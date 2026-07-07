import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { isFrenchCountry, normalizeEmail } from './_lib.js';

export function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères.';
  if (!/[a-z]/.test(value)) return 'Le mot de passe doit contenir une minuscule.';
  if (!/[A-Z]/.test(value)) return 'Le mot de passe doit contenir une majuscule.';
  if (!/[0-9]/.test(value)) return 'Le mot de passe doit contenir un chiffre.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Le mot de passe doit contenir un symbole.';
  return null;
}

export function validateSignupPayload(body) {
  const errors = [];
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const countryCode = String(body.country_code || '').trim().toUpperCase();
  const company = body.company || {};

  if (!String(body.first_name || '').trim()) errors.push('Le prénom est requis.');
  if (!String(body.last_name || '').trim()) errors.push('Le nom est requis.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Un email valide est requis.');
  if (!String(body.country || '').trim() || !countryCode) errors.push('Le pays est requis.');
  if (!body.cgv_accepted) errors.push('Vous devez accepter les CGV.');

  const passwordError = validatePassword(body.password);
  if (passwordError) errors.push(passwordError);

  const phoneCountry = String(body.phone_country || countryCode || 'FR').toUpperCase();
  const parsed = parsePhoneNumberFromString(phone, phoneCountry);
  if (!phone || !parsed || !parsed.isValid()) errors.push('Un numéro de téléphone valide est requis.');

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
      phone: parsed ? parsed.number : phone,
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
