import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Keep these checks independent of production database configuration.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
let moduleID = 0;
async function handlers() {
  const id = ++moduleID;
  return {
    search: (await import(`../api/pappers-search.js?test=${id}`)).default,
    detail: (await import(`../api/pappers-company.js?test=${id}`)).default
  };
}
async function call(handler, query = {}, method = 'GET') {
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await handler({ method, query, headers: {}, socket: { remoteAddress: `test-${moduleID}` } }, res);
  return { status: res.statusCode, body: res.body };
}
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
const company = { name: 'Boutique', legal_name: 'Société Boutique', siret: '01234567800001', siren: '012345678', address: '7 RUE DU PORT', city: 'Pointe-à-Pitre', legal_form: '5710', activity: '47.11A', tva_id: '' };

test('signup company registry proxy', async t => {
  const originalFetch = globalThis.fetch;
  process.env.SOFY_ENTREPRISES_API_KEY = 'test-registry-key';
  delete process.env.SOFY_ENTREPRISES_API_URL;
  try {
    await t.test('default host, server-side bearer, response fields, normalized name and pagination', async () => {
      const { search } = await handlers();
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url: new URL(url), options });
        return reply({ companies: [company], next_cursor: calls.length === 1 ? 'opaque-cursor' : null });
      };
      const first = await call(search, { q: '  BOUTIQUE  ' });
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { companies: [{ ...company, details_loaded: true }], next_cursor: 'opaque-cursor' });
      assert.equal(calls[0].url.origin, 'https://entreprises.system.sofy.fr');
      assert.equal(calls[0].url.pathname, '/api/companies');
      assert.equal(calls[0].url.searchParams.get('q'), 'boutique');
      assert.equal(calls[0].url.searchParams.get('limit'), '50');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer test-registry-key');
      assert.equal(calls[0].options.redirect, 'error');
      assert.ok(calls[0].options.signal instanceof AbortSignal);
      assert.ok(!JSON.stringify(first.body).includes('test-registry-key'));
      const second = await call(search, { q: 'Boutique', cursor: first.body.next_cursor });
      assert.equal(second.status, 200);
      assert.equal(calls[1].url.searchParams.get('q'), 'boutique');
      assert.equal(calls[1].url.searchParams.get('cursor'), 'opaque-cursor');
      assert.equal(second.body.next_cursor, null);
    });
    await t.test('SIREN and SIRET use one registry search and preserve leading zeros', async () => {
      const { search } = await handlers();
      const queries = [];
      globalThis.fetch = async url => { queries.push(new URL(url).searchParams.get('q')); return reply({ companies: [company], next_cursor: null }); };
      for (const q of ['012 345 678', '012 345 678 00001']) {
        const r = await call(search, { q });
        assert.equal(r.status, 200);
        assert.equal(r.body.companies[0].details_loaded, true);
      }
      assert.deepEqual(queries, ['012345678', '01234567800001']);
    });
    await t.test('detail route preserves the form contract and uses the configurable base', async () => {
      const { detail } = await handlers();
      process.env.SOFY_ENTREPRISES_API_URL = 'https://alternate.example/';
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://alternate.example/api/companies/01234567800001');
        assert.equal(options.headers.Authorization, 'Bearer test-registry-key');
        return reply({ company });
      };
      assert.deepEqual(await call(detail, { siret: '012 345 678 00001' }), { status: 200, body: { company: { ...company, details_loaded: true } } });
      delete process.env.SOFY_ENTREPRISES_API_URL;
    });
    await t.test('successful caches remain and forced first-page refresh bypasses a stale cache', async () => {
      const { search, detail } = await handlers();
      let calls = 0;
      globalThis.fetch = async url => { calls++; return new URL(url).pathname === '/api/companies' ? reply({ companies: [company], next_cursor: `cursor-${calls}` }) : reply({ company }); };
      await call(search, { q: 'Boutique' });
      await call(search, { q: 'BOUTIQUE' });
      assert.equal(calls, 1);
      const fresh = await call(search, { q: 'Boutique', refresh: '1' });
      assert.equal(calls, 2);
      assert.equal(fresh.body.next_cursor, 'cursor-2');
      await call(detail, { siret: company.siret });
      await call(detail, { siret: company.siret });
      assert.equal(calls, 3);
    });
    await t.test('invalid identifiers and unsupported methods never call upstream', async () => {
      const { search, detail } = await handlers();
      globalThis.fetch = () => { throw new Error('unexpected upstream call'); };
      assert.deepEqual((await call(search, { q: '1234' })).body.companies, []);
      assert.deepEqual((await call(search, { q: 'ab' })).body.companies, []);
      assert.equal((await call(detail, { siret: '1234' })).status, 400);
      assert.equal((await call(search, {}, 'POST')).status, 405);
      assert.equal((await call(detail, {}, 'POST')).status, 405);
    });
    await t.test('upstream failures and stale cursors are forwarded, never cached', async () => {
      const { search, detail } = await handlers();
      for (const status of [409, 503, 429]) {
        globalThis.fetch = async () => reply({ error: `registry-${status}` }, status);
        const result = await call(search, { q: 'boutique', cursor: 'old-cursor' });
        assert.equal(result.status, status);
        assert.equal(result.body.error, `registry-${status}`);
      }
      globalThis.fetch = async () => reply({ error: 'company not found' }, 404);
      assert.equal((await call(detail, { siret: company.siret })).status, 404);
    });
    await t.test('malformed or failed upstream responses do not expose internals or the token', async () => {
      const { search, detail } = await handlers();
      globalThis.fetch = async () => reply({ resultats: [] });
      assert.equal((await call(search, { q: 'boutique' })).status, 502);
      assert.equal((await call(detail, { siret: company.siret })).status, 502);
      globalThis.fetch = async () => { throw new Error('test-registry-key internal upstream failure'); };
      const result = await call(search, { q: 'boutique' });
      assert.equal(result.status, 500);
      assert.equal(result.body.error, 'Company registry unavailable');
      globalThis.fetch = async () => new Response('<html>Bad gateway</html>');
      assert.equal((await call(detail, { siret: company.siret })).status, 500);
    });
    await t.test('missing key fails without making an unauthenticated request', async () => {
      const { search } = await handlers();
      delete process.env.SOFY_ENTREPRISES_API_KEY;
      let fetched = false;
      globalThis.fetch = async () => { fetched = true; return reply({}); };
      assert.equal((await call(search, { q: 'boutique' })).status, 500);
      assert.equal(fetched, false);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SOFY_ENTREPRISES_API_KEY;
    delete process.env.SOFY_ENTREPRISES_API_URL;
  }
});

