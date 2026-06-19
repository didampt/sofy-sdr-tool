// /api/basile-debug3.js — TEMPORAIRE — isole quel filtre people fait chuter le comptage à 0.
// À SUPPRIMER après diagnostic. Réservé superadmin.
//
// GET /api/basile-debug3
// Fait une recherche entreprises (Antilles/Guyane/Réunion, distribution), récupère leurs noms,
// puis teste le comptage de contacts avec des combinaisons de filtres de plus en plus strictes.

import { verifierToken } from './db.js';

async function basile(path, body, key) {
  const r = await fetch('https://api.basile.cc' + path, {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, total: data?.total, ok: r.ok, leadsCount: (data?.leads || []).length };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  try {
    // 1) Cherche des entreprises de distribution dans les DOM (CP 971/972/973/974)
    const cps = [];
    for (const base of ['971', '972', '973', '974']) for (let i = 0; i <= 9; i++) cps.push(base + String(i) + '0'); // échantillon de CP
    const fEnt = { company_ceased: false, headquarters_postal_code: { include: cps } };
    const entRes = await fetch('https://api.basile.cc/companies/find', {
      method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20, filters: fEnt })
    });
    const entData = await entRes.json().catch(() => null);
    const entreprises = (entData?.leads || []);
    // Récupère les noms (les 2 champs : legal_name ET current_company_name pour comparer)
    const nomsLegal = entreprises.map(e => (e.data || {}).legal_name).filter(Boolean).slice(0, 10);
    const nomsCompany = entreprises.map(e => (e.data || {}).company_name).filter(Boolean).slice(0, 10);
    const noms = [...new Set([...nomsLegal, ...nomsCompany])].slice(0, 10);

    const postes = ['Directeur Commercial', 'Gérant', 'Directeur Marketing', 'Sales Director', 'CMO', 'Manager'];

    // 2) Teste plusieurs combinaisons de filtres (comptage gratuit limit:1)
    const tests = {};

    // A) Postes seuls + FR
    tests.A_postes_seuls = (await basile('/people/find', { limit: 1, filters: { result_role: { include: postes }, result_country_code: { include: ['FR'] }, result_is_current: true } }, key)).total;

    // B) Postes + séniorité + FR
    tests.B_postes_seniorite = (await basile('/people/find', { limit: 1, filters: { result_role: { include: postes }, current_seniority: { include: ['C-Level', 'Director', 'Head'] }, result_country_code: { include: ['FR'] }, result_is_current: true } }, key)).total;

    // C) employer seul (noms exacts) — sans poste
    tests.C_employer_seul = (await basile('/people/find', { limit: 1, filters: { employer: { include: noms.map(n => `"${n}"`) }, result_is_current: true } }, key)).total;

    // D) employer + postes
    tests.D_employer_postes = (await basile('/people/find', { limit: 1, filters: { employer: { include: noms.map(n => `"${n}"`) }, result_role: { include: postes }, result_is_current: true } }, key)).total;

    // E) employer + postes + séniorité (ce que fait le code actuel)
    tests.E_tout = (await basile('/people/find', { limit: 1, filters: { employer: { include: noms.map(n => `"${n}"`) }, result_role: { include: postes }, current_seniority: { include: ['C-Level', 'Director', 'Head'] }, result_country_code: { include: ['FR'] }, result_is_current: true } }, key)).total;

    // F) employer SANS guillemets (contains au lieu de exact)
    tests.F_employer_contains = (await basile('/people/find', { limit: 1, filters: { employer: { include: noms }, result_is_current: true } }, key)).total;

    return res.status(200).json({
      nb_entreprises_trouvees: entreprises.length,
      noms_utilises: noms,
      noms_legal_vs_company: { legal: nomsLegal.slice(0, 5), company: nomsCompany.slice(0, 5) },
      comptages: tests,
      interpretation: 'Compare les totaux : celui qui chute à 0 révèle le filtre coupable.'
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur diagnostic', detail: String(e.message || e).slice(0, 200) });
  }
}
