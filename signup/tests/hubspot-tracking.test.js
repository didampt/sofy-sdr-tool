import assert from 'node:assert/strict';
import test from 'node:test';
import { initHubSpotAttribution, HUBSPOT_CONFIRMATION_PATH } from '../public/hubspot.js';

function browser({ hostname = 'signup.sofy.fr', loaded = false, blockedStorage = false } = {}) {
  const values = new Map();
  const scripts = [];
  const win = { location: { hostname }, sessionStorage: {
    getItem(key) { if (blockedStorage) throw Error('blocked'); return values.get(key); },
    setItem(key, value) { if (blockedStorage) throw Error('blocked'); values.set(key, value); }
  } };
  const doc = {
    getElementById: () => loaded,
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: node => scripts.push(node) }
  };
  return { win, doc, scripts, consent(value) {
    win._hsq.find(([method]) => method === 'addPrivacyConsentListener')[1](value);
  }, events() { return win._hsq?.filter(([method]) => method !== 'addPrivacyConsentListener') || []; } };
}
const signup = { status: 201, data: { ok: true }, reference: 'opaque-id', email: 'Test@Example.com' };

test('native tracker loads EU portal once, without collecting the form', () => {
  const b = browser();
  initHubSpotAttribution(b.win, b.doc);
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, 'https://js-eu1.hs-scripts.com/147834354.js');
  assert.equal(b.scripts[0].async, true);
  assert.deepEqual(b.events(), []); // Let HubSpot record the real landing view first.
  const existing = browser({ loaded: true });
  initHubSpotAttribution(existing.win, existing.doc);
  assert.equal(existing.scripts.length, 0);
});

test('previews and development hosts never load or identify against the live portal', () => {
  for (const [hostname, preview] of [['localhost', false], ['branch.vercel.app', false], ['signup.sofy.fr', true]]) {
    const b = browser({ hostname });
    const record = initHubSpotAttribution(b.win, b.doc, { preview });
    assert.equal(record(signup), false);
    assert.equal(b.scripts.length, 0);
    assert.equal(b.win._hsq, undefined);
  }
});

test('accepted signup identifies by email then records the native confirmation page, without Google PII', () => {
  const b = browser();
  const record = initHubSpotAttribution(b.win, b.doc);
  b.consent({ allowed: true });
  assert.equal(record(signup), true);
  assert.deepEqual(b.events(), [
    ['identify', { email: 'test@example.com' }],
    ['setPath', HUBSPOT_CONFIRMATION_PATH],
    ['trackPageView']
  ]);
  assert.equal(b.win.dataLayer, undefined);
  assert.equal(record(signup), false);
  b.consent({ allowed: true });
  assert.equal(b.events().length, 3);
  const recordAgain = initHubSpotAttribution(b.win, b.doc);
  // Reinitialization/session storage cannot record the same accepted signup twice.
  b.win._hsq.filter(([name]) => name === 'addPrivacyConsentListener').at(-1)[1]({ allowed: true });
  assert.equal(recordAgain(signup), false);
});

test('pending signup waits for tracker readiness and analytics consent, including manual SMS review', async () => {
  const b = browser();
  const record = initHubSpotAttribution(b.win, b.doc);
  assert.equal(record({ ...signup, status: 202, data: { ok: true, manual_review: true } }), false);
  assert.deepEqual(b.events(), []);
  b.consent({ allowed: false });
  b.consent({ allowed: true, categories: { analytics: false, advertisement: true } });
  assert.deepEqual(b.events(), []);
  b.consent({ allowed: false, categories: { analytics: true, advertisement: false } });
  assert.deepEqual(b.events(), []); // Tracker startup/landing view must finish first.
  await Promise.resolve();
  assert.equal(b.events().length, 3);
  assert.equal(record(signup), false); // Same signup later created/activated.
});

