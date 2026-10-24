// Pure helpers for src/host/artwork.js (no DOM, no fetch): the localStorage mirror of today's projects, the gallery's
// merge of samples, mirror and Snowflake list, the save-confirmation poll verdict, failure messages and grid moves.
// tests/artwork.test.js covers them under node:test.

export const MIRROR_KEY = 'tt.projects';
export const MIRROR_CAP = 50;
// localStorage counts UTF-16 code units, so string length is the right measure here.
export const MIRROR_SCENE_MAX = 60 * 1024;
export const GALLERY_CARDS = 12;
export const GALLERY_COLS = 4;
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

// Gallery cards: {id, title, image, at, source, saved: 'saved'|'local'|'sample', scene, scene_url, n}.
const card = (o) => ({
  id: o.id, title: str(o.title, 120) || 'Untitled', image: safeUrl(o.image), at: Number.isFinite(o.at) ? o.at : 0,
  source: ['drop', 'phone', 'sample'].includes(o.source) ? o.source : 'drop', saved: o.saved,
  scene: isObj(o.scene) ? o.scene : null, scene_url: safeUrl(o.scene_url), n: Number.isInteger(o.n) ? o.n : null,
});

const fromSample = (s) => card({ id: s.id, title: s.name, image: s.image, source: 'sample', saved: 'sample', scene_url: s.scene, n: s.n });
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

// The Snowflake line over the gallery, from GET /api/projects's answer (null while it is in flight).
export function storeLine(body) {
  if (body === null) return 'Checking Snowflake…';
  if (isObj(body) && body.ok === true && body.configured !== false) return 'Saved projects from Snowflake, and this laptop';
  return isObj(body) && body.configured === false ? 'Local only: Snowflake is not set up here' : 'Local only: Snowflake is not answering';
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

export const chipText = (source) => (source === 'sample' ? 'Sample' : source === 'phone' ? 'Phone' : 'Laptop');
export const badgeText = (saved) => (saved === 'saved' ? 'Saved to Snowflake' : saved === 'sample' ? 'Hand-corrected' : 'Local only');

// The selected card after an arrow key on a grid of n cards, `cols` wide; other keys leave it.
export function moveSel(i, key, n, cols = GALLERY_COLS) {
  if (n <= 0) return 0;
  const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key] || 0;
  const j = i + d;
  return j >= 0 && j < n ? j : Math.min(Math.max(i, 0), n - 1);
}
