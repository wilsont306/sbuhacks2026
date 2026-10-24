import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rig, panLimit, leanCap, leanFor, project, corners, groupBox, followAim, focusAim, aimFor, stepView, figH,
  TAG_GAP, TAG_H, FIG_ASPECT, LEAN_Y, ZOOM_MIN, ZOOM_MAX,
} from '../src/host/camera.js';
import { MIN_T } from '../src/shared/protocol.js';
import { sceneDepth, pathPoints, objectHotspots } from '../src/host/maskDepth.js';
import { sampler } from '../src/host/depth.js';
import { validateScene } from '../src/shared/scene-validate.js';

// The stage as scene.js builds it: a 4-unit plane at the painting's aspect, relief up to AMP, a 1447 x 1080 canvas.
const W = 4, H = W / (1920 / 1433), AMP = 0.42, LIFT = 0.015, r = rig(W, H, 1447 / 1080);
const path = JSON.parse(readFileSync(new URL('../public/path.json', import.meta.url), 'utf8'));
const TAG_W = 1.0; // world units; wider than the widest slot name's tag ("Slate Dog-walker", about 0.85)
const STEP = 1 / 60, SPEED = 0.10;

// Uniform Catmull-Rom with tension 0.5 through path.json's points (or P), ends extrapolated (what THREE's curve does).
function curve(t, P = path.points) {
  const l = P.length, p = (l - 1) * Math.min(1, Math.max(0, t));
  let i = Math.floor(p), w = p - i;
  if (i >= l - 1) { i = l - 2; w = 1; }
  const p0 = i > 0 ? P[i - 1] : P[0].map((x, k) => 2 * x - P[1][k]);
  const p3 = i + 2 < l ? P[i + 2] : P[l - 1].map((x, k) => 2 * x - P[l - 2][k]);
  return [0, 1, 2].map((k) => {
    const x0 = P[i][k], x1 = P[i + 1][k], t0 = 0.5 * (P[i + 1][k] - p0[k]), t1 = 0.5 * (p3[k] - P[i][k]);
    return x0 + t0 * w + (-3 * x0 + 3 * x1 - 2 * t0 - t1) * w * w + (2 * x0 - 2 * x1 + t0 + t1) * w * w * w;
  });
}
const figure = (t) => { const [u, v, h] = curve(t); return { t, u, x: (u - 0.5) * W, y: (v - 0.5) * H, z: h * AMP + LIFT, tagged: true }; };

// Every point the visitor must see: body corners and name-tag corners. Tags are lifted clear of each other the way
// scene.js arrangeTags does it and pulled sideways inside the frame, so only their height and width can escape.
function worstNdc(v, figs) {
  const tags = figs.map((f) => ({ f, y: f.y + figH(f.t) + TAG_GAP })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < tags.length; i++) for (let j = 0; j < i; j++) {
    const a = tags[j], b = tags[i];
    if (Math.abs(a.f.x - b.f.x) < TAG_W && b.y - a.y < TAG_H) b.y = a.y + TAG_H * 1.08;
  }
  let m = 0;
  const see = (q) => { const [x, y] = project(r, v, q); m = Math.max(m, Math.abs(x), Math.abs(y)); };
  for (const f of figs) {
    const h = figH(f.t), w = h * FIG_ASPECT / 2;
    for (const [dx, dy] of [[-w, 0], [w, 0], [-w, h], [w, h]]) see([f.x + dx, f.y + dy, f.z]);
  }
  for (const { f, y } of tags) {
    const [l] = project(r, v, [f.x - TAG_W / 2, y, f.z]), [rr] = project(r, v, [f.x + TAG_W / 2, y, f.z]);
    assert.ok(rr - l < 2 * 0.97, 'a name tag is wider than the frame');
    const [, top] = project(r, v, [f.x, y + TAG_H, f.z]), [, bottom] = project(r, v, [f.x, y, f.z]);
    m = Math.max(m, Math.abs(top), Math.abs(bottom));
  }
  return m;
}

test('figures shrink from 1.0 to 0.55 of their height up the bank', () => {
  assert.ok(Math.abs(figH(1) / figH(0) - 0.55) < 1e-12);
});

