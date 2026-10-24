// Host artwork flow: a dropped or picked picture (drag-drop, U) is downscaled, shown flat while Gemini reads it through
// POST /api/interpret, then played as a scene; a phone's scene URL, a bundled sample (1, 2, 3, boot and R) or a gallery
// sample (G) plays the same way without Gemini. Mirrors today's projects in localStorage 'tt.projects' and polls
// GET /api/projects?id= for the "Saved to Snowflake" badge. Every failure is a designed status line, never a thrown error.
// The gallery is two lines: how it works (the "Add a picture" engine and a three-step demo), then the samples; the
// chosen sample peeks in 3D: its picture sinks and each object, cut along its mask, lifts by its depth guess.
import { downscale } from '../shared/downscale.js';
import { validateScene } from '../shared/scene-validate.js';
import {
  MIRROR_KEY, POLL_AT, STATUS_MS, GALLERY_CARDS, readMirror, trimMirror, mirrorItem, mergeGallery,
  pollVerdict, reasonMessage, moveShelf, peekLayers, isSceneUrl, safeUrl,
} from './gallery.js';
import { apiHeaders, load as loadKeys } from '../shared/byok.js';
import { MAX_PLAYERS } from '../shared/protocol.js';
import './artwork.css';

let game = null, audio = null, margins = null;
let state = { scene: null, id: null, saved: 'sample' };
let gen = 0, reading = false, statusTimer = 0, stage = Promise.resolve(), sampleList = null;
let gal = null, galOpen = false, galRows = [[], []], galSel = { s: 0, i: 0 };
let galHover = false, galIdle = false; // the pointer made the current choice; the pointer left it and nothing is chosen
const ADD = { add: true }; // the "Add a picture" engine that leads the how-it-works line
const peeks = new Map(); // card id -> promise of its validated scene or null, fetched once on the first peek
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

// A gallery card is a sample: it plays like keys 1 to 3, with the appear sound. Never Gemini.
const openCard = (c) => loadSample(c.n).then((ok) => ok && tell(audio, 'play', 'appear'));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || !!document.querySelector('#tv.reduced');

// The card's plate leans toward the pointer; null (pointer gone, or reduced motion) hands it back to the CSS pose.
function tiltTo(plate, e) {
  if (!e || reducedMotion()) {
    plate.style.removeProperty('--rx');
    plate.style.removeProperty('--ry');
    return;
  }
  const r = plate.parentElement.getBoundingClientRect();
  const x = Math.min(0.5, Math.max(-0.5, (e.clientX - r.left) / r.width - 0.5));
  const y = Math.min(0.5, Math.max(-0.5, (e.clientY - r.top) / r.height - 0.5));
  plate.style.setProperty('--ry', `${(x * 30).toFixed(1)}deg`);
  plate.style.setProperty('--rx', `${(8 - y * 24).toFixed(1)}deg`);
}

// A card's validated scene for its peek: the local copy, else its scene file. No Snowflake or Gemini call on a peek.
function sceneFor(c) {
  if (!peeks.has(c.id)) peeks.set(c.id, (async () => {
    let raw = c.scene;
    if (!isObj(raw) && c.scene_url) raw = (await getJson(c.scene_url, c.n ? {} : { mode: 'cors' })).body;
    return isObj(raw) ? validateScene(raw, raw) : null;
  })());
  return peeks.get(c.id);
}

// The print a card (or an empty-shelf step) shows: the picture on a plate that tilts inside a mat.
function printEl(c) {
  const mat = el('span', 'art-mat'), tilt = el('span', 'art-tilt'), plate = el('span', 'art-plate'), back = el('span', 'art-back');
  if (c.image) {
    const img = el('img', 'art-base');
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => { if (img.naturalHeight) plate.style.setProperty('--ar', img.naturalWidth / img.naturalHeight); };
    img.onerror = () => img.remove();
    img.src = c.image;
    back.append(img);
  }
  plate.append(back);
  tilt.append(plate);
  mat.append(tilt);
  return { mat, plate };
}

