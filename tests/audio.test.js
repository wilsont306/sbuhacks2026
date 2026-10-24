// src/host/audio.js: kind to palette file, sound choice, day cap, the serial /api/sfx queue, mute and quiet failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as audio from '../src/host/audio.js';
import { KINDS, MOTIONS } from '../src/shared/scene-validate.js';

const { kindFile, labelKey, chooseSound, todayCount, dayStamp, prepareList, EVENTS, DAY_CAP } = audio;
const palette = new Set(JSON.parse(readFileSync(new URL('../tools/sfx-palette.json', import.meta.url), 'utf8')).map((p) => p.file));
const obj = (label, kind = 'object', o = {}) => ({ label, kind, motion: 'none', sound_prompt: '', ...o });

test('every kind, motion and event names a palette file', () => {
  for (const k of KINDS) for (const m of MOTIONS) assert.ok(palette.has(kindFile(k, m)), `${k}/${m}`);
  for (const e of EVENTS) assert.ok(palette.has(chooseSound(e).file.replace(/\.mp3$/, '')), e);
});

test('kind map follows the contract; flying animals chirp, flying vehicles do not', () => {
  const want = { sky: 'wind', cloud: 'wind', plant: 'wind', water: 'water', fire: 'fire', animal: 'animal', vehicle: 'vehicle', person: 'footsteps', building: 'bell', celestial: 'twinkle', ground: 'poke', object: 'poke' };
  for (const [k, f] of Object.entries(want)) assert.equal(kindFile(k, 'none'), f, k);
  assert.equal(kindFile('animal', 'fly'), 'bird');
  assert.equal(kindFile('object', 'fly'), 'bird');
  assert.equal(kindFile('bird'), 'bird');
  assert.equal(kindFile('vehicle', 'fly'), 'vehicle');
  assert.equal(kindFile('dragon'), 'poke');
  assert.equal(kindFile('toString'), 'poke');
});

test('labelKey matches the server cache key', () => {
  assert.equal(labelKey('  Old   Oak\tTree '), 'old oak tree');
  assert.equal(labelKey(undefined), '');
  assert.equal(labelKey(42), '');
});

test('chooseSound: events by name, pokes by kind until a generated url is known', () => {
  assert.deepEqual(chooseSound('join'), { src: '/sfx/join.mp3', file: 'join.mp3', generated: false });
  assert.equal(chooseSound('poke').src, '/sfx/poke.mp3');
  assert.equal(chooseSound('poke', obj('River', 'water'), new Map()).src, '/sfx/water.mp3');
  const urls = new Map([['river', 'https://blob.example/sfx/abc.mp3']]);
  const g = chooseSound('poke', obj(' river ', 'water'), urls);
  assert.equal(g.src, 'https://blob.example/sfx/abc.mp3'); assert.equal(g.generated, true); assert.match(g.file, /river/);
  // the poke event carries no motion; the prepared scene supplies it
  assert.equal(chooseSound('poke', { label: 'Swallow', kind: 'animal' }, new Map(), new Map([['swallow', 'fly']])).src, '/sfx/bird.mp3');
});

test('describe plays the object\'s generated sound once ready, else the poke tick (never a kind file)', () => {
  const want = { src: '/sfx/poke.mp3', file: 'poke.mp3', generated: false };
  assert.deepEqual(chooseSound('describe'), want);
  assert.deepEqual(chooseSound('describe', obj('River', 'water'), new Map()), want);
  assert.deepEqual(chooseSound('describe', obj('River', 'water'), new Map([['river', 'https://blob.example/sfx/abc.mp3']])),
    { src: 'https://blob.example/sfx/abc.mp3', file: 'river (made for this artwork)', generated: true });
});

