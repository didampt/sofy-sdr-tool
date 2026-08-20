// /api/avis-reponses.js — ⭐ Taux de réponse aux avis et délai réel, via SerpApi.
//
// POURQUOI CE FICHIER EXISTE. L'API Google Places (Details) renvoie jusqu'à 5 avis avec leur note
// et leur texte, mais **jamais la réponse du propriétaire** : le champ n'existe pas dans son
// modèle de données. Le taux de réponse et le délai de première réponse — les deux critères qui
// vendent Soview — étaient donc marqués « non mesurable depuis l'extérieur » dans le scoring.
//
// SerpApi lit la page Google Maps et expose, pour chaque avis, un objet `response` avec
// `response.snippet` (le texte de la réponse) et `response.iso_date`. On peut donc calculer :
//   · le taux de réponse sur les avis RÉCENTS (la pratique actuelle, pas une moyenne historique) ;
//   · le délai médian entre l'avis et sa réponse ;
//   · le plus ancien avis resté sans réponse.
//
// POST { place_id, nom? }   → mesure et renvoie le bilan
// Variable d'environnement requise : SERPAPI_KEY (à créer dans Vercel, jamais dans le code).
//
// Coût : environ 0,01 $ par fiche analysée. La mesure est donc faite À LA DEMANDE, jamais en
// masse, et le résultat est réutilisé pendant 30 jours.

import { verifierToken, sql } from './db.js';

export const config = { maxDuration: 60 };

// SerpApi refuse le paramètre `num` sur la PREMIÈRE page : « num parameter should not be used on
// the initial page unless next_page_token, topic_id, or query is set. It always returns 8 results ».
// On prend donc les 8 avis de la première page, puis UNE page de plus via next_page_token — soit
// une quinzaine d'avis récents pour deux appels, ce qui suffit à juger une pratique de réponse.
const PAGES = 2;
const CACHE_JOURS = 30;

