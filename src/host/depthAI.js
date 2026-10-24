// Depth Anything V2 Small (Apache-2.0) in the TV's own browser, through transformers.js: a picture in, the depth image
// out (D1: one byte per pixel, rows top first, 255 nearest, min-max normalised, at most 512 px on the long side) plus
// its PNG. A lazy chunk: import it only with await import('./depthAI.js'). The model runs in a module worker
// (depthWorker.js, started on the first estimate, which also fetches the library), so the TV keeps rendering and
// answering phones meanwhile. Never throws: any failure is null.
const IN_MAX = 1024; // the output comes back at the input's size, so the input is downscaled first

const info = { device: null, dtype: null, progress: 0, loadMs: 0, runMs: 0 };
const waiting = new Map(); // request id -> [resolve, reject]
let worker = null, seq = 0;

// -> {device, dtype, progress (0..100 of the download), loadMs, runMs} for the HUD.
export const stats = () => ({ ...info });

const fit = (w, h, max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };

function spawn() {
  if (worker) return worker;
  const w = new Worker(new URL('./depthWorker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const m = e.data || {};
    if (typeof m.progress === 'number') info.progress = m.progress;
    if (m.info) Object.assign(info, m.info);
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.error) p[1](new Error(m.error)); else p[0](m);
  };
  // A worker that will not start or that died fails whatever waits; the next picture starts a fresh one.
  w.onerror = (e) => {
    if (worker === w) worker = null;
    w.terminate();
    for (const p of waiting.values()) p[1](new Error((e && e.message) || 'depth worker failed'));
    waiting.clear();
  };
  return (worker = w);
}

// image: a loaded <img> (crossOrigin 'anonymous' when it is not same-origin), an ImageBitmap or a canvas.
// -> {depth: {data, w, h}, png: Blob, ms} or null.
export async function estimateDepth(image) {
  try {
    const t0 = performance.now(), c = document.createElement('canvas');
    [c.width, c.height] = fit(image.naturalWidth || image.width, image.naturalHeight || image.height, IN_MAX);
    const g = c.getContext('2d');
    g.drawImage(image, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height); // a tainted canvas throws here, before the model is fetched
    const w = spawn(), id = ++seq;
    const r = await new Promise((ok, no) => {
      waiting.set(id, [ok, no]);
      w.postMessage({ id, data: px.data, w: px.width, h: px.height }, [px.data.buffer]);
    });
    info.runMs = Math.round(performance.now() - t0);
    return { depth: r.depth, png: r.png, ms: info.runMs };
  } catch (err) {
    console.warn('depthAI:', err && err.message);
    return null;
  }
}
