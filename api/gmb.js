// /api/gmb.js — Analyse Google Business Profile d'une entreprise
// Retourne : note moyenne, nb d'avis, pire fiche, avis négatif récent, moyenne des concurrents locaux.
// Coût : 2 à 3 appels Google Places par analyse (Text Search + Details + Text Search concurrents).

const MOTS_CLES_CONCURRENTS = {
  '45.11': 'concessionnaire automobile',
  '45.20': 'garage automobile',
  '45.32': 'pièces automobiles',
  '45.40': 'concessionnaire moto',
  '96.02': 'salon de coiffure',
  '47.73': 'pharmacie',
  '56.10': 'restaurant',
  '56.30': 'bar',
  '55.10': 'hôtel',
  '68.31': 'agence immobilière',
  '93.13': 'salle de sport',
  '47.24': 'boulangerie',
  '77.11': 'location de voitures'
};

// Types Google Places attendus par famille NAF (validation de cohérence)
const TYPES_ATTENDUS = {
  '45.11': ['car_dealer', 'car_repair', 'car_rental', 'store'],
  '45.20': ['car_repair', 'car_dealer', 'car_wash'],
  '45.32': ['car_repair', 'store'],
  '45.40': ['car_dealer', 'car_repair', 'store'],
  '77.11': ['car_rental'],
  '96.02': ['hair_care', 'beauty_salon', 'spa'],
  '47.73': ['pharmacy', 'drugstore', 'health'],
  '56.10': ['restaurant', 'food', 'meal_takeaway'],
  '56.30': ['bar', 'night_club', 'cafe'],
  '55.10': ['lodging'],
  '68.31': ['real_estate_agency'],
  '93.13': ['gym', 'health'],
  '47.24': ['bakery', 'food', 'store']
};

function normaliser(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Le nom de l'entreprise (ou l'enseigne) doit apparaître en MOT ENTIER dans le nom de la fiche Google
function nomCorrespond(nomFiche, nomEntreprise) {
  const fiche = normaliser(nomFiche);
  const tokens = normaliser(nomEntreprise).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  if (!tokens.length) return false;
  const trouves = tokens.filter(t => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '') + '\\b').test(fiche));
  // Un mot distinctif (5 lettres et +) trouvé en mot entier suffit ; sinon, moitié des mots
  if (trouves.some(t => t.length >= 5)) return true;
  return trouves.length >= Math.ceil(tokens.length / 2);
}

// Types Google "forts" = catégories métier distinctives (vs types génériques comme establishment)
const TYPES_FORTS = ['car_dealer','car_repair','car_rental','car_wash','restaurant','meal_takeaway','meal_delivery','bakery','bar','cafe','night_club','pharmacy','hair_care','beauty_salon','spa','lodging','real_estate_agency','gym','clothing_store','jewelry_store','veterinary_care','funeral_home'];

// On ne rejette que les CONTRADICTIONS franches : la fiche a un type métier fort
// qui n'appartient PAS à la famille NAF attendue. Types génériques = on laisse passer.
function typeCoherent(typesFiche, naf) {
  const prefixe = (naf || '').slice(0, 5);
  const attendus = TYPES_ATTENDUS[prefixe];
  if (!attendus) return true; // famille NAF inconnue : pas de contrainte
  const types = typesFiche || [];
  if (types.some(t => attendus.includes(t))) return true;          // type attendu présent → OK
  const fortsPresents = types.filter(t => TYPES_FORTS.includes(t));
  if (!fortsPresents.length) return true;                          // que des types génériques → OK (le nom tranche)
  return false;                                                     // type métier fort d'une AUTRE famille → rejet
}

