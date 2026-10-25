// Pure helpers for src/host/artwork.js (no DOM, no fetch): the localStorage mirror of today's projects, the gallery's
// cards (the bundled samples, shaped by mergeGallery), the save-confirmation poll verdict, failure messages, shelf
// moves and the 3D peek's cut-out layers. tests/artwork.test.js covers them under node:test.

export const MIRROR_KEY = 'tt.projects';
export const MIRROR_CAP = 50;
// localStorage counts UTF-16 code units, so string length is the right measure here.
export const MIRROR_SCENE_MAX = 60 * 1024;
export const GALLERY_CARDS = 12;
// px a peek cut-out lifts off the picture at depth 1 (far) and 0 (nearest).
export const PEEK_Z = [10, 64];
// GET /api/projects?id= at these times after the scene lands; the save goes through waitUntil, so it trails the reply.
export const POLL_AT = [3000, 10000, 30000];
export const STATUS_MS = 6000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);

// Same rule as hub/relay.js: a public Vercel Blob scene file written by api/interpret.js.
const SCENE_URL = /^https:\/\/[a-z0-9-]{1,64}\.public\.blob\.vercel-storage\.com\/scenes\/[A-Za-z0-9_-]{1,64}\.json$/;
export const isSceneUrl = (u) => typeof u === 'string' && SCENE_URL.test(u);

// An image or scene URL the page may load: http(s) or site-relative; anything else (javascript:, //host) is ''.
export function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return '';
  return /^https?:\/\//i.test(u) || (u[0] === '/' && u[1] !== '/') ? u : '';
}

const atOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

// Same local calendar day as now.
export function isToday(at, now = Date.now()) {
  const t = atOf(at);
  return Number.isFinite(t) && new Date(t).toDateString() === new Date(now).toDateString();
}

// The stored mirror, parsed: today's well-formed entries only; anything unreadable is [].
export function readMirror(raw, now = Date.now()) {
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  return Array.isArray(list) ? list.filter((e) => isObj(e) && okId(e.id) && isToday(e.at, now)) : [];
}

// The mirror after adding `item`: newest first, today only, one entry per id, at most MIRROR_CAP, and a scene over
// MIRROR_SCENE_MAX left out (the gallery then reloads it from scene_url).
export function trimMirror(list, item, now = Date.now()) {
  let scene = isObj(item.scene) ? item.scene : null;
  try { if (scene && JSON.stringify(scene).length > MIRROR_SCENE_MAX) scene = null; } catch { scene = null; }
  const rest = (Array.isArray(list) ? list : []).filter((e) => isObj(e) && e.id !== item.id && isToday(e.at, now));
  return [{ ...item, scene }, ...rest].slice(0, MIRROR_CAP);
}

// One mirror entry from a played scene.
export const mirrorItem = (scene, at = Date.now()) => ({
  id: scene.id, name: scene.title_guess, source: scene.source, image_url: scene.image_url, scene_url: scene.scene_url,
  scene, title_guess: scene.title_guess, at,
});

// Gallery cards: {id, title, image, at, source, saved: 'saved'|'local'|'sample', scene, scene_url, n, by}; `by` is a
// sample's short artist line from /samples/index.json, '' for projects.
const card = (o) => ({
  id: o.id, title: str(o.title, 120) || 'Untitled', image: safeUrl(o.image), at: Number.isFinite(o.at) ? o.at : 0,
  source: ['drop', 'phone', 'sample'].includes(o.source) ? o.source : 'drop', saved: o.saved,
  scene: isObj(o.scene) ? o.scene : null, scene_url: safeUrl(o.scene_url), n: Number.isInteger(o.n) ? o.n : null,
  by: str(o.by, 40),
});

const fromSample = (s) => card({ id: s.id, title: s.name, image: s.image, source: 'sample', saved: 'sample', scene_url: s.scene, n: s.n, by: s.by });
const fromLocal = (e) => card({ id: e.id, title: e.title_guess || e.name, image: e.image_url, at: atOf(e.at), source: e.source || (isObj(e.scene) && e.scene.source), saved: 'local', scene: e.scene, scene_url: e.scene_url });
const fromRemote = (p) => card({ id: p.id, title: p.title_guess || p.name, image: p.image_url, at: atOf(p.created_at), source: p.source, saved: 'saved', scene_url: p.scene_url });

// Samples, today's mirror and the Snowflake list as at most `max` cards: projects deduplicated by id (Snowflake's
// row wins, keeping the local scene copy for an offline reload), newest first, then the samples, which always fit.
export function mergeGallery({ samples = [], local = [], remote = [] } = {}, max = GALLERY_CARDS) {
  const sam = (Array.isArray(samples) ? samples : []).filter((s) => isObj(s) && okId(s.id)).map(fromSample)
    .sort((a, b) => (a.n ?? 99) - (b.n ?? 99)).slice(0, max);
  const taken = new Set(sam.map((s) => s.id)), byId = new Map();
  for (const e of Array.isArray(local) ? local : []) if (isObj(e) && okId(e.id) && !taken.has(e.id)) byId.set(e.id, fromLocal(e));
  for (const p of Array.isArray(remote) ? remote : []) {
    if (!isObj(p) || !okId(p.id) || taken.has(p.id)) continue;
    const mine = byId.get(p.id), r = fromRemote(p);
    byId.set(p.id, mine ? { ...r, scene: mine.scene, image: r.image || mine.image, scene_url: r.scene_url || mine.scene_url } : r);
  }
  const projects = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(0, max - sam.length));
  return [...projects, ...sam];
}

