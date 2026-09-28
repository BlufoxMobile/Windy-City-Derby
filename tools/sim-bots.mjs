#!/usr/bin/env node
// ============================================================================
// WINDY CITY DERBY — balance bots for src/sim.js.
//
//   node tools/sim-bots.mjs                       # 300 rounds × 6 foxes × 4 bots × 2 parks, tables + target check
//   node tools/sim-bots.mjs --rounds 100 --bots good --parks wrigley
//   node tools/sim-bots.mjs --json scratch/sim/bots.json
//   node tools/sim-bots.mjs --calm                # no wind / clear weather instead of random free-play conditions
//   node tools/sim-bots.mjs --patch '{"jett":{"evMax":107}}'   # try proposed CHARACTERS[].swing changes (in memory only)
//   node tools/sim-bots.mjs --k '{"evFast":14}'                  # try SIM_K changes (in memory only)
//   node tools/sim-bots.mjs --bots good,hard,button --oop        # out-of-the-park table only
//
// Bot model (timing σ in GAME seconds around the perfect swing start):
//   novice 70 ms / average 45 ms / good 28 ms / elite 16 ms; readBonus hitters × (1 − 0.2·readBonus)
//   (Dex × 0.8, Nova × 0.95).
// v2 swipe: each bot swipes with a bat speed ~ N(bs, bsSd) (clamped 0.05..1) and times its swing start for its
//   MEAN bat speed (so swipe-speed inconsistency also costs timing: the lead is 0.20 s lazy → 0.09 s max effort);
//   uppercut = smart·idealUppercut(pitch height) + N(0, ucSd). 'hard' = a skilled slugger swiping hard,
//   'button' = a good player in Button mode (fixed 0.72, level swing).
//   Aim: novice always aims dead center; the others aim with idealAim() for the location they
//   PERCEIVE (location noise) plus aim noise. Swing decision: swing if the perceived location is
//   inside the zone grown by a per-bot margin (novices chase more), otherwise take.
// Common random numbers: round i uses the same pitch seed and the same bot noise for every fox, so
// character comparisons are paired.
// Exit code 1 if --check (default on for full runs) finds a missed target.
// ============================================================================
import { createRound, idealAim, idealUppercut, perfectTap, SIM_K } from '../src/sim.js';
import { CHARACTERS, PARK_IDS, PARKS, ZONE, BREAKING, OUTS_PER_ROUND, makeRng, hashString, randomConditions } from '../src/data.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const ROUNDS = +opt('rounds', 300);
const BOTS = String(opt('bots', 'novice,average,good,elite')).split(',');
const CHARS = String(opt('chars', CHARACTERS.map(c => c.id).join(','))).split(',');
const PARKS_ = String(opt('parks', PARK_IDS.join(','))).split(',');
const CALM = !!opt('calm', false);
const JSON_OUT = opt('json', null);
const CHECK = opt('check', ['novice', 'average', 'good', 'elite'].every(b => BOTS.includes(b)) && CHARS.length === 6 ? 'yes' : 'no') !== 'no';
const SEED0 = +opt('seed', 20260926);
const PATCH = opt('patch', null);
if (PATCH && PATCH !== true) { const pt = JSON.parse(PATCH); for (const id in pt) Object.assign(CHARACTERS.find(c => c.id === id).swing, pt[id]); }
const KPATCH = opt('k', null);
if (KPATCH && KPATCH !== true) Object.assign(SIM_K, JSON.parse(KPATCH));
const OOP_ONLY = !!opt('oop', false);

