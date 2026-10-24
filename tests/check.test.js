// node:test suite for api/check.js with a fake fetch and a fake Snowflake module; no network. Keys are obvious fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MAX_PER_MINUTE, MINUTE_MS } from '../api/check.js';

const YOURS = 'FAKE_visitor_key_0123456789';
const TEAM = 'FAKE_team_key_0123456789abc';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
const SUB_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const MODELS_URL = 'https://api.elevenlabs.io/v1/models';
const TRIPO_URL = 'https://openapi.tripo3d.ai/v3/account/balance';
// A dot early on keeps the pre-commit hook's tsk_ pattern from taking these fakes for real keys.
const TRIPO_YOURS = 'tsk_FAKE.visitor.key.0002', TRIPO_TEAM = 'tsk_FAKE.team.key.0001';
const never = () => new Promise(() => {});

// Answers by URL: {status, json}, 'hang' or 'throw'; records every call.
function fakeFetch(routes = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, signal: opts.signal });
    const r = routes[url] ?? { status: 200, json: {} };
    if (r === 'hang') return never();
    if (r === 'throw') throw new Error(`socket closed while sending ${JSON.stringify(opts.headers)}`);
    return { status: r.status, json: async () => r.json ?? null };
  };
  return { fetch, calls };
}

function fakeRes() {
  return {
    statusCode: 200, headers: {}, text: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.text = s || ''; },
  };
}

// A fake @vercel/blob whose head() answers like a working store asked for a path nobody wrote.
class FakeNotFound extends Error {}
const workingBlob = async () => ({ BlobNotFoundError: FakeNotFound, head: async () => { throw new FakeNotFound('not found'); } });

function make({ env = {}, routes, snowflake, blob = workingBlob, now, timeoutMs = 40 } = {}) {
  const f = fakeFetch(routes);
  const handler = createHandler({ env, fetch: f.fetch, now, timeoutMs, blob, snowflake: snowflake || (async () => ({ configured: () => false })) });
  const seen = [];
  const ask = async (service, { headers = {}, ip = '10.0.0.1', method = 'POST', body } = {}) => {
    const res = fakeRes();
    await handler({ method, headers: { 'x-forwarded-for': ip, ...headers }, body: body ?? { service } }, res);
    seen.push(res.text);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    return { status: res.statusCode, body: JSON.parse(res.text), headers: res.headers };
  };
  return { ask, calls: f.calls, seen };
}

test('check: anything but POST is 405 with Allow, an unknown service or bad body is 400; no upstream call', async () => {
  const { ask, calls } = make();
  const r = await ask('gemini', { method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
  assert.equal(r.body.ok, false);
  for (const body of [{ service: 'gpt' }, {}, { service: ['gemini'] }, 'nope', '{bad']) {
    const b = await ask(null, { body, ip: '10.0.0.2' });
    assert.equal(b.status, 400, JSON.stringify(body));
    assert.deepEqual(b.body, { ok: false, using: 'none', detail: 'Unknown service' });
  }
  assert.equal(calls.length, 0);
});

test('check gemini: your key, else the team key, else none; it lists models with x-goog-api-key', async () => {
  const { ask, calls } = make({ env: { GEMINI_API_KEY: TEAM } });
  let r = await ask('gemini', { headers: { 'x-gemini-key': `  ${YOURS} ` } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, using: 'yours', detail: 'Gemini accepted the key' }]);
  assert.equal(calls[0].url, GEMINI_URL);
  assert.deepEqual(calls[0].headers, { 'x-goog-api-key': YOURS });
  assert.ok(calls[0].signal instanceof AbortSignal);
  r = await ask('gemini');
  assert.deepEqual(r.body, { ok: true, using: 'team', detail: 'Gemini accepted the key' });
  assert.deepEqual(calls[1].headers, { 'x-goog-api-key': TEAM });

  const none = make();
  r = await none.ask('gemini');
  assert.deepEqual(r.body.using, 'none');
  assert.equal(r.body.ok, false);
  assert.match(r.body.detail, /paste your own/);
  r = await none.ask('gemini', { headers: { 'x-gemini-key': 'short' } });
  assert.deepEqual([r.status, r.body.ok, r.body.using], [200, false, 'yours']);
  r = await none.ask('gemini', { headers: { 'x-gemini-key': `${YOURS}!` } });
  assert.equal(r.body.using, 'yours', 'a bad character makes it malformed, not the team key');
  assert.equal(none.calls.length, 0, 'no key or a malformed one never reaches Google');
});

test('check gemini: refusals, quota, other statuses, a timeout and a network error are short, safe details', async () => {
  const cases = [
    [{ status: 400 }, /^Gemini refused the key$/], [{ status: 403 }, /refused/], [{ status: 429 }, /over its limit/],
    [{ status: 503 }, /^Gemini answered HTTP 503$/], ['hang', /^Gemini did not answer in \d+ s$/], ['throw', /^Could not reach Gemini$/],
  ];
  for (const [route, want] of cases) {
    const { ask } = make({ routes: { [GEMINI_URL]: route } });
    const t = Date.now();
    const r = await ask('gemini', { headers: { 'x-gemini-key': YOURS } });
    assert.deepEqual([r.status, r.body.ok, r.body.using], [200, false, 'yours']);
    assert.match(r.body.detail, want);
    assert.ok(Date.now() - t < 1000);
  }
});

test('check elevenlabs: credits left from the subscription, or null when it has no counts', async () => {
  const { ask, calls } = make({ routes: { [SUB_URL]: { status: 200, json: { character_limit: 10000, character_count: 2500 } } } });
  const r = await ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.deepEqual(r.body, { ok: true, using: 'yours', credits: 7500, detail: 'ElevenLabs accepted the key; 7500 credits left' });
  assert.deepEqual(calls.map((c) => [c.url, c.headers]), [[SUB_URL, { 'xi-api-key': YOURS }]]);
  const bare = make({ routes: { [SUB_URL]: { status: 200, json: { tier: 'free' } } } });
  assert.equal((await bare.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } })).body.credits, null);
});

