// /api/db.js — Connexion à la base Neon Postgres (Vercel Storage)
// La variable DATABASE_URL est créée automatiquement par Vercel lors de la création de la base.
import { neon } from '@neondatabase/serverless';
import { createHmac, createHash } from 'crypto';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = url ? neon(url) : null;

let ready = false;
export async function ensureSchema() {
  if (ready || !sql) return;
  await sql`CREATE TABLE IF NOT EXISTS listes (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL,
    sdr TEXT NOT NULL,
    criteres JSONB NOT NULL,
    criteres_hash TEXT NOT NULL,
    entreprises JSONB NOT NULL,
    total INTEGER DEFAULT 0,
    credits_estimes INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_listes_hash ON listes(criteres_hash)`;
  await sql`CREATE TABLE IF NOT EXISTS sdrs (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL UNIQUE,
    email TEXT DEFAULT '',
    limite_credits NUMERIC DEFAULT NULL,
    actif BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'sdr'`;
  await sql`ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS password_hash TEXT DEFAULT NULL`;
  // Amorçage : l'équipe Sofy si la table est vide
  const n = await sql`SELECT COUNT(*)::int AS c FROM sdrs`;
  if (n[0].c === 0) {
    await sql`INSERT INTO sdrs (nom) VALUES ('Alicia'), ('Franck'), ('Romain'), ('Manon')`;
  }
  // Superadmin : Didier
  const sa = await sql`SELECT id FROM sdrs WHERE email = 'didier@sofy.fr'`;
  if (!sa.length) {
    await sql`INSERT INTO sdrs (nom, email, role) VALUES ('Didier', 'didier@sofy.fr', 'superadmin')
              ON CONFLICT (nom) DO UPDATE SET email = 'didier@sofy.fr', role = 'superadmin'`;
  } else {
    await sql`UPDATE sdrs SET role = 'superadmin' WHERE email = 'didier@sofy.fr'`;
  }
  await sql`CREATE TABLE IF NOT EXISTS consommations (
    id SERIAL PRIMARY KEY,
    sdr TEXT NOT NULL,
    api TEXT NOT NULL,
    quantite NUMERIC NOT NULL DEFAULT 1,
    liste_id INTEGER DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conso_sdr ON consommations(sdr, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conso_liste ON consommations(liste_id)`;
  await sql`CREATE TABLE IF NOT EXISTS tarifs (api TEXT PRIMARY KEY, prix NUMERIC NOT NULL)`;
  const t = await sql`SELECT COUNT(*)::int AS c FROM tarifs`;
  if (t[0].c === 0) {
    await sql`INSERT INTO tarifs (api, prix) VALUES
      ('pappers', 0.05), ('google_places', 0.02), ('dropcontact', 0.10),
      ('ia_claude', 0.02), ('fullenrich', 0.25), ('leadmagic', 0.05), ('kaspr', 0.20)`;
  }
  await sql`CREATE TABLE IF NOT EXISTS etats_api (api TEXT PRIMARY KEY, solde NUMERIC, maj TIMESTAMPTZ DEFAULT NOW())`;
  await sql`ALTER TABLE listes ADD COLUMN IF NOT EXISTS createur TEXT DEFAULT NULL`;
  await sql`ALTER TABLE listes ADD COLUMN IF NOT EXISTS archivee BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE listes ADD COLUMN IF NOT EXISTS veille BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE listes ADD COLUMN IF NOT EXISTS veille_fin TIMESTAMPTZ DEFAULT NULL`;
  await sql`CREATE TABLE IF NOT EXISTS signaux (
    id SERIAL PRIMARY KEY,
    liste_id INTEGER,
    entreprise_nom TEXT,
    contact_nom TEXT,
    linkedin TEXT,
    type TEXT,
    source TEXT,
    detail TEXT,
    sdr TEXT,
    vu BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS veille_etat (cle TEXT PRIMARY KEY, deja_vus JSONB DEFAULT '[]', maj TIMESTAMPTZ DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS config (cle TEXT PRIMARY KEY, valeur JSONB NOT NULL DEFAULT '{}')`;
  await sql`CREATE TABLE IF NOT EXISTS taches (
    id SERIAL PRIMARY KEY,
    sdr TEXT NOT NULL,
    liste_id INTEGER,
    fiche_cle TEXT,
    entreprise_nom TEXT,
    contact_nom TEXT,
    description TEXT,
    date_rappel TIMESTAMPTZ,
    faite BOOLEAN DEFAULT FALSE,
    alertee BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS ringover_numero TEXT`;
  await sql`ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS slack_id TEXT`;
  await sql`INSERT INTO tarifs (api, prix) VALUES ('soreach', 0.07) ON CONFLICT (api) DO NOTHING`;
  ready = true;
}

