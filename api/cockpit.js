// /api/cockpit.js — « Ma journée » : file de travail priorisée du SDR.
// GET (?sdr=Nom réservé admin — vue manager) →
//   { ok, sdr, chauds:[...], rappels:{retard,aujourdhui}, prospecter:[...], restants, bilan }
// 3 étages : signaux chauds 24 h (activites ALERTE) → rappels dus (taches) → fiches sans
// issue d'appel des listes ACTIVES du SDR, triées par score global (top 25).
// Tout est calculé à la lecture : aucune table nouvelle.

import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { maxDuration: 30 };

const ALERTE = ['warmed', 'emailsOpened', 'emailsClicked', 'emailsReplied', 'emailsInterested',
  'linkedinOpened', 'linkedinReplied', 'linkedinInviteAccepted', 'linkedinInterested',
  'whatsappReplied', 'smsReplied', 'interested', 'aircallInterested', 'manualInterested'];

const estMobileFr = t => /^(?:\+33|0033|0)\s*[67]/.test(String(t || '').replace(/[\s.\-()]/g, ''));

function telDe(e, c) {
  const tels = [c && c.enrich && c.enrich.telephone, e.enrich && e.enrich.telephone, e.gmb && e.gmb.telephone].filter(Boolean);
  return tels.find(estMobileFr) || tels[0] || null;
}

