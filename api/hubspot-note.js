// /api/hubspot-note.js — Écrit une note sur la timeline du contact HubSpot (1er email trouvé).
// POST { emails:[...], note } -> { ok:true, contactEmail } | { ok:false, raison }
// Utilise le scope crm.objects.contacts.write (les notes/engagements passent par ce scope).
import { verifierToken } from './db.js';

export const config = { maxDuration: 30 };

async function hs(url, token, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

function enHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\r?\n/g, '<br>');
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(200).json({ ok: false, raison: 'HubSpot non configuré' });

  const b = req.body || {};
  const emails = (Array.isArray(b.emails) ? b.emails : String(b.emails || '').split(','))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const note = String(b.note || '').slice(0, 12000);
  if (!emails.length) return res.status(200).json({ ok: false, raison: 'Aucun email de contact' });
  if (!note.trim()) return res.status(200).json({ ok: false, raison: 'Note vide' });

  try {
    let cid = null, cemail = null;
    for (const email of emails) {
      const cs = await hs('https://api.hubapi.com/crm/v3/objects/contacts/search', token, {
        method: 'POST',
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email'], limit: 1 })
      });
      if (cs.ok && cs.body && cs.body.total) { cid = cs.body.results[0].id; cemail = email; break; }
    }
    if (!cid) return res.status(200).json({ ok: false, raison: 'Aucun des emails de la fiche n’existe comme contact dans HubSpot' });

    // Note + association au contact (typeId 202 = note → contact)
    const cr = await hs('https://api.hubapi.com/crm/v3/objects/notes', token, {
      method: 'POST',
      body: JSON.stringify({
        properties: { hs_note_body: enHtml(note), hs_timestamp: Date.now() },
        associations: [{ to: { id: cid }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
      })
    });
    if (!cr.ok) {
      const msg = (cr.body && (cr.body.message || (cr.body.errors && cr.body.errors[0] && cr.body.errors[0].message))) || ('HTTP ' + cr.status);
      return res.status(200).json({ ok: false, raison: 'Création de la note refusée : ' + msg });
    }
    return res.status(200).json({ ok: true, contactEmail: cemail, noteId: (cr.body && cr.body.id) || null });
  } catch (e) {
    return res.status(200).json({ ok: false, raison: 'Erreur HubSpot : ' + String(e.message || e).slice(0, 150) });
  }
}
