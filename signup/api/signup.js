import {
  clientIp,
  claimOtpForManualReview,
  consumeOtp,
  json,
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

function isExistingAuth0UserError(error) {
  const message = String(error?.message || '');
  return /status\s*=\s*409/i.test(message)
    && (/auth0_idp_error/i.test(message) || /the user already exists/i.test(message));
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
  const ipLimit = await rateLimit(`submit:ip:${ip}`, 20, 60 * 60);
  if (!ipLimit.ok) return json(res, 429, { error: 'Trop de tentatives.', retry_after: ipLimit.retryAfter });

  const { errors, normalized } = validateSignupPayload(body);
  if (errors.length) return json(res, 400, { error: 'Validation failed', errors });

  const manualSmsReview = body.sms_verification_status === 'not_received';
  const otp = manualSmsReview
    ? await claimOtpForManualReview({ token: body.otp_token, email: normalized.email, phone: normalized.phone })
    : await consumeOtp({ token: body.otp_token, code: body.otp_code, email: normalized.email, phone: normalized.phone });
  if (!otp.ok) return json(res, 401, { error: otp.error || 'Code de validation invalide.' });

  if (manualSmsReview) {
    normalized.sms_verification_status = 'not_received';
    normalized.sms_verification_reported_at = new Date().toISOString();
    normalized.sms_verification_code = otp.code || null;
    return json(res, 202, { ok: true, manual_review: true });
  } else {
    normalized.sms_verification_status = 'verified';
    normalized.sms_verification_reported_at = null;
    normalized.sms_verification_code = null;
  }

  try {
    const backendBase = String(process.env.BACKEND_API_URL || '').replace(/\/$/, '');
    const backendUrl = process.env.BACKEND_SIGNUP_URL || `${backendBase}/auth/internal/signups`;
    const backendToken = requireEnv('SOFY_SIGNUP_TOKEN');
    if (!backendBase && !process.env.BACKEND_SIGNUP_URL) throw new Error('BACKEND_API_URL or BACKEND_SIGNUP_URL is not configured');

    const hotleadUrl = requireEnv('SOFY_SCRAP_HOTLEAD_URL');
    const hotleadToken = requireEnv('SIGNUP_HOTLEAD_TOKEN');

    const accountPayload = { ...normalized };
    delete accountPayload.sms_verification_status;
    delete accountPayload.sms_verification_reported_at;
    delete accountPayload.sms_verification_code;
    const accountResult = await capture('gw.sofy.fr', postJson(backendUrl, backendToken, accountPayload));

    if (!accountResult.ok && isExistingAuth0UserError(accountResult.error)) {
      return json(res, 409, { code: 'EMAIL_ALREADY_EXISTS' });
    }
    if (!accountResult.ok) throw new Error(`${accountResult.name}: ${accountResult.error.message}`);

    const hotleadPayload = {
      ...normalized,
      otp_token: body.signup_reference || body.otp_token,
      signup_account: accountResult.value
    };
    const [hotleadResult, hubspotResult] = await Promise.all([
      capture('sofy-sdr-tool', postJson(hotleadUrl, hotleadToken, hotleadPayload)),
      capture('HubSpot', syncSignupToHubSpot(normalized))
    ]);

    const account = accountResult.value;
    const hotlead = hotleadResult.ok
      ? hotleadResult.value
      : { ok: false, error: 'Sofy Scrap sync failed', detail: hotleadResult.error.message };
    const hubspot = hubspotResult.ok
      ? hubspotResult.value
      : { ok: false, error: 'HubSpot sync failed', detail: hubspotResult.error.message };

    return json(res, 201, { ok: true, account, hubspot, hotlead });
  } catch (err) {
    return json(res, 502, { error: 'Signup submission failed', detail: err.message });
  }
}
