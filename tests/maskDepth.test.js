// src/host/maskDepth.js: scene JSON to the relief's depth map, path points and per-object hotspots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneDepth, pathPoints, objectHotspots, objectIdMap } from '../src/host/maskDepth.js';
import { depthAt, sampler } from '../src/host/depth.js';
import { MIN_T, HOTSPOT_HALF_WIDTH } from '../src/shared/protocol.js';

// The value of the pixel holding image-space point (x, y) (y top-down), through depth.js's bottom-up row layout.
const px = (d, x, y) => {
  const i = Math.min(d.w - 1, Math.floor(x / 1000 * d.w)), j = Math.min(d.h - 1, Math.floor((1 - y / 1000) * d.h));
  return d.data[j * d.w + i];
};
const sharp = (scene) => sceneDepth(scene, { blurRadius: 0 });
const obj = (o) => ({ label: 'thing', kind: 'object', mask: null, colour: '#888888', motion: 'none', sound_prompt: '', ...o });
const inUnit = (d) => d.data.every((x) => Number.isFinite(x) && x >= 0 && x <= 1);
const EPS = 1e-9;

test('empty scene is the prototype gradient: far sky at the top, ground nearing at the bottom', () => {
  const d = sharp({ objects: [] });
  assert.equal(d.w, 256); assert.equal(d.h, 192); assert.equal(d.data.length, 256 * 192); assert.equal(d.placeholder, false);
  // away from the Turner features, depthAt is the same sky and ground
  for (const [u, v] of [[0.05, 0.95], [0.3, 0.8], [0.1, 0.2], [0.3, 0.05]]) {
    const i = Math.floor(u * 256), j = Math.floor(v * 192);
    assert.ok(Math.abs(d.data[j * 256 + i] - depthAt((i + 0.5) / 256, (j + 0.5) / 192)) < 1e-6, `${u},${v}`);
  }
  assert.ok(px(d, 500, 980) > 0.8 && px(d, 500, 30) < 0.12);
});

test('a near box lifts its pixels above the far sky and above the ground it covers', () => {
  const base = sharp({ objects: [] }), d = sharp({ objects: [obj({ box: [400, 500, 600, 900], depth: 0.1 })] });
  assert.ok(Math.abs(px(d, 500, 700) - 0.9) < 1e-6);
  assert.ok(px(d, 500, 700) > px(d, 500, 100) + 0.5);
  assert.ok(px(d, 500, 700) > px(base, 500, 700) + 0.3);
  assert.equal(px(d, 200, 700), px(base, 200, 700)); // outside the box: untouched
});

test('mask fill follows the outline; a null mask fills the whole box', () => {
  const box = [100, 100, 900, 900], tri = [[100, 100], [900, 100], [100, 900]]; // the upper-left half of the box
  const base = sharp({ objects: [] });
  const m = sharp({ objects: [obj({ box, mask: tri, depth: 0 })] }), b = sharp({ objects: [obj({ box, depth: 0 })] });
  assert.equal(px(m, 200, 200), 1); assert.equal(px(b, 200, 200), 1);
  assert.equal(px(m, 800, 800), px(base, 800, 800)); // outside the triangle, inside the box
  assert.equal(px(b, 800, 800), 1);
});

test('concave and self-touching masks fill by even-odd without throwing', () => {
  const base = sharp({ objects: [] });
  const U = [[100, 100], [300, 100], [300, 700], [700, 700], [700, 100], [900, 100], [900, 900], [100, 900]]; // opens upward
  const u = sharp({ objects: [obj({ box: [100, 100, 900, 900], mask: U, depth: 0 })] });
  assert.equal(px(u, 200, 300), 1); assert.equal(px(u, 800, 300), 1); assert.equal(px(u, 500, 800), 1);
  assert.equal(px(u, 500, 300), px(base, 500, 300)); // the notch
  // two triangles meeting at one vertex, traced as one loop
  const touch = [[100, 100], [500, 500], [900, 100], [900, 900], [500, 500], [100, 900]];
  const t = sharp({ objects: [obj({ box: [100, 100, 900, 900], mask: touch, depth: 0 })] });
  assert.equal(px(t, 150, 500), 1); assert.equal(px(t, 850, 500), 1);
  assert.equal(px(t, 500, 200), px(base, 500, 200)); assert.equal(px(t, 500, 800), px(base, 500, 800));
  // a bowtie cancels to zero area and falls back to its box; collinear points too
  const bow = sharp({ objects: [obj({ box: [100, 100, 900, 900], mask: [[100, 100], [900, 900], [900, 100], [100, 900]], depth: 0 })] });
  assert.equal(px(bow, 500, 200), 1);
  assert.doesNotThrow(() => sharp({ objects: [obj({ box: [100, 100, 300, 300], mask: [[0, 0], [500, 500], [1000, 1000]], depth: 0.2 })] }));
});

