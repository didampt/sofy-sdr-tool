// /api/monitor.js — Monitoring automatique des APIs (cron 2×/jour).
// Ping les clés + vérifie les soldes. Alerte Slack UNIQUEMENT si problème (clé down / solde bas).
// Anti-spam : ne réalerte pas pour la même API tant qu'elle n'est pas redevenue OK (état en base config).

const SEUILS = { pappers: 300, dropcontact: 100, fullenrich: 50, kaspr: 50 };

async function slack(texte) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texte }) });
  } catch (_) {}
}

const pf = (u, o = {}) => Promise.race([
  fetch(u, o),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
]);

// Teste une clé : renvoie 'ok' | 'down' | 'absent'
async function testKey(present, fn) {
  if (!present) return 'absent';
  try {
    const r = await fn();
    // Seul un refus d'authentification (401/403) = clé morte.
    // 200/400/404 = la clé est acceptée (ressource de test inexistante, peu importe).
    if (r.status === 401 || r.status === 403) return 'down';
    return 'ok';
  } catch (e) {
    // Timeout / réseau : on ne crie pas "down" pour un aléa réseau ponctuel
    return e.message === 'timeout' ? 'ok' : 'down';
  }
}

export default async function handler(req, res) {
  // Sécurité : réservé au cron Vercel (header) ou au superadmin
  const estCron = req.headers['x-vercel-cron'] || (req.query && req.query.cron_secret === process.env.PHANTOMBUSTER_CRON_SECRET);
  let user = null;
  if (!estCron) {
    try { const { verifierToken } = await import('./db.js'); user = verifierToken(req); } catch (_) {}
    if (!user || user.role !== 'superadmin') {
      return res.status(401).json({ erreur: 'Réservé au cron ou au superadmin' });
    }
  }

  const env = process.env;
  const problemes = [];   // { nom, type, detail }
  const okMaintenant = []; // noms des APIs OK (pour réinitialiser l'anti-spam)

  // ── 1. Tests de clés ──
  const checks = [
    ['Pappers', !!env.PAPPERS_API_KEY, () => pf(`https://api.pappers.fr/v2/recherche?api_token=${env.PAPPERS_API_KEY}&code_naf=4511Z&par_page=1`)],
    ['Kaspr', !!env.KASPR_API_KEY, () => pf('https://api.developers.kaspr.io/profile/linkedin', { method: 'POST', headers: { 'Authorization': `Bearer ${env.KASPR_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ linkedinUrl: 'https://www.linkedin.com/in/test-monitoring-key' }) })],
    ['FullEnrich', !!env.FULLENRICH_API_KEY, () => pf('https://app.fullenrich.com/api/v1/account/credits', { headers: { 'Authorization': `Bearer ${env.FULLENRICH_API_KEY}` } })],
    ['Dropcontact', !!env.DROPCONTACT_API_KEY, () => pf('https://api.dropcontact.com/v1/enrich/all/test-monitoring', { headers: { 'X-Access-Token': env.DROPCONTACT_API_KEY } })],
    ['HubSpot', !!env.HUBSPOT_API_KEY, () => pf('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { 'Authorization': `Bearer ${env.HUBSPOT_API_KEY}` } })],
    ['Lemlist', !!env.LEMLIST_API_KEY, () => pf('https://api.lemlist.com/api/team', { headers: { 'Authorization': 'Basic ' + Buffer.from(':' + env.LEMLIST_API_KEY).toString('base64') } })],
    ['Ringover', !!env.RINGOVER_API_KEY, () => pf('https://public-api.ringover.com/v2/contacts?limit=1', { headers: { 'Authorization': env.RINGOVER_API_KEY } })],
    ['PhantomBuster', !!env.PHANTOMBUSTER_API_KEY, () => pf('https://api.phantombuster.com/api/v2/agents/fetch-all', { headers: { 'X-Phantombuster-Key-1': env.PHANTOMBUSTER_API_KEY } })],
    ['Claude', !!env.ANTHROPIC_API_KEY, () => pf('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) })]
  ];

  for (const [nom, present, fn] of checks) {
    const etat = await testKey(present, fn);
    if (etat === 'down') problemes.push({ nom, type: 'cle', detail: 'clé refusée ou injoignable (401/403)' });
    else if (etat === 'ok') okMaintenant.push(nom);
    // 'absent' = clé non configurée → on ignore (volontairement vide, pas une panne)
  }

  // ── 2. Soldes sous seuil (depuis la base etats_api, alimentée par les enrichissements) ──
  let sql, ensureSchema;
  try {
    ({ sql, ensureSchema } = await import('./db.js'));
    if (sql) {
      await ensureSchema();
      const rows = await sql`SELECT api, solde FROM etats_api`;
      for (const r of rows) {
        const seuil = SEUILS[r.api];
        if (seuil && Number(r.solde) < seuil) {
          problemes.push({ nom: r.api, type: 'solde', detail: `solde bas : ${Number(r.solde).toLocaleString('fr-FR')} crédits (seuil ${seuil})` });
        }
      }
    }
  } catch (_) {}

  // ── 3. Anti-spam : on ne réalerte pas pour une API déjà signalée (sauf si elle était revenue OK) ──
  let dejaSignales = [];
  try {
    if (sql) {
      const r = await sql`SELECT valeur FROM config WHERE cle = 'monitor_alertes'`;
      dejaSignales = (r.length && Array.isArray(r[0].valeur)) ? r[0].valeur : [];
    }
  } catch (_) {}

  const clesProblemes = problemes.map(p => `${p.nom}:${p.type}`);
  const nouveaux = problemes.filter(p => !dejaSignales.includes(`${p.nom}:${p.type}`));

  // ── 4. Envoi Slack si nouveaux problèmes ──
  if (nouveaux.length) {
    const lignes = nouveaux.map(p => p.type === 'cle'
      ? `🔴 *${p.nom}* — ${p.detail}`
      : `🟠 *${p.nom}* — ${p.detail}`).join('\n');
    await slack(`⚠️ *Monitoring Sofy Scrap — problème détecté*\n${lignes}\n👉 Vérifie les clés/crédits dans Vercel ou chez le fournisseur.`);
  }

  // ── 5. Mémoriser l'état courant (anti-spam) ──
  try {
    if (sql) {
      await sql`INSERT INTO config (cle, valeur) VALUES ('monitor_alertes', ${JSON.stringify(clesProblemes)})
                ON CONFLICT (cle) DO UPDATE SET valeur = ${JSON.stringify(clesProblemes)}`;
    }
  } catch (_) {}

  return res.status(200).json({
    ok: true,
    problemes,
    nouveaux: nouveaux.length,
    ok_apis: okMaintenant,
    slack_envoye: nouveaux.length > 0
  });
}
