// Vercel Function: POST /api/sfx {label, prompt} -> {url} of a short ElevenLabs sound effect for one scene object.
// Cached in Blob at sfx/<sha1 of the lowercased label>.mp3, so a label is paid for once across every instance.
// 204 while SOUND_GEN is not 'on'; any failure answers 200 {url:null} so the host keeps its palette default.
// Only the host tab calls this, and every new label spends credits on a public URL: with HOST_TOKEN set the
// request must carry it in x-host-token (else 401), and each instance starts at most SFX_MAX_PER_HOUR new sounds.
// Bring your own key: after the token check, a valid x-elevenlabs-key header generates with that key even when
// SOUND_GEN is not 'on' and skips SFX_MAX_PER_HOUR; a malformed one is 400 {url:null, error:'bad key'}. Never logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import { head as blobHead, put as blobPut, BlobNotFoundError } from '@vercel/blob';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { userKey } from './interpret.js';

export const MAX_LABEL = 40, MAX_PROMPT = 200, MAX_BODY = 4096, MAX_AUDIO = 2 * 1024 * 1024;
export const TIMEOUT_MS = 20000;
export const MAX_PER_HOUR = 20, HOUR_MS = 60 * 60 * 1000, WARN_EVERY_MS = 60 * 1000;
// 3 s at the documented 40 credits a second when duration is set (auto duration is billed flat at 200).
export const SFX_PARAMS = { durationSeconds: 3, promptInfluence: 0.5, modelId: 'eleven_text_to_sound_v2', outputFormat: 'mp3_44100_128' };

const clean = (s) => s.replace(/\s+/g, ' ').trim();

// -> {label, text, key} or {error}. text is what ElevenLabs hears; key names the cached file.
export function parseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const { label = '', prompt = '' } = body;
  if (typeof label !== 'string' || typeof prompt !== 'string') return { error: 'label and prompt must be strings' };
  const l = clean(label), p = clean(prompt);
  if (l.length > MAX_LABEL) return { error: `label over ${MAX_LABEL} characters` };
  if (p.length > MAX_PROMPT) return { error: `prompt over ${MAX_PROMPT} characters` };
  const text = p || l;
  if (!text) return { error: 'prompt or label required' };
  return { label: l, text, key: sfxKey(l || p) };
}

// Constant-time compare; timingSafeEqual needs equal lengths, so a length mismatch is a plain no.
export function tokenMatches(got, want) {
  if (typeof got !== 'string' || typeof want !== 'string') return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// SFX_MAX_PER_HOUR as a whole number >= 0 (0 = cache only); unset, empty or junk means the default.
export function maxPerHour(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return MAX_PER_HOUR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : MAX_PER_HOUR;
}

export const sfxKey = (s) => createHash('sha1').update(clean(s).toLowerCase()).digest('hex');
export const blobPath = (key) => `sfx/${key}.mp3`;

// The SDK hands back a web ReadableStream; accept any byte source so tests and the CLI can share this.
export async function toBuffer(src, max = MAX_AUDIO) {
  if (!src) throw new Error('no audio');
  const parts = [];
  let n = 0;
  const add = (chunk) => { const b = Buffer.from(chunk); n += b.length; if (n > max) throw new Error('audio too large'); parts.push(b); };
  if (src instanceof Uint8Array || src instanceof ArrayBuffer) add(src);
  else if (typeof src.getReader === 'function') {
    const reader = src.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; add(value); }
  } else if (typeof src[Symbol.asyncIterator] === 'function') {
    for await (const chunk of src) add(chunk);
  } else if (typeof src.arrayBuffer === 'function') add(await src.arrayBuffer());
  else throw new Error('unknown audio type');
  return Buffer.concat(parts);
}

