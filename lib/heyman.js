// Heyman-style thrust-line check, ported unchanged from the prototype's archCheck.
// Semi-elliptical centreline; ring 5 ft 3 in at the crown to 7 ft at the springing; spandrel fill
// (relative density 0.85) to a level surface 2 ft above the crown. A model, not a record of the bridge.
export const RING_CROWN_FT = 5.25;
export const RING_SPRING_FT = 7;
const N = 32, RHO = 0.85, COVER = 2;

// Centreline joints (i = 0 at the crown, i = N at the springing) and ring thickness per joint; shared with archGeometry.
export function ring(spanFt, riseFt) {
  const a = spanFt / 2, b = riseFt, pts = [], tk = [];
  for (let i = 0; i <= N; i++) {
    const th = Math.PI / 2 * (1 - i / N);
    pts.push([a * Math.cos(th), b * Math.sin(th)]);
    tk.push(RING_CROWN_FT + (RING_SPRING_FT - RING_CROWN_FT) * (1 - Math.sin(th)));
  }
  return { a, b, N, pts, tk };
}

export function checkArch(spanFt, riseFt) {
  const { a, b, pts, tk } = ring(spanFt, riseFt), tc = RING_CROWN_FT;
  const surface = b + tc / 2 + COVER, wts = [], xm = [];
  let Wtot = 0;
  for (let i = 0; i < N; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], tm = (tk[i] + tk[i + 1]) / 2;
    const ringW = Math.hypot(x1 - x0, y1 - y0) * tm, ymid = (y0 + y1) / 2, dx = Math.abs(x1 - x0);
    const fillW = RHO * Math.max(0, surface - (ymid + tm / 2)) * dx;
    wts.push(ringW + fillW); xm.push((x0 + x1) / 2); Wtot += ringW + fillW;
  }
  const Ms = [];
  for (let i = 0; i <= N; i++) { let M = 0; for (let k = 0; k < i; k++) M += wts[k] * (pts[i][0] - xm[k]); Ms.push(M); }
  const Hnom = Ms[N] / b;
  let best = { margin: -1e9, H: Hnom, y0: b, worst: 0 };
  for (let yi = 0; yi < 25; yi++) {
    const yc0 = b - tc / 2 + tc * yi / 24;
    for (let hi = 0; hi < 90; hi++) {
      const H = Hnom * 0.25 * Math.pow(16, hi / 89);
      let margin = 1e9, worst = 0;
      for (let i = 0; i <= N; i++) {
        const m = tk[i] / 2 - Math.abs((yc0 - Ms[i] / H) - pts[i][1]);  // vertical deviation
        if (m < margin) { margin = m; worst = i; }
      }
      if (margin > best.margin) best = { margin, H, y0: yc0, worst };
    }
  }
  const line = pts.map((p, i) => [p[0], best.y0 - Ms[i] / best.H]);
  return {
    a, b, N, pts, tk, line,
    marginFt: best.margin, marginMm: Math.round(best.margin * 304.8), worstJoint: best.worst,
    H: best.H, push: best.H / Wtot, stands: best.margin > 0,
  };
}

// Where joint i of N (0 at the crown, N at the springing) sits on the ring: the readout names the region, not the joint.
export const jointRegion = (i, N) => (i <= N / 4 ? 'crown' : i >= N - N / 8 ? 'springing' : 'haunch');
