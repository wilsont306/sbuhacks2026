// Scene validator shared by api/interpret.js and the host page: turns Gemini's raw answer, or a scene that was
// already stored, into exactly the scene contract (ids, URLs, guesses, palette, ground_path, objects with
// image-space boxes and masks). Pure plain JS for the browser and Node; never throws.

export const KINDS = ['sky', 'cloud', 'celestial', 'water', 'ground', 'plant', 'building', 'vehicle', 'animal', 'person', 'fire', 'object'];
export const MOTIONS = ['none', 'sway', 'drift', 'bob', 'spin', 'fly', 'flicker', 'twinkle'];
export const SOURCES = ['drop', 'phone', 'sample'];
export const LIMITS = Object.freeze({ objects: 8, maskPoints: 24, pathPoints: 8, palette: 5, label: 40, soundWords: 12, guess: 120 });
export const FLAT_PATH = Object.freeze([Object.freeze([0, 850]), Object.freeze([1000, 850])]);

// A mask below this area (image units squared, of 1e6) or below this share of its box is noise, not an outline.
const MIN_MASK_AREA = 25, MIN_MASK_SHARE = 0.02;
// A ground path narrower than a tenth of the picture is not walkable.
const MIN_PATH_SPAN = 100;
// Bounds the work on hostile input before any cleaning.
const MAX_RAW_ITEMS = 64, MAX_RAW_POINTS = 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const fin = Number.isFinite;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const coord = (v) => clamp(v, 0, 1000);
const list = (v, cap) => (Array.isArray(v) ? v.slice(0, cap) : []);
const first = (...vals) => vals.find((v) => v !== undefined && v !== null);
const pick = (v, allowed, dflt) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return allowed.includes(s) ? s : dflt;
};