test('row orientation: an object at the image top lands in the high rows', () => {
  const d = sharp({ objects: [obj({ box: [0, 0, 1000, 100], depth: 0 })] }), mid = d.w / 2;
  assert.equal(d.data[(d.h - 1) * d.w + mid], 1);
  assert.equal(d.data[Math.floor(0.95 * d.h) * d.w + mid], 1);
  assert.ok(d.data[mid] < 1 && d.data[Math.floor(0.5 * d.h) * d.w + mid] < 1);
});

test('nearer objects win where they overlap, whatever the list order', () => {
  const near = obj({ box: [300, 300, 700, 700], depth: 0.2 }), far = obj({ box: [100, 100, 900, 900], depth: 0.7 });
  for (const objects of [[near, far], [far, near]]) {
    const d = sharp({ objects });
    assert.ok(Math.abs(px(d, 500, 500) - 0.8) < 1e-6);
    assert.ok(Math.abs(px(d, 150, 500) - 0.3) < 1e-6);
  }
});

test('missing depth defaults to the box foot; ground keeps part of its gradient', () => {
  const d = sharp({ objects: [obj({ box: [400, 400, 600, 800], depth: undefined })] });
  assert.ok(Math.abs(px(d, 500, 600) - 0.8) < 1e-6); // depth 1 - 800/1000, near 0.8
  const g = sharp({ objects: [obj({ kind: 'ground', box: [0, 500, 1000, 1000], depth: 0.4 })] });
  assert.ok(px(g, 500, 950) > px(g, 500, 550) + 0.2, 'a ground object is not a flat card');
});

test('blur keeps values in 0..1 and softens edges', () => {
  const scene = { objects: [obj({ box: [0, 0, 1000, 1000], depth: 1 }), obj({ box: [400, 400, 600, 600], depth: 0 }), obj({ box: [0, 900, 50, 1000], depth: 0 })] };
  for (const blurRadius of [1, 3, 8, 32]) {
    const d = sceneDepth(scene, { blurRadius });
    assert.ok(inUnit(d), `r ${blurRadius}`);
  }
  const d = sceneDepth(scene, { blurRadius: 3 }), edge = px(d, 400, 500);
  assert.ok(edge > 0.05 && edge < 0.95, 'the box edge is a ramp, not a cliff');
  assert.ok(px(d, 500, 500) > 0.9);
});

test('garbage scenes and options still return a full map', () => {
  const junk = [null, undefined, 'x', 42, [], { objects: 'nope' }, { objects: [null, 1, 'a', [], { box: [NaN, 0, 1, 1] },
    { mask: [[NaN, NaN]], box: [1, 2] }, { depth: NaN, box: [100, 100, 200, 200] }, { depth: Infinity, mask: [[0, 0], [0, 0], [0, 0]] },
    { box: [1e308, -1e308, 5, 5], mask: [[1e308, 0], [0, -1e308], [Infinity, 1]], depth: -3 }, { box: [500, 500, 500, 500], depth: 0 }] }];
  for (const scene of junk) for (const opts of [undefined, null, 'x', { w: NaN, h: -5, blurRadius: 'x' }, { w: 1e9, h: 3.7, blurRadius: 1e9 }]) {
    const d = sceneDepth(scene, opts);
    assert.ok(Number.isInteger(d.w) && Number.isInteger(d.h) && d.w >= 2 && d.h >= 2);
    assert.equal(d.data.length, d.w * d.h);
    assert.ok(inUnit(d));
    assert.equal(d.placeholder, false);
  }
  const d = sceneDepth({ objects: [] }, { w: 64, h: 48 });
  assert.equal(d.w, 64); assert.equal(d.h, 48);
});

