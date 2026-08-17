// /api/diag-enrich.js — 📊 Rendement réel du waterfall d'enrichissement (superadmin, lecture seule).
// Question posée le 17/08 : « utilise-t-on toujours Dropcontact ? » → oui (niveau 1), mais est-ce
// qu'il RAPPORTE ? On croise deux sources :
//   • tentatives  = table `consommations` (1 ligne par appel API : dropcontact, fullenrich, kaspr…)
//   • succès      = scan des listes, chaque email/mobile porte sa provenance
//                   (enrich.email_source / tel_source ; absent + source='dropcontact' → Dropcontact)
// Sortie : par outil → tentatives, trouvés, taux, coût, coût par donnée trouvée + verdict.
// GET ?jours=N pour restreindre la fenêtre des tentatives (défaut : tout l'historique).

import { verifierToken, sql, ensureSchema } from './db.js';

export const config = { maxDuration: 60 };

// Provenance d'un email : la source explicite gagne, sinon Dropcontact (niveau 1, qui ne
// pose pas d'email_source mais laisse enrich.source = 'dropcontact')
function outilEmail(c) {
  const en = c.enrich || {};
  if (!en.email) return null;
  const s = String(en.email_source || '').toLowerCase().trim();
  if (s) return s === 'sdr' ? 'saisi_sdr' : s;
  if (/^ia web/i.test(String(en.email_qualification || '')) || c.source === 'ia_web') return 'ia_web';
  if (String(en.source || '').toLowerCase() === 'dropcontact') return 'dropcontact';
  return 'non_attribue';
}
function outilTel(c) {
  const en = c.enrich || {};
  if (!en.telephone) return null;
  const s = String(en.tel_source || en.telephone_source || '').toLowerCase().trim();
  if (s) return s;
  if (String(en.source || '').toLowerCase() === 'dropcontact') return 'dropcontact';
  return 'non_attribue';
}

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Réservé superadmin' });
  await ensureSchema();
  const jours = parseInt((req.query || {}).jours || '0', 10) || 0; // 0 = tout l'historique

  try {
    // ── 1. Tentatives facturées (table consommations) ──
    const conso = jours
      ? await sql`SELECT api, SUM(quantite)::float AS n, MIN(created_at) AS depuis FROM consommations
                  WHERE created_at > NOW() - (${jours} || ' days')::interval GROUP BY api`
      : await sql`SELECT api, SUM(quantite)::float AS n, MIN(created_at) AS depuis FROM consommations GROUP BY api`;
    const tentatives = {}; let depuis = null;
    for (const r of conso) {
      tentatives[r.api] = Math.round(r.n);
      if (r.depuis && (!depuis || new Date(r.depuis) < new Date(depuis))) depuis = r.depuis;
    }
    const tarifs = {};
    for (const t of await sql`SELECT api, prix FROM tarifs`) tarifs[t.api] = Number(t.prix);

    // ── 2. Succès réels : scan de toutes les listes (l'email porte sa provenance) ──
    const listes = await sql`SELECT entreprises FROM listes`;
    const emails = {}, tels = {};
    let contacts = 0, avecEmail = 0, avecMobile = 0;
    let feTente = 0, kasprTente = 0, lemTente = 0, echecTotal = 0;
    for (const l of listes) {
      const arr = Array.isArray(l.entreprises) ? l.entreprises : [];
      for (const e of arr) {
        for (const c of (Array.isArray(e.contacts) ? e.contacts : [])) {
          if (!c || !(c.nom || c.prenom)) continue;
          contacts++;
          const en = c.enrich || {};
          const oe = outilEmail(c); if (oe) { emails[oe] = (emails[oe] || 0) + 1; avecEmail++; }
          const ot = outilTel(c); if (ot) { tels[ot] = (tels[ot] || 0) + 1; avecMobile++; }
          if (en.fe_fait) feTente++;
          if (en.kaspr_fait) kasprTente++;
          if (en.lemlist_fait) lemTente++;
          // Cascade épuisée sans rien trouver : le contact a coûté sans jamais rien rendre
          if (!en.email && !en.telephone && (en.fe_fait || en.kaspr_fait || en.lemlist_fait)) echecTotal++;
        }
      }
    }

    // ── 3. Rendement par outil ──
    const OUTILS = [
      ['dropcontact', 'Dropcontact (niveau 1 — email)', 'dropcontact'],
      ['fullenrich', 'FullEnrich (niveau 2 — email + mobile)', 'fullenrich'],
      ['kaspr', 'Kaspr (niveau 3 — mobile)', 'kaspr'],
      ['lemlist', 'Lemlist (niveau 4 — email + mobile)', null],
      ['ia_web_email', 'Recherche web IA (emails génériques)', 'ia_web_email']
    ];
    const rendement = OUTILS.map(([cle, libelle, apiConso]) => {
      const nT = apiConso ? (tentatives[apiConso] || 0) : null; // Lemlist n'est pas journalisé en conso
      const nE = emails[cle === 'ia_web_email' ? 'ia_web' : cle] || 0;
      const nM = tels[cle] || 0;
      const prix = tarifs[apiConso || cle] != null ? tarifs[apiConso || cle] : null;
      const cout = (nT != null && prix != null) ? Math.round(nT * prix * 100) / 100 : null;
      const trouves = nE + nM;
      return {
        outil: libelle,
        tentatives: nT,
        emails_trouves: nE,
        mobiles_trouves: nM,
        taux_email_pct: (nT && nT > 0) ? Math.round(100 * nE / nT) : null,
        cout_total_eur: cout,
        cout_par_donnee_eur: (cout != null && trouves > 0) ? Math.round(cout / trouves * 100) / 100 : null,
        note: apiConso ? undefined : 'non journalisé dans consommations (facturé à la réussite par Lemlist)'
      };
    });

    // ── 4. Lecture : Dropcontact vaut-il sa place en niveau 1 ? ──
    const dc = rendement[0], fe = rendement[1];
    let verdict;
    if (!dc.tentatives) verdict = 'Aucune tentative Dropcontact sur la fenêtre analysée — rien à conclure.';
    else if (dc.taux_email_pct >= 45) verdict = `✅ Dropcontact garde sa place en niveau 1 (${dc.taux_email_pct} % de réussite, ${dc.cout_par_donnee_eur} € par email trouvé).`;
    else if (dc.taux_email_pct >= 25) verdict = `🟠 Rendement moyen (${dc.taux_email_pct} %). Il reste rentable s'il coûte moins par email que FullEnrich (${fe.cout_par_donnee_eur ?? '—'} €) — sinon, inverser l'ordre du waterfall.`;
    else verdict = `⛔ Rendement faible (${dc.taux_email_pct} % de réussite pour ${dc.cout_total_eur} €). FullEnrich derrière rattrape ${fe.emails_trouves} email(s) : envisager de passer FullEnrich en niveau 1 et Dropcontact en repli (ou de le retirer).`;

    return res.status(200).json({
      ok: true,
      fenetre: jours ? `${jours} derniers jours` : 'tout l\'historique',
      premiere_conso: depuis,
      base: {
        contacts_nominatifs: contacts,
        avec_email: avecEmail, pct_email: contacts ? Math.round(100 * avecEmail / contacts) : 0,
        avec_mobile: avecMobile, pct_mobile: contacts ? Math.round(100 * avecMobile / contacts) : 0
      },
      rendement,
      cascade: {
        fullenrich_tente: feTente, kaspr_tente: kasprTente, lemlist_tente: lemTente,
        cascade_epuisee_sans_rien: echecTotal,
        emails_par_provenance: emails, mobiles_par_provenance: tels
      },
      verdict,
      rappel: 'Lecture seule — aucune modification du waterfall. Les emails « non_attribue » viennent de fiches antérieures au marquage des sources.'
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Diagnostic impossible', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
