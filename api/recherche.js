// /api/recherche.js — Recherche avancée (6e carte, 22/09/2026) : le « Sales Nav » de SofyScrap.
// Onglet PROSPECTS uniquement (l'onglet Entreprises du front passe par /api/estimer + /api/liste,
// la tuyauterie Pappers existante). Moteur : Basile people/find, mêmes briques que la Liste
// intelligente V2 (concepts activity résolus par suggest, company_headcount, curseur, dédup
// LinkedIn) mais piloté par des FILTRES MANUELS posés par le SDR — plus une recherche par
// « listes de comptes » SofyScrap (filtre siren, l'équivalent des account lists Sales Nav).
//
// POST { mode, filtres, nb?, curseur?, exclus_slugs? }
//   mode='apercu'  -> { total, total_sans_effectif, concepts_labels, leads:[{...,doublon}] } (gratuit)
//   mode='generer' -> { fiches, nb, curseur, epuise, profils_parcourus } (fiches au format Sofy)
//   filtres = { naf_codes:[], concept_ids:[], postes:[], familles:[], decideur:bool,
//               effectif_min, effectif_max, listes_ids:[], exclure_extraits:bool }
// Règles maison : comptage/aperçu gratuits ; tout filtre qui écarte de l'inconnu est MESURÉ
// (total_sans_effectif) ; les doublons sont signalés à l'aperçu et écartés à la génération.

import { verifierToken, loggerConso, limiteAtteinte, sql } from './db.js';
import {
  basile, FAMILLES_POSTE, resoudreConcepts, leadVersFichePersonne,
  slugLinkedin, linkedinsConnus, regrouperParEntreprise
} from './ia-liste-creer.js';

export const config = { maxDuration: 120 };

// « N'importe quel décideur » en mode recherche = l'union des intitulés de TOUTES les familles
// (déterministe, même logique figée que la Liste intelligente).
function rolesDecideur() {
  const out = [];
  for (const fam of Object.keys(FAMILLES_POSTE)) for (const t of FAMILLES_POSTE[fam]) if (!out.includes(t)) out.push(t);
  return out;
}

function rolesDepuisFiltres(f) {
  if (f.decideur) return rolesDecideur();
  const out = [];
  for (const fam of (Array.isArray(f.familles) ? f.familles : [])) {
    const arr = FAMILLES_POSTE[String(fam).toLowerCase().trim()];
    if (arr) for (const t of arr) if (!out.includes(t)) out.push(t);
  }
  for (const p of (Array.isArray(f.postes) ? f.postes : [])) {
    const t = String(p || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 80);
}

// SIREN des listes SofyScrap sélectionnées (équivalent « account lists » Sales Nav).
async function sirensDesListes(ids) {
  if (!sql || !Array.isArray(ids) || !ids.length) return [];
  const propres = ids.map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 10);
  if (!propres.length) return [];
  const sirens = [];
  try {
    const rows = await sql`SELECT entreprises FROM listes WHERE id = ANY(${propres})`;
    const vus = new Set();
    for (const row of rows) {
      for (const e of (Array.isArray(row.entreprises) ? row.entreprises : [])) {
        const s = String(e.siren || '').replace(/\D/g, '');
        if (s.length === 9 && !vus.has(s)) { vus.add(s); sirens.push(s); }
      }
    }
  } catch (_) {}
  return sirens.slice(0, 300); // plafond : 10 lots de 30 côté people/find
}

// Construit les filtres Basile communs (hors siren, géré par lots).
function filtresBasile(f, conceptIds, roles) {
  // Pays de la personne (result_country_code) — FR par défaut ; multi possible (BE, CH, LU…),
  // Basile étant une base française, un autre pays peut légitimement compter très peu.
  const pays = (Array.isArray(f.pays) ? f.pays : []).map(p => String(p || '').trim().toUpperCase()).filter(p => /^[A-Z]{2}$/.test(p)).slice(0, 6);
  const b = { result_country_code: { include: pays.length ? pays : ['FR'] }, hide_legal_entities: true };
  if (roles.length) b.result_role = { include: roles };
  // Intitulés EXCLUS (wireframe v2 : postes ciblés Inclure/Exclure façon Sales Nav)
  const rolesEx = (Array.isArray(f.postes_exclus) ? f.postes_exclus : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 30);
  if (rolesEx.length) { b.result_role = b.result_role || {}; b.result_role.exclude = rolesEx; }
  if (conceptIds.length) b.activity = { include: conceptIds };
  // Ville de la PERSONNE (result_city, multi-source) — le seul filtre géo qui existe sur
  // people/find (region/département n'existent pas ; result_postal_code est Legal-only et
  // exclurait LinkedIn). Pour une zone entière : filtre « lieu du siège » (voie SIREN).
  const villes = (Array.isArray(f.villes) ? f.villes : []).map(v => String(v || '').trim()).filter(Boolean).slice(0, 15);
  if (villes.length) b.result_city = { include: villes };
  // La personne (wireframe v2) : prénom / nom / entreprise actuelle (employer exact+contains,
  // même pattern que personas.js — multi-source, marche aussi en voie directe)
  const prenom = String(f.prenom || '').trim(), nomP = String(f.nom_personne || '').trim();
  if (prenom) b.result_first_name = { include: [prenom] };
  if (nomP) b.result_last_name = { include: [nomP] };
  // ⚠️ MESURÉ (matrice Didier 22/09 nuit) : employer traite plusieurs valeurs en ET, pas en OU
  // (exact 3 · contains 39 517 · les deux 3) → UNE seule valeur. Sans guillemets = contains
  // (large, façon Sales Nav) ; le SDR peut taper "X" entre guillemets pour l'exact.
  const ent = String(f.entreprise || '').trim();
  if (ent) b.employer = { include: [ent] };
  const effMin = parseInt(f.effectif_min, 10), effMax = parseInt(f.effectif_max, 10);
  if (effMin > 0 || effMax > 0) {
    b.company_headcount = {};
    if (effMin > 0) b.company_headcount['>='] = effMin;
    if (effMax > 0) b.company_headcount['<='] = effMax;
  }
  return b;
}

