// /api/verticale.js — Liste « Verticale » : toutes les entités d'un GROUPE (holding) ou d'un RÉSEAU (enseigne)
//
// Moteur GROUPE (Pappers) — ex : Groupe Bernard Hayot, multi-enseignes :
//   retrouve les sociétés dont la holding est DIRIGEANTE (personne morale) via
//   /v2/recherche-dirigeants, puis récursif sur les sous-holdings (NAF 6420Z/7010Z
//   ou nom évocateur) -> l'arbre complet du groupe.
//   POST { moteur:'groupe', mode:'estimer'|'creer', nom? , siren?, nb? }
//     estimer -> { holding, candidats, filiales:[{siren,nom,naf,ville,qualite,niveau,via}] } (pas de crédit détail)
//     creer   -> { entreprises:[fiches au format liste Pappers] } (détail + dirigeant, cessées exclues)
//
// Moteur ENSEIGNE (Google Maps) — ex : BigMat, réseau à vitrines :
//   balayage du réseau département par département ; le front enchaîne les lots.
//   POST { moteur:'enseigne', mode:'estimer'|'creer', enseigne, departements?:['971','972',…], nb? }
//     estimer -> échantillon sur 8 départements représentatifs + extrapolation France
//     creer   -> { entreprises:[fiches au format liste Google Maps] } (max 10 départements/appel)
//
// Moteur WEB (annuaire du site) — ex : Algorel, réseau qui publie ses adhérents en ligne :
//   lit la page « nos adhérents / points de vente » (+ pagination), Claude extrait les
//   sociétés, Pappers retrouve SIREN + dirigeants. Non résolues gardées (nom + ville).
//   POST { moteur:'web', mode:'estimer'|'creer', url, reseau?, entites?, nb? }
//     estimer -> { total, entites, echantillon } (1 appel Claude, aucune requête Pappers)
//     creer   -> { entreprises:[fiches], resolues, non_resolues } (entites réutilisées si fournies)
//
// GET ?debug=1&q=NOM (superadmin) : réponse brute Pappers recherche-dirigeants (ajustement du mapping)

import { verifierToken, loggerConso, limiteAtteinte, sql } from './db.js';
import { detailEntreprise } from './liste.js';
import { pageTextSearch, detailsPlace, versFiche } from './gmb-liste.js';

export const config = { maxDuration: 120 };

