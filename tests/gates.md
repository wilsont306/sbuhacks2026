# Gate checklists

One person runs, one witnesses. Start the stopwatch at the first step and stop it at the last. Tick each line only when it passes on the demo laptop or a real phone, not in a dev tab. Write the result and any failure in Notes, then commit this file straight after the gate. Gate C criteria are quoted from `stage-2-kickoff.md`, Gates D1 and D2 from the PRD's Stages and gates table, and the 11 PM run from the PRD's Stage 5 row and demo script.

## Gate C, Sat 1:00 PM (15 minutes)

| Field | Entry |
|---|---|
| Runs (N) | |
| Witnesses (G) | |
| Start | |
| Stop | |
| Phones used (model, browser, network) | |

- [ ] One iPhone and one Android on cellular scan the TV QR, tap a colour, and both figures walk the bank via `window.game`.
- [ ] The camera widens to fit both and never shows the stage background on a lean.
- [ ] Look at a plaque sends `{t:'mode'}`; the phone shows a placeholder panel; Escape returns.

Miss rule: coloured dots replace sprites and T moves to the camera; the plan does not otherwise change.

Result: - [ ] Pass - [ ] Fail

Notes:

## Gate D1, Sat 5:00 PM

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |
| Phones used (model, browser, network) | |

Criterion: "M2 to M6 from a visitor's phone through Fly (join, walk, follow, Look, bridge sliders, Export on the laptop, J and R), then on the Q fallback with the laptop offline."

Through Fly, from a visitor's phone:

- [ ] Join
- [ ] Walk
- [ ] Follow
- [ ] Look
- [ ] Bridge sliders
- [ ] Export on the laptop
- [ ] J
- [ ] R

On the Q fallback, with the laptop offline:

- [ ] Join
- [ ] Walk
- [ ] Follow
- [ ] Look
- [ ] Bridge sliders
- [ ] Export on the laptop
- [ ] J
- [ ] R

Miss rule: the arch is off and 6:30 to 8 PM is the fix slot.

Result: - [ ] Pass - [ ] Fail

Notes:

## Gate D2, Sat 6:30 PM

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Start | |
| Stop | |

Criterion: "hare Original and all Show-the-work layers."

- [ ] Fig. 3 hare Original
- [ ] W: painting
- [ ] W: depth
- [ ] W: wireframe
- [ ] W: thrust line
- [ ] W: network
- [ ] Every layer carries its dated caption, and the FPS counter shows (H7)

Miss rule: the PRD gives none for D2. Anything not clean by Gate E (8 PM, feature freeze) comes off the table card.

Result: - [ ] Pass - [ ] Fail

Notes:

## 11 PM full run, Sat

| Field | Entry |
|---|---|
| Runs | |
| Witnesses | |
| Stranger (first name only) | |
| Start | |
| Stop | |

The four-beat demo, timed against the script:

- [ ] 0 to 20 s, the join: J pressed; a phone scans, taps a colour, and its figure drops onto the bank in that colour
- [ ] 20 to 70 s, Completion: walk right, the camera follows and fits both; at the viaduct plaque the rise goes up until it fails, back down until it stands; Export
- [ ] 70 to 110 s, Design: at the locomotive plaque the regulator reads about 240 rpm at 60 mph
- [ ] 110 to 140 s, Technology: W cycles painting, depth map, wireframe, thrust line, network layer with the input stream and round-trip time
- [ ] 140 to 165 s, Learning: LEARNING.md entries open on the second laptop
- [ ] 165 to 180 s, the close: Show the original from the phone; the painting stands alone

Robustness:

- [ ] Hub kill: "Killing the hub and restarting it brings every phone back without a tap" (J4)
- [ ] R returns everything in under 10 s (H7). Seconds:
- [ ] A stranger tries to break it for 3 minutes. What broke:
- [ ] Sound effects fire on their events, only if X3 shipped (X3)

Result: - [ ] Pass - [ ] Fail

Notes:
