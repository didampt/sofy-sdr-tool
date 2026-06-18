// /api/enrich-lock.js — Verrou global d'enrichissement par liste (anti-double-lancement).
// POST { liste_id, action, total?, faites?, cout? }
//   action = 'prendre'   → tente de poser le verrou (échoue si déjà actif sur cette liste)
//   action = 'rafraichir'→ met à jour la progression (faites/total/cout) + prouve que l'onglet est vivant
//   action = 'liberer'   → retire le verrou (fin d'enrichissement)
// GET  ?liste_id=... → état du verrou (pour afficher la barre dans un autre onglet)

import { verifierToken, prendreVerrouEnrich, rafraichirVerrouEnrich, libererVerrouEnrich, etatVerrouEnrich } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  try {
    if (req.method === 'GET') {
      const listeId = parseInt(req.query.liste_id);
      if (!listeId) return res.status(400).json({ erreur: 'liste_id requis' });
      const etat = await etatVerrouEnrich(listeId);
      return res.status(200).json(etat);
    }

    if (req.method === 'POST') {
      const { liste_id, action = 'prendre', total, faites, cout } = req.body || {};
      const listeId = parseInt(liste_id);
      if (!listeId) return res.status(400).json({ erreur: 'liste_id requis' });

      if (action === 'liberer') {
        await libererVerrouEnrich(listeId);
        return res.status(200).json({ ok: true });
      }
      if (action === 'rafraichir') {
        await rafraichirVerrouEnrich(listeId, faites, cout);
        return res.status(200).json({ ok: true });
      }
      // 'prendre'
      const r = await prendreVerrouEnrich(listeId, user.nom, total);
      return res.status(200).json(r);
    }

    return res.status(405).json({ erreur: 'Méthode non supportée' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur verrou', detail: String(e.message || e).slice(0, 200) });
  }
}
