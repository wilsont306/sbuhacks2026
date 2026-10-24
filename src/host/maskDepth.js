// A validated scene (Gemini's objects, masks and ground path) turned into what the relief renderer already takes:
// a depth map in depth.js's format, path.json-style [u, v, h] points and one hotspot per object.
// Pure (no THREE) so node:test runs it. Image space is 0..1000 with y top-down; the depth map's row j is
// v = (j + 0.5) / h, bottom-up like texture UV, values 0 far .. 1 near. Scene depth runs the other way (0 = nearest).
import { MIN_T, HOTSPOT_HALF_WIDTH } from '../shared/protocol.js';

const HORIZON = 0.62; // v where the prototype's sky meets its ground
const SURFACES = new Set(['sky', 'ground', 'water']); // planes that recede: keep half the gradient so they are not flat cards
const SURFACE_MIX = 0.5;
const FLAT_PATH = [[50, 850], [950, 850]]; // scene-validate's flat default (x 0..1000), clamped here to U_MIN..U_MAX
const MAX_OBJECTS = 32, MAX_POINTS = 64; // far above the contract's 8 and 24; only a bound on work
const U_MIN = 0.05, U_MAX = 0.95;
// Hotspots stay clear of the staggered start points (scene.js startT reaches MIN_T + 0.072) plus a half-width,
// and two hotspots never overlap (2 half-widths apart). A nudge further than two gaps drops the hotspot instead.
const T_FIRST = MIN_T + 0.11, T_LAST = 1 - HOTSPOT_HALF_WIDTH, T_GAP = 2 * HOTSPOT_HALF_WIDTH, T_NUDGE = 2 * T_GAP;
const ZOOM = 1.3;
const TICK = 1e4; // hotspot t is spaced in integer ticks so rounding can never bring two closer than the gap

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const intIn = (x, dflt, a, b) => (fin(x) ? clamp(Math.round(x), a, b) : dflt);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// The prototype's sky and ground (depth.js depthAt without the Turner features): far sky, ground nearing at the bottom.
function baseDepth(v) {
  if (v > HORIZON) return 0.05 + 0.06 * smooth(0.95, HORIZON, v);
  return 0.11 + 0.80 * Math.pow((HORIZON - v) / HORIZON, 1.25);
}

function area(pts) {
  let a = 0;
  for (let k = 0, n = pts.length; k < n; k++) { const [px, py] = pts[k], [qx, qy] = pts[(k + 1) % n]; a += px * qy - qx * py; }
  return a / 2;
}

// The mask as image-space points, or null when missing, too short or near-zero area (a bowtie cancels to zero).
function maskOf(o) {
  if (!Array.isArray(o.mask)) return null;
  const pts = [];
  for (const p of o.mask.slice(0, MAX_POINTS)) if (Array.isArray(p) && fin(p[0]) && fin(p[1])) pts.push([clamp(p[0], 0, 1000), clamp(p[1], 0, 1000)]);
  return pts.length >= 3 && Math.abs(area(pts)) >= 1 ? pts : null;
}

