// /api/basile-debug4.js — TEMPORAIRE — DÉCISIF.
// Cherche des PERSONNES par poste (sans employer) et montre TOUS les champs d'un contact
// qui a un poste rempli (source LinkedIn probable). Objectif : voir si Basile expose
// le persona + le profil LinkedIn + des indices email/tel. À SUPPRIMER après.

import { verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });

  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  try {
    // Cherche des personnes avec un poste précis (devrait taper la source LinkedIn)
    const filters = {
      result_role: { include: ['Directeur Commercial', 'Directeur Marketing', 'Head of Sales'] },
      result_country_code: { include: ['FR'] },
      result_is_current: true
    };
    const r = await fetch('https://api.basile.cc/people/find', {
      method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5, filters })
    });
    const data = await r.json().catch(() => null);
    const leads = data?.leads || [];

    // Pour chaque lead, on regarde la source et les champs présents
    const analyse = leads.map(l => ({
      source: l.source,
      champs: Object.keys(l.data || {}).sort(),
      // On expose les valeurs clés pour voir ce qui est réellement rempli
      apercu: {
        prenom: (l.data || {}).result_first_name,
        nom: (l.data || {}).result_last_name,
        poste: (l.data || {}).result_role || (l.data || {}).current_title || (l.data || {}).job_title || '(vide)',
        entreprise: (l.data || {}).current_company_name,
        linkedin: (l.data || {}).result_linkedin_url || (l.data || {}).linkedin_url || (l.data || {}).linkedin || '(vide)',
        email: (l.data || {}).result_email || (l.data || {}).email || '(vide)',
        tel: (l.data || {}).result_phone || (l.data || {}).phone || '(vide)',
        ville: (l.data || {}).result_city
      }
    }));

    return res.status(200).json({
      total_disponible: data?.total,
      nb_rapportes: leads.length,
      sources_rencontrees: [...new Set(leads.map(l => l.source))],
      analyse
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur diagnostic', detail: String(e.message || e).slice(0, 200) });
  }
}