async function gPlaces(url) {
  const r = await fetch(url);
  return r.json().catch(() => ({}));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante dans Vercel' });

  const { nom = '', ville = '', naf = '' } = req.query;
  if (!nom) return res.status(400).json({ erreur: "Paramètre 'nom' requis" });

  const { enseigne = '' } = req.query;

  try {
    // ── 1. Fiches GMB : plusieurs tentatives (enseigne commerciale, puis raison sociale) ──
    const tentatives = [];
    if (enseigne) tentatives.push(`${enseigne} ${ville}`.trim());
    tentatives.push(`${nom} ${ville}`.trim());
    if (enseigne) tentatives.push(enseigne);
    tentatives.push(nom);

    let fiches = [], requeteUtilisee = '', statutGoogle = '';
    for (const t of tentatives) {
      const q = encodeURIComponent(t);
      const search = await gPlaces(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&language=fr&region=fr&key=${key}`);
      statutGoogle = search.status || '';
      // Erreur de configuration Google : on la remonte clairement
      if (['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'INVALID_REQUEST'].includes(statutGoogle)) {
        return res.status(502).json({ erreur: 'Erreur Google Places : ' + statutGoogle, detail: search.error_message || 'Vérifier que "Places API" (version classique) est bien activée dans Google Cloud Console + facturation active' });
      }
      const nomRef = t.startsWith(enseigne) && enseigne ? enseigne : nom;
      fiches = (search.results || [])
        .filter(r => typeof r.rating === 'number' && r.user_ratings_total > 0)
        .filter(r => typeCoherent(r.types, naf))
        .filter(r => nomCorrespond(r.name, nomRef) || nomCorrespond(r.name, enseigne || nom))
        .slice(0, 5)
        .map(r => ({
          nom: r.name,
          note: r.rating,
          nb_avis: r.user_ratings_total,
          adresse: r.formatted_address || '',
          place_id: r.place_id,
          lien: `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
        }));
      if (fiches.length) { requeteUtilisee = t; break; }
    }

    if (!fiches.length) {
      return res.status(200).json({ trouve: false, statut_google: statutGoogle, message: 'Aucune fiche Google trouvée pour cette entreprise' });
    }

    // Note moyenne pondérée par le nombre d'avis
    const totalAvis = fiches.reduce((s, f) => s + f.nb_avis, 0);
    const noteMoyenne = Math.round((fiches.reduce((s, f) => s + f.note * f.nb_avis, 0) / totalAvis) * 10) / 10;

    // Pire fiche (au moins 3 avis pour être significative)
    const significatives = fiches.filter(f => f.nb_avis >= 3);
    const pire = (significatives.length ? significatives : fiches).reduce((a, b) => (a.note <= b.note ? a : b));

    // ── 2. Avis négatif récent sur la pire fiche ──
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

    // ── 3. Moyenne des concurrents locaux ──
    let concurrents = null;
    const prefixeNaf = (naf || '').replace('Z', '').replace('A', '').replace('B', '').slice(0, 5);
    const motCle = MOTS_CLES_CONCURRENTS[prefixeNaf] || null;
    if (motCle && ville) {
      const qc = encodeURIComponent(`${motCle} ${ville}`);
      const sc = await gPlaces(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${qc}&language=fr&region=fr&key=${key}`);
      const autres = (sc.results || [])
        .filter(r => typeof r.rating === 'number' && r.user_ratings_total >= 5)
        .filter(r => !r.name.toLowerCase().includes(nom.toLowerCase().split(' ')[0]))
        .slice(0, 10);
      if (autres.length >= 3) {
        concurrents = {
          note_moyenne: Math.round((autres.reduce((s, r) => s + r.rating, 0) / autres.length) * 10) / 10,
          nb_analyses: autres.length,
          secteur: motCle,
          zone: ville
        };
      }
    }

    return res.status(200).json({
      trouve: true,
      requete_utilisee: requeteUtilisee,
      note_moyenne: noteMoyenne,
      total_avis: totalAvis,
      nb_fiches: fiches.length,
      fiches,
      pire_fiche: pire,
      avis_negatif: avisNegatif,
      concurrents
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
