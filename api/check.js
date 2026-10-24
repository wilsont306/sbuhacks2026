// Vercel Function: POST /api/check {service: 'gemini'|'elevenlabs'|'tripo'|'snowflake'|'storage'} -> 200 {ok, using,
// detail, credits?}, the TV's "test this key" button. gemini, elevenlabs and tripo test the visitor's own key from
// x-gemini-key / x-elevenlabs-key / x-tripo-key (using:'yours'), else the team's env key (using:'team'), else answer
// using:'none'; none costs generation quota (Gemini lists models, ElevenLabs reads the subscription, or its models list
// for a key not allowed to read it, and then credits is null; Tripo reads the balance). snowflake and storage are the
// team's only. Each upstream call is cut at 8 s, each client gets 10 checks a minute (429), anything but POST is 405, an
// unknown service 400. detail is short, fixed text safe to show on the TV: no key and no upstream body ever comes back
// or reaches the log.
import { readBody, clientIp, userKey } from './interpret.js';
import { tokenMatches } from './sfx.js';
import { TRIPO_BASE, tripoKey } from '../lib/tripo.js';

export const TIMEOUT_MS = 8000, MAX_PER_MINUTE = 10, MINUTE_MS = 60 * 1000;
export const SERVICES = ['gemini', 'elevenlabs', 'tripo', 'snowflake', 'storage'];
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
const ELEVEN_URL = 'https://api.elevenlabs.io/v1';
const TIMED_OUT = { status: 0, why: 'timeout' };

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function createHandler(deps = {}) {
  const {
    env = process.env,
    fetch = globalThis.fetch,
    now = Date.now,
    timeoutMs = TIMEOUT_MS,
    // Imported on use, like api/interpret.js, so a broken Snowflake module only fails its own check.
    snowflake = () => import('../lib/snowflake.js'),
  } = deps;
  const recent = new Map(); // client -> times of its checks in the last minute

  function allow(ip, t) {
    for (const [k, times] of recent) {
      const kept = times.filter((at) => t - at < MINUTE_MS);
      if (kept.length) recent.set(k, kept); else recent.delete(k);
    }
    const times = recent.get(ip) || [];
    if (times.length >= MAX_PER_MINUTE) return false;
    recent.set(ip, [...times, t]);
    return true;
  }

  // Settles within ms (default timeoutMs) even when the work ignores its abort signal.
  function within(work, ac, ms = timeoutMs) {
    let timer;
    const cut = new Promise((ok) => { timer = setTimeout(() => { ac?.abort(); ok(TIMED_OUT); }, ms); });
    return Promise.race([work, cut]).finally(() => clearTimeout(timer));
  }

  // -> {status, json} for any HTTP answer, else {status: 0, why: 'timeout' | 'network'}.
  function get(url, headers, ms) {
    const ac = new AbortController();
    const work = Promise.resolve().then(async () => {
      const r = await fetch(url, { headers, signal: ac.signal });
      let json = null;
      try { json = await r.json(); } catch { /* no JSON body; the status says enough */ }
      return { status: r.status, json };
    }).catch(() => ({ status: 0, why: 'network' }));
    return within(work, ac, ms);
  }

  function trouble(name, r) {
    if (!r.status) return r.why === 'timeout' ? `${name} did not answer in ${Math.ceil(timeoutMs / 1000)} s` : `Could not reach ${name}`;
    if ([400, 401, 403].includes(r.status)) return `${name} refused the key`;
    if (r.status === 429) return `${name} says the key is over its limit`;
    return `${name} answered HTTP ${r.status}`;
  }

  async function gemini(key) {
    const r = await get(GEMINI_URL, { 'x-goog-api-key': key });
    return r.status === 200 ? { ok: true, detail: 'Gemini accepted the key' } : { ok: false, detail: trouble('Gemini', r) };
  }

  async function elevenlabs(key) {
    const h = { 'xi-api-key': key }, start = now();
    const r = await get(`${ELEVEN_URL}/user/subscription`, h);
    if (r.status === 200) {
      const limit = r.json?.character_limit, used = r.json?.character_count;
      const credits = Number.isFinite(limit) && Number.isFinite(used) ? Math.max(0, limit - used) : null;
      return { ok: true, credits, detail: credits === null ? 'ElevenLabs accepted the key' : `ElevenLabs accepted the key; ${credits} credits left` };
    }
    if (r.status !== 401) return { ok: false, credits: null, detail: trouble('ElevenLabs', r) };
    // A key scoped without user_read is refused here yet may still make sounds; a list it can read tells them apart.
    // One 8 s budget for both calls, so the check never outlives the function or the TV's wait.
    const left = timeoutMs - (now() - start);
    if (left < timeoutMs / 8) return { ok: false, credits: null, detail: trouble('ElevenLabs', r) }; // under ~1 s left: report the 401
    const m = await get(`${ELEVEN_URL}/models`, h, left);
    return m.status === 200
      ? { ok: true, credits: null, detail: 'ElevenLabs accepted the key (it may not read its credits)' }
      : { ok: false, credits: null, detail: trouble('ElevenLabs', m) };
  }

  async function tripo(key) {
    const r = await get(`${TRIPO_BASE}/account/balance`, { Authorization: `Bearer ${key}` });
    if (r.status !== 200 || r.json?.code !== 0) return { ok: false, credits: null, detail: r.status === 200 ? 'Tripo answered with an error' : trouble('Tripo', r) };
    const credits = parseFloat(r.json.data?.balance); // a float, maybe sent as a string
    return Number.isFinite(credits)
      ? { ok: true, credits, detail: `Tripo accepted the key; ${credits} credits left` }
      : { ok: true, credits: null, detail: 'Tripo accepted the key' };
  }

  // A provider check: the visitor's key, else the team's, else none.
  // The team's setup (its keys, credits, Snowflake, Blob) is told only to the TV, which sends HOST_TOKEN; a visitor's
  // own key can be tested by anyone.
  const isHost = (req) => !env.HOST_TOKEN || tokenMatches(req.headers?.['x-host-token'], env.HOST_TOKEN);
  const TV_ONLY = { ok: false, using: 'none', detail: 'Team checks run from the TV only' };

  async function provider(req, header, teamKey, name, test, read = userKey) {
    const key = read(req, header);
    if (key === null) return { ok: false, using: 'yours', detail: `That does not look like a ${name} key` };
    if (!key && !isHost(req)) return TV_ONLY;
    const team = String(teamKey ?? '').trim();
    if (!key && !team) return { ok: false, using: 'none', detail: `No ${name} key on this server; paste your own` };
    return { using: key ? 'yours' : 'team', ...(await test(key || team)) };
  }

  async function check(service, req) {
    if (service === 'gemini') return provider(req, 'x-gemini-key', env.GEMINI_API_KEY, 'Gemini', gemini);
    if (service === 'tripo') return provider(req, 'x-tripo-key', env.TRIPO_API_KEY, 'Tripo', tripo, tripoKey);
    if (service === 'elevenlabs') {
      const out = await provider(req, 'x-elevenlabs-key', env.ELEVENLABS_API_KEY, 'ElevenLabs', elevenlabs);
      if (out.using === 'team' && out.ok && env.SOUND_GEN !== 'on') out.detail += '; sound generation is off on this server';
      return out;
    }
    if (!isHost(req)) return TV_ONLY;
    if (service === 'storage') {
      // A newer store connects by BLOB_STORE_ID (OIDC, which @vercel/blob uses on its own) instead of a token.
      return String(env.BLOB_READ_WRITE_TOKEN ?? '').trim() || String(env.BLOB_STORE_ID ?? '').trim()
        ? { ok: true, using: 'team', detail: 'Blob storage is connected' }
        : { ok: false, using: 'none', detail: 'No Blob store connected' };
    }
    let sf;
    try { sf = await snowflake(); } catch { return { ok: false, using: 'none', detail: 'Snowflake support failed to load' }; }
    if (!sf.configured(env)) return { ok: false, using: 'none', detail: 'Snowflake is not set up on this server' };
    const r = await within(Promise.resolve().then(() => sf.listProjectsResult(1, { env })).catch(() => ({ ok: false })));
    if (r === TIMED_OUT) return { ok: false, using: 'team', detail: `Snowflake did not answer in ${Math.ceil(timeoutMs / 1000)} s` };
    return r.ok ? { ok: true, using: 'team', detail: 'Snowflake answered' } : { ok: false, using: 'team', detail: 'Snowflake did not answer' };
  }

  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') return send(res, 405, { ok: false, using: 'none', detail: 'POST only' }, { Allow: 'POST' });
      if (!allow(clientIp(req), now())) return send(res, 429, { ok: false, detail: 'Too many checks; wait a minute' });
      const got = await readBody(req, 4096);
      const service = got.body?.service;
      if (!SERVICES.includes(service)) return send(res, 400, { ok: false, using: 'none', detail: 'Unknown service' });
      return send(res, 200, await check(service, req));
    } catch {
      return send(res, 200, { ok: false, using: 'none', detail: 'The check itself failed' });
    }
  };
}

export default createHandler();
