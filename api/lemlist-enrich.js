// /api/lemlist-enrich.js — Waterfall niveau 4 : enrichissement Lemlist (email + mobile).
// Même contrat que FullEnrich (async POST -> poll GET).
// POST { contact:{prenom,nom,linkedin,email,fonction}, entreprise:{nom,site} }
//        -> { pending:true, enrichment_id } | { resultat:{email,telephone,linkedin}, enrichment_id } | { erreur }
// GET  ?enrichment_id=enr_xxx
//        -> { pending:true, enrichment_id } | { resultat:{email,telephone,linkedin} } | { erreur }
import { verifierToken } from './db.js';

export const config = { maxDuration: 30 };

const KEY = process.env.LEMLIST_API_KEY;
const authHeader = () => 'Basic ' + Buffer.from(':' + (KEY || '')).toString('base64');

function parseResultat(d) {
  const data = (d && d.data) || {};
  const em = data.email || data.find_email || {};
  const ph = data.phone || data.find_phone || {};
  const lk = data.linkedin_enrichment || data.linkedinEnrichment || {};
  const email = (em && em.notFound !== true && (em.email || em.value)) || (typeof data.email === 'string' ? data.email : '') || '';
  const telephone = (ph && (ph.phone || ph.value || ph.number)) || (typeof data.phone === 'string' ? data.phone : '') || '';
  const linkedin = (lk && lk.linkedinUrl) || data.linkedinUrl || '';
  return { email: email || '', telephone: telephone || '', linkedin: linkedin || '' };
}

async function lire(id) {
  const r = await fetch(`https://api.lemlist.com/api/enrich/${encodeURIComponent(id)}`, { headers: { 'Authorization': authHeader() } });
  if (r.status === 202) return { pending: true, enrichment_id: id };
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { erreur: 'Lemlist GET ' + r.status };
  const statut = d.enrichmentStatus || d.status || (d.type === 'enrichmentDone' ? 'done' : '');
  if (statut && statut !== 'done') return { pending: true, enrichment_id: id };
  return { resultat: parseResultat(d), enrichment_id: id };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!KEY) return res.status(200).json({ erreur: 'Lemlist non configuré (LEMLIST_API_KEY manquante)' });

  try {
    if (req.method === 'GET') {
      const id = String(req.query.enrichment_id || '').trim();
      if (!id) return res.status(400).json({ erreur: 'enrichment_id requis' });
      return res.status(200).json(await lire(id));
    }

    const b = req.body || {};
    const c = b.contact || {};
    const ent = b.entreprise || {};
    if (!c.linkedin && !c.email && !(c.nom && (ent.site || ent.nom))) {
      return res.status(200).json({ erreur: 'Pas assez d’infos (nom + société/domaine, ou LinkedIn, ou email)' });
    }
    const params = new URLSearchParams();
    params.set('findEmail', 'true');
    params.set('findPhone', 'true');
    if (c.prenom) params.set('firstName', c.prenom);
    if (c.nom) params.set('lastName', c.nom);
    if (c.linkedin) params.set('linkedinUrl', c.linkedin.startsWith('http') ? c.linkedin : 'https://' + c.linkedin);
    if (c.email) params.set('email', c.email);
    if (ent.site) params.set('companyDomain', String(ent.site).replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    if (ent.nom) params.set('companyName', ent.nom);
    if (c.fonction) params.set('jobTitle', c.fonction);

    const r = await fetch('https://api.lemlist.com/api/enrich?' + params.toString(), { method: 'POST', headers: { 'Authorization': authHeader() } });
    const txt = await r.text();
    let d = {}; try { d = JSON.parse(txt); } catch (_) { d = {}; }
    if (!r.ok) return res.status(200).json({ erreur: 'Lemlist POST ' + r.status + (txt ? ' — ' + txt.slice(0, 120) : '') });
    const id = d.id || d.enrichmentId;
    if (!id) return res.status(200).json({ erreur: 'Lemlist : pas d’ID d’enrichissement' });

    // Essai rapide (parfois instantané)
    await new Promise(x => setTimeout(x, 2500));
    const g = await lire(id);
    if (g.resultat) return res.status(200).json(g);
    return res.status(200).json({ pending: true, enrichment_id: id });
  } catch (e) {
    return res.status(200).json({ erreur: 'Lemlist erreur : ' + String(e.message || e).slice(0, 150) });
  }
}
