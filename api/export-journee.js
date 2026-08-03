// /api/export-journee.js — ⬇️ Export CSV de « Ma journée » : les leads appelés (fiches statuées)
// croisés avec l'analyse IA du Coach (décroché, durée, note, résumé, action) et le NEXT STEP
// (RDV pris / rappel planifié / séquence Lemlist). GET ?du=&au=&sdr= → text/csv (Excel FR : ; + BOM).
// Rôles : un SDR exporte SA journée ; admin = tout SDR via ?sdr=.

import { verifierToken, sql, ensureSchema, ensureCoach } from './db.js';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  const admin = ['admin', 'superadmin'].includes(user.role);

  try {
    await ensureSchema();
    await ensureCoach();
    const auj = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    let du = String((req.query || {}).du || '').slice(0, 10);
    let au = String((req.query || {}).au || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(du)) du = auj;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(au)) au = auj;
    const sdrF = admin ? (String((req.query || {}).sdr || '').trim() || user.nom) : user.nom;
    const duT = new Date(du + 'T00:00:00+02:00').getTime();
    const auT = new Date(au + 'T23:59:59+02:00').getTime();

    // ── Analyses IA de la période (index par nom de prospect normalisé) ──
    const anIdx = [];
    try {
      const ans = await sql`SELECT prospect, tags, duree_sec, note, "analyse" FROM analyses_appels
        WHERE jour >= ${du} AND jour <= ${au} AND sdr = ${sdrF}`;
      for (const a of ans) anIdx.push({ k: norm(a.prospect), a });
    } catch (_) {}
    const trouverAnalyse = (noms) => {
      for (const n of noms) {
        const k = norm(n);
        if (k.length < 4) continue;
        const m = anIdx.find(x => x.k && (x.k.includes(k) || k.includes(x.k)));
        if (m) return m.a;
      }
      return null;
    };

    // ── Rappels en attente (next step) ──
    const rappels = {};
    try {
      for (const t of await sql`SELECT fiche_cle, date_rappel, description FROM taches WHERE sdr = ${sdrF} AND faite = FALSE AND fiche_cle IS NOT NULL`)
        if (!rappels[t.fiche_cle]) rappels[t.fiche_cle] = t;
    } catch (_) {}

    // ── Fiches statuées sur la période ──
    const lignes = [];
    const ls = await sql`SELECT nom, entreprises FROM listes WHERE criteres->>'auto' IS DISTINCT FROM 'hotleads'`;
    for (const l of ls) for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
      if (e.traite_par !== sdrF || !e.traite_le) continue;
      const t = new Date(e.traite_le).getTime();
      if (t < duT || t > auT) continue;
      const statut = (e.tags_sdr || [])[0] || e.statut_appel || '';
      const nomE = e.enseigne_ia || e.enseigne || e.nom || '';
      const c0 = (e.contacts || []).find(c => c && c.nom) || null;
      const contact = c0 ? ((c0.prenom || '') + ' ' + (c0.nom || '')).trim() : '';
      const tel = (c0 && c0.enrich && c0.enrich.telephone) || (e.enrich && e.enrich.telephone) || (e.gmb && e.gmb.telephone) || (e.ia && e.ia.telephone) || '';
      const an = trouverAnalyse([nomE, e.nom, contact]);
      const emailCle = ((e.contacts || []).find(c => c && c.enrich && c.enrich.email) || {}).enrich;
      const cleF = (emailCle && emailCle.email) ? String(emailCle.email).toLowerCase() : ('nom:' + String(e.nom || '').toLowerCase().replace(/\s+/g, ' ').trim());
      const rp = rappels[cleF];
      let next = '';
      if (statut.indexOf('RDV') >= 0) next = 'RDV pris';
      else if (rp) next = 'Rappel le ' + new Date(rp.date_rappel).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      else if (e.sequence_auto || e.lemlist_envoye) next = 'Séquence Lemlist';
      lignes.push({
        date: new Date(e.traite_le).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        entreprise: nomE, contact, tel, ville: e.ville || '', liste: l.nom || '',
        statut,
        decroche: an ? 'oui' : '',
        duree: an ? Math.floor((an.duree_sec || 0) / 60) + ':' + String((an.duree_sec || 0) % 60).padStart(2, '0') : '',
        note_ia: (an && an.note != null) ? String(an.note) : '',
        resume_ia: (an && an.analyse && an.analyse.resume) || '',
        action_ia: (an && an.analyse && (an.analyse.actions || [])[0]) || '',
        next_step: next
      });
    }
    lignes.sort((a, b) => a.date < b.date ? 1 : -1);

    // ── CSV Excel FR : séparateur ; + BOM UTF-8 ──
    const cols = [['date', 'Date'], ['entreprise', 'Entreprise'], ['contact', 'Contact'], ['tel', 'Téléphone'], ['ville', 'Ville'],
      ['liste', 'Liste'], ['statut', 'Issue d’appel'], ['decroche', 'Décroché (analysé)'], ['duree', 'Durée'],
      ['note_ia', 'Note IA /10'], ['resume_ia', 'Résumé IA'], ['action_ia', 'Action recommandée'], ['next_step', 'Next step']];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
    const csv = '﻿' + cols.map(c => esc(c[1])).join(';') + '\n'
      + lignes.map(li => cols.map(c => esc(li[c[0]])).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="journee_${sdrF.replace(/[^\w-]/g, '_')}_${du}${au !== du ? '_' + au : ''}.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
