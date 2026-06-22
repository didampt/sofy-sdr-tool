// /api/ringover-journal.js — Journal global des appels Ringover (vue manager).
// Réservé admin/superadmin. Renvoie tous les appels récents (slim) + le RÔLE de chaque agent,
// résolu via la table sdrs (email prioritaire, sinon ligne Ringover). Pour les filtres + le dashboard.

import { verifierToken, sql } from './db.js';

const BASE = 'https://public-api.ringover.com/v2';
const LIMIT = 1000;
const MAX_PAGES = 3;  // ~3000 max → couvre tout l'historique du compte (jour/semaine/mois/année)
const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (!['admin', 'superadmin'].includes(user.role)) return res.status(403).json({ erreur: 'Réservé au management (Romain / superadmin)' });

  const key = process.env.RINGOVER_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'RINGOVER_API_KEY manquante dans Vercel' });

  try {
    // Mapping agent → rôle (table sdrs : email prioritaire, sinon ligne Ringover via 9 derniers chiffres)
    const byEmail = {}, byNum = {};
    try {
      const us = await sql`SELECT nom, email, role, ringover_numero FROM sdrs`;
      for (const u of us) {
        if (u.email) byEmail[u.email.toLowerCase().trim()] = { nom: u.nom, role: u.role || 'sdr' };
        if (u.ringover_numero) { const k = cle9(u.ringover_numero); if (k) byNum[k] = { nom: u.nom, role: u.role || 'sdr' }; }
      }
    } catch (e) {}
    const resoudre = c => {
      const em = c.user && c.user.email ? c.user.email.toLowerCase().trim() : '';
      if (em && byEmail[em]) return byEmail[em];
      const ligne = c.direction === 'in' ? c.to_number : c.from_number; // la ligne = celle de l'agent
      const k = cle9(ligne);
      if (k && byNum[k]) return byNum[k];
      return null;
    };

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
        const m = resoudre(c);
        const nomRingover = c.user ? (c.user.concat_name || `${c.user.firstname || ''} ${c.user.lastname || ''}`.trim()) : null;
        appels.push({
          start_time: c.start_time || null,
          direction: c.direction || null,
          is_answered: !!c.is_answered,
          incall_duration: c.incall_duration || 0,
          numero: c.direction === 'in' ? (c.from_number || c.contact_number) : (c.to_number || c.contact_number),
          record: c.record || null,
          voicemail: c.voicemail || null,
          note: (c.note || '').trim() || null,
          tags: Array.isArray(c.tags) ? c.tags.map(t => t.name).filter(Boolean) : [],
          sdr: (m && m.nom) || nomRingover,
          sdr_email: c.user ? (c.user.email || null) : null,
          role: m ? m.role : null
        });
      }
      if (liste.length < LIMIT) break;
    }
    return res.status(200).json({ appels, total, renvoyes: appels.length });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur API Ringover', detail: String(e.message || e).slice(0, 200) });
  }
}
