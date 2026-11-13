// /api/leads.js — 🎯 Les LEADS du commercial (onglets « Nouveau lead » et « Mes leads »).
//
// Constat du 13/11/2026 (Didier) : les sales prospectent et appellent dans Lemlist ; ce qu'ils
// viennent chercher ici, ce sont les documents client (prez, étude ROI). Un document ne doit donc
// plus exiger une liste d'appel : il part d'un LEAD, importé de Lemlist ou saisi à la main.
//
// Un lead est une fiche ordinaire, rangée dans une liste personnelle « 🎯 Mes leads — <nom> »
// (criteres.mes_leads). C'est ce qui évite de réécrire quoi que ce soit : l'analyse (fiche
// Google, technos, scoring, relevés SerpApi), la prez et le suivi d'ouverture travaillent déjà
// sur (liste_id, fiche) — le front charge cette liste en silence et appelle les mêmes fonctions.
//
// GET                    → { liste_id } (crée la liste personnelle au premier appel)
// GET  ?q=…              → recherche dans l'index Lemlist : nom, entreprise, email, téléphone
// POST { action:'indexer', force? } → rafraîchit l'index, campagne par campagne (reprise possible)
// POST { entreprise, nom_complet?, email?, telephone?, linkedin?, fonction?, site_web?, ville?,
//        origine:'manuel'|'lemlist', lemlist_id?, campagne? } → ajoute le lead (ou complète la
//        fiche si l'entreprise y est déjà) → { liste_id, lead_id, nom, cree }
// DELETE ?lead_id=…      → retire le lead de la liste
//
// Pourquoi un INDEX : l'API Lemlist n'a pas de recherche de lead par nom — seulement un export
// CSV par campagne. On recopie donc, à la demande, les leads des campagnes dans une table
// PARESSEUSE (pas de bump SCHEMA_VERSION), et la barre de recherche l'interroge en SQL.

import { verifierToken, sql, ensureSchema } from './db.js';
import { leadsDuCsv } from './lemlist-import.js';
import crypto from 'crypto';

export const config = { maxDuration: 60 };

const FRAICHEUR_H = 6;          // une campagne indexée depuis moins de 6 h n'est pas relue
const BUDGET_MS = 40000;        // on rend la main avant la limite Vercel ; le front relance

let indexPret = false;
async function ensureIndex() {
  if (indexPret) return;
  await sql`CREATE TABLE IF NOT EXISTS lemlist_index (
    campagne_id TEXT NOT NULL,
    campagne_nom TEXT,
    lemlist_id TEXT,
    email TEXT, prenom TEXT, nom TEXT, entreprise TEXT, telephone TEXT,
    linkedin TEXT, fonction TEXT, ville TEXT, site TEXT,
    tel9 TEXT,
    h TEXT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_lemidx_camp ON lemlist_index(campagne_id)`;
  await sql`CREATE TABLE IF NOT EXISTS lemlist_index_etat (
    campagne_id TEXT PRIMARY KEY, campagne_nom TEXT, nb INTEGER DEFAULT 0, maj TIMESTAMPTZ
  )`;
  indexPret = true;
}

// Même normalisation à l'indexation et à la recherche : minuscules, sans accents.
export const normaliser = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9@.+\-_ ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Les 9 derniers chiffres : +33 6 12 34 56 78, 0612345678 et 612345678 deviennent la même clé.
export const tel9 = s => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };

function enteteLemlist() {
  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey) return null;
  return { 'Authorization': 'Basic ' + Buffer.from(':' + apiKey).toString('base64') };
}