// Filtres LINKEDIN-ONLY (langue, ancienneté au poste) : appliqués UNIQUEMENT aux requêtes de la
// source LinkedIn — un filtre LKI-only sur la source registre la viderait (doc Basile : activer
// un filtre d'une source exclut l'autre). Jamais validés en prod → le comptage 💼 dira s'ils
// mordent ; s'ils étaient ignorés, ils n'enlèvent rien (comportement dégradé sans casse).
const LANGUES = { 'Français': 'French', 'Anglais': 'English', 'Espagnol': 'Spanish', 'Allemand': 'German' };
function extrasLki(f, b) {
  const o = { ...b };
  const lg = LANGUES[String(f.langue || '').trim()];
  if (lg) o.languages = { include: [lg] };
  const anc = String(f.anciennete || '').trim();
  if (f.nouveau_poste || anc === '<1') o.current_tenure_years = { '<': 1 };
  else if (anc === '1-3') o.current_tenure_years = { '>=': 1, '<=': 3 };
  else if (anc === '3+') o.current_tenure_years = { '>=': 3 };
  return o;
}

const LOT_SIREN = 30;
const ENT_PAR_PAGE = 210; // entreprises balayées par page d'aperçu voie SIREN (7 lots de 30)

// ── Voie « entreprises → SIREN → personnes » pour la part LinkedIn ──────────────────────────
// MATRICE PROD DU 22/09 (test Didier, 68.31Z × Directeur Commercial) : le filtre `activity`
// (concepts naf:) est REGISTRE-ONLY (lki=0) et `result_role` avec un intitulé précis est
// LINKEDIN-ONLY (legal=0, le registre n'a que des mandats) → secteur NAF × poste précis = 0
// PAR CONSTRUCTION en voie directe. La seule voie qui atteint les salariés LinkedIn d'un
// secteur NAF : companies/find (naf_code marche sur les ENTREPRISES) → SIREN → people/find
// par lots de SIREN (qui ramène bien les salariés LinkedIn — validé sur GBH : 757, 100 % LKI).
function nafDepuisConcepts(ids) {
  return ids.filter(x => x.startsWith('naf:')).map(x => x.slice(4)).slice(0, 4);
}
function sansActivity(o) { const c = { ...o }; delete c.activity; return c; }

