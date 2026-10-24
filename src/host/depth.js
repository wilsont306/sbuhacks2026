// Depth for the relief: the 16-bit RG PNG from tools/depth.py decoded once on the CPU, or the prototype's
// hand-authored placeholder when the file is missing, so the kiosk works at every commit.
// Layout of `data`: row j is v = (j + 0.5) / h, bottom-up like texture UV; values 0 far .. 1 near.
import * as THREE from 'three';

const DW = 256, DH = 192;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Ported unchanged from the prototype.
export function depthAt(u, v) {
  let d;
  if (v > 0.62) d = 0.05 + 0.06 * smooth(0.95, 0.62, v);                       // sky, far
  else d = 0.11 + 0.80 * Math.pow((0.62 - v) / 0.62, 1.25);                   // ground, nearer toward the bottom
  // the viaduct: a ridge from the bottom right toward the centre, near at the right
  const ax = 0.97, ay = 0.02, vx = 0.46 - ax, vy = 0.46 - ay;
  const s = Math.min(1, Math.max(0, ((u - ax) * vx + (v - ay) * vy) / (vx * vx + vy * vy)));
  const dl = Math.hypot(u - (ax + s * vx), v - (ay + s * vy)), wb = 0.12 * (1 - s) + 0.03 * s;
  if (dl < wb) { const k = smooth(wb, wb * 0.35, dl); d = Math.max(d, (0.95 * (1 - s) + 0.32 * s) * k + d * (1 - k)); }
  // the locomotive, a nearer mass right of centre
  const ex = (u - 0.68) / 0.075, ey = (v - 0.47) / 0.11, er = ex * ex + ey * ey;
  if (er < 1) { const k = smooth(1, 0.2, er); d = Math.max(d, 0.80 * k + d * (1 - k)); }
  // the old road bridge, far left, slightly nearer than the sky
  const fx = (u - 0.16) / 0.14, fy = (v - 0.47) / 0.03;
  if (fx * fx + fy * fy < 1) d = Math.max(d, 0.20);
  return Math.min(1, Math.max(0, d));
}

// Two-pass box blur so edges do not rubber-sheet.
function blur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { acc += src[y * w + xx]; n++; } }
    tmp[y * w + x] = acc / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { acc += tmp[yy * w + x]; n++; } }
    out[y * w + x] = acc / n;
  }
  return out;
}

export function placeholderDepth() {
  const d = new Float32Array(DW * DH);
  for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) d[j * DW + i] = depthAt((i + 0.5) / DW, (j + 0.5) / DH);
  return { data: blur(blur(d, DW, DH, 3), DW, DH, 2), w: DW, h: DH, placeholder: true };
}

export async function loadDepth(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const { width: w, height: h } = bmp, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, w, h).data, data = new Float32Array(w * h);
    // canvas rows run top-down; flip so row j is v = (j + 0.5) / h
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = ((h - 1 - y) * w + x) * 4;
      data[y * w + x] = (px[k] * 256 + px[k + 1]) / 65535;
    }
    return { data, w, h, placeholder: false };
  } catch {
    return placeholderDepth();
  }
}

// Bilinear sample at texture uv, matching the GPU's LinearFilter.
export function sampler({ data, w, h }) {
  return (u, v) => {
    const x = Math.min(w - 1.001, Math.max(0, u * w - 0.5)), y = Math.min(h - 1.001, Math.max(0, v * h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
  };
}

// Full precision on the GPU (no 8-bit quantisation, so no terracing in the wireframe).
export function depthTexture(renderer, { data, w, h }) {
  let tex;
  if (renderer.capabilities.isWebGL2 && renderer.getContext().getExtension('OES_texture_float_linear')) {
    tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  } else if (renderer.capabilities.isWebGL2) {
    // half floats filter linearly in core WebGL2; 11 bits of mantissa is still far finer than 8-bit
    tex = new THREE.DataTexture(Uint16Array.from(data, THREE.DataUtils.toHalfFloat), w, h, THREE.RedFormat, THREE.HalfFloatType);
  } else {
    // shortcut: WebGL1 gets 8-bit luminance and may terrace; upgrade only if a target browser lacks WebGL2
    tex = new THREE.DataTexture(Uint8Array.from(data, (d) => Math.round(d * 255)), w, h, THREE.LuminanceFormat, THREE.UnsignedByteType);
  }
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
