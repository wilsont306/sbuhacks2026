// node:test suite for lib/gemini.js (retry and fallback over a fake client) and api/interpret.js (Blob, Gemini and
// Snowflake injected as stubs). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readArtwork, buildRequest, parseOutput, classify, thinkingFor, PRIMARY_MODEL, FALLBACK_MODEL, PROMPT } from '../lib/gemini.js';
import { createHandler, readBody, parseRequest, sniff, siblingUrl, clientIp, userKey, KEY_RE, GEMINI_MODELS, MAX_BODY, MAX_PER_HOUR, MIN_GAP_MS } from '../api/interpret.js';
import { sceneJsonSchema } from '../src/shared/scene-validate.js';

// ---------- helpers ----------

// A tiny JPEG-looking payload: the magic bytes, then filler (Gemini is stubbed, so it never has to decode).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
const JPEG_B64 = JPEG.toString('base64');
const ID = '0b7c3f62-5d1e-4c3a-9f00-123456789abc';
const STORE = 'https://abc123.public.blob.vercel-storage.com';
const RAW = {
  title_guess: 'The Starry Night', artist_guess: 'Vincent van Gogh', palette: ['#1b2a6b', '#f2c94c'],
  ground_path: [[1000, 850], [0, 880]],
  objects: [{ label: 'cypress', kind: 'plant', box_2d: [100, 50, 900, 250], mask: [[500, 0], [1000, 1000], [0, 1000]], depth: 0.2, colour: '#1f3a2b', motion: 'sway', sound_prompt: 'wind in branches' }],
};
const quiet = () => {};

function fakeReq({ method = 'POST', body, headers = {}, preParsed, socket } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = '/api/interpret';
  req.headers = { 'content-type': 'application/json', ...headers };
  if (socket) req.socket = socket;
  if (preParsed !== undefined) Object.defineProperty(req, 'body', typeof preParsed === 'function' ? { get: preParsed } : { value: preParsed });
  return req;
}

function fakeRes() {
  let done;
  const finished = new Promise((r) => { done = r; });
  const res = {
    statusCode: 200, headers: {}, headersSent: false, writableEnded: false, finished,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.headersSent = true; this.writableEnded = true; this.text = text; done(); },
    json() { return JSON.parse(this.text); },
  };
  return res;
}

async function call(handler, reqOpts) {
  const res = fakeRes();
  await handler(fakeReq(reqOpts), res);
  await res.finished;
  assert.match(res.headers['content-type'], /^application\/json/);
  return { status: res.statusCode, body: res.json(), res };
}

// Blob stub: records puts, answers with a public URL at the given pathname.
function fakeBlob({ failOn = null } = {}) {
  const puts = [];
  const put = async (path, body, opts) => {
    puts.push({ path, body, opts });
    if (failOn && path.startsWith(failOn)) throw new Error(`blob down for ${path}`);
    return { url: `${STORE}/${path}`, pathname: path };
  };
  return { put, puts };
}

function deps(over = {}) {
  const blob = over.blob || fakeBlob();
  const saved = [];
  const waited = [];
  return {
    blob, saved, waited,
    handler: createHandler({
      put: blob.put,
      readArtwork: async () => ({ raw: RAW, model: PRIMARY_MODEL }),
      saveProject: async (row) => { saved.push(row); return true; },
      waitUntil: (p) => { waited.push(p); },
      newId: () => ID,
      log: quiet,
      env: {},
      ...over.deps,
    }),
  };
}

// For the guards: a hand-moved clock, a Gemini stub that counts its calls, and a request from one client IP.
function guarded(env, start = 1_000_000) {
  const clock = { t: start };
  const gemini = { calls: 0 };
  const d = deps({ deps: { env, now: () => clock.t, readArtwork: async () => { gemini.calls += 1; return { raw: RAW, model: PRIMARY_MODEL }; } } });
  const from = (ip) => call(d.handler, { body: { image: JPEG_B64 }, headers: ip ? { 'x-forwarded-for': ip } : {} }).then((r) => r.body);
  return { ...d, clock, gemini, from };
}

