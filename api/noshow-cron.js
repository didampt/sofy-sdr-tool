// /api/noshow-cron.js — 👻 → 🔁 : quand un deal HubSpot passe en « No show », recrée un RAPPEL
// chez le SDR qui avait pris le RDV (cas « Johan » géré à la main par Alicia le 22/07).
// Cron 07:00 UTC lun-ven : deals entrés en No show dans les 25 dernières heures → rapprochement
// de la fiche Sofy Scrap par NOM (le deal s'appelle « Société - Produit ») → tache (rappel 14 h,
// anti-doublon : pas de 2e rappel no-show en attente sur la même fiche) + DM Slack au SDR.
// GET ?dry=1 (superadmin) : montre les rapprochements sans rien créer.

import { sql, ensureSchema } from './db.js';

export const config = { maxDuration: 60 };

const HS = 'https://api.hubapi.com';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
  } catch (_) {}
}

export default async function handler(req, res) {
  const estCron = req.headers['x-vercel-cron'];
  const dry = (req.query || {}).dry === '1';
  if (!estCron) {
    try {
      const { verifierToken } = await import('./db.js');
      const user = verifierToken(req);
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    } catch (_) { return res.status(401).json({ erreur: 'Non autorisé' }); }
  }
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ erreur: 'HUBSPOT_API_KEY manquante' });
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    await ensureSchema();
    // ── 1. Deals passés en No show dans les 25 dernières heures (fenêtre = 1 run/jour) ──
    const t1 = Date.now(), t0 = t1 - 25 * 3600 * 1000;
    const rp = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers: H });
    const dp = await rp.json().catch(() => ({}));
    const nouveaux = [];
    for (const p of (dp.results || [])) {
      if (!/^sales/i.test(p.label || '')) continue;
      const st = (p.stages || []).find(s => /no[ -]?show/i.test(s.label));
      if (!st) continue;
      const prop = `hs_v2_date_entered_${st.id}`;
      const r = await fetch(`${HS}/crm/v3/objects/deals/search`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: prop, operator: 'BETWEEN', value: String(t0), highValue: String(t1) }] }],
          properties: ['dealname', prop], limit: 50
        })
      });
      const d = await r.json().catch(() => ({}));
      for (const x of (d.results || [])) nouveaux.push({ nom: x.properties.dealname || '', date: x.properties[prop], pipeline: p.label });
    }
    if (!nouveaux.length) return res.status(200).json({ ok: true, nouveaux: 0, info: 'Aucun no-show dans les 25 dernières heures' });

    // ── 2. Rapprochement fiche par NOM (« Société - Produit » → société) sur les fiches RDV pris ──
    const ls = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' IS DISTINCT FROM 'hotleads'`;
    const index = []; // {cle: nom normalisé, fiche, liste_id}
    for (const l of ls) for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
      if (!((e.tags_sdr || []).some(t => t.indexOf('RDV') >= 0))) continue;
      for (const n of [e.nom, e.enseigne, e.enseigne_ia]) { const k = norm(n); if (k && k.length >= 4) index.push({ k, e, liste_id: l.id }); }
    }
    const slackIds = {};
    try { for (const u of await sql`SELECT nom, slack_id FROM sdrs WHERE actif = TRUE`) slackIds[u.nom] = u.slack_id || null; } catch (_) {}

    let crees = 0, introuvables = 0; const apercu = [];
    for (const nv of nouveaux) {
      const societe = norm(String(nv.nom).split(' - ')[0]);
      const m = societe.length >= 4 ? index.find(x => x.k === societe || x.k.includes(societe) || societe.includes(x.k)) : null;
      if (!m) { introuvables++; apercu.push({ deal: nv.nom, fiche: null }); continue; }
      const e = m.e;
      const sdr = e.traite_par || null;
      const cle = ((e.contacts || []).find(c => c && c.enrich && c.enrich.email) || {}).enrich;
      const ficheCle = (cle && cle.email) ? String(cle.email).toLowerCase() : ('nom:' + String(e.nom || '').toLowerCase().replace(/\s+/g, ' ').trim());
      apercu.push({ deal: nv.nom, fiche: e.nom, sdr, liste_id: m.liste_id });
      if (dry || !sdr) { if (!sdr) introuvables++; continue; }
      // Anti-doublon : déjà un rappel no-show en attente sur cette fiche → on ne double pas
      const ex = await sql`SELECT id FROM taches WHERE fiche_cle = ${ficheCle} AND faite = FALSE AND description LIKE '%No-show%' LIMIT 1`;
      if (ex.length) continue;
      const dr = new Date(); dr.setHours(14, 0, 0, 0);
      if (dr.getTime() < Date.now()) dr.setDate(dr.getDate() + 1);
      await sql`INSERT INTO taches (sdr, liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel)
        VALUES (${sdr}, ${m.liste_id}, ${ficheCle}, ${e.enseigne_ia || e.enseigne || e.nom}, ${''},
          ${'👻 No-show HubSpot (' + String(nv.nom).slice(0, 60) + ') — rappeler pour re-booker le RDV'}, ${dr.toISOString()})`;
      crees++;
      if (slackIds[sdr]) await envoyerDM(slackIds[sdr], `👻 *No-show détecté* — « ${e.enseigne_ia || e.enseigne || e.nom} » ne s'est pas présenté à la démo (deal HubSpot : ${nv.nom}).\n🔁 Un rappel a été posé dans « Ma journée » pour re-booker. Astuce : rappelle vite, s'excuser d'un oubli est plus facile à chaud.`);
    }
    return res.status(200).json({ ok: true, simulation: dry, nouveaux: nouveaux.length, rappels_crees: crees, introuvables, apercu: apercu.slice(0, 10) });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
