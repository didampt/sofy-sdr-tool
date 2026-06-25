// /api/hubspot-meeting.js — récupère le dernier RDV (meeting) HubSpot d'un contact, par email.
// GET ?email=a@x.fr → { ok, meeting:{ iso, titre } | null }
import { verifierToken } from './db.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  const token = process.env.HUBSPOT_API_KEY;
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!token) return res.status(200).json({ ok: false, erreur: 'HubSpot non configuré' });
  if (!email) return res.status(400).json({ erreur: 'email requis' });

  const H = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  try {
    // 1. Trouver le contact par email
    const cr = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST', headers: H,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email'], limit: 1 })
    });
    const cd = await cr.json().catch(() => ({}));
    if (!cr.ok || !cd.total) return res.status(200).json({ ok: true, meeting: null });
    const cid = cd.results[0].id;

    // 2. Meetings associés au contact
    const ar = await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${cid}/associations/meetings?limit=50`, { headers: H });
    const ad = await ar.json().catch(() => ({}));
    const ids = (ad.results || []).map(x => x.toObjectId || x.id).filter(Boolean);
    if (!ids.length) return res.status(200).json({ ok: true, meeting: null });

    // 3. Charger les meetings, garder le plus récent (start le plus tardif)
    let best = null;
    for (const id of ids.slice(0, 15)) {
      const mr = await fetch(`https://api.hubapi.com/crm/v3/objects/meetings/${id}?properties=hs_meeting_start_time,hs_meeting_title,hs_timestamp`, { headers: H });
      if (!mr.ok) continue;
      const md = await mr.json().catch(() => ({}));
      const p = (md && md.properties) || {};
      const raw = p.hs_meeting_start_time || p.hs_timestamp;
      if (!raw) continue;
      const ms = /^\d+$/.test(String(raw)) ? Number(raw) : Date.parse(raw);
      if (!ms) continue;
      if (!best || ms > best.ms) best = { ms, titre: p.hs_meeting_title || 'RDV' };
    }
    if (!best) return res.status(200).json({ ok: true, meeting: null });
    return res.status(200).json({ ok: true, meeting: { iso: new Date(best.ms).toISOString(), titre: best.titre } });
  } catch (e) {
    return res.status(200).json({ ok: false, erreur: String(e.message || e).slice(0, 150) });
  }
}
