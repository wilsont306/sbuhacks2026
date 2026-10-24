// Host glue: the relay socket, the seats (src/host/slots.js), the player manager, the phones' panel kinds ('original',
// 'artwork', 'inside', and 'look', which is activity only: panel() stamps lastActive for every kind; decided here and
// only here, the host never trusts a phone), the scene's hotspot events (near,
// describe, layer, scene) relayed to phones, audio and margins, the inside phones' world and pos (on change, else every 3 s), the right margin
// (#roster, #hud, #qr, #resting) and the operator keys
// H, J, R, Q. It inits audio.js, margins.js and artwork.js. main.js imports scene.js first, so window.game already exists.
import qrcode from 'qrcode-generator';
import SLOTS from '../shared/slots.json';
import { createSlots } from './slots.js';
import * as audio from './audio.js';
import * as margins from './margins.js';
import * as artwork from './artwork.js';
import * as enrich from './enrich.js';
import * as models from './models3d.js';
import {
  MAX_PLAYERS, HB_MS, INPUT_STALE_MS, ORIGINAL_COOLDOWN_MS, ORIGINAL_MS, ARTWORK_COOLDOWN_MS, CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, hubUrl,
  PLAYER_IDLE_MS, JUDGE_IDLE_MS, JUDGE_RESERVE,
  SLOT_HOLD_MS, ROLLOVER_MS, ROLLOVER_JITTER_MS, ROLL_WAIT_MS, WS_PATH,
} from '../shared/protocol.js';
import './glue.css';

/* pure:start (tests/glue.test.js imports this block on its own, so it must not use imports or page globals) */
// The TV's room key (README Rooms): the stored one when well formed, else `bytes` (16 random) as base64url, 22 characters.
export const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const pickKey = (stored, bytes) => typeof stored === 'string' && KEY_RE.test(stored) ? stored
  : btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The QR's join URL: the relay's joinUrl with ?room= set, or '' while either is missing or malformed.
export function joinWithRoom(url, room) {
  if (typeof url !== 'string' || typeof room !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(room)) return '';
  try { const u = new URL(url); u.searchParams.set('room', room); return u.href; } catch { return ''; }
}

// The seats' store, tagged with the room key: a seat list saved under another key (another room) reads as nothing.
export const roomStore = (store, tag) => store && {
  get: () => { const v = store.get(); return typeof v === 'string' && v.startsWith(tag + '\n') ? v.slice(tag.length + 1) : null; },
  set: (v) => store.set(tag + '\n' + v),
};

// B4: phones quiet longer than `idle` go ('idle'); in judge mode so do phones that were on the bank at J once quiet
// longer than `judgeIdle` ('judge'). Never already-kicked phones, or guests while judge mode is on.
export function idleKicks(players, now, judge, { idle, judgeIdle }) {
  const out = [];
  for (const [pid, p] of players) {
    if (p.kicked || (judge && p.guest)) continue;
    const quiet = now - p.lastActive;
    if (quiet > idle) out.push({ pid, reason: 'idle' });
    else if (judge && p.preJ && quiet > judgeIdle) out.push({ pid, reason: 'judge' });
  }
  return out;
}

// Judge mode: the longest-idle phones go first (away ones before present ones) until `keep` remain.
export function pickKicks(players, keep) {
  const list = [...players].filter(([, p]) => !p.kicked)
    .sort(([, pa], [, pb]) => pb.away - pa.away || pa.lastActive - pb.lastActive);
  return list.slice(0, Math.max(0, list.length - keep)).map(([pid]) => pid);
}

export const originalWait = (last, now, cooldown) => Math.max(0, last + cooldown - now);

// A phone's picture for the TV: 'tour' while the guided tour is on (judges' phones, the guests, are exempt), 'wait'
// within that phone's own cooldown, else 'ok'.
export const artworkGate = (p, now, judge, cooldown) =>
  judge && !p.guest ? 'tour' : originalWait(p.lastArtwork ?? -Infinity, now, cooldown) ? 'wait' : 'ok';

