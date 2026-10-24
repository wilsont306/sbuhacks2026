// Unit tests for src/host/slots.js, the seats the host tab owns: a fake clock (the timers and now options), a fixed
// token generator and recorded send / close / emit calls, so holds, kicks, the phone rollover and a host reload are
// checked without a relay. Ported from the old stateful hub's tests (hub.test.js) where the behaviour moved here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSlots } from '../src/host/slots.js';
import { MAX_PLAYERS, SLOT_HOLD_MS as HOLD, CLOSE_EVICTED, CLOSE_REPLACED } from '../src/shared/protocol.js';

const SLOTS = JSON.parse(fs.readFileSync(new URL('../src/shared/slots.json', import.meta.url), 'utf8'));
const RESTORE_MS = 10 * 60 * 1000; // slots.js: a save older than this restores only the kicked tokens

// setTimeout / clearTimeout on a clock that moves only in advance(); due timers fire in time order.
function fakeClock(t = 1_700_000_000_000) {
  const due = new Map();
  let id = 0;
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { due.set(++id, { at: t + ms, fn }); return id; },
      clearTimeout: (h) => { due.delete(h); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const e of due) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        due.delete(next[0]); t = next[1].at; next[1].fn();
      }
      t = end;
    },
  };
}

const memStore = (v = null) => ({ v, get() { return this.v; }, set(x) { this.v = x; } });

// One seats instance with everything it says recorded. Tokens are tok1, tok2, ... (shared across a reload via `tokens`).
function seats({ clock = fakeClock(), store = null, tokens = { n: 0 } } = {}) {
  const h = { clock, sent: [], closes: [], events: [] };
  h.s = createSlots({
    slots: SLOTS, max: MAX_PLAYERS, holdMs: HOLD, store, timers: clock.timers, now: clock.now,
    token: () => `tok${++tokens.n}`,
    send: (cid, msg) => h.sent.push({ cid, msg }),
    close: (cid, code, reason, msg) => h.closes.push({ cid, code, reason, msg }),
    emit: (e) => h.events.push(e),
  });
  return h;
}
// Drain what was sent to one cid, the emitted events, or the close orders.
function inbox(h, cid) {
  const out = [];
  for (let i = 0; i < h.sent.length;) if (h.sent[i].cid === cid) out.push(h.sent.splice(i, 1)[0].msg); else i++;
  return out;
}
const events = (h) => h.events.splice(0);
const closes = (h) => h.closes.splice(0);
// Open a socket and say hello; returns the welcome (or full) it got.
function join(h, cid, slot = null, token = null) {
  h.s.open(cid);
  h.s.message(cid, { t: 'hello', token, slot });
  return inbox(h, cid).find((m) => m.t === 'welcome' || m.t === 'full');
}
const welcomeOf = (pid, token, i) => ({ t: 'welcome', pid, token, color: SLOTS[i].color, name: SLOTS[i].name, slot: i });
const joinOf = (w) => ({ t: 'join', pid: w.pid, name: w.name, color: w.color });
const evicted = (cid, reason) => ({ cid, code: CLOSE_EVICTED, reason, msg: { t: 'evicted', reason } });

