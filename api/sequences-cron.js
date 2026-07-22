// /api/sequences-cron.js — Séquences par température : plus aucun lead travaillé ne meurt en silence.
// Cron quotidien (06:00 UTC lun-ven). Scanne les listes ACTIVES avec sequences_auto (défaut ON) et
// bascule automatiquement en séquence Lemlist (campagne du produit dominant — V1 partagée) :
//   ❄️ FROID : statut « Pas de réponse / Message vocal laissé / Absent » ET ≥ 3 tentatives
//              (1 statut + rappels effectués) → outbound produit.
//   🌡️ TIÈDE : « Demande email / envoyer doc » (immédiat) OU « Rappel demandé / occupé » resté
//              sans suite 7 jours (aucun rappel en attente) → même campagne (V1), variable temperature.
// Jamais basculé : leads déjà en séquence (lemlist_envoye), déjà HubSpot, ayant réagi (types STOP),
// sans email. Garde-fous : plafond Lemlist 50/SDR/24 h (partagé avec les envois manuels), plafond
// global 100/run. Chaque bascule : lead poussé avec les MÊMES variables que l'envoi manuel
// (accroche + email IA inclus), activité sequenceAdded + note « ✈️ Séquence auto » au bloc-notes,
// flag e.sequence_auto sur la fiche. DM Slack récapitulatif par SDR.

import { sql, ensureSchema } from './db.js';

export const config = { maxDuration: 300 };

const PLAFOND_JOUR = parseInt(process.env.LEMLIST_PLAFOND_JOUR || '50', 10);
const PLAFOND_RUN = 100;
const STATUTS_FROID = ['Pas de réponse', 'Message vocal laissé', 'Absent'];
const TYPES_STOP = ['warmed', 'emailsReplied', 'linkedinReplied', 'whatsappReplied', 'smsReplied',
  'interested', 'emailsInterested', 'linkedinInterested', 'aircallInterested', 'apiInterested', 'manualInterested',
  'notInterested', 'emailsNotInterested', 'linkedinNotInterested', 'aircallNotInterested', 'apiNotInterested', 'manualNotInterested',
  'emailsUnsubscribed', 'stopped'];

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

// Produit dominant du score IA (mêmes clés que produitDominant() côté front)
function produitDominant(e) {
  const s = e.score && e.score.scores;
  if (!s) return null;
  const m = [['soview', s.soview], ['soconnect', s.soconnect], ['soreach', s.soreach]].sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
  return (m && m[1]) ? m[0] : null;
}

// Variables de campagne — miroir de varsLemlist() côté front (les templates restent compatibles)
function varsDe(e, c, temperature) {
  const g = e.gmb || {}, sc = e.score || {};
  const prod = produitDominant(e);
  return {
    companyName: e.enseigne_ia || e.enseigne || e.nom,
    phone: (c.enrich && c.enrich.telephone) || g.telephone || '',
    linkedinUrl: (c.enrich && c.enrich.linkedin) || '',
    gmb_note: g.trouve ? String(g.note_moyenne) : '',
    gmb_pire_fiche: g.trouve && g.pire_fiche ? `${g.pire_fiche.nom} (${g.pire_fiche.note}★)` : '',
    avis_negatif: g.avis_negatif ? String(g.avis_negatif.texte || '').slice(0, 180) : '',
    gmb_concurrents: g.concurrents ? String(g.concurrents.note_moyenne) : '',
    produit_score: prod ? `${prod} ${sc.scores[prod]}` : '',
    accroche: sc.accroche || '',
    objet_perso: sc.email ? sc.email.objet : '',
    email_perso: sc.email ? sc.email.corps : '',
    temperature
  };
}

