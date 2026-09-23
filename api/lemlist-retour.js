// /api/lemlist-retour.js — push RETOUR de l'analyse SofyScrap vers la campagne Lemlist d'ORIGINE
// (GO Didier 23/09 : « il faut donner du contexte lors de l'appel »). Pour une liste créée via
// 📥 Importer depuis Lemlist puis enrichie 🚀, on met à jour les variables des leads EXISTANTS
// dans la campagne (gmb_note, avis_negatif, gmb_maps_url…) — le SDR voit le pré-audit dans
// Lemlist au moment d'appeler, sans changer d'écran.
//
// POST { campagne:'cam_x', leads:[{ lemlist_id, email, variables:{…} }] }  (cap 300/appel)
//   → { ok, maj, echecs:[{cle,status,detail}], sans_cle }
// Adresse chaque lead par son _id Lemlist (fiable même SANS email — cas People Database),
// sinon par email. PATCH uniquement : on ne crée JAMAIS de lead ici (le sourcing reste à Lemlist).

import { verifierToken } from './db.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante dans Vercel' });
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + Buffer.from(':' + apiKey).toString('base64') };

  const { campagne, leads } = req.body || {};
  if (!campagne || !Array.isArray(leads) || !leads.length) {
    return res.status(400).json({ erreur: 'campagne et leads[] requis' });
  }

  // Même hygiène que /api/lemlist : on ne pousse que des chaînes non vides.
  const nettoyer = (variables) => {
    const corps = {};
    for (const [k, v] of Object.entries(variables || {})) {
      if (v === null || v === undefined || v === '') continue;
      corps[k] = (typeof v === 'string') ? v : (Array.isArray(v) ? v.join('; ') : String(v));
    }
    return corps;
  };

  const aFaire = leads.slice(0, 300);
  let maj = 0, sansCle = 0;
  const echecs = [];

  const patchUn = async (l) => {
    const cle = String(l.lemlist_id || l.email || '').trim();
    if (!cle) { sansCle++; return; }
    const corps = nettoyer(l.variables);
    if (!Object.keys(corps).length) return;
    try {
      const r = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(cle)}`,
        { method: 'PATCH', headers, body: JSON.stringify(corps) });
      if (r.ok) { maj++; return; }
      const txt = await r.text().catch(() => '');
      echecs.push({ cle: cle.slice(0, 40), status: r.status, detail: (txt || '').slice(0, 120) });
    } catch (e) {
      echecs.push({ cle: cle.slice(0, 40), status: 0, detail: String(e.message || e).slice(0, 120) });
    }
  };

  // 5 de front : ~170 leads en <15 s, sous les limites Lemlist (20 req/s par clé).
  for (let i = 0; i < aFaire.length; i += 5) {
    await Promise.all(aFaire.slice(i, i + 5).map(patchUn));
  }

  return res.status(200).json({ ok: true, maj, echecs: echecs.slice(0, 20), nb_echecs: echecs.length, sans_cle: sansCle, recus: aFaire.length });
}