// Builds a print's cut-outs once, the first time it is chosen; CSS lifts them while it is selected.
async function peek(card, c) {
  if (card.dataset.peek) return;
  card.dataset.peek = 'loading';
  const line = card.querySelector('.art-peekline'), plate = card.querySelector('.art-plate'), back = card.querySelector('.art-back');
  const say = (text) => { if (line) line.textContent = text; };
  say('Lifting the layers…');
  const layers = c.image ? peekLayers(await sceneFor(c)) : [];
  if (!card.isConnected) return;
  if (!layers.length) {
    card.dataset.peek = 'flat';
    say('Flat picture: no reading');
    return;
  }
  const bg = `url(${JSON.stringify(c.image)})`;
  layers.forEach((l, k) => {
    const hole = el('span', 'art-hole');
    hole.style.clipPath = l.clip;
    const lift = el('span', 'art-lift'), cut = el('span', 'art-cut');
    lift.style.setProperty('--z', `${l.z}px`);
    lift.style.setProperty('--k', k);
    // The sidebar names a part under the pointer and lifts just that part (its lift and its hole share k).
    lift.dataset.k = hole.dataset.k = k;
    cut.dataset.label = l.label;
    cut.dataset.motion = l.motion;
    Object.assign(cut.style, { clipPath: l.clip, backgroundImage: bg, transformOrigin: l.origin });
    lift.append(cut);
    back.append(hole);
    plate.append(lift);
  });
  void plate.offsetWidth; // style the cut-outs flat first, so the first lift transitions instead of popping
  card.dataset.peek = 'ready';
  const n = `${layers.length} cut-out${layers.length === 1 ? '' : 's'}`;
  say(c.saved === 'sample' ? n : `${n} · AI guess`); // the samples' siding already says their depths are hand-set
}

// Gemini's outlines drawn over a plate, as on a blueprint (the empty shelf's second step).
function outline(plate, layers) {
  if (!layers.length || !plate.isConnected) return;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'art-outline');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  for (const l of layers) {
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', l.points.map((q) => q.join(',')).join(' '));
    svg.append(p);
  }
  plate.append(svg);
}


// Fades a shelf's edges where more cards are scrolled out of view.
function fades(row) {
  row.classList.toggle('fade-l', row.scrollLeft > 4);
  row.classList.toggle('fade-r', row.scrollLeft + row.clientWidth < row.scrollWidth - 4);
}

// The locomotive at the head of today's train, facing the way it pulls (left). Static markup; colours come from CSS.
const ENGINE = `<svg class="art-engine" viewBox="0 0 300 200" aria-hidden="true">
  <g class="puffs"><circle cx="62" cy="10" r="9"/><circle cx="44" cy="-6" r="12"/><circle cx="22" cy="-24" r="15"/></g>
  <rect class="dark" x="48" y="22" width="26" height="40" rx="3"/><rect class="dark" x="42" y="16" width="38" height="10" rx="3"/>
  <rect class="body" x="22" y="58" width="176" height="72" rx="16"/><rect class="dark" x="12" y="60" width="28" height="68" rx="9"/>
  <rect class="brass" x="92" y="58" width="6" height="72"/><rect class="brass" x="152" y="58" width="6" height="72"/>
  <ellipse class="brass" cx="124" cy="58" rx="18" ry="13"/><circle class="lamp" cx="16" cy="52" r="7"/>
  <rect class="dark" x="182" y="16" width="112" height="14" rx="6"/><rect class="body" x="190" y="28" width="96" height="102" rx="4"/>
  <rect class="window" x="208" y="44" width="58" height="42" rx="7"/>
  <rect class="dark" x="6" y="128" width="290" height="12" rx="2"/><rect class="brass" x="0" y="124" width="10" height="22" rx="2"/>
  <g class="wheel"><circle cx="76" cy="164" r="26"/><circle cx="138" cy="164" r="26"/><circle cx="200" cy="164" r="26"/><circle cx="262" cy="172" r="18"/></g>
  <g class="hub"><circle cx="76" cy="164" r="6"/><circle cx="138" cy="164" r="6"/><circle cx="200" cy="164" r="6"/><circle cx="262" cy="172" r="5"/></g>
  <rect class="brass" x="72" y="160" width="132" height="8" rx="4"/>
</svg>`;

