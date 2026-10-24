// Vercel Function: /api/tripo, a Tripo 3D model (GLB) for one scene object, cached in Blob at tripo/<key>.glb so an
// object is paid for once. The TV picks the cache key (sha1 hex of image, label and mask) and polls; never one long call.
//   POST {key, png}           -> {status:'success', model_url} | {status:'queued', task} | {status:'capped'} | failure
//   GET ?task=<id>&key=<key>  -> one Tripo poll; on success the GLB is copied into Blob -> {status:'success', model_url}
// failure: {status:'failed', reason} | {status:'busy', retry_after} | {status:'no_credits'}; all of those are HTTP 200.
// x-host-token on every call (401; an empty HOST_TOKEN means no check, local only). The visitor's x-tripo-key, else
// TRIPO_API_KEY; with neither 200 {status:'off'}. Each instance starts at most TRIPO_MAX_PER_HOUR (default 6) tasks an
// hour on the team key; a visitor's key skips that cap. A key is never logged or echoed.
import { head as blobHead, put as blobPut, BlobNotFoundError } from '@vercel/blob';
import { readBody } from './interpret.js';
import { tokenMatches, toBuffer } from './sfx.js';
import { client, tripoKey, failure, taskView, TASK_RE, TIMEOUT_MS } from '../lib/tripo.js';

export const MAX_PNG = 3 * 1024 * 1024, MAX_GLB = 25 * 1024 * 1024;
export const MAX_PNG_B64 = Math.ceil(MAX_PNG / 3) * 4, MAX_BODY = MAX_PNG_B64 + 1024; // under Vercel's 4.5 MB body limit
export const TASK_TTL_MS = 15 * 60 * 1000, HOUR_MS = 60 * 60 * 1000, MAX_PER_HOUR = 6, GLB_TIMEOUT_MS = 60000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BLOB_OPTS = { access: 'public', addRandomSuffix: false, allowOverwrite: true };

/* pure */
export const paths = (key) => ({ glb: `tripo/${key}.glb`, task: `tripo/${key}.task.json`, png: `tripo/in/${key}.png` });
export const cacheKey = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : '');

// TRIPO_MAX_PER_HOUR as a whole number >= 0 (0 = cache only); unset or junk means the default.
export function maxPerHour(raw) {
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : MAX_PER_HOUR;
}

// POST body -> {key, png: Buffer} or {error, status}.
export function parsePost(body) {
  const key = cacheKey(body && body.key);
  if (!key) return { error: 'key must be 40 hex characters', status: 400 };
  const b64 = typeof body.png === 'string' ? body.png.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '') : '';
  if (!b64) return { error: 'png required', status: 400 };
  if (b64.length > MAX_PNG_B64) return { error: 'png over 3 MB', status: 413 };
  if (b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'png is not base64', status: 400 };
  const png = Buffer.from(b64, 'base64');
  if (png.length > MAX_PNG) return { error: 'png over 3 MB', status: 413 };
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return { error: 'not a PNG', status: 400 };
  return { key, png };
}
/* end pure */

