// The TV stage, ported from prototype/living-blueprint.html: Turner's painting as a depth relief, the riverbank
// figures and plaques, the in-stage panels and the follow camera. window.game (README contract) is defined
// synchronously below, before anything has loaded; glue.js assigns sendTo/sendAll and decides ownership.
import * as THREE from 'three';
import '@fontsource/im-fell-english/400.css';
import '@fontsource/libre-franklin/400.css';
import '@fontsource/libre-franklin/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '../shared/tokens.css';
import './host.css';
import cards from '../shared/cards.json';
import { PLAQUES, HOTSPOT_HALF_WIDTH, WALK_OFF, WALK_OFF_MS, ORIGINAL_MS, MIN_T, LEVER_MIN, LEVER_MAX, SPAN_MIN, SPAN_MAX, RISE_MIN, RISE_MAX_KIOSK } from '../shared/protocol.js';
import { rpmFor, pistonX, crankPin } from '../../lib/crankSlider.js';
import { checkArch, jointRegion } from '../../lib/heyman.js';
import { archGeometry } from '../../lib/archGeometry.js';
import { writeStl } from '../../lib/stl.js';
import { loadDepth, placeholderDepth, sampler, depthTexture } from './depth.js';
import { loadSheets, paintSheet, sheetTexture, setFrame, shadowTexture, textSprite, drawLabel, WALK, IDLE, WAVE, ASPECT as FIG_ASPECT } from './figures.js';
import { createPathOverlay } from './pathOverlay.js';
import { FOV, LEAN_Y, TAG_GAP, TAG_H, rig, figH, groupBox, aimFor, leanFor, stepView, pose } from './camera.js';

const ASPECT = 1920 / 1433, W = 4, H = W / ASPECT, AMP = 0.42;
const SW = 1447, SH = 1080, STEP = 1 / 60, SPEED = 0.10; // stage px; path lengths per second
const CARD_MS = 12000; // the card's headline and first sentence, then only the drawing, readout and operator
const PANEL_EDGE = (24 + 600) / SW; // a panel's inner edge; the focus frame puts the look point mid the rest (NDC)
const LOCO_R = 78; // drawing units for the 7 ft driving wheel
// Same as public/path.json, used until (or if) the fetch succeeds.
const PATH0 = {
  image: 'assets/turner-1920.jpg',
  points: [[0.05, 0.11, 0.7368], [0.0993, 0.1271, 0.7106], [0.1536, 0.149, 0.6774], [0.2115, 0.1754, 0.638],
    [0.2691, 0.204, 0.5959], [0.3205, 0.2355, 0.5504], [0.37, 0.2679, 0.5045], [0.42, 0.3, 0.4601]],
  plaques: [{ id: 'loco', t: 0.26, look: [0.68, 0.47], zoom: 1.6 }, { id: 'bridge', t: 0.58, look: [0.58, 0.40], zoom: 1.5 },
    { id: 'hare', t: 0.90, look: [0.79, 0.30], zoom: 1.0 }],
};
const IMG = '/' + PATH0.image;
const WORK = ['Painting view', 'Depth map', 'Wireframe'];
const ATTRACT_LINE = 'Scan the code to join, or use the keyboard. The view follows whoever is walking.';

const $ = (id) => document.getElementById(id);
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, dflt) => (Number.isFinite(+x) ? +x : dflt);
const label = (id) => `${cards[id].fig} ${cards[id].title}`;
const fmtFt = (x) => { let ft = Math.floor(x), inch = Math.round((x - ft) * 12); if (inch === 12) { ft++; inch = 0; } return inch ? `${ft} ft ${inch} in` : `${ft} ft`; };
// Staggered from MIN_T, all short of Fig. 1's hotspot (0.23 with path.json's loco at 0.26).
const startT = (pid) => (pid === 0 ? MIN_T : MIN_T + 0.012 * (((pid - 1) % 6) + 1));
let pal = null; // canvas colours, read from the tokens once
const P = () => pal || (pal = { brass: tok('--brass'), cream: tok('--cream'), frame: tok('--frame-ink'), bg: tok('--prussian-deep'), ok: tok('--ok'), bad: tok('--bad') });

const tv = $('tv'), stage = $('stage'), canvas = $('gl'), hintEl = $('hint'), captionEl = $('caption'), modeTag = $('modeTag'), originalEl = $('original');
const fit = () => tv.style.setProperty('--fit', Math.min(innerWidth / 1920, innerHeight / 1080));
addEventListener('resize', fit); fit();

// ---------- state ----------
const listeners = new Set();
const emit = (e) => { for (const cb of listeners) try { cb(e); } catch (err) { console.error(err); } };
const players = new Map(); // pid -> figure
const plaques = new Map(); // id -> {id, t, look, zoom, owner, openedAt, sprite, panel, far, walked}
let path = PATH0, curve = null, depth = placeholderDepth(), sample = sampler(depth), sheets = null;
let work = 0, judge = false, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches, originalTimer = 0;
let mph = 30, theta = 0, simTime = 0, fps = 0, notice = '';
const arch = { span: 128, rise: 24.25, A: null };
const attract = { idle: 0, on: false, lean: 0 };
const cam = { tx: 0, ty: 0, zoom: 1, lean: 0, leanY: 0 }, aim = { tx: 0, ty: 0, zoom: 1 }, mouse = { x: 0, y: 0 };
const keys = { left: false, right: false, verb: false };

