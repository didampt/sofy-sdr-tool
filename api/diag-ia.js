// /api/diag-ia.js — 💸 Où partent les crédits Claude ? (superadmin, lecture seule)
// GET ?jours=7 →
//   { periode_jours, total_usd, par_source:[{source, modele, appels, input, output, recherches,
//     cout_usd, cout_moyen_usd}], par_jour:[{jour, appels, cout_usd}],
//     historique_30j:[{appelant, appels}] }
// par_source / par_jour viennent du compteur de db.js (table ia_usage, coût réel par modèle,
// alimenté depuis le 01/10). historique_30j lit l'ancien journal `consommations` (api =
// ia_claude) : incomplet et sans modèle, mais il dit QUI appelait avant le compteur — le cron
// du radar y signe « radar (cron) ».

import { verifierToken, sql } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé superadmin' });
  if (!sql) return res.status(500).json({ erreur: 'Base indisponible' });
  const jours = Math.max(1, Math.min(90, parseInt((req.query || {}).jours || '7', 10) || 7));
  const depuis = new Date(Date.now() - jours * 86400000);
  const out = { periode_jours: jours, par_source: [], par_jour: [], historique_30j: [] };
  try {
    out.par_source = await sql`SELECT source, modele, COUNT(*)::int AS appels,
        SUM(input)::int AS input, SUM(output)::int AS output, SUM(cache_lu)::int AS cache_lu,
        SUM(recherches)::int AS recherches, ROUND(SUM(cout_usd), 2)::float AS cout_usd,
        ROUND(AVG(cout_usd), 4)::float AS cout_moyen_usd
      FROM ia_usage WHERE ts >= ${depuis} GROUP BY source, modele ORDER BY cout_usd DESC`;
    out.par_jour = await sql`SELECT to_char(ts AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
        COUNT(*)::int AS appels, ROUND(SUM(cout_usd), 2)::float AS cout_usd
      FROM ia_usage WHERE ts >= ${depuis} GROUP BY 1 ORDER BY 1 DESC`;
    out.total_usd = Math.round(out.par_source.reduce((s, r) => s + (r.cout_usd || 0), 0) * 100) / 100;
  } catch (e) {
    out.compteur = /ia_usage/.test(String(e.message)) ? 'pas encore de données (le compteur se remplit au premier appel Claude)' : String(e.message).slice(0, 150);
  }
  try {
    out.historique_30j = await sql`SELECT sdr AS appelant, SUM(quantite)::int AS appels
      FROM consommations WHERE api = 'ia_claude' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY sdr ORDER BY 2 DESC LIMIT 20`;
  } catch (_) {}
  return res.status(200).json(out);
}
