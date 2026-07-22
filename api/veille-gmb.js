// /api/veille-gmb.js — Veille e-réputation : re-lit la note Google des fiches des listes en
// VEILLE ou NURTURING (~1×/mois par fiche, lissé) et alerte le SDR quand la note décroche.
// C'est le signal d'achat Soview par excellence : on prospecte au moment exact de la douleur.
//
// Déclencheurs : note -0,2★ ou plus · nouveaux avis qui font baisser la note · passage sous 4,0★.
// Actions : DM Slack au SDR (avant→après + lien profond fiche) + e.signal_gmb (badge fiche)
//           + trace au bloc-notes (si email connu) + rafraîchissement de e.gmb (note/avis à jour).
//
// Cron Vercel quotidien (03:00), plafond PLAFOND_FICHES fiches/jour (Place Details rating ≈ 0,005 $)
// → conso journalisée sous le pseudo-SDR 'veille-gmb' (n'impacte pas les quotas des SDR).

import { sql, ensureSchema } from './db.js';

export const config = { maxDuration: 120 };

const PLAFOND_FICHES = 40;          // fiches entreprises re-vérifiées par exécution
const INTERVALLE_JOURS = 30;        // fréquence de re-lecture par fiche
const SEUIL_BAISSE = 0.2;           // baisse de note qui déclenche l'alerte

const APP_URL = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');

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

