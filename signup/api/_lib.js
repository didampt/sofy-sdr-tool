import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = dbUrl ? neon(dbUrl) : null;

const memoryBuckets = new Map();

export function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || String(req.socket?.remoteAddress || 'unknown');
}

export function hashKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function rateLimit(key, limit, windowSeconds) {
  const bucket = hashKey(key);
  const now = Date.now();

  if (!sql) {
    const current = memoryBuckets.get(bucket);
    if (!current || current.resetAt <= now) {
      memoryBuckets.set(bucket, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { ok: true, remaining: limit - 1 };
    }
    current.count += 1;
    return {
      ok: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
      retryAfter: Math.ceil((current.resetAt - now) / 1000)
    };
  }

  await sql`CREATE TABLE IF NOT EXISTS signup_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at TIMESTAMPTZ NOT NULL
  )`;

  const rows = await sql`
    INSERT INTO signup_rate_limits (key, count, reset_at)
    VALUES (${bucket}, 1, NOW() + (${windowSeconds}::int * INTERVAL '1 second'))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN signup_rate_limits.reset_at <= NOW() THEN 1
        ELSE signup_rate_limits.count + 1
      END,
      reset_at = CASE
        WHEN signup_rate_limits.reset_at <= NOW() THEN NOW() + (${windowSeconds}::int * INTERVAL '1 second')
        ELSE signup_rate_limits.reset_at
      END
    RETURNING count, EXTRACT(EPOCH FROM (reset_at - NOW()))::int AS retry_after
  `;

  const row = rows[0] || {};
  const count = Number(row.count || 0);
  return {
    ok: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Number(row.retry_after || windowSeconds)
  };
}

export function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function isFrenchCountry(code) {
  return new Set(['FR', 'GP', 'MQ', 'RE', 'GF', 'YT', 'PM', 'BL', 'MF', 'WF', 'PF', 'NC', 'TF'])
    .has(String(code || '').toUpperCase());
}
