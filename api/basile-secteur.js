// /api/basile-secteur.js — TEMPORAIRE — activity sur les personnes + recherche de l'endpoint d'autocomplétion.
import { verifierToken } from './db.js';
const BASE = 'https://api.basile.cc';
async function post(path, body, key) {
  try { const r = await fetch(BASE + path, { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => null); return { status: r.status, data: d, total: (d && d.total != null) ? d.total : null }; }
  catch (e) { return { status: 0, data: null, total: null }; }
}
async function get(path, key) {
  try { const r = await fetch(BASE + path, { headers: { 'Authorization': key } }); const d = await r.json().catch(() => null); return { status: r.status, data: d }; }
  catch (e) { return { status: 0, data: null }; }
}
function extraireIds(data) {
  let arr = Array.isArray(data) ? data : (data && (data.suggestions || data.results || data.items || data.data || data.activities)) || [];
  if (!Array.isArray(arr)) arr = [];
  return arr.map(it => (typeof it === 'string') ? it : (it.id || it.value || it.concept_id || it.slug || it.key || JSON.stringify(it).slice(0, 50)));
}

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const roleMkt = { include: ['Directeur Marketing', 'Directrice Marketing'] };
  const fr = { include: ['FR'] };
  const out = [];

  const ref = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, result_country_code: fr } }, key);
  out.push({ label: '④ Dir. Marketing seul (référence)', type: 'personnes', status: ref.status, total: ref.total });

  const pHosp = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, activity: { include: ['hospitality_global'] }, result_country_code: fr } }, key);
  out.push({ label: '⑦ Dir. Marketing + activity=hospitality_global', type: 'personnes', status: pHosp.status, total: pHosp.total });

  // ⑧ Trouver l'endpoint d'autocomplétion des activités (pattern /people/<type>/suggest)
  const types = ['activities', 'activity', 'sectors', 'sector', 'industries', 'industry', 'naf', 'concepts'];
  const trouve = [];
  let bonChemin = null; let exemples = [];
  for (const t of types) {
    const sg = await get('/people/' + t + '/suggest?q=restauration', key);
    if (sg.status === 200 && sg.data) {
      const ids = extraireIds(sg.data);
      trouve.push('/people/' + t + '/suggest = 200 ✓ (' + ids.length + ' ids)');
      if (ids.length && !bonChemin) { bonChemin = '/people/' + t + '/suggest'; exemples = ids.slice(0, 8); }
    } else { trouve.push('/people/' + t + '/suggest = ' + sg.status); }
  }
  out.push({ label: '⑧ Recherche endpoint autocomplétion', type: 'endpoints', status: 200, total: null, apercu: trouve });
  if (bonChemin) out.push({ label: '✅ Endpoint trouvé : ' + bonChemin + ' — IDs "restauration"', type: 'concepts', status: 200, total: exemples.length, apercu: exemples });

  return res.status(200).json({ note: '⑦ confirme : activity filtre les personnes. ⑧ cherche l\'endpoint qui donne les slugs précis (ex. restauration rapide).', out });
}
