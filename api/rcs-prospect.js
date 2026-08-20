// /api/rcs-prospect.js — 💬 RCS de prospection : le prospect reçoit une rich-card Sofy…
// qui EST la démonstration du produit (SoReach RCS). Envoyé depuis « Ma journée » ou la fiche.
// POST { tel, prenom?, entreprise?, accroche?, email_cle?, liste_id?, texte? }
//   → rich-card (visuel + titre + texte personnalisé + bouton « Réserver ma démo »)
//   → repli SMS v1 route alerte si le RCS échoue ; note dans le bloc-notes ; conso journalisée.
// GET ?apercu=1&… → texte proposé sans rien envoyer (prévisualisation avant envoi).
// ⚠️ Prospection B2B : mention de désinscription obligatoire dans le texte (ajoutée automatiquement).

import { verifierToken, sql, ensureSchema, envoyerSmsSofy, loggerConso } from './db.js';
import { gsmifier, analyserSms } from './sms-gsm.js';

// ⚠️ L'API v2 (RCS) attend un jeton Bearer sofy_live_…. rcs-rdv-cron.js accepte les DEUX noms de
// variable depuis le 06/08 ; ici il n'y avait que SOFY_API_KEY_V2 — si Vercel ne porte que
// SOFY_API_KEY, le bloc RCS était sauté en silence et tout partait en SMS v1 (bug du 20/08).
const cleV2 = () => process.env.SOFY_API_KEY_V2 || process.env.SOFY_API_KEY || '';
// Réservation de démo côté PROSPECT (parcours « site web », adapté au mobile).
// ⚠️ Ne pas utiliser demo-sdr : c'est le calendrier interne réservé aux SDR.
const LIEN_DEMO = process.env.SOFY_LIEN_DEMO || 'https://go.sofy.fr/meetings/mbouly/demo-site-web';
const VISUEL = process.env.SOFY_RCS_IMAGE_DEMO || 'https://www.sofyscrap.com/rcs-demo.jpg';
const BASE_PUB = () => process.env.SOFY_BASE_PUBLIQUE || 'https://www.sofyscrap.com';
// Visuel de la carte « analyse » : la création Sofy « Découvrez votre analyse personnalisée »,
// servie depuis public/ (1000×1000, 157 Ko — assez léger pour s'afficher avant que le prospect
// referme sa messagerie). Un RCS sans image n'a pas d'intérêt : c'est justement ce qu'on vend.
// ⚠️ fallback.text est plafonné à 129 caractères par l'API v2 : au-delà, la rich-card est
// refusée (400) et l'envoi retombe en SMS. Limite constatée au test du 06/08.
const MAX_FALLBACK = 129;
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

  // ── Suivi d'acheminement d'un message déjà envoyé : ?statut=<id> ──
  // Sans lui, « je n'ai rien reçu » reste une impression. L'API v2 sait dire si le message a été
  // remis, rejeté, ou s'il attend. Les deux chemins sont testés (SMS puis RCS) : l'id ne dit pas
  // de quel canal il vient.
  if (req.method === 'GET' && req.query && req.query.statut) {
    const idM = String(req.query.statut).slice(0, 80);
    const hd = { Authorization: `Bearer ${cleV2()}` };
    if (!cleV2()) return res.status(500).json({ erreur: 'Aucune clé API v2 (SOFY_API_KEY_V2 / SOFY_API_KEY)' });
    for (const chemin of ['/v2/sms/', '/v2/rcs/']) {
      try {
        const r = await fetch('https://api.sofy.fr' + chemin + encodeURIComponent(idM), { headers: hd });
        const d = await r.json().catch(() => ({}));
        if (r.ok && (d.id || d.status)) {
          return res.status(200).json({ ok: true, via: chemin.replace(/\//g, ''), message: d,
            statut: d.status || null, remis: /deliver/i.test(String(d.status || '')),
            rejete: /reject|fail|undeliver/i.test(String(d.status || '')) });
        }
      } catch (_) { }
    }
    return res.status(404).json({ erreur: 'Message introuvable côté API (id inconnu des canaux SMS et RCS)' });
  }

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

  // ── Test de la route SMS de l'API v2 (superadmin) ──
  // Question de Didier le 21/08 : « l'API v2 gère-t-elle le SMS comme la v1 ? ». Le code portait
  // la réponse du 07/08 (« rejected by provider ») ; un an de produit plus tard, elle mérite
  // d'être revérifiée sur pièce plutôt que citée de mémoire. Ce test envoie UN vrai SMS, il est
  // donc explicite, réservé au superadmin, et rend la réponse brute de l'API + l'id de suivi.
  if (String(b.action || '') === 'test_sms_v2') {
    if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
    if (!cleV2()) return res.status(500).json({ erreur: 'Aucune clé API v2 (SOFY_API_KEY_V2 / SOFY_API_KEY)' });
    const corps = String(b.texte || 'Sofy : test technique de la route SMS v2. Aucune action attendue.').slice(0, 140);
    const payload = Object.assign({ to: tel, body: corps, isTransactional: true },
      process.env.SOFY_SMS_FROM ? { from: process.env.SOFY_SMS_FROM } : {});
    try {
      const r = await fetch('https://api.sofy.fr/v2/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleV2()}` },
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(() => ({}));
      return res.status(200).json({
        ok: r.ok, http: r.status, reponse: d, tel,
        expediteur_envoye: process.env.SOFY_SMS_FROM || '(défaut du compte)',
        suivi: d && d.id ? 'Acheminement : GET /api/rcs-prospect?statut=' + d.id : null,
        lecture: r.ok && d.id
          ? 'La route SMS v2 accepte l\'envoi. Vérifie l\'acheminement avec le suivi ci-dessus : le 07/08, elle acceptait puis le provider rejetait.'
          : 'La route SMS v2 a refusé l\'envoi — la v1 reste le canal SMS de référence.'
      });
    } catch (e) {
      return res.status(502).json({ erreur: 'API v2 injoignable', detail: String((e && e.message) || e).slice(0, 200) });
    }
  }

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
    // Le repli SMS a DEUX contraintes, et j'en avais oublié une le 20/08 :
    //  · alphabet GSM — une apostrophe courbe ou un ★ fait basculer tout le message en UCS-2 ;
    //  · 129 CARACTÈRES MAXIMUM — au-delà, l'API v2 refuse la rich-card avec un 400 (limite
    //    documentée dans rcs-rdv-cron.js depuis le test du 06/08). Mon repli faisait 135
    //    caractères : le RCS était donc rejeté à chaque envoi, et le SMS v1 prenait le relais.
    const queue = ' STOP pour ne plus etre contacte.';
    let repli = gsmifier(`Sofy : votre analyse est prete. ${url}${queue}`);
    if (repli.length > MAX_FALLBACK) repli = gsmifier(`Sofy : votre analyse. ${url}`).slice(0, MAX_FALLBACK);
    const diag = analyserSms(repli);

    if (b.apercu) {
      return res.status(200).json({ ok: true, apercu: true, texte: txt, url, visuel: VISUEL_PREZ,
        bouton: '📊 Voir mon analyse', repli_sms: repli, segments_sms: diag.segments, alphabet: diag.alphabet,
        // La longueur est affichée à l'écran : au-delà de 129, l'API v2 refuse la rich-card et
        // tout partirait en SMS. Le bug du 20/08 aurait été visible avant l'envoi.
        repli_longueur: repli.length, repli_max: MAX_FALLBACK,
        rcs_configure: !!(cleV2() && process.env.SOFY_RCS_SENDER_ID) });
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
        if (r.ok && d.id) envoi = { canal: d.isSmsFallback ? 'sms (repli Sofy)' : 'rcs', id: d.id,
          repli_operateur: !!d.isSmsFallback, statut_api: d.status || null };
        else envoi = { erreur: 'RCS ' + r.status + ': ' + JSON.stringify(d).slice(0, 200) };
      } catch (e) { envoi = { erreur: 'RCS injoignable : ' + String((e && e.message) || e).slice(0, 120) }; }
    }
    // Quand la rich-card passe, c'est l'API v2 qui gère elle-même la bascule SMS : on n'a rien à
    // faire. Les étages ci-dessous ne servent QUE si la rich-card a été refusée — et l'erreur
    // remonte jusqu'à l'écran, pour qu'un refus ne ressemble plus à un envoi normal.
    if ((!envoi || envoi.erreur) && cleV2()) {
      // SMS de l'API v2, avec le lien complet (pas de limite 129 ici).
      try {
        const rs = await fetch('https://api.sofy.fr/v2/sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cleV2()}` },
          body: JSON.stringify(Object.assign({ to: tel, body: repli, isTransactional: false },
            process.env.SOFY_SMS_FROM ? { from: process.env.SOFY_SMS_FROM } : {}))
        });
        const ds = await rs.json().catch(() => ({}));
        if (rs.ok && ds.id) envoi = { canal: 'sms (v2)', id: ds.id, rcs_echec: envoi && envoi.erreur };
      } catch (_) { }
    }
    // Dernier filet : l'API v1, éprouvée. La route SMS de la clé v2 est « rejected by provider »
    // toutes destinations depuis le 07/08 — à régler côté produit.
    if (!envoi || envoi.erreur) {
      // Sans ma mention STOP : db.js ajoute celle qui est légalement due, avec le BON code court
      // selon le territoire (36789 en DOM, 36229 en métropole). En laisser deux serait fautif.
      const pourV1 = repli.replace(/\s*STOP pour ne plus etre contacte\.?\s*$/i, '').trim();
      const v1 = await envoyerSmsSofy({ to: tel, message: pourV1, user: user.nom, liste_id: b.liste_id || null, transactionnel: false });
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
          ${url + ' → ' + tel + (envoi.rcs_echec ? ' · RCS non parti : ' + String(envoi.rcs_echec).slice(0, 180) : '')},
          ${user.nom || 'système'}, NOW())`; } catch (_) {}
    }
    // Un +590 / +596 / +594 / +262 : le repli SMS y part avec l'expéditeur 36789 et arrive avec
    // quelques minutes de retard, le temps que l'opérateur renonce au RCS (vérifié le 21/08 sur
    // un +590 non compatible RCS). On le signale pour que l'attente ne passe pas pour un échec.
    const estDom = /^\+(590|596|594|262)/.test(tel);
    return res.status(200).json({ ok: true, canal: envoi.canal, id: envoi.id || null, tel, url,
      repli_operateur: !!envoi.repli_operateur, statut_api: envoi.statut_api || null,
      dom: estDom, heure_paris: new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date()),
      repli_sms: repli, segments_sms: diag.segments,
      // Pourquoi le RCS n'est pas parti : sans ça, « envoyé par sms (v1) » ne dit pas si l'agent
      // RCS a refusé, si la clé manque, ou si le mobile ne gère simplement pas le RCS.
      rcs_echec: (envoi && envoi.rcs_echec) || null,
      rcs_configure: !!(cleV2() && process.env.SOFY_RCS_SENDER_ID) });
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
