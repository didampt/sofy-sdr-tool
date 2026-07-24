// /api/listes.js — Mémoire des listes d'appel
// GET ?q=…           → historique (recherche par nom de liste ou SDR)
// GET ?id=…          → liste complète (pour la rouvrir)
// GET ?criteres=…    → listes existantes avec les MÊMES critères (anti-doublon)
// POST {…}           → sauvegarder une nouvelle liste
// PUT  {id, entreprises} → mettre à jour les entreprises (ex: après analyses GMB)
// PUT  {id, jobs}        → mémoriser les postes personas dans les critères de la liste

import { createHash } from 'crypto';
import { sql, ensureSchema, verifierToken } from './db.js';

function hashCriteres(criteres) {
  // Hash stable : on ne garde que les critères de ciblage (pas le nom de liste ni le SDR)
  const c = criteres || {};
  const cle = JSON.stringify({
    naf: [...(c.naf || [])].sort(),
    size: c.size || '',
    emp: Array.isArray(c.emp) ? [...c.emp].sort().join('+') : (c.emp || ''),
    ca: c.ca || '',
    jobs: [...(c.jobs || [])].sort(),
    pays: [...(c.pays || [])].sort(),
    ville: (c.ville || '').trim().toLowerCase()
  });
  return createHash('sha256').update(cle).digest('hex').slice(0, 32);
}

// #3+#4 Calcule les stats d'une liste à partir de ses entreprises (tags SDR) + score qualité 0-100
// F3 — Score des statuts d'appel (doit refléter STATUTS_APPEL côté front)
const SCORE_STATUT = {
  '🤝 RDV pris': 40,
  'Intéressé – RDV à prendre': 30,
  'Demande email / envoyer doc': 10,
  'Rappel demandé / occupé': 5,
  'Pas de réponse': 0, 'Message vocal laissé': 0, 'Barrage secrétaire / standard': 0,
  'Absent': 0, 'Connecté': 0, 'Hors prospection': 0,
  'Hors ICP / à requalifier': -10, 'Pas le bon contact / referral': -5, 'Non décisionnaire': -5,
  'Refus – timing / pas prioritaire': -5, 'Refus – concurrence': -10, 'Négatif (refus ferme)': -10,
  'Faux numéro': -15, 'Numéro perso – ne plus appeler': -15, 'Opt-out téléphone': -15
};
function calculerStatsListe(entreprises) {
  const ents = Array.isArray(entreprises) ? entreprises : [];
  const total = ents.length;
  if (!total) return null;
  let enrichies = 0, rdv = 0, fauxNum = 0, refus = 0, pasReponse = 0, traites = 0, sommeScore = 0;
  for (const e of ents) {
    const contacts = e.contacts || [];
    const aContact = contacts.some(c => (c.enrich && (c.enrich.email || c.enrich.telephone)));
    if (aContact || (e.gmb && e.gmb.trouve) || e.score) enrichies++;
    // Le statut d'appel = e.statut_appel (nouveau) ou le 1er tag (compat ancien + RDV pris)
    const statut = e.statut_appel || (e.tags_sdr || [])[0] || null;
    if (statut) {
      traites++;
      sommeScore += (SCORE_STATUT[statut] != null ? SCORE_STATUT[statut] : 0);
      if (statut === '🤝 RDV pris' || statut === 'Intéressé – RDV à prendre') rdv++;
      else if (statut === 'Faux numéro' || statut === 'Numéro perso – ne plus appeler' || statut === 'Opt-out téléphone') fauxNum++;
      else if (statut.indexOf('Refus') === 0 || statut === 'Négatif (refus ferme)') refus++;
      else if (statut === 'Pas de réponse' || statut === 'Message vocal laissé' || statut === 'Absent') pasReponse++;
    }
  }
  const pct = n => total ? Math.round(n / total * 100) : 0;
  // Score qualité basé sur les statuts. null si <30% de fiches traitées (pas assez de retours).
  const tauxTag = total ? traites / total : 0;
  // Le score est calculé dès qu'il y a des fiches traitées. L'affichage de la pastille
  // (seuil 100% traités) est géré côté front via pct_tag.
  let qualite = null;
  if (traites > 0) {
    qualite = Math.max(0, Math.min(100, Math.round(50 + sommeScore / traites)));
  }
  return {
    total,
    pct_complete: pct(enrichies),
    rdv,
    pct_mauvais_num: pct(fauxNum),
    pct_pas_interesse: pct(refus),
    pct_pas_reponse: pct(pasReponse),
    traites,
    pct_tag: pct(traites),
    qualite
  };
}

