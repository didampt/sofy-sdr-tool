// /api/enrich.js — Enrichissement Dropcontact (niveau 1 du waterfall)
// POST {contact:{prenom,nom}, entreprise:{nom,siren}} → soumet + attend le résultat (jusqu'à ~40s)
// GET  ?request_id=…                                  → re-vérifie un enrichissement en attente
// Récupère : email pro vérifié, profil LinkedIn, fonction (classification IA), site web, téléphone.

import { verifierToken, loggerConso, limiteAtteinte, majSoldeApi } from './db.js';

export const config = { maxDuration: 60 };

const attendre = (ms) => new Promise(r => setTimeout(r, ms));

function mapperResultat(d) {
  // d = premier élément de data[] renvoyé par Dropcontact
  const emails = Array.isArray(d.email) ? d.email : (d.email ? [{ email: d.email, qualification: '' }] : []);
  const meilleur = emails.find(e => (e.qualification || '').includes('nominative')) || emails[0] || null;
  return {
    email: meilleur ? meilleur.email : null,
    email_qualification: meilleur ? (meilleur.qualification || '') : null,
    linkedin: d.linkedin || null,
    fonction: d.job || null,
    site_web: d.website || null,
    telephone: d.phone || d.mobile_phone || null,
    civilite: d.civility || null,
    source: 'dropcontact'
  };
}

async function recupererResultat(requestId, apiKey) {
  const r = await fetch(`https://api.dropcontact.com/v1/enrich/all/${requestId}`, {
    headers: { 'X-Access-Token': apiKey }
  });
  const data = await r.json().catch(() => ({}));
  if (data.success === true && Array.isArray(data.data) && data.data.length) {
    return { pret: true, resultat: mapperResultat(data.data[0]), credits: data.credits_left ?? null };
  }
  if (data.error) return { erreur: data.error };
  return { pret: false, raison: data.reason || 'En cours de traitement' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  const apiKey = process.env.DROPCONTACT_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'DROPCONTACT_API_KEY manquante dans Vercel' });

  try {
    // ── Re-vérification d'une demande en attente ──
    if (req.method === 'GET') {
      const { request_id } = req.query;
      if (!request_id) return res.status(400).json({ erreur: 'request_id requis' });
      const etat = await recupererResultat(request_id, apiKey);
      if (etat.erreur) return res.status(502).json({ erreur: 'Dropcontact : ' + etat.erreur });
      if (!etat.pret) return res.status(200).json({ pending: true, request_id });
      if (etat.credits != null) await majSoldeApi('dropcontact', etat.credits);
      return res.status(200).json({ ok: true, ...etat });
    }

    // ── Nouvelle demande ──
    if (req.method === 'POST') {
      const { contact = {}, entreprise = {} } = req.body || {};
      if (!contact.nom || !entreprise.nom) {
        return res.status(400).json({ erreur: 'contact.nom et entreprise.nom requis' });
      }

      const corps = {
        data: [{
          first_name: contact.prenom || '',
          last_name: contact.nom,
          company: entreprise.nom,
          ...(entreprise.siren ? { num_siren: String(entreprise.siren) } : {}),
          ...(entreprise.site ? { website: entreprise.site } : {})
        }],
        siren: true,
        language: 'fr'
      };

      const lim = await limiteAtteinte(user);
      if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });
      const soumission = await fetch('https://api.dropcontact.com/v1/enrich/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Access-Token': apiKey },
        body: JSON.stringify(corps)
      });
      const sub = await soumission.json().catch(() => ({}));
      if (!soumission.ok || !sub.request_id) {
        return res.status(502).json({ erreur: 'Dropcontact (soumission)', detail: sub.error || sub.reason || JSON.stringify(sub) });
      }

      await loggerConso(user, 'dropcontact', 1, req.body?.liste_id);
      // Attente du résultat : jusqu'à ~38 secondes (Dropcontact prend 15-45s)
      for (let i = 0; i < 8; i++) {
        await attendre(i === 0 ? 8000 : 4500);
        const etat = await recupererResultat(sub.request_id, apiKey);
        if (etat.erreur) return res.status(502).json({ erreur: 'Dropcontact : ' + etat.erreur });
        if (etat.pret) { if (etat.credits != null) await majSoldeApi('dropcontact', etat.credits); return res.status(200).json({ ok: true, ...etat }); }
      }
      // Pas encore prêt : le front re-vérifiera avec request_id
      return res.status(200).json({ pending: true, request_id: sub.request_id });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
