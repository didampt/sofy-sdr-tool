// /api/rcs-rdv-cron.js — 🛡️ Anti no-show : rappel RCS (repli SMS) des démos HubSpot à venir.
// Deux rappels par démo : J-1 (la veille, fenêtre 23-25 h avant) et H-2 (fenêtre 1 h 30-2 h 30 avant).
// Source : réunions HubSpot (hs_meeting_start_time) → contact associé → mobile.
// Envoi : API Sofy (api.sofy.fr/v2) — rich-card RCS si SOFY_RCS_SENDER_ID est défini, sinon SMS.
// Anti-doublon : table paresseuse rcs_rdv_envoyes (UNIQUE meeting_id + type). ?dry=1 = simulation.
// Env requis : SOFY_API_KEY (sofy_live_…) ; optionnels : SOFY_RCS_SENDER_ID, SOFY_SMS_FROM (déf. Sofy).
// Cron horaire jours ouvrés (vercel.json) — en-tête x-vercel-cron, Bearer CRON_SECRET ou superadmin.

import { verifierToken, sql, ensureSchema, envoyerSmsSofy } from './db.js';
import { jetonRdv } from './rdv-confirme.js';

const HS = 'https://api.hubapi.com';

// Table paresseuse (pattern ensureCoach — pas de bump SCHEMA_VERSION, DDL sans mot réservé)
async function ensureRcsRdv() {
  await sql`CREATE TABLE IF NOT EXISTS rcs_rdv_envoyes (
    id SERIAL PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    type TEXT NOT NULL,
    tel TEXT,
    contact TEXT,
    ts TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (meeting_id, type)
  )`;
  // colonnes ajoutées après coup — ADD IF NOT EXISTS = sûr
  await sql`ALTER TABLE rcs_rdv_envoyes ADD COLUMN IF NOT EXISTS email TEXT`;
  await sql`ALTER TABLE rcs_rdv_envoyes ADD COLUMN IF NOT EXISTS date_rdv TIMESTAMPTZ`;
  await sql`ALTER TABLE rcs_rdv_envoyes ADD COLUMN IF NOT EXISTS reponse TEXT`;
}

// 🗓 Lien « Ajouter à mon agenda Google » (RCS = Android : Google Calendar est le bon réflexe)
function lienAgenda(debutMs, ae) {
  const deb = new Date(debutMs), fin = new Date(debutMs + 45 * 60000);
  const f = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('Rendez-vous Sofy' + (ae ? ' avec ' + ae : ''))
    + '&dates=' + f(deb) + '/' + f(fin) + '&details=' + encodeURIComponent('Votre rendez-vous Sofy — sofy.fr');
}

// Numéro FR/DOM → E.164 (+590 Guadeloupe, +596 Martinique, +594 Guyane, +262 Réunion/Mayotte, +33 métropole)
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

// ⚠️ L'API v2 (RCS) attend un jeton Bearer sofy_live_… — différent du couple
// SOFY_API_KEY_ID/SECRET de l'API v1 utilisée par l'envoi SMS SoReach (db.js).
const cleV2 = () => process.env.SOFY_API_KEY_V2 || process.env.SOFY_API_KEY || '';

