// /api/noshow.js — 👻 Taux de no-show depuis le PIPELINE HubSpot (stages « Démo planifiée » /
// « No show » / « Démo réalisée », horodatés par hs_v2_date_entered_<stageId>).
// ÉTAPE 0 (?debug=1, superadmin) : liste les pipelines/stages + 2 deals du stage No show avec
// leur date d'entrée — valide les IDs et la dispo des propriétés avant de brancher la tuile.

import { verifierToken } from './db.js';

const HS = 'https://api.hubapi.com';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé au superadmin' });
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ erreur: 'HUBSPOT_API_KEY manquante' });
  const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

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
