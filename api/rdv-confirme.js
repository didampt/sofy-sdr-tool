// /api/rdv-confirme.js — ✅ Confirmation de RDV en un clic depuis la rich-card RCS.
// GET ?m=<meeting_id>&t=<jeton HMAC> : page « c'est confirmé » + bouton Agenda Google,
// alerte Slack, note 💬 sur la fiche, statut mémorisé dans rcs_rdv_envoyes.
// Le jeton signe le meeting_id (personne ne peut confirmer pour un autre RDV).

import crypto from 'crypto';
import { sql, ensureSchema } from './db.js';

export function jetonRdv(meetingId) {
  const secret = process.env.JWT_SECRET || process.env.CRON_SECRET || 'sofy-rdv';
  return crypto.createHmac('sha256', secret).update(String(meetingId)).digest('hex').slice(0, 20);
}

function page(titre, corps, agendaUrl) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title>
<style>body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F6F7FB;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:16px;padding:34px 28px;text-align:center;box-shadow:0 4px 24px rgba(20,30,70,.08);max-width:360px}
a.b{display:inline-block;background:#2B4BF2;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 24px;border-radius:12px;margin-top:16px}
p{color:#5A6172;font-size:14.5px;line-height:1.55}</style></head>
<body><div class="c"><div style="font-size:40px">✅</div><h2 style="margin:10px 0 4px">${titre}</h2><p>${corps}</p>
${agendaUrl ? `<a class="b" href="${agendaUrl}" target="_blank">🗓 Ajouter à mon agenda Google</a>` : ''}
</div></body></html>`;
}

export default async function handler(req, res) {
  const m = String(req.query.m || '').trim();
  const t = String(req.query.t || '').trim();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!m || t !== jetonRdv(m)) {
    return res.status(400).send(page('Lien invalide', 'Ce lien de confirmation n\'est plus valide. Contactez votre interlocuteur Sofy.', null));
  }
  try {
    await ensureSchema();
    const rows = await sql`SELECT contact, email, tel, date_rdv, reponse FROM rcs_rdv_envoyes WHERE meeting_id = ${m} ORDER BY ts DESC LIMIT 1`;
    const r = rows.length ? rows[0] : {};
    // Lien Agenda Google (Android → Google Calendar, format UTC basic)
    let agendaUrl = null;
    if (r.date_rdv) {
      const deb = new Date(r.date_rdv), fin = new Date(deb.getTime() + 45 * 60000);
      const f = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      agendaUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('Démo Sofy')
        + '&dates=' + f(deb) + '/' + f(fin) + '&details=' + encodeURIComponent('Votre démonstration Sofy — sofy.fr');
    }
    const deja = r.reponse === 'confirmé';
    if (!deja) {
      await sql`UPDATE rcs_rdv_envoyes SET reponse = 'confirmé' WHERE meeting_id = ${m}`;
      if (r.email) {
        try { await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
          VALUES (${r.email}, 'sms', 'rdv_confirme', '✅ RDV confirmé par le prospect (bouton RCS)', ${'Confirmation en un clic' + (r.tel ? ' — ' + r.tel : '')}, 'système', NOW())`; } catch (_) {}
      }
      try {
        const hook = process.env.SLACK_WEBHOOK_URL;
        if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `✅ *RDV confirmé* par ${r.contact || r.tel || 'un prospect'} (bouton RCS)${r.date_rdv ? ' — démo du ' + new Date(r.date_rdv).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''} 🎉` }) });
      } catch (_) {}
    }
    return res.status(200).send(page(
      deja ? 'Déjà confirmé, merci !' : 'Votre rendez-vous est confirmé !',
      'Merci' + (r.contact ? ' ' + String(r.contact).split(' ')[0] : '') + ' — toute l\'équipe Sofy vous attend. À très vite ! 😊',
      agendaUrl
    ));
  } catch (e) {
    return res.status(500).send(page('Oups', 'Une erreur est survenue — votre RDV reste bien planifié. Contactez votre interlocuteur Sofy si besoin.', null));
  }
}
