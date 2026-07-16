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
function mandatsPersonnePhysique(resultats, prenom, nom, annee, empreinte) {
  const cp = normaliser(prenom), cn = normaliser(nom);
  const out = [];
  for (const r of (Array.isArray(resultats) ? resultats : [])) {
    if (!r || typeof r !== 'object' || r.personne_morale === true) continue;
    const rp = normaliser(r.prenom || ''), rn = normaliser(r.nom || '');
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
      if (!datesSures) {
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
  try {
    const r = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${encodeURIComponent(racine.siren)}`);
    requetes++;
    const e = r.ok ? await r.json().catch(() => null) : null;
    if (e && e.siege && e.siege.code_postal) racine.code_postal = e.siege.code_postal; // empreinte géo (B et C)
    const empreinteAB = new Set([...filiales.values()].map(f => depDeCp(f.code_postal)).filter(Boolean));
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
async function resoudreHolding(nom, siren, apiKey) {
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

  // Tri final : mandats détenus (signal registre) > score de nom > taille (CA)
  candidats.sort((a, b) => (b.mandats || 0) - (a.mandats || 0) || b._score - a._score || (b.ca || 0) - (a.ca || 0));
  return { holding: candidats[0] || null, candidats, acronyme, probes };
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
      const r = await resoudreHolding(q, '', apiKey);
      return res.status(200).json({ holding: r.holding, acronyme: r.acronyme, probes: r.probes, candidats: r.candidats });
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

      const { holding, candidats, probes = 0 } = await resoudreHolding(nom, siren, apiKey);
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

      // Contacts Basile (mandataires par SIREN) : ajoute les profils LinkedIn (poste, URL, photo
      // si fournie) en plus du dirigeant Pappers — max 3 contacts par fiche, dédoublonnés par nom.
      let contactsBasile = 0;
      if (b.contacts_basile !== false && process.env.BASILE_API_KEY && entreprises.length) {
        try {
          const bkey = process.env.BASILE_API_KEY;
          const parSiren = new Map(entreprises.map(e => [String(e.siren), e]));
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
              contactsBasile++;
            }
          }
        } catch (_) {}
      }

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

    return res.status(400).json({ erreur: "moteur requis : 'groupe' (holding Pappers) ou 'enseigne' (Google Maps)" });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