const wifiEsc = (s) => String(s).replace(/[\\;,:"]/g, '\\$&');
export const wifiPayload = ({ ssid, pass }) =>
  pass ? `WIFI:T:WPA;S:${wifiEsc(ssid)};P:${wifiEsc(pass)};;` : `WIFI:T:nopass;S:${wifiEsc(ssid)};;`;

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Integer px per module (6, else 5, else 4) so the modules plus a 4-module quiet zone fit in `max` px.
export const qrScale = (modules, max = 222) =>
  [6, 5, 4].find((px) => (modules + 8) * px <= max) || Math.max(1, Math.floor(max / (modules + 8)));

// The inside view's world: the scene inline with an image the phone can load (http(s) or site-relative; never data:,
// blob: or protocol-relative), and only while its JSON is at most 48000 characters. Else nothing to step into.
const worldImage = (u) => typeof u === 'string' && /^(https?:\/\/|\/(?![/\\]))/i.test(u);
export function worldMsg(scene) {
  const image = scene ? scene.image_url : null;
  return scene && worldImage(image) && JSON.stringify(scene).length <= 48000
    ? { t: 'world', scene, image } : { t: 'world', scene: null, reason: 'This picture can’t be entered yet' };
}

// panel inside: 1 always answers with the world; 2 (a re-assert from a view that already shows one) only when the
// world's JSON differs from the last one sent to that phone; anything else is leaving.
export const worldDue = (value, sentJson, json) => value === 1 || (value === 2 && sentJson !== json);

// A phone's pos goes out when it changed, or as a keepalive (each 'to' across Vercel instances is a Redis PUBLISH).
export const posDue = (prevJson, json, lastAt, now, keepaliveMs) => json !== prevJson || now - lastAt >= keepaliveMs;

// One inside phone's pos: its own figure, the label it stands at, and every other seated figure (`who`: pid ->
// {name, color, near}). null when that phone has no figure or no seat.
export function posMsg(pid, figures, who) {
  const r = (t) => Math.round(t * 1e4) / 1e4, me = figures.find((f) => f.pid === pid), p = who.get(pid);
  if (!me || !p) return null;
  return {
    t: 'pos', me: { t: r(me.t), facing: me.facing }, near: p.near ?? null,
    others: figures.filter((f) => f.pid !== pid && who.has(f.pid))
      .map((f) => ({ pid: f.pid, t: r(f.t), facing: f.facing, color: who.get(f.pid).color, name: who.get(f.pid).name })),
  };
}

// The verb's answer at an object: its label and its description (whitespace collapsed, at most 240 characters),
// or a plain line when the reading has none.
export const NO_DESCRIPTION = 'No description for this one yet.';
export function describeMsg(label, description) {
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  return { t: 'describe', label: typeof label === 'string' ? label : null, text: text || NO_DESCRIPTION };
}
/* pure:end */

const game = window.game;
const query = new URLSearchParams(location.search);
const token = query.get('host') || '';
const primary = hubUrl(location, query.get('hub'));
const FALLBACK = 'ws://localhost' + WS_PATH;
const ROLL = Number(query.get('roll')) || 0; // ?roll=<ms> shortens the socket rollover, for testing it
const els = Object.fromEntries(['roster', 'hud', 'qr', 'resting'].map((id) => [id, document.getElementById(id)]));

const KICK_LIMITS = { idle: PLAYER_IDLE_MS, judgeIdle: JUDGE_IDLE_MS };
const POS_KEEPALIVE_MS = 3000; // an unchanged pos is re-sent this often

// phone pid -> {name, color, joinedAt, lastInput, lastActive, moving, away, rtts, kicked, guest, preJ, near, lastArtwork,
// inside, worldSent (JSON of the last world told to it), lastPos (JSON of the last pos), lastPosAt}
const players = new Map();
let ws = null, open = false, hubSeen = false, closedAt = performance.now(), stopped = '', backoff = 500, retry = 0, rollT = 0, rollWait = 0;
let fallback = false, hub = null, joinUrl = '', judge = false, hudOpen = false, lastOriginal = -Infinity;

// margins and audio only keep each other's references at init, so the order only matters for artwork, which may use both at once.
margins.init({ audioStats: audio.stats, depthStats: enrich.stats, modelStats: models.stats });
audio.init({ token, margins });
models.init({ game, token, margins });
enrich.onScene(models.onScene); // before artwork.init, whose sample 1 is the first scene
artwork.init({ game, token, audio, margins });
enrich.init({ game, token, margins }); // depth (and, through onScene, 3D models) for each scene once it is on stage

const send = (m) => { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
const storage = (key) => { try { const ls = window.localStorage; return { get: () => ls.getItem(key), set: (v) => ls.setItem(key, v) }; } catch { return null; } };
// This TV's room: the relay hashes the key into the room the QR carries, so a reload keeps the room and a new
// browser is a new one. Never shown: whoever holds the key can host the room. No storage: a new room per load.
const keyStore = storage('tt.hostKey');
let hostKey = null;
try { hostKey = keyStore.get(); } catch {}
hostKey = pickKey(hostKey, crypto.getRandomValues(new Uint8Array(16)));
try { keyStore.set(hostKey); } catch {}
// Seats, tokens and the cap live here in the host tab; the relay only routes. Its events land in onHub below.
const seats = createSlots({
  slots: SLOTS, max: MAX_PLAYERS, holdMs: SLOT_HOLD_MS, store: roomStore(storage('tt.seats'), hostKey),
  send: (cid, msg) => send({ t: 'to', cid, msg }),
  close: (cid, code, reason, msg) => send({ t: 'close', cid, code, reason, msg }),
  emit: (m) => onHub(m),
});
const tell = (pid, msg) => pid > 0 && seats.to(pid, msg);
const kick = (pid, reason) => { const p = players.get(pid); if (p) p.kicked = true; seats.kick(pid, reason); };
game.sendTo = (pid, msg) => seats.to(pid, msg);
game.sendAll = (msg) => send({ t: 'all', msg });

// ---- socket ----
// One socket to the relay. Every ROLLOVER_MS the next one opens and takes over before Vercel's max duration closes
// the old (make-before-break): the relay registers the new socket before it closes the old, so nothing is missed.
function connect(roll = false) {
  clearTimeout(retry);
  const base = fallback ? FALLBACK : primary;
  const prev = roll ? ws : null;
  let s;
  try { s = new WebSocket(base + (base.includes('?') ? '&' : '?') + 'role=host&key=' + hostKey); }
  catch { if (prev) scheduleRoll(30000); else later(); return; }
  const onClose = (e) => {
    if (ws !== s || s.retiring) return;
    ws = null; clearTimeout(rollT); lost();
    // A 4000 on a socket whose rollover was abandoned comes from that rollover's own socket, not another tab.
    if (e.code === CLOSE_HOST_REPLACED && !s.rolled) stopped = 'Another host tab took over.';
    else if (e.code === CLOSE_BAD_HOST_TOKEN) stopped = 'The hub refused this screen’s room key.';
    else later();
  };
  if (prev) {
    prev.retiring = true; // the relay closes it with 4000 once s is in: our own replacement, not another tab's
    const abandon = () => {
      clearTimeout(rollWait); s.onopen = s.onmessage = s.onclose = null; try { s.close(); } catch {}
      if (ws !== prev) return;
      prev.retiring = false; prev.rolled = true;
      if (prev.readyState === 1) scheduleRoll(30000); else { ws = null; lost(); later(); }
    };
    rollWait = setTimeout(abandon, ROLL_WAIT_MS);
    s.onclose = abandon;
  } else { ws = s; s.onclose = onClose; }
  s.onopen = () => {
    if (prev) {
      clearTimeout(rollWait);
      if (ws !== prev) { s.onclose = null; s.close(); return; } // switched hubs meanwhile
      // prev still delivers what the relay routed to it before switching (its onmessage accepts a retiring socket)
      // until the relay closes it with 4000; the timer only covers a 4000 that never comes.
      ws = s; s.onclose = onClose; prev.onclose = null;
      setTimeout(() => { try { prev.close(); } catch {} }, ROLL_WAIT_MS);
      return scheduleRoll();
    }
    if (ws !== s) return;
    open = true; backoff = 500;
    // A gap in which messages may have been missed: every seat must answer who (or its hold drops it), and
    // phones without a seat answer here to get the lobby.
    seats.hostOpen(); seats.setCap(MAX_PLAYERS);
    send({ t: 'all', msg: { t: 'who' } });
    scheduleRoll();
  };
  // shortcut: in the few ms two host sockets overlap on different instances, a phone message from a third instance can
  // reach both; every handler is idempotent except the cooldown-guarded artwork and original. Dedupe by id if it bites.
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if ((ws !== s && !s.retiring) || !m || typeof m !== 'object') return;
    try { onRelay(m); } catch (err) { console.warn('glue: relay message dropped', err); }
  };
}
function scheduleRoll(ms) {
  clearTimeout(rollT);
  rollT = setTimeout(() => { if (ws && ws.readyState === 1 && !ws.retiring) connect(true); },
    ms || ROLL || ROLLOVER_MS + Math.random() * ROLLOVER_JITTER_MS);
}
function later() { retry = setTimeout(connect, backoff); backoff = Math.min(8000, backoff * 2); }
function lost() {
  if (open) closedAt = performance.now(); // failed retries must not restart the 2 s resting clock
  open = hubSeen = false;
  for (const [pid, p] of players) {
    game.setInput(pid, 0, 0); // no more input can arrive; never let a figure walk on
    p.away = true; // the roster greys them and J kicks them first if the hub never returns
    p.worldSent = null; // a world written into the dying socket may never have arrived; the post-gap inside 2 resends it
  }
}

// Relay -> host: its own `hub` greeting, sockets opening and closing, and player messages tagged with their cid.
function onRelay(m) {
  const cid = typeof m.cid === 'string' ? m.cid : null;
  switch (m.t) {
    case 'hub': hub = m; hubSeen = true; drawQr(); margins.setHub(m); break;
    case 'open': if (cid) seats.open(cid); break;
    case 'gone': if (cid) seats.gone(cid); break;
    case 'hello': case 'here': case 'in': case 'panel': case 'hbr': if (cid) seats.message(cid, m); break;
  }
}

// Seat events (src/host/slots.js), with the pid stamped.
function onHub(m) {
  const pid = Number.isInteger(m.pid) && m.pid > 0 ? m.pid : null, p = players.get(pid), now = performance.now();
  switch (m.t) {
    case 'join': {
      if (pid == null) return;
      const q = p || { joinedAt: now, lastInput: now, rtts: [], guest: judge };
      // lastActive restarts on every join, so a relay outage (every seat answering who) never idles the whole bank out at once
      Object.assign(q, { name: String(m.name || 'Visitor'), color: String(m.color || ''), away: false, lastActive: now });
      players.set(pid, q);
      game.addPlayer(pid, q.name, q.color);
      if (!p) audio.play('join'); // not for the who answers after a relay gap: six chimes at once
      resync(pid);
      break;
    }
    case 'leave': if (p) leave(pid); break;
    case 'in': if (p) {
      const lx = Math.max(-1, Math.min(1, Math.trunc(m.lx) || 0)), a = m.a ? 1 : 0;
      game.setInput(pid, lx, a);
      p.moving = !!(lx || a);
      if (p.moving) p.lastInput = p.lastActive = now;
    } break;
    // A phone back from away says 'inside' again; what reached it before its socket died is unknown, so forget the world.
    case 'away': if (p) { p.away = true; p.inside = false; p.worldSent = null; } break;
    case 'back':
      if (p) p.away = false;
      resync(pid);
      break;
    case 'panel': if (p) panel(pid, m.kind, m.value); break;
    case 'hbr': if (p && Number.isFinite(m.ts)) {
      const rtt = Math.round(now - m.ts);
      if (rtt >= 0 && rtt < 60000) { p.rtts.push(rtt); if (p.rtts.length > 10) p.rtts.shift(); }
    } break;
  }
}

// ---- players, panels and hotspots ----
// Mode and the label the figure stands at, so the verb button is right again after a reconnect.
function resync(pid) {
  tell(pid, { t: 'mode', mode: 'walk' });
  tell(pid, { t: 'near', label: players.get(pid)?.near ?? null });
}

function leave(pid) {
  game.removePlayer(pid);
  players.delete(pid);
  margins.setNear(pid, null); // its stop goes dark
}

const readout = (pid, text) => tell(pid, { t: 'readout', text });

function panel(pid, kind, value) {
  const p = players.get(pid), now = performance.now();
  p.lastActive = now;
  if (kind === 'inside') {
    // shortcut: no per-phone throttle on the world reply; the relay's 20 messages a second per phone bounds a repeater.
    p.inside = value === 1 || value === 2;
    if (!p.inside) return;
    p.lastPos = null; p.lastPosAt = -Infinity; // the first pos goes out on the next tick
    const msg = worldMsg(game.scene()), json = JSON.stringify(msg);
    if (worldDue(value, p.worldSent, json) && tell(pid, msg)) p.worldSent = json;
    return;
  }
  if (kind === 'original') {
    const wait = originalWait(lastOriginal, now, ORIGINAL_COOLDOWN_MS);
    if (wait) return readout(pid, `Show the original again in ${Math.ceil(wait / 1000)} s`);
    lastOriginal = now;
    game.showOriginal();
    return readout(pid, `Showing the original on the screen for ${ORIGINAL_MS / 1000} s`);
  }
  if (kind !== 'artwork' || typeof value !== 'string') return; // the relay already checked it is a Blob scene URL
  const gate = artworkGate(p, now, judge, ARTWORK_COOLDOWN_MS);
  if (gate === 'tour') return readout(pid, 'Pictures are paused for the guided tour');
  if (gate === 'wait') return readout(pid, `One picture every ${ARTWORK_COOLDOWN_MS / 1000} s`);
  p.lastArtwork = now;
  readout(pid, 'Your picture is on its way to the TV');
  artwork.fromPhone(value, pid).catch(() => false)
    .then((ok) => { if (!ok) readout(pid, "The TV couldn't open that picture; try another"); });
}

game.onHotspot((e) => {
  const label = typeof e?.label === 'string' ? e.label : null;
  if (e?.type === 'near') {
    const p = players.get(e.pid);
    if (p) p.near = label;
    margins.setNear(e.pid, e.object, e.pid === 0 ? 'var(--slot-keyboard)' : p?.color);
    tell(e.pid, { t: 'near', label });
  } else if (e?.type === 'describe') { // the verb at an object (pid 0, the keyboard, has no phone to tell)
    const msg = describeMsg(label, e.description);
    audio.play('describe', { label, kind: e.kind });
    margins.showDescription(msg.label, msg.text, e.index);
    tell(e.pid, msg);
  } else if (e?.type === 'layer') margins.showPlatforms(e.name === 'network');
  else if (e?.type === 'scene' || e?.type === 'enriched') { // enriched: a depth_url or model_url landed on this scene
    const msg = worldMsg(game.scene()), json = JSON.stringify(msg);
    for (const [pid, p] of players) if (p.inside && tell(pid, msg)) p.worldSent = json;
  }
});

// Checked at about 5 Hz: where every figure stands, to each inside phone whose pos changed (else every
// POS_KEEPALIVE_MS). pid 0 is the TV's keyboard figure.
setInterval(() => {
  const inside = [...players].filter(([, p]) => p.inside);
  if (!inside.length || !open) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--slot-keyboard').trim();
  const figures = game.positions(), who = new Map(players).set(0, { name: 'Keyboard', color }), now = performance.now();
  for (const [pid, p] of inside) {
    const m = posMsg(pid, figures, who), json = m && JSON.stringify(m);
    if (m && posDue(p.lastPos, json, p.lastPosAt, now, POS_KEEPALIVE_MS) && tell(pid, m)) { p.lastPos = json; p.lastPosAt = now; }
  }
}, 200);

// ---- operator keys ----
// The cap stays MAX_PLAYERS: a lower cap would also refuse the judge. Phones on the bank now are preJ; later joins are guests.
function setJudge(on) {
  judge = on; game.setJudge(on);
  for (const p of players.values()) Object.assign(p, { guest: false, preJ: on });
  if (on) for (const pid of pickKicks(players, MAX_PLAYERS - JUDGE_RESERVE)) kick(pid, 'judge');
}

function reset() {
  game.reset();
  artwork.loadSample(1);
  audio.play('reset');
  game.sendAll({ t: 'mode', mode: 'reset' });
  setJudge(false);
  lastOriginal = -Infinity;
  for (const p of players.values()) p.lastArtwork = -Infinity;
  seats.setCap(MAX_PLAYERS);
}

// Q: phones do not follow the host to the other relay by themselves; they rescan the new QR (or keep their seat
// if they come back within the hold).
function switchHub() {
  fallback = !fallback; hub = null; stopped = ''; backoff = 500;
  clearTimeout(rollT); clearTimeout(rollWait);
  if (open) lost();
  const old = ws; ws = null; old?.close();
  connect(); drawQr();
}

addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'h') hudOpen = !hudOpen;
  else if (k === 'j') setJudge(!judge);
  else if (k === 'r') reset();
  else if (k === 'q') switchHub();
  else return;
  render();
});

