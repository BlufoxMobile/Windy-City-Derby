// ============================================================================
// WINDY CITY DERBY — SIM. Pure game logic: pitches, swings, ball flight, scoring.
// No DOM, no three.js. Runs in node (tools/sim-test.mjs, tools/sim-bots.mjs).
// Owner: SIM. Reads everything from ./data.js (single source of truth).
//
// Units: feet, seconds (GAME seconds — the game clock may run slower than real
// time near the plate for readBonus hitters, see Pitch.clockRate), mph for
// speeds shown to the player, degrees for angles. Axes: see CONTRACT.md
// (+Y up, center field = −Z, spray 0 = CF, −45 = LF line, +45 = RF line).
//
// Determinism: the pitch for (seed, n) comes from its own RNG stream and never
// depends on the character or on how earlier pitches were played; swing noise
// comes from a second stream seeded by (seed, n). Same seed + same inputs ⇒
// identical round, on any platform.
// ============================================================================
import {
  VERSION, OUTS_PER_ROUND, CHAR_BY_ID, CHARACTERS, PARKS, PITCHES, BREAKING, ZONE, RELEASE, TUNING, WEATHER,
  pitchMix, rampAt, fenceDistance, surfaceHeight, scoreboardDistance, classifyLanding, isOutOfPark, hashString, makeRng,
} from './data.js';

// ---------------------------------------------------------------------------
// SIM-local tuning. The flight constants REPLACE TUNING.dragK/liftK (the model
// is richer than one drag + one lift number); they were fitted to the SIM
// brief's distance table — see tools/sim-test.mjs. Exported as SIM_K so tools
// can read them. Game code must treat it as read-only.
// ---------------------------------------------------------------------------
const K = {
  // --- ball flight (v2 calibration, Statcast-like top end: 95@25≈326, 100@28≈367, 105@28≈400, 110@28≈433, 115@30≈464, 119@28≈491) ---
  dragK: 0.00172,       // quadratic drag (1/ft): a = −cd·|v_air|·v_air
  dragV: 0.75,          // cd × (1 + dragV·(1 − airspeed/100 mph)), clamped 0.45..1.8 (drag-crisis-like)
  dragEvExp: 0.3,       // cd × (EV/100)^−dragEvExp — squarely-hit balls carry a bit better (v1 0.64 over-carried 115+ mph)
  liftK: 0.00079,       // backspin lift (1/ft): a = liftK·spin·|v_air|² ⟂ v, in the vertical plane
  liftEvExp: 2.5,       // spin ∝ (EV/100)^liftEvExp
  liftLa: 0.03,         // spin × (1 + liftLa·(launch − 28°)), clamped 0.5..1.5
  spinTau: 11.3,        // s — spin decays as exp(−t/spinTau)
  windGain: 1.05,       // conditions.wind.mph × PARKS.windScale × windGain
  carryK: 2.0,          // cd × (1 − carryK·(WEATHER.carry − 1))  ⇒ carry ≈ distance multiplier
  dt: 1 / 240,          // integration step (RK2)
  sampleEvery: 4,       // → path samples at 60 Hz
  ballR: 0.12,          // ft
  bounceField: 0.34, bounceKeep: 0.7, rollDecel: 16, // grass: vertical restitution, tangential keep, roll decel (ft/s²)
  bounceWall: 0.3,
  maxPostTime: 3.2,     // s of bounce/roll after the first impact (ball is eased to a stop by then)
  // --- swing model (tuned with tools/sim-bots.mjs; see SIM_SELFTEST) ---
  // Aim is judged in "pull units" p = aim·pullSign (+1 = full pull, −1 = full oppo) against a band
  // that slides with the pitch's insideness i (+1 = inside edge of the zone, −1 = outside edge):
  //   p ∈ [bandSlope·i − W, bandSlope·i + W] (clamped to ±1) costs nothing — so center is always
  //   fine on a middle pitch — with W = bandW·aimTol/0.85: contact hitters (big aimTol) can pull a
  //   middle pitch into the corner, a slugger can't. Beyond it quality falls as exp(−(excess/(aimTol·aimK))²):
  //   pulled past it = rolled over / "off the end", too far the other way = "jammed".
  // idealAim() = the POWER aim inside the band: aimMargin in from the pull edge for pitches with
  // i ≥ aimSplit, in from the oppo edge otherwise (pull the middle-in pitch, go oppo with the away one).
  bandSlope: 1.35, bandW: 0.87, aimMargin: 0.24, aimSplit: 0, aimK: 0.63,
  qPow: 0.6,            // EV = evMin + (evMax − evMin)·Q^qPow + pitch EV (+ Skye's streak EV) + evBoost, then the knee (below)
  speedEv: 0.09,        // pitch EV: +mph per pitch-mph above 60 (fastballs come off the bat harder) …
  cookieEv: 2.7,        // … except a meatball, which sits up there to be crushed: flat +cookieEv
  evNoise: 0.5,         // mph sd at perfect contact (× (1 + 2.5·(1 − Q)))
  heightLaunch: 9.3,    // deg of launch per ft of pitch height above/below the zone middle …
  heightTolPow: 1.08,   // … × (0.85/aimTol)^heightTolPow (contact hitters flatten it out, sluggers don't)
  heightTol: 0.97,      // ft (× aimTol) — scale of the quality penalty beyond 3/4 of the half-zone height
  missLaunch: 48,       // deg — vertical mis-hit (topped / under) as contact → 0 …
  missPow: 0.64,        // … × (1 − Qm)^missPow, Qm = qt^(1−missMix)·exp(−(err/missWindow)²)^missMix·qa·qh:
  missMix: 0.49,        //   half the character's own timing quality, half the absolute error in seconds
  missWindow: 0.07,     //   (the bat is somewhere else in its arc when it's N ms off, whoever swings it)
  launchNoise: 2.85,    // deg sd at perfect contact (+ 6·(1 − Q))
  sprayPerAim: 28,      // deg of spray per unit of aim
  sprayTiming: 7.2,     // deg of pull (early) / oppo (late) per window of timing error
  sprayNoise: 2.5,      // deg sd at perfect contact (+ 7·(1 − Q))
  streakQPow: 4.6,      // Skye: streak EV × Q^streakQPow (the extra power shows on squared-up swings) …
  streakPost: 0.5,      // … × streakPost, added after the evKnee compression (so a 5-homer heater is ~+8.75 mph)
  chaseWhiff: 0.84,     // extra whiff probability per ft outside the zone (beyond 0.08 ft), cap 0.65
  sweetQ: 0.84, solidQ: 0.6,
  // --- v2 bat speed (swipe) — batSpeed b ∈ [0,1], reference TUNING.batSpeedRef (button = 0.72) ---
  //   timing window & aim tolerance × (1 − winSpeed·(b − ref)) / (1 − aimSpeed·(b − ref)): a max-effort swing is
  //   less forgiving, a lazy one more. EV = knee(evMin' + (evMax − evMin')·Q^qPow + pitch + streak), then
  //   − evSlow·s^evSlowPow below the reference (s = (ref − b)/ref; lazy swings make weak contact; evMin' = evMin − evSlowMin·s^evSlowPow),
  //   + evFast·h·Q² above it (h = (b − ref)/(1 − ref) ∈ [0,1]) plus evNoiseHard·h·(evMax − evMin)/evNoiseRange mph
  //   of extra EV sd: muscling up is boom or bust, more so for the free swingers.
  winSpeed: 0.35, aimSpeed: 0.2, evFast: 1.5,
  evSlow: 24, evSlowMin: 14, evSlowPow: 1.8,   // lazy swing: − evSlow·s^evSlowPow mph (s = (ref − b)/ref): b .55 → −1.5, .3 → −8.8, 0 → −24
  evNoiseHard: 2.2, evNoiseRange: 40, evNoisePow: 1.5,   // hard-swing EV sd = evNoiseHard·h·clamp(((evMax−evMin)/evNoiseRange)^evNoisePow, .5, 1.5)
  evTail: 3, evTailAt: 1.5,  // … plus a right tail hardSd·evTail·max(0, g − evTailAt)²·Q: the rare max-effort bomb
  evBoost: 2,           // flat mph added before the knee (keeps the homer rate up while the knee trims the monsters)
  uppercutLaunch: 7,    // deg of launch per unit of uppercut (swipe angle): loft a low pitch, stay level on a high one
  optLaunch: 29,        // the launch angle bots aim their uppercut at
  evKnee: 104.5, evKneeGain: 0.4, // EV above evKnee counts × evKneeGain — out-of-the-park stays special (tools/sim-bots.mjs --oop)
  evCap: 124,           // hard cap on exit velocity (keeps every homer ≤ TUNING.maxHomerFt in any conditions)
  perfectFrac: 0.42,    // |err| ≤ perfectFrac·window → PERFECT
  earlyFrac: 1.5,       // |err| ≤ earlyFrac·window → EARLY / LATE, beyond → WAY EARLY / WAY LATE
};
export const SIM_K = K;

