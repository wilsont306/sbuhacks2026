// node:test suite for src/shared/lineart.js: is a picture ink on blank paper (no depth for it) or a painting?
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isLineArt, paperGains, paperOutside } from '../src/shared/lineart.js';

// The samples' own pictures, decoded by sharp (installed with @huggingface/transformers); skipped if it will not load.
let sharp = null;
try { sharp = createRequire(import.meta.url)('sharp'); } catch (e) { sharp = null; }
const raw = async (img) => { const { data, info } = await img.raw().toBuffer({ resolveWithObject: true }); return [data, info.width, info.height]; };

test('the samples: the sketch is line art, Turner and The Starry Night are not, at full size and as small copies', { skip: sharp ? false : 'sharp is not installed' }, async () => {
  for (const [file, want] of [['samples/sketch.svg', true], ['assets/turner-1920.jpg', false], ['samples/starry-night.jpg', false]]) {
    // the SVG at half its 1600 px (its paper-grain filter takes seconds to render at full size)
    const full = await raw(sharp(readFileSync(new URL(`../public/${file}`, import.meta.url)), { density: 36 }).ensureAlpha());
    assert.equal(isLineArt(...full), want, `${file} at ${full[1]} by ${full[2]}`);
    for (const size of [256, 64]) { // the TV and the phone read a smoothed 256 px copy
      const small = await raw(sharp(full[0], { raw: { width: full[1], height: full[2], channels: 4 } }).resize(size, size, { fit: 'fill' }));
      assert.equal(isLineArt(...small), want, `${file} at ${size} px`);
    }
  }
});

// Synthetic pictures, w by h RGBA, from fn(i, j) -> [r, g, b].
function picture(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = 4 * (j * w + i), c = fn(i, j); data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 255; }
  return data;
}
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const W = 320, H = 240;
// A drawing: ink outlines (3 px), a few pastel washes inside them, on paper of the given colour with a little grain.
function drawing(paper, grain, seed) {
  const rnd = lcg(seed);
  const shapes = [[60, 50, 40, '#f2c14e'], [200, 140, 60, '#7fae6a'], [120, 170, 35, '#7fb3d5'], [260, 60, 28, '#d98c5f']];
  const rgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  return picture(W, H, (i, j) => {
    const g = (rnd() * 2 - 1) * grain;
    for (const [cx, cy, r, fill] of shapes) {
      const d = Math.hypot(i - cx, j - cy);
      if (Math.abs(d - r) < 1.5) return [43 + g, 42 + g, 51 + g]; // the ink line
      if (d < r) return rgb(fill).map((c, k) => (c + paper[k]) / 2 + g); // a half-strength wash
    }
    if (j === 200 || (i === 30 && j > 100)) return [43, 42, 51]; // a ground line and a post
    return paper.map((c) => c + g);
  });
}
// A painting: overlapping colour fields with brushwork, through the mid-tones.
function painting(seed, lift) {
  const rnd = lcg(seed);
  return picture(W, H, (i, j) => {
    const n = (rnd() * 2 - 1) * 30, a = Math.sin(i / 23) * 40, b = Math.cos(j / 17 + i / 41) * 40;
    return [90 + a + n + lift, 110 + b + n + lift, 140 - a / 2 + n + lift];
  });
}

test('ink on paper is line art: white, off-white, photographed grey and warm paper, with or without washes', () => {
  assert.equal(isLineArt(drawing([255, 255, 255], 0, 1), W, H), true, 'white paper');
  assert.equal(isLineArt(drawing([244, 239, 227], 6, 2), W, H), true, 'the sketch sample\'s cream paper with grain');
  assert.equal(isLineArt(drawing([196, 194, 188], 8, 3), W, H), true, 'a phone photo of a page, greyer than the print');
  assert.equal(isLineArt(drawing([226, 210, 186], 5, 4), W, H), true, 'under warm light');
  const bare = picture(W, H, (i, j) => (i % 40 < 2 || j % 50 < 2 ? [20, 20, 20] : [250, 250, 250])); // a ruled grid of ink
  assert.equal(isLineArt(bare, W, H), true, 'only lines');
});