let pret = false;
async function ensureCache() {
  if (pret || !sql) return;
  // Table paresseuse (aucun bump de SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS avis_reponses (
    place_id TEXT PRIMARY KEY,
    nom TEXT,
    analyses INTEGER,
    repondus INTEGER,
    taux INTEGER,
    delai_median_h INTEGER,
    delai_max_h INTEGER,
    plus_vieux_sans_reponse TEXT,
    rythme_par_mois NUMERIC,
    fenetre_mois NUMERIC,
    mesure_le TIMESTAMPTZ DEFAULT NOW(),
    mesure_par TEXT
  )`;
  try { await sql`ALTER TABLE avis_reponses ADD COLUMN IF NOT EXISTS rythme_par_mois NUMERIC`; } catch (_) {}
  try { await sql`ALTER TABLE avis_reponses ADD COLUMN IF NOT EXISTS fenetre_mois NUMERIC`; } catch (_) {}
  pret = true;
}

// À quelle vitesse ce prospect collecte-t-il des avis AUJOURD'HUI ? Les avis récupérés ici sont
// triés du plus récent au plus ancien : l'écart de dates entre le premier et le dernier de
// l'échantillon donne son rythme réel, sans un appel de plus. C'est la mesure qui manquait pour
// que la courbe de trajectoire soit adossée à SES chiffres et non à une constante inventée.
function rythmeDe(avis) {
  const dates = avis.map(a => a && a.iso_date).filter(Boolean)
    .map(d => new Date(d).getTime()).filter(t => isFinite(t)).sort((a, b) => b - a);
  if (dates.length < 3) return { rythme: null, fenetre: null };
  const mois = (dates[0] - dates[dates.length - 1]) / (1000 * 3600 * 24 * 30.44);
  // Une salve d'avis le même jour donnerait un rythme absurde : sous un mois d'écart, la mesure
  // n'est pas exploitable et on préfère ne rien affirmer.
  if (!(mois >= 1)) return { rythme: null, fenetre: Math.round(mois * 10) / 10 };
  const r = (dates.length - 1) / mois;
  return { rythme: Math.round(Math.min(200, r) * 100) / 100, fenetre: Math.round(mois * 10) / 10 };
}

const heures = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 3600000);
const median = arr => {
  if (!arr.length) return null;
  const t = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : Math.round((t[m - 1] + t[m]) / 2);
};

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureCache();

  const cle = process.env.SERPAPI_KEY;
  if (!cle) {
    return res.status(500).json({
      erreur: 'SERPAPI_KEY absente',
      detail: 'Ajoute la variable SERPAPI_KEY dans Vercel (Settings › Environment Variables) puis redéploie. Sans elle, le taux de réponse aux avis reste non mesurable — l\'API Google ne l\'expose pas.'
    });
  }

  const b = req.body || {};
  const placeId = String(b.place_id || '').trim();
  if (!placeId) return res.status(400).json({ erreur: 'place_id requis (il est dans la fiche Google du prospect)' });

  // Réutilisation : une pratique de réponse aux avis ne change pas d'un jour à l'autre.
  if (!b.forcer) {
    try {
      const [c] = await sql`SELECT * FROM avis_reponses WHERE place_id = ${placeId}
        AND mesure_le > NOW() - (${CACHE_JOURS} || ' days')::interval`;
      if (c) return res.status(200).json({ ok: true, cache: true, mesure: c });
    } catch (_) { }
  }

  // SerpApi accepte place_id OU data_id, mais le place_id de l'API Places n'est pas toujours
  // reconnu tel quel. Repli : on récupère le data_id de la fiche puis on relance. Un appel de
  // plus, seulement quand c'est nécessaire.
  const lire = async (params) => {
    const u = 'https://serpapi.com/search.json?' + new URLSearchParams(
      { ...params, hl: 'fr', api_key: cle }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d };
  };

  let avis = [], via = 'place_id', titre = null;
  try {
    // Première page : SANS `num` (l'API le refuse ici), triée du plus récent au plus ancien.
    const base = { engine: 'google_maps_reviews', sort_by: 'newestFirst' };
    let rep = await lire({ ...base, place_id: placeId });
    let jeton = null;

    if (!rep.ok || (rep.d && rep.d.error) || !Array.isArray(rep.d.reviews)) {
      // Repli : retrouver le data_id de la fiche, que SerpApi reconnaît toujours.
      const pl = await lire({ engine: 'google_maps', type: 'place', place_id: placeId });
      const did = pl.d && ((pl.d.place_results && pl.d.place_results.data_id) || (pl.d.search_metadata || {}).data_id);
      if (did) { via = 'data_id'; rep = await lire({ ...base, data_id: did }); }
      if (!rep.ok || (rep.d && rep.d.error) || !Array.isArray(rep.d.reviews)) {
        return res.status(502).json({
          erreur: 'SerpApi n\'a pas rendu les avis',
          detail: String((rep.d && rep.d.error) || ('HTTP ' + rep.status)).slice(0, 220),
          piste: did ? 'Le data_id a été trouvé mais les avis restent inaccessibles — la fiche est peut-être sans avis publics.'
                     : 'Impossible de retrouver l\'identifiant Maps de cette fiche. Relance l\'analyse GMB, ou rattache la fiche par son lien Maps.'
        });
      }
    }
    avis = rep.d.reviews.slice();
    titre = (rep.d.place_info && rep.d.place_info.title) || null;
    jeton = (rep.d.serpapi_pagination && rep.d.serpapi_pagination.next_page_token) || null;
    const idBase = via === 'data_id' ? { data_id: rep.d.search_parameters && rep.d.search_parameters.data_id } : { place_id: placeId };

    // Pages suivantes : ici `num` est autorisé puisqu'un next_page_token accompagne la requête.
    for (let k = 1; k < PAGES && jeton; k++) {
      const suite = await lire({ ...base, ...idBase, next_page_token: jeton, num: '20' });
      if (!suite.ok || !Array.isArray(suite.d.reviews) || !suite.d.reviews.length) break;
      avis = avis.concat(suite.d.reviews);
      jeton = (suite.d.serpapi_pagination && suite.d.serpapi_pagination.next_page_token) || null;
    }
  } catch (e) {
    return res.status(502).json({ erreur: 'SerpApi injoignable', detail: String((e && e.message) || e).slice(0, 160) });
  }
  if (!avis.length) {
    return res.status(200).json({
      ok: true, vide: true,
      info: 'Aucun avis récupéré pour cette fiche : elle est peut-être sans avis, ou son identifiant a changé.'
    });
  }

  const delais = [];
  let repondus = 0, plusVieuxSans = null;
  for (const a of avis) {
    const rep = a.response || null;
    if (rep) {
      repondus++;
      if (a.iso_date && rep.iso_date) {
        const h = heures(a.iso_date, rep.iso_date);
        if (h >= 0 && h < 24 * 365) delais.push(h);   // au-delà d'un an, la donnée n'a plus de sens
      }
    } else if (a.iso_date) {
      // Le plus ANCIEN avis sans réponse : c'est celui qui traîne en public depuis le plus longtemps.
      if (!plusVieuxSans || new Date(a.iso_date) < new Date(plusVieuxSans)) plusVieuxSans = a.iso_date;
    }
  }

  const ry = rythmeDe(avis);
  const mesure = {
    place_id: placeId,
    nom: b.nom ? String(b.nom).slice(0, 160) : titre,
    rythme_par_mois: ry.rythme,
    fenetre_mois: ry.fenetre,
    analyses: avis.length,
    repondus,
    taux: Math.round((repondus / avis.length) * 100),
    delai_median_h: median(delais),
    delai_max_h: delais.length ? Math.max(...delais) : null,
    plus_vieux_sans_reponse: plusVieuxSans
  };

  try {
    await sql`INSERT INTO avis_reponses (place_id, nom, analyses, repondus, taux,
        delai_median_h, delai_max_h, plus_vieux_sans_reponse, rythme_par_mois, fenetre_mois, mesure_le, mesure_par)
      VALUES (${mesure.place_id}, ${mesure.nom}, ${mesure.analyses}, ${mesure.repondus}, ${mesure.taux},
              ${mesure.delai_median_h}, ${mesure.delai_max_h}, ${mesure.plus_vieux_sans_reponse},
              ${mesure.rythme_par_mois}, ${mesure.fenetre_mois}, NOW(), ${user.nom})
      ON CONFLICT (place_id) DO UPDATE SET nom = EXCLUDED.nom, analyses = EXCLUDED.analyses,
        repondus = EXCLUDED.repondus, taux = EXCLUDED.taux, delai_median_h = EXCLUDED.delai_median_h,
        delai_max_h = EXCLUDED.delai_max_h, plus_vieux_sans_reponse = EXCLUDED.plus_vieux_sans_reponse,
        rythme_par_mois = EXCLUDED.rythme_par_mois, fenetre_mois = EXCLUDED.fenetre_mois,
        mesure_le = NOW(), mesure_par = EXCLUDED.mesure_par`;
  } catch (_) { }

  // Une phrase prête à lire, formulée sur le seul échantillon mesuré — jamais généralisée.
  const d = mesure.delai_median_h;
  const lisible = d == null ? null
    : (d < 48 ? `${d} h` : `${Math.round(d / 24)} jours`);
  return res.status(200).json({
    ok: true, cache: false, mesure, via,
    resume: mesure.taux === 0
      ? `Aucun des ${mesure.analyses} avis les plus récents n'a reçu de réponse publique.`
      : `${mesure.repondus} des ${mesure.analyses} avis récents ont une réponse publique (${mesure.taux} %)${lisible ? `, avec un délai médian de ${lisible}` : ''}.`,
    rythme: mesure.rythme_par_mois != null
      ? `Rythme actuel de collecte : ${String(mesure.rythme_par_mois).replace('.', ',')} avis par mois (mesuré sur ${mesure.analyses} avis étalés sur ${String(mesure.fenetre_mois).replace('.', ',')} mois).`
      : null,
    cout_estime_usd: 0.01
  });
}
