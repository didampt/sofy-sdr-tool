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
