import { clientIp, json, rateLimit } from './_lib.js';
import { fetchEntreprises } from './_entreprises.js';

export const config = { maxDuration: 10 };

const cache = new Map();

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  const siret = String(req.query.siret || '').replace(/\D/g, '');
  if (siret.length !== 14) return json(res, 400, { error: 'Valid SIRET is required' });

  const limited = await rateLimit(`pappers-company:${clientIp(req)}`, 40, 60);
  if (!limited.ok) return json(res, 429, { error: 'Too many requests', retry_after: limited.retryAfter });

  const hit = cache.get(siret);
  if (hit && hit.expiresAt > Date.now()) return json(res, 200, hit.payload);

  try {
    const { response, data } = await fetchEntreprises(`/api/companies/${siret}`);
    if (!response.ok) {
      return json(res, response.status, { error: data.error || 'Company registry error' });
    }
    if (!data.company || typeof data.company !== 'object' || Array.isArray(data.company)) {
      return json(res, 502, { error: 'Invalid company registry response' });
    }
    const payload = { company: { ...data.company, details_loaded: true } };
    cache.set(siret, { expiresAt: Date.now() + 30 * 60 * 1000, payload });
    return json(res, 200, payload);
  } catch {
    return json(res, 500, { error: 'Company registry unavailable' });
  }
}