test('paintings and photos of paintings are not line art', () => {
  assert.equal(isLineArt(painting(5, 0), W, H), false, 'a painting');
  assert.equal(isLineArt(painting(6, 60), W, H), false, 'a pale painting');
  // Turner-like haze: pale, low-saturation yellows and greys, but a soft gradient through the mid-tones
  assert.equal(isLineArt(picture(W, H, (i, j) => { const v = 120 + 80 * Math.sin(i / W * Math.PI) * (1 - j / H / 2); return [v + 12, v + 6, v - 18]; }), W, H), false, 'haze');
  // a painting photographed on a white gallery wall that fills 60% of the frame
  const art = painting(7, 0);
  const wall = picture(W, H, (i, j) => {
    if (i < 70 || i >= 250 || j < 50 || j >= 190) return [238, 236, 230];
    const k = 4 * (j * W + i);
    return [art[k], art[k + 1], art[k + 2]];
  });
  assert.equal(isLineArt(wall, W, H), false, 'a painting on a white wall');
  assert.equal(isLineArt(picture(W, H, () => [255, 210, 60]), W, H), false, 'a pale saturated colour is not paper');
  assert.equal(isLineArt(picture(W, H, () => [20, 20, 30]), W, H), false, 'a night scene');
});

test('a large picture is sampled on a grid of at most about 64k pixels, with the same answer', () => {
  const big = 2048, px = new Uint8ClampedArray(big * big * 4).fill(250);
  for (let j = 0; j < big; j += 64) px.fill(30, 4 * j * big, 4 * (j + 2) * big); // ink rules every 64 rows
  let reads = 0;
  const counted = new Proxy(px, { get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k); } });
  assert.equal(isLineArt(counted, big, big), true);
  assert.ok(reads <= 2 * 3 * 70000, `${reads} channel reads`); // two passes: the paper's white balance, then the count
});

test('anything unreadable is not line art, and never throws', () => {
  for (const [d, w, h] of [[null, 2, 2], [undefined, 2, 2], [new Uint8Array(15), 2, 2], [new Uint8Array(16).fill(255), 2.5, 2], [new Uint8Array(16), 0, 4],
    [new Uint8Array(16), -2, -2], ['x', 1, 1], [new Uint8Array(16), NaN, 2], [{}, 1, 1]]) {
    assert.equal(isLineArt(d, w, h), false, `${w} by ${h}`);
  }
  assert.equal(isLineArt(new Uint8Array(4).fill(255), 1, 1), true, 'one white pixel is blank paper');
});

// A picture under a colour cast or exposure change: each channel times k.
const cast = (data, k) => { const out = new Uint8ClampedArray(data.length); for (let i = 0; i < data.length; i++) out[i] = i % 4 === 3 ? data[i] : data[i] * k[i % 4]; return out; };
const WARM = [1, 0.95, 0.86], WARMER = [1, 0.92, 0.78], DIM = [0.75, 0.75, 0.75];

test('the samples under warm light or dim exposure: the sketch is still line art, the paintings still are not', { skip: sharp ? false : 'sharp is not installed' }, async () => {
  for (const [file, want] of [['samples/sketch.svg', true], ['assets/turner-1920.jpg', false], ['samples/starry-night.jpg', false]]) {
    const full = await raw(sharp(readFileSync(new URL(`../public/${file}`, import.meta.url)), { density: 36 }).ensureAlpha());
    const small = await raw(sharp(full[0], { raw: { width: full[1], height: full[2], channels: 4 } }).resize(256, 256, { fit: 'fill' }));
    for (const k of [WARM, WARMER, DIM]) assert.equal(isLineArt(cast(small[0], k), 256, 256), want, `${file} at ${k}`);
    if (!want) assert.equal(isLineArt(cast(small[0], [1.25, 1.25, 1.25]), 256, 256), false, `${file} overexposed`);
  }
});

