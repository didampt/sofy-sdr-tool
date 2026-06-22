// /api/fiche-par-numero.js — Retrouve la fiche (liste + entreprise) correspondant à un numéro.
// Utilisé par le popup d'appel pour afficher « Ouvrir la fiche » si le prospect existe dans une liste.
// Pré-filtre SQL (LIKE sur les 9 derniers chiffres) puis scan précis des champs téléphone.

import { verifierToken, sql } from './db.js';

const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  const numero = (req.method === 'POST' ? ((req.body || {}).numero) : req.query.numero) || '';
  const d9 = cle9(numero);
  if (d9.length < 6) return res.status(200).json({ match: null });

  try {
    // Pré-filtre : seules les listes dont le JSON contient cette séquence de chiffres
    const rows = await sql`
      SELECT id, nom, sdr, entreprises FROM listes
      WHERE archivee = FALSE AND entreprises::text LIKE ${'%' + d9 + '%'}
      ORDER BY created_at DESC LIMIT 25`;

    for (const l of rows) {
      const ents = l.entreprises || [];
      for (const e of ents) {
        const tels = [];
        if (e.gmb && e.gmb.telephone) tels.push(e.gmb.telephone);
        if (e.ia && e.ia.telephone) tels.push(e.ia.telephone);
        if (e.telephone_google) tels.push(e.telephone_google);
        if (e.enrich && e.enrich.telephone) tels.push(e.enrich.telephone);
        if (Array.isArray(e.contacts)) for (const c of e.contacts) { if (c && c.enrich && c.enrich.telephone) tels.push(c.enrich.telephone); }
        if (e.dirigeant && e.dirigeant.enrich && e.dirigeant.enrich.telephone) tels.push(e.dirigeant.enrich.telephone);

        if (tels.some(t => cle9(t) === d9)) {
          const nom = e.enseigne_ia || e.enseigne || (e.gmb && e.gmb.nom) || e.nom || '(sans nom)';
          return res.status(200).json({ match: { liste_id: l.id, liste_nom: l.nom, sdr: l.sdr, entreprise: nom } });
        }
      }
    }
    return res.status(200).json({ match: null });
  } catch (e) {
    return res.status(500).json({ erreur: 'Recherche fiche échouée', detail: String(e.message || e).slice(0, 200) });
  }
}
