// The inside view's world (src/join/inside.js builds it when a phone steps inside): a Tour-into-the-Picture diorama of
// a validated scene, on tip.js's geometry. The floor, the back wall and one standing flat per object all sample the
// painting by projective texturing through the painting camera, so from that camera the world is exactly the picture
// and from anywhere else a paper theatre with depth. Each flat's pixels are blurred out of the floor and wall behind
// it (the "plate"), so walking past an object does not show it twice. With a depth picture (opts.depth) whose floor
// fits TIP's, the floor and wall become one relief mesh (the depth room, tip.js), the flats stand at their depth and
// the walk follows the terrain; without one, or when the fit fails, the plain floor and wall planes. An object's
// optional model_url (a GLB) stands in for its flat once it loads. No ?. or ??: the phone's lazy inside chunk imports
// this file (iOS 13).
import * as THREE from 'three';
import { validateScene } from '../shared/scene-validate.js';
import { pathPoints } from '../host/maskDepth.js';
import {
  BACKDROP, FLOOR_KINDS, paintingCamera, imageToFloor, planePoint, padBox, flatOf, extentOf,
  fitDepth, fillDepth, flatDistance, reliefGrid, terrainPath, shapeOf,
} from './tip.js';

const MAX_TEX = 2048;  // plate pixels on the long side
const MASK_PX = 256;   // a flat's mask canvas on its long side
const RIM = 6;         // the cut-out's paper border, in image units across (0.6% of the picture's width)
const BLUR_PX = 24;    // the plate's fill is the picture shrunk to this width and stretched back: a blur iOS 13 draws
const MODEL_MS = 20000;
const PATH_K = 128;    // the walk is sampled this many steps along t
// Under the relief the plain floor stays as a skirt (seen past the picture's edges and through cut silhouettes),
// dropped clear of the relief's noise, and the plain wall stays behind its farthest points.
const SKIRT = 0.25, WALL_BACK = 1.05;
const FLAT_FAR = 0.95; // a flat whose depth reaches this share of the wall's distance stays painted on the relief
// shortcut: Tripo's GLBs face +x by its default export orientation (not checked by eye yet); this turns +x to +z,
// toward the painting camera. Check one real model and flip the sign if it shows its back.
export const MODEL_YAW = -Math.PI / 2;
const okModel = (u) => typeof u === 'string' && u.length <= 300 && /^(https:\/\/\S+|\/(?![/\\])\S*)$/.test(u); // README, Scene

