// /api/sofy-reply.js — 💬 Réponses aux RCS/SMS Sofy (webhook sms.reply / rcs.reply).
// Réception : POST signé par Sofy (X-Sofy-Timestamp + X-Sofy-Signature = HMAC-SHA256 hex de
// « <timestamp>.<corps brut> », secret remis UNE fois à la création) → alerte Slack + note dans
// le bloc-notes de la fiche (email retrouvé via rcs_rdv_envoyes par le numéro).
// Gestion (superadmin) :
//   GET ?setup=1      → crée le webhook côté Sofy (url prod, events sms.reply + rcs.reply) et
//                       stocke {id, secret} dans config 'sofy_webhook'
//   GET ?liste=1      → webhooks existants de la clé
//   GET ?supprimer=ID → supprime un webhook
//   GET ?debug=1      → dernier payload brut reçu (sonde, le schéma exact n'est pas documenté)

import crypto from 'crypto';
import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { api: { bodyParser: false } }; // corps BRUT requis pour vérifier la signature

const cleV2 = () => process.env.SOFY_API_KEY_V2 || '';
const URL_WEBHOOK = 'https://www.sofyscrap.com/api/sofy-reply';

function lireBrut(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('trop gros')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function cfgWebhook() {
  const rows = await sql`SELECT valeur FROM config WHERE cle = 'sofy_webhook'`;
  return rows.length ? (rows[0].valeur || {}) : {};
}

export default async function handler(req, res) {
  await ensureSchema();

  // ── Gestion (superadmin, GET) ──
  if (req.method === 'GET') {
    const user = verifierToken(req);
    if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé superadmin' });
    const hd = { 'Content-Type': 'application/json', Authorization: `Bearer ${cleV2()}` };
    try {
      if (req.query.setup) {
        const r = await fetch('https://api.sofy.fr/v2/webhooks', {
          method: 'POST', headers: hd,
          body: JSON.stringify({ url: URL_WEBHOOK, events: ['sms.reply', 'rcs.reply'] })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.secret) return res.status(502).json({ erreur: 'Création refusée', detail: d });
        await sql`INSERT INTO config (cle, valeur) VALUES ('sofy_webhook', ${JSON.stringify({ id: d.id, secret: d.secret, cree_le: new Date().toISOString() })})
                  ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify({ id: d.id, secret: d.secret, cree_le: new Date().toISOString() })}`;
        return res.status(200).json({ ok: true, id: d.id, info: 'Webhook réponses créé ✓ — secret stocké. Réponds à un RCS de test pour valider.' });
      }
      if (req.query.liste) {
        const r = await fetch('https://api.sofy.fr/v2/webhooks', { headers: hd });
        return res.status(200).json({ ok: true, webhooks: await r.json().catch(() => []) });
      }
      if (req.query.supprimer) {
        const r = await fetch(`https://api.sofy.fr/v2/webhooks/${encodeURIComponent(req.query.supprimer)}`, { method: 'DELETE', headers: hd });
        return res.status(200).json({ ok: r.status === 204, status: r.status });
      }
      if (req.query.debug) {
        const rows = await sql`SELECT valeur FROM config WHERE cle = 'sofy_reply_derniere'`;
        return res.status(200).json({ ok: true, derniere_reception: rows.length ? rows[0].valeur : null });
      }
      return res.status(400).json({ erreur: 'Action : ?setup=1, ?liste=1, ?supprimer=<id>, ?debug=1' });
    } catch (e) {
      return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 250) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST (webhook) ou GET (gestion)' });

  // ── Réception d'une réponse (signée par Sofy) ──
  try {
    const brut = await lireBrut(req);
    const cfg = await cfgWebhook();
    if (!cfg.secret) return res.status(503).json({ erreur: 'Webhook non configuré (?setup=1)' });
    const ts = String(req.headers['x-sofy-timestamp'] || '');
    const sig = String(req.headers['x-sofy-signature'] || '');
    const attendu = crypto.createHmac('sha256', cfg.secret).update(`${ts}.${brut}`).digest('hex');
    const okSig = sig.length === attendu.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu));
    if (!okSig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ erreur: 'Signature invalide' });

    let b = {}; try { b = JSON.parse(brut); } catch (_) {}
    // Sonde : le schéma du payload n'est pas documenté → on garde le dernier reçu pour ?debug=1
    try { await sql`INSERT INTO config (cle, valeur) VALUES ('sofy_reply_derniere', ${JSON.stringify({ ts: new Date().toISOString(), payload: b })})
                    ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify({ ts: new Date().toISOString(), payload: b })}`; } catch (_) {}

    // Extraction défensive : événement + numéro + texte, quel que soit l'emballage
    const ev = String(b.event || b.type || '');
    const m = b.data || b.message || b.payload || b;
    const de = String(m.from || m.msisdn || m.sender || m.to_reply || '').trim();
    const texte = String(m.body || m.text || m.message || m.reply || '').trim();
    if (!de && !texte) return res.status(200).json({ ok: true, info: 'payload sans numéro ni texte (sonde enregistrée)' });

    // Qui est-ce ? — retrouvé via les rappels envoyés (tel → contact + email de la fiche)
    let contact = null, email = null;
    try {
      const rows = await sql`SELECT contact, email FROM rcs_rdv_envoyes WHERE tel = ${de} ORDER BY ts DESC LIMIT 1`;
      if (rows.length) { contact = rows[0].contact || null; email = rows[0].email || null; }
    } catch (_) {}

    // Note dans le bloc-notes de la fiche (si on connaît son email)
    if (email && texte) {
      try { await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
        VALUES (${email}, 'sms', 'reponse_rcs', '💬 Réponse du prospect (RCS/SMS)', ${texte + ' — ' + de}, 'système', NOW())`; } catch (_) {}
    }

    // Alerte Slack immédiate (le SDR rappelle à chaud)
    try {
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `💬 *Réponse à un ${/rcs/i.test(ev) ? 'RCS' : 'SMS'} Sofy* — ${contact || de}\n« ${texte.slice(0, 300)} »\n${email ? '📂 Fiche : recherche « ' + email + ' » dans l\'Historique' : '📱 ' + de}\n👉 À rappeler à chaud !` }) });
    } catch (_) {}

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 250) });
  }
}
