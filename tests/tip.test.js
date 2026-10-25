// node:test suite for src/world/tip.js: the Tour-into-the-Picture geometry behind the phone's inside view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EYE, horizonRow, paintingCamera, rayAt, project, imageToFloor, rowDistance, planePoint, uvToFloor, uvToImage, padBox, flatOf, extentOf,
  fitDepth, distanceAt, fillDepth, flatDistance, reliefGrid, terrainPath, sampleDepth, shapeOf, walkSign, pushPull,
  pathGap, slideScale, turnWeight, turnYaw, turnCap, hides, isDeck, lookPoint, groundHeight, BACKDROP, FLOOR_KINDS,
} from '../src/world/tip.js';
import { validateScene } from '../src/shared/scene-validate.js';
import { pathPoints } from '../src/host/maskDepth.js';

const sample = (f) => validateScene(JSON.parse(readFileSync(new URL(`../public/samples/${f}`, import.meta.url), 'utf8')));
const TURNER = sample('turner.scene.json'), SKETCH = sample('sketch.scene.json'), STARRY = sample('starry-night.scene.json');
// Gemini's real reading of a printed sketch, "Steam Train on the Bridge" (1024 x 791; descriptions left out): the
// train's foot is on the bridge deck, which sets the horizon, the walk runs along that deck, and the train's mask
// outlines only its roof.
const TRAIN = validateScene({
  ground_path: [[0, 680], [500, 680], [1000, 680]],
  objects: [
    { label: 'train', kind: 'vehicle', box: [321, 419, 687, 674], mask: [[339, 419], [358, 432], [394, 439], [431, 438], [467, 434], [486, 429], [467, 424], [431, 422], [394, 420], [358, 419]] },
    { label: 'bridge and river', kind: 'building', box: [40, 672, 960, 937], mask: [[40, 675], [960, 675], [960, 934], [40, 934]] },
    { label: 'tree on hill', kind: 'plant', box: [715, 263, 959, 671] }, { label: 'sun', kind: 'celestial', box: [52, 66, 203, 255] },
    { label: 'cloud', kind: 'cloud', box: [427, 91, 663, 219] },
  ],
});
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

test('pushPull fills a hole from the colours around it, never its own', () => {
  // red left half, blue right half, a black object across the seam: the gap takes red and blue, never black
  const w = 64, h = 48, px = new Uint8ClampedArray(w * h * 4), hole = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const i = k % w, j = (k - i) / w, inHole = i >= 20 && i < 44 && j >= 8 && j < 40;
    px.set(inHole ? [0, 0, 0, 255] : i < 32 ? [200, 0, 0, 255] : [0, 0, 200, 255], 4 * k);
    hole[k] = inHole ? 1 : 0;
  }
  const before = px.slice();
  assert.equal(pushPull(px, w, h, hole), true);
  for (let k = 0; k < w * h; k++) {
    if (!hole[k]) { assert.deepEqual([...px.subarray(4 * k, 4 * k + 4)], [...before.subarray(4 * k, 4 * k + 4)], 'known pixels stay'); continue; }
    const [r, g, b, a] = px.subarray(4 * k, 4 * k + 4);
    assert.ok(Math.abs(r + b - 200) <= 2 && g === 0 && a === 255, `a hole pixel is a blend of its surroundings: ${r},${g},${b},${a}`);
  }
  const row = 24 * w, red = (i) => px[4 * (row + i)];
  assert.ok(red(20) > 150 && red(43) < 50, 'each side of the gap takes its own side');
  for (let i = 21; i < 44; i++) assert.ok(red(i) <= red(i - 1), 'and blends across it');
  // one colour around a hole fills it with that colour exactly; holes at the picture's edge fill too
  const g = new Uint8ClampedArray(9 * 7 * 4), gh = new Uint8Array(9 * 7);
  for (let k = 0; k < 63; k++) { gh[k] = k % 9 < 4 || k < 9 ? 1 : 0; g.set(gh[k] ? [255, 255, 255, 255] : [10, 180, 30, 255], 4 * k); }
  assert.equal(pushPull(g, 9, 7, gh), true);
  for (let k = 0; k < 63; k++) assert.deepEqual([...g.subarray(4 * k, 4 * k + 3)], [10, 180, 30]);
  // nothing known: untouched and false; a single pixel; a column
  const all = new Uint8ClampedArray(16).fill(7);
  assert.equal(pushPull(all, 2, 2, new Uint8Array(4).fill(1)), false);
  assert.deepEqual([...all], new Array(16).fill(7));
  assert.equal(pushPull(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1, new Uint8Array(1)), true);
  const col = new Uint8ClampedArray([0, 0, 0, 255, 9, 9, 9, 255, 0, 0, 0, 255, 0, 0, 0, 255, 90, 90, 90, 255]);
  assert.equal(pushPull(col, 1, 5, new Uint8Array([1, 0, 1, 1, 0])), true);
  assert.ok(col[0] === 9 && col[8] >= 9 && col[8] <= 90 && col[12] >= col[8] && col[12] <= 90, 'a column fills from its ends');
});