// ---------- renderer, scene, painting ----------
const scene = new THREE.Scene();
const stageBg = new THREE.Color(tok('--prussian-deep'));
scene.background = stageBg;
const camera = new THREE.PerspectiveCamera(FOV, SW / SH, 0.1, 50);
const lens = rig(W, H, SW / SH); // camera.js: the follow/focus math, swept by tests/camera.test.js

const blank = new THREE.DataTexture(Uint8Array.from([stageBg.r, stageBg.g, stageBg.b, 1], (x) => x * 255), 1, 1);
blank.needsUpdate = true;
const uniforms = {
  map: { value: blank }, depthMap: { value: null }, amp: { value: AMP }, mode: { value: 0 },
  cyan: { value: new THREE.Color(tok('--prussian')) }, cream: { value: new THREE.Color(tok('--cream')) },
};
const mat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: `uniform sampler2D depthMap; uniform float amp; varying vec2 vUv; varying float vD;
    void main() { vUv = uv; vD = texture2D(depthMap, uv).r; vec3 p = position; p.z += vD * amp;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
  fragmentShader: `uniform sampler2D map; uniform int mode; uniform vec3 cyan; uniform vec3 cream; varying vec2 vUv; varying float vD;
    void main() {
      if (mode == 1) { gl_FragColor = vec4(mix(cyan, cream, vD), 1.0); return; }
      if (mode == 2) { gl_FragColor = vec4(cream * 0.9, 1.0); return; }
      gl_FragColor = texture2D(map, vUv); }`,
});
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(W, H, 512, 384), mat));

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SW, SH, false);
  uniforms.depthMap.value = depthTexture(renderer, depth);
} catch (err) {
  renderer = null; notice = 'WebGL is not available in this browser.';
}
const upload = (tex) => { if (renderer && tex) renderer.initTexture(tex); }; // upload now so no sprite ever flashes white

new THREE.TextureLoader().load(IMG, (tex) => { uniforms.map.value = tex; upload(tex); },
  undefined, () => { notice = 'The painting file did not load.'; renderHint(); });
originalEl.style.backgroundImage = $('hareView').style.backgroundImage = `url("${IMG}")`;

// ---------- path and plaques ----------
const tmp = new THREE.Vector3();
// World position at path parameter t. h comes from the curve, never a per-frame depth sample.
function at(t, lift, out) { const p = curve.getPoint(clamp(t, 0, 1), tmp); return out.set((p.x - 0.5) * W, (p.y - 0.5) * H, p.z * AMP + lift); }
function setPath(p) {
  path = p;
  curve = new THREE.CatmullRomCurve3(p.points.map(([u, v, h]) => new THREE.Vector3(u, v, h)), false, 'catmullrom', 0.5);
  for (const q of p.plaques) { const pl = plaques.get(q.id); if (pl) Object.assign(pl, { t: q.t, look: q.look, zoom: q.zoom }); }
}
const validPath = (p) => Array.isArray(p?.points) && p.points.length >= 2 && Array.isArray(p.plaques)
  && p.points.every((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite))
  && p.plaques.every((q) => Number.isFinite(q?.t) && Number.isFinite(q.zoom) && Array.isArray(q.look) && q.look.length === 2);

for (const id of PLAQUES) {
  const c = cards[id], panel = $('panel-' + id);
  const sprite = textSprite(c.fig, { bg: tok('--brass'), fg: tok('--brass-ink'), px: 48 });
  sprite.renderOrder = 5; sprite.userData.plaque = id;
  scene.add(sprite); upload(sprite.material.map);
  plaques.set(id, { id, t: 0.5, look: [0.5, 0.5], zoom: 1, owner: null, openedAt: 0, sprite, panel, far: 0, walked: false, side: 'left', brief: 0 });
  panel.querySelector('h2').textContent = label(id);
  const tb = panel.querySelector('.tb-title');
  if (tb) tb.textContent = label(id);
  panel.querySelector('.headline').textContent = c.headline;
  panel.querySelector('.lede').textContent = (c.body.match(/^.*?[.!?](?=\s|$)/) || [c.body])[0]; // the full body lives on the phone
  panel.querySelector('.source').textContent = c.source;
  panel.querySelector('.close').addEventListener('click', () => { const pl = plaques.get(id); if (pl.owner != null) emit({ type: 'done', pid: pl.owner, plaque: id }); });
}
setPath(PATH0);

function placePlaques() {
  for (const pl of plaques.values()) {
    at(pl.t, 0.06, pl.sprite.position);
    let near = false;
    for (const f of players.values()) if (f.near === pl.id) near = true;
    const h = 0.11 * (1 - 0.45 * pl.t) * (near ? 1.25 : 1);
    pl.sprite.scale.set(h * pl.sprite.userData.aspect, h, 1);
    pl.sprite.material.opacity = near ? 1 : 0.86;
  }
}

// ---------- figures ----------
const shadowMat = new THREE.SpriteMaterial({ map: shadowTexture(), transparent: true, depthTest: false, depthWrite: false });
upload(shadowMat.map);
function makeFigure(color, bonnet, name, tagged) {
  const tex = sheetTexture(sheets, color, bonnet);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const shadow = new THREE.Sprite(shadowMat);
  const tag = tagged ? textSprite(name, { bg: tok('--ink'), fg: tok('--cream'), dot: color, alpha: 0.85 }) : null;
  sprite.center.set(0.5, 0);
  scene.add(shadow, sprite);
  if (tag) { tag.renderOrder = 300; scene.add(tag); upload(tag.material.map); }
  upload(tex);
  return { tex, sprite, shadow, tag, color, bonnet, name, t: 0, lx: 0, a: 0, frozen: false, facing: 1, phase: 0, pulse: 0, near: null, active: true };
}
// The attract figure: strolls the bank when G has it on; not a window.game player and never at a hotspot.
const ghost = Object.assign(makeFigure('#7a93c9', true, 'Ghost passenger', false), { t: 0.62, lx: -1, facing: -1 });

function place(f) {
  const p = at(f.t, 0.015, f.sprite.position);
  const h = figH(f.t), k = f.pulse > 0 ? 1 + 0.18 * Math.abs(Math.sin(Math.PI * f.pulse / 0.6)) : 1; // two pulses in 1.2 s
  f.sprite.scale.set(h * k * FIG_ASPECT, h * k, 1);
  f.sprite.renderOrder = 100 - Math.round(f.t * 50);
  f.shadow.position.set(p.x, p.y + 0.004, p.z + 0.005);
  f.shadow.scale.set(h * 0.55, h * 0.16, 1);
  f.shadow.renderOrder = f.sprite.renderOrder - 1;
  setFrame(f.tex, f.pulse > 0 ? WAVE : f.lx && !f.frozen ? WALK[Math.floor(f.phase) % 4] : IDLE, f.facing);
  if (f.tag) { f.tag.position.set(p.x, p.y + h * k + TAG_GAP, p.z); f.tag.scale.set(TAG_H * f.tag.userData.aspect, TAG_H, 1); }
  f.sprite.visible = f.shadow.visible = f.active;
}

// ---------- panels ----------
function layoutPanels() {
  const used = new Set();
  for (const pl of [...plaques.values()].sort((a, b) => a.openedAt - b.openedAt)) {
    pl.panel.hidden = pl.owner == null;
    if (pl.owner == null) continue;
    // Opposite the look point, unless another open panel holds that side.
    // shortcut: a third simultaneous operator's panel overlaps another; stack them if three operators ever happen
    let side = pl.look[0] > 0.5 ? 'left' : 'right';
    if (used.has(side)) side = side === 'left' ? 'right' : 'left';
    used.add(side); pl.side = side;
    pl.panel.classList.toggle('left', side === 'left');
    const f = players.get(pl.owner), dot = Object.assign(document.createElement('span'), { className: 'swatch' });
    dot.style.background = f?.color || tok('--cream'); // names always with their colour
    pl.panel.querySelector('.operator').replaceChildren('Operator: ', dot, f?.name || 'Visitor');
    if (pl.id === 'bridge') drawArch(); else if (pl.id === 'hare') drawHare(); else drawLoco();
  }
}

// Canvas labels in drawing units that land at `px` on the 1080p TV, on a dark chip so they read over the lines.
function labeller(g, s, px = 20) {
  const fs = px / s;
  return (text, x, y, color, align = 'left') => {
    g.font = `${fs}px "JetBrains Mono", monospace`; g.textAlign = align;
    const tw = g.measureText(text).width, x0 = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
    g.fillStyle = 'rgba(14,20,32,.82)'; g.fillRect(x0 - 3, y - fs * 0.95, tw + 6, fs * 1.25);
    g.fillStyle = color; g.fillText(text, x, y);
  };
}
// The title block's scale bar: the longest round length that stays under 140 px.
function scaleBar(id, pxPerFt) {
  const ft = [50, 25, 20, 10, 5, 4, 2, 1].find((n) => n * pxPerFt <= 140) || 1, bar = $(id);
  bar.style.width = `${Math.round(ft * pxPerFt)}px`; bar.nextElementSibling.textContent = `${ft} ft`;
}

function drawLoco() {
  const c = $('locoCanvas'), g = c.getContext('2d'), s = c.width / 440, w = 440, h = c.height / s, C = P(), lbl = labeller(g, s);
  g.setTransform(s, 0, 0, s, 0, 0); // the prototype's 440-unit drawing, scaled
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  const R = LOCO_R, cx = 112, cy = h / 2 + 4, r = R * 0.32, l = r * 3.2, px = cx + pistonX(theta, r, l);
  const [pinX, pinY] = crankPin(theta, r), kx = cx + pinX, ky = cy + pinY;
  g.strokeStyle = '#3b4552'; g.lineWidth = 3; g.beginPath(); g.moveTo(10, cy + R + 4); g.lineTo(w - 10, cy + R + 4); g.stroke(); // rail
  g.strokeStyle = C.brass; g.lineWidth = 5; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke(); // wheel
  g.lineWidth = 2;
  for (let k = 0; k < 8; k++) { const a = theta + k * Math.PI / 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); }
  g.strokeStyle = C.cream; g.lineWidth = 6; g.beginPath(); g.moveTo(kx, ky); g.lineTo(px, cy); g.stroke(); // connecting rod
  g.strokeStyle = '#3b4552'; g.lineWidth = 2; g.beginPath(); // crosshead guides
  g.moveTo(cx + r + l * 0.9, cy - 14); g.lineTo(w - 20, cy - 14); g.moveTo(cx + r + l * 0.9, cy + 14); g.lineTo(w - 20, cy + 14); g.stroke();
  g.strokeStyle = '#55617a'; g.strokeRect(330, cy - 22, w - 350, 44); // cylinder
  g.fillStyle = C.brass; g.fillRect(px - 10, cy - 10, 20, 20); // crosshead
  g.fillStyle = '#7a93c9'; g.fillRect(px + 10, cy - 4, Math.max(0, w - 30 - (px + 10)), 8); // piston rod
  g.fillStyle = C.cream; g.beginPath(); g.arc(kx, ky, 5, 0, Math.PI * 2); g.fill(); // crank pin
  g.strokeStyle = 'rgba(243,236,220,.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(kx, ky); g.lineTo(40, 26); g.stroke();
  lbl('crank pin', 6, 22, C.cream);
  lbl('x = r cos θ + √(l² − r² sin²θ)', w - 4, 22, C.frame, 'right');
  lbl('r = 0.32 R · l = 3.2 r', w - 4, 44, C.frame, 'right');
  lbl('crosshead', 196, cy - 34, C.brass);
  lbl('cylinder', 342, cy - 34, '#9fb0d0');
  lbl('connecting rod', 196, cy + 46, C.cream);
  lbl('piston rod', 316, cy + 70, '#7a93c9');
  lbl('driving wheel, 7 ft', cx, h - 5, C.brass, 'center');
}

function drawArch() {
  const A = arch.A, c = $('archCanvas'), g = c.getContext('2d'), s = c.width / 440, w = 440, h = c.height / s, C = P(), lbl = labeller(g, s);
  $('spanOut').textContent = fmtFt(arch.span); $('riseOut').textContent = fmtFt(arch.rise);
  g.setTransform(s, 0, 0, s, 0, 0);
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  const ox = w / 2, oy = h - 40, sc = Math.min((w - 60) / arch.span, (oy - 34) / (arch.rise + A.tk[0] / 2 + 3)), X = (x) => ox + x * sc, Y = (y) => oy - y * sc;
  const poly = (side, fn) => { g.beginPath(); A.pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, X(side * p[0]), Y(fn(p, i)))); g.stroke(); };
  for (const side of [1, -1]) {
    // ring: extrados and intrados as vertical offsets of the centreline by the local half thickness
    g.strokeStyle = C.brass; g.lineWidth = 2;
    poly(side, (p, i) => p[1] + A.tk[i] / 2);
    poly(side, (p, i) => Math.max(0, p[1] - A.tk[i] / 2));
    g.strokeStyle = 'rgba(201,162,75,.45)'; g.lineWidth = 1; // voussoir joints
    A.pts.forEach((p, i) => { if (i % 2) return; g.beginPath(); g.moveTo(X(side * p[0]), Y(Math.max(0, p[1] - A.tk[i] / 2))); g.lineTo(X(side * p[0]), Y(p[1] + A.tk[i] / 2)); g.stroke(); });
  }
  g.fillStyle = '#3b4552'; g.fillRect(X(-A.a) - 26, Y(0), 26, 30); g.fillRect(X(A.a), Y(0), 26, 30); // abutments
  g.strokeStyle = '#2b4f7a'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(-A.a), Y(0) + 24); g.lineTo(X(A.a), Y(0) + 24); g.stroke(); // river
  g.strokeStyle = A.stands ? C.ok : C.bad; g.lineWidth = 2.5; // thrust line, both halves
  for (const side of [1, -1]) { g.beginPath(); A.line.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, X(side * p[0]), Y(p[1]))); g.stroke(); }
  // dimension lines: the span along the springing line, the rise up the centreline to the crown
  g.strokeStyle = C.frame; g.lineWidth = 1; g.beginPath();
  g.moveTo(X(-A.a), Y(0) + 10); g.lineTo(X(A.a), Y(0) + 10);
  for (const x of [X(-A.a), X(A.a)]) { g.moveTo(x, Y(0) + 4); g.lineTo(x, Y(0) + 16); }
  g.moveTo(ox, Y(0)); g.lineTo(ox, Y(arch.rise)); g.moveTo(ox - 6, Y(arch.rise)); g.lineTo(ox + 6, Y(arch.rise)); g.stroke();
  lbl(`span ${fmtFt(arch.span)}`, ox, h - 4, C.frame, 'center');
  lbl(`rise ${fmtFt(arch.rise)}`, ox - 8, Y(arch.rise / 2) + 7, C.frame, 'right'); // left of the crown: the failure label takes the right half
  lbl('ring 5 ft 3 in–7 ft · fill 2 ft over crown', 6, 22, C.frame);
  const m = mirror('bridge');
  if (!A.stands) { // where the line of thrust leaves the ring, both halves, and the region named once
    const [bx, by] = A.line[A.worstJoint], text = `${m.where}: thrust out`;
    g.strokeStyle = g.fillStyle = C.bad; g.lineWidth = 2;
    for (const side of [1, -1]) { g.beginPath(); g.arc(X(side * bx), Y(by), 4, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(X(side * bx), Y(by), 9, 0, Math.PI * 2); g.stroke(); }
    const tw = g.measureText(text).width;
    lbl(text, clamp(X(bx) - tw / 2, ox + 8, w - tw - 6), clamp(Y(by) - 16, 46, oy - 8), C.bad);
  }
  scaleBar('archBar', sc * s);
  const out = $('archOut');
  out.replaceChildren(m.text, document.createElement('br'), `Abutment push ${m.push.toFixed(2)} × half-arch weight`);
  out.className = 'readout ' + (A.stands ? 'ok' : 'bad');
}

function drawHare() {
  // the untouched original at 2x around the hare's look point; v is bottom-up, CSS is top-down
  const el = $('hareView'), bw = el.clientWidth, bh = el.clientHeight, iw = 1920 * 2, ih = iw / ASPECT, [u, v] = plaques.get('hare').look;
  el.style.backgroundSize = `${iw}px ${ih}px`;
  el.style.backgroundPosition = `${clamp(bw / 2 - u * iw, bw - iw, 0)}px ${clamp(bh / 2 - (1 - v) * ih, bh - ih, 0)}px`;
}

// The mirror readout glue forwards to the operating phone (README Protocol); the TV panels show the same values.
function mirror(id) {
  if (id === 'loco') { const rpm = Math.round(rpmFor(mph)); return { plaque: id, mph, rpm, text: `${rpm} rpm at ${Math.round(mph)} mph` }; }
  if (id === 'hare') return { plaque: id, text: `${label(id)} · the untouched original` };
  if (id !== 'bridge') return null;
  const { stands, marginMm, worstJoint, push, N } = arch.A, where = jointRegion(worstJoint, N);
  return {
    plaque: id, span: arch.span, rise: arch.rise, stands, marginMm, push: Math.round(push * 100) / 100, worstJoint, where,
    text: stands ? `Stands · thrust inside the ring by ${marginMm} mm` : `Would fail · the thrust leaves the ring at the ${where} by ${-marginMm} mm`,
  };
}

function exportArch() {
  const file = `arch_${fmtFt(arch.span)}_${fmtFt(arch.rise)}`.replace(/\s+/g, '') + '.stl', out = $('stlOut'), { stands, marginMm } = arch.A;
  try {
    const { positions, indices } = archGeometry(arch.span, arch.rise), buf = writeStl(positions, indices, { name: file.slice(0, -4) }); // lib default 1:400
    const a = document.createElement('a'), kb = Math.round(buf.byteLength / 1024);
    a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
    a.download = file; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    out.textContent = `Saved ${file} · ${kb} KB`;
    return { file, bytes: buf.byteLength, triangles: indices.length / 3, stands, marginMm, text: `Saved ${file} on the exhibit laptop · ${kb} KB` };
  } catch (err) {
    console.warn(err); out.textContent = 'This arch could not be exported.';
    return { file: null, bytes: 0, triangles: 0, stands, marginMm, text: 'This arch could not be exported' };
  }
}

// ---------- margins and captions ----------
function renderHint() {
  const own = [...plaques.values()].find((p) => p.owner === 0), near = players.get(0)?.near, busy = near && plaques.get(near).owner;
  const text = notice || (own ? `${label(own.id)} · Esc returns to the bank`
    : busy ? `${label(near)} is in use by ${players.get(busy)?.name || 'another visitor'}`
    : near ? `${label(near)} · press Space to look` : '← → walk the bank · Space looks at a brass plaque');
  if (hintEl.textContent !== text) hintEl.textContent = text;
}
function renderCaption() {
  const text = attract.on ? ATTRACT_LINE
    : work === 1 ? (depth.placeholder ? 'Depth map: hand-authored placeholder, 2026' : 'Depth map: reconstruction, 2026')
    : work === 2 ? 'Wireframe: a 512 by 384 plane displaced in our vertex shader · reconstruction, 2026' : '';
  captionEl.textContent = text; captionEl.hidden = !text;
}
function renderTag() {
  const shown = !originalEl.hidden;
  const lines = [[shown ? 'Original' : WORK[work]], [work && !shown ? `${fps} fps` : ''], [judge ? 'Guided tour' : '', 'judge'], [reduced ? 'Reduced motion' : '']];
  modeTag.replaceChildren(...lines.filter(([t]) => t).map(([t, cls]) => Object.assign(document.createElement('span'), { textContent: t, className: cls || '' })));
}
function setWork(m) { work = m % 3; uniforms.mode.value = work; mat.wireframe = work === 2; hideOriginal(); renderCaption(); }
function hideOriginal() { clearTimeout(originalTimer); originalEl.hidden = true; renderTag(); }
function setReduced(on) { reduced = on; tv.classList.toggle('reduced', on); if (on) for (const f of players.values()) f.pulse = 0; renderTag(); }
function stopAttract() { attract.on = false; attract.lean = 0; renderCaption(); }
function poke() { attract.idle = 0; if (attract.on) stopAttract(); }

// ---------- window.game ----------
const game = window.game = {
  addPlayer(pid, name, color) {
    pid = Number(pid);
    if (!Number.isInteger(pid)) return;
    name = String(name ?? ''); color = String(color || tok('--cream'));
    const f = players.get(pid);
    if (!f) {
      const n = Object.assign(makeFigure(color, pid % 2 === 0, name, pid !== 0), { t: startT(pid), pulse: reduced || pid === 0 ? 0 : 1.2 });
      players.set(pid, n); place(n);
      return;
    }
    if (color !== f.color) { f.color = color; paintSheet(f.tex.image, sheets, color, f.bonnet); f.tex.needsUpdate = true; upload(f.tex); }
    if (f.tag && (name !== f.tag.userData.text || color !== f.tag.userData.dot)) { Object.assign(f.tag.userData, { text: name, dot: color }); drawLabel(f.tag); upload(f.tag.material.map); }
    f.name = name;
    if ([...plaques.values()].some((pl) => pl.owner === pid)) layoutPanels(); // the operator line carries name and colour
    if (f.near) emit({ type: 'near', pid, plaque: f.near }); // a reloaded phone resets its verb label; step() only emits on change
  },
  removePlayer(pid) {
    pid = Number(pid);
    const f = players.get(pid);
    if (!f || pid === 0) return; // the keyboard player is always on the bank
    scene.remove(f.sprite, f.shadow); f.tex.dispose(); f.sprite.material.dispose();
    if (f.tag) { scene.remove(f.tag); f.tag.material.map.dispose(); f.tag.material.dispose(); }
    players.delete(pid);
  },
  setInput(pid, lx, a) {
    pid = Number(pid);
    const f = players.get(pid);
    if (!f) return;
    lx = Math.sign(num(lx, 0)); a = a ? 1 : 0;
    const rising = a && !f.a;
    f.a = a; // tracked while frozen too, so a held button never fires on release
    if (lx || a) poke();
    if (f.frozen) return;
    f.lx = lx;
    if (rising && f.near) emit({ type: 'look', pid, plaque: f.near });
  },
  setPanel(pid, kind, value) {
    if (kind === 'lever') return game.setLever(value);
    if (kind === 'span') return game.setArch(value, arch.rise);
    if (kind === 'rise') return game.setArch(arch.span, value);
    return null;
  },
  readout: mirror,
  exportArch,
  onHotspot(cb) { if (typeof cb === 'function') listeners.add(cb); return () => listeners.delete(cb); },
  sendTo() {},
  sendAll() {},
  setOwner(id, pid) {
    const pl = plaques.get(id);
    if (!pl) return;
    const owner = pid == null ? null : Number(pid);
    if (owner !== pl.owner) {
      pl.openedAt = performance.now();
      clearTimeout(pl.brief); pl.panel.classList.remove('settled');
      if (owner != null) pl.brief = setTimeout(() => pl.panel.classList.add('settled'), CARD_MS);
    }
    Object.assign(pl, { owner, far: 0, walked: false });
    // the TV's own controls work by mouse only for the keyboard operator; for a phone they display its values
    for (const el of pl.panel.querySelectorAll('input, button:not(.close)')) el.disabled = owner !== 0;
    layoutPanels(); renderHint();
  },
  freeze(pid, on) { const f = players.get(Number(pid)); if (!f) return; f.frozen = !!on; if (on) f.lx = 0; },
  setLever(v) {
    mph = clamp(num(v, mph), LEVER_MIN, LEVER_MAX);
    const m = mirror('loco');
    $('mph').value = mph; $('mphOut').textContent = `${Math.round(mph)} mph`; $('rpmOut').textContent = m.text;
    return m;
  },
  setArch(spanFt, riseFt) {
    arch.span = clamp(num(spanFt, arch.span), SPAN_MIN, SPAN_MAX);
    arch.rise = clamp(num(riseFt, arch.rise), RISE_MIN, RISE_MAX_KIOSK);
    arch.A = checkArch(arch.span, arch.rise);
    $('span').value = arch.span; $('rise').value = arch.rise; $('stlOut').textContent = '';
    drawArch();
    return mirror('bridge');
  },
  setJudge(on) { judge = !!on; if (judge) stopAttract(); renderTag(); },
  showOriginal() { originalEl.hidden = false; clearTimeout(originalTimer); originalTimer = setTimeout(hideOriginal, ORIGINAL_MS); renderTag(); },
  reset() {
    for (const [pid, f] of players) Object.assign(f, { t: startT(pid), lx: 0, a: 0, frozen: false, facing: 1, phase: 0, pulse: 0 });
    Object.assign(ghost, { t: 0.62, lx: -1, facing: -1, active: true });
    for (const pl of plaques.values()) Object.assign(pl, { owner: null, far: 0, walked: false });
    keys.left = keys.right = keys.verb = false;
    layoutPanels(); setWork(0); game.setLever(30); game.setArch(128, 24.25);
    attract.idle = 0; stopAttract(); renderHint();
  },
  stats: () => ({ fps, zoom: Math.round(cam.zoom * 100) / 100, lean: Math.round(cam.lean * 10) / 10 }),
};

// ---------- follow camera ----------
const group = () => (ghost.active ? [...players.values(), ghost] : [...players.values()]); // never empty: pid 0 stays
function aimCamera() {
  if (overlay.visible) { Object.assign(aim, { tx: 0, ty: 0, zoom: 1 }); return; } // hold still on the whole bank while dots are dragged
  const owned = [...plaques.values()].filter((p) => p.owner != null)
    .map((p) => ({ look: p.look, zoom: p.zoom, shift: p.side === 'left' ? PANEL_EDGE : -PANEL_EDGE }));
  Object.assign(aim, aimFor(lens, owned, groupBox(group().map((f) => ({ x: f.sprite.position.x, y: f.sprite.position.y, t: f.t, tagged: !!f.tag })))));
}
function stepCamera(dt) {
  const g = group(), cx = g.reduce((s, f) => s + f.sprite.position.x, 0) / g.length / W + 0.5;
  const still = overlay.visible ? 0 : reduced ? 0.25 : 1;
  stepView(lens, cam, aim, leanFor(cx, mouse.x, attract.lean, cam.zoom, still), still * -mouse.y * LEAN_Y, dt);
  camera.position.set(...pose(lens, cam));
  camera.lookAt(cam.tx, cam.ty, 0);
}

// ---------- simulation: fixed 1/60 s steps ----------
function step() {
  simTime += STEP;
  for (const [pid, f] of players) {
    if (f.lx && !f.frozen) { f.t = clamp(f.t + f.lx * SPEED * STEP, MIN_T, 1); f.facing = f.lx; f.phase += STEP * 8; }
    let near = null;
    for (const pl of plaques.values()) if (Math.abs(f.t - pl.t) <= HOTSPOT_HALF_WIDTH) near = pl.id;
    if (near !== f.near) { f.near = near; emit({ type: 'near', pid, plaque: near }); if (pid === 0) renderHint(); }
    f.pulse = Math.max(0, f.pulse - STEP);
  }
  if (ghost.active) {
    ghost.t += ghost.lx * SPEED * 0.6 * STEP;
    if (ghost.t > 0.98) ghost.lx = -1; else if (ghost.t < MIN_T) ghost.lx = 1;
    ghost.t = clamp(ghost.t, MIN_T, 0.98); ghost.facing = ghost.lx; ghost.phase += STEP * 5;
  }
  let owned = false;
  for (const pl of plaques.values()) {
    if (pl.owner != null) owned = true;
    const f = pl.owner == null ? null : players.get(pl.owner);
    if (f && Math.abs(f.t - pl.t) > WALK_OFF) {
      pl.far += STEP * 1000;
      if (pl.far >= WALK_OFF_MS && !pl.walked) { pl.walked = true; emit({ type: 'walkoff', pid: pl.owner, plaque: pl.id }); }
    } else { pl.far = 0; pl.walked = false; }
  }
  attract.idle += STEP;
  if (!attract.on && !judge && !owned && attract.idle > 45) { attract.on = true; renderCaption(); }
  else if (attract.on && (judge || owned)) stopAttract();
  attract.lean = attract.on && !reduced ? Math.sin(simTime / 4) * 5 : 0;
  theta += rpmFor(mph) / 60 * 2 * Math.PI * STEP;
  for (const f of players.values()) place(f);
  place(ghost); placePlaques();
  aimCamera(); stepCamera(STEP); arrangeTags();
}

// Name tags stay legible: pulled inside the frame (the bank starts near the stage edge), then lifted clear of
// each other when figures crowd. shortcut: greedy, one pass; fine for six tags.
const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
function arrangeTags() {
  camera.updateMatrixWorld();
  const tags = [];
  for (const f of players.values()) {
    if (!f.tag) continue;
    const p = f.tag.position, s = f.tag.scale.x / 2, m = 0.97;
    const l = e1.set(p.x - s, p.y, p.z).project(camera).x, r = e2.set(p.x + s, p.y, p.z).project(camera).x, k = 2 * s / (r - l); // world per ndc
    if (Math.abs(l + r) > 2) continue; // the figure itself is out of frame: leave its tag with it
    if (l < -m) p.x += (-m - l) * k; else if (r > m) p.x -= (r - m) * k;
    tags.push(f.tag);
  }
  tags.sort((a, b) => a.position.y - b.position.y);
  for (let i = 1; i < tags.length; i++) for (let j = 0; j < i; j++) {
    const a = tags[j], b = tags[i];
    if (Math.abs(a.position.x - b.position.x) < (a.scale.x + b.scale.x) / 2 && b.position.y - a.position.y < a.scale.y) b.position.y = a.position.y + a.scale.y * 1.08;
  }
}

const overlay = createPathOverlay({
  stage, camera, W, H, AMP, getPath: () => path, getCurve: () => curve, sample: (u, v) => sample(u, v), onChange: () => setPath(path),
});

let last = performance.now(), acc = 0, frames = 0, fpsT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const el = clamp((now - last) / 1000, 0, 0.25);
  last = now; acc += el;
  for (let n = 0; acc >= STEP && n < 5; n++) { step(); acc -= STEP; }
  if (acc >= STEP) acc = 0; // more than 5 steps behind: drop the backlog rather than spiral
  if (!plaques.get('loco').panel.hidden) drawLoco();
  overlay.draw();
  if (renderer) renderer.render(scene, camera);
  frames++; fpsT += el;
  if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = fpsT = 0; if (work) renderTag(); }
}

// ---------- input: scene owns ← → Space Enter Esc O W M ` G (glue owns H J R Q) ----------
const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const kb = () => game.setInput(0, keys.right - keys.left, keys.verb ? 1 : 0);
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    poke();
    if (!originalEl.hidden) hideOriginal();
    const own = [...plaques.values()].find((p) => p.owner === 0);
    if (own) emit({ type: 'done', pid: 0, plaque: own.id });
    return;
  }
  if (typing(e.target)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((k === ' ' || k === 'Enter') && e.target.tagName === 'BUTTON') return; // let a focused button activate
  if (!['ArrowLeft', 'ArrowRight'].includes(k) && e.repeat) return;
  poke();
  if (k === 'ArrowLeft') keys.left = true;
  else if (k === 'ArrowRight') keys.right = true;
  else if (k === ' ' || k === 'Enter') keys.verb = true;
  else if (k === 'o') game.showOriginal();
  else if (k === 'w') setWork(work + 1);
  else if (k === 'm') setReduced(!reduced);
  else if (k === '`' || e.code === 'Backquote') overlay.toggle();
  else if (k === 'g') ghost.active = !ghost.active;
  else return;
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === ' ' || k === 'Enter') kb();
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft') keys.left = false;
  else if (e.key === 'ArrowRight') keys.right = false;
  else if (e.key === ' ' || e.key === 'Enter') keys.verb = false;
  else return;
  kb();
});
const release = () => { keys.left = keys.right = keys.verb = false; kb(); };
addEventListener('blur', release);
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const plaqueAt = (e) => {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(ndc.set((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), camera);
  return ray.intersectObjects([...plaques.values()].map((p) => p.sprite))[0]?.object.userData.plaque ?? null;
};
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return; // lean follows the mouse only
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2; mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
  canvas.style.cursor = plaqueAt(e) ? 'pointer' : '';
  poke();
});
canvas.addEventListener('pointerleave', () => { mouse.x = mouse.y = 0; });
// On a grant (glue's setOwner runs inside emit) the keyboard figure steps to the plaque; left where it stood, walk-off
// would close the panel in 300 ms. A refused click leaves it where it was, so it keeps any plaque it holds.
canvas.addEventListener('click', (e) => {
  const id = plaqueAt(e), pl = plaques.get(id);
  if (pl) { poke(); emit({ type: 'look', pid: 0, plaque: id }); if (pl.owner === 0) players.get(0).t = pl.t; }
});
// a mouse-used slider or button would otherwise keep the arrow keys and Space
stage.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && e.target.matches('input, button')) e.target.blur(); });
$('mph').addEventListener('input', (e) => game.setLever(e.target.value));
$('span').addEventListener('input', (e) => game.setArch(e.target.value, arch.rise));
$('rise').addEventListener('input', (e) => game.setArch(arch.span, e.target.value));
$('exportBtn').addEventListener('click', () => exportArch());