async function readJson(req) {
  // Vercel's Node helpers pre-parse req.body (and throw on bad JSON); plain node:http leaves the stream to us.
  let body = req.body;
  if (body === undefined) {
    const parts = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new Error('body too large'); parts.push(c); }
    body = Buffer.concat(parts).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') return body.trim() ? JSON.parse(body) : {};
  return body;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  if (obj === undefined) return res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

// One ElevenLabs call at a time per instance. The job settles when its signal aborts even if the call ignores
// the signal, so a hung request never blocks the queue past its own deadline.
let chain = Promise.resolve();
const inflight = new Map();
function serial(job, signal) {
  const run = chain.then(() => new Promise((ok, no) => {
    if (signal.aborted) return no(new Error('gave up while queued'));
    const stop = () => no(new Error('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    job().then(ok, no).finally(() => signal.removeEventListener('abort', stop));
  }));
  chain = run.catch(() => {});
  return run;
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const head = deps.head || blobHead, put = deps.put || blobPut;
  const isNotFound = deps.isNotFound || ((err) => err instanceof BlobNotFoundError);
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const now = deps.now || Date.now;
  // Start times of this instance's new generations in the last hour; cache hits and shared in-flight calls are free.
  const started = [];
  let lastCapWarn = -Infinity;
  let client = deps.client || null;
  const makeClient = deps.makeClient || ((apiKey) => new ElevenLabsClient({ apiKey, maxRetries: 0, timeoutInSeconds: Math.ceil(timeoutMs / 1000) }));
  const getClient = () => client || (client = makeClient(env.ELEVENLABS_API_KEY));

  async function cachedUrl(path, signal) {
    try { return (await head(path, { abortSignal: signal })).url || null; } catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  // apiKey: the visitor's own key, given a client of its own that is dropped after the call; else the team's.
  async function generate({ text, key }, signal, apiKey) {
    // Retries are off: each one would spend credits again.
    const audio = await (apiKey ? makeClient(apiKey) : getClient()).textToSoundEffects.convert({ text, ...SFX_PARAMS }, { abortSignal: signal, maxRetries: 0, timeoutInSeconds: Math.ceil(timeoutMs / 1000) });
    const buf = await toBuffer(audio);
    if (!buf.length) throw new Error('empty audio');
    // allowOverwrite: two instances that raced on one label both end up with the same URL instead of one error.
    const blob = await put(blobPath(key), buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'audio/mpeg', abortSignal: signal });
    return blob.url;
  }

  // true when one more new generation fits the rolling hour (and records it); checked and recorded in one tick.
  function takeSlot() {
    const t = now(), cap = maxPerHour(env.SFX_MAX_PER_HOUR);
    while (started.length && t - started[0] >= HOUR_MS) started.shift();
    if (started.length < cap) { started.push(t); return true; }
    if (t - lastCapWarn >= WARN_EVERY_MS) {
      lastCapWarn = t;
      console.warn(`sfx: ${cap} new sounds in the last hour (SFX_MAX_PER_HOUR); answering {url:null} until one ages out`);
    }
    return false;
  }

  async function lookup(reqd, apiKey) {
    const ac = new AbortController();
    let timer;
    const deadline = new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Error(`no sound in ${timeoutMs} ms`)); }, timeoutMs); });
    const work = (async () => {
      const path = blobPath(reqd.key);
      const hit = await cachedUrl(path, ac.signal);
      if (hit) return { url: hit, cached: true };
      if (!apiKey && !env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
      let job = inflight.get(reqd.key);
      if (!job) {
        if (!apiKey && !takeSlot()) return { url: null };
        job = serial(() => generate(reqd, ac.signal, apiKey), ac.signal);
        inflight.set(reqd.key, job);
        job.then(() => inflight.delete(reqd.key), () => inflight.delete(reqd.key));
      }
      return { url: await job, cached: false };
    })();
    try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); work.catch(() => {}); }
  }

  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'POST only' }); }
      // Before the body and SOUND_GEN, so a stranger learns nothing and spends nothing. Empty HOST_TOKEN = local, no check.
      const hostToken = env.HOST_TOKEN || '';
      if (hostToken && !tokenMatches(req.headers && req.headers['x-host-token'], hostToken)) return send(res, 401, { url: null, error: 'host token' });
      const apiKey = userKey(req, 'x-elevenlabs-key');
      if (apiKey === null) return send(res, 400, { url: null, error: 'bad key' });
      if (env.SOUND_GEN !== 'on' && !apiKey) return send(res, 204);
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { url: null, error: 'invalid JSON body' }); }
      const reqd = parseRequest(body);
      if (reqd.error) return send(res, 400, { url: null, error: reqd.error });
      try { return send(res, 200, await lookup(reqd, apiKey)); } catch (err) {
        const msg = String(err && err.message);
        console.warn('sfx:', reqd.label || reqd.text, '-', apiKey ? msg.split(apiKey).join('[key]') : msg);
        return send(res, 200, { url: null });
      }
    } catch (err) {
      console.warn('sfx: handler', err && err.message);
      if (!res.headersSent) send(res, 200, { url: null });
    }
  };
}

export default createHandler();
