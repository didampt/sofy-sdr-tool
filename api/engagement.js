// /api/engagement.js — Derniere reaction Lemlist par lead, pour une liste d'emails (badge 🔥 + tri).
// POST { emails:[...] }  ->  { engagements: { "email": { titre, type, ts } } }
import { sql, verifierToken } from './db.js';

const TYPES = ['emailsOpened','emailsClicked','emailsReplied','emailsInterested','linkedinOpened','linkedinReplied','linkedinInviteAccepted','linkedinInterested','whatsappReplied','smsReplied','interested','aircallInterested','manualInterested','warmed','hooked','attracted'];

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!sql) return res.status(200).json({ engagements: {} });
  try {
    let emails = [];
    if (req.method === 'POST') emails = (req.body && req.body.emails) || [];
    else emails = String((req.query && req.query.emails) || '').split(',');
    const list = emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    if (!list.length) return res.status(200).json({ engagements: {} });
    const rows = await sql`
      SELECT DISTINCT ON (lower(fiche_cle)) lower(fiche_cle) AS email, titre, type, ts
      FROM activites
      WHERE source = 'lemlist' AND type = ANY(${TYPES}) AND lower(fiche_cle) = ANY(${list})
      ORDER BY lower(fiche_cle), ts DESC`;
    const out = {};
    for (const r of rows) out[r.email] = { titre: r.titre, type: r.type, ts: r.ts };
    return res.status(200).json({ engagements: out });
  } catch (e) {
    return res.status(200).json({ engagements: {}, erreur: e.message });
  }
}
