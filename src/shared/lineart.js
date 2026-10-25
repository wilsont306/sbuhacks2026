// Whether a picture is line art: ink on blank paper (a sketch, a colouring-book drawing, a photo of either). Depth
// Anything reads such a picture as noise, so the TV (src/host/enrich.js) skips its depth and the phone's diorama
// (src/join/inside.js) its depth room; the diorama also cuts a drawing's objects out of their paper (paperOutside).
// Pure, node:test (tests/lineart.test.js). No ?. or ??: the phone imports it (iOS 13).
const MAX_SAMPLES = 65536; // a grid of at most about this many pixels is read
const PAPER_L = 176;       // near-white: luminance at least this (a photographed page is rarely pure white)...
const PAPER_C = 48;        // ...and channels within this of each other (paper, not a pale colour)
const INK_L = 72;          // darker than this is ink
const MID_L = 152;         // a mid-tone: between ink and this; the pastel washes of a coloured drawing are lighter
const PAPER_MIN = 0.55, MID_MAX = 0.12;
const GAIN_MAX = 1.5;      // white balance: a gain above this on any channel means there is no paper to balance against
const LIFT_INK = 110, LIFT_MIN = 0.01; // the exposure is lifted only for a picture with this share of dark strokes (no pale haze)
const CUT_L = 224, CUT_C = 24; // bare paper for cutting out, stricter: a drawing's pastel washes stay with their object

const readable = (data, w, h) => w >= 1 && h >= 1 && Math.floor(w) === w && Math.floor(h) === h && !!data && data.length >= w * h * 4;

// fn(r, g, b) for each pixel of a grid of at most about MAX_SAMPLES over a readable w by h RGBA picture.
function each(data, w, h, fn) {
  const step = Math.max(1, Math.ceil(Math.sqrt(w * h / MAX_SAMPLES)));
  for (let j = 0; j < h; j += step) {
    for (let i = 0, k = 4 * j * w; i < w; i += step, k += 4 * step) fn(data[k], data[k + 1], data[k + 2]);
  }
}

// Per-channel gains that turn the paper white: the mean colour of the brightest third of the samples (by luminance)
// balanced to grey, then (with ink in it) lifted to white, so cream paper or a warm or dim photo of a page reads as
// white; [1, 1, 1] when either step needs more than GAIN_MAX (a dark or strongly coloured picture has no paper to
// balance against) or the picture is unreadable.
export function paperGains(data, w, h) {
  if (!readable(data, w, h)) return [1, 1, 1];
  const count = new Uint32Array(256), sum = new Float64Array(768);
  let n = 0;
  each(data, w, h, (r, g, b) => {
    const l = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)) || 0;
    count[l]++; sum[3 * l] += r; sum[3 * l + 1] += g; sum[3 * l + 2] += b; n++;
  });
  let m = 0, dark = 0;
  for (let l = 0; l < LIFT_INK; l++) dark += count[l];
  const rgb = [0, 0, 0];
  for (let l = 255; l >= 0 && 3 * m < n; l--) { m += count[l]; rgb[0] += sum[3 * l]; rgb[1] += sum[3 * l + 1]; rgb[2] += sum[3 * l + 2]; }
  // the cast (each channel up to the brightest) and the exposure (that one up to white), each within GAIN_MAX; a
  // picture with no dark strokes (a pale haze, not a dim page) keeps its exposure
  const top = Math.max(rgb[0], rgb[1], rgb[2]), cast = rgb.map((s) => (s > 0 ? top / s : Infinity)), exposure = top > 0 ? 255 * m / top : Infinity;
  const lift = dark >= LIFT_MIN * n ? Math.max(1, exposure) : 1;
  return exposure <= GAIN_MAX && cast.every((g) => g <= GAIN_MAX) ? cast.map((g) => g * lift) : [1, 1, 1];
}

// data: RGBA bytes, rows top first (ImageData.data, or sharp's raw output), w by h pixels. True when, balanced against
// its paper (paperGains), more than PAPER_MIN of the sampled pixels are near-white paper and fewer than MID_MAX are
// mid-tones; false for a painting or a photo of one, and for anything unreadable.
export function isLineArt(data, w, h) {
  if (!readable(data, w, h)) return false;
  const g = paperGains(data, w, h);
  let n = 0, paper = 0, mid = 0;
  each(data, w, h, (r0, g0, b0) => {
    const r = r0 * g[0], gg = g0 * g[1], b = b0 * g[2], l = 0.299 * r + 0.587 * gg + 0.114 * b;
    n++;
    if (l >= PAPER_L && Math.max(r, gg, b) - Math.min(r, gg, b) <= PAPER_C) paper++;
    else if (l >= INK_L && l < MID_L) mid++;
  });
  return paper > PAPER_MIN * n && mid < MID_MAX * n;
}

// The bare paper around a drawn object: 1 for each pixel of a w by h RGBA crop that is paper (after gains, from
// paperGains of the whole picture; stricter than isLineArt's, so washes stay) and joined to the crop's edge through
// paper, side by side; shapes the ink closes stay 0. All 0 when unreadable.
export function paperOutside(data, w, h, gains) {
  const out = new Uint8Array(readable(data, w, h) ? w * h : 0);
  if (!out.length) return out;
  const g = Array.isArray(gains) && gains.length === 3 && gains.every((v) => v > 0 && isFinite(v)) ? gains : [1, 1, 1];
  const paper = (k) => {
    const r = data[4 * k] * g[0], gg = data[4 * k + 1] * g[1], b = data[4 * k + 2] * g[2];
    return 0.299 * r + 0.587 * gg + 0.114 * b >= CUT_L && Math.max(r, gg, b) - Math.min(r, gg, b) <= CUT_C;
  };
  const stack = new Int32Array(w * h);
  let top = 0;
  const visit = (k) => { if (!out[k] && paper(k)) { out[k] = 1; stack[top++] = k; } };
  for (let i = 0; i < w; i++) { visit(i); visit((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { visit(j * w); visit(j * w + w - 1); }
  while (top) {
    const k = stack[--top], i = k % w;
    if (i > 0) visit(k - 1);
    if (i < w - 1) visit(k + 1);
    if (k >= w) visit(k - w);
    if (k + w < w * h) visit(k + w);
  }
  return out;
}