// A fake @google/genai client whose interactions.create plays back a script of answers.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    interactions: {
      create: (request, options) => {
        calls.push({ request, options });
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        return typeof step === 'function' ? step(request, options) : step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
      },
    },
  };
}
const answer = (obj) => ({ id: 'i1', status: 'completed', output_text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const never = () => new Promise(() => {});

// ---------- lib/gemini.js ----------

test('gemini: the request carries the inline image at low resolution, the JSON schema and the thinking level', () => {
  const r = buildRequest({ model: PRIMARY_MODEL, base64: 'QUJD', mimeType: 'image/jpeg' });
  assert.equal(r.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(r.input[0], { type: 'image', data: 'QUJD', mime_type: 'image/jpeg', resolution: 'low' });
  assert.deepEqual(r.input[1], { type: 'text', text: PROMPT });
  assert.deepEqual(r.response_format, { type: 'text', mime_type: 'application/json', schema: sceneJsonSchema });
  assert.equal(r.generation_config.thinking_level, 'minimal');
  assert.equal(buildRequest({ model: FALLBACK_MODEL, base64: 'QUJD' }).generation_config.thinking_level, 'low');
  assert.equal(thinkingFor('gemini-3.8-flash'), 'low');
  assert.match(PROMPT, /unknown/);
  assert.match(PROMPT, /12 words/);
  assert.match(PROMPT, /- description: .*220 characters/);
  assert.doesNotMatch(PROMPT, /poke/);
});

test('gemini: parseOutput reads output_text or the model_output steps; rejects non-objects', () => {
  assert.deepEqual(parseOutput(answer({ a: 1 })), { a: 1 });
  assert.deepEqual(parseOutput({ steps: [{ type: 'user_input' }, { type: 'model_output', content: [{ type: 'text', text: '{"b":' }, { type: 'text', text: '2}' }] }] }), { b: 2 });
  assert.deepEqual(parseOutput(answer('```json\n{"c":3}\n```')), { c: 3 });
  for (const bad of [answer('nope'), answer('[1]'), answer('null'), {}, null, { output_text: 5 }]) {
    assert.throws(() => parseOutput(bad), (e) => e.reason === 'bad_json');
  }
});

test('gemini: classify sorts failures into retry and fallback', () => {
  assert.deepEqual(classify(httpError(503)), { reason: 'upstream', retry: true, fallback: true, status: 503 });
  assert.deepEqual(classify(httpError(429)), { reason: 'quota', retry: false, fallback: true, status: 429 });
  assert.equal(classify(httpError(403)).reason, 'auth');
  assert.equal(classify(httpError(400, 'API key not valid. Please pass a valid API key.')).reason, 'auth');
  assert.deepEqual(classify(httpError(400, 'schema too complex')), { reason: 'rejected', retry: false, fallback: true, status: 400 });
  assert.equal(classify(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' })).reason, 'timeout');
  assert.equal(classify(Object.assign(new Error('x'), { name: 'APIConnectionError' })).reason, 'network');
});

test('gemini: first answer wins; the abort signal is passed and SDK retries are off', async () => {
  const client = fakeClient([answer(RAW)]);
  const out = await readArtwork({ base64: JPEG_B64, client, log: quiet });
  assert.deepEqual(out, { raw: RAW, model: PRIMARY_MODEL });
  assert.equal(client.calls.length, 1);
  assert.ok(client.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(client.calls[0].options.retries, { strategy: 'none' });
});

test('gemini: invalid JSON is retried once on the same model', async () => {
  const client = fakeClient([answer('not json'), answer(RAW)]);
  const out = await readArtwork({ base64: JPEG_B64, client, log: quiet });
  assert.equal(out.model, PRIMARY_MODEL);
  assert.deepEqual(client.calls.map((c) => c.request.model), [PRIMARY_MODEL, PRIMARY_MODEL]);
});

test('gemini: two 5xx answers, then one call to gemini-3.8-flash with thinking low', async () => {
  const client = fakeClient([httpError(500), httpError(503), answer(RAW)]);
  const out = await readArtwork({ base64: JPEG_B64, client, log: quiet });
  assert.deepEqual(out, { raw: RAW, model: FALLBACK_MODEL });
  assert.deepEqual(client.calls.map((c) => c.request.model), [PRIMARY_MODEL, PRIMARY_MODEL, FALLBACK_MODEL]);
  assert.equal(client.calls[2].request.generation_config.thinking_level, 'low');
});

test('gemini: a quota answer skips the same-model retry and falls back once', async () => {
  const client = fakeClient([httpError(429), httpError(429)]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client, log: quiet }), (e) => e.reason === 'quota' && e.status === 429);
  assert.deepEqual(client.calls.map((c) => c.request.model), [PRIMARY_MODEL, FALLBACK_MODEL]);
});

test('gemini: a bad key stops at once', async () => {
  const client = fakeClient([httpError(401)]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client, log: quiet }), (e) => e.reason === 'auth');
  assert.equal(client.calls.length, 1);
});

test('gemini: no key means no call and an immediate no_key', async () => {
  const t = Date.now();
  await assert.rejects(readArtwork({ base64: JPEG_B64, apiKey: '', log: quiet }), (e) => e.reason === 'no_key');
  assert.ok(Date.now() - t < 100);
  await assert.rejects(readArtwork({ base64: '', client: fakeClient([answer(RAW)]), log: quiet }), (e) => e.reason === 'bad_image');
});

test('gemini: each attempt is cut at attemptMs even if the SDK hangs; the deadline stops new attempts', async () => {
  const client = fakeClient([never]);
  const t = Date.now();
  await assert.rejects(readArtwork({ base64: JPEG_B64, client, attemptMs: 40, log: quiet }), (e) => e.reason === 'timeout');
  assert.equal(client.calls.length, 3, 'timeout -> retry -> fallback');
  assert.ok(client.calls.every((c) => c.options.signal.aborted), 'every hung call was aborted');
  assert.ok(Date.now() - t < 1000);
  const short = fakeClient([never]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client: short, attemptMs: 40, deadline: Date.now() + 60, log: quiet }), (e) => e.reason === 'timeout');
  assert.ok(short.calls.length < 3, `deadline honoured (${short.calls.length} calls)`);
});

