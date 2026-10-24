// The realtime relay: routes JSON between the one host tab (the TV) and the phones. It holds no game state; the host
// tab owns seats, tokens and every rule (src/host/slots.js). The same module runs in three places: hub.js (the laptop:
// port 8080 in dev, port 80 for the Q fallback), api/ws.js (a Vercel Function) and the tests. Instances share
// messages over a bus: Redis pub/sub on Vercel (hub/redisBus.js), an in-process broker otherwise.
// Protocol: README "Protocol".
import crypto from 'node:crypto';
import {
  MAX_SOCKETS, PLAYER_MAX_PAYLOAD, MSGS_PER_SEC, PING_MS, HB_MS,
  CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, CLOSE_EVICTED, CLOSE_REPLACED,
} from '../src/shared/protocol.js';

export const CH = { host: 'tt:host', phones: 'tt:phones', ctl: 'tt:ctl' };
const HOST_CLOSE_CODES = new Set([CLOSE_EVICTED, CLOSE_REPLACED]); // the only closes the host may order
const rid = (n) => crypto.randomBytes(n).toString('base64url');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// A public Vercel Blob scene file, as api/interpret.js writes it (scenes/<id>.json).
const SCENE_URL = /^https:\/\/[a-z0-9-]{1,64}\.public\.blob\.vercel-storage\.com\/scenes\/[A-Za-z0-9_-]{1,64}\.json$/;

// In-process pub/sub shaped like Redis: every bus on one broker sees every publish, its own included, later and in order.
export function createBroker() {
  const subs = new Set();
  return {
    bus() {
      const handlers = new Set();
      const deliver = (ch, raw) => { const m = JSON.parse(raw); for (const h of handlers) h(ch, m); };
      subs.add(deliver);
      return {
        publish(ch, m) { const raw = JSON.stringify(m); for (const s of subs) queueMicrotask(() => s(ch, raw)); },
        subscribe(h) { handlers.add(h); },
        ready: () => Promise.resolve(),
      };
    },
  };
}

// Player messages are untrusted: keep the known types and fields only. Never String() or | 0 a value
// (`{"toString":1}` throws); this is the trust boundary, so the host only ever sees these shapes.
export function clean(m) {
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello': return { t: 'hello', token: typeof m.token === 'string' && m.token.length <= 64 ? m.token : null, slot: Number.isInteger(m.slot) ? m.slot : null };
    case 'here': return { t: 'here' };
    case 'in': return { t: 'in', lx: m.lx === 1 || m.lx === -1 ? m.lx : 0, a: m.a ? 1 : 0 };
    case 'panel': {
      const kind = typeof m.kind === 'string' ? m.kind.slice(0, 16) : '';
      // The phone's photo handoff: the scene file /api/interpret just stored, and nothing but such a Blob URL.
      if (kind === 'artwork') return typeof m.value === 'string' && SCENE_URL.test(m.value) ? { t: 'panel', kind, value: m.value } : null;
      return { t: 'panel', kind, value: typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : 0 };
    }
    case 'hbr': return { t: 'hbr', ts: typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0 };
    default: return null;
  }
}

