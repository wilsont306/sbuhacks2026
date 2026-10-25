// The TV page's cover, "Canvas Express": the night line, where a paper train roams a winding rail under the title,
// and one ticket, "Host a ride". Pressing it (a click, Enter or Space) punches the ticket, opens the gallery
// underneath and crumples the cover like a sheet of paper, which falls away to show the gallery. Keys 1 to 3, and any
// scene after the boot sample (a phone's picture, R, a script's loadScene), crumple it without the gallery, so scripted
// tests and the attendant get past it. ?cover=0 skips it.
// Phones never see it: they open the join page, every QR carries a room, and join.html sends only a computer without
// one here. The ticket is also the page's first gesture, which lets the browser start its sound.
import { showGallery, loadSample } from './artwork.js';
import * as audio from './audio.js';
import './cover.css';

/* pure:start (tests/cover.test.js imports this block on its own, so it must not use imports or globals) */
// The crumple's clip-path stops, n points each so the browser can move every point from one stop to the next: the
// page's outline (clockwise from its top-left corner), the page folding in (each point pulled toward the middle by
// its own amount), and a paper ball (each point on the ray it started on, alternately in and out). The ball is round
// on a 16:9 page: its x radius is a share of the width, its y radius the same length as a share of the height.
export function crumpleStops(n = 28, aspect = 16 / 9) {
  const side = n / 4, edge = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i / side), f = (i % side) / side;
    edge.push(s === 0 ? [f * 100, 0] : s === 1 ? [100, f * 100] : s === 2 ? [100 - f * 100, 100] : [0, 100 - f * 100]);
  }
  let seed = 7; // the same crumple every time
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const fold = edge.map(([x, y]) => { const k = 0.18 + rand() * 0.22; return [x + (50 - x) * k, y + (50 - y) * k]; });
  const ball = edge.map(([x, y], i) => {
    const a = Math.atan2((y - 50) / aspect, x - 50), r = (i % 2 ? 8 : 9.5) + rand() * 2; // lumpy, not a star
    return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r * aspect];
  });
  const css = (pts) => `polygon(${pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ')})`;
  return [edge, fold, ball].map(css);
}
/* pure:end */

const SVG = 'http://www.w3.org/2000/svg';
// The rail: in from beyond the left edge, over two gentle rises, out beyond the right; the train follows the same path.
const RAIL = 'M -420 880 C -40 880, 240 760, 640 792 S 1180 930, 1480 862 S 1980 760, 2340 812';
// The rail run on straight past both ends by ext frame px (in level, as it starts; out along its last slope, 52 in
// 360), for windows wider than 16:9, whose edges lie beyond the frame's.
const railPath = (ext) => (ext > 0 ? `M ${-420 - ext} 880 L${RAIL.slice(1)} L ${2340 + ext} ${(812 + ext * 52 / 360).toFixed(1)}` : RAIL);
const lengthOf = (d) => { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); return p.getTotalLength(); };

