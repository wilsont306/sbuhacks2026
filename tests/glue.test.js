// Slot-policy, panel and margin helpers from src/host/glue.js. glue.js itself imports CSS, JSON and sibling modules
// and touches the DOM, so this loads only its pure block (between the pure:start and pure:end markers) as a module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/host/glue.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* pure:start'), src.indexOf('/* pure:end */'));
const g = await import('data:text/javascript,' + encodeURIComponent(block));

test('idle kicks: 90 s for everyone, 30 s for pre-J phones in judge mode, guests and kicked phones exempt', () => {
  const L = { idle: 90000, judgeIdle: 30000 }, now = 100000;
  const p = (quiet, extra = {}) => ({ lastActive: now - quiet, ...extra });
  const players = new Map([[1, p(91000)], [2, p(89000)], [4, p(31000, { preJ: true })], [5, p(91000, { guest: true })], [6, p(91000, { kicked: true })]]);
  assert.deepEqual(g.idleKicks(players, now, false, L), [{ pid: 1, reason: 'idle' }, { pid: 5, reason: 'idle' }]);
  assert.deepEqual(g.idleKicks(players, now, true, L), [{ pid: 1, reason: 'idle' }, { pid: 4, reason: 'judge' }]);
  assert.deepEqual(g.idleKicks(new Map([[4, p(29000, { preJ: true })]]), now, true, L), []);
  assert.deepEqual(g.idleKicks(new Map([[4, p(91000, { preJ: true })]]), now, true, L), [{ pid: 4, reason: 'idle' }]);
});

test('judge kicks: away first, then longest idle, until keep remain', () => {
  const p = (lastActive, extra = {}) => ({ lastActive, away: false, ...extra });
  const players = new Map([[1, p(100)], [2, p(50)], [3, p(10)], [4, p(400)], [5, p(300)], [6, p(200)]]);
  assert.deepEqual(g.pickKicks(players, 4), [3, 2]);
  assert.deepEqual(g.pickKicks(new Map([[1, p(500)], [2, p(10)], [3, p(20, { away: true })]]), 1), [3, 2]);
  assert.deepEqual(g.pickKicks(new Map([[1, p(10, { kicked: true })], [2, p(20)]]), 1), []);
  assert.deepEqual(g.pickKicks(players, 6), []);
});

test('Show the original: once per cooldown, globally', () => {
  assert.equal(g.originalWait(-Infinity, 5000, 20000), 0);
  assert.equal(g.originalWait(1000, 13000, 20000), 8000);
  assert.equal(g.originalWait(1000, 21000, 20000), 0);
});

test('artwork from a phone: one per phone per cooldown, only guests during the guided tour', () => {
  assert.equal(g.artworkGate({}, 5000, false, 20000), 'ok');
  assert.equal(g.artworkGate({ lastArtwork: 1000 }, 13000, false, 20000), 'wait');
  assert.equal(g.artworkGate({ lastArtwork: 1000 }, 21000, false, 20000), 'ok');
  assert.equal(g.artworkGate({ lastArtwork: -Infinity }, 0, false, 20000), 'ok');
  assert.equal(g.artworkGate({ guest: false }, 5000, true, 20000), 'tour');
  assert.equal(g.artworkGate({ guest: true }, 5000, true, 20000), 'ok');
  assert.equal(g.artworkGate({ guest: true, lastArtwork: 1000 }, 13000, true, 20000), 'wait');
  assert.equal(g.artworkGate({ guest: true }, 5000, false, 20000), 'ok'); // after J is off, guest status is moot
});

test('Wi-Fi payload escapes \\ ; , : "', () => {
  assert.equal(g.wifiPayload({ ssid: 'Toy Theatre', pass: 'a;b,c:d"e\\f' }), 'WIFI:T:WPA;S:Toy Theatre;P:a\\;b\\,c\\:d\\"e\\\\f;;');
  assert.equal(g.wifiPayload({ ssid: 'open', pass: '' }), 'WIFI:T:nopass;S:open;;');
});

test('median of the last RTTs', () => {
  assert.equal(g.median([]), null);
  assert.equal(g.median([30, 10, 20]), 20);
  assert.equal(g.median([40, 10, 20, 30]), 25);
});

test('QR scale: integer px per module, at most 222 px with the quiet zone', () => {
  assert.equal(g.qrScale(25), 6); // version 2: 198 px
  assert.equal(g.qrScale(29), 6); // version 3: 222 px
  assert.equal(g.qrScale(33), 5); // version 4: 205 px
  assert.equal(g.qrScale(45), 4); // version 7: 212 px
  for (const n of [21, 25, 29, 33, 37, 41, 45]) assert.ok((n + 8) * g.qrScale(n) <= 222);
});
