// Tests for api/tripo.js and lib/tripo.js with a fake fetch (Tripo, its model CDN, the Blob CDN) and a fake Blob; no
// network. Keys are obvious fakes, with a dot early on so the pre-commit hook's tsk_ pattern lets them through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { BlobNotFoundError } from '@vercel/blob';
import { createHandler, parsePost, maxPerHour, MAX_PNG_B64, MAX_BODY, MAX_GLB, TASK_TTL_MS, HOUR_MS } from '../api/tripo.js';
import { TRIPO_BASE, TASK_OPTIONS, tripoKey, retryAfter, failure, taskView } from '../lib/tripo.js';

const TEAM = 'tsk_FAKE.team.key.0001';
const YOURS = 'tsk_FAKE.visitor.key.0002';
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const KEY = sha1('https://blob.test/art/a.jpg|lamp|[[0,0],[1,1]]'), KEY2 = sha1('two'), KEY3 = sha1('three'), KEY4 = sha1('four');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28, 1)]);
const MODEL = 'https://cdn.tripo.test/signed/model.glb?sig=abc';
const TASK = '0b8e7c1a-1111-4222-8333-944455556666', TASK2 = '1c9f8d2b-2222-4333-9444-a55566667777';
const CROP_URL = `https://blob.test/tripo/in/${KEY}.png`, GLB_URL = `https://blob.test/tripo/${KEY}.glb`;

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (data) => json(200, { code: 0, data });
const success = () => ok({ task_id: TASK, status: 'success', progress: 100, output: { model_url: MODEL, rendered_image_url: 'https://cdn.tripo.test/r.webp' } });

// Blob stand-in keyed by pathname; uploadedAt comes from the test's clock.
function fakeBlob(clock, opts = {}) {
  const store = new Map(), puts = [];
  const url = (p) => `https://blob.test/${p}`;
  return {
    store, puts,
    head: async (p) => { if (!store.has(p)) throw new BlobNotFoundError(); return { url: url(p), uploadedAt: new Date(store.get(p).at) }; },
    put: async (p, body, o) => {
      if (opts.putError && opts.putError(p)) throw new Error(`blob down for ${p}`);
      puts.push({ p, body, o });
      store.set(p, { body: Buffer.from(body), at: clock.t });
      return { url: url(p), pathname: p };
    },
    seed: (p, body, at = clock.t) => store.set(p, { body: Buffer.from(body), at }),
  };
}

// Routes by URL; t.create/upload/task/glb override Tripo's and the CDN's answers. Records every call.
function fakeFetch(blob, t = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body });
    if (t.echo) throw new Error(`socket closed sending ${JSON.stringify(init.headers || {})} for ${TEAM}`);
    if (url.startsWith('https://blob.test/')) {
      const b = blob.store.get(url.slice('https://blob.test/'.length));
      return b ? new Response(b.body) : new Response('', { status: 404 });
    }
    if (url === MODEL) return t.glb ? t.glb() : new Response(GLB, { headers: { 'content-length': String(GLB.length) } });
    const path = url.slice(TRIPO_BASE.length);
    if (path === '/generation/image-to-model') return t.create ? t.create(JSON.parse(init.body)) : ok({ task_id: TASK });
    if (path === '/files') return t.upload ? t.upload(init.body) : ok({ file_token: 'file_abc' });
    if (path.startsWith('/tasks/')) return t.task ? t.task(decodeURIComponent(path.slice(7))) : ok({ task_id: TASK, status: 'running', progress: 40 });
    throw new Error(`unexpected fetch ${url}`);
  };
  const only = (pred) => calls.filter(pred);
  return {
    fetch, calls,
    creates: () => only((c) => c.url.endsWith('/generation/image-to-model')),
    uploads: () => only((c) => c.url.endsWith('/files')),
    tripoCalls: () => only((c) => c.url.startsWith(TRIPO_BASE)),
    downloads: () => only((c) => c.url === MODEL),
  };
}

