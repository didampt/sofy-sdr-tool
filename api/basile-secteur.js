// /api/basile-secteur.js — TEMPORAIRE — Le filtre "activity" sauve-t-il le ciblage secteur sur les PERSONNES ?
// Tout en petit limit -> GRATUIT. Superadmin.
import { verifierToken } from './db.js';

const BASE = 'https://api.basile.cc';
async function post(path, body, key) {
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    return { status: r.status, data: d, total: (d && d.total != null) ? d.total : null };
  } catch (e) { return { status: 0, data: null, total: null }; }
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

  // ④ référence : Directeur Marketing seul
  const ref = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, result_country_code: fr } }, key);
  const refTotal = ref.total;
  out.push({ label: '④ People: Dir. Marketing seul (référence)', type: 'personnes', status: ref.status, total: refTotal });

  // ⑤ activity filtre-t-il les PERSONNES ? (id certifié btp_global)
  const pBtp = await post('/people/find', { limit: 1, filters: { result_role: roleMkt, activity: { include: ['btp_global'] }, result_country_code: fr } }, key);
  out.push({ label: '⑤ People: Dir. Marketing + activity=btp_global', type: 'personnes', status: pBtp.status, total: pBtp.total, note_cible: 'vs ④ (' + (refTotal != null ? refTotal.toLocaleString('fr-FR') : '?') + ') : si << alors activity FILTRE les personnes' });

  // ⑥ trouver l'ID concept "restauration" via des slugs plausibles, testés sur ENTREPRISES (où activity marche)
  const guesses = ['restauration_global', 'food_global', 'restaurants_global', 'fast_food_global', 'hospitality_global', 'restauration_rapide_global'];
  let best = null; const gr = [];
  for (const g of guesses) {
    const r = await post('/companies/find', { limit: 1, filters: { activity: { include: [g] } } }, key);
    const t = r.total;
    const plausible = (t != null && t > 5000 && t < 3000000);
    gr.push(g + ' = ' + (t == null ? 'KO' : t.toLocaleString('fr-FR')) + (plausible ? ' ✓' : (t != null && t >= 3000000 ? ' (ignoré?)' : '')));
    if (plausible && !best) best = g;
  }
  out.push({ label: '⑥ IDs activity "restauration" testés (entreprises)', type: 'concepts', status: 200, total: null, apercu: gr });

  // ⑦ si un ID valide : Directeur Marketing + cet ID sur les PERSONNES
  if (best) {
    const pAct = await post('/people/find', { limit: 3, filters: { result_role: roleMkt, activity: { include: [best] }, result_country_code: fr } }, key);
    out.push({ label: '⑦ People: Dir. Marketing + activity="' + best + '"', type: 'personnes', status: pAct.status, total: pAct.total, note_cible: 'vs ④ (' + (refTotal != null ? refTotal.toLocaleString('fr-FR') : '?') + ') : si << alors on PEUT cibler poste + secteur sur les personnes' });
  } else {
    out.push({ label: '⑦ People: Dir. Marketing + activity', type: 'personnes', status: 0, total: null, note_cible: 'aucun ID activity restauration plausible trouvé en ⑥' });
  }

  return res.status(200).json({
    note: 'DÉCISIF : ⑤ et ⑦ comparés à ④. Si activity réduit fortement le total, le secteur filtre enfin les personnes (poste + secteur possible). Sinon, impossible avec Basile.',
    out
  });
}
