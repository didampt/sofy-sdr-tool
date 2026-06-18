// /api/demande-credits.js — Un SDR demande une allocation de crédits (estimation insuffisante).
// POST { liste_nom, cout_max, manque, nb_fiches }
// → envoie un DM Slack à TOUS les superadmins (toi + Romain) avec un lien vers la page d'allocation.

import { verifierToken, sql } from './db.js';

const APP_URL = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return { ok: false, raison: 'token ou slack_id manquant' };
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
    const d = await r.json();
    return { ok: !!d.ok, raison: d.error };
  } catch (e) {
    return { ok: false, raison: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  try {
    const { liste_nom = 'une liste', cout_max = 0, manque = 0, nb_fiches = 0 } = req.body || {};

    // Récupère tous les superadmins avec un slack_id
    const admins = await sql`SELECT nom, slack_id FROM sdrs WHERE role = 'superadmin' AND actif = TRUE AND slack_id IS NOT NULL AND slack_id <> ''`;

    const lienAllocation = `${APP_URL}/?allouer=${encodeURIComponent(user.nom)}`;
    const message = `💳 *Demande de crédits*\n*${user.nom}* souhaite générer la liste « ${liste_nom} » (${nb_fiches} fiches).\nCoût estimé jusqu'à *${Number(cout_max).toFixed(2)} €* — il manque environ *${Number(manque).toFixed(2)} €* sur son plafond.\n\n👉 <${lienAllocation}|Allouer des crédits à ${user.nom} dans Sofy Scrap>`;

    let envoyes = 0;
    const raisons = [];
    for (const a of admins) {
      const r = await envoyerDM(a.slack_id, message);
      if (r.ok) envoyes++;
      else raisons.push(`${a.nom}: ${r.raison}`);
    }

    // Repli : si aucun superadmin n'a de slack_id, on tente le canal général
    if (envoyes === 0 && process.env.SLACK_WEBHOOK_URL) {
      try {
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message })
        });
        envoyes = 1;
      } catch (_) {}
    }

    return res.status(200).json({ ok: true, envoyes, raisons: raisons.slice(0, 3) });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur demande crédits', detail: String(e.message || e).slice(0, 200) });
  }
}
