// /api/ia-liste-creer.js — Orchestrateur de la "Liste intelligente".
// ARCHITECTURE (validée par diagnostics réels) :
//   Basile source LKI (LinkedIn) = personnes par POSTE + persona + profil LinkedIn.
//   On cherche les PERSONNES directement (pas les entreprises d'abord).
//   Email/téléphone NE sont PAS chez Basile -> récupérés ensuite par le waterfall Sofy (Kaspr part du profile_url).
//
// POST { mode, criteres }
//   mode = 'estimer' -> comptage gratuit : { nb_personnes }
//   mode = 'creer'   -> recherche réelle : { fiches:[...] } au format Sofy (avec LinkedIn, sans email/tel)
//
// Champs réels source LKI : people_first_name, people_last_name, current_job_title,
//   current_job_functions [{function, sub_function}], current_seniority, current_company_name,
//   current_company_profile_url, profile_url, location_city, location_region, location_country_code.

const BASE = 'https://api.basile.cc';

async function basile(path, body, key) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

// Régions LinkedIn correspondant aux DOM (location_region renvoyé par Basile)
const REGIONS_DOM = {
  '971': ['Guadeloupe'],
  '972': ['Martinique'],
  '973': ['Guyane française', 'French Guiana', 'Guyane'],
  '974': ['La Réunion', 'Réunion', 'Reunion'],
  '976': ['Mayotte']
};

// Traduction des critères IA -> filtres Basile (PERSONNES, source LinkedIn)
function filtresPersonnes(c) {
  const f = {};
  if (Array.isArray(c.postes) && c.postes.length) {
    f.current_job_title = { include: c.postes };
  }
  f.location_country_code = { include: Array.isArray(c.pays) && c.pays.length ? c.pays : ['FR'] };
  const zones = Array.isArray(c.zones) ? c.zones : [];
  const veutMetropole = zones.includes('metropole');
  const regionsDom = [];
  for (const z of zones) if (REGIONS_DOM[z]) regionsDom.push(...REGIONS_DOM[z]);
  if (regionsDom.length && !veutMetropole) {
    f.location_region = { include: regionsDom };
  }
  return { filtres: f, veutMetropole, zones };
}

// Mappe un lead Basile (source LKI) -> fiche Sofy
function leadVersFiche(lead) {
  const d = lead.data || lead || {};
  const prenom = d.people_first_name || d.result_first_name || '';
  const nomContact = d.people_last_name || d.result_last_name || '';
  const titre = d.current_job_title || '';
  let persona = '';
  if (Array.isArray(d.current_job_functions) && d.current_job_functions.length) {
    persona = d.current_job_functions.map(x => x.function).filter(Boolean).join(', ');
  }
  const seniorite = d.current_seniority && d.current_seniority !== 'Unknown' ? d.current_seniority : '';
  const linkedinPerso = d.profile_url || null;
  const entreprise = d.current_company_name || '';
  const linkedinEnt = d.current_company_profile_url || null;
  const ville = d.location_city || d.result_city || '';
  const region = d.location_region || '';
  const siren = d.siren || null;

  const contact = {
    prenom, nom: nomContact,
    fonction: titre || persona || '',
    source: 'basile',
    enrich: {}
  };
  if (linkedinPerso) contact.enrich.linkedin = linkedinPerso;

  return {
    nom: entreprise || (prenom + ' ' + nomContact).trim() || 'Sans nom',
    ville,
    code_postal: '',
    region,
    adresse: '',
    naf: null, siren,
    site_web: null,
    linkedin_entreprise: linkedinEnt,
    persona_ia: persona || null,
    seniorite_basile: seniorite || null,
    activite: null, effectif: null, chiffre_affaires: null, nb_etablissements: null,
    dirigeant: null, enseigne: null,
    source: 'basile',
    contacts: [contact],
    _region_brut: region,
    _pays_brut: d.location_country_code || d.result_country_code || ''
  };
}

// Post-filtrage géo : si on cible des DOM précis (sans métropole), garder seulement ces régions
function gardeZone(fiche, veutMetropole, zones) {
  const regionsDom = [];
  for (const z of zones) if (REGIONS_DOM[z]) regionsDom.push(...REGIONS_DOM[z]);
  if (veutMetropole || !regionsDom.length) return true;
  const reg = (fiche._region_brut || '').toLowerCase();
  return regionsDom.some(r => reg.includes(r.toLowerCase()));
}

// Regroupe les contacts par entreprise
function regrouperParEntreprise(fiches) {
  const parNom = new Map();
  for (const f of fiches) {
    const cle = (f.nom || '').toLowerCase().trim();
    if (!parNom.has(cle)) parNom.set(cle, f);
    else parNom.get(cle).contacts.push(...f.contacts);
  }
  return [...parNom.values()];
}

export default async function handler(req, res) {
  const { verifierToken } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const { mode, criteres } = req.body || {};
  if (!criteres || typeof criteres !== 'object') return res.status(400).json({ erreur: 'criteres requis' });

  const { filtres, veutMetropole, zones } = filtresPersonnes(criteres);

  try {
    if (mode === 'estimer') {
      const r = await basile('/people/find', { limit: 1, filters: filtres }, key);
      if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
      return res.status(200).json({
        nb_personnes: r.data?.total || 0,
        nb_entreprises: null,
        nb_contacts_estimes: r.data?.total || 0
      });
    }

    if (mode === 'creer') {
      const r = await basile('/people/find', { limit: 100, filters: filtres }, key);
      if (r.status === 402) return res.status(402).json({ erreur: 'Abonnement Basile requis (pagination)' });
      if (!r.data || r.data.success === false) return res.status(502).json({ erreur: 'Recherche Basile échouée', status: r.status });
      let leads = r.data.leads || [];

      let fiches = leads.map(leadVersFiche)
        .filter(f => f.contacts[0] && f.contacts[0].enrich && f.contacts[0].enrich.linkedin)
        .filter(f => gardeZone(f, veutMetropole, zones));

      fiches = regrouperParEntreprise(fiches);
      fiches.forEach(f => { delete f._region_brut; delete f._pays_brut; });

      return res.status(200).json({ fiches, nb: fiches.length });
    }

    return res.status(400).json({ erreur: 'mode inconnu (estimer|creer)' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur orchestration Basile', detail: String(e.message || e).slice(0, 200) });
  }
}
