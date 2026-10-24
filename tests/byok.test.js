// src/shared/byok.js: key validation, masking, headers, storage choice, /api/check and relay answers. Keys are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_RE, MODELS, STORE_KEY, cleanKey, validKey, normalize, mask, headersFor, createByok, readCheck, relayPath, relayView,
  apiHeaders, TRIPO_KEY_RE, cleanTripoKey, validTripoKey, secureOrigin,
} from '../src/shared/byok.js';

test('secureOrigin: https or a loopback host, matched exactly', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.equal(secureOrigin({ protocol: 'http:', hostname: h }), true, h);
  for (const h of ['127x0x0x1', ':', '1', '10.0.0.5', 'localhost.evil.com']) assert.equal(secureOrigin({ protocol: 'http:', hostname: h }), false, h);
  assert.equal(secureOrigin({ protocol: 'https:', hostname: 'x.vercel.app' }), true);
});

const GEM = 'AIzaFAKEfakeFAKEfake_1234-X9q2';
const XI = 'sk_fake_0000000000000000000000';
// A dot early on keeps the pre-commit hook's tsk_ pattern from taking this fake for a real key.
const TRIPO = 'tsk_FAKE.visitor.key.0002';

function fakeStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

test('a key is 20 to 200 of letters, digits, _ . - after trim', () => {
  assert.equal(validKey('a'.repeat(20)), true);
  assert.equal(validKey('a'.repeat(19)), false);
  assert.equal(validKey('a'.repeat(200)), true);
  assert.equal(validKey('a'.repeat(201)), false);
  assert.equal(cleanKey(`  ${GEM}\n`), GEM);
  for (const bad of [`${GEM} x`, `${GEM}!`, `${GEM}é`, '', null, 42, {}]) assert.equal(validKey(bad), false, String(bad));
  assert.equal(KEY_RE.test('A.b_c-0123456789abcdefgh'), true);
});

test('normalize keeps valid keys, an allowed model and a strict remember', () => {
  assert.deepEqual(normalize(null), { gemini: '', geminiModel: '', elevenlabs: '', tripo: '', remember: false });
  assert.deepEqual(normalize({ gemini: ` ${GEM} `, geminiModel: MODELS[1], elevenlabs: XI, tripo: ` ${TRIPO}`, remember: true }),
    { gemini: GEM, geminiModel: 'gemini-3.8-flash', elevenlabs: XI, tripo: TRIPO, remember: true });
  assert.deepEqual(normalize({ gemini: 'short', geminiModel: 'gemini-pro', elevenlabs: 7, tripo: GEM, remember: 'yes' }),
    { gemini: '', geminiModel: '', elevenlabs: '', tripo: '', remember: false });
});

test('a Tripo key is tsk_ then 8 to 200 printable characters, no spaces', () => {
  assert.equal(validTripoKey(TRIPO), true);
  assert.equal(cleanTripoKey(` ${TRIPO}\n`), TRIPO);
  assert.equal(validTripoKey('tsk_' + 'a'.repeat(8)), true);
  assert.equal(validTripoKey('tsk_' + 'a'.repeat(7)), false);
  assert.equal(validTripoKey('tsk_' + 'a'.repeat(201)), false);
  assert.equal(TRIPO_KEY_RE.test('tsk_a+b/c=d~e'), true, 'lenient: the charset is unverified');
  for (const bad of [GEM, XI, `${TRIPO} x`, `${TRIPO}, ${TRIPO}`, `${TRIPO}é`, 'TSK_abcdefghij', '', null, 7]) assert.equal(validTripoKey(bad), false, String(bad));
  assert.equal(validKey(TRIPO), true, 'the other slots keep their own check');
});

test('mask shows the first and last four only', () => {
  assert.equal(mask(GEM), 'AIza…X9q2');
  assert.equal(mask(''), '');
  assert.equal(mask(null), '');
  assert.equal(mask('abcdefgh'), '…gh');
  assert.ok(!mask(XI).includes(XI.slice(4, -4)));
});

test('headers carry only the set fields', () => {
  assert.deepEqual(headersFor({}), {});
  assert.deepEqual(headersFor({ gemini: GEM }), { 'x-gemini-key': GEM });
  assert.deepEqual(headersFor({ gemini: GEM, geminiModel: MODELS[0], elevenlabs: XI }),
    { 'x-gemini-key': GEM, 'x-gemini-model': 'gemini-3.5-flash-lite', 'x-elevenlabs-key': XI });
  assert.deepEqual(headersFor({ gemini: 'bad key', geminiModel: 'other', elevenlabs: '' }), {});
  assert.deepEqual(headersFor({ tripo: TRIPO }), { 'x-tripo-key': TRIPO });
  assert.deepEqual(headersFor({ tripo: GEM }), {}, 'a Gemini key is not a Tripo key');
  assert.deepEqual(apiHeaders(), {}, 'node has no storage: the default instance sends nothing');
});

