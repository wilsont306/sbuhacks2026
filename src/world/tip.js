// Tour into the Picture: the geometry that turns a validated scene's picture into a walkable diorama (diorama.js
// builds the meshes). Pure math, no THREE, so node:test checks it. Image space is the scene's: 0..1000 on both axes,
// x right, y down. World space is metres: a floor at y = 0, x right, +z toward the viewer. The painting camera stands
// at x 0, z 0, EYE above the floor, and looks along -z, pitched just enough to put the horizon on its row; a plain
// perspective camera with its {position, lookAt, fov, aspect} therefore sees exactly the picture.
// No ?. or ?? here: the phone's inside view imports this file (iOS 13).

export const EYE = 1.6;                                // the painting camera's height above the floor, and the walker's eye
export const BACKDROP = ['sky', 'cloud', 'celestial']; // stay painted on the back wall
export const FLOOR_KINDS = ['ground', 'water'];        // lie on the floor; a standing flat of a river would be a wall
const GROUNDED = ['ground', 'building', 'plant', 'person', 'animal', 'vehicle', 'water'];
const HORIZON_MIN = 300, HORIZON_MAX = 700, HORIZON_DEFAULT = 450;
const HORIZON_MARGIN = 40; // the horizon sits this far above the farthest foot, so that object still stands
const WALL_GAP = 12;       // the back wall's foot is this many rows below the horizon (the floor ends there)
const WALK_GAP = 20;       // the walker keeps this many rows clear of the wall's foot
const FOV_V = 50, FOV_WIDE = 110; // vertical field of view, narrowed for wide pictures so the horizontal one stays under FOV_WIDE
const RAD = Math.PI / 180;

const fin = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const okBox = (b) => Array.isArray(b) && b.length === 4 && b.every(fin) && b[2] > b[0] && b[3] > b[1];

// The horizon row: the highest foot (y1) among things that stand on the ground, less a margin, clamped to 300..700.
export function horizonRow(scene) {
  const objs = isObj(scene) && Array.isArray(scene.objects) ? scene.objects.slice(0, 32) : [];
  let top = Infinity;
  for (const o of objs) {
    if (isObj(o) && GROUNDED.indexOf(o.kind) >= 0 && okBox(o.box)) top = Math.min(top, o.box[3]);
  }
  return top === Infinity ? HORIZON_DEFAULT : clamp(Math.round(top - HORIZON_MARGIN), HORIZON_MIN, HORIZON_MAX);
}

// The camera the picture was painted from. aspect is the picture's width / height in pixels.
export function paintingCamera(scene, aspect) {
  const A = fin(aspect) && aspect > 0 ? clamp(aspect, 0.25, 4) : 4 / 3;
  const horizon = horizonRow(scene);
  const th = Math.min(Math.tan(FOV_V / 2 * RAD), Math.tan(FOV_WIDE / 2 * RAD) / A), tx = th * A;
  // A level ray lands on ndc y = -tan(pitch) / th; solve for the pitch that puts it on the horizon row.
  const pitch = Math.atan(-(1 - horizon / 500) * th), s = Math.sin(pitch), c = Math.cos(pitch);
  const cam = {
    aspect: A, horizon, wallRow: horizon + WALL_GAP, eye: EYE, th, tx, pitch, fov: 2 * Math.atan(th) / RAD,
    position: [0, EYE, 0], lookAt: [0, EYE + 10 * s, -10 * c],
    right: [1, 0, 0], up: [0, c, s], back: [0, -s, c], // the camera basis (it looks along -back)
    nearDist: 0, farDist: 0,
  };
  cam.nearDist = rowDistance(cam, 1000);   // the floor seen at the picture's bottom edge
  cam.farDist = rowDistance(cam, cam.wallRow); // the back wall
  return cam;
}

// World direction (not normalised) of the ray through image point (x, y).
export function rayAt(cam, x, y) {
  const nx = (x / 500 - 1) * cam.tx, ny = (1 - y / 500) * cam.th;
  return [nx * cam.right[0] + ny * cam.up[0] - cam.back[0], nx * cam.right[1] + ny * cam.up[1] - cam.back[1], nx * cam.right[2] + ny * cam.up[2] - cam.back[2]];
}

// Image point [x, y] of world point p through the painting camera, or null behind it.
export function project(cam, p) {
  if (!Array.isArray(p) || !p.every(fin)) return null;
  const r = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const dot = (a) => a[0] * r[0] + a[1] * r[1] + a[2] * r[2];
  const d = -dot(cam.back);
  if (!(d > 1e-9)) return null;
  return [500 * (1 + dot(cam.right) / (d * cam.tx)), 500 * (1 - dot(cam.up) / (d * cam.th))];
}

// The floor point [X, 0, Z] seen at image point (x, y), or null at or above the horizon.
export function imageToFloor(cam, x, y) {
  if (!fin(x) || !fin(y)) return null;
  const w = rayAt(cam, x, y);
  if (!(w[1] < -1e-9)) return null;
  const s = -cam.eye / w[1];
  return [s * w[0], 0, s * w[2]];
}

