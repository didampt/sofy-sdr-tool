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

async function pushPendingSignup(payload) {
  const url = requireEnv('SOFY_SCRAP_HOTLEAD_URL');
  const token = requireEnv('SIGNUP_HOTLEAD_TOKEN');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sofy-Signup-Token': token
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.erreur || data.detail || `Sofy Scrap HTTP ${response.status}`);
  }
  return data;
}

async function capture(name, promise) {
  try {
    return { name, ok: true, value: await promise };
  } catch (error) {
    return { name, ok: false, error };
  }
}

function smsErrorMessage(error) {
  const message = String(error?.message || '');
  if (/please provide a mobile phone number as ['"]to['"] parameter/i.test(message)) {
    return 'Veuillez renseigner un numéro de téléphone mobile valide.';
  }
  return message;
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

  const phoneLimit = await rateLimit(`otp:phone:${normalized.phone}`, 20, 60 * 60);
  if (!phoneLimit.ok) return json(res, 429, { error: 'Trop de demandes pour ce numéro.', retry_after: phoneLimit.retryAfter });

  const code = newOtpCode();
  const token = newOtpToken();
  const signupReference = String(body.signup_reference || token).trim();
  const to = smsRecipient(normalized.phone);
  if (!to) return json(res, 400, { error: 'Numéro de téléphone invalide.' });

  try {
    await storeOtp({ token, code, email: normalized.email, phone: normalized.phone, ttlSeconds: 10 * 60 });
    const [smsResult, hotleadResult] = await Promise.all([
      capture('SMS', sendOtpSms({ to, code })),
      capture('Sofy Scrap', pushPendingSignup({
        ...normalized,
        otp_token: signupReference,
        sms_verification_status: 'not_received',
        sms_verification_reported_at: new Date().toISOString(),
        sms_verification_code: code
      }))
    ]);
    if (!hotleadResult.ok) {
      return json(res, 502, {
        error: 'Impossible d’enregistrer la demande.',
        detail: hotleadResult.error.message
      });
    }
    if (!smsResult.ok) {
      return json(res, 200, {
        ok: true,
        otp_token: token,
        signup_reference: signupReference,
        expires_in: 10 * 60,
        sms_sent: false,
        signup_recorded: true
      });
    }
    return json(res, 200, {
      ok: true,
      otp_token: token,
      signup_reference: signupReference,
      expires_in: 10 * 60,
      sms_sent: true,
      sms_id: smsResult.value.id || null
    });
  } catch (err) {
    return json(res, 502, { error: 'Impossible de préparer la demande.', detail: smsErrorMessage(err) });
  }
}
