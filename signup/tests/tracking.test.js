import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { initAttribution, trackConfirmedSignup } from '../public/tracking.js';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
}

test('first attribution survives a later direct visit; current visit stays separate', () => {
  const win = { localStorage: storage(), location: new URL('https://signup.sofy.fr/?utm_source=google&utm_campaign=sms&wbraid=click') };
  const first = initAttribution(win, { referrer: 'https://google.fr/' });
  win.location = new URL('https://signup.sofy.fr/');
  const later = initAttribution(win, { referrer: '' });
  assert.deepEqual(later.original, first.original);
  assert.equal(later.current.utm_source, '');
  assert.equal(later.original.wbraid, 'click');
  win.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(initAttribution(win, {}).original.landing_page, 'https://signup.sofy.fr/');
});

test('conversion requires accepted signup and deduplicates without sending personal data', () => {
  const win = { sessionStorage: storage() };
  const success = { status: 201, data: { ok: true }, reference: 'opaque-server-id' };
  for (const status of [200, 202, 400, 401, 409, 429, 502]) {
    assert.equal(trackConfirmedSignup(win, { ...success, status }), false);
  }
  assert.equal(trackConfirmedSignup(win, { ...success, preview: 'received' }), false);
  assert.equal(trackConfirmedSignup(win, { ...success, status: 202, data: { ok: false, manual_review: true } }), false);
  assert.equal(trackConfirmedSignup(win, { ...success, data: { ok: false } }), false);
  assert.equal(trackConfirmedSignup(win, success), true);
  assert.equal(trackConfirmedSignup(win, success), false);
  assert.deepEqual(win.dataLayer, [{ event: 'sign_up', method: 'self_service', transaction_id: 'opaque-server-id' }]);
  delete win.__sofySignupConversions;
  assert.equal(trackConfirmedSignup(win, success), false);
});

test('storage and tag failures cannot break the signup UI', () => {
  const win = { sessionStorage: { getItem() { throw Error(); }, setItem() { throw Error(); } } };
  const success = { status: 201, data: { ok: true }, reference: 'opaque' };
  assert.equal(trackConfirmedSignup(win, success), true);
  assert.equal(trackConfirmedSignup(win, success), false);
  assert.equal(trackConfirmedSignup({ dataLayer: { push() { throw Error('tag failed'); } } }, success), false);
});

test('real submission flow counts saved manual review and created accounts, excluding errors', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const submit = source.slice(source.indexOf('async function submitSignup('), source.indexOf('function validatedPayload('));
  for (const [status, data, expected] of [
    [201, { ok: true, conversion: { id: 'server-id' } }, 1],
    [202, { ok: true, manual_review: true, conversion: { id: 'manual-server-id' } }, 1],
    [202, { ok: true }, 0],
    [409, { code: 'EMAIL_ALREADY_EXISTS' }, 0],
    [401, { error: 'Invalid OTP' }, 0],
    [502, { error: 'Backend failed' }, 0]
  ]) {
    const win = {};
    const context = vm.createContext({ window: win, trackConfirmedSignup, trackHubSpotSignup: () => false,
      fetch: async () => new Response(JSON.stringify(data), { status }),
      pendingSignupPayload: {}, otpValue: () => '123456', otpPayload: x => x,
      submitBtn: {}, resendOtpBtn: {}, missingOtpBtn: {}, previewMode: '', signupCompleted: false,
      setError() {}, resetOtpStep() {}, renderReceivedView() {}, showExistingEmailError() {}
    });
    await vm.runInContext(`${submit}\nsubmitSignup({});`, context);
    assert.equal(win.dataLayer?.length || 0, expected, `HTTP ${status}`);
    assert.equal(context.signupCompleted, status < 400, `completion for HTTP ${status}`);
  }
});


test('manual review uses the same conversion deduplication as account creation', () => {
  const win = { sessionStorage: storage() };
  const reference = 'same-signup-id';
  assert.equal(trackConfirmedSignup(win, { status: 202, data: { ok: true, manual_review: true }, reference }), true);
  assert.equal(trackConfirmedSignup(win, { status: 202, data: { ok: true, manual_review: true }, reference }), false);
  assert.equal(trackConfirmedSignup(win, { status: 201, data: { ok: true }, reference }), false);
  assert.equal(win.dataLayer.length, 1);
});