// How far ahead (-z) the floor seen on image row y lies; Infinity at or above the horizon. Rows of the floor are level
// lines across the picture, so the column does not matter.
export function rowDistance(cam, y) {
  const p = imageToFloor(cam, 500, y);
  return p ? -p[2] : Infinity;
}

// The point seen at image point (x, y) on the upright plane z = -D facing the camera, or null.
export function planePoint(cam, x, y, D) {
  if (!fin(x) || !fin(y) || !fin(D) || !(D > 0)) return null;
  const w = rayAt(cam, x, y);
  if (!(w[2] < -1e-9)) return null;
  const s = -D / w[2];
  return [s * w[0], cam.eye + s * w[1], -D];
}

// A path point in texture UV (u right, v bottom-up, as maskDepth.pathPoints and the TV's curve use) as an image point
// [x, y] kept on the floor and clear of the back wall.
export function uvToImage(cam, u, v) {
  return [clamp(fin(u) ? u * 1000 : 500, 0, 1000), clamp(fin(v) ? (1 - v) * 1000 : 850, cam.wallRow + WALK_GAP, 1000)];
}

// The same path point on the floor.
export function uvToFloor(cam, u, v) {
  const q = uvToImage(cam, u, v);
  return imageToFloor(cam, q[0], q[1]);
}

// A box grown by rim image units across (and the same pixels down), for a cut-out with a paper border.
export function padBox(box, aspect, rim) {
  if (!okBox(box)) return null;
  const A = fin(aspect) && aspect > 0 ? clamp(aspect, 0.25, 4) : 4 / 3, r = fin(rim) ? Math.max(0, rim) : 0;
  return [clamp(box[0] - r, 0, 1000), clamp(box[1] - r * A, 0, 1000), clamp(box[2] + r, 0, 1000), clamp(box[3] + r * A, 0, 1000)];
}

// The standing flat for an image box: an upright rectangle facing the camera, wide and tall enough that its picture
// covers the box, on the floor at its foot row's distance, or at `dist` when given (the depth room's distance, so its
// foot may sit above or below the floor). {foot: [X, Y, Z], distance, left, right, height} with left and right relative
// to the foot, or null when the foot is at or beyond the back wall (it stays painted there).
export function flatOf(cam, box, dist) {
  if (!okBox(box) || !(box[3] > cam.wallRow + 1)) return null;
  const given = fin(dist) && dist > 0, D = given ? dist : rowDistance(cam, box[3]);
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map((q) => planePoint(cam, q[0], q[1], D));
  if (!fin(D) || pts.some((q) => !q)) return null;
  const bottom = given ? pts[2][1] : 0;
  const xMin = Math.min(pts[0][0], pts[2][0]), xMax = Math.max(pts[1][0], pts[3][0]), height = pts[0][1] - bottom;
  if (!(height > 1e-6) || !(xMax > xMin)) return null;
  const X = (xMin + xMax) / 2;
  return { foot: [X, bottom, -D], distance: D, left: xMin - X, right: xMax - X, height };
}

// The room's size: the floor runs from behind the camera (back) to the wall (far); the wall is width wide and
// height tall. Both are twice what the picture shows, so the edges stretch into the margins instead of a void.
export function extentOf(cam) {
  const far = cam.farDist, corners = [[0, 0], [1000, 0]].map((q) => planePoint(cam, q[0], q[1], far));
  const half = corners.every(Boolean) ? Math.max(Math.abs(corners[0][0]), Math.abs(corners[1][0])) : far;
  const top = corners[0] ? corners[0][1] : far;
  return { back: cam.nearDist, far, width: 4 * half, height: 2 * Math.max(top, cam.eye) };
}

// Which way along the path Walk goes (+1 toward increasing t, -1 back) for a look direction (lookX, lookZ) and the
// path's +t tangent (tanX, tanZ) on the floor: the nearer of the two. It switches away from `current` only past
// hysteresisDeg beyond perpendicular, so a look held almost sideways does not flicker. With no current it takes the
// nearer side; a look or tangent with no length keeps current (else +1).
export function walkSign(lookX, lookZ, tanX, tanZ, current, hysteresisDeg) {
  const cur = current === 1 || current === -1 ? current : 0;
  const ll = Math.hypot(lookX, lookZ), tl = Math.hypot(tanX, tanZ);
  const c = (lookX * tanX + lookZ * tanZ) / (ll * tl); // cosine of the look's angle from +t
  if (!(ll > 1e-6) || !(tl > 1e-6) || !fin(c)) return cur || 1;
  const s = Math.sin(clamp(fin(hysteresisDeg) ? hysteresisDeg : 0, 0, 89) * RAD);
  if (cur === 1) return c < -s ? -1 : 1;
  if (cur === -1) return c > s ? 1 : -1;
  return c >= 0 ? 1 : -1;
}

// ---- Standing objects among the walk (diorama.js): where each stands, which way a flat turns, where to look ----
const FAR_SHARE = 0.7;   // nothing stands farther than this share of the back wall's distance...
const PATH_GAP = 1.2;    // ...or nearer the walk than this many eye heights...
const NEAR_SHARE = 0.5;  // ...or nearer the painting camera than this share of the floor at the picture's foot
const SLIDE = 0.01, SLIDES = 240; // a slide tries scales k0 * e^(+-n SLIDE), n up to SLIDES, the smallest move first
const TURN_IN = 0.5;     // flats turn fully to the eye once it is this share of nearDist from the painting camera

