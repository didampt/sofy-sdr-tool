// /api/score.js — Scoring multi-produits + synthèse d'appel + email/SMS personnalisés (IA)
// POST {entreprise:{…toutes les données accumulées…}, sdr:"Romain"} 
//   → {scores:{soview,soconnect,soreach,global}, signaux:[…], synthese:"…", accroche:"…", email:{objet,corps}, sms:"…"}
// Pas de recherche web : l'IA travaille sur les données déjà collectées (Pappers, GMB, IA, contacts).

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!verifierToken(req)) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante dans Vercel' });

  const { entreprise = {}, sdr = '' } = req.body || {};
  if (!entreprise.nom) return res.status(400).json({ erreur: 'entreprise requise' });

  try {
    const prompt = `Tu es l'assistant commercial de Sofy (sofy.fr), plateforme SaaS qui aide les commerces et entreprises de proximité à se rapprocher de leurs clients via 3 produits :
- **Soview** : pilotage de la présence Google (fiches GMB, avis, notes, visibilité locale, cartes NFC de collecte d'avis)
- **SoConnect** : messagerie professionnelle unifiée + agent IA conversationnel (Budy) qui répond aux clients — PAS un outil de fidélité
- **SoReach** : campagnes SMS et RCS

Voici TOUTES les données collectées sur ce prospect :
${JSON.stringify(entreprise, null, 1)}

Analyse et produis :
1. **Scores 0-100 par produit** selon les signaux :
   - Soview ↑ si : pas de fiche Google, note sous la moyenne des concurrents, avis négatif récent, plusieurs fiches dispersées, beaucoup d'établissements
   - SoConnect ↑ si : avis mentionnant des appels/messages sans réponse, entreprise multi-sites, volume d'avis élevé (= flux clients), pas de site web
   - SoReach ↑ si : activité avec relances clients (entretiens, révisions auto, rendez-vous), base clients probable (ancienneté, volume d'avis), multi-établissements
2. **Score global** = potentiel commercial d'ensemble (pondère aussi taille/CA)

⚡ SIGNAL CHAUD (si présent dans les données) : si l'entreprise a un champ "signal" de source "RB2B" (= elle a visité sofy.fr) ou un signal LinkedIn, c'est un prospect TIÈDE À CHAUD, pas une approche à froid. Dans ce cas :
   - Monte le score global (un visiteur du site est bien plus intéressé qu'un nom tiré de Pappers)
   - Surtout, REGARDE les pages visitées ("pages_visitees") pour orienter le produit dominant :
     • page contenant "so-reach" / "sms" / "rcs" → booste fortement **SoReach** (il s'intéresse aux campagnes SMS)
     • page contenant "so-view" / "avis" → booste fortement **Soview**
     • page contenant "so-connect" / "budy" / "messaging" → booste fortement **SoConnect**
     • page "demo" / "tarifs" / "pricing" → intention d'achat forte, monte le score global
   - L'accroche, la synthèse et l'email DOIVENT mentionner subtilement ce signal ("j'ai vu que vous vous intéressiez à…", "suite à votre visite sur notre page X") — c'est un warm call, le SDR a un prétexte naturel. Reste élégant, ne dis pas "notre logiciel espion vous a tracké".
3. **Signaux** : liste courte des éléments concrets exploitables (max 4), formulés pour un SDR
4. **Synthèse d'appel** (4-6 phrases) : qui appeler, contexte de l'entreprise, LE point de douleur n°1 avec les chiffres exacts (note, avis, concurrents), et l'angle d'attaque produit recommandé
5. **Accroche d'appel** : LA première phrase que le SDR peut dire après bonjour (naturelle, factuelle, pas commerciale agressive)
6. **Email de prospection** : objet court intriguant + corps de 80-120 mots, personnalisé avec les données réelles (note Google, avis, concurrents…), ton direct et utile, une seule idée, CTA = proposer un échange de 15 min ou réserver sur sofy.fr/demo. Signature : ${sdr || 'L\'équipe Sofy'} — Sofy.
7. **SMS** (max 140 caractères, hors mention STOP) : version ultra-courte de l'accroche avec le prénom du contact si connu.

Règles : utilise UNIQUEMENT les données fournies (n'invente aucun chiffre). Écris en français. Si une donnée manque, n'en parle pas.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"scores":{"soview":0,"soconnect":0,"soreach":0,"global":0},"signaux":["…"],"synthese":"…","accroche":"…","email":{"objet":"…","corps":"…"},"sms":"…"}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    let data = await r.json();
    if (r.status === 429) {
      await new Promise(x => setTimeout(x, 25000));
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1800, messages: [{ role: 'user', content: prompt }] })
      });
      data = await r2.json();
      if (!r2.ok) return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || '' });
    } else if (!r.ok) {
      return res.status(502).json({ erreur: 'API Claude', detail: data.error?.message || JSON.stringify(data).slice(0, 200) });
    }

    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const debut = brut.indexOf('{');
    const finIdx = brut.lastIndexOf('}');
    if (debut === -1 || finIdx === -1) return res.status(502).json({ erreur: 'Réponse IA non exploitable' });
    let parsed;
    try { parsed = JSON.parse(brut.slice(debut, finIdx + 1)); }
    catch { return res.status(502).json({ erreur: 'JSON IA invalide' }); }

    return res.status(200).json({ ok: true, resultat: parsed });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
