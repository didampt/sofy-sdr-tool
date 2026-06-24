// /api/lemlist-webhook.js — réception des événements Lemlist
//   GET ?register=1 -> enregistre le webhook chez Lemlist (tous événements) + secret
//   GET ?hooks=1    -> liste les webhooks enregistrés
//   GET ?voir=1     -> 20 derniers événements bruts (debug)
//   POST (Lemlist)  -> vérifie le secret, journalise dans `activites`, et stoppe la prospection (SMS/tâche) si réponse/intéressé
import crypto from 'crypto';
import { sql, ensureSchema } from './db.js';

function authHeader() { return 'Basic ' + Buffer.from(':' + process.env.LEMLIST_API_KEY).toString('base64'); }

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
  } catch (_) {}
}

// Trouve le SDR proprietaire du lead (celui qui l'a pousse en sequence) et lui envoie une alerte Slack
async function alerterSdr(email, titre, b, campagne) {
  try {
    const own = await sql`SELECT auteur FROM activites WHERE fiche_cle = ${email} AND type = 'sequenceAdded' AND auteur IS NOT NULL ORDER BY ts DESC LIMIT 1`;
    const sdrNom = (own.length && own[0].auteur) || b.sendUserName || b.userName || null;
    if (!sdrNom) return;
    const s = await sql`SELECT slack_id FROM sdrs WHERE nom = ${sdrNom} AND slack_id IS NOT NULL AND slack_id <> '' LIMIT 1`;
    if (!s.length) return;
    const qui = [b.firstName || b.leadFirstName, b.lastName || b.leadLastName].filter(Boolean).join(' ');
    const ent = b.companyName || b.company || '';
    const url = process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app';
    const txt = `🔥 *${titre}* — ${qui || email}${ent ? ' · ' + ent : ''}\nCampagne : ${campagne || '—'}\n👉 Le lead reagit, recontacte-le a chaud : ${url}`;
    await envoyerDM(s[0].slack_id, txt);
  } catch (_) {}
}

// Libellés FR pour la chronologie
const LIBELLES = {
  contacted: "Contacté", hooked: "A ouvert un message", attracted: "A cliqué / invitation acceptée", warmed: "A répondu",
  interested: "Intéressé", notInterested: "Pas intéressé",
  emailsSent: "Email envoyé", emailsOpened: "Email ouvert", emailsClicked: "Lien cliqué", emailsReplied: "A répondu à l'email",
  emailsBounced: "Email rejeté (bounce)", emailsFailed: "Échec d'envoi email", emailsInterested: "Intéressé (email)",
  emailsNotInterested: "Pas intéressé (email)", emailsUnsubscribed: "Désabonné",
  linkedinSent: "Message LinkedIn envoyé", linkedinOpened: "Message LinkedIn ouvert", linkedinReplied: "A répondu sur LinkedIn",
  linkedinInterested: "Intéressé (LinkedIn)", linkedinNotInterested: "Pas intéressé (LinkedIn)",
  linkedinVisitDone: "Profil LinkedIn visité", linkedinFollowDone: "Suivi sur LinkedIn",
  linkedinInviteDone: "Invitation LinkedIn envoyée", linkedinInviteAccepted: "Invitation LinkedIn acceptée",
  linkedinVoiceNoteDone: "Note vocale LinkedIn envoyée",
  whatsappMessageSent: "WhatsApp envoyé", whatsappMessageDelivered: "WhatsApp délivré", whatsappReplied: "A répondu sur WhatsApp",
  smsSent: "SMS envoyé", smsDelivered: "SMS délivré", smsReplied: "A répondu au SMS",
  aircallEnded: "Appel terminé", aircallInterested: "Intéressé (appel)", callRecordingDone: "Enregistrement d'appel prêt", callTranscriptDone: "Transcription prête",
  manualInterested: "Marqué intéressé", manualNotInterested: "Marqué pas intéressé",
  paused: "Lead mis en pause", resumed: "Lead réactivé", stopped: "Lead arrêté", campaignComplete: "Séquence terminée",
  annotated: "Annotation", apiDone: "Étape API exécutée"
};

// Événements qui stoppent la prospection Sofy (annule le SMS programmé + clôt la tâche)
const STOP = [
  'warmed', 'emailsReplied', 'linkedinReplied', 'whatsappReplied', 'smsReplied',
  'interested', 'emailsInterested', 'linkedinInterested', 'aircallInterested', 'apiInterested', 'manualInterested',
  'notInterested', 'emailsNotInterested', 'linkedinNotInterested', 'aircallNotInterested', 'apiNotInterested', 'manualNotInterested',
  'emailsUnsubscribed', 'stopped'
];

// Le lead a REAGI -> on alerte le SDR sur Slack pour qu'il recontacte a chaud
const ALERTE = [
  'emailsOpened', 'emailsClicked', 'emailsReplied', 'emailsInterested',
  'linkedinOpened', 'linkedinReplied', 'linkedinInviteAccepted', 'linkedinInterested',
  'whatsappReplied', 'smsReplied',
  'interested', 'aircallInterested', 'manualInterested'
];

