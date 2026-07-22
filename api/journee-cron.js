// /api/journee-cron.js — Journal automatique des journées SDR + bilan Slack du soir.
// AUCUN pointage manuel : la journée est dérivée des actions réelles —
//   début/fin = premier/dernier appel Ringover du jour · appels/décrochés/durée = Ringover
//   statuées = fiches avec traite_le aujourd'hui (par traite_par) · RDV = activités 'rdv'.
// Snapshot upserté dans journees_sdr (comparaisons du cockpit + futur tableau croisé Romain),
// puis DM Slack de bilan à chaque SDR actif ayant eu de l'activité, avec comparaison vs moyenne 7 j.
// Cron Vercel : 17:00 UTC lun-ven (≈ 19 h Paris l'été, 18 h l'hiver).

import { sql, ensureSchema } from './db.js';

export const config = { maxDuration: 120 };

const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);

async function envoyerDM(slackId, texte) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !slackId) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: slackId, text: texte })
    });
  } catch (_) {}
}

const fmtDuree = sec => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

export default async function handler(req, res) {
  const estCron = req.headers['x-vercel-cron'] || (req.query && req.query.cron_secret === process.env.PHANTOMBUSTER_CRON_SECRET);
  if (!estCron) {
    try {
      const { verifierToken } = await import('./db.js');
      const user = verifierToken(req);
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    } catch (_) { return res.status(401).json({ erreur: 'Non autorisé' }); }
  }
  await ensureSchema();

  const debutJour = new Date(); debutJour.setHours(0, 0, 0, 0);
  const jourISO = debutJour.toISOString().slice(0, 10);

  try {
    // ── SDR actifs + mapping Ringover (email / 9 derniers chiffres de la ligne) ──
    const sdrs = await sql`SELECT nom, email, ringover_numero, slack_id FROM sdrs WHERE actif = TRUE`;
    const stats = {}; // nom -> {appels, decroches, duree, debut, fin, statuees, rdv}
    const parEmail = {}, parNum = {};
    for (const u of sdrs) {
      stats[u.nom] = { appels: 0, decroches: 0, duree: 0, debut: null, fin: null, statuees: 0, rdv: 0 };
      if (u.email) parEmail[u.email.toLowerCase().trim()] = u.nom;
      const k = cle9(u.ringover_numero); if (k) parNum[k] = u.nom;
    }

    // ── 1. Appels Ringover du jour (sortants) ──
    const cleRing = process.env.RINGOVER_API_KEY;
    if (cleRing) {
      for (let p = 0; p < 2; p++) {
        const r = await fetch(`https://public-api.ringover.com/v2/calls?limit_count=1000&limit_offset=${p * 1000}`, { headers: { 'Authorization': cleRing } });
        let d = null; try { d = await r.json(); } catch (_) {}
        const liste = (d && d.call_list) || [];
        if (!liste.length) break;
        let resteAujourdhui = false;
        for (const c of liste) {
          const ts = c.start_time ? new Date(c.start_time) : null;
          if (!ts || ts < debutJour) continue;
          resteAujourdhui = true;
          if (c.direction !== 'out') continue;
          const em = c.user && c.user.email ? c.user.email.toLowerCase().trim() : '';
          const nom = parEmail[em] || parNum[cle9(c.from_number)] || null;
          if (!nom || !stats[nom]) continue;
          const s = stats[nom];
          s.appels++;
          if (c.is_answered) { s.decroches++; s.duree += (c.incall_duration || 0); }
          if (!s.debut || ts < s.debut) s.debut = ts;
          if (!s.fin || ts > s.fin) s.fin = ts;
        }
        if (!resteAujourdhui || liste.length < 1000) break;
      }
    }

    // ── 2. Fiches statuées aujourd'hui (traite_le / traite_par, toutes listes non archivées) ──
    const listes = await sql`SELECT entreprises FROM listes WHERE archivee = FALSE`;
    for (const l of listes) {
      for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
        if (!e.traite_le || !e.traite_par || !stats[e.traite_par]) continue;
        if (new Date(e.traite_le) >= debutJour) stats[e.traite_par].statuees++;
      }
    }

    // ── 3. RDV du jour (bloc-notes) ──
    try {
      const rdvs = await sql`SELECT auteur, COUNT(*)::int AS n FROM activites
        WHERE source = 'rdv' AND ts >= ${debutJour.toISOString()} GROUP BY auteur`;
      for (const r2 of rdvs) if (r2.auteur && stats[r2.auteur]) stats[r2.auteur].rdv = r2.n;
    } catch (_) {}

    // ── 4. Snapshot + bilan Slack ──
    let enregistres = 0, bilans = 0;
    for (const u of sdrs) {
      const s = stats[u.nom];
      if (!s.appels && !s.statuees && !s.rdv) continue; // journée sans activité : rien à consigner
      await sql`INSERT INTO journees_sdr (sdr, jour, debut, fin, appels, decroches, duree_sec, statuees, rdv)
        VALUES (${u.nom}, ${jourISO}, ${s.debut}, ${s.fin}, ${s.appels}, ${s.decroches}, ${s.duree}, ${s.statuees}, ${s.rdv})
        ON CONFLICT (sdr, jour) DO UPDATE SET debut = EXCLUDED.debut, fin = EXCLUDED.fin,
          appels = EXCLUDED.appels, decroches = EXCLUDED.decroches, duree_sec = EXCLUDED.duree_sec,
          statuees = EXCLUDED.statuees, rdv = EXCLUDED.rdv`;
      enregistres++;

      if (!u.slack_id) continue;
      // Comparaison vs moyenne des 7 derniers jours consignés (hors aujourd'hui)
      let moy = null, maxAppels7 = 0;
      try {
        const [m] = await sql`SELECT ROUND(AVG(appels))::int AS appels, ROUND(AVG(rdv)*10)/10 AS rdv, MAX(appels)::int AS max_appels
          FROM journees_sdr WHERE sdr = ${u.nom} AND jour < ${jourISO} AND jour >= ${jourISO}::date - 7`;
        if (m && m.appels != null) { moy = m; maxAppels7 = m.max_appels || 0; }
      } catch (_) {}
      const taux = s.appels ? Math.round(s.decroches / s.appels * 100) : 0;
      const dAppels = moy ? s.appels - moy.appels : null;
      const lignes = [
        `🌇 *Bilan du jour — ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}*`,
        `📞 ${s.appels} appel${s.appels > 1 ? 's' : ''} · ${s.decroches} décroché${s.decroches > 1 ? 's' : ''} (${taux} %) · ${fmtDuree(s.duree)} en ligne`,
        `✅ ${s.statuees} fiche${s.statuees > 1 ? 's' : ''} statuée${s.statuees > 1 ? 's' : ''}${s.rdv ? ` · 🏆 ${s.rdv} RDV pris` : ''}`
      ];
      if (dAppels !== null && dAppels !== 0) lignes.push(`📈 vs ta moyenne 7 j : ${dAppels > 0 ? '+' : ''}${dAppels} appel${Math.abs(dAppels) > 1 ? 's' : ''}`);
      if (maxAppels7 && s.appels > maxAppels7) lignes.push('🔥 Meilleure journée d’appels de la semaine !');
      await envoyerDM(u.slack_id, lignes.join('\n'));
      bilans++;
    }

    return res.status(200).json({ ok: true, jour: jourISO, sdrs_actifs: sdrs.length, journees_enregistrees: enregistres, bilans_slack: bilans });
  } catch (e) {
    return res.status(500).json({ erreur: 'Journal des journées en échec', detail: String(e.message || e).slice(0, 200) });
  }
}
