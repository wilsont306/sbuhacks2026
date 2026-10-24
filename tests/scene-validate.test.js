// node:test suite for src/shared/scene-validate.js: Gemini's raw answer (and any garbage) in, the scene contract out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, MOTIONS, LIMITS, FLAT_PATH, validateScene, sceneJsonSchema, hexColour, shoelace } from '../src/shared/scene-validate.js';

const META = {
  id: '6f1c2a9e-1111-4222-8333-944455556666', source: 'phone', image_url: 'https://x.public.blob.vercel-storage.com/art/a.jpg',
  scene_url: 'https://x.public.blob.vercel-storage.com/scenes/a.json', model: 'gemini-3.5-flash-lite', generated_at: '2026-10-24T14:00:00.000Z',
};
const HEX = /^#[0-9a-f]{6}$/;
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000);

// Every field of the contract, with its type and range.
const isAsset = (u) => typeof u === 'string' && u.length <= 300 && /^(https:\/\/|\/(?![/\\]))\S*$/.test(u);
function assertContract(s) {
  const top = ['id', 'source', 'edited', 'credit', 'image_url', 'scene_url', 'model', 'generated_at', 'ai_draft',
    'title_guess', 'artist_guess', 'palette', 'ground_path', 'objects'];
  assert.deepEqual(Object.keys(s), 'depth_url' in s ? [...top, 'depth_url'] : top);
  if ('depth_url' in s) assert.ok(isAsset(s.depth_url));
  for (const k of ['id', 'image_url', 'scene_url', 'model', 'title_guess', 'artist_guess']) assert.equal(typeof s[k], 'string', k);
  assert.ok(['drop', 'phone', 'sample'].includes(s.source));
  assert.equal(typeof s.edited, 'boolean');
  assert.ok(s.credit === null || typeof s.credit === 'string');
  assert.equal(s.ai_draft, true);
  assert.equal(new Date(s.generated_at).toISOString(), s.generated_at);
  assert.ok(Array.isArray(s.palette) && s.palette.length <= 5 && s.palette.every((c) => HEX.test(c)));
  assert.ok(s.ground_path.length >= 2 && s.ground_path.length <= 8 && s.ground_path.every(isPt));
  for (let i = 1; i < s.ground_path.length; i++) assert.ok(s.ground_path[i][0] >= s.ground_path[i - 1][0], 'path sorted by x');
  assert.ok(s.objects.length <= 8);
  for (const o of s.objects) {
    const keys = ['label', 'kind', 'box', 'mask', 'depth', 'colour', 'motion', 'sound_prompt'];
    assert.deepEqual(Object.keys(o), 'model_url' in o ? [...keys, 'model_url'] : keys);
    if ('model_url' in o) assert.ok(isAsset(o.model_url));
    assert.ok(typeof o.label === 'string' && o.label.length >= 1 && o.label.length <= 40);
    assert.ok(KINDS.includes(o.kind));
    assert.ok(o.box.length === 4 && o.box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000));
    assert.ok(o.box[0] < o.box[2] && o.box[1] < o.box[3]);
    assert.ok(o.mask === null || (o.mask.length >= 3 && o.mask.length <= 24 && o.mask.every(isPt)));
    assert.ok(Number.isFinite(o.depth) && o.depth >= 0 && o.depth <= 1);
    assert.match(o.colour, HEX);
    assert.ok(MOTIONS.includes(o.motion));
    assert.ok(typeof o.sound_prompt === 'string' && o.sound_prompt.split(' ').filter(Boolean).length <= 12);
  }
}

const cypress = {
  label: 'cypress tree', kind: 'plant', box_2d: [100, 50, 900, 250], depth: 0.2, colour: '#1F3A2B', motion: 'sway',
  sound_prompt: 'wind rustling through dense evergreen branches',
  mask: [[500, 0], [1000, 1000], [0, 1000]],
};
const RAW = {
  title_guess: 'The Starry Night', artist_guess: 'Vincent van Gogh', palette: ['#1b2a6b', '#F2C94C', 'nope', '#abc'],
  ground_path: [[1000, 820], [0, 870], [500, 840]],
  objects: [cypress, { label: 'moon', kind: 'celestial', box_2d: [50, 800, 150, 900], depth: 1, colour: '#ffe680', motion: 'twinkle', sound_prompt: 'soft chime' }],
};

