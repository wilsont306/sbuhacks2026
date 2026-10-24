# Living Blueprint: Toy Theatre

A gallery interactive for any artwork. A visitor drops a picture on the exhibit laptop or photographs one (a painting, a postcard, a paper sketch) with their phone. Google Gemini reads it into a scene: named objects, their outlines, a depth guess and how each kind moves. The TV builds a depth relief from that reading in our own shader, and every object moves by its kind. Any visitor scans one code, their phone becomes the controller, and a cut-paper figure walks the picture and pokes the object it stands at. ElevenLabs sounds play and are named on screen, and Snowflake saves each project for the TV gallery. Every AI label is marked as a guess, and the original is one key or tap away. Two hand-corrected samples ship in the repo and play with no network: J. M. W. Turner, *Rain, Steam, and Speed – The Great Western Railway* (1844, The National Gallery, London, NG538, public domain), and a sketch drawn for the demo.

Built at SBUHacks 2026 (Stony Brook University, Oct 23 to 25).

Version 2 (Sat Oct 24) moved the realtime relay onto Vercel (Vercel WebSockets fanned out by Upstash Redis, with the host tab owning seats and tokens). It also replaced v1's one painting and three brass plaques with any artwork read by Gemini, plus ElevenLabs sound and Snowflake saves. The v2 PRD puts v1's plaques, engineering panels, STL export and print out of scope. Their pure code (`lib/archGeometry.js`, `heyman.js`, `stl.js`, `crankSlider.js`, `tools/export-arch.mjs`) stays in the repo with its tests, wired to no page. The sections below describe the code as it stands.

<!-- The sections below are the frozen contract. Every module is built against them; change code and README together. -->

## Layout

```
hub.js                 the laptop hub: serves dist/ and runs hub/relay.js (port 8080 in dev, port 80 for the Q fallback)
hub/                   relay.js (the stateless relay, shared by hub.js, api/ws.js and the tests), redisBus.js (its Redis pub/sub bus on Vercel)
api/                   Vercel Functions: ws.js (the relay at /api/ws), interpret.js (image to scene: Blob + Gemini, saved to Snowflake), projects.js (Snowflake list and get), sfx.js (ElevenLabs sounds cached in Blob), check.js (tests a key or a platform for the API box)
host.html              the TV page (Vite entry) -> dist/host.html, served at /host?host=TOKEN
join.html              the phone page (Vite entry) -> dist/join.html, served at /
src/shared/            protocol.js (constants, WS_PATH, hubUrl; it still exports v1's plaque, slider and owner constants, which nothing imports), scene-validate.js (the scene contract), downscale.js (a picture to a 1024 px JPEG, for the TV and the phone), byok.js (the visitor's own API keys: storage, request headers, masking), slots.json, tokens.css (every colour, font, size and spacing token), learning.json (the L overlay's entries); cards.json (v1's plaque cards, no longer imported)
src/host/              main.js -> scene.js (Three.js stage, window.game) + glue.js (relay socket, players, phone panels, hotspot events, roster, HUD, QR, resting panel, H/J/R/Q) + apibox.js (the API plug-in box and its margin button, K). glue.js inits audio.js (sound bus, S), margins.js (wall label, legend, source block, platform panel, Learning overlay; L, X) and artwork.js (drop, U, phone pictures, samples 1/2/3, G gallery; its pure helpers are in gallery.js). Also slots.js (seats, tokens, cap), maskDepth.js (a scene to its depth map, id map, path and hotspots), and the stage's helpers depth.js, figures.js, camera.js and pathOverlay.js. Each module that draws has its own CSS file.
src/join/              main.js, join.css (the controller)
lib/                   gemini.js (read the artwork), snowflake.js (SQL REST with a key-pair JWT); v1's archGeometry.js, heyman.js, stl.js, crankSlider.js (pure, node:test, wired to no page)
sql/                   projects.sql (the Snowflake user, key and PROJECTS table, run once in Snowsight)
public/                assets/turner-1920.jpg, path.json (v1's bank path), samples/ (index.json, turner.scene.json, sketch.svg, sketch.scene.json, README.md). Not in the repo yet: sprites/*.png, sfx/*.mp3
tools/                 start.cmd (the Q fallback kiosk), sfx.mjs + sfx-palette.json (the ElevenLabs palette); v1's depth.py and export-arch.mjs (no page reads their output)
tests/                 *.test.js (node --test): relay, slots, glue, camera, lib, scene-validate, maskDepth, interpret (lib/gemini.js, api/interpret.js), sfx (api/sfx.js, tools/sfx.mjs), check (api/check.js), snowflake (lib/snowflake.js, api/projects.js, sql/projects.sql), artwork (src/host/gallery.js), audio, margins, byok (src/shared/byok.js); gates.md
vercel.json            build to dist, rewrites for / and /host, no-cache headers, maxDuration 300 for api/ws.js (30 for interpret and sfx, 15 for projects and check)
```

## URLs

- Join page at `/`, host page at `/host?host=TOKEN` (`/host.html?host=TOKEN` in `npm run dev`). On Vercel the host page is a static file; the relay checks the token when the host socket connects (4003). With `HOST_TOKEN` set, the laptop hub also refuses the page itself without it (403).
- WebSocket at `/api/ws` everywhere: the Vercel Function `api/ws.js`, the laptop hub, and Vite's dev proxy (to the hub on 8080). The laptop hub also accepts `/ws`, for kiosks and links set up before the move.
- Health: a plain GET of `/api/ws` on Vercel answers that instance's `{ok, instance, host, sockets, region, bus}`; the laptop hub answers `/healthz` with `{ok, instance, host, sockets, uptime, region, joinUrl}`.
- WebSocket URL (`hubUrl()` in `src/shared/protocol.js`): the page's own origin plus `/api/ws` (ws on http, wss on https). `?hub=` overrides it: `localhost` or `host:port` (ws, plus `/api/ws`), a full `ws://` or `wss://` URL (used as is), or an `http(s)://` origin (plus `/api/ws`).
- The host appends `role=host&host=<token>` to the ws URL; the token comes from the host page's `?host=` query. Q switches the host socket between that URL and `ws://localhost/api/ws` (the laptop hub on port 80).
- `?roll=<ms>` on either page replaces the socket rollover interval (see Protocol), for testing it.

## Protocol

All messages are JSON objects with a `t` field. Three parties: the phones, the relay (`hub/relay.js`, inside `api/ws.js` on Vercel and `hub.js` on the laptop) and the one host tab (the TV). The relay holds no game state. It stamps each phone socket with a random `cid`, type-checks phone messages and routes. The host tab owns seats, tokens, colours and every rule: `src/host/slots.js` for seats, `src/host/glue.js` for the rest. Relay instances share messages over a bus: Redis pub/sub on Vercel (`hub/redisBus.js`, channels `tt:host`, `tt:phones` and `tt:ctl`, each message tagged with its instance so an instance drops its own echo), and an in-process broker on the laptop and in the tests. A phone message goes straight to the host socket when the host sits on the same instance (no Redis command) and over the bus only when it does not; every message reaches exactly one host socket. Player sockets are capped at 1 KB per message and 20 messages per second (the rest of that second is dropped); the host socket is exempt from both.

Player -> relay

| Message | When |
|---|---|
| `{t:'hello', token, slot}` | Join or rejoin. Sent on open when the phone has a stored token, else when the visitor taps a colour; also on a rollover socket and in answer to `who`. `token` is the stored token or `null` (a string over 64 characters becomes `null`). `slot` (0 to 5, an integer, else `null`) is the colour the visitor tapped; ignored on a token reconnect or if taken. |
| `{t:'here'}` | Answer to `who` from a phone with no seat and no pending `hello`: send me the lobby. |
| `{t:'in', lx, a}` | `lx` -1, 0 or 1 (walk left, stop, right); `a` 0 or 1 (the verb button held). Sent on every change plus a 4 Hz heartbeat while any input is non-zero (`INPUT_HZ`; on Vercel each one is a Redis command when the host sits on another instance). |
| `{t:'panel', kind, value}` | The phone sends two kinds. `original` is Show the original on the TV (`value` 1). `artwork` is the phone's photo handoff: `value` is the scene file `/api/interpret` just stored, an `https://<store>.public.blob.vercel-storage.com/scenes/<id>.json` URL, and the relay drops an `artwork` message with any other value. For every other kind the relay keeps the first 16 characters of `kind` and turns a non-number `value` into 0; the host ignores those kinds, though they still count as activity for idle kicks (see Phone panels). |
| `{t:'hbr', ts}` | Echo of a host heartbeat `{t:'hb', ts}`, for round-trip time. Joined phones only. |

The relay passes these five types with these fields only (`clean()` in `hub/relay.js`) and drops everything else.

Relay -> player

| Message | When |
|---|---|
| `{t:'hb', i}` | Every 2 s from the relay instance the socket is on; `i` is that instance's id (for the network layer). No `ts`: the socket is alive. The phone arms its 5 s watchdog on its first `hb` or `welcome`. Every other message, and an `hb` that carries `ts`, counts as host traffic; after 6 s without any the phone shows "The screen is resting". |
| close 1013 / 1009 / 1008 | More than 12 phone sockets on this instance / a phone message over 1 KB / an unparsable request URL. |
| anything the host sends with `to`, `all` or `close` | Forwarded verbatim. |

Host -> player (the host sends these with `to`, `all` or `close`; the relay delivers them)