test('errors, preview confirmations, missing IDs and invalid emails never identify a visitor', () => {
  const b = browser();
  const record = initHubSpotAttribution(b.win, b.doc);
  b.consent({ allowed: true });
  for (const status of [200, 202, 400, 401, 409, 429, 502]) assert.equal(record({ ...signup, status }), false);
  for (const patch of [{ preview: true }, { reference: '' }, { email: '' }, { email: 'invalid' }, { data: { ok: false } }]) {
    assert.equal(record({ ...signup, ...patch }), false);
  }
  assert.deepEqual(b.events(), []);
});

test('blocked storage and broken tracking do not prevent signup completion', () => {
  const b = browser({ blockedStorage: true });
  const record = initHubSpotAttribution(b.win, b.doc);
  b.consent({ allowed: true });
  assert.equal(record(signup), true);
  assert.equal(record(signup), false);
  b.win._hsq = { push() { throw Error('blocked'); } };
  assert.equal(record({ ...signup, reference: 'second-id' }), false);
  const c = browser();
  c.doc.head.appendChild = () => { throw Error('blocked'); };
  assert.equal(initHubSpotAttribution(c.win, c.doc)(signup), false);
});

const body = {
  email: 'test@example.com', first_name: 'Test', last_name: 'Signup',
  company: { name: 'Company', siret: '01234567890123' },
  tracking: { original: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'SMS', gclid: 'click-id' } }
};

test('CRM sync leaves acquisition to HubSpot and preserves contact/company associations', async t => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.HUBSPOT_API_KEY;
  process.env.HUBSPOT_API_KEY = 'test-only';
  try {
    for (const scenario of ['new', 'existing-customer', 'search-fails']) {
      await t.test(scenario, async () => {
        const writes = [];
        const sync = (await import(`../api/hubspot-signup.js?scenario=${scenario}`)).syncSignupToHubSpot;
        globalThis.fetch = async (url, options) => {
          const payload = options.body ? JSON.parse(options.body) : null;
          if (url.includes('/properties/')) return Response.json({ results: [
            { name: 'siret', type: 'string' },
            // Even if previous custom/legacy acquisition fields exist, do not write them.
            { name: 'sofy_signup_channel', type: 'string' },
            { name: 'utm_source', type: 'string' },
            { name: 'hs_analytics_source', type: 'enumeration' }
          ] });
          if (url.endsWith('/search')) {
            if (scenario === 'search-fails') return Response.json({ message: 'Rate limit' }, { status: 429 });
            return Response.json(scenario === 'existing-customer'
              ? { total: 1, results: [{ id: 'company', properties: { lifecyclestage: 'customer', hs_analytics_source: 'ORGANIC_SEARCH' } }] }
              : { total: 0 });
          }
          if (options.method === 'GET') return scenario === 'existing-customer'
            ? Response.json({ id: 'contact', properties: { hs_analytics_source: 'ORGANIC_SEARCH' } })
            : Response.json({}, { status: 404 });
          writes.push({ url, method: options.method, payload });
          return Response.json({ id: url.endsWith('/companies') ? 'company' : 'contact' });
        };
        if (scenario === 'search-fails') {
          await assert.rejects(sync(body), /Rate limit/);
          assert.equal(writes.length, 0);
          return;
        }
        const result = await sync(body);
        assert.equal(result.ok, true);
        assert.deepEqual(result.warnings, []);
        for (const write of writes.filter(x => x.payload?.properties)) {
          const properties = write.payload.properties;
          assert.equal(properties.lifecyclestage, undefined);
          assert.ok(!Object.keys(properties).some(key => /^(sofy_signup_|hs_analytics_|utm_)/.test(key)));
        }
        assert.ok(writes.some(x => /\/associations\/default\/companies\/company$/.test(x.url)));
        const note = writes.find(x => x.url.endsWith('/notes')).payload.properties.hs_note_body;
        assert.match(note, /UTM campaign: SMS/);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.HUBSPOT_API_KEY;
    else process.env.HUBSPOT_API_KEY = originalToken;
  }
});
