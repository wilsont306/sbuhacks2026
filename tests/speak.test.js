// Tests for api/speak.js with a fake ElevenLabs client and fake Blob functions; no network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { BlobNotFoundError } from '@vercel/blob';
import { createHandler, parseText, maxPerHour, speechPath, VOICE_ID, MODEL_ID, MAX_PER_HOUR } from '../api/speak.js';
import { HOUR_MS } from '../api/sfx.js';

const TEAM = 'fake-team-key-for-tests-0001', VISITOR = 'fake-visitor-key-for-tests-0002';
const ENV = { ELEVENLABS_API_KEY: TEAM };
const TEXT = 'A small red train puffs past the hill.';
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const pathFor = (text, model = MODEL_ID, voice = VOICE_ID) => `speech/${sha1(`${model}|${voice}|${text}`)}.mp3`;
const audioStream = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); } });

function fakeBlob(opts = {}) {
  const store = new Map(), puts = [];
  return {
    store, puts,
    head: async (p) => { if (opts.headError) throw opts.headError; if (!store.has(p)) throw new BlobNotFoundError(); return { url: store.get(p).url }; },
    put: async (p, body, o) => { if (opts.putError) throw opts.putError; puts.push({ p, body, o }); const url = `https://blob.test/${p}`; store.set(p, { url, body }); return { url, pathname: p }; },
  };
}

// makeClient records which key each client got; every client shares one call log.
function fakeElevenLabs(impl, voices = [{ voiceId: 'acct-voice-1' }]) {
  const calls = [], keys = [], listed = [];
  const makeClient = (apiKey) => { keys.push(apiKey); return {
    textToSpeech: { convert: (voice, req, ro) => { calls.push({ voice, req, ro, apiKey }); return impl ? impl(voice, req, ro) : Promise.resolve(audioStream([1, 2, 3], [4, 5])); } },
    voices: { getAll: async () => { listed.push(apiKey); return { voices }; } },
  }; };
  return { calls, keys, listed, makeClient };
}

async function call(handler, { method = 'POST', body, parsed, headers = {} } = {}) {
  let read = false;
  const req = Readable.from((function* () { read = true; if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); })());
  req.method = method;
  req.headers = headers;
  if (parsed !== undefined) req.body = parsed;
  const out = { headers: {} };
  let text = '';
  const res = { statusCode: 200, headersSent: false, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: (s) => { if (s) text += s; res.headersSent = true; } };
  await handler(req, res);
  return { status: res.statusCode, headers: out.headers, json: text ? JSON.parse(text) : undefined, raw: text, read };
}

function make(over = {}) {
  const blob = over.blob || fakeBlob(), el = over.el || fakeElevenLabs();
  const handler = createHandler({ env: over.env || ENV, makeClient: el.makeClient, head: blob.head, put: blob.put, timeoutMs: over.timeoutMs || 2000, now: over.now });
  return { handler, blob, el };
}

test('non-POST is 405 with an Allow header', async () => {
  const { handler, el } = make();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await call(handler, { method, body: { text: TEXT } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'POST');
    assert.equal(r.json.url, null);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal(el.calls.length, 0);
});

test('with HOST_TOKEN set, a missing or wrong x-host-token is 401 before the body is read', async () => {
  const { handler, el, blob } = make({ env: { ...ENV, HOST_TOKEN: 's3cret' } });
  for (const headers of [{}, { 'x-host-token': '' }, { 'x-host-token': 'S3CRET' }, { 'x-host-token': 's3cret!' }, { 'x-host-token': ['s3cret'] }]) {
    const r = await call(handler, { headers, body: '{nope' });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.json.url, null);
    assert.equal(r.json.error, 'host token');
    assert.equal(r.read, false, 'the body is never read');
  }
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 401, 'no headers object is denied, not a crash');
  const ok = await call(handler, { headers: { 'x-host-token': 's3cret' }, body: { text: TEXT } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.url, `https://blob.test/${pathFor(TEXT)}`);
  assert.equal(el.calls.length, 1);
  assert.equal(blob.puts.length, 1);
});

test('bad bodies and a malformed visitor key are 400 and never reach ElevenLabs', async () => {
  const { handler, el } = make();
  for (const body of ['{nope', '[]', '', {}, { text: 3 }, { text: ['a'] }, { text: '   \n\t ' }, { text: 'x'.repeat(301) }, { other: TEXT }]) {
    const r = await call(handler, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.url, null);
  }
  const big = await call(handler, { body: JSON.stringify({ text: 'a' }) + ' '.repeat(5000) });
  assert.equal(big.status, 400, 'a streamed body over 4 KB');
  const badKey = await call(handler, { headers: { 'x-elevenlabs-key': 'short' }, body: { text: TEXT } });
  assert.deepEqual([badKey.status, badKey.json.error], [400, 'bad key']);
  assert.equal(el.calls.length, 0);
});

