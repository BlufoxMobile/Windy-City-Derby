#!/usr/bin/env node
// ============================================================================
// WINDY CITY DERBY — src/sim.js tests.   node tools/sim-test.mjs   (exit 1 on any failure)
// Covers: API shape, determinism, pitches, calibration table, wind/weather, fence/HR edge cases,
// wall balls, scoreboard, foul lines, takes, swing model, scoring/multipliers/clutch/bonuses/record,
// round-over flag, path format.
// v2: swipe swing (batSpeed / uppercut / swingLeadFor), video boards, Fan Deck, out of the park,
// round events (wave / outOfPark), distance cap and the leaderboard score bounds.
// ============================================================================
import assert from 'node:assert/strict';
import {
  createRound, simulateFlight, battedBall, pitchAt, perfectTap, idealAim, idealUppercut, aimBand, insideness, SIM_K, SIM_SELFTEST, normalizeConditions,
  swingLeadFor, batSpeedMph,
} from '../src/sim.js';
import {
  CHARACTERS, CHAR_BY_ID, PARKS, PITCHES, BREAKING, ZONE, RELEASE, TUNING, OUTS_PER_ROUND, VERSION,
  pitchMix, fenceDistance, surfaceHeight, scoreboardDistance, dailyConfig, classifyLanding, isOutOfPark,
} from '../src/data.js';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(['ok  ', name]); }
  catch (e) { failed++; results.push(['FAIL', name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')]); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);
const CALM = { timeOfDay: 'day', weather: 'clear', wind: { mph: 0, dir: 0 } };
const FROM = [0, 3, TUNING.contactZ];
const fly = (ev, la, spray = 0, cond = CALM, park = 'wrigley') => simulateFlight(park, { exitVelo: ev, launch: la, spray, conditions: cond, from: FROM, samples: false });
const dist = (ev, la, cond = CALM, spray = 0, park = 'wrigley') => fly(ev, la, spray, cond, park).distance;
/** y of the path where it crosses horizontal radius r (linear interp on the 60 Hz samples) */
function yAtRadius(pts, r) {
  for (let i = 4; i < pts.length; i += 4) {
    const r0 = Math.hypot(pts[i - 3], pts[i - 1]), r1 = Math.hypot(pts[i + 1], pts[i + 3]);
    if (r0 < r && r1 >= r) { const f = (r - r0) / (r1 - r0); return pts[i - 2] + (pts[i + 2] - pts[i - 2]) * f; }
  }
  return null;
}
/** smallest EV (±0.001 mph) at which pred(flight) flips from false to true, by bisection */
function bisectEv(lo, hi, pred) {
  for (let k = 0; k < 60 && hi - lo > 0.001; k++) { const m = (lo + hi) / 2; if (pred(m)) hi = m; else lo = m; }
  return hi;
}
const homerResult = (distance, extra = {}) => ({ kind: 'homer', swung: true, distance, bonus: null, ...extra });
const outResult = (kind = 'flyout', extra = {}) => ({ kind, swung: true, distance: 300, spray: 0, bonus: null, ...extra });

// ---------------------------------------------------------------------------- API
test('API: exports + Round shape match CONTRACT', () => {
  for (const f of [createRound, simulateFlight, battedBall, pitchAt, perfectTap, idealAim, aimBand]) assert.equal(typeof f, 'function');
  assert.ok(SIM_SELFTEST && SIM_SELFTEST.calibration && SIM_SELFTEST.bots, 'SIM_SELFTEST exported');
  const R = createRound({ charId: 'nova', parkId: 'wrigley', mode: 'daily', seed: 42, conditions: CALM, date: '2026-09-26', personalBest: 0 });
  for (const k of ['charId', 'parkId', 'mode', 'outs', 'homers', 'score', 'streak', 'bestStreak', 'longest', 'pitchCount', 'over']) assert.ok(k in R, 'Round.' + k);
  for (const k of ['nextPitch', 'resolveSwing', 'resolveTake', 'apply', 'summary']) assert.equal(typeof R[k], 'function', 'Round.' + k);
  assert.deepEqual([R.charId, R.parkId, R.mode, R.outs, R.homers, R.score, R.streak, R.over], ['nova', 'wrigley', 'daily', 0, 0, 0, 0, false]);
  const p = R.nextPitch();
  for (const k of ['n', 'type', 'label', 'mph', 'flightTime', 'plateLoc', 'inZone', 'posAt', 'ring', 'clockRate']) assert.ok(k in p, 'Pitch.' + k);
  for (const k of ['showAt', 'preLoc', 'trueLoc', 'snapAt']) assert.ok(k in p.ring, 'ring.' + k);
  const s = R.resolveSwing(p, { tapT: perfectTap(p), aim: 0 });
  for (const k of ['kind', 'swung', 'timingErr', 'timingLabel', 'quality', 'contact', 'exitVelo', 'launch', 'spray', 'distance', 'hangTime', 'contactT', 'contactPos', 'path', 'bonus']) assert.ok(k in s, 'SwingResult.' + k);
  for (const k of ['batSpeed', 'leadT', 'outOfPark']) assert.ok(k in s, 'SwingResult.' + k + ' (v2)');
  assert.equal(s.batSpeed, TUNING.batSpeedRef, 'default batSpeed = button'); near(s.leadT, TUNING.swingLead, 1e-12, 'default lead');
  for (const k of ['pts', 'apex', 'landing', 'hitBoard', 'clearedBoard', 'fenceT']) assert.ok(k in s.path, 'path.' + k);
  const t = R.resolveTake(p); assert.equal(t.swung, false); assert.ok(t.kind === 'ball' || t.kind === 'strike');
  const a = R.apply(s);
  for (const k of ['scoreDelta', 'callouts', 'out', 'roundOver', 'streak', 'mult', 'events']) assert.ok(k in a, 'apply().' + k);
  assert.ok(Array.isArray(a.events));
  const sum = R.summary();
  for (const k of ['score', 'homers', 'longest', 'outs', 'pitches', 'bestStreak', 'charId', 'parkId', 'mode', 'date', 'avgDistance', 'v']) assert.ok(k in sum, 'summary.' + k);
  assert.equal(sum.v, VERSION); assert.equal(sum.date, '2026-09-26'); assert.equal(sum.pitches, 1);
});

test('defaults: unknown char/park/conditions fall back safely', () => {
  const R = createRound({ charId: 'nobody', parkId: 'nowhere', seed: 'abc' });
  assert.ok(CHAR_BY_ID[R.charId] && PARKS[R.parkId]);
  const p = R.nextPitch(); const s = R.resolveSwing(p, { tapT: NaN, aim: 'x' });
  assert.equal(s.kind, 'whiff');
  assert.deepEqual(normalizeConditions(null), { timeOfDay: 'day', weather: 'clear', wind: { mph: 0, dir: 0 } });
});

// ---------------------------------------------------------------------------- determinism
test('determinism: pitch sequence depends only on seed + n (not character, not swings)', () => {
  const seq = (charId, play) => {
    const R = createRound({ charId, parkId: 'rate', seed: 777, conditions: CALM });
    const out = [];
    while (!R.over && R.pitchCount < 40) {
      const p = R.nextPitch();
      out.push([p.type, p.mph, p.plateLoc.join(','), p.inZone, p.flightTime.toFixed(9), p.posAt(0.3).map(v => v.toFixed(6)).join(',')].join('|'));
      R.apply(play === 'take' ? R.resolveTake(p) : R.resolveSwing(p, { tapT: perfectTap(p) + (play === 'late' ? 0.04 : 0), aim: 0, samples: false }));
    }
    return out;
  };
  const a = seq('rocco', 'swing'), b = seq('jett', 'take'), c = seq('dex', 'late');
  const n = Math.min(a.length, b.length, c.length);
  assert.ok(n >= 10);
  for (let i = 0; i < n; i++) {
    const strip = s => s.split('|').slice(0, 5).join('|'); // posAt identical except nothing: posAt is char-independent
    assert.equal(strip(a[i]), strip(b[i]), 'pitch ' + (i + 1)); assert.equal(a[i], c[i], 'pitch ' + (i + 1));
  }
  for (let k = 1; k <= 30; k++) { const q = pitchAt(777, k); assert.ok(a[k - 1] === undefined || a[k - 1].startsWith(`${q.type}|${q.mph}|${q.px},${q.py}|`), 'pitchAt ' + k); }
  const d = seq('rocco', 'swing'); assert.deepEqual(a, d, 'repeatable');
  const other = createRound({ charId: 'rocco', parkId: 'rate', seed: 778 }); const o = [];
  for (let k = 0; k < 10; k++) { const p = other.nextPitch(); o.push(p.type + p.mph + p.plateLoc); }
  assert.notDeepEqual(o, a.slice(0, 10).map(s => s.split('|').slice(0, 3).join('')), 'different seed differs');
});

test('determinism: same seed + same inputs ⇒ identical swing results and paths; daily pitchSeed shared', () => {
  const run = () => {
    const R = createRound({ charId: 'skye', parkId: 'wrigley', seed: dailyConfig('2026-09-26').pitchSeed, conditions: { weather: 'heat', wind: { mph: 9, dir: -20 } } });
    const out = [];
    for (let k = 0; k < 25 && !R.over; k++) {
      const p = R.nextPitch();
      const r = R.resolveSwing(p, { tapT: perfectTap(p) + ((k * 7) % 5 - 2) * 0.006, aim: ((k * 3) % 5 - 2) / 2 });
      out.push(JSON.stringify([r.kind, r.exitVelo, r.launch, r.spray, r.distance, r.contact, r.timingLabel, r.bonus, r.path && Array.from(r.path.pts.slice(-8)).map(v => v.toFixed(4))]));
      R.apply(r);
    }
    return out.join('\n') + JSON.stringify(R.summary());
  };
  assert.equal(run(), run());
  // resolving the same pitch twice (e.g. a re-render) gives the same outcome
  const R = createRound({ charId: 'nova', parkId: 'rate', seed: 5 }); const p = R.nextPitch();
  const r1 = R.resolveSwing(p, { tapT: perfectTap(p) + 0.01, aim: 0.2 }), r2 = R.resolveSwing(p, { tapT: perfectTap(p) + 0.01, aim: 0.2 });
  assert.equal(JSON.stringify({ ...r1, path: null }), JSON.stringify({ ...r2, path: null }));
});

// ---------------------------------------------------------------------------- pitches
test('pitches: trajectory endpoints, flight time, contact plane, continues to the backstop', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const R = createRound({ charId: 'blaze', parkId: 'wrigley', seed });
    for (let k = 0; k < 30; k++) {
      const p = R.nextPitch();
      near(p.flightTime, 54 / (p.mph * TUNING.mph) * TUNING.pitchTimeScale, 1e-9, 'flightTime');
      const r = p.posAt(0); RELEASE.forEach((v, i) => near(r[i], v, 1e-9, 'release'));
      const e = p.posAt(p.flightTime); near(e[0], p.plateLoc[0], 1e-9, 'plate x'); near(e[1], p.plateLoc[1], 1e-9, 'plate y'); near(e[2], 0, 1e-9, 'plate z');
      near(p.posAt(p.tArrive)[2], TUNING.contactZ, 1e-9, 'contact plane');
      const b = p.posAt(p.flightTime + 0.6); assert.ok(b.every(Number.isFinite) && b[2] > 10 && b[1] >= SIM_K.ballR - 1e-9, 'past the plate');
      const [lo, hi] = PITCHES[p.type].mph; assert.ok(p.mph >= lo && p.mph <= hi, `${p.type} ${p.mph} in range`);
      assert.equal(p.label, PITCHES[p.type].label);
      assert.equal(p.inZone, p.plateLoc[0] >= ZONE.x[0] && p.plateLoc[0] <= ZONE.x[1] && p.plateLoc[1] >= ZONE.y[0] && p.plateLoc[1] <= ZONE.y[1]);
      // gentle arc: mid-flight height above the straight line
      if (p.type === 'meatball') { const m = p.posAt(p.flightTime / 2); assert.ok(m[1] > (RELEASE[1] + p.plateLoc[1]) / 2, 'arc'); }
    }
  }
});

test('pitches: mix follows pitchMix(n); speed and spread ramp; 15-25% of later pitches are balls', () => {
  const allowed = n => Object.keys(pitchMix(n));
  let fastEarly = [], fastLate = [], outLate = 0, late = 0, spreadEarly = [], spreadLate = [];
  for (let seed = 1; seed <= 400; seed++) for (let n = 1; n <= 30; n++) {
    const q = pitchAt(seed, n);
    assert.ok(allowed(n).includes(q.type), `n${n} ${q.type}`);
    if (n <= 3) { assert.equal(q.type, 'meatball'); assert.ok(Math.abs(q.px) < 0.2 && Math.abs(q.py - 2.55) < 0.2, 'early pitches near middle-middle'); }
    if (q.type === 'fastball' && n <= 7) fastEarly.push(q.mph);
    if (q.type === 'fastball' && n >= 19) fastLate.push(q.mph);
    if (n <= 5 && q.inZone) spreadEarly.push(Math.hypot(q.px, q.py - 2.55));
    if (n >= 19 && q.inZone) spreadLate.push(Math.hypot(q.px, q.py - 2.55));
    if (n >= 13) { late++; if (!q.inZone) outLate++; }
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(fastLate) > mean(fastEarly) + 3, `fastballs get faster: ${mean(fastEarly).toFixed(1)} → ${mean(fastLate).toFixed(1)}`);
  assert.ok(mean(spreadLate) > mean(spreadEarly) * 2, 'locations spread with the ramp');
  const f = outLate / late; assert.ok(f >= 0.15 && f <= 0.25, `later pitches outside the zone: ${(f * 100).toFixed(1)}%`);
});

test('pitches: breaking balls break late (ease-in after breakStart)', () => {
  let found = 0;
  for (let seed = 1; seed <= 60 && found < 20; seed++) for (let n = 13; n <= 30; n++) {
    const q = pitchAt(seed, n); if (!BREAKING.has(q.type)) continue;
    const R = createRound({ charId: 'rocco', seed }); let p; for (let k = 0; k < n; k++) p = R.nextPitch();
    const T = PITCHES[p.type], ft = p.flightTime;
    const straight = u => [RELEASE[0] + (p.plateLoc[0] - T.move[0] - RELEASE[0]) * u, RELEASE[2] * (1 - u)];
    const dxAt = u => p.posAt(u * ft)[0] - straight(u)[0];
    near(dxAt(T.breakStart * 0.9), 0, 1e-9, 'no break before breakStart');
    near(dxAt(1), T.move[0], 1e-9, 'full break at the plate');
    assert.ok(Math.abs(dxAt((1 + T.breakStart) / 2)) < Math.abs(T.move[0]) * 0.3, 'ease-in (quarter of the break halfway through the break phase)');
    found++;
  }
  assert.ok(found >= 10);
});

test('pitches: eye — clockRate, read ring timing and pre-break location', () => {
  const pitchFor = (charId, pred) => { for (let seed = 1; seed < 200; seed++) { const R = createRound({ charId, seed }); for (let k = 0; k < 30; k++) { const p = R.nextPitch(); if (pred(p)) return p; } } };
  const isCurve = p => p.type === 'curveball';
  const dex = pitchFor('dex', isCurve), rocco = pitchFor('rocco', isCurve), nova = pitchFor('nova', isCurve);
  assert.equal(rocco.clockRate(0), 1); assert.equal(rocco.clockRate(rocco.flightTime), 1);
  assert.equal(dex.clockRate(0), 1);
  near(dex.clockRate(dex.flightTime * 0.95), 1 - TUNING.eyeSlowAmount, 1e-9, 'Dex slow-down near the plate');
  near(nova.clockRate(nova.flightTime * 0.95), 1 - TUNING.eyeSlowAmount * 0.25, 1e-9, 'Nova (readBonus .25)');
  assert.ok(dex.clockRate(dex.flightTime * (1 - TUNING.eyeSlowFrac) - 0.01) === 1, 'normal speed before the slow zone');
  assert.equal(dex.clockRate(dex.flightTime + 2), 1, 'back to normal after the pitch');
  near(rocco.ring.showAt, rocco.flightTime * TUNING.ringShowFrac, 1e-9);
  near(dex.ring.showAt, dex.flightTime * TUNING.ringShowFracEye, 1e-9);
  assert.deepEqual(dex.ring.preLoc, dex.ring.trueLoc, 'the eye sees the break early');
  assert.deepEqual(rocco.ring.trueLoc, rocco.plateLoc);
  near(rocco.plateLoc[1] - rocco.ring.preLoc[1], PITCHES.curveball.move[1], 0.011, 'preLoc = location without the break');
  assert.ok(rocco.ring.snapAt > rocco.ring.showAt && rocco.ring.snapAt < rocco.flightTime);
  const meat = pitchFor('rocco', p => p.type === 'meatball'); assert.deepEqual(meat.ring.preLoc, meat.plateLoc);
});

// ---------------------------------------------------------------------------- flight calibration
// v2: Statcast-like top end (v1's 115@30≈475 / 119@28≈507 over-carried the monster shots)
const CAL = [[95, 25, 326], [100, 28, 367], [105, 28, 400], [110, 28, 433], [115, 30, 464], [119, 28, 491]];
test('flight: calibration table (no wind) within ±8 ft', () => {
  for (const [ev, la, tgt] of CAL) near(dist(ev, la), tgt, 8, `${ev} mph @ ${la}°`);
});
test('flight: wind 10 mph straight out ≈ +25-35 ft on a ~400 ft drive, in ≈ same loss; windScale', () => {
  const base = dist(105, 28);
  const out = dist(105, 28, { wind: { mph: 10, dir: 0 } }) - base, inn = base - dist(105, 28, { wind: { mph: 10, dir: 180 } });
  assert.ok(out >= 25 && out <= 35, `out +${out.toFixed(1)}`); assert.ok(inn >= 25 && inn <= 35, `in −${inn.toFixed(1)}`);
  const rateOut = dist(105, 28, { wind: { mph: 10, dir: 0 } }, 0, 'rate') - dist(105, 28, CALM, 0, 'rate');
  assert.ok(rateOut > out * 0.45 && rateOut < out * 0.75, `Rate windScale 0.6: +${rateOut.toFixed(1)}`);
  // crosswind pushes the ball sideways toward where it blows
  const f = fly(105, 28, 0, { wind: { mph: 15, dir: 90 } }); assert.ok(f.landing[0] > 5, 'blows toward RF');
});
test('flight: WEATHER.carry acts as a distance multiplier (±1%)', () => {
  const base = dist(105, 28);
  for (const w of ['heat', 'drizzle', 'overcast']) {
    const ratio = dist(105, 28, { weather: w }) / base; near(ratio, { heat: 1.03, drizzle: 0.97, overcast: 0.99 }[w], 0.01, w);
  }
});
test('flight: shape — optimum launch 26-34°, pop-ups and grounders short', () => {
  for (const ev of [95, 105, 115]) {
    let best = 0, bl = 0; for (let la = 15; la <= 45; la++) { const d = dist(ev, la); if (d > best) { best = d; bl = la; } }
    assert.ok(bl >= 26 && bl <= 34, `${ev} mph optimum ${bl}°`);
    assert.ok(dist(ev, 65) < best * 0.6, 'pop-up short'); assert.ok(dist(ev, 2) < 160, 'grounder short');
  }
});

// ---------------------------------------------------------------------------- fence / HR edge cases
test('fence: HR iff the ball crosses fenceDistance above fenceH + 0.25 (both parks, several sprays)', () => {
  for (const park of ['wrigley', 'rate']) for (const spray of [-40, -20, 0, 15, 35]) {
    const P = PARKS[park], fr = fenceDistance(park, spray);
    const ev = bisectEv(80, 125, e => simulateFlight(park, { exitVelo: e, launch: 24, spray, conditions: CALM, from: FROM, samples: false }).cleared);
    const over = simulateFlight(park, { exitVelo: ev, launch: 24, spray, conditions: CALM, from: FROM });
    const under = simulateFlight(park, { exitVelo: ev - 0.002, launch: 24, spray, conditions: CALM, from: FROM });
    assert.ok(over.cleared && !under.cleared, `${park} ${spray}: edge found`);
    const top = P.fenceH + 0.25;
    assert.ok(over.fenceY > top && over.fenceY < top + 0.1, `${park} ${spray}: cleared at y=${over.fenceY.toFixed(3)}`);
    assert.ok(under.wall && under.event === 'wall' && under.fenceY <= top && under.fenceY > top - 0.1, `${park} ${spray}: just under → off the wall (y=${under.fenceY.toFixed(3)})`);
    near(under.landing[1], under.fenceY, 1e-9, 'hits the wall at that height');
    assert.ok(Array.from(under.pts).some((v, i) => i % 4 === 2 && Math.abs(v - under.fenceY) < 1e-3), 'path includes the wall impact');
    near(fenceDistance(park, over.fenceSpray), fr, 0.5);
    near(Math.hypot(under.landing[0], under.landing[2]), fr - 0.3, 0.5, 'wall impact at the fence');
    assert.ok(Math.hypot(under.rest[0], under.rest[2]) < fr, 'wall ball rebounds into the field');
    assert.ok(over.fenceT > 0 && Math.abs(over.fenceSpray - spray) < 1.5, 'fenceT / fenceSpray');
    const b = battedBall(park, { exitVelo: ev - 0.002, launch: 24, spray, conditions: CALM, from: FROM, samples: false });
    assert.ok(b.kind !== 'homer' && b.wall, 'wall ball is an out'); near(b.distance, fr, 1, 'wall ball distance = where it hit');
  }
});
test('fence: homers come to rest on surfaceHeight(); projected distance ≥ landing distance', () => {
  for (const park of ['wrigley', 'rate']) for (const [ev, la, sp] of [[108, 28, -25], [112, 26, 20], [118, 30, -38], [121, 29, 30], [110, 35, 5]]) {
    const f = simulateFlight(park, { exitVelo: ev, launch: la, spray: sp, conditions: CALM, from: FROM });
    if (!f.cleared || f.hitBoard) continue;
    const s = Math.atan2(f.rest[0], -f.rest[2]) * 180 / Math.PI, r = Math.hypot(f.rest[0], f.rest[2]);
    near(f.rest[1], surfaceHeight(park, s, r), 0.2, `${park} ${ev}/${la}/${sp} at rest on the surface`);
    assert.ok(r > fenceDistance(park, s), 'beyond the fence'); assert.ok(f.distance >= r - 1, 'projected ≥ landing');
  }
});
test('fence: Wrigley bonus zones — Waveland, Sheffield, rooftops', () => {
  const find = (sprays, pred) => { for (const sp of sprays) for (let ev = 105; ev <= 125; ev += 0.5) for (const la of [24, 28, 32]) { const b = battedBall('wrigley', { exitVelo: ev, launch: la, spray: sp, conditions: CALM, from: FROM, samples: false }); if (pred(b)) return b; } return null; };
  assert.ok(find([-40, -35, -12, -10], b => b.bonus === 'street_l' && b.outOfPark), 'ON WAVELAND reachable (out of the park)');
  assert.ok(find([30, 35, 40, 12], b => b.bonus === 'street_r' && b.outOfPark), 'ON SHEFFIELD reachable (out of the park)');
  const roof = find([-35, -30, 30, 35], b => b.bonus === 'rooftop'); assert.ok(roof, 'rooftop reachable');
  assert.equal(roof.flight.rest[1], PARKS.wrigley.rooftops.h + SIM_K.ballR * 0.5, 'rests on the roof');
  const seats = battedBall('wrigley', { exitVelo: 104, launch: 28, spray: -30, conditions: CALM, from: FROM });
  assert.equal(seats.kind, 'homer'); assert.equal(seats.bonus, null, 'first rows of the bleachers = plain homer');
});

// ---------------------------------------------------------------------------- scoreboard
test('scoreboard: face hit (hitBoard) vs over the top (clearedBoard) — both parks', () => {
  for (const park of ['wrigley', 'rate']) {
    const sb = PARKS[park].scoreboard, rb = scoreboardDistance(park, 0);
    let hit = null, over = null;
    for (let la = 20; la <= 45 && !(hit && over); la += 1) for (let ev = 110; ev <= 125 && !(hit && over); ev += 0.5) {
      const f = simulateFlight(park, { exitVelo: ev, launch: la, spray: 0, conditions: { wind: { mph: park === 'rate' ? 25 : 12, dir: 0 } }, from: FROM });
      if (!hit && f.hitBoard && f.event === 'board') hit = f;
      if (!over && f.clearedBoard) over = f;
    }
    assert.ok(hit, `${park}: a ball can hit the board`);
    near(Math.hypot(hit.landing[0], hit.landing[2]), rb - 0.3, 0.6, 'hits the face'); assert.ok(hit.landing[1] < sb.h && hit.cleared);
    assert.equal(battedBall(park, { exitVelo: 0, launch: 0 }).kind, 'grounder');
    const cls = (f) => f.clearedBoard ? 'over_cf' : f.hitBoard ? 'board' : null;
    assert.equal(cls(hit), 'board');
    if (park === 'wrigley') { assert.ok(over, 'wrigley: a ball can clear the board'); assert.equal(cls(over), 'over_cf'); assert.ok(Math.hypot(over.rest[0], over.rest[2]) > rb + sb.depth); }
    // outside the board's spray range there is no board
    const side = simulateFlight(park, { exitVelo: 122, launch: 30, spray: sb.spray[1] + 3, conditions: CALM, from: FROM });
    assert.ok(!side.hitBoard && !side.clearedBoard);
  }
});

// ---------------------------------------------------------------------------- foul lines
test('foul lines: |spray| > 45 is foul, fair just inside, wind can push a drive foul', () => {
  for (const park of ['wrigley', 'rate']) {
    assert.equal(battedBall(park, { exitVelo: 115, launch: 28, spray: 46, conditions: CALM, from: FROM }).kind, 'foul');
    assert.equal(battedBall(park, { exitVelo: 115, launch: 28, spray: -46, conditions: CALM, from: FROM }).kind, 'foul');
    assert.equal(battedBall(park, { exitVelo: 115, launch: 28, spray: 43, conditions: CALM, from: FROM }).kind, 'homer');
    assert.equal(battedBall(park, { exitVelo: 115, launch: 28, spray: -43, conditions: CALM, from: FROM }).kind, 'homer');
    const blown = battedBall(park, { exitVelo: 115, launch: 30, spray: -43.5, conditions: { wind: { mph: 25, dir: -90 } }, from: FROM });
    assert.equal(blown.kind, 'foul', `${park}: wind carries it foul (crossed at ${blown.flight.fenceSpray && blown.flight.fenceSpray.toFixed(1)}°)`);
    assert.equal(battedBall(park, { exitVelo: 60, launch: -5, spray: 46 }).kind, 'foul', 'foul grounder');
  }
});

// ---------------------------------------------------------------------------- takes
test('takes: in-zone = strike (out, streak resets); outside = ball (nothing)', () => {
  const R = createRound({ charId: 'nova', seed: 3 });
  let strikes = 0, balls = 0;
  for (let seed = 1; seed < 400 && (strikes < 2 || balls < 2); seed++) for (let n = 13; n <= 30; n++) {
    const q = pitchAt(seed, n); const fake = { n, plateLoc: [q.px, q.py], inZone: q.inZone };
    const t = R.resolveTake(fake);
    if (!q.inZone && balls < 2) {
      R.apply(homerResult(400)); const st = R.streak;
      assert.equal(t.kind, 'ball'); const o = R.outs, a = R.apply(t);
      assert.equal(a.out, false); assert.equal(R.outs, o); assert.equal(a.scoreDelta, 0); assert.equal(R.streak, st, 'a ball keeps the streak'); balls++;
    } else if (q.inZone && strikes < 2) {
      assert.equal(t.kind, 'strike'); const o = R.outs, a = R.apply(t);
      assert.equal(a.out, true); assert.equal(R.outs, o + 1); assert.equal(R.streak, 0); strikes++;
      assert.ok(a.callouts.some(c => c.text === 'CALLED STRIKE'));
    }
  }
  assert.equal(strikes, 2); assert.equal(balls, 2);
});

// ---------------------------------------------------------------------------- swing model
test('swing: contact time = tapT − inputLatencyComp + swingLead; timing labels; whiffs', () => {
  const R = createRound({ charId: 'rocco', seed: 11 }); const p = R.nextPitch(); const w = CHAR_BY_ID.rocco.swing.window * (TUNING.assistWindow || 1);
  const at = e => R.resolveSwing(p, { tapT: perfectTap(p) + e * w, aim: 0, samples: false });
  const s0 = at(0); near(s0.timingErr, 0, 1e-12); near(s0.contactT, perfectTap(p) - TUNING.inputLatencyComp + TUNING.swingLead, 1e-12);
  near(s0.contactT, p.tArrive, 1e-12); s0.contactPos.forEach((v, i) => near(v, p.posAt(s0.contactT)[i], 1e-12));
  const lateHit = at(1.4); near(lateHit.rawContactT, perfectTap(p) + 1.4 * w - TUNING.inputLatencyComp + TUNING.swingLead, 1e-12);
  assert.ok(lateHit.contactT <= p.tArrive + 0.05 + 1e-12, 'contactT clamped to a hittable depth'); lateHit.contactPos.forEach((v, i) => near(v, p.posAt(lateHit.contactT)[i], 1e-12));
  assert.equal(s0.timingLabel, 'PERFECT');
  assert.equal(at(-1).timingLabel, 'EARLY'); assert.equal(at(1).timingLabel, 'LATE');
  assert.equal(at(-2).timingLabel, 'WAY EARLY'); assert.equal(at(2).timingLabel, 'WAY LATE');
  assert.equal(at(CHAR_BY_ID.rocco.swing.whiffAt + 0.01).kind, 'whiff'); assert.equal(at(-CHAR_BY_ID.rocco.swing.whiffAt - 0.01).contact, 'miss');
  near(at(0.5).timingErr, 0.5 * w, 1e-12, '+ = late');
  const early = R.resolveSwing(p, { tapT: -0.2, aim: 0 }); assert.equal(early.kind, 'whiff', 'swinging during the windup');
});

test('swing: fair — perfect timing + location-matched aim homers the vast majority of the time (every fox, both parks)', () => {
  for (const c of CHARACTERS) for (const park of ['wrigley', 'rate']) {
    let n = 0, h = 0, h0 = 0, hb = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const R = createRound({ charId: c.id, parkId: park, seed: 5000 + seed, conditions: CALM });
      for (let k = 0; k < 30; k++) {
        const p = R.nextPitch(); if (!p.inZone) continue;
        const aim = idealAim(c, p.plateLoc[0], p.type), uppercut = idealUppercut(c, p.plateLoc[1], p.type);
        const r = R.resolveSwing(p, { tapT: perfectTap(p), aim, uppercut, samples: false });
        const r0 = R.resolveSwing(p, { tapT: perfectTap(p), aim, samples: false });                        // level swing
        const rb = R.resolveSwing(p, { tapT: perfectTap(p, 0.95), aim, uppercut, batSpeed: 0.95, samples: false }); // swiping hard
        n++; if (r.kind === 'homer') h++; if (r0.kind === 'homer') h0++; if (rb.kind === 'homer') hb++;
        assert.ok(r.timingLabel === 'PERFECT' && rb.timingLabel === 'PERFECT');
      }
    }
    assert.ok(h / n >= 0.85, `${c.id} @ ${park}: ${(100 * h / n).toFixed(0)}% homers (matched uppercut)`);
    assert.ok(hb / n >= 0.85, `${c.id} @ ${park}: ${(100 * hb / n).toFixed(0)}% homers (hard swipe)`);
    assert.ok(h0 / n >= 0.72, `${c.id} @ ${park}: ${(100 * h0 / n).toFixed(0)}% homers (level swing)`);
  }
});

