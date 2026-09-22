// /api/recherche.js — Recherche avancée (6e carte, 22/09/2026) : le « Sales Nav » de SofyScrap.
// Onglet PROSPECTS uniquement (l'onglet Entreprises du front passe par /api/estimer + /api/liste,
// la tuyauterie Pappers existante). Moteur : Basile people/find, mêmes briques que la Liste
// intelligente V2 (concepts activity résolus par suggest, company_headcount, curseur, dédup
// LinkedIn) mais piloté par des FILTRES MANUELS posés par le SDR — plus une recherche par
// « listes de comptes » SofyScrap (filtre siren, l'équivalent des account lists Sales Nav).
//
// POST { mode, filtres, nb?, curseur?, exclus_slugs? }
//   mode='apercu'  -> { total, total_sans_effectif, concepts_labels, leads:[{...,doublon}] } (gratuit)
//   mode='generer' -> { fiches, nb, curseur, epuise, profils_parcourus } (fiches au format Sofy)
//   filtres = { naf_codes:[], concept_ids:[], postes:[], familles:[], decideur:bool,
//               effectif_min, effectif_max, listes_ids:[], exclure_extraits:bool }
// Règles maison : comptage/aperçu gratuits ; tout filtre qui écarte de l'inconnu est MESURÉ
// (total_sans_effectif) ; les doublons sont signalés à l'aperçu et écartés à la génération.

import { verifierToken, loggerConso, limiteAtteinte, sql } from './db.js';
import {
  basile, FAMILLES_POSTE, resoudreConcepts, leadVersFichePersonne,
  slugLinkedin, linkedinsConnus, regrouperParEntreprise
} from './ia-liste-creer.js';

export const config = { maxDuration: 120 };

// « N'importe quel décideur » en mode recherche = l'union des intitulés de TOUTES les familles
// (déterministe, même logique figée que la Liste intelligente).
function rolesDecideur() {
  const out = [];
  for (const fam of Object.keys(FAMILLES_POSTE)) for (const t of FAMILLES_POSTE[fam]) if (!out.includes(t)) out.push(t);
  return out;
}

