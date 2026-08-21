// /api/apple-plans.js — 🍎 Le prospect existe-t-il sur Apple Plans ?
//
// POURQUOI CE FICHIER. Le discours Sofy sur le NAP dit depuis toujours que « Google, Apple Plans,
// Waze et les assistants IA croisent les mêmes informations ». Jusqu'ici, Apple Plans était une
// AFFIRMATION dans un deck. C'est désormais une mesure : SerpApi expose le moteur `apple_maps`,
// qui rend pour chaque établissement son nom, sa note, son nombre d'avis et sa position.
//
// L'argument devient opposable : sur un iPhone — la moitié du parc en France — un client qui
// cherche le métier du prospect ne le trouve pas, ou le trouve avec une fiche vide. Et une fiche
// Apple absente ne se répare pas en la « demandant à Google » : elle se réclame chez Apple.
//
// POST { requete, nom?, ll? }
//   requete = ce qu'un client taperait (« déménagement Le Lamentin »)
//   ll      = « latitude,longitude » ; sinon on passe la ville en `location`
//
// Un appel, environ 0,01 $. Cache 30 jours : une présence sur Apple Plans ne change pas d'un jour
// à l'autre. SERPAPI_KEY requise (Vercel › Environment Variables).

import { verifierToken, sql } from './db.js';
import { appelSerpApi } from './serpapi.js';

export const config = { maxDuration: 45 };
const CACHE_JOURS = 30;

let pret = false;
async function ensureApple() {
  if (pret || !sql) return;
  // Table PARESSEUSE (aucun bump de SCHEMA_VERSION — cf. incident « analyse » du 03/08)
  await sql`CREATE TABLE IF NOT EXISTS apple_plans (
    cle TEXT PRIMARY KEY,
    requete TEXT, nom TEXT,
    present BOOLEAN,
    position INTEGER,
    note NUMERIC,
    avis INTEGER,
    categorie TEXT,
    site_declare TEXT,
    telephone_declare TEXT,
    trois_premiers JSONB,
    total_resultats INTEGER,
    mesure_le TIMESTAMPTZ DEFAULT NOW(),
    mesure_par TEXT
  )`;
  pret = true;
}

// Rapprochement de nom : Apple écrit « AGS Déménagement » là où Pappers dit « A.G.S. MARTINIQUE ».
// On compare sur les lettres seules, et on accepte l'inclusion dans un sens ou dans l'autre.
const norm = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
function memeEnseigne(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Une inclusion ne vaut que si le morceau commun est assez long pour ne pas être un hasard.
  const court = x.length < y.length ? x : y, long = x.length < y.length ? y : x;
  return court.length >= 5 && long.includes(court);
}