// Drive the handler like Vercel would: req.body pre-parsed when given, else a raw stream; res collects the reply.
async function call(handler, { method = 'POST', url = '/api/tripo', body, raw, headers = {} } = {}) {
  const req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
  Object.assign(req, { method, url, headers });
  if (body !== undefined) req.body = body;
  const out = { headers: {} };
  const res = {
    statusCode: 200, headersSent: false,
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: (s) => { out.text = s || ''; res.headersSent = true; },
  };
  await handler(req, res);
  assert.equal(out.headers['cache-control'], 'no-store');
  return { status: res.statusCode, headers: out.headers, text: out.text, json: out.text ? JSON.parse(out.text) : undefined };
}

function make({ env = { TRIPO_API_KEY: TEAM }, tripo, putError } = {}) {
  const clock = { t: 1_000_000_000 };
  const blob = fakeBlob(clock, { putError });
  const f = fakeFetch(blob, tripo);
  const handler = createHandler({ env, fetch: f.fetch, head: blob.head, put: blob.put, now: () => clock.t, timeoutMs: 500, glbTimeoutMs: 500 });
  const post = (key = KEY, headers = {}, png = PNG) => call(handler, { body: { key, png: png.toString('base64') }, headers });
  const poll = (task = TASK, key = KEY, headers = {}) => call(handler, { method: 'GET', url: `/api/tripo?task=${encodeURIComponent(task)}&key=${key}`, headers });
  return { handler, blob, clock, ...f, post, poll };
}

test('tripo: anything but GET or POST is 405 with Allow; nothing upstream', async () => {
  const m = make();
  const r = await call(m.handler, { method: 'PUT' });
  assert.deepEqual([r.status, r.headers.allow, typeof r.json.error], [405, 'GET, POST', 'string']);
  assert.equal(m.calls.length, 0);
});

test('tripo: with HOST_TOKEN set, a missing or wrong x-host-token is 401 before the key and the body', async () => {
  const m = make({ env: { HOST_TOKEN: 'tvtoken123', TRIPO_API_KEY: TEAM } });
  for (const headers of [{}, { 'x-host-token': 'wrong' }, { 'x-host-token': 'tvtoken12' }]) {
    assert.deepEqual([(await m.post(KEY, headers)).status, (await m.poll(TASK, KEY, headers)).status], [401, 401]);
  }
  assert.deepEqual((await m.post(KEY, { 'x-host-token': 'bad', 'x-tripo-key': 'junk' })).json, { error: 'host token' });
  assert.equal(m.calls.length + m.blob.puts.length, 0);
  assert.equal((await m.post(KEY, { 'x-host-token': 'tvtoken123' })).json.status, 'queued');
});

test('tripo: no key anywhere is 200 {status:off} with no call; a malformed x-tripo-key is 400', async () => {
  for (const env of [{}, { TRIPO_API_KEY: '   ' }]) {
    const m = make({ env });
    assert.deepEqual([(await m.post()).json, (await m.poll()).json], [{ status: 'off' }, { status: 'off' }]);
    assert.deepEqual((await call(m.handler, { raw: '{not json' })).json, { status: 'off' }, 'off before the body is read');
    assert.equal(m.calls.length + m.blob.puts.length, 0);
  }
  const m = make();
  for (const k of ['sk_fake_00000000000000000000', 'tsk_short', `${YOURS} extra`, `${YOURS}, ${YOURS}`]) {
    const r = await m.post(KEY, { 'x-tripo-key': k });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad key' }], k);
  }
  assert.equal(m.calls.length, 0);
});

test('tripo: bad POST bodies are 400 or 413 and reach neither Tripo nor Blob', async () => {
  const m = make();
  const b64 = PNG.toString('base64');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)]).toString('base64');
  const cases = [
    [{ raw: '{nope' }, 400], [{ raw: '' }, 400], [{ body: [] }, 400], [{ body: 'x' }, 400],
    [{ body: { png: b64 } }, 400], [{ body: { key: 'abc', png: b64 } }, 400], [{ body: { key: KEY.slice(1) + 'g', png: b64 } }, 400],
    [{ body: { key: KEY } }, 400], [{ body: { key: KEY, png: 42 } }, 400], [{ body: { key: KEY, png: '!!!!' } }, 400],
    [{ body: { key: KEY, png: jpeg } }, 400], [{ body: { key: KEY, png: 'iVBO' } }, 400],
    [{ body: { key: KEY, png: 'A'.repeat(MAX_PNG_B64 + 4) } }, 413],
    [{ body: { key: KEY, png: b64 }, headers: { 'content-length': String(MAX_BODY + 1) } }, 413],
  ];
  for (const [req, want] of cases) {
    const r = await call(m.handler, req);
    assert.equal(r.status, want, JSON.stringify(req).slice(0, 80));
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal(m.calls.length + m.blob.puts.length, 0);
  assert.equal(parsePost({ key: KEY.toUpperCase(), png: `data:image/png;base64,${b64}` }).key, KEY, 'upper hex and a data: prefix are tolerated');
});