| Message | Meaning |
|---|---|
| `{t:'lobby', free:[slot…]}` | When the relay reports a new socket (`open`), in answer to `here`, and again to every socket without a seat whenever a seat is taken or freed or the cap changes. Empty when the seats are at the cap. The phone ignores it once it has sent `hello`. |
| `{t:'welcome', pid, token, color, name, slot}` | Reply to `hello` (also to a repeated `hello` on the socket that already holds the seat). Store `token` in localStorage. |
| `{t:'full'}` | Reply to `hello` when no slot is free (or the host's cap is reached). The phone retries every 3 s. |
| `{t:'evicted', reason}` then close 4001 | Sent with `close`. Kicked by the host (`idle`, `judge`), the seat hold expired (`timeout`), or a later `hello` with a kicked token (with the kick's reason, so a phone that was away at the kick cannot rejoin by itself). The phone clears its token and stops auto-reconnecting. |
| `{t:'who'}` | Sent with `all` whenever the host's relay socket opens after a gap (not on its own rollover). A phone with a seat answers `hello` with its token, a phone waiting on a `hello` repeats it, and any other phone answers `here`. |
| `{t:'mode', mode}` | `mode` is `walk` or `reset`. Either one shows the phone's walk screen, the only seated screen; `reset` also sets the verb back to "Walk to something". The host sends `walk` on every `join` and `back` (a `who` answer included), followed by `near`, and sends `reset` to every phone on R. |
| `{t:'near', label}` | The phone's figure reached an object's stop (`label` is that object's AI label from the scene) or left it (`null`). The verb button reads "Poke the <label>" (the first 40 characters), else "Walk to something" with `aria-disabled="true"`. Sent on every change, and after every `mode` `walk` with the last label the host recorded for that phone. |
| `{t:'readout', text}` | A one-off line the phone toasts for 4 s: "You poked the <label>", "Showing the original on the screen for 8 s", "Show the original again in <n> s", "Your picture is on its way to the TV", "One picture every 20 s", "Pictures are paused for the guided tour", "The TV couldn't open that picture; try another". |
| `{t:'hb', ts}` | Host heartbeat every 2 s (sent with `all`); a joined phone answers `{t:'hbr', ts}`. |

`all` reaches every phone socket, with or without a seat; a phone without a seat ignores `mode`, `near` and `readout`.

Relay -> host

| Message | When |
|---|---|
| `{t:'hub', joinUrl, lanIp, region, wifi, bus, instance}` | On host connect. `joinUrl` is what the QR encodes: `JOIN_URL` env, else `https://<request host>/` on Vercel and `http://<lanIp>[:port]/` on the laptop. `lanIp` is `null` on Vercel. `region` is `VERCEL_REGION` (or `vercel`) on Vercel and `local` on the laptop. `wifi` is `{ssid, pass}` from `WIFI_SSID`/`WIFI_PASS` on the laptop, else `null`. `bus` is `redis` or `local` (`local` on Vercel means no Redis URL is set; the HUD then says "no redis"). `instance` is a random id per relay instance. |
| `{t:'open', cid}` | A phone socket opened, on any instance. |
| `{t:'gone', cid}` | That phone socket closed. |
| `{t:'hello', cid, token, slot}` / `{t:'here', cid}` / `{t:'in', cid, lx, a}` / `{t:'panel', cid, kind, value}` / `{t:'hbr', cid, ts}` | Phone messages, cleaned and stamped with the socket's `cid`. |

The relay sends no `stats`, `join`, `away`, `back` or `leave` any more; the host makes those itself (see Seats).

Host -> relay

| Message | Effect |
|---|---|
| `{t:'to', cid, msg}` | Forward `msg` to that phone socket, on whichever instance holds it. |
| `{t:'all', msg}` | Forward `msg` to every phone socket on every instance. |
| `{t:'close', cid, code, reason, msg?}` | Send `msg` if there is one, then close that socket with `code`. Only 4001 (evicted) and 4002 (replaced) are accepted; `reason` is cut to 32 characters. |

Anything else from the host is ignored. There is no `kick` or `cap` message: the host applies both itself.

Seats (`src/host/slots.js`, in the host tab)

- Six seats, one per colour in `slots.json`. The cap is 6 (`setCap` clamps to 0 to 6; the host sets 6 on connect and on R). With the seats at the cap the lobby is empty and a new `hello` gets `full`.
- A new `hello` (no token, or one the host does not know) takes the tapped slot if it is free, else the first free one. It gets a new random token (16 bytes, base64url) and the next pid. Pids start at 1 and are never reused, across host reloads too.
- A `hello` with a known token takes its seat back. If the seat's old socket is still open (a phone's rollover, a half-open socket, a second tab), the newest socket wins and the old one is closed with 4002. A close the host ordered while its own socket was down never reached the relay, so that socket still counts when it answers `who`. A seat that was away reports `back`, then `join`.
- When a seat's socket is `gone` the host zeroes the figure, reports `away` and holds the seat 20 s. When the hold runs out the seat drops (`leave`; a socket still bound to it gets `evicted`, reason `timeout`). A `gone` from a socket that no longer holds a seat (replaced by a newer one) is ignored.
- A kick remembers the token (the last 50 are kept), sends `evicted`, closes 4001 and reports `leave`. That token's later `hello` gets the same eviction.
- The host saves its seats, next pid, counters and kicked tokens to its localStorage (`tt.seats`) on every change. A host tab reloaded within 10 minutes restores its seats, each on a 20 s hold, so phones that answer `who` keep their pid and colour. Kicked tokens are restored whatever their age.
- Seat events reach glue.js as `{t:'join', pid, name, color}`, `{t:'away', pid}`, `{t:'back', pid}`, `{t:'leave', pid}`, `{t:'in', pid, lx, a}`, `{t:'panel', pid, kind, value}` and `{t:'hbr', pid, ts}`. These are the messages the v1 hub sent, so the player manager did not change. `addPlayer` is an upsert, so a repeated `join` is harmless.

Host replacement. There is one host across every instance, and the newest host socket wins. The relay closes an older host socket on its own instance with 4000 and publishes the new socket's id on `tt:ctl`. Every other instance then closes its own host socket with 4000 if that socket is older (by connect time, ties broken by id), so two TV tabs opened at the same moment leave exactly one host instead of closing each other. A host page closed with 4000 stops reconnecting and says "Another host tab took over". The exception is the old socket of its own rollover, whose close the page ignores.

Rollover (make-before-break). Vercel closes every WebSocket at the function's max duration (300 s on Hobby, `maxDuration` in `vercel.json`). Both pages therefore replace their socket 240 to 270 s after it opens (`ROLLOVER_MS` plus up to `ROLLOVER_JITTER_MS`; `?roll=<ms>` sets the interval exactly).

- Phone (after `welcome`): it opens a second socket and says `hello` with its token. When that socket gets `welcome`, the phone switches to it and closes the old one. The host has already closed the old cid with 4002, and the retiring socket ignores that close. Each socket rolls once, timed from when it opened (a later `welcome`, such as an answer to `who`, does not restart the clock), and a retiring socket does not answer `who`. If no `welcome` arrives within 5 s (`ROLL_WAIT_MS`), or the new socket closes first, the phone drops the new socket, keeps the old one, says `hello` on it again (the host may already have moved the seat) and tries again 30 s later; for 15 s a 4002 on that old socket counts as an ordinary drop that reconnects. An `evicted` on the new socket ends the session as usual. The seat, pid and colour stay the same and the figure does not stop.
- Host: it opens a second host socket with the same token and switches to it as soon as it opens; the relay closes the old one with 4000, which the page ignores. If the new socket has not opened within 5 s, the host keeps the old one and tries again 30 s later. A rollover is not a gap, so the host sends no `who`.

After a gap. Any other host reconnect is a gap: a dropped socket, a relay restart, or Q. Messages sent while the host was away went nowhere (`open`, `gone`, `hello`), so on open the host puts every live seat on a 20 s hold (`hostOpen()`), sets the cap to 6 and sends `all {t:'who'}`. Seats that answer keep their pid and colour; seats that stay silent drop when their hold ends. Phones without a seat answer `here` and get the lobby again. Meanwhile the figures stand still, phones whose own socket is still up show "The screen is resting", and the TV shows its resting panel 2 s after its socket dropped.

Phone reconnect. A phone that loses its socket retries after 0.5, 1, 2, 4 and then every 8 s, and shows "Reconnecting…" after 1 s. On open it says `hello` with its token, so it keeps its seat while the 20 s hold lasts. A connect that hangs (captive Wi-Fi) is retried after 5 s.

Close codes: 4000 host replaced by a newer host socket; 4001 evicted (phone stops auto-reconnect); 4002 `replaced`, the same token said `hello` on a newer socket (outside a rollover the old tab keeps its token, shows the end screen and stops auto-reconnect, so two tabs never steal the seat back and forth); 4003 bad host token; 1013 busy (more than 12 phone sockets on one relay instance); 1009 player message over 1 KB; 1008 an unparsable request URL (the pages reconnect after 1013, 1009 and 1008). On Vercel an upgrade waits for Redis to answer and is refused with HTTP 503 if Redis is silent for 4 s; the page retries with backoff.

## HTTP API

Four Vercel Functions beside the relay. They run on Vercel and under `vercel dev` (see Run it); the laptop hub and `npm run dev` serve only the pages and the relay, so these paths do not exist there. Every answer is JSON (except the 204) with `Cache-Control: no-store`. Each file also exports `createHandler()`, so the tests inject Blob, Gemini, ElevenLabs, Snowflake and `fetch`. Four callers use them. The TV's `artwork.js` sends `POST /api/interpret` with `source:'drop'` and calls `GET /api/projects` for the gallery and the save poll. The phone sends `POST /api/interpret` with `source:'phone'`. The TV's `audio.js` sends `POST /api/sfx`. The TV's `apibox.js` sends `POST /api/check`.

Bring your own key. The TV may add three request headers from the API box (see `src/host/apibox.js`): `x-gemini-key`, `x-gemini-model` and `x-elevenlabs-key`. `artwork.js` adds them to every site-relative `/api/` request (`/api/interpret` and `/api/projects`; never a Blob or sample URL), `audio.js` to `/api/sfx` and `apibox.js` to `/api/check`; only the fields the visitor set are sent, so a visitor with no keys sends exactly what the page sent before. The phone sends none. A key is valid when it matches `/^[A-Za-z0-9_.-]{20,200}$/` after trimming (`KEY_RE`); a blank or whitespace-only header means no key, and a malformed one (a repeated header included) is refused as below. `x-gemini-model` must be `gemini-3.5-flash-lite` or `gemini-3.8-flash` (`GEMINI_MODELS`); it is read only beside a valid `x-gemini-key`, and any other value is ignored. `KEY_RE`, `GEMINI_MODELS` and `userKey(req, header)` (`undefined` for no key, `null` for a malformed one, else the trimmed key) live in `api/interpret.js`; `api/sfx.js` and `api/check.js` import them. A visitor's key is used for that one request and never stored, logged or echoed: `api/interpret.js` gives it a fresh `@google/genai` client per request instead of `lib/gemini.js`'s cached one, `api/sfx.js` gives it a fresh ElevenLabs client and writes `[key]` in its place in any error line. What the key makes still lands in the team's stores: the image and scene in Blob and the row in Snowflake, and a sound in the shared Blob cache under its label.

`POST /api/interpret` (`api/interpret.js`): one artwork in, one scene out.

Request body `{image, source, name?, credit?}`. `image` is the picture as base64 (a `data:` prefix and line breaks are tolerated): JPEG, PNG or WebP, recognised by its first bytes, at least 100 bytes decoded. `source` is `drop` or `phone`; anything else becomes `drop`. `name` (at most 80 characters) and `credit` (at most 300, else `null`) are optional; control characters and runs of whitespace become one space. The body is capped at 1.5 MB (`MAX_BODY`, 1,572,864 bytes; a `Content-Length` over it is refused unread) and `image` at 2,048 characters less (`MAX_IMAGE_B64`), so the picture itself is at most about 1.1 MB.

The request checks answer at once, with no id:

| Status | Body | When |
|---|---|---|
| 405 | `{ok:false, reason:'method'}`, header `Allow: POST` | Not a POST. |
| 413 | `{ok:false, reason:'too_large'}` | The body is over 1.5 MB, or `image` over its cap. |
| 400 | `{ok:false, reason:'bad_body'}` | No body, not JSON, not a JSON object, or not fully received within 10 s. |
| 400 | `{ok:false, reason:'no_image'}` | `image` missing, empty or not a string. |
| 400 | `{ok:false, reason:'bad_image'}` | `image` is not base64. |
| 400 | `{ok:false, reason:'not_image'}` | It decodes to under 100 bytes, or to something other than JPEG, PNG or WebP. |

Past those checks every outcome is HTTP 200, so the page reads `ok` and never an HTTP error:

- `{ok:true, id, image_url, scene_url, scene}`. `id` is a new `crypto.randomUUID()`. The image is stored in Blob at `art/<id>.jpg` (`.png` or `.webp` for those types) and the scene at `scenes/<id>.json`, both public with no random suffix. `scene` is the validated scene (see Scene) that was stored; its `image_url` and `scene_url` are the same two URLs.
- `{ok:false, reason, id, image_url?, scene}`. `image_url` is there only when the image was stored. `scene` is `null` for every reason but `storage`.

| `reason` | Meaning |
|---|---|
| `bad_key` | The `x-gemini-key` header is malformed. Answered right after the request checks, with no id: `{ok:false, reason:'bad_key', scene:null}`. Gemini is not called, nothing is stored, and neither guard counts it. |
| `no_key` | `GEMINI_API_KEY` is not set and no valid `x-gemini-key` came. |
| `auth` | Gemini refused the key (401, 403, or a 400 naming the API key): the visitor's when one came, else the team's. No retry, no fallback. |
| `quota` | The last attempt was answered 429 (by the visitor's key's quota when one came), or this instance's hourly cap was reached (then there is no id and nothing was stored; never with a visitor's key). |
| `busy` | The same client was admitted less than `INTERPRET_MIN_GAP_MS` ago; no id, nothing stored. |
| `upstream` | The last attempt was answered 5xx. |
| `rejected` | The last attempt was answered with another 4xx. |
| `bad_json` | Gemini's answer was not a JSON object. |
| `network` | No HTTP answer from Gemini. |
| `timeout` | A Gemini attempt ran out of time (or there was no time to start one), or the 25 s budget ran out (then `scene` is `null` even if Gemini had answered). |
| `gemini` | The Gemini call threw without a reason (a bug, not an answer). |
| `storage` | A Blob write failed, or the image upload hung past its share of the budget. Without `image_url` the image was not stored and no scene file was written; with it, the scene file was not stored. `scene` is the validated scene either way, so the page can still play it, unsaved. `scene.scene_url` is `''` whenever the scene file was not stored. |
| `internal` | Anything else threw. |

`lib/gemini.js` also defines `bad_image` (no image data) and `error` (no attempt recorded); neither can reach this reply. The Gemini reason is the last attempt's (`classify()` in `lib/gemini.js`).

Two guards run after the request checks and before an id is made, per instance and in memory: a second request from one client (the first `x-forwarded-for` entry, else the socket address) less than `INTERPRET_MIN_GAP_MS` (8,000 ms) after its last admitted one gets `{ok:false, reason:'busy', scene:null}`, and one past `INTERPRET_MAX_PER_HOUR` (30) admitted requests in the last hour gets `{ok:false, reason:'quota', scene:null}`. Both are HTTP 200 with no id; nothing is stored, Gemini is not called, and refused requests count toward neither guard. The public join URL is how phones reach this endpoint, so these guards are what protects the small Gemini daily quota. A request with a valid `x-gemini-key` spends the visitor's own quota, so it skips `INTERPRET_MAX_PER_HOUR` and does not count toward it; the per-client gap (`busy`) still applies to it.

Budget: 25 s from the moment the request arrives, reading the body included (`BUDGET_MS`). The image upload and the Gemini read run side by side, and both stop 3 s early to leave the scene write and the reply. Gemini gets the primary model (a visitor's allowed `x-gemini-model`, else `GEMINI_MODEL`, else `gemini-3.5-flash-lite`), one retry on the same model after bad JSON, a 5xx, a timeout or a network error, then one call to `gemini-3.8-flash` unless the key was refused (none when the primary model is already that model): at most three attempts, each cut at 12 s, none started with under 2.5 s left. `scene.model` names the model that answered. At 25 s the reply is `timeout`, whatever is still running.

Snowflake: only after `ok:true` (both files stored, inside the budget), the row `{id, name, source, image_url, scene_url, scene, title_guess, artist_guess, credit}` goes to `waitUntil` and is sent after the reply. `name` is the request's `name`, else the title guess, else `Untitled`. `lib/snowflake.js` is imported only then, and posts the INSERT with `?async=true`, so Snowflake accepts it at once (202) and finishes it on its side; the Vercel log reads `snowflake save: <id> accepted, statementHandle <handle>`. Without the Snowflake env the save is skipped; a failed save is a log line. Neither changes the reply, so `ok:true` does not mean saved: `GET /api/projects?id=<id>` answers 200 once the row has landed.

`GET /api/projects` (`api/projects.js`): the saved projects, for the gallery and the "Saved to Snowflake" check.

| Request | Status | Body |
|---|---|---|
| `GET /api/projects` | 200 | `{ok:true, projects, configured:true}`: the newest 24 by `CREATED_AT`, each `{id, name, source, image_url, scene_url, title_guess, artist_guess, created_at}` (`created_at` an ISO time). `projects` is `[]` when the table is empty. |
| | 200 | `{ok:false, configured:true, error:'unavailable', projects:[]}`: Snowflake is configured but did not answer (the page's cue for "local only"). |
| | 200 | `{ok:true, projects:[], configured:false}`: no Snowflake env (see Env). The gallery shows "local only" whenever `ok` is false or `configured` is false. |
| `GET /api/projects?id=<id>` | 200 | `{ok:true, project}`: `{id, name, source, image_url, scene_url, title_guess, artist_guess, credit, created_at, scene}`, with `scene` parsed from the row (`null` if it is not JSON). |
| | 404 | `{ok:false}`: no such project, which is also the answer while its save is still in flight. |
| | 404 | `{ok:false, configured:false}`: no Snowflake env. |
| | 503 | `{ok:false, configured:true, error:'unavailable'}`: the lookup failed (Snowflake did not answer). |
| | 400 | `{ok:false, error:'bad id'}`: `id` is not 1 to 64 letters, digits, `_` or `-` starting with a letter or digit (an empty `?id=` included). Checked before the Snowflake env. |
| any other method | 405 | `{ok:false, error:'method not allowed'}`, header `Allow: GET`. |
| any request | 500 | `{ok:false, error:'unavailable'}`: the handler itself threw. |

Reads are synchronous SQL REST calls with a fresh key-pair JWT each, every HTTP call cut at 8 s; a read Snowflake answers 202 (a warehouse resuming) is polled four times over about 3 s, then counts as unavailable.

`POST /api/sfx` (`api/sfx.js`): a sound for one scene object.

Request body `{label, prompt}`: the object's `label` (at most 40 characters) and its `sound_prompt` (at most 200); either may be empty, not both. ElevenLabs hears `prompt`, else `label`. The sound is cached in Blob at `sfx/<sha1>.mp3`, keyed by the label lowercased with its whitespace collapsed (the prompt when there is no label), so a label is paid for once across every instance and every artwork.

| Status | Body | When |
|---|---|---|
| 405 | `{error:'POST only'}`, header `Allow: POST` | Not a POST. |
| 401 | `{url:null, error:'host token'}` | `HOST_TOKEN` is set and the `x-host-token` header does not equal it (compared in constant time). Checked before `SOUND_GEN` and before the body is read; an empty `HOST_TOKEN` means no check, local only. Only the host page calls this endpoint, with its `?host=` token. |
| 400 | `{url:null, error:'bad key'}` | The `x-elevenlabs-key` header is malformed. Checked after the host token and before `SOUND_GEN` and the body. |
| 204 | none | `SOUND_GEN` is not exactly `on` and no valid `x-elevenlabs-key` came. Checked before the body is read; nothing is generated. |
| 400 | `{url:null, error}` | `error` is `invalid JSON body` (bad JSON, or a streamed body over 4 KB outside Vercel), `body must be a JSON object`, `label and prompt must be strings`, `label over 40 characters`, `prompt over 200 characters` or `prompt or label required`. |
| 200 | `{url, cached:true}` | The label's file is already in Blob. |
| 200 | `{url, cached:false}` | Generated now and stored. |
| 200 | `{url:null}` | Any other failure: no `ELEVENLABS_API_KEY` and no visitor key, ElevenLabs refused or failed, Blob failed, no audio or over 2 MB of it, or no sound within 20 s. The host keeps its palette default (`public/sfx`). |

Generation runs one ElevenLabs call at a time per instance (a second request for a label in flight shares its call): 3 s, prompt influence 0.5, `eleven_text_to_sound_v2`, `mp3_44100_128`, no retries (a retry is billed again). That is about 120 credits per new label, at 40 a second. Each instance also starts at most `SFX_MAX_PER_HOUR` (default 20; 0 means cache only) new generations per rolling hour. Cache hits and requests that share a call already in flight are free. Over the cap the answer is 200 `{url:null}` with no ElevenLabs call, so the host keeps its palette default, and the Vercel log warns at most once a minute.

With a valid `x-elevenlabs-key` the visitor's key pays: the sound is generated even when `SOUND_GEN` is not `on` and with no `ELEVENLABS_API_KEY` set, and it neither takes nor counts against `SFX_MAX_PER_HOUR`. The host token is still checked first, and the Blob cache, the one-at-a-time queue and the sharing of a label in flight are unchanged, so a cached label costs the visitor nothing and a team request for a label the visitor's call is making shares that call.

`POST /api/check` (`api/check.js`): does this key, or this platform, work? The API box's Test buttons call it. It spends no generation quota.

Request body `{service}`, one of `gemini`, `elevenlabs`, `snowflake` or `storage` (`SERVICES`; the body is capped at 4 KB), with the same optional `x-gemini-key` and `x-elevenlabs-key` headers as above. No host token is asked for.

| Status | Body | When |
|---|---|---|
| 405 | `{ok:false, using:'none', detail:'POST only'}`, header `Allow: POST` | Not a POST. Not counted by the rate limit. |
| 429 | `{ok:false, detail:'Too many checks; wait a minute'}` | This client (the first `x-forwarded-for` entry, else the socket address) has sent 10 checks in the last minute (`MAX_PER_MINUTE`), per instance and in memory. Every POST counts, bad ones included. |
| 400 | `{ok:false, using:'none', detail:'Unknown service'}` | `service` is not one of the four, or the body is missing, not JSON or over 4 KB. |
| 200 | `{ok, using, detail, credits?}` | Every check that ran. `using` is `yours` (the visitor's key was tested), `team` (the server's env) or `none` (nothing to test). `detail` is one short line of fixed text, safe to show on the TV. |
| 200 | `{ok:false, using:'none', detail:'The check itself failed'}` | The handler threw. |

What each service tests:

- **`gemini`.** `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` with the key in `x-goog-api-key`: a model list, so no generation quota is spent. The visitor's `x-gemini-key`, else `GEMINI_API_KEY`, else `{ok:false, using:'none', detail:'No Gemini key on this server; paste your own'}`. A 200 is "Gemini accepted the key".
- **`elevenlabs`.** `GET https://api.elevenlabs.io/v1/user/subscription` with `xi-api-key`; `credits` is `character_limit - character_count` (at least 0), or `null` when the answer has no counts, and the detail reads "ElevenLabs accepted the key; <n> credits left". A 401 there (a key scoped without user read access may still make sounds) falls back to `GET /v1/models`; a 200 from that is `ok:true` with `credits:null` ("ElevenLabs accepted the key (it may not read its credits)"). The visitor's `x-elevenlabs-key`, else `ELEVENLABS_API_KEY` (whose detail adds "; sound generation is off on this server" when `SOUND_GEN` is not `on`), else `using:'none'`. Every answer that called ElevenLabs carries `credits` (a number or `null`).
- **`snowflake`.** The team's only: `configured()`, then `listProjectsResult(1)` from `lib/snowflake.js`. "Snowflake answered", "Snowflake did not answer", or `using:'none'` with "Snowflake is not set up on this server".
- **`storage`.** The team's only: whether `BLOB_READ_WRITE_TOKEN` is set ("Blob storage is connected", else `using:'none'` with "No Blob store connected"). Nothing is written.

A malformed key header answers 200 `{ok:false, using:'yours', detail:'That does not look like a Gemini key'}` (or ElevenLabs) with no upstream call. A failed upstream call reads "<platform> refused the key" (400, 401 or 403), "<platform> says the key is over its limit" (429), "<platform> answered HTTP <status>", "Could not reach <platform>" or "<platform> did not answer in 8 s". Each upstream call, the Snowflake check included, is cut at 8 s (`TIMEOUT_MS`; `maxDuration` 15 in `vercel.json`). No answer and no log line ever carries a key or an upstream body.

## Scene

`validateScene(raw, meta, opts)` in `src/shared/scene-validate.js` (plain JS for Node and the browser) makes every scene: `api/interpret.js` runs it on Gemini's answer before storing the scene file. `raw` is Gemini's answer (an object or its JSON text) or a stored scene. It never throws and always returns exactly this shape; a stored scene re-validates to itself, and garbage gives an empty scene on the flat path.

`{id, source, edited, credit, image_url, scene_url, model, generated_at, ai_draft, title_guess, artist_guess, palette, ground_path, objects}`

| Field | Contract |
|---|---|
| `id` | The project id, at most 128 characters (`''` when none). |
| `source` | `drop`, `phone` or `sample` (`SOURCES`); anything else is `drop`. |
| `edited` | `true` only when given exactly `true`; `api/interpret.js` sets `false`. |
| `credit` | One line, at most 300 characters, else `null`. |
| `image_url`, `scene_url` | The Blob URLs, at most 2048 characters each (`''` when not stored). |
| `model` | The Gemini model that answered, at most 80 characters, else `unknown`. |
| `generated_at` | An ISO time; now when missing or unreadable. |
| `ai_draft` | Always `true`. |
| `title_guess`, `artist_guess` | Gemini's guesses, at most 120 characters each, else `unknown`. |
| `palette` | Up to 5 distinct `#rrggbb`, lowercase (`#rgb` and `#rrggbbaa` are converted, other strings dropped). |
| `ground_path` | 2 to 8 `[x, y]` points sorted left to right: where small figures walk. Fewer than 2 points, or a span under 100 across, becomes the flat `[[0, 850], [1000, 850]]` (`FLAT_PATH`). Longer paths are thinned evenly, keeping both ends. |
| `objects` | Up to 8 `{label, kind, box, mask, depth, colour, motion, sound_prompt}`, most prominent first. An object with no usable box is dropped. |
| `objects[].label` | At most 40 characters, else the kind. |
| `objects[].kind` | One of `KINDS`; anything else is `object`. |
| `objects[].box` | `[x0, y0, x1, y1]`, ordered, at least 1 wide and 1 tall. Gemini sends `box_2d` as `[ymin, xmin, ymax, xmax]`; a stored scene has `box`. With no usable box, a valid image-frame mask's bounds stand in. |
| `objects[].mask` | The outline in image space, 3 to 24 `[x, y]` points, or `null` when it is missing, has a non-numeric point or is too small (under 25 square units, or under 2% of its box). Longer outlines are thinned evenly, keeping the first and last point. |
| `objects[].depth` | 0 nearest the viewer to 1 farthest (the sky, the horizon), three decimals. Missing means `1 - y1/1000`: the lower the box's foot, the nearer. |
| `objects[].colour` | `#rrggbb` (`color` is read too), else a palette colour, else `#808080`. |
| `objects[].motion` | One of `MOTIONS`; anything else is `none`. |
| `objects[].sound_prompt` | At most 12 words and 120 characters (`''` when none); what `POST /api/sfx` takes as `prompt`. |

Text fields become one line (control characters and runs of whitespace turn into one space); `kind`, `motion` and `source` match case-insensitively.

Coordinates are image space: 0 to 1000 on both axes whatever the picture's aspect, x left to right, y top to bottom, clamped and rounded to integers. path.json's UV is `u = x / 1000`, `v = 1 - y / 1000`. Scene `depth` runs the other way from path.json's `h` and the depth map (both 1 near): near is `1 - depth`.

`KINDS`: `sky`, `cloud`, `celestial`, `water`, `ground`, `plant`, `building`, `vehicle`, `animal`, `person`, `fire`, `object`. `MOTIONS`: `none`, `sway`, `drift`, `bob`, `spin`, `fly`, `flicker`, `twinkle`. `LIMITS` holds the caps above (objects 8, mask points 24, path points 8, palette 5, label 40, sound words 12, guesses 120).

`meta` is `{id, source, edited, credit, image_url, scene_url, model, generated_at}`; each one given wins over raw's own field of that name, and a missing (or `null`) one falls back to raw's.

`opts.maskFrame` says where a raw Gemini mask lives. `'box'` (the default, and what `api/interpret.js` uses; Gemini's documented frame): its points are 0 to 1000 inside the object's `box_2d` and are mapped into image space. `'image'`: they are already image space. Only objects that carry `box_2d` are mapped; a stored object (with `box`) is always image space, so re-validating never moves a mask.

`sceneJsonSchema` (the same file) is the response schema sent to Gemini, kept flat and in step with `KINDS`, `MOTIONS` and `LIMITS`.

`src/host/maskDepth.js` (pure, node:test; `scene.js` calls it on every `loadScene`) turns a validated scene into what the relief takes. `sceneDepth(scene, {w, h, blurRadius})`: a depth map in `depth.js`'s format, `{data, w, h, placeholder:false}` (256 by 192 and blur 3 by default, rows bottom-up, 0 far to 1 near), each object painted farthest first over the prototype's sky-and-ground gradient, with `sky`, `ground` and `water` keeping half that gradient. `pathPoints(scene, sample, n = 8)`: `n` path.json-style `[u, v, h]` points spaced evenly along `ground_path`, `u` clamped to 0.05 to 0.95, `h` from the depth sampler (0.5 without one). `objectHotspots(scene, points)`: one `{index, label, t, look, zoom}` per object that fits on those points, `t` nearest the box's foot within 0.26 to 0.97, hotspots at least 0.06 apart and moved at most 0.12 (the rest dropped), `look` the box centre in UV, `zoom` 1.3. `objectIdMap(scene, {w, h})`: `{data: Uint8Array(w*h), w, h}`, each pixel `i + 1` for `scene.objects[i]` (the original index, even when an earlier entry was skipped as unusable) and 0 for none. It uses `sceneDepth`'s row layout, its even-odd fill, its box fallback for a null or degenerate mask and its painting order (far first, nearer overwrites, ties to the later object). It is not blurred, so ids never mix at an edge. `w` and `h` default to 256 by 192, clamped to 2 to 2048; at most 32 objects are read.

## window.game

Defined synchronously by `src/host/scene.js`; every method is callable immediately, before any image has loaded. `src/host/glue.js` calls it and assigns `sendTo` and `sendAll`; `src/host/artwork.js` calls `loadScene`, `showImage` and `setStatus`. v1's `setPanel`, `readout`, `exportArch`, `setOwner`, `setLever` and `setArch` are gone with the plaques and panels.

| Call | Contract |
|---|---|
| `addPlayer(pid, name, color)` | Upsert a figure at its staggered start (pid 0 at t 0.15, pid n at 0.15 + 0.012 × ((n − 1) mod 6 + 1), all short of the first stop). Body by pid parity: top hat for odd pid, bonnet for even (pid 0 is the kiosk keyboard player and is always in the picture). A repeated call for a figure standing at a stop re-emits its `near`. |
| `removePlayer(pid)` | Remove the figure (never pid 0). |
| `setInput(pid, lx, a)` | Walk direction (−1, 0, 1) and verb button. A rising edge of `a` while the figure is at a stop pokes that object (see `poke`) and emits a `poke` event. Ignored while the figure is frozen (`a` is still tracked, so a held button never fires on release). |
| `onHotspot(cb)` | `cb(evt)` for every event below; returns an unsubscribe function. |
| `sendTo(pid, msg)` / `sendAll(msg)` | Network; no-ops until glue assigns them. |
| `freeze(pid, on)` | Zero the figure's input and hold it in place. Nothing calls it since the plaques went. |
| `setJudge(on)` | Judge-mode indicator ("Guided tour" in `#modeTag`); stops and suppresses the attract loop. |
| `showOriginal()` | The current image alone over the stage for 8 s (`ORIGINAL_MS`), in `#original`. Its tag reads "Original. " plus the scene's `credit`, else its `title_guess` plus "(AI guess)". After `showImage`, or when the title is `unknown`, it reads "Original. As it was sent." Esc, W or the timer hides it. |
| `reset()` | Figures to their starts with input, freezes and waves cleared; the ghost back on; pulses cleared; the layer back to painting (emits `layer`); attract stopped. The scene stays; glue's R then loads sample 1. Under 10 s. |
| `loadScene(scene, {image})` | -> `Promise<void>`. Runs `validateScene(scene)` and loads `image` (default `scene.image_url`). Only site-relative, http(s), `blob:` or `data:image` URLs are accepted; anything else rejects with "image URL refused". Images load with `crossOrigin='anonymous'`, so a Blob image needs CORS. It then rebuilds the relief. The plane's height is fixed at 2.985 world units (4 / (1920/1433)), its width is height × the image's aspect (clamped 0.25 to 4), with 512 segments on the long side. Depth comes from `sceneDepth` and ids from `objectIdMap`, both at 256 texels on the long side. The path is `pathPoints(scene, sampler(depth))`, with one stop per `objectHotspots` entry (id `obj:<index>`). Figures keep their colours and go back to their starts. If the image fails it rejects and keeps the old scene. A call overtaken by a later `loadScene` or `showImage` resolves without touching the stage. Emits `{type:'scene', scene}` with the validated copy, which `scene()` then returns. |
| `showImage(url)` | -> `Promise<void>`. The flat state, used while a picture is read and after a failed reading: the image on a flat plane, the flat path `[[0, 850], [1000, 850]]` (u clamped to 0.05 to 0.95), no stops. Same URL rules and overtaking as `loadScene`. Emits `near` with `null` for every figure that stood at a stop, then `{type:'scene', scene:null}`. |
| `setStatus(text \| null)` | One line in `#status` at the stage's top centre (whitespace collapsed, at most 160 characters; `#hint` moves below it). `null` or `''` hides it. |
| `scene()` | The current validated scene, or `null` (the boot Turner and the flat state). |
| `poke(index)` | -> the object, or `null` when there is no scene or no object at that index. A 1 s pulse: the object pops 0.14 world units toward the viewer and glows. |
| `stats()` | `{fps, zoom, lean, layer}` for the HUD. |

Hotspot events (`onHotspot`):

- `{type:'near', pid, object, label}`: the figure reached a stop (`object` is the index into `scene.objects`, `label` its AI label) or left one (both `null`).
- `{type:'poke', pid, object, label, kind, sound_prompt}`: the verb's rising edge at a stop, emitted by scene.js itself after it starts the pulse (pid 0 is the keyboard); the figure waves.
- `{type:'layer', name}`: `painting`, `depth`, `exploded` or `network`, on every W and on `reset()`.
- `{type:'scene', scene}`: after `loadScene` resolves (the scene) and after `showImage` (`null`).

Layers (W): painting, then depth (the relief shaded by depth, captioned "Depth map: from <model>'s reading (AI draft)" or "Depth map: from a hand-corrected reading (sample)"), then exploded (the relief's amplitude eased from 0.42 to three times that, captioned "Exploded layers: the relief at three times its depth, each object at its depth guess"), then network (the painting view with no caption; margins.js shows the platform panel), then painting again. `#modeTag` names the layer and, off painting, the fps.

Motion: per object, from `scene.objects[i].motion`, in the vertex shader. The id map is a Luminance `DataTexture` with `NearestFilter`, read with two uniform arrays of 9 slots (slot 0 is no object, slots 1 to 8 are objects 0 to 7), filled on every 1/60 s step. The motions are sway (a shear from the object's foot up), drift, bob, spin (a small orbit), fly (a figure-eight with lift), flicker (glow and jitter), twinkle (glow) and none. A figure standing at an object adds a soft glow. M (reduced motion, also on with `prefers-reduced-motion`) quarters every amplitude, the poke pop included, and stops the figures' waves. At an object's edge the moving part stretches the triangles around it.

Camera: follows the group (every figure, plus the ghost while it is on): zoom 1.0 to 1.35, a translate-only pan, and lean from the group and the mouse. There is no focus frame.

Stage text: `#hint` reads "<label> (AI label) · Space pokes it" while the keyboard figure is at a stop, else "← → walk · Space pokes what you stand at", or "← → walk the picture" when there are no stops. After 45 s without input (and never in judge mode) the caption reads "Scan the code to join, or use the keyboard. The view follows whoever is walking." and the camera sways; any input stops it. The ghost passenger strolls the path whenever it is on (it is on at boot and after `reset()`; A toggles it). Without WebGL the hint reads "WebGL is not available in this browser."; if the boot image fails, "The painting file did not load."

Boot: the Turner (`/assets/turner-1920.jpg`) on the hand-authored placeholder relief (`depth.js`), walked along an inline copy of path.json's bank points. It has no stops and `scene()` is `null`, so the kiosk works with zero network until artwork.js loads sample 1.

Keys. Every module ignores Ctrl, Meta and Alt, and keys typed into a field (except scene.js's Esc). Key repeats are ignored except for the arrows and the open gallery's keys. No module handles another's keys.

- scene.js: `←` `→` (walk pid 0), `Space`/`Enter` (poke, pid 0), `Esc` (hide the original), `O` (original), `W` (next layer), `M` (reduced motion), `` ` `` (path debug overlay), `A` (attract ghost).
- glue.js: `H` (HUD), `J` (judge mode), `R` (reset), `Q` (relay fallback switch: the laptop hub).
- artwork.js: `G` (gallery; while it is open it takes the arrows, `Enter` and `Esc` in the capture phase), `U` (file picker), `1` `2` `3` (samples), and drag-drop on the window. Because it listens in the capture phase, it also ignores any key whose target sits inside an `[aria-modal="true"]` element (the API box).
- audio.js: `S` (mute).
- margins.js: `L` (Learning overlay), `X` (hide the AI labels).
- apibox.js: `K` (open the API plug-in box). While the box is open, every key pressed inside it stops at the box, so no letter typed into a key field reaches the TV; Tab and Shift+Tab cycle inside it and `Esc` closes it.

Host page DOM. The TV is a fixed 1920 by 1080 frame scaled to fit the window (`--fit`), in three columns:

- A 236 px left margin: `#label` (filled by margins.js, which also inserts `#legend` before `#roster`) and `#roster`.
- The 1447 px stage `#stage`: canvas `#gl`, `#status`, `#hint`, `#caption`, and `#original` holding an `<img>` and a `p.tag`.
- A 237 px right margin: `#modeTag`, `#hud`, `#resting`, `#qr`. margins.js inserts `#source` before `#resting`, and apibox.js inserts the API button (`.api-open`) right after `#modeTag`.

At runtime the stage also gets the path overlay canvas and its Save button (pathOverlay.js), `#platforms` and `#learning` (margins.js), `#artGallery`, the drop hint and a hidden file input (artwork.js), and `#apiBox` (apibox.js). Stacking order: the stage's vignette and brass rule (`#stage::before` and `::after`) at 1, status, hint and caption at 2, `#platforms` 4, path overlay 5 and 6, gallery 7, Learning 8, drop hint 9, `#original` 10, `#apiBox` 11. Any new stage overlay sits at 2 or higher. glue.js renders only into `#roster`, `#hud`, `#qr` and `#resting`. scene.js renders into `#status`, `#hint`, `#caption`, `#original` and `#modeTag`.

Look. Both pages wear one skin, a cyanotype toy theatre: a Prussian-blue ground, cream paper cards and ink text, with brass kept for the primary action, the focus ring and the stage's hairline rule. Every colour lives in `src/shared/tokens.css`; components use its variables only. Besides the palette, fonts and sizes it defines `--space-1` to `--space-4` (8, 16, 24, 32 px), `--radius-card` (8 px), `--radius-pill` (999 px), `--rule-frame` (a hairline on Prussian), `--rule-ink` (a hairline on cream), `--card-frame` (a card sunk into the Prussian ground), `--ink-soft` (secondary ink on cream, 6.7:1), `--ok-ink` ("saved" on cream, 5.4:1), `--shadow-card`, `--shadow-lift`, `--vignette`, `--focus` (brass) and `--fade` (200 ms). Its alpha colours are 8-digit hex, not `color-mix()`, so iOS 13 reads them on the phone. On the TV:

- **Stage.** A proscenium with a soft inner vignette and a hairline brass rule 12 px in. The status line is a cream pill and the hint a translucent Prussian pill, both centred at the stage's top (top 32 px; the hint drops to 96 px while the status shows). The caption and the original's tag are pills at the bottom, so a new overlay keeps clear of the top-centre band and the bottom 100 px.
- **Margins.** The left margin is a cream museum label: the artist in small caps, the title in Fell clamped to 3 lines, the AI chip as an outlined pill, the credit under a hairline. margins.js puts each line's full text in its `title` attribute (the artist, title, credit and every legend item), because long lines end in an ellipsis. The legend item is the label in Franklin with the kind in mono small caps, and an item that does not fit moves whole out of view. The right margin's blocks (mode tag, HUD, source, resting note) are matching hairline cards, and the QR is a cream paper card. Margin body text is 22 px, small print (the chip, credit, notice, HUD and QR URL) 18 to 20 px; every stage overlay is 28 px or more.
- **Overlays.** Gallery cards are paper with a 4 px brass focus ring; the W platform panel is a blueprint table, mono on a faint grid; the L Learning overlay is a paper sheet.
- **Motion.** `host.css` defines `@keyframes tt-fade`; every fade uses `--fade`, and all animation and transition inside `#tv` is off under `prefers-reduced-motion` and under `#tv.reduced` (M).

## TV modules and the phone page

`src/host/glue.js` keeps the relay socket, rollover, seats, judge mode, idle kicks and the keys H, J, R and Q.

- **Init.** On load it calls `margins.init({audioStats: audio.stats})`, then `audio.init({token, margins})`, then `artwork.init({game, token, audio, margins})`. `token` is the page's `?host=` value.
- **Hotspot events.**
  - `near`: sends `{t:'near', label}` to that phone.
  - `poke`: calls `audio.play('poke', {label, kind, sound_prompt})` and sends the readout "You poked the <label>".
  - `layer`: calls `margins.showPlatforms(name === 'network')`.
- **Joins and the relay.** A new pid's `join` plays `audio.play('join')`; the re-joins after a relay gap stay silent. The relay's `hub` message goes to `margins.setHub(m)`.
- **R.** Runs `game.reset()`, `artwork.loadSample(1)` and `audio.play('reset')`. It sends mode `reset` to every phone, turns judge mode off, clears the original and artwork cooldowns and sets the cap to 6.
- **HUD and margin text.** H's expanded HUD adds the line `layer <layer> · <saved> <id>` beside each phone's median rtt. The roster heading is "In the picture" and the QR caption "Scan to walk into the picture". After Q with `WIFI_SSID` set, the two QR captions read "1  Join the Toy Theatre Wi-Fi" and "2  Scan to walk into the picture".

`src/host/artwork.js` exports `init({game, token, audio, margins})` (which loads sample 1), `upload(file)`, `fromPhone(sceneUrl, pid)` (resolves `true` or `false`), `loadSample(n)`, `toggleGallery()` and `current()`. `current()` returns `{scene, id, saved}`, where `saved` is `sample`, `saving`, `saved`, `local` or `unsaved`. Its stage calls run one at a time, and a superseded one is skipped.

- **Upload** (a drop anywhere on the window, or U). While a file is dragged over, a dashed hint reads "Drop the picture: Google Gemini will read it". The picture is downscaled (1024 px JPEG), shown flat (`showImage`) with the status "Reading the artwork…", then sent as `POST /api/interpret {image, source:'drop'}` with a 40 s client timeout. A second picture during a reading gets "One at a time: still reading the last picture".
  - **ok:true.** The scene plays (falling back to the local copy if the Blob image will not load), with the appear sound and the badge "saving…". It is mirrored to localStorage `tt.projects` (today only, at most 50 entries, a scene over 60 KB left out). The page then polls `GET /api/projects?id=<id>` at +3, +10 and +30 s. "Saved to Snowflake" and the save sound come only with a 200 row. The badge settles to "local only" after the last poll, or at once when Snowflake is not configured.
  - **Failure lines** last 6 s on the stage:
    - busy: "One at a time: try again in a few seconds"
    - quota: "The artwork reader is resting; press 1, 2 or 3 for a sample"
    - storage with a scene: plays it unsaved, with "Read it, but couldn't save it; playing it unsaved"
    - an unreadable file: "That file isn't a picture we can open"
    - bad_key, or auth while the visitor has a Gemini key saved: "Your Gemini key was refused; check it in the API box (K)", over the flat picture
    - anything else, including no API on the laptop hub or in `npm run dev`: "Couldn't read this one; walking on the flat painting", over the flat picture
- **Phone pictures.** `fromPhone` checks the URL against the relay's Blob `scenes/<id>.json` pattern, shows "Opening a picture from a phone…", fetches the scene JSON (CORS), validates it and plays it with the same mirror and poll. If that scene is already on stage it returns `true` without reloading. On a failure it shows "Couldn't open that phone's picture; staying on this one".
- **Samples.** `loadSample(n)` is 1-based, from `/samples/index.json`, and plays no sound (boot and R call it). Keys 1, 2 and 3 play the appear sound after a load. A number with no sample does nothing.
- **Gallery (G).** Up to 12 cards, merged from the bundled samples, today's mirror and the `GET /api/projects` list, deduplicated by id (the Snowflake row wins and keeps the local scene copy). Projects come newest first and the samples last, always present.
  - **Header and empty state.** The header reads "Gallery" with "Titles are AI guesses. Arrows choose, Enter opens, Esc closes.". Under it a store line reads "Checking Snowflake…", "Saved projects from Snowflake, and this laptop", "Local only: Snowflake is not set up here" or "Local only: Snowflake is not answering". With no cards at all it reads "Nothing here yet today. Drop a picture, or press 1 for a sample."
  - **Cards.** Each card shows the image, the title, the time, a chip (Sample, Laptop or Phone) and a badge (Saved to Snowflake, Local only or Hand-corrected). Opening the gallery plays the gallery sound.
  - **Reload.** A card reloads from the local copy, then `scene_url`, then the Snowflake row's scene, and never calls Gemini. A failure reads "Couldn't open that project; staying on this one". Badges come from the list, so a confirmed project reads "Local only" when the list is unreachable.

`src/host/audio.js` exports `init({token, margins})`, `play(event, obj?)`, `prepare(scene)`, `toggleMute()` (bound to S) and `stats()`.

- **Return values.** `play` returns `Promise<boolean>` (true when the sound started) and never rejects. `prepare` returns a Promise that never rejects. `toggleMute` returns the new muted state. `stats` returns `{played, generated, cached}`.
- **Events.** The events are `join`, `poke`, `appear`, `save`, `reset` and `gallery`, each playing `public/sfx/<event>.mp3`.
- **Pokes.** A poke plays the generated sound for that object's label once `/api/sfx` has returned its url. Until then it plays its kind's palette file:

  | Kind | Palette file |
  |---|---|
  | sky, cloud, plant | `wind` |
  | water | `water` |
  | fire | `fire` |
  | animal | `animal` (`bird` when its motion is fly) |
  | object | `poke` (`bird` when its motion is fly) |
  | vehicle | `vehicle` |
  | person | `footsteps` |
  | building | `bell` |
  | celestial | `twinkle` |
  | ground, and any unknown kind | `poke` |

- **Playback.** Sounds play from a round-robin pool of 6 HTMLAudio elements at volume 0.3. A missing file, a blocked autoplay or an unknown event is silent and not counted. The kiosk's `--autoplay-policy=no-user-gesture-required` (`tools/start.cmd`) lets sound play from boot. Elsewhere Chrome unlocks it on the first key or click. Every sound that plays calls `margins.flash('<event> · <file> · ElevenLabs')`; a generated sound's `<file>` reads "<label> (made for this artwork)".
- **Generation.** `prepare(scene)` asks `POST /api/sfx {label, prompt}` for the scene's first 2 distinct labels (lowercased, whitespace collapsed), one at a time. The request carries `x-host-token` when the token is set, the visitor's `x-elevenlabs-key` when one is saved, and has a 25 s timeout. Any non-200 answer (204, 400, 401, or the 404 of the laptop hub) stops requests until the next `init()` or the next change of keys: on the `tt:keys` event it asks again, for the scene already on stage too, so a key added in the API box makes sounds for the artwork in front of it. New generations are capped at 25 a day in localStorage `tt.sfxday`, a visitor's key included; once the cap is reached, cache hits are skipped too.
- **Mute.** S mutes and pauses everything playing, stored in `tt.mute` (`'1'`/`'0'`), so it survives R and a reload. It flashes "Sound off (S turns it back on)" or "Sound on".

`src/host/margins.js` exports `init({audioStats})`, `setScene(scene, {saved})` (`null` clears it), `setSaved(state, id)`, `setHub(hubMsg)`, `showPlatforms(on)`, `flash(text)`, `toggleLearning()` (L) and `toggleLabels()` (X). Every scene string reaches the page through `textContent`.

- **Left margin.** `#label` shows the artist guess, then the title guess ("Artist unknown" or "Title unknown" when Gemini said `unknown`). Below them is the chip "AI draft, not a museum record", or "AI draft, hand-corrected (sample)" when `scene.edited` is true, then the credit line. `#legend` ("AI guesses") lists up to 8 objects as "label (kind)".
- **Right margin `#source`.** It shows the source thumbnail and the saved badge. The badge reads "Saved to Snowflake" (green) only for `saved`, else "saving…", "local only", "sample" or "not saved". Below them is the notice "Pictures sent here are public demo content read by Google Gemini (free tier)." `flash(text)` shows over the top of this block for 2 s.
- **Stale confirmations.** `setSaved` ignores a call whose id is not the project on screen.
- **Platform panel.** `#platforms` sits over the stage bottom for the network layer and refreshes every second, with one line per platform:
  - Vercel: "relay <region>" or "laptop relay (Q)", the instance's first 8 characters, and the bus ("Upstash Redis" or "local"), all from the relay's `hub` message.
  - Gemini: "<model> · read at HH:MM", or "sample, edited (hand-corrected)" for an edited sample.
  - ElevenLabs: played, generated and cached, from `audio.stats()`.
  - Snowflake: "project <id> · <badge text>".
- **X.** It adds `#tv.labels-off`, which hides the guesses, the chip and the legend and shows "AI labels hidden"; the credit stays.
- **L.** The overlay "Learning: what surprised us" lists `src/shared/learning.json` (`{"entries": []}`, each `{who, at, text, shot?}`, where `at` is an ISO time shown as "Sat 14:05" or free text) in file order. When the file is empty it says where to add entries; it never invents any.

`src/host/apibox.js` is the API plug-in box: where a visitor plugs in their own Gemini and ElevenLabs keys and tests every platform. main.js imports it after glue.js. It exports `open()`, `close()` and `toggle()`.

- **Open and close.** K, or the API button under `#modeTag` (it reads "API" with a K key cap, plus "your keys" while a key of theirs is saved). Esc, the × button or the API button closes it. It is a modal (`role="dialog"`, `aria-modal="true"`) over the whole stage at z 11; focus starts in the Gemini key field, stays inside the box while it is open and goes back where it was on close. The first open on a page tests every card once (4 of the server's 10 checks a minute, plus the relay's health GET); after that only Test asks again.
- **Gemini and ElevenLabs cards.** Each has a status dot with a word beside it ("Not tested", "Testing…", "Working", "Failed"), so status never rests on colour alone; a "Using: your key / team key / not set" line; one line on what the platform does here and what a key of yours changes; a password field with Show/Hide; "Saved: AIza…X9q2" (the masked key) or "No key of yours saved"; Test and Clear; and the server's `detail`. Test with text in the field saves it first (it reads "Save and test"; text that is not a key's shape is refused in place) and empties the field. Clear forgets that key, the model with it on Gemini. Gemini also has a model select, "Default model" or one of the two allowed models, used only with the visitor's key. ElevenLabs also shows "Credits left: <n>" when the server reports them.
- **Team cards.** Snowflake, Blob storage and Realtime relay, each with Test; the box tests them and cannot change them. The relay card asks `GET /api/ws` on https and `/healthz` on http (the laptop hub) and lists region, instance, bus and sockets.
- **Footer.** "Remember on this device" (localStorage instead of sessionStorage), "Clear my keys" (both forgotten, both cards tested again on the team's keys), and the privacy note: "Keys stay in this browser and are sent only to this site's API over HTTPS with each request; the server never stores or logs them."
- **No API here.** On the laptop hub or `npm run dev` every check reads "Failed" with "No API here (the laptop hub or npm run dev)", and the relay card "No relay health at /healthz" under Vite.
- **Privacy.** After a save the page only ever shows `mask(key)`, and closing the box empties anything typed and not saved. Keys never go into a URL.

`src/shared/byok.js` keeps the keys. `load()` returns `{gemini, geminiModel, elevenlabs, remember}`, normalised (a stored key that does not match `KEY_RE` reads as `''`, a model outside the two as `''`). `save(patch)` merges a partial update; with `remember` true it writes localStorage `tt.byok` and clears sessionStorage `tt.byok`, else the reverse. `clear()` drops both. Every change dispatches the window event `tt:keys` (no payload). `apiHeaders()` returns only the headers that are set, and `mask(key)` the first 4 and last 4 characters around an ellipsis. Every storage access sits in try/catch, so blocked site data only means no keys. It also exports `readCheck()`, `relayPath()` and `relayView()`, the box's pure readers of the check and relay answers. The file has no `?.` or `??`, so the phone could import it.

Phone page (`join.html`, `src/join/main.js`, `src/join/join.css`). It has five screens: connecting, lobby, walk, full and evicted. v1's plaque screen, sliders, Done, Export and `cards.json` are gone.

- **The verb.** The verb follows the host's `near` label.
- **Add artwork.** It shows only when `location.protocol` is `https:`, because the laptop hub serves no `/api/interpret`. It opens `<input type=file accept="image/*" capture="environment">` under the notice "Your picture is uploaded publicly and read by Google Gemini (free tier)." The photo is downscaled (1024 px, JPEG 0.8) and posted to `/api/interpret` as `{image, source:'phone'}`. While it uploads the button is disabled and reads "Sending…".
  - **ok:true.** The phone sends `{t:'panel', kind:'artwork', value: scene_url}` (retrying for about 5 s if the socket is busy) and toasts "On the TV in a moment"; the host's readout then replaces that toast. If the send never goes through it toasts "Couldn’t reach the screen; try again".
  - **Failure toasts.** busy: "One at a time: try again in a few seconds". quota: "The artwork reader is resting; try a sample on the TV". Anything else, a network error or 40 s without an answer: "Couldn’t read that one; try another picture". A failed reading never reaches the TV.
  - **Keys.** The phone sends no bring-your-own-key headers, so a phone's picture always uses the team's Gemini key and its hourly cap, whatever keys the TV holds.
- **Look.** The same cyanotype skin as the TV, from the same tokens. Connecting, full and evicted are centred cream cards (the evicted message is the card's `h1`). The lobby reads "Welcome to the Toy Theatre" over the Fell title "Pick a colour"; each free seat is a card filled with its colour, its name in ink or cream by luminance (`--on`), one column in portrait and two on a landscape phone. The header holds the player's name in a chip filled with their colour (`--on-accent` text) beside an outlined "Show the original" pill. The walk pad is a cream pad with drawn Left and Right halves and chevrons; the held half turns ink. The verb is a brass pill, a dashed outline while it reads "Walk to something". Add artwork is an outlined pill with a camera glyph, its label in `#artLabel`. Toasts are cream pills at the bottom, above the safe area. Text is 18 px or more and every target at least 44 px. Screens fade in over `--fade`, and all motion is off under `prefers-reduced-motion`. The phone loads Fell and Franklin but not JetBrains Mono.
- **Unchanged.** The socket, rollover, who/here, watchdog, resting, wake lock, lobby and Show the original work as before. With no host, Show the original still shows the Turner on the phone. The file has no `?.` or `??`, so iOS 13 can parse it.

Samples (`public/samples/`, see its README). `index.json` is `[{n, id, name, image, scene, credit}]`, where `n` is 1-based and matches keys 1, 2 and 3, and `image` and `scene` are site-relative. Each scene file is `validateScene` output with `source` `sample`, `edited` true, `ai_draft` true, `model` `hand-corrected`, `scene_url` `''` and `credit` set.

- **Sample 1, `sample-turner`.** The Turner at `/assets/turner-1920.jpg`, with 8 objects. Its `ground_path` is path.json's left bank, so only 6 objects get a stop; steam and sky still move but cannot be poked.
- **Sample 2, `sample-sketch`.** `/samples/sketch.svg`, 1600 by 1200, with 7 objects whose masks are the SVG's own polygons.
- **Sample 3 (The Starry Night).** Not in the repo yet, so key 3 does nothing; `public/samples/README.md` gives the steps to add it.

## Constants

Positions along the path are in path-parameter units: t runs 0 to 1.

- **Walking.** Hotspot half-width 0.03 (a figure that close to a stop's t is at that stop). Figures walk t 0.15 to 1 (`MIN_T`; with the path's first point at u 0.05 the follow camera cannot frame a figure below t 0.15), at 0.10 path lengths a second. Stops sit at t 0.26 to 0.97, at least 0.06 apart (`maskDepth.js`).
- **Camera.** Follow zoom 1.0 to 1.35. Lean up to 10 degrees, fading to 0 by zoom 1.8.
- **Input.** The host zeroes a phone's non-zero input when its 4 Hz heartbeat stops for 1 s.
- **Phone panels.** Phones may show the original on the TV once per 20 s globally (`ORIGINAL_COOLDOWN_MS`), for 8 s (`ORIGINAL_MS`). Each phone may send one artwork per 20 s (`ARTWORK_COOLDOWN_MS`).
- **Where they live.** All in `src/shared/protocol.js` except the stop spacing and the walk speed.

Sockets: the relay pings every 15 s and drops a socket that missed the last pong; the relay's `hb` and the host's `hb` both run every 2 s; a phone drops a silent socket after 5 s; a seat is held 20 s; sockets roll over 240 s after opening plus up to 30 s of jitter (`ROLLOVER_MS`, `ROLLOVER_JITTER_MS`), and a rollover socket has 5 s to be welcomed or opened (`ROLL_WAIT_MS`); a phone shows "The screen is resting" after 6 s without host traffic (`HOST_SEEN_MS`); at most 12 phone sockets per relay instance (`MAX_SOCKETS`). The relay's path is `WS_PATH`, `/api/ws`.

Phone panels (glue decides; the host never trusts a phone).

- **`original`.** Once per 20 s across all phones. The TV shows the original for 8 s and the phone gets "Showing the original on the screen for 8 s", or "Show the original again in <n> s".
- **`artwork`.** `value` must be a string; the relay has already checked it is a Blob scene URL.
  - During the guided tour only phones that joined while J was on (the guests) may send one. Any other phone gets "Pictures are paused for the guided tour", so a judge must join after J is pressed.
  - Each phone may send one per 20 s ("One picture every 20 s").
  - An accepted one gets "Your picture is on its way to the TV" and goes to `artwork.fromPhone(url, pid)`. If that resolves false or rejects, the phone gets "The TV couldn't open that picture; try another".
- **Other kinds.** Ignored, but they count as activity.
- **On R.** Both cooldowns clear.

Slot policy (B4, "Guided tour"). The cap stays at 6: a cap of 4 would also refuse the judge. Any phone idle for 90 s (no non-zero input, no panel message) is released with a kick (reason `idle`). Pressing J turns on judge mode. It kicks the longest-idle phones at once, away ones first, until two of the six slots are free (reason `judge`). It keeps releasing phones that were already on the bank when J was pressed once they idle for 30 s, and exempts phones that join while it is on (the judges) from both idle releases. J again, or R, turns judge mode off. A kicked token is refused by the host's seats (`src/host/slots.js`), so a kicked phone shows its end screen and rejoins only when the visitor taps Join again.

## path.json

`public/path.json` is v1's Turner bank path: `{"image":"assets/turner-1920.jpg","points":[[u,v,h] × 8],"plaques":[…]}`. `u` runs left to right, `v` bottom to top (texture UV); `h` is the depth (0 far, 1 near) baked at that point.

- **Readers.** scene.js no longer fetches it: the boot Turner walks an inline copy of its points. Sample 1's `ground_path` was converted from them (`x = u × 1000`, `y = (1 − v) × 1000`). `tests/camera.test.js` still reads the file. Its v1 `plaques` are unused.
- **The path at runtime.** It is `pathPoints(scene, …)`, with `h` from the scene's depth map. Figures and stops use the curve's interpolated `h`, never a per-frame depth sample.
- **The backtick overlay.** It shows the live path and the stops (as `plaques` entries `{id:'obj:<index>', index, label, t, look, zoom}`), lets you drag either, and "Save path.json" downloads them in this schema.

## Depth map

Each scene's depth is `sceneDepth(scene)` (see Scene), 256 texels on the long side, uploaded as a float texture (half float without `OES_texture_float_linear`, 8-bit on WebGL1); it displaces the plane by up to 0.42 world units (three times that on the exploded layer). The boot Turner uses the prototype's hand-authored placeholder (`placeholderDepth()` in `depth.js`), so the kiosk works at every commit. v1's `public/depth/turner-depth.png` (from `tools/depth.py`: Depth Anything V2 Small on the scan, 16-bit with R the high byte and G the low byte) is not in the repo and nothing reads it now. `loadDepth()` in `depth.js` still decodes that format, but nothing calls it.

## Sprites

`public/sprites/tophat.png`, `bonnet.png` (1024 by 384, four 256 by 384 frames: walk1, walk2, walk3, wave; warm black with a 2 px cream edge) and `tophat-accent.png`, `bonnet-accent.png` (white where the band or ribbon is, tinted per player). Loaded with `repeat.set(0.25, 1)`; missing sheets fall back to procedural canvas figures. The sheets are not in the repo yet, so the procedural figures draw today.

## Env

Vercel (Project Settings, Environment Variables, by exact name; a change applies only to the next deployment):

| Name | Read by | Value |
|---|---|---|
| `HOST_TOKEN` | `api/ws.js`, `api/sfx.js` | The host socket's `?host=` must match it, or the relay closes it with 4003; `/api/sfx` also requires it in the `x-host-token` header (401 otherwise). Always set it on Vercel: empty means no check, and any page that opens `/api/ws?role=host` would take the TV over (4000). |
| `JOIN_URL` | `api/ws.js` | What the QR encodes. Empty means `https://<request host>/`; set it to the production URL. |
| `REDIS_URL`, else `KV_URL`, else `UPSTASH_KV_URL` | `api/ws.js` | A `rediss://` URL for the relay's bus, read in that order. The Upstash integration injects `KV_URL` or `UPSTASH_KV_URL`; `REDIS_URL` is the name for a URL added by hand. Its REST URL and token are not enough, because the relay speaks the Redis protocol (ioredis). Without one the relay delivers only inside one instance and the HUD says "no redis". |
| `BLOB_READ_WRITE_TOKEN` | `api/interpret.js`, `api/sfx.js`, `api/check.js` | Injected when a Blob store is connected to the project. `/api/check` only tests that it is set. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (optional) | `lib/gemini.js` (for `api/interpret.js`); `api/check.js` reads the key | One Gemini project, one key. A visitor who brings their own (`x-gemini-key`) needs neither; without the key, every other reading gets `no_key`. |
| `INTERPRET_MAX_PER_HOUR`, `INTERPRET_MIN_GAP_MS` (optional) | `api/interpret.js` | Requests let through to Gemini per hour on one instance (default 30; 0 refuses all) and the least gap between one client's requests in ms (default 8000; 0 turns it off); anything but a whole number means the default. |
| `ELEVENLABS_API_KEY`, `SOUND_GEN`, `SFX_MAX_PER_HOUR` (optional) | `api/sfx.js`; `api/check.js` reads the key and `SOUND_GEN` | `SOUND_GEN` is `on` or `off`; anything but `on` answers 204 and generates nothing, unless the request brings a valid `x-elevenlabs-key` (which also skips `SFX_MAX_PER_HOUR` and needs no `ELEVENLABS_API_KEY`). `SFX_MAX_PER_HOUR` (default 20) caps new sounds per instance per rolling hour. `tools/sfx.mjs` reads the key from a local `.env` (`node --env-file=.env tools/sfx.mjs`). |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE` | `lib/snowflake.js` (for `api/interpret.js`, `api/projects.js`, `api/check.js`) | The private key is the full PEM, PKCS#8, unencrypted. `SNOWFLAKE_ROLE` is optional (empty means the user's default role); with any other one missing, saves are skipped and the project list is empty. |

`VERCEL_REGION` is set by Vercel itself and becomes `region` in the `hub` message.

Laptop (`.env`, never committed; `tools/start.cmd` loads it and the laptop hub inherits it; `npm run hub` reads the shell's environment): `PORT` (8080 by default, 80 under start.cmd), `HUB_URL` (start.cmd only: where the kiosk loads the host page, default `http://localhost`), `HOST_TOKEN` (empty means no check, local only; otherwise it must equal the Vercel value, because the host page sends one token to both relays), `JOIN_URL` (leave it empty so the QR encodes `http://<LAN_IP>/`), `WIFI_SSID` and `WIFI_PASS` (the hotspot Wi-Fi QR beside the join QR after Q), `LAN_IP` (empty means the first private IPv4), `ALLOW_ORIGIN` (CORS for `/healthz`). `.env.example` lists them, plus the Vercel names without values.

Pages: no env; query parameters only (`?host=`, `?hub=`, `?roll=`).

## Run it

Install the dependencies once.

```
npm install
```

Development: start the laptop hub in one terminal and Vite in another. Vite proxies `/api/ws` to the hub on 8080.

```
npm run hub
```

```
npm run dev
```

On the laptop, open `http://localhost:5173/host.html?host=`. On a phone on the same network, open `http://<laptop LAN IP>:5173/join.html`. The TV boots into sample 1 and keys 1 and 2 load the samples. Without the HTTP API (see below) a drop shows the picture flat with "Couldn't read this one; walking on the flat painting". The phone hides Add artwork on http. In dev, Vite serves the join page at `/join.html`; the hub serves the same page at `/`. To see a rollover without waiting four minutes, add `&roll=20000` to the host URL and `?roll=20000` to the phone's.

Demo on the laptop alone: Vite builds `dist` and the hub serves it on port 8080. Open `http://localhost:8080/host?host=` on the laptop and `http://<laptop LAN IP>:8080/` on a phone.

```
npm run demo
```

Tests:

```
npm test
```

The HTTP API locally (N's machine, the linked one). The laptop hub and `npm run dev` serve only the pages and the relay; `/api/interpret`, `/api/projects`, `/api/sfx` and `/api/check` run on Vercel or under `vercel dev`. First tick Development on the API's variables in Project Settings: `vercel env pull` writes that environment (another with `--environment`) to `.env.local`, which git ignores (`.env.*`). Never pull into `.env`: the Q fallback reads it. Then start `vercel dev` (port 3000):

```
vercel env pull
```

```
vercel dev
```

These are the real keys: an interpret spends Gemini quota and writes real Blob files and a Snowflake row, and with `SOUND_GEN=on` every new label spends ElevenLabs credits. The pages under `vercel dev` still need a relay: run `npm run hub` beside it and open `http://localhost:3000/host.html?host=&hub=localhost:8080`. To try the API alone (the second sends the Turner scan and prints `ok` and the scene URL, or the reason):

```
curl -s http://localhost:3000/api/projects
```

```
node -e "fetch('http://localhost:3000/api/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:require('fs').readFileSync('public/assets/turner-1920.jpg','base64')})}).then(r=>r.json()).then(j=>console.log(j.ok,j.reason||j.scene_url))"
```

Your own keys. On the TV, press K (or click the API button in the right margin), paste a Gemini or ElevenLabs key and press Test: the card turns to "Working" or says why not, and from then on the TV's readings and sounds use that key. Without the box, the same check from a shell (`service` is `gemini`, `elevenlabs`, `snowflake` or `storage`; add `-H "x-gemini-key: <key>"` or `-H "x-elevenlabs-key: <key>"` to test yours instead of the team's; at most 10 checks a minute):

```
curl -s -X POST http://localhost:3000/api/check -H "content-type: application/json" -d "{\"service\":\"gemini\"}"
```

Vercel (production). One person deploys; Hobby runs one build at a time.

1. Link the project. A Hobby project links only to a repository on a personal GitHub account, not an organisation.

   ```
   vercel link
   ```

2. Add Upstash Redis and a Blob store with Public access from the Vercel Marketplace (the project's Storage tab) and connect both to the project. Blob injects `BLOB_READ_WRITE_TOKEN`. If the Upstash install asks for a card, create the free database at console.upstash.com instead and use its `rediss://` URL as `REDIS_URL`.
3. Set the variables in the Env table, in Project Settings or with the CLI, for example:

   ```
   vercel env add HOST_TOKEN production
   ```

   The Snowflake values come from G's one-time setup, `sql/projects.sql`, run in a Snowsight worksheet on the trial account (AWS us-east-1, beside Vercel's iad1); every object in it is named in full, so the worksheet's context does not matter. Its steps: make the key pair with openssl on a laptop (never commit `rsa_key.p8`); as ACCOUNTADMIN, uncomment and run the setup with the public key pasted in (warehouse `LB_WH`, database `LB_DB`, schema `LB_DB.APP`, role `LB_APP` with SELECT and INSERT on the schema's future tables, and the key-pair-only service user `LB_SERVICE`); check with `DESCRIBE USER LB_SERVICE` that `RSA_PUBLIC_KEY_FP` is `SHA256:` plus the openssl fingerprint; run the one live statement, `CREATE TABLE IF NOT EXISTS LB_DB.APP.PROJECTS`; then set `SNOWFLAKE_ACCOUNT` (orgname-accountname, from the query in the file), `SNOWFLAKE_USER=LB_SERVICE`, `SNOWFLAKE_PRIVATE_KEY` (all of `rsa_key.p8`), `SNOWFLAKE_WAREHOUSE=LB_WH`, `SNOWFLAKE_DATABASE=LB_DB`, `SNOWFLAKE_SCHEMA=APP` and `SNOWFLAKE_ROLE=LB_APP` for Production and Preview. The app writes plain `PROJECTS`, which those database and schema names resolve. For a save that did not land, the `statementHandle` in its Vercel log line is the Query ID to look up in Snowsight's Query History.

4. Check that a `rediss://` URL is set under `REDIS_URL`, `KV_URL` or `UPSTASH_KV_URL`; only those three names are read. If the integration only injected REST variables, copy the database's `rediss://` URL into `REDIS_URL`.

   ```
   vercel env ls
   ```

5. Turn off Vercel Authentication for preview deployments, or every test has to run on production.
6. Deploy. Environment changes reach only new deployments, so deploy again after every change.

   ```
   vercel --prod
   ```

7. Check that `https://<project>.vercel.app/api/ws` answers `"bus":"redis"`, then open `https://<project>.vercel.app/host?host=<token>` on the kiosk. The HUD should read `vercel iad1`, without "no redis".

Q fallback: `tools\start.cmd` starts the laptop hub on port 80 (building `dist` first if it is missing), then opens Chrome in kiosk mode on `%HUB_URL%/host?host=%HOST_TOKEN%`. It reads an uncommitted `.env`. With `HUB_URL` set to the Vercel production URL, the kiosk runs on Vercel and keeps the laptop hub warm: Q switches the host socket to it, and the QR switches to the laptop's join URL (the hotspot pair when `WIFI_SSID` is set). Phones do not follow by themselves; they rescan. With `HUB_URL` left at `http://localhost`, everything runs on the laptop.

```
tools\start.cmd
```

v1's arch STL export still runs from the command line (`lib/` is wired to no page). These are the span and rise of Brunel's Maidenhead arch.

```
node tools/export-arch.mjs --span 128 --rise 24.25
```

Make the sound palette (once, offline). Until it runs, `public/sfx/` does not exist and every palette sound is silent and unflashed; only generated per-object sounds play. `tools/sfx.mjs` writes each missing `public/sfx/<file>.mp3` listed in `tools/sfx-palette.json`, one at a time in palette order, and stops at the first error; it never remakes a file that exists, so delete one to make it again. It reads `ELEVENLABS_API_KEY` from `.env` and refuses to run without it (`--env-file` needs Node 20.6 or later). Every file spends ElevenLabs credits, at 40 a second: 80 for a 2 s sound, 160 for a 4 s loop, about 1440 for the whole palette. Nothing is retried, because a retry is billed again. See the plan and its cost first; that needs no key:

```
node tools/sfx.mjs --dry-run
```

```
node --env-file=.env tools/sfx.mjs
```

`--only <file>` (for example `--only poke`) makes just that one. When the key can read its subscription, the run prints the credits left before, after each file and at the end.

Turn on the secret-scanning pre-commit hook, once per clone:

```
git config core.hooksPath .githooks
```

## MUST list

These eight deliverables defined Completion in v1 (from the v1 PRD's Scope section). The v2 PRD puts v1's plaques, engineering panels, STL export and print out of scope, so those parts are struck through and marked superseded; the v2 MVP follows. The ticks are filled in at each gate, from the results logged in `tests/gates.md`.

- [ ] M1 Kiosk: ~~Turner's painting as a depth relief with mouse lean, three plaques usable by mouse and keys, Show the original, Show the work.~~ Superseded by v2: any artwork (sample 1 at boot) as a depth relief with mouse lean, played from the keyboard (pid 0 walks and pokes), O shows the original, W cycles the four layers. Works at every commit with zero phones.
- [ ] M2 Hub: ~~a Node relay on Fly.io Newark with a stable HTTPS URL, running the same code as the laptop's Q fallback.~~ Superseded by the Vercel relay (Sat Oct 24): `api/ws.js` with Upstash Redis on the Vercel URL, running the same `hub/relay.js` as the laptop's Q fallback; Fly is dropped. Tokens, slot hold, judge-mode slot reserve (now in the host tab: `src/host/slots.js`, `glue.js`), rate limits, health endpoint.
- [ ] M3 Join page: works in any phone's browser. Tap a colour, hold-to-walk pad, one verb button, ~~three plaque panels~~ (superseded by v2: the verb pokes the object the figure stands at, and Add artwork over https), reconnect, wake lock. Under 150 KB.
- [ ] M4 Figures: two cut-paper bodies in six accent colours walking ~~one riverbank curve, depth-placed, never over the train, bridge or hare~~ (superseded by v2: each scene's ground path, depth-placed on its relief). Roster in the margin.
- [ ] M5 Follow camera: fits the group, zoom 1.0 to 1.35, translate-only pan, lean from the group~~, focus frame only when exactly one plaque is owned~~ (superseded by v2: no plaques, so the camera only follows).
- [ ] M6 ~~Plaques and~~ ops: ~~three brass plaques with Look, operator ownership and release rules~~ (superseded by v2: one stop per Gemini object, poked with the verb), J judge mode, R reset under 10 s, Q fallback switch, network layer (W, the platform panel).
- [ ] M7 Content and print: wall label (v2: the AI label margins.js draws), ~~three cited cards~~, tent card with the join QR, pictogram card (cut on Saturday; the tent card carries the same three steps), attendant checklist, colophon, ~~arch object label, dated reconstruction captions~~ (the plaque content is superseded by v2).
- [ ] M8 Submission: public repo from Fri 9:30 PM, README with dependency versions and the AI-tools table, LEARNING.md with timestamps, Devpost with video submitted by Sun 8:20 AM.

The v2 MVP (the v2 PRD's Scope section, MVP items 1 to 7):

- [ ] V1 Capture: a laptop drop or U (`artwork.js`), or Add artwork on a phone over https (`src/join/main.js`).
- [ ] V2 Interpret: `POST /api/interpret` (Gemini). Every AI string is tagged (the chip, "(AI label)", "(AI guess)", "AI guesses"), and the original is one key (O) or tap (Show the original) away.
- [ ] V3 Simulate: `game.loadScene` builds the relief from the reading, and objects move by kind. A saved scene replays without Gemini.
- [ ] V4 Interact: phones walk figures and poke objects; judge-mode slot reserve; R under 10 s.
- [ ] V5 Sound: ElevenLabs palette and per-object sounds on join, appear and poke, quiet (gain 0.3), S mutes, and every sound is named in the margin.
- [ ] V6 Save: every project is saved in Snowflake. The G gallery reloads today's, and "Saved to Snowflake" shows only after the row is found.
- [ ] V7 Deploy: pages, API and relay on Vercel; a fresh clone deploys from this README; the repo is public.

## Dependency versions

Node >= 20 (`engines` in `package.json`). Every package is pinned to an exact version; `package-lock.json` holds the rest of the tree.

| Package | Version | Kind |
|---|---|---|
| @elevenlabs/elevenlabs-js | 2.74.0 | dependency (api: sound effects) |
| @google/genai | 2.31.0 | dependency (api: Gemini) |
| @vercel/blob | 2.8.2 | dependency (api: images, scenes, sound cache) |
| @vercel/functions | 3.10.3 | dependency (api: `waitUntil`) |
| express | 4.22.3 | dependency (laptop hub) |
| ioredis | 6.0.0 | dependency (relay bus on Vercel) |
| ws | 8.22.0 | dependency (relay) |
| three | 0.128.0 (r128) | dev (host page) |
| qrcode-generator | 1.4.4 | dev (host page) |
| nosleep.js | 0.12.0 | dev (join page) |
| vite | 5.4.21 | dev (build) |
| @fontsource/im-fell-english | 5.3.0 | dev (type) |
| @fontsource/libre-franklin | 5.3.0 | dev (type) |
| @fontsource/jetbrains-mono | 5.3.0 | dev (type) |

`tools/depth.py` is not part of the build. It runs once, offline, in Python with torch, transformers, pillow and numpy, none of them pinned.

## AI tools

| Tool | Used for | How it was checked |
|---|---|---|
| Claude Code (Anthropic Claude, Opus model) | The reference prototype and deploy kit, written in the planning folder before this repo existed. In this repo: the Stage 1 to 2 code scaffold (`hub.js`, `src/`, `lib/`, `tests/`, `tools/`), plus these README sections, `CREDITS.md` and the `LEARNING.md` template. | The node:test suites (`npm test`) and the on-device gate runs logged in `tests/gates.md` |
| Claude Code (Anthropic Claude, Opus model) | v2: the build plan and the PRD amendments, and the relay and seat move. That covers `hub/relay.js`, `hub/redisBus.js`, `api/ws.js`, `src/host/slots.js`, the socket rollover in both pages, and this README's Protocol, Env and Run it sections, `tests/gates.md`, `.env.example` and `CREDITS.md`. | The node:test suites (`npm test`) and the gate runs logged in `tests/gates.md` |
| Claude Code (Anthropic Claude, Opus model) | v2's front end, finished after the Three.js teammate left: `src/host/scene.js`, `pathOverlay.js`, `artwork.js`, `gallery.js`, `audio.js`, `margins.js`, `glue.js`, `objectIdMap` in `maskDepth.js`, `host.html`, the phone page, `public/samples/` and `src/shared/learning.json`, plus this README's window.game, TV modules, Constants and MUST sections. | The node:test suites (artwork, audio, margins, maskDepth, glue, camera), private Vite builds, browser checks of the stage and the phone against a fake relay, and the gate runs logged in `tests/gates.md` |
| (add any other tool the team uses) | | |

## Credits

The painting's record, the depth model, the type, the libraries, the services and the sources: see [CREDITS.md](CREDITS.md). Sound: elevenlabs.io.

## Learning

Each teammate's timestamped entries and the stranger-test log: see [LEARNING.md](LEARNING.md).
