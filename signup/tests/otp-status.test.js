import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise handlers without production database, SMS, Slack or account writes.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.SOFY_V2_API_KEY = 'test-key';
process.env.SOFY_SCRAP_HOTLEAD_URL = 'https://sdr.example/intake';
process.env.SIGNUP_HOTLEAD_TOKEN = 'test-token';
const otpHandler = (await import('../api/signup-otp.js')).default;
const signupHandler = (await import('../api/signup.js')).default;
const payload = {
  first_name: 'Test', last_name: 'Signup', email: 'otp-test@example.com',
  phone: '+33612345678', country: 'France', country_code: 'FR',
  fonction: 'Direction', password: 'Example-Test123!', cgv_accepted: true,
  company: { name: 'Test', siret: '12345678901234', secteur: 'Commerce' }
};
let requestNumber = 0;
async function call(handler, body) {
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method: 'POST', body, headers: {}, socket: { remoteAddress: `otp-test-${++requestNumber}` } }, res);
  return { status: res.statusCode, body: res.body };
}
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status }); }

test('OTP status follows sending and explicit manual review', async t => {
  const originalFetch = globalThis.fetch;
  let smsFails = false;
  let backendCalls = 0;
  let sentCode;
  const records = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === 'https://api.sofy.fr/v2/sms') {
      sentCode = body.body.match(/\b\d{6}\b/)[0];
      return smsFails ? reply({ error: 'Unavailable' }, 503) : reply({ id: 'sms-test' });
    }
    if (url === process.env.SOFY_SCRAP_HOTLEAD_URL) {
      records.push(body);
      return reply({ ok: true });
    }
    backendCalls++;
    return reply({ user_id: 'test-user', organization_id: 'test-org' });
  };
  try {
    let challenge;
    await t.test('successful sending records pending with no missing-code claim', async () => {
      challenge = await call(otpHandler, payload);
      assert.equal(challenge.status, 200);
      assert.equal(challenge.body.sms_sent, true);
      assert.equal(records.at(-1).sms_verification_status, 'pending');
      assert.equal(records.at(-1).sms_verification_code, null);
      assert.equal(records.at(-1).sms_verification_reported_at, null);
    });
    await t.test('explicit missing-code report updates the same signup without creating an account', async () => {
      const result = await call(signupHandler, {
        ...payload, otp_token: challenge.body.otp_token,
        signup_reference: challenge.body.signup_reference, sms_verification_status: 'not_received'
      });
      assert.equal(result.status, 202);
      assert.equal(records.at(-1).otp_token, challenge.body.signup_reference);
      assert.equal(records.at(-1).sms_verification_status, 'not_received');
      assert.equal(records.at(-1).sms_verification_code, sentCode);
      assert.equal(backendCalls, 0);
      const count = records.length;
      const replay = await call(signupHandler, {
        ...payload, otp_token: challenge.body.otp_token, sms_verification_status: 'not_received'
      });
      assert.equal(replay.status, 401);
      assert.equal(records.length, count);
    });
    await t.test('a send failure still records the manual-review warning', async () => {
      smsFails = true;
      const result = await call(otpHandler, { ...payload, signup_reference: 'stable-reference' });
      assert.equal(result.body.sms_sent, false);
      assert.equal(records.at(-1).sms_verification_status, 'not_received');
      assert.equal(records.at(-1).sms_verification_code, sentCode);
      assert.equal(records.at(-1).otp_token, 'stable-reference');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack distinguishes pending verification and a later missing-code report', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const crypto = await import('node:crypto');
  const source = (await readFile(new URL('../../api/signup-hotlead.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace('export const config', 'const config')
    .replace('export default async function handler', 'async function handler');
  const messages = [];
  const stored = [];
  let result = { ajoute: true, liste_id: 1, cle_fiche: 'test' };
  const context = vm.createContext({
    crypto, Buffer,
    process: { env: { SIGNUP_HOTLEAD_TOKEN: 'test-token', SLACK_WEBHOOK_URL: 'https://slack.example/test' } },
    sql: {}, ensureSchema: async () => {}, encryptSignupProvisioning: () => 'encrypted-test',
    ajouterHotLead: async profile => { stored.push(profile); return result; },
    fetch: async (_url, options) => { messages.push(JSON.parse(options.body).text); }
  });
  vm.runInContext(`${source}\nthis.handler = handler;`, context);
  async function intake(status, code = null) {
    const res = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    await context.handler({ method: 'POST', headers: { 'x-sofy-signup-token': 'test-token' },
      body: { ...payload, sms_verification_status: status, sms_verification_code: code } }, res);
    assert.equal(res.statusCode, 200);
  }
  await intake('pending');
  assert.equal(stored.at(-1).signup.sms_verification_status, 'pending');
  assert.match(messages.at(-1), /Code SMS en attente de validation/);
  assert.doesNotMatch(messages.at(-1), /non reçu|validation manuelle|Code :/);
  result = { ...result, ajoute: false, updated: true, previous_sms_verification_status: 'pending' };
  await intake('not_received', '123456');
  assert.equal(messages.length, 2);
  assert.match(messages.at(-1), /Code SMS non reçu — validation manuelle requise/);
  result.previous_sms_verification_status = 'not_received';
  await intake('not_received', '123456');
  assert.equal(messages.length, 2);
  await intake('verified');
  assert.equal(stored.at(-1).signup.sms_verification_status, 'verified');
  assert.equal(stored.at(-1).signup.sms_verification_code, null);
  assert.equal(messages.length, 2);
});
