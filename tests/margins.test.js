// Formatting helpers from src/host/margins.js: chip and saved-badge text, safe image URLs, times, the station sign,
// the stops' crops, the platform lines and the Learning entries. margins.js imports CSS and JSON and touches the DOM, so this loads
// only its pure block (between the pure:start and pure:end markers) as a module, as tests/glue.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/host/margins.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* pure:start'), src.indexOf('/* pure:end */'));
const m = await import('data:text/javascript,' + encodeURIComponent(block));

// A local wall-clock time as ISO, so the expected 'HH:MM' holds in any time zone.
const local = (h, min) => new Date(2026, 9, 24, h, min).toISOString(); // Sat Oct 24 2026

test('chip: hand-corrected samples say so; everything else is an AI draft', () => {
  assert.equal(m.chipText({ edited: true }), 'AI draft, hand-corrected (sample)');
  assert.equal(m.chipText({ edited: false }), 'AI draft, not a museum record');
  assert.equal(m.chipText({ edited: 'yes' }), 'AI draft, not a museum record');
  assert.equal(m.chipText(null), 'AI draft, not a museum record');
});

test('saved badge: Saved to Snowflake only for saved', () => {
  assert.equal(m.savedText('saved'), 'Saved to Snowflake');
  assert.equal(m.savedText('saving'), 'saving…');
  assert.equal(m.savedText('local'), 'local only');
  assert.equal(m.savedText('sample'), 'sample');
  assert.equal(m.savedText('unsaved'), 'not saved');
  for (const v of [undefined, null, '', 'SAVED', 'toString', '__proto__', 1]) assert.equal(m.savedText(v), 'not saved');
});

test('safeUrl: only http(s), site-relative, blob and data:image', () => {
  for (const u of ['https://x.public.blob.vercel-storage.com/art/1.jpg', 'http://localhost/a.png', '/assets/turner-1920.jpg',
    '/samples/sketch.svg', 'blob:http://localhost/abc', 'data:image/jpeg;base64,AAAA']) assert.equal(m.safeUrl(u), u);
  for (const u of ['javascript:alert(1)', '//evil.example/x.png', 'data:text/html,<b>', 'samples/x.png', ' https://a', '', null, 3, {}])
    assert.equal(m.safeUrl(u), '');
});

test('clock and stamp: local HH:MM; ISO stamps get the weekday, free text stays', () => {
  assert.equal(m.clock(local(14, 5)), '14:05');
  assert.equal(m.clock(local(9, 0)), '09:00');
  assert.equal(m.clock('not a date'), '—');
  assert.equal(m.clock(undefined), '—');
  assert.equal(m.stamp(local(14, 5)), 'Sat 14:05');
  assert.equal(m.stamp('Sat 10:15'), 'Sat 10:15');
  assert.equal(m.stamp('2026-13-45Tnope'), '2026-13-45Tnope');
  assert.equal(m.stamp(undefined), '');
});

test('labelOf: the artist guess, chip, credit and thumbnail (the sign title is gallery.js projectTitle)', () => {
  const scene = {
    id: 'sample-turner', edited: true, credit: 'J. M. W. Turner, 1844. The National Gallery, London',
    title_guess: 'Rain, Steam and\nSpeed', artist_guess: 'J. M. W. Turner', image_url: '/assets/turner-1920.jpg',
  };
  assert.deepEqual(m.labelOf(scene), {
    artist: 'J. M. W. Turner', chip: 'AI draft, hand-corrected (sample)',
    credit: 'J. M. W. Turner, 1844. The National Gallery, London', thumb: '/assets/turner-1920.jpg',
  });
  assert.equal(m.labelOf({ credit: null }).credit, '');
  assert.equal(m.labelOf({ credit: 'x'.repeat(400) }).credit.length, 300);
  assert.equal(m.labelOf(null), null);
});

