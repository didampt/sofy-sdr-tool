// /api/taches.js — Tâches de rappel des SDR (statut "Rappel demandé")
// GET   → mes tâches non faites (triées par échéance). Admin/superadmin : ?all=1 (toute l'équipe) ou ?sdr=Nom
// POST  {liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel} → créer
//        Anti-doublon : un seul rappel EN ATTENTE par (sdr, fiche). On met à jour + purge les doublons.
// PUT   {id|fiche_cle, sdr?, faite} → marquer faite/non-faite (par fiche : toutes les tâches de cette fiche)
// DELETE{id|fiche_cle, sdr?}        → supprimer (par fiche : toutes les tâches de cette fiche)

import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  const admin = ['admin', 'superadmin'].includes(user.role);

  try {
    if (req.method === 'GET') {
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
      // Anti-doublon : s'il existe déjà un rappel en attente sur cette fiche pour ce SDR, on le met à jour
      if (fiche_cle) {
        const ex = await sql`SELECT id FROM taches WHERE sdr = ${user.nom} AND fiche_cle = ${fiche_cle} AND faite = FALSE ORDER BY id ASC LIMIT 1`;
        if (ex.length) {
          const up = await sql`UPDATE taches SET liste_id = ${liste_id || null}, entreprise_nom = ${entreprise_nom || null}, contact_nom = ${contact_nom || null}, description = ${description || null}, date_rappel = ${date_rappel}, alertee = FALSE WHERE id = ${ex[0].id} RETURNING *`;
          // purge des éventuels doublons déjà présents sur la même fiche
          await sql`DELETE FROM taches WHERE sdr = ${user.nom} AND fiche_cle = ${fiche_cle} AND faite = FALSE AND id <> ${ex[0].id}`;
          return res.status(200).json({ ok: true, tache: up[0], maj: true });
        }
      }
      const r = await sql`
        INSERT INTO taches (sdr, liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel)
        VALUES (${user.nom}, ${liste_id || null}, ${fiche_cle || null}, ${entreprise_nom || null}, ${contact_nom || null}, ${description || null}, ${date_rappel})
        RETURNING *`;
      return res.status(200).json({ ok: true, tache: r[0] });
    }

    if (req.method === 'PUT') {
      const { id, fiche_cle, sdr, faite } = req.body || {};
      const val = faite !== false;
      if (fiche_cle) {
        if (admin && sdr) await sql`UPDATE taches SET faite = ${val} WHERE fiche_cle = ${fiche_cle} AND sdr = ${sdr}`;
        else if (admin) await sql`UPDATE taches SET faite = ${val} WHERE fiche_cle = ${fiche_cle}`;
        else await sql`UPDATE taches SET faite = ${val} WHERE fiche_cle = ${fiche_cle} AND sdr = ${user.nom}`;
        return res.status(200).json({ ok: true });
      }
      if (!id) return res.status(400).json({ erreur: 'id ou fiche_cle requis' });
      if (admin) await sql`UPDATE taches SET faite = ${val} WHERE id = ${id}`;
      else await sql`UPDATE taches SET faite = ${val} WHERE id = ${id} AND sdr = ${user.nom}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id, fiche_cle, sdr } = req.body || {};
      if (fiche_cle) {
        if (admin && sdr) await sql`DELETE FROM taches WHERE fiche_cle = ${fiche_cle} AND sdr = ${sdr}`;
        else if (admin) await sql`DELETE FROM taches WHERE fiche_cle = ${fiche_cle}`;
        else await sql`DELETE FROM taches WHERE fiche_cle = ${fiche_cle} AND sdr = ${user.nom}`;
        return res.status(200).json({ ok: true });
      }
      if (!id) return res.status(400).json({ erreur: 'id ou fiche_cle requis' });
      if (admin) await sql`DELETE FROM taches WHERE id = ${id}`;
      else await sql`DELETE FROM taches WHERE id = ${id} AND sdr = ${user.nom}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non supportée' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String(e.message || e).slice(0, 200) });
  }
}
