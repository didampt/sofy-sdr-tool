// /api/estimer.js — Estimation AVANT génération d'une liste.
// GET avec les mêmes paramètres que /api/liste (naf, dep, effectif_min/max, ca_min/max, nb_etab_min)
// → renvoie : nb de fiches Pappers (comptage sans rapatrier), fourchette de coût d'enrichissement,
//   et solde du SDR (plafond mensuel − consommation du mois).
// Coût de l'appel : ~1 crédit Pappers (recherche par_page=1, sans détail).

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

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const apiKey = process.env.PAPPERS_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'PAPPERS_API_KEY manquante' });

  try {
    const {
      naf = '', dep = '',
      effectif_min = '', effectif_max = '',
      ca_min = '', ca_max = '',
      nb_souhaite = '25'
    } = req.query;

    // ── 1. Comptage Pappers (par_page=1 : on ne rapatrie qu'une fiche, on lit "total") ──
    const p = new URLSearchParams();
    p.set('api_token', apiKey);
    p.set('par_page', '1');
    if (naf) p.set('code_naf', naf);
    if (dep) p.set('departement', dep);
    if (effectif_min) p.set('effectif_min', effectif_min);
    if (effectif_max) p.set('effectif_max', effectif_max);
    if (ca_min) p.set('chiffre_affaires_min', ca_min);
    if (ca_max) p.set('chiffre_affaires_max', ca_max);
    p.set('entreprise_cessee', 'false');

    const r = await fetch('https://api.pappers.fr/v2/recherche?' + p.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ erreur: 'Erreur Pappers', detail: data });

    const totalDispo = data.total || 0;
    // Nombre réellement généré = min(souhaité, dispo, plafond 500)
    const nbSouhaite = Math.min(parseInt(nb_souhaite) || 25, 500);
    const nbGenere = Math.min(nbSouhaite, totalDispo);

    // ── 2. Fourchette de coût d'enrichissement ──
    const tarifs = await sql`SELECT api, prix FROM tarifs`;
    const { min, max } = fourchetteParFiche(tarifs);
    const coutMin = Math.round(nbGenere * min * 100) / 100;
    const coutMax = Math.round(nbGenere * max * 100) / 100;

    // ── 3. Solde du SDR (plafond − conso du mois) ──
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
      nb_genere: nbGenere,
      cout_min: coutMin,
      cout_max: coutMax,
      plafond,            // null = illimité
      conso_mois: consoMois,
      solde,              // null = illimité
      assez,              // false → il faut une allocation
      manque: assez ? 0 : Math.round((coutMax - solde) * 100) / 100
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur estimation', detail: String(e.message || e).slice(0, 200) });
  }
}
