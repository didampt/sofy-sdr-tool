// /api/ringover-incoming.js — Appels entrants Ringover → bandeau "fiche" pour le SDR.
//
// Ringover (Dashboard → Developer → Webhooks → champ "Incoming calls") POST l'événement "incoming_call" :
//   { event:"incoming_call", call_id, caller_number, receiver_number, timestamp }
// On identifie le SDR via sa ligne (receiver_number ↔ sdrs.ringover_numero), on résout la fiche
//   par le numéro de l'appelant (Sofy Scrap d'abord, sinon HubSpot), et on stocke un "appel en cours".
// L'onglet du SDR interroge ce point en GET (token) toutes les ~3 s → bandeau persistant.
//
// Sécurité webhook : en-tête Authorization = RINGOVER_WEBHOOK_SECRET (champ "Authorization Header" de Ringover)
//   OU ?secret=RINGOVER_WEBHOOK_SECRET dans l'URL.
// Variables Vercel : RINGOVER_WEBHOOK_SECRET, HUBSPOT_API_KEY (déjà présente).

import { sql, ensureSchema, verifierToken } from './db.js';

export const config = { maxDuration: 30 };

const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);

async function assurerTable() {
  await sql`CREATE TABLE IF NOT EXISTS appels_entrants (
    id BIGSERIAL PRIMARY KEY,
    ligne TEXT,
    sdr TEXT,
    caller_number TEXT,
    entreprise TEXT,
    source TEXT,
    liste_id BIGINT,
    lien_hubspot TEXT,
    call_id TEXT,
    recu_le TIMESTAMPTZ DEFAULT NOW(),
    traite BOOLEAN DEFAULT FALSE
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_appels_entrants_ligne ON appels_entrants (ligne, recu_le DESC)`;
}

// — Résolution de la fiche Sofy par le numéro (même logique que fiche-par-numero.js) —
async function chercherSofy(numero) {
  const d9 = cle9(numero);
  if (d9.length < 6) return null;
  const rows = await sql`
    SELECT id, nom, entreprises FROM listes
    WHERE archivee = FALSE AND entreprises::text LIKE ${'%' + d9 + '%'}
    ORDER BY created_at DESC LIMIT 25`;
  for (const l of rows) {
    for (const e of (l.entreprises || [])) {
      const tels = [];
      if (e.gmb && e.gmb.telephone) tels.push(e.gmb.telephone);
      if (e.ia && e.ia.telephone) tels.push(e.ia.telephone);
      if (e.telephone_google) tels.push(e.telephone_google);
      if (e.enrich && e.enrich.telephone) tels.push(e.enrich.telephone);
      if (Array.isArray(e.contacts)) for (const c of e.contacts) { if (c && c.enrich && c.enrich.telephone) tels.push(c.enrich.telephone); }
      if (e.dirigeant && e.dirigeant.enrich && e.dirigeant.enrich.telephone) tels.push(e.dirigeant.enrich.telephone);
      if (tels.some(t => cle9(t) === d9)) {
        return { liste_id: l.id, entreprise: e.enseigne_ia || e.enseigne || (e.gmb && e.gmb.nom) || e.nom || '(sans nom)' };
      }
    }
  }
  return null;
}

