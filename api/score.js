// /api/score.js — Scoring multi-produits + synthèse d'appel + email/SMS personnalisés (IA)
// POST {entreprise:{…toutes les données accumulées…}, sdr:"Romain"} 
//   → {scores:{soview,soconnect,soreach,global}, signaux:[…], synthese:"…", accroche:"…", email:{objet,corps}, sms:"…"}
// Pas de recherche web : l'IA travaille sur les données déjà collectées (Pappers, GMB, IA, contacts).

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {

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

⚡⚡ RÈGLE PRIORITAIRE — INTENTION DÉCLARÉE PAR LA PAGE VISITÉE (si champ "signal" de source "RB2B" ou "pages_visitees" présent) :
Le prospect a visité sofy.fr. La/les page(s) visitée(s) révèlent SON intérêt explicite — c'est le signal le PLUS FORT, il PRIME sur ton analyse des données GMB/Pappers. Le produit correspondant à la page DOIT avoir le score le plus élevé et être l'angle de TOUT (synthèse, accroche, email, SMS).

Cartographie page → produit dominant (regarde "pages_visitees", la page la plus spécifique gagne ; ignore "/" générique pour choisir) :
 • "/so-reach-sms"  → **SoReach (SMS)** est LE produit. SoReach doit être le score le plus haut. Angle = campagnes SMS marketing. NE PARLE PAS de Google My Business / fiche Google en premier, même si la fiche GMB est mauvaise — il est venu pour le SMS.
 • "/so-reach-rcs"  → **SoReach (RCS)** est LE produit. Score SoReach le plus haut. Angle = messagerie RCS enrichie (logo, images, boutons). Mentionne RCS spécifiquement, pas juste SMS.
 • "/so-view" ou "/avis" → **Soview** est LE produit. Score Soview le plus haut. Angle = fiche Google My Business, avis, visibilité locale.
 • "/so-connect" ou "/budy" ou "/messaging" → **SoConnect** est LE produit. Score SoConnect le plus haut. Angle = messagerie professionnelle unifiée + agent IA conversationnel Budy (répond aux clients 24/7).
 • UNIQUEMENT "/" ou "/demo" ou "/tarifs" (pas de page produit précise) → pas d'intention produit claire : là tu peux utiliser ton analyse GMB/Pappers classique pour choisir l'angle, et "/demo"/"/tarifs" = forte intention d'achat → monte le score global.

Conséquences OBLIGATOIRES quand une page produit précise est visitée :
   - Le score du produit visité = le plus élevé des trois (ex : visite /so-reach-sms → soreach > soview ET soreach > soconnect, même si la fiche GMB est nulle).
   - Monte le score global (un visiteur est bien plus chaud qu'un nom froid de Pappers).
   - Synthèse, accroche, objet d'email, corps d'email ET SMS sont CENTRÉS sur le produit de la page. Exemple visite /so-reach-sms : l'email parle de campagnes SMS pour fidéliser/relancer leurs clients, PAS de leur fiche Google.
   - Mentionne le signal avec élégance ("j'ai vu que les campagnes SMS vous intéressaient", "suite à votre passage sur notre page SMS") — warm call, prétexte naturel. Ne dis JAMAIS "notre outil vous a tracké".
3. **Signaux** : liste courte des éléments concrets exploitables (max 4), formulés pour un SDR
4. **Synthèse d'appel** (4-6 phrases) : qui appeler, contexte de l'entreprise, LE point de douleur n°1 avec les chiffres exacts (note, avis, concurrents), et l'angle d'attaque produit recommandé
5. **Accroche d'appel** : LA première phrase que le SDR peut dire après bonjour (naturelle, factuelle, pas commerciale agressive)
6. **Email de prospection** : objet court intriguant + corps de 80-120 mots, personnalisé avec les données réelles (note Google, avis, concurrents…), ton direct et utile, une seule idée, CTA = proposer un échange de 15 min en invitant à cliquer sur le bouton de réservation situé sous l'email (ex : « réservez un créneau via le bouton ci-dessous »). N'écris JAMAIS d'URL dans le texte. Signature : ${sdr || 'L\'équipe Sofy'} — Sofy.
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
