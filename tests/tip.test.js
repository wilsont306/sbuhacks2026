// node:test suite for src/world/tip.js: the Tour-into-the-Picture geometry behind the phone's inside view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EYE, horizonRow, paintingCamera, rayAt, project, imageToFloor, rowDistance, planePoint, uvToFloor, uvToImage, padBox, flatOf, extentOf,
  fitDepth, distanceAt, fillDepth, flatDistance, reliefGrid, terrainPath, sampleDepth, shapeOf, walkSign,
} from '../src/world/tip.js';
import { validateScene } from '../src/shared/scene-validate.js';
import { pathPoints } from '../src/host/maskDepth.js';

const sample = (f) => validateScene(JSON.parse(readFileSync(new URL(`../public/samples/${f}`, import.meta.url), 'utf8')));
const TURNER = sample('turner.scene.json'), SKETCH = sample('sketch.scene.json');
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const obj = (kind, box) => ({ kind, box, label: kind, mask: null, depth: 0.5, motion: 'none' });

test('horizon: the highest grounded foot less a margin, clamped 300..700, default 450', () => {
  assert.equal(horizonRow(null), 450);
  assert.equal(horizonRow({ objects: [] }), 450);
  assert.equal(horizonRow({ objects: [obj('sky', [0, 0, 1000, 600]), obj('cloud', [0, 0, 100, 650]), obj('celestial', [0, 0, 50, 520])] }), 450, 'the sky never sets it');
  assert.equal(horizonRow({ objects: [obj('building', [0, 300, 100, 640]), obj('person', [0, 500, 100, 900])] }), 600);
  assert.equal(horizonRow({ objects: [obj('plant', [0, 0, 100, 100])] }), 300);
  assert.equal(horizonRow({ objects: [obj('animal', [0, 900, 100, 1000])] }), 700);
  assert.equal(horizonRow(TURNER), 628, 'the old road bridge foot (668) less 40');
  assert.equal(horizonRow(SKETCH), 595, 'the tree foot (635) less 40');
});

test('the painting camera stands at eye height, and a level ray lands on the horizon row', () => {
  for (const [scene, aspect] of [[TURNER, 1920 / 1433], [SKETCH, 4 / 3], [{}, 0.5], [{ objects: [obj('plant', [0, 0, 9, 9])] }, 4]]) {
    const cam = paintingCamera(scene, aspect);
    assert.deepEqual(cam.position, [0, EYE, 0]);
    const far = project(cam, [0, 0, -1e7]);
    close(far[1], cam.horizon, 0.1, 'a far floor point sits on the horizon');
    const level = project(cam, [123, EYE, -1e6]);
    close(level[1], cam.horizon, 1e-6, 'a level ray');
    assert.ok(cam.fov > 10 && cam.fov <= 50 && 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect) * 180 / Math.PI <= 110.0001, 'fields of view');
    // lookAt sits on the view axis: it projects to the picture's centre
    const c = project(cam, cam.lookAt);
    close(c[0], 500, 1e-9, 'lookAt x'); close(c[1], 500, 1e-9, 'lookAt y');
  }
});

test('a floor point projected back through the painting camera lands on its image coordinate', () => {
  const cam = paintingCamera(TURNER, 1920 / 1433);
  for (let x = 0; x <= 1000; x += 125) {
    for (let y = cam.wallRow; y <= 1000; y += 37) {
      const p = imageToFloor(cam, x, y);
      assert.ok(p, `${x},${y} is on the floor`);
      assert.equal(p[1], 0);
      assert.ok(p[2] < 0, 'in front of the camera');
      const q = project(cam, p);
      close(q[0], x, 1e-6, 'x'); close(q[1], y, 1e-6, 'y');
    }
  }
  // the same for points on an upright plane and on the back wall
  for (const [x, y] of [[0, 0], [1000, 0], [500, 500], [250, 990]]) {
    const q = project(cam, planePoint(cam, x, y, 37));
    close(q[0], x, 1e-6, 'plane x'); close(q[1], y, 1e-6, 'plane y');
  }
});

