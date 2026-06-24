// /api/activite.js — Timeline unifiée d'une fiche (côté base) : événements Lemlist + SMS SoReach.
// Les appels Ringover sont ajoutés côté front via /api/ringover-calls (numéros de la fiche).
// GET ?emails=a@x.fr,b@y.fr  → { activites: [ {source,type,titre,detail,auteur,ts} ] } trié desc.

import { verifierToken, sql, ensureSchema } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (sql) await ensureSchema();

  const emails = String(req.query.emails || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return res.status(200).json({ activites: [] });

  try {
    const out = [];

    // 1) Événements Lemlist (table activites, alimentée par le webhook)
    const evs = await sql`
      SELECT source, type, titre, detail, auteur, ts
      FROM activites
      WHERE lower(fiche_cle) = ANY(${emails})
      ORDER BY ts DESC LIMIT 200`;
    for (const e of evs) {
      out.push({
        source: e.source || 'lemlist',
        type: e.type || null,
        titre: e.titre || e.type || 'Activité',
        detail: e.detail || null,
        auteur: e.auteur || null,
        ts: e.ts
      });
    }

    // 2) SMS SoReach (programmés / envoyés / annulés)
    const sms = await sql`
      SELECT message, telephone, envoyer_le, statut, sdr, created_at
      FROM sms_programmes
      WHERE lower(email) = ANY(${emails})
      ORDER BY created_at DESC LIMIT 100`;
    const LIB = { pending: 'SMS SoReach programmé', sent: 'SMS SoReach envoyé', cancelled: 'SMS SoReach annulé' };
    for (const s of sms) {
      let detail = null;
      if (s.statut === 'pending') {
        detail = s.envoyer_le ? ('Envoi prévu le ' + new Date(s.envoyer_le).toLocaleDateString('fr-FR')) : null;
      } else if (s.message) {
        detail = s.message.slice(0, 90);
      }
      out.push({
        source: 'sms',
        type: 'sms_' + (s.statut || ''),
        titre: LIB[s.statut] || 'SMS SoReach',
        detail,
        auteur: s.sdr || 'système',
        ts: s.created_at
      });
    }

    out.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    return res.status(200).json({ activites: out });
  } catch (e) {
    return res.status(500).json({ erreur: 'Activité indisponible', detail: String(e.message || e).slice(0, 200) });
  }
}
