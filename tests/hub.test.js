// Integration tests for hub.js: a fresh hub child per test, driven by real ws clients.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = new URL('..', import.meta.url);
const SLOTS = JSON.parse(fs.readFileSync(new URL('src/shared/slots.json', ROOT), 'utf8'));
const ORIGIN = 'https://example.vercel.app';
let hub, port;

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

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
    hub.on('exit', (code) => rej(new Error(`hub exited ${code}: ${err}`)));
  });
}

// A ws client with an inbox: next(...types) resolves with the next message of one of those types.
function client(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const inbox = [], waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.ts.includes(m.t));
    if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m);
  });
  ws.on('error', () => {});
  ws.closed = new Promise((res) => ws.on('close', (code) => res(code)));
  ws.json = (m) => (ws.readyState === 1 ? ws.send(JSON.stringify(m)) : ws.once('open', () => ws.send(JSON.stringify(m))));
  ws.next = (...ts) => {
    const i = inbox.findIndex((m) => ts.includes(m.t));
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { ts, res: (m) => { clearTimeout(timer); res(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout waiting for ${ts}`)); }, 3000);
      waiters.push(w);
    });
  };
  // Message types received so far, in order, for sequence checks.
  ws.types = () => inbox.map((m) => m.t);
  return ws;
}
const hostClient = (token = 'test') => client(`?role=host&host=${token}`);
async function join(slot, token = null) {
  const p = client();
  p.json({ t: 'hello', token, slot });
  const m = await p.next('welcome', 'full');
  return { p, w: m.t === 'welcome' ? m : null };
}

describe('hub', () => {
  beforeEach(startHub);
  afterEach(async () => { if (hub.exitCode !== null) return; const exited = new Promise((r) => hub.once('exit', r)); hub.kill(); await exited; });

  it('sends lobby with all free slots on connect', async () => {
    const p = client();
    assert.deepEqual((await p.next('lobby')).free, [0, 1, 2, 3, 4, 5]);
  });

  it('honours hello.slot and re-sends lobby to un-joined sockets', async () => {
    const watcher = client();
    await watcher.next('lobby');
    const { w } = await join(3);
    assert.equal(w.slot, 3);
    assert.equal(w.color, SLOTS[3].color);
    assert.equal(w.name, SLOTS[3].name);
    assert.equal(typeof w.token, 'string');
    assert.equal(typeof w.pid, 'number');
    assert.deepEqual((await watcher.next('lobby')).free, [0, 1, 2, 4, 5]);
  });

  it('answers full to the 7th hello', async () => {
    const used = new Set();
    for (let i = 0; i < 6; i++) { const { w } = await join(); assert.ok(w); used.add(w.slot); }
    assert.equal(used.size, 6);
    const p = client();
    p.json({ t: 'hello', token: null });
    assert.deepEqual(await p.next('full'), { t: 'full' });
  });

  it('honours host cap for new tokens but not for token reconnects', async () => {
    const watcher = client();
    await watcher.next('lobby');
    const h = hostClient();
    await h.next('hub');
    h.json({ t: 'cap', max: 2 });
    await watcher.next('lobby');   // cap change re-broadcasts the lobby, so the hub has applied it
    const a = await join(0), b = await join(1);
    assert.ok(a.w && b.w);
    assert.deepEqual((await watcher.next('lobby')).free, [1, 2, 3, 4, 5]);
    assert.deepEqual((await watcher.next('lobby')).free, []);
    const c = await join(2);
    assert.equal(c.w, null);
    a.p.close();
    await h.next('away');
    const again = await join(null, a.w.token);
    assert.equal(again.w.pid, a.w.pid);
  });

  it('sends the host a hub message with joinUrl', async () => {
    const h = hostClient();
    const m = await h.next('hub');
    assert.equal(m.joinUrl, `http://10.1.2.3:${port}/`);
    assert.equal(m.lanIp, '10.1.2.3');
    assert.equal(m.region, 'local');
    assert.equal(typeof m.boot, 'string');
    assert.deepEqual(m.wifi, { ssid: 'Hotspot', pass: 'pw' });
  });

  it('replays joins when the host reconnects and closes the old host with 4000', async () => {
    const h1 = hostClient();
    await h1.next('hub');
    const { w } = await join(2);
    assert.equal((await h1.next('join')).pid, w.pid);
    const h2 = hostClient();
    assert.equal(await h1.closed, 4000);
    await h2.next('hub');
    assert.deepEqual(await h2.next('join'), { t: 'join', pid: w.pid, name: SLOTS[2].name, color: SLOTS[2].color });
  });

  it('sends in-zero then away on close, back then join on token reconnect', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(4);
    await h.next('join');
    p.close();
    await h.next('away');
    assert.deepEqual(h.types().filter((t) => t !== 'stats'), ['in']);
    assert.deepEqual(await h.next('in'), { t: 'in', pid: w.pid, lx: 0, a: 0 });
    const again = await join(0, w.token);
    assert.equal(again.w.pid, w.pid);
    assert.equal(again.w.slot, 4);   // slot preference ignored on a token reconnect
    assert.deepEqual(await h.next('back'), { t: 'back', pid: w.pid });
    await h.next('join');
    assert.deepEqual(h.types().filter((t) => t !== 'stats'), []);
  });

  it('a token reconnect over a still-open socket replaces it without away', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(2);
    await h.next('join');
    const again = await join(null, w.token);
    assert.equal(again.w.pid, w.pid);
    assert.equal(await p.closed, 1000);
    await h.next('join');
    again.p.json({ t: 'hbr', ts: 1 });
    await h.next('hbr');   // the new socket is the live one
    assert.deepEqual(h.types().filter((t) => t !== 'stats'), []);
  });

  it('kick sends evicted then closes 4001 and tells the host leave', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(1);
    await h.next('join');
    h.json({ t: 'kick', pid: w.pid, reason: 'judge' });
    assert.deepEqual(await p.next('evicted'), { t: 'evicted', reason: 'judge' });
    assert.equal(await p.closed, 4001);
    assert.deepEqual(await h.next('leave'), { t: 'leave', pid: w.pid });
  });

  it('a kicked token is evicted again, even if the phone was away at the kick', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(2);
    await h.next('join');
    p.close();
    await h.next('away');
    h.json({ t: 'kick', pid: w.pid, reason: 'judge' });
    await h.next('leave');
    const again = client();
    again.json({ t: 'hello', token: w.token, slot: 2 });
    assert.deepEqual(await again.next('evicted'), { t: 'evicted', reason: 'judge' });
    assert.equal(await again.closed, 4001);
    assert.deepEqual(h.types().filter((t) => t !== 'stats' && t !== 'in'), []);
  });

  it('survives hostile player and host values', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(0);
    await h.next('join');
    for (const m of [{ t: 'panel', kind: { toString: 1 } }, { t: 'panel', kind: [{ toString: 1 }] },
      { t: 'in', lx: { valueOf: 1, toString: 1 } }, { t: 'in', lx: [{ toString: 1 }] }]) p.json(m);
    p.json({ t: 'hbr', ts: 1 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', pid: w.pid, ts: 1 });   // processed in order, hub still up
    assert.equal((await h.next('panel')).kind, '');
    assert.equal((await h.next('in')).lx, 0);
    h.json({ t: 'kick', pid: w.pid, reason: { toString: 1 } });
    assert.deepEqual(await p.next('evicted'), { t: 'evicted', reason: 'judge' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  });

  it('closes a player with 1009 over 1 KB but accepts a big host message', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p } = await join(0);
    const text = 'x'.repeat(2000);
    h.json({ t: 'all', msg: { t: 'readout', text } });
    assert.equal((await p.next('readout')).text, text);
    p.json({ t: 'panel', kind: 'lever', value: 1, pad: text });
    assert.equal(await p.closed, 1009);
  });

  it('rejects a bad host token with 4003', async () => {
    assert.equal(await hostClient('wrong').closed, 4003);
  });

  it('forwards hbr with pid', async () => {
    const h = hostClient();
    await h.next('hub');
    const { p, w } = await join(5);
    p.json({ t: 'hbr', ts: 123 });
    assert.deepEqual(await h.next('hbr'), { t: 'hbr', pid: w.pid, ts: 123 });
  });

  it('serves /healthz with CORS and guards /host', async () => {
    await join(0);
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    const j = await r.json();
    for (const k of ['ok', 'players', 'slots', 'host', 'uptime', 'reconnects', 'joinsTotal', 'region', 'joinUrl', 'cap']) assert.ok(k in j, k);
    assert.equal(j.ok, true);
    assert.equal(j.players, 1);
    assert.equal(j.joinsTotal, 1);
    assert.equal(j.cap, 6);
    assert.equal((await fetch(`http://127.0.0.1:${port}/host`)).status, 403);
  });
});
