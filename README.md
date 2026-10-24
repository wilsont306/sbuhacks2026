# Living Blueprint: Toy Theatre

A gallery interactive for one painting: J. M. W. Turner, *Rain, Steam, and Speed – The Great Western Railway* (1844, The National Gallery, London, NG538, public domain). The painting shows on a TV as a depth relief displaced in our own shader; any visitor scans one code, their phone becomes the controller, a cut-paper figure walks the riverbank, and three brass plaques open the painting's engineering: Fig. 1 The Locomotive (crank-slider), Fig. 2 The Viaduct (Brunel's arch with a Heyman thrust-line check and an STL export), Fig. 3 The Hare (the untouched original).

Built at SBUHacks 2026 (Stony Brook University, Oct 23 to 25).

<!-- The sections below are the frozen contract. Every module is built against them; change code and README together. -->

## Layout

```
hub.js                 Node relay (Fly.io Newark in production, the laptop on port 80 as the Q fallback)
host.html              the TV page (Vite entry) -> dist/host.html, served at /host?host=TOKEN
join.html              the phone page (Vite entry) -> dist/join.html, served at /
src/shared/            protocol.js (constants, hubUrl), slots.json, tokens.css, cards.json
src/host/              main.js -> scene.js (Three.js stage, window.game) + glue.js (hub socket, margins, J/R/Q/H)
src/join/              main.js, join.css (the controller)
lib/                   archGeometry.js, heyman.js, stl.js, crankSlider.js (pure functions, node:test)
public/                assets/turner-1920.jpg, path.json, depth/turner-depth.png, sprites/*.png
tools/                 depth.py, start.cmd, export-arch.mjs
tests/                 *.test.js (node --test), gates.md
```

## URLs

- Join page at `/`, host page at `/host?host=TOKEN` (`/host.html?host=TOKEN` in `npm run dev`), WebSocket at `/ws`, health at `/healthz`.
- WebSocket URL (`hubUrl()` in `src/shared/protocol.js`): `wss://toy-theatre-hub.fly.dev/ws` when the page is served from `*.vercel.app`; otherwise the page's own origin plus `/ws` (ws on http, wss on https). `?hub=` overrides both (`localhost`, `host:port`, or a full ws/http URL).
- The host appends `role=host&host=<token>` to the ws URL; the token comes from the host page's `?host=` query.

## Protocol

All messages are JSON objects with a `t` field. Player sockets are capped at 1 KB per message and 20 messages per second; the host socket is exempt from both.

Player -> hub

| Message | When |
|---|---|
| `{t:'hello', token, slot}` | First message. `token` is the stored token or `null`. `slot` (0 to 5, optional) is the colour the visitor tapped; ignored on a token reconnect or if taken. |
| `{t:'in', lx, a}` | `lx` -1, 0 or 1 (walk left, stop, right); `a` 0 or 1 (the verb button held). Sent on every change plus a 10 Hz heartbeat while any input is non-zero. |
| `{t:'panel', kind, value}` | `kind` is `done` (leave the plaque), `original` (Show the original on the TV), `lever` (mph, 0 to 60), `span` (ft, 90 to 160), `rise` (ft, 10 to 48 on phones), or `export` (save the current arch as an STL on the exhibit laptop). `value` is a number. Slider kinds are sent at most 10 times a second while dragging, plus the final value on release. |
| `{t:'hbr', ts}` | Echo of a host heartbeat `{t:'hb', ts}`, for round-trip time. |

Hub -> player