// The horizontal distance from (x, z) to the walk, a polyline of world points [x, y, z]; Infinity with no points.
export function pathGap(path, x, z) {
  const pts = Array.isArray(path) ? path : [];
  let best = Infinity;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[Math.min(pts.length - 1, k + 1)], dx = b[0] - a[0], dz = b[2] - a[2], len = dx * dx + dz * dz;
    const s = len > 0 ? clamp(((x - a[0]) * dx + (z - a[2]) * dz) / len, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - a[0] - s * dx, z - a[2] - s * dz));
  }
  return best;
}

// How a standing object at foot [x, y, z] slides to stand sanely by the walk (path, as pathGap's): its foot's x and z
// times k, along its bearing from the painting camera (so it keeps its column in the picture), with k also its scale
// (so its size seen from the painting camera is kept). k is the smallest move at which it stands no farther than
// FAR_SHARE of the back wall's distance, no nearer than NEAR_SHARE of nearDist, and PATH_GAP eye heights plus k *
// radius (a model's footprint; 0 for a flat, which turns to face the walker so never comes nearer than its foot) from
// the walk; 1 when it already does; the nearest to 1 within the room's limits when no k clears the walk.
export function slideScale(cam, foot, path, radius) {
  const D = Array.isArray(foot) ? -foot[2] : NaN, r = fin(radius) ? Math.max(0, radius) : 0;
  if (!(D > 0) || !fin(D) || !fin(foot[0])) return 1;
  const hi = FAR_SHARE * cam.farDist / D, lo = Math.min(hi, NEAR_SHARE * cam.nearDist / D), k0 = clamp(1, lo, hi);
  for (let n = 0; n <= 2 * SLIDES; n++) {
    const k = k0 * Math.exp((n % 2 ? 1 : -1) * Math.ceil(n / 2) * SLIDE); // k0, then a step farther, a step nearer, ...
    if (k >= lo && k <= hi && pathGap(path, k * foot[0], k * foot[2]) >= PATH_GAP * cam.eye + k * r) return k;
  }
  return k0;
}

// How far a flat has turned to the eye (0..1): none at the painting camera, all of the way once the eye is TURN_IN of
// nearDist from it (a smoothstep), so from that camera every flat faces the picture plane and the view is the picture.
// The contact shadows fade in with it.
export function turnWeight(cam, eye) {
  if (!Array.isArray(eye) || !eye.every(fin)) return 0;
  const t = clamp(Math.hypot(eye[0] - cam.position[0], eye[1] - cam.position[1], eye[2] - cam.position[2]) / (TURN_IN * cam.nearDist), 0, 1);
  return t * t * (3 - 2 * t);
}

// The yaw (radians about +y; 0 faces +z, the picture plane) a standing flat at foot turns to for the eye: toward it
// about its vertical axis, by turnWeight. cap (turnCap), when given, bounds how far its plane swings from the picture
// plane either way (either face may show: a flat is two-sided).
export function turnYaw(cam, foot, eye, cap) {
  const w = turnWeight(cam, eye), y = w ? w * Math.atan2(eye[0] - foot[0], eye[2] - foot[2]) : 0;
  if (!fin(cap) || !(cap < Math.PI / 2)) return y;
  const l = y - Math.PI * Math.round(y / Math.PI); // the plane's swing, -PI/2..PI/2
  return y - l + clamp(l, -Math.max(0, cap), Math.max(0, cap));
}

// How far (radians) a flat half wide (half its scaled width) standing at foot may swing from the picture plane before
// an edge could come within TURN_CLEAR eye heights of the walk (path, as pathGap's): a wide flat beside the walk turned
// to the eye would otherwise lie across the walk ahead. PI when it cannot reach.
const TURN_CLEAR = 0.5;
export function turnCap(cam, path, foot, half) {
  const g = Array.isArray(foot) ? pathGap(path, foot[0], foot[2]) - TURN_CLEAR * cam.eye : NaN;
  if (!fin(g) || !(half > 0)) return Math.PI;
  return half > g ? Math.asin(Math.max(0, g) / half) : Math.PI;
}

// Whether a standing flat (flatOf's {left, right, height}) at foot, turned by yaw and scaled by k, hides point from the
// eye: the segment between them passes through it, short of point (a point on the flat itself is not hidden by it).
export function hides(flat, foot, yaw, k, eye, point) {
  if (!flat || !(k > 0) || ![foot, eye, point].every((p) => Array.isArray(p) && p.every(fin)) || !fin(yaw)) return false;
  const s = Math.sin(yaw), c = Math.cos(yaw), d = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
  const den = s * d[0] + c * d[2], t = (s * (foot[0] - eye[0]) + c * (foot[2] - eye[2])) / den; // along the segment to the flat's plane
  if (!(Math.abs(den) > 1e-9) || !(t > 1e-3 && t < 0.98)) return false;
  const x = ((eye[0] + t * d[0] - foot[0]) * c - (eye[2] + t * d[2] - foot[2]) * s) / k, y = (eye[1] + t * d[1] - foot[1]) / k;
  return x >= flat.left && x <= flat.right && y >= 0 && y <= flat.height;
}

