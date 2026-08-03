// /api/stats-journees.js — Statistiques « Journées SDR » + entonnoir des issues + pertes concurrents.
// GET ?du=YYYY-MM-DD&au=YYYY-MM-DD&sdr=Nom
//   Rôles : admin/superadmin = toute l'équipe (+ filtre sdr) ; SDR = SES journées uniquement.
//   Retour : { journees, totaux, graphe, entonnoir, concurrents, objectifs, periode }
// Sources : journees_sdr (journal automatique du soir), listes.entreprises (tags_sdr/traite_le,
// concurrent_perdu) — aucun appel externe, aucune écriture.

import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { maxDuration: 30 };

function jourParis(d) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  const admin = ['admin', 'superadmin'].includes(user.role);

  // Période : défaut = le mois en cours (heure de Paris)
  const auj = jourParis();
  let du = String(req.query.du || '').slice(0, 10);
  let au = String(req.query.au || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(du)) du = auj.slice(0, 7) + '-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(au)) au = auj;
  // Visibilité : un SDR ne voit que ses journées
  const sdrF = admin ? String(req.query.sdr || '').trim() : user.nom;

  try {
    // ── Journées (journal automatique) ──
    const journees = sdrF
      ? await sql`SELECT sdr, jour, debut, fin, appels, decroches, duree_sec, statuees, rdv
          FROM journees_sdr WHERE jour >= ${du} AND jour <= ${au} AND sdr = ${sdrF}
          ORDER BY jour DESC, sdr ASC LIMIT 500`
      : await sql`SELECT sdr, jour, debut, fin, appels, decroches, duree_sec, statuees, rdv
          FROM journees_sdr WHERE jour >= ${du} AND jour <= ${au}
          ORDER BY jour DESC, sdr ASC LIMIT 500`;

    const totaux = { appels: 0, decroches: 0, duree_sec: 0, statuees: 0, rdv: 0, jours: new Set() };
    const parJour = {};
    for (const j of journees) {
      totaux.appels += j.appels || 0; totaux.decroches += j.decroches || 0;
      totaux.duree_sec += j.duree_sec || 0; totaux.statuees += j.statuees || 0; totaux.rdv += j.rdv || 0;
      const cle = new Date(j.jour).toISOString().slice(0, 10); // Neon renvoie les DATE en objet Date
      totaux.jours.add(cle);
      const pj = parJour[cle] = parJour[cle] || { appels: 0, rdv: 0 };
      pj.appels += j.appels || 0; pj.rdv += j.rdv || 0;
    }
    const graphe = Object.entries(parJour).sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([jour, x]) => ({ jour, appels: x.appels, rdv: x.rdv }));

    // ── Période PRÉCÉDENTE de même durée (deltas des tuiles KPI) ──
    const msJ = 24 * 3600 * 1000;
    const nbJours = Math.max(1, Math.round((new Date(au + 'T12:00:00Z') - new Date(du + 'T12:00:00Z')) / msJ) + 1);
    const pAu = new Date(new Date(du + 'T12:00:00Z').getTime() - msJ).toISOString().slice(0, 10);
    const pDu = new Date(new Date(du + 'T12:00:00Z').getTime() - nbJours * msJ).toISOString().slice(0, 10);
    const precedent = { appels: 0, decroches: 0, statuees: 0, rdv: 0, cout_conso: null };
    try {
      const pj = sdrF
        ? await sql`SELECT COALESCE(SUM(appels),0)::int a, COALESCE(SUM(decroches),0)::int d, COALESCE(SUM(statuees),0)::int s, COALESCE(SUM(rdv),0)::int r FROM journees_sdr WHERE jour >= ${pDu} AND jour <= ${pAu} AND sdr = ${sdrF}`
        : await sql`SELECT COALESCE(SUM(appels),0)::int a, COALESCE(SUM(decroches),0)::int d, COALESCE(SUM(statuees),0)::int s, COALESCE(SUM(rdv),0)::int r FROM journees_sdr WHERE jour >= ${pDu} AND jour <= ${pAu}`;
      if (pj[0]) { precedent.appels = pj[0].a; precedent.decroches = pj[0].d; precedent.statuees = pj[0].s; precedent.rdv = pj[0].r; }
    } catch (_) {}

    // ── 🎧 Coach (période) : note moyenne + RDV proposés par SDR ──
    const coach = {};
    try {
      const cs = sdrF
        ? await sql`SELECT sdr, COUNT(*)::int n, ROUND(AVG(note),1)::float note_moy FROM analyses_appels WHERE jour >= ${du} AND jour <= ${au} AND sdr = ${sdrF} GROUP BY sdr`
        : await sql`SELECT sdr, COUNT(*)::int n, ROUND(AVG(note),1)::float note_moy FROM analyses_appels WHERE jour >= ${du} AND jour <= ${au} GROUP BY sdr`;
      for (const c of cs) coach[c.sdr] = { n: c.n, note_moy: c.note_moy };
    } catch (_) {}

    // ── Quota Lemlist LIVE (24 h glissantes — colonne opérationnelle du tableau équipe) ──
    const quota = {};
    const PLAF = parseInt(process.env.LEMLIST_PLAFOND_JOUR || '75', 10);
    try {
      const q = await sql`SELECT auteur, COUNT(*)::int n FROM activites WHERE type = 'sequenceAdded' AND ts > NOW() - INTERVAL '24 hours' GROUP BY auteur`;
      for (const r of q) if (r.auteur) quota[r.auteur] = { utilise: r.n, plafond: PLAF };
    } catch (_) {}

    // ── 💰 Coûts PÉRIODISÉS (admins) : conso réelle de la période + abonnements au prorata ──
    let couts = null;
    if (admin) {
      try {
        const duT = du + 'T00:00:00+02:00', auT = au + 'T23:59:59+02:00';
        const cr = await sql`SELECT c.sdr, c.api, SUM(c.quantite * COALESCE(t.prix,0))::float cout
          FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
          WHERE c.created_at >= ${duT} AND c.created_at <= ${auT} GROUP BY c.sdr, c.api`;
        const parSdrC = {}, parApi = {};
        let totalC = 0;
        for (const r of cr) {
          totalC += r.cout;
          parSdrC[r.sdr] = (parSdrC[r.sdr] || 0) + r.cout;
          parApi[r.api] = (parApi[r.api] || 0) + r.cout;
        }
        const aboRows = await sql`SELECT valeur FROM config WHERE cle = 'abonnements'`;
        const abos = (aboRows.length && Array.isArray(aboRows[0].valeur)) ? aboRows[0].valeur : [];
        const abosMensuel = abos.reduce((s, a) => s + (Number(a.montant) || 0), 0);
        const abosProrata = Math.round(abosMensuel * nbJours / 30.44 * 100) / 100;
        couts = {
          conso: Math.round(totalC * 100) / 100,
          par_sdr: Object.fromEntries(Object.entries(parSdrC).map(([k, v]) => [k, Math.round(v * 100) / 100])),
          par_api: Object.fromEntries(Object.entries(parApi).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 100) / 100])),
          abos_prorata: abosProrata, abos_mensuel: Math.round(abosMensuel * 100) / 100,
          total: Math.round((totalC + abosProrata) * 100) / 100, jours: nbJours
        };
        // Conso de la période précédente (delta du coût)
        const pDuT = pDu + 'T00:00:00+02:00', pAuT = pAu + 'T23:59:59+02:00';
        const pc = await sql`SELECT SUM(c.quantite * COALESCE(t.prix,0))::float cout FROM consommations c LEFT JOIN tarifs t ON t.api = c.api WHERE c.created_at >= ${pDuT} AND c.created_at <= ${pAuT}`;
        precedent.cout_conso = Math.round(((pc[0] && pc[0].cout) || 0) * 100) / 100;
      } catch (_) {}
    }

    // ── Objectifs (couleurs du tableau) ──
    const objectifs = {};
    try {
      const os = await sql`SELECT nom, objectif_appels_jour, objectif_rdv_mois FROM sdrs WHERE actif = TRUE`;
      for (const o of os) objectifs[o.nom] = { appels: o.objectif_appels_jour || 50, rdv: o.objectif_rdv_mois || 20 };
    } catch (_) {}

    // ── Entonnoir des issues + pertes par concurrent (scan des fiches, filtré période/SDR) ──
    const entonnoir = {}; const concurrents = {};
    try {
      const duT = new Date(du + 'T00:00:00Z').getTime() - 2 * 3600 * 1000;   // marge fuseau
      const auT = new Date(au + 'T23:59:59Z').getTime() + 2 * 3600 * 1000;
      const ls = await sql`SELECT entreprises FROM listes WHERE criteres->>'auto' IS DISTINCT FROM 'hotleads'`;
      for (const l of ls) for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
        const statut = (e.tags_sdr || [])[0] || e.statut_appel || null;
        if (statut && e.traite_le) {
          const t = new Date(e.traite_le).getTime();
          if (t >= duT && t <= auT && (!sdrF || e.traite_par === sdrF)) entonnoir[statut] = (entonnoir[statut] || 0) + 1;
        }
        const cp = e.concurrent_perdu;
        if (cp && cp.nom && cp.date) {
          const t = new Date(cp.date).getTime();
          if (t >= duT && t <= auT && (!sdrF || e.traite_par === sdrF)) concurrents[cp.nom] = (concurrents[cp.nom] || 0) + 1;
        }
      }
    } catch (_) {}

    return res.status(200).json({
      ok: true, periode: { du, au }, sdr: sdrF || null, admin,
      journees: journees.map(j => ({ ...j, jour: new Date(j.jour).toISOString().slice(0, 10) })),
      totaux: {
        appels: totaux.appels, decroches: totaux.decroches,
        taux_decroche: totaux.appels ? Math.round(100 * totaux.decroches / totaux.appels) : 0,
        duree_moy_sec: totaux.decroches ? Math.round(totaux.duree_sec / totaux.decroches) : 0,
        statuees: totaux.statuees, rdv: totaux.rdv, jours: totaux.jours.size
      },
      graphe, entonnoir, concurrents, objectifs,
      precedent, coach, quota, couts
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: e.message });
  }
}
