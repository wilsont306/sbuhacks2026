// The TV's margins and overlays (README contract F): in the left margin the line, an enamel station sign for the AI's
// guess at the picture (#label) over its stops (#legend: every object a figure walks to, in walk order, each with a
// crop of the picture; the stops figures stand at are lit, and a description opens in its stop); in the right margin
// the sound flash, the data-use notice while no join ticket shows it, and behind H the source thumbnail and saved
// badge; the platform panel over the stage bottom (the W 'network' layer); the L Learning overlay; X hides the AI
// labels. glue.js calls init and tells it who stands where. Every string from a scene reaches the page through
// textContent only.
import learning from '../shared/learning.json';
import { objectHotspots, pathPoints } from './maskDepth.js';
import './margins.css';

/* pure:start (tests/margins.test.js imports this block on its own, so it must not use imports or globals) */
export const CHIP = 'AI draft, not a museum record';
export const CHIP_EDITED = 'AI draft, hand-corrected (sample)';
export const NOTICE = 'Pictures sent here are public demo content read by Google Gemini (free tier).';
const SAVED = { saved: 'Saved to Snowflake', saving: 'saving…', local: 'local only', sample: 'sample', unsaved: 'not saved' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One line of display text, capped.
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const pad = (n) => String(n).padStart(2, '0');
const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export const chipText = (scene) => (scene && scene.edited === true ? CHIP_EDITED : CHIP);
export const savedText = (state) => (typeof state === 'string' && Object.hasOwn(SAVED, state) ? SAVED[state] : SAVED.unsaved);

// Only URLs an <img> may load: http(s), site-relative, blob: and data:image. Anything else (javascript:, //host) is ''.
export const safeUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|\/(?!\/)|blob:|data:image\/)/i.test(u) ? u : '');

// 'HH:MM' in the TV's local time, or '—'.
export function clock(iso) {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
}

// A Learning timestamp: an ISO time becomes 'Sat 14:05'; anything else is shown as written ('Sat 10:15').
export function stamp(at) {
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at)) {
    const d = new Date(at);
    if (Number.isFinite(d.getTime())) return `${DAYS[d.getDay()]} ${clock(at)}`;
  }
  return str(at, 40);
}

// What the station sign and the source block show for a scene; null when there is none. (The credit is the
// original's, under O; the stops come from the scene's objects.)
export function labelOf(scene) {
  if (!scene || typeof scene !== 'object') return null;
  // the validator writes 'unknown' when Gemini gave no guess
  const guess = (v, what) => { const s = str(v, 120); return s && s.toLowerCase() !== 'unknown' ? s : `${what} unknown`; };
  return {
    artist: guess(scene.artist_guess, 'Artist'),
    title: guess(scene.title_guess, 'Title'),
    chip: chipText(scene),
    thumb: safeUrl(scene.image_url),
  };
}

// One live line per platform for the 'network' layer. hub: the relay's {t:'hub'} message; audio: audio.stats();
// depth: enrich.stats(); models: models3d.stats(), 'off' when D turned them off or the server has no Tripo key.
export function platformLines({ hub, scene, saved, id, audio, depth, models } = {}) {
  const h = hub && typeof hub === 'object' ? hub : null;
  const where = h && (h.region === 'local' ? 'laptop relay (Q)' : `relay ${str(h.region, 20) || 'vercel'}`);
  const a = audio && typeof audio === 'object' ? audio : {};
  const d = depth && typeof depth === 'object' ? depth : {}, t = models && typeof models === 'object' ? models : {};
  return [
    { name: 'Vercel', text: h ? `${where} · instance ${str(h.instance, 8) || '—'} · bus ${h.bus === 'redis' ? 'Upstash Redis' : 'local'}` : 'relay not connected' },
    { name: 'Gemini', text: !scene ? 'no reading on screen' : scene.edited === true ? 'sample, edited (hand-corrected)'
      : `${str(scene.model, 40) || 'unknown model'} · read at ${clock(scene.generated_at)}` },
    { name: 'ElevenLabs', text: `played ${count(a.played)} · generated ${count(a.generated)} · cached ${count(a.cached)}` },
    { name: 'Snowflake', text: `project ${str(id, 48) || '—'} · ${savedText(saved)}` },
    { name: 'Depth Anything V2', text: `${str(d.device, 20) || '—'} · ${str(d.state, 20) || 'idle'} · ${count(d.ms)} ms` },
    { name: 'Tripo', text: t.on !== true || t.last === 'off' ? 'off' : `${count(t.ready)} ready · ${count(t.running)} running` },
  ];
}

