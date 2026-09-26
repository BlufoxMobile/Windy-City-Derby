# WINDY CITY DERBY — build contract

A mobile-first 3D home run derby for Blufox Mobile employees. Anthropomorphic fox
hitters, two real Chicago ballparks (Wrigley Field on the North Side, Rate Field on the
South Side), one-tap swings, 10 outs per round, a company-wide online leaderboard and a
daily challenge. Target: "Home Run Derby 2030" — AAA, cinematic, fast, fun on a phone in
a break room over store Wi-Fi. Explicitly NOT a sales game.

**Hard rules**
- three.js **r169** only (`node_modules/three`). Import as `import * as THREE from 'three'` and
  addons as `three/addons/...` (mapped to `node_modules/three/examples/jsm/`).
- Plain ES modules in `src/`. No frameworks, no npm runtime deps beyond three. No external
  network at runtime except the leaderboard Worker (`BOARD_ENDPOINT`) — no CDNs, no Google Fonts.
- **No MLB team logos, wordmarks, mascots or team names anywhere** (no "Cubs", "White Sox",
  no "C" logo, no Sox script). Park names and neighborhood/street names are fine
  (Wrigley Field, Rate Field, Waveland, Sheffield, North Side, South Side, Chicago skyline).
  Park colour palettes are in `data.js` — use those.
- Company name is spelled **Blufox** (never "Bluefox").
- Portrait phone is the primary target (390×844 CSS px, DPR 2–3). Must also work in landscape
  and on desktop. Touch + mouse + keyboard (space = swing, ←/→ = aim).
- 60 fps target on a mid-range phone. Everything must degrade gracefully (quality tiers).
- Every asset may be missing. Code must render something good without it (procedural fallback),
  and never hang on a loading screen. The first screen must be reachable WITHOUT a user gesture.
- `src/data.js` is the single source of truth for units, coordinates, characters, parks, pitches,
  tuning and dates. READ IT FIRST. Do not edit it; propose changes in your final report.
- Only edit the files you own (listed per module). Scratch files go in `scratch/<your-module>/`.

**World units = feet.** Home plate apex at the origin, +Y up, batting camera looks toward
center field = **−Z**. Screen-right during batting = **+X** = first-base / right-field side.
Spray angle: 0 = center, −45 = LF line, +45 = RF line. Ground direction for spray s:
`(sin s, 0, −cos s)`. Pitcher release point `RELEASE = [-1.8, 5.9, -54]`.
A right-handed batter (bats:'R') stands on the −X side of the plate, a lefty on +X.

## Dev + test

```
cd /home/claude/derby
python3 -m http.server 8765 >/dev/null 2>&1 &          # (already running — check `curl -s localhost:8765 >/dev/null`)
python3 tools/shot.py http://localhost:8765/tools/harness/<you>.html scratch/<you>/shot.png --w 390 --h 844 --wait 5000 \
        [--eval "js before wait"] [--eval-after "js after wait, result printed"]
```
Harness pages use an import map: `{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}`
(see `tools/harness/smoke.html`). Headless Chromium uses SwiftShader: WebGL2 works but runs
~1–5 fps, so drive time manually (call your `update(dt)` in a loop inside `--eval`) rather than
waiting on requestAnimationFrame. **Screenshot your own output and Read the PNG. Iterate until it
looks genuinely good — assertions alone ship bugs you cannot see.** Check both 390×844 portrait and
844×390 landscape.

`node build.mjs` bundles `src/main.js` → `dist/index.html` (+ copies `assets/`). You don't need it for
module work.

## Assets (`assets/manifest.json`, loaded by `src/assets.js`)

Keys (see `ASSET_KEYS` in data.js). Real art is being generated in parallel and may appear in `assets/`
while you work. Every key may be absent → your fallback must look good.

| key | what | format |
|---|---|---|
| `title_portrait`, `title_landscape` | key art with the WINDY CITY DERBY logo baked in | webp |
| `portrait_<charId>` | waist-up hero portrait, facing camera, transparent bg | webp RGBA |
| `swing_<charId>` | horizontal strip of **6 equal frames**, 3/4 BACK view of a RIGHT-handed batter: 0 stance, 1 load, 2 stride, 3 contact, 4 follow-through, 5 finish. Transparent. Lefties = mirror horizontally. | webp RGBA |
| `pitcher` | horizontal strip of 6 equal frames, FRONT view of the right-handed fox pitcher: 0 set, 1 leg kick, 2 stride, 3 release, 4 follow-through, 5 recover | webp RGBA |
| `sky_<park>_<day|dusk|night>` | wide (~21:9) backdrop beyond the outfield — sky + distant Chicago (no stadium in it) | webp |
| `tex_ivy`, `tex_brick` | tileable wall textures | webp |
| `tex_crowd_north`, `tex_crowd_south` | tileable crowd texture for the stands | webp |