test('gemini: out of time before the fallback, the real failure is reported; a junk deadline is ignored', async () => {
  // 2550 ms left lets one attempt start (the floor is 2500 ms); 120 ms later there is too little for the fallback.
  const slow429 = fakeClient([() => new Promise((_, no) => setTimeout(() => no(httpError(429)), 120))]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client: slow429, attemptMs: 5000, deadline: Date.now() + 2550, log: quiet }), (e) => e.reason === 'quota');
  assert.equal(slow429.calls.length, 1, 'no fallback started with too little time left');
  const client = fakeClient([answer(RAW)]);
  assert.equal((await readArtwork({ base64: JPEG_B64, client, deadline: NaN, log: quiet })).model, PRIMARY_MODEL);
});

test('gemini: GEMINI_MODEL set to the fallback model means no third call', async () => {
  const client = fakeClient([httpError(500)]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client, model: FALLBACK_MODEL, log: quiet }), (e) => e.reason === 'upstream');
  assert.deepEqual(client.calls.map((c) => c.request.model), [FALLBACK_MODEL, FALLBACK_MODEL]);
});

test('gemini: the key never reaches the log', async () => {
  const key = 'AIzaFAKEFAKEFAKE-test-only';
  const lines = [];
  const client = fakeClient([httpError(500, `upstream said ${key} twice ${key}`)]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client, apiKey: key, log: (l) => lines.push(l) }));
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => !l.includes(key)), lines.join('\n'));
  // A key straddling the 200-character cut: scrubbing after the cut would have left its first characters behind.
  const edge = [];
  const atCut = fakeClient([httpError(500, `${'x'.repeat(190)}${key} trailing`)]);
  await assert.rejects(readArtwork({ base64: JPEG_B64, client: atCut, apiKey: key, log: (l) => edge.push(l) }));
  assert.ok(edge.length >= 1);
  assert.ok(edge.every((l) => !l.includes(key.slice(0, 6)) && l.includes('[key]')), edge.join('\n'));
});

// ---------- api/interpret.js pieces ----------

test('interpret: sniff, siblingUrl and parseRequest', () => {
  assert.deepEqual(sniff(JPEG), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])), { mime: 'image/png', ext: 'png' });
  assert.equal(sniff(Buffer.from('GIF89a........')), null);
  assert.equal(siblingUrl(`${STORE}/art/${ID}.jpg`, `art/${ID}.jpg`, `scenes/${ID}.json`), `${STORE}/scenes/${ID}.json`);
  assert.equal(siblingUrl('not a url', 'a', 'b'), '');
  const ok = parseRequest({ image: `data:image/jpeg;base64,${JPEG_B64}`, source: 'phone', name: '  My\npostcard ', credit: 'Courtesy W. Wang' });
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal(ok.source, 'phone');
  assert.equal(ok.name, 'My postcard');
  assert.equal(ok.credit, 'Courtesy W. Wang');
  assert.ok(ok.bytes.equals(JPEG));
  assert.equal(parseRequest({ image: JPEG_B64, source: 'sample' }).source, 'drop', 'only drop or phone from the wire');
  assert.equal(parseRequest({ image: JPEG_B64 }).credit, null);
  assert.equal(parseRequest({}).error, 'no_image');
  assert.equal(parseRequest({ image: 'not base64!!' }).error, 'bad_image');
  assert.equal(parseRequest({ image: Buffer.from('hello there, this is plain text and not an image at all, padded out past one hundred bytes......').toString('base64') }).error, 'not_image');
  assert.equal(parseRequest({ image: 'A'.repeat(MAX_BODY) }).status, 413);
  assert.equal(parseRequest(null).error, 'bad_body');
});

test('interpret: readBody handles a raw stream, a pre-parsed body, a throwing getter and the cap', async () => {
  assert.deepEqual(await readBody(fakeReq({ body: { a: 1 } })), { body: { a: 1 } });
  assert.deepEqual(await readBody(fakeReq({ preParsed: { a: 2 } })), { body: { a: 2 } });
  assert.deepEqual(await readBody(fakeReq({ preParsed: Buffer.from('{"a":3}') })), { body: { a: 3 } });
  assert.deepEqual(await readBody(fakeReq({ preParsed: () => { throw new Error('Invalid JSON'); } })), { status: 400 });
  assert.deepEqual(await readBody(fakeReq({ body: '{"a":' })), { status: 400 });
  assert.deepEqual(await readBody(fakeReq({ body: '[1,2]' })), { status: 400 });
  assert.deepEqual(await readBody(fakeReq({ body: 'x'.repeat(2000) }), 1000), { status: 413 });
  assert.deepEqual(await readBody(fakeReq({ body: '{}', headers: { 'content-length': String(MAX_BODY + 1) } })), { status: 413 });
});

// ---------- api/interpret.js handler ----------

test('handler: non-POST is 405 JSON with Allow', async () => {
  const { handler } = deps();
  const { status, body, res } = await call(handler, { method: 'GET' });
  assert.equal(status, 405);
  assert.deepEqual(body, { ok: false, reason: 'method' });
  assert.equal(res.headers.allow, 'POST');
});

