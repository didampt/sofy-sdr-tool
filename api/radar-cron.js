// /api/radar-cron.js — 📰 Alimente le radar des hot leads « visite du site », puis prévient Slack.
//
// Pourquoi un cron et pas le webhook Snitcher : le radar prend 20 à 40 s (5 à 6 recherches web).
// Le faire dans le webhook, c'est risquer un timeout côté Snitcher et des doublons de signaux.
// Ici, la visite est signalée immédiatement par le webhook, et le contexte arrive dans les 10 min
// qui suivent — très en dessous du SLA de 2 h des hot leads.
//
// GET (cron ou superadmin) : radarise jusqu'à 5 entreprises non encore couvertes, puis poste
// une seule alerte Slack par entreprise avec l'accroche prête à dire.
// ?dry=1 → montre la file sans rien dépenser · ?max=N → change le lot · ?heures=N → fenêtre

import { verifierToken, sql, ensureSchema } from './db.js';
import { radarEntreprise, cleRadar } from './radar.js';

export const config = { maxDuration: 300 };

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default async function handler(req, res) {
  const estCron = !!req.headers['x-vercel-cron'] ||
    (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`);
  const user = estCron ? null : verifierToken(req);
  if (!estCron && (!user || !['admin', 'superadmin'].includes(user.role))) {
    return res.status(401).json({ erreur: 'Cron ou admin uniquement' });
  }
  const dry = (req.query || {}).dry === '1';
  const max = Math.max(1, Math.min(10, parseInt((req.query || {}).max || '5', 10) || 5));
  const heures = Math.max(2, Math.min(168, parseInt((req.query || {}).heures || '48', 10) || 48));

  try {
    await ensureSchema();
    // Les hot leads vivent dans la liste partagée « auto: hotleads »
    const [liste] = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' = 'hotleads' LIMIT 1`;
    if (!liste) return res.status(200).json({ ok: true, info: 'Aucune liste Hot Leads', traites: 0 });

    const arr = Array.isArray(liste.entreprises) ? liste.entreprises : [];
    const limite = Date.now() - heures * 3600000;
    // Périmètre demandé par Didier : visites du site uniquement, pas les likers LinkedIn
    const estVisite = e => {
      const t = String((e.signal && e.signal.type) || '').toLowerCase();
      if (t === 'linkedin' || t === 'manuel' || t === 'signup') return false;
      const src = String(e.source_hotlead || (e.signal && e.signal.source) || '').toLowerCase();
      return t === 'visite_site' || /snitcher|rb2b|sofy\.fr/.test(src);
    };
    const dateDe = e => new Date(e.date_visite || (e.signal && e.signal.date) || 0).getTime();

    const candidats = [];
    const vues = new Set();
    for (const e of arr) {
      if (!estVisite(e) || dateDe(e) < limite) continue;
      const cle = cleRadar({ site: e.site_web || (e.gmb && e.gmb.site_web), nom: e.nom, enseigne: e.enseigne_ia || e.enseigne });
      if (!cle || vues.has(cle)) continue;
      vues.add(cle);
      candidats.push({ cle, e });
    }

    // Déjà couvertes (< 30 j) : on ne repaie pas
    let dejaFaites = new Set();
    if (candidats.length) {
      try {
        const cles = candidats.map(c => c.cle);
        const rows = await sql`SELECT cle FROM radar_cache WHERE cle = ANY(${cles}) AND maj_le > NOW() - INTERVAL '30 days'`;
        dejaFaites = new Set(rows.map(r => r.cle));
      } catch (_) {}
    }
    const file = candidats.filter(c => !dejaFaites.has(c.cle));

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, fenetre_heures: heures,
        visites_trouvees: candidats.length, deja_couvertes: dejaFaites.size,
        a_radariser: file.length,
        file: file.slice(0, max).map(c => ({ entreprise: c.e.enseigne_ia || c.e.enseigne || c.e.nom, cle: c.cle })),
        info: 'Simulation — aucune recherche lancée, aucun coût.'
      });
    }

    const faits = [];
    for (const c of file.slice(0, max)) {
      const e = c.e;
      const out = await radarEntreprise({
        nom: e.nom, enseigne: e.enseigne_ia || e.enseigne, site: e.site_web || (e.gmb && e.gmb.site_web),
        ville: e.ville, cp: e.code_postal, secteur: e.secteur_rb2b || e.activite, effectif: e.effectif,
        pages: (e.pages_visitees && e.pages_visitees.length) ? e.pages_visitees : ((e.signal && e.signal.pages) || [])
      }, { nom: 'radar (cron)' }, { liste_id: liste.id });

      const nom = e.enseigne_ia || e.enseigne || e.nom;
      if (out.erreur) { faits.push({ entreprise: nom, erreur: out.erreur }); continue; }
      const r = out.radar || {};
      faits.push({ entreprise: nom, signaux: (r.signaux || []).length, rejetes: (r.signaux_rejetes || []).length, confiance: r.confiance });

      // Slack : uniquement quand il y a vraiment quelque chose à dire (sinon on ajoute du bruit)
      const hook = process.env.SLACK_WEBHOOK_URL;
      if (hook && (r.accroches || []).length) {
        const s0 = (r.signaux || [])[0] || {};
        const lignes = (r.signaux || []).slice(0, 3)
          .map(s => `${s.emoji || '·'} ${esc(s.titre)} — <${s.source_url}|${esc(s.media || 'source')}> · ${esc(s.date)}`).join('\n');
        const txt = [
          `📰 *Contexte trouvé — ${esc(nom)}*`,
          r.resume ? `_${esc(r.resume)}_` : '',
          lignes,
          `\n🗣 *Accroche :* « ${esc(r.accroches[0].texte)} »`,
          (r.a_eviter || []).length ? `⚠️ À éviter : ${esc(r.a_eviter[0])}` : '',
          `_${(r.signaux || []).length} signal(aux) sourcé(s) · confiance ${esc(r.confiance)} · vérifie la source avant d'appeler_`
        ].filter(Boolean).join('\n');
        try {
          await fetch(hook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: txt, unfurl_links: false })
          });
        } catch (_) {}
      }
    }

    return res.status(200).json({
      ok: true, fenetre_heures: heures, visites_trouvees: candidats.length,
      deja_couvertes: dejaFaites.size, restant_en_file: Math.max(0, file.length - faits.length),
      traites: faits.length, detail: faits
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Radar cron impossible', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
