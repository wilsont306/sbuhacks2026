// Slot-policy, panel and margin helpers from src/host/glue.js. glue.js itself imports CSS, JSON and sibling modules
// and touches the DOM, so this loads only its pure block (between the pure:start and pure:end markers) as a module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pure = (path) => {
  const src = readFileSync(new URL(path, import.meta.url), 'utf8');
  return import('data:text/javascript,' + encodeURIComponent(src.slice(src.indexOf('/* pure:start'), src.indexOf('/* pure:end */'))));
};
const g = await pure('../src/host/glue.js');
const phone = await pure('../src/join/main.js'); // the phone page's pure block

test('room key: a well-formed stored key stays, else 16 random bytes as 22 base64url characters', () => {
  const k22 = 'Ab-_0123456789xyzXYZab', k64 = 'a'.repeat(64), zeros = new Uint8Array(16), ones = new Uint8Array(16).fill(255);
  assert.equal(g.pickKey(k22, ones), k22);
  assert.equal(g.pickKey(k64, ones), k64);
  assert.equal(g.pickKey(null, zeros), 'A'.repeat(22));
  assert.equal(g.pickKey(null, ones), '_'.repeat(21) + 'w'); // '+' and '/' never appear, nor '=' padding
  for (const bad of [undefined, '', 'a'.repeat(21), 'a'.repeat(65), 'Ab+/0123456789xyzXYZab', 'Ab=_0123456789xyzXYZab', 42]) {
    assert.equal(g.pickKey(bad, zeros), 'A'.repeat(22), String(bad));
  }
  const fresh = g.pickKey(null, Uint8Array.from({ length: 16 }, (_, i) => i * 17));
  assert.equal(fresh.length, 22);
  assert.match(fresh, g.KEY_RE);
});

test('join URL: the relay joinUrl with ?room=, else nothing for the QR', () => {
  const R = 'abcDEF0123456_-z';
  assert.equal(g.joinWithRoom('https://x.vercel.app/', R), 'https://x.vercel.app/?room=' + R);
  assert.equal(g.joinWithRoom('https://x.vercel.app', R), 'https://x.vercel.app/?room=' + R);
  assert.equal(g.joinWithRoom('http://192.168.1.5:8080/', R), 'http://192.168.1.5:8080/?room=' + R); // the laptop hub (Q)
  assert.equal(g.joinWithRoom('https://x.app/?hub=y.app#a', R), 'https://x.app/?hub=y.app&room=' + R + '#a');
  assert.equal(g.joinWithRoom('https://x.app/?room=old', R), 'https://x.app/?room=' + R);
  for (const bad of [undefined, null, '', 'abc', R.slice(1), R + 'a', 'abcDEF0123456/+z']) assert.equal(g.joinWithRoom('https://x.app/', bad), '', String(bad));
  for (const bad of [undefined, null, '', 'not a url', '/relative']) assert.equal(g.joinWithRoom(bad, R), '', String(bad));
});

test('seat store: tagged with the room key, so seats saved under another key (or untagged) are not restored', () => {
  const mem = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
  const ls = mem(), a = g.roomStore(ls, 'keyA'), b = g.roomStore(ls, 'keyB');
  assert.equal(a.get(), null);
  a.set('{"v":1}');
  assert.equal(a.get(), '{"v":1}');
  assert.equal(b.get(), null);
  ls.set('{"v":1}'); // saved before rooms
  assert.equal(a.get(), null);
  assert.equal(g.roomStore(null, 'keyA'), null); // no storage: no restore, as before
});

test('phone seat: the URL room, else the saved one; a token only for its own room', () => {
  const A = 'roomAAAAAAAAAAAA', B = 'roomBBBBBBBBBBBB';
  assert.deepEqual(phone.pickSeat(A, { room: A, token: 't1' }), { room: A, token: 't1' });
  assert.deepEqual(phone.pickSeat(A, { room: B, token: 't1' }), { room: A, token: null }); // another room clears it
  assert.deepEqual(phone.pickSeat(A, null), { room: A, token: null });
  assert.deepEqual(phone.pickSeat(null, { room: B, token: 't1' }), { room: null, token: null }); // no QR: scan again
  assert.deepEqual(phone.pickSeat('bad', { room: B, token: null }), { room: null, token: null });
  assert.deepEqual(phone.pickSeat(null, null), { room: null, token: null }); // the "Scan the code" screen
  assert.deepEqual(phone.pickSeat(null, 't1'), { room: null, token: null }); // a v1 token without a room
  assert.deepEqual(phone.pickSeat(null, { token: 't1' }), { room: null, token: null });
  assert.deepEqual(phone.pickSeat(A + 'x', { room: 'short', token: 't1' }), { room: null, token: null });
  assert.deepEqual(phone.pickSeat(A, { room: A, token: '' }), { room: A, token: null });
});

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

