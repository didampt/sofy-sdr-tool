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