test('floor distances grow toward the horizon and stop there', () => {
  const cam = paintingCamera(SKETCH, 4 / 3);
  let last = 0;
  for (let y = 1000; y > cam.horizon; y -= 5) {
    const d = rowDistance(cam, y);
    assert.ok(d > last, `row ${y}: ${d} > ${last}`);
    last = d;
  }
  assert.equal(rowDistance(cam, cam.horizon), Infinity);
  assert.equal(rowDistance(cam, 0), Infinity);
  assert.equal(imageToFloor(cam, 500, cam.horizon - 1), null);
  close(cam.nearDist, rowDistance(cam, 1000), 1e-9, 'near');
  close(cam.farDist, rowDistance(cam, cam.wallRow), 1e-9, 'far');
  assert.ok(cam.nearDist > 1 && cam.nearDist < 10, `the picture's foot is a few metres away (${cam.nearDist})`);
  assert.ok(cam.farDist > 50 && cam.farDist < 400, `the back wall is far (${cam.farDist})`);
});

test('flats stand on the floor at their foot row and cover their box', () => {
  const cam = paintingCamera(SKETCH, 4 / 3);
  const flats = SKETCH.objects.map((o) => flatOf(cam, o.box));
  for (const [i, o] of SKETCH.objects.entries()) {
    const f = flats[i];
    if (o.box[3] <= cam.wallRow + 1) { assert.equal(f, null, `${o.label} stays on the wall`); continue; }
    assert.ok(f, o.label);
    assert.equal(f.foot[1], 0, 'on the floor');
    close(f.distance, rowDistance(cam, o.box[3]), 1e-9, 'at its foot row');
    assert.ok(f.distance < cam.farDist, 'in front of the wall');
    assert.ok(f.height > 0 && f.right > 0 && f.left < 0, 'a real rectangle around its foot');
    const corners = [[f.left, 0], [f.right, 0], [f.left, f.height], [f.right, f.height]].map(([dx, y]) => project(cam, [f.foot[0] + dx, y, f.foot[2]]));
    const [x0, y0, x1, y1] = o.box;
    close(corners[0][1], y1, 1e-6, 'its bottom edge is the foot row');
    close(corners[2][1], y0, 1e-6, 'its top edge is the top row');
    for (const [k, c] of corners.entries()) assert.ok(k % 2 === 0 ? c[0] <= x0 + 1e-6 : c[0] >= x1 - 1e-6, `${o.label} corner ${k} covers the box`);
  }
  const tree = SKETCH.objects.findIndex((o) => o.label === 'Tree'), dog = SKETCH.objects.findIndex((o) => o.label === 'Dog');
  assert.ok(flats[tree] && flats[dog] && flats[tree].distance > flats[dog].distance, 'the tree stands behind the dog');
  assert.equal(flatOf(cam, [0, 0, 100, cam.wallRow]), null, 'a foot at the wall stays painted');
});

test('padBox grows the box by a rim, clamped to the picture', () => {
  assert.deepEqual(padBox([100, 100, 200, 200], 2, 5), [95, 90, 205, 210]);
  assert.deepEqual(padBox([0, 0, 1000, 1000], 1, 5), [0, 0, 1000, 1000]);
  assert.equal(padBox([1, 2, 3], 1, 5), null);
  assert.deepEqual(padBox([100, 100, 200, 200], NaN, NaN), [100, 100, 200, 200]);
});

test('the TV path, converted to the floor, stays on the floor and clear of the wall', () => {
  for (const scene of [TURNER, SKETCH, validateScene({})]) {
    const cam = paintingCamera(scene, 4 / 3);
    for (const [u, v] of pathPoints(scene, () => 0, 8)) {
      const p = uvToFloor(cam, u, v);
      assert.ok(p && p[1] === 0 && -p[2] >= cam.nearDist - 1e-9 && -p[2] < cam.farDist, `${u},${v}`);
      const back = project(cam, p);
      close(back[0], u * 1000, 1e-6, 'its column is kept');
    }
    const high = uvToFloor(cam, 0.5, 0.99); // a path point up in the sky is pulled down to the far floor
    assert.ok(high && -high[2] < cam.farDist && project(cam, high)[1] > cam.wallRow);
  }
});

test('the room extends past what the picture shows', () => {
  const cam = paintingCamera(TURNER, 1920 / 1433), e = extentOf(cam);
  assert.equal(e.far, cam.farDist);
  assert.equal(e.back, cam.nearDist);
  const top = planePoint(cam, 0, 0, cam.farDist), right = planePoint(cam, 1000, 1000, cam.farDist);
  assert.ok(e.height >= top[1] && e.width / 2 >= Math.abs(top[0]) && e.width / 2 >= Math.abs(right[0]));
});

