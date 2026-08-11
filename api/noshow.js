// /api/noshow.js — 👻 Taux de no-show depuis le PIPELINE HubSpot (stages « Démo planifiée » /
// « No show » / « Démo réalisée », horodatés par hs_v2_date_entered_<stageId>).
// ÉTAPE 0 (?debug=1, superadmin) : liste les pipelines/stages + 2 deals du stage No show avec
// leur date d'entrée — valide les IDs et la dispo des propriétés avant de brancher la tuile.

import { verifierToken } from './db.js';

const HS = 'https://api.hubapi.com';

// HubSpot limite le débit : noshow enchaîne ~10 appels et un 429 faisait contribuer 0 au pipeline
// concerné → réponse PARTIELLE affichée comme définitive (2 ventes au lieu de 6, CA 107 € au lieu
// de 11 420 €, constat Didier 07/08). On réessaie, et on signale l'incomplétude au front.
async function hsFetch(url, opts, etat) {
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) {
        if (essai < 2) { await new Promise(x => setTimeout(x, 1200 * (essai + 1))); continue; }
        if (etat) etat.incomplet = true;
        return r;
      }
      return r;
    } catch (e) {
      if (essai === 2) { if (etat) etat.incomplet = true; throw e; }
      await new Promise(x => setTimeout(x, 1200 * (essai + 1)));
    }
  }
}

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
      const etatHS = { incomplet: false }; // signale une réponse partielle (rate limit HubSpot)
      const rp0 = await hsFetch(`${HS}/crm/v3/pipelines/deals`, { headers: H }, etatHS);
      const dp0 = await rp0.json().catch(() => ({}));
      const compte = async (prop, avecDetails) => {
        const r = await hsFetch(`${HS}/crm/v3/objects/deals/search`, {
          method: 'POST', headers: H,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: prop, operator: 'BETWEEN', value: t0, highValue: t1 }] }],
            properties: ['dealname', prop], limit: avecDetails ? 100 : 1
          })
        }, etatHS);
        const d = await r.json().catch(() => ({}));
        return { total: d.total || 0, deals: avecDetails ? (d.results || []).map(x => ({ nom: x.properties.dealname, date: x.properties[prop] })) : [] };
      };
      let planifies = 0, noshows = 0, realises = 0, gagnes = 0; const details = []; const cycles = []; const detailsGagnes = [];
      // Portal id HubSpot (liens directs vers les deals depuis Insights)
      let portalId = null;
      try {
        const ra = await hsFetch(`${HS}/account-info/v3/details`, { headers: H }, etatHS);
        const da = await ra.json().catch(() => ({}));
        portalId = da.portalId || null;
      } catch (_) {}
      for (const p of (dp0.results || [])) {
        if (!/^sales/i.test(p.label || '')) continue;
        const stP = (p.stages || []).find(s => /d[ée]mo planifi/i.test(s.label));
        const stN = (p.stages || []).find(s => /no[ -]?show/i.test(s.label));
        const stR = (p.stages || []).find(s => /d[ée]mo r[ée]alis/i.test(s.label));
        const stW = (p.stages || []).find(s => /gagn/i.test(s.label)); // « Fermé gagné »
        if (stP) planifies += (await compte(`hs_v2_date_entered_${stP.id}`, false)).total;
        if (stR) realises += (await compte(`hs_v2_date_entered_${stR.id}`, false)).total;
        if (stN) {
          const rN = await compte(`hs_v2_date_entered_${stN.id}`, true);
          noshows += rN.total;
          for (const x of rN.deals) details.push({ ...x, pipeline: p.label });
        }
        // 💼 Ventes conclues sur la période + cycle de vente (entrée Démo planifiée → Fermé gagné)
        if (stW && stP) {
          const propW = `hs_v2_date_entered_${stW.id}`, propP = `hs_v2_date_entered_${stP.id}`;
          const rW = await hsFetch(`${HS}/crm/v3/objects/deals/search`, {
            method: 'POST', headers: H,
            body: JSON.stringify({
              filterGroups: [{ filters: [{ propertyName: propW, operator: 'BETWEEN', value: t0, highValue: t1 }] }],
              properties: ['dealname', propW, propP, 'hubspot_owner_id', 'revops_source', 'sdr'], limit: 100
            })
          }, etatHS);
          const dW = await rW.json().catch(() => ({}));
          gagnes += dW.total || 0;
          for (const x of (dW.results || [])) {
            const a = x.properties[propP], b = x.properties[propW];
            if (a && b) { const j = (new Date(b) - new Date(a)) / 86400000; if (j >= 0 && j < 400) cycles.push(j); }
            detailsGagnes.push({ id: x.id, nom: x.properties.dealname || '', date: x.properties[propW] || null, pipeline: p.label, owner_id: x.properties.hubspot_owner_id || null,
              origine: x.properties.revops_source || null, sdr_deal: x.properties.sdr || null });
          }
        }
      }
      // Nom de l'AE (propriétaire du deal) sur les ventes conclues
      try {
        const ids = [...new Set(detailsGagnes.map(d => d.owner_id).filter(Boolean))];
        if (ids.length) {
          const ro = await hsFetch(`${HS}/crm/v3/owners/?limit=500`, { headers: H }, etatHS);
          const doo = await ro.json().catch(() => ({}));
          const parId = new Map((doo.results || []).map(o => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || '']));
          for (const d of detailsGagnes) { d.ae = parId.get(String(d.owner_id)) || null; delete d.owner_id; }
        }
      } catch (_) {}
      // Email du contact associé à chaque deal gagné → rapprochement factures Zoho par email
      // (cas Bricopro : client Zoho « j.moueza@brico2000.fr », introuvable par le nom du deal)
      try {
        const dids = detailsGagnes.map(d => d.id).filter(Boolean);
        if (dids.length) {
          const ra = await hsFetch(`${HS}/crm/v4/associations/deals/contacts/batch/read`, {
            method: 'POST', headers: H, body: JSON.stringify({ inputs: dids.map(id => ({ id })) })
          }, etatHS);
          const da = await ra.json().catch(() => ({}));
          const contactDe = new Map(); const cids = new Set();
          for (const r of (da.results || [])) {
            const cid = r.to && r.to[0] && (r.to[0].toObjectId || r.to[0].id);
            if (r.from && cid) { contactDe.set(String(r.from.id), String(cid)); cids.add(String(cid)); }
          }
          if (cids.size) {
            const rc = await hsFetch(`${HS}/crm/v3/objects/contacts/batch/read`, {
              method: 'POST', headers: H, body: JSON.stringify({ properties: ['email'], inputs: [...cids].map(id => ({ id })) })
            }, etatHS);
            const dc = await rc.json().catch(() => ({}));
            const emailDe = new Map((dc.results || []).map(c => [String(c.id), ((c.properties && c.properties.email) || '').toLowerCase()]));
            for (const d of detailsGagnes) { const cid = contactDe.get(String(d.id)); d.email = (cid && emailDe.get(cid)) || null; }
          }
        }
      } catch (_) {}
      cycles.sort((a, b) => a - b);
      details.sort((a, b) => new Date(b.date) - new Date(a.date));
      return res.status(200).json({
        ok: true, periode: { du, au }, planifies, noshows, realises, gagnes,
        incomplet: etatHS.incomplet, // le front n'écrase pas des données complètes avec du partiel
        taux_pct: planifies ? Math.round(100 * noshows / planifies) : null,
        taux_vente_pct: planifies ? Math.round(100 * gagnes / planifies) : null,
        cycle_median_j: cycles.length ? Math.round(cycles[Math.floor(cycles.length / 2)]) : null,
        cycle_n: cycles.length,
        details: details.slice(0, 50),
        details_gagnes: detailsGagnes.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50),
        portal_id: portalId
      });
    } catch (e) { return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) }); }
  }

  try {
    const rp = await hsFetch(`${HS}/crm/v3/pipelines/deals`, { headers: H }, etatHS);
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
      const rs = await hsFetch(`${HS}/crm/v3/objects/deals/search`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: st.id }] }],
          properties: ['dealname', 'dealstage', 'hubspot_owner_id', prop, 'hs_v2_date_entered_' + st.id],
          limit: 2, sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
        })
      }, etatHS);
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
