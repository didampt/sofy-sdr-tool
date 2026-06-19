// /api/basile-debug5.js — TEMPORAIRE — DERNIER TEST.
// Teste toutes les hypothèses restantes pour accéder aux personas LinkedIn de Basile.
// À SUPPRIMER après. Réservé superadmin.

import { verifierToken } from './db.js';

async function cnt(filters, key) {
  try {
    const r = await fetch('https://api.basile.cc/people/find', {
      method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 3, filters })
    });
    const d = await r.json().catch(() => null);
    return { status: r.status, total: d?.total ?? null, sources: [...new Set((d?.leads || []).map(l => l.source))], exemple: (d?.leads || [])[0]?.data ? Object.keys((d?.leads || [])[0].data).sort() : [] };
  } catch (e) { return { erreur: String(e.message || e).slice(0, 80) }; }
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const tests = {};

  // H1 — result_role avec des intitulés LÉGAUX (pour voir ce que ce champ contient vraiment)
  tests.H1_roles_legaux = await cnt({ result_role: { include: ['Gérant', 'Président', 'Directeur Général'] }, result_country_code: { include: ['FR'] } }, key);

  // H2 — un autre nom de champ pour le poste : current_title
  tests.H2_current_title = await cnt({ current_title: { include: ['Directeur Commercial'] }, result_country_code: { include: ['FR'] } }, key);

  // H3 — job_title
  tests.H3_job_title = await cnt({ job_title: { include: ['Directeur Commercial'] }, result_country_code: { include: ['FR'] } }, key);

  // H4 — recherche par mot-clé de profil (profile_keywords)
  tests.H4_profile_keywords = await cnt({ profile_keywords: { include: ['Directeur Commercial'] }, result_country_code: { include: ['FR'] } }, key);

  // H5 — current_seniority seule (pour voir les valeurs acceptées : on tente des variantes)
  tests.H5a_seniority_CXO = await cnt({ current_seniority: { include: ['CXO'] }, result_country_code: { include: ['FR'] } }, key);
  tests.H5b_seniority_owner = await cnt({ current_seniority: { include: ['Owner'] }, result_country_code: { include: ['FR'] } }, key);
  tests.H5c_seniority_director = await cnt({ current_seniority: { include: ['director'] }, result_country_code: { include: ['FR'] } }, key); // minuscule

  // H6 — has_lki_company_enrichment (forcer la source LinkedIn)
  tests.H6_lki_only = await cnt({ has_lki_company_enrichment: true, result_country_code: { include: ['FR'] } }, key);

  // H7 — result_role minuscule / variante
  tests.H7_role_minuscule = await cnt({ result_role: { include: ['directeur commercial'] }, result_country_code: { include: ['FR'] } }, key);

  return res.status(200).json({
    note: 'Compare les totaux. Un total > 0 révèle le bon champ/la bonne valeur. exemple = champs réels du 1er résultat.',
    tests
  });
}
