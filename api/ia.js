// /api/ia.js — Agent IA "trouve le site web et le nom commercial" (équivalent Claygent)
// POST {nom, enseigne, ville, naf, siren} → {site_web, nom_commercial, confiance}
// Utilisé quand le matching GMB échoue ou qu'aucun domaine n'est connu (ex : PDK → Centre Porsche Guadeloupe)

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!verifierToken(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { nom, enseigne = '', ville = '', naf = '', siren = '', indice = '' } = req.body || {};
  if (!nom) return res.status(400).json({ erreur: 'nom requis' });

  try {
    const prompt = `Tu es un assistant de prospection B2B. Trouve les informations publiques de cette entreprise française :

Raison sociale : ${nom}
${enseigne ? `Enseigne : ${enseigne}` : ''}
Ville : ${ville}
Activité (NAF ${naf}) ${siren ? `· SIREN ${siren}` : ''}

${indice ? `Indication fournie par le commercial (fiable, à utiliser dans tes recherches) : "${indice}"
` : ''}Fais PLUSIEURS recherches web si nécessaire (ex : "${enseigne || nom} ${ville}", "${nom} site officiel", sigle + activité + département${indice ? `, "${indice} site officiel"` : ''}) et trouve :
1. Son site web officiel (le domaine exact, vérifié dans les résultats — jamais inventé)
2. Son nom commercial tel qu'il apparaît sur Google Maps (souvent différent de la raison sociale, ex : "PDK PRESTIGE DISTRIBUTION KARAIB" = "Centre Porsche Guadeloupe")
3. Son numéro de téléphone public (Pages Jaunes, annuaires, site web)
4. Son adresse constatée sur le web

⚠️ RÈGLE DE COHÉRENCE ABSOLUE : le site web et le nom commercial doivent appartenir à CETTE entreprise — même activité (${naf ? 'NAF ' + naf + ', ' : ''}vérifie que l'activité du site correspond), même ville. Exemple d'erreur à NE PAS faire : "MOBILE AUTO" (concession automobile) ≠ "Flip Mobile" (magasin de téléphones) même si les noms se ressemblent. En cas de doute sur la cohérence d'activité : null.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"site_web": "exemple.fr ou null", "nom_commercial": "Nom Google Maps ou null", "telephone": "+590... ou null", "adresse": "adresse ou null", "confiance": "haute|moyenne|basse", "explication": "une phrase"}

Si tu n'es pas sûr, mets null et confiance basse. Ne devine jamais.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || JSON.stringify(data).slice(0, 200) });
    }

    // Le dernier bloc texte contient la réponse
    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const debut = brut.indexOf('{');
    const finIdx = brut.lastIndexOf('}');
    if (debut === -1 || finIdx === -1) {
      return res.status(200).json({ ok: true, resultat: { site_web: null, nom_commercial: null, confiance: 'basse', explication: 'Réponse IA non exploitable' } });
    }
    let parsed;
    try { parsed = JSON.parse(brut.slice(debut, finIdx + 1)); }
    catch { parsed = { site_web: null, nom_commercial: null, confiance: 'basse', explication: 'JSON invalide' }; }

    // Nettoyage du domaine
    if (parsed.site_web) {
      parsed.site_web = String(parsed.site_web).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      if (!parsed.site_web.includes('.')) parsed.site_web = null;
    }

    return res.status(200).json({ ok: true, resultat: parsed });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
