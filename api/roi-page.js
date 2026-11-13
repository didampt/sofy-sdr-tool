// /api/roi-page.js — 💶 Simulateur ROI « Budy Auto » : moteur de calcul + étude client.
//
// Pas de default export : ce fichier est une bibliothèque, partagée par
//  · /api/roi.js  — crée / met à jour l'étude, et sert le moteur au front (?script=1) ;
//  · /api/p.js    — rend l'étude publique sur /p/<jeton> (suivi d'ouverture, alerte Slack, PDF).
//
// ⚠️ UNE SEULE SOURCE DE CALCUL. Le front exécute `calculerRoi` tel quel (servi par
// /api/roi?script=1 via Function.toString) : la fonction doit rester AUTONOME — aucune variable
// extérieure, aucun import. Un chiffre affiché au commercial et un chiffre lu par le client ne
// peuvent ainsi jamais diverger.
//
// Huit leviers, chacun désactivable (config.off.<id>) :
//   appels     appels manqués repris par Budy (voix, 24 h/24)
//   messages   messages WhatsApp / RCS / webchat restés sans réponse rapide
//   devis      relance WhatsApp / RCS des devis sans suite
//   atelier    rappels de rendez-vous atelier (anti no-show)
//   revisions  relance des révisions selon le plan d'entretien constructeur (TecRMI)
//   upsell     vente additionnelle guidée par la préconisation (plaquettes → disques)
//   identif    bonne pièce depuis l'immatriculation (TecDoc + SIV) : temps et retours évités
//   temps      appels et messages traités seul par Budy
//
// Règle de prudence (même esprit que prez.js) : chaque chiffre de marché porte sa source et sa
// date ; tout le reste est une HYPOTHÈSE affichée en clair dans le document, que le client peut
// contester ligne par ligne. Le retour sur investissement est calculé sur la MARGE, pas sur le
// chiffre d'affaires : c'est ce qui le rend défendable devant un DAF.

