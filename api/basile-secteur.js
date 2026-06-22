// /api/basile-secteur.js — TEMPORAIRE — Le secteur filtre-t-il les PERSONNES ? (naf_code vs activity)
// Tout en petit limit -> GRATUIT. Superadmin uniquement.
import { verifierToken } from './db.js';

const BASE = 'https://api.basile.cc';

async function post(path, body, key) {
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    return { status: r.status, data: d };
  } catch (e) { return { status: 0, data: null, err: String(e.message || e) }; }
}
async function get(path, key) {
  try {
    const r = await fetch(BASE + path, { headers: { 'Authorization': key } });
    const d = await r.json().catch(() => null);
    return { status: r.status, data: d };
  } catch (e) { return { status: 0, data: null, err: String(e.message || e) }; }
}
function extraireIds(data) {
  let arr = Array.isArray(data) ? data : (data && (data.suggestions || data.results || data.items || data.data)) || [];
  if (!Array.isArray(arr)) arr = [];
  return arr.map(it => {
    if (typeof it === 'string') return it;
    return it.id || it.value || it.concept_id || it.slug || it.key || JSON.stringify(it).slice(0, 40);
  });
}

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const naf = { include: ['56.10C'] };
  const roleMkt = { include: ['Directeur Marketing', 'Directrice Marketing'] };
  const out = [];

  // ① Entreprises restauration rapide (national) + échantillon SIREN
  const c = await post('/companies/find', { limit: 10, filters: { naf_code: naf } }, key);
  const comps = (c.data && (c.data.companies || c.data.leads || c.data.results)) || [];
  const sirens = []; const noms = [];
  for (const co of comps) { const x = co.data || co || {}; const sir = x.siren || null; const nom = x.company_name || x.name || '?'; if (sir && sirens.length < 8) { sirens.push(sir); noms.push(nom); } }
  out.push({ label: '① Entreprises NAF 56.10C (national)', type: 'entreprises', status: c.status, total: (c.data && c.data.total != null) ? c.data.total : null, apercu: noms });

  // ② Dirigeants de ces entreprises -> rôles
  if (sirens.length) {
    const p = await post('/people/find', { limit: 25, filters: { siren: { include: sirens }, result_is_current: true } }, key);
    const leads = (p.data && p.data.leads) || [];
    const cible = leads.filter(l => /marketing|exp[ée]rience client|relation client|cx|crm/.test(((l.data || {}).result_role || (l.data || {}).current_job_title || '').toLowerCase())).length;
    out.push({ label: '② Dirigeants de ces entreprises', type: 'personnes', status: p.status, total: (p.data && p.data.total != null) ? p.data.total : null, note_cible: cible + ' / ' + leads.length + ' ont un rôle marketing/CX' });
  }

  // ③ People: Directeur Marketing + NAF (naf ignoré sur les personnes ?)
  const pNaf = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, naf_code: naf, result_country_code: { include: ['FR'] } } }, key);
  out.push({ label: '③ People: Dir. Marketing + NAF', type: 'personnes', status: pNaf.status, total: (pNaf.data && pNaf.data.total != null) ? pNaf.data.total : null });

  // ④ People: Directeur Marketing seul (référence)
  const pRef = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, result_country_code: { include: ['FR'] } } }, key);
  const refTotal = (pRef.data && pRef.data.total != null) ? pRef.data.total : null;
  out.push({ label: '④ People: Dir. Marketing seul (référence)', type: 'personnes', status: pRef.status, total: refTotal });

  // ⑤ Résoudre l'ID concept "restauration" via autocomplétion (on teste plusieurs chemins)
  let activityIds = []; let suggestPath = null;
  for (const path of ['/people/activities/suggest?q=restauration', '/activities/suggest?q=restauration', '/people/activity/suggest?q=restauration']) {
    const sg = await get(path, key);
    if (sg.status === 200 && sg.data) { const ids = extraireIds(sg.data); if (ids.length) { activityIds = ids; suggestPath = path; break; } }
  }
  out.push({ label: '⑤ IDs concept "restauration"' + (suggestPath ? ' (' + suggestPath.split('?')[0] + ')' : ' (introuvable)'), type: 'concepts', status: suggestPath ? 200 : 404, total: activityIds.length, apercu: activityIds.slice(0, 10) });

  // ⑥ People: Directeur Marketing + activity (le secteur filtre-t-il enfin les personnes ?)
  if (activityIds.length) {
    const pAct = await post('/people/find', { limit: 3, filters: { result_role: roleMkt, activity: { include: [activityIds[0]] }, result_country_code: { include: ['FR'] } } }, key);
    out.push({ label: '⑥ People: Dir. Marketing + activity="' + activityIds[0] + '"', type: 'personnes', status: pAct.status, total: (pAct.data && pAct.data.total != null) ? pAct.data.total : null, note_cible: 'à comparer à ④ (' + (refTotal != null ? refTotal.toLocaleString('fr-FR') : '?') + ') : si nettement plus petit, le secteur filtre enfin les personnes !' });
  } else {
    out.push({ label: '⑥ People: Dir. Marketing + activity', type: 'personnes', status: 0, total: null, note_cible: 'non testé (aucun ID concept trouvé en ⑤)' });
  }

  return res.status(200).json({
    note: '③≈④ => NAF ignoré sur les personnes. ⑥ vs ④ => si activity réduit fortement le total, on PEUT filtrer un poste par secteur via activity.',
    out
  });
}