test('handler: bad JSON is 400, a missing image 400, a body over 1.5 MB 413, all JSON', async () => {
  const { handler, blob } = deps();
  assert.deepEqual(await call(handler, { body: '{nope' }).then((r) => [r.status, r.body]), [400, { ok: false, reason: 'bad_body' }]);
  assert.deepEqual(await call(handler, { body: { source: 'drop' } }).then((r) => [r.status, r.body]), [400, { ok: false, reason: 'no_image' }]);
  assert.deepEqual(await call(handler, { body: { image: 'QUJD'.repeat(100) } }).then((r) => [r.status, r.body.reason]), [400, 'not_image']);
  const big = await call(handler, { body: JSON.stringify({ image: 'A'.repeat(MAX_BODY + 10) }) });
  assert.deepEqual([big.status, big.body], [413, { ok: false, reason: 'too_large' }]);
  assert.equal(blob.puts.length, 0, 'nothing stored for a refused request');
});

test('handler: the happy path stores image and scene, answers 200 with the validated scene, saves later', async () => {
  let putBeforeRead = false;
  const blob = fakeBlob();
  const { handler, saved, waited } = deps({
    blob,
    deps: {
      readArtwork: async (args) => {
        assert.equal(args.base64, JPEG_B64);
        assert.equal(args.mimeType, 'image/jpeg');
        assert.ok(args.deadline > Date.now() && args.deadline <= Date.now() + 25000);
        await new Promise((r) => setTimeout(r, 5));
        putBeforeRead = blob.puts.some((p) => p.path.startsWith('art/'));
        return { raw: RAW, model: PRIMARY_MODEL };
      },
    },
  });
  const { status, body } = await call(handler, { body: { image: JPEG_B64, source: 'phone', name: 'Postcard 3' } });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.id, ID);
  assert.equal(body.image_url, `${STORE}/art/${ID}.jpg`);
  assert.equal(body.scene_url, `${STORE}/scenes/${ID}.json`);
  assert.ok(putBeforeRead, 'image upload ran alongside the Gemini read');

  const s = body.scene;
  assert.equal(s.id, ID);
  assert.equal(s.source, 'phone');
  assert.equal(s.ai_draft, true);
  assert.equal(s.edited, false);
  assert.equal(s.model, PRIMARY_MODEL);
  assert.equal(s.image_url, body.image_url);
  assert.equal(s.scene_url, body.scene_url);
  assert.deepEqual(s.objects[0].box, [50, 100, 250, 900]);
  assert.deepEqual(s.objects[0].mask, [[150, 100], [250, 900], [50, 900]], 'box-relative mask now in image space');
  assert.deepEqual(s.ground_path, [[0, 880], [1000, 850]]);

  const [art, sceneFile] = blob.puts;
  assert.equal(art.path, `art/${ID}.jpg`);
  assert.ok(art.body.equals(JPEG));
  assert.equal(art.opts.access, 'public');
  assert.equal(art.opts.addRandomSuffix, false);
  assert.equal(art.opts.contentType, 'image/jpeg');
  assert.equal(sceneFile.path, `scenes/${ID}.json`);
  assert.equal(sceneFile.opts.contentType, 'application/json');
  assert.equal(sceneFile.opts.addRandomSuffix, false);
  assert.deepEqual(JSON.parse(sceneFile.body), s, 'the stored scene is the returned scene');

  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    id: ID, name: 'Postcard 3', source: 'phone', image_url: body.image_url, scene_url: body.scene_url, scene: s,
    title_guess: 'The Starry Night', artist_guess: 'Vincent van Gogh', credit: null,
  });
});

test('handler: a Gemini failure answers 200 ok:false with its reason and the saved image', async () => {
  const { handler, saved, waited } = deps({ deps: { readArtwork: async () => { throw Object.assign(new Error('no key'), { reason: 'no_key' }); } } });
  const { status, body } = await call(handler, { body: { image: JPEG_B64, source: 'drop' } });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: false, reason: 'no_key', id: ID, image_url: `${STORE}/art/${ID}.jpg`, scene: null });
  assert.equal(waited.length + saved.length, 0, 'nothing to save');
});

test('handler: a readArtwork that throws synchronously is still a JSON 200', async () => {
  const { handler } = deps({ deps: { readArtwork: () => { throw new TypeError('kaput'); } } });
  const { status, body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'gemini');
});

test('handler: image upload failed -> ok:false storage, no image_url, the scene still returned', async () => {
  const blob = fakeBlob({ failOn: 'art/' });
  const { handler, saved } = deps({ blob });
  const { status, body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'storage');
  assert.equal('image_url' in body, false);
  assert.equal(body.scene.objects.length, 1);
  assert.equal(body.scene.image_url, '', 'not stored');
  assert.equal(body.scene.scene_url, '', 'not stored');
  assert.equal(blob.puts.length, 1, 'no scene file without an image');
  assert.equal(saved.length, 0);
});

