// /api/ringover-calls.js — Récupère les appels Ringover correspondant à une liste de numéros.
// Brique 0 du shadowing : on interroge l'API Ringover (GET /calls), on matche côté serveur les
// numéros de la fiche/liste, et on renvoie SEULEMENT les appels concernés (payload léger).
//
// POST { numeros: ["0766420482", "+590690...", ...] }
//   → { table: { "<cle9>": [ {record, voicemail, note, tags, direction, is_answered,
//                             start_time, incall_duration, sdr, sdr_email} ] }, scannes, total }
//
// Auth Ringover : header Authorization = clé brute (SANS "Bearer"). Base https://public-api.ringover.com/v2
// Aucun impact sur Lemlist (on ne touche pas aux webhooks).

import { verifierToken } from './db.js';

const BASE = 'https://public-api.ringover.com/v2';
const LIMIT = 1000;     // appels par page
const MAX_PAGES = 3;    // plafond (3000 appels récents scannés max → tient dans le temps Vercel)

// Clé de comparaison d'un numéro : chiffres seuls, 9 derniers (FR mobile + fixe + DOM)
function cle9(s) {
  let d = String(s || '').replace(/\D/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

async function pageCalls(offset, key) {
  const r = await fetch(`${BASE}/calls?limit_count=${LIMIT}&limit_offset=${offset}`, {
    headers: { 'Authorization': key }
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const key = process.env.RINGOVER_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'RINGOVER_API_KEY manquante dans Vercel' });

  // ── RÉCUPÉRATION D'UN TRAVAIL PERDU ────────────────────────────────────────────────────────
  // Incident Franck du 20/08 : liste jamais enregistrée, 30 fiches et un RDV disparus avec
  // l'onglet. Les appels, eux, sont chez Ringover : ils ne dépendent pas de Sofy Scrap. Cette
  // vue liste les appels d'une journée pour reconstituer ce qui a été travaillé — numéro,
  // heure, durée, note et enregistrement compris.
  // GET ?journee=2026-08-20[&sdr=Franck]
  if (req.method === 'GET' && (req.query || {}).journee) {
    if (!['admin', 'superadmin'].includes(user.role)) {
      return res.status(403).json({ erreur: 'Réservé aux admins' });
    }
    const j = String(req.query.journee).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j)) return res.status(400).json({ erreur: 'Format attendu : AAAA-MM-JJ' });
    const qui = String((req.query || {}).sdr || '').toLowerCase().trim();
    const debut = new Date(j + 'T00:00:00Z').getTime();
    const fin = debut + 86400000;
    const appels = [];
    for (let p2 = 0; p2 < MAX_PAGES; p2++) {
      const { status, data } = await pageCalls(p2 * LIMIT, key);
      if (status !== 200 || !data) break;
      const lot = data.call_list || data.calls || [];
      if (!lot.length) break;
      let plusVieuxQueLaJournee = false;
      for (const c of lot) {
        const t = new Date(c.start_time || c.date || 0).getTime();
        if (!t) continue;
        if (t < debut) { plusVieuxQueLaJournee = true; continue; }
        if (t >= fin) continue;
        const agent = [c.user && c.user.firstname, c.user && c.user.lastname].filter(Boolean).join(' ');
        if (qui && !String(agent).toLowerCase().includes(qui) && !String((c.user || {}).email || '').toLowerCase().includes(qui)) continue;
        appels.push({
          heure: new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
          numero: c.to_number || c.from_number || '',
          contact: (c.contact && (c.contact.concat_name || c.contact.company)) || null,
          sens: c.direction === 'in' ? 'entrant' : 'sortant',
          repondu: !!c.is_answered,
          duree_s: c.incall_duration || 0,
          agent: agent || (c.user || {}).email || '',
          note: c.notes || (c.note && c.note.content) || null,
          enregistrement: c.record || null
        });
      }
      if (plusVieuxQueLaJournee) break;   // les pages suivantes sont encore plus anciennes
    }
    appels.sort((a, b) => a.heure.localeCompare(b.heure));
    return res.status(200).json({
      ok: true, journee: j, sdr: qui || 'tous', total: appels.length, appels,
      info: appels.length
        ? 'Ces appels viennent de Ringover : ils survivent à la perte d\'une liste. Le numéro et la note permettent de reconstituer la fiche.'
        : 'Aucun appel trouvé pour ce jour. Ringover ne conserve que les appels passés depuis un poste connecté.'
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST ou GET ?journee=' });

  const numeros = Array.isArray(req.body?.numeros) ? req.body.numeros : [];
  if (!numeros.length) return res.status(400).json({ erreur: 'numeros requis (tableau)' });

  // Ensemble des clés recherchées
  const recherche = new Set(numeros.map(cle9).filter(c => c.length >= 6));
  if (!recherche.size) return res.status(200).json({ table: {}, scannes: 0, total: 0 });

  const table = {};   // cle9 → [appels]
  let scannes = 0, total = null;

  try {
    for (let p = 0; p < MAX_PAGES; p++) {
      const { status, data } = await pageCalls(p * LIMIT, key);
      if (status === 401) return res.status(502).json({ erreur: 'Clé Ringover refusée (droit "lecture des appels" ?)' });
      if (!data) break;
      total = data.total_call_count ?? total;
      const liste = data.call_list || [];
      if (!liste.length) break;
      scannes += liste.length;

      for (const c of liste) {
        // Le numéro du prospect est to_number (sortant) ou from_number (entrant) ; on teste les deux.
        const cibles = [cle9(c.to_number), cle9(c.from_number)];
        const match = cibles.find(x => recherche.has(x));
        if (!match) continue;
        (table[match] = table[match] || []).push({
          record: c.record || null,
          voicemail: c.voicemail || null,
          note: (c.note || '').trim() || null,
          tags: Array.isArray(c.tags) ? c.tags.map(t => t.name).filter(Boolean) : [],
          direction: c.direction || null,
          is_answered: !!c.is_answered,
          start_time: c.start_time || null,
          incall_duration: c.incall_duration || 0,
          sdr: c.user ? (c.user.concat_name || `${c.user.firstname || ''} ${c.user.lastname || ''}`.trim()) : null,
          sdr_email: c.user ? (c.user.email || null) : null
        });
      }
      // Si la page n'est pas pleine, on a tout vu
      if (liste.length < LIMIT) break;
    }

    // Tri par date décroissante pour chaque numéro
    for (const k of Object.keys(table)) {
      table[k].sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
    }

    return res.status(200).json({ table, scannes, total });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur API Ringover', detail: String(e.message || e).slice(0, 200) });
  }
}
