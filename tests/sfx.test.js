// Tests for api/sfx.js and tools/sfx.mjs with a fake ElevenLabs client and fake Blob functions; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlobNotFoundError } from '@vercel/blob';
import { createHandler, parseRequest, sfxKey, toBuffer, tokenMatches, maxPerHour, SFX_PARAMS, MAX_PER_HOUR, HOUR_MS, WARN_EVERY_MS } from '../api/sfx.js';
import { validatePalette, plan, cost, run, PALETTE, CREDITS_PER_SECOND } from '../tools/sfx.mjs';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const ENV = { SOUND_GEN: 'on', ELEVENLABS_API_KEY: 'fake-key-for-tests' };
const audioStream = (...chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); } });

// Blob stand-in: an in-memory store keyed by pathname.
function fakeBlob(opts = {}) {
  const store = new Map(), puts = [];
  return {
    store, puts,
    head: async (p) => { if (opts.headError) throw opts.headError; if (!store.has(p)) throw new BlobNotFoundError(); return { url: store.get(p).url }; },
    put: async (p, body, o) => { if (opts.putError) throw opts.putError; puts.push({ p, body, o }); const url = `https://blob.test/${p}`; store.set(p, { url, body }); return { url, pathname: p }; },
  };
}

function fakeClient(impl) {
  const calls = [];
  return { calls, textToSoundEffects: { convert: (req, ro) => { calls.push({ req, ro }); return impl ? impl(req, ro) : Promise.resolve(audioStream([1, 2, 3], [4, 5])); } } };
}

// Drive the handler like node:http would: req is a readable body with a method, res collects the reply.
// r.read says whether the handler started reading the body stream.
async function call(handler, { method = 'POST', body, parsed, headers: reqHeaders = {} } = {}) {
  let read = false;
  const req = Readable.from((function* () { read = true; if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); })());
  req.method = method;
  req.headers = reqHeaders;
  if (parsed !== undefined) req.body = parsed;
  const headers = {};
  let out = '';
  const res = {
    statusCode: 200, headersSent: false,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    end: (s) => { if (s) out += s; res.headersSent = true; },
  };
  await handler(req, res);
  return { status: res.statusCode, headers, json: out ? JSON.parse(out) : undefined, read };
}

function make(over = {}) {
  const blob = over.blob || fakeBlob(), client = over.client || fakeClient();
  const handler = createHandler({ env: over.env || ENV, client, head: blob.head, put: blob.put, timeoutMs: over.timeoutMs || 2000, now: over.now });
  return { handler, blob, client };
}

