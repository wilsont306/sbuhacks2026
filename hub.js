// The laptop hub: serves the built pages and runs the shared relay (hub/relay.js) in one process, for development
// (port 8080, `npm run hub`) and the Q fallback (port 80 over the hotspot, tools/start.cmd). Like the Vercel
// Function api/ws.js it holds no game state; the host tab owns seats and tokens. Protocol: README "Protocol".
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createRelay, createBroker } from './hub/relay.js';
import { WS_PATH } from './src/shared/protocol.js';

const env = process.env;
const PORT = Number(env.PORT) || 8080;
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

const relay = createRelay({
  bus: createBroker().bus(),
  // The hotspot password goes only to a TV on this laptop (its Q socket is ws://localhost); anyone can host a room now.
  info: (req) => ({ joinUrl: joinUrl(), lanIp: lanIp(), region: 'local', bus: 'local',
    wifi: env.WIFI_SSID && /^(::1|127\.|::ffff:127\.)/.test((req && req.socket && req.socket.remoteAddress) || '') ? { ssid: env.WIFI_SSID, pass: env.WIFI_PASS || '' } : null }),
});

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => {
  res.set('Access-Control-Allow-Origin', env.ALLOW_ORIGIN || '*');
  res.json({ ok: true, ...relay.stats(), uptime: Math.round(process.uptime()), region: 'local', joinUrl: joinUrl() });
});
const page = (res, file) => res.sendFile(DIST + file, { headers: { 'Cache-Control': 'no-cache' } },
  (err) => { if (err && !res.headersSent) res.status(404).type('text').send('dist missing: run npm run build'); });
app.get('/', (req, res) => page(res, 'join.html'));
// Open to anyone: each TV hosts its own room with its own key, so the page needs no token.
app.get('/host', (req, res) => page(res, 'host.html'));
// Vite's hashed bundles are immutable; public files (samples, sfx, sprites) change during the event.
app.use(express.static(DIST, { index: false, setHeaders: (res, file) =>
  res.setHeader('Cache-Control', /-[\w-]{8}\.\w+$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache') }));

const server = http.createServer(app);
// WS_PATH as on Vercel; /ws too, for kiosks and links set up before the move.
const PATHS = new Set([WS_PATH, '/ws']);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // generous so the host is exempt; the relay holds players to 1 KB
  // A target like //[ makes new URL throw, and a throw here would end the process for the TV and every phone.
  verifyClient: ({ req }) => { try { return PATHS.has(new URL(req.url, 'http://x').pathname); } catch { return false; } },
});
wss.on('connection', relay.connection);

server.listen(PORT, '0.0.0.0', () => console.log(`hub listening on ${PORT} (local), join ${joinUrl()}`));