// ---------- boot ----------
game.setLever(30); game.setArch(128, 24.25); setWork(0); setReduced(reduced);
scaleBar('locoBar', LOCO_R / 3.5 * $('locoCanvas').width / 440); // the 7 ft wheel is 2 LOCO_R drawing units
game.addPlayer(0, 'Keyboard', tok('--slot-keyboard'));
place(ghost); placePlaques(); renderHint();
requestAnimationFrame(frame);

fetch('/path.json').then((r) => (r.ok ? r.json() : null)).then((p) => { if (validPath(p)) setPath(p); }).catch(() => {});
loadDepth('/depth/turner-depth.png').then((d) => {
  if (d.placeholder) return;
  depth = d; sample = sampler(d);
  if (renderer) { uniforms.depthMap.value?.dispose(); uniforms.depthMap.value = depthTexture(renderer, d); }
  renderCaption();
});
loadSheets().then((s) => {
  if (!s) return;
  sheets = s;
  for (const f of [...players.values(), ghost]) { paintSheet(f.tex.image, s, f.color, f.bonnet); f.tex.needsUpdate = true; upload(f.tex); }
});
document.fonts?.load('600 56px "Libre Franklin"').then(() => {
  for (const sp of [...[...plaques.values()].map((p) => p.sprite), ...[...players.values()].map((f) => f.tag).filter(Boolean)]) { drawLabel(sp); upload(sp.material.map); }
}, () => {});
