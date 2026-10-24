// Tests for the stateless relay (hub/relay.js): its pure parts (clean, createBroker); hub.js spawned as a child and
// driven by real ws clients, as the TV and the phones use it; and two in-process relays on one broker, standing in
// for two Vercel instances on Redis, so a message that crosses instances is checked to arrive exactly once.
import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { clean, createBroker, createRelay } from '../hub/relay.js';
import {
  WS_PATH, MAX_SOCKETS, MAX_ROOMS, MSGS_PER_SEC, HOST_MSGS_PER_SEC, PLAYER_MAX_PAYLOAD,
  CLOSE_EVICTED, CLOSE_REPLACED, CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, CLOSE_NO_ROOM,
} from '../src/shared/protocol.js';

const ROOT = new URL('..', import.meta.url);
const ORIGIN = 'https://example.vercel.app';
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// A ws client with an inbox: next(...types) resolves with the next message of one of those types; log keeps them all.
function client(url) {
  const ws = new WebSocket(url);
  const inbox = [], waiters = [];
  ws.log = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    ws.log.push(m);
    const i = waiters.findIndex((w) => w.ts.includes(m.t));
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m);
  });
  ws.failed = new Promise((res) => ws.on('error', (e) => res(e.message)));
  ws.opened = new Promise((res) => ws.once('open', res));
  ws.closed = new Promise((res) => ws.on('close', (code, reason) => { ws.reason = String(reason); res(code); }));
  ws.raw = (s) => (ws.readyState === 1 ? ws.send(s) : ws.once('open', () => ws.send(s)));
  ws.json = (m) => ws.raw(JSON.stringify(m));
  ws.next = (...ts) => {
    const i = inbox.findIndex((m) => ts.includes(m.t));
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { ts, res: (m) => { clearTimeout(timer); res(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout waiting for ${ts}`)); }, 3000);
      waiters.push(w);
    });
  };
  ws.count = (t) => ws.log.filter((m) => m.t === t).length;
  return ws;
}
// Two TVs' keys and the rooms the relay names after them (computed here on their own, not with hub/relay.js).
const KEY = 'a'.repeat(22), KEY2 = 'b'.repeat(22);
const roomOf = (key) => createHash('sha256').update('tt-room:' + key).digest('base64url').slice(0, 16);
const ROOM = roomOf(KEY), ROOM2 = roomOf(KEY2);
const hostOf = (base, key = KEY) => client(`${base}?role=host&key=${key}`);
const inRoom = (base, room = ROOM) => `${base}?room=${room}`;
// A phone socket in `room` on `base`; the host's open {cid} names it. Phones connect one at a time so cids match.
async function phone(h, base, room = ROOM) {
  const p = client(inRoom(base, room));
  const { cid } = await h.next('open');
  await p.opened;
  return { p, cid };
}
// Nothing was delivered twice: every message a client got is distinct (the relay's own liveness hb aside).
function assertOnce(...clients) {
  for (const ws of clients) {
    const seen = new Set();
    for (const m of ws.log) {
      if (m.t === 'hb') continue;
      const k = JSON.stringify(m);
      assert.ok(!seen.has(k), 'delivered twice: ' + k);
      seen.add(k);
    }
  }
}
// A WebSocket upgrade with a request target no URL parser accepts (Node's http parser lets it through). Resolves with
// the status line and, after a 101, the code of the server's first frame if it is a close frame (else null).
function rawUpgrade(port, target) {
  return new Promise((res) => {
    const chunks = [];
    const done = () => {
      const buf = Buffer.concat(chunks), end = buf.indexOf('\r\n\r\n');
      const frame = end < 0 ? null : buf.subarray(end + 4);
      res({ status: buf.toString('latin1').split('\r\n')[0], close: frame?.length >= 4 && frame[0] === 0x88 ? frame.readUInt16BE(2) : null });
    };
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n`
      + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.setTimeout(1000, () => s.destroy());
    s.on('data', (d) => { chunks.push(d); setTimeout(() => s.destroy(), 100); });
    s.on('error', () => {}); s.on('close', done);
  });
}

describe('relay: pure parts', () => {
  test('clean keeps the known phone types and their fields only', () => {
    assert.deepEqual(clean({ t: 'hello', token: 'abc', slot: 3, pid: 9 }), { t: 'hello', token: 'abc', slot: 3 });
    assert.deepEqual(clean({ t: 'hello', token: 'x'.repeat(64), slot: 0 }), { t: 'hello', token: 'x'.repeat(64), slot: 0 });
    assert.deepEqual(clean({ t: 'hello', token: 'x'.repeat(65), slot: '3' }), { t: 'hello', token: null, slot: null });
    assert.deepEqual(clean({ t: 'hello', token: { toString: 1 }, slot: 2.5 }), { t: 'hello', token: null, slot: null });
    assert.deepEqual(clean({ t: 'hello' }), { t: 'hello', token: null, slot: null });
    assert.deepEqual(clean({ t: 'here', cid: 'forged' }), { t: 'here' });
    assert.deepEqual(clean({ t: 'in', lx: -1, a: true, pid: 2 }), { t: 'in', lx: -1, a: 1 });
    assert.deepEqual(clean({ t: 'in', lx: 2, a: 0 }), { t: 'in', lx: 0, a: 0 });
    assert.deepEqual(clean({ t: 'in', lx: { valueOf: 1, toString: 1 }, a: { toString: 1 } }), { t: 'in', lx: 0, a: 1 });
    assert.deepEqual(clean({ t: 'in', lx: '1' }), { t: 'in', lx: 0, a: 0 });
    assert.deepEqual(clean({ t: 'panel', kind: 'x'.repeat(40), value: 5 }), { t: 'panel', kind: 'x'.repeat(16), value: 5 });
    assert.deepEqual(clean({ t: 'panel', kind: { toString: 1 }, value: '5' }), { t: 'panel', kind: '', value: 0 });
    assert.deepEqual(clean({ t: 'panel', kind: 'lever', value: Infinity }), { t: 'panel', kind: 'lever', value: 0 });
    // artwork carries the scene file's Blob URL, and nothing else
    const sceneUrl = 'https://abc123xyz.public.blob.vercel-storage.com/scenes/0b7f9c2e-1d2a-4c3b-9e8f-1234567890ab.json';
    assert.deepEqual(clean({ t: 'panel', kind: 'artwork', value: sceneUrl }), { t: 'panel', kind: 'artwork', value: sceneUrl });
    for (const bad of ['https://evil.example.com/scenes/x.json', 'http://abc.public.blob.vercel-storage.com/scenes/x.json',
      'https://abc.public.blob.vercel-storage.com/art/x.jpg', 'https://abc.public.blob.vercel-storage.com/scenes/../x.json', 7, { toString: 1 }].entries()) {
      assert.equal(clean({ t: 'panel', kind: 'artwork', value: bad[1] }), null, `bad artwork value #${bad[0]}`);
    }
    assert.deepEqual(clean({ t: 'hbr', ts: 12.5 }), { t: 'hbr', ts: 12.5 });
    assert.deepEqual(clean({ t: 'hbr', ts: NaN }), { t: 'hbr', ts: 0 });
    for (const m of [null, undefined, 5, 'hello', [], [{ t: 'in' }], {}, { t: { toString: 1 } }, { t: '__proto__' },
      { t: 'to', cid: 'x', msg: {} }, { t: 'all', msg: {} }, { t: 'close', cid: 'x', code: 4001 }, { t: 'open', cid: 'x' },
      { t: 'gone', cid: 'x' }, { t: 'hub' }, { t: 'kick', pid: 1 }, { t: 'cap', max: 6 }]) assert.equal(clean(m), null, JSON.stringify(m));
  });

  test('createBroker: a bus hears the channels it subscribes to, its own publishes included, later, in order and by value', async () => {
    const broker = createBroker(), x = broker.bus(), y = broker.bus();
    const got = { x: [], y: [] };
    x.listen((ch, m) => got.x.push([ch, m.n]));
    y.listen((ch, m) => got.y.push([ch, m.n]));
    x.subscribe('a', 'b'); y.subscribe('b');
    const first = { n: 1 };
    x.publish('a', first); y.publish('b', { n: 2 }); x.publish('a', { n: 3 }); x.publish('c', { n: 4 });
    first.n = 99;
    assert.deepEqual(got, { x: [], y: [] }); // never synchronously
    await x.ready();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, { x: [['a', 1], ['b', 2], ['a', 3]], y: [['b', 2]] });
    x.unsubscribe('b');
    y.publish('b', { n: 5 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got.x, [['a', 1], ['b', 2], ['a', 3]]);
    assert.deepEqual(got.y, [['b', 2], ['b', 5]]);
  });

  test('connection closes a socket whose request target cannot be parsed, or without a room or a host key, instead of throwing', () => {
    const bus = createBroker().bus(), subs = [];
    const relay = createRelay({ bus: { ...bus, subscribe(...chs) { subs.push(chs); bus.subscribe(...chs); } } });
    const closed = [];
    const ws = { on() {}, close: (code, reason) => closed.push([code, reason]) };
    try {
      for (const url of ['//[', 'http://[::1', 'http://x:99999/']) assert.doesNotThrow(() => relay.connection(ws, { url }), url);
      assert.deepEqual(closed.map((c) => c[0]), [1008, 1008, 1008]);
      closed.length = 0;
      const noRoom = ['/api/ws', '/api/ws?room=', '/api/ws?room=' + ROOM.slice(1), '/api/ws?room=' + ROOM + 'x',
        `/api/ws?room=${ROOM.slice(1)}%2B`, '/api/ws?role=player&key=' + KEY];
      const noKey = ['/api/ws?role=host', '/api/ws?role=host&key=', '/api/ws?role=host&room=' + ROOM, '/api/ws?role=host&key=' + 'a'.repeat(21),
        '/api/ws?role=host&key=' + 'a'.repeat(65), `/api/ws?role=host&key=${'a'.repeat(21)}.`, `/api/ws?role=host&key=${'a'.repeat(21)}%2B&room=${ROOM}`];
      for (const url of [...noRoom, ...noKey]) relay.connection(ws, { url });
      assert.deepEqual(closed, [...noRoom.map(() => [CLOSE_NO_ROOM, 'room']), ...noKey.map(() => [CLOSE_BAD_HOST_TOKEN, 'host key'])]);
      assert.deepEqual(subs, []); // a refused socket never subscribes to anything
      assert.deepEqual(relay.stats(), { instance: relay.instance, host: 0, sockets: 0 });
    } finally { relay.stop(); }
  });
});

// ---- hub.js as a child process: a fresh one per test ----
let hub, port;
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const wsUrl = (path = WS_PATH) => `ws://127.0.0.1:${port}${path}`;
const status = async (path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); await r.arrayBuffer(); return r.status; };