// Pousse le lead dans la campagne (upsert contact + PATCH puis POST — même mécanique que api/lemlist.js)
async function pousserLemlist(apiKey, campagne, email, prenom, nom, variables, ownerEmail) {
  const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64');
  const headers = { 'Content-Type': 'application/json', 'Authorization': auth };
  const snEid = Buffer.from(String(email).trim().toLowerCase()).toString('base64');
  const brut = { firstName: prenom || '', lastName: nom || '', ...variables, snEid, ...(ownerEmail ? { contactOwner: ownerEmail } : {}) };
  const corps = {};
  for (const [k, v] of Object.entries(brut)) {
    if (v === null || v === undefined || v === '') continue;
    corps[k] = (typeof v === 'string') ? v : String(v);
  }
  const { contactOwner, ...corpsMaj } = corps;

  try {
    const contactBody = { email };
    if (prenom) contactBody.firstName = prenom;
    if (nom) contactBody.lastName = nom;
    if (variables.companyName) contactBody.companyName = variables.companyName;
    if (variables.phone) contactBody.phone = variables.phone;
    if (ownerEmail) contactBody.contactOwner = ownerEmail;
    await fetch('https://api.lemlist.com/api/contacts', { method: 'POST', headers, body: JSON.stringify(contactBody) });
  } catch (_) {}

  const url = `https://api.lemlist.com/api/campaigns/${encodeURIComponent(campagne)}/leads/${encodeURIComponent(email)}`;
  let rep = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(corpsMaj) });
  if (rep.ok) return { ok: true, maj: true };
  rep = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corps) });
  if (!rep.ok) {
    const txt = await rep.text().catch(() => '');
    if (/owner/i.test(txt || '')) {
      rep = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corpsMaj) });
      if (rep.ok) return { ok: true, ajoute: true };
    }
    return { ok: false, status: rep.status };
  }
  return { ok: true, ajoute: true };
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
  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, info: 'LEMLIST_API_KEY manquante' });
  // ?dry=1 : simulation — compte les leads qui basculeraient, sans rien envoyer ni écrire
  const dry = req.query && req.query.dry === '1';
  await ensureSchema();

  try {
    // Config campagnes (⚙️ Envois) — sans campagne configurée, on ne fait rien
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'lemlist'`;
    const cfg = cfgRows.length ? cfgRows[0].valeur : {};
    if (!cfg.camp_defaut && !cfg.camp_soview && !cfg.camp_soconnect && !cfg.camp_soreach) {
      return res.status(200).json({ ok: false, info: 'Aucune campagne Lemlist configurée dans ⚙️ Envois' });
    }

    // Quota restant par SDR (plafond partagé avec les envois manuels) + infos SDR
    const quota = {}, ownerEmails = {}, slackIds = {};
    const us = await sql`SELECT nom, email_envoi, slack_id FROM sdrs WHERE actif = TRUE`;
    for (const u of us) { quota[u.nom] = PLAFOND_JOUR; ownerEmails[u.nom] = u.email_envoi || null; slackIds[u.nom] = u.slack_id || null; }
    try {
      const q = await sql`SELECT auteur, COUNT(*)::int AS n FROM activites
        WHERE type = 'sequenceAdded' AND ts > NOW() - INTERVAL '24 hours' GROUP BY auteur`;
      for (const r of q) if (r.auteur && quota[r.auteur] !== undefined) quota[r.auteur] = Math.max(0, PLAFOND_JOUR - r.n);
    } catch (_) {}

    const il7j = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE archivee = FALSE AND (statut IS NULL OR statut = 'active')
        AND (sequences_auto IS NULL OR sequences_auto = TRUE)
      ORDER BY id ASC`;

    let total = 0;
    const parSdr = {}; // nom -> {froid, tiede, produits:{}}
    for (const l of listes) {
      if (total >= PLAFOND_RUN) break;
      const ents = Array.isArray(l.entreprises) ? l.entreprises : [];
      let modifie = false;

      // Candidats de la liste (pré-filtre sans requête)
      const candidats = [];
      for (const e of ents) {
        if (e.lemlist_envoye || e.sequence_auto || e.deja_hubspot || e.dedup_hubspot || e.skip_enrich) continue;
        const statut = e.statut_appel || (e.tags_sdr || [])[0] || null;
        if (!statut) continue;
        const c = (e.contacts || []).find(x => x && x.enrich && x.enrich.email);
        if (!c) continue;
        const email = String(c.enrich.email).toLowerCase();
        let temperature = null;
        if (STATUTS_FROID.includes(statut)) temperature = 'froid';
        else if (statut === 'Demande email / envoyer doc') temperature = 'tiede';
        else if (statut === 'Rappel demandé / occupé' && e.traite_le && new Date(e.traite_le) < il7j) temperature = 'tiede_rappel';
        if (!temperature) continue;
        candidats.push({ e, c, email, statut, temperature });
      }
      if (!candidats.length) continue;

      // Requêtes groupées : réactions STOP + tentatives (rappels faits/pendants)
      const emails = candidats.map(x => x.email);
      const stops = new Set();
      const rappels = {};
      try {
        const sr = await sql`SELECT DISTINCT lower(fiche_cle) AS e FROM activites
          WHERE lower(fiche_cle) = ANY(${emails}) AND type = ANY(${TYPES_STOP})`;
        for (const r of sr) stops.add(r.e);
        const tr = await sql`SELECT lower(fiche_cle) AS e,
          COUNT(*) FILTER (WHERE faite)::int AS faits, COUNT(*) FILTER (WHERE NOT faite)::int AS pendants
          FROM taches WHERE lower(fiche_cle) = ANY(${emails}) GROUP BY lower(fiche_cle)`;
        for (const r of tr) rappels[r.e] = r;
      } catch (_) {}

      for (const cand of candidats) {
        if (total >= PLAFOND_RUN) break;
        if ((quota[l.sdr] || 0) <= 0) break;
        if (stops.has(cand.email)) continue;
        const rp = rappels[cand.email] || { faits: 0, pendants: 0 };
        if (cand.temperature === 'froid' && (1 + rp.faits) < 3) continue;      // 3 tentatives : 1 statut + 2 rappels effectués
        if (cand.temperature === 'tiede_rappel' && rp.pendants > 0) continue;  // un rappel est encore programmé → le cockpit gère
        const temperature = cand.temperature === 'tiede_rappel' ? 'tiede' : cand.temperature;

        const produit = produitDominant(cand.e) || 'generique';
        const campagne = cfg['camp_' + produit] || cfg.camp_defaut;
        if (!campagne) continue;

        if (dry) {
          // Simulation : on compte sans envoyer ni écrire
          total++;
          quota[l.sdr] = (quota[l.sdr] || 0) - 1;
          const sd = parSdr[l.sdr] = parSdr[l.sdr] || { froid: 0, tiede: 0, produits: {} };
          sd[temperature === 'froid' ? 'froid' : 'tiede']++;
          sd.produits[produit] = (sd.produits[produit] || 0) + 1;
          continue;
        }

        const r = await pousserLemlist(apiKey, campagne, cand.email, cand.c.prenom, cand.c.nom,
          varsDe(cand.e, cand.c, temperature), ownerEmails[l.sdr] || null);
        if (!r.ok) continue;

        cand.e.lemlist_envoye = true;
        cand.e.sequence_auto = { date: new Date().toISOString(), temperature, produit };
        modifie = true; total++;
        quota[l.sdr] = (quota[l.sdr] || 0) - 1;
        const s = parSdr[l.sdr] = parSdr[l.sdr] || { froid: 0, tiede: 0, produits: {} };
        s[temperature === 'froid' ? 'froid' : 'tiede']++;
        s.produits[produit] = (s.produits[produit] || 0) + 1;

        // Traces : sequenceAdded (plafond + timeline) + note lisible au bloc-notes
        try {
          await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ref, ts)
            VALUES (${cand.email}, 'lemlist', 'sequenceAdded', ${'Envoye vers Lemlist (' + produit + ')'}, ${varsDe(cand.e, cand.c, temperature).companyName || null}, ${l.sdr}, ${'add:' + cand.email + ':' + produit}, NOW())
            ON CONFLICT (ref) DO NOTHING`;
          const titreNote = '✈️ Séquence auto (' + (temperature === 'froid' ? 'froide' : 'tiède') + ')';
          const detailNote = (temperature === 'froid' ? (1 + rp.faits) + ' tentative(s) d\'appel sans réponse' : 'Statut « ' + cand.statut + ' » resté sans suite') + ' → campagne ' + produit;
          await sql`INSERT INTO activites (fiche_cle, source, type, titre, detail, auteur, ts)
            VALUES (${cand.email}, 'sequence', 'sequence_auto', ${titreNote}, ${detailNote}, 'système', NOW())`;
        } catch (_) {}
      }

      if (modifie) {
        try {
          await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${l.id}`;
        } catch (_) {}
      }
    }

    if (dry) return res.status(200).json({ ok: true, simulation: true, listes_scannees: listes.length, basculeraient: total, par_sdr: parSdr });

    // DM Slack récapitulatif par SDR
    let bilans = 0;
    for (const [nom, s] of Object.entries(parSdr)) {
      if (!slackIds[nom]) continue;
      const prods = Object.entries(s.produits).map(([p, n]) => `${p} ${n}`).join(' · ');
      await envoyerDM(slackIds[nom], `🌙 *Séquences auto* — ${s.froid + s.tiede} lead${(s.froid + s.tiede) > 1 ? 's' : ''} basculé${(s.froid + s.tiede) > 1 ? 's' : ''} en séquence email cette nuit\n❄️ ${s.froid} non joint${s.froid > 1 ? 's' : ''} (3 tentatives) · 🌡️ ${s.tiede} tiède${s.tiede > 1 ? 's' : ''}\nCampagnes : ${prods}\n💡 Ils réapparaîtront dans « Ma journée » dès qu'ils réagissent.`);
      bilans++;
    }

    return res.status(200).json({ ok: true, listes_scannees: listes.length, bascules: total, par_sdr: parSdr, bilans_slack: bilans });
  } catch (e) {
    return res.status(500).json({ erreur: 'Séquences auto en échec', detail: String(e.message || e).slice(0, 200) });
  }
}
