// node --experimental-vm-modules --test tests/rcs-prospect.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext, runInNewContext } from 'node:vm';
import { createHmac, createHash } from 'node:crypto';
import { analyserStatutMessage } from '../api/message-status.js';

test('les statuts de remise et les échecs sont distincts', () => {
  for (const status of ['errored', 'error', 'rejected', 'failed', 'undelivered', 'expired', 'delivery_failed']) {
    const suivi = analyserStatutMessage({ status, error: { message: 'Motif opérateur' } });
    assert.equal(suivi.rejete, true, status);
    assert.equal(suivi.remis, false, status);
    assert.equal(suivi.detail, 'Motif opérateur');
  }
  for (const status of ['delivered', 'read']) assert.equal(analyserStatutMessage({ status }).remis, true);
  for (const status of ['pending', 'queued', 'sent', 'unknown', undefined]) {
    const suivi = analyserStatutMessage({ status });
    assert.equal(suivi.remis, false);
    assert.equal(suivi.rejete, false);
  }
});

async function chargerHandler(reponseRcs, smsOk = true) {
  const appels = { fetch: [], sms: [], conso: [] };
  const contexte = createContext({ URL, console, process: { env: {
    SOFY_API_KEY_V2: 'test-key', SOFY_RCS_SENDER_ID: 'test-sender'
  } }, fetch: async (url, options) => {
    appels.fetch.push({ url, options });
    return { ok: true, status: 201, json: async () => reponseRcs };
  } });
  const db = {
    verifierToken: () => ({ nom: 'Camille', role: 'sdr' }),
    ensureSchema: async () => {},
    sql: async (texte) => texte.join('').includes('SELECT jeton') ? [{ client: 'Pokeshop Paris' }] : [],
    envoyerSmsSofy: async (params) => {
      appels.sms.push(params);
      return smsOk ? { ok: true, id: 'sms-1', via: 'v2', statut: 'pending' }
        : { ok: false, detail: 'SMS refusé' };
    },
    loggerConso: async (...params) => appels.conso.push(params)
  };
  const modules = new Map();
  async function charger(nom) {
    if (modules.has(nom)) return modules.get(nom);
    const module = nom === 'db.js'
      ? new SyntheticModule(Object.keys(db), function () {
        for (const [k, v] of Object.entries(db)) this.setExport(k, v);
      }, { context: contexte })
      : new SourceTextModule(await readFile(new URL('../api/' + nom, import.meta.url), 'utf8'), { context: contexte });
    modules.set(nom, module);
    await module.link(spec => charger(spec.replace('./', '')));
    return module;
  }
  const module = await charger('rcs-prospect.js');
  await module.evaluate();
  return { appels, requete: async (method, params) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.namespace.default({ method, query: method === 'GET' ? params : {}, body: params }, res);
    return res;
  } };
}

const envoi = { mode: 'prez', jeton: 'analyse-test', tel: '+33600000000', d: 0 };

test('le suivi classe errored en échec et conserve le motif du fournisseur', async () => {
  const { requete, appels } = await chargerHandler({ id: 'rcs-1', status: 'errored', errorMessage: 'Agent indisponible' });
  const res = await requete('GET', { statut: 'rcs-1' });
  assert.equal(res.body.rejete, true);
  assert.equal(res.body.remis, false);
  assert.equal(res.body.detail, 'Agent indisponible');
  assert.equal(appels.sms.length, 0); // Une vérification ne doit jamais renvoyer de message.
});

test('un RCS en erreur malgré HTTP 201 déclenche un seul SMS avec le lien nominatif', async () => {
  const { requete, appels } = await chargerHandler({ id: 'rcs-1', status: 'errored', error: 'Agent indisponible' });
  const res = await requete('POST', envoi);
  assert.equal(res.body.ok, true);
  assert.match(res.body.canal, /sms/);
  assert.match(res.body.rcs_echec, /errored.*Agent indisponible/);
  assert.equal(appels.sms.length, 1);
  assert.match(appels.sms[0].message, /\/p\/analyse-test\?d=0/);
});