test('exports the enums and limits of the contract', () => {
  assert.deepEqual(KINDS, ['sky', 'cloud', 'celestial', 'water', 'ground', 'plant', 'building', 'vehicle', 'animal', 'person', 'fire', 'object']);
  assert.deepEqual(MOTIONS, ['none', 'sway', 'drift', 'bob', 'spin', 'fly', 'flicker', 'twinkle']);
  assert.equal(LIMITS.objects, 8);
  assert.equal(LIMITS.maskPoints, 24);
});

test('a well-formed Gemini answer becomes the contract, meta applied', () => {
  const s = validateScene(RAW, META);
  assertContract(s);
  assert.equal(s.id, META.id);
  assert.equal(s.source, 'phone');
  assert.equal(s.edited, false);
  assert.equal(s.credit, null);
  assert.equal(s.model, 'gemini-3.5-flash-lite');
  assert.equal(s.generated_at, META.generated_at);
  assert.equal(s.title_guess, 'The Starry Night');
  assert.deepEqual(s.palette, ['#1b2a6b', '#f2c94c', '#aabbcc']);
  assert.deepEqual(s.ground_path, [[0, 870], [500, 840], [1000, 820]]);
  assert.equal(s.objects.length, 2);
  const [c] = s.objects;
  assert.deepEqual(c.box, [50, 100, 250, 900], 'box_2d [ymin,xmin,ymax,xmax] -> box [x0,y0,x1,y1]');
  assert.equal(c.colour, '#1f3a2b');
  assert.equal(c.motion, 'sway');
  assert.equal(c.depth, 0.2);
});

test('box-relative masks (the default frame) convert to image space', () => {
  const [c] = validateScene(RAW, META).objects;
  // X = x0 + x * (x1 - x0) / 1000, Y = y0 + y * (y1 - y0) / 1000 with box [50, 100, 250, 900]
  assert.deepEqual(c.mask, [[150, 100], [250, 900], [50, 900]]);
  const [img] = validateScene(RAW, META, { maskFrame: 'image' }).objects;
  assert.deepEqual(img.mask, [[500, 0], [1000, 1000], [0, 1000]], 'image frame keeps the points');
  const [bogus] = validateScene(RAW, META, { maskFrame: 'sideways' }).objects;
  assert.deepEqual(bogus.mask, c.mask, 'an unknown frame falls back to box');
});

test('degenerate masks become null and the object keeps its box', () => {
  const masks = {
    'two points': [[0, 0], [1000, 1000]],
    'a NaN point': [[0, 0], [1000, 'x'], [0, 1000]],
    'a short point': [[0, 0], [1000], [0, 1000]],
    collinear: [[0, 0], [500, 500], [1000, 1000]],
    'a sliver': [[0, 0], [1000, 0], [1000, 5]],
    'not an array': 'polygon',
    missing: undefined,
  };
  for (const [name, mask] of Object.entries(masks)) {
    const s = validateScene({ objects: [{ ...cypress, mask }] }, META);
    assert.equal(s.objects.length, 1, name);
    assert.equal(s.objects[0].mask, null, name);
    assert.deepEqual(s.objects[0].box, [50, 100, 250, 900], name);
  }
});

test('long masks are thinned to 24 points, keeping the first and last', () => {
  const ring = Array.from({ length: 100 }, (_, k) => [500 + 400 * Math.cos(k / 50 * Math.PI), 500 + 400 * Math.sin(k / 50 * Math.PI)]);
  const [o] = validateScene({ objects: [{ ...cypress, mask: ring }] }, META, { maskFrame: 'image' }).objects;
  assert.equal(o.mask.length, 24);
  assert.deepEqual(o.mask[0], [900, 500]);
  assert.deepEqual(o.mask[23], ring[99].map(Math.round));
  assert.ok(Math.abs(shoelace(o.mask)) > 400000, 'still an outline');
});

test('a mask in the image frame with no box gives the box', () => {
  const [o] = validateScene({ objects: [{ label: 'hill', kind: 'ground', mask: [[100, 600], [900, 600], [900, 900], [100, 900]] }] }, META, { maskFrame: 'image' }).objects;
  assert.deepEqual(o.box, [100, 600, 900, 900]);
  assert.equal(o.depth, 0.1, 'default depth 1 - y1/1000');
});

