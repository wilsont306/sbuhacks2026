// The inside view's world (src/join/inside.js builds it when a phone steps inside): a Tour-into-the-Picture diorama of
// a validated scene, on tip.js's geometry. The floor and the back wall sample the painting by projective texturing
// through the painting camera, and each standing object is a flat cut-out showing its own crop of the picture, so
// from that camera the world is exactly the picture and from anywhere else a paper theatre with depth. Each flat turns
// to face the walker, slides out of the walk's way (keeping its size seen from the painting camera) and has a soft
// contact shadow; in a drawing (opts.lineArt) it is cut out of its paper too. Each flat's pixels are inpainted out of
// the floor and wall behind it from the colours around them (the "plate"), so walking past an object does not show it
// twice, and past the picture's frame every object is (FRAG's uBack). A wide object the walk runs along the top of (a
// bridge's deck) lies painted on the floor under the walk. With a depth picture (opts.depth) whose floor fits
// TIP's, the floor and wall become one relief mesh (the depth room, tip.js), the flats stand at their depth and the
// walk follows the terrain; without one, for a drawing (opts.lineArt: depth estimation reads ink on paper as noise),
// or when the fit fails, the plain floor and wall planes. An object's optional model_url (a GLB) stands in for its
// flat once it loads. No ?. or ??: the phone's lazy inside chunk imports this file (iOS 13).
import * as THREE from 'three';
import { validateScene } from '../shared/scene-validate.js';
import { pathPoints } from '../host/maskDepth.js';
import {
  BACKDROP, FLOOR_KINDS, paintingCamera, imageToFloor, planePoint, rowDistance, padBox, flatOf, extentOf, project,
  fitDepth, fillDepth, flatDistance, reliefGrid, terrainPath, shapeOf, pushPull,
  slideScale, turnWeight, turnYaw, turnCap, hides, isDeck, lookPoint, groundHeight,
} from './tip.js';
import { paperGains, paperOutside } from '../shared/lineart.js';

const MAX_TEX = 2048;  // plate pixels on the long side
const MASK_PX = 256;   // a flat's mask canvas on its long side
const RIM = 6;         // the cut-out's paper border, in image units across (0.6% of the picture's width)
const FILL_PX = 512;   // the plate's hole fill is worked at this size on the long side, then scaled up (a fill is soft)
const STROKES = 0.5;   // how much of the brushwork beside a hole carries into it (tip.js pushPull); none for a drawing, whose
                       // "brushwork" is ink lines that would streak the fill
const CANVAS = ['sky', 'ground']; // kinds that are the picture's own ground and sky: past its frame they go on, mirrored
const MODEL_MS = 20000;
const PATH_K = 128;    // the walk is sampled this many steps along t
// Under the relief the plain floor stays as a skirt (seen past the picture's edges and through cut silhouettes),
// dropped clear of the relief's noise, and the plain wall stays behind its farthest points.
const SKIRT = 0.25, WALL_BACK = 1.05;
const FLAT_FAR = 0.95; // a flat whose depth reaches this share of the wall's distance stays painted on the relief
const TURN_RATE = 6;   // a flat's turn to the walker eases at this rate a second
const SHADOW_LIFT = 0.01;
const FADE = 0.75;     // a flat in the way of the stop the view turns to drops this share of its pixels (a screen door)
// shortcut: Tripo's GLBs face +x by its default export orientation (not checked by eye yet); this turns +x to +z,
// toward the painting camera. Check one real model and flip the sign if it shows its back.
export const MODEL_YAW = -Math.PI / 2;
const okModel = (u) => typeof u === 'string' && u.length <= 300 && /^(https:\/\/\S+|\/(?![/\\])\S*)$/.test(u); // README, Scene

