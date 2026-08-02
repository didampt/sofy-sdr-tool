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
      const cle = String(j.jour).slice(0, 10);
      totaux.jours.add(cle);
      parJour[cle] = (parJour[cle] || 0) + (j.appels || 0);
    }
    const graphe = Object.entries(parJour).sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([jour, appels]) => ({ jour, appels }));

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
      journees: journees.map(j => ({ ...j, jour: String(j.jour).slice(0, 10) })),
      totaux: {
        appels: totaux.appels, decroches: totaux.decroches,
        taux_decroche: totaux.appels ? Math.round(100 * totaux.decroches / totaux.appels) : 0,
        duree_moy_sec: totaux.decroches ? Math.round(totaux.duree_sec / totaux.decroches) : 0,
        statuees: totaux.statuees, rdv: totaux.rdv, jours: totaux.jours.size
      },
      graphe, entonnoir, concurrents, objectifs
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: e.message });
  }
}
