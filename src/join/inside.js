// The inside view (a lazy chunk): the TV's picture folded into a walkable diorama (../world/diorama.js) and seen
// first person from this phone's figure. main.js imports it on "Step inside", hands it the pad's input setters and
// routes the host's {t:'world'} and {t:'pos'} here. It opens on the picture exactly as painted (the diorama's
// painting camera), then glides down into the figure's eyes. No ES2020 syntax (?. ??): iOS 13 must parse it.
import * as THREE from 'three';
import { buildDiorama } from '../world/diorama.js';
import { sheetTexture, setFrame, textSprite, shadowTexture, ASPECT, WALK, IDLE } from '../host/figures.js';
import { MIN_T } from '../shared/protocol.js';
import './inside.css';

const MAX_TEX = 2048, MAX_DPR = 1.5;
const HFOV = 64; // degrees across the screen whatever its shape, so a portrait phone still sees a room, not a slot
const PITCH_MAX = 50 * Math.PI / 180;
const HOLD_S = 0.6, GLIDE_S = 1.8; // the painting as painted, then the step inside
const ASK_MS = 2500, ASKS = 4; // ask the screen again if no world came (a send lost to the rate headroom, a busy host)
const FIG_H = 1.08, LANE = 0.35; // other figures: height and side step off the path line, in eye heights
const TAG_H = 0.09; // name tags keep one size on screen (about 4% of its height), near or far
const WALK_RATE = 80; // walk frames per path length: the TV's 8 a second at 0.10 path lengths a second
const LOOK_MS = 20000, LOOK_TURN = 5 * Math.PI / 180; // looking around counts as activity: one 'look' per 20 s at most
const UNTIL = 'This view opens by itself when the TV shows a picture you can enter.';
const BACK_HINT = 'Go back to the pad, or wait here for the next picture.';
const BUILDING = 'Building the world…', ASKING = 'Asking the screen for the picture.';
const END_HINT = 'End of the path · turn around';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (x) => typeof x === 'number' && isFinite(x);
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const wrap = (r) => r - Math.PI * 2 * Math.floor((r + Math.PI) / (Math.PI * 2)); // to -PI..PI
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isPress = (e) => e.key === ' ' || e.key === 'Enter';
const xyz = (p, out) => (Array.isArray(p) ? out.fromArray(p) : out.copy(p)); // the diorama may hand [x, y, z] or a Vector3
// The host sends the scene's own image_url: http(s) or site-relative, never data: (README, the inside view).
const okUrl = (u) => typeof u === 'string' && u.length <= 2048 && /^(https?:\/\/|\/(?!\/))/i.test(u);
// depth_url as the scene contract keeps it: https or site-relative, at most 300 characters, no whitespace (README, Scene)
const okDepthUrl = (u) => typeof u === 'string' && u.length <= 300 && /^(https:\/\/\S+|\/(?![/\\])\S*)$/.test(u);
const okColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : tok('--cream'));
const DEPTH_PX = 512, DEPTH_MS = 8000; // the depth picture's long side at most; a slow one is not waited for longer

