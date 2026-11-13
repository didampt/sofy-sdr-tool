// /api/roi-produits.js — 💶 Les études de rentabilité, produit par produit.
//
// Trois produits, un seul gabarit (roi-page.js) et un seul parcours (onglet « Simulateur ROI ») :
//   budy     Budy Auto — le commercial remplit avec le client (moteur : calculerRoi, roi-page.js)
//   soview   Soview — pré-rempli par les MESURES du lead (note, avis, position locale, réponses
//            aux avis, aperçu IA) ; restent 3 saisies que SerpApi ne peut pas connaître : les vues
//            de la fiche, le panier et le taux de transformation
//   soreach  SoReach SMS / RCS — la taille de la base et le rythme des campagnes
//
// Pas de default export : bibliothèque partagée par /api/roi.js (calcul, nettoyage, script servi
// au front) et /api/p.js (rendu public).
//
// ⚠️ Comme calculerRoi, calculerSoview et calculerSoreach sont servies au front par
// Function.toString : elles doivent rester AUTONOMES (aucune variable extérieure).
// ⚠️ Prudence : Soview et SoReach n'ont pas de « gain mesuré » — le gain dépend d'hypothèses
// (hausse de visibilité, taux de clic) affichées comme telles. Le message qui tient tout seul est
// le SEUIL (« rentabilisé avec N clients par mois »), d'où sa place en tête des deux études.

import {
  esc, NBSP, fmt, eur, eur2, ent, nb, roiX, p0, kpi, bulle, pageSynthese, pagePreuve, blocFin, gabarit,
  PIED_ESTIMATION, calculerRoi, PRESETS_ROI, COULEURS_ROI, pageRoi, scenariosEtude, tableScenarios, SCENARIO_BUDY
} from './roi-page.js';

