import crypto from 'crypto';
import { sql, hashKey } from './_lib.js';

const memoryChallenges = new Map();
const OTP_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

function otpSecret() {
  return String(
    process.env.SIGNUP_OTP_SECRET ||
    process.env.SOFY_SIGNUP_TOKEN ||
    process.env.SIGNUP_HOTLEAD_TOKEN ||
    'signup-otp-local-dev'
  );
}

export function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function challengeHash({ id, email, phone, code }) {
  return crypto
    .createHmac('sha256', otpSecret())
    .update(`${id}:${String(email || '').toLowerCase()}:${String(phone || '')}:${String(code || '')}`)
    .digest('hex');
}

async function ensureOtpSchema() {
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS signup_otp_challenges (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
  )`;
}

export async function createOtpChallenge({ email, phone, code }) {
  const id = crypto.randomUUID();
  const normalizedEmail = String(email || '').toLowerCase().trim();
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const codeHash = challengeHash({ id, email: normalizedEmail, phone: normalizedPhone, code });
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

  if (!sql) {
    memoryChallenges.set(id, {
      id,
      email: normalizedEmail,
      phone: normalizedPhone,
      codeHash,
      attempts: 0,
      expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
      verifiedAt: null,
      consumedAt: null
    });
    return id;
  }

  await ensureOtpSchema();
  await sql`
    INSERT INTO signup_otp_challenges (id, email, phone, code_hash, expires_at)
    VALUES (${id}, ${normalizedEmail}, ${normalizedPhone}, ${codeHash}, ${expiresAt})
  `;
  return id;
}

export async function verifyOtpChallenge({ id, email, phone, code }) {
  const normalizedID = String(id || '').trim();
  const normalizedEmail = String(email || '').toLowerCase().trim();
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const normalizedCode = String(code || '').replace(/\D/g, '');
  if (!normalizedID || !normalizedEmail || !normalizedPhone || !/^\d{6}$/.test(normalizedCode)) {
    return { ok: false, error: 'Code de validation invalide.' };
  }

  const expectedHash = challengeHash({
    id: normalizedID,
    email: normalizedEmail,
    phone: normalizedPhone,
    code: normalizedCode
  });

  if (!sql) {
    const challenge = memoryChallenges.get(normalizedID);
    if (!challenge || challenge.email !== normalizedEmail || challenge.phone !== normalizedPhone) {
      return { ok: false, error: 'Code de validation introuvable.' };
    }
    if (challenge.consumedAt) return { ok: false, error: 'Ce code a déjà été utilisé.' };
    if (challenge.expiresAt <= Date.now()) return { ok: false, error: 'Ce code a expiré.' };
    if (challenge.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Trop de tentatives pour ce code.' };
    challenge.attempts += 1;
    if (challenge.codeHash !== expectedHash) return { ok: false, error: 'Code incorrect.' };
    challenge.verifiedAt = Date.now();
    return { ok: true };
  }

  await ensureOtpSchema();
  const rows = await sql`
    UPDATE signup_otp_challenges
    SET attempts = attempts + 1,
        verified_at = CASE WHEN code_hash = ${expectedHash} THEN NOW() ELSE verified_at END
    WHERE id = ${normalizedID}
      AND email = ${normalizedEmail}
      AND phone = ${normalizedPhone}
      AND consumed_at IS NULL
      AND expires_at > NOW()
      AND attempts < ${MAX_ATTEMPTS}
    RETURNING code_hash = ${expectedHash} AS valid
  `;

  if (!rows.length) return { ok: false, error: 'Code expiré, utilisé ou introuvable.' };
  if (!rows[0].valid) return { ok: false, error: 'Code incorrect.' };
  return { ok: true };
}

export async function consumeOtpChallenge(id) {
  const normalizedID = String(id || '').trim();
  if (!normalizedID) return;
  if (!sql) {
    const challenge = memoryChallenges.get(normalizedID);
    if (challenge) challenge.consumedAt = Date.now();
    return;
  }
  await ensureOtpSchema();
  await sql`UPDATE signup_otp_challenges SET consumed_at = NOW() WHERE id = ${normalizedID}`;
}

export function otpRateLimitKey(phone, email) {
  return hashKey(`${String(phone || '').replace(/\D/g, '')}:${String(email || '').toLowerCase().trim()}`);
}