function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetch = deps.fetch || globalThis.fetch;
  const head = deps.head || blobHead, put = deps.put || blobPut;
  const isNotFound = deps.isNotFound || ((err) => err instanceof BlobNotFoundError);
  const now = deps.now || Date.now;
  const tripoMs = deps.timeoutMs || TIMEOUT_MS, glbMs = deps.glbTimeoutMs || GLB_TIMEOUT_MS;
  const started = []; // start times of this instance's team-paid tasks in the last hour
  const inflight = new Map(); // cache key -> the create a second POST shares instead of paying twice

  const warn = (what, err, apiKey) => {
    let m = String(err && err.message);
    for (const k of [apiKey, String(env.TRIPO_API_KEY || '').trim()]) if (k) m = m.split(k).join('[key]');
    console.warn('tripo:', what, '-', m);
  };

  async function stat(path) {
    try { return await head(path); } catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  // The saved task as {task, fresh}, fresh when its create is under 15 min old, else null. Age from head(), which asks
  // the store itself: the file's text comes through the CDN and can lag an overwrite by its 60 s max-age.
  async function savedTask(path) {
    const h = await stat(path);
    if (!h) return null;
    try {
      const r = await fetch(h.url, { signal: AbortSignal.timeout(tripoMs) });
      const j = r.ok ? await r.json() : null;
      const fresh = now() - new Date(h.uploadedAt).getTime() < TASK_TTL_MS;
      return j && typeof j.task === 'string' && TASK_RE.test(j.task) ? { task: j.task, fresh } : null;
    } catch { return null; }
  }

  // An older task may have finished unseen (the TV stops polling once its scene leaves), so it is asked once before
  // paying again: success is copied, queued or running is shared, and null (a new task) only when it failed (refunded)
  // or Tripo will not show it to this key (a 4xx refusal other than busy or no credits).
  async function resume(key, task, apiKey) {
    let v;
    try { v = taskView(await client(fetch, apiKey, tripoMs).getTask(task)); } catch (err) {
      if (err && err.status >= 400 && err.status < 500 && failure(err).status === 'failed') return null;
      throw err;
    }
    if (v.status === 'failed') return null;
    return v.status === 'success' ? settle(key, v) : { status: 'queued', task };
  }

  // -> the slot's time, or null when the rolling hour is full.
  function takeSlot() {
    const t = now(), cap = maxPerHour(env.TRIPO_MAX_PER_HOUR);
    while (started.length && t - started[0] >= HOUR_MS) started.shift();
    if (started.length >= cap) return null;
    started.push(t);
    return t;
  }

  async function create(p, png, apiKey, team) {
    const tripo = client(fetch, apiKey, tripoMs);
    let url = '';
    // Only the capped team key gets a public Blob copy of the crop; a visitor key (uncapped, format-checked only) uploads
    // straight to Tripo, so this is never a free image host.
    if (team) try { url = (await put(p.png, png, { ...BLOB_OPTS, contentType: 'image/png' })).url; } catch (err) { warn('crop not stored, uploading it instead', err, apiKey); }
    let task;
    try {
      if (!url) throw new Error('no crop URL');
      task = await tripo.createTask(url); // a URL needs no upload (those are limited to about 10 a minute)
    } catch (err) {
      // Only when Tripo refused outright: after a timeout it may have made the task, and busy or broke refuses an upload too.
      if (url && !(err.status && failure(err).status === 'failed')) throw err;
      task = await tripo.createTask(await tripo.uploadPng(png));
    }
    try { await put(p.task, JSON.stringify({ task }), { ...BLOB_OPTS, contentType: 'application/json', cacheControlMaxAge: 60 }); } catch (err) { warn('task not stored', err, apiKey); }
    return { status: 'queued', task };
  }

  async function start(key, png, apiKey, team) {
    const p = paths(key);
    const glb = await stat(p.glb);
    if (glb) return { status: 'success', model_url: glb.url };
    const saved = await savedTask(p.task);
    if (saved && saved.fresh) return { status: 'queued', task: saved.task };
    const old = saved ? await resume(key, saved.task, apiKey) : null;
    if (old) return old;
    let job = inflight.get(key);
    if (!job) {
      const slot = team ? takeSlot() : null;
      if (team && slot === null) return { status: 'capped' };
      job = create(p, png, apiKey, team).catch((err) => {
        // Tripo answered with a refusal, so nothing was charged: give the slot back.
        const i = slot !== null && err && err.status ? started.lastIndexOf(slot) : -1;
        if (i >= 0) started.splice(i, 1);
        throw err;
      });
      inflight.set(key, job);
      job.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return job;
  }

  // The signed model_url lives about a day, so the first poll that sees success copies the GLB.
  async function copyGlb(path, src) {
    const hit = await stat(path); // two polls that both saw success end on one file
    if (hit) return hit.url;
    // No Authorization: the signed URL is its own credential, and the key must never reach the CDN.
    const r = await fetch(src, { signal: AbortSignal.timeout(glbMs) });
    if (!r.ok) throw new Error(`model download HTTP ${r.status}`);
    if (Number(r.headers.get('content-length')) > MAX_GLB) throw new Error('model over 25 MB');
    const buf = await toBuffer(r.body, MAX_GLB).catch(() => { throw new Error('model over 25 MB or empty'); });
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('model is not a GLB');
    return (await put(path, buf, { ...BLOB_OPTS, contentType: 'model/gltf-binary' })).url;
  }

  const settle = async (key, v) => (v.status === 'success' ? { status: 'success', model_url: await copyGlb(paths(key).glb, v.url) } : v);
  const poll = async (key, task, apiKey) => settle(key, taskView(await client(fetch, apiKey, tripoMs).getTask(task)));

  async function safely(what, work, apiKey) {
    try { return await work(); } catch (err) { warn(what, err, apiKey); return failure(err); }
  }

  return async function handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'GET or POST only' }, { allow: 'GET, POST' });
      // Before the key and the body, so a stranger learns nothing and spends nothing.
      const hostToken = env.HOST_TOKEN || '';
      if (hostToken && !tokenMatches(req.headers && req.headers['x-host-token'], hostToken)) return send(res, 401, { error: 'host token' });
      const visitor = tripoKey(req);
      if (visitor === null) return send(res, 400, { error: 'bad key' });
      const apiKey = visitor || String(env.TRIPO_API_KEY || '').trim();
      if (!apiKey) return send(res, 200, { status: 'off' });
      if (req.method === 'GET') {
        const q = new URL(req.url || '/', 'http://localhost').searchParams;
        const key = cacheKey(q.get('key')), task = q.get('task') || '';
        if (!key || !TASK_RE.test(task)) return send(res, 400, { error: 'task and a 40 hex key required' });
        return send(res, 200, await safely(`poll ${key}`, () => poll(key, task, apiKey), apiKey));
      }
      const got = await readBody(req, MAX_BODY);
      if (got.status) return send(res, got.status, { error: got.status === 413 ? 'body too large' : 'invalid JSON body' });
      const reqd = parsePost(got.body);
      if (reqd.error) return send(res, reqd.status, { error: reqd.error });
      return send(res, 200, await safely(`start ${reqd.key}`, () => start(reqd.key, reqd.png, apiKey, !visitor), apiKey));
    } catch (err) {
      console.warn('tripo: handler', err && err.name);
      if (!res.headersSent) send(res, 500, { error: 'tripo failed' });
    }
  };
}

export default createHandler();
