import {
  clientIp,
  json,
  newOtpCode,
  newOtpToken,
  rateLimit,
  readBody,
  requireEnv,
  storeOtp
} from './_lib.js';
import { validateSignupPayload } from './_signup-validation.js';

export const config = { maxDuration: 20 };

function smsRecipient(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function sendOtpSms({ to, code }) {
  const apiBase = String(process.env.SOFY_SMS_API_URL || 'https://api.sofy.fr/v1').replace(/\/$/, '');
  const response = await fetch(`${apiBase}/sms`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-KEY-ID': requireEnv('SOFY_API_KEY_ID'),
      'X-API-KEY-SECRET': requireEnv('SOFY_API_KEY_SECRET')
    },
    body: JSON.stringify({
      from: process.env.SIGNUP_OTP_SMS_FROM || 'SOFY',
      to,
      body: `Votre code de validation Sofy est ${code}. Il expire dans 10 minutes.`,
      shortenUrls: false,
      isTransactional: true
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || data.detail || `Sofy SMS HTTP ${response.status}`);
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

  const ip = clientIp(req);
  const ipLimit = await rateLimit(`otp:ip:${ip}`, 12, 60 * 60);
  if (!ipLimit.ok) return json(res, 429, { error: 'Trop de demandes de code.', retry_after: ipLimit.retryAfter });

  const { errors, normalized } = validateSignupPayload(body);
  if (errors.length) return json(res, 400, { error: 'Validation failed', errors });

  const phoneLimit = await rateLimit(`otp:phone:${normalized.phone}`, 4, 60 * 60);
  if (!phoneLimit.ok) return json(res, 429, { error: 'Trop de demandes pour ce numéro.', retry_after: phoneLimit.retryAfter });

  const code = newOtpCode();
  const token = newOtpToken();
  const to = smsRecipient(normalized.phone);
  if (!to) return json(res, 400, { error: 'Numéro de téléphone invalide.' });

  try {
    const sms = await sendOtpSms({ to, code });
    await storeOtp({ token, code, email: normalized.email, phone: normalized.phone, ttlSeconds: 10 * 60 });
    return json(res, 200, {
      ok: true,
      otp_token: token,
      expires_in: 10 * 60,
      sms_id: sms.id || null
    });
  } catch (err) {
    return json(res, 502, { error: 'Impossible d’envoyer le code SMS.', detail: err.message });
  }
}
