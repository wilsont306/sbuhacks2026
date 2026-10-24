// Vercel Function: POST /api/speak {text} -> {url} of an ElevenLabs narration of one object's description.
// Only the TV calls it, when a phone taps Listen (glue.js, panel 'listen'); the phone then plays the url.
// Cached in Blob at speech/<sha1 of model|voice|text>.mp3, so a description is paid for once across every instance.
// Gated like api/sfx.js: x-host-token when HOST_TOKEN is set (before the body), a visitor's x-elevenlabs-key else
// ELEVENLABS_API_KEY. Past the request checks every answer is 200: {url}, or {url:null, reason} with reason
// 'off' (no key), 'capped' (team key over SPEAK_MAX_PER_HOUR new clips this hour) or 'error'. Keys are never logged.
import { createHash } from 'node:crypto';
import { head as blobHead, put as blobPut, BlobNotFoundError } from '@vercel/blob';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { userKey } from './interpret.js';
import { tokenMatches, toBuffer, HOUR_MS, WARN_EVERY_MS } from './sfx.js';

export const MAX_TEXT = 300, MAX_BODY = 4096, TIMEOUT_MS = 20000, MAX_PER_HOUR = 30;
// George, a Default voice: only accounts made before March 2026 have it, and it expires on 2026-12-31 (ELEVENLABS_VOICE_ID).
export const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
// Flash v2.5: the fast model, at half Multilingual v2's price per character (ELEVENLABS_TTS_MODEL).
export const MODEL_ID = 'eleven_flash_v2_5', OUTPUT_FORMAT = 'mp3_44100_128';

// -> the description as ElevenLabs hears it (whitespace collapsed), or null when it is not 1 to MAX_TEXT characters.
export function parseText(body) {
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return null;
  const text = body.text.replace(/\s+/g, ' ').trim();
  return text && text.length <= MAX_TEXT ? text : null;
}