test('unknown kind and motion are coerced; case and spacing are forgiven', () => {
  const [a, b] = validateScene({ objects: [
    { ...cypress, kind: 'tree', motion: 'dance' },
    { ...cypress, kind: ' Plant ', motion: 'FLY' },
  ] }, META).objects;
  assert.equal(a.kind, 'object');
  assert.equal(a.motion, 'none');
  assert.equal(b.kind, 'plant');
  assert.equal(b.motion, 'fly');
});

test('depth: clamped, numeric strings read, missing -> 1 - y1/1000', () => {
  const depths = validateScene({ objects: [
    { ...cypress, depth: 5 }, { ...cypress, depth: -1 }, { ...cypress, depth: '0.35' }, { ...cypress, depth: undefined },
    { ...cypress, depth: 'deep' }, { ...cypress, depth: NaN },
  ] }, META).objects.map((o) => o.depth);
  assert.deepEqual(depths, [1, 0, 0.35, 0.1, 0.1, 0.1]);
});

test('numbers are clamped to 0..1000 and reversed boxes are put right', () => {
  const [o] = validateScene({ objects: [{ ...cypress, box_2d: [1200, 900, -50, 100], mask: null }] }, META).objects;
  assert.deepEqual(o.box, [100, 0, 900, 1000]);
});

test('objects with no usable box are dropped; at most 8 are kept', () => {
  const bad = [{ ...cypress, box_2d: [1, 2, 3] }, { ...cypress, box_2d: [0, 0, 0, 500] }, { ...cypress, box_2d: [0, 'a', 10, 10] }, null, 'tree', 7];
  assert.equal(validateScene({ objects: bad }, META).objects.length, 0);
  const many = Array.from({ length: 20 }, (_, k) => ({ ...cypress, label: `thing ${k}` }));
  const s = validateScene({ objects: [...bad, ...many] }, META);
  assert.equal(s.objects.length, 8);
  assert.equal(s.objects[0].label, 'thing 0', 'Gemini order kept');
});

test('labels, colours and sound prompts are cleaned', () => {
  const [o] = validateScene({ palette: ['#123456'], objects: [{
    ...cypress, label: '  a\u0000very\n\tlong label that keeps going and going past forty characters ', colour: 'green',
    sound_prompt: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
  }] }, META).objects;
  assert.ok(o.label.length <= 40);
  assert.ok(o.label.startsWith('a very long label'));
  assert.equal(o.colour, '#123456', 'falls back to the palette');
  assert.equal(o.sound_prompt.split(' ').length, 12);
  const [p] = validateScene({ objects: [{ ...cypress, label: '   ', colour: undefined, color: '#ABCDEF' }] }, META).objects;
  assert.equal(p.label, 'plant', 'an empty label becomes the kind');
  assert.equal(p.colour, '#abcdef', 'US spelling accepted');
  const [q] = validateScene({ objects: [{ ...cypress, colour: 42 }] }, META).objects;
  assert.equal(q.colour, '#808080');
});

// Both asset fields share one rule: https or site-relative, at most 300 characters, no whitespace.
const ASSET_BAD = ['http://example.com/a.glb', 'javascript:alert(1)', 'data:model/gltf-binary;base64,AAAA', 'blob:https://x/1', '//evil.example/a.glb',
  '/\\evil.example/a.glb', 'models/a.glb', 'https://', 'https://exa mple.com/a.glb', ' https://example.com/a.glb', '/a b.png', '/a\tb.png', '', 42, null, {}];

test('model_url: kept only as an https URL or a site-relative path of at most 300 characters', () => {
  for (const url of ['https://example.com/models/cypress.glb', '/models/cypress.glb', 'https://x.public.blob.vercel-storage.com/tripo/abc.glb']) {
    const [o] = validateScene({ objects: [{ ...cypress, model_url: url }] }, META).objects;
    assertContract({ ...validateScene({}, META), objects: [o] });
    assert.equal(o.model_url, url);
    assert.deepEqual(validateScene(JSON.parse(JSON.stringify(validateScene({ objects: [o] }, META))), {}).objects[0], o, 'a stored model_url re-validates to itself');
  }
  const long = 'https://example.com/' + 'a'.repeat(281);
  for (const bad of [...ASSET_BAD, long]) {
    const [p] = validateScene({ objects: [{ ...cypress, model_url: bad }] }, META).objects;
    assert.equal('model_url' in p, false, String(bad).slice(0, 40));
  }
  assert.equal(long.length, 301);
  assert.equal(validateScene({ objects: [{ ...cypress, model_url: long.slice(0, 300) }] }, META).objects[0].model_url.length, 300);
});