test('dropdown restarts with fresh results after a registry snapshot changes', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function escapeCompanyText('), source.indexOf('function renderCompanyLoading('));
  const calls = [];
  let more;
  let focused = false;
  const results = { innerHTML: '', scrollTop: 120, querySelectorAll(selector) { return selector === '[data-index]' ? [{ focus() { focused = true; } }] : []; }, appendChild(button) { more = button; } };
  const cache = new Map([['boutique', { companies: [{ name: 'Old' }], next_cursor: 'stale' }]]);
  const context = vm.createContext({
    AbortController, URLSearchParams,
    companyResults: results,
    companyName: { value: 'Boutique', setAttribute() {} },
    searchCache: cache,
    abortSearch: null,
    isFrenchCompanyCountry: () => true,
    selectCompany() {},
    document: { createElement() { return { addEventListener(_event, callback) { this.click = callback; } }; } },
    fetch: async url => {
      calls.push(String(url));
      return calls.length === 1 ? reply({ error: 'registry refreshed' }, 409) : reply({ companies: [company], next_cursor: null });
    }
  });
  vm.runInContext(`${render}\nrenderCompanies([{name:'Old',siret:'old'}], 'stale', 'Boutique');`, context);
  await more.click();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1], 'https://signup.example').searchParams.get('refresh'), '1');
  assert.equal(cache.get('boutique').companies.length, 1);
  assert.equal(cache.get('boutique').companies[0].siret, company.siret);
  assert.ok(!results.innerHTML.includes('Old'));
  assert.equal(results.scrollTop, 0);
  assert.equal(focused, true);
});


test('company dropdown renders registry values as text, including HTML characters', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function escapeCompanyText('), source.indexOf('function renderCompanyLoading('));
  const results = { innerHTML: '', querySelectorAll() { return []; } };
  const context = vm.createContext({ companyResults: results, companyName: { value: '', setAttribute() {} } });
  vm.runInContext(`${render}\nrenderCompanies([{name:'<img src=x onerror=alert(1)> & "Sons"',siret:'<id>',city:'<script>alert(1)</script>'}]);`, context);
  assert.ok(!results.innerHTML.includes('<img'));
  assert.ok(!results.innerHTML.includes('<script>'));
  assert.ok(results.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Sons&quot;'));
  assert.ok(results.innerHTML.includes('&lt;id&gt;'));
  assert.ok(results.innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
