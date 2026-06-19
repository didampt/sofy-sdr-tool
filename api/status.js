// /api/status.js — Statut des connexions : présence des clés (jamais leur valeur)

import { verifierToken } from './db.js';

const OUTILS = [
  { id: 'pappers',     nom: 'Pappers',          env: 'PAPPERS_API_KEY',        role: 'Extraction entreprises & dirigeants' },
  { id: 'gplaces',     nom: 'Google Places',    env: 'GOOGLE_PLACES_API_KEY',  role: 'Score GMB, avis, concurrents' },
  { id: 'fullenrich',  nom: 'FullEnrich',       env: 'FULLENRICH_API_KEY',     role: 'Email + mobile (waterfall 1)' },
  { id: 'dropcontact', nom: 'Dropcontact',      env: 'DROPCONTACT_API_KEY',    role: 'Email vérifié (waterfall 2)' },
  { id: 'kaspr',       nom: 'Kaspr',            env: 'KASPR_API_KEY',          role: 'Mobile FR via LinkedIn (waterfall 3)' },
  { id: 'leadmagic',   nom: 'LeadMagic',        env: 'LEADMAGIC_API_KEY',      role: 'Email US/international (plus tard)' },
  { id: 'hubspot',     nom: 'HubSpot',          env: 'HUBSPOT_API_KEY',        role: 'Dédoublonnage CRM + transaction AE' },
  { id: 'lemlist',     nom: 'Lemlist',          env: 'LEMLIST_API_KEY',        role: 'Envoi en séquence email' },
  { id: 'ringover',    nom: 'Ringover',         env: 'RINGOVER_API_KEY',       role: 'Appel click-to-call' },
  { id: 'sofy',        nom: 'Sofy (SoReach)',   env: 'SOFY_API_KEY_ID',        env2: 'SOFY_API_KEY_SECRET', role: 'Envoi SMS via api.sofy.fr' },
  { id: 'slack',       nom: 'Slack Webhook',    env: 'SLACK_WEBHOOK_URL',      role: 'Alertes signaux' },
  { id: 'claude',      nom: 'Claude API',       env: 'ANTHROPIC_API_KEY',      role: 'Scoring, synthèses, emails perso' },
  { id: 'phantom',     nom: 'PhantomBuster',    env: 'PHANTOMBUSTER_API_KEY',  role: 'Signaux LinkedIn' },
  { id: 'rb2b',        nom: 'RB2B',             env: 'RB2B_WEBHOOK_SECRET',    role: 'Visiteurs du site sofy.fr (webhook temps réel)' },
  { id: 'basile',      nom: 'Basile',           env: 'BASILE_API_KEY',         role: 'Recherche de leads B2B française (Liste intelligente IA)' }
];