function rolesDepuisFiltres(f) {
  if (f.decideur) return rolesDecideur();
  const out = [];
  for (const fam of (Array.isArray(f.familles) ? f.familles : [])) {
    const arr = FAMILLES_POSTE[String(fam).toLowerCase().trim()];
    if (arr) for (const t of arr) if (!out.includes(t)) out.push(t);
  }
  for (const p of (Array.isArray(f.postes) ? f.postes : [])) {
    const t = String(p || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 80);
}

// SIREN des listes SofyScrap sélectionnées (équivalent « account lists » Sales Nav).
async function sirensDesListes(ids) {
  if (!sql || !Array.isArray(ids) || !ids.length) return [];
  const propres = ids.map(x => parseInt(x, 10)).filter(x => x > 0).slice(0, 10);
  if (!propres.length) return [];
  const sirens = [];
  try {
    const rows = await sql`SELECT entreprises FROM listes WHERE id = ANY(${propres})`;
    const vus = new Set();
    for (const row of rows) {
      for (const e of (Array.isArray(row.entreprises) ? row.entreprises : [])) {
        const s = String(e.siren || '').replace(/\D/g, '');
        if (s.length === 9 && !vus.has(s)) { vus.add(s); sirens.push(s); }
      }
    }
  } catch (_) {}
  return sirens.slice(0, 300); // plafond : 10 lots de 30 côté people/find
}

// Construit les filtres Basile communs (hors siren, géré par lots).
function filtresBasile(f, conceptIds, roles) {
  const b = { result_country_code: { include: ['FR'] }, hide_legal_entities: true };
  if (roles.length) b.result_role = { include: roles };
  if (conceptIds.length) b.activity = { include: conceptIds };
  const effMin = parseInt(f.effectif_min, 10), effMax = parseInt(f.effectif_max, 10);
  if (effMin > 0 || effMax > 0) {
    b.company_headcount = {};
    if (effMin > 0) b.company_headcount['>='] = effMin;
    if (effMax > 0) b.company_headcount['<='] = effMax;
  }
  return b;
}

const LOT_SIREN = 30;

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  const key = process.env.BASILE_API_KEY;
  if (!key) return res.status(500).json({ erreur: 'BASILE_API_KEY manquante' });

  const lim = await limiteAtteinte(user);
  if (lim) return res.status(403).json({ erreur: `Limite mensuelle atteinte : ${lim.conso} € / ${lim.limite} €` });

  const { mode, filtres = {}, nb = 50, curseur = null, exclus_slugs = [] } = req.body || {};
  if (mode !== 'apercu' && mode !== 'generer') return res.status(400).json({ erreur: 'mode inconnu (apercu|generer)' });

  try {
    // Concepts secteur : ids déjà choisis par le SDR (autocomplete), sinon résolus depuis les NAF.
    let conceptIds = (Array.isArray(filtres.concept_ids) ? filtres.concept_ids : [])
      .map(x => String(x || '').trim()).filter(x => x && !x.startsWith('concept:')).slice(0, 10);
    let conceptLabels = Array.isArray(filtres.concept_labels) ? filtres.concept_labels.slice(0, 10) : [];
    if (!conceptIds.length && Array.isArray(filtres.naf_codes) && filtres.naf_codes.length) {
      const r = await resoudreConcepts({ naf_codes: filtres.naf_codes }, key);
      conceptIds = r.ids; conceptLabels = r.labels;
    }
    const roles = rolesDepuisFiltres(filtres);
    const sirens = await sirensDesListes(filtres.listes_ids);
    if (!roles.length && !conceptIds.length && !sirens.length) {
      return res.status(400).json({ erreur: 'Ajoute au moins un filtre (secteur, poste ou liste de comptes) — sans quoi la recherche couvrirait toute la France.' });
    }
    const base = filtresBasile(filtres, conceptIds, roles);

    // Un appel people/find (comptage limit 1 ou page) avec, en mode listes, un lot de SIREN.
    async function trouver(extra, limit, token) {
      const body = { limit, filters: { ...base, ...extra } };
      if (token) body.paginationToken = token;
      return basile('/people/find', body, key);
    }

    // ── APERÇU : total + transparence effectif + 20 premiers profils, doublons signalés ──
    if (mode === 'apercu') {
      let total = 0, totalSansEffectif = null, leadsBruts = [];
      if (sirens.length) {
        // Par lots de SIREN : total = somme, aperçu = premiers lots (comptages gratuits)
        for (let i = 0; i < sirens.length; i += LOT_SIREN) {
          const lot = sirens.slice(i, i + LOT_SIREN);
          const r = await trouver({ siren: { include: lot } }, leadsBruts.length < 20 ? 100 : 1);
          if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
          if (!r.data || r.data.success === false) continue;
          total += r.data.total || 0;
          if (leadsBruts.length < 20) leadsBruts = leadsBruts.concat(r.data.leads || []);
        }
      } else {
        const r = await trouver({}, 20);
        if (r.status === 401) return res.status(502).json({ erreur: 'Clé Basile refusée' });
        if (!r.data || r.data.success === false) return res.status(502).json({ erreur: 'Recherche Basile échouée', status: r.status });
        total = r.data.total || 0;
        leadsBruts = r.data.leads || [];
        if (base.company_headcount && total >= 0) {
          const sans = { ...base }; delete sans.company_headcount;
          const r2 = await basile('/people/find', { limit: 1, filters: sans }, key);
          if (r2.data && r2.data.total != null) totalSansEffectif = r2.data.total;
        }
      }
      // Doublons : slugs LinkedIn déjà extraits dans les listes actives
      const connus = await linkedinsConnus(sql);
      const leads = leadsBruts.slice(0, 20).map(l => {
        const fiche = leadVersFichePersonne(l);
        const c = fiche.contacts[0] || {};
        const slug = slugLinkedin(c.enrich && c.enrich.linkedin);
        return {
          prenom: c.prenom || '', nom: c.nom || '', fonction: c.fonction || '',
          entreprise: fiche.nom || '', ville: fiche.ville || '',
          linkedin: (c.enrich && c.enrich.linkedin) || null,
          slug: slug || null,
          doublon: !!(slug && connus.has(slug))
        };
      });
      return res.status(200).json({
        total, total_sans_effectif: totalSansEffectif,
        concepts_labels: conceptLabels, nb_roles: roles.length,
        nb_sirens: sirens.length || null,
        leads
      });
    }

    // ── GÉNÉRATION : fiches au format Sofy, dédup + curseur (hors mode listes, borné) ──
    const cap = Math.min(parseInt(nb, 10) || 50, 200);
    const exclure = filtres.exclure_extraits !== false;
    const connus = exclure ? await linkedinsConnus(sql) : new Set();
    for (const s of (Array.isArray(exclus_slugs) ? exclus_slugs : [])) {
      const x = String(s || '').toLowerCase().trim(); if (x) connus.add(x); // décochés à l'aperçu
    }
    const debut = Date.now();
    const tempsOk = () => (Date.now() - debut) < 90000; // maxDuration 120 s, marge
    let fiches = [], epuise = false, pages = 0, token = null;

    if (sirens.length) {
      // Mode listes de comptes : lots bornés (≤300 SIREN), pas de curseur nécessaire.
      for (let i = 0; i < sirens.length; i += LOT_SIREN) {
        if (!tempsOk() || fiches.length >= cap) break;
        const r = await trouver({ siren: { include: sirens.slice(i, i + LOT_SIREN) } }, 100);
        if (!r.data || r.data.success === false) continue;
        pages++;
        for (const l of (r.data.leads || [])) {
          const f = leadVersFichePersonne(l);
          const slug = slugLinkedin(f.contacts[0] && f.contacts[0].enrich && f.contacts[0].enrich.linkedin);
          if (!slug || connus.has(slug)) continue;
          fiches.push(f); connus.add(slug);
          if (fiches.length >= cap) break;
        }
      }
      epuise = true; // le vivier des listes est fini par construction
    } else {
      // Mode filtres : pagination avec curseur persistant (même mécanique que la Liste intelligente).
      const cle = 'av_curseur_' + (() => {
        const basePlate = JSON.stringify({ r: [...roles].sort(), a: conceptIds, e: base.company_headcount || null });
        let h = 0; for (let i = 0; i < basePlate.length; i++) { h = ((h << 5) - h + basePlate.charCodeAt(i)) | 0; }
        return Math.abs(h).toString(36);
      })();
      let cur = (curseur && typeof curseur === 'object') ? curseur : null;
      if (!cur && sql) {
        try { const r = await sql`SELECT valeur FROM config WHERE cle = ${cle}`; cur = (r.length && r[0].valeur) || null; } catch (_) {}
      }
      if (cur && cur.epuise) cur = null;
      token = (cur && cur.token) || null;
      pages = (cur && cur.pages) || 0;
      for (let p = 0; p < 8; p++) {
        if (!tempsOk() || fiches.length >= cap) break;
        let r = await trouver({}, 100, token);
        if (token && (!r.data || r.data.success === false)) { token = null; pages = 0; r = await trouver({}, 100); }
        if (r.status === 402) break;
        if (!r.data || r.data.success === false) break;
        const leads = r.data.leads || [];
        if (!leads.length) { epuise = true; break; }
        pages++;
        token = (r.data.pagination && r.data.pagination.nextToken) || null;
        for (const l of leads) {
          const f = leadVersFichePersonne(l);
          const slug = slugLinkedin(f.contacts[0] && f.contacts[0].enrich && f.contacts[0].enrich.linkedin);
          if (!slug || connus.has(slug)) continue;
          fiches.push(f); connus.add(slug);
          if (fiches.length >= cap) break;
        }
        if (!token) { epuise = true; break; }
      }
      if (sql) {
        try {
          await sql`INSERT INTO config (cle, valeur) VALUES (${cle}, ${JSON.stringify({ token, pages, epuise, maj: new Date().toISOString() })})
                    ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify({ token, pages, epuise, maj: new Date().toISOString() })}`;
        } catch (_) {}
      }
    }

    fiches = regrouperParEntreprise(fiches).slice(0, cap);
    await loggerConso(user, 'basile', 1, null);
    return res.status(200).json({
      fiches, nb: fiches.length,
      curseur: sirens.length ? null : { token, pages, epuise },
      epuise,
      profils_parcourus: pages * 100,
      concepts_labels: conceptLabels,
      message: fiches.length ? undefined : (epuise
        ? 'Tout le vivier de ces critères a déjà été extrait — élargis le secteur, les postes ou retire le filtre effectif.'
        : 'Aucun nouveau profil sur ce lot — relance pour explorer la suite.')
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur recherche', detail: String(e.message || e).slice(0, 200) });
  }
}