test('labelOf: unknown guesses read as unknown, bad fields are dropped', () => {
  const l = m.labelOf({ title_guess: 'unknown', artist_guess: 42, image_url: 'javascript:x' });
  assert.equal(l.artist, 'Artist unknown');
  assert.equal(l.chip, 'AI draft, not a museum record');
  assert.equal(l.thumb, '');
});

// The crop as the rectangle of the picture it shows, back from CSS background-size and -position (fractions 0..1).
function shown(c) {
  const [sw, sh] = c.size.split(' ').map((p) => 100 / parseFloat(p)), [px, py] = c.position.split(' ').map((p) => parseFloat(p) / 100);
  return { x: px * (1 - sw), y: py * (1 - sh), w: sw, h: sh };
}
const near = (a, b) => Math.abs(a - b) < 1e-3;

test('cropOf: a 4:3 window round the box, at the picture aspect, inside the picture', () => {
  for (const aspect of [16 / 9, 4 / 3, 1, 3 / 4]) {
    for (const box of [[572, 543, 695, 700], [778, 686, 808, 712], [0, 0, 1000, 510], [500, 552, 1000, 1000], [0, 0, 1000, 1000], [0, 900, 40, 1000]]) {
      const r = shown(m.cropOf(box, aspect));
      assert.ok(near(r.w * aspect / r.h, 4 / 3), `4:3 on screen: ${box} at ${aspect}`);
      assert.ok(r.x >= -1e-3 && r.y >= -1e-3 && r.x + r.w <= 1 + 1e-3 && r.y + r.h <= 1 + 1e-3, `inside: ${box} at ${aspect}`);
      // the box's centre is in view
      const cx = (box[0] + box[2]) / 2000, cy = (box[1] + box[3]) / 2000;
      assert.ok(cx >= r.x - 1e-3 && cx <= r.x + r.w + 1e-3 && cy >= r.y - 1e-3 && cy <= r.y + r.h + 1e-3, `centre: ${box} at ${aspect}`);
    }
  }
  const loco = shown(m.cropOf([572, 543, 695, 700], 4 / 3)); // a small box is framed with a little room round it
  assert.ok(loco.x < 0.572 && loco.x + loco.w > 0.695 && loco.y < 0.543 && loco.y + loco.h > 0.7);
  assert.deepEqual(m.cropOf([700, 543, 572, 695], 4 / 3), m.cropOf([572, 543, 700, 695], 4 / 3), 'corners in any order');
});

test('cropOf: no box, no aspect, no crop', () => {
  for (const [box, aspect] of [[null, 1], [[1, 2, 3], 1], [[0, 0, 0, 10], 1], [[0, 0, 10, 10], 0], [[0, 0, 10, 10], NaN], [[0, 0, 'a', 10], 1], [[0, 0, 10, 10], Infinity]])
    assert.equal(m.cropOf(box, aspect), null, `${box} at ${aspect}`);
});

test('platformLines: one line per platform, in order', () => {
  const lines = m.platformLines({
    hub: { t: 'hub', region: 'iad1', instance: 'abcdef123456', bus: 'redis' },
    scene: { model: 'gemini-3.5-flash-lite', generated_at: local(14, 5) },
    saved: 'saved', id: 'p-42', audio: { played: 3, generated: 1, cached: 2 },
    depth: { state: 'ready', device: 'webgpu', ms: 812 }, models: { on: true, ready: 1, running: 1, failed: 0, last: 'running' },
  });
  assert.deepEqual(lines, [
    { name: 'Vercel', text: 'relay iad1 · instance abcdef12 · bus Upstash Redis' },
    { name: 'Gemini', text: 'gemini-3.5-flash-lite · read at 14:05' },
    { name: 'ElevenLabs', text: 'played 3 · generated 1 · cached 2' },
    { name: 'Snowflake', text: 'project p-42 · Saved to Snowflake' },
    { name: 'Depth Anything V2', text: 'webgpu · ready · 812 ms' },
    { name: 'Tripo', text: '1 ready · 1 running' },
  ]);
});

