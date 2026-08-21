// /api/fiche-audit.js — 🔍 Audit d'une fiche Google : photos, complétude, position locale.
//
// Ce que l'API Google Places ne donne PAS et que SerpApi permet de mesurer :
//   · le NOMBRE de photos de la fiche, et qui les a publiées (l'enseigne ou ses clients) ;
//   · la complétude réelle : description, horaires, attributs, catégories secondaires ;
//   · la POSITION dans le pack local pour un mot-clé et une zone — c'est l'« Analyse marché »
//     de Soview, mesurée depuis l'extérieur au lieu d'être affirmée.
//
// POST { place_id, nom?, requete?, ll? }
//   requete = le mot-clé que taperait un client (« nettoyage bureaux Rennes »)
//   ll      = @latitude,longitude,14z — sans lui, la position locale n'est pas demandée
//
// Coût : 1 appel pour la fiche, 1 pour la position locale. Environ 0,01 $ chacun.
// SERPAPI_KEY requise (Vercel › Environment Variables).

import { verifierToken, sql } from './db.js';
import { appelSerpApi } from './serpapi.js';

export const config = { maxDuration: 60 };
const CACHE_JOURS = 30;

let pret = false;
async function ensureAudit() {
  if (pret || !sql) return;
  await sql`CREATE TABLE IF NOT EXISTS fiche_audit (
    place_id TEXT PRIMARY KEY,
    nom TEXT,
    photos_total INTEGER,
    photos_enseigne INTEGER,
    description_presente BOOLEAN,
    horaires_presents BOOLEAN,
    nb_categories INTEGER,
    nb_attributs INTEGER,
    position_locale INTEGER,
    requete TEXT,
    categorie TEXT,
    ville TEXT,
    lat NUMERIC,
    lng NUMERIC,
    whatsapp_sur_fiche TEXT,
    whatsapp_champ TEXT,
    concurrents JSONB,
    mesure_le TIMESTAMPTZ DEFAULT NOW(),
    mesure_par TEXT
  )`;
  // Fiches auditées avant le 20/08 : colonnes ajoutées à la volée (jamais de bump SCHEMA_VERSION).
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS categorie TEXT`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS ville TEXT`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS lat NUMERIC`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS lng NUMERIC`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS whatsapp_sur_fiche TEXT`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS whatsapp_champ TEXT`; } catch (_) {}
  // 21/08 : seconde source pour le site et le téléphone affichés par Google. L'API Places peut
  // rendre un `website` vide sur une fiche qui en porte un (constat sur SOFY France) — une seule
  // source ne peut pas suffire à affirmer une absence dans un document client.
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS site_declare TEXT`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS telephone_declare TEXT`; } catch (_) {}
  // ⚠️ MARQUEUR DE RÉVISION — sans lui, une correction de code n'atteint aucune fiche déjà auditée.
  // Le cache dure 30 jours et la ligne est rendue telle quelle. Les lignes écrites avant le 21/08
  // portent deux valeurs qu'on sait maintenant fausses : photos_enseigne = 0 (le filtre cherchait
  // des champs que SerpApi ne rend pas → 0 sur TOUTES les fiches) et description_presente = false
  // (le champ absent était lu comme une absence). Ces deux-là sont neutralisées à la lecture.
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS revision INTEGER`; } catch (_) {}
  pret = true;
}

// ── WhatsApp sur la fiche Google ────────────────────────────────────────────────────────────────
// ⚠️ J'ai d'abord écrit que Google n'avait pas de bouton WhatsApp. C'est FAUX : Didier l'a
// démontré capture en main (fiche « SOFY France » — une ligne WhatsApp figure dans l'aperçu, à
// côté du téléphone et du site). Google permet bien de rattacher un numéro WhatsApp à une fiche.
//
// Restait à savoir dans quel champ SerpApi le range. Plutôt que de le deviner une seconde fois, on
// PARCOURT la fiche et on note où on l'a trouvé : le champ exact part dans la réponse (whatsapp_champ),
// ce qui rend la détection vérifiable au lieu d'être supposée.
//
// On exclut volontairement les avis, les photos et les descriptions : un client qui ÉCRIT
// « contactez-les sur WhatsApp » dans un avis ne prouve pas que le bouton existe.
const EXCLUS_WA = new Set(['user_reviews', 'reviews', 'images', 'photos', 'description', 'snippet',
  'about', 'editorial_summary', 'people_also_search_for', 'similar_places_nearby']);
const MOTIF_WA = /wa\.me\/|api\.whatsapp\.com|chat\.whatsapp\.com|(^|[^a-z])whatsapp([^a-z]|$)/i;
function whatsappDe(fiche, chemin, prof) {
  // Profondeur 5 : les options de contact de Google arrivent parfois imbriquées
  // (extensions → [0] → contact_options → ['WhatsApp']), soit quatre niveaux.
  if (prof > 5 || fiche == null) return null;
  if (typeof fiche === 'string') {
    return MOTIF_WA.test(fiche) ? { valeur: fiche.slice(0, 200), champ: chemin || '(racine)' } : null;
  }
  if (typeof fiche === 'number') return null;
  if (Array.isArray(fiche)) {
    for (let k = 0; k < Math.min(fiche.length, 12); k++) {
      const t = whatsappDe(fiche[k], (chemin || '') + '[' + k + ']', prof + 1);
      if (t) return t;
    }
    return null;
  }
  if (typeof fiche === 'object') {
    for (const [c, v] of Object.entries(fiche)) {
      if (EXCLUS_WA.has(c)) continue;
      // Un champ NOMMÉ whatsapp est une preuve à lui seul : sa valeur peut n'être qu'un numéro,
      // sans le mot « whatsapp » dedans (cas d'un champ dédié côté API).
      if (MOTIF_WA.test(c) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) {
        return { valeur: String(v).slice(0, 200), champ: chemin ? chemin + '.' + c : c };
      }
      const t = whatsappDe(v, chemin ? chemin + '.' + c : c, prof + 1);
      if (t) return t;
    }
  }
  return null;
}

// La ville, extraite d'une adresse française : on repère le code postal et on prend ce qui suit.
// « 12 Rue de Rivoli, 75001 Paris, France » → « Paris ».
function villeDe(adresse) {
  const a = String(adresse || '');
  const m = a.match(/\b\d{5}\b[\s,]*([^,]{2,40})/);
  if (m) return m[1].trim();
  const bouts = a.split(',').map(x => x.trim()).filter(Boolean);
  // Sans code postal : l'avant-dernier morceau est presque toujours la ville (le dernier = pays).
  return bouts.length >= 2 ? bouts[bouts.length - 2].replace(/\b\d{5}\b/, '').trim() : null;
}

export default async function handler(req, res) {
  let erreurCache = null;   // échec d'écriture du cache : coûte un relevé de plus au prochain appel
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureAudit();

  const cle = process.env.SERPAPI_KEY;
  if (!cle) return res.status(500).json({ erreur: 'SERPAPI_KEY absente', detail: 'À créer dans Vercel, puis redéployer.' });

  const b = req.body || {};
  let placeId = String(b.place_id || '').trim();
  // Un lien Maps collé à la place d'un place_id : on essaie d'en extraire l'identifiant plutôt
  // que de partir en erreur.
  const dansUrl = placeId.match(/place_id[:=]([A-Za-z0-9_-]{20,})/);
  if (dansUrl) placeId = dansUrl[1];
  if (!placeId) return res.status(400).json({ erreur: 'place_id requis' });
  // ⚠️ VALIDATION AVANT L'APPEL. Un identifiant mal formé partait quand même chez SerpApi :
  // le relevé était facturé sur les 230 du mois, puis on répondait « Fiche introuvable » (502).
  // Cas réel du 21/08 : « 4Pp9ndnj4CS5gubM7 », qui est l'identifiant d'un lien court
  // maps.app.goo.gl — pas un place_id (ceux-ci font 20 caractères et plus, souvent en ChIJ…).
  if (!/^[A-Za-z0-9_-]{20,}$/.test(placeId)) {
    return res.status(400).json({
      erreur: 'Ce n\'est pas un place_id Google',
      detail: /^https?:\/\//i.test(placeId)
        ? `C'est une URL, et elle ne contient pas « place_id:… ». Les liens courts maps.app.goo.gl ne portent `
          + `pas le place_id : il faut d'abord les ouvrir dans Google Maps pour obtenir l'adresse complète.`
        : `« ${placeId.slice(0, 40)} » fait ${placeId.length} caractère(s). Un place_id en fait au moins 20 `
          + `(souvent « ChIJ… »). L'identifiant d'un lien court maps.app.goo.gl n'en est pas un.`,
      ou_le_trouver: 'Sur la fiche Sofy Scrap : ⭐ Fiches Google matchées → le lien de chaque fiche contient « ?q=place_id:… ». '
        + 'Sinon, rattache la fiche avec « ➕ Ajouter une fiche par son lien Maps » : cette action résout le lien et enregistre le place_id.',
      aucun_releve_consomme: true
    });
  }

  if (!b.forcer) {
    try {
      const [c] = await sql`SELECT * FROM fiche_audit WHERE place_id = ${placeId}
        AND mesure_le > NOW() - (${CACHE_JOURS} || ' days')::interval`;
      if (c) {
        // Une ligne d'avant la révision 2 ne peut pas être servie telle quelle : ses deux champs
        // non fiables redeviennent « inconnu », ce qui les empêche de produire une affirmation
        // fausse. On ne repaie pas le relevé pour autant — le reste de la ligne est bon.
        const vieux = (c.revision || 0) < 2;
        if (vieux) { c.photos_enseigne = null; c.description_presente = null; c.revision_ancienne = true; }
        return res.status(200).json({ ok: true, cache: true, audit: c });
      }
    } catch (_) { }
  }

  let budget = null;
  const lire = async (params) => {
    const r = await appelSerpApi({ ...params, hl: 'fr' }, { qui: user.nom, motif: 'audit de fiche' });
    budget = r;
    return { ok: r.ok, status: r.status, d: r.d };
  };

  // ── 1. La fiche elle-même : photos, description, horaires, attributs ──
  let fiche = null;
  try {
    const rep = await lire({ engine: 'google_maps', type: 'place', place_id: placeId });
    if (rep.status === 429 && budget && budget.refuse) {
      return res.status(429).json({ erreur: budget.d.error, plafond_atteint: true, conso: budget.conso, plafond: budget.plafond });
    }
    fiche = rep.d && rep.d.place_results;
    if (!fiche) {
      return res.status(502).json({
        erreur: 'Fiche introuvable chez SerpApi',
        detail: String((rep.d && rep.d.error) || ('HTTP ' + rep.status)).slice(0, 200)
      });
    }
  } catch (e) {
    return res.status(502).json({ erreur: 'SerpApi injoignable', detail: String((e && e.message) || e).slice(0, 160) });
  }

  // ?champs=1 (superadmin) : les clés réellement rendues par SerpApi pour cette fiche, plus le
  // résultat de la recherche WhatsApp. À lancer une fois sur une fiche qui PORTE le bouton (par
  // exemple « SOFY France ») pour confirmer le champ, au lieu de le supposer.
  if (b.champs && ['admin', 'superadmin'].includes(user.role)) {
    const wa0 = whatsappDe(fiche, '', 0);
    // Le relevé de clés du 21/08 sur la fiche Sofy montre qu'il n'y a NI champ « links », NI champ
    // « whatsapp ». Restent trois conteneurs où Google range ce qu'il ne modélise pas :
    // extensions, service_options et surtout unsupported_extensions — c'est là que SerpApi dépose
    // ce qu'il ne sait pas nommer. On les rend en entier : une seule exécution doit trancher.
    return res.status(200).json({
      ok: true, diagnostic: true, place_id: placeId, nom: fiche.title || null,
      cles_racine: Object.keys(fiche).sort(),
      whatsapp_trouve: wa0 || null,
      // Les conteneurs candidats, en entier — c'est leur CONTENU qui tranche, pas leur présence.
      extensions: fiche.extensions || null,
      service_options: fiche.service_options || null,
      unsupported_extensions: fiche.unsupported_extensions || null,
      posts: Array.isArray(fiche.posts) ? fiche.posts.slice(0, 2) : (fiche.posts || null),
      liens: fiche.links || null,
      website: fiche.website || null,
      phone: fiche.phone || null,
      note: 'Aucune écriture, aucun cache. Si whatsapp_trouve est null ET que la fiche interrogée '
        + 'PORTE le bouton, alors SerpApi ne l\'expose pas : la détection par cette voie est impossible.'
    });
  }

  const photos = Array.isArray(fiche.images) ? fiche.images : [];
  // Une photo publiée par l'enseigne montre ce qu'elle veut montrer ; celles des clients, ce
  // qu'ils ont vu. Le déséquilibre serait un argument en soi — MAIS il faut pouvoir l'établir.
  //
  // ⚠️ CORRECTION DU 21/08. Ce filtre cherchait `p.source` / `p.author`, deux champs que SerpApi
  // ne rend PAS sur les images d'une fiche (elles portent `title` et `thumbnail`). Le compte
  // valait donc 0 sur TOUTES les fiches du monde, et l'audit affirmait « aucune photo publiée par
  // vous » à chaque fois — y compris sur la fiche SOFY France où la plupart sont les nôtres.
  // Une donnée qu'on ne sait pas lire doit valoir « inconnu », jamais « zéro ».
  const attribution = photos.some(p => p && (p.source || p.author || p.user || p.contributor));
  const parEnseigne = attribution
    ? photos.filter(p => /owner|business|propriétaire|propriétaire/i.test(String(p.source || p.author || p.user || p.contributor || ''))).length
    : null;
  const attributs = fiche.extensions ? Object.keys(fiche.extensions).length
    : (Array.isArray(fiche.service_options) ? fiche.service_options.length : 0);

  const audit = {
    place_id: placeId,
    // La révision voyage AVEC l'objet, pas seulement dans la base : le front doit pouvoir
    // distinguer un relevé fiable d'une copie périmée stockée sur la fiche depuis des semaines.
    revision: 2,
    nom: b.nom || fiche.title || null,
    photos_total: fiche.photos_count != null ? fiche.photos_count : photos.length,
    photos_enseigne: parEnseigne,
    // ⚠️ TRI-ÉTAT, pas un booléen. La description du propriétaire existe bel et bien sur la fiche
    // SOFY France (capture Didier 21/08) et SerpApi ne l'a pas rendue : le champ absent ne dit
    // donc pas « pas de description », il dit « cette voie ne l'expose pas ».
    // true = vue · null = non exposée par cette voie. Jamais false, qu'on ne peut pas prouver.
    description_presente: (fiche.description || fiche.snippet) ? true : null,
    // Le site et le téléphone tels que Google les affiche : SECONDE SOURCE indispensable.
    // L'audit annonçait « aucun site web déclaré » sur la fiche SOFY France, qui porte sofy.fr —
    // le champ de l'API Places était vide alors que Google l'affiche. Une seule source ne peut
    // pas suffire à affirmer une absence.
    site_declare: fiche.website || null,
    telephone_declare: fiche.phone || null,
    horaires_presents: !!(fiche.hours || fiche.operating_hours || fiche.open_state),
    nb_categories: Array.isArray(fiche.categories) ? fiche.categories.length : (fiche.type ? 1 : 0),
    nb_attributs: attributs,
    position_locale: null,
    requete: null,
    // La catégorie Google et la ville : c'est ce qui manquait le 20/08 sur Buffalo Wild Wings
    // (fiche venue de LinkedIn, sans activité ni ville) alors que Google, lui, les connaît.
    categorie: (Array.isArray(fiche.categories) && fiche.categories[0] && (fiche.categories[0].name || fiche.categories[0]))
      || fiche.type || (Array.isArray(fiche.types) ? fiche.types[0] : null) || null,
    ville: villeDe(fiche.address || fiche.formatted_address),
    // Les coordonnées de la fiche, telles que SerpApi les rend. On les garde : Apple Plans exige
    // un repère géographique, et les fiches analysées avant août 2026 n'en ont aucun côté GMB.
    lat: (fiche.gps_coordinates && fiche.gps_coordinates.latitude != null) ? fiche.gps_coordinates.latitude : null,
    lng: (fiche.gps_coordinates && fiche.gps_coordinates.longitude != null) ? fiche.gps_coordinates.longitude : null,
    // WhatsApp : cherché dans toute la fiche, avec le champ où il a été trouvé (cf. whatsappDe).
    whatsapp_sur_fiche: (waT => waT ? waT.valeur : null)(whatsappDe(fiche, '', 0)),
    whatsapp_champ: (waT => waT ? waT.champ : null)(whatsappDe(fiche, '', 0)),
    concurrents: null
  };
  if (audit.categorie) audit.categorie = String(audit.categorie).slice(0, 80);

  // ── 2. La position locale : ce que voit un client qui cherche le SERVICE, pas l'enseigne ──
  // Si le front n'a pas su deviner la requête (fiche sans activité ni ville), on la déduit ICI :
  // la fiche Google que nous venons de lire porte sa catégorie et son adresse. C'est la seule
  // place où l'information existe à coup sûr.
  // Même règle que côté front : sans CATÉGORIE, une ville seule ne fait pas une requête — elle
  // renvoie « 0 résultat » et fait croire que le prospect est absent (constat fiche Sofy, 21/08).
  const requete = String(b.requete || '').trim()
    || (audit.categorie ? [audit.categorie, audit.ville].filter(Boolean).join(' ').trim() : '');
  // Les fiches analysées avant août 2026 n'ont pas de coordonnées stockées : SerpApi vient de nous
  // rendre celles de la fiche, on s'en sert plutôt que de renoncer à la position locale.
  const gps = fiche.gps_coordinates || {};
  const ll = String(b.ll || '').trim()
    || ((gps.latitude != null && gps.longitude != null) ? `@${gps.latitude},${gps.longitude},13z` : '');
  // La requête retenue part TOUJOURS dans la réponse, même si la recherche locale échoue : le
  // front la réutilise pour l'aperçu IA plutôt que de renoncer faute de l'avoir devinée.
  audit.requete = requete || null;
  if (requete && ll) {
    try {
      const loc = await lire({ engine: 'google_maps', type: 'search', q: requete, ll });
      const liste = Array.isArray(loc.d.local_results) ? loc.d.local_results : [];
      const moi = liste.findIndex(x => x.place_id === placeId
        || (x.title && audit.nom && String(x.title).toLowerCase() === String(audit.nom).toLowerCase()));
      audit.position_locale = moi >= 0 ? (liste[moi].position || moi + 1) : null;
      // Les trois premiers : c'est à eux que le prospect se compare, pas à une moyenne.
      audit.concurrents = liste.slice(0, 3).map(x => ({
        nom: x.title, note: x.rating || null, avis: x.reviews || null, position: x.position || null
      }));
    } catch (_) { }
  }

  try {
    await sql`INSERT INTO fiche_audit (place_id, nom, photos_total, photos_enseigne,
        site_declare, telephone_declare,
        revision, description_presente, horaires_presents, nb_categories, nb_attributs,
        position_locale, requete, concurrents, categorie, ville, lat, lng, whatsapp_sur_fiche, whatsapp_champ, mesure_le, mesure_par)
      VALUES (${audit.place_id}, ${audit.nom}, ${audit.photos_total}, ${audit.photos_enseigne},
              ${audit.site_declare}, ${audit.telephone_declare},
              2, ${audit.description_presente}, ${audit.horaires_presents}, ${audit.nb_categories},
              ${audit.nb_attributs}, ${audit.position_locale}, ${audit.requete},
              ${JSON.stringify(audit.concurrents)}::jsonb, ${audit.categorie}, ${audit.ville},
              ${audit.lat}, ${audit.lng}, ${audit.whatsapp_sur_fiche}, ${audit.whatsapp_champ}, NOW(), ${user.nom})
      ON CONFLICT (place_id) DO UPDATE SET nom = EXCLUDED.nom, photos_total = EXCLUDED.photos_total,
        photos_enseigne = EXCLUDED.photos_enseigne, description_presente = EXCLUDED.description_presente,
        horaires_presents = EXCLUDED.horaires_presents, nb_categories = EXCLUDED.nb_categories,
        nb_attributs = EXCLUDED.nb_attributs, position_locale = EXCLUDED.position_locale,
        requete = EXCLUDED.requete, concurrents = EXCLUDED.concurrents,
        categorie = EXCLUDED.categorie, ville = EXCLUDED.ville,
        lat = EXCLUDED.lat, lng = EXCLUDED.lng, whatsapp_sur_fiche = EXCLUDED.whatsapp_sur_fiche,
        whatsapp_champ = EXCLUDED.whatsapp_champ,
        site_declare = EXCLUDED.site_declare, telephone_declare = EXCLUDED.telephone_declare,
        revision = EXCLUDED.revision,
        mesure_le = NOW(), mesure_par = EXCLUDED.mesure_par`;
  } catch (eCache) {
    // Un cache non écrit n'est pas anodin : la prochaine analyse REPAYERA ces appels, sur un
    // budget de 230 par mois. On le remonte au lieu de le taire.
    erreurCache = String((eCache && eCache.message) || eCache).slice(0, 180);
  }

  // Un « manque » n'est un manque que s'il a été CONSTATÉ. Les deux lignes retirées ici
  // (description, attribution des photos) affirmaient une absence à partir d'un champ que cette
  // voie n'expose pas : c'est ce qui a produit deux affirmations fausses sur la fiche SOFY France.
  const manques = [];
  if (audit.description_presente === false) manques.push('aucune description');
  if (!audit.horaires_presents) manques.push('aucun horaire');
  if ((audit.photos_total || 0) < 10) manques.push(`${audit.photos_total || 0} photo(s) seulement`);
  if (audit.photos_enseigne === 0 && (audit.photos_total || 0) > 0) manques.push('aucune photo publiée par l\'enseigne');

  return res.status(200).json({
    ok: true, cache: false, audit,
    cache_erreur: erreurCache,
    budget_serpapi: budget ? { conso: budget.conso, plafond: budget.plafond, alerte: budget.alerte } : null,
    resume: manques.length ? 'Fiche incomplète : ' + manques.join(', ') + '.' : 'Fiche complète sur les points mesurables.',
    position: audit.position_locale
      ? `${audit.position_locale}ᵉ sur « ${audit.requete} »`
      : (requete ? `absent des résultats locaux sur « ${requete} »` : null),
    cout_estime_usd: requete && ll ? 0.02 : 0.01
  });
}