test('pushPull strokes carry the brushwork beside a gap into it, on the colours around it', () => {
  // grey stripes (160 and 80, two pixels each, mean 120) with a black object across the middle
  const w = 64, h = 32, make = () => {
    const px = new Uint8ClampedArray(w * h * 4), hole = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const i = k % w, v = i >= 24 && i < 40 ? 0 : i % 4 < 2 ? 160 : 80;
      px.set([v, v, v, 255], 4 * k); hole[k] = v ? 0 : 1;
    }
    return { px, hole };
  };
  const stats = (px) => {
    const row = 16 * w, vs = [];
    for (let i = 24; i < 40; i++) vs.push(px[4 * (row + i)]);
    const m = vs.reduce((a, b) => a + b) / vs.length;
    return { m, sd: Math.sqrt(vs.reduce((a, b) => a + (b - m) * (b - m), 0) / vs.length), min: Math.min(...vs), vs };
  };
  const plain = make(), brushed = make();
  assert.equal(pushPull(plain.px, w, h, plain.hole), true);
  assert.equal(pushPull(brushed.px, w, h, brushed.hole, 1), true);
  const p = stats(plain.px), b = stats(brushed.px);
  assert.ok(p.sd < 6, `no strokes: smooth (${p.sd})`);
  assert.ok(b.sd > 15, `strokes: the stripes carry on (${b.sd})`);
  assert.ok(Math.abs(b.m - 120) < 12 && b.min > 50, `on the colours around it, never the object's black: ${b.vs}`);
  assert.ok(b.vs[0] < 100 && b.vs[2] > 140, 'mirrored across the gap\'s left edge (pixel 23 is 80, 21 is 160)');
  assert.ok(b.vs[15] > 140 && b.vs[13] < 100, 'and its right edge (pixel 40 is 160, 42 is 80)');
  // a gap with nothing known on its row, and strokes out of range, never throw
  const g = new Uint8ClampedArray(8 * 8 * 4).fill(200), gh = new Uint8Array(64);
  gh.fill(1, 0, 8);
  for (const s of [NaN, -1, 5, 'x', undefined]) assert.equal(pushPull(g.slice(), 8, 8, gh, s), true);
});

test('shapeOf: the mask, else the box, and the box for a mask that outlines only a sliver of it', () => {
  const box = [100, 100, 300, 200], rect = [[100, 100], [300, 100], [300, 200], [100, 200]];
  const tri = [[100, 100], [300, 100], [200, 200]];
  assert.deepEqual(shapeOf({ box, mask: tri }), tri, 'half the box');
  assert.deepEqual(shapeOf({ box, mask: null }), rect);
  assert.deepEqual(shapeOf({ box, mask: [[100, 100], [300, 100], [300, 105]] }), rect, '2.5% of the box: a part, not the object');
  assert.deepEqual(shapeOf({ box, mask: [[100, 100], [300, 100]] }), rect, 'two points');
  assert.deepEqual(shapeOf({ box, mask: [null, 1, 'x'] }), rect, 'garbage');
  const train = TRAIN.objects[0];
  assert.ok(train.mask && train.mask.length === 10, 'the saved train\'s roof outline passed validation');
  assert.deepEqual(shapeOf(train), [[321, 419], [687, 419], [687, 674], [321, 674]], 'its whole box stands');
  for (const o of [...TURNER.objects, ...SKETCH.objects, ...STARRY.objects]) if (o.mask) assert.equal(shapeOf(o), o.mask, `${o.label} keeps its mask`);
});