// The paper train, cut from cream card with an ink edge: the engine facing the way it runs, then two carriages
// with their lamps lit. Colours come from CSS.
const ENGINE = `<svg viewBox="0 0 250 140" aria-hidden="true">
  <g class="puffs"><circle cx="198" cy="20" r="11"/><circle cx="176" cy="10" r="8"/><circle cx="156" cy="6" r="6"/></g>
  <rect class="paper" x="188" y="30" width="20" height="34" rx="3"/>
  <rect class="paper" x="70" y="56" width="148" height="50" rx="10"/>
  <rect class="band" x="70" y="78" width="148" height="10"/>
  <path class="brass" d="M128 56 a16 14 0 0 1 32 0 Z"/>
  <rect class="paper" x="16" y="26" width="72" height="80" rx="6"/>
  <rect class="lamp" x="32" y="40" width="40" height="26" rx="3"/>
  <path class="paper" d="M218 70 L244 104 L218 104 Z"/>
  <circle class="wheel" cx="44" cy="112" r="17"/><circle class="wheel" cx="96" cy="112" r="17"/>
  <circle class="wheel" cx="146" cy="112" r="17"/><circle class="wheel" cx="200" cy="116" r="12"/>
</svg>`;
const CARRIAGE = `<svg viewBox="0 0 210 130" aria-hidden="true">
  <path class="paper" d="M12 40 Q105 8 198 40 Z"/>
  <rect class="paper" x="8" y="38" width="194" height="66" rx="8"/>
  <rect class="band" x="8" y="84" width="194" height="10"/>
  <rect class="lamp" x="26" y="50" width="30" height="24" rx="3"/><rect class="lamp" x="70" y="50" width="30" height="24" rx="3"/>
  <rect class="lamp" x="114" y="50" width="30" height="24" rx="3"/><rect class="lamp" x="158" y="50" width="30" height="24" rx="3"/>
  <circle class="wheel" cx="40" cy="112" r="14"/><circle class="wheel" cx="74" cy="112" r="14"/>
  <circle class="wheel" cx="138" cy="112" r="14"/><circle class="wheel" cx="172" cy="112" r="14"/>
</svg>`;
const SKY = `<svg class="cover-sky" viewBox="0 0 1920 1080" aria-hidden="true">
  <circle class="moon" cx="1560" cy="150" r="46"/><circle class="bite" cx="1584" cy="132" r="40"/>
  ${[[240, 120], [420, 260], [700, 90], [980, 170], [1240, 80], [1380, 300], [1760, 260], [140, 420], [1820, 520]]
    .map(([x, y], i) => `<path class="star" style="animation-delay:${(i * 0.37) % 3}s" transform="translate(${x} ${y})" d="M0 -8 L1.8 -1.8 L8 0 L1.8 1.8 L0 8 L-1.8 1.8 L-8 0 L-1.8 -1.8 Z"/>`).join('')}
  <path class="hills" d="M-700 800 Q-340 720 0 820 Q240 700 520 760 T1040 740 T1560 720 T1920 780 T2620 760 V1800 H-700 Z"/>
</svg>`;
// Creases that show as the page folds: light ridges and dark valleys, across it in every direction.
const CREASES = [[0, 18, 100, 64], [12, 0, 46, 100], [0, 82, 70, 0], [38, 0, 100, 92], [0, 46, 100, 38], [74, 0, 30, 100],
  [0, 100, 100, 6], [20, 100, 88, 0], [0, 30, 58, 100]];

function rail() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'cover-rail');
  svg.setAttribute('viewBox', '0 0 1920 1080');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['sleepers', 'rails', 'gap']) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', railPath(1600)); // to the edges of a window up to about 5:1
    svg.append(p);
  }
  return svg;
}

function creases() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'cover-creases');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x1, y1, x2, y2] of CREASES) {
    for (const cls of ['valley', 'ridge']) {
      const l = document.createElementNS(SVG, 'line');
      Object.entries({ x1, y1: y1 + (cls === 'ridge' ? 0.35 : 0), x2, y2: y2 + (cls === 'ridge' ? 0.35 : 0), class: cls })
        .forEach(([k, v]) => l.setAttribute(k, String(v)));
      svg.append(l);
    }
  }
  return svg;
}

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

