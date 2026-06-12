// /api/hubspot.js — "RDV pris" → contact + note (synthèse) + transaction pour l'AE
// POST {contact:{email,prenom,nom,mobile,fonction,linkedin}, entreprise:{nom,site,naf,nb_etablissements},
//       note, deal:{nom, produit}}
// Pipeline / étape / propriétaire : config 'hubspot' {pipeline, stage, owner}

import { sql, ensureSchema, verifierToken } from './db.js';

const HS = 'https://api.hubapi.com';

async function hs(chemin, methode, token, corps) {
  const r = await fetch(HS + chemin, {
    method: methode,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: corps ? JSON.stringify(corps) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(500).json({ erreur: 'HUBSPOT_API_KEY manquante dans Vercel (jeton d\'app privée)' });
  if (sql) await ensureSchema();

  const { contact = {}, entreprise = {}, note = '', deal = {} } = req.body || {};
  if (!contact.email && !(contact.prenom && contact.nom)) {
    return res.status(400).json({ erreur: 'contact.email ou prénom+nom requis' });
  }

  try {
    let cfg = {};
    if (sql) {
      const rows = await sql`SELECT valeur FROM config WHERE cle = 'hubspot'`;
      cfg = rows.length ? rows[0].valeur : {};
    }

    // ── 1. Contact : recherche par email, sinon création ──
    let contactId = null, dejaPresent = false;
    if (contact.email) {
      const cherche = await hs('/crm/v3/objects/contacts/search', 'POST', token, {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contact.email }] }],
        properties: ['email'], limit: 1
      });
      if (cherche.ok && cherche.data.total > 0) { contactId = cherche.data.results[0].id; dejaPresent = true; }
    }
    const proprietes = {
      email: contact.email || undefined,
      firstname: contact.prenom || undefined,
      lastname: contact.nom || undefined,
      mobilephone: contact.mobile || undefined,
      jobtitle: contact.fonction || undefined,
      website: entreprise.site || undefined,
      company: entreprise.nom || undefined,
      hs_lead_status: 'OPEN'
    };
    Object.keys(proprietes).forEach(k => proprietes[k] === undefined && delete proprietes[k]);
    if (!contactId) {
      const crea = await hs('/crm/v3/objects/contacts', 'POST', token, { properties: proprietes });
      if (!crea.ok) return res.status(502).json({ erreur: 'HubSpot (contact)', detail: crea.data.message || JSON.stringify(crea.data).slice(0, 200) });
      contactId = crea.data.id;
    } else {
      await hs(`/crm/v3/objects/contacts/${contactId}`, 'PATCH', token, { properties: proprietes });
    }

    // ── 2. Note (synthèse d'appel + signal) ──
    if (note) {
      await hs('/crm/v3/objects/notes', 'POST', token, {
        properties: { hs_note_body: note.slice(0, 9000), hs_timestamp: Date.now() },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
      });
    }

    // ── 3. Transaction (RDV pris → AE) ──
    let dealId = null, avertissement = null;
    if (cfg.pipeline && cfg.stage) {
      const props = {
        dealname: deal.nom || `${entreprise.nom || 'Prospect'} — via Sofy Scrap`,
        pipeline: cfg.pipeline,
        dealstage: cfg.stage
      };
      if (cfg.owner) props.hubspot_owner_id = cfg.owner;
      const dl = await hs('/crm/v3/objects/deals', 'POST', token, {
        properties: props,
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }]
      });
      if (!dl.ok) avertissement = 'Transaction non créée : ' + (dl.data.message || '').slice(0, 150);
      else dealId = dl.data.id;
    } else {
      avertissement = 'Pipeline/étape non configurés (⚙️ Envois) — contact + note créés, transaction ignorée';
    }

    return res.status(200).json({ ok: true, contactId, dealId, dejaPresent, avertissement });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