const VERT = `
uniform mat4 uRest;
varying vec3 vRest;
#ifdef CUT
attribute vec3 uvq;
varying vec3 vUvq;
#endif
void main() {
  vRest = (uRest * vec4(position, 1.0)).xyz;
#ifdef CUT
  vUvq = uvq;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A flat (CUT) shows its own crop of the picture: each vertex carries its place in the picture as (u q, v q, q), q its
// depth from the painting camera where the flat was first put (diorama.js), so the crop follows the painting
// camera's keystone exactly and stays on the flat however it turns or slides; its mask over its padded box (uBox)
// cuts it out, and while it stands in the way of the stop the view turns to it drops uFade of its pixels. Everything
// else takes uv = the rest position projected through the painting camera. Outside the picture's frame the painting
// continues mirrored about its side and bottom edges inset by EDGE, so the picture's own pale border never lines a
// seam (the floor nearer than the picture's foot mirrors the floor beyond it), and above its top edge it goes on as
// its top strip, never mirrored (that would hang the ground in the sky), easing from about half a picture out into a
// softer mip of itself (BLUR; above the top, within a third of a picture, and on to a far softer one so the strip
// never streaks). Whatever is not the picture's own place (past the frame, the mirrored floor, behind the painting
// camera) samples uBack, the picture with every object but its sky and ground inpainted (a celestial one with its
// glow), so no sun, moon, cloud or figure shows twice. The border band inside the frame stays as painted while the eye
// is at the painting camera and joins the mirror once it has stepped away, so the painting camera still sees exactly
// the picture. The dome maps each direction from the painting camera, one behind it mirrored to the front the way
// the floor is: projective near the frame (so it meets the wall's edges seamlessly), by angle further out (so uv
// stays bounded round the sides, with no streaks or kaleidoscope); the floor turns into that mapping as it nears
// the dome, so the horizon has no seam. Whatever lies behind the painting camera (dome and floor alike) takes the
// soft mip.
const FRAG = `
#define EDGE 0.015
#define BLUR 3.0
uniform sampler2D uMap;
uniform mat4 uPaint;
uniform vec3 uCam;
uniform float uNear;
uniform float uR;
uniform float uGlow;
varying vec3 vRest;
#ifdef CUT
uniform sampler2D uMask;
uniform vec4 uBox;
uniform float uFade;
varying vec3 vUvq;
#else
uniform sampler2D uBack;
#endif
#if defined(FLOOR) || defined(DOME)
// d: a direction from the painting camera; lens: its projection's x and y scale. Exactly projective inside the
// frame, turning to by-angle from the frame's edge to a picture beyond it.
vec2 domeUv(vec3 d, vec2 lens) {
  d.z = -abs(d.z);
  vec4 pd = uPaint * vec4(d, 0.0);
  vec3 e = normalize(vec3(pd.xy / lens, abs(pd.w))); // its own frame, z toward the picture
  e.z = max(e.z, 0.001); // beside the camera ndc stays finite (it is by-angle there anyway)
  vec2 ndc = e.xy * lens / e.z;
  vec2 ang = vec2(atan(e.x, e.z), atan(e.y, length(e.xz))) / atan(1.0 / lens);
  return mix(ndc, ang, smoothstep(1.0, 3.0, max(abs(ndc.x), abs(ndc.y)))) * 0.5 + 0.5;
}
#endif
void main() {
#ifdef CUT
  vec2 uv = vUvq.xy / vUvq.z;
  vec2 m = (uv - uBox.xy) / (uBox.zw - uBox.xy), f = mod(floor(gl_FragCoord.xy), 2.0);
  if (m.x < 0.0 || m.x > 1.0 || m.y < 0.0 || m.y > 1.0 || texture2D(uMask, m).r < 0.5) discard;
  if ((2.0 * f.x + 3.0 * f.y - 4.0 * f.x * f.y + 0.5) / 4.0 < uFade) discard; // a 2 x 2 ordered dither
  gl_FragColor = vec4(texture2D(uMap, uv).rgb * (1.0 + uGlow), 1.0);
#else
  vec3 q = vRest;
  float soft = 0.0, mir = 0.0;
#if defined(FLOOR) || defined(DOME)
  vec2 lens = vec2(length(vec3(uPaint[0][0], uPaint[1][0], uPaint[2][0])), length(vec3(uPaint[0][1], uPaint[1][1], uPaint[2][1])));
  vec4 pd = uPaint * vec4(q - uCam, 0.0);
  soft = 1.0 - smoothstep(-0.4, 0.0, pd.w / length(vec3(pd.xy / lens, pd.w))); // edges in order: GLSL leaves edge0 > edge1 undefined
  vec2 uv = domeUv(q - uCam, lens);
#ifdef FLOOR
  if (q.z > -uNear) {
    q.z = -2.0 * uNear - q.z;
    uv = mix(domeUv(q - uCam, lens), uv, smoothstep(0.5 * uR, uR, length(vRest - uCam)));
    mir = 1.0;
  }
#endif
#else
  vec4 p = uPaint * vec4(q, 1.0);
  vec2 uv = p.xy / max(p.w, 0.0001) * 0.5 + 0.5;
#endif
  vec2 o = max(max(-uv, uv - 1.0), 0.0);
  float up = smoothstep(0.0, 0.3, uv.y - 1.0); // above the top: the top strip, spread ever softer so it never streaks
  float far = max(max(soft, smoothstep(0.6, 2.0, max(o.x, o.y))), up);
  float alt = max(max(soft, mir), o.x + o.y > 0.0 ? 1.0 : 0.0);
  float away = o.x + o.y > 0.0 ? 1.0 : smoothstep(0.0, 0.1 * uNear, distance(cameraPosition, uCam));
  vec2 m = EDGE + (1.0 - 2.0 * EDGE) * (1.0 - abs(mod((uv - EDGE) / (1.0 - 2.0 * EDGE), 2.0) - 1.0));
  if (uv.y > 1.0) m.y = 1.0 - EDGE;
  uv = mix(uv, m, away);
  vec3 c = mix(texture2D(uMap, uv).rgb, texture2D(uMap, uv, BLUR).rgb, far);
  vec3 b = mix(texture2D(uBack, uv).rgb, texture2D(uBack, uv, BLUR - 2.0 + 5.0 * up).rgb, far); // uBack: a quarter of uMap's size
  gl_FragColor = vec4(mix(c, b, alt) * (1.0 + uGlow), 1.0);
#endif
}`;

const fin = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const wrap = (r) => r - Math.PI * 2 * Math.floor((r + Math.PI) / (Math.PI * 2)); // to -PI..PI

// A soft round contact shadow, darkest at its centre; its plane is scaled to each footprint. null without a DOM.
function shadowTexture() {
  if (typeof document === 'undefined') return null;
  const c = canvasOf(64, 64), ctx = c.getContext('2d'), g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(30,24,18,0.5)'); g.addColorStop(0.55, 'rgba(30,24,18,0.28)'); g.addColorStop(1, 'rgba(30,24,18,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function trace(ctx, pts, ox, oy, sx, sy) {
  ctx.beginPath();
  pts.forEach((p, k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, (p[0] - ox) * sx, (p[1] - oy) * sy));
  ctx.closePath();
}

// The flat's alpha: its outline plus the rim, white on black, over its padded box (A keeps the pixels square). cut (a
// drawing's, paperCut): the bare paper joined to the box's edge is cut away too (lineart.js paperOutside), so a drawn
// object stands as its own silhouette rather than a card of paper, whatever its outline (often just its box).
function maskTexture(shape, box, A, cut) {
  if (typeof document === 'undefined') return null;
  const bw = box[2] - box[0], bh = (box[3] - box[1]) / A, k = MASK_PX / Math.max(bw, bh);
  const c = canvasOf(Math.max(2, Math.round(bw * k)), Math.max(2, Math.round(bh * k))), ctx = c.getContext('2d');
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * RIM * k; ctx.lineJoin = 'round';
  trace(ctx, shape, box[0], box[1], k, k / A);
  ctx.fill(); ctx.stroke();
  if (cut) cutPaper(ctx, c.width, c.height, box, cut);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

// A drawing's paper, for cutting its objects out: {img, iw, ih, gains}, gains its white balance from a small copy
// (lineart.js paperGains); null without a DOM or when the picture will not read back.
function paperCut(img, iw, ih) {
  if (!img || typeof document === 'undefined' || !(iw > 0 && ih > 0)) return null;
  let c = null;
  try {
    const k = Math.min(1, MASK_PX / Math.max(iw, ih)), w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    c = canvasOf(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return { img, iw, ih, gains: paperGains(ctx.getImageData(0, 0, w, h).data, w, h) };
  } catch (e) {
    return null;
  } finally {
    if (c) c.width = c.height = 0;
  }
}
// The mask (ctx, w by h over box) loses the paper joined to its edge in that crop of the picture (clear: the plate's
// hole is the silhouette too); one that will not read back keeps its outline.
function cutPaper(ctx, w, h, box, cut) {
  let p = null;
  try {
    p = canvasOf(w, h);
    const pctx = p.getContext('2d');
    pctx.drawImage(cut.img, box[0] / 1000 * cut.iw, box[1] / 1000 * cut.ih, (box[2] - box[0]) / 1000 * cut.iw, (box[3] - box[1]) / 1000 * cut.ih, 0, 0, w, h);
    const out = paperOutside(pctx.getImageData(0, 0, w, h).data, w, h, cut.gains), m = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < out.length; i++) if (out[i]) m.data[4 * i] = m.data[4 * i + 1] = m.data[4 * i + 2] = m.data[4 * i + 3] = 0;
    ctx.putImageData(m, 0, 0);
  } catch (e) {
    // the outline stands
  } finally {
    if (p) p.width = p.height = 0;
  }
}

const pot = (n) => Math.pow(2, Math.round(Math.log2(Math.max(1, n))));
// A sun's, moon's or star's box with the glow painted round it: HALO of its size more on every side, as an outline.
const HALO = 0.5;
function halo(b) {
  const dx = HALO * (b[2] - b[0]), dy = HALO * (b[3] - b[1]), x0 = clamp(b[0] - dx, 0, 1000), x1 = clamp(b[2] + dx, 0, 1000), y0 = clamp(b[1] - dy, 0, 1000), y1 = clamp(b[3] + dy, 0, 1000);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
// The picture with every standing object (flats: their outlines, or {canvas, box}: a cut-out drawing's mask canvas
// over its padded box; with its rim) inpainted from the colours around it (tip.js pushPull), for the floor and the
// wall (plate); and a small copy with the other objects but the sky and the ground (others, outlines) inpainted too
// (beyond), for whatever is not the picture's own place (FRAG's uBack). Either is null when it has no holes or the
// image cannot be read back (no DOM, no size, or a cross-origin canvas, which WebGL would refuse as well). strokes:
// pushPull's.
function plateTextures(img, flats, others, strokes) {
  const got = { plate: null, beyond: null };
  if (!(flats.length || others.length) || !img || typeof document === 'undefined') return got;
  let c = null, small = null, mask = null, far = null; // zeroed on the way out (iOS counts canvas memory), c and far kept only by a texture
  try {
    const nw = img.naturalWidth || img.videoWidth || img.width, nh = img.naturalHeight || img.videoHeight || img.height;
    if (!(nw > 0 && nh > 0)) return got;
    const k = Math.min(1, MAX_TEX / Math.max(nw, nh)), w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
    const f = Math.min(1, FILL_PX / Math.max(w, h)), fw = Math.max(1, Math.round(w * f)), fh = Math.max(1, Math.round(h * f));
    small = canvasOf(fw, fh); mask = canvasOf(fw, fh);
    const sctx = small.getContext('2d'), mctx = mask.getContext('2d');
    sctx.imageSmoothingQuality = 'high'; // a 4x shrink; Safari's default 'low' aliases the brushwork
    sctx.drawImage(img, 0, 0, fw, fh);
    const px = sctx.getImageData(0, 0, fw, fh), orig = px.data.slice(); // throws on a tainted canvas
    // the holes: every outline with its rim, and a pixel more all round (the shrink mixed the object into its edge)
    const holes = (shapes) => {
      mctx.clearRect(0, 0, fw, fh);
      mctx.fillStyle = mctx.strokeStyle = '#fff';
      mctx.lineWidth = 2 * RIM * fw / 1000 + 2; mctx.lineJoin = 'round';
      for (const shape of shapes) {
        if (Array.isArray(shape)) { trace(mctx, shape, 0, 0, fw / 1000, fh / 1000); mctx.fill(); mctx.stroke(); continue; }
        const b = shape.box, x = b[0] * fw / 1000, y = b[1] * fh / 1000, w = (b[2] - b[0]) * fw / 1000, h = (b[3] - b[1]) * fh / 1000;
        for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) mctx.drawImage(shape.canvas, x + dx, y + dy, w, h); // a pixel more all round
      }
      const m = mctx.getImageData(0, 0, fw, fh).data, hole = new Uint8Array(fw * fh);
      for (let i = 0; i < hole.length; i++) hole[i] = m[4 * i + 3] ? 1 : 0;
      return hole;
    };
    if (pushPull(px.data, fw, fh, holes(flats.concat(others)), strokes)) {
      sctx.putImageData(px, 0, 0);
      far = canvasOf(pot(fw), pot(fh)); // power-of-two sides: WebGL1 mips it
      far.getContext('2d').drawImage(small, 0, 0, far.width, far.height);
      got.beyond = new THREE.CanvasTexture(far);
      far = null;
    }
    if (!flats.length) return got;
    px.data.set(orig);
    if (!pushPull(px.data, fw, fh, holes(flats), strokes)) return got;
    sctx.putImageData(px, 0, 0);
    sctx.globalCompositeOperation = 'destination-in'; // only the holes, soft-edged, go back over the full-size picture
    sctx.drawImage(mask, 0, 0);
    c = canvasOf(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    ctx.drawImage(small, 0, 0, w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 16; // the far floor is seen at a grazing angle; the renderer clamps this to what the GPU has
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping; // past the frame the painting continues mirrored (FRAG)
    c = null;
    got.plate = t;
    return got;
  } catch (e) {
    return got;
  } finally {
    for (const cv of [c, small, mask, far]) if (cv) cv.width = cv.height = 0;
  }
}

// o.part: 'floor', 'dome' or a flat (o.box set: its padded box in UV, o.mask its outline); anything else is the back
// wall. o.R: the dome's radius (the floor). o.beyond: FRAG's uBack (map when not given).
function paintMaterial(map, paint, cam, rest, o) {
  const defines = {};
  if (o.part === 'floor') defines.FLOOR = '';
  if (o.part === 'dome') defines.DOME = '';
  if (o.box) defines.CUT = '';
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map }, uPaint: { value: paint }, uRest: { value: rest }, uCam: { value: v3(cam.position) }, uNear: { value: cam.nearDist },
      uR: { value: o.R || 1 }, uGlow: { value: 0 }, uMask: { value: o.mask || null }, uBox: { value: o.box || new THREE.Vector4(0, 0, 1, 1) },
      uBack: { value: o.beyond || map }, uFade: { value: 0 },
    },
    defines, vertexShader: VERT, fragmentShader: FRAG, side: o.side || THREE.FrontSide,
  });
}

function disposeTree(root) {
  root.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) if (m[key] && m[key].isTexture) m[key].dispose(); // a model's maps; uniforms are not scanned
      m.dispose();
    }
  });
}

// scene: a validated scene (validated again here). texture: the painting (THREE.Texture, flipY as THREE loads it); the
// caller owns it, dispose() leaves it alone. opts.aspect: the picture's width / height, else read from the texture.
// opts.depth: an optional depth picture, {data: Uint8Array, w, h} (README, Inside view). opts.lineArt: the picture is a
// drawing (src/shared/lineart.js), so any depth is ignored and the room keeps its plain floor and wall.
export function buildDiorama(scene, texture, opts) {
  const s = validateScene(scene), o = opts || {};
  const img = texture && texture.image;
  const iw = img ? img.naturalWidth || img.videoWidth || img.width : 0, ih = img ? img.naturalHeight || img.videoHeight || img.height : 0;
  const A = clamp(fin(o.aspect) && o.aspect > 0 ? o.aspect : iw > 0 && ih > 0 ? iw / ih : 4 / 3, 0.25, 4);
  const cam = paintingCamera(s, A), ext = extentOf(cam);
  const fit = o.depth && !o.lineArt ? fitDepth(cam, s, o.depth) : null; // null for no depth, a drawing, a bad depth, or one whose floor does not fit
  const owned = [];
  let map = texture && texture.isTexture ? texture : null;
  if (!map) { map = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); map.needsUpdate = true; owned.push(map); }

  const lens = new THREE.PerspectiveCamera(cam.fov, cam.aspect, 0.1, ext.far * 4);
  lens.position.copy(v3(cam.position));
  lens.lookAt(v3(cam.lookAt));
  lens.updateMatrixWorld(true);
  const paint = new THREE.Matrix4().multiplyMatrices(lens.projectionMatrix, lens.matrixWorldInverse);

  // Sort every object: painted on the wall, lying on the floor (the floor kinds, and a deck the walk runs along: tip.js
  // isDeck), or standing as a flat. In the depth room a flat stands at its median depth (one as far as the wall stays
  // painted on the relief), never behind the relief over its outline; the relief's depth (filled) is the picture's
  // with the flats' outlines filled and the backdrop on the wall.
  const pts = pathPoints(s, () => 0, 8);
  const lies = s.objects.map((ob) => FLOOR_KINDS.indexOf(ob.kind) >= 0 || isDeck(ob, pts));
  const stand = s.objects.map((ob, i) => (BACKDROP.indexOf(ob.kind) < 0 && !lies[i] ? padBox(ob.box, A, RIM) : null));
  const up = s.objects.map((ob, i) => !!stand[i] && stand[i][3] > cam.wallRow + 1 && !(fit && flatDistance(cam, fit, o.depth, ob) >= FLAT_FAR * cam.farDist));
  const filled = fit ? fillDepth(o.depth, s.objects.filter((ob, i) => up[i]).map(shapeOf), s.objects.filter((ob) => BACKDROP.indexOf(ob.kind) >= 0).map(shapeOf)) : null;
  const grid = filled ? reliefGrid(cam, fit, filled) : null, terrain = grid ? fit : null;
  const groundAt = (x, z) => groundHeight(cam, terrain, filled, x, z); // the relief's height, else the floor's 0

  // The walk: the TV's own curve through maskDepth's path points, then through the painting camera onto the floor, or
  // onto the relief's terrain (its filled depth, so behind an object the walk is on the ground there).
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)), false, 'catmullrom', 0.5);
  const tmp = new THREE.Vector3(), uvs = [];
  for (let k = 0; k <= PATH_K; k++) { curve.getPoint(k / PATH_K, tmp); uvs.push([tmp.x, tmp.y]); }
  const walk = terrainPath(cam, terrain, filled, uvs), walkV = walk.map(v3);
  const floorAt = (t) => { const f = t * PATH_K, k = Math.min(PATH_K - 1, Math.floor(f)); return walkV[k].clone().lerp(walkV[k + 1], f - k); };
  function pathAt(t) {
    const tt = clamp(fin(t) ? t : 0, 0, 1), forward = floorAt(Math.min(1, tt + 0.01)).sub(floorAt(Math.max(0, tt - 0.01)));
    forward.y = 0;
    if (forward.lengthSq() < 1e-12) forward.set(0, 0, -1); else forward.normalize();
    return { position: floorAt(tt), forward };
  }

  // A flat (or the model in its place) stands at k along its bearing from the painting camera (tip.js slideScale),
  // scaled by k, as high over (or as far under) the ground there as it stood where it was put, times k. Its entry in
  // objects says where it stands; the flat itself slides there as the eye leaves the painting camera (pose), so that
  // camera sees the picture. fl.cap: how far it may turn there (tip.js turnCap), so a wide one never lies across the walk.
  function place(fl, k) {
    const f = fl.f, x = k * f.foot[0], z = k * f.foot[2], g0 = groundAt(f.foot[0], f.foot[2]), g1 = k === 1 ? g0 : groundAt(x, z);
    fl.k = k;
    fl.foot = k === 1 ? f.foot : [x, g1 + k * (f.foot[1] - g0), z];
    fl.cap = turnCap(cam, walk, fl.foot, k * (f.right - f.left) / 2);
    fl.ground = [g0, g1]; // under it before and after
    fl.item.position.fromArray(fl.foot);
    fl.item.lookAt.fromArray(lookPoint(cam, fl.ob, { foot: fl.foot, height: f.height, scale: k }));
    if (fl.pivot) pose(fl, fl.w || 0);
  }
  // The flat and its shadow a share w of the way from where it was put to where it stands.
  function pose(fl, w) {
    const a = fl.f.foot, b = fl.foot, k = 1 + (fl.k - 1) * w, at = (i) => a[i] + (b[i] - a[i]) * w;
    fl.w = w;
    fl.pivot.position.set(at(0), at(1), at(2) + fl.index * 0.002); // flats sharing a foot row never z-fight
    fl.pivot.scale.setScalar(k);
    fl.shadow.position.set(at(0), fl.ground[0] + (fl.ground[1] - fl.ground[0]) * w + SHADOW_LIFT, at(2));
    fl.shadow.scale.set(fl.print[0] * k * 1.15, 1, fl.print[1] * k * 1.15);
  }
  const flats = [], objects = [];
  s.objects.forEach((ob, index) => {
    const padded = up[index] ? stand[index] : null;
    // at its median depth in the depth room, else at its own foot's row (its rim's lower edge dips under the floor)
    const f = padded ? flatOf(cam, padded, fit ? flatDistance(cam, fit, o.depth, ob, filled) : rowDistance(cam, ob.box[3])) : null;
    const item = { index, label: ob.label, kind: ob.kind, part: f ? 'stand' : lies[index] ? 'floor' : 'wall', position: new THREE.Vector3(), lookAt: new THREE.Vector3() };
    objects.push(item);
    if (f) {
      const w = f.right - f.left, fl = { index, ob, f, padded, item, height: f.height, print: [w, Math.min(0.35 * w, 0.5 * f.height)] };
      flats.push(fl);
      place(fl, slideScale(cam, f.foot, walk, 0));
      return;
    }
    const cx = (ob.box[0] + ob.box[2]) / 2, cy = (ob.box[1] + ob.box[3]) / 2;
    item.position.fromArray(lies[index] ? imageToFloor(cam, cx, clamp(cy, cam.wallRow + 1, 1000)) : planePoint(cam, cx, cy, cam.farDist) || [0, cam.eye, -cam.farDist]);
    item.lookAt.fromArray(lookPoint(cam, ob, null, terrain, filled));
  });

  const group = new THREE.Group();
  group.name = 'diorama';
  const standing = flats.map((fl) => fl.index), cut = o.lineArt ? paperCut(img, iw, ih) : null;
  const others = s.objects.filter((ob, i) => standing.indexOf(i) < 0 && CANVAS.indexOf(ob.kind) < 0).map((ob) => (ob.kind === 'celestial' ? halo(ob.box) : shapeOf(ob)));
  // a drawing's flats are cut out of their paper, so only their silhouettes leave holes (the paper around stays as drawn)
  const masks = flats.map((fl) => maskTexture(shapeOf(fl.ob), fl.padded, A, cut));
  for (const m of masks) if (m) owned.push(m);
  const holes = flats.map((fl, k) => (cut && masks[k] ? { canvas: masks[k].image, box: fl.padded } : shapeOf(fl.ob)));
  const tex = plateTextures(img, holes, others, o.lineArt ? 0 : STROKES);
  for (const t of [tex.plate, tex.beyond]) if (t) owned.push(t);
  const back = tex.plate || map, beyond = tex.beyond || back, I = new THREE.Matrix4();

  // The room: the floor to the wall in front and out to the dome everywhere else, the back wall, and the dome around
  // all of it (radius R about the painting camera, enclosing the wall's corners). The depth room adds the relief, the
  // depth behind the flats filled in, so the floor and wall planes only show past its edges and through its cuts.
  const wallZ = grid ? ext.far * WALL_BACK : ext.far;
  const R = 1.2 * Math.sqrt(ext.width * ext.width / 4 + ext.height * ext.height + ext.far * ext.far);
  const floorGeo = new THREE.PlaneGeometry(2 * R, wallZ + R);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, grid ? -SKIRT : 0, (R - wallZ) / 2);
  group.add(new THREE.Mesh(floorGeo, paintMaterial(back, paint, cam, I, { part: 'floor', R, beyond })));
  const wallGeo = new THREE.PlaneGeometry(ext.width, ext.height);
  wallGeo.translate(0, ext.height / 2, -wallZ);
  group.add(new THREE.Mesh(wallGeo, paintMaterial(back, paint, cam, I, { beyond })));
  if (grid) {
    const reliefGeo = new THREE.BufferGeometry();
    reliefGeo.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
    reliefGeo.setIndex(grid.index);
    group.add(new THREE.Mesh(reliefGeo, paintMaterial(back, paint, cam, I, { side: THREE.DoubleSide, beyond })));
  }
  const domeGeo = new THREE.SphereGeometry(R, 48, 24);
  domeGeo.translate(cam.position[0], cam.position[1], cam.position[2]);
  const dome = new THREE.Mesh(domeGeo, paintMaterial(back, paint, cam, I, { part: 'dome', side: THREE.BackSide, beyond }));
  group.add(dome);

  // The flats: each its own crop of the picture (every vertex carries its image point where the flat was first put,
  // through the painting camera, so from there it is the picture, and turned or slid it keeps its pixels), cut out by
  // its mask (and, in a drawing, out of its paper), with a soft shadow on the ground at its foot.
  const shadowTex = shadowTexture(), shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  owned.push(shadowGeo, shadowMat);
  if (shadowTex) owned.push(shadowTex);
  for (const fl of flats) {
    const { f, padded } = fl, mask = masks[flats.indexOf(fl)];
    const geo = new THREE.PlaneGeometry(f.right - f.left, f.height);
    geo.translate((f.left + f.right) / 2, f.height / 2, 0);
    const pos = geo.attributes.position, uvq = new Float32Array(3 * pos.count);
    for (let k = 0; k < pos.count; k++) {
      const p = [f.foot[0] + pos.getX(k), f.foot[1] + pos.getY(k), f.foot[2]], xy = project(cam, p) || [500, 500];
      const q = cam.back[0] * (cam.position[0] - p[0]) + cam.back[1] * (cam.position[1] - p[1]) + cam.back[2] * (cam.position[2] - p[2]); // its depth
      uvq.set([xy[0] / 1000 * q, (1 - xy[1] / 1000) * q, q], 3 * k);
    }
    geo.setAttribute('uvq', new THREE.BufferAttribute(uvq, 3));
    const box = new THREE.Vector4(padded[0] / 1000, 1 - padded[3] / 1000, padded[2] / 1000, 1 - padded[1] / 1000); // UV, bottom-up
    fl.mesh = new THREE.Mesh(geo, paintMaterial(map, paint, cam, I, { mask, box, side: THREE.DoubleSide }));
    fl.pivot = new THREE.Group();
    fl.pivot.add(fl.mesh);
    fl.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    group.add(fl.pivot, fl.shadow);
    place(fl, fl.k);
  }

  // Every frame each flat turns about its vertical axis to the eye (tip.js turnYaw: not at all at the painting
  // camera, no further than its cap), eased, or at once on the first frame and with reduced motion. As the eye leaves
  // the painting camera (tip.js turnWeight) the slid flats slide out to where they stand and the shadows fade in, so
  // from that camera the view is the picture. A flat that hides the focus (focus()) from the eye fades to a screen
  // door (tip.js hides). It runs as the dome is drawn, first of all (renderOrder), with that frame's camera.
  let disposed = false, calm = false, lastT = 0, focusAt = null;
  const eye = new THREE.Vector3();
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  dome.onBeforeRender = (renderer, sc, camera) => {
    const now = performance.now(), a = calm || !lastT ? 1 : 1 - Math.exp(-clamp((now - lastT) / 1000, 0, 0.1) * TURN_RATE);
    lastT = now;
    eye.setFromMatrixPosition(camera.matrixWorld);
    const e = [eye.x, eye.y, eye.z], w = turnWeight(cam, e);
    shadowMat.opacity = w;
    for (const fl of flats) {
      if (fl.k !== 1 && fl.w !== w) pose(fl, w);
      if (fl.mesh.visible) { // a model stands in its place, and does not turn
        const r = fl.mesh.rotation, p = fl.pivot.position, at = [p.x, p.y, p.z], u = fl.mesh.material.uniforms.uFade;
        r.y += wrap(turnYaw(cam, at, e, fl.cap) - r.y) * a;
        fl.shadow.rotation.y = r.y;
        u.value += ((focusAt && hides(fl.f, at, r.y, fl.pivot.scale.x, e, focusAt) ? FADE : 0) - u.value) * a;
      }
      fl.pivot.updateMatrixWorld(true);
      fl.shadow.updateMatrixWorld();
    }
  };
  // Nothing else moves (the per-kind motion read as cut-outs warping). reducedMotion: the flats turn at once.
  function update(dt, reducedMotion) { calm = !!reducedMotion; }
  // p: the point the view is turned to (a Vector3: a stop's lookAt), whose hiding flats fade, or null for none.
  // shortcut: a 3D model in the way does not fade; give its materials a dither too if one is ever seen hiding a stop.
  function focus(p) { focusAt = p && fin(p.x) && fin(p.y) && fin(p.z) ? [p.x, p.y, p.z] : null; }

  // A model stands in for its flat: turned by MODEL_YAW to face the painting camera, centred on the flat's footprint,
  // scaled to the flat's height with its feet on the flat's foot (all times the flat's slide scale). Resolves true once
  // it stands; any failure keeps the flat and resolves false.
  function loadModel(fl) {
    return import('three/examples/jsm/loaders/GLTFLoader.js').then((mod) => new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => { late = true; reject(new Error('model timeout')); }, MODEL_MS);
      new mod.GLTFLoader().load(fl.ob.model_url, (gltf) => {
        const model = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (late) { if (model) disposeTree(model); return; }
        clearTimeout(timer);
        if (model) resolve(model); else reject(new Error('empty model'));
      }, undefined, (e) => { clearTimeout(timer); reject(e); });
    })).then((model) => {
      if (disposed) { disposeTree(model); return false; }
      // Unlit, like the painted room: Tripo's metallic PBR has nothing to reflect here and renders near black. The
      // colour texture is shown as stored (linear), the way the painting's own texture is.
      model.traverse((n) => {
        if (!n.isMesh) return;
        const olds = Array.isArray(n.material) ? n.material : [n.material];
        const made = olds.map((m) => {
          const map = m && m.map ? m.map : null;
          if (map) map.encoding = THREE.LinearEncoding;
          const flat = new THREE.MeshBasicMaterial({ map: map, color: map || !(m && m.color) ? 0xffffff : m.color.getHex(), side: THREE.DoubleSide,
            vertexColors: !!(n.geometry && n.geometry.attributes && n.geometry.attributes.color), transparent: !!(m && m.transparent), alphaTest: (m && m.alphaTest) || 0 });
          if (m) m.dispose();
          return flat;
        });
        n.material = Array.isArray(n.material) ? made : made[0];
      });
      const holder = new THREE.Group();
      model.rotation.y = MODEL_YAW;
      holder.add(model);
      const box = new THREE.Box3().setFromObject(holder), size = box.getSize(new THREE.Vector3());
      if (!(size.y > 1e-6) || !fin(size.y)) { disposeTree(holder); return false; }
      const k = fl.height / size.y;
      holder.scale.setScalar(k);
      holder.position.set(-(box.min.x + box.max.x) / 2 * k, -box.min.y * k, -(box.min.z + box.max.z) / 2 * k);
      fl.pivot.add(holder);
      fl.mesh.visible = false;
      // It does not turn as a flat does, so it slides clear of the walk by its footprint too; its shadow takes that shape.
      fl.print = [size.x * k, size.z * k];
      fl.shadow.rotation.y = 0;
      place(fl, slideScale(cam, fl.f.foot, walk, Math.hypot(size.x, size.z) * k / 2));
      return true;
    }).catch(() => false); // the flat stays
  }
  const withModel = flats.filter((fl) => okModel(fl.ob.model_url));
  // ready: the indices of the objects whose model now stands, once every model has loaded or fallen back
  const ready = Promise.all(withModel.map(loadModel)).then((ok) => withModel.filter((fl, k) => ok[k]).map((fl) => fl.index));

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (group.parent) group.parent.remove(group);
    disposeTree(group);
    for (const t of owned) t.dispose();
  }

  return {
    group,
    // far: a view anywhere inside sees the whole room with this far plane (the dome's radius, twice over)
    paintingCamera: { position: v3(cam.position), lookAt: v3(cam.lookAt), fov: cam.fov, aspect: cam.aspect, near: 0.1, far: 2 * R },
    eyeHeight: cam.eye,
    relief: !!grid, // the depth room was built (else the plain planes)
    pathAt,
    groundAt, // (x, z) -> the ground's height there: the relief's in the depth room, else 0
    // [{index, label, kind, part, position, lookAt}]: part 'stand' (a flat or model), 'floor' (lying on it) or 'wall'
    // (painted there); position where it stands or lies (a flat's foot), lookAt where the view faces it (a flat's or
    // model's centre, a backdrop object's spot on the back wall); both Vector3s, final once ready
    objects,
    update,
    focus,
    ready,
    dispose,
  };
}
