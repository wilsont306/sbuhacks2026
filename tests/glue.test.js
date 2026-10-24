// Ownership and margin helpers from src/host/glue.js. glue.js itself imports CSS and JSON and touches the DOM,
// so this loads only its pure block (between the pure:start and pure:end markers) as a module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/host/glue.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* pure:start'), src.indexOf('/* pure:end */'));
const g = await import('data:text/javascript,' + encodeURIComponent(block));

test('look: free or own plaque is granted, someone else\'s is busy', () => {
  const owners = new Map([['bridge', 2]]);
  assert.deepEqual(g.decideLook(owners, 'loco', 1), { drop: null });
  assert.deepEqual(g.decideLook(owners, 'bridge', 2), { drop: null });
  assert.deepEqual(g.decideLook(owners, 'bridge', 1), { busy: 2 });
  assert.deepEqual(g.decideLook(new Map([['hare', 0]]), 'hare', 3), { busy: 0 });
});

test('look: a pid that already holds another plaque drops it', () => {
  assert.deepEqual(g.decideLook(new Map([['loco', 0]]), 'bridge', 0), { drop: 'loco' });
});

test('panel: lever needs loco, span and rise need bridge', () => {
  const owners = new Map([['loco', 1], ['bridge', 2]]);
  assert.equal(g.mayPanel(owners, 1, 'lever'), true);
  assert.equal(g.mayPanel(owners, 2, 'lever'), false);
  assert.equal(g.mayPanel(owners, 2, 'span'), true);
  assert.equal(g.mayPanel(owners, 2, 'rise'), true);
  assert.equal(g.mayPanel(owners, 1, 'rise'), false);
  assert.equal(g.mayPanel(owners, 1, 'constructor'), false);
  assert.equal(g.mayPanel(new Map(), undefined, 'toString'), false);
});

test('panel: export needs bridge', () => {
  const owners = new Map([['loco', 1], ['bridge', 2]]);
  assert.equal(g.mayPanel(owners, 2, 'export'), true);
  assert.equal(g.mayPanel(owners, 1, 'export'), false);
  assert.equal(g.mayPanel(new Map(), 2, 'export'), false);
});

test('panel values are clamped to the phone ranges', () => {
  const ranges = new Map([['lever', [0, 60]], ['span', [90, 160]], ['rise', [10, 48]]]);
  assert.equal(g.panelValue('lever', 75, ranges), 60);
  assert.equal(g.panelValue('lever', -3, ranges), 0);
  assert.equal(g.panelValue('span', 128, ranges), 128);
  assert.equal(g.panelValue('rise', 64, ranges), 48);
  assert.equal(g.panelValue('rise', 5, ranges), 10);
  assert.equal(g.panelValue('rise', NaN, ranges), null);
  assert.equal(g.panelValue('rise', '30', ranges), null);
  assert.equal(g.panelValue('export', 1, ranges), null);
});

test('owner expiry: 20 s idle (not in judge mode), 90 s cap, 180 s in judge mode', () => {
  const L = { idle: 20000, cap: 90000, capJudge: 180000 };
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 0 }, 19999, false, L), null);
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 0 }, 20000, false, L), 'idle');
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 0 }, 100000, true, L), null);
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 85000 }, 89999, false, L), null);
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 85000 }, 90000, false, L), 'cap');
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 175000 }, 179999, true, L), null);
  assert.equal(g.ownerExpiry({ since: 0, lastPanel: 175000 }, 180000, true, L), 'cap');
});

test('idle kicks: 90 s for everyone, 30 s for pre-J phones in judge mode, owners and guests exempt', () => {
  const L = { idle: 90000, judgeIdle: 30000 }, now = 100000;
  const p = (quiet, extra = {}) => ({ lastActive: now - quiet, ...extra });
  const players = new Map([[1, p(91000)], [2, p(89000)], [3, p(91000)], [4, p(31000, { preJ: true })], [5, p(91000, { guest: true })], [6, p(91000, { kicked: true })]]);
  const owners = new Map([['loco', 3]]);
  assert.deepEqual(g.idleKicks(players, owners, now, false, L), [{ pid: 1, reason: 'idle' }, { pid: 5, reason: 'idle' }]);
  assert.deepEqual(g.idleKicks(players, owners, now, true, L), [{ pid: 1, reason: 'idle' }, { pid: 4, reason: 'judge' }]);
  assert.deepEqual(g.idleKicks(new Map([[4, p(29000, { preJ: true })]]), new Map(), now, true, L), []);
  assert.deepEqual(g.idleKicks(new Map([[4, p(91000, { preJ: true })]]), new Map(), now, true, L), [{ pid: 4, reason: 'idle' }]);
});

test('ownedBy finds the plaque a pid holds', () => {
  const owners = new Map([['loco', 1], ['hare', 0]]);
  assert.equal(g.ownedBy(owners, 0), 'hare');
  assert.equal(g.ownedBy(owners, 1), 'loco');
  assert.equal(g.ownedBy(owners, 5), null);
});

test('judge kicks: longest idle first, owners last, until keep remain', () => {
  const p = (lastActive, extra = {}) => ({ lastActive, away: false, ...extra });
  const players = new Map([[1, p(100)], [2, p(50)], [3, p(10)], [4, p(400)], [5, p(300)], [6, p(200)]]);
  assert.deepEqual(g.pickKicks(players, new Map(), 4), [3, 2]);
  assert.deepEqual(g.pickKicks(players, new Map([['loco', 3]]), 4), [2, 1]);
  assert.deepEqual(g.pickKicks(new Map([[1, p(10)], [2, p(20)]]), new Map([['loco', 1], ['bridge', 2]]), 1), [1]);
  assert.deepEqual(g.pickKicks(new Map([[1, p(500)], [2, p(10)], [3, p(20, { away: true })]]), new Map(), 1), [3, 2]);
  assert.deepEqual(g.pickKicks(new Map([[1, p(10, { kicked: true })], [2, p(20)]]), new Map(), 1), []);
  assert.deepEqual(g.pickKicks(players, new Map(), 6), []);
});

test('Show the original: once per cooldown, globally', () => {
  assert.equal(g.originalWait(-Infinity, 5000, 20000), 0);
  assert.equal(g.originalWait(1000, 13000, 20000), 8000);
  assert.equal(g.originalWait(1000, 21000, 20000), 0);
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