// The night the trains run through, drawn flat: a crescent moon and a few stars over the gallery, and behind each
// line a strip of far hills and nearer telegraph poles that scroll past at two speeds, so the trains seem to travel.
// Each strip holds two 1920-wide tiles and slides one tile's width per loop. Static markup; colours come from CSS.
const STAR = 'M0 -7 L1.6 -1.6 L7 0 L1.6 1.6 L0 7 L-1.6 1.6 L-7 0 L-1.6 -1.6 Z';
const SKY = `<svg class="art-sky" viewBox="0 0 1920 1080" aria-hidden="true">
  <circle class="moon" cx="1272" cy="74" r="30"/><circle class="bite" cx="1287" cy="63" r="26"/>
  ${[[430, 44, 0], [566, 104, 1.3], [712, 32, .6], [866, 120, 2.1], [988, 58, 1.7], [1128, 126, .3], [1412, 128, 2.6],
    [1110, 640, .9], [1330, 710, 2.3], [1540, 626, 1.1], [1730, 700, .4]]
    .map(([x, y, d]) => `<path class="star" style="animation-delay:${d}s" transform="translate(${x} ${y})" d="${STAR}"/>`).join('')}
</svg>`;
const HILLS = 'M0 150 Q160 70 360 120 T760 110 T1160 132 T1560 92 T1920 150 V200 H0 Z';
const POLES = Array.from({ length: 6 }, (_, k) => {
  const x = 160 + 320 * k;
  return `<rect x="${x - 3}" y="60" width="6" height="140"/><rect x="${x - 22}" y="66" width="44" height="5"/>`
    + `<path class="wire" d="M${x - 16} 70 Q${x + 144} 94 ${x + 304} 70 M${x + 16} 70 Q${x + 176} 94 ${x + 336} 70"/>`;
}).join('');
const SCENERY = `<svg class="art-scenery" viewBox="0 0 1920 200" aria-hidden="true">
  <g class="far"><path class="hills" d="${HILLS}"/><path class="hills" transform="translate(1920 0)" d="${HILLS}"/></g>
  <g class="near"><g class="poles">${POLES}</g><g class="poles" transform="translate(1920 0)">${POLES}</g></g>
</svg>`;

function addTile() {
  const b = el('button', 'art-card art-add');
  b.type = 'button';
  b.insertAdjacentHTML('beforeend', ENGINE);
  b.prepend(el('span', 'art-title', 'Add a picture'), el('span', 'art-add-note', 'Drop a file or press U'));
  b.addEventListener('click', () => gal.pick.click());
  b.addEventListener('pointermove', (e) => { if (moved(e) && (galIdle || galSel.s !== 0 || galSel.i !== 0)) select({ s: 0, i: 0 }, true); });
  b.addEventListener('pointerleave', () => { if (galHover) unchoose(); });
  return b;
}

// The pointer left the carriage it had chosen: the carriage folds flat again and nothing is chosen, until a key
// (which picks up where it was) or the pointer chooses again. A choice made with the keys stays put.
function unchoose() {
  galIdle = true;
  galHover = false;
  for (const c of gal.root.querySelectorAll('.art-row > li > .selected')) {
    c.classList.remove('selected');
    c.removeAttribute('aria-current');
  }
}


// A pointer that really moved. Chrome also fires boundary events when cards re-render under a parked mouse, and on
// the kiosk that must not steal the keyboard's choice.
const moved = (e) => !!(e.movementX || e.movementY);

// The arrow from one step to the next: a route line arcing over the coupling, its arrowhead along the curve's end.
const STEP_ARROW = `<svg class="art-step-arrow" viewBox="0 0 160 44" aria-hidden="true">
  <path class="line" d="M8 40 Q80 -6 146 36"/><polygon class="head" points="150,39 136,38 142,27"/>
</svg>`;
const STEPS = ['Drop or photograph a picture', 'Gemini outlines what is in it', 'It stands up in 3D', 'Step into the world from your phone'];

// The how-it-works line demonstrates the pipeline on a sample, in green demonstration carriages behind the engine,
// arrowed one to the next: the picture, Gemini's outlines, its cut-outs standing up, then a rider standing in it.
function ghostSteps(sample) {
  return STEPS.map((text, k) => {
    const li = el('li', 'art-slot'), car = el('div', 'art-card art-demo');
    li.setAttribute('aria-hidden', 'true');
    car.append(el('span', 'art-ghost-n', String(k + 1)));
    if (sample && sample.image) {
      const { mat, plate } = printEl(sample);
      car.append(mat);
      if (k === 1) sceneFor(sample).then((scene) => outline(plate, peekLayers(scene)));
      if (k >= 2) { mat.classList.add('selected'); peek(mat, sample); }
      if (k === 3) plate.append(el('span', 'art-rider'));
    }
    car.append(el('span', 'art-ghost-text', text));
    li.append(car);
    if (k < STEPS.length - 1) li.insertAdjacentHTML('beforeend', STEP_ARROW);
    return li;
  });
}

