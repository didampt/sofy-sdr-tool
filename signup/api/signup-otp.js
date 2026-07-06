import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  clientIp,
  json,
  normalizeEmail,
  rateLimit,
  readBody,
  requireEnv
} from './_lib.js';
import { createOtpChallenge, generateOtpCode, otpRateLimitKey } from './_otp.js';

export const config = { maxDuration: 30 };

function normalizePhone(phone, country) {
  const parsed = parsePhoneNumberFromString(String(phone || '').trim(), String(country || 'FR').toUpperCase());
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number.replace(/\D/g, '');
}

async function sendOtpSms(phone, code) {
  const keyID = requireEnv('SOFY_API_KEY_ID');
  const keySecret = requireEnv('SOFY_API_KEY_SECRET');
  const url = String(process.env.SOFY_SMS_API_URL || 'https://api.sofy.fr/v1/sms').trim();
  const from = String(process.env.SIGNUP_OTP_SENDER || 'SOFY').trim();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY-ID': keyID,
      'X-API-KEY-SECRET': keySecret
    },
    body: JSON.stringify({
      from,
      to: phone,
      body: `Votre code de validation Sofy est ${code}. Il expire dans 10 minutes.`,
      shortenUrls: false,
      isTransactional: true
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.erreur || data.detail || `Erreur SMS ${response.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  let body;
  try {
    body = await readBody(req);
  } catch (_) {
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const email = normalizeEmail(body.email);
  const phoneCountry = String(body.phone_country || body.country_code || 'FR').toUpperCase();
  const phone = normalizePhone(body.phone, phoneCountry);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 400, { error: 'Un email valide est requis.' });
  }
  if (!phone) {
    return json(res, 400, { error: 'Un numéro de téléphone valide est requis.' });
  }

  const ip = clientIp(req);
  const ipLimit = await rateLimit(`otp:ip:${ip}`, 12, 60 * 60);
  if (!ipLimit.ok) return json(res, 429, { error: 'Trop de demandes de code.', retry_after: ipLimit.retryAfter });

  const phoneLimit = await rateLimit(`otp:phone:${otpRateLimitKey(phone, email)}`, 3, 15 * 60);
  if (!phoneLimit.ok) return json(res, 429, { error: 'Trop de codes envoyés. Réessayez plus tard.', retry_after: phoneLimit.retryAfter });

  try {
    const code = generateOtpCode();
    const challengeID = await createOtpChallenge({ email, phone, code });
    await sendOtpSms(phone, code);
    return json(res, 200, {
      ok: true,
      challenge_id: challengeID,
      phone,
      expires_in: 600
    });
  } catch (err) {
    return json(res, 502, { error: 'Envoi du code impossible.', detail: err.message });
  }
}