test('platformLines: depth and Tripo lines before anything ran, when off, and with junk stats', () => {
  const t = (o) => m.platformLines(o).slice(4).map((l) => l.text);
  assert.deepEqual(t({}), ['— · idle · 0 ms', 'off']);
  assert.deepEqual(t({ depth: { state: 'idle', device: null, ms: 0 }, models: { on: true, ready: 0, running: 0, failed: 0, last: '' } }),
    ['— · idle · 0 ms', '0 ready · 0 running']);
  assert.deepEqual(t({ depth: { state: 'saved', device: 'file', ms: 40 }, models: { on: false, ready: 2, running: 0 } }), ['file · saved · 40 ms', 'off']);
  assert.deepEqual(t({ models: { on: true, ready: 0, running: 0, last: 'off' } }).slice(1), ['off'], 'the server has no Tripo key');
  assert.deepEqual(t({ depth: { state: 7, device: 'wasm\nq8', ms: -3 }, models: { on: true, ready: NaN, running: '2' } }),
    ['wasm q8 · idle · 0 ms', '0 ready · 0 running']);
});

test('platformLines: laptop relay, samples, nothing yet, and bad stats', () => {
  const t = (o) => m.platformLines(o).map((l) => l.text);
  assert.deepEqual(t({ hub: { region: 'local', instance: 'x1', bus: 'local' }, scene: { edited: true, model: 'hand-corrected' },
    saved: 'sample', id: 'sample-turner', audio: { played: -1, generated: NaN, cached: '9' } }).slice(0, 4), [
    'laptop relay (Q) · instance x1 · bus local',
    'sample, edited (hand-corrected)',
    'played 0 · generated 0 · cached 0',
    'project sample-turner · sample',
  ]);
  assert.deepEqual(t({}).slice(0, 4), ['relay not connected', 'no reading on screen', 'played 0 · generated 0 · cached 0', 'project — · not saved']);
  assert.deepEqual(t({ hub: { region: 'iad1', bus: 'local' } }).slice(0, 1), ['relay iad1 · instance — · bus local']);
});

test('learningEntries: keeps complete entries in order, cleans them, invents nothing', () => {
  const json = { entries: [
    { who: 'N', at: local(14, 5), text: 'First WebSocket over cellular.', shot: '/learning/n1.png' },
    { who: 'T', text: 'no time' },
    { who: '', text: 'no author' },
    { who: 'D', at: 'Sat 10:15' },
    'junk',
    { who: 'G', at: 'Sat 11:00', text: 'JWT\nworked', shot: 'javascript:x' },
  ] };
  assert.deepEqual(m.learningEntries(json), [
    { who: 'N', at: 'Sat 14:05', text: 'First WebSocket over cellular.', shot: '/learning/n1.png' },
    { who: 'T', at: '', text: 'no time', shot: '' },
    { who: 'G', at: 'Sat 11:00', text: 'JWT worked', shot: '' },
  ]);
  for (const j of [null, {}, { entries: 'x' }, { entries: [] }]) assert.deepEqual(m.learningEntries(j), []);
});

test('learning.json is the empty receipts file the overlay expects', () => {
  const json = JSON.parse(readFileSync(new URL('../src/shared/learning.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(json.entries));
  assert.equal(m.learningEntries(json).length, json.entries.length);
});

test('describeCard: the label and the description on one line each, capped', () => {
  assert.deepEqual(m.describeCard(' old\noak ', 'A tree,\n  painted in two greens.'), { label: 'old oak', text: 'A tree, painted in two greens.' });
  assert.deepEqual(m.describeCard(null, 'Text.'), { label: 'Object', text: 'Text.' });
  assert.equal(m.describeCard('x'.repeat(60), '').label.length, 40);
  assert.equal(m.describeCard('sky', 'y'.repeat(300)).text.length, 240);
  assert.equal(m.describeCard('sky', 42).text, ''); // nothing to show: the card stays hidden
});