// ── Authentification : jetons signés HMAC ──
function secret() {
  return process.env.AUTH_SECRET || createHash('sha256').update(url || 'sofy-scrap').digest('hex');
}
export function signerToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id, email: user.email, nom: user.nom, role: user.role,
    exp: Date.now() + 7 * 24 * 3600 * 1000
  })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}
export function verifierToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const attendu = createHmac('sha256', secret()).update(payload).digest('base64url');
  if (sig !== attendu) return null;
  try {
    const u = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (u.exp < Date.now()) return null;
    return u;
  } catch { return null; }
}

// ── Suivi des consommations + limites mensuelles ──
export async function loggerConso(user, api, quantite, listeId) {
  if (!sql || !quantite) return;
  try {
    await sql`INSERT INTO consommations (sdr, api, quantite, liste_id)
      VALUES (${user?.nom || '?'}, ${api}, ${quantite}, ${listeId ? parseInt(listeId) : null})`;
  } catch (_) {}
}
export async function majSoldeApi(api, solde) {
  if (!sql || solde === null || solde === undefined) return;
  try {
    await sql`INSERT INTO etats_api (api, solde, maj) VALUES (${api}, ${solde}, NOW())
      ON CONFLICT (api) DO UPDATE SET solde = ${solde}, maj = NOW()`;
  } catch (_) {}
}
// Renvoie {conso, limite} si la limite mensuelle (€) du SDR est atteinte, sinon null
// ── Hot Leads automatiques (visiteurs site, likers concurrents, followers) ──
export async function listeHotLeads(cfgSdr) {
  const rows = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' = 'hotleads' LIMIT 1`;
  if (rows.length) return rows[0];
  const crea = await sql`INSERT INTO listes (nom, sdr, criteres, criteres_hash, entreprises, veille)
    VALUES ('🔥 Hot Leads (auto)', ${cfgSdr || 'didier'}, ${JSON.stringify({ auto: 'hotleads' })}, 'auto:hotleads', '[]', TRUE)
    RETURNING id, entreprises`;
  return crea[0];
}

// true si le contact existe dans HubSpot comme CLIENT (lifecyclestage customer) → à exclure des hot leads
// true si le contact existe dans HubSpot À N'IMPORTE QUEL STADE (client, lead, deal en cours…) → déjà connu
export async function existeDansHubspot(email) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token || !email) return null;
  try {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['lifecyclestage', 'hubspot_owner_id'], limit: 1 })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.total) return null;
    const p = data.results[0].properties || {};
    return { stage: p.lifecyclestage || 'inconnu', owner: p.hubspot_owner_id || null };
  } catch (_) { return null; }
}

export async function estClientHubspot(email, domaine) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token || (!email && !domaine)) return false;
  try {
    const filtres = email
      ? [{ propertyName: 'email', operator: 'EQ', value: email }]
      : [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: '@' + domaine }];
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filterGroups: [{ filters: filtres }], properties: ['lifecyclestage'], limit: 1 })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.total) return false;
    const stage = (data.results[0].properties || {}).lifecyclestage || '';
    return ['customer', 'evangelist'].includes(stage);
  } catch (_) { return false; }
}