// A wide standing object whose top edge the walk runs along (Gemini puts the path on a bridge's deck): at least DECK_W
// across, with every path point over its columns (path: [u, v] texture UV, as maskDepth.pathPoints) within DECK_TOL of
// its height from its top edge, and at least two of them. diorama.js lays it on the floor, painted where it is under
// the walk and whatever rides on it, rather than stand it up as a flat at its foot's distance, far from both.
const DECK_W = 600, DECK_TOL = 0.15;
export function isDeck(o, path) {
  if (!isObj(o) || !okBox(o.box) || o.box[2] - o.box[0] < DECK_W) return false;
  const tol = DECK_TOL * (o.box[3] - o.box[1]);
  let n = 0;
  for (const p of Array.isArray(path) ? path : []) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1])) continue;
    const x = p[0] * 1000, y = (1 - p[1]) * 1000;
    if (x < o.box[0] || x > o.box[2]) continue;
    if (Math.abs(y - o.box[1]) > tol) return false;
    n++;
  }
  return n >= 2;
}

// Where the view looks to face object o (inside.js turns to it at its stop): a standing object's centre (stand: {foot,
// height, scale}, its flat's height before scaling); a backdrop object's box centre on the back wall; anything else
// the room's surface seen at its box centre: the relief with a fit and its (filled) depth, else the floor, or the
// wall where the floor has ended.
export function lookPoint(cam, o, stand, fit, depth) {
  if (stand) return [stand.foot[0], stand.foot[1] + stand.scale * stand.height / 2, stand.foot[2]];
  const cx = (o.box[0] + o.box[2]) / 2, cy = (o.box[1] + o.box[3]) / 2;
  const wall = planePoint(cam, cx, cy, cam.farDist) || [0, cam.eye, -cam.farDist];
  if (BACKDROP.indexOf(o.kind) >= 0) return wall;
  if (fit && okDepth(depth)) return planePoint(cam, cx, cy, distanceAt(fit, sampleDepth(depth, cx, cy))) || wall;
  return cy > cam.wallRow ? imageToFloor(cam, cx, cy) : wall;
}

// The ground's height at world (x, z): 0 on the plain floor (no fit); in the depth room, where the vertical line there
// meets the relief, its terrain read from the (filled) depth: up that line's image from the picture's foot to the first
// point whose relief is as far as the line, between the two rows either side. A line nearer than the relief at the
// picture's foot takes the relief's height there; one beyond all of it, 0.
export function groundHeight(cam, fit, depth, x, z) {
  const D = -z;
  if (!fit || !okDepth(depth) || !fin(x) || !(D > 0) || !fin(D)) return 0;
  const p0 = project(cam, [x, 0, z]), p1 = project(cam, [x, cam.eye, z]);
  if (!p0 || !p1 || !(Math.abs(p1[1] - p0[1]) > 1e-9)) return 0;
  const colAt = (y) => clamp(p0[0] + (y - p0[1]) * (p1[0] - p0[0]) / (p1[1] - p0[1]), 0, 1000);
  const distAt = (y) => distanceAt(fit, sampleDepth(depth, colAt(y), y));
  const step = 1000 / depth.h, heightAt = (y, d) => { const q = planePoint(cam, colAt(y), y, d); return q ? q[1] : 0; };
  let y0 = 1000, d0 = distAt(y0);
  if (d0 >= D) return heightAt(y0, d0);
  for (let y = 1000 - step; y >= 0; y -= step) {
    const d = distAt(y);
    if (d >= D) return heightAt(y0 + (y - y0) * (D - d0) / (d - d0), D);
    y0 = y; d0 = d;
  }
  return 0;
}

// ---- The depth room (README, Inside view): the same room re-shaped by a depth picture ----
// depth (D1): {data: Uint8Array, one byte per pixel, rows top first, w, h}, 255 nearest, Depth Anything V2's relative
// inverse depth min-max normalised over the picture. On the floor inverse depth is affine in that value, so a line
// fitted from the value to TIP's own 1/rowDistance gives every pixel a distance in the room's metres.
const FIT_MARGIN = 30;  // floor samples start this many rows below the horizon, where the floor still resolves
const FIT_SAMPLES = 20000, FIT_MIN = 64, FIT_TRIM = 0.2, MIN_R2 = 0.5;
const NEAR_K = 0.5;     // the room's nearest point: half the distance of the floor at the picture's foot
const GROW = 0.008;     // a filled outline also takes this share of the width around it (depth bleeds past edges)
const CUT = 1.35;       // corners' distances differing by more than this ratio mark a silhouette: no triangle there
const GRID_COLS = 160, GRID_CELLS = 8000; // relief vertices across at most, and its cells (two triangles each) in all
const PATH_SMOOTH = 3;  // path samples either side in each of the two low-pass passes along the walk

