// /api/serpapi.js — 🎚️ Le compteur et le garde-fou du budget SerpApi.
//
// POURQUOI CE FICHIER. L'abonnement autorise un nombre fini d'appels par mois (230 à l'origine,
// **1000 depuis le passage au plan Starter le 31/08/2026**), et jusqu'ici rien ne les
// comptait. Au-delà du plafond, chaque relevé aurait échoué un par un et les analyses se seraient
// dégradées en silence — exactement la classe de panne qu'on a passé trois jours à éliminer sur
// cette brique. Un plafond sans compteur n'est pas un plafond, c'est une surprise.
//
// Tous les appels SerpApi de l'application passent par appelSerpApi() : c'est le seul endroit qui
// parle à serpapi.com. Un appel ajouté ailleurs échapperait au compteur — ne pas le faire.
//
// GET  /api/serpapi?etat=1   → consommation du mois, par motif et par personne
// GET  /api/serpapi?mois=6   → les 6 derniers mois (défaut 3)

import { verifierToken, sql } from './db.js';

export const config = { maxDuration: 20 };

// Le plafond réel de l'abonnement. Réglable sans redéploiement si l'offre change.
// 1000 = plan Starter pris le 31/08/2026 (230 avant). ⚠️ Si la variable Vercel
// SERPAPI_PLAFOND_MOIS existe encore à 230, c'est ELLE qui gagne — la mettre à jour ou la retirer.
export const PLAFOND = () => parseInt(process.env.SERPAPI_PLAFOND_MOIS || '1000', 10);
// Seuil d'avertissement : à partir d'ici, chaque réponse porte une alerte que le front affiche.
const SEUIL_ALERTE = 0.8;

