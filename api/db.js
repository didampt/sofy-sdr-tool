// /api/db.js — Connexion à la base Neon Postgres (Vercel Storage)
// La variable DATABASE_URL est créée automatiquement par Vercel lors de la création de la base.
import { neon } from '@neondatabase/serverless';

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
  ready = true;
}
