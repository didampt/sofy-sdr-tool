// /api/coach.js — Lecture des analyses du Coach d'appels (transparence : un SDR voit SES
// analyses, les admins voient tout — arbitrage Didier 03/08).
// GET ?call_id=…            → une analyse complète (pour le Journal des appels)
// GET ?du=&au=&sdr=&limit=  → liste (note, actions, résumé) pour la vue coaching

import { verifierToken, sql, ensureSchema, ensureCoach } from './db.js';

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const admin = ['admin', 'superadmin'].includes(user.role);

  try {
    await ensureSchema();
    await ensureCoach();
    const callId = String((req.query || {}).call_id || '').trim();
    if (callId) {
      const rows = await sql`SELECT * FROM analyses_appels WHERE call_id = ${callId} LIMIT 1`;
      if (!rows.length) return res.status(200).json({ ok: true, analyse: null });
      if (!admin && rows[0].sdr !== user.nom) return res.status(403).json({ erreur: 'Analyse réservée au SDR concerné et aux managers' });
      return res.status(200).json({ ok: true, analyse: rows[0] });
    }

    let du = String((req.query || {}).du || '').slice(0, 10);
    let au = String((req.query || {}).au || '').slice(0, 10);
    const auj = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(du)) du = auj.slice(0, 7) + '-01';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(au)) au = auj;
    const sdrF = admin ? String((req.query || {}).sdr || '').trim() : user.nom;
    const lim = Math.min(Math.max(parseInt((req.query || {}).limit, 10) || 100, 1), 300);

    const rows = sdrF
      ? await sql`SELECT call_id, sdr, jour, duree_sec, prospect, tags, note, "analyse", created_at
          FROM analyses_appels WHERE jour >= ${du} AND jour <= ${au} AND sdr = ${sdrF}
          ORDER BY jour DESC, note ASC LIMIT ${lim}`
      : await sql`SELECT call_id, sdr, jour, duree_sec, prospect, tags, note, "analyse", created_at
          FROM analyses_appels WHERE jour >= ${du} AND jour <= ${au}
          ORDER BY jour DESC, note ASC LIMIT ${lim}`;

    // Moyennes par SDR (pilotage rapide)
    const parSdr = {};
    for (const r of rows) {
      const s = parSdr[r.sdr] = parSdr[r.sdr] || { n: 0, somme: 0, rdv_proposes: 0 };
      s.n++; s.somme += Number(r.note) || 0;
      if (r.analyse && r.analyse.proposition_rdv && r.analyse.proposition_rdv.faite) s.rdv_proposes++;
    }
    for (const s of Object.values(parSdr)) { s.note_moy = s.n ? Math.round(10 * s.somme / s.n) / 10 : null; delete s.somme; }

    // Neon renvoie les DATE en objet Date : ISO explicite (String(Date) donnait « Fri Jul 31 »)
    return res.status(200).json({ ok: true, periode: { du, au }, admin, analyses: rows.map(r => ({ ...r, jour: new Date(r.jour).toISOString().slice(0, 10) })), par_sdr: parSdr });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: e.message });
  }
}
