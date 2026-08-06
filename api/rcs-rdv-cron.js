// /api/rcs-rdv-cron.js — 🛡️ Anti no-show : rappel RCS (repli SMS) des démos HubSpot à venir.
// Deux rappels par démo : J-1 (la veille, fenêtre 23-25 h avant) et H-2 (fenêtre 1 h 30-2 h 30 avant).
// Source : réunions HubSpot (hs_meeting_start_time) → contact associé → mobile.
// Envoi : API Sofy (api.sofy.fr/v2) — rich-card RCS si SOFY_RCS_SENDER_ID est défini, sinon SMS.
// Anti-doublon : table paresseuse rcs_rdv_envoyes (UNIQUE meeting_id + type). ?dry=1 = simulation.
// Env requis : SOFY_API_KEY (sofy_live_…) ; optionnels : SOFY_RCS_SENDER_ID, SOFY_SMS_FROM (déf. Sofy).
// Cron horaire jours ouvrés (vercel.json) — en-tête x-vercel-cron, Bearer CRON_SECRET ou superadmin.

import { verifierToken, sql, ensureSchema } from './db.js';

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

async function envoyerSofy(tel, titre, texte) {
  const cle = process.env.SOFY_API_KEY;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cle}` };
  const senderId = process.env.SOFY_RCS_SENDER_ID;
  // 1) RCS rich-card si un expéditeur RCS est configuré (repli SMS géré par Sofy via fallback)
  if (senderId) {
    try {
      const corps = { to: tel, senderId, title: titre, description: texte, fallback: { enabled: true, text: titre + ' — ' + texte } };
      // 🖼️ Visuel « Votre RDV Sofy » (URL publique, ex. hébergée sur www.sofy.fr) — optionnel
      if (process.env.SOFY_RCS_IMAGE_URL) corps.imageUrl = process.env.SOFY_RCS_IMAGE_URL;
      const r = await fetch('https://api.sofy.fr/v2/rcs/rich-card', {
        method: 'POST', headers,
        body: JSON.stringify(corps)
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.id) return { ok: true, canal: d.isSmsFallback ? 'sms (repli)' : 'rcs', id: d.id };
    } catch (_) {}
  }
  // 2) SMS direct
  const r2 = await fetch('https://api.sofy.fr/v2/sms', {
    method: 'POST', headers,
    body: JSON.stringify({ to: tel, from: process.env.SOFY_SMS_FROM || 'Sofy', body: titre + ' — ' + texte, isTransactional: true })
  });
  const d2 = await r2.json().catch(() => ({}));
  if (r2.ok && d2.id) return { ok: true, canal: 'sms', id: d2.id };
  return { ok: false, erreur: JSON.stringify(d2).slice(0, 200) };
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
    if (!process.env.SOFY_API_KEY) return res.status(200).json({ ok: true, info: 'SOFY_API_KEY absente — rappels RCS inactifs' });
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'rcs_rdv'`;
    const cfg = cfgRows.length ? (cfgRows[0].valeur || {}) : {};
    if (cfg.actif === false) return res.status(200).json({ ok: true, info: 'Désactivé (config rcs_rdv.actif=false)' });

    const cleHS = process.env.HUBSPOT_API_KEY;
    if (!cleHS) return res.status(200).json({ ok: true, info: 'HUBSPOT_API_KEY absente' });
    const H = { Authorization: `Bearer ${cleHS}`, 'Content-Type': 'application/json' };

    // ── 1. Réunions HubSpot des prochaines 26 h ──
    const mtn = Date.now();
    const rM = await fetch(`${HS}/crm/v3/objects/meetings/search`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'hs_meeting_start_time', operator: 'BETWEEN', value: String(mtn), highValue: String(mtn + 26 * 3600 * 1000) }] }],
        properties: ['hs_meeting_start_time', 'hs_meeting_title', 'hs_meeting_outcome'], limit: 100
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

    // ── 3. Fenêtres J-1 / H-2 + envoi (anti-doublon en base) ──
    for (const m of meetings) {
      const debut = new Date((m.properties || {}).hs_meeting_start_time || 0).getTime();
      if (!debut) continue;
      const dans = debut - mtn;
      let type = null;
      if (dans >= 23 * 3600 * 1000 && dans <= 25 * 3600 * 1000) type = 'j1';
      else if (dans >= 1.5 * 3600 * 1000 && dans <= 2.5 * 3600 * 1000) type = 'h2';
      if (!type) continue;

      const cid = contactDe.get(String(m.id));
      const c = cid ? parContact.get(cid) : null;
      const tel = c ? e164(c.mobilephone || c.phone) : null;
      const nomC = c ? [c.firstname, c.lastname].filter(Boolean).join(' ') : '';
      if (!tel) { resume.ignores.push({ meeting: m.id, type, raison: 'pas de téléphone' }); continue; }

      const quand = new Date(debut).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
      const heure = new Date(debut).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
      const prenom = (c && c.firstname) ? c.firstname : '';
      const titre = type === 'j1' ? '📅 Votre démo Sofy, c\'est demain !' : '⏰ Votre démo Sofy commence bientôt';
      const texte = type === 'j1'
        ? `${prenom ? prenom + ', r' : 'R'}endez-vous ${quand} pour votre démonstration Sofy. Un empêchement ? Répondez à ce message ou appelez-nous, on trouvera un autre créneau.`
        : `${prenom ? prenom + ', v' : 'V'}otre démonstration Sofy commence à ${heure} (dans 2 h). À tout à l'heure !`;

      if (dry) { resume.envoyes.push({ meeting: m.id, type, tel, contact: nomC, simulation: true, texte: titre + ' — ' + texte }); continue; }

      // Anti-doublon : INSERT unique — si la ligne existe déjà, un autre passage a déjà envoyé
      const ins = await sql`INSERT INTO rcs_rdv_envoyes (meeting_id, type, tel, contact)
        VALUES (${m.id}, ${type}, ${tel}, ${nomC}) ON CONFLICT (meeting_id, type) DO NOTHING RETURNING id`;
      if (!ins.length) { resume.ignores.push({ meeting: m.id, type, raison: 'déjà envoyé' }); continue; }

      const env = await envoyerSofy(tel, titre, texte);
      if (env.ok) {
        resume.envoyes.push({ meeting: m.id, type, tel, contact: nomC, canal: env.canal });
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
          body: JSON.stringify({ text: `🛡️ *Anti no-show* — ${resume.envoyes.length} rappel(s) de démo envoyé(s) :\n` +
            resume.envoyes.map(e => `• ${e.contact || e.tel} — ${e.type === 'j1' ? 'J-1' : 'H-2'} (${e.canal})`).join('\n') }) });
      } catch (_) {}
    }
    return res.status(200).json(resume);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
