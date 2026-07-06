// /api/signups.js — Dedicated signup inbox and enable action for Sofy Scrap.

import { sql, ensureSchema, verifierToken } from './db.js';

function signupInfo(e) {
  return (e && (e.signup || (e.signal && e.signal.signup))) || null;
}

function signupContact(e) {
  const c = ((e && e.contacts) || [])[0] || {};
  const enrich = c.enrich || {};
  return {
    first_name: c.prenom || '',
    last_name: c.nom || '',
    full_name: [c.prenom, c.nom].filter(Boolean).join(' ').trim(),
    email: enrich.email || '',
    phone: enrich.telephone || ''
  };
}

function signupKey(e) {
  return `${(e && e.signal && e.signal.date) || ''}${(e && e.nom) || ''}`;
}

function normalizeSignup(e, idx, listId) {
  const info = signupInfo(e) || {};
  const payload = info.payload || {};
  const company = payload.company || {};
  const contact = signupContact(e);
  const enabledAt = info.enabled_at || e.signup_enabled_at || null;
  const userId = info.user_id || null;
  return {
    key: signupKey(e),
    index: idx,
    list_id: listId,
    company_name: company.name || e.nom || '',
    country: payload.country || e.region || '',
    country_code: payload.country_code || '',
    city: company.city || e.ville || '',
    siret: company.siret || '',
    siren: company.siren || '',
    tva_id: company.tva_id || '',
    submitted_at: info.submitted_at || e.date_hotlead || (e.signal && e.signal.date) || null,
    enabled_at: enabledAt,
    enabled_by: info.enabled_by || null,
    pending: !enabledAt && info.enabled !== true,
    user_id: userId,
    organization_id: info.organization_id || null,
    can_enable: Boolean(userId || contact.email),
    contact
  };
}

async function getHotLeadList() {
  const rows = await sql`SELECT id, entreprises FROM listes WHERE criteres->>'auto' = 'hotleads' LIMIT 1`;
  return rows[0] || null;
}

async function callBackendEnable({ userId, email }) {
  const backendBase = String(process.env.BACKEND_API_URL || '').replace(/\/$/, '');
  const url = process.env.BACKEND_SIGNUP_ENABLE_URL || (backendBase ? `${backendBase}/auth/internal/signups/enable` : '');
  const token = String(process.env.SOFY_SIGNUP_TOKEN || '').trim();
  if (!url) throw new Error('BACKEND_API_URL or BACKEND_SIGNUP_ENABLE_URL is not configured');
  if (!token) throw new Error('SOFY_SIGNUP_TOKEN is not configured');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sofy-Signup-Token': token
    },
    body: JSON.stringify({ user_id: userId || undefined, email: email || undefined })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.erreur || data.detail || `HTTP ${response.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (!sql) return res.status(500).json({ erreur: 'Base de données non configurée' });
  await ensureSchema();
  const user = verifierToken(req);
  if (!user) return res.status(401).json({ erreur: 'Connexion requise' });

  try {
    const list = await getHotLeadList();
    const entreprises = (list && Array.isArray(list.entreprises)) ? list.entreprises : [];

    if (req.method === 'GET') {
      const signups = entreprises
        .map((e, idx) => ({ e, idx }))
        .filter(({ e }) => ((e.signal && e.signal.type) || '') === 'signup' || signupInfo(e))
        .map(({ e, idx }) => normalizeSignup(e, idx, list ? list.id : null))
        .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
      return res.status(200).json({
        ok: true,
        signups,
        pending_count: signups.filter(s => s.pending).length
      });
    }

    if (req.method === 'POST') {
      if (!['admin', 'superadmin'].includes(user.role)) {
        return res.status(403).json({ erreur: 'Réservé aux administrateurs' });
      }
      const { key } = req.body || {};
      if (!list) return res.status(404).json({ erreur: 'Liste Hot Leads introuvable' });
      if (!key) return res.status(400).json({ erreur: 'key requis' });

      const idx = entreprises.findIndex(e => signupKey(e) === key);
      if (idx < 0) return res.status(404).json({ erreur: 'Signup introuvable' });

      const current = entreprises[idx];
      const normalized = normalizeSignup(current, idx, list.id);
      if (!normalized.pending) return res.status(200).json({ ok: true, already_enabled: true, signup: normalized });
      if (!normalized.can_enable) return res.status(400).json({ erreur: 'Aucun user_id ou email pour activer ce signup' });

      const backend = await callBackendEnable({ userId: normalized.user_id, email: normalized.contact.email });
      const enabledAt = new Date().toISOString();
      const latestList = await getHotLeadList();
      const latestEntreprises = (latestList && Array.isArray(latestList.entreprises)) ? latestList.entreprises : [];
      const latestIdx = latestEntreprises.findIndex(e => signupKey(e) === key);
      if (!latestList || latestIdx < 0) return res.status(404).json({ erreur: 'Signup introuvable après activation backend' });
      const latest = latestEntreprises[latestIdx];
      const signup = {
        ...(signupInfo(latest) || {}),
        user_id: backend.user_id || normalized.user_id || null,
        organization_id: normalized.organization_id || null,
        enabled: true,
        disabled: false,
        enabled_at: enabledAt,
        enabled_by: user.nom
      };
      latestEntreprises[latestIdx] = {
        ...latest,
        signup,
        signup_enabled_at: enabledAt,
        signup_enabled_by: user.nom,
        signal: {
          ...(latest.signal || {}),
          signup
        }
      };
      await sql`UPDATE listes SET entreprises = ${JSON.stringify(latestEntreprises)} WHERE id = ${latestList.id}`;
      return res.status(200).json({ ok: true, signup: normalizeSignup(latestEntreprises[latestIdx], latestIdx, latestList.id), backend });
    }

    return res.status(405).json({ erreur: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur signups', detail: err.message });
  }
}