async function startHub() {
  port = await freePort();
  hub = spawn(process.execPath, ['hub.js'], {
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, PORT: String(port), HOST_TOKEN: 'test', ALLOW_ORIGIN: ORIGIN, JOIN_URL: '', LAN_IP: '10.1.2.3', WIFI_SSID: 'Hotspot', WIFI_PASS: 'pw' },
  });
  let err = '';
  hub.stderr.on('data', (d) => { err += d; });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('hub did not start: ' + out + err)), 8000);
    hub.stdout.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(t); res(); } });
    hub.on('exit', (code) => { clearTimeout(t); rej(new Error(`hub exited ${code}: ${err}`)); });
  });
}
async function stopHub() {
  if (hub.exitCode !== null || hub.signalCode !== null) return;
  const exited = new Promise((r) => hub.once('exit', r));
  hub.kill();
  await exited;
}

describe('relay: hub.js', () => {
  beforeEach(startHub);
  afterEach(stopHub);

  it('greets the host with hub {joinUrl, lanIp, region, wifi, room}', async () => {
    const h = hostOf(wsUrl());
    const m = await h.next('hub');
    assert.equal(m.room, ROOM);
    assert.equal(m.joinUrl, `http://10.1.2.3:${port}/`);
    assert.equal(m.lanIp, '10.1.2.3');
    assert.equal(m.region, 'local');
    assert.deepEqual(m.wifi, { ssid: 'Hotspot', pass: 'pw' });
    assert.equal(typeof m.instance, 'string');
  });

  it('tells the host open {cid} when a phone connects and gone {cid} when it closes', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const p = client(inRoom(wsUrl()));
    const open = await h.next('open');
    assert.deepEqual(Object.keys(open).sort(), ['cid', 't']);
    assert.equal(typeof open.cid, 'string');
    await p.opened;
    p.close();
    assert.deepEqual(await h.next('gone'), { t: 'gone', cid: open.cid });
  });

  it('to {cid, msg} reaches only that phone; all {msg} reaches every phone', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const a = await phone(h, wsUrl()), b = await phone(h, wsUrl());
    h.json({ t: 'to', cid: a.cid, msg: { t: 'mode', mode: 'loco' } });
    h.json({ t: 'all', msg: { t: 'readout', text: 'to everyone' } });
    assert.deepEqual(await a.p.next('mode'), { t: 'mode', mode: 'loco' });
    assert.deepEqual(await a.p.next('readout'), { t: 'readout', text: 'to everyone' });
    assert.deepEqual(await b.p.next('readout'), { t: 'readout', text: 'to everyone' });
    assert.equal(b.p.count('mode'), 0); // the all went out after the to, so b would have had it by now
    assertOnce(a.p, b.p);
  });

  it('close {cid, code, reason, msg} sends msg then closes with that code', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const a = await phone(h, wsUrl()), b = await phone(h, wsUrl());
    h.json({ t: 'close', cid: a.cid, code: CLOSE_EVICTED, reason: 'judge', msg: { t: 'evicted', reason: 'judge' } });
    assert.deepEqual(await a.p.next('evicted'), { t: 'evicted', reason: 'judge' });
    assert.equal(await a.p.closed, CLOSE_EVICTED);
    assert.equal(a.p.reason, 'judge');
    assert.equal(a.p.log.at(-1).t, 'evicted'); // nothing after the msg
    h.json({ t: 'close', cid: b.cid, code: CLOSE_REPLACED, reason: 'replaced' });
    assert.equal(await b.p.closed, CLOSE_REPLACED);
    assert.equal(b.p.reason, 'replaced');
    const gone = [await h.next('gone'), await h.next('gone')].map((m) => m.cid).sort();
    assert.deepEqual(gone, [a.cid, b.cid].sort());
  });

  it('ignores a close with a code the host may not order', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const { p, cid } = await phone(h, wsUrl());
    for (const code of [CLOSE_HOST_REPLACED, CLOSE_BAD_HOST_TOKEN, 1006, 1009, 3000, 4999, String(CLOSE_EVICTED), null]) {
      h.json({ t: 'close', cid, code, reason: 'x', msg: { t: 'evicted', reason: 'x' } });
    }
    h.json({ t: 'close', code: CLOSE_EVICTED, reason: 'no cid' });
    h.json({ t: 'to', cid, msg: { t: 'readout', text: 'still open' } });
    assert.equal((await p.next('readout')).text, 'still open');
    assert.equal(p.count('evicted'), 0);
    assert.equal(p.readyState, WebSocket.OPEN);
  });

  it('stamps hello, here, in, panel and hbr with the cid, and a phone cannot speak as the host', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const { p, cid } = await phone(h, wsUrl()), other = await phone(h, wsUrl());
    p.json({ t: 'hello', token: 'abc', slot: 2, pid: 7 });
    p.json({ t: 'here', cid: 'forged' });
    p.json({ t: 'in', lx: -1, a: true, cid: other.cid });
    p.json({ t: 'panel', kind: 'lever', value: 42.5 });
    p.json({ t: 'hbr', ts: 123 });
    assert.deepEqual(await h.next('hello'), { t: 'hello', token: 'abc', slot: 2, cid });
    assert.deepEqual(await h.next('here'), { t: 'here', cid });
    assert.deepEqual(await h.next('in'), { t: 'in', lx: -1, a: 1, cid });
    assert.deepEqual(await h.next('panel'), { t: 'panel', kind: 'lever', value: 42.5, cid });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 123, cid });
    for (const m of [{ t: 'all', msg: { t: 'mode', mode: 'frozen' } }, { t: 'to', cid: other.cid, msg: { t: 'mode', mode: 'frozen' } },
      { t: 'close', cid: other.cid, code: CLOSE_EVICTED }, { t: 'open', cid: 'forged' }, { t: 'gone', cid: other.cid },
      { t: 'kick', pid: 1 }, { t: 'cap', max: 0 }, { t: 'hub' }]) p.json(m);
    p.json({ t: 'hbr', ts: 456 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 456, cid });
    h.json({ t: 'all', msg: { t: 'readout', text: 'sentinel' } });
    await other.p.next('readout');
    assert.equal(other.p.count('mode'), 0);
    assert.equal(other.p.readyState, WebSocket.OPEN);
    assert.deepEqual(h.log.map((m) => m.t), ['hub', 'open', 'open', 'hello', 'here', 'in', 'panel', 'hbr', 'hbr']);
  });

  it('sanitizes hostile phone values and survives hostile host values', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const { p, cid } = await phone(h, wsUrl());
    for (const raw of ['{', 'null', '[]', '"hello"', '5', '{"t":"in","lx":1e999,"a":0}']) p.raw(raw);
    p.json({ t: 'panel', kind: { toString: 1 }, value: { valueOf: 1 } });
    p.json({ t: 'hello', token: { toString: 1 }, slot: '3' });
    p.json({ t: 'hbr', ts: 'soon' });
    assert.deepEqual(await h.next('in'), { t: 'in', lx: 0, a: 0, cid });
    assert.deepEqual(await h.next('panel'), { t: 'panel', kind: '', value: 0, cid });
    assert.deepEqual(await h.next('hello'), { t: 'hello', token: null, slot: null, cid });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 0, cid });
    const bad = [{ t: 'to', cid: { toString: 1 }, msg: { t: 'x' } }, { t: 'to', cid, msg: 'str' }, { t: 'to', cid, msg: [{ t: 'x' }] },
      { t: 'to', cid, msg: null }, { t: 'to', cid: '__proto__', msg: { t: 'x' } }, { t: 'all', msg: null }, { t: 'all', msg: [{ t: 'x' }] },
      { t: 'close', cid, code: { valueOf: 1 } }, { t: 'close', cid: [cid], code: CLOSE_EVICTED }, { t: 'kick', pid: 1 }, { t: 'cap', max: { valueOf: 1 } }];
    for (const raw of ['{', 'null', '[]', '7', '"to"', ...bad.map((m) => JSON.stringify(m))]) h.raw(raw);
    h.json({ t: 'to', cid, msg: { t: 'readout', text: 'still here' } });
    assert.equal((await p.next('readout')).text, 'still here');
    assert.equal(p.count('x'), 0);
    // A long, multi-byte close reason is cut to fit a close frame (123 bytes).
    h.json({ t: 'close', cid, code: CLOSE_EVICTED, reason: '€'.repeat(200), msg: { t: 'evicted', reason: 'judge' } });
    assert.equal(await p.closed, CLOSE_EVICTED);
    assert.equal(p.reason, '€'.repeat(32));
    assert.equal(await status('/healthz'), 200);
  });

  it('closes a phone with 1009 over 1 KB but accepts a big host message', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const { p, cid } = await phone(h, wsUrl());
    const text = 'x'.repeat(2000);
    h.json({ t: 'all', msg: { t: 'readout', text } });
    assert.equal((await p.next('readout')).text, text);
    const base = { t: 'panel', kind: 'lever', value: 1, pad: '' };
    const exact = JSON.stringify({ ...base, pad: 'x'.repeat(PLAYER_MAX_PAYLOAD - JSON.stringify(base).length) });
    assert.equal(Buffer.byteLength(exact), PLAYER_MAX_PAYLOAD);
    p.raw(exact); // exactly 1 KB still passes
    assert.deepEqual(await h.next('panel'), { t: 'panel', kind: 'lever', value: 1, cid });
    p.raw(exact.replace('"pad":"', '"pad":"x'));
    assert.equal(await p.closed, 1009);
    assert.deepEqual(await h.next('gone'), { t: 'gone', cid });
  });

  it('passes at most 20 messages a second from one phone', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    const { p } = await phone(h, wsUrl());
    for (let i = 0; i < 3 * MSGS_PER_SEC; i++) p.json({ t: 'hbr', ts: i });
    await settle(1100); // the bucket refills every second
    p.json({ t: 'hbr', ts: -1 });
    while ((await h.next('hbr')).ts !== -1);
    const n = h.log.filter((m) => m.t === 'hbr' && m.ts >= 0).length;
    assert.ok(n >= MSGS_PER_SEC && n <= 2 * MSGS_PER_SEC, `${n} of ${3 * MSGS_PER_SEC} passed`); // a refill may land mid-burst
  });

  it('refuses a phone socket past 12 in one room with 1013, and another room still has room', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    for (let i = 0; i < MAX_SOCKETS; i++) await phone(h, wsUrl());
    const extra = client(inRoom(wsUrl()));
    assert.equal(await extra.closed, 1013);
    assert.equal(extra.reason, 'busy');
    assert.equal(h.count('open'), MAX_SOCKETS);
    const h2 = hostOf(wsUrl(), KEY2);
    await h2.next('hub');
    const other = await phone(h2, wsUrl(), ROOM2);
    assert.equal(other.p.readyState, WebSocket.OPEN);
  });

  it('rejects a bad or missing host key with 4003 and a phone without a room with 4004; HOST_TOKEN gates nothing', async () => {
    const bad = hostOf(wsUrl(), 'short');
    assert.equal(await bad.closed, CLOSE_BAD_HOST_TOKEN);
    assert.equal(bad.reason, 'host key');
    assert.equal(await client(`${wsUrl()}?role=host&host=test`).closed, CLOSE_BAD_HOST_TOKEN);
    const lost = client(wsUrl());
    assert.equal(await lost.closed, CLOSE_NO_ROOM);
    assert.equal(lost.reason, 'room');
    assert.equal(await client(`${wsUrl()}?room=nope`).closed, CLOSE_NO_ROOM);
    // The hub runs with a HOST_TOKEN of 'test', and a key with no token (or a wrong one) still hosts.
    const h = client(`${wsUrl()}?role=host&key=${KEY}&host=wrong`);
    assert.equal((await h.next('hub')).room, ROOM);
  });

  it('closes the first host with 4000 when a second connects, and routes to the second', async () => {
    const h1 = hostOf(wsUrl());
    await h1.next('hub');
    const { p, cid } = await phone(h1, wsUrl());
    const h2 = hostOf(wsUrl());
    assert.equal(await h1.closed, CLOSE_HOST_REPLACED);
    await h2.next('hub');
    p.json({ t: 'hbr', ts: 5 });
    assert.deepEqual(await h2.next('hbr'), { t: 'hbr', ts: 5, cid });
    h2.json({ t: 'to', cid, msg: { t: 'mode', mode: 'walk' } });
    assert.deepEqual(await p.next('mode'), { t: 'mode', mode: 'walk' });
    assert.equal(h1.count('hbr'), 0);
  });

  it('accepts the legacy /ws path and refuses any other', async () => {
    const h = hostOf(wsUrl('/ws'));
    await h.next('hub');
    const { cid } = await phone(h, wsUrl('/ws'));
    assert.equal(typeof cid, 'string');
    for (const path of ['/', '/nope', '/api/wsx', '/ws/x']) assert.match(await client(wsUrl(path)).failed, /401/, path);
    assert.equal(h.count('open'), 1);
  });

  it('serves /healthz with CORS and /host without a token', async () => {
    const h = hostOf(wsUrl());
    await h.next('hub');
    await phone(h, wsUrl());
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.host, 1);
    assert.equal(j.sockets, 1);
    assert.equal(j.region, 'local');
    assert.equal(j.joinUrl, `http://10.1.2.3:${port}/`);
    assert.equal(typeof j.uptime, 'number');
    assert.equal(typeof j.instance, 'string');
    const h2 = hostOf(wsUrl(), KEY2); // a second room: the numbers are totals
    await h2.next('hub');
    await phone(h2, wsUrl(), ROOM2);
    const k = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(k.host, 2);
    assert.equal(k.sockets, 2);
    for (const q of ['', '?host=', '?host=wrong', '?host=test']) assert.notEqual(await status('/host' + q), 403, q);
  });

  // hub.js verifyClient parses req.url; one bad target must not end the process for every socket.
  it('survives a malformed request target', async () => {
    await rawUpgrade(port, '//[');
    await settle(300);
    assert.equal(hub.exitCode, null, 'hub.js exited');
    assert.equal(await status('/healthz'), 200);
  });
});

