// /api/ia-liste-creer.js — Orchestrateur de la "Liste intelligente".
// DEUX CHEMINS (validés par diagnostics réels) :
//   A) MÉTROPOLE / national  -> recherche PERSONNES par POSTE (result_role + result_country_code).
//   B) ZONE DOM (971..976)   -> ENTREPRISE D'ABORD : companies/find (naf_code + headquarters_postal_code)
//        -> on récupère les SIREN -> people/find (siren + result_is_current) -> dirigeants.
//      Raison : Basile n'a quasi pas de PERSONNES en DOM (test géo), mais beaucoup d'ENTREPRISES.
//      Les filtres region_code/department_code n'existent pas ; la géo fine se fait par CODE POSTAL.
//
// POST { mode, criteres }
//   mode='estimer' -> comptage gratuit (+ échantillon de dirigeants en mode DOM)
//   mode='creer'   -> fiches au format Sofy

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

const DOM = ['971', '972', '973', '974', '976'];

// Codes postaux d'un DOM (ex '971' -> 97100..97199). Basile n'accepte pas les wildcards -> on énumère.
function cpPrefix(p) { const a = []; for (let i = 0; i < 100; i++) a.push(p + String(i).padStart(2, '0')); return a; }

// ---------- PERSONNES (chemin métropole) ----------
// Les 7 macro-secteurs Basile activables (les seuls slugs *_global valides). Filtrent les PERSONNES.
const SECTEURS_BASILE = {
  commerce: 'commerce_global', btp: 'btp_global', transport: 'transport_global',
  hospitality: 'hospitality_global', agriculture: 'agriculture_global',
  finance: 'finance_global', manufacturing: 'manufacturing_global'
};
// Familles de postes -> intitulés FIGÉS (déterministe : même famille => mêmes intitulés => même comptage).
const FAMILLES_POSTE = {
  direction: ['Président', 'Présidente', 'Directeur Général', 'Directrice Générale', 'PDG', 'CEO', 'Chief Executive Officer', 'Fondateur', 'Fondatrice', 'Co-fondateur', 'Gérant', 'Gérante'],
  commercial: ['Directeur Commercial', 'Directrice Commerciale', 'Directeur des Ventes', 'Directrice des Ventes', 'Responsable Commercial', 'Head of Sales', 'VP Sales', 'Sales Director'],
  marketing: ['Directeur Marketing', 'Directrice Marketing', 'Responsable Marketing', 'Chief Marketing Officer', 'CMO', 'Head of Marketing', 'VP Marketing', 'Directeur Marketing Digital'],
  communication: ['Directeur de la Communication', 'Directrice de la Communication', 'Responsable Communication', 'Head of Communications', 'Directeur Communication'],
  digital: ['Directeur Digital', 'Directrice Digital', 'Responsable Digital', 'Chief Digital Officer', 'CDO', 'Head of Digital'],
  relation_client: ['Directeur Relation Client', 'Directrice Relation Client', 'Directeur de la Relation Client', 'Responsable Relation Client', 'Directeur Service Client', 'Responsable Service Client', 'Head of Customer Relations'],
  experience_client: ['Directeur Expérience Client', 'Directrice Expérience Client', "Directeur de l'Expérience Client", 'Chief Customer Officer', 'CCO', 'Head of Customer Experience', 'Customer Experience Director', 'VP Customer Experience'],
  crm: ['Directeur CRM', 'Responsable CRM', 'Head of CRM', 'CRM Manager', 'Directeur Fidélisation'],
  acquisition: ['Directeur Acquisition', 'Responsable Acquisition', 'Head of Acquisition', 'Directeur Marketing Automation', 'Head of Growth', 'Growth Manager']
};
function rolesDepuisFamilles(c) {
  if (Array.isArray(c.familles_poste) && c.familles_poste.length) {
    const out = [];
    for (const fam of c.familles_poste) {
      const arr = FAMILLES_POSTE[String(fam).toLowerCase().trim()];
      if (arr) for (const t of arr) if (!out.includes(t)) out.push(t);
    }
    if (out.length) return out;
  }
  return Array.isArray(c.postes) ? c.postes : []; // repli si pas de familles
}
function filtresPersonnes(c) {
  const f = {};
  const roles = rolesDepuisFamilles(c);
  if (roles.length) f.result_role = { include: roles };
  f.result_country_code = { include: Array.isArray(c.pays) && c.pays.length ? c.pays : ['FR'] };
  const slug = SECTEURS_BASILE[(c.secteur_basile || '').toLowerCase()];
  if (slug) f.activity = { include: [slug] }; // filtre secteur sur les personnes (seul moyen qui marche)
  return f;
}

