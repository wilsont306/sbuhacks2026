// Phone controller (M3, J1-J5). The host owns all game state; this page shows one screen per state
// (connecting, lobby, walk, plaque, full, evicted) and sends pad, verb and panel input to the hub.
// No ES2020 syntax (?. ??): iOS 13 Safari must parse this.
import '../shared/tokens.css';
import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/libre-franklin/latin-400.css';
import '@fontsource/libre-franklin/latin-600.css';
import './join.css';
import NoSleep from 'nosleep.js';
import {
  hubUrl, HB_WATCHDOG_MS, INPUT_HZ, MSGS_PER_SEC, ORIGINAL_MS, CLOSE_EVICTED, CLOSE_REPLACED, MODES, PLAQUES,
  PANEL_HZ, LEVER_MIN, LEVER_MAX, SPAN_MIN, SPAN_MAX, RISE_MIN, RISE_MAX_PHONE,
} from '../shared/protocol.js';
import slots from '../shared/slots.json';
import cards from '../shared/cards.json';

const $ = (id) => document.getElementById(id);
const body = document.body, pad = $('pad'), verb = $('verb');
const HUB = hubUrl(location, new URLSearchParams(location.search).get('hub'));
const BACKOFF = [500, 1000, 2000, 4000, 8000];
const IN_GAP = 60; // ms between 'in' messages: ~16/s leaves room under the hub's 20/s for hbr and panel
const DEAD = 0.075; // half of the 15%-wide dead zone at the pad centre, as a fraction of pad width

let tok = null;
try { tok = localStorage.getItem('tt.token'); } catch (e) {}
function setTok(t) {
  tok = t;
  try { if (t) localStorage.setItem('tt.token', t); else localStorage.removeItem('tt.token'); } catch (e) {}
}

let state = '', ws = null, joined = false, armed = false, helloSent = false, lastHello = null, stopped = false, named = false, mySlot;
let retry = 0, retryT, bannerT = 0, hintT, dogT, fullT, toastT, splashT, origT, open = null;

// ---- screens ----
function show(s) {
  if (s === state) return;
  if (s !== 'walk') zero();
  if (s !== 'plaque') { open = null; dirty.length = 0; clearTimeout(panelT); }
  state = s;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== s;
  clearInterval(fullT);
  if (s === 'full') fullT = setInterval(() => hello(lastHello), 3000);
}

function lobby(free) {
  const list = $('swatches');
  list.textContent = '';
  for (const i of free) {
    const s = slots[i];
    if (!s) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.textContent = s.name;
    b.style.setProperty('--c', s.color);
    b.onclick = () => hello({ t: 'hello', token: null, slot: i });
    list.appendChild(b);
  }
  $('lobbyNone').hidden = list.children.length > 0;
  show('lobby');
}

function plaque(k) {
  if (state === 'plaque' && open === k) return; // a re-sent mode (grant, back, replayed join) keeps the panel; its mirror follows
  const c = cards[k], sec = $('plaque');
  $('pFig').textContent = c.fig; $('pTitle').textContent = c.title; $('pHead').textContent = c.headline;
  $('pBody').textContent = c.body; $('pSource').textContent = c.source; $('pClosing').textContent = c.closing;
  show('plaque');
  open = k; dirty.length = 0; clearTimeout(panelT);
  // Disabled until the first mirror sets them, so the phone never sends its own defaults.
  for (const s of SL) if (s.p === k) { s.el.blur(); s.el.disabled = true; s.ptr = null; s.touch = false; put(s.out, '–'); }
  $('ctlLoco').hidden = k !== 'loco'; $('ctlBridge').hidden = k !== 'bridge';
  put($('rpm'), '–'); put($('verdict'), ''); put($('push'), '');
  sec.scrollTop = sec.querySelector('article').scrollTop = 0;
}

