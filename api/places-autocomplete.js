// /api/places-autocomplete.js — Recherche d'établissements Google (aide à la saisie d'une fiche).
// Clé Google protégée côté serveur (jamais exposée au front).
// GET ?q=texte           → liste d'établissements { place_id, nom, adresse }
// GET ?place_id=...       → détails pour pré-remplir { nom, adresse, ville, code_postal, telephone, site_web, place_id }
// GET ?ville=texte        → autocomplete de VILLES françaises { villes:[{nom, detail}] } (Liste Google Maps)

import { verifierToken } from './db.js';

async function gPlaces(url) {
  const r = await fetch(url);
  return r.json();
}

// Découpe une adresse Google "12 Rue des Lilas, 33000 Bordeaux, France" en {adresse, cp, ville}
function decouperAdresse(adr) {
  const out = { adresse: '', code_postal: '', ville: '' };
  if (!adr) return out;
  const parts = adr.split(',').map(s => s.trim());
  // Dernier morceau = pays (souvent "France") → on l'ignore s'il n'a pas de chiffres
  if (parts.length >= 2) {
    out.adresse = parts[0];
    // Cherche un morceau "33000 Bordeaux"
    for (const p of parts.slice(1)) {
      const m = p.match(/^(\d{4,5})\s+(.+)$/);
      if (m) { out.code_postal = m[1]; out.ville = m[2]; break; }
    }
    // Si pas trouvé, on prend le 2e morceau comme ville
    if (!out.ville && parts[1] && !/^\d/.test(parts[1])) out.ville = parts[1];
  } else {
    out.adresse = adr;
  }
  return out;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante' });

  try {
    const { q, place_id, ville } = req.query;

    // ── Mode villes : autocomplete France + DOM ──
    // Google classe les DOM sous leurs propres codes pays (GP/MQ/GF/RE/YT), pas sous FR,
    // et limite à 5 pays par requête -> 2 requêtes parallèles fusionnées.
    if (ville && ville.trim().length >= 2) {
      const base = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(ville.trim())}&types=%28cities%29&language=fr&key=${key}`;
      const groupes = ['country:fr|country:gp|country:mq', 'country:re|country:gf|country:yt'];
      const [d1, d2] = await Promise.all(groupes.map(g => gPlaces(base + '&components=' + encodeURIComponent(g))));
      const vus = new Set(); const villes = [];
      for (const p of [...(d1.predictions || []), ...(d2.predictions || [])]) {
        const nom = (p.structured_formatting && p.structured_formatting.main_text) || p.description;
        const detail = (p.structured_formatting && p.structured_formatting.secondary_text) || '';
        const cle = (nom + '|' + detail).toLowerCase();
        if (vus.has(cle)) continue;
        vus.add(cle);
        villes.push({ nom, detail });
        if (villes.length >= 8) break;
      }
      return res.status(200).json({ villes });
    }

    // ── Mode détails : on a le place_id, on renvoie tout pour pré-remplir ──
    if (place_id) {
      const champs = 'name,formatted_address,formatted_phone_number,website,address_components';
      const d = await gPlaces(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=${champs}&language=fr&key=${key}`);
      if (d.status !== 'OK' || !d.result) return res.status(404).json({ erreur: 'Établissement introuvable' });
      const r = d.result;
      // Essaie d'extraire ville + CP proprement via address_components, sinon parse l'adresse formatée
      let ville = '', cp = '';
      for (const c of (r.address_components || [])) {
        if (c.types.includes('postal_code')) cp = c.long_name;
        if (c.types.includes('locality')) ville = c.long_name;
        if (!ville && c.types.includes('postal_town')) ville = c.long_name;
      }
      const parse = decouperAdresse(r.formatted_address);
      return res.status(200).json({
        place_id,
        nom: r.name || '',
        adresse: parse.adresse || '',
        ville: ville || parse.ville || '',
        code_postal: cp || parse.code_postal || '',
        telephone: r.formatted_phone_number || '',
        site_web: r.website || ''
      });
    }

    // ── Mode recherche : on renvoie une liste de suggestions ──
    if (q && q.trim().length >= 3) {
      const d = await gPlaces(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q.trim())}&language=fr&key=${key}`);
      const resultats = (d.results || []).slice(0, 5).map(x => ({
        place_id: x.place_id,
        nom: x.name,
        adresse: x.formatted_address || ''
      }));
      return res.status(200).json({ resultats });
    }

    return res.status(200).json({ resultats: [] });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur Google Places', detail: String(e.message || e).slice(0, 200) });
  }
}
