// /api/rapport.js — Rapport de fin d'enrichissement : Slack + email au SDR (Resend)
// POST {liste_id, nom, total, emails, tels, gmb} · Variables : RESEND_API_KEY (optionnelle), RAPPORT_FROM
import { verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });
  const { nom = 'Liste', total = 0, emails = 0, tels = 0, gmb = 0 } = req.body || {};
  const synthese = `📋 ${nom} — enrichissement terminé\n${total} fiches · ✉️ ${emails} email(s) (${total ? Math.round(emails / total * 100) : 0}%) · 📱 ${tels} numéro(s) · ⭐ ${gmb} fiche(s) GMB`;
  try {
    if (process.env.SLACK_WEBHOOK_URL) {
      await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🏁 *Enrichissement terminé* — ${user.nom}\n${synthese}` }) });
    }
  } catch (_) {}
  let emailEnvoye = false;
  try {
    if (process.env.RESEND_API_KEY && user.email) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: process.env.RAPPORT_FROM || 'Sofy Scrap <notifications@sofy.fr>',
          to: [user.email],
          subject: `🏁 ${nom} : terminé (${emails} emails, ${tels} mobiles)`,
          text: `Bonjour ${user.nom},\n\n${synthese}\n\nOuvre ta liste : ${(process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '')}\n\n— Sofy Scrap`
        })
      });
      emailEnvoye = r.ok;
    }
  } catch (_) {}
  return res.status(200).json({ ok: true, emailEnvoye });
}
