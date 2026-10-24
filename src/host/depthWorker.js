// The Depth Anything V2 Small run for depthAI.js, in a module worker: on wasm one thread runs the whole model, which on
// the TV's main thread would freeze its render loop, phone input and host heartbeat. In: {id, data, w, h}, the picture's
// RGBA pixels (at most 1024 px on the long side). Out: {id, depth (D1), png, info} or {id, error, info}, plus {progress}
// while the model downloads. The weights come from huggingface.co at a pinned revision and the ONNX runtime's wasm from
// jsdelivr, both kept in Cache Storage on https and localhost.
import { pipeline, RawImage } from '@huggingface/transformers';

const MODEL = 'onnx-community/depth-anything-v2-small', REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const OUT_MAX = 512;
const WASM = { device: 'wasm', dtype: 'q8' };

const info = { device: null, dtype: null, loadMs: 0 };
let estP = null;

const fit = (w, h, max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };

// WebGPU with f16 shaders runs the 18 MiB q4f16 weights, anything else the 26 MiB q8 on wasm. transformers.js does not
// check shader-f16 for q4f16 itself, and navigator.gpu is missing outside a secure context.
async function pick() {
  try {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    if (a && a.features.has('shader-f16')) return { device: 'webgpu', dtype: 'q4f16' };
  } catch { /* no adapter: wasm */ }
  return WASM;
}

async function load(opts) {
  const t0 = performance.now();
  const est = await pipeline('depth-estimation', MODEL, {
    ...opts, revision: REVISION,
    progress_callback: (p) => { if (p && p.status === 'progress_total') postMessage({ progress: Math.round(p.progress) }); },
  });
  Object.assign(info, opts, { loadMs: Math.round(performance.now() - t0) });
  postMessage({ progress: 100 });
  return est;
}

// One pipeline per worker (a second would download and hold the model twice). A WebGPU session that fails falls back
// to wasm; a load that fails (offline) is forgotten, so the next picture tries again.
function estimator(wasmOnly) {
  if (estP && !wasmOnly) return estP;
  const p = wasmOnly ? load(WASM) : pick().then((o) => (o === WASM ? load(WASM) : load(o).catch(() => load(WASM))));
  estP = p;
  p.catch(() => { if (estP === p) estP = null; });
  return p;
}

self.onmessage = async (e) => {
  const { id, data, w, h } = e.data || {};
  try {
    const img = new RawImage(data, w, h, 4);
    let est = await estimator(), out;
    try { out = await est(img); } catch (err) {
      if (info.device !== 'webgpu') throw err;
      // shortcut: q4f16 on WebGPU is unverified for this model; an op it cannot run gets one more try on wasm
      Promise.resolve(est.dispose()).catch(() => {});
      est = await estimator(true); out = await est(img);
    }
    const small = await out.depth.resize(...fit(out.depth.width, out.depth.height, OUT_MAX)); // 1 channel, as the model gave it
    const png = await small.toBlob('image/png'), depth = Uint8Array.from(small.data);
    postMessage({ id, depth: { data: depth, w: small.width, h: small.height }, png, info }, [depth.buffer]);
  } catch (err) {
    postMessage({ id, error: String((err && err.message) || err), info });
  }
};