export default async function handler(req, res) {

  if (!sql) {
    return res.status(500).json({ erreur: 'Base de données non configurée — créer la base Neon dans Vercel (Storage) puis redéployer' });
  }
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  try {
    // ── Lecture ──
    if (req.method === 'GET') {
      const { id, q, criteres, archivees, migrer_stats } = req.query;

      // Migration ponctuelle (superadmin) : pré-remplir stats des listes qui n'en ont pas encore.
      // À lancer une fois après déploiement. Charge le JSON uniquement pour ces listes-là.
      if (migrer_stats === '1') {
        if (user.role !== 'superadmin') return res.status(403).json({ erreur: 'Réservé au superadmin' });
        const aMigrer = await sql`SELECT id, entreprises FROM listes WHERE stats IS NULL`;
        let n = 0;
        for (const l of aMigrer) {
          const st = calculerStatsListe(l.entreprises);
          await sql`UPDATE listes SET stats = ${JSON.stringify(st)} WHERE id = ${l.id}`;
          n++;
        }
        return res.status(200).json({ ok: true, migrees: n });
      }

      // ── Statistiques détaillées d'une liste (chargées au clic sur « Stats », visibles par tous) ──
      if (req.query.stats_detail) {
        const lid = parseInt(req.query.stats_detail);
        const rows = await sql`SELECT id, nom, total, entreprises, created_at FROM listes WHERE id = ${lid}`;
        if (!rows.length) return res.status(404).json({ erreur: 'Liste introuvable' });
        const l = rows[0];
        const ents = Array.isArray(l.entreprises) ? l.entreprises : [];
        const base = calculerStatsListe(ents) || { total: 0, traites: 0, pct_tag: 0, rdv: 0 };
        let enrichies = 0, avecEmail = 0;
        const emails = new Set();
        const cats = { positif: 0, rappel: 0, sans_reponse: 0, refus: 0, mauvais_num: 0, autres: 0 };
        for (const e of ents) {
          if (e.score || (e.gmb && e.gmb.trouve) || e.ia) enrichies++;
          let em = false;
          for (const c of (e.contacts || [])) if (c && c.enrich && c.enrich.email) { emails.add(String(c.enrich.email).toLowerCase()); em = true; }
          if (e.enrich && e.enrich.email) { emails.add(String(e.enrich.email).toLowerCase()); em = true; }
          if (em) avecEmail++;
          const s = e.statut_appel || (e.tags_sdr || [])[0] || null;
          if (!s) continue;
          if (s === '🤝 RDV pris' || s === 'Intéressé – RDV à prendre') cats.positif++;
          else if (s === 'Rappel demandé / occupé' || s === 'Demande email / envoyer doc') cats.rappel++;
          else if (s === 'Pas de réponse' || s === 'Message vocal laissé' || s === 'Absent' || s === 'Barrage secrétaire / standard') cats.sans_reponse++;
          else if (s.indexOf('Refus') === 0 || s === 'Négatif (refus ferme)') cats.refus++;
          else if (s === 'Faux numéro' || s === 'Numéro perso – ne plus appeler' || s === 'Opt-out téléphone') cats.mauvais_num++;
          else cats.autres++;
        }
        const arr = [...emails];
        let act = { pousses: 0, ouvertures: 0, reponses: 0, whatsapp: 0, sms_directs: 0, notes: 0, alertes: 0, premiere: null, derniere: null, jours: 0 };
        let rdvDates = [];
        if (arr.length) {
          try {
            const TYPES_REP = ['warmed', 'emailsReplied', 'linkedinReplied', 'whatsappReplied', 'smsReplied'];
            const [ag] = await sql`SELECT
              COUNT(DISTINCT fiche_cle) FILTER (WHERE type = 'sequenceAdded')::int AS pousses,
              COUNT(DISTINCT fiche_cle) FILTER (WHERE type IN ('emailsOpened','linkedinOpened','hooked'))::int AS ouvertures,
              COUNT(DISTINCT fiche_cle) FILTER (WHERE type = ANY(${TYPES_REP}))::int AS reponses,
              COUNT(*) FILTER (WHERE source = 'whatsapp')::int AS whatsapp,
              COUNT(*) FILTER (WHERE source = 'sms')::int AS sms_directs,
              COUNT(*) FILTER (WHERE source = 'note')::int AS notes,
              COUNT(*) FILTER (WHERE source = 'alerte')::int AS alertes,
              MIN(ts) AS premiere, MAX(ts) AS derniere,
              COUNT(DISTINCT ts::date)::int AS jours
              FROM activites WHERE lower(fiche_cle) = ANY(${arr})`;
            if (ag) act = ag;
            const rd = await sql`SELECT ts FROM activites WHERE lower(fiche_cle) = ANY(${arr}) AND source = 'rdv' ORDER BY ts ASC LIMIT 10`;
            rdvDates = rd.map(x => x.ts);
          } catch (_) {}
        }
        let tk = { faits: 0, pendants: 0 }, sp = { envoyes: 0, attente: 0 }, cout = 0;
        try {
          const [t1] = await sql`SELECT COUNT(*) FILTER (WHERE faite)::int AS faits, COUNT(*) FILTER (WHERE NOT faite)::int AS pendants FROM taches WHERE liste_id = ${lid}`;
          if (t1) tk = t1;
          const [s1] = await sql`SELECT COUNT(*) FILTER (WHERE statut = 'sent')::int AS envoyes, COUNT(*) FILTER (WHERE statut = 'pending')::int AS attente FROM sms_programmes WHERE liste_id = ${lid}`;
          if (s1) sp = s1;
          const [c1] = await sql`SELECT COALESCE(SUM(c.quantite * COALESCE(t.prix, 0)), 0)::float AS cout FROM consommations c LEFT JOIN tarifs t ON t.api = c.api WHERE c.liste_id = ${lid}`;
          if (c1) cout = Math.round((c1.cout || 0) * 100) / 100;
        } catch (_) {}
        return res.status(200).json({ ok: true, stats: {
          nom: l.nom, cree_le: l.created_at,
          total: base.total, traites: base.traites, pct_tag: base.pct_tag, rdv: base.rdv,
          enrichies, avec_email: avecEmail,
          pousses: act.pousses || 0, ouvertures: act.ouvertures || 0, reponses: act.reponses || 0,
          whatsapp: act.whatsapp || 0, sms_directs: act.sms_directs || 0, notes: act.notes || 0, alertes: act.alertes || 0,
          premiere_action: act.premiere || null, derniere_action: act.derniere || null, jours_actifs: act.jours || 0,
          rdv_dates: rdvDates,
          rappels_faits: tk.faits || 0, rappels_pendants: tk.pendants || 0,
          sms_envoyes: sp.envoyes || 0, sms_attente: sp.attente || 0,
          cout, categories: cats
        }});
      }

      if (id) {
        const rows = await sql`SELECT * FROM listes WHERE id = ${parseInt(id)}`;
        if (!rows.length) return res.status(404).json({ erreur: 'Liste introuvable' });
        // #3 Sécurité : un 'sdr' ne peut ouvrir QUE ses listes ou la liste Hot Leads auto
        const l = rows[0];
        const estAuto = l.criteres && l.criteres.auto === 'hotleads';
        const toutVoir = ['admin', 'superadmin'].includes(user.role);
        if (!toutVoir && l.sdr !== user.nom && !estAuto) {
          return res.status(403).json({ erreur: 'Cette liste appartient à un autre SDR' });
        }
        return res.status(200).json(l);
      }

      if (criteres) {
        let c;
        try { c = JSON.parse(criteres); } catch { return res.status(400).json({ erreur: 'criteres invalide' }); }
        const h = hashCriteres(c);
        const rows = await sql`SELECT id, nom, sdr, created_at FROM listes WHERE criteres_hash = ${h} ORDER BY created_at DESC LIMIT 3`;
        return res.status(200).json({ existantes: rows });
      }

      const recherche = (q || '').trim();
      // #3 Visibilité par rôle : un 'sdr' ne voit QUE ses listes + la liste Hot Leads auto ; admin/superadmin voient tout.
      const toutVoir = ['admin', 'superadmin'].includes(user.role);
      const moi = user.nom;
      // Filtres Historique : sdr_filtre (admin — vue par SDR/AE) + client (recherche dédiée dans les fiches)
      const clientQ = String(req.query.client || '').trim();
      const sdrF = toutVoir ? String(req.query.sdr_filtre || '').trim() : '';
      const like = '%' + recherche + '%';
      const likeClient = '%' + clientQ + '%';
      // Recherche par numéro : on compare les chiffres du terme au JSON débarrassé de ses espaces/ponctuation
      const digits = recherche.replace(/[^0-9]/g, '');
      const estNum = digits.length >= 4 && /^[0-9\s.()+\-]+$/.test(recherche);
      const likeDigits = '%' + digits + '%';
      // LIMIT 200 (avant : 50 tous statuts confondus → les vieilles archives devenaient introuvables).
      // ⚠️ La recherche matche les MÊMES champs que le filtre d'une liste ouverte (nom, enseigne,
      // ville, contacts, emails, téléphones) — plus jamais entreprises::text : le JSON contient les
      // synthèses/emails IA, « instant » matchait « en un instant » dans une liste sans rapport.
      const avecRecherche = recherche !== '' || clientQ !== '';
      const rows = avecRecherche
        ? await sql`SELECT id, nom, sdr, createur, archivee, statut, statut_depuis, stats, total, credits_estimes, criteres, created_at, veille, veille_fin, sequences_auto FROM listes
        WHERE (${toutVoir} OR sdr = ${moi} OR criteres->>'auto' = 'hotleads')
          AND (${recherche === ''} OR nom ILIKE ${like} OR sdr ILIKE ${like}
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(entreprises) AS fe
                 WHERE fe->>'nom' ILIKE ${like} OR fe->>'enseigne' ILIKE ${like} OR fe->>'enseigne_ia' ILIKE ${like}
                    OR fe->>'ville' ILIKE ${like} OR fe->>'site_web' ILIKE ${like}
                    OR (${estNum} AND regexp_replace(COALESCE(fe->'gmb'->>'telephone','') || COALESCE(fe->'ia'->>'telephone',''), '[^0-9]', '', 'g') ILIKE ${likeDigits})
                    OR EXISTS (
                      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fe->'contacts') = 'array' THEN fe->'contacts' ELSE '[]'::jsonb END) AS fc
                      WHERE (COALESCE(fc->>'prenom','') || ' ' || COALESCE(fc->>'nom','')) ILIKE ${like}
                         OR fc->>'fonction' ILIKE ${like}
                         OR fc->'enrich'->>'email' ILIKE ${like}
                         OR fc->'enrich'->>'linkedin' ILIKE ${like}
                         OR (${estNum} AND regexp_replace(COALESCE(fc->'enrich'->>'telephone',''), '[^0-9]', '', 'g') ILIKE ${likeDigits})
                    )
               ))
          AND (${clientQ === ''} OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(entreprises) AS fe
                 WHERE fe->>'nom' ILIKE ${likeClient} OR fe->>'enseigne' ILIKE ${likeClient} OR fe->>'enseigne_ia' ILIKE ${likeClient}
                    OR EXISTS (
                      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fe->'contacts') = 'array' THEN fe->'contacts' ELSE '[]'::jsonb END) AS fc
                      WHERE (COALESCE(fc->>'prenom','') || ' ' || COALESCE(fc->>'nom','')) ILIKE ${likeClient}
                    )
               ))
          AND (${sdrF === ''} OR sdr = ${sdrF})
        ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 200`
        : await sql`SELECT id, nom, sdr, createur, archivee, statut, statut_depuis, stats, total, credits_estimes, criteres, created_at, veille, veille_fin, sequences_auto FROM listes
        WHERE (${toutVoir} OR sdr = ${moi} OR criteres->>'auto' = 'hotleads')
          AND (${sdrF === ''} OR sdr = ${sdrF})
        ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 200`;
      // Récupérer les coûts par liste en une requête (table consommations)
      const ids = rows.map(r => r.id);
      let couts = {};
      if (ids.length) {
        try {
          const cr = await sql`SELECT c.liste_id, COALESCE(SUM(c.quantite * COALESCE(t.prix,0)),0) AS cout FROM consommations c LEFT JOIN tarifs t ON t.api = c.api WHERE c.liste_id = ANY(${ids}) GROUP BY c.liste_id`;
          cr.forEach(c => { couts[c.liste_id] = Number(c.cout) || 0; });
        } catch (_) {}
      }
      // Activité résiduelle par liste (nurturing) : rappels et SMS encore en attente
      const pendants = {};
      try {
        const tp = await sql`SELECT liste_id, COUNT(*)::int AS n FROM taches WHERE faite = FALSE AND liste_id IS NOT NULL GROUP BY liste_id`;
        for (const r of tp) pendants[r.liste_id] = { rappels: r.n, sms: 0 };
        const sp = await sql`SELECT liste_id, COUNT(*)::int AS n FROM sms_programmes WHERE statut = 'pending' AND liste_id IS NOT NULL GROUP BY liste_id`;
        for (const r of sp) { (pendants[r.liste_id] = pendants[r.liste_id] || { rappels: 0, sms: 0 }).sms = r.n; }
      } catch (_) {}
      // Stats déjà pré-calculées et stockées en base (colonne stats) → aucun gros JSON chargé.
      const voirArchivees = archivees === '1' || archivees === 'true';
      const listes = rows
        .filter(r => voirArchivees ? true : !r.archivee)
        .map(r => ({
          ...r, cout: couts[r.id] || 0, stats: r.stats || null,
          statut: r.statut || (r.archivee ? 'archivee' : 'active'),
          rappels_pendants: (pendants[r.id] || {}).rappels || 0,
          sms_pendants: (pendants[r.id] || {}).sms || 0
        }));
      return res.status(200).json({ listes });
    }

    // ── Sauvegarde ──
    if (req.method === 'POST') {
      const { nom, sdr, criteres, entreprises, credits_estimes } = req.body || {};
      if (!nom || !sdr || !criteres || !Array.isArray(entreprises)) {
        return res.status(400).json({ erreur: 'nom, sdr, criteres et entreprises requis' });
      }
      // Anti-doublon de nom : refuse une liste active portant déjà ce nom (insensible à la casse).
      // Protège contre le double-clic ET les doublons volontaires. Les listes archivées ne comptent pas.
      const memeNom = await sql`SELECT id FROM listes WHERE LOWER(TRIM(nom)) = ${nom.trim().toLowerCase()} AND archivee = FALSE LIMIT 1`;
      if (memeNom.length) {
        return res.status(409).json({ erreur: 'Une liste active porte déjà ce nom. Choisis un nom différent (ou archive l\'ancienne).' });
      }
      // Garde-fou anti-listes mortes : un SDR ne crée pas de nouvelle liste s'il a déjà 3 listes
      // actives enrichies à moins de 50 % (stats.pct_complete). Admin/superadmin passent outre.
      if (!['admin', 'superadmin'].includes(user.role)) {
        try {
          const actives = await sql`SELECT nom, stats, total FROM listes
            WHERE archivee = FALSE AND (statut IS NULL OR statut = 'active') AND sdr = ${sdr}`;
          const mortes = actives.filter(l => (l.total || 0) > 0 && l.stats && (l.stats.pct_complete || 0) < 50);
          if (mortes.length >= 3) {
            const detail = mortes.slice(0, 4).map(l => `« ${l.nom} » (${l.stats.pct_complete || 0} % enrichie)`).join(', ');
            return res.status(403).json({
              code: 'listes_non_enrichies',
              erreur: `Tu as déjà ${mortes.length} listes actives enrichies à moins de 50 % : ${detail}. Enrichis-les (🚀) ou archive-les avant d'en créer une nouvelle.`
            });
          }
        } catch (_) {}
      }
      const h = hashCriteres(criteres);
      const statsInit = calculerStatsListe(entreprises);
      const rows = await sql`INSERT INTO listes (nom, sdr, createur, criteres, criteres_hash, entreprises, total, credits_estimes, stats)
        VALUES (${nom}, ${sdr}, ${user.nom}, ${JSON.stringify(criteres)}, ${h}, ${JSON.stringify(entreprises)}, ${entreprises.length}, ${credits_estimes || 0}, ${JSON.stringify(statsInit)})
        RETURNING id, created_at`;
      // Rattache les crédits Pappers consommés à l'instant (extraction avant sauvegarde) à cette liste
      try {
        await sql`UPDATE consommations SET liste_id = ${rows[0].id}
                  WHERE sdr = ${user.nom} AND liste_id IS NULL AND api = 'pappers'
                    AND created_at > NOW() - INTERVAL '10 minutes'`;
      } catch (_) {}
      return res.status(200).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
    }

    // ── Mise à jour des entreprises (analyses GMB, enrichissements futurs) ──
    // ── Suppression définitive (réservé superadmin) ──
    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      if (user.role !== 'superadmin') {
        return res.status(403).json({ erreur: 'Seul le superadmin peut supprimer définitivement une liste' });
      }
      await sql`DELETE FROM listes WHERE id = ${parseInt(id)}`;
      return res.status(200).json({ ok: true, supprime: true });
    }

    if (req.method === 'PUT') {
      const { id, entreprises, veille, veille_jours, supprimees, nom, assigner_a, archiver } = req.body || {};
      if (!id) return res.status(400).json({ erreur: 'id requis' });
      if (Array.isArray(entreprises)) {
        const lid = parseInt(id);
        // Protection anti-disparition : pour la liste Hot Leads (auto), on FUSIONNE au lieu d'écraser.
        // Une fiche présente en base mais absente de l'envoi (race condition, webhook concurrent) est conservée.
        const cur = await sql`SELECT criteres, entreprises FROM listes WHERE id = ${lid}`;
        const estAuto = cur.length && cur[0].criteres && cur[0].criteres.auto === 'hotleads';
        if (estAuto) {
          const cleFiche = e => ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || '');
          const envoyees = new Map(entreprises.map(e => [cleFiche(e), e]));
          const base = cur[0].entreprises || [];
          // Repartir des fiches envoyées (à jour), puis rajouter celles de la base qui manquent
          const fusion = [...entreprises];
          const clesEnvoyees = new Set(entreprises.map(cleFiche));
          const clesSupprimees = new Set(Array.isArray(supprimees) ? supprimees : []);
          for (const eb of base) {
            const c = cleFiche(eb);
            // On conserve une fiche de la base SAUF si le front l'a explicitement supprimée
            if (!clesEnvoyees.has(c) && !clesSupprimees.has(c)) fusion.push(eb);
          }
          const fusionFinale = fusion.slice(0, 300);
          const statsAuto = calculerStatsListe(fusionFinale);
          await sql`UPDATE listes SET entreprises = ${JSON.stringify(fusionFinale)}, total = ${fusionFinale.length}, stats = ${JSON.stringify(statsAuto)} WHERE id = ${lid}`;
        } else {
          const statsMaj = calculerStatsListe(entreprises);
          await sql`UPDATE listes SET entreprises = ${JSON.stringify(entreprises)}, total = ${entreprises.length}, stats = ${JSON.stringify(statsMaj)} WHERE id = ${lid}`;
        }
      }
      // Personas : mémoriser les postes ciblés dans les critères (bouton 👥 sur une liste sans postes)
      if (Array.isArray(req.body.jobs)) {
        const lid = parseInt(id);
        const rows = await sql`SELECT criteres FROM listes WHERE id = ${lid}`;
        if (!rows.length) return res.status(404).json({ erreur: 'Liste introuvable' });
        const c = rows[0].criteres || {};
        c.jobs = req.body.jobs.filter(j => typeof j === 'string' && j.trim()).slice(0, 20);
        await sql`UPDATE listes SET criteres = ${JSON.stringify(c)} WHERE id = ${lid}`;
        return res.status(200).json({ ok: true, jobs: c.jobs });
      }
      // #2 Renommage d'une liste
      if (nom !== undefined && typeof nom === 'string' && nom.trim()) {
        await sql`UPDATE listes SET nom = ${nom.trim().slice(0, 120)} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, nom: nom.trim().slice(0, 120) });
      }
      // Transfert d'une liste à un autre SDR (réservé admin/superadmin)
      // ── Statuer UNE fiche depuis le cockpit (mise à jour chirurgicale du JSONB, sans recharger la liste) ──
      // PUT { id, fiche_cle, statut_appel } — fiche_cle = clé cleSignal() (signal.date + nom).
      if (req.body.fiche_cle !== undefined && (req.body.statut_appel !== undefined || req.body.marquer_lemlist === true || req.body.prendre === true
          || Array.isArray(req.body.ajouter_contacts) || (req.body.contact_enrich && typeof req.body.contact_enrich === 'object'))) {
        const rowsF = await sql`SELECT sdr, entreprises FROM listes WHERE id = ${parseInt(id)}`;
        if (!rowsF.length) return res.status(404).json({ erreur: 'Liste introuvable' });
        const adminF = ['admin', 'superadmin'].includes(user.role);
        if (!adminF && rowsF[0].sdr !== user.nom) return res.status(403).json({ erreur: 'Cette liste appartient à un autre SDR' });
        const entsF = Array.isArray(rowsF[0].entreprises) ? rowsF[0].entreprises : [];
        const cleDe = e => ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || '');
        const fiche = entsF.find(e => cleDe(e) === String(req.body.fiche_cle));
        if (!fiche) return res.status(404).json({ erreur: 'Fiche introuvable (liste modifiée entre-temps ?)' });
        const statutF = (req.body.statut_appel !== undefined) ? String(req.body.statut_appel || '').slice(0, 60) : null;
        const statutFourni = req.body.statut_appel !== undefined;
        // « Je prends » (tuile Hot Leads partagée) : verrou premier arrivé — 409 si déjà pris par un autre
        if (req.body.prendre === true) {
          if (fiche.pris_par && fiche.pris_par !== user.nom) {
            return res.status(409).json({ erreur: 'Déjà pris par ' + fiche.pris_par });
          }
          fiche.pris_par = user.nom;
          fiche.pris_le = new Date().toISOString();
          // Annonce au canal SDR : toute l'équipe voit que le hot lead est pris
          try {
            const hook = process.env.SLACK_WEBHOOK_URL;
            if (hook) {
              const estSignup = !!(fiche.signup || (fiche.signal && fiche.signal.signup));
              const type = estSignup ? 'signup' : ((fiche.pages_visitees && fiche.pages_visitees.length) ? 'visite ' + fiche.pages_visitees[0] : 'signal');
              await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `🔥 *${user.nom}* prend en charge « ${fiche.enseigne_ia || fiche.enseigne || fiche.nom} » (${type})` }) });
            }
          } catch (_) {}
        }
        // Refus – concurrence : mémorise QUI a pris le deal (stats pertes par concurrent + rappel dans 6 mois)
        if (req.body.concurrent) fiche.concurrent_perdu = { nom: String(req.body.concurrent).slice(0, 60), date: new Date().toISOString() };
        // Envoi Lemlist depuis le cockpit : marque la fiche (cohérence avec le flux fiche + sequences-cron)
        if (req.body.marquer_lemlist === true) fiche.lemlist_envoye = true;
        // 👥 Personas depuis le cockpit : ajout des contacts trouvés (dédup par prénom+nom, plafond 8)
        const normP = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
        let contactsAjoutes = 0;
        if (Array.isArray(req.body.ajouter_contacts)) {
          if (!Array.isArray(fiche.contacts)) fiche.contacts = [];
          for (const np of req.body.ajouter_contacts.slice(0, 6)) {
            if (!np || !np.nom) continue;
            if (fiche.contacts.length >= 8) break;
            const deja = fiche.contacts.some(c => c && normP(c.prenom) === normP(np.prenom) && normP(c.nom) === normP(np.nom));
            if (deja) continue;
            fiche.contacts.push({
              prenom: String(np.prenom || '').slice(0, 60), nom: String(np.nom).slice(0, 60),
              fonction: String(np.fonction || '').slice(0, 120), source: 'linkedin',
              enrich: np.linkedin ? { linkedin: String(np.linkedin).slice(0, 300), email: null, telephone: null, fonction: String(np.fonction || '').slice(0, 120), source: 'ia-personas', avec_domaine: false } : null
            });
            contactsAjoutes++;
          }
          fiche.personas_fait = true;
        }
        // ↻ Compléter (Lemlist) depuis le cockpit : complète email/téléphone d'un contact existant
        if (req.body.contact_enrich && typeof req.body.contact_enrich === 'object') {
          const ce = req.body.contact_enrich;
          const c = (fiche.contacts || []).find(x => x && normP(x.prenom) === normP(ce.prenom) && normP(x.nom) === normP(ce.nom));
          if (c) {
            if (!c.enrich) c.enrich = {};
            if (ce.email && !c.enrich.email) { c.enrich.email = String(ce.email).slice(0, 200); c.enrich.email_source = 'lemlist'; c.enrich.email_qualification = 'Lemlist'; }
            if (ce.telephone && !c.enrich.telephone) { c.enrich.telephone = String(ce.telephone).slice(0, 40); c.enrich.telephone_source = 'lemlist'; }
            if (ce.linkedin && !c.enrich.linkedin) c.enrich.linkedin = String(ce.linkedin).slice(0, 300);
            c.enrich.lemlist_fait = true;
          }
        }
        if (statutF) {
          fiche.statut_appel = statutF;
          fiche.tags_sdr = [statutF === 'RDV pris' ? '🤝 RDV pris' : statutF];
          fiche.traite_par = user.nom;
          fiche.traite_le = new Date().toISOString();
        } else if (statutFourni) {
          fiche.statut_appel = null;
          if (!(fiche.tags_sdr || []).includes('🤝 RDV pris')) { fiche.tags_sdr = []; fiche.traite_par = null; fiche.traite_le = null; }
        }
        const stF = calculerStatsListe(entsF);
        await sql`UPDATE listes SET entreprises = ${JSON.stringify(entsF)}, stats = ${JSON.stringify(stF)} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, statut_appel: fiche.statut_appel, stats: stF, contacts: fiche.contacts || [], contacts_ajoutes: contactsAjoutes });
      }

      if (assigner_a !== undefined && typeof assigner_a === 'string' && assigner_a.trim()) {
        if (!['admin', 'superadmin'].includes(user.role)) {
          return res.status(403).json({ erreur: 'Seuls les administrateurs peuvent transférer une liste' });
        }
        await sql`UPDATE listes SET sdr = ${assigner_a.trim()} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, assigne: assigner_a.trim() });
      }
      // ── Cycle de vie : active | nurturing | archivee ──
      // active    = le SDR travaille la liste
      // nurturing = SDR terminé, la MACHINE continue (séquences Lemlist, rappels, alertes,
      //             veille Snitcher activée 60 j) — la liste sort de la vue « En cours »
      // archivee  = terminal : rappels supprimés, SMS annulés, veille coupée
      // Rétro-compatible : l'ancien paramètre `archiver` est mappé sur statut.
      let statutCible = (typeof req.body.statut === 'string') ? req.body.statut : undefined;
      if (statutCible === undefined && archiver !== undefined) statutCible = archiver ? 'archivee' : 'active';
      if (statutCible !== undefined) {
        if (!['active', 'nurturing', 'archivee'].includes(statutCible)) return res.status(400).json({ erreur: 'statut invalide (active | nurturing | archivee)' });
        const adminA = ['admin', 'superadmin'].includes(user.role);
        if (!adminA) {
          const rows = await sql`SELECT sdr FROM listes WHERE id = ${parseInt(id)}`;
          if (!rows.length) return res.status(404).json({ erreur: 'Liste introuvable' });
          if (rows[0].sdr !== user.nom) return res.status(403).json({ erreur: 'Vous ne pouvez modifier que vos propres listes' });
        }
        let rappelsSupprimes = 0, smsAnnules = 0;
        if (statutCible === 'archivee') {
          // Garde-fou : une liste ne s'archive que traitée à 100 % (issue d'appel sur chaque fiche).
          // Un admin peut forcer (forcer:true = bouton « Archiver quand même »). Le SDR est orienté
          // vers le nurturing, qui conserve rappels/SMS. L'auto-archivage du cron n'est pas concerné
          // (il passe en SQL direct et ne vise que des nurturing à l'activité épuisée).
          const forcerA = req.body.forcer === true && adminA;
          if (!forcerA) {
            const lr = await sql`SELECT entreprises FROM listes WHERE id = ${parseInt(id)}`;
            const stG = lr.length ? calculerStatsListe(lr[0].entreprises) : null;
            if (stG && stG.pct_tag < 100) {
              return res.status(403).json({
                erreur: 'non_terminee', pct: stG.pct_tag, restantes: stG.total - stG.traites,
                message: `Liste traitée à ${stG.pct_tag} % — ${stG.total - stG.traites} fiche(s) sans issue d'appel. Termine le traitement ou passe-la en nurturing${adminA ? ' (ou force l\'archivage)' : ''}.`
              });
            }
          }
          await sql`UPDATE listes SET archivee = TRUE, statut = 'archivee', statut_depuis = NOW(), veille = FALSE WHERE id = ${parseInt(id)}`;
          // Archiver = sortir la liste du jeu : rappels non faits supprimés, SMS en attente annulés
          // (sinon les alertes et les envois continuent !). Le désarchivage ne restaure rien.
          try {
            const rt = await sql`DELETE FROM taches WHERE liste_id = ${parseInt(id)} AND faite = FALSE RETURNING id`;
            rappelsSupprimes = rt.length;
            const rs = await sql`UPDATE sms_programmes SET statut = 'cancelled' WHERE liste_id = ${parseInt(id)} AND statut = 'pending' RETURNING id`;
            smsAnnules = rs.length;
          } catch (_) {}
        } else if (statutCible === 'nurturing') {
          await sql`UPDATE listes SET archivee = FALSE, statut = 'nurturing', statut_depuis = NOW(), veille = TRUE, veille_fin = NOW() + INTERVAL '60 days' WHERE id = ${parseInt(id)}`;
        } else {
          await sql`UPDATE listes SET archivee = FALSE, statut = 'active', statut_depuis = NOW() WHERE id = ${parseInt(id)}`;
        }
        return res.status(200).json({ ok: true, statut: statutCible, archivee: statutCible === 'archivee', rappels_supprimes: rappelsSupprimes, sms_annules: smsAnnules });
      }
      if (req.body.sequences_auto !== undefined) {
        await sql`UPDATE listes SET sequences_auto = ${!!req.body.sequences_auto} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, sequences_auto: !!req.body.sequences_auto });
      }
      if (veille !== undefined) {
        const fin = veille ? new Date(Date.now() + (parseInt(veille_jours) || 60) * 24 * 3600 * 1000) : null;
        await sql`UPDATE listes SET veille = ${!!veille}, veille_fin = ${fin} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, veille: !!veille, veille_fin: fin });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur base de données', detail: err.message });
  }
}