describe('slots: joining', () => {
  it('sends the lobby with every slot free on open', () => {
    const h = seats();
    h.s.open('c1');
    assert.deepEqual(inbox(h, 'c1'), [{ t: 'lobby', free: [0, 1, 2, 3, 4, 5] }]);
    assert.deepEqual(events(h), []);
  });

  it('honours hello.slot and re-sends the lobby to the other un-joined sockets only', () => {
    const h = seats();
    h.s.open('watch'); h.s.open('c1');
    inbox(h, 'watch'); inbox(h, 'c1');
    h.s.message('c1', { t: 'hello', token: null, slot: 3 });
    assert.deepEqual(inbox(h, 'c1'), [welcomeOf(1, 'tok1', 3)]);
    assert.deepEqual(inbox(h, 'watch'), [{ t: 'lobby', free: [0, 1, 2, 4, 5] }]);
    assert.deepEqual(events(h), [{ t: 'join', pid: 1, name: SLOTS[3].name, color: SLOTS[3].color }]);
    // A taken, out-of-range or missing slot falls back to the first free one.
    assert.equal(join(h, 'c2', 3).slot, 0);
    assert.equal(join(h, 'c3', 99).slot, 1);
    assert.equal(join(h, 'c4', -1).slot, 2);
    assert.equal(join(h, 'c5').slot, 4);
    assert.deepEqual(inbox(h, 'watch').at(-1), { t: 'lobby', free: [5] });
    assert.deepEqual(inbox(h, 'c1'), []); // a seated socket gets no lobby updates
  });

  it('answers full to the 7th hello, and that socket hears when a slot frees', () => {
    const h = seats();
    const ws = [1, 2, 3, 4, 5, 6].map((i) => join(h, 'c' + i));
    assert.ok(ws.every((w) => w.t === 'welcome'));
    assert.equal(new Set(ws.map((w) => w.slot)).size, 6);
    assert.equal(new Set(ws.map((w) => w.pid)).size, 6);
    assert.deepEqual(join(h, 'c7'), { t: 'full' });
    assert.deepEqual(h.s.stats(), { players: 6, seats: 6, joinsTotal: 6, reconnects: 0 });
    h.s.kick(ws[2].pid, 'idle');
    assert.deepEqual(inbox(h, 'c7'), [{ t: 'lobby', free: [ws[2].slot] }]);
  });

  it('applies the cap to new tokens but never to a token reconnect', () => {
    const h = seats();
    h.s.open('watch'); inbox(h, 'watch');
    h.s.setCap(2);
    assert.deepEqual(inbox(h, 'watch'), [{ t: 'lobby', free: [0, 1, 2, 3, 4, 5] }]);
    const a = join(h, 'a', 0), b = join(h, 'b', 1);
    assert.equal(a.t, 'welcome'); assert.equal(b.t, 'welcome');
    assert.deepEqual(inbox(h, 'watch'), [{ t: 'lobby', free: [1, 2, 3, 4, 5] }, { t: 'lobby', free: [] }]);
    assert.deepEqual(join(h, 'c', 2), { t: 'full' });
    h.s.gone('a');
    assert.deepEqual(join(h, 'a2', 5, a.token), a); // same pid, token and slot; the slot preference is ignored
    h.s.setCap(99); // clamped to max
    assert.deepEqual(inbox(h, 'watch').at(-1), { t: 'lobby', free: [2, 3, 4, 5] });
    h.s.setCap(-3);
    assert.deepEqual(inbox(h, 'watch').at(-1), { t: 'lobby', free: [] });
  });

  it('a repeated hello on the same socket re-welcomes the same seat, whatever token it carries', () => {
    const h = seats();
    const w = join(h, 'c1', 1), other = join(h, 'c2', 2);
    events(h);
    h.s.message('c1', { t: 'hello', token: w.token, slot: 1 });
    h.s.message('c1', { t: 'hello', token: null, slot: 5 });
    h.s.message('c1', { t: 'hello', token: other.token, slot: null }); // a bound socket cannot take another seat
    assert.deepEqual(inbox(h, 'c1'), [w, w, w]);
    assert.deepEqual(events(h), [joinOf(w), joinOf(w), joinOf(w)]);
    assert.deepEqual(closes(h), []);
    assert.deepEqual(inbox(h, 'c2'), []);
    assert.deepEqual(h.s.stats(), { players: 2, seats: 2, joinsTotal: 2, reconnects: 0 });
  });

  it('makes url-safe random tokens by default', () => {
    const toks = new Set();
    for (let i = 0; i < 6; i++) {
      const sent = [];
      const s = createSlots({ slots: SLOTS, max: MAX_PLAYERS, holdMs: HOLD, send: (cid, m) => sent.push(m), close() {}, emit() {} });
      s.message('c', { t: 'hello', token: null, slot: 0 });
      const tk = sent.find((m) => m.t === 'welcome').token;
      assert.match(tk, /^[A-Za-z0-9_-]{22}$/);
      toks.add(tk);
    }
    assert.equal(toks.size, 6);
  });
});

