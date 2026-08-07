// /api/purge-cron.js — 🧹 Hygiène de la base (cron mensuel, 1er du mois 4 h UTC).
// lemlist_events était la plus grosse table (31,8 Mo / 18 411 lignes le 07/08) : payloads bruts
// des webhooks, jamais purgés, sans index, alors que les données utiles sont déjà dérivées
// (linkedin_profils, activites). On garde 90 jours de brut pour le debug, on jette le reste.
// GET ?dry=1 → ce qui serait supprimé, sans rien toucher. ?jours=N pour ajuster la rétention.

import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { maxDuration: 60 };

const mo = o => Math.round((Number(o) || 0) / 10485.76) / 100;

export default async function handler(req, res) {
  const estCron = !!req.headers['x-vercel-cron'] ||
    (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`);
  const user = estCron ? null : verifierToken(req);
  if (!estCron && (!user || user.role !== 'superadmin')) return res.status(401).json({ erreur: 'Cron ou superadmin uniquement' });
  const dry = (req.query || {}).dry === '1';
  const jours = Math.max(30, Math.min(365, parseInt((req.query || {}).jours || '90', 10) || 90));

  try {
    await ensureSchema();
    const out = { ok: true, dry, retention_jours: jours };

    // Index (idempotent) : la lecture des profils fait un DISTINCT ON (lower(email)) ORDER BY recu_le
    try {
      await sql`CREATE INDEX IF NOT EXISTS idx_lemlist_events_email_date ON lemlist_events (lower(email), recu_le DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_lemlist_events_date ON lemlist_events (recu_le)`;
      out.index = 'ok';
    } catch (e) { out.index = 'erreur : ' + String(e.message || e).slice(0, 120); }

    const [avant] = await sql`SELECT COUNT(*)::int AS lignes, pg_total_relation_size('lemlist_events') AS octets FROM lemlist_events`;
    const [aPurger] = await sql`SELECT COUNT(*)::int AS n FROM lemlist_events WHERE recu_le < NOW() - (${jours} || ' days')::interval`;
    out.avant = { lignes: avant.lignes, taille_mo: mo(avant.octets) };
    out.a_purger = aPurger.n;

    if (dry) return res.status(200).json({ ...out, info: 'Simulation — rien supprimé. Retire ?dry=1 pour exécuter.' });

    if (aPurger.n > 0) {
      // Filet : les profils LinkedIn utiles sont re-dérivés avant la purge (idempotent)
      try {
        await sql`INSERT INTO linkedin_profils (email, picture, job_title, tagline, company_size, linkedin_url, company_linkedin_url, maj_le)
          SELECT DISTINCT ON (lower(email)) lower(email), brut->>'picture', brut->>'jobTitle', brut->>'tagline',
            brut->>'companySize', brut->>'linkedinUrl', brut->>'companyLinkedinUrl', recu_le
          FROM lemlist_events
          WHERE email IS NOT NULL AND (brut->>'picture' IS NOT NULL OR brut->>'jobTitle' IS NOT NULL OR brut->>'linkedinUrl' IS NOT NULL)
          ORDER BY lower(email), recu_le DESC
          ON CONFLICT (email) DO UPDATE SET
            picture = COALESCE(EXCLUDED.picture, linkedin_profils.picture),
            job_title = COALESCE(EXCLUDED.job_title, linkedin_profils.job_title),
            tagline = COALESCE(EXCLUDED.tagline, linkedin_profils.tagline),
            company_size = COALESCE(EXCLUDED.company_size, linkedin_profils.company_size),
            linkedin_url = COALESCE(EXCLUDED.linkedin_url, linkedin_profils.linkedin_url)`;
        out.profils_preserves = true;
      } catch (e) { out.profils_preserves = 'erreur : ' + String(e.message || e).slice(0, 120); }

      const sup = await sql`DELETE FROM lemlist_events WHERE recu_le < NOW() - (${jours} || ' days')::interval RETURNING id`;
      out.supprimes = sup.length;
      // Récupération de l'espace (VACUUM FULL impossible en transaction → VACUUM simple)
      try { await sql`VACUUM ANALYZE lemlist_events`; out.vacuum = 'ok'; } catch (_) { out.vacuum = 'ignoré'; }
    } else out.supprimes = 0;

    const [apres] = await sql`SELECT COUNT(*)::int AS lignes, pg_total_relation_size('lemlist_events') AS octets FROM lemlist_events`;
    out.apres = { lignes: apres.lignes, taille_mo: mo(apres.octets) };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ erreur: 'Purge impossible', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