test('non-POST is 405 JSON with an Allow header', async () => {
  const { handler, client } = make();
  const r = await call(handler, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
  assert.equal(typeof r.json.error, 'string');
  assert.equal(client.calls.length, 0);
});

test('204 with no body unless SOUND_GEN is exactly on', async () => {
  for (const SOUND_GEN of [undefined, 'off', 'ON', '1']) {
    const { handler, client } = make({ env: { ...ENV, SOUND_GEN } });
    const r = await call(handler, { body: { label: 'train', prompt: 'steam train' } });
    assert.equal(r.status, 204);
    assert.equal(r.json, undefined);
    assert.equal(client.calls.length, 0);
  }
});

test('bad input is 400 JSON and never reaches ElevenLabs', async () => {
  const { handler, client } = make();
  const bad = ['{nope', '[]', { label: 3, prompt: 'x' }, { prompt: { a: 1 } }, { label: 'x'.repeat(41), prompt: 'p' },
    { label: 'ok', prompt: 'p'.repeat(201) }, { label: '  ', prompt: '' }, {}];
  for (const body of bad) {
    const r = await call(handler, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.url, null);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal(client.calls.length, 0);
});

test('parseRequest keys by the lowercased trimmed label, else the prompt', () => {
  assert.equal(parseRequest({ label: '  Steam Train ', prompt: 'a' }).key, sha1('steam train'));
  assert.equal(parseRequest({ label: 'steam train', prompt: 'b' }).key, sha1('steam train'));
  const p = parseRequest({ prompt: 'Soft Rain On A Roof' });
  assert.equal(p.key, sha1('soft rain on a roof'));
  assert.equal(p.text, 'Soft Rain On A Roof');
  assert.equal(parseRequest({ label: 'Hare' }).text, 'Hare', 'the label is the prompt when no prompt is given');
  assert.equal(sfxKey('A  B'), sha1('a b'));
});

test('a cached label answers from Blob without generating', async () => {
  const { handler, blob, client } = make();
  const p = `sfx/${sha1('cached bell')}.mp3`;
  blob.store.set(p, { url: `https://blob.test/${p}` });
  const r = await call(handler, { body: { label: 'Cached Bell', prompt: 'a church bell' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, `https://blob.test/${p}`);
  assert.equal(r.json.cached, true);
  assert.equal(client.calls.length, 0);
});

test('a miss generates once with the pinned options and puts a public mp3 at sfx/<sha1>.mp3', async () => {
  const { handler, blob, client } = make();
  const r = await call(handler, { body: { label: 'Locomotive', prompt: 'distant steam train whistle' } });
  assert.equal(r.status, 200);
  const p = `sfx/${sha1('locomotive')}.mp3`;
  assert.deepEqual(r.json, { url: `https://blob.test/${p}`, cached: false });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].req, { text: 'distant steam train whistle', durationSeconds: 3, promptInfluence: 0.5, modelId: 'eleven_text_to_sound_v2', outputFormat: 'mp3_44100_128' });
  assert.equal(client.calls[0].ro.maxRetries, 0);
  assert.ok(client.calls[0].ro.abortSignal);
  assert.equal(blob.puts.length, 1);
  assert.equal(blob.puts[0].p, p);
  assert.deepEqual([...blob.puts[0].body], [1, 2, 3, 4, 5]);
  assert.equal(blob.puts[0].o.access, 'public');
  assert.equal(blob.puts[0].o.addRandomSuffix, false);
  assert.equal(blob.puts[0].o.contentType, 'audio/mpeg');
  const again = await call(handler, { body: { label: 'locomotive', prompt: 'anything' } });
  assert.equal(again.json.cached, true);
  assert.equal(client.calls.length, 1, 'the second call for the label hits the cache');
  assert.equal(SFX_PARAMS.durationSeconds, 3);
});

test('a Vercel pre-parsed req.body is used as is', async () => {
  const { handler, client } = make();
  const r = await call(handler, { parsed: { label: 'Parsed Cloud', prompt: 'soft wind' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.url.endsWith(`${sha1('parsed cloud')}.mp3`));
  assert.equal(client.calls.length, 1);
});

test('every failure is 200 {url:null}', async () => {
  const boom = () => Promise.reject(new Error('quota exceeded'));
  let r = await call(make({ client: fakeClient(boom) }).handler, { body: { label: 'fail convert', prompt: 'x' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }]);

  r = await call(make({ client: fakeClient(() => Promise.resolve(audioStream())) }).handler, { body: { label: 'fail empty', prompt: 'x' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }], 'empty audio');

  r = await call(make({ blob: fakeBlob({ putError: new Error('store suspended') }) }).handler, { body: { label: 'fail put', prompt: 'x' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }]);

  const broken = make({ blob: fakeBlob({ headError: new Error('no token') }) });
  r = await call(broken.handler, { body: { label: 'fail head', prompt: 'x' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }]);
  assert.equal(broken.client.calls.length, 0, 'a broken Blob store does not spend credits');

  const nokey = make({ env: { SOUND_GEN: 'on' } });
  r = await call(nokey.handler, { body: { label: 'fail nokey', prompt: 'x' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }]);
  assert.equal(nokey.client.calls.length, 0);
});

test('a hung generation times out to {url:null} and does not block the queue', async () => {
  const hung = make({ client: fakeClient(() => new Promise(() => {})), timeoutMs: 80 });
  const t0 = Date.now();
  const r = await call(hung.handler, { body: { label: 'hang', prompt: 'x' } });
  assert.deepEqual(r.json, { url: null });
  assert.ok(Date.now() - t0 < 1500, 'answered near the timeout');
  const next = await call(make().handler, { body: { label: 'after hang', prompt: 'x' } });
  assert.ok(next.json.url, 'the next generation still runs');
});

test('generations run one at a time, and one label in flight is generated once', async () => {
  let active = 0, peak = 0;
  const slow = () => { active++; peak = Math.max(peak, active); return new Promise((ok) => setTimeout(() => { active--; ok(audioStream([9])); }, 30)); };
  const { handler, client } = make({ client: fakeClient(slow) });
  const rs = await Promise.all([
    call(handler, { body: { label: 'serial a', prompt: 'x' } }),
    call(handler, { body: { label: 'serial b', prompt: 'x' } }),
    call(handler, { body: { label: 'serial c', prompt: 'x' } }),
    call(handler, { body: { label: 'Serial C', prompt: 'y' } }),
  ]);
  assert.equal(peak, 1);
  assert.equal(client.calls.length, 3);
  assert.ok(rs.every((r) => r.json.url));
  assert.equal(rs[2].json.url, rs[3].json.url);
});

const TOKEN_ENV = { ...ENV, HOST_TOKEN: 's3cret' };
const DENIED = { url: null, error: 'host token' };

test('with HOST_TOKEN set, a missing or wrong x-host-token is 401 before the body and SOUND_GEN', async () => {
  const { handler, client, blob } = make({ env: TOKEN_ENV });
  const wrong = [{}, { 'x-host-token': '' }, { 'x-host-token': 'wrong!' }, { 'x-host-token': 'S3CRET' },
    { 'x-host-token': 's3cre' }, { 'x-host-token': 's3cret-and-more' }, { 'x-host-token': ['s3cret'] }, { host: 's3cret' }];
  for (const headers of wrong) {
    const r = await call(handler, { headers, body: { label: 'denied', prompt: 'x' } });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(r.json, DENIED);
    assert.equal(r.read, false, 'the body is never read');
  }
  let r = await call(handler, { body: '{nope' });
  assert.deepEqual([r.status, r.json], [401, DENIED], 'bad JSON from a stranger is still 401, not 400');
  r = await call(make({ env: { ...TOKEN_ENV, SOUND_GEN: 'off' } }).handler, { body: { label: 'denied' } });
  assert.deepEqual([r.status, r.json], [401, DENIED], 'checked before SOUND_GEN');
  const noHeaders = await (async () => { const res = { statusCode: 0, setHeader() {}, end(s) { res.out = s; } }; await handler({ method: 'POST' }, res); return res; })();
  assert.equal(noHeaders.statusCode, 401, 'a request without a headers object is denied, not a crash');
  assert.equal(client.calls.length, 0);
  assert.equal(blob.puts.length, 0);
});

test('the right x-host-token passes', async () => {
  const { handler, client } = make({ env: TOKEN_ENV });
  const r = await call(handler, { headers: { 'x-host-token': 's3cret' }, body: { label: 'Token Bell', prompt: 'bell' } });
  assert.equal(r.status, 200);
  assert.equal(r.read, true);
  assert.equal(r.json.cached, false);
  assert.ok(r.json.url.endsWith(`${sha1('token bell')}.mp3`));
  assert.equal(client.calls.length, 1);
  const off = await call(make({ env: { ...TOKEN_ENV, SOUND_GEN: 'off' } }).handler, { headers: { 'x-host-token': 's3cret' }, body: {} });
  assert.equal(off.status, 204, 'past the token, SOUND_GEN still decides');
  assert.equal(tokenMatches('s3cret', 's3cret'), true);
  assert.equal(tokenMatches('s3creT', 's3cret'), false);
  assert.equal(tokenMatches(undefined, 's3cret'), false);
});

test('no host token check when HOST_TOKEN is empty', async () => {
  for (const env of [{ ...ENV, HOST_TOKEN: '' }, ENV]) {
    const { handler, client } = make({ env });
    const a = await call(handler, { body: { label: 'open a', prompt: 'x' } });
    const b = await call(handler, { headers: { 'x-host-token': 'anything' }, body: { label: 'open b', prompt: 'x' } });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.ok(a.json.url && b.json.url);
    assert.equal(client.calls.length, 2);
  }
});

test('SFX_MAX_PER_HOUR parses to a whole number >= 0, else 20', () => {
  assert.equal(MAX_PER_HOUR, 20);
  for (const raw of [undefined, null, '', '  ', 'abc', '-1', '2.5', 'Infinity']) assert.equal(maxPerHour(raw), 20, String(raw));
  assert.equal(maxPerHour('5'), 5);
  assert.equal(maxPerHour(' 7 '), 7);
  assert.equal(maxPerHour('0'), 0);
});

test('the cap answers 200 {url:null} without calling ElevenLabs, warns once a minute and rolls over the hour', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let clock = 5_000_000;
  const t0 = clock;
  const { handler, client, blob } = make({ env: { ...ENV, SFX_MAX_PER_HOUR: '2' }, now: () => clock });
  const ask = (label) => call(handler, { body: { label, prompt: 'x' } });
  assert.ok((await ask('cap a')).json.url);
  clock = t0 + 10 * 60 * 1000;
  // Two requests for one label in flight share one call and one slot.
  const [b1, b2] = await Promise.all([ask('cap b'), ask('Cap B')]);
  assert.ok(b1.json.url && b1.json.url === b2.json.url);
  assert.equal(client.calls.length, 2);

  let r = await ask('cap c');
  assert.deepEqual([r.status, r.json], [200, { url: null }]);
  r = await ask('cap d');
  assert.deepEqual(r.json, { url: null });
  assert.equal(client.calls.length, 2, 'over the cap, ElevenLabs is never called');
  assert.equal(blob.puts.length, 2);
  assert.equal(warn.mock.callCount(), 1, 'one warning within the minute');
  assert.match(String(warn.mock.calls[0].arguments[0]), /SFX_MAX_PER_HOUR/);

  clock += WARN_EVERY_MS;
  assert.deepEqual((await ask('cap e')).json, { url: null });
  assert.equal(warn.mock.callCount(), 2, 'and one more a minute later');

  clock = t0 + HOUR_MS; // cap a ages out; cap b (10 minutes later) still counts
  r = await ask('cap f');
  assert.equal(r.json.cached, false);
  assert.ok(r.json.url);
  assert.deepEqual((await ask('cap g')).json, { url: null });
  assert.equal(client.calls.length, 3);
});

test('cache hits do not count toward the cap and are still served once it is reached', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { handler, client, blob } = make({ env: { ...ENV, SFX_MAX_PER_HOUR: '1' }, now: () => 1 });
  const p = `sfx/${sha1('cached bell')}.mp3`;
  blob.store.set(p, { url: `https://blob.test/${p}` });
  const ask = (label) => call(handler, { body: { label, prompt: 'x' } });
  for (let i = 0; i < 5; i++) assert.equal((await ask('Cached Bell')).json.cached, true);
  const fresh = await ask('fresh one');
  assert.equal(fresh.json.cached, false, 'five cache hits left the one slot free');
  assert.deepEqual((await ask('another new')).json, { url: null });
  assert.equal((await ask('cached bell')).json.cached, true, 'at the cap, a cached label still answers');
  assert.equal((await ask('fresh one')).json.url, fresh.json.url, 'and so does one generated this hour');
  assert.equal(client.calls.length, 1);
});

test('the default cap is 20 new sounds an hour, and 0 means cache only', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { handler, client } = make({ now: () => 1 });
  for (let i = 0; i < 20; i++) assert.ok((await call(handler, { body: { label: `default ${i}`, prompt: 'x' } })).json.url, `sound ${i}`);
  assert.deepEqual((await call(handler, { body: { label: 'default 20', prompt: 'x' } })).json, { url: null });
  assert.equal(client.calls.length, 20);
  const none = make({ env: { ...ENV, SFX_MAX_PER_HOUR: '0' } });
  assert.deepEqual((await call(none.handler, { body: { label: 'zero', prompt: 'x' } })).json, { url: null });
  assert.equal(none.client.calls.length, 0);
});

test('toBuffer accepts web streams, async iterables, buffers and blobs', async () => {
  assert.deepEqual([...await toBuffer(audioStream([1], [2, 3]))], [1, 2, 3]);
  assert.deepEqual([...await toBuffer(Readable.from([Buffer.from([4]), Buffer.from([5])]))], [4, 5]);
  assert.deepEqual([...await toBuffer(new Uint8Array([6]))], [6]);
  assert.deepEqual([...await toBuffer(new Blob([new Uint8Array([7, 8])]))], [7, 8]);
  await assert.rejects(toBuffer(audioStream([1, 2, 3]), 2), /too large/);
  await assert.rejects(toBuffer(null));
});

const palette = JSON.parse(fs.readFileSync(PALETTE, 'utf8'));

test('the palette is valid, in priority order, short and cheap', () => {
  validatePalette(palette);
  assert.deepEqual(palette.slice(0, 6).map((e) => e.file), ['join', 'poke', 'appear', 'save', 'reset', 'gallery']);
  for (const e of palette) assert.equal(e.seconds, e.loop ? 4 : 2, e.file);
  for (const f of ['wind', 'water', 'fire']) assert.equal(palette.find((e) => e.file === f).loop, true, f);
  assert.equal(CREDITS_PER_SECOND, 40);
  assert.ok(cost(palette) <= 2000, `whole palette about ${cost(palette)} credits`);
  assert.throws(() => validatePalette([{ file: 'a', prompt: 'p', seconds: 2, loop: false }, { file: 'a', prompt: 'p', seconds: 2, loop: false }]), /duplicate/);
  assert.throws(() => validatePalette([{ file: 'Bad.mp3', prompt: 'p', seconds: 2, loop: false }]), /file/);
  assert.throws(() => validatePalette([{ file: 'a', prompt: 'p', seconds: 31, loop: false }]), /seconds/);
});

test('plan skips files that exist and honours --only', () => {
  const have = new Set(['join', 'appear']);
  assert.deepEqual(plan(palette, (f) => have.has(f)).slice(0, 2).map((e) => e.file), ['poke', 'save']);
  assert.deepEqual(plan(palette, () => false, 'poke.mp3').map((e) => e.file), ['poke']);
  assert.deepEqual(plan(palette, (f) => have.has(f), 'join'), []);
  assert.throws(() => plan(palette, () => false, 'nope'), /no palette entry/);
});

test('run writes missing files serially with duration set and stops at the first error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'join.mp3'), 'already here');
    let credits = 10000, n = 0;
    const client = {
      user: { subscription: { get: async () => ({ characterLimit: 10000, characterCount: 10000 - credits }) } },
      textToSoundEffects: { convert: async (req, ro) => {
        assert.equal(ro.maxRetries, 0);
        assert.equal(typeof req.durationSeconds, 'number');
        assert.equal(req.modelId, 'eleven_text_to_sound_v2');
        if (++n === 3) throw new Error('rate limited');
        credits -= req.durationSeconds * 40;
        return audioStream([n]);
      } },
    };
    const lines = [];
    await assert.rejects(run({ client, palette, dir, log: (s) => lines.push(s) }), /rate limited/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['appear.mp3', 'join.mp3', 'poke.mp3']);
    assert.equal(fs.readFileSync(path.join(dir, 'join.mp3'), 'utf8'), 'already here', 'existing files are never regenerated');
    assert.ok(lines.some((l) => l.includes('credits left: 10000')));
    assert.ok(lines.some((l) => /wrote poke\.mp3.*spent 80 \(40 a second\), 9920 left/.test(l)), lines.join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- bring your own key (x-elevenlabs-key) ----------

const USER_KEY = 'FAKE_eleven_key_0123456789';

// A handler whose team client is `team` and whose visitor clients come from makeClient, which records each key.
function byok(env, impl) {
  const blob = fakeBlob(), team = fakeClient(), visitor = fakeClient(impl), made = [];
  const handler = createHandler({ env, client: team, makeClient: (k) => { made.push(k); return visitor; }, head: blob.head, put: blob.put, timeoutMs: 2000, now: () => 1 });
  return { handler, blob, team, visitor, made };
}
const mine = { 'x-elevenlabs-key': ` ${USER_KEY} ` };

test('a valid x-elevenlabs-key generates with its own client even with SOUND_GEN off and no team key', async () => {
  for (const env of [{ SOUND_GEN: 'off' }, {}, { ...ENV, SOUND_GEN: 'off' }]) {
    const label = `byok bell ${Object.keys(env).length}`;
    const b = byok(env);
    const r = await call(b.handler, { headers: mine, body: { label, prompt: 'a small bell' } });
    assert.deepEqual([r.status, r.json], [200, { url: `https://blob.test/sfx/${sha1(label)}.mp3`, cached: false }]);
    assert.deepEqual(b.made, [USER_KEY], 'one client for the trimmed key');
    assert.equal(b.visitor.calls.length, 1);
    assert.equal(b.team.calls.length, 0);
    assert.equal(b.visitor.calls[0].ro.maxRetries, 0);
  }
});

test('a visitor key skips SFX_MAX_PER_HOUR and leaves the team slots alone; a cache hit is still free', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const b = byok({ ...ENV, SFX_MAX_PER_HOUR: '0' });
  assert.deepEqual((await call(b.handler, { body: { label: 'byok cap team' } })).json, { url: null }, 'the team key is cache only');
  for (let i = 0; i < 3; i++) assert.ok((await call(b.handler, { headers: mine, body: { label: `byok cap ${i}` } })).json.url);
  assert.equal(b.visitor.calls.length, 3);
  assert.equal((await call(b.handler, { headers: mine, body: { label: 'byok cap 0' } })).json.cached, true);
  assert.equal(b.visitor.calls.length, 3);
  const one = byok({ ...ENV, SFX_MAX_PER_HOUR: '1' });
  assert.ok((await call(one.handler, { headers: mine, body: { label: 'byok slot a' } })).json.url);
  assert.ok((await call(one.handler, { body: { label: 'byok slot b' } })).json.url, 'the key request did not use the one team slot');
  assert.equal(one.team.calls.length, 1);
});

test('a malformed x-elevenlabs-key is 400 bad key before the body, SOUND_GEN or any call', async () => {
  for (const env of [ENV, { SOUND_GEN: 'off' }]) {
    const b = byok(env);
    for (const bad of ['short', `${USER_KEY} x`, 'k'.repeat(201), [USER_KEY]]) {
      const r = await call(b.handler, { headers: { 'x-elevenlabs-key': bad }, body: { label: 'byok bad' } });
      assert.deepEqual([r.status, r.json, r.read], [400, { url: null, error: 'bad key' }, false], String(bad));
    }
    assert.equal(b.made.length + b.team.calls.length + b.blob.puts.length, 0);
  }
  const blank = byok({ SOUND_GEN: 'off' });
  assert.equal((await call(blank.handler, { headers: { 'x-elevenlabs-key': '  ' }, body: { label: 'byok blank' } })).status, 204, 'a blank header is no key');
});

test('the host token is still checked first, with or without a visitor key', async () => {
  const b = byok({ ...TOKEN_ENV, SOUND_GEN: 'off' });
  for (const headers of [mine, { 'x-elevenlabs-key': 'short' }, { ...mine, 'x-host-token': 'wrong!' }]) {
    const r = await call(b.handler, { headers, body: { label: 'byok token' } });
    assert.deepEqual([r.status, r.json, r.read], [401, DENIED, false]);
  }
  assert.equal(b.made.length + b.visitor.calls.length, 0);
  const r = await call(b.handler, { headers: { ...mine, 'x-host-token': 's3cret' }, body: { label: 'byok token ok' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.cached, false);
});

test('the visitor key never reaches a reply or a log line, even when ElevenLabs quotes it', async (t) => {
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) t.mock.method(console, m, (...a) => lines.push(a.map(String).join(' ')));
  const b = byok({ SOUND_GEN: 'off' }, () => Promise.reject(new Error(`401 invalid_api_key ${USER_KEY} (${USER_KEY})`)));
  const r = await call(b.handler, { headers: mine, body: { label: 'byok leak' } });
  assert.deepEqual([r.status, r.json], [200, { url: null }]);
  const bad = await call(b.handler, { headers: { 'x-elevenlabs-key': `${USER_KEY}/` }, body: { label: 'byok leak' } });
  assert.ok(lines.length >= 1);
  assert.ok(lines.some((l) => l.includes('[key]')), lines.join('\n'));
  assert.ok([JSON.stringify(r.json), JSON.stringify(bad.json), ...lines].every((s) => !s.includes(USER_KEY)), lines.join('\n'));
});
