// The TV stage: any artwork as a depth relief. One displaced plane, rebuilt per scene for the image's aspect, takes
// its depth and an object-id map from the scene's reading (maskDepth.js); the picture holds still and the shader only
// glows the object a figure stands at; the cut-paper figures walk the scene's ground path to one stop per object; the camera follows the
// group. window.game (README contract) is defined synchronously below, before anything has loaded; glue.js assigns
// sendTo/sendAll. Boot shows the Turner on its hand-authored relief, so the kiosk works with zero network.
import * as THREE from 'three';
import '@fontsource/im-fell-english/400.css';
import '@fontsource/libre-franklin/400.css';
import '@fontsource/libre-franklin/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '../shared/tokens.css';
import './host.css';
import { HOTSPOT_HALF_WIDTH, ORIGINAL_MS, MIN_T } from '../shared/protocol.js';
import { validateScene } from '../shared/scene-validate.js';
import { placeholderDepth, sampler, depthTexture } from './depth.js';
import { sceneDepth, objectIdMap, objectOutlines, pathPoints, objectHotspots } from './maskDepth.js';
import { loadSheets, paintSheet, sheetTexture, setFrame, shadowTexture, textSprite, drawLabel, WALK, IDLE, WAVE, ASPECT as FIG_ASPECT } from './figures.js';
import { createPathOverlay } from './pathOverlay.js';
import { FOV, LEAN_Y, TAG_GAP, TAG_H, rig, figH, groupBox, followAim, leanFor, stepView, pose } from './camera.js';

const TURNER = 1920 / 1433, H = 4 / TURNER, AMP = 0.42, EXPLODE = 3; // the plane's height is fixed; width follows the image
const SW = 1447, SH = 1080, STEP = 1 / 60, SPEED = 0.10; // stage px; path lengths per second
const TEXELS = 256, SEGS = 512, MAX_TEX = 2048; // depth and id texels, plane segments and image pixels on the long side
const SLOTS = 9; // shader glow slots: 0 is "no object", then scene.objects[0..7]
const NEAR_GLOW = 0.12, EASE_AMP = 1 - Math.exp(-STEP / 0.6);
const BOOT_IMG = '/assets/turner-1920.jpg';
const BOOT_CREDIT = 'J. M. W. Turner, Rain, Steam, and Speed, 1844. The National Gallery, London, NG538.';
const BOOT_POINTS = [[0.05, 0.11, 0.7368], [0.0993, 0.1271, 0.7106], [0.1536, 0.149, 0.6774], [0.2115, 0.1754, 0.638],
  [0.2691, 0.204, 0.5959], [0.3205, 0.2355, 0.5504], [0.37, 0.2679, 0.5045], [0.42, 0.3, 0.4601]]; // public/path.json's bank
const FLAT = { ground_path: [[0, 850], [1000, 850]], objects: [] };
const LAYERS = ['painting', 'depth', 'exploded', 'network'];
const LAYER_NAME = { painting: 'Painting view', depth: 'Depth map', exploded: 'Exploded layers', network: 'Network' };
const NO_IMAGE = 'The painting file did not load.';
const ATTRACT_LINE ='Scan the code to join, or use the keyboard. The view follows whoever is walking.';

