// /api/restaurer-liste.js — 🚑 Restauration d'une liste depuis une BRANCHE Neon (point-in-time).
// Incident 04/08 (onglet périmé → liste écrasée) : lit la liste sur la branche et FUSIONNE dans
// la prod — additive uniquement : fiche absente ré-ajoutée, statut restauré si la prod n'en a pas
// de plus récent, contacts/enrichissements complétés. Ré-exécutable (idempotent), multi-branches.
// POST {branch_url, liste_id, dry} — superadmin. dry=true → aperçu des gains sans écrire.

import { verifierToken, sql } from './db.js';
import { neon } from '@neondatabase/serverless';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé au superadmin' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const { branch_url, liste_id, dry } = req.body || {};
  if (!branch_url || !/^postgres(ql)?:\/\//.test(String(branch_url))) return res.status(400).json({ erreur: 'branch_url (postgresql://…) requis' });
  const lid = parseInt(liste_id, 10);
  if (!lid) return res.status(400).json({ erreur: 'liste_id requis' });

  try {
    const sqlB = neon(String(branch_url));
    const bRows = await sqlB`SELECT nom, entreprises FROM listes WHERE id = ${lid}`;
    if (!bRows.length) return res.status(404).json({ erreur: 'Liste introuvable sur la branche' });
    const pRows = await sql`SELECT nom, entreprises FROM listes WHERE id = ${lid}`;
    if (!pRows.length) return res.status(404).json({ erreur: 'Liste introuvable en prod' });
    const branche = Array.isArray(bRows[0].entreprises) ? bRows[0].entreprises : [];
    const prod = Array.isArray(pRows[0].entreprises) ? pRows[0].entreprises : [];

    const cle = e => ((e.signal && e.signal.date) ? e.signal.date : '') + (e.nom || '');
    const normP = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const parCleB = new Map(branche.map(e => [cle(e), e]));
    const gains = { statuts: 0, contacts: 0, enrichissements: 0, fiches_reajoutees: 0, champs: 0 };

    const fusion = prod.map(env => {
      const bse = parCleB.get(cle(env));
      if (!bse) return env;
      const tB = bse.traite_le ? new Date(bse.traite_le).getTime() : 0;
      const tE = env.traite_le ? new Date(env.traite_le).getTime() : 0;
      if (tB > tE && (bse.tags_sdr || []).length) {
        env.tags_sdr = bse.tags_sdr; env.statut_appel = bse.statut_appel;
        env.traite_par = bse.traite_par; env.traite_le = bse.traite_le;
        gains.statuts++;
      }
      for (const ch of ['rdv_le', 'pris_par', 'pris_le', 'concurrent_perdu', 'lemlist_envoye', 'sequence_auto', 'personas_fait', 'linkedin_entreprise']) {
        if (bse[ch] !== undefined && bse[ch] !== null && (env[ch] === undefined || env[ch] === null || env[ch] === false)) { env[ch] = bse[ch]; gains.champs++; }
      }
      if (bse.score && !env.score) { env.score = bse.score; env.enrich = env.enrich || bse.enrich; env.gmb = env.gmb || bse.gmb; env.ia = env.ia || bse.ia; gains.enrichissements++; }
      if (Array.isArray(bse.contacts) && bse.contacts.length) {
        if (!Array.isArray(env.contacts)) env.contacts = [];
        const vus = new Map(env.contacts.map(c => [normP((c.prenom || '') + ' ' + (c.nom || '')), c]));
        for (const cb of bse.contacts) {
          const k = normP((cb.prenom || '') + ' ' + (cb.nom || ''));
          const ce = vus.get(k);
          if (!ce) { env.contacts.push(cb); gains.contacts++; continue; }
          if (cb.enrich) {
            if (!ce.enrich) { ce.enrich = cb.enrich; gains.contacts++; }
            else for (const f of ['email', 'telephone', 'linkedin']) if (cb.enrich[f] && !ce.enrich[f]) { ce.enrich[f] = cb.enrich[f]; gains.contacts++; }
          }
        }
      }
      return env;
    });
    const clesProd = new Set(prod.map(cle));
    for (const eb of branche) if (!clesProd.has(cle(eb))) { fusion.push(eb); gains.fiches_reajoutees++; }

    const apres = {
      fiches: fusion.length,
      enrichies: fusion.filter(e => e.score).length,
      statuees: fusion.filter(e => (e.tags_sdr || []).length).length,
      contacts: fusion.reduce((s, e) => s + ((e.contacts || []).length), 0)
    };
    const avant = {
      fiches: prod.length,
      enrichies: prod.filter(e => e.score).length,
      statuees: prod.filter(e => (e.tags_sdr || []).length).length,
      contacts: prod.reduce((s, e) => s + ((e.contacts || []).length), 0)
    };
    if (dry) return res.status(200).json({ ok: true, simulation: true, liste: pRows[0].nom, avant, apres, gains });

    const { calculerStatsListe } = await import('./listes.js').catch(() => ({}));
    const stats = (typeof calculerStatsListe === 'function') ? calculerStatsListe(fusion) : undefined;
    if (stats) await sql`UPDATE listes SET entreprises = ${JSON.stringify(fusion)}, total = ${fusion.length}, stats = ${JSON.stringify(stats)} WHERE id = ${lid}`;
    else await sql`UPDATE listes SET entreprises = ${JSON.stringify(fusion)}, total = ${fusion.length} WHERE id = ${lid}`;
    return res.status(200).json({ ok: true, restaure: true, liste: pRows[0].nom, avant, apres, gains });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur serveur', detail: String((e && e.message) || e) });
  }
}
