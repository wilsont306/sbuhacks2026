// node tools/depth.mjs  ->  public/samples/<name>.depth.png for every sample in public/samples/index.json, and
// depth_url '/samples/<name>.depth.png' in that sample's scene file. Depth Anything V2 Small (Apache-2.0) through
// transformers.js on the CPU, dtype q8 (about 26 MiB, downloaded once into node_modules/@huggingface/transformers/.cache).
// The PNG is the TV's own depth format (src/host/depthAI.js): 8-bit grayscale, 255 nearest, at most 512 px long side.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScene } from '../src/shared/scene-validate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MODEL = 'onnx-community/depth-anything-v2-small';
export const REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d'; // pinned, so a repo change upstream cannot move the samples
export const IN_MAX = 1024, OUT_MAX = 512;
// Samples whose phone room stays on the plain planes, so they get no depth_url: Turner's depth room stands the haze as a
// near slab and pulls the locomotive out of the walk's view (README, Inside view). The TV still estimates its own.
export const PLANES = ['turner'];

// '/samples/turner.scene.json' -> 'turner'
export const sampleName = (sceneUrl) => path.posix.basename(sceneUrl).replace(/\.scene\.json$/, '');

// The scene file's text with depth_url set: an existing depth_url line replaced, else one added after scene_url, so
// the hand-formatted file keeps its layout. Throws when there is no scene_url line to anchor it.
export function withDepthUrl(text, url) {
  const line = (indent) => `${indent}"depth_url": ${JSON.stringify(url)},`;
  const old = /^([ \t]*)"depth_url": .*,(\r?)$/m, anchor = /^([ \t]*)("scene_url": .*,)(\r?)$/m;
  if (old.test(text)) return text.replace(old, (_, i, cr) => line(i) + cr);
  if (!anchor.test(text)) throw new Error('no "scene_url" line to put depth_url after');
  return text.replace(anchor, (_, i, body, cr) => `${i}${body}${cr}\n${line(i)}${cr}`); // the line's own \n ends the new one
}

const fit = (w, h, max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };

async function main() {
  const { pipeline, RawImage } = await import('@huggingface/transformers');
  const samples = JSON.parse(readFileSync(path.join(ROOT, 'public', 'samples', 'index.json'), 'utf8'));
  let t = performance.now();
  const est = await pipeline('depth-estimation', MODEL, { revision: REVISION, dtype: 'q8' });
  console.log(`model ready in ${Math.round(performance.now() - t)} ms`);
  for (const s of samples) {
    const name = sampleName(s.scene), out = `/samples/${name}.depth.png`, sceneFile = path.join(ROOT, 'public', s.scene);
    if (PLANES.includes(name)) { console.log(`${name}: skipped (planes)`); continue; }
    t = performance.now();
    const img = await RawImage.read(path.join(ROOT, 'public', s.image));
    const { depth } = await est(await img.resize(...fit(img.width, img.height, IN_MAX))); // the output comes back at the input size
    const small = await depth.resize(...fit(depth.width, depth.height, OUT_MAX));
    if (small.channels !== 1) throw new Error(`${name}: depth has ${small.channels} channels`);
    // RawImage.save would widen one channel to sRGB; b-w keeps the PNG 8-bit grayscale (D1)
    await small.toSharp().toColourspace('b-w').png({ compressionLevel: 9 }).toFile(path.join(ROOT, 'public', out));
    const text = withDepthUrl(readFileSync(sceneFile, 'utf8'), out), scene = JSON.parse(text);
    if (validateScene(scene, {}, { maskFrame: 'image' }).depth_url !== out) throw new Error(`${name}: depth_url did not validate`);
    writeFileSync(sceneFile, text);
    const kb = statSync(path.join(ROOT, 'public', out)).size / 1024;
    console.log(`${name}: ${img.width}x${img.height} -> ${small.width}x${small.height} in ${Math.round(performance.now() - t)} ms, ${kb.toFixed(1)} KB`);
  }
  await est.dispose();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err) => { console.error(err && err.message); process.exitCode = 1; });
