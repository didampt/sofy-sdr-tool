// /api/rappels-cron.js — Envoie les rappels arrivés à échéance en DM Slack au SDR concerné.
// Déclenché par un cron Vercel. Utilise SLACK_BOT_TOKEN (xoxb-) + le slack_id de chaque SDR.
// Anti-doublon : ne ré-alerte pas une tâche déjà alertée (champ alertee).

import { sql, ensureSchema } from './db.js';

const APP_URL = 'https://sofy-sdr-tool.vercel.app';

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return { ok: false, raison: 'token ou slack_id manquant' };
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
    const d = await r.json();
    return { ok: !!d.ok, raison: d.error || null };
  } catch (e) {
    return { ok: false, raison: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  // Sécurité : cron Vercel (header) ou superadmin
  const estCron = req.headers['x-vercel-cron'] || (req.query && req.query.cron_secret === process.env.PHANTOMBUSTER_CRON_SECRET);
  if (!estCron) {
    try {
      const { verifierToken } = await import('./db.js');
      const user = verifierToken(req);
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    } catch (_) { return res.status(401).json({ erreur: 'Non autorisé' }); }
  }

  await ensureSchema();

  // Tâches dues (échéance passée), non faites, pas encore alertées
  const dues = await sql`
    SELECT t.*, s.slack_id
    FROM taches t
    LEFT JOIN sdrs s ON s.nom = t.sdr
    WHERE t.faite = FALSE AND t.alertee = FALSE AND t.date_rappel IS NOT NULL AND t.date_rappel <= NOW()
    ORDER BY t.date_rappel ASC
    LIMIT 50`;

  let envoyes = 0, sansSlack = 0, erreurs = 0;
  for (const t of dues) {
    const lien = `${APP_URL}/?liste=${t.liste_id || ''}`;
    const ligne = `🔁 *Rappel à passer* — ${t.entreprise_nom || 'fiche'}${t.contact_nom ? ' (' + t.contact_nom + ')' : ''}\n${t.description ? '📝 ' + t.description + '\n' : ''}👉 Ouvre Sofy Scrap : ${lien}`;

    if (!t.slack_id) {
      sansSlack++;
    } else {
      const r = await envoyerDM(t.slack_id, ligne);
      if (r.ok) envoyes++; else erreurs++;
    }
    // On marque alertée même sans slack_id, pour ne pas réessayer indéfiniment
    await sql`UPDATE taches SET alertee = TRUE WHERE id = ${t.id}`;
  }

  return res.status(200).json({ ok: true, dues: dues.length, envoyes, sansSlack, erreurs });
}
