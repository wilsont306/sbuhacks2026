// node:test suite for src/host/models3d.js: which objects get a Tripo model, the cache key, the crop geometry, the
// polling state machine, and one run per scene against fake fetch, canvas and game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as m from '../src/host/models3d.js';
import { validateScene } from '../src/shared/scene-validate.js';

const obj = (label, kind, box, mask = null) => ({ label, kind, box, mask });
const scene = (objects, image_url = '/assets/a.jpg') => ({ image_url, objects });

test('pickHeroes: standing kinds only, subjects before buildings, then largest mask or box area, at most MODELS_PER_SCENE', () => {
  assert.equal(m.MODELS_PER_SCENE, 2);
  const s = scene([
    obj('sky', 'sky', [0, 0, 1000, 400]), obj('field', 'ground', [0, 500, 1000, 1000]), obj('river', 'water', [0, 600, 1000, 900]),
    obj('cloud', 'cloud', [0, 0, 500, 200]), obj('sun', 'celestial', [0, 0, 300, 300]),
    obj('hut', 'building', [100, 300, 300, 600]),                                        // box 200 x 300 = 60000
    obj('man', 'person', [400, 200, 800, 700], [[400, 700], [800, 700], [600, 200]]),    // box 200000, mask 100000
    obj('cart', 'vehicle', [500, 500, 600, 600]),                                         // 10000, the smallest kept
    obj('bird', 'animal', [0, 0, 99, 100]),                                               // 9900: too few pixels
  ]);
  assert.deepEqual(m.pickHeroes(s).map((h) => [h.index, h.obj.label]), [[6, 'man'], [7, 'cart']]);
  assert.deepEqual(m.pickHeroes(s, 5).map((h) => h.obj.label), ['man', 'cart', 'hut']);
  assert.deepEqual(m.pickHeroes(s, 0), []);
});

test('pickHeroes: ties keep scene order; nothing for no scene, a data:/blob: picture or bad objects', () => {
  const s = scene([obj('a', 'object', [0, 0, 100, 100]), obj('b', 'plant', [200, 0, 300, 100]), obj('c', 'plant', [0, 0, 0, 0]), null]);
  assert.deepEqual(m.pickHeroes(s).map((h) => h.obj.label), ['a', 'b']);
  for (const u of ['data:image/jpeg;base64,AAAA', 'blob:http://localhost/x', '', '//evil.example/a.jpg', '/\\x', undefined])
    assert.deepEqual(m.pickHeroes({ ...s, image_url: u }), [], String(u));
  for (const bad of [null, undefined, 'x', { image_url: '/a.jpg' }, { image_url: '/a.jpg', objects: 'no' }]) assert.deepEqual(m.pickHeroes(bad), []);
  assert.equal(m.pickHeroes(scene([obj('a', 'object', [0, 0, 200, 200])], 'https://x.public.blob.vercel-storage.com/art/1.jpg')).length, 1);
});

test('pickHeroes: the bundled samples give standing heroes, the subject first', () => {
  const first = { turner: 'Steam locomotive', sketch: 'Tree', 'starry-night': 'Cypress' }; // the sketch's dog outline is under MIN_AREA
  for (const f of Object.keys(first)) {
    const s = validateScene(JSON.parse(readFileSync(new URL(`../public/samples/${f}.scene.json`, import.meta.url), 'utf8')));
    const heroes = m.pickHeroes(s);
    assert.ok(heroes.length >= 1 && heroes.length <= 2, f);
    assert.equal(heroes[0].obj.label, first[f], f);
    for (const h of heroes) assert.ok(!['sky', 'cloud', 'celestial', 'ground', 'water'].includes(h.obj.kind), `${f}: ${h.obj.kind}`);
  }
});

test('cacheKeyText and sha1hex: picture | label | JSON of the mask, else the box', async () => {
  const mask = [[1, 2], [3, 4], [5, 6]];
  assert.equal(m.cacheKeyText({ image_url: '/a.jpg' }, obj('hut', 'building', [1, 2, 3, 4], mask)), '/a.jpg|hut|[[1,2],[3,4],[5,6]]');
  assert.equal(m.cacheKeyText({ image_url: '/a.jpg' }, obj('hut', 'building', [1, 2, 3, 4])), '/a.jpg|hut|[1,2,3,4]');
  const text = '/a.jpg|hut|[1,2,3,4]', key = await m.sha1hex(text);
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(key, createHash('sha1').update(text).digest('hex'));
});