// One line of display text: control characters and runs of whitespace become single spaces.
function text(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const words = (v, n, max) => text(v, 400).split(' ').filter(Boolean).slice(0, n).join(' ').slice(0, max).trim();

function iso(v) {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  return fin(t) ? new Date(t).toISOString() : null;
}

// '#rrggbb' lowercase from '#rgb', '#rrggbb', '#rrggbbaa' (alpha dropped), with or without '#'; null otherwise.
export function hexColour(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (s[0] === '#') s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.replace(/./g, (c) => c + c);
  else if (/^[0-9a-f]{8}$/.test(s)) s = s.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}

function point(p) {
  const xy = Array.isArray(p) ? p : isObj(p) ? [p.x, p.y] : null;
  if (!xy || xy.length < 2) return null;
  const x = num(xy[0]), y = num(xy[1]);
  return fin(x) && fin(y) ? [x, y] : null;
}

// Evenly spaced picks that keep the first and last item, so a long outline or path keeps its shape when capped.
function thin(items, max) {
  if (items.length <= max) return items;
  const out = [];
  for (let k = 0; k < max; k++) out.push(items[Math.round(k * (items.length - 1) / (max - 1))]);
  return out;
}

export function shoelace(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

function bboxOf(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const okBox = (b) => b[2] - b[0] >= 1 && b[3] - b[1] >= 1;

// Gemini's box_2d is [ymin, xmin, ymax, xmax]; a stored scene's box is already [x0, y0, x1, y1].
function boxOf(o) {
  let b = null;
  if (Array.isArray(o.box_2d) && o.box_2d.length === 4) {
    const [ymin, xmin, ymax, xmax] = o.box_2d.map(num);
    b = [xmin, ymin, xmax, ymax];
  } else if (Array.isArray(o.box) && o.box.length === 4) b = o.box.map(num);
  if (!b || !b.every(fin)) return null;
  const [ax, ay, bx, by] = b.map((v) => Math.round(coord(v)));
  const box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  return okBox(box) ? box : null;
}

// Image-space polygon, or null for fewer than 3 points, any non-numeric point, or a near-zero area.
// frame 'box': points are 0..1000 inside the box (Gemini's documented frame); 'image': already image space.
function maskOf(raw, box, frame) {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  if (frame === 'box' && !box) return null;
  const pts = [];
  for (const p of raw.slice(0, MAX_RAW_POINTS)) {
    const q = point(p);
    if (!q) return null;
    pts.push(q);
  }
  const img = frame === 'box'
    ? pts.map(([x, y]) => [box[0] + coord(x) * (box[2] - box[0]) / 1000, box[1] + coord(y) * (box[3] - box[1]) / 1000])
    : pts.map(([x, y]) => [coord(x), coord(y)]);
  const out = thin(img, LIMITS.maskPoints).map(([x, y]) => [Math.round(x), Math.round(y)]);
  if (out.length < 3) return null;
  const [x0, y0, x1, y1] = box || bboxOf(out);
  const area = Math.abs(shoelace(out));
  return area >= Math.max(MIN_MASK_AREA, MIN_MASK_SHARE * (x1 - x0) * (y1 - y0)) ? out : null;
}

// An optional asset (an object's 3D model, the scene's depth image): an https URL or a site-relative path ('/' not
// followed by '/' or '\'), at most 300 characters with no whitespace, else none.
function assetUrl(v) {
  if (typeof v !== 'string' || v.length > 300 || /\s/.test(v)) return null;
  if (/^\/(?![/\\])/.test(v)) return v;
  if (!/^https:\/\//i.test(v)) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}

function objectOf(o, maskFrame, palette, index) {
  if (!isObj(o)) return null;
  // Only Gemini's raw shape carries box_2d; anything else is a stored scene whose mask is already image space.
  const frame = Array.isArray(o.box_2d) ? maskFrame : 'image';
  let box = boxOf(o);
  const mask = maskOf(o.mask, box, frame);
  if (!box && mask) box = bboxOf(mask);
  if (!box || !okBox(box)) return null;
  const kind = pick(o.kind, KINDS, 'object');
  const d = num(o.depth);
  const depth = fin(d) ? clamp(d, 0, 1) : clamp(1 - box[3] / 1000, 0, 1);
  const out = {
    label: text(o.label, LIMITS.label) || kind,
    kind,
    box,
    mask,
    depth: Math.round(depth * 1000) / 1000,
    colour: hexColour(first(o.colour, o.color)) || palette[index % palette.length] || '#808080',
    motion: pick(o.motion, MOTIONS, 'none'),
    sound_prompt: words(o.sound_prompt, LIMITS.soundWords, 120),
  };
  const model = assetUrl(o.model_url);
  if (model) out.model_url = model;
  return out;
}

function groundPath(raw) {
  const pts = list(raw, MAX_RAW_POINTS).map(point).filter(Boolean).map(([x, y]) => [Math.round(coord(x)), Math.round(coord(y))]);
  pts.sort((a, b) => a[0] - b[0]);
  const path = thin(pts, LIMITS.pathPoints);
  if (path.length < 2 || path[path.length - 1][0] - path[0][0] < MIN_PATH_SPAN) return FLAT_PATH.map((p) => [...p]);
  return path;
}

function build(r, m, maskFrame) {
  const palette = [];
  for (const c of list(r.palette, MAX_RAW_ITEMS)) {
    const h = hexColour(c);
    if (h && !palette.includes(h)) palette.push(h);
    if (palette.length === LIMITS.palette) break;
  }
  const objects = [];
  for (const item of list(r.objects, MAX_RAW_ITEMS)) {
    const ob = objectOf(item, maskFrame, palette, objects.length);
    if (ob) objects.push(ob);
    if (objects.length === LIMITS.objects) break;
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = {
    id: str(first(m.id, r.id), 128),
    source: pick(first(m.source, r.source), SOURCES, 'drop'),
    edited: first(m.edited, r.edited) === true,
    credit: text(first(m.credit, r.credit), 300) || null,
    image_url: str(first(m.image_url, r.image_url), 2048),
    scene_url: str(first(m.scene_url, r.scene_url), 2048),
    model: text(first(m.model, r.model), 80) || 'unknown',
    generated_at: iso(first(m.generated_at, r.generated_at)) || new Date().toISOString(),
    ai_draft: true,
    title_guess: text(r.title_guess, LIMITS.guess) || 'unknown',
    artist_guess: text(r.artist_guess, LIMITS.guess) || 'unknown',
    palette,
    ground_path: groundPath(r.ground_path),
    objects,
  };
  // The TV's depth image for this picture (Depth Anything V2, see src/host/enrich.js); like model_url, never from Gemini.
  const depth = assetUrl(r.depth_url);
  if (depth) out.depth_url = depth;
  return out;
}

// raw: Gemini's parsed answer (or its JSON text, or a stored scene). meta: {id, source, image_url, scene_url, model,
// generated_at, edited?, credit?}, each falling back to raw's own field. opts.maskFrame: 'box' (default) | 'image'.
export function validateScene(raw, meta = {}, opts = {}) {
  let r = raw;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { r = null; }
  }
  const o = isObj(opts) ? opts : {};
  const maskFrame = o.maskFrame === 'image' ? 'image' : 'box';
  const m = isObj(meta) ? meta : {};
  try { return build(isObj(r) ? r : {}, m, maskFrame); } catch { /* hostile getters or similar: fall through */ }
  try { return build({}, m, maskFrame); } catch { return build({}, {}, maskFrame); }
}

// One [x, y] point: exactly two integers.
const XY = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' } };

// The JSON Schema sent to Gemini as response_format. Kept flat with short enums and small maxItems, since large or
// deep schemas are refused with 400 INVALID_ARGUMENT.
export const sceneJsonSchema = {
  type: 'object',
  properties: {
    title_guess: { type: 'string' },
    artist_guess: { type: 'string' },
    palette: { type: 'array', maxItems: LIMITS.palette, items: { type: 'string' } },
    ground_path: {
      type: 'array', minItems: 2, maxItems: LIMITS.pathPoints,
      description: '[x, y] points, whole image, 0-1000, left to right',
      items: XY,
    },
    objects: {
      type: 'array', maxItems: LIMITS.objects,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          box_2d: { type: 'array', minItems: 4, maxItems: 4, description: '[ymin, xmin, ymax, xmax], 0-1000', items: { type: 'integer' } },
          mask: {
            type: 'array', maxItems: LIMITS.maskPoints,
            description: 'outline polygon, [x, y] points normalized 0-1000 inside box_2d',
            items: XY,
          },
          depth: { type: 'number', minimum: 0, maximum: 1, description: '0 nearest the viewer, 1 farthest' },
          colour: { type: 'string', description: '#rrggbb' },
          motion: { type: 'string', enum: MOTIONS },
          sound_prompt: { type: 'string' },
        },
        required: ['label', 'kind', 'box_2d', 'mask', 'depth', 'colour', 'motion', 'sound_prompt'],
      },
    },
  },
  required: ['title_guess', 'artist_guess', 'palette', 'ground_path', 'objects'],
};
