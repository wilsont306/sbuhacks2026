// Host artwork flow: a dropped or picked picture (drag-drop, U) is downscaled, shown flat while Gemini reads it through
// POST /api/interpret, then played as a scene; a phone's scene URL, a bundled sample (1, 2, 3, boot and R) or a gallery
// card (G) plays the same way without Gemini. Mirrors today's projects in localStorage 'tt.projects' and polls
// GET /api/projects?id= for the "Saved to Snowflake" badge. Every failure is a designed status line, never a thrown error.
import { downscale } from '../shared/downscale.js';
import { validateScene } from '../shared/scene-validate.js';
import {
  MIRROR_KEY, POLL_AT, STATUS_MS, GALLERY_CARDS, readMirror, trimMirror, mirrorItem, mergeGallery, storeLine,
  pollVerdict, reasonMessage, chipText, badgeText, moveSel, isSceneUrl, safeUrl,
} from './gallery.js';
import { apiHeaders, load as loadKeys } from '../shared/byok.js';
import './artwork.css';

let game = null, audio = null, margins = null;
let state = { scene: null, id: null, saved: 'sample' };
let gen = 0, reading = false, statusTimer = 0, stage = Promise.resolve(), sampleList = null;
let gal = null, galOpen = false, galCards = [], galSel = 0, galStore = null;
const STALE = new Error('stale');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sibling modules are optional at runtime: a missing or throwing one never stops a scene from playing.
const tell = (mod, fn, ...args) => { try { if (mod && typeof mod[fn] === 'function') mod[fn](...args); } catch { /* designed: ignore */ } };

// Every network read: {status, body}, with status 0 and body null for a failure or a non-JSON answer.
async function getJson(url, { ms = 10000, ...init } = {}) {
  try {
    // The visitor's own keys (the API box) go to this site's API only, never to Blob or a sample file.
    const headers = url.startsWith('/api/') ? { ...apiHeaders(), ...init.headers } : init.headers;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms), ...init, headers });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: body stays null */ }
    return { status: res.status, body };
  } catch { return { status: 0, body: null }; }
}

function status(text, ms = 0) {
  clearTimeout(statusTimer);
  try { game.setStatus(text); } catch { /* designed: ignore */ }
  if (text && ms) statusTimer = setTimeout(() => status(null), ms);
}

// Stage calls run one at a time and a superseded one is skipped, so a slow texture never lands over a newer scene.
function onStage(my, fn) {
  const run = stage.then(() => { if (my !== gen) throw STALE; return fn(); });
  stage = run.catch(() => {});
  return run;
}

// Plays a validated scene: stage, margins and sound preparation. False when a newer load took over or no image loads.
async function present(my, scene, image, saved, fallback) {
  try { await onStage(my, () => game.loadScene(scene, { image })); } catch (err) {
    if (err === STALE || !fallback || fallback === image) return false;
    try { await onStage(my, () => game.loadScene(scene, { image: fallback })); } catch { return false; }
  }
  if (my !== gen) return false;
  state = { scene, id: scene.id || null, saved };
  status(null);
  tell(margins, 'setScene', scene, { saved });
  tell(audio, 'prepare', scene);
  closeGallery();
  return true;
}

function mirror(scene) {
  if (!scene.id) return;
  try {
    const now = Date.now(), list = readMirror(localStorage.getItem(MIRROR_KEY), now);
    localStorage.setItem(MIRROR_KEY, JSON.stringify(trimMirror(list, mirrorItem(scene, now), now)));
  } catch { /* storage full or blocked: the gallery still has Snowflake */ }
}

function settle(id, saved) {
  if (state.id !== id) return;
  state.saved = saved;
  tell(margins, 'setSaved', saved, id);
  if (saved === 'saved') tell(audio, 'play', 'save');
}

// "Saved to Snowflake" only once GET /api/projects?id= finds the row; after the last poll it is 'local'.
async function pollSaved(id) {
  const t0 = Date.now();
  for (const at of POLL_AT) {
    await sleep(Math.max(0, t0 + at - Date.now()));
    if (state.id !== id) return;
    const r = await getJson('/api/projects?id=' + encodeURIComponent(id), { ms: 9000 });
    const v = pollVerdict(r.status, r.body);
    if (v !== 'wait') return settle(id, v);
  }
  settle(id, 'local');
}

// A scene that came back from interpret or a phone: played, mirrored, and checked for its Snowflake row.
async function playNew(my, scene, image, fallback) {
  if (!(await present(my, scene, image, 'saving', fallback))) return false;
  tell(audio, 'play', 'appear');
  mirror(scene);
  if (scene.id) pollSaved(scene.id);
  return true;
}