describe('slots: away, back and the rollover', () => {
  it('sends in-zero then away when a seat\'s socket goes, and back then join on its token reconnect', () => {
    const h = seats();
    const w = join(h, 'c1', 4);
    events(h);
    h.s.gone('c1');
    assert.deepEqual(events(h), [{ t: 'in', pid: w.pid, lx: 0, a: 0 }, { t: 'away', pid: w.pid }]);
    assert.equal(h.s.to(w.pid, { t: 'mode', mode: 'walk' }), false); // nothing is sent to an away seat
    h.s.message('c1', { t: 'in', lx: 1, a: 0 }); // late input from the closed socket
    assert.deepEqual(events(h), []);
    h.clock.advance(HOLD - 1);
    assert.deepEqual(join(h, 'c2', 0, w.token), welcomeOf(w.pid, w.token, 4));
    assert.deepEqual(events(h), [{ t: 'back', pid: w.pid }, joinOf(w)]);
    h.clock.advance(HOLD * 2);
    assert.deepEqual(events(h), []); // the hold was cleared
    assert.equal(h.s.to(w.pid, { t: 'near', plaque: null }), true);
    assert.deepEqual(inbox(h, 'c2'), [{ t: 'near', plaque: null }]);
    assert.deepEqual(h.s.stats(), { players: 1, seats: 1, joinsTotal: 1, reconnects: 1 });
  });

  // The phone's make-before-break rollover: a second socket says hello with the token while the first is still open.
  it('a token hello over a still-open socket replaces it with 1000, emits join only, and ignores the old socket after', () => {
    const h = seats();
    h.s.open('watch');
    const w = join(h, 'old', 2);
    inbox(h, 'watch'); events(h);
    h.s.open('new');
    assert.deepEqual(inbox(h, 'new'), [{ t: 'lobby', free: [0, 1, 3, 4, 5] }]);
    h.s.message('new', { t: 'hello', token: w.token, slot: 2 });
    assert.deepEqual(closes(h), [{ cid: 'old', code: CLOSE_REPLACED, reason: 'replaced', msg: undefined }]);
    assert.deepEqual(inbox(h, 'new'), [w]);
    assert.deepEqual(events(h), [joinOf(w)]); // no in-zero, no away, no back: the figure never stops
    assert.deepEqual(inbox(h, 'watch'), []); // nothing changed for the lobby
    // Still in flight on the old socket, then its close: all stale.
    h.s.message('old', { t: 'in', lx: 1, a: 0 });
    h.s.message('old', { t: 'hello', token: w.token, slot: 2 }); // its answer to a who: must not take the seat back
    h.s.message('old', { t: 'here' });
    h.s.gone('old');
    assert.deepEqual(events(h), []);
    assert.deepEqual(closes(h), []);
    assert.deepEqual(inbox(h, 'old'), []);
    h.clock.advance(HOLD * 2);
    assert.deepEqual(events(h), []); // no hold was started: the seat never left
    // The new socket is the live one.
    h.s.message('new', { t: 'in', lx: -1, a: 1 });
    assert.deepEqual(events(h), [{ t: 'in', pid: w.pid, lx: -1, a: 1 }]);
    assert.equal(h.s.to(w.pid, { t: 'mode', mode: 'walk' }), true);
    assert.deepEqual(inbox(h, 'new'), [{ t: 'mode', mode: 'walk' }]);
    assert.deepEqual(h.s.stats(), { players: 1, seats: 1, joinsTotal: 1, reconnects: 1 });
    // A later lobby change does not reach the old cid.
    join(h, 'c3', 0);
    assert.deepEqual(inbox(h, 'old'), []);
    // And when the new socket goes, the seat goes away as usual.
    events(h);
    h.s.gone('new');
    assert.deepEqual(events(h), [{ t: 'in', pid: w.pid, lx: 0, a: 0 }, { t: 'away', pid: w.pid }]);
  });

  it('drops a seat whose hold runs out: leave, the slot back in the lobby, and its token forgotten', () => {
    const h = seats();
    h.s.open('watch');
    const w = join(h, 'c1', 0);
    inbox(h, 'watch');
    h.s.gone('c1');
    events(h);
    h.clock.advance(HOLD - 1);
    assert.deepEqual(events(h), []);
    h.clock.advance(1);
    assert.deepEqual(events(h), [{ t: 'leave', pid: w.pid }]);
    assert.deepEqual(closes(h), []); // its socket had already gone
    assert.deepEqual(inbox(h, 'watch'), [{ t: 'lobby', free: [0, 1, 2, 3, 4, 5] }]);
    const again = join(h, 'c2', 0, w.token);
    assert.notEqual(again.pid, w.pid);
    assert.notEqual(again.token, w.token);
    assert.deepEqual(events(h), [joinOf(again)]); // a new player: no back
  });
});

