// What a scene gains once it is on stage: its depth now, and 3D models through onScene (src/host/models3d.js). On each
// scene event with a scene: a scene that carries a depth_url loads that image; any other has Depth Anything V2 estimate
// one in this browser from its picture (src/host/depthAI.js, a lazy chunk). The relief takes it (game.setDepth), and a
// saved project's image goes to POST /api/depth, whose URL lands on the scene (game.setSceneField) so inside phones get
// it with the world. A generation guard drops any result for a scene that has since left; every failure is quiet and
// keeps the mask relief. A drawing (ink on blank paper, src/shared/lineart.js) gets no depth at all: Depth Anything reads
// one as noise, so it keeps the mask relief too. glue.js calls init({game, token, margins}) once; the HUD reads stats().
import { apiHeaders } from '../shared/byok.js';
import { isLineArt } from '../shared/lineart.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // api/depth.js's id rule
const DEPTH_MAX = 512; // D1's long side
const LINE_MAX = 256; // the picture's long side for isLineArt: at most 64k pixels
const UPLOAD_MS = 15000;

let game = null, token = '', margins = null, gen = 0, ai = null;
const hooks = new Set();
const st = { state: 'idle', device: null, ms: 0 };

// -> {state: 'idle'|'loading'|'computing'|'ready'|'saved'|'failed'|'drawing', device, ms}. 'loading' covers the model's
// first download, which runs inside the estimate; 'drawing': the picture is line art, so no depth was loaded or made.
export function stats() {
  const loading = st.state === 'computing' && ai && ai.stats().progress < 100;
  return { ...st, state: loading ? 'loading' : st.state };
}

// fn(scene, isCurrent) for every scene put on stage; isCurrent() turns false once another scene or the flat state
// replaced it. Returns an unsubscribe function.
export function onScene(fn) {
  if (typeof fn === 'function') hooks.add(fn);
  return () => hooks.delete(fn);
}

export function init(deps) {
  game = deps.game; token = deps.token || ''; margins = deps.margins || null;
  game.onHotspot((e) => { if (e && e.type === 'scene') onStage(e.scene); });
}

const set = (state, device, ms) => Object.assign(st, { state, device: device || null, ms: ms || 0 });
const since = (t0) => Math.round(performance.now() - t0);
// A project the API stored (an id the endpoint accepts), not a bundled sample.
const saved = (s) => s.source !== 'sample' && typeof s.id === 'string' && ID_RE.test(s.id);

function loadImage(url) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Blob images send CORS; without it the canvas would be tainted and unreadable
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('did not load'));
    img.src = url;
  });
}

// An image's RGBA pixels as {data, w, h}, at most max on the long side.
function pixels(img, max) {
  const nw = img.naturalWidth || max, nh = img.naturalHeight || max, s = Math.min(1, max / Math.max(nw, nh));
  const w = Math.max(2, Math.round(nw * s)), h = Math.max(2, Math.round(nh * s)), c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, w, h };
}

// A depth image file (8-bit, R=G=B, 255 nearest) as {data, w, h}, at most DEPTH_MAX on the long side.
async function fileDepth(url) {
  const { data: px, w, h } = pixels(await loadImage(url), DEPTH_MAX), data = new Uint8Array(w * h);
  for (let k = 0; k < data.length; k++) data[k] = px[k * 4];
  return { data, w, h };
}

// Whether the scene's picture is a drawing; false when it has none or it will not load or read.
async function isDrawing(scene) {
  if (!scene.image_url) return false;
  try {
    const { data, w, h } = pixels(await loadImage(scene.image_url), LINE_MAX);
    return isLineArt(data, w, h);
  } catch { return false; }
}

const base64 = (blob) => new Promise((ok, no) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).slice(String(fr.result).indexOf(',') + 1));
  fr.onerror = () => no(fr.error);
  fr.readAsDataURL(blob);
});

// -> the stored URL, or null (no API here, a refused token, a Blob failure: the relief keeps the depth regardless).
async function upload(id, png) {
  try {
    const headers = { 'Content-Type': 'application/json', ...apiHeaders() };
    if (token) headers['x-host-token'] = token;
    const res = await fetch('/api/depth', { method: 'POST', headers, body: JSON.stringify({ id, png: await base64(png) }), signal: AbortSignal.timeout(UPLOAD_MS) });
    const body = await res.json().catch(() => null);
    return res.ok && body && typeof body.depth_url === 'string' ? body.depth_url : null;
  } catch { return null; }
}

async function depthFor(scene, isCurrent) {
  const t0 = performance.now();
  set('loading');
  const drawing = await isDrawing(scene);
  if (!isCurrent()) return;
  if (drawing) return set('drawing', null, since(t0)); // no setDepth and no upload, even for a stored depth_url
  if (scene.depth_url) {
    set('loading');
    const d = await fileDepth(scene.depth_url).catch(() => null);
    if (!isCurrent()) return;
    if (d && game.setDepth(d)) return set('saved', 'file', since(t0));
    // a stored file that will not load: estimate one instead, below
  }
  if (!scene.image_url) return set('idle'); // an unsaved reading has no picture URL to read back
  set('loading');
  ai = ai || await import('./depthAI.js');
  const img = await loadImage(scene.image_url);
  if (!isCurrent()) return;
  set('computing');
  const r = await ai.estimateDepth(img);
  if (!isCurrent()) return;
  const device = ai.stats().device;
  if (!r || !game.setDepth(r.depth)) return set('failed', device, since(t0));
  set('ready', device, r.ms);
  if (margins && typeof margins.flash === 'function') margins.flash('Depth Anything V2 · depth ready');
  if (!saved(scene)) return;
  const url = await upload(scene.id, r.png);
  if (url && isCurrent() && game.setSceneField('depth_url', url)) set('saved', device, r.ms);
}

function onStage(scene) {
  const my = ++gen, isCurrent = () => my === gen;
  if (!scene) return set('idle');
  for (const fn of hooks) try { fn(scene, isCurrent); } catch (err) { console.warn('enrich: onScene', err); }
  depthFor(scene, isCurrent).catch((err) => { if (isCurrent()) set('failed', st.device, 0); console.warn('enrich: depth', err && err.message); });
}
