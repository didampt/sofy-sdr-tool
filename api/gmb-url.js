// /api/gmb-url.js — Rattacher la fiche Google Business EXACTE à partir d'un lien Google Maps collé.
// Méthode : on lit les coordonnées + le CID (identifiant unique) dans le lien, on cherche par
// COORDONNÉES (Nearby Search), puis on ne retient une fiche QUE si son CID == celui du lien.
// => jamais d'attache approchante. Renvoie un diagnostic clair en cas d'échec.
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
  const parts = (r.formatted_address || '').split(',').map(s => s.trim());
  return { adresse: parts.length ? parts[0] : '', ville, code_postal: cp };
}
const CHAMPS = 'name,formatted_address,formatted_phone_number,website,address_components,rating,user_ratings_total,reviews,business_status,url,geometry';

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

  const diag = [];
  try {
    // 1) Résoudre le lien court → URL complète
    let full = url;
    if (/(goo\.gl|maps\.app\.goo\.gl|g\.co)/i.test(url)) {
      try { const rr = await fetch(url, { redirect: 'follow' }); full = rr.url || url; } catch (e) { /* on continue avec l'URL telle quelle */ }
    }

    // 2) Coordonnées précises (!3d!4d sinon @lat,lng), nom, et CID (identifiant unique de la fiche)
    let m = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const lat = m ? m[1] : null, lng = m ? m[2] : null;
    let nom = '';
    const mn = full.match(/\/maps\/place\/([^/@]+)/);
    if (mn) { try { nom = decodeURIComponent(mn[1].replace(/\+/g, ' ')).trim(); } catch (_) { nom = mn[1].replace(/\+/g, ' ').trim(); } }
    const ft = full.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
    let cidDec = null; if (ft) { try { cidDec = BigInt(ft[2]).toString(); } catch (_) {} }

    // Lien vers une commune / zone (ex "Le Tampon 97430, La Réunion") → pas une fiche d'établissement
    const estZone = /\b\d{5}\b/.test(nom) || /,\s*(la r[ée]union|guadeloupe|martinique|guyane|mayotte|france)\s*$/i.test(nom);
    if (estZone) return res.status(422).json({ erreur: "Ce lien pointe vers une commune ou une zone (« " + nom + " »), pas vers une fiche d'établissement. Sur Google Maps, ouvre la fiche de l'entreprise (celle qui a des avis), puis « Partager » → copie CE lien." });

    const g2 = async (label, u) => { const d = await g(u); diag.push(label + ':' + (d.status || '?') + (d.error_message ? '(' + d.error_message + ')' : '')); return d; };
    const norm = x => (x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

    // 3) Rassembler des candidats place_id PAR COORDONNÉES (l'API texte rate les fiches maigres)
    const cands = [];
    const ajoute = arr => { for (const r of (arr || [])) if (r.place_id && !cands.includes(r.place_id)) cands.push(r.place_id); };
    if (lat && lng) {
      if (nom) ajoute((await g2('nearby_kw', `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&rankby=distance&keyword=${encodeURIComponent(nom)}&language=fr&key=${key}`)).results);
      ajoute((await g2('nearby_radius', `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=120&language=fr&key=${key}`)).results);
    }
    if (!cands.length && nom) {
      const fp = await g2('findplace', `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(nom)}&inputtype=textquery&fields=place_id&language=fr&key=${key}`);
      ajoute(fp.candidates);
      if (!cands.length) ajoute((await g2('textsearch', `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(nom)}&language=fr&key=${key}`)).results);
    }

    // 4) Détails + sélection EXACTE (CID prioritaire ; sinon, à défaut de CID, nom + distance < 120 m)
    const R = 6371000, rd = x => x * Math.PI / 180;
    const distM = (la, lo) => { if (!(lat && lng)) return 1e9; const a = Math.sin(rd(la - +lat) / 2) ** 2 + Math.cos(rd(+lat)) * Math.cos(rd(la)) * Math.sin(rd(lo - +lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
    let chosen = null, chosenId = null, repliNom = null, repliNomId = null;
    const cible = norm(nom);
    for (const pid of cands.slice(0, 6)) {
      const d = await g(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${pid}&fields=${CHAMPS}&language=fr&key=${key}`);
      const r = d.result; if (!r) continue;
      const cidM = (r.url || '').match(/[?&]cid=(\d+)/);
      if (cidDec && cidM && cidM[1] === cidDec) { chosen = r; chosenId = pid; diag.push('CID_EXACT:ok'); break; }
      // repli (seulement si le lien n'a PAS de CID) : nom identique ET très proche
      if (!cidDec && !repliNom) {
        const loc = r.geometry && r.geometry.location;
        const proche = loc && distM(loc.lat, loc.lng) <= 120;
        const n = norm(r.name);
        if (proche && cible && (n.includes(cible) || cible.includes(n))) { repliNom = r; repliNomId = pid; }
      }
    }
    if (!chosen && repliNom) { chosen = repliNom; chosenId = repliNomId; diag.push('repli_nom_distance:ok'); }

    if (!chosen) {
      await loggerConso(user, 'google_places', NB, req.query.liste_id);
      return res.status(404).json({
        erreur: "Fiche introuvable via l'API Google pour « " + (nom || '?') + " ». Cette fiche n'est probablement pas exposée par l'API Google (fiche maigre ou sans vitrine). Tu peux saisir le site et le téléphone à la main sur la fiche.",
        detail: diag.join(' · '), coords: (lat && lng) ? (lat + ',' + lng) : 'aucune', cid: cidDec || 'aucun', candidats: cands.length
      });
    }

    // 5) Construire la réponse (note/avis seulement s'ils existent réellement)
    const ad = parseAdresse(chosen);
    const note = (typeof chosen.rating === 'number') ? chosen.rating : null;
    const avis = chosen.user_ratings_total || 0;
    const fiche = { nom: chosen.name, note, nb_avis: avis, adresse: chosen.formatted_address || '', place_id: chosenId, match: 'lien Maps (CID vérifié)', lien: `https://www.google.com/maps/place/?q=place_id:${chosenId}` };
    let avisNeg = null;
    const negs = (chosen.reviews || []).filter(x => x.rating <= 3 && (x.text || '').length > 20).sort((a, b) => (b.time || 0) - (a.time || 0));
    if (negs.length) { const a = negs[0]; avisNeg = { texte: a.text.length > 220 ? a.text.slice(0, 220) + '…' : a.text, note: a.rating, date: a.relative_time_description || '', lien: `https://search.google.com/local/reviews?placeid=${chosenId}` }; }

    const gmb = { trouve: true, manuel: true, telephone: chosen.formatted_phone_number || null, site_web: chosen.website || null, note_moyenne: note, total_avis: avis, nb_fiches: 1, fiches: [fiche], pire_fiche: fiche, avis_negatif: avisNeg, concurrents: null };
    const prefill = { nom: chosen.name || '', adresse: ad.adresse, ville: ad.ville, code_postal: ad.code_postal, telephone: chosen.formatted_phone_number || '', site_web: chosen.website || '', place_id: chosenId };

    await loggerConso(user, 'google_places', NB, req.query.liste_id);
    return res.status(200).json({ ok: true, prefill, gmb, sans_note: note === null });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur Google', detail: (diag.join(' · ') + ' | ' + String(err.message || err)).slice(0, 300) });
  }
}
