# Credits

## The paintings

Joseph Mallord William Turner, *Rain, Steam, and Speed – The Great Western Railway*, 1844. The National Gallery, London, NG538. A public-domain scan via Wikimedia Commons, used as `public/assets/turner-1920.jpg`.

Commons file page:

Vincent van Gogh, *The Starry Night*, 1889. The Museum of Modern Art, New York. A public-domain scan (Google Art Project) via Wikimedia Commons, used at 1920 x 1520 as `public/samples/starry-night.jpg` for sample 3.

Commons file page: https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg

## Depth

Depth Anything V2 Small (`depth-anything/Depth-Anything-V2-Small-hf`), Apache-2.0. Only the Small checkpoint has this licence, so `tools/depth.py` uses only that one. The model runs once on the scan, offline, and writes `public/depth/turner-depth.png`.

## Type

All three faces are vendored through @fontsource 5.3.0 under the SIL Open Font License 1.1. Nothing is fetched from a font CDN at runtime.

- IM Fell English
- Libre Franklin
- JetBrains Mono

## Libraries

Each licence below is read from the package's own `package.json` in `node_modules`.

| Package | Version | Licence | Used in |
|---|---|---|---|
| three.js | 0.128.0 (r128) | MIT | host page |
| ws | 8.22.0 | MIT | relay (`api/ws.js`, `hub.js`) |
| express | 4.22.3 | MIT | laptop hub (`hub.js`) |
| ioredis | 6.0.0 | MIT | relay bus on Vercel (`hub/redisBus.js`) |
| @google/genai | 2.31.0 | Apache-2.0 | `lib/gemini.js` (Gemini, for `api/interpret.js`) |
| @elevenlabs/elevenlabs-js | 2.74.0 | MIT | `api/sfx.js` (sound effects) |
| @vercel/blob | 2.8.2 | Apache-2.0 | api functions (images, scenes, sound cache) |
| @vercel/functions | 3.10.3 | Apache-2.0 | api functions (`waitUntil`) |
| qrcode-generator | 1.4.4 | MIT | host page (join QR) |
| nosleep.js | 0.12.0 | MIT | join page (wake lock fallback) |
| vite | 5.4.21 | MIT | build only |

The three @fontsource 5.3.0 packages under Type read `OFL-1.1` by the same check.

## Borrowed patterns

- `api/ws.js` follows the plain Node example in Vercel's WebSockets documentation: an `http.createServer()` with a `ws` `WebSocketServer` on it, exported as the function.
- The relay's Redis pub/sub fan-out across Function instances follows Vercel's multiplayer-cursors guide (Vercel WebSockets with Upstash Redis): each message carries its instance id, so an instance drops its own echo.

## Services

- Vercel: the pages, the API functions, Blob storage and the WebSocket relay (Hobby plan, non-commercial).
- Upstash Redis, from the Vercel Marketplace: the relay's pub/sub bus (free plan).
- Google Gemini API: reads an artwork into the scene description our renderer builds (free tier).
- ElevenLabs: sound effects, free plan, non-commercial, with attribution. Sound: elevenlabs.io.
- Snowflake: saved projects, through the SQL REST API with key-pair authentication (trial account).

## Sources

- J. Heyman, *The Masonry Arch* (1982): the thrust-line method behind Fig. 2 and `lib/heyman.js`.
- Grace's Guide to British Industrial History: card source.
- The National Gallery's entry for NG538: card source and wall label.

Each card's own source line is in `src/shared/cards.json`.

## AI tools

See "AI tools" in `README.md`.