function cardEl(c, s, i) {
  const card = el('article', 'art-card');
  const open = el('button', 'art-open');
  open.type = 'button';
  open.title = c.title;
  const { mat, plate } = printEl(c);
  mat.append(el('span', 'art-peekline'));
  const meta = el('span', 'art-meta');
  meta.append(el('span', 'art-by', c.by)); // the sample's artist line
  open.append(mat, el('span', 'art-title', c.title), meta);
  open.addEventListener('click', () => gal.detail.show(c));
  card.addEventListener('pointermove', (e) => {
    if (!moved(e)) return;
    if (galIdle || galSel.s !== s || galSel.i !== i) select({ s, i }, true);
    tiltTo(plate, e);
  });
  card.addEventListener('pointerleave', () => {
    tiltTo(plate, null);
    if (galHover) unchoose();
  });
  card.append(open);
  return card;
}

// Scrolls a shelf just enough to show its chosen card clear of the 72 px edge fade.
function keepInView(row, li) {
  const pad = 84, left = li.offsetLeft - pad, right = li.offsetLeft + li.offsetWidth + pad;
  if (left < row.scrollLeft) row.scrollLeft = left;
  else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
}

// Chooses a carriage; `hover` when the pointer chose it, so leaving it un-chooses it again. Moving to another one
// clacks over a rail joint, unless `quiet` (the shelves being built).
function select(sel, hover = false, quiet = false) {
  const was = galIdle ? null : galSel;
  galSel = moveShelf(sel, '', galRows.map((r) => r.length));
  if (!quiet && (!was || was.s !== galSel.s || was.i !== galSel.i)) tell(audio, 'play', 'step');
  galHover = hover;
  galIdle = false;
  gal.shelves.forEach((sh, s) => galRows[s].forEach((c, i) => {
    const on = s === galSel.s && i === galSel.i, card = sh.list.children[i].firstElementChild;
    card.classList.toggle('selected', on);
    if (on) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }));
  const li = gal.shelves[galSel.s].list.children[galSel.i], c = galRows[galSel.s][galSel.i];
  if (!li) return;
  keepInView(gal.shelves[galSel.s].list, li);
  if (!c.add) peek(li.firstElementChild, c);
}

// Builds both lines: how it works (the engine, the only thing on it to choose, then the three demo steps) and the
// samples, choosing the first sample.
function renderGallery(sam) {
  galRows = [[ADD], sam];
  gal.shelves.forEach((sh, s) => {
    sh.count.textContent = s === 1 ? String(sam.length) : '';
    sh.list.replaceChildren(...galRows[s].map((c, i) => {
      const li = el('li', 'art-slot');
      li.style.setProperty('--n', s * 4 + i);
      li.append(c.add ? addTile() : cardEl(c, s, i));
      return li;
    }));
  });
  // The steps are not in galRows, so arrows never land on them.
  gal.shelves[0].list.append(...ghostSteps(sam.find((c) => c.id === 'sample-sketch') || sam[0]));
  select({ s: 1, i: 0 }, false, true);
  for (const sh of gal.shelves) fades(sh.list);
}

async function openGallery() {
  if (!gal) return;
  galOpen = true;
  gal.root.hidden = false;
  tell(audio, 'play', 'gallery');
  const sam = await samples();
  if (!galOpen) return;
  renderGallery(mergeGallery({ samples: sam }, GALLERY_CARDS));
}

