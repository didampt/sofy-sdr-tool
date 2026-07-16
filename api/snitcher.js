// /api/snitcher.js — Récepteur temps réel des ENTREPRISES identifiées sur sofy.fr (webhook Snitcher)
// Remplaçant de RB2B. Snitcher pousse un événement quand une entreprise entre dans un segment (ICP)
// — ou quand un contact est révélé — → 🔥 sur la fiche déjà en liste + alerte Slack,
// sinon création d'un nouveau Hot Lead (entreprise) enrichi ensuite par le waterfall Sofy.
//
// Sécurité : le secret est dans l'URL du webhook → https://…/api/snitcher?secret=SNITCHER_WEBHOOK_SECRET
//   (comme RB2B). Snitcher peut aussi signer en HMAC-SHA256 via l'en-tête « Signature » : vérifié en bonus si présent.
// Variables Vercel : SNITCHER_WEBHOOK_SECRET (longue chaîne aléatoire), SLACK_WEBHOOK_URL, APP_URL

import { sql, ensureSchema, ajouterHotLead } from './db.js';
import crypto from 'crypto';

export const config = { maxDuration: 30 };

function normaliserNom(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normaliserLinkedin(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/linkedin\.com\/(in|company)\/([^/?#]+)/);
  return m ? `${m[1]}/${decodeURIComponent(m[2]).replace(/\/$/, '')}` : null;
}
function domaineDe(s) {
  if (!s) return null;
  return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('@').pop() || null;
}
const DOMAINES_PERSO = new Set(['gmail.com','outlook.com','hotmail.com','yahoo.com','yahoo.fr','orange.fr','wanadoo.fr','live.fr','icloud.com','free.fr','sfr.fr','laposte.net']);

async function envoyerSlack(texte) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texte }) });
  } catch (_) {}
}

// Transforme le payload Snitcher (entreprise OU contacts révélés) en une liste d'items normalisés.
// On ratisse plusieurs noms de champs possibles ; le payload réel est journalisé dans config('snitcher_last').
function extraireItems(corps) {
  const items = [];
  const blocs = Array.isArray(corps) ? corps : [corps];
  for (const bloc of blocs) {
    if (!bloc || typeof bloc !== 'object') continue;

    // a) Contacts révélés → personnes (event « contacts_revealed »)
    const sujets = Array.isArray(bloc.subjects) ? bloc.subjects : (Array.isArray(bloc.contacts) ? bloc.contacts : null);
    if (sujets && sujets.length) {
      for (const s of sujets) {
        const co = s.company || {};
        items.push({
          prenom: s.first_name || s.firstName || '', nom: s.last_name || s.lastName || '',
          email: (s.email || '').toLowerCase() || null,
          telephone: s.phone || null,
          linkedin: s.linkedin_url || s.linkedin || null,
          fonction: s.title || s.headline || '',
          entreprise: co.name || '', domaine: co.domain || null,
          industrie: null, effectif: null,
          ville: s.location || null, region: null,
          pages: [], event: bloc.event || 'contacts_revealed',
          segment: bloc.segment || null
        });
      }
      continue;
    }

    // b) Entreprise identifiée / entrée dans un segment (event « company.identified », « enters segment »…)
    const co = bloc.company || bloc.organisation || bloc.organization || null;
    if (co && typeof co === 'object') {
      const loc = co.location || {};
      const sess = bloc.session || {};
      // Visiteur identifié par l'Identity Layer Snitcher (lien email ?sn_eid=…, formulaire, login) :
      // on ratisse plusieurs noms de champs possibles — ajuster au vu du payload réel
      // journalisé dans config('snitcher_last') quand le premier événement identifié arrivera.
      const vis = bloc.visitor || bloc.lead || bloc.identity || bloc.contact || sess.visitor || null;
      const visEmail = (vis && (vis.email || vis.identified_email)) || bloc.identified_email || sess.identified_email || null;
      items.push({
        prenom: (vis && (vis.first_name || vis.firstName)) || '',
        nom: (vis && (vis.last_name || vis.lastName)) || '',
        email: visEmail ? String(visEmail).toLowerCase() : null,
        telephone: (vis && vis.phone) || null,
        linkedin: (vis && (vis.linkedin_url || vis.linkedin)) || null,
        fonction: (vis && (vis.title || vis.headline)) || '',
        entreprise: co.name || co.company_name || '', domaine: co.domain || co.website || null,
        industrie: co.industry || null,
        effectif: co.employee_range || co.employee_count || co.size || null,
        ville: loc.city || null, region: loc.region || loc.state || null,
        pages: [], referrer: sess.referrer || null, pages_vues: sess.pages_viewed || null,
        event: bloc.event || 'company.identified',
        segment: bloc.segment || (Array.isArray(bloc.segments) ? bloc.segments[0] : null)
      });
    }
  }
  return items;
}

