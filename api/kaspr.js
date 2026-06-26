// /api/kaspr.js — Niveau 3 du waterfall : MOBILES (+ email direct en bonus) via l'URL LinkedIn
// POST {linkedin:"https://www.linkedin.com/in/xxx", prenom, nom}
//   → {ok, resultat:{telephone, email, fonction}, brut?} 
// Coût : 1 crédit téléphone si mobile trouvé + 1 crédit export par appel réussi.
// Mode défensif : si la forme de réponse varie, on renvoie aussi le brut pour ajuster le mapping.

import { verifierToken, loggerConso, limiteAtteinte } from './db.js';

export const config = { maxDuration: 30 };

function extraireIdLinkedin(url) {
  // "https://www.linkedin.com/in/jean-dufour-12345/" → "jean-dufour-12345"
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : null;
}

export default async function handler(req, res) {

  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const apiKey = process.env.KASPR_API_KEY;
  if (!apiKey) return res.status(500).json({ erreur: 'KASPR_API_KEY manquante dans Vercel' });

  const { linkedin = '', prenom = '', nom = '' } = req.body || {};
  const idLinkedin = extraireIdLinkedin(linkedin);
  if (!idLinkedin) return res.status(400).json({ erreur: 'URL LinkedIn invalide ou absente' });

  try {
    await loggerConso(user, 'kaspr', 1, req.body?.liste_id);
    const r = await fetch('https://api.developers.kaspr.io/profile/linkedin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'accept-version': 'v2.0'
      },
      body: JSON.stringify({
        id: idLinkedin,
        name: `${prenom} ${nom}`.trim() || idLinkedin,
        dataToGet: ['phone', 'workEmail']
      })
    });

    const texte = await r.text();
    let data;
    try { data = JSON.parse(texte); } catch { data = { brut_texte: texte.slice(0, 400) }; }

    if (!r.ok) {
      return res.status(502).json({
        erreur: `Kaspr ${r.status}`,
        detail: (data && (data.message || data.error)) || texte.slice(0, 200)
      });
    }

    // Mapping défensif : la fiche profil peut être à la racine ou sous profile/data
    const p = data.profile || data.data || data || {};
    const tels = []
      .concat(p.phones || [], p.phone || [], p.phoneNumbers || [])
      .map(t => (typeof t === 'string' ? t : (t && (t.number || t.phone || t.value))))
      .filter(Boolean);
    const emails = []
      .concat(p.directEmails || [], p.workEmails || [], p.emails || [], p.email || [])
      .map(e => (typeof e === 'string' ? e : (e && (e.email || e.address || e.value))))
      .filter(Boolean);

    const resultat = {
      telephone: tels[0] || null,
      email: emails[0] || null,
      fonction: p.title || p.job || null
    };

    const corps = { ok: true, resultat };
    // Si rien d'exploitable, joindre le brut pour diagnostic (tronqué)
    if (!resultat.telephone && !resultat.email) corps.brut = JSON.stringify(data).slice(0, 600);

    return res.status(200).json(corps);
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: err.message });
  }
}
