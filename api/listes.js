// /api/listes.js — Mémoire des listes d'appel
// GET ?q=…           → historique (recherche par nom de liste ou SDR)
// GET ?id=…          → liste complète (pour la rouvrir)
// GET ?criteres=…    → listes existantes avec les MÊMES critères (anti-doublon)
// POST {…}           → sauvegarder une nouvelle liste
// PUT  {id, entreprises} → mettre à jour les entreprises (ex: après analyses GMB)

import { createHash } from 'crypto';
import { sql, ensureSchema, verifierToken } from './db.js';

function hashCriteres(criteres) {
  // Hash stable : on ne garde que les critères de ciblage (pas le nom de liste ni le SDR)
  const c = criteres || {};
  const cle = JSON.stringify({
    naf: [...(c.naf || [])].sort(),
    size: c.size || '',
    emp: c.emp || '',
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
      let rows;
      if (recherche) {
        const like = '%' + recherche + '%';
        // Recherche par numéro : on compare les chiffres du terme au JSON débarrassé de ses espaces/ponctuation
        const digits = recherche.replace(/[^0-9]/g, '');
        const estNum = digits.length >= 4 && /^[0-9\s.()+\-]+$/.test(recherche);
        const likeDigits = '%' + digits + '%';
        rows = toutVoir
          ? await sql`SELECT id, nom, sdr, createur, archivee, stats, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                      WHERE (nom ILIKE ${like} OR sdr ILIKE ${like} OR entreprises::text ILIKE ${like}
                             OR (${estNum} AND regexp_replace(entreprises::text, '[^0-9]', '', 'g') ILIKE ${likeDigits}))
                      ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 50`
          : await sql`SELECT id, nom, sdr, createur, archivee, stats, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                      WHERE (sdr = ${moi} OR criteres->>'auto' = 'hotleads')
                        AND (nom ILIKE ${like} OR sdr ILIKE ${like} OR entreprises::text ILIKE ${like}
                             OR (${estNum} AND regexp_replace(entreprises::text, '[^0-9]', '', 'g') ILIKE ${likeDigits}))
                      ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 50`;
      } else {
        rows = toutVoir
          ? await sql`SELECT id, nom, sdr, createur, archivee, stats, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                      ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 50`
          : await sql`SELECT id, nom, sdr, createur, archivee, stats, total, credits_estimes, criteres, created_at, veille, veille_fin FROM listes
                      WHERE (sdr = ${moi} OR criteres->>'auto' = 'hotleads')
                      ORDER BY COALESCE(criteres->>'auto' = 'hotleads', false) DESC, created_at DESC LIMIT 50`;
      }
      // Récupérer les coûts par liste en une requête (table consommations)
      const ids = rows.map(r => r.id);
      let couts = {};
      if (ids.length) {
        try {
          const cr = await sql`SELECT c.liste_id, COALESCE(SUM(c.quantite * COALESCE(t.prix,0)),0) AS cout FROM consommations c LEFT JOIN tarifs t ON t.api = c.api WHERE c.liste_id = ANY(${ids}) GROUP BY c.liste_id`;
          cr.forEach(c => { couts[c.liste_id] = Number(c.cout) || 0; });
        } catch (_) {}
      }
      // Stats déjà pré-calculées et stockées en base (colonne stats) → aucun gros JSON chargé.
      const voirArchivees = archivees === '1' || archivees === 'true';
      const listes = rows
        .filter(r => voirArchivees ? true : !r.archivee)
        .map(r => ({ ...r, cout: couts[r.id] || 0, stats: r.stats || null }));
      return res.status(200).json({ listes });
    }

    // ── Sauvegarde ──
    if (req.method === 'POST') {
      const { nom, sdr, criteres, entreprises, credits_estimes } = req.body || {};
      if (!nom || !sdr || !criteres || !Array.isArray(entreprises)) {
        return res.status(400).json({ erreur: 'nom, sdr, criteres et entreprises requis' });
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
      // #2 Renommage d'une liste
      if (nom !== undefined && typeof nom === 'string' && nom.trim()) {
        await sql`UPDATE listes SET nom = ${nom.trim().slice(0, 120)} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, nom: nom.trim().slice(0, 120) });
      }
      // Transfert d'une liste à un autre SDR (réservé admin/superadmin)
      if (assigner_a !== undefined && typeof assigner_a === 'string' && assigner_a.trim()) {
        if (!['admin', 'superadmin'].includes(user.role)) {
          return res.status(403).json({ erreur: 'Seuls les administrateurs peuvent transférer une liste' });
        }
        await sql`UPDATE listes SET sdr = ${assigner_a.trim()} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, assigne: assigner_a.trim() });
      }
      // Archiver / désarchiver une liste (réservé admin/superadmin)
      if (archiver !== undefined) {
        if (!['admin', 'superadmin'].includes(user.role)) {
          return res.status(403).json({ erreur: 'Seuls les administrateurs peuvent archiver une liste' });
        }
        await sql`UPDATE listes SET archivee = ${!!archiver} WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true, archivee: !!archiver });
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
