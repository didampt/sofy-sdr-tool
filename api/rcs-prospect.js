// /api/rcs-prospect.js — 💬 RCS de prospection : le prospect reçoit une rich-card Sofy…
// qui EST la démonstration du produit (SoReach RCS). Envoyé depuis « Ma journée » ou la fiche.
// POST { tel, prenom?, entreprise?, accroche?, email_cle?, liste_id?, texte? }
//   → rich-card (visuel + titre + texte personnalisé + bouton « Réserver ma démo »)
//   → repli SMS v1 route alerte si le RCS échoue ; note dans le bloc-notes ; conso journalisée.
// GET ?apercu=1&… → texte proposé sans rien envoyer (prévisualisation avant envoi).
// ⚠️ Prospection B2B : mention de désinscription obligatoire dans le texte (ajoutée automatiquement).

import { verifierToken, sql, ensureSchema, envoyerSmsSofy, loggerConso } from './db.js';

const cleV2 = () => process.env.SOFY_API_KEY_V2 || '';
// Page de demande de démo PUBLIQUE (le lien go.sofy.fr/meetings/… est réservé aux SDR
// pour réserver un créneau AE — jamais à envoyer à un prospect)
const LIEN_DEMO = process.env.SOFY_LIEN_DEMO || 'https://www.sofy.fr/demo';
const VISUEL = process.env.SOFY_RCS_IMAGE_DEMO || 'https://www.sofyscrap.com/rcs-demo.jpg';

function e164(brut) {
  let t = String(brut || '').replace(/[^\d+]/g, '');
  if (!t) return null;
  if (t.startsWith('+')) return t.length >= 11 ? t : null;
  if (t.startsWith('00')) return '+' + t.slice(2);
  if (t.startsWith('0')) {
    const p4 = t.slice(0, 4);
    if (['0690', '0691'].includes(p4)) return '+590' + t.slice(1);
    if (['0696', '0697'].includes(p4)) return '+596' + t.slice(1);
    if (p4 === '0694') return '+594' + t.slice(1);
    if (['0692', '0693'].includes(p4)) return '+262' + t.slice(1);
    return '+33' + t.slice(1);
  }
  return null;
}

// Texte proposé : reprend l'accroche IA de la fiche (le « pourquoi je vous appelle »), sinon
// message générique. Le RCS n'a pas la limite des 160 caractères → on peut être concret.
export function texteProspect({ prenom, entreprise, accroche, sdr }) {
  const qui = prenom ? prenom : 'Bonjour';
  const soc = entreprise ? ` pour ${entreprise}` : '';
  const debut = accroche
    ? String(accroche).replace(/^bonjour[^,]*,\s*/i, '').replace(/\s+/g, ' ').trim()
    : `j'accompagne les enseignes sur leurs avis Google, leurs conversations clients et leurs campagnes SMS/RCS.`;
  return `${qui}, ${debut}${soc ? '' : ''} 👉 Ce message est justement un RCS envoyé depuis Sofy : logo, visuel, bouton — c'est ce que vos clients pourraient recevoir à la place d'un SMS. On en parle 15 min ?${sdr ? ` — ${sdr}, Sofy` : ''}`;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  const b = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const prenom = String(b.prenom || '').trim().split(' ')[0];
  const entreprise = String(b.entreprise || '').trim();
  const accroche = String(b.accroche || '').trim();

  // Prévisualisation (le SDR relit et peut corriger avant l'envoi)
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, texte: texteProspect({ prenom, entreprise, accroche, sdr: user.nom }), lien: LIEN_DEMO, visuel: VISUEL });
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET (aperçu) ou POST (envoi)' });

  const tel = e164(b.tel);
  if (!tel) return res.status(400).json({ erreur: 'Numéro invalide' });
  // Clé de trace : email du contact, sinon clé de fiche (nom:…) — sans repli, les fiches sans
  // email n'avaient AUCUNE note dans le bloc-notes (constat Didier 07/08).
  const cleTrace = String(b.email_cle || b.cle_fiche || '').toLowerCase().trim() || null;
  // 🛡️ Garde-fou : UN SEUL RCS de démonstration par lead (anti-envoi en masse). La trace fait foi.
  try {
    const deja = await sql`SELECT ts, auteur FROM activites
      WHERE type = 'rcs_prospect' AND (fiche_cle = ${cleTrace || '§'} OR detail LIKE ${'%' + tel})
      ORDER BY ts DESC LIMIT 1`;
    if (deja.length) return res.status(409).json({
      erreur: 'RCS déjà envoyé à ce lead le ' + new Date(deja[0].ts).toLocaleDateString('fr-FR') + (deja[0].auteur ? ' par ' + deja[0].auteur : '') + ' — un seul par lead',
      deja: true });
  } catch (_) {}
  const texte = (String(b.texte || '').trim() || texteProspect({ prenom, entreprise, accroche, sdr: user.nom })).slice(0, 900);
  const titre = '💬 Découvrez le futur du SMS avec le RCS';
  // Mention légale prospection B2B (droit d'opposition) — jamais retirée du repli SMS non plus
  const stop = ' Pour ne plus recevoir de message : répondez STOP.';
  const replicourt = `Sofy : ce message est un RCS de démonstration. 15 min pour en parler ? ${LIEN_DEMO}`.slice(0, 129);

  try {
    let envoi = null;
    const senderId = process.env.SOFY_RCS_SENDER_ID;
    if (cleV2() && senderId) {
      const r = await fetch('https://api.sofy.fr/v2/rcs/rich-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleV2()}` },
        body: JSON.stringify({
          to: tel, senderId, title: titre, description: texte + stop, imageUrl: VISUEL,
          button: { label: '📅 Réserver ma démo', url: LIEN_DEMO },
          fallback: { enabled: true, text: replicourt }
        })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.id) envoi = { canal: d.isSmsFallback ? 'sms (repli Sofy)' : 'rcs', id: d.id };
      else envoi = { erreur: 'RCS ' + r.status + ': ' + JSON.stringify(d).slice(0, 200) };
    }
    // Repli : SMS v1 route alerte (la route SMS v2 est rejetée par le provider, cf. 07/08)
    if (!envoi || envoi.erreur) {
      const v1 = await envoyerSmsSofy({ to: tel, message: replicourt, user: user.nom, liste_id: b.liste_id || null, transactionnel: false });
      if (v1.ok) envoi = { canal: 'sms (v1)', id: v1.id || null, rcs_echec: envoi && envoi.erreur };
      else return res.status(502).json({ erreur: 'Envoi refusé', detail: (envoi && envoi.erreur) || v1.detail });
    }

    try { await loggerConso(user.nom, 'soreach', 1, b.liste_id || null); } catch (_) {}
    // Trace dans le bloc-notes de la fiche
    if (cleTrace) {
      try { await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
        VALUES (${cleTrace}, 'sms', 'rcs_prospect', ${'💬 RCS de démonstration envoyé (' + envoi.canal + ')'},
          ${texte + ' → ' + tel}, ${user.nom || 'système'}, NOW())`; } catch (_) {}
    }
    return res.status(200).json({ ok: true, canal: envoi.canal, id: envoi.id || null, tel });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