// ---- plaque panels (J3): sliders follow the host's mirror readouts; the host checks ownership and clamps ----
const put = (el, text) => { if (el.textContent !== text) el.textContent = text; }; // in place: live regions announce real changes only
const ftin = (f) => { const i = Math.round(f * 12); return Math.floor(i / 12) + ' ft ' + (i % 12) + ' in'; };
const SETTLE = 500; // ms after a release while mirrors of values sent mid-drag may still arrive
const SL = [
  ['lever', 'loco', 'mph', LEVER_MIN, LEVER_MAX, (v) => v + ' mph'],
  ['span', 'bridge', 'span', SPAN_MIN, SPAN_MAX, (v) => v + ' ft'],
  ['rise', 'bridge', 'rise', RISE_MIN, RISE_MAX_PHONE, ftin],
].map(([kind, p, f, min, max, fmt]) => {
  const el = $(kind), s = { kind, p, f, fmt, el, out: $(kind + 'V'), ptr: null, touch: false, settle: 0, sent: null };
  el.min = min; el.max = max;
  const moved = () => { const t = fmt(+el.value); el.setAttribute('aria-valuetext', t); put(s.out, t); mark(s); };
  el.addEventListener('input', moved);
  el.addEventListener('change', moved);
  el.addEventListener('pointerdown', (e) => { s.ptr = e.pointerId; live(); });
  for (const ev of ['touchstart', 'touchend', 'touchcancel']) el.addEventListener(ev, (e) => {
    s.touch = e.targetTouches.length > 0;
    if (!s.touch) s.settle = Date.now() + SETTLE;
    live();
  }, { passive: true });
  el.addEventListener('blur', () => { s.settle = Date.now() + SETTLE; });
  return s;
});
// A mouse may be released outside the slider, so pointer ends are caught on the document.
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, (e) => {
  for (const s of SL) if (s.ptr === e.pointerId) { s.ptr = null; s.settle = Date.now() + SETTLE; }
  live();
}, true);
const held = (s) => s.ptr !== null || s.touch || document.activeElement === s.el || dirty.indexOf(s) >= 0 || Date.now() < s.settle;
// Readouts stay quiet while a finger drags; the mirror of the released value is announced once.
function live() {
  const busy = SL.some((s) => s.ptr !== null || s.touch);
  for (const r of document.querySelectorAll('.ro')) r.setAttribute('aria-live', busy ? 'off' : 'polite');
}

// Latest values, at most PANEL_HZ messages a second across all sliders; the final value always goes, at most one gap late.
const dirty = []; // sliders whose latest value is unsent, oldest first
let lastPanel = 0, panelT;
function mark(s) { if (dirty.indexOf(s) < 0) dirty.push(s); pushPanel(); }
function pushPanel() {
  clearTimeout(panelT);
  while (dirty.length && +dirty[0].el.value === dirty[0].sent) dirty.shift();
  if (!dirty.length) return;
  const wait = lastPanel + 1000 / PANEL_HZ - Date.now();
  if (wait > 0) { panelT = setTimeout(pushPanel, wait); return; }
  const s = dirty[0], v = +s.el.value;
  if (!joined || !send({ t: 'panel', kind: s.kind, value: v })) { panelT = setTimeout(pushPanel, 100); return; }
  dirty.shift(); s.sent = v; lastPanel = Date.now();
  if (dirty.length) panelT = setTimeout(pushPanel, 1000 / PANEL_HZ);
}

function mirror(m) {
  if (state !== 'plaque' || m.plaque !== open) return;
  for (const s of SL) {
    const v = m[s.f];
    if (s.p !== open || !Number.isFinite(v)) continue;
    if (s.el.disabled || !held(s)) {
      s.el.value = v; s.sent = v; // the host's value, not the thumb's: a thumb clamped below a kiosk rise of 64 still sends 48
      s.el.setAttribute('aria-valuetext', s.fmt(v)); put(s.out, s.fmt(v));
    }
    s.el.disabled = false;
  }
  if (open === 'loco' && Number.isFinite(m.rpm)) put($('rpm'), String(Math.round(m.rpm)));
  if (open === 'bridge' && typeof m.stands === 'boolean' && Number.isFinite(m.marginMm)) {
    const at = m.where ? ' at the ' + m.where : '', v = $('verdict');
    put(v, m.stands ? 'Stands · ' + m.marginMm + ' mm inside the ring' + at : 'Fails · leaves the ring by ' + (-m.marginMm) + ' mm' + at);
    v.className = m.stands ? 'ok' : 'bad';
    put($('push'), Number.isFinite(m.push) ? 'Abutment push ' + m.push.toFixed(2) + '× the half-arch weight' : '');
  }
}

function near(p) {
  const on = PLAQUES.indexOf(p) >= 0;
  verb.textContent = on ? 'Look at ' + cards[p].fig : 'Walk to a plaque';
  verb.setAttribute('aria-disabled', on ? 'false' : 'true');
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  clearTimeout(toastT); toastT = setTimeout(() => { t.textContent = ''; }, 4000);
}

// Text on an accent fill: ink on light accents, cream on dark (equal contrast at relative luminance 0.18).
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const onAccent = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.18 ? 'var(--ink)' : 'var(--cream)';
};