test('sessionStorage by default; remember moves the keys to localStorage and back', () => {
  const session = fakeStore(), local = fakeStore(), seen = [];
  const b = createByok({ session, local, notify: (k) => seen.push(k) });
  assert.deepEqual(b.load(), normalize(null));

  b.save({ gemini: GEM });
  assert.ok(session.m.has(STORE_KEY));
  assert.equal(local.m.has(STORE_KEY), false);
  assert.equal(b.load().gemini, GEM);

  b.save({ remember: true, elevenlabs: XI });
  assert.equal(session.m.has(STORE_KEY), false);
  assert.deepEqual(JSON.parse(local.m.get(STORE_KEY)), { gemini: GEM, geminiModel: '', elevenlabs: XI, tripo: '', remember: true });
  assert.deepEqual(b.apiHeaders(), { 'x-gemini-key': GEM, 'x-elevenlabs-key': XI });

  b.save({ remember: false });
  assert.equal(local.m.has(STORE_KEY), false);
  assert.equal(JSON.parse(session.m.get(STORE_KEY)).gemini, GEM);

  b.save({ gemini: '' });
  assert.deepEqual(b.apiHeaders(), { 'x-elevenlabs-key': XI });

  b.clear();
  assert.equal(session.m.size + local.m.size, 0);
  assert.deepEqual(b.load(), normalize(null));
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[4], normalize(null));
});

test('a junk or tampered store reads as no keys, and an invalid key is never stored', () => {
  const session = fakeStore(), local = fakeStore();
  const b = createByok({ session, local });
  session.setItem(STORE_KEY, '{not json');
  local.setItem(STORE_KEY, JSON.stringify({ gemini: 'x\r\nInjected: 1', elevenlabs: XI }));
  assert.deepEqual(b.load(), { gemini: '', geminiModel: '', elevenlabs: XI, tripo: '', remember: false });
  b.save({ gemini: 'not a key' });
  assert.equal(JSON.parse(session.m.get(STORE_KEY)).gemini, '');
});

test('blocked storage never throws: remember falls back to the session', () => {
  const session = fakeStore();
  const b = createByok({ session, local: () => { throw new Error('SecurityError'); }, notify: () => { throw new Error('listener'); } });
  assert.equal(b.save({ gemini: GEM, remember: true }).gemini, GEM);
  assert.equal(b.load().gemini, GEM);
  const none = createByok({ session: broken, local: broken });
  assert.doesNotThrow(() => { none.save({ gemini: GEM }); none.clear(); });
  assert.deepEqual(none.load(), normalize(null));
  assert.deepEqual(createByok().apiHeaders(), {});
});

test('readCheck: the answer, a missing API, an unreachable one, and the rate limit', () => {
  assert.deepEqual(readCheck(200, { ok: true, using: 'yours', detail: ' Key works,\n 12 models ', credits: 9412 }),
    { ok: true, using: 'yours', detail: 'Key works, 12 models', credits: 9412 });
  assert.deepEqual(readCheck(200, { ok: false, using: 'other', credits: 'lots' }), { ok: false, using: '', detail: 'Failed', credits: null });
  assert.equal(readCheck(200, { ok: true }).detail, 'Working');
  assert.deepEqual(readCheck(429, { ok: false, detail: 'Too many checks; wait a minute' }),
    { ok: false, using: '', detail: 'Too many checks; wait a minute', credits: null });
  assert.match(readCheck(404, null).detail, /No API here/);
  assert.match(readCheck(0, null).detail, /No answer/);
  assert.equal(readCheck(200, { ok: true, detail: 'x'.repeat(500) }).detail.length, 160);
});

test('relay health: path by protocol, rows from either answer', () => {
  assert.equal(relayPath('https:'), '/api/ws');
  assert.equal(relayPath('http:'), '/healthz');
  assert.deepEqual(relayView(200, { ok: true, instance: 'abcdef123456', host: true, sockets: 3, region: 'iad1', bus: 'redis' }, '/api/ws'), {
    ok: true, detail: 'Answering', rows: [['region', 'iad1'], ['instance', 'abcdef12'], ['bus', 'Upstash Redis'], ['sockets', '3']],
  });
  assert.deepEqual(relayView(200, { ok: true, instance: 'abc', region: 'local', uptime: 5 }, '/healthz').rows, [['region', 'local'], ['instance', 'abc']]);
  assert.equal(relayView(200, { ok: true, bus: 'local' }, '/api/ws').rows[0][1], 'local, no redis');
  assert.deepEqual(relayView(404, null, '/healthz'), { ok: false, detail: 'No relay health at /healthz', rows: [] });
  assert.equal(relayView(0, null, '/api/ws').detail, 'No answer from the relay');
});