async function indexerCampagne(headers, c) {
  const r = await fetch(`https://api.lemlist.com/api/campaigns/${encodeURIComponent(c.id)}/export/leads?state=all`, { headers });
  const texte = await r.text();
  if (!r.ok) throw new Error('export ' + r.status);
  const { leads } = leadsDuCsv(texte);
  const lignes = leads.slice(0, 5000).map(l => ({
    campagne_id: c.id, campagne_nom: c.nom, lemlist_id: l.lemlist_id || null,
    email: l.email || null, prenom: l.prenom || null, nom: l.nom || null, entreprise: l.entreprise || null,
    telephone: l.telephone || null, linkedin: l.linkedin || null, fonction: l.fonction || null,
    ville: l.ville || null, site: l.site || null,
    tel9: tel9(l.telephone) || null,
    h: normaliser([l.prenom, l.nom, l.entreprise, l.email].filter(Boolean).join(' '))
  }));
  await sql`DELETE FROM lemlist_index WHERE campagne_id = ${c.id}`;
  for (let i = 0; i < lignes.length; i += 400) {
    await sql`INSERT INTO lemlist_index (campagne_id, campagne_nom, lemlist_id, email, prenom, nom, entreprise,
        telephone, linkedin, fonction, ville, site, tel9, h)
      SELECT campagne_id, campagne_nom, lemlist_id, email, prenom, nom, entreprise, telephone, linkedin,
        fonction, ville, site, tel9, h
      FROM jsonb_to_recordset(${JSON.stringify(lignes.slice(i, i + 400))}::jsonb) AS x(
        campagne_id TEXT, campagne_nom TEXT, lemlist_id TEXT, email TEXT, prenom TEXT, nom TEXT,
        entreprise TEXT, telephone TEXT, linkedin TEXT, fonction TEXT, ville TEXT, site TEXT, tel9 TEXT, h TEXT)`;
  }
  await sql`INSERT INTO lemlist_index_etat (campagne_id, campagne_nom, nb, maj) VALUES (${c.id}, ${c.nom}, ${lignes.length}, NOW())
    ON CONFLICT (campagne_id) DO UPDATE SET campagne_nom = EXCLUDED.campagne_nom, nb = EXCLUDED.nb, maj = NOW()`;
  return lignes.length;
}

async function indexer(force) {
  const headers = enteteLemlist();
  if (!headers) return { erreur: 'LEMLIST_API_KEY manquante dans Vercel' };
  const debut = Date.now();
  const r = await fetch('https://api.lemlist.com/api/campaigns?version=v2&limit=100&sortBy=createdAt&sortOrder=desc', { headers });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) return { erreur: 'Lemlist campagnes : ' + r.status };
  const campagnes = (Array.isArray(d) ? d : (d.campaigns || []))
    .map(c => ({ id: c._id || c.id, nom: c.name || c.nom || c._id })).filter(c => c.id);
  const etats = await sql`SELECT campagne_id, maj FROM lemlist_index_etat`;
  const frais = new Set(etats.filter(e => e.maj && (Date.now() - new Date(e.maj).getTime()) < FRAICHEUR_H * 3600000).map(e => e.campagne_id));
  const aFaire = campagnes.filter(c => force || !frais.has(c.id));
  let faites = 0, leads = 0;
  const erreurs = [];
  // 3 de front : l'API Lemlist plafonne à 20 requêtes / 2 s, on reste très en dessous.
  while (aFaire.length && Date.now() - debut < BUDGET_MS) {
    const lot = aFaire.splice(0, 3);
    const res = await Promise.allSettled(lot.map(c => indexerCampagne(headers, c)));
    res.forEach((x, i) => {
      if (x.status === 'fulfilled') { faites++; leads += x.value; }
      else {
        erreurs.push(lot[i].nom + ' : ' + String((x.reason && x.reason.message) || x.reason).slice(0, 80));
        // Une campagne illisible ne doit pas être retentée à chaque passe : on la marque vue.
        sql`INSERT INTO lemlist_index_etat (campagne_id, campagne_nom, nb, maj) VALUES (${lot[i].id}, ${lot[i].nom}, 0, NOW())
          ON CONFLICT (campagne_id) DO UPDATE SET maj = NOW()`.catch(() => {});
      }
    });
  }
  return { ok: true, campagnes: campagnes.length, indexees: faites, leads, restantes: aFaire.length, erreurs: erreurs.slice(0, 5) };
}

