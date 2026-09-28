# WINDY CITY DERBY — v2 build contract ("blow Jeff away")

v1 is live at https://blufoxmobile.github.io/Windy-City-Derby/ (read `CONTRACT.md` first — every v1 rule
still applies unless this file overrides it). Jeff played it on his iPhone and asked for:

1. **Swing by swiping.** Drag a finger across the plate to swing; *the faster the swipe, the faster (harder)
   the swing.* A big **SWING** button must also exist as an option in Settings.
2. **A realistic, SIDEWAYS batting stance** (closed/square stance like a real hitter — front shoulder to the
   pitcher), not a fox facing the pitcher. Jeff's reference: classic "open / square / closed stance" coaching
   photos. Default = square stance, feet parallel to the box line, knees bent, hands at the back shoulder,
   bat angled up and back, head turned to the pitcher.
3. **Realistic parks** — each instantly identifiable as Wrigley Field / Rate Field. Research with dimensions,
   colours and ranked identifiers: `scratch/research/parks.md`. READ IT.
4. **Models as realistic as possible** (rigged 3D foxes replace the flat sprites).
5. **Great sound effects.**
6. **The crowd does THE WAVE** when a hitter hits **3 home runs in a row**.
7. **Hitting one OUT OF THE PARK** must be possible and a huge moment.
8. At Wrigley, an out-of-the-park homer cuts to an **announcer in the broadcast booth**. This is an ORIGINAL
   fox broadcaster (thick-rimmed glasses, headset mic, loud sport coat) — **never Harry Caray**: not his name,
   face, likeness, signature glasses shape or catchphrases (no "Holy cow!", no "It might be, it could be…").
   Jeff approved an original character.
9. **AAA quality.** He wants to be blown away by the quality and realism.

## Hard rules (in addition to v1)
- Still **no MLB team names, logos, wordmarks, mascots, or sponsor brands** anywhere. Architecture, colours,
  street names, "Wrigley Field", "Rate Field", "Waveland", "Sheffield", "Fan Deck" are fine. Ad panels show
  BLUFOX MOBILE / fictional Chicago businesses / blank.
- Spell the company **Blufox**.
- Phones first: iPhone Safari (iOS 17+), 390×844 CSS px, DPR 3, inside an iframe on cookcountycooks.com too.
  **60 fps target on a mid-range phone**; quality tiers `high|medium|low` must all look good; `low` must be
  cheap. Watch draw calls (<~250 at high), triangles (<~1.5M at high), texture memory.
- Only edit files you OWN (table below). Scratch goes in `scratch/<you>/`. If you need a change in a file
  you don't own, put it in your final report as an exact patch or a precise instruction.
- `src/data.js` — park GEOMETRY (fence/stands/street/rooftops/scoreboard/videoBoards/fanDeck/booth/wells/
  palette) is FROZEN by the lead (just updated from the research). PLAY may edit TUNING, scoring,
  bonus, classifyLanding and add exports; nobody else edits data.js.
- Every asset may be missing → graceful fallback, never a hang, never a console error.
- **Zero console errors/warnings** in normal play. **Screenshot your own work and Read the PNGs.** Iterate
  until it looks genuinely great in portrait (390×844) and landscape (844×390). Assertions alone ship bugs.
- Higgsfield credits are real money. Each agent has a hard cap (below). Preflight with `get_cost:true`.
  Higgsfield project folder for ALL generations: `folder_id = 8a935128-e05f-4f04-8eaf-1e51f2bc0db1`.
  Higgsfield cannot make standalone music/SFX (policy) — sound stays procedural; speech (TTS) is allowed.

## Dev + test
- Repo: `/home/claude/wcd` (node_modules installed: three r169, esbuild). Serve it:
  `cd /home/claude/wcd && (python3 -m http.server 8765 >/dev/null 2>&1 &)` (check first: `curl -s localhost:8765 >/dev/null`).
- `dev.html` runs the real game unbundled. `?debug&autoplay=free&warp=4&park=wrigley&char=nova&name=Tester`
  auto-starts a round; `window.__wcd` exposes the game object in debug. `tools/playtest.py` drives a round
  headless (SwiftShader, slow — use `low` quality, warp 8). `tools/shot.py` screenshots any page.
  Harness pages go in `tools/harness/` (import map in `tools/harness/smoke.html`).
- Playwright + Chromium are installed (`/opt/pw-browsers`, `pip install playwright --break-system-packages`
  if the module is missing). Do not run `playwright install`.
