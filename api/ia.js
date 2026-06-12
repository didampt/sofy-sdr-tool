// /api/ia.js — Agent IA "trouve le site web et le nom commercial" (équivalent Claygent)
// POST {nom, enseigne, ville, naf, siren} → {site_web, nom_commercial, confiance}
// Utilisé quand le matching GMB échoue ou qu'aucun domaine n'est connu (ex : PDK → Centre Porsche Guadeloupe)

import { verifierToken } from './db.js';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!verifierToken(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { nom, enseigne = '', ville = '', naf = '', siren = '', indice = '', dirigeant = '' } = req.body || {};
  if (!nom) return res.status(400).json({ erreur: 'nom requis' });

  try {
    const prompt = `Tu es un assistant de prospection B2B. Trouve les informations publiques de cette entreprise française :

Raison sociale : ${nom}
${enseigne ? `Enseigne : ${enseigne}` : ''}
${dirigeant ? `Dirigeant : ${dirigeant} (très utile : cherche aussi "${dirigeant} ${nom}" et son LinkedIn)` : ''}
Ville : ${ville}
Activité (NAF ${naf}) ${siren ? `· SIREN ${siren}` : ''}

${indice ? `Indication fournie par le commercial (fiable, à utiliser dans tes recherches) : "${indice}"
` : ''}Fais PLUSIEURS recherches web (4-6 recherches, c'est normal) en variant les angles : "${enseigne || nom} ${ville}", "${nom} site officiel", "${nom} pages jaunes", le sigle + activité + département, LinkedIn et Instagram de l'entreprise${dirigeant ? `, "${dirigeant} ${ville}"` : ''}${indice ? `, "${indice} site officiel"` : ''}. Les petites entreprises des DOM sont souvent mieux référencées via Pages Jaunes, Instagram ou LinkedIn que par leur propre site. Trouve :
1. Son site web officiel (le domaine exact, vérifié dans les résultats — jamais inventé)
2. Son nom commercial tel qu'il apparaît sur Google Maps (souvent différent de la raison sociale, ex : "PDK PRESTIGE DISTRIBUTION KARAIB" = "Centre Porsche Guadeloupe")
3. Son numéro de téléphone public — AUSSI IMPORTANT que le site web : cherche spécifiquement sur pagesjaunes.fr et les annuaires locaux si besoin
4. Son adresse constatée sur le web

⚠️ RÈGLE DE COHÉRENCE ABSOLUE : le site web et le nom commercial doivent appartenir à CETTE entreprise — même activité (${naf ? 'NAF ' + naf + ', ' : ''}vérifie que l'activité du site correspond), et surtout MÊME LOCALISATION : ${ville || 'la ville indiquée'}. Les groupes ont souvent des sociétés sœurs sur d'autres îles avec des noms proches (ex : "Automobile Import Guadeloupe / A.I.G." en Guadeloupe vs "Auto Import FWI" en Martinique) — choisis IMPÉRATIVEMENT l'établissement de ${ville || 'la bonne ville'} et son nom Google Maps local. Autre erreur à NE PAS faire : "MOBILE AUTO" (concession automobile) ≠ "Flip Mobile" (magasin de téléphones) même si les noms se ressemblent. En cas de doute : null.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"site_web": "exemple.fr ou null", "nom_commercial": "Nom Google Maps ou null", "telephone": "+590... ou null", "adresse": "adresse ou null", "confiance": "haute|moyenne|basse", "explication": "une phrase"}

IMPORTANT — équilibre : un résultat avec confiance "moyenne" vaut mieux qu'aucun résultat. Mets null UNIQUEMENT si tes recherches ne donnent rien de cohérent. Un téléphone ou une adresse trouvés sur Pages Jaunes ou un annuaire sont fiables même sans site web : renseigne-les. Le "null par prudence" doit rester l'exception, réservé aux cas d'attribution douteuse (mauvaise île, mauvaise activité). Ne devine jamais un domaine.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
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