test('cropRect: the box padded 8 percent of its size, clamped to the picture, long side at most 1024', () => {
  // 200 x 100 units of a 2000 x 1000 picture, padded 16 x 8 units: [184, 392, 416, 508] units
  assert.deepEqual(m.cropRect([200, 400, 400, 500], 2000, 1000), { sx: 368, sy: 392, sw: 464, sh: 116, s: 1, w: 464, h: 116 });
  const big = m.cropRect([0, 0, 1000, 1000], 4000, 3000); // padding falls off the edges; 4000 px scaled to 1024
  assert.deepEqual([big.sx, big.sy, big.sw, big.sh, big.w, big.h], [0, 0, 4000, 3000, 1024, 768]);
  assert.equal(big.s, 1024 / 4000);
  for (const [b, w, h] of [[[0, 0, 0, 10], 100, 100], [[5, 5, 1, 1], 100, 100], [null, 100, 100], [[0, 0, 10, 10], 0, 100]]) assert.equal(m.cropRect(b, w, h), null);
});

test('cropPath: image-space outline points land in crop pixels', () => {
  const r = m.cropRect([200, 400, 400, 500], 2000, 1000);
  assert.deepEqual(m.cropPath([[200, 400], [400, 500]], r, 2000, 1000), [[32, 8], [432, 108]]);
  const big = m.cropRect([0, 0, 1000, 1000], 4000, 3000);
  assert.deepEqual(m.cropPath([[1000, 1000]], big, 4000, 3000), [[1024, 768]]);
});

test('step: success ends, queued and running poll every 4 s, busy waits Retry-After, the rest stop', () => {
  assert.deepEqual(m.step({ status: 'success', model_url: 'https://b/tripo/k.glb' }, 't1'), { url: 'https://b/tripo/k.glb' });
  assert.deepEqual(m.step({ status: 'success' }, 't1'), { end: 'failed' });
  assert.deepEqual(m.step({ status: 'queued', task: 'abc-123' }, ''), { task: 'abc-123', wait: 4000 });
  assert.deepEqual(m.step({ status: 'running', progress: 40 }, 'abc-123'), { task: 'abc-123', wait: 4000 });
  assert.deepEqual(m.step({ status: 'queued', task: 'bad id!' }, ''), { end: 'failed' });
  assert.deepEqual(m.step({ status: 'busy', retry_after: 9 }, ''), { task: '', wait: 9000 });
  assert.deepEqual(m.step({ status: 'busy', retry_after: 1 }, 't'), { task: 't', wait: 4000 });
  assert.deepEqual(m.step({ status: 'busy', retry_after: 1e9 }, 't'), { task: 't', wait: 60000 });
  for (const s of ['off', 'capped', 'no_credits', 'failed', 'http']) assert.deepEqual(m.step({ status: s, reason: 'x' }, 't'), { end: s });
  for (const r of [null, {}, { status: 3 }]) assert.deepEqual(m.step(r, 't'), { end: 'failed' });
});

