// /api/hubspot-meeting.js — RDV (meeting) HubSpot d'une fiche. Teste TOUS les emails de la fiche.
// GET ?emails=a@x.fr,b@y.fr[&debug=1]  (ou ?email=a@x.fr) -> { ok:true, meeting:{iso,titre} } | { ok:false, raison, diag? }
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
  const debug = req.query.debug === '1';
  const emails = String(req.query.emails || req.query.email || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!token) return res.status(200).json({ ok: false, raison: 'HubSpot non configuré' });
  if (!emails.length) return res.status(400).json({ erreur: 'email requis' });

  const diag = { emails, parContact: [] };
  const out = (o) => res.status(200).json(debug ? { ...o, diag } : o);

  try {
    let allIds = [];
    let auMoinsUnContact = false;
    for (const email of emails) {
      const cs = await hs('https://api.hubapi.com/crm/v3/objects/contacts/search', token, {
        method: 'POST',
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email'], limit: 1 })
      });
      if (!cs.ok) { diag.parContact.push({ email, etape: 'search', status: cs.status }); continue; }
      if (!cs.body || !cs.body.total) { diag.parContact.push({ email, trouve: false }); continue; }
      auMoinsUnContact = true;
      const cid = cs.body.results[0].id;
      const as = await hs(`https://api.hubapi.com/crm/v4/objects/contacts/${cid}/associations/meetings?limit=100`, token);
      if (!as.ok) {
        diag.parContact.push({ email, cid, assocStatus: as.status });
        if (as.status === 403) return out({ ok: false, raison: 'Lecture des RDV refusée (HTTP 403) — il manque le scope « crm.objects.meetings.read » sur la clé HubSpot' });
        continue;
      }
      const ids = ((as.body && as.body.results) || []).map(x => x.toObjectId || x.id).filter(Boolean);
      diag.parContact.push({ email, cid, nbAssoc: ids.length });
      allIds = allIds.concat(ids);
    }
    allIds = [...new Set(allIds)];
    diag.totalAssoc = allIds.length;

    if (!auMoinsUnContact) return out({ ok: false, raison: 'Aucun des emails de la fiche n’existe comme contact dans HubSpot' });
    if (!allIds.length) return out({ ok: false, raison: 'Contacts trouvés, mais aucun RDV (meeting) associé côté HubSpot' });

    const mr = await hs('https://api.hubapi.com/crm/v3/objects/meetings/batch/read', token, {
      method: 'POST',
      body: JSON.stringify({ properties: ['hs_meeting_start_time', 'hs_meeting_title', 'hs_timestamp'], inputs: allIds.slice(0, 100).map(id => ({ id })) })
    });
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
