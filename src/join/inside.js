// The inside view (a lazy chunk): the TV's picture folded into a walkable diorama (../world/diorama.js) and seen
// first person from this phone's figure. main.js imports it on "Step inside", hands it the pad's input setters and
// routes the host's {t:'world'} and {t:'pos'} here. It opens on the picture exactly as painted (the diorama's
// painting camera), then glides down into the figure's eyes. No ES2020 syntax (?. ??): iOS 13 must parse it.
import * as THREE from 'three';
import { buildDiorama } from '../world/diorama.js';
import { walkSign } from '../world/tip.js';
import { sheetTexture, setFrame, textSprite, shadowTexture, ASPECT, WALK, IDLE } from '../host/figures.js';
import { MIN_T } from '../shared/protocol.js';
import { isLineArt } from '../shared/lineart.js';
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
const FLIP_DEG = 15; // Walk switches path direction only once the look is this far past sideways
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
const LINE_PX = 256; // the drawing check reads a nearest-sampled 256 x 256 copy of the picture (thin ink stays ink)
const FOLLOW_S = 0.8, FOLLOW_MS = 2500; // the view turns to a stop in this long, unless you looked round yourself this recently
const FLOOR_PITCH = 25 * Math.PI / 180; // a stop's river or path is seen ahead on the ground, not straight down at your feet
const FOOT_VIEW = 0.4; // a standing stop's foot stays within this share of the view's height below its middle

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
  tex.anisotropy = Math.min(16, aniso); // the floor is seen at a grazing angle
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping; // past the frame the diorama continues the painting mirrored
  return { tex, aspect, lineArt: lineArtOf(c) };
}
// Whether the picture is a drawing (ink on blank paper: depth estimation reads only noise in it); false when unreadable.
function lineArtOf(c) {
  const s = document.createElement('canvas');
  try {
    s.width = s.height = LINE_PX;
    const sctx = s.getContext('2d');
    sctx.imageSmoothingEnabled = false; // point samples, as isLineArt's own grid takes them: no greyed lines
    sctx.drawImage(c, 0, 0, LINE_PX, LINE_PX);
    return isLineArt(sctx.getImageData(0, 0, LINE_PX, LINE_PX).data, LINE_PX, LINE_PX) === true;
  } catch (e) {
    return false;
  } finally {
    s.width = s.height = 0;
  }
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
// join.html's #descL; main.js shows it and paints its state (it owns the one voice)
const LISTEN = '<button type="button" class="desc-l" aria-label="Listen to the description" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 5.5a9 9 0 0 1 0 13"/></svg><span aria-hidden="true">Listen</span></button>';
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
</div>
<div class="desc in-desc" role="status" hidden><div class="desc-head"><h2></h2><button type="button" class="desc-x">Close</button></div>${LISTEN}<p></p></div>`;

// ctx: {setLx(v), setA(v)} (the pad's own input, so the heartbeat and release rules are the pad's), ask() (sends
// {t:'panel', kind:'inside', value:1}), reassert() (value 2: the host resends the world only if it changed), look()
// (sends {t:'panel', kind:'look', value:1}, activity for the idle kick; returns whether it went), back() (main leaves:
// sends value 0 and calls close), toast(text), closeDesc() (the description card's Close: main closes it everywhere),
// listen() (the card's Listen: main plays or stops the voice and paints this button too).
// Returns {msg(m), input(lx, a), again(), describe(d), close()}; d is {head, text, index}, or null to hide the card.
export function open(ctx) {
  const root = document.createElement('section');
  root.className = 'inside';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Inside the picture');
  root.innerHTML = HTML;
  document.body.appendChild(root);
  document.body.classList.add('inside');
  const q = (s) => root.querySelector(s);
  const canvas = q('.in-gl'), card = q('.in-card'), verb = q('.in-verb'), tiltBtn = q('.in-tilt'), hint = q('.in-hint');
  const walkBtn = q('.in-walk'), turnBtn = q('.in-turn'), descEl = q('.in-desc');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let closed = false, raf = 0, last = 0, seq = 0, worldKey = '', world = null, asks = 0, askT = 0, tiltT = 0, hintT = 0;
  let born = 0, yaw = null, dragYaw = 0, pitch = 0, fpFov = 60, tilt = null, curLx = 0;
  // heading: the way the camera faces along the path (+1 toward increasing t), apart from the figure's own facing,
  // so standing still you can turn round; Walk walks that way. null until the first pos after a world is built.
  let heading = null, endShown = false, lookedAt = -Infinity;
  // The view follows the stop: nearLabel is the last pos's near; stop the label the view turns to (reached with no look
  // round of your own for FOLLOW_MS), null once left or let go; fol the turn under way, {on, label, t0, y0, p0} (on:
  // toward the stop, else back to the walking way), null while the look is the player's own.
  let nearLabel = null, stop = null, fol = null, movedAt = -Infinity;
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
  // The player takes the look (a drag, a tilt, Turn): the view stops following until the next stop, from where it is.
  function letGo() { stop = null; fol = null; }
  // Looking around (a drag that moved, a tilt that turned) keeps the seat from the idle kick, at most once per LOOK_MS.
  function looked() {
    const now = performance.now();
    movedAt = now; letGo();
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
    let tex = richer ? world.tex : null, aspect = richer ? world.aspect : 0, lineArt = richer ? world.lineArt : false, loaded = [];
    const picture = richer ? null : loadImage(m.image).then(null, () => { throw new Error('image'); });
    Promise.all([picture, loadDepth(m.scene.depth_url)]) // the card waits for both; a depth that fails is just null
      .then((got) => {
        if (gen !== seq) return null;
        if (!richer) {
          const t = imageTexture(got[0], Math.min(MAX_TEX, renderer.capabilities.maxTextureSize), renderer.capabilities.getMaxAnisotropy());
          tex = t.tex; aspect = t.aspect; lineArt = t.lineArt;
        }
        return buildDiorama(m.scene, tex, { aspect, depth: got[1], lineArt }); // it validates the scene itself; a drawing gets no depth room
      })
      .then((d) => (d ? Promise.resolve(d.ready).then((ids) => { loaded = ids; return d; }) : null)) // its 3D models load, or fall back to flats, first
      .then((d) => {
        if (!d) return;
        if (gen !== seq) { d.dispose(); if (!richer) tex.dispose(); return; }
        const was = world;
        if (richer) { scene.remove(was.d.group); try { was.d.dispose(); } catch (e) {} } // its texture is the new world's
        world = { d, tex, aspect, lineArt, scene: m.scene, image: m.image };
        scene.add(d.group);
        const box = new THREE.Box3().setFromObject(d.group), r = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length();
        camera.near = Math.max(0.001, d.eyeHeight * 0.02); camera.far = Math.max(camera.near * 100, r * 3);
        camera.updateProjectionMatrix();
        if (richer) {
          const line = gained(was.scene, m.scene, d, loaded);
          if (line) hintSay(line, 5000);
          return;
        }
        born = performance.now(); yaw = null; heading = null; fol = null; // a new world: its own walking way, level, no stop
        dragYaw = 0; pitch = 0; stop = null; nearLabel = null;
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
    const text = on ? 'About the ' + label.slice(0, 40) : 'Walk to something';
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
    const color = okColor(o.color), tex = sheetTexture(null, color, o.pid === 0 ? 'conductor' : o.pid % 2 === 0); // as on the TV: pid 0 the Conductor, then bonnet for even pids
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5 }));
    sprite.center.set(0.5, 0);
    const tag = textSprite(String(o.name || '').slice(0, 40), { bg: tok('--ink'), fg: tok('--cream'), dot: color, alpha: 0.85 });
    tag.renderOrder = 10; tag.material.sizeAttenuation = false;
    tag.material.depthTest = true; // a figure hidden behind a cut-out hides its name too
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
    const near = typeof m.near === 'string' && m.near !== '' ? m.near : null;
    if (near !== nearLabel) { nearLabel = near; stop = near !== null && performance.now() - movedAt >= FOLLOW_MS ? near : null; }
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
  const look = new THREE.Quaternion(), qz = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ'), ahead = new THREE.Vector3();
  const BACK_OF_PHONE = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // the camera looks out of the phone's back
  // The look for a base yaw along the path: plus the drag, and the phone's own turn while tilt is on.
  function aimLook(qOut, base) {
    if (tilt && tilt.q) return qOut.setFromAxisAngle(Y, base + dragYaw - tilt.yaw0).multiply(tilt.q);
    return qOut.setFromEuler(euler.set(pitch, base + dragYaw, 0, 'YXZ'));
  }
  // Where the stop `label` is to be looked at (the diorama's lookAt: a flat's or model's centre, a backdrop's spot on
  // the wall; else its position) into goal, and that object into goalOf; of two objects with one label, the nearer.
  // false when none has it.
  const goal = new THREE.Vector3(), cand = new THREE.Vector3();
  let goalOf = null;
  function stopPoint(d, label) {
    let best = Infinity;
    (Array.isArray(d.objects) ? d.objects : []).forEach((o) => {
      const p = o && typeof o.label === 'string' && o.label.trim() === label.trim() ? o.lookAt || o.position : null;
      if (!p) return;
      const dd = xyz(p, cand).distanceToSquared(eye);
      if (dd < best) { best = dd; goal.copy(cand); goalOf = o; }
    });
    return best < Infinity;
  }
  // The view follows the stop: standing at one (Walk not held), the look eases over FOLLOW_S to it and holds there; on
  // leaving it, or on Walk, back to the walking way, and the look is the player's own again. It turns the drag's yaw
  // and pitch (with tilt on, the yaw only: the phone keeps its own pitch), so a drag carries on from it (walkSign skips
  // it: see frame). Something lying on the floor is looked at no steeper than FLOOR_PITCH down; a standing one keeps
  // its foot in view. Flats hiding the stop's object fade while the view holds on it (the diorama's focus). Run after
  // yaw is eased and eye placed.
  function follow(d, now) {
    const on = stop !== null && curLx === 0 && stopPoint(d, stop);
    if (typeof d.focus === 'function') d.focus(on ? goal : null);
    if (!fol && !on) return;
    const tilted = !!(tilt && tilt.q), ty = tilted ? euler.setFromQuaternion(tilt.q, 'YXZ').y - tilt.yaw0 : 0; // the phone's own turn
    const label = on ? stop : null;
    if (!fol || fol.label !== label) fol = { on, label, t0: now, y0: yaw + dragYaw + ty, p0: pitch };
    let toY = yaw, toP = 0;
    if (on) {
      cand.copy(goal).sub(eye);
      const across = Math.hypot(cand.x, cand.z);
      toY = across > 1e-6 ? Math.atan2(-cand.x, -cand.z) : fol.y0;
      toP = clamp(Math.atan2(cand.y, across), goalOf.part === 'floor' ? -FLOOR_PITCH : -PITCH_MAX, PITCH_MAX);
      if (goalOf.part === 'stand' && goalOf.position) { // the foot no lower than FOOT_VIEW of the way down the view
        xyz(goalOf.position, cand).sub(eye);
        toP = Math.max(-PITCH_MAX, Math.min(toP, Math.atan2(cand.y, Math.hypot(cand.x, cand.z)) + FOOT_VIEW * fpFov * Math.PI / 180));
      }
    }
    const s = reduced.matches ? 1 : smooth((now - fol.t0) / 1000 / FOLLOW_S);
    dragYaw = wrap(fol.y0 + wrap(toY - fol.y0) * s - yaw - ty);
    if (!tilted) pitch = fol.p0 + (toP - fol.p0) * s;
    if (!on && s >= 1) fol = null; // back on the walking way
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;
    if (!world) return;
    const d = world.d, k = 1 - Math.exp(-dt * 8);
    d.update(dt, reduced.matches);
    me.shown += (me.t - me.shown) * k; // positions come 5 times a second; ease between them
    const p = d.pathAt(me.shown), f0 = xyz(p.forward, fwd);
    let aim = Math.atan2(-f0.x * dir(), -f0.z * dir());
    // Walk goes the path way nearer the look: the full look at the path aim (not the eased yaw, so a turn's swing never
    // flips it back). A flip re-expresses the drag (and the eased yaw) against the new aim: the view does not move.
    // Only the player's own look flips it: while the view follows a stop (fol), Walk carries on the way it came, however
    // far round the stop's object turned the view.
    if (heading !== null && !fol) {
      ahead.set(0, 0, -1).applyQuaternion(aimLook(look, aim));
      const s = walkSign(ahead.x, ahead.z, f0.x, f0.z, heading, FLIP_DEG);
      if (s !== heading) {
        heading = s; aim += Math.PI; dragYaw = wrap(dragYaw + Math.PI); endShown = false;
        if (yaw !== null) yaw += Math.PI;
        if (curLx !== 0) ctx.setLx(heading); // Walk held: keep walking, now the way you look
      }
    }
    yaw = yaw === null ? aim : yaw + wrap(aim - yaw) * (1 - Math.exp(-dt * 5)); // turning round is a turn, not a cut
    xyz(p.position, eye).y += d.eyeHeight;
    follow(d, now);
    aimLook(look, yaw);
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
      const gy = typeof d.groundAt === 'function' ? d.groundAt(pos.x, pos.z) : NaN;
      if (fin(gy)) pos.y = gy; // on the ground under its feet beside the path (the relief's own height), else the path's
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
    heading = -dir(); endShown = false; letGo(); // a stop's held look would keep the view from turning round
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
    letGo();
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
  q('.desc-x').onclick = ctx.closeDesc;
  q('.desc-l').onclick = ctx.listen;
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
    // The verb's answer over the view (main owns when it opens and closes).
    describe(d) {
      if (closed) return;
      descEl.hidden = !d;
      if (d) { descEl.querySelector('h2').textContent = d.head; descEl.querySelector('p').textContent = d.text; }
    },
    close,
  };
}
