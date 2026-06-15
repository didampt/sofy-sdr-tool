// /api/personas.js — Wave 2 : trouver les PERSONNES aux postes ciblés (Dir Commercial, Dir Réseau…)
// POST {entreprise:{nom, enseigne, site, ville}, jobs:["Dir Marketing", …]} 
//   → {personas:[{prenom, nom, fonction, linkedin, confiance}]}
// Agent IA (Claude + recherche web) : page LinkedIn de l'entreprise + profils publics des rôles choisis.
// Les contacts trouvés passent ensuite dans le waterfall standard (Dropcontact → FullEnrich).

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { entreprise = {}, jobs = [] } = req.body || {};
  if (!entreprise.nom || !jobs.length) return res.status(400).json({ erreur: 'entreprise.nom et jobs requis' });

  try {
    const prompt = `Tu es un assistant de prospection B2B. Trouve les PERSONNES occupant actuellement ces postes dans cette entreprise française :

Entreprise : ${entreprise.nom}${entreprise.enseigne ? ` (enseigne : ${entreprise.enseigne})` : ''}
${entreprise.site ? `Site web : ${entreprise.site}` : ''}
${entreprise.linkedin ? `Page LinkedIn de l'entreprise (déjà connue, utilise-la directement) : ${entreprise.linkedin}` : ''}
Ville : ${entreprise.ville || ''}
Postes recherchés en priorité : ${jobs.join(', ')}
Postes acceptés en repli (décideurs locaux, à proposer même s'ils ne correspondent pas exactement) : Directeur, Directeur Adjoint, Directeur d'exploitation, Responsable (marketing/commercial/communication/établissement), Gérant, DG, CEO, COO, Fondateur

Méthode :
1. ${entreprise.linkedin ? `La page LinkedIn de l'entreprise est ${entreprise.linkedin} — va directement sur sa page "people" : ${entreprise.linkedin.replace(/\/$/,'')}/people` : `Cherche la page LinkedIn de l'entreprise ("${entreprise.enseigne || entreprise.nom} linkedin"${entreprise.site ? `, "site:linkedin.com ${entreprise.site}"` : ''})`}
2. Cherche les profils publics : "site:linkedin.com/in ${entreprise.enseigne || entreprise.nom} ${jobs[0]}" et variantes pour chaque poste prioritaire, puis pour les postes de repli (directeur, responsable, gérant…)
2bis. Consulte aussi la page "people" de l'entreprise si trouvée : "linkedin.com/company/…/people"
3. Vérifie que la personne travaille ACTUELLEMENT dans cette entreprise (pas un ancien poste)

RÈGLES STRICTES :
- Maximum 5 personnes, classées : postes prioritaires d'abord, puis décideurs de repli — uniquement des trouvailles RÉELLES vérifiées dans tes résultats de recherche, n'invente JAMAIS un nom
- Une petite entreprise n'a souvent PERSONNE à ces postes : c'est une réponse normale et utile (liste vide)
- Ne confonds pas avec une entreprise homonyme ou une société sœur d'une autre île

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"personas": [{"prenom": "…", "nom": "…", "fonction": "…", "linkedin": "linkedin.com/in/… ou null", "confiance": "haute|moyenne|basse", "cible": true|false}], "linkedin_entreprise": "linkedin.com/company/… ou null", "explication": "une phrase"}\n("cible": true si le poste correspond aux postes prioritaires, false si décideur de repli)`;

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

    let data = await r.json();
    if (r.status === 429) {
      await new Promise(x => setTimeout(x, 30000));
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
        })
      });
      data = await r2.json();
      if (!r2.ok) return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || '' });
    } else if (!r.ok) {
      return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || JSON.stringify(data).slice(0, 200) });
    }

    await loggerConso(user, 'ia_claude', 1, (req.body && req.body.liste_id) || req.query.liste_id);
    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const debut = brut.indexOf('{');
    const finIdx = brut.lastIndexOf('}');
    let parsed = { personas: [], linkedin_entreprise: null, explication: 'Réponse IA non exploitable' };
    if (debut !== -1 && finIdx !== -1) {
      try { parsed = JSON.parse(brut.slice(debut, finIdx + 1)); } catch { /* garde le défaut */ }
    }
    parsed.personas = (parsed.personas || [])
      .filter(p => p && p.nom && p.confiance !== 'basse')
      .slice(0, 3);

    return res.status(200).json({ ok: true, resultat: parsed });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