describe('slots: kicks', () => {
  it('kick sends evicted, closes 4001 and emits leave; that socket\'s later messages and gone are ignored', () => {
    const h = seats();
    const w = join(h, 'c1', 1);
    h.s.open('lob'); inbox(h, 'lob'); events(h);
    h.s.kick(w.pid, 'judge');
    assert.deepEqual(closes(h), [evicted('c1', 'judge')]);
    assert.deepEqual(events(h), [{ t: 'leave', pid: w.pid }]);
    assert.deepEqual(inbox(h, 'lob'), [{ t: 'lobby', free: [0, 1, 2, 3, 4, 5] }]);
    h.s.message('c1', { t: 'in', lx: 1, a: 1 });
    h.s.gone('c1');
    assert.deepEqual(events(h), []);
    // The token is refused from then on, and that socket leaves the lobby list.
    h.s.open('c2'); inbox(h, 'c2');
    h.s.message('c2', { t: 'hello', token: w.token, slot: 1 });
    assert.deepEqual(closes(h), [evicted('c2', 'judge')]);
    assert.deepEqual(inbox(h, 'c2'), []);
    assert.deepEqual(events(h), []);
    join(h, 'c3');
    assert.deepEqual(inbox(h, 'c2'), []);
    assert.equal(h.s.stats().seats, 1);
  });

  it('a kicked token is refused even if the phone was away at the kick', () => {
    const h = seats();
    const w = join(h, 'c1', 2);
    h.s.gone('c1');
    events(h);
    h.s.kick(w.pid, 'idle');
    assert.deepEqual(closes(h), []); // nothing to close
    assert.deepEqual(events(h), [{ t: 'leave', pid: w.pid }]);
    h.clock.advance(HOLD * 2);
    assert.deepEqual(events(h), []); // the hold died with the seat: no second leave
    h.s.open('c2');
    h.s.message('c2', { t: 'hello', token: w.token, slot: 2 });
    assert.deepEqual(closes(h), [evicted('c2', 'idle')]);
    assert.ok(!inbox(h, 'c2').some((m) => m.t === 'welcome'));
    h.s.kick(w.pid, 'idle'); h.s.kick(999, 'idle'); // already gone, never there: no-ops
    assert.deepEqual(events(h), []);
    assert.deepEqual(closes(h), []);
  });
});

describe('slots: a host reconnect', () => {
  it('hostOpen keeps the seats that answer who within the hold and drops the rest', () => {
    const h = seats();
    const a = join(h, 'a', 0), b = join(h, 'b', 1), c = join(h, 'c', 2);
    h.s.open('lob');
    inbox(h, 'lob'); events(h);
    h.s.hostOpen();
    h.clock.advance(HOLD / 2);
    h.s.message('a', { t: 'hello', token: a.token, slot: 0 }); // a's answer to who, on the same socket
    assert.deepEqual(inbox(h, 'a'), [a]);
    assert.deepEqual(events(h), [joinOf(a)]);
    // c's socket changed while the host was away: it answers from a new cid and keeps its pid, no back.
    h.s.open('c-new');
    h.s.message('c-new', { t: 'hello', token: c.token, slot: 2 });
    assert.deepEqual(inbox(h, 'c-new').at(-1), c);
    assert.deepEqual(events(h), [joinOf(c)]);
    assert.deepEqual(closes(h), [{ cid: 'c', code: CLOSE_REPLACED, reason: 'replaced', msg: undefined }]);
    h.clock.advance(HOLD / 2);
    assert.deepEqual(events(h), [{ t: 'leave', pid: b.pid }]);
    assert.deepEqual(closes(h), [evicted('b', 'timeout')]);
    assert.deepEqual(inbox(h, 'lob'), []); // the lobby list was forgotten: no update until it says here
    h.clock.advance(HOLD * 2);
    assert.deepEqual(events(h), []); // a and c stay
    assert.equal(h.s.to(a.pid, { t: 'x' }), true);
    assert.equal(h.s.to(c.pid, { t: 'x' }), true);
    assert.deepEqual(h.s.stats().seats, 2);
  });

  it('here puts a socket back on the lobby list; a seated socket\'s here is ignored', () => {
    const h = seats();
    const a = join(h, 'a', 0);
    h.s.open('lob'); inbox(h, 'lob');
    h.s.hostOpen();
    h.s.message('lob', { t: 'here' });
    assert.deepEqual(inbox(h, 'lob'), [{ t: 'lobby', free: [1, 2, 3, 4, 5] }]);
    h.s.message('a', { t: 'here' });
    assert.deepEqual(inbox(h, 'a'), []);
    join(h, 'c', 2);
    assert.deepEqual(inbox(h, 'lob'), [{ t: 'lobby', free: [1, 3, 4, 5] }]);
    // A socket whose open the host missed (it connected while the host was away) gets the lobby too.
    h.s.message('unseen', { t: 'here' });
    assert.deepEqual(inbox(h, 'unseen'), [{ t: 'lobby', free: [1, 3, 4, 5] }]);
    h.s.message('a', { t: 'hello', token: a.token, slot: 0 });
    h.clock.advance(HOLD * 2);
    assert.ok(!events(h).some((e) => e.t === 'leave'));
  });
});