// ---- two relays on one broker: two Vercel instances sharing Redis ----
async function relayServer(bus) {
  const relay = createRelay({ bus, info: () => ({ region: 'test' }) });
  const server = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  wss.on('connection', relay.connection);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    relay,
    port: server.address().port,
    url: `ws://127.0.0.1:${server.address().port}${WS_PATH}`,
    async close() {
      relay.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((res) => wss.close(() => res()));
      server.closeAllConnections?.();
      await new Promise((res) => server.close(() => res()));
    },
  };
}

describe('relay: two instances on one bus', () => {
  let A, B;
  beforeEach(async () => { const broker = createBroker(); A = await relayServer(broker.bus()); B = await relayServer(broker.bus()); });
  afterEach(async () => { await A.close(); await B.close(); });

  it('routes between a host on A and phones on A and B, each message exactly once', async () => {
    const h = hostOf(A.url);
    await h.next('hub');
    const a = await phone(h, A.url), b = await phone(h, B.url);
    assert.notEqual(a.cid, b.cid);
    b.p.json({ t: 'hello', token: null, slot: 1 });
    assert.deepEqual(await h.next('hello'), { t: 'hello', token: null, slot: 1, cid: b.cid });
    a.p.json({ t: 'hello', token: null, slot: 2 });
    assert.deepEqual(await h.next('hello'), { t: 'hello', token: null, slot: 2, cid: a.cid });
    h.json({ t: 'to', cid: b.cid, msg: { t: 'welcome', pid: 1 } });
    h.json({ t: 'to', cid: a.cid, msg: { t: 'welcome', pid: 2 } });
    assert.deepEqual(await b.p.next('welcome'), { t: 'welcome', pid: 1 });
    assert.deepEqual(await a.p.next('welcome'), { t: 'welcome', pid: 2 });
    h.json({ t: 'all', msg: { t: 'mode', mode: 'walk' } });
    assert.deepEqual(await a.p.next('mode'), { t: 'mode', mode: 'walk' });
    assert.deepEqual(await b.p.next('mode'), { t: 'mode', mode: 'walk' });
    for (let i = 0; i < 5; i++) { a.p.json({ t: 'hbr', ts: i }); b.p.json({ t: 'hbr', ts: 100 + i }); }
    for (let i = 0; i < 10; i++) await h.next('hbr');
    // A close for B's phone crosses the bus: its msg first, then the code.
    h.json({ t: 'close', cid: b.cid, code: CLOSE_EVICTED, reason: 'judge', msg: { t: 'evicted', reason: 'judge' } });
    assert.deepEqual(await b.p.next('evicted'), { t: 'evicted', reason: 'judge' });
    assert.equal(await b.p.closed, CLOSE_EVICTED);
    assert.deepEqual(await h.next('gone'), { t: 'gone', cid: b.cid });
    await settle();
    assertOnce(h, a.p, b.p);
    assert.equal(h.count('open'), 2);
    assert.equal(h.count('hello'), 2);
    assert.equal(h.count('hbr'), 10);
    assert.equal(h.count('gone'), 1);
    for (const p of [a.p, b.p]) { assert.equal(p.count('welcome'), 1); assert.equal(p.count('mode'), 1); }
    assert.equal(a.p.count('evicted'), 0);
    assert.deepEqual(A.relay.stats(), { instance: A.relay.instance, host: 1, sockets: 1 });
    assert.deepEqual(B.relay.stats(), { instance: B.relay.instance, host: 0, sockets: 0 });
  });

  it('a host connecting on B closes the host on A with 4000, then gets every phone message once', async () => {
    const h1 = hostOf(A.url);
    await h1.next('hub');
    const a = await phone(h1, A.url), b = await phone(h1, B.url);
    const h2 = hostOf(B.url);
    await h2.next('hub');
    assert.equal(await h1.closed, CLOSE_HOST_REPLACED);
    a.p.json({ t: 'hbr', ts: 1 });
    b.p.json({ t: 'hbr', ts: 2 });
    const got = [await h2.next('hbr'), await h2.next('hbr')].sort((x, y) => x.ts - y.ts);
    assert.deepEqual(got, [{ t: 'hbr', ts: 1, cid: a.cid }, { t: 'hbr', ts: 2, cid: b.cid }]);
    h2.json({ t: 'to', cid: a.cid, msg: { t: 'near', plaque: 'loco' } });
    h2.json({ t: 'all', msg: { t: 'mode', mode: 'reset' } });
    assert.deepEqual(await a.p.next('near'), { t: 'near', plaque: 'loco' });
    await a.p.next('mode');
    await b.p.next('mode');
    const c = await phone(h2, A.url); // a phone opening on A now is announced to the host on B
    a.p.close();
    assert.deepEqual(await h2.next('gone'), { t: 'gone', cid: a.cid });
    await settle();
    assertOnce(h1, h2, a.p, b.p, c.p);
    assert.equal(h1.count('hbr'), 0);
    assert.equal(h2.count('hbr'), 2);
    assert.equal(h2.count('open'), 1);
    assert.equal(h2.count('gone'), 1);
    assert.equal(b.p.count('near'), 0);
    assert.equal(A.relay.stats().host, 0);
    assert.equal(B.relay.stats().host, 1);
  });

  it('drops phone messages while no host is connected anywhere, and delivers once one connects', async () => {
    const p = client(inRoom(B.url));
    await p.opened;
    p.json({ t: 'hbr', ts: 1 });
    await settle(50);
    const h = hostOf(A.url);
    await h.next('hub');
    p.json({ t: 'hbr', ts: 2 });
    const m = await h.next('hbr');
    assert.equal(m.ts, 2);
    assert.equal(typeof m.cid, 'string');
    await settle();
    assert.equal(h.count('hbr'), 1);
    assert.equal(h.count('open'), 0); // its open went nowhere: the host's who / here covers that
  });

  it('closes an upgrade with an unparsable request target (1008) and keeps serving', async () => {
    assert.deepEqual(await rawUpgrade(A.port, '//['), { status: 'HTTP/1.1 101 Switching Protocols', close: 1008 });
    const h = hostOf(A.url);
    await h.next('hub');
    const { p, cid } = await phone(h, A.url);
    p.json({ t: 'hbr', ts: 7 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 7, cid });
  });
});

