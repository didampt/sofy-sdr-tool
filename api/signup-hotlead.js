// /api/signup-hotlead.js — Protected intake for signup.sofy.fr submissions.
// Creates an incoming Hot Lead in Sofy Scrap while preserving signup/company context.

import crypto from 'crypto';
import { sql, ensureSchema, ajouterHotLead } from './db.js';

export const config = { maxDuration: 30 };

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function domainFromEmail(email) {
  const value = String(email || '').toLowerCase().trim();
  if (!value.includes('@')) return null;
  const domain = value.split('@').pop();
  return /^(gmail|outlook|hotmail|yahoo|orange|wanadoo|free|sfr|laposte|icloud|live)\./.test(domain) ? null : domain;
}

async function envoyerSlack(texte) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texte })
    });
  } catch (_) {}
}

function sanitizeSignupPayload(body) {
  const { password, signup_account, ...rest } = body || {};
  return {
    ...rest,
    company: body && body.company ? { ...body.company, pappers_raw: body.company.pappers_raw || undefined } : undefined
  };
}

export default async function handler(req, res) {
  const expected = (process.env.SIGNUP_HOTLEAD_TOKEN || '').trim();
  const received = String(req.headers['x-sofy-signup-token'] || '').trim();

  if (!expected || !safeEqual(received, expected)) {
    return res.status(401).json({ erreur: 'Token signup invalide' });
  }
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  if (!sql) return res.status(500).json({ erreur: 'Base non configurée' });

  await ensureSchema();

  const body = req.body || {};
  const company = body.company || {};
  const firstName = String(body.first_name || '').trim();
  const lastName = String(body.last_name || '').trim();
  const email = String(body.email || '').toLowerCase().trim();
  const companyName = String(company.name || '').trim();
  const country = String(body.country || '').trim();
  const city = String(company.city || '').trim();
  const signupAccount = body.signup_account && typeof body.signup_account === 'object' ? body.signup_account : {};
  const safePayload = sanitizeSignupPayload(body);

  if (!email || !firstName || !lastName) {
    return res.status(400).json({ erreur: 'first_name, last_name et email requis' });
  }

  try {
    const result = await ajouterHotLead({
      nom_complet: `${firstName} ${lastName}`.trim(),
      email,
      entreprise: companyName || email,
      domaine: domainFromEmail(email),
      fonction: 'Inscription signup',
      ville: city || null,
      region: country || null,
      pages_visitees: ['https://signup.sofy.fr'],
      nb_visites: 1,
      date_visite: new Date().toISOString(),
      source: 'Signup Sofy',
      type: 'signup',
      detail: `${firstName} ${lastName} a demandé la création d'un compte Sofy${companyName ? ` pour ${companyName}` : ''}`,
      ca_estime: null,
      industrie: company.activity || null,
      effectif: null,
      signup: {
        user_id: signupAccount.user_id || null,
        organization_id: signupAccount.organization_id || null,
        disabled: signupAccount.disabled !== false,
        submitted_at: new Date().toISOString(),
        payload: safePayload
      }
    }, {
      sdr: process.env.SIGNUP_HOTLEAD_SDR || 'didier',
      exclure_hubspot: false
    });

    if (result.ajoute) {
      const app = (process.env.APP_URL || 'https://sofy-sdr-tool.vercel.app').replace(/\/$/, '');
      const link = `${app}/?liste=${result.liste_id}&fiche=${encodeURIComponent(result.cle_fiche || '')}`;
      await envoyerSlack(`🔥 *Nouvelle inscription Sofy* — ${companyName || email}\n👤 ${firstName} ${lastName} · ${email}${body.phone ? ` · ${body.phone}` : ''}\n📍 ${country || 'Pays non renseigné'}${company.siret ? ` · SIRET ${company.siret}` : ''}${company.tva_id ? ` · TVA ${company.tva_id}` : ''}\n📂 <${link}|Ouvrir dans Sofy Scrap>`);
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ erreur: 'Création hot lead impossible', detail: err.message });
  }
}
