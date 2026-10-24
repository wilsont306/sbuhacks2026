// Phone controller (v2). The host owns all game state; this page shows one screen per state
// (connecting, lobby, walk, full, evicted, and noroom without a room), sends pad and verb input to the hub, and hands the TV a photographed
// artwork: the phone POSTs it to /api/interpret itself and sends only the returned scene URL.
// No ES2020 syntax (?. ??): iOS 13 Safari must parse this.
import '../shared/tokens.css';
import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/libre-franklin/latin-400.css';
import '@fontsource/libre-franklin/latin-600.css';
import './join.css';
import NoSleep from 'nosleep.js';
import {
  hubUrl, HB_WATCHDOG_MS, INPUT_HZ, MSGS_PER_SEC, CLOSE_EVICTED, CLOSE_REPLACED, CLOSE_NO_ROOM,
  ROLLOVER_MS, ROLLOVER_JITTER_MS, ROLL_WAIT_MS, HOST_SEEN_MS,
} from '../shared/protocol.js';
import { downscale } from '../shared/downscale.js';
import slots from '../shared/slots.json';

/* pure:start (tests/glue.test.js imports this block on its own: no imports, no page globals, no ES2020 syntax) */
// The room this phone plays in and its seat token. The room is only ever the URL's ?room= (the TV's QR; a reload
// keeps it), never a saved one, which may belong to a TV that has gone. A token belongs to the room it was won in,
// so another room starts without one. `saved` is the stored {room, token}.
export function pickSeat(urlRoom, saved) {
  const ok = (r) => typeof r === 'string' && /^[A-Za-z0-9_-]{16}$/.test(r);
  if (!ok(urlRoom)) return { room: null, token: null };
  const s = saved && typeof saved === 'object' && saved.room === urlRoom ? saved : null;
  return { room: urlRoom, token: s && typeof s.token === 'string' && s.token ? s.token : null };
}
/* pure:end */

const $ = (id) => document.getElementById(id);
const body = document.body, pad = $('pad'), verb = $('verb');
const QS = new URLSearchParams(location.search);
const HUB = hubUrl(location, QS.get('hub'));
const ROLL = Number(QS.get('roll')) || 0; // ?roll=<ms> shortens the socket rollover, for testing it
const BACKOFF = [500, 1000, 2000, 4000, 8000];
const IN_GAP = 60; // ms between 'in' messages: ~16/s leaves room under the hub's 20/s for hbr and panel
const DEAD = 0.075; // half of the 15%-wide dead zone at the pad centre, as a fraction of pad width

// The room and token live together in tt.seat; v1's bare tt.token (no room) is never read.
let saved = null;
try { saved = JSON.parse(localStorage.getItem('tt.seat')); } catch (e) {}
const seat = pickSeat(QS.get('room'), saved), ROOM = seat.room;
const WS = ROOM && HUB + (HUB.indexOf('?') < 0 ? '?' : '&') + 'room=' + ROOM; // every socket, rollover included
let tok = seat.token;
function setTok(t) {
  tok = t;
  try { localStorage.setItem('tt.seat', JSON.stringify({ room: ROOM, token: t || null })); } catch (e) {}
}
if (ROOM) setTok(tok); // a new room drops the old room's token

let state = '', ws = null, joined = false, armed = false, helloSent = false, lastHello = null, stopped = false, named = false, mySlot;
let retry = 0, retryT, bannerT = 0, hintT, dogT, fullT, toastT, splashT;
let hostSeen = 0, rollT, rollWaitT; // hostSeen: last message that came from the host tab, not the relay

// ---- screens ----
function show(s) {
  if (s === state) return;
  if (s !== 'walk') { leaveInside(false); zero(); } // the socket is gone or seatless: nothing to tell the host
  state = s;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== s;
  $('origBtn').hidden = s === 'noroom'; // no TV to show it on
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
    b.style.setProperty('--on', onAccent(s.color)); // the card is filled with the colour, so its name needs ink or cream
    b.onclick = () => hello({ t: 'hello', token: null, slot: i });
    list.appendChild(b);
  }
  $('lobbyNone').hidden = list.children.length > 0;
  show('lobby');
}

