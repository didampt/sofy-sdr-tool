// /api/gmb.js — Analyse Google Business Profile d'une entreprise
// Matching multi-signaux : nom (avec variante compacte type "A 2G"→"A2G"), adresse du siège
// Pappers + code postal, et cohérence de catégorie vs NAF.

const MOTS_CLES_CONCURRENTS = {
  '45.11': 'concessionnaire automobile', '45.20': 'garage automobile',
  '45.32': 'pièces automobiles', '45.40': 'concessionnaire moto',
  '77.11': 'location de voitures', '96.02': 'salon de coiffure',
  '47.73': 'pharmacie', '56.10': 'restaurant', '56.30': 'bar',
  '55.10': 'hôtel', '68.31': 'agence immobilière', '93.13': 'salle de sport',
  '47.24': 'boulangerie'
};

const TYPES_ATTENDUS = {
  '45.11': ['car_dealer','car_repair','car_rental','store'],
  '45.20': ['car_repair','car_dealer','car_wash'],
  '45.32': ['car_repair','store'],
  '45.40': ['car_dealer','car_repair','store'],
  '77.11': ['car_rental'],
  '96.02': ['hair_care','beauty_salon','spa'],
  '47.73': ['pharmacy','drugstore','health'],
  '56.10': ['restaurant','food','meal_takeaway'],
  '56.30': ['bar','night_club','cafe'],
  '55.10': ['lodging'],
  '68.31': ['real_estate_agency'],
  '93.13': ['gym','health'],
  '47.24': ['bakery','food','store']
};
const TYPES_FORTS = ['car_dealer','car_repair','car_rental','car_wash','restaurant','meal_takeaway','meal_delivery','bakery','bar','cafe','night_club','pharmacy','hair_care','beauty_salon','spa','lodging','real_estate_agency','gym','clothing_store','jewelry_store','veterinary_care','funeral_home'];

function normaliser(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function echapper(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, ''); }

// Nom en mots entiers + variante compacte ("A 2G" matche "A2G", "COI" ne matche pas "Coin")
function nomCorrespond(nomFiche, nomEntreprise) {
  if (!nomEntreprise) return false;
  const fiche = normaliser(nomFiche);
  const tokens = normaliser(nomEntreprise).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  const trouves = tokens.filter(t => new RegExp('\\b' + echapper(t) + '\\b').test(fiche));
  if (trouves.some(t => t.length >= 5)) return true;
  if (tokens.length && trouves.length >= Math.ceil(tokens.length / 2)) return true;
  // Variante compacte : "a 2g" → /\ba\s*2\s*g\b/ matche "A2G" et "A 2G"
  const compact = normaliser(nomEntreprise).replace(/[^a-z0-9]/g, '');
  if (compact.length >= 3 && compact.length <= 10) {
    const rx = new RegExp('\\b' + compact.split('').map(echapper).join('\\s*') + '\\b');
    if (rx.test(fiche)) return true;
  }
  return false;
}

// Adresse : 'exacte' = numéro de rue identique + mot de rue → fiable seul.
// 'zone' = même zone/CP → INSUFFISANT seul (à Jarry, tous les concurrents sont voisins).
function adresseCorrespond(adresseFiche, adressePappers, codePostal) {
  const fiche = normaliser(adresseFiche);
  if (codePostal && !fiche.includes(codePostal)) return false;
  const numero = (adressePappers || '').match(/^\s*(\d{1,5})\b/);
  const tokens = normaliser(adressePappers).split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4 && !['rue','avenue','boulevard','route','chemin','impasse','place','allee','zone','lieu','dit'].includes(t));
  const tokenOk = tokens.some(t => fiche.includes(t));
  if (numero && new RegExp('\\b' + numero[1] + '\\b').test(fiche) && tokenOk) return 'exacte';
  if (tokenOk) return 'zone';
  return false;
}