test('check elevenlabs: a 401 on the subscription falls back to the models list', async () => {
  const scoped = make({ routes: { [SUB_URL]: { status: 401 }, [MODELS_URL]: { status: 200, json: [] } } });
  let r = await scoped.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.deepEqual([r.body.ok, r.body.using, r.body.credits], [true, 'yours', null]);
  assert.deepEqual(scoped.calls.map((c) => c.url), [SUB_URL, MODELS_URL]);
  assert.deepEqual(scoped.calls[1].headers, { 'xi-api-key': YOURS });
  const bad = make({ routes: { [SUB_URL]: { status: 401 }, [MODELS_URL]: { status: 401 } } });
  r = await bad.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.deepEqual(r.body, { ok: false, using: 'yours', credits: null, detail: 'ElevenLabs refused the key' });
  // ElevenLabs's own reason token comes through (never its message), from whichever refusal carries one.
  const why = (status) => ({ status: 401, json: { detail: { status, message: 'long text with the key sk_abc…' } } });
  r = await make({ routes: { [SUB_URL]: why('missing_permissions'), [MODELS_URL]: { status: 401 } } }).ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.equal(r.body.detail, 'ElevenLabs refused the key (401 missing_permissions)');
  r = await make({ routes: { [SUB_URL]: { status: 401 }, [MODELS_URL]: why('detected_unusual_activity') } }).ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.equal(r.body.detail, 'ElevenLabs refused the key (401 detected_unusual_activity)');
  r = await make({ routes: { [SUB_URL]: why('Not A Token!'), [MODELS_URL]: { status: 401 } } }).ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.equal(r.body.detail, 'ElevenLabs refused the key');
  const down = make({ routes: { [SUB_URL]: { status: 500 } } });
  r = await down.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } });
  assert.deepEqual([r.body.ok, r.body.detail], [false, 'ElevenLabs answered HTTP 500']);
  assert.equal(down.calls.length, 1, 'only a 401 tries the models list');
  const hung = make({ routes: { [SUB_URL]: 'hang' } });
  assert.match((await hung.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } })).body.detail, /did not answer/);
});