test('pathPoints: n evenly spaced [u, v, h] points, left to right, u clamped, h from the sampler', () => {
  const scene = { ground_path: [[0, 900], [300, 800], [600, 700], [1000, 650]] }, sample = (u, v) => 0.2 + 0.5 * u * v;
  const p = pathPoints(scene, sample);
  assert.equal(p.length, 8);
  assert.ok(p.every((q) => q.length === 3 && q.every(Number.isFinite)));
  assert.deepEqual(p[0].slice(0, 2), [0.05, 0.1]);
  assert.deepEqual(p[7].slice(0, 2), [0.95, 0.35]);
  for (let k = 1; k < p.length; k++) assert.ok(p[k][0] > p[k - 1][0]);
  assert.ok(p.every(([u]) => u >= 0.05 && u <= 0.95));
  for (const [u, v, h] of p) assert.ok(Math.abs(h - sample(u, v)) < 1e-4);
  const gaps = p.slice(1).map((q, k) => Math.hypot(q[0] - p[k][0], q[1] - p[k][1]));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1e-3, 'even along the length');
  assert.deepEqual(pathPoints({ ground_path: [...scene.ground_path].reverse() }, sample), p, 'drawn right to left, same path');
  assert.equal(pathPoints(scene, sample, 5).length, 5);
  assert.equal(pathPoints(scene, sample, 'x').length, 8);
});

test('pathPoints: missing or degenerate paths fall back to the flat bank; a bad sampler gives h 0.5', () => {
  for (const scene of [null, {}, { ground_path: 'x' }, { ground_path: [[500, 500]] }, { ground_path: [[500, 500], [500, 500]] }, { ground_path: [[NaN, 1], [2]] }]) {
    const p = pathPoints(scene, () => 0.3);
    assert.equal(p.length, 8);
    assert.deepEqual(p[0], [0.05, 0.15, 0.3]); assert.deepEqual(p[7], [0.95, 0.15, 0.3]);
  }
  for (const s of [null, () => NaN, () => { throw new Error('x'); }]) assert.ok(pathPoints({}, s).every((q) => q[2] === 0.5));
  assert.ok(pathPoints({}, () => 7).every((q) => q[2] === 1));
  // a path straight up the image starts at its near (bottom) end
  const up = pathPoints({ ground_path: [[500, 200], [500, 900]] }, () => 0);
  assert.equal(up[0][1], 0.1); assert.equal(up[7][1], 0.8);
});

test('pathPoints heights come from the scene depth map through depth.js sampler', () => {
  const scene = { ground_path: [[50, 850], [950, 850]], objects: [obj({ box: [450, 600, 550, 950], depth: 0 })] };
  const p = pathPoints(scene, sampler(sceneDepth(scene)), 9);
  assert.equal(p[4][0], 0.5);
  assert.ok(p[4][2] > p[0][2] + 0.1, 'the path rises over the near object');
});

test('objectHotspots: t nearest the box foot, look at the box centre, sorted, spaced, clamped', () => {
  const path = pathPoints({ ground_path: [[50, 850], [950, 850]] }, () => 0.5);
  const scene = { objects: [
    obj({ label: 'tree', box: [700, 200, 800, 850] }), // foot at x 750: t 0.7778
    obj({ label: 'house', box: [450, 300, 550, 850] }), // t 0.5
    obj({ label: 'x'.repeat(60), box: [0, 0, 100, 400] }), // t 0.0278 -> first allowed
    obj({ box: null, mask: null }), // unusable: no hotspot, indices of the rest unchanged
    obj({ label: '', kind: 'animal', box: [900, 700, 1000, 900] }), // t 1 -> last allowed
  ] };
  const hs = objectHotspots(scene, path);
  assert.deepEqual(hs.map((h) => h.index), [2, 1, 0, 4]);
  const T_FIRST = MIN_T + 0.11, T_LAST = 1 - HOTSPOT_HALF_WIDTH;
  assert.ok(Math.abs(hs[0].t - T_FIRST) < EPS); assert.ok(Math.abs(hs[3].t - T_LAST) < EPS);
  assert.ok(Math.abs(hs[1].t - 0.5) < 1e-3); assert.ok(Math.abs(hs[2].t - 7 / 9) < 1e-3);
  assert.deepEqual(hs[1].look, [0.5, 0.425]);
  assert.equal(hs[0].label.length, 40); assert.equal(hs[3].label, 'animal');
  assert.ok(hs.every((h) => h.zoom === 1.3 && h.t >= T_FIRST - EPS && h.t <= T_LAST + EPS));
});

