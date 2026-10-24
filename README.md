# Living Blueprint: Toy Theatre

A gallery interactive for any artwork. A visitor drops a picture on the exhibit laptop or photographs one (a painting, a postcard, a paper sketch) with their phone. Google Gemini reads it into a scene: named objects, their outlines, a depth guess and a short description of each. The TV builds a still depth relief from that reading in our own shader: nothing in the picture moves, and the object a figure stands at glows. Once the picture is on stage, the TV's own browser estimates its depth with Depth Anything V2 Small and re-skins the relief with it, and Tripo makes 3D models of up to two of its standing objects (see Depth and 3D models). Any visitor scans one code, their phone becomes the controller, and a cut-paper figure walks the picture; the verb button at an object shows that object's description on the phone and in the TV's margin. On the phone, Step inside folds the same reading into a small 3D world, built in the phone's browser with no further AI call (a Tour-into-the-Picture diorama, see Inside view): the TV's depth image turns its floor and walls into terrain, and a Tripo model stands in for its flat. It shows the world first person through the figure's eyes. ElevenLabs sounds play and are named on screen, and Snowflake saves each project for the TV gallery. Every AI label is marked as a guess, and the original is one key or tap away. Three hand-corrected samples ship in the repo and play with no network: J. M. W. Turner, *Rain, Steam, and Speed – The Great Western Railway* (1844, The National Gallery, London, NG538, public domain), Vincent van Gogh, *The Starry Night* (1889, The Museum of Modern Art, New York, public domain), and a sketch drawn for the demo.

Built at SBUHacks 2026 (Stony Brook University, Oct 23 to 25).

Version 2 (Sat Oct 24) moved the realtime relay onto Vercel (Vercel WebSockets fanned out by Upstash Redis, with the host tab owning seats and tokens). It also replaced v1's one painting and three brass plaques with any artwork read by Gemini, plus ElevenLabs sound and Snowflake saves. The v2 PRD puts v1's plaques, engineering panels, STL export and print out of scope. Their pure code (`lib/archGeometry.js`, `heyman.js`, `stl.js`, `crankSlider.js`, `tools/export-arch.mjs`) stays in the repo with its tests, wired to no page. Later on Saturday the v2 PRD's Tier 2 (see its section Toward true 3D) added the depth estimate and the Tripo models, beside Gemini rather than in its place. The sections below describe the code as it stands.

<!-- The sections below are the frozen contract. Every module is built against them; change code and README together. -->

## Layout

```
hub.js                 the laptop hub: serves dist/ and runs hub/relay.js (port 8080 in dev, port 80 for the Q fallback)
hub/                   relay.js (the stateless relay, shared by hub.js, api/ws.js and the tests), redisBus.js (its Redis pub/sub bus on Vercel)
api/                   Vercel Functions: ws.js (the relay at /api/ws), interpret.js (image to scene: Blob + Gemini, saved to Snowflake), projects.js (Snowflake list and get), sfx.js (ElevenLabs sounds cached in Blob), check.js (tests a key or a platform for the API box), depth.js (stores a saved project's depth image in Blob), tripo.js (Tripo 3D models, cached in Blob)
host.html              the TV page (Vite entry) -> dist/host.html, served at /host (any browser; each one hosts its own room)
join.html              the phone page (Vite entry) -> dist/join.html, served at /
src/shared/            protocol.js (constants, WS_PATH, hubUrl; it still exports v1's plaque, slider and owner constants, which nothing imports), scene-validate.js (the scene contract), downscale.js (a picture to a 1024 px JPEG, for the TV and the phone), byok.js (the visitor's own API keys: storage, request headers, masking), slots.json, tokens.css (every colour, font, size and spacing token), learning.json (the L overlay's entries); cards.json (v1's plaque cards, no longer imported)
src/host/              main.js -> scene.js (Three.js stage, window.game) + glue.js (relay socket, players, phone panels, hotspot events, the inside phones' world and pos, the On board seats, HUD, join ticket, resting panel, H/J/R/Q) + apibox.js (the API plug-in box and its margin button, K). glue.js inits audio.js (sound bus, S), margins.js (station sign, the stops, source block, platform panel, Learning overlay; L, X) and artwork.js (drop, U, phone pictures, samples 1/2/3, G gallery; its pure helpers are in gallery.js), plus enrich.js (each scene's depth once it is on stage, through the lazy chunk depthAI.js and its worker depthWorker.js) and models3d.js (its Tripo models, D). Also slots.js (seats, tokens, cap), maskDepth.js (a scene to its depth map, id map, path and hotspots), and the stage's helpers depth.js, figures.js, camera.js and pathOverlay.js. Each module that draws has its own CSS file. figures.js and maskDepth.js are also in the phone's inside chunk.
src/join/              main.js, join.css (the controller); inside.js, inside.css (the Step inside view, a lazy chunk)
src/world/             tip.js (Tour-into-the-Picture geometry and the depth room's fit, pure, node:test) and diorama.js (the phone's inside-view world: floor, back wall, dome and standing flats, all projective-textured through the painting camera, or a relief mesh from the scene's depth image; an optional GLB per object through a lazily imported GLTFLoader)
lib/                   gemini.js (read the artwork), snowflake.js (SQL REST with a programmatic access token or a key-pair JWT), tripo.js (the Tripo v3 client over plain fetch); v1's archGeometry.js, heyman.js, stl.js, crankSlider.js (pure, node:test, wired to no page)
sql/                   projects.sql (the Snowflake user, key and PROJECTS table, run once in Snowsight)
public/                assets/turner-1920.jpg, path.json (v1's bank path), samples/ (index.json, turner.scene.json, sketch.svg, sketch.scene.json, starry-night.jpg, starry-night.scene.json, a <name>.depth.png per sample, README.md). Not in the repo yet: sprites/*.png, sfx/*.mp3
tools/                 start.cmd (the Q fallback kiosk), sfx.mjs + sfx-palette.json (the ElevenLabs palette), depth.mjs (the samples' depth images); v1's depth.py and export-arch.mjs (no page reads their output)
tests/                 *.test.js (node --test): relay, slots, glue, camera, lib, scene-validate, maskDepth, interpret (lib/gemini.js, api/interpret.js), sfx (api/sfx.js, tools/sfx.mjs), check (api/check.js), snowflake (lib/snowflake.js, api/projects.js, sql/projects.sql), artwork (src/host/gallery.js and the sidebar's hit test `partAt` in src/host/artwork.js), audio, margins, byok (src/shared/byok.js), tip (src/world/tip.js), depth (api/depth.js, tools/depth.mjs), tripo (lib/tripo.js, api/tripo.js), models3d (src/host/models3d.js); gates.md
vercel.json            build to dist, install with ONNXRUNTIME_NODE_INSTALL=skip (see Run it), rewrites for / and /host, no-cache headers, maxDuration 300 for api/ws.js (120 for tripo, 30 for interpret and sfx, 15 for projects, check and depth)
vite.config.js         the two pages; resolve.conditions ['onnxruntime-web-use-extern-wasm'], so the 27 MB ONNX Runtime wasm is not copied into dist (see Depth and 3D models)
```

## URLs

