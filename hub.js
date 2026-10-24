// Hub: a dumb relay. The host tab (the TV) owns all game state; this process routes JSON between one
// host socket and the player sockets, hands out tokens and holds a slot briefly across a reconnect.
// Ported from deploy/fly/hub.reference.js (AI-assisted reference). Protocol: README "Protocol".
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  MAX_PLAYERS, MAX_SOCKETS, PLAYER_MAX_PAYLOAD, MSGS_PER_SEC, SLOT_HOLD_MS, PING_MS, HB_MS, STATS_MS,
  CLOSE_HOST_REPLACED, CLOSE_EVICTED, CLOSE_BAD_HOST_TOKEN, CLOSE_REPLACED,
} from './src/shared/protocol.js';

const env = process.env;
const PORT = Number(env.PORT) || 8080;
const HOST_TOKEN = env.HOST_TOKEN || '';               // empty = no check (local only)
const REGION = env.FLY_REGION || 'local';
const SLOTS = JSON.parse(fs.readFileSync(new URL('./src/shared/slots.json', import.meta.url), 'utf8'));
const DIST = fileURLToPath(new URL('./dist/', import.meta.url));

// Recomputed per call: the laptop may move from campus Wi-Fi to the hotspot after the hub starts.
function lanIp() {
  if (env.LAN_IP) return env.LAN_IP;
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter(a => (a.family === 'IPv4' || a.family === 4) && !a.internal).map(a => ({ name, ip: a.address })));
  const score = (c) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.ip) ? 2 : 0) - (/virtual|vethernet|vmware|vbox|wsl|docker/i.test(c.name) ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a))[0]?.ip || '127.0.0.1';
}
const joinUrl = () => env.JOIN_URL || `http://${lanIp()}${PORT === 80 ? '' : ':' + PORT}/`;

let host = null, cap = MAX_PLAYERS, nextPid = 1, reconnects = 0, joinsTotal = 0;
const BOOT = crypto.randomBytes(6).toString('base64url'); // pids restart at 1 with each process; the host needs to know
const slots = new Map();   // token -> { pid, token, slot, name, color, ws (null while away), hold }
const kicked = new Map();  // token -> reason: a kicked phone that comes back with its token (it was away) is evicted again
const live = () => [...slots.values()].filter(s => s.ws);
const byPid = (pid) => [...slots.values()].find(s => s.pid === pid);
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const toHost = (msg) => send(host, msg);
const freeSlots = () => {
  if (slots.size >= cap) return [];
  const used = new Set([...slots.values()].map(s => s.slot));
  return SLOTS.map((_, i) => i).filter(i => !used.has(i));
};
const lobby = (ws) => send(ws, { t: 'lobby', free: freeSlots() });
const lobbyAll = () => { for (const ws of wss.clients) if (ws.role === 'player' && ws.pid == null) lobby(ws); };

function dropSlot(s, reason) {
  clearTimeout(s.hold);
  if (slots.get(s.token) !== s) return;
  slots.delete(s.token);
  if (s.ws) { const w = s.ws; s.ws = null; w.pid = null; send(w, { t: 'evicted', reason }); w.close(CLOSE_EVICTED, reason); }
  toHost({ t: 'leave', pid: s.pid });
  lobbyAll();
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => {
  res.set('Access-Control-Allow-Origin', env.ALLOW_ORIGIN || '*');
  res.json({ ok: true, players: live().length, slots: slots.size, host: !!host, uptime: Math.round(process.uptime()), reconnects, joinsTotal, region: REGION, joinUrl: joinUrl(), cap });
});
const page = (res, file) => res.sendFile(DIST + file, { headers: { 'Cache-Control': 'no-cache' } },
  (err) => { if (err && !res.headersSent) res.status(404).type('text').send('dist missing: run npm run build'); });
