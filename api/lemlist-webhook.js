// /api/lemlist-webhook.js — réception des événements Lemlist
// PHASE CAPTURE (sans clé, temporaire) : on enregistre le format brut pour écrire le parseur ensuite.
//   GET ?register=1  -> enregistre le webhook chez Lemlist (POST /api/hooks) avec un secret
//   GET ?voir=1      -> renvoie les 20 derniers événements bruts reçus (pour analyse)
//   POST (Lemlist)   -> stocke l'événement brut dans lemlist_events (répond toujours 200)
import crypto from 'crypto';
import { sql, ensureSchema } from './db.js';

export default async function handler(req, res) {
  if (sql) await ensureSchema();
  const q = req.query || {};

  // 1) Enregistrement one-shot du webhook chez Lemlist
  if (req.method === 'GET' && q.register) {
    const apiKey = process.env.LEMLIST_API_KEY;
    if (!apiKey) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante' });
    if (sql) {
      const ex = await sql`SELECT valeur FROM config WHERE cle = 'lemlist_hook'`;
      if (ex.length && ex[0].valeur && ex[0].valeur.hookId) {
        return res.status(200).json({ ok: true, deja: true, hook: ex[0].valeur });
      }
    }
    const base = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');
    const targetUrl = base + '/api/lemlist-webhook';
    const secret = crypto.randomBytes(16).toString('hex');
    try {
      const r = await fetch('https://api.lemlist.com/api/hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + Buffer.from(':' + apiKey).toString('base64') },
        body: JSON.stringify({ targetUrl, secret })
      });
      const txt = await r.text();
      let data = {}; try { data = JSON.parse(txt); } catch (_) {}
      if (r.ok && sql) {
        const val = JSON.stringify({ secret, hookId: data._id || null, targetUrl });
        await sql`INSERT INTO config (cle, valeur) VALUES ('lemlist_hook', ${val}::jsonb)
          ON CONFLICT (cle) DO UPDATE SET valeur = ${val}::jsonb`;
      }
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, targetUrl, hook: data, status: r.status, body: r.ok ? undefined : txt.slice(0, 300) });
    } catch (e) {
      return res.status(500).json({ erreur: e.message });
    }
  }

  // 2) Voir les derniers événements bruts (debug temporaire)
  if (req.method === 'GET' && q.voir) {
    if (!sql) return res.status(500).json({ erreur: 'pas de base' });
    const rows = await sql`SELECT id, recu_le, type, email, brut FROM lemlist_events ORDER BY id DESC LIMIT 20`;
    return res.status(200).json({ count: rows.length, events: rows });
  }

  // 3) Réception d'un événement Lemlist → on enregistre le format brut
  if (req.method === 'POST') {
    try {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
      b = b || {};
      const inner = b.data || b.lead || b;
      const email = b.email || (inner && inner.email) || b.leadEmail || null;
      const type = b.type || b.event || null;
      if (sql) {
        await sql`INSERT INTO lemlist_events (type, email, brut) VALUES (${type}, ${email}, ${JSON.stringify(b)}::jsonb)`;
      }
    } catch (e) { /* on repond 200 quoi qu il arrive */ }
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true, info: 'lemlist-webhook actif' });
}
