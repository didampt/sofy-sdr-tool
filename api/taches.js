// /api/taches.js — Tâches de rappel des SDR (statut "Rappel demandé")
// GET            → mes tâches non faites (triées par échéance). Admin/superadmin : ?sdr=Nom pour filtrer
// POST {liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel} → créer
// PUT  {id, faite}  → marquer faite (au clic sur "Ouvrir la fiche")

import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  try {
    if (req.method === 'GET') {
      const admin = ['admin', 'superadmin'].includes(user.role);
      const filtreSdr = (req.query && req.query.sdr) ? req.query.sdr : null;
      let rows;
      if (admin && filtreSdr) {
        rows = await sql`SELECT * FROM taches WHERE faite = FALSE AND sdr = ${filtreSdr} ORDER BY date_rappel ASC NULLS LAST`;
      } else if (admin && req.query && req.query.all === '1') {
        rows = await sql`SELECT * FROM taches WHERE faite = FALSE ORDER BY date_rappel ASC NULLS LAST`;
      } else {
        rows = await sql`SELECT * FROM taches WHERE faite = FALSE AND sdr = ${user.nom} ORDER BY date_rappel ASC NULLS LAST`;
      }
      return res.status(200).json({ taches: rows });
    }

    if (req.method === 'POST') {
      const { liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel } = req.body || {};
      if (!date_rappel) return res.status(400).json({ erreur: 'date_rappel requis' });
      const r = await sql`
        INSERT INTO taches (sdr, liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel)
        VALUES (${user.nom}, ${liste_id || null}, ${fiche_cle || null}, ${entreprise_nom || null}, ${contact_nom || null}, ${description || null}, ${date_rappel})
        RETURNING *`;
      return res.status(200).json({ ok: true, tache: r[0] });
    }

    if (req.method === 'PUT') {
      const { id, faite } = req.body || {};
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      // Un SDR ne peut marquer que ses propres tâches (admin : toutes)
      const admin = ['admin', 'superadmin'].includes(user.role);
      if (admin) {
        await sql`UPDATE taches SET faite = ${faite !== false} WHERE id = ${id}`;
      } else {
        await sql`UPDATE taches SET faite = ${faite !== false} WHERE id = ${id} AND sdr = ${user.nom}`;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non supportée' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String(e.message || e).slice(0, 200) });
  }
}