test('degenerate input never throws', () => {
  for (const scene of [undefined, null, 7, 'x', [], { objects: 'x' }, { objects: [null, 1, { kind: 'plant', box: [NaN, 0, 1, 1] }, { kind: 'plant', box: [5, 5, 5, 5] }] }]) {
    for (const aspect of [undefined, NaN, -1, 0, 1e9, 1 / 0]) {
      const cam = paintingCamera(scene, aspect);
      assert.ok(Number.isFinite(cam.fov) && Number.isFinite(cam.farDist) && Number.isFinite(cam.nearDist));
      assert.ok(cam.aspect >= 0.25 && cam.aspect <= 4);
    }
  }
  const cam = paintingCamera({}, 1);
  for (const bad of [NaN, Infinity, undefined, null, 'x']) {
    assert.equal(imageToFloor(cam, bad, 900), null);
    assert.equal(imageToFloor(cam, 500, bad), null);
    assert.equal(planePoint(cam, 500, 500, bad), null);
    assert.ok(uvToFloor(cam, bad, bad), 'uv falls back to a floor point');
    assert.equal(flatOf(cam, bad), null);
  }
  assert.equal(project(cam, [0, EYE, 5]), null, 'behind the camera');
  assert.equal(project(cam, [0, NaN, -5]), null);
  assert.equal(project(cam, 'x'), null);
  assert.equal(planePoint(cam, 500, 500, -3), null);
  assert.equal(flatOf(cam, [10, 10, 5, 5]), null, 'a reversed box');
  assert.ok(rayAt(cam, 500, 500).every(Number.isFinite));
});

// ---- the depth room ----
// A seeded generator, so the noise is the same on every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const A0 = 0.4, B0 = -0.02; // the synthetic depth: value / 255 = (1 / distance - B0) / A0
const byteOf = (D) => Math.round(255 * clampN((1 / D - B0) / A0, 0, 1));
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// A D1 picture from TIP's own room: the floor at its row's distance and each standing object at its foot's (what a
// depth model would see), the sky 0. noise: +-noise bytes on every pixel; outliers: that share of floor pixels random.
function tipDepth(cam, scene, w, h, noise, outliers, seed) {
  const rnd = lcg(seed || 1), data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const D = rowDistance(cam, (j + 0.5) / h * 1000);
    for (let i = 0; i < w; i++) {
      let v = D === Infinity ? 0 : byteOf(D);
      if (D !== Infinity && rnd() < outliers) v = Math.floor(rnd() * 256);
      data[j * w + i] = clampN(Math.round(v + (rnd() * 2 - 1) * noise), 0, 255);
    }
  }
  for (const o of (scene.objects || [])) {
    if (['sky', 'cloud', 'celestial', 'ground', 'water'].indexOf(o.kind) >= 0) continue;
    const v = o.box[3] > cam.horizon ? byteOf(rowDistance(cam, o.box[3])) : 0;
    const shape = shapeOf(o);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (inside(shape, (i + 0.5) / w * 1000, (j + 0.5) / h * 1000)) data[j * w + i] = v;
  }
  return { data, w, h };
}
function inside(pts, x, y) {
  let c = false;
  for (let k = 0, n = pts.length; k < n; k++) {
    const [px, py] = pts[k], [qx, qy] = pts[(k + 1) % n];
    if ((py <= y) !== (qy <= y) && x < px + (y - py) / (qy - py) * (qx - px)) c = !c;
  }
  return c;
}