// A stop's description: the object's label and its description, cleaned for display.
export const describeCard = (label, text) => ({ label: str(label, 40) || 'Object', text: str(text, 240) });

// A stop's picture: the part of the painting around an object's box ([x0, y0, x1, y1], 0..1000 image space), with a
// little room round it and widened to a 4:3 window at the picture's aspect (width / height), as CSS background-size
// and background-position for the whole picture. Never stretched: a box too big for the picture zooms in instead.
// null without a usable box or aspect.
export function cropOf(box, aspect) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || !(aspect > 0 && Number.isFinite(aspect))) return null;
  const x0 = Math.max(0, Math.min(box[0], box[2])), x1 = Math.min(1000, Math.max(box[0], box[2]));
  const y0 = Math.max(0, Math.min(box[1], box[3])), y1 = Math.min(1000, Math.max(box[1], box[3]));
  let w = (x1 - x0) / 1000 * 1.12, h = (y1 - y0) / 1000 * 1.12; // fractions of the picture's width and height
  if (!(w > 0 && h > 0)) return null;
  if (w * aspect / h < 4 / 3) w = h * 4 / 3 / aspect; else h = w * aspect * 3 / 4;
  if (w > 1) { h /= w; w = 1; }
  if (h > 1) { w /= h; h = 1; }
  const at = (c, f) => (f < 1 ? Math.min(Math.max(c - f / 2, 0), 1 - f) / (1 - f) : 0); // the offset as a percentage's fraction
  const pct = (x) => `${Math.round(x * 1e4) / 100}%`;
  return { size: `${pct(1 / w)} ${pct(1 / h)}`, position: `${pct(at((x0 + x1) / 2000, w))} ${pct(at((y0 + y1) / 2000, h))}` };
}

// learning.json entries with a who and a text, cleaned for display, in file order.
export function learningEntries(json) {
  const list = json && Array.isArray(json.entries) ? json.entries : [];
  return list.filter((e) => e && typeof e === 'object' && str(e.who) && str(e.text)).slice(0, 60)
    .map((e) => ({ who: str(e.who, 40), at: stamp(e.at), text: str(e.text, 400), shot: safeUrl(e.shot) }));
}
/* pure:end */

const FLASH_MS = 2000, PLATFORM_TICK_MS = 1000, DESCRIBE_MS = 10000;

const h = (tag, cls, ...kids) => { const el = document.createElement(tag); if (cls) el.className = cls; el.append(...kids); return el; };

let els = null, scene = null, saved = 'unsaved', projectId = '', hub = null, audioStats = () => ({}), depthStats = () => ({}), modelStats = () => ({});
let flashT = 0, platformT = 0, describeT = 0;
const riders = new Map(); // pid -> {index, color}: the stop each figure stands at (glue.js's setNear)
let routeScene; // the scene the stops were built for
let staged = ''; // the picture on stage (artwork.js's setScene image), else the scene's own image_url