| Message | When |
|---|---|
| `{t:'lobby', free:[slot…]}` | On connect before `hello`, and again to every un-joined socket whenever a slot is taken or freed. |
| `{t:'welcome', pid, token, color, name, slot}` | Reply to `hello`. Store `token` in localStorage. |
| `{t:'full'}` | Reply to `hello` when no slot is free (or the host's cap is reached). The phone retries every 3 s. |
| `{t:'hb', host}` | Every 2 s; `host` is true while a host tab is connected. |
| `{t:'evicted', reason}` then close 4001 | Kicked by the host (also the reply to any later `hello` with a kicked token, so a phone that was away at the kick cannot rejoin by itself) or the slot hold expired. The phone clears its token and stops auto-reconnecting. |
| anything the host sends with `to` or `all` | Forwarded verbatim (see below). |

Host -> player (forwarded by the hub)

| Message | Meaning |
|---|---|
| `{t:'mode', mode}` | `mode` is `walk`, `loco`, `bridge`, `hare`, `frozen` or `reset`. A plaque mode means this phone now operates that plaque; the phone shows that card from its own static `cards.json` (mode messages never carry card text). |
| `{t:'near', plaque}` | The phone's figure entered (`'loco'`, `'bridge'`, `'hare'`) or left (`null`) a plaque hotspot; the verb button's live label follows. |
| `{t:'readout', text, plaque?, …}` | Without `plaque`: a one-off line the phone toasts ("Fig. 2 is in use by Rose Walker", "Showing the original on the screen for 8 s", "Fig. 2 closed after 20 s without a touch", "Saved arch_128ft_24ft3in.stl on the exhibit laptop"). With `plaque`: a live mirror of that plaque's state, shown in the open panel and never toasted: `plaque:'loco'` carries `mph, rpm`; `plaque:'bridge'` carries `span, rise, stands, marginMm, push, worstJoint, where` (`where` is `crown`, `haunch` or `springing`). The host sends a mirror right after every plaque `mode` (so the phone's sliders start at the TV's values) and after every accepted slider value. |
| `{t:'hb', ts}` | Host heartbeat every 2 s (sent with `all`); the phone answers `{t:'hbr', ts}`. |

Hub -> host

| Message | When |
|---|---|
| `{t:'hub', joinUrl, lanIp, region, boot, wifi}` | On host connect, before the replayed joins. `joinUrl` is what the QR encodes (`JOIN_URL` env, else `http://<lanIp>[:port]/`); `boot` is a random id per hub process (pids restart at 1 with each process, so on a new `boot` the host drops every player it had and takes the replayed joins as new players); `wifi` is `{ssid, pass}` from `WIFI_SSID`/`WIFI_PASS` env or `null`. |
| `{t:'join', pid, name, color}` | A player joined or re-joined. Replayed for every connected player when the host (re)connects. `addPlayer` is an upsert. |
| `{t:'away', pid}` | A player's socket closed; the slot is held 20 s. The hub first sends `{t:'in', pid, lx:0, a:0}`. |
| `{t:'back', pid}` | That player reconnected with its token inside the hold (followed by `join`). |
| `{t:'leave', pid}` | The slot was dropped (hold expired or kicked). |
| `{t:'in', pid, lx, a}` / `{t:'panel', pid, kind, value}` / `{t:'hbr', pid, ts}` | Player messages, stamped with `pid`. |
| `{t:'stats', uptime, joinsTotal, reconnects, players}` | Every 5 s. |

Host -> hub

| Message | Effect |
|---|---|
| `{t:'to', pid, msg}` / `{t:'all', msg}` | Forward `msg` to one or every joined player. |
| `{t:'kick', pid, reason}` | Send `evicted`, close 4001, drop the slot, tell the host `leave`. The hub refuses that token from then on. |
| `{t:'cap', max}` | The hub answers `full` to new joins while `players >= max` (token reconnects always succeed). The host sends 6 on connect and on R. |

Close codes: 4000 host replaced by a newer host tab; 4001 evicted (phone stops auto-reconnect); 1000 `replaced`, the same token said `hello` on a newer socket (the old tab keeps its token, shows the end screen and stops auto-reconnect, so two tabs never steal the slot back and forth); 4003 bad host token; 1013 busy (more than 12 sockets); 1009 player message over 1 KB.

## window.game

Defined synchronously by `src/host/scene.js` (T); every method is callable immediately, before the painting or depth has loaded. `src/host/glue.js` (N) calls it and assigns `sendTo` and `sendAll`.

| Call | Contract |
|---|---|
| `addPlayer(pid, name, color)` | Upsert a figure. Body by pid parity: top hat for odd pid, bonnet for even (pid 0 is the kiosk keyboard player and is always on the bank). |
| `removePlayer(pid)` | Remove the figure. |
| `setInput(pid, lx, a)` | Walk direction and verb button. A rising edge of `a` while the figure is at a plaque emits a `look` hotspot event. Ignored while the figure is frozen. |
| `setPanel(pid, kind, value)` | Applies `lever` / `span` / `rise` (calls `setLever` / `setArch`) and returns that plaque's mirror readout (`readout(plaque)` shape). No ownership or range check beyond the kiosk clamps; glue checks ownership and phone ranges first. |
| `readout(plaque)` | The current mirror for `'loco'` (`{plaque, mph, rpm, text}`), `'bridge'` (`{plaque, span, rise, stands, marginMm, push, worstJoint, where, text}`) or `'hare'` (`{plaque, text}`), without changing anything. |
| `exportArch()` | Downloads the current arch as a binary STL (1:400) on the laptop and returns `{file, bytes, triangles, stands, marginMm, text}`. The TV's Export button and a phone's `export` both use it; glue enforces the 10 s cooldown for phones. |
| `onHotspot(cb)` | `cb(evt)` with `evt` one of `{type:'near', pid, plaque|null}`, `{type:'look', pid, plaque}` (verb at a plaque, or a mouse click on a plaque sprite as pid 0), `{type:'done', pid, plaque}` (Esc or the TV panel's close button), `{type:'walkoff', pid, plaque}` (owner beyond `WALK_OFF` for `WALK_OFF_MS`). |
| `sendTo(pid, msg)` / `sendAll(msg)` | Network; no-ops until glue assigns them. |
| `setOwner(plaqueId, pid|null)` | Opens or closes that plaque's panel on the TV with "Operator: name". The camera focus-frames a plaque only when exactly one plaque is owned. The TV panel's own sliders and Export work by mouse only while the keyboard (pid 0) operates it; while a phone operates it they are display-only and follow the phone. |
| `freeze(pid, on)` | Zero the figure's input and hold it in place (on Look grant). |
| `setLever(mph)` | 0 to 60; returns the loco mirror (`readout('loco')` shape, so `mph` and `rpm`; 60 mph reads about 240 rpm). |
| `setArch(spanFt, riseFt)` | Clamps to span 90 to 160 and rise 10 to 64 (the kiosk range; glue caps phones at 48) and returns the bridge mirror (`readout('bridge')` shape). |
| `setJudge(on)` | Judge-mode indicator on the stage ("Guided tour"); suppresses the attract loop. |
| `showOriginal()` | The untouched painting alone for 8 s (figures, plaques and panels hidden). |
| `reset()` | Figures to their start points, panels closed, owners cleared, Show the work back to the painting, lever 30 mph, arch 128 ft by 24 ft 3 in. Under 10 s. |
| `stats()` | `{fps, zoom, lean}` for the HUD. |

Keys: scene.js owns `←` `→` (walk pid 0), `Space`/`Enter` (Look, pid 0), `Esc` (done), `O` (original), `W` (Show the work), `M` (reduced motion), `` ` `` (path debug overlay), `G` (attract ghost). glue.js owns `H` (HUD), `J` (judge mode), `R` (reset), `Q` (hub fallback switch). Neither handles the other's keys.

Host page DOM: the TV is a fixed 1920 by 1080 frame scaled to fit the window: a 236 px left margin (title block and `#roster`), the stage (`#stage`, canvas plus in-stage panels), a 236 px right margin (`#modeTag`, `#hud`, `#qr`, `#resting`). glue.js renders only into `#roster`, `#hud`, `#qr` and `#resting`.

## Constants

Hotspot half-width 0.03, walk-off 0.08 held 300 ms, snap 0.03, figures walk t 0.15 to 1 (path-parameter units; with path.json's first point at u 0.05 the follow camera cannot frame a figure below t 0.15); follow zoom 1.0 to 1.35, focus zoom per plaque from path.json; lean up to 10 degrees, fading to 0 by zoom 1.8; the host zeroes input and freezes the figure on a Look grant, zeroes a phone's non-zero input when its 10 Hz heartbeat stops for 1 s, and releases a plaque 10 s after `away` (or after its own hub socket drops, if no replayed `join` comes back first). Phones may show the original on the TV once per 20 s globally. All in `src/shared/protocol.js`.

Plaque release rules (glue decides; the host never trusts a phone). A phone owner loses its plaque on Done, walk-off, 20 s without a panel input (not in judge mode), 90 s of ownership (180 s in judge mode), 10 s after `away` or after the host's own hub socket drops, a kick, or R; the phone gets `{t:'mode', mode:'walk'}` and a one-off readout naming why. The keyboard (pid 0) releases only on Esc, the panel's close button, walk-off or R. On every grant, `back` or replayed `join` the host re-sends the phone its mode and, for a plaque, its mirror readout.

Slot policy (B4, "Guided tour"). The cap stays at 6: a cap of 4 would also refuse the judge. Any phone idle for 90 s (no non-zero input, no panel message) is released with a kick (reason `idle`). Pressing J turns on judge mode: it kicks the longest-idle phones at once until two of the six slots are free (reason `judge`), keeps releasing phones that were already on the bank when J was pressed once they idle for 30 s, and exempts phones that join while it is on (the judges) from both idle releases. Plaque owners are exempt from idle releases (the ownership rules govern them). J again, or R, turns judge mode off. A kicked token is refused by the hub, so a kicked phone shows its end screen and rejoins only when the visitor taps Join again.

Exports. A phone's `export` (bridge owner only, once per 10 s globally) and the TV's Export button both download the STL on the exhibit laptop. Allow automatic downloads for the host page's origin in Chrome (Settings, Privacy and security, Site settings, Additional permissions, Automatic downloads) before the demo, or the second download raises a permission prompt over the stage.

## path.json

`public/path.json`: `{"image":"assets/turner-1920.jpg","points":[[u,v,h] × 8],"plaques":[{"id":"loco","t":0.26,"look":[0.68,0.47],"zoom":1.6},{"id":"bridge","t":0.58,"look":[0.58,0.40],"zoom":1.5},{"id":"hare","t":0.90,"look":[0.79,0.30],"zoom":1.0}]}`. `u` runs left to right, `v` bottom to top (texture UV); `h` is the depth (0 far, 1 near) baked at that point by the debug overlay, and figures and plaques use the curve's interpolated `h`, never a per-frame depth sample.

## Depth map

`public/depth/turner-depth.png`, written by `tools/depth.py`: Depth Anything V2 Small (Apache-2.0) on the scan, bilinear resize to the painting aspect, min-max normalised, `value = round(near × 65535)` with nearest = 65535, R = high byte, G = low byte, no gAMA/iCCP/sRGB chunks, 2 to 3 px blur before packing. The host decodes it once on the CPU into a float texture and displaces a 4 by 2.985 plane with 512 by 384 segments. Without the file the host falls back to the prototype's hand-authored placeholder depth, so the kiosk works at every commit.

## Sprites

`public/sprites/tophat.png`, `bonnet.png` (1024 by 384, four 256 by 384 frames: walk1, walk2, walk3, wave; warm black with a 2 px cream edge) and `tophat-accent.png`, `bonnet-accent.png` (white where the band or ribbon is, tinted per player). Loaded with `repeat.set(0.25, 1)`; missing sheets fall back to procedural canvas figures.

## Env

Hub: `PORT` (8080 on Fly and in dev, 80 for the laptop fallback), `HOST_TOKEN` (empty means no check, local only), `JOIN_URL` (the Vercel production URL on Fly), `ALLOW_ORIGIN` (CORS for `/healthz`), `WIFI_SSID`, `WIFI_PASS`, `LAN_IP` (fallback only, never on Fly), `NODE_ENV`. Pages: no env.

## Run it

Install the dependencies once.

```
npm install
```

Development: start the hub in one terminal and Vite in another.

```
npm run hub
```

```
npm run dev
```

On the laptop, open `http://localhost:5173/host.html?host=`. On a phone on the same network, open `http://<laptop LAN IP>:5173/join.html`. In dev, Vite serves the join page at `/join.html`; the hub serves the same page at `/`.

Demo: Vite builds `dist` and the hub serves it on port 8080. Open `http://localhost:8080/host?host=` on the laptop and `http://<laptop LAN IP>:8080/` on a phone.

```
npm run demo
```

Q fallback: starts the local hub on port 80, then the kiosk browser, using an uncommitted `.env`.

```
tools\start.cmd
```

Tests:

```
npm test
```

Export the arch as an STL. These are the span and rise of Brunel's Maidenhead arch.

```
node tools/export-arch.mjs --span 128 --rise 24.25
```

Turn on the secret-scanning pre-commit hook, once per clone:

```
git config core.hooksPath .githooks
```

Hosting: the hub runs on Fly.io and the two pages on Vercel.

```
fly secrets set HOST_TOKEN=… JOIN_URL=https://<project>.vercel.app/
```

```
fly deploy
```

```
vercel --prod
```

## MUST list

These eight deliverables define Completion (from the PRD's Scope section). The ticks are filled in at each gate, from the results logged in `tests/gates.md`.

- [ ] M1 Kiosk: Turner's painting as a depth relief with mouse lean, three plaques usable by mouse and keys, Show the original, Show the work. Works at every commit with zero phones.
- [ ] M2 Hub: a Node relay on Fly.io Newark with a stable HTTPS URL, running the same code as the laptop's Q fallback. Tokens, slot hold, judge-mode slot reserve, rate limits, health endpoint.
- [ ] M3 Join page: works in any phone's browser. Tap a colour, hold-to-walk pad, one verb button, three plaque panels, reconnect, wake lock. Under 150 KB.
- [ ] M4 Figures: two cut-paper bodies in six accent colours walking one riverbank curve, depth-placed, never over the train, bridge or hare. Roster in the margin.
- [ ] M5 Follow camera: fits the group, zoom 1.0 to 1.35, translate-only pan, lean from the group, focus frame only when exactly one plaque is owned.
- [ ] M6 Plaques and ops: three brass plaques with Look, operator ownership and release rules, J judge mode, R reset under 10 s, Q fallback switch, network layer in Show the work.
- [ ] M7 Content and print: wall label, three cited cards, tent card with the join QR, pictogram card (cut on Saturday; the tent card carries the same three steps), attendant checklist, colophon, arch object label, dated reconstruction captions.
- [ ] M8 Submission: public repo from Fri 9:30 PM, README with dependency versions and the AI-tools table, LEARNING.md with timestamps, Devpost with video submitted by Sun 8:20 AM.

## Dependency versions

Node >= 18.14 (`engines` in `package.json`). Every package is pinned to an exact version; `package-lock.json` holds the rest of the tree.

| Package | Version | Kind |
|---|---|---|
| express | 4.22.3 | dependency (hub) |
| ws | 8.22.0 | dependency (hub) |
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
| (add any other tool the team uses) | | |

## Credits

The painting's record, the depth model, the type, the libraries and the sources: see [CREDITS.md](CREDITS.md).

## Learning

Each teammate's timestamped entries and the stranger-test log: see [LEARNING.md](LEARNING.md).
