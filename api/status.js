// /api/status.js — Statut des connexions : présence des clés (jamais leur valeur)

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
  { id: 'rb2b',        nom: 'RB2B',             env: 'RB2B_WEBHOOK_SECRET',    role: 'Visiteurs du site sofy.fr (webhook temps réel)' }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  res.status(200).json({ outils: statut, soldes });
}