function welcome(m) {
  const fresh = !named || tok !== m.token;
  joined = named = true; mySlot = m.slot;
  setTok(m.token);
  body.style.setProperty('--accent', m.color);
  body.style.setProperty('--on-accent', onAccent(String(m.color)));
  body.classList.add('joined');
  $('me').textContent = m.name;
  if (fresh) {
    near(null);
    $('splashName').textContent = m.name; $('splash').hidden = false;
    clearTimeout(splashT); splashT = setTimeout(() => { $('splash').hidden = true; }, 3000);
  }
  show(state === 'plaque' ? 'plaque' : 'walk'); // the host re-sends mode if it disagrees
}

const byeH = $('evicted').firstElementChild, BYE_DEFAULT = byeH.textContent;
const BYE = new Map([
  ['idle', 'You were still for a while, so your place on the bank was freed.'],
  ['judge', 'Your place on the bank was freed for a guided tour.'],
  ['timeout', 'Your phone was away too long.'],
]);
function evicted(keepToken, reason) {
  drop();
  stopped = true; named = false; if (!keepToken) setTok(null);
  clearTimeout(retryT); clearTimeout(bannerT); bannerT = 0;
  $('banner').hidden = $('resting').hidden = $('splash').hidden = true;
  body.classList.remove('joined'); $('me').textContent = '';
  byeH.textContent = BYE.get(reason) || BYE_DEFAULT;
  show('evicted');
}

// ---- socket ----
function connect() {
  clearTimeout(retryT);
  let w;
  try { w = new WebSocket(HUB); } catch (e) { return lost(0); }
  ws = w; armed = helloSent = false;
  dogT = setTimeout(() => lost(0), HB_WATCHDOG_MS); // a connect that hangs (captive Wi-Fi) is retried too
  // slot is ignored for a known token; after a hub restart it keeps this phone's colour
  w.onopen = () => { clearTimeout(dogT); if (tok) hello({ t: 'hello', token: tok, slot: mySlot }); };
  w.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } if (m && typeof m === 'object') onMsg(m); };
  w.onclose = (e) => { if (ws === w) lost(e.code, e.reason); };
}

function drop() {
  const w = ws;
  ws = null; joined = false; clearTimeout(dogT);
  if (w) { w.onopen = w.onmessage = w.onclose = null; try { w.close(); } catch (e) {} }
}

function lost(code, reason) {
  drop();
  $('resting').hidden = true;
  if (code === CLOSE_EVICTED) return evicted(false, reason);
  if (code === CLOSE_REPLACED) return evicted(true); // another tab of this phone took the token; reconnecting would steal it back forever
  if (stopped) return;
  if (state !== 'connecting' && !bannerT) bannerT = setTimeout(() => { $('banner').hidden = false; }, 1000);
  clearTimeout(retryT);
  retryT = setTimeout(connect, BACKOFF[Math.min(retry++, BACKOFF.length - 1)]);
}

const sent = []; // send times in the last second; the hub silently drops a player's 21st message in a second
function send(m) {
  if (!ws || ws.readyState !== 1) return false;
  const now = Date.now();
  while (sent.length && now - sent[0] >= 1000) sent.shift();
  if (sent.length >= MSGS_PER_SEC - 2) return false; // headroom for network jitter bunching messages
  sent.push(now);
  ws.send(JSON.stringify(m));
  return true;
}

function hello(m) { lastHello = m; helloSent = true; send(m); }

function onMsg(m) {
  const t = m.t;
  // Arm the watchdog only once this socket has shown it gets heartbeats, so a quiet lobby is never dropped.
  if (t === 'hb' || t === 'welcome') armed = true;
  if (armed) { clearTimeout(dogT); dogT = setTimeout(() => lost(0), HB_WATCHDOG_MS); }
  retry = 0;
  clearTimeout(bannerT); bannerT = 0; $('banner').hidden = true;
  clearTimeout(hintT); $('hint').hidden = true;

  if (t === 'lobby') { if (!helloSent && state !== 'full') lobby(Array.isArray(m.free) ? m.free : []); }
  else if (t === 'welcome') welcome(m);
  else if (t === 'full') show('full');
  else if (t === 'hb') {
    if (m.ts !== undefined) send({ t: 'hbr', ts: m.ts });
    if (typeof m.host === 'boolean') $('resting').hidden = m.host;
  }
  else if (t === 'evicted') evicted(false, m.reason);
  else if (!joined) return;
  else if (t === 'mode') {
    if (PLAQUES.indexOf(m.mode) >= 0) plaque(m.mode);
    else if (MODES.indexOf(m.mode) >= 0) show('walk');
    if (m.mode === 'reset') near(null);
  }
  else if (t === 'near') near(m.plaque);
  else if (t === 'readout') { if (m.plaque) mirror(m); else if (m.text) toast(String(m.text)); } // mirrors are never toasted
}