// ---- standing objects among the walk ----
// The walk as the diorama samples it (here linearly, 16 steps between the TV's 8 path points), on the plain floor.
function walkOf(scene, cam) {
  const pp = pathPoints(scene, () => 0, 8), uvs = [];
  for (let k = 0; k + 1 < pp.length; k++) for (let s = 0; s < 16; s++) uvs.push([pp[k][0] + (pp[k + 1][0] - pp[k][0]) * s / 16, pp[k][1] + (pp[k + 1][1] - pp[k][1]) * s / 16]);
  uvs.push(pp[pp.length - 1]);
  return terrainPath(cam, null, null, uvs);
}

test('pathGap: the horizontal distance to the walk\'s polyline', () => {
  const path = [[0, 5, 0], [10, 0, 0], [10, 0, -10]];
  close(pathGap(path, 5, 3), 3, 1e-12, 'beside the first leg (heights ignored)');
  close(pathGap(path, 13, -4), 3, 1e-12, 'beside the second');
  close(pathGap(path, -3, -4), 5, 1e-12, 'before its start: to the first point');
  close(pathGap([[1, 0, 1]], 4, 5), 5, 1e-12, 'one point');
  assert.equal(pathGap([], 0, 0), Infinity);
  assert.equal(pathGap(null, 0, 0), Infinity);
});

test('slideScale: a flat on the walk slides the least way clear of it, keeping its side; one well placed stays', () => {
  const cam = paintingCamera({}, 4 / 3), gap = 1.2 * cam.eye, D = 20, across = [[-50, 0, -D], [50, 0, -D]]; // a straight walk at 20 m
  assert.equal(slideScale(cam, [3, 0, -D + 6], across), 1, 'clear: it stays');
  const behind = slideScale(cam, [3, 0, -D - 0.5], across), front = slideScale(cam, [3, 0, -D + 0.5], across);
  assert.ok(behind > 1 && front < 1, `behind the walk it goes farther, in front nearer (${behind}, ${front})`);
  for (const [k, z] of [[behind, -D - 0.5], [front, -D + 0.5]]) {
    const g = pathGap(across, 3 * k, z * k);
    assert.ok(g >= gap && g < gap + 0.25, `just clear: ${g}`);
  }
  // a model, which does not turn: clear by its footprint's radius too, times its scale
  const k = slideScale(cam, [0, 0, -D - 0.5], across, 2), g = pathGap(across, 0, -(D + 0.5) * k);
  assert.ok(g >= gap + 2 * k && g < gap + 2 * k + 0.3, `clear by its footprint: ${g}`);
  // nowhere clear (a walk zigzagging over every depth): it stays
  const everywhere = [];
  for (let z = 0; z < 120; z += 0.5) everywhere.push([-50, 0, -z], [50, 0, -z - 0.25]);
  assert.equal(slideScale(cam, [0, 0, -D], everywhere), 1);
  for (const bad of [null, 'x', [0, 0, 5], [0, 0, 0], [NaN, 0, -3], [0, 0, NaN]]) assert.equal(slideScale(cam, bad, across), 1, `${bad}`);
  assert.equal(slideScale(cam, [0, 0, -D], []), 1, 'no walk: nothing to clear');
});

test('slideScale: nothing beyond 0.7 of the back wall or nearer than half the near floor; a slid flat keeps its size in the picture', () => {
  const cam = paintingCamera({}, 4 / 3), D = 0.9 * cam.farDist;
  close(slideScale(cam, [D * 0.2, 0, -D], []) * D, 0.7 * cam.farDist, 1e-9, 'brought to 0.7 of the wall');
  close(slideScale(cam, [0, 0, -0.1], []) * 0.1, 0.5 * cam.nearDist, 1e-9, 'pushed out to half the near floor');
  // standing on the floor at k times its distance, k times its size: the same rows tall and columns wide, in its column
  const f = flatOf(cam, [400, 300, 520, 700]), kk = slideScale(cam, f.foot, [[-50, 0, f.foot[2]], [50, 0, f.foot[2]]]);
  assert.ok(Math.abs(kk - 1) > 0.02, `it slid (${kk})`);
  const at = (k) => [[f.left, 0], [f.right, 0], [f.left, f.height], [f.right, f.height]].map(([dx, y]) => project(cam, [k * (f.foot[0] + dx), k * y, k * f.foot[2]]));
  const a = at(1), b = at(kk);
  close(b[0][1] - b[2][1], a[0][1] - a[2][1], 0.01 * (a[0][1] - a[2][1]), 'rows tall');
  close(b[1][0] - b[0][0], a[1][0] - a[0][0], 0.01 * (a[1][0] - a[0][0]), 'columns wide');
  close((b[0][0] + b[1][0]) / 2, (a[0][0] + a[1][0]) / 2, 0.5, 'its column');
});

