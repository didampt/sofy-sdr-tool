// /api/ia-liste-creer.js — Orchestrateur de la "Liste intelligente".
// Traduit les critères IA en filtres Basile, compte (gratuit) ou recherche, et renvoie des fiches Sofy.
//
// POST { mode, criteres }
//   mode = 'estimer' → comptage gratuit : renvoie { nb_entreprises, nb_contacts_estimes }
//   mode = 'creer'   → recherche réelle : renvoie { fiches:[...] } au format Sofy
//
// Workflow Basile en 2 temps :
//   1) /companies/find  → entreprises du secteur (NAF/activité + effectif + géo)
//   2) /people/find     → contacts dans ces entreprises (employer = noms exacts + postes)
//
// v1 : une page de résultats (100 max), pas de pagination massive (évite les timeouts Vercel 60s).

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

// ── Traduction des critères IA → filtres Basile (entreprises) ──
function filtresEntreprises(c) {
  const f = { company_ceased: false };
  // Activité : on privilégie les codes NAF si présents, sinon l'activité libre (plus tolérante)
  if (Array.isArray(c.naf_codes) && c.naf_codes.length) {
    f.naf_code = { include: c.naf_codes };
  } else if (c.activite_libre) {
    // À défaut de NAF, on tente l'activité en texte (Basile gère une taxonomie d'activité)
    f.activity = { include: [c.activite_libre] };
  }
  // Effectif
  if (c.effectif_min != null && c.effectif_min !== '') f.headcount_min = parseInt(c.effectif_min) || undefined;
  if (c.effectif_max != null && c.effectif_max !== '') f.headcount_max = parseInt(c.effectif_max) || undefined;
  // Géo : DOM précis → préfixes de codes postaux. Métropole seule → pas de filtre CP (base déjà FR).
  const zones = Array.isArray(c.zones) ? c.zones : [];
  const domPrefixes = { '971': '971', '972': '972', '973': '973', '974': '974', '976': '976' };
  const cps = [];
  for (const z of zones) {
    if (domPrefixes[z]) {
      // Énumère les CP du DOM : préfixe + 00..99 (ex 974 → 97400..97499). Basile matche le code exact.
      const base = domPrefixes[z];
      for (let i = 0; i <= 99; i++) cps.push(base + String(i).padStart(2, '0'));
    }
  }
  // Si SEULS des DOM sont demandés (pas de métropole), on filtre par ces CP.
  const veutMetropole = zones.includes('metropole');
  if (cps.length && !veutMetropole) {
    f.headquarters_postal_code = { include: cps };
  }
  // Si métropole + DOM : on ne filtre pas (toute la France), le tri se fait en post-filtrage.
  return { filtres: f, veutMetropole, zonesDom: zones.filter(z => domPrefixes[z]) };
}

// ── Traduction des critères IA → filtres Basile (personnes) ──
function filtresPersonnes(c, nomsEntreprises) {
  const f = { result_is_current: true, hide_legal_entities: true };
  if (Array.isArray(c.postes) && c.postes.length) f.result_role = { include: c.postes };
  if (Array.isArray(c.seniorites) && c.seniorites.length) f.current_seniority = { include: c.seniorites };
  if (Array.isArray(c.pays) && c.pays.length) f.result_country_code = { include: c.pays };
  // Rattachement aux entreprises trouvées : match EXACT (noms entre guillemets) → zéro faux positif
  if (Array.isArray(nomsEntreprises) && nomsEntreprises.length) {
    f.employer = { include: nomsEntreprises.map(n => `"${n}"`) };
  }
  return f;
}

// ── Post-filtrage géo : garder/exclure les DOM selon la demande ──
function gardeZone(cp, veutMetropole, zonesDom) {
  if (!cp) return true; // pas de CP → on garde (prudence)
  const estDom = /^97[1-6]/.test(String(cp));
  if (estDom) {
    // On garde si ce DOM précis était demandé
    const prefix = String(cp).slice(0, 3);
    return zonesDom.includes(prefix);
  }
  // CP métropole → on garde si la métropole était demandée
  return veutMetropole;
}