const $ = (id) => document.getElementById(id);
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, dflt) => (Number.isFinite(+x) ? +x : dflt);
// Staggered from MIN_T, all short of the first stop (maskDepth keeps hotspots at t >= MIN_T + 0.11).
const startT = (pid) => (pid === 0 ? MIN_T : MIN_T + 0.012 * (((pid - 1) % 6) + 1));
// Only what an <img> may load: site-relative, http(s), blob: and data:image (a downscaled drop is ~300 kB of data URL).
const okUrl = (u) => typeof u === 'string' && (/^data:image\//i.test(u) || (u.length <= 2048 && /^(https?:\/\/|\/(?!\/)|blob:)/i.test(u)));
// Depth and id texels for an aspect: TEXELS on the long side.
const texels = (aspect) => (aspect >= 1 ? { w: TEXELS, h: Math.max(2, Math.round(TEXELS / aspect)) } : { w: Math.max(2, Math.round(TEXELS * aspect)), h: TEXELS });
// A depth image (enrich.js: one byte per pixel, rows top first, 255 nearest) in depth.js's layout (rows bottom-up, 0 far
// to 1 near), or null when it is not one. Unblurred, as v1 used Depth Anything's output.
function reliefOf(d) {
  const w = d && d.w, h = d && d.h;
  if (!d || !ArrayBuffer.isView(d.data) || !Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > MAX_TEX || h > MAX_TEX || d.data.length !== w * h) return null;
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = d.data[(h - 1 - j) * w + i] / 255;
  return { data, w, h, placeholder: false };
}

const tv = $('tv'), stage = $('stage'), canvas = $('gl'), hintEl = $('hint'), captionEl = $('caption'), statusEl = $('status'), modeTag = $('modeTag');
const originalEl = $('original'), originalImg = originalEl.querySelector('img'), originalTag = originalEl.querySelector('.tag');
const fit = () => tv.style.setProperty('--fit', Math.min(innerWidth / 1920, innerHeight / 1080));
addEventListener('resize', fit); fit();

// ---------- state ----------
const listeners = new Set();
const emit = (e) => { for (const cb of listeners) try { cb(e); } catch (err) { console.error(err); } };
const players = new Map(); // pid -> figure
let W = H * TURNER, lens = rig(W, H, SW / SH); // camera.js: the follow math, swept by tests/camera.test.js
let current = null, stops = [], path = null, curve = null, depth = null, sample = () => 0.5, sheets = null;
let imageUrl = BOOT_IMG, credit = BOOT_CREDIT, gen = 0; // gen: the latest loadScene/showImage; an older one never lands
let depthFromAi = false; // setDepth re-skinned the relief with an estimated depth image; build() clears it
let layer = 'painting', judge = false, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches, originalTimer = 0;
let simTime = 0, fps = 0, notice = '';
const attract = { idle: 0, on: false, lean: 0 };
const cam = { tx: 0, ty: 0, zoom: 1, lean: 0, leanY: 0 }, aim = { tx: 0, ty: 0, zoom: 1 }, mouse = { x: 0, y: 0 };
const keys = { left: false, right: false, verb: false };
const glow = new Float32Array(SLOTS);

// ---------- renderer, scene, relief ----------
const scene = new THREE.Scene();
const stageBg = new THREE.Color(tok('--rail-night'));
scene.background = stageBg;
const camera = new THREE.PerspectiveCamera(FOV, SW / SH, 0.1, 50);

const blank = new THREE.DataTexture(Uint8Array.from([stageBg.r, stageBg.g, stageBg.b, 1], (x) => x * 255), 1, 1);
blank.needsUpdate = true;
const noLines = new THREE.DataTexture(new Uint8Array(4), 1, 1); // no stops, no outlines: transparent
noLines.needsUpdate = true;
const uniforms = {
  map: { value: blank }, depthMap: { value: null }, idMap: { value: null }, amp: { value: AMP }, mode: { value: 0 },
  glow: { value: glow }, outline: { value: noLines },
  cyan: { value: new THREE.Color(tok('--prussian')) }, cream: { value: new THREE.Color(tok('--cream')) },
};
// GLSL ES 1.0: the fixed 9-slot loop compares the texel's id instead of indexing the array with it.
const mat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: `uniform sampler2D depthMap; uniform sampler2D idMap; uniform float amp; uniform float glow[${SLOTS}];
    varying vec2 vUv; varying float vD; varying float vGlow;
    void main() {
      vUv = uv; vD = texture2D(depthMap, uv).r;
      float id = floor(texture2D(idMap, uv).r * 255.0 + 0.5);
      vGlow = 0.0;
      for (int i = 0; i < ${SLOTS}; i++) { if (abs(id - float(i)) < 0.5) vGlow = glow[i]; }
      vec3 p = position; p.z += vD * amp;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
  fragmentShader: `uniform sampler2D map; uniform sampler2D outline; uniform int mode; uniform vec3 cyan; uniform vec3 cream;
    varying vec2 vUv; varying float vD; varying float vGlow;
    void main() {
      vec3 c = mode == 1 ? mix(cyan, cream, vD) : texture2D(map, vUv).rgb;
      // dark texels glow toward cream, pale ones toward Prussian: a cream glow on white paper moved pixels by 2/255
      vec3 tint = mix(cream, cyan, smoothstep(0.52, 0.62, dot(c, vec3(0.299, 0.587, 0.114))));
      vec4 line = texture2D(outline, vUv); // every stop's outline, over the picture and its glow
      gl_FragColor = vec4(mix(mix(c, tint, vGlow * 0.6), line.rgb, line.a), 1.0); }`,
});
const relief = new THREE.Mesh(new THREE.PlaneGeometry(W, H, 1, 1), mat);
scene.add(relief);

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SW, SH, false);
} catch (err) {
  renderer = null; notice = 'WebGL is not available in this browser.';
}
const upload = (tex) => { if (renderer && tex) renderer.initTexture(tex); }; // upload now so no sprite ever flashes white

function idTexture({ data, w, h }) {
  const tex = new THREE.DataTexture(data, w, h, THREE.LuminanceFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; // ids must never blend into a neighbour's
  tex.needsUpdate = true;
  return tex;
}
function swapTex(key, tex) {
  const old = uniforms[key].value;
  uniforms[key].value = tex; upload(tex);
  if (old && old !== blank && old !== noLines && old !== tex) old.dispose();
}

// ---------- the stops, shown on the stage ----------
// Where a figure can walk to: a numbered enamel marker on the path at each stop (the left margin numbers its stops
// the same). The object a figure stands at is outlined in that rider's colour, with an ink edge each side so it reads
// on pale paper and dark paint, over a light wash of its region so a big one reads as a region (the sky) and a tiny
// one gets a ring (the hare). Drawn into a texture the relief lays over the picture, only when who stands where
// changes. Far objects first, each erasing what it covers, so a line never crosses an object in front of it.
const LINES_LONG = 1024, SMALL = 90; // the outline texture's long side; a box under 90 of 1000 on both sides is circled
let lines = null, linesKey = '';
const markers = [];
function linesFor(aspect) {
  const c = document.createElement('canvas');
  c.width = Math.round(aspect >= 1 ? LINES_LONG : LINES_LONG * aspect); c.height = Math.round(aspect >= 1 ? LINES_LONG / aspect : LINES_LONG);
  return { c, tex: new THREE.CanvasTexture(c) };
}
function stepLines() {
  if (!lines || !current) return;
  const who = new Map(); // object index -> the first rider's colour there
  // in arrival order, as margins.js keeps its riders: the first to arrive colours a shared stop in both places
  for (const f of [...players.values()].sort((a, b) => (a.nearAt ?? 0) - (b.nearAt ?? 0))) if (f.near != null && !who.has(f.near)) who.set(f.near, f.color);
  const key = [...who].map((e) => e.join(':')).sort().join('|');
  if (key === linesKey) return;
  linesKey = key;
  const { c } = lines, g = c.getContext('2d'), k = Math.max(c.width, c.height) / 2048, ink = tok('--ink');
  // A point on the picture's edge goes past it, so the sky's or a river's border draws no frame round the picture.
  const edge = (v, size) => (v <= 0.5 ? -24 * k : v >= 999.5 ? size + 24 * k : v / 1000 * size);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, c.width, c.height);
  g.lineJoin = 'round';
  for (const { index, pts } of objectOutlines(current)) {
    g.beginPath();
    pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](edge(x, c.width), edge(y, c.height)));
    g.closePath();
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1; g.fill();
    const color = who.get(index);
    if (!color) continue;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = color; g.globalAlpha = 0.16; g.fill();
    g.globalAlpha = 1;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const line = () => { g.strokeStyle = ink; g.lineWidth = 15 * k; g.stroke(); g.strokeStyle = color; g.lineWidth = 7 * k; g.stroke(); };
    line();
    if (bw < SMALL && bh < SMALL) { // too small to see by its outline: a ring round it too
      g.beginPath();
      g.arc((Math.max(...xs) + Math.min(...xs)) / 2000 * c.width, (Math.max(...ys) + Math.min(...ys)) / 2000 * c.height,
        Math.max(bw / 1000 * c.width, bh / 1000 * c.height) * 0.75 + 28 * k, 0, Math.PI * 2);
      line();
    }
  }
  lines.tex.needsUpdate = true;
}
function drawMarker(sp) {
  const c = sp.material.map.image, g = c.getContext('2d');
  c.width = c.height = 128;
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2);
  g.fillStyle = tok('--cream'); g.fill();
  g.lineWidth = 10; g.strokeStyle = tok('--livery'); g.stroke();
  g.fillStyle = tok('--livery'); g.font = '600 62px "Libre Franklin", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(sp.userData.n), 64, 68);
  sp.material.map.needsUpdate = true;
}
function setMarkers(list) {
  for (const sp of markers) { scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); }
  markers.length = 0;
  list.forEach((st, i) => {
    const tex = new THREE.CanvasTexture(document.createElement('canvas'));
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.center.set(0.5, 0.2); sp.renderOrder = 20; // under every figure (their order is 50 and up)
    Object.assign(sp.userData, { n: i + 1, stop: st });
    drawMarker(sp); scene.add(sp); upload(tex); markers.push(sp);
  });
  placeMarkers();
}
// On the path at its stop (the overlay can drag a stop, so its t is read each step), sized like a figure there.
function placeMarkers() {
  for (const sp of markers) { const t = sp.userData.stop.t, h = figH(t) * 0.3; at(t, 0.012, sp.position); sp.scale.set(h, h, 1); }
}

function loadImage(url) {
  return new Promise((ok, fail) => {
    if (!okUrl(url)) { fail(new Error('image URL refused')); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Blob URLs are cross-origin; without CORS the load fails rather than tainting WebGL
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error('image did not load'));
    img.src = url;
  });
}
// The image drawn into a canvas at most MAX_TEX on its long side (an SVG without a size still rasterises), and its aspect.
function imageTexture(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight, aspect = clamp(nw > 0 && nh > 0 ? nw / nh : 4 / 3, 0.25, 4);
  const long = Math.min(MAX_TEX, Math.max(nw, nh) || 1024), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(aspect >= 1 ? long : long * aspect));
  c.height = Math.max(1, Math.round(aspect >= 1 ? long / aspect : long));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { tex: new THREE.CanvasTexture(c), aspect };
}

// ---------- path and stops ----------
const tmp = new THREE.Vector3();
// World position at path parameter t. h comes from the curve, never a per-frame depth sample; the live amplitude
// keeps figures on the relief while the exploded layer eases it.
function at(t, lift, out) { const p = curve.getPoint(clamp(t, 0, 1), tmp); return out.set((p.x - 0.5) * W, (p.y - 0.5) * H, p.z * uniforms.amp.value + lift); }
// pathOverlay.js edits {image, points, plaques}; the stops ride as its plaques, so dragging one moves the stop.
function setPath(p) {
  path = p;
  curve = new THREE.CatmullRomCurve3(p.points.map(([u, v, h]) => new THREE.Vector3(u, v, h)), false, 'catmullrom', 0.5);
}
const stopAt = (t) => stops.find((s) => Math.abs(t - s.t) <= HOTSPOT_HALF_WIDTH) || null;
const stopOf = (index) => (index == null ? null : stops.find((s) => s.index === index) || null);

// Swap in a whole stage: the plane at the image's aspect, its textures, the walk path and the stops; every figure
// goes back to its staggered start. Everything that can fail has already run.
function build(tex, aspect, d, ids, points, newStops) {
  W = H * aspect; lens = rig(W, H, SW / SH);
  relief.geometry.dispose();
  relief.geometry = new THREE.PlaneGeometry(W, H, Math.round(SEGS * Math.min(1, aspect)), Math.round(SEGS / Math.max(1, aspect)));
  swapTex('map', tex);
  swapTex('depthMap', renderer ? depthTexture(renderer, d) : null);
  swapTex('idMap', idTexture(ids));
  lines = current && newStops.length ? linesFor(aspect) : null; linesKey = null; // drawn on the next step
  swapTex('outline', lines ? lines.tex : noLines);
  depth = d; sample = sampler(d); stops = newStops; depthFromAi = false;
  if (notice === NO_IMAGE) notice = '';
  setPath({ image: imageUrl, points, plaques: stops });
  setMarkers(stops);
  glow.fill(0);
  for (const [pid, f] of players) {
    f.t = startT(pid); f.facing = 1; // as reset() does: an inside phone takes its heading from this
    if (f.near != null) { f.near = null; emit({ type: 'near', pid, object: null, label: null }); }
    place(f);
  }
  if (originalImg.getAttribute('src') !== imageUrl) originalImg.src = imageUrl;
  originalTag.textContent = `Original. ${credit}`;
  renderCaption(); renderHint();
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
function place(f) {
  const p = at(f.t, 0.015, f.sprite.position);
  const h = figH(f.t), k = f.pulse > 0 ? 1 + 0.18 * Math.abs(Math.sin(Math.PI * f.pulse / 0.6)) : 1; // one pulse per 0.6 s
  f.sprite.scale.set(h * k * FIG_ASPECT, h * k, 1);
  f.sprite.renderOrder = 100 - Math.round(f.t * 50);
  f.shadow.position.set(p.x, p.y + 0.004, p.z + 0.005);
  f.shadow.scale.set(h * 0.55, h * 0.16, 1);
  f.shadow.renderOrder = f.sprite.renderOrder - 1;
  setFrame(f.tex, f.pulse > 0 ? WAVE : f.lx && !f.frozen ? WALK[Math.floor(f.phase) % 4] : IDLE, f.facing);
  if (f.tag) { f.tag.position.set(p.x, p.y + h * k + TAG_GAP, p.z); f.tag.scale.set(TAG_H * f.tag.userData.aspect, TAG_H, 1); }
  f.sprite.visible = f.shadow.visible = f.active;
}

// The verb at a stop: tell glue which object to describe (sound, the TV margin, the phone's card). Nothing moves.
function describeAt(pid, f) {
  const st = stopOf(f.near), o = st && current && current.objects[st.index];
  if (!o) return;
  emit({ type: 'describe', pid, index: st.index, label: st.label, kind: o.kind, description: typeof o.description === 'string' ? o.description : '' });
}

// The shader's only per-object effect: a soft glow on each object a figure stands at.
function stepGlow() {
  glow.fill(0);
  for (const f of players.values()) if (f.near != null && f.near + 1 < SLOTS) glow[f.near + 1] = NEAR_GLOW;
}

// ---------- margins and captions ----------
function renderHint() {
  const st = stopOf(players.get(0)?.near);
  const text = notice || (st ? `${st.label} (AI label) · Space describes it` : stops.length ? '← → walk · Space describes what you stand at' : '← → walk the picture');
  if (hintEl.textContent !== text) hintEl.textContent = text;
}
function depthLine() {
  if (current && depthFromAi) return 'Depth map: estimated from the picture by Depth Anything V2 (AI estimate)';
  if (current) return current.edited ? 'Depth map: from a hand-corrected reading (sample)' : `Depth map: from ${current.model}'s reading (AI draft)`;
  return depth && depth.placeholder ? 'Depth map: hand-authored placeholder, 2026' : 'Depth map: flat until the reading lands';
}
function renderCaption() {
  const text = layer === 'network' ? '' // margins.js puts the platform panel over the stage bottom
    : attract.on ? ATTRACT_LINE
    : layer === 'depth' ? depthLine()
    : layer === 'exploded' ? 'Exploded layers: the relief at three times its depth, each object at its depth guess' : '';
  captionEl.textContent = text; captionEl.hidden = !text;
}
function renderTag() {
  const shown = !originalEl.hidden;
  const lines = [[shown ? 'Original' : LAYER_NAME[layer]], [layer !== 'painting' && !shown ? `${fps} fps` : ''], [judge ? 'Guided tour' : '', 'judge'], [reduced ? 'Reduced motion' : '']];
  modeTag.replaceChildren(...lines.filter(([t]) => t).map(([t, cls]) => Object.assign(document.createElement('span'), { textContent: t, className: cls || '' })));
}
function setLayer(i) {
  layer = LAYERS[(i + LAYERS.length) % LAYERS.length];
  uniforms.mode.value = layer === 'depth' ? 1 : 0;
  hideOriginal(); renderCaption();
  emit({ type: 'layer', name: layer });
}
function hideOriginal() { clearTimeout(originalTimer); originalEl.hidden = true; renderTag(); }
function setReduced(on) { reduced = on; tv.classList.toggle('reduced', on); if (on) for (const f of players.values()) f.pulse = 0; renderTag(); }
function stopAttract() { attract.on = false; attract.lean = 0; renderCaption(); }
function wake() { attract.idle = 0; if (attract.on) stopAttract(); }