// [x0, y0, x1, y1] ordered and clamped; the mask's bounds when the box is unusable; null when neither is.
function boxOf(o) {
  const b = o.box;
  let x0, y0, x1, y1;
  if (Array.isArray(b) && b.length === 4 && b.every(fin)) {
    [x0, x1] = [Math.min(b[0], b[2]), Math.max(b[0], b[2])].map((x) => clamp(x, 0, 1000));
    [y0, y1] = [Math.min(b[1], b[3]), Math.max(b[1], b[3])].map((y) => clamp(y, 0, 1000));
    if (x1 > x0 && y1 > y0) return [x0, y0, x1, y1];
  }
  const m = maskOf(o);
  if (!m) return null;
  x0 = Math.min(...m.map((p) => p[0])); x1 = Math.max(...m.map((p) => p[0]));
  y0 = Math.min(...m.map((p) => p[1])); y1 = Math.max(...m.map((p) => p[1]));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

const objectsOf = (scene) => (isObj(scene) && Array.isArray(scene.objects) ? scene.objects.slice(0, MAX_OBJECTS) : []);

// Paintable layers, far first so nearer ones overwrite them (the sort is stable, so ties keep scene order).
function layers(scene) {
  const out = [];
  objectsOf(scene).forEach((o, index) => {
    if (!isObj(o)) return;
    const box = boxOf(o);
    if (!box) return;
    const [x0, y0, x1, y1] = box, depth = fin(o.depth) ? clamp(o.depth, 0, 1) : 1 - y1 / 1000;
    const pts = maskOf(o) || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    out.push({ index, pts, depth, near: 1 - depth, surface: SURFACES.has(o.kind) });
  });
  return out.sort((a, b) => b.depth - a.depth);
}

// Even-odd scanline fill of an image-space polygon into the bottom-up map. Half-open edge spans count a vertex on the
// scanline once, so concave, self-touching and self-crossing outlines all fill with no special case and no throw.
function fillPolygon(data, w, h, pts, rowValue) {
  const xs = [];
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h, y = (1 - v) * 1000;
    xs.length = 0;
    for (let k = 0, n = pts.length; k < n; k++) {
      const [px, py] = pts[k], [qx, qy] = pts[(k + 1) % n];
      if ((py <= y) !== (qy <= y)) xs.push(px + (y - py) / (qy - py) * (qx - px));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const value = rowValue(v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // pixels whose centre (i + 0.5) / w * 1000 lies in [xs[k], xs[k + 1])
      const i0 = Math.max(0, Math.ceil(xs[k] / 1000 * w - 0.5)), i1 = Math.min(w, Math.ceil(xs[k + 1] / 1000 * w - 0.5));
      if (i1 > i0) data.fill(value, j * w + i0, j * w + i1);
    }
  }
}

// One separable box pass with running sums, averaging only in-bounds pixels (the same edge rule as depth.js).
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0, n = 0;
    for (let k = 0; k <= r && k < w; k++) { acc += src[row + k]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      if (x + r + 1 < w) { acc += src[row + x + r + 1]; n++; }
      if (x - r >= 0) { acc -= src[row + x - r]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let k = 0; k <= r && k < h; k++) { acc += tmp[k * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      if (y + r + 1 < h) { acc += tmp[(y + r + 1) * w + x]; n++; }
      if (y - r >= 0) { acc -= tmp[(y - r) * w + x]; n--; }
    }
  }
  return out;
}

export function sceneDepth(scene, opts) {
  const o = isObj(opts) ? opts : {};
  const w = intIn(o.w, 256, 2, 2048), h = intIn(o.h, 192, 2, 2048), r = intIn(o.blurRadius, 3, 0, 32);
  let data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) data.fill(baseDepth((j + 0.5) / h), j * w, (j + 1) * w);
  for (const { pts, near, surface } of layers(scene)) {
    fillPolygon(data, w, h, pts, surface ? (v) => baseDepth(v) * (1 - SURFACE_MIX) + near * SURFACE_MIX : () => near);
  }
  // two box passes (r, then about 2r/3) approach a Gaussian, as placeholderDepth does with 3 then 2
  if (r > 0) data = boxBlur(boxBlur(data, w, h, r), w, h, Math.max(1, Math.round(r * 2 / 3)));
  for (let k = 0; k < data.length; k++) data[k] = Number.isFinite(data[k]) ? clamp(data[k], 0, 1) : 0;
  return { data, w, h, placeholder: false };
}

// Which object owns each pixel, for the shader's per-object motion: i + 1 for scene.objects[i], 0 for none. Same rows,
// fill and painting order as sceneDepth, unblurred so ids never mix at the edges.
export function objectIdMap(scene, opts) {
  const o = isObj(opts) ? opts : {};
  const w = intIn(o.w, 256, 2, 2048), h = intIn(o.h, 192, 2, 2048), data = new Uint8Array(w * h);
  for (const { index, pts } of layers(scene)) fillPolygon(data, w, h, pts, () => index + 1);
  return { data, w, h };
}

// ground_path as an image-space polyline: x clamped to the walkable u range, repeats dropped, starting at the left
// end (the near end when it runs straight up), or the flat default when fewer than two distinct points remain.
function groundPolyline(scene) {
  const raw = isObj(scene) && Array.isArray(scene.ground_path) ? scene.ground_path.slice(0, MAX_POINTS) : [];
  const pts = [];
  let len = 0;
  for (const p of raw) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1])) continue;
    const q = [clamp(p[0], U_MIN * 1000, U_MAX * 1000), clamp(p[1], 0, 1000)], last = pts[pts.length - 1];
    const d = last ? Math.hypot(q[0] - last[0], q[1] - last[1]) : Infinity;
    if (d > 1e-6) { pts.push(q); if (last) len += d; }
  }
  if (pts.length < 2 || len < 1) return FLAT_PATH.map((p) => [...p]);
  const a = pts[0], b = pts[pts.length - 1];
  if (a[0] > b[0] || (a[0] === b[0] && a[1] < b[1])) pts.reverse();
  return pts;
}

