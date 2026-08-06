// /api/zoho.js — Connecteur Zoho Billing : CA encaissé réel (factures), rapproché ensuite des ventes HubSpot.
// ── Setup OAuth Self Client (superadmin, une seule fois) ──
//   GET /api/zoho?setup=1&code=<grant_code>
//   Prérequis env Vercel : ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_DC (eu | com, défaut eu).
//   Échange le code contre un refresh_token (permanent) + détecte l'organisation → config 'zoho'.
// ── Données (admin/superadmin) ──
//   GET /api/zoho?ca=1&du=YYYY-MM-DD&au=YYYY-MM-DD
//   → { ok, total_encaisse, nb_factures, factures:[{numero, client, email, montant, encaisse, date, statut}] }
//   total_encaisse = Σ (total - solde restant) des factures émises sur la période (donc l'encaissé réel).
// ── Sonde (superadmin) : GET /api/zoho?debug=1 → 1re page brute des factures ──

import { verifierToken, sql, ensureSchema } from './db.js';

const DC = () => ((process.env.ZOHO_DC || 'eu').toLowerCase() === 'com' ? 'com' : 'eu');
const ACCOUNTS = () => `https://accounts.zoho.${DC()}`;
const API_BASE = () => `https://www.zohoapis.${DC()}/billing/v1`;

async function lireCfg() {
  const rows = await sql`SELECT valeur FROM config WHERE cle = 'zoho'`;
  return rows.length ? (rows[0].valeur || {}) : {};
}
async function ecrireCfg(v) {
  await sql`INSERT INTO config (cle, valeur) VALUES ('zoho', ${JSON.stringify(v)})
            ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify(v)}`;
}

// Jeton d'accès (1 h) depuis le refresh_token permanent, mis en cache dans config 'zoho'.
async function accessToken() {
  const cfg = await lireCfg();
  if (!cfg.refresh_token) throw new Error('Zoho non configuré — lance ?setup=1&code=… (superadmin)');
  if (cfg.access_token && cfg.access_expire && cfg.access_expire > Date.now() + 60000) return { token: cfg.access_token, cfg };
  const p = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: cfg.refresh_token,
    client_id: process.env.ZOHO_CLIENT_ID || '', client_secret: process.env.ZOHO_CLIENT_SECRET || ''
  });
  const r = await fetch(`${ACCOUNTS()}/oauth/v2/token?${p}`, { method: 'POST' });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Refresh Zoho refusé : ' + JSON.stringify(d).slice(0, 200));
  const maj = { ...cfg, access_token: d.access_token, access_expire: Date.now() + (Number(d.expires_in || 3600) - 120) * 1000 };
  await ecrireCfg(maj);
  return { token: d.access_token, cfg: maj };
}

