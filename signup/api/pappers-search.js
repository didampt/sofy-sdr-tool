import { clientIp, json, rateLimit, requireEnv } from './_lib.js';

export const config = { maxDuration: 10 };

const cache = new Map();

function mapCompany(item) {
  const siege = item.siege || {};
  return {
    name: item.nom_entreprise || item.denomination || item.nom_complet || '',
    siret: siege.siret || item.siret || '',
    siren: item.siren || '',
    tva_id: item.numero_tva_intracommunautaire || item.tva_intracommunautaire || '',
    address: [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' '),
    postal_code: siege.code_postal || '',
    city: siege.ville || '',
    legal_form: item.forme_juridique || item.forme_juridique_code || '',
    activity: item.libelle_code_naf || item.code_naf || '',
    pappers_raw: item
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  const q = String(req.query.q || '').trim();
  if (q.length < 3) return json(res, 200, { companies: [] });

  const limited = await rateLimit(`pappers:${clientIp(req)}`, 80, 60);
  if (!limited.ok) return json(res, 429, { error: 'Too many requests', retry_after: limited.retryAfter });

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return json(res, 200, hit.payload);

  try {
    const token = requireEnv('PAPPERS_API_TOKEN');
    const url = new URL('https://api.pappers.fr/v2/recherche');
    url.searchParams.set('api_token', token);
    url.searchParams.set('q', q);
    url.searchParams.set('par_page', '8');
    url.searchParams.set('entreprise_cessee', 'false');

    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: 'Pappers error', detail: data });

    const payload = { companies: (data.resultats || []).map(mapCompany).filter(c => c.name || c.siret) };
    cache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, payload });
    return json(res, 200, payload);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