Manifest entry shape: `{ "src": "file.webp", "w": 2048, "h": 512, "frames": 6, "anchor": [0.5, 0.93], "heightFt": 6.3, "contactFrame": 3 }`
(`frames/anchor/heightFt/contactFrame` only on strips; `anchor` = normalized foot point inside ONE frame).

## Module APIs (exact — integration depends on these)

### `src/data.js` — lead (done). Read it.

### `src/sim.js` — owner: SIM. Pure logic, no DOM, no three.js; must run in node.
```js
export function createRound({ charId, parkId, mode /*'free'|'daily'*/, seed /*number*/, conditions /*{timeOfDay,weather,wind:{mph,dir}}*/, date, personalBest /*ft or 0*/ }) → Round
Round: {
  charId, parkId, mode, outs, homers, score, streak, bestStreak, longest, pitchCount, over:boolean,
  nextPitch() → Pitch,                      // deterministic from seed; throws if over
  resolveSwing(pitch, { tapT, aim }) → SwingResult,   // tapT = game-seconds since release (raw tap time; sim adds swingLead & latency comp); aim ∈ [-1,1] field direction (−1 LF line … +1 RF line)
  resolveTake(pitch) → TakeResult,         // no swing
  apply(result) → { scoreDelta, callouts:[{text, points, kind}], out:boolean, roundOver:boolean, streak, mult },
  summary() → { score, homers, longest, outs, pitches, bestStreak, charId, parkId, mode, date, avgDistance, v:VERSION }
}
Pitch: { n, type, label, mph, flightTime /*game s, release→front of plate*/, plateLoc:[px,py], inZone,
  posAt(t) → [x,y,z]  /* t game-seconds since release; valid to flightTime+0.6 (continues to backstop) */,
  ring: { showAt, preLoc:[px,py], trueLoc:[px,py], snapAt }  /* read-ring assist timing (UI/actors draw it) */,
  clockRate(t) → number  /* game-clock multiplier at t (1 normally; <1 near the plate for readBonus hitters) */ }
SwingResult: { kind:'whiff'|'foul'|'grounder'|'popup'|'flyout'|'liner'|'homer', swung:true,
  timingErr /*s, + = late*/, timingLabel:'WAY EARLY'|'EARLY'|'PERFECT'|'LATE'|'WAY LATE',
  quality /*0..1*/, contact:'sweet'|'solid'|'jammed'|'off the end'|'topped'|'under'|'miss',
  exitVelo, launch, spray, distance /*projected ft*/, hangTime,
  contactT /*game s since release when bat meets ball*/, contactPos:[x,y,z],
  path: { pts: Float32Array /*[t,x,y,z]* at 1/60 s from contact to rest*/, apex:[x,y,z], landing:[x,y,z], hitBoard, clearedBoard, fenceT /*t when crossing fence radius or null*/ } | null,
  bonus /*key from PARKS[park].bonus or null*/ }
TakeResult: { kind:'ball'|'strike', swung:false }
```
Also export `simulateFlight(parkId, { exitVelo, launch, spray, conditions, from:[x,y,z] })` (used by tests/tools) and
`const SIM_SELFTEST` results in your report: a calibration table and bot balance numbers (see SIM brief).

### `src/render.js` + `src/stadium.js` — owner: STADIUM.
```js
// render.js
export function createRenderer(canvas, { quality:'high'|'medium'|'low' }) → R
R: { renderer, render(scene, camera), resize(cssW, cssH), setQuality(tier), quality, dispose(),
     beginFrame(dtSeconds) /* feeds the adaptive-quality watchdog */ }
// stadium.js
export function buildStadium(THREE, { parkId, timeOfDay, weather, wind, assets /*Assets*/, quality }) → Stadium
Stadium: {
  attach(scene), detach(scene),             // sets scene.background/fog/environment + adds meshes & lights
  update(dt, t),                             // crowd shimmer, flags, drizzle, fireworks, board animation
  setBoard({ name, homers, outs, score, lastFt, message }),   // CF scoreboard / video board contents
  celebrate({ spray, distance, bonus }),     // homer: fireworks (Rate Field every homer), crowd flash, board takeover
  setCrowd(level /*0..1*/),                  // crowd excitement → motion/brightness
  sunDir: THREE.Vector3, dispose()
}
```
The mesh must honor `fenceDistance()/surfaceHeight()/scoreboardDistance()` from data.js exactly
(balls stop on the surface the sim says). Shadows: one directional light, fitted around the infield.