test('todayCount counts only today and ignores junk', () => {
  assert.equal(todayCount({ day: '2026-10-24', n: 7 }, '2026-10-24'), 7);
  assert.equal(todayCount({ day: '2026-10-23', n: 7 }, '2026-10-24'), 0);
  for (const junk of [null, 'x', { day: '2026-10-24', n: -1 }, { day: '2026-10-24', n: 1.5 }, { day: '2026-10-24', n: '3' }]) assert.equal(todayCount(junk, '2026-10-24'), 0);
  assert.equal(dayStamp(new Date(2026, 9, 24, 23, 59)), '2026-10-24');
});

test('prepareList takes the first two distinct labels and skips known ones', () => {
  const scene = { objects: [obj('Sky'), obj('sky '), obj('Train', 'vehicle', { sound_prompt: 'a steam whistle' }), obj('Hare')] };
  assert.deepEqual(prepareList(scene, new Set()), [{ label: 'sky', prompt: '' }, { label: 'train', prompt: 'a steam whistle' }]);
  assert.deepEqual(prepareList(scene, new Set(['sky'])), [{ label: 'train', prompt: 'a steam whistle' }]);
  assert.deepEqual(prepareList(null, new Set()), []);
  assert.deepEqual(prepareList({ objects: [null, { label: '' }] }, new Set()), []);
});

// Browser stand-ins: localStorage, fetch, Audio.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let plays = [], playResult = () => Promise.resolve();
globalThis.Audio = class { constructor() { this.src = ''; } pause() {} play() { plays.push({ src: this.src, volume: this.volume }); return playResult(this.src); } };
const fail = (name) => Promise.reject(Object.assign(new Error(name), { name }));

function fakeFetch(answer) {
  const calls = [];
  let inflight = 0;
  const f = async (url, init) => {
    inflight++; calls.push({ url, init, inflight });
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    const a = answer(JSON.parse(init.body));
    return { status: a.status || 200, json: async () => a.body };
  };
  f.calls = calls;
  return f;
}

function fresh(answer, token = 'tok') {
  mem.clear(); plays = []; playResult = () => Promise.resolve();
  const flashes = [];
  globalThis.fetch = fakeFetch(answer);
  audio.init({ token, margins: { flash: (t) => flashes.push(t) } });
  return flashes;
}
const scene = { objects: [obj('Train', 'vehicle', { sound_prompt: 'one short whistle' }), obj('Swallow', 'animal', { motion: 'fly' }), obj('Bridge', 'building')] };

test('prepare asks for two objects serially with the host token, then pokes play the generated sound', async () => {
  const flashes = fresh(({ label }) => ({ body: { url: `https://blob.example/sfx/${label}.mp3`, cached: label === 'swallow' } }));
  await audio.prepare(scene);
  const calls = globalThis.fetch.calls;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url === '/api/sfx' && c.init.method === 'POST' && c.init.headers['x-host-token'] === 'tok' && c.inflight === 1));
  assert.deepEqual(JSON.parse(calls[0].init.body), { label: 'train', prompt: 'one short whistle' });
  assert.deepEqual(audio.stats(), { played: 0, generated: 1, cached: 1 });
  assert.equal(todayCount(JSON.parse(mem.get('tt.sfxday')), dayStamp(new Date())), 1);

  assert.equal(await audio.play('poke', { label: 'Train', kind: 'vehicle' }), true);
  assert.equal(await audio.play('poke', { label: 'Bridge', kind: 'building' }), true);
  assert.deepEqual(plays.map((p) => p.src), ['https://blob.example/sfx/train.mp3', '/sfx/bell.mp3']);
  assert.ok(plays.every((p) => p.volume === audio.GAIN));
  assert.equal(flashes.length, 2);
  assert.ok(flashes.every((t) => t.startsWith('poke · ') && t.endsWith(' · ElevenLabs')));
  assert.match(flashes[1], /bell\.mp3/);
  assert.equal(await audio.play('describe', { label: 'Train', kind: 'vehicle' }), true); // its generated sound is ready
  assert.equal(plays[2].src, 'https://blob.example/sfx/train.mp3');
  assert.equal(await audio.play('describe', { label: 'Bridge', kind: 'building' }), true); // none made: the tick
  assert.equal(plays[3].src, '/sfx/poke.mp3');
  assert.equal(flashes[3], 'describe · poke.mp3 · ElevenLabs');

  await audio.prepare(scene); // same scene again: both labels known, nothing spent
  assert.equal(calls.length, 2);
});

