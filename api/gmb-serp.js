// /api/gmb-serp.js — Onglet 📍 Google de la Recherche avancée, moteur SERPAPI google_maps
// (wireframe v2, demande Didier 22/09 : « utiliser SerpApi pour Google »).
// Pourquoi SerpApi plutôt que Places Text Search : pagination réelle (20/page, ~120/ville),
// note + nb d'avis inclus SANS appel Details, paramètre pays (gl). Google ne donne JAMAIS de
// total : on renvoie « N balayés », jamais un faux total. Plafond 1 000 recherches/mois partagé
// (compteur + garde-fou de api/serpapi.js via appelSerpApi). Google Places Details ne sert plus
// qu'à la GÉNÉRATION (téléphone, site, pire avis — versFiche/scrape email de gmb-liste réutilisés).
//
// POST { mode:'apercu'|'creer', activites:[nom…] (≤3), villes:[…] (≤5), pays:'fr'|'be'|…,
//        note_min?, note_max?, avis_min?, nb?, page? (aperçu), place_ids? (créer : sélection) }
//   apercu -> { etablissements:[{nom,ville,activite,note,avis,adresse,place_id,doublon}],
//               balayes, page, a_suite }   (1 recherche SerpApi par combinaison activité×ville)
//   creer  -> fiches au format Sofy (mêmes gmb.* que gmb-liste : Details + email du site)

import { verifierToken, loggerConso, sql } from './db.js';
import { appelSerpApi } from './serpapi.js';
import { detailsPlace, versFiche, trouverEmailSite } from './gmb-liste.js';

export const config = { maxDuration: 120 };

