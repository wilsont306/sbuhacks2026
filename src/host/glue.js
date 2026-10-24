// Host glue: the hub socket, the player manager, plaque ownership (decided here and only here; the host
// never trusts a phone), the margins (#roster, #hud, #qr, #resting) and the operator keys H, J, R, Q.
// main.js imports scene.js first, so window.game already exists.
import qrcode from 'qrcode-generator';
import cards from '../shared/cards.json';
import {
  MAX_PLAYERS, HB_MS, INPUT_STALE_MS, AWAY_RELEASE_MS, ORIGINAL_COOLDOWN_MS, ORIGINAL_MS, PLAQUES, CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, hubUrl,
  LEVER_MIN, LEVER_MAX, SPAN_MIN, SPAN_MAX, RISE_MIN, RISE_MAX_PHONE, EXPORT_COOLDOWN_MS,
  OWNER_IDLE_MS, OWNER_CAP_MS, OWNER_CAP_JUDGE_MS, PLAYER_IDLE_MS, JUDGE_IDLE_MS, JUDGE_RESERVE,
} from '../shared/protocol.js';
import './glue.css';

/* pure:start (tests/glue.test.js imports this block on its own, so it must not use imports or globals) */
export const ownedBy = (owners, pid) => { for (const [plaque, p] of owners) if (p === pid) return plaque; return null; };

// Free or already this pid's: grant, dropping any other plaque the pid holds. Otherwise name the owner.
export function decideLook(owners, plaque, pid) {
  const cur = owners.get(plaque);
  if (cur != null && cur !== pid) return { busy: cur };
  const prev = ownedBy(owners, pid);
  return { drop: prev !== plaque ? prev : null };
}

const PANEL_PLAQUE = new Map([['lever', 'loco'], ['span', 'bridge'], ['rise', 'bridge'], ['export', 'bridge']]);
export const mayPanel = (owners, pid, kind) => PANEL_PLAQUE.has(kind) && owners.get(PANEL_PLAQUE.get(kind)) === pid;

// A slider value clamped to `ranges` (Map kind -> [min, max]); null when the kind is not a slider or the value not a number.
export function panelValue(kind, v, ranges) {
  const r = ranges.get(kind);
  return r && Number.isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : null;
}

// A phone owner's plaque: 'idle' after `idle` ms without a panel input (never in judge mode), 'cap' after holding it
// `cap` ms (`capJudge` in judge mode), else null.
export function ownerExpiry({ since, lastPanel }, now, judge, { idle, cap, capJudge }) {
  if (!judge && now - lastPanel >= idle) return 'idle';
  return now - since >= (judge ? capJudge : cap) ? 'cap' : null;
}

// B4: phones quiet longer than `idle` go ('idle'); in judge mode so do phones that were on the bank at J once quiet
// longer than `judgeIdle` ('judge'). Never plaque owners, already-kicked phones, or guests while judge mode is on.
export function idleKicks(players, owners, now, judge, { idle, judgeIdle }) {
  const owning = new Set(owners.values()), out = [];
  for (const [pid, p] of players) {
    if (p.kicked || owning.has(pid) || (judge && p.guest)) continue;
    const quiet = now - p.lastActive;
    if (quiet > idle) out.push({ pid, reason: 'idle' });
    else if (judge && p.preJ && quiet > judgeIdle) out.push({ pid, reason: 'judge' });
  }
  return out;
}

// Judge mode: the longest-idle phones go first (away ones before present ones, plaque owners last) until `keep` remain.
export function pickKicks(players, owners, keep) {
  const owning = new Set(owners.values());
  const list = [...players].filter(([, p]) => !p.kicked)
    .sort(([a, pa], [b, pb]) => owning.has(a) - owning.has(b) || pb.away - pa.away || pa.lastActive - pb.lastActive);
  return list.slice(0, Math.max(0, list.length - keep)).map(([pid]) => pid);
}

export const originalWait = (last, now, cooldown) => Math.max(0, last + cooldown - now);

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
/* pure:end */

const game = window.game;
const query = new URLSearchParams(location.search);
const token = query.get('host') || '';
const primary = hubUrl(location, query.get('hub'));
const FALLBACK = 'ws://localhost/ws';
const els = Object.fromEntries(['roster', 'hud', 'qr', 'resting'].map((id) => [id, document.getElementById(id)]));

const OWNER_LIMITS = { idle: OWNER_IDLE_MS, cap: OWNER_CAP_MS, capJudge: OWNER_CAP_JUDGE_MS };
const KICK_LIMITS = { idle: PLAYER_IDLE_MS, judgeIdle: JUDGE_IDLE_MS };
const PANEL_RANGE = new Map([['lever', [LEVER_MIN, LEVER_MAX]], ['span', [SPAN_MIN, SPAN_MAX]], ['rise', [RISE_MIN, RISE_MAX_PHONE]]]);