test('the samples and the saved steam train sketch: every flat stands within 0.7 of the wall and 1.2 eye heights clear of the walk', () => {
  const slid = {};
  for (const [name, scene, aspect] of [['Turner', TURNER, 1920 / 1433], ['sketch', SKETCH, 4 / 3], ['Starry Night', STARRY, 1920 / 1520], ['steam train', TRAIN, 1024 / 791]]) {
    const cam = paintingCamera(scene, aspect), walk = walkOf(scene, cam);
    for (const o of scene.objects) {
      // as diorama.js stands it: covering its box with a 6-unit rim, at its own foot's distance
      const f = BACKDROP.indexOf(o.kind) < 0 && FLOOR_KINDS.indexOf(o.kind) < 0 ? flatOf(cam, padBox(o.box, aspect, 6), rowDistance(cam, o.box[3])) : null;
      if (!f) continue;
      const k = slideScale(cam, f.foot, walk);
      if (k !== 1) slid[`${name}: ${o.label}`] = +k.toFixed(2);
      if (name === 'steam train' && o.label === 'train') assert.ok(-f.foot[2] > -walk[0][2] + 1.2 * EYE, 'the train stands behind the walk on its deck, as its wheels stand above the walk\'s row');
      assert.ok(k * f.distance <= 0.7 * cam.farDist + 1e-9, `${name} ${o.label} within 0.7 of the wall`);
      assert.ok(pathGap(walk, k * f.foot[0], k * f.foot[2]) >= 1.2 * EYE - 1e-9, `${name} ${o.label} clear of the walk`);
    }
  }
  // standing at their own feet the train and the tree on the deck are clear of the walk along it; the boat and the
  // spire stand on their walks
  assert.deepEqual(Object.keys(slid).sort(), ['Starry Night: Church spire', 'Turner: Rowing boat']);
  for (const k of Object.values(slid)) assert.ok(k > 0.9 && k < 1.2, `a small slide: ${k}`);
});

test('turnYaw: from the painting camera a flat faces the picture plane; away from it, the eye', () => {
  const cam = paintingCamera(SKETCH, 4 / 3), foot = [4, 0, -12];
  assert.equal(turnWeight(cam, cam.position), 0);
  assert.equal(turnYaw(cam, foot, cam.position), 0, 'from the painting camera: as painted');
  for (const eye of [[0, EYE, -20], [10, EYE, -12], [-6, EYE, -3], [4, EYE, -30], [4.0001, EYE, -12.5]]) {
    const y = turnYaw(cam, foot, eye), to = [eye[0] - foot[0], eye[2] - foot[2]], len = Math.hypot(to[0], to[1]);
    close((Math.sin(y) * to[0] + Math.cos(y) * to[1]) / len, 1, 1e-9, `${eye}: its face points at the eye`);
  }
  let last = 0; // eased in, smoothly, over the first half of the near floor's distance
  for (let d = 0; d <= cam.nearDist; d += cam.nearDist / 40) {
    const w = turnWeight(cam, [0, EYE, -d]);
    assert.ok(w >= last && w <= 1, `${d}: ${w}`);
    last = w;
  }
  assert.equal(turnWeight(cam, [0, EYE, -cam.nearDist / 2]), 1);
  const early = turnWeight(cam, [0, EYE, -cam.nearDist / 8]);
  assert.ok(early > 0 && early < 0.25, `${early}`);
  assert.equal(turnWeight(cam, [NaN, 0, 0]), 0);
  assert.equal(turnWeight(cam, null), 0);
});

