// /api/carte.js — 🪄 Pré-remplissage du Hot lead manuel (usage AE : salon, déplacement).
// Deux modes, même réponse {ok, resultat:{prenom, nom, fonction, entreprise, site_web, ville, email, telephone}} :
//   POST { image, media_type }  -> photo de carte de visite lue par Claude en vision (~0,01 €, 3-5 s).
//                                  `image` = base64 SANS préfixe dataURL ; le front réduit la photo
//                                  à ≤1600 px AVANT l'envoi (limite de corps Vercel ~4,5 Mo — même
//                                  piège que les vignettes PNG du 26/08).
//   POST { linkedin }           -> URL de profil : prénom/nom déduits du slug (gratuit), puis
//                                  Claude + web_search retrouve fonction/entreprise/site via les
//                                  traces publiques (~0,03-0,06 €, 10-30 s). Fiabilité bonne sur
//                                  les profils visibles, partielle sur les discrets : les champs
//                                  restent ÉDITABLES côté front, jamais validés aveuglément.
// Chaque appel est journalisé dans consommations ('ia_claude') comme les Personas.

import { verifierToken, loggerConso } from './db.js';

export const config = { maxDuration: 120 }; // règle du 17/08 : généreux dès qu'on appelle l'IA / le web

const CHAMPS = '{"prenom": "…", "nom": "…", "fonction": "…", "entreprise": "…", "site_web": "domaine.fr ou null", "ville": "… ou null", "email": "… ou null", "telephone": "… ou null"}';

function extraireJson(data) {
  const textes = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  const brut = (textes[textes.length - 1] || '').replace(/```json|```/g, '').trim();
  const d = brut.indexOf('{'), f = brut.lastIndexOf('}');
  if (d === -1 || f === -1) return null;
  try { return JSON.parse(brut.slice(d, f + 1)); } catch { return null; }
}

// Slug LinkedIn -> prénom/nom probables (gratuit, avant même l'appel IA)
function nomDepuisSlug(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  const mots = decodeURIComponent(m[1]).replace(/-[0-9a-z]{5,}$/i, '').split('-').filter(Boolean);
  if (!mots.length) return null;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return { prenom: cap(mots[0] || ''), nom: mots.slice(1).map(cap).join(' ') };
}

async function appelerClaude(apiKey, corps) {
  const un = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(corps)
  });
  let r = await un();
  if (r.status === 429) { await new Promise(x => setTimeout(x, 15000)); r = await un(); }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY manquante' });
  const b = req.body || {};

  try {
    let corps;
    if (b.image) {
      const media = /^image\/(jpeg|png|webp|gif)$/.test(String(b.media_type || '')) ? b.media_type : 'image/jpeg';
      corps = {
        model: 'claude-sonnet-4-6', max_tokens: 600,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: String(b.image) } },
          { type: 'text', text: `Ceci est une carte de visite (ou un badge de salon). Extrais les coordonnées de LA PERSONNE (pas celles d'un standard générique si un contact direct existe).\nRéponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :\n${CHAMPS}\nRègles : site_web = domaine nu (sans https/www) ; telephone = mobile de préférence, au format lisible ; champ illisible ou absent -> null. N'invente RIEN.` }
        ] }]
      };
    } else if (b.linkedin) {
      const url = String(b.linkedin).trim().slice(0, 300);
      if (!/linkedin\.com\/in\//i.test(url)) return res.status(400).json({ erreur: 'Colle une URL de PROFIL LinkedIn (linkedin.com/in/…)' });
      const indice = nomDepuisSlug(url);
      corps = {
        model: 'claude-sonnet-4-6', max_tokens: 800,
        messages: [{ role: 'user', content: `Profil LinkedIn : ${url}${indice ? `\nNom probable d'après l'URL : ${indice.prenom} ${indice.nom}` : ''}\nLinkedIn n'est pas lisible directement : cherche sur le web les traces publiques de ce profil (annuaires, presse, site de sa société, Pappers…) pour identifier la personne.\nRéponds UNIQUEMENT avec un objet JSON, sans texte autour, sans backticks :\n${CHAMPS}\nRègles : site_web = domaine nu du site de SA société ; information non confirmée par ta recherche -> null. N'invente RIEN — un champ null vaut mieux qu'une erreur.` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      };
    } else {
      return res.status(400).json({ erreur: 'image (carte de visite) ou linkedin (URL de profil) requis' });
    }

    const r = await appelerClaude(apiKey, corps);
    if (!r.ok) return res.status(502).json({ erreur: 'API Claude', detail: (r.data.error && r.data.error.message) || ('HTTP ' + r.status) });
    await loggerConso(user, 'ia_claude', 1, null);

    const parsed = extraireJson(r.data);
    if (!parsed) return res.status(200).json({ ok: false, erreur: 'Lecture impossible — remplis les champs à la main' });
    // Le slug de l'URL reste l'autorité sur le nom quand l'IA n'a rien trouvé de mieux
    if (b.linkedin) {
      const indice = nomDepuisSlug(b.linkedin);
      if (indice && !parsed.prenom) parsed.prenom = indice.prenom;
      if (indice && !parsed.nom) parsed.nom = indice.nom;
    }
    const net = v => { const s = String(v == null ? '' : v).trim(); return (!s || /^null$/i.test(s)) ? null : s; };
    return res.status(200).json({ ok: true, resultat: {
      prenom: net(parsed.prenom), nom: net(parsed.nom), fonction: net(parsed.fonction),
      entreprise: net(parsed.entreprise),
      site_web: net(parsed.site_web) ? String(parsed.site_web).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : null,
      ville: net(parsed.ville), email: net(parsed.email) ? String(parsed.email).toLowerCase() : null, telephone: net(parsed.telephone)
    } });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
