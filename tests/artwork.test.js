// src/host/gallery.js: the mirror, the gallery merge, the save poll verdict, the failure messages, shelf moves and peeks;
// and src/host/artwork.js's sidebar hit test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateScene } from '../src/shared/scene-validate.js';
import {
  readMirror, trimMirror, mirrorItem, mergeGallery, pollVerdict, reasonMessage, isToday, safeUrl, isSceneUrl,
  moveShelf, peekLayers, MIRROR_CAP, MIRROR_SCENE_MAX, GALLERY_CARDS, POLL_AT, PEEK_Z,
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

test('a sample card carries its short artist line; a project has none', () => {
  const cards = mergeGallery({ samples: [{ id: 's1', n: 1, scene: '/a.json', by: 'Turner, 1844' }], local: [item('a')] });
  assert.deepEqual(cards.map((c) => [c.id, c.by]), [['a', ''], ['s1', 'Turner, 1844']]);
});

test('moveShelf walks along a shelf, hops to the nearest non-empty one, and stops at edges', () => {
  const sizes = [4, 0, 3];
  assert.deepEqual(moveShelf({ s: 0, i: 0 }, 'ArrowRight', sizes), { s: 0, i: 1 });
  assert.deepEqual(moveShelf({ s: 0, i: 0 }, 'ArrowLeft', sizes), { s: 0, i: 0 });
  assert.deepEqual(moveShelf({ s: 0, i: 3 }, 'ArrowRight', sizes), { s: 0, i: 3 });
  assert.deepEqual(moveShelf({ s: 0, i: 3 }, 'ArrowDown', sizes), { s: 2, i: 2 }, 'skips the empty shelf, clamps to its end');
  assert.deepEqual(moveShelf({ s: 2, i: 1 }, 'ArrowUp', sizes), { s: 0, i: 1 });
  assert.deepEqual(moveShelf({ s: 2, i: 1 }, 'ArrowDown', sizes), { s: 2, i: 1 });
  assert.deepEqual(moveShelf({ s: 0, i: 2 }, 'Enter', sizes), { s: 0, i: 2 });
  assert.deepEqual(moveShelf({ s: 1, i: 5 }, 'ArrowRight', sizes), { s: 0, i: 0 }, 'a stale selection lands on the first item');
  assert.deepEqual(moveShelf({ s: 0, i: 0 }, 'ArrowDown', [0, 0]), { s: 0, i: 0 });
});

test('peekLayers lifts objects far first along their masks and leaves the receding surfaces', () => {
  const layers = peekLayers({ objects: [
    { label: 'Dog', kind: 'animal', depth: 0, motion: 'bob', mask: [[100, 500], [300, 500], [200, 900]], box: [100, 500, 300, 900] },
    { label: 'Sky', kind: 'sky', depth: 1, box: [0, 0, 1000, 400] },
    { label: 'Sun', kind: 'celestial', depth: 1, motion: 'spin', box: [700, 50, 900, 250] },
    { label: 'Bad', kind: 'object', mask: [[1, 2]] },
    { label: 'Speck', kind: 'animal', box: [500, 500, 520, 520] },
  ] });
  assert.deepEqual(layers.map((l) => l.label), ['Sun', 'Dog']);
  assert.equal(layers[0].z, PEEK_Z[0]);
  assert.equal(layers[1].z, PEEK_Z[1]);
  assert.equal(layers[0].clip, 'polygon(70% 5%, 90% 5%, 90% 25%, 70% 25%)', 'no mask: the box');
  assert.equal(layers[1].clip, 'polygon(10% 50%, 30% 50%, 20% 90%)');
  assert.equal(layers[1].origin, '20% 90%');
  assert.deepEqual(layers[1].points, [[100, 500], [300, 500], [200, 900]]);
  assert.equal(layers[1].surface, false);
  const all = peekLayers({ objects: [{ label: 'Sky', kind: 'sky', depth: 1, box: [0, 0, 1000, 400] }, { label: 'Dog', kind: 'animal', box: [100, 500, 300, 900] }] }, { surfaces: true });
  assert.deepEqual(all.map((l) => [l.label, l.surface]), [['Sky', true], ['Dog', false]], 'surfaces on request, marked');
  assert.equal(layers[1].motion, 'bob');
  assert.deepEqual(peekLayers(null), []);
  assert.deepEqual(peekLayers({ objects: 'x' }), []);
});

// src/host/artwork.js imports CSS and touches the DOM, so only its pure block is loaded, as tests/glue.test.js does.
const artSrc = readFileSync(new URL('../src/host/artwork.js', import.meta.url), 'utf8');
const art = await import('data:text/javascript,' + encodeURIComponent(artSrc.slice(artSrc.indexOf('/* pure:start'), artSrc.indexOf('/* pure:end */'))));

test('partAt names the smallest outline under the point, so a part inside a bigger one stays reachable', () => {
  const sky = { points: [[0, 0], [1000, 0], [1000, 500], [0, 500]] };
  const star = { points: [[400, 100], [420, 100], [420, 120], [400, 120]] };
  const tri = { points: [[0, 600], [200, 600], [100, 900]] };
  const flat = { points: [[0, 0], [500, 500], [1000, 1000]] };
  assert.equal(art.partAt([sky, star], 410, 110), 1, 'the star, though the sky comes first');
  assert.equal(art.partAt([star, sky], 410, 110), 0);
  assert.equal(art.partAt([sky, star], 600, 300), 0);
  assert.equal(art.partAt([sky, star, tri], 100, 700), 2);
  assert.equal(art.partAt([sky, star, tri], 190, 880), -1, 'outside the triangle');
  assert.equal(art.partAt([sky, star], 500, 800), -1);
  assert.equal(art.partAt([flat], 500, 500), -1, 'a zero-area outline holds nothing');
  assert.equal(art.partAt([], 1, 1), -1);
});

test('the sidebar can point at every object of the three samples', () => {
  for (const name of ['turner', 'sketch', 'starry-night']) {
    const raw = JSON.parse(readFileSync(new URL(`../public/samples/${name}.scene.json`, import.meta.url), 'utf8'));
    const objects = validateScene(raw, raw).objects;
    // The sidebar's geometry: each object's mask, else its box (peekLayers keeps the same points for the parts it cuts out).
    const parts = objects.map((o) => ({ points: o.mask || [[o.box[0], o.box[1]], [o.box[2], o.box[1]], [o.box[2], o.box[3]], [o.box[0], o.box[3]]] }));
    const reach = objects.map(() => 0);
    for (let x = 1; x < 1000; x += 3) for (let y = 1; y < 1000; y += 3) { const i = art.partAt(parts, x, y); if (i >= 0) reach[i]++; }
    objects.forEach((o, i) => assert.ok(reach[i] > 0, `${name}: ${o.label}`));
  }
});
