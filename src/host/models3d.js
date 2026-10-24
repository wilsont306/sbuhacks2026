// Tripo 3D models for a scene's hero objects (README contract D6). For each scene put on stage (enrich.onScene) the TV
// picks at most MODELS_PER_SCENE standing objects, largest outline first, cuts each out of the picture (its box padded
// PAD, masked to its outline, transparent around it, a PNG at most CROP_MAX on its long side) and asks /api/tripo for a
// model, one object at a time: a POST, then a GET every POLL_MS for up to GIVE_UP_MS. The cache key is the sha1 of
// image_url, label and outline, so an object is paid for once. A model that lands while its scene is still on stage goes
// to game.setObjectModel, which re-sends the world to inside phones. D turns it on and off (localStorage 'tt.models',
// default on). Every failure is quiet: the flat stays. glue.js calls init({game, token, margins}); margins reads stats().
import { apiHeaders } from '../shared/byok.js';
import { BACKDROP, FLOOR_KINDS, shapeOf } from '../world/tip.js';

export const MODELS_PER_SCENE = 2;
export const STORE_KEY = 'tt.models';
export const PAD = 0.08, CROP_MAX = 1024, POLL_MS = 4000, GIVE_UP_MS = 10 * 60 * 1000;
const CALL_MS = 125000; // api/tripo.js runs up to 120 s (vercel.json): a 20 s Tripo call plus a 60 s GLB copy
const RETRY_MAX_S = 60;
// Answers that would be the same for the scene's next object, so its turn is skipped too.
const STOP = ['off', 'capped', 'no_credits', 'http', 'error'];

/* pure */
const fin = (v) => typeof v === 'number' && isFinite(v);
const okBox = (b) => Array.isArray(b) && b.length === 4 && b.every(fin) && b[2] > b[0] && b[3] > b[1];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const areaOf = (pts) => Math.abs(pts.reduce((a, p, k) => { const q = pts[(k + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// A picture the TV can fetch and Tripo can be sent a crop of: https/http or site-relative; never data:, blob: or ''.
export const pictureOk = (u) => typeof u === 'string' && /^(https?:\/\/|\/(?![/\\]))/i.test(u);

// Subjects before scenery: a model of the locomotive beats one of the viaduct it crosses. Unlisted kinds rank 1.
const RANK = { vehicle: 0, animal: 0, person: 0, building: 2 };
const MIN_AREA = 10000; // 1 percent of the picture: a smaller crop is too few pixels for a usable model

// -> [{index, obj}]: up to n objects that stand (not BACKDROP, not FLOOR_KINDS) and cover at least MIN_AREA, by RANK
// then largest mask (else box) area, ties in scene order. [] for no scene or a picture that cannot be cropped.
export function pickHeroes(scene, n = MODELS_PER_SCENE) {
  if (!scene || typeof scene !== 'object' || !pictureOk(scene.image_url) || !Array.isArray(scene.objects)) return [];
  const rank = (h) => (RANK[h.obj.kind] === undefined ? 1 : RANK[h.obj.kind]);
  return scene.objects
    .map((obj, index) => ({ index, obj, area: obj && okBox(obj.box) ? areaOf(shapeOf(obj)) : 0 }))
    .filter((h) => h.area >= MIN_AREA && BACKDROP.indexOf(h.obj.kind) < 0 && FLOOR_KINDS.indexOf(h.obj.kind) < 0)
    .sort((a, b) => rank(a) - rank(b) || b.area - a.area)
    .slice(0, Math.max(0, n))
    .map((h) => ({ index: h.index, obj: h.obj }));
}

// What the cache key hashes: the same picture, label and outline give the same model.
export const cacheKeyText = (scene, obj) => `${scene.image_url}|${obj.label}|${JSON.stringify(Array.isArray(obj.mask) ? obj.mask : obj.box)}`;

// The crop of an image-space box (0..1000 on both axes) in a w by h picture: grown by PAD of its own size on each side,
// clamped to the picture, in whole pixels; s scales it so the output (w, h) is at most CROP_MAX on its long side.
// -> {sx, sy, sw, sh, s, w, h}, or null.
export function cropRect(box, w, h) {
  if (!okBox(box) || !(w >= 1 && h >= 1)) return null;
  const px = (box[2] - box[0]) * PAD, py = (box[3] - box[1]) * PAD;
  const x0 = Math.floor(clamp(box[0] - px, 0, 1000) * w / 1000), x1 = Math.ceil(clamp(box[2] + px, 0, 1000) * w / 1000);
  const y0 = Math.floor(clamp(box[1] - py, 0, 1000) * h / 1000), y1 = Math.ceil(clamp(box[3] + py, 0, 1000) * h / 1000);
  const sw = x1 - x0, sh = y1 - y0;
  if (!(sw >= 1 && sh >= 1)) return null;
  const s = Math.min(1, CROP_MAX / Math.max(sw, sh));
  return { sx: x0, sy: y0, sw, sh, s, w: Math.max(1, Math.round(sw * s)), h: Math.max(1, Math.round(sh * s)) };
}

// An image-space outline in that crop's output pixels.
export const cropPath = (shape, r, w, h) => shape.map((p) => [(p[0] * w / 1000 - r.sx) * r.s, (p[1] * h / 1000 - r.sy) * r.s]);

// One /api/tripo answer -> what the loop does next: {url} done, {task, wait} ask again in wait ms, or {end: reason}.
// task is the one already known; a poll's answer does not repeat it.
export function step(r, task) {
  const s = r && typeof r.status === 'string' ? r.status : '';
  if (s === 'success') return typeof r.model_url === 'string' && r.model_url ? { url: r.model_url } : { end: 'failed' };
  if (s === 'queued' || s === 'running') {
    const t = typeof r.task === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.task) ? r.task : task;
    return t ? { task: t, wait: POLL_MS } : { end: 'failed' };
  }
  if (s === 'busy') return { task, wait: Math.max(POLL_MS, clamp(Number(r.retry_after) || 0, 0, RETRY_MAX_S) * 1000) };
  return { end: s || 'failed' };
}
/* end pure */

export async function sha1hex(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)); // https or localhost only
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

let game = null, token = '', margins = null, on = true, bound = false;
let job = { ready: 0, running: 0, failed: 0, last: '' }, lastStage = null;

// -> {on, ready, running, failed, last} for the scene on stage; last is the latest /api/tripo status (or why it stopped).
export function stats() {
  return { on, ready: job.ready, running: job.running, failed: job.failed, last: job.last };
}

const store = {
  get: () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(STORE_KEY, v); } catch { /* blocked site data: the toggle just does not stick */ } },
};
const flash = (text) => { if (margins && typeof margins.flash === 'function') margins.flash(text); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function init(deps) {
  game = deps.game; token = deps.token || ''; margins = deps.margins || null;
  on = store.get() !== '0';
  if (!bound && typeof addEventListener === 'function') { bound = true; addEventListener('keydown', onKey); }
}

function onKey(e) {
  const t = e.target;
  // the same guard as artwork.js: fields, and anything inside a modal (the API box)
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    || (t.closest && t.closest('[aria-modal="true"]'))))) return;
  if ((e.key || '').toLowerCase() === 'd') setOn(!on);
}