test('lookPoint: a standing object\'s centre, a backdrop\'s spot on the back wall, else the surface seen at its box centre', () => {
  const cam = paintingCamera(SKETCH, 4 / 3), mid = (o) => [(o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2];
  assert.deepEqual(lookPoint(cam, SKETCH.objects[2], { foot: [1, 0, -10], height: 4, scale: 1.5 }), [1, 3, -10], 'half its scaled height up');
  for (const o of SKETCH.objects) {
    const p = lookPoint(cam, o, null), q = project(cam, p), [cx, cy] = mid(o);
    close(q[0], cx, 1e-6, `${o.label} column`); close(q[1], cy, 1e-6, `${o.label} row`);
    if (BACKDROP.indexOf(o.kind) >= 0 || cy <= cam.wallRow) close(-p[2], cam.farDist, 1e-9, `${o.label} on the back wall`);
    else assert.equal(p[1], 0, `${o.label} on the floor`);
  }
  // in the depth room, at the relief's distance; a backdrop stays on the back wall
  const depth = tipDepth(cam, { objects: [] }, 128, 96, 0, 0), fit = fitDepth(cam, SKETCH, depth), river = SKETCH.objects[5], [cx, cy] = mid(river);
  const p = lookPoint(cam, river, null, fit, depth), q = project(cam, p);
  close(-p[2], distanceAt(fit, sampleDepth(depth, cx, cy)), 1e-9, 'the relief\'s distance');
  close(q[0], cx, 1e-6, 'column'); close(q[1], cy, 1e-6, 'row');
  close(-lookPoint(cam, SKETCH.objects[0], null, fit, depth)[2], cam.farDist, 1e-9, 'the sun on the wall');
});

test('groundHeight: 0 on the plain floor; in the depth room the relief\'s height under the point', () => {
  const cam = paintingCamera(TURNER, 1920 / 1433);
  for (const p of walkOf(TURNER, cam)) assert.equal(groundHeight(cam, null, null, p[0], p[2]), 0);
  const flat = tipDepth(cam, { objects: [] }, 256, 191, 0, 0), fitted = fitDepth(cam, TURNER, flat);
  for (const p of walkOf(TURNER, cam)) close(groundHeight(cam, fitted, flat, p[0], p[2]), 0, 0.15, `the floor at ${p}`);
  // ground rising away at 1 in 10, read through a known fit: a tenth of the distance up
  const slope = 0.1, w = 256, h = 384, data = new Uint8Array(w * h), fit = { a: A0, b: B0, r2: 1, near: cam.nearDist / 2, far: cam.farDist };
  for (let j = 0; j < h; j++) {
    const r = rayAt(cam, 500, (j + 0.5) / h * 1000), s = -cam.eye / (r[1] + slope * r[2]); // eye + s r.y = slope * (-s r.z)
    data.fill(s > 0 ? byteOf(-s * r[2]) : 0, j * w, (j + 1) * w);
  }
  const slopeDepth = { data, w, h };
  for (const D of [6, 9, 14, 20]) for (const x of [-2, 0, 3]) close(groundHeight(cam, fit, slopeDepth, x, -D), slope * D, 0.04 * D, `${x}, ${D} m`);
  const lip = distanceAt(fit, sampleDepth(slopeDepth, 500, 1000));
  close(groundHeight(cam, fit, slopeDepth, 0, -1), slope * lip, 0.1, 'nearer than the picture\'s foot: the relief\'s height there');
  assert.equal(groundHeight(cam, fit, slopeDepth, 0, -(cam.farDist + 10)), 0, 'beyond all of it');
  for (const [x, z] of [[NaN, -5], [0, 1], [0, 0], [0, NaN]]) assert.equal(groundHeight(cam, fit, slopeDepth, x, z), 0, `${x}, ${z}`);
  assert.equal(groundHeight(cam, fit, { data: new Uint8Array(3), w: 2, h: 2 }, 0, -5), 0, 'an unusable depth');
});

test('turnCap: a wide flat beside the walk turns to the eye only so far that its edges stay clear of the walk', () => {
  const cam = paintingCamera(TRAIN, 1024 / 791), walk = walkOf(TRAIN, cam), o = TRAIN.objects[0];
  const f = flatOf(cam, padBox(o.box, 1024 / 791, 6), rowDistance(cam, o.box[3])), half = (f.right - f.left) / 2;
  assert.equal(slideScale(cam, f.foot, walk), 1, 'the train stands where it was put');
  const cap = turnCap(cam, walk, f.foot, half);
  assert.ok(cap > 0.3 && cap < 0.6, `about 26 degrees (${cap * 180 / Math.PI})`);
  // its plane turned to every eye along the walk: the segment through its foot, never within 0.5 eye heights of the walk
  const nearest = (y) => {
    let m = Infinity;
    for (let q = 0; q <= 60; q++) { const x = f.left + (f.right - f.left) * q / 60; m = Math.min(m, pathGap(walk, f.foot[0] + x * Math.cos(y), f.foot[2] - x * Math.sin(y))); }
    return m;
  };
  let uncapped = Infinity;
  for (const p of walk) {
    const eye = [p[0], EYE, p[2]];
    assert.ok(nearest(turnYaw(cam, f.foot, eye, cap)) >= 0.5 * EYE - 1e-6, `clear of the walk seen from ${p[0].toFixed(1)}`);
    uncapped = Math.min(uncapped, nearest(turnYaw(cam, f.foot, eye)));
  }
  assert.ok(uncapped < 0.01, `turned all the way it would lie across the walk (${uncapped})`);
  // capped, it still turns toward the eye as far as it may, either face; from the painting camera not at all
  const eye = [20, EYE, walk[0][2]], y = turnYaw(cam, f.foot, eye, cap);
  close(Math.abs(y), cap, 1e-9, 'as far as it may');
  assert.ok(Math.sign(y) === Math.sign(turnYaw(cam, f.foot, eye)), 'toward the eye');
  assert.equal(turnYaw(cam, f.foot, cam.position, cap), 0);
  close(turnYaw(cam, [0, 0, -10], [10, EYE, -40], 0.2), Math.PI - 0.2, 1e-9, 'behind it: its back turns to the eye, as far as it may');
  assert.equal(turnCap(cam, walk, [0, 0, -120], 3), Math.PI, 'narrow and far from the walk: free');
  assert.equal(turnCap(cam, walk, [0, 0, walk[0][2]], 3), 0, 'its foot on the walk: it stays square to the picture');
  for (const bad of [null, [NaN, 0, 0]]) assert.equal(turnCap(cam, walk, bad, 3), Math.PI);
  assert.equal(turnYaw(cam, f.foot, eye, NaN), turnYaw(cam, f.foot, eye), 'no cap');
});

test("hides: a flat between the eye and a point hides it; one beside, beyond, or the point's own does not", () => {
  const flat = { left: -2, right: 2, height: 3 }, foot = [0, 0, -10], eye = [0, EYE, 0];
  assert.equal(hides(flat, foot, 0, 1, eye, [0, 1, -30]), true, 'square on, in the way');
  assert.equal(hides(flat, foot, 0, 1, eye, [0, 20, -30]), false, 'over its top');
  assert.equal(hides(flat, foot, 0, 1, eye, [10, 1, -30]), false, 'past its side');
  assert.equal(hides(flat, foot, 0, 1, eye, [0, 1, -5]), false, 'nearer than it');
  assert.equal(hides(flat, foot, 0, 1, eye, [0, 1.5, -10]), false, 'on it: its own centre');
  assert.equal(hides(flat, foot, 0, 2, eye, [0, 5, -30]), true, 'scaled up it reaches higher');
  assert.equal(hides(flat, foot, Math.PI / 2, 1, eye, [0, 1, -30]), false, 'edge on to the line of sight');
  assert.equal(hides(flat, foot, 0.6, 1, eye, [0, 1, -30]), true, 'turned, still across it');
  for (const bad of [[null, foot], [flat, null], [flat, [NaN, 0, 0]]]) assert.equal(hides(bad[0], bad[1], 0, 1, eye, [0, 1, -30]), false);
  assert.equal(hides(flat, foot, 0, 0, eye, [0, 1, -30]), false, 'no scale');
});

test("isDeck: the bridge the steam train's walk runs along lies on the floor; no sample object does", () => {
  const pp = (scene) => pathPoints(scene, () => 0, 8);
  assert.deepEqual(TRAIN.objects.filter((o) => isDeck(o, pp(TRAIN))).map((o) => o.label), ['bridge and river']);
  for (const scene of [TURNER, SKETCH, STARRY]) for (const o of scene.objects) assert.equal(isDeck(o, pp(scene)), false, o.label);
  const bridge = TRAIN.objects[1], along = (row) => [[0.1, 1 - row / 1000], [0.5, 1 - row / 1000], [0.9, 1 - row / 1000]];
  assert.equal(isDeck(bridge, along(700)), true, 'within 15% of its height of its top');
  assert.equal(isDeck(bridge, along(800)), false, 'the walk crosses its middle: in front of it or behind');
  assert.equal(isDeck({ box: [300, 672, 700, 937] }, along(680)), false, 'narrow');
  assert.equal(isDeck(bridge, [[0.5, 0.32]]), false, 'one path point over it');
  assert.equal(isDeck(bridge, [[0.02, 0.32], [0.98, 0.32]]), false, 'none over its columns');
  for (const bad of [null, 'x', [[NaN, 0.3], [null]]]) assert.equal(isDeck(bridge, bad), false);
  assert.equal(isDeck(null, along(680)), false);
});