// Un local_result SerpApi → le shape « r » que versFiche (gmb-liste) attend (format Places)
function versR(x) {
  return {
    place_id: x.place_id || null,
    name: x.title || '',
    rating: (typeof x.rating === 'number') ? x.rating : null,
    user_ratings_total: x.reviews || 0,
    formatted_address: x.address || '',
    types: x.type ? [x.type] : []
  };
}
function passeNote(x, noteMin, noteMax, avisMin) {
  if (avisMin && (x.reviews || 0) < avisMin) return false;
  if (noteMin != null && (x.rating == null || x.rating < noteMin)) return false;
  if (noteMax != null && (x.rating == null || x.rating > noteMax)) return false;
  return true;
}
// SIREN inconnus côté Google : dédup par place_id contre les listes actives (fiches GMB en base)
async function placeIdsConnus() {
  const connus = new Set();
  try {
    const rows = sql ? await sql`SELECT entreprises FROM listes WHERE archivee = FALSE` : [];
    for (const row of rows) for (const e of (Array.isArray(row.entreprises) ? row.entreprises : [])) {
      if (e.place_id) connus.add(String(e.place_id));
    }
  } catch (_) {}
  return connus;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });

  const {
    mode, activites = [], villes = [], pays = 'fr',
    note_min = null, note_max = null, avis_min = null,
    nb = 30, page = 0
  } = req.body || {};
  const acts = (Array.isArray(activites) ? activites : []).map(a => String((a && a.nom) || a || '').trim()).filter(Boolean).slice(0, 3);
  const vls = (Array.isArray(villes) ? villes : []).map(v => String(v || '').trim()).filter(Boolean).slice(0, 5);
  if (mode !== 'apercu' && mode !== 'creer') return res.status(400).json({ erreur: 'mode inconnu (apercu|creer)' });
  if ((!acts.length || !vls.length) && !(mode === 'creer' && Array.isArray(req.body.selection) && req.body.selection.length)) {
    return res.status(400).json({ erreur: 'activites et villes requis' });
  }
  const gl = /^[a-z]{2}$/i.test(String(pays)) ? String(pays).toLowerCase() : 'fr';
  const noteMin = note_min != null ? parseFloat(note_min) : null;
  const noteMax = note_max != null ? parseFloat(note_max) : null;
  const avisMin = avis_min != null ? parseInt(avis_min, 10) : null;
  const combos = [];
  for (const a of acts) for (const v of vls) combos.push({ a, v });

  // Une page SerpApi google_maps pour une combinaison. ⚠️ Doc SerpApi : `start` (pagination)
  // n'est accepté QU'AVEC `ll` — envoyé seul, Google répond « hasn't returned any results »
  // (bug prod Didier 22/09 : même la page 1 échouait car start=0 était toujours envoyé).
  // Page 1 : q seul. Pages suivantes : ll = coordonnées GPS du 1er résultat de la page 1
  // (transportées par le front dans body.lls, clé "activité|ville").
  const lls = (req.body.lls && typeof req.body.lls === 'object') ? req.body.lls : {};
  function cleCombo(combo) { return combo.a + '|' + combo.v; }
  async function pageSerp(combo, start) {
    const params = { engine: 'google_maps', type: 'search', q: combo.a + ' ' + combo.v, hl: 'fr', gl };
    const ll = lls[cleCombo(combo)];
    if (start > 0) {
      if (!ll) return []; // pagination impossible sans ll (jamais eu de page 1 → rien à paginer)
      params.ll = ll;
      params.start = String(start * 20);
    }
    const r = await appelSerpApi(params, { qui: user.nom || 'recherche-avancee', motif: 'gmb-serp ' + combo.a + '/' + combo.v });
    if (r.refuse || r.sansCle) { const e = new Error((r.d && r.d.error) || 'SerpApi indisponible'); e.plafond = !!r.refuse; throw e; }
    if (!r.ok) {
      // « Google hasn't returned any results » = ZÉRO résultat pour cette combinaison, pas une
      // panne (SerpApi le sert en erreur HTTP) → page vide propre, jamais de toast d'erreur.
      const msg = String((r.d && r.d.error) || '');
      if (/hasn't returned any results/i.test(msg)) return [];
      throw new Error('SerpApi : ' + (msg || r.status));
    }
    const brut = (r.d && r.d.local_results) || [];
    // Mémorise le ll pour les pages suivantes de cette combinaison
    const g = brut[0] && brut[0].gps_coordinates;
    if (!lls[cleCombo(combo)] && g && g.latitude != null) lls[cleCombo(combo)] = '@' + g.latitude + ',' + g.longitude + ',14z';
    return brut;
  }

  try {
    // ── APERÇU : la page N de chaque combinaison, filtre note/avis, doublons signalés ──
    if (mode === 'apercu') {
      const p = Math.max(0, Math.min(parseInt(page, 10) || 0, 5)); // ~120 résultats max/ville chez Google
      const connus = await placeIdsConnus();
      const etablissements = [];
      let balayes = 0, aSuite = false;
      for (const combo of combos.slice(0, 6)) {
        const brut = await pageSerp(combo, p);
        balayes += brut.length;
        if (brut.length >= 20) aSuite = true;
        for (const x of brut) {
          if (!passeNote(x, noteMin, noteMax, avisMin)) continue;
          etablissements.push({
            nom: x.title || '', ville: combo.v, activite: combo.a,
            note: (typeof x.rating === 'number') ? x.rating : null,
            avis: x.reviews || 0,
            adresse: x.address || '',
            place_id: x.place_id || null,
            doublon: !!(x.place_id && connus.has(String(x.place_id)))
          });
        }
      }
      return res.status(200).json({
        etablissements, balayes, page: p, a_suite: aSuite,
        lls, // coordonnées par combinaison — à repasser tel quel pour paginer (exigé par SerpApi)
        recherches_serp: combos.length // consommation SerpApi de cet appel (plafond 1000/mois)
      });
    }

    // ── CRÉER : sélection explicite (place_ids cochés) sinon balayage, puis Details + email ──
    const cap = Math.min(parseInt(nb, 10) || 30, 100);
    const key = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return res.status(500).json({ erreur: 'Clé Google Places manquante (Details)' });
    const connus = await placeIdsConnus();
    const candidats = []; // {r, ville, activite}
    const selection = Array.isArray(req.body.selection) ? req.body.selection.slice(0, 100) : null;
    if (selection && selection.length) {
      // La SÉLECTION de la modale : le front possède déjà nom/note/avis/place_id des pages vues
      // → aucun nouvel appel SerpApi, on part directement sur les Details Google.
      for (const s of selection) {
        if (!s || !s.place_id) continue;
        candidats.push({
          r: { place_id: String(s.place_id), name: String(s.nom || ''), rating: (typeof s.note === 'number') ? s.note : null, user_ratings_total: s.avis || 0, formatted_address: String(s.adresse || ''), types: [] },
          ville: String(s.ville || ''), activite: String(s.activite || '')
        });
      }
    } else {
      for (let p = 0; p <= 5 && candidats.length < cap; p++) {
        let vide = true;
        for (const combo of combos.slice(0, 6)) {
          if (candidats.length >= cap) break;
          const brut = await pageSerp(combo, p);
          if (brut.length) vide = false;
          for (const x of brut) {
            if (candidats.length >= cap) break;
            if (!x.place_id || connus.has(String(x.place_id))) continue;
            if (!passeNote(x, noteMin, noteMax, avisMin)) continue;
            if (candidats.some(c => c.r.place_id === x.place_id)) continue;
            candidats.push({ r: versR(x), ville: combo.v, activite: combo.a });
          }
        }
        if (vide) break;
      }
    }
    if (!candidats.length) return res.status(200).json({ fiches: [], nb: 0, message: 'Aucun établissement retenu — élargis la note, les villes ou la sélection.' });

    // Details Google (tél, site, pire avis) par 5, puis email générique du site — même pipeline
    // que gmb-liste (versFiche/trouverEmailSite réutilisés, fiches 100 % compatibles GMB).
    let nbDetails = 0;
    const fiches = []; const aScraper = [];
    for (let i = 0; i < candidats.length; i += 5) {
      const lot = candidats.slice(i, Math.min(i + 5, candidats.length));
      const dets = await Promise.all(lot.map(c => detailsPlace(c.r.place_id, key)));
      nbDetails += lot.length;
      lot.forEach((c, j) => {
        const det = dets[j] || {};
        const f = versFiche(c.r, det, c.ville, c.activite);
        fiches.push(f);
        if (det.website) aScraper.push({ f, url: det.website });
      });
    }
    const debut = Date.now();
    let emailsTrouves = 0;
    for (let i = 0; i < aScraper.length; i += 8) {
      if (Date.now() - debut > 30000) break;
      await Promise.all(aScraper.slice(i, i + 8).map(async ({ f, url }) => {
        const em = await trouverEmailSite(url, f.site_web).catch(() => null);
        if (!em) return;
        emailsTrouves++;
        f.contacts = [{ prenom: '', nom: 'Accueil / Standard', fonction: 'Email générique (site web)', source: 'site_web', enrich: { email: em, email_qualification: 'générique site' } }];
      }));
    }
    await loggerConso(user, 'google_places', nbDetails, null);
    return res.status(200).json({ fiches, nb: fiches.length, emails_trouves: emailsTrouves });
  } catch (e) {
    // appelSerpApi lève une erreur claire quand le plafond mensuel est atteint : on la relaie
    return res.status(e.plafond ? 429 : 500).json({ erreur: String(e.message || e).slice(0, 200) });
  }
}
