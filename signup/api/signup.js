import {
  clientIp,
  consumeOtp,
  json,
  normalizeEmail,
  rateLimit,
  readBody,
  requireEnv
} from './_lib.js';
import { syncSignupToHubSpot } from './hubspot-signup.js';
import { validateSignupPayload } from './_signup-validation.js';

export const config = { maxDuration: 30 };

async function postJson(url, token, payload) {
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
    const message = data.error || data.erreur || data.detail || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function capture(name, promise) {
  try {
    return { name, ok: true, value: await promise };
  } catch (err) {
    return { name, ok: false, error: err };
  }
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
  const ipLimit = await rateLimit(`submit:ip:${ip}`, 10, 60 * 60);
  if (!ipLimit.ok) return json(res, 429, { error: 'Trop de tentatives.', retry_after: ipLimit.retryAfter });

  const email = normalizeEmail(body.email);
  if (email) {
    const emailLimit = await rateLimit(`submit:email:${email}`, 3, 60 * 60);
    if (!emailLimit.ok) return json(res, 429, { error: 'Trop de tentatives pour cet email.', retry_after: emailLimit.retryAfter });
  }

  const { errors, normalized } = validateSignupPayload(body);
  if (errors.length) return json(res, 400, { error: 'Validation failed', errors });

  const otp = await consumeOtp({
    token: body.otp_token,
    code: body.otp_code,
    email: normalized.email,
    phone: normalized.phone
  });
  if (!otp.ok) return json(res, 401, { error: otp.error || 'Code de validation invalide.' });

  try {
    const backendBase = String(process.env.BACKEND_API_URL || '').replace(/\/$/, '');
    const backendUrl = process.env.BACKEND_SIGNUP_URL || `${backendBase}/auth/internal/signups`;
    const backendToken = requireEnv('SOFY_SIGNUP_TOKEN');
    if (!backendBase && !process.env.BACKEND_SIGNUP_URL) throw new Error('BACKEND_API_URL or BACKEND_SIGNUP_URL is not configured');

    const hotleadUrl = requireEnv('SOFY_SCRAP_HOTLEAD_URL');
    const hotleadToken = requireEnv('SIGNUP_HOTLEAD_TOKEN');

    const [accountResult, hotleadResult, hubspotResult] = await Promise.all([
      capture('gw.sofy.fr', postJson(backendUrl, backendToken, normalized)),
      capture('sofy-sdr-tool', postJson(hotleadUrl, hotleadToken, normalized)),
      capture('HubSpot', syncSignupToHubSpot(normalized))
    ]);

    const failures = [accountResult, hotleadResult]
      .filter(result => !result.ok)
      .map(result => `${result.name}: ${result.error.message}`);
    if (failures.length) throw new Error(failures.join(' ; '));

    const account = accountResult.value;
    const hotlead = hotleadResult.value;
    const hubspot = hubspotResult.ok
      ? hubspotResult.value
      : { ok: false, error: 'HubSpot sync failed', detail: hubspotResult.error.message };

    return json(res, 201, { ok: true, account, hubspot, hotlead });
  } catch (err) {
    return json(res, 502, { error: 'Signup submission failed', detail: err.message });
  }
}
