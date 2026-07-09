// /api/gmb-liste.js — Liste depuis Google Maps (fiches Google Business) pour cibler SoView.
// La note Google est le signal de vente : on cible par ville + activité + tranche de note.
//
// POST { mode:'estimer'|'creer', activite, villes:[...], note_min?, note_max?, nb? }
//   estimer -> 1 page Text Search par ville (20 résultats max), comptage + échantillon (pas de Details)
//   creer   -> jusqu'à 3 pages/ville (60 max/ville, limite Google), filtre note,
//              puis Place Details (site web + téléphone) sur les fiches retenues
//              -> fiches au format Sofy (gmb.note_moyenne, telephone_google, maps_url…).
//
// Coût : Text Search + Details par fiche retenue -> journalisé dans consommations (google_places).

import { verifierToken, loggerConso } from './db.js';

const BASE = 'https://maps.googleapis.com/maps/api/place';

function cpDepuisAdresse(adr) { const m = String(adr || '').match(/\b(\d{5})\b/); return m ? m[1] : ''; }
function domaineDeUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

async function pageTextSearch(params, key) {
  const p = new URLSearchParams({ ...params, language: 'fr', region: 'fr', key });
  const r = await fetch(BASE + '/textsearch/json?' + p.toString());
  const d = await r.json().catch(() => null);
  if (!d || (d.status !== 'OK' && d.status !== 'ZERO_RESULTS' && d.status !== 'INVALID_REQUEST')) {
    throw Object.assign(new Error('Google Places : ' + ((d && d.status) || 'réponse invalide')), { google: (d && d.error_message) || null });
  }
  return d;
}

async function detailsPlace(placeId, key) {
  const p = new URLSearchParams({ place_id: placeId, fields: 'website,formatted_phone_number,url', language: 'fr', key });
  const r = await fetch(BASE + '/details/json?' + p.toString());
  const d = await r.json().catch(() => null);
  return (d && d.status === 'OK' && d.result) ? d.result : {};
}

// Garde une place ? (ouverte + filtre de note ; sans note = gardée seulement si aucun filtre)
function passeFiltre(r, noteMin, noteMax) {
  if (r.business_status && r.business_status !== 'OPERATIONAL') return false;
  const aFiltre = (noteMin != null || noteMax != null);
  if (typeof r.rating !== 'number') return !aFiltre;
  if (noteMin != null && r.rating < noteMin) return false;
  if (noteMax != null && r.rating > noteMax) return false;
  return true;
}