// ---- one scene's run, with fake browser parts ----
const PNG_B64 = 'iVBORw0KGgo=';
function fakes(answers) {
  const calls = [], set = [], flashes = [];
  globalThis.Image = class { set src(v) { this.naturalWidth = 1000; this.naturalHeight = 800; queueMicrotask(() => this.onload()); } };
  globalThis.document = { createElement: () => ({ getContext: () => ({ beginPath() {}, lineTo() {}, closePath() {}, clip() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,' + PNG_B64 }) };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const a = answers.shift();
    return { ok: a.http === undefined, status: a.http || 200, json: async () => a };
  };
  let current = null;
  const game = {
    scene: () => current,
    setObjectModel: (i, url) => { set.push([i, url]); current = { ...current, objects: current.objects.map((o, k) => (k === i ? { ...o, model_url: url } : o)) }; return true; },
  };
  m.init({ game, token: 'tok', margins: { flash: (t) => flashes.push(t) } });
  const play = (s, isCurrent = () => true) => { current = s; m.onScene(s, isCurrent); };
  return { calls, set, flashes, play };
}
// Up to 5 s, not a tick count: crypto.subtle runs on libuv's pool, which the full parallel suite can hold up past 50 ticks.
const settle = async () => { for (const end = Date.now() + 5000; m.stats().running && Date.now() < end;) await new Promise((ok) => setImmediate(ok)); };
const TWO = scene([obj('hut', 'building', [100, 300, 300, 600]), obj('man', 'person', [400, 200, 800, 700]), obj('sky', 'sky', [0, 0, 1000, 300])]);

test('run: a cached model lands at once with its flash; capped stops the scene quietly', async () => {
  const f = fakes([{ status: 'success', model_url: 'https://b/tripo/1.glb' }, { status: 'capped' }]);
  f.play(TWO);
  await settle();
  assert.equal(f.calls.length, 2, 'one POST per hero');
  const [first] = f.calls;
  assert.equal(first.url, '/api/tripo');
  assert.equal(first.method, 'POST');
  assert.equal(first.headers['x-host-token'], 'tok');
  assert.equal(first.body.png, PNG_B64);
  assert.equal(first.body.key, createHash('sha1').update(m.cacheKeyText(TWO, TWO.objects[1])).digest('hex'), 'man is the larger');
  assert.deepEqual(f.set, [[1, 'https://b/tripo/1.glb']]);
  assert.deepEqual(f.flashes, ['Tripo · man · 3D model ready']);
  assert.deepEqual(m.stats(), { on: true, ready: 1, running: 0, failed: 1, last: 'capped' });
});

test('run: a scene that left gets nothing; data: pictures and no-key servers ask nothing more', async () => {
  let live = true;
  const f = fakes([{ status: 'success', model_url: 'https://b/tripo/1.glb' }]);
  const gone = { ...TWO };
  f.play(gone, () => live);
  live = false;
  await settle();
  assert.deepEqual(f.set, []);

  const g = fakes([]);
  g.play({ ...TWO, image_url: 'data:image/jpeg;base64,AAAA' });
  await settle();
  assert.equal(g.calls.length, 0);
  assert.equal(m.stats().running, 0);

  const h = fakes([{ status: 'off' }]);
  h.play(TWO);
  await settle();
  assert.equal(h.calls.length, 1, 'off stops the second hero too');
  assert.deepEqual(m.stats(), { on: true, ready: 0, running: 0, failed: 1, last: 'off' });

  const k = fakes([{ http: 404 }]);
  k.play(TWO);
  await settle();
  assert.equal(k.calls.length, 1, 'no API here (the laptop hub)');
  assert.equal(m.stats().last, 'http');

  const big = fakes([{ http: 413 }, { status: 'success', model_url: 'https://b/tripo/2.glb' }]);
  big.play(TWO);
  await settle();
  assert.deepEqual(big.set, [[0, 'https://b/tripo/2.glb']], 'a crop over 3 MB costs only its own object');
  assert.deepEqual(m.stats(), { on: true, ready: 1, running: 0, failed: 1, last: 'success' });
});

test('D: off asks nothing and the line reads off; on again runs the scene on stage', async () => {
  const f = fakes([{ status: 'success', model_url: 'https://b/tripo/1.glb' }, { status: 'success', model_url: 'https://b/tripo/2.glb' }]);
  assert.equal(m.setOn(false), false);
  f.play(TWO);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(m.stats().on, false);
  assert.equal(m.setOn(true), true);
  await settle();
  assert.deepEqual(f.set, [[1, 'https://b/tripo/1.glb'], [0, 'https://b/tripo/2.glb']]);
  assert.deepEqual(f.flashes, ['3D models off (D turns them back on)', '3D models on', 'Tripo · man · 3D model ready', 'Tripo · hut · 3D model ready']);
  assert.deepEqual(m.stats(), { on: true, ready: 2, running: 0, failed: 0, last: 'success' });
});
