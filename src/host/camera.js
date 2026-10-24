// The follow and focus camera as plain numbers (no THREE), so tests/camera.test.js can sweep every reachable view.
// World units: the painting is a W x H plane centred on the origin at z = 0, its relief rising toward the camera (+z).
// A view {tx, ty, zoom, lean, leanY}: the camera sits base / zoom from the target (tx, ty, 0), swung `lean` degrees
// sideways and `leanY` up, and looks at the target with +y up, as THREE's lookAt builds it.
export const FOV = 30, OVERSCAN = 1.1, ZOOM_MIN = 1, ZOOM_MAX = 1.35;
// Degrees. 10 sideways plus 2.5 vertical is the most the 10% overscan hides at zoom 1 (3 vertical showed the corner).
export const LEAN_MAX = 10, LEAN_GROUP = 6, LEAN_MOUSE = 4, LEAN_Y = 2.5, LEAN_OFF = 1.8;
export const FIG_ASPECT = 256 / 384, TAG_GAP = 0.02, TAG_H = 0.13; // figures.js frames; name tag above the head
export const figH = (t) => 0.33 * (1 - 0.45 * t); // figures shrink to 0.55 of their height up the bank
const PAD_X = 0.9, PAD_Y = 0.7; // painting kept around the group, world units
const RAD = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };

export function rig(W, H, aspect) {
  const tan = Math.tan(FOV / 2 * RAD);
  return { W, H, aspect, tan, base: H / 2 / tan / OVERSCAN }; // zoom 1 shows 1 / OVERSCAN of the plane; the rest is lean margin
}

// Pan range: the frame OVERSCAN times the real one stays on the plane, so panning never eats the lean margin.
export function panLimit(r, zoom) {
  const hh = r.H / 2 / zoom;
  return { mx: Math.max(0, r.W / 2 - hh * r.aspect), my: Math.max(0, r.H / 2 - hh) };
}

const fade = (zoom) => clamp((LEAN_OFF - zoom) / (LEAN_OFF - 1), 0, 1);
export const leanCap = (zoom) => LEAN_MAX * fade(zoom);
// Sideways lean from the group centroid (cx, 0..1 across the painting), the mouse (-1..1) and any extra (the attract
// sway), at most LEAN_MAX, faded out by zoom LEAN_OFF; `still` is 1, or a quarter under reduced motion.
export const leanFor = (cx, mouseX, extra, zoom, still) =>
  clamp(LEAN_GROUP * (cx - 0.5) * 2 + mouseX * LEAN_MOUSE + extra, -LEAN_MAX, LEAN_MAX) * fade(zoom) * still;

export function pose(r, v) {
  const d = r.base / v.zoom, ax = v.lean * RAD, ay = v.leanY * RAD;
  return [v.tx + Math.sin(ax) * d, v.ty + Math.sin(ay) * d, Math.cos(ax) * Math.cos(ay) * d];
}

function basis(r, v) {
  const p = pose(r, v), z = unit([p[0] - v.tx, p[1] - v.ty, p[2]]), x = unit(cross([0, 1, 0], z));
  return { p, x, y: cross(z, x), z };
}

// Normalised device coordinates of a world point: inside the frame when both are within -1..1.
export function project(r, v, q) {
  const { p, x, y, z } = basis(r, v), d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], depth = -dot(d, z);
  return [dot(d, x) / (depth * r.tan * r.aspect), dot(d, y) / (depth * r.tan)];
}

// Where the four frustum corner rays cross the plane z = zp.
export function corners(r, v, zp = 0) {
  const { p, x, y, z } = basis(r, v);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const d = [0, 1, 2].map((i) => -z[i] + a * r.tan * r.aspect * x[i] + b * r.tan * y[i]), s = (zp - p[2]) / d[2];
    return [p[0] + s * d[0], p[1] + s * d[1]];
  });
}

// Bodies and name tags of the group ({x, y, t, tagged}, feet at x, y). Heights come from t alone, never the sprite's
// scale, so the join pulse cannot pump the frame. `looks` ([x, y] world points) are the centres of the objects figures
// stand at: framed too, so a glow far from the path (a sun, a moon) is on screen.
export function groupBox(figs, looks = []) {
  const b = { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity };
  for (const { x, y, t, tagged } of figs) {
    const h = figH(t), w = h * FIG_ASPECT / 2;
    b.minx = Math.min(b.minx, x - w); b.maxx = Math.max(b.maxx, x + w);
    b.miny = Math.min(b.miny, y); b.maxy = Math.max(b.maxy, y + h + (tagged ? TAG_GAP + TAG_H : 0));
  }
  for (const [x, y] of looks) { b.minx = Math.min(b.minx, x); b.maxx = Math.max(b.maxx, x); b.miny = Math.min(b.miny, y); b.maxy = Math.max(b.maxy, y); }
  return b;
}

// Zoom falls as the group's box grows and nothing else, so a figure walking away only ever widens the view.
export function followAim(r, box) {
  const hh = r.base * r.tan;
  const zoom = clamp(Math.min(hh * r.aspect / ((box.maxx - box.minx) / 2 + PAD_X), hh / ((box.maxy - box.miny) / 2 + PAD_Y)), ZOOM_MIN, ZOOM_MAX);
  const { mx, my } = panLimit(r, zoom);
  return { tx: clamp((box.minx + box.maxx) / 2, -mx, mx), ty: clamp((box.miny + box.maxy) / 2, -my, my), zoom };
}

// The plaque's look point (u, v) framed at its zoom; `shift` (NDC) moves it toward the half of the stage the panel leaves free.
export function focusAim(r, look, zoom, shift = 0) {
  zoom = Math.max(ZOOM_MIN, zoom);
  const { mx, my } = panLimit(r, zoom);
  return { tx: clamp((look[0] - 0.5) * r.W - shift * r.base * r.tan * r.aspect / zoom, -mx, mx), ty: clamp((look[1] - 0.5) * r.H, -my, my), zoom };
}

// Focus frame only while exactly one plaque is owned ({look, zoom, shift}); none, or two at once, follows the group.
export const aimFor = (r, owned, box) => (owned.length === 1 ? focusAim(r, owned[0].look, owned[0].zoom, owned[0].shift) : followAim(r, box));

// One step toward `aim`: the pan settles in about 1.2 s (the blend back from a focus frame), zoom in slower than out,
// lean over about 1.5 s; then pan and lean are clamped to what this zoom allows, so no view ever shows the stage.
export function stepView(r, cam, aim, lean, leanY, dt) {
  const kp = 1 - Math.exp(-dt / 0.4), kz = 1 - Math.exp(-dt / (aim.zoom > cam.zoom ? 0.8 : 0.35)), kl = 1 - Math.exp(-dt / 0.5);
  cam.zoom += (aim.zoom - cam.zoom) * kz;
  const { mx, my } = panLimit(r, cam.zoom), cap = leanCap(cam.zoom);
  cam.tx = clamp(cam.tx + (aim.tx - cam.tx) * kp, -mx, mx);
  cam.ty = clamp(cam.ty + (aim.ty - cam.ty) * kp, -my, my);
  cam.lean = clamp(cam.lean + (lean - cam.lean) * kl, -cap, cap);
  cam.leanY = clamp(cam.leanY + (leanY - cam.leanY) * kl, -LEAN_Y, LEAN_Y);
  return cam;
}