export function calculerRoi(c) {
  const n = (v, d) => { const x = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const borne = (v, a, b) => Math.max(a, Math.min(b, v));
  const pct = (v, d) => borne(n(v, d), 0, 100) / 100;
  const pos = (v, d, max) => borne(n(v, d), 0, max);
  c = c || {};
  const off = c.off || {};
  const on = k => !off[k];
  const sites = borne(Math.round(n(c.sites, 1)), 1, 500);
  const jours = borne(n(c.jours_mois, 22), 1, 31);
  // Valoriser le temps rendu est une OPTION (demande Didier 13/11/2026) : décochée, les heures
  // restent affichées mais ne comptent plus dans le gain.
  const coutH = off.cout_temps ? 0 : pos(c.cout_horaire, 32, 500);
  const tBudy = pct(c.taux_budy, 90);
  const tAuto = pct(c.automatisation, 30);

  // ── Motifs : ce que vaut, en moyenne, un client à qui l'on répond enfin ──
  // Deux façons de dire ce que vaut un client sauvé : UN panier moyen (mode simple, par défaut —
  // la question que le commercial pose au client) ou le détail par motif d'appel.
  const simple = c.panier_mode === 'simple';
  // Mode simple : UN panier moyen vaut pour toutes les ventes — appels, messages, devis, atelier,
  // révisions, ventes additionnelles (décision Didier 13/11/2026). En détail, chaque levier a le sien.
  const pUnique = simple ? Math.max(0, n(c.panier_moyen, 0)) : null;
  // Base du gain : le CHIFFRE D'AFFAIRES par défaut (décision Didier 13/11/2026, comme le tableau
  // de Romain) ; 'marge' applique la marge de chaque levier.
  const surMarge = c.seuil_base === 'marge';
  const motifsIn = simple
    ? [{ id: 'moyen', label: 'Vente moyenne', unite: 'ventes', part: 100, conv: n(c.taux_conversion, 0), panier: n(c.panier_moyen, 0), marge: n(c.marge_moyenne, 0) }]
    : (Array.isArray(c.motifs) ? c.motifs : []);
  const somme = motifsIn.reduce((s, m) => s + Math.max(0, n(m && m.part, 0)), 0) || 1;
  const mix = motifsIn.map(m => ({
    id: String(m.id || ''), label: String(m.label || ''), unite: String(m.unite || 'ventes'),
    part: Math.max(0, n(m.part, 0)) / somme, conv: pct(m.conv, 0), panier: Math.max(0, n(m.panier, 0)), marge: pct(m.marge, 0)
  }));
  const valeurOpp = mix.reduce((s, m) => s + m.part * m.conv * m.panier, 0);            // CA moyen par client sauvé
  const margeOpp = mix.reduce((s, m) => s + m.part * m.conv * m.panier * m.marge, 0);   // marge moyenne

  // ── 1. Appels ──
  const appelsMois = sites * pos(c.appels_jour, 100, 5000) * jours;
  const hors = appelsMois * pct(c.hors_horaires, 10);      // hors horaires : personne pour décrocher
  const dansHoraires = appelsMois - hors;
  const manquesJour = dansHoraires * pct(c.taux_manques, 28);
  const manques = hors + manquesJour;
  const decroches = dansHoraires - manquesJour;
  const tPerdus = pct(c.taux_perdus, 35);
  const oppPerduesAuj = manques * tPerdus;                  // clients qui ne rappellent pas
  const reprises = on('appels') ? manques * tBudy : 0;
  const oppRecup = reprises * tPerdus;
  const motifs = mix.map(m => {
    const ventes = oppRecup * m.part * m.conv, ca = ventes * m.panier;
    return { id: m.id, label: m.label, unite: m.unite, part: Math.round(m.part * 1000) / 10, conv: m.conv * 100,
      panier: m.panier, marge: m.marge * 100, appels: oppRecup * m.part, ventes, ca_mois: ca, marge_mois: ca * m.marge };
  });
  const caAppels = oppRecup * valeurOpp, gAppels = oppRecup * margeOpp;

  // ── 2. Messages écrits (WhatsApp, RCS, Messenger, webchat) ──
  const msgMois = sites * pos(c.messages_jour, 0, 5000) * jours;
  const msgPerdus = msgMois * pct(c.taux_msg_perdus, 0);   // sans réponse rapide : le client est parti
  const msgRecup = on('messages') ? msgPerdus * tBudy : 0;
  const caMsg = msgRecup * valeurOpp, gMsg = msgRecup * margeOpp;

  // ── 3. Relance des devis sans suite ──
  const devisMois = sites * pos(c.devis_mois, 0, 50000);
  const devisSansSuite = devisMois * pct(c.taux_devis_sans_suite, 0);
  const devisRecupPot = devisSansSuite * pct(c.taux_devis_conv, 0);
  const panierDevis = pUnique != null ? pUnique : pos(c.panier_devis, 0, 100000);
  const devisRecup = on('devis') ? devisRecupPot : 0;
  const caDevis = devisRecup * panierDevis, gDevis = caDevis * pct(c.marge_devis, 0);

  // ── 4. Rappels de rendez-vous atelier (no-show) ──
  const rdvMois = sites * pos(c.rdv_mois, 0, 50000);
  const noshow = rdvMois * pct(c.taux_noshow, 0);
  const panierRdv = pUnique != null ? pUnique : pos(c.panier_rdv, 0, 100000);
  const mRdv = pct(c.marge_rdv, 0);
  const noshowEvites = on('atelier') ? noshow * pct(c.reduction_noshow, 0) : 0;
  const caNoshow = noshowEvites * panierRdv, gNoshow = caNoshow * mRdv;

  // ── 5. Relance des révisions (plan d'entretien constructeur, TecRMI) ──
  const revRelances = sites * pos(c.revisions_mois, 0, 50000);
  const panierRev = pUnique != null ? pUnique : pos(c.panier_revision, 0, 100000);
  const revPot = revRelances * pct(c.taux_revision_conv, 0);
  const revRdv = on('revisions') ? revPot : 0;
  const caRev = revRdv * panierRev, gRev = caRev * mRdv;

  // ── 6. Vente additionnelle guidée par la préconisation ──
  const upsBase = sites * pos(c.upsell_demandes_mois, 0, 100000);
  const panierUps = pUnique != null ? pUnique : pos(c.panier_upsell, 0, 100000);
  const upsPot = upsBase * pct(c.taux_upsell, 0);
  const upsVentes = on('upsell') ? upsPot : 0;
  const caUps = upsVentes * panierUps, gUps = caUps * pct(c.marge_upsell, 0);

  // ── 7. Bonne pièce depuis l'immatriculation (TecDoc + SIV) ──
  const recherches = sites * pos(c.recherches_mois, 0, 100000);
  const erreurs = recherches * pct(c.taux_erreur, 0);
  const coutErreur = pos(c.cout_erreur, 0, 10000);
  const hIdentif = on('identif') ? recherches * pos(c.min_recherche, 0, 60) / 60 : 0;
  const erreursEvitees = on('identif') ? erreurs * pct(c.reduction_erreur, 0) : 0;
  const gIdentif = hIdentif * coutH + erreursEvitees * coutErreur;

  // ── 8. Temps : appels et messages traités de bout en bout par Budy ──
  const appelsAuto = on('temps') ? decroches * tAuto : 0;
  const msgAuto = (on('temps') && on('messages')) ? (msgMois - msgPerdus) * tAuto : 0;
  const hAuto = (appelsAuto * pos(c.duree_appel, 4, 60) + msgAuto * pos(c.duree_message, 0, 60)) / 60;
  const gTemps = hAuto * coutH;

  // ── Coûts ── socle SoConnect Basic + module Budy Auto, par site. Le module inclut un forfait
  // mensuel de messages WhatsApp / RCS et d'interrogations de plaque ; seul le dépassement coûte.
  const relancesMois = (on('devis') ? devisSansSuite : 0) + (on('atelier') ? rdvMois * 2 : 0) + (on('revisions') ? revRelances : 0);
  const msgInclus = pos(c.messages_inclus, 0, 1000000) * sites;
  const msgHorsForfait = Math.max(0, relancesMois - msgInclus);
  const coutMsg = msgHorsForfait * pos(c.cout_message, 0, 5);
  const plaquesMois = on('identif') ? recherches : 0;
  const plaquesHorsForfait = Math.max(0, plaquesMois - pos(c.plaques_incluses, 0, 1000000) * sites);
  const coutPlaques = plaquesHorsForfait * pos(c.cout_plaque, 0, 5);
  const socle = pos(c.abonnement, 0, 100000) * sites;
  const module = pos(c.module, 0, 100000) * sites;
  const abo = socle + module;
  const frais = pos(c.frais_installation, 0, 1000000);
  const coutMois = abo + coutMsg + coutPlaques;
  const coutAn1 = coutMois * 12 + frais;

  // ── Synthèse ──
  const caMois = caAppels + caMsg + caDevis + caNoshow + caRev + caUps;
  const margeMois = gAppels + gMsg + gDevis + gNoshow + gRev + gUps;
  const ecoMois = gIdentif + gTemps;
  const G = (ca, marge) => surMarge ? marge : ca;      // gain d'un levier de vente selon la base
  const gainVentes = G(caMois, margeMois);
  const gainMois = gainVentes + ecoMois;
  const gainAn = gainMois * 12;
  const heuresMois = hAuto + hIdentif;
  const roi = coutAn1 > 0 ? gainAn / coutAn1 : null;
  const gainJour = gainAn / 365;
  // ── Synthèse « rentabilisé avec N ventes par mois » (modèle de la fiche Arnoux) ──
  // Le seuil se lit sur le chiffre d'affaires par défaut (c'est la lecture du client : « combien
  // de ventes pour payer l'abonnement ? ») ou sur la marge si le commercial le choisit.
  const tauxVente = mix.reduce((t, m) => t + m.part * m.conv, 0);            // ventes par demande sauvée
  const panierMoyen = tauxVente > 0 ? valeurOpp / tauxVente : 0;
  const margeVente = tauxVente > 0 ? margeOpp / tauxVente : 0;
  const paniers = mix.filter(m => m.conv > 0 && m.panier > 0).map(m => m.panier);
  const baseSeuil = c.seuil_base === 'marge' ? margeVente : panierMoyen;
  const seuilVentes = (baseSeuil > 0 && coutMois > 0) ? Math.max(1, Math.ceil(coutMois / baseSeuil)) : null;
  const demandesMois = appelsMois + msgMois;
  const ventesMois = (oppRecup + msgRecup) * tauxVente + devisRecup + noshowEvites + revRdv + upsVentes;
  const gainJourOuvre = gainMois / jours;
    const L = (id, label, ca, gain) => ({ id, label, actif: on(id), ca_an: ca * 12, gain_an: gain * 12 });
  const caPerdu = oppPerduesAuj * valeurOpp + msgPerdus * valeurOpp + devisRecupPot * panierDevis
    + noshow * panierRdv + revPot * panierRev + upsPot * panierUps;

  return {
    sites, jours,
    appels_mois: appelsMois, hors_horaires_mois: hors, manques_mois: manques, decroches_mois: decroches,
    taux_reponse_actuel: appelsMois ? decroches / appelsMois * 100 : 0,
    taux_reponse_budy: appelsMois ? (decroches + reprises) / appelsMois * 100 : 0,
    reprises_mois: reprises, opp_perdues_mois: oppPerduesAuj, opp_recup_mois: oppRecup,
    valeur_opp: valeurOpp, marge_opp: margeOpp, motifs,
    ca_appels_mois: caAppels,
    messages_mois: msgMois, messages_perdus_mois: msgPerdus, messages_recup_mois: msgRecup, ca_messages_mois: caMsg,
    devis_sans_suite_mois: devisSansSuite, devis_recup_pot_mois: devisRecupPot, devis_recup_mois: devisRecup, ca_devis_mois: caDevis,
    rdv_mois: rdvMois, noshow_mois: noshow, noshow_evites_mois: noshowEvites, ca_noshow_mois: caNoshow,
    revisions_relances_mois: revRelances, revisions_rdv_mois: revRdv, ca_revisions_mois: caRev,
    upsell_ventes_mois: upsVentes, ca_upsell_mois: caUps, marge_upsell_mois: gUps,
    recherches_mois: recherches, heures_identif_mois: hIdentif, erreurs_mois: erreurs,
    erreurs_evitees_mois: erreursEvitees, eco_identif_mois: gIdentif,
    appels_auto_mois: appelsAuto, messages_auto_mois: msgAuto, heures_auto_mois: hAuto, temps_mois: gTemps,
    fuites: [
      { id: 'appels', label: 'Appels sans réponse — clients qui ne rappellent pas', volume: oppPerduesAuj, ca_an: oppPerduesAuj * valeurOpp * 12 },
      { id: 'messages', label: 'Messages WhatsApp / RCS sans réponse rapide', volume: msgPerdus, ca_an: msgPerdus * valeurOpp * 12 },
      { id: 'devis', label: 'Devis sans suite qu\'une relance aurait conclus', volume: devisRecupPot, ca_an: devisRecupPot * panierDevis * 12 },
      { id: 'atelier', label: 'Rendez-vous atelier non honorés', volume: noshow, ca_an: noshow * panierRdv * 12 },
      { id: 'revisions', label: 'Révisions à échéance jamais proposées', volume: revPot, ca_an: revPot * panierRev * 12 },
      { id: 'upsell', label: 'Ventes associées jamais suggérées', volume: upsPot, ca_an: upsPot * panierUps * 12 }
    ],
    ca_perdu_an: caPerdu * 12,
    leviers: [
      L('appels', 'Appels manqués repris', caAppels, G(caAppels, gAppels)),
      L('messages', 'Messages WhatsApp / RCS sauvés', caMsg, G(caMsg, gMsg)),
      L('devis', 'Devis relancés', caDevis, G(caDevis, gDevis)),
      L('atelier', 'Rendez-vous atelier sécurisés', caNoshow, G(caNoshow, gNoshow)),
      L('revisions', 'Révisions relancées (TecRMI)', caRev, G(caRev, gRev)),
      L('upsell', 'Ventes additionnelles par préconisation', caUps, G(caUps, gUps)),
      L('identif', 'Bonne pièce par immatriculation (TecDoc + SIV)', 0, gIdentif),
      L('temps', 'Appels et messages traités seul par Budy', 0, gTemps)
    ],
    clients_sauves_mois: oppRecup + msgRecup + devisRecup + noshowEvites + revRdv,
    interactions_mois: reprises + appelsAuto + msgRecup + msgAuto + relancesMois + (on('identif') ? recherches : 0),
    relances_mois: relancesMois,
    ca_mois: caMois, ca_an: caMois * 12, marge_mois: margeMois, marge_an: margeMois * 12,
    eco_mois: ecoMois, eco_an: ecoMois * 12,
    heures_mois: heuresMois, heures_an: heuresMois * 12, etp: heuresMois / 151.67,
    socle_mois: socle, module_mois: module, abonnement_mois: abo,
    messages_hors_forfait_mois: msgHorsForfait, cout_messages_mois: coutMsg,
    plaques_mois: plaquesMois, plaques_hors_forfait_mois: plaquesHorsForfait, cout_plaques_mois: coutPlaques,
    cout_mois: coutMois, cout_an1: coutAn1, frais,
    gain_mois: gainMois, gain_an: gainAn, gain_net_an: gainAn - coutAn1, gain_par_site_an: gainAn / sites,
    gain_net_3ans: gainAn * 3 - (coutMois * 36 + frais),
    roi, roi_prudent: coutAn1 > 0 ? (gainAn / 2) / coutAn1 : null,
    payback_jours: (coutAn1 > 0 && gainJour > 0) ? Math.ceil(coutAn1 / gainJour) : null,
    seuil_pct: gainAn > 0 ? coutAn1 / gainAn * 100 : null,
    seuil_clients_mois: G(valeurOpp, margeOpp) > 0 ? (coutAn1 / 12) / G(valeurOpp, margeOpp) : null,
    cout_inaction_jour: caPerdu / jours,
    demandes_mois: demandesMois, demandes_jour: demandesMois / jours,
    panier_moyen: panierMoyen, panier_min: paniers.length ? Math.min(...paniers) : 0, panier_max: paniers.length ? Math.max(...paniers) : 0,
    gain_ventes_mois: gainVentes, sur_marge: surMarge, panier_mode: simple ? 'simple' : 'detail',
    marge_par_vente: margeVente, seuil_base: c.seuil_base === 'marge' ? 'marge' : 'ca',
    seuil_ventes_mois: seuilVentes,
    seuil_pct_demandes: (seuilVentes != null && demandesMois > 0) ? seuilVentes / demandesMois * 100 : null,
    ventes_mois: ventesMois, multiple_seuil: (seuilVentes && ventesMois > 0) ? ventesMois / seuilVentes : null,
    valeur_temps_mois: heuresMois * coutH,
    temps_valorise: !off.cout_temps,
    jour_rentable: (gainJourOuvre > 0 && coutMois > 0) ? Math.min(jours, Math.max(1, Math.ceil(coutMois / gainJourOuvre))) : null,
    gain_net_mois: gainMois - coutMois
  };
}

// ── Profils de départ ─────────────────────────────────────────────────────────────────────────
// Les valeurs par défaut sont des HYPOTHÈSES de travail, prudentes, que le commercial ajuste
// avec le client. Seuls les taux de marché ont une source (cf. SOURCES_ROI) ; Marimax sert de
// repère pour le distributeur de pièces (≈150 demandes/jour sur 2 sites, 80 % de devis).
// ⚠️ AUCUN de ces paniers, taux de conversion ou marges n'a de source : ce sont des hypothèses de
// départ posées le 13/11/2026, à remplacer par les chiffres du client (ou par des moyennes Sofy
// quand elles existeront). Le panier moyen unique (mode simple) est l'équivalent du détail par
// motif, hors ventes de véhicules pour la concession.
// Calés le 13/11/2026 (demande Didier) pour afficher ≈ ×30 en concession et ≈ ×25 en pièces, GAIN
// SUR LE CHIFFRE D'AFFAIRES et panier unique, au tarif SoConnect Basic 389 € + module Budy Auto
// (249 € concession, 199 € pièces). Passer le gain « sur la marge » divise ces multiples par ≈ 2,5.
// Toute retouche d'un défaut ou d'un prix les déplace — relancer le banc de calcul (calc.mjs).
export const PRESETS_ROI = {
  concession: {
    profil: 'concession', libelle: 'Concession / garage', off: {},
    sites: 1, jours_mois: 22,
    panier_mode: 'simple', taux_conversion: 14, panier_moyen: 280, marge_moyenne: 40, scen_bas: 5, scen_haut: 30,
    appels_jour: 100, taux_manques: 28, hors_horaires: 10, taux_perdus: 30, taux_budy: 90,
    messages_jour: 15, taux_msg_perdus: 15,
    devis_mois: 150, taux_devis_sans_suite: 45, taux_devis_conv: 10, panier_devis: 450, marge_devis: 38,
    rdv_mois: 400, taux_noshow: 8, reduction_noshow: 30, panier_rdv: 280, marge_rdv: 40,
    revisions_mois: 200, taux_revision_conv: 6, panier_revision: 320,
    upsell_demandes_mois: 250, taux_upsell: 4, panier_upsell: 110, marge_upsell: 35,
    recherches_mois: 300, min_recherche: 2, taux_erreur: 5, reduction_erreur: 50, cout_erreur: 25,
    automatisation: 30, duree_appel: 4, duree_message: 3, cout_horaire: 32,
    seuil_base: 'ca', abonnement: 389, module: 249, messages_inclus: 0, plaques_incluses: 0, cout_message: 0.1, cout_plaque: 0, frais_installation: 0,
    motifs: [
      { id: 'atelier', label: 'Rendez-vous atelier / après-vente', unite: 'RDV', part: 55, conv: 50, panier: 280, marge: 40 },
      { id: 'pieces', label: 'Pièces & accessoires', unite: 'commandes', part: 15, conv: 35, panier: 140, marge: 30 },
      { id: 'vente', label: 'Vente VN / VO', unite: 'ventes', part: 15, conv: 2, panier: 20000, marge: 5 },
      { id: 'autres', label: 'Infos, suivi de dossier', unite: '—', part: 15, conv: 0, panier: 0, marge: 0 }
    ]
  },
  pieces: {
    profil: 'pieces', libelle: 'Distributeur de pièces détachées', off: { atelier: true, revisions: true },
    sites: 2, jours_mois: 24,
    panier_mode: 'simple', taux_conversion: 12, panier_moyen: 195, marge_moyenne: 28, scen_bas: 4, scen_haut: 25,
    appels_jour: 45, taux_manques: 25, hors_horaires: 8, taux_perdus: 35, taux_budy: 90,
    messages_jour: 30, taux_msg_perdus: 15,
    devis_mois: 750, taux_devis_sans_suite: 50, taux_devis_conv: 5, panier_devis: 180, marge_devis: 28,
    rdv_mois: 0, taux_noshow: 8, reduction_noshow: 40, panier_rdv: 250, marge_rdv: 40,
    revisions_mois: 0, taux_revision_conv: 8, panier_revision: 300,
    upsell_demandes_mois: 800, taux_upsell: 2, panier_upsell: 70, marge_upsell: 30,
    recherches_mois: 1500, min_recherche: 2, taux_erreur: 5, reduction_erreur: 50, cout_erreur: 25,
    automatisation: 35, duree_appel: 4, duree_message: 3, cout_horaire: 30,
    seuil_base: 'ca', abonnement: 389, module: 199, messages_inclus: 1000, plaques_incluses: 500, cout_message: 0.1, cout_plaque: 0, frais_installation: 0,
    motifs: [
      { id: 'devis_pro', label: 'Devis / dispo pièce — garages pros', unite: 'commandes', part: 55, conv: 40, panier: 220, marge: 28 },
      { id: 'devis_part', label: 'Devis / dispo pièce — particuliers', unite: 'commandes', part: 25, conv: 30, panier: 120, marge: 32 },
      { id: 'suivi', label: 'Suivi de commande, retours, infos', unite: '—', part: 20, conv: 0, panier: 0, marge: 0 }
    ]
  }
};

// Chiffres de marché, tous sourcés et datés. Ne rien ajouter ici sans source : ce bloc est
// imprimé tel quel dans le document envoyé au client. Les deux « messagerie » viennent de la base
// de connaissance (kb-sales, validés Didier 26/08/2026).
export const SOURCES_ROI = [
  { v: '28 %', t: "des sollicitations adressées à une concession restent sans réponse", s: "Journal de l'Automobile, 19/02/2026" },
  { v: '72 %', t: "de taux de décroché dans l'automobile, contre 90 % tous secteurs confondus", s: "Journal de l'Automobile, 19/02/2026" },
  { v: '3', t: "tentatives en moyenne pour joindre une concession en France", s: "Journal de l'Automobile, 19/02/2026" },
  { v: '30-40 %', t: "des appels entrants en concession sont manqués", s: "L'Argus, 22/09/2026" },
  { v: '32 M', t: "de Français utilisent WhatsApp chaque mois : c'est la première messagerie du pays", s: "Médiamétrie, 2024" },
  { v: '46 %', t: "des contacts clients passent par les canaux conversationnels écrits (42 % en 2024)", s: "Observatoire des services clients Ipsos-BVA, 2025" },
  { v: '60 %', t: "des prises de rendez-vous après-vente automatisées par un agent IA, sur un test de 117 concessions — et −30 % d'appels à traiter par les équipes", s: "L'Argus, 22/09/2026" }
];

// ── Rendu ─────────────────────────────────────────────────────────────────────────────────────
export const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const NBSP = ' ';
function arrondi(v) {
  const a = Math.abs(v);
  if (a >= 100000) return Math.round(v / 1000) * 1000;
  if (a >= 10000) return Math.round(v / 100) * 100;
  if (a >= 1000) return Math.round(v / 10) * 10;
  return Math.round(v);
}
export const fmt = (v, d = 0) => (Number(v) || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/[  ]/g, NBSP);
export const eur = v => fmt(arrondi(v)) + NBSP + '€';
export const eur2 = v => fmt(v, 2) + NBSP + '€';
export const ent = v => fmt(Math.round(v));
export const nb = v => (v >= 10 || v === 0) ? ent(v) : fmt(v, 1);
export const roiX = r => r == null ? '—' : '×' + (r >= 10 ? fmt(Math.round(r)) : fmt(r, 1));
export const p0 = v => fmt(v || 0, 0) + NBSP + '%';

export const COULEURS_ROI = { appels: '#5B4FE9', messages: '#25B573', devis: '#F0428A', atelier: '#F59E0B', revisions: '#06A6C9', upsell: '#A855F7', identif: '#64748B', temps: '#94A3B8' };

// Un message type, tel que le client final le reçoit. `fil` = [['c'|'b', texte], …] ; `boutons`.
export function bulle(canal, emetteur, fil, boutons) {
  const wa = canal === 'WhatsApp';
  return `<div class="ms${wa ? ' wa' : ''}">
    <div class="ms-h"><i></i>${esc(canal)} · ${esc(emetteur)}<em>exemple</em></div>
    ${fil.map(([q, t]) => `<div class="ms-${q === 'c' ? 'c' : 'b'}">${esc(t)}</div>`).join('')}
    ${boutons && boutons.length ? `<div class="ms-a">${boutons.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
  </div>`;
}

// ── Preuve sociale : la MÊME base que les prez ───────────────────────────────────────────────
// Un cas client est un bloc `cas_client` de kb_sales, les logos et la photo viennent de
// kb_visuels (cf. preuvesRoi dans kb-visuels.js). Corriger le cas ou changer un logo dans
// « Base de connaissance » met donc à jour les prez ET les études ROI, sans toucher au code.
// Le bloc est rédigé en texte : « intro. **Avant :** … **Résultats :** a · b · c. **Verbatim
// client :** « … » ». On le découpe ici ; un bloc écrit autrement s'affiche en texte simple.
export function casClient(bloc) {
  if (!bloc || !bloc.titre) return null;
  const titre = String(bloc.titre);
  const coupe = titre.split(/\s+[—–-]\s+/);
  const contenu = String(bloc.contenu || '');
  const section = nom => {
    const m = contenu.match(new RegExp('\\*\\*' + nom + '[^*]*\\*\\*\\s*([^]*?)(?=\\*\\*[^*]+:\\s*\\*\\*|$)', 'i'));
    return m ? m[1].trim() : '';
  };
  const nu = t => String(t || '').replace(/\*\*/g, '').trim();
  const resultats = section('R[ée]sultats').split(/\s+·\s+/).map(x => nu(x).replace(/\.$/, '')).filter(x => x.length > 3);
  const url = bloc.lien || ((String(bloc.source || '').match(/(?:https?:\/\/)?((?:www\.)?sofy\.fr\/[^\s)]+)/) || [])[1] || '');
  return {
    nom: coupe[0].trim(),
    accroche: coupe.slice(1).join(' — ').trim(),
    secteur: bloc.secteur || '', territoire: bloc.territoire || '',
    intro: nu(contenu.split('**')[0]),
    avant: nu(section('Avant')),
    resultats: resultats.slice(0, 8),
    verbatim: nu(section('Verbatim')).replace(/^[«"\s]+|[»"\s.]+$/g, ''),
    lien: url ? (url.startsWith('http') ? url : 'https://' + url.replace(/^https?:\/\//, '')) : '',
    source: nu(String(bloc.source || '').split(' — ')[0])
  };
}

// Illustration de repli (aucune photo « garage / concession » validée dans la bibliothèque) :
// un atelier, une voiture, une conversation. Dessinée ici pour ne dépendre d'aucun fichier.
export const ILLU_AUTO = `<svg viewBox="0 0 320 230" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Un atelier automobile et une conversation client">
 <defs><linearGradient id="ig" x1="0" x2="1"><stop offset="0" stop-color="#8F86FF"/><stop offset="1" stop-color="#F0428A"/></linearGradient></defs>
 <rect x="1" y="1" width="318" height="228" rx="18" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)"/>
 <path d="M26 96 L160 44 L294 96" fill="none" stroke="url(#ig)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
 <path d="M44 96 V196 M276 96 V196" stroke="rgba(255,255,255,.28)" stroke-width="3" stroke-linecap="round"/>
 <rect x="62" y="104" width="196" height="12" rx="6" fill="rgba(255,255,255,.1)"/>
 <path d="M70 172 q4 -20 24 -24 l20 -4 q13 -20 40 -22 h30 q24 2 40 22 l26 6 q12 4 12 20 v6 h-192 z" fill="rgba(143,134,255,.22)" stroke="#B9B2E0" stroke-width="2.5" stroke-linejoin="round"/>
 <path d="M122 143 q10 -14 30 -15 h30 q16 1 28 15 z" fill="rgba(255,255,255,.14)"/>
 <circle cx="112" cy="178" r="13" fill="#0F0B29" stroke="#B9B2E0" stroke-width="3"/><circle cx="112" cy="178" r="4" fill="#B9B2E0"/>
 <circle cx="222" cy="178" r="13" fill="#0F0B29" stroke="#B9B2E0" stroke-width="3"/><circle cx="222" cy="178" r="4" fill="#B9B2E0"/>
 <path d="M30 196 H290" stroke="rgba(255,255,255,.28)" stroke-width="3" stroke-linecap="round"/>
 <rect x="196" y="14" width="104" height="40" rx="13" fill="url(#ig)"/>
 <path d="M214 54 l-6 12 l18 -12 z" fill="#C36BC0"/>
 <circle cx="228" cy="34" r="4.5" fill="#fff"/><circle cx="248" cy="34" r="4.5" fill="#fff"/><circle cx="268" cy="34" r="4.5" fill="#fff"/>
 <rect x="20" y="20" width="76" height="30" rx="11" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.2)"/>
 <path d="M44 35 l7 7 l14 -14" fill="none" stroke="#5DDBA5" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── Scénarios Bas / Moyen / Haut (tableau de Romain, 13/11/2026) ─────────────────────────────
// UNE hypothèse varie (def.cle), tout le reste est figé. Le « gain » d'un scénario est celui des
// ventes seules (r.gain_ventes_mois − coût) : le temps gagné ne dépend pas du scénario et se lit à
// part. `seuil` = la valeur de l'hypothèse à partir de laquelle l'abonnement est payé.
// AUTONOME : servie au front par Function.toString, comme les moteurs.
export function scenariosEtude(calc, cfg, def) {
  if (!def || (def.simple && cfg.panier_mode !== 'simple')) return null;
  const nombre = (v, d) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; };
  const moyen = nombre(cfg[def.cle], 0);
  const run = v => { const c2 = Object.assign({}, cfg); c2[def.cle] = v; return calc(c2); };
  const net = r => r.gain_ventes_mois - r.cout_mois;
  const colonnes = [['bas', 'Bas', nombre(cfg.scen_bas, moyen)], ['moyen', 'Moyen', moyen], ['haut', 'Haut', nombre(cfg.scen_haut, moyen)]].map(x => {
    const r = run(x[2]);
    return { id: x[0], label: x[1], valeur: x[2], ventes_mois: r.ventes_mois, ca_mois: r.ca_mois, marge_mois: r.marge_mois,
      cout_mois: r.cout_mois, gain_mois: net(r), gain_an: net(r) * 12 };
  });
  let lo = 0, hi = def.max || 100, seuil = null;
  if (net(run(hi)) > 0) {
    if (net(run(lo)) >= 0) seuil = 0;
    else { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (net(run(m)) >= 0) hi = m; else lo = m; } seuil = hi; }
  }
  return { cle: def.cle, label: def.label, colonnes, seuil };
}
export const SCENARIO_BUDY = { cle: 'taux_conversion', label: 'Clients sauvés qui achètent', max: 100, simple: true };