const VERT = `
uniform mat4 uRest;
varying vec3 vRest;
void main() {
  vRest = (uRest * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// uv = the rest position projected through the painting camera, so a moving flat carries its own pixels. uv is clamped,
// so everything outside the picture's frame stretches its edges: the floor nearer than the picture's foot shows its
// bottom row, and the dome (the sky beside and behind the camera) the border colours, never a void.
const FRAG = `
uniform sampler2D uMap;
uniform mat4 uPaint;
uniform vec3 uCam;
uniform float uNear;
uniform float uGlow;
varying vec3 vRest;
#ifdef CUT
uniform sampler2D uMask;
uniform vec4 uBox;
#endif
void main() {
  vec3 q = vRest;
#ifdef FLOOR
  q.z = min(q.z, -uNear);
#endif
#ifdef DOME
  vec3 d = q - uCam;
  d.z = min(d.z, -0.05 * length(d));
  q = uCam + d;
#endif
  vec4 p = uPaint * vec4(q, 1.0);
  vec2 uv = clamp(p.xy / max(p.w, 0.0001) * 0.5 + 0.5, 0.0, 1.0);
#ifdef CUT
  vec2 m = (uv - uBox.xy) / (uBox.zw - uBox.xy);
  if (m.x < 0.0 || m.x > 1.0 || m.y < 0.0 || m.y > 1.0 || texture2D(uMask, m).r < 0.5) discard;
#endif
  gl_FragColor = vec4(texture2D(uMap, uv).rgb * (1.0 + uGlow), 1.0);
}`;

const fin = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function trace(ctx, pts, ox, oy, sx, sy) {
  ctx.beginPath();
  pts.forEach((p, k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, (p[0] - ox) * sx, (p[1] - oy) * sy));
  ctx.closePath();
}

// The flat's alpha: its outline plus the rim, white on black, over its padded box (A keeps the pixels square).
function maskTexture(shape, box, A) {
  if (typeof document === 'undefined') return null;
  const bw = box[2] - box[0], bh = (box[3] - box[1]) / A, k = MASK_PX / Math.max(bw, bh);
  const c = canvasOf(Math.max(2, Math.round(bw * k)), Math.max(2, Math.round(bh * k))), ctx = c.getContext('2d');
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * RIM * k; ctx.lineJoin = 'round';
  trace(ctx, shape, box[0], box[1], k, k / A);
  ctx.fill(); ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

// The picture with every standing object (and its rim) filled with a blur, for the floor and the wall. null when the
// image cannot be read back (no DOM, no size, or a cross-origin canvas, which WebGL would refuse as well).
function plateTexture(img, shapes) {
  if (!shapes.length || !img || typeof document === 'undefined') return null;
  try {
    const nw = img.naturalWidth || img.videoWidth || img.width, nh = img.naturalHeight || img.videoHeight || img.height;
    if (!(nw > 0 && nh > 0)) return null;
    const k = Math.min(1, MAX_TEX / Math.max(nw, nh)), w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
    const c = canvasOf(w, h), ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    ctx.getImageData(0, 0, 1, 1); // throws on a tainted canvas
    const small = canvasOf(BLUR_PX, Math.max(1, Math.round(BLUR_PX * h / w))), blur = canvasOf(w, h);
    small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
    blur.getContext('2d').drawImage(small, 0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = ctx.createPattern(blur, 'no-repeat');
    ctx.lineWidth = 2 * RIM * w / 1000; ctx.lineJoin = 'round';
    for (const shape of shapes) { trace(ctx, shape, 0, 0, w / 1000, h / 1000); ctx.fill(); ctx.stroke(); }
    small.width = 0; blur.width = 0;
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8; // the far floor is seen at a grazing angle; the renderer clamps this to what the GPU has
    return t;
  } catch (e) {
    return null;
  }
}

// o.part: 'floor', 'dome' or a flat (o.mask set); anything else is the back wall.
function paintMaterial(map, paint, cam, rest, o) {
  const defines = {};
  if (o.part === 'floor') defines.FLOOR = '';
  if (o.part === 'dome') defines.DOME = '';
  if (o.mask) defines.CUT = '';
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map }, uPaint: { value: paint }, uRest: { value: rest }, uCam: { value: v3(cam.position) }, uNear: { value: cam.nearDist },
      uGlow: { value: 0 }, uMask: { value: o.mask || null }, uBox: { value: o.box || new THREE.Vector4(0, 0, 1, 1) },
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
// opts.depth: an optional depth picture, {data: Uint8Array, w, h} (README, Inside view).
export function buildDiorama(scene, texture, opts) {
  const s = validateScene(scene), o = opts || {};
  const img = texture && texture.image;
  const iw = img ? img.naturalWidth || img.videoWidth || img.width : 0, ih = img ? img.naturalHeight || img.videoHeight || img.height : 0;
  const A = clamp(fin(o.aspect) && o.aspect > 0 ? o.aspect : iw > 0 && ih > 0 ? iw / ih : 4 / 3, 0.25, 4);
  const cam = paintingCamera(s, A), ext = extentOf(cam);
  const fit = o.depth ? fitDepth(cam, s, o.depth) : null; // null for no depth, a bad one, or one whose floor does not fit
  const owned = [];
  let map = texture && texture.isTexture ? texture : null;
  if (!map) { map = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); map.needsUpdate = true; owned.push(map); }

  const lens = new THREE.PerspectiveCamera(cam.fov, cam.aspect, 0.1, ext.far * 4);
  lens.position.copy(v3(cam.position));
  lens.lookAt(v3(cam.lookAt));
  lens.updateMatrixWorld(true);
  const paint = new THREE.Matrix4().multiplyMatrices(lens.projectionMatrix, lens.matrixWorldInverse);

  // Sort every object: painted on the wall, lying on the floor, or standing as a flat. In the depth room a flat stands
  // at its median depth (one as far as the wall stays painted on the relief), never behind the relief over its
  // outline; the relief's depth (filled) is the picture's with the flats' outlines filled and the backdrop on the wall.
  const stand = s.objects.map((ob) => (BACKDROP.indexOf(ob.kind) < 0 && FLOOR_KINDS.indexOf(ob.kind) < 0 ? padBox(ob.box, A, RIM) : null));
  const up = s.objects.map((ob, i) => !!stand[i] && stand[i][3] > cam.wallRow + 1 && !(fit && flatDistance(cam, fit, o.depth, ob) >= FLAT_FAR * cam.farDist));
  const filled = fit ? fillDepth(o.depth, s.objects.filter((ob, i) => up[i]).map(shapeOf), s.objects.filter((ob) => BACKDROP.indexOf(ob.kind) >= 0).map(shapeOf)) : null;
  const flats = [], objects = [];
  s.objects.forEach((ob, index) => {
    const [x0, y0, x1, y1] = ob.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const padded = up[index] ? stand[index] : null;
    const f = padded ? flatOf(cam, padded, fit ? flatDistance(cam, fit, o.depth, ob, filled) : undefined) : null; // undefined: at its foot row
    let at;
    if (f) {
      at = v3(f.foot);
      flats.push({ index, ob, f, padded, height: f.height });
    } else if (FLOOR_KINDS.indexOf(ob.kind) >= 0) {
      at = v3(imageToFloor(cam, cx, clamp(cy, cam.wallRow + 1, 1000)));
    } else {
      at = v3(planePoint(cam, cx, cy, cam.farDist) || [0, cam.eye, -cam.farDist]);
    }
    objects.push({ index, label: ob.label, kind: ob.kind, position: at });
  });

  const group = new THREE.Group();
  group.name = 'diorama';
  const plate = plateTexture(img, flats.map((fl) => shapeOf(fl.ob)));
  if (plate) owned.push(plate);
  const back = plate || map, I = new THREE.Matrix4();

  // The room: the floor to the wall in front and out to the dome everywhere else, the back wall, and the dome around
  // all of it (radius R about the painting camera, enclosing the wall's corners). The depth room adds the relief, the
  // depth behind the flats filled in, so the floor and wall planes only show past its edges and through its cuts.
  const grid = filled ? reliefGrid(cam, fit, filled) : null;
  const wallZ = grid ? ext.far * WALL_BACK : ext.far;
  const R = 1.2 * Math.sqrt(ext.width * ext.width / 4 + ext.height * ext.height + ext.far * ext.far);
  const floorGeo = new THREE.PlaneGeometry(2 * R, wallZ + R);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, grid ? -SKIRT : 0, (R - wallZ) / 2);
  group.add(new THREE.Mesh(floorGeo, paintMaterial(back, paint, cam, I, { part: 'floor' })));
  const wallGeo = new THREE.PlaneGeometry(ext.width, ext.height);
  wallGeo.translate(0, ext.height / 2, -wallZ);
  group.add(new THREE.Mesh(wallGeo, paintMaterial(back, paint, cam, I, {})));
  if (grid) {
    const reliefGeo = new THREE.BufferGeometry();
    reliefGeo.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
    reliefGeo.setIndex(grid.index);
    group.add(new THREE.Mesh(reliefGeo, paintMaterial(back, paint, cam, I, { side: THREE.DoubleSide })));
  }
  const domeGeo = new THREE.SphereGeometry(R, 48, 24);
  domeGeo.translate(cam.position[0], cam.position[1], cam.position[2]);
  group.add(new THREE.Mesh(domeGeo, paintMaterial(back, paint, cam, I, { part: 'dome', side: THREE.BackSide })));

  for (const fl of flats) {
    const { f, padded } = fl, mask = maskTexture(shapeOf(fl.ob), padded, A);
    if (mask) owned.push(mask);
    fl.pivot = new THREE.Group();
    fl.pivot.position.set(f.foot[0], f.foot[1], f.foot[2] + fl.index * 0.002); // flats sharing a foot row never z-fight
    fl.pivot.updateMatrix();
    const geo = new THREE.PlaneGeometry(f.right - f.left, f.height);
    geo.translate((f.left + f.right) / 2, f.height / 2, 0);
    const box = new THREE.Vector4(padded[0] / 1000, 1 - padded[3] / 1000, padded[2] / 1000, 1 - padded[1] / 1000); // UV, bottom-up
    fl.material = paintMaterial(map, paint, cam, fl.pivot.matrix.clone(), { mask, box, side: THREE.DoubleSide });
    fl.mesh = new THREE.Mesh(geo, fl.material);
    fl.pivot.add(fl.mesh);
    group.add(fl.pivot);
  }

  // The walk: the TV's own curve through maskDepth's path points, then through the painting camera onto the floor, or
  // onto the relief's terrain (its filled depth, so behind an object the walk is on the ground there).
  const pts = pathPoints(s, () => 0, 8);
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)), false, 'catmullrom', 0.5);
  const tmp = new THREE.Vector3(), uvs = [];
  for (let k = 0; k <= PATH_K; k++) { curve.getPoint(k / PATH_K, tmp); uvs.push([tmp.x, tmp.y]); }
  const walk = terrainPath(cam, grid ? fit : null, filled, uvs).map(v3);
  const floorAt = (t) => { const f = t * PATH_K, k = Math.min(PATH_K - 1, Math.floor(f)); return walk[k].clone().lerp(walk[k + 1], f - k); };
  function pathAt(t) {
    const tt = clamp(fin(t) ? t : 0, 0, 1), forward = floorAt(Math.min(1, tt + 0.01)).sub(floorAt(Math.max(0, tt - 0.01)));
    forward.y = 0;
    if (forward.lengthSq() < 1e-12) forward.set(0, 0, -1); else forward.normalize();
    return { position: floorAt(tt), forward };
  }

  let disposed = false;
  // Still pictures: no flat or model moves (the per-kind motion read as cut-outs warping); kept for the API's shape.
  function update() {}

  // A model stands in for its flat: turned by MODEL_YAW to face the painting camera, centred on the flat's footprint,
  // scaled to the flat's height with its feet on the flat's foot. Resolves true once it stands; any failure keeps the
  // flat and resolves false.
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
    objects,
    update,
    ready,
    dispose,
  };
}