test('handler: a hanging image upload is cut with the scene reserve, so the validated scene still comes back', async () => {
  // 3000 ms of the budget is the scene reserve, so the image put gets about 150 ms; this stub ignores its abort.
  const puts = [];
  const put = (path, body, opts) => { puts.push({ path, opts }); return never(); };
  const { handler, saved } = deps({ blob: { put, puts }, deps: { budgetMs: 3150 } });
  const t = Date.now();
  const { status, body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.ok(Date.now() - t < 2500, `answered before the overall timeout (${Date.now() - t} ms)`);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'storage');
  assert.equal('image_url' in body, false);
  assert.equal(body.scene.objects.length, 1, 'the good scene is not lost to a timeout');
  assert.equal(body.scene.title_guess, 'The Starry Night');
  assert.equal(body.scene.scene_url, '', 'no scene file, so no scene URL');
  assert.deepEqual(puts.map((p) => p.path), [`art/${ID}.jpg`], 'no scene file without an image');
  assert.equal(puts[0].opts.abortSignal.aborted, true, 'the hung upload was aborted');
  assert.equal(saved.length, 0);
});

test('handler: scene upload failed -> ok:false storage with the image_url, and the scene says it has no file', async () => {
  const blob = fakeBlob({ failOn: 'scenes/' });
  const { handler, saved, waited } = deps({ blob });
  const { body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'storage');
  assert.equal(body.image_url, `${STORE}/art/${ID}.jpg`);
  assert.equal('scene_url' in body, false);
  assert.equal(body.scene.objects.length, 1, 'the validated scene still comes back');
  assert.equal(body.scene.image_url, body.image_url, 'the image was stored');
  assert.equal(body.scene.scene_url, '', 'the scene file was not, so its URL is empty, not the derived one');
  assert.deepEqual(blob.puts.map((p) => p.path), [`art/${ID}.jpg`, `scenes/${ID}.json`]);
  assert.equal(waited.length + saved.length, 0);
});

test('handler: a hanging scene upload is cut at the budget; the reply never carries a scene URL with no file', async () => {
  const puts = [];
  const put = (path, body, opts) => {
    puts.push({ path, opts });
    return path.startsWith('art/') ? Promise.resolve({ url: `${STORE}/${path}` }) : never();
  };
  const { handler, saved } = deps({ blob: { put, puts }, deps: { budgetMs: 200 } });
  const { body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(body.ok, false);
  assert.ok(['storage', 'timeout'].includes(body.reason), body.reason);
  assert.equal(body.image_url, `${STORE}/art/${ID}.jpg`);
  if (body.scene) assert.equal(body.scene.scene_url, '');
  assert.equal(saved.length, 0);
});

test('handler: PNG and WebP are stored as art/<id>.png and art/<id>.webp with their own type', async () => {
  const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
  const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(200, 2)]);
  for (const [bytes, ext, mime] of [[PNG_BYTES, 'png', 'image/png'], [WEBP_BYTES, 'webp', 'image/webp']]) {
    let seenMime;
    const { handler, blob } = deps({ deps: { readArtwork: async (a) => { seenMime = a.mimeType; return { raw: RAW, model: PRIMARY_MODEL }; } } });
    const { body } = await call(handler, { body: { image: bytes.toString('base64') } });
    assert.equal(body.ok, true, ext);
    assert.equal(body.image_url, `${STORE}/art/${ID}.${ext}`);
    assert.equal(body.scene_url, `${STORE}/scenes/${ID}.json`);
    assert.equal(blob.puts[0].path, `art/${ID}.${ext}`);
    assert.equal(blob.puts[0].opts.contentType, mime);
    assert.equal(seenMime, mime);
  }
});

// ---------- api/interpret.js guards: per-IP gap and per-instance hourly cap ----------