test('parseText collapses whitespace and allows 1 to 300 characters', () => {
  assert.equal(parseText({ text: '  a \n\n b\tc  ' }), 'a b c');
  assert.equal(parseText({ text: 'x' }), 'x');
  assert.equal(parseText({ text: ` ${'y'.repeat(300)}  ` }), 'y'.repeat(300));
  assert.equal(parseText({ text: 'y'.repeat(301) }), null);
  assert.equal(parseText(null), null);
  assert.equal(parseText('text'), null);
});

test('no team key and no visitor key answers 200 off, with no Blob or ElevenLabs call', async () => {
  let heads = 0;
  const blob = fakeBlob();
  const counted = { ...blob, head: (...a) => { heads++; return blob.head(...a); } };
  for (const env of [{}, { ELEVENLABS_API_KEY: '' }]) {
    const { handler, el } = make({ env, blob: counted });
    const r = await call(handler, { body: { text: TEXT } });
    assert.deepEqual([r.status, r.json], [200, { url: null, reason: 'off' }]);
    assert.equal(el.calls.length, 0);
  }
  assert.equal(heads, 0);
});

test('a cached description answers its Blob url with no ElevenLabs call, even over the cap', async () => {
  const { handler, blob, el } = make({ env: { ...ENV, SPEAK_MAX_PER_HOUR: '0' } });
  blob.store.set(pathFor(TEXT), { url: 'https://blob.test/cached.mp3' });
  const r = await call(handler, { body: { text: `  ${TEXT.replace(/ /g, '   ')} ` } });
  assert.deepEqual([r.status, r.json], [200, { url: 'https://blob.test/cached.mp3' }]);
  assert.equal(el.calls.length, 0);
  assert.equal(blob.puts.length, 0);
});

test('a miss calls text-to-speech with the voice first and stores public audio/mpeg at the sha1 path', async () => {
  const { handler, blob, el } = make();
  const r = await call(handler, { body: { text: TEXT } });
  assert.deepEqual([r.status, r.json], [200, { url: `https://blob.test/${pathFor(TEXT)}` }]);
  assert.equal(el.calls.length, 1);
  const c = el.calls[0];
  assert.equal(c.voice, 'JBFqnCBsd6RMkjVDRZzb');
  assert.deepEqual(c.req, { text: TEXT, modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128' });
  assert.equal(c.ro.maxRetries, 0);
  assert.equal(c.ro.timeoutInSeconds, 2);
  assert.ok(c.ro.abortSignal);
  assert.equal(c.apiKey, TEAM);
  assert.equal(blob.puts.length, 1);
  const p = blob.puts[0];
  assert.equal(p.p, pathFor(TEXT));
  assert.match(p.p, /^speech\/[0-9a-f]{40}\.mp3$/);
  assert.deepEqual([...p.body], [1, 2, 3, 4, 5]);
  assert.equal(p.o.access, 'public');
  assert.equal(p.o.contentType, 'audio/mpeg');
  assert.equal(p.o.addRandomSuffix, false);
  assert.equal(p.o.allowOverwrite, true);
  const again = await call(handler, { parsed: { text: TEXT } });
  assert.equal(again.json.url, r.json.url);
  assert.equal(el.calls.length, 1, 'the second ask is a cache hit');
});

test('ELEVENLABS_VOICE_ID and ELEVENLABS_TTS_MODEL pick the voice and model and key the cache', async () => {
  const { handler, blob, el } = make({ env: { ...ENV, ELEVENLABS_VOICE_ID: ' gOupLcAkjEnguROwi4oS ', ELEVENLABS_TTS_MODEL: 'eleven_multilingual_v2' } });
  const r = await call(handler, { body: { text: TEXT } });
  assert.equal(el.calls[0].voice, 'gOupLcAkjEnguROwi4oS');
  assert.equal(el.calls[0].req.modelId, 'eleven_multilingual_v2');
  assert.equal(blob.puts[0].p, pathFor(TEXT, 'eleven_multilingual_v2', 'gOupLcAkjEnguROwi4oS'));
  assert.notEqual(blob.puts[0].p, pathFor(TEXT));
  assert.ok(r.json.url);
  assert.equal(speechPath('m', 'v', 't'), `speech/${sha1('m|v|t')}.mp3`);
});

test('the team key is capped per hour, a visitor key skips the cap, and the hour rolls over', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let clock = 1_000_000;
  const { handler, el } = make({ env: { ...ENV, SPEAK_MAX_PER_HOUR: '2' }, now: () => clock });
  const ask = (text, headers) => call(handler, { body: { text }, headers });
  assert.ok((await ask('one')).json.url);
  const [a, b] = await Promise.all([ask('two'), ask('two')]);
  assert.ok(a.json.url && a.json.url === b.json.url, 'two asks in flight share one call and one slot');
  assert.equal(el.calls.length, 2);
  assert.deepEqual((await ask('three')).json, { url: null, reason: 'capped' });
  assert.equal(el.calls.length, 2, 'over the cap, ElevenLabs is never called');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /SPEAK_MAX_PER_HOUR/);
  const mine = await ask('three', { 'x-elevenlabs-key': VISITOR });
  assert.ok(mine.json.url, 'a visitor key is not capped');
  assert.equal(el.calls[2].apiKey, VISITOR);
  assert.equal(el.keys.filter((k) => k === TEAM).length, 1, 'the team client is made once and reused');
  clock += HOUR_MS;
  assert.ok((await ask('four')).json.url, 'slots age out after an hour');
  assert.equal(JSON.stringify(warn.mock.calls).includes(TEAM), false);
});