// ---- Redis cost and host tie-break (review fixes) ----
describe('relay: bus economy and host tie-break', () => {
  let A, B, broker, sent;
  beforeEach(async () => {
    broker = createBroker(); sent = [];
    const bus = broker.bus();
    // A's bus counts publishes: each one is a Redis command on Vercel.
    A = await relayServer({ ...bus, publish(ch, m) { sent.push(ch); bus.publish(ch, m); } });
    B = await relayServer(broker.bus());
  });
  afterEach(async () => { await A.close(); await B.close(); });

  it('a phone on the host\'s own instance reaches it without a bus publish', async () => {
    const h = hostOf(A.url);
    await h.next('hub');
    const { p, cid } = await phone(h, A.url);
    for (let i = 0; i < 5; i++) p.json({ t: 'in', lx: 1, a: 0 });
    for (let i = 0; i < 5; i++) assert.deepEqual(await h.next('in'), { t: 'in', lx: 1, a: 0, cid });
    assert.deepEqual(sent.filter((ch) => ch === `tt:${ROOM}:host`), []);
  });

  it('a phone on another instance still reaches the host through the bus', async () => {
    const h = hostOf(B.url);
    await h.next('hub');
    const { p, cid } = await phone(h, A.url);
    p.json({ t: 'hbr', ts: 3 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 3, cid });
    assert.ok(sent.includes(`tt:${ROOM}:host`));
  });

  it('an older host\'s claim does not close a newer host', async () => {
    const h = hostOf(B.url);
    await h.next('hub');
    broker.bus().publish(`tt:${ROOM}:ctl`, { t: 'host', hid: 'zzz', at: 1, o: 'elsewhere' }); // a claim from long ago
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.readyState, 1);
    broker.bus().publish(`tt:${ROOM}:ctl`, { t: 'host', hid: 'zzz', at: Date.now() + 1000, o: 'elsewhere' }); // a newer one
    assert.equal(await h.closed, CLOSE_HOST_REPLACED);
  });

  it('the relay hb names its instance', async () => {
    const h = hostOf(A.url);
    await h.next('hub');
    const { p } = await phone(h, A.url);
    const hb = await p.next('hb');
    assert.equal(hb.i, A.relay.instance);
  });
});