// ---------- window.game ----------
// The README's window.game table, plus three calls for what arrives after a scene is on stage (src/host/enrich.js and
// the 3D models): setDepth(depth) re-skins the relief with a depth image ({data: Uint8Array, w, h}, one byte per pixel,
// rows top first, 255 nearest), its texture, sampler and path heights, leaving the figures, stops and camera where they
// are (false for a bad image or no scene). setSceneField('depth_url', url) and setObjectModel(index, url) set that field
// on the scene game.scene() returns, through validateScene (false when the URL does not pass), and emit
// {type:'enriched', scene}. onHotspot takes any number of listeners. A rising verb (setInput's a, the keyboard's Space
// or Enter) at a stop emits {type:'describe', pid, index, label, kind, description}, description '' when the object has
// none; it replaces the old poke, so nothing pops, scales or waves and there is no game.poke. No object ever moves.
const ENRICH_FIELDS = ['depth_url'];
function enriched(next, ok) {
  if (!ok) return false;
  current = next;
  emit({ type: 'enriched', scene: current });
  return true;
}
const game = window.game = {
  addPlayer(pid, name, color) {
    pid = Number(pid);
    if (!Number.isInteger(pid)) return;
    name = String(name ?? ''); color = String(color || tok('--cream'));
    const f = players.get(pid);
    if (!f) {
      // pid 0, the TV's own keyboard player, is the Conductor; phones alternate top hat and bonnet.
      const n = Object.assign(makeFigure(color, pid === 0 ? 'conductor' : pid % 2 === 0, name, pid !== 0), { t: startT(pid), pulse: reduced || pid === 0 ? 0 : 1.2 });
      players.set(pid, n); place(n);
      return;
    }
    if (color !== f.color) { f.color = color; paintSheet(f.tex.image, sheets, color, f.bonnet); f.tex.needsUpdate = true; upload(f.tex); }
    if (f.tag && (name !== f.tag.userData.text || color !== f.tag.userData.dot)) { Object.assign(f.tag.userData, { text: name, dot: color }); drawLabel(f.tag); upload(f.tag.material.map); }
    f.name = name;
    const st = stopOf(f.near); // a reloaded phone resets its verb label; step() only emits on change
    if (st) emit({ type: 'near', pid, object: st.index, label: st.label });
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
    if (lx || a) wake();
    if (f.frozen) return;
    f.lx = lx;
    if (rising && f.near != null) describeAt(pid, f);
  },
  onHotspot(cb) { if (typeof cb === 'function') listeners.add(cb); return () => listeners.delete(cb); },
  sendTo() {},
  sendAll() {},
  freeze(pid, on) { const f = players.get(Number(pid)); if (!f) return; f.frozen = !!on; if (on) f.lx = 0; },
  setJudge(on) { judge = !!on; if (judge) stopAttract(); renderTag(); },
  showOriginal() { originalEl.hidden = false; clearTimeout(originalTimer); originalTimer = setTimeout(hideOriginal, ORIGINAL_MS); renderTag(); },
  reset() {
    for (const [pid, f] of players) Object.assign(f, { t: startT(pid), lx: 0, a: 0, frozen: false, facing: 1, phase: 0, pulse: 0 });
    keys.left = keys.right = keys.verb = false; glow.fill(0);
    setLayer(0); attract.idle = 0; stopAttract(); renderHint();
  },
  // A validated scene on the relief. Rejects, keeping the old scene, when the image fails; a call overtaken by a later
  // loadScene or showImage resolves without touching the stage.
  async loadScene(raw, opts) {
    const s = validateScene(raw), my = ++gen;
    const url = opts && typeof opts.image === 'string' && opts.image ? opts.image : s.image_url;
    const img = await loadImage(url);
    if (my !== gen) return;
    const { tex, aspect } = imageTexture(img), size = texels(aspect);
    const d = sceneDepth(s, size), ids = objectIdMap(s, size), points = pathPoints(s, sampler(d));
    const st = objectHotspots(s, points).map((h) => ({ id: `obj:${h.index}`, ...h }));
    current = s; imageUrl = url;
    credit = s.credit || (s.title_guess === 'unknown' ? 'As it was sent.' : `${s.title_guess} (AI guess)`);
    build(tex, aspect, d, ids, points, st);
    emit({ type: 'scene', scene: s });
  },
  // The flat state, while reading and when reading failed: the image on a flat plane, the flat path, no stops.
  async showImage(url) {
    const my = ++gen, img = await loadImage(url);
    if (my !== gen) return;
    const { tex, aspect } = imageTexture(img);
    current = null; imageUrl = url; credit = 'As it was sent.';
    build(tex, aspect, { data: new Float32Array(4), w: 2, h: 2, placeholder: false }, { data: new Uint8Array(1), w: 1, h: 1 }, pathPoints(FLAT, () => 0), []);
    emit({ type: 'scene', scene: null });
  },
  setStatus(text) {
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    statusEl.textContent = t; statusEl.hidden = !t;
  },
  scene: () => current,
  stats: () => ({ fps, zoom: Math.round(cam.zoom * 100) / 100, lean: Math.round(cam.lean * 10) / 10, layer }),
  // [{pid, t, facing}] for every joined figure (pid 0, the keyboard, included): glue.js sends them to inside phones.
  positions: () => [...players].map(([pid, f]) => ({ pid, t: f.t, facing: f.facing })),
  setDepth(raw) {
    const d = current && reliefOf(raw);
    if (!d) return false;
    swapTex('depthMap', renderer ? depthTexture(renderer, d) : null);
    depth = d; sample = sampler(d); depthFromAi = true;
    // the walk keeps its points (and any overlay edit), standing at the new heights as pathPoints would place them
    path.points = path.points.map(([u, v]) => [u, v, Math.round(clamp(sample(u, v), 0, 1) * 1e4) / 1e4]);
    setPath(path);
    renderCaption();
    return true;
  },
  setSceneField(key, value) {
    if (!current || !ENRICH_FIELDS.includes(key)) return false;
    const next = validateScene({ ...current, [key]: value });
    return enriched(next, next[key] === value);
  },
  setObjectModel(index, url) {
    const i = Number(index);
    if (!current || !Number.isInteger(i) || !current.objects[i]) return false;
    const next = validateScene({ ...current, objects: current.objects.map((o, k) => (k === i ? { ...o, model_url: url } : o)) });
    return enriched(next, next.objects[i] && next.objects[i].model_url === url);
  },
};