test('world message: the scene inline with an image the phone can load, else nothing to step into', () => {
  const NO = { t: 'world', scene: null, reason: 'This picture can’t be entered yet' };
  const s = (image_url, extra = {}) => ({ id: 'a', image_url, objects: [], ...extra });
  const blob = 'https://x.public.blob.vercel-storage.com/art/a.jpg';
  assert.deepEqual(g.worldMsg(s(blob)), { t: 'world', scene: s(blob), image: blob });
  assert.equal(g.worldMsg(s('/assets/turner-1920.jpg')).image, '/assets/turner-1920.jpg');
  assert.equal(g.worldMsg(s('HTTP://192.168.1.5/samples/sketch.svg')).image, 'HTTP://192.168.1.5/samples/sketch.svg');
  for (const bad of ['data:image/jpeg;base64,AAAA', 'blob:https://a/b', '', '//evil.example/x.jpg', '/\\evil.example/x.jpg', 'javascript:alert(1)', null]) {
    assert.deepEqual(g.worldMsg(s(bad)), NO, String(bad));
  }
  assert.deepEqual(g.worldMsg(null), NO); // the boot Turner and the flat state
  const pad = (n) => s('/a.jpg', { pad: 'x'.repeat(n - JSON.stringify(s('/a.jpg', { pad: '' })).length) });
  assert.equal(JSON.stringify(pad(48000)).length, 48000);
  assert.equal(g.worldMsg(pad(48000)).image, '/a.jpg');
  assert.deepEqual(g.worldMsg(pad(48001)), NO);
});

test('world due: inside 1 always answers, 2 only when the world changed since the last one sent, else nothing', () => {
  const a = JSON.stringify(g.worldMsg(null)), b = '{"t":"world","scene":{"id":"b"}}';
  assert.equal(g.worldDue(1, a, a), true);
  assert.equal(g.worldDue(1, undefined, a), true);
  assert.equal(g.worldDue(2, a, a), false);
  assert.equal(g.worldDue(2, a, b), true);
  assert.equal(g.worldDue(2, undefined, a), true); // never sent, or forgotten on away
  assert.equal(g.worldDue(2, null, a), true);
  for (const v of [0, 3, -1, '1']) assert.equal(g.worldDue(v, null, a), false, String(v));
});

test('pos due: on change, else once the keepalive has passed', () => {
  assert.equal(g.posDue('a', 'a', 1000, 3999, 3000), false);
  assert.equal(g.posDue('a', 'a', 1000, 4000, 3000), true);
  assert.equal(g.posDue('a', 'b', 1000, 1200, 3000), true);
  assert.equal(g.posDue(null, 'a', -Infinity, 0, 3000), true); // cleared on enter
  assert.equal(g.posDue(undefined, 'a', undefined, 5, 3000), true); // never sent
});

test('pos payload: my figure, my near label, every other seated figure with its colour and name', () => {
  const who = new Map([[0, { name: 'Keyboard', color: '#f3ecdc' }], [1, { name: 'Red Fox', color: '#c33', near: 'train' }], [2, { name: 'Blue Jay', color: '#33c', near: null }]]);
  const figures = [{ pid: 0, t: 0.15, facing: 1 }, { pid: 1, t: 0.123456, facing: -1 }, { pid: 2, t: 0.5, facing: 1 }, { pid: 9, t: 0.7, facing: 1 }];
  assert.deepEqual(g.posMsg(1, figures, who), {
    t: 'pos', me: { t: 0.1235, facing: -1 }, near: 'train',
    others: [{ pid: 0, t: 0.15, facing: 1, color: '#f3ecdc', name: 'Keyboard' }, { pid: 2, t: 0.5, facing: 1, color: '#33c', name: 'Blue Jay' }],
  });
  assert.equal(g.posMsg(2, figures, who).near, null);
  assert.equal(g.posMsg(3, figures, who), null); // no figure
  assert.equal(g.posMsg(9, figures, who), null); // a figure but no seat
});