export async function upload(file) {
  if (!file || !game) return;
  // No timer: the reading's own outcome replaces this line.
  if (reading) return status('One at a time: still reading the last picture');
  reading = true;
  try {
    let pic;
    try { pic = await downscale(file); } catch { return status(reasonMessage('file'), STATUS_MS); }
    const my = ++gen;
    state = { scene: null, id: null, saved: 'unsaved' };
    closeGallery();
    await onStage(my, () => game.showImage(pic.dataUrl)).catch(() => {});
    if (my !== gen) return; // overtaken while staging: do not spend a Gemini call on a picture nobody will see
    tell(margins, 'setScene', null, { saved: 'unsaved' });
    status('Reading the artwork…');
    const { body } = await getJson('/api/interpret', {
      ms: 40000, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: pic.base64, source: 'drop' }),
    });
    if (my !== gen) return;
    const r = isObj(body) ? body : { ok: false, reason: 'offline' };
    const scene = isObj(r.scene) ? validateScene(r.scene, r.scene) : null;
    if (r.ok === true && scene) {
      if (!(await playNew(my, scene, safeUrl(scene.image_url) || pic.dataUrl, pic.dataUrl)) && my === gen) status(reasonMessage('offline'), STATUS_MS);
    } else if (r.reason === 'storage' && scene) {
      if (await present(my, scene, pic.dataUrl, 'unsaved')) tell(audio, 'play', 'appear');
      if (my === gen) status(reasonMessage('storage'), STATUS_MS);
    } else if (r.reason === 'bad_key' || (r.reason === 'auth' && loadKeys().gemini)) {
      status('Your Gemini key was refused; check it in the API box (K)', STATUS_MS);
    } else status(reasonMessage(r.reason), STATUS_MS);
  } finally { reading = false; }
}

export async function fromPhone(sceneUrl, pid) {
  if (!game || !isSceneUrl(sceneUrl)) return false;
  if (state.scene && state.scene.scene_url === sceneUrl) return true;
  const my = ++gen;
  status('Opening a picture from a phone…');
  const { body } = await getJson(sceneUrl, { mode: 'cors' });
  if (my !== gen) return false;
  const scene = isObj(body) ? validateScene(body, body) : null;
  const ok = !!scene && !!safeUrl(scene.image_url) && (await playNew(my, scene, scene.image_url));
  if (!ok && my === gen) status("Couldn't open that phone's picture; staying on this one", STATUS_MS);
  return ok;
}

async function samples() {
  if (sampleList) return sampleList;
  const { body } = await getJson('/samples/index.json');
  if (!Array.isArray(body)) return [];
  return (sampleList = body.filter((s) => isObj(s) && Number.isInteger(s.n) && safeUrl(s.scene)));
}

// Sample n (1-based, from /samples/index.json), with no sound: boot and R call it, and R plays its own.
export async function loadSample(n) {
  if (!game) return false;
  const my = ++gen;
  const s = (await samples()).find((e) => e.n === n);
  if (!s || my !== gen) return false;
  const { body } = await getJson(s.scene);
  if (my !== gen || !isObj(body)) return false;
  const scene = validateScene(body, body);
  return present(my, scene, safeUrl(s.image) || safeUrl(scene.image_url), 'sample');
}

// A gallery card: the local copy, else its scene file, else the Snowflake row's scene. Never Gemini.
async function openCard(c) {
  if (c.n) return loadSample(c.n).then((ok) => ok && tell(audio, 'play', 'appear'));
  const my = ++gen;
  closeGallery();
  let raw = c.scene;
  if (!isObj(raw) && c.scene_url) raw = (await getJson(c.scene_url, { mode: 'cors' })).body;
  if (!isObj(raw) && my === gen) {
    const { body } = await getJson('/api/projects?id=' + encodeURIComponent(c.id), { ms: 9000 });
    raw = isObj(body) && isObj(body.project) ? body.project.scene : null;
  }
  if (my !== gen) return;
  const scene = isObj(raw) ? validateScene(raw, { ...raw, id: raw.id || c.id }) : null;
  const image = scene && (safeUrl(scene.image_url) || c.image);
  if (image && (await present(my, scene, image, c.saved))) tell(audio, 'play', 'appear');
  else if (my === gen) status("Couldn't open that project; staying on this one", STATUS_MS);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function renderGallery() {
  if (!gal) return;
  gal.store.textContent = storeLine(galStore);
  gal.list.replaceChildren(...galCards.map((c, i) => {
    const b = el('button', 'art-card' + (i === galSel ? ' selected' : ''));
    b.type = 'button';
    if (i === galSel) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => openCard(c));
    const pic = el('div', 'art-pic');
    if (c.image) {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      img.src = c.image;
      pic.append(img);
    }
    const time = c.at ? new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const meta = el('span', 'art-meta');
    meta.append(el('span', 'art-chip', chipText(c.source)), time ? ' ' + time : '');
    b.append(pic, el('span', 'art-title', c.title), meta, el('span', 'art-badge ' + c.saved, badgeText(c.saved)));
    b.title = c.title;
    const li = el('li');
    li.append(b);
    return li;
  }));
  gal.empty.hidden = galCards.length > 0;
}