// Le tableau, tel que le client le lit. o : { unite:[sing,plur], marge:boolean (afficher la ligne
// marge), avant:[[libellé, valeur]] (lignes fixes au-dessus), note }.
export function tableScenarios(sc, o) {
  if (!sc) return '';
  const C = sc.colonnes;
  const cel = f => C.map(x => `<td${x.id === 'moyen' ? ' class="m"' : ''}>${f(x)}</td>`).join('');
  // Montants à l'euro près, sans arrondi commercial : ce tableau se vérifie à la calculette.
  const ex = v => ent(v) + NBSP + '€';
  const signe = v => `<span${v < 0 ? ' class="neg"' : ''}>${v < 0 ? '−' + NBSP : ''}${ex(Math.abs(v))}</span>`;
  const pc = v => fmt(v, v < 10 && v % 1 ? 1 : 0) + NBSP + '%';
  return `<table class="sc">
  <tr><th></th>${C.map(x => `<th${x.id === 'moyen' ? ' class="m"' : ''}>${esc(x.label)}</th>`).join('')}</tr>
  ${(o.avant || []).map(([l, v]) => `<tr><td>${l}</td>${cel(() => v)}</tr>`).join('')}
  <tr><td>${esc(sc.label)}</td>${cel(x => pc(x.valeur))}</tr>
  <tr><td>${esc(o.unite[1].charAt(0).toUpperCase() + o.unite[1].slice(1))} en plus par mois</td>${cel(x => nb(x.ventes_mois))}</tr>
  <tr><td>Chiffre d'affaires généré par mois</td>${cel(x => ex(x.ca_mois))}</tr>
  ${o.marge ? `<tr><td>Marge correspondante</td>${cel(x => ex(x.marge_mois))}</tr>` : ''}
  <tr><td>Investissement mensuel</td>${cel(x => ex(x.cout_mois))}</tr>
  <tr class="st"><td>Gain ou perte par mois</td>${cel(x => signe(x.gain_mois))}</tr>
  <tr class="tot"><td>Gain ou perte par an</td>${cel(x => signe(x.gain_an))}</tr>
 </table>
 <p class="note" style="margin-top:8px">${sc.seuil === 0 ? '<b>Rentable dans les trois scénarios</b> : même à 0 %, les autres leviers couvrent l\'investissement. '
    : (sc.seuil != null ? `<b>Rentable dès ${pc(sc.seuil)}</b> — ${esc(sc.label.charAt(0).toLowerCase() + sc.label.slice(1))}. ` : '')}${o.note || ''}</p>`;
}