// ---- margins ----
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']; // a Wi-Fi name or password may be non-ASCII

const h = (tag, cls, ...kids) => { const el = document.createElement(tag); if (cls) el.className = cls; el.append(...kids); return el; };
const dot = (color, cls = '') => { const d = h('span', 'dot ' + cls); if (color) d.style.background = color; return d; };
const short = (u) => u.replace(/^\w+:\/\//, '').replace(/\/$/, '');

// A ticket: the code, its caption, and for the join code a stub (what it admits, the address, the data-use small
// print). artwork.js's boarding screen copies the canvas, the caption's first text and .url, so those stay put.
function qrFigure(text, caption, url) {
  const qr = qrcode(0, 'L'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), px = qrScale(n), size = (n + 8) * px;
  const c = document.createElement('canvas'), g = c.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.width = c.height = size; c.style.width = c.style.height = size + 'px';
  c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'QR code');
  g.fillStyle = css.getPropertyValue('--paper').trim(); g.fillRect(0, 0, size, size);
  g.fillStyle = css.getPropertyValue('--ink').trim();
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + 4) * px, (r + 4) * px, px, px);
  const stub = url ? [h('span', 'stub', `Party ticket · up to ${MAX_PLAYERS} phones`, h('span', 'url', url), h('small', 'fine', margins.NOTICE))] : [];
  return h('figure', '', c, h('figcaption', '', caption, ...stub));
}

