// Debug overlay on the backtick key: the 8 path dots, the curve and the stops (path.plaques), drawn through the live
// camera. Drag a dot to move it (h is baked from the depth at the drop point); drag a stop along the curve to
// change its t. Changes apply live; "Save path.json" downloads the README schema. size() returns the plane and
// relief amplitude now, since both change per scene and per layer.
import * as THREE from 'three';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function pathJson(p) {
  const rows = (a) => a.map((q) => '    ' + JSON.stringify(q)).join(',\n');
  return `{\n  "image": ${JSON.stringify(p.image)},\n  "points": [\n${rows(p.points)}\n  ],\n  "plaques": [\n${rows(p.plaques)}\n  ]\n}\n`;
}

export function createPathOverlay({ stage, camera, size, getPath, getCurve, sample, onChange }) {
  const c = document.createElement('canvas'), save = document.createElement('button');
  c.width = 1447; c.height = 1080; c.className = 'path-overlay'; c.hidden = true;
  save.type = 'button'; save.className = 'btn path-save'; save.textContent = 'Save path.json'; save.hidden = true;
  stage.append(c, save);
  const g = c.getContext('2d'), v = new THREE.Vector3(), hit = new THREE.Vector3(), ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const screen = (u, vv, h) => { const { W, H, AMP } = size(); v.set((u - 0.5) * W, (vv - 0.5) * H, h * AMP).project(camera); return [(v.x + 1) / 2 * c.width, (1 - v.y) / 2 * c.height]; };
  const onCurve = (t) => { const q = getCurve().getPoint(t); return screen(q.x, q.y, q.z); };
  const local = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * c.width, (e.clientY - r.top) / r.height * c.height]; };
  let drag = null;

  c.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e), near = ([px, py]) => Math.hypot(px - x, py - y) < 20, p = getPath();
    const i = p.points.findIndex((q) => near(screen(...q)));
    const pl = i < 0 ? p.plaques.find((q) => near(onCurve(q.t))) : null;
    if (i < 0 && !pl) return;
    drag = i >= 0 ? { i } : { pl };
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = local(e), p = getPath();
    if (drag.pl) {
      // nearest point of the curve on screen
      let best = Infinity, bt = drag.pl.t;
      for (let k = 0; k <= 400; k++) { const [px, py] = onCurve(k / 400), d = Math.hypot(px - x, py - y); if (d < best) { best = d; bt = k / 400; } }
      drag.pl.t = Math.round(bt * 1000) / 1000;
    } else {
      ray.setFromCamera(ndc.set(x / c.width * 2 - 1, 1 - y / c.height * 2), camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const { W, H } = size(), u = clamp01(hit.x / W + 0.5), vv = clamp01(hit.y / H + 0.5);
      p.points[drag.i] = [r4(u), r4(vv), r4(sample(u, vv))];
    }
    onChange();
  });
  const end = () => { drag = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  save.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pathJson(getPath())], { type: 'application/json' }));
    a.download = 'path.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  return {
    get visible() { return !c.hidden; },
    toggle() { c.hidden = save.hidden = !c.hidden; drag = null; },
    draw() {
      if (c.hidden) return;
      const p = getPath(), cream = css('--cream'), brass = css('--brass'), ink = css('--ink');
      g.clearRect(0, 0, c.width, c.height);
      g.lineWidth = 3; g.strokeStyle = cream; g.setLineDash([12, 8]);
      g.beginPath();
      for (let k = 0; k <= 160; k++) { const [x, y] = onCurve(k / 160); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke(); g.setLineDash([]);
      g.font = '20px "JetBrains Mono", monospace'; g.textBaseline = 'middle';
      p.points.forEach((q, i) => {
        const [x, y] = screen(...q);
        g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fillStyle = cream; g.fill(); g.strokeStyle = ink; g.stroke();
        g.fillStyle = ink; g.textAlign = 'center'; g.fillText(String(i + 1), x, y + 1);
      });
      for (const q of p.plaques) {
        const [x, y] = onCurve(q.t);
        g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x + 14, y); g.lineTo(x, y + 14); g.lineTo(x - 14, y); g.closePath();
        g.fillStyle = brass; g.fill(); g.strokeStyle = ink; g.stroke();
        g.textAlign = 'left'; g.fillStyle = cream; g.fillText(`${q.id} t ${q.t}`, x + 20, y - 22);
      }
    },
  };
}