test('a drawing photographed under warm light or dim exposure is balanced against its paper; a painting is not lifted into paper', () => {
  for (const k of [WARM, WARMER, DIM, [0.8, 0.76, 0.68]]) {
    assert.equal(isLineArt(cast(drawing([255, 255, 255], 4, 8), k), W, H), true, `white paper at ${k}`);
    assert.equal(isLineArt(cast(drawing([244, 239, 227], 6, 9), k), W, H), true, `cream paper at ${k}`);
    assert.equal(isLineArt(cast(painting(10, 0), k), W, H), false, `a painting at ${k}`);
    assert.equal(isLineArt(cast(painting(11, 60), k), W, H), false, `a pale painting at ${k}`);
  }
  // the gains: white paper needs none, a warm page its channels' reciprocals, a dark or saturated picture none at all
  const near = (a, b, msg) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 0.03), `${msg}: ${a}`);
  near(paperGains(drawing([255, 255, 255], 0, 1), W, H), [1, 1, 1], 'white');
  near(paperGains(cast(drawing([255, 255, 255], 0, 1), WARMER), W, H), WARMER.map((k) => 1 / k), 'warm');
  near(paperGains(picture(W, H, () => [255, 210, 60]), W, H), [1, 1, 1], 'a saturated yellow has no paper');
  near(paperGains(picture(W, H, () => [60, 60, 70]), W, H), [1, 1, 1], 'a night scene has no paper');
  near(paperGains(null, 2, 2), [1, 1, 1], 'unreadable');
});

test('paperOutside: the bare paper joined to the crop\'s edge, not the washes or the paper the ink closes in', () => {
  const w = 60, h = 40;
  // an ink ring (radius 14) with a pale blue wash, and inside the wash a ring of ink closing in a dot of bare paper
  const shape = (gap) => picture(w, h, (i, j) => {
    const d = Math.hypot(i - 30, j - 20), a = Math.atan2(j - 20, i - 30);
    if (Math.abs(d - 14) < 1.2 && !(gap && Math.abs(a) < 0.2)) return [40, 40, 45];
    if (Math.abs(d - 5) < 1.2) return [40, 40, 45];
    if (d < 5) return [252, 251, 248];
    if (d < 14) return [190, 214, 235];
    return [250, 248, 240];
  });
  const at = (m, i, j) => m[j * w + i];
  let m = paperOutside(shape(false), w, h, [1, 1, 1]);
  assert.equal(at(m, 2, 2), 1, 'the corner\'s paper');
  assert.equal(at(m, 58, 20), 1, 'paper beside the ring');
  assert.equal(at(m, 30, 6), 0, 'the ink');
  assert.equal(at(m, 30, 10), 0, 'the wash stays (it is no bare paper)');
  assert.equal(at(m, 30, 20), 0, 'the paper the ink closes in stays');
  // under a warm cast the same, given the picture's gains; without them the cast paper is not bare paper
  const warm = cast(shape(false), WARMER), g = paperGains(warm, w, h);
  assert.deepEqual(Array.from(paperOutside(warm, w, h, g)), Array.from(m), 'balanced');
  assert.equal(at(paperOutside(warm, w, h, [1, 1, 1]), 2, 2), 0, 'unbalanced, the cast paper is not cut');
  // a gap in the outer ring lets the paper in only as far as the wash
  m = paperOutside(shape(true), w, h, [1, 1, 1]);
  assert.equal(at(m, 30, 10), 0, 'the wash still stays');
  assert.equal(at(m, 30, 20), 0, 'and the closed-in paper');
  for (const [d, ww, hh] of [[null, 2, 2], [new Uint8Array(3), 2, 2], [new Uint8Array(16), 0, 4]]) assert.equal(paperOutside(d, ww, hh).length, 0);
  assert.equal(paperOutside(new Uint8Array(16).fill(255), 2, 2, 'x').reduce((a, b) => a + b, 0), 4, 'bad gains are none');
});