// label: the object the figure stands at (from the host's {t:'near'}), or null.
function near(label) {
  const on = typeof label === 'string' && label !== '';
  verb.textContent = on ? 'Poke the ' + label.slice(0, 40) : 'Walk to something';
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
  show('walk');
  if (inside) inside.again();
  armRoll();
}

const byeH = $('evicted').querySelector('h1'), BYE_DEFAULT = byeH.textContent;
const BYE = new Map([
  ['idle', 'You were still for a while, so your place in the picture was freed.'],
  ['judge', 'Your place in the picture was freed for a guided tour.'],
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
// 'replaced' (another tab took our token) ends the session, except just after this phone's own abandoned rollover,
// when the host may have moved the seat to the rollover socket: then it is an ordinary drop that reconnects.
function onClosed(w, e) {
  if (ws !== w || w.retiring) return; // a retiring socket's close is our rollover
  lost(w.rolled && Date.now() - w.rolled < 15000 && e.code === CLOSE_REPLACED ? 0 : e.code, e.reason);
}
function connect() {
  clearTimeout(retryT);
  let w;
  try { w = new WebSocket(WS); } catch (e) { return lost(0); }
  ws = w; armed = helloSent = false;
  dogT = setTimeout(() => lost(0), HB_WATCHDOG_MS); // a connect that hangs (captive Wi-Fi) is retried too
  // slot is ignored for a known token; after a hub restart it keeps this phone's colour
  w.onopen = () => { w.openedAt = Date.now(); clearTimeout(dogT); if (tok) hello({ t: 'hello', token: tok, slot: mySlot }); };
  w.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } if (m && typeof m === 'object') onMsg(m); };
  w.onclose = (e) => onClosed(w, e);
}

// Rollover (make-before-break): before Vercel's max duration closes this socket, open the next one and say hello
// with our token. The host gives the seat to the newest socket and closes the old one, so the figure never stops.
// Each socket rolls once, timed from when it opened: a welcome can come again at any time (the host's who).
function armRoll() {
  const w = ws;
  if (!w || w.rollArmed) return;
  w.rollArmed = true;
  const age = Date.now() - (w.openedAt || Date.now());
  scheduleRoll(Math.max(500, (ROLL || ROLLOVER_MS + Math.random() * ROLLOVER_JITTER_MS) - age));
}
function scheduleRoll(ms) { clearTimeout(rollT); rollT = setTimeout(roll, ms); }
function roll() {
  const a = ws;
  if (!joined || !tok || !a || a.readyState !== 1) return; // no seat to keep: an ordinary reconnect is fine
  let b;
  try { b = new WebSocket(WS); } catch (e) { return scheduleRoll(30000); }
  a.retiring = true;
  const abandon = () => {
    clearTimeout(rollWaitT);
    b.onopen = b.onmessage = b.onclose = null; try { b.close(); } catch (e) {}
    a.retiring = false; a.rolled = Date.now();
    if (ws !== a) return;
    if (a.readyState !== 1) return lost(0);
    // The host may already have moved the seat to b: claim it back on a (just a re-welcome if it never moved).
    try { a.send(JSON.stringify({ t: 'hello', token: tok, slot: mySlot })); } catch (e) {}
    scheduleRoll(30000);
  };
  rollWaitT = setTimeout(abandon, ROLL_WAIT_MS);
  b.onclose = abandon;
  b.onopen = () => { b.openedAt = Date.now(); b.send(JSON.stringify({ t: 'hello', token: tok, slot: mySlot })); };
  b.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'evicted') { abandon(); return evicted(false, m.reason); }
    if (m.t !== 'welcome') return; // the lobby and relay hb a fresh socket gets first
    clearTimeout(rollWaitT);
    if (ws !== a) { b.onclose = null; b.close(); return; }
    a.onopen = a.onmessage = a.onclose = null; try { a.close(); } catch (err) {}
    ws = b; armed = true;
    b.onmessage = (ev) => { let mm; try { mm = JSON.parse(ev.data); } catch (err) { return; } if (mm && typeof mm === 'object') onMsg(mm); };
    b.onclose = (ev) => onClosed(b, ev);
    onMsg(m); // same pid and colour; re-arms the watchdog and the next rollover
  };
}

