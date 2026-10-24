// The realtime relay: routes JSON between each room's host tab (a TV) and that room's phones. It holds no game state;
// the host tab owns seats, tokens and every rule (src/host/slots.js). The same module runs in three places: hub.js (the
// laptop: port 8080 in dev, port 80 for the Q fallback), api/ws.js (a Vercel Function) and the tests. Instances share
// messages over a bus: Redis pub/sub on Vercel (hub/redisBus.js), an in-process broker otherwise.
// Rooms: a host connects with ?role=host&key=<its own random key> and the relay names the room after a hash of the key
// (sent back in `hub`); a phone connects with ?room=. Every channel and every piece of state is per room.
// Protocol: README "Protocol".
import crypto from 'node:crypto';
import {
  MAX_SOCKETS, MAX_ROOMS, PLAYER_MAX_PAYLOAD, MSGS_PER_SEC, HOST_MSGS_PER_SEC, PING_MS, HB_MS, HOST_KEY_RE, ROOM_RE,
  CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, CLOSE_EVICTED, CLOSE_REPLACED, CLOSE_NO_ROOM,
} from '../src/shared/protocol.js';

const HOST_CLOSE_CODES = new Set([CLOSE_EVICTED, CLOSE_REPLACED]); // the only closes the host may order
const rid = (n) => crypto.randomBytes(n).toString('base64url');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// The room a host key opens. One-way, so a room id in a QR code never lets anyone host that room.
const roomOf = (key) => crypto.createHash('sha256').update('tt-room:' + key).digest('base64url').slice(0, 16);
// A public Vercel Blob scene file, as api/interpret.js writes it (scenes/<id>.json).
const SCENE_URL = /^https:\/\/[a-z0-9-]{1,64}\.public\.blob\.vercel-storage\.com\/scenes\/[A-Za-z0-9_-]{1,64}\.json$/;