test('swing: early pulls, late goes the other way (both sides); aim steers spray', () => {
  for (const charId of ['nova', 'skye']) {
    const bats = CHAR_BY_ID[charId].bats, pullSign = bats === 'R' ? -1 : 1, w = CHAR_BY_ID[charId].swing.window;
    let e = 0, l = 0, left = 0, right = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const R = createRound({ charId, seed }); const p = R.nextPitch();
      e += R.resolveSwing(p, { tapT: perfectTap(p) - 0.9 * w, aim: 0, samples: false }).spray;
      l += R.resolveSwing(p, { tapT: perfectTap(p) + 0.9 * w, aim: 0, samples: false }).spray;
      left += R.resolveSwing(p, { tapT: perfectTap(p), aim: -0.8, samples: false }).spray;
      right += R.resolveSwing(p, { tapT: perfectTap(p), aim: 0.8, samples: false }).spray;
    }
    assert.ok(e * pullSign > 0 && l * pullSign < 0, `${charId}: early → pull side, late → oppo`);
    assert.ok(left / 40 < -15 && right / 40 > 15, 'aim −0.8 → LF, +0.8 → RF');
  }
});

test('swing: pitch height — low pitch launches lower (topped), high pitch higher (under)', () => {
  let low = [], high = [];
  for (let seed = 1; seed <= 300; seed++) for (let n = 8; n <= 30; n++) {
    const q = pitchAt(seed, n); if (Math.abs(q.px) > 0.5) continue;
    if (q.py < 1.9 || q.py > 3.2) {
      const R = createRound({ charId: 'nova', seed }); let p; for (let k = 0; k < n; k++) p = R.nextPitch();
      const r = R.resolveSwing(p, { tapT: perfectTap(p), aim: idealAim('nova', p.plateLoc[0], p.type), samples: false });
      if (r.kind === 'whiff') continue;
      (q.py < 1.9 ? low : high).push(r.launch);
    }
    if (low.length > 40 && high.length > 40) break;
  }
  const m = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(m(high) > m(low) + 6, `launch low ${m(low).toFixed(1)}° vs high ${m(high).toFixed(1)}°`);
});