function loadImage(url) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Blob images are cross-origin; WebGL needs them CORS-clean
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = url;
  });
}
// The picture redrawn at power-of-two sides (iOS 13 is WebGL1: mipmaps on the receding floor need them), at most
// `max` on a side; the UVs stay 0..1, so the stretch never shows. An SVG without a size still rasterises.
function imageTexture(img, max, aniso) {
  const nw = img.naturalWidth, nh = img.naturalHeight, aspect = clamp(nw > 0 && nh > 0 ? nw / nh : 4 / 3, 0.25, 4);
  const long = Math.min(max, Math.max(nw, nh) || 1024), pot = (n) => clamp(Math.pow(2, Math.round(Math.log2(n))), 1, max);
  const c = document.createElement('canvas');
  c.width = pot(aspect >= 1 ? long : long * aspect); c.height = pot(aspect >= 1 ? long / aspect : long);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = Math.min(4, aniso);
  return { tex, aspect };
}
// The scene's depth picture as {data, w, h} (one byte per pixel from its red channel, rows top first), or null when
// there is none, it fails, it is slow, or the canvas will not read it back (a cross-origin PNG without CORS).
function loadDepth(url) {
  if (!okDepthUrl(url)) return Promise.resolve(null);
  const read = loadImage(url).then((img) => {
    const k = Math.min(1, DEPTH_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    if (!(w >= 2 && h >= 2)) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = px[4 * i];
    c.width = 0;
    return { data, w, h };
  }).catch(() => null);
  return Promise.race([read, new Promise((ok) => setTimeout(() => ok(null), DEPTH_MS))]);
}
// A scene without what enrichment adds (depth_url, each object's model_url): equal for a richer copy of one world.
function bare(scene) {
  const s = Object.assign({}, scene);
  delete s.depth_url;
  s.objects = (Array.isArray(s.objects) ? s.objects : []).map((o) => { const c = Object.assign({}, o); delete c.model_url; return c; });
  return JSON.stringify(s);
}
// The one calm line for what a richer world brought, or '' when it did not take (a depth whose floor did not fit, a
// model that fell back to its flat). loaded: the indices of the objects whose model stands (the diorama's ready).
function gained(prev, next, d, loaded) {
  if (next.depth_url && next.depth_url !== prev.depth_url && d.relief) return 'The world gained depth';
  const objs = Array.isArray(next.objects) ? next.objects : [], was = Array.isArray(prev.objects) ? prev.objects : [];
  for (const i of Array.isArray(loaded) ? loaded : []) {
    if (objs[i] && objs[i].model_url !== (was[i] && was[i].model_url)) return 'A 3D ' + String(objs[i].label).slice(0, 40) + ' arrived';
  }
  return '';
}

const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4l-8 8 8 8"/></svg>';
const FORWARD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l7-7 7 7M5 19l7-7 7 7"/></svg>';
const U_TURN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21V10a4 4 0 0 1 8 0v7M12 13l4 4 4-4"/></svg>';
const HTML = `<canvas class="in-gl" aria-hidden="true"></canvas>
<div class="in-top">
  <button type="button" class="in-back">${CHEV_L}Back</button>
  <button type="button" class="in-tilt" aria-pressed="false" hidden>Look by moving your phone</button>
</div>
<p class="in-hint gone" role="status">Drag to look around</p>
<div class="in-card" role="status" aria-live="polite"><h2></h2><p></p><button type="button" class="primary in-out" hidden>Back to the pad</button></div>
<div class="in-pad">
  <button type="button" class="in-round in-walk" aria-label="Hold to walk forward">${FORWARD}</button>
  <button type="button" class="verb in-verb" aria-disabled="true">Walk to something</button>
  <button type="button" class="in-round in-turn" aria-label="Turn around">${U_TURN}</button>
</div>`;

// ctx: {setLx(v), setA(v)} (the pad's own input, so the heartbeat and release rules are the pad's), ask() (sends
// {t:'panel', kind:'inside', value:1}), reassert() (value 2: the host resends the world only if it changed), look()
// (sends {t:'panel', kind:'look', value:1}, activity for the idle kick; returns whether it went), back() (main leaves:
// sends value 0 and calls close), toast(text). Returns {msg(m), input(lx, a), again(), close()}.
export function open(ctx) {
  const root = document.createElement('section');
  root.className = 'inside';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Inside the picture');
  root.innerHTML = HTML;
  document.body.appendChild(root);
  document.body.classList.add('inside');
  const q = (s) => root.querySelector(s);
  const canvas = q('.in-gl'), card = q('.in-card'), verb = q('.in-verb'), tiltBtn = q('.in-tilt'), hint = q('.in-hint');
  const walkBtn = q('.in-walk'), turnBtn = q('.in-turn');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let closed = false, raf = 0, last = 0, seq = 0, worldKey = '', world = null, asks = 0, askT = 0, tiltT = 0, hintT = 0;
  let born = 0, yaw = null, dragYaw = 0, pitch = 0, fpFov = 60, tilt = null, curLx = 0;
  // heading: the way the camera faces along the path (+1 toward increasing t), apart from the figure's own facing,
  // so standing still you can turn round; Walk walks that way. null until the first pos after a world is built.
  let heading = null, endShown = false, lookedAt = -Infinity;
  const me = { t: 0.16, shown: 0.16, facing: 1, seen: false };
  const dir = () => (heading === null ? me.facing : heading);
  const others = new Map(); // pid -> a paper figure

  function say(head, text, failed) {
    card.hidden = false;
    card.classList.toggle('busy', !failed);
    card.querySelector('h2').textContent = head;
    card.querySelector('p').textContent = text;
    q('.in-out').hidden = !failed;
  }
  function hintSay(text, ms) {
    hint.textContent = text;
    hint.classList.remove('gone'); clearTimeout(hintT); hintT = setTimeout(() => hint.classList.add('gone'), ms);
  }
  // Looking around (a drag that moved, a tilt that turned) keeps the seat from the idle kick, at most once per LOOK_MS.
  function looked() {
    const now = performance.now();
    if (now - lookedAt >= LOOK_MS && ctx.look()) lookedAt = now;
  }

  let renderer = null;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (e) { renderer = null; }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(tok('--prussian-deep'));
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000), paintCam = new THREE.PerspectiveCamera();
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });

  function size() {
    if (!renderer) return;
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    fpFov = clamp(2 * Math.atan(Math.tan(HFOV * Math.PI / 360) / camera.aspect) * 180 / Math.PI, 50, 90);
    camera.updateProjectionMatrix();
  }
  size();
  addEventListener('resize', size);

  // ---- the world: one diorama per {t:'world'}; a repeat of the same one (a rejoin, a rollover) is ignored ----
  function clearWorld() {
    if (!world) return;
    scene.remove(world.d.group);
    try { world.d.dispose(); } catch (e) {}
    world.tex.dispose();
    world = null;
  }
  function onWorld(m) {
    const key = JSON.stringify([m.scene, m.image]);
    if (key === worldKey) return;
    worldKey = key; clearTimeout(askT);
    const gen = ++seq;
    // The world shown, only richer (a depth picture or a 3D model arrived): rebuilt behind it on the same picture
    // texture and swapped in with no glide, the heading and the look kept.
    const richer = !!(world && m.scene && m.image === world.image && bare(m.scene) === bare(world.scene));
    if (!richer) clearWorld();
    if (!renderer) return; // the no-WebGL card stays
    if (!m.scene || !okUrl(m.image)) {
      return say(typeof m.reason === 'string' && m.reason ? m.reason.slice(0, 120) : 'This picture can’t be entered yet', UNTIL, true);
    }
    if (!richer) say(BUILDING, 'Folding the picture into a little stage.', false);
    let tex = richer ? world.tex : null, aspect = richer ? world.aspect : 0, loaded = [];
    const picture = richer ? null : loadImage(m.image).then(null, () => { throw new Error('image'); });
    Promise.all([picture, loadDepth(m.scene.depth_url)]) // the card waits for both; a depth that fails is just null
      .then((got) => {
        if (gen !== seq) return null;
        if (!richer) {
          const t = imageTexture(got[0], Math.min(MAX_TEX, renderer.capabilities.maxTextureSize), renderer.capabilities.getMaxAnisotropy());
          tex = t.tex; aspect = t.aspect;
        }
        return buildDiorama(m.scene, tex, { aspect, depth: got[1] }); // it validates the scene itself
      })
      .then((d) => (d ? Promise.resolve(d.ready).then((ids) => { loaded = ids; return d; }) : null)) // its 3D models load, or fall back to flats, first
      .then((d) => {
        if (!d) return;
        if (gen !== seq) { d.dispose(); if (!richer) tex.dispose(); return; }
        const was = world;
        if (richer) { scene.remove(was.d.group); try { was.d.dispose(); } catch (e) {} } // its texture is the new world's
        world = { d, tex, aspect, scene: m.scene, image: m.image };
        scene.add(d.group);
        const box = new THREE.Box3().setFromObject(d.group), r = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length();
        camera.near = Math.max(0.001, d.eyeHeight * 0.02); camera.far = Math.max(camera.near * 100, r * 3);
        camera.updateProjectionMatrix();
        if (richer) {
          const line = gained(was.scene, m.scene, d, loaded);
          if (line) hintSay(line, 5000);
          return;
        }
        born = performance.now(); yaw = null; heading = null;
        card.hidden = true;
        hintSay('Drag to look around', 6000);
      })
      .catch((e) => {
        if (!richer && tex && !(world && world.tex === tex)) tex.dispose();
        if (gen !== seq || richer) return; // a richer world that failed: the one shown stays
        if (e && e.message === 'image') say('The picture didn’t load on this phone', BACK_HINT, true);
        else say('This world didn’t build on this phone', BACK_HINT, true);
      });
  }
  // The world comes in answer to ask(); if the screen stays silent, ask again a few times, then say so (and still
  // take a world that arrives later).
  function ask() {
    if (closed || worldKey) return;
    if (asks++ >= ASKS) return say('The screen hasn’t sent the world', 'It may be resting. ' + BACK_HINT, true);
    ctx.ask();
    askT = setTimeout(ask, ASK_MS);
  }
  // A welcome without a world yet: a fresh round of asks (the running loop carries on with it, a spent one restarts).
  function askAgain() {
    const spent = asks > ASKS;
    asks = 0;
    if (spent) { say(BUILDING, ASKING, false); ask(); }
  }

  // ---- positions: mine drives the camera, the others are paper figures in their colours ----
  function setNear(label) {
    const on = typeof label === 'string' && label !== '';
    const text = on ? 'Poke the ' + label.slice(0, 40) : 'Walk to something';
    if (verb.textContent !== text) verb.textContent = text;
    verb.setAttribute('aria-disabled', on ? 'false' : 'true');
  }
  // Walk held toward the end of the path the figure already stands at: say so once per press of Walk (or turn).
  function endCheck() {
    const hd = dir();
    if (endShown || !world || !me.seen || curLx === 0 || curLx !== hd || (hd < 0 ? me.t > MIN_T + 0.005 : me.t < 0.995)) return;
    endShown = true;
    hintSay(END_HINT, 4000);
  }
  function makeFigure(o) {
    const color = okColor(o.color), tex = sheetTexture(null, color, o.pid % 2 === 0); // bonnet for even pids, as on the TV
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5 }));
    sprite.center.set(0.5, 0);
    const tag = textSprite(String(o.name || '').slice(0, 40), { bg: tok('--ink'), fg: tok('--cream'), dot: color, alpha: 0.85 });
    tag.renderOrder = 10; tag.material.sizeAttenuation = false;
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    scene.add(shadow, sprite, tag);
    // everyone walks the one path line, so the others keep to a side of it rather than walk through your eyes
    return { sprite, tag, shadow, tex, t: o.t, shown: o.t, facing: 1, phase: 0, lane: o.pid % 2 ? LANE : -LANE };
  }
  function dropFigure(f) {
    scene.remove(f.sprite, f.tag, f.shadow);
    f.tex.dispose(); f.sprite.material.dispose(); f.tag.material.map.dispose(); f.tag.material.dispose();
  }
  function onPos(m) {
    const mine = m.me;
    if (mine && fin(mine.t)) {
      me.t = clamp(mine.t, 0, 1); me.facing = mine.facing === -1 ? -1 : 1;
      if (!me.seen) { me.seen = true; me.shown = me.t; }
      if (world && heading === null) heading = me.facing;
      endCheck();
    }
    setNear(m.near);
    if (!Array.isArray(m.others)) return;
    const seen = {};
    for (const o of m.others.slice(0, 12)) {
      if (!o || !fin(o.pid) || !fin(o.t)) continue;
      seen[o.pid] = true;
      let f = others.get(o.pid);
      if (!f) { f = makeFigure(o); others.set(o.pid, f); }
      f.t = clamp(o.t, 0, 1); f.facing = o.facing === -1 ? -1 : 1;
    }
    others.forEach((f, pid) => { if (!seen[pid]) { dropFigure(f); others.delete(pid); } });
  }

  // ---- the frame ----
  const eye = new THREE.Vector3(), fwd = new THREE.Vector3(), at = new THREE.Vector3(), right = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const look = new THREE.Quaternion(), qz = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const BACK_OF_PHONE = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // the camera looks out of the phone's back
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;
    if (!world) return;
    const d = world.d, k = 1 - Math.exp(-dt * 8);
    d.update(dt, reduced.matches);
    me.shown += (me.t - me.shown) * k; // positions come 5 times a second; ease between them
    const hd = dir(), p = d.pathAt(me.shown), f0 = xyz(p.forward, fwd), aim = Math.atan2(-f0.x * hd, -f0.z * hd);
    yaw = yaw === null ? aim : yaw + wrap(aim - yaw) * (1 - Math.exp(-dt * 5)); // turning round is a turn, not a cut
    xyz(p.position, eye).y += d.eyeHeight;
    if (tilt && tilt.q) look.setFromAxisAngle(Y, yaw + dragYaw - tilt.yaw0).multiply(tilt.q);
    else look.setFromEuler(euler.set(pitch, yaw + dragYaw, 0, 'YXZ'));
    const g = reduced.matches ? 1 : smooth(((now - born) / 1000 - HOLD_S) / GLIDE_S);
    let fov = fpFov;
    if (g < 1) {
      const pc = d.paintingCamera;
      xyz(pc.position, paintCam.position); paintCam.lookAt(xyz(pc.lookAt, at));
      camera.position.copy(paintCam.position).lerp(eye, g);
      camera.quaternion.copy(paintCam.quaternion).slerp(look, g);
      fov = pc.fov + (fpFov - pc.fov) * g;
    } else { camera.position.copy(eye); camera.quaternion.copy(look); }
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    const h = d.eyeHeight * FIG_H;
    others.forEach((f) => {
      const step = (f.t - f.shown) * k;
      f.shown += step; f.phase += Math.abs(step) * WALK_RATE;
      const fp = d.pathAt(f.shown), fw = xyz(fp.forward, fwd), pos = xyz(fp.position, at);
      pos.x += fw.z * f.lane * d.eyeHeight; pos.z -= fw.x * f.lane * d.eyeHeight;
      f.sprite.visible = f.tag.visible = f.shadow.visible = Math.hypot(pos.x - eye.x, pos.z - eye.z) > d.eyeHeight * 0.4; // not in your face
      f.sprite.position.copy(pos); f.sprite.scale.set(h * ASPECT, h, 1);
      f.shadow.position.copy(pos); f.shadow.position.y += h * 0.01; f.shadow.scale.set(h * 0.55, 1, h * 0.2);
      f.tag.position.copy(pos); f.tag.position.y += h * 1.06; f.tag.scale.set(TAG_H * f.tag.userData.aspect, TAG_H, 1);
      const onScreen = (fw.x * right.x + fw.z * right.z) * f.facing < 0 ? -1 : 1; // billboards mirror by view
      setFrame(f.tex, Math.abs(f.t - f.shown) > 1e-4 ? WALK[Math.floor(f.phase) % 4] : IDLE, onScreen);
    });
    renderer.render(scene, camera);
  }

  // ---- input: Walk (held), Turn around and the verb drive the pad's own input; drag looks around ----
  const resets = [];
  function hold(el, down, up) {
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      if (id !== null || e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      id = e.pointerId; down();
    });
    const end = (e) => { if (e.pointerId === id) { id = null; up(); } };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, end);
    el.addEventListener('keydown', (e) => { if (isPress(e)) { e.preventDefault(); if (!e.repeat) down(); } });
    el.addEventListener('keyup', (e) => { if (isPress(e)) up(); });
    resets.push(() => { id = null; });
  }
  function walk(on) {
    if (on) endShown = false;
    ctx.setLx(on ? dir() : 0);
  }
  function turn() {
    heading = -dir(); endShown = false;
    if (curLx !== 0) ctx.setLx(heading); // Walk held: keep walking, the other way
  }
  hold(walkBtn, () => walk(true), () => walk(false));
  hold(verb, () => ctx.setA(1), () => ctx.setA(0));
  // Turn turns on pointerdown, so a second thumb's tap works while the first holds Walk (a multi-touch tap may get no
  // click); the click that follows a pointer press is skipped, a keyboard or screen-reader click turns.
  let turnUp = -Infinity;
  turnBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); turn(); } });
  turnBtn.addEventListener('pointerup', () => { turnUp = performance.now(); });
  turnBtn.addEventListener('click', () => { if (performance.now() - turnUp > 400) turn(); });

  let dragId = null, px = 0, py = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (dragId !== null) return;
    dragId = e.pointerId; px = e.clientX; py = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    hint.classList.add('gone');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    if (e.clientX !== px || e.clientY !== py) looked();
    const s = Math.PI / Math.max(1, canvas.clientWidth); // a full-width drag turns you half way round
    dragYaw += (e.clientX - px) * s;
    pitch = clamp(pitch + (e.clientY - py) * s, -PITCH_MAX, PITCH_MAX);
    px = e.clientX; py = e.clientY;
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, (e) => { if (e.pointerId === dragId) dragId = null; });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (!closed) say('The phone’s graphics gave out', 'Go back to the pad and step inside again.', true);
  });

  // ---- Look by moving your phone: DeviceOrientation, relative to how the phone was held when it was turned on ----
  // Only on a secure touch device (no events on http); iOS asks permission inside the tap.
  tiltBtn.hidden = !(window.isSecureContext && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches);
  const tiltEuler = new THREE.Euler(0, 0, 0, 'YXZ'), RAD = Math.PI / 180;
  function onOri(e) {
    if (!tilt || e.alpha === null || e.alpha === undefined) return;
    const orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * RAD;
    const qd = tilt.q || new THREE.Quaternion();
    qd.setFromEuler(tiltEuler.set(e.beta * RAD, e.alpha * RAD, -e.gamma * RAD, 'YXZ')).multiply(BACK_OF_PHONE).multiply(qz.setFromAxisAngle(Z, -orient));
    if (!tilt.q) { tilt.q = qd; tilt.yaw0 = tiltEuler.setFromQuaternion(qd, 'YXZ').y; tilt.ref = qd.clone(); }
    else if (qd.angleTo(tilt.ref) >= LOOK_TURN) { tilt.ref.copy(qd); looked(); } // sensor jitter on a still phone is not looking
  }
  function setTilt(on) {
    tilt = on ? { q: null, yaw0: 0, ref: null } : null;
    tiltBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    clearTimeout(tiltT);
    removeEventListener('deviceorientation', onOri);
    if (!on) return;
    dragYaw = 0; // straight ahead is wherever the phone points now
    addEventListener('deviceorientation', onOri);
    tiltT = setTimeout(() => {
      if (tilt && !tilt.q) { setTilt(false); ctx.toast('This phone doesn’t report its motion; drag to look'); }
    }, 1500);
  }
  tiltBtn.onclick = () => {
    if (tilt) return setTilt(false);
    const D = window.DeviceOrientationEvent;
    let asked;
    try { asked = typeof D.requestPermission === 'function' ? D.requestPermission() : Promise.resolve('granted'); } catch (e) { asked = Promise.reject(e); }
    asked.then((r) => { if (r !== 'granted') throw r; if (!closed) setTilt(true); })
      .catch(() => { if (!closed) ctx.toast('Motion wasn’t allowed; drag to look instead'); });
  };

  q('.in-back').onclick = ctx.back;
  q('.in-out').onclick = ctx.back;
  // Keys: ArrowUp held walks, ArrowDown or T turns around, Escape goes back.
  function onKey(e) {
    if (e.key === 'Escape') return ctx.back();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); if (!e.repeat) walk(true); }
    else if (e.key === 'ArrowDown' || e.key === 't' || e.key === 'T') { e.preventDefault(); if (!e.repeat) turn(); }
  }
  function onKeyUp(e) { if (e.key === 'ArrowUp') walk(false); }
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);

  function close() {
    if (closed) return;
    closed = true; seq++;
    cancelAnimationFrame(raf); clearTimeout(askT); clearTimeout(hintT);
    setTilt(false);
    removeEventListener('resize', size); removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp);
    clearWorld();
    others.forEach(dropFigure); others.clear();
    shadowGeo.dispose(); shadowMat.dispose();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    root.parentNode.removeChild(root);
    document.body.classList.remove('inside');
  }

  q('.in-back').focus();
  if (renderer) {
    say(BUILDING, ASKING, false);
    ask();
    raf = requestAnimationFrame(frame);
  } else {
    say('This phone can’t draw the world in 3D', 'Its browser has no WebGL. The pad still walks your figure.', true);
  }

  return {
    msg(m) { if (closed) return; if (m.t === 'world') onWorld(m); else if (m.t === 'pos') onPos(m); },
    // the pad's state after every change, so a release by blur or pagehide (zero) also lets go of these buttons
    input(lx, a) {
      curLx = lx;
      walkBtn.classList.toggle('on', lx !== 0 && lx === dir());
      verb.classList.toggle('down', !!a);
      if (!lx && !a) resets.forEach((r) => r());
      endCheck();
    },
    // A welcome (a rejoin, a rollover, a host back from a gap): the host may have lost track that this phone is inside.
    // With a world here, value 2 re-asserts it without the world coming again unless it changed; else the asks go on.
    again() {
      if (closed || !renderer) return;
      if (worldKey) ctx.reassert(); else askAgain();
    },
    close,
  };
}
