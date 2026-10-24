// The TV's margins and overlays (README contract F): the AI wall label (#label) and the object legend in the left
// margin; the source thumbnail, data-use notice, saved badge and sound flash in the right margin; the platform panel
// over the stage bottom (the W 'network' layer); the L Learning overlay; X hides the AI labels. glue.js calls init.
// Every string from a scene reaches the page through textContent only.
import learning from '../shared/learning.json';
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

// What the left margin and the source block show for a scene; null when there is none.
export function labelOf(scene) {
  if (!scene || typeof scene !== 'object') return null;
  // the validator writes 'unknown' when Gemini gave no guess
  const guess = (v, what) => { const s = str(v, 120); return s && s.toLowerCase() !== 'unknown' ? s : `${what} unknown`; };
  const objects = Array.isArray(scene.objects) ? scene.objects.slice(0, 8) : [];
  return {
    artist: guess(scene.artist_guess, 'Artist'),
    title: guess(scene.title_guess, 'Title'),
    chip: chipText(scene),
    credit: str(scene.credit, 300),
    legend: objects.map((o) => ({ label: str(o && o.label, 40), kind: str(o && o.kind, 20) })).filter((o) => o.label),
    thumb: safeUrl(scene.image_url),
  };
}

// One live line per platform for the 'network' layer. hub: the relay's {t:'hub'} message; audio: audio.stats().
export function platformLines({ hub, scene, saved, id, audio } = {}) {
  const h = hub && typeof hub === 'object' ? hub : null;
  const where = h && (h.region === 'local' ? 'laptop relay (Q)' : `relay ${str(h.region, 20) || 'vercel'}`);
  const a = audio && typeof audio === 'object' ? audio : {};
  return [
    { name: 'Vercel', text: h ? `${where} · instance ${str(h.instance, 8) || '—'} · bus ${h.bus === 'redis' ? 'Upstash Redis' : 'local'}` : 'relay not connected' },
    { name: 'Gemini', text: !scene ? 'no reading on screen' : scene.edited === true ? 'sample, edited (hand-corrected)'
      : `${str(scene.model, 40) || 'unknown model'} · read at ${clock(scene.generated_at)}` },
    { name: 'ElevenLabs', text: `played ${count(a.played)} · generated ${count(a.generated)} · cached ${count(a.cached)}` },
    { name: 'Snowflake', text: `project ${str(id, 48) || '—'} · ${savedText(saved)}` },
  ];
}

// learning.json entries with a who and a text, cleaned for display, in file order.
export function learningEntries(json) {
  const list = json && Array.isArray(json.entries) ? json.entries : [];
  return list.filter((e) => e && typeof e === 'object' && str(e.who) && str(e.text)).slice(0, 60)
    .map((e) => ({ who: str(e.who, 40), at: stamp(e.at), text: str(e.text, 400), shot: safeUrl(e.shot) }));
}
/* pure:end */

const FLASH_MS = 2000, PLATFORM_TICK_MS = 1000;

const h = (tag, cls, ...kids) => { const el = document.createElement(tag); if (cls) el.className = cls; el.append(...kids); return el; };

let els = null, scene = null, saved = 'unsaved', projectId = '', hub = null, audioStats = () => ({});
let flashT = 0, platformT = 0;

export function init(opts = {}) {
  if (typeof opts.audioStats === 'function') audioStats = opts.audioStats;
  if (els) return;
  const tv = document.getElementById('tv'), stage = document.getElementById('stage');
  const left = document.querySelector('#tv .margin.left'), right = document.querySelector('#tv .margin.right');
  if (!tv || !stage || !left || !right) return; // not the host page
  let label = document.getElementById('label');
  if (!label) { label = h('div', 'tombstone'); label.id = 'label'; left.prepend(label); }

  const legend = h('section', ''); legend.id = 'legend'; legend.hidden = true;
  const roster = document.getElementById('roster');
  left.insertBefore(legend, roster && roster.parentNode === left ? roster : null);

  const flashEl = h('p', 'flash'); flashEl.setAttribute('role', 'status'); flashEl.hidden = true;
  const thumb = h('img', 'thumb'); thumb.alt = 'The source picture'; thumb.hidden = true;
  thumb.addEventListener('error', () => { thumb.hidden = true; });
  const badge = h('p', 'badge'); badge.hidden = true;
  const source = h('section', '', flashEl, thumb, badge, h('p', 'notice', NOTICE));
  source.id = 'source'; source.setAttribute('aria-label', 'Source picture');
  const resting = document.getElementById('resting');
  right.insertBefore(source, resting && resting.parentNode === right ? resting : null);

  const platformList = h('dl', '');
  const platforms = h('section', '', platformList); platforms.id = 'platforms'; platforms.hidden = true;
  platforms.setAttribute('aria-label', 'The four platforms, live');
  const learn = h('section', ''); learn.id = 'learning'; learn.hidden = true; learn.setAttribute('aria-label', 'Learning');
  stage.append(platforms, learn);

  els = { tv, label, legend, flash: flashEl, thumb, badge, platforms, platformList, learning: learn };
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
  renderScene();
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
  if (on) platformT = setInterval(renderPlatforms, PLATFORM_TICK_MS); // ElevenLabs counts move while it is open
  renderPlatforms();
}

export function flash(text) {
  if (!els) return;
  els.flash.textContent = str(text, 160);
  els.flash.hidden = !els.flash.textContent;
  clearTimeout(flashT);
  flashT = setTimeout(() => { els.flash.hidden = true; }, FLASH_MS);
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
  els.label.replaceChildren(...(m ? [
    full(h('p', 'artist ai', m.artist)), full(h('p', 'title ai', m.title)), h('p', 'chip ai', m.chip),
    h('p', 'labels-note', 'AI labels hidden'),
    ...(m.credit ? [full(h('p', 'credit', m.credit))] : []),
  ] : []));
  els.legend.hidden = !m || !m.legend.length;
  els.legend.replaceChildren(h('h2', '', 'AI guesses'),
    h('ul', '', ...(m ? m.legend : []).map((o) => full(h('li', '', h('span', 'name', o.label), ' ', h('span', 'kind', `(${o.kind})`))))));

  const src = m ? m.thumb : '';
  if (!src) els.thumb.removeAttribute('src');
  else if (els.thumb.getAttribute('src') !== src) els.thumb.src = src;
  els.thumb.hidden = !src;
  els.badge.hidden = !m;
  els.badge.textContent = savedText(saved);
  els.badge.classList.toggle('ok', saved === 'saved');
  renderPlatforms();
}

function renderPlatforms() {
  if (!els || els.platforms.hidden) return;
  let audio = {};
  try { audio = audioStats() || {}; } catch { /* the audio module's own failure must not blank the panel */ }
  els.platformList.replaceChildren(...platformLines({ hub, scene, saved, id: projectId, audio })
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