test('tripo create: the crop is stored public, its URL is the task input, and the task is remembered', async () => {
  const m = make();
  const r = await m.post();
  assert.deepEqual([r.status, r.json], [200, { status: 'queued', task: TASK }]);
  const [crop, task] = m.blob.puts;
  assert.equal(crop.p, `tripo/in/${KEY}.png`);
  assert.deepEqual(crop.o, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'image/png' });
  assert.ok(Buffer.from(crop.body).equals(PNG));
  const [c] = m.creates();
  assert.deepEqual([c.method, c.headers.Authorization, c.headers['Content-Type']], ['POST', `Bearer ${TEAM}`, 'application/json']);
  assert.deepEqual(JSON.parse(c.body), { input: CROP_URL, model: 'v3.1-20260211', texture: true, pbr: false, texture_quality: 'standard', face_limit: 20000 });
  assert.deepEqual(Object.keys(TASK_OPTIONS).filter((k) => k === 'quad' || k === 'compress'), []);
  assert.equal(m.uploads().length, 0, 'a URL input needs no upload');
  assert.equal(task.p, `tripo/${KEY}.task.json`);
  assert.deepEqual(JSON.parse(task.body), { task: TASK });
  assert.deepEqual([task.o.access, task.o.allowOverwrite, task.o.addRandomSuffix, task.o.cacheControlMaxAge], ['public', true, false, 60]);
});

test('tripo create: the upload fallback when the crop cannot be stored or Tripo refuses its URL', async () => {
  const noBlob = make({ putError: (p) => p.startsWith('tripo/in/') });
  assert.deepEqual((await noBlob.post()).json, { status: 'queued', task: TASK });
  const [up] = noBlob.uploads();
  assert.ok(up.body instanceof FormData);
  assert.equal(up.headers['Content-Type'], undefined, 'fetch sets the multipart boundary');
  assert.equal(up.headers.Authorization, `Bearer ${TEAM}`);
  const file = up.body.get('file');
  assert.equal(file.type, 'image/png');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG));
  assert.equal(JSON.parse(noBlob.creates()[0].body).input, 'file_abc');

  const refused = make({ tripo: { create: (b) => (b.input === CROP_URL ? json(400, { code: 1004, message: 'bad input' }) : ok({ task_id: TASK2 })) } });
  assert.deepEqual((await refused.post()).json, { status: 'queued', task: TASK2 });
  assert.deepEqual(refused.creates().map((c) => JSON.parse(c.body).input), [CROP_URL, 'file_abc']);

  // Busy, out of credits or no answer: an upload would not help (and after a timeout Tripo may have made the task).
  const cases = [
    [() => json(429, { code: 2000 }, { 'retry-after': '7' }), { status: 'busy', retry_after: 7 }],
    [() => json(403, { code: 2010 }), { status: 'no_credits' }],
    [() => { throw new TypeError('fetch failed'); }, { status: 'failed', reason: 'error' }],
  ];
  for (const [create, want] of cases) {
    const m = make({ tripo: { create } });
    assert.deepEqual((await m.post()).json, want);
    assert.equal(m.uploads().length, 0);
    assert.equal(m.blob.store.has(`tripo/${KEY}.task.json`), false);
  }
});

test('tripo: a GLB already in Blob answers success with no Tripo call and no cap spent', async () => {
  const m = make({ env: { TRIPO_API_KEY: TEAM, TRIPO_MAX_PER_HOUR: '0' } });
  m.blob.seed(`tripo/${KEY}.glb`, GLB);
  assert.deepEqual((await m.post()).json, { status: 'success', model_url: GLB_URL });
  assert.equal(m.tripoCalls().length + m.blob.puts.length, 0);
});