test('un RCS accepté en attente ne déclenche aucun SMS supplémentaire', async () => {
  const { requete, appels } = await chargerHandler({ id: 'rcs-1', status: 'pending' });
  const res = await requete('POST', envoi);
  assert.equal(res.body.canal, 'rcs');
  assert.equal(res.body.statut_api, 'pending');
  assert.equal(appels.sms.length, 0);
});

test('si RCS et SMS échouent, aucune réussite ni consommation RCS n’est enregistrée', async () => {
  const { requete, appels } = await chargerHandler({ id: 'rcs-1', status: 'errored' }, false);
  const res = await requete('POST', envoi);
  assert.equal(res.code, 502);
  assert.match(res.body.detail, /errored.*SMS refusé/);
  assert.equal(appels.conso.length, 0);
});

test('l’aperçu GET utilise le repli réellement envoyé et affiche sa limite', async () => {
  const { requete, appels } = await chargerHandler({ id: 'rcs-1', status: 'pending' });
  const apercu = await requete('GET', envoi);
  assert.equal(appels.fetch.length, 0);
  await requete('POST', envoi);
  const corps = JSON.parse(appels.fetch[0].options.body);
  assert.equal(apercu.body.repli_sms, corps.fallback.text);
  assert.equal(apercu.body.repli_longueur, corps.fallback.text.length);
  assert.ok(apercu.body.repli_longueur <= apercu.body.repli_max);
  assert.equal(apercu.body.rcs_configure, true);
});

test('le SMS partagé traite aussi une réponse HTTP 201 en erreur comme un échec', async () => {
  const appels = [];
  const contexte = createContext({ console, process: { env: {
    SOFY_API_KEY_V2: 'test-key', SOFY_API_KEY_ID: 'test-id', SOFY_API_KEY_SECRET: 'test-secret'
  } }, fetch: async (url) => {
    appels.push(url);
    return { ok: true, status: 201, json: async () => ({ id: 'sms-1', status: 'errored' }) };
  } });
  const module = new SourceTextModule(await readFile(new URL('../api/db.js', import.meta.url), 'utf8'), { context: contexte });
  await module.link(async spec => {
    if (spec === './message-status.js') {
      const suivi = new SourceTextModule(await readFile(new URL('../api/message-status.js', import.meta.url), 'utf8'), { context: contexte });
      await suivi.link(() => {});
      return suivi;
    }
    const valeurs = spec === 'crypto' ? { createHmac, createHash } : { neon: () => async () => [] };
    return new SyntheticModule(Object.keys(valeurs), function () {
      for (const [k, v] of Object.entries(valeurs)) this.setExport(k, v);
    }, { context: contexte });
  });
  await module.evaluate();
  const resultat = await module.namespace.envoyerSmsSofy({ to: '+33600000000', message: 'Test' });
  assert.equal(resultat.ok, false);
  assert.match(resultat.detail, /errored/);
  assert.deepEqual(appels, ['https://api.sofy.fr/v2/sms', 'https://api.sofy.fr/v1/sms']);
});

test('le suivi à l’écran montre l’échec puis actualise la même ligne à la revérification', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('async function verifierAcheminement('), html.indexOf('\nfunction marquerEnvoye('));
  const lignes = new Set();
  const btn = { parentNode: { style: {}, appendChild: ligne => lignes.add(ligne) } };
  let statut = { statut: 'errored', rejete: true, detail: 'Agent indisponible' };
  const verifier = runInNewContext(source + '\nverifierAcheminement', {
    document: { createElement: () => ({ style: {} }) },
    api: async () => ({ json: async () => statut }), toast: assert.fail
  });
  await verifier('rcs-1', btn);
  assert.match(btn._suiviAcheminement.textContent, /échec.*errored.*Agent indisponible/);
  assert.equal(btn.parentNode.style.color, '#B91C1C');
  statut = { statut: 'delivered', remis: true };
  await verifier('rcs-1', btn);
  assert.match(btn._suiviAcheminement.textContent, /✅ remis/);
  assert.equal(lignes.size, 1);
  assert.equal(btn.disabled, false);
});