test('check elevenlabs: the team key, with a note when SOUND_GEN is off; none without one', async () => {
  const routes = { [SUB_URL]: { status: 200, json: { character_limit: 100, character_count: 40 } } };
  const off = make({ env: { ELEVENLABS_API_KEY: TEAM }, routes });
  let r = await off.ask('elevenlabs');
  assert.deepEqual([r.body.ok, r.body.using, r.body.credits], [true, 'team', 60]);
  assert.match(r.body.detail, /sound generation is off/);
  assert.deepEqual(off.calls[0].headers, { 'xi-api-key': TEAM });
  const on = make({ env: { ELEVENLABS_API_KEY: TEAM, SOUND_GEN: 'on' }, routes });
  assert.doesNotMatch((await on.ask('elevenlabs')).body.detail, /off/);
  const mine = make({ env: { ELEVENLABS_API_KEY: TEAM }, routes });
  assert.doesNotMatch((await mine.ask('elevenlabs', { headers: { 'x-elevenlabs-key': YOURS } })).body.detail, /off/, 'your key works with SOUND_GEN off');
  const none = make();
  r = await none.ask('elevenlabs');
  assert.deepEqual([r.body.ok, r.body.using], [false, 'none']);
  r = await none.ask('elevenlabs', { headers: { 'x-elevenlabs-key': 'has spaces in it but is long' } });
  assert.deepEqual([r.body.ok, r.body.using], [false, 'yours']);
  assert.equal(none.calls.length, 0);
});

test('check tripo: your key, else the team key, else none; the balance is the credits, as a float', async () => {
  const balance = (data) => ({ [TRIPO_URL]: { status: 200, json: { code: 0, data } } });
  const { ask, calls } = make({ env: { TRIPO_API_KEY: TRIPO_TEAM }, routes: balance({ balance: 1234.5, frozen: 30 }) });
  let r = await ask('tripo', { headers: { 'x-tripo-key': ` ${TRIPO_YOURS} ` } });
  assert.deepEqual(r.body, { ok: true, using: 'yours', credits: 1234.5, detail: 'Tripo accepted the key; 1234.5 credits left' });
  assert.deepEqual(calls.map((c) => [c.url, c.headers]), [[TRIPO_URL, { Authorization: `Bearer ${TRIPO_YOURS}` }]]);
  r = await ask('tripo');
  assert.deepEqual([r.body.ok, r.body.using, r.body.credits], [true, 'team', 1234.5]);
  assert.deepEqual(calls[1].headers, { Authorization: `Bearer ${TRIPO_TEAM}` });
  const mine = { headers: { 'x-tripo-key': TRIPO_YOURS } };
  assert.equal((await make({ routes: balance({ balance: '88.25' }) }).ask('tripo', mine)).body.credits, 88.25);
  assert.deepEqual((await make({ routes: balance({}) }).ask('tripo', mine)).body, { ok: true, using: 'yours', credits: null, detail: 'Tripo accepted the key' });

  const none = make();
  r = await none.ask('tripo');
  assert.deepEqual([r.body.ok, r.body.using], [false, 'none']);
  assert.match(r.body.detail, /No Tripo key on this server/);
  r = await none.ask('tripo', { headers: { 'x-tripo-key': YOURS } });
  assert.deepEqual(r.body, { ok: false, using: 'yours', detail: 'That does not look like a Tripo key' }, 'a key without tsk_ is malformed');
  assert.equal(none.calls.length, 0);
});

test('check tripo: refusals, an error code, other statuses and no answer are short, safe details', async () => {
  const echo = { code: 1002, message: `bad key ${TRIPO_YOURS} ${TRIPO_TEAM}` };
  const cases = [
    [{ status: 401, json: echo }, /^Tripo refused the key$/], [{ status: 403, json: { code: 2010 } }, /refused/],
    [{ status: 200, json: echo }, /^Tripo answered with an error$/], [{ status: 200, json: null }, /answered with an error/],
    [{ status: 429 }, /over its limit/], [{ status: 500 }, /^Tripo answered HTTP 500$/],
    ['hang', /^Tripo did not answer in \d+ s$/], ['throw', /^Could not reach Tripo$/],
  ];
  for (const [route, want] of cases) {
    const { ask, seen } = make({ env: { TRIPO_API_KEY: TRIPO_TEAM }, routes: { [TRIPO_URL]: route } });
    for (const headers of [{ 'x-tripo-key': TRIPO_YOURS }, {}]) {
      const r = await ask('tripo', { headers });
      assert.deepEqual([r.status, r.body.ok, r.body.credits], [200, false, null]);
      assert.match(r.body.detail, want);
    }
    for (const s of seen) assert.ok(!s.includes(TRIPO_YOURS) && !s.includes(TRIPO_TEAM), s);
  }
});