// SPEAK_MAX_PER_HOUR as a whole number >= 0 (0 = cache only); unset, empty or junk means the default.
export const maxPerHour = (raw) => (/^\s*\d+\s*$/.test(String(raw ?? '')) ? Number(raw) : MAX_PER_HOUR);
export const speechPath = (model, voice, text) => `speech/${createHash('sha1').update(`${model}|${voice}|${text}`).digest('hex')}.mp3`;

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
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const head = deps.head || blobHead, put = deps.put || blobPut;
  const isNotFound = deps.isNotFound || ((err) => err instanceof BlobNotFoundError);
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const now = deps.now || Date.now;
  const started = []; // start times of this instance's new team-key clips in the last hour
  const inflight = new Map(); // path -> the call making it, so two phones on one object pay once
  let lastCapWarn = -Infinity;
  let client = deps.client || null;
  const makeClient = deps.makeClient || ((apiKey) => new ElevenLabsClient({ apiKey, maxRetries: 0, timeoutInSeconds: Math.ceil(timeoutMs / 1000) }));
  const getClient = () => client || (client = makeClient(env.ELEVENLABS_API_KEY));
  let teamVoice = null; // the team account's stand-in voice, once the chosen one turned out to be missing
  const voiceMissing = (err) => !!err && (err.statusCode === 404
    || /voice/i.test(String((err.body && err.body.detail && err.body.detail.status) || '')));

  function takeSlot() {
    const t = now(), cap = maxPerHour(env.SPEAK_MAX_PER_HOUR);
    while (started.length && t - started[0] >= HOUR_MS) started.shift();
    if (started.length < cap) { started.push(t); return true; }
    if (t - lastCapWarn >= WARN_EVERY_MS) { lastCapWarn = t; console.warn(`speak: ${cap} new clips in the last hour (SPEAK_MAX_PER_HOUR); answering capped`); }
    return false;
  }

  async function generate(voice, model, text, path, signal, apiKey) {
    // Retries are off: each one would spend credits again.
    const c = apiKey ? makeClient(apiKey) : getClient(), opts = { abortSignal: signal, maxRetries: 0, timeoutInSeconds: Math.ceil(timeoutMs / 1000) };
    const speak = (v) => c.textToSpeech.convert(v, { text, modelId: model, outputFormat: OUTPUT_FORMAT }, opts);
    let audio;
    try { audio = await speak((!apiKey && teamVoice) || voice); } catch (err) {
      if (!voiceMissing(err)) throw err;
      // The chosen voice is not on this account (Default voices exist only on accounts made before March 2026, and
      // free keys cannot use the Voice Library): take the first voice the account has. Listing voices costs no credits.
      const list = await c.voices.getAll({}, opts), v = list && list.voices && list.voices[0] && list.voices[0].voiceId;
      if (!v) throw err;
      if (!apiKey) teamVoice = v;
      audio = await speak(v);
    }
    const buf = await toBuffer(audio);
    if (!buf.length) throw new Error('empty audio');
    const blob = await put(path, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'audio/mpeg', abortSignal: signal });
    return blob.url;
  }

  // Head, share or generate, all inside one deadline that settles even if a call ignores its abort signal.
  async function lookup(text, apiKey) {
    const voice = String(env.ELEVENLABS_VOICE_ID || '').trim() || VOICE_ID;
    const model = String(env.ELEVENLABS_TTS_MODEL || '').trim() || MODEL_ID;
    const path = speechPath(model, voice, text);
    const ac = new AbortController();
    let timer;
    const deadline = new Promise((_, no) => { timer = setTimeout(() => { ac.abort(); no(new Error(`no speech in ${timeoutMs} ms`)); }, timeoutMs); });
    const work = (async () => {
      try { const hit = (await head(path, { abortSignal: ac.signal })).url; if (hit) return { url: hit }; } catch (err) { if (!isNotFound(err)) throw err; }
      let job = inflight.get(path);
      if (!job) {
        if (!apiKey && !takeSlot()) return { url: null, reason: 'capped' };
        // Raced with the deadline so a hung call still leaves inflight and a later ask can try again.
        job = Promise.race([generate(voice, model, text, path, ac.signal, apiKey), deadline]);
        inflight.set(path, job);
        job.then(() => inflight.delete(path), () => inflight.delete(path));
      }
      return { url: await job };
    })();
    try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); work.catch(() => {}); }
  }

  return async function handler(req, res) {
    let apiKey;
    try {
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { url: null, reason: 'error', error: 'POST only' }); }
      // Before the body, so a stranger learns nothing and spends nothing. Empty HOST_TOKEN = local, no check.
      const hostToken = env.HOST_TOKEN || '';
      if (hostToken && !tokenMatches(req.headers && req.headers['x-host-token'], hostToken)) return send(res, 401, { url: null, reason: 'error', error: 'host token' });
      apiKey = userKey(req, 'x-elevenlabs-key');
      if (apiKey === null) return send(res, 400, { url: null, reason: 'error', error: 'bad key' });
      let text;
      try { text = parseText(await readJson(req)); } catch { text = null; }
      if (!text) return send(res, 400, { url: null, reason: 'error', error: `text must be 1 to ${MAX_TEXT} characters` });
      if (!apiKey && !env.ELEVENLABS_API_KEY) return send(res, 200, { url: null, reason: 'off' });
      return send(res, 200, await lookup(text, apiKey));
    } catch (err) {
      // An ElevenLabsError's message carries the upstream body, so log its status only; never a key.
      let why = err && (err.statusCode || err.body !== undefined) ? `${err.name} ${err.statusCode || ''}` : String(err && err.message).split('\n')[0];
      for (const k of [apiKey, env.ELEVENLABS_API_KEY]) if (k) why = why.split(k).join('[key]');
      console.warn('speak:', why);
      if (!res.headersSent) send(res, 200, { url: null, reason: 'error' });
    }
  };
}

export default createHandler();