const isInt = (v) => fin(v) && Math.floor(v) === v;
const objectsOf = (scene) => (isObj(scene) && Array.isArray(scene.objects) ? scene.objects.slice(0, 32).filter((o) => isObj(o) && okBox(o.box)) : []);

export function okDepth(d) {
  return isObj(d) && isInt(d.w) && isInt(d.h) && d.w >= 2 && d.h >= 2 && d.w <= 4096 && d.h <= 4096 && !!d.data && d.data.length === d.w * d.h;
}

// An object's outline in image space: its mask, else its box. A mask over less than MASK_SHARE of its box outlines a
// part, not the object (Gemini outlined only a sketched train's roof, 2% of its box, and the rest of the train stayed
// painted far off on the floor), so its box stands in for it too.
const MASK_SHARE = 0.1;
export function shapeOf(o) {
  const b = o.box, box = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], m = o.mask;
  if (!Array.isArray(m) || m.length < 3 || !m.every(Array.isArray)) return box;
  let a = 0;
  for (let k = 0; k < m.length; k++) { const p = m[k], q = m[(k + 1) % m.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2 >= MASK_SHARE * (b[2] - b[0]) * (b[3] - b[1]) ? m : box;
}

// fn(row, i0, i1) for each run of pixels [i0, i1) of a w by h picture whose centres lie inside the outline (even-odd,
// half-open edges, so concave and self-crossing outlines fill with no special case).
function spans(shape, w, h, fn) {
  if (!Array.isArray(shape) || !shape.every((p) => Array.isArray(p) && fin(p[0]) && fin(p[1]))) return;
  let top = Infinity, foot = -Infinity;
  for (const p of shape) { top = Math.min(top, p[1]); foot = Math.max(foot, p[1]); }
  const xs = [];
  for (let j = Math.max(0, Math.floor(top / 1000 * h - 0.5)); j <= Math.min(h - 1, Math.ceil(foot / 1000 * h)); j++) {
    const y = (j + 0.5) / h * 1000;
    xs.length = 0;
    for (let k = 0, n = shape.length; k < n; k++) {
      const p = shape[k], q = shape[(k + 1) % n];
      if ((p[1] <= y) !== (q[1] <= y)) xs.push(p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / 1000 * w - 0.5)), i1 = Math.min(w, Math.ceil(xs[k + 1] / 1000 * w - 0.5));
      if (i1 > i0) fn(j, i0, i1);
    }
  }
}

function maskOf(shapes, w, h) {
  const m = new Uint8Array(w * h);
  for (const s of shapes) spans(s, w, h, (j, i0, i1) => m.fill(1, j * w + i0, j * w + i1));
  return m;
}

// The mask grown by r pixels in every direction (a square).
function grow(m, w, h, r) {
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) if (m[k]) { const i = k % w, row = k - i; a.fill(1, row + Math.max(0, i - r), row + Math.min(w, i + r + 1)); }
  for (let k = 0; k < w * h; k++) {
    if (!a[k]) continue;
    const i = k % w, j = (k - i) / w;
    for (let q = Math.max(0, j - r); q <= Math.min(h - 1, j + r); q++) b[q * w + i] = 1;
  }
  return b;
}

// The depth value (0..255, bilinear) at image point (x, y).
export function sampleDepth(depth, x, y) {
  const data = depth.data, w = depth.w, h = depth.h;
  const px = clamp(x / 1000 * w - 0.5, 0, w - 1), py = clamp(y / 1000 * h - 0.5, 0, h - 1);
  const i = Math.min(w - 2, Math.floor(px)), j = Math.min(h - 2, Math.floor(py)), fx = px - i, fy = py - j, k = j * w + i;
  return (data[k] * (1 - fx) + data[k + 1] * fx) * (1 - fy) + (data[k + w] * (1 - fx) + data[k + w + 1] * fx) * fy;
}

// Least squares y = a x + b over the first n samples (only those with keep[k] when keep is given), and its r2.
function line(xs, ys, n, keep) {
  let m = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    if (keep && !keep[k]) continue;
    const x = xs[k], y = ys[k];
    m++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const dx = m * sxx - sx * sx, dy = m * syy - sy * sy;
  if (m < FIT_MIN || !(dx > 1e-6 * m * m) || !(dy > 1e-12 * m * m)) return null; // a constant depth has no slope
  const c = m * sxy - sx * sy, a = c / dx;
  return { a, b: (sy - a * sx) / m, r2: c * c / (dx * dy) };
}

