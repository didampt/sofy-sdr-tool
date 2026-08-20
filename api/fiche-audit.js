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
    concurrents JSONB,
    mesure_le TIMESTAMPTZ DEFAULT NOW(),
    mesure_par TEXT
  )`;
  // Fiches auditées avant le 20/08 : colonnes ajoutées à la volée (jamais de bump SCHEMA_VERSION).
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS categorie TEXT`; } catch (_) {}
  try { await sql`ALTER TABLE fiche_audit ADD COLUMN IF NOT EXISTS ville TEXT`; } catch (_) {}
  pret = true;
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
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  await ensureAudit();

  const cle = process.env.SERPAPI_KEY;
  if (!cle) return res.status(500).json({ erreur: 'SERPAPI_KEY absente', detail: 'À créer dans Vercel, puis redéployer.' });

  const b = req.body || {};
  const placeId = String(b.place_id || '').trim();
  if (!placeId) return res.status(400).json({ erreur: 'place_id requis' });

  if (!b.forcer) {
    try {
      const [c] = await sql`SELECT * FROM fiche_audit WHERE place_id = ${placeId}
        AND mesure_le > NOW() - (${CACHE_JOURS} || ' days')::interval`;
      if (c) return res.status(200).json({ ok: true, cache: true, audit: c });
    } catch (_) { }
  }

  const lire = async (params) => {
    const u = 'https://serpapi.com/search.json?' + new URLSearchParams({ ...params, hl: 'fr', api_key: cle }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
    return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
  };

  // ── 1. La fiche elle-même : photos, description, horaires, attributs ──
  let fiche = null;
  try {
    const rep = await lire({ engine: 'google_maps', type: 'place', place_id: placeId });
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

  const photos = Array.isArray(fiche.images) ? fiche.images : [];
  // Une photo publiée par l'enseigne montre ce qu'elle veut montrer ; celles des clients, ce
  // qu'ils ont vu. Le déséquilibre est un argument en soi.
  const parEnseigne = photos.filter(p => /owner|business|propriétaire/i.test(String(p.source || p.author || ''))).length;
  const attributs = fiche.extensions ? Object.keys(fiche.extensions).length
    : (Array.isArray(fiche.service_options) ? fiche.service_options.length : 0);

  const audit = {
    place_id: placeId,
    nom: b.nom || fiche.title || null,
    photos_total: fiche.photos_count != null ? fiche.photos_count : photos.length,
    photos_enseigne: parEnseigne,
    description_presente: !!(fiche.description || fiche.snippet),
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
    concurrents: null
  };
  if (audit.categorie) audit.categorie = String(audit.categorie).slice(0, 80);

  // ── 2. La position locale : ce que voit un client qui cherche le SERVICE, pas l'enseigne ──
  // Si le front n'a pas su deviner la requête (fiche sans activité ni ville), on la déduit ICI :
  // la fiche Google que nous venons de lire porte sa catégorie et son adresse. C'est la seule
  // place où l'information existe à coup sûr.
  const requete = String(b.requete || '').trim()
    || [audit.categorie, audit.ville].filter(Boolean).join(' ').trim();
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
        description_presente, horaires_presents, nb_categories, nb_attributs,
        position_locale, requete, concurrents, categorie, ville, mesure_le, mesure_par)
      VALUES (${audit.place_id}, ${audit.nom}, ${audit.photos_total}, ${audit.photos_enseigne},
              ${audit.description_presente}, ${audit.horaires_presents}, ${audit.nb_categories},
              ${audit.nb_attributs}, ${audit.position_locale}, ${audit.requete},
              ${JSON.stringify(audit.concurrents)}::jsonb, ${audit.categorie}, ${audit.ville},
              NOW(), ${user.nom})
      ON CONFLICT (place_id) DO UPDATE SET nom = EXCLUDED.nom, photos_total = EXCLUDED.photos_total,
        photos_enseigne = EXCLUDED.photos_enseigne, description_presente = EXCLUDED.description_presente,
        horaires_presents = EXCLUDED.horaires_presents, nb_categories = EXCLUDED.nb_categories,
        nb_attributs = EXCLUDED.nb_attributs, position_locale = EXCLUDED.position_locale,
        requete = EXCLUDED.requete, concurrents = EXCLUDED.concurrents,
        categorie = EXCLUDED.categorie, ville = EXCLUDED.ville,
        mesure_le = NOW(), mesure_par = EXCLUDED.mesure_par`;
  } catch (_) { }

  const manques = [];
  if (!audit.description_presente) manques.push('aucune description');
  if (!audit.horaires_presents) manques.push('aucun horaire');
  if ((audit.photos_total || 0) < 10) manques.push(`${audit.photos_total || 0} photo(s) seulement`);
  if (audit.photos_enseigne === 0 && (audit.photos_total || 0) > 0) manques.push('aucune photo publiée par l\'enseigne');

  return res.status(200).json({
    ok: true, cache: false, audit,
    resume: manques.length ? 'Fiche incomplète : ' + manques.join(', ') + '.' : 'Fiche complète sur les points mesurables.',
    position: audit.position_locale
      ? `${audit.position_locale}ᵉ sur « ${audit.requete} »`
      : (requete ? `absent des résultats locaux sur « ${requete} »` : null),
    cout_estime_usd: requete && ll ? 0.02 : 0.01
  });
}