// ── Page « La synthèse » : commune à toutes les études (Budy Auto, Soview, SoReach) ───────────
// Modèle de la fiche Arnoux : demandes → vente moyenne → investissement → seuil, puis le vrai
// gain. `r` doit porter : seuil_ventes_mois, seuil_pct_demandes, demandes_mois, demandes_jour,
// panier_moyen (+_min/_max), cout_mois, sites, frais, heures_mois, valeur_temps_mois, ventes_mois,
// multiple_seuil, gain_net_mois, gain_net_an, roi, jour_rentable, jours, gain_mois, seuil_base.
export const kpi = (v, l, g) => `<div class="k"><b${g ? ' class="g"' : ''}>${v}</b><span>${l}</span></div>`;
export function pageSynthese(r, o) {
  const k = kpi;
  const U = o.unite || ['vente', 'ventes'];
  const sv = r.seuil_ventes_mois;
  const pctDem = r.seuil_pct_demandes;
  const fmtPct = v => v == null ? '—' : (v < 0.1 ? 'moins de 0,1' : fmt(v, v < 10 ? 1 : 0)) + NBSP + '%';
  const partAbo = r.cout_mois > 0 ? r.valeur_temps_mois / r.cout_mois : 0;
  const tempsVsAbo = partAbo >= 0.9 && partAbo <= 1.15 ? "l'équivalent du prix de l'abonnement"
    : partAbo > 1.15 ? `${fmt(partAbo, 1)} fois le prix de l'abonnement` : `${fmt(partAbo * 100, 0)}${NBSP}% du prix de l'abonnement`;
  if (sv == null) return null;
  return { corps: `
 <div class="ey">La synthèse</div>
 <h2 style="max-width:none">${esc(o.produit)} est rentabilisé avec <span class="g">${ent(sv)} ${sv > 1 ? U[1] : U[0]}</span>${o.enPlus ? ' en plus' : ''} par mois</h2>
 <div class="rule"></div>
 <div class="ch">
  <div class="ch-c"><small>Vos demandes</small><b>${ent(r.demandes_mois)}</b><span>${esc(o.demandes)}${o.sansJour ? '' : `, <i>soit ${ent(r.demandes_jour)} par jour</i>`}*</span></div>
  <div class="ch-a">→</div>
  <div class="ch-c"><small>${esc(o.panier || 'Vente moyenne')}</small><b>${eur(r.panier_moyen)}</b><span>par ${U[0]}${r.panier_max > r.panier_min ? ` <i>(de ${eur(r.panier_min)} à ${eur(r.panier_max)})</i>` : ''}*</span></div>
  <div class="ch-a">→</div>
  <div class="ch-c"><small>L'investissement</small><b>${eur(r.cout_mois)}</b><span>HT par mois${r.sites > 1 ? `, pour vos ${r.sites} sites` : ''}${r.frais ? ` <i>(+ ${eur(r.frais)} de mise en place)</i>` : ''}</span></div>
  <div class="ch-a">→</div>
  <div class="ch-c ch-n"><small>Pour être rentable</small><b>${ent(sv)}</b><span>${sv > 1 ? U[1] : U[0]} en plus par mois suffi${sv > 1 ? 'sent' : 't'}, soit ${fmtPct(pctDem)} des ${esc(o.demandesCourt || 'demandes')}</span></div>
 </div>
 ${r.heures_mois >= 1 ? `<div class="enplus"><b>En plus :</b> <em>${ent(r.heures_mois)} h par mois</em> rendues à vos équipes${o.temps ? ` (${esc(o.temps)})` : ''}${r.valeur_temps_mois > 0 ? `, soit ${eur(r.valeur_temps_mois)} de temps — ${tempsVsAbo}` : ''}.</div>` : ''}
 <div class="h3" style="margin-top:30px">Le vrai gain : bien au-delà du seuil</div>
 <div class="vg">
  <div class="vg-b">
   <div class="vg-l"><span>Seuil de rentabilité</span><b>${ent(sv)} ${sv > 1 ? U[1] : U[0]} / mois</b></div>
   <div class="vg-j"><i style="width:${Math.max(1.5, Math.min(100, sv / Math.max(sv, r.ventes_mois) * 100)).toFixed(1)}%;background:#B9B2E0"></i></div>
   <div class="vg-l" style="margin-top:12px"><span>Ce que ${esc(o.produit)} vise chez vous</span><b class="g">${ent(r.ventes_mois)} ${U[1]} / mois</b></div>
   <div class="vg-j"><i style="width:${Math.max(1.5, Math.min(100, r.ventes_mois / Math.max(sv, r.ventes_mois) * 100)).toFixed(1)}%"></i></div>
   ${r.multiple_seuil != null && r.multiple_seuil >= 2 ? `<p>Soit <b>${fmt(Math.floor(r.multiple_seuil))} fois le seuil</b> : même si une petite partie seulement se réalise, ${esc(o.produit)} est payé.</p>` : ''}
  </div>
  <div class="k">
   <b class="g">${eur(r.gain_net_mois)}</b><span>de gain net par mois, abonnement déduit</span>
   <b style="margin-top:14px">${eur(r.gain_net_an)}</b><span>de gain net la première année</span>
  </div>
 </div>
 <div class="k3">
  ${k(roiX(r.roi).replace('×', '') + NBSP + '€', 'récupérés pour 1 € investi')}
  ${k(r.jour_rentable != null ? (r.jour_rentable === 1 ? '1er jour' : ent(r.jour_rentable) + 'ᵉ jour') : '—', r.jour_rentable != null ? `ouvré du mois : l'abonnement est payé, les ${ent(r.jours - r.jour_rentable)} jours suivants sont du gain net` : 'pour rentabiliser le mois')}
  ${k(eur(r.gain_mois), 'de gain non réalisé pour chaque mois d\'attente')}
 </div>
 <p class="note">* Données à valider ensemble. Calcul sur ${r.seuil_base === 'marge' ? 'la marge brute' : "le chiffre d'affaires"}. Montants hors taxes. Détail des hypothèses plus loin dans ce document.</p>` };
}

// ── Page « Ils l'ont fait » : cas client + logos, commune à toutes les études ──
export function pagePreuve(cas, logos) {
  logos = logos || [];
  if (!cas && !logos.length) return null;
  return { corps: `
 <div class="ey">Ils l'ont fait</div>
 <h2>${cas ? `${esc(cas.nom)} : <span class="g">${esc(cas.accroche || 'les résultats')}</span>` : `Ils nous confient <span class="g">leur relation client</span>`}</h2>
 <div class="rule"></div>
 ${cas ? `
 <p class="lead" style="font-size:15px">${esc(cas.intro)}</p>
 ${cas.avant ? `<div class="h3">Avant Sofy</div><p class="tx" style="max-width:none">${esc(cas.avant)}</p>` : ''}
 ${cas.resultats.length ? `<div class="h3">Les résultats</div>
 <div class="res">${cas.resultats.map(x => `<div><i>✓</i><span>${esc(x.charAt(0).toUpperCase() + x.slice(1))}</span></div>`).join('')}</div>` : ''}
 ${cas.verbatim ? `<blockquote class="vb">« ${esc(cas.verbatim)} »<cite>${esc(cas.nom)}${cas.secteur ? ' · ' + esc(cas.secteur) : ''}${cas.territoire ? ' · ' + esc(cas.territoire) : ''}</cite></blockquote>` : ''}
 <p class="note" style="margin-top:10px">${cas.lien ? `<a href="${esc(cas.lien)}" target="_blank" rel="noopener">Lire l'interview complète →</a> · ` : ''}Source : ${esc(cas.source || 'interview client Sofy')}</p>` : ''}
 ${logos.length ? `<div class="h3" style="margin-top:${cas ? 26 : 8}px">Ils nous font confiance</div>
 <div class="lg">${logos.map(l => `<span><img src="${esc(l.image)}" alt="${esc(l.description || '')}"></span>`).join('')}</div>` : ''}` };
}

// ── Fin de document : le bouton de démonstration et la carte du conseiller ──
export function blocFin(sdr, lienDemo, bouton, texte) {
  const signature = (sdr && sdr.nom) ? `<div class="sig">
   ${sdr.photo ? `<img src="${esc(sdr.photo)}" alt="">` : `<i>${esc(sdr.nom.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase())}</i>`}
   <div><small>Votre conseiller Sofy</small><b>${esc(sdr.nom)}</b>${sdr.poste ? `<span>${esc(sdr.poste)}</span>` : ''}
   <p>${sdr.email ? `<a href="mailto:${esc(sdr.email)}">${esc(sdr.email)}</a>` : ''}${sdr.ringover_numero ? `<a href="tel:${esc(String(sdr.ringover_numero).replace(/\s/g, ''))}">${esc(sdr.ringover_numero)}</a>` : ''}</p></div>
  </div>` : '';
  return `<div class="fin">
  <div>
   <a class="btn" href="${esc(lienDemo)}" target="_blank" rel="noopener">${esc(bouton)}</a>
   <p>${esc(texte)}</p>
  </div>
  ${signature}
 </div>`;
}
export const PIED_ESTIMATION = "Les montants sont des estimations établies à partir des hypothèses détaillées dans ce document ; ils ne constituent pas un engagement de résultat.";

// ── Gabarit : habille une liste de pages { dark?, corps, pied? } — styles, pagination, PDF ──
export function gabarit(P, o) {
  const { client, date, apercu } = o;
  const total = P.length;
  const sections = P.map((p, i) => `<section class="page${p.dark ? ' dark' : ''}">
 <header class="ph"><img class="logo" src="/logo-full.png" alt="Sofy" width="92" height="29"><span class="pag">${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></header>${p.corps}
 <footer class="pf"><span>${p.pied ? esc(p.pied) : (i === 0 ? esc(date) : `${esc(o.nom)} · ${esc(client)} · ${esc(date)}`)}</span><span>sofy.fr</span></footer>
</section>`).join('\n');

  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(o.nom)} — ${esc(client)}</title>
<style>
:root{--nuit:#0F0B29;--nuit2:#1A1040;--ink:#14103A;--ink-s:#5A5580;--ink-d:#F2F0FF;--ink-ds:#B9B2E0;
 --v:#5B4FE9;--r:#F0428A;--line:#E4E0F5;--line-d:rgba(255,255,255,.13);--grad:linear-gradient(90deg,#5B4FE9,#F0428A)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#E9E6F4;font-family:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;color:var(--ink);font-variant-numeric:tabular-nums}
.page{width:min(820px,100%);margin:24px auto;background:linear-gradient(160deg,#FFF 0%,#F8F6FE 60%,#FDF3F8 100%);border-radius:14px;
 box-shadow:0 2px 6px rgba(20,16,58,.06),0 24px 60px rgba(20,16,58,.12);padding:40px 52px 26px;display:flex;flex-direction:column;min-height:1100px;position:relative;overflow:hidden}
.page.dark{background:radial-gradient(120% 80% at 80% 0%,#2C1A5C 0%,var(--nuit2) 45%,var(--nuit) 100%);color:var(--ink-d)}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}
.logo{height:29px;width:auto}
.dark .logo{filter:brightness(0) invert(1)}
.pag{font-size:11.5px;letter-spacing:.22em;color:#B9B2E0}
.dark .pag{color:rgba(255,255,255,.45)}
.ey{font-size:12px;font-weight:800;letter-spacing:.19em;text-transform:uppercase;color:var(--v);margin-bottom:12px}
.dark .ey{color:var(--r)}
h1,h2{margin:0;font-weight:800;letter-spacing:-.03em;line-height:1.05;text-wrap:balance}
h1{font-size:44px;max-width:16ch}
h2{font-size:32px;max-width:22ch}
.g{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.rule{height:5px;width:86px;border-radius:3px;background:var(--grad);margin:18px 0 18px}
.lead{font-size:16px;line-height:1.6;color:var(--ink-s);max-width:60ch;margin:0}
.dark .lead{color:var(--ink-ds)}
.tx{font-size:13.5px;line-height:1.55;color:var(--ink-s);margin:0 0 10px;max-width:52ch}
.note{font-size:10.5px;color:#A49DCB;margin:18px 0 0}
.pf{margin-top:auto;padding-top:18px;display:flex;justify-content:space-between;gap:20px;font-size:10.5px;letter-spacing:.04em;color:#A49DCB}
.dark .pf{color:rgba(255,255,255,.38)}
.pt{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:8px;vertical-align:1px}
/* Synthèse */
.ch{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;gap:8px;align-items:stretch;margin-top:6px}
.ch-c{padding:15px 14px;border-radius:14px;background:#fff;border:1px solid var(--line);display:flex;flex-direction:column}
.ch-c small{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-s)}
.ch-c b{font-size:30px;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin:8px 0 6px;color:var(--v);white-space:nowrap}
.ch-c span{font-size:12px;line-height:1.4;color:var(--ink)}
.ch-c i{font-style:italic;color:var(--ink-s)}
.ch-n{background:var(--nuit);border-color:var(--nuit)}
.ch-n small{color:#F7A8CB}.ch-n b{color:#F7A8CB;font-size:40px}.ch-n span{color:var(--ink-d)}
.ch-a{align-self:center;color:var(--r);font-size:18px}
.enplus{margin-top:14px;padding:14px 18px;border-radius:13px;background:#ECEAFB;font-size:14px;line-height:1.5}
.enplus em{font-style:normal;font-weight:800;color:var(--v)}
.vg{display:grid;grid-template-columns:1.5fr 1fr;gap:12px}
.vg-b{padding:16px 18px;border-radius:14px;background:#fff;border:1px solid var(--line)}
.vg-b p{margin:12px 0 0;font-size:12.5px;line-height:1.5;color:var(--ink-s)}
.vg-l{display:flex;justify-content:space-between;gap:10px;font-size:13px}
.vg-l b{white-space:nowrap}
.vg-j{height:12px;border-radius:7px;background:#ECE9F8;overflow:hidden;margin-top:5px}
.vg-j i{display:block;height:100%;border-radius:7px;background:var(--grad)}
.vg .k b+span+b{font-size:22px}
/* Couverture */
.cv-for{font-size:14px;letter-spacing:.04em;color:var(--ink-ds);margin:22px 0 0}
.cv-for b{color:#fff;font-size:22px;letter-spacing:-.01em;display:block;margin-top:4px}
.hero{margin:26px 0 0;padding:24px 26px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid var(--line-d)}
.hero-l{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-ds);font-weight:700}
.hero-v{font-size:66px;font-weight:800;letter-spacing:-.04em;line-height:1;margin-top:10px}
.hero-s{font-size:15px;color:var(--ink-ds);margin-top:10px;line-height:1.5}
.hero-s b{color:#fff}
.pile{display:flex;gap:2px;height:12px;border-radius:7px;overflow:hidden;margin-top:18px}
.pile i{display:block;min-width:3px}
.pile-l{display:flex;flex-wrap:wrap;gap:5px 16px;margin-top:10px;font-size:11.5px;color:var(--ink-ds)}
.pile-l i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.pile-l b{color:#fff;font-weight:700}
.k3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.k4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:10px}
.k{padding:16px 16px;border-radius:14px;background:#fff;border:1px solid var(--line)}
.dark .k{background:rgba(255,255,255,.055);border-color:var(--line-d)}
.k b{display:block;font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.05;white-space:nowrap}
.k span{display:block;font-size:12px;line-height:1.4;margin-top:6px;color:var(--ink-s)}
.dark .k span{color:var(--ink-ds)}
.k4 .k{padding:13px 13px}.k4 .k b{font-size:23px}.k4 .k span{font-size:11.5px}
.mini{gap:8px;margin-top:0}.mini .k{padding:11px 12px;border-radius:11px}.mini .k b{font-size:20px}.mini .k span{font-size:11px;margin-top:4px}
.sdr{display:flex;gap:14px;align-items:center;margin-top:24px}
.sdr img{width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.3)}
.sdr b{display:block;font-size:15px}
.sdr span{display:block;font-size:12px;color:var(--ink-ds);margin:2px 0 4px}
.sdr a{color:inherit;font-size:12.5px;text-decoration:none;margin-right:12px}
/* Constat */
.big{display:grid;grid-template-columns:1.1fr 1fr;gap:14px}
.loss{padding:22px 24px;border-radius:16px;background:var(--nuit);color:var(--ink-d)}
.loss small{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--r);font-weight:800}
.loss>b{display:block;font-size:46px;font-weight:800;letter-spacing:-.04em;margin-top:8px;line-height:1}
.loss p{margin:10px 0 0;font-size:13px;line-height:1.5;color:var(--ink-ds)}
.loss p b{color:#fff}
.flux{display:flex;flex-direction:column;gap:7px}
.fx{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:9px 14px;border-radius:11px;background:#fff;border:1px solid var(--line);font-size:13px}
.fx b{font-size:18px;letter-spacing:-.02em;white-space:nowrap}
.fx.rouge b{color:#D92D6A}
.mk{display:grid;grid-template-columns:1fr 1fr;gap:9px 22px}
.mk div{display:flex;gap:12px;align-items:flex-start;font-size:12.5px;line-height:1.4;color:var(--ink-s)}
.mk b{flex:none;min-width:64px;font-size:20px;font-weight:800;letter-spacing:-.02em;color:var(--v)}
.mk i{display:block;font-style:normal;font-size:10.5px;color:#A49DCB;margin-top:2px}
.h3{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-s);margin:24px 0 8px}
/* Avec Budy */
.bars{display:flex;flex-direction:column;gap:10px}
.bar-h{display:flex;justify-content:space-between;font-size:13px;gap:10px}
.bar-h b{white-space:nowrap}
.bar-h em{font-style:normal;color:var(--ink-s);font-size:12px}
.bar{height:10px;border-radius:6px;background:#ECE9F8;overflow:hidden;margin-top:5px}
.bar i{display:block;height:100%;border-radius:6px;background:var(--grad)}
.cmp{display:flex;gap:12px;align-items:center;padding:13px 18px;border-radius:13px;background:#fff;border:1px solid var(--line);font-size:13px;line-height:1.5}
.cmp .ga{flex:1}.cmp .ga b{font-size:24px;letter-spacing:-.02em;display:block}
.cmp .ar{font-size:22px;color:var(--v)}
.rl{display:grid;grid-template-columns:1.2fr 1fr;gap:16px;align-items:start}
.ms{border-radius:14px;background:#fff;border:1px solid var(--line);padding:11px 12px;font-size:12px;line-height:1.45}
.ms-h{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--v);margin-bottom:2px}
.ms-h i{width:8px;height:8px;border-radius:50%;background:var(--v)}
.ms-h em{margin-left:auto;font-style:normal;font-weight:600;color:#B9B2E0;letter-spacing:.04em}
.ms.wa .ms-h{color:#128C5E}.ms.wa .ms-h i{background:#25B573}
.ms-b{background:#F1EFFD;border-radius:4px 12px 12px 12px;padding:8px 10px;margin:7px 18px 0 0}
.ms.wa .ms-b{background:#E7F8EE}
.ms-c{background:#F3F4F6;border-radius:12px 4px 12px 12px;padding:8px 10px;margin:7px 0 0 34px}
.ms-a{display:flex;gap:6px;margin-top:8px}
.ms-a span{flex:1;text-align:center;border:1px solid #D9D4F5;border-radius:8px;padding:6px 4px;font-weight:700;color:var(--v);font-size:11px}
.ms.wa .ms-a span{border-color:#BFE9D7;color:#0B6B4B}
/* Calcul */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#9990C4;font-weight:700;padding:0 8px 7px 0;border-bottom:1px solid var(--line)}
td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:not(:first-child),th:not(:first-child){text-align:right;white-space:nowrap}
.lv td{border-bottom:none;padding-bottom:3px}
.jauge td{padding:0 0 4px 17px;text-align:left}
.jauge i{display:block;height:3px;border-radius:2px;opacity:.6}
.st td{font-weight:800;border-bottom:2px solid var(--ink)}
.tot td{font-weight:800;font-size:15.5px;border-bottom:none;padding-top:11px}
.neg{color:#D92D6A}
.sc td,.sc th{padding:6px 10px 6px 0}
.sc td:not(:first-child),.sc th:not(:first-child){width:19%;padding-right:10px}
.sc .m{background:#F1EFFD;font-weight:700}
.sc th.m{color:var(--v)}
.sc .tot td{font-size:14.5px;padding-top:8px}
.prud{margin-top:12px;padding:12px 16px;border-radius:12px;background:#EEFAF5;border:1px solid #BFE9D7;color:#0B6B4B;font-size:13px;line-height:1.5}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:26px;align-items:start}
.hb{margin-top:14px}
.hb h5{margin:0 0 4px;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.hyp{font-size:11.5px}
.hyp td{padding:4px 8px 4px 0;color:var(--ink-s)}
.hyp td:last-child{color:var(--ink);font-weight:600;padding-right:0}
.hyp th{font-size:9.5px;padding-bottom:4px}
/* Couverture : titre + illustration */
.cv-t{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:22px;align-items:center}
.cv-i{margin:0}
.cv-i img,.cv-i svg{display:block;width:100%;height:auto;border-radius:18px}
.cv-i img{aspect-ratio:4/3;object-fit:cover;border:1px solid var(--line-d)}
/* Preuve sociale */
.res{display:grid;grid-template-columns:1fr 1fr;gap:9px 22px}
.res div{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.45}
.res i{flex:none;width:20px;height:20px;border-radius:50%;background:var(--grad);color:#fff;font-style:normal;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px}
.vb{margin:22px 0 0;padding:18px 22px;border-radius:14px;background:#fff;border:1px solid var(--line);border-left:4px solid var(--r);font-size:17px;line-height:1.5;font-style:italic}
.vb cite{display:block;margin-top:10px;font-style:normal;font-size:11.5px;letter-spacing:.03em;color:#9990C4}
.note a{color:var(--v);font-weight:700;text-decoration:none}
.lg{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.lg span{display:flex;align-items:center;justify-content:center;height:58px;padding:9px 12px;border-radius:12px;background:#fff;border:1px solid var(--line)}
.lg img{max-width:100%;max-height:100%;object-fit:contain}
/* Fin : appel à l'action + conseiller */
.fin{display:grid;grid-template-columns:1fr auto;gap:22px;align-items:center;margin-top:24px;padding:20px 22px;border-radius:16px;background:rgba(255,255,255,.06);border:1px solid var(--line-d)}
.fin p{margin:10px 0 0;font-size:12.5px;color:var(--ink-ds);line-height:1.5}
.sig{display:flex;gap:13px;align-items:center}
.sig img,.sig i{flex:none;width:62px;height:62px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.3)}
.sig i{display:flex;align-items:center;justify-content:center;background:var(--grad);color:#fff;font-style:normal;font-weight:800;font-size:20px}
.sig small{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--r);font-weight:800}
.sig b{display:block;font-size:17px;margin-top:2px}
.sig span{display:block;font-size:12px;color:var(--ink-ds)}
.sig p{margin:5px 0 0}.sig a{display:block;color:#fff;font-size:12.5px;text-decoration:none}
/* Pourquoi Budy */
.why{display:flex;flex-direction:column;gap:11px}
.w{display:flex;gap:13px;align-items:flex-start}
.w-n{flex:none;width:30px;height:30px;border-radius:10px;background:var(--grad);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13.5px}
.w-t{font-size:15px;font-weight:750;letter-spacing:-.01em}
.w-x{font-size:12.5px;line-height:1.5;color:var(--ink-ds);margin-top:2px}
.btn{display:inline-block;padding:13px 20px;border-radius:12px;background:var(--grad);color:#fff;text-decoration:none;font-weight:800;font-size:14.5px}
.tools{position:fixed;right:18px;bottom:18px;display:flex;gap:8px;z-index:5}
.tools button{border:0;border-radius:12px;padding:12px 18px;font-weight:800;font-size:14px;background:var(--grad);color:#fff;cursor:pointer;box-shadow:0 10px 26px rgba(91,79,233,.35)}
.apercu{position:fixed;left:18px;bottom:18px;background:#FFF7E0;border:1px solid #F3D27A;color:#7A5A00;border-radius:10px;padding:9px 13px;font-size:12.5px;z-index:5;max-width:calc(100vw - 250px)}
@media (max-width:700px){
 .page{margin:0 0 10px;border-radius:0;padding:26px 18px 20px;min-height:0}
 h1{font-size:33px} h2{font-size:25px} .hero-v{font-size:44px} .loss>b{font-size:38px}
 .k3,.k4,.big,.mk,.cols,.rl,.vg{grid-template-columns:1fr}
 .ch{grid-template-columns:1fr 1fr}.ch-a{display:none}
 .cv-t,.fin,.res{grid-template-columns:1fr}.cv-i{max-width:260px}.lg{grid-template-columns:repeat(3,1fr)}
 .mini{grid-template-columns:repeat(3,1fr)}
 .cmp{flex-wrap:wrap}.cmp .ar{display:none}.cmp .ga{flex:1 1 40%}
 table{font-size:12px}
 .apercu{display:none}
}
@page{size:A4;margin:0}
@media print{
 :root{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
 body{background:#fff}
 .tools,.apercu{display:none!important}
 *{box-shadow:none!important}
 .page{width:210mm;height:297mm;min-height:0;margin:0;border-radius:0;padding:12mm 15mm 8mm;break-after:page;page-break-after:always;overflow:hidden}
 .page:last-of-type{break-after:auto;page-break-after:auto}
 .g{-webkit-text-fill-color:currentColor;background:none;color:var(--v)}
 .dark .g{color:#F7A8CB}
}
</style></head><body>

${sections}

${apercu ? `<div class="apercu">👁 Aperçu interne — cette visite n'est pas comptée dans les ouvertures du client.</div>` : ''}
<div class="tools"><button type="button" id="pdf">⬇️ Télécharger en PDF</button></div>
<script>
(function(){
 var b=document.getElementById('pdf');
 if(b)b.addEventListener('click',function(){window.print();});
 if(/[?&]print=1/.test(location.search))setTimeout(function(){window.print();},500);
})();
</script>
</body></html>`;
}

export function pageRoi(doc, meta, sdr, apercu, lienDemo, preuves) {
  preuves = preuves || {};
  const cas = preuves.cas || null;
  const logos = Array.isArray(preuves.logos) ? preuves.logos.filter(l => l && l.image) : [];
  const illu = preuves.illustration && preuves.illustration.image ? preuves.illustration : null;
  const c = doc.config || {};
  const r = calculerRoi(c);
  const client = doc.client || 'votre entreprise';
  const pieces = c.profil === 'pieces';
  const date = new Date(meta.cree_le || Date.now()).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const lev = id => r.leviers.find(l => l.id === id) || { actif: false, gain_an: 0 };
  const act = id => lev(id).actif && lev(id).gain_an > 0;
  const leviersV = r.leviers.filter(l => l.actif && l.gain_an > 0);
  const maxGain = Math.max(1, ...leviersV.map(l => l.gain_an));
  const motifsV = r.motifs.filter(m => m.ca_mois > 0);
  const maxCa = Math.max(1, ...motifsV.map(m => m.ca_mois));
  const fuitesV = r.fuites.filter(f => f.ca_an > 0);
  const contact = sdr ? `<div class="sdr">
      ${sdr.photo ? `<img src="${esc(sdr.photo)}" alt="">` : ''}
      <div><b>${esc(sdr.nom || '')}</b><span>${esc(sdr.poste || 'Votre interlocuteur chez Sofy')}</span>
      ${sdr.email ? `<a href="mailto:${esc(sdr.email)}">${esc(sdr.email)}</a>` : ''}
      ${sdr.ringover_numero ? `<a href="tel:${esc(String(sdr.ringover_numero).replace(/\s/g, ''))}">${esc(sdr.ringover_numero)}</a>` : ''}</div>
    </div>` : '';
  const k = kpi;
  const surCa = !r.sur_marge;                 // gain lu sur le chiffre d'affaires (défaut) ou sur la marge
  const simple = r.panier_mode === 'simple';  // un seul panier moyen pour toutes les ventes
  const P = [];   // pages : { dark, corps, pied }

  // ── 1. Couverture ──
  P.push({ dark: true, corps: `
 <div class="ey">Étude de rentabilité · Budy, l'IA de la relation client automobile</div>
 <div class="cv-t">
  <div>
   <h1>Chaque demande sans réponse est un client qui <span class="g">va voir ailleurs.</span></h1>
   <div class="rule"></div>
  </div>
  <figure class="cv-i">${illu ? `<img src="${esc(illu.image)}" alt="${esc(illu.description || '')}">` : ILLU_AUTO}</figure>
 </div>
 <p class="lead">Ce document chiffre ce que ${esc(client)} récupère quand plus aucun appel, message ou devis ne reste sans suite : chiffre d'affaires, marge et temps rendu à vos équipes. Toutes les hypothèses sont en annexe — modifiables avec vous.</p>
 <p class="cv-for">Préparée pour<b>${esc(client)}${r.sites > 1 ? ` · ${r.sites} sites` : ''}</b></p>
 <div class="hero">
  <div class="hero-l">Gain total potentiel la première année</div>
  <div class="hero-v g">${eur(r.gain_an)}</div>
  <div class="hero-s">${surCa ? "chiffre d'affaires récupéré" : 'marge récupérée'} + temps et coûts évités, pour ${eur(r.cout_an1)} investis${r.roi != null ? ` — soit <b>${roiX(r.roi)}</b> la mise` : ''}${r.payback_jours != null ? `, rentabilisé en <b>${ent(r.payback_jours)} jours</b>` : ''}.</div>
  <div class="pile">${leviersV.map(l => `<i style="flex:${Math.max(1, Math.round(l.gain_an))};background:${COULEURS_ROI[l.id]}"></i>`).join('')}</div>
  <div class="pile-l">${leviersV.map(l => `<span><i style="background:${COULEURS_ROI[l.id]}"></i>${esc(l.label)} · <b>${eur(l.gain_an)}</b></span>`).join('')}</div>
 </div>
 <div class="k3">
  ${k(ent(r.clients_sauves_mois), 'clients sauvés chaque mois : appels repris, messages traités, devis et rendez-vous relancés')}
  ${k(eur(r.ca_an), "de chiffre d'affaires récupéré par an")}
  ${k(ent(r.heures_an) + NBSP + 'h', `de travail rendues à vos équipes par an${r.etp >= 0.1 ? ` (≈ ${fmt(r.etp, 1)} ETP)` : ''}`)}
 </div>
 ${contact}` });

  // ── 2. La synthèse : le seuil de rentabilité, puis le vrai gain ──
  const synth = pageSynthese(r, { produit: 'Budy', demandes: 'appels et messages par mois', demandesCourt: 'demandes',
    panier: 'Vente moyenne', temps: 'préqualification, recherche de références, questions répétitives' });
  if (synth) P.push(synth);

  // ── 2. Aujourd'hui ──
  P.push({ corps: `
 <div class="ey">Aujourd'hui</div>
 <h2>Ce que coûtent les demandes <span class="g">qui restent sans suite</span></h2>
 <div class="rule"></div>
 <div class="big">
  <div class="loss">
   <small>Chiffre d'affaires qui vous échappe</small>
   <b>${eur(r.ca_perdu_an)}</b>
   <p>par an : appels et messages sans réponse, devis jamais relancés, rendez-vous non honorés, ventes jamais proposées.<br>Soit <b>${eur(r.cout_inaction_jour)}</b> par jour ouvré.</p>
  </div>
  <div class="flux">
   <div class="fx"><span>Appels reçus par mois</span><b>${ent(r.appels_mois)}</b></div>
   <div class="fx rouge"><span>… restés sans réponse</span><b>${ent(r.manques_mois)}</b></div>
   <div class="fx"><span>Taux de réponse téléphonique estimé</span><b>${p0(r.taux_reponse_actuel)}</b></div>
   ${r.messages_mois ? `<div class="fx"><span>Messages écrits reçus par mois</span><b>${ent(r.messages_mois)}</b></div>` : ''}
   ${r.devis_sans_suite_mois ? `<div class="fx rouge"><span>Devis sans suite par mois</span><b>${ent(r.devis_sans_suite_mois)}</b></div>` : ''}
  </div>
 </div>
 <div class="h3">Où part ce chiffre d'affaires</div>
 <table>
  <tr><th>Fuite</th><th>Par mois</th><th>CA perdu par an</th></tr>
  ${fuitesV.map(f => `<tr><td><i class="pt" style="background:${COULEURS_ROI[f.id]}"></i>${esc(f.label)}</td><td>${nb(f.volume)}</td><td>${eur(f.ca_an)}</td></tr>`).join('')}
 </table>
 <div class="h3">Ce que mesure le marché</div>
 <div class="mk">
  ${SOURCES_ROI.slice(0, 6).map(s => `<div><b>${esc(s.v)}</b><span>${esc(s.t)}<i>${esc(s.s)}</i></span></div>`).join('')}
 </div>` });

  // ── 3. Répondre ──
  if (act('appels') || act('messages') || act('temps')) P.push({ corps: `
 <div class="ey">Avec Budy · répondre</div>
 <h2>Plus aucun appel ni message <span class="g">sans réponse</span></h2>
 <div class="rule"></div>
 <div class="cmp">
  <div class="ga"><span>Taux de réponse aujourd'hui</span><b>${p0(r.taux_reponse_actuel)}</b></div>
  <div class="ar">→</div>
  <div class="ga"><span>Avec Budy, 24 h/24</span><b class="g">${p0(r.taux_reponse_budy)}</b></div>
  <div class="ga"><span>Appels repris par mois</span><b>${ent(r.reprises_mois)}</b></div>
 </div>
 ${motifsV.length ? `<div class="h3">Chiffre d'affaires récupéré sur les appels${motifsV.length > 1 ? ', par motif' : ''}</div>
 <div class="bars">
  ${motifsV.map(m => `<div>
   <div class="bar-h"><span>${esc(m.label)} <em>· ${nb(m.ventes)} ${esc(m.unite)} / mois</em></span><b>${eur(m.ca_mois)} / mois</b></div>
   <div class="bar"><i style="width:${Math.max(3, Math.round(m.ca_mois / maxCa * 100))}%"></i></div>
  </div>`).join('')}
 </div>` : ''}
 ${act('messages') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.messages}"></i>WhatsApp, RCS, Messenger, webchat</div>
 <div class="rl">
  <div>
   <p class="tx">Vos clients écrivent autant qu'ils appellent. Budy répond dans la minute, qualifie la demande (véhicule, immatriculation, besoin) et la transmet à votre équipe avec tout l'historique.</p>
   <div class="k3 mini">
    ${k(ent(r.messages_perdus_mois), 'messages par mois sans réponse rapide aujourd\'hui')}
    ${k(ent(r.messages_recup_mois), 'clients sauvés par mois')}
    ${k(eur(r.ca_messages_mois), 'de CA récupéré par mois', true)}
   </div>
  </div>
  ${bulle('WhatsApp', client, pieces
    ? [['c', 'Bonjour, il me faut un kit de distribution pour un Kangoo, vous avez ?'], ['b', 'Bonjour ! Pour trouver la référence exacte, pouvez-vous m\'indiquer l\'immatriculation du véhicule ?'], ['c', 'FG-482-KL']]
    : [['c', 'Bonjour, je voudrais un rendez-vous pour ma révision.'], ['b', 'Bonjour ! Avec plaisir. Quelle est l\'immatriculation de votre véhicule, et son kilométrage approximatif ?'], ['c', 'FG-482-KL, 61 000 km']], [])}
 </div>` : ''}
 ${act('temps') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.temps}"></i>Temps rendu à vos équipes</div>
 <div class="k3">
  ${k(ent(r.appels_auto_mois + r.messages_auto_mois), 'appels et messages par mois traités de bout en bout par Budy (horaires, suivi, rendez-vous simple…)')}
  ${k(ent(r.heures_auto_mois) + NBSP + 'h', 'libérées par mois, réaffectées à la vente et au conseil')}
  ${k(eur(r.temps_mois), 'de temps valorisé par mois')}
 </div>` : ''}` });

  // ── 4. Relancer ──
  if (act('devis') || act('atelier') || act('revisions')) P.push({ corps: `
 <div class="ey">Avec Budy · relancer</div>
 <h2>Le bon message, <span class="g">au bon moment</span>, sur WhatsApp et RCS</h2>
 <div class="rule"></div>
 ${act('devis') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.devis}"></i>Devis sans suite</div>
 <div class="rl">
  <div>
   <p class="tx">Un devis qui n'est pas relancé est un devis signé ailleurs. Budy relance chaque devis resté sans réponse, avec un bouton pour confirmer ou être rappelé.</p>
   <div class="k3 mini">
    ${k(ent(r.devis_sans_suite_mois), 'devis sans suite par mois')}
    ${k(nb(r.devis_recup_mois), 'conclus grâce à la relance')}
    ${k(eur(r.ca_devis_mois), 'de CA récupéré par mois', true)}
   </div>
  </div>
  ${bulle('WhatsApp', client, [['b', pieces
    ? 'Bonjour, votre devis n° 2841 (kit de distribution, 186 €) est toujours valable. Souhaitez-vous que nous vous mettions la pièce de côté ?'
    : 'Bonjour M. Martin, votre devis freinage pour votre 308 (389 €) est valable jusqu\'à vendredi. Je vous réserve un créneau ?']],
    [pieces ? 'Réserver la pièce' : 'Réserver un créneau', 'Être rappelé'])}
 </div>` : ''}
 ${act('atelier') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.atelier}"></i>Rendez-vous atelier</div>
 <div class="rl">
  <div>
   <p class="tx">Un pont vide ne se rattrape pas. Relié à votre planning atelier Mecaplanning, Budy rappelle chaque rendez-vous l'avant-veille et la veille ; le client confirme ou décale d'un geste, et le créneau libéré peut être reproposé.</p>
   <div class="k3 mini">
    ${k(ent(r.noshow_mois), 'rendez-vous non honorés par mois')}
    ${k(nb(r.noshow_evites_mois), 'évités grâce aux rappels')}
    ${k(eur(r.ca_noshow_mois), 'de CA atelier sécurisé par mois', true)}
   </div>
  </div>
  ${bulle('RCS', client, [['b', 'Rappel : votre Clio est attendue demain à 8 h 30 pour sa révision. Pensez à la carte grise et au carnet d\'entretien. Vous confirmez ?']], ['Je confirme', 'Je décale'])}
 </div>` : ''}
 ${act('revisions') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.revisions}"></i>Révisions à échéance — plan d'entretien constructeur (TecRMI)</div>
 <div class="rl">
  <div>
   <p class="tx">Budy croise votre base clients avec les préconisations constructeur TecRMI : chaque véhicule reçoit sa relance au bon kilométrage, avec le contenu exact de la révision.</p>
   <div class="k3 mini">
    ${k(ent(r.revisions_relances_mois), 'relances de révision par mois')}
    ${k(nb(r.revisions_rdv_mois), 'rendez-vous pris')}
    ${k(eur(r.ca_revisions_mois), 'de CA atelier généré par mois', true)}
   </div>
  </div>
  ${bulle('WhatsApp', client, [['b', 'Bonjour Mme Durand, d\'après le plan d\'entretien constructeur de votre 208 (62 000 km), la révision des 60 000 km est à prévoir : vidange, filtres, liquide de frein. Je vous propose un créneau ?']], ['Choisir un créneau', 'Plus tard'])}
 </div>` : ''}` });

  // ── 5. Vendre juste ──
  if (act('identif') || act('upsell')) P.push({ corps: `
 <div class="ey">Avec Budy · vendre juste</div>
 <h2>La bonne pièce du premier coup, <span class="g">et celle qui va avec</span></h2>
 <div class="rule"></div>
 ${act('identif') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.identif}"></i>De l'immatriculation à la bonne référence — TecDoc + SIV</div>
 <p class="tx" style="max-width:none">Le client donne sa plaque : Budy identifie le véhicule exact via le fichier des immatriculations (SIV), puis la référence compatible dans le catalogue TecDoc. Plus de recherche manuelle, plus de « c'est quel moteur ? », moins de pièces qui reviennent.</p>
 <div class="k4">
  ${k(ent(r.recherches_mois), 'recherches de pièces par mois')}
  ${k(ent(r.heures_identif_mois) + NBSP + 'h', 'de recherche économisées par mois')}
  ${k(nb(r.erreurs_evitees_mois), 'erreurs de référence et retours évités par mois')}
  ${k(eur(r.eco_identif_mois), 'd\'économie par mois', true)}
 </div>` : ''}
 ${act('upsell') ? `<div class="h3"><i class="pt" style="background:${COULEURS_ROI.upsell}"></i>La vente additionnelle guidée par la préconisation constructeur</div>
 <div class="rl">
  <div>
   <p class="tx">Budy connaît le véhicule, son kilométrage et ce que le constructeur préconise. Quand un client demande des plaquettes, il sait si les disques sont à remplacer — et le propose au bon moment, sans insister.</p>
   <div class="k3 mini">
    ${k(nb(r.upsell_ventes_mois), 'ventes additionnelles par mois')}
    ${k(eur(r.ca_upsell_mois), 'de CA additionnel par mois', true)}
    ${k(eur(r.marge_upsell_mois), 'de marge par mois')}
   </div>
  </div>
  ${bulle('WhatsApp', client, [
    ['c', 'Bonjour, il me faut des plaquettes avant pour ma Clio, AB-123-CD.'],
    ['b', 'Clio IV 1.5 dCi 90 identifiée ✓ Plaquettes avant compatibles trouvées. À 87 000 km, le constructeur préconise aussi de remplacer les disques avant. Je les ajoute au devis ?']
  ], ['Ajouter les disques', 'Plaquettes seules'])}
 </div>` : ''}
 <p class="note">TecDoc et TecRMI sont des bases de données de TecAlliance. Les exemples de messages sont illustratifs.</p>` });

  // ── 6. Le calcul ──
  const scen = scenariosEtude(calculerRoi, c, SCENARIO_BUDY);
  const seuilCli = r.seuil_clients_mois != null ? Math.ceil(r.seuil_clients_mois) : null;
  P.push({ corps: `
 <div class="ey">Le calcul</div>
 <h2>Un retour sur investissement <span class="g">calculé sur ${surCa ? "le chiffre d'affaires" : 'la marge'}</span></h2>
 <div class="rule"></div>
 <table>
  <tr><th>Première année</th>${surCa ? '' : '<th>CA récupéré</th>'}<th>${surCa ? 'Montant' : 'Gain'}</th></tr>
  ${leviersV.map(l => `<tr class="lv"><td><i class="pt" style="background:${COULEURS_ROI[l.id]}"></i>${esc(l.label)}</td>${surCa ? '' : `<td>${l.ca_an ? eur(l.ca_an) : '—'}</td>`}<td>${eur(l.gain_an)}</td></tr>
  <tr class="jauge"><td colspan="${surCa ? 2 : 3}"><i style="width:${Math.max(1, Math.round(l.gain_an / maxGain * 100))}%;background:${COULEURS_ROI[l.id]}"></i></td></tr>`).join('')}
  <tr class="st"><td>Gain total (${surCa ? "chiffre d'affaires" : 'marge'} + temps et coûts évités)</td>${surCa ? '' : `<td>${eur(r.ca_an)}</td>`}<td>${eur(r.gain_an)}</td></tr>
  <tr><td>SoConnect Basic (${eur(c.abonnement || 0)}/mois${r.sites > 1 ? ` × ${r.sites} sites` : ''} × 12)</td>${surCa ? '' : '<td></td>'}<td class="neg">− ${eur(r.socle_mois * 12)}</td></tr>
  ${r.module_mois ? `<tr><td>Module Budy Auto ${pieces ? 'Pièces' : 'Concession'} (${eur(c.module || 0)}/mois${r.sites > 1 ? ` × ${r.sites} sites` : ''} × 12) — ${pieces ? 'TecDoc, TecRMI, plaques et messages inclus' : 'TecDoc, TecRMI et Mecaplanning inclus'}</td>${surCa ? '' : '<td></td>'}<td class="neg">− ${eur(r.module_mois * 12)}</td></tr>` : ''}
  ${r.cout_messages_mois ? `<tr><td>Messages WhatsApp / RCS au-delà du forfait (${ent(r.messages_hors_forfait_mois)}/mois × ${eur2(c.cout_message || 0)})</td>${surCa ? '' : '<td></td>'}<td class="neg">− ${eur(r.cout_messages_mois * 12)}</td></tr>` : ''}
  ${r.cout_plaques_mois ? `<tr><td>Interrogations de plaque au-delà du forfait (${ent(r.plaques_hors_forfait_mois)}/mois × ${eur2(c.cout_plaque || 0)})</td>${surCa ? '' : '<td></td>'}<td class="neg">− ${eur(r.cout_plaques_mois * 12)}</td></tr>` : ''}
  ${r.frais ? `<tr><td>Mise en place</td>${surCa ? '' : '<td></td>'}<td class="neg">− ${eur(r.frais)}</td></tr>` : ''}
  <tr class="tot"><td>Gain net la première année</td>${surCa ? '' : '<td></td>'}<td>${eur(r.gain_net_an)}</td></tr>
 </table>
 <div class="k4" style="margin-top:18px">
  ${k(roiX(r.roi), 'retour sur investissement (gain ÷ coût)', true)}
  ${k(r.payback_jours != null ? ent(r.payback_jours) + NBSP + 'j' : '—', 'pour que Budy soit rentabilisé')}
  ${k(r.seuil_pct != null ? fmt(r.seuil_pct, r.seuil_pct < 10 ? 1 : 0) + NBSP + '%' : '—', 'du gain estimé suffisent à payer Budy')}
  ${k(eur(r.gain_net_3ans), 'de gain net cumulé sur 3 ans')}
 </div>
 <div class="prud">✅ <b>Même avec des hypothèses deux fois moins favorables</b>, Budy rapporte ${roiX(r.roi_prudent)} sa mise${r.roi_prudent != null && r.roi_prudent >= 1 ? ' : l\'investissement reste rentable' : ''}.${seuilCli != null && r.clients_sauves_mois > seuilCli ? ` Il suffit de <b>${ent(seuilCli)} client${seuilCli > 1 ? 's' : ''} sauvé${seuilCli > 1 ? 's' : ''} par mois</b> pour couvrir son coût, sur ${ent(r.clients_sauves_mois)} estimés.` : ''}</div>
 <div class="k3" style="margin-top:14px">
  ${k(eur(r.gain_mois), 'de gain moyen par mois')}
  ${r.sites > 1 ? k(eur(r.gain_par_site_an), 'de gain par site et par an') : k(eur(r.cout_inaction_jour), 'de CA qui échappe chaque jour ouvré sans Budy')}
  ${k(r.interactions_mois ? eur2(r.cout_mois / r.interactions_mois) : '—', `par contact traité par Budy (${ent(r.interactions_mois)} par mois)`)}
 </div>` });
  // Trois scénarios (mode « panier moyen ») : leur propre page, le tableau se lit d'un coup d'œil.
  if (scen) P.push({ corps: `
 <div class="ey">Trois scénarios</div>
 <h2>Du scénario prudent <span class="g">au scénario ambitieux</span></h2>
 <div class="rule"></div>
 <p class="tx" style="max-width:none">Une seule hypothèse change d'une colonne à l'autre : la part des clients repris par Budy (appels et messages) qui achètent réellement. Tout le reste — volumes, panier moyen de ${eur(c.panier_moyen || 0)} pour toutes les ventes, relances, tarif — est identique.</p>
 ${tableScenarios(scen, { unite: ['vente', 'ventes'], marge: !surCa, avant: [
    ['Appels et messages repris par mois', ent(r.reprises_mois + r.messages_recup_mois)],
    ['Panier moyen', eur(c.panier_moyen || 0)]
  ], note: 'Gain calculé sur ' + (surCa ? "le chiffre d'affaires" : 'la marge') + ' des ventes, hors temps rendu et coûts évités (' + eur(r.eco_mois) + ' par mois en plus, quel que soit le scénario).' })}
 <div class="h3">Comment lire ce tableau</div>
 <div class="res" style="grid-template-columns:1fr">
  <div><i>1</i><span><b>Le scénario bas est volontairement sévère.</b> Il suppose que très peu des clients à qui Budy répond enfin passent commande.</span></div>
  <div><i>2</i><span><b>Le scénario moyen est celui de cette étude.</b> C'est lui qui donne les montants des autres pages.</span></div>
  <div><i>3</i><span><b>Les relances ne dépendent pas de ce taux.</b> Devis relancés, rendez-vous sécurisés, révisions et ventes additionnelles sont comptés à l'identique dans les trois colonnes.</span></div>
 </div>` });

  // ── 7. Annexe : hypothèses ──
  const h = (l, v) => `<tr><td>${l}</td><td>${v}</td></tr>`;
  const bloc = (id, titre, lignes) => (!id || lev(id).actif)
    ? `<div class="hb"><h5>${id ? `<i class="pt" style="background:${COULEURS_ROI[id]}"></i>` : ''}${titre}</h5><table class="hyp">${lignes.join('')}</table></div>` : '';
  P.push({ corps: `
 <div class="ey">Annexe</div>
 <h2>Les hypothèses retenues — <span class="g">à ajuster avec vous</span></h2>
 <div class="rule"></div>
 <p class="tx" style="max-width:none;margin-bottom:0">Chaque montant de cette étude découle des valeurs ci-dessous. Changez-en une, tout se recalcule : votre interlocuteur Sofy met l'étude à jour sur le même lien.</p>
 <div class="cols">
  <div>
   ${bloc('', 'Périmètre', [h('Sites équipés', r.sites), h('Jours d\'ouverture par mois', r.jours), ...(simple ? [h('Panier moyen, pour toutes les ventes', eur(c.panier_moyen || 0))] : []), h('Gain calculé sur', surCa ? "le chiffre d'affaires" : 'la marge'), h('Coût horaire chargé d\'un conseiller', r.temps_valorise ? eur(c.cout_horaire || 0) : 'temps rendu non valorisé')])}
   ${bloc('', 'Tarif retenu', [h('SoConnect Basic, par site et par mois', eur(c.abonnement || 0)), h('Module Budy Auto ' + (pieces ? 'Pièces' : 'Concession'), '+ ' + eur(c.module || 0)), ...(c.messages_inclus ? [h('Messages WhatsApp / RCS inclus par mois', ent(c.messages_inclus))] : []), ...(c.plaques_incluses ? [h('Interrogations de plaque incluses par mois', ent(c.plaques_incluses))] : []), ...(r.cout_messages_mois ? [h('Message au-delà du forfait', eur2(c.cout_message || 0))] : [])])}
   ${bloc('appels', 'Appels', [h('Appels entrants par jour et par site', ent(c.appels_jour || 0)), h('Manqués pendant les horaires', p0(c.taux_manques)), h('Reçus hors horaires', p0(c.hors_horaires)), h('Appelants sans réponse qui ne rappellent pas', p0(c.taux_perdus)), h('Demandes sans réponse reprises par Budy', p0(c.taux_budy))])}
   ${bloc('messages', 'Messages écrits', [h('Messages reçus par jour et par site', ent(c.messages_jour || 0)), h('Sans réponse rapide (client perdu)', p0(c.taux_msg_perdus))])}
   ${bloc('temps', 'Traitement automatique', [h('Demandes traitées seul par Budy', p0(c.automatisation)), h('Durée moyenne d\'un appel', fmt(c.duree_appel || 0, 1) + ' min'), h('Durée de traitement d\'un message', fmt(c.duree_message || 0, 1) + ' min')])}
   ${bloc('identif', 'Identification par immatriculation', [h('Recherches de pièces par mois et par site', ent(c.recherches_mois || 0)), h('Temps gagné par recherche', fmt(c.min_recherche || 0, 1) + ' min'), h('Erreurs de référence aujourd\'hui', p0(c.taux_erreur)), h('Erreurs évitées', p0(c.reduction_erreur)), h('Coût d\'une erreur (retour, temps, remise)', eur(c.cout_erreur || 0))])}
  </div>
  <div>
   <div class="hb"><h5>Valeur d'un client sauvé (appels et messages)</h5>
   <table class="hyp">
    <tr><th>Motif</th><th>Part</th><th>Conv.</th><th>Panier</th><th>Marge</th></tr>
    ${r.motifs.map(m => `<tr><td>${esc(m.label)}</td><td>${p0(m.part)}</td><td>${m.conv ? fmt(m.conv, m.conv < 10 && m.conv % 1 ? 1 : 0) + NBSP + '%' : '—'}</td><td>${m.panier ? eur(m.panier) : '—'}</td><td>${m.marge ? p0(m.marge) : '—'}</td></tr>`).join('')}
   </table></div>
   ${bloc('devis', 'Relance des devis', [h('Devis émis par mois et par site', ent(c.devis_mois || 0)), h('Devis restant sans suite', p0(c.taux_devis_sans_suite)), h('Conclus grâce à la relance', p0(c.taux_devis_conv)), ...(simple ? [] : [h('Montant moyen d\'un devis', eur(c.panier_devis || 0))]), ...(surCa ? [] : [h('Marge', p0(c.marge_devis))])])}
   ${bloc('atelier', 'Rappels de rendez-vous atelier', [h('Rendez-vous par mois et par site', ent(c.rdv_mois || 0)), h('Rendez-vous non honorés', p0(c.taux_noshow)), h('Évités grâce aux rappels (2 par rendez-vous)', p0(c.reduction_noshow)), ...(simple ? [] : [h('Facture atelier moyenne', eur(c.panier_rdv || 0))]), ...(surCa ? [] : [h('Marge atelier', p0(c.marge_rdv))])])}
   ${bloc('revisions', 'Relance des révisions', [h('Relances envoyées par mois et par site', ent(c.revisions_mois || 0)), h('Relances suivies d\'un rendez-vous', p0(c.taux_revision_conv)), ...(simple ? [] : [h('Facture moyenne d\'une révision', eur(c.panier_revision || 0))]), ...(surCa ? [] : [h('Marge atelier', p0(c.marge_rdv))])])}
   ${bloc('upsell', 'Vente additionnelle', [h('Demandes pièces / entretien par mois et par site', ent(c.upsell_demandes_mois || 0)), h('Demandes avec vente additionnelle', p0(c.taux_upsell)), ...(simple ? [] : [h('Panier additionnel moyen', eur(c.panier_upsell || 0))]), ...(surCa ? [] : [h('Marge', p0(c.marge_upsell))])])}
  </div>
 </div>` });

  // ── Preuve sociale : cas client + logos, lus dans la base commune aux prez ──
  const pp = pagePreuve(cas, logos);
  if (pp) P.push(pp);

  // ── 8. Pourquoi Budy ──
  const benef = pieces ? [
    ['Chaque demande de pièce aboutit', "Au téléphone comme sur WhatsApp, Budy relève l'immatriculation, identifie le véhicule et la référence, puis transmet un devis prêt à valider — plus de « rappelez plus tard »."],
    ['Vos vendeurs comptoir vendent', "Horaires, suivi de commande, disponibilité : Budy répond seul aux questions simples. Vos équipes gardent leur temps pour les commandes."],
    ['Ouvert quand vos clients travaillent', "Les garages appellent tôt, tard et le samedi. Budy répond 24 h/24 et la demande attend votre équipe à l'ouverture."]
  ] : [
    ['Chaque demande atelier devient un rendez-vous', "Au téléphone comme sur WhatsApp, Budy identifie le motif, relève le véhicule, l'immatriculation et le créneau souhaité, puis transmet une demande qualifiée — ou la traite seul quand elle est simple."],
    ['Vos conseillers se concentrent sur la vente', "Horaires, suivi de réparation, documents : Budy absorbe les demandes répétitives. Le téléphone ne sonne plus que pour ce qui demande un humain."],
    ['Ouvert quand vos clients vous cherchent', "Le soir, le samedi, à l'heure du déjeuner : Budy répond 24 h/24. La demande attend votre équipe à l'ouverture, avec tout le contexte."]
  ];
  P.push({ dark: true, corps: `
 <div class="ey">Pourquoi Budy</div>
 <h2>Plus qu'un robot qui décroche : <span class="g">toute votre relation client</span> au même endroit</h2>
 <div class="rule"></div>
 <div class="why">
  ${benef.map((b, i) => `<div class="w"><div class="w-n">${i + 1}</div><div><div class="w-t">${esc(b[0])}</div><div class="w-x">${esc(b[1])}</div></div></div>`).join('')}
  <div class="w"><div class="w-n">4</div><div><div class="w-t">Une IA qui connaît l'automobile</div><div class="w-x">Reliée au fichier des immatriculations, au catalogue TecDoc et aux plans d'entretien TecRMI${pieces ? '' : ', ainsi qu\'à votre planning atelier Mecaplanning'}, Budy parle véhicule, référence et préconisation constructeur — pas un script générique.</div></div></div>
  <div class="w"><div class="w-n">5</div><div><div class="w-t">La voix et l'écrit dans une seule boîte</div><div class="w-x">Téléphone, WhatsApp, Messenger, Instagram, webchat et RCS arrivent dans SoConnect, avec l'historique du client. Un canal de plus n'ajoute pas un écran de plus.</div></div></div>
  <div class="w"><div class="w-n">6</div><div><div class="w-t">Une équipe qui reste</div><div class="w-x">Sofy est une marque d'Optima Group, éditeur de SunSMS : 14 ans de messagerie d'entreprise. Une coach dédiée suit votre déploiement — pas une hotline anonyme.</div></div></div>
 </div>
 ${blocFin(sdr, lienDemo, 'Réserver une démonstration de Budy →', 'Une démonstration de 30 minutes sur vos propres demandes : appels, WhatsApp, devis.')}
 `, pied: "Les montants sont des estimations établies à partir des hypothèses détaillées dans ce document ; ils ne constituent pas un engagement de résultat." });

  return gabarit(P, { client, date, apercu, nom: 'Étude de rentabilité Budy' });
}