export default async function handler(req, res) {
  let erreurCache = null;   // échec d'écriture du cache : coûte un relevé de plus au prochain appel
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureApple();

  const cle = process.env.SERPAPI_KEY;
  if (!cle) return res.status(500).json({ erreur: 'SERPAPI_KEY absente', detail: 'À créer dans Vercel, puis redéployer.' });

  const b = req.body || {};
  const requete = String(b.requete || '').trim();
  if (requete.length < 4) return res.status(400).json({ erreur: 'Donne la requête qu\'un client taperait (4 caractères minimum)' });
  const nom = String(b.nom || '').trim();
  const ll = String(b.ll || '').trim();          // « 14.61,-61.00 »
  const lieu = String(b.lieu || '').trim();      // repli : « Le Lamentin, Martinique »
  const cleCache = (requete + '|' + (nom || lieu || ll || '')).toLowerCase().slice(0, 200);

  if (!b.forcer) {
    try {
      const [c] = await sql`SELECT * FROM apple_plans WHERE cle = ${cleCache}
        AND mesure_le > NOW() - (${CACHE_JOURS} || ' days')::interval`;
      if (c) return res.status(200).json({ ok: true, cache: true, apple: c });
    } catch (_) { }
  }

  // ⚠️ `center` OU `location` est obligatoire, et les deux ne peuvent PAS partir ensemble.
  // Le 400 du 21/08 (« Missing query `center` or `location` parameter ») venait d'un paramètre
  // ENVOYÉ MAIS VIDE : URLSearchParams écrit « center= », que l'API compte pour absent. On
  // valide donc les coordonnées comme deux vrais nombres avant de les utiliser, et on ne met
  // dans la requête que ce qui a une valeur.
  const coord = (() => {
    const m = String(ll).replace(/^@/, '').split(',');
    if (m.length < 2) return null;
    const la = Number(m[0]), lo = Number(m[1]);
    if (!isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0)) return null;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return la + ',' + lo;
  })();
  if (!coord && !lieu) {
    return res.status(400).json({
      erreur: 'Apple Plans exige un repère géographique',
      detail: 'Ni coordonnées exploitables (ll = « latitude,longitude ») ni ville (lieu). Lance « 🔍 Audit de fiche » : '
        + 'il relève et conserve désormais les coordonnées de la fiche Google, qui servent ici.',
      recu: { ll: ll || null, lieu: lieu || null }
    });
  }

  let lieux = [], envoye = null, budget = null;
  // Deux tentatives au plus : les coordonnées d'abord (précises), la ville ensuite. Un « location »
  // qu'Apple ne reconnaît pas ne doit pas coûter la mesure quand on a des coordonnées, et
  // réciproquement.
  const tentatives = [];
  if (coord) tentatives.push({ center: coord });
  if (lieu) tentatives.push({ location: lieu });
  // Dernier recours : la requête locale finit par la ville (« déménagement Le Lamentin »). On en
  // extrait les deux derniers mots comme lieu nommé. Mieux vaut une tentative de plus qu'une
  // mesure perdue — et si Apple ne résout pas non plus celle-là, la réponse dira ce qu'on a tenté.
  const finRequete = requete.split(/\s+/).slice(-2).join(' ').trim();
  if (finRequete && finRequete.length >= 3 && !lieu) tentatives.push({ location: finRequete + ', France' });
  let derniereErreur = null;
  for (const geo of tentatives) {
    try {
      const r = await appelSerpApi({ engine: 'apple_maps', query: requete, ...geo }, { qui: user.nom, motif: 'Apple Plans' });
      budget = r;
      if (r.refuse) return res.status(429).json({ erreur: r.d.error, plafond_atteint: true, conso: r.conso, plafond: r.plafond });
      const d = r.d;
      if (!r.ok) {
        derniereErreur = { http: r.status, message: String((d && d.error) || 'HTTP ' + r.status).slice(0, 200), envoye: geo };
        continue;
      }
      lieux = Array.isArray(d.local_results) ? d.local_results
        : (Array.isArray(d.place_results) ? d.place_results : []);
      envoye = geo;
      break;
    } catch (e) {
      derniereErreur = { http: 0, message: String((e && e.message) || e).slice(0, 160), envoye: geo };
    }
  }
  if (!envoye) {
    // Le paramètre réellement transmis part dans la réponse : un 400 de plus doit être
    // diagnosticable du premier coup, sans nouvelle passe de devinettes.
    return res.status(502).json({
      erreur: 'SerpApi ' + ((derniereErreur && derniereErreur.http) || '?'),
      detail: (derniereErreur && derniereErreur.message) || 'aucune tentative aboutie',
      parametres_envoyes: tentatives.map(t => Object.keys(t)[0] + '=' + Object.values(t)[0]),
      recu: { ll: ll || null, lieu: lieu || null, coord_validee: coord || null },
      requete
    });
  }

  const moi = nom ? lieux.findIndex(x => memeEnseigne(x.title || x.name, nom)) : -1;
  const p0 = moi >= 0 ? lieux[moi] : null;
  const apple = {
    cle: cleCache, requete, nom: nom || null,
    present: !!p0,
    position: p0 ? (p0.position || moi + 1) : null,
    note: p0 && p0.rating != null ? p0.rating : null,
    avis: p0 && p0.reviews != null ? p0.reviews : null,
    categorie: p0 ? (p0.type || null) : null,
    site_declare: p0 ? (p0.website || null) : null,
    telephone_declare: p0 ? (p0.phone || null) : null,
    // Les trois premiers d'Apple : ce ne sont pas forcément ceux de Google, et cet écart est
    // en soi un argument (deux moteurs, deux podiums, un seul jeu de données à tenir à jour).
    trois_premiers: lieux.slice(0, 3).map(x => ({
      nom: x.title || x.name || null,
      note: x.rating != null ? x.rating : null,
      avis: x.reviews != null ? x.reviews : null
    })),
    total_resultats: lieux.length,
    repere: Object.keys(envoye)[0] + ' = ' + Object.values(envoye)[0]
  };

  try {
    await sql`INSERT INTO apple_plans (cle, requete, nom, present, position, note, avis, categorie,
        site_declare, telephone_declare, trois_premiers, total_resultats, mesure_le, mesure_par)
      VALUES (${apple.cle}, ${apple.requete}, ${apple.nom}, ${apple.present}, ${apple.position},
              ${apple.note}, ${apple.avis}, ${apple.categorie}, ${apple.site_declare},
              ${apple.telephone_declare}, ${JSON.stringify(apple.trois_premiers)}::jsonb,
              ${apple.total_resultats}, NOW(), ${user.nom})
      ON CONFLICT (cle) DO UPDATE SET present = EXCLUDED.present, position = EXCLUDED.position,
        note = EXCLUDED.note, avis = EXCLUDED.avis, categorie = EXCLUDED.categorie,
        site_declare = EXCLUDED.site_declare, telephone_declare = EXCLUDED.telephone_declare,
        trois_premiers = EXCLUDED.trois_premiers, total_resultats = EXCLUDED.total_resultats,
        mesure_le = NOW(), mesure_par = EXCLUDED.mesure_par`;
  } catch (eCache) {
    // Un cache non écrit n'est pas anodin : la prochaine analyse REPAYERA ces appels, sur un
    // budget de 230 par mois. On le remonte au lieu de le taire.
    erreurCache = String((eCache && eCache.message) || eCache).slice(0, 180);
  }

  return res.status(200).json({
    ok: true, cache: false, apple,
    cache_erreur: erreurCache,
    resume: !lieux.length
      ? `Apple Plans ne rend aucun résultat sur « ${requete} » — requête trop étroite ou zone mal cadrée.`
      : (apple.present
        ? `Présent sur Apple Plans en ${apple.position}ᵉ position${apple.note != null ? `, ${String(apple.note).replace('.', ',')}★` : ', sans note'}${apple.avis != null ? ` (${apple.avis} avis)` : ''}.`
        : `ABSENT des ${lieux.length} résultats Apple Plans sur « ${requete} » — sur iPhone, ce client ne le trouve pas.`),
    budget_serpapi: budget ? { conso: budget.conso, plafond: budget.plafond, alerte: budget.alerte } : null,
    cout_estime_usd: 0.01
  });
}