describe('slots: a host tab reload', () => {
  it('restores seats (pids, colours, slots) and kicked tokens from the store', () => {
    const clock = fakeClock(), store = memStore(), tokens = { n: 0 };
    const h1 = seats({ clock, store, tokens });
    const a = join(h1, 'a', 2), b = join(h1, 'b', 4), k = join(h1, 'k', 0);
    h1.s.kick(k.pid, 'judge');
    clock.advance(60_000);
    const h2 = seats({ clock, store, tokens });
    assert.deepEqual(h2.s.stats(), { players: 0, seats: 2, joinsTotal: 3, reconnects: 0 });
    h2.s.open('lob');
    assert.deepEqual(inbox(h2, 'lob'), [{ t: 'lobby', free: [0, 1, 3, 5] }]);
    assert.deepEqual(join(h2, 'a2', 0, a.token), a);
    assert.deepEqual(events(h2), [{ t: 'back', pid: a.pid }, joinOf(a)]);
    h2.s.open('k2');
    h2.s.message('k2', { t: 'hello', token: k.token, slot: 0 });
    assert.deepEqual(closes(h2), [evicted('k2', 'judge')]);
    assert.equal(join(h2, 'n', 0).pid, 4); // new players continue the pid sequence
    events(h2);
    clock.advance(HOLD); // b never came back: its restored hold drops it
    assert.deepEqual(events(h2), [{ t: 'leave', pid: b.pid }]);
    assert.deepEqual(closes(h2), []);
  });

  it('a save older than 10 minutes restores only the kicked tokens', () => {
    const clock = fakeClock(), store = memStore(), tokens = { n: 0 };
    const h1 = seats({ clock, store, tokens });
    const a = join(h1, 'a', 2), k = join(h1, 'k', 0);
    h1.s.kick(k.pid, 'idle');
    clock.advance(RESTORE_MS + 1);
    const h2 = seats({ clock, store, tokens });
    assert.equal(h2.s.stats().seats, 0);
    const a2 = join(h2, 'a2', 2, a.token);
    assert.equal(a2.t, 'welcome');
    assert.notEqual(a2.token, a.token);
    assert.deepEqual(events(h2), [joinOf(a2)]); // a new player: no back
    h2.s.open('k2');
    h2.s.message('k2', { t: 'hello', token: k.token, slot: 0 });
    assert.deepEqual(closes(h2), [evicted('k2', 'idle')]);
  });

  it('a corrupt, odd or failing store never throws: the seats start empty', () => {
    const clock = fakeClock(), at = clock.now();
    const values = ['{', 'null', '42', '"x"', '[]', JSON.stringify({ v: 2, at, seats: [] }),
      JSON.stringify({ v: 1, at: 'x', kicked: 5, seats: 'x' }), JSON.stringify({ v: 1, at, kicked: [5], seats: [] }),
      JSON.stringify({ v: 1, at, kicked: [[1]], seats: [null, 1, 'x', { token: 5, slot: 0 }, { token: 't', slot: 9 }] })];
    for (const v of values) {
      const h = seats({ clock, store: memStore(v) });
      assert.equal(h.s.stats().seats, 0, v);
      assert.equal(join(h, 'c').t, 'welcome', v);
    }
    const h = seats({ clock, store: { get() { throw new Error('blocked'); }, set() { throw new Error('full'); } } });
    const w = join(h, 'c');
    assert.equal(w.t, 'welcome');
    h.s.gone('c'); // saves again
    clock.advance(HOLD);
    assert.deepEqual(events(h).at(-1), { t: 'leave', pid: w.pid });
  });
});

