// /api/listes.js — Mémoire des listes d'appel
// GET ?q=…           → historique (recherche par nom de liste ou SDR)
// GET ?id=…          → liste complète (pour la rouvrir)
// GET ?criteres=…    → listes existantes avec les MÊMES critères (anti-doublon)
// POST {…}           → sauvegarder une nouvelle liste
// PUT  {id, entreprises} → mettre à jour les entreprises (ex: après analyses GMB)

import { createHash } from 'crypto';
import { sql, ensureSchema, verifierToken } from './db.js';

function hashCriteres(criteres) {
  // Hash stable : on ne garde que les critères de ciblage (pas le nom de liste ni le SDR)
  const c = criteres || {};
  const cle = JSON.stringify({
    naf: [...(c.naf || [])].sort(),
    size: c.size || '',
    emp: c.emp || '',
    ca: c.ca || '',
    jobs: [...(c.jobs || [])].sort(),
    pays: [...(c.pays || [])].sort(),
    ville: (c.ville || '').trim().toLowerCase()
  });
  return createHash('sha256').update(cle).digest('hex').slice(0, 32);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!sql) {
    return res.status(500).json({ erreur: 'Base de données non configurée — créer la base Neon dans Vercel (Storage) puis redéployer' });
  }
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  try {
    // ── Lecture ──
    if (req.method === 'GET') {
      const { id, q, criteres } = req.query;

      if (id) {
        const rows = await sql`SELECT * FROM listes WHERE id = ${parseInt(id)}`;
        if (!rows.length) return res.status(404).json({ erreur: 'Liste introuvable' });
        return res.status(200).json(rows[0]);
      }

      if (criteres) {
        let c;
        try { c = JSON.parse(criteres); } catch { return res.status(400).json({ erreur: 'criteres invalide' }); }
        const h = hashCriteres(c);
        const rows = await sql`SELECT id, nom, sdr, created_at FROM listes WHERE criteres_hash = ${h} ORDER BY created_at DESC LIMIT 3`;
        return res.status(200).json({ existantes: rows });
      }

      const recherche = (q || '').trim();
      const rows = recherche
        ? await sql`SELECT id, nom, sdr, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                    WHERE nom ILIKE ${'%' + recherche + '%'} OR sdr ILIKE ${'%' + recherche + '%'}
                    ORDER BY created_at DESC LIMIT 50`
        : await sql`SELECT id, nom, sdr, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                    ORDER BY created_at DESC LIMIT 50`;
      return res.status(200).json({ listes: rows });
    }

    // ── Sauvegarde ──
    if (req.method === 'POST') {
      const { nom, sdr, criteres, entreprises, credits_estimes } = req.body || {};
      if (!nom || !sdr || !criteres || !Array.isArray(entreprises)) {
        return res.status(400).json({ erreur: 'nom, sdr, criteres et entreprises requis' });
      }
      const h = hashCriteres(criteres);
      const rows = await sql`INSERT INTO listes (nom, sdr, criteres, criteres_hash, entreprises, total, credits_estimes)
        VALUES (${nom}, ${sdr}, ${JSON.stringify(criteres)}, ${h}, ${JSON.stringify(entreprises)}, ${entreprises.length}, ${credits_estimes || 0})
        RETURNING id, created_at`;
      // Rattache les crédits Pappers consommés à l'instant (extraction avant sauvegarde) à cette liste
      try {
        await sql`UPDATE consommations SET liste_id = ${rows[0].id}
                  WHERE sdr = ${user.nom} AND liste_id IS NULL AND api = 'pappers'
                    AND created_at > NOW() - INTERVAL '10 minutes'`;
      } catch (_) {}
      return res.status(200).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
    }

    // ── Mise à jour des entreprises (analyses GMB, enrichissements futurs) ──
    if (req.method === 'PUT') {
      const { id, entreprises, veille, veille_jours } = req.body || {};
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      if (Array.isArray(entreprises)) {
        await sql`UPDATE listes SET entreprises = ${JSON.stringify(entreprises)} WHERE id = ${parseInt(id)}`;
      }
      if (veille !== undefined) {
        const fin = veille ? new Date(Date.now() + (parseInt(veille_jours) || 60) * 24 * 3600 * 1000) : null;
        await sql`UPDATE listes SET veille = ${!!veille}, veille_fin = ${fin} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, veille: !!veille, veille_fin: fin });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur base de données', detail: err.message });
  }
}
