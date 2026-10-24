// The API plug-in box (K, or the API button in the right margin): a modal over the stage where a visitor plugs in
// their own Gemini, ElevenLabs and Tripo keys and tests every platform, through POST /api/check (the relay through its
// own health GET). The keys live in src/shared/byok.js; once saved the page shows only mask(). main.js imports this
// after glue.js. Every key pressed inside the box stops here, so typing never reaches the TV's letter keys.
import * as byok from '../shared/byok.js';
import './apibox.css';

const CHECK_MS = 12000; // the server cuts each upstream call at 8 s
const HOST_TOKEN = new URLSearchParams(location.search).get('host') || ''; // the server answers team checks only to the TV
const KEYED = [
  { id: 'gemini', name: 'Google Gemini', what: 'Reads each artwork. Your key skips our hourly cap.', hint: 'Paste a Gemini key' },
  { id: 'elevenlabs', name: 'ElevenLabs', what: 'Makes the sounds. Your key turns generation on.', hint: 'Paste an ElevenLabs key' },
  {
    id: 'tripo', name: 'Tripo', what: 'Builds 3D models of the main objects. Your key skips our hourly cap.', hint: 'Paste a Tripo key',
    note: "About 30 credits per object. On Tripo's free plan Tripo owns the outputs.",
  },
];
// A key's shape before it is saved: Tripo's own check, else the shared one.
const SHAPE = {
  tripo: [byok.validTripoKey, "That isn't a Tripo key: tsk_ then 8 to 200 characters, no spaces"],
  other: [byok.validKey, "That isn't a key: 20 to 200 letters, digits, . _ -"],
};
// Team-only services: the box can test them, never change them. The relay answers its own health GET.
const TEAM = [{ id: 'snowflake', name: 'Snowflake' }, { id: 'storage', name: 'Blob storage' }, { id: 'relay', name: 'Realtime relay' }];
const STATE_TEXT = { idle: 'Not tested', pending: 'Testing…', ok: 'Working', bad: 'Failed' };
const USING = { team: 'team setup', none: 'not set' };
const PRIVACY = "Keys stay in this browser and are sent only to this site's API over HTTPS with each request; the server never stores or logs them.";

const results = {}, seq = {}, ui = {};
let layer = null, dialog = null, openBtn = null, openYours = null, remember = null, footMsg = null, returnTo = null, checked = false;

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter(Boolean));
  return e;
}

const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

function set(id, patch) {
  results[id] = { ...results[id], ...patch };
  renderCard(id);
}