// mergeGallery's cards as the gallery's two picture lines: the samples, and the saved projects (newest first, up to
// `max`; Snowflake's rows and today's mirror, deduplicated by id).
export function galleryLines({ samples = [], local = [], remote = [] } = {}, max = GALLERY_CARDS) {
  const n = (Array.isArray(samples) ? samples : []).length, all = mergeGallery({ samples, local, remote }, max + n);
  return { samples: all.filter((c) => c.saved === 'sample'), saved: all.filter((c) => c.saved !== 'sample') };
}

// A saved project's carriage name: its title guess, else its first object labels (a reading Gemini could not name
// still knows what is in it), else 'Untitled' and the time it was saved.
export function projectTitle(title, scene, at) {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (t && !/^(unknown|untitled)$/i.test(t)) return t.slice(0, 120);
  const labels = isObj(scene) && Array.isArray(scene.objects)
    ? scene.objects.map((o) => (isObj(o) && typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : '')).filter(Boolean) : [];
  if (labels.length) { const t2 = labels.slice(0, 2).join(' · '); return (t2[0].toUpperCase() + t2.slice(1)).slice(0, 120); }
  const d = new Date(Number.isFinite(at) && at > 0 ? at : NaN), pad = (x) => String(x).padStart(2, '0');
  return Number.isFinite(d.getTime()) ? `Untitled, ${pad(d.getHours())}:${pad(d.getMinutes())}` : 'Untitled';
}

// One save-confirmation poll: 'saved' on the row, 'local' when Snowflake is not configured at all, else 'wait'.
export function pollVerdict(status, body) {
  if (status === 200 && isObj(body) && body.ok === true) return 'saved';
  return isObj(body) && body.configured === false ? 'local' : 'wait';
}

// The stage's one-line status for a failed or partial reading (api/interpret.js reasons, plus 'file' and 'offline').
export function reasonMessage(reason) {
  switch (reason) {
    case 'busy': return 'One at a time: try again in a few seconds';
    case 'quota': return 'The artwork reader is resting; press 1, 2 or 3 for a sample';
    case 'storage': return "Read it, but couldn't save it; playing it unsaved";
    case 'file': return "That file isn't a picture we can open";
    default: return "Couldn't read this one; walking on the flat painting";
  }
}


// The selection {s, i} after an arrow key over shelves holding `sizes` items: left and right along a shelf, up and
// down to the same place (or the end) of the nearest non-empty shelf. Edges and other keys leave it.
export function moveShelf(sel, key, sizes) {
  const ok = (s) => Number.isInteger(s) && sizes[s] > 0;
  if (!ok(sel.s)) { const s = sizes.findIndex((n) => n > 0); return { s: Math.max(s, 0), i: 0 }; }
  const s = sel.s, i = Math.min(Math.max(sel.i, 0), sizes[s] - 1);
  const dx = { ArrowLeft: -1, ArrowRight: 1 }[key] || 0, dy = { ArrowUp: -1, ArrowDown: 1 }[key] || 0;
  if (dx) return { s, i: Math.min(Math.max(i + dx, 0), sizes[s] - 1) };
  for (let t = s + dy; dy && t >= 0 && t < sizes.length; t += dy) if (ok(t)) return { s: t, i: Math.min(i, sizes[t] - 1) };
  return { s, i };
}

// Planes that recede (as in maskDepth.js): the peek leaves them on the picture instead of lifting them as cards.
const SURFACES = new Set(['sky', 'ground', 'water']);
// Outlines under this area (image units squared, of 1e6) lift as specks, not objects; the peek leaves them flat.
export const PEEK_MIN_AREA = 8000;
const pct = (v) => `${Math.round(v) / 10}%`;
const areaOf = (pts) => Math.abs(pts.reduce((a, [x, y], k) => { const [u, v] = pts[(k + 1) % pts.length]; return a + x * v - u * y; }, 0)) / 2;

// The 3D peek's cut-outs from a validated scene, far first: each object but the receding surfaces, as its outline
// points (image space) and a CSS clip-path along them in percent of the picture, a lift in px from its depth guess,
// its motion, and a transform origin at its foot so a sway pivots where it stands. `surfaces` also returns the
// receding planes, marked `surface`, for the sidebar's point-to-name areas (they are never lifted).
export function peekLayers(scene, { surfaces = false } = {}) {
  const objects = isObj(scene) && Array.isArray(scene.objects) ? scene.objects : [];
  return objects.flatMap((o) => {
    if (!isObj(o) || (!surfaces && SURFACES.has(o.kind))) return [];
    const b = Array.isArray(o.box) && o.box.length === 4 ? o.box : null;
    let pts = Array.isArray(o.mask) && o.mask.length >= 3 ? o.mask : b && [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    pts = (pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 3 || areaOf(pts) < PEEK_MIN_AREA) return [];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const depth = Number.isFinite(o.depth) ? Math.min(1, Math.max(0, o.depth)) : 0.5;
    return [{
      label: str(o.label, 40), kind: str(o.kind, 20), motion: str(o.motion, 12) || 'none', depth, points: pts, surface: SURFACES.has(o.kind),
      z: Math.round(PEEK_Z[0] + (1 - depth) * (PEEK_Z[1] - PEEK_Z[0])),
      clip: `polygon(${pts.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(', ')})`,
      origin: `${pct((Math.min(...xs) + Math.max(...xs)) / 2)} ${pct(Math.max(...ys))}`,
    }];
  }).sort((a, b) => b.depth - a.depth);
}