function closeGallery() {
  galOpen = false;
  if (!gal) return;
  gal.root.hidden = true;
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
    if (k === 'Escape') { closeGallery(); return; }
    const c = galRows[galSel.s][galSel.i];
    // Arrows move the gallery's own selection, so a carriage left focused by Tab must not keep a second glow.
    if (k !== 'Enter' && gal.root.contains(document.activeElement)) document.activeElement.blur();
    // With nothing chosen (the pointer left), an arrow first brings the choice back where it was, and Enter waits.
    if (k !== 'Enter') select(galIdle ? galSel : moveShelf(galSel, k, galRows.map((r) => r.length)));
    else if (galIdle) return;
    else if (c && c.add) gal.pick.click();
    else if (c) gal.detail.show(c);
    return;
  }
  if (e.repeat) return;
  if (k === 'g') toggleGallery();
  else if (k === 'u' && gal) gal.pick.click();
  else if (k === '1' || k === '2' || k === '3') loadSample(Number(k)).then((ok) => ok && tell(audio, 'play', 'appear'));
}

// Keys inside the sidebar and the boarding screen stay there (as in the API box), so arrows never walk a figure behind
// them: arrows move between the buttons, Escape backs out, Enter presses the focused button.
function modalKeys(root, onEscape) {
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
    if (!/^Arrow/.test(e.key)) return;
    e.preventDefault();
    const btns = Array.from(root.querySelectorAll('button')), i = btns.indexOf(document.activeElement);
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    btns[(i + d + btns.length) % btns.length]?.focus();
  });
}

function modalRoot(cls, label) {
  const root = el('section', cls);
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', label);
  return root;
}

