// Vercel Function: the realtime relay at /api/ws (README "Protocol"), the plain Node pattern from Vercel's
// WebSockets docs (an http server with ws, exported). Every socket closes at the function's max duration, so both
// pages switch to a fresh socket before then. Phones and the host may land on different instances, so the bus is
// Redis; without a Redis URL it falls back to delivery inside one instance, which only works while everyone shares it.
// A plain GET (no upgrade) answers with this instance's health.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelay, createBroker } from '../hub/relay.js';
import { redisBus } from '../hub/redisBus.js';

const env = process.env;
// REDIS_URL by hand; KV_URL / UPSTASH_KV_URL are the names the Upstash integration has injected (rediss://).
const url = env.REDIS_URL || env.KV_URL || env.UPSTASH_KV_URL || '';
if (!url) console.warn('relay: no REDIS_URL; messages stay inside one instance');
const bus = url ? redisBus(url) : createBroker().bus();
const region = env.VERCEL_REGION || 'vercel';

const relay = createRelay({
  bus,
  hostToken: env.HOST_TOKEN || '',
  info: (req) => ({ joinUrl: env.JOIN_URL || `https://${req.headers.host}/`, lanIp: null, region, wifi: null, bus: url ? 'redis' : 'local' }),
});

const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, ...relay.stats(), region, bus: url ? 'redis' : 'local' }));
});
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // generous so the host is exempt; the relay holds players to 1 KB
  // Accept only once Redis answers; a refused upgrade makes the page retry with backoff instead of losing messages.
  verifyClient: (_info, done) => {
    within(bus.ready(), 4000).then(() => done(true), (err) => { console.warn('relay: bus not ready:', err.message); done(false, 503, 'relay not ready'); });
  },
});
wss.on('connection', relay.connection);

export default server;
