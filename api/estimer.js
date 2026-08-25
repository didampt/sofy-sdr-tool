// /api/estimer.js — Estimation AVANT génération d'une liste.
// GET avec les mêmes paramètres que /api/liste (naf, dep, effectif_min/max, ca_min/max, nb_etab_min)
// → renvoie : nb de fiches Pappers disponibles, nb réellement générable, fourchette de coût
//   d'enrichissement, et solde du SDR (plafond mensuel − consommation du mois).
//
// Règle du jeu : le total Pappers seul MENT. La génération applique ensuite des filtres que
// le comptage ne connaît pas (dédoublonnage inter-listes, seuil d'établissements, cessées/
// procédures collectives) — c'est ce qui produisait « 145 trouvées » puis 2 fiches livrées.
// On rapatrie donc ici la première page que /api/liste balayerait (même appel recherche) et on
// mesure ces filtres dessus. Depuis que la génération REMPLACE les doublons en balayant plus
// loin (10 pages max), le livrable est une fourchette :
//   borne basse = fiches retenues sur l'échantillon mesuré (livrées quoi qu'il arrive) ;
//   borne haute = nb demandé, plafonné par ce que le balayage peut encore trouver de frais.
// Pas d'extrapolation de taux : les doublons forment un PRÉFIXE (ordre Pappers stable), pas
// une répartition uniforme — un taux linéaire mentirait dans le cas le plus courant.
// Les cessées/liquidations ne sont détectables qu'en ouvrant les fiches détaillées :
// on ne les devine pas, on les signale.

import { verifierToken, sql } from './db.js';

// Coût d'enrichissement par fiche (fourchette réaliste), basé sur la table tarifs.
// Min = fiche "facile" (GMB + scoring suffisent). Max = waterfall complet (Dropcontact + FullEnrich + Kaspr).
function fourchetteParFiche(tarifs) {
  const t = {};
  for (const r of tarifs) t[r.api] = Number(r.prix) || 0;
  const gmb = t.google_places || 0.02;
  const ia = t.ia_claude || 0.02;
  const drop = t.dropcontact || 0.10;
  const fe = t.fullenrich || 0.25;
  const kaspr = t.kaspr || 0.20;
  const pappers = t.pappers || 0.05;
  // Min : Pappers détail + GMB + scoring IA (email/tel trouvés via GMB)
  const min = pappers + gmb + ia;
  // Max : Pappers détail + GMB + IA + Dropcontact + FullEnrich + Kaspr + scoring
  const max = pappers + gmb + ia + drop + fe + kaspr + ia;
  return { min, max };
}