// ---------- Commun ----------
function normaliser(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\b(sas|sasu|sarl|sa|sci|snc|societe|groupe|holding|cie|compagnie|ets|etablissements?)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---------- Moteur GROUPE (Pappers) ----------
const RE_HOLDING = /holding|groupe|participation|invest|financ|patrimoin|développement|developpement/i;
const NAF_HOLDING = new Set(['6420Z', '64.20Z', '7010Z', '70.10Z']);

async function pageRechercheDirigeants(q, page, apiKey, champ) {
  // champ='denomination' -> recherche UNIQUEMENT parmi les dirigeants personnes morales
  // (évite de paginer des centaines d'homonymes personnes physiques, cas « Loret »)
  const p = new URLSearchParams({ api_token: apiKey, par_page: '100', page: String(page) });
  p.set(champ === 'denomination' ? 'denomination' : 'q', q);
  const r = await fetch('https://api.pappers.fr/v2/recherche-dirigeants?' + p.toString());
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Format réel /recherche-dirigeants (vérifié via ?debug=1) : chaque résultat = UN dirigeant
// (personne morale : denomination + siren + qualite) avec `entreprises` = TABLEAU des sociétés
// où il détient le mandat. Beaucoup d'homonymes (SCI GBH, GBH SARL…) -> match STRICT par le
// SIREN du dirigeant ; mandats de contrôle (commissaire aux comptes…) et mandats passés exclus.
function filialesDepuisResultats(resultats, holding) {
  const out = [];
  for (const r of (Array.isArray(resultats) ? resultats : [])) {
    if (!r || typeof r !== 'object') continue;
    if (r.personne_morale !== true) continue;
    const dirSiren = String(r.siren || '').replace(/\s/g, '');
    if (!holding.siren || !dirSiren || dirSiren !== String(holding.siren)) continue;
    const qualite = r.qualite || (Array.isArray(r.qualites) && r.qualites[0]) || '';
    if (/commissaire|liquidateur|administrateur judiciaire/i.test(qualite)) continue;
    for (const ent of (Array.isArray(r.entreprises) ? r.entreprises : [])) {
      const siren = String(ent.siren || '').replace(/\s/g, '');
      if (!siren || siren === dirSiren) continue;
      const actuel = (ent.dirigeant_actuel !== undefined) ? !!ent.dirigeant_actuel : (r.actuel !== false);
      if (!actuel) continue;
      out.push({
        siren,
        nom: ent.nom_entreprise || ent.denomination || '',
        naf: ent.code_naf || null,
        activite: ent.libelle_code_naf || null,
        ville: (ent.siege && ent.siege.ville) || '',
        code_postal: (ent.siege && ent.siege.code_postal) || '',
        adresse: (ent.siege && ent.siege.adresse_ligne_1) || '',
        effectif: ent.effectif || null,
        chiffre_affaires: ent.chiffre_affaires || null,
        forme: ent.forme_juridique || null,
        qualite,
        cessee: !!ent.entreprise_cessee || ent.statut_consolide === 'radié'
      });
    }
  }
  return out;
}

// Mandats d'un dirigeant PERSONNE PHYSIQUE (stratégie « dirigeants communs ») : toutes les
// sociétés qu'il dirige actuellement. Anti-homonymes (les « Michel Gonnet » sont légion) :
// la DATE DE NAISSANCE tranche quand les deux côtés l'ont ; sinon on exige que la société
// soit dans l'EMPREINTE GÉOGRAPHIQUE du groupe (départements de la racine + stratégie A).
function mandatsPersonnePhysique(resultats, prenom, nom, annee, empreinte, filtreFait) {
  const cp = normaliser(prenom), cn = normaliser(nom);
  const out = [];
  for (const r of (Array.isArray(resultats) ? resultats : [])) {
    if (!r || typeof r !== 'object' || r.personne_morale === true) continue;
    const rp = normaliser(r.prenom || (Array.isArray(r.prenoms) && r.prenoms[0]) || ''), rn = normaliser(r.nom || '');
    const complet = normaliser(r.nom_complet || (r.prenom || '') + ' ' + (r.nom || ''));
    const match = (rp && rn) ? (rp === cp && rn === cn) : (complet === normaliser(prenom + ' ' + nom));
    if (!match) continue;
    const aR = anneeNaissance(r.date_de_naissance_formate || r.date_de_naissance || r.date_de_naissance_complete_formate);
    const datesSures = !!(annee && aR);
    if (datesSures && annee !== aR) continue; // homonyme certain -> écarté
    const qualite = r.qualite || (Array.isArray(r.qualites) && r.qualites[0]) || '';
    if (/commissaire|liquidateur|administrateur judiciaire/i.test(qualite)) continue;
    for (const ent of (Array.isArray(r.entreprises) ? r.entreprises : [])) {
      const siren = String(ent.siren || '').replace(/\s/g, '');
      if (!siren) continue;
      const actuel = (ent.dirigeant_actuel !== undefined) ? !!ent.dirigeant_actuel : (r.actuel !== false);
      if (!actuel) continue;
      // Sans date pour trancher l'homonymie : seule l'empreinte géo du groupe fait foi
      // (sauf si le filtrage a déjà été fait par l'API, ex : date passée en paramètre)
      if (!datesSures && !filtreFait) {
        const dep = depDeCp((ent.siege && ent.siege.code_postal) || '');
        if (!empreinte || !empreinte.size || !empreinte.has(dep)) continue;
      }
      out.push({
        siren, nom: ent.nom_entreprise || ent.denomination || '',
        naf: ent.code_naf || null, activite: ent.libelle_code_naf || null,
        ville: (ent.siege && ent.siege.ville) || '', code_postal: (ent.siege && ent.siege.code_postal) || '',
        adresse: (ent.siege && ent.siege.adresse_ligne_1) || '',
        effectif: ent.effectif || null, chiffre_affaires: ent.chiffre_affaires || null,
        forme: ent.forme_juridique || null, qualite,
        cessee: !!ent.entreprise_cessee || ent.statut_consolide === 'radié'
      });
    }
  }
  return out;
}

// Mot distinctif du nom du groupe pour la stratégie « nom éponyme » (patronyme ≈ dernier mot utile)
const MOTS_GENERIQUES = new Set(['groupe', 'holding', 'societe', 'société', 'cie', 'compagnie', 'ets', 'etablissements', 'établissements', 'sas', 'sarl', 'sa', 'distribution', 'automobile', 'automobiles', 'participations', 'invest', 'investissement', 'finance', 'financiere', 'financière', 'et', 'de', 'du', 'des', 'la', 'le', 'les']);
function motDistinctif(nom) {
  const mots = String(nom || '').split(/[\s\-']+/).map(m => normaliser(m)).filter(m => m.length >= 4 && !MOTS_GENERIQUES.has(m));
  if (!mots.length) return null;
  return mots[mots.length - 1]; // « Groupe Amédée Barbotteau » -> « barbotteau », « Groupe Bernard Hayot » -> « hayot »
}
// Mots « utiles » d'une dénomination pour interroger recherche-dirigeants : le plein texte exige
// TOUS les mots (« SA L LORET ET CIE » ne trouve rien, « L LORET » trouve le mandat).
function motsRequete(nom) {
  return String(nom || '').split(/\s+/).filter(m => { const n = normaliser(m); return n && !MOTS_GENERIQUES.has(n); }).join(' ') || String(nom || '');
}
function anneeNaissance(s) { const m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : null; }
// Date de naissance au format DD-MM-YYYY attendu par /recherche-beneficiaires
function dateNaissanceParam(b) {
  const f = String((b && (b.date_de_naissance_formate || b.date_de_naissance_rgpd_formatee)) || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(f)) return f.replace(/\//g, '-');
  const d = String((b && (b.date_de_naissance || b.date_de_naissance_complete)) || '').trim();
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function depDeCp(cp) { cp = String(cp || ''); return /^9[78]/.test(cp) ? cp.slice(0, 3) : cp.slice(0, 2); }

// Arbre du groupe — 3 stratégies combinées, dédoublonnées par SIREN :
//  A. mandats de la holding PERSONNE MORALE (récursif sur les sous-holdings) — ex : GBH
//  B. dirigeants COMMUNS : les personnes physiques qui dirigent la holding -> leurs mandats — groupes familiaux
//  C. nom ÉPONYME : sociétés actives dont le nom porte le patronyme du groupe — ex : BARBOTTEAU DISTRIBUTION
async function arbreGroupe(racine, apiKey, nomUsuel) {
  const vues = new Set([racine.siren]);
  const filiales = new Map();
  let requetes = 0;
  const ajouter = (f, niveau, via, lien) => {
    if (vues.has(f.siren)) return null;
    vues.add(f.siren);
    f.niveau = niveau; f.via = via; f.lien = lien;
    filiales.set(f.siren, f);
    return f;
  };

  // ── A. Mandats personne morale, récursif (sous-holdings) ──
  let front = [racine];
  for (let niveau = 1; niveau <= 3 && front.length; niveau++) {
    const prochaines = [];
    for (const h of front) {
      if (requetes >= 30) break; // garde-fou crédits + durée
      let page = 1;
      while (page <= 5 && requetes < 30) {
        requetes++;
        const r = await pageRechercheDirigeants(motsRequete(h.nom), page, apiKey);
        if (!r.ok) break;
        const rs = r.data.resultats || [];
        for (const f of filialesDepuisResultats(rs, h)) {
          const aj = ajouter(f, niveau, h.nom, 'mandat');
          if (aj && !f.cessee && (NAF_HOLDING.has(String(f.naf || '')) || RE_HOLDING.test(f.nom))) {
            prochaines.push({ siren: f.siren, nom: f.nom });
          }
        }
        const total = r.data.total || rs.length;
        if (!rs.length || page * 100 >= total) break;
        page++;
      }
    }
    front = prochaines.slice(0, 15); // max 15 sous-holdings explorées par niveau
  }

  // ── B. Dirigeants communs (personnes physiques de la holding -> leurs mandats) ──
  // Anti-homonymes : date de naissance quand disponible, sinon empreinte géo (racine + A).
  let empreinteAB = new Set();
  let beneficiaires = [];
  try {
    const r = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${encodeURIComponent(racine.siren)}`);
    requetes++;
    const e = r.ok ? await r.json().catch(() => null) : null;
    if (e && e.siege && e.siege.code_postal) racine.code_postal = e.siege.code_postal; // empreinte géo (B, C, D)
    beneficiaires = (e && Array.isArray(e.beneficiaires_effectifs)) ? e.beneficiaires_effectifs : [];
    empreinteAB = new Set([...filiales.values()].map(f => depDeCp(f.code_postal)).filter(Boolean));
    if (racine.code_postal) empreinteAB.add(depDeCp(racine.code_postal));
    const physiques = ((e && e.representants) || [])
      .filter(p => !p.personne_morale && (p.nom || p.nom_complet) && !/commissaire|liquidateur/i.test(p.qualite || ''))
      .slice(0, 4);
    for (const p of physiques) {
      if (requetes >= 40) break;
      const prenom = String(p.prenom || '').split(',')[0].trim();
      const nomP = p.nom || p.nom_complet || '';
      if (!nomP) continue;
      const annee = anneeNaissance(p.date_de_naissance_formate || p.date_de_naissance || p.date_de_naissance_complete_formate || (p.age ? '' : ''));
      requetes++;
      const rd = await pageRechercheDirigeants((prenom + ' ' + nomP).trim(), 1, apiKey);
      if (!rd.ok) continue;
      for (const f of mandatsPersonnePhysique(rd.data.resultats || [], prenom, nomP, annee, empreinteAB)) {
        ajouter(f, 1, (prenom + ' ' + nomP).trim(), 'dirigeant_commun');
      }
    }
  } catch (_) {}

  // ── D. Bénéficiaires effectifs : les personnes au sommet du groupe -> toutes les sociétés
  // dont elles sont bénéficiaires effectifs. Le BE traverse les chaînes de détention par
  // CAPITAL, là où les mandats ne relient pas les filiales opérationnelles (cas Loret :
  // concessions/télécom détenues par la holding mais dirigées par des managers salariés).
  // Anti-homonymes : la date de naissance est passée en PARAMÈTRE de recherche quand connue.
  try {
    const bes = beneficiaires.filter(b => b && !b.personne_morale && b.nom).slice(0, 4);
    for (const be of bes) {
      if (requetes >= 50) break;
      const prenom = String((Array.isArray(be.prenoms) && be.prenoms[0]) || be.prenom || '').split(',')[0].trim();
      const nomB = be.nom || '';
      if (!nomB) continue;
      const dnaiss = dateNaissanceParam(be);
      const p = new URLSearchParams({ api_token: apiKey, q: (prenom + ' ' + nomB).trim(), par_page: '100' });
      if (dnaiss) { p.set('date_de_naissance_beneficiaire_min', dnaiss); p.set('date_de_naissance_beneficiaire_max', dnaiss); }
      requetes++;
      const r = await fetch('https://api.pappers.fr/v2/recherche-beneficiaires?' + p.toString());
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      // Date passée en paramètre -> le filtrage homonymes est déjà fait par Pappers ; sinon
      // mandatsPersonnePhysique applique nom+prénom + empreinte géographique.
      for (const f of mandatsPersonnePhysique(d.resultats || [], prenom, nomB, anneeNaissance(dnaiss), empreinteAB, !!dnaiss)) {
        ajouter(f, 1, (prenom + ' ' + nomB).trim(), 'beneficiaire');
      }
    }
  } catch (_) {}

  // ── C. Nom éponyme (patronyme distinctif dans la dénomination) ──
  // Le nom TAPÉ par le SDR porte souvent le patronyme (« Groupe Barbotteau ») même quand
  // la dénomination légale de la racine ne le porte pas (« GB ») -> on essaie les deux.
  // Deux garde-fous anti-bruit : (1) les entreprises individuelles homonymes sont exclues
  // (« BARBOTTEAU VANESSA · vente à domicile »), (2) on reste dans l'EMPREINTE GÉOGRAPHIQUE
  // du groupe = les départements de la racine et des entités trouvées par les stratégies A/B.
  const empreinte = new Set([...filiales.values()].map(f => depDeCp(f.code_postal)).filter(Boolean));
  if (racine.code_postal) empreinte.add(depDeCp(racine.code_postal));
  const token = motDistinctif(nomUsuel || '') || motDistinctif(racine.nom);
  if (token && empreinte.size && requetes < 45) {
    try {
      const p = new URLSearchParams({ api_token: apiKey, q: token, par_page: '100', precision: 'standard' });
      requetes++;
      const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      const rs = d.resultats || [];
      // Trop d'homonymes (patronyme courant) -> stratégie écartée pour ne pas polluer la liste
      if ((d.total || rs.length) <= 200) {
        for (const ent of rs) {
          if (!normaliser(ent.nom_entreprise || '').includes(token)) continue;
          if (ent.entreprise_cessee === true || ent.entreprise_cessee === 1) continue;
          if (/entrepreneur individuel|micro-entrepreneur|artisan|commer[cç]ant/i.test(ent.forme_juridique || '')) continue;
          const cp = (ent.siege && ent.siege.code_postal) || '';
          if (!empreinte.has(depDeCp(cp))) continue;
          const siren = String(ent.siren || '').replace(/\s/g, '');
          if (!siren) continue;
          ajouter({
            siren, nom: ent.nom_entreprise || '',
            naf: ent.code_naf || null, activite: ent.libelle_code_naf || null,
            ville: (ent.siege && ent.siege.ville) || '', code_postal: cp,
            adresse: (ent.siege && ent.siege.adresse_ligne_1) || '',
            effectif: ent.effectif || ent.tranche_effectif || null,
            chiffre_affaires: ent.dernier_chiffre_affaires || null,
            forme: ent.forme_juridique || null, qualite: 'nom éponyme',
            cessee: false
          }, 1, token, 'nom');
        }
      }
    } catch (_) {}
  }

  return { filiales: [...filiales.values()], requetes };
}

// Résout la holding racine : siren fourni, sinon meilleure correspondance Pappers (+ candidats).
// Repli : beaucoup de groupes sont enregistrés sous leur ACRONYME (« Groupe Bernard Hayot » -> « GBH »).
async function chercherEntreprises(q, apiKey) {
  const p = new URLSearchParams({ api_token: apiKey, q, par_page: '20', precision: 'standard' });
  const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  return (d.resultats || []).map(e => ({
    siren: String(e.siren || ''), nom: e.nom_entreprise || '',
    ville: (e.siege && e.siege.ville) || '', naf: e.code_naf || null, activite: e.libelle_code_naf || null,
    effectif_min: e.effectif_min || 0,
    ca: e.dernier_chiffre_affaires || e.chiffre_affaires || 0
  })).filter(c => c.siren);
}
// La recherche Pappers exige TOUS les mots -> « Groupe Barbotteau » ne matche aucune société.
// On essaie donc : nom complet, puis nom SANS les mots génériques (« Barbotteau »), puis acronyme
// (« Groupe Bernard Hayot » -> « GBH »), et on fusionne les candidats avant de trier.
async function resoudreHolding(nom, siren, apiKey, dep) {
  if (siren) {
    const r = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${encodeURIComponent(siren)}`);
    const e = r.ok ? await r.json().catch(() => null) : null;
    if (e && e.siren) return { holding: { siren: String(e.siren), nom: e.nom_entreprise || e.denomination || nom || '' }, candidats: [] };
    return { holding: null, candidats: [] };
  }
  const mots = nom.split(/\s+/).filter(Boolean);
  // « générique » = dans la liste OU vidé par la normalisation (groupe, sas… y sont déjà retirés)
  const motsUtiles = mots.filter(m => { const n = normaliser(m); return n && !MOTS_GENERIQUES.has(n); });
  // Acronyme seulement à partir de 3 mots (« Groupe Bernard Hayot » -> « GBH ») : à 2 lettres
  // (« Groupe Ampiot » -> « GA ») il matche n'importe quoi et invente des groupes loufoques.
  const acronyme = mots.length >= 3 ? mots.map(w => w[0]).join('').toUpperCase() : null;
  const essais = [nom];
  if (motsUtiles.length && motsUtiles.join(' ').toLowerCase() !== nom.toLowerCase()) essais.push(motsUtiles.join(' '));
  if (acronyme) essais.push(acronyme);
  const vus = new Set();
  const candidats = [];
  let probes = 0;
  for (const q of essais) {
    if (candidats.length >= 12) break;
    for (const c of await chercherEntreprises(q, apiKey)) {
      if (vus.has(c.siren)) continue;
      vus.add(c.siren); candidats.push(c);
    }
  }

  // Candidats élargis : /recherche large (100) filtrée sur les structures « de groupe »
  // (NAF holding, ou CA/effectif significatif) — attrape L. LORET ET CIE que le top 20 noie.
  const token = motDistinctif(nom);
  if (token) {
    try {
      const p = new URLSearchParams({ api_token: apiKey, q: token, par_page: '100', precision: 'standard' });
      probes++;
      const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      const gros = (d.resultats || []).map(e => ({
        siren: String(e.siren || ''), nom: e.nom_entreprise || '',
        ville: (e.siege && e.siege.ville) || '', naf: e.code_naf || null, activite: e.libelle_code_naf || null,
        effectif_min: e.effectif_min || 0,
        ca: e.dernier_chiffre_affaires || e.chiffre_affaires || 0
      })).filter(c => c.siren && normaliser(c.nom).includes(token)
        && (NAF_HOLDING.has(String(c.naf || '')) || c.ca >= 1000000 || c.effectif_min >= 10))
        .slice(0, 8);
      for (const c of gros) {
        if (vus.has(c.siren)) continue;
        vus.add(c.siren); candidats.push(c);
      }
    } catch (_) {}
  }

  // Source décisive : les DIRIGEANTS PERSONNE MORALE portant le nom (la tête de groupe préside
  // ses filiales). Vérification STRICTE de la correspondance du nom : Pappers ignore les
  // paramètres inconnus et peut renvoyer des dirigeants sans rapport (bug « KLESIA »).
  const qDir = (motsUtiles.length ? motsUtiles.join(' ') : nom);
  const nomCorrespond = (denomination) => {
    const n = normaliser(denomination);
    return n && (n.includes(normaliser(qDir)) || (token && n.includes(token)));
  };
  const rsScan = []; // toutes les pages scannées, réutilisées pour la sonde (0 requête en plus)
  try {
    for (let page = 1; page <= 5; page++) {
      probes++;
      const rd = await pageRechercheDirigeants(qDir, page, apiKey, 'q');
      if (!rd.ok) break;
      const rs = rd.data.resultats || [];
      rsScan.push(...rs);
      for (const r of rs) {
        if (r.personne_morale !== true) continue;
        const qualite = r.qualite || (Array.isArray(r.qualites) && r.qualites[0]) || '';
        if (/commissaire|liquidateur/i.test(qualite)) continue;
        const siren = String(r.siren || '').replace(/\s/g, '');
        const denomination = r.denomination || r.nom_complet || '';
        if (!siren || !denomination || !nomCorrespond(denomination)) continue;
        const mandats = r.nb_entreprises_total || (Array.isArray(r.entreprises) ? r.entreprises.length : 0);
        const existant = candidats.find(c => c.siren === siren);
        if (existant) { existant.mandats = Math.max(existant.mandats || 0, mandats); continue; }
        if (vus.has(siren)) continue;
        vus.add(siren);
        candidats.push({ siren, nom: denomination, ville: '', naf: null, activite: null, effectif_min: 0, ca: 0, mandats });
      }
      const total = rd.data.total || rs.length;
      if (!rs.length || page * 100 >= total) break;
    }
  } catch (_) {}

  // Score de base : NAF holding, nom exact (ou acronyme), mot distinctif, taille (CA / effectif)
  const cible = normaliser(nom);
  const cibleAcro = acronyme ? normaliser(acronyme) : null;
  for (const c of candidats) {
    const n = normaliser(c.nom);
    c._score = (n === cible || (cibleAcro && n === cibleAcro) ? 2 : 0)
      + (NAF_HOLDING.has(String(c.naf || '')) ? 2 : 0)
      + (token && n.includes(token) ? 1 : 0)
      + (c.ca > 10000000 || c.effectif_min >= 50 ? 2 : (c.ca > 1000000 || c.effectif_min >= 10 ? 1 : 0));
  }

  // Sonde de mandats gratuite : comptage dans les pages déjà scannées (filtré par LEUR siren)
  for (const c of candidats) {
    if (c.mandats !== undefined) continue;
    c.mandats = filialesDepuisResultats(rsScan, c).filter(f => !f.cessee).length;
  }

  // Sonde CIBLÉE pour les candidats sérieux restés à 0 mandat : la page partagée est saturée
  // d'homonymes personnes physiques (cas « L. LORET ET CIE » invisible dans 500 dirigeants
  // « loret »). Requête dédiée sur le nom épuré du candidat (« SA L LORET ET CIE » -> « l loret »)
  // -> peu de résultats, son mandat de tête de groupe ressort. Comptage filtré par SON siren.
  const serieux = candidats
    .filter(c => (c.mandats || 0) === 0 && (c._score >= 2 || c.ca >= 1000000 || c.effectif_min >= 10 || NAF_HOLDING.has(String(c.naf || ''))))
    .sort((a, b) => (b.ca || 0) - (a.ca || 0) || b._score - a._score);
  const dejaQ = new Map();
  let sondes = 0;
  for (const c of serieux) {
    if (sondes >= 8) break;
    const qS = motsRequete(c.nom);
    let rs = dejaQ.get(qS);
    if (rs === undefined) {
      sondes++; probes++;
      const r = await pageRechercheDirigeants(qS, 1, apiKey, 'q');
      rs = (r.ok && (r.data.resultats || [])) || [];
      dejaQ.set(qS, rs);
    }
    c.mandats = Math.max(c.mandats || 0, filialesDepuisResultats(rs, c).filter(f => !f.cessee).length);
  }

  // Tri provisoire pour choisir qui enrichir : mandats > score > CA
  candidats.sort((a, b) => (b.mandats || 0) - (a.mandats || 0) || b._score - a._score || (b.ca || 0) - (a.ca || 0));

  // Ville/CP systématiques sur le top des candidats (cas « Groupe Citadelle » : 20+ homonymes,
  // chips sans ville = choix aveugle ; le vrai groupe était au Lamentin 972). 1 crédit /entreprise
  // par candidat sans ville, plafonné à 8 — uniquement à la résolution, pas à chaque estimation.
  const aEnrichir = candidats.slice(0, dep ? 16 : 8).filter(c => !c.ville);
  for (const c of aEnrichir) {
    try {
      probes++;
      const r = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${encodeURIComponent(c.siren)}`);
      const e = r.ok ? await r.json().catch(() => null) : null;
      if (e && e.siege) {
        c.ville = e.siege.ville || '';
        c.code_postal = e.siege.code_postal || '';
        if (!c.naf) { c.naf = e.code_naf || null; c.activite = e.libelle_code_naf || null; }
        if (!c.ca && e.finances && e.finances[0]) c.ca = e.finances[0].chiffre_affaires || 0;
      }
    } catch (_) {}
  }

  // Indice département (optionnel, décisif pour les groupes DOM) : le SDR nous DIT où est la
  // tête -> les candidats du bon département passent devant tout le reste, mandats compris
  // (sinon un homonyme métropole à 5 mandats écrase le vrai groupe, cas Citadelle 972).
  if (dep) {
    const d3 = String(dep).replace(/\D/g, '');
    for (const c of candidats) {
      const cp = String(c.code_postal || '');
      if (d3 && cp && cp.startsWith(d3)) { c._dep = 1; c._score += 4; }
    }
  }

  // Tri final : département indiqué > mandats détenus (signal registre) > score de nom > taille (CA)
  candidats.sort((a, b) => (b._dep || 0) - (a._dep || 0) || (b.mandats || 0) - (a.mandats || 0) || b._score - a._score || (b.ca || 0) - (a.ca || 0));
  return { holding: candidats[0] || null, candidats, acronyme, probes };
}

// Contacts Basile (mandataires par SIREN) : ajoute les profils LinkedIn (poste, URL, photo
// si fournie) en plus du dirigeant Pappers — max 3 contacts par fiche, dédoublonnés par nom.
async function ajouterContactsBasile(entreprises) {
  let ajoutes = 0;
  const bkey = process.env.BASILE_API_KEY;
  const avecSiren = entreprises.filter(e => e.siren);
  if (!bkey || !avecSiren.length) return 0;
  try {
    const parSiren = new Map(avecSiren.map(e => [String(e.siren), e]));
    const sirens = [...parSiren.keys()];
    for (let i = 0; i < sirens.length; i += 50) {
      const part = sirens.slice(i, i + 50);
      const r = await fetch('https://api.basile.cc/people/find', {
        method: 'POST', headers: { 'Authorization': bkey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100, filters: { siren: { include: part }, result_is_current: true } })
      });
      const d = await r.json().catch(() => null);
      for (const lead of ((d && d.leads) || [])) {
        const x = lead.data || lead || {};
        const f = parSiren.get(String(x.siren || ''));
        if (!f) continue;
        const fonction = x.result_role || x.current_job_title || '';
        if (/commissaire|liquidateur|administrateur judiciaire/i.test(fonction)) continue;
        const prenom = x.people_first_name || x.result_first_name || '';
        const nomC = x.people_last_name || x.result_last_name || '';
        if (!prenom && !nomC) continue;
        // Premier contact = le dirigeant Pappers (sinon contactsDe() le perdrait)
        if (!f.contacts) f.contacts = f.dirigeant ? [{ prenom: f.dirigeant.prenom, nom: f.dirigeant.nom, fonction: f.dirigeant.fonction || 'Dirigeant', source: 'pappers', enrich: null }] : [];
        if (f.contacts.length >= 3) continue;
        if (f.contacts.some(c => normaliser(c.prenom + ' ' + c.nom) === normaliser(prenom + ' ' + nomC))) continue;
        const contact = { prenom, nom: nomC, fonction, source: 'basile', enrich: {} };
        if (x.profile_url) contact.enrich.linkedin = x.profile_url;
        const photo = x.people_profile_picture || x.profile_picture || x.picture || x.photo_url || null;
        if (photo) contact.photo = photo;
        f.contacts.push(contact);
        ajoutes++;
      }
    }
  } catch (_) {}
  return ajoutes;
}

// Déduplication INTER-LISTES : clés déjà extraites dans les listes existantes (une nouvelle
// extraction « kiabi 50 » une semaine plus tard ramène les 50 SUIVANTES, sans re-payer les mêmes).
async function clesDejaExtraites() {
  const cles = { pids: new Set(), sirens: new Set() };
  if (!sql) return cles;
  try {
    const ls = await sql`SELECT entreprises FROM listes WHERE criteres->>'auto' IS NULL`;
    for (const l of ls) for (const e of (l.entreprises || [])) {
      if (e.siren) cles.sirens.add(String(e.siren));
      if (e.gmb && e.gmb.place_id) cles.pids.add(e.gmb.place_id);
    }
  } catch (_) {}
  return cles;
}

// ---------- Moteur ENSEIGNE (Google Maps, balayage par département) ----------
const DEPARTEMENTS = [
  ['01', 'Ain'], ['02', 'Aisne'], ['03', 'Allier'], ['04', 'Alpes-de-Haute-Provence'], ['05', 'Hautes-Alpes'],
  ['06', 'Alpes-Maritimes'], ['07', 'Ardèche'], ['08', 'Ardennes'], ['09', 'Ariège'], ['10', 'Aube'],
  ['11', 'Aude'], ['12', 'Aveyron'], ['13', 'Bouches-du-Rhône'], ['14', 'Calvados'], ['15', 'Cantal'],
  ['16', 'Charente'], ['17', 'Charente-Maritime'], ['18', 'Cher'], ['19', 'Corrèze'], ['2A', 'Corse-du-Sud'],
  ['2B', 'Haute-Corse'], ['21', 'Côte-d\'Or'], ['22', 'Côtes-d\'Armor'], ['23', 'Creuse'], ['24', 'Dordogne'],
  ['25', 'Doubs'], ['26', 'Drôme'], ['27', 'Eure'], ['28', 'Eure-et-Loir'], ['29', 'Finistère'],
  ['30', 'Gard'], ['31', 'Haute-Garonne'], ['32', 'Gers'], ['33', 'Gironde'], ['34', 'Hérault'],
  ['35', 'Ille-et-Vilaine'], ['36', 'Indre'], ['37', 'Indre-et-Loire'], ['38', 'Isère'], ['39', 'Jura'],
  ['40', 'Landes'], ['41', 'Loir-et-Cher'], ['42', 'Loire'], ['43', 'Haute-Loire'], ['44', 'Loire-Atlantique'],
  ['45', 'Loiret'], ['46', 'Lot'], ['47', 'Lot-et-Garonne'], ['48', 'Lozère'], ['49', 'Maine-et-Loire'],
  ['50', 'Manche'], ['51', 'Marne'], ['52', 'Haute-Marne'], ['53', 'Mayenne'], ['54', 'Meurthe-et-Moselle'],
  ['55', 'Meuse'], ['56', 'Morbihan'], ['57', 'Moselle'], ['58', 'Nièvre'], ['59', 'Nord'],
  ['60', 'Oise'], ['61', 'Orne'], ['62', 'Pas-de-Calais'], ['63', 'Puy-de-Dôme'], ['64', 'Pyrénées-Atlantiques'],
  ['65', 'Hautes-Pyrénées'], ['66', 'Pyrénées-Orientales'], ['67', 'Bas-Rhin'], ['68', 'Haut-Rhin'], ['69', 'Rhône'],
  ['70', 'Haute-Saône'], ['71', 'Saône-et-Loire'], ['72', 'Sarthe'], ['73', 'Savoie'], ['74', 'Haute-Savoie'],
  ['75', 'Paris'], ['76', 'Seine-Maritime'], ['77', 'Seine-et-Marne'], ['78', 'Yvelines'], ['79', 'Deux-Sèvres'],
  ['80', 'Somme'], ['81', 'Tarn'], ['82', 'Tarn-et-Garonne'], ['83', 'Var'], ['84', 'Vaucluse'],
  ['85', 'Vendée'], ['86', 'Vienne'], ['87', 'Haute-Vienne'], ['88', 'Vosges'], ['89', 'Yonne'],
  ['90', 'Territoire de Belfort'], ['91', 'Essonne'], ['92', 'Hauts-de-Seine'], ['93', 'Seine-Saint-Denis'],
  ['94', 'Val-de-Marne'], ['95', 'Val-d\'Oise'],
  ['971', 'Guadeloupe'], ['972', 'Martinique'], ['973', 'Guyane'], ['974', 'La Réunion'], ['976', 'Mayotte']
];
const DEP_ECHANTILLON = ['75', '13', '69', '33', '59', '971', '972', '974'];

function nomDep(code) { const d = DEPARTEMENTS.find(x => x[0] === code); return d ? d[1] : code; }

// La fiche Google porte-t-elle bien l'enseigne cherchée ? (filtre anti-bruit du Text Search)
function porteEnseigne(nomPlace, enseigne) {
  return normaliser(nomPlace).includes(normaliser(enseigne));
}

// ---------- Moteur WEB (annuaire publié sur le site du réseau) ----------
// Beaucoup de réseaux listent leurs adhérents / points de vente / agences sur leur
// site (ex : algorel.fr/nos-adherents). On lit la page (+ sa pagination), Claude en
// extrait les sociétés, puis Pappers retrouve SIREN et dirigeants.

function urlSure(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(x.hostname)) return false;
    return true;
  } catch (_) { return false; }
}

function htmlVersTexte(html) {
  let h = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Les noms des membres sont souvent portés par les logos : on remonte les alt en texte
  h = h.replace(/<img[^>]*\balt="([^"]{2,80})"[^>]*>/gi, '\n$1\n');
  h = h.replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&eacute;/gi, 'é').replace(/&egrave;/gi, 'è').replace(/&agrave;/gi, 'à').replace(/&ccedil;/gi, 'ç')
    .replace(/&#(\d+);/g, (m, c) => { try { return String.fromCodePoint(+c); } catch (_) { return ' '; } });
  return h.split('\n').map(l => l.trim()).filter(Boolean).join('\n').slice(0, 25000);
}

async function lirePageWeb(url) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SofyScrap/1.0)' } });
    if (!r.ok || !/text\/html/.test(r.headers.get('content-type') || '')) return null;
    return (await r.text()).slice(0, 600000);
  } catch (_) { return null; } finally { clearTimeout(to); }
}

// Pages suivantes d'un annuaire paginé (liens ?page=N sur le même chemin), max 9 après la première
function liensPagination(html, urlBase) {
  const base = new URL(urlBase);
  const vus = new Set(); const urls = [];
  for (const m of String(html || '').matchAll(/href="([^"]*[?&]page=\d+[^"]*)"/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), base);
      if (u.hostname !== base.hostname || u.pathname !== base.pathname) continue;
      if (u.href === base.href || vus.has(u.href)) continue;
      vus.add(u.href); urls.push(u.href);
    } catch (_) {}
  }
  return urls.slice(0, 9);
}

async function extraireEntitesWeb(url) {
  const html = await lirePageWeb(url);
  if (!html) throw new Error('Page illisible (site indisponible, bloqué, ou contenu 100 % JavaScript)');
  const textes = [htmlVersTexte(html)];
  for (const u of liensPagination(html, url)) {
    const h2 = await lirePageWeb(u);
    if (h2) textes.push(htmlVersTexte(h2));
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante dans Vercel');
  const prompt = `Voici le texte de ${textes.length} page(s) du site d'un réseau / groupement, listant ses membres (adhérents, points de vente, agences, magasins…).

Extrais TOUTES les entreprises membres listées. Règles :
- une entrée par SOCIÉTÉ : si plusieurs points de vente appartiennent visiblement à la même société (même nom, villes différentes), regroupe en UNE entité avec la ville du premier
- ignore la navigation, le footer, les marques / fournisseurs / partenaires, et les enseignes du réseau lui-même
- ville et cp (code postal) uniquement s'ils figurent dans le texte, sinon null
- n'invente RIEN, déduplique

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :
{"entites":[{"nom":"…","ville":null,"cp":null}]}

${textes.map((t, i) => `--- PAGE ${i + 1} ---\n${t}`).join('\n\n')}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error('API Claude : ' + ((data && data.error && data.error.message) || r.status));
  const brut = ((data.content || []).map(c => c.text || '').join('')).replace(/```json|```/g, '');
  let parsed = null;
  try { parsed = JSON.parse(brut.slice(brut.indexOf('{'), brut.lastIndexOf('}') + 1)); } catch (_) {}
  const vues = new Set();
  const entites = ((parsed && parsed.entites) || [])
    .map(e => ({ nom: String(e.nom || '').trim().slice(0, 120), ville: e.ville ? String(e.ville).trim().slice(0, 80) : null, cp: e.cp ? String(e.cp).replace(/\D/g, '').slice(0, 5) : null }))
    .filter(e => { const k = normaliser(e.nom); if (e.nom.length < 2 || !k || vues.has(k)) return false; vues.add(k); return true; })
    .slice(0, 300);
  return { entites, pages_lues: textes.length };
}

// Retrouve le SIREN d'un membre : /recherche Pappers, d'abord dans son département (si CP connu)
async function resoudreSirenWeb(ent, apiKey) {
  const nomN = normaliser(ent.nom);
  if (!nomN || nomN.length < 3) return { requetes: 0, siren: null };
  const essais = [];
  const dep = ent.cp ? depDeCp(ent.cp) : '';
  if (dep) essais.push(dep);
  essais.push('');
  let requetes = 0;
  for (const d of essais) {
    const p = new URLSearchParams({ api_token: apiKey, q: ent.nom, par_page: '5', precision: 'standard' });
    if (d) p.set('departement', d);
    try {
      const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
      requetes++;
      if (!r.ok) continue;
      const data = await r.json();
      for (const e of (data.resultats || [])) {
        const cand = normaliser(e.nom_entreprise || e.denomination || '');
        if (!cand) continue;
        if (cand === nomN || cand.includes(nomN) || nomN.includes(cand)) {
          return {
            requetes, siren: String(e.siren), nom: e.nom_entreprise || ent.nom,
            naf: e.code_naf || null, activite: e.libelle_code_naf || null,
            ville: (e.siege && e.siege.ville) || ent.ville || '', code_postal: (e.siege && e.siege.code_postal) || ent.cp || ''
          };
        }
      }
    } catch (_) { requetes++; }
  }
  return { requetes, siren: null };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  // ── Debug superadmin : réponses brutes Pappers (pour ajuster le mapping) ──
  // ?debug=1&q=NOM                    -> /recherche-dirigeants
  // ?debug=1&endpoint=recherche&q=NOM -> /recherche (résolution de la holding)
  if (req.method === 'GET' && (req.query || {}).debug) {
    if (user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au superadmin' });
    const apiKey = process.env.PAPPERS_API_KEY;
    if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante' });
    const q = String(req.query.q || '');
    // ?debug=1&endpoint=resolution&q=groupe loret -> toute la résolution, candidats détaillés
    if (req.query.endpoint === 'resolution') {
      const r = await resoudreHolding(q, '', apiKey, (req.query || {}).dep || '');
      return res.status(200).json({ holding: r.holding, acronyme: r.acronyme, probes: r.probes, candidats: r.candidats });
    }
    // ?debug=1&endpoint=entreprise&siren=… -> teste les champs_supplementaires Pappers
    // (liens capitalistiques / participations…) : quelles clés apparaissent, quelles erreurs.
    // L'essai « xxx » (invalide) force Pappers à lister les valeurs autorisées dans son erreur.
    if (req.query.endpoint === 'entreprise') {
      const sirenDbg = String(req.query.siren || '').replace(/\s/g, '');
      if (!sirenDbg) return res.status(400).json({ erreur: 'siren requis' });
      const essais = ['', 'xxx', 'liens_capitalistiques', 'participations', 'filiales', 'associes', 'actionnaires'];
      const out = {};
      let clesBase = new Set();
      for (const champ of essais) {
        const p = new URLSearchParams({ api_token: apiKey, siren: sirenDbg });
        if (champ) p.set('champs_supplementaires', champ);
        try {
          const r = await fetch('https://api.pappers.fr/v2/entreprise?' + p.toString());
          const txt = await r.text(); let d = null; try { d = JSON.parse(txt); } catch (_) {}
          if (!champ) {
            clesBase = new Set(Object.keys(d || {}));
            out.base = { status: r.status, cles: [...clesBase] };
          } else {
            const nouvelles = d ? Object.keys(d).filter(k => !clesBase.has(k)) : [];
            const extrait = {};
            for (const k of nouvelles) { const v = d[k]; extrait[k] = Array.isArray(v) ? v.slice(0, 3) : v; }
            out[champ] = {
              status: r.status,
              cles_nouvelles: nouvelles,
              extrait: nouvelles.length ? extrait : undefined,
              erreur: !r.ok ? ((d && (d.erreur || d.error || d.message)) || txt.slice(0, 300)) : undefined
            };
          }
        } catch (e) { out[champ || 'base'] = { erreur: e.message }; }
      }
      return res.status(200).json(out);
    }
    // ?debug=1&endpoint=arbre&siren=… -> diagnostic complet des 4 stratégies de l'arbre du groupe :
    // représentants et bénéficiaires effectifs de la racine (matière des stratégies B et D),
    // mandats trouvés au nom de la holding (stratégie A), puis l'arbre réellement construit.
    if (req.query.endpoint === 'arbre') {
      const sirenA = String(req.query.siren || '').replace(/\s/g, '');
      if (!sirenA) return res.status(400).json({ erreur: 'siren requis' });
      const rE = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${sirenA}`);
      const e = rE.ok ? await rE.json().catch(() => null) : null;
      if (!e || !e.siren) return res.status(404).json({ erreur: 'SIREN introuvable sur Pappers' });
      const nomA = String(req.query.nom || e.nom_entreprise || e.denomination || '');
      const rD = await pageRechercheDirigeants(motsRequete(nomA), 1, apiKey);
      const rsD = (rD.data && rD.data.resultats) || [];
      const pmMemeSiren = rsD.filter(r => r && r.personne_morale === true && String(r.siren || '').replace(/\s/g, '') === sirenA);
      const racine = { siren: sirenA, nom: nomA, code_postal: (e.siege && e.siege.code_postal) || '' };
      const { filiales, requetes } = await arbreGroupe(racine, apiKey, nomA);
      const repartition = {};
      for (const f of filiales) repartition[f.lien || 'mandat'] = (repartition[f.lien || 'mandat'] || 0) + 1;
      return res.status(200).json({
        racine: { siren: sirenA, nom: nomA, ville: (e.siege && e.siege.ville) || '', cp: racine.code_postal },
        cles_entreprise: Object.keys(e),
        representants: (e.representants || []).map(p => ({ pm: !!p.personne_morale, nom: p.nom_complet || ((p.prenom || '') + ' ' + (p.nom || '')).trim(), qualite: p.qualite || null, naissance: p.date_de_naissance_formate || p.date_de_naissance || null, actuel: p.actuel !== false })),
        beneficiaires_effectifs: (Array.isArray(e.beneficiaires_effectifs) ? e.beneficiaires_effectifs : []).map(b => ({ pm: !!b.personne_morale, nom: (((Array.isArray(b.prenoms) && b.prenoms[0]) || b.prenom || '') + ' ' + (b.nom || '')).trim(), naissance: dateNaissanceParam(b), pct: b.pourcentage_parts || b.pourcentage_parts_directes || null })),
        strategie_A: {
          requete: motsRequete(nomA), statut: rD.status, resultats_page1: rsD.length, total: (rD.data && rD.data.total) || null,
          dirigeants_pm_meme_siren: pmMemeSiren.length,
          filiales_extraites: filialesDepuisResultats(rsD, { siren: sirenA }).length,
          record_brut: pmMemeSiren.map(r => ({
            qualite: r.qualite || null, qualites: r.qualites || null, actuel: r.actuel,
            entreprises_3_premieres: (r.entreprises || []).slice(0, 3)
          })),
          mandats_apercu: pmMemeSiren.flatMap(r => (r.entreprises || []).slice(0, 8).map(x => ({ nom: x.nom_entreprise || x.denomination, actuel: x.dirigeant_actuel })))
        },
        arbre: { total: filiales.length, requetes, repartition, apercu: filiales.slice(0, 25).map(f => ({ nom: f.nom, siren: f.siren, ville: f.ville, lien: f.lien, via: f.via, cessee: !!f.cessee })) }
      });
    }
    // ?debug=1&endpoint=beneficiaires&q=Prénom Nom[&naissance=DD-MM-YYYY] -> recherche-beneficiaires brut
    if (req.query.endpoint === 'beneficiaires') {
      const p = new URLSearchParams({ api_token: apiKey, q, par_page: '5' });
      if (req.query.naissance) { p.set('date_de_naissance_beneficiaire_min', String(req.query.naissance)); p.set('date_de_naissance_beneficiaire_max', String(req.query.naissance)); }
      const r = await fetch('https://api.pappers.fr/v2/recherche-beneficiaires?' + p.toString());
      const txt = await r.text(); let d = null; try { d = JSON.parse(txt); } catch (_) {}
      return res.status(200).json({ status: r.status, total: d && d.total, exemple: d ? (d.resultats || []).slice(0, 2) : txt.slice(0, 400) });
    }
    if (req.query.endpoint === 'recherche') {
      const p = new URLSearchParams({ api_token: apiKey, q, par_page: '5', precision: 'standard' });
      const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
      const txt = await r.text(); let d = null; try { d = JSON.parse(txt); } catch (_) {}
      return res.status(200).json({ status: r.status, total: d && d.total, exemple: (d && d.resultats) ? d.resultats.slice(0, 3).map(e => ({ siren: e.siren, nom: e.nom_entreprise, ville: e.siege && e.siege.ville, naf: e.code_naf })) : txt.slice(0, 400) });
    }
    const r = await pageRechercheDirigeants(q, 1, apiKey);
    const rs = (r.data && r.data.resultats) || [];
    return res.status(200).json({ status: r.status, total: r.data && r.data.total, exemple: rs.slice(0, 3) });
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const b = req.body || {};
  const mode = b.mode === 'creer' ? 'creer' : 'estimer';

  try {
    // ════════ Moteur GROUPE (Pappers) ════════
    if (b.moteur === 'groupe') {
      const apiKey = process.env.PAPPERS_API_KEY;
      if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante dans Vercel' });
      const nom = String(b.nom || '').trim();
      const siren = String(b.siren || '').replace(/\s/g, '');
      if (!nom && !siren) return res.status(400).json({ erreur: 'nom (ou siren) du groupe requis' });

      const { holding, candidats, probes = 0 } = await resoudreHolding(nom, siren, apiKey, b.dep || '');
      if (!holding) return res.status(404).json({ erreur: `Groupe introuvable sur Pappers : « ${nom || siren} »`, candidats });

      const { filiales, requetes } = await arbreGroupe(holding, apiKey, nom);
      const actives = filiales.filter(f => !f.cessee);

      if (mode === 'estimer') {
        // Répartition par stratégie de rattachement (mandat / dirigeant commun / nom éponyme)
        const repartition = {};
        for (const f of actives) repartition[f.lien || 'mandat'] = (repartition[f.lien || 'mandat'] || 0) + 1;
        await loggerConso(user, 'pappers', requetes + probes, b.liste_id || null);
        return res.status(200).json({
          moteur: 'groupe', holding, candidats,
          total: actives.length, cessees: filiales.length - actives.length,
          repartition,
          filiales: actives, requetes_pappers: requetes,
          credits_detail_estimes: Math.min(actives.length, 300)
        });
      }

      // creer : détail Pappers par filiale (dirigeant, CA…) — même format que la liste Pappers
      const nb = Math.min(Math.max(parseInt(b.nb, 10) || 150, 1), 300);
      // Dédoublonnage inter-listes AVANT le détail payant (1 crédit/fiche)
      let doublonsInterListes = 0;
      let pool = actives;
      if (b.dedup !== false) {
        const cles = await clesDejaExtraites();
        pool = actives.filter(f => { if (cles.sirens.has(String(f.siren))) { doublonsInterListes++; return false; } return true; });
      }
      const retenues = pool.slice(0, nb);
      const details = new Array(retenues.length).fill(null);
      for (let i = 0; i < retenues.length; i += 10) {
        const lot = retenues.slice(i, i + 10);
        const rs = await Promise.all(lot.map(f => detailEntreprise(f.siren, apiKey)));
        rs.forEach((d, j) => { details[i + j] = d; });
      }
      let exclues = 0;
      const entreprises = retenues.map((f, i) => {
        const d = details[i] || {};
        return {
          nom: f.nom, siren: f.siren, naf: f.naf, activite: f.activite,
          ville: f.ville, code_postal: f.code_postal, adresse: f.adresse || '',
          effectif: f.effectif || null,
          chiffre_affaires: d.chiffre_affaires || f.chiffre_affaires || null,
          nb_etablissements: d.nb_etablissements || null,
          site_web: d.site_web || null,
          date_creation: d.date_creation || null,
          dirigeant: d.dirigeant || null,
          enseigne: d.enseigne || null,
          groupe: holding.nom, groupe_niveau: f.niveau, groupe_via: f.via, groupe_qualite: f.qualite || null, groupe_lien: f.lien || null,
          detail_charge: details[i] !== null,
          _cessee: d.cessee === true, _proc: d.procedure_collective === true
        };
      }).filter(e => { if (e._cessee || e._proc) { exclues++; return false; } return true; })
        .map(({ _cessee, _proc, ...e }) => e);

      let contactsBasile = 0;
      if (b.contacts_basile !== false) contactsBasile = await ajouterContactsBasile(entreprises);

      await loggerConso(user, 'pappers', requetes + probes + retenues.length, b.liste_id || null);
      return res.status(200).json({
        moteur: 'groupe', holding, total: actives.length,
        fiches_detaillees: retenues.length, exclues_cessees_ou_liquidation: exclues,
        doublons_inter_listes: doublonsInterListes,
        contacts_basile: contactsBasile,
        credits_estimes: requetes + probes + retenues.length, entreprises
      });
    }

    // ════════ Moteur ENSEIGNE (Google Maps) ════════
    if (b.moteur === 'enseigne') {
      const key = process.env.GOOGLE_PLACES_API_KEY;
      if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante' });
      const enseigne = String(b.enseigne || '').trim();
      if (!enseigne) return res.status(400).json({ erreur: 'enseigne requise' });

      let nbAppels = 0;

      if (mode === 'estimer') {
        // L'échantillon suit le PÉRIMÈTRE choisi : DOM -> comptage réel des 5 départements ;
        // métropole/France -> 8 départements représentatifs + extrapolation sur le périmètre.
        const DOM_CODES = ['971', '972', '973', '974', '976'];
        const METRO_ECHANTILLON = ['75', '13', '69', '33', '59', '44', '31', '67'];
        const per = (b.perimetre === 'dom' || b.perimetre === 'metropole') ? b.perimetre : 'france';
        const sample = per === 'dom' ? DOM_CODES : (per === 'metropole' ? METRO_ECHANTILLON : DEP_ECHANTILLON);
        const nbDepsPerimetre = per === 'dom' ? DOM_CODES.length : (per === 'metropole' ? DEPARTEMENTS.length - DOM_CODES.length : DEPARTEMENTS.length);
        const exact = per === 'dom';
        let trouves = 0; const echantillon = []; const parDep = {}; const vusEst = new Set();
        for (const code of sample) {
          const d = await pageTextSearch({ query: enseigne + ' ' + nomDep(code) }, key); nbAppels++;
          const ok = (d.results || []).filter(r => r.place_id && !vusEst.has(r.place_id) && porteEnseigne(r.name, enseigne));
          ok.forEach(r => vusEst.add(r.place_id));
          parDep[code] = ok.length; trouves += ok.length;
          for (const r of ok.slice(0, exact ? 2 : 1)) echantillon.push({ nom: r.name, dep: nomDep(code), note: (typeof r.rating === 'number') ? r.rating : null, avis: r.user_ratings_total || 0 });
        }
        await loggerConso(user, 'google_places', nbAppels, b.liste_id || null);
        return res.status(200).json({
          moteur: 'enseigne', enseigne, perimetre: per, comptage_exact: exact,
          trouves_echantillon: trouves, departements_testes: sample.length, par_departement: parDep, echantillon,
          estimation_perimetre: exact ? trouves : Math.round((trouves / sample.length) * nbDepsPerimetre),
          departements_perimetre: nbDepsPerimetre,
          info: 'Création par lots : envoie mode=creer avec departements=[codes] (max 10 par appel).'
        });
      }

      // creer : lot de départements (max 10 / appel — le front enchaîne les lots)
      const deps = (Array.isArray(b.departements) ? b.departements : []).map(String).filter(c => DEPARTEMENTS.some(d => d[0] === c)).slice(0, 10);
      if (!deps.length) return res.status(400).json({ erreur: 'departements[] requis (max 10 par appel)' });
      const capFiches = Math.min(Math.max(parseInt(b.nb, 10) || 100, 1), 150);

      const vus = new Set(); const places = [];
      for (const code of deps) {
        let d = await pageTextSearch({ query: enseigne + ' ' + nomDep(code) }, key); nbAppels++;
        let pages = 1;
        while (true) {
          for (const r of (d.results || [])) {
            if (!r.place_id || vus.has(r.place_id)) continue;
            if (r.business_status && r.business_status !== 'OPERATIONAL') continue;
            if (!porteEnseigne(r.name, enseigne)) continue;
            vus.add(r.place_id);
            places.push({ r, dep: code });
          }
          if (!d.next_page_token || pages >= 2 || places.length >= capFiches) break;
          await new Promise(ok => setTimeout(ok, 2000)); // le page_token Google demande ~2 s
          d = await pageTextSearch({ pagetoken: d.next_page_token }, key); nbAppels++;
          pages++;
        }
        if (places.length >= capFiches) break;
      }

      // Dédoublonnage inter-listes AVANT les Details payants (fiches Google déjà extraites ailleurs)
      let doublonsInterListes = 0;
      let poolPlaces = places;
      if (b.dedup !== false) {
        const cles = await clesDejaExtraites();
        poolPlaces = places.filter(p => { if (cles.pids.has(p.r.place_id)) { doublonsInterListes++; return false; } return true; });
      }
      // Details (site, téléphone, avis) par lots de 8 — même munitions que la liste Google Maps
      const retenues = poolPlaces.slice(0, capFiches);
      const fiches = [];
      for (let i = 0; i < retenues.length; i += 8) {
        const lot = retenues.slice(i, i + 8);
        const dets = await Promise.all(lot.map(p => detailsPlace(p.r.place_id, key)));
        nbAppels += lot.length;
        dets.forEach((det, j) => {
          const p = lot[j];
          const f = versFiche(p.r, det, nomDep(p.dep), enseigne);
          f.source = 'gmb';
          f.groupe = enseigne;
          fiches.push(f);
        });
      }

      await loggerConso(user, 'google_places', nbAppels, b.liste_id || null);
      return res.status(200).json({
        moteur: 'enseigne', enseigne, departements: deps,
        total: fiches.length, appels_google: nbAppels,
        tronque: poolPlaces.length > capFiches,
        doublons_inter_listes: doublonsInterListes,
        entreprises: fiches
      });
    }

    // ════════ Moteur WEB (annuaire publié sur le site du réseau) ════════
    if (b.moteur === 'web') {
      const url = String(b.url || '').trim();
      if (!urlSure(url)) return res.status(400).json({ erreur: 'URL invalide — colle l’adresse complète (https://…) de la page annuaire' });
      const reseau = String(b.reseau || '').trim() || new URL(url).hostname.replace(/^www\./, '');

      if (mode === 'estimer') {
        const { entites, pages_lues } = await extraireEntitesWeb(url);
        await loggerConso(user, 'ia_claude', 1, b.liste_id || null);
        return res.status(200).json({
          moteur: 'web', url, reseau, pages_lues,
          total: entites.length, entites,
          echantillon: entites.slice(0, 10),
          info: 'Renvoie ces entites au mode=creer pour éviter une seconde lecture de la page.'
        });
      }

      // creer : SIREN + détail via Pappers ; les membres non résolus (nom commercial ≠ raison
      // sociale) sont GARDÉS quand même — nom + ville suffisent à l'enrichissement GMB/scoring.
      const apiKey = process.env.PAPPERS_API_KEY;
      if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante dans Vercel' });
      let entites = Array.isArray(b.entites) && b.entites.length
        ? b.entites.map(e => ({ nom: String(e.nom || '').trim().slice(0, 120), ville: e.ville ? String(e.ville).trim().slice(0, 80) : null, cp: e.cp ? String(e.cp).replace(/\D/g, '').slice(0, 5) : null })).filter(e => e.nom.length >= 2)
        : null;
      let iaAppels = 0;
      if (!entites) { const ex = await extraireEntitesWeb(url); entites = ex.entites; iaAppels = 1; }
      const nb = Math.min(Math.max(parseInt(b.nb, 10) || 150, 1), 300);
      entites = entites.slice(0, nb);

      const cles = (b.dedup !== false) ? await clesDejaExtraites() : { sirens: new Set(), pids: new Set() };
      const sirensLot = new Set(); // deux membres résolus sur le même SIREN = une seule fiche
      let requetesPappers = 0, doublonsInterListes = 0, exclues = 0;
      const fiches = [];
      for (let i = 0; i < entites.length; i += 10) {
        const lot = entites.slice(i, i + 10);
        const rs = await Promise.all(lot.map(async (ent) => {
          const r = await resoudreSirenWeb(ent, apiKey);
          let d = null;
          if (r.siren && !cles.sirens.has(r.siren) && !sirensLot.has(r.siren)) { d = await detailEntreprise(r.siren, apiKey); r.requetes++; }
          return { ent, r, d };
        }));
        for (const { ent, r, d } of rs) {
          requetesPappers += r.requetes;
          if (r.siren) {
            if (cles.sirens.has(r.siren)) { doublonsInterListes++; continue; }
            if (sirensLot.has(r.siren)) continue;
            sirensLot.add(r.siren);
          }
          if (d && (d.cessee === true || d.procedure_collective === true)) { exclues++; continue; }
          const fiche = {
            nom: r.siren ? r.nom : ent.nom,
            siren: r.siren || null,
            naf: r.naf || null, activite: r.activite || null,
            ville: (r.siren ? r.ville : ent.ville) || '', code_postal: (r.siren ? r.code_postal : ent.cp) || '',
            chiffre_affaires: d ? d.chiffre_affaires : null,
            nb_etablissements: d ? d.nb_etablissements : null,
            site_web: d ? d.site_web : null,
            date_creation: d ? d.date_creation : null,
            dirigeant: d ? d.dirigeant : null,
            enseigne: (d && d.enseigne) || ((r.siren && normaliser(r.nom) !== normaliser(ent.nom)) ? ent.nom : null),
            groupe: reseau, groupe_lien: 'annuaire_web',
            detail_charge: !!d
          };
          if (!r.siren) fiche.siren_non_trouve = true;
          fiches.push(fiche);
        }
      }

      let contactsBasile = 0;
      if (b.contacts_basile !== false) contactsBasile = await ajouterContactsBasile(fiches);

      if (requetesPappers) await loggerConso(user, 'pappers', requetesPappers, b.liste_id || null);
      if (iaAppels) await loggerConso(user, 'ia_claude', iaAppels, b.liste_id || null);
      const resolues = fiches.filter(f => f.siren).length;
      return res.status(200).json({
        moteur: 'web', url, reseau,
        total: fiches.length, resolues, non_resolues: fiches.length - resolues,
        exclues_cessees_ou_liquidation: exclues,
        doublons_inter_listes: doublonsInterListes,
        contacts_basile: contactsBasile,
        credits_estimes: requetesPappers,
        entreprises: fiches
      });
    }

    return res.status(400).json({ erreur: "moteur requis : 'groupe' (holding Pappers), 'enseigne' (Google Maps) ou 'web' (annuaire du réseau)" });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
