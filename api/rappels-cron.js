// /api/rappels-cron.js — Envoie les rappels arrivés à échéance en DM Slack au SDR concerné.
// Déclenché par un cron Vercel. Utilise SLACK_BOT_TOKEN (xoxb-) + le slack_id de chaque SDR.
// Anti-doublon : ne ré-alerte pas une tâche déjà alertée (champ alertee).

import { sql, ensureSchema } from './db.js';

const APP_URL = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');

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

  // ── Auto-archivage des listes en NURTURING dont l'activité est épuisée ──
  // Une liste nurturing est archivée automatiquement quand : plus AUCUN rappel ni SMS en
  // attente, ET aucun événement (Lemlist, notes, appels journalisés) sur ses fiches depuis
  // 30 jours, ET au moins 7 jours passés en nurturing. Le SDR reçoit un bilan en DM Slack.
  let autoArchivees = 0;
  try {
    const nurt = await sql`
      SELECT l.id, l.nom, l.sdr, l.stats, l.total, l.entreprises, l.statut_depuis, s.slack_id
      FROM listes l LEFT JOIN sdrs s ON s.nom = l.sdr
      WHERE l.statut = 'nurturing' AND l.statut_depuis < NOW() - INTERVAL '7 days'
      LIMIT 20`;
    for (const l of nurt) {
      const [tp] = await sql`SELECT COUNT(*)::int AS n FROM taches WHERE liste_id = ${l.id} AND faite = FALSE`;
      const [sp] = await sql`SELECT COUNT(*)::int AS n FROM sms_programmes WHERE liste_id = ${l.id} AND statut = 'pending'`;
      if ((tp && tp.n) || (sp && sp.n)) continue; // encore des rappels/SMS -> on laisse vivre

      // Emails des fiches -> dernier événement journalisé (Lemlist, notes, WhatsApp, SMS…)
      const emails = new Set();
      for (const e of (l.entreprises || [])) {
        for (const c of (e.contacts || [])) if (c && c.enrich && c.enrich.email) emails.add(String(c.enrich.email).toLowerCase());
        if (e.enrich && e.enrich.email) emails.add(String(e.enrich.email).toLowerCase());
      }
      let dernier = null, reponses = 0;
      if (emails.size) {
        const arr = [...emails];
        const [d] = await sql`SELECT MAX(ts) AS dernier FROM activites WHERE lower(fiche_cle) = ANY(${arr})`;
        dernier = d && d.dernier;
        const [rp] = await sql`SELECT COUNT(*)::int AS n FROM activites WHERE lower(fiche_cle) = ANY(${arr}) AND type = ANY(${['warmed', 'emailsReplied', 'linkedinReplied', 'whatsappReplied', 'smsReplied']})`;
        reponses = (rp && rp.n) || 0;
      }
      if (dernier && new Date(dernier) > new Date(Date.now() - 30 * 24 * 3600 * 1000)) continue; // activité récente

      await sql`UPDATE listes SET archivee = TRUE, statut = 'archivee', statut_depuis = NOW(), veille = FALSE WHERE id = ${l.id}`;
      autoArchivees++;
      const st = l.stats || {};
      const bilan = `🗄️ *Liste archivée automatiquement* — « ${l.nom} » (activité épuisée : séquences terminées, plus de rappel ni de SMS, aucun signal depuis 30 j)\n📊 Bilan : ${l.total || 0} fiche(s) · ${reponses} réponse(s) · ${st.rdv || 0} RDV\n♻️ Récupérable à tout moment dans Archives : ${APP_URL}`;
      if (l.slack_id) await envoyerDM(l.slack_id, bilan);
    }
  } catch (_) {}

  return res.status(200).json({ ok: true, dues: dues.length, envoyes, sansSlack, erreurs, listes_auto_archivees: autoArchivees });
}
