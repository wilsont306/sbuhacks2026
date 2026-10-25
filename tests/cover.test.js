// src/host/cover.js's crumple: its clip-path stops. cover.js imports CSS and other modules and touches the DOM, so
// this loads only its pure block (between the pure:start and pure:end markers), as tests/margins.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/host/cover.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('/* pure:start'), src.indexOf('/* pure:end */'));
const m = await import('data:text/javascript,' + encodeURIComponent(block));

const points = (poly) => poly.slice('polygon('.length, -1).split(', ').map((p) => p.split(' ').map(parseFloat));

test('crumpleStops: three polygons of the same point count, so the browser can morph one into the next', () => {
  const stops = m.crumpleStops(28);
  assert.equal(stops.length, 3);
  for (const s of stops) { assert.match(s, /^polygon\(/); assert.equal(points(s).length, 28); }
  assert.deepEqual(m.crumpleStops(28), stops, 'the same crumple every time');
});

test('crumpleStops: the page edge, then folded in, then a small round ball, each point on its own ray', () => {
  const [flat, fold, ball] = m.crumpleStops(28).map(points);
  assert.deepEqual(flat[0], [0, 0]); // the top-left corner first, then clockwise
  for (const [x, y] of flat) assert.ok(x === 0 || x === 100 || y === 0 || y === 100, `${x} ${y} on the edge`);
  fold.forEach(([x, y], i) => {
    const [fx, fy] = flat[i];
    assert.ok(Math.hypot(x - 50, y - 50) < Math.hypot(fx - 50, fy - 50), 'pulled toward the middle');
  });
  // On a 16:9 page the ball is round in pixels: radii within 7 to 12.5 % of the width either way.
  for (const [x, y] of ball) {
    const r = Math.hypot(x - 50, (y - 50) / (16 / 9));
    assert.ok(r >= 6.9 && r <= 12.6, `ball radius ${r}`);
  }
  // Same order round the middle as the page edge: no point crosses another, so the morph never twists.
  const angle = ([x, y]) => Math.atan2((y - 50) / (16 / 9), x - 50);
  const turn = (pts) => pts.map(angle).map((a, i, as) => ((as[(i + 1) % as.length] - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  assert.ok(turn(ball).every((d) => d > 0), 'ball points run clockwise like the edge');
});
