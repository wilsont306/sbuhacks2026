// Vercel Function: POST /api/interpret {image: base64 JPEG, PNG or WebP, source: 'drop'|'phone', name?, credit?} -> the
// artwork saved to Blob as art/<id>.<ext> (jpg, png or webp, from its first bytes), read by Gemini, validated to the
// scene contract, saved as scenes/<id>.json, then queued for Snowflake with waitUntil. Always JSON, and HTTP 200 for
// every outcome past the request checks: {ok:true, id, image_url, scene_url, scene} or {ok:false, reason, id,
// image_url (when saved), scene (or null)}; a returned scene's scene_url is '' whenever the scene file was not stored.
// Two guards for a public URL run before any of that, per instance: a second request from one client IP inside
// INTERPRET_MIN_GAP_MS (default 8000) gets {ok:false, reason:'busy', scene:null}, and one past INTERPRET_MAX_PER_HOUR
// (default 30) requests let through in the last hour gets {ok:false, reason:'quota', scene:null}. Neither has an id:
// nothing is stored and Gemini is not called.
// Bring your own key: a valid x-gemini-key header (KEY_RE) is used instead of GEMINI_API_KEY, with x-gemini-model when
// it is in GEMINI_MODELS; such a request skips the hourly cap (its own quota) but not the per-client gap. A malformed
// one gets {ok:false, reason:'bad_key', scene:null} with no Gemini call. The key is never logged or kept.
import { randomUUID } from 'node:crypto';
import { put as blobPut } from '@vercel/blob';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { readArtwork as geminiReadArtwork } from '../lib/gemini.js';
import { validateScene } from '../src/shared/scene-validate.js';

export const MAX_BODY = 1.5 * 1024 * 1024;
// base64 of the largest image that fits in MAX_BODY, minus a little for the other fields.
export const MAX_IMAGE_B64 = MAX_BODY - 2048;
export const BUDGET_MS = 25000;
// Kept back from Gemini's share of the budget for the scene put and the reply.
const SCENE_RESERVE_MS = 3000;
const BODY_READ_MS = 10000;
const SOURCES = ['drop', 'phone'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Defaults for INTERPRET_MAX_PER_HOUR and INTERPRET_MIN_GAP_MS; a value that is not a whole number falls back to them.
export const MAX_PER_HOUR = 30;
export const MIN_GAP_MS = 8000;
const HOUR_MS = 60 * 60 * 1000;
export const KEY_RE = /^[A-Za-z0-9_.-]{20,200}$/;
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

// A bring-your-own-key header (also read by api/sfx.js and api/check.js): undefined when absent or blank, null when
// malformed (a repeated header included), else the trimmed key.
export function userKey(req, name) {
  const raw = req.headers?.[name];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return undefined;
  const s = typeof raw === 'string' ? raw.trim() : '';
  return KEY_RE.test(s) ? s : null;
}

// A new client for a visitor's key on each request, so it never outlives the request (lib/gemini.js caches its own).
async function freshGeminiClient(apiKey) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const envInt = (v, fallback) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : fallback);
// eslint-disable-next-line no-control-regex
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const short = (err) => String(err?.message ?? err ?? '').slice(0, 200);

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function readStream(req, cap, ms) {
  return new Promise((resolve) => {
    const parts = [];
    let n = 0, settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      resolve(v);
    };
    const onData = (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      n += b.length;
      if (n > cap) { finish({ status: 413 }); req.resume?.(); return; }
      parts.push(b);
    };
    const onEnd = () => finish({ buf: Buffer.concat(parts) });
    const onError = () => finish({ status: 400 });
    const timer = setTimeout(() => finish({ status: 400 }), ms);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  });
}

// Vercel's Node helpers buffer the body before the handler runs and expose req.body (JSON parsed lazily, throwing on
// bad JSON); a bare node:http server leaves the stream unread. Both, capped. -> {body} or {status: 400 | 413}.
export async function readBody(req, cap = MAX_BODY, ms = BODY_READ_MS) {
  if (Number(req.headers?.['content-length']) > cap) return { status: 413 };
  let body;
  try { body = req.body; } catch { return { status: 400 }; }
  if (body === undefined || body === null) {
    if (req.readableEnded || typeof req.on !== 'function') return { status: 400 };
    const got = await readStream(req, cap, ms);
    if (got.status) return got;
    body = got.buf;
  }
  if (body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > cap) return { status: 413 };
    try { body = JSON.parse(body); } catch { return { status: 400 }; }
  }
  return isObj(body) ? { body } : { status: 400 };
}