test('tripo: a task under 15 min old is reused unasked; an older one is asked once before paying again; a junk file makes a new one', async () => {
  let next = TASK, answer = () => ok({ task_id: TASK, status: 'running', progress: 40 });
  const m = make({ tripo: { create: () => ok({ task_id: next }), task: (id) => answer(id) } });
  assert.deepEqual((await m.post()).json, { status: 'queued', task: TASK });
  next = TASK2;
  m.clock.t += TASK_TTL_MS - 1;
  assert.deepEqual((await m.post()).json, { status: 'queued', task: TASK });
  assert.equal(m.tripoCalls().length, 1, 'fresh: no Tripo call at all');
  m.clock.t += 1;
  assert.deepEqual((await m.post()).json, { status: 'queued', task: TASK }, 'still running: shared');
  assert.deepEqual(m.tripoCalls().map((c) => c.url), [`${TRIPO_BASE}/generation/image-to-model`, `${TRIPO_BASE}/tasks/${TASK}`]);

  // Busy or unreachable: neither a new task nor a cap slot.
  for (const [a, want] of [[() => json(429, { code: 2000 }), { status: 'busy', retry_after: 5 }], [() => { throw new TypeError('fetch failed'); }, { status: 'failed', reason: 'error' }]]) {
    answer = a;
    assert.deepEqual((await m.post()).json, want);
  }
  assert.equal(m.creates().length, 1);

  // Finished while nobody polled: copied, never paid again.
  answer = success;
  assert.deepEqual((await m.post()).json, { status: 'success', model_url: GLB_URL });
  assert.equal(m.creates().length + m.downloads().length, 2);

  // Failed (refunded) or not shown to this key: a new task.
  for (const [a, key] of [[() => ok({ task_id: TASK, status: 'failed', error_code: 2008 }), KEY2], [() => json(404, { code: 2001 }), KEY3]]) {
    m.blob.seed(`tripo/${key}.task.json`, JSON.stringify({ task: TASK }), m.clock.t - TASK_TTL_MS);
    answer = a;
    assert.deepEqual((await m.post(key)).json, { status: 'queued', task: TASK2 });
  }
  assert.equal(m.creates().length, 3);
  m.blob.seed(`tripo/${KEY4}.task.json`, '{"task":"../etc"}', m.clock.t - TASK_TTL_MS);
  assert.deepEqual((await m.post(KEY4)).json, { status: 'queued', task: TASK2 });
  assert.equal(m.creates().length, 4);
});

test('tripo cap: TRIPO_MAX_PER_HOUR team tasks an hour per instance; a visitor key skips it; refusals give the slot back', async () => {
  const m = make({ env: { TRIPO_API_KEY: TEAM, TRIPO_MAX_PER_HOUR: '2' } });
  assert.equal((await m.post(KEY)).json.status, 'queued');
  assert.equal((await m.post(KEY2)).json.status, 'queued');
  assert.deepEqual((await m.post(KEY3)).json, { status: 'capped' });
  assert.equal(m.creates().length, 2);
  assert.equal((await m.post(KEY)).json.status, 'queued', 'a pending task is free');
  assert.equal((await m.post(KEY3, { 'x-tripo-key': YOURS })).json.status, 'queued');
  assert.equal(m.creates()[2].headers.Authorization, `Bearer ${YOURS}`);
  m.clock.t += HOUR_MS;
  assert.equal((await m.post(KEY4)).json.status, 'queued');

  assert.deepEqual((await make({ env: { TRIPO_API_KEY: TEAM, TRIPO_MAX_PER_HOUR: '0' } }).post()).json, { status: 'capped' });
  assert.deepEqual([maxPerHour(undefined), maxPerHour(''), maxPerHour('lots'), maxPerHour('-1'), maxPerHour(' 3 '), maxPerHour('0')], [6, 6, 6, 6, 3, 0]);

  let refuse = true;
  const r = make({ env: { TRIPO_API_KEY: TEAM, TRIPO_MAX_PER_HOUR: '1' }, tripo: { create: () => (refuse ? json(400, { code: 2002 }) : ok({ task_id: TASK })) } });
  assert.deepEqual((await r.post()).json, { status: 'failed', reason: 'tripo code 2002' });
  refuse = false;
  assert.equal((await r.post(KEY2)).json.status, 'queued', 'nothing was charged, so the slot came back');
  assert.deepEqual((await r.post(KEY3)).json, { status: 'capped' });
});