test('(a) two figures anywhere on the bank stay inside the frame, name tags included, at any lean', () => {
  const N = 85; // t steps of 0.01 over MIN_T..1
  let worst = { m: 0 };
  for (let i = 0; i <= N; i++) for (let j = i; j <= N; j++) {
    const figs = [figure(MIN_T + (1 - MIN_T) * i / N), figure(MIN_T + (1 - MIN_T) * j / N)];
    const aim = followAim(r, groupBox(figs)), cx = (figs[0].u + figs[1].u) / 2;
    for (const mouseX of [-1, 0, 1]) for (const leanY of [-LEAN_Y, 0, LEAN_Y]) {
      const m = worstNdc({ ...aim, lean: leanFor(cx, mouseX, 0, aim.zoom, 1), leanY }, figs);
      if (m > worst.m) worst = { m, t: figs.map((f) => f.t.toFixed(2)), mouseX, leanY, zoom: aim.zoom.toFixed(3) };
    }
  }
  assert.ok(worst.m <= 1, `a figure leaves the frame: ${JSON.stringify(worst)}`);
});

const zooms = () => {
  const zs = path.plaques.map((p) => p.zoom);
  for (let z = ZOOM_MIN; z <= Math.max(...zs) + 1e-9; z += 0.01) zs.push(z); // every zoom a blend passes through
  return zs;
};
function showsStage(v) {
  for (const zp of [0, AMP]) for (const [x, y] of corners(r, v, zp)) if (Math.abs(x) > W / 2 || Math.abs(y) > H / 2) return [x, y, zp];
  return null;
}

test('(b) no reachable pan, zoom and lean shows the stage background', () => {
  for (const zoom of zooms()) {
    const { mx, my } = panLimit(r, zoom), cap = leanCap(zoom);
    for (const tx of [-mx, -mx / 2, 0, mx / 2, mx]) for (const ty of [-my, 0, my])
      for (const lean of [-cap, 0, cap]) for (const leanY of [-LEAN_Y, 0, LEAN_Y]) {
        const v = { tx, ty, zoom, lean, leanY }, hit = showsStage(v);
        assert.equal(hit, null, `stage shows at ${JSON.stringify(v)}: corner ray at ${hit}`);
      }
  }
});

test('(b) the camera only ever reaches those views, whatever it is asked', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cam = { tx: 0, ty: 0, zoom: 1, lean: 0, leanY: 0 }, zs = zooms();
  let aim = { tx: 0, ty: 0, zoom: 1 };
  for (let n = 0; n < 20000; n++) {
    if (n % 90 === 0) aim = { tx: (rnd() - 0.5) * 2 * W, ty: (rnd() - 0.5) * 2 * H, zoom: zs[Math.floor(rnd() * zs.length)] };
    stepView(r, cam, aim, (rnd() - 0.5) * 40, (rnd() - 0.5) * 3 * LEAN_Y * 2, STEP * (0.5 + rnd() * 6));
    const { mx, my } = panLimit(r, cam.zoom);
    assert.ok(cam.zoom >= ZOOM_MIN - 1e-9 && Math.abs(cam.tx) <= mx + 1e-9 && Math.abs(cam.ty) <= my + 1e-9, JSON.stringify(cam));
    assert.ok(Math.abs(cam.lean) <= leanCap(cam.zoom) + 1e-9 && Math.abs(cam.leanY) <= LEAN_Y + 1e-9, JSON.stringify(cam));
    assert.equal(showsStage(cam), null, `stage shows at ${JSON.stringify(cam)}`);
  }
});