// The fit 1/rowDistance(cam, y) ~= a * value / 255 + b over floor pixels: rows FIT_MARGIN below the horizon, outside
// every object that is not floor (the standing ones and the backdrop), with one trim pass that drops the worst
// FIT_TRIM by residual. {a, b, r2, near, far}, or null for an unusable depth or a fit that is not a floor (a <= 0, a
// poor r2, too few samples).
export function fitDepth(cam, scene, depth) {
  if (!okDepth(depth)) return null;
  const w = depth.w, h = depth.h, data = depth.data;
  const skip = maskOf(objectsOf(scene).filter((o) => FLOOR_KINDS.indexOf(o.kind) < 0).map(shapeOf), w, h);
  const step = Math.max(1, Math.ceil(Math.sqrt(w * h / FIT_SAMPLES)));
  const xs = new Float64Array(Math.ceil(w / step) * Math.ceil(h / step)), ys = new Float64Array(xs.length);
  let n = 0;
  for (let j = 0; j < h; j += step) {
    const y = (j + 0.5) / h * 1000, inv = 1 / rowDistance(cam, y);
    if (y < cam.horizon + FIT_MARGIN || !(inv > 0)) continue;
    for (let i = 0; i < w; i += step) if (!skip[j * w + i]) { xs[n] = data[j * w + i] / 255; ys[n] = inv; n++; }
  }
  const first = line(xs, ys, n, null);
  if (!first) return null;
  const res = new Float64Array(n), keep = new Uint8Array(n);
  for (let k = 0; k < n; k++) res[k] = Math.abs(ys[k] - first.a * xs[k] - first.b);
  const limit = res.slice().sort()[Math.floor((1 - FIT_TRIM) * (n - 1))];
  for (let k = 0; k < n; k++) keep[k] = res[k] <= limit ? 1 : 0;
  const fit = line(xs, ys, n, keep);
  if (!fit || !(fit.a > 0) || !(fit.r2 >= MIN_R2)) return null;
  return { a: fit.a, b: fit.b, r2: fit.r2, near: NEAR_K * cam.nearDist, far: cam.farDist };
}

// The distance (-z, metres) for a depth value through the fit, clamped to the room: nearer than near is near, a
// non-positive inverse distance or one beyond the back wall is the wall.
export function distanceAt(fit, value) {
  const inv = fit.a * value / 255 + fit.b;
  return inv > 0 ? clamp(1 / inv, fit.near, fit.far) : fit.far;
}

// The depth behind the outlines (the standing flats, which carry their own pixels): each outline, grown by GROW, is
// replaced along every row by a line between the depths just outside it, or by the median of the depths around all
// of them where a row has no outside on either side. Pixels inside the optional walls outlines (the backdrop) are 0
// first, the back wall, as TIP paints the sky: a depth model reads a hazy sky as near. A new D1, or null for an
// unusable depth.
export function fillDepth(depth, shapes, walls) {
  if (!okDepth(depth)) return null;
  const w = depth.w, h = depth.h, out = new Uint8Array(depth.data), hist = new Uint32Array(256);
  for (const s of Array.isArray(walls) ? walls : []) spans(s, w, h, (j, i0, i1) => out.fill(0, j * w + i0, j * w + i1));
  const m = grow(maskOf(Array.isArray(shapes) ? shapes : [], w, h), w, h, Math.max(1, Math.round(GROW * w)));
  let n = 0, med = 0;
  for (let k = 0; k < w * h; k++) {
    const i = k % w;
    if (!m[k] && ((i > 0 && m[k - 1]) || (i < w - 1 && m[k + 1]) || (k >= w && m[k - w]) || (k + w < w * h && m[k + w]))) { hist[out[k]]++; n++; }
  }
  if (!n) return { data: out, w, h }; // nothing to fill, or nothing outside to fill it from
  for (let c = 0, acc = 0; c < 256; c++) { acc += hist[c]; if (acc * 2 >= n) { med = c; break; } }
  for (let j = 0; j < h; j++) {
    const row = j * w;
    for (let i = 0; i < w; i++) {
      if (!m[row + i]) continue;
      let e = i;
      while (e < w && m[row + e]) e++;
      const l = i > 0 ? out[row + i - 1] : -1, r = e < w ? out[row + e] : -1;
      for (let q = i; q < e; q++) out[row + q] = l >= 0 && r >= 0 ? Math.round(l + (r - l) * (q - i + 1) / (e - i + 1)) : l >= 0 ? l : r >= 0 ? r : med;
      i = e;
    }
  }
  return { data: out, w, h };
}

// How far a standing object's flat stands: its median depth inside its outline through the fit; the floor's distance
// at its foot row without a fit or when no depth pixel falls inside. With filled (fillDepth's picture, the relief
// behind the flats, same size) it also stands FRONT nearer than the nearest relief over its outline, so the relief
// never hides it from the painting camera.
const FRONT = 1.03;
export function flatDistance(cam, fit, depth, o, filled) {
  if (!isObj(o) || !okBox(o.box)) return Infinity;
  const foot = rowDistance(cam, o.box[3]), w = fit && okDepth(depth) ? depth.w : 0, hist = new Uint32Array(256);
  const back = w && okDepth(filled) && filled.w === w && filled.h === depth.h ? filled.data : null;
  let n = 0, near = 0, D = foot;
  if (w) {
    spans(shapeOf(o), w, depth.h, (j, i0, i1) => {
      for (let k = j * w + i0; k < j * w + i1; k++) { hist[depth.data[k] & 255]++; n++; if (back) near = Math.max(near, back[k]); }
    });
  }
  for (let c = 0, acc = 0; c < 256 && n; c++) { acc += hist[c]; if (acc * 2 >= n) { D = distanceAt(fit, c); break; } }
  return n && back ? Math.min(D, distanceAt(fit, near) / FRONT) : D;
}