- Join page at `/?room=<room>` (the TV's QR carries the room; `/join.html?room=<room>` in `npm run dev`), host page at `/host` (`/host.html` in `npm run dev`). Any browser that opens the host page hosts its own room (see Rooms under Protocol), so neither the page nor its socket needs a token, and the laptop hub serves `/host` to anyone. `?host=<HOST_TOKEN>` on the host page only unlocks the team's paid API calls (see Env).
- WebSocket at `/api/ws` everywhere: the Vercel Function `api/ws.js`, the laptop hub, and Vite's dev proxy (to the hub on 8080). The laptop hub also accepts `/ws`, for kiosks and links set up before the move.
- Health: a plain GET of `/api/ws` on Vercel answers that instance's `{ok, instance, host, sockets, region, bus}`; the laptop hub answers `/healthz` with `{ok, instance, host, sockets, uptime, region, joinUrl}`. Both count every room on that instance: `host` is the number of host sockets (one per room at most), `sockets` the number of phone sockets.
- WebSocket URL (`hubUrl()` in `src/shared/protocol.js`): the page's own origin plus `/api/ws` (ws on http, wss on https). `?hub=` overrides it: `localhost` or `host:port` (ws, plus `/api/ws`), a full `ws://` or `wss://` URL (used as is), or an `http(s)://` origin (plus `/api/ws`).
- The host appends `role=host&key=<hostKey>` to the ws URL, the key from its localStorage `tt.hostKey`; the phone appends `room=<room>`. Q switches the host socket between that URL and `ws://localhost/api/ws` (the laptop hub on port 80), with the same key and so the same room.
- `?roll=<ms>` on either page replaces the socket rollover interval (see Protocol), for testing it.

## Protocol

All messages are JSON objects with a `t` field. Three parties: the phones, the relay (`hub/relay.js`, inside `api/ws.js` on Vercel and `hub.js` on the laptop) and each room's one host tab (a TV). The relay holds no game state. It stamps each phone socket with a random `cid`, type-checks phone messages and routes them inside their room. The host tab owns seats, tokens, colours and every rule: `src/host/slots.js` for seats, `src/host/glue.js` for the rest. Relay instances share messages over a bus: Redis pub/sub on Vercel (`hub/redisBus.js`), and an in-process broker on the laptop and in the tests. Each room has three channels, `tt:<room>:host`, `tt:<room>:phones` and `tt:<room>:ctl`, and each message is tagged with its instance so an instance drops its own echo. A phone message goes straight to its room's host socket when that host sits on the same instance (no Redis command) and over the bus only when it does not; every message reaches exactly one host socket. A player socket may send 1 KB per message and 20 messages a second (`MSGS_PER_SEC`); a host socket 200 messages a second (`HOST_MSGS_PER_SEC`) of up to 64 KB (the servers' `maxPayload`). Past its count, a socket's messages are dropped until the next refill, every second.

Rooms. Every TV hosts its own room, so several TVs run on one deployment at once without touching each other.

- **The key.** The TV keeps a random host key in localStorage `tt.hostKey`: 16 bytes from `crypto.getRandomValues`, base64url, 22 characters, made on first use (a stored value that is not well formed is replaced). It connects with `role=host&key=<hostKey>`. The relay accepts a key that matches `HOST_KEY_RE` (`/^[A-Za-z0-9_-]{22,64}$/`) and closes any other host socket with 4003 (reason `host key`).
- **The room.** The relay names the room itself, `base64url(sha256('tt-room:' + key))` cut to 16 characters, and sends it in the `hub` greeting; the TV never hashes (`crypto.subtle` is missing on plain-http LAN pages). A phone connects with `room=<room>`, which must match `ROOM_RE` (`/^[A-Za-z0-9_-]{16}$/`), else the relay closes it with 4004 (reason `room`). Both patterns are in `src/shared/protocol.js`.
- **One-way.** A phone that knows a room can join it, never host it: the room is too short to pass as a key, and any other key names another room. The key is never shown on screen, because whoever holds it hosts that room.
- **Lifetime.** A reload keeps the key and so the room. Another browser or profile is another room, and with localStorage blocked every load is a new room.
- **Per-room state.** Everything is keyed by room: the host socket, the host tie-break on `ctl` and its 4000, the phone sockets, the 12-socket cap, and `who`/`here` (an `all` reaches only its room's phones).
- **Subscriptions.** An instance subscribes to a room's three channels when its first socket of that room connects and unsubscribes when its last one closes. A socket is announced and routed only once that SUBSCRIBE has resolved; what it sends meanwhile waits (up to 20 messages) and is then handled in order. A rejected SUBSCRIBE closes the socket with 1013 (`relay not ready`), and the page retries. The relay only publishes and subscribes; it writes no Redis keys.
- **Limits.** Each instance holds at most 64 rooms (`MAX_ROOMS`); a socket for a new room past that, host or phone, gets 1013 `busy`. A room the instance already holds still takes sockets.

Player -> relay

| Message | When |
|---|---|
| `{t:'hello', token, slot}` | Join or rejoin. Sent on open when the phone has a stored token, else when the visitor taps a colour; also on a rollover socket and in answer to `who`. `token` is the stored token or `null` (a string over 64 characters becomes `null`). `slot` (0 to 5, an integer, else `null`) is the colour the visitor tapped; ignored on a token reconnect or if taken. |
| `{t:'here'}` | Answer to `who` from a phone with no seat and no pending `hello`: send me the lobby. |
| `{t:'in', lx, a}` | `lx` -1, 0 or 1 (walk left, stop, right); `a` 0 or 1 (the verb button held). Sent on every change plus a 4 Hz heartbeat while any input is non-zero (`INPUT_HZ`; on Vercel each one is a Redis command when the host sits on another instance). |
| `{t:'panel', kind, value}` | The phone sends four kinds. `original` is Show the original on the TV (`value` 1). `inside` is the inside view: `value` 1 enters or asks for the world (sent on Step inside and by the view's ask loop while no `world` has come), 2 re-asserts after a `welcome` while the view already holds a `world`, and 0 leaves (sent on Back, and again when a `pos` reaches a closed view, at most once every 5 s, which repairs a lost Back). `look` (`value` 1) is activity only: the inside view sends it at most once every 20 s, and only while the player is looking around (a drag that moved, or a tilt that turned at least 5°). `artwork` is the phone's photo handoff: `value` is the scene file `/api/interpret` just stored, an `https://<store>.public.blob.vercel-storage.com/scenes/<id>.json` URL, and the relay drops an `artwork` message with any other value. For every other kind, `inside` and `look` included, the relay keeps the first 16 characters of `kind` and turns a `value` that is not a finite number into 0. The host acts on `original`, `inside` and `artwork` and ignores every other kind, `look` included, though every kind counts as activity for idle kicks (see Phone panels). |
| `{t:'hbr', ts}` | Echo of a host heartbeat `{t:'hb', ts}`, for round-trip time. Joined phones only. |

The relay passes these five types with these fields only (`clean()` in `hub/relay.js`) and drops everything else.

Relay -> player

| Message | When |
|---|---|
| `{t:'hb', i}` | Every 2 s from the relay instance the socket is on; `i` is that instance's id (for the network layer). No `ts`: the socket is alive. The phone arms its 5 s watchdog on its first `hb` or `welcome`. Every other message, and an `hb` that carries `ts`, counts as host traffic; after 6 s without any the phone shows "The screen is resting". |
| close 1013 / 1009 / 1008 / 4004 | 1013: `busy` (more than 12 phone sockets in this room on this instance, or a new room past 64 on this instance) or `relay not ready` (the room's SUBSCRIBE failed) / a phone message over 1 KB / an unparsable request URL / no well-formed `room` (see Rooms). |
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
| `{t:'near', label}` | The phone's figure reached an object's stop (`label` is that object's AI label from the scene) or left it (`null`). The verb button reads "About the <label>" (the first 40 characters), else "Walk to something" with `aria-disabled="true"`. A change of label closes the description card. Sent on every change, and after every `mode` `walk` with the last label the host recorded for that phone. |
| `{t:'describe', label, text}` | The answer to the verb at an object (glue's `describeMsg`): `label` is the object's AI label, `text` its `description` (whitespace collapsed, at most 240 characters), or "No description for this one yet." when it has none. The phone shows a cream card with `label` (its first 40 characters) as the heading, `text` below and a Close button: under the verb on the walk screen, and over the inside view while that is open. It closes on Close, on a change of `near`, on leaving the walk screen, or after 20 s; a later `describe` replaces it. |
| `{t:'readout', text}` | A one-off line the phone toasts for 4 s: "Showing the original on the screen for 8 s", "Show the original again in <n> s", "Your picture is on its way to the TV", "One picture every 20 s", "Pictures are paused for the guided tour", "The TV couldn't open that picture; try another". |
| `{t:'hb', ts}` | Host heartbeat every 2 s (sent with `all`); a joined phone answers `{t:'hbr', ts}`. |
| `{t:'world', scene, image}` | The world to step into. It goes to a phone on every `panel` `inside` 1, and on `inside` 2 only when this message's JSON differs from the last `world` sent to that phone. It also goes to every inside phone on every `scene` and `enriched` hotspot event (an `enriched` world is the same scene with a `depth_url` or a `model_url` added). `scene` is `game.scene()` inline and `image` its `image_url`, which must be http(s) or site-relative (`/` not followed by `/` or `\`). |
| `{t:'world', scene:null, reason}` | Instead of the above when there is nothing to step into: no scene (the boot Turner, the flat state), an `image_url` that is anything else (`data:`, `blob:`, empty, as after an unsaved reading), or `JSON.stringify(scene)` over 48000 characters. `reason` is always "This picture can’t be entered yet" (a typographic apostrophe). |
| `{t:'pos', me:{t, facing}, near, others:[{pid, t, facing, color, name}]}` | To each inside phone while the host socket is open. The host checks every 200 ms and sends a phone its `pos` only when the message's JSON differs from the last `pos` sent to that phone, or 3000 ms after that one (`POS_KEEPALIVE_MS`), because each `to` to a phone on another Vercel instance is one Upstash PUBLISH. `inside` 1 or 2 clears that memory, so the first `pos` goes out on the next check. `me` is that phone's figure (`t` rounded to 4 decimals, `facing` 1 or -1), `near` the last label the host recorded for it (else `null`), `others` every other figure with a seat, pid 0 included as `Conductor` in `--slot-keyboard`. Not sent for a phone with no figure or no seat. |

`all` reaches every phone socket, with or without a seat; a phone without a seat ignores `mode`, `near`, `describe` and `readout`. `world` and `pos` go with `to`, to inside phones only. A phone ignores a `world` while its inside view is closed. A `pos` that reaches a closed view means the host missed its Back, so the phone sends `panel` `inside` 0, at most once every 5 s (Back itself starts those 5 s).

Relay -> host

| Message | When |
|---|---|
| `{t:'hub', joinUrl, lanIp, region, wifi, bus, instance, room}` | On host connect, once the room's channels are subscribed. `joinUrl` is the join page without the room: `JOIN_URL` env, else `https://<request host>/` on Vercel and `http://<lanIp>[:port]/` on the laptop; the TV adds `?room=` for the QR. `lanIp` is `null` on Vercel. `region` is `VERCEL_REGION` (or `vercel`) on Vercel and `local` on the laptop. `wifi` is `{ssid, pass}` from `WIFI_SSID`/`WIFI_PASS` on the laptop, sent only to a host socket from the laptop itself (a loopback address: the TV's Q socket is `ws://localhost`), else `null`. `bus` is `redis` or `local` (`local` on Vercel means no Redis URL is set; the HUD then says "no redis"). `instance` is a random id per relay instance. `room` is this host's room (see Rooms). |
| `{t:'open', cid}` | A phone socket of this room opened, on any instance. |
| `{t:'gone', cid}` | That phone socket closed. |
| `{t:'hello', cid, token, slot}` / `{t:'here', cid}` / `{t:'in', cid, lx, a}` / `{t:'panel', cid, kind, value}` / `{t:'hbr', cid, ts}` | Phone messages, cleaned and stamped with the socket's `cid`. |

The relay sends no `stats`, `join`, `away`, `back` or `leave` any more; the host makes those itself (see Seats).

Host -> relay

| Message | Effect |
|---|---|
| `{t:'to', cid, msg}` | Forward `msg` to that phone socket of the room, on whichever instance holds it. A `cid` of another room reaches nobody. |
| `{t:'all', msg}` | Forward `msg` to every phone socket of the room, on every instance. |
| `{t:'close', cid, code, reason, msg?}` | Send `msg` if there is one, then close that socket with `code`. Only 4001 (evicted) and 4002 (replaced) are accepted; `reason` is cut to 32 characters. |

Anything else from the host is ignored. There is no `kick` or `cap` message: the host applies both itself.

Seats (`src/host/slots.js`, in the host tab)

- Six seats, one per colour in `slots.json`. The cap is 6 (`setCap` clamps to 0 to 6; the host sets 6 on connect and on R). With the seats at the cap the lobby is empty and a new `hello` gets `full`.
- A new `hello` (no token, or one the host does not know) takes the tapped slot if it is free, else the first free one. It gets a new random token (16 bytes, base64url) and the next pid. Pids start at 1 and are never reused, across host reloads too.
- A `hello` with a known token takes its seat back. If the seat's old socket is still open (a phone's rollover, a half-open socket, a second tab), the newest socket wins and the old one is closed with 4002. A close the host ordered while its own socket was down never reached the relay, so that socket still counts when it answers `who`. A seat that was away reports `back`, then `join`.
- When a seat's socket is `gone` the host zeroes the figure, reports `away` and holds the seat 20 s. When the hold runs out the seat drops (`leave`; a socket still bound to it gets `evicted`, reason `timeout`). A `gone` from a socket that no longer holds a seat (replaced by a newer one) is ignored.
- A kick remembers the token (the last 50 are kept), sends `evicted`, closes 4001 and reports `leave`. That token's later `hello` gets the same eviction.
- The host saves its seats, next pid, counters and kicked tokens to its localStorage (`tt.seats`, the value prefixed with its host key and a newline) on every change. A host tab reloaded within 10 minutes restores its seats, each on a 20 s hold, so phones that answer `who` keep their pid and colour. Kicked tokens are restored whatever their age. A list saved under another key, or before rooms, restores nothing, kicked tokens included.
- Seat events reach glue.js as `{t:'join', pid, name, color}`, `{t:'away', pid}`, `{t:'back', pid}`, `{t:'leave', pid}`, `{t:'in', pid, lx, a}`, `{t:'panel', pid, kind, value}` and `{t:'hbr', pid, ts}`. These are the messages the v1 hub sent, so the player manager did not change. `addPlayer` is an upsert, so a repeated `join` is harmless.

Host replacement. There is one host per room across every instance, and the room's newest host socket wins. Only a tab with the same key can replace a host: a second tab in the same browser profile. Another TV has another key and so another room. The relay closes an older host socket of the room on its own instance with 4000 and publishes the new socket's id on `tt:<room>:ctl`. Every other instance holding that room then closes its own host socket with 4000 if that socket is older (by connect time, ties broken by id), so two tabs opened at the same moment leave one host instead of closing each other. An instance that keeps its host after hearing an older claim publishes its own claim again, so an instance that was still subscribing when the first claim went out hears it and gives way. A host page closed with 4000 stops reconnecting and says "Another host tab took over". The exception is the old socket of its own rollover, whose close the page ignores.

Rollover (make-before-break). Vercel closes every WebSocket at the function's max duration (300 s on Hobby, `maxDuration` in `vercel.json`). Both pages therefore replace their socket 240 to 270 s after it opens (`ROLLOVER_MS` plus up to `ROLLOVER_JITTER_MS`; `?roll=<ms>` sets the interval exactly).

- Phone (after `welcome`): it opens a second socket and says `hello` with its token. When that socket gets `welcome`, the phone switches to it and closes the old one. The host has already closed the old cid with 4002, and the retiring socket ignores that close. Each socket rolls once, timed from when it opened (a later `welcome`, such as an answer to `who`, does not restart the clock), and a retiring socket does not answer `who`. If no `welcome` arrives within 5 s (`ROLL_WAIT_MS`), or the new socket closes first, the phone drops the new socket, keeps the old one, says `hello` on it again (the host may already have moved the seat) and tries again 30 s later; for 15 s a 4002 on that old socket counts as an ordinary drop that reconnects. An `evicted` on the new socket ends the session as usual. The seat, pid and colour stay the same and the figure does not stop.
- Host: it opens a second host socket with the same key and switches to it as soon as it opens; the relay closes the old one with 4000, which the page ignores. If the new socket has not opened within 5 s, the host keeps the old one and tries again 30 s later. A rollover is not a gap, so the host sends no `who`.

After a gap. Any other host reconnect is a gap: a dropped socket, a relay restart, or Q. Messages sent while the host was away went nowhere (`open`, `gone`, `hello`), so on open the host puts every live seat on a 20 s hold (`hostOpen()`), sets the cap to 6 and sends `all {t:'who'}`. Seats that answer keep their pid and colour; seats that stay silent drop when their hold ends. Phones without a seat answer `here` and get the lobby again. Meanwhile the figures stand still, phones whose own socket is still up show "The screen is resting", and the TV shows its resting panel 2 s after its socket dropped.

Phone reconnect. A phone that loses its socket retries after 0.5, 1, 2, 4 and then every 8 s, and shows "Reconnecting…" after 1 s. On open it says `hello` with its token, so it keeps its seat while the 20 s hold lasts. A connect that hangs (captive Wi-Fi) is retried after 5 s. The relay never refuses a well-formed room, so a phone in a room no TV hosts any more (a stale QR, or a TV moved to a new browser) waits on "Connecting to the picture…" or "The screen is resting" until that TV returns.

Close codes: 4000 host replaced by a newer host socket; 4001 evicted (phone stops auto-reconnect); 4002 `replaced`, the same token said `hello` on a newer socket (outside a rollover the old tab keeps its token, shows the end screen and stops auto-reconnect, so two tabs never steal the seat back and forth); 4003 a host socket without a well-formed `key` (the TV stops and says "The hub refused this screen’s room key."); 4004 a phone socket without a well-formed `room` (the phone stops and shows its no-room screen); 1013 `busy` (more than 12 phone sockets in one room on one relay instance, or a new room past 64 on one instance) or `relay not ready` (the room's SUBSCRIBE failed); 1009 player message over 1 KB; 1008 an unparsable request URL (the pages reconnect after 1013, 1009 and 1008). On Vercel an upgrade waits for Redis to answer and is refused with HTTP 503 if Redis is silent for 4 s; the page retries with backoff.

## HTTP API

Six Vercel Functions beside the relay. They run on Vercel and under `vercel dev` (see Run it); the laptop hub and `npm run dev` serve only the pages and the relay, so these paths do not exist there. Every answer is JSON (except the 204) with `Cache-Control: no-store`. Each file also exports `createHandler()`, so the tests inject Blob, Gemini, ElevenLabs, Snowflake and `fetch`. Six callers use them. The TV's `artwork.js` sends `POST /api/interpret` with `source:'drop'` and calls `GET /api/projects?id=` for the save poll. The phone sends `POST /api/interpret` with `source:'phone'`. The TV's `audio.js` sends `POST /api/sfx`. The TV's `apibox.js` sends `POST /api/check`. The TV's `enrich.js` sends `POST /api/depth`, and its `models3d.js` calls `/api/tripo`.

Bring your own key. The TV may add four request headers from the API box (see `src/host/apibox.js`): `x-gemini-key`, `x-gemini-model`, `x-elevenlabs-key` and `x-tripo-key`. They come from `byok.apiHeaders()`, which every TV call to `/api/` goes through: `artwork.js` on every site-relative `/api/` request (`/api/interpret` and `/api/projects`; never a Blob or sample URL), `audio.js` on `/api/sfx`, `apibox.js` on `/api/check`, `enrich.js` on `/api/depth` and `models3d.js` on `/api/tripo`. So every header the visitor set goes on every one of those calls, and each function reads only its own. Only the fields the visitor set are sent, so a visitor with no keys sends exactly what the page sent before, and `apiHeaders()` sends none at all unless the page is on https or localhost (`secureOrigin` in `src/shared/byok.js`). The phone sends none. A key is valid when it matches `/^[A-Za-z0-9_.-]{20,200}$/` after trimming (`KEY_RE`); a blank or whitespace-only header means no key, and a malformed one (a repeated header included) is refused as below. `x-gemini-model` must be `gemini-3.5-flash-lite` or `gemini-3.8-flash` (`GEMINI_MODELS`); it is read only beside a valid `x-gemini-key`, and any other value is ignored. `KEY_RE`, `GEMINI_MODELS` and `userKey(req, header)` (`undefined` for no key, `null` for a malformed one, else the trimmed key) live in `api/interpret.js`; `api/sfx.js` and `api/check.js` import them. A Tripo key has its own rule, `TRIPO_KEY_RE` (`/^tsk_[\x21-\x7e]{8,200}$/`, `tsk_` then 8 to 200 printable characters with no space, because the rest of the real character set is unverified) in `src/shared/byok.js`, read by `tripoKey(req)` in `lib/tripo.js` with the same three answers. A visitor's key is used for that one request and never stored, logged or echoed: `api/interpret.js` gives it a fresh `@google/genai` client per request instead of `lib/gemini.js`'s cached one, `api/sfx.js` gives it a fresh ElevenLabs client and writes `[key]` in its place in any error line, and `api/tripo.js` does the same for a Tripo key (and the team's). What the key makes still lands in the team's stores: the image and scene in Blob and the row in Snowflake, a sound in the shared Blob cache under its label, and a model in the shared Blob cache under its object's key.

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

`GET /api/projects` (`api/projects.js`): the saved projects, for the "Saved to Snowflake" check.

| Request | Status | Body |
|---|---|---|
| `GET /api/projects` | 200 | `{ok:true, projects, configured:true}`: the newest 24 by `CREATED_AT`, each `{id, name, source, image_url, scene_url, title_guess, artist_guess, created_at}` (`created_at` an ISO time). `projects` is `[]` when the table is empty. |
| | 200 | `{ok:false, configured:true, error:'unavailable', projects:[]}`: Snowflake is configured but did not answer (the page's cue for "local only"). |
| | 200 | `{ok:true, projects:[], configured:false}`: no Snowflake env (see Env). |
| `GET /api/projects?id=<id>` | 200 | `{ok:true, project}`: `{id, name, source, image_url, scene_url, title_guess, artist_guess, credit, created_at, scene}`, with `scene` parsed from the row (`null` if it is not JSON). |
| | 404 | `{ok:false}`: no such project, which is also the answer while its save is still in flight. |
| | 404 | `{ok:false, configured:false}`: no Snowflake env. |
| | 503 | `{ok:false, configured:true, error:'unavailable'}`: the lookup failed (Snowflake did not answer). |
| | 400 | `{ok:false, error:'bad id'}`: `id` is not 1 to 64 letters, digits, `_` or `-` starting with a letter or digit (an empty `?id=` included). Checked before the Snowflake env. |
| any other method | 405 | `{ok:false, error:'method not allowed'}`, header `Allow: GET`. |
| any request | 500 | `{ok:false, error:'unavailable'}`: the handler itself threw. |

Reads are synchronous SQL REST calls, each with the PAT or else a fresh key-pair JWT, every HTTP call cut at 8 s; a read Snowflake answers 202 (a warehouse resuming) is polled four times over about 3 s, then counts as unavailable.

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

Request body `{service}`, one of `gemini`, `elevenlabs`, `tripo`, `snowflake` or `storage` (`SERVICES`; the body is capped at 4 KB), with the same optional `x-gemini-key`, `x-elevenlabs-key` and `x-tripo-key` headers as above. A visitor's own key can be tested by anyone. A check of the team's setup (a provider with no visitor key, and `snowflake` and `storage` always) needs `x-host-token` to match `HOST_TOKEN` when it is set (the API box sends the page's `?host=`); otherwise the answer is 200 `{ok:false, using:'none', detail:'Team checks run from the TV only'}`.

| Status | Body | When |
|---|---|---|
| 405 | `{ok:false, using:'none', detail:'POST only'}`, header `Allow: POST` | Not a POST. Not counted by the rate limit. |
| 429 | `{ok:false, detail:'Too many checks; wait a minute'}` | This client (the first `x-forwarded-for` entry, else the socket address) has sent 10 checks in the last minute (`MAX_PER_MINUTE`), per instance and in memory. Every POST counts, bad ones included. |
| 400 | `{ok:false, using:'none', detail:'Unknown service'}` | `service` is not one of the five, or the body is missing, not JSON or over 4 KB. |
| 200 | `{ok, using, detail, credits?}` | Every check that ran. `using` is `yours` (the visitor's key was tested), `team` (the server's env) or `none` (nothing to test). `detail` is one short line of fixed text, safe to show on the TV. |
| 200 | `{ok:false, using:'none', detail:'The check itself failed'}` | The handler threw. |

What each service tests:

- **`gemini`.** `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1` with the key in `x-goog-api-key`: a model list, so no generation quota is spent. The visitor's `x-gemini-key`, else `GEMINI_API_KEY`, else `{ok:false, using:'none', detail:'No Gemini key on this server; paste your own'}`. A 200 is "Gemini accepted the key".
- **`elevenlabs`.** `GET https://api.elevenlabs.io/v1/user/subscription` with `xi-api-key`; `credits` is `character_limit - character_count` (at least 0), or `null` when the answer has no counts, and the detail reads "ElevenLabs accepted the key; <n> credits left". A 401 there (a key scoped without user read access may still make sounds) falls back to `GET /v1/models`; a 200 from that is `ok:true` with `credits:null` ("ElevenLabs accepted the key (it may not read its credits)"). The visitor's `x-elevenlabs-key`, else `ELEVENLABS_API_KEY` (whose detail adds "; sound generation is off on this server" when `SOUND_GEN` is not `on`), else `using:'none'`. Every answer that called ElevenLabs carries `credits` (a number or `null`).
- **`tripo`.** `GET https://openapi.tripo3d.ai/v3/account/balance` with `Authorization: Bearer <key>`, a query that starts no task (that it costs nothing is the research's reading, not stated by Tripo). `credits` is `parseFloat(data.balance)`, or `null`, and the detail reads "Tripo accepted the key; <n> credits left". A 200 whose `code` is not 0 reads "Tripo answered with an error". The visitor's `x-tripo-key`, else `TRIPO_API_KEY`, else `using:'none'`.
- **`snowflake`.** The team's only: `configured()`, then `listProjectsResult(1)` from `lib/snowflake.js`. "Snowflake answered", "Snowflake did not answer", or `using:'none'` with "Snowflake is not set up on this server".
- **`storage`.** The team's only. With neither `BLOB_READ_WRITE_TOKEN` nor `BLOB_STORE_ID` (a newer store, which `@vercel/blob` reaches by OIDC) it answers `using:'none'` with "No Blob store connected". Otherwise it looks up `check/never-written.txt`: "not found" means the store answered these credentials ("Blob storage is connected"); any other error reads "Blob storage refused the check", and no answer in 8 s "Blob storage did not answer in 8 s". Nothing is written.

A malformed key header answers 200 `{ok:false, using:'yours', detail:'That does not look like a Gemini key'}` (or ElevenLabs, or Tripo) with no upstream call. A failed upstream call reads "<platform> refused the key" (400, 401 or 403), "<platform> says the key is over its limit" (429), "<platform> answered HTTP <status>", "Could not reach <platform>" or "<platform> did not answer in 8 s". Each upstream call, the Snowflake check included, is cut at 8 s (`TIMEOUT_MS`; `maxDuration` 15 in `vercel.json`). No answer and no log line ever carries a key or an upstream body.

`POST /api/depth` (`api/depth.js`): stores a saved project's depth image, so its next replay loads the file instead of running the model again.

Request body `{id, png}`. `id` is the project id, `/^[A-Za-z0-9_-]{1,64}$/`. `png` is the depth image (see Depth and 3D models) as plain base64 (no `data:` prefix, no line breaks), at most 1 MB decoded (`MAX_PNG`, 1,048,576 bytes) and recognised as a PNG by its signature. With `HOST_TOKEN` set, `x-host-token` must match it, checked before the body is read; an empty `HOST_TOKEN` means no check, local only, as in `api/sfx.js`. The image is stored in Blob at `depth/<id>.png`: public, `image/png`, no random suffix, overwritten when it is already there. `maxDuration` is 15 s.

| Status | Body | When |
|---|---|---|
| 200 | `{depth_url}` | Stored; `depth_url` is the Blob URL. |
| 405 | `{error:'POST only'}`, header `Allow: POST` | Not a POST. |
| 401 | `{error:'host token'}` | The host token does not match. |
| 400 | `{error}`: `bad body`, `bad id`, `no png`, `not base64` or `not a png` | The body is not a JSON object, or the field named is wrong. |
| 413 | `{error:'too large'}` | The body, or the decoded PNG, is over its cap. |
| 500 | `{error:'storage'}` or `{error:'internal'}` | The Blob write failed, or the handler threw. |

Only the TV's `enrich.js` calls it, for a saved project (a scene whose `source` is not `sample` and whose `id` passes that rule), with a 15 s timeout; the samples ship their depth files instead.

`/api/tripo` (`api/tripo.js`, over `lib/tripo.js`): a Tripo 3D model (GLB) for one scene object, cached in Blob so each object is paid for once. The TV's `models3d.js` chooses the cache key and polls; no call ever waits for a model to finish.

Every call, GET and POST, needs `x-host-token` to match `HOST_TOKEN` when it is set (401 `{error:'host token'}`), checked before the key and the body; an empty `HOST_TOKEN` means no check, local only. The Tripo key is the visitor's `x-tripo-key`, else `TRIPO_API_KEY`. A malformed `x-tripo-key` is 400 `{error:'bad key'}`. With no key at all the answer is 200 `{status:'off'}`, before the body is read. Any other method is 405 `{error:'GET or POST only'}` with `Allow: GET, POST`, and a handler that throws is 500 `{error:'tripo failed'}`.

`POST {key, png}`. `key` is 40 hex characters (the TV's sha1 cache key; upper case is accepted and stored lower case). `png` is the object's cut-out as base64 PNG (a `data:image/png;base64,` prefix and whitespace are tolerated), at most 3 MB decoded (`MAX_PNG`), signature checked; the body is capped at about 4 MB (`MAX_BODY`), under Vercel's 4.5 MB request limit. A bad key, png or body is 400 `{error}`, and a png or body over its cap is 413 `{error}`. Then, in this order:

1. `tripo/<key>.glb` is in Blob: `{status:'success', model_url}`.
2. `tripo/<key>.task.json` is there and under 15 minutes old (`TASK_TTL_MS`, the age from Blob's own `uploadedAt`): `{status:'queued', task}` with the task it holds. An older one is polled once first, because the TV stops polling when its scene leaves the stage and a finished task would otherwise be paid for again: `success` copies the GLB as `GET` does and answers `{status:'success', model_url}` (a copy that fails is `failed`, not a new task); `queued` or `running` answers `{status:'queued', task}`; a busy, no-credits or unreachable Tripo answers as below. Only a failed task (refunded) or a 4xx refusal (other than busy or no credits, such as a 404 for a task this key cannot see) goes on to a new task.
3. A create for the same key is already running on this instance: the request shares it.
4. On the team's key only, this instance has started `TRIPO_MAX_PER_HOUR` tasks (default 6; 0 means cache only) in the last rolling hour: `{status:'capped'}`. A visitor's key skips the cap and does not count toward it, and a slot comes back when Tripo answered with an error status, since nothing was charged.
5. Otherwise, on the team key, the crop is stored public at `tripo/in/<key>.png` and a Tripo v3 image-to-model task is created with that URL as its input; a visitor's key (uncapped) skips the Blob copy and uploads the crop to Tripo, so the store is never a free image host. It falls back to uploading the crop to `/v3/files` and creating the task from the file token only when the crop could not be stored or Tripo refused the URL outright, never after a 429 or a 2010 (an upload would be refused too) or a timeout (Tripo may already have made that task). `tripo/<key>.task.json` (`{task}`, max-age 60 s) is written, and the answer is `{status:'queued', task}`.

`GET ?task=<id>&key=<key>` polls Tripo once (`key` 40 hex, `task` 1 to 128 letters, digits, `_` or `-`, else 400 `{error}`). `queued` and `running` answer `{status, progress}` (0 to 100). On `success` the GLB is copied into Blob at `tripo/<key>.glb`: a `head()` first, so two polls that both saw success end on one file; the signed download URL fetched with no `Authorization` header, so the key never reaches Tripo's CDN; at most 25 MB (by `Content-Length` and by stream), the `glTF` magic checked, stored public as `model/gltf-binary` with no random suffix. The answer is `{status:'success', model_url}`, the Blob URL; Tripo's own URL, which expires (about a day, per the research), is never stored. `failed`, `cancelled`, `banned`, `expired` or any other status, a success with no https model, and a copy that fails all answer `{status:'failed', reason}`.

Upstream failures on either method are HTTP 200 too: a 429, or code 1007 or 2000 (the account's 10-task concurrency), is `{status:'busy', retry_after}` (Retry-After in seconds, else 5); code 2010 is `{status:'no_credits'}`; anything else is `{status:'failed', reason}`. `reason` is short fixed text such as `tripo code 1004`, `tripo HTTP 502`, `failed 2008`, `timeout` or `error`; no upstream text is passed through, and no reply or log line carries a key (a log line writes `[key]` in its place).

Every task is created with `{model:'v3.1-20260211', texture:true, pbr:false, texture_quality:'standard', face_limit:20000}` (`TASK_OPTIONS`) at `https://openapi.tripo3d.ai/v3`, the global site (`.com` is the China site). `model` is always sent, because Tripo's migration notes say leaving it out is a 400 (1004). It never sends `quad` (FBX, which GLTFLoader cannot read) or `compress` (meshopt, for which no decoder is wired). The research puts this at about 30 credits per object, with failed tasks not charged. Each Tripo call is cut at 20 s and the GLB download at 60 s; `vercel.json` gives the function 120 s.

## Scene

`validateScene(raw, meta, opts)` in `src/shared/scene-validate.js` (plain JS for Node and the browser) makes every scene: `api/interpret.js` runs it on Gemini's answer before storing the scene file. `raw` is Gemini's answer (an object or its JSON text) or a stored scene. It never throws and always returns exactly this shape; a stored scene re-validates to itself, and garbage gives an empty scene on the flat path.

`{id, source, edited, credit, image_url, scene_url, model, generated_at, ai_draft, title_guess, artist_guess, palette, ground_path, objects}`, plus `depth_url` when it has a valid one

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
| `depth_url` | Optional: the picture's depth image (see Depth and 3D models), kept by the same rule as `model_url` below. The TV sets it once `/api/depth` has stored a saved project's estimate, and the sketch's and Starry Night's files have `/samples/<name>.depth.png` (the Turner's has none, see Depth and 3D models). It is appended last, after `objects`. |
| `objects` | Up to 8 `{label, kind, box, mask, depth, colour, motion, sound_prompt}`, plus `description` when it has one and `model_url` when it has a valid one (in that order), most prominent first. An object with no usable box is dropped. |
| `objects[].label` | At most 40 characters, else the kind. |
| `objects[].kind` | One of `KINDS`; anything else is `object`. |
| `objects[].box` | `[x0, y0, x1, y1]`, ordered, at least 1 wide and 1 tall. Gemini sends `box_2d` as `[ymin, xmin, ymax, xmax]`; a stored scene has `box`. With no usable box, a valid image-frame mask's bounds stand in. |
| `objects[].mask` | The outline in image space, 3 to 24 `[x, y]` points, or `null` when it is missing, has a non-numeric point or is too small (under 25 square units, or under 2% of its box). Longer outlines are thinned evenly, keeping the first and last point. |
| `objects[].depth` | 0 nearest the viewer to 1 farthest (the sky, the horizon), three decimals. Missing means `1 - y1/1000`: the lower the box's foot, the nearer. |
| `objects[].colour` | `#rrggbb` (`color` is read too), else a palette colour, else `#808080`. |
| `objects[].motion` | One of `MOTIONS`; anything else is `none`. Still read and kept, but nothing on screen moves by it any more (see Glow and Inside view); only audio.js's unused `poke` branch reads it. |
| `objects[].sound_prompt` | At most 12 words and 120 characters (`''` when none); what `POST /api/sfx` takes as `prompt`. |
| `objects[].description` | Optional: one line (control characters and runs of whitespace become one space, trimmed), at most 240 characters (`LIMITS.description`); a longer one is cut back to its last whole word (a hard cut at 240 for one word with no space). A missing, empty or non-string value drops the key, so an old scene without one still validates. Gemini is asked for one or two plain sentences of at most 220 characters: what this part of the picture shows and one thing worth noticing in how it is painted or drawn, with no invented names, dates or facts. The three samples carry hand-written ones (at most 198 characters). It is what the verb shows (see Hotspot events). |
| `objects[].model_url` | Optional: a 3D model (glTF or GLB) for the inside view, kept only as an `https://` URL or a site-relative path (`/` not followed by `/` or `\`), at most 300 characters with no whitespace (`assetUrl()`); anything else drops the field. Neither it nor `depth_url` is in `sceneJsonSchema`, so Gemini never writes one: the TV sets it when Tripo's model is in Blob (`game.setObjectModel`), or it comes from a hand-authored scene. |

Text fields become one line (control characters and runs of whitespace turn into one space); `kind`, `motion` and `source` match case-insensitively.

Coordinates are image space: 0 to 1000 on both axes whatever the picture's aspect, x left to right, y top to bottom, clamped and rounded to integers. path.json's UV is `u = x / 1000`, `v = 1 - y / 1000`. Scene `depth` runs the other way from path.json's `h` and the depth map (both 1 near): near is `1 - depth`.

`KINDS`: `sky`, `cloud`, `celestial`, `water`, `ground`, `plant`, `building`, `vehicle`, `animal`, `person`, `fire`, `object`. `MOTIONS`: `none`, `sway`, `drift`, `bob`, `spin`, `fly`, `flicker`, `twinkle`. `LIMITS` holds the caps above (objects 8, mask points 24, path points 8, palette 5, label 40, sound words 12, guesses 120, description 240).

`meta` is `{id, source, edited, credit, image_url, scene_url, model, generated_at}`; each one given wins over raw's own field of that name, and a missing (or `null`) one falls back to raw's.

`opts.maskFrame` says where a raw Gemini mask lives. `'box'` (the default, and what `api/interpret.js` uses; Gemini's documented frame): its points are 0 to 1000 inside the object's `box_2d` and are mapped into image space. `'image'`: they are already image space. Only objects that carry `box_2d` are mapped; a stored object (with `box`) is always image space, so re-validating never moves a mask.

`sceneJsonSchema` (the same file) is the response schema sent to Gemini, kept flat and in step with `KINDS`, `MOTIONS` and `LIMITS`. It requires `description` on every object; `lib/gemini.js`'s `PROMPT` asks for it as above, and tells Gemini visitors read about each thing they reach.

`src/host/maskDepth.js` (pure, node:test; `scene.js` calls it on every `loadScene`) turns a validated scene into what the relief takes. `sceneDepth(scene, {w, h, blurRadius})`: a depth map in `depth.js`'s format, `{data, w, h, placeholder:false}` (256 by 192 and blur 3 by default, rows bottom-up, 0 far to 1 near), each object painted farthest first over the prototype's sky-and-ground gradient, with `sky`, `ground` and `water` keeping half that gradient. `pathPoints(scene, sample, n = 8)`: `n` path.json-style `[u, v, h]` points spaced evenly along `ground_path`, `u` clamped to 0.05 to 0.95, `h` from the depth sampler (0.5 without one). `objectHotspots(scene, points)`: one `{index, label, t, look, zoom}` per usable object, `sky`, `cloud` and `celestial` included, so every object can be walked to and glows. Each wants the `t` nearest its box's bottom-centre, within 0.26 to 0.97 (`MIN_T` + 0.11, clear of the staggered starts, to 1 − `HOTSPOT_HALF_WIDTH`). Stops keep the objects' left-to-right order (box centre x, ties by that `t`, then index) and sit at least 0.07 apart (two half-widths plus 0.01, so a walk leaves one stop before it reaches the next); a crowded or out-of-order run is spread 0.07 apart around its mean, kept inside that range, instead of dropped, so a walk end to end meets each object once. That range holds 11 stops; past 11 usable objects (only unvalidated input, a validated scene has at most 8) the least prominent get none. `look` is the box centre in UV, `zoom` 1.3. Fewer than 2 path points give `[]`. `objectIdMap(scene, {w, h})`: `{data: Uint8Array(w*h), w, h}`, each pixel `i + 1` for `scene.objects[i]` (the original index, even when an earlier entry was skipped as unusable) and 0 for none. It uses `sceneDepth`'s row layout, its even-odd fill, its box fallback for a null or degenerate mask and its painting order (far first, nearer overwrites, ties to the later object). It is not blurred, so ids never mix at an edge. `w` and `h` default to 256 by 192, clamped to 2 to 2048; at most 32 objects are read.

## window.game

Defined synchronously by `src/host/scene.js`; every method is callable immediately, before any image has loaded. `src/host/glue.js` calls it and assigns `sendTo` and `sendAll`; `src/host/artwork.js` calls `loadScene`, `showImage` and `setStatus`; `src/host/enrich.js` calls `setDepth` and `setSceneField`, and `src/host/models3d.js` calls `setObjectModel`. v1's `setPanel`, `readout`, `exportArch`, `setOwner`, `setLever` and `setArch` are gone with the plaques and panels.

| Call | Contract |
|---|---|
| `addPlayer(pid, name, color)` | Upsert a figure at its staggered start (pid 0 at t 0.15, pid n at 0.15 + 0.012 × ((n − 1) mod 6 + 1), all short of the first stop). Body by pid parity: top hat for odd pid, bonnet for even (pid 0 is the kiosk keyboard player and is always in the picture). A repeated call for a figure standing at a stop re-emits its `near`. |
| `removePlayer(pid)` | Remove the figure (never pid 0). |
| `setInput(pid, lx, a)` | Walk direction (−1, 0, 1) and verb button. A rising edge of `a` while the figure is at a stop emits a `describe` event for that object; nothing pops, scales or waves. Ignored while the figure is frozen (`a` is still tracked, so a held button never fires on release). |
| `onHotspot(cb)` | `cb(evt)` for every event below; returns an unsubscribe function. Any number of listeners (glue.js and enrich.js each add one); one that throws is logged and the rest still run. |
| `sendTo(pid, msg)` / `sendAll(msg)` | Network; no-ops until glue assigns them. |
| `freeze(pid, on)` | Zero the figure's input and hold it in place. Nothing calls it since the plaques went. |
| `setJudge(on)` | Judge-mode indicator ("Guided tour" in `#modeTag`); stops and suppresses the attract loop. |
| `showOriginal()` | The current image alone over the stage for 8 s (`ORIGINAL_MS`), in `#original`. Its tag reads "Original. " plus the scene's `credit`, else its `title_guess` plus "(AI guess)". After `showImage`, or when the title is `unknown`, it reads "Original. As it was sent." Esc, W or the timer hides it. |
| `reset()` | Figures to their starts with input, freezes and waves cleared; the glow cleared; the layer back to painting (emits `layer`); attract stopped. The scene stays; glue's R then loads sample 1. Under 10 s. |
| `loadScene(scene, {image})` | -> `Promise<void>`. Runs `validateScene(scene)` and loads `image` (default `scene.image_url`). Only site-relative, http(s), `blob:` or `data:image` URLs are accepted; anything else rejects with "image URL refused". Images load with `crossOrigin='anonymous'`, so a Blob image needs CORS. It then rebuilds the relief. The plane's height is fixed at 2.985 world units (4 / (1920/1433)), its width is height × the image's aspect (clamped 0.25 to 4), with 512 segments on the long side. Depth comes from `sceneDepth` and ids from `objectIdMap`, both at 256 texels on the long side. The path is `pathPoints(scene, sampler(depth))`, with one stop per `objectHotspots` entry (id `obj:<index>`). Figures keep their colours and go back to their starts, facing right. If the image fails it rejects and keeps the old scene. A call overtaken by a later `loadScene` or `showImage` resolves without touching the stage. Emits `{type:'scene', scene}` with the validated copy, which `scene()` then returns. |
| `showImage(url)` | -> `Promise<void>`. The flat state, used while a picture is read and after a failed reading: the image on a flat plane, the flat path `[[0, 850], [1000, 850]]` (u clamped to 0.05 to 0.95), no stops. Same URL rules and overtaking as `loadScene`. Emits `near` with `null` for every figure that stood at a stop, then `{type:'scene', scene:null}`. |
| `setStatus(text \| null)` | One line in `#status` at the stage's top centre (whitespace collapsed, at most 160 characters; `#hint` moves below it). `null` or `''` hides it. |
| `scene()` | The current validated scene, or `null` (the boot Turner and the flat state). |
| `stats()` | `{fps, zoom, lean, layer}` for the HUD. |
| `positions()` | `[{pid, t, facing}]` for every figure, pid 0 (the keyboard player, the Conductor) included: each figure's path parameter and facing (1 or -1). glue.js sends them to inside phones as `pos`. |
| `setDepth(depth)` | -> `true`, or `false` for no scene or a bad image. `depth` is a depth image in memory, `{data: Uint8Array, w, h}` (see Depth and 3D models), 2 to 2048 on each side. It re-skins the relief with it, unblurred: the depth texture, the sampler and the path's heights (the walk keeps its points, a backtick-overlay edit included). The figures, stops, hotspots, object ids, glow and camera stay as they were. The depth layer's caption then reads "Depth map: estimated from the picture by Depth Anything V2 (AI estimate)" until the next `loadScene`. |
| `setSceneField(key, value)` | -> `true` or `false`. Only `depth_url`: sets it on the current scene through `validateScene`, `false` (and no change) when there is no scene or the URL does not pass. Emits `{type:'enriched', scene}`. |
| `setObjectModel(index, url)` | -> `true` or `false`. Sets `objects[index].model_url` the same way, `false` for no scene, no such object or a URL that does not pass. Emits `{type:'enriched', scene}`. |

Hotspot events (`onHotspot`):

- `{type:'near', pid, object, label}`: the figure reached a stop (`object` is the index into `scene.objects`, `label` its AI label) or left one (both `null`).
- `{type:'describe', pid, index, label, kind, description}`: the verb's rising edge at a stop (`setInput`'s `a`, or the keyboard's Space or Enter for pid 0), emitted by scene.js itself. `index` is the object's index into `scene.objects` (note: `index`, where `near` says `object`), `description` its `description`, `''` when it has none. Nothing pops, scales or waves; there is no `game.poke` and no `poke` event any more.
- `{type:'layer', name}`: `painting`, `depth`, `exploded` or `network`, on every W and on `reset()`.
- `{type:'scene', scene}`: after `loadScene` resolves (the scene) and after `showImage` (`null`).
- `{type:'enriched', scene}`: after `setSceneField` or `setObjectModel` changed the scene on stage; `scene` is the new copy, which `scene()` then returns. glue.js answers it exactly as `scene`, with a new `world` for every inside phone.

Layers (W): painting, then depth (the relief shaded by depth, captioned "Depth map: from <model>'s reading (AI draft)" or "Depth map: from a hand-corrected reading (sample)", or after `setDepth` "Depth map: estimated from the picture by Depth Anything V2 (AI estimate)"), then exploded (the relief's amplitude eased from 0.42 to three times that, captioned "Exploded layers: the relief at three times its depth, each object at its depth guess"), then network (the painting view with no caption; margins.js shows the platform panel), then painting again. `#modeTag` names the layer and, off painting, the fps.

Glow: the picture holds still. No object moves on its own (`scene.objects[i].motion` is ignored here); only the figures walk, and the relief's depth eases when the layer changes. The shader's one per-object effect is a soft glow on each object a figure (pid 0 included) stands at. The id map (`objectIdMap`) is a Luminance `DataTexture` with `NearestFilter`, read in the vertex shader against one uniform array `glow[9]` (slot 0 is no object, slots 1 to 8 are objects 0 to 7), refilled on every 1/60 s step: 0.12 at that object's slot, else 0. The fragment shader mixes the texel `glow × 0.6` (about 7%) toward a tint: cream for dark texels and Prussian for pale ones (luma above about 0.6, a smoothstep from 0.52 to 0.62, so a gradient gets no seam), so the glow also shows on white paper. M (reduced motion, also on with `prefers-reduced-motion`) stops the figures' join waves and the idle camera sway and quarters the camera's lean; the glow stays.

Camera: follows the group (every figure), plus the centre of each object a figure stands at (the stop's `look`, passed to `groupBox(figs, looks)` in `camera.js`), so a far object such as the sketch's Sun comes into frame when a figure reaches it and the view eases back when it leaves: zoom 1.0 to 1.35, a translate-only pan, and lean from the group and the mouse. There is no focus frame.

Stage text: `#hint` reads "<label> (AI label) · Space describes it" while the keyboard figure is at a stop, else "← → walk · Space describes what you stand at", or "← → walk the picture" when there are no stops. After 45 s without input (and never in judge mode) the caption reads "Scan the code to join, or use the keyboard. The view follows whoever is walking." and the camera sways; any input stops it. The TV's keyboard player (pid 0) is the Conductor: a navy railway uniform with peaked cap, brass buttons, whistle and lamp (`figures.js` style 'conductor', also in the phone's inside view), named "Conductor" in the roster and in inside phones' name tags. Without WebGL the hint reads "WebGL is not available in this browser."; if the boot image fails, "The painting file did not load."

Boot: the Turner (`/assets/turner-1920.jpg`) on the hand-authored placeholder relief (`depth.js`), walked along an inline copy of path.json's bank points. It has no stops and `scene()` is `null`, so the kiosk works with zero network until artwork.js loads sample 1.

Keys. Every module ignores Ctrl, Meta and Alt, and keys typed into a field (except scene.js's Esc). Key repeats are ignored except for the arrows and the open gallery's keys. No module handles another's keys.

- scene.js: `←` `→` (walk pid 0), `Space`/`Enter` (describe, pid 0), `Esc` (hide the original), `O` (original), `W` (next layer), `M` (reduced motion), `` ` `` (path debug overlay). There is no self-walking ghost figure.
- glue.js: `H` (HUD), `J` (judge mode), `R` (reset), `Q` (relay fallback switch: the laptop hub).
- artwork.js: `G` (gallery; while it is open it takes the arrows, `Enter` and `Esc` in the capture phase), `U` (file picker), `1` `2` `3` (samples), and drag-drop on the window. Because it listens in the capture phase, it also ignores any key whose target sits inside an `[aria-modal="true"]` element (the API box).
- audio.js: `S` (mute).
- margins.js: `L` (Learning overlay), `X` (hide the AI labels).
- models3d.js: `D` (automatic 3D models on or off). Like artwork.js it ignores a repeat, a field and any key inside an `[aria-modal="true"]` element.
- apibox.js: `K` (open the API plug-in box). While the box is open, every key pressed inside it stops at the box, so no letter typed into a key field reaches the TV; Tab and Shift+Tab cycle inside it and `Esc` closes it.

Host page DOM. The TV is a fixed 1920 by 1080 frame scaled to fit the window (`--fit`), in three columns:

- A 236 px left margin: `#label` (filled by margins.js, which also appends `#legend`, the stops).
- The 1447 px stage `#stage`: canvas `#gl`, `#status`, `#hint`, `#caption`, and `#original` holding an `<img>` and a `p.tag`.
- A 237 px right margin: `#modeTag`, `#hud`, `#roster`, `#resting`, `#qr`. margins.js prepends `#source`, and apibox.js inserts the API button (`.api-open`) right after `#modeTag`. The operator's parts (`#modeTag`, `#hud`, `.api-open`, and `#source`'s thumbnail and badge) show only while H puts `#tv.hud-open` on; K opens the API box either way.

At runtime the stage also gets the path overlay canvas and its Save button (pathOverlay.js), `#platforms` and `#learning` (margins.js), `#artGallery`, the drop hint and a hidden file input (artwork.js), and `#apiBox` (apibox.js). Stacking order: the stage's vignette and brass rule (`#stage::before` and `::after`) at 1, status, hint and caption at 2, `#platforms` 4, path overlay 5 and 6, gallery 7, Learning 8, drop hint 9, `#original` 10, `#apiBox` 11. Any new stage overlay sits at 2 or higher. glue.js renders only into `#roster`, `#hud`, `#qr` and `#resting`. scene.js renders into `#status`, `#hint`, `#caption`, `#original` and `#modeTag`.

Look. The phone wears a cyanotype toy theatre: a Prussian-blue ground, cream paper cards and ink text, with brass kept for the primary action and the focus ring. The TV wears the gallery's night railway: the page and `#tv` are `--rail-night`, so a letterboxed frame has no visible edge, and host.css maps the cyanotype tokens onto it for the margins and the stage (`--prussian` to `--rail-dusk`, `--prussian-deep` to `--rail-night`, `--frame-ink` to `--cream`). The gallery keeps its own, and scene.js reads `:root`, so the relief's colours are unchanged. Every colour lives in `src/shared/tokens.css`; components use its variables only. Besides the palette, fonts and sizes it defines `--space-1` to `--space-4` (8, 16, 24, 32 px), `--radius-card` (8 px), `--radius-pill` (999 px), `--rule-frame` (a hairline on Prussian), `--rule-ink` (a hairline on cream), `--card-frame` (a card sunk into the Prussian ground), `--ink-soft` (secondary ink on cream, 6.7:1), `--ok-ink` ("saved" on cream, 5.4:1), `--shadow-card`, `--shadow-lift`, `--vignette`, `--focus` (brass) and `--fade` (200 ms). Its alpha colours are 8-digit hex, not `color-mix()`, so iOS 13 reads them on the phone. On the TV:

- **Stage.** A proscenium with a soft inner vignette and a hairline brass rule 12 px in. The status line is a cream pill and the hint a translucent night pill, both centred at the stage's top (top 32 px; the hint drops to 96 px while the status shows). The caption and the original's tag are pills at the bottom, so a new overlay keeps clear of the top-centre band and the bottom 100 px.
- **Margins.** The left margin is the line. A cream enamel station sign with a livery rule inside its edge carries the title in Fell (clamped to 4 lines; a subtitle after a dash or colon goes on a smaller line under it), the artist, and the AI chip under a hairline. Under it, "Stops on this line": every object the figures walk to, in walk order, on a brass line, each a 56 x 42 crop of the picture beside its name. A stop a figure stands at is lit in cream, its marker filled with that rider's colour. While a description is open its stop is the whole route, its crop at full width over the name and the text. margins.js puts each name's full text in its `title` attribute, because long lines end in an ellipsis; when the margin is short the last stops give way. The right margin: "On board", a seat card per figure (the keyboard's first) edged and tinted in its rider's colour with a phone (or keyboard) drawn in it, then the open seats as a dashed line; at the foot the join ticket, the QR on cream card stock inside a livery rule with "Scan to board" and a perforated stub (what it admits, the URL, the data-use notice). The operator's cards (mode tag, HUD, source) are hairline cards behind H. Margin body text is 20 to 22 px, small print (the chip, URL, notice and HUD) 16 to 18 px; every stage overlay is 28 px or more.
- **Overlays.** Gallery samples are chocolate-and-cream carriages that lift and light their window when chosen; the W platform panel is a blueprint table, mono on a faint grid; the L Learning overlay is a paper sheet.
- **Motion.** `host.css` defines `@keyframes tt-fade`; every fade uses `--fade`, and all animation and transition inside `#tv` is off under `prefers-reduced-motion` and under `#tv.reduced` (M).

## TV modules and the phone page

`src/host/glue.js` keeps the relay socket, rollover, seats, judge mode, idle kicks and the keys H, J, R and Q.

- **Init.** On load it calls `margins.init({audioStats: audio.stats, depthStats: enrich.stats, modelStats: models.stats})`, then `audio.init({token, margins})`, `models.init({game, token, margins})`, `enrich.onScene(models.onScene)` (before artwork.init, whose sample 1 is the first scene), `artwork.init({game, token, audio, margins})` and `enrich.init({game, token, margins})`. `token` is the page's `?host=` value, used only as `x-host-token` on the team's API calls; the socket never carries it.
- **Room key.** On load glue reads `tt.hostKey` through `pickKey(stored, randomBytes)`, which keeps a well-formed stored key and otherwise makes one from 16 bytes of `crypto.getRandomValues`, and writes it back (see Rooms). The first socket and every rollover socket carry `role=host&key=<hostKey>`. The seats' store is `roomStore(storage('tt.seats'), hostKey)`, so a seat list saved under another key restores nothing. A 4003 stops the page with "The hub refused this screen’s room key."; a 1013 retries with backoff.
- **Hotspot events.**
  - `near`: sends `{t:'near', label}` to that phone and calls `margins.setNear(pid, object, colour)` (the keyboard's colour is `--slot-keyboard`). A phone's `leave` calls `margins.setNear(pid, null)`.
  - `describe`: builds `describeMsg(label, description)` (`{t:'describe', label, text}`, `text` the description with whitespace collapsed and at most 240 characters, else `NO_DESCRIPTION`, "No description for this one yet."), calls `audio.play('describe')` and `margins.showDescription(label, text, index)`, and sends the message to that phone. pid 0 (the keyboard) has no phone, so it gets only the description in its stop on the TV. There is no readout.
  - `layer`: calls `margins.showPlatforms(name === 'network')`.
  - `scene` and `enriched`: sends the new `world` to every inside phone.
- **Inside phones.**
  - **The flag.** A `panel` `inside` with `value` 1 or 2 sets the phone's inside flag and clears its `p.lastPos` and `p.lastPosAt`; any other value clears the flag. The flag also clears when the seat goes `away` or `leave`s, so a phone back from away says `inside` again.
  - **The world.** Value 1 always answers with `world`. Value 2 answers only when `worldDue` finds that message's JSON differs from `p.worldSent`. No throttle: the relay's 20 messages a second per phone bound a phone that repeats it.
  - **`p.worldSent`.** The JSON of the last `world` handed to the relay for that phone: on entering, on a re-assert, and on the `scene` broadcast. It is recorded only when the seat had a socket (`tell()` returned true). `away` forgets it, because the host cannot know what reached a socket that died, so a phone back from away gets the world again even on value 2. A socket rollover does not go through `away`, so its value 2 skips the resend.
  - **`pos`.** A 200 ms interval checks every inside phone while the host socket is open. It sends a phone's `pos` when `posDue` finds the JSON changed or `POS_KEEPALIVE_MS` (3000 ms) passed since the last one, then records `p.lastPos` and `p.lastPosAt` (again only when `tell()` returned true).
  - **`look`.** No code: `panel()` stamps `lastActive` for every kind before it reads the kind.
  - **Pure helpers.** `worldMsg(scene)`, `posMsg(pid, figures, who)`, `worldDue(value, sentJson, json)` and `posDue(prevJson, json, lastAt, now, keepaliveMs)` sit in glue's tested pure block, with `describeMsg(label, description)` and `NO_DESCRIPTION`.
- **Joins and the relay.** A new pid's `join` plays `audio.play('join')`; the re-joins after a relay gap stay silent. The relay's `hub` message goes to `margins.setHub(m)`.
- **R.** Runs `game.reset()`, `artwork.loadSample(1)` and `audio.play('reset')`. It sends mode `reset` to every phone, turns judge mode off, clears the original and artwork cooldowns and sets the cap to 6.
- **HUD and margin text.** The HUD's first line reads `<where> · players <n>/6 · inside <k>`, `k` being the phones in the inside view. H's expanded HUD adds the lines `layer <layer> · <saved> <id>` and `depth <state> · <device> · <ms> ms` (from `enrich.stats()`; the device and ms only once known) beside each phone's median rtt. The roster heading is "On board": a seat per figure, "Conductor" (the keyboard player) first, then "<n> seats open" ("1 seat open", or "Every seat taken"; nothing while resting). The join QR's caption is "Scan to board", over a stub reading "Party ticket · up to 6 phones", the URL and the data-use notice. After Q with `WIFI_SSID` set, the two QR captions read "1  Join the Toy Theatre Wi-Fi" and "2  Scan to board".
- **The join QR.** Each join QR (the cloud one, the laptop's after Q, and the second of the Wi-Fi pair) encodes `joinWithRoom(hub.joinUrl, hub.room)`: the relay's `joinUrl` with `?room=` set through `URL.searchParams`. Q's laptop hub sends the same room, since the room comes from the key. Until a `hub` greeting arrives (Q clears the last one), or with no valid room or `joinUrl`, there is no QR, and a `joinUrl` that contains the page's `?host=` token is never drawn. Under each join QR the caption shows that URL without its scheme (`<host>/?room=<room>`), and H's `join` line shows it in full. `pickKey`, `joinWithRoom` and `roomStore` sit in glue's tested pure block.

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
- **Gallery (G).** A night railway over the whole TV frame (the margins hidden) and out over the letterbox to the window's edges (as do its sidebar and boarding screen; their content stays inside the frame), on two lines, with a moon, stars, and hills and telegraph poles scrolling past behind the trains while the sleepers run under them, so the trains seem to travel. That motion, and the engine's steam, ignore reduced motion (the OS setting and M) by the owner's choice; every other animation still stops. The foot reads the keys: ← → along the train, ↑ ↓ change line, Enter board, Esc close, and "Titles are AI guesses". Opening it plays the gallery sound; moving between carriages plays step.
  - **How it works (top line).** The locomotive is the "Add a picture" button (the file picker, as U), followed by four demonstration carriages in Brunswick green, arrowed one to the next, showing the sketch sample at each stage: the picture, Gemini's outlines, its cut-outs standing up, then a rider stepping into it from a phone. Only the locomotive can be chosen. Today's projects are not listed.
  - **Samples (bottom line).** One carriage per entry of `/samples/index.json`: the picture in the window, the title, and on the chosen carriage its `by` line. The chosen carriage lifts, lights its window and peeks in 3D (the picture sinks and each object lifts along its mask by its depth guess, then holds still: no cut-out moves on its own and the plate does not sway, though it leans with the pointer); pointing at one chooses it, and leaving it folds it flat again.
  - **Sidebar.** Enter (or a click) opens a sidebar with the picture lying flat: pointing at a part lifts just that part and shows its name; nothing says what it does (the descriptions are kept for the ride). The part is found on the flat picture, not under the pointer: `partAt(parts, x, y)` (in artwork.js's tested pure block) picks the smallest outline holding the point, so a part inside a bigger one (a star in the sky, a spire in the village) stays reachable and a lifted part never flickers to its neighbour. A part with no cut-out (sky, ground and water, or one under `PEEK_MIN_AREA`, such as the Turner's hare and boat) gets its blueprint outline instead of a lift. The name never runs past the picture's right edge. Its two tickets are Ride solo (plays the sample) and Ride with a group (plays it behind the boarding screen). Esc or × closes it. Opening it plays door; a ticket plays punch.
  - **Boarding screen.** The TV's own join code (copied from glue.js's `#qr`) as a printed party ticket, the picture's title, and six seats that fill in join order with each phone's colour and name (read from `#roster`). "All aboard" plays whistle and closes it; "Back to the gallery" reopens the gallery. With no relay the ticket says phones can't join.

`src/host/audio.js` exports `init({token, margins})`, `play(event, obj?)`, `prepare(scene)`, `toggleMute()` (bound to S) and `stats()`.

- **Return values.** `play` returns `Promise<boolean>` (true when the sound started) and never rejects. `prepare` returns a Promise that never rejects. `toggleMute` returns the new muted state. `stats` returns `{played, generated, cached}`.
- **Events.** The events are `join`, `poke`, `describe`, `appear`, `save`, `reset` and `gallery`, plus the gallery's railway: `step` (moving between carriages), `door` (a carriage's sidebar opening), `punch` (a ticket chosen) and `whistle` (All aboard); each plays `public/sfx/<event>.mp3`, except `describe` (glue's answer to the verb), which plays the palette's `poke.mp3` (a soft paper tick; it has no palette entry of its own) and flashes "describe · poke.mp3 · ElevenLabs".
- **Per-object sounds.** `play('poke', obj)` still plays the generated sound for that object's label once `/api/sfx` has returned its url, and until then its kind's palette file (below). Nothing calls it since the verb became `describe`, so no per-object or generated sound plays today, while `prepare` (below) still makes them; see the cost note under Generation.

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
- **Generation.** `prepare(scene)` asks `POST /api/sfx {label, prompt}` for the scene's first 2 distinct labels (lowercased, whitespace collapsed), one at a time. The request carries `x-host-token` when the token is set, the visitor's `x-elevenlabs-key` when one is saved, and has a 25 s timeout. Any non-200 answer (204, 400, 401, or the 404 of the laptop hub) stops requests until the next `init()` or the next change of keys: on the `tt:keys` event it asks again, for the scene already on stage too, so a key added in the API box makes sounds for the artwork in front of it. New generations are capped at 25 a day in localStorage `tt.sfxday`, a visitor's key included; once the cap is reached, cache hits are skipped too. Cost note: artwork.js still calls `prepare` for every scene, so up to 2 ElevenLabs generations a new scene are spent on sounds nothing plays (see Per-object sounds); whether to stop preparing or to play the label's sound on `describe` is open.
- **Mute.** S mutes and pauses everything playing, stored in `tt.mute` (`'1'`/`'0'`), so it survives R and a reload. It flashes "Sound off (S turns it back on)" or "Sound on".

`src/host/margins.js` exports `init({audioStats, depthStats, modelStats})`, `setScene(scene, {saved, image})` (`null` clears it; `image`, the picture actually on stage, is what the stops crop, else `scene.image_url`), `setNear(pid, index, colour)`, `showDescription(label, text, index)` (opens the text in that stop for 10 s), `setSaved(state, id)`, `setHub(hubMsg)`, `showPlatforms(on)`, `flash(text)`, `toggleLearning()` (L) and `toggleLabels()` (X), plus the pure helpers `describeCard(label, text)` and `cropOf(box, aspect)` (tested). Every scene string reaches the page through `textContent`.

- **Left margin.** `#label` shows the title guess, then the artist guess ("Title unknown" or "Artist unknown" when Gemini said `unknown`), then the chip "AI draft, not a museum record", or "AI draft, hand-corrected (sample)" when `scene.edited` is true. (The credit is the original's, under O.) `#legend` ("Stops on this line") lists the scene's stops in walk order (maskDepth.js `objectHotspots`, the stops scene.js walks to), each with the crop `cropOf(box, aspect)` returns: a 4:3 window round the object's box with a little room, never stretched.
- **Descriptions.** `showDescription(label, text, index)` (glue calls it for every `describe`, with scene.js's object index) opens the text (`describeCard`: at most 240 characters; nothing for an empty text) inside that stop for 10 s (`DESCRIBE_MS`); the latest replaces the previous, and an index with no stop falls back to the stop with that label. While it shows, its stop is the whole route: its crop at full width, the name, then the text, prefixed "AI:" except on the samples, whose descriptions are hand-written. `#legend` is `aria-live="polite"`, X hides it with the other AI guesses, and a new scene rebuilds the stops, so a new picture never shows the last one's description.
- **Right margin `#source`.** With H it shows the source thumbnail and the saved badge. The badge reads "Saved to Snowflake" (green) only for `saved`, else "saving…", "local only", "sample" or "not saved". Below them is the notice "Pictures sent here are public demo content read by Google Gemini (free tier).", shown only while no join ticket carries it (U and a dropped file still send pictures). `flash(text)` shows over the top of this block for 2 s, H or not.
- **Stale confirmations.** `setSaved` ignores a call whose id is not the project on screen.
- **Platform panel.** `#platforms` (`aria-label` "The platforms, live") sits over the stage bottom for the network layer and refreshes every second, with one line per platform; a stats function that throws only blanks its own line's numbers:
  - Vercel: "relay <region>" or "laptop relay (Q)", the instance's first 8 characters, and the bus ("Upstash Redis" or "local"), all from the relay's `hub` message.
  - Gemini: "<model> · read at HH:MM", or "sample, edited (hand-corrected)" for an edited sample.
  - ElevenLabs: played, generated and cached, from `audio.stats()`.
  - Snowflake: "project <id> · <badge text>".
  - Depth Anything V2: "<device> · <state> · <ms> ms" from `enrich.stats()` ("—" before a device is known, `idle` before a state).
  - Tripo: "<n> ready · <m> running" from `models3d.stats()`, or "off" while D has models off or the server answered `off` (no Tripo key).
- **X.** It adds `#tv.labels-off`, which hides the sign's guesses, the chip and the stops and shows "AI labels hidden".
- **L.** The overlay "Learning: what surprised us" lists `src/shared/learning.json` (`{"entries": []}`, each `{who, at, text, shot?}`, where `at` is an ISO time shown as "Sat 14:05" or free text) in file order. When the file is empty it says where to add entries; it never invents any.

`src/host/apibox.js` is the API plug-in box: where a visitor plugs in their own Gemini, ElevenLabs and Tripo keys and tests every platform. main.js imports it after glue.js. It exports `open()`, `close()` and `toggle()`.

- **Open and close.** K, or the API button under `#modeTag` (it reads "API" with a K key cap, plus "your keys" while a key of theirs is saved). Esc, the × button or the API button closes it. It is a modal (`role="dialog"`, `aria-modal="true"`) over the whole stage at z 11; focus starts in the Gemini key field, stays inside the box while it is open and goes back where it was on close. The first open on a page tests every card once (5 of the server's 10 checks a minute, plus the relay's health GET); after that only Test asks again. Each check carries the page's `?host=` token as `x-host-token`, so with `HOST_TOKEN` set the team's checks answer only on a TV opened with it. The cards sit in four columns (Gemini, ElevenLabs, Tripo, then the team column), and the grid scrolls if it runs out of height.
- **Gemini, ElevenLabs and Tripo cards.** Each has a status dot with a word beside it ("Not tested", "Testing…", "Working", "Failed"), so status never rests on colour alone; a "Using: your key / team key / not set" line; one line on what the platform does here and what a key of yours changes; a password field with Show/Hide; "Saved: AIza…X9q2" (the masked key) or "No key of yours saved"; Test and Clear; and the server's `detail`. Test with text in the field saves it first (it reads "Save and test"; text that is not a key's shape is refused in place) and empties the field. Clear forgets that key, the model with it on Gemini. Gemini also has a model select, "Default model" or one of the two allowed models, used only with the visitor's key. ElevenLabs and Tripo also show "Credits left: <n>" when the server reports them. The Tripo card reads "Builds 3D models of the main objects. Your key skips our hourly cap." with the note "About 30 credits per object. On Tripo's free plan Tripo owns the outputs." Its key is checked against `TRIPO_KEY_RE` ("That isn't a Tripo key: tsk_ then 8 to 200 characters, no spaces"); the other two against `KEY_RE`.
- **Team cards.** Snowflake, Blob storage and Realtime relay, each with Test; the box tests them and cannot change them. The relay card asks `GET /api/ws` on https and `/healthz` on http (the laptop hub) and lists region, instance, bus and sockets.
- **Footer.** "Remember on this device" (localStorage instead of sessionStorage), "Clear my keys" (all three forgotten, the three key cards tested again on the team's keys), and the privacy note: "Keys stay in this browser and are sent only to this site's API over HTTPS with each request; the server never stores or logs them."
- **No API here.** On the laptop hub or `npm run dev` every check reads "Failed" with "No API here (the laptop hub or npm run dev)", and the relay card "No relay health at /healthz" under Vite.
- **Privacy.** After a save the page only ever shows `mask(key)`, and closing the box empties anything typed and not saved. Keys never go into a URL.

`src/shared/byok.js` keeps the keys. `load()` returns `{gemini, geminiModel, elevenlabs, tripo, remember}`, normalised (a stored key that does not match `KEY_RE`, or `TRIPO_KEY_RE` for Tripo, reads as `''`, a model outside the two as `''`). `save(patch)` merges a partial update; with `remember` true it writes localStorage `tt.byok` and clears sessionStorage `tt.byok`, else the reverse. `clear()` drops both. Every change dispatches the window event `tt:keys` (no payload). `apiHeaders()` returns only the headers that are set, and none unless the page is on https or localhost (`secureOrigin`), and `mask(key)` the first 4 and last 4 characters around an ellipsis. Every storage access sits in try/catch, so blocked site data only means no keys. It also exports `readCheck()`, `relayPath()` and `relayView()`, the box's pure readers of the check and relay answers. The file has no `?.` or `??`, so the phone could import it.

`src/host/enrich.js` exports `init({game, token, margins})`, `stats()` (`{state, device, ms}`, `state` one of `idle`, `loading`, `computing`, `ready`, `saved` or `failed`) and `onScene(fn)`, where `fn(scene, isCurrent)` runs for every scene put on stage and `isCurrent()` turns false once another scene or the flat state replaced it (it returns an unsubscribe function; `models3d.js` is its one user). On each `scene` event it gets the scene's depth image and hands it to `game.setDepth`; see Depth and 3D models.

`src/host/models3d.js` exports `init({game, token, margins})`, `onScene(scene, isCurrent)`, `stats()` (`{on, ready, running, failed, last}` for the scene on stage, `last` the latest `/api/tripo` status or why it stopped), `setOn(v)` and `MODELS_PER_SCENE` (2). D toggles it; see Depth and 3D models.

Phone page (`join.html`, `src/join/main.js`, `src/join/join.css`; the inside view in `src/join/inside.js` and `inside.css`). It has six screens: connecting, lobby, walk, full, evicted and noroom. v1's plaque screen, sliders, Done, Export and `cards.json` are gone. The walk screen has five controls: the pad, the verb, Step inside, Add artwork (https only) and Show the original.

- **Room and token.** `pickSeat(urlRoom, saved)`, in main.js's own pure block (tested in `tests/glue.test.js`), picks the room. It takes only the URL's `?room=` (the TV's QR; a reload keeps it). With none, or a malformed one, the phone shows "Scan the code on the screen to join" and opens no socket: a saved room may belong to a TV that has gone. The saved localStorage `tt.seat` (`{room, token}`) only supplies the token: a token belongs to the room it was won in, so a URL room other than the saved one starts with no token, and the new room is saved at once. "Show the original" is hidden on that screen. v1's bare `tt.token` is never read or removed. Every socket the phone opens, rollover included, carries `room=<room>`.
- **No room.** With no room in the URL and none saved, the phone shows the noroom screen and opens no socket. A 4004 close shows the same screen and stops reconnecting.
- **The verb.** The verb follows the host's `near` label: "About the <label>", else "Walk to something". Pressed at an object it sends `a` 1, then 0 on release, as before, and the host answers `describe`.
- **The description card.** On `{t:'describe'}` main.js shows `#desc` under the verb: the label as an `h2` (`#descH`), the text (`#descP`) and a Close button (`#descX`), in a `role="status"` region. While it shows (`#walk.described`) it takes the "Hold left or right to walk" hint's row and scrolls when long, so short and landscape phones keep the pad's 120 px. main.js owns it: it closes on Close (here or in the inside view), on a change of `near` (walking to another object or off this one), on leaving the walk screen, or after 20 s (`DESC_MS`). A card already open when Step inside is tapped shows over the view too.
- **Step inside.** The button sits between the verb and Add artwork (in landscape, under the verb in the right column) and shows on http too. It reads "Opening…" while it dynamic-imports `src/join/inside.js`, a separate chunk with three.js, `src/world/diorama.js` and `src/host/figures.js`; if the chunk fails to load it toasts "Couldn’t open the inside view; try again". The view then opens over the page (`section.inside`, a modal dialog at z 4, under the player's colour frame and the splash; the toast, Reconnecting and resting lines are raised above it) and sends `panel` `inside` 1. main.js routes `world` and `pos` to it while it is open. Back (or Esc) sends `panel` `inside` 0, closes it and returns focus to Step inside. Leaving the walk screen (evicted, full, the lobby, connecting) closes it without a message.
  - **On a `welcome` while it is open** (a rejoin, a rollover, a host back from a gap): once any `world` has arrived (built, building, a reason card, or a failed load or build) it sends `inside` 2, so the host resends the world only if it changed. With no `world` yet it gives the ask loop a fresh 4 asks, and restarts it under the Building card if it had given up.
  - **A `pos` while it is closed** means the host missed Back: main.js sends `inside` 0 again, at most once every 5 s, counting from the last one it sent (Back included).
- **Inside view.** A first-person walk through the diorama (see Inside view).
  - **Loading.** A calm "Building the world…" card stays up until the image and the scene's depth image have loaded and the diorama's `ready` has resolved. The image loads with `crossOrigin='anonymous'` (a Blob image needs CORS, as on the TV) and is redrawn at power-of-two sides, at most 2048 (or the GPU's limit), so mipmaps work on iOS 13's WebGL1. The depth image (`scene.depth_url`, when it passes the Scene rule) loads beside it the same way, at most 8 s, and is read back to a depth image of at most 512 px from its red channel; a missing, failed, slow or unreadable one is `null`, and the world is today's planes. A repeat of the same world (a rejoin, a rollover) is ignored.
  - **A richer world.** A `world` with the same image whose scene differs only by `depth_url` or `model_url` (an `enriched` broadcast) is rebuilt in place on the same picture texture: no card, no glide, the heading and the look kept. Then one hint shows for 5 s, "The world gained depth" or "A 3D <label> arrived", and only when the depth room or that model actually took. If the rebuild fails, the world shown stays. If no world comes, the view asks again every 2.5 s, 4 times in all, and still builds a world that arrives later.
  - **Camera.** It holds 0.6 s on the painting camera (the picture exactly as painted), then glides 1.8 s into the figure's eyes; reduced motion skips both. It stands at `pathAt(me.shown).position` plus `eyeHeight`, where `me.shown` eases toward the last `pos` (at most 5 a second, and only on change), with a 64° horizontal field of view (the vertical one kept to 50° to 90°). Its yaw aims along `pathAt(me.shown).forward` times the camera's heading (see Controls) and swings round smoothly when Turn around flips the heading (when the Walk rule flips it, the drag is re-expressed instead, so the view does not move), plus the drag: a drag across the full width turns half a turn, and a vertical drag pitches within ±50°. "Drag to look around" shows for 6 s or until the first drag. A drag that moves sends `panel` `look` (at most once every 20 s); a tap that does not move sends nothing.
  - **Look by moving your phone.** Only on a secure context with a coarse pointer and `DeviceOrientationEvent`; iOS asks permission inside the tap. It is relative to how the phone was held when it was turned on, and the drag still turns left and right but no longer pitches. A refusal, or no motion events within 1.5 s, turns it off with a toast. A turn of at least 5° from the last turn that counted sends `look` (sharing the drag's 20 s limit); sensor jitter on a still phone sends nothing.
  - **Other figures.** Procedural paper-cut sprites in their colours, a bonnet for an even pid as on the TV, each with a shadow and a name tag of fixed screen size. Each keeps 0.35 eye heights (about half a metre) to one side of the path line by pid parity, and one nearer than 0.4 eye heights across the floor is hidden.
  - **Controls.** Back sits at top left. Walk, the verb and Turn around run along the bottom. Walk and the verb drive the pad's own input through the same `hold()` helper, so the `in` messages, the 4 Hz heartbeat and the release-on-blur rule are the pad's.
    - **Heading.** The camera faces along the path with its own heading, +1 (toward increasing `t`) or -1, apart from the figure's `facing`, so a player standing still can turn round. It is set from `facing` on the first `pos` after a world is built (until then `facing` stands in), and a new world resets it.
    - **Walk toward the look.** The figure can only go along the path, so the heading follows whichever path direction (+t or -t) is nearer where the player looks. Every frame, `walkSign(lookX, lookZ, tanX, tanZ, heading, FLIP_DEG)` (pure, in `tip.js`, tested) compares the full look (the path aim plus the drag, and the phone's own turn while tilt is on) with the path's tangent at the player's spot. With hysteresis it switches only once the look is more than 105° from the current heading, 15° past sideways (`FLIP_DEG` in `inside.js`), so looking almost sideways does not flicker. It checks the look at the path aim, not the eased camera, so Turn around's swing never flips it back. On a flip the drag (and the eased yaw) is shifted half a turn against the new aim, so the look does not jump, and while Walk is held it re-sends `lx` with the new heading. Degenerate input keeps the heading.
    - **Walk** (a 64 px cream circle with a double forward chevron, `aria-label` "Hold to walk forward") is held. It sends `lx` equal to the heading while held and 0 on release, so the figure walks the way the camera looks. It turns ink while `lx` is non-zero and equals the heading.
    - **Turn around** (a 64 px cream circle with a U-turn arrow, `aria-label` "Turn around") is a tap that flips the heading, and with it the view, half a turn; walking then follows the new look by the same rule. While Walk is held it re-sends `lx` with the new heading, so the figure walks the other way. It acts on `pointerdown`, so a second thumb can tap it while the first holds Walk. The click that follows a pointer press is skipped; a keyboard or screen-reader click turns.
    - **The verb** is brass and reads "About the <label>" from `pos.near`, else "Walk to something". Its answer, the description card, floats over the view above Walk, the verb and Turn around (`.desc.in-desc`); its Close closes the walk screen's card too.
    - **The pad outside.** The walk screen's pad keeps plain left and right; only Walk here follows the look.
    - **End of the path.** Holding Walk at the path's end in the heading's direction (`t` at most `MIN_T` + 0.005 with heading -1, or at least 0.995 with heading +1) shows "End of the path · turn around" in the hint pill for 4 s, once per press of Walk or Turn around. The hint is a `role="status"` line, so screen readers announce it.
    - **Keys.** Space and Enter work on Walk, the verb and Turn around. ArrowUp held walks, ArrowDown or T turns around, and Escape goes back.
  - **Limits.** Pixel ratio min(devicePixelRatio, 1.5). Leaving disposes the world, the figures and the renderer and calls `forceContextLoss`. Image URLs are accepted when http(s) or site-relative and at most 2048 characters.
  - **Failure cards.** Each has a "Back to the pad" button, never a blank screen: the host's `reason` with "This view opens by itself when the TV shows a picture you can enter." (it does, on the next `world`); "The picture didn’t load on this phone"; "This world didn’t build on this phone"; "The screen hasn’t sent the world" (after the 4 asks); "This phone can’t draw the world in 3D" (no WebGL); "The phone’s graphics gave out" (context lost).
- **Sizes** (Vite's build, for M3; measured Sat Oct 24 after Tier 2). The join page as first loaded is 42.4 KB (17.3 KB gzip; re-measured Sat Oct 24 after the description card): join.html 3.5, join JS 25.6, the JS chunk it shares with the TV 3.2 (Vite names it preload-helper), join CSS 8.8 and the shared CSS 1.2. Its three woff2 fonts add 91.8 KB, so about 134.2 KB in all, under M3's 150 KB. three.js appears only in the dynamic import's preload list. The inside chunk, loaded on Step inside only, is about 558 KB (147 KB gzip): inside JS 22.5 (inside.js and diorama.js), inside CSS 3.2, and the chunk it shares with the TV, three r128 with figures.js and tip.js, 532.2 (136.5 gzip; Vite names it tip). GLTFLoader (39.5 KB, 12.7 KB gzip) loads only for a scene with a `model_url` on a standing object. The depth image adds 47 to 80 KB for a sample, and a Tripo GLB its own size (not measured; Tripo does not document it).
- **Add artwork.** It shows only when `location.protocol` is `https:`, because the laptop hub serves no `/api/interpret`. It opens `<input type=file accept="image/*" capture="environment">` under the notice "Your picture is uploaded publicly and read by Google Gemini (free tier)." The photo is downscaled (1024 px, JPEG 0.8) and posted to `/api/interpret` as `{image, source:'phone'}`. While it uploads the button is disabled and reads "Sending…".
  - **ok:true.** The phone sends `{t:'panel', kind:'artwork', value: scene_url}` (retrying for about 5 s if the socket is busy) and toasts "On the TV in a moment"; the host's readout then replaces that toast. If the send never goes through it toasts "Couldn’t reach the screen; try again".
  - **Failure toasts.** busy: "One at a time: try again in a few seconds". quota: "The artwork reader is resting; try a sample on the TV". Anything else, a network error or 40 s without an answer: "Couldn’t read that one; try another picture". A failed reading never reaches the TV.
  - **Keys.** The phone sends no bring-your-own-key headers, so a phone's picture always uses the team's Gemini key and its hourly cap, whatever keys the TV holds.
- **Look.** The same cyanotype skin as the TV, from the same tokens. Connecting, full, evicted and noroom are centred cream cards (the evicted message is the card's `h1`; noroom's `h1` is "Toy Theatre" over "Scan the code on the screen to join"). The lobby reads "Welcome to the Toy Theatre" over the Fell title "Pick a colour"; each free seat is a card filled with its colour, its name in ink or cream by luminance (`--on`), one column in portrait and two on a landscape phone. The header holds the player's name in a chip filled with their colour (`--on-accent` text) beside an outlined "Show the original" pill. The walk pad is a cream pad with drawn Left and Right halves and chevrons; the held half turns ink. The verb is a brass pill, a dashed outline while it reads "Walk to something". The description card is cream paper with the label in Fell (24 px), the text at 18 px and an outlined Close. Step inside is an outlined pill with a door glyph, its label in `#insideLabel`; the pad's minimum height is 120 px so it fits on short phones. Add artwork is an outlined pill with a camera glyph, its label in `#artLabel`. The inside view's loading and failure cards are the same cream paper as the connecting card. Toasts are cream pills at the bottom, above the safe area. Text is 18 px or more and every target at least 44 px. Screens fade in over `--fade`, and all motion is off under `prefers-reduced-motion`. The phone loads Fell and Franklin but not JetBrains Mono.
- **Unchanged.** Apart from the room, the socket, rollover, who/here, watchdog, resting, wake lock, lobby and Show the original work as before. Without a seat, or while the screen is resting, Show the original toasts "The original shows on the screen once it is back". main.js and everything the inside chunk imports (inside.js, diorama.js, tip.js, figures.js, maskDepth.js, scene-validate.js, protocol.js) have no `?.`, `??`, `??=`, `||=`, `&&=`, class private fields or regex lookbehind, so iOS 13 can parse them.

Samples (`public/samples/`, see its README). `index.json` is `[{n, id, name, image, scene, credit}]`, where `n` is 1-based and matches keys 1, 2 and 3, and `image` and `scene` are site-relative. Each scene file is `validateScene` output with `source` `sample`, `edited` true, `ai_draft` true, `model` `hand-corrected`, `scene_url` `''` and `credit` set, plus `depth_url` `/samples/<name>.depth.png` (written after `scene_url` by `tools/depth.mjs`; key order does not matter to the re-validation check), except the Turner's, which has none (`PLANES`). Those three PNGs are Depth Anything V2's estimates, not hand-corrected: turner 512 by 382 (47.3 KB), sketch 512 by 384 (79.5 KB), starry-night 512 by 406 (67.1 KB), each 8-bit grayscale.

- **Sample 1, `sample-turner`.** The Turner at `/assets/turner-1920.jpg`, with 8 objects. Its `ground_path` is path.json's left bank, which ends at x 420, so the five objects to its right (sky, steam and smoke, locomotive, viaduct, hare) all want the path's end; they are spread 0.07 apart at t 0.69 to 0.97, and every object of the three samples gets a stop: Turner 8 of 8 (bridge, boat, river, then those five), sketch 7 of 7, Starry Night 8 of 8.
- **Sample 2, `sample-sketch`.** `/samples/sketch.svg`, 1600 by 1200, with 7 objects whose masks are the SVG's own polygons.
- **Sample 3, `sample-starry-night`.** `/samples/starry-night.jpg`, a 1920 by 1520 public-domain scan (Google Art Project, via Wikimedia Commons), with 8 objects. `public/samples/README.md` records how it was made.

## Constants

Positions along the path are in path-parameter units: t runs 0 to 1.

- **Walking.** Hotspot half-width 0.03 (a figure that close to a stop's t is at that stop). Figures walk t 0.15 to 1 (`MIN_T`; with the path's first point at u 0.05 the follow camera cannot frame a figure below t 0.15), at 0.10 path lengths a second. Stops sit at t 0.26 to 0.97, at least 0.07 apart, one per object (`maskDepth.js`).
- **Camera.** Follow zoom 1.0 to 1.35. Lean up to 10 degrees, fading to 0 by zoom 1.8.
- **Input.** The host zeroes a phone's non-zero input when its 4 Hz heartbeat stops for 1 s.
- **Phone panels.** Phones may show the original on the TV once per 20 s globally (`ORIGINAL_COOLDOWN_MS`), for 8 s (`ORIGINAL_MS`). Each phone may send one artwork per 20 s (`ARTWORK_COOLDOWN_MS`).
- **Inside view.** An unchanged `pos` is re-sent every 3000 ms (`POS_KEEPALIVE_MS`, in `glue.js`). The phone sends `look` at most once per 20 s, for a drag that moved or a tilt of at least 5° (`LOOK_MS` and `LOOK_TURN`, in `inside.js`). It repeats `inside` 0 for a stray `pos` at most every 5 s (in `main.js`). It asks for the world every 2.5 s, 4 times in all (`ASK_MS` and `ASKS`, in `inside.js`).
- **Depth and 3D models.** The depth image is at most 512 px (`OUT_MAX` in `depthWorker.js` and `tools/depth.mjs`, `DEPTH_MAX` in `enrich.js`, `DEPTH_PX` in `inside.js`, which waits 8 s for it, `DEPTH_MS`). Models: `MODELS_PER_SCENE` 2, `PAD` 0.08, `CROP_MAX` 1024, `POLL_MS` 4000 and `GIVE_UP_MS` 10 minutes in `models3d.js`; `TASK_TTL_MS` 15 minutes, `MAX_PER_HOUR` 6, `MAX_PNG` 3 MB and `MAX_GLB` 25 MB in `api/tripo.js`.
- **Where they live.** All in `src/shared/protocol.js` except the stop spacing, the walk speed, the inside view's numbers and the depth and model numbers above.

Sockets: the relay pings every 15 s and drops a socket that missed the last pong; the relay's `hb` and the host's `hb` both run every 2 s; a phone drops a silent socket after 5 s; a seat is held 20 s; sockets roll over 240 s after opening plus up to 30 s of jitter (`ROLLOVER_MS`, `ROLLOVER_JITTER_MS`), and a rollover socket has 5 s to be welcomed or opened (`ROLL_WAIT_MS`); a phone shows "The screen is resting" after 6 s without host traffic (`HOST_SEEN_MS`); at most 12 phone sockets per room on one relay instance (`MAX_SOCKETS`) and 64 rooms per instance (`MAX_ROOMS`), past which a socket gets 1013 `busy`; a phone socket passes 20 messages a second (`MSGS_PER_SEC`) and a host socket 200 (`HOST_MSGS_PER_SEC`), each bucket refilled every second. The relay's path is `WS_PATH`, `/api/ws`.

Phone panels (glue decides; the host never trusts a phone).

- **`original`.** Once per 20 s across all phones. The TV shows the original for 8 s and the phone gets "Showing the original on the screen for 8 s", or "Show the original again in <n> s".
- **`artwork`.** `value` must be a string; the relay has already checked it is a Blob scene URL.
  - During the guided tour only phones that joined while J was on (the guests) may send one. Any other phone gets "Pictures are paused for the guided tour", so a judge must join after J is pressed.
  - Each phone may send one per 20 s ("One picture every 20 s").
  - An accepted one gets "Your picture is on its way to the TV" and goes to `artwork.fromPhone(url, pid)`. If that resolves false or rejects, the phone gets "The TV couldn't open that picture; try another".
- **`inside`.** No cooldown. `value` 1 or 2 marks the phone as inside. 1 always answers `world`, and 2 does only when that world differs from the last one sent to the phone. Any other value clears the mark. It counts as activity.
- **`look`.** Activity only, so a phone that only looks around inside is not kicked as idle. The host does nothing else with it.
- **Other kinds.** Ignored, but they count as activity.
- **On R.** Both cooldowns clear.

Slot policy (B4, "Guided tour"). The cap stays at 6: a cap of 4 would also refuse the judge. Any phone idle for 90 s (no non-zero input, no panel message) is released with a kick (reason `idle`). Looking around in the inside view counts as activity through `panel` `look`, sent at most once every 20 s (under judge mode's 30 s) while the player is actually looking. A phone that stands still inside without looking is idle like any other, and `pos` traffic from the host never counts. Pressing J turns on judge mode. It kicks the longest-idle phones at once, away ones first, until two of the six slots are free (reason `judge`). It keeps releasing phones that were already on the bank when J was pressed once they idle for 30 s, and exempts phones that join while it is on (the judges) from both idle releases. J again, or R, turns judge mode off. A kicked token is refused by the host's seats (`src/host/slots.js`), so a kicked phone shows its end screen and rejoins only when the visitor taps Join again.

## path.json

`public/path.json` is v1's Turner bank path: `{"image":"assets/turner-1920.jpg","points":[[u,v,h] × 8],"plaques":[…]}`. `u` runs left to right, `v` bottom to top (texture UV); `h` is the depth (0 far, 1 near) baked at that point.

- **Readers.** scene.js no longer fetches it: the boot Turner walks an inline copy of its points. Sample 1's `ground_path` was converted from them (`x = u × 1000`, `y = (1 − v) × 1000`). `tests/camera.test.js` still reads the file. Its v1 `plaques` are unused.
- **The path at runtime.** It is `pathPoints(scene, …)`, with `h` from the scene's depth map. Figures and stops use the curve's interpolated `h`, never a per-frame depth sample.
- **The backtick overlay.** It shows the live path and the stops (as `plaques` entries `{id:'obj:<index>', index, label, t, look, zoom}`), lets you drag either, and "Save path.json" downloads them in this schema.

## Depth and 3D models

What a scene gains once it is on stage, beside Gemini's reading: a depth image from Depth Anything V2 Small, estimated in the TV's own browser, and Tripo 3D models of its main standing objects. Both arrive after the scene plays, both are labelled as AI on screen, and any failure of either is quiet: the mask relief and the flats stay.

**The mask relief first.** `loadScene` builds the relief from `sceneDepth(scene)` (see Scene), 256 texels on the long side, uploaded as a float texture (half float without `OES_texture_float_linear`, 8-bit on WebGL1); it displaces the plane by up to 0.42 world units (three times that on the exploded layer). The boot Turner uses the prototype's hand-authored placeholder (`placeholderDepth()` in `depth.js`), so the kiosk works at every commit. v1's `public/depth/turner-depth.png` (from `tools/depth.py`: Depth Anything V2 Small on the scan, 16-bit with R the high byte and G the low byte) is not in the repo and nothing reads it now. `loadDepth()` in `depth.js` still decodes that format, but nothing calls it.

**The depth image.** An 8-bit grayscale PNG (R = G = B), 255 nearest. It is Depth Anything V2 Small's `depth` output as it is: relative inverse depth, min-max normalised over the one picture, so it is neither metres nor comparable between pictures. It has the picture's aspect, at most 512 px on the long side. In memory it is `{data: Uint8Array, w, h}`, one byte per pixel, row-major, top row first. `game.setDepth` takes that, and so does the phone's diorama.

**Estimating it on the TV (`src/host/depthAI.js`).** A lazy chunk (1.3 KB) that only `enrich.js` imports, the first time a scene needs an estimate. The model runs in a module worker, `src/host/depthWorker.js` (`vite.config.js` sets `worker.format` to `es`), started on the first estimate: on wasm one thread runs the whole model, which on the main thread would freeze the TV's render loop, phone input and the 2 s host heartbeat long enough for phones to show the resting screen. The page sends the picture's pixels (at most 1024 px) and gets the depth image and its PNG back; a worker that fails to start or dies fails that estimate (`null`), and the next picture starts a new one. `estimateDepth(image)` returns `{depth, png, ms}` (the image in memory, its PNG as a Blob, the time taken) or `null`, and never throws. `stats()` returns `{device, dtype, progress, loadMs, runMs}`.
- **Model.** `onnx-community/depth-anything-v2-small` at revision `4472b7362082ad9968fee890ca0f1e5aca36b93d`, through transformers.js (`@huggingface/transformers` 4.3.1, `pipeline('depth-estimation')`). WebGPU with `shader-f16` runs the q4f16 weights (18.2 MiB, per the research); anything else runs q8 on wasm (26.0 MiB). transformers.js does not check `shader-f16` for q4f16 itself, so `depthWorker.js` does.
- **Fallbacks.** One pipeline per worker, so one per page. A WebGPU load that fails loads wasm instead, a WebGPU run that fails is tried once more on wasm, and a load that fails (offline) is forgotten, so the next picture tries again. The picture is drawn into a canvas at most 1024 px on its long side first (the output comes back at the input's size), which also fails fast on a tainted canvas, before the model is fetched; the output is resized to at most 512 px.
- **Downloads, on the first estimate only.** The worker chunk, which holds transformers.js (509.9 KB, 146.1 KB gzip), the weights from huggingface.co, and ONNX Runtime Web's wasm from cdn.jsdelivr.net (transformers.js's default; about 27 MB raw, 5.5 MB brotli per the research). transformers.js keeps the weights and the wasm in the browser's Cache Storage, which needs https or localhost: on a plain-http LAN address every reload downloads them again, and there is no WebGPU either. `vite.config.js`'s resolve condition `onnxruntime-web-use-extern-wasm` keeps that wasm out of `dist` (otherwise Vite copies it into `dist/assets`, though nothing fetches it there); `dist` is 4.1 MB. The TV's host JS is 100.3 KB (39.9 KB gzip) and carries no transformers.js code.
- **Measured once** (the built page served on 127.0.0.1 in the desktop app's Chromium pane on a Windows laptop, weights already cached, the Turner at 1024 px): WebGPU q4f16 ran, loading in 2.3 s and 4.0 s in all; wasm q8 (WebGPU hidden from the worker) loaded in 1.1 s and took 7.6 s in all, while the page's 50 ms timer never waited more than 63 ms. The TV laptop itself is not measured.

**On stage (`src/host/enrich.js`).** On every `scene` event with a scene, under a generation guard that drops any result for a scene that has since left:
1. A scene with a `depth_url` loads that image (`crossOrigin='anonymous'`), reads its red channel back as a depth image of at most 512 px and passes it to `game.setDepth`; the state is `saved`, device `file`. A file that will not load falls through to step 2.
2. A scene with no `image_url` (an unsaved reading) stops at `idle`. Otherwise the picture is loaded with CORS and estimated (`loading` while the model's first download runs, then `computing`), and the result goes to `game.setDepth`. The state is `ready` with the device and time, and the margin flashes "Depth Anything V2 · depth ready". The depth layer (W) now reads "Depth map: estimated from the picture by Depth Anything V2 (AI estimate)".
3. A saved project (a `source` other than `sample` and an `id` that `/api/depth` accepts) posts the PNG to `POST /api/depth` with `x-host-token` and `apiHeaders()`. The returned URL goes on the scene with `game.setSceneField('depth_url', url)`, so inside phones get it with the next `world` (the `enriched` broadcast), and the state is `saved`.

Any failure leaves `failed` (or `idle`) in the HUD and keeps the mask relief. The depth re-skins only the relief's shape: hotspots, object ids and the glow still come from the masks. The sketch and Starry Night ship a `depth_url` (below) and the Turner does not, so the TV estimates the Turner's like a new picture's, at boot too; either way the samples show the AI estimate rather than their hand-corrected mask relief once it loads. A sample's estimate is never uploaded, so inside phones on the Turner keep the plain planes.

Known limit: `depth_url` is set on the scene on stage only. It is not written back into `scenes/<id>.json`, the Snowflake row or the TV's local mirror, so a project reopened from the gallery estimates again (quick once the model is cached) and overwrites `depth/<id>.png`.

**The samples' depth images (`tools/depth.mjs`).** `node tools/depth.mjs` writes `public/samples/<name>.depth.png` for every sample in `index.json` except those in `PLANES` (`turner`, see Inside view's known limits) and puts `"depth_url": "/samples/<name>.depth.png"` into its scene file: an existing `depth_url` line is replaced, else one is added after `scene_url`, so the hand formatting stays (CRLF files included), and the result must re-validate with that `depth_url` before it is written. It runs Depth Anything V2 Small on the CPU in Node at the same revision, dtype q8 (about 26 MiB, downloaded once into `node_modules/@huggingface/transformers/.cache`), with the input at most 1024 px and the output at most 512 px, saved 8-bit grayscale through sharp. In its one logged run the model was ready in about 1 s and each picture took 1.5 to 1.6 s, except the SVG sketch, at 9.8 s (most of it rasterising). It does `tools/depth.py`'s old job; `depth.py` stays in the repo unused, and so does `public/samples/turner.depth.png` from the run before `PLANES`.

**3D models (`src/host/models3d.js`).** For each scene put on stage (`enrich.onScene`), while D has models on:
- **Which objects.** At most `MODELS_PER_SCENE` (2) objects that stand: kinds outside `BACKDROP` (`sky`, `cloud`, `celestial`) and `FLOOR_KINDS` (`ground`, `water`) from `src/world/tip.js`, covering at least 1 percent of the picture (`MIN_AREA`), subjects first (`vehicle`, `animal`, `person`, then other kinds, then `building`), then largest mask area (else box area), ties in scene order. The samples get Turner's Steam locomotive and Railway viaduct, the sketch's Tree and House (its dog is under `MIN_AREA`), and Starry Night's Cypress and Sleeping village. Nothing is asked for with no scene, or for an `image_url` that is `data:`, `blob:`, empty or protocol-relative. An object that already has a `model_url` counts as ready with no call.
- **The crop.** The object's box padded 8% of its own size on each side and clamped to the picture, clipped even-odd to its outline on a transparent background, at most 1024 px on its long side, as PNG. Whether Tripo models transparent cut-outs cleanly is unverified.
- **The cache key.** The sha1 hex of `image_url|label|JSON(mask, else box)`, through `crypto.subtle`, so https or localhost only. The same object on the same picture is never paid for twice once its GLB is in Blob.
- **The calls.** `POST /api/tripo {key, png}`, then `GET ?task=&key=` every 4 s for up to 10 minutes per object, one object at a time, each with `x-host-token` and `apiHeaders()` and a 125 s timeout. `busy` waits its `retry_after` (4 to 60 s); a poll that throws or answers 5xx (a function cut short) is asked again.
- **Success.** While that scene is still on stage, `game.setObjectModel(index, model_url)`, so inside phones get the model with the next `world`, and the margin flashes "Tripo · <label> · 3D model ready".
- **Stops.** `off`, `capped`, `no_credits`, a non-200 or non-JSON answer (the laptop hub, `npm run dev`) or an error on the TV (a tainted canvas, no `crypto.subtle`, a POST that did not get through) stops the rest of that scene. `failed`, a 10-minute timeout and a crop over 3 MB (413) skip only that object. Every failure is quiet: the flat stays.
- **D.** Toggles automatic models, stored in localStorage `tt.models` as `'1'` or `'0'` (default on), and flashes "3D models on" or "3D models off (D turns them back on)". Turning them back on re-runs the scene on stage; the server's task file and GLB cache answer what was already made.

Credits, at about 30 a new object (the research's figure for this task's options): a scene costs at most about 60, once. The samples count too: the first time each sample is shown on a deployment with a Tripo key, it asks for its two models, so about 180 credits in all for the three. The team's key is capped per instance at `TRIPO_MAX_PER_HOUR` new tasks (default 6, about 180 credits an hour per instance); a visitor's own key skips that cap. Whether a new API key comes with free credits is unverified. Ownership: per the research's reading of Tripo's terms, a free-plan user grants Tripo the rights to its inputs and outputs, while a paid user keeps them; the API box's Tripo card says so.

## Inside view

The phone's Step inside world is Tour into the Picture (TIP): Youichi Horry, Ken-ichi Anjyo and Kiyoshi Arai, "Tour Into the Picture: Using a Spidery Mesh Interface to Make Animation from a Single Image", SIGGRAPH 97. TIP treats one picture as the view into a simple room from the camera that painted it. The image below the horizon becomes the floor and the image above it the walls; each foreground object stands up as a flat cut-out at the distance where its foot meets the floor. Seen from that camera the model is the picture, and from anywhere else it is a walk-through with depth. In the paper a person marks the vanishing point and the foreground objects with a "spidery mesh". Here the scene Gemini already wrote does that job: the horizon comes from the objects' feet, the cut-outs from their masks and kinds, and the walk from `ground_path`. The world is built in the phone's browser with no further AI call and no depth model on the phone; when the scene carries the TV's depth image (`depth_url`), it shapes the room (see The depth room below). Every surface samples the picture by projective texturing through the painting camera: its colour is the picture at its position projected through that camera. In a browser check the view from the painting camera differed from the picture by a mean of 4.99/255 per channel on the Turner and 2.07/255 on the sketch.

- **Geometry (`src/world/tip.js`, pure, node:test).** World units are metres, with the floor at y = 0, x to the right and +z toward the viewer. The painting camera stands at (0, 1.6, 0) (`EYE`, also the walker's eye height) and looks along -z. It is pitched just enough to put the horizon on its row, with a 50° vertical field of view, narrowed for wide pictures so the horizontal one stays under 110°. So a plain `THREE.PerspectiveCamera(fov, aspect)` at `position`, looking at `lookAt`, reproduces the picture. The horizon row is the highest foot (`box[3]`) among `ground`, `building`, `plant`, `person`, `animal`, `vehicle` and `water` objects less 40, clamped to 300 to 700, or 450 when there are none; the margin keeps the farthest of them standing instead of at infinity. The back wall's foot is 12 rows below the horizon, and the walk keeps 20 rows clear of it.
- **Objects.**
  - `sky`, `cloud` and `celestial` stay painted on the back wall.
  - `ground` and `water` lie on the floor.
  - Every other object stands as a flat at its foot row's distance: an upright rectangle parallel to the picture plane, cut out by its mask (its box when the mask is `null`) with a 6-unit paper rim. One whose padded foot is at or beyond the wall's foot stays painted on the wall.
  - The floor and the wall use a plate: the picture with each standing object and its rim filled from a blurred 24 px copy, so walking past an object never shows it twice. The plate falls back to the plain picture when the canvas cannot be read back.
  - A dome around the room samples the picture's edge colours, so no direction looks into a void.
- **Still.** Nothing moves: the flats, the 3D models and the objects on the wall and floor all stay put (the per-kind motion read as cut-outs warping and was removed). `update()` is a no-op, kept for `buildDiorama`'s shape. Only the figures walk.
- **Models.** For a standing object with a `model_url` (https or site-relative, as in Scene), `three/examples/jsm/loaders/GLTFLoader.js` is imported lazily (its own chunk) and the model stands in for the flat. It is turned by `MODEL_YAW` (`-Math.PI / 2`, exported), centred on the flat's footprint, scaled to the flat's height with its feet on the flat's foot, and lit by a hemisphere and a directional light. `MODEL_YAW` assumes Tripo's default export faces +x and turns that to +z, toward the painting camera: that is unverified on a real Tripo GLB (it was checked with a test GLB facing +x), so if a real model shows its back, flip the sign. Any error, or 20 s without the model, keeps the flat. A `model_url` on an object that does not stand is ignored, and the URL needs CORS.
- **The depth room.** With a depth image (`opts.depth`) whose floor fits TIP's own geometry, the floor and walls become one relief mesh (`src/world/tip.js`, pure, node:test):
  - **The fit.** `fitDepth` fits `1 / rowDistance ≈ a × value / 255 + b` over floor pixels: rows at least 30 image units below the horizon, outside every object that is not floor, with one trim pass dropping the worst 20% by residual. It needs `a > 0`, an r² of at least 0.5 and at least 64 samples, else `null`.
  - **The relief.** One vertex per grid cell over the whole picture (at most 160 across and about 8000 cells), each on its own ray through the painting camera at its fitted distance, clamped between half the floor's nearest distance and the back wall. So the painting camera still sees every vertex at its own image point. A triangle whose corners' distances differ by more than 1.35 times is left out, which cuts silhouettes. It uses the plate and the projective shader, double-sided.
  - **Behind the flats.** The depth inside each standing flat's outline (grown 0.8% of the width) is filled along each row from the depths just outside it, or with the median around them all. Backdrop outlines (`sky`, `cloud`, `celestial`) are set to the back wall first, because a depth model reads a hazy sky as near.
  - **The flats.** Each stands at its median depth, but never behind the filled relief over its own outline (nearest relief ÷ 1.03), so the relief never hides it from the painting camera. A flat at 95% or more of the wall's distance stays painted on the relief.
  - **Around it.** The plain floor stays as a skirt 0.25 m below and the wall moves back to 1.05 times its distance, filling the space past the relief's edges and behind its cuts.
  - **The walk.** `pathAt` follows the terrain: the path's 129 samples sit on the filled depth's distances, with the inverse distance low-passed along the path, and the camera at that point plus `eyeHeight`.
  - **Fallback.** No depth, a bad depth or a fit that fails gives the plain planes above, exactly as before. In the phone builder's harness Turner fitted with r² 0.91 and Starry Night 0.96, while the sketch's fit failed and keeps the planes. The view from the painting camera still matched the picture (Turner 4.97/255 with depth against 4.96 without), and Turner's diorama is about 17.8k triangles.
- **`buildDiorama(scene, texture, {aspect, depth})`** (`src/world/diorama.js`).
  - It validates the scene itself and returns `{group, paintingCamera: {position, lookAt, fov, aspect, near, far}, eyeHeight, relief, pathAt(t) -> {position, forward}, objects: [{index, label, kind, position}], update(dt, reducedMotion), ready, dispose()}`. `relief` is true when the depth room was built. `update(dt, reducedMotion)` does nothing (inside.js still calls it every frame).
  - `pathAt` uses the TV's own path, `pathPoints(scene, () => 0, 8)` through `THREE.CatmullRomCurve3(…, false, 'catmullrom', 0.5)`, projected onto the floor (or the relief's terrain) through the painting camera. So a figure's `t` on the TV is the same spot here.
  - `ready` resolves to the indices of the objects whose model now stands, once every model has loaded or fallen back, and never rejects.
  - `dispose()` frees everything the diorama made, never the caller's texture.
- **Known limits.** The floor beside the walker stretches the picture into streaks. Looking behind you shows smeared edge colours, not a scene. Depth Anything reads the Turner as a shallow hazy room, about 10 to 25 m deep: the haze between the sky's outline and the horizon stands as a near slab with a straight top edge, and the locomotive moves from 21.9 m (plain TIP) to 9.8 m, about 80° right of the walk, so Step inside ends facing the slab. So the Turner sample ships no `depth_url` and keeps the planes; an upload of a hazy landscape can still look like this. The blurred plate's ghost of a flat still shows on the wall behind the walker. Nothing has run on a real iOS 13 device, and no real Tripo GLB has been loaded.

## Sprites

`public/sprites/tophat.png`, `bonnet.png` (1024 by 384, four 256 by 384 frames: walk1, walk2, walk3, wave; warm black with a 2 px cream edge) and `tophat-accent.png`, `bonnet-accent.png` (white where the band or ribbon is, tinted per player). Loaded with `repeat.set(0.25, 1)`; missing sheets fall back to procedural canvas figures. The sheets are not in the repo yet, so the procedural figures draw today.

## Env

Vercel (Project Settings, Environment Variables, by exact name; a change applies only to the next deployment):

| Name | Read by | Value |
|---|---|---|
| `HOST_TOKEN` (optional) | `api/sfx.js`, `api/depth.js`, `api/tripo.js`, `api/check.js` | Only the lock on the team's paid API calls. It no longer gates hosting: any browser on `/host` hosts its own room (see Rooms), and the relay never reads it. With it set, `/api/sfx`, `/api/depth` and `/api/tripo` require it in the `x-host-token` header (401 otherwise, checked before a visitor's own key), and `/api/check` answers team checks only with it; the TV sends its page's `?host=`. A TV opened without it still hosts, and reads pictures (`/api/interpret` takes no token), but makes no generated sounds, saves no depth image (it still estimates one) and builds no Tripo models. Empty means no lock: every session uses the team's keys within the hourly caps (`INTERPRET_MAX_PER_HOUR`, `SFX_MAX_PER_HOUR`, `TRIPO_MAX_PER_HOUR`, each per instance). |
| `JOIN_URL` | `api/ws.js` | The join URL the QR encodes, before the TV adds `?room=`. Empty means `https://<request host>/`; set it to the production URL. |
| `REDIS_URL`, else `KV_URL`, else `UPSTASH_KV_URL` | `api/ws.js` | A `rediss://` URL for the relay's bus, read in that order. The Upstash integration injects `KV_URL` or `UPSTASH_KV_URL`; `REDIS_URL` is the name for a URL added by hand. Its REST URL and token are not enough, because the relay speaks the Redis protocol (ioredis). Without one the relay delivers only inside one instance and the HUD says "no redis". |
| `BLOB_READ_WRITE_TOKEN` | `api/interpret.js`, `api/sfx.js`, `api/depth.js`, `api/tripo.js` (through `@vercel/blob`), `api/check.js` | Injected when a Blob store is connected to the project. `/api/check` only tests that it is set. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (optional) | `lib/gemini.js` (for `api/interpret.js`); `api/check.js` reads the key | One Gemini project, one key. A visitor who brings their own (`x-gemini-key`) needs neither; without the key, every other reading gets `no_key`. |
| `INTERPRET_MAX_PER_HOUR`, `INTERPRET_MIN_GAP_MS` (optional) | `api/interpret.js` | Requests let through to Gemini per hour on one instance (default 30; 0 refuses all) and the least gap between one client's requests in ms (default 8000; 0 turns it off); anything but a whole number means the default. |
| `ELEVENLABS_API_KEY`, `SOUND_GEN`, `SFX_MAX_PER_HOUR` (optional) | `api/sfx.js`; `api/check.js` reads the key and `SOUND_GEN` | `SOUND_GEN` is `on` or `off`; anything but `on` answers 204 and generates nothing, unless the request brings a valid `x-elevenlabs-key` (which also skips `SFX_MAX_PER_HOUR` and needs no `ELEVENLABS_API_KEY`). `SFX_MAX_PER_HOUR` (default 20) caps new sounds per instance per rolling hour. `tools/sfx.mjs` reads the key from a local `.env` (`node --env-file=.env tools/sfx.mjs`). |
| `TRIPO_API_KEY`, `TRIPO_MAX_PER_HOUR` (optional) | `api/tripo.js`; `api/check.js` reads the key | The team's Tripo key (`tsk_…`, from platform.tripo3d.ai), set on Vercel. Without it, and without a visitor's `x-tripo-key`, `/api/tripo` answers `off` and the TV keeps its flats. `TRIPO_MAX_PER_HOUR` (default 6; 0 means cache only; anything but a whole number means the default) caps new tasks on the team key per instance per rolling hour, at about 30 credits each. |
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_PAT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE` | `lib/snowflake.js` (for `api/interpret.js`, `api/projects.js`, `api/check.js`) | The app signs in with `SNOWFLAKE_PAT`, a programmatic access token's secret (the quick path, see Run it), or else with `SNOWFLAKE_USER` and `SNOWFLAKE_PRIVATE_KEY` (the full PEM, PKCS#8, unencrypted). If both are set, the PAT wins and the user and key are not read. The PAT never appears in a log line, an error or an answer. `SNOWFLAKE_ROLE` is optional (empty means the user's default role; with a PAT, keep it the token's role or empty). With the account, warehouse, database or schema missing, or neither way of signing in complete, saves are skipped and the project list is empty. |

`VERCEL_REGION` is set by Vercel itself and becomes `region` in the `hub` message. `ONNXRUNTIME_NODE_INSTALL=skip` needs no variable: `vercel.json`'s `installCommand` sets it (see Run it).

Laptop (`.env`, never committed; `tools/start.cmd` loads it and the laptop hub inherits it; `npm run hub` reads the shell's environment): `PORT` (8080 by default, 80 under start.cmd), `HUB_URL` (start.cmd only: where the kiosk loads the host page, default `http://localhost`), `HOST_TOKEN` (the laptop hub does not read it; `tools/start.cmd` puts it in the kiosk URL as `?host=`, which matters only when `HUB_URL` is the Vercel URL, and then it must equal the Vercel value for the team's API calls), `JOIN_URL` (leave it empty so the QR encodes `http://<LAN_IP>/?room=<room>`), `WIFI_SSID` and `WIFI_PASS` (the hotspot Wi-Fi QR beside the join QR after Q), `LAN_IP` (empty means the first private IPv4), `ALLOW_ORIGIN` (CORS for `/healthz`). `.env.example` lists them, plus the Vercel names without values.

Pages: no env; query parameters only (`?host=`, `?hub=`, `?roll=`, and the phone's `?room=`).

## Run it

Install the dependencies once.

```
npm install
```

`@huggingface/transformers` is a dependency for the TV's depth estimate and `tools/depth.mjs`, and it brings `onnxruntime-node` and `sharp`. On Windows and macOS their prebuilt binaries install as they are. On Vercel's Linux build, `onnxruntime-node`'s install script would also download its CUDA 12 provider from NuGet, so `vercel.json`'s `installCommand` is `ONNXRUNTIME_NODE_INSTALL=skip npm install`. No `api/*.js` imports transformers.js, so no function bundle carries it.

Development: start the laptop hub in one terminal and Vite in another. Vite proxies `/api/ws` to the hub on 8080.

```
npm run hub
```

```
npm run dev
```

On the laptop, open `http://localhost:5173/host.html`. On a phone on the same network, open `http://<laptop LAN IP>:5173/join.html?room=<room>`, with the 16 characters after `?room=` in the TV's QR caption (the QR itself points at the hub's port 8080, which serves `dist`). The TV boots into sample 1 and keys 1, 2 and 3 load the samples. Without the HTTP API (see below) a drop shows the picture flat with "Couldn't read this one; walking on the flat painting". The phone hides Add artwork on http. Step inside works on http too, but Look by moving your phone needs https. In dev, Vite serves the join page at `/join.html`; the hub serves the same page at `/`. To see a rollover without waiting four minutes, add `?roll=20000` to the host URL and `&roll=20000` to the phone's.

Demo on the laptop alone: Vite builds `dist` and the hub serves it on port 8080. Open `http://localhost:8080/host` on the laptop and scan its QR with a phone (`http://<laptop LAN IP>:8080/?room=<room>`). Several TVs can run at once, on the laptop hub or on Vercel: each browser or profile that opens `/host` hosts its own room with its own QR. A second tab in the same browser has the same key, so it takes that room over and the first tab says "Another host tab took over".

```
npm run demo
```

Tests:

```
npm test
```

The HTTP API locally (N's machine, the linked one). The laptop hub and `npm run dev` serve only the pages and the relay; `/api/interpret`, `/api/projects`, `/api/sfx`, `/api/check`, `/api/depth` and `/api/tripo` run on Vercel or under `vercel dev`. First tick Development on the API's variables in Project Settings: `vercel env pull` writes that environment (another with `--environment`) to `.env.local`, which git ignores (`.env.*`). Never pull into `.env`: the Q fallback reads it. Then start `vercel dev` (port 3000):

```
vercel env pull
```

```
vercel dev
```

These are the real keys: an interpret spends Gemini quota and writes real Blob files and a Snowflake row, and with `SOUND_GEN=on` every new label spends ElevenLabs credits. With `TRIPO_API_KEY` pulled, the first showing of each picture spends about 30 Tripo credits for each of up to two standing objects, the samples included (D turns models off). The pages under `vercel dev` still need a relay: run `npm run hub` beside it and open `http://localhost:3000/host.html?hub=localhost:8080` (add `&host=<HOST_TOKEN>` when the pulled environment sets `HOST_TOKEN`, or sounds, depth saves and models answer 401). To try the API alone (the second sends the Turner scan and prints `ok` and the scene URL, or the reason):

```
curl -s http://localhost:3000/api/projects
```

```
node -e "fetch('http://localhost:3000/api/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:require('fs').readFileSync('public/assets/turner-1920.jpg','base64')})}).then(r=>r.json()).then(j=>console.log(j.ok,j.reason||j.scene_url))"
```

Your own keys. On the TV, press K (or, with H's operator cards showing, click the API button in the right margin), paste a Gemini, ElevenLabs or Tripo key and press Test: the card turns to "Working" or says why not, and from then on the TV's readings, sounds and models use that key. Without the box, the same check from a shell (`service` is `gemini`, `elevenlabs`, `tripo`, `snowflake` or `storage`; add `-H "x-gemini-key: <key>"`, `-H "x-elevenlabs-key: <key>"` or `-H "x-tripo-key: <key>"` to test yours instead of the team's, or `-H "x-host-token: <token>"` for the team's when `HOST_TOKEN` is set; at most 10 checks a minute):

```
curl -s -X POST http://localhost:3000/api/check -H "content-type: application/json" -d "{\"service\":\"gemini\"}"
```

Vercel (production). One person deploys; Hobby runs one build at a time.

1. Link the project. A Hobby project links only to a repository on a personal GitHub account, not an organisation.

   ```
   vercel link
   ```

2. Add Upstash Redis and a Blob store with Public access from the Vercel Marketplace (the project's Storage tab) and connect both to the project. Blob injects `BLOB_READ_WRITE_TOKEN`. If the Upstash install asks for a card, create the free database at console.upstash.com instead and use its `rediss://` URL as `REDIS_URL`.
3. Set the variables in the Env table, in Project Settings or with the CLI. `HOST_TOKEN` is optional: set it to keep the team's sounds, depth saves and Tripo models for a kiosk opened with it. For example:

   ```
   vercel env add HOST_TOKEN production
   ```

   The Snowflake values come from G's one-time setup, `sql/projects.sql`, run in a Snowsight worksheet on the trial account (AWS us-east-1, beside Vercel's iad1); every object in it is named in full, so the worksheet's context does not matter. As ACCOUNTADMIN, uncomment and run its setup (warehouse `LB_WH`, database `LB_DB`, schema `LB_DB.APP`, role `LB_APP` with SELECT and INSERT on the schema's future tables, and the service user `LB_SERVICE`), then run the one live statement, `CREATE TABLE IF NOT EXISTS LB_DB.APP.PROJECTS`. Set `SNOWFLAKE_ACCOUNT` (orgname-accountname, from the query in the file), `SNOWFLAKE_WAREHOUSE=LB_WH`, `SNOWFLAKE_DATABASE=LB_DB`, `SNOWFLAKE_SCHEMA=APP` and `SNOWFLAKE_ROLE=LB_APP` for Production and Preview, plus one of the two sign-ins below. The app writes plain `PROJECTS`, which those database and schema names resolve. For a save that did not land, the `statementHandle` in its Vercel log line is the Query ID to look up in Snowsight's Query History.

   **Use a programmatic access token (PAT).** It is the quick path: the token's secret is all of `SNOWFLAKE_PAT`, with no `SNOWFLAKE_USER`, no key and no signing. For this path, leave the `RSA_PUBLIC_KEY` line out of the setup's `CREATE USER` and end its `DEFAULT_NAMESPACE = LB_DB.APP` line with the semicolon instead. Snowflake lets a `TYPE = SERVICE` user such as `LB_SERVICE` make or use a PAT only while a network policy applies to it, and Vercel's functions do not call from fixed addresses, so give `LB_SERVICE` alone (never the account) a policy that allows every IPv4 address. In the same worksheet:

   ```sql
   USE ROLE ACCOUNTADMIN;
   USE SCHEMA LB_DB.APP;
   CREATE NETWORK RULE LB_ANY_IPV4 TYPE = IPV4 MODE = INGRESS VALUE_LIST = ('0.0.0.0/0');
   CREATE NETWORK POLICY LB_SERVICE_ANY_IP ALLOWED_NETWORK_RULE_LIST = ('LB_ANY_IPV4');
   ALTER USER LB_SERVICE SET NETWORK_POLICY = LB_SERVICE_ANY_IP;
   ALTER USER LB_SERVICE ADD PROGRAMMATIC ACCESS TOKEN LB_VERCEL
     ROLE_RESTRICTION = 'LB_APP'
     DAYS_TO_EXPIRY = 365
     COMMENT = 'Vercel SQL API';
   ```

   The last statement's output shows the token's secret (`token_secret`) this once and never again: paste it straight into Vercel as `SNOWFLAKE_PAT` (Production and Preview) and redeploy. Snowsight can make the same token instead: Governance & security > Users & roles > `LB_SERVICE` > Programmatic access tokens > Generate new token, with "One specific role" set to `LB_APP`. A service user's token must name its role, which cannot be changed later; keep `SNOWFLAKE_ROLE` at `LB_APP` or empty (the user's default role, also `LB_APP`). A token lasts at most 365 days (15 by default) and a user holds at most 15, so make the next one and swap the variable before it expires. The Snowflake docs do not show `0.0.0.0/0` inside a network rule; if Snowflake refuses the rule, make the policy the older way, `CREATE NETWORK POLICY LB_SERVICE_ANY_IP ALLOWED_IP_LIST = ('0.0.0.0/0');`, and go on from the first `ALTER USER`. Instead of the network policy, an authentication policy can lift the requirement: `CREATE AUTHENTICATION POLICY LB_DB.APP.LB_PAT_POLICY PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED);` then `ALTER USER LB_SERVICE SET AUTHENTICATION POLICY LB_DB.APP.LB_PAT_POLICY;` (the docs leave open whether a network policy on the whole account would then still block Vercel).

   **Or use the key pair**, the alternative: make it with openssl on a laptop (never commit `rsa_key.p8`), paste the public key into the setup's `CREATE USER`, check with `DESCRIBE USER LB_SERVICE` that `RSA_PUBLIC_KEY_FP` is `SHA256:` plus the openssl fingerprint, then set `SNOWFLAKE_USER=LB_SERVICE` and `SNOWFLAKE_PRIVATE_KEY` (all of `rsa_key.p8`). It needs no network policy and does not expire. If `SNOWFLAKE_PAT` is set as well, the PAT wins and these two are not read.

4. Check that a `rediss://` URL is set under `REDIS_URL`, `KV_URL` or `UPSTASH_KV_URL`; only those three names are read. If the integration only injected REST variables, copy the database's `rediss://` URL into `REDIS_URL`.

   ```
   vercel env ls
   ```

5. Turn off Vercel Authentication for preview deployments, or every test has to run on production.
6. Deploy. Environment changes reach only new deployments, so deploy again after every change.

   ```
   vercel --prod
   ```

7. Check that `https://<project>.vercel.app/api/ws` answers `"bus":"redis"`, then open `https://<project>.vercel.app/host` on the kiosk (`/host?host=<HOST_TOKEN>` when it is set). The HUD should read `vercel iad1`, without "no redis". After a deploy that changes the socket URLs, as rooms did, reload the kiosk and the phones: a TV still on the old page sends no key, gets 4003 and stops, and an old phone page sends no room and keeps retrying.

Q fallback: `tools\start.cmd` starts the laptop hub on port 80 (building `dist` first if it is missing), then opens Chrome in kiosk mode on `%HUB_URL%/host?host=%HOST_TOKEN%`. It reads an uncommitted `.env`. With `HUB_URL` set to the Vercel production URL, the kiosk runs on Vercel and keeps the laptop hub warm: Q switches the host socket to it, and the QR switches to the laptop's join URL with the same room (the hotspot pair when `WIFI_SSID` is set). Phones do not follow by themselves; they rescan. With `HUB_URL` left at `http://localhost`, everything runs on the laptop.

```
tools\start.cmd
```

A printed join QR (the tent card) must carry the kiosk's room: copy the URL from the QR caption or H's `join` line. The room holds while the kiosk's browser keeps `tt.hostKey`; start.cmd gives Chrome its own profile (`%LOCALAPPDATA%\toy-theatre-kiosk`), so a restart keeps it. A new profile or cleared site data is a new room, and the printed code then leads to a room no TV hosts. A printed `/` with no room shows "Scan the code on the screen to join" on a phone that has never joined.

v1's arch STL export still runs from the command line (`lib/` is wired to no page). These are the span and rise of Brunel's Maidenhead arch.

```
node tools/export-arch.mjs --span 128 --rise 24.25
```

Make the sound palette (once, offline). Until it runs, `public/sfx/` does not exist and every palette sound is silent and unflashed, the `describe` tick included (it plays `poke.mp3`); the generated per-object sounds no longer play either (see audio.js, Per-object sounds). `tools/sfx.mjs` writes each missing `public/sfx/<file>.mp3` listed in `tools/sfx-palette.json`, one at a time in palette order, and stops at the first error; it never remakes a file that exists, so delete one to make it again. It reads `ELEVENLABS_API_KEY` from `.env` and refuses to run without it (`--env-file` needs Node 20.6 or later). Every file spends ElevenLabs credits, at 40 a second: 80 for a 2 s sound, 160 for a 4 s loop, about 1760 for the whole palette. Nothing is retried, because a retry is billed again. See the plan and its cost first; that needs no key:

```
node tools/sfx.mjs --dry-run
```

```
node --env-file=.env tools/sfx.mjs
```

`--only <file>` (for example `--only poke`) makes just that one. When the key can read its subscription, the run prints the credits left before, after each file and at the end.

Make the samples' depth images (once, offline; needs no key). It writes `public/samples/<name>.depth.png` and the `depth_url` line in each sample's scene file (not the Turner's, `PLANES`), and running it again only rewrites them. The first run downloads the q8 model (about 26 MiB) from huggingface.co into `node_modules/@huggingface/transformers/.cache`:

```
node tools/depth.mjs
```

Turn on the secret-scanning pre-commit hook, once per clone:

```
git config core.hooksPath .githooks
```

## MUST list

These eight deliverables defined Completion in v1 (from the v1 PRD's Scope section). The v2 PRD puts v1's plaques, engineering panels, STL export and print out of scope, so those parts are struck through and marked superseded; the v2 MVP follows. The ticks are filled in at each gate, from the results logged in `tests/gates.md`.

- [ ] M1 Kiosk: ~~Turner's painting as a depth relief with mouse lean, three plaques usable by mouse and keys, Show the original, Show the work.~~ Superseded by v2: any artwork (sample 1 at boot) as a depth relief with mouse lean, played from the keyboard (pid 0 walks, and Space describes the object it stands at), O shows the original, W cycles the four layers. Works at every commit with zero phones.
- [ ] M2 Hub: ~~a Node relay on Fly.io Newark with a stable HTTPS URL, running the same code as the laptop's Q fallback.~~ Superseded by the Vercel relay (Sat Oct 24): `api/ws.js` with Upstash Redis on the Vercel URL, running the same `hub/relay.js` as the laptop's Q fallback; Fly is dropped. Tokens, slot hold, judge-mode slot reserve (now in the host tab: `src/host/slots.js`, `glue.js`), rate limits, health endpoint.
- [ ] M3 Join page: works in any phone's browser. Tap a colour, hold-to-walk pad, one verb button, ~~three plaque panels~~ (superseded by v2: the verb shows the description of the object the figure stands at, and Add artwork over https), reconnect, wake lock. Under 150 KB.
- [ ] M4 Figures: two cut-paper bodies in six accent colours walking ~~one riverbank curve, depth-placed, never over the train, bridge or hare~~ (superseded by v2: each scene's ground path, depth-placed on its relief). Roster in the margin.
- [ ] M5 Follow camera: fits the group, zoom 1.0 to 1.35, translate-only pan, lean from the group~~, focus frame only when exactly one plaque is owned~~ (superseded by v2: no plaques, so the camera only follows).
- [ ] M6 ~~Plaques and~~ ops: ~~three brass plaques with Look, operator ownership and release rules~~ (superseded by v2: one stop per Gemini object, described with the verb), J judge mode, R reset under 10 s, Q fallback switch, network layer (W, the platform panel).
- [ ] M7 Content and print: wall label (v2: the AI label margins.js draws), ~~three cited cards~~, tent card with the join QR, pictogram card (cut on Saturday; the tent card carries the same three steps), attendant checklist, colophon, ~~arch object label, dated reconstruction captions~~ (the plaque content is superseded by v2).
- [ ] M8 Submission: public repo from Fri 9:30 PM, README with dependency versions and the AI-tools table, LEARNING.md with timestamps, Devpost with video submitted by Sun 8:20 AM.

The v2 MVP (the v2 PRD's Scope section, MVP items 1 to 8):

- [ ] V1 Capture: a laptop drop or U (`artwork.js`), or Add artwork on a phone over https (`src/join/main.js`).
- [ ] V2 Interpret: `POST /api/interpret` (Gemini). Every AI string is tagged (the chip, "(AI label)", "(AI guess)", "AI guesses"), and the original is one key (O) or tap (Show the original) away.
- [ ] V3 Simulate: `game.loadScene` builds the relief from the reading~~, and objects move by kind~~ (dropped Sat Oct 24: the pictures hold still, and the object a figure stands at glows). A saved scene replays without Gemini.
- [ ] V4 Interact: phones walk figures and ~~poke objects~~ read each object's description (Sat Oct 24); judge-mode slot reserve; R under 10 s.
- [ ] V5 Sound: ElevenLabs palette sounds on join, appear and describe (~~and per-object sounds on poke~~: nothing plays them since the verb became describe), quiet (gain 0.3), S mutes, and every sound is named in the margin.
- [ ] V6 Save: every project is saved in Snowflake. "Saved to Snowflake" shows only after the row is found.
- [ ] V7 Deploy: pages, API and relay on Vercel; a fresh clone deploys from this README; the repo is public.
- [ ] V8 Step inside: the phone's first-person world (`src/join/inside.js`, `src/world/`), with Walk, Turn around and drag look, plus tilt over https. It is built in the phone's browser from the saved reading with no further AI call. The TV keeps its relief. Tier 2 adds the depth room from the TV's depth image and Tripo models in place of flats.

## Dependency versions

Node >= 20 (`engines` in `package.json`). Every package is pinned to an exact version; `package-lock.json` holds the rest of the tree.

| Package | Version | Kind |
|---|---|---|
| @elevenlabs/elevenlabs-js | 2.74.0 | dependency (api: sound effects) |
| @google/genai | 2.31.0 | dependency (api: Gemini) |
| @huggingface/transformers | 4.3.1 | dependency (the TV's depth estimate, a lazy chunk, and `tools/depth.mjs`; never imported by `api/`). It pins onnxruntime-web 1.31.0-dev.20260914-8d85527a0 and onnxruntime-node 1.30.0, and brings sharp (0.35.5 in the lock) |
| @vercel/blob | 2.8.2 | dependency (api: images, scenes, sound cache) |
| @vercel/functions | 3.10.3 | dependency (api: `waitUntil`) |
| express | 4.22.3 | dependency (laptop hub) |
| ioredis | 6.0.0 | dependency (relay bus on Vercel) |
| ws | 8.22.0 | dependency (relay) |
| three | 0.128.0 (r128) | dev (host page, and the phone's inside view with its examples/jsm GLTFLoader) |
| qrcode-generator | 1.4.4 | dev (host page) |
| nosleep.js | 0.12.0 | dev (join page) |
| vite | 5.4.21 | dev (build) |
| @fontsource/im-fell-english | 5.3.0 | dev (type) |
| @fontsource/libre-franklin | 5.3.0 | dev (type) |
| @fontsource/jetbrains-mono | 5.3.0 | dev (type) |

`tools/depth.py` is not part of the build, and `tools/depth.mjs` now does its job. It ran once, offline, in Python with torch, transformers, pillow and numpy, none of them pinned.

Licences of the Tier 2 pieces: transformers.js (`@huggingface/transformers`) Apache-2.0, ONNX Runtime (onnxruntime-web and onnxruntime-node) MIT, sharp Apache-2.0, and the model, Depth Anything V2 Small (`onnx-community/depth-anything-v2-small`), Apache-2.0. Only the Small checkpoint has that licence (Base and Large are CC-BY-NC-4.0), so nothing here uses the others. Tripo is a service, not a package (`lib/tripo.js` is plain fetch); its outputs' rights follow Tripo's terms (see Depth and 3D models).

## AI tools

| Tool | Used for | How it was checked |
|---|---|---|
| Claude Code (Anthropic Claude, Opus model) | The reference prototype and deploy kit, written in the planning folder before this repo existed. In this repo: the Stage 1 to 2 code scaffold (`hub.js`, `src/`, `lib/`, `tests/`, `tools/`), plus these README sections, `CREDITS.md` and the `LEARNING.md` template. | The node:test suites (`npm test`) and the on-device gate runs logged in `tests/gates.md` |
| Claude Code (Anthropic Claude, Opus model) | v2: the build plan and the PRD amendments, and the relay and seat move. That covers `hub/relay.js`, `hub/redisBus.js`, `api/ws.js`, `src/host/slots.js`, the socket rollover in both pages, and this README's Protocol, Env and Run it sections, `tests/gates.md`, `.env.example` and `CREDITS.md`. Later, the per-room relay: host keys, rooms, the room in both pages and the QR, and the no-room screen. | The node:test suites (`npm test`) and the gate runs logged in `tests/gates.md` |
| Claude Code (Anthropic Claude, Opus model) | v2's front end, finished after the Three.js teammate left: `src/host/scene.js`, `pathOverlay.js`, `artwork.js`, `gallery.js`, `audio.js`, `margins.js`, `glue.js`, `objectIdMap` in `maskDepth.js`, `host.html`, the phone page, `public/samples/` and `src/shared/learning.json`, plus this README's window.game, TV modules, Constants and MUST sections. | The node:test suites (artwork, audio, margins, maskDepth, glue, camera), private Vite builds, browser checks of the stage and the phone against a fake relay, and the gate runs logged in `tests/gates.md` |
| Claude Code (Anthropic Claude, Opus model) | v2's inside view: `src/world/tip.js` and `diorama.js`, `src/join/inside.js` and `inside.css`, Step inside in `join.html` and `src/join/main.js`, the `world` and `pos` messages in `glue.js`, `game.positions()`, `objects[].model_url` in `scene-validate.js`, and this README's Inside view section and its Protocol, Scene and phone page lines. | The node:test suites (tip, scene-validate, glue), private Vite builds, and browser checks of the diorama and of the phone against a fake relay. Not yet run on a real phone. |
| Claude Code (Anthropic Claude, Opus model) | v2's Tier 2 (depth and 3D models): `src/host/depthAI.js`, `enrich.js` and `models3d.js`, `setDepth`, `setSceneField` and `setObjectModel` in `scene.js`, their wiring in `glue.js` and `margins.js`, `api/depth.js`, `api/tripo.js`, `lib/tripo.js`, the Tripo check and key (`api/check.js`, `src/shared/byok.js`, `apibox.js`), `tools/depth.mjs` and the samples' depth images, the depth room in `src/world/tip.js`, `diorama.js` and `src/join/inside.js`, and this README's sections on them. | The node:test suites (depth, tripo, models3d, tip, scene-validate, margins, check, byok), private Vite builds, and browser checks of the phone's depth room in a harness with the real sample depth images. Not yet run: the depth model in a real browser on the TV, the real Tripo API, a real Tripo GLB, a real phone. |
| (add any other tool the team uses) | | |

## Credits

The painting's record, the depth model, the type, the libraries, the services and the sources: see [CREDITS.md](CREDITS.md). Sound: elevenlabs.io. Depth: Depth Anything V2 Small (Apache-2.0) through transformers.js (Apache-2.0). 3D models: Tripo (tripo3d.ai).

## Learning

Each teammate's timestamped entries and the stranger-test log: see [LEARNING.md](LEARNING.md).