test('no token sends no header; 204 or 401 stops asking for the session', async () => {
  fresh(() => ({ status: 204 }), '');
  await audio.prepare(scene);
  assert.equal(globalThis.fetch.calls.length, 1);
  assert.equal('x-host-token' in globalThis.fetch.calls[0].init.headers, false);
  await audio.prepare({ objects: [obj('Moon', 'celestial')] });
  assert.equal(globalThis.fetch.calls.length, 1);
  assert.equal(await audio.play('poke', { label: 'Train', kind: 'vehicle' }), true);
  assert.equal(plays[0].src, '/sfx/vehicle.mp3');
});

test('url:null, bad urls and a throwing fetch keep the palette and never reject', async () => {
  fresh(({ label }) => ({ body: label === 'train' ? { url: null } : { url: 'javascript:alert(1)' } }));
  await audio.prepare(scene);
  assert.deepEqual(audio.stats(), { played: 0, generated: 0, cached: 0 });
  globalThis.fetch = async () => { throw new Error('offline'); };
  await audio.prepare({ objects: [obj('Moon', 'celestial')] });
  assert.equal(await audio.play('poke', { label: 'Moon', kind: 'celestial' }), true);
  assert.equal(plays[0].src, '/sfx/twinkle.mp3');
});

test('the day cap stops generation at 25', async () => {
  fresh(() => ({ body: { url: 'https://blob.example/x.mp3', cached: false } }));
  mem.set('tt.sfxday', JSON.stringify({ day: dayStamp(new Date()), n: DAY_CAP - 1 }));
  await audio.prepare(scene);
  assert.equal(globalThis.fetch.calls.length, 1);
  assert.equal(todayCount(JSON.parse(mem.get('tt.sfxday')), dayStamp(new Date())), DAY_CAP);
});

test('mute persists, silences everything and survives a re-init', async () => {
  const flashes = fresh(() => ({ status: 204 }));
  assert.equal(audio.toggleMute(), true);
  assert.equal(mem.get('tt.mute'), '1');
  audio.init({ token: '', margins: { flash: (t) => flashes.push(t) } });
  assert.equal(await audio.play('join'), false);
  assert.equal(plays.length, 0);
  assert.equal(audio.toggleMute(), false);
  assert.equal(mem.get('tt.mute'), '0');
  assert.equal(await audio.play('join'), true);
  assert.equal(audio.stats().played, 1);
});

test('missing files, blocked autoplay and unknown events are quiet', async () => {
  const flashes = fresh(() => ({ status: 204 }));
  playResult = () => fail('NotSupportedError');
  assert.equal(await audio.play('save'), false);
  playResult = () => fail('NotAllowedError');
  assert.equal(await audio.play('gallery'), false);
  assert.equal(await audio.play('explode'), false);
  playResult = () => { throw new Error('sync'); };
  assert.equal(await audio.play('reset'), false);
  assert.equal(flashes.length, 0);
  assert.equal(audio.stats().played, 0);
});

test('a generated sound that will not load falls back to the kind file', async () => {
  fresh(() => ({ body: { url: 'https://blob.example/gone.mp3', cached: true } }));
  await audio.prepare({ objects: [obj('River', 'water')] });
  playResult = (src) => (src.startsWith('https:') ? fail('NotSupportedError') : Promise.resolve());
  assert.equal(await audio.play('poke', { label: 'River', kind: 'water' }), true);
  assert.deepEqual(plays.map((p) => p.src), ['https://blob.example/gone.mp3', '/sfx/water.mp3']);
  assert.equal(await audio.play('poke', { label: 'River', kind: 'water' }), true);
  assert.equal(plays[2].src, '/sfx/water.mp3');
});