// The relief: a vertex per grid cell over the whole picture (GRID_COLS across at most, about GRID_CELLS cells, square
// in the picture's pixels), each on its own ray at the depth's distance, so the painting camera sees every vertex at
// its own image point; a triangle across a silhouette (CUT) is left out. {position: Float32Array of x, y, z per
// vertex, index: [a, b, c, ...], cols, rows}, or null without a fit or a usable depth.
export function reliefGrid(cam, fit, depth) {
  if (!fit || !okDepth(depth)) return null;
  const cols = Math.min(GRID_COLS, Math.max(2, Math.round(Math.sqrt(GRID_CELLS * cam.aspect)))), rows = Math.max(2, Math.round(cols / cam.aspect));
  const position = new Float32Array(cols * rows * 3), dist = new Float32Array(cols * rows), index = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i / (cols - 1) * 1000, y = j / (rows - 1) * 1000, k = j * cols + i;
      const D = distanceAt(fit, sampleDepth(depth, x, y)), p = planePoint(cam, x, y, D) || [0, cam.eye, -D];
      position[3 * k] = p[0]; position[3 * k + 1] = p[1]; position[3 * k + 2] = p[2]; dist[k] = D;
    }
  }
  const tri = (a, b, c) => { if (Math.max(dist[a], dist[b], dist[c]) <= CUT * Math.min(dist[a], dist[b], dist[c])) index.push(a, b, c); };
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      const k = j * cols + i;
      tri(k, k + cols, k + 1); tri(k + 1, k + cols, k + cols + 1); // counter-clockwise from the painting camera
    }
  }
  return { position, index, cols, rows };
}

// The plate's hole fill (diorama.js): push-pull inpainting. Every pixel of a w by h RGBA picture (rgba, 4 bytes a
// pixel, changed in place) with hole[k] set takes the colours around the hole, coarse to fine: a pyramid of 2x2 means
// over known pixels only (push), then each level's holes from the level above, bilinear (pull). A hole never keeps
// its own colour. strokes (0..1, default 0) adds that share of the brushwork beside the hole (strokesInto). Returns
// false, rgba untouched, when no pixel is known.
const STROKE_LEVEL = 3; // brushwork is what the picture has finer than its means over 8 by 8 pixels
export function pushPull(rgba, w, h, hole, strokes) {
  let lw = w, lh = h, col = new Float32Array(w * h * 3), known = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    if (hole[k]) continue;
    known[k] = 1; col[3 * k] = rgba[4 * k]; col[3 * k + 1] = rgba[4 * k + 1]; col[3 * k + 2] = rgba[4 * k + 2];
  }
  const levels = [{ w, h, col, known }];
  while (lw > 1 || lh > 1) {
    const nw = Math.ceil(lw / 2), nh = Math.ceil(lh / 2), nc = new Float32Array(nw * nh * 3), nk = new Uint8Array(nw * nh);
    for (let j = 0; j < nh; j++) {
      for (let i = 0; i < nw; i++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 2 * j; y < Math.min(lh, 2 * j + 2); y++) {
          for (let x = 2 * i; x < Math.min(lw, 2 * i + 2); x++) {
            const k = y * lw + x;
            if (known[k]) { r += col[3 * k]; g += col[3 * k + 1]; b += col[3 * k + 2]; n++; }
          }
        }
        if (n) { const q = j * nw + i; nc[3 * q] = r / n; nc[3 * q + 1] = g / n; nc[3 * q + 2] = b / n; nk[q] = 1; }
      }
    }
    lw = nw; lh = nh; col = nc; known = nk;
    levels.push({ w: lw, h: lh, col, known });
  }
  if (!known[0]) return false;
  for (let L = levels.length - 2; L >= 0; L--) {
    const f = levels[L], c = levels[L + 1], X = taps(f.w, c.w), Y = taps(f.h, c.h);
    for (let j = 0; j < f.h; j++) {
      const j0 = Y.i0[j] * c.w, j1 = Y.i1[j] * c.w, fy = Y.f[j];
      for (let i = 0, k = j * f.w; i < f.w; i++, k++) if (!f.known[k]) lerp(c, X, i, j0, j1, fy, f.col, 3 * k);
    }
  }
  const out = levels[0].col;
  if (fin(strokes) && strokes > 0 && levels.length > STROKE_LEVEL) strokesInto(out, w, h, hole, levels[STROKE_LEVEL], Math.min(1, strokes));
  for (let k = 0; k < w * h; k++) {
    if (hole[k]) { rgba[4 * k] = Math.round(out[3 * k]); rgba[4 * k + 1] = Math.round(out[3 * k + 1]); rgba[4 * k + 2] = Math.round(out[3 * k + 2]); }
  }
  return true;
}