test('check snowflake: team only, configured() then one listProjectsResult row', async () => {
  const asked = [];
  const sf = (result) => async () => ({ configured: (env) => env.SNOWFLAKE_ACCOUNT === 'acct', listProjectsResult: (n, opts) => { asked.push([n, opts.env.SNOWFLAKE_ACCOUNT]); return result(); } });
  const env = { SNOWFLAKE_ACCOUNT: 'acct' };
  let r = await make({ env, snowflake: sf(async () => ({ ok: true, rows: [] })) }).ask('snowflake', { headers: { 'x-gemini-key': YOURS } });
  assert.deepEqual(r.body, { ok: true, using: 'team', detail: 'Snowflake answered' });
  assert.deepEqual(asked, [[1, 'acct']]);
  r = await make({ env, snowflake: sf(async () => ({ ok: false, rows: [] })) }).ask('snowflake');
  assert.deepEqual(r.body, { ok: false, using: 'team', detail: 'Snowflake did not answer' });
  r = await make({ env, snowflake: sf(async () => { throw new Error('boom'); }) }).ask('snowflake');
  assert.deepEqual([r.body.ok, r.body.using], [false, 'team']);
  const t = Date.now();
  r = await make({ env, snowflake: sf(never) }).ask('snowflake');
  assert.deepEqual([r.body.ok, r.body.using], [false, 'team']);
  assert.match(r.body.detail, /did not answer in/);
  assert.ok(Date.now() - t < 1000);
  r = await make({ env: {}, snowflake: sf(async () => ({ ok: true })) }).ask('snowflake');
  assert.deepEqual([r.body.ok, r.body.using], [false, 'none']);
  r = await make({ env, snowflake: async () => { throw new Error('module broke'); } }).ask('snowflake');
  assert.deepEqual([r.status, r.body.ok, r.body.using], [200, false, 'none']);
});

test('check snowflake: a PAT-only env (no user, no key) passes the real configured() and lists over the PAT', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const real = await import('../lib/snowflake.js');
  const PAT = 'FAKE.pat.secret.0123456789abcdef';
  const env = { SNOWFLAKE_ACCOUNT: 'myorg-myacct', SNOWFLAKE_WAREHOUSE: 'lb_wh', SNOWFLAKE_DATABASE: 'lb_db', SNOWFLAKE_SCHEMA: 'app', SNOWFLAKE_PAT: PAT };
  const sent = [];
  // The real module, its fetch swapped for one that answers status/json.
  const over = (status, json) => async () => ({
    ...real,
    listProjectsResult: (n, opts) => real.listProjectsResult(n, { ...opts, fetch: async (url, init) => { sent.push([url, init.headers]); return { status, json: async () => json }; } }),
  });
  let r = await make({ env, snowflake: over(200, { resultSetMetaData: { rowType: [] }, data: [] }) }).ask('snowflake');
  assert.deepEqual(r.body, { ok: true, using: 'team', detail: 'Snowflake answered' });
  assert.equal(sent[0][0], 'https://myorg-myacct.snowflakecomputing.com/api/v2/statements');
  assert.equal(sent[0][1].Authorization, `Bearer ${PAT}`);
  assert.equal(sent[0][1]['X-Snowflake-Authorization-Token-Type'], 'PROGRAMMATIC_ACCESS_TOKEN');
  const { ask, seen } = make({ env, snowflake: over(401, { code: '390303', message: `Invalid token ${PAT}` }) });
  r = await ask('snowflake');
  assert.deepEqual(r.body, { ok: false, using: 'team', detail: 'Snowflake did not answer' });
  assert.equal(warn.mock.calls.length, 1);
  for (const s of [...seen, ...warn.mock.calls.map((c) => c.arguments.join(' '))]) assert.ok(!s.includes(PAT.slice(0, 8)), s);
});

test('check storage: a token or a store id, then a lookup the store must answer (not found is fine)', async () => {
  const connected = { ok: true, using: 'team', detail: 'Blob storage is connected' };
  assert.deepEqual((await make({ env: { BLOB_READ_WRITE_TOKEN: 'fake-blob-token' } }).ask('storage')).body, connected);
  assert.deepEqual((await make({ env: { BLOB_READ_WRITE_TOKEN: '  ' } }).ask('storage')).body, { ok: false, using: 'none', detail: 'No Blob store connected' });
  assert.deepEqual((await make({ env: { BLOB_STORE_ID: 'store_fake123' } }).ask('storage')).body, connected);
  const env = { BLOB_STORE_ID: 'store_fake123' };
  const refused = { ok: false, using: 'team', detail: 'Blob storage refused the check' };
  assert.deepEqual((await make({ env, blob: async () => ({ BlobNotFoundError: FakeNotFound, head: async () => { throw new Error('no credentials'); } }) }).ask('storage')).body, refused);
  assert.deepEqual((await make({ env, blob: async () => { throw new Error('module failed'); } }).ask('storage')).body, refused);
  assert.deepEqual((await make({ env, blob: async () => ({ BlobNotFoundError: FakeNotFound, head: () => new Promise(() => {}) }) }).ask('storage')).body,
    { ok: false, using: 'team', detail: 'Blob storage did not answer in 1 s' });
});

