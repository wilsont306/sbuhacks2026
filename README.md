# Living Blueprint: Toy Theatre

**Walk around inside any painting with your phone.**

Drop a picture on the exhibit screen, or photograph one with your phone: a painting, a postcard, a sketch on paper. The app reads it into a scene, builds a 3D depth relief of it on the TV, and turns every visitor's phone into a controller for a little cut-paper figure that walks through the picture. Stop at an object and your phone tells you what it is and can read it aloud. Tap **Step inside** and the painting folds into a small first-person 3D world on your phone.

Built at **SBUHacks 2026** (Stony Brook University, October 23–25).

**Built with:** JavaScript · Three.js · Vite · WebSockets · Vercel Functions · Upstash Redis · Google Gemini · Depth Anything V2 · Tripo 3D · ElevenLabs · Snowflake

## How it works

```
  picture ──▶ Gemini reads it ──▶ TV builds a depth relief ──▶ phones join by QR
                 objects,           custom shader, then          walk a figure,
                 outlines,          refined in-browser by        read and hear each
                 depth, captions    Depth Anything V2            object, step inside
```

1. **Read.** Google Gemini turns the image into a structured scene: named objects, their outlines, a depth guess and a short description of each. Every AI label is marked as a guess, and the original is one tap away.
2. **Stage.** The TV renders the scene as a depth relief in a custom Three.js shader. Once it's on screen, the TV's own browser runs **Depth Anything V2** (ONNX, in a web worker) to refine the depth, and **Tripo** generates 3D models of up to two standing objects.
3. **Play.** Visitors scan one QR code and their phone becomes a controller over WebSockets: a hold-to-walk pad and one action button. The figure walks a path through the picture, and the object it reaches glows and is described on the phone and in the TV's margin. **ElevenLabs** narrates on request and adds named sound effects.
4. **Step inside.** The phone rebuilds the scene as a *Tour Into the Picture*-style diorama: floor, walls and standing cut-outs, projectively textured from the painting, with the depth map as terrain. It shows the world in first person, with no extra AI call.
5. **Save.** Each project is stored in **Snowflake** for the TV's gallery.

Three hand-corrected samples ship in the repo and play with no network: Turner's *Rain, Steam, and Speed* (1844), Van Gogh's *The Starry Night* (1889), and a sketch drawn for the demo.

## Engineering highlights

- **Realtime relay on serverless.** Rooms, seats and tokens are held by the host tab, and the relay runs as a Vercel WebSocket function fanned out through Upstash Redis. The same relay code also runs as a local laptop hub, a one-key fallback for flaky venue Wi-Fi.
- **Machine learning in the browser.** The depth model runs client-side via transformers.js and ONNX Runtime Web, lazy-loaded in a web worker so it stays out of the initial page load.
- **Projective geometry for the inside view.** The diorama places a camera at the painting's horizon line and projects the painting onto the floor, back wall and cut-out planes.
- **Cost guards.** Every paid API (Gemini, ElevenLabs, Tripo) is rate-limited per hour and cached in Vercel Blob, and visitors can plug in their own API keys.
- **Tested.** Node `node:test` suites cover the relay, scene validation, geometry, depth, audio and every API function.

## Run it

Requires Node 20+.

```bash
npm install
npm run hub      # terminal 1: the relay on :8080
npm run dev      # terminal 2: Vite
```

Open `http://localhost:5173/host.html` on a laptop, then scan the QR code with a phone on the same network. Keys **1**, **2** and **3** load the samples, which work offline. To read new pictures, copy `.env.example` to `.env` and add a `GEMINI_API_KEY`. ElevenLabs, Tripo and Snowflake keys are optional.

For a single-machine demo, run `npm run demo` and open `http://localhost:8080/host`. Run the tests with `npm test`.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the full technical spec, covering the WebSocket protocol, HTTP API, scene format, TV and phone modules, environment variables, Vercel deployment, dependency versions and the AI tools used to build it
- [CREDITS.md](CREDITS.md): paintings, models, fonts, libraries and services
- [LEARNING.md](LEARNING.md): the team's hackathon learning log
