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

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { verifierToken, loggerConso, limiteAtteinte, sql, ensureSchema } = await import('./db.js');
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
    nb_etab_min = '',
    nb = '25'
  } = req.query;
  const nbDemande = Math.min(parseInt(nb) || 25, 500); // jusqu'à 500 fiches (5 pages Pappers)

  if (!naf) return res.status(400).json({ erreur: "Paramètre 'naf' requis" });

  // ── 1. Recherche (avec fallback effectif en 3 niveaux) ──
  const base = {
    api_token: apiKey,
    code_naf: naf,
    entreprise_cessee: 'false',
    par_page: Math.min(nbDemande, 100).toString(),
    precision: 'standard'
  };
  if (dep) base.departement = dep;
  if (ca_min) base.chiffre_affaires_min = ca_min;
  if (ca_max) base.chiffre_affaires_max = ca_max;

  async function call(extra, page) {
    const p = new URLSearchParams({ ...base, ...extra, ...(page ? { page: String(page) } : {}) });
    const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }
  let filtresRetenus = null; // mémorise le niveau de filtre qui a fonctionné (pour paginer avec les mêmes)

  let result, filtreEffectif = 'aucun';
  const wantsEff = !!(effectif_min || effectif_max);
  try {
    if (wantsEff) {
      const eff = {};
      if (effectif_min) eff.effectif_min = effectif_min;
      if (effectif_max) eff.effectif_max = effectif_max;
      result = await call(eff); filtreEffectif = 'effectif'; filtresRetenus = eff;
      if (!result.ok || (result.data.total || 0) === 0) {
        const tr = {};
        if (effectif_min) tr.tranche_effectif_min = effectif_min;
        if (effectif_max) tr.tranche_effectif_max = effectif_max;
        result = await call(tr); filtreEffectif = 'tranche_effectif'; filtresRetenus = tr;
      }
      if (!result.ok || (result.data.total || 0) === 0) {
        result = await call({}); filtreEffectif = 'aucun (effectif souvent non renseigné — filtre élargi)'; filtresRetenus = {};
      }
    } else {
      result = await call({}); filtresRetenus = {};
    }

    if (!result.ok) return res.status(result.status).json({ erreur: 'Erreur Pappers', detail: result.data });

    let bruts = result.data.resultats || [];
    // ── Pagination : pages suivantes (Pappers max 100/page) jusqu'à nb demandé ──
    const totalDispo = result.data.total || bruts.length;
    let page = 2;
    while (bruts.length < Math.min(nbDemande, totalDispo) && page <= 5) {
      const suite = await call(filtresRetenus || {}, page);
      const rs = (suite.ok && suite.data.resultats) || [];
      if (!rs.length) break;
      bruts = bruts.concat(rs);
      page++;
    }
    bruts = bruts.slice(0, nbDemande);

    // ── Dédoublonnage inter-listes : exclure les SIREN déjà extraits par un SDR (économise les crédits détail) ──
    let doublonsInterListes = 0;
    const listesTouchees = new Set();
    if (sql) {
      try {
        await ensureSchema();
        const existantes = await sql`SELECT nom, sdr, entreprises FROM listes WHERE criteres->>'auto' IS NULL`;
        const sirensConnus = new Map(); // siren → "liste (sdr)"
        for (const l of existantes) {
          for (const e of (l.entreprises || [])) {
            if (e.siren) sirensConnus.set(String(e.siren), `${l.nom} (${l.sdr})`);
          }
        }
        bruts = bruts.filter(e => {
          const ou = sirensConnus.get(String(e.siren));
          if (ou) { doublonsInterListes++; listesTouchees.add(ou); return false; }
          return true;
        });
      } catch (_) {}
    }

    // ── 2. Détail (dirigeants, CA, établissements) — par lots de 5 en parallèle ──
    const nDetail = bruts.length; // toutes les fiches sont détaillées (1 crédit Pappers chacune)
    const details = new Array(bruts.length).fill(null);
    for (let i = 0; i < nDetail; i += 10) {
      const lot = bruts.slice(i, Math.min(i + 10, nDetail));
      const resultats = await Promise.all(lot.map(e => detailEntreprise(e.siren, apiKey)));
      resultats.forEach((d, j) => { details[i + j] = d; });
    }

    // ── 3. Fusion + exclusion des entreprises cessées ou en procédure collective ──
    let exclues = 0;
    let exclusEtab = 0;
    const etabMinNum = parseInt(nb_etab_min) || 0;
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
      // Filtre ICP multi-sites : exclut les entreprises sous le seuil d'établissements.
      // On ne filtre que si le nombre est connu (fiche détaillée) — sinon on garde (info absente ≠ exclusion).
      if (etabMinNum && e.nb_etablissements != null && e.nb_etablissements < etabMinNum) { exclusEtab++; return false; }
      return true;
    }).map(({ _cessee, _proc, ...e }) => e);

    await loggerConso(user, 'pappers', nDetail + 1, req.query.liste_id);
    return res.status(200).json({
      total: result.data.total || entreprises.length,
      filtre_effectif: filtreEffectif,
      fiches_detaillees: nDetail,
      exclues_cessees_ou_liquidation: exclues,
      exclus_sous_seuil_etablissements: exclusEtab,
      filtre_etablissements_min: etabMinNum || null,
      doublons_inter_listes: doublonsInterListes,
      listes_doublons: [...listesTouchees].slice(0, 5),
      credits_estimes: nDetail + 1,
      entreprises
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