async function etatIndex() {
  const [e] = await sql`SELECT COUNT(*)::int AS campagnes, COALESCE(SUM(nb),0)::int AS leads, MIN(maj) AS plus_ancienne, MAX(maj) AS plus_recente FROM lemlist_index_etat`;
  return e || { campagnes: 0, leads: 0, plus_ancienne: null, plus_recente: null };
}

async function chercher(q) {
  const brut = String(q || '').trim().slice(0, 80);
  const chiffres = brut.replace(/\D/g, '');
  // Un numéro : au moins 6 chiffres et presque rien d'autre.
  if (chiffres.length >= 6 && brut.replace(/[\d\s+().\-]/g, '').length === 0) {
    const cle = chiffres.length >= 9 ? chiffres.slice(-9) : chiffres;
    return sql`SELECT campagne_id, campagne_nom, lemlist_id, email, prenom, nom, entreprise, telephone, linkedin, fonction, ville, site
      FROM lemlist_index WHERE tel9 LIKE ${'%' + cle + '%'} LIMIT 25`;
  }
  const mots = normaliser(brut).split(' ').filter(m => m.length >= 2).slice(0, 3);
  if (!mots.length) return [];
  const p = i => '%' + (mots[i] || '') + '%';   // un mot absent devient « % » : il ne filtre rien
  return sql`SELECT campagne_id, campagne_nom, lemlist_id, email, prenom, nom, entreprise, telephone, linkedin, fonction, ville, site
    FROM lemlist_index WHERE h LIKE ${p(0)} AND h LIKE ${p(1)} AND h LIKE ${p(2)}
    ORDER BY (email IS NULL), entreprise NULLS LAST LIMIT 25`;
}

