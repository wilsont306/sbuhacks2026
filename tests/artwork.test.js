// src/host/gallery.js: the mirror, the gallery merge, the save poll verdict, the failure messages and grid moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readMirror, trimMirror, mirrorItem, mergeGallery, pollVerdict, reasonMessage, moveSel, isToday, safeUrl, isSceneUrl,
  storeLine, badgeText, chipText, MIRROR_CAP, MIRROR_SCENE_MAX, GALLERY_CARDS, POLL_AT,
} from '../src/host/gallery.js';

const NOW = new Date(2026, 9, 24, 15, 0).getTime();
const YESTERDAY = new Date(2026, 9, 23, 23, 59).getTime();
const item = (id, at = NOW, extra = {}) => ({ id, name: id, image_url: '/i.jpg', scene_url: '', scene: { id }, title_guess: id, at, ...extra });

test('today is the local calendar day', () => {
  assert.equal(isToday(new Date(2026, 9, 24, 0, 1).getTime(), NOW), true);
  assert.equal(isToday(YESTERDAY, NOW), false);
  assert.equal(isToday(new Date(NOW).toISOString(), NOW), true);
  assert.equal(isToday('nonsense', NOW), false);
});

test('readMirror keeps only today\'s well-formed entries and survives garbage', () => {
  assert.deepEqual(readMirror(null, NOW), []);
  assert.deepEqual(readMirror('{not json', NOW), []);
  assert.deepEqual(readMirror('{"a":1}', NOW), []);
  const raw = JSON.stringify([item('a'), item('b', YESTERDAY), { id: '' , at: NOW }, 7, item('c')]);
  assert.deepEqual(readMirror(raw, NOW).map((e) => e.id), ['a', 'c']);
});

test('trimMirror puts the new entry first, drops old days and duplicates, caps the list', () => {
  const list = [item('a'), item('b', YESTERDAY), item('c')];
  assert.deepEqual(trimMirror(list, item('c'), NOW).map((e) => e.id), ['c', 'a']);
  const many = Array.from({ length: 80 }, (_, i) => item('p' + i));
  const out = trimMirror(many, item('new'), NOW);
  assert.equal(out.length, MIRROR_CAP);
  assert.equal(out[0].id, 'new');
});

test('trimMirror leaves out a scene over the size cap but keeps the entry', () => {
  const big = item('big', NOW, { scene: { id: 'big', pad: 'x'.repeat(MIRROR_SCENE_MAX) } });
  const [e] = trimMirror([], big, NOW);
  assert.equal(e.id, 'big');
  assert.equal(e.scene, null);
  assert.deepEqual(trimMirror([], item('small'), NOW)[0].scene, { id: 'small' });
});

test('mirrorItem carries the fields the gallery needs', () => {
  const scene = { id: 'x1', title_guess: 'Starry', source: 'phone', image_url: 'https://a/i.jpg', scene_url: 'https://a/s.json' };
  assert.deepEqual(mirrorItem(scene, NOW), { id: 'x1', name: 'Starry', source: 'phone', image_url: 'https://a/i.jpg', scene_url: 'https://a/s.json', scene, title_guess: 'Starry', at: NOW });
});

test('mergeGallery dedupes by id, prefers the Snowflake row, keeps the local scene, newest first, samples last', () => {
  const samples = [{ n: 2, id: 'sample-b', name: 'B', image: '/b.jpg', scene: '/samples/b.json' }, { n: 1, id: 'sample-a', name: 'A', image: '/a.jpg', scene: '/samples/a.json' }];
  const local = [item('l1', NOW - 1000), item('both', NOW - 5000)];
  const remote = [
    { id: 'both', name: 'Both', source: 'phone', image_url: 'https://x/both.jpg', scene_url: 'https://x/both.json', title_guess: 'Both', created_at: new Date(NOW - 5000).toISOString() },
    { id: 'r1', name: 'R1', source: 'drop', image_url: 'https://x/r1.jpg', scene_url: '', title_guess: '', created_at: new Date(NOW).toISOString() },
    { id: 'sample-a', name: 'dup of a sample' },
  ];
  const cards = mergeGallery({ samples, local, remote });
  assert.deepEqual(cards.map((c) => c.id), ['r1', 'l1', 'both', 'sample-a', 'sample-b']);
  const both = cards.find((c) => c.id === 'both');
  assert.equal(both.saved, 'saved');
  assert.equal(both.source, 'phone');
  assert.deepEqual(both.scene, { id: 'both' });
  assert.equal(cards.find((c) => c.id === 'l1').saved, 'local');
  assert.equal(cards.find((c) => c.id === 'r1').title, 'R1');
  assert.equal(cards.find((c) => c.id === 'sample-a').n, 1);
  assert.equal(cards.find((c) => c.id === 'sample-a').saved, 'sample');
});

