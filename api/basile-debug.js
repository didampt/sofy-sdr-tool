// /api/basile-debug.js — TEMPORAIRE — inspecte la structure brute d'une fiche Basile.
// À SUPPRIMER après diagnostic. Réservé superadmin.
//
// GET /api/basile-debug?type=companies   → 1 entreprise (tous les champs)
// GET /api/basile-debug?type=people      → 1 contact (tous les champs)
//
// Objectif : voir si Basile renvoie le CA, le nombre d'établissements, etc.

import { verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const type = (req.query.type === 'people') ? 'people' : 'companies';
  const path = type === 'people' ? '/people/find' : '/companies/find';

  // Filtre minimal pour ramener au moins 1 résultat (entreprises actives FR)
  const filters = type === 'people'
    ? { result_country_code: { include: ['FR'] }, result_is_current: true }
    : { company_ceased: false };

  try {
    const r = await fetch('https://api.basile.cc' + path, {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, filters })
    });
    const data = await r.json().catch(() => null);
    if (!data) return res.status(502).json({ erreur: 'Réponse Basile illisible', status: r.status });

    const premier = (data.leads && data.leads[0]) ? data.leads[0] : null;

    return res.status(200).json({
      status: r.status,
      total: data.total || 0,
      // Liste de TOUS les noms de champs disponibles (le plus utile pour décider)
      champs_disponibles: premier ? Object.keys(premier).sort() : [],
      // Un exemple complet (pour voir les valeurs)
      exemple_fiche: premier,
      // Structure de la pagination
      a_pagination: !!data.pagination
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur Basile', detail: String(e.message || e).slice(0, 200) });
  }
}
