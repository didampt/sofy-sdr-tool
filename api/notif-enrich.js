// /api/notif-enrich.js — Alerte Slack : un SDR a lancé l'enrichissement d'une liste partagée (Hot Leads)
// Évite que 2 SDR lancent en parallèle. POST { liste_nom, nb }
import { verifierToken } from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const { liste_nom, nb } = req.body || {};
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return res.status(200).json({ ok: true, slack: false });

  try {
    const txt = `⏳ *${user.nom}* a lancé l'enrichissement de « ${liste_nom || 'Hot Leads (auto)'} »${nb ? ` (${nb} fiche${nb > 1 ? 's' : ''})` : ''}.\n_Évitez de lancer un enrichissement en parallèle sur cette liste._`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: txt })
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, detail: e.message });
  }
}