test('swing: aim mismatch — oppo on an inside pitch jams, pulling an outside pitch rolls over', () => {
  const R = createRound({ charId: 'rocco', seed: 21 }); const p = R.nextPitch();
  const inside = { ...p, plateLoc: [-0.75, 2.55] }, outside = { ...p, plateLoc: [0.75, 2.55] }; // Rocco bats R: −x is inside
  assert.ok(insideness('R', -0.75) > 0.8 && insideness('L', -0.75) < -0.8);
  const band = aimBand('rocco', -0.75, p.type); assert.ok(band[0] <= idealAim('rocco', -0.75, p.type) && idealAim('rocco', -0.75, p.type) <= band[1]);
  const jam = R.resolveSwing(inside, { tapT: perfectTap(p), aim: 1, samples: false });
  const roll = R.resolveSwing(outside, { tapT: perfectTap(p), aim: -1, samples: false });
  const good = R.resolveSwing(inside, { tapT: perfectTap(p), aim: idealAim('rocco', -0.75, p.type), samples: false });
  assert.ok(jam.q.aim < 0.6 && roll.q.aim < 0.6 && good.q.aim === 1, 'mismatch costs quality');
  assert.ok(['jammed', 'topped', 'under'].includes(jam.contact), 'jammed: ' + jam.contact);
  assert.ok(['off the end', 'topped', 'under'].includes(roll.contact), 'off the end: ' + roll.contact);
  // a contact hitter (bigger aimTol) shrugs the same mismatch off better
  const J = createRound({ charId: 'jett', seed: 21 }); const pj = J.nextPitch();
  const jj = J.resolveSwing({ ...pj, plateLoc: [0.75, 2.55] }, { tapT: perfectTap(pj), aim: -0.3, samples: false }); // Jett bats L: +x inside
  const rj = R.resolveSwing(inside, { tapT: perfectTap(p), aim: 0.3, samples: false });
  assert.ok(jj.q.aim > rj.q.aim, 'aimTol matters');
});

