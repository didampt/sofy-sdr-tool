import { clientIp, json, rateLimit } from './_lib.js';
import { fetchEntreprises } from './_entreprises.js';

export const config = { maxDuration: 10 };

const cache = new Map();

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  const input = String(req.query.q || '').trim();
  const numeric = /^[\d\s]+$/.test(input);
  const q = numeric ? input.replace(/\s/g, '') : input.toLowerCase();
  const identifier = numeric && (q.length === 9 || q.length === 14);
  if (numeric && !identifier) return json(res, 200, { companies: [], next_cursor: null });
  if (q.length < 3) return json(res, 200, { companies: [] });

  const limited = await rateLimit(`pappers:${clientIp(req)}`, 80, 60);
  if (!limited.ok) return json(res, 429, { error: 'Too many requests', retry_after: limited.retryAfter });

  const cursor = String(req.query.cursor || '*');
  const key = JSON.stringify([q.toLowerCase(), cursor]);
  const hit = cache.get(key);
  if (req.query.refresh !== '1' && hit && hit.expiresAt > Date.now()) return json(res, 200, hit.payload);

  try {
    const { response, data } = await fetchEntreprises('/api/companies', {
      q, cursor, limit: '50'
    });
    if (!response.ok) {
      return json(res, response.status, { error: data.error || 'Company registry error' });
    }
    if (!Array.isArray(data.companies) || (data.next_cursor != null && typeof data.next_cursor !== 'string')) {
      return json(res, 502, { error: 'Invalid company registry response' });
    }
    const payload = {
      companies: data.companies.map(company => ({ ...company, details_loaded: true })),
      next_cursor: data.next_cursor || null
    };
    cache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, payload });
    return json(res, 200, payload);
  } catch {
    return json(res, 500, { error: 'Company registry unavailable' });
  }
}
