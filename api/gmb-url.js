// /api/gmb-url.js — Rattacher une fiche Google Business à partir d'un lien Google Maps collé manuellement.
// Résout le lien (même court maps.app.goo.gl), lit coordonnées + nom, retrouve la fiche via Google,
// renvoie le pré-remplissage (nom/adresse/ville/CP/tél/site) + l'objet GMB (note, avis, avis négatif) au format gmb.js.
import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

let NB = 0;
async function g(url) { NB++; const r = await fetch(url); return r.json().catch(() => ({})); }

function parseAdresse(r) {
  let ville = '', cp = '';
  for (const c of (r.address_components || [])) {
    if (c.types.includes('postal_code')) cp = c.long_name;
    if (c.types.includes('locality')) ville = c.long_name;
    if (!ville && c.types.includes('postal_town')) ville = c.long_name;
  }
  let adresse = '';
  const parts = (r.formatted_address || '').split(',').map(s => s.trim());
  if (parts.length) adresse = parts[0];
  return { adresse, ville, code_postal: cp };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  NB = 0;
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante dans Vercel' });

  const url = (req.query.url || '').trim();
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ erreur: 'Lien Google Maps manquant ou invalide' });

  try {
    // 1) Résoudre le lien court → URL complète
    let full = url;
    if (/(goo\.gl|maps\.app\.goo\.gl|g\.co)/i.test(url)) {
      try { const rr = await fetch(url, { redirect: 'follow' }); full = rr.url || url; } catch (e) { /* on tente avec l'URL telle quelle */ }
    }

    // 2) Extraire coordonnées précises (!3d!4d) sinon centre (@lat,lng) + nom de l'établissement
    let lat = null, lng = null;
    let m = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (!m) m = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) { lat = m[1]; lng = m[2]; }
    let nom = '';
    const mn = full.match(/\/maps\/place\/([^/@]+)/);
    if (mn) { try { nom = decodeURIComponent(mn[1].replace(/\+/g, ' ')).trim(); } catch (_) { nom = mn[1].replace(/\+/g, ' ').trim(); } }

    // 3) Retrouver le place_id (sans biais métropole : on s'appuie sur les coordonnées du lien)
    let placeId = null;
    const biais = (lat && lng) ? `&locationbias=point:${lat},${lng}` : '';
    if (nom) {
      const fp = await g(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(nom)}&inputtype=textquery&fields=place_id${biais}&language=fr&key=${key}`);
      if (fp.candidates && fp.candidates[0]) placeId = fp.candidates[0].place_id;
      if (!placeId) { // repli : textsearch autour des coordonnées
        const loc = (lat && lng) ? `&location=${lat},${lng}&radius=30000` : '';
        const ts = await g(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(nom)}${loc}&language=fr&key=${key}`);
        if (ts.results && ts.results[0]) placeId = ts.results[0].place_id;
      }
    }
    if (!placeId) return res.status(404).json({ erreur: "Impossible d'identifier l'établissement depuis ce lien. Ouvre la fiche dans Google Maps et copie le lien de partage de la fiche (pas une recherche)." });

    // 4) Détails de la fiche
    const champs = 'name,formatted_address,formatted_phone_number,website,address_components,rating,user_ratings_total,reviews,business_status';
    const d = await g(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${champs}&language=fr&key=${key}`);
    const r = d.result;
    if (!r) { await loggerConso(user, 'google_places', NB, req.query.liste_id); return res.status(404).json({ erreur: 'Fiche introuvable côté Google' }); }

    const ad = parseAdresse(r);
    const note = (typeof r.rating === 'number') ? r.rating : null;
    const avis = r.user_ratings_total || 0;
    const fiche = { nom: r.name, note, nb_avis: avis, adresse: r.formatted_address || '', place_id: placeId, match: 'lien manuel', lien: `https://www.google.com/maps/place/?q=place_id:${placeId}` };

    let avisNeg = null;
    const negs = (r.reviews || []).filter(x => x.rating <= 3 && (x.text || '').length > 20).sort((a, b) => (b.time || 0) - (a.time || 0));
    if (negs.length) { const a = negs[0]; avisNeg = { texte: a.text.length > 220 ? a.text.slice(0, 220) + '…' : a.text, note: a.rating, date: a.relative_time_description || '', lien: `https://search.google.com/local/reviews?placeid=${placeId}` }; }

    const gmb = {
      trouve: true, manuel: true,
      telephone: r.formatted_phone_number || null,
      site_web: r.website || null,
      note_moyenne: note, total_avis: avis, nb_fiches: 1,
      fiches: [fiche], pire_fiche: fiche, avis_negatif: avisNeg, concurrents: null
    };
    const prefill = {
      nom: r.name || '', adresse: ad.adresse, ville: ad.ville, code_postal: ad.code_postal,
      telephone: r.formatted_phone_number || '', site_web: r.website || '', place_id: placeId
    };

    await loggerConso(user, 'google_places', NB, req.query.liste_id);
    return res.status(200).json({ ok: true, prefill, gmb });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur Google', detail: String(err.message || err).slice(0, 200) });
  }
}
