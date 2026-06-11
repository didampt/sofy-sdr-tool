// /api/pappers.js — Recherche d'entreprises via l'API Pappers
// La clé API est lue depuis la variable d'environnement PAPPERS_API_KEY (jamais dans le code).

export default async function handler(req, res) {
  // Autoriser uniquement les appels depuis notre propre site
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.PAPPERS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erreur: "PAPPERS_API_KEY manquante dans les variables d'environnement Vercel" });
  }

  // ── Paramètres reçus du front ──
  const {
    naf = '',          // ex: "4511Z,4520A"
    dep = '',          // ex: "971,972" (971=Guadeloupe, 972=Martinique, 973=Guyane, 974=Réunion, 976=Mayotte)
    effectif_min = '',
    effectif_max = '',
    ca_min = '',
    ca_max = '',
    nb = '10'          // nombre de résultats (max 100)
  } = req.query;

  if (!naf) {
    return res.status(400).json({ erreur: "Paramètre 'naf' requis (ex: ?naf=4511Z)" });
  }

  // ── Construction de la requête Pappers ──
  const params = new URLSearchParams({
    api_token: apiKey,
    code_naf: naf,
    entreprise_cessee: 'false',
    par_page: Math.min(parseInt(nb) || 10, 100).toString(),
    precision: 'standard'
  });
  if (dep) params.set('departement', dep);
  if (effectif_min) params.set('effectif_min', effectif_min);
  if (effectif_max) params.set('effectif_max', effectif_max);
  if (ca_min) params.set('chiffre_affaires_min', ca_min);
  if (ca_max) params.set('chiffre_affaires_max', ca_max);

  try {
    const r = await fetch('https://api.pappers.fr/v2/recherche?' + params.toString());
    const data = await r.json();

    if (!r.ok) {
      // On renvoie l'erreur Pappers telle quelle pour pouvoir ajuster les paramètres si besoin
      return res.status(r.status).json({ erreur: 'Erreur Pappers', detail: data });
    }

    // ── Simplification de la réponse pour le front ──
    const entreprises = (data.resultats || []).map(e => ({
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
      total: data.total || entreprises.length,
      page: data.page || 1,
      entreprises
    });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
