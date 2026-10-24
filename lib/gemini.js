// Gemini "read the artwork" call (milestone 2): one downscaled image in, Gemini's raw scene JSON out, through the
// Interactions API of @google/genai 2.x with a JSON response schema. src/shared/scene-validate.js cleans it after.
// One project, one key (GEMINI_API_KEY), no rotation (Google's API terms); the key is never logged.
import { sceneJsonSchema } from '../src/shared/scene-validate.js';

export const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.8-flash';
export const ATTEMPT_MS = 12000;
// With less time than this left, another attempt cannot finish; report a timeout instead.
const MIN_ATTEMPT_MS = 2500;

export const PROMPT = [
  'This is an artwork: a painting, a print, a photo of a postcard, or a sketch on paper.',
  'A renderer will turn it into a small 3D diorama that visitors walk through, reading about each thing they reach. Describe it as JSON matching the schema.',
  'objects: up to 8 prominent things a viewer would want to know about, most prominent first. For each:',
  '- label: a short everyday name, at most 4 words (for example "cypress tree", "church steeple").',
  '- kind: the closest listed kind.',
  '- box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000.',
  '- mask: its outline as a polygon of at most 24 [x, y] points normalized to 0-1000 inside its box_2d.',
  '- depth: a guess from 0 (nearest the viewer) to 1 (farthest, such as the sky or the horizon).',
  '- motion: how it would plausibly move if the scene came alive; none for things that stay still.',
  '- colour: its dominant colour as #rrggbb.',
  '- sound_prompt: a sound effect it could make, at most 12 words, no music and no speech.',
  '- description: one or two plain sentences, at most 220 characters: what this part of the picture shows, and one thing',
  '  worth noticing in how it is painted or drawn. Plain words. Do not invent names, dates or facts you cannot see.',
  'ground_path: 2 to 8 [x, y] points in whole-image coordinates normalized to 0-1000 (x left to right, y top to bottom),',
  'ordered left to right, tracing the ground or floor along which small figures could walk.',
  'palette: up to 5 dominant colours of the whole picture as #rrggbb.',
  'title_guess and artist_guess: your best guess at the title and the artist. Say "unknown" rather than invent one.',
].join('\n');

// flash-lite documents 'minimal' as its segmentation setting; 3.8 Flash's lowest level is 'low' (minimal errors).
export const thinkingFor = (model) => (/flash-lite/i.test(String(model)) ? 'minimal' : 'low');

export function buildRequest({ model, base64, mimeType = 'image/jpeg' }) {
  return {
    model,
    input: [
      { type: 'image', data: base64, mime_type: mimeType, resolution: 'low' },
      { type: 'text', text: PROMPT },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: sceneJsonSchema },
    generation_config: { thinking_level: thinkingFor(model) },
  };
}

export function failure(reason, message, status) {
  const err = new Error(message || reason);
  err.reason = reason;
  if (status) err.status = status;
  return err;
}

function textFromSteps(interaction) {
  const out = [];
  for (const step of Array.isArray(interaction?.steps) ? interaction.steps : []) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const c of step.content) if (c?.type === 'text' && typeof c.text === 'string') out.push(c.text);
  }
  return out.join('');
}

// The interaction's JSON text as a plain object, or a 'bad_json' failure.
export function parseOutput(interaction) {
  let s = typeof interaction?.output_text === 'string' && interaction.output_text ? interaction.output_text : textFromSteps(interaction);
  s = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(s); } catch { throw failure('bad_json', 'the answer is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('bad_json', 'the answer is not a JSON object');
  return value;
}

// -> {reason, retry (same model once more), fallback (worth one call to the other model)}.
export function classify(err) {
  if (err?.reason === 'bad_json' || err?.reason === 'timeout') return { reason: err.reason, retry: true, fallback: true };
  const status = Number(err?.status ?? err?.statusCode) || 0;
  const name = String(err?.name || '');
  if (/timeout|abort/i.test(name)) return { reason: 'timeout', retry: true, fallback: true };
  if (status >= 500) return { reason: 'upstream', retry: true, fallback: true, status };
  // Quotas are per model, so the other model may still answer; the same one will not.
  if (status === 429) return { reason: 'quota', retry: false, fallback: true, status };
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(String(err?.message)))) {
    return { reason: 'auth', retry: false, fallback: false, status };
  }
  if (status >= 400) return { reason: 'rejected', retry: false, fallback: true, status };
  return { reason: 'network', retry: true, fallback: true };
}

let cached = null;
async function clientFor(apiKey) {
  if (cached?.key !== apiKey) {
    const { GoogleGenAI } = await import('@google/genai');
    cached = { key: apiKey, ai: new GoogleGenAI({ apiKey }) };
  }
  return cached.ai;
}

// One call, settled within ms even if the SDK ignores the abort; the SDK's own retries are off so ours decide.
async function callOnce(ai, request, ms) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, no) => {
    timer = setTimeout(() => { ctl.abort(); no(failure('timeout', `no answer in ${ms} ms`)); }, ms);
  });
  try {
    return await Promise.race([ai.interactions.create(request, { signal: ctl.signal, retries: { strategy: 'none' } }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The key comes out before the cut, so no prefix of it can survive at the 200-character edge.
const scrub = (msg, key) => {
  const s = String(msg ?? '');
  return (key ? s.split(key).join('[key]') : s).slice(0, 200);
};

// -> {raw, model}. Primary model, one retry on bad JSON / 5xx / timeout / network, then one call to the fallback
// model; every attempt is capped at attemptMs and at deadline (epoch ms), and none starts too close to it. Throws an Error with
// .reason ('no_key' | 'bad_image' | 'timeout' | 'bad_json' | 'upstream' | 'quota' | 'auth' | 'rejected' | 'network').
export async function readArtwork({
  base64,
  mimeType = 'image/jpeg',
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || PRIMARY_MODEL,
  fallbackModel = FALLBACK_MODEL,
  attemptMs = ATTEMPT_MS,
  // No deadline means each attempt is bounded by attemptMs alone (at most three of them).
  deadline = Infinity,
  client = null,
  log = console.warn,
} = {}) {
  if (!client && !apiKey) throw failure('no_key', 'GEMINI_API_KEY is not set');
  if (typeof base64 !== 'string' || !base64) throw failure('bad_image', 'no image data');
  const ai = client || (await clientFor(apiKey));
  const until = Number.isFinite(deadline) ? deadline : Infinity;
  const plan = [model, model];
  if (fallbackModel && fallbackModel !== model) plan.push(fallbackModel);
  let last = null;
  for (let i = 0; i < plan.length; i++) {
    const same = i > 0 && plan[i] === plan[i - 1];
    if (last && same && !last.retry) continue;
    if (last && !same && !last.fallback) break;
    const left = until - Date.now();
    // Out of time: report the failure that cost the time (or a timeout if nothing was tried).
    if (left < Math.min(MIN_ATTEMPT_MS, attemptMs)) { last = last || { reason: 'timeout' }; break; }
    try {
      const interaction = await callOnce(ai, buildRequest({ model: plan[i], base64, mimeType }), Math.min(attemptMs, left));
      return { raw: parseOutput(interaction), model: plan[i] };
    } catch (err) {
      last = classify(err);
      log(`gemini: ${plan[i]} attempt ${i + 1} failed (${last.reason}${last.status ? ' ' + last.status : ''}): ${scrub(err?.message, apiKey)}`);
    }
  }
  throw failure(last?.reason || 'error', `gemini gave no scene (${last?.reason || 'error'})`, last?.status);
}