function drop() {
  const w = ws;
  ws = null; joined = false; clearTimeout(dogT); clearTimeout(rollT);
  if (w) { w.onopen = w.onmessage = w.onclose = null; try { w.close(); } catch (e) {} }
}

function lost(code, reason) {
  drop();
  $('resting').hidden = true;
  if (code === CLOSE_EVICTED) return evicted(false, reason);
  if (code === CLOSE_REPLACED) return evicted(true); // another tab of this phone took the token; reconnecting would steal it back forever
  if (code === CLOSE_NO_ROOM) { // the relay refused our room: only a fresh scan helps
    stopped = true; clearTimeout(hintT); clearTimeout(bannerT); bannerT = 0; $('banner').hidden = true;
    return show('noroom');
  }
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
  if (t !== 'hb' || m.ts !== undefined) hostSeen = Date.now(); // the relay's own hb has no ts; everything else is the host

  if (t === 'lobby') { if (!helloSent && state !== 'full') lobby(Array.isArray(m.free) ? m.free : []); }
  else if (t === 'welcome') welcome(m);
  else if (t === 'full') show('full');
  else if (t === 'hb') { if (m.ts !== undefined && joined) send({ t: 'hbr', ts: m.ts }); }
  else if (t === 'evicted') evicted(false, m.reason);
  // The host (re)connected and lost track of sockets: a seat answers with its token, a pending join repeats its
  // hello, anyone else asks for the lobby.
  else if (t === 'who') {
    if (ws && ws.retiring) return; // mid-rollover: the new socket's hello claims the seat (abandon re-claims it here)
    if (joined && tok) hello({ t: 'hello', token: tok, slot: mySlot });
    else if (helloSent && lastHello) hello(lastHello);
    else send({ t: 'here' });
  }
  else if (!joined) return;
  else if (t === 'mode') { show('walk'); if (m.mode === 'reset') near(null); } // 'walk' | 'reset': walk is the only seated screen
  else if (t === 'near') near(m.label);
  else if (t === 'readout') { if (m.text) toast(String(m.text)); }
  else if (t === 'world' || t === 'pos') {
    if (inside) inside.msg(m);
    // pos for a closed view: the host missed our Back, so say it again (at most every 5 s)
    else if (t === 'pos' && Date.now() - outSent >= 5000 && send({ t: 'panel', kind: 'inside', value: 0 })) outSent = Date.now();
  }
}

// ---- input: hold-to-walk pad and verb button ----
let lx = 0, a = 0, padId = null, verbId = null, lastIn = 0, inT;
function setIn(nlx, na) {
  if (nlx === lx && na === a) return;
  if (na && !a) lastIn = 0; // a Poke is a rising edge on the host: never let IN_GAP coalesce a short tap away
  lx = nlx; a = na;
  pad.setAttribute('data-lx', lx);
  verb.classList.toggle('down', !!a);
  if (inside) inside.input(lx, a);
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
  // The original is whatever the TV shows, so without the TV there is nothing to show here.
  toast('The original shows on the screen once it is back');
};
$('again').onclick = start;