function domaine(url) {
  try { return new URL(/^https?:/.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function typeCoherent(typesFiche, naf) {
  const attendus = TYPES_ATTENDUS[(naf || '').slice(0, 5)];
  if (!attendus) return true;
  const types = typesFiche || [];
  if (types.some(t => attendus.includes(t))) return true;
  const forts = types.filter(t => TYPES_FORTS.includes(t));
  return forts.length === 0;
}

async function gPlaces(url) {
  const r = await fetch(url);
  return r.json().catch(() => ({}));
}

async function textSearch(q, key) {
  const data = await gPlaces(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=fr&region=fr&key=${key}`);
  if (['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'INVALID_REQUEST'].includes(data.status || '')) {
    throw Object.assign(new Error('Google Places : ' + data.status), { google: data.error_message || '' });
  }
  return data.results || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante dans Vercel' });

  const { nom = '', enseigne = '', ville = '', naf = '', adresse = '', cp = '', site = '' } = req.query;
  if (!nom) return res.status(400).json({ erreur: "Paramètre 'nom' requis" });

  const prefixeNaf = (naf || '').slice(0, 5);
  const motCle = MOTS_CLES_CONCURRENTS[prefixeNaf] || null;

  try {
    // ── 1. Pool de candidats : recherches nom/enseigne + recherche par catégorie locale ──
    const requetes = [];
    if (enseigne) requetes.push(`${enseigne} ${ville}`.trim());
    requetes.push(`${nom} ${ville}`.trim());
    if (motCle && ville) requetes.push(`${motCle} ${ville}`); // sert aussi pour les concurrents

    const vus = new Set();
    const candidats = [];
    let resultatsCategorie = [];
    for (const q of requetes) {
      const results = await textSearch(q, key);
      if (motCle && q === `${motCle} ${ville}`) resultatsCategorie = results;
      for (const r of results) {
        if (vus.has(r.place_id)) continue;
        vus.add(r.place_id);
        candidats.push(r);
      }
    }

    // ── 2. Scoring multi-signaux (avec garde-fou géographique) ──
    const villeNorm = normaliser(ville);
    const valides = candidats
      .filter(r => typeof r.rating === 'number' && r.user_ratings_total > 0)
      .filter(r => typeCoherent(r.types, naf))
      .filter(r => { // la fiche doit être dans la ville ou le code postal de l'entreprise
        if (!villeNorm && !cp) return true;
        const fa = normaliser(r.formatted_address || '');
        return (villeNorm && fa.includes(villeNorm)) || (cp && fa.includes(cp));
      })
      .map(r => {
        const matchNom = nomCorrespond(r.name, enseigne) || nomCorrespond(r.name, nom);
        const matchAdresse = adresse || cp ? adresseCorrespond(r.formatted_address || '', adresse, cp) : false;
        return { r, matchNom, matchAdresse };
      });

    // Acceptés d'office : nom OU adresse exacte (numéro de rue identique)
    let retenus = valides.filter(c => c.matchNom || c.matchAdresse === 'exacte');

    // Candidats "même zone" sans nom : confirmation par le DOMAINE du site web (max 3 vérifications)
    if (site) {
      const domaineSofy = domaine(site);
      const aVerifier = valides.filter(c => !c.matchNom && c.matchAdresse === 'zone')
        .sort((a, b) => b.r.user_ratings_total - a.r.user_ratings_total).slice(0, 3);
      for (const c of aVerifier) {
        if (!domaineSofy) break;
        const d = await gPlaces(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${c.r.place_id}&fields=website&language=fr&key=${key}`);
        const w = domaine(d.result?.website || '');
        if (w && w === domaineSofy) { c.matchSite = true; retenus.push(c); }
      }
    }

    retenus.sort((a, b) => ((b.matchNom?2:0)+(b.matchAdresse==='exacte'?2:0)+(b.matchSite?2:0)) - ((a.matchNom?2:0)+(a.matchAdresse==='exacte'?2:0)+(a.matchSite?2:0)) || b.r.user_ratings_total - a.r.user_ratings_total);

    const fiches = retenus.slice(0, 5).map(c => ({
      nom: c.r.name,
      note: c.r.rating,
      nb_avis: c.r.user_ratings_total,
      adresse: c.r.formatted_address || '',
      place_id: c.r.place_id,
      match: [c.matchNom?'nom':null, c.matchAdresse==='exacte'?'adresse exacte':null, c.matchSite?'site web':null].filter(Boolean).join(' + ') || 'zone',
      lien: `https://www.google.com/maps/place/?q=place_id:${c.r.place_id}`
    }));

    if (!fiches.length) {
      return res.status(200).json({ trouve: false, message: 'Aucune fiche Google trouvée pour cette entreprise' });
    }

    const totalAvis = fiches.reduce((s, f) => s + f.nb_avis, 0);
    const noteMoyenne = Math.round((fiches.reduce((s, f) => s + f.note * f.nb_avis, 0) / totalAvis) * 10) / 10;
    const significatives = fiches.filter(f => f.nb_avis >= 3);
    const pire = (significatives.length ? significatives : fiches).reduce((a, b) => (a.note <= b.note ? a : b));

    // ── 3. Avis négatif récent sur la pire fiche ──
    let avisNegatif = null;
    const det = await gPlaces(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pire.place_id}&fields=reviews&language=fr&key=${key}`);
    const reviews = det.result?.reviews || [];
    const negatifs = reviews.filter(r => r.rating <= 3 && (r.text || '').length > 20).sort((a, b) => (b.time || 0) - (a.time || 0));
    if (negatifs.length) {
      const a = negatifs[0];
      avisNegatif = {
        texte: a.text.length > 220 ? a.text.slice(0, 220) + '…' : a.text,
        note: a.rating,
        date: a.relative_time_description || ''
      };
    }

    // ── 4. Moyenne des concurrents (réutilise la recherche catégorie déjà faite) ──
    let concurrents = null;
    const idsEntreprise = new Set(fiches.map(f => f.place_id));
    const autres = resultatsCategorie
      .filter(r => typeof r.rating === 'number' && r.user_ratings_total >= 5)
      .filter(r => !idsEntreprise.has(r.place_id))
      .slice(0, 10);
    if (autres.length >= 3) {
      concurrents = {
        note_moyenne: Math.round((autres.reduce((s, r) => s + r.rating, 0) / autres.length) * 10) / 10,
        nb_analyses: autres.length,
        secteur: motCle,
        zone: ville
      };
    }

    return res.status(200).json({
      trouve: true,
      note_moyenne: noteMoyenne,
      total_avis: totalAvis,
      nb_fiches: fiches.length,
      fiches,
      pire_fiche: pire,
      avis_negatif: avisNegatif,
      concurrents
    });
  } catch (err) {
    if (err.google !== undefined) {
      return res.status(502).json({ erreur: err.message, detail: err.google || 'Vérifier que "Places API" (classique) est activée + facturation active' });
    }
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
