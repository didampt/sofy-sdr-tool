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

  const { produit, contact = {}, variables = {}, proprietaire, liste_id } = req.body || {};
  if (!contact.email) return res.status(400).json({ erreur: 'contact.email requis' });

  try {
    // Campagne selon le produit dominant
    let cfg = {};
    if (sql) {
      const rows = await sql`SELECT valeur FROM config WHERE cle = 'lemlist'`;
      cfg = rows.length ? rows[0].valeur : {};
    }
    const campagne = (produit && cfg['camp_' + produit]) || cfg.camp_defaut;
    if (!campagne) {
      return res.status(400).json({ erreur: "Aucune campagne configurée — renseigne les IDs de campagnes Lemlist dans ⚙️ Envois (carte Connexion réelle)" });
    }

    let ownerEmail = null;
    if (sql && proprietaire) {
      const me = await sql`SELECT email_envoi FROM sdrs WHERE nom = ${proprietaire} LIMIT 1`;
      ownerEmail = me.length ? (me[0].email_envoi || null) : null;
    }

    const corps = {
      firstName: contact.prenom || '',
      lastName: contact.nom || '',
      companyName: variables.companyName || '',
      ...variables,
      ...(ownerEmail ? { contactOwner: ownerEmail } : {})
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
    // deduplicate=true n ajoute pas / ne met pas a jour un lead existant -> PATCH pour rafraichir note, LinkedIn et variables
    let maj = false;
    try {
      const { contactOwner, ...corpsMaj } = corps;
      const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64');
      let pr = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(contact.email)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify(corpsMaj)
      });
      maj = pr.ok;
      if (!pr.ok && data._id) {
        pr = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(data._id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': auth },
          body: JSON.stringify(corpsMaj)
        });
        maj = pr.ok;
      }
    } catch (e) { /* la mise a jour ne bloque pas l envoi */ }
    try {
      const cle = contact.email;
      const ent = variables.companyName || '';
      const ctc = [contact.prenom, contact.nom].filter(Boolean).join(' ');
      const sdrTache = proprietaire || user.nom;
      if (sql && cle && sdrTache) {
        const dej = await sql`SELECT id FROM taches WHERE sdr = ${sdrTache} AND fiche_cle = ${cle} AND faite = FALSE LIMIT 1`;
        if (!dej.length) {
          await sql`INSERT INTO taches (sdr, liste_id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel)
            VALUES (${sdrTache}, ${liste_id || null}, ${cle}, ${ent || null}, ${ctc || null}, ${'Rappel - pas de reponse a la sequence ' + (produit || '')}, NOW() + INTERVAL '5 days')`;
        }
      }
      const smsTxt = (req.body && req.body.sms) || '';
      const tel = variables.phone || '';
      if (sql && produit === 'soreach' && tel && smsTxt.trim()) {
        const dejaSms = await sql`SELECT id FROM sms_programmes WHERE email = ${contact.email} AND statut = 'pending' LIMIT 1`;
        if (!dejaSms.length) {
          await sql`INSERT INTO sms_programmes (cle, liste_id, sdr, email, telephone, message, envoyer_le)
            VALUES (${cle}, ${liste_id || null}, ${sdrTache}, ${contact.email}, ${tel}, ${smsTxt.trim()}, NOW() + INTERVAL '7 days')`;
        }
      }
    } catch (e) { /* la programmation ne bloque pas l envoi */ }
    return res.status(200).json({ ok: true, campagne, owner: ownerEmail, lead: data._id || contact.email, maj });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