// In-process pub/sub shaped like Redis: a publish reaches every bus subscribed to its channel at that moment, its own
// included, later, in order and by value.
export function createBroker() {
  const buses = new Set();
  return {
    bus() {
      const chans = new Set(), handlers = new Set();
      buses.add({ chans, deliver: (ch, raw) => { const m = JSON.parse(raw); for (const h of handlers) h(ch, m); } });
      return {
        publish(ch, m) { const raw = JSON.stringify(m); for (const b of buses) if (b.chans.has(ch)) queueMicrotask(() => b.deliver(ch, raw)); },
        listen(h) { handlers.add(h); },
        subscribe(...chs) { for (const ch of chs) chans.add(ch); },
        unsubscribe(...chs) { for (const ch of chs) chans.delete(ch); },
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
export function createRelay({ bus, info = () => ({}) }) {
  const instance = rid(4);
  // room id -> { id, ch: its channels, n: its sockets on this instance, host: its host socket here, players: cid -> socket, ready }
  const rooms = new Map();

  const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const publish = (ch, m) => { try { bus.publish(ch, { ...m, o: instance }); } catch (err) { console.warn('relay: publish failed:', err.message); } };
  // Phone -> host: straight to this instance's host of the room when it has one (no Redis command), else through the
  // bus to the instance that does. Each message reaches exactly one host socket; during a host rollover the page keeps
  // reading the old socket until it closes, so a message delivered there is not lost.
  const toHost = (r, m) => { if (r.host) send(r.host, m); else publish(r.ch.host, m); };

  // A host command for the room's phones on this instance.
  function command(r, c) {
    if (c.t === 'to') send(r.players.get(c.cid), c.msg);
    else if (c.t === 'all') for (const ws of r.players.values()) send(ws, c.msg);
    else if (c.t === 'close') {
      const ws = r.players.get(c.cid);
      if (!ws) return;
      if (c.msg) send(ws, c.msg);
      ws.close(c.code, c.reason);
    }
  }

  bus.listen((ch, m) => {
    const r = rooms.get(String(ch).split(':')[1]); // tt:<room>:<kind>; a room id has no ':'
    if (!r || !isObj(m) || m.o === instance) return; // our own publish: already delivered locally
    const { o, ...msg } = m;
    if (ch === r.ch.host) send(r.host, msg);
    else if (ch === r.ch.phones) command(r, msg);
    // Another instance took the room's host: ours goes unless it is the newer one (ties by id), so two TV tabs opened
    // at the same moment leave exactly one host instead of closing each other.
    else if (ch === r.ch.ctl && msg.t === 'host' && r.host && r.host.hid !== msg.hid
      && (r.host.at < msg.at || (r.host.at === msg.at && r.host.hid < msg.hid))) r.host.close(CLOSE_HOST_REPLACED, 'replaced by a new host tab');
    // Ours is the newer one: say so again, in case that instance was still subscribing when our claim went out.
    else if (ch === r.ch.ctl && msg.t === 'host' && r.host && r.host.hid !== msg.hid) publish(r.ch.ctl, { t: 'host', hid: r.host.hid, at: r.host.at });
  });

  // The first socket of a room on this instance subscribes to the room's channels; the last one to close unsubscribes.
  function enter(id) {
    let r = rooms.get(id);
    if (!r) {
      const ch = { host: `tt:${id}:host`, phones: `tt:${id}:phones`, ctl: `tt:${id}:ctl` };
      r = { id, ch, n: 0, host: null, players: new Map(), ready: null };
      r.ready = Promise.resolve(bus.subscribe(ch.host, ch.phones, ch.ctl));
      // A failed SUBSCRIBE is not kept: the room's next socket subscribes afresh instead of waiting out the closes.
      r.ready.catch(() => { if (rooms.get(id) === r) rooms.delete(id); });
      rooms.set(id, r);
    }
    r.n++;
    return r;
  }
  function leave(r) {
    if (--r.n > 0 || rooms.get(r.id) !== r) return; // a room whose SUBSCRIBE failed is already gone
    rooms.delete(r.id);
    bus.unsubscribe(r.ch.host, r.ch.phones, r.ch.ctl);
  }

  // Each returns the socket's message handler.
  function onHost(ws, r, req) {
    ws.role = 'host'; ws.hid = rid(6); ws.at = Date.now(); ws.bucket = HOST_MSGS_PER_SEC;
    const old = r.host; r.host = ws;
    if (old) old.close(CLOSE_HOST_REPLACED, 'replaced by a new host tab');
    publish(r.ch.ctl, { t: 'host', hid: ws.hid, at: ws.at }); // one host per room across every instance: the newest wins
    send(ws, { t: 'hub', ...info(req), instance, room: r.id });
    ws.on('close', () => { if (r.host === ws) r.host = null; });
    return (buf) => {
      if (--ws.bucket < 0) return; // refilled every second
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (!isObj(m)) return;
      try {
        if (m.t === 'all' && isObj(m.msg)) { const c = { t: 'all', msg: m.msg }; command(r, c); publish(r.ch.phones, c); return; }
        if (typeof m.cid !== 'string') return;
        let c;
        if (m.t === 'to' && isObj(m.msg)) c = { t: 'to', cid: m.cid, msg: m.msg };
        else if (m.t === 'close' && HOST_CLOSE_CODES.has(m.code)) {
          c = { t: 'close', cid: m.cid, code: m.code, reason: typeof m.reason === 'string' ? m.reason.slice(0, 32) : '' };
          if (isObj(m.msg)) c.msg = m.msg;
        } else return;
        if (r.players.has(c.cid)) command(r, c); else publish(r.ch.phones, c); // a cid lives on exactly one instance
      } catch (err) { console.warn('relay: host message dropped:', err.message); }
    };
  }

  function onPlayer(ws, r) {
    if (r.players.size >= MAX_SOCKETS) { ws.close(1013, 'busy'); return () => {}; }
    const cid = rid(9);
    ws.role = 'player'; ws.cid = cid; ws.bucket = MSGS_PER_SEC;
    r.players.set(cid, ws);
    toHost(r, { t: 'open', cid });
    ws.on('close', () => { if (r.players.get(cid) === ws) r.players.delete(cid); toHost(r, { t: 'gone', cid }); });
    return (buf) => {
      if (buf.length > PLAYER_MAX_PAYLOAD) return ws.close(1009, 'too big');
      if (--ws.bucket < 0) return; // refilled every second
      let m; try { m = JSON.parse(buf); } catch { return; }
      const c = clean(m);
      if (c) toHost(r, { ...c, cid });
    };
  }

  function connection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // ws emits on bad frames; unhandled it would end the process for every phone
    let q;
    try { q = new URL(req.url, 'http://x').searchParams; } catch { return ws.close(1008, 'bad url'); } // a target like //[ throws
    const isHost = q.get('role') === 'host', key = q.get('key') || '';
    if (isHost && !HOST_KEY_RE.test(key)) return ws.close(CLOSE_BAD_HOST_TOKEN, 'host key');
    const id = isHost ? roomOf(key) : q.get('room') || '';
    if (!ROOM_RE.test(id)) return ws.close(CLOSE_NO_ROOM, 'room');
    if (!rooms.has(id) && rooms.size >= MAX_ROOMS) return ws.close(1013, 'busy'); // random room ids cannot grow it without end
    const r = enter(id);
    // Nothing is announced or routed until this instance hears the room's channels, so no reply can outrun its
    // SUBSCRIBE; what the socket says meanwhile waits (a second's worth at most).
    const held = [];
    let handle = null;
    ws.on('message', (buf) => { if (handle) handle(buf); else if (held.length < MSGS_PER_SEC) held.push(buf); });
    ws.on('close', () => leave(r));
    r.ready.then(() => {
      if (ws.readyState !== 1) return;
      handle = isHost ? onHost(ws, r, req) : onPlayer(ws, r);
      for (const buf of held) handle(buf);
    }, (err) => { console.warn('relay: subscribe failed:', err.message); ws.close(1013, 'relay not ready'); });
  }

  const players = () => [...rooms.values()].flatMap((r) => [...r.players.values()]);
  const sockets = () => [...rooms.values()].flatMap((r) => (r.host ? [r.host, ...r.players.values()] : [...r.players.values()]));
  const timers = [
    setInterval(() => { for (const ws of sockets()) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, PING_MS),
    setInterval(() => { for (const ws of sockets()) ws.bucket = ws.role === 'host' ? HOST_MSGS_PER_SEC : MSGS_PER_SEC; }, 1000),
    // Liveness, plus this instance's id for the network layer; the host's own hb carries ts instead.
    setInterval(() => { for (const ws of players()) send(ws, { t: 'hb', i: instance }); }, HB_MS),
  ];
  for (const t of timers) t.unref?.();

  return {
    connection,
    instance,
    // Totals over every room on this instance: host sockets and phone sockets.
    stats: () => ({ instance, host: [...rooms.values()].filter((r) => r.host).length, sockets: players().length }),
    stop() { for (const t of timers) clearInterval(t); },
  };
}