// n points evenly spaced along the polyline's length, ends included.
function resample(pts, n) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const total = cum[cum.length - 1], out = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = total * k / (n - 1);
    while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
    const len = cum[seg + 1] - cum[seg], f = len > 0 ? clamp((s - cum[seg]) / len, 0, 1) : 0, [ax, ay] = pts[seg], [bx, by] = pts[seg + 1];
    out.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
  }
  return out;
}

export function pathPoints(scene, sample, n = 8) {
  const count = intIn(n, 8, 2, 64);
  const height = (u, v) => {
    try { const x = typeof sample === 'function' ? sample(u, v) : NaN; return fin(x) ? clamp(x, 0, 1) : 0.5; } catch { return 0.5; }
  };
  return resample(groundPolyline(scene), count).map(([x, y]) => {
    const u = round4(clamp(x / 1000, U_MIN, U_MAX)), v = round4(clamp(1 - y / 1000, 0, 1));
    return [u, v, round4(height(u, v))];
  });
}

// The path parameter of the polyline point nearest (u, v), in the index parameterisation scene.js's curve uses
// (point k sits at t = k / (n - 1)); pathPoints spaces points evenly, so that is also the fraction of the length.
function nearestT(line, u, v) {
  let best = Infinity, t = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k], [bx, by] = line[k + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? clamp(((u - ax) * dx + (v - ay) * dy) / l2, 0, 1) : 0;
    const d = (ax + f * dx - u) ** 2 + (ay + f * dy - v) ** 2;
    if (d < best) { best = d; t = (k + f) / (line.length - 1); }
  }
  return t;
}

const labelOf = (o) => (typeof o.label === 'string' && o.label.trim() ? o.label.trim() : typeof o.kind === 'string' && o.kind ? o.kind : 'object').slice(0, 40);

// 1D label placement in integer ticks (sorted wants in, positions out): each run of crowded hotspots is spread `gap`
// apart around its mean and kept inside [lo, hi]; runs that then overlap merge and are spread again.
function layout(want, lo, hi, gap) {
  const groups = [], start = (g) => clamp(Math.round(g.sum / g.n - gap * (g.n - 1) / 2), lo, hi - gap * (g.n - 1));
  for (const w of want) {
    groups.push({ sum: w, n: 1 });
    while (groups.length > 1) {
      const a = groups[groups.length - 2], b = groups[groups.length - 1];
      if (start(a) + a.n * gap <= start(b)) break;
      a.sum += b.sum; a.n += b.n; groups.pop();
    }
  }
  return groups.flatMap((g) => Array.from({ length: g.n }, (_, k) => start(g) + k * gap));
}

// Admit hotspots in scene order (earlier objects keep theirs on a crowded stretch) while the laid-out set still fits:
// every one inside [lo, hi] and within `nudge` of its object. Extras are dropped rather than overlapped.
function spread(spots, lo, hi, gap, nudge) {
  let keep = [], ticks = [];
  for (const s of spots) {
    const trial = [...keep, s].sort((a, b) => a.want - b.want || a.index - b.index), t = layout(trial.map((x) => x.want), lo, hi, gap);
    if (t.every((x, i) => x >= lo && Math.abs(x - trial[i].want) <= nudge)) { keep = trial; ticks = t; }
  }
  return keep.map((s, i) => ({ ...s, tick: ticks[i] }));
}

export function objectHotspots(scene, points) {
  const line = Array.isArray(points) ? points.filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])) : [];
  if (line.length < 2) return [];
  const spots = [];
  objectsOf(scene).forEach((o, index) => {
    if (!isObj(o)) return;
    const box = boxOf(o);
    if (!box) return;
    const [x0, y0, x1, y1] = box, t = nearestT(line, (x0 + x1) / 2000, 1 - y1 / 1000); // the box's bottom-centre
    spots.push({ index, label: labelOf(o), want: Math.round(clamp(t, T_FIRST, T_LAST) * TICK), look: [round4((x0 + x1) / 2000), round4(1 - (y0 + y1) / 2000)], zoom: ZOOM });
  });
  return spread(spots, Math.round(T_FIRST * TICK), Math.round(T_LAST * TICK), Math.round(T_GAP * TICK), Math.round(T_NUDGE * TICK))
    .map(({ index, label, tick, look, zoom }) => ({ index, label, t: tick / TICK, look, zoom }));
}