let pret = false;
async function ensureConso() {
  if (pret || !sql) return;
  // Table PARESSEUSE (aucun bump de SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS serpapi_conso (
    id SERIAL PRIMARY KEY,
    mois TEXT NOT NULL,
    moteur TEXT,
    motif TEXT,
    qui TEXT,
    depuis_cache BOOLEAN DEFAULT FALSE,
    ok BOOLEAN,
    ts TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_serpapi_mois ON serpapi_conso(mois)`;
  pret = true;
}

// Le mois de facturation, en heure de Paris : à 1 h du matin le 1er, on est encore le mois
// précédent côté UTC, et le compteur se serait remis à zéro un jour trop tôt.
export function moisCourant() {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
}

export async function consoDuMois(mois) {
  await ensureConso();
  const m = mois || moisCourant();
  try {
    // Pas de filtre sur depuis_cache : appelSerpApi() n'est jamais invoqué pour une lecture de
    // cache — chaque ligne de cette table EST un appel réseau facturé. La colonne reste pour
    // compatibilité mais ne filtre rien (relevé à la relecture du 21/08).
    const [r] = await sql`SELECT COUNT(*)::int AS n FROM serpapi_conso
      WHERE mois = ${m} AND ok IS NOT FALSE`;
    return (r && r.n) || 0;
  } catch (_) { return 0; }
}

/**
 * L'unique porte vers SerpApi.
 *   params : les paramètres de la requête, api_key exclue (ajoutée ici)
 *   motif  : à quoi sert l'appel (« position locale », « aperçu IA »…) — sert au suivi
 * Renvoie { ok, status, d, refuse, conso, plafond, alerte }
 *   refuse = true  → le plafond mensuel est atteint, AUCUN appel n'a été passé
 */
export async function appelSerpApi(params, { qui, motif } = {}) {
  const cle = process.env.SERPAPI_KEY;
  if (!cle) return { ok: false, status: 0, d: { error: 'SERPAPI_KEY absente' }, sansCle: true };
  await ensureConso();
  const mois = moisCourant(), plafond = PLAFOND();
  const conso = await consoDuMois(mois);

  // Refus PROPRE plutôt que dégradation silencieuse : l'appelant remonte le message tel quel.
  if (conso >= plafond) {
    return {
      ok: false, status: 429, refuse: true, conso, plafond,
      d: {
        error: `Plafond SerpApi atteint : ${conso}/${plafond} relevés ce mois-ci. `
          + `Les mesures reprendront le 1er du mois prochain, ou dès que l'abonnement sera relevé. `
          + `Les analyses déjà mesurées restent utilisables (les relevés sont réutilisés 21 à 30 jours).`
      }
    };
  }

  const u = 'https://serpapi.com/search.json?' + new URLSearchParams({ ...params, api_key: cle }).toString();
  let ok = false, status = 0, d = {};
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    status = r.status;
    d = await r.json().catch(() => ({}));
    ok = r.ok && !(d && d.error);
  } catch (e) {
    d = { error: String((e && e.message) || e).slice(0, 200) };
  }

  // On journalise TOUS les appels, réussis ou non : un quota se consomme même sur une erreur de
  // paramètre, et c'est précisément ce qu'on veut voir venir.
  // Si cette écriture échoue, le compteur SOUS-ESTIME la consommation : on dépasserait les 230
  // sans que rien ne s'allume. On ne bloque pas l'appel pour autant — il est déjà parti et payé —
  // mais on marque le compteur comme non fiable, et l'écran du budget le dira.
  let compteurFiable = true;
  try {
    await sql`INSERT INTO serpapi_conso (mois, moteur, motif, qui, ok)
      VALUES (${mois}, ${String(params.engine || '?').slice(0, 40)}, ${String(motif || '').slice(0, 60)},
              ${String(qui || 'système').slice(0, 60)}, ${ok})`;
  } catch (e) {
    compteurFiable = false;
    console.error('[SerpApi conso NON journalisée]', params.engine, motif, String((e && e.message) || e).slice(0, 160));
  }

  const n = conso + 1;
  return {
    ok, status, d, conso: n, plafond, compteur_fiable: compteurFiable,
    alerte: !compteurFiable
      ? `⚠️ Le compteur SerpApi n'a pas pu enregistrer cet appel : la consommation affichée est SOUS-ESTIMÉE. Vérifie 🔧 Maintenance › Budget des relevés.`
      : n >= Math.floor(plafond * SEUIL_ALERTE)
      ? `Budget SerpApi : ${n}/${plafond} relevés ce mois-ci — il reste de quoi faire environ ${Math.max(0, Math.floor((plafond - n) / 7))} analyse(s).`
      : null
  };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureConso();
  const plafond = PLAFOND();

  const nbMois = Math.max(1, Math.min(12, parseInt((req.query || {}).mois, 10) || 3));
  try {
    const mois = moisCourant();
    const n = await consoDuMois(mois);
    // Le détail sert à trancher « qui consomme » sans accuser personne au hasard.
    const parMotif = await sql`SELECT motif, COUNT(*)::int AS n FROM serpapi_conso
      WHERE mois = ${mois} GROUP BY motif ORDER BY n DESC`;
    const parQui = await sql`SELECT qui, COUNT(*)::int AS n FROM serpapi_conso
      WHERE mois = ${mois} GROUP BY qui ORDER BY n DESC`;
    const echecs = await sql`SELECT COUNT(*)::int AS n FROM serpapi_conso
      WHERE mois = ${mois} AND ok = FALSE`;
    const histo = await sql`SELECT mois, COUNT(*)::int AS n FROM serpapi_conso
      GROUP BY mois ORDER BY mois DESC LIMIT ${nbMois}`;
    return res.status(200).json({
      ok: true, mois, appels: n, plafond,
      restants: Math.max(0, plafond - n),
      pct: Math.round((n / plafond) * 100),
      // 7 appels par analyse : la moyenne observée (2 avis + 2 fiche + 1,5 IA + 1,5 Apple).
      analyses_restantes: Math.max(0, Math.floor((plafond - n) / 7)),
      etat: n >= plafond ? 'plafond atteint' : (n >= plafond * SEUIL_ALERTE ? 'bientôt atteint' : 'ok'),
      echecs_du_mois: (echecs[0] && echecs[0].n) || 0,
      par_motif: parMotif, par_personne: parQui, historique: histo,
      note: 'Un relevé réutilisé depuis le cache ne consomme rien : régénérer une analyse dans le mois est gratuit.'
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Consommation illisible', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
