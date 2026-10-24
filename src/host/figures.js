// Cut-paper figures. Every figure is one 1024 x 384 sheet of four 256 x 384 frames (walk1, walk2, walk3, wave):
// D's PNGs from public/sprites/ when all four load, else the prototype's procedural canvas figures drawn into
// the same layout, so the frame and mirroring code is one path either way.
import * as THREE from 'three';

export const WALK = [0, 1, 2, 1], IDLE = 1, WAVE = 3, ASPECT = 256 / 384;
const SW = 1024, SH = 384;
const img = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

// Resolves to the four sheets, or null when any is missing.
export async function loadSheets() {
  const [tophat, bonnet, tophatAccent, bonnetAccent] = await Promise.all(
    ['tophat', 'bonnet', 'tophat-accent', 'bonnet-accent'].map((n) => img(`/sprites/${n}.png`)));
  return tophat && bonnet && tophatAccent && bonnetAccent ? { tophat, bonnet, tophatAccent, bonnetAccent } : null;
}

// The prototype figure (128 x 192 units, drawn at 2x), legs per frame; frame 3 raises an arm to wave.
// style: 'conductor', 'bonnet', or the old flag (true = bonnet, false or missing = top hat).
function drawCell(g, f, accent, style) {
  g.setTransform(2, 0, 0, 2, f * 256 + 128, 0);
  if (style === 'conductor') { drawConductor(g, f, accent); g.setTransform(1, 0, 0, 1, 0, 0); return; }
  const bonnet = style === true || style === 'bonnet';
  const legA = [-10, 0, 10, 0][f], legB = [10, 0, -10, 0][f];
  const shape = (stroke) => {
    g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#f3e9d2'; g.fillStyle = '#1a1510';
    const done = () => { g.closePath(); if (stroke) g.stroke(); g.fill(); };
    g.beginPath(); g.moveTo(-8, 120); g.lineTo(-8 + legA, 184); g.lineTo(2 + legA, 184); g.lineTo(0, 120); done();
    g.beginPath(); g.moveTo(8, 120); g.lineTo(8 + legB, 184); g.lineTo(18 + legB, 184); g.lineTo(10, 120); done();
    g.beginPath();
    if (bonnet) { g.moveTo(-14, 60); g.lineTo(14, 60); g.lineTo(34, 128); g.lineTo(-34, 128); }
    else { g.moveTo(-18, 58); g.lineTo(18, 58); g.lineTo(22, 126); g.lineTo(-22, 126); }
    done();
    if (f === WAVE) { g.beginPath(); g.moveTo(10, 66); g.lineTo(30, 22); g.lineTo(38, 26); g.lineTo(20, 72); done(); }
    g.beginPath(); g.arc(0, 44, 14, 0, Math.PI * 2); done();
    g.beginPath();
    if (bonnet) { g.arc(0, 40, 20, Math.PI, 0); g.lineTo(22, 50); g.lineTo(-22, 50); }
    else { g.rect(-13, 8, 26, 26); g.rect(-24, 32, 48, 6); }
    done();
  };
  shape(true); shape(false);
  g.fillStyle = accent;
  if (bonnet) g.fillRect(-20, 44, 40, 5); else g.fillRect(-13, 26, 26, 6);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

// A Victorian railway conductor on the same frame, pivot and ground line: peaked cap with a brass badge, a navy
// double-breasted frock coat, whistle on a chain, a hand lamp swinging in the left hand. Accent: cap band and cuffs.
const INK = '#1a1510', NAVY = '#24345e', TROUSER = '#1c2030', BRASS = '#d0a84e', LAMP = '#fff0b0', VISOR = '#4b5a7a';
function drawConductor(g, f, accent) {
  const legA = [-10, 0, 10, 0][f], legB = [10, 0, -10, 0][f], s = [-3, 0, 3, 0][f], lx = -28 + s;
  const arms = [[-15, 63, lx, 104], f === WAVE ? [15, 68, 32, 28] : [15, 63, 26 - s, 104]];
  const band = (a, w, t0, t1) => { // a strip of width w along an arm, from fraction t0 to t1
    const dx = a[2] - a[0], dy = a[3] - a[1], k = w / 2 / Math.hypot(dx, dy), nx = -dy * k, ny = dx * k;
    g.moveTo(a[0] + dx * t0 + nx, a[1] + dy * t0 + ny); g.lineTo(a[0] + dx * t1 + nx, a[1] + dy * t1 + ny);
    g.lineTo(a[0] + dx * t1 - nx, a[1] + dy * t1 - ny); g.lineTo(a[0] + dx * t0 - nx, a[1] + dy * t0 - ny); g.closePath();
  };
  const leg = (x, d) => { g.moveTo(x, 120); g.lineTo(x + d - 1, 176); g.lineTo(x + d - 1, 184); g.lineTo(x + d + 15, 184);
    g.lineTo(x + d + 13, 177); g.lineTo(x + d + 9, 174); g.lineTo(x + 8, 120); g.closePath(); };
  const coat = () => { g.moveTo(-17, 58); g.lineTo(17, 58); g.lineTo(19, 90); g.lineTo(16, 98); g.lineTo(25, 142);
    g.lineTo(-25, 142); g.lineTo(-16, 98); g.lineTo(-19, 90); g.closePath(); };
  const crown = () => { g.moveTo(-13, 27); g.lineTo(-17, 12); g.lineTo(17, 12); g.lineTo(13, 27); g.closePath(); };
  const lamp = () => { g.moveTo(lx - 5, 112); g.lineTo(lx + 5, 112); g.lineTo(lx + 8, 118); g.lineTo(lx - 8, 118); g.closePath();
    g.rect(lx - 8, 118, 16, 21); g.rect(lx - 9, 138, 18, 5); };
  const peak = () => { g.moveTo(-15, 32); g.lineTo(19, 32); g.quadraticCurveTo(18, 40, 2, 40); g.quadraticCurveTo(-13, 40, -15, 32); };
  const fill = (c, path) => { g.fillStyle = c; g.beginPath(); path(); g.fill(); };
  const shape = (stroke) => {
    g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#f3e9d2'; g.fillStyle = INK;
    const done = () => { if (stroke) g.stroke(); g.fill(); };
    g.beginPath(); leg(-12, legA); leg(4, legB); done();
    g.beginPath(); coat(); g.rect(-8, 51, 16, 9); done();
    for (const a of arms) {
      const hx = a[2] + (a[2] - a[0]) * 0.1, hy = a[3] + (a[3] - a[1]) * 0.1;
      g.beginPath(); band(a, 10, 0, 1); g.moveTo(hx + 5, hy); g.arc(hx, hy, 5, 0, Math.PI * 2); done();
    }
    g.beginPath(); lamp(); done();
    g.beginPath(); g.arc(0, 44, 14, 0, Math.PI * 2); done();
    g.beginPath(); crown(); g.rect(-13, 26, 26, 7); done();
    g.beginPath(); peak(); done();
  };
  shape(true); shape(false);
  g.save(); g.beginPath(); g.rect(-64, 120, 128, 46); g.clip(); fill(TROUSER, () => { leg(-12, legA); leg(4, legB); }); g.restore();
  fill(NAVY, () => { coat(); g.rect(-8, 51, 16, 9); });
  g.strokeStyle = INK; g.lineWidth = 1.5;
  // The cuffs get an ink edge so a pale accent (the keyboard's cream) does not melt into the outline.
  for (const a of arms) { fill(NAVY, () => band(a, 10, 0, 1)); g.stroke(); fill(accent, () => band(a, 10.5, 0.8, 1)); g.stroke(); }
  g.beginPath(); g.moveTo(0, 100); g.lineTo(0, 142); g.stroke(); // the frock coat's skirts part below the waist
  fill(NAVY, crown); fill(accent, () => g.rect(-13, 26, 26, 6));
  fill(VISOR, peak); // slate, so the peak shows against the black head
  fill(BRASS, () => { g.arc(0, 19, 3.5, 0, Math.PI * 2); });
  for (const y of [66, 75, 84, 93]) fill(BRASS, () => { g.arc(-5.5, y, 2.4, 0, Math.PI * 2); g.moveTo(7.9, y); g.arc(5.5, y, 2.4, 0, Math.PI * 2); });
  g.strokeStyle = BRASS; g.lineWidth = 1.2; g.beginPath(); g.moveTo(5.5, 66); g.quadraticCurveTo(14, 70, 12, 79); g.stroke();
  fill(BRASS, () => g.rect(9, 79, 7, 4)); // the whistle
  fill(BRASS, lamp);
  fill(LAMP, () => g.rect(lx - 5.5, 121, 11, 15));
  g.strokeStyle = INK; g.lineWidth = 1.2; g.beginPath(); g.rect(lx - 5.5, 121, 11, 15); g.moveTo(lx, 121); g.lineTo(lx, 136); g.stroke();
}

// style: as drawCell. There is no sprite sheet for the conductor, so it is always the procedural figure.
export function paintSheet(canvas, sheets, accent, style) {
  const g = canvas.getContext('2d'), bonnet = style === true || style === 'bonnet';
  g.clearRect(0, 0, SW, SH);
  if (!sheets || style === 'conductor') { for (let f = 0; f < 4; f++) drawCell(g, f, accent, style); return; }
  const mask = bonnet ? sheets.bonnetAccent : sheets.tophatAccent, t = document.createElement('canvas');
  t.width = SW; t.height = SH;
  const tg = t.getContext('2d');
  tg.drawImage(mask, 0, 0, SW, SH);
  tg.globalCompositeOperation = 'multiply'; tg.fillStyle = accent; tg.fillRect(0, 0, SW, SH);
  tg.globalCompositeOperation = 'destination-in'; tg.drawImage(mask, 0, 0, SW, SH); // multiply also painted the transparent area
  g.drawImage(bonnet ? sheets.bonnet : sheets.tophat, 0, 0, SW, SH);
  g.drawImage(t, 0, 0);
}

export function sheetTexture(sheets, accent, style) {
  const c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  paintSheet(c, sheets, accent, style);
  const tex = new THREE.CanvasTexture(c);
  tex.repeat.set(0.25, 1);
  return tex;
}

// Sprites ignore a negative scale, so a left-facing figure flips the uv transform instead.
export function setFrame(tex, f, facing) {
  tex.repeat.x = facing < 0 ? -0.25 : 0.25;
  tex.offset.x = (facing < 0 ? f + 1 : f) * 0.25;
}

let shadow = null;
export function shadowTexture() {
  if (shadow) return shadow;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  c.width = 128; c.height = 48;
  const gr = g.createRadialGradient(64, 24, 2, 64, 24, 60);
  gr.addColorStop(0, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.beginPath(); g.ellipse(64, 24, 62, 20, 0, 0, Math.PI * 2); g.fill();
  return (shadow = new THREE.CanvasTexture(c));
}

// A rounded label sprite (plaque numbers, name tags). drawLabel(sprite) redraws it, e.g. once the web font lands;
// sprite.userData.aspect is width / height for scaling.
export function textSprite(text, { bg, fg, dot = null, alpha = 1, px = 56 }) {
  const tex = new THREE.CanvasTexture(document.createElement('canvas'));
  tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.center.set(0.5, 0);
  Object.assign(sp.userData, { text, bg, fg, dot, alpha, px });
  drawLabel(sp);
  return sp;
}

export function drawLabel(sp) {
  const { text, bg, fg, dot, alpha, px } = sp.userData, c = sp.material.map.image, g = c.getContext('2d');
  const font = `600 ${px}px "Libre Franklin", Arial, sans-serif`, pad = px * 0.45, dw = dot ? px * 0.85 : 0;
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width + pad * 2 + dw); c.height = Math.round(px * 1.6); // resizing resets the context
  const w = c.width, h = c.height, r = px * 0.25;
  g.beginPath(); g.moveTo(3 + r, 3); g.arcTo(w - 3, 3, w - 3, h - 3, r); g.arcTo(w - 3, h - 3, 3, h - 3, r); g.arcTo(3, h - 3, 3, 3, r); g.arcTo(3, 3, w - 3, 3, r); g.closePath();
  g.globalAlpha = alpha; g.fillStyle = bg; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = 'rgba(27,21,16,.7)'; g.lineWidth = 3; g.stroke();
  if (dot) { g.beginPath(); g.arc(pad + px * 0.3, h / 2, px * 0.3, 0, Math.PI * 2); g.fillStyle = dot; g.fill(); g.strokeStyle = fg; g.lineWidth = 3; g.stroke(); }
  g.font = font; g.fillStyle = fg; g.textBaseline = 'middle';
  g.fillText(text, pad + dw, h / 2 + px * 0.04);
  sp.userData.aspect = w / h;
  sp.material.map.needsUpdate = true;
}