test('tripo: two POSTs for one key at once share one create', async () => {
  let release;
  const gate = new Promise((ok_) => { release = ok_; });
  const m = make({ tripo: { create: async () => { await gate; return ok({ task_id: TASK }); } } });
  const both = Promise.all([m.post(), m.post()]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.deepEqual((await both).map((r) => r.json), [{ status: 'queued', task: TASK }, { status: 'queued', task: TASK }]);
  assert.equal(m.creates().length, 1);
});

test('tripo poll: queued and running carry progress; every other status is failed with a short reason', async () => {
  const cases = [
    [{ status: 'queued' }, { status: 'queued', progress: 0 }],
    [{ status: 'running', progress: 55.4 }, { status: 'running', progress: 55 }],
    [{ status: 'running', progress: 400 }, { status: 'running', progress: 100 }],
    [{ status: 'failed', error_code: 2008, error_message: 'policy' }, { status: 'failed', reason: 'failed 2008' }],
    [{ status: 'cancelled' }, { status: 'failed', reason: 'cancelled' }],
    [{ status: 'banned' }, { status: 'failed', reason: 'banned' }],
    [{ status: 'expired' }, { status: 'failed', reason: 'expired' }],
    [{ status: 'melted' }, { status: 'failed', reason: 'unknown' }],
    [{}, { status: 'failed', reason: 'unknown' }],
    [{ status: 'success', output: {} }, { status: 'failed', reason: 'no model' }],
    [{ status: 'success', output: { model_url: 'http://cdn.tripo.test/m.glb' } }, { status: 'failed', reason: 'no model' }],
  ];
  for (const [data, want] of cases) {
    const m = make({ tripo: { task: (id) => ok({ task_id: id, ...data }) } });
    assert.deepEqual((await m.poll()).json, want, JSON.stringify(data));
    const [c] = m.tripoCalls();
    assert.deepEqual([c.url, c.method, c.headers.Authorization], [`${TRIPO_BASE}/tasks/${TASK}`, 'GET', `Bearer ${TEAM}`]);
    assert.equal(m.blob.puts.length, 0);
  }
  const mine = make({ env: {} });
  assert.equal((await mine.poll(TASK, KEY, { 'x-tripo-key': YOURS })).json.status, 'running');
  assert.equal(mine.tripoCalls()[0].headers.Authorization, `Bearer ${YOURS}`);
});

test('tripo poll: 429 is busy with Retry-After, 2010 is no_credits, a malformed answer is failed', async () => {
  const cases = [
    [() => json(429, { code: 1007 }, { 'retry-after': '12' }), { status: 'busy', retry_after: 12 }],
    [() => json(429, { code: 2000 }), { status: 'busy', retry_after: 5 }],
    [() => json(403, { code: 2010, message: 'no credits' }), { status: 'no_credits' }],
    [() => json(401, { code: 1002 }), { status: 'failed', reason: 'tripo code 1002' }],
    [() => new Response('<html>oops</html>', { status: 502 }), { status: 'failed', reason: 'tripo HTTP 502' }],
    [() => new Response('not json'), { status: 'failed', reason: 'tripo HTTP 200' }],
    [() => json(200, { code: 1, data: { status: 'success' } }), { status: 'failed', reason: 'tripo code 1' }],
    [() => json(200, { data: { status: 'running' } }), { status: 'failed', reason: 'tripo HTTP 200' }],
    [() => json(200, { code: 0, data: 'nope' }), { status: 'failed', reason: 'unknown' }],
    [() => { throw new TypeError('fetch failed'); }, { status: 'failed', reason: 'error' }],
  ];
  for (const [task, want] of cases) assert.deepEqual((await make({ tripo: { task } }).poll()).json, want);
});

test('tripo poll success: the GLB is copied into Blob once, downloaded with no Authorization', async () => {
  const m = make({ tripo: { task: success } });
  assert.deepEqual((await m.poll()).json, { status: 'success', model_url: GLB_URL });
  const [d] = m.downloads();
  assert.deepEqual(d.headers, {}, 'the key never goes to the model CDN');
  const glb = m.blob.puts.find((p) => p.p === `tripo/${KEY}.glb`);
  assert.deepEqual(glb.o, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'model/gltf-binary' });
  assert.ok(Buffer.from(glb.body).equals(GLB));
  assert.deepEqual((await m.poll()).json, { status: 'success', model_url: GLB_URL });
  assert.equal(m.downloads().length, 1, 'head first: a second poll that sees success copies nothing');
  assert.deepEqual((await m.post()).json, { status: 'success', model_url: GLB_URL });
});