function chercherNombre(obj, motifs) {
  // Trouve la première valeur numérique dont la clé contient un des motifs (ex: "credit", "jeton")
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    if (motifs.some(m => kl.includes(m))) {
      const n = Number(v);
      if (!isNaN(n)) return n;
    }
    if (v && typeof v === 'object') {
      const r = chercherNombre(v, motifs);
      if (r !== null) return r;
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Sécurité : réservé aux utilisateurs authentifiés (évite la cartographie de l'infra)
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Non authentifié' });
  // Le mode test (?test=1) ping réellement les APIs → réservé aux admins
  const veutTest = req.query && (req.query.test === '1' || req.query.test === 'true');
  const estAdmin = ['admin', 'superadmin'].includes(user.role);
  if (veutTest && !estAdmin) return res.status(403).json({ erreur: 'Test réservé aux admins' });
  const statut = OUTILS.map(o => ({
    id: o.id,
    nom: o.nom,
    role: o.role,
    variable: o.env,
    variable_2: o.env2 || undefined,
    configuree: !!(process.env[o.env] && process.env[o.env].trim()) && (!o.env2 || !!(process.env[o.env2] && process.env[o.env2].trim()))
  }));

  // ── Soldes ──
  const soldes = {};
  // Pappers : solde en direct
  try {
    if (process.env.PAPPERS_API_KEY) {
      const r = await fetch(`https://api.pappers.fr/v2/suivi?api_token=${process.env.PAPPERS_API_KEY}`);
      if (r.ok) soldes.pappers = chercherNombre(await r.json(), ['credit', 'jeton', 'restant']);
    }
  } catch (_) {}
  // Derniers soldes connus (mis à jour par les enrichissements)
  try {
    const { sql, ensureSchema } = await import('./db.js');
    if (sql) {
      await ensureSchema();
      const rows = await sql`SELECT api, solde, maj FROM etats_api`;
      for (const r of rows) if (soldes[r.api] === undefined) soldes[r.api] = Number(r.solde);
    }
  } catch (_) {}

  // ── Mode TEST réel : ping chaque API pour vérifier que la clé fonctionne (détecte les 401/403) ──
  let tests = null;
  if (req.query && (req.query.test === '1' || req.query.test === 'true')) {
    tests = {};
    const fin = (etat, detail) => ({ etat, detail }); // etat: 'ok' | 'erreur' | 'absent'
    // Helper : timeout court pour ne pas bloquer
    const pf = (url, opts = {}) => Promise.race([
      fetch(url, opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);

    // Pappers
    try {
      if (!process.env.PAPPERS_API_KEY) tests.pappers = fin('absent', 'Clé manquante');
      else { const r = await pf(`https://api.pappers.fr/v2/recherche?api_token=${process.env.PAPPERS_API_KEY}&code_naf=4511Z&par_page=1`); tests.pappers = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.pappers = fin('erreur', e.message); }

    // Kaspr (le cas qui t'intéresse : 401 = clé morte)
    try {
      if (!process.env.KASPR_API_KEY) tests.kaspr = fin('absent', 'Clé manquante');
      else {
        const r = await pf('https://api.developers.kaspr.io/profile/linkedin', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.KASPR_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedinUrl: 'https://www.linkedin.com/in/test-monitoring-key' }) });
        tests.kaspr = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : fin('ok', 'Clé valide');
      }
    } catch (e) { tests.kaspr = fin('erreur', e.message); }

    // FullEnrich
    try {
      if (!process.env.FULLENRICH_API_KEY) tests.fullenrich = fin('absent', 'Clé manquante');
      else { const r = await pf('https://app.fullenrich.com/api/v1/account/credits', { headers: { 'Authorization': `Bearer ${process.env.FULLENRICH_API_KEY}` } }); tests.fullenrich = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.fullenrich = fin('erreur', e.message); }

    // Dropcontact
    try {
      if (!process.env.DROPCONTACT_API_KEY) tests.dropcontact = fin('absent', 'Clé manquante');
      else { const r = await pf('https://api.dropcontact.com/v1/enrich/all/test-monitoring', { headers: { 'X-Access-Token': process.env.DROPCONTACT_API_KEY } }); tests.dropcontact = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : fin('ok', 'Clé valide'); }
    } catch (e) { tests.dropcontact = fin('erreur', e.message); }

    // HubSpot
    try {
      if (!process.env.HUBSPOT_API_KEY) tests.hubspot = fin('absent', 'Clé manquante');
      else { const r = await pf('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { 'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}` } }); tests.hubspot = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.hubspot = fin('erreur', e.message); }

    // Lemlist
    try {
      if (!process.env.LEMLIST_API_KEY) tests.lemlist = fin('absent', 'Clé manquante');
      else { const r = await pf('https://api.lemlist.com/api/team', { headers: { 'Authorization': 'Basic ' + Buffer.from(':' + process.env.LEMLIST_API_KEY).toString('base64') } }); tests.lemlist = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.lemlist = fin('erreur', e.message); }

    // Ringover
    try {
      if (!process.env.RINGOVER_API_KEY) tests.ringover = fin('absent', 'Clé manquante');
      else { const r = await pf('https://public-api.ringover.com/v2/contacts?limit=1', { headers: { 'Authorization': process.env.RINGOVER_API_KEY } }); tests.ringover = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.ringover = fin('erreur', e.message); }

    // PhantomBuster
    try {
      if (!process.env.PHANTOMBUSTER_API_KEY) tests.phantom = fin('absent', 'Clé manquante');
      else { const r = await pf('https://api.phantombuster.com/api/v2/agents/fetch-all', { headers: { 'X-Phantombuster-Key-1': process.env.PHANTOMBUSTER_API_KEY } }); tests.phantom = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.phantom = fin('erreur', e.message); }

    // Slack (webhook : on ne peut pas ping sans envoyer ; on vérifie juste le format)
    if (!process.env.SLACK_WEBHOOK_URL) tests.slack = fin('absent', 'Webhook manquant');
    else tests.slack = (process.env.SLACK_WEBHOOK_URL.startsWith('https://hooks.slack.com/')) ? fin('ok', 'Webhook configuré') : fin('erreur', 'Format inattendu');

    // Claude
    try {
      if (!process.env.ANTHROPIC_API_KEY) tests.claude = fin('absent', 'Clé manquante');
      else { const r = await pf('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) }); tests.claude = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok || r.status === 400 ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`)); }
    } catch (e) { tests.claude = fin('erreur', e.message); }

    // ── Basile : comptage gratuit (limit:1) ; 401 = clé refusée ──
    try {
      if (!process.env.BASILE_API_KEY) tests.basile = fin('absent', 'Clé manquante');
      else {
        const r = await pf('https://api.basile.cc/people/find', { method: 'POST', headers: { 'Authorization': process.env.BASILE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1, filters: { result_country_code: { include: ['FR'] } } }) });
        tests.basile = (r.status === 401 || r.status === 403) ? fin('erreur', `Clé refusée (HTTP ${r.status})`) : (r.ok ? fin('ok', 'Clé valide') : fin('erreur', `HTTP ${r.status}`));
      }
    } catch (e) { tests.basile = fin('erreur', e.message); }
  }

  res.status(200).json({ outils: statut, soldes, tests });
}