test('interpret: clientIp takes the first x-forwarded-for entry, else the socket address', () => {
  assert.equal(clientIp(fakeReq({ headers: { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' } })), '203.0.113.7');
  assert.equal(clientIp(fakeReq({ headers: { 'x-forwarded-for': ['198.51.100.9, 10.0.0.2'] } })), '198.51.100.9');
  assert.equal(clientIp(fakeReq({ socket: { remoteAddress: '192.0.2.4' } })), '192.0.2.4');
  assert.equal(clientIp(fakeReq({ headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '::1' } })), '::1');
  assert.equal(clientIp(fakeReq()), '');
  assert.equal(MAX_PER_HOUR, 30);
  assert.equal(MIN_GAP_MS, 8000);
});

test('handler: a second request from one IP inside the default 8 s is busy, with no Gemini call and nothing stored', async () => {
  const g = guarded({});
  assert.equal((await g.from('203.0.113.7, 10.0.0.1')).ok, true);
  const putsAfterFirst = g.blob.puts.length;
  g.clock.t += MIN_GAP_MS - 1;
  assert.deepEqual(await g.from('203.0.113.7'), { ok: false, reason: 'busy', scene: null });
  assert.equal(g.gemini.calls, 1, 'busy never reaches Gemini');
  assert.equal(g.blob.puts.length, putsAfterFirst, 'busy stores nothing');
  assert.equal((await g.from('203.0.113.8')).ok, true, 'another client is not held up');
  g.clock.t += 1;
  assert.equal((await g.from('203.0.113.7')).ok, true, 'the gap is measured from the last admitted request, not the busy one');
  assert.equal(g.gemini.calls, 3);
});

test('handler: the socket address is the client when there is no x-forwarded-for', async () => {
  const g = guarded({});
  const fromSocket = (addr) => call(g.handler, { body: { image: JPEG_B64 }, socket: { remoteAddress: addr } }).then((r) => r.body);
  assert.equal((await fromSocket('192.0.2.4')).ok, true);
  assert.equal((await fromSocket('192.0.2.4')).reason, 'busy');
  assert.equal((await fromSocket('192.0.2.5')).ok, true);
});

test('handler: INTERPRET_MIN_GAP_MS is read from env, and 0 turns the gap off', async () => {
  const g = guarded({ INTERPRET_MIN_GAP_MS: '500' });
  assert.equal((await g.from('203.0.113.7')).ok, true);
  g.clock.t += 499;
  assert.equal((await g.from('203.0.113.7')).reason, 'busy');
  g.clock.t += 1;
  assert.equal((await g.from('203.0.113.7')).ok, true);
  const off = guarded({ INTERPRET_MIN_GAP_MS: '0' });
  for (let i = 0; i < 3; i += 1) assert.equal((await off.from('203.0.113.7')).ok, true);
});

test('handler: past the default 30 an hour the reply is quota, with no Gemini call and nothing stored; junk env is the default', async () => {
  const g = guarded({ INTERPRET_MAX_PER_HOUR: 'lots', INTERPRET_MIN_GAP_MS: '-5' });
  for (let i = 0; i < MAX_PER_HOUR; i += 1) {
    assert.equal((await g.from('203.0.113.7')).ok, true, `request ${i + 1}`);
    g.clock.t += MIN_GAP_MS;
  }
  const puts = g.blob.puts.length;
  assert.deepEqual(await g.from('203.0.113.99'), { ok: false, reason: 'quota', scene: null });
  assert.equal(g.gemini.calls, MAX_PER_HOUR, 'the 31st never reaches Gemini');
  assert.equal(g.blob.puts.length, puts, 'and stores nothing');
  assert.equal(g.waited.length, MAX_PER_HOUR, 'one Snowflake save queued per admitted request');
});

test('handler: INTERPRET_MAX_PER_HOUR is a sliding hour; busy and quota refusals are not counted; 0 refuses all', async () => {
  const g = guarded({ INTERPRET_MAX_PER_HOUR: '2' });
  const t0 = g.clock.t;
  assert.equal((await g.from('203.0.113.1')).ok, true);
  g.clock.t += 1;
  assert.equal((await g.from('203.0.113.1')).reason, 'busy', 'busy, and not counted');
  g.clock.t += 1;
  assert.equal((await g.from('203.0.113.2')).ok, true, 'the second admitted request');
  assert.equal((await g.from('203.0.113.3')).reason, 'quota');
  assert.equal((await g.from('203.0.113.4')).reason, 'quota', 'a refusal does not count either');
  g.clock.t = t0 + 60 * 60 * 1000 - 1;
  assert.equal((await g.from('203.0.113.5')).reason, 'quota', 'the first is still inside the hour');
  g.clock.t = t0 + 60 * 60 * 1000;
  assert.equal((await g.from('203.0.113.5')).ok, true, 'one slot back once the first is an hour old');
  assert.equal((await g.from('203.0.113.6')).reason, 'quota');
  assert.equal(g.gemini.calls, 3);

  const none = guarded({ INTERPRET_MAX_PER_HOUR: '0' });
  assert.equal((await none.from('203.0.113.1')).reason, 'quota');
  assert.equal(none.gemini.calls + none.blob.puts.length, 0);
});

test('handler: the guards run after the request checks, so a bad request is still its 400 and is not counted', async () => {
  const g = guarded({ INTERPRET_MAX_PER_HOUR: '1' });
  const bad = await call(g.handler, { body: { source: 'drop' }, headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.deepEqual([bad.status, bad.body], [400, { ok: false, reason: 'no_image' }]);
  assert.equal((await g.from('203.0.113.7')).ok, true, 'neither the gap nor the cap saw the bad request');
});

test('handler: over budget answers ok:false timeout in time, even with Gemini hanging', async () => {
  const { handler } = deps({ deps: { readArtwork: never, budgetMs: 80 } });
  const t = Date.now();
  const { status, body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'timeout');
  assert.equal(body.image_url, `${STORE}/art/${ID}.jpg`);
  assert.ok(Date.now() - t < 1000);
});

test('handler: a Snowflake or waitUntil failure never breaks interpret', async () => {
  const a = deps({ deps: { saveProject: async () => { throw new Error('snowflake down'); } } });
  const ra = await call(a.handler, { body: { image: JPEG_B64 } });
  assert.equal(ra.body.ok, true);
  await Promise.all(a.waited);
  const b = deps({ deps: { saveProject: () => { throw new Error('sync boom'); }, waitUntil: () => { throw new Error('no context'); } } });
  const rb = await call(b.handler, { body: { image: JPEG_B64 } });
  assert.equal(rb.body.ok, true);
});

test('handler: the default Snowflake hook is a lazy import that cannot break the reply', async () => {
  const waited = [];
  const handler = createHandler({ put: fakeBlob().put, readArtwork: async () => ({ raw: RAW, model: PRIMARY_MODEL }), waitUntil: (p) => waited.push(p), newId: () => ID, log: quiet });
  const saved = {};
  for (const k of ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PRIVATE_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const { body } = await call(handler, { body: { image: JPEG_B64 } });
    assert.equal(body.ok, true);
    assert.equal(waited.length, 1);
    await assert.doesNotReject(waited[0]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test('handler: a pre-parsed Vercel body works, and a missing name falls back to the title guess', async () => {
  const { handler, saved, waited } = deps();
  const res = fakeRes();
  await handler(fakeReq({ preParsed: { image: JPEG_B64, source: 'drop' } }), res);
  await res.finished;
  assert.equal(res.json().ok, true);
  await Promise.all(waited);
  assert.equal(saved[0].name, 'The Starry Night');
});

test('handler: an empty Gemini answer still yields a walkable scene', async () => {
  const { handler } = deps({ deps: { readArtwork: async () => ({ raw: { objects: 'garbage' }, model: PRIMARY_MODEL }) } });
  const { body } = await call(handler, { body: { image: JPEG_B64 } });
  assert.equal(body.ok, true);
  assert.deepEqual(body.scene.objects, []);
  assert.deepEqual(body.scene.ground_path, [[0, 850], [1000, 850]]);
  assert.equal(body.scene.title_guess, 'unknown');
});

// ---------- bring your own key (x-gemini-key, x-gemini-model) ----------

const USER_KEY = 'FAKE_gemini_key_0123456789';
const TEAM_KEY = 'FAKE_team_gemini_key_0123456789';

// The guards' clock plus a readArtwork that records what it was given and a geminiClient that records the keys it got.
function byok(env = {}, over = {}) {
  const clock = { t: 2_000_000 };
  const reads = [], made = [], logs = [];
  const d = deps({ deps: {
    env, now: () => clock.t, log: (l) => logs.push(String(l)),
    readArtwork: async (opts) => { reads.push(opts); return { raw: RAW, model: opts.model || PRIMARY_MODEL }; },
    geminiClient: async (k) => { made.push(k); return { fake: 'client' }; },
    ...over,
  } });
  const send = (ip, headers = {}) => call(d.handler, { body: { image: JPEG_B64 }, headers: { 'x-forwarded-for': ip, ...headers } });
  const from = (ip, headers) => send(ip, headers).then((r) => r.body);
  return { ...d, clock, reads, made, logs, send, from };
}
const mine = (extra = {}) => ({ 'x-gemini-key': USER_KEY, ...extra });

test('interpret: userKey takes a trimmed key of 20 to 200 safe characters; blank is absent, anything else malformed', () => {
  const h = (v) => ({ headers: { 'x-gemini-key': v } });
  assert.equal(userKey({ headers: {} }, 'x-gemini-key'), undefined);
  assert.equal(userKey({}, 'x-gemini-key'), undefined);
  assert.equal(userKey(h('  \t'), 'x-gemini-key'), undefined);
  assert.equal(userKey(h(` ${USER_KEY}\t`), 'x-gemini-key'), USER_KEY);
  assert.equal(userKey(h('a'.repeat(20)), 'x-gemini-key'), 'a'.repeat(20));
  assert.equal(userKey(h('A.b_c-'.repeat(33) + 'zz'), 'x-gemini-key'), 'A.b_c-'.repeat(33) + 'zz');
  for (const bad of ['a'.repeat(19), 'a'.repeat(201), `${USER_KEY} x`, `${USER_KEY}/`, `${USER_KEY}é`, [USER_KEY], `${USER_KEY}, ${USER_KEY}`]) {
    assert.equal(userKey(h(bad), 'x-gemini-key'), null, String(bad));
  }
  assert.ok(KEY_RE.test(USER_KEY));
  assert.deepEqual(GEMINI_MODELS, ['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
});

test('handler: a valid x-gemini-key is used with its own client, and x-gemini-model only from the allowlist', async () => {
  const g = byok({ GEMINI_API_KEY: TEAM_KEY });
  let r = await g.from('203.0.113.1', mine({ 'x-gemini-model': ' gemini-3.8-flash ' }));
  assert.equal(r.ok, true);
  assert.equal(r.scene.model, 'gemini-3.8-flash');
  assert.equal(g.reads[0].apiKey, USER_KEY);
  assert.equal(g.reads[0].model, 'gemini-3.8-flash');
  assert.deepEqual(g.reads[0].client, { fake: 'client' });
  r = await g.from('203.0.113.2', mine({ 'x-gemini-model': 'gemini-9-ultra' }));
  assert.equal(r.ok, true);
  assert.equal('model' in g.reads[1], false, 'a model off the list is ignored');
  assert.equal(g.reads[1].apiKey, USER_KEY);
  r = await g.from('203.0.113.3', { 'x-gemini-model': 'gemini-3.8-flash' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(g.reads[2]).sort(), ['base64', 'deadline', 'mimeType'], 'without a key: the team key and model, header ignored');
  assert.deepEqual(g.made, [USER_KEY, USER_KEY], 'one fresh client per request with a key');
});

test('handler: the default client for a visitor key is a real @google/genai client (no call made)', async () => {
  const seen = [];
  const { handler } = deps({ deps: { readArtwork: async (opts) => { seen.push(opts); return { raw: RAW, model: PRIMARY_MODEL }; } } });
  const { body } = await call(handler, { body: { image: JPEG_B64 }, headers: mine() });
  assert.equal(body.ok, true);
  assert.equal(typeof seen[0].client.interactions.create, 'function');
});

test('handler: a malformed x-gemini-key is bad_key with no Gemini call, nothing stored, and counted by neither guard', async () => {
  const g = byok({ INTERPRET_MAX_PER_HOUR: '1' });
  for (const bad of ['too-short', `${USER_KEY} spaces`, 'x'.repeat(201)]) {
    const r = await g.send('203.0.113.1', { 'x-gemini-key': bad });
    assert.deepEqual([r.status, r.body], [200, { ok: false, reason: 'bad_key', scene: null }]);
  }
  assert.equal(g.reads.length + g.made.length + g.blob.puts.length, 0);
  assert.equal((await g.from('203.0.113.1')).ok, true, 'same client, no gap and the one slot still free');
});

test('handler: a visitor key skips the hourly cap and does not use it up; without one the cap holds', async () => {
  const g = byok({ INTERPRET_MAX_PER_HOUR: '1' });
  assert.equal((await g.from('203.0.113.1', mine())).ok, true);
  assert.equal((await g.from('203.0.113.2')).ok, true, 'the key request left the one team slot free');
  assert.equal((await g.from('203.0.113.3')).reason, 'quota');
  assert.equal((await g.from('203.0.113.4', mine())).ok, true, 'past the cap, a visitor key still gets through');
  assert.equal(g.reads.length, 3);
  const zero = byok({ INTERPRET_MAX_PER_HOUR: '0' });
  assert.equal((await zero.from('203.0.113.1', mine())).ok, true);
  assert.equal((await zero.from('203.0.113.2')).reason, 'quota');
});

test('handler: the per-client gap still applies with a visitor key', async () => {
  const g = byok({});
  assert.equal((await g.from('203.0.113.1', mine())).ok, true);
  g.clock.t += MIN_GAP_MS - 1;
  assert.deepEqual(await g.from('203.0.113.1', mine()), { ok: false, reason: 'busy', scene: null });
  assert.equal((await g.from('203.0.113.1')).reason, 'busy', 'and it blocks that client either way');
  g.clock.t += 1;
  assert.equal((await g.from('203.0.113.1', mine())).ok, true);
  assert.equal(g.reads.length, 2);
});

test('handler: the visitor key never reaches a reply or a log line, even when the client or Gemini quotes it', async (t) => {
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) t.mock.method(console, m, (...a) => lines.push(a.map(String).join(' ')));
  const quoting = [
    { geminiClient: async (k) => { throw new Error(`cannot build a client for ${k}`); } },
    { readArtwork: async (o) => { throw Object.assign(new Error(`refused ${o.apiKey}`), { reason: 'auth' }); } },
    { readArtwork: async (o) => { throw new Error(`broke on ${o.apiKey}`); } },
  ];
  const texts = [];
  for (const over of quoting) {
    const g = byok({}, over);
    const r = await g.send('203.0.113.1', mine({ 'x-gemini-model': 'gemini-3.5-flash-lite' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    texts.push(r.res.text, ...g.logs);
  }
  const g = byok({});
  texts.push((await g.send('203.0.113.1', { 'x-gemini-key': `${USER_KEY}!` })).res.text, (await g.send('203.0.113.2', mine())).res.text, ...g.logs);
  assert.ok([...texts, ...lines].every((s) => !s.includes(USER_KEY)), [...texts, ...lines].join('\n'));
});

test('interpret: with a visitor key nothing is stored when Gemini refuses the read (no uncapped image host)', async () => {
  const blob = fakeBlob();
  const refused = async () => { const e = new Error('refused'); e.reason = 'auth'; throw e; };
  const d = deps({ blob, deps: { readArtwork: refused, geminiClient: async () => ({}) } });
  const r = await call(d.handler, { body: { image: JPEG_B64 }, headers: { 'x-gemini-key': 'FAKE_visitor_key_0123456789' } });
  assert.deepEqual([r.status, r.body.ok, r.body.reason], [200, false, 'auth']);
  assert.deepEqual(blob.puts, [], 'no Blob put before a successful read');
  const ok = deps({ blob: fakeBlob(), deps: { geminiClient: async () => ({}) } });
  const good = await call(ok.handler, { body: { image: JPEG_B64 }, headers: { 'x-gemini-key': 'FAKE_visitor_key_0123456789' } });
  assert.equal(good.body.ok, true, 'a successful visitor read still stores the image and scene');
});
