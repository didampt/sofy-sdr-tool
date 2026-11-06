// Purchase notifications use an opaque URL path; first-purchase state stays here.
import crypto from 'crypto';
import { sql, ensureSchema } from './db.js';

export const config = { maxDuration: 30 };
const FIRST_PURCHASE_PROPERTY = 'sofy_first_self_service_purchase_at';

async function hs(path, method = 'GET', body) {
  const response = await fetch(`https://api.hubapi.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(6000),
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    const err = new Error(`HubSpot HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function findCompany(signup) {
  // Signup already associates its contact to its company. Prefer that native
  // relationship: the portal's legacy numeric SIRET field can be empty.
  const email = String(signup.email || '').trim().toLowerCase();
  if (email) {
    let contact;
    try {
      contact = await hs(`/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&associations=companies`);
    } catch (err) { if (err.status !== 404) throw err; }
    const companies = contact?.associations?.companies;
    const ids = [...new Set((companies?.results || []).map(company => company.id))];
    if (ids.length === 1 && !companies.paging?.next) return ids[0];
  }
  const siret = String(signup.company?.siret || '').replace(/\D/g, '');
  if (/^\d{14}$/.test(siret)) {
    const property = process.env.HUBSPOT_SIGNUP_COMPANY_SIRET_PROPERTY || 'siret';
    const result = await hs('/crm/v3/objects/companies/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value: siret }] }],
      properties: [FIRST_PURCHASE_PROPERTY], limit: 2
    });
    if (result.total === 1 && result.results?.[0]?.id) return result.results[0].id;
  }
  throw new Error('Entreprise HubSpot introuvable ou ambiguë');
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  if (!Number.isFinite(date.getTime())) throw new Error('Date du premier achat HubSpot invalide');
  return date;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST uniquement' });
  if (!sql || !process.env.HUBSPOT_API_KEY) return res.status(503).json({ erreur: 'Tracking achats non configuré' });
  let purchase;
  try { purchase = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch {}
  const paidAt = new Date(purchase?.paid_at);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(purchase?.organization_id || ''))
    || !/^pi_[A-Za-z0-9]+$/.test(String(purchase?.payment_id || ''))
    || !String(purchase?.invoice_id || '').trim()
    || !Number.isFinite(paidAt.getTime()) || paidAt.getUTCFullYear() < 2020
    || paidAt.getTime() > Date.now() + 5 * 60 * 1000
    || !Number.isSafeInteger(purchase?.amount_cents) || purchase.amount_cents <= 0
    || !/^[A-Za-z]{3}$/.test(String(purchase?.currency || ''))) {
    return res.status(400).json({ erreur: 'Notification achat invalide' });
  }

  let lockKey;
  const owner = crypto.randomUUID();
  try {
    await ensureSchema();
    const rows = await sql`
      SELECT COALESCE(NULLIF(e->'signup', 'null'::jsonb), e->'signal'->'signup')->'payload' AS payload
      FROM listes l CROSS JOIN LATERAL jsonb_array_elements(l.entreprises) AS e
      WHERE COALESCE(NULLIF(e->'signup', 'null'::jsonb), e->'signal'->'signup')->>'organization_id' = ${purchase.organization_id}
    `;
    if (!rows.length) return res.status(404).json({ erreur: 'Organisation signup introuvable' });
    const contexts = new Map(rows.map(row => [String(row.payload?.company?.siret || '').replace(/\D/g, '') || String(row.payload?.email || '').toLowerCase(), row.payload]));
    // Do not guess if multiple signup identities have been linked to this org.
    if (contexts.size !== 1) return res.status(409).json({ erreur: 'Organisation signup ambiguë' });
    const companyId = String(await findCompany([...contexts.values()][0]));
    if (!/^\d+$/.test(companyId)) throw new Error('Identifiant entreprise HubSpot invalide');
    const key = `self_service_purchase:${companyId}`;
    const fact = { organization_id: purchase.organization_id, payment_id: purchase.payment_id,
      invoice_id: purchase.invoice_id, paid_at: paidAt.toISOString(),
      amount_cents: purchase.amount_cents, currency: purchase.currency.toLowerCase() };
    // The existing config JSON store provides an atomic earliest-payment fact without a schema migration.
    await sql`
      INSERT INTO config (cle, valeur) VALUES (${key}, ${JSON.stringify(fact)}::jsonb)
      ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur
      WHERE (config.valeur->>'paid_at')::timestamptz > (EXCLUDED.valeur->>'paid_at')::timestamptz
    `;
    lockKey = `self_service_purchase_lock:${companyId}`;
    const lease = { owner, expires_at: new Date(Date.now() + 35000).toISOString() };
    const locks = await sql`
      INSERT INTO config (cle, valeur) VALUES (${lockKey}, ${JSON.stringify(lease)}::jsonb)
      ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur
      WHERE (config.valeur->>'expires_at')::timestamptz < now()
      RETURNING valeur
    `;
    if (!locks.length) return res.status(409).json({ erreur: 'Synchronisation achat déjà en cours' });
    const current = await sql`SELECT valeur FROM config WHERE cle = ${key}`;
    const first = current[0].valeur;
    const company = await hs(`/crm/v3/objects/companies/${companyId}?properties=${FIRST_PURCHASE_PROPERTY}`);
    const existing = dateValue(company.properties?.[FIRST_PURCHASE_PROPERTY]);
    const candidate = new Date(new Date(first.paid_at).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    // Keep earlier dates, including existing CRM data; a delayed older payment may correct a later date.
    let updated = false;
    if (!existing || candidate < existing) {
      await hs(`/crm/v3/objects/companies/${companyId}`, 'PATCH', {
        properties: { [FIRST_PURCHASE_PROPERTY]: candidate.toISOString() }
      });
      updated = true;
    }
    return res.status(200).json({ ok: true, updated, company_id: companyId,
      first_purchase_at: (existing && existing <= candidate ? existing : candidate).toISOString() });
  } catch (err) {
    console.error('First purchase sync failed:', err.message);
    return res.status(502).json({ erreur: 'Synchronisation premier achat impossible' });
  } finally {
    if (lockKey) {
      try { await sql`DELETE FROM config WHERE cle = ${lockKey} AND valeur->>'owner' = ${owner}`; } catch {}
    }
  }
}
