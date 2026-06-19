// /api/basile-debug6.js — TEMPORAIRE — DERNIER. Montre les VALEURS réelles de contacts LinkedIn.
// À SUPPRIMER après. Réservé superadmin.

import { verifierToken } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé superadmin' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  try {
    // Cherche des contacts avec un titre commercial/marketing (source LinkedIn)
    const filters = {
      current_job_title: { include: ['Directeur Commercial', 'Directeur Marketing'] },
      location_country_code: { include: ['FR'] }
    };
    const r = await fetch('https://api.basile.cc/people/find', {
      method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 4, filters })
    });
    const data = await r.json().catch(() => null);
    const leads = data?.leads || [];

    // On renvoie les VALEURS complètes (pas juste les noms de champs), anonymisées partiellement
    const exemples = leads.map(l => {
      const d = l.data || {};
      return {
        source: l.source,
        people_first_name: d.people_first_name,
        people_last_name: d.people_last_name ? (d.people_last_name[0] + '***') : null, // anonymise le nom
        current_job_title: d.current_job_title,
        current_job_functions: d.current_job_functions,
        current_seniority: d.current_seniority,
        current_company_name: d.current_company_name,
        current_company_profile_url: d.current_company_profile_url,
        profile_url: d.profile_url ? '✓ présent' : '✗ absent',
        location_city: d.location_city,
        location_region: d.location_region,
        // Cherche tout champ qui pourrait être un email ou un téléphone
        champs_email_tel: Object.keys(d).filter(k => /email|phone|mail|tel|mobile/i.test(k)),
        // Liste tous les champs pour ne rien rater
        tous_les_champs: Object.keys(d).sort()
      };
    });

    return res.status(200).json({
      total_disponible: data?.total,
      nb: leads.length,
      exemples
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur diagnostic', detail: String(e.message || e).slice(0, 200) });
  }
}