export default async function handler(req, res) {
  if (sql) await ensureSchema();
  const q = req.query || {};

  // 1) Enregistrement one-shot du webhook (tous les événements)
  if (req.method === 'GET' && q.register) {
    if (!process.env.LEMLIST_API_KEY) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante' });
    if (sql) {
      const ex = await sql`SELECT valeur FROM config WHERE cle = 'lemlist_hook'`;
      if (ex.length && ex[0].valeur && ex[0].valeur.hookId) return res.status(200).json({ ok: true, deja: true, hook: ex[0].valeur });
    }
    const base = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');
    const targetUrl = base + '/api/lemlist-webhook';
    const secret = crypto.randomBytes(16).toString('hex');
    try {
      const r = await fetch('https://api.lemlist.com/api/hooks', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
        body: JSON.stringify({ targetUrl, secret })
      });
      const txt = await r.text(); let data = {}; try { data = JSON.parse(txt); } catch (_) {}
      if (r.ok && sql) {
        const val = JSON.stringify({ secret, hookId: data._id || null, targetUrl });
        await sql`INSERT INTO config (cle, valeur) VALUES ('lemlist_hook', ${val}::jsonb)
          ON CONFLICT (cle) DO UPDATE SET valeur = ${val}::jsonb`;
      }
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, targetUrl, hook: data, status: r.status, body: r.ok ? undefined : txt.slice(0, 300) });
    } catch (e) { return res.status(500).json({ erreur: e.message }); }
  }

  // 1bis) Lister les webhooks enregistrés
  if (req.method === 'GET' && q.hooks) {
    if (!process.env.LEMLIST_API_KEY) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante' });
    try {
      const r = await fetch('https://api.lemlist.com/api/hooks', { headers: { 'Authorization': authHeader() } });
      const txt = await r.text(); let data = txt; try { data = JSON.parse(txt); } catch (_) {}
      return res.status(200).json({ status: r.status, hooks: data });
    } catch (e) { return res.status(500).json({ erreur: e.message }); }
  }

  // 1ter) Lister les utilisateurs Lemlist AVEC leur email (= contactOwner pour chaque SDR)
  if (req.method === 'GET' && q.team) {
    if (!process.env.LEMLIST_API_KEY) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante' });
    try {
      const headers = { 'Authorization': authHeader() };
      const t = await fetch('https://api.lemlist.com/api/team', { headers });
      const team = await t.json().catch(() => ({}));
      const ids = (team && team.userIds) || [];
      const users = await Promise.all(ids.map(async (id) => {
        try {
          const u = await fetch('https://api.lemlist.com/api/users/' + encodeURIComponent(id), { headers });
          const ud = await u.json().catch(() => ({}));
          return { id, email: ud.email || ud.login || null, nom: ((ud.firstName || '') + ' ' + (ud.lastName || '')).trim() || null };
        } catch (e) { return { id, erreur: e.message }; }
      }));
      return res.status(200).json({ users });
    } catch (e) { return res.status(500).json({ erreur: e.message }); }
  }

  // 2) Voir les derniers événements bruts (debug)
  if (req.method === 'GET' && q.voir) {
    if (!sql) return res.status(500).json({ erreur: 'pas de base' });
    const rows = await sql`SELECT id, recu_le, type, email, brut FROM lemlist_events ORDER BY id DESC LIMIT 20`;
    return res.status(200).json({ count: rows.length, events: rows });
  }

  // 3) Réception d'un événement Lemlist
  if (req.method === 'POST') {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
    b = b || {};
    try {
      const email = b.leadEmail || b.email || null;
      const type = b.type || (b.metaData && b.metaData.type) || null;
      if (sql) await sql`INSERT INTO lemlist_events (type, email, brut) VALUES (${type}, ${email}, ${JSON.stringify(b)}::jsonb)`;

      // Vérification du secret (la requête vient bien de Lemlist)
      let attendu = null;
      if (sql) { const c = await sql`SELECT valeur FROM config WHERE cle = 'lemlist_hook'`; attendu = c.length && c[0].valeur ? c[0].valeur.secret : null; }
      if (attendu && b.secret && b.secret !== attendu) return res.status(200).json({ ok: true, ignore: 'secret' });

      if (sql && email && type) {
        const ref = b._id || null;
        const ts = b.createdAt || new Date().toISOString();
        const auteur = b.userName || b.sendUserName || null;
        const detail = b.campaignName || null;
        const titre = LIBELLES[type] || type;
        // 1ere occurrence de ce signal pour ce lead ? (alerter une seule fois, pas a chaque ouverture)
        let premiereFois = false;
        if (ALERTE.includes(type)) {
          const v = await sql`SELECT 1 FROM activites WHERE fiche_cle = ${email} AND type = ${type} LIMIT 1`;
          premiereFois = (v.length === 0);
        }
        await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ref, ts)
          VALUES (${email}, 'lemlist', ${type}, ${titre}, ${detail}, ${auteur}, ${ref}, ${ts})
          ON CONFLICT (ref) DO NOTHING`;
        // Le lead a réagi → on stoppe la prospection Sofy (SMS programmé + tâche de rappel)
        if (STOP.includes(type)) {
          await sql`UPDATE sms_programmes SET statut = 'cancelled' WHERE email = ${email} AND statut = 'pending'`;
          await sql`UPDATE taches SET faite = TRUE WHERE fiche_cle = ${email} AND faite = FALSE`;
        }
        // Signal d'engagement -> alerte Slack immediate au SDR (1ere fois seulement)
        if (premiereFois) await alerterSdr(email, titre, b, detail);
      }
    } catch (e) { /* on repond 200 quoi qu il arrive */ }
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true, info: 'lemlist-webhook actif' });
}