test('depth_url: a top-level asset URL, kept by the same rule, last in the scene, never asked of Gemini', () => {
  for (const url of ['/samples/turner.depth.png', 'https://x.public.blob.vercel-storage.com/depth/6f1c.png']) {
    const s = validateScene({ ...RAW, depth_url: url }, META);
    assertContract(s);
    assert.equal(s.depth_url, url);
    assert.deepEqual(validateScene(JSON.parse(JSON.stringify(s)), {}), s, 'a stored depth_url re-validates to itself');
  }
  for (const bad of [...ASSET_BAD, '/' + 'a'.repeat(300)]) assert.equal('depth_url' in validateScene({ ...RAW, depth_url: bad }, META), false, String(bad).slice(0, 40));
  assert.equal('depth_url' in validateScene(RAW, META), false);
  assert.equal(validateScene({ ...RAW, depth_url: '/' + 'a'.repeat(299) }, META).depth_url.length, 300);
  assert.ok(!JSON.stringify(sceneJsonSchema).includes('depth_url') && !JSON.stringify(sceneJsonSchema).includes('model_url'));
});

test('hexColour', () => {
  assert.equal(hexColour('#ABC'), '#aabbcc');
  assert.equal(hexColour('a1b2c3'), '#a1b2c3');
  assert.equal(hexColour('#a1b2c3ff'), '#a1b2c3');
  for (const v of ['#abcd', 'red', '', null, 12, '#ggg000']) assert.equal(hexColour(v), null);
});

