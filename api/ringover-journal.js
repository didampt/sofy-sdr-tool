// /api/ringover-journal.js — Journal global des appels Ringover (vue manager pour Romain).
// Réservé admin/superadmin. Renvoie les appels récents (slim) pour affichage + filtres côté front.
// Auth Ringover : header Authorization = clé brute. Base https://public-api.ringover.com/v2

import { verifierToken } from './db.js';

const BASE = 'https://public-api.ringover.com/v2';
const LIMIT = 1000;
const MAX_PAGES = 2;  // ~2000 appels récents (large pour le shadowing ; date-range à ajouter plus tard si besoin)

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!['admin', 'superadmin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé au management (Romain / superadmin)' });

  const key = process.env.RINGOVER_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'RINGOVER_API_KEY manquante dans Vercel' });

  try {
    const appels = [];
    let total = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await fetch(`${BASE}/calls?limit_count=${LIMIT}&limit_offset=${p * LIMIT}`, { headers: { 'Authorization': key } });
      if (r.status === 401) return res.status(502).json({ erreur: 'Clé Ringover refusée (droit "lecture des appels" ?)' });
      let d = null; try { d = await r.json(); } catch (e) {}
      if (!d) break;
      total = d.total_call_count ?? total;
      const liste = d.call_list || [];
      if (!liste.length) break;
      for (const c of liste) {
        appels.push({
          start_time: c.start_time || null,
          direction: c.direction || null,
          is_answered: !!c.is_answered,
          incall_duration: c.incall_duration || 0,
          // Numéro du prospect : appelé (sortant) ou appelant (entrant)
          numero: c.direction === 'in' ? (c.from_number || c.contact_number) : (c.to_number || c.contact_number),
          record: c.record || null,
          voicemail: c.voicemail || null,
          note: (c.note || '').trim() || null,
          tags: Array.isArray(c.tags) ? c.tags.map(t => t.name).filter(Boolean) : [],
          sdr: c.user ? (c.user.concat_name || `${c.user.firstname || ''} ${c.user.lastname || ''}`.trim()) : null,
          sdr_email: c.user ? (c.user.email || null) : null
        });
      }
      if (liste.length < LIMIT) break;
    }
    return res.status(200).json({ appels, total, renvoyes: appels.length });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur API Ringover', detail: String(e.message || e).slice(0, 200) });
  }
}