// Ajoute un profil à la liste Hot Leads (dédup interne par email/linkedin/nom+entreprise)
export async function ajouterHotLead(profil, cfg) {
  const hl = await listeHotLeads(cfg && cfg.sdr);
  const ents = hl.entreprises || [];
  // Clé STABLE = domaine, LinkedIn société ou nom d'entreprise. (Le contact change après enrichissement → ne pas s'en servir.)
  const norm = v => (v || '').toString().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'').trim();
  const cleStable = p => norm(p.domaine) || norm(p.linkedin_societe) || norm(p.entreprise);
  const connus = new Set(ents.map(e => norm(e.site_web) || norm(e.linkedin_entreprise) || norm(e.nom)));
  const cleP = cleStable(profil);
  if (cleP && connus.has(cleP)) return { ajoute: false, raison: 'déjà présent' };
  if ((cfg && cfg.exclure_hubspot) !== false) {
    const dom = profil.email && !profil.email.match(/@(gmail|outlook|hotmail|yahoo|orange|wanadoo|free|sfr|laposte|icloud|live)\./) ? profil.email.split('@')[1] : profil.domaine;
    if (await estClientHubspot(profil.email, dom)) return { ajoute: false, raison: 'client HubSpot' };
  }
  const morceaux = (profil.nom_complet || '').split(' ');
  const maintenant = new Date().toISOString();
  ents.unshift({
    nom: profil.entreprise || profil.nom_complet || 'Inconnu',
    enseigne: profil.entreprise || null, siren: null,
    site_web: profil.domaine ? (profil.domaine.startsWith('http') ? profil.domaine : 'https://' + profil.domaine) : null,
    // ── Données RB2B conservées (servent à l'enrichissement auto + contexte SDR) ──
    linkedin_entreprise: profil.linkedin_societe || null,
    effectif: profil.effectif || null,
    chiffre_affaires_estime: profil.ca_estime || null,
    secteur_rb2b: profil.industrie || null,
    ville: profil.ville || null,
    region: profil.region || null,
    pages_visitees: profil.pages_visitees || [],   // ex : ['/so-reach-sms', '/demo'] → signal produit
    nb_visites: profil.nb_visites || null,
    date_visite: profil.date_visite || maintenant,
    source_hotlead: profil.source, date_hotlead: maintenant,
    a_enrichir: true,
    signal_hot: true,
    signal: { type: profil.type, source: profil.source, detail: profil.detail, date: maintenant, pages: profil.pages_visitees || [] },
    contacts: profil.nom_complet ? [{
      prenom: morceaux[0] || '', nom: morceaux.slice(1).join(' ') || '',
      fonction: profil.fonction || '', source: profil.source,
      enrich: { email: profil.email || null, linkedin: profil.linkedin_brut || null, telephone: null },
      signal: { type: profil.type, source: profil.source, detail: profil.detail, date: maintenant }
    }] : []
  });
  const finales = ents.slice(0, 300);
  await sql`UPDATE listes SET entreprises = ${JSON.stringify(finales)}, total = ${finales.length} WHERE id = ${hl.id}`;
  const cleFiche = maintenant + (profil.entreprise || profil.nom_complet || 'Inconnu');
  return { ajoute: true, liste_id: hl.id, cle_fiche: cleFiche };
}

// Verrou d'enrichissement Hot Lead : pose enrichi_par sur une fiche (par index) si libre.
// Renvoie {ok:true} si le verrou est acquis, {ok:false, par, depuis} si déjà pris (<5min).
export async function verrouHotLead(listeId, signalCle, sdr) {
  const rows = await sql`SELECT entreprises FROM listes WHERE id = ${listeId}`;
  if (!rows.length) return { ok: false, par: null };
  const ents = rows[0].entreprises || [];
  const idx = ents.findIndex(e => (e.signal && e.signal.date ? e.signal.date : '') + (e.nom || '') === signalCle);
  if (idx < 0) return { ok: true, idx: -1 }; // fiche introuvable → laisser passer
  const e = ents[idx];
  const maintenant = Date.now();
  if (e.enrichi_par && e.enrich_lock_ts && (maintenant - e.enrich_lock_ts) < 5 * 60 * 1000 && !e.score) {
    return { ok: false, par: e.enrichi_par, depuis: Math.round((maintenant - e.enrich_lock_ts) / 1000) };
  }
  ents[idx].enrichi_par = sdr;
  ents[idx].enrich_lock_ts = maintenant;
  await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${listeId}`;
  return { ok: true, idx };
}

// Libère le verrou d'enrichissement d'un Hot Lead (après enrichissement terminé).
export async function libererHotLead(listeId, signalCle) {
  const rows = await sql`SELECT entreprises FROM listes WHERE id = ${listeId}`;
  if (!rows.length) return;
  const ents = rows[0].entreprises || [];
  const idx = ents.findIndex(e => (e.signal && e.signal.date ? e.signal.date : '') + (e.nom || '') === signalCle);
  if (idx < 0) return;
  // On garde enrichi_par (= qui l'a traité, utile pour le badge ✅) mais on retire le timestamp de lock
  delete ents[idx].enrich_lock_ts;
  await sql`UPDATE listes SET entreprises = ${JSON.stringify(ents)} WHERE id = ${listeId}`;
}

export async function limiteAtteinte(user) {
  if (!sql || !user) return null;
  try {
    const rows = await sql`
      SELECT s.limite_credits AS lim,
             COALESCE((SELECT SUM(c.quantite * COALESCE(t.prix, 0))
                       FROM consommations c LEFT JOIN tarifs t ON t.api = c.api
                       WHERE c.sdr = s.nom
                         AND date_trunc('month', c.created_at) = date_trunc('month', NOW())), 0) AS conso
      FROM sdrs s WHERE s.id = ${user.id}`;
    if (!rows.length || rows[0].lim === null) return null;
    const conso = Number(rows[0].conso), limite = Number(rows[0].lim);
    return conso >= limite ? { conso: Math.round(conso * 100) / 100, limite } : null;
  } catch (_) { return null; }
}