test('swing: character traits — Blaze vs breaking, Skye streak power, Rocco biggest EV', () => {
  const findPitch = (seed, pred) => { const R = createRound({ charId: 'blaze', seed }); for (let k = 0; k < 40; k++) { const p = R.nextPitch(); if (pred(p)) return [R, p]; } return [null, null]; };
  let [R, p] = [null, null]; for (let s = 1; !p; s++) [R, p] = findPitch(s, q => q.type === 'slider' && q.inZone);
  const w = CHAR_BY_ID.blaze.swing.window * CHAR_BY_ID.blaze.swing.breakWindowMul * (TUNING.assistWindow || 1);
  assert.equal(R.resolveSwing(p, { tapT: perfectTap(p) + 1.2 * w, aim: 0, samples: false }).timingLabel, 'LATE', 'Blaze window shrinks vs breaking');
  near(R.resolveSwing(p, { tapT: perfectTap(p) + 0.03, aim: 0, samples: false }).q.t, Math.exp(-((0.03 / w) ** 2)), 1e-9);
  // Skye: same swing, higher EV with a streak going
  const S = createRound({ charId: 'skye', seed: 9 }); const ps = S.nextPitch();
  const ev0 = S.resolveSwing(ps, { tapT: perfectTap(ps), aim: 0.5, samples: false }).exitVelo;
  for (let k = 0; k < 5; k++) S.apply(homerResult(400));
  const ev5 = S.resolveSwing(ps, { tapT: perfectTap(ps), aim: 0.5, samples: false }).exitVelo;
  assert.ok(ev5 - ev0 > 0.8 * SIM_K.streakPost * CHAR_BY_ID.skye.swing.streakEvCap, `Skye +${(ev5 - ev0).toFixed(1)} mph on a 5-homer streak`);
  const evMax = id => { const Rx = createRound({ charId: id, seed: 9 }); const px = Rx.nextPitch(); return Rx.resolveSwing(px, { tapT: perfectTap(px), aim: 0, samples: false }).exitVelo; };
  const evs = CHARACTERS.map(c => [c.id, evMax(c.id)]).sort((a, b) => b[1] - a[1]);
  assert.equal(evs[0][0], 'rocco', JSON.stringify(evs));
});

