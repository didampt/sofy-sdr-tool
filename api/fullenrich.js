// /api/fullenrich.js — Niveau 2 du waterfall : FullEnrich (cascade 15+ sources)
// POST {contact:{prenom,nom}, entreprise:{nom,site}} → soumet + attend (~jusqu'à 100s)
// GET  ?enrichment_id=…                              → re-vérifie un enrichissement en attente
// Récupère : email (si Dropcontact a échoué) + numéro de MOBILE (la spécialité de FullEnrich).

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

export const config = { maxDuration: 120 };

const attendre = (ms) => new Promise(r => setTimeout(r, ms));

function mapperResultat(d) {
  // d = premier élément de datas[] ; structure défensive (le schéma FullEnrich peut évoluer)
  const c = d.contact || d || {};
  const emails = c.emails || c.email || [];
  const listeEmails = Array.isArray(emails) ? emails : [emails];
  const bonEmail = listeEmails
    .map(e => (typeof e === 'string' ? { email: e } : e))
    .filter(e => e && e.email)
    .sort((a, b) => {
      const score = (x) => /valid|deliverable|safe/i.test(x.status || x.qualification || '') ? 0 : 1;
      return score(a) - score(b);
    })[0] || null;

  const phones = c.phones || c.phone || [];
  const listePhones = (Array.isArray(phones) ? phones : [phones])
    .map(p => (typeof p === 'string' ? { number: p } : p))
    .filter(p => p && (p.number || p.phone));
  const mobile = listePhones.find(p => /mobile|cell/i.test(p.type || '')) || listePhones[0] || null;

  return {
    email: bonEmail ? bonEmail.email : null,
    email_statut: bonEmail ? (bonEmail.status || bonEmail.qualification || '') : null,
    telephone: mobile ? (mobile.number || mobile.phone) : null,
    linkedin: c.linkedin_url || c.linkedin || null,
    source: 'fullenrich'
  };
}

async function recupererResultat(enrichmentId, apiKey) {
  const r = await fetch(`https://app.fullenrich.com/api/v1/contact/enrich/bulk/${enrichmentId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { erreur: data.message || data.error || `HTTP ${r.status}` };
  const statut = (data.status || '').toUpperCase();
  if (statut === 'FINISHED' || statut === 'COMPLETED' || statut === 'DONE') {
    const d = (data.datas && data.datas[0]) || (data.data && data.data[0]) || null;
    return { pret: true, resultat: d ? mapperResultat(d) : { email: null, telephone: null, source: 'fullenrich' } };
  }
  if (statut === 'FAILED' || statut === 'ERROR') return { erreur: 'FullEnrich : enrichissement en échec' };
  return { pret: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const apiKey = process.env.FULLENRICH_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'FULLENRICH_API_KEY manquante dans Vercel' });

  try {
    if (req.method === 'GET') {
      const { enrichment_id } = req.query;
      if (!enrichment_id) return res.status(400).json({ erreur: 'enrichment_id requis' });
      const etat = await recupererResultat(enrichment_id, apiKey);
      if (etat.erreur) return res.status(502).json({ erreur: etat.erreur });
      if (!etat.pret) return res.status(200).json({ pending: true, enrichment_id });
      return res.status(200).json({ ok: true, ...etat });
    }

    if (req.method === 'POST') {
      const { contact = {}, entreprise = {} } = req.body || {};
      if (!contact.nom || !entreprise.nom) {
        return res.status(400).json({ erreur: 'contact.nom et entreprise.nom requis' });
      }

      const corps = {
        name: `sofy-scrap ${contact.prenom || ''} ${contact.nom}`.trim(),
        datas: [{
          firstname: contact.prenom || '',
          lastname: contact.nom,
          company_name: entreprise.nom,
          ...(entreprise.site ? { domain: entreprise.site } : {}),
          enrich_fields: ['contact.emails', 'contact.phones']
        }]
      };

      const soumission = await fetch('https://app.fullenrich.com/api/v1/contact/enrich/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(corps)
      });
      const sub = await soumission.json().catch(() => ({}));
      const enrichmentId = sub.enrichment_id || sub.id;
      if (!soumission.ok || !enrichmentId) {
        return res.status(502).json({ erreur: 'FullEnrich (soumission)', detail: sub.message || sub.error || JSON.stringify(sub).slice(0, 200) });
      }
      await loggerConso(user, 'fullenrich', 1, req.body?.liste_id);

      // FullEnrich cascade 15+ sources : jusqu'à ~100 s d'attente ici, puis le front reprend
      for (let i = 0; i < 14; i++) {
        await attendre(i === 0 ? 10000 : 7000);
        const etat = await recupererResultat(enrichmentId, apiKey);
        if (etat.erreur) return res.status(502).json({ erreur: etat.erreur });
        if (etat.pret) return res.status(200).json({ ok: true, ...etat });
      }
      return res.status(200).json({ pending: true, enrichment_id: enrichmentId });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