test('fitDepth recovers the floor line from noisy depth with outliers, and reads no standing object', () => {
  for (const [scene, aspect] of [[TURNER, 1920 / 1433], [SKETCH, 4 / 3]]) {
    const cam = paintingCamera(scene, aspect);
    const fit = fitDepth(cam, scene, tipDepth(cam, scene, 256, Math.round(256 / aspect), 3, 0.05, 5));
    assert.ok(fit, 'a fit');
    close(fit.a, A0, 0.03 * A0, 'a');
    close(fit.b, B0, 0.004, 'b');
    assert.ok(fit.r2 > 0.95, `r2 ${fit.r2}`);
    close(fit.near, cam.nearDist / 2, 1e-9, 'near');
    close(fit.far, cam.farDist, 1e-9, 'far is the back wall');
  }
  // the same floor read upside down (far bright) is not a floor
  const cam = paintingCamera(SKETCH, 4 / 3), d = tipDepth(cam, SKETCH, 128, 96, 0, 0);
  assert.equal(fitDepth(cam, SKETCH, { data: d.data.map((v) => 255 - v), w: 128, h: 96 }), null, 'a < 0');
  const rnd = lcg(9);
  assert.equal(fitDepth(cam, SKETCH, { data: d.data.map(() => Math.floor(rnd() * 256)), w: 128, h: 96 }), null, 'noise has no sane r2');
});

test('distanceAt inverts the fit and clamps to the room', () => {
  const fit = { a: A0, b: B0, r2: 1, near: 2, far: 80 };
  close(distanceAt(fit, byteOf(10)), 10, 0.2, '10 m');
  assert.equal(distanceAt(fit, 255), Math.max(2, 1 / (A0 + B0)), 'the nearest value');
  assert.equal(distanceAt({ a: 1, b: 0, r2: 1, near: 2, far: 80 }, 255), 2, 'nearer than near is near');
  assert.equal(distanceAt(fit, 0), 80, 'a non-positive inverse distance is the wall');
  assert.equal(distanceAt(fit, byteOf(1000)), 80, 'beyond the wall is the wall');
  assert.equal(distanceAt(fit, NaN), 80);
});

test('relief vertices project back to their image points and the floor lies flat', () => {
  const cam = paintingCamera(TURNER, 1920 / 1433), depth = tipDepth(cam, { objects: [] }, 256, 191, 0, 0);
  const fit = fitDepth(cam, TURNER, depth), g = reliefGrid(cam, fit, depth);
  assert.ok(fit && g);
  assert.ok(g.cols <= 160 && g.cols >= 80 && g.rows >= 60, `${g.cols} by ${g.rows}`);
  assert.equal(g.position.length, g.cols * g.rows * 3);
  const tris = g.index.length / 3;
  assert.ok(tris > 0.8 * 2 * (g.cols - 1) * (g.rows - 1) && tris <= 18000, `${tris} triangles`);
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) {
      const k = j * g.cols + i, p = [g.position[3 * k], g.position[3 * k + 1], g.position[3 * k + 2]], x = i / (g.cols - 1) * 1000, y = j / (g.rows - 1) * 1000;
      const q = project(cam, p);
      close(q[0], x, 0.01, `vertex ${i},${j} x`); close(q[1], y, 0.01, `vertex ${i},${j} y`);
      assert.ok(-p[2] >= fit.near - 1e-3 && -p[2] <= fit.far + 1e-3, 'inside the room');
      if (y > cam.horizon + 100) close(p[1], 0, 0.15, `floor vertex ${i},${j} height`);
    }
  }
  for (const k of g.index) assert.ok(Number.isInteger(k) && k >= 0 && k < g.cols * g.rows);
});

test('relief triangles are cut across a silhouette and kept on smooth ground', () => {
  const cam = paintingCamera({}, 4 / 3), w = 120, h = 90, data = new Uint8Array(w * h).fill(byteOf(cam.nearDist * 3));
  for (let j = 30; j < 60; j++) data.fill(byteOf(cam.nearDist), j * w + 40, j * w + 80); // a near block on a far wall
  const fit = { a: A0, b: B0, r2: 1, near: cam.nearDist / 2, far: cam.farDist }, g = reliefGrid(cam, fit, { data, w, h });
  const D = (k) => -g.position[3 * k + 2];
  let max = 0;
  for (let t = 0; t < g.index.length; t += 3) {
    const ds = [D(g.index[t]), D(g.index[t + 1]), D(g.index[t + 2])];
    max = Math.max(max, Math.max(...ds) / Math.min(...ds));
  }
  assert.ok(max <= 1.35 + 1e-6, `no stretched triangle (${max})`);
  const all = 2 * (g.cols - 1) * (g.rows - 1), tris = g.index.length / 3;
  assert.ok(tris < all && tris > 0.9 * all, `the block's outline is cut (${tris} of ${all})`);
  const flat = reliefGrid(cam, fit, { data: new Uint8Array(w * h).fill(100), w, h });
  assert.equal(flat.index.length / 3, all, 'a constant depth keeps every triangle');
});

