// /api/noshow.js — 👻 Taux de no-show depuis le PIPELINE HubSpot (stages « Démo planifiée » /
// « No show » / « Démo réalisée », horodatés par hs_v2_date_entered_<stageId>).
// ÉTAPE 0 (?debug=1, superadmin) : liste les pipelines/stages + 2 deals du stage No show avec
// leur date d'entrée — valide les IDs et la dispo des propriétés avant de brancher la tuile.

import { verifierToken } from './db.js';

const HS = 'https://api.hubapi.com';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if ((req.query || {}).debug && user.role !== 'superadmin') return res.status(403).json({ erreur: 'Debug réservé au superadmin' });
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ erreur: 'HUBSPOT_API_KEY manquante' });
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Mode DONNÉES (admins) : ?du=YYYY-MM-DD&au=YYYY-MM-DD → taux de no-show périodisé ──
  // Dénominateur = deals ENTRÉS en « Démo planifiée » sur la période ; numérateur = deals
  // ENTRÉS en « No show » (pipelines Sales - New + Sales - Parc, stages résolus par libellé).
  if (!(req.query || {}).debug) {
    if (!['admin', 'superadmin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé aux admins' });
    try {
      let du = String((req.query || {}).du || '').slice(0, 10);
      let au = String((req.query || {}).au || '').slice(0, 10);
      const auj = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(du)) du = auj.slice(0, 7) + '-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(au)) au = auj;
      const t0 = String(new Date(du + 'T00:00:00+02:00').getTime());
      const t1 = String(new Date(au + 'T23:59:59+02:00').getTime());
      const rp0 = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers: H });
      const dp0 = await rp0.json().catch(() => ({}));
      const compte = async (prop, avecDetails) => {
        const r = await fetch(`${HS}/crm/v3/objects/deals/search`, {
          method: 'POST', headers: H,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: prop, operator: 'BETWEEN', value: t0, highValue: t1 }] }],
            properties: ['dealname', prop], limit: avecDetails ? 100 : 1
          })
        });
        const d = await r.json().catch(() => ({}));
        return { total: d.total || 0, deals: avecDetails ? (d.results || []).map(x => ({ nom: x.properties.dealname, date: x.properties[prop] })) : [] };
      };
      let planifies = 0, noshows = 0; const details = [];
      for (const p of (dp0.results || [])) {
        if (!/^sales/i.test(p.label || '')) continue;
        const stP = (p.stages || []).find(s => /d[ée]mo planifi/i.test(s.label));
        const stN = (p.stages || []).find(s => /no[ -]?show/i.test(s.label));
        if (stP) planifies += (await compte(`hs_v2_date_entered_${stP.id}`, false)).total;
        if (stN) {
          const rN = await compte(`hs_v2_date_entered_${stN.id}`, true);
          noshows += rN.total;
          for (const x of rN.deals) details.push({ ...x, pipeline: p.label });
        }
      }
      details.sort((a, b) => new Date(b.date) - new Date(a.date));
      return res.status(200).json({
        ok: true, periode: { du, au }, planifies, noshows,
        taux_pct: planifies ? Math.round(100 * noshows / planifies) : null,
        details: details.slice(0, 50)
      });
    } catch (e) { return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) }); }
  }

  try {
    const rp = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers: H });
    const dp = await rp.json().catch(() => ({}));
    if (!rp.ok) return res.status(502).json({ erreur: 'HubSpot pipelines', detail: JSON.stringify(dp).slice(0, 300) });
    const pipelines = (dp.results || []).map(p => ({
      id: p.id, label: p.label,
      stages: (p.stages || []).map(s => ({ id: s.id, label: s.label }))
    }));
    // Repère le stage No show et sonde 2 deals avec leur date d'entrée dans le stage
    let sonde = null;
    for (const p of pipelines) {
      const st = p.stages.find(s => /no[ -]?show/i.test(s.label));
      if (!st) continue;
      const prop = `hs_v2_date_entered_${st.id}`;
      const rs = await fetch(`${HS}/crm/v3/objects/deals/search`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: st.id }] }],
          properties: ['dealname', 'dealstage', 'hubspot_owner_id', prop, 'hs_v2_date_entered_' + st.id],
          limit: 2, sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
        })
      });
      const ds = await rs.json().catch(() => ({}));
      sonde = {
        pipeline: p.label, stage_noshow: st, propriete_testee: prop,
        total_no_show: ds.total || 0,
        exemples: (ds.results || []).map(x => ({ nom: x.properties.dealname, date_entree_noshow: x.properties[prop] || null }))
      };
      break;
    }
    return res.status(200).json({ ok: true, pipelines, sonde });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