test('objectHotspots: crowded objects are nudged at least 0.06 apart, extras dropped', () => {
  const path = pathPoints({ ground_path: [[50, 850], [950, 850]] }, () => 0.5);
  const cluster = Array.from({ length: 8 }, (_, k) => obj({ label: `o${k}`, box: [480, 300, 520, 850] })); // all at t 0.5
  const hs = objectHotspots({ objects: cluster }, path);
  for (let k = 1; k < hs.length; k++) assert.ok(hs[k].t - hs[k - 1].t >= 0.06 - EPS);
  assert.ok(hs.every((h) => Math.abs(h.t - 0.5) <= 0.12 + EPS));
  // spread around the cluster, not all pushed to one side: five fit within two gaps of t 0.5
  assert.deepEqual(hs.map((h) => h.t), [0.38, 0.44, 0.5, 0.56, 0.62]);
  assert.deepEqual(hs.map((h) => h.index), [0, 1, 2, 3, 4]);
  // two neighbours a little too close move apart symmetrically
  const pair = objectHotspots({ objects: [obj({ box: [480, 300, 520, 850] }), obj({ box: [507, 300, 547, 850] })] }, path);
  assert.equal(pair.length, 2); assert.ok(Math.abs(pair[1].t - pair[0].t - 0.06) < EPS);
  assert.ok(pair[0].t < 0.5 && pair[1].t > 0.53);
  // more objects than the range holds: never overlapping, never outside it
  const many = Array.from({ length: 32 }, (_, k) => obj({ box: [k * 31, 300, k * 31 + 30, 850] }));
  const hm = objectHotspots({ objects: many }, path);
  assert.ok(hm.length <= 12 && hm.length >= 8);
  for (let k = 1; k < hm.length; k++) assert.ok(hm[k].t - hm[k - 1].t >= 0.06 - EPS);
  assert.ok(hm.every((h) => h.t >= MIN_T + 0.11 - EPS && h.t <= 0.97 + EPS));
  // crowded at the far end: pulled back inside the range rather than past t 0.97
  const end = Array.from({ length: 3 }, () => obj({ box: [940, 300, 1000, 850] }));
  const he = objectHotspots({ objects: end }, path);
  assert.equal(he.length, 3);
  assert.ok(he.every((h) => h.t <= 0.97 + EPS));
  for (let k = 1; k < he.length; k++) assert.ok(he[k].t - he[k - 1].t >= 0.06 - EPS);
});

test('objectHotspots: garbage in, empty or partial list out', () => {
  assert.deepEqual(objectHotspots(null, null), []);
  assert.deepEqual(objectHotspots({ objects: [obj({ box: [0, 0, 10, 10] })] }, [[0.5, 0.5, 0.5]]), []);
  assert.deepEqual(objectHotspots({ objects: 'x' }, pathPoints({}, () => 0)), []);
  const hs = objectHotspots({ objects: [null, 3, { mask: [[100, 100], [300, 100], [200, 400]] }] }, pathPoints({}, () => 0));
  assert.equal(hs.length, 1); assert.equal(hs[0].index, 2); assert.equal(hs[0].label, 'object');
});

test('objectIdMap: i + 1 for scene.objects[i], 0 for none; skipped entries keep the indices of the rest', () => {
  const m = objectIdMap({ objects: [obj({ box: [100, 100, 300, 300] }), null, obj({ box: null }), obj({ box: [600, 600, 900, 900] })] }, { w: 64, h: 48 });
  assert.equal(m.w, 64); assert.equal(m.h, 48); assert.ok(m.data instanceof Uint8Array); assert.equal(m.data.length, 64 * 48);
  assert.equal(px(m, 200, 200), 1); assert.equal(px(m, 750, 750), 4); assert.equal(px(m, 500, 500), 0);
  assert.deepEqual([...new Set(m.data)].sort(), [0, 1, 4]);
  const d = objectIdMap({ objects: [] });
  assert.equal(d.w, 256); assert.equal(d.h, 192); assert.ok(d.data.every((x) => x === 0));
});

