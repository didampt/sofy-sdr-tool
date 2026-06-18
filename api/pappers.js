// /api/pappers.js — Recherche d'entreprises via l'API Pappers
// Clé lue depuis la variable d'environnement PAPPERS_API_KEY.
// Filtre effectif en 3 niveaux : effectif_min/max → tranche_effectif_min/max → sans filtre (fallback).

import { verifierToken } from './db.js';

async function callPappers(baseParams, effectifMode, effMin, effMax) {
  const params = new URLSearchParams(baseParams);
  if (effectifMode === 'effectif') {
    if (effMin) params.set('effectif_min', effMin);
    if (effMax) params.set('effectif_max', effMax);
  } else if (effectifMode === 'tranche') {
    if (effMin) params.set('tranche_effectif_min', effMin);
    if (effMax) params.set('tranche_effectif_max', effMax);
  }
  const r = await fetch('https://api.pappers.fr/v2/recherche?' + params.toString());
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  // Sécurité : réservé aux utilisateurs authentifiés (sinon un tiers consomme les crédits Pappers)
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const apiKey = process.env.PAPPERS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erreur: "PAPPERS_API_KEY manquante dans Vercel" });
  }

  const {
    naf = '', dep = '',
    effectif_min = '', effectif_max = '',
    ca_min = '', ca_max = '',
    nb = '10'
  } = req.query;

  if (!naf) return res.status(400).json({ erreur: "Paramètre 'naf' requis (ex: ?naf=4511Z)" });

  const baseParams = {
    api_token: apiKey,
    code_naf: naf,
    entreprise_cessee: 'false',
    par_page: Math.min(parseInt(nb) || 10, 100).toString(),
    precision: 'standard'
  };
  if (dep) baseParams.departement = dep;
  if (ca_min) baseParams.chiffre_affaires_min = ca_min;
  if (ca_max) baseParams.chiffre_affaires_max = ca_max;

  const wantsEffectif = !!(effectif_min || effectif_max);

  try {
    let result, filtreEffectif = 'aucun';

    if (wantsEffectif) {
      // Niveau 1 : effectif_min/max
      result = await callPappers(baseParams, 'effectif', effectif_min, effectif_max);
      filtreEffectif = 'effectif';
      // Niveau 2 : tranche_effectif_min/max
      if (!result.ok || (result.data.total || 0) === 0) {
        result = await callPappers(baseParams, 'tranche', effectif_min, effectif_max);
        filtreEffectif = 'tranche_effectif';
      }
      // Niveau 3 : sans filtre effectif (données souvent manquantes, surtout DOM)
      if (!result.ok || (result.data.total || 0) === 0) {
        result = await callPappers(baseParams, 'aucun');
        filtreEffectif = 'aucun (donnée effectif souvent manquante — filtre élargi)';
      }
    } else {
      result = await callPappers(baseParams, 'aucun');
    }

    if (!result.ok) {
      return res.status(result.status).json({ erreur: 'Erreur Pappers', detail: result.data });
    }

    const entreprises = (result.data.resultats || []).map(e => ({
      nom: e.nom_entreprise,
      siren: e.siren,
      naf: e.code_naf,
      activite: e.libelle_code_naf,
      ville: e.siege?.ville || '',
      code_postal: e.siege?.code_postal || '',
      effectif: e.effectif || e.tranche_effectif || null,
      chiffre_affaires: e.dernier_chiffre_affaires || e.chiffre_affaires || null,
      nb_etablissements: e.nombre_etablissements_ouverts || e.nombre_etablissements || null,
      site_web: e.site_internet || null
    }));

    return res.status(200).json({
      total: result.data.total || entreprises.length,
      page: result.data.page || 1,
      filtre_effectif: filtreEffectif,
      entreprises
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
