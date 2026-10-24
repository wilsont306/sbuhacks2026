// Bring your own keys, for the API plug-in box (src/host/apibox.js, K): a visitor's Gemini and ElevenLabs keys live in
// this browser only (sessionStorage 'tt.byok', or localStorage when "Remember on this device" is ticked) and go to this
// site's own API as request headers. Pure and node-safe: createByok() takes the storages, so the tests inject fakes.
// No ?. or ?? here: the phone page may import it, and iOS 13 must still parse it.

export const STORE_KEY = 'tt.byok';
export const EVENT = 'tt:keys';
export const KEY_RE = /^[A-Za-z0-9_.-]{20,200}$/;
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

// A key as the server accepts it (trimmed), else ''.
export const cleanKey = (k) => (typeof k === 'string' && KEY_RE.test(k.trim()) ? k.trim() : '');
export const validKey = (k) => cleanKey(k) !== '';

export function normalize(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    gemini: cleanKey(v.gemini),
    geminiModel: MODELS.indexOf(v.geminiModel) >= 0 ? v.geminiModel : '',
    elevenlabs: cleanKey(v.elevenlabs),
    remember: v.remember === true,
  };
}

// 'AIza…X9q2': enough to recognise a key, never enough to use it.
export function mask(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return '';
  return k.length < 12 ? '…' + k.slice(-2) : k.slice(0, 4) + '…' + k.slice(-4);
}

// Only the fields that are set, so a visitor with no keys sends exactly what the page sent before.
export function headersFor(keys) {
  const k = normalize(keys), h = {};
  if (k.gemini) h['x-gemini-key'] = k.gemini;
  if (k.geminiModel) h['x-gemini-model'] = k.geminiModel;
  if (k.elevenlabs) h['x-elevenlabs-key'] = k.elevenlabs;
  return h;
}

const attempt = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
const getter = (s) => (typeof s === 'function' ? s : () => s);

// {session, local}: storages, or functions returning them (reading window.localStorage itself throws when site data
// is blocked). notify(keys) runs after every change; the default dispatches the window event 'tt:keys' (no payload).
export function createByok(opts) {
  const o = opts || {};
  const session = getter(o.session), local = getter(o.local);
  const notify = typeof o.notify === 'function' ? o.notify : () => {};
  const read = (s) => attempt(() => { const st = s(); return st ? JSON.parse(st.getItem(STORE_KEY)) : null; }, null);
  const write = (s, raw) => attempt(() => { const st = s(); if (!st) return false; st.setItem(STORE_KEY, raw); return true; }, false);
  const drop = (s) => attempt(() => { const st = s(); if (st) st.removeItem(STORE_KEY); }, null);

  const load = () => normalize(read(session) || read(local));

  // Merges a partial update; remember true keeps them in localStorage (sessionStorage cleared), else the reverse.
  function save(patch) {
    const next = normalize(Object.assign(load(), patch || {}));
    const raw = JSON.stringify(next);
    if (next.remember && write(local, raw)) drop(session);
    else { write(session, raw); if (!next.remember) drop(local); }
    attempt(() => notify(next));
    return next;
  }

  function clear() {
    drop(session); drop(local);
    const next = normalize(null);
    attempt(() => notify(next));
    return next;
  }

  return { load, save, clear, apiHeaders: () => headersFor(load()) };
}

const byok = createByok({
  session: () => globalThis.sessionStorage,
  local: () => globalThis.localStorage,
  notify: () => { if (typeof dispatchEvent === 'function' && typeof Event === 'function') dispatchEvent(new Event(EVENT)); },
});
// Keys leave this browser only over HTTPS (or to this machine): never across venue Wi-Fi to the laptop hub in clear.
export const secureOrigin = (loc) => !loc || loc.protocol === 'https:' || /^(localhost|127.0.0.1|[::1])$/.test(loc.hostname);
export const load = byok.load, save = byok.save, clear = byok.clear;
export const apiHeaders = () => (secureOrigin(globalThis.location) ? byok.apiHeaders() : {});

// One POST /api/check answer -> {ok, using, detail, credits}. No JSON means no API here (the laptop hub, npm run dev).
export function readCheck(status, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) {
    const detail = status ? 'No API here (the laptop hub or npm run dev)' : "No answer from this site's API";
    return { ok: false, using: '', detail, credits: null };
  }
  const text = typeof b.detail === 'string' ? b.detail.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return {
    ok: b.ok === true,
    using: ['yours', 'team', 'none'].indexOf(b.using) >= 0 ? b.using : '',
    detail: text || (b.ok === true ? 'Working' : 'Failed'),
    credits: typeof b.credits === 'number' && isFinite(b.credits) ? b.credits : null,
  };
}

// The relay's health: GET /api/ws on Vercel (https), /healthz on the laptop hub.
export const relayPath = (protocol) => (protocol === 'https:' ? '/api/ws' : '/healthz');

// -> {ok, detail, rows: [[name, value]]} from that answer.
export function relayView(status, body, path) {
  const b = body && typeof body === 'object' ? body : null;
  if (!b || b.ok !== true) return { ok: false, detail: status ? 'No relay health at ' + path : 'No answer from the relay', rows: [] };
  const rows = [];
  const s = (v) => (typeof v === 'string' ? v.slice(0, 40) : '');
  if (s(b.region)) rows.push(['region', s(b.region)]);
  if (s(b.instance)) rows.push(['instance', s(b.instance).slice(0, 8)]);
  if (s(b.bus)) rows.push(['bus', b.bus === 'redis' ? 'Upstash Redis' : b.bus === 'local' ? 'local, no redis' : s(b.bus)]);
  if (Number.isInteger(b.sockets)) rows.push(['sockets', String(b.sockets)]);
  return { ok: true, detail: 'Answering', rows };
}
