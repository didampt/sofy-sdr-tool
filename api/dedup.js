// /api/dedup.js — Déduplication des fiches avant enrichissement (économie de crédits).
// Vérifie si les contacts sont DÉJÀ connus, dans HubSpot et/ou dans les listes Sofy existantes.
//
// POST { contacts: [{ email, telephone, nom, prenom, siren?, linkedin? }], liste_id_courante? }
//   liste_id_courante = (optionnel) liste à exclure de la comparaison interne (la liste en cours)
//
// Renvoie : { resultats: { "<cle>": { hubspot:{stage,owner}|null, liste:{nom,id}|null } } }
//   La clé identifie chaque contact (email normalisé, sinon tel normalisé, sinon nom).
//   Le LinkedIn sert au matching interne : indispensable pour les fiches Basile qui n'ont
//   ni email, ni téléphone, ni SIREN avant enrichissement.

import { verifierToken, sql } from './db.js';

// ── Normalisation d'un numéro de téléphone français en formats comparables ──
// Renvoie { national: "0612345678", e164: "+33612345678" } ou null si pas exploitable.
export function normaliserTel(brut) {
  if (!brut) return null;
  let s = String(brut).replace(/[^\d+]/g, ''); // garde chiffres et +
  if (!s) return null;
  // Variantes d'entrée : 0612..., +33612..., 0033612..., 612... (sans 0)
  if (s.startsWith('0033')) s = '+33' + s.slice(4);
  else if (s.startsWith('33') && s.length === 11) s = '+33' + s.slice(2);
  // National 0XXXXXXXXX (10 chiffres commençant par 0)
  let national = null, e164 = null;
  if (/^0\d{9}$/.test(s)) {
    national = s;
    e164 = '+33' + s.slice(1);
  } else if (/^\+33\d{9}$/.test(s)) {
    e164 = s;
    national = '0' + s.slice(3);
  } else if (/^\d{9}$/.test(s)) {
    // 9 chiffres sans préfixe (ex 612345678) → on suppose mobile/fixe FR
    national = '0' + s;
    e164 = '+33' + s;
  } else {
    // Format inconnu (étranger, court) → on garde tel quel pour comparaison brute
    return { national: s, e164: s };
  }
  return { national, e164 };
}

// Email normalisé (minuscules, sans espaces)
function normEmail(e) {
  if (!e || !String(e).includes('@')) return null;
  return String(e).trim().toLowerCase();
}

// Identifiant LinkedIn normalisé ("https://www.linkedin.com/in/Jean-Dupont-123/" → "jean-dupont-123")
function normLinkedin(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
}

// Clé d'identification d'un contact (pour le mapping de retour)
function cleContact(c) {
  return normEmail(c.email) || (normaliserTel(c.telephone)?.e164) || ((c.prenom || '') + ' ' + (c.nom || '')).trim().toLowerCase() || Math.random().toString(36).slice(2);
}

// ── Recherche HubSpot par téléphone (best-effort : teste national ET e164) ──
async function hubspotParTel(tel, token) {
  const norm = normaliserTel(tel);
  if (!norm) return null;
  const formats = [...new Set([norm.national, norm.e164])];
  for (const val of formats) {
    try {
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: val }] }], properties: ['lifecyclestage', 'hubspot_owner_id'], limit: 1 })
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.total) {
        const p = data.results[0].properties || {};
        return { stage: p.lifecyclestage || 'inconnu', owner: p.hubspot_owner_id || null, via: 'tel' };
      }
    } catch (_) {}
  }
  return null;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const { contacts, liste_id_courante } = req.body || {};
  if (!Array.isArray(contacts) || !contacts.length) return res.status(200).json({ resultats: {} });

  const token = process.env.HUBSPOT_API_KEY;
  const resultats = {};

  // Prépare les clés normalisées pour chaque contact entrant
  const items = contacts.slice(0, 200).map(c => ({
    cle: cleContact(c),
    email: normEmail(c.email),
    tel: normaliserTel(c.telephone),
    siren: c.siren ? String(c.siren).replace(/\D/g, '') : '',
    linkedin: normLinkedin(c.linkedin)
  }));
  for (const it of items) resultats[it.cle] = { hubspot: null, liste: null };

  // ── 1) Dédup LISTES INTERNES (email OU tel normalisé) ──
  try {
    // On charge les listes actives (hors liste courante) avec leurs entreprises
    const rows = liste_id_courante
      ? await sql`SELECT id, nom, entreprises FROM listes WHERE archivee = FALSE AND id <> ${liste_id_courante}`
      : await sql`SELECT id, nom, entreprises FROM listes WHERE archivee = FALSE`;
    // Construit un index { email/tel → {nom,id} } à partir des contacts existants
    const indexEmail = new Map(), indexTel = new Map(), indexSiren = new Map(), indexLinkedin = new Map();
    for (const l of rows) {
      const ents = Array.isArray(l.entreprises) ? l.entreprises : [];
      for (const e of ents) {
        let sEmail = null, sTel = null;
        for (const ct of (e.contacts || [])) {
          const em = normEmail(ct.enrich?.email);
          const tl = normaliserTel(ct.enrich?.telephone);
          const li = normLinkedin(ct.enrich?.linkedin);
          if (em && !indexEmail.has(em)) indexEmail.set(em, { nom: l.nom, id: l.id });
          if (tl && !indexTel.has(tl.e164)) indexTel.set(tl.e164, { nom: l.nom, id: l.id });
          if (li && !indexLinkedin.has(li)) indexLinkedin.set(li, { nom: l.nom, id: l.id });
          if (em && !sEmail) sEmail = em;
          if (tl && !sTel) sTel = tl.national;
        }
        const sir = e.siren ? String(e.siren).replace(/\D/g, '') : '';
        if (sir && !indexSiren.has(sir)) indexSiren.set(sir, { nom: l.nom, id: l.id, enrichi: !!(sEmail || sTel), email: sEmail, telephone: sTel });
      }
    }
    for (const it of items) {
      let trouve = (it.email && indexEmail.get(it.email)) || (it.tel && indexTel.get(it.tel.e164)) || (it.linkedin && indexLinkedin.get(it.linkedin)) || null;
      if (trouve) resultats[it.cle].liste = trouve;
      if (it.siren && indexSiren.has(it.siren)) {
        const m = indexSiren.get(it.siren);
        if (!resultats[it.cle].liste) resultats[it.cle].liste = { nom: m.nom, id: m.id };
        resultats[it.cle].siren_connu = { enrichi: m.enrichi, email: m.email || null, telephone: m.telephone || null };
      }
    }
  } catch (e) { /* en cas d'erreur, on continue sans la dédup interne */ }

  // ── 2) Dédup HUBSPOT (email EQ + tel best-effort), par lots de 5 ──
  if (token) {
    const { existeDansHubspot } = await import('./db.js');
    for (let i = 0; i < items.length; i += 5) {
      const lot = items.slice(i, i + 5);
      await Promise.all(lot.map(async it => {
        // Email d'abord (le plus fiable)
        if (it.email) {
          const h = await existeDansHubspot(it.email);
          if (h) { resultats[it.cle].hubspot = h; return; }
        }
        // Sinon (ou en complément) le téléphone
        if (it.tel) {
          const h = await hubspotParTel(it.tel.e164, token);
          if (h) resultats[it.cle].hubspot = h;
        }
      }));
    }
  }

  return res.status(200).json({ resultats, hubspot_actif: !!token });
}
