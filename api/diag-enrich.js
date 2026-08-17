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
    // Lemlist ne passe pas par `consommations` : il facture À LA RÉUSSITE (≈0,05 $/email,
    // ≈0,20 $/mobile) — on estime donc son coût sur les données trouvées, pas sur les tentatives.
    const LEM_EMAIL = 0.05, LEM_MOBILE = 0.20;
    const rendement = OUTILS.map(([cle, libelle, apiConso]) => {
      const nT = apiConso ? (tentatives[apiConso] || 0) : null;
      const nE = emails[cle === 'ia_web_email' ? 'ia_web' : cle] || 0;
      const nM = tels[cle] || 0;
      const prix = tarifs[apiConso || cle] != null ? tarifs[apiConso || cle] : null;
      let cout = (nT != null && prix != null) ? Math.round(nT * prix * 100) / 100 : null;
      let estime = false;
      if (cle === 'lemlist') { cout = Math.round((nE * LEM_EMAIL + nM * LEM_MOBILE) * 100) / 100; estime = true; }
      const trouves = nE + nM;
      return {
        outil: libelle,
        facturation: cle === 'lemlist' ? 'à la réussite' : 'à la tentative',
        tentatives: nT,
        emails_trouves: nE,
        mobiles_trouves: nM,
        donnees_trouvees: trouves,
        taux_email_pct: (nT && nT > 0) ? Math.round(100 * nE / nT) : null,
        cout_total_eur: cout,
        cout_par_donnee_eur: (cout != null && trouves > 0) ? Math.round(cout / trouves * 100) / 100 : null,
        note: cle === 'lemlist' ? 'coût ESTIMÉ (facturé à la réussite : ~0,05 $/email + 0,20 $/mobile) — non journalisé dans consommations' : undefined
      };
    });

    // ── 4. Lecture : le bon critère est le COÛT PAR DONNÉE OBTENUE, pas le taux de réussite ──
    // Un outil à 21 % de réussite mais 0,26 €/donnée est plus rentable qu'un outil à 15 % et
    // 0,61 €/donnée. Et un outil facturé à la réussite n'a aucun coût d'échec : il doit remonter
    // haut dans la cascade, quel que soit son taux.
    const classables = rendement.filter(r => r.cout_par_donnee_eur != null && r.donnees_trouvees >= 20)
      .sort((a, b) => a.cout_par_donnee_eur - b.cout_par_donnee_eur);
    const coutTotal = Math.round(rendement.reduce((s, r) => s + (r.cout_total_eur || 0), 0) * 100) / 100;
    const verdicts = [];
    if (classables.length) {
      verdicts.push('💶 Classement par coût réel d\'une donnée obtenue (email ou mobile) : ' +
        classables.map(r => `${r.outil.split(' (')[0]} ${r.cout_par_donnee_eur} €`).join(' · ') + '.');
      const ordreActuel = ['Dropcontact', 'FullEnrich', 'Kaspr', 'Lemlist'];
      const ordreIdeal = classables.map(r => r.outil.split(' (')[0]).filter(n => ordreActuel.includes(n));
      const malPlaces = ordreIdeal.filter((n, i) => ordreActuel.indexOf(n) !== ordreActuel.filter(x => ordreIdeal.includes(x)).indexOf(n));
      if (malPlaces.length) verdicts.push(`🔄 L'ordre du waterfall ne suit pas les coûts : ordre actuel ${ordreActuel.join(' → ')}, ordre le moins cher ${ordreIdeal.join(' → ')}. Chaque étage cher appelé trop tôt facture des échecs que l'étage suivant aurait résolus moins cher.`);
      const aLaReussite = rendement.find(r => r.facturation === 'à la réussite' && r.donnees_trouvees >= 20);
      if (aLaReussite) verdicts.push(`🎯 ${aLaReussite.outil.split(' (')[0]} est facturé À LA RÉUSSITE (${aLaReussite.donnees_trouvees} données pour ~${aLaReussite.cout_total_eur} € estimés) : un échec ne coûte rien. Le remonter dans la cascade est le levier le moins risqué — il ne peut pas faire grimper la facture.`);
    }
    if (echecTotal >= 20) verdicts.push(`🕳️ ${echecTotal} contact(s) ont épuisé toute la cascade sans rendre ni email ni mobile — chacun a été facturé par plusieurs étages (~${Math.round(echecTotal * 0.55)} € au minimum). Un garde-fou « stop après 2 échecs » économiserait cette perte sèche.`);
    verdicts.push(`📊 Total enrichissement sur la fenêtre : ~${coutTotal} € (premier appel le ${depuis ? String(depuis).slice(0, 10) : '?'}).`);

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
      cout_total_eur: coutTotal,
      verdict: verdicts.join('\n'),
      verdicts,
      rappel: 'Lecture seule — aucune modification du waterfall. Les emails « non_attribue » viennent de fiches antérieures au marquage des sources ; « saisi_sdr » = trouvés par les SDR (site web, Google Maps, ajout manuel), donc gratuits.'
    });
  } catch (e) {
    return res.status(500).json({ erreur: 'Diagnostic impossible', detail: String((e && e.message) || e).slice(0, 300) });
  }
}