export function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// -> {base64, bytes, mime, ext, source, name, credit} or {error, status}.
export function parseRequest(body) {
  if (!isObj(body)) return { error: 'bad_body', status: 400 };
  // A data: prefix and line breaks are tolerated even though the pages send neither.
  const image = typeof body.image === 'string' ? body.image.replace(/^data:[^,]{0,100};base64,/, '').replace(/\s+/g, '') : '';
  if (!image) return { error: 'no_image', status: 400 };
  if (image.length > MAX_IMAGE_B64) return { error: 'too_large', status: 413 };
  if (image.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return { error: 'bad_image', status: 400 };
  const bytes = Buffer.from(image, 'base64');
  const type = bytes.length >= 100 ? sniff(bytes) : null;
  if (!type) return { error: 'not_image', status: 400 };
  return {
    base64: image, bytes, ...type,
    source: SOURCES.includes(body.source) ? body.source : 'drop',
    name: clean(body.name, 80),
    credit: clean(body.credit, 300) || null,
  };
}

// The scene's public URL next to the image's: same store host, a different pathname.
export function siblingUrl(url, from, to) {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith('/' + from)) return '';
    u.pathname = u.pathname.slice(0, -from.length) + to;
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

// The caller: the first x-forwarded-for entry (Vercel sets it), else the socket's address, else '' (unknown).
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  const first = String((Array.isArray(xff) ? xff[0] : xff) ?? '').split(',')[0].trim();
  return first || String(req.socket?.remoteAddress ?? '');
}

async function lazySaveProject(row) {
  // Imported on use, so a missing or broken Snowflake module can only lose the save, never the interpret.
  const { saveProject } = await import('../lib/snowflake.js');
  return saveProject(row);
}