export function init(opts = {}) {
  if (typeof opts.audioStats === 'function') audioStats = opts.audioStats;
  if (typeof opts.depthStats === 'function') depthStats = opts.depthStats;
  if (typeof opts.modelStats === 'function') modelStats = opts.modelStats;
  if (els) return;
  const tv = document.getElementById('tv'), stage = document.getElementById('stage');
  const left = document.querySelector('#tv .margin.left'), right = document.querySelector('#tv .margin.right');
  if (!tv || !stage || !left || !right) return; // not the host page
  let label = document.getElementById('label');
  if (!label) { label = h('div', 'tombstone'); label.id = 'label'; left.prepend(label); }

  const route = h('ol', 'route');
  const legend = h('section', '', h('h2', '', 'Stops on this line'), route); legend.id = 'legend'; legend.hidden = true;
  legend.setAttribute('aria-live', 'polite'); // a description opening under its stop is read out
  left.append(legend);

  // The flash is for everyone; the thumbnail and badge are the operator's (H). The data-use notice rides on the
  // join ticket (glue.js); this copy shows while there is no ticket, since U and a dropped file still send pictures.
  const flashEl = h('p', 'flash'); flashEl.setAttribute('role', 'status'); flashEl.hidden = true;
  const thumb = h('img', 'thumb'); thumb.alt = 'The source picture'; thumb.hidden = true;
  thumb.addEventListener('error', () => { thumb.hidden = true; });
  thumb.addEventListener('load', paintCrops); // the stops' crops need the picture's aspect
  const badge = h('p', 'badge'); badge.hidden = true;
  const source = h('section', '', flashEl, thumb, badge, h('p', 'notice', NOTICE));
  source.id = 'source'; source.setAttribute('aria-label', 'Source picture');
  right.prepend(source);

  const platformList = h('dl', '');
  const platforms = h('section', '', platformList); platforms.id = 'platforms'; platforms.hidden = true;
  platforms.setAttribute('aria-label', 'The platforms, live');
  const learn = h('section', ''); learn.id = 'learning'; learn.hidden = true; learn.setAttribute('aria-label', 'Learning');
  stage.append(platforms, learn);

  els = { tv, label, legend, route, flash: flashEl, thumb, badge, platforms, platformList, learning: learn };
  renderLearning();
  renderScene();

  addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'l') toggleLearning();
    else if (k === 'x') toggleLabels();
  });
}

export function setScene(s, opts = {}) {
  scene = s && typeof s === 'object' ? s : null;
  projectId = scene ? str(scene.id, 128) : '';
  saved = opts && opts.saved ? opts.saved : scene && scene.source === 'sample' ? 'sample' : 'unsaved';
  staged = scene && opts ? safeUrl(opts.image) : '';
  renderScene(); // a new route: the last scene's lit stops and description go with it
}

// The stop a figure stands at (an object index; null when it stands at none), lit in that rider's colour.
export function setNear(pid, index, color) {
  if (Number.isInteger(index)) riders.set(pid, { index, color: typeof color === 'string' ? color : '' });
  else riders.delete(pid);
  paintNear();
}

export function setSaved(state, id) {
  // a late confirmation for a project no longer on screen must not badge the current one
  if (id && projectId && String(id) !== projectId) return;
  saved = state;
  if (id && !projectId) projectId = str(String(id), 128);
  renderScene();
}

export function setHub(m) {
  hub = m && typeof m === 'object' ? m : null;
  renderPlatforms();
}

export function showPlatforms(on) {
  if (!els) return;
  els.platforms.hidden = !on;
  clearInterval(platformT);
  if (on) platformT = setInterval(renderPlatforms, PLATFORM_TICK_MS); // the ElevenLabs, depth and Tripo lines move while it is open
  renderPlatforms();
}

export function flash(text) {
  if (!els) return;
  els.flash.textContent = str(text, 160);
  els.flash.hidden = !els.flash.textContent;
  clearTimeout(flashT);
  flashT = setTimeout(() => { els.flash.hidden = true; }, FLASH_MS);
}

// The object a figure asked about (scene.js's object index, else its label): its description opens under its stop
// for 10 s; the latest replaces the previous.
export function showDescription(label, text, index) {
  if (!els) return;
  const c = describeCard(label, text), stops = [...els.route.children];
  const stop = stops.find((li) => Number(li.dataset.index) === index) || stops.find((li) => li.dataset.label === c.label);
  clearTimeout(describeT);
  for (const li of stops) li.querySelector('.say')?.remove();
  if (!stop || !c.text) return;
  stop.append(h('p', 'say', h('b', '', 'AI: '), c.text));
  describeT = setTimeout(() => stop.querySelector('.say')?.remove(), DESCRIBE_MS);
}

export function toggleLearning() {
  if (!els) return false;
  els.learning.hidden = !els.learning.hidden;
  return !els.learning.hidden;
}