test('swing: path format — Float32Array [t,x,y,z] at 1/60 s from contact to rest', () => {
  let checked = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const R = createRound({ charId: 'rocco', parkId: seed % 2 ? 'wrigley' : 'rate', seed });
    const p = R.nextPitch(); const r = R.resolveSwing(p, { tapT: perfectTap(p) + (seed % 3) * 0.01, aim: (seed % 5 - 2) / 3 });
    if (!r.path) continue;
    const pts = r.path.pts; assert.ok(pts instanceof Float32Array && pts.length % 4 === 0 && pts.length >= 8);
    assert.equal(pts[0], 0); near(pts[1], r.contactPos[0], 1e-4); near(pts[2], r.contactPos[1], 1e-4); near(pts[3], r.contactPos[2], 1e-4);
    for (let i = 4; i < pts.length; i += 4) { const dt = pts[i] - pts[i - 4]; assert.ok(dt > 0 && dt <= 1 / 60 + 1e-3, 'monotonic 60 Hz'); }
    const last = pts.length - 4; assert.deepEqual(Array.from(pts.slice(last + 1)), Array.from(new Float32Array(r.path.rest)), 'ends at rest');
    assert.ok(pts[last] <= TUNING.maxFlightTime + SIM_K.maxPostTime + 0.1);
    if (r.kind === 'homer') assert.ok(r.path.fenceT > 0 && r.path.fenceT < r.hangTime + 1e-9);
    assert.ok(r.path.apex[1] >= Math.max(pts[2], 0) - 1e-6);
    checked++;
  }
  assert.ok(checked > 15);
});

