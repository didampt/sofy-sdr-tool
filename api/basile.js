// /api/basile.js — Moteur de recherche Basile (data B2B française : INSEE/INPI + LinkedIn + GMB).
// Clé API protégée côté serveur (jamais exposée au front).
//
// POST { action, filters, limit?, paginationToken? }
//   action = 'count'      → comptage gratuit (ne consomme aucun quota) : renvoie { total }
//   action = 'companies'  → recherche d'entreprises (/companies/find) : renvoie { total, leads, nextToken }
//   action = 'people'     → recherche de contacts (/people/find)       : renvoie { total, leads, nextToken }
//
// Auth Basile : header Authorization = clé brute, SANS préfixe "Bearer".
// Réponse Basile : { success, total, leads:[...], pagination:{ nextToken } }
// Pagination : 100 résultats max/page. Page 1 OK ; pages suivantes => 402 si pas d'abonnement actif.

import { verifierToken } from './db.js';

const BASE = 'https://api.basile.cc';

async function basileFetch(path, body, key) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}

export default async function handler(req, res) {
  // Auth interne Sofy Scrap
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const { action, filters, limit, paginationToken } = req.body || {};
  if (!action || !filters || typeof filters !== 'object') {
    return res.status(400).json({ erreur: 'action et filters requis' });
  }

  // Choix de l'endpoint Basile selon l'action.
  // 'count' compte des contacts, 'count_companies' compte des entreprises (les deux gratuits via limit:1).
  const ENDPOINTS = {
    companies: '/companies/find',
    people: '/people/find',
    count: '/people/find',
    count_companies: '/companies/find'
  };
  const realPath = ENDPOINTS[action];
  if (!realPath) return res.status(400).json({ erreur: 'action inconnue' });

  // Construction du corps de requête Basile
  const body = { filters };
  // Comptage = limit:1 (gratuit, on ne lit que total). Sinon, page de 100 max.
  if (action === 'count' || action === 'count_companies') {
    body.limit = 1;
  } else {
    body.limit = Math.min(parseInt(limit) || 100, 100);
    if (paginationToken) body.paginationToken = paginationToken;
  }

  try {
    const { status, data } = await basileFetch(realPath, body, key);

    // Gestion des erreurs Basile les plus courantes
    if (status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée (401)' });
    if (status === 402) return res.status(402).json({ erreur: 'Abonnement Basile requis pour la pagination (402)' });
    if (status === 429) {
      const retry = 5;
      return res.status(429).json({ erreur: 'Trop de requêtes Basile (429)', retry_after: retry });
    }
    if (!data || data.success === false) {
      return res.status(502).json({ erreur: 'Réponse Basile invalide', status });
    }

    // Réponse normalisée pour le front
    return res.status(200).json({
      total: data.total || 0,
      leads: Array.isArray(data.leads) ? data.leads : [],
      nextToken: data.pagination?.nextToken || null
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur appel Basile', detail: String(e.message || e).slice(0, 200) });
  }
}
