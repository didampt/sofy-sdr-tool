// /api/email-angle.js — Réécrit l'email de prospection selon l'angle (module) choisi par le SDR, via Sonnet 4.6.
// POST { entreprise:{…}, sdr:"…", produit:"soview|soconnect|soreach|generique" } → { ok, email:{objet,corps} }
import { verifierToken } from './db.js';
export const config = { maxDuration: 60 };

const MODULES = {
  soview: "Soview — pilotage de la presence Google (fiche GMB, avis, notes, visibilite locale, cartes NFC de collecte d'avis). Angle : la reputation Google et la visibilite locale comme levier d'appels entrants.",
  soconnect: "SoConnect — messagerie professionnelle unifiee (WhatsApp, Messenger, Instagram, webchat) + agent IA conversationnel Budy qui repond aux clients 24/7. Ce n'est PAS de la fidelite. Angle : ne plus manquer un message client, repondre instantanement, centraliser toutes les conversations.",
  soreach: "SoReach — campagnes SMS et RCS (messagerie enrichie : logo, images, boutons), connexion operateur directe. Angle : relancer et fideliser la base clients par SMS/RCS, taux d'ouverture eleves.",
  generique: "TOUTE la suite Sofy (Soview + SoConnect + SoReach). Angle : presenter Sofy comme la plateforme qui rapproche les commerces de leurs clients, en choisissant les 1-2 benefices les plus pertinents pour CE prospect parmi les 3 modules."
};

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Methode non autorisee' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante' });

  const { entreprise = {}, sdr = '', produit = 'generique' } = req.body || {};
  if (!entreprise.nom) return res.status(400).json({ erreur: 'entreprise requise' });
  const mod = MODULES[produit] || MODULES.generique;

  const prompt = `Tu es le meilleur copywriter commercial de Sofy (sofy.fr). Tu ecris un email de prospection B2B ultra-percutant, accrocheur et personnalise.

ANGLE IMPOSE — le SDR a choisi ce module, l'email DOIT etre centre dessus :
${mod}

Donnees reelles collectees sur le prospect (n'invente AUCUN chiffre, utilise uniquement ce qui est present) :
${JSON.stringify(entreprise, null, 1)}

Consignes :
- Objet court (max ~6 mots), intriguant, sans le mot "Sofy", qui donne envie d'ouvrir.
- Corps de 80-120 mots, ton direct et humain, UNE seule idee forte, accroche basee sur une donnee reelle du prospect (note Google, avis, concurrents, multi-sites, activite…).
- Si un signal d'intention existe (champ "signal" ou "pages_visitees"), accroche dessus avec elegance (jamais "notre outil vous a tracke").
- CTA : proposer un echange de 15 min ou reserver sur sofy.fr/demo.
- Signature : ${sdr || "L'equipe Sofy"} — Sofy.
- Ecris en francais. Si le produit est "generique", choisis les 1-2 benefices les plus pertinents parmi les 3 modules pour CE prospect.

Reponds UNIQUEMENT avec un objet JSON, sans texte ni backticks :
{"objet":"…","corps":"…"}`;

  const call = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });

  try {
    let r = await call();
    let data = await r.json();
    if (r.status === 429 || r.status === 529) {
      await new Promise(x => setTimeout(x, 8000));
      r = await call(); data = await r.json();
    }
    if (!r.ok) return res.status(502).json({ erreur: 'API Claude', detail: (data.error && data.error.message) || JSON.stringify(data).slice(0, 200) });
    const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
    const a = brut.indexOf('{'), b2 = brut.lastIndexOf('}');
    if (a === -1 || b2 === -1) return res.status(502).json({ erreur: 'Reponse IA non exploitable' });
    let email;
    try { email = JSON.parse(brut.slice(a, b2 + 1)); } catch (_) { return res.status(502).json({ erreur: 'JSON IA invalide' }); }
    if (!email.objet || !email.corps) return res.status(502).json({ erreur: 'Email incomplet' });
    return res.status(200).json({ ok: true, email });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