// phone pid -> {name, color, joinedAt, lastInput, lastActive, moving, away, awayTimer, rtts, stale, kicked,
//               guest, preJ, since, lastPanel, note}; since/lastPanel only while it owns a plaque
const players = new Map();
const owners = new Map();  // plaque -> pid (0 is the keyboard)
let ws = null, open = false, hubSeen = false, closedAt = performance.now(), stopped = '', backoff = 500, retry = 0, replay = 0;
let fallback = false, hub = null, boot, joinUrl = '', stats = null, judge = false, hudOpen = false, lastOriginal = -Infinity, lastExport = -Infinity;

const send = (m) => { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
const tell = (pid, msg) => pid > 0 && send({ t: 'to', pid, msg });
const kick = (pid, reason) => { if (send({ t: 'kick', pid, reason })) players.get(pid).kicked = true; };
game.sendTo = (pid, msg) => send({ t: 'to', pid, msg });
game.sendAll = (msg) => send({ t: 'all', msg });

// ---- socket ----
function connect() {
  clearTimeout(retry);
  const base = fallback ? FALLBACK : primary;
  let s;
  try { s = new WebSocket(base + (base.includes('?') ? '&' : '?') + 'role=host&host=' + encodeURIComponent(token)); }
  catch { return later(); }
  ws = s;
  s.onopen = () => {
    if (ws !== s) return;
    open = true; backoff = 500;
    send({ t: 'cap', max: MAX_PLAYERS });
    // The hub replays a join for every connected phone; anyone not re-announced within 2 s is gone.
    for (const p of players.values()) p.stale = true;
    clearTimeout(replay);
    replay = setTimeout(() => { for (const [pid, p] of players) if (p.stale) leave(pid); }, 2000);
  };
  s.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (ws !== s || !m || typeof m !== 'object') return;
    try { onHub(m); } catch (err) { console.warn('glue: hub message dropped', err); }
  };
  s.onclose = (e) => {
    if (ws !== s) return;
    ws = null; lost();
    if (e.code === CLOSE_HOST_REPLACED) stopped = 'Another host tab took over.';
    else if (e.code === CLOSE_BAD_HOST_TOKEN) stopped = 'The hub refused the host token.';
    else later();
  };
}
function later() { retry = setTimeout(connect, backoff); backoff = Math.min(8000, backoff * 2); }
function lost() {
  if (open) closedAt = performance.now(); // failed retries must not restart the 2 s resting clock
  open = hubSeen = false;
  for (const [pid, p] of players) {
    game.setInput(pid, 0, 0); // no more input can arrive; never let a figure walk on
    if (!p.away) markAway(pid, p); // nor away or leave: plaques must still free up if the hub never returns
  }
}