- **This machine has only 2 CPU cores and 7 GB RAM, shared by 7 agents.** Headless Chromium (SwiftShader) is the
  bottleneck, so EVERY Chromium/Playwright run must be wrapped in the shared render lock and kept short:
  `flock /tmp/wcd-render.lock timeout 150 python3 tools/shot.py ...` (same for your own Playwright scripts).
  Close the browser at the end of every script. Iterate at `quality:'low'`/DPR 1 and small viewports; do final
  beauty shots at high. Never leave a server, watcher or browser running in the background (port 8765 is
  already served for everyone — don't start another).
- Don't run git commands that change state (no commit/checkout/reset/stash) — the lead snapshots.
- `node build.mjs` → `dist/index.html`. `node tools/sim-test.mjs`, `node tools/worker-test.mjs` must pass.

## World conventions (unchanged)
Feet. Home plate apex at origin, +Y up, CF = −Z, 1B/RF = +X. Spray: 0 = CF, −45 = LF line, +45 = RF line,
ground dir `(sin s, 0, −cos s)`. A right-handed batter (`bats:'R'`) stands on the −X side, faces +X
(toward the plate), front (left) shoulder toward the pitcher (−Z). Lefty mirrored.

## Ownership
| Agent | Owns | Credit cap |
|---|---|---|
| **PLAY** (input + sim + game loop) | `src/sim.js`, `src/ui.js`, `src/ui.css`, `src/game.js`, `src/data.js` (TUNING/scoring/bonus/classify only), `tools/sim-test.mjs`, `tools/sim-bots.mjs`, `tools/playtest.py` | 0 |
| **ACTORS** (3D foxes + animation) | `src/actors.js`, `src/assets.js`, `assets/manifest.json`, `assets/models/*`, `tools/harness/actors.html` | 330 |
| **WRIGLEY** | `src/parks/wrigley.js`, `assets/parks/wrigley/*`, `tools/harness/wrigley.html` | 30 |
| **RATE** | `src/parks/rate.js`, `assets/parks/rate/*`, `tools/harness/rate.html` | 30 |
| **CROWD** | `src/crowd.js`, `assets/crowd/*`, `tools/harness/crowd.html` | 20 |
| **CINEMA** (cameras, post, fx, booth announcer) | `src/camera.js`, `src/fx.js`, `src/render.js`, `src/booth.js` (new), `assets/booth/*`, `assets/vo/*`, `tools/harness/booth.html` | 40 |
| **AUDIO** | `src/audio.js`, `tools/harness/audio.html` | 0 |
| lead | `src/stadium.js` (dispatcher), `src/main.js`, `src/shell.html`, `src/net.js`, `worker/*`, `build.mjs`, integration | — |

New assets: put files under your folder and list the manifest entries you need in your final report (and in
`scratch/<you>/manifest-add.json`); ACTORS owns `assets/manifest.json`, the lead merges the rest.

## Interfaces (exact — integration depends on these)

### Swing (PLAY ↔ ACTORS ↔ sim)
UI emits `onEvent('swing', { aim, t, batSpeed, uppercut, via })`:
- `t` = `performance.now()` when the swing STARTS (swipe recognised / button pressed).
- `batSpeed` ∈ [0,1] from the swipe speed (0 = lazy, 1 = max effort). Button mode sends a fixed 0.72.
- `aim` ∈ [−1,1] field direction (−1 LF line … +1 RF line) — from where the swipe starts/crosses (PLAY decides
  the exact mapping; keep the PULL / CENTER / OPPO lanes readable).
- `uppercut` ∈ [−1,1] from the swipe's vertical angle (level swipe = 0; upward = loft).
Sim: `resolveSwing(pitch, { tapT, aim, batSpeed = 0.72, uppercut = 0 })` where `tapT` = game-seconds since
release when the swing STARTS. Contact time = `tapT − inputLatencyComp + swingLeadFor(batSpeed)`.
`export function swingLeadFor(batSpeed)` (sim.js) — fast swings reach the zone sooner (≈0.20 s slow → ≈0.09 s max;
PLAY tunes). SwingResult gains `{ batSpeed, leadT, outOfPark:boolean }`. Faster swing = more exit velocity and a
slightly less forgiving sweet spot. Keep the game learnable and fair; recalibrate bots.
Actors: `actors.swing({ batSpeed, leadT, aim, uppercut, pitchLoc:[px,py] })` — **the bat must meet the ball
exactly `leadT` seconds after this call** (it's the contact frame), swing speed visibly scales with `batSpeed`.
`actors.swing()` with no args must still work (leadT = `swingLeadFor(0.72)`).

### Round events (PLAY)
`round.apply(result)` also returns `events: string[]` — at least `'wave'` (the swing that makes the streak
exactly 3, and again at 6 and 9) and `'outOfPark'`.

### Stadium (each `src/parks/<park>.js` → `build<Park>Stadium(THREE, opts)`; `src/stadium.js` dispatches)
Same v1 API (`attach, detach, update, setBoard, celebrate, setCrowd, sunDir, info, dispose`, `lights`) PLUS:
```js
wave({ fromSpray, laps }) → seconds        // delegates to crowd.wave(); the whole bowl + bleachers (+ rooftops) ripple
outOfPark({ spray, distance, landing:[x,y,z], bonus }) // park-specific spectacle (Wrigley: ballhawks scramble on Waveland/
                                           //  Sheffield, rooftop fans erupt; Rate: pinwheels spin + fireworks barrage)
landmarks: { booth: { pos:[x,y,z], look:[x,y,z] } | null, street: [x,y,z] | null, boards: [...] }
crowd                                      // the Crowd object (below)
```
Honour `data.js` exactly: `fenceDistance()`, `surfaceHeight()`, `scoreboardDistance()`, `PARKS[p].videoBoards`
(boards the ball can hit), `fanDeck`, `wells`, `booth`. Balls come to rest on the surfaces the sim says.
Start from your park file — it is currently a verbatim copy of the v1 stadium (both parks); strip the other park
out and rebuild yours for realism. Field surface/sky/lighting/fog/flags/fireworks code is yours to improve too.

### Crowd (`src/crowd.js`) — API FROZEN (a working stub is already in the file)
```js
createCrowd(THREE, { parkId, quality, look:{ crowd, crowdShade, night }, assets }) → Crowd
Crowd: { addRow(p0, p1, { spacing, fill, kind, facing, section }), addFan(x,y,z,{ facing, kind, section }),
  build() → Object3D, update(dt,t), setExcite(0..1), flash(spray), wave({ fromSpray, laps, speed }) → seconds,
  celebrate({ spray, big }), count, dispose() }
```
kind 0 = sunlit, 1 = shaded, 2 = always standing (street ballhawks, rooftop decks). Park builders register every
seat row with `addRow` (y = seat surface height) and add `crowd.build()` to their group.

### Camera / cinema (CINEMA)
`director.setMode('outOfPark', { result, landmarks, parkId })` — the ball-leaves-the-park shot (chase the ball over the
bleachers, land on Waveland/Sheffield/rooftops, or out over Rate Field's concourse into the lot).
`director.setMode('wave', { fromSpray })` — a sweeping crowd shot for ~2.5 s (used between pitches after 3 straight).
`director.setMode('booth', { pos, look })` — optional 3D push-in on the Wrigley booth windows.
`src/booth.js`: `createBooth(root /*UI root element*/, { assets, audio }) → { show({ parkId, bonus, distance, name }) → Promise<void>, hide(), dispose() }`
— picture-in-picture "BOOTH CAM" broadcast cutaway with the original fox announcer (animated painted frames from
Higgsfield) and a voiced call (Higgsfield TTS clips, 3–6 lines, e.g. street / rooftop / scoreboard / generic).
At Rate Field use a PA-announcer voice line + a board takeover instead of the booth fox.
`render.js`: better tone mapping/colour grade, bloom that suits night games, optional FXAA/SMAA, all tiered.

### Audio (AUDIO) — procedural, far more realistic
Existing names keep working. `sfx('bat_sweet'|'bat_solid'|'bat_weak', { batSpeed, quality })` scales with bat speed.
Add: `'wave_swell'` (crowd "whoooOOOA" travelling around the bowl, ~6 s), `'out_of_park'` (massive roar + echo off
buildings + car alarm/ballhawk shouts at Wrigley), `'swing_whoosh'` ({ batSpeed }), `'pinwheels'`, `'ballpark_bell'`.
`playClip(key, { gain, duck })` — play a decoded clip from `assets.buffer(key)` (voice lines), ducking crowd/music.

### Assets (ACTORS owns `src/assets.js`)
Add to the Assets store: `buffer(key) → ArrayBuffer|null` (audio/binary entries), `model(key) → Promise<gltf|null>` or
equivalent lazy GLB loading (only load the chosen hitter + the pitcher), `load(key) → Promise` for lazy keys.
Manifest entry types: images as today; `{ "src": "...glb", "type": "model", "lazy": true }`; `{ "src": "...mp3|m4a|ogg", "type": "audio" }`.
Use iOS-safe audio formats (AAC .m4a or .mp3). GLBs: meshopt/quantized, WebP textures ≤1024², target ≤1.5 MB each.

## Definition of done (every agent)
- Your module works in the real game (`dev.html`) and in your harness; no console errors; screenshots in
  `scratch/<you>/` that you have LOOKED AT, portrait + landscape, day + night where relevant.
- Performance measured (draw calls, triangles, ms per frame in your harness at high and low).
- Final report: what you built, how to use it, exact integration notes for the lead, manifest entries,
  proposed changes to files you don't own, credits spent, known issues.
