// /api/ringover-webhook.js — Webhook Ringover "After-Call Work" (enregistrement des appels).
//
// PHASE 1 (actuelle) : on LOGGE le vrai payload sans l'interpréter (les noms de champs exacts
// varient selon l'API Ringover, doc derrière login). Une fois un vrai appel capturé, on regarde
// la structure réelle, PUIS on code le matching numéro→fiche (phase 2).
//
// Sécurité : secret dans l'URL → https://…/api/ringover-webhook?secret=RINGOVER_WEBHOOK_SECRET
// (à configurer dans Ringover → Dashboard → Webhooks, et comme variable Vercel RINGOVER_WEBHOOK_SECRET)
//
// POST (Ringover) : enregistre le payload brut + en-têtes, garde les 50 derniers.
// GET  (superadmin OU secret) : renvoie les derniers payloads pour inspection.

import { sql, verifierToken } from './db.js';

async function assurerTable() {
  await sql`CREATE TABLE IF NOT EXISTS ringover_events (
    id SERIAL PRIMARY KEY,
    recu_le TIMESTAMPTZ DEFAULT NOW(),
    payload JSONB,
    headers JSONB
  )`;
}

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });

  const secretServeur = (process.env.RINGOVER_WEBHOOK_SECRET || '').trim();
  const secretRecu = (req.query.secret || '').trim();

  // ── GET : inspection des payloads (superadmin via token, ou secret dans l'URL) ──
  if (req.method === 'GET') {
    const user = verifierToken(req);
    const okSecret = secretServeur && secretRecu === secretServeur;
    if (!(user && user.role === 'superadmin') && !okSecret) {
      return res.status(401).json({ erreur: 'Réservé superadmin (ou secret requis)' });
    }
    try {
      await assurerTable();
      const rows = await sql`SELECT id, recu_le, payload, headers FROM ringover_events ORDER BY id DESC LIMIT 20`;
      return res.status(200).json({
        nb: rows.length,
        note: rows.length ? 'Voici les derniers payloads reçus de Ringover. Repère les champs : numéro appelé, numéro SDR, durée, lien enregistrement.' : "Aucun payload reçu pour l'instant. Passe un appel test Ringover puis recharge.",
        events: rows
      });
    } catch (e) {
      return res.status(500).json({ erreur: 'Lecture impossible', detail: String(e.message || e).slice(0, 200) });
    }
  }

  // ── POST : réception du webhook Ringover ──
  if (!secretServeur) return res.status(500).json({ erreur: 'RINGOVER_WEBHOOK_SECRET manquant côté serveur' });
  if (secretRecu !== secretServeur) {
    return res.status(401).json({ erreur: 'Secret invalide', indice: `reçu ${secretRecu.length} car., attendu ${secretServeur.length}` });
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement (webhook Ringover) — secret OK ✓' });

  try {
    await assurerTable();
    // On stocke le corps tel quel + quelques en-têtes utiles (signature éventuelle pour la phase 2)
    const payload = req.body || {};
    const headers = {
      'content-type': req.headers['content-type'] || null,
      'user-agent': req.headers['user-agent'] || null,
      'x-ringover-signature': req.headers['x-ringover-signature'] || req.headers['x-signature'] || null
    };
    await sql`INSERT INTO ringover_events (payload, headers) VALUES (${JSON.stringify(payload)}, ${JSON.stringify(headers)})`;
    // On garde seulement les 50 derniers (évite que la table gonfle)
    await sql`DELETE FROM ringover_events WHERE id NOT IN (SELECT id FROM ringover_events ORDER BY id DESC LIMIT 50)`;
    // Réponse rapide (Ringover attend un 200)
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ erreur: 'Enregistrement impossible', detail: String(e.message || e).slice(0, 200) });
  }
}