test('check: 10 checks a minute per client, then 429; other clients and the next minute are fine', async () => {
  const clock = { t: 1_000_000 };
  const { ask } = make({ env: { BLOB_READ_WRITE_TOKEN: 'x' }, now: () => clock.t });
  for (let i = 0; i < MAX_PER_MINUTE; i++) assert.equal((await ask('storage')).status, 200, `check ${i}`);
  const r = await ask('storage');
  assert.deepEqual([r.status, r.body], [429, { ok: false, detail: 'Too many checks; wait a minute' }]);
  assert.equal((await ask('storage', { ip: '10.9.9.9' })).status, 200);
  clock.t += MINUTE_MS;
  assert.equal((await ask('storage')).status, 200);
  const bad = await ask(null, { body: { service: 'nope' }, ip: '10.9.9.9' });
  assert.equal(bad.status, 400, 'bad requests count too, but still answer their own error under the limit');
});

test('check: no reply and no console line ever carries a key, even when upstream errors quote it', async (t) => {
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) t.mock.method(console, m, (...a) => lines.push(a.map(String).join(' ')));
  const env = { GEMINI_API_KEY: TEAM, ELEVENLABS_API_KEY: TEAM, BLOB_READ_WRITE_TOKEN: 'x', SNOWFLAKE_ACCOUNT: 'acct' };
  const echo = { status: 401, json: { detail: { message: `bad key ${YOURS} ${TEAM}` } } };
  for (const routes of [{}, { [GEMINI_URL]: echo, [SUB_URL]: echo, [MODELS_URL]: echo }, { [GEMINI_URL]: 'throw', [SUB_URL]: 'throw' }, { [GEMINI_URL]: 'hang', [SUB_URL]: 'hang' }]) {
    const { ask, seen } = make({ env, routes, snowflake: async () => ({ configured: () => true, listProjectsResult: async () => ({ ok: false }) }) });
    for (const service of ['gemini', 'elevenlabs', 'snowflake', 'storage']) {
      await ask(service, { headers: { 'x-gemini-key': YOURS, 'x-elevenlabs-key': YOURS } });
      await ask(service);
    }
    for (const s of seen) assert.ok(!s.includes(YOURS) && !s.includes(TEAM), s);
  }
  assert.ok(lines.every((l) => !l.includes(YOURS) && !l.includes(TEAM)), lines.join('\n'));
});

test('check: team answers only to the TV (x-host-token) when HOST_TOKEN is set; a visitor key works for anyone', async () => {
  const env = { HOST_TOKEN: 'tvtoken123', GEMINI_API_KEY: 'AIzaTEAMTEAMTEAMTEAMTEAM0000', TRIPO_API_KEY: TRIPO_TEAM, BLOB_READ_WRITE_TOKEN: 'x' };
  const { ask } = make({ env, routes: { [GEMINI_URL]: { status: 200, json: {} } } });
  const tvOnly = { ok: false, using: 'none', detail: 'Team checks run from the TV only' };
  assert.deepEqual((await ask('gemini')).body, tvOnly);
  assert.deepEqual((await ask('storage')).body, tvOnly);
  assert.deepEqual((await ask('tripo')).body, tvOnly);
  assert.deepEqual((await ask('snowflake', { headers: { 'x-host-token': 'wrong' } })).body, tvOnly);
  assert.equal((await ask('gemini', { headers: { 'x-host-token': 'tvtoken123' } })).body.using, 'team');
  assert.equal((await ask('storage', { headers: { 'x-host-token': 'tvtoken123' } })).body.ok, true);
  const mine = (await ask('gemini', { headers: { 'x-gemini-key': YOURS } })).body;
  assert.deepEqual([mine.ok, mine.using], [true, 'yours']);
  assert.deepEqual((await ask('tripo', { headers: { 'x-tripo-key': TRIPO_YOURS } })).body.using, 'yours');
  assert.equal((await ask('tripo', { headers: { 'x-host-token': 'tvtoken123' } })).body.using, 'team');
});