function onHub(m) {
  const pid = Number.isInteger(m.pid) && m.pid > 0 ? m.pid : null, p = players.get(pid), now = performance.now();
  switch (m.t) {
    case 'hub':
      // A new hub process (restart, or Q) hands out pids from 1 again: its replayed joins are new players.
      if (m.boot !== boot) { for (const old of players.keys()) leave(old); boot = m.boot; }
      hub = m; hubSeen = true; drawQr(); break;
    case 'stats': stats = m; break;
    case 'join': {
      if (pid == null) return;
      const q = p || { joinedAt: now, lastInput: now, rtts: [], guest: judge };
      clearTimeout(q.awayTimer);
      // lastActive restarts on every join, so a hub outage (replayed joins) never idles the whole bank out at once
      Object.assign(q, { name: String(m.name || 'Visitor'), color: String(m.color || ''), away: false, stale: false, lastActive: now });
      players.set(pid, q);
      game.addPlayer(pid, q.name, q.color);
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
    case 'away': if (p) markAway(pid, p); break;
    case 'back':
      if (p) { clearTimeout(p.awayTimer); p.away = false; }
      resync(pid);
      break;
    case 'panel': if (p) panel(pid, m.kind, m.value); break;
    case 'hbr': if (p && Number.isFinite(m.ts)) {
      const rtt = Math.round(now - m.ts);
      if (rtt >= 0 && rtt < 60000) { p.rtts.push(rtt); if (p.rtts.length > 10) p.rtts.shift(); }
    } break;
  }
}

// ---- players and plaques ----
function markAway(pid, p) {
  p.away = true; clearTimeout(p.awayTimer);
  p.awayTimer = setTimeout(() => release(ownedBy(owners, pid), 'away'), AWAY_RELEASE_MS);
}

// Mode, the owned plaque's mirror (so the phone's sliders start at the TV's values), and any release note it missed while away.
function resync(pid) {
  const pl = ownedBy(owners, pid), p = players.get(pid);
  tell(pid, { t: 'mode', mode: pl || 'walk' });
  if (pl) tell(pid, { t: 'readout', ...game.readout(pl) });
  if (p?.note) { tell(pid, { t: 'readout', text: p.note }); p.note = null; }
}

function leave(pid) {
  const p = players.get(pid);
  release(ownedBy(owners, pid));
  clearTimeout(p.awayTimer);
  game.removePlayer(pid);
  players.delete(pid);
}

const closedWhy = (why) => why === 'idle' ? ` after ${OWNER_IDLE_MS / 1000} s without a touch`
  : why === 'cap' ? ` after ${(judge ? OWNER_CAP_JUDGE_MS : OWNER_CAP_MS) / 1000} s` : ': the connection dropped';

// `why` ('idle' | 'cap' | 'away') adds a one-off readout; an away phone gets it on its next join or back (the hub drops messages to an away socket).
function release(plaque, why) {
  const pid = owners.get(plaque);
  if (pid == null) return;
  owners.delete(plaque);
  game.setOwner(plaque, null); game.freeze(pid, false);
  tell(pid, { t: 'mode', mode: 'walk' });
  const p = players.get(pid);
  if (!why || !p) return;
  const text = `${cards[plaque].fig} ${cards[plaque].title} closed${closedWhy(why)}`;
  if (p.away) p.note = text; else tell(pid, { t: 'readout', text });
}

function look(pid, plaque) {
  if (pid !== 0 && !players.has(pid)) return;
  const d = decideLook(owners, plaque, pid);
  if ('busy' in d) {
    const c = cards[plaque], who = d.busy === 0 ? 'the keyboard' : players.get(d.busy)?.name || 'another visitor';
    return tell(pid, { t: 'readout', text: `${c.fig} ${c.title} is in use by ${who}` });
  }
  if (d.drop) { owners.delete(d.drop); game.setOwner(d.drop, null); }
  owners.set(plaque, pid);
  if (pid > 0) { const now = performance.now(); Object.assign(players.get(pid), { since: now, lastPanel: now }); }
  game.setInput(pid, 0, 0); game.freeze(pid, true); game.setOwner(plaque, pid);
  resync(pid);
}

function panel(pid, kind, value) {
  const p = players.get(pid), now = performance.now();
  p.lastActive = now;
  if (kind === 'done') {
    const pl = ownedBy(owners, pid);
    return pl ? release(pl) : tell(pid, { t: 'mode', mode: 'walk' }); // re-sync a phone that thinks it holds a panel
  }
  if (kind === 'original') {
    const wait = originalWait(lastOriginal, now, ORIGINAL_COOLDOWN_MS);
    if (wait) return tell(pid, { t: 'readout', text: `Show the original again in ${Math.ceil(wait / 1000)} s` });
    lastOriginal = now;
    game.showOriginal();
    return tell(pid, { t: 'readout', text: `Showing the original on the screen for ${ORIGINAL_MS / 1000} s` });
  }
  if (!mayPanel(owners, pid, kind)) return;
  if (kind === 'export') {
    p.lastPanel = now; // a tap during the cooldown still shows the owner is there
    const wait = originalWait(lastExport, now, EXPORT_COOLDOWN_MS);
    if (wait) return tell(pid, { t: 'readout', text: `Export again in ${Math.ceil(wait / 1000)} s` });
    const r = game.exportArch();
    lastExport = now;
    return tell(pid, { t: 'readout', text: r.text });
  }
  const v = panelValue(kind, value, PANEL_RANGE);
  if (v == null) return;
  p.lastPanel = now;
  tell(pid, { t: 'readout', ...game.setPanel(pid, kind, v) });
}

game.onHotspot((e) => {
  const plaque = PLAQUES.includes(e?.plaque) ? e.plaque : null;
  if (e?.type === 'near') tell(e.pid, { t: 'near', plaque });
  else if (!plaque) return;
  else if (e.type === 'look') look(e.pid, plaque);
  else if (e.type === 'done') release(plaque); // Esc or the TV close button: the kiosk may close any panel
  else if (e.type === 'walkoff' && owners.get(plaque) === e.pid) release(plaque);
});

// ---- operator keys ----
// The cap stays MAX_PLAYERS: a lower cap would also refuse the judge. Phones on the bank now are preJ; later joins are guests.
function setJudge(on) {
  judge = on; game.setJudge(on);
  for (const p of players.values()) Object.assign(p, { guest: false, preJ: on });
  if (on) for (const pid of pickKicks(players, owners, MAX_PLAYERS - JUDGE_RESERVE)) kick(pid, 'judge');
}

function reset() {
  for (const plaque of [...owners.keys()]) release(plaque);
  game.reset();
  game.sendAll({ t: 'mode', mode: 'reset' });
  setJudge(false);
  lastOriginal = lastExport = -Infinity;
  send({ t: 'cap', max: MAX_PLAYERS });
}

function switchHub() {
  fallback = !fallback; hub = null; stopped = ''; backoff = 500;
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

function qrFigure(text, caption, url) {
  const qr = qrcode(0, 'L'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), px = qrScale(n), size = (n + 8) * px;
  const c = document.createElement('canvas'), g = c.getContext('2d'), css = getComputedStyle(document.documentElement);
  c.width = c.height = size; c.style.width = c.style.height = size + 'px';
  c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'QR code');
  g.fillStyle = css.getPropertyValue('--paper').trim(); g.fillRect(0, 0, size, size);
  g.fillStyle = css.getPropertyValue('--ink').trim();
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + 4) * px, (r + 4) * px, px, px);
  return h('figure', '', c, h('figcaption', '', caption, ...(url ? [h('span', 'url', url)] : [])));
}