test('palette: valid colours only, deduplicated, at most 5', () => {
  const s = validateScene({ palette: ['#111111', '#111', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', 'x'] }, META);
  assert.deepEqual(s.palette, ['#111111', '#222222', '#333333', '#444444', '#555555']);
});

test('ground_path: missing or short -> flat at y 850; NaN dropped, clamped, sorted, capped at 8', () => {
  const flat = FLAT_PATH.map((p) => [...p]);
  for (const ground_path of [undefined, [], [[10, 10]], 'path', [[0, 800], [40, 820]], [[NaN, 1], [5, NaN]]]) {
    assert.deepEqual(validateScene({ ground_path }, META).ground_path, flat, JSON.stringify(ground_path));
  }
  const s = validateScene({ ground_path: [[900, 2000], ['x', 5], [-30, 700], { x: 400, y: 760 }, [600, 'nan']] }, META);
  assert.deepEqual(s.ground_path, [[0, 700], [400, 760], [900, 1000]]);
  const long = Array.from({ length: 30 }, (_, k) => [1000 - k * 30, 800 + k]);
  const p = validateScene({ ground_path: long }, META).ground_path;
  assert.equal(p.length, 8);
  assert.deepEqual(p[0], [130, 829]);
  assert.deepEqual(p[7], [1000, 800]);
});

test('meta wins, raw fills gaps, bad meta values fall back', () => {
  const s = validateScene({ id: 'raw-id', source: 'sample', edited: true, credit: 'Courtesy of the artist', model: 'm', generated_at: '2026-10-24T01:02:03Z' }, {});
  assert.equal(s.id, 'raw-id');
  assert.equal(s.source, 'sample');
  assert.equal(s.edited, true);
  assert.equal(s.credit, 'Courtesy of the artist');
  assert.equal(s.generated_at, '2026-10-24T01:02:03.000Z');
  const t = validateScene({ source: 'sample' }, { source: 'telegram', edited: 'yes', generated_at: 'last tuesday', model: '' });
  assert.equal(t.source, 'drop');
  assert.equal(t.edited, false);
  assert.equal(t.model, 'unknown');
  assert.ok(Math.abs(Date.parse(t.generated_at) - Date.now()) < 5000, 'invalid time -> now');
  assert.equal(validateScene({}, { ...META, source: 'sample' }).source, 'sample');
});

test('title and artist guesses default to unknown', () => {
  const s = validateScene({ title_guess: '   ', artist_guess: 7 }, META);
  assert.equal(s.title_guess, 'unknown');
  assert.equal(s.artist_guess, 'unknown');
});

test('a JSON string is parsed; a stored scene re-validates to itself', () => {
  const once = validateScene(JSON.stringify(RAW), META);
  assert.deepEqual(once, validateScene(RAW, META));
  const twice = validateScene(JSON.parse(JSON.stringify(once)), {});
  assert.deepEqual(twice, once, 'box and image-space mask are kept as they are');
  assert.deepEqual(validateScene(once, {}, { maskFrame: 'box' }), once, 'the frame option applies only to box_2d objects');
});

test('garbage in -> a valid, walkable, empty scene; never throws', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  const getterBomb = { get objects() { throw new Error('boom'); }, title_guess: 'x' };
  for (const raw of [null, undefined, 0, 42, true, 'not json', '[1,2]', [], [RAW], { objects: 'x' }, { objects: [[1, 2, 3]] }, hostile, getterBomb, () => 1]) {
    const s = validateScene(raw, META);
    assertContract(s);
    assert.equal(s.objects.length, 0);
    assert.deepEqual(s.ground_path, [[0, 850], [1000, 850]]);
    assert.equal(s.id, META.id);
  }
  for (const meta of [null, 'meta', hostile, []]) assertContract(validateScene(RAW, meta));
  assertContract(validateScene());
});

test('fuzz: random structures always come out as the contract', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const junk = (depth) => {
    const r = rnd();
    if (depth > 3 || r < 0.15) return [NaN, Infinity, -1e9, 1e9, 500, '400', '', 'sky', '#fff', null, undefined, true][Math.floor(rnd() * 12)];
    if (r < 0.5) return Array.from({ length: Math.floor(rnd() * 30) }, () => junk(depth + 1));
    const o = {};
    for (const k of ['label', 'kind', 'box_2d', 'box', 'mask', 'depth', 'colour', 'motion', 'sound_prompt', 'objects', 'ground_path', 'palette']) if (rnd() < 0.5) o[k] = junk(depth + 1);
    return o;
  };
  for (let i = 0; i < 400; i++) {
    const raw = { objects: Array.from({ length: Math.floor(rnd() * 12) }, () => ({ ...junk(1), box_2d: rnd() < 0.7 ? [rnd() * 1200 - 100, rnd() * 1000, rnd() * 1000, rnd() * 1200 - 100] : junk(2), mask: junk(1) })), ground_path: junk(1), palette: junk(1) };
    assertContract(validateScene(raw, META, { maskFrame: rnd() < 0.5 ? 'box' : 'image' }));
  }
});

test('sceneJsonSchema is flat, small and in step with the enums and limits', () => {
  const s = sceneJsonSchema;
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required, ['title_guess', 'artist_guess', 'palette', 'ground_path', 'objects']);
  const item = s.properties.objects.items;
  assert.deepEqual(item.properties.kind.enum, KINDS);
  assert.deepEqual(item.properties.motion.enum, MOTIONS);
  assert.equal(s.properties.objects.maxItems, 8);
  assert.equal(item.properties.mask.maxItems, 24);
  assert.equal(s.properties.ground_path.maxItems, 8);
  assert.equal(s.properties.palette.maxItems, 5);
  // Exact lengths: a box is four numbers and every point is two, so Gemini cannot answer short or long tuples.
  assert.deepEqual([item.properties.box_2d.minItems, item.properties.box_2d.maxItems], [4, 4]);
  for (const pt of [item.properties.mask.items, s.properties.ground_path.items]) {
    assert.deepEqual([pt.type, pt.minItems, pt.maxItems, pt.items.type], ['array', 2, 2, 'integer']);
  }
  const depth =(node) => (node && typeof node === 'object' ? 1 + Math.max(0, ...Object.values(node).map(depth)) : 0);
  assert.ok(depth(s) <= 9, `schema nesting ${depth(s)}`);
  assert.ok(JSON.stringify(s).length < 2500, 'schema stays small');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
});