export function toggleLabels() {
  if (!els) return false;
  return !els.tv.classList.toggle('labels-off');
}

function renderScene() {
  if (!els) return;
  const m = labelOf(scene);
  // the margins clamp long lines with an ellipsis; the title attribute keeps the full text
  const full = (el) => { el.title = el.textContent; return el; };
  // The sign: the title (a subtitle after a dash or colon goes on its own smaller line), the artist, whose guess.
  const [main, ...rest] = m ? m.title.split(/\s+[–—-]\s+|:\s+/) : [], sub = rest.join(' – ');
  els.label.replaceChildren(...(m ? [
    full(h('p', 'title ai', main)), ...(sub ? [full(h('p', 'sub ai', sub))] : []), full(h('p', 'artist ai', m.artist)),
    h('p', 'chip ai', m.chip), h('p', 'labels-note', 'AI labels hidden'),
  ] : []));
  // The stops, in the order the figures reach them (scene.js's stops: the same objects, the same labels). Built once
  // per scene, so a saved badge changing never closes an open description.
  if (routeScene !== scene) {
    routeScene = scene;
    const stops = scene ? objectHotspots(scene, pathPoints(scene, () => 0)) : [];
    els.legend.hidden = !stops.length;
    els.route.replaceChildren(...stops.map((s) => {
      const li = h('li', '', h('span', 'thumb'), full(h('span', 'name', s.label)));
      li.dataset.index = s.index; li.dataset.label = s.label;
      return li;
    }));
  }

  const src = m ? staged || m.thumb : '';
  if (!src) els.thumb.removeAttribute('src');
  else if (els.thumb.getAttribute('src') !== src) els.thumb.src = src;
  els.thumb.hidden = !src;
  paintCrops(); paintNear();
  els.badge.hidden = !m;
  els.badge.textContent = savedText(saved);
  els.badge.classList.toggle('ok', saved === 'saved');
  renderPlatforms();
}

// Each stop's crop of the picture, once the picture (the H thumbnail: the same image as the stage's) has loaded.
function paintCrops() {
  const img = els.thumb, src = img.getAttribute('src'), aspect = img.naturalWidth / img.naturalHeight;
  if (!src || !img.complete || !(aspect > 0)) return;
  for (const li of els.route.children) {
    const o = scene && scene.objects[Number(li.dataset.index)], c = o && cropOf(o.box, aspect), t = li.firstChild;
    t.style.backgroundImage = c ? `url(${JSON.stringify(src)})` : '';
    t.style.backgroundSize = c ? c.size : '';
    t.style.backgroundPosition = c ? c.position : '';
  }
}

// Lights the stops figures stand at, each in its rider's colour (the first rider's, when two share a stop).
function paintNear() {
  if (!els) return;
  for (const li of els.route.children) {
    const r = [...riders.values()].find((x) => x.index === Number(li.dataset.index));
    li.classList.toggle('here', !!r);
    if (r && r.color) li.style.setProperty('--rider', r.color); else li.style.removeProperty('--rider');
  }
}

function renderPlatforms() {
  if (!els || els.platforms.hidden) return;
  // another module's own failure must not blank the panel
  const read = (fn) => { try { return fn() || {}; } catch { return {}; } };
  els.platformList.replaceChildren(...platformLines({ hub, scene, saved, id: projectId, audio: read(audioStats), depth: read(depthStats), models: read(modelStats) })
    .map((l) => h('div', 'row', h('dt', '', l.name), h('dd', '', l.text))));
}

function renderLearning() {
  const list = learningEntries(learning);
  els.learning.replaceChildren(h('h2', '', 'Learning: what surprised us'), list.length
    ? h('ol', '', ...list.map((e) => h('li', '',
      ...(e.shot ? [Object.assign(h('img', 'shot'), { src: e.shot, alt: `Screenshot for ${e.who}'s entry` })] : []),
      h('p', 'meta', e.at ? `${e.who} · ${e.at}` : e.who), h('p', 'text', e.text))))
    : h('p', 'empty', 'No entries yet. Each teammate adds theirs to src/shared/learning.json as {"who", "at", "text", "shot"}; they show here after the next build.'));
}