// Relit note + nb d'avis d'une fiche Google (Place Details, champs Atmosphere uniquement)
async function lirePlace(placeId, key) {
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total&language=fr&key=${key}`);
    const d = await r.json().catch(() => null);
    if (!d || d.status !== 'OK' || !d.result) return null;
    return { note: d.result.rating ?? null, avis: d.result.user_ratings_total ?? 0 };
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  const estCron = req.headers['x-vercel-cron'] || (req.query && req.query.cron_secret === process.env.PHANTOMBUSTER_CRON_SECRET);
  if (!estCron) {
    try {
      const { verifierToken } = await import('./db.js');
      const user = verifierToken(req);
      if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    } catch (_) { return res.status(401).json({ erreur: 'Non autorisé' }); }
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'GOOGLE_PLACES_API_KEY manquante' });
  await ensureSchema();

  const maintenant = new Date();
  const limite = new Date(Date.now() - INTERVALLE_JOURS * 24 * 3600 * 1000);
  let verifiees = 0, alertes = 0, appelsPlaces = 0;

  try {
    // Slack ID par SDR (pour les DM)
    const slackParSdr = {};
    try {
      const us = await sql`SELECT nom, slack_id FROM sdrs WHERE slack_id IS NOT NULL AND slack_id <> ''`;
      for (const u of us) slackParSdr[u.nom] = u.slack_id;
    } catch (_) {}

    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE archivee = FALSE AND (veille = TRUE OR statut = 'nurturing')
      ORDER BY id ASC`;

    for (const l of listes) {
      if (verifiees >= PLAFOND_FICHES) break;
      const ents = Array.isArray(l.entreprises) ? l.entreprises : [];
      let modifie = false;

      for (const e of ents) {
        if (verifiees >= PLAFOND_FICHES) break;
        const g = e.gmb;
        if (!g || !g.trouve) continue;
        const places = (g.fiches || []).filter(f => f && f.place_id).slice(0, 5);
        if (!places.length) continue;
        if (e.gmb_veille && e.gmb_veille.ts && new Date(e.gmb_veille.ts) > limite) continue; // déjà vérifiée ce mois-ci

        // Référence = dernier relevé de veille, sinon l'état au moment de l'enrichissement
        const base = {
          note: (e.gmb_veille && e.gmb_veille.note) ?? g.note_moyenne,
          avis: (e.gmb_veille && e.gmb_veille.avis) ?? g.total_avis
        };

        // Re-lecture de chaque fiche Google, puis moyenne pondérée (même calcul que api/gmb.js)
        let totalAvis = 0, somme = 0, lues = 0;
        for (const f of places) {
          const p = await lirePlace(f.place_id, key);
          appelsPlaces++;
          if (!p || p.note == null) continue;
          lues++;
          f.note = p.note; f.nb_avis = p.avis;
          totalAvis += p.avis; somme += p.note * p.avis;
        }
        verifiees++;
        if (!lues || !totalAvis) { e.gmb_veille = { ts: maintenant.toISOString(), note: base.note, avis: base.avis }; modifie = true; continue; }

        const nNote = Math.round(somme / totalAvis * 10) / 10;
        const nAvis = totalAvis;
        e.gmb_veille = { ts: maintenant.toISOString(), note: nNote, avis: nAvis };
        g.note_moyenne = nNote; g.total_avis = nAvis; // la fiche reste fraîche
        modifie = true;

        // ── Déclencheurs ──
        const baisse = (typeof base.note === 'number') && (nNote <= base.note - SEUIL_BAISSE);
        const negatifsRecents = (typeof base.avis === 'number') && nAvis > base.avis && typeof base.note === 'number' && nNote < base.note;
        const sous4 = (typeof base.note === 'number') && base.note >= 4 && nNote < 4;
        if (!(baisse || negatifsRecents || sous4)) continue;

        alertes++;
        const delta = (typeof base.note === 'number') ? (Math.round((nNote - base.note) * 10) / 10) : null;
        const nouveaux = (typeof base.avis === 'number') ? Math.max(0, nAvis - base.avis) : 0;
        e.signal_gmb = {
          date: maintenant.toISOString(), type: sous4 ? 'sous_4' : 'note_baisse',
          avant: base.note, apres: nNote, nouveaux_avis: nouveaux
        };

        // DM Slack au SDR de la liste
        const cle = ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || '');
        const lien = `${APP_URL}/?liste=${l.id}&fiche=${encodeURIComponent(cle)}`;
        const nom = e.enseigne_ia || e.enseigne || e.nom;
        const tel = (g.telephone || (e.enrich && e.enrich.telephone)) ? `\n☎️ ${g.telephone || e.enrich.telephone} — appelle pendant que ça fait mal` : '';
        const txt = `📉 *Signal Soview — la note Google de ${nom} décroche*\n⭐ ${String(base.note).replace('.', ',')} → ${String(nNote).replace('.', ',')}${nouveaux ? ` (+${nouveaux} avis récents)` : ''}${sous4 ? ' · passe SOUS les 4,0★' : ''}\nListe : ${l.nom}${tel}\n👉 Ouvre la fiche : ${lien}`;
        if (slackParSdr[l.sdr]) await envoyerDM(slackParSdr[l.sdr], txt);

        // Trace au bloc-notes (si un email est connu sur la fiche)
        try {
          const email = ((e.contacts || []).find(c => c && c.enrich && c.enrich.email) || {}).enrich?.email || (e.enrich && e.enrich.email) || null;
          if (email) await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
            VALUES (${String(email).toLowerCase()}, 'signal', 'gmb_baisse', '📉 Note Google en baisse',
              ${'⭐ ' + base.note + ' → ' + nNote + (nouveaux ? ' (+' + nouveaux + ' avis)' : '')}, 'veille-gmb', NOW())`;
        } catch (_) {}
      }

      if (modifie) {
        try { await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${l.id}`; } catch (_) {}
      }
    }

    // Conso Google Places journalisée sous 'veille-gmb' (hors quotas SDR)
    if (appelsPlaces) {
      try { await sql`INSERT INTO consommations (sdr, api, quantite) VALUES ('veille-gmb', 'google_places', ${appelsPlaces})`; } catch (_) {}
    }

    return res.status(200).json({ ok: true, listes: listes.length, fiches_verifiees: verifiees, alertes, appels_places: appelsPlaces });
  } catch (e) {
    return res.status(500).json({ erreur: 'Veille GMB en échec', detail: String(e.message || e).slice(0, 200) });
  }
}