// ── Wireframe v2 (23/09) : type d'entreprise + lieu du siège (inclure/exclure), appliqués aux
// ENTREPRISES de la voie SIREN. legal_category = catégorie juridique INSEE ; le mapping
// libellés → préfixes niveau 1/2 est SPÉCULATIF (jamais testé en prod) → garde anti-filtre-
// fantôme dans le handler : si le comptage entreprises tombe à 0 avec le filtre, on l'ignore
// et on le dit (`types_ignores`). Régions par NOM canonique (le code region_code est ⛔ ignoré,
// cf. openapi Basile) ; DOM par préfixes de code postal ; villes par headquarters_city.
// ⚠️ MESURÉ (matrice Didier 22/09 nuit) : legal_category attend des codes INSEE NIVEAU 3
// (4 chiffres — ['5710','5720','5499','5498'] → 46 775 ✓) ; préfixes et libellés donnent 0.
// 2e leçon (bandeau 🏷️ en prod) : énumérer 500 codes 00-99 vide AUSSI le comptage (limite de
// taille d'include quelque part au-dessus de 100 valeurs) → listes des VRAIS codes de la
// nomenclature INSEE (les gros du parc en tête) ; la garde types_ignores reste le filet.
const CJ_SARL = ['5499', '5498', '5410', '5415', '5422', '5426', '5430', '5431', '5432', '5442', '5443', '5451', '5453', '5454', '5455', '5458', '5459', '5460', '5470', '5485'];
const CJ_SA_CA = ['5599', '5505', '5510', '5515', '5520', '5522', '5525', '5530', '5531', '5532', '5542', '5543', '5546', '5547', '5548', '5551', '5552', '5553', '5554', '5555', '5558', '5559', '5560', '5570', '5585'];
const CJ_SA_DIR = ['5699', '5605', '5610', '5615', '5620', '5622', '5625', '5630', '5631', '5632', '5642', '5643', '5646', '5647', '5648', '5651', '5652', '5653', '5654', '5655', '5658', '5659', '5660', '5670', '5685'];
const CJ_SAS = ['5710', '5720', '5770', '5785', '5800'];
const TYPES_ENTREPRISE = {
  'Société commerciale': [...CJ_SARL, ...CJ_SA_CA, ...CJ_SA_DIR, ...CJ_SAS],
  'Société cotée en bourse': [...CJ_SA_CA, ...CJ_SA_DIR],
  'Société civile': ['6540', '6541', '6542', '6543', '6544', '6551', '6554', '6558', '6560', '6561', '6562', '6563', '6564', '6565', '6566', '6567', '6568', '6569', '6571', '6572', '6573', '6574', '6575', '6576', '6577', '6578', '6585', '6588', '6589', '6595', '6596', '6597', '6598', '6599', '6521', '6532', '6533', '6534', '6535', '6536', '6537', '6538', '6539'],
  'À but non lucratif': ['9220', '9210', '9221', '9222', '9223', '9224', '9230', '9240', '9260', '9300'],
  'Société de personnes': ['5202', '5203', '5306', '5307', '5308', '5309', '5370', '5385'],
  'Indépendant / EI': ['1000'],
  'Administration publique': ['4110', '4120', '4130', '4140', '4150', '4160', '7210', '7220', '7225', '7229', '7230', '7343', '7344', '7346', '7348', '7364', '7366', '7371', '7372', '7379', '7381', '7382', '7383', '7384', '7385', '7389', '7410', '7490']
};
const REGIONS_NOMS = ['Auvergne-Rhône-Alpes', 'Bourgogne-Franche-Comté', 'Bretagne', 'Centre-Val de Loire', 'Corse', 'Grand Est', 'Hauts-de-France', 'Île-de-France', 'Normandie', 'Nouvelle-Aquitaine', 'Occitanie', 'Pays de la Loire', "Provence-Alpes-Côte d'Azur"];
const DOM_CP = { 'Guadeloupe': '971', 'Martinique': '972', 'Guyane': '973', 'Réunion': '974', 'Mayotte': '976' };
function cpsDePrefixe(p) { const a = []; for (let i = 0; i < 100; i++) a.push(p + String(i).padStart(2, '0')); return a; }
function filtresEntreprises(filtres) {
  const f = { company_ceased: false };
  // Tranches d'effectif cochées → headcount_min/max sur les ENTREPRISES balayées (Legal + LKI) :
  // la voie SIREN ne balaye plus que des boîtes de la bonne taille (au lieu de compter sur le
  // seul company_headcount côté personnes, qui filtrait APRÈS un balayage dilué).
  const eMin = parseInt(filtres.effectif_min, 10), eMax = parseInt(filtres.effectif_max, 10);
  if (eMin > 0) f.headcount_min = eMin;
  if (eMax > 0) f.headcount_max = eMax;
  // Type d'entreprise → legal_category en codes niveau 3 énumérés (cf. TYPES_ENTREPRISE)
  const cats = [];
  for (const t of (Array.isArray(filtres.types_entreprise) ? filtres.types_entreprise : [])) {
    for (const c of (TYPES_ENTREPRISE[t] || [])) if (!cats.includes(c)) cats.push(c);
  }
  if (cats.length) f.legal_category = { include: cats };
  // Lieux du siège : {valeur, mode:'inclure'|'exclure'} — régions (nom canonique), DOM (CP), villes
  const regIn = [], regEx = [], cpIn = [], cpEx = [], villeIn = [], villeEx = [];
  for (const l of (Array.isArray(filtres.lieux) ? filtres.lieux : []).slice(0, 12)) {
    const v = String((l && l.valeur) || '').trim(); if (!v) continue;
    const ex = l.mode === 'exclure';
    if (v === 'France métropolitaine') { REGIONS_NOMS.forEach(r => (ex ? regEx : regIn).push(r)); continue; }
    if (REGIONS_NOMS.includes(v)) { (ex ? regEx : regIn).push(v); continue; }
    if (DOM_CP[v]) { cpsDePrefixe(DOM_CP[v]).forEach(c => (ex ? cpEx : cpIn).push(c)); continue; }
    (ex ? villeEx : villeIn).push(v);
  }
  if (regIn.length || regEx.length) { f.region = {}; if (regIn.length) f.region.include = regIn; if (regEx.length) f.region.exclude = regEx; }
  if (cpIn.length || cpEx.length) { f.headquarters_postal_code = {}; if (cpIn.length) f.headquarters_postal_code.include = cpIn; if (cpEx.length) f.headquarters_postal_code.exclude = cpEx; }
  if (villeIn.length || villeEx.length) { f.headquarters_city = {}; if (villeIn.length) f.headquarters_city.include = villeIn; if (villeEx.length) f.headquarters_city.exclude = villeEx; }
  return f;
}