test('fillDepth replaces the outlines from just outside them', () => {
  const w = 100, h = 50, data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = 50 + i; // depth runs left to right
  for (let j = 10; j < 30; j++) data.fill(255, j * w + 40, j * w + 60);
  const box = [400, 200, 600, 600], shape = [[400, 200], [600, 200], [600, 600], [400, 600]];
  const out = fillDepth({ data, w, h }, [shape]);
  assert.equal(out.w, w); assert.equal(out.h, h);
  assert.notEqual(out.data, data, 'a new picture');
  for (let j = 10; j < 30; j++) for (let i = 40; i < 60; i++) close(out.data[j * w + i], 50 + i, 1, `filled ${i},${j}`);
  for (const [i, j] of [[0, 0], [10, 40], [99, 49], [80, 20]]) assert.equal(out.data[j * w + i], data[j * w + i], 'far outside is kept');
  assert.equal(data[20 * w + 50], 255, 'the input is untouched');
  // rows covered edge to edge take the median of the depth around the outlines
  const band = new Uint8Array(w * h).fill(90);
  for (let j = 20; j < 30; j++) band.fill(200, j * w, (j + 1) * w);
  const b = fillDepth({ data: band, w, h }, [[[0, 400], [1000, 400], [1000, 600], [0, 600]]]);
  for (let i = 0; i < w; i++) assert.equal(b.data[25 * w + i], 90, 'the boundary median');
  // nothing to fill, and outlines that are garbage, keep the picture
  assert.deepEqual(Array.from(fillDepth({ data, w, h }, []).data), Array.from(data));
  assert.deepEqual(Array.from(fillDepth({ data, w, h }, [null, 'x', [[NaN, 0], [1, 2], [3, 4]], [[0, 0]]]).data), Array.from(data));
  // everything covered: no outside to fill from, so it is kept as it is
  assert.deepEqual(Array.from(fillDepth({ data, w, h }, [[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]).data), Array.from(data));
  assert.equal(box.length, 4);
  // the backdrop goes to the wall first, and an outline beside it fills from the wall
  const sky = [[0, 0], [1000, 0], [1000, 300], [0, 300]], walled = fillDepth({ data, w, h }, [[[0, 200], [300, 200], [300, 600], [0, 600]]], [sky, 'x']);
  for (let j = 0; j < 15; j++) for (let i = 0; i < w; i++) assert.equal(walled.data[j * w + i], 0, `sky ${i},${j}`);
  assert.equal(walled.data[30 * w + 50], data[30 * w + 50], 'below the sky is kept');
  assert.equal(walled.data[12 * w + 10], 0, 'a row whose outside is all sky fills with the wall');
});

test('a flat never stands behind the relief over its outline', () => {
  const cam = paintingCamera({}, 4 / 3), w = 64, h = 48, fit = { a: A0, b: B0, r2: 1, near: 1, far: 140 };
  const o = { kind: 'plant', box: [250, 250, 750, 750], mask: null };
  const depth = { data: new Uint8Array(w * h).fill(20), w, h }, filled = { data: new Uint8Array(w * h).fill(20), w, h };
  for (let j = 30; j < 40; j++) filled.data.fill(200, j * w + 10, j * w + 50); // the floor behind its foot is near
  const median = flatDistance(cam, fit, depth, o);
  close(median, distanceAt(fit, 20), 1e-9, 'its median depth');
  close(flatDistance(cam, fit, depth, o, filled), distanceAt(fit, 200) / 1.03, 1e-9, 'in front of the nearest relief behind it');
  close(flatDistance(cam, fit, depth, o, { data: new Uint8Array(w * h), w, h }), median, 1e-9, 'a relief far behind changes nothing');
  close(flatDistance(cam, fit, depth, o, { data: new Uint8Array(4), w: 2, h: 2 }), median, 1e-9, 'a filled picture of another size is ignored');
});

test('a flat in the depth room stands at its median depth and still covers its box', () => {
  const cam = paintingCamera(SKETCH, 4 / 3), depth = tipDepth(cam, SKETCH, 256, 192, 2, 0.05, 3), fit = fitDepth(cam, SKETCH, depth);
  assert.ok(fit);
  for (const o of SKETCH.objects) {
    if (['sky', 'cloud', 'celestial', 'ground', 'water'].indexOf(o.kind) >= 0 || o.box[3] <= cam.wallRow + 1) continue;
    const D = flatDistance(cam, fit, depth, o), foot = rowDistance(cam, o.box[3]);
    close(D, foot, 0.06 * foot, `${o.label} at its depth`);
    assert.equal(flatDistance(cam, null, depth, o), foot, 'no fit: the foot row');
    const f = flatOf(cam, o.box, D * 1.2); // farther than its foot: it sinks below the floor, and still covers its box
    assert.ok(f && f.distance === D * 1.2 && f.foot[1] < 0, o.label);
    const corners = [[f.left, 0], [f.right, 0], [f.left, f.height], [f.right, f.height]].map(([dx, y]) => project(cam, [f.foot[0] + dx, f.foot[1] + y, f.foot[2]]));
    close(corners[0][1], o.box[3], 1e-6, 'bottom edge'); close(corners[2][1], o.box[1], 1e-6, 'top edge');
    assert.ok(corners[0][0] <= o.box[0] + 1e-6 && corners[1][0] >= o.box[2] - 1e-6, 'covers across');
  }
  assert.equal(flatDistance(cam, fit, depth, { kind: 'plant', box: [0, 0, 1, 1], mask: null }) > 0, true, 'a box between pixel centres');
  assert.equal(flatDistance(cam, fit, depth, null), Infinity);
});

test('the walk on the relief keeps the TV path\'s image points and its feet on the ground', () => {
  // the TV's 8 path points, 8 samples between each pair (the diorama samples its curve as densely)
  const cam = paintingCamera(TURNER, 1920 / 1433), pp = pathPoints(TURNER, () => 0, 8), uvs = [];
  for (let k = 0; k < 57; k++) { const s = k / 8, a = pp[Math.min(6, Math.floor(s))], b = pp[Math.min(7, Math.floor(s) + 1)], f = s - Math.min(6, Math.floor(s)); uvs.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
  const clean = tipDepth(cam, { objects: [] }, 256, 191, 0, 0), fit = fitDepth(cam, TURNER, clean);
  for (const [k, p] of terrainPath(cam, fit, clean, uvs).entries()) {
    const q = project(cam, p), want = uvToImage(cam, uvs[k][0], uvs[k][1]);
    close(q[0], want[0], 1e-6, 'x'); close(q[1], want[1], 1e-6, 'y');
    close(p[1], 0, 0.15, 'on the floor');
  }
  // noise on the ground: the low-pass keeps the heights smoother than the raw depth would
  const noisy = tipDepth(cam, { objects: [] }, 256, 191, 12, 0, 4), many = [];
  for (let k = 0; k <= 64; k++) many.push([0.1 + 0.8 * k / 64, 0.2]);
  const rough = (pts) => pts.slice(2).reduce((s, p, k) => s + Math.pow(p[1] - 2 * pts[k + 1][1] + pts[k][1], 2), 0);
  const raw = many.map((uv) => { const q = uvToImage(cam, uv[0], uv[1]); return planePoint(cam, q[0], q[1], distanceAt(fit, sampleDepth(noisy, q[0], q[1]))); });
  assert.ok(rough(terrainPath(cam, fit, noisy, many)) < rough(raw) / 4, 'smoothed');
  // no fit: the plain floor, exactly as uvToFloor has it
  for (const [k, p] of terrainPath(cam, null, null, uvs).entries()) {
    const f = uvToFloor(cam, uvs[k][0], uvs[k][1]);
    close(p[0], f[0], 1e-6, 'floor x'); close(p[1], 0, 1e-9, 'floor y'); close(p[2], f[2], 1e-6, 'floor z');
  }
  assert.deepEqual(terrainPath(cam, fit, clean, 'x'), []);
});

test('degenerate depth never throws and falls back', () => {
  const cam = paintingCamera(SKETCH, 4 / 3), w = 64, h = 48;
  const bad = [undefined, null, 7, 'x', [], {}, { data: new Uint8Array(10), w, h }, { data: new Uint8Array(w * h), w: 64.5, h },
    { data: new Uint8Array(w * h), w: -w, h: -h }, { data: null, w, h }, { data: new Uint8Array(4), w: 2, h: 2, x: 1 }];
  for (const d of bad) {
    assert.equal(fitDepth(cam, SKETCH, d), null);
    assert.equal(reliefGrid(cam, { a: 1, b: 0, near: 1, far: 9 }, d === bad[10] ? null : d), null);
  }
  for (const d of bad.slice(0, 10)) assert.equal(fillDepth(d, []), null);
  assert.equal(fitDepth(cam, SKETCH, { data: new Uint8Array(w * h).fill(128), w, h }), null, 'constant');
  assert.equal(fitDepth(cam, SKETCH, { data: new Uint8Array(w * h), w, h }), null, 'all zero');
  assert.equal(fitDepth(cam, SKETCH, { data: new Array(w * h).fill(NaN), w, h }), null, 'not numbers');
  for (const scene of [undefined, null, 'x', { objects: 'x' }, { objects: [null, 1, { kind: 'plant', box: [NaN, 0, 1, 1] }, { kind: 'plant', box: [1, 1, 9, 9], mask: [[0, 'x']] }] }]) {
    assert.ok(fitDepth(cam, scene, tipDepth(cam, { objects: [] }, w, h, 0, 0)), 'any scene: the floor is all there is');
  }
  assert.equal(reliefGrid(cam, null, { data: new Uint8Array(w * h), w, h }), null, 'no fit');
  const tiny = reliefGrid(cam, { a: 1, b: 0, near: 1, far: 9 }, { data: new Uint8Array(4), w: 2, h: 2 });
  assert.ok(tiny && tiny.position.every(Number.isFinite), 'a 2 by 2 depth still makes a relief');
});

test('walkSign: Walk goes the path way nearer the look, switching only 15 degrees past perpendicular', () => {
  const sign = (deg, cur) => walkSign(Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 1, 0, cur, 15); // deg from +t
  for (const cur of [1, -1, 0, null, undefined]) {
    assert.equal(sign(0, cur), 1, `along +t from ${cur}`);
    assert.equal(sign(180, cur), -1, `along -t from ${cur}`);
  }
  assert.equal(sign(100, 1), 1, 'just past sideways keeps +1');
  assert.equal(sign(-104, 1), 1, 'on either side');
  assert.equal(sign(106, 1), -1, 'past 105 switches');
  assert.equal(sign(-106, 1), -1, 'past 105 switches on either side');
  assert.equal(sign(80, -1), -1, 'from -1, 80 degrees keeps -1');
  assert.equal(sign(74, -1), 1, 'under 75 switches back');
  assert.equal(sign(91, 0), -1, 'no current: the nearer side');
  assert.equal(sign(89, null), 1, 'no current: the nearer side');
  // any tangent, any lengths: only the angle counts
  assert.equal(walkSign(0, -3, 0, 0.2, 1, 15), -1, 'opposite, unnormalised');
  assert.equal(walkSign(-0.6, -0.8, -6, -8, -1, 15), 1, 'along a slanted tangent');
  assert.equal(walkSign(1, 0.1, 1, 0, -1, 0), 1, 'no hysteresis: just the nearer');
  // nothing to go on keeps what it had
  for (const v of [[0, 0, 1, 0], [1, 0, 0, 0], [NaN, 1, 1, 0], [1, 0, Infinity, 0]]) {
    assert.equal(walkSign(v[0], v[1], v[2], v[3], -1, 15), -1, `${v} keeps -1`);
    assert.equal(walkSign(v[0], v[1], v[2], v[3], null, 15), 1, `${v} with no current`);
  }
  // a look swept slowly round and back flips once each way, past 105 out and under 75 back: no flicker between
  let cur = 1;
  const flips = [];
  const sweep = (from, to, step) => {
    for (let d = from; step > 0 ? d <= to : d >= to; d += step) { const n = sign(d, cur); if (n !== cur) { flips.push([d, n]); cur = n; } }
  };
  sweep(0.25, 179.75, 0.5); sweep(179.75, 0.25, -0.5); // off the exact boundary, where rounding decides
  assert.deepEqual(flips, [[105.25, -1], [74.75, 1]]);
});