// — Portal HubSpot (pour le lien vers la fiche), mis en cache dans config —
async function portalHubspot(token) {
  try {
    const c = await sql`SELECT valeur FROM config WHERE cle = 'hubspot_portal'`;
    if (c.length && c[0].valeur && c[0].valeur.id) return c[0].valeur.id;
  } catch (_) {}
  try {
    const r = await fetch('https://api.hubapi.com/account-info/v3/details', { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (d && d.portalId) {
      try { await sql`INSERT INTO config (cle, valeur) VALUES ('hubspot_portal', ${JSON.stringify({ id: d.portalId })}::jsonb) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`; } catch (_) {}
      return d.portalId;
    }
  } catch (_) {}
  return null;
}

// — Résolution HubSpot par téléphone (best-effort, plusieurs formats) —
async function chercherHubspot(numero) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return null;
  const d9 = cle9(numero);
  const brut = String(numero || '').trim();
  const national = d9 ? '0' + d9 : '';
  const valeurs = [...new Set([brut, national, d9].filter(Boolean))];
  const groupes = [];
  for (const v of valeurs) {
    groupes.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: v }] });
    groupes.push({ filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: v }] });
  }
  try {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filterGroups: groupes.slice(0, 5), properties: ['firstname', 'lastname', 'company'], limit: 1 })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.total) return null;
    const c = d.results[0];
    const p = c.properties || {};
    const contact = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || p.company || 'Contact HubSpot';
    const portal = await portalHubspot(token);
    const lien = portal ? `https://app.hubspot.com/contacts/${portal}/contact/${c.id}` : null;
    return { entreprise: p.company || contact, lien };
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });

  // ───────── GET : interrogation par l'onglet du SDR (token) ─────────
  if (req.method === 'GET') {
    const user = verifierToken(req);
    if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
    await ensureSchema();
    await assurerTable();

    let maLigne = '';
    try {
      const rs = await sql`SELECT ringover_numero FROM sdrs WHERE lower(trim(nom)) = lower(trim(${user.nom})) LIMIT 1`;
      maLigne = rs.length ? cle9(rs[0].ringover_numero) : '';
    } catch (_) {}

    // Fermeture du bandeau : ?vu=<id>
    const vu = req.query && req.query.vu;
    if (vu) {
      try { await sql`UPDATE appels_entrants SET traite = TRUE WHERE id = ${parseInt(vu)} AND ligne = ${maLigne}`; } catch (_) {}
      return res.status(200).json({ ok: true });
    }

    if (!maLigne) return res.status(200).json({ call: null, sans_ligne: true });
    const rows = await sql`
      SELECT id, caller_number, entreprise, source, liste_id, lien_hubspot, call_id, recu_le
      FROM appels_entrants
      WHERE ligne = ${maLigne} AND traite = FALSE AND recu_le > NOW() - INTERVAL '45 seconds'
      ORDER BY recu_le DESC LIMIT 1`;
    return res.status(200).json({ call: rows.length ? rows[0] : null });
  }

  // ───────── POST : webhook Ringover (appel entrant) ─────────
  const secretServeur = (process.env.RINGOVER_WEBHOOK_SECRET || '').trim();
  if (!secretServeur) return res.status(401).json({ erreur: 'RINGOVER_WEBHOOK_SECRET absente côté serveur — créer la variable Vercel (Production) puis Redeploy' });
  const auth = (req.headers['authorization'] || '').toString().replace(/^Bearer\s+/i, '').trim();
  const secretRecu = auth || (req.query.secret || '').trim();
  if (secretRecu !== secretServeur) return res.status(401).json({ erreur: 'Secret Ringover invalide' });

  await ensureSchema();
  await assurerTable();

  try {
    const corps = req.body || {};
    // Journalise le dernier payload (pour vérifier/ajuster les vrais champs Ringover)
    try { await sql`INSERT INTO config (cle, valeur) VALUES ('ringover_incoming_last', ${JSON.stringify({ recu_le: new Date().toISOString(), payload: corps })}::jsonb) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`; } catch (_) {}

    const event = corps.event || corps.event_type || '';
    const caller = corps.caller_number || corps.from_number || corps.from || '';
    const receiver = corps.receiver_number || corps.to_number || corps.to || corps.did || '';
    const callId = corps.call_id || corps.callId || corps.id || null;

    // On ne traite que les sonneries entrantes (tolérant aux variantes de nom d'événement)
    if (event && !/incoming|ring|call_started|started/i.test(String(event))) {
      return res.status(200).json({ ok: true, ignore: event });
    }
    if (!caller) return res.status(200).json({ ok: true, sans_numero: true });

    const ligne = cle9(receiver);
    // SDR propriétaire de cette ligne (match sur les 9 derniers chiffres)
    let sdr = null;
    if (ligne) {
      try {
        const all = await sql`SELECT nom, ringover_numero FROM sdrs WHERE ringover_numero IS NOT NULL AND ringover_numero <> ''`;
        const hit = all.find(s => cle9(s.ringover_numero) === ligne);
        if (hit) sdr = hit.nom;
      } catch (_) {}
    }

    // Résolution fiche : Sofy d'abord, sinon HubSpot
    let entreprise = null, source = null, liste_id = null, lien_hubspot = null;
    const sofy = await chercherSofy(caller);
    if (sofy) { entreprise = sofy.entreprise; source = 'sofy'; liste_id = sofy.liste_id; }
    else {
      const hs = await chercherHubspot(caller);
      if (hs) { entreprise = hs.entreprise; source = 'hubspot'; lien_hubspot = hs.lien; }
    }

    await sql`INSERT INTO appels_entrants (ligne, sdr, caller_number, entreprise, source, liste_id, lien_hubspot, call_id)
      VALUES (${ligne}, ${sdr}, ${caller}, ${entreprise}, ${source}, ${liste_id}, ${lien_hubspot}, ${callId})`;

    return res.status(200).json({ ok: true, sdr, source, entreprise: entreprise || null });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur ringover-incoming', detail: String(err.message || err).slice(0, 200) });
  }
}