function leadVersFichePersonne(lead) {
  const d = lead.data || lead || {};
  const prenom = d.people_first_name || d.result_first_name || '';
  const nomContact = d.people_last_name || d.result_last_name || '';
  const titre = d.result_role || d.current_job_title || '';
  let persona = '';
  if (Array.isArray(d.current_job_functions) && d.current_job_functions.length) {
    persona = d.current_job_functions.map(x => x.function).filter(Boolean).join(', ');
  }
  const seniorite = d.current_seniority && d.current_seniority !== 'Unknown' ? d.current_seniority : '';
  const linkedinPerso = d.profile_url || null;
  const entreprise = d.current_company_name || '';
  const linkedinEnt = d.current_company_profile_url || null;
  const ville = d.location_city || d.result_city || '';

  const contact = { prenom, nom: nomContact, fonction: titre || persona || '', source: 'basile', enrich: {} };
  if (linkedinPerso) contact.enrich.linkedin = linkedinPerso;

  return {
    nom: entreprise || (prenom + ' ' + nomContact).trim() || 'Sans nom',
    ville, code_postal: '', region: '', adresse: '', naf: null, siren: d.siren || null,
    site_web: null, linkedin_entreprise: linkedinEnt,
    persona_ia: persona || null, seniorite_basile: seniorite || null,
    activite: null, effectif: null, chiffre_affaires: null, nb_etablissements: null,
    dirigeant: null, enseigne: null, source: 'basile',
    contacts: [contact]
  };
}

// ---------- ENTREPRISES (chemin DOM) ----------
function nafFiltre(c) { return (Array.isArray(c.naf_codes) && c.naf_codes.length) ? { include: c.naf_codes } : null; }

function listeEntreprises(data) { return (data && (data.companies || data.leads || data.results)) || []; }
function lireEntreprise(co) {
  const x = co.data || co || {};
  return {
    siren: x.siren || x.siren_number || null,
    nom: x.company_name || x.name || x.denomination || x.legal_name || '',
    ville: x.headquarters_city || x.city || x.headquarters_locality || '',
    cp: x.headquarters_postal_code || x.postal_code || '',
    naf: x.naf_code || x.naf || x.ape || null
  };
}

const EXCLURE_ROLE = /commissaire aux comptes|commissaire|suppl[ée]ant|^autre$/i;

// Rang de priorité d'un mandataire (0 = plus haut) pour choisir LE dirigeant principal d'une entreprise.
function rangDirigeant(r) {
  r = (r || '').toLowerCase();
  if (/p-?dg|président directeur général/.test(r)) return 0;
  if (/président/.test(r)) return 1;
  if (/g[ée]rant/.test(r)) return 2;
  if (/directeur g[ée]n[ée]ral|directrice g[ée]n[ée]rale|^dg$/.test(r)) return 3;
  if (/directeur|directrice/.test(r)) return 4;
  return 8;
}
// Nombre de fiches demandé (clamp 1..100, défaut 20).
function capContacts(c) { const n = parseInt(c && c.nb_contacts, 10); return (n && n > 0) ? Math.min(n, 100) : 20; }

// Garde UN seul dirigeant (le mieux classé) par entreprise.
function unParEntreprise(people) {
  const byCo = new Map();
  for (const pf of people) { const k = (pf.nom || '').toLowerCase().trim(); if (!byCo.has(k)) byCo.set(k, []); byCo.get(k).push(pf); }
  const out = [];
  for (const [, arr] of byCo) { arr.sort((x, y) => rangDirigeant(x._role) - rangDirigeant(y._role)); out.push(arr[0]); }
  return out;
}

function dirigeantVersFiche(lead, infoSiren) {
  const d = lead.data || lead || {};
  const prenom = d.people_first_name || d.result_first_name || '';
  const nomContact = d.people_last_name || d.result_last_name || '';
  const role = d.result_role || d.current_job_title || d.mandate_role || 'Dirigeant';
  const linkedinPerso = d.profile_url || null;
  const siren = d.siren || (infoSiren && infoSiren.siren) || null;
  const info = infoSiren || {};
  const entreprise = info.nom || d.current_company_name || '';

  const contact = { prenom, nom: nomContact, fonction: role, source: 'basile', enrich: {} };
  if (linkedinPerso) contact.enrich.linkedin = linkedinPerso;

  return {
    nom: entreprise || (prenom + ' ' + nomContact).trim() || 'Sans nom',
    ville: info.ville || '', code_postal: info.cp || '', region: '', adresse: '',
    naf: info.naf || null, siren, site_web: null, linkedin_entreprise: null,
    persona_ia: null, seniorite_basile: null,
    activite: null, effectif: null, chiffre_affaires: null, nb_etablissements: null,
    dirigeant: null, enseigne: null, source: 'basile',
    contacts: [contact],
    _role: role
  };
}