function localList() {
  try { return readMirror(localStorage.getItem(MIRROR_KEY)); } catch { return []; }
}

async function openGallery() {
  if (!gal) return;
  galOpen = true;
  galSel = 0;
  galStore = null;
  gal.root.hidden = false;
  tell(audio, 'play', 'gallery');
  const sam = await samples(), local = localList();
  if (!galOpen) return;
  galCards = mergeGallery({ samples: sam, local }, GALLERY_CARDS);
  renderGallery();
  const { body } = await getJson('/api/projects', { ms: 9000 });
  if (!galOpen) return;
  const keep = galCards[galSel] && galCards[galSel].id;
  galStore = isObj(body) ? body : {};
  const remote = isObj(body) && body.ok === true && Array.isArray(body.projects) ? body.projects : [];
  galCards = mergeGallery({ samples: sam, local, remote }, GALLERY_CARDS);
  galSel = Math.max(0, galCards.findIndex((c) => c.id === keep));
  renderGallery();
}

function closeGallery() {
  galOpen = false;
  if (gal) gal.root.hidden = true;
}

export function toggleGallery() {
  if (galOpen) closeGallery();
  else openGallery();
}

export const current = () => ({ scene: state.scene, id: state.id, saved: state.saved });

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  // Fields, and anything inside a modal (the API box): this capture-phase handler runs before the box can stop the key.
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || (t.closest && t.closest('[aria-modal="true"]')))) return;
  const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // While the gallery is open it owns the arrows, Enter and Escape; capture phase keeps them from scene.js.
  if (galOpen && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(k)) {
    e.preventDefault();
    e.stopPropagation();
    if (k === 'Escape') closeGallery();
    else if (k === 'Enter') { if (galCards[galSel]) openCard(galCards[galSel]); }
    else { galSel = moveSel(galSel, k, galCards.length); renderGallery(); }
    return;
  }
  if (e.repeat) return;
  if (k === 'g') toggleGallery();
  else if (k === 'u' && gal) gal.pick.click();
  else if (k === '1' || k === '2' || k === '3') loadSample(Number(k)).then((ok) => ok && tell(audio, 'play', 'appear'));
}

function buildDom() {
  const host = document.getElementById('stage') || document.getElementById('tv') || document.body;
  const root = el('section', 'art-gallery');
  root.id = 'artGallery';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', "Gallery of today's projects");
  const head = el('header', 'art-head');
  head.append(el('h2', null, 'Gallery'), el('p', 'art-note', 'Titles are AI guesses. Arrows choose, Enter opens, Esc closes.'));
  const store = el('p', 'art-store');
  const list = el('ol', 'art-cards');
  const empty = el('p', 'art-empty', 'Nothing here yet today. Drop a picture, or press 1 for a sample.');
  empty.hidden = true;
  root.append(head, store, list, empty);
  const drop = el('div', 'art-drop', 'Drop the picture: Google Gemini will read it');
  drop.hidden = true;
  const pick = el('input');
  pick.type = 'file';
  pick.accept = 'image/*';
  pick.hidden = true;
  pick.addEventListener('change', () => {
    const f = pick.files && pick.files[0];
    pick.value = '';
    if (f) upload(f);
  });
  host.append(root, drop, pick);
  return { root, store, list, empty, drop, pick };
}

function wireDrop() {
  let hide = 0;
  const files = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  addEventListener('dragover', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    gal.drop.hidden = false;
    clearTimeout(hide);
    // dragover repeats while the file is over the page; when it stops, the hint goes.
    hide = setTimeout(() => { gal.drop.hidden = true; }, 300);
  });
  addEventListener('drop', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    gal.drop.hidden = true;
    const f = Array.from(e.dataTransfer.files || []).find((x) => /^image\//.test(x.type)) || e.dataTransfer.files[0];
    if (f) upload(f);
  });
}

export function init(opts = {}) {
  if (gal) return;
  game = opts.game || window.game;
  audio = opts.audio || null;
  margins = opts.margins || null;
  gal = buildDom();
  wireDrop();
  addEventListener('keydown', onKey, true);
  loadSample(1);
}