export default async function handler(req, res) {
  const q = req.query || {};

  // ── Test manuel (superadmin) : injecte un faux événement Snitcher et exécute la vraie logique ──
  // Permet de tester sans « Send Test » côté Snitcher (bouton « 🧪 Tester Snitcher » dans Paramètres).
  let estTest = false;
  if (q.test) {
    let user = null;
    try { const m = await import('./db.js'); user = m.verifierToken(req); } catch (_) {}
    if (!user || user.role !== 'superadmin') return res.status(401).json({ erreur: 'Test réservé au superadmin (connecte-toi en superadmin)' });
    estTest = true;
    req.body = {
      event: 'segment.entered',
      segment: { name: 'TEST Sofy Scrap' },
      company: { uuid: 'test_' + Date.now(), name: 'Entreprise Test Snitcher', domain: 'exemple-test-snitcher.fr', industry: 'Automobile', employee_range: '50-200', location: { city: 'Pointe-à-Pitre', region: 'Guadeloupe', country: 'France' } },
      session: { pages_viewed: 3, referrer: 'google.com' }
    };
  }

  if (!estTest) {
    const secretServeur = (process.env.SNITCHER_WEBHOOK_SECRET || '').trim();
    if (!secretServeur) {
      return res.status(401).json({ erreur: 'SNITCHER_WEBHOOK_SECRET absente côté serveur — créer la variable Vercel (Production cochée) puis Redeploy' });
    }
    // Auth : secret dans l'URL (?secret=) — comme RB2B — OU signature HMAC-SHA256 (en-tête Signature) si présente.
    const secretRecu = (req.query.secret || '').trim();
    let okAuth = !!secretRecu && secretRecu === secretServeur;
    const sig = (req.headers['signature'] || req.headers['x-signature'] || '').toString();
    if (!okAuth && sig) {
      try {
        const brut = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
        const attendu = crypto.createHmac('sha256', secretServeur).update(brut).digest('hex');
        if (sig === attendu) okAuth = true;
      } catch (_) {}
    }
    if (!okAuth) {
      if (req.method !== 'POST') return res.status(401).json({ erreur: 'Secret requis dans l\u2019URL (?secret=\u2026) — webhook Snitcher' });
      return res.status(401).json({ erreur: 'Secret invalide', indice: `re\u00e7u ${secretRecu.length} car., attendu ${secretServeur.length}` });
    }
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement (webhook Snitcher) — secret OK ✓' });
  }
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });
  await ensureSchema();

  try {
    const corps = req.body || {};

    // Journalise le DERNIER payload reçu → permet de vérifier/ajuster le mapping des vrais champs Snitcher.
    try {
      await sql`INSERT INTO config (cle, valeur) VALUES ('snitcher_last', ${JSON.stringify({ recu_le: new Date().toISOString(), event: corps.event || null, payload: corps })}::jsonb)
        ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`;
    } catch (_) {}

    const items = extraireItems(corps);
    let matches = 0, hotleads = 0;

    // Index des listes en veille 🔔
    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE veille = TRUE AND (veille_fin IS NULL OR veille_fin > NOW())`;

    // ── Phase 1 : entreprise/contact déjà présent dans une liste en veille → 🔥 sur la fiche ──
    for (const it of items) {
      const nomComplet = normaliserNom(`${it.prenom} ${it.nom}`);
      const email = it.email || '';
      const linkedin = normaliserLinkedin(it.linkedin);
      const domaine = (!DOMAINES_PERSO.has(domaineDe(email)) && domaineDe(email)) || domaineDe(it.domaine);
      const entrepriseNom = normaliserNom(it.entreprise);
      const titre = it.fonction || '';

      for (const l of listes) {
        let touche = null;
        (l.entreprises || []).forEach((e, ei) => {
          if (touche) return;
          const domE = domaineDe(e.site_web || (e.gmb && e.gmb.site_web) || '');
          const nomE = normaliserNom(e.enseigne_ia || e.enseigne || e.nom);
          // 1) Match contact (le plus fort) : linkedin, email ou nom complet
          for (let ci = 0; ci < (e.contacts || []).length; ci++) {
            const c = e.contacts[ci];
            const cLk = normaliserLinkedin(c.enrich && c.enrich.linkedin);
            const cEmail = (c.enrich && c.enrich.email || '').toLowerCase();
            const cNom = normaliserNom(`${c.prenom || ''} ${c.nom || ''}`);
            if ((linkedin && cLk && linkedin === cLk) || (email && cEmail && email === cEmail) || (nomComplet && cNom && nomComplet === cNom && nomComplet.includes(' '))) {
              touche = { ei, ci, qui: `${c.prenom || ''} ${c.nom || ''}`.trim() };
              return;
            }
          }
          // 2) Match entreprise : domaine identique, ou nom d'entreprise identique
          if ((domaine && domE && domaine === domE) || (entrepriseNom && nomE && entrepriseNom === nomE && entrepriseNom.length >= 5)) {
            touche = { ei, ci: -1, qui: nomComplet ? `${it.prenom} ${it.nom}`.trim() : (it.entreprise || 'Un visiteur') };
          }
        });

        if (!touche) continue;
        matches++;
        const e = l.entreprises[touche.ei];
        const entLabel = e.enseigne_ia || e.enseigne || e.nom;
        const detail = `${touche.qui}${titre ? ' (' + titre + ')' : ''} a visité sofy.fr 👀`;
        const sigObj = { type: 'visite_site', source: 'Snitcher', detail, date: new Date().toISOString() };
        e.signal_hot = true;
        if (touche.ci >= 0 && e.contacts && e.contacts[touche.ci]) e.contacts[touche.ci].signal = sigObj;
        else e.signal = sigObj;
        await sql`UPDATE listes SET entreprises = ${JSON.stringify(l.entreprises)} WHERE id = ${l.id}`;
        await sql`INSERT INTO signaux (liste_id, entreprise_nom, contact_nom, linkedin, type, source, detail, sdr)
          VALUES (${l.id}, ${entLabel}, ${touche.qui}, ${linkedin || ''}, 'visite_site', 'Snitcher', ${detail}, ${l.sdr})`;
        await envoyerSlack(`🔥🔥 *VISITE SITE EN DIRECT* — ${entLabel}\n${detail}\nListe « ${l.nom} » · SDR *${l.sdr}* → c'est LE moment d'appeler ☎️`);
      }
    }

    // ── Phase 2 : entreprise/contact non présent → liste 🔥 Hot Leads (auto), sauf clients HubSpot ──
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'hotleads'`;
    const cfgHL = cfgRows.length ? cfgRows[0].valeur : {};
    if (cfgHL.actif !== false) {
      for (const it of items) {
        const nomC = `${it.prenom} ${it.nom}`.trim();
        if (!nomC && !it.email && !it.entreprise) continue;
        const segNom = it.segment ? (typeof it.segment === 'string' ? it.segment : (it.segment.name || 'ICP')) : null;
        const ctx = segNom ? `entrée dans le segment « ${segNom} »` : 'visite sofy.fr';
        const r2 = await ajouterHotLead({
          nom_complet: nomC, email: it.email,
          entreprise: it.entreprise,
          domaine: domaineDe(it.domaine),
          linkedin_brut: it.linkedin || null,
          fonction: it.fonction || '',
          effectif: it.effectif || null,
          industrie: it.industrie || null,
          ville: it.ville || null,
          region: it.region || null,
          pages_visitees: it.pages || [],
          source: 'Snitcher', type: 'visite_site',
          detail: `${nomC || it.entreprise || 'Une entreprise'} — ${ctx}`
        }, cfgHL);
        if (r2.ajoute) {
          hotleads++;
          const lienListe = `${(process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '')}/?liste=${r2.liste_id}&fiche=${encodeURIComponent(r2.cle_fiche || '')}`;
          await envoyerSlack(`🔥 *Nouveau Hot Lead* (${ctx}) — ${it.entreprise || nomC}${it.fonction ? ' · ' + it.fonction : ''}${it.industrie ? ' · ' + it.industrie : ''}\n📂 <${lienListe}|Ouvrir la fiche dans Sofy Scrap> — enrichissement auto au chargement`);
        }
      }
    }

    return res.status(200).json({ ok: true, recus: items.length, matches, hotleads });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur Snitcher', detail: err.message });
  }
}
