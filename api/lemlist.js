// /api/lemlist.js — "Pas de décroché" → le lead part en séquence Lemlist
// POST {liste_id, produit, contact:{email,prenom,nom}, variables:{…}}
// La campagne est choisie selon le produit dominant (config 'lemlist' : camp_soview/camp_soconnect/camp_soreach/camp_defaut)

import { sql, ensureSchema, verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'LEMLIST_API_KEY manquante dans Vercel' });
  if (sql) await ensureSchema();

  const { produit, contact = {}, variables = {} } = req.body || {};
  if (!contact.email) return res.status(400).json({ erreur: 'contact.email requis' });

  try {
    // Campagne selon le produit dominant
    let cfg = {};
    if (sql) {
      const rows = await sql`SELECT valeur FROM config WHERE cle = 'lemlist'`;
      cfg = rows.length ? rows[0].valeur : {};
    }
    const campagne = (cfg.routage !== false && produit && cfg['camp_' + produit]) || cfg.camp_defaut;
    if (!campagne) {
      return res.status(400).json({ erreur: "Aucune campagne configurée — renseigne les IDs de campagnes Lemlist dans ⚙️ Envois (carte Connexion réelle)" });
    }

    const corps = {
      firstName: contact.prenom || '',
      lastName: contact.nom || '',
      companyName: variables.companyName || '',
      ...variables
    };
    const r = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(contact.email)}?deduplicate=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(':' + apiKey).toString('base64')
      },
      body: JSON.stringify(corps)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ erreur: 'Lemlist', detail: data.message || data.error || JSON.stringify(data).slice(0, 200) });
    }
    return res.status(200).json({ ok: true, campagne, lead: data._id || contact.email });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