test('(c) no pumping: one figure walks away from another and back at constant speed', () => {
  for (const still of [0.2, 0.4, 0.6, 0.8]) for (const end of [MIN_T, 1]) {
    const legs = [], toward = (a, b) => (Math.abs(b - a) > SPEED * STEP ? a + Math.sign(b - a) * SPEED * STEP : b);
    let t = still;
    while (t !== end) legs.push([+1, (t = toward(t, end))]); // scene.js clamps t to MIN_T..1 the same way
    while (t !== still) legs.push([-1, (t = toward(t, still))]);
    const cam = { ...followAim(r, groupBox([figure(still), figure(still)])), lean: 0, leanY: 0 };
    let prev = null, turns = 0, last = 0, prevZoom = cam.zoom;
    for (const [leg, tw] of legs) {
      const figs = [figure(still), figure(tw)], aim = followAim(r, groupBox(figs));
      if (prev) {
        const d = aim.zoom - prev.zoom;
        // walking away the target only falls, walking back it only rises
        assert.ok(leg > 0 ? d <= 1e-12 : d >= -1e-12, `zoom target reversed at t ${tw.toFixed(3)} (still ${still}, leg ${leg}): ${d}`);
      }
      prev = aim;
      stepView(r, cam, aim, 0, 0, STEP);
      const dz = cam.zoom - prevZoom, s = Math.abs(dz) < 1e-9 ? 0 : Math.sign(dz);
      if (s && last && s !== last) turns++;
      if (s) last = s;
      prevZoom = cam.zoom;
    }
    assert.ok(turns <= 1, `the camera zoom changed direction ${turns} times for one turn of the walker (still ${still}, end ${end})`);
  }
});

test('(d) focus frame only while exactly one plaque is owned, then a blend back of about 1.2 s', () => {
  const [loco, bridge] = path.plaques, box = groupBox([figure(0.3), figure(0.7)]), follow = followAim(r, box);
  assert.deepEqual(aimFor(r, [], box), follow);
  assert.deepEqual(aimFor(r, [loco, bridge], box), follow);
  const focus = aimFor(r, [loco], box);
  assert.deepEqual(focus, focusAim(r, loco.look, loco.zoom));
  assert.equal(focus.zoom, loco.zoom);
  // the look point sits mid-frame, or mid the half the panel leaves free
  assert.ok(Math.abs(project(r, { ...focus, lean: 0, leanY: 0 }, [(loco.look[0] - 0.5) * W, (loco.look[1] - 0.5) * H, 0])[0]) < 1e-9);
  const shifted = focusAim(r, loco.look, loco.zoom, 0.43);
  assert.ok(Math.abs(project(r, { ...shifted, lean: 0, leanY: 0 }, [(loco.look[0] - 0.5) * W, (loco.look[1] - 0.5) * H, 0])[0] - 0.43) < 1e-9);

  const cam = { ...focus, lean: 0, leanY: 0 }, gap = (c) => Math.max(...['tx', 'ty', 'zoom'].map((k) => Math.abs(c[k] - follow[k]) / Math.abs(focus[k] - follow[k] || 1)));
  let at06 = 0;
  for (let n = 1; n <= 72; n++) { stepView(r, cam, follow, 0, 0, STEP); if (n === 36) at06 = gap(cam); }
  assert.ok(at06 > 0.05, `the blend back is a cut (${at06.toFixed(3)} left at 0.6 s)`);
  assert.ok(gap(cam) <= 0.05, `the blend back has ${(gap(cam) * 100).toFixed(1)}% left at 1.2 s`);
});

test('(e) a lone figure at any stop of the bundled samples has that object\'s centre in frame, so its glow shows', () => {
  for (const [name, aspect] of [['turner', 1920 / 1433], ['sketch', 1600 / 1200], ['starry-night', 1920 / 1520]]) {
    const s = validateScene(JSON.parse(readFileSync(new URL(`../public/samples/${name}.scene.json`, import.meta.url), 'utf8')));
    const pts = pathPoints(s, sampler(sceneDepth(s))), w = H * aspect, rr = rig(w, H, 1447 / 1080);
    for (const st of objectHotspots(s, pts)) {
      const [u, v] = curve(st.t, pts), look = [(st.look[0] - 0.5) * w, (st.look[1] - 0.5) * H];
      const aim = followAim(rr, groupBox([{ x: (u - 0.5) * w, y: (v - 0.5) * H, t: st.t, tagged: true }], [look]));
      for (const mouseX of [-1, 0, 1]) for (const leanY of [-LEAN_Y, 0, LEAN_Y]) {
        const [nx, ny] = project(rr, { ...aim, lean: leanFor(u, mouseX, 0, aim.zoom, 1), leanY }, [...look, 0]);
        assert.ok(Math.abs(nx) <= 1 && Math.abs(ny) <= 1, `${name}: ${st.label} at t ${st.t} is off screen (${nx.toFixed(2)}, ${ny.toFixed(2)})`);
      }
    }
  }
});
