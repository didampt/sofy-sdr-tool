import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const base = process.env.REGISTRY_TEST_URL;
test('signup HTTP handlers against the running registry container', { skip: !base }, async t => {
  // This test is deliberately limited to the local fixture service.
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
  assert.ok(process.env.REGISTRY_TEST_KEY);
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.SOFY_ENTREPRISES_API_URL = base;
  process.env.SOFY_ENTREPRISES_API_KEY = process.env.REGISTRY_TEST_KEY;
  const search = (await import('../api/pappers-search.js')).default;
  const detail = (await import('../api/pappers-company.js')).default;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    const handler = url.pathname === '/api/pappers-search' ? search : detail;
    handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const signup = `http://127.0.0.1:${server.address().port}`;
  const firstResponse = await fetch(`${signup}/api/pappers-search?q=ETOILE`);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.companies.length, 50);
  assert.equal(first.companies[0].legal_name, 'Société Étoile');
  assert.equal(first.companies[0].details_loaded, true);
  assert.ok(first.next_cursor);
  const nextResponse = await fetch(`${signup}/api/pappers-search?${new URLSearchParams({ q: 'Etoile', cursor: first.next_cursor })}`);
  assert.equal(nextResponse.status, 200);
  const second = await nextResponse.json();
  assert.equal(second.companies.length, 2);
  assert.equal(second.next_cursor, null);
  for (const [q, siret] of [['012 345 678', '01234567800002'], ['01234567800001', '01234567800001']]) {
    const response = await fetch(`${signup}/api/pappers-search?${new URLSearchParams({ q })}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).companies[0].siret, siret);
  }
  const response = await fetch(`${signup}/api/pappers-company?siret=01234567800001`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.company.address, '7 RUE DU PORT');
  assert.equal(result.company.city, 'Pointe-à-Pitre');
  assert.ok(!JSON.stringify(result).includes(process.env.REGISTRY_TEST_KEY));
  assert.equal((await fetch(`${signup}/api/pappers-company?siret=01234567800054`)).status, 404);
});
