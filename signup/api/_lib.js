import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = dbUrl ? neon(dbUrl) : null;

const memoryBuckets = new Map();
const memoryOtps = new Map();

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

function otpHash(token, code, email, phone) {
  return hashKey(`${token}:${code}:${normalizeEmail(email)}:${String(phone || '').trim()}`);
}

export function newOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function newOtpToken() {
  return crypto.randomBytes(24).toString('base64url');
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

async function ensureOtpSchema() {
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS signup_otps (
    token TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_signup_otps_expires ON signup_otps (expires_at)`;
}

export async function storeOtp({ token, code, email, phone, ttlSeconds = 600 }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = String(phone || '').trim();
  const codeHash = otpHash(token, code, normalizedEmail, normalizedPhone);

  if (!sql) {
    memoryOtps.set(token, {
      codeHash,
      email: normalizedEmail,
      phone: normalizedPhone,
      attempts: 0,
      expiresAt: Date.now() + ttlSeconds * 1000,
      consumed: false
    });
    return;
  }

  await ensureOtpSchema();
  await sql`DELETE FROM signup_otps WHERE expires_at <= NOW() - INTERVAL '1 hour' OR consumed_at IS NOT NULL`;
  await sql`
    INSERT INTO signup_otps (token, code_hash, email, phone, expires_at)
    VALUES (${token}, ${codeHash}, ${normalizedEmail}, ${normalizedPhone}, NOW() + (${ttlSeconds}::int * INTERVAL '1 second'))
  `;
}

export async function consumeOtp({ token, code, email, phone, maxAttempts = 5 }) {
  const normalizedToken = String(token || '').trim();
  const normalizedCode = String(code || '').replace(/\s/g, '');
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = String(phone || '').trim();
  if (!/^[0-9]{6}$/.test(normalizedCode) || !normalizedToken) {
    return { ok: false, error: 'Code de validation invalide.' };
  }

  if (!sql) {
    const current = memoryOtps.get(normalizedToken);
    if (!current || current.consumed || current.expiresAt <= Date.now()) {
      return { ok: false, error: 'Code expiré. Demandez un nouveau code.' };
    }
    if (current.email !== normalizedEmail || current.phone !== normalizedPhone) {
      return { ok: false, error: 'Code de validation invalide.' };
    }
    current.attempts += 1;
    if (current.attempts > maxAttempts) {
      memoryOtps.delete(normalizedToken);
      return { ok: false, error: 'Trop de tentatives. Demandez un nouveau code.' };
    }
    if (current.codeHash !== otpHash(normalizedToken, normalizedCode, normalizedEmail, normalizedPhone)) {
      return { ok: false, error: 'Code de validation incorrect.' };
    }
    current.consumed = true;
    memoryOtps.delete(normalizedToken);
    return { ok: true };
  }

  await ensureOtpSchema();
  const rows = await sql`
    UPDATE signup_otps
    SET attempts = attempts + 1
    WHERE token = ${normalizedToken}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING code_hash, email, phone, attempts
  `;
  const row = rows[0];
  if (!row) return { ok: false, error: 'Code expiré. Demandez un nouveau code.' };
  if (row.email !== normalizedEmail || row.phone !== normalizedPhone) {
    return { ok: false, error: 'Code de validation invalide.' };
  }
  if (Number(row.attempts || 0) > maxAttempts) {
    await sql`DELETE FROM signup_otps WHERE token = ${normalizedToken}`;
    return { ok: false, error: 'Trop de tentatives. Demandez un nouveau code.' };
  }
  if (row.code_hash !== otpHash(normalizedToken, normalizedCode, normalizedEmail, normalizedPhone)) {
    return { ok: false, error: 'Code de validation incorrect.' };
  }
  await sql`UPDATE signup_otps SET consumed_at = NOW() WHERE token = ${normalizedToken}`;
  return { ok: true };
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
