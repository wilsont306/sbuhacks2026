# Samples

The bundled scenes the TV can show with no network: boot and R load sample 1, keys 1, 2 and 3 load samples by number,
and the gallery (G) lists them as "sample" cards. `src/host/artwork.js` reads `index.json`; nothing here calls Gemini.

## Files

| File | What it is |
|---|---|
| `index.json` | `[{n, id, name, image, scene, credit}]`, `n` 1-based and in key order. `image` and `scene` are site-relative URLs; `name` is the gallery card title. |
| `turner.scene.json` | Sample 1. J. M. W. Turner, *Rain, Steam, and Speed – The Great Western Railway* (1844), image `/assets/turner-1920.jpg`. |
| `sketch.svg` | Sample 2's picture: a 1600 x 1200 ink-on-paper sketch (sun, cloud, house, tree, dog, river, path) drawn for this demo. |
| `sketch.scene.json` | Sample 2's scene. |
| `starry-night.jpg` | Sample 3's picture: Vincent van Gogh, *The Starry Night* (1889), a 1920 x 1520 public-domain scan. |
| `starry-night.scene.json` | Sample 3's scene. |

Every scene file is in the SCENE contract (`src/shared/scene-validate.js`, README "Scene"): `source: 'sample'`,
`edited: true`, `ai_draft: true`, `model: 'hand-corrected'`, `id: 'sample-<name>'`, `scene_url: ''`, `image_url` the
same path as the index's `image`, and `credit` set, so the margin chip reads "AI draft, hand-corrected (sample)".
Each file stays under 60 KB.

## How they were made

- **Turner:** the eight masks (locomotive, hare, boat, viaduct, river, old road bridge, steam, sky) were placed by hand
  on a gridded render of the painting, in image space 0 to 1000. `ground_path` is v1's walk along the near bank:
  `public/path.json` points converted with `x = u * 1000`, `y = (1 - v) * 1000`. That path only covers the left
  bank, so `objectHotspots` gives six hotspots: river, boat, old bridge, then locomotive, hare and viaduct packed at
  the far end. Steam and sky get no hotspot, but they still move.
- **Sketch:** the SVG uses `viewBox="0 0 1000 1000"` stretched to 1600 x 1200 (`preserveAspectRatio="none"`), so
  each filled `<polygon>` in it uses exactly the points of its object's `mask`. The ink wobble is an SVG displacement
  filter that moves lines by about 2 units at most. `ground_path` is the centre line of the drawn garden path.

All three scene files went through `validateScene(raw, meta, {maskFrame: 'image'})` and were written as it returned
them. Check that they still re-validate to themselves (run from the repo root):

```sh
node --input-type=module -e "import {readFileSync as r} from 'node:fs'; import {validateScene as v} from './src/shared/scene-validate.js'; import {deepStrictEqual as eq} from 'node:assert'; for (const e of JSON.parse(r('public/samples/index.json'))) { const s = JSON.parse(r('public' + e.scene)); eq(v(s, {}, {maskFrame: 'image'}), s); console.log('ok', e.id, s.objects.length, 'objects'); }"
```

## Sample 3: The Starry Night (done)

It is in: `index.json` has entry 3, so key 3 loads it and the gallery shows its card. How it was made:

1. **Image:** the public-domain scan from Wikimedia Commons ("Van Gogh - Starry Night - Google Art Project.jpg"),
   saved as `starry-night.jpg` at 1920 x 1520 (1.4 MB). That is over the 1 MB first planned here; the team chose the
   1920 px copy for the TV. The 60 KB limit is for scene files, not images.
2. **Masks:** eight objects placed by hand on a gridded render of the painting, in image space 0 to 1000, with no
   `/api/interpret` call: cypress (`plant`, `sway`), crescent moon (`celestial`, `twinkle`), church spire and the
   village (`building`, `none`), the great white star right of the cypress and the smaller star left of it
   (`celestial`, `twinkle`), hills (`ground`, `none`) and the swirling sky (`sky`, `drift`). Sky and hills share one
   ridge line, which the cypress hides between x 140 and 350. The other stars stay part of the sky: one mask cannot
   cover scattered stars, and the contract allows 8 objects.
3. **Path:** `ground_path` starts on the foreground hill at the bottom left, passes the cypress's foot and runs along
   the village street just below the church (y 915 to 884). It spans the width, so `objectHotspots` gives all eight
   objects a stop, in walk order: star by the cypress, cypress, great white star, hills, sky, church spire, village,
   then the moon at the far end.
4. **Validation:** the raw scene went through the validator with `{id: 'sample-starry-night', source: 'sample',
   edited: true, model: 'hand-corrected', scene_url: '', image_url: '/samples/starry-night.jpg', generated_at:
   '2026-10-24T09:00:00.000Z', credit: 'Vincent van Gogh, 1889. The Museum of Modern Art, New York. Public domain
   (Wikimedia Commons).'}` and `{maskFrame: 'image'}`, and was written as it returned it (4.8 KB). The painting's
   source and licence are in `CREDITS.md`.