// `info(req)` adds the fields of the `hub` message the host gets on connect (joinUrl, lanIp, region, wifi).
export function createRelay({ bus, hostToken = '', info = () => ({}) }) {
  const instance = rid(4);
  let host = null;                 // the host socket on this instance, if any
  const players = new Map();       // cid -> player socket on this instance

  const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const publish = (ch, m) => { try { bus.publish(ch, { ...m, o: instance }); } catch (err) { console.warn('relay: publish failed:', err.message); } };
  // Phone -> host: straight to this instance's host when it has one (no Redis command), else through the bus to the
  // instance that does. Each message reaches exactly one host socket; during a host rollover the page keeps reading
  // the old socket until it closes, so a message delivered there is not lost.
  const toHost = (m) => { if (host) send(host, m); else publish(CH.host, m); };

  // A host command for the phones on this instance.
  function command(c) {
    if (c.t === 'to') send(players.get(c.cid), c.msg);
    else if (c.t === 'all') for (const ws of players.values()) send(ws, c.msg);
    else if (c.t === 'close') {
      const ws = players.get(c.cid);
      if (!ws) return;
      if (c.msg) send(ws, c.msg);
      ws.close(c.code, c.reason);
    }
  }

  bus.subscribe((ch, m) => {
    if (!isObj(m) || m.o === instance) return; // our own publish: already delivered locally
    const { o, ...msg } = m;
    if (ch === CH.host) send(host, msg);
    else if (ch === CH.phones) command(msg);
    // Another instance took a host: ours goes unless it is the newer one (ties by id), so two TV tabs opened at the
    // same moment leave exactly one host instead of closing each other.
    else if (ch === CH.ctl && msg.t === 'host' && host && host.hid !== msg.hid
      && (host.at < msg.at || (host.at === msg.at && host.hid < msg.hid))) host.close(CLOSE_HOST_REPLACED, 'replaced by a new host tab');
  });

  function onHost(ws, q, req) {
    if (hostToken && q.get('host') !== hostToken) return ws.close(CLOSE_BAD_HOST_TOKEN, 'host token');
    ws.role = 'host'; ws.hid = rid(6); ws.at = Date.now();
    const old = host; host = ws;
    if (old) old.close(CLOSE_HOST_REPLACED, 'replaced by a new host tab');
    publish(CH.ctl, { t: 'host', hid: ws.hid, at: ws.at }); // one host across every instance: the newest wins
    send(ws, { t: 'hub', ...info(req), instance });
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (!isObj(m)) return;
      try {
        if (m.t === 'all' && isObj(m.msg)) { const c = { t: 'all', msg: m.msg }; command(c); publish(CH.phones, c); return; }
        if (typeof m.cid !== 'string') return;
        let c;
        if (m.t === 'to' && isObj(m.msg)) c = { t: 'to', cid: m.cid, msg: m.msg };
        else if (m.t === 'close' && HOST_CLOSE_CODES.has(m.code)) {
          c = { t: 'close', cid: m.cid, code: m.code, reason: typeof m.reason === 'string' ? m.reason.slice(0, 32) : '' };
          if (isObj(m.msg)) c.msg = m.msg;
        } else return;
        if (players.has(c.cid)) command(c); else publish(CH.phones, c); // a cid lives on exactly one instance
      } catch (err) { console.warn('relay: host message dropped:', err.message); }
    });
    ws.on('close', () => { if (host === ws) host = null; });
  }

  function onPlayer(ws) {
    if (players.size >= MAX_SOCKETS) return ws.close(1013, 'busy');
    const cid = rid(9);
    ws.role = 'player'; ws.cid = cid; ws.bucket = MSGS_PER_SEC;
    players.set(cid, ws);
    toHost({ t: 'open', cid });
    ws.on('message', (buf) => {
      if (buf.length > PLAYER_MAX_PAYLOAD) return ws.close(1009, 'too big');
      if (--ws.bucket < 0) return; // refilled every second
      let m; try { m = JSON.parse(buf); } catch { return; }
      const c = clean(m);
      if (c) toHost({ ...c, cid });
    });
    ws.on('close', () => { if (players.get(cid) === ws) players.delete(cid); toHost({ t: 'gone', cid }); });
  }

  function connection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // ws emits on bad frames; unhandled it would end the process for every phone
    let q;
    try { q = new URL(req.url, 'http://x').searchParams; } catch { return ws.close(1008, 'bad url'); } // a target like //[ throws
    if (q.get('role') === 'host') onHost(ws, q, req); else onPlayer(ws);
  }

  const sockets = () => (host ? [host, ...players.values()] : [...players.values()]);
  const timers = [
    setInterval(() => { for (const ws of sockets()) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, PING_MS),
    setInterval(() => { for (const ws of players.values()) ws.bucket = MSGS_PER_SEC; }, 1000),
    // Liveness, plus this instance's id for the network layer; the host's own hb carries ts instead.
    setInterval(() => { for (const ws of players.values()) send(ws, { t: 'hb', i: instance }); }, HB_MS),
  ];
  for (const t of timers) t.unref?.();

  return {
    connection,
    instance,
    stats: () => ({ instance, host: !!host, sockets: players.size }),
    stop() { for (const t of timers) clearInterval(t); },
  };
}