test('mergeGallery caps at 12 and always keeps room for the samples', () => {
  const samples = [1, 2, 3].map((n) => ({ n, id: 'sample-' + n, name: 'S' + n, image: '/s.jpg', scene: '/s.json' }));
  const local = Array.from({ length: 20 }, (_, i) => item('p' + i, NOW - i));
  const cards = mergeGallery({ samples, local }, GALLERY_CARDS);
  assert.equal(cards.length, GALLERY_CARDS);
  assert.deepEqual(cards.slice(-3).map((c) => c.id), ['sample-1', 'sample-2', 'sample-3']);
  assert.equal(cards[0].id, 'p0');
});

test('mergeGallery drops unsafe URLs and malformed entries', () => {
  const cards = mergeGallery({ local: [item('ok', NOW, { image_url: 'javascript:alert(1)' }), { id: 5 }, null], remote: 'nope' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].image, '');
  assert.deepEqual(mergeGallery(), []);
});

test('safeUrl and isSceneUrl', () => {
  assert.equal(safeUrl('/samples/a.svg'), '/samples/a.svg');
  assert.equal(safeUrl('https://x.public.blob.vercel-storage.com/art/a.jpg'), 'https://x.public.blob.vercel-storage.com/art/a.jpg');
  assert.equal(safeUrl('//evil.example/a.jpg'), '');
  assert.equal(safeUrl('data:image/png;base64,AAAA'), '');
  assert.equal(safeUrl(42), '');
  assert.equal(isSceneUrl('https://abc123.public.blob.vercel-storage.com/scenes/0f9e-11.json'), true);
  assert.equal(isSceneUrl('https://evil.example/scenes/a.json'), false);
  assert.equal(isSceneUrl('http://abc.public.blob.vercel-storage.com/scenes/a.json'), false);
});

test('pollVerdict: saved only on a 200 row; local when Snowflake is not configured; else wait', () => {
  assert.equal(pollVerdict(200, { ok: true, project: {} }), 'saved');
  assert.equal(pollVerdict(404, { ok: false }), 'wait');
  assert.equal(pollVerdict(503, { ok: false, configured: true, error: 'unavailable' }), 'wait');
  assert.equal(pollVerdict(404, { ok: false, configured: false }), 'local');
  assert.equal(pollVerdict(0, null), 'wait');
  assert.deepEqual(POLL_AT, [3000, 10000, 30000]);
});

test('reasonMessage covers busy, quota, storage and everything else', () => {
  assert.equal(reasonMessage('busy'), 'One at a time: try again in a few seconds');
  assert.match(reasonMessage('quota'), /resting/);
  assert.match(reasonMessage('storage'), /unsaved/);
  for (const r of ['timeout', 'no_key', 'offline', undefined]) assert.equal(reasonMessage(r), "Couldn't read this one; walking on the flat painting");
});

test('storeLine names the local-only cases', () => {
  assert.match(storeLine(null), /Checking/);
  assert.match(storeLine({ ok: true, projects: [], configured: true }), /Snowflake/);
  assert.match(storeLine({ ok: true, projects: [], configured: false }), /^Local only/);
  assert.match(storeLine({ ok: false, configured: true, error: 'unavailable', projects: [] }), /^Local only/);
  assert.match(storeLine(undefined), /^Local only/);
});

test('badges and chips are words, not colours', () => {
  assert.equal(badgeText('saved'), 'Saved to Snowflake');
  assert.equal(badgeText('local'), 'Local only');
  assert.equal(badgeText('sample'), 'Hand-corrected');
  assert.equal(chipText('phone'), 'Phone');
  assert.equal(chipText('drop'), 'Laptop');
  assert.equal(chipText('sample'), 'Sample');
});

test('moveSel walks a 4-wide grid and stops at the edges', () => {
  assert.equal(moveSel(0, 'ArrowRight', 10), 1);
  assert.equal(moveSel(0, 'ArrowLeft', 10), 0);
  assert.equal(moveSel(1, 'ArrowDown', 10), 5);
  assert.equal(moveSel(8, 'ArrowDown', 10), 8);
  assert.equal(moveSel(5, 'ArrowUp', 10), 1);
  assert.equal(moveSel(9, 'ArrowRight', 10), 9);
  assert.equal(moveSel(3, 'Enter', 10), 3);
  assert.equal(moveSel(7, 'ArrowLeft', 3), 2);
  assert.equal(moveSel(0, 'ArrowRight', 0), 0);
});