export const BOT_PROFILES = {
  novice:  { sigma: 0.070, aimNoise: 0,    locNoise: 0.45, margin: 0.45, center: true, bs: 0.55, bsSd: 0.20, smart: 0,   ucSd: 0.40 },
  average: { sigma: 0.045, aimNoise: 0.30, locNoise: 0.30, margin: 0.18, bs: 0.70, bsSd: 0.15, smart: 0.3, ucSd: 0.30 },
  good:    { sigma: 0.028, aimNoise: 0.20, locNoise: 0.20, margin: 0.06, bs: 0.84, bsSd: 0.10, smart: 0.6, ucSd: 0.25 },
  elite:   { sigma: 0.016, aimNoise: 0.12, locNoise: 0.12, margin: 0.0,  bs: 0.91, bsSd: 0.07, smart: 0.8, ucSd: 0.18 },
  hard:    { sigma: 0.028, aimNoise: 0.20, locNoise: 0.20, margin: 0.06, bs: 0.96, bsSd: 0.05, smart: 0.6, ucSd: 0.25 },
  button:  { sigma: 0.028, aimNoise: 0.20, locNoise: 0.20, margin: 0.06, bs: 0.72, bsSd: 0,    smart: 0,   ucSd: 0 },
};

function gauss(rng) { let u = rng(); if (u < 1e-12) u = 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

/** Play one full round with a bot. Returns the summary plus per-swing detail aggregates. */
export function playRound({ charId, parkId, bot, roundIdx, calm = false, seed0 = SEED0 }) {
  const B = BOT_PROFILES[bot];
  const char = CHARACTERS.find(c => c.id === charId);
  const pitchSeed = hashString(`bots:${seed0}:${parkId}:${roundIdx}`);
  const condRng = makeRng(pitchSeed ^ 0x5eed);
  const conditions = calm ? { timeOfDay: 'day', weather: 'clear', wind: { mph: 0, dir: 0 } } : randomConditions(parkId, condRng);
  const R = createRound({ charId, parkId, mode: 'free', seed: pitchSeed, conditions, personalBest: 0 });
  const rng = makeRng(hashString(`botnoise:${seed0}:${bot}:${parkId}:${roundIdx}`)); // same for every fox
  const rb = char.swing.readBonus || 0;
  const st = { swings: 0, swBrk: 0, hrBrk: 0, swStr: 0, hrStr: 0, homerD: [], maxStreakEv: 0, kinds: {}, labels: {}, takes: 0, balls: 0, oop: 0, bonus: {}, oopD: [], maxDelta: 0 };
  while (!R.over && R.pitchCount < 400) { // (safety cap — a sane tuning never gets near it)
    const p = R.nextPitch();
    const g1 = gauss(rng), g2 = gauss(rng), g3 = gauss(rng), g4 = gauss(rng), g5 = gauss(rng), g6 = gauss(rng);
    const [px, py] = p.plateLoc;
    const qx = px + g2 * B.locNoise, qy = py + g3 * B.locNoise * 0.8;
    const m = B.margin;
    const looksStrike = qx >= ZONE.x[0] - m && qx <= ZONE.x[1] + m && qy >= ZONE.y[0] - m && qy <= ZONE.y[1] + m;
    let res;
    if (!looksStrike) {
      res = R.resolveTake(p); st.takes++; if (res.kind === 'ball') st.balls++;
    } else {
      const brk = BREAKING.has(p.type);
      const sigma = B.sigma * (1 - 0.2 * rb);
      const aim = B.center ? 0 : Math.max(-1, Math.min(1, idealAim(char, qx, p.type) + g4 * B.aimNoise));
      const batSpeed = Math.max(0.05, Math.min(1, B.bs + g5 * B.bsSd));
      const uppercut = Math.max(-1, Math.min(1, B.smart * idealUppercut(char, qy, p.type) + g6 * B.ucSd));
      res = R.resolveSwing(p, { tapT: perfectTap(p, B.bs) + g1 * sigma, aim, batSpeed, uppercut, samples: false });
      st.swings++;
      if (brk) { st.swBrk++; if (res.kind === 'homer') st.hrBrk++; } else { st.swStr++; if (res.kind === 'homer') st.hrStr++; }
      st.labels[res.timingLabel] = (st.labels[res.timingLabel] || 0) + 1;
      if (res.streakEv > st.maxStreakEv) st.maxStreakEv = res.streakEv;
      if (res.kind === 'homer') {
        st.homerD.push(res.distance);
        if (res.bonus) st.bonus[res.bonus] = (st.bonus[res.bonus] || 0) + 1;
        if (res.outOfPark) { st.oop++; st.oopD.push(res.distance); }
      }
    }
    st.kinds[res.kind] = (st.kinds[res.kind] || 0) + 1;
    const ap = R.apply(res);
    if (ap.scoreDelta > st.maxDelta) st.maxDelta = ap.scoreDelta;
  }
  return { summary: R.summary(), st };
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : 0; };
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export function runCell({ charId, parkId, bot, rounds, calm }) {
  const hr = [], score = [], pitches = [], dist = [], bestStreak = [], streakEv = [], oopD = [];
  let swBrk = 0, hrBrk = 0, swStr = 0, hrStr = 0, over60 = 0, oop = 0, maxDelta = 0, maxScore = 0, maxPerHr = 0, waves = 0; const kinds = {}, bonus = {};
  for (let i = 0; i < rounds; i++) {
    const { summary: s, st } = playRound({ charId, parkId, bot, roundIdx: i, calm });
    hr.push(s.homers); score.push(s.score); pitches.push(s.pitches); bestStreak.push(s.bestStreak); streakEv.push(st.maxStreakEv);
    dist.push(...st.homerD);
    if (s.pitches > 60) over60++;
    swBrk += st.swBrk; hrBrk += st.hrBrk; swStr += st.swStr; hrStr += st.hrStr;
    for (const k in st.kinds) kinds[k] = (kinds[k] || 0) + st.kinds[k];
    for (const k in st.bonus) bonus[k] = (bonus[k] || 0) + st.bonus[k];
    oop += st.oop; oopD.push(...st.oopD); maxDelta = Math.max(maxDelta, st.maxDelta); maxScore = Math.max(maxScore, s.score);
    if (s.homers) maxPerHr = Math.max(maxPerHr, (s.score - 200) / s.homers);
    waves += Math.floor(s.bestStreak / 3);
  }
  return {
    charId, parkId, bot, rounds,
    hr: mean(hr), hrSd: sd(hr), hrP10: pct(hr, 0.1), hrP90: pct(hr, 0.9),
    score: mean(score), scoreSd: sd(score),
    pitches: mean(pitches), pitchesP95: pct(pitches, 0.95), pitchesMax: Math.max(...pitches), over60: over60 / rounds,
    dist: mean(dist), distSd: sd(dist), longest: dist.length ? Math.max(...dist) : 0,
    hrRateBrk: swBrk ? hrBrk / swBrk : 0, hrRateStr: swStr ? hrStr / swStr : 0,
    bestStreak: mean(bestStreak), maxStreakEv: Math.max(...streakEv), meanMaxStreakEv: mean(streakEv), kinds,
    oop, oopRate: dist.length ? oop / dist.length : 0, oopPerRound: oop / rounds, oopDist: mean(oopD), bonus, maxDelta, maxScore, maxPerHr,
    p90dist: pct(dist, 0.9), p99dist: pct(dist, 0.99),
  };
}

// ---------------------------------------------------------------------------- main
const isMain = import.meta.url === `file://${process.argv[1]}` || !!process.argv[1]?.endsWith('sim-bots.mjs');
if (isMain) {
  const t0 = Date.now();
  const cells = [];
  for (const bot of BOTS) for (const parkId of PARKS_) for (const charId of CHARS) {
    cells.push(runCell({ charId, parkId, bot, rounds: ROUNDS, calm: CALM }));
  }
  const f0 = v => v.toFixed(0), f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
  console.log(`WINDY CITY DERBY sim bots — ${ROUNDS} rounds/cell, ${CALM ? 'calm' : 'random free-play'} conditions${PATCH ? ', PATCH ' + PATCH : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!OOP_ONLY) console.log('bot      park     fox     HR/rnd (sd) [p10-p90]   score (sd)       pitches p95 max >60   HR ft (sd) longest  HR%str HR%brk  bestStk maxSkyeEv');
  for (const c of OOP_ONLY ? [] : cells) {
    console.log([
      c.bot.padEnd(8), c.parkId.padEnd(8), c.charId.padEnd(6),
      `${f1(c.hr).padStart(5)} (${f1(c.hrSd)}) [${c.hrP10}-${c.hrP90}]`.padEnd(24),
      `${f0(c.score).padStart(6)} (${f0(c.scoreSd)})`.padEnd(16),
      `${f1(c.pitches).padStart(5)} ${String(c.pitchesP95).padStart(3)} ${String(c.pitchesMax).padStart(3)} ${(c.over60 * 100).toFixed(1).padStart(4)}%`,
      `  ${f0(c.dist).padStart(4)} (${f0(c.distSd).padStart(2)}) ${String(c.longest).padStart(4)}`,
      `   ${(c.hrRateStr * 100).toFixed(0).padStart(3)}%  ${(c.hrRateBrk * 100).toFixed(0).padStart(3)}%`,
      `  ${f2(c.bestStreak).padStart(5)}  ${c.maxStreakEv ? f1(c.maxStreakEv) : '-'}`,
    ].join(' '));
  }

  // ---- out of the park ----
  console.log('\nOUT OF THE PARK  bot      park     fox     HR/rnd  OOP/HR     1 in   OOP/rnd  OOP ft  p90 ft  p99 ft  longest  bonus mix');
  for (const c of cells) {
    const mix = Object.entries(c.bonus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / Math.max(1, c.hr * c.rounds)).toFixed(0)}%`).join(' ');
    console.log(`                 ${c.bot.padEnd(8)} ${c.parkId.padEnd(8)} ${c.charId.padEnd(7)} ${f1(c.hr).padStart(5)}  ${(c.oopRate * 100).toFixed(1).padStart(5)}%  ${(c.oopRate ? f1(1 / c.oopRate) : '—').padStart(6)}   ${f2(c.oopPerRound).padStart(5)}   ${f0(c.oopDist).padStart(4)}    ${String(c.p90dist).padStart(4)}    ${String(c.p99dist).padStart(4)}    ${String(c.longest).padStart(4)}   ${mix}`);
  }
  const maxDelta = Math.max(...cells.map(c => c.maxDelta)), maxScore = Math.max(...cells.map(c => c.maxScore)), maxPerHr = Math.max(...cells.map(c => c.maxPerHr)), longest = Math.max(...cells.map(c => c.longest));
  console.log(`\nlimits seen: max single-homer scoreDelta ${maxDelta}, max round score ${maxScore}, max (score−200)/homers ${f0(maxPerHr)}, longest ${longest} ft`);
  if (OOP_ONLY) { console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`); process.exit(0); }

  // ---- aggregates + target checks ----
  const by = (bot, charId) => cells.filter(c => c.bot === bot && (!charId || c.charId === charId));
  const avg = (arr, k) => mean(arr.map(c => c[k]));
  const fails = [], notes = [];
  const check = (ok, msg) => { (ok ? notes : fails).push((ok ? 'ok   ' : 'FAIL ') + msg); };
  const summary = {};
  console.log('\nPer bot (both parks):  fox      HR/rnd   score   HR ft  HR ft sd  score sd  pitches  >60');
  for (const bot of BOTS) {
    summary[bot] = {};
    if (!BOT_PROFILES[bot]) continue;
    for (const charId of CHARS) {
      const cs = by(bot, charId);
      const s = { hr: avg(cs, 'hr'), score: avg(cs, 'score'), dist: avg(cs, 'dist'), distSd: avg(cs, 'distSd'), scoreSd: avg(cs, 'scoreSd'), pitches: avg(cs, 'pitches'), over60: avg(cs, 'over60'), hrRateBrk: avg(cs, 'hrRateBrk'), hrRateStr: avg(cs, 'hrRateStr'), bestStreak: avg(cs, 'bestStreak'), maxStreakEv: Math.max(...cs.map(c => c.maxStreakEv)) };
      summary[bot][charId] = s;
      console.log(`  ${bot.padEnd(8)}             ${charId.padEnd(7)} ${f1(s.hr).padStart(5)}  ${f0(s.score).padStart(6)}   ${f0(s.dist).padStart(4)}  ${f1(s.distSd).padStart(6)}  ${f0(s.scoreSd).padStart(7)}  ${f1(s.pitches).padStart(6)}  ${(s.over60 * 100).toFixed(1)}%`);
    }
  }
  if (CHECK) {
    // v2 targets (swipe swings add bat-speed variance, so the low end sits a touch under v1's 1-3 / 4-8 / 9-15)
    const T = { novice: [1, 3], average: [3.5, 8], good: [8, 15], elite: [15, 30] };
    for (const bot of BOTS.filter(b => T[b])) {
      const all = avg(by(bot), 'hr');
      check(all >= T[bot][0] && all <= T[bot][1], `${bot}: mean ${f1(all)} HR/round (target ${T[bot][0]}-${T[bot][1]})`);
      const lo = Math.min(...CHARS.map(c => summary[bot][c].hr)), hi = Math.max(...CHARS.map(c => summary[bot][c].hr));
      notes.push(`info ${bot}: per-fox HR/round range ${f1(lo)}-${f1(hi)}`);
    }
    const o60 = mean(cells.map(c => c.over60));
    check(o60 < 0.03, `rounds over 60 pitches: ${(o60 * 100).toFixed(2)}% overall (max cell ${(Math.max(...cells.map(c => c.over60)) * 100).toFixed(1)}%)`);
    const g = summary.good;
    const sc = CHARS.map(c => g[c].score), ms = mean(sc);
    // (v2: reported, not enforced — the fix is a CHARACTERS patch the lead owns; see PLAY report / SIM_SELFTEST.proposal)
    notes.push(`${sc.every(v => Math.abs(v / ms - 1) <= 0.2) ? 'info (holds)  ' : 'info (misses) '}good-bot mean score within ±20%: ${CHARS.map(c => `${c} ${f0(g[c].score)} (${((g[c].score / ms - 1) * 100).toFixed(0)}%)`).join(', ')}`);
    // Character identity: judged on the reference 'good' bot (the brief's balance bot); the other
    // skill levels are printed as info.
    for (const bot of ['average', 'good', 'elite'].filter(b => summary[b])) {
      const s = summary[bot], chk = bot === 'good' ? check : (ok, msg) => notes.push(`info ${ok ? '(holds)  ' : '(misses) '}${msg}`);
      const byDist = [...CHARS].sort((a, b) => s[b].dist - s[a].dist);
      chk(byDist[0] === 'rocco', `${bot}: Rocco longest avg HR distance (${byDist.map(c => `${c} ${f0(s[c].dist)}`).join(' > ')})`);
      chk(byDist[byDist.length - 1] === 'jett', `${bot}: Jett shortest avg HR distance`);
      const byHr = [...CHARS].sort((a, b) => s[b].hr - s[a].hr);
      chk(byHr[0] === 'jett', `${bot}: Jett most HR/round (${byHr.map(c => `${c} ${f1(s[c].hr)}`).join(' > ')})`);
      const byVar = [...CHARS].sort((a, b) => s[b].distSd - s[a].distSd);
      chk(byVar[0] === 'rocco', `${bot}: Rocco highest HR-distance sd (${byVar.map(c => `${c} ${f1(s[c].distSd)}`).join(' > ')})`);
      const bySv = [...CHARS].sort((a, b) => s[b].scoreSd / s[b].score - s[a].scoreSd / s[a].score);
      notes.push(`info ${bot}: score CV ranking ${bySv.map(c => `${c} ${(s[c].scoreSd / s[c].score).toFixed(2)}`).join(' > ')}`);
      // Blaze vs breaking: HR% vs breaking relative to HR% vs straight stuff, compared to the others' average
      const rel = c => s[c].hrRateBrk / Math.max(1e-9, s[c].hrRateStr);
      const others = mean(CHARS.filter(c => c !== 'blaze').map(rel));
      check(rel('blaze') < others * 0.75, `${bot}: Blaze clearly worse vs breaking (brk/str HR ratio ${f2(rel('blaze'))} vs others ${f2(others)})`);
    }
    if (summary.elite && summary.elite.skye) {
      const s = summary.elite.skye;
      const gd = summary.good && summary.good.skye ? summary.good.skye.dist : s.dist;
      check(s.maxStreakEv >= 10 && s.dist - gd >= 15, `elite: Skye streak power visible (up to +${f1(s.maxStreakEv)} mph, mean best streak ${f2(s.bestStreak)}, HR ft ${f0(gd)} good → ${f0(s.dist)} elite)`);
    }
    // ---- out of the park (v2): a skilled hard-swinging slugger leaves Wrigley ~1 in 8-12 homers, contact hitters 1 in 25+,
    //      Rate Field (deeper alleys, taller concourse, calmer wind) is harder than Wrigley for everyone
    {
      const hardCells = BOTS.includes('hard') ? cells.filter(c => c.bot === 'hard') : cells.filter(c => c.bot === 'good').map(c => runCell({ charId: c.charId, parkId: c.parkId, bot: 'hard', rounds: ROUNDS, calm: CALM }));
      const one = (ch, pk) => { const c = hardCells.find(x => x.charId === ch && x.parkId === pk); return c && c.oopRate ? 1 / c.oopRate : Infinity; };
      const f1_ = v => (Number.isFinite(v) ? v.toFixed(1) : '∞');
      check(one('rocco', 'wrigley') >= 6.5 && one('rocco', 'wrigley') <= 13, `hard: Rocco leaves Wrigley 1 in ${f1_(one('rocco', 'wrigley'))} homers (target ~8-12)`);
      check(one('blaze', 'wrigley') >= 7 && one('blaze', 'wrigley') <= 16, `hard: Blaze leaves Wrigley 1 in ${f1_(one('blaze', 'wrigley'))} homers (target ~8-12)`);
      check(one('jett', 'wrigley') >= 25, `hard: Jett (contact) leaves Wrigley 1 in ${f1_(one('jett', 'wrigley'))} homers (target 25+)`);
      check(CHARS.every(ch => one(ch, 'rate') > one(ch, 'wrigley')), `hard: Rate Field harder to leave than Wrigley for every fox (${CHARS.map(ch => `${ch} ${f1_(one(ch, 'wrigley'))}/${f1_(one(ch, 'rate'))}`).join(', ')})`);
      check(Number.isFinite(one('rocco', 'rate')) || Number.isFinite(one('skye', 'rate')), `hard: leaving Rate Field is possible (Rocco 1 in ${f1_(one('rocco', 'rate'))})`);
    }
    console.log('\nTARGETS'); for (const n of notes) console.log('  ' + n); for (const f of fails) console.log('  ' + f);
    console.log(fails.length ? `\n${fails.length} target(s) missed.` : '\nAll targets hold.');
  }
  if (JSON_OUT) { const fs = await import('node:fs'); fs.writeFileSync(JSON_OUT, JSON.stringify({ rounds: ROUNDS, calm: CALM, cells, summary }, null, 1)); console.log('wrote', JSON_OUT); }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (CHECK && fails.length) process.exitCode = 1;
}
