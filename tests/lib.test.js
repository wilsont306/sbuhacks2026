import test from 'node:test';
import assert from 'node:assert/strict';
import { archGeometry } from '../lib/archGeometry.js';
import { checkArch } from '../lib/heyman.js';
import { rpmFor, pistonX } from '../lib/crankSlider.js';
import { writeStl, readStl } from '../lib/stl.js';

for (const [span, rise] of [[128, 24.25], [90, 10], [160, 48], [128, 64], [128, 59.5], [90, 59.5]]) {
  test(`archGeometry ${span} x ${rise}: closed, consistently oriented, positive volume`, () => {
    const { positions: P, indices: I } = archGeometry(span, rise);
    const directed = new Set();
    let vol = 0, minArea = Infinity;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        assert.ok(!directed.has(u + ',' + v), `directed edge ${u}->${v} repeated`);
        directed.add(u + ',' + v);
      }
      const A = [...P.subarray(a * 3, a * 3 + 3)], B = [...P.subarray(b * 3, b * 3 + 3)], C = [...P.subarray(c * 3, c * 3 + 3)];
      const u = B.map((x, i) => x - A[i]), w = C.map((x, i) => x - A[i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      minArea = Math.min(minArea, Math.hypot(...n) / 2);
      vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    }
    // every directed edge once and its reverse present = every edge shared by exactly two triangles, opposite ways
    for (const e of directed) { const [u, v] = e.split(','); assert.ok(directed.has(v + ',' + u), `edge ${e} has one triangle`); }
    assert.ok(vol > 0, `signed volume ${vol}`);
    assert.ok(minArea > 1e-4, `degenerate triangle, area ${minArea}`);
    const keys = new Set(); for (let i = 0; i < P.length; i += 3) keys.add(`${P[i]},${P[i + 1]},${P[i + 2]}`);
    assert.equal(keys.size, P.length / 3, 'duplicate vertex positions');
  });
}

test('heyman: Brunel 128 x 24.25 stands by about 200 mm', () => {
  const r = checkArch(128, 24.25);
  assert.ok(r.stands && r.marginMm >= 150 && r.marginMm <= 250, `marginMm ${r.marginMm}`);
});
test('heyman: 36 ft rise fails at the haunch', () => assert.ok(!checkArch(128, 36).stands));
test('heyman: semicircle fails', () => assert.ok(!checkArch(128, 64).stands));
test('heyman: 10 ft rise stands', () => assert.ok(checkArch(128, 10).stands));

test('crank: 60 mph reads about 240 rpm; piston at dead centres', () => {
  const rpm = rpmFor(60);
  assert.ok(rpm >= 239 && rpm <= 241, `rpm ${rpm}`);
  assert.equal(pistonX(0, 1, 3), 4);
  assert.ok(Math.abs(pistonX(Math.PI, 1, 3) - 2) < 1e-12);
});

test('stl: two-triangle round trip', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.5]), idx = [0, 1, 2, 0, 2, 3];
  const buf = writeStl(pos, idx);
  assert.equal(buf.byteLength, 84 + 50 * 2);
  const { count, positions } = readStl(buf);
  assert.equal(count, 2);
  idx.forEach((v, k) => { for (let c = 0; c < 3; c++) assert.ok(Math.abs(positions[k * 3 + c] - pos[v * 3 + c] * 0.762) < 1e-6); });
});

test('stl: Brunel arch byte length', () => {
  const { positions, indices } = archGeometry(128, 24.25);
  assert.equal(writeStl(positions, indices).byteLength, 84 + 50 * indices.length / 3);
});

test('heyman: 128 x 36 fails at a haunch joint', async () => {
  const { jointRegion } = await import('../lib/heyman.js'), r = checkArch(128, 36);
  assert.ok(!r.stands);
  assert.equal(jointRegion(r.worstJoint, r.N), 'haunch', `worst joint ${r.worstJoint} of ${r.N}`);
});
test('heyman: the semicircle fails at the haunch; Brunel stands, closest at the springing', async () => {
  const { jointRegion } = await import('../lib/heyman.js'), semi = checkArch(128, 64), brunel = checkArch(128, 24.25);
  assert.ok(!semi.stands);
  assert.equal(jointRegion(semi.worstJoint, semi.N), 'haunch', `worst joint ${semi.worstJoint} of ${semi.N}`);
  assert.ok(brunel.stands);
  assert.equal(jointRegion(brunel.worstJoint, brunel.N), 'springing');
});
test('heyman: joint regions split the half-ring at N/4 and N - N/8', async () => {
  const { jointRegion } = await import('../lib/heyman.js');
  assert.deepEqual([0, 8, 9, 27, 28, 32].map((i) => jointRegion(i, 32)), ['crown', 'crown', 'haunch', 'haunch', 'springing', 'springing']);
});