// ---------------------------------------------------------------------------- scoring
test('scoring: distance × streak multiplier, streak callouts, reset on out', () => {
  const R = createRound({ charId: 'jett', parkId: 'rate', seed: 1, personalBest: 1000 });
  const exp = [[400, 1, null], [400, 1.5, 'BACK-TO-BACK ×1.5'], [400, 2, 'B2B2B ×2'], [400, 2.5, '4 STRAIGHT ×2.5'], [400, 3, 'ON FIRE ×3'], [400, 3, 'ON FIRE ×3']];
  let total = 0;
  exp.forEach(([d, m, txt], i) => {
    const a = R.apply(homerResult(d));
    assert.equal(a.mult, m); assert.equal(a.scoreDelta, Math.round(d * m)); assert.equal(a.streak, i + 1); assert.equal(a.out, false);
    if (txt) assert.ok(a.callouts.some(c => c.text === txt && c.kind === 'streak'), txt); else assert.ok(!a.callouts.some(c => c.kind === 'streak'));
    assert.equal(a.callouts.reduce((s, c) => s + c.points, 0), a.scoreDelta, 'callout points add up');
    total += a.scoreDelta;
  });
  assert.equal(R.score, total); assert.equal(R.bestStreak, 6); assert.equal(R.homers, 6); assert.equal(R.longest, 400);
  const o = R.apply(outResult('flyout'));
  assert.equal(o.out, true); assert.equal(o.streak, 0); assert.equal(R.outs, 1);
  assert.ok(o.callouts.some(c => c.text === 'STREAK ENDS AT 6'));
  assert.equal(R.apply(homerResult(380)).mult, 1, 'streak starts over');
});

test('scoring: clutch ×1.5 on the last out, stacks with the streak', () => {
  const R = createRound({ charId: 'nova', seed: 1, personalBest: 1000 });
  for (let k = 0; k < OUTS_PER_ROUND - 1; k++) R.apply(outResult());
  assert.equal(R.outs, 9);
  const a = R.apply(homerResult(410)); assert.equal(a.mult, 1.5); assert.equal(a.scoreDelta, Math.round(410 * 1.5));
  assert.ok(a.callouts.some(c => c.text === 'CLUTCH ×1.5'));
  const b = R.apply(homerResult(400)); assert.equal(b.mult, 1.5 * 1.5); assert.equal(b.scoreDelta, Math.round(400 * 2.25));
  assert.ok(b.callouts.some(c => c.text === 'BACK-TO-BACK ×1.5') && b.callouts.some(c => c.text === 'CLUTCH ×1.5'));
  assert.equal(b.callouts.reduce((s, c) => s + c.points, 0), b.scoreDelta);
  assert.equal(b.roundOver, false);
});

test('scoring: park bonuses, moonshot / way out, new record (once per new best)', () => {
  const W = PARKS.wrigley.bonus, RB = PARKS.rate.bonus;
  const R = createRound({ charId: 'rocco', parkId: 'wrigley', seed: 1, personalBest: 440 });
  let a = R.apply(homerResult(430, { bonus: 'street_l' }));
  assert.equal(a.scoreDelta, 430 + W.street_l.points); assert.ok(a.callouts.some(c => c.text === `ON WAVELAND! +${W.street_l.points}` && c.key === 'street_l' && c.outOfPark));
  assert.ok(a.events.includes('outOfPark'), 'Waveland = out of the park');
  R.apply(outResult());
  a = R.apply(homerResult(455)); assert.equal(a.scoreDelta, 455 + 100 + 250);
  assert.ok(a.callouts.some(c => c.text === 'MOONSHOT +100') && a.callouts.some(c => c.text === 'NEW RECORD +250'));
  assert.ok(!a.events.includes('outOfPark'));
  R.apply(outResult());
  a = R.apply(homerResult(450)); assert.ok(!a.callouts.some(c => c.kind === 'record'), 'not a new best'); assert.equal(a.scoreDelta, 450 + 100);
  R.apply(outResult());
  a = R.apply(homerResult(512, { bonus: 'over_cf' }));
  assert.equal(a.scoreDelta, 512 + W.over_cf.points + 250 + 250, 'over the board + way out (not also moonshot) + record');
  assert.ok(a.callouts.some(c => c.text === `OVER THE SCOREBOARD! +${W.over_cf.points}`) && a.callouts.some(c => c.text === 'WAY OUT +250') && !a.callouts.some(c => c.kind === 'moonshot'));
  assert.equal(R.longest, 512);
  a = R.apply(homerResult(420, { bonus: 'videoboard' })); assert.equal(a.scoreDelta, Math.round(420 * 1.5) + W.videoboard.points); assert.ok(!a.events.includes('outOfPark'), 'off the video board stays in the park');
  const Rt = createRound({ charId: 'nova', parkId: 'rate', seed: 1, personalBest: 0 });
  a = Rt.apply(homerResult(395, { bonus: 'concourse' })); assert.equal(a.scoreDelta, 395 + RB.concourse.points + 250, 'first homer at a park is a record');
  assert.ok(a.callouts.some(c => c.text === `CONCOURSE SHOT! +${RB.concourse.points}`)); assert.ok(!a.events.includes('outOfPark'), 'concourse is still in the park');
  a = Rt.apply(homerResult(505, { bonus: 'out_of_park' })); assert.ok(a.events.includes('outOfPark') && a.callouts.some(c => c.key === 'out_of_park'));
  assert.equal(Rt.summary().outOfPark, 1);
});

test('scoring: out callouts (wall / warning track / whiff), idempotent apply, round over at 10 outs', () => {
  const R = createRound({ charId: 'dex', parkId: 'wrigley', seed: 2 });
  assert.ok(R.apply(outResult('flyout', { wall: true, distance: 395 })).callouts.some(c => c.text === 'OFF THE WALL'));
  assert.ok(R.apply(outResult('flyout', { distance: 385, spray: 0 })).callouts.some(c => c.text === 'WARNING TRACK'));
  const w = outResult('whiff'); const a1 = R.apply(w), a2 = R.apply(w);
  assert.equal(a1, a2, 'same result applied twice counts once'); assert.equal(R.outs, 3);
  let last;
  while (!R.over) last = R.apply(outResult('grounder'));
  assert.equal(R.outs, OUTS_PER_ROUND); assert.equal(last.roundOver, true); assert.equal(R.over, true);
  assert.throws(() => R.nextPitch(), /over/);
  const after = R.apply(homerResult(500)); assert.equal(after.scoreDelta, 0); assert.equal(after.roundOver, true); assert.equal(R.homers, 0);
  const s = R.summary(); assert.equal(s.outs, 10); assert.equal(s.score, 0); assert.equal(s.avgDistance, 0);
});

test('round: full simulated rounds are consistent (score = Σ scoreDelta, summary, avgDistance)', () => {
  for (const c of CHARACTERS) {
    const R = createRound({ charId: c.id, parkId: c.bats === 'R' ? 'rate' : 'wrigley', seed: 99, conditions: { weather: 'clear', wind: { mph: 8, dir: 0 } } });
    let sum = 0, hrs = [], guard = 0;
    while (!R.over && guard++ < 300) {
      const p = R.nextPitch();
      const r = p.inZone || guard % 3 ? R.resolveSwing(p, { tapT: perfectTap(p) + ((guard * 37) % 11 - 5) * 0.006, aim: idealAim(c, p.plateLoc[0], p.type), samples: false }) : R.resolveTake(p);
      const a = R.apply(r); sum += a.scoreDelta; if (r.kind === 'homer') hrs.push(r.distance);
    }
    const s = R.summary();
    assert.equal(s.score, sum); assert.equal(s.homers, hrs.length); assert.equal(s.outs, 10);
    assert.equal(s.longest, hrs.length ? Math.max(...hrs) : 0);
    assert.equal(s.avgDistance, hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : 0);
  }
});