describe('slots: hostile input', () => {
  it('never throws on hostile message shapes or unknown ids, and the bank keeps working', () => {
    const h = seats();
    const w = join(h, 'c1', 0);
    const shapes = [{}, { t: 'nope' }, { t: '__proto__' }, { t: 'constructor' }, { t: 'toString' }, { t: { toString: 1 } },
      { t: 'hello' }, { t: 'hello', token: { toString: 1 }, slot: { valueOf: 1 } }, { t: 'hello', token: ['tok1'], slot: [0] },
      { t: 'hello', token: '__proto__', slot: '__proto__' }, { t: 'hello', token: 'constructor', slot: 1.5 },
      { t: 'hello', token: 'toString', slot: Infinity }, { t: 'hello', token: '', slot: -0 },
      { t: 'in', lx: { toString: 1 }, a: [] }, { t: 'panel', kind: { toString: 1 }, value: {} }, { t: 'hbr', ts: { valueOf: 1 } },
      { t: 'here', extra: [1] }];
    for (const cid of ['c1', 'stranger', '__proto__', 'constructor', '']) {
      for (const m of shapes) assert.doesNotThrow(() => h.s.message(cid, m), `${cid} ${JSON.stringify(m)}`);
    }
    for (const cid of ['nobody', '__proto__', undefined]) { h.s.gone(cid); h.s.open(cid); h.s.gone(cid); }
    h.s.kick(undefined, 'x'); h.s.kick('1', 'x'); h.s.kick(999, 'x');
    assert.equal(h.s.to(undefined, { t: 'x' }), false);
    assert.equal(h.s.to(999, { t: 'x' }), false);
    h.clock.advance(HOLD * 3);
    // The first seat is untouched and still live.
    events(h); inbox(h, 'c1');
    h.s.message('c1', { t: 'in', lx: 1, a: 0 });
    assert.deepEqual(events(h), [{ t: 'in', pid: w.pid, lx: 1, a: 0 }]);
    assert.equal(h.s.to(w.pid, { t: 'x' }), true);
    assert.ok(h.s.stats().seats <= MAX_PLAYERS);
  });
});

// ---- a close ordered while the host's socket is down (review fix) ----
describe('slots: closes that never reached the relay', () => {
  it('a phone kicked during a gap is evicted when it answers who, not silently ignored', () => {
    const clock = fakeClock(), closesSeen = [], sent = [];
    let up = true, n = 0;
    const s = createSlots({
      slots: SLOTS, max: MAX_PLAYERS, holdMs: HOLD, timers: clock.timers, now: clock.now, token: () => `t${++n}`,
      send: (cid, msg) => { if (up) sent.push({ cid, msg }); return up; },
      close: (cid, code, reason, msg) => { if (up) closesSeen.push({ cid, code, reason, msg }); return up; },
      emit: () => {},
    });
    s.open('c1'); s.message('c1', { t: 'hello', token: null, slot: 0 });
    up = false;          // the host tab's socket drops
    s.kick(1, 'judge');  // J during the gap: the eviction cannot be delivered
    assert.deepEqual(closesSeen, []);
    up = true; s.hostOpen(); // back: the host sends who, the phone answers on its still-open socket
    s.message('c1', { t: 'hello', token: 't1', slot: 0 });
    assert.deepEqual(closesSeen, [{ cid: 'c1', code: CLOSE_EVICTED, reason: 'judge', msg: { t: 'evicted', reason: 'judge' } }]);
  });

  it('to() is false while the host socket is down, so glue never records an undelivered world', () => {
    let up = true;
    const s = createSlots({ slots: SLOTS, max: MAX_PLAYERS, holdMs: HOLD, send: () => up, close() {}, emit() {} });
    s.open('c1'); s.message('c1', { t: 'hello', token: null, slot: 0 });
    assert.equal(s.to(1, { t: 'world' }), true);
    up = false;
    assert.equal(s.to(1, { t: 'world' }), false);
  });
});
