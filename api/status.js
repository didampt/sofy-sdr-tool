// /api/status.js — Statut des connexions : présence des clés (jamais leur valeur)

const OUTILS = [
  { id: 'pappers',     nom: 'Pappers',          env: 'PAPPERS_API_KEY',        role: 'Extraction entreprises & dirigeants' },
  { id: 'gplaces',     nom: 'Google Places',    env: 'GOOGLE_PLACES_API_KEY',  role: 'Score GMB, avis, concurrents' },
  { id: 'fullenrich',  nom: 'FullEnrich',       env: 'FULLENRICH_API_KEY',     role: 'Email + mobile (waterfall 1)' },
  { id: 'dropcontact', nom: 'Dropcontact',      env: 'DROPCONTACT_API_KEY',    role: 'Email vérifié (waterfall 2)' },
  { id: 'leadmagic',   nom: 'LeadMagic',        env: 'LEADMAGIC_API_KEY',      role: 'Email (waterfall 3)' },
  { id: 'hubspot',     nom: 'HubSpot',          env: 'HUBSPOT_API_KEY',        role: 'Dédoublonnage CRM + transaction AE' },
  { id: 'lemlist',     nom: 'Lemlist',          env: 'LEMLIST_API_KEY',        role: 'Envoi en séquence email' },
  { id: 'ringover',    nom: 'Ringover',         env: 'RINGOVER_API_KEY',       role: 'Appel click-to-call' },
  { id: 'sofy',        nom: 'Sofy (SoReach)',   env: 'SOFY_API_KEY',           role: 'Envoi SMS / RCS' },
  { id: 'slack',       nom: 'Slack Webhook',    env: 'SLACK_WEBHOOK_URL',      role: 'Alertes signaux' },
  { id: 'claude',      nom: 'Claude API',       env: 'ANTHROPIC_API_KEY',      role: 'Scoring, synthèses, emails perso' },
  { id: 'phantom',     nom: 'PhantomBuster',    env: 'PHANTOMBUSTER_API_KEY',  role: 'Signaux LinkedIn' },
  { id: 'rb2b',        nom: 'RB2B',             env: 'RB2B_API_KEY',           role: 'Visiteurs du site sofy.fr' }
];

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const statut = OUTILS.map(o => ({
    id: o.id,
    nom: o.nom,
    role: o.role,
    variable: o.env,
    configuree: !!(process.env[o.env] && process.env[o.env].trim())
  }));
  res.status(200).json({ outils: statut });
}