// ---------------------------------------------------------------------------- v2: swipe swing
test('v2 swing: swingLeadFor — 0.20 s lazy → 0.12 s button → 0.09 s max effort, monotonic; contact = tapT − latency + lead', () => {
  near(swingLeadFor(0), TUNING.swingLeadSlow, 1e-12); near(swingLeadFor(TUNING.batSpeedRef), TUNING.swingLead, 1e-12); near(swingLeadFor(1), TUNING.swingLeadFast, 1e-12);
  near(swingLeadFor(), TUNING.swingLead, 1e-12, 'default'); near(swingLeadFor(2), TUNING.swingLeadFast, 1e-12, 'clamped'); near(swingLeadFor(NaN), TUNING.swingLead, 1e-12);
  for (let b = 0; b < 1; b += 0.05) assert.ok(swingLeadFor(b + 0.05) < swingLeadFor(b), 'faster swing reaches the zone sooner');
  const R = createRound({ charId: 'nova', seed: 4 }); const p = R.nextPitch();
  for (const b of [0.2, 0.5, 0.72, 0.9, 1]) {
    const r = R.resolveSwing(p, { tapT: perfectTap(p, b), aim: 0, batSpeed: b, samples: false });
    near(r.timingErr, 0, 1e-12, 'perfectTap(p, b)'); near(r.leadT, swingLeadFor(b), 1e-12); near(r.contactT, p.tArrive, 1e-12);
    near(r.rawContactT, perfectTap(p, b) - TUNING.inputLatencyComp + swingLeadFor(b), 1e-12); assert.equal(r.batSpeed, b);
  }
  // the same swing START with a faster swipe meets the ball earlier (timing error goes negative)
  const t0 = perfectTap(p); assert.ok(R.resolveSwing(p, { tapT: t0, batSpeed: 1, samples: false }).timingErr < -0.02);
  assert.equal(batSpeedMph(0), TUNING.batMph[0]); assert.equal(batSpeedMph(1), TUNING.batMph[1]); assert.ok(batSpeedMph(0.72) >= 70 && batSpeedMph(0.72) <= 75);
});

test('v2 swing: bat speed — harder = more EV (on good contact) and a smaller window; lazy = weak contact; uppercut lofts', () => {
  const avg = (charId, b, u = 0, park = 'wrigley') => {
    let ev = 0, la = 0, n = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const R = createRound({ charId, parkId: park, seed: 900 + seed, conditions: CALM }); const p = R.nextPitch();
      const r = R.resolveSwing(p, { tapT: perfectTap(p, b), aim: idealAim(charId, p.plateLoc[0], p.type), batSpeed: b, uppercut: u, samples: false });
      if (r.kind === 'whiff') continue; ev += r.exitVelo; la += r.launch; n++;
    }
    return { ev: ev / n, la: la / n };
  };
  for (const c of ['rocco', 'jett']) {
    const lazy = avg(c, 0.3), ref = avg(c, TUNING.batSpeedRef), hard = avg(c, 1);
    assert.ok(hard.ev > ref.ev + 0.5 && ref.ev > lazy.ev + 5, `${c}: EV lazy ${lazy.ev.toFixed(1)} < button ${ref.ev.toFixed(1)} < max ${hard.ev.toFixed(1)}`);
    assert.ok(lazy.ev > 75, 'a lazy swing still makes contact');
  }
  const up = avg('nova', 0.72, 1), lvl = avg('nova', 0.72, 0), down = avg('nova', 0.72, -1);
  near(up.la - lvl.la, SIM_K.uppercutLaunch, 1.5, 'uppercut +1'); near(lvl.la - down.la, SIM_K.uppercutLaunch, 1.5, 'chop −1');
  // window: the same 30 ms late costs a max-effort swing more quality than a button swing
  const R = createRound({ charId: 'dex', seed: 7 }); const p = R.nextPitch();
  const qb = R.resolveSwing(p, { tapT: perfectTap(p, 0.72) + 0.03, batSpeed: 0.72, samples: false }).q.t;
  const qh = R.resolveSwing(p, { tapT: perfectTap(p, 1) + 0.03, batSpeed: 1, samples: false }).q.t;
  const ql = R.resolveSwing(p, { tapT: perfectTap(p, 0.3) + 0.03, batSpeed: 0.3, samples: false }).q.t;
  assert.ok(qh < qb && qb < ql, `timing quality at +30 ms: max ${qh.toFixed(3)} < button ${qb.toFixed(3)} < lazy ${ql.toFixed(3)}`);
  // resolveSwing input sanitising
  const r = R.resolveSwing(p, { tapT: perfectTap(p), batSpeed: 'x', uppercut: 7, samples: false }); assert.equal(r.batSpeed, TUNING.batSpeedRef); assert.equal(r.uppercut, 1);
  assert.equal(R.resolveSwing(p, { tapT: perfectTap(p, 1), batSpeed: 1, samples: false }).maxEffort, true);
});

// ---------------------------------------------------------------------------- v2: boards, Fan Deck, out of the park
test('v2 flight: video boards bounce the ball back into the bleachers (both parks); over the top leaves', () => {
  for (const park of ['wrigley', 'rate']) for (const vb of PARKS[park].videoBoards) {
    const sp = (vb.spray[0] + vb.spray[1]) / 2; let hit = null, over = null;
    for (let ev = 105; ev <= 124 && !(hit && over); ev += 0.25) for (const la of [26, 30, 34]) {
      const f = simulateFlight(park, { exitVelo: ev, launch: la, spray: sp, conditions: { wind: { mph: 18, dir: sp } }, from: FROM });
      if (!hit && f.videoBoard === vb.id) hit = f;
      if (!over && f.cleared && !f.videoBoard && Math.hypot(f.rest[0], f.rest[2]) > fenceDistance(park, sp) + PARKS[park].stands.depth + 1) over = f;
    }
    assert.ok(hit, `${park} ${vb.id} board can be hit`);
    assert.equal(hit.event, 'vboard');
    near(Math.hypot(hit.landing[0], hit.landing[2]), fenceDistance(park, Math.atan2(hit.landing[0], -hit.landing[2]) * 180 / Math.PI) + PARKS[park].stands.depth - 0.3, 0.8, 'hits the board face');
    assert.ok(hit.landing[1] <= vb.top + 0.01, 'below the top');
    const s = Math.atan2(hit.rest[0], -hit.rest[2]) * 180 / Math.PI, r = Math.hypot(hit.rest[0], hit.rest[2]);
    assert.ok(r < fenceDistance(park, s) + PARKS[park].stands.depth && r > fenceDistance(park, s), 'bounces back into the bleachers');
    near(hit.rest[1], surfaceHeight(park, s, r), 0.3, 'comes to rest on the seats');
    const b = battedBall(park, { exitVelo: 0, launch: 0 }); assert.ok(b);
    assert.equal(classifyLanding(park, { spray: s, r, y: hit.rest[1], videoBoard: hit.videoBoard }), 'videoboard');
    if (over) assert.ok(!over.videoBoard, `${park} ${vb.id}: can clear the board`);
  }
});