// Ligne d'angle affichée dans la file : produit dominant + état GMB (l'accroche d'appel en 5 mots)
function angleDe(e) {
  const s = e.score && e.score.scores;
  let produit = null;
  if (s) {
    const m = [['Soview', s.soview], ['SoConnect', s.soconnect], ['SoReach', s.soreach]].sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
    produit = (m && m[1]) ? m[0] : null;
  }
  const bouts = [];
  if (produit) bouts.push('Angle ' + produit);
  if (e.gmb && e.gmb.trouve && e.gmb.note != null) bouts.push(e.gmb.note + '★' + (e.gmb.nb_avis ? ' (' + e.gmb.nb_avis + ' avis)' : ''));
  else if (e.gmb && e.gmb.trouve === false) bouts.push('aucune fiche Google');
  return bouts.join(' · ') || null;
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  const admin = ['admin', 'superadmin'].includes(user.role);
  const sdr = (admin && req.query.sdr) ? String(req.query.sdr) : user.nom;

  try {
    const debutJour = new Date(); debutJour.setHours(0, 0, 0, 0);

    // ── Mode différé ?appels=1 : stats d'appels Ringover du jour pour ce SDR (chargées après le rendu) ──
    if (req.query.appels === '1') {
      const cleRing = process.env.RINGOVER_API_KEY;
      if (!cleRing) return res.status(200).json({ ok: true, appels: null });
      const cle9 = s => String(s || '').replace(/\D/g, '').slice(-9);
      const [srow] = await sql`SELECT email, ringover_numero FROM sdrs WHERE nom = ${sdr} LIMIT 1`;
      const emailSdr = (srow && srow.email) ? srow.email.toLowerCase().trim() : '';
      const numSdr = srow ? cle9(srow.ringover_numero) : '';
      let total = 0, decroches = 0, dureeSum = 0;
      for (let p = 0; p < 2; p++) {
        const r = await fetch(`https://public-api.ringover.com/v2/calls?limit_count=1000&limit_offset=${p * 1000}`, { headers: { 'Authorization': cleRing } });
        let dd = null; try { dd = await r.json(); } catch (_) {}
        const liste = (dd && dd.call_list) || [];
        if (!liste.length) break;
        let resteAujourdhui = false;
        for (const c of liste) {
          const ts = c.start_time ? new Date(c.start_time) : null;
          if (!ts || ts < debutJour) continue;
          resteAujourdhui = true;
          if (c.direction !== 'out') continue;
          const em = c.user && c.user.email ? c.user.email.toLowerCase().trim() : '';
          const ligne = cle9(c.from_number);
          if (!((emailSdr && em === emailSdr) || (numSdr && ligne === numSdr))) continue;
          total++;
          if (c.is_answered) { decroches++; dureeSum += (c.incall_duration || 0); }
        }
        if (!resteAujourdhui || liste.length < 1000) break;
      }
      return res.status(200).json({ ok: true, appels: {
        total, decroches, taux: total ? Math.round(decroches / total * 100) : 0,
        duree_moy_sec: decroches ? Math.round(dureeSum / decroches) : 0
      }});
    }

    // Objectifs du SDR (Paramètres) — défauts : 50 appels/jour, 20 RDV/mois
    let objAppels = 50, objRdv = 20;
    try {
      const [orow] = await sql`SELECT objectif_appels_jour, objectif_rdv_mois FROM sdrs WHERE nom = ${sdr} LIMIT 1`;
      if (orow) { if (orow.objectif_appels_jour) objAppels = orow.objectif_appels_jour; if (orow.objectif_rdv_mois) objRdv = orow.objectif_rdv_mois; }
    } catch (_) {}

    // Comparaisons : moyenne des 7 derniers jours consignés par journee-cron (journal automatique)
    let moy7 = null;
    try {
      const [m] = await sql`SELECT ROUND(AVG(appels))::int AS appels, ROUND(AVG(decroches))::int AS decroches,
        ROUND(AVG(statuees))::int AS statuees
        FROM journees_sdr WHERE sdr = ${sdr} AND jour < CURRENT_DATE AND jour >= CURRENT_DATE - 7`;
      if (m && m.appels != null) moy7 = m;
    } catch (_) {}

    // ── 1. Fiches des listes ACTIVES du SDR : index par email + candidates « à prospecter » ──
    const listeChoisie = parseInt(req.query.liste) || null; // « Ma prospection » filtrée sur UNE liste
    const listes = await sql`SELECT id, nom, stats, total, entreprises FROM listes
      WHERE archivee = FALSE AND (statut IS NULL OR statut = 'active') AND sdr = ${sdr}
        AND (criteres->>'auto' IS DISTINCT FROM 'hotleads')
      ORDER BY id DESC LIMIT 40`;
    // Listes créées mais jamais enrichies : invisibles de la file (ni score ni GMB) → on les signale
    const listesAEnrichir = listes
      .filter(l => (l.total || 0) > 0 && l.stats && (l.stats.pct_complete || 0) < 50)
      .map(l => ({ id: l.id, nom: l.nom, pct: (l.stats.pct_complete || 0) }))
      .slice(0, 3);
    const parEmail = new Map();
    const prospecter = [];
    const parListe = []; // sélecteur « Ma prospection » : {id, nom, total, restantes}
    let statueesJour = 0, traitees7j = 0;
    const il7j = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const debutHier = new Date(debutJour.getTime() - 24 * 3600 * 1000);
    let reprise = null; // liste la plus travaillée HIER et non finie → bannière « Reprendre ? »
    let lookalikeRef = null; // dernière fiche « RDV pris » : sert au bouton Lookalike de la bannière
    for (const l of listes) {
      let restantesL = 0, statueesHierL = 0;
      for (const e of (Array.isArray(l.entreprises) ? l.entreprises : [])) {
        const cle = ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || ''); // = cleSignal() côté front
        const cs = e.contacts || [];
        const c0 = cs.find(c => c && c.enrich && (c.enrich.telephone || c.enrich.email)) || cs[0] || null;
        const statut = e.statut_appel || (e.tags_sdr || [])[0] || null;
        if (statut && e.traite_le && new Date(e.traite_le) >= debutJour) statueesJour++;
        if (statut && e.traite_le && new Date(e.traite_le) >= il7j) traitees7j++;
        if ((statut === 'RDV pris' || statut === '🤝 RDV pris' || (e.tags_sdr || []).includes('🤝 RDV pris'))
            && (!lookalikeRef || (e.traite_le && (!lookalikeRef.traite_le || new Date(e.traite_le) > new Date(lookalikeRef.traite_le))))) {
          lookalikeRef = {
            nom: e.nom, enseigne: e.enseigne_ia || e.enseigne || null, activite: e.activite || null,
            gmb_categorie: (e.gmb && e.gmb.categorie) || null, naf: e.naf || null,
            effectif: e.effectif || null, code_postal: e.code_postal || '', traite_le: e.traite_le || null
          };
        }
        // Détail pour le panneau déplié du cockpit : tous les contacts + synthèse d'appel
        const contactsDetail = cs.filter(c => c && c.nom).slice(0, 5).map(c => ({
          nom: ((c.prenom || '') + ' ' + (c.nom || '')).trim(),
          prenom: c.prenom || '', nom_seul: c.nom || '',
          fonction: c.fonction || (c.enrich && c.enrich.fonction) || '',
          email: (c.enrich && c.enrich.email) || null,
          tel: (c.enrich && c.enrich.telephone) || null,
          linkedin: (c.enrich && c.enrich.linkedin) || null
        }));
        // Variables Lemlist prêtes à l'envoi (miroir de varsLemlist côté fiche) pour « ✈️ Séquence » du panneau
        const gV = e.gmb || {}, scV = e.score || {};
        const prodV = scV.scores ? ([['soview', scV.scores.soview], ['soconnect', scV.scores.soconnect], ['soreach', scV.scores.soreach]].sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]) : null;
        const varsLem = {
          companyName: e.enseigne_ia || e.enseigne || e.nom,
          gmb_note: gV.trouve ? String(gV.note_moyenne) : '',
          gmb_pire_fiche: gV.trouve && gV.pire_fiche ? `${gV.pire_fiche.nom} (${gV.pire_fiche.note}★)` : '',
          avis_negatif: gV.avis_negatif ? String(gV.avis_negatif.texte || '').slice(0, 180) : '',
          gmb_concurrents: gV.concurrents ? String(gV.concurrents.note_moyenne) : '',
          produit_score: (prodV && prodV[1]) ? `${prodV[0]} ${prodV[1]}` : '',
          accroche: scV.accroche || '',
          objet_perso: scV.email ? scV.email.objet : '',
          email_perso: scV.email ? scV.email.corps : ''
        };
        const emailCle = (cs.find(c => c && c.enrich && c.enrich.email) || {}).enrich;
        const info = {
          liste_id: l.id, liste_nom: l.nom, cle,
          nom: e.enseigne_ia || e.enseigne || e.nom, ville: e.ville || '',
          contact: c0 ? ((c0.prenom || '') + ' ' + (c0.nom || '')).trim() : '',
          fonction: (c0 && (c0.fonction || (c0.enrich && c0.enrich.fonction))) || '',
          tel: telDe(e, c0), statut, traite_le: e.traite_le || null,
          email_cle: (emailCle && emailCle.email) ? String(emailCle.email).toLowerCase() : ((e.enrich && e.enrich.email) ? String(e.enrich.email).toLowerCase() : null),
          tel_standard: (e.gmb && e.gmb.telephone) || null,
          accroche: (e.score && e.score.accroche) || null,
          synthese: (e.score && e.score.synthese) || null,
          contacts_detail: contactsDetail,
          vars: varsLem,
          produit_dominant: (prodV && prodV[1]) ? prodV[0] : null
        };
        for (const c of cs) if (c && c.enrich && c.enrich.email) parEmail.set(String(c.enrich.email).toLowerCase(), info);
        if (e.enrich && e.enrich.email) parEmail.set(String(e.enrich.email).toLowerCase(), info);
        if (statut && e.traite_le) { const t = new Date(e.traite_le); if (t >= debutHier && t < debutJour) statueesHierL++; }
        if (!statut && (e.score || (e.gmb && e.gmb.trouve))) {
          restantesL++;
          if (!listeChoisie || l.id === listeChoisie) prospecter.push({
            ...info,
            score: (e.score && e.score.scores && e.score.scores.global) || 0,
            angle: angleDe(e), contacts: contactsDetail.length
          });
        }
      }
      if ((l.total || 0) > 0) parListe.push({ id: l.id, nom: l.nom, total: l.total || 0, restantes: restantesL });
      if (restantesL > 0 && statueesHierL > 0 && (!reprise || statueesHierL > reprise._n)) {
        reprise = { id: l.id, nom: l.nom, restantes: restantesL, _n: statueesHierL };
      }
    }
    if (reprise) delete reprise._n;
    prospecter.sort((a, b) => b.score - a.score);
    const restants = listeChoisie ? prospecter.length : prospecter.length; // restants = périmètre affiché

    // ── Tuile HOT partagée : signaux de visite + signups (liste Hot Leads auto), claim « Je prends » ──
    let hot = [];
    try {
      const [hl] = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' = 'hotleads' LIMIT 1`;
      if (hl) {
        for (const e of (Array.isArray(hl.entreprises) ? hl.entreprises : [])) {
          const statutH = e.statut_appel || (e.tags_sdr || [])[0] || null;
          if (statutH) continue; // traité → sort de la tuile pour tout le monde
          const estSignup = !!(e.signup || (e.signal && e.signal.signup));
          if (!estSignup && !(e.signal_hot || e.signal || e.a_enrichir)) continue;
          if (e.pris_par && e.pris_par !== sdr) continue; // pris par un autre SDR
          const cleH = ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || '');
          const csH = e.contacts || [];
          const c0H = csH.find(c => c && c.enrich && (c.enrich.telephone || c.enrich.email)) || csH[0] || null;
          const emH = csH.find(c => c && c.enrich && c.enrich.email);
          hot.push({
            liste_id: hl.id, liste_nom: 'Hot Leads', cle: cleH,
            nom: e.enseigne_ia || e.enseigne || e.nom, ville: e.ville || '',
            contact: c0H ? ((c0H.prenom || '') + ' ' + (c0H.nom || '')).trim() : '',
            tel: telDe(e, c0H),
            email_cle: emH ? String(emH.enrich.email).toLowerCase() : null,
            type: estSignup ? 'signup' : 'visite',
            date: (e.signal && e.signal.date) || e.date_hotlead || null,
            pages: e.pages_visitees || (e.signal && e.signal.pages) || [],
            pris_par: e.pris_par || null,
            contacts_detail: csH.filter(c => c && c.nom).slice(0, 5).map(c => ({
              nom: ((c.prenom || '') + ' ' + (c.nom || '')).trim(), prenom: c.prenom || '', nom_seul: c.nom || '',
              fonction: c.fonction || (c.enrich && c.enrich.fonction) || '',
              email: (c.enrich && c.enrich.email) || null, tel: (c.enrich && c.enrich.telephone) || null,
              linkedin: (c.enrich && c.enrich.linkedin) || null
            }))
          });
        }
        hot.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        hot = hot.slice(0, 12);
      }
    } catch (_) {}

    // ── 2. Signaux chauds des dernières 24 h (dernier événement par lead, fiches non re-traitées depuis) ──
    let chauds = [];
    const emails = [...parEmail.keys()];
    if (emails.length) {
      const evs = await sql`SELECT DISTINCT ON (fiche_cle) fiche_cle, type, titre, ts FROM activites
        WHERE lower(fiche_cle) = ANY(${emails}) AND type = ANY(${ALERTE}) AND ts > NOW() - INTERVAL '24 hours'
        ORDER BY fiche_cle, ts DESC`;
      for (const ev of evs) {
        const f = parEmail.get(String(ev.fiche_cle).toLowerCase());
        if (!f) continue;
        if (f.traite_le && new Date(f.traite_le) > new Date(ev.ts)) continue; // déjà recontacté après le signal
        chauds.push({ ...f, signal: ev.titre || ev.type, signal_ts: ev.ts });
      }
      chauds.sort((a, b) => new Date(b.signal_ts) - new Date(a.signal_ts));
    }

    // ── 3. Rappels dus (en retard + aujourd'hui) ──
    const finJour = new Date(); finJour.setHours(23, 59, 59, 999);
    const tks = await sql`SELECT id, fiche_cle, entreprise_nom, contact_nom, description, date_rappel, liste_id
      FROM taches WHERE sdr = ${sdr} AND faite = FALSE AND date_rappel IS NOT NULL AND date_rappel <= ${finJour.toISOString()}
      ORDER BY date_rappel ASC LIMIT 60`;
    const rappels = { retard: [], aujourdhui: [], retenter: [] };
    const mtn = new Date();
    for (const t of tks) {
      const f = (t.fiche_cle && t.fiche_cle.includes('@')) ? parEmail.get(String(t.fiche_cle).toLowerCase()) : null;
      const r = {
        id: t.id, entreprise: t.entreprise_nom || (f && f.nom) || 'Fiche', contact: t.contact_nom || (f && f.contact) || '',
        description: t.description || '', date_rappel: t.date_rappel,
        liste_id: t.liste_id || (f && f.liste_id) || null, cle: f ? f.cle : null, tel: f ? f.tel : null,
        email_cle: f ? f.email_cle : (t.fiche_cle && t.fiche_cle.includes('@') ? String(t.fiche_cle).toLowerCase() : null),
        tel_standard: f ? f.tel_standard : null,
        accroche: f ? f.accroche : null, synthese: f ? f.synthese : null,
        contacts_detail: f ? f.contacts_detail : [],
        vars: f ? f.vars : null, produit_dominant: f ? f.produit_dominant : null
      };
      if ((t.description || '').includes('re-tentative auto')) { r._retard = new Date(t.date_rappel) < mtn; rappels.retenter.push(r); }
      else (new Date(t.date_rappel) < mtn ? rappels.retard : rappels.aujourdhui).push(r);
    }

    // ── 4. Bilan du jour + RDV du mois (vs objectif) ──
    let rdvJour = 0, rdvMois = 0;
    const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0, 0, 0, 0);
    try {
      const [r1] = await sql`SELECT
        COUNT(*) FILTER (WHERE ts >= ${debutJour.toISOString()})::int AS jour,
        COUNT(*)::int AS mois
        FROM activites WHERE source = 'rdv' AND auteur = ${sdr} AND ts >= ${debutMois.toISOString()}`;
      rdvJour = (r1 && r1.jour) || 0; rdvMois = (r1 && r1.mois) || 0;
    } catch (_) {}

    return res.status(200).json({
      ok: true, sdr,
      chauds: chauds.slice(0, 15),
      rappels,
      prospecter: prospecter.slice(0, 25),
      restants,
      bilan: { statuees_jour: statueesJour, rdv_jour: rdvJour, rdv_mois: rdvMois },
      objectifs: { appels_jour: objAppels, rdv_mois: objRdv },
      moy7,
      rythme_7j: Math.round(traitees7j / 7 * 10) / 10,
      lookalike_ref: lookalikeRef,
      listes_a_enrichir: listesAEnrichir,
      hot,
      par_liste: parListe,
      liste_choisie: listeChoisie,
      reprise
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Cockpit indisponible', detail: String(e.message || e).slice(0, 200) });
  }
}
