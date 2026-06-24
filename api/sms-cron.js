// /api/sms-cron.js — Envoie les SMS SoReach programmes (J+7 au handoff) arrives a echeance.
// Cron Vercel (toutes les heures). Respecte la limite mensuelle de chaque SDR.
import { sql, ensureSchema, envoyerSmsSofy, limiteAtteinte } from './db.js';

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });
  await ensureSchema();
  try {
    const rows = await sql`SELECT * FROM sms_programmes WHERE statut = 'pending' AND envoyer_le <= NOW() ORDER BY envoyer_le ASC LIMIT 50`;
    let envoyes = 0, ignores = 0, erreurs = 0;
    for (const row of rows) {
      let user = { nom: row.sdr };
      const sdrRow = await sql`SELECT id, nom FROM sdrs WHERE nom = ${row.sdr} LIMIT 1`;
      if (sdrRow.length) user = { id: sdrRow[0].id, nom: sdrRow[0].nom };
      const lim = await limiteAtteinte(user);
      if (lim) { ignores++; continue; }
      const r = await envoyerSmsSofy({ to: row.telephone, message: row.message, user, liste_id: row.liste_id });
      if (r.ok) { await sql`UPDATE sms_programmes SET statut = 'sent' WHERE id = ${row.id}`; envoyes++; }
      else { await sql`UPDATE sms_programmes SET statut = ${'error: ' + String(r.detail || r.status).slice(0, 120)} WHERE id = ${row.id}`; erreurs++; }
    }
    return res.status(200).json({ ok: true, dus: rows.length, envoyes, ignores, erreurs });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur cron SMS', detail: String(e.message || e).slice(0, 200) });
  }
}