async function runCheck(id) {
  const my = (seq[id] = (seq[id] || 0) + 1);
  set(id, { state: 'pending', detail: '' });
  let status = 0, body = null;
  try {
    const res = await fetch('/api/check', {
      method: 'POST', cache: 'no-store', signal: timeout(CHECK_MS),
      headers: { 'content-type': 'application/json', 'x-host-token': HOST_TOKEN, ...byok.apiHeaders() }, body: JSON.stringify({ service: id }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* no answer: status 0 */ }
  if (seq[id] !== my) return;
  const r = byok.readCheck(status, body);
  set(id, { state: r.ok ? 'ok' : 'bad', using: r.using, detail: r.detail, credits: r.credits });
}

async function runRelay() {
  const my = (seq.relay = (seq.relay || 0) + 1), path = byok.relayPath(location.protocol);
  set('relay', { state: 'pending', detail: '' });
  let status = 0, body = null;
  try {
    const res = await fetch(path, { cache: 'no-store', signal: timeout(CHECK_MS) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* no answer: status 0 */ }
  if (seq.relay !== my) return;
  const v = byok.relayView(status, body, path);
  set('relay', { state: v.ok ? 'ok' : 'bad', detail: v.ok ? '' : v.detail, rows: v.rows });
}

const test = (id) => { if (results[id].state !== 'pending') (id === 'relay' ? runRelay() : runCheck(id)); };

function hideKey(c) {
  c.input.type = 'password';
  c.show.textContent = 'Show';
  c.show.setAttribute('aria-pressed', 'false');
}

function forget(c) {
  c.input.value = '';
  c.test.textContent = 'Test';
  hideKey(c);
}

// Test with typed text saves it first (only if it has a key's shape), then checks; the field empties at once.
function testKeyed(id) {
  const c = ui[id], typed = c.input.value.trim(), [valid, why] = SHAPE[id] || SHAPE.other;
  if (typed) {
    if (!valid(typed)) {
      set(id, { state: 'bad', detail: why, credits: null });
      c.input.focus();
      return;
    }
    forget(c);
    byok.save({ [id]: typed });
    return runCheck(id); // a check still running carried the old key: this one wins
  }
  test(id);
}

function clearKeyed(id) {
  forget(ui[id]);
  byok.save(id === 'gemini' ? { gemini: '', geminiModel: '' } : { [id]: '' });
  runCheck(id);
}

function stateRow() {
  const dot = h('span', { class: 'api-dot', 'data-state': 'idle', 'aria-hidden': 'true' });
  const text = h('span', { text: STATE_TEXT.idle });
  return { el: h('p', { class: 'api-state' }, dot, text), dot, text };
}

function keyedCard(svc) {
  const id = svc.id, st = stateRow();
  const c = {
    dot: st.dot, stateText: st.text,
    input: h('input', {
      id: `api-${id}-key`, class: 'api-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'off', placeholder: svc.hint, 'aria-describedby': `api-${id}-saved`,
    }),
    show: h('button', { type: 'button', class: 'api-ghost', 'aria-pressed': 'false', 'aria-controls': `api-${id}-key`, text: 'Show' }),
    test: h('button', { type: 'button', class: 'api-primary', text: 'Test' }),
    clear: h('button', { type: 'button', class: 'api-ghost', text: 'Clear' }),
    using: h('p', { class: 'api-using' }),
    saved: h('p', { id: `api-${id}-saved`, class: 'api-saved' }),
    detail: h('span', {}),
    credits: id === 'elevenlabs' || id === 'tripo' ? h('span', { class: 'api-credits' }) : null,
    model: null,
  };
  c.input.addEventListener('input', () => { c.test.textContent = c.input.value.trim() ? 'Save and test' : 'Test'; });
  c.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); testKeyed(id); } });
  c.show.addEventListener('click', () => {
    const on = c.input.type === 'password';
    c.input.type = on ? 'text' : 'password';
    c.show.textContent = on ? 'Hide' : 'Show';
    c.show.setAttribute('aria-pressed', String(on));
  });
  c.test.addEventListener('click', () => testKeyed(id));
  c.clear.addEventListener('click', () => clearKeyed(id));
  let modelRow = null;
  if (id === 'gemini') {
    c.model = h('select', { id: 'api-gemini-model', class: 'api-select' },
      h('option', { value: '', text: 'Default model' }), ...byok.MODELS.map((m) => h('option', { value: m, text: m })));
    c.model.addEventListener('change', () => byok.save({ geminiModel: c.model.value }));
    modelRow = h('div', { class: 'api-field' }, h('label', { class: 'api-label', for: c.model.id, text: 'Model, with your key' }), c.model);
  }
  ui[id] = c;
  return h('article', { class: 'api-card api-keyed', 'aria-labelledby': `api-${id}-h` },
    h('div', { class: 'api-head' }, h('h3', { id: `api-${id}-h`, text: svc.name }), st.el),
    c.using,
    h('p', { class: 'api-what', text: svc.what }),
    svc.note ? h('p', { class: 'api-what', text: svc.note }) : null,
    h('div', { class: 'api-field' },
      h('label', { class: 'api-label', for: c.input.id, text: 'Your key' }),
      h('div', { class: 'api-keyrow' }, c.input, c.show),
      c.saved),
    modelRow,
    h('div', { class: 'api-actions' }, c.test, c.clear),
    h('p', { class: 'api-detail', 'aria-live': 'polite' }, c.detail, c.credits));
}

function teamCard({ id, name }) {
  const st = stateRow();
  const c = {
    dot: st.dot, stateText: st.text, test: h('button', { type: 'button', class: 'api-ghost', text: 'Test', 'aria-label': 'Test ' + name }),
    detail: h('span', {}), rows: id === 'relay' ? h('dl', { class: 'api-rows' }) : null,
  };
  c.test.addEventListener('click', () => test(id));
  ui[id] = c;
  return h('article', { class: 'api-card api-team', 'aria-labelledby': `api-${id}-h` },
    h('div', { class: 'api-head' }, h('h3', { id: `api-${id}-h`, text: name }), c.test),
    st.el,
    c.rows,
    h('p', { class: 'api-detail', 'aria-live': 'polite' }, c.detail));
}

function renderCard(id) {
  const c = ui[id], r = results[id], keys = byok.load();
  if (!c) return;
  c.dot.setAttribute('data-state', r.state);
  const using = !c.using && USING[r.using] && r.state !== 'pending' ? ' · ' + USING[r.using] : '';
  c.stateText.textContent = STATE_TEXT[r.state] + using;
  c.detail.textContent = r.detail || '';
  if (c.credits) c.credits.textContent = r.credits !== null ? 'Credits left: ' + r.credits.toLocaleString('en-US') : '';
  if (c.using) {
    const u = keys[id] ? 'your key' : r.using === 'team' ? 'team key' : r.using === 'none' ? 'not set' : 'not checked yet';
    c.using.textContent = 'Using: ' + u;
  }
  if (c.saved) c.saved.replaceChildren(...(keys[id] ? ['Saved: ', h('code', { text: byok.mask(keys[id]) })] : ['No key of yours saved']));
  if (c.model) c.model.value = keys.geminiModel;
  if (c.rows) c.rows.replaceChildren(...r.rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
}

function renderAll() {
  for (const id of Object.keys(ui)) renderCard(id);
  const keys = byok.load();
  if (remember) remember.checked = keys.remember;
  if (openYours) openYours.hidden = !(keys.gemini || keys.elevenlabs || keys.tripo);
}

function focusables() {
  return [...dialog.querySelectorAll('button, input, select')].filter((e) => !e.disabled && e.getClientRects().length);
}

function trap(e) {
  const list = focusables();
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1], at = document.activeElement;
  if (!dialog.contains(at)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

export function open() {
  if (!layer || !layer.hidden) return;
  returnTo = document.activeElement;
  renderAll();
  layer.hidden = false;
  openBtn.setAttribute('aria-expanded', 'true');
  ui.gemini.input.focus();
  // One round of checks per page load (5 of the server's 10 per minute); after that, Test asks again.
  if (!checked) { checked = true; for (const id of Object.keys(ui)) test(id); }
}

export function close() {
  if (!layer || layer.hidden) return;
  for (const s of KEYED) forget(ui[s.id]); // no typed, unsaved key stays in the page
  if (layer.contains(document.activeElement)) document.activeElement.blur();
  layer.hidden = true;
  openBtn.setAttribute('aria-expanded', 'false');
  const back = returnTo;
  returnTo = null;
  if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus();
}

export const toggle = () => (layer && layer.hidden ? open() : close());

function build() {
  const stage = document.getElementById('stage') || document.getElementById('tv') || document.body;
  remember = h('input', { type: 'checkbox', id: 'api-remember' });
  remember.addEventListener('change', () => {
    byok.save({ remember: remember.checked });
    footMsg.textContent = remember.checked ? 'Kept on this device until you clear them' : 'Kept until this tab closes';
  });
  footMsg = h('p', { class: 'api-foot-msg', 'aria-live': 'polite' });
  const clearAll = h('button', { type: 'button', class: 'api-ghost api-on-frame', text: 'Clear my keys' });
  clearAll.addEventListener('click', () => {
    for (const s of KEYED) forget(ui[s.id]);
    byok.clear();
    footMsg.textContent = 'Your keys are cleared from this browser';
    for (const s of KEYED) runCheck(s.id);
  });
  const closeBtn = h('button', { type: 'button', class: 'api-close', 'aria-label': 'Close the API box', text: '×' });
  closeBtn.addEventListener('click', close);

  // tabindex -1: a click on blank space inside the box keeps focus in the box, so the TV's keys stay shut out.
  dialog = h('section', { class: 'api-box', role: 'dialog', tabindex: '-1', 'aria-modal': 'true', 'aria-labelledby': 'api-title', 'aria-describedby': 'api-sub' },
    h('header', { class: 'api-top' },
      h('div', {}, h('h2', { id: 'api-title', text: 'API plug-in box' }),
        h('p', { id: 'api-sub', class: 'api-sub', text: 'Plug in your own keys and test each platform. Tab moves, Esc closes.' })),
      closeBtn),
    h('div', { class: 'api-grid' },
      ...KEYED.map(keyedCard),
      h('div', { class: 'api-col' },
        ...TEAM.map(teamCard))),
    h('footer', { class: 'api-foot' },
      h('div', { class: 'api-foot-row' },
        h('label', { class: 'api-remember', for: remember.id }, remember, h('span', { text: 'Remember on this device' })),
        clearAll, footMsg),
      h('p', { class: 'api-privacy', text: PRIVACY })));
  layer = h('div', { id: 'apiBox', class: 'api-layer' }, dialog);
  layer.hidden = true;
  // Bubble phase on the box, so the window's key handlers (scene, glue, audio, margins) never see these keys.
  layer.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') trap(e);
  });
  // scene.js blurs a mouse-clicked input or button on #stage (for the keyboard player); never inside the box.
  layer.addEventListener('pointerup', (e) => e.stopPropagation());
  stage.append(layer);

  openYours = h('span', { class: 'api-open-yours', text: 'your keys' });
  openBtn = h('button', { type: 'button', class: 'api-open', title: 'API plug-in box (K)', 'aria-expanded': 'false', 'aria-controls': 'apiBox' },
    h('span', { text: 'API' }), h('kbd', { text: 'K' }), openYours);
  // A mouse click must not leave focus on the button, or the keyboard player's Space would press it again.
  openBtn.addEventListener('mousedown', (e) => e.preventDefault());
  openBtn.addEventListener('click', toggle);
  const tag = document.getElementById('modeTag'), margin = document.querySelector('.margin.right');
  if (tag) tag.after(openBtn); else if (margin) margin.prepend(openBtn); else document.body.append(openBtn);

  for (const { id } of [...KEYED, ...TEAM]) results[id] = { state: 'idle', using: '', detail: '', credits: null, rows: [] };
  renderAll();
}

function wire() {
  addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !t || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (!layer.hidden) { if (e.key === 'Escape') close(); return; }
    if ((e.key || '').toLowerCase() === 'k') { e.preventDefault(); open(); }
  });
  // Focus stays in the box while it is open: a click outside it (the margins) cannot take it away.
  document.addEventListener('mousedown', (e) => {
    if (!layer.hidden && !layer.contains(e.target) && !openBtn.contains(e.target)) e.preventDefault();
  }, true);
  document.addEventListener('focusin', (e) => {
    if (!layer.hidden && !layer.contains(e.target)) { const f = focusables()[0]; if (f) f.focus(); }
  });
  addEventListener(byok.EVENT, renderAll);
}

build();
wire();
