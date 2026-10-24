// Tripo v3 image-to-model over plain fetch, for api/tripo.js and api/check.js. No SDK: it is not on npm, and the one
// Tripo's docs lock to sends its key on model downloads. Tripo answers browsers with no CORS headers and its docs forbid
// browser-side keys, so only our functions call it. Never puts a key or an upstream body in an error message.
import { cleanTripoKey } from '../src/shared/byok.js';

export const TRIPO_BASE = 'https://openapi.tripo3d.ai/v3'; // the global site; openapi.tripo3d.com is China's
export const TIMEOUT_MS = 20000;
// About 30 credits an object. Never quad (FBX, which GLTFLoader cannot read) and never compress (needs a meshopt decoder).
// model is sent explicitly: Tripo's migration notes say leaving it out is a 400 (1004).
export const TASK_OPTIONS = { model: 'v3.1-20260211', texture: true, pbr: false, texture_quality: 'standard', face_limit: 20000 };
// Task ids are opaque (the docs show task_…, real ones are bare UUIDs); this only keeps them path- and log-safe.
export const TASK_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FAILED = ['failed', 'cancelled', 'banned', 'expired'];

/* pure */
// x-tripo-key: undefined when absent or blank, null when malformed (a repeated header included), else the trimmed key.
export function tripoKey(req) {
  const raw = req.headers?.['x-tripo-key'];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return undefined;
  return cleanTripoKey(raw) || null;
}

// Retry-After in whole seconds; missing or an HTTP date means 5.
export function retryAfter(v) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 5;
}

// A thrown call -> the reply the TV reads. 429 is a rate limit (1007) or the account's 10-task concurrency (2000).
export function failure(err) {
  const e = err || {};
  if (e.status === 429 || e.code === 1007 || e.code === 2000) return { status: 'busy', retry_after: retryAfter(e.retryAfter) };
  if (e.code === 2010) return { status: 'no_credits' };
  const reason = e.code ? `tripo code ${e.code}` : e.status ? `tripo HTTP ${e.status}` : e.name === 'TimeoutError' ? 'timeout' : 'error';
  return { status: 'failed', reason };
}

// One task as Tripo returns it -> {status:'queued'|'running', progress} | {status:'success', url} | {status:'failed', reason}.
// Banned and expired are listed for v2; v3 reports them as failed with 2008 and 2018. Anything unknown is a failure.
export function taskView(t) {
  const s = t && typeof t.status === 'string' ? t.status : '';
  if (s === 'queued' || s === 'running') return { status: s, progress: Math.max(0, Math.min(100, Math.round(Number(t.progress) || 0))) };
  const url = t && t.output && t.output.model_url;
  if (s === 'success') return typeof url === 'string' && /^https:\/\//.test(url) ? { status: 'success', url } : { status: 'failed', reason: 'no model' };
  const code = t && Number.isInteger(t.error_code) ? ` ${t.error_code}` : '';
  return { status: 'failed', reason: (FAILED.includes(s) ? s : 'unknown') + code };
}
/* end pure */

// -> {createTask(input), uploadPng(buf), getTask(id)} for one key. Each throws an Error carrying {status, code, retryAfter}
// when Tripo answers anything but HTTP 2xx with code 0.
export function client(fetch, apiKey, ms = TIMEOUT_MS) {
  async function call(path, init = {}) {
    const r = await fetch(TRIPO_BASE + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(ms) });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON: the status says enough */ }
    const code = j && typeof j === 'object' ? j.code : undefined;
    if (!r.ok || code !== 0) {
      throw Object.assign(new Error(`tripo HTTP ${r.status}, code ${code}`), { status: r.status, code, retryAfter: r.headers?.get?.('retry-after') ?? null });
    }
    return j.data && typeof j.data === 'object' ? j.data : {};
  }
  const need = (v, what) => { if (typeof v !== 'string' || !v) throw new Error(`tripo gave no ${what}`); return v; };
  return {
    // input: a public image URL or a file token, as a plain string.
    createTask: async (input) => {
      const id = need((await call('/generation/image-to-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, ...TASK_OPTIONS }) })).task_id, 'task id');
      if (!TASK_RE.test(id)) throw new Error('tripo gave an odd task id');
      return id;
    },
    // Multipart; fetch sets the boundary. Tripo refuses base64 and data: URLs.
    uploadPng: async (buf) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'image/png' }), 'cutout.png');
      return need((await call('/files', { method: 'POST', body: fd })).file_token, 'file token');
    },
    getTask: (id) => call(`/tasks/${encodeURIComponent(id)}`),
  };
}
