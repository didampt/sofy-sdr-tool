import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../api/purchase-c8d6614869335b19882d8f877d35657b.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export const config', 'const config')
  .replace('export default async function handler', 'async function handler');
const purchase = { organization_id: '01K9CFY71N7N1M9D9E3D1B3D9E', payment_id: 'pi_first', invoice_id: 'invoice-1',
  paid_at: '2026-01-04T10:34:56.000Z', amount_cents: 2400, currency: 'eur' };
function fixture({ existingDate = '', siret = '12345678901234', associated = [{ id: '42' }], total = 1, payloads, patchFails = false } = {}) {
  const data = new Map();
  const requests = [];
  let property = existingDate;
  let failPatch = patchFails;
  const signupPayloads = payloads || [{ company: { siret }, email: 'signup@example.com' }];
  const sql = async (parts, ...values) => {
    const query = parts.join('?');
    if (query.includes('FROM listes')) return signupPayloads.map(payload => ({ payload }));
    if (query.includes('INSERT INTO config')) {
      const [key, json] = values;
      const incoming = JSON.parse(json);
      if (key.includes('_lock:')) {
        const lock = data.get(key);
        if (lock && new Date(lock.expires_at) > new Date()) return [];
        data.set(key, incoming);
        return [{ valeur: incoming }];
      }
      if (!data.has(key) || new Date(data.get(key).paid_at) > new Date(incoming.paid_at)) data.set(key, incoming);
      return [];
    }
    if (query.includes('SELECT valeur')) return data.has(values[0]) ? [{ valeur: data.get(values[0]) }] : [];
    if (query.includes('UPDATE config')) {
      const [eligible, key, paymentId] = values;
      if (data.get(key)?.payment_id === paymentId) data.get(key).is_first_purchase = JSON.parse(eligible);
      return [];
    }
    if (query.includes('DELETE FROM config')) {
      if (data.get(values[0])?.owner === values[1]) data.delete(values[0]);
      return [];
    }
    throw Error('Unexpected SQL');
  };
  const context = vm.createContext({ crypto, Buffer, sql, ensureSchema: async () => {}, AbortSignal,
    console: { error() {} }, process: { env: { HUBSPOT_API_KEY: 'test-key' } },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (url.endsWith('/search')) return Response.json({ total, results: total ? [{ id: '42' }] : [] });
      if (url.includes('/contacts/')) return Response.json({ associations: { companies: { results: associated } } });
      if (options.method === 'PATCH') {
        if (failPatch) return Response.json({}, { status: 503 });
        property = JSON.parse(options.body).properties.sofy_first_self_service_purchase_at;
        return Response.json({ id: '42' });
      }
      return Response.json({ properties: { sofy_first_self_service_purchase_at: property } });
    }
  });
  vm.runInContext(`${source}\nthis.handler = handler;`, context);
  return { data, requests, retryPatch() { failPatch = false; },
    async call(body = purchase, { method = 'POST' } = {}) {
      const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await context.handler({ method, headers: {}, body }, res);
      return res;
    }, patches() { return requests.filter(x => x.method === 'PATCH'); }
  };
}

test('opaque receiver accepts requests without a token and preserves the first purchase date', async () => {
  const f = fixture();
  let res = await f.call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.first_purchase_at, '2026-01-04T00:00:00.000Z');
  await f.call();
  await f.call({ ...purchase, payment_id: 'pi_later', paid_at: '2026-02-05T12:00:00Z' });
  assert.equal(f.patches().length, 1);
  assert.deepEqual(f.patches()[0].body.properties, { sofy_first_self_service_purchase_at: '2026-01-04T00:00:00.000Z' });
  assert.equal(f.data.get('self_service_purchase:42').payment_id, 'pi_first');
  assert.ok(![...f.data.keys()].some(key => key.includes('_lock:')));
});

test('existing CRM dates stay earlier, and out-of-order older payments correct later dates', async () => {
  const f = fixture({ existingDate: '2025-12-01T00:00:00Z' });
  await f.call();
  assert.equal(f.patches().length, 0);
  const late = fixture();
  await late.call({ ...purchase, paid_at: '2026-02-05T12:00:00Z' });
  const res = await late.call();
  assert.equal(res.body.first_purchase_at, '2026-01-04T00:00:00.000Z');
  assert.equal(late.patches().length, 2);
});

test('failed HubSpot sync preserves the first fact and a later duplicate repairs it', async () => {
  const f = fixture({ patchFails: true });
  assert.equal((await f.call()).statusCode, 502);
  assert.ok(f.data.has('self_service_purchase:42'));
  f.retryPatch();
  const res = await f.call({ ...purchase, payment_id: 'pi_later', paid_at: '2026-02-05T12:00:00Z' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.first_purchase_at, '2026-01-04T00:00:00.000Z');
});

test('invalid requests never query HubSpot', async () => {
  const f = fixture();
  assert.equal((await f.call(purchase, { method: 'GET' })).statusCode, 405);
  for (const patch of [{ organization_id: 'bad' }, { payment_id: 'bad' }, { paid_at: 'bad' }, { amount_cents: 0 }, { currency: 'bad-currency' }]) {
    assert.equal((await f.call({ ...purchase, ...patch })).statusCode, 400);
  }
  assert.equal(f.requests.length, 0);
});

test('company resolution uses native contact association, with exact SIRET fallback', async () => {
  for (const total of [0, 2]) {
    const f = fixture({ total, associated: [] });
    assert.equal((await f.call()).statusCode, 502);
    assert.equal(f.patches().length, 0);
  }
  const international = fixture({ siret: '' });
  assert.equal((await international.call()).statusCode, 200);
  assert.match(international.requests[0].url, /signup%40example.com/);
  const ambiguous = fixture({ siret: '', associated: [{ id: '42' }, { id: '43' }] });
  assert.equal((await ambiguous.call()).statusCode, 502);
  assert.equal(ambiguous.patches().length, 0);
  const sameCompany = fixture({ payloads: [
    { company: { siret: '12345678901234' }, email: 'one@example.com' },
    { company: { siret: '12345678901234' }, email: 'two@example.com' }
  ] });
  assert.equal((await sameCompany.call()).statusCode, 200);
  assert.equal((await fixture({ payloads: [] }).call()).statusCode, 404);
});

test('another active company sync cannot be overwritten or have its lease released', async () => {
  const f = fixture();
  f.data.set('self_service_purchase_lock:42', { owner: 'other-owner', expires_at: new Date(Date.now() + 30000).toISOString() });
  assert.equal((await f.call()).statusCode, 409);
  assert.equal(f.patches().length, 0);
  assert.equal(f.data.get('self_service_purchase_lock:42').owner, 'other-owner');
});


test('lookup waits for fulfillment and reports only the company first payment', async () => {
  const f = fixture();
  const lookup = { operation: 'lookup', organization_id: purchase.organization_id, payment_id: purchase.payment_id };
  assert.equal((await f.call(lookup)).statusCode, 202);
  await f.call();
  const res = await f.call(lookup);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.is_first_purchase, true);
  assert.equal(res.body.transaction_id, 'pi_first');
  assert.equal(res.body.value, 24);
  assert.equal(res.body.currency, 'EUR');
  assert.equal((await f.call({ ...lookup, payment_id: 'pi_later' })).body.is_first_purchase, false);
  const existing = fixture({ existingDate: '2025-12-01T00:00:00Z' });
  await existing.call();
  await existing.call();
  assert.equal((await existing.call(lookup)).body.is_first_purchase, false);
  const failed = fixture({ patchFails: true });
  await failed.call();
  assert.equal((await failed.call(lookup)).statusCode, 202);
});
