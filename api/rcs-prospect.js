// /api/rcs-prospect.js — 💬 RCS de prospection : le prospect reçoit une rich-card Sofy…
// qui EST la démonstration du produit (SoReach RCS). Envoyé depuis « Ma journée » ou la fiche.
// POST { tel, prenom?, entreprise?, accroche?, email_cle?, liste_id?, texte? }
//   → rich-card (visuel + titre + texte personnalisé + bouton « Réserver ma démo »)
//   → repli SMS v1 route alerte si le RCS échoue ; note dans le bloc-notes ; conso journalisée.
// GET ?apercu=1&… → texte proposé sans rien envoyer (prévisualisation avant envoi).
// ⚠️ Prospection B2B : mention de désinscription obligatoire dans le texte (ajoutée automatiquement).

import { verifierToken, sql, ensureSchema, envoyerSmsSofy, loggerConso } from './db.js';
import { gsmifier, analyserSms } from './sms-gsm.js';

const cleV2 = () => process.env.SOFY_API_KEY_V2 || '';
// Réservation de démo côté PROSPECT (parcours « site web », adapté au mobile).
// ⚠️ Ne pas utiliser demo-sdr : c'est le calendrier interne réservé aux SDR.
const LIEN_DEMO = process.env.SOFY_LIEN_DEMO || 'https://go.sofy.fr/meetings/mbouly/demo-site-web';
const VISUEL = process.env.SOFY_RCS_IMAGE_DEMO || 'https://www.sofyscrap.com/rcs-demo.jpg';
const BASE_PUB = () => process.env.SOFY_BASE_PUBLIQUE || 'https://www.sofyscrap.com';
// Visuel de la carte « analyse » : la création Sofy « Découvrez votre analyse personnalisée »,
// servie depuis public/ (1000×1000, 157 Ko — assez léger pour s'afficher avant que le prospect
// referme sa messagerie). Un RCS sans image n'a pas d'intérêt : c'est justement ce qu'on vend.
const VISUEL_PREZ = process.env.SOFY_RCS_IMAGE_PREZ
  || (process.env.SOFY_BASE_PUBLIQUE || 'https://www.sofyscrap.com') + '/rcs-prez.jpg';