// Récupère des entreprises DOM (naf + code postal) et collecte SIREN + infos. cap = nb max de SIREN.
async function collecterSiren(domPrefixes, naf, key, capSiren, limitParDom, sirenExclus) {
  sirenExclus = sirenExclus || new Set();
  const sirens = []; const infoBySiren = {}; let totalEnt = 0;
  for (let i = 0; i < domPrefixes.length; i++) {
    if (sirens.length >= capSiren) break;
    const f = { headquarters_postal_code: { include: cpPrefix(domPrefixes[i]) } };
    if (naf) f.naf_code = naf;
    const r = await basile('/companies/find', { limit: limitParDom, filters: f }, key);
    if (r.data && r.data.total != null) totalEnt += r.data.total;
    for (const co of listeEntreprises(r.data)) {
      const e = lireEntreprise(co);
      const sn = e.siren ? String(e.siren).replace(/\D/g, '') : '';
      if (e.siren && !infoBySiren[e.siren] && !sirenExclus.has(sn)) { infoBySiren[e.siren] = e; sirens.push(e.siren); }
      if (sirens.length >= capSiren) break;
    }
  }
  return { sirens, infoBySiren, totalEnt };
}

// people/find par paquets de SIREN -> dirigeants (current), hors commissaires.
async function dirigeantsParSiren(sirens, infoBySiren, key, capFiches) {
  let out = [];
  const taille = 30;
  for (let i = 0; i < sirens.length; i += taille) {
    if (out.length >= capFiches) break;
    const part = sirens.slice(i, i + taille);
    const r = await basile('/people/find', { limit: 100, filters: { siren: { include: part }, result_is_current: true } }, key);
    const leads = (r.data && r.data.leads) || [];
    for (const l of leads) {
      const d = l.data || l || {};
      const fiche = dirigeantVersFiche(l, infoBySiren[d.siren]);
      if (EXCLURE_ROLE.test(fiche._role)) continue;
      out.push(fiche);
      if (out.length >= capFiches) break;
    }
  }
  return out;
}

function regrouperParEntreprise(fiches) {
  const parNom = new Map();
  for (const f of fiches) {
    const cle = (f.nom || '').toLowerCase().trim() || ('x' + Math.random());
    if (!parNom.has(cle)) parNom.set(cle, f);
    else {
      const exist = parNom.get(cle);
      const dejaNoms = new Set(exist.contacts.map(c => (c.prenom + ' ' + c.nom).toLowerCase()));
      for (const c of f.contacts) { const k = (c.prenom + ' ' + c.nom).toLowerCase(); if (!dejaNoms.has(k)) { exist.contacts.push(c); dejaNoms.add(k); } }
    }
  }
  return [...parNom.values()];
}