// After a carriage is pressed, a sidebar slides in from the right with the picture lying flat. Pointing at a part
// lifts just that part out toward you (with its shadow and the blueprint gap it leaves) and shows its name; nothing
// says what it does (riders find out on board). Two tickets at the foot: ride solo, or with a group (the boarding
// screen with the party's QR).
function buildDetail() {
  const root = modalRoot('art-detail', 'Carriage');
  const panel = el('aside', 'art-detail-panel'), view = el('div', 'art-detail-view'), tip = el('span', 'art-detail-tip');
  const kicker = el('p', 'art-detail-kicker'), title = el('h2'), hint = el('p', 'art-detail-hint'), note = el('p', 'art-detail-note');
  const shut = el('button', 'art-detail-close');
  // Two railway tickets at the foot: a single and a party fare.
  const ticket = (cls, name, text) => {
    const b = el('button', 'art-ticket ' + cls), words = el('span', 'art-ticket-words');
    b.type = 'button';
    words.append(el('span', 'art-ticket-name', name), el('span', 'art-ticket-note', text));
    b.append(el('span', 'art-ticket-icon'), words);
    return b;
  };
  const solo = ticket('solo', 'Ride solo', 'Just you, with the keyboard or one phone');
  const group = ticket('group', 'Ride with a group', 'Everyone scans one code and rides together');
  const tickets = el('div', 'art-tickets');
  tickets.append(solo, group);
  shut.type = 'button';
  shut.setAttribute('aria-label', 'Back to the gallery');
  view.setAttribute('role', 'img');
  tip.hidden = true;
  panel.append(shut, kicker, view, hint, title, note, tickets);
  root.append(panel);
  let my = 0, hot = null;
  const close = () => { my++; root.hidden = true; document.activeElement?.blur(); };
  modalKeys(root, close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  shut.addEventListener('click', close);
  // One part lifted at a time: its lift and its hole (same k) get .hot; a receding plane is only named.
  const setHot = (k) => {
    if (hot === k) return;
    for (const e of view.querySelectorAll('.hot')) e.classList.remove('hot');
    hot = k;
    view.querySelector('.art-mat')?.classList.toggle('has-hot', k !== null);
    if (k !== null) for (const e of view.querySelectorAll(`[data-k="${k}"]`)) e.classList.add('hot');
  };
  view.addEventListener('pointermove', (e) => {
    const hit = e.target.closest?.('[data-label]');
    setHot(hit?.closest('.art-lift')?.dataset.k ?? null);
    if (!hit) { tip.hidden = true; return; }
    // #tv is scaled to the window, so client px are turned back into the frame's own px.
    const r = view.getBoundingClientRect(), s = r.width / view.offsetWidth || 1;
    tip.textContent = hit.dataset.label;
    tip.style.left = `${(e.clientX - r.left) / s}px`;
    tip.style.top = `${(e.clientY - r.top) / s}px`;
    tip.hidden = false;
  });
  view.addEventListener('pointerleave', () => { setHot(null); tip.hidden = true; });
  const show = async (c) => {
    const me = ++my, print = printEl(c);
    hot = null;
    tip.hidden = true;
    view.replaceChildren(print.mat, tip);
    view.setAttribute('aria-label', c.title);
    kicker.textContent = c.by;
    title.textContent = c.title;
    hint.textContent = '';
    note.textContent = 'Reading the picture…';
    solo.onclick = () => { tell(audio, 'play', 'punch'); close(); openCard(c); };
    group.onclick = () => { tell(audio, 'play', 'punch'); close(); ride(c); };
    root.hidden = false;
    tell(audio, 'play', 'door');
    solo.focus();
    peek(print.mat, c);
    const scene = await sceneFor(c);
    if (me !== my) return;
    const parts = peekLayers(scene, { surfaces: true });
    // The receding planes are named where they lie, under the cut-outs.
    const back = print.mat.querySelector('.art-back');
    for (const l of parts.filter((p) => p.surface)) {
      const zone = el('span', 'art-zone');
      zone.style.clipPath = l.clip;
      zone.dataset.label = l.label;
      back.append(zone);
    }
    view.setAttribute('aria-label', `${c.title}: ${parts.map((p) => p.label).join(', ')}`);
    hint.textContent = parts.length ? 'Point at the picture: each part lifts out and says its name.' : '';
    note.textContent = !parts.length ? 'No saved reading: this one rides as a flat picture.'
      : c.saved === 'sample' ? 'What each one does, you find out on board.'
        : 'Names are AI guesses. What each one does, you find out on board.';
  };
  return { root, show };
}

// One seat card, as on a console's controller-pairing screen: an open seat is a dashed outline with its number; a taken
// one shows the phone in its player's colour, the rider's name and the seat. `fresh` pops a card when its phone arrives.
function seatEl(p, i, fresh) {
  const li = el('li', 'art-seat' + (p ? ' taken' : '') + (p && p.away ? ' away' : '') + (fresh ? ' fresh' : ''));
  if (!p) {
    li.append(el('span', 'art-seat-n', String(i + 1)));
    return li;
  }
  li.style.setProperty('--seat', p.color);
  const words = el('span', 'art-seat-words');
  words.append(el('span', 'art-seat-name', p.name), el('span', 'art-seat-sub', p.away ? 'Away' : `Seat ${i + 1}`));
  li.append(el('span', 'art-seat-phone'), words);
  return li;
}

// The boarding screen: the TV's own join code (copied from glue.js's #qr, so it is always the code phones use) drawn
// large for a group around the screen, and a row of seats that fill as their phones join, while the picture loads behind.
function buildBoard() {
  const root = modalRoot('art-board', 'Boarding');
  const ticket = el('div', 'art-board-ticket'), side = el('div', 'art-board-side');
  const title = el('h2'), count = el('p', 'art-board-count'), seats = el('ol', 'art-seats');
  const go = el('button', 'art-board-go', 'All aboard'), back = el('button', 'art-board-back', 'Back to the gallery');
  go.type = back.type = 'button';
  const btns = el('div', 'art-board-btns');
  btns.append(go, back);
  const head = el('div', 'art-board-head'), seatHead = el('div', 'art-seats-head');
  head.append(el('p', 'art-board-kicker', 'Now boarding'), title);
  seatHead.append(el('h3', null, 'Seats'), count);
  side.append(head, seatHead, seats, btns);
  root.append(ticket, side);
  let timer = 0, qrKey = null, seatKeys = [];
  const close = () => { root.hidden = true; clearInterval(timer); document.activeElement?.blur(); };
  const refresh = () => {
    // glue.js hides #qr while the relay is resting: then no phone can join, whatever codes it still holds.
    const qr = document.getElementById('qr'), figs = qr && !qr.hidden ? Array.from(qr.querySelectorAll('figure')) : [];
    const key = figs.map((f) => f.textContent).join('|');
    if (key !== qrKey) {
      qrKey = key;
      ticket.classList.toggle('off', !figs.length);
      // A printed party ticket: the code, then a perforated stub saying what it admits.
      ticket.replaceChildren(...(figs.length
        ? [...figs.map((f) => bigQr(f, figs.length > 1 ? 300 : 444)), el('p', 'art-board-stub', `Party ticket · up to ${MAX_PLAYERS} phones`)]
        : [el('p', 'art-board-off', "Phones can't join right now: the relay isn't answering. Ride with the keyboard.")]));
    }
    // glue.js's roster: the keyboard's row first (it always rides, so it takes no seat), then a row per phone in the
    // order they joined, each a colour dot and a name.
    const phones = Array.from(document.querySelectorAll('#roster li')).slice(1, 1 + MAX_PLAYERS).map((li) => ({
      name: (li.lastElementChild?.textContent || '').replace(/ \(away\)$/, ''),
      color: li.querySelector('.dot')?.style.background || '', away: li.classList.contains('away'),
    }));
    const keys = Array.from({ length: MAX_PLAYERS }, (_, i) => (phones[i] ? JSON.stringify(phones[i]) : ''));
    // Rebuilt only on a change, so a seat pops once, when its phone arrives.
    if (keys.join('|') !== seatKeys.join('|')) {
      seats.replaceChildren(...keys.map((k, i) => seatEl(phones[i], i, !!k && k !== seatKeys[i])));
      seatKeys = keys;
    }
    count.textContent = `${phones.length} of ${MAX_PLAYERS} taken · the keyboard always rides`;
  };
  go.addEventListener('click', () => { tell(audio, 'play', 'whistle'); close(); });
  back.addEventListener('click', () => { close(); openGallery(); });
  modalKeys(root, close);
  const show = (c) => {
    title.textContent = c.title;
    qrKey = null;
    seatKeys = [];
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 1000);
    root.hidden = false;
    go.focus();
  };
  return { root, show };
}