// ── Soview ────────────────────────────────────────────────────────────────────────────────────
export function calculerSoview(c) {
  const n = (v, d) => { const x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const borne = (v, a, b) => Math.max(a, Math.min(b, v));
  const pct = (v, d) => borne(n(v, d), 0, 100) / 100;
  const pos = (v, d, max) => borne(n(v, d), 0, max);
  c = c || {};
  const off = c.off || {};
  const on = k => !off[k];
  const sites = borne(Math.round(n(c.sites, 1)), 1, 2000);
  const jours = borne(n(c.jours_mois, 26), 1, 31);
  const coutH = off.cout_temps ? 0 : pos(c.cout_horaire, 30, 500);   // valorisation du temps : option
  const panier = pos(c.panier, 0, 1000000), marge = pct(c.marge, 0);

  // Ce que la fiche Google rapporte déjà : vues → actions (appel, itinéraire, site) → clients.
  const vues = sites * pos(c.vues_mois, 0, 10000000);
  const actions = vues * pct(c.taux_action, 0);
  const clientsAuj = actions * pct(c.taux_transfo, 0);
  // Levier 1 — visibilité : une hausse des contacts venus de Google (hypothèse affichée).
  const clientsPlus = on('visibilite') ? clientsAuj * borne(n(c.gain_visibilite, 0), 0, 300) / 100 : 0;
  const caVis = clientsPlus * panier, gVis = caVis * marge;
  // Levier 2 — avis : les réponses rédigées par Budy, validées d'un clic.
  const avisMois = sites * pos(c.avis_mois, 0, 100000);
  const hAvis = on('avis') ? avisMois * pos(c.min_reponse, 0, 60) / 60 : 0;
  // Levier 3 — gestion : une seule saisie pour toutes les fiches et tous les annuaires.
  const hGestion = on('gestion') ? sites * pos(c.heures_gestion, 0, 200) : 0;
  const heures = hAvis + hGestion;

  const abo = pos(c.abonnement, 0, 100000) * sites;
  const frais = pos(c.frais_installation, 0, 1000000);
  const coutMois = abo, coutAn1 = coutMois * 12 + frais;
  const surMarge = c.seuil_base === 'marge';
  const gV = surMarge ? gVis : caVis;                 // gain sur le CA par défaut (décision Didier 13/11/2026)
  const gainMois = gV + heures * coutH, gainAn = gainMois * 12;
  const base = surMarge ? panier * marge : panier;
  const seuil = (base > 0 && coutMois > 0) ? Math.max(1, Math.ceil(coutMois / base)) : null;
  const gainJour = gainMois / jours;
  const L = (id, label, ca, gain) => ({ id, label, actif: on(id), ca_an: ca * 12, gain_an: gain * 12 });
  return {
    produit: 'soview', sites, jours,
    vues_mois: vues, actions_mois: actions, clients_actuels_mois: clientsAuj, clients_plus_mois: clientsPlus,
    avis_mois: avisMois, heures_avis_mois: hAvis, heures_gestion_mois: hGestion,
    leviers: [
      L('visibilite', 'Clients gagnés par une meilleure visibilité locale', caVis, gV),
      L('avis', 'Réponses aux avis rédigées par Budy', 0, hAvis * coutH),
      L('gestion', 'Fiches gérées d\'une seule saisie', 0, hGestion * coutH)
    ],
    ca_mois: caVis, ca_an: caVis * 12, marge_mois: gVis, marge_an: gVis * 12,
    gain_ventes_mois: gV, sur_marge: surMarge,
    heures_mois: heures, heures_an: heures * 12, etp: heures / 151.67, valeur_temps_mois: heures * coutH,
    abonnement_mois: abo, cout_mois: coutMois, cout_an1: coutAn1, frais,
    gain_mois: gainMois, gain_an: gainAn, gain_net_mois: gainMois - coutMois, gain_net_an: gainAn - coutAn1,
    gain_par_site_an: gainAn / sites, gain_net_3ans: gainAn * 3 - (coutMois * 36 + frais),
    roi: coutAn1 > 0 ? gainAn / coutAn1 : null, roi_prudent: coutAn1 > 0 ? (gainAn / 2) / coutAn1 : null,
    payback_jours: (coutAn1 > 0 && gainAn > 0) ? Math.ceil(coutAn1 / (gainAn / 365)) : null,
    seuil_pct: gainAn > 0 ? coutAn1 / gainAn * 100 : null,
    demandes_mois: actions, demandes_jour: actions / 30,
    panier_moyen: panier, panier_min: panier, panier_max: panier,
    seuil_base: c.seuil_base === 'marge' ? 'marge' : 'ca', seuil_ventes_mois: seuil,
    seuil_pct_demandes: (seuil != null && actions > 0) ? seuil / actions * 100 : null,
    ventes_mois: clientsPlus, multiple_seuil: (seuil && clientsPlus > 0) ? clientsPlus / seuil : null,
    jour_rentable: (gainJour > 0 && coutMois > 0 && gainMois >= coutMois) ? Math.min(jours, Math.max(1, Math.ceil(coutMois / gainJour))) : null
  };
}

// ── SoReach SMS / RCS ─────────────────────────────────────────────────────────────────────────
export function calculerSoreach(c) {
  const n = (v, d) => { const x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const borne = (v, a, b) => Math.max(a, Math.min(b, v));
  const pct = (v, d) => borne(n(v, d), 0, 100) / 100;
  const pos = (v, d, max) => borne(n(v, d), 0, max);
  c = c || {};
  const off = c.off || {};
  const on = k => !off[k];
  const sites = borne(Math.round(n(c.sites, 1)), 1, 2000);
  const jours = borne(n(c.jours_mois, 26), 1, 31);
  const coutH = off.cout_temps ? 0 : pos(c.cout_horaire, 30, 500);   // valorisation du temps : option
  const panier = pos(c.panier, 0, 1000000), marge = pct(c.marge, 0);

  const contacts = sites * pos(c.contacts, 0, 10000000);
  const campagnes = pos(c.campagnes_mois, 0, 60);
  const messages = on('campagnes') ? contacts * campagnes : 0;
  const clics = messages * pct(c.taux_clic, 0);
  const ventes = clics * pct(c.taux_conv, 0);
  const ca = ventes * panier, g = ca * marge;
  // Rédaction et ciblage préparés par Budy : du temps rendu à celui qui fait les campagnes.
  const heures = on('redaction') ? campagnes * pos(c.heures_campagne, 0, 40) : 0;

  const coutMsg = messages * pos(c.cout_message, 0, 5);
  const abo = pos(c.abonnement, 0, 100000) * sites;
  const frais = pos(c.frais_installation, 0, 1000000);
  const coutMois = abo + coutMsg, coutAn1 = coutMois * 12 + frais;
  const surMarge = c.seuil_base === 'marge';
  const gV = surMarge ? g : ca;                       // gain sur le CA par défaut (décision Didier 13/11/2026)
  const gainMois = gV + heures * coutH, gainAn = gainMois * 12;
  const base = surMarge ? panier * marge : panier;
  const seuil = (base > 0 && coutMois > 0) ? Math.max(1, Math.ceil(coutMois / base)) : null;
  const gainJour = gainMois / jours;
  const L = (id, label, caL, gain) => ({ id, label, actif: on(id), ca_an: caL * 12, gain_an: gain * 12 });
  return {
    produit: 'soreach', sites, jours,
    contacts, campagnes_mois: campagnes, messages_mois: messages, clics_mois: clics,
    leviers: [
      L('campagnes', 'Ventes générées par les campagnes SMS / RCS', ca, gV),
      L('redaction', 'Campagnes préparées par Budy', 0, heures * coutH)
    ],
    ca_mois: ca, ca_an: ca * 12, marge_mois: g, marge_an: g * 12, gain_ventes_mois: gV, sur_marge: surMarge,
    heures_mois: heures, heures_an: heures * 12, etp: heures / 151.67, valeur_temps_mois: heures * coutH,
    abonnement_mois: abo, cout_messages_mois: coutMsg, cout_mois: coutMois, cout_an1: coutAn1, frais,
    gain_mois: gainMois, gain_an: gainAn, gain_net_mois: gainMois - coutMois, gain_net_an: gainAn - coutAn1,
    gain_par_site_an: gainAn / sites, gain_net_3ans: gainAn * 3 - (coutMois * 36 + frais),
    roi: coutAn1 > 0 ? gainAn / coutAn1 : null, roi_prudent: coutAn1 > 0 ? (gainAn / 2) / coutAn1 : null,
    payback_jours: (coutAn1 > 0 && gainAn > 0) ? Math.ceil(coutAn1 / (gainAn / 365)) : null,
    seuil_pct: gainAn > 0 ? coutAn1 / gainAn * 100 : null,
    demandes_mois: messages, demandes_jour: messages / 30,
    panier_moyen: panier, panier_min: panier, panier_max: panier,
    seuil_base: c.seuil_base === 'marge' ? 'marge' : 'ca', seuil_ventes_mois: seuil,
    seuil_pct_demandes: (seuil != null && messages > 0) ? seuil / messages * 100 : null,
    ventes_mois: ventes, multiple_seuil: (seuil && ventes > 0) ? ventes / seuil : null,
    jour_rentable: (gainJour > 0 && coutMois > 0 && gainMois >= coutMois) ? Math.min(jours, Math.max(1, Math.ceil(coutMois / gainJour))) : null
  };
}

// ── SoConnect (hors automobile) : le tableau de Romain du 13/11/2026 ─────────────────────────
// demandes → part non traitée → prises en charge par SoConnect → conversion → ventes → CA.
// Par défaut le gain se lit SUR LE CHIFFRE D'AFFAIRES, comme sur son tableau et sur la fiche
// Arnoux (seuil_base 'ca') ; 'marge' applique la marge. Vérification : 540 demandes, 10 %,
// conversion 10 %, panier 250 €, abonnement 349 € → 5,4 ventes, 1 350 € de CA, +1 001 € / mois.
export function calculerSoconnect(c) {
  const n = (v, d) => { const x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const borne = (v, a, b) => Math.max(a, Math.min(b, v));
  const pct = (v, d) => borne(n(v, d), 0, 100) / 100;
  const pos = (v, d, max) => borne(n(v, d), 0, max);
  c = c || {};
  const off = c.off || {};
  const on = k => !off[k];
  const sites = borne(Math.round(n(c.sites, 1)), 1, 2000);
  const jours = borne(n(c.jours_mois, 26), 1, 31);
  const coutH = off.cout_temps ? 0 : pos(c.cout_horaire, 20, 500);   // valorisation du temps : option
  const panier = pos(c.panier, 0, 1000000), marge = pct(c.marge, 0);
  const surMarge = c.seuil_base === 'marge';

  const demandes = sites * pos(c.demandes_mois, 0, 10000000);
  const nonTraitees = demandes * pct(c.taux_non_traitees, 0);
  const prises = on('demandes') ? nonTraitees : 0;          // reprises par SoConnect
  const ventes = prises * pct(c.taux_conversion, 0);
  const ca = ventes * panier, m = ca * marge;
  const gVentes = surMarge ? m : ca;
  // Préqualification par Budy sur les demandes déjà traitées (fiche Arnoux : 18 h pour 540 demandes).
  const heures = on('temps') ? (demandes - nonTraitees) * pos(c.min_gagnees, 0, 60) / 60 : 0;

  const abo = pos(c.abonnement, 0, 100000) * sites;
  const frais = pos(c.frais_installation, 0, 1000000);
  const coutMois = abo, coutAn1 = coutMois * 12 + frais;
  const gainMois = gVentes + heures * coutH, gainAn = gainMois * 12;
  const base = surMarge ? panier * marge : panier;
  const seuil = (base > 0 && coutMois > 0) ? Math.max(1, Math.ceil(coutMois / base)) : null;
  const gainJour = gainMois / jours;
  const L = (id, label, caL, gain) => ({ id, label, actif: on(id), ca_an: caL * 12, gain_an: gain * 12 });
  return {
    produit: 'soconnect', sites, jours, sur_marge: surMarge,
    demandes_total_mois: demandes, non_traitees_mois: nonTraitees, prises_mois: prises,
    leviers: [
      L('demandes', 'Ventes sur les demandes aujourd\'hui non traitées', ca, gVentes),
      L('temps', 'Préqualification des demandes par Budy', 0, heures * coutH)
    ],
    ca_mois: ca, ca_an: ca * 12, marge_mois: m, marge_an: m * 12, gain_ventes_mois: gVentes,
    heures_mois: heures, heures_an: heures * 12, etp: heures / 151.67, valeur_temps_mois: heures * coutH,
    abonnement_mois: abo, cout_mois: coutMois, cout_an1: coutAn1, frais,
    gain_mois: gainMois, gain_an: gainAn, gain_net_mois: gainMois - coutMois, gain_net_an: gainAn - coutAn1,
    gain_par_site_an: gainAn / sites, gain_net_3ans: gainAn * 3 - (coutMois * 36 + frais),
    roi: coutAn1 > 0 ? gainAn / coutAn1 : null, roi_prudent: coutAn1 > 0 ? (gainAn / 2) / coutAn1 : null,
    payback_jours: (coutAn1 > 0 && gainAn > 0) ? Math.ceil(coutAn1 / (gainAn / 365)) : null,
    seuil_pct: gainAn > 0 ? coutAn1 / gainAn * 100 : null,
    demandes_mois: demandes, demandes_jour: demandes / jours,
    panier_moyen: panier, panier_min: panier, panier_max: panier,
    seuil_base: surMarge ? 'marge' : 'ca', seuil_ventes_mois: seuil,
    seuil_pct_demandes: (seuil != null && demandes > 0) ? seuil / demandes * 100 : null,
    ventes_mois: ventes, multiple_seuil: (seuil && ventes > 0) ? ventes / seuil : null,
    jour_rentable: (gainJour > 0 && coutMois > 0 && gainMois >= coutMois) ? Math.min(jours, Math.max(1, Math.ceil(coutMois / gainJour))) : null
  };
}

// ── Catalogue : ce que chaque produit sait calculer, et ce qu'on accepte dans sa configuration ──
// Les valeurs par défaut de Soview et SoReach sont des HYPOTHÈSES de départ prudentes (aucun
// multiple visé) ; les tarifs viennent de la grille de la base de connaissance (Soview « à partir
// de 440 € par établissement », à confirmer) — le prix du message SoReach n'est pas connu ici.
export const PRODUITS = {
  budy: {
    nom: 'Budy Auto', calc: calculerRoi, presets: PRESETS_ROI,
    champs: ['sites', 'jours_mois', 'appels_jour', 'taux_manques', 'hors_horaires', 'taux_perdus', 'taux_budy',
      'messages_jour', 'taux_msg_perdus',
      'devis_mois', 'taux_devis_sans_suite', 'taux_devis_conv', 'panier_devis', 'marge_devis',
      'rdv_mois', 'taux_noshow', 'reduction_noshow', 'panier_rdv', 'marge_rdv',
      'revisions_mois', 'taux_revision_conv', 'panier_revision',
      'upsell_demandes_mois', 'taux_upsell', 'panier_upsell', 'marge_upsell',
      'recherches_mois', 'min_recherche', 'taux_erreur', 'reduction_erreur', 'cout_erreur',
      'automatisation', 'duree_appel', 'duree_message', 'cout_horaire',
      'taux_conversion', 'panier_moyen', 'marge_moyenne', 'scen_bas', 'scen_haut',
      'abonnement', 'module', 'messages_inclus', 'plaques_incluses', 'cout_message', 'cout_plaque', 'frais_installation'],
    leviers: ['appels', 'messages', 'devis', 'atelier', 'revisions', 'upsell', 'identif', 'temps'],
    scenario: SCENARIO_BUDY
  },
  soconnect: {
    nom: 'SoConnect', calc: calculerSoconnect,
    presets: { defaut: {
      produit: 'soconnect', profil: 'defaut', off: {}, seuil_base: 'ca',
      sites: 1, jours_mois: 26, cout_horaire: 20,
      demandes_mois: 540, taux_non_traitees: 10, taux_conversion: 10, scen_bas: 1, scen_haut: 25,
      panier: 250, marge: 35, min_gagnees: 2,
      abonnement: 389, frais_installation: 0
    } },
    champs: ['sites', 'jours_mois', 'cout_horaire', 'demandes_mois', 'taux_non_traitees', 'taux_conversion', 'scen_bas', 'scen_haut',
      'panier', 'marge', 'min_gagnees', 'abonnement', 'frais_installation'],
    leviers: ['demandes', 'temps'],
    scenario: { cle: 'taux_conversion', label: 'Taux de conversion', max: 100 }
  },
  soview: {
    nom: 'Soview', calc: calculerSoview,
    presets: { defaut: {
      produit: 'soview', profil: 'defaut', off: {}, seuil_base: 'ca', mesures: {},
      sites: 1, jours_mois: 26, cout_horaire: 30,
      vues_mois: 8000, taux_action: 6, taux_transfo: 25, gain_visibilite: 15, scen_bas: 5, scen_haut: 30, panier: 120, marge: 40,
      avis_mois: 8, min_reponse: 6, heures_gestion: 3,
      abonnement: 440, frais_installation: 0
    } },
    champs: ['sites', 'jours_mois', 'cout_horaire', 'vues_mois', 'taux_action', 'taux_transfo', 'gain_visibilite', 'scen_bas', 'scen_haut', 'panier', 'marge',
      'avis_mois', 'min_reponse', 'heures_gestion', 'abonnement', 'frais_installation'],
    leviers: ['visibilite', 'avis', 'gestion'],
    scenario: { cle: 'gain_visibilite', label: 'Hausse des contacts venus de Google', max: 300 }
  },
  soreach: {
    nom: 'SoReach SMS / RCS', calc: calculerSoreach,
    presets: { defaut: {
      produit: 'soreach', profil: 'defaut', off: {}, seuil_base: 'ca',
      sites: 1, jours_mois: 26, cout_horaire: 30,
      contacts: 5000, campagnes_mois: 2, taux_clic: 12, taux_conv: 5, scen_bas: 2, scen_haut: 10, panier: 80, marge: 40, heures_campagne: 1.5,
      abonnement: 0, cout_message: 0.08, frais_installation: 0
    } },
    champs: ['sites', 'jours_mois', 'cout_horaire', 'contacts', 'campagnes_mois', 'taux_clic', 'taux_conv', 'scen_bas', 'scen_haut', 'panier', 'marge',
      'heures_campagne', 'abonnement', 'cout_message', 'frais_installation'],
    leviers: ['campagnes', 'redaction'],
    scenario: { cle: 'taux_conv', label: 'Clics suivis d\'un achat', max: 100 }
  }
};
export const COULEURS = { ...COULEURS_ROI, demandes: '#5B4FE9', visibilite: '#5B4FE9', avis: '#F59E0B', gestion: '#94A3B8', campagnes: '#F0428A', redaction: '#94A3B8' };
export const produitDe = c => (c && PRODUITS[c.produit]) ? c.produit : 'budy';
export const calculerEtude = c => PRODUITS[produitDe(c)].calc(c);
export const scenariosDe = c => { const P = PRODUITS[produitDe(c)]; return scenariosEtude(P.calc, c, P.scenario); };

// Ce que le front reçoit : les trois moteurs, leurs profils, les couleurs des leviers.
export function scriptMoteurs() {
  const presets = {};
  for (const k of Object.keys(PRODUITS)) presets[k] = PRODUITS[k].presets;
  return 'window.ROI_MOTEURS={' + Object.keys(PRODUITS).map(k => k + ':(' + PRODUITS[k].calc.toString() + ')').join(',\n') + '};\n'
    + 'window.ROI_PROFILS=' + JSON.stringify(presets) + ';\n'
    + 'window.ROI_COULEURS=' + JSON.stringify(COULEURS) + ';\n'
    + 'window.ROI_SCEN_DEF=' + JSON.stringify(Object.fromEntries(Object.keys(PRODUITS).map(k => [k, PRODUITS[k].scenario || null]))) + ';\n'
    + 'window.ROI_SCENARIOS=(' + scenariosEtude.toString() + ');\n'
    // Compatibilité avec un onglet resté ouvert sur l'ancienne version du simulateur.
    + 'window.ROI_CALC=window.ROI_MOTEURS.budy;window.ROI_PRESETS=window.ROI_PROFILS.budy;\n';
}

// Ne garder que des champs connus et des nombres : la config est réimprimée dans un document
// client, rien d'arbitraire ne doit y entrer.
export function nettoyerConfig(c) {
  c = c || {};
  const num = (v, d) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const txt = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
  const produit = produitDe(c);
  const P = PRODUITS[produit];
  const profil = P.presets[c.profil] ? c.profil : Object.keys(P.presets)[0];
  const base = P.presets[profil];
  const out = { produit, profil };
  for (const k of P.champs) out[k] = num(c[k], base[k]);
  out.seuil_base = c.seuil_base === 'marge' ? 'marge' : 'ca';
  if (produit === 'budy') out.panier_mode = c.panier_mode === 'detail' ? 'detail' : (c.panier_mode === 'simple' || !Array.isArray(c.motifs) ? 'simple' : 'detail');
  out.off = {};
  for (const k of P.leviers) if (c.off && c.off[k]) out.off[k] = true;
  if (c.off && c.off.cout_temps) out.off.cout_temps = true;   // temps rendu non valorisé
  if (base.motifs) out.motifs = (Array.isArray(c.motifs) ? c.motifs : base.motifs).slice(0, 8).map((m, i) => ({
    id: txt((m && m.id) || 'm' + i, 30), label: txt((m && m.label) || 'Motif ' + (i + 1), 80), unite: txt((m && m.unite) || 'ventes', 20),
    part: num(m && m.part, 0), conv: num(m && m.conv, 0), panier: num(m && m.panier, 0), marge: num(m && m.marge, 0)
  }));
  if (produit === 'soview') {
    const m = c.mesures || {};
    const opt = v => { const x = num(v, null); return x == null ? null : x; };
    out.mesures = {
      note: opt(m.note), avis: opt(m.avis), fiches: opt(m.fiches), note_concurrents: opt(m.note_concurrents),
      position: opt(m.position), taux_reponse: opt(m.taux_reponse),
      requete: txt(m.requete, 80) || null,
      premiers: (Array.isArray(m.premiers) ? m.premiers : []).slice(0, 3).map(x => ({ nom: txt(x && x.nom, 60), note: opt(x && x.note), avis: opt(x && x.avis) })).filter(x => x.nom),
      ia_present: m.ia_present === true ? true : (m.ia_present === false ? false : null),
      ia_cite: m.ia_cite === true ? true : (m.ia_cite === false ? false : null)
    };
  }
  if (c.secteur) out.secteur = txt(c.secteur, 80);
  return out;
}

// ── Illustrations de repli ──
const ILLU_LOCAL = `<svg viewBox="0 0 320 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Une fiche d'établissement, sa note et sa position sur la carte">
 <defs><linearGradient id="il" x1="0" x2="1"><stop offset="0" stop-color="#8F86FF"/><stop offset="1" stop-color="#F0428A"/></linearGradient></defs>
 <rect x="1" y="1" width="318" height="228" rx="18" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)"/>
 <rect x="22" y="22" width="276" height="34" rx="17" fill="rgba(255,255,255,.1)" stroke="rgba(255,255,255,.2)"/>
 <circle cx="42" cy="39" r="7" fill="none" stroke="#B9B2E0" stroke-width="2.5"/><path d="M47 44 l6 6" stroke="#B9B2E0" stroke-width="2.5" stroke-linecap="round"/>
 <rect x="62" y="34" width="120" height="10" rx="5" fill="rgba(255,255,255,.22)"/>
 <path d="M22 150 q60 -50 120 -20 t156 -30 v108 h-276 z" fill="rgba(143,134,255,.14)"/>
 <path d="M22 150 q60 -50 120 -20 t156 -30" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2"/>
 <path d="M226 78 c-22 0 -36 16 -36 34 c0 26 36 58 36 58 s36 -32 36 -58 c0 -18 -14 -34 -36 -34 z" fill="url(#il)"/>
 <circle cx="226" cy="112" r="13" fill="#0F0B29"/>
 <rect x="28" y="84" width="132" height="72" rx="12" fill="#0F0B29" stroke="rgba(255,255,255,.22)"/>
 <rect x="40" y="96" width="78" height="9" rx="4.5" fill="rgba(255,255,255,.3)"/>
 <g fill="#F5B83D"><path d="M46 118 l3 7 h7 l-6 4 l2 7 l-6 -4 l-6 4 l2 -7 l-6 -4 h7 z"/><path d="M68 118 l3 7 h7 l-6 4 l2 7 l-6 -4 l-6 4 l2 -7 l-6 -4 h7 z"/><path d="M90 118 l3 7 h7 l-6 4 l2 7 l-6 -4 l-6 4 l2 -7 l-6 -4 h7 z"/><path d="M112 118 l3 7 h7 l-6 4 l2 7 l-6 -4 l-6 4 l2 -7 l-6 -4 h7 z"/></g>
 <path d="M134 118 l3 7 h7 l-6 4 l2 7 l-6 -4 l-6 4 l2 -7 l-6 -4 h7 z" fill="rgba(255,255,255,.25)"/>
</svg>`;
const ILLU_MOBILE = `<svg viewBox="0 0 320 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Un téléphone qui reçoit un message enrichi avec un bouton">
 <defs><linearGradient id="im" x1="0" x2="1"><stop offset="0" stop-color="#8F86FF"/><stop offset="1" stop-color="#F0428A"/></linearGradient></defs>
 <rect x="1" y="1" width="318" height="228" rx="18" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)"/>
 <rect x="104" y="16" width="112" height="198" rx="18" fill="#0F0B29" stroke="#B9B2E0" stroke-width="2.5"/>
 <rect x="140" y="24" width="40" height="6" rx="3" fill="rgba(255,255,255,.25)"/>
 <rect x="116" y="44" width="88" height="56" rx="9" fill="url(#im)"/>
 <rect x="116" y="108" width="70" height="8" rx="4" fill="rgba(255,255,255,.35)"/>
 <rect x="116" y="122" width="52" height="8" rx="4" fill="rgba(255,255,255,.2)"/>
 <rect x="116" y="142" width="88" height="22" rx="11" fill="none" stroke="#8F86FF" stroke-width="2"/>
 <rect x="136" y="150" width="48" height="6" rx="3" fill="#8F86FF"/>
 <rect x="116" y="172" width="88" height="22" rx="11" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="2"/>
 <rect x="24" y="64" width="60" height="30" rx="11" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.2)"/>
 <path d="M42 79 l7 7 l14 -14" fill="none" stroke="#5DDBA5" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
 <rect x="236" y="120" width="62" height="30" rx="11" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.2)"/>
 <circle cx="254" cy="135" r="4" fill="#fff"/><circle cx="267" cy="135" r="4" fill="#fff"/><circle cx="280" cy="135" r="4" fill="#fff"/>
</svg>`;

// ── Morceaux communs aux études Soview et SoReach ──
function couverture(o) {
  const { r, client, sdr, illu, repli } = o;
  const leviersV = r.leviers.filter(l => l.actif && l.gain_an > 0);
  const contact = sdr ? `<div class="sdr">
      ${sdr.photo ? `<img src="${esc(sdr.photo)}" alt="">` : ''}
      <div><b>${esc(sdr.nom || '')}</b><span>${esc(sdr.poste || 'Votre interlocuteur chez Sofy')}</span>
      ${sdr.email ? `<a href="mailto:${esc(sdr.email)}">${esc(sdr.email)}</a>` : ''}
      ${sdr.ringover_numero ? `<a href="tel:${esc(String(sdr.ringover_numero).replace(/\s/g, ''))}">${esc(sdr.ringover_numero)}</a>` : ''}</div>
    </div>` : '';
  return { dark: true, corps: `
 <div class="ey">${esc(o.eyebrow)}</div>
 <div class="cv-t">
  <div><h1>${o.titre}</h1><div class="rule"></div></div>
  <figure class="cv-i">${illu ? `<img src="${esc(illu.image)}" alt="${esc(illu.description || '')}">` : repli}</figure>
 </div>
 <p class="lead">${o.chapo}</p>
 <p class="cv-for">Préparée pour<b>${esc(client)}${r.sites > 1 ? ` · ${r.sites} établissements` : ''}</b></p>
 <div class="hero">
  <div class="hero-l">${r.seuil_ventes_mois != null ? 'Rentabilisé avec' : 'Gain potentiel la première année'}</div>
  <div class="hero-v g">${r.seuil_ventes_mois != null ? `${ent(r.seuil_ventes_mois)} ${r.seuil_ventes_mois > 1 ? o.unite[1] : o.unite[0]} par mois` : eur(r.gain_an)}</div>
  <div class="hero-s">pour un investissement de <b>${eur(r.cout_mois)} HT par mois</b>. Avec les hypothèses de cette étude, le gain potentiel atteint <b>${eur(r.gain_an)}</b> la première année${r.roi != null && r.roi >= 1 ? `, soit <b>${roiX(r.roi)}</b> la mise` : ''}.</div>
  ${leviersV.length > 1 ? `<div class="pile">${leviersV.map(l => `<i style="flex:${Math.max(1, Math.round(l.gain_an))};background:${COULEURS[l.id]}"></i>`).join('')}</div>
  <div class="pile-l">${leviersV.map(l => `<span><i style="background:${COULEURS[l.id]}"></i>${esc(l.label)} · <b>${eur(l.gain_an)}</b></span>`).join('')}</div>` : ''}
 </div>
 <div class="k3">${o.kpis.join('')}</div>
 ${contact}` };
}

function pageCalcul(o) {
  const { r, c, lignesCout, hypotheses } = o;
  const leviersV = r.leviers.filter(l => l.actif && l.gain_an > 0);
  const maxGain = Math.max(1, ...leviersV.map(l => l.gain_an));
  return { corps: `
 <div class="ey">Le calcul</div>
 <h2>Un retour sur investissement <span class="g">calculé sur ${o.surCa ? "le chiffre d'affaires" : 'la marge'}</span></h2>
 <div class="rule"></div>
 <table>
  <tr><th>Première année</th><th>CA généré</th><th>Gain</th></tr>
  ${leviersV.map(l => `<tr class="lv"><td><i class="pt" style="background:${COULEURS[l.id]}"></i>${esc(l.label)}</td><td>${l.ca_an ? eur(l.ca_an) : '—'}</td><td>${eur(l.gain_an)}</td></tr>
  <tr class="jauge"><td colspan="3"><i style="width:${Math.max(1, Math.round(l.gain_an / maxGain * 100))}%;background:${COULEURS[l.id]}"></i></td></tr>`).join('')}
  <tr class="st"><td>Gain total (${o.surCa ? 'ventes' : 'marge'} + temps rendu)</td><td>${eur(r.ca_an)}</td><td>${eur(r.gain_an)}</td></tr>
  ${lignesCout.map(([l, v]) => `<tr><td>${l}</td><td></td><td class="neg">− ${eur(v)}</td></tr>`).join('')}
  <tr class="tot"><td>Gain net la première année</td><td></td><td>${eur(r.gain_net_an)}</td></tr>
 </table>
 <div class="k4" style="margin-top:18px">
  ${kpi(roiX(r.roi), 'retour sur investissement (gain ÷ coût)', true)}
  ${kpi(r.payback_jours != null && r.roi >= 1 ? ent(r.payback_jours) + NBSP + 'j' : '—', `pour que ${esc(o.produit)} soit rentabilisé`)}
  ${kpi(r.seuil_ventes_mois != null ? ent(r.seuil_ventes_mois) : '—', `${o.unite[1]} par mois suffisent à le payer`)}
  ${kpi(eur(r.gain_net_3ans), 'de gain net cumulé sur 3 ans')}
 </div>
 ${o.scenarios ? `<div class="h3">Du scénario prudent au scénario ambitieux</div>
 ${tableScenarios(o.scenarios, { unite: o.unite, marge: !o.surCa, note: o.noteScenarios || '' })}` : `${r.roi_prudent != null && r.roi_prudent >= 1 ? `<div class="prud">✅ <b>Même avec des hypothèses deux fois moins favorables</b>, ${esc(o.produit)} rapporte ${roiX(r.roi_prudent)} sa mise : l'investissement reste rentable.</div>`
    : `<div class="prud">ℹ️ Ce chiffrage dépend surtout de <b>${esc(o.sensible)}</b> : c'est la valeur à vérifier ensemble en premier. Le seuil de rentabilité, lui, ne dépend que de votre panier moyen et du prix de l'abonnement.</div>`}`}
 <div class="h3">Les hypothèses retenues — à ajuster avec vous</div>
 <div class="cols">
  ${hypotheses.map(col => `<div>${col.map(([titre, lignes]) => `<div class="hb"><h5>${titre}</h5><table class="hyp">${lignes.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}</table></div>`).join('')}</div>`).join('')}
 </div>` };
}

// Page « Trois scénarios » (Soview, SoReach) : le tableau Bas / Moyen / Haut et sa lecture.
function pageScenarios(o) {
  if (!o.sc) return null;
  return { corps: `
 <div class="ey">Trois scénarios</div>
 <h2>Du scénario prudent <span class="g">au scénario ambitieux</span></h2>
 <div class="rule"></div>
 <p class="tx" style="max-width:none">${esc(o.intro)}</p>
 ${tableScenarios(o.sc, { unite: o.unite, marge: !o.surCa, avant: o.avant, note: o.note })}
 <div class="h3">Comment lire ce tableau</div>
 <div class="res" style="grid-template-columns:1fr">
  ${o.lecture.map((x, i) => `<div><i>${i + 1}</i><span><b>${esc(x[0])}</b> ${esc(x[1])}</span></div>`).join('')}
 </div>` };
}

function pageFin(o) {
  return { dark: true, pied: PIED_ESTIMATION, corps: `
 <div class="ey">${esc(o.eyebrow)}</div>
 <h2>${o.titre}</h2>
 <div class="rule"></div>
 <div class="why">
  ${o.points.map((b, i) => `<div class="w"><div class="w-n">${i + 1}</div><div><div class="w-t">${esc(b[0])}</div><div class="w-x">${esc(b[1])}</div></div></div>`).join('')}
 </div>
 ${blocFin(o.sdr, o.lienDemo, o.bouton, o.texte)}` };
}

// ── Étude Soview ──
function ecartsSoview(m) {
  const E = [];
  const v = x => String(x).replace('.', ',');
  if (m.note != null && m.note_concurrents != null) {
    const d = Math.round((m.note_concurrents - m.note) * 10) / 10;
    E.push(d >= 0.1
      ? { ok: false, t: `Note Google de ${v(m.note)} contre ${v(m.note_concurrents)} en moyenne chez vos concurrents locaux : ${v(d)} point d'écart.` }
      : { ok: true, t: `Note Google de ${v(m.note)}, au niveau ou au-dessus de vos concurrents locaux (${v(m.note_concurrents)} en moyenne).` });
  }
  if (m.position != null) E.push(m.position > 3
    ? { ok: false, t: `${m.position}ᵉ${m.requete ? ` sur « ${m.requete} »` : ' dans les résultats locaux'} : en dehors des trois établissements que Google affiche en premier.` }
    : { ok: true, t: `${m.position === 1 ? '1er' : m.position + 'ᵉ'}${m.requete ? ` sur « ${m.requete} »` : ' dans les résultats locaux'} : dans le trio de tête affiché par Google.` });
  if (m.taux_reponse != null) E.push(m.taux_reponse < 50
    ? { ok: false, t: m.taux_reponse === 0 ? "Aucun de vos avis récents n'a reçu de réponse publique." : `${v(m.taux_reponse)} % seulement de vos avis récents ont une réponse publique.` }
    : { ok: true, t: `${v(m.taux_reponse)} % de vos avis récents ont une réponse publique.` });
  if (m.ia_present === true) E.push(m.ia_cite
    ? { ok: true, t: "L'aperçu IA de Google s'affiche sur votre recherche et vous cite." }
    : { ok: false, t: "L'aperçu IA de Google s'affiche sur votre recherche et ne vous cite pas." });
  return E;
}

function pageSoview(doc, meta, sdr, apercu, lienDemo, preuves) {
  const c = doc.config || {}, r = calculerSoview(c), m = c.mesures || {};
  const client = doc.client || 'votre entreprise';
  const date = new Date(meta.cree_le || Date.now()).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const unite = ['client', 'clients'];
  const E = ecartsSoview(m);
  const mesure = m.note != null || m.position != null || m.avis != null;
  const v = x => String(x).replace('.', ',');
  const P = [];
  P.push(couverture({ r, client, sdr, illu: preuves.illustration, repli: ILLU_LOCAL, unite,
    eyebrow: 'Étude de rentabilité · Soview, votre visibilité locale',
    titre: 'Vos clients vous cherchent sur Google. <span class="g">Qui trouvent-ils ?</span>',
    chapo: `Ce document part de ce que nous avons mesuré sur les fiches Google de ${esc(client)}, puis chiffre ce que rapporte une visibilité locale tenue : combien de clients en plus suffisent à payer Soview, et ce qu'il peut rapporter au-delà.`,
    kpis: [
      kpi(ent(r.actions_mois), 'contacts par mois venus de Google : appels, itinéraires, visites du site'),
      kpi(nb(r.clients_plus_mois), 'clients en plus par mois visés'),
      kpi(ent(r.heures_an) + NBSP + 'h', 'de gestion et de réponses aux avis rendues par an')
    ] }));
  const s = pageSynthese(r, { produit: 'Soview', unite, enPlus: true, demandes: 'contacts par mois venus de Google', demandesCourt: 'contacts venus de Google',
    panier: 'Panier moyen', temps: 'réponses aux avis, mise à jour des fiches' });
  if (s) P.push(s);
  P.push({ corps: `
 <div class="ey">${mesure ? 'Ce que nous avons mesuré' : 'Votre visibilité locale'}</div>
 <h2>${mesure ? `Votre fiche Google, <span class="g">vue par vos clients</span>` : `Ce que vos clients voient <span class="g">avant de vous appeler</span>`}</h2>
 <div class="rule"></div>
 ${mesure ? `<div class="k4">
  ${m.note != null ? kpi(v(m.note) + NBSP + '★', `votre note Google${m.fiches > 1 ? `, sur ${ent(m.fiches)} fiches` : ''}`, true) : ''}
  ${m.note_concurrents != null ? kpi(v(m.note_concurrents) + NBSP + '★', 'note moyenne de vos concurrents locaux') : ''}
  ${m.avis != null ? kpi(ent(m.avis), 'avis sur vos fiches') : ''}
  ${m.position != null ? kpi((m.position === 1 ? '1er' : m.position + 'ᵉ'), m.requete ? `sur « ${esc(m.requete)} »` : 'dans les résultats locaux') : ''}
 </div>` : ''}
 ${E.length ? `<div class="h3">Ce que ces mesures disent</div>
 <div class="res" style="grid-template-columns:1fr">${E.map(e => `<div><i style="${e.ok ? '' : 'background:#D92D6A'}">${e.ok ? '✓' : '!'}</i><span>${esc(e.t)}</span></div>`).join('')}</div>` : ''}
 ${(m.premiers || []).length ? `<div class="h3">Ceux que Google affiche avant vous</div>
 <table><tr><th>Établissement</th><th>Note</th><th>Avis</th></tr>
  ${m.premiers.map(x => `<tr><td>${esc(x.nom)}</td><td>${x.note != null ? v(x.note) + NBSP + '★' : '—'}</td><td>${x.avis != null ? ent(x.avis) : '—'}</td></tr>`).join('')}
 </table>` : ''}
 <div class="h3">Ce que Soview change</div>
 <div class="res">
  <div><i>1</i><span><b>Vos fiches, à jour partout.</b> Une seule saisie diffusée sur Google, Maps, Apple Plans, Waze, Facebook et Instagram.</span></div>
  <div><i>2</i><span><b>Vos avis, collectés et traités.</b> Invitations par SMS, QR code ou carte NFC ; réponses rédigées par Budy, validées par vous.</span></div>
  <div><i>3</i><span><b>Vos résultats, lisibles.</b> Visibilité locale et comparaison avec vos concurrents directs, sans tableau de bord illisible.</span></div>
  <div><i>4</i><span><b>Un coach Sofy dédié.</b> Un interlocuteur qui connaît votre réseau, inclus dans l'abonnement.</span></div>
 </div>
 ${mesure ? `<p class="note">Mesures relevées par Sofy sur les résultats publics de Google${m.requete ? ` pour la recherche « ${esc(m.requete)} »` : ''}. Elles décrivent un instant : une position locale varie selon le lieu et le moment de la recherche.</p>` : ''}` });
  const pSc = pageScenarios({ sc: scenariosDe(c), unite, surCa: !r.sur_marge,
    intro: "Une seule hypothèse change d'une colonne à l'autre : la hausse des contacts que Google vous envoie une fois vos fiches tenues, vos avis traités et votre position locale travaillée. Tout le reste vient de vos chiffres.",
    avant: [['Contacts venus de Google par mois', ent(r.actions_mois)], ['Clients actuels via Google par mois', ent(r.clients_actuels_mois)], ['Panier moyen', eur(c.panier || 0)]],
    note: 'Gain calculé sur ' + (r.sur_marge ? 'la marge' : "le chiffre d'affaires") + ' des clients gagnés, hors temps rendu (' + eur(r.valeur_temps_mois) + ' par mois en plus, quel que soit le scénario).',
    lecture: [['La hausse retenue est une hypothèse.', "Elle dépend de votre point de départ : plus l'écart avec vos concurrents est grand, plus la marge de progression l'est aussi."],
      ['Le scénario moyen est celui de cette étude.', "C'est lui qui donne les montants des autres pages."],
      ['Le temps rendu ne dépend pas du scénario.', "Réponses aux avis et gestion des fiches sont gagnées dans les trois colonnes."]] });
  if (pSc) P.push(pSc);
  P.push(pageCalcul({ r, c, produit: 'Soview', unite, surCa: !r.sur_marge, sensible: 'la hausse de visibilité retenue',
    lignesCout: [[`Abonnement Soview (${eur(c.abonnement || 0)}/mois${r.sites > 1 ? ` × ${r.sites} établissements` : ''} × 12)`, r.abonnement_mois * 12]].concat(r.frais ? [['Mise en place', r.frais]] : []),
    hypotheses: [
      [['Votre fiche Google aujourd\'hui', [['Établissements', r.sites], ['Vues de la fiche par mois et par établissement', ent(c.vues_mois || 0)], ['Vues suivies d\'une action (appel, itinéraire, site)', p0(c.taux_action)], ['Actions qui deviennent un client', p0(c.taux_transfo)], ['Panier moyen', eur(c.panier || 0)]].concat(r.sur_marge ? [['Marge', p0(c.marge)]] : [])]],
      [['Avec Soview', [['Hausse des contacts venus de Google', '+ ' + p0(c.gain_visibilite)], ['Avis reçus par mois et par établissement', ent(c.avis_mois || 0)], ['Temps pour répondre à un avis aujourd\'hui', fmt(c.min_reponse || 0, 0) + ' min'], ['Gestion des fiches économisée par établissement', fmt(c.heures_gestion || 0, 1) + ' h / mois'], ['Coût horaire chargé', (c.off && c.off.cout_temps) ? 'temps rendu non valorisé' : eur(c.cout_horaire || 0)]]]]
    ] }));
  const pp = pagePreuve(preuves.cas, preuves.logos);
  if (pp) P.push(pp);
  P.push(pageFin({ sdr, lienDemo, eyebrow: 'Pourquoi Sofy', titre: 'Une équipe qui connaît votre réseau, <span class="g">et un outil qui tient dans la durée</span>',
    points: [
      ['Budy, votre IA incluse', "Réponses aux avis, suggestions de publication, analyse concurrentielle : sans surcoût ni option."],
      ['Un déploiement en 12 semaines', "État des lieux et score par établissement, mise en ordre des fiches, puis régime de croisière : réponses sous 24 à 48 heures sur tout le réseau."],
      ['La voix, l\'écrit et les campagnes au même endroit', "Soview s'articule avec SoConnect (messagerie) et SoReach (SMS et RCS) : un avis demandé par SMS, une réponse au client dans la même boîte."],
      ['Une équipe qui reste', "Sofy est une marque d'Optima Group, éditeur de SunSMS : 14 ans de messagerie d'entreprise et de visibilité locale. Une coach dédiée suit votre déploiement."]
    ], bouton: 'Réserver une démonstration de Soview →', texte: 'Trente minutes sur vos propres fiches : ce qui se voit, ce qui manque, par où commencer.' }));
  return gabarit(P, { client, date, apercu, nom: 'Étude de rentabilité Soview' });
}

// ── Étude SoReach SMS / RCS ──
function pageSoreach(doc, meta, sdr, apercu, lienDemo, preuves) {
  const c = doc.config || {}, r = calculerSoreach(c);
  const client = doc.client || 'votre entreprise';
  const date = new Date(meta.cree_le || Date.now()).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const unite = ['vente', 'ventes'];
  const etape = (l, v, max, coul) => `<div><div class="bar-h"><span>${l}</span><b>${v}</b></div><div class="bar"><i style="width:${Math.max(2, Math.min(100, max))}%;${coul ? 'background:' + coul : ''}"></i></div></div>`;
  const pc = r.messages_mois > 0 ? x => x / r.messages_mois * 100 : () => 0;
  const P = [];
  P.push(couverture({ r, client, sdr, illu: preuves.illustration, repli: ILLU_MOBILE, unite,
    eyebrow: 'Étude de rentabilité · SoReach, vos campagnes SMS et RCS',
    titre: 'Votre base clients est un chiffre d\'affaires <span class="g">qui dort.</span>',
    chapo: `Ce document chiffre ce que ${esc(client)} peut attendre de campagnes SMS et RCS régulières sur sa propre base de contacts : combien de ventes suffisent à payer les envois, et ce qu'elles peuvent rapporter au-delà.`,
    kpis: [
      kpi(ent(r.messages_mois), 'messages envoyés par mois à vos propres clients'),
      kpi(nb(r.ventes_mois), 'ventes par mois visées'),
      kpi(eur(r.ca_an), 'de chiffre d\'affaires généré par an')
    ] }));
  const s = pageSynthese(r, { produit: 'SoReach', unite, demandes: 'messages envoyés par mois à vos clients', demandesCourt: 'messages envoyés', sansJour: true,
    panier: 'Panier moyen', temps: 'rédaction et ciblage des campagnes' });
  if (s) P.push(s);
  P.push({ corps: `
 <div class="ey">De l'envoi à la vente</div>
 <h2>Un message lu, <span class="g">un bouton, une vente</span></h2>
 <div class="rule"></div>
 <div class="rl">
  <div>
   <div class="bars">
    ${etape('Messages envoyés par mois', ent(r.messages_mois), 100)}
    ${etape('Clients qui cliquent', ent(r.clics_mois), pc(r.clics_mois))}
    ${etape('Ventes', nb(r.ventes_mois), pc(r.ventes_mois) * 4, '#F0428A')}
   </div>
   <div class="k3 mini" style="margin-top:16px">
    ${kpi(eur(r.ca_mois), 'de chiffre d\'affaires par mois', true)}
    ${kpi(eur(r.cout_mois), 'd\'envois et d\'abonnement par mois')}
    ${kpi(r.cout_mois > 0 ? fmt(r.ca_mois / r.cout_mois, 1) + NBSP + '€' : '—', 'de CA pour 1 € d\'envoi')}
   </div>
  </div>
  ${bulle('RCS', client, [['b', 'Bonjour Julie, votre avantage fidélité vous attend jusqu\'à dimanche : −15 % sur votre prochaine visite. On vous réserve un créneau ?']], ['Je réserve', 'Voir l\'offre'])}
 </div>
 <div class="h3">Pourquoi le RCS change la campagne</div>
 <div class="res">
  <div><i>1</i><span><b>Un émetteur vérifié.</b> Votre nom, votre logo et un badge de vérification : le client sait que c'est vous.</span></div>
  <div><i>2</i><span><b>Des boutons, pas un lien à recopier.</b> « Prendre rendez-vous », « Laisser un avis », carrousels, images : une mini-page dans la messagerie.</span></div>
  <div><i>3</i><span><b>Une conversation.</b> Le client répond dans le même fil, et l'échange arrive dans SoConnect avec son historique.</span></div>
  <div><i>4</i><span><b>Aucun message perdu.</b> Bascule automatique en SMS quand le téléphone ne prend pas le RCS.</span></div>
 </div>
 <div class="h3">Ce que mesure un réseau client</div>
 <div class="mk">
  <div><b>85,7 %</b><span>de taux d'ouverture sur ses campagnes SMS<i>Groupe Kiosque, 32 points de vente — interview client Sofy</i></span></div>
  <div><b>47 %</b><span>de taux de clic sur ces mêmes campagnes<i>Groupe Kiosque, 32 points de vente — interview client Sofy</i></span></div>
 </div>
 <p class="note">Sofy est Google Partner RBM : l'agent RCS de votre enseigne est vérifié par Google, et Sofy porte le déploiement. L'exemple de message est illustratif.</p>` });
  const pSc = pageScenarios({ sc: scenariosDe(c), unite, surCa: !r.sur_marge,
    intro: "Une seule hypothèse change d'une colonne à l'autre : la part des clients qui achètent après avoir cliqué. Tout le reste — taille de la base, rythme des campagnes, panier — vient de vos chiffres.",
    avant: [['Messages envoyés par mois', ent(r.messages_mois)], ['Clients qui cliquent par mois', ent(r.clics_mois)], ['Panier moyen', eur(c.panier || 0)]],
    note: 'Gain calculé sur ' + (r.sur_marge ? 'la marge' : "le chiffre d'affaires") + ' des ventes, coût des envois déduit.',
    lecture: [['Le coût des envois est le même partout.', "Un message coûte autant qu'il déclenche une vente ou non : c'est ce qui rend le scénario bas instructif."],
      ['Le scénario moyen est celui de cette étude.', "C'est lui qui donne les montants des autres pages."],
      ['Une campagne se mesure.', "Dès le premier envoi, les clics et les ventes réels remplacent ces hypothèses."]] });
  if (pSc) P.push(pSc);
  P.push(pageCalcul({ r, c, produit: 'SoReach', unite, surCa: !r.sur_marge, sensible: 'le taux de clic et le taux de conversion retenus',
    lignesCout: [[`Messages (${ent(r.messages_mois)}/mois × ${eur2(c.cout_message || 0)} × 12)`, r.cout_messages_mois * 12]]
      .concat(r.abonnement_mois ? [[`Abonnement (${eur(c.abonnement || 0)}/mois × 12)`, r.abonnement_mois * 12]] : [])
      .concat(r.frais ? [['Mise en place', r.frais]] : []),
    hypotheses: [
      [['Votre base', [['Établissements', r.sites], ['Contacts joignables par établissement', ent(c.contacts || 0)], ['Campagnes par mois', fmt(c.campagnes_mois || 0, 1)], ['Coût d\'un message', eur2(c.cout_message || 0)]]]],
      [['Ce que les campagnes déclenchent', [['Messages suivis d\'un clic', p0(c.taux_clic)], ['Clics suivis d\'un achat', p0(c.taux_conv)], ['Panier moyen', eur(c.panier || 0)]].concat(r.sur_marge ? [['Marge', p0(c.marge)]] : []).concat([['Temps gagné par campagne', fmt(c.heures_campagne || 0, 1) + ' h'], ['Coût horaire chargé', (c.off && c.off.cout_temps) ? 'temps rendu non valorisé' : eur(c.cout_horaire || 0)]])]]
    ] }));
  const pp = pagePreuve(preuves.cas, preuves.logos);
  if (pp) P.push(pp);
  P.push(pageFin({ sdr, lienDemo, eyebrow: 'Pourquoi Sofy', titre: 'Quatorze ans de messagerie d\'entreprise, <span class="g">et le RCS vérifié par Google</span>',
    points: [
      ['Un opérateur, pas un revendeur', "Sofy est une marque d'Optima Group, éditeur de SunSMS : agrégateur direct, habilité ARCEP, 14 ans d'envois pour les enseignes."],
      ['Budy prépare la campagne', "Ciblage, rédaction, personnalisation : vous validez, Budy envoie au bon moment."],
      ['La réponse du client ne se perd pas', "Chaque réponse arrive dans SoConnect, à côté de WhatsApp, Messenger et du webchat."],
      ['Une coach dédiée', "Un interlocuteur qui connaît vos saisons et vos points de vente, inclus."]
    ], bouton: 'Réserver une démonstration de SoReach →', texte: 'Trente minutes pour monter ensemble votre première campagne RCS.' }));
  return gabarit(P, { client, date, apercu, nom: 'Étude de rentabilité SoReach' });
}

// ── Étude SoConnect (hors automobile) ──
function pageSoconnect(doc, meta, sdr, apercu, lienDemo, preuves) {
  const c = doc.config || {}, r = calculerSoconnect(c);
  const client = doc.client || 'votre entreprise';
  const date = new Date(meta.cree_le || Date.now()).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const unite = ['vente', 'ventes'];
  const sc = scenariosDe(c);
  const surCa = !r.sur_marge;
  const noteTemps = r.heures_mois >= 1 ? `En plus, quel que soit le scénario : ${ent(r.heures_mois)} h par mois de préqualification rendues à vos vendeurs, soit ${eur(r.valeur_temps_mois)}.` : '';
  const P = [];
  P.push(couverture({ r, client, sdr, illu: preuves.illustration, repli: ILLU_MOBILE, unite,
    eyebrow: 'Étude de rentabilité · SoConnect, toutes vos demandes dans une seule boîte',
    titre: 'Chaque demande sans réponse est une vente <span class="g">pour un autre.</span>',
    chapo: `Ce document chiffre ce que ${esc(client)} récupère quand plus aucune demande WhatsApp, Messenger, Instagram ou webchat ne reste sans réponse : combien de ventes suffisent à payer SoConnect, et trois scénarios pour la suite.`,
    kpis: [
      kpi(ent(r.demandes_total_mois), 'demandes reçues par mois, tous canaux'),
      kpi(ent(r.prises_mois), 'demandes aujourd\'hui non traitées, reprises par SoConnect'),
      kpi(ent(r.heures_mois) + NBSP + 'h', 'de préqualification rendues à vos vendeurs par mois')
    ] }));
  const s = pageSynthese(r, { produit: 'SoConnect', unite, enPlus: true, demandes: 'demandes par mois', demandesCourt: 'demandes',
    panier: 'Commande moyenne', temps: 'préqualification des demandes par Budy' });
  if (s) P.push(s);
  P.push({ corps: `
 <div class="ey">Trois scénarios</div>
 <h2>Du scénario prudent <span class="g">au scénario ambitieux</span></h2>
 <div class="rule"></div>
 <p class="tx" style="max-width:none">Une seule hypothèse change d'une colonne à l'autre : la part des demandes reprises qui se transforment en vente. Tout le reste vient de vos chiffres.</p>
 ${tableScenarios(sc, { unite, marge: !surCa, avant: [
    ['Demandes par mois', ent(r.demandes_total_mois)],
    ['Demandes non traitées aujourd\'hui', p0(c.taux_non_traitees)],
    ['Demandes prises en charge par SoConnect', ent(r.prises_mois)],
    ['Panier moyen', eur(c.panier || 0)]
  ], note: `Gain calculé sur ${surCa ? "le chiffre d'affaires" : 'la marge'}. ${noteTemps}` })}
 <div class="h3">Ce que SoConnect change</div>
 <div class="rl">
  <div class="res" style="grid-template-columns:1fr">
   <div><i>1</i><span><b>Quatre canaux écrits, une seule boîte.</b> WhatsApp, webchat du site, Facebook et Messenger, RCS : un canal de plus n'ajoute pas un écran de plus.</span></div>
   <div><i>2</i><span><b>Budy pré-qualifie.</b> Il répond tout de suite, relève le besoin et les coordonnées, puis passe la main à votre équipe avec l'historique.</span></div>
   <div><i>3</i><span><b>Ouvert quand vos clients écrivent.</b> Le soir et le week-end, la demande est prise et attend votre équipe à l'ouverture.</span></div>
   <div><i>4</i><span><b>Rien ne se perd.</b> Chaque demande a un responsable, un statut et une relance.</span></div>
  </div>
  ${bulle('WhatsApp', client, [['c', 'Bonjour, vous avez ce modèle en stock ? J\'en aurais besoin pour samedi.'], ['b', 'Bonjour ! Je regarde ça pour vous. Pour quel usage, et à quel nom dois-je préparer le devis ?']], ['Recevoir le devis', 'Être rappelé'])}
 </div>
 <p class="note">L'exemple de message est illustratif.</p>` });
  P.push(pageCalcul({ r, c, produit: 'SoConnect', unite, surCa, sensible: 'le taux de conversion retenu',
    lignesCout: [[`Abonnement SoConnect (${eur(c.abonnement || 0)}/mois${r.sites > 1 ? ` × ${r.sites} établissements` : ''} × 12)`, r.abonnement_mois * 12]].concat(r.frais ? [['Mise en place', r.frais]] : []),
    hypotheses: [
      [['Vos demandes', [['Établissements', r.sites], ['Demandes par mois et par établissement', ent(c.demandes_mois || 0)], ['Demandes non traitées aujourd\'hui', p0(c.taux_non_traitees)], ['Taux de conversion (scénario moyen)', p0(c.taux_conversion)]]]],
      [['Ce que vaut une vente', [['Panier moyen', eur(c.panier || 0)]].concat(surCa ? [] : [['Marge', p0(c.marge)]]).concat([['Temps gagné par demande traitée', fmt(c.min_gagnees || 0, 1) + ' min'], ['Coût horaire chargé d\'un vendeur', (c.off && c.off.cout_temps) ? 'temps rendu non valorisé' : eur(c.cout_horaire || 0)]])]]
    ] }));
  const pp = pagePreuve(preuves.cas, preuves.logos);
  if (pp) P.push(pp);
  P.push(pageFin({ sdr, lienDemo, eyebrow: 'Pourquoi Sofy', titre: 'Une seule interface, <span class="g">et une équipe qui reste</span>',
    points: [
      ['Budy, votre IA incluse', "Pré-qualification, réponses aux questions récurrentes, relances : sans surcoût ni option."],
      ['Vos avis et vos campagnes au même endroit', "SoConnect s'articule avec Soview (fiches Google, avis) et SoReach (SMS et RCS) : la réponse du client arrive dans la même boîte."],
      ['Une mise en route accompagnée', "Une coach dédiée branche vos canaux, forme votre équipe et suit les premières semaines."],
      ['Une équipe qui reste', "Sofy est une marque d'Optima Group, éditeur de SunSMS : 14 ans de messagerie d'entreprise."]
    ], bouton: 'Réserver une démonstration de SoConnect →', texte: 'Trente minutes sur vos propres demandes : WhatsApp, Messenger, webchat.' }));
  return gabarit(P, { client, date, apercu, nom: 'Étude de rentabilité SoConnect' });
}

export function pageEtude(doc, meta, sdr, apercu, lienDemo, preuves) {
  preuves = preuves || {};
  const produit = produitDe(doc.config);
  if (produit === 'soview') return pageSoview(doc, meta, sdr, apercu, lienDemo, preuves);
  if (produit === 'soreach') return pageSoreach(doc, meta, sdr, apercu, lienDemo, preuves);
  if (produit === 'soconnect') return pageSoconnect(doc, meta, sdr, apercu, lienDemo, preuves);
  return pageRoi(doc, meta, sdr, apercu, lienDemo, preuves);
}