test('a visitor key works with no team key set', async () => {
  const { handler, el } = make({ env: {} });
  const r = await call(handler, { headers: { 'x-elevenlabs-key': ` ${VISITOR} ` }, body: { text: TEXT } });
  assert.equal(r.json.url, `https://blob.test/${pathFor(TEXT)}`);
  assert.deepEqual(el.keys, [VISITOR]);
});

test('SPEAK_MAX_PER_HOUR parses to a whole number >= 0, else 30', () => {
  assert.equal(MAX_PER_HOUR, 30);
  for (const raw of [undefined, null, '', ' ', 'abc', '-1', '2.5', 'Infinity']) assert.equal(maxPerHour(raw), 30, String(raw));
  assert.equal(maxPerHour('0'), 0);
  assert.equal(maxPerHour(' 7 '), 7);
});

test('failures and a hung call answer 200 error, and no key reaches a log or a response', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  // Shaped like the SDK's ElevenLabsError: the message embeds the upstream body.
  const upstream = (key) => () => Promise.reject(Object.assign(new Error(`Status code: 401\nBody: {"detail":"invalid key ${key}"}`), { name: 'ElevenLabsError', statusCode: 401, body: { detail: `invalid key ${key}` } }));
  const cases = [
    make({ el: fakeElevenLabs(upstream(TEAM)) }),
    make({ el: fakeElevenLabs(() => Promise.reject(new Error(`fetch failed for ${TEAM}`))) }),
    make({ el: fakeElevenLabs(() => Promise.resolve(audioStream())) }),
    make({ blob: fakeBlob({ putError: new Error('store suspended') }) }),
    make({ blob: fakeBlob({ headError: new Error('no blob token') }) }),
    make({ el: fakeElevenLabs(() => new Promise(() => {})), timeoutMs: 60 }),
  ];
  for (const { handler } of cases) {
    const r = await call(handler, { body: { text: TEXT } });
    assert.deepEqual([r.status, r.json], [200, { url: null, reason: 'error' }]);
    assert.equal(r.raw.includes(TEAM), false);
  }
  const visitor = make({ env: {}, el: fakeElevenLabs(upstream(VISITOR)) });
  const r = await call(visitor.handler, { headers: { 'x-elevenlabs-key': VISITOR }, body: { text: TEXT } });
  assert.deepEqual(r.json, { url: null, reason: 'error' });
  assert.equal(cases[4].el.calls.length, 0, 'a broken Blob store spends nothing');
  const logged = JSON.stringify(warn.mock.calls.map((c) => c.arguments));
  assert.equal(warn.mock.callCount(), 7);
  for (const secret of [TEAM, VISITOR, 'invalid key', 'detail']) assert.equal(logged.includes(secret), false, secret);
  assert.match(logged, /ElevenLabsError 401/);
  assert.match(logged, /no speech in 60 ms/);
});

test('after a hung call times out, the same description can be asked again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let n = 0;
  const { handler, el } = make({ el: fakeElevenLabs(() => (n++ ? Promise.resolve(audioStream([7])) : new Promise(() => {}))), timeoutMs: 60 });
  const t0 = Date.now();
  assert.deepEqual((await call(handler, { body: { text: TEXT } })).json, { url: null, reason: 'error' });
  assert.ok(Date.now() - t0 < 1500, 'answered near the timeout');
  assert.ok((await call(handler, { body: { text: TEXT } })).json.url);
  assert.equal(el.calls.length, 2);
});

test('a voice the account lacks falls back to the first voice it has, once, and the team remembers it', async () => {
  const missing = Object.assign(new Error('voice not found'), { statusCode: 404, body: { detail: { status: 'voice_not_found' } } });
  const el = fakeElevenLabs((voice) => (voice === VOICE_ID ? Promise.reject(missing) : Promise.resolve(audioStream([9]))));
  const { handler } = make({ el });
  const r = await call(handler, { body: { text: TEXT } });
  assert.ok(r.json.url, 'answered with a clip');
  assert.deepEqual(el.calls.map((c) => c.voice), [VOICE_ID, 'acct-voice-1']);
  assert.equal(el.listed.length, 1);
  await call(handler, { body: { text: TEXT + ' Again.' } });
  assert.deepEqual(el.calls.slice(2).map((c) => c.voice), ['acct-voice-1'], 'the stand-in is used straight away next time');
  assert.equal(el.listed.length, 1, 'the voice list is read once');
  // An account with no voices at all answers error, not a crash.
  const none = fakeElevenLabs(() => Promise.reject(missing), []);
  assert.deepEqual((await call(make({ el: none }).handler, { body: { text: TEXT } })).json, { url: null, reason: 'error' });
});