// ---------- follow camera ----------
const group = () => [...players.values()]; // never empty: pid 0 stays
function aimCamera() {
  if (overlay.visible) { Object.assign(aim, { tx: 0, ty: 0, zoom: 1 }); return; } // hold still on the whole path while dots are dragged
  const looks = [];
  for (const f of players.values()) { const st = stopOf(f.near); if (st) looks.push([(st.look[0] - 0.5) * W, (st.look[1] - 0.5) * H]); }
  Object.assign(aim, followAim(lens, groupBox(group().map((f) => ({ x: f.sprite.position.x, y: f.sprite.position.y, t: f.t, tagged: !!f.tag })), looks)));
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
    const st = stopAt(f.t), near = st ? st.index : null;
    if (near !== f.near) { f.near = near; f.nearAt = simTime; emit({ type: 'near', pid, object: near, label: st ? st.label : null }); if (pid === 0) renderHint(); }
    f.pulse = Math.max(0, f.pulse - STEP);
  }
  attract.idle += STEP;
  if (!attract.on && !judge && attract.idle > 45) { attract.on = true; renderCaption(); }
  else if (attract.on && judge) stopAttract();
  attract.lean = attract.on && !reduced ? Math.sin(simTime / 4) * 5 : 0;
  uniforms.amp.value += ((layer === 'exploded' ? AMP * EXPLODE : AMP) - uniforms.amp.value) * EASE_AMP;
  stepGlow(); stepLines();
  for (const f of players.values()) place(f);
  placeMarkers();
  aimCamera(); stepCamera(STEP); arrangeTags();
}