function drawQr() {
  // A JOIN_URL that carries the host token must never reach the screen.
  joinUrl = typeof hub?.joinUrl === 'string' && !(token && hub.joinUrl.includes(token)) ? hub.joinUrl : '';
  const wifi = fallback && hub?.wifi?.ssid ? hub.wifi : null;
  els.qr?.replaceChildren(...(!joinUrl ? [] : wifi
    ? [qrFigure(wifiPayload(wifi), '1  Join the Toy Theatre Wi-Fi'), qrFigure(joinUrl, '2  Scan to walk on the riverbank', short(joinUrl))]
    : [qrFigure(joinUrl, 'Scan to walk on the riverbank', short(joinUrl))]));
}

const dur = (s) => Number.isFinite(s) ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : '—';

function render() {
  const resting = !!stopped || (!open && performance.now() - closedAt > 2000);
  if (els.qr) els.qr.hidden = resting;
  if (els.resting) {
    els.resting.hidden = !resting;
    els.resting.replaceChildren(h('p', 'rest', 'This exhibit is resting. Please use the keyboard.', ...(stopped ? [h('small', '', stopped)] : [])));
  }

  const row = (color, name, away, plaque) =>
    h('li', away ? 'away' : '', dot(color), h('span', '', name, away ? ' (away)' : '', ...(plaque ? [h('span', 'fig', ` · ${cards[plaque].fig}`)] : [])));
  els.roster?.replaceChildren(h('h2', '', 'On the bank'), h('ul', '',
    row('var(--slot-keyboard)', 'Keyboard', false, ownedBy(owners, 0)),
    ...[...players].map(([pid, p]) => row(p.color, p.name, p.away, ownedBy(owners, pid)))));

  const where = hub?.region && hub.region !== 'local' ? `fly ${hub.region}` : hub ? 'local' : '—';
  const hud = [h('div', 'line', dot('', open && hubSeen ? 'ok' : 'bad'), `${where} · players ${players.size}/${MAX_PLAYERS}`)];
  if (hudOpen) {
    const s = stats || {}, fps = game.stats()?.fps;
    hud.push(h('div', 'more', ...[
      `join ${joinUrl || '—'}`,
      `up ${dur(s.uptime)} · joins ${s.joinsTotal ?? '—'} · reconnects ${s.reconnects ?? '—'}`,
      `fps ${Number.isFinite(fps) ? Math.round(fps) : '—'}`,
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
// A phone frozen in the background can leave its socket open without sending the zero; its 10 Hz heartbeat stops instead.
setInterval(() => {
  const now = performance.now();
  for (const [pid, p] of players) if (p.moving && now - p.lastInput > INPUT_STALE_MS) { p.moving = false; game.setInput(pid, 0, 0); }
  for (const [plaque, pid] of owners) { // phone owners only: the keyboard releases on Esc, close, walk-off or R
    const p = players.get(pid), why = p && ownerExpiry(p, now, judge, OWNER_LIMITS);
    if (why) release(plaque, why);
  }
}, 250);
setInterval(() => { for (const { pid, reason } of idleKicks(players, owners, performance.now(), judge, KICK_LIMITS)) kick(pid, reason); }, 1000);
connect();
render();