app.get('/', (req, res) => page(res, 'join.html'));
app.get('/host', (req, res) => {
  if (HOST_TOKEN && req.query.host !== HOST_TOKEN) return res.status(403).type('text').send('host token required');
  page(res, 'host.html');
});
// Vite's hashed bundles are immutable; public files (path.json, depth, sprites) change during the event.
app.use(express.static(DIST, { index: false, setHeaders: (res, file) =>
  res.setHeader('Cache-Control', /-[\w-]{8}\.\w+$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache') }));

const server = http.createServer(app);
// Generous here so the host is exempt; players are held to PLAYER_MAX_PAYLOAD below.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  ws.isAlive = true; ws.bucket = MSGS_PER_SEC;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});   // ws emits on bad frames; unhandled it would crash the process

  if (q.get('role') === 'host') {
    if (HOST_TOKEN && q.get('host') !== HOST_TOKEN) return ws.close(CLOSE_BAD_HOST_TOKEN, 'host token');
    const old = host; host = ws; ws.role = 'host';
    if (old) old.close(CLOSE_HOST_REPLACED, 'replaced by a new host tab');
    toHost({ t: 'hub', joinUrl: joinUrl(), lanIp: lanIp(), region: REGION, boot: BOOT, wifi: env.WIFI_SSID ? { ssid: env.WIFI_SSID, pass: env.WIFI_PASS || '' } : null });
    for (const s of live()) toHost({ t: 'join', pid: s.pid, name: s.name, color: s.color });
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (!m) return;
      try {
        const msg = m.msg && typeof m.msg === 'object' ? m.msg : null;
        if (m.t === 'to' && msg) send(byPid(m.pid)?.ws, msg);
        else if (m.t === 'all' && msg) for (const s of live()) send(s.ws, msg);
        else if (m.t === 'kick') {
          const s = byPid(m.pid), why = (typeof m.reason === 'string' && m.reason.slice(0, 32)) || 'judge';
          if (s) { kicked.set(s.token, why); dropSlot(s, why); }
        }
        else if (m.t === 'cap' && Number.isInteger(m.max)) { cap = Math.max(0, Math.min(MAX_PLAYERS, m.max)); lobbyAll(); }
      } catch (err) { console.warn('hub: host message dropped:', err.message); }
    });
    ws.on('close', () => { if (host === ws) host = null; });
    return;
  }

  let n = 0; for (const c of wss.clients) if (c.role === 'player') n++;
  if (n >= MAX_SOCKETS) return ws.close(1013, 'busy');
  ws.role = 'player'; ws.pid = null;
  lobby(ws);

  ws.on('message', (buf) => {
    if (buf.length > PLAYER_MAX_PAYLOAD) return ws.close(1009, 'too big');
    if (--ws.bucket < 0) return;   // refilled every second
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!m) return;
    // onPlayer type-checks untrusted values (String() or | 0 on {"toString":1} throws); this catch is the backstop,
    // since a throw escaping a ws listener ends the process for every phone and the host.
    try { onPlayer(ws, m); } catch (err) { console.warn('hub: player message dropped:', err.message); }
  });

  ws.on('close', () => {
    const s = byPid(ws.pid);
    if (!s || s.ws !== ws) return;   // already replaced or dropped
    s.ws = null;
    toHost({ t: 'in', pid: s.pid, lx: 0, a: 0 });   // stop the figure at once
    toHost({ t: 'away', pid: s.pid });
    s.hold = setTimeout(() => dropSlot(s, 'timeout'), SLOT_HOLD_MS);
  });
});

function onPlayer(ws, m) {
  if (m.t === 'hello') {
    if (ws.pid != null) return;
    if (kicked.has(m.token)) { const why = kicked.get(m.token); send(ws, { t: 'evicted', reason: why }); return ws.close(CLOSE_EVICTED, why); }
    let s = typeof m.token === 'string' ? slots.get(m.token) : null, back = false, fresh = !s;
    if (s) {
      clearTimeout(s.hold); reconnects++;
      back = !s.ws;
      // Same token on a still-open socket (half-open phone, second tab): the newest socket wins.
      if (s.ws) { const w = s.ws; w.pid = null; w.close(CLOSE_REPLACED, 'replaced'); }
    } else {
      const free = freeSlots();
      if (!free.length) return send(ws, { t: 'full' });
      const i = free.includes(m.slot) ? m.slot : free[0];
      s = { pid: nextPid++, token: crypto.randomBytes(16).toString('base64url'), slot: i, name: SLOTS[i].name, color: SLOTS[i].color, ws: null, hold: null };
      slots.set(s.token, s); joinsTotal++;
    }
    s.ws = ws; ws.pid = s.pid;
    send(ws, { t: 'welcome', pid: s.pid, token: s.token, color: s.color, name: s.name, slot: s.slot });
    if (back) toHost({ t: 'back', pid: s.pid });
    toHost({ t: 'join', pid: s.pid, name: s.name, color: s.color });
    if (fresh) lobbyAll();
    return;
  }
  const pid = ws.pid;
  if (pid == null) return;
  if (m.t === 'in') toHost({ t: 'in', pid, lx: m.lx === 1 || m.lx === -1 ? m.lx : 0, a: m.a ? 1 : 0 });
  else if (m.t === 'panel') toHost({ t: 'panel', pid, kind: typeof m.kind === 'string' ? m.kind.slice(0, 16) : '', value: typeof m.value === 'number' ? m.value : 0 });
  else if (m.t === 'hbr') toHost({ t: 'hbr', pid, ts: typeof m.ts === 'number' ? m.ts : 0 });
}

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, PING_MS);
setInterval(() => { for (const ws of wss.clients) ws.bucket = MSGS_PER_SEC; }, 1000);
setInterval(() => { for (const ws of wss.clients) if (ws.role === 'player') send(ws, { t: 'hb', host: !!host }); }, HB_MS);
setInterval(() => toHost({ t: 'stats', uptime: Math.round(process.uptime()), joinsTotal, reconnects, players: live().length }), STATS_MS);

server.listen(PORT, '0.0.0.0', () => console.log(`hub listening on ${PORT} (${REGION}), join ${joinUrl()}`));