// Entreprises du secteur : par CONCEPTS UNIFIÉS (`activity` sur companies/find est documenté
// multi-source « le meilleur filtre secteur » — il couvre les entreprises taguées LinkedIn/Google
// qui n'ont pas le bon NAF), avec repli naf_code si `activity` ne rend rien (garde anti-filtre-
// fantôme, jamais validé en prod sur companies). Retour Didier 22/09 nuit : « automobile » (concept
// LinkedIn) ne pesait RIEN sur le périmètre entreprises → 338 entreprises au lieu du secteur réel.
async function sirensParNaf(nafs, key, limit, token, extra, concepts) {
  const filtreSecteur = (concepts && concepts.length)
    ? { activity: { include: concepts } }
    : { naf_code: { include: nafs } };
  const body = { limit, filters: { ...filtreSecteur, company_ceased: false, ...(extra || {}) } };
  if (token) body.paginationToken = token;
  const r = await basile('/companies/find', body, key);
  const d = r.data || {};
  const sirens = [];
  for (const co of (d.companies || d.leads || d.results || [])) {
    const x = co.data || co || {};
    const s = String(x.siren || x.siren_number || '').replace(/\D/g, '');
    if (s.length === 9 && !sirens.includes(s)) sirens.push(s);
  }
  return { sirens, next: (d.pagination && d.pagination.nextToken) || null, total: d.total || 0 };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const { mode, filtres = {}, nb = 50, curseur = null, exclus_slugs = [], apercu_suite = null } = req.body || {};

  // ── Mode matrice (superadmin) : countOnly Basile arbitraire — la boucle de validation prod
  // du 22/09 (languages ✓, tenure ✓, exclude géo ✓, legal_category ✗ préfixes). limit forcé
  // à 1, aucun lead renvoyé : gratuit et sans fuite de données.
  if (mode === 'debug_count') {
    if (user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au superadmin' });
    const path = req.body.path === '/companies/find' ? '/companies/find' : '/people/find';
    const r = await basile(path, { limit: 1, filters: req.body.filters || {} }, key);
    const d = r.data || {};
    return res.status(200).json({ path, total: d.total ?? null, success: d.success !== false, brut: d.success === false ? d : undefined });
  }
  if (mode !== 'apercu' && mode !== 'generer') return res.status(400).json({ erreur: 'mode inconnu (apercu|generer)' });

  try {
    // Concepts secteur : ids déjà choisis par le SDR (autocomplete), sinon résolus depuis les NAF.
    let conceptIds = (Array.isArray(filtres.concept_ids) ? filtres.concept_ids : [])
      .map(x => String(x || '').trim()).filter(x => x && !x.startsWith('concept:')).slice(0, 10);
    let conceptLabels = Array.isArray(filtres.concept_labels) ? filtres.concept_labels.slice(0, 10) : [];
    if (!conceptIds.length && Array.isArray(filtres.naf_codes) && filtres.naf_codes.length) {
      const r = await resoudreConcepts({ naf_codes: filtres.naf_codes }, key);
      conceptIds = r.ids; conceptLabels = r.labels;
    }
    // ÉLARGISSEMENT BIDIRECTIONNEL : un concept naf: n'indexe que le REGISTRE, un concept
    // lki:/gmb: n'indexe que LinkedIn/Google — constaté en prod 22/09 dans les deux sens
    // (naf:45.11Z + « Directeur Commercial » → 0 ; lki:Collection Agencies seul → 2 profils et
    // 🏛️ registre 0). Dès qu'un des deux mondes manque dans la sélection, chaque concept est
    // élargi en ses équivalents via activity-suggest interrogé par le LIBELLÉ (la requête par
    // code ne renvoie que le naf:), en union OR.
    const aLkiGmb = conceptIds.some(x => x.startsWith('lki:') || x.startsWith('gmb:'));
    const aNaf = conceptIds.some(x => x.startsWith('naf:'));
    if (conceptIds.length && (!aLkiGmb || !aNaf)) {
      const vus = new Set(conceptIds);
      for (let i = 0; i < Math.min(conceptIds.length, 4); i++) {
        // Libellé sans le préfixe « 45.11Z – » ; repli sur la fin de l'id si le libellé manque
        const brut = String(conceptLabels[i] || '').replace(/^[\d.]{4,8}[A-Z]?\s*[–-]\s*/, '').trim();
        const q = brut || String(conceptIds[i]).replace(/^[a-z]+:/, '');
        try {
          const r = await fetch('https://api.basile.cc/companies/activity-suggest?q=' + encodeURIComponent(q), { headers: { 'Authorization': key } });
          const d = await r.json().catch(() => null);
          for (const s of (((d || {}).suggestions) || [])) {
            if (!s || !s.value || s.type === 'concept') continue;
            const sid = String(s.value);
            if (vus.has(sid)) continue;
            vus.add(sid); conceptIds.push(sid); conceptLabels.push(String(s.label || sid));
          }
        } catch (_) {}
      }
      conceptIds = conceptIds.slice(0, 14); conceptLabels = conceptLabels.slice(0, 14);
    }
    const roles = rolesDepuisFiltres(filtres);
    let sirens = await sirensDesListes(filtres.listes_ids);
    // SIREN passés directement (aperçu « décideurs des entreprises trouvées » de l'onglet
    // Entreprises : /api/estimer?avec_sirens=1 fournit les SIREN frais de sa page mesurée).
    if (!sirens.length && Array.isArray(filtres.sirens)) {
      sirens = filtres.sirens.map(s => String(s || '').replace(/\D/g, '')).filter(s => s.length === 9).slice(0, 120);
    }
    const aVilles = Array.isArray(filtres.villes) && filtres.villes.some(v => String(v || '').trim());
    const aPersonne = !!(String(filtres.prenom || '').trim() || String(filtres.nom_personne || '').trim() || String(filtres.entreprise || '').trim());
    if (!roles.length && !conceptIds.length && !sirens.length && !aVilles && !aPersonne) {
      return res.status(400).json({ erreur: 'Ajoute au moins un filtre (secteur, poste, ville ou liste de comptes) — sans quoi la recherche couvrirait toute la France.' });
    }
    const base = filtresBasile(filtres, conceptIds, roles);
    // Part LinkedIn par la voie « entreprises → SIREN → personnes » dès qu'un secteur NAF est
    // posé sans SIREN explicites : la voie directe activity×role est structurellement vide
    // (matrice du 22/09). S'il existe des concepts lki: on tente quand même la voie directe en
    // PLUS ? Non : la voie SIREN couvre aussi ces cas (les entreprises du NAF portent leurs
    // salariés) — plus simple et cohérent. Les concepts lki:/gmb: restent utiles au comptage
    // registre ? Non plus (activity=Legal-only ≠ lki:). On garde activity pour le REGISTRE
    // (concepts naf:) et la voie SIREN pour LINKEDIN.
    const nafsConcepts = nafDepuisConcepts(conceptIds);
    // La voie SIREN s'active dès qu'un SECTEUR est posé (concepts unifiés OU codes NAF) : avant,
    // un concept purement LinkedIn (lki:) n'ouvrait pas la voie entreprises → périmètre amputé.
    const lkiParSiren = !sirens.length && (conceptIds.length > 0 || nafsConcepts.length > 0);
    // Filtres de la voie SIREN côté personnes : tout SAUF activity (Legal-only, redondant),
    // PLUS les filtres LinkedIn-only (langue, ancienneté — wireframe v2)
    const baseLkiSiren = extrasLki(filtres, sansActivity(avecSource(base, 'lki')));
    // Filtres ENTREPRISES de la voie SIREN (type d'entreprise, lieux du siège) avec garde :
    // si legal_category (mapping spéculatif) vide le comptage, on le retire et on le signale.
    const extraEnt = filtresEntreprises(filtres);
    let typesIgnores = false;
    let secteurConcepts = conceptIds.slice(0, 10); // essayé d'abord ; vidé si activity ne rend rien
    async function sirensGarde(limit, token) {
      let r = await sirensParNaf(nafsConcepts, key, limit, token, extraEnt, secteurConcepts);
      // Garde n°1 : `activity` sur companies ignoré/vide → repli naf_code (concepts naf: seuls)
      if (!token && r.total === 0 && secteurConcepts.length && nafsConcepts.length) {
        r = await sirensParNaf(nafsConcepts, key, limit, null, extraEnt, null);
        if (r.total > 0) secteurConcepts = [];
      }
      // Garde n°2 : legal_category (types d'entreprise) vide le comptage → retiré + signalé
      if (!token && r.total === 0 && extraEnt.legal_category) {
        const sans = { ...extraEnt }; delete sans.legal_category;
        r = await sirensParNaf(nafsConcepts, key, limit, null, sans, secteurConcepts.length ? secteurConcepts : null);
        if (r.total > 0) { typesIgnores = true; delete extraEnt.legal_category; }
      }
      return r;
    }

    // Source des contacts : 'lki' (profils LinkedIn seuls), 'legal' (dirigeants du registre),
    // 'deux' (défaut : LinkedIn D'ABORD, registre en complément). Sans ça, « N'importe quel
    // décideur » ne sortait QUE des gérants du registre — leurs intitulés exacts (Président,
    // Gérant) matchent en masse et Basile les sert en premier (retour Didier 22/09).
    const source = (filtres.source === 'lki' || filtres.source === 'legal') ? filtres.source : 'deux';
    function avecSource(b, s) {
      const o = { ...b };
      if (s === 'lki') o.with_linkedin_profile = true;
      if (s === 'legal') o.with_legal_data = true;
      return o;
    }

    // Un appel people/find (comptage limit 1 ou page) avec, en mode listes, un lot de SIREN.
    async function trouver(extra, limit, token) {
      const body = { limit, filters: { ...base, ...extra } };
      if (token) body.paginationToken = token;
      return basile('/people/find', body, key);
    }

    // ── APERÇU : total + transparence effectif + 20 profils par appel, doublons signalés.
    //    PAGINÉ : `apercu_suite` (renvoyé par l'appel précédent) donne la page suivante —
    //    {phase:'siren', lot:N} en mode SIREN, {phase:'lki'|'legal', token} en mode filtres
    //    (LinkedIn d'abord, puis le registre). Les comptages ne sont faits qu'au 1er appel. ──
    if (mode === 'apercu') {
      const suite = (apercu_suite && typeof apercu_suite === 'object') ? apercu_suite : null;
      let total = null, totalSansEffectif = null, leadsBruts = [], totalLki = null, totalLegal = null;
      let prochaineSuite = null;
      if (sirens.length) {
        const nbLots = Math.ceil(sirens.length / LOT_SIREN);
        const lot0 = (suite && suite.phase === 'siren' && suite.lot > 0) ? Math.min(suite.lot, nbLots - 1) : 0;
        if (!suite) {
          // 1er appel : total = somme des lots (comptages limit 1, gratuits)
          total = 0;
          for (let li = 0; li < nbLots; li++) {
            const r = await trouver({ siren: { include: sirens.slice(li * LOT_SIREN, (li + 1) * LOT_SIREN) } }, 1);
            if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
            if (r.data && r.data.success !== false) total += r.data.total || 0;
          }
        }
        // Page = UN lot de 30 entreprises (jusqu'à 100 personnes, on en montre 20)
        const rL = await trouver({ siren: { include: sirens.slice(lot0 * LOT_SIREN, (lot0 + 1) * LOT_SIREN) } }, 100);
        if (rL.data && rL.data.success !== false) leadsBruts = rL.data.leads || [];
        if (lot0 + 1 < nbLots) prochaineSuite = { phase: 'siren', lot: lot0 + 1 };
      } else {
        const phase0 = suite ? suite.phase : (source === 'legal' ? 'legal' : 'lki');
        let nbEntSecteur = null, lkiPartiel = false, nbEntBalayees = null;
        let lotDepart = null; // premier lot de SIREN avec des personnes (comptage ci-dessous)
        if (!suite) {
          // Comptages, une seule fois. Part LinkedIn : voie directe (sans secteur NAF) ou voie
          // SIREN (comptage sur les 90 premières entreprises du secteur — partiel mais VRAI).
          const rC2 = await basile('/people/find', { limit: 1, filters: avecSource(base, 'legal') }, key);
          if (rC2.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
          totalLegal = (rC2.data && rC2.data.total) || 0;
          if (lkiParSiren) {
            const ent = await sirensGarde(ENT_PAR_PAGE, null);
            nbEntSecteur = ent.total; lkiPartiel = !!ent.next;
            nbEntBalayees = ent.sirens.length; // vrai nombre (Basile peut plafonner la page)
            totalLki = 0;
            for (let i = 0; i < ent.sirens.length; i += LOT_SIREN) {
              const rc = await basile('/people/find', { limit: 1, filters: { ...baseLkiSiren, siren: { include: ent.sirens.slice(i, i + LOT_SIREN) } } }, key);
              const n = (rc.data && rc.data.success !== false) ? (rc.data.total || 0) : 0;
              totalLki += n;
              // 1re page servie = le PREMIER lot qui a des personnes (les 30 premières entreprises
              // d'un secteur dilué n'ont souvent AUCUN lead → l'aperçu se cachait, retour Didier)
              if (n > 0 && lotDepart === null) lotDepart = i / LOT_SIREN;
            }
          } else {
            const rC1 = await basile('/people/find', { limit: 1, filters: extrasLki(filtres, avecSource(base, 'lki')) }, key);
            totalLki = (rC1.data && rC1.data.total) || 0;
          }
          total = source === 'lki' ? totalLki : source === 'legal' ? totalLegal : totalLki + totalLegal;
          if (base.company_headcount && !lkiParSiren) {
            const sans = source === 'legal' ? avecSource(base, 'legal') : extrasLki(filtres, avecSource(base, 'lki')); delete sans.company_headcount;
            const r2 = await basile('/people/find', { limit: 1, filters: sans }, key);
            if (r2.data && r2.data.total != null) totalSansEffectif = r2.data.total;
          }
        }
        // Page de leads sur la phase courante
        async function pageLegal(token) {
          const body = { limit: 20, filters: avecSource(base, 'legal') };
          if (token) body.paginationToken = token;
          const rP = await basile('/people/find', body, key);
          if (!rP.data || rP.data.success === false) return false;
          leadsBruts = rP.data.leads || [];
          const next = (rP.data.pagination && rP.data.pagination.nextToken) || null;
          prochaineSuite = next ? { phase: 'legal', token: next } : null;
          return true;
        }
        if (phase0 === 'legal') {
          if (!await pageLegal(suite ? suite.token : null) && !suite) return res.status(502).json({ erreur: 'Recherche Basile échouée' });
        } else if (lkiParSiren) {
          // Page LinkedIn = un lot de 30 entreprises du secteur (déterministe : même page
          // companies/find rechargée via entToken, puis lot N)
          const entToken = suite ? (suite.entToken || null) : null;
          let lot = suite ? (suite.lot || 0) : (lotDepart != null ? lotDepart : 0);
          const ent = await sirensGarde(ENT_PAR_PAGE, entToken);
          const nbLots = Math.ceil(ent.sirens.length / LOT_SIREN);
          // Saute les lots sans lead (≤ 4 essais par appel — pages « vides » supprimées)
          for (let essais = 0; lot < nbLots && essais < 4; essais++, lot++) {
            const lotSirens = ent.sirens.slice(lot * LOT_SIREN, (lot + 1) * LOT_SIREN);
            if (!lotSirens.length) break;
            const rP = await basile('/people/find', { limit: 100, filters: { ...baseLkiSiren, siren: { include: lotSirens } } }, key);
            if (rP.data && rP.data.success !== false) leadsBruts = rP.data.leads || [];
            if (leadsBruts.length) break;
          }
          if (lot + 1 < nbLots) prochaineSuite = { phase: 'lki', lot: lot + 1, entToken };
          else if (ent.next) prochaineSuite = { phase: 'lki', lot: 0, entToken: ent.next };
          else if (source === 'deux') prochaineSuite = { phase: 'legal', token: null };
        } else {
          const body = { limit: 20, filters: extrasLki(filtres, avecSource(base, 'lki')) };
          if (suite && suite.token) body.paginationToken = suite.token;
          const rP = await basile('/people/find', body, key);
          if (!rP.data || rP.data.success === false) {
            if (!suite) return res.status(502).json({ erreur: 'Recherche Basile échouée' });
          } else {
            leadsBruts = rP.data.leads || [];
            const next = (rP.data.pagination && rP.data.pagination.nextToken) || null;
            if (next) prochaineSuite = { phase: 'lki', token: next };
            else if (source === 'deux') prochaineSuite = { phase: 'legal', token: null };
          }
        }
        // Page LinkedIn VIDE au 1er appel en mode 'deux' → enchaîner tout de suite sur le
        // registre (avant : l'aperçu se cachait alors que le registre avait des milliers de
        // personnes — « aucun personas », retour Didier du 22/09 au soir).
        if (!suite && source === 'deux' && phase0 !== 'legal' && !leadsBruts.length) {
          await pageLegal(null);
        }
        if (nbEntSecteur != null) { /* exposés dans la réponse ci-dessous */ }
        var _nbEntSecteur = nbEntSecteur, _lkiPartiel = lkiPartiel, _nbEntBalayees = nbEntBalayees;
      }

      // Total 0 avec des concepts secteur : lequel est « mort » côté PERSONNES ? (constaté en prod
      // 22/09 : `gmb:Concessionnaire automobile` seul → 0 — les concepts Google Maps ne matchent
      // pas toujours des personnes, contrairement aux naf:/lki:). Comptages limit 1, gratuits :
      // on renvoie les ids sans résultat pour que le front les marque et propose la variante.
      let conceptsZero = null;
      if (!suite && total === 0 && conceptIds.length && !sirens.length) {
        conceptsZero = [];
        for (const cid of conceptIds.slice(0, 8)) {
          const seul = { ...base, activity: { include: [cid] } };
          const rc = await basile('/people/find', { limit: 1, filters: seul }, key);
          if (!rc.data || !(rc.data.total > 0)) conceptsZero.push(cid);
        }
      }
      // Doublons : slugs LinkedIn déjà extraits dans les listes actives
      const connus = await linkedinsConnus(sql);
      const leads = leadsBruts.slice(0, 20).map(l => {
        const fiche = leadVersFichePersonne(l);
        const c = fiche.contacts[0] || {};
        const slug = slugLinkedin(c.enrich && c.enrich.linkedin);
        return {
          prenom: c.prenom || '', nom: c.nom || '', fonction: c.fonction || '',
          entreprise: fiche.nom || '', ville: fiche.ville || '',
          linkedin: (c.enrich && c.enrich.linkedin) || null,
          siren: fiche.siren || null, // fusion des décideurs cochés dans les fiches (onglet Entreprises)
          slug: slug || null,
          doublon: !!(slug && connus.has(slug))
        };
      });
      return res.status(200).json({
        total, total_sans_effectif: totalSansEffectif, // null sur les pages suivantes (comptés au 1er appel)
        total_lki: totalLki, total_legal: totalLegal,  // répartition par source (null en mode listes)
        concepts_labels: conceptLabels, concepts_ids: conceptIds,
        concepts_zero: conceptsZero, // ids sans AUCUNE personne (null si total > 0)
        nb_roles: roles.length,
        nb_sirens: sirens.length || null,
        nb_entreprises_secteur: (typeof _nbEntSecteur !== 'undefined' && _nbEntSecteur != null) ? _nbEntSecteur : null,
        types_ignores: typesIgnores || false, // legal_category vidait le comptage → retiré, à dire au SDR
        total_lki_partiel: (typeof _lkiPartiel !== 'undefined') ? !!_lkiPartiel : false, // LinkedIn compté sur les premières entreprises seulement
        nb_entreprises_balayees: (typeof _nbEntBalayees !== 'undefined' && _nbEntBalayees != null) ? _nbEntBalayees : null, // pour l'extrapolation front
        apercu_suite: prochaineSuite, // à repasser tel quel pour la page suivante (null = fin)
        leads
      });
    }

    // ── GÉNÉRATION : fiches au format Sofy, dédup + curseur (hors mode listes, borné) ──
    const cap = Math.min(parseInt(nb, 10) || 50, 200);
    const exclure = filtres.exclure_extraits !== false;
    const connus = exclure ? await linkedinsConnus(sql) : new Set();
    for (const s of (Array.isArray(exclus_slugs) ? exclus_slugs : [])) {
      const x = String(s || '').toLowerCase().trim(); if (x) connus.add(x); // décochés à l'aperçu
    }
    const debut = Date.now();
    const tempsOk = () => (Date.now() - debut) < 90000; // maxDuration 120 s, marge
    let fiches = [], epuise = false, pages = 0;

    // Clé de dédup d'un lead : slug LinkedIn, sinon (dirigeants du registre, sans profil)
    // prénom+nom+entreprise — sans ce repli, la génération JETAIT tous les mandataires.
    function cleLead(f) {
      const c = f.contacts[0] || {};
      const slug = slugLinkedin(c.enrich && c.enrich.linkedin);
      if (slug) return slug;
      const p = ((c.prenom || '') + ' ' + (c.nom || '') + '@' + (f.nom || '')).toLowerCase().replace(/\s+/g, ' ').trim();
      return p.length > 3 ? 'p:' + p : null;
    }
    function absorber(leads) {
      for (const l of leads) {
        const f = leadVersFichePersonne(l);
        const k = cleLead(f);
        if (!k || connus.has(k)) continue;
        fiches.push(f); connus.add(k);
        if (fiches.length >= cap) break;
      }
    }

    if (sirens.length) {
      // Mode listes de comptes : lots bornés (≤300 SIREN), pas de curseur nécessaire.
      for (let i = 0; i < sirens.length; i += LOT_SIREN) {
        if (!tempsOk() || fiches.length >= cap) break;
        const r = await trouver({ siren: { include: sirens.slice(i, i + LOT_SIREN) } }, 100);
        if (!r.data || r.data.success === false) continue;
        pages++;
        absorber(r.data.leads || []);
      }
      epuise = true; // le vivier des listes est fini par construction
    } else {
      // Mode filtres : par SOURCE (LinkedIn D'ABORD en mode 'deux'), curseur persistant PAR
      // source en table config. Le curseur renvoyé au front est un simple drapeau « continue » :
      // la vraie reprise vit en base, donc l'enchaînement front marche même multi-sources.
      const hashDe = (obj) => { const s = JSON.stringify(obj); let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h).toString(36); };
      const sources = source === 'deux' ? ['lki', 'legal'] : [source];
      let toutEpuise = true;
      for (const src of sources) {
        if (fiches.length >= cap || !tempsOk()) { toutEpuise = false; break; }
        // Part LinkedIn d'un secteur NAF : voie entreprises → SIREN → personnes (cf. en-tête).
        if (src === 'lki' && lkiParSiren) {
          const cleE = 'av_curseur_' + hashDe({ n: nafsConcepts, r: [...roles].sort(), e: base.company_headcount || null, v: (base.result_city && base.result_city.include) || null, s: 'lki_siren' });
          let curE = null;
          if (sql) { try { const r = await sql`SELECT valeur FROM config WHERE cle = ${cleE}`; curE = (r.length && r[0].valeur) || null; } catch (_) {} }
          if (curE && curE.epuise) curE = null;
          let entToken = (curE && curE.entToken) || null;
          let epuiseSrc = false;
          for (let b = 0; b < 6; b++) {
            if (!tempsOk() || fiches.length >= cap) break;
            const ent = await sirensGarde(300, entToken);
            if (!ent.sirens.length) { epuiseSrc = true; break; }
            for (let i = 0; i < ent.sirens.length; i += LOT_SIREN) {
              if (!tempsOk() || fiches.length >= cap) break;
              const rP = await basile('/people/find', { limit: 100, filters: { ...baseLkiSiren, siren: { include: ent.sirens.slice(i, i + LOT_SIREN) } } }, key);
              if (!rP.data || rP.data.success === false) continue;
              pages++;
              absorber(rP.data.leads || []);
            }
            entToken = ent.next;
            if (!entToken) { epuiseSrc = true; break; }
          }
          if (sql) {
            try {
              const val = JSON.stringify({ entToken, epuise: epuiseSrc, maj: new Date().toISOString() });
              await sql`INSERT INTO config (cle, valeur) VALUES (${cleE}, ${val}) ON CONFLICT (cle) DO UPDATE SET valeur = ${val}`;
            } catch (_) {}
          }
          if (!epuiseSrc) toutEpuise = false;
          continue;
        }
        const fSrc = src === 'lki' ? extrasLki(filtres, avecSource(base, 'lki')) : avecSource(base, src);
        const cle = 'av_curseur_' + hashDe({ r: [...roles].sort(), a: conceptIds, e: base.company_headcount || null, v: (base.result_city && base.result_city.include) || null, s: src });
        let cur = null;
        if (sql) { try { const r = await sql`SELECT valeur FROM config WHERE cle = ${cle}`; cur = (r.length && r[0].valeur) || null; } catch (_) {} }
        if (cur && cur.epuise) cur = null;
        let token = (cur && cur.token) || null;
        let pagesSrc = (cur && cur.pages) || 0;
        let epuiseSrc = false;
        for (let p = 0; p < 8; p++) {
          if (!tempsOk() || fiches.length >= cap) break;
          const body = { limit: 100, filters: fSrc };
          if (token) body.paginationToken = token;
          let r = await basile('/people/find', body, key);
          if (token && (!r.data || r.data.success === false)) { token = null; pagesSrc = 0; r = await basile('/people/find', { limit: 100, filters: fSrc }, key); }
          if (r.status === 402) break;
          if (!r.data || r.data.success === false) break;
          const leads = r.data.leads || [];
          if (!leads.length) { epuiseSrc = true; break; }
          pagesSrc++; pages++;
          token = (r.data.pagination && r.data.pagination.nextToken) || null;
          absorber(leads);
          if (!token) { epuiseSrc = true; break; }
        }
        if (sql) {
          try {
            const val = JSON.stringify({ token, pages: pagesSrc, epuise: epuiseSrc, maj: new Date().toISOString() });
            await sql`INSERT INTO config (cle, valeur) VALUES (${cle}, ${val}) ON CONFLICT (cle) DO UPDATE SET valeur = ${val}`;
          } catch (_) {}
        }
        if (!epuiseSrc) toutEpuise = false;
      }
      epuise = toutEpuise;
    }

    fiches = regrouperParEntreprise(fiches).slice(0, cap);
    await loggerConso(user, 'basile', 1, null);
    return res.status(200).json({
      fiches, nb: fiches.length,
      curseur: (sirens.length || epuise) ? null : { suite: true },
      epuise,
      profils_parcourus: pages * 100,
      concepts_labels: conceptLabels,
      message: fiches.length ? undefined : (epuise
        ? 'Tout le vivier de ces critères a déjà été extrait — élargis le secteur, les postes ou retire le filtre effectif.'
        : 'Aucun nouveau profil sur ce lot — relance pour explorer la suite.')
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur recherche', detail: String(e.message || e).slice(0, 200) });
  }
}
