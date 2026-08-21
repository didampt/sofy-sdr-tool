// /api/hubspot-check.js — vérifie quels emails sont DÉJÀ dans HubSpot (tout stade)
// Body : { emails: ["a@x.fr", …], domaines: ["x.fr", …] }
// Renvoie : { connus: { "a@x.fr": { stage, owner }, … }, clients: { "x.fr": true, … } }
//
// ⚠️ POURQUOI `domaines` A ÉTÉ AJOUTÉ (21/08).
// On cherchait à DEVINER, depuis le site d'un prospect, s'il utilise déjà Sofy. C'est impossible
// pour Soview comme pour SoReach : ces briques se pilotent depuis app.sofy.fr et ne déposent rien
// sur le site du client (constat Didier). Aucune signature ne les trouvera jamais, et j'en avais
// pourtant écrit — inventées.
// Or l'information EXISTE, et pas dehors : dans HubSpot. Le `lifecyclestage` d'un contact dit
// « customer ». On arrête donc de déduire, et on demande à celui qui sait. Gratuit, exact, et ça
// couvre tous les modules d'un coup — y compris ceux qu'aucun scan ne peut voir.
import { existeDansHubspot, estClientHubspot, verifierToken } from './db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST requis' });
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  const token = process.env.HUBSPOT_API_KEY;
  if (!token) return res.status(200).json({ connus: {}, clients: {}, hubspot: false });

  const { emails, domaines } = req.body || {};
  const listeE = Array.isArray(emails) ? emails : [];
  const listeD = Array.isArray(domaines) ? domaines : [];
  if (!listeE.length && !listeD.length) return res.status(200).json({ connus: {}, clients: {} });

  const uniques = [...new Set(listeE.filter(e => e && e.includes('@')))].slice(0, 100);
  const connus = {};
  // Par lots de 5 en parallèle pour ne pas saturer l'API HubSpot
  for (let i = 0; i < uniques.length; i += 5) {
    const lot = uniques.slice(i, i + 5);
    const res5 = await Promise.all(lot.map(em => existeDansHubspot(em)));
    res5.forEach((r, j) => { if (r) connus[lot[j]] = r; });
  }

  // Statut CLIENT par domaine : utile quand la fiche n'a encore aucun email connu, ce qui est le
  // cas le plus fréquent en début de prospection.
  const clients = {};
  const domsUniques = [...new Set(listeD
    .map(d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])
    .filter(d => d && d.includes('.')))].slice(0, 40);
  for (let i = 0; i < domsUniques.length; i += 5) {
    const lot = domsUniques.slice(i, i + 5);
    const res5 = await Promise.all(lot.map(d => estClientHubspot(null, d)));
    res5.forEach((r, j) => { if (r) clients[lot[j]] = true; });
  }
  return res.status(200).json({ connus, clients });
}