// ---- rooms: two TVs on the same two instances ----
// A bus that logs the relay's subscribe and unsubscribe calls, each as [op, ...channels].
const logged = (bus, log) => ({
  ...bus,
  subscribe(...chs) { log.push(['sub', ...chs]); return bus.subscribe(...chs); },
  unsubscribe(...chs) { log.push(['unsub', ...chs]); return bus.unsubscribe(...chs); },
});
const ops = (log) => log.map(([op, ch]) => `${op} ${ch.split(':')[1]}`);
const roomChannels = (room) => [`tt:${room}:host`, `tt:${room}:phones`, `tt:${room}:ctl`];

describe('relay: rooms on two instances', () => {
  let A, B, logA, logB;
  beforeEach(async () => {
    const broker = createBroker(); logA = []; logB = [];
    A = await relayServer(logged(broker.bus(), logA)); B = await relayServer(logged(broker.bus(), logB));
  });
  afterEach(async () => { await A.close(); await B.close(); });

  it('keeps rooms apart: a host\'s to, all and close reach only its own room\'s phones, on either instance', async () => {
    const h1 = hostOf(A.url), h2 = hostOf(B.url, KEY2);
    assert.equal((await h1.next('hub')).room, ROOM);
    assert.equal((await h2.next('hub')).room, ROOM2);
    const a1 = await phone(h1, A.url), b1 = await phone(h1, B.url);
    const a2 = await phone(h2, A.url, ROOM2), b2 = await phone(h2, B.url, ROOM2);
    for (const x of [a2, b2]) { // host 1 aims at room 2's phones
      h1.json({ t: 'to', cid: x.cid, msg: { t: 'mode', mode: 'walk' } });
      h1.json({ t: 'close', cid: x.cid, code: CLOSE_EVICTED, reason: 'judge', msg: { t: 'evicted', reason: 'judge' } });
    }
    h1.json({ t: 'all', msg: { t: 'readout', text: 'room 1' } });
    h1.json({ t: 'to', cid: b1.cid, msg: { t: 'near', label: 'loco' } });
    assert.equal((await a1.p.next('readout')).text, 'room 1');
    assert.equal((await b1.p.next('readout')).text, 'room 1');
    assert.equal((await b1.p.next('near')).label, 'loco');
    a1.p.json({ t: 'hbr', ts: 11 }); b1.p.json({ t: 'hbr', ts: 12 });
    a2.p.json({ t: 'hbr', ts: 21 }); b2.p.json({ t: 'hbr', ts: 22 });
    assert.deepEqual([await h1.next('hbr'), await h1.next('hbr')].map((m) => m.ts).sort(), [11, 12]);
    assert.deepEqual([await h2.next('hbr'), await h2.next('hbr')].map((m) => m.ts).sort(), [21, 22]);
    h2.json({ t: 'all', msg: { t: 'readout', text: 'room 2' } });
    await a2.p.next('readout');
    await b2.p.next('readout');
    a1.p.close();
    assert.deepEqual(await h1.next('gone'), { t: 'gone', cid: a1.cid });
    await settle();
    for (const x of [a2, b2]) {
      assert.equal(x.p.readyState, WebSocket.OPEN);
      assert.deepEqual(x.p.log.filter((m) => m.t !== 'hb'), [{ t: 'readout', text: 'room 2' }]);
    }
    for (const x of [a1, b1]) assert.deepEqual(x.p.log.filter((m) => m.t === 'readout'), [{ t: 'readout', text: 'room 1' }]);
    assert.deepEqual(h1.log.map((m) => m.t).sort(), ['gone', 'hbr', 'hbr', 'hub', 'open', 'open']);
    assert.deepEqual(h2.log.map((m) => m.t).sort(), ['hbr', 'hbr', 'hub', 'open', 'open']);
    assertOnce(h1, h2, a1.p, b1.p, a2.p, b2.p);
  });

  it('a phone that knows the room cannot host it: no key is 4003, any other key is another room', async () => {
    const h = hostOf(A.url);
    await h.next('hub');
    const { p, cid } = await phone(h, B.url);
    assert.equal(await client(`${B.url}?role=host&room=${ROOM}`).closed, CLOSE_BAD_HOST_TOKEN);
    assert.equal(await client(`${B.url}?role=host&key=${ROOM}`).closed, CLOSE_BAD_HOST_TOKEN); // a room is too short to be a key
    const thief = hostOf(B.url, ROOM + ROOM.slice(0, 6));
    assert.notEqual((await thief.next('hub')).room, ROOM);
    thief.json({ t: 'all', msg: { t: 'mode', mode: 'frozen' } });
    thief.json({ t: 'close', cid, code: CLOSE_EVICTED, reason: 'x' });
    thief.json({ t: 'to', cid, msg: { t: 'mode', mode: 'frozen' } });
    h.json({ t: 'to', cid, msg: { t: 'readout', text: 'mine' } });
    assert.equal((await p.next('readout')).text, 'mine');
    p.json({ t: 'hbr', ts: 9 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', ts: 9, cid });
    await settle();
    assert.equal(h.readyState, WebSocket.OPEN);
    assert.equal(p.readyState, WebSocket.OPEN);
    assert.equal(p.count('mode'), 0);
    assert.deepEqual(thief.log.map((m) => m.t), ['hub']);
  });

  it('two keys host side by side; the same key in a second tab replaces the first as before', async () => {
    const h1 = hostOf(A.url), h2 = hostOf(A.url, KEY2);
    await h1.next('hub'); await h2.next('hub');
    await settle(20); // a later connect time, so the newest tab is unambiguous
    const h3 = hostOf(B.url, KEY2); // room 2's second tab, on the other instance
    await h3.next('hub');
    assert.equal(await h2.closed, CLOSE_HOST_REPLACED);
    await settle(20);
    const h4 = hostOf(A.url, KEY2); // and a third, back on the first instance
    await h4.next('hub');
    assert.equal(await h3.closed, CLOSE_HOST_REPLACED);
    await settle();
    assert.equal(h1.readyState, WebSocket.OPEN);
    assert.equal(h4.readyState, WebSocket.OPEN);
    const { p, cid } = await phone(h1, B.url);
    const q = await phone(h4, B.url, ROOM2);
    p.json({ t: 'hbr', ts: 1 });
    q.p.json({ t: 'hbr', ts: 2 });
    assert.deepEqual(await h1.next('hbr'), { t: 'hbr', ts: 1, cid });
    assert.deepEqual(await h4.next('hbr'), { t: 'hbr', ts: 2, cid: q.cid });
    await settle();
    assert.equal(h1.count('open') + h1.count('hbr'), 2);
    assert.equal(h4.count('open') + h4.count('hbr'), 2);
    assert.deepEqual(A.relay.stats(), { instance: A.relay.instance, host: 2, sockets: 0 });
    assert.deepEqual(B.relay.stats(), { instance: B.relay.instance, host: 0, sockets: 2 });
  });

  it('an instance subscribes to a room with its first socket there and unsubscribes with its last', async () => {
    const h = hostOf(B.url);
    await h.next('hub');
    assert.deepEqual(logB, [['sub', ...roomChannels(ROOM)]]);
    const p1 = await phone(h, A.url), p2 = await phone(h, A.url);
    const r2 = client(inRoom(A.url, ROOM2));
    await r2.opened;
    await settle(50);
    assert.deepEqual(logA, [['sub', ...roomChannels(ROOM)], ['sub', ...roomChannels(ROOM2)]]);
    const closeOf = async (ws) => { ws.close(); await ws.closed; await settle(50); };
    await closeOf(p1.p);
    assert.deepEqual(ops(logA), [`sub ${ROOM}`, `sub ${ROOM2}`]);
    await closeOf(p2.p);
    assert.deepEqual(logA.at(-1), ['unsub', ...roomChannels(ROOM)]);
    const p3 = await phone(h, A.url); // the room comes back: subscribed afresh
    await closeOf(r2);
    await closeOf(p3.p);
    assert.deepEqual(ops(logA), [`sub ${ROOM}`, `sub ${ROOM2}`, `unsub ${ROOM}`, `sub ${ROOM}`, `unsub ${ROOM2}`, `unsub ${ROOM}`]);
    assert.deepEqual(A.relay.stats(), { instance: A.relay.instance, host: 0, sockets: 0 });
    for (const url of [A.url, inRoom(A.url, 'short'), `${A.url}?role=host&key=short`]) await client(url).closed; // refused sockets
    assert.equal(logA.length, 6);
    assert.deepEqual(ops(logB), [`sub ${ROOM}`]);
    await closeOf(h);
    assert.deepEqual(ops(logB), [`sub ${ROOM}`, `unsub ${ROOM}`]);
  });

  it('closes a malformed room with 4004 and a malformed key with 4003, and accepts a 64-character key', async () => {
    for (const url of [A.url, inRoom(A.url, ''), inRoom(A.url, ROOM.slice(1)), inRoom(A.url, ROOM + 'x'), inRoom(A.url, ROOM.slice(1) + '.')]) {
      const ws = client(url);
      assert.equal(await ws.closed, CLOSE_NO_ROOM, url);
      assert.equal(ws.reason, 'room');
    }
    for (const key of ['', 'a'.repeat(21), 'a'.repeat(65), 'a'.repeat(21) + '.', 'a'.repeat(21) + '%2B']) {
      const ws = client(`${A.url}?role=host&key=${key}`);
      assert.equal(await ws.closed, CLOSE_BAD_HOST_TOKEN, key);
      assert.equal(ws.reason, 'host key');
    }
    const long = 'Z_-9'.repeat(16);
    assert.equal((await hostOf(B.url, long).next('hub')).room, roomOf(long));
  });
});

// ---- limits: anyone may host, so hosts and rooms are bounded too ----
describe('relay: host and room limits', () => {
  let A;
  beforeEach(async () => { A = await relayServer(createBroker().bus()); });
  afterEach(async () => { await A.close(); });

  it('passes at most 200 messages a second from one host', async () => {
    const h = hostOf(A.url);
    await h.next('hub');
    const { p, cid } = await phone(h, A.url);
    for (let i = 0; i < 3 * HOST_MSGS_PER_SEC; i++) h.json({ t: 'to', cid, msg: { t: 'readout', text: String(i) } });
    await settle(1100); // the bucket refills every second
    h.json({ t: 'to', cid, msg: { t: 'readout', text: 'last' } });
    while ((await p.next('readout')).text !== 'last');
    const n = p.count('readout') - 1;
    assert.ok(n >= HOST_MSGS_PER_SEC && n <= 2 * HOST_MSGS_PER_SEC, `${n} of ${3 * HOST_MSGS_PER_SEC} passed`); // a refill may land mid-burst
    // The refill gives a host its own rate back, not a phone's.
    const before = p.count('readout');
    for (let i = 0; i < 3 * HOST_MSGS_PER_SEC; i++) h.json({ t: 'to', cid, msg: { t: 'readout', text: 'b' + i } });
    await settle(1100);
    h.json({ t: 'to', cid, msg: { t: 'readout', text: 'end' } });
    while ((await p.next('readout')).text !== 'end');
    assert.ok(p.count('readout') - before - 1 > MSGS_PER_SEC, `second burst: ${p.count('readout') - before - 1} passed`);
  });

  it('refuses a new room past 64 on one instance with 1013, while a room it holds still takes sockets', async () => {
    const roomN = (i) => 'r' + String(i).padStart(15, '0');
    const held = [];
    for (let i = 0; i < MAX_ROOMS; i++) { const ws = client(inRoom(A.url, roomN(i))); await ws.opened; held.push(ws); }
    for (const url of [inRoom(A.url, roomN(MAX_ROOMS)), `${A.url}?role=host&key=${KEY}`]) {
      const ws = client(url);
      assert.equal(await ws.closed, 1013, url);
      assert.equal(ws.reason, 'busy');
    }
    const again = client(inRoom(A.url, roomN(0)));
    await again.opened;
    await settle(50);
    assert.equal(again.readyState, WebSocket.OPEN);
    held[1].close(); await held[1].closed; await settle(50); // a room that empties frees its place
    const h = hostOf(A.url);
    assert.equal((await h.next('hub')).room, ROOM);
  });
});

// ---- a slow or failing SUBSCRIBE (Redis on Vercel) ----
describe('relay: room subscription timing', () => {
  it('a failed subscribe closes the socket with 1013; the next one subscribes again, and what it says first waits', async () => {
    const broker = createBroker(), base = broker.bus();
    let fails = 1;
    const slow = { ...base, subscribe(...chs) {
      if (fails-- > 0) return Promise.reject(new Error('redis down'));
      return settle(100).then(() => base.subscribe(...chs));
    } };
    const S = await relayServer(slow), H = await relayServer(broker.bus());
    try {
      const h = hostOf(H.url);
      await h.next('hub');
      const first = client(inRoom(S.url));
      assert.equal(await first.closed, 1013);
      assert.equal(first.reason, 'relay not ready');
      await settle(50);
      const p = client(inRoom(S.url));
      p.json({ t: 'hello', token: null, slot: 4 }); // sent on open, while the room is still subscribing
      const { cid } = await h.next('open');
      assert.deepEqual(await h.next('hello'), { t: 'hello', token: null, slot: 4, cid });
      h.json({ t: 'to', cid, msg: { t: 'welcome', pid: 1 } });
      assert.deepEqual(await p.next('welcome'), { t: 'welcome', pid: 1 });
      assert.deepEqual(h.log.map((m) => m.t), ['hub', 'open', 'hello']);
    } finally { await S.close(); await H.close(); }
  });
});