// Bilinear taps from an axis of n pixels onto a coarser one of m: pixel i reads i0[i] and i1[i], the second weighted f[i].
function taps(n, m) {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = clamp((i + 0.5) * m / n - 0.5, 0, m - 1); i0[i] = Math.floor(x); i1[i] = Math.min(m - 1, i0[i] + 1); f[i] = x - i0[i]; }
  return { i0, i1, f };
}
// Level c's colour at column i (taps X) between row offsets j0 and j1 (j1 weighted fy), into out[o], out[o + 1], out[o + 2].
function lerp(c, X, i, j0, j1, fy, out, o) {
  const a = 3 * (j0 + X.i0[i]), b = 3 * (j0 + X.i1[i]), d = 3 * (j1 + X.i0[i]), e = 3 * (j1 + X.i1[i]), fx = X.f[i], v = c.col;
  for (let ch = 0; ch < 3; ch++) out[o + ch] = (v[a + ch] * (1 - fx) + v[b + ch] * fx) * (1 - fy) + (v[d + ch] * (1 - fx) + v[e + ch] * fx) * fy;
}

// The brushwork beside the holes, carried into them: each known pixel's detail (its colour less the coarse level lo's
// mean there) is mirrored across the ends of each run of hole pixels, along the rows and then, where the rows left
// room, along the columns, fading out over the length of the known stretch it mirrors (or of the run). No seam at a
// hole's edge, and no stretch is ever repeated. The outermost STROKE_EDGE of the picture (a photo's border, the
// canvas edge) lends nothing. col's known pixels are left holding their detail: only its holes are read back.
const STROKE_EDGE = 0.015;
function strokesInto(col, w, h, hole, lo, amount) {
  const X = taps(w, lo.w), Y = taps(h, lo.h), m = new Float32Array(3), cover = new Float32Array(w * h); // m: lerp stays monomorphic
  for (let j = 0; j < h; j++) {
    const j0 = Y.i0[j] * lo.w, j1 = Y.i1[j] * lo.w, fy = Y.f[j];
    for (let i = 0, k = j * w; i < w; i++, k++) {
      if (hole[k]) continue;
      lerp(lo, X, i, j0, j1, fy, m, 0);
      col[3 * k] -= m[0]; col[3 * k + 1] -= m[1]; col[3 * k + 2] -= m[2];
    }
  }
  strokeLines(col, hole, cover, h, w, w, 1, amount);
  strokeLines(col, hole, cover, w, h, 1, w, amount);
}
// One direction of strokesInto: `lines` lines of n pixels, pixel q of line L at L * lineStep + q * step.
function strokeLines(col, hole, cover, lines, n, lineStep, step, amount) {
  const edge = Math.round(STROKE_EDGE * n);
  for (let L = 0; L < lines; L++) {
    const base = L * lineStep;
    for (let i = 0; i < n; i++) {
      if (!hole[base + i * step]) continue;
      let e = i, l0 = i, r1;
      while (e < n && hole[base + e * step]) e++;
      while (l0 > edge && !hole[base + (l0 - 1) * step]) l0--;
      for (r1 = e; r1 < n - edge && !hole[base + r1 * step];) r1++;
      const len = e - i, rl = Math.min(i - l0, len), rr = Math.min(r1 - e, len);
      for (let q = i; q < e && (rl > 0 || rr > 0); q++) {
        const p = base + q * step, dl = q - i, dr = e - 1 - q;
        const wl = rl > 0 ? Math.max(0, 1 - dl / rl) : 0, wr = rr > 0 ? Math.max(0, 1 - dr / rr) : 0, sum = wl + wr;
        if (!(sum > 0) || cover[p] >= 1) continue;
        const free = (1 - cover[p]) * amount / Math.max(1, sum), a = 3 * (base + (i - 1 - dl) * step), b = 3 * (base + (e + dr) * step);
        for (let ch = 0; ch < 3; ch++) col[3 * p + ch] += free * ((wl ? wl * col[a + ch] : 0) + (wr ? wr * col[b + ch] : 0));
        cover[p] += (1 - cover[p]) * Math.min(1, sum);
      }
      i = e;
    }
  }
}

// A moving average of radius r, the ends mirrored through their own value so a straight run stays straight to its end.
function boxPass(a, r) {
  const n = a.length, at = (q) => (q < 0 ? 2 * a[0] - a[Math.min(n - 1, -q)] : q >= n ? 2 * a[n - 1] - a[Math.max(0, 2 * n - 2 - q)] : a[q]);
  return a.map((_, k) => {
    let s = 0;
    for (let q = k - r; q <= k + r; q++) s += at(q);
    return s / (2 * r + 1);
  });
}

// The walk on the relief: each path point [u, v] (texture UV) at its image point's distance in the (filled) depth,
// the inverse distance low-passed along the path (on a floor it runs near linear with the row), as world points
// [X, Y, Z]; the plain floor without a fit.
export function terrainPath(cam, fit, depth, uvs) {
  const pts = (Array.isArray(uvs) ? uvs : []).map((p) => (Array.isArray(p) ? uvToImage(cam, p[0], p[1]) : uvToImage(cam, NaN, NaN)));
  if (!fit || !okDepth(depth)) return pts.map((q) => imageToFloor(cam, q[0], q[1]));
  const soft = boxPass(boxPass(pts.map((q) => 1 / distanceAt(fit, sampleDepth(depth, q[0], q[1]))), PATH_SMOOTH), PATH_SMOOTH);
  return pts.map((q, k) => planePoint(cam, q[0], q[1], 1 / soft[k]));
}