async function envoyerSofy(tel, titre, texte, bouton, replicourt, sauterV2) {
  const cle = cleV2();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cle}` };
  const senderId = process.env.SOFY_RCS_SENDER_ID;
  // ⚠️ fallback.text est limité à 129 caractères par l'API (erreur 400 sinon, test du 06/08)
  const fbk = String(replicourt || (titre + ' — ' + texte)).slice(0, 129);
  // 1) RCS rich-card si un expéditeur RCS est configuré (repli SMS géré par Sofy via fallback)
  if (senderId) {
    try {
      const corps = { to: tel, senderId, title: titre, description: texte, fallback: { enabled: true, text: fbk } };
      // 🖼️ Visuel « Votre rendez-vous approche » — hébergé sur sofyscrap.com (public/rcs-rdv.jpg),
      // surchargeable par SOFY_RCS_IMAGE_URL
      corps.imageUrl = process.env.SOFY_RCS_IMAGE_URL || 'https://www.sofyscrap.com/rcs-rdv.jpg';
      // 📞 Bouton « Je reporte » → lance l'appel vers le SDR qui a pris le RDV (lien tel:)
      if (bouton && bouton.url) corps.button = bouton;
      const r = await fetch('https://api.sofy.fr/v2/rcs/rich-card', {
        method: 'POST', headers,
        body: JSON.stringify(corps)
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.id) return { ok: true, canal: d.isSmsFallback ? 'sms (repli)' : 'rcs', id: d.id };
      var rcsEchec = 'RCS ' + r.status + ': ' + JSON.stringify(d).slice(0, 200); // → diagnostic
    } catch (e) { var rcsEchec = 'RCS exception: ' + e.message; }
  }
  // 2) SMS direct
  if (sauterV2) { // test ?canal=sms&v1=1 : valider directement l'étage v1 (le POST v2 répond 201
    // mais le provider rejette ensuite — l'API ne nous laisse pas le voir de façon synchrone)
    try {
      const v1 = await envoyerSmsSofy({ to: tel, message: fbk, user: 'rcs-rdv', liste_id: null, transactionnel: true });
      if (v1.ok) return { ok: true, canal: 'sms (' + (v1.via || '?') + ')', id: v1.id || null };
      return { ok: false, erreur: 'sms: ' + (v1.detail || v1.status) };
    } catch (e) { return { ok: false, erreur: 'v1: ' + e.message }; }
  }
  // ⚠️ CE FICHIER AVAIT SON PROPRE ÉTAGE /v2/sms, et il posait `from` UNIQUEMENT si
  // SOFY_SMS_FROM était défini dans Vercel. Sans cette variable, le compte utilisait son
  // expéditeur par défaut — le code court DOM 36789, rejeté vers la métropole (incident du
  // 07/08). Et comme cet étage passait AVANT envoyerSmsSofy(), le chemin cassé gagnait.
  // Il est supprimé : tous les SMS de l'application passent par envoyerSmsSofy(), qui tente la
  // v2 avec l'expéditeur « SOFY » puis retombe sur la v1. Un seul chemin, un seul correctif.
  try {
    const sms = await envoyerSmsSofy({ to: tel, message: fbk, user: 'rcs-rdv', liste_id: null, transactionnel: true });
    if (sms.ok) return { ok: true, canal: 'sms (' + (sms.via || '?') + ')', id: sms.id || null, statut: sms.statut || null, rcs_echec: typeof rcsEchec !== 'undefined' ? rcsEchec : null };
    return { ok: false, erreur: String(sms.detail || sms.status || 'envoi refusé').slice(0, 200), rcs_echec: typeof rcsEchec !== 'undefined' ? rcsEchec : null };
  } catch (e) {
    return { ok: false, erreur: String((e && e.message) || e).slice(0, 200), rcs_echec: typeof rcsEchec !== 'undefined' ? rcsEchec : null };
  }
}

export default async function handler(req, res) {
  const estCron = !!req.headers['x-vercel-cron'] ||
    (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`);
  const user = estCron ? null : verifierToken(req);
  if (!estCron && (!user || user.role !== 'superadmin')) return res.status(401).json({ erreur: 'Cron ou superadmin uniquement' });
  const dry = req.query.dry === '1';

  try {
    await ensureSchema();
    await ensureRcsRdv();
    if (!cleV2()) return res.status(200).json({ ok: true, info: 'SOFY_API_KEY_V2 absente — rappels RCS inactifs' });
    if (!String(cleV2()).startsWith('sofy_live_')) return res.status(200).json({ ok: true, info: 'La clé trouvée n\'est pas un jeton API v2 (sofy_live_…) — crée SOFY_API_KEY_V2 dans Vercel' });
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'rcs_rdv'`;
    const cfg = cfgRows.length ? (cfgRows[0].valeur || {}) : {};
    if (cfg.actif === false) return res.status(200).json({ ok: true, info: 'Désactivé (config rcs_rdv.actif=false)' });

    // ── Test réel vers un numéro (superadmin) : ?test_tel=+33687834783 ──
    if (req.query.test_tel) {
      if (!user || user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const telT = e164(req.query.test_tel);
      if (!telT) return res.status(400).json({ erreur: 'Numéro invalide' });
      const demain = new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: '2-digit', month: 'long' });
      const titreT = '📅 Votre rendez-vous Sofy, c\'est demain !';
      const texteT = `Didier, rendez-vous ${demain} à 10:00 avec Sarah. Nous avons hâte de vous retrouver ! 😊 ✅ Un clic pour confirmer, et c'est noté. Un imprévu ? 📞 Alicia au +33612345678. (ceci est un TEST)`;
      // Meeting fictif « test » enregistré → le bouton de confirmation fonctionne de bout en bout
      try { await sql`INSERT INTO rcs_rdv_envoyes (meeting_id, type, tel, contact, email, date_rdv)
        VALUES ('test', 'j1', ${telT}, 'Didier (test)', ${user.email || null}, ${new Date(Date.now() + 24 * 3600 * 1000).toISOString()})
        ON CONFLICT (meeting_id, type) DO UPDATE SET reponse = NULL, date_rdv = ${new Date(Date.now() + 24 * 3600 * 1000).toISOString()}`; } catch (_) {}
      const forceSms = req.query.canal === 'sms'; // ?canal=sms → teste le repli SMS (RCS sauté)
      const boutonT = { label: '✅ Je confirme mon RDV', url: 'https://www.sofyscrap.com/api/rdv-confirme?m=test&t=' + jetonRdv('test') };
      const envT = forceSms
        ? await (async () => { const s = process.env.SOFY_RCS_SENDER_ID; delete process.env.SOFY_RCS_SENDER_ID;
            const rT = await envoyerSofy(telT, titreT, texteT, boutonT,
              `Rappel Sofy : votre rendez-vous demain 10:00 avec Sarah. Un imprévu ? Appelez le ${telT}. (TEST)`, req.query.v1 === '1');
            if (s) process.env.SOFY_RCS_SENDER_ID = s; return rT; })()
        : await envoyerSofy(telT, titreT, texteT, boutonT,
          `Rappel Sofy : votre rendez-vous demain 10:00 avec Sarah. Un empêchement ? Appelez le ${telT}. (TEST)`);
      return res.status(200).json({ ok: envT.ok, test: true, tel: telT, canal: envT.canal || null, id: envT.id || null,
        statut: envT.statut || null, rcs_echec: envT.rcs_echec || null, detail: envT.erreur || null,
        suivi: envT.id ? 'Statut d\'acheminement : ?statut=' + envT.id : null });
    }

    // ── Expéditeurs RCS de l'organisation (superadmin) : ?senders=1 → id à mettre dans SOFY_RCS_SENDER_ID ──
    if (req.query.senders) {
      if (!user || user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const hd = { Authorization: `Bearer ${cleV2()}` };
      for (const chemin of ['/v2/rcs/senders', '/v2/senders', '/v2/rcs/sender-ids']) {
        try {
          const r = await fetch('https://api.sofy.fr' + chemin, { headers: hd });
          const d = await r.json().catch(() => ({}));
          if (r.ok) return res.status(200).json({ ok: true, via: chemin, senders: d });
        } catch (_) {}
      }
      return res.status(404).json({ erreur: 'Endpoint senders introuvable — récupère l\'ID dans le dashboard Sofy (section RCS)' });
    }

    // ── Suivi d'acheminement d'un message (superadmin) : ?statut=<id> ──
    if (req.query.statut) {
      if (!user || user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const idM = String(req.query.statut);
      const hd = { Authorization: `Bearer ${cleV2()}` };
      for (const chemin of ['/v2/sms/', '/v2/rcs/']) {
        try {
          const r = await fetch('https://api.sofy.fr' + chemin + encodeURIComponent(idM), { headers: hd });
          const d = await r.json().catch(() => ({}));
          if (r.ok && (d.id || d.status)) return res.status(200).json({ ok: true, via: chemin, message: d });
        } catch (_) {}
      }
      return res.status(404).json({ erreur: 'Message introuvable (id inconnu des deux canaux)' });
    }

    const cleHS = process.env.HUBSPOT_API_KEY;
    if (!cleHS) return res.status(200).json({ ok: true, info: 'HUBSPOT_API_KEY absente' });
    const H = { Authorization: `Bearer ${cleHS}`, 'Content-Type': 'application/json' };

    // ── 1. Réunions HubSpot des prochaines 26 h ──
    const mtn = Date.now();
    const rM = await fetch(`${HS}/crm/v3/objects/meetings/search`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'hs_meeting_start_time', operator: 'BETWEEN', value: String(mtn), highValue: String(mtn + 26 * 3600 * 1000) }] }],
        properties: ['hs_meeting_start_time', 'hs_meeting_title', 'hs_meeting_outcome', 'hubspot_owner_id'], limit: 100
      })
    });
    const dM = await rM.json().catch(() => ({}));
    if (!rM.ok) return res.status(502).json({ erreur: 'HubSpot meetings', detail: JSON.stringify(dM).slice(0, 250) });
    const meetings = (dM.results || []).filter(m => !/cancel/i.test(String((m.properties || {}).hs_meeting_outcome || '')));

    const resume = { ok: true, dry, reunions_26h: meetings.length, envoyes: [], ignores: [] };
    if (!meetings.length) return res.status(200).json(resume);

    // ── 2. Contact associé (téléphone) par réunion ──
    const rA = await fetch(`${HS}/crm/v4/associations/meetings/contacts/batch/read`, {
      method: 'POST', headers: H, body: JSON.stringify({ inputs: meetings.map(m => ({ id: m.id })) })
    });
    const dA = await rA.json().catch(() => ({}));
    const contactDe = new Map(); const cids = new Set();
    for (const r of (dA.results || [])) {
      const cid = r.to && r.to[0] && (r.to[0].toObjectId || r.to[0].id);
      if (r.from && cid) { contactDe.set(String(r.from.id), String(cid)); cids.add(String(cid)); }
    }
    const parContact = new Map();
    if (cids.size) {
      const rC = await fetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ properties: ['firstname', 'lastname', 'email', 'mobilephone', 'phone', 'company'], inputs: [...cids].map(id => ({ id })) })
      });
      const dC = await rC.json().catch(() => ({}));
      for (const c of (dC.results || [])) parContact.set(String(c.id), c.properties || {});
    }

    // ── 2a. Portal id HubSpot (liens cliquables vers les fiches contact dans Slack) ──
    let portalId = null;
    try {
      const rP = await fetch(`${HS}/account-info/v3/details`, { headers: H });
      const dP = await rP.json().catch(() => ({}));
      portalId = dP.portalId || null;
    } catch (_) {}

    // ── 2b. AE des réunions (owners) + SDR sourceur par entreprise (fiches Sofy) + n° Ringover ──
    let ownersMap = new Map();
    try {
      const ro = await fetch(`${HS}/crm/v3/owners/?limit=500`, { headers: H });
      const doo = await ro.json().catch(() => ({}));
      ownersMap = new Map((doo.results || []).map(o => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || '']));
    } catch (_) {}
    const normE = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const srcParEnt = {}, telParSdr = {};
    try {
      const sd = await sql`SELECT nom, ringover_numero FROM sdrs`;
      for (const s of sd) if (s.ringover_numero) telParSdr[s.nom] = e164(s.ringover_numero);
      const ls = await sql`SELECT entreprises FROM listes`;
      for (const l of ls) for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
        const st = (e.tags_sdr || [])[0] || e.statut_appel || '';
        if (String(st).indexOf('RDV') < 0 || !e.traite_par) continue;
        const k = normE(e.enseigne_ia || e.enseigne || e.nom);
        if (k && k.length >= 3 && !srcParEnt[k]) srcParEnt[k] = e.traite_par;
      }
    } catch (_) {}
    const sourceurDe = societe => {
      const k = normE(societe); if (!k || k.length < 3) return null;
      if (srcParEnt[k]) return srcParEnt[k];
      for (const s in srcParEnt) { if (s.includes(k) || k.includes(s)) return srcParEnt[s]; }
      return null;
    };

    // ── 3. Fenêtres J-1 / H-2 + envoi (anti-doublon en base) ──
    for (const m of meetings) {
      const debut = new Date((m.properties || {}).hs_meeting_start_time || 0).getTime();
      if (!debut) continue;
      const dans = debut - mtn;
      let type = null;
      if (dans >= 23 * 3600 * 1000 && dans <= 25 * 3600 * 1000) type = 'j1';
      else if (dans >= 1.5 * 3600 * 1000 && dans <= 2.5 * 3600 * 1000) type = 'h2';
      // Mode validation (?dry=1&tout=1) : fenêtres ignorées, on simule le rappel adapté à l'échéance
      if (!type && dry && req.query.tout === '1') type = dans > 4 * 3600 * 1000 ? 'j1' : 'h2';
      if (!type) { resume.ignores.push({ meeting: m.id, dans_h: Math.round(dans / 360000) / 10, raison: 'hors fenêtre (normal — le cron horaire la prendra à J-1 et H-2)' }); continue; }

      const cid = contactDe.get(String(m.id));
      const c = cid ? parContact.get(cid) : null;
      const tel = c ? e164(c.mobilephone || c.phone) : null;
      const nomC = c ? [c.firstname, c.lastname].filter(Boolean).join(' ') : '';
      if (!tel) { resume.ignores.push({ meeting: m.id, type, raison: 'pas de téléphone' }); continue; }

      const quand = new Date(debut).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
      const heure = new Date(debut).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
      const prenom = (c && c.firstname) ? c.firstname : '';
      // AE qui tient la démo (propriétaire de la réunion) + SDR qui a pris le RDV (fiches Sofy) :
      // le RCS n'est PAS conversationnel → jamais « répondez », toujours un numéro à appeler.
      const ae = ownersMap.get(String((m.properties || {}).hubspot_owner_id || '')) || null;
      const sdrS = sourceurDe(c && c.company);
      const telSdr = sdrS ? (telParSdr[sdrS] || null) : null;
      const aide = telSdr ? `Un imprévu ? 📞 ${sdrS} au ${telSdr}.` : `Un imprévu ? Appelez votre interlocuteur Sofy habituel.`;
      // J-1 : LE bouton (un seul autorisé) = confirmation en un clic (engagement actif, meilleur
      // anti no-show) — la page de confirmation propose ensuite l'ajout à l'agenda Google.
      // H-2 : bouton agenda direct (confirmer à 2 h du RDV n'a plus de sens).
      const bouton = type === 'j1'
        ? { label: '✅ Je confirme mon RDV', url: 'https://www.sofyscrap.com/api/rdv-confirme?m=' + encodeURIComponent(m.id) + '&t=' + jetonRdv(m.id) }
        : { label: '🗓 Ajouter à mon agenda', url: lienAgenda(debut, ae) };
      const titre = type === 'j1' ? '📅 Votre rendez-vous Sofy, c\'est demain !' : '⏰ On se retrouve dans 2 h !';
      const texte = type === 'j1'
        ? `${prenom ? prenom + ', r' : 'R'}endez-vous ${quand}${ae ? ' avec ' + ae : ''}. Nous avons hâte de vous retrouver ! 😊 ✅ Un clic pour confirmer, et c'est noté. ${aide}`
        : `${prenom ? prenom + ', v' : 'V'}otre rendez-vous Sofy${ae ? ' avec ' + ae : ''} commence à ${heure}. Tout est prêt de notre côté 😊 ${aide}`;

      if (dry) { resume.envoyes.push({ meeting: m.id, type, tel, contact: nomC, ae, sdr: sdrS, bouton, simulation: true, texte: titre + ' — ' + texte }); continue; }

      // Anti-doublon : INSERT unique — si la ligne existe déjà, un autre passage a déjà envoyé
      const ins = await sql`INSERT INTO rcs_rdv_envoyes (meeting_id, type, tel, contact, email, date_rdv)
        VALUES (${m.id}, ${type}, ${tel}, ${nomC}, ${(c && c.email) ? String(c.email).toLowerCase() : null}, ${new Date(debut).toISOString()})
        ON CONFLICT (meeting_id, type) DO NOTHING RETURNING id`;
      if (!ins.length) { resume.ignores.push({ meeting: m.id, type, raison: 'déjà envoyé' }); continue; }

      const replicourt = (type === 'j1'
        ? `Rappel Sofy : votre rendez-vous demain à ${heure}.`
        : `Rappel Sofy : votre rendez-vous à ${heure} (dans 2 h).`) + (telSdr ? ` Empêchement ? ${telSdr}` : '');
      const env = await envoyerSofy(tel, titre, texte, bouton, replicourt);
      if (env.ok) {
        resume.envoyes.push({ meeting: m.id, type, tel, contact: nomC, canal: env.canal,
          titre_reunion: (m.properties || {}).hs_meeting_title || '',
          lien: (portalId && cid) ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${cid}` : null });
        // 📝 Trace dans le bloc-notes de la fiche (timeline par email du contact)
        try {
          const emailC = (c && c.email) ? String(c.email).toLowerCase() : null;
          if (emailC) await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
            VALUES (${emailC}, 'sms', 'rcs_rdv', ${'🛡️ Rappel démo ' + (type === 'j1' ? 'J-1' : 'H-2') + ' envoyé (' + env.canal + ')'},
              ${titre + ' — ' + texte + ' → ' + tel}, 'système', NOW())`;
        } catch (_) {}
      }
      else {
        // Échec d'envoi → on libère l'anti-doublon pour retenter au prochain passage
        await sql`DELETE FROM rcs_rdv_envoyes WHERE meeting_id = ${m.id} AND type = ${type}`;
        resume.ignores.push({ meeting: m.id, type, raison: 'envoi refusé', detail: env.erreur });
      }
    }

    // ── 4. Récap Slack (si envois réels) ──
    if (!dry && resume.envoyes.length) {
      try {
        const hook = process.env.SLACK_WEBHOOK_URL;
        if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `🛡️ *Anti no-show* — ${resume.envoyes.length} rappel(s) de rendez-vous envoyé(s) :\n` +
            resume.envoyes.map(e => `• ${e.lien ? '<' + e.lien + '|' + (e.contact || e.tel) + '>' : (e.contact || e.tel)} — ${e.type === 'j1' ? 'J-1' : 'H-2'} (${e.canal})${e.titre_reunion ? ' · « ' + e.titre_reunion.slice(0, 60) + ' »' : ''}`).join('\n') }) });
      } catch (_) {}
    }
    return res.status(200).json(resume);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