// ── Mappe un lead Basile → fiche Sofy ──
function leadVersFiche(lead) {
  // IMPORTANT : Basile imbrique tout dans lead.data (vérifié via diagnostic réel).
  const d = lead.data || lead || {};
  // Entreprise
  const nom = d.current_company_name || d.legal_name || d.company_name || '';
  // Contact (personne)
  const prenom = d.result_first_name || d.first_name || '';
  const nomContact = d.result_last_name || d.last_name || '';
  // Poste : présent surtout sur les sources LinkedIn/GMB (peut être absent en source Legal)
  const fonction = d.result_role || d.current_title || d.title || d.job_title || '';
  // Coordonnées : Basile = identité ; email/tel souvent absents (→ enrichissement waterfall Sofy ensuite)
  const email = d.result_email || d.email || d.work_email || null;
  const tel = d.result_phone || d.phone || d.mobile_phone || null;
  const linkedin = d.result_linkedin_url || d.linkedin_url || d.linkedin || null;
  // Localisation : côté people = result_city ; côté entreprise = headquarters_*
  const ville = d.result_city || d.headquarters_city || d.company_city || d.city || '';
  const cp = d.headquarters_postal_code || d.result_postal_code || d.company_postal_code || d.postal_code || '';
  const adresse = d.headquarters_address || d.company_address || '';
  const siteWeb = d.company_website || d.website || null;
  const linkedinEnt = d.company_linkedin_url || null;
  const siren = d.siren || null;
  const naf = d.naf_code || d.company_naf || null;

  const contact = {
    prenom, nom: nomContact, fonction,
    source: 'basile',
    enrich: {}
  };
  if (email) contact.enrich.email = email;
  if (tel) contact.enrich.telephone = tel;
  if (linkedin) contact.enrich.linkedin = linkedin;

  return {
    nom: nom || `${prenom} ${nomContact}`.trim() || 'Sans nom',
    ville, code_postal: cp,
    adresse,
    naf, siren,
    site_web: siteWeb,
    linkedin_entreprise: linkedinEnt,
    activite: null, effectif: null, chiffre_affaires: null, nb_etablissements: null,
    dirigeant: null, enseigne: null,
    source: 'basile',
    contacts: [contact],
    _cp_brut: cp
  };
}

// ── Regroupe les contacts par entreprise (un lead = un contact ; on fusionne par société) ──
function regrouperParEntreprise(fiches) {
  const parNom = new Map();
  for (const f of fiches) {
    const cle = (f.nom || '').toLowerCase().trim();
    if (!parNom.has(cle)) {
      parNom.set(cle, f);
    } else {
      // Même entreprise : on ajoute le contact à la fiche existante
      const existante = parNom.get(cle);
      existante.contacts.push(...f.contacts);
    }
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

  const { filtres: fEnt, veutMetropole, zonesDom } = filtresEntreprises(criteres);

  try {
    // ── MODE ESTIMER : comptage gratuit ──
    if (mode === 'estimer') {
      // Compte les entreprises (limit:1, gratuit)
      const ent = await basile('/companies/find', { limit: 1, filters: fEnt }, key);
      if (ent.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
      const nbEnt = ent.data?.total || 0;
      // Estimation des contacts : on compte aussi côté personnes (sans employer, juste postes+pays)
      // pour donner un ordre de grandeur. (L'employer exact nécessiterait d'avoir les noms.)
      const fPersGlobal = filtresPersonnes(criteres, null);
      const pers = await basile('/people/find', { limit: 1, filters: fPersGlobal }, key);
      const nbPersGlobal = pers.data?.total || 0;
      // Estimation prudente : min entre (contacts globaux) et (entreprises × ~2 contacts attendus)
      const estimContacts = Math.min(nbPersGlobal, nbEnt * 2) || nbEnt;
      return res.status(200).json({
        nb_entreprises: nbEnt,
        nb_contacts_estimes: estimContacts
      });
    }

    // ── MODE CREER : recherche réelle (1 page) ──
    if (mode === 'creer') {
      // 1) Entreprises (1 page de 100 max)
      const ent = await basile('/companies/find', { limit: 100, filters: fEnt }, key);
      if (ent.status === 402) return res.status(402).json({ erreur: 'Abonnement Basile requis' });
      if (!ent.data || ent.data.success === false) return res.status(502).json({ erreur: 'Recherche entreprises échouée' });
      let entreprises = ent.data.leads || [];
      // Post-filtrage géo (métropole/DOM) sur le code postal de l'entreprise
      entreprises = entreprises.filter(e => {
        const d = e.data || e || {};
        const cp = d.headquarters_postal_code || d.postal_code || d.company_postal_code || '';
        return gardeZone(cp, veutMetropole, zonesDom);
      });
      // Récupère les noms d'entreprises pour le rattachement des contacts (dans e.data)
      const noms = entreprises.map(e => { const d = e.data || e || {}; return d.legal_name || d.company_name || d.name; }).filter(Boolean).slice(0, 100);
      if (!noms.length) return res.status(200).json({ fiches: [] });

      // 2) Contacts dans ces entreprises (employer = noms exacts + postes)
      const fPers = filtresPersonnes(criteres, noms);
      const pers = await basile('/people/find', { limit: 100, filters: fPers }, key);
      const leads = (pers.data && pers.data.leads) ? pers.data.leads : [];

      // 3) Mappe les leads → fiches, puis post-filtrage géo + regroupement par entreprise
      let fiches = leads.map(leadVersFiche)
        .filter(f => gardeZone(f._cp_brut, veutMetropole, zonesDom));
      fiches = regrouperParEntreprise(fiches);
      // Nettoie le champ technique
      fiches.forEach(f => { delete f._cp_brut; });

      return res.status(200).json({ fiches, nb: fiches.length });
    }

    return res.status(400).json({ erreur: 'mode inconnu (estimer|creer)' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur orchestration Basile', detail: String(e.message || e).slice(0, 200) });
  }
}
