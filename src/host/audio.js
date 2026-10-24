// Host sound bus: the ElevenLabs palette in public/sfx for events and object kinds, plus up to two sounds per
// scene made by POST /api/sfx; every sound that plays is named in the margin. Never throws, never blocks the TV.
// A visitor's own ElevenLabs key (the API box, src/shared/byok.js) rides along on /api/sfx as x-elevenlabs-key.
import { apiHeaders, EVENT as KEYS_EVENT } from '../shared/byok.js';

// The gallery's railway adds four: step (between carriages), door (a carriage's sidebar), punch (a ticket chosen) and
// whistle (all aboard). A phone taking a seat already rings join.
export const EVENTS = ['join', 'poke', 'appear', 'save', 'reset', 'gallery', 'step', 'door', 'punch', 'whistle'];
export const GAIN = 0.3, PER_SCENE = 2, DAY_CAP = 25, POOL = 6, FETCH_MS = 25000;
const MUTE_KEY = 'tt.mute', DAY_KEY = 'tt.sfxday';

// Scene kinds (scene-validate KINDS) to palette files (tools/sfx-palette.json); 'bird' is not a kind, see kindFile.
export const KIND_FILE = {
  sky: 'wind', cloud: 'wind', plant: 'wind', water: 'water', fire: 'fire', animal: 'animal', bird: 'bird',
  vehicle: 'vehicle', person: 'footsteps', building: 'bell', celestial: 'twinkle', ground: 'poke', object: 'poke',
};

export function kindFile(kind, motion) {
  // Gemini files birds under animal (or object), so a flying one chirps; a flying vehicle keeps its own sound.
  if (motion === 'fly' && (kind === 'animal' || kind === 'object')) return 'bird';
  return Object.prototype.hasOwnProperty.call(KIND_FILE, kind) ? KIND_FILE[kind] : 'poke';
}

// The key api/sfx.js caches by: whitespace collapsed, lowercased.
export const labelKey = (s) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().toLowerCase();

// -> {src, file, generated}. A poke plays its label's generated sound once its url is known, else its kind's file.
export function chooseSound(event, obj, urls, motions) {
  if (event === 'poke' && obj) {
    const key = labelKey(obj.label), url = urls && urls.get(key);
    if (url) return { src: url, file: `${key} (made for this artwork)`, generated: true };
    const f = kindFile(obj.kind, obj.motion || (motions && motions.get(key)));
    return { src: `/sfx/${f}.mp3`, file: `${f}.mp3`, generated: false };
  }
  return { src: `/sfx/${event}.mp3`, file: `${event}.mp3`, generated: false };
}

// Today's generation count from the stored {day, n}; another day or junk counts as zero.
export const todayCount = (rec, day) => (rec && rec.day === day && Number.isInteger(rec.n) && rec.n > 0 ? rec.n : 0);
export const dayStamp = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// The scene's first `max` distinct labels (objects come most prominent first), minus those already known.
export function prepareList(scene, known, max = PER_SCENE) {
  const out = [], seen = new Set();
  for (const o of scene && Array.isArray(scene.objects) ? scene.objects : []) {
    const key = labelKey(o && o.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (seen.size > max) break;
    if (!known.has(key)) out.push({ label: key.slice(0, 40), prompt: (typeof o.sound_prompt === 'string' ? o.sound_prompt : '').slice(0, 200) });
  }
  return out;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: the session still works */ } },
};
const readDay = () => { try { return JSON.parse(store.get(DAY_KEY)); } catch { return null; } };

let token = '', margins = null, muted = false, off = false, keyBound = false;
let urls = new Map(), motions = new Map(), pool = [], next = 0, chain = Promise.resolve(), lastScene = null;
let counts = { played: 0, generated: 0, cached: 0 };

const flash = (text) => { try { if (margins && typeof margins.flash === 'function') margins.flash(text); } catch { /* margins never break sound */ } };

export function init(opts = {}) {
  token = typeof opts.token === 'string' ? opts.token : '';
  margins = opts.margins || null;
  muted = store.get(MUTE_KEY) === '1';
  off = false; urls = new Map(); motions = new Map(); chain = Promise.resolve(); lastScene = null;
  counts = { played: 0, generated: 0, cached: 0 };
  if (!keyBound && typeof addEventListener === 'function') { keyBound = true; addEventListener('keydown', onKey); addEventListener(KEYS_EVENT, onKeys); }
}

// New or cleared keys in the API box: ask again (a non-200 had switched generation off), for the scene on stage too.
function onKeys() {
  off = false;
  if (lastScene) prepare(lastScene);
}

function onKey(e) {
  const t = e.target || {};
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
  if ((e.key || '').toLowerCase() === 's') toggleMute();
}

export function toggleMute() {
  muted = !muted;
  store.set(MUTE_KEY, muted ? '1' : '0');
  if (muted) for (const el of pool) { try { el.pause(); } catch { /* ignore */ } }
  flash(muted ? 'Sound off (S turns it back on)' : 'Sound on');
  return muted;
}

function element() {
  const i = next++ % POOL;
  return pool[i] || (pool[i] = new Audio());
}

// Resolves true when the sound started; a missing file or a blocked autoplay resolves false, quietly.
export function play(event, obj) {
  if (muted || !EVENTS.includes(event) || typeof Audio !== 'function') return Promise.resolve(false);
  const pick = chooseSound(event, obj, urls, motions);
  return new Promise((done) => {
    try {
      const el = element();
      el.pause(); el.src = pick.src; el.volume = GAIN; el.loop = false;
      Promise.resolve(el.play()).then(() => {
        counts.played++;
        flash(`${event} · ${pick.file} · ElevenLabs`);
        done(true);
      }, (err) => {
        // A generated sound that will not load (gone from Blob) drops back to the palette for good.
        if (pick.generated && err && err.name === 'NotSupportedError') { urls.delete(labelKey(obj.label)); play(event, obj).then(done); } else done(false);
      });
    } catch { done(false); }
  });
}

async function fetchOne({ label, prompt }) {
  if (off || urls.has(label) || typeof fetch !== 'function') return;
  const day = dayStamp(new Date());
  // shortcut: the cap also skips free cache hits once 25 were made today; fine for one kiosk tab.
  if (todayCount(readDay(), day) >= DAY_CAP) return;
  const headers = { 'content-type': 'application/json', ...apiHeaders() };
  if (token) headers['x-host-token'] = token;
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_MS) : undefined;
  const res = await fetch('/api/sfx', { method: 'POST', headers, body: JSON.stringify({ label, prompt }), signal });
  // 204 (SOUND_GEN off), 401, or no API at all (the laptop hub, npm run dev): stop asking for this session.
  if (res.status !== 200) { off = true; return; }
  const j = await res.json();
  if (!j || typeof j.url !== 'string' || !/^https?:\/\//.test(j.url)) return;
  urls.set(label, j.url);
  if (j.cached === true) counts.cached++;
  else { counts.generated++; store.set(DAY_KEY, JSON.stringify({ day, n: todayCount(readDay(), day) + 1 })); }
}

// Serially asks /api/sfx for this scene's first two objects; resolves when they are done (never rejects).
export function prepare(scene) {
  const objs = scene && Array.isArray(scene.objects) ? scene.objects : [];
  lastScene = scene || null;
  motions = new Map(objs.map((o) => [labelKey(o && o.label), o && o.motion]));
  for (const item of prepareList(scene, urls)) chain = chain.then(() => fetchOne(item)).catch(() => {});
  return chain;
}

export const stats = () => ({ ...counts });