export function createHandler(deps = {}) {
  const {
    readArtwork = geminiReadArtwork,
    geminiClient = freshGeminiClient,
    put = blobPut,
    saveProject = lazySaveProject,
    waitUntil = vercelWaitUntil,
    newId = randomUUID,
    now = Date.now,
    budgetMs = BUDGET_MS,
    maskFrame = 'box',
    log = console.warn,
    env = process.env,
  } = deps;

  // 0 is taken literally: MAX_PER_HOUR=0 refuses every request, MIN_GAP_MS=0 turns the per-IP gap off.
  const maxPerHour = envInt(env?.INTERPRET_MAX_PER_HOUR, MAX_PER_HOUR);
  const minGapMs = envInt(env?.INTERPRET_MIN_GAP_MS, MIN_GAP_MS);
  // This instance's memory only: when each request let through to Gemini was admitted, and each IP's latest one.
  let admitted = [];
  const lastByIp = new Map();

  // -> null (let through and counted) or the refusal: 'busy' or 'quota'. Only admitted requests start a gap or count,
  // so a phone retrying while refused gets in once the gap since its last admitted request is over. capped is false
  // for a visitor's own key: the gap still applies, the hourly cap neither refuses nor counts it.
  function admit(ip, t, capped) {
    if (minGapMs > 0 && ip) {
      for (const [k, at] of lastByIp) if (t - at >= minGapMs) lastByIp.delete(k);
      if (lastByIp.has(ip)) return 'busy';
    }
    if (capped) {
      admitted = admitted.filter((at) => t - at < HOUR_MS);
      if (admitted.length >= maxPerHour) return 'quota';
      admitted.push(t);
    }
    if (minGapMs > 0 && ip) lastByIp.set(ip, t);
    return null;
  }

  // Settled within ms even if the Blob client ignores the abort, like the Gemini call.
  const putWithin = (path, body, contentType, ms) => {
    const abortSignal = AbortSignal.timeout(Math.max(1, ms));
    const cut = new Promise((_, no) => abortSignal.addEventListener('abort', () => no(abortSignal.reason), { once: true }));
    return Promise.race([Promise.resolve().then(() => put(path, body, { access: 'public', addRandomSuffix: false, contentType, abortSignal })), cut]);
  };

  const failed = (state, reason, scene = null) => ({
    ok: false, reason, id: state.id, ...(state.image_url ? { image_url: state.image_url } : {}), scene,
  });

  function saveLater(row) {
    try {
      const job = Promise.resolve().then(() => saveProject(row)).catch((err) => log(`interpret ${row.id}: snowflake save failed: ${short(err)}`));
      waitUntil(job);
    } catch (err) {
      log(`interpret ${row.id}: waitUntil failed: ${short(err)}`);
    }
  }

  // byok: null, or {apiKey, model?} from the visitor's headers.
  async function run(reqd, state, deadline, byok) {
    const { id } = state;
    const art = `art/${id}.${reqd.ext}`;
    // The image upload and the Gemini read run side by side; neither waits for the other. Both stop SCENE_RESERVE_MS
    // early, so a hung upload ends in the storage reply (with the scene) rather than the overall timeout.
    const upload = () => putWithin(art, reqd.bytes, reqd.mime, deadline - SCENE_RESERVE_MS - now()).then((r) => { state.image_url = typeof r?.url === 'string' && r.url ? r.url : null; });
    const readIt = () => Promise.resolve().then(async () => readArtwork({
      base64: reqd.base64, mimeType: reqd.mime, deadline: deadline - SCENE_RESERVE_MS,
      // apiKey goes along with the client so lib/gemini.js scrubs it from its log lines.
      ...(byok && { ...byok, client: await geminiClient(byok.apiKey) }),
    }));
    const settle = (p) => p.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    let img, read;
    if (byok) {
      // A visitor's key skips the hourly cap, so their picture is stored only after Gemini read it: no free image host.
      read = await settle(readIt());
      img = read.status === 'fulfilled' ? await settle(upload()) : { status: 'fulfilled' };
    } else [img, read] = await Promise.allSettled([upload(), readIt()]);
    if (img.status === 'rejected') log(`interpret ${id}: image not saved: ${short(img.reason)}`);
    if (read.status === 'rejected') return failed(state, typeof read.reason?.reason === 'string' ? read.reason.reason : 'gemini');
    const { raw, model } = read.value || {};
    const scenePath = `scenes/${id}.json`;
    const scene = validateScene(raw, {
      id, source: reqd.source, edited: false, credit: reqd.credit,
      image_url: state.image_url || '', scene_url: state.image_url ? siblingUrl(state.image_url, art, scenePath) : '',
      model: typeof model === 'string' ? model : 'unknown', generated_at: new Date(now()).toISOString(),
    }, { maskFrame });
    if (!state.image_url) return failed(state, 'storage', scene);
    if (state.expired) return failed(state, 'timeout');
    try {
      const r = await putWithin(scenePath, JSON.stringify(scene), 'application/json', deadline - now());
      if (typeof r?.url === 'string' && r.url && r.url !== scene.scene_url) {
        log(`interpret ${id}: scene stored at ${r.url}, not the derived ${scene.scene_url || '(none)'}`);
        scene.scene_url = r.url;
      }
    } catch (err) {
      log(`interpret ${id}: scene not saved: ${short(err)}`);
      scene.scene_url = '';
      return failed(state, 'storage', scene);
    }
    if (state.expired) return failed(state, 'timeout');
    saveLater({
      id, name: reqd.name || (scene.title_guess !== 'unknown' ? scene.title_guess : 'Untitled'), source: scene.source,
      image_url: scene.image_url, scene_url: scene.scene_url, scene,
      title_guess: scene.title_guess, artist_guess: scene.artist_guess, credit: scene.credit,
    });
    return { ok: true, id, image_url: scene.image_url, scene_url: scene.scene_url, scene };
  }

  return async function handler(req, res) {
    const t0 = now();
    const state = { id: null, image_url: null, expired: false };
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method' }, { Allow: 'POST' });
      const got = await readBody(req);
      if (got.status) return send(res, got.status, { ok: false, reason: got.status === 413 ? 'too_large' : 'bad_body' });
      const reqd = parseRequest(got.body);
      if (reqd.error) return send(res, reqd.status, { ok: false, reason: reqd.error });
      const key = userKey(req, 'x-gemini-key');
      if (key === null) {
        log('interpret: bad_key, a malformed x-gemini-key header');
        return send(res, 200, { ok: false, reason: 'bad_key', scene: null });
      }
      const wanted = String(req.headers?.['x-gemini-model'] ?? '').trim();
      const byok = key ? { apiKey: key, ...(GEMINI_MODELS.includes(wanted) && { model: wanted }) } : null;
      const refused = admit(clientIp(req), now(), !key);
      if (refused) {
        log(`interpret: ${refused === 'busy' ? `busy, same client inside ${minGapMs} ms` : `quota, this instance's cap of ${maxPerHour} an hour reached`}`);
        return send(res, 200, { ok: false, reason: refused, scene: null });
      }
      state.id = String(newId());
      const deadline = t0 + budgetMs;
      let timer;
      const overtime = new Promise((resolve) => {
        timer = setTimeout(() => { state.expired = true; resolve(failed(state, 'timeout')); }, Math.max(0, deadline - now()));
      });
      const work = run(reqd, state, deadline, byok).catch((err) => {
        log(`interpret ${state.id}: ${short(err)}`);
        return failed(state, 'internal');
      });
      const out = await Promise.race([work, overtime]);
      clearTimeout(timer);
      if (!out.ok) log(`interpret ${state.id}: ${out.reason} after ${now() - t0} ms`);
      return send(res, 200, out);
    } catch (err) {
      log(`interpret ${state.id || '-'}: handler: ${short(err)}`);
      return send(res, 200, failed(state, 'internal'));
    }
  };
}

export default createHandler();
