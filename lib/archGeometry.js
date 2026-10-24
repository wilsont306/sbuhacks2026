// One closed 2-manifold shell for the viaduct arch: a 2D profile (ring + abutments + baseplate, arch opening
// as a hole) triangulated by keyhole bridge + ear clipping, then extruded across the width.
// Feet; x along the span centred at 0, y up with the springing line at y = 0, z across the width centred at 0.
import { ring } from './heyman.js';

const EPS = 0.05;  // ft; intrados joints closer than this to y = 0 are dropped so the crossing vertex makes no sliver

// abutmentFt is both the block's width outboard of the springing and its depth below the springing line.
export function archGeometry(spanFt, riseFt, { widthFt = 30, abutmentFt = 12, baseFt = 3 } = {}) {
  const { a, N, pts, tk } = ring(spanFt, riseFt);
  if (!(riseFt - tk[0] / 2 > EPS) || !(abutmentFt > 0) || !(baseFt > 0) || !(widthFt > 0)) throw new Error('archGeometry: bad dimensions');
  const joints = pts.map(([x, y], i) => ({ x, yIn: y - tk[i] / 2, yOut: y + tk[i] / 2 }));
  const X = a + abutmentFt, yTop = joints[N].yOut, baseTop = -abutmentFt, yBot = baseTop - baseFt;

  // The intrados below y = 0 is buried in the abutment: the opening's side faces stand at the y = 0 crossing.
  let k = 0;
  while (joints[k + 1].yIn > EPS) k++;
  const j0 = joints[k], j1 = joints[k + 1], x0 = j0.x + (j1.x - j0.x) * j0.yIn / (j0.yIn - j1.yIn);

  const P = [];  // flat 2D points; index = profile point id
  const add = (x, y) => (P.push(x, y), P.length / 2 - 1);
  // Outer boundary, CCW, starting at the baseplate's bottom-right corner (the bridge's outer end).
  const outer = [add(X, yBot), add(X, yTop)];
  for (let i = N; i >= 0; i--) outer.push(add(joints[i].x, joints[i].yOut));
  for (let i = 1; i <= N; i++) outer.push(add(-joints[i].x, joints[i].yOut));
  outer.push(add(-X, yTop), add(-X, yBot));
  // Opening, CW, starting at its bottom-right corner (the bridge's inner end).
  const hole = [add(x0, baseTop), add(-x0, baseTop), add(-x0, 0)];
  for (let i = k; i >= 1; i--) hole.push(add(-joints[i].x, joints[i].yIn));
  for (let i = 0; i <= k; i++) hole.push(add(joints[i].x, joints[i].yIn));
  hole.push(add(x0, 0));
  // Keyhole: (X, yBot) -> (x0, baseTop) runs through solid abutment and baseplate for any positive dimensions.
  const cap = earClip(P, [...outer, outer[0], ...hole, hole[0]]);

  const n = P.length / 2, hw = widthFt / 2, positions = new Float32Array(n * 6), idx = [];
  for (let p = 0; p < n; p++) { positions.set([P[2 * p], P[2 * p + 1], hw], p * 3); positions.set([P[2 * p], P[2 * p + 1], -hw], (p + n) * 3); }
  for (let t = 0; t < cap.length; t += 3) idx.push(cap[t], cap[t + 1], cap[t + 2], cap[t + 2] + n, cap[t + 1] + n, cap[t] + n);
  // Side walls: both loops keep the solid on their left, so the outward normal is to the right of travel.
  for (const loop of [outer, hole]) loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length];
    idx.push(p + n, q + n, q, p + n, q, p);
  });
  let maxY = -Infinity;
  for (let p = 0; p < n; p++) maxY = Math.max(maxY, P[2 * p + 1]);
  return { positions, indices: Uint32Array.from(idx), joints, bbox: { min: [-X, yBot, -hw], max: [X, maxY, hw] } };
}

// Ear clipping of a CCW (weakly simple) loop of point ids; repeated ids are the keyhole bridge.
function earClip(P, loop) {
  const cr = (a, b, c) => (P[2 * b] - P[2 * a]) * (P[2 * c + 1] - P[2 * a + 1]) - (P[2 * b + 1] - P[2 * a + 1]) * (P[2 * c] - P[2 * a]);
  const v = loop.slice(), tris = [];
  while (v.length > 3) {
    let i = 0;
    for (; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length], b = v[i], c = v[(i + 1) % v.length];
      if (cr(a, b, c) <= 1e-9) continue;  // reflex or collinear
      // -1e-3 ft²: a hole vertex on (or round-off just outside) the diagonal still blocks the ear, so no sliver facet
      if (!v.some(p => p !== a && p !== b && p !== c && cr(a, b, p) >= -1e-3 && cr(b, c, p) >= -1e-3 && cr(c, a, p) >= -1e-3)) break;
    }
    if (i === v.length) throw new Error('archGeometry: ear clipping found no ear');
    tris.push(v[(i + v.length - 1) % v.length], v[i], v[(i + 1) % v.length]);
    v.splice(i, 1);
  }
  return tris.concat(v);
}
