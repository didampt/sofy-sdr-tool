// /api/rb2b.js — Récepteur temps réel des visiteurs identifiés sur sofy.fr (webhook RB2B)
// RB2B pousse un événement à chaque visiteur identifié → on croise avec les listes en veille 🔔
// (par email, domaine d'entreprise, LinkedIn ou nom) → 🔥 sur la fiche + alerte Slack immédiate.
//
// Sécurité : l'URL du webhook contient un secret → https://…/api/rb2b?secret=RB2B_WEBHOOK_SECRET
// Variables Vercel : RB2B_WEBHOOK_SECRET (longue chaîne aléatoire), SLACK_WEBHOOK_URL

import { sql, ensureSchema, ajouterHotLead } from './db.js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secretServeur = (process.env.RB2B_WEBHOOK_SECRET || '').trim();
  const secretRecu = (req.query.secret || '').trim();
  if (!secretServeur) {
    // Diagnostic explicite : la variable n'est pas visible par la fonction (pas créée, mauvais environnement, ou pas redéployé)
    return res.status(401).json({ erreur: 'RB2B_WEBHOOK_SECRET absente côté serveur — vérifier la variable Vercel (environnement Production coché) puis Redeploy' });
  }
  if (secretRecu !== secretServeur) {
    return res.status(401).json({ erreur: 'Secret différent de celui du serveur', indice: `reçu ${secretRecu.length} caractères, attendu ${secretServeur.length}` });
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement (webhook RB2B) — secret OK ✓' });
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });
  await ensureSchema();

  try {
    // RB2B envoie un objet (ou un tableau) par visiteur identifié — champs usuels :
    // first_name/last_name (ou FirstName…), email, linkedin_url, company_name, company_domain/website, title, page/url
    const corps = req.body || {};
    const visiteurs = Array.isArray(corps) ? corps : [corps];
    let matches = 0;

    // Index des listes en veille
    const listes = await sql`SELECT id, nom, sdr, entreprises FROM listes
      WHERE veille = TRUE AND (veille_fin IS NULL OR veille_fin > NOW())`;

    for (const vBrut of visiteurs) {
      // Normalisation des champs (RB2B varie selon les versions : on ratisse large, insensible à la casse)
      const v = {};
      for (const [k, val] of Object.entries(vBrut || {})) v[k.toLowerCase().replace(/[^a-z]/g, '')] = val;
      const prenom = v.firstname || '';
      const nom = v.lastname || '';
      const nomComplet = normaliserNom(`${prenom} ${nom}`) || normaliserNom(v.fullname || v.name || '');
      const email = (v.email || v.businessemail || '').toLowerCase();
      const linkedin = normaliserLinkedin(v.linkedinurl || v.linkedin || '');
      const domaine = (!DOMAINES_PERSO.has(domaineDe(email)) && domaineDe(email)) || domaineDe(v.companydomain || v.website || v.companywebsite || '');
      const entrepriseNom = normaliserNom(v.companyname || v.company || '');
      const page = v.page || v.url || v.lastpage || v.pageurl || 'sofy.fr';
      const titre = v.title || v.jobtitle || '';

      for (const l of listes) {
        let touche = null;
        (l.entreprises || []).forEach((e, ei) => {
          if (touche) return;
          const domE = domaineDe(e.site_web || (e.gmb && e.gmb.site_web) || '');
          const nomE = normaliserNom(e.enseigne_ia || e.enseigne || e.nom);
          // 1. Match contact (le plus fort) : linkedin, email ou nom complet
          for (let ci = 0; ci < (e.contacts || []).length; ci++) {
            const c = e.contacts[ci];
            const cLk = normaliserLinkedin(c.enrich && c.enrich.linkedin);
            const cEmail = (c.enrich && c.enrich.email || '').toLowerCase();
            const cNom = normaliserNom(`${c.prenom || ''} ${c.nom || ''}`);
            if ((linkedin && cLk && linkedin === cLk) || (email && cEmail && email === cEmail) || (nomComplet && cNom && nomComplet === cNom && nomComplet.includes(' '))) {
              touche = { ei, ci, type: 'contact', qui: `${c.prenom || ''} ${c.nom || ''}`.trim() };
              return;
            }
          }
          // 2. Match entreprise : domaine identique, ou nom d'entreprise identique
          if ((domaine && domE && domaine === domE) || (entrepriseNom && nomE && entrepriseNom === nomE && entrepriseNom.length >= 5)) {
            touche = { ei, ci: -1, type: 'entreprise', qui: nomComplet ? `${prenom} ${nom}`.trim() : 'Un visiteur' };
          }
        });

        if (!touche) continue;
        matches++;
        const e = l.entreprises[touche.ei];
        const entLabel = e.enseigne_ia || e.enseigne || e.nom;
        const detail = `${touche.qui}${titre ? ' (' + titre + ')' : ''} a visité ${page} 👀`;
        const sig = { type: 'visite_site', source: 'RB2B', detail, date: new Date().toISOString() };
        e.signal_hot = true;
        if (touche.ci >= 0 && e.contacts && e.contacts[touche.ci]) e.contacts[touche.ci].signal = sig;
        else e.signal = sig;
        await sql`UPDATE listes SET entreprises = ${JSON.stringify(l.entreprises)} WHERE id = ${l.id}`;
        await sql`INSERT INTO signaux (liste_id, entreprise_nom, contact_nom, linkedin, type, source, detail, sdr)
          VALUES (${l.id}, ${entLabel}, ${touche.qui}, ${linkedin || ''}, 'visite_site', 'RB2B', ${detail}, ${l.sdr})`;
        await envoyerSlack(`🔥🔥 *VISITE SITE EN DIRECT* — ${touche.qui} (${entLabel})\n${detail}\nListe « ${l.nom} » · SDR *${l.sdr}* → c'est LE moment d'appeler ☎️`);
      }
    }

    // ── Visiteurs NON matchés → liste 🔥 Hot Leads (auto), sauf clients HubSpot ──
    let hotleads = 0;
    const cfgRows = await sql`SELECT valeur FROM config WHERE cle = 'hotleads'`;
    const cfgHL = cfgRows.length ? cfgRows[0].valeur : {};
    if (cfgHL.actif !== false) {
      for (const vBrut of visiteurs) {
        const v = {};
        for (const [k, val] of Object.entries(vBrut || {})) v[k.toLowerCase().replace(/[^a-z]/g, '')] = val;
        const nomC = `${v.firstname || ''} ${v.lastname || ''}`.trim() || v.fullname || v.name || '';
        const email = (v.email || v.businessemail || '').toLowerCase() || null;
        const ent = v.companyname || v.company || '';
        if (!nomC && !email && !ent) continue;
        // ── Pages visitées (RecentPageUrls = JSON ou liste) → signal produit ──
        let pages = [];
        const rawPages = v.recentpageurls || v.recentpages || v.pageurls || v.page || v.url || '';
        try {
          if (Array.isArray(rawPages)) pages = rawPages;
          else if (typeof rawPages === 'string' && rawPages.trim().startsWith('[')) pages = JSON.parse(rawPages);
          else if (rawPages) pages = [rawPages];
        } catch (_) { if (rawPages) pages = [String(rawPages)]; }
        pages = pages.map(p => String(p).replace(/^https?:\/\/(www\.)?sofy\.fr/i, '').trim() || '/').filter(Boolean);
        const pagesTxt = pages.length ? pages.join(', ') : 'sofy.fr';

        const r2 = await ajouterHotLead({
          nom_complet: nomC, email,
          entreprise: ent,
          domaine: domaineDe(v.companydomain || v.website || v.companywebsite || ''),
          linkedin_brut: v.linkedinurl || v.linkedin || null,
          // Pour ProfileType=Company, LinkedInUrl EST l'URL de la page société
          linkedin_societe: (v.profiletype === 'Company' || v.profiletype === 'company') ? (v.linkedinurl || v.linkedin || null) : (v.companylinkedinurl || null),
          fonction: v.title || v.jobtitle || '',
          effectif: v.estimatedemployeecount || v.employeecount || null,
          ca_estime: v.estimaterevenue || v.estimatedrevenue || v.revenue || null,
          industrie: v.industry || null,
          ville: v.city || null,
          region: v.state || null,
          pages_visitees: pages,
          nb_visites: v.recentpagecount || v.alltimepageviews || null,
          date_visite: v.lastseenat || v.firstseenat || null,
          source: 'RB2B', type: 'visite_site',
          detail: `${nomC || ent || 'Un visiteur'} a visité ${pagesTxt}`
        }, cfgHL);
        if (r2.ajoute) {
          hotleads++;
          const prod = pages.find(p => /so-?reach/i.test(p)) ? 'SoReach' : pages.find(p => /so-?view|avis/i.test(p)) ? 'Soview' : pages.find(p => /so-?connect|budy|messaging/i.test(p)) ? 'SoConnect' : null;
          await envoyerSlack(`🔥 *Nouveau Hot Lead* (visite sofy.fr) — ${ent || nomC}${v.title ? ' · ' + v.title : ''}${v.industry ? ' · ' + v.industry : ''}\n👀 Pages : ${pagesTxt}${prod ? ` → intérêt probable *${prod}*` : ''}\n→ ajouté à « 🔥 Hot Leads (auto) » (enrichissement auto en cours)`);
        }
      }
    }

    return res.status(200).json({ ok: true, recus: visiteurs.length, matches, hotleads });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur RB2B', detail: err.message });
  }
}