function show() {
  const tv = document.getElementById('tv');
  if (!tv) return;
  const root = el('section', 'cover');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'coverTitle');
  const frame = el('div', 'cover-frame'), title = el('h1', 'cover-title'), ticket = el('button', 'cover-ticket');
  title.id = 'coverTitle';
  title.textContent = 'Canvas Express';
  ticket.type = 'button';
  ticket.append(el('span', 'cover-ticket-name'));
  ticket.firstChild.textContent = 'Host a ride';
  const train = el('div', 'cover-train');
  // A window wider than about 2.3:1 (#tv widened by its bleed) runs the train's path on past its edges, the loop slowed
  // to keep its speed, so it still enters and leaves out of sight. shortcut: measured once, at show; a window widened
  // further later can see the train pop in at an edge until reload.
  const bleed = Math.max(0, (tv.offsetWidth - 1920) / 2), ext = Math.max(0, Math.ceil(bleed - 280)), path = railPath(ext);
  if (ext) train.style.setProperty('--roam', `${(22 * lengthOf(path) / lengthOf(RAIL)).toFixed(2)}s`);
  // Engine first: each car runs the same rail, the ones behind it a little later.
  [ENGINE, CARRIAGE, CARRIAGE].forEach((art, i) => {
    const car = el('div', 'cover-car' + (i ? '' : ' engine'), art);
    car.style.setProperty('--i', String(i));
    car.style.offsetPath = `path("${path}")`; // the rail's own path, so the train never leaves it
    train.append(car);
  });
  frame.insertAdjacentHTML('afterbegin', SKY);
  frame.append(rail(), train, title, ticket);
  root.append(frame, el('div', 'cover-paper'), creases()); // the sheet's cream back shows as it crumples
  tv.append(root);
  ticket.focus();
  // The keys stay here, so nothing walks or opens behind the cover; the ticket keeps the focus. 1, 2 and 3 are the
  // attendant's shortcut past it: the cover crumples and that sample plays.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (!e.repeat && /^[123]$/.test(e.key)) {
      ride(root, ticket, false);
      loadSample(Number(e.key)).then((ok) => { if (ok) try { audio.play('appear'); } catch { /* optional */ } });
    }
  });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget) && root.isConnected && !root.classList.contains('crumpling')) setTimeout(() => ticket.focus(), 0);
  });
  // A picture dropped on the cover stops here: the page's drop (artwork.js) would read and stage it unseen behind it.
  for (const t of ['dragover', 'drop']) root.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); });
  ticket.addEventListener('click', () => ride(root, ticket, true));
  // Any scene after the boot sample (a phone's picture, R, a script's window.game.loadScene) means the TV is in use:
  // the cover crumples away on its own, so nothing ever plays hidden behind it.
  let booted = false;
  const stop = window.game && typeof window.game.onHotspot === 'function' ? window.game.onHotspot((e) => {
    if (!e || e.type !== 'scene' || !root.isConnected) return;
    if (booted) ride(root, ticket, false);
    booted = true;
  }) : null;
  root.addEventListener('cover:gone', () => { if (typeof stop === 'function') stop(); }, { once: true });
}

// The page crumples into a ball that drops away; from the ticket, punched first and with the gallery opened under it.
// Like the train, the crumple plays under reduced motion too, by the owner's choice: it is the transition asked for, and
// the kiosk runs with reduced motion on.
function ride(root, ticket, gallery) {
  if (root.classList.contains('crumpling')) return; // once
  if (gallery) {
    ticket.classList.add('punched');
    try { audio.play('punch'); } catch { /* sound is optional */ }
    showGallery();
  }
  root.classList.add('crumpling');
  // The focus and keys go to the page under it, so the gallery's arrows work while the sheet falls; the sheet itself
  // still takes clicks where it is drawn, and a second click on the ticket does nothing.
  ticket.blur();
  ticket.disabled = true;
  const [flat, fold, ball] = crumpleStops();
  // Solid until it drops: the fade is only in the last stretch, so the gallery never shows through the sheet.
  const run = root.animate([
    { clipPath: flat, transform: 'none', opacity: 1 },
    { clipPath: fold, transform: 'scale(.94) rotate(-2deg)', opacity: 1, offset: 0.34 },
    { clipPath: ball, transform: 'scale(.62) rotate(7deg)', opacity: 1, offset: 0.68 },
    { clipPath: ball, transform: 'translate(14%, 70%) scale(.4) rotate(160deg)', opacity: 0 },
  ], { duration: 1500, easing: 'cubic-bezier(.45, 0, .55, 1)', fill: 'forwards' });
  const sheet = (sel, frames) => root.querySelector(sel).animate(frames, { duration: 1500, fill: 'forwards' });
  sheet('.cover-paper', [{ opacity: 0 }, { opacity: 0, offset: 0.18 }, { opacity: 0.94, offset: 0.6 }, { opacity: 0.94 }]);
  sheet('.cover-creases', [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1 }]);
  const done = () => { root.dispatchEvent(new Event('cover:gone')); root.remove(); };
  run.finished.then(done, done);
}

if (new URLSearchParams(location.search).get('cover') !== '0') show();