// ---- Step inside: the TV's picture as a world seen from this figure (./inside.js, a lazy chunk with three.js) ----
// The host answers {t:'panel', kind:'inside', value:1} with {t:'world'} and then {t:'pos'} whenever it changes (and
// every 3 s); value 2 re-asserts after a welcome and gets the world only if it changed; 'look' is idle-kick activity.
const insideBtn = $('insideBtn'), insideLabel = $('insideLabel'), INSIDE_LABEL = insideLabel.textContent;
let inside = null, outSent = 0; // outSent: the last inside 0 this phone sent
insideBtn.onclick = () => {
  if (inside || insideBtn.disabled) return;
  insideBtn.disabled = true; insideLabel.textContent = 'Opening…';
  import('./inside.js')
    .then((mod) => {
      if (state !== 'walk' || inside) return;
      zero();
      inside = mod.open({
        setLx: (v) => setIn(v, a), setA: (v) => setIn(lx, v), // the pad's own input: same heartbeat, same release rules
        ask: () => send({ t: 'panel', kind: 'inside', value: 1 }),
        reassert: () => send({ t: 'panel', kind: 'inside', value: 2 }),
        look: () => send({ t: 'panel', kind: 'look', value: 1 }),
        back: () => leaveInside(true), toast,
      });
    })
    .catch(() => toast('Couldn’t open the inside view; try again'))
    .then(() => { insideBtn.disabled = false; insideLabel.textContent = INSIDE_LABEL; });
};
function leaveInside(tell) {
  if (!inside) return;
  const v = inside;
  inside = null;
  v.close(); zero();
  if (tell) { if (send({ t: 'panel', kind: 'inside', value: 0 })) outSent = Date.now(); insideBtn.focus(); }
}

// ---- Add artwork: photo -> downscale -> /api/interpret -> the scene URL to the host as {t:'panel', kind:'artwork'} ----
// Only over https: the laptop hub serves no /api/interpret.
const artBtn = $('artBtn'), artFile = $('artFile'), artLabel = $('artLabel'), ART_LABEL = artLabel.textContent; // the label span keeps the camera glyph
const ART_MS = 40000; // the function's 25 s budget plus a slow phone upload; past it the button comes back
const ART_FAIL = 'Couldn’t read that one; try another picture';
const ART_SAY = new Map([
  ['busy', 'One at a time: try again in a few seconds'],
  ['quota', 'The artwork reader is resting; try a sample on the TV'],
]);
if (location.protocol === 'https:') $('art').hidden = false;
function artBusy(on) { artBtn.disabled = on; artLabel.textContent = on ? 'Sending…' : ART_LABEL; }
// The send can miss a beat (rate headroom while the pad is held, a socket switch), so it retries for about 5 s.
function handOff(url, tries) {
  return new Promise((done) => {
    const go = (n) => {
      if (joined && send({ t: 'panel', kind: 'artwork', value: url })) return done('On the TV in a moment');
      if (n <= 0) return done('Couldn’t reach the screen; try again');
      setTimeout(() => go(n - 1), 250);
    };
    go(tries);
  });
}
artBtn.onclick = () => { if (!artBtn.disabled) artFile.click(); };
artFile.onchange = () => {
  const file = artFile.files && artFile.files[0];
  artFile.value = ''; // the same photo can be picked again
  if (!file) return;
  artBusy(true);
  const post = downscale(file)
    .then((img) => fetch('/api/interpret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: img.base64, source: 'phone' }),
    }))
    .then((r) => r.json());
  Promise.race([post, new Promise((ok, no) => setTimeout(no, ART_MS))])
    .then((res) => {
      if (res && res.ok === true && typeof res.scene_url === 'string' && res.scene_url) return handOff(res.scene_url, 20);
      return (res && ART_SAY.get(res.reason)) || ART_FAIL;
    }, () => ART_FAIL)
    .then((text) => { toast(text); artBusy(false); });
};

// "The screen is resting": the relay answers but the host tab has been silent (closed, reloading, or its own link down).
// A phone without a seat waits for the host's lobby; if it never came (the host missed this socket's open), ask.
let lastHere = 0;
setInterval(() => {
  const resting = !!ws && armed && Date.now() - hostSeen > HOST_SEEN_MS;
  if ($('resting').hidden === resting) $('resting').hidden = !resting;
  const now = Date.now();
  if (ws && ws.readyState === 1 && state === 'connecting' && !helloSent && now - (ws.openedAt || now) > 3000 && now - lastHere > 3000) {
    lastHere = now; send({ t: 'here' });
  }
}, 1000);

function start() {
  if (!ROOM) return show('noroom'); // no QR scanned, nothing saved: no socket to open
  stopped = false; retry = 0;
  show('connecting');
  clearTimeout(hintT); hintT = setTimeout(() => { $('hint').hidden = false; }, 4000);
  connect();
}
start();