test('v2 flight: Rate Field Fan Deck — onto the deck or into its face, both "fan_deck"; in the park', () => {
  const fd = PARKS.rate.fanDeck; let top = null, face = null;
  for (let ev = 104; ev <= 124 && !(top && face); ev += 0.25) for (const la of [20, 24, 28, 32, 36]) for (const sp of [-4, 0, 4]) {
    const b = battedBall('rate', { exitVelo: ev, launch: la, spray: sp, conditions: CALM, from: FROM });
    if (b.flight.event === 'deck' && !top) top = b; if (b.flight.event === 'deckFace' && !face) face = b;
  }
  assert.ok(top && face, 'both reachable');
  near(top.flight.rest[1], fd.h + SIM_K.ballR * 0.5, 1e-9, 'rests on the deck');
  for (const b of [top, face]) { assert.equal(b.kind, 'homer'); assert.equal(b.bonus, 'fan_deck'); assert.equal(b.outOfPark, false); }
  const r = Math.hypot(face.flight.rest[0], face.flight.rest[2]), s = Math.atan2(face.flight.rest[0], -face.flight.rest[2]) * 180 / Math.PI;
  assert.ok(r - fenceDistance('rate', s) < fd.d[0], 'a face hit drops in front of the deck');
});

test('v2 out of the park: Wrigley street/rooftop/over the board = out; Rate concourse = in, beyond it = out', () => {
  assert.deepEqual(PARKS.wrigley.outOfPark.slice().sort(), ['over_cf', 'rooftop', 'street_l', 'street_r']);
  assert.ok(isOutOfPark('wrigley', 'street_l') && isOutOfPark('rate', 'out_of_park') && isOutOfPark('rate', 'over_cf'));
  assert.ok(!isOutOfPark('wrigley', 'videoboard') && !isOutOfPark('rate', 'concourse') && !isOutOfPark('rate', 'fan_deck') && !isOutOfPark('wrigley', null));
  const W = PARKS.wrigley, Rp = PARKS.rate;
  assert.equal(classifyLanding('wrigley', { spray: -38, r: fenceDistance('wrigley', -38) + W.stands.depth + 10, y: 0.1 }), 'street_l');
  assert.equal(classifyLanding('wrigley', { spray: 36, r: fenceDistance('wrigley', 36) + W.stands.depth + 10, y: 0.1 }), 'street_r');
  assert.equal(classifyLanding('wrigley', { spray: -40, r: fenceDistance('wrigley', -40) + W.stands.depth + W.street.width + 20, y: W.rooftops.h }), 'rooftop');
  assert.equal(classifyLanding('wrigley', { spray: -33, r: fenceDistance('wrigley', -33) + W.stands.depth + W.street.width + 20, y: 0 }), 'street_l', 'Kenmore Ave gap');
  assert.equal(classifyLanding('wrigley', { spray: -20, r: fenceDistance('wrigley', -20) + 20, y: 20 }), null, 'in the bleachers');
  assert.equal(classifyLanding('rate', { spray: -30, r: fenceDistance('rate', -30) + Rp.stands.depth + 10, y: Rp.street.h }), 'concourse');
  assert.equal(classifyLanding('rate', { spray: -30, r: fenceDistance('rate', -30) + Rp.stands.depth + Rp.street.width + 10, y: 0 }), 'out_of_park');
  // a real flight out of each park
  const out = (park, sprays) => { for (const sp of sprays) for (let ev = 110; ev <= 124; ev += 0.5) for (const la of [26, 30, 34]) { const b = battedBall(park, { exitVelo: ev, launch: la, spray: sp, conditions: { wind: { mph: 10, dir: sp } }, from: FROM }); if (b.outOfPark) return b; } return null; };
  const w = out('wrigley', [-40, 35, -12]); assert.ok(w && w.kind === 'homer' && W.outOfPark.includes(w.bonus), 'can leave Wrigley');
  const r = out('rate', [-44, -32, 32, 44]); assert.ok(r && r.bonus === 'out_of_park', 'can leave Rate Field');
  const rw = Math.hypot(r.flight.rest[0], r.flight.rest[2]); near(r.flight.rest[1], 0, 0.5, 'lands outside, at ground level');
  assert.ok(rw > fenceDistance('rate', r.flight.restSpray) + Rp.stands.depth + Rp.street.width);
  // resolveSwing reports it
  let found = null;
  for (let seed = 1; seed < 300 && !found; seed++) {
    const R = createRound({ charId: 'rocco', parkId: 'wrigley', seed, conditions: { wind: { mph: 16, dir: 0 } } }); const p = R.nextPitch();
    const s = R.resolveSwing(p, { tapT: perfectTap(p, 1), aim: idealAim('rocco', p.plateLoc[0], p.type), batSpeed: 1, uppercut: idealUppercut('rocco', p.plateLoc[1]) });
    if (s.outOfPark) found = [R, s];
  }
  assert.ok(found, 'a max-effort pull with the wind blowing out can leave Wrigley');
  const [R, s] = found; assert.ok(W.outOfPark.includes(s.bonus) && s.kind === 'homer');
  const a = R.apply(s); assert.ok(a.events.includes('outOfPark') && a.events.includes('homer'));
});

test('v2 round events: "wave" when the streak reaches 3, 6, 9 (not 1, 2, 4, 5, 7); streak resets', () => {
  const R = createRound({ charId: 'jett', seed: 1, personalBest: 1000 });
  const waves = [];
  for (let k = 1; k <= 10; k++) { const a = R.apply(homerResult(400)); if (a.events.includes('wave')) waves.push(k); assert.ok(a.events.includes('homer')); }
  assert.deepEqual(waves, [3, 6, 9]);
  const o = R.apply(outResult()); assert.ok(o.events.includes('streakEnd') && !o.events.includes('wave'));
  assert.ok(!R.apply(homerResult(400)).events.includes('wave') && !R.apply(homerResult(400)).events.includes('wave') && R.apply(homerResult(400)).events.includes('wave'), 'three more → wave again');
  assert.deepEqual(R.apply(R.resolveTake({ n: 99, plateLoc: [3, 3], inZone: false })).events, [], 'a ball → no events');
});

test('v2 limits: every homer ≤ TUNING.maxHomerFt ≤ 620 (any EV, launch, wind, weather); score bounds for the leaderboard Worker', () => {
  let maxD = 0;
  for (const park of ['wrigley', 'rate']) for (const la of [22, 25, 28, 31, 34]) for (const sp of [-30, 0, 30]) for (const w of ['heat', 'clear']) {
    const b = battedBall(park, { exitVelo: SIM_K.evCap, launch: la, spray: sp, conditions: { weather: w, wind: { mph: 20 * PARKS[park].windScale / PARKS[park].windScale, dir: sp } }, from: FROM, samples: false });
    if (b.kind === 'homer') maxD = Math.max(maxD, b.distance);
  }
  assert.ok(maxD <= TUNING.maxHomerFt && TUNING.maxHomerFt <= 620, `max homer ${maxD} ft`);
  assert.equal(createRound({ seed: 1 }).apply(homerResult(700)).callouts[0].text, `${TUNING.maxHomerFt} FT`, 'apply() caps the distance too');
  // the most a single homer can score: max distance × streak × clutch + biggest bonus + WAY OUT + NEW RECORD
  const bonusMax = Math.max(...Object.values(PARKS).flatMap(P => Object.values(P.bonus).map(b => b.points)));
  const perHr = TUNING.maxHomerFt * TUNING.streakMult[TUNING.streakMult.length - 1] * TUNING.clutchMult + bonusMax + TUNING.wayOutPts + TUNING.recordPts;
  const R = createRound({ charId: 'rocco', parkId: 'wrigley', seed: 1, personalBest: 0 });
  for (let k = 0; k < OUTS_PER_ROUND - 1; k++) R.apply(outResult());
  let d = 600, last = null; for (let k = 0; k < 8; k++) last = R.apply(homerResult(d += 1, { bonus: 'over_cf' }));
  assert.ok(last.scoreDelta <= perHr + 1, `single homer ${last.scoreDelta} ≤ ${perHr}`);
  assert.ok(R.score <= Math.ceil(perHr) * R.homers + 200, 'round score ≤ homers × PER_HR + 200');
  SIM_SELFTEST.limits = { perHomerMax: Math.ceil(perHr), maxHomerFt: TUNING.maxHomerFt };
});

// ----------------------------------------------------------------------------
for (const [s, n] of results) console.log(s, n);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
