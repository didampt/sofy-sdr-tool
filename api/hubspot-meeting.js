// /api/hubspot-meeting.js — RDV (meeting) HubSpot d'un contact, par email. Avec diagnostics.
// GET ?email=a@x.fr[&debug=1] -> { ok:true, meeting:{iso,titre} } | { ok:false, raison, diag? }
import { verifierToken } from './db.js';

export const config = { maxDuration: 30 };

const toMs = v => { if (!v) return 0; if (/^\d+$/.test(String(v))) return Number(v); const t = Date.parse(v); return isFinite(t) ? t : 0; };

async function hs(url, token, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const token = process.env.HUBSPOT_API_KEY;
  const email = String(req.query.email || '').trim().toLowerCase();
  const debug = req.query.debug === '1';
  if (!token) return res.status(200).json({ ok: false, raison: 'HubSpot non configuré' });
  if (!email) return res.status(400).json({ erreur: 'email requis' });

  const diag = { email };
  const out = (o) => res.status(200).json(debug ? { ...o, diag } : o);

  try {
    // 1) contact par email
    const cs = await hs('https://api.hubapi.com/crm/v3/objects/contacts/search', token, {
      method: 'POST',
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email'], limit: 1 })
    });
    diag.contactSearchStatus = cs.status;
    if (!cs.ok) return out({ ok: false, raison: 'Recherche contact refusée (HTTP ' + cs.status + ') — scope contacts ?' });
    if (!cs.body || !cs.body.total) return out({ ok: false, raison: 'Contact introuvable dans HubSpot pour ' + email + ' — le RDV a peut-être été pris avec un autre email' });
    const cid = cs.body.results[0].id;
    diag.contactId = cid;

    // 2) meetings associés au contact (v4)
    const as = await hs(`https://api.hubapi.com/crm/v4/objects/contacts/${cid}/associations/meetings?limit=100`, token);
    diag.assocStatus = as.status;
    if (!as.ok) return out({ ok: false, raison: 'Lecture des RDV refusée (HTTP ' + as.status + ') — il manque sans doute le scope « crm.objects.meetings.read » sur la clé HubSpot' });
    const ids = ((as.body && as.body.results) || []).map(x => x.toObjectId || x.id).filter(Boolean);
    diag.nbAssoc = ids.length;
    if (!ids.length) return out({ ok: false, raison: 'Contact trouvé mais aucun RDV (meeting) associé côté HubSpot' });

    // 3) détail des meetings
    const mr = await hs('https://api.hubapi.com/crm/v3/objects/meetings/batch/read', token, {
      method: 'POST',
      body: JSON.stringify({ properties: ['hs_meeting_start_time', 'hs_meeting_title', 'hs_timestamp'], inputs: ids.slice(0, 100).map(id => ({ id })) })
    });
    diag.meetingReadStatus = mr.status;
    if (!mr.ok) return out({ ok: false, raison: 'Lecture du détail des RDV refusée (HTTP ' + mr.status + ')' });
    const list = ((mr.body && mr.body.results) || []).map(m => {
      const p = m.properties || {};
      return { start: toMs(p.hs_meeting_start_time) || toMs(p.hs_timestamp), titre: p.hs_meeting_title || 'RDV' };
    }).filter(m => m.start);
    diag.nbMeetingsDates = list.length;
    if (!list.length) return out({ ok: false, raison: 'RDV trouvé(s) mais sans date exploitable' });

    const now = Date.now();
    const futurs = list.filter(m => m.start >= now).sort((a, b) => a.start - b.start);
    const choisi = futurs[0] || list.sort((a, b) => b.start - a.start)[0];
    return out({ ok: true, meeting: { iso: new Date(choisi.start).toISOString(), titre: choisi.titre } });
  } catch (e) {
    diag.exception = String(e.message || e).slice(0, 150);
    return out({ ok: false, raison: 'Erreur HubSpot : ' + String(e.message || e).slice(0, 150) });
  }
}
