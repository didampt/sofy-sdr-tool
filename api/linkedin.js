// /api/linkedin.js — L'IA trouve l'URL du profil LinkedIn personnel d'un contact (pour alimenter Kaspr)
// POST {prenom, nom, entreprise, ville, fonction}
//   → {ok, resultat:{url|null, confiance, explication}}
// Règle d'or : jamais d'URL inventée — uniquement un profil réellement trouvé et cohérent.

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!verifierToken(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { prenom = '', nom = '', entreprise = '', ville = '', fonction = '' } = req.body || {};
  if (!nom || !entreprise) return res.status(400).json({ erreur: 'nom et entreprise requis' });

  const prompt = `Trouve l'URL du profil LinkedIn PERSONNEL de cette personne :
- Personne : ${prenom} ${nom}${fonction ? ` (${fonction})` : ''}
- Entreprise : ${entreprise}${ville ? ` — ${ville}` : ''} (France / Antilles / Réunion)

Méthode : recherche web "${prenom} ${nom} ${entreprise} linkedin" puis variantes si besoin ("${prenom} ${nom} linkedin ${ville}").

Règles STRICTES :
1. L'URL doit être un profil PERSONNEL (linkedin.com/in/…), pas une page entreprise (/company/).
2. Le profil doit correspondre à la bonne personne : même nom ET un lien crédible avec l'entreprise ou sa zone géographique. Attention aux homonymes — en cas de doute entre plusieurs profils, réponds null.
3. N'INVENTE JAMAIS une URL. Tu ne peux renvoyer que une URL vue dans les résultats de recherche.
4. Les dirigeants de TPE/PME aux Antilles n'ont souvent PAS de profil LinkedIn : null est une réponse normale et fréquente.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"url":"https://www.linkedin.com/in/… ou null","confiance":"haute|moyenne|basse","explication":"1-2 phrases : comment tu as trouvé / pourquoi null"}`;

  try {
    const appel = async () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      })
    });

    let r = await appel();
    if (r.status === 429) { await new Promise(x => setTimeout(x, 25000)); r = await appel(); }
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || '' });

    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const d1 = brut.indexOf('{'), d2 = brut.lastIndexOf('}');
    if (d1 === -1) return res.status(502).json({ erreur: 'Réponse IA non exploitable' });
    let p;
    try { p = JSON.parse(brut.slice(d1, d2 + 1)); } catch { return res.status(502).json({ erreur: 'JSON IA invalide' }); }

    // Garde-fous serveur : format /in/ obligatoire, sinon null
    let url = (p.url && p.url !== 'null') ? String(p.url).trim() : null;
    if (url && !/linkedin\.com\/in\/[^/?#]+/i.test(url)) url = null;

    return res.status(200).json({ ok: true, resultat: { url, confiance: p.confiance || 'basse', explication: p.explication || '' } });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