function versFiche(r, det, ville, activite) {
  const site = det.website ? domaineDeUrl(det.website) : null;
  return {
    nom: r.name || 'Sans nom',
    ville: ville || '', code_postal: cpDepuisAdresse(r.formatted_address), region: '',
    adresse: r.formatted_address || '',
    naf: null, siren: null,
    site_web: site, linkedin_entreprise: null,
    persona_ia: null, activite: activite || null,
    effectif: null, chiffre_affaires: null, nb_etablissements: null,
    dirigeant: null, enseigne: r.name || null, source: 'gmb',
    telephone_google: det.formatted_phone_number || null,
    maps_url: det.url || ('https://www.google.com/maps/place/?q=place_id:' + r.place_id),
    detail_charge: true,
    gmb: {
      trouve: true,
      note_moyenne: (typeof r.rating === 'number') ? r.rating : null,
      total_avis: r.user_ratings_total || 0,
      nb_fiches: 1,
      place_id: r.place_id,
      telephone: det.formatted_phone_number || null,
      site_web: site,
      // Un seul établissement -> sa propre fiche sert de « pire fiche » (lien direct vers les avis)
      pire_fiche: (typeof r.rating === 'number') ? {
        nom: r.name || '',
        note: r.rating,
        nb_avis: r.user_ratings_total || 0,
        lien: 'https://search.google.com/local/reviews?placeid=' + r.place_id,
        place_id: r.place_id
      } : null
    },
    contacts: []
  };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante' });

  const b = req.body || {};
  const mode = b.mode;
  const activite = String(b.activite || '').trim();
  const villes = (Array.isArray(b.villes) ? b.villes : String(b.villes || '').split(','))
    .map(v => String(v).trim()).filter(Boolean).slice(0, 5); // max 5 villes (3 pages Google/ville)
  const noteMin = (b.note_min !== undefined && b.note_min !== null && b.note_min !== '') ? parseFloat(b.note_min) : null;
  const noteMax = (b.note_max !== undefined && b.note_max !== null && b.note_max !== '') ? parseFloat(b.note_max) : null;
  const nb = Math.min(Math.max(parseInt(b.nb, 10) || 30, 1), 100); // Details facturés par fiche -> cap 100
  if (!activite || !villes.length) return res.status(400).json({ erreur: 'activite et villes requis' });

  let nbAppels = 0;
  try {
    // ============ ESTIMER : 1 page par ville, gratuitissime, échantillon réel ============
    if (mode === 'estimer') {
      let total = 0, avecSuite = 0; const echantillon = [];
      for (const ville of villes) {
        const d = await pageTextSearch({ query: activite + ' ' + ville }, key); nbAppels++;
        const ok = (d.results || []).filter(r => passeFiltre(r, noteMin, noteMax));
        total += ok.length;
        if (d.next_page_token) avecSuite++;
        for (const r of ok.slice(0, 3)) {
          if (echantillon.length >= 6) break;
          echantillon.push({ nom: r.name, ville, note: (typeof r.rating === 'number') ? r.rating : null, avis: r.user_ratings_total || 0 });
        }
      }
      await loggerConso(user, 'google_places', nbAppels, null);
      return res.status(200).json({
        mode_recherche: 'gmb',
        nb_etablissements: total,           // sur la 1re page de chaque ville
        peut_aller_plus_loin: avecSuite > 0, // Google permet jusqu'à 60 résultats/ville
        echantillon,
        _filtres: { activite, villes, note_min: noteMin, note_max: noteMax }
      });
    }

    // ============ CREER : jusqu'à 3 pages/ville, filtre note, Details sur les retenues ============
    if (mode === 'creer') {
      const vus = new Set(); const candidats = [];
      for (const ville of villes) {
        if (candidats.length >= nb) break;
        let token = null;
        for (let page = 0; page < 3; page++) {
          if (candidats.length >= nb) break;
          if (token) await new Promise(s => setTimeout(s, 2000)); // le pagetoken Google met ~2 s à s'activer
          const d = await pageTextSearch(token ? { pagetoken: token } : { query: activite + ' ' + ville }, key); nbAppels++;
          for (const r of (d.results || [])) {
            if (candidats.length >= nb) break;
            if (!r.place_id || vus.has(r.place_id)) continue;
            vus.add(r.place_id);
            if (!passeFiltre(r, noteMin, noteMax)) continue;
            candidats.push({ r, ville });
          }
          token = d.next_page_token || null;
          if (!token) break;
        }
      }
      // Détails (site + téléphone) par paquets de 5 en parallèle
      const fiches = [];
      for (let i = 0; i < candidats.length; i += 5) {
        const lot = candidats.slice(i, i + 5);
        const dets = await Promise.all(lot.map(c => detailsPlace(c.r.place_id, key)));
        nbAppels += lot.length;
        lot.forEach((c, j) => fiches.push(versFiche(c.r, dets[j] || {}, c.ville, activite)));
      }
      await loggerConso(user, 'google_places', nbAppels, null);
      return res.status(200).json({
        fiches, nb: fiches.length, mode_recherche: 'gmb',
        message: fiches.length ? undefined : 'Aucun établissement ne passe le filtre de note sur ces villes — élargis la tranche ou ajoute des villes.'
      });
    }

    return res.status(400).json({ erreur: 'mode inconnu (estimer|creer)' });
  } catch (e) {
    if (e.google !== undefined) return res.status(502).json({ erreur: e.message, detail: e.google || 'Vérifier la clé Google Places' });
    return res.status(500).json({ erreur: 'Erreur Google Places', detail: String(e.message || e).slice(0, 200) });
  }
}
