// /api/basile-secteur.js — TEMPORAIRE — Peut-on filtrer les PERSONNES par taille d'entreprise (effectif) ?
// On teste plusieurs noms de champ + structures. Tout en limit:1 => GRATUIT. Superadmin.
import { verifierToken } from './db.js';
const BASE = 'https://api.basile.cc';
async function post(body, key) {
  try { const r = await fetch(BASE + '/people/find', { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => null); return { status: r.status, total: (d && d.total != null) ? d.total : null }; }
  catch (e) { return { status: 0, total: null }; }
}

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const role = { include: ['Directeur Marketing', 'Directrice Marketing'] };
  const fr = { include: ['FR'] };
  const base = { result_role: role, result_country_code: fr };

  // Référence (sans filtre effectif)
  const ref = await post({ limit: 1, filters: base }, key);
  const refTotal = ref.total;
  const out = [{ label: 'RÉFÉRENCE : Dir. Marketing seul', type: 'personnes', status: ref.status, total: refTotal }];

  const bandes = ['201-500', '501-1000', '1001-5000', '5001-10000', '10001+'];
  const noms = ['current_company_headcount', 'current_company_size', 'company_headcount', 'company_size', 'headcount', 'effectif', 'employee_count', 'current_company_employees'];

  // a) structure "bandes" {include:[...]}
  for (const n of noms) {
    const r = await post({ limit: 1, filters: { ...base, [n]: { include: bandes } } }, key);
    const flag = (r.total != null && refTotal != null) ? (r.total < refTotal ? ' ▼ FILTRE !' : ' = (ignoré)') : '';
    out.push({ label: n + ' = {include:bandes}', type: 'personnes', status: r.status, total: r.total, note_cible: flag });
  }
  // b) structure range {gte:200} sur les noms les plus probables
  for (const n of ['current_company_headcount', 'company_size', 'headcount']) {
    const r = await post({ limit: 1, filters: { ...base, [n]: { gte: 200 } } }, key);
    const flag = (r.total != null && refTotal != null) ? (r.total < refTotal ? ' ▼ FILTRE !' : ' = (ignoré)') : '';
    out.push({ label: n + ' = {gte:200}', type: 'personnes', status: r.status, total: r.total, note_cible: flag });
  }

  return res.status(200).json({ note: 'Compare chaque ligne à la RÉFÉRENCE (' + (refTotal != null ? refTotal.toLocaleString('fr-FR') : '?') + '). « ▼ FILTRE ! » = ce champ/structure filtre par effectif. « = ignoré » = ne marche pas.', out });
}
