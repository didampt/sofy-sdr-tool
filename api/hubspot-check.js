// /api/hubspot-check.js — vérifie quels emails sont DÉJÀ dans HubSpot (tout stade)
// Body : { emails: ["a@x.fr", "b@y.fr", ...] }
// Renvoie : { connus: { "a@x.fr": { stage, owner }, ... } }  (seuls les emails trouvés)
import { existeDansHubspot, verifierToken } from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST requis' });
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(200).json({ connus: {}, hubspot: false });

  const { emails } = req.body || {};
  if (!Array.isArray(emails) || !emails.length) return res.status(200).json({ connus: {} });

  const uniques = [...new Set(emails.filter(e => e && e.includes('@')))].slice(0, 100);
  const connus = {};
  // Par lots de 5 en parallèle pour ne pas saturer l'API HubSpot
  for (let i = 0; i < uniques.length; i += 5) {
    const lot = uniques.slice(i, i + 5);
    const res5 = await Promise.all(lot.map(em => existeDansHubspot(em)));
    res5.forEach((r, j) => { if (r) connus[lot[j]] = r; });
  }
  return res.status(200).json({ connus });
}
