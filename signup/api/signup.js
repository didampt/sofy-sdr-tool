import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  clientIp,
  isFrenchCountry,
  json,
  normalizeEmail,
  rateLimit,
  readBody,
  requireEnv
} from './_lib.js';

export const config = { maxDuration: 30 };

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 12) return 'Le mot de passe doit contenir au moins 12 caracteres.';
  if (!/[a-z]/.test(value)) return 'Le mot de passe doit contenir une minuscule.';
  if (!/[A-Z]/.test(value)) return 'Le mot de passe doit contenir une majuscule.';
  if (!/[0-9]/.test(value)) return 'Le mot de passe doit contenir un chiffre.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Le mot de passe doit contenir un symbole.';
  return null;
}

function e164Digits(parsed, fallback) {
  return String(parsed ? parsed.number : fallback || '').replace(/\D/g, '');
}

function validatePayload(body) {
  const errors = [];
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const countryCode = String(body.country_code || '').trim().toUpperCase();
  const company = body.company || {};

  if (!String(body.first_name || '').trim()) errors.push('Le prenom est requis.');
  if (!String(body.last_name || '').trim()) errors.push('Le nom est requis.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Un email valide est requis.');
  if (!String(body.country || '').trim() || !countryCode) errors.push('Le pays est requis.');
  if (!body.cgv_accepted) errors.push('Vous devez accepter les CGV.');

  const passwordError = validatePassword(body.password);
  if (passwordError) errors.push(passwordError);

  const phoneCountry = String(body.phone_country || countryCode || 'FR').toUpperCase();
  const parsed = parsePhoneNumberFromString(phone, phoneCountry);
  if (!phone || !parsed || !parsed.isValid()) errors.push('Un numero de telephone valide est requis.');

  if (isFrenchCountry(countryCode)) {
    if (!String(company.name || '').trim()) errors.push('La raison sociale est requise.');
    if (!/^\d{14}$/.test(String(company.siret || '').replace(/\D/g, ''))) errors.push('Un SIRET valide est requis.');
  }

  return {
    errors,
    normalized: {
      first_name: String(body.first_name || '').trim(),
      last_name: String(body.last_name || '').trim(),
      email,
      phone: e164Digits(parsed, phone),
      phone_country: phoneCountry,
      country: String(body.country || '').trim(),
      country_code: countryCode,
      password: String(body.password || ''),
      cgv_accepted: Boolean(body.cgv_accepted),
      source: 'signup.sofy.fr',
      company: {
        name: String(company.name || '').trim(),
        siret: String(company.siret || '').replace(/\D/g, ''),
        siren: String(company.siren || '').replace(/\D/g, ''),
        tva_id: String(company.tva_id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
        address: String(company.address || '').trim(),
        postal_code: String(company.postal_code || '').trim(),
        city: String(company.city || '').trim(),
        legal_form: String(company.legal_form || '').trim(),
        activity: String(company.activity || '').trim(),
        manual_entry: Boolean(company.manual_entry),
        pappers_raw: company.pappers_raw && typeof company.pappers_raw === 'object' ? company.pappers_raw : undefined
      }
    }
  };
}

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

  const { errors, normalized } = validatePayload(body);
  if (errors.length) return json(res, 400, { error: 'Validation failed', errors });

  try {
    const backendBase = String(process.env.BACKEND_API_URL || '').replace(/\/$/, '');
    const backendUrl = process.env.BACKEND_SIGNUP_URL || `${backendBase}/auth/internal/signups`;
    const backendToken = requireEnv('SOFY_SIGNUP_TOKEN');
    if (!backendBase && !process.env.BACKEND_SIGNUP_URL) throw new Error('BACKEND_API_URL or BACKEND_SIGNUP_URL is not configured');

    const hotleadUrl = requireEnv('SOFY_SCRAP_HOTLEAD_URL');
    const hotleadToken = requireEnv('SIGNUP_HOTLEAD_TOKEN');

    const account = await postJson(backendUrl, backendToken, normalized);
    const hotlead = await postJson(hotleadUrl, hotleadToken, { ...normalized, signup_account: account });

    return json(res, 201, { ok: true, account, hotlead });
  } catch (err) {
    return json(res, 502, { error: 'Signup submission failed', detail: err.message });
  }
}
