// /api/liste.js — Génère une liste complète : recherche Pappers + détail par entreprise
// Détail récupéré (dirigeants, CA, nb établissements) pour les N premières entreprises (max 25)
// pour maîtriser la consommation de crédits Pappers (~1 crédit / fiche détaillée).

const FONCTIONS_PRIORITAIRES = ['président', 'directeur général', 'gérant', 'directrice générale', 'présidente', 'gérante'];
const FONCTIONS_EXCLUES = ['commissaire', 'liquidateur', 'administrateur judiciaire'];

function meilleurDirigeant(representants) {
  if (!Array.isArray(representants)) return null;
  // Personnes physiques uniquement, hors commissaires aux comptes & co
  const persons = representants.filter(r =>
    !r.personne_morale &&
    (r.nom || r.nom_complet) &&
    !FONCTIONS_EXCLUES.some(f => (r.qualite || '').toLowerCase().includes(f))
  );
  if (!persons.length) return null;
  // Priorité aux fonctions de direction ; sinon premier représentant restant
  const prio = persons.find(p => FONCTIONS_PRIORITAIRES.some(f => (p.qualite || '').toLowerCase().includes(f)));
  const d = prio || persons[0];
  return {
    prenom: (d.prenom || '').split(',')[0].trim(),
    nom: d.nom || d.nom_complet || '',
    fonction: d.qualite || '',
    age: d.age || null
  };
}

function dernierCA(e) {
  if (e.dernier_chiffre_affaires) return e.dernier_chiffre_affaires;
  if (Array.isArray(e.finances) && e.finances.length) {
    const tri = [...e.finances].sort((a, b) => (b.annee || 0) - (a.annee || 0));
    return tri[0].chiffre_affaires || null;
  }
  return e.chiffre_affaires || null;
}

async function detailEntreprise(siren, apiKey) {
  try {
    const r = await fetch(`https://api.pappers.fr/v2/entreprise?api_token=${apiKey}&siren=${siren}`);
    if (!r.ok) return null;
    const e = await r.json();
    // Procédure collective en cours (liquidation, redressement, sauvegarde)
    const procEnCours = !!(
      e.procedure_collective_en_cours === true ||
      e.procedure_collective === true ||
      (Array.isArray(e.procedures_collectives) && e.procedures_collectives.some(p => p.en_cours === true || !p.date_fin))
    );
    return {
      cessee: e.entreprise_cessee === true || !!e.date_cessation,
      procedure_collective: procEnCours,
      dirigeant: meilleurDirigeant(e.representants),
      chiffre_affaires: dernierCA(e),
      nb_etablissements: e.nombre_etablissements_ouverts || e.nombre_etablissements || null,
      site_web: e.site_internet || null,
      date_creation: e.date_creation || null,
      enseigne: e.siege?.enseigne || e.nom_commercial || e.sigle || null
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { verifierToken, loggerConso, limiteAtteinte } = await import('./db.js');
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} € — vois avec Didier` });

  const apiKey = process.env.PAPPERS_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante dans Vercel' });

  const {
    naf = '', dep = '',
    effectif_min = '', effectif_max = '',
    ca_min = '', ca_max = '',
    nb = '25',
    detail = '25' // nombre de fiches détaillées (crédits) — plafonné à 25
  } = req.query;

  if (!naf) return res.status(400).json({ erreur: "Paramètre 'naf' requis" });

  // ── 1. Recherche (avec fallback effectif en 3 niveaux) ──
  const base = {
    api_token: apiKey,
    code_naf: naf,
    entreprise_cessee: 'false',
    par_page: Math.min(parseInt(nb) || 25, 100).toString(),
    precision: 'standard'
  };
  if (dep) base.departement = dep;
  if (ca_min) base.chiffre_affaires_min = ca_min;
  if (ca_max) base.chiffre_affaires_max = ca_max;

  async function call(extra) {
    const p = new URLSearchParams({ ...base, ...extra });
    const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  let result, filtreEffectif = 'aucun';
  const wantsEff = !!(effectif_min || effectif_max);
  try {
    if (wantsEff) {
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

    const bruts = result.data.resultats || [];

    // ── 2. Détail (dirigeants, CA, établissements) — par lots de 5 en parallèle ──
    const nDetail = Math.min(parseInt(detail) || 25, 25, bruts.length);
    const details = new Array(bruts.length).fill(null);
    for (let i = 0; i < nDetail; i += 5) {
      const lot = bruts.slice(i, Math.min(i + 5, nDetail));
      const resultats = await Promise.all(lot.map(e => detailEntreprise(e.siren, apiKey)));
      resultats.forEach((d, j) => { details[i + j] = d; });
    }

    // ── 3. Fusion + exclusion des entreprises cessées ou en procédure collective ──
    let exclues = 0;
    const entreprises = bruts.map((e, i) => {
      const d = details[i] || {};
      return {
        nom: e.nom_entreprise,
        siren: e.siren,
        naf: e.code_naf,
        activite: e.libelle_code_naf,
        ville: e.siege?.ville || '',
        code_postal: e.siege?.code_postal || '',
        adresse: e.siege?.adresse_ligne_1 || '',
        effectif: e.effectif || e.tranche_effectif || null,
        chiffre_affaires: d.chiffre_affaires || e.dernier_chiffre_affaires || null,
        nb_etablissements: d.nb_etablissements || e.nombre_etablissements_ouverts || null,
        site_web: d.site_web || e.site_internet || null,
        date_creation: d.date_creation || null,
        dirigeant: d.dirigeant || null,
        enseigne: d.enseigne || null,
        detail_charge: details[i] !== null,
        _cessee: d.cessee === true,
        _proc: d.procedure_collective === true
      };
    }).filter(e => {
      if (e._cessee || e._proc) { exclues++; return false; }
      return true;
    }).map(({ _cessee, _proc, ...e }) => e);

    await loggerConso(user, 'pappers', nDetail + 1, req.query.liste_id);
    return res.status(200).json({
      total: result.data.total || entreprises.length,
      filtre_effectif: filtreEffectif,
      fiches_detaillees: nDetail,
      exclues_cessees_ou_liquidation: exclues,
      credits_estimes: nDetail + 1,
      entreprises
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