const DEG = Math.PI / 180;
const G = TUNING.gravity;
const MPH = TUNING.mph;
const DRAG_REF = 100 * MPH;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ZONE_CX = (ZONE.x[0] + ZONE.x[1]) / 2, ZONE_CY = (ZONE.y[0] + ZONE.y[1]) / 2;
const ZONE_HX = (ZONE.x[1] - ZONE.x[0]) / 2, ZONE_HY = (ZONE.y[1] - ZONE.y[0]) / 2;
const round1 = v => Math.round(v * 10) / 10;
const round2 = v => Math.round(v * 100) / 100;

function gauss(rng) { // Box–Muller, one sample (always consumes two draws)
  let u = rng(); if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
const sprayOf = (x, z) => Math.atan2(x, -z) / DEG;

/** Fill in defaults: { timeOfDay, weather, wind:{mph,dir} }. */
export function normalizeConditions(c) {
  c = c || {};
  const w = c.wind || {};
  return {
    timeOfDay: c.timeOfDay || 'day',
    weather: WEATHER[c.weather] ? c.weather : 'clear',
    wind: { mph: Number.isFinite(w.mph) ? Math.max(0, w.mph) : 0, dir: Number.isFinite(w.dir) ? w.dir : 0 },
  };
}

// ============================================================================
// BALL FLIGHT
// ============================================================================
/**
 * Integrate a batted ball from `from` (default [0, 3, TUNING.contactZ]).
 * Returns {
 *   pts: Float32Array [t,x,y,z]… at 1/60 s, t = 0 at contact, last sample = at rest (null if samples:false),
 *   apex:[x,y,z], landing:[x,y,z] (first impact: field / wall / seats / board), rest:[x,y,z],
 *   cleared  — crossed the fence radius above fenceH + 0.25 (a home run if fair),
 *   wall     — hit the fence below the top (an out),
 *   hitBoard, clearedBoard — CF scoreboard / big board: hit its face (or top) / flew over it,
 *   videoBoard — id of the PARKS[p].videoBoards entry the ball came back off (null if none),
 *   fanDeck  — (Rate) came down on / into the Fan Deck,
 *   fenceT   — s after contact when the ball crossed the fence radius (null if it never did),
 *   fenceSpray, fenceY — spray angle and height at that moment,
 *   distance — projected horizontal distance where the flight would reach y = 0 (math continued
 *              through stands/boards), carry — horizontal distance of the first impact,
 *   hangTime — s to first impact, event: 'field'|'wall'|'stands'|'face'|'board'|'boardTop'|'vboard'|'deck'|'deckFace'|'timeout',
 *   landSpray, restSpray, restR }
 * opts.samples === false skips the point array and the post-impact roll (fast path for bots).
 */
export function simulateFlight(parkId, { exitVelo, launch, spray, conditions, from, samples = true } = {}) {
  const P = PARKS[parkId] || PARKS.wrigley; parkId = P.id;
  const cond = normalizeConditions(conditions);
  const carry = WEATHER[cond.weather].carry;
  const ev = Math.max(exitVelo || 0, 0);
  launch = launch || 0; spray = spray || 0;
  // Harder-hit balls carry disproportionately; WEATHER.carry thins/thickens the air.
  const kd = K.dragK * Math.pow(Math.max(ev, 20) / 100, -K.dragEvExp) * (1 - K.carryK * (carry - 1));
  // Backspin grows with exit velocity and with launch (getting under it); balls hit down carry topspin.
  const spin = Math.pow(Math.max(ev, 1) / 100, K.liftEvExp) * clamp(1 + K.liftLa * (launch - 28), 0.5, 1.5);
  const kl0 = K.liftK * spin * (launch < 0 ? -0.6 : 1);
  const wmag = cond.wind.mph * MPH * P.windScale * K.windGain;
  const wx = Math.sin(cond.wind.dir * DEG) * wmag, wz = -Math.cos(cond.wind.dir * DEG) * wmag;
  const fenceTop = P.fenceH + 0.25;
  const sb = P.scoreboard;
  const vbs = P.videoBoards || [];   // video boards on top of the back of the bleachers (bounce back)
  const fd = P.fanDeck || null;      // Rate Field's Fan Deck: a raised deck (box) above the CF batter's eye

  const v0 = ev * MPH;
  const la = launch * DEG, sp = spray * DEG;
  const x0 = from ? from[0] : 0, y0 = from ? Math.max(from[1], K.ballR) : 3, z0 = from ? from[2] : TUNING.contactZ;
  const dt = K.dt;

  const acc = [0, 0, 0];
  function accel(vx, vy, vz, kl) {
    const rx = vx - wx, rz = vz - wz;
    const s = Math.sqrt(rx * rx + vy * vy + rz * rz);
    const h = Math.sqrt(rx * rx + rz * rz) || 1e-6;
    const cd = kd * clamp(1 + K.dragV * (1 - s / DRAG_REF), 0.45, 1.8);
    acc[0] = -cd * s * rx - kl * s * (vy * rx / h);
    acc[1] = -G - cd * s * vy + kl * s * h;
    acc[2] = -cd * s * rz - kl * s * (vy * rz / h);
  }
  function step(st, kl) { // RK2 midpoint. st = [x,y,z,vx,vy,vz]
    accel(st[3], st[4], st[5], kl);
    const mx = st[3] + acc[0] * dt * 0.5, my = st[4] + acc[1] * dt * 0.5, mz = st[5] + acc[2] * dt * 0.5;
    accel(mx, my, mz, kl);
    st[0] += mx * dt; st[1] += my * dt; st[2] += mz * dt;
    st[3] += acc[0] * dt; st[4] += acc[1] * dt; st[5] += acc[2] * dt;
  }

  const out = samples ? [] : null;
  const push = (t, px, py, pz) => { if (out) out.push(t, px, py, pz); };
  push(0, x0, y0, z0);

  const st = [x0, y0, z0, v0 * Math.cos(la) * Math.sin(sp), v0 * Math.sin(la), -v0 * Math.cos(la) * Math.cos(sp)];
  let t = 0, n = 0;
  let apex = [x0, y0, z0];
  let fenceT = null, fenceSpray = null, fenceY = null, cleared = false, wall = false, hitBoard = false, clearedBoard = false;
  let videoBoard = null, fanDeck = false;
  let event = null, evState = null, evT = 0, distance = null;
  const maxT = TUNING.maxFlightTime;

  // ---- phase A: free flight with obstacle detection until the first impact;
  //      after it, keep integrating (obstacle-free) only to get the projected distance ----
  while (t < maxT + 8) {
    const px = st[0], py = st[1], pz = st[2];
    const r0 = Math.hypot(px, pz), s0 = sprayOf(px, pz);
    step(st, kl0 * Math.exp(-t / K.spinTau));
    t += dt; n++;
    if (distance === null && st[1] <= 0 && st[4] < 0) {
      const f = py / (py - st[1] || 1e-9);
      distance = Math.hypot(lerp(px, st[0], f), lerp(pz, st[2], f));
    }
    if (event) { if (distance !== null) break; continue; }

    if (st[1] > apex[1]) apex = [st[0], st[1], st[2]];
    const r1 = Math.hypot(st[0], st[2]), s1 = sprayOf(st[0], st[2]);
    const fr0 = fenceDistance(parkId, s0), fr1 = fenceDistance(parkId, s1);

    // (a) fence crossing — over (home-run height) or into the wall
    if (fenceT === null && r0 < fr0 && r1 >= fr1) {
      const g0 = r0 - fr0, g1 = r1 - fr1;
      const f = clamp(-g0 / (g1 - g0 || 1e-9), 0, 1);
      const yc = lerp(py, st[1], f), cx = lerp(px, st[0], f), cz = lerp(pz, st[2], f);
      fenceT = t - dt + f * dt; fenceSpray = sprayOf(cx, cz); fenceY = yc;
      if (yc > fenceTop) cleared = true;
      else {
        wall = true; event = 'wall'; evT = fenceT;
        const rr = Math.hypot(cx, cz) || 1, k = (fenceDistance(parkId, fenceSpray) - 0.3) / rr;
        evState = [cx * k, Math.max(K.ballR, yc), cz * k, st[3], st[4], st[5]];
        continue;
      }
    }
    if (cleared) {
      // (a2) video boards atop the back of the bleachers: anything that reaches one below its top comes back off it
      if (vbs.length) {
        const g0 = r0 - (fr0 + P.stands.depth), g1 = r1 - (fr1 + P.stands.depth);
        if (g0 < 0 && g1 >= 0) {
          const f = clamp(-g0 / (g1 - g0 || 1e-9), 0, 1);
          const cx = lerp(px, st[0], f), cz = lerp(pz, st[2], f), yc = lerp(py, st[1], f), sc = sprayOf(cx, cz);
          const vb = vbs.find(b => sc >= b.spray[0] && sc <= b.spray[1]);
          if (vb && yc <= vb.top) {
            videoBoard = vb.id; event = 'vboard'; evT = t - dt + f * dt;
            const rr = Math.hypot(cx, cz) || 1, k = (fenceDistance(parkId, sc) + P.stands.depth - 0.3) / rr;
            evState = [cx * k, yc, cz * k, st[3], st[4], st[5]];
            continue;
          }
        }
      }
      // (a3) Rate Field Fan Deck: into its front face, or down onto the deck
      if (fd && s1 >= fd.spray[0] && s1 <= fd.spray[1]) {
        const d0 = r0 - fr0, d1 = r1 - fr1;
        if (d0 < fd.d[0] && d1 >= fd.d[0]) {
          const f = clamp((fd.d[0] - d0) / (d1 - d0 || 1e-9), 0, 1), yc = lerp(py, st[1], f);
          if (yc <= fd.h) {
            fanDeck = true; event = 'deckFace'; evT = t - dt + f * dt;
            const cx = lerp(px, st[0], f), cz = lerp(pz, st[2], f), rr = Math.hypot(cx, cz) || 1, k = (fenceDistance(parkId, sprayOf(cx, cz)) + fd.d[0] - 0.3) / rr;
            evState = [cx * k, yc, cz * k, st[3], st[4], st[5]];
            continue;
          }
        }
        if (d1 >= fd.d[0] && d1 <= fd.d[1] && st[1] <= fd.h && st[4] < 0) {
          fanDeck = true; event = 'deck'; evT = t;
          evState = [st[0], fd.h + K.ballR * 0.5, st[2], 0, 0, 0];
          continue;
        }
      }
      // (b) CF scoreboard: front face, or over it (then maybe down onto its top)
      if (sb && s1 >= sb.spray[0] && s1 <= sb.spray[1]) {
        const rb = scoreboardDistance(parkId, s1);
        if (!clearedBoard && r0 < rb && r1 >= rb) {
          const f = clamp((rb - r0) / (r1 - r0 || 1e-9), 0, 1);
          const yc = lerp(py, st[1], f);
          if (yc < sb.h) {
            hitBoard = true; event = 'board'; evT = t - dt + f * dt;
            const cx = lerp(px, st[0], f), cz = lerp(pz, st[2], f), rr = Math.hypot(cx, cz) || 1, k = (rb - 0.3) / rr;
            evState = [cx * k, yc, cz * k, st[3], st[4], st[5]];
            continue;
          }
          clearedBoard = true;
        }
        if (clearedBoard && r1 >= rb && r1 <= rb + sb.depth && st[1] <= sb.h) { // dropped onto the top of the board
          clearedBoard = false; hitBoard = true; event = 'boardTop'; evT = t;
          evState = [st[0], sb.h + K.ballR, st[2], 0, 0, 0];
          continue;
        }
      }
      // (c) surfaces beyond the fence: seats, street/concourse, rooftops, ground
      const sh1 = surfaceHeight(parkId, s1, r1);
      if (st[1] <= sh1) {
        const sh0 = r0 >= fr0 ? surfaceHeight(parkId, s0, r0) : 0;
        if (r0 >= fr0 && sh1 - sh0 > 1.5 && py > sh0 + 0.5) { // hit the face of a taller step (rooftop building)
          event = 'face'; evT = t - dt;
          evState = [px, py, pz, st[3], st[4], st[5]];
        } else {
          event = 'stands'; evT = t;
          evState = [st[0], sh1 + K.ballR * 0.5, st[2], 0, 0, 0];
        }
        continue;
      }
    } else if (st[1] <= 0 && st[4] < 0) {
      // (d) came down in the field (fair or foul territory)
      const f = py / (py - st[1] || 1e-9);
      event = 'field'; evT = t - dt + f * dt;
      evState = [lerp(px, st[0], f), K.ballR, lerp(pz, st[2], f), st[3], st[4], st[5]];
      continue;
    }
    if (out && n % K.sampleEvery === 0) push(t, st[0], st[1], st[2]);
    if (t >= maxT) { event = 'timeout'; evT = t; evState = st.slice(); }
  }
  if (!event) { event = 'timeout'; evT = t; evState = st.slice(); }
  if (distance === null) distance = Math.hypot(st[0], st[2]);

  const landing = [evState[0], evState[1], evState[2]];
  if (out) { // a sample exactly at the impact
    const lastT = out[out.length - 4];
    if (evT - lastT > 1e-4) push(evT, landing[0], landing[1], landing[2]);
    else { out[out.length - 3] = landing[0]; out[out.length - 2] = landing[1]; out[out.length - 1] = landing[2]; }
  }

  // ---- phase B: after the first impact — bounce / roll / drop off a wall ----
  const s = evState.slice();
  let tb = evT;
  const needB = event === 'face' || (out && (event === 'field' || event === 'wall' || event === 'board' || event === 'vboard' || event === 'deckFace'));
  if (needB) {
    if (event === 'wall' || event === 'board' || event === 'face' || event === 'vboard' || event === 'deckFace') { // reflect the outward component, damp the rest
      const rr = Math.hypot(s[0], s[2]) || 1, ux = s[0] / rr, uz = s[2] / rr;
      const vr = s[3] * ux + s[5] * uz;
      if (vr > 0) { s[3] -= (1 + K.bounceWall) * vr * ux; s[5] -= (1 + K.bounceWall) * vr * uz; }
      s[3] *= 0.7; s[5] *= 0.7; s[4] = Math.min(s[4], 0) * 0.5;
    }
    let rolling = false, m = 0;
    const tEnd = evT + K.maxPostTime;
    const bounce = () => {
      s[4] = -s[4] * K.bounceField; s[3] *= K.bounceKeep; s[5] *= K.bounceKeep;
      if (s[4] < 3) { rolling = true; s[4] = 0; s[1] = K.ballR; }
    };
    if (event === 'field') bounce();
    const startIn = Math.hypot(s[0], s[2]) < fenceDistance(parkId, sprayOf(s[0], s[2]));
    while (tb < tEnd) {
      if (rolling) {
        const hs = Math.hypot(s[3], s[5]);
        if (hs < 0.5) { s[3] = s[5] = 0; break; }
        // decelerate; ease to a stop by tEnd so the ball never freezes mid-roll
        const dec = Math.max(K.rollDecel, hs / Math.max(tEnd - tb, dt));
        const k = Math.min(hs, dec * dt) / hs;
        s[3] -= s[3] * k; s[5] -= s[5] * k;
        s[0] += s[3] * dt; s[2] += s[5] * dt;
      } else {
        accel(s[3], s[4], s[5], 0); // no lift after impact
        s[3] += acc[0] * dt; s[4] += acc[1] * dt; s[5] += acc[2] * dt;
        s[0] += s[3] * dt; s[1] += s[4] * dt; s[2] += s[5] * dt;
      }
      tb += dt; m++;
      const r1 = Math.hypot(s[0], s[2]), s1 = sprayOf(s[0], s[2]), fr1 = fenceDistance(parkId, s1);
      if (startIn && r1 >= fr1 - 0.3) { // bounced / rolled to the wall → comes back off it
        const k = (fr1 - 0.35) / (r1 || 1); s[0] *= k; s[2] *= k;
        const ux = s[0] / (r1 * k || 1), uz = s[2] / (r1 * k || 1), vr = s[3] * ux + s[5] * uz;
        if (vr > 0) { s[3] -= (1 + K.bounceWall) * vr * ux; s[5] -= (1 + K.bounceWall) * vr * uz; }
      }
      const surf = startIn ? 0 : surfaceHeight(parkId, s1, r1);
      if (!rolling && s[1] <= surf + K.ballR) {
        s[1] = surf + K.ballR;
        if (!startIn) { s[3] = s[4] = s[5] = 0; break; } // came to rest in the seats / street
        bounce();
      }
      if (out && m % K.sampleEvery === 0) push(tb, s[0], s[1], s[2]);
    }
    if (out && out[out.length - 4] < tb - 1e-6) push(tb, s[0], s[1], s[2]);
  }
  const rest = [s[0], s[1], s[2]];
  return {
    pts: out ? Float32Array.from(out) : null,
    apex, landing, rest,
    cleared, wall, hitBoard, clearedBoard, videoBoard, fanDeck, fenceT, fenceSpray, fenceY,
    distance, carry: Math.hypot(landing[0], landing[2]), hangTime: evT, event,
    landSpray: sprayOf(landing[0], landing[2]),
    restSpray: sprayOf(rest[0], rest[2]), restR: Math.hypot(rest[0], rest[2]),
  };
}

/** Convenience: projected distance (ft at y = 0) for a batted ball. */
export function carryDistance(ev, launch, { spray = 0, conditions, from, parkId = 'wrigley' } = {}) {
  return simulateFlight(parkId, { exitVelo: ev, launch, spray, conditions, from, samples: false }).distance;
}

// ============================================================================
// PITCHES
// ============================================================================
function pickWeighted(weights, u) {
  const keys = Object.keys(weights); let tot = 0;
  for (const k of keys) tot += weights[k];
  let acc = 0;
  for (const k of keys) { acc += weights[k] / tot; if (u < acc) return k; }
  return keys[keys.length - 1];
}
// Break progress (0..1 at the plate) for flight fraction u; quadratic ease-in after breakStart,
// keeps its final slope past the plate.
const breakFn = (u, bs) => {
  if (bs >= 1 || u <= bs) return 0;
  if (u <= 1) { const k = (u - bs) / (1 - bs); return k * k; }
  return 1 + (2 / (1 - bs)) * (u - 1);
};

/** The physical pitch for (seed, n): type, mph, final plate location. Identical for every character. */
function genPitchCore(seed, n) {
  const rng = makeRng(hashString(`wcd:pitch:${seed}:${n}`));
  const ramp = rampAt(n);
  const type = pickWeighted(pitchMix(n), rng());
  const T = PITCHES[type];
  const vFrac = clamp(0.18 + 0.7 * ramp + (rng() - 0.5) * 0.45, 0, 1);
  const mph = Math.round(lerp(T.mph[0], T.mph[1], vFrac));

  // Final location at the front of the plate (z = 0).
  const pOut = n <= 3 ? 0 : clamp(0.03 + 0.21 * ramp, 0, 0.24);
  const u1 = rng(), u2 = rng(), u3 = rng(), u4 = rng(), u5 = rng(), u6 = rng();
  let px, py;
  if (u1 < pOut) {
    const beyond = 0.1 + u3 * 0.5;
    let side = u2 < 0.4 ? 'x' : u2 < 0.75 ? 'low' : 'high';
    if ((type === 'curveball' && u4 < 0.55) || (type === 'changeup' && u4 < 0.4)) side = 'low';
    if (side === 'x') {
      const sgn = type === 'slider' ? (u5 < 0.7 ? 1 : -1) : (u5 < 0.5 ? -1 : 1);
      px = ZONE_CX + sgn * (ZONE_HX + beyond); py = ZONE_CY + (u6 * 2 - 1) * ZONE_HY * 0.85;
    } else {
      px = ZONE_CX + (u6 * 2 - 1) * ZONE_HX * 0.9;
      py = side === 'low' ? ZONE.y[0] - beyond : ZONE.y[1] + beyond * 0.8;
    }
  } else {
    const spread = 0.16 + 0.76 * ramp;             // fraction of the half-zone used
    const edge = 1 - 0.4 * ramp;                     // < 1 pushes samples toward the edges
    const ax = u2 * 2 - 1, ay = u3 * 2 - 1;
    px = ZONE_CX + Math.sign(ax) * Math.pow(Math.abs(ax), edge) * spread * (ZONE_HX - 0.06);
    py = ZONE_CY + Math.sign(ay) * Math.pow(Math.abs(ay), edge) * spread * (ZONE_HY - 0.07);
  }
  px = round2(px); py = round2(py); // 0.01 ft grid — stable across platforms
  const inZone = px >= ZONE.x[0] && px <= ZONE.x[1] && py >= ZONE.y[0] && py <= ZONE.y[1];
  return { n, type, mph, px, py, inZone };
}

function buildPitch(core, char) {
  const { n, type, mph, px, py, inZone } = core;
  const T = PITCHES[type];
  const flightTime = 54 / (mph * MPH) * TUNING.pitchTimeScale;   // game s, release → front of plate
  const Treal = flightTime / TUNING.pitchTimeScale;
  const hump = 0.5 * G * Treal * Treal;                           // real gravity arc, played back in game time
  const [mx, my] = T.move; const bs = T.breakStart;
  const [rx, ry, rz] = RELEASE;
  const preX = px - mx, preY = py - my;                           // where it would cross without the break
  const tArrive = flightTime * (TUNING.contactZ - rz) / -rz;      // ball reaches the contact plane (z = contactZ)
  const rb = clamp(char.swing.readBonus || 0, 0, 1);

  function posAt(t) {
    const u = Math.max(0, t) / flightTime;
    const b = breakFn(u, bs);
    const x = rx + (preX - rx) * u + mx * b;
    let y = ry + (preY - ry) * u + hump * u * (1 - u) + my * b;
    const z = rz - rz * u;
    if (y < K.ballR) y = K.ballR;
    return [x, y, z];
  }
  // The eye: game clock slows over the last eyeSlowFrac of the flight (smooth in), holds just past
  // the plate, then eases back to 1.
  const slowStart = flightTime * (1 - TUNING.eyeSlowFrac);
  const slowMin = 1 - TUNING.eyeSlowAmount * rb;
  function clockRate(t) {
    if (rb <= 0) return 1;
    const inRamp = 0.06, holdEnd = flightTime + 0.12, outRamp = 0.12;
    let k;
    if (t <= slowStart) k = 0;
    else if (t < slowStart + inRamp) k = (t - slowStart) / inRamp;
    else if (t <= holdEnd) k = 1;
    else if (t < holdEnd + outRamp) k = 1 - (t - holdEnd) / outRamp;
    else k = 0;
    k = k * k * (3 - 2 * k);
    return 1 - (1 - slowMin) * k;
  }
  const showAt = flightTime * lerp(TUNING.ringShowFrac, TUNING.ringShowFracEye, rb);
  const hasBreak = bs < 1 && (mx !== 0 || my !== 0);
  const preLoc = rb >= 1 || !hasBreak ? [px, py] : [round2(lerp(preX, px, rb)), round2(lerp(preY, py, rb))];
  // break reaches ~20% of its total → visibly bending
  const snapAt = rb >= 1 || !hasBreak ? showAt : Math.max(showAt, flightTime * (bs + (1 - bs) * Math.sqrt(0.2)));

  return {
    n, type, label: T.label, mph, flightTime, plateLoc: [px, py], inZone,
    posAt, clockRate,
    ring: { showAt, preLoc, trueLoc: [px, py], snapAt },
    // extras (not in CONTRACT; safe to ignore):
    tArrive,                      // game s since release when the ball reaches TUNING.contactZ
    perfectTapT: tArrive + TUNING.inputLatencyComp - TUNING.swingLead, // raw tapT that gives timingErr 0 (at the reference bat speed)
    breaking: BREAKING.has(type), color: T.color,
  };
}

/** Pitch preview for (seed, n) without a Round — {n,type,mph,px,py,inZone} (tests, daily preview). */
export function pitchAt(seed, n) { return genPitchCore(seed, n); }

/** The raw swing-start tapT (game s since release) that produces a zero timing error on this pitch at batSpeed b. */
export function perfectTap(pitch, batSpeed = TUNING.batSpeedRef) { return pitch.tArrive + TUNING.inputLatencyComp - swingLeadFor(batSpeed); }

/**
 * Seconds from swing START to bat-on-ball for bat speed b ∈ [0,1] (a fast swing reaches the zone sooner).
 * Piecewise-linear through (0, swingLeadSlow) (batSpeedRef, swingLead) (1, swingLeadFast): 0.20 → 0.12 → 0.09 s.
 */
export function swingLeadFor(batSpeed = TUNING.batSpeedRef) {
  const b = clamp(Number.isFinite(+batSpeed) ? +batSpeed : TUNING.batSpeedRef, 0, 1), r = TUNING.batSpeedRef;
  return b <= r ? lerp(TUNING.swingLeadSlow, TUNING.swingLead, b / r) : lerp(TUNING.swingLead, TUNING.swingLeadFast, (b - r) / (1 - r));
}
/** Displayed bat speed in mph for b ∈ [0,1] (TUNING.batMph, linear). */
export function batSpeedMph(batSpeed) { const [a, c] = TUNING.batMph; return Math.round(lerp(a, c, clamp(+batSpeed || 0, 0, 1))); }

/** The uppercut (−1..1) a smart hitter uses on a pitch at height py: cancels the pitch-height launch shift. */
export function idealUppercut(who, py, type = 'fastball') {
  const ch = charOf(who); if (!ch) return 0;
  const tol = aimTolFor(ch, type);
  const shift = (py - ZONE_CY) * K.heightLaunch * Math.pow(0.85 / tol, K.heightTolPow);
  return clamp((K.optLaunch - ch.swing.launch - shift) / K.uppercutLaunch, -1, 1);
}

/** How far inside a plate x is for a batter side: +1 = inside edge of the zone, −1 = outside edge. */
export function insideness(bats, px) { return clamp((bats === 'R' ? -1 : 1) * (px - ZONE_CX) / ZONE_HX, -1.6, 1.6); }

// aimTol for a character vs a pitch type (× breakWindowMul vs breaking stuff)
function aimTolFor(char, type) {
  const S = char.swing; return S.aimTol * (BREAKING.has(type) ? S.breakWindowMul : 1);
}
const bandLo = (i, tol) => clamp(K.bandSlope * i - K.bandW * tol / 0.85, -1, 1);
const bandHi = (i, tol) => clamp(K.bandSlope * i + K.bandW * tol / 0.85, -1, 1);
const charOf = c => (typeof c === 'string' ? CHAR_BY_ID[c] : c) || null;

/**
 * The location-matched POWER aim (−1 LF … +1 RF) for a character, plate x and pitch type: just inside
 * the pull edge of the character's free band for a pitch from the middle in, just inside the oppo edge
 * for one away. `who` = charId or character object (or 'R'/'L' for a generic hitter with aimTol 0.85).
 */
export function idealAim(who, px, type = 'fastball') {
  const ch = charOf(who), bats = ch ? ch.bats : who, tol = ch ? aimTolFor(ch, type) : 0.85;
  const i = insideness(bats, px);
  const pull = i >= K.aimSplit ? bandHi(i, tol) - K.aimMargin : bandLo(i, tol) + K.aimMargin;
  return (bats === 'R' ? -1 : 1) * clamp(pull, -1, 1);
}

/** Aim range (field direction, [lo, hi]) that costs no swing quality for this character, plate x and pitch type. */
export function aimBand(who, px, type = 'fastball') {
  const ch = charOf(who), bats = ch ? ch.bats : who, tol = ch ? aimTolFor(ch, type) : 0.85;
  const i = insideness(bats, px), ps = bats === 'R' ? -1 : 1;
  const a = bandLo(i, tol) * ps, b = bandHi(i, tol) * ps;
  return a < b ? [a, b] : [b, a];
}

// ============================================================================
// SWING MODEL
// ============================================================================
function swingOutcome(char, park, cond, pitch, tapT, aim, streak, seed, samples, batSpeed, uppercut) {
  const S = char.swing;
  const rng = makeRng(hashString(`wcd:swing:${seed}:${pitch.n}`)); // outcome-noise stream (seed + n)
  const uWhiff = rng(), gEv = gauss(rng), gLa = gauss(rng), gSp = gauss(rng), gSide = gauss(rng);

  const pullSign = char.bats === 'R' ? -1 : 1;
  const brk = BREAKING.has(pitch.type);
  const bs = clamp(Number.isFinite(+batSpeed) ? +batSpeed : TUNING.batSpeedRef, 0, 1);
  const uc = clamp(Number.isFinite(+uppercut) ? +uppercut : 0, -1, 1);
  const db = bs - TUNING.batSpeedRef;
  const leadT = swingLeadFor(bs);
  const w = S.window * (brk ? S.breakWindowMul : 1) * clamp(1 - K.winSpeed * db, 0.7, 1.4);
  const aimTol = S.aimTol * (brk ? S.breakWindowMul : 1) * clamp(1 - K.aimSpeed * db, 0.8, 1.25);
  aim = clamp(Number.isFinite(aim) ? aim : 0, -1, 1);
  const tArrive = pitch.tArrive != null ? pitch.tArrive : pitch.flightTime * (TUNING.contactZ - RELEASE[2]) / -RELEASE[2];
  const contactT = (Number.isFinite(tapT) ? tapT : -99) - TUNING.inputLatencyComp + leadT;
  const timingErr = contactT - tArrive;          // + = late
  const e = timingErr / w, ae = Math.abs(e);
  const timingLabel = ae <= K.perfectFrac ? 'PERFECT' : ae <= K.earlyFrac ? (e < 0 ? 'EARLY' : 'LATE') : (e < 0 ? 'WAY EARLY' : 'WAY LATE');
  const [px, py] = pitch.plateLoc;
  // The bat meets the ball within a hittable depth: contactT is clamped to tArrive −0.06/+0.05 s so that
  // posAt(contactT) === contactPos === the first path sample (rawContactT is the unclamped swing time).
  const tc = clamp(contactT, tArrive - 0.06, tArrive + 0.05);
  const contactPos = pitch.posAt(tc);
  const base = { swung: true, timingErr, timingLabel, contactT: tc, rawContactT: contactT, contactPos, n: pitch.n, aim,
    batSpeed: bs, batMph: batSpeedMph(bs), leadT, uppercut: uc, maxEffort: bs >= TUNING.maxEffortAt, outOfPark: false };

  // ---- whiff: way off on timing, or chasing well out of the zone ----
  const outDist = Math.hypot(Math.max(0, Math.abs(px - ZONE_CX) - ZONE_HX), Math.max(0, ZONE.y[0] - py, py - ZONE.y[1]));
  const pChase = clamp((outDist - 0.08) * K.chaseWhiff, 0, 0.65);
  if (ae > S.whiffAt || uWhiff < pChase) {
    return { ...base, kind: 'whiff', quality: 0, contact: 'miss', exitVelo: 0, launch: 0, spray: 0, distance: 0, hangTime: 0, path: null, bonus: null, wall: false };
  }

  // ---- quality = timing × aim match × height ----
  const qt = Math.exp(-e * e);
  const ideal = idealAim(char, px, pitch.type);
  const ins = insideness(char.bats, px), pull = aim * pullSign, hi = bandHi(ins, aimTol), lo = bandLo(ins, aimTol);
  const aimErr = pull > hi ? pull - hi : pull < lo ? pull - lo : 0; // > 0 pulled it more than the pitch wants, < 0 went oppo on it
  const dev = Math.abs(aimErr) / (aimTol * K.aimK);
  const qa = Math.exp(-dev * dev);
  // pitch height: the edges of the zone and beyond cost quality (contact hitters — big aimTol — cope better)
  const hOut = Math.max(0, Math.abs(py - ZONE_CY) - ZONE_HY * 0.75);
  const qh = Math.exp(-((hOut / (K.heightTol * aimTol)) ** 2));
  const Q = clamp(qt * qa * qh, 0, 1);

  // ---- exit velocity (Skye's streak power needs a good swing to show) ----
  const streakEv = S.streakEv ? Math.min(streak * S.streakEv, S.streakEvCap) * Math.pow(Q, K.streakQPow) : 0;
  const pitchEv = pitch.type === 'meatball' ? K.cookieEv : Math.max(0, pitch.mph - 60) * K.speedEv;
  // bat speed: a lazy swing lowers ceiling and floor; the top end is compressed above evKnee (monster shots stay rare and
  // the park geometry honest); a hard swing then adds EV on good contact plus extra variance (muscling up = boom or bust)
  const slow = Math.max(0, -db) / TUNING.batSpeedRef, hard = Math.max(0, db) / (1 - TUNING.batSpeedRef); // both 0..1
  const soft = Math.pow(slow, K.evSlowPow);   // a slightly soft swipe barely matters, a lazy flick really does
  const evLow = S.evMin - K.evSlowMin * soft;
  let exitVelo = evLow + (S.evMax - evLow) * Math.pow(Q, K.qPow) + pitchEv + K.evBoost;
  if (exitVelo > K.evKnee) exitVelo = K.evKnee + (exitVelo - K.evKnee) * K.evKneeGain;
  exitVelo += streakEv * K.streakPost;   // Skye's heat rides on top of the knee
  const hardSd = K.evNoiseHard * hard * clamp(((S.evMax - S.evMin) / K.evNoiseRange) ** K.evNoisePow, 0.5, 1.5);
  exitVelo += K.evFast * hard * Q * Q - K.evSlow * soft
    + gEv * (K.evNoise * (1 + 2.5 * (1 - Q)) + hardSd)
    + hardSd * K.evTail * Math.max(0, gEv - K.evTailAt) ** 2 * Q;   // the rare "got ALL of it" max-effort bomb
  exitVelo = clamp(exitVelo, 35, K.evCap);

  // ---- launch: base + pitch height + vertical mis-hit (high pitch → under it, low → topped) ----
  const hRel = py - ZONE_CY;
  const sideSign = Math.sign(hRel * 2.2 + gSide * 0.6) || 1;
  // vertical mis-hit: blends the character's quality with the absolute timing error (the bat is simply
  // somewhere else in its arc when it's early/late by N ms, whoever swings it)
  const qMiss = Math.pow(qt, 1 - K.missMix) * Math.pow(Math.exp(-((timingErr / K.missWindow) ** 2)), K.missMix) * qa * qh;
  const miss = Math.pow(1 - qMiss, K.missPow) * K.missLaunch;
  // (contact hitters — big aimTol — match their swing plane to the pitch height better)
  let launch = S.launch + hRel * K.heightLaunch * Math.pow(0.85 / aimTol, K.heightTolPow) + uc * K.uppercutLaunch + sideSign * miss + gLa * (K.launchNoise + 6 * (1 - Q));
  launch = clamp(launch, -25, 78);

  // ---- spray: aim + timing (early pulls, late goes the other way) + noise ----
  const spray = aim * K.sprayPerAim + clamp(-e * K.sprayTiming * pullSign, -32, 32) + gSp * (K.sprayNoise + 7 * (1 - Q));

  // ---- contact label: the dominant reason ----
  let contact;
  if (Q >= K.sweetQ) contact = 'sweet';
  else if (launch < 3) contact = 'topped';
  else if (launch > 46) contact = 'under';
  else if (Q >= K.solidQ) contact = 'solid';
  else if (qh < qt && qh < qa) contact = hRel < 0 ? 'topped' : 'under';
  else if (qa < qt) contact = aimErr > 0 ? 'off the end' : 'jammed';
  else contact = e > 0 ? 'jammed' : 'off the end';

  const b = battedBall(park.id, { exitVelo, launch, spray, conditions: cond, from: contactPos, samples });
  const f = b.flight;
  return {
    ...base, kind: b.kind, quality: Q, contact,
    exitVelo: round1(exitVelo), launch: round1(launch), spray: round1(spray),
    distance: b.distance, hangTime: f.hangTime,
    path: { pts: f.pts, apex: f.apex, landing: f.landing, rest: f.rest, hitBoard: f.hitBoard, clearedBoard: f.clearedBoard, videoBoard: f.videoBoard, fanDeck: f.fanDeck, fenceT: f.fenceT, event: f.event },
    wall: b.wall, bonus: b.bonus, outOfPark: b.outOfPark,
    // debugging extras
    projected: Math.round(f.distance), q: { t: qt, aim: qa, h: qh }, idealAim: ideal, streakEv,
  };
}

/**
 * Fly a batted ball and classify it exactly as resolveSwing does:
 * { kind: 'foul'|'homer'|'grounder'|'popup'|'liner'|'flyout', distance, bonus, outOfPark, wall, flight }.
 * Foul = launched outside ±45°, or (beyond the infield) first landing / fence crossing outside ±45°.
 * distance: homers → projected distance at field level; others → where it first came down / hit the wall.
 */
export function battedBall(parkId, { exitVelo, launch, spray, conditions, from, samples = true } = {}) {
  const P = PARKS[parkId] || PARKS.wrigley;
  const f = simulateFlight(P.id, { exitVelo, launch, spray, conditions, from, samples });
  const fairAt = f.fenceT !== null ? f.fenceSpray : f.landSpray;
  const foul = Math.abs(spray || 0) > 45 || (f.carry > 100 && Math.abs(fairAt) > 45);
  let kind;
  if (foul) kind = 'foul';
  else if (f.cleared) kind = 'homer';
  else if (launch < 10) kind = 'grounder';
  else if (launch > 48) kind = 'popup';
  else if (launch < 24) kind = 'liner';
  else kind = 'flyout';
  const homer = kind === 'homer';
  const bonus = homer ? classifyLanding(P.id, { spray: f.restSpray, r: f.restR, y: f.rest[1], hitBoard: f.hitBoard, clearedBoard: f.clearedBoard, videoBoard: f.videoBoard, fanDeck: f.fanDeck }) : null;
  const distance = Math.round(homer ? Math.min(f.distance, TUNING.maxHomerFt) : f.carry);
  return { kind, distance, bonus, outOfPark: homer && isOutOfPark(P.id, bonus), wall: f.wall && !foul, flight: f };
}

// ============================================================================
// ROUND
// ============================================================================
export function createRound({ charId, parkId, mode = 'free', seed = 1, conditions, date = null, personalBest = 0 } = {}) {
  const char = CHAR_BY_ID[charId] || CHARACTERS[0];
  const park = PARKS[parkId] || PARKS.wrigley;
  const cond = normalizeConditions(conditions);
  const S = char.swing;
  seed = Number.isFinite(+seed) ? +seed : hashString(String(seed));
  let best = Math.max(0, personalBest || 0);
  const applied = new WeakMap();
  const homerDistances = [];

  const R = {
    charId: char.id, parkId: park.id, mode, seed, date, conditions: cond, bats: char.bats,
    outs: 0, homers: 0, score: 0, streak: 0, bestStreak: 0, longest: 0, pitchCount: 0, over: false, outOfPark: 0,

    nextPitch() {
      if (R.over) throw new Error('round over');
      R.pitchCount += 1;
      return buildPitch(genPitchCore(seed, R.pitchCount), char);
    },

    resolveTake(pitch) {
      return { kind: pitch && pitch.inZone ? 'strike' : 'ball', swung: false, n: pitch ? pitch.n : 0 };
    },

    // v2: batSpeed ∈ [0,1] (swipe speed; button = 0.72), uppercut ∈ [−1,1] (swipe angle). tapT = swing START.
    // opts.samples === false: no path.pts (bots / batch tools — much faster)
    resolveSwing(pitch, { tapT, aim = 0, batSpeed = TUNING.batSpeedRef, uppercut = 0, samples = true } = {}) {
      return swingOutcome(char, park, cond, pitch, tapT, aim, R.streak, seed, samples !== false, batSpeed, uppercut);
    },

    apply(result) {
      if (!result) throw new Error('apply(result): result required');
      if (applied.has(result)) return applied.get(result);     // idempotent per result object
      if (R.over) return { scoreDelta: 0, callouts: [], events: [], out: false, roundOver: true, streak: R.streak, mult: 1, nextMult: 1 };
      const callouts = [], events = [];
      let scoreDelta = 0, out = false, mult = 1;
      const prevStreak = R.streak;
      if (result.kind === 'homer') {
        const clutchNow = R.outs === OUTS_PER_ROUND - 1;
        R.homers++; R.streak++; R.bestStreak = Math.max(R.bestStreak, R.streak);
        events.push('homer');
        if (R.streak % TUNING.waveEvery === 0) events.push('wave');           // THE WAVE at 3, 6, 9 … straight
        const oop = result.outOfPark != null ? !!result.outOfPark : isOutOfPark(park.id, result.bonus);
        if (oop) { events.push('outOfPark'); R.outOfPark++; }
        const d = Math.round(Math.min(result.distance, TUNING.maxHomerFt));
        homerDistances.push(d);
        R.longest = Math.max(R.longest, d);
        const sm = TUNING.streakMult[Math.min(R.streak, TUNING.streakMult.length - 1)];
        const clutch = clutchNow ? TUNING.clutchMult : 1;
        mult = sm * clutch;
        const withStreak = Math.round(d * sm), total = Math.round(d * mult);
        callouts.push({ text: `${d} FT`, points: d, kind: 'distance' });
        if (sm > 1) {
          const txt = R.streak === 2 ? 'BACK-TO-BACK' : R.streak === 3 ? 'B2B2B' : R.streak === 4 ? '4 STRAIGHT' : 'ON FIRE';
          callouts.push({ text: `${txt} ×${sm}`, points: withStreak - d, kind: 'streak' });
        }
        if (clutch > 1) callouts.push({ text: `CLUTCH ×${clutch}`, points: total - withStreak, kind: 'clutch' });
        scoreDelta += total;
        if (result.bonus && park.bonus[result.bonus]) {
          const b = park.bonus[result.bonus];
          callouts.push({ text: `${b.label} +${b.points}`, points: b.points, kind: 'bonus', key: result.bonus, outOfPark: oop });
          scoreDelta += b.points; events.push('bonus');
        }
        if (d >= TUNING.wayOutFt) { callouts.push({ text: `WAY OUT +${TUNING.wayOutPts}`, points: TUNING.wayOutPts, kind: 'wayout' }); scoreDelta += TUNING.wayOutPts; }
        else if (d >= TUNING.moonshotFt) { callouts.push({ text: `MOONSHOT +${TUNING.moonshotPts}`, points: TUNING.moonshotPts, kind: 'moonshot' }); scoreDelta += TUNING.moonshotPts; }
        if (d > best) {
          best = d;
          callouts.push({ text: `NEW RECORD +${TUNING.recordPts}`, points: TUNING.recordPts, kind: 'record' });
          scoreDelta += TUNING.recordPts; events.push('record');
        }
        if (S.streakEv && R.streak >= 1) { // Skye: power grows with every straight homer (applies to the NEXT swing)
          const nb = Math.min(R.streak * S.streakEv, S.streakEvCap);
          callouts.push({ text: `HEATING UP +${round1(nb)} MPH`, points: 0, kind: 'power' });
        }
      } else if (result.kind === 'ball') {
        callouts.push({ text: 'BALL', points: 0, kind: 'ball' });
      } else {
        out = true; R.outs++; R.streak = 0;
        let text = {
          strike: 'CALLED STRIKE', whiff: 'SWING & MISS', foul: 'FOUL BALL', grounder: 'GROUNDER', popup: 'POP UP',
          liner: 'LINE OUT', flyout: 'FLY OUT',
        }[result.kind] || 'OUT';
        if (result.wall) text = 'OFF THE WALL';
        else if (result.kind === 'flyout' && result.distance >= fenceDistance(park.id, result.spray) - 30) text = 'WARNING TRACK';
        callouts.push({ text, points: 0, kind: 'out' });
        if (prevStreak >= 2) { callouts.push({ text: `STREAK ENDS AT ${prevStreak}`, points: 0, kind: 'streakEnd' }); events.push('streakEnd'); }
        if (R.outs === OUTS_PER_ROUND - 1) callouts.push({ text: `LAST OUT — CLUTCH ×${TUNING.clutchMult}`, points: 0, kind: 'info' });
      }
      R.score += scoreDelta;
      if (R.outs >= OUTS_PER_ROUND) R.over = true;
      const res = {
        scoreDelta, callouts, events, out, roundOver: R.over, streak: R.streak, mult,
        // multiplier the NEXT homer would get (for the HUD)
        nextMult: TUNING.streakMult[Math.min(R.streak + 1, TUNING.streakMult.length - 1)] * (R.outs === OUTS_PER_ROUND - 1 ? TUNING.clutchMult : 1),
      };
      applied.set(result, res);
      return res;
    },

    summary() {
      const avg = homerDistances.length ? Math.round(homerDistances.reduce((a, b) => a + b, 0) / homerDistances.length) : 0;
      return {
        score: R.score, homers: R.homers, longest: R.longest, outs: R.outs, pitches: R.pitchCount,
        bestStreak: R.bestStreak, charId: R.charId, parkId: R.parkId, mode: R.mode, date: R.date,
        avgDistance: avg, outOfPark: R.outOfPark || 0, v: VERSION,
      };
    },
  };
  return R;
}

// ============================================================================
// SIM_SELFTEST — the numbers this build was tuned to (regenerate with tools/sim-test.mjs and
// tools/sim-bots.mjs; values below are copied from their output). v2 (PLAY, swipe swing).
// ============================================================================
export const SIM_SELFTEST = {
  // simulateFlight, no wind, from [0,3,contactZ]: [exitVelo, launch, target ft, sim ft] (v2: Statcast-like top end)
  calibration: [[95, 25, 326, 325.8], [100, 28, 367, 367.4], [105, 28, 400, 399.8], [110, 28, 433, 432.7], [115, 30, 464, 463.8], [119, 28, 491, 490.7]],
  wind: { out10: +28.0, in10: -31.9, rateOut10: +17.2 },          // ft on a 105 mph @ 28° drive (Rate windScale 0.6)
  weather: { heat: 1.031, overcast: 0.99, drizzle: 0.971 },        // distance ratio vs clear
  shape: { '124@28': 520, '105@20': 364, '105@33': 402, '105@45': 354, '105@60': 238 },
  swingLead: { 0: 0.2, 0.3: 0.167, 0.72: 0.12, 0.9: 0.101, 1: 0.09 },   // swingLeadFor(batSpeed), s
  // tools/sim-bots.mjs --rounds 200 (random free-play conditions, both parks): mean HR/round per bot (v2 swipe bots)
  bots: {
    rounds: 200,
    meanHr: { novice: 1.0, average: 3.6, good: 8.4, elite: 22.4 }, over60pct: 2.97,
    // per fox (both parks): [HR/round, score, avg HR ft]
    perFox: {
      good: { rocco: [5.3, 4103, 435], jett: [11.3, 8549, 417], dex: [9.9, 7448, 420], blaze: [6.8, 5130, 428], nova: [9.1, 6808, 421], skye: [7.9, 6229, 420] },
      elite: { rocco: [15.6, 15276, 440], jett: [27.8, 26579, 423], dex: [26.0, 25199, 425], blaze: [15.6, 14309, 433], nova: [24.4, 23393, 427], skye: [24.8, 28620, 437] },
    },
    missed: ['good-bot score ±20% (rocco −36%, jett +34%) — needs the CHARACTERS patch below (lead owns CHARACTERS)'],
  },
  // --bots good,hard,button,elite --oop --rounds 300: homers per out-of-the-park homer ("1 in N")
  outOfPark: {
    hard:   { wrigley: { rocco: 8.8, blaze: 14.3, skye: 30.7, nova: 32.9, dex: 38.7, jett: 60.0 }, rate: { rocco: 149, blaze: 303, skye: 373, nova: 421, dex: 420, jett: 467 } },
    good:   { wrigley: { rocco: 13.7, blaze: 20.0, skye: 28.6, nova: 47.8, dex: 57.3, jett: 84.8 }, rate: { rocco: 233 } },
    button: { wrigley: { rocco: 21.1, blaze: 30.8, jett: 176 }, rate: {} },
    elite:  { wrigley: { rocco: 9.8, skye: 11.2, blaze: 16.7, jett: 64.7 }, rate: { rocco: 106, skye: 105 } },
    longest: 590, maxRoundScore: 192447, maxHomersPerRound: 84,
  },
  // proposed data.js CHARACTERS patch (lead owns CHARACTERS): brings good-bot scores to −21%…+21%
  proposal: {
    patch: { rocco: { window: 0.062, whiffAt: 2.6 }, blaze: { window: 0.078 }, skye: { window: 0.084 }, jett: { window: 0.09 } },
    good: { rocco: [6.4, 5098, 435], jett: [10.5, 7839, 417], dex: [9.9, 7448, 420], blaze: [7.4, 5569, 428], nova: [9.1, 6808, 421], skye: [8.5, 6855, 421] },
  },
  // leaderboard bounds for this scoring (tools/sim-test.mjs 'v2 limits'): one homer ≤ maxHomerFt·3·1.5 + 2000 + 250 + 250
  limits: { perHomerMax: 5245, maxHomerFt: 610 },
};