// One of #qr's codes redrawn at about `target` px, in whole multiples of its modules so it stays sharp and scannable.
function bigQr(fig, target) {
  const src = fig.querySelector('canvas'), out = el('figure', 'art-board-qr');
  if (src && src.width) {
    const k = Math.max(1, Math.round(target / src.width)), c = document.createElement('canvas');
    c.width = c.height = src.width * k;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'QR code');
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, c.width, c.height);
    out.append(c);
  }
  const cap = fig.querySelector('figcaption'), url = fig.querySelector('.url');
  out.append(el('figcaption', null, cap ? cap.firstChild?.textContent || '' : ''), ...(url ? [el('span', 'url', url.textContent)] : []));
  return out;
}

// Group ride: the picture opens behind the boarding screen, so it is on stage when the party departs.
function ride(c) {
  openCard(c);
  gal.board.show(c);
}

function buildDom() {
  // The gallery and its two screens cover the whole TV frame, margins included; the drop hint stays on the stage.
  const tv = document.getElementById('tv') || document.body, host = document.getElementById('stage') || tv;
  const root = el('section', 'art-gallery');
  root.id = 'artGallery';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', "Gallery of today's projects");
  const head = el('header', 'art-head');
  head.append(el('h2', null, 'Gallery'));
  root.insertAdjacentHTML('afterbegin', SKY);
  root.append(head);
  const shelf = (title, cls) => {
    const sec = el('section', 'art-shelf ' + cls), top = el('header', 'art-shelf-head');
    const count = el('span', 'art-count'), list = el('ol', 'art-row');
    top.append(el('h3', null, title), count);
    list.addEventListener('scroll', () => fades(list), { passive: true });
    sec.insertAdjacentHTML('afterbegin', SCENERY);
    sec.append(top, list);
    root.append(sec);
    return { count, list };
  };
  // Today's line is the hero; the samples wait on a quieter siding below it.
  const shelvesDom = [shelf('How it works', 'major'), shelf('Samples', 'minor')];
  // Every instruction lives in one quiet line at the foot of the screen.
  const foot = el('footer', 'art-foot');
  const keys = (caps, text) => {
    const s = el('span');
    s.append(...caps.map((k) => el('kbd', null, k)), ' ' + text);
    return s;
  };
  foot.append(keys(['←', '→'], 'along the train'), keys(['↑', '↓'], 'change line'), keys(['Enter'], 'board'), keys(['Esc'], 'close'),
    el('span', 'art-foot-note', 'Titles are AI guesses'));
  root.append(foot);
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
  const detail = buildDetail(), board = buildBoard();
  tv.append(root, detail.root, board.root);
  host.append(drop, pick);
  return { root, shelves: shelvesDom, drop, pick, detail, board };
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