// ---- input: hold-to-walk pad and verb button ----
let lx = 0, a = 0, padId = null, verbId = null, lastIn = 0, inT;
function setIn(nlx, na) {
  if (nlx === lx && na === a) return;
  if (na && !a) lastIn = 0; // a Look is a rising edge on the host: never let IN_GAP coalesce a short tap away
  lx = nlx; a = na;
  pad.setAttribute('data-lx', lx);
  verb.classList.toggle('down', !!a);
  pushIn();
}
function pushIn() {
  clearTimeout(inT);
  if (!joined) return; // the hub zeroes the figure itself when the socket closes
  const wait = lastIn + IN_GAP - Date.now();
  if (wait > 0) { inT = setTimeout(pushIn, wait); return; }
  if (send({ t: 'in', lx, a })) lastIn = Date.now(); else inT = setTimeout(pushIn, 100);
}
setInterval(() => { if (lx || a) pushIn(); }, 1000 / INPUT_HZ);
function zero() { padId = verbId = null; setIn(0, 0); }

function padMove(e) {
  const r = pad.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2;
  setIn(Math.abs(dx) < r.width * DEAD ? 0 : dx < 0 ? -1 : 1, a);
}
pad.addEventListener('pointerdown', (e) => {
  if (padId !== null || e.button !== 0) return; // not isPrimary: a thumb may already be on the verb
  e.preventDefault();
  try { pad.setPointerCapture(e.pointerId); } catch (err) {}
  padId = e.pointerId; padMove(e);
});
pad.addEventListener('pointermove', (e) => { if (e.pointerId === padId) padMove(e); });
verb.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // not isPrimary: the other thumb may already be holding the pad
  e.preventDefault();
  try { verb.setPointerCapture(e.pointerId); } catch (err) {}
  verbId = e.pointerId; setIn(lx, 1);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  pad.addEventListener(ev, (e) => { if (e.pointerId === padId) { padId = null; setIn(0, a); } });
  verb.addEventListener(ev, (e) => { if (e.pointerId === verbId) { verbId = null; setIn(lx, 0); } });
}
const isPress = (e) => e.key === ' ' || e.key === 'Enter';
verb.addEventListener('keydown', (e) => { if (isPress(e)) { e.preventDefault(); if (!e.repeat) setIn(lx, 1); } });
verb.addEventListener('keyup', (e) => { if (isPress(e)) setIn(lx, 0); });

addEventListener('blur', zero);
addEventListener('pagehide', zero);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- wake lock: native on a secure context, else NoSleep's looping video, both started inside a gesture ----
const native = 'wakeLock' in navigator && window.isSecureContext;
let ns = null, woke = false;
if (!native) try { ns = new NoSleep(); } catch (e) {}
function wake() {
  if (woke) return;
  woke = true;
  const fail = () => { woke = false; };
  try { (native ? navigator.wakeLock.request('screen') : ns ? ns.enable() : Promise.resolve()).catch(fail); } catch (e) { fail(); }
}
for (const ev of ['touchend', 'pointerup', 'click']) document.addEventListener(ev, wake, true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { zero(); woke = false; } // both locks lapse while hidden
  else if (native) wake();
});

// ---- buttons ----
$('origBtn').onclick = () => {
  if (joined && $('resting').hidden) { send({ t: 'panel', kind: 'original', value: 1 }); return; } // the host replies with a readout
  // not connected, or no host: show it here
  const o = $('orig'), img = o.firstElementChild;
  if (!img.getAttribute('src')) img.src = 'assets/turner-1920.jpg'; // about 700 KB, so fetched only here
  o.hidden = false;
  clearTimeout(origT); origT = setTimeout(() => { o.hidden = true; }, ORIGINAL_MS);
};
$('orig').onclick = () => { clearTimeout(origT); $('orig').hidden = true; };
$('done').onclick = () => { send({ t: 'panel', kind: 'done', value: 1 }); show('walk'); };
$('export').onclick = () => send({ t: 'panel', kind: 'export', value: 1 }); // the host answers with a toasted readout
$('again').onclick = start;

function start() {
  stopped = false; retry = 0;
  show('connecting');
  clearTimeout(hintT); hintT = setTimeout(() => { $('hint').hidden = false; }, 4000);
  connect();
}
start();