test('objectIdMap: rows run bottom-up like sceneDepth, an object at the image top lands in the high rows', () => {
  const m = objectIdMap({ objects: [obj({ box: [0, 0, 1000, 100] })] }), mid = m.w / 2;
  assert.equal(m.data[(m.h - 1) * m.w + mid], 1);
  assert.equal(m.data[Math.floor(0.95 * m.h) * m.w + mid], 1);
  assert.equal(m.data[mid], 0); assert.equal(m.data[Math.floor(0.5 * m.h) * m.w + mid], 0);
});

test('objectIdMap: nearer objects overwrite farther ones whatever the list order; masks follow the outline, null fills the box', () => {
  const near = obj({ box: [300, 300, 700, 700], depth: 0.2 }), far = obj({ box: [100, 100, 900, 900], depth: 0.7 });
  const a = objectIdMap({ objects: [near, far] }), b = objectIdMap({ objects: [far, near] });
  assert.equal(px(a, 500, 500), 1); assert.equal(px(a, 150, 500), 2);
  assert.equal(px(b, 500, 500), 2); assert.equal(px(b, 150, 500), 1);
  // equal depth: the later object paints last, as in sceneDepth's stable sort
  const tie = objectIdMap({ objects: [obj({ box: [100, 100, 900, 900], depth: 0.5 }), obj({ box: [300, 300, 700, 700], depth: 0.5 })] });
  assert.equal(px(tie, 500, 500), 2);
  const box = [100, 100, 900, 900], tri = [[100, 100], [900, 100], [100, 900]];
  const m = objectIdMap({ objects: [obj({ box, mask: tri })] }), f = objectIdMap({ objects: [obj({ box })] });
  assert.equal(px(m, 200, 200), 1); assert.equal(px(m, 800, 800), 0);
  assert.equal(px(f, 800, 800), 1);
  // the depth map and the id map agree on which pixels an object covers
  const scene = { objects: [obj({ box, mask: tri, depth: 0 })] }, dm = sharp(scene), base = sharp({ objects: [] }), im = objectIdMap(scene);
  for (let k = 0; k < im.data.length; k++) if ((im.data[k] === 1) !== (dm.data[k] !== base.data[k])) assert.fail(`pixel ${k}`);
});

test('objectIdMap: garbage scenes and options still return a full map of valid ids', () => {
  const junk = [null, undefined, 'x', 42, [], { objects: 'nope' }, { objects: [null, 1, 'a', [], { box: [NaN, 0, 1, 1] },
    { mask: [[NaN, NaN]], box: [1, 2] }, { depth: NaN, box: [100, 100, 200, 200] }, { depth: Infinity, mask: [[0, 0], [0, 0], [0, 0]] },
    { box: [1e308, -1e308, 5, 5], mask: [[1e308, 0], [0, -1e308], [Infinity, 1]], depth: -3 }, { box: [500, 500, 500, 500], depth: 0 }] }];
  for (const scene of junk) for (const opts of [undefined, null, 'x', { w: NaN, h: -5 }, { w: 1e9, h: 3.7 }]) {
    const m = objectIdMap(scene, opts);
    assert.ok(Number.isInteger(m.w) && Number.isInteger(m.h) && m.w >= 2 && m.h >= 2);
    assert.equal(m.data.length, m.w * m.h);
    assert.ok(m.data.every((x) => x === 0 || x === 7 || x === 9 || x === 10), 'only objects with a usable box or mask');
  }
  // 32 objects is the cap, so ids never pass 32 and the 33rd is ignored
  const many = objectIdMap({ objects: Array.from({ length: 40 }, () => obj({ box: [0, 0, 1000, 1000], depth: 0.5 })) });
  assert.ok(many.data.every((x) => x === 32));
});
