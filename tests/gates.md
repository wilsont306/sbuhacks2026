# Gate checklists

One person runs, one witnesses. Start the stopwatch at the first step and stop it at the last. Tick each line only when it passes on the demo laptop or a real phone, not in a dev tab. Every gate is checked from the Vercel URL on a phone on cellular, not Wi-Fi, unless a line names the laptop hub. Write the result and any failure in Notes, then commit this file straight after the gate.

Criteria are quoted from the v2 build plan. The gate lines come from its Milestones section. The numbered lines come from the Acceptance column of each step row due by that gate, and the degraded-state table from its Step 0. The plan's Repo findings decision (Sat about 5 AM) overrides its older rows. Fly is dropped, so every F line, row 1.10 and the Fly image are void and appear struck through below. Q is the only fallback: the laptop hub over the hotspot, running the same `hub/relay.js`.

The Gate D lines, the degraded-state table and the 11 PM run were rewritten Sat evening to name the keys and on-screen text the code uses (README "window.game" and "TV modules and the phone page"). Where the plan's wording differs from the code, the line says so in brackets. Three gaps block lines below until they are filled. `public/sfx/` is not made yet, so the palette is silent and unflashed (run `tools/sfx.mjs`). Sample 3, Starry Night, is not in the repo, so key 3 does nothing (`public/samples/README.md`). `src/shared/learning.json` has no entries.

## Gate C, Sat 2:00 PM

| Field | Entry |
|---|---|
| Runs (N) | |
| Witnesses (T) | |
| Start | |
| Stop | |
| Deployment URL and commit | |
| Phones used (model, browser, network) | |

Row 1.11: integration 1:00 to 1:30 on the deployed relay, then this run 1:30 to 2:00 (two phones on cellular, the 12-tab broadcast, one rollover, Q).

Gate line:

- [ ] A stranger's phone on cellular opens the Vercel URL, taps a colour and walks a card
- [ ] A second phone joins
- [ ] One rollover passes with no visible change (a socket rolls 240 to 270 s after it opens; `?roll=20000` on a tester's own tab forces one sooner)
- ~~F moves phones through Fly~~ (void)
- [ ] Q works (from a kiosk whose host page is served by Vercel, too: if Chrome asks to allow access to the local network for `ws://localhost`, allow it in the kiosk's own profile before the demo)

Step acceptances (M1):

- [ ] 1.1 The join page loads over cellular from the Vercel URL in under 3 s; the health endpoint answers (the plan names `/api/health`; today it is a plain GET of `/api/ws`, which should show `"bus":"redis"`). Seconds:
- [ ] 1.2 A phone on cellular round-trips an echo in under 150 ms (the H HUD shows each phone's rtt); go/no-go at 8:30. Red: ~~Fly stays primary~~ Q becomes the live path (Fly void). ms:
- [ ] 1.3 A phone on the hotspot moves a figure through the laptop hub; a hub restart brings the phone back without a tap; the stale-socket test passes (a `gone` from the old cid after `hello` on the new one leaves the seat alone)
- [ ] 1.4 Twelve tabs on the production URL receive one `all`; two phones on cellular move two figures. The plan also asks for "instance ids differ in the hb", but the relay's `hb` no longer carries an id, so write down how this was checked. How:
- [ ] 1.5 A phone walking 7 minutes shows no stall over 1 s across the rollover and never flips to held (away)
- [ ] 1.6 The join page is readable at arm's length; no raw hex outside `tokens.css`
- [ ] 1.7 A phone taps a colour and the host receives hello, in and verb on the laptop hub
- [ ] 1.8 A relay restart repopulates the roster within 5 s; a phone that sleeps 10 s gets the same colour; ~~F and~~ Q changes the QR within 5 s
- [ ] 1.9 With Wi-Fi off, the arrow keys walk a figure at 60 fps, 1080p, pixel ratio 1; no console errors
- ~~1.10 F key moves two phones through Fly~~ (void)

Miss rule (the plan's cut, adapted because Fly is void): Q, the laptop hub over the hotspot, becomes the default path, and the same three places change: beat 1's spoken line, the W platform layer, the credits card. Decided at 2:00, not later. T and N eat 2:00 to 2:30.

Result: - [ ] Pass - [ ] Fail

Notes:

## Gate D, Sat 5:30 PM

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |
| Deployment URL and commit | |
| Phones used (model, browser, network) | |
| Images used | |
| Gemini calls used (budget 10) | |

Row 2.12: the run is 5:00 to 5:30 (T, N, G), and the script must pass twice.

Each pass runs the same five lines.

- **Picture to relief.**
  - From the laptop: drop the Starry Night file anywhere on the TV window (a dashed "Drop the picture: Google Gemini will read it" shows while dragging), or press U and pick it. The TV shows it flat with "Reading the artwork…".
  - From a phone: tap Add artwork and photograph a postcard. The button reads "Sending…", then the toast "On the TV in a moment", and the TV shows "Opening a picture from a phone…".
  - Either way, the relief appears within 15 s.
- **Motion.** At least three objects move by kind (sway, drift, bob, spin, fly, flicker or twinkle) [plan: "layers"].
- **Walking.** A figure walks the ground path, and at an object the phone's verb reads "Poke the <label>".
- **Poke.** A phone poke pops the object (a 1 s pop and glow), and the phone toasts "You poked the <label>". The right margin flashes "poke · <file> · ElevenLabs". `<file>` is the kind's palette file, which is `poke.mp3` only for ground and object kinds, or "<label> (made for this artwork)" once `/api/sfx` has made one [plan: "with `poke.mp3`"].
- **Save.** The right margin's badge goes from "saving…" to "Saved to Snowflake", and `curl https://<project>.vercel.app/api/projects` shows the id. The id is also on H's HUD line `layer … · saved <id>`.

Gate line, first pass:

- [ ] Picture to relief within 15 s. Seconds:
- [ ] Motion
- [ ] Walking
- [ ] Poke
- [ ] Save

Gate line, second pass:

- [ ] Picture to relief within 15 s. Seconds:
- [ ] Motion
- [ ] Walking
- [ ] Poke
- [ ] Save

Step acceptances (M2):

- [ ] 2.1 By 8:45 both fixtures validate (at most 8 objects, masks, `ground_path`) and the mask frame is written down
- [ ] 2.2 The spike table is in LEARNING.md, the decision is written down, and `GEMINI_MODEL` is set (the plan says `MODEL`). Rule: at least 4 of 6 images with 3 or more usable masks and P50 under 10 s means polygons, else boxes-only
- [ ] 2.3 Built as the mask-depth relief (Repo findings item 3) instead of cutouts. At the rest camera the fixture looks like the flat painting, and a lean (mouse) shows parallax. 60 fps. A broken mask falls back to its box without a console error.
- [ ] 2.4 Standing at the cypress, the phone's verb reads "Poke the cypress" (there is no grant: any figure may stand there). The verb pokes once per press with a sound and the margin flash. M quarters every amplitude [plan: "halves"].
- [ ] 2.5 With the Gemini key pulled, a drop still shows a walkable flat stage with "Couldn't read this one; walking on the flat painting" for 6 s
- [ ] 2.6 Drop to flat under 1 s, to the relief under 15 s. The badge reads "Saved to Snowflake" (green) within 30 s, or "local only" after the last poll at +30 s [plan: "local, saving"; the code shows "saving…" then "local only"].
- [ ] 2.7 curl with Starry Night returns a valid scene, P50 under 10 s; with the key removed it returns `scene:null` in under 2 s; a malformed answer still returns 200
- [ ] 2.8 A judge's photo from their own phone over cellular is the relief on the TV in under 15 s. A judge in judge mode must have joined after J, or the phone hears "Pictures are paused for the guided tour". A failed read stays on the phone with "Couldn’t read that one; try another picture" (busy and quota have their own lines), and the TV keeps its scene [plan: "a failed read shows it flat"; only a laptop drop does].
- [ ] 2.9 Every generated string carries an AI mark: the chip "AI draft, not a museum record", "(AI label)" in the stage hint, "AI guesses" over the legend, "(AI guess)" on the original's tag. Hand-corrected samples read "AI draft, hand-corrected (sample)". Nothing is styled to look like the painting. X hides the AI labels and shows "AI labels hidden".
- [ ] 2.10 All three samples load in under 2 s with Wi-Fi off, via keys 1, 2 and 3 [sample 3 is not in the repo yet, so key 3 does nothing until it is added]
- [ ] 2.11 The figure sprites are identifiable from 3 m, tinted in six accents, with no white fringe [`public/sprites/` is not in the repo yet, so the procedural figures draw]

Miss rule: boxes-only at 2 PM if the spike said so; behaviours reduced to sway, drift, bob and none; phone capture dropped at 4 PM, and the laptop drop with the postcard tray becomes the live path.

Result: - [ ] Pass - [ ] Fail

Notes:

## Gate E, Sat 8:00 PM (feature freeze)

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |
| Deployment URL and commit | |
| Gemini calls used in the stranger test (budget 12) | |

Gate line:

- [ ] Feature freeze: anything not clean is off the tent card and out of the script. Taken off:
- [ ] "Repo public" re-checked from a logged-out browser

Step acceptances due by 8 PM. Sound (M3, hooks 5:30 to 7:00 PM):

- [ ] 3.1 Join, poke and appear exist by 10:45 AM; total under 1.5 MB; spend logged
- [ ] 3.2 A second call for the same label answers in under 300 ms; with the key removed it returns `{url:null}` and the host keeps the default
- [ ] 3.3 Every join, appear and poke sounds and flashes; mute survives R and a reload; the TV never waits on audio
- [ ] 3.4 "sound: elevenlabs.io" is in all five places (Devpost title or tagline, video title, title block, colophon, README); `SOUND_GEN=on` from the 5 PM redeploy and left on; the counter caps spend

Save and gallery (M4, by 6:30 PM):

- [ ] 4.1 Snowflake `SELECT 1` and `INSERT ... SELECT PARSE_JSON(?)` both returned 200 by 9:15 AM (the hard checkpoint; with no 200 at 11:00, Snowflake drops to the local mirror and leaves the script)
- [ ] 4.2 The list answers in under 2 s warm; with `SNOWFLAKE_*` removed it returns `[]` with 200 and save is a no-op
- [ ] 4.3 Offline, the gallery still lists today's drops and reloads them
- [ ] 4.4 A judge's scene shows a green badge within 30 s; a failed insert shows "local, saving" and no error [the code shows "saving…" then "local only"]
- [ ] 4.5 The G gallery reloads a project in under 5 s with no Gemini call; with the Snowflake key removed it shows the local list and "local only"
- [ ] 4.6 The first gallery open after 10 idle minutes takes under 3 s

Table-ready (M5, before 8 PM):

- [ ] 5.1 W cycles from a fresh load; one W press shows all four platforms live [the code needs three W presses from the painting view to reach Network and its platform panel]
- [ ] 5.2 With six testers, J frees a slot within 5 s; no visible error in any test (two rollovers; Redis down shows the designed message and ~~the F drill~~ the Q drill; a host reload mid-demo)
- [ ] 5.3 Stranger test, 7:00 to 8:00 PM, on the Vercel URL over cellular, then the manual Q path: median scan-to-walk under 20 s and photo-to-layers under 15 s, or the fix list says why; Q under 5 s. Each recruit goes in LEARNING.md's stranger-test table. Medians:
- [ ] 5.5 Devpost saved with every field but Submit by 8 PM; insurance video on two devices
- [ ] 5.6 This file committed after each gate; the usage table below filled at 1 PM and 5 PM

Miss rule: anything not clean is off the tent card and out of the script.

Result: - [ ] Pass - [ ] Fail

Notes:

## Key pulls, Sat 10:00 PM

| Field | Entry |
|---|---|
| Runs (N) | |
| Witnesses | |
| Start | |
| Stop | |

Row 5.8, on N's `vercel dev`, after the fix window (row 5.7, 8:00 to 10:00 PM). Pull one thing at a time and check the TV, the phone and the attendant's move against the degraded-state table below, then restore it. If `vercel dev` does not upgrade `/api/ws`, run `npm run hub` beside it and add `hub=localhost:8080` to both pages' queries.

- [ ] 5.7 Every stranger-test defect is closed or written off on the card
- [ ] Gemini key pulled: matches the Gemini row
- [ ] ElevenLabs key pulled: matches the ElevenLabs row
- [ ] Snowflake variables pulled: matches the Snowflake row
- [ ] Redis down (`REDIS_URL` pointed at a dead address, or the relay stopped): matches the Redis or WS function row
- [ ] Laptop uplink off: matches the Laptop uplink row
- [ ] No phone joins: matches the No phone joins row
- [ ] Everything restored; one drop, one sound and one save checked again
- [ ] No visible error in any state, and no console error

Result: - [ ] Pass - [ ] Fail

Notes:

## Degraded-state table

What the 10 PM pulls and the 11 PM run check against: the plan's Step 0 table, with the TV and Phone columns rewritten to the text the code shows. The relay row follows the decision: press Q, not F.

| Pull | TV | Phone | Attendant |
|---|---|---|---|
| Gemini | A drop shows the picture flat with "Couldn't read this one; walking on the flat painting" for 6 s, walkable. Over quota: "The artwork reader is resting; press 1, 2 or 3 for a sample" | Add artwork toasts "Couldn’t read that one; try another picture" (quota: "The artwork reader is resting; try a sample on the TV"); nothing reaches the TV | Offer key 2 sample |
| ElevenLabs | Nothing visible; the palette plays, and the flash names the palette file, for example "poke · water.mp3 · ElevenLabs" | none | none |
| Snowflake | Right-margin badge "local only" (at the first poll, +3 s, when the env is gone). Gallery store line "Local only: Snowflake is not set up here" (or "… is not answering"), cards "Local only" | none | Point at the Snowsight tab |
| Redis or WS function | The resting panel "This exhibit is resting. Please use the keyboard." 2 s after the socket drops; press Q; hotspot QR | "Reconnecting…", then "The screen is resting" | Press Q, hand the spare phone |
| Laptop uplink | Press Q; hotspot QR (with `WIFI_SSID`). A drop reads "Couldn't read this one; walking on the flat painting", the gallery "Local only: Snowflake is not answering", and only palette sounds play | Add artwork is hidden (the laptop hub serves http) | Run the 60-second cut |
| No phone joins | Keyboard player pid 0 and samples (keys 1, 2) | none | Spare pre-joined phone at 8 s |

The plan's designed texts that are not in the code:

- Gemini row: "+ reason" (the TV shows one line per reason family, not the reason code) and the phone's "Sent; the TV shows your picture flat".
- ElevenLabs row: a flash that says "palette".
- Redis row: "Relay switching, rescan the code" and "Rescan the code".
- Laptop uplink row: "Samples only on this network".

## 11 PM production run, Sat

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Stranger (first name only) | |
| Start | |
| Stop | |
| Deployment URL and commit | |

Row 5.8: the whole script, two rollovers in a 12-minute connection, a hub kill, ~~F~~, Q, and a stranger trying to break it for 3 minutes; freeze tag by midnight with `SOUND_GEN=on`; production pinned.

The six-beat demo, under 3 minutes, with the criterion word at each transition:

- [ ] 0:00 Join.
  - The TV shows sample 1, the Turner, with the chip "AI draft, hand-corrected (sample)"; boot and R load it. Press 3 for Starry Night once it is added [plan: "the Starry Night sample"].
  - The ghost figure strolls the path (A toggles it).
  - The attendant presses J ("Guided tour" in the top-right tag) and points at the tent card.
  - The judge taps a colour, sees "You are <name>", and their figure walks. At 8 s of fumbling the pre-joined spare phone comes out without comment. The judge joins after J, so their phone may send a picture.
  - "Vercel WebSockets, fanned out by Upstash Redis."
- [ ] 0:30 Scan.
  - Phone: the judge taps Add artwork and photographs a postcard or sketch card. The button reads "Sending…", then the toast "On the TV in a moment" gives way to "Your picture is on its way to the TV", and the TV shows "Opening a picture from a phone…". Or the attendant drops a file (or presses U) and the TV shows it flat with "Reading the artwork…".
  - The relief unfolds raw from Gemini, with the chip "AI draft, not a museum record" and the badge "saving…".
  - They walk to an object (the verb reads "Poke the <label>") and poke it. It pops and sounds, the phone toasts "You poked the <label>", and the margin flashes "poke · <file> · ElevenLabs".
  - "Gemini reads the painting into a scene description our renderer builds. The sound is ElevenLabs." Completion.
- [ ] 1:30 Gallery.
  - Press G. The header reads "Gallery" and "Titles are AI guesses. Arrows choose, Enter opens, Esc closes.", and the store line reads "Saved projects from Snowflake, and this laptop".
  - The judge's project is first. If its card's badge reads "Saved to Snowflake", say "saved to Snowflake"; otherwise point at an earlier judge's card with that badge.
  - Arrows and Enter reload one in under 5 s.
  - Snowsight query history on the second laptop.
- [ ] 2:00 Technology.
  - W cycles Painting view, Depth map, Exploded layers and Network, each named in the top-right tag.
  - Network shows the platform panel over the stage bottom, live: Vercel (relay region, instance id, bus Upstash Redis), Gemini (model and read time), ElevenLabs (played, generated, cached) and Snowflake (project id and its badge).
  - The legend ("AI guesses") is always in the left margin.
  - The judge's own rtt is on H's HUD; the platform panel has no RTT line [plan: "legend and the platform layer with the judge's own RTT"].
- [ ] 2:30 Learning: L opens "Learning: what surprised us", one timestamped receipt per teammate from `src/shared/learning.json` (empty today: the overlay only says where to add entries); or the back of the credits card. L closes it.
- [ ] 2:50 Close: O shows the original for 8 s with "Original. <credit>" (Esc hides it); "You just walked into it."; R resets. Figures return to their starts, sample 1 comes back with the reset sound, the phones' verbs read "Walk to something" again, and judge mode is off.

Robustness:

- [ ] Two rollovers inside one 12-minute connection, on a phone and on the host, with no visible change
- [ ] Hub kill: on Q, close the laptop hub's window and start it again; every phone comes back without a tap
- ~~F moves phones through Fly~~ (void)
- [ ] Q, then back to the Vercel relay
- [ ] A stranger tries to break it for 3 minutes. What broke:
- [ ] 5.4 A teammate who did not write it runs the script from the card in under 3:30. Time:
- [ ] No visible error in any state
- [ ] Freeze tag pushed by midnight with `SOUND_GEN=on`; production pinned; no pushes after midnight. Tag:

Result: - [ ] Pass - [ ] Fail

Notes:

## The 60-second cut

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |

For when the laptop uplink fails (its row above says run it) or the table runs out of time. Never a live scan.

- [ ] 10 s: the spare, pre-joined phone joins
- [ ] 20 s: the key 2 sample and a poke
- [ ] 15 s: the W platform layer (three W presses to Network)
- [ ] 10 s: one Learning line (L)
- [ ] R

Result: - [ ] Pass - [ ] Fail

Notes:

## Sunday, Oct 25, 7:00 to 9:00 AM

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |
| Gemini calls used (budget 20) | |

Row 5.10. No redeploy on Sunday.

- [ ] Plugged-in run from the Vercel URL
- [ ] Three stopwatch rehearsals under 3:30. Times:
- [ ] Judge mode on by default
- [ ] Quotas checked at 7:45 (the usage table); no service above 70 percent of a free cap
- [ ] Final video uploaded by 8:00
- [ ] D presses Submit at 8:20
- [ ] The submission and the public repo link open from a logged-out second phone at 8:30
- [ ] Cellular check at 8:45
- [ ] Hands off at 9:00; no redeploy
- [ ] Kit (row 5.6): a small USB speaker, the pre-joined spare phone, the TV settings list, the Q drill done
- [ ] After judging (Sunday afternoon): the Wang Center images' blobs and rows deleted

Acceptance: the submission opens from a second phone; three runs under 3:30.

Result: - [ ] Pass - [ ] Fail

Notes:

## Usage

Row 5.6: read at Sat 1 PM, Sat 5 PM and Sun 7:45 AM. On Sunday morning no service may be above 70 percent of its free cap.

| Service | Free cap | Sat 1 PM | Sat 5 PM | Sun 7:45 AM |
|---|---|---|---|---|
| Upstash Redis commands | 500K a month | | | |
| Gemini calls | the daily quota read at 7:15 (budget: spike 12, Gate D 10, stranger test 12, Sunday 20; resets 3 AM Eastern) | | | |
| ElevenLabs credits | 10,000 | | | |
| Vercel Function invocations, Active CPU, Provisioned Memory | 1M, 4 CPU-hours, 360 GB-hours a month | | | |
| Vercel Blob uploads (advanced operations) | 2,000 a month | | | |
| Snowflake credits | the trial balance in Snowsight | | | |
