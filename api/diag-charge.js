// /api/diag-charge.js — 📊 Diagnostic de charge (superadmin) : où passe le temps et le volume.
// GET /api/diag-charge → poids réel des données, taille des tables, chronos des requêtes
// les plus lourdes (celles du cockpit et d'Insights), et projection à ×3 / ×10.
// Lecture seule, aucune écriture. Sert à décider si le passage à une table `fiches` est urgent.

import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { maxDuration: 60 };

const mo = o => Math.round((Number(o) || 0) / 10485.76) / 100; // octets → Mo (2 décimales)

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé superadmin' });
  await ensureSchema();
  const t0 = Date.now();
  const out = { ok: true, mesure_le: new Date().toISOString() };

  try {
    // ── 1. Poids des données : la colonne entreprises (JSONB) liste par liste ──
    const listes = await sql`SELECT id, nom, sdr, statut, total,
        pg_column_size(entreprises) AS octets,
        jsonb_array_length(CASE WHEN jsonb_typeof(entreprises) = 'array' THEN entreprises ELSE '[]'::jsonb END) AS fiches
      FROM listes ORDER BY pg_column_size(entreprises) DESC NULLS LAST`;
    const totOctets = listes.reduce((s, l) => s + Number(l.octets || 0), 0);
    const totFiches = listes.reduce((s, l) => s + Number(l.fiches || 0), 0);
    out.donnees = {
      listes: listes.length,
      fiches_total: totFiches,
      poids_total_mo: mo(totOctets),
      poids_moyen_par_fiche_ko: totFiches ? Math.round(totOctets / totFiches / 102.4) / 10 : 0,
      top10_listes: listes.slice(0, 10).map(l => ({ nom: l.nom, sdr: l.sdr, statut: l.statut, fiches: Number(l.fiches || 0), poids_mo: mo(l.octets) }))
    };

    // ── 2. Taille des tables (données + index) ──
    // pg_class et pg_stat_user_tables ont toutes deux une colonne relname → préfixer (500 le 07/08)
    const tables = await sql`SELECT c.relname AS nom_table, pg_total_relation_size(c.oid) AS octets, s.n_live_tup AS lignes
      FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`;
    out.tables = tables.map(t => ({ table: t.nom_table, lignes: Number(t.lignes || 0), taille_mo: mo(t.octets) }));

    // ── 3. Chronos des requêtes réellement utilisées (les plus lourdes du produit) ──
    const chrono = async (nom, fn) => { const d = Date.now(); let n = 0; try { n = await fn(); } catch (e) { return { nom, erreur: String(e.message || e).slice(0, 80) }; } return { nom, ms: Date.now() - d, lignes: n }; };
    out.requetes = [];
    out.requetes.push(await chrono('Insights — scan de TOUTES les listes (stats-journees)', async () => {
      const r = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' IS DISTINCT FROM 'hotleads'`;
      return r.reduce((s, l) => s + ((Array.isArray(l.entreprises) ? l.entreprises.length : 0)), 0);
    }));
    out.requetes.push(await chrono('Cockpit — listes actives d\'un SDR', async () => {
      const r = await sql`SELECT id, entreprises FROM listes WHERE sdr = ${user.nom} AND statut = 'active'`;
      return r.reduce((s, l) => s + ((Array.isArray(l.entreprises) ? l.entreprises.length : 0)), 0);
    }));
    out.requetes.push(await chrono('Hot Leads (liste partagée)', async () => {
      const r = await sql`SELECT entreprises FROM listes WHERE criteres->>'auto' = 'hotleads' LIMIT 1`;
      return r.length ? (Array.isArray(r[0].entreprises) ? r[0].entreprises.length : 0) : 0;
    }));
    out.requetes.push(await chrono('Activités — 30 derniers jours', async () => {
      const r = await sql`SELECT COUNT(*)::int AS n FROM activites WHERE ts > NOW() - INTERVAL '30 days'`;
      return r[0].n;
    }));
    out.requetes.push(await chrono('Listing Historique (200 listes, sans les fiches)', async () => {
      const r = await sql`SELECT id, nom, sdr, statut, total, created_at FROM listes ORDER BY created_at DESC LIMIT 200`;
      return r.length;
    }));

    // ── 4. Index présents sur les tables chaudes ──
    const idx = await sql`SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('listes','activites','taches','conso','journees_sdr') ORDER BY tablename`;
    out.index = idx.map(i => `${i.tablename}.${i.indexname}`);

    // ── 5. Lecture : verdict + projection ──
    const pireMs = Math.max(...out.requetes.map(r => r.ms || 0));
    const projx3 = Math.round(pireMs * 3), projx10 = Math.round(pireMs * 10);
    out.verdict = {
      requete_la_plus_lourde_ms: pireMs,
      projection_x3_ms: projx3, projection_x10_ms: projx10,
      plafond_cockpit_ms: 30000, plafond_insights_ms: 120000,
      // Le scan complet croît linéairement avec le volume : c'est lui qui fixe la limite.
      alerte: projx10 > 25000 ? '⛔ à ×10 le scan complet dépasse le plafond du cockpit — table `fiches` nécessaire avant'
        : (projx3 > 10000 ? '⚠️ à ×3 les temps deviennent sensibles — prévoir les agrégats' : '✅ marge confortable jusqu\'à ×10 sur ce critère'),
      poids_transfere_par_ouverture_insights_mo: mo(totOctets)
    };
    out.duree_diagnostic_ms = Date.now() - t0;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ erreur: 'Diagnostic impossible', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