### `src/actors.js` + `src/fx.js` + `src/camera.js` — owner: ACTORS.
```js
export function createActors(THREE, { scene, assets, charId, parkId }) → Actors
Actors: {
  startPitch(pitch) → { releaseIn /*s == TUNING.windupTime*/ },  // pitcher windup; ball appears at release
  setPitchTime(t, pitch),       // ball on pitch.posAt(t), spin, faint trail, read ring (pitch.ring), shadow
  swing(),                      // batter swing anim; contact frame lands TUNING.swingLead s after this call
  contact(result),              // at contactT: hit-stop spark/dust/bat-crack flash, then ball follows result.path (tracer arc)
  ballFlightT(tau),             // place ball along result.path at tau s after contact (game drives the clock, incl. slow-mo)
  settle(result),               // ball at rest (bounce/roll small), tracer holds, landing marker with distance
  take(result),                 // ball into the backstop/catcher pop
  reset(),                      // between pitches
  setCharacter(charId), update(dt, t), dispose()
}
export function createDirector(THREE, camera, { parkId, bats }) → Director
Director: { setMode('title'|'select'|'batting'|'follow'|'homer'|'result', opts), follow(result) /* track ball on path */,
  shake(amount), update(dt, t), resize(aspect), fovFor(aspect) }
// fx.js: particles, tracer, fireworks, confetti — used internally by actors & stadium via
export function createFX(THREE, scene) → { burst(kind, pos, opts), tracer(path, color) → handle, fireworks(pos, n), update(dt), clear() }
```
Batting camera: behind and slightly above home plate (catcher cam), framed so the pitcher, the
whole infield and the outfield wall/skyline are visible in portrait, batter large in the lower third.

### `src/audio.js` — owner: AUDIO. Procedural WebAudio only (no audio files).
```js
export function createAudio() → Audio
Audio: { unlock() /*call on first gesture; safe to call many times*/, muted, setMuted(b), setMusicOn(b),
  sfx(name, opts?), setCrowd(level 0..1), music(cue /*'title'|'batting'|'roundOver'|null*/), organ(riff /*'charge'|'walkup'|'homer'|'stretch'|'tension'*/),
  update(dt) }
sfx names: 'bat_sweet','bat_solid','bat_weak','foul','whiff','mitt','pitch_whoosh','homer_horn','fireworks',
  'crowd_roar','crowd_groan','streak','record','out','ui_tap','ui_back','ui_confirm','countdown','ding'
```
Chicago ballpark ORGAN is the soul: original riffs only (no copyrighted songs; nothing recognizable
as any team's song). Must be silent until unlock(); must never throw if WebAudio is missing.

### `src/ui.js` + `src/ui.css` — owner: UI. All DOM.
```js
export function createUI(root /*HTMLElement*/, { onEvent /*(type, payload)*/ , assets, characters, parks }) → UI
UI: {
  boot(progress /*0..1*/, label),
  title({ daily /*dailyConfig*/, best }),                 // → onEvent('play') / ('daily') / ('board') / ('settings')
  nameEntry({ name, district }),                          // → onEvent('name', {name, district})
  characterSelect({ selected }),                          // → onEvent('character', {charId})
  parkSelect({ daily, conditionsPreview }),               // free play park pick → onEvent('park', {parkId})
  intro({ park, conditions, char, mode }),                // "WRIGLEY FIELD · DUSK · WIND OUT TO LF 12 MPH" card, auto-dismiss → onEvent('intro-done')
  hud(state /* {outs, homers, score, streak, mult, pitchN, wind, name, charId} */), hideHud(),
  pitchCallout(pitch),                                    // tiny "FASTBALL 94" tag after release
  aim(value /*-1..1*/), armInput(on),                     // tap zone: on pointerdown → onEvent('swing', {aim, t: performance.now()})
  result(result, applied),                                // "452 FT · 111 MPH · 29°", PERFECT/LATE, callouts, BACK-TO-BACK ×1.5
  roundOver(summary, { submitting:Promise<board>|null }), // results + leaderboard + PLAY AGAIN / CHANGE FOX / HOME
  leaderboard(data, { tab /*'today'|'alltime'|'longest'*/, district }),
  toast(text), settings({ sound, music, haptics, quality }), hide()
}
```
Tap-to-swing: one tap anywhere on the play area. Thumb X position = aim (left third PULL/center/OPPO
labels depend on `bats` — for a righty the left side of the screen is PULL). Show three subtle aim
lanes along the bottom and a live aim marker. Keyboard: space/enter swing, arrows aim.
Never let banners cover the pitch path (the middle band between pitcher and plate).

### `src/net.js` + `src/assets.js` + `worker/worker.js` — owner: NET.
```js
// net.js
export function createBoard({ endpoint }) → Board
Board: { ping() → Promise<bool>, top({ board:'today'|'alltime'|'longest', date, district, limit }) → Promise<{ok, rows:[{rank,name,score,homers,longest,charId,parkId,district}], remote}>,
  submit(summary & {name, district}) → Promise<{ ok, remote, rank|null, boards }>, local: { best(), history() } }
// assets.js
export async function loadAssets({ manifestUrl='assets/manifest.json', onProgress, priority /*array of keys first*/ }) → Assets
Assets: { get(key) → HTMLImageElement|ImageBitmap|null, meta(key) → manifest entry|null, texture(THREE, key, {repeat, srgb}) → THREE.Texture|null, receipt: {loaded, failed, total, ms} }
```
Worker: Cloudflare module Worker + one KV namespace bound as `BOARD`. Endpoints `/ping`, `/top`, `/submit`.

### `src/game.js` + `src/main.js` + `src/shell.html` — owner: lead (integration, later).