// ── Mode « analyse » : le lien de la présentation, envoyé par RCS, replié en SMS ────────────────
// Pourquoi ici et pas dans un fichier neuf : l'envoi RCS, le repli SMS, la mise en E.164, la
// journalisation de conso et la trace dans le bloc-notes sont déjà écrits et éprouvés. Le seul
// changement, c'est la carte : un autre titre, un autre bouton, une autre destination.
export function textePrez({ prenom, entreprise, sdr }) {
  const qui = prenom ? prenom : 'Bonjour';
  const soc = entreprise ? ` de ${entreprise}` : '';
  return `${qui}, j'ai préparé une analyse de la visibilité locale${soc} : votre fiche Google, `
    + `vos avis, votre position quand un client cherche votre métier — et ce que nous pouvons y changer. `
    + `Tout est sur une page privée, 2 minutes de lecture.${sdr ? ` — ${sdr}, Sofy` : ''}`;
}

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
    if (String(b.mode || '') === 'prez') {
      const jt = String(b.jeton || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const u = BASE_PUB() + '/p/' + jt;
      const rp = gsmifier(`Sofy : votre analyse de visibilite locale est prete. ${u} Repondez STOP pour ne plus etre contacte.`).slice(0, 160);
      const dg = analyserSms(rp);
      return res.status(200).json({ ok: true, mode: 'prez',
        texte: textePrez({ prenom, entreprise, sdr: user.nom }), lien: u, visuel: VISUEL_PREZ,
        bouton: '📊 Voir mon analyse', repli_sms: rp, segments_sms: dg.segments, alphabet: dg.alphabet });
    }
    return res.status(200).json({ ok: true, texte: texteProspect({ prenom, entreprise, accroche, sdr: user.nom }), lien: LIEN_DEMO, visuel: VISUEL });
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET (aperçu) ou POST (envoi)' });

  const tel = e164(b.tel);
  if (!tel) return res.status(400).json({ erreur: 'Numéro invalide' });

  // ══ Envoi de l'ANALYSE par RCS (bascule SMS automatique) ══
  if (String(b.mode || '') === 'prez') {
    const jeton = String(b.jeton || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!jeton) return res.status(400).json({ erreur: 'jeton de l\'analyse requis' });
    let row = null;
    try { const r = await sql`SELECT jeton, client, sdr, expire_le, destinataire FROM prez WHERE jeton = ${jeton}`; row = r[0] || null; } catch (_) {}
    if (!row) return res.status(404).json({ erreur: 'Analyse introuvable — régénère-la avant de l\'envoyer' });
    if (row.expire_le && new Date(row.expire_le) < new Date()) {
      return res.status(410).json({ erreur: 'Le lien de cette analyse a expiré — régénère-la, sinon le prospect tombera sur une page morte' });
    }
    // Lien PERSONNEL du destinataire quand il en a un : c'est ce qui permet de dire ensuite
    // « Lauriane a ouvert », et pas seulement « quelqu'un a ouvert ».
    const dn = Number.isInteger(parseInt(b.d, 10)) ? parseInt(b.d, 10) : null;
    const url = BASE_PUB() + '/p/' + jeton + (dn != null && dn >= 0 ? '?d=' + dn : '');
    const txt = (String(b.texte || '').trim() || textePrez({ prenom, entreprise: entreprise || row.client, sdr: user.nom })).slice(0, 900);
    const stopP = ' Pour ne plus recevoir de message : répondez STOP.';
    // Le repli SMS doit tenir en UN segment ET rester en alphabet GSM : une apostrophe courbe
    // ou un ★ fait basculer le message entier en UCS-2 (70 caractères au lieu de 160).
    const brut = `Sofy : votre analyse de visibilite locale est prete. ${url} Repondez STOP pour ne plus etre contacte.`;
    const repli = gsmifier(brut).slice(0, 160);
    const diag = analyserSms(repli);

    if (b.apercu) {
      return res.status(200).json({ ok: true, apercu: true, texte: txt, url, visuel: VISUEL_PREZ,
        bouton: '📊 Voir mon analyse', repli_sms: repli, segments_sms: diag.segments, alphabet: diag.alphabet });
    }

    let envoi = null;
    const senderId0 = process.env.SOFY_RCS_SENDER_ID;
    if (cleV2() && senderId0) {
      try {
        const r = await fetch('https://api.sofy.fr/v2/rcs/rich-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleV2()}` },
          body: JSON.stringify({
            to: tel, senderId: senderId0,
            title: `📊 Votre analyse Sofy${row.client ? ' — ' + row.client : ''}`.slice(0, 60),
            description: txt + stopP, imageUrl: VISUEL_PREZ,
            button: { label: '📊 Voir mon analyse', url },
            fallback: { enabled: true, text: repli }
          })
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.id) envoi = { canal: d.isSmsFallback ? 'sms (repli Sofy)' : 'rcs', id: d.id };
        else envoi = { erreur: 'RCS ' + r.status + ': ' + JSON.stringify(d).slice(0, 200) };
      } catch (e) { envoi = { erreur: 'RCS injoignable : ' + String((e && e.message) || e).slice(0, 120) }; }
    }
    // Second filet : si l'agent RCS n'a pas répondu, le SMS v1 part quand même avec le lien.
    if (!envoi || envoi.erreur) {
      const v1 = await envoyerSmsSofy({ to: tel, message: repli, user: user.nom, liste_id: b.liste_id || null, transactionnel: false });
      if (v1.ok) envoi = { canal: 'sms (v1)', id: v1.id || null, rcs_echec: envoi && envoi.erreur };
      else return res.status(502).json({ erreur: 'Envoi refusé', detail: (envoi && envoi.erreur) || v1.detail });
    }

    try { await loggerConso(user.nom, 'soreach', 1, b.liste_id || null); } catch (_) {}
    // Le destinataire est mémorisé sur l'analyse : c'est lui qui rend lisible le signal
    // « quelqu'un lit » dans Ma journée (« lien envoyé à … »).
    try { await sql`UPDATE prez SET destinataire = COALESCE(destinataire, ${tel}) WHERE jeton = ${jeton}`; } catch (_) {}
    // Trace d'envoi sur le destinataire nommé : la fiche dira « envoyée à Léo le 20/08, par RCS ».
    if (dn != null && dn >= 0) {
      try {
        const [rr] = await sql`SELECT destinataires FROM prez WHERE jeton = ${jeton}`;
        const ds = Array.isArray(rr && rr.destinataires) ? rr.destinataires.slice() : [];
        if (ds[dn]) {
          ds[dn] = { ...ds[dn], envoye_le: new Date().toISOString(), canal: envoi.canal };
          await sql`UPDATE prez SET destinataires = ${JSON.stringify(ds)}::jsonb WHERE jeton = ${jeton}`;
        }
      } catch (_) {}
    }
    const cleP = String(b.email_cle || b.cle_fiche || '').toLowerCase().trim() || null;
    if (cleP) {
      try { await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
        VALUES (${cleP}, 'sms', 'rcs_prez', ${'📊 Analyse envoyée par ' + envoi.canal},
          ${url + ' → ' + tel}, ${user.nom || 'système'}, NOW())`; } catch (_) {}
    }
    return res.status(200).json({ ok: true, canal: envoi.canal, id: envoi.id || null, tel, url,
      repli_sms: repli, segments_sms: diag.segments });
  }
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
