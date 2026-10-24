// node --env-file=.env tools/sfx.mjs [--only <file>] [--dry-run]  ->  public/sfx/<file>.mp3 from tools/sfx-palette.json
// Generates the missing palette files serially through ElevenLabs Sound Effects, in palette (priority) order, and
// stops at the first error. Delete a file to regenerate it. --dry-run lists the plan and its cost without a key.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBuffer } from '../api/sfx.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PALETTE = path.join(ROOT, 'tools', 'sfx-palette.json');
export const OUT_DIR = path.join(ROOT, 'public', 'sfx');
// The documented rate when duration_seconds is set; without it a generation is billed flat at 200.
export const CREDITS_PER_SECOND = 40;
export const MODEL = 'eleven_text_to_sound_v2';

export function validatePalette(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('palette must be a non-empty array');
  const seen = new Set();
  list.forEach((e, i) => {
    const where = `palette[${i}]`;
    if (!e || typeof e.file !== 'string' || !/^[a-z0-9-]{1,32}$/.test(e.file)) throw new Error(`${where}: file must be a short lowercase name without .mp3`);
    if (seen.has(e.file)) throw new Error(`${where}: duplicate file ${e.file}`);
    seen.add(e.file);
    if (typeof e.prompt !== 'string' || !e.prompt.trim() || e.prompt.length > 450) throw new Error(`${where}: prompt must be 1 to 450 characters`);
    if (typeof e.seconds !== 'number' || !(e.seconds >= 0.5 && e.seconds <= 30)) throw new Error(`${where}: seconds must be 0.5 to 30`);
    if (typeof e.loop !== 'boolean') throw new Error(`${where}: loop must be true or false`);
  });
  return list;
}

// The entries still to generate, in palette order.
export function plan(palette, exists, only) {
  const want = only ? palette.filter((e) => e.file === only.replace(/\.mp3$/, '')) : palette;
  if (only && !want.length) throw new Error(`no palette entry named ${only}`);
  return want.filter((e) => !exists(e.file));
}

export const cost = (entries) => entries.reduce((s, e) => s + e.seconds * CREDITS_PER_SECOND, 0);

// Free-plan credits are reported as characters; null when the key cannot read its subscription.
export async function remainingCredits(client) {
  try {
    const s = await client.user.subscription.get();
    return Number.isFinite(s.characterLimit) && Number.isFinite(s.characterCount) ? s.characterLimit - s.characterCount : null;
  } catch { return null; }
}

export async function run({ client, palette, dir = OUT_DIR, only = null, log = console.log }) {
  const target = (file) => path.join(dir, `${file}.mp3`);
  const todo = plan(palette, (file) => existsSync(target(file)), only);
  if (!todo.length) { log('nothing to generate: every palette file already exists'); return { written: [] }; }
  log(`${todo.length} to generate, about ${cost(todo)} credits at ${CREDITS_PER_SECOND} a second`);
  mkdirSync(dir, { recursive: true });
  const start = await remainingCredits(client);
  log(start === null ? 'credits left: unknown (the key cannot read its subscription)' : `credits left: ${start}`);
  let last = start;
  const written = [];
  for (const e of todo) {
    const t0 = Date.now();
    // Retries are off: a retried generation is billed again.
    const audio = await client.textToSoundEffects.convert(
      { text: e.prompt, durationSeconds: e.seconds, loop: e.loop, promptInfluence: 0.5, modelId: MODEL, outputFormat: 'mp3_44100_128' },
      { maxRetries: 0, timeoutInSeconds: 60 });
    const buf = await toBuffer(audio);
    if (!buf.length) throw new Error(`${e.file}: ElevenLabs returned no audio`);
    writeFileSync(target(e.file), buf);
    written.push(e.file);
    const now = await remainingCredits(client);
    const spent = last !== null && now !== null ? `, spent ${last - now} (${((last - now) / e.seconds).toFixed(0)} a second), ${now} left` : '';
    log(`wrote ${e.file}.mp3: ${e.seconds} s${e.loop ? ' loop' : ''}, ${(buf.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms${spent}`);
    last = now;
  }
  if (start !== null && last !== null) log(`credits: ${start} before, ${last} after, ${start - last} spent`);
  return { written };
}

function folderKb(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.mp3')).reduce((s, f) => s + statSync(path.join(dir, f)).size, 0) / 1024; } catch { return 0; }
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--only'), only = i >= 0 ? args[i + 1] : null;
  if (i >= 0 && !only) { console.error('usage: node tools/sfx.mjs [--only <file>] [--dry-run]'); process.exit(1); }
  const palette = validatePalette(JSON.parse(readFileSync(PALETTE, 'utf8')));
  if (args.includes('--dry-run')) {
    const todo = plan(palette, (file) => existsSync(path.join(OUT_DIR, `${file}.mp3`)), only);
    for (const e of todo) console.log(`${e.file}.mp3  ${e.seconds} s${e.loop ? ' loop' : ''}  ~${e.seconds * CREDITS_PER_SECOND} credits  "${e.prompt}"`);
    console.log(`${todo.length} to generate, about ${cost(todo)} credits`);
    return;
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('ELEVENLABS_API_KEY is not set; refusing to run. Use node --env-file=.env tools/sfx.mjs, or --dry-run to see the plan.');
    process.exit(1);
  }
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY, maxRetries: 0, timeoutInSeconds: 60 });
  try {
    await run({ client, palette, only });
  } catch (err) {
    console.error(`stopped: ${err && err.message}`);
    const left = await remainingCredits(client);
    if (left !== null) console.error(`credits left: ${left}`);
    process.exitCode = 1;
  }
  console.log(`public/sfx holds ${folderKb(OUT_DIR).toFixed(0)} KB of mp3`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err) => { console.error(err && err.message); process.exitCode = 1; });
