// /api/basile-secteur.js — TEMPORAIRE — La chaîne "secteur national" donne-t-elle de vrais décideurs ?
// Cas testé : restauration rapide (NAF 56.10C) en France. Tout en petit limit -> GRATUIT. Superadmin.
import { verifierToken } from './db.js';

const BASE = 'https://api.basile.cc';

async function call(path, body, key) {
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    return { status: r.status, data: d };
  } catch (e) { return { status: 0, data: null, err: String(e.message || e) }; }
}

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const naf = { include: ['56.10C'] }; // Restauration de type rapide
  const out = [];

  // 1) Entreprises restauration rapide (national) + échantillon de SIREN
  const c = await call('/companies/find', { limit: 10, filters: { naf_code: naf } }, key);
  const comps = (c.data && (c.data.companies || c.data.leads || c.data.results)) || [];
  const sirens = []; const noms = [];
  for (const co of comps) {
    const x = co.data || co || {};
    const sir = x.siren || x.siren_number || null;
    const nom = x.company_name || x.name || x.denomination || '?';
    if (sir && sirens.length < 8) { sirens.push(sir); noms.push(nom + ' (CP ' + (x.headquarters_postal_code || '?') + ')'); }
  }
  out.push({ label: '① Entreprises NAF 56.10C (national)', type: 'entreprises', status: c.status, total: (c.data && c.data.total != null) ? c.data.total : null, apercu: noms });

  // 2) Dirigeants actuels de ces entreprises -> quels RÔLES ?
  if (sirens.length) {
    const p = await call('/people/find', { limit: 25, filters: { siren: { include: sirens }, result_is_current: true } }, key);
    const leads = (p.data && p.data.leads) || [];
    const roles = leads.map(l => { const x = l.data || {}; return (x.result_role || x.current_job_title || '?') + ' — ' + (x.current_company_name || x.result_company_name || '?'); });
    // Combien ont un rôle "marketing/CX/relation client" vs mandataire légal ?
    const cible = leads.filter(l => { const r = ((l.data || {}).result_role || (l.data || {}).current_job_title || '').toLowerCase(); return /marketing|exp[ée]rience client|relation client|cx|crm/.test(r); }).length;
    out.push({ label: '② Dirigeants de ces entreprises (rôles réels)', type: 'personnes', status: p.status, total: (p.data && p.data.total != null) ? p.data.total : null, note_cible: cible + ' / ' + leads.length + ' ont un rôle marketing/CX/relation client', apercu: roles.slice(0, 12) });
  }

  // 3) People : Directeur Marketing + NAF (le NAF filtre-t-il les PERSONNES ?)
  const pm = await call('/people/find', { limit: 5, filters: { result_role: { include: ['Directeur Marketing', 'Directrice Marketing'] }, naf_code: naf, result_country_code: { include: ['FR'] } } }, key);
  out.push({ label: '③ People: Directeur Marketing + NAF 56.10C', type: 'personnes', status: pm.status, total: (pm.data && pm.data.total != null) ? pm.data.total : null });

  // 4) Référence : Directeur Marketing seul (national, sans secteur)
  const pr = await call('/people/find', { limit: 5, filters: { result_role: { include: ['Directeur Marketing', 'Directrice Marketing'] }, result_country_code: { include: ['FR'] } } }, key);
  out.push({ label: '④ People: Directeur Marketing seul (référence)', type: 'personnes', status: pr.status, total: (pr.data && pr.data.total != null) ? pr.data.total : null });

  return res.status(200).json({
    note: '① combien d\'entreprises resto rapide. ② leurs dirigeants = gérants ou vrais directeurs marketing ? ③ si total ≈ ④ alors le NAF est IGNORÉ sur les personnes (le secteur ne filtre pas les gens).',
    out
  });
}