function nbEtabDe(e) {
  const v = e.nombre_etablissements_ouverts != null ? e.nombre_etablissements_ouverts : e.nombre_etablissements;
  return v == null ? null : Number(v);
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const apiKey = process.env.PAPPERS_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante' });

  try {
    const {
      naf = '', dep = '', region = '',
      effectif_min = '', effectif_max = '',
      ca_min = '', ca_max = '',
      nb_etab_min = '',
      nb_souhaite = '25'
    } = req.query;

    const nbSouhaite = Math.min(parseInt(nb_souhaite) || 25, 500);
    const etabMinNum = parseInt(nb_etab_min) || 0;

    // ── 1. Recherche Pappers : on demande les fiches que la génération rapatrierait vraiment
    //      (même appel « recherche » qu'avant, même coût — seul par_page change). ──
    const base = {
      api_token: apiKey,
      par_page: String(Math.min(nbSouhaite, 100)),
      entreprise_cessee: 'false',
      precision: 'standard'
    };
    if (naf) base.code_naf = naf;
    if (dep) base.departement = dep;
    if (region) base.region = region;
    if (ca_min) base.chiffre_affaires_min = ca_min;
    if (ca_max) base.chiffre_affaires_max = ca_max;

    async function call(extra) {
      const p = new URLSearchParams({ ...base, ...extra });
      const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    }

    // Même cascade effectif que /api/liste (effectif → tranche_effectif → sans filtre) :
    // sans elle, l'estimation comptait une population que la génération n'utilise pas.
    let result, filtreEffectif = 'aucun';
    if (effectif_min || effectif_max) {
      const eff = {};
      if (effectif_min) eff.effectif_min = effectif_min;
      if (effectif_max) eff.effectif_max = effectif_max;
      result = await call(eff); filtreEffectif = 'effectif';
      if (!result.ok || (result.data.total || 0) === 0) {
        const tr = {};
        if (effectif_min) tr.tranche_effectif_min = effectif_min;
        if (effectif_max) tr.tranche_effectif_max = effectif_max;
        result = await call(tr); filtreEffectif = 'tranche_effectif';
      }
      if (!result.ok || (result.data.total || 0) === 0) {
        result = await call({}); filtreEffectif = 'aucun (effectif souvent non renseigné — filtre élargi)';
      }
    } else {
      result = await call({});
    }
    if (!result.ok) return res.status(result.status).json({ erreur: 'Erreur Pappers', detail: result.data });

    const totalDispo = result.data.total || 0;
    const echantillon = result.data.resultats || [];
    const surPage = echantillon.length;

    // ── 2. Les filtres que le comptage Pappers ne sait pas appliquer, mesurés sur l'échantillon ──
    // Ordre identique à /api/liste : dédoublonnage d'abord, seuil d'établissements ensuite.
    let dejaExtraites = 0, sousSeuilEtab = 0, etabInconnu = 0;
    let doublonsMesures = false;
    const listesDoublons = new Set();

    let sirensConnus = null;
    if (sql && surPage) {
      try {
        const existantes = await sql`SELECT nom, sdr, entreprises FROM listes WHERE criteres->>'auto' IS NULL`;
        sirensConnus = new Map(); // siren → "liste (sdr)"
        for (const l of existantes) {
          for (const e of (l.entreprises || [])) {
            if (e.siren) sirensConnus.set(String(e.siren), `${l.nom} (${l.sdr})`);
          }
        }
        doublonsMesures = true;
      } catch (_) { sirensConnus = null; }
    }
    for (const e of echantillon) {
      if (sirensConnus) {
        const ou = sirensConnus.get(String(e.siren));
        if (ou) { dejaExtraites++; listesDoublons.add(ou); continue; }
      }
      // Seuil d'établissements, compté sur les fiches fraîches uniquement (même ordre que la
      // génération). Une fiche sans info au comptage n'est PAS écartée ici — mais elle pourra
      // l'être à la génération, où la fiche détaillée renseigne toujours le nombre : on compte
      // ces inconnues à part pour le dire au SDR.
      if (etabMinNum) {
        const nb = nbEtabDe(e);
        if (nb == null) etabInconnu++;
        else if (nb < etabMinNum) sousSeuilEtab++;
      }
    }

    // ── 3. Fourchette de fiches livrables ──
    // Borne basse : retenues sur la page mesurée (la génération les livrera, aux cessées près).
    const nbMin = Math.min(nbSouhaite, Math.max(0, surPage - dejaExtraites - sousSeuilEtab));
    // Borne haute : la génération remplace les doublons en balayant jusqu'à 10 pages ; les
    // doublons déjà repérés sont perdus, le reste du vivier est disponible.
    const balayageMax = Math.min(totalDispo, 10 * Math.min(nbSouhaite, 100));
    const nbMax = Math.max(nbMin, Math.min(nbSouhaite, balayageMax - dejaExtraites));

    // ── 4. Fourchette de coût d'enrichissement : prudente dans les deux sens.
    // Bas = borne basse × fiche facile ; haut = borne haute × waterfall complet (le solde est
    // comparé au haut, pour ne jamais laisser lancer une liste qu'on ne peut pas payer). ──
    const tarifs = await sql`SELECT api, prix FROM tarifs`;
    const { min, max } = fourchetteParFiche(tarifs);
    const coutMin = Math.round(nbMin * min * 100) / 100;
    const coutMax = Math.round(nbMax * max * 100) / 100;

    // ── 5. Solde du SDR (plafond − conso du mois) ──
    // On calcule la conso de l'utilisateur courant pour le mois en cours.
    const limRows = await sql`SELECT limite_credits FROM sdrs WHERE LOWER(nom) = ${(user.nom || '').toLowerCase()} OR LOWER(email) = ${(user.email || '').toLowerCase()} LIMIT 1`;
    const plafond = limRows.length && limRows[0].limite_credits != null ? Number(limRows[0].limite_credits) : null;

    let consoMois = 0;
    const consoRows = await sql`
      SELECT COALESCE(SUM(c.quantite * COALESCE(t.prix, 0)), 0)::float AS total
      FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
      WHERE LOWER(c.sdr) = ${(user.nom || '').toLowerCase()}
        AND date_trunc('month', c.created_at) = date_trunc('month', NOW())`;
    consoMois = Math.round((consoRows[0]?.total || 0) * 100) / 100;

    const solde = plafond != null ? Math.round((plafond - consoMois) * 100) / 100 : null;
    // Assez de crédits ? (on compare le coût MAX au solde, pour être prudent)
    const assez = plafond == null ? true : (solde >= coutMax);

    return res.status(200).json({
      total_dispo: totalDispo,
      nb_genere: nbMax,       // compat : nombre max livrable (utilisé par demanderCredits)
      nb_genere_min: nbMin,   // mesuré sur l'échantillon — livré quoi qu'il arrive (aux cessées près)
      nb_genere_max: nbMax,
      cout_min: coutMin,
      cout_max: coutMax,
      plafond,            // null = illimité
      conso_mois: consoMois,
      solde,              // null = illimité
      assez,              // false → il faut une allocation
      manque: assez ? 0 : Math.round((coutMax - solde) * 100) / 100,
      // ── Pourquoi le total et le générable diffèrent (mesuré, pas deviné) ──
      sur_page: surPage,                          // taille de l'échantillon analysé (1re page)
      deja_extraites: dejaExtraites,              // doublons repérés — la génération les remplace
      listes_doublons: [...listesDoublons].slice(0, 5),
      sous_seuil_etablissements: sousSeuilEtab,   // écartées par le filtre multi-sites (échantillon)
      etab_inconnu: etabInconnu,                  // fiches fraîches sans info d'établissements au comptage
      filtre_etablissements_min: etabMinNum || null,
      doublons_mesures: doublonsMesures,          // false → base inaccessible, doublons non mesurés
      balayage_max: balayageMax,                  // fiches que la génération peut balayer au maximum
      filtre_effectif: filtreEffectif
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur estimation', detail: String(e.message || e).slice(0, 200) });
  }
}