async function zGet(chemin, token, orgId) {
  const r = await fetch(`${API_BASE()}${chemin}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'X-com-zoho-subscriptions-organizationid': orgId || '' }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || (d.code !== undefined && d.code !== 0)) throw new Error(`Zoho ${chemin} : ` + JSON.stringify(d).slice(0, 250));
  return d;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  const q = req.query || {};

  try {
    // ── 1. Setup OAuth (une fois) ──
    if (q.setup) {
      if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET)
        return res.status(400).json({ erreur: 'Ajoute ZOHO_CLIENT_ID et ZOHO_CLIENT_SECRET dans Vercel (+ ZOHO_DC) puis Redeploy' });
      const code = String(q.code || '').trim();
      if (!code) return res.status(400).json({ erreur: 'Paramètre code manquant (Self Client → Generate Code)' });
      const p = new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET
      });
      const r = await fetch(`${ACCOUNTS()}/oauth/v2/token?${p}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!d.refresh_token) return res.status(400).json({ erreur: 'Échange refusé (code expiré ? mauvais datacenter ?)', detail: d });
      // Détection de l'organisation Zoho Billing
      let orgId = null, orgNom = null;
      try {
        const o = await fetch(`${API_BASE()}/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${d.access_token}` } });
        const od = await o.json().catch(() => ({}));
        const orgs = od.organizations || [];
        if (orgs.length) { orgId = orgs[0].organization_id; orgNom = orgs[0].name; }
      } catch (_) {}
      const cfgPrev = await lireCfg(); // re-setup (ajout de scopes) : on garde l'organisation déjà choisie
      await ecrireCfg({ refresh_token: d.refresh_token, access_token: d.access_token,
        access_expire: Date.now() + 3000 * 1000,
        organization_id: cfgPrev.organization_id || orgId, organisation: cfgPrev.organisation || orgNom,
        dc: DC(), configure_le: new Date().toISOString() });
      return res.status(200).json({ ok: true, organisation: orgNom, organization_id: orgId,
        info: orgId ? 'Zoho Billing connecté ✓ — teste ?ca=1' : 'Token OK mais organisation introuvable — vérifie le datacenter ZOHO_DC' });
    }

    if (!['admin', 'superadmin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé admin' });
    const { token, cfg } = await accessToken();
    const orgId = cfg.organization_id;

    // ── Choix de l'organisation (comptes Zoho multi-orgs : le setup prend la 1re par défaut) ──
    if (q.orgs) {
      const d = await zGet('/organizations', token, null);
      return res.status(200).json({ ok: true, active: cfg.organization_id,
        organisations: (d.organizations || []).map(o => ({ organization_id: o.organization_id, nom: o.name })) });
    }
    if (q.org) {
      if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const d = await zGet('/organizations', token, null);
      const o = (d.organizations || []).find(x => String(x.organization_id) === String(q.org));
      if (!o) return res.status(400).json({ erreur: 'organization_id inconnu — liste-les avec ?orgs=1' });
      await ecrireCfg({ ...cfg, organization_id: o.organization_id, organisation: o.name });
      return res.status(200).json({ ok: true, organisation: o.name, organization_id: o.organization_id, info: 'Organisation active mise à jour ✓ — teste ?ca=1' });
    }

    // ── Sonde brute ──
    if (q.debug) {
      if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
      const d = await zGet('/invoices?per_page=5&sort_column=date&sort_order=D', token, orgId);
      return res.status(200).json({ ok: true, organisation: cfg.organisation, exemple: d });
    }

    // ── 2. CA encaissé sur une période ──
    const jour = new Date().toISOString().slice(0, 10);
    const du = String(q.du || jour.slice(0, 7) + '-01');
    const au = String(q.au || jour);
    const factures = [];
    // Pagination robuste : tri invoice_date desc (repli 'date' si refusé), on ne s'arrête qu'après
    // une page ENTIÈREMENT passée sous la fenêtre (le tri intra-page n'est pas garanti — cas 104/207
    // factures du 06/08). Brouillons et annulées exclues. Garde-fou 25 pages × 200.
    let sortCol = 'invoice_date';
    for (let page = 1; page <= 25; page++) {
      let d;
      try { d = await zGet(`/invoices?per_page=200&page=${page}&sort_column=${sortCol}&sort_order=D`, token, orgId); }
      catch (e) { if (sortCol === 'invoice_date') { sortCol = 'date'; page--; continue; } throw e; }
      const lot = d.invoices || [];
      let minDt = '9999';
      for (const f of lot) {
        const dt = String(f.invoice_date || f.date || ''); // ⚠️ Zoho Billing : le champ est invoice_date
        if (dt && dt < minDt) minDt = dt;
        if (!dt || dt > au || dt < du) continue;
        if (['draft', 'void'].includes(String(f.status || ''))) continue; // tests / annulées
        factures.push({
          numero: f.number || f.invoice_number || '', client: f.customer_name || '',
          email: (f.email || '').toLowerCase(), date: dt, statut: f.status || '',
          montant: Number(f.total || 0), encaisse: Math.max(0, Number(f.total || 0) - Number(f.balance || 0)),
          devise: f.currency_code || 'EUR'
        });
      }
      if (!(d.page_context && d.page_context.has_more_page)) break;
      if (minDt < du) break; // page déjà entièrement plus ancienne → les suivantes aussi
    }
    // 📝 Devis ACCEPTÉS (ventes signées pas encore facturées, ex. abonnement Somarec) —
    // silencieux si le token n'a pas le scope estimates (re-générer un code pour l'activer).
    let devis = [];
    try {
      for (let page = 1; page <= 5; page++) {
        const d = await zGet(`/estimates?per_page=200&page=${page}`, token, orgId);
        const lot = d.estimates || [];
        for (const e of lot) {
          if (!/accept/i.test(String(e.status || ''))) continue;
          const dt = String(e.estimate_date || e.date || '');
          if (dt && (dt < du || dt > au)) continue;
          devis.push({ numero: e.estimate_number || e.number || '', client: e.customer_name || '',
            email: (e.email || '').toLowerCase(), date: dt, montant: Number(e.total || 0), statut: e.status || '' });
        }
        if (!(d.page_context && d.page_context.has_more_page)) break;
      }
    } catch (_) {}
    const encaisse = factures.reduce((s, f) => s + f.encaisse, 0);
    const facture = factures.reduce((s, f) => s + f.montant, 0);
    return res.status(200).json({
      ok: true, organisation: cfg.organisation || null, du, au,
      total_facture: Math.round(facture * 100) / 100,   // émis sur la période (payé ou non)
      total_encaisse: Math.round(encaisse * 100) / 100, // réellement payé (total − solde)
      nb_factures: factures.length,
      // ⚠️ plafond large : à 200, les factures de début de fenêtre sortaient de la liste dès que la
      // fenêtre dépassait le mois (rapprochement ventes perdait Somarec & co, 06/08)
      factures: factures.slice(0, 1000),
      devis_acceptes: devis.slice(0, 300)
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Zoho', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
