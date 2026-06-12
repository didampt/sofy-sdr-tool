// /api/veille.js — Veille signaux LinkedIn (PhantomBuster) sur les listes 🔔
// Appelée automatiquement par le cron Vercel (toutes les 6 h) ou manuellement par le superadmin.
//
// Variables Vercel nécessaires :
//   PHANTOMBUSTER_API_KEY    → ta clé API PhantomBuster
//   PHANTOMBUSTER_AGENT_IDS  → IDs des Phantoms à surveiller, séparés par des virgules (ex: "1234567,7654321")
//                              (Phantoms type "LinkedIn Post Likers" / "Company Followers" programmés côté PB)
//   SLACK_WEBHOOK_URL        → webhook du canal Slack des SDR
//   CRON_SECRET              → secret du cron Vercel (généré automatiquement quand la variable existe)
//
// Logique : pour chaque Phantom → résultat le plus récent → on compare avec les profils déjà vus
// (table veille_etat) → les NOUVEAUX likers sont croisés avec les contacts des listes en veille
// (match par URL LinkedIn) → signal 🔥 sur la fiche + ligne dans la table signaux + alerte Slack.

import { sql, ensureSchema, verifierToken } from './db.js';

export const config = { maxDuration: 120 };

function normaliserLinkedin(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/linkedin\.com\/(in|company)\/([^/?#]+)/);
  return m ? `${m[1]}/${decodeURIComponent(m[2]).replace(/\/$/, '')}` : null;
}

function extraireProfils(data) {
  // Les exports PhantomBuster varient selon le Phantom : on cherche toute URL LinkedIn /in/ ou /company/
  const profils = [];
  const lignes = Array.isArray(data) ? data : (data && Array.isArray(data.result) ? data.result : []);
  for (const ligne of lignes) {
    if (!ligne || typeof ligne !== 'object') continue;
    let url = null, nom = null;
    for (const [k, v] of Object.entries(ligne)) {
      if (typeof v !== 'string') continue;
      if (!url && /linkedin\.com\/(in|company)\//i.test(v)) url = v;
      const kl = k.toLowerCase();
      if (!nom && (kl === 'name' || kl === 'fullname' || kl === 'full_name' || kl === 'profilename')) nom = v;
    }
    if (url) profils.push({ url: normaliserLinkedin(url), brut: url, nom: nom || '' });
  }
  return profils.filter(p => p.url);
}

async function envoyerSlack(texte) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texte }) });
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();

  // Accès : cron Vercel (Bearer CRON_SECRET) OU superadmin connecté (bouton "Tester la veille")
  const auth = req.headers.authorization || '';
  const estCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const user = verifierToken(req);
  if (!estCron && (!user || user.role !== 'superadmin')) {
    return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
  }

  const pbKey = process.env.PHANTOMBUSTER_API_KEY;
  const agentIds = (process.env.PHANTOMBUSTER_AGENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!pbKey || !agentIds.length) {
    return res.status(200).json({ ok: false, message: 'PHANTOMBUSTER_API_KEY ou PHANTOMBUSTER_AGENT_IDS manquante — veille inactive' });
  }

  try {
    // ── 1. Listes en veille active + index des contacts par URL LinkedIn ──
    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE veille = TRUE AND (veille_fin IS NULL OR veille_fin > NOW())`;
    const index = new Map(); // linkedin normalisé → {liste, e_idx, c_idx, entreprise, contact}
    for (const l of listes) {
      (l.entreprises || []).forEach((e, ei) => {
        (e.contacts || []).forEach((c, ci) => {
          const url = normaliserLinkedin(c.enrich && c.enrich.linkedin);
          if (url) index.set(url, { liste: l, ei, ci, entreprise: e.enseigne_ia || e.enseigne || e.nom, contact: `${c.prenom || ''} ${c.nom || ''}`.trim() });
        });
        // Page entreprise LinkedIn (suivie par les Phantoms "followers")
        const pageCo = normaliserLinkedin(e.linkedin_entreprise);
        if (pageCo) index.set(pageCo, { liste: l, ei, ci: -1, entreprise: e.enseigne_ia || e.enseigne || e.nom, contact: '' });
      });
    }

    const resume = { agents: 0, nouveaux: 0, matches: 0, listes_en_veille: listes.length };
    const aSauver = new Map(); // liste_id → entreprises modifiées

    // ── 2. Chaque Phantom : résultat → diff → match ──
    for (const agentId of agentIds) {
      resume.agents++;
      // Métadonnées de l'agent (nom + dossier S3 du dernier résultat)
      const rAgent = await fetch(`https://api.phantombuster.com/api/v2/agents/fetch?id=${agentId}`, {
        headers: { 'X-Phantombuster-Key-1': pbKey }
      });
      const agent = await rAgent.json().catch(() => ({}));
      const nomAgent = agent.name || `Phantom ${agentId}`;
      let data = null;
      if (agent.orgS3Folder && agent.s3Folder) {
        const rRes = await fetch(`https://phantombuster.s3.amazonaws.com/${agent.orgS3Folder}/${agent.s3Folder}/result.json`);
        if (rRes.ok) data = await rRes.json().catch(() => null);
      }
      if (!data) {
        // Repli : sortie du dernier container
        const rOut = await fetch(`https://api.phantombuster.com/api/v2/agents/fetch-output?id=${agentId}`, {
          headers: { 'X-Phantombuster-Key-1': pbKey }
        });
        const out = await rOut.json().catch(() => ({}));
        if (out && out.resultObject) { try { data = JSON.parse(out.resultObject); } catch (_) {} }
      }
      if (!data) continue;

      const profils = extraireProfils(data);

      // Diff avec les profils déjà vus pour cet agent
      const etat = await sql`SELECT deja_vus FROM veille_etat WHERE cle = ${String(agentId)}`;
      const dejaVus = new Set(etat.length ? etat[0].deja_vus : []);
      const premierPassage = etat.length === 0;
      const nouveaux = profils.filter(p => !dejaVus.has(p.url));
      resume.nouveaux += premierPassage ? 0 : nouveaux.length;

      // Mémoriser l'état (plafonné à 5000 profils)
      const tous = [...new Set([...dejaVus, ...profils.map(p => p.url)])].slice(-5000);
      await sql`INSERT INTO veille_etat (cle, deja_vus, maj) VALUES (${String(agentId)}, ${JSON.stringify(tous)}, NOW())
                ON CONFLICT (cle) DO UPDATE SET deja_vus = ${JSON.stringify(tous)}, maj = NOW()`;

      if (premierPassage) continue; // 1er passage = référence, pas d'alertes (sinon spam)

      // Croisement avec les contacts en veille
      for (const p of nouveaux) {
        const m = index.get(p.url);
        if (!m) continue;
        resume.matches++;
        const detail = `${p.nom || m.contact || 'Un profil suivi'} a interagi (${nomAgent})`;
        await sql`INSERT INTO signaux (liste_id, entreprise_nom, contact_nom, linkedin, type, source, detail, sdr)
          VALUES (${m.liste.id}, ${m.entreprise}, ${m.contact || p.nom}, ${p.brut}, 'linkedin', ${nomAgent}, ${detail}, ${m.liste.sdr})`;
        // Marquer la fiche 🔥
        const ents = aSauver.get(m.liste.id) || m.liste.entreprises;
        const e = ents[m.ei];
        e.signal_hot = true;
        const sig = { type: 'linkedin', source: nomAgent, detail, date: new Date().toISOString() };
        if (m.ci >= 0 && e.contacts && e.contacts[m.ci]) e.contacts[m.ci].signal = sig;
        else e.signal = sig;
        aSauver.set(m.liste.id, ents);
        await envoyerSlack(`🔥 *Signal LinkedIn* — ${m.contact || p.nom} (${m.entreprise})\n${nomAgent} · liste « ${m.liste.nom} » · SDR *${m.liste.sdr}*\n${p.brut}`);
      }
    }

    // ── 3. Sauvegarder les fiches marquées ──
    for (const [listeId, ents] of aSauver) {
      await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${listeId}`;
    }

    return res.status(200).json({ ok: true, ...resume });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur veille', detail: err.message });
  }
}