function drawQr() {
  // A JOIN_URL that carries the host token must never reach the screen. Each hub's greeting brings the room (the
  // same one on Q's laptop hub, since it comes from the key), and every join QR carries it.
  joinUrl = hub && !(token && String(hub.joinUrl).includes(token)) ? joinWithRoom(hub.joinUrl, hub.room) : '';
  const wifi = fallback && hub?.wifi?.ssid ? hub.wifi : null;
  els.qr?.replaceChildren(...(!joinUrl ? [] : wifi
    ? [qrFigure(wifiPayload(wifi), '1  Join the Toy Theatre Wi-Fi'), qrFigure(joinUrl, '2  Scan to board', short(joinUrl))]
    : [qrFigure(joinUrl, 'Scan to board', short(joinUrl))]));
}

const dur = (s) => Number.isFinite(s) ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : '—';

function render() {
  const resting = !!stopped || (!open && performance.now() - closedAt > 2000);
  if (els.qr) els.qr.hidden = resting;
  if (els.resting) {
    els.resting.hidden = !resting;
    els.resting.replaceChildren(h('p', 'rest', 'This exhibit is resting. Please use the keyboard.', ...(stopped ? [h('small', '', stopped)] : [])));
  }

  // On board: a seat per figure, the keyboard's first (artwork.js's boarding screen reads these rows: the dot's colour,
  // the last span's name, .away), then the seats still open.
  const seat = (color, name, away, cls = '') => {
    const li = h('li', `${cls} ${away ? 'away' : ''}`.trim(), dot(color), h('span', '', name, away ? ' (away)' : ''));
    li.style.setProperty('--seat', color);
    return li;
  };
  const free = MAX_PLAYERS - players.size;
  els.roster?.replaceChildren(h('h2', '', 'On board'), h('ul', '',
    seat('var(--slot-keyboard)', 'Keyboard', false, 'kbd'),
    ...[...players.values()].map((p) => seat(p.color, p.name, p.away))),
  ...(resting ? [] : [h('p', 'open', free > 0 ? `${free} ${free === 1 ? 'seat' : 'seats'} open` : 'Every seat taken')])); // resting: no one can board
  document.getElementById('tv')?.classList.toggle('hud-open', hudOpen); // the operator's cards (host.css, margins.css)

  const where = !hub ? '—' : hub.region === 'local' ? 'local' : `vercel ${hub.region}${hub.bus === 'redis' ? '' : ' · no redis'}`;
  const inside = [...players.values()].filter((p) => p.inside).length;
  const hud = [h('div', 'line', dot('', open && hubSeen ? 'ok' : 'bad'), `${where} · players ${players.size}/${MAX_PLAYERS} · inside ${inside}`)];
  if (hudOpen) {
    const s = { uptime: performance.now() / 1000, ...seats.stats() }, st = game.stats() || {}, cur = artwork.current() || {}, dp = enrich.stats();
    hud.push(h('div', 'more', ...[
      `join ${joinUrl || '—'}`,
      `up ${dur(s.uptime)} · joins ${s.joinsTotal ?? '—'} · reconnects ${s.reconnects ?? '—'}`,
      `fps ${Number.isFinite(st.fps) ? Math.round(st.fps) : '—'}`,
      `layer ${st.layer || '—'} · ${cur.saved || '—'}${cur.id ? ' ' + cur.id : ''}`,
      `depth ${dp.state}${dp.device ? ' · ' + dp.device : ''}${dp.ms ? ' · ' + dp.ms + ' ms' : ''}`,
      // One short line per phone: guests are exempt from idle releases, so they show 'guest' in place of the idle clock.
      ...[...players.values()].map((p) => `${p.name.split(' ')[0]} rtt ${p.rtts.length ? Math.round(median(p.rtts)) + 'ms' : '—'} `
        + (judge && p.guest ? 'guest' : `idle ${Math.floor((performance.now() - p.lastActive) / 1000)}s`)),
      `QR ${fallback ? (hub?.wifi?.ssid ? 'hotspot pair' : 'LAN') : 'cloud'} · guided tour ${judge ? 'on' : 'off'} · cap ${MAX_PLAYERS}`,
    ].map((line) => h('div', '', line))));
  }
  els.hud?.replaceChildren(...hud);
}

setInterval(() => send({ t: 'all', msg: { t: 'hb', ts: Math.round(performance.now()) } }), HB_MS);
setInterval(render, 500);
// A phone frozen in the background can leave its socket open without sending the zero; its 4 Hz heartbeat (INPUT_HZ) stops instead.
setInterval(() => {
  const now = performance.now();
  for (const [pid, p] of players) if (p.moving && now - p.lastInput > INPUT_STALE_MS) { p.moving = false; game.setInput(pid, 0, 0); }
}, 250);
setInterval(() => { for (const { pid, reason } of idleKicks(players, performance.now(), judge, KICK_LIMITS)) kick(pid, reason); }, 1000);
connect();
render();
