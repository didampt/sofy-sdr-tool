// /api/basile-secteur.js — TEMPORAIRE — Catalogue des secteurs "activity" disponibles (slugs *_global).
import { verifierToken } from './db.js';
const BASE = 'https://api.basile.cc';
async function post(path, body, key) {
  try { const r = await fetch(BASE + path, { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => null); return { status: r.status, total: (d && d.total != null) ? d.total : null }; }
  catch (e) { return { status: 0, total: null }; }
}

export default async function handler(req, res) {
  const u = verifierToken(req);
  if (!u) return res.status(401).json({ erreur: 'Non authentifié' });
  if (u.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const candidats = [
    'retail_global', 'ecommerce_global', 'commerce_global',
    'automotive_global', 'auto_global', 'mobility_global',
    'hospitality_global', 'food_global', 'restaurant_global',
    'health_global', 'healthcare_global', 'medical_global', 'pharma_global',
    'realestate_global', 'real_estate_global', 'construction_global', 'btp_global',
    'finance_global', 'banking_global', 'insurance_global',
    'manufacturing_global', 'industry_global', 'industrial_global',
    'transport_global', 'logistics_global',
    'education_global', 'beauty_global', 'wellness_global', 'sport_global', 'fitness_global',
    'agriculture_global', 'agri_global', 'tech_global', 'it_global', 'software_global',
    'media_global', 'telecom_global', 'energy_global', 'legal_global', 'consulting_global',
    'tourism_global', 'travel_global', 'wholesale_global', 'services_global'
  ];

  const valides = []; const ignores = []; const ko = [];
  for (const slug of candidats) {
    const r = await post('/companies/find', { limit: 1, filters: { activity: { include: [slug] } } }, key);
    if (r.total == null) ko.push(slug);
    else if (r.total >= 5000000) ignores.push(slug + ' (' + r.total.toLocaleString('fr-FR') + ')');
    else valides.push({ slug, total: r.total });
  }
  valides.sort((a, b) => b.total - a.total);

  const out = [
    { label: '✅ Secteurs activity VALIDES (' + valides.length + ')', type: 'concepts', status: 200, total: valides.length, apercu: valides.map(v => v.slug + ' = ' + v.total.toLocaleString('fr-FR')) },
    { label: 'Récap', type: 'info', status: 200, total: null, apercu: [ko.length + ' slugs inconnus', ignores.length + ' slugs ignorés (renvoient toute la base)'] }
  ];
  return res.status(200).json({ note: 'Secteurs "activity" VALIDES = utilisables pour filtrer un poste par secteur sur les personnes.', out });
}
