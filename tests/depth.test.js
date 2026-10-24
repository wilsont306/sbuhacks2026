// Tests for api/depth.js (POST /api/depth) with a fake Blob put, and tools/depth.mjs's scene-file helper; no network,
// no model (the tool imports transformers.js only when run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createHandler, parseRequest, MAX_PNG } from '../api/depth.js';
import { withDepthUrl, sampleName, PLANES } from '../tools/depth.mjs';
import { validateScene } from '../src/shared/scene-validate.js';

const ENV = { HOST_TOKEN: 'tok-123' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 200) => Buffer.concat([PNG_SIG, Buffer.alloc(n)]).toString('base64');
const ID = '6f1c2a9e-1111-4222-8333-944455556666';

function fakePut(err) {
  const puts = [];
  return { puts, put: async (p, body, o) => { if (err) throw err; puts.push({ p, body, o }); return { url: `https://x.public.blob.vercel-storage.com/${p}`, pathname: p }; } };
}

// Drive the handler like node:http would: a readable body with a method and headers; res collects the reply.
async function call(handler, { method = 'POST', body, headers = { 'x-host-token': 'tok-123' } } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.headers = headers;
  const out = { status: 200, headers: {}, text: '' };
  const res = {
    headersSent: false,
    set statusCode(v) { out.status = v; }, get statusCode() { return out.status; },
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: (s) => { if (s) out.text += s; res.headersSent = true; },
  };
  await handler(req, res);
  return { ...out, json: out.text ? JSON.parse(out.text) : undefined };
}

const make = (over = {}) => { const b = over.blob || fakePut(); return { b, handler: createHandler({ env: over.env || ENV, put: b.put }) }; };

test('success stores a public PNG at depth/<id>.png with a fixed name and answers its URL', async () => {
  const { b, handler } = make();
  const r = await call(handler, { body: { id: ID, png: png() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { depth_url: `https://x.public.blob.vercel-storage.com/depth/${ID}.png` });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(b.puts.length, 1);
  assert.equal(b.puts[0].p, `depth/${ID}.png`);
  assert.deepEqual(b.puts[0].o, { access: 'public', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true });
  assert.ok(b.puts[0].body.subarray(0, 8).equals(PNG_SIG));
  assert.equal(validateScene({ depth_url: r.json.depth_url }).depth_url, r.json.depth_url, 'the answer passes the scene contract');
});

test('a missing or wrong host token is 401 before the body is read', async () => {
  for (const headers of [{}, { 'x-host-token': 'nope' }, { 'x-host-token': 'tok-1234' }, { 'x-host-token': ['tok-123'] }]) {
    const { b, handler } = make();
    const r = await call(handler, { body: { id: ID, png: png() }, headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(r.json, { error: 'host token' });
    assert.equal(b.puts.length, 0);
  }
  const { b, handler } = make({ env: {} }); // an empty HOST_TOKEN means local, no check (as api/sfx.js)
  assert.equal((await call(handler, { body: { id: ID, png: png() }, headers: {} })).status, 200);
  assert.equal(b.puts.length, 1);
});

test('bad ids, bodies and non-PNGs are 400 {error}; nothing is stored', async () => {
  const { b, handler } = make();
  const bad = [
    { id: '', png: png() }, { id: '../x', png: png() }, { id: 'a'.repeat(65), png: png() }, { id: 'a b', png: png() }, { id: 7, png: png() }, { png: png() },
    { id: ID }, { id: ID, png: '' }, { id: ID, png: 42 }, { id: ID, png: 'not base64!' }, { id: ID, png: 'abcde' },
    { id: ID, png: Buffer.from('GIF89a' + 'x'.repeat(100)).toString('base64') }, { id: ID, png: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]).toString('base64') },
  ];
  for (const body of bad) {
    const r = await call(handler, { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof r.json.error, 'string');
  }
  for (const body of ['{nope', '[]', '"x"', undefined]) assert.equal((await call(handler, { body })).status, 400, String(body));
  assert.equal(parseRequest({ id: ID, png: png() }).id, ID);
  assert.equal(b.puts.length, 0);
});

test('a PNG over 1 MB decoded, or a body over the cap, is 413', async () => {
  const { b, handler } = make();
  const over = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_PNG)]).toString('base64');
  const r = await call(handler, { body: { id: ID, png: over } });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'too large' });
  assert.equal(parseRequest({ id: ID, png: over }).status, 413);
  assert.equal((await call(handler, { body: { id: ID, png: png(MAX_PNG - 8) } })).status, 200, 'exactly 1 MB is allowed');
  assert.equal(b.puts.length, 1);
});

test('a Blob failure is 500 {error:"storage"}; a non-POST is 405', async () => {
  const { handler } = make({ blob: fakePut(new Error('blob down')) });
  const r = await call(handler, { body: { id: ID, png: png() } });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'storage' });
  const g = await call(make().handler, { method: 'GET' });
  assert.equal(g.status, 405);
  assert.equal(g.headers.allow, 'POST');
});

test('tools/depth.mjs: depth_url goes after scene_url once, keeps the layout, and the samples carry theirs unless in PLANES', () => {
  const text = '{\n "id": "sample-x",\n "scene_url": "",\n "model": "hand-corrected"\n}\n';
  const once = withDepthUrl(text, '/samples/x.depth.png');
  assert.equal(once, '{\n "id": "sample-x",\n "scene_url": "",\n "depth_url": "/samples/x.depth.png",\n "model": "hand-corrected"\n}\n');
  assert.equal(withDepthUrl(once, '/samples/x.depth.png'), once, 'idempotent');
  assert.equal(withDepthUrl(once, '/samples/y.depth.png').match(/depth_url/g).length, 1, 'replaced, not added');
  const crlf = text.replace(/\n/g, '\r\n');
  assert.equal(withDepthUrl(crlf, '/d.png'), crlf.replace('"scene_url": "",\r\n', '"scene_url": "",\r\n "depth_url": "/d.png",\r\n'));
  assert.throws(() => withDepthUrl('{"id": "x"}', '/d.png'));
  assert.equal(sampleName('/samples/starry-night.scene.json'), 'starry-night');
  for (const e of JSON.parse(readFileSync(new URL('../public/samples/index.json', import.meta.url), 'utf8'))) {
    const s = JSON.parse(readFileSync(new URL(`../public${e.scene}`, import.meta.url), 'utf8'));
    if (PLANES.includes(sampleName(e.scene))) { assert.equal('depth_url' in s, false, `${e.id} keeps the planes`); continue; }
    assert.equal(s.depth_url, `/samples/${sampleName(e.scene)}.depth.png`, e.id);
    const head = readFileSync(new URL(`../public${s.depth_url}`, import.meta.url)).subarray(0, 26);
    assert.ok(head.subarray(0, 8).equals(PNG_SIG), `${e.id} depth file is a PNG`);
    assert.deepEqual([head.readUInt32BE(16) <= 512, head.readUInt32BE(20) <= 512, head[24], head[25]], [true, true, 8, 0], `${e.id}: at most 512 px, 8-bit grayscale`);
  }
});
