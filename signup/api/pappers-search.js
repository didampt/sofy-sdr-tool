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

  const input = String(req.query.q || '').trim();
  const numeric = /^[\d\s]+$/.test(input);
  const q = numeric ? input.replace(/\s/g, '') : input;
  const identifier = numeric && (q.length === 9 || q.length === 14);
  if (numeric && !identifier) return json(res, 200, { companies: [], next_cursor: null });
  if (q.length < 3) return json(res, 200, { companies: [] });

  const limited = await rateLimit(`pappers:${clientIp(req)}`, 80, 60);
  if (!limited.ok) return json(res, 429, { error: 'Too many requests', retry_after: limited.retryAfter });

  const cursor = String(req.query.cursor || '*');
  const key = JSON.stringify([q.toLowerCase(), cursor]);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return json(res, 200, hit.payload);

  try {
    const token = requireEnv('PAPPERS_API_TOKEN');
    const url = new URL(`https://api.pappers.fr/v2/${identifier ? 'entreprise' : 'recherche'}`);
    url.searchParams.set('api_token', token);
    if (identifier) {
      url.searchParams.set(q.length === 9 ? 'siren' : 'siret', q);
    } else {
      url.searchParams.set('q', q);
      url.searchParams.set('curseur', cursor);
      url.searchParams.set('par_curseur', '50');
      url.searchParams.set('entreprise_cessee', 'false');
    }

    const upstream = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok && !(identifier && upstream.status === 404)) {
      return json(res, upstream.status, { error: 'Pappers error', detail: data });
    }

    if (identifier) {
      const establishment = q.length === 14
        ? [data.siege, ...(data.etablissements || [])].find(item => item?.siret === q)
        : null;
      const company = mapCompany(establishment ? { ...data, siege: establishment } : data);
      const payload = {
        companies: upstream.ok && !data.entreprise_cessee && (company.name || company.siret)
          ? [{ ...company, details_loaded: true }]
          : [],
        next_cursor: null
      };
      cache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, payload });
      return json(res, 200, payload);
    }

    const results = data.resultats || [];
    const payload = {
      companies: results.map(mapCompany).filter(c => c.name || c.siret),
      next_cursor: results.length > 0 && data.curseurSuivant !== cursor ? (data.curseurSuivant || null) : null
    };
    cache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, payload });
    return json(res, 200, payload);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