test('tripo GLB copy: over 25 MB by header or by stream, not a GLB, or a failed download is failed and stores nothing', async () => {
  const big = () => new ReadableStream({ start(c) { for (let i = 0; i < 26; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
  const cases = [
    () => new Response(GLB, { headers: { 'content-length': String(MAX_GLB + 1) } }),
    () => new Response(big()),
    () => new Response(Buffer.from('<html>not a model</html>')),
    () => new Response('', { status: 403 }),
    () => { throw new TypeError('fetch failed'); },
  ];
  for (const glb of cases) {
    const m = make({ tripo: { task: success, glb } });
    assert.deepEqual((await m.poll()).json, { status: 'failed', reason: 'error' });
    assert.equal(m.blob.puts.length, 0);
  }
});

test('tripo GET: needs a task id and a 40 hex key', async () => {
  const m = make();
  for (const [task, key] of [['', KEY], [TASK, 'abc'], ['../tasks', KEY], ['a'.repeat(129), KEY], [TASK, '']]) {
    const r = await m.poll(task, key);
    assert.equal(r.status, 400, `${task} ${key}`);
  }
  assert.equal((await call(m.handler, { method: 'GET', url: '/api/tripo' })).status, 400);
  assert.equal(m.calls.length, 0);
});

test('tripo: no reply and no log line carries a key, even when errors quote it', async (t) => {
  const lines = [];
  for (const k of ['log', 'warn', 'error', 'info']) t.mock.method(console, k, (...a) => lines.push(a.map(String).join(' ')));
  const seen = [];
  for (const tripo of [{ echo: true }, { task: success, glb: () => { throw new Error(`download failed for ${TEAM}`); } }]) {
    const m = make({ tripo, putError: () => true });
    for (const headers of [{}, { 'x-tripo-key': YOURS }]) {
      for (const r of [await m.post(KEY, headers), await m.poll(TASK, KEY, headers)]) seen.push(r.text);
    }
  }
  assert.ok(lines.length > 0);
  for (const s of [...seen, ...lines]) assert.ok(!s.includes(TEAM) && !s.includes(YOURS), s);
});

test('lib/tripo: header reading, Retry-After, failures and task views', () => {
  const req = (v) => ({ headers: v === undefined ? {} : { 'x-tripo-key': v } });
  assert.equal(tripoKey(req()), undefined);
  assert.equal(tripoKey(req('   ')), undefined);
  assert.equal(tripoKey(req(` ${YOURS} `)), YOURS);
  for (const bad of ['AIzaFAKEfakeFAKEfake_1234-X9q2', `${YOURS}, ${YOURS}`, [YOURS, YOURS], 7]) assert.equal(tripoKey(req(bad)), null, String(bad));
  assert.deepEqual([retryAfter('3'), retryAfter('2.2'), retryAfter(null), retryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), retryAfter('')], [3, 3, 5, 5, 5]);
  assert.deepEqual(failure(Object.assign(new Error('x'), { name: 'TimeoutError' })), { status: 'failed', reason: 'timeout' });
  assert.deepEqual(failure(null), { status: 'failed', reason: 'error' });
  assert.deepEqual(taskView(null), { status: 'failed', reason: 'unknown' });
  assert.deepEqual(taskView({ status: 'success', output: { model_url: MODEL } }), { status: 'success', url: MODEL });
});
