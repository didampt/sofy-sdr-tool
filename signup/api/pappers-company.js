import { clientIp, json, rateLimit, requireEnv } from './_lib.js';

export const config = { maxDuration: 10 };

const cache = new Map();

function mapCompany(data) {
  const siege = data.siege || {};
  return {
    name: data.nom_entreprise || data.denomination || data.nom_complet || '',
    siret: siege.siret || data.siret || '',
    siren: data.siren || '',
    tva_id: data.numero_tva_intracommunautaire || data.tva_intracommunautaire || '',
    address: [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' '),
    postal_code: siege.code_postal || '',
    city: siege.ville || '',
    legal_form: data.forme_juridique || data.forme_juridique_code || '',
    activity: data.libelle_code_naf || data.code_naf || '',
    pappers_raw: data
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  const siret = String(req.query.siret || '').replace(/\D/g, '');
  if (siret.length !== 14) return json(res, 400, { error: 'Valid SIRET is required' });

  const limited = await rateLimit(`pappers-company:${clientIp(req)}`, 40, 60);
  if (!limited.ok) return json(res, 429, { error: 'Too many requests', retry_after: limited.retryAfter });

  const hit = cache.get(siret);
  if (hit && hit.expiresAt > Date.now()) return json(res, 200, hit.payload);

  try {
    const token = requireEnv('PAPPERS_API_TOKEN');
    const url = new URL('https://api.pappers.fr/v2/entreprise');
    url.searchParams.set('api_token', token);
    url.searchParams.set('siret', siret);

    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: 'Pappers error', detail: data });

    const payload = { company: mapCompany(data) };
    cache.set(siret, { expiresAt: Date.now() + 30 * 60 * 1000, payload });
    return json(res, 200, payload);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
