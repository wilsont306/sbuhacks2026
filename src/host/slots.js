// The bank's seats, owned by the host tab (the TV). The relay only routes, so this module decides who holds which
// colour: it hands out tokens, holds a seat 20 s across a reconnect, lets the newest socket for a token win, refuses
// kicked tokens and applies the cap. It reports to glue.js with the events the old hub sent (join, away, back,
// leave, in, panel, hbr), so the player manager and plaque rules there did not change.
// Pure: no DOM and no network (tests/slots.test.js drives it with a fake clock).
import { CLOSE_EVICTED, CLOSE_REPLACED } from '../shared/protocol.js';

const RESTORE_MS = 10 * 60 * 1000; // a host tab reloaded within this keeps its seats, so phones keep their colours
const KICKED_MAX = 50;

function randomToken() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// send(cid, msg) and close(cid, code, reason, msg) go to the relay; emit(event) goes to glue's handler.
// store is {get, set} for one string (localStorage in the page) or null.
export function createSlots({ slots, max, holdMs, send, close, emit, store = null, timers = globalThis, now = () => Date.now(), token = randomToken }) {
  const byToken = new Map(); // token -> seat {pid, token, slot, name, color, cid (null while away), hold}
  const byCid = new Map();   // live cid -> seat; a seat's old cid is removed the moment a newer socket takes it
  const lobbyCids = new Set(); // open sockets without a seat, which get lobby updates
  // Cids we told the relay to close. Their in-flight messages are stale: a replaced socket's late hello (a who reply
  // during a phone's rollover) must not take the seat back. The old hub closed them synchronously.
  const closing = new Set();
  // Only a close that reached the relay makes the cid stale; one ordered while the host's socket was down never closed
  // that socket, so its next hello (after the host's who) must still count.
  const shut = (cid, code, reason, msg) => { if (close(cid, code, reason, msg) !== false) closing.add(cid); };
  let kicked = new Map();    // token -> reason: a kicked phone that comes back with its token is evicted again
  let cap = max, nextPid = 1, joinsTotal = 0, reconnects = 0;

  const byPid = (pid) => { for (const s of byToken.values()) if (s.pid === pid) return s; return null; };
  const freeSlots = () => {
    if (byToken.size >= cap) return [];
    const used = new Set([...byToken.values()].map((s) => s.slot));
    return slots.map((_, i) => i).filter((i) => !used.has(i));
  };
  const lobby = (cid) => send(cid, { t: 'lobby', free: freeSlots() });
  const lobbyAll = () => { for (const cid of lobbyCids) lobby(cid); };
  const clearHold = (s) => { timers.clearTimeout(s.hold); s.hold = 0; };
  const hold = (s) => { clearHold(s); s.hold = timers.setTimeout(() => drop(s, 'timeout'), holdMs); };

  function save() {
    if (!store) return;
    try {
      store.set(JSON.stringify({
        v: 1, at: now(), nextPid, joinsTotal, reconnects,
        seats: [...byToken.values()].map(({ pid, token: tk, slot, name, color }) => ({ pid, token: tk, slot, name, color })),
        kicked: [...kicked].slice(-KICKED_MAX),
      }));
    } catch { /* storage full or blocked: seats just do not survive a reload */ }
  }

  function drop(s, reason) {
    clearHold(s);
    if (byToken.get(s.token) !== s) return;
    byToken.delete(s.token);
    if (s.cid) { byCid.delete(s.cid); shut(s.cid, CLOSE_EVICTED, reason, { t: 'evicted', reason }); s.cid = null; }
    emit({ t: 'leave', pid: s.pid });
    lobbyAll(); save();
  }

  function welcome(s) { send(s.cid, { t: 'welcome', pid: s.pid, token: s.token, color: s.color, name: s.name, slot: s.slot }); }

  function hello(cid, m) {
    const bound = byCid.get(cid);
    if (bound) { // this socket already holds a seat: a reply to the host's who, or a repeated hello
      clearHold(bound); welcome(bound);
      emit({ t: 'join', pid: bound.pid, name: bound.name, color: bound.color });
      return;
    }
    if (m.token && kicked.has(m.token)) {
      const why = kicked.get(m.token);
      lobbyCids.delete(cid);
      return shut(cid, CLOSE_EVICTED, why, { t: 'evicted', reason: why });
    }
    let s = m.token ? byToken.get(m.token) : null, back = false;
    const fresh = !s;
    if (s) {
      clearHold(s); reconnects++;
      back = !s.cid;
      // Same token on a still-open socket (a phone's rollover, a half-open phone, a second tab): the newest wins.
      if (s.cid) { byCid.delete(s.cid); shut(s.cid, CLOSE_REPLACED, 'replaced'); }
    } else {
      const free = freeSlots();
      if (!free.length) return send(cid, { t: 'full' });
      const i = free.includes(m.slot) ? m.slot : free[0];
      s = { pid: nextPid++, token: token(), slot: i, name: slots[i].name, color: slots[i].color, cid: null, hold: 0 };
      byToken.set(s.token, s); joinsTotal++;
    }
    s.cid = cid; byCid.set(cid, s); lobbyCids.delete(cid);
    welcome(s);
    if (back) emit({ t: 'back', pid: s.pid });
    emit({ t: 'join', pid: s.pid, name: s.name, color: s.color });
    if (fresh) lobbyAll();
    save();
  }

  // Restore seats a reloaded host tab had; their phones come back on the host's who, or the hold drops them.
  if (store) {
    try {
      const d = JSON.parse(store.get() || 'null');
      if (d && d.v === 1) {
        kicked = new Map(Array.isArray(d.kicked) ? d.kicked : []);
        nextPid = Math.max(nextPid, Number(d.nextPid) || 1);
        if (now() - d.at < RESTORE_MS && Array.isArray(d.seats)) {
          joinsTotal = Number(d.joinsTotal) || 0; reconnects = Number(d.reconnects) || 0;
          for (const q of d.seats) {
            if (typeof q?.token !== 'string' || !slots[q.slot]) continue;
            const s = { pid: q.pid, token: q.token, slot: q.slot, name: q.name, color: q.color, cid: null, hold: 0 };
            byToken.set(s.token, s); hold(s);
          }
        }
      }
    } catch { /* a bad saved value: start empty */ }
  }

  return {
    // A phone socket opened on the relay.
    open(cid) { lobbyCids.add(cid); lobby(cid); },
    // A phone socket closed. A cid that no longer holds a seat (replaced by a newer socket) is ignored.
    gone(cid) {
      lobbyCids.delete(cid); closing.delete(cid);
      const s = byCid.get(cid);
      if (!s) return;
      byCid.delete(cid); s.cid = null;
      emit({ t: 'in', pid: s.pid, lx: 0, a: 0 }); // stop the figure at once
      emit({ t: 'away', pid: s.pid });
      hold(s); save();
    },
    // A player message from the relay, already type-checked there (hub/relay.js clean()).
    message(cid, m) {
      if (closing.has(cid)) return;
      if (m.t === 'hello') return hello(cid, m);
      if (m.t === 'here') { if (!byCid.has(cid)) { lobbyCids.add(cid); lobby(cid); } return; }
      const s = byCid.get(cid);
      if (!s) return;
      if (m.t === 'in') emit({ t: 'in', pid: s.pid, lx: m.lx, a: m.a });
      else if (m.t === 'panel') emit({ t: 'panel', pid: s.pid, kind: m.kind, value: m.value });
      else if (m.t === 'hbr') emit({ t: 'hbr', pid: s.pid, ts: m.ts });
    },
    // The host's socket (re)connected after a gap it may have missed messages in. Every seat must answer the who the
    // host sends next, or its hold drops it; lobby sockets re-announce themselves with here.
    hostOpen() {
      lobbyCids.clear(); closing.clear(); // after a gap every live cid proves itself again by answering who
      for (const s of byToken.values()) if (s.cid) hold(s);
    },
    to(pid, msg) { const s = byPid(pid); if (!s || !s.cid) return false; send(s.cid, msg); return true; },
    kick(pid, reason) { const s = byPid(pid); if (!s) return; kicked.set(s.token, reason); drop(s, reason); },
    setCap(n) { cap = Math.max(0, Math.min(max, n | 0)); lobbyAll(); },
    stats: () => ({ players: byCid.size, seats: byToken.size, joinsTotal, reconnects }),
  };
}