async function maListe(user) {
  const rows = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'mes_leads' = 'true' AND sdr = ${user.nom} ORDER BY id LIMIT 1`;
  if (rows.length) return rows[0];
  const crea = await sql`INSERT INTO listes (nom, sdr, criteres, criteres_hash, entreprises, total)
    VALUES (${'🎯 Mes leads — ' + user.nom}, ${user.nom}, ${JSON.stringify({ mes_leads: true })}, ${'mes_leads:' + user.nom}, '[]', 0)
    RETURNING id, entreprises`;
  return crea[0];
}

const propre = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
const domaineDe = v => propre(v, 200).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
const cleNom = v => normaliser(v).replace(/\b(sas|sarl|sa|eurl|sasu|groupe|group)\b/g, '').replace(/\s+/g, ' ').trim();

export default async function handler(req, res) {
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });
  await ensureSchema();
  const q = req.query || {};

  try {
    if (req.method === 'GET') {
      if (q.q != null) {
        await ensureIndex();
        const resultats = await chercher(q.q);
        return res.status(200).json({ ok: true, resultats, index: await etatIndex() });
      }
      if (q.index === '1') { await ensureIndex(); return res.status(200).json({ ok: true, index: await etatIndex() }); }
      const l = await maListe(user);
      return res.status(200).json({ ok: true, liste_id: l.id, nb: (l.entreprises || []).length });
    }

    if (req.method === 'DELETE') {
      const id = propre(q.lead_id, 40);
      if (!id) return res.status(400).json({ erreur: 'lead_id requis' });
      const l = await maListe(user);
      const ents = (l.entreprises || []).filter(e => e.lead_id !== id);
      if (ents.length === (l.entreprises || []).length) return res.status(404).json({ erreur: 'Lead introuvable' });
      await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)}::jsonb, total = ${ents.length} WHERE id = ${l.id}`;
      return res.status(200).json({ ok: true, liste_id: l.id });
    }

    if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET, POST ou DELETE' });
    const b = req.body || {};

    if (b.action === 'indexer') {
      await ensureIndex();
      const out = await indexer(!!b.force);
      if (out.erreur) return res.status(502).json(out);
      return res.status(200).json({ ...out, index: await etatIndex() });
    }

    const nomComplet = propre(b.nom_complet, 120);
    const email = propre(b.email, 160).toLowerCase();
    const site = domaineDe(b.site_web) || ((email && !/@(gmail|outlook|hotmail|yahoo|orange|wanadoo|free|sfr|laposte|icloud|live)\./.test(email)) ? email.split('@')[1] || '' : '');
    // L'analyse porte sur l'ENTREPRISE : sans elle (ni site pour la déduire), il n'y a rien à mesurer.
    const entreprise = propre(b.entreprise, 120) || (site ? site.split('.')[0].replace(/[-_]/g, ' ') : '');
    if (!entreprise) return res.status(400).json({ erreur: "Entreprise requise : c'est elle que l'analyse mesure (son nom, ou son site web)." });

    const l = await maListe(user);
    const ents = l.entreprises || [];
    const morceaux = nomComplet.split(/\s+/).filter(Boolean);
    const contact = (nomComplet || email || b.telephone || b.linkedin) ? {
      prenom: morceaux[0] || '', nom: morceaux.slice(1).join(' '),
      fonction: propre(b.fonction, 120), source: 'lead',
      lemlist_id: propre(b.lemlist_id, 60) || undefined,
      enrich: { email: email || null, linkedin: propre(b.linkedin, 300) || null, telephone: propre(b.telephone, 40) || null }
    } : null;
    const maintenant = new Date().toISOString();

    // Même entreprise déjà dans mes leads (nom ou domaine) : on complète la fiche, on ne la double pas.
    const k = cleNom(entreprise);
    const existante = ents.find(e => (k && cleNom(e.enseigne || e.nom) === k) || (site && domaineDe(e.site_web) === site));
    if (existante) {
      if (!existante.lead_id) existante.lead_id = crypto.randomBytes(6).toString('hex');
      if (!existante.site_web && site) existante.site_web = 'https://' + site;
      if (!existante.ville && b.ville) existante.ville = propre(b.ville, 80);
      if (contact) {
        const cs = existante.contacts = existante.contacts || [];
        const meme = c => (email && c.enrich && c.enrich.email === email)
          || (contact.enrich.linkedin && c.enrich && c.enrich.linkedin === contact.enrich.linkedin)
          || (nomComplet && normaliser((c.prenom || '') + ' ' + (c.nom || '')) === normaliser(nomComplet));
        if (!cs.some(meme)) cs.push(contact);
      }
      await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)}::jsonb, total = ${ents.length} WHERE id = ${l.id}`;
      return res.status(200).json({ ok: true, cree: false, liste_id: l.id, lead_id: existante.lead_id, nom: existante.nom,
        info: 'Cette entreprise est déjà dans tes leads — fiche complétée.' });
    }

    const leadId = crypto.randomBytes(6).toString('hex');
    ents.unshift({
      nom: entreprise, enseigne: entreprise, siren: null,
      site_web: site ? 'https://' + site : null,
      ville: propre(b.ville, 80) || null,
      source: 'lead', lead_id: leadId, date_lead: maintenant,
      lead_origine: b.origine === 'lemlist' ? 'lemlist' : 'manuel',
      lead_campagne: propre(b.campagne, 120) || null,
      contacts: contact ? [contact] : []
    });
    const finales = ents.slice(0, 500);
    await sql`UPDATE listes SET entreprises = ${JSON.stringify(finales)}::jsonb, total = ${finales.length} WHERE id = ${l.id}`;
    return res.status(200).json({ ok: true, cree: true, liste_id: l.id, lead_id: leadId, nom: entreprise });
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur leads', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