export default async function handler(req, res) {
  const { verifierToken, sql } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const { mode, criteres } = req.body || {};
  if (!criteres || typeof criteres !== 'object') return res.status(400).json({ erreur: 'criteres requis' });

  const zones = Array.isArray(criteres.zones) ? criteres.zones : [];
  const veutMetropole = zones.includes('metropole');
  const domPrefixes = zones.filter(z => DOM.includes(z));
  const companyFirst = domPrefixes.length > 0 && !veutMetropole;
  const naf = nafFiltre(criteres);

  try {
    // ========================= CHEMIN DOM (entreprise d'abord) =========================
    if (companyFirst) {
      // SIREN déjà présents dans des listes existantes -> exclus pour ne sortir que du NEUF
      let sirenExclus = new Set();
      try {
        const rowsEx = sql ? await sql`SELECT entreprises FROM listes WHERE archivee = FALSE` : [];
        for (const row of rowsEx) { const ents = Array.isArray(row.entreprises) ? row.entreprises : []; for (const e of ents) { if (e.siren) sirenExclus.add(String(e.siren).replace(/\D/g, '')); } }
      } catch (e) {}
      if (mode === 'estimer') {
        // Comptage entreprises (1 appel/DOM, le 1er ramène un échantillon)
        let totalEnt = 0; let sampleSirens = []; let sampleInfo = {};
        for (let i = 0; i < domPrefixes.length; i++) {
          const f = { headquarters_postal_code: { include: cpPrefix(domPrefixes[i]) } };
          if (naf) f.naf_code = naf;
          const r = await basile('/companies/find', { limit: i === 0 ? 20 : 1, filters: f }, key);
          if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
          if (r.data && r.data.total != null) totalEnt += r.data.total;
          if (i === 0) {
            for (const co of listeEntreprises(r.data)) {
              const e = lireEntreprise(co);
              const sn = e.siren ? String(e.siren).replace(/\D/g, '') : '';
              if (e.siren && !sampleInfo[e.siren] && !sirenExclus.has(sn)) { sampleInfo[e.siren] = e; sampleSirens.push(e.siren); }
              if (sampleSirens.length >= 15) break;
            }
          }
        }
        // Échantillon de dirigeants (validation de la chaîne, gratuit)
        let echantillon = [];
        if (sampleSirens.length) {
          let dirigeants = await dirigeantsParSiren(sampleSirens, sampleInfo, key, 40);
          if (criteres.un_par_entreprise !== false) dirigeants = unParEntreprise(dirigeants);
          echantillon = dirigeants.slice(0, 6).map(f => ({
            nom: ((f.contacts[0].prenom || '') + ' ' + (f.contacts[0].nom || '')).trim() || '—',
            role: f.contacts[0].fonction || '—',
            entreprise: f.nom || '—',
            ville: f.ville || ''
          }));
        }
        return res.status(200).json({
          mode_recherche: 'entreprise',
          nb_entreprises: totalEnt,
          nb_personnes: null,
          echantillon_dirigeants: echantillon,
          _filtres: { naf_code: naf || { include: [] }, zones_dom: domPrefixes }
        });
      }

      if (mode === 'creer') {
        const cap = capContacts(criteres);
        const unParEnt = criteres.un_par_entreprise !== false; // défaut : 1 dirigeant principal par entreprise
        const { sirens, infoBySiren } = await collecterSiren(domPrefixes, naf, key, Math.max(cap * 3, 60), 100, sirenExclus);
        if (!sirens.length) return res.status(200).json({ fiches: [], nb: 0, mode_recherche: 'entreprise', message: 'Aucune nouvelle entreprise (toutes déjà présentes dans tes listes).' });
        let people = await dirigeantsParSiren(sirens, infoBySiren, key, Math.max(cap * 4, 80));
        if (unParEnt) people = unParEntreprise(people);
        people = people.slice(0, cap);
        let fiches = regrouperParEntreprise(people);
        fiches.forEach(f => { delete f._role; });
        return res.status(200).json({ fiches, nb: fiches.length, mode_recherche: 'entreprise' });
      }
      return res.status(400).json({ erreur: 'mode inconnu (estimer|creer)' });
    }

    // ========================= CHEMIN MÉTROPOLE (personne par poste) =========================
    const filtres = filtresPersonnes(criteres);
    if (mode === 'estimer') {
      const r = await basile('/people/find', { limit: 1, filters: filtres }, key);
      if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
      return res.status(200).json({
        mode_recherche: 'personne',
        nb_personnes: r.data?.total || 0,
        nb_entreprises: null,
        _filtres: filtres,
        _status: r.status,
        _ok: r.data?.success !== false
      });
    }
    if (mode === 'creer') {
      const r = await basile('/people/find', { limit: 100, filters: filtres }, key);
      if (r.status === 402) return res.status(402).json({ erreur: 'Abonnement Basile requis (pagination)' });
      if (!r.data || r.data.success === false) return res.status(502).json({ erreur: 'Recherche Basile échouée', status: r.status });
      const capP = capContacts(criteres);
      let fiches = (r.data.leads || []).map(leadVersFichePersonne)
        .filter(f => f.contacts[0] && f.contacts[0].enrich && f.contacts[0].enrich.linkedin);
      fiches = regrouperParEntreprise(fiches).slice(0, capP);
      return res.status(200).json({ fiches, nb: fiches.length, mode_recherche: 'personne' });
    }
    return res.status(400).json({ erreur: 'mode inconnu (estimer|creer)' });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur orchestration Basile', detail: String(e.message || e).slice(0, 200) });
  }
}