export function setOn(v) {
  on = !!v;
  store.set(on ? '1' : '0');
  flash(on ? '3D models on' : '3D models off (D turns them back on)');
  if (on && lastStage && lastStage.isCurrent()) onScene(lastStage.scene, lastStage.isCurrent); // the cache answers what was already made
  return on;
}

// enrich.onScene's hook: fn(scene, isCurrent).
export function onScene(scene, isCurrent) {
  lastStage = { scene, isCurrent };
  const heroes = on && game ? pickHeroes(scene) : [];
  const my = job = { ready: 0, running: heroes.length, failed: 0, last: '' };
  const alive = () => on && my === job && isCurrent();
  if (heroes.length) run(my, scene, heroes, alive).catch((err) => console.warn('models3d:', err && err.message));
}

function loadImage(url) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // without it the canvas is tainted and cannot be read back
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('picture did not load'));
    img.src = url;
  });
}

// The object cut out of the picture as base64 PNG (throws on a tainted canvas).
function cropPng(img, obj) {
  const W = img.naturalWidth, H = img.naturalHeight, r = cropRect(obj.box, W, H);
  if (!r) throw new Error('no crop');
  const c = document.createElement('canvas');
  c.width = r.w; c.height = r.h;
  const g = c.getContext('2d');
  g.beginPath();
  for (const [x, y] of cropPath(shapeOf(obj), r, W, H)) g.lineTo(x, y);
  g.closePath();
  g.clip('evenodd'); // as tip.js fills outlines
  g.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, r.w, r.h);
  const url = c.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}

// One call; a non-200 or a non-JSON answer (the laptop hub, npm run dev) reads as {status:'http'}, except a crop over
// 3 MB (413), which only that object has. A 5xx (a function cut short) throws, so a poll asks again.
async function call(qs, body) {
  const headers = { ...apiHeaders() };
  if (token) headers['x-host-token'] = token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api/tripo' + qs, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CALL_MS) });
  if (res.status >= 500) throw new Error('tripo function ' + res.status);
  if (!res.ok) return { status: res.status === 413 ? 'too_big' : 'http' };
  return res.json().catch(() => ({ status: 'http' }));
}

// One object: POST until it has a task (or a model), then poll. -> {url} or {end}.
async function build(my, key, png, alive) {
  const t0 = Date.now();
  let task = '';
  while (alive()) {
    if (Date.now() - t0 > GIVE_UP_MS) return { end: 'timeout' };
    let r;
    try {
      r = await call(task ? `?task=${encodeURIComponent(task)}&key=${key}` : '', task ? null : { key, png });
    } catch {
      if (!task) return { end: 'error' };
      await sleep(POLL_MS); // a poll that did not get through: the task still runs, ask again
      continue;
    }
    if (!alive()) break;
    my.last = r && typeof r.status === 'string' ? r.status.slice(0, 20) : '';
    const next = step(r, task);
    if (!next.wait) return next;
    task = next.task;
    await sleep(next.wait);
  }
  return { end: 'stopped' };
}

async function run(my, scene, heroes, alive) {
  let img = null;
  for (const { index, obj } of heroes) {
    if (!alive()) break;
    const now = game.scene(), have = now && now.objects[index];
    let r = have && have.model_url ? { url: have.model_url, had: true } : null; // a model already there (hand-authored, or D again)
    if (!r) {
      try {
        img = img || await loadImage(scene.image_url);
        if (!alive()) break;
        r = await build(my, await sha1hex(cacheKeyText(scene, obj)), cropPng(img, obj), alive);
      } catch (err) {
        r = { end: 'error' };
        console.warn('models3d:', obj.label, err && err.message);
      }
    }
    if (!alive()) break;
    my.running--;
    if (r.url && (r.had || game.setObjectModel(index, r.url))) {
      my.ready++;
      if (!r.had) flash(`Tripo · ${obj.label} · 3D model ready`);
    } else {
      my.failed++;
      my.last = r.end || 'refused'; // refused: the URL did not pass validateScene
      if (STOP.indexOf(r.end) >= 0) break;
    }
  }
  my.running = 0;
}