// Name tags stay legible: pulled inside the frame (the path starts near the stage edge), then lifted clear of
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
  stage, camera, size: () => ({ W, H, AMP: uniforms.amp.value }), getPath: () => path, getCurve: () => curve, sample: (u, v) => sample(u, v), onChange: () => setPath(path),
});

let last = performance.now(), acc = 0, frames = 0, fpsT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const el = clamp((now - last) / 1000, 0, 0.25);
  last = now; acc += el;
  for (let n = 0; acc >= STEP && n < 5; n++) { step(); acc -= STEP; }
  if (acc >= STEP) acc = 0; // more than 5 steps behind: drop the backlog rather than spiral
  overlay.draw();
  if (renderer) renderer.render(scene, camera);
  frames++; fpsT += el;
  if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = fpsT = 0; if (layer !== 'painting') renderTag(); }
}

// ---------- input: scene owns ← → Space Enter Esc O W M ` (artwork owns G U 1 2 3, glue H J R Q, audio S, margins L X, models3d D, apibox K) ----------
const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const kb = () => game.setInput(0, keys.right - keys.left, keys.verb ? 1 : 0);
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return; // an open gallery takes its keys in the capture phase
  if (e.key === 'Escape') { wake(); if (!originalEl.hidden) hideOriginal(); return; }
  if (typing(e.target)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((k === ' ' || k === 'Enter') && e.target.tagName === 'BUTTON') return; // let a focused button activate
  if (!['ArrowLeft', 'ArrowRight'].includes(k) && e.repeat) return;
  wake();
  if (k === 'ArrowLeft') keys.left = true;
  else if (k === 'ArrowRight') keys.right = true;
  else if (k === ' ' || k === 'Enter') keys.verb = true;
  else if (k === 'o') game.showOriginal();
  else if (k === 'w') setLayer(LAYERS.indexOf(layer) + 1);
  else if (k === 'm') setReduced(!reduced);
  else if (k === '`' || e.code === 'Backquote') overlay.toggle();
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

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return; // lean follows the mouse only
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2; mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
  wake();
});
canvas.addEventListener('pointerleave', () => { mouse.x = mouse.y = 0; });
// a mouse-used button would otherwise keep the arrow keys and Space
stage.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && e.target.matches('input, button')) e.target.blur(); });

// ---------- boot: the Turner on its hand-authored relief, no stops, until artwork.js loads sample 1 ----------
setReduced(reduced);
build(blank, TURNER, placeholderDepth(), { data: new Uint8Array(1), w: 1, h: 1 }, BOOT_POINTS, []); // before any figure: place() needs the curve
game.addPlayer(0, 'Conductor', tok('--slot-keyboard'));
renderHint();
requestAnimationFrame(frame);

loadImage(BOOT_IMG).then((img) => { if (gen === 0) swapTex('map', imageTexture(img).tex); },
  () => { if (gen === 0) { notice = NO_IMAGE; renderHint(); } });
loadSheets().then((s) => {
  if (!s) return;
  sheets = s;
  for (const f of players.values()) { paintSheet(f.tex.image, s, f.color, f.bonnet); f.tex.needsUpdate = true; upload(f.tex); }
});
document.fonts?.load('600 56px "Libre Franklin"').then(() => {
  for (const sp of [...players.values()].map((f) => f.tag).filter(Boolean)) { drawLabel(sp); upload(sp.material.map); }
  for (const sp of markers) { drawMarker(sp); upload(sp.material.map); }
}, () => {});
