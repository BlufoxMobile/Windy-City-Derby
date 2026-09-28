// ============================================================================
// WINDY CITY DERBY — integration: boot, state machine, main loop.
// Owner: PLAY (v2; v1 lead). Glues sim / render / stadium / actors / camera / audio / ui / net / booth.
// v2 calls into the other modules are all optional-chained (a missing API never breaks play):
//   actors.swing({ batSpeed, leadT, aim, uppercut, pitchLoc })  — leadT = seconds (actor clock) until bat-on-ball
//   director.setMode('outOfPark', { result, landmarks, parkId, onCue }) · director.setMode('wave', { fromSpray, dur })
//   director.pitchProgress(u) · director.timeScale (slow-mo hint, multiplies the flight clock)
//   stadium.wave({ fromSpray, laps }) · stadium.outOfPark({ spray, distance, landing, bonus }) · stadium.landmarks
//   audio.sfx('swing_whoosh', { batSpeed, leadT }) · sfx('bat_*', { batSpeed, quality }) · sfx('wave_swell') · sfx('out_of_park', { parkId, bonus })
//   booth.show({ parkId, bonus, distance, name, streak, timeOfDay }) → Promise   (src/booth.js, loaded lazily)
// ============================================================================
import * as THREE from 'three';
import * as D from './data.js';
import { createRound, swingLeadFor } from './sim.js';
import { createRenderer } from './render.js';
import { buildStadium } from './stadium.js';
import { createActors } from './actors.js';
import { createDirector } from './camera.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { createBoard } from './net.js';
import { loadAssets } from './assets.js';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
let WARP = DEBUG ? Math.max(0.05, Math.min(8, +params.get('warp') || 1)) : 1;
const DT_MAX = DEBUG && +params.get('dtmax') > 0 ? Math.min(0.5, +params.get('dtmax')) : 0.05;   // headless tests: keep game time = real time × WARP
const crowdKey = parkId => (parkId === 'rate' ? 'tex_crowd_south' : 'tex_crowd_north');
const parkKeys = (parkId, tod) => [`sky_${parkId}_${tod}`, crowdKey(parkId), 'crowd_atlas', ...(parkId === 'wrigley' ? ['tex_ivy', 'tex_brick', 'wrigley_ivy', 'wrigley_ivy_n', 'wrigley_ivy_leaves', 'wrigley_facades', 'wrigley_facades_win', 'wrigley_juniper'] : ['rate_hedge', 'rate_precast'])];

export async function boot() {
  const canvas = document.getElementById('gl');
  const root = document.getElementById('ui');

  // ---------------------------------------------------------------- settings
  const settings = Object.assign({ sound: true, music: true, haptics: true, quality: 'auto', swing: 'swipe' }, LS.get('wcd-settings', {}));
  if (settings.swing !== 'button') settings.swing = 'swipe';
  const profile = Object.assign({ name: '', district: '', charId: 'nova', parkId: 'wrigley' }, LS.get('wcd-profile', {}));
  if (!D.CHAR_BY_ID[profile.charId]) profile.charId = 'nova';
  if (!D.PARKS[profile.parkId]) profile.parkId = 'wrigley';
  const autoQuality = () => {
    const minSide = Math.min(screen.width || innerWidth, screen.height || innerHeight);
    const mem = navigator.deviceMemory || 4;
    if (minSide < 500) return mem <= 3 ? 'low' : 'medium';
    return 'high';
  };
  const qualityTier = () => (settings.quality && settings.quality !== 'auto' ? settings.quality : autoQuality());

  // ---------------------------------------------------------------- core
  const R = createRenderer(canvas, { quality: qualityTier() });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 9000);
  camera.position.set(-3.4, 13, 18); camera.lookAt(0, 4, -60);
  const audio = createAudio();
  try { audio.setAssets?.(A); } catch (e) { /* */ }
  audio.setMuted?.(!settings.sound); audio.setMusicOn?.(settings.music);
  // Debug/test runs never post to the live company leaderboard unless asked (&post).
  const board = createBoard({ endpoint: DEBUG && !params.has('post') ? '' : D.BOARD_ENDPOINT });

  const G = {
    mode: 'free', parkId: profile.parkId, charId: profile.charId, conditions: null, daily: D.dailyConfig(),
    stadium: null, stadiumKey: '', actors: null, actorsPark: '', actorsChar: '', director: null, round: null,
    state: 'boot', timer: 0, pitch: null, pt: 0, swung: null, result: null, tau: 0, timeScale: 1, armed: false,
    stamp: { real: 0, pt: 0, rate: 1 }, hitstop: 0, homerCamAt: null, resultHold: 0, canSkipAt: 0, show3D: false, lastFt: 0,
    playing: false,
  };
  if (DEBUG) {
    window.__wcd = G;
    G.debugSwing = (tapT, aim, batSpeed, uppercut) => doSwing({ forceTapT: tapT, aim, batSpeed, uppercut });
    G.onEvent = (t, p) => onEvent(t, p); G.swings = [];
    G.setWarp = w => { WARP = Math.max(0.05, Math.min(8, +w || 1)); return WARP; }; G.warp = () => WARP;
    // Headless tests (tools/playtest.py): freeze the game clock while slow CDP input is delivered. Input timestamps are
    // then read on the frozen timeline (virtual now = frozenAt); on thaw the pitch stamp shifts by the frozen span.
    G.freeze = on => {
      const now = performance.now();
      if (on && !G.frozen) { G.frozen = true; G.frozenAt = now; }
      else if (!on && G.frozen) { const span = now - G.frozenAt; G.frozen = false; G.stamp.real += span; last = now; }
      return G.frozen;
    };
  }

  // ---------------------------------------------------------------- assets (live store — never block on all 8 MB)
  const orient = innerWidth >= innerHeight ? 'title_landscape' : 'title_portrait';
  const other = orient === 'title_portrait' ? 'title_landscape' : 'title_portrait';
  const dailyTod = G.daily.timeOfDay;
  const prio = [
    orient, ...D.ASSET_KEYS.portraits,
    ...parkKeys(G.daily.parkId, dailyTod), `model_${profile.charId}`, 'model_pitcher',
    ...parkKeys(profile.parkId, dailyTod), `celebrate_${profile.charId}`, 'park_wrigley', 'park_rate',
    other,
  ];
  let bootFrac = 0, uiRef = null, bootDone = false;
  const loading = loadAssets({ manifestUrl: 'assets/manifest.json', priority: prio,
    onProgress: f => { if (G.state === 'boot' && uiRef && !bootDone) { bootFrac = Math.max(bootFrac, Math.min(0.92, f * 14)); uiRef.boot(bootFrac, 'LOADING THE PARK'); } } });
  const A = loading.assets;
  loading.then(a => { if (DEBUG) console.log('[assets] receipt', a.receipt); });

  const ui = createUI(root, { onEvent: (type, p) => onEvent(type, p || {}), assets: A, characters: D.CHARACTERS, parks: D.PARKS });
  uiRef = ui;
  ui.setSwingMode?.(settings.swing);
  if (DEBUG) G.ui = ui;

  // ---------------------------------------------------------------- booth cam (CINEMA, optional — loaded lazily, never fatal)
  let booth = null;
  const boothReady = import('./booth.js')
    .then(m => { try { booth = m.createBooth ? m.createBooth(root, { assets: A, audio, autoPreload: false }) : null; } catch (e) { console.warn('[booth] init', e); booth = null; } if (DEBUG) G.booth = booth; return booth; })
    .catch(e => { if (DEBUG) console.warn('[booth] unavailable', e && e.message); return null; });

  // ---------------------------------------------------------------- helpers
  const haptic = ms => { if (settings.haptics && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* */ } };
  const char = () => D.CHAR_BY_ID[G.charId] || D.CHARACTERS[0];
  const has = k => { try { return A.has(k); } catch { return false; } };

  function ensureStadium(parkId, cond) {
    const art = parkKeys(parkId, cond.timeOfDay).map(k => (has(k) ? 1 : 0)).join('');
    const key = `${parkId}|${cond.timeOfDay}|${cond.weather}|${cond.wind.mph}|${cond.wind.dir}|${art}|${R.quality}`;
    if (G.stadium && G.stadiumKey === key) return G.stadium;
    if (G.stadium) { try { G.stadium.detach(scene); G.stadium.dispose(); } catch (e) { console.warn(e); } }
    const t0 = performance.now();
    G.stadium = buildStadium(THREE, { parkId, timeOfDay: cond.timeOfDay, weather: cond.weather, wind: cond.wind, assets: A, quality: R.quality });
    G.stadium.attach(scene);
    G.stadiumKey = key;
    try { R.setGrade?.({ parkId, timeOfDay: cond.timeOfDay, weather: cond.weather }); } catch (e) { /* */ }
    try { audio.setPark?.(parkId, { wind: cond.wind }); } catch (e) { /* */ }
    if (DEBUG) console.log('[stadium] built', key, Math.round(performance.now() - t0) + 'ms');
    return G.stadium;
  }
  function ensureActors(parkId, charId) {
    if (G.actors && G.actorsPark === parkId) {
      if (G.actorsChar !== charId) { G.actors.setCharacter(charId); G.actorsChar = charId; }
      return G.actors;
    }
    if (G.actors) { try { G.actors.dispose(); } catch (e) { console.warn(e); } }
    G.actors = createActors(THREE, { scene, assets: A, charId, parkId, quality: R.quality, onEvent: onActorEvent });
    G.actorsPark = parkId; G.actorsChar = charId;
    return G.actors;
  }
  function ensureDirector(parkId, bats) {
    G.director = createDirector(THREE, camera, { parkId, bats, occluders: G.stadium?.group });
    G.director.resize?.(camera.aspect);
    return G.director;
  }
  function onActorEvent(type) {
    if (type === 'mitt') audio.sfx?.('mitt');
  }

  function nextMult() {
    const r = G.round; const m = D.TUNING.streakMult;
    return m[Math.min(r.streak + 1, m.length - 1)];
  }
  function hudState() {
    const r = G.round;
    return { outs: r.outs, homers: r.homers, score: r.score, streak: r.streak, mult: G.lastApplied?.nextMult ?? nextMult(),
      pitchN: r.pitchCount, wind: G.conditions.wind, name: profile.name, charId: G.charId, parkId: G.parkId, mode: G.mode, bats: char().bats };
  }
  function boardState(message) {
    const r = G.round;
    G.stadium?.setBoard({ name: (profile.name || 'PLAYER').toUpperCase(), homers: r ? r.homers : 0, outs: r ? r.outs : 0, score: r ? r.score : 0, lastFt: G.lastFt || 0, message: message || '' });
  }

  // ---------------------------------------------------------------- screens
  function showTitle() {
    G.state = 'title'; G.playing = false; G.show3D = false; G.round = null;
    ui.hideHud?.(); ui.armInput?.(false);
    const lb = board.local?.best?.() || null;
    const best = LS.get('wcd-best', null) || (lb && lb.score ? lb : null);
    ui.title({ daily: G.daily, best });
    audio.music?.('title');
    audio.setCrowd?.(0);
  }

  async function startRound() {
    const c = char();
    const seed = G.mode === 'daily' ? G.daily.pitchSeed : DEBUG && params.get('seed') ? (+params.get('seed') | 0) : (Math.random() * 2 ** 31) | 0;
    if (G.mode === 'daily') { G.parkId = G.daily.parkId; G.conditions = { timeOfDay: G.daily.timeOfDay, weather: G.daily.weather, wind: G.daily.wind }; }
    else G.conditions = D.randomConditions(G.parkId, D.makeRng(seed ^ 0x5eed));
    if (DEBUG && params.get('cond')) {   // ?cond=tod,weather,mph,dir  e.g. night,clear,18,0
      const [tod, w, mph, dir] = params.get('cond').split(',');
      G.conditions = { timeOfDay: D.TIMES.includes(tod) ? tod : G.conditions.timeOfDay, weather: D.WEATHER[w] ? w : G.conditions.weather, wind: { mph: Number.isFinite(+mph) ? +mph : G.conditions.wind.mph, dir: Number.isFinite(+dir) ? +dir : G.conditions.wind.dir } };
    }
    // Give the art for THIS park a few seconds to land (store Wi-Fi), then go with what we have.
    const need = [...parkKeys(G.parkId, G.conditions.timeOfDay), `model_${G.charId}`, 'model_pitcher'];
    const missing = need.filter(k => !has(k));
    if (missing.length) {
      G.state = 'loading';
      ui.toast?.('LOADING THE PARK…', { ms: 2500 });
      await Promise.race([Promise.all(missing.map(k => A.ready(k))), sleep(7000)]);
    }
    const pbLocal = board.local?.best?.(G.parkId);
    const pb = Math.max(LS.get('wcd-longest-' + G.parkId, 0) || 0, (pbLocal && pbLocal.longest) || 0);
    G.round = createRound({ charId: G.charId, parkId: G.parkId, mode: G.mode, seed, conditions: G.conditions, date: G.daily.date, personalBest: pb });
    boothReady.then(b => { try { b?.preload?.(G.parkId); } catch (e) { /* */ } });   // booth art + voice for THIS park, behind the intro
    G.lastFt = 0; G.lastApplied = null; G.chargePlayed = false;
    ensureStadium(G.parkId, G.conditions);
    ensureActors(G.parkId, G.charId);
    ensureDirector(G.parkId, c.bats).setMode('batting', { instant: true });
    G.actors.reset?.();
    G.stadium.setCrowd?.(0.35);
    audio.setCrowd?.(0.35);
    boardState('NOW BATTING');
    // Pay the shader-compile / first-frame cost BEFORE the intro card's timer starts.
    try { G.director.update(0.016, 0); R.renderer.compile?.(scene, camera); R.render(scene, camera); } catch (e) { console.warn('[prewarm]', e); }
    await sleep(30);
    G.state = 'intro'; G.show3D = true; G.playing = true;
    ui.intro({ park: D.PARKS[G.parkId], conditions: G.conditions, char: c, mode: G.mode, daily: G.mode === 'daily' ? G.daily : null });
    audio.music?.('batting');
    audio.organ?.('walkup');
    G.timer = 0;
  }

  function beginBatting() {
    ui.hud(hudState());
    G.state = 'between'; G.timer = 0.5;
  }

  function nextPitch() {
    const r = G.round;
    if (r.over) return endRound();
    G.pitch = r.nextPitch();
    G.swung = null; G.result = null; G.tau = 0; G.hitstop = 0; G.homerCamAt = null; G.armed = false;
    G.actors.reset?.();
    const s = G.actors.startPitch(G.pitch) || {};
    G.timer = s.releaseIn ?? D.TUNING.windupTime;
    G.state = 'windup';
    audio.sfx?.('anticipation', { outs: r.outs, streak: r.streak });
    if (r.outs === D.OUTS_PER_ROUND - 1) audio.organ?.('tension');
  }

  /** Game-clock seconds → actor-clock seconds from pitch time t0 to t1 (the eye's slowed clock runs the ball slower). */
  function actorLead(t0, t1) {
    const p = G.pitch; if (!(t1 > t0)) return 0;
    if (!p || !p.clockRate) return (t1 - t0) / (G.stamp.rate || 1);
    let acc = 0; const n = 12, h = (t1 - t0) / n;
    for (let i = 0; i < n; i++) acc += h / Math.max(0.2, p.clockRate(t0 + (i + 0.5) * h));
    return acc;
  }
  function doSwing(p) {
    const aim = clamp(Number.isFinite(p.aim) ? p.aim : 0, -1, 1);
    const batSpeed = clamp(Number.isFinite(p.batSpeed) ? p.batSpeed : D.TUNING.batSpeedRef, 0, 1);
    const uppercut = clamp(Number.isFinite(p.uppercut) ? p.uppercut : 0, -1, 1);
    let tapT, ptNow = G.pt;
    if (p.forceTapT != null) {
      if (!(G.pitch && !G.swung && (G.state === 'pitch' || G.state === 'windup'))) return null;
      tapT = p.forceTapT;
      if (G.state === 'windup') { G.state = 'pitch'; G.pt = 0; G.stamp = { real: performance.now(), pt: 0, rate: 1 }; }
    } else {
      if (G.swung || !(G.state === 'pitch' || (G.state === 'windup' && G.timer < 0.15))) return null;
      if (G.state === 'windup') tapT = -G.timer; // before release — way early
      else {
        // p.t = when the swing STARTED (swipe: the moment the finger began to move) — back-date it onto the pitch clock
        const dtReal = ((p.t ?? performance.now()) - G.stamp.real) / 1000;
        tapT = G.stamp.pt + dtReal * WARP * G.stamp.rate;
        ptNow = G.stamp.pt + (((G.frozen ? G.frozenAt : performance.now()) - G.stamp.real) / 1000) * WARP * G.stamp.rate;
      }
    }
    const res = G.round.resolveSwing(G.pitch, { tapT, aim, batSpeed, uppercut });
    G.swung = { tapT, aim, batSpeed, uppercut, via: p.via || (p.forceTapT != null ? 'debug' : 'tap'), at: performance.now() }; G.result = res;
    G.oopFired = false; G.oopBack = null;
    // the bat must meet the ball exactly when the sim says: leadT = actor-clock time from NOW to contact
    const leadT = Math.max(0.02, actorLead(ptNow, res.contactT));
    G.actors.swing?.({ batSpeed, leadT, aim, uppercut, pitchLoc: G.pitch.plateLoc, kind: res.kind });
    ui.armInput?.(false); G.armed = false;
    audio.sfx?.('swing_whoosh', { batSpeed, leadT, delay: Math.max(0, leadT - 0.07) });
    if (res.kind === 'whiff') audio.sfx?.('whiff', { delay: leadT * 0.8, batSpeed });
    if (DEBUG) {
      const rec = { n: G.pitch.n, via: G.swung.via, tapT: +tapT.toFixed(4), batSpeed, uppercut, aim: +aim.toFixed(3), lead: +res.leadT.toFixed(4), err: +res.timingErr.toFixed(4), kind: res.kind, timing: res.timingLabel, ev: res.exitVelo, la: res.launch, dist: res.distance, oop: res.outOfPark, bonus: res.bonus, latency: p.latency ?? null };
      G.swings.push(rec); console.log('[swing]', JSON.stringify(rec));
    }
    return res;
  }

  function contact() {
    const res = G.result;
    G.actors.contact(res);
    G.state = 'flight'; G.tau = 0;
    const sweet = res.contact === 'sweet' || res.quality > 0.85;
    const bo = { batSpeed: res.batSpeed ?? D.TUNING.batSpeedRef, quality: res.quality ?? 0.5, exitVelo: res.exitVelo };
    audio.sfx?.(res.kind === 'foul' ? 'foul' : sweet ? 'bat_sweet' : res.quality > 0.55 ? 'bat_solid' : 'bat_weak', bo);
    G.director?.pitchProgress?.(null);
    haptic(sweet ? [18, 30, 28] : 14);
    G.hitstop = sweet ? 0.085 : 0.03;
    if (sweet) G.director?.shake?.(0.6);
    G.director?.follow?.(res);
    const hr = res.kind === 'homer';
    G.stadium?.setCrowd?.(hr ? 0.85 : 0.55);
    audio.setCrowd?.(hr ? 0.85 : 0.55);
    if (hr) audio.sfx?.('crowd_roar', { intensity: clamp((res.distance - 360) / 140, 0.4, 1), distance: res.distance, delay: Math.max(0, (res.path?.fenceT ?? 1.5) - 0.2) });
    if (res.path && (hr || res.kind === 'flyout' || res.kind === 'liner') && res.hangTime > 1.2) audio.sfx?.('crowd_ooh', { dur: res.path.fenceT ?? Math.min(res.hangTime, 4) });
    // out of the park: when does the ball clear the back of the bleachers? (path tau)
    if (hr && res.outOfPark && res.path && res.path.pts) {
      const P = D.PARKS[G.parkId], pts = res.path.pts;
      let tb = null;
      for (let i = 0; i < pts.length; i += 4) {
        const x = pts[i + 1], z = pts[i + 3], r = Math.hypot(x, z), sp = Math.atan2(x, -z) * 180 / Math.PI;
        if (r >= D.fenceDistance(G.parkId, sp) + P.stands.depth) { tb = pts[i]; break; }
      }
      G.oopBack = tb ?? pts[pts.length - 4];
    }
  }

  /** The ball has left the yard (clearing the back row) — the broadcast moment. Fires once per swing. */
  function oopMoment(res) {
    if (G.oopFired) return; G.oopFired = true;
    ui.outOfPark?.({ parkId: G.parkId, bonus: res.bonus, distance: res.distance });
    audio.sfx?.('out_of_park', { parkId: G.parkId, bonus: res.bonus, distance: res.distance });
    audio.organ?.('outOfPark');
    G.stadium?.setCrowd?.(1); audio.setCrowd?.(1);
    haptic([40, 60, 40, 60, 90]);
  }

  function finishPlay(res) {
    const applied = G.round.apply(res);
    G.lastApplied = applied;
    const events = applied.events || [];
    G.post = { wave: null, waveAt: 0, waveOn: false, boothP: null, boothDone: false };
    if (res.kind === 'homer') {
      G.lastFt = Math.round(res.distance);
      const key = 'wcd-longest-' + G.parkId;
      if (res.distance > (LS.get(key, 0) || 0)) LS.set(key, Math.round(res.distance));
      G.stadium?.celebrate?.({ spray: res.spray, distance: res.distance, bonus: res.bonus });
      audio.sfx?.('homer_horn');
      if (G.parkId === 'rate') audio.sfx?.('fireworks', { n: 10 });
      if (applied.streak >= 3 && !G.chargePlayed) { audio.organ?.('charge'); G.chargePlayed = true; }
      else audio.organ?.('homer');
      if (applied.streak >= 2) audio.sfx?.('streak', { n: applied.streak });
      if ((applied.callouts || []).some(c => /RECORD/i.test(c.text || ''))) audio.sfx?.('record', { delay: 0.6 });
      haptic([30, 40, 60]);
      boardState(res.outOfPark ? 'OUT OF THE PARK!' : applied.streak >= 2 ? `${applied.streak} STRAIGHT!` : 'HOME RUN!');
      if (events.includes('outOfPark') || res.outOfPark) {
        oopMoment(res);   // (if the flight never reached the back-row trigger)
        const landing = res.path ? res.path.rest || res.path.landing : null;
        try { G.stadium?.outOfPark?.({ spray: res.spray, distance: res.distance, landing, bonus: res.bonus }); } catch (e) { console.warn('[stadium] outOfPark', e); }
        const show = () => booth?.show?.({ parkId: G.parkId, bonus: res.bonus, distance: res.distance, name: (profile.name || '').toUpperCase(), streak: applied.streak, timeOfDay: G.conditions?.timeOfDay });
        let pr = null;
        try { pr = show(); } catch (e) { console.warn('[booth] show', e); }
        if (!pr && !booth) pr = boothReady.then(b => (b && G.state === 'result' ? show() : null));
        if (pr && typeof pr.then === 'function') { G.post.boothP = pr; pr.then(() => { if (G.post) G.post.boothDone = true; }, () => { if (G.post) G.post.boothDone = true; }); }
        else G.post.boothDone = true;
      }
      if (events.includes('wave')) G.post.wave = { fromSpray: res.spray, streak: applied.streak };
    } else {
      if (applied.streak === 0) G.chargePlayed = false;
      if (applied.out) { audio.sfx?.('crowd_groan'); audio.sfx?.('out'); }
      G.stadium?.setCrowd?.(0.3); audio.setCrowd?.(0.3);
      boardState(applied.out ? 'OUT' : 'BALL');
    }
    ui.result(res, applied);
    ui.hud(hudState());
    G.state = 'result'; G.lastResult = res;
    G.resultHold = res.kind === 'homer' ? (res.outOfPark ? 7.5 : 3.1) : res.swung ? 1.8 : 1.3;   // OOP: until the booth call ends (≤ 7.5 s)
    G.canSkipAt = res.kind === 'homer' ? (res.outOfPark ? 1.6 : 1.2) : 0.6;
    if (G.post.wave) G.post.waveAt = res.outOfPark ? -1 : 1.25;   // after the homer beat (OOP: after the booth)
    G.timer = 0;
  }

  /** THE WAVE: crowd + camera sweep + callout, ≤ 2.5 s of extra hold. */
  function startWave() {
    const w = G.post && G.post.wave; if (!w || G.post.waveOn) return;
    G.post.waveOn = true;
    const dur = 2.5;
    try { G.stadium?.wave?.({ fromSpray: w.fromSpray, laps: 1 }); } catch (e) { console.warn('[stadium] wave', e); }
    G.director?.setMode?.('wave', { fromSpray: w.fromSpray, dur });
    audio.sfx?.('wave_swell', { streak: w.streak });
    audio.organ?.('wave');
    ui.wave?.({ streak: w.streak, ms: dur * 1000 });
    G.stadium?.setCrowd?.(1); audio.setCrowd?.(0.9);
    G.resultHold = G.timer + dur; G.canSkipAt = G.timer + 0.9;
  }

  function endRound() {
    G.state = 'over'; G.playing = false;
    ui.hideHud?.();
    ui.armInput?.(false);
    const s = G.round.summary();
    const prev = LS.get('wcd-best', null);
    const personalBest = s.score > 0 && (!prev || s.score > prev.score);
    if (personalBest) LS.set('wcd-best', { score: s.score, homers: s.homers, longest: s.longest, charId: s.charId, parkId: s.parkId, date: D.chicagoDate() });
    G.director?.setMode('result');
    audio.organ?.(null);
    audio.music?.('roundOver');
    audio.setCrowd?.(0.4);
    boardState('FINAL');
    let submitting = null;
    if (profile.name) submitting = board.submit({ ...s, name: profile.name, district: profile.district || '' }).catch(e => { console.warn('[board] submit failed', e); return null; });
    else board.local?.record?.(s);
    ui.roundOver(s, { submitting, board: t => board.top({ ...(t || {}), date: (t && t.date) || G.daily.date, limit: (t && t.limit) || 25 }), name: profile.name, personalBest });
    setTimeout(() => { if (G.state === 'over') G.show3D = false; }, 1200);
  }

  async function openBoard(tab = 'today', district = '') {
    G.show3D = false;
    const data = await board.top({ board: tab, date: G.daily.date, district, limit: 25 }).catch(() => ({ ok: false, rows: [], remote: false }));
    ui.leaderboard(data, { tab, district });
  }

  // ---------------------------------------------------------------- events
  const unlock = () => { audio.unlock?.(); };
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true });

  function onEvent(type, p = {}) {
    if (DEBUG && type !== 'sfx') console.log('[ui]', type, JSON.stringify(p || {}).slice(0, 200));
    switch (type) {
      case 'swing': return doSwing(p);
      case 'sfx': return audio.sfx?.(p.name || 'ui_tap');
      case 'aim': return;
      case 'play': G.mode = 'free'; return ui.nameEntry({ name: profile.name, district: profile.district });
      case 'daily': G.mode = 'daily'; return ui.nameEntry({ name: profile.name, district: profile.district });
      case 'name':
        profile.name = String(p.name || '').trim().slice(0, 16); profile.district = p.district || ''; LS.set('wcd-profile', profile);
        return ui.characterSelect({ selected: G.charId });
      case 'character':
        G.charId = D.CHAR_BY_ID[p.charId] ? p.charId : G.charId; profile.charId = G.charId; LS.set('wcd-profile', profile);
        if (G.mode === 'daily') return startRound();
        return ui.parkSelect({ daily: G.daily, selected: G.parkId });
      case 'park':
        G.parkId = D.PARKS[p.parkId] ? p.parkId : 'wrigley'; profile.parkId = G.parkId; LS.set('wcd-profile', profile);
        return startRound();
      case 'intro-done': if (G.state === 'intro') beginBatting(); return;
      case 'skip': case 'continue':
        if (G.state === 'result' && G.timer >= G.canSkipAt) {
          if (booth?.showing) booth.hide?.();
          if (G.post && G.post.wave && !G.post.waveOn) startWave();   // a skip jumps to THE WAVE, it never skips it
          else G.timer = G.resultHold;
        }
        return;
      case 'again': case 'play-again': case 'replay': return startRound();
      case 'change': case 'change-fox': case 'change-character': return ui.characterSelect({ selected: G.charId });
      case 'back':
        if (p.from === 'character') return ui.nameEntry({ name: profile.name, district: profile.district });
        if (p.from === 'park') return ui.characterSelect({ selected: G.charId });
        return showTitle();
      case 'home': case 'title': return showTitle();
      case 'board': case 'leaderboard': return openBoard(p.tab || 'today', p.district || '');
      case 'board-tab': case 'leaderboard-tab':
        if (p.from === 'roundover' || p.from === 'roundOver') return board.top({ board: p.tab || 'today', date: G.daily.date, district: p.district || '', limit: 25 }).then(d => ui.leaderboard(d, { tab: p.tab, district: p.district })).catch(() => {});
        return openBoard(p.tab || 'today', p.district || '');
      case 'settings': return ui.settings({ ...settings });
      case 'setting': case 'settings-change': case 'settings-close': {
        const before = settings.quality;
        for (const k of ['sound', 'music', 'haptics', 'quality', 'swing']) if (k in p) settings[k] = p[k];
        if (settings.swing !== 'button') settings.swing = 'swipe';
        LS.set('wcd-settings', settings);
        audio.setMuted?.(!settings.sound); audio.setMusicOn?.(settings.music);
        if (settings.quality !== before) { R.setQuality(qualityTier()); G.stadiumKey = ''; }
        return;
      }
      default: if (DEBUG) console.log('[ui] unhandled event', type);
    }
  }

  // ---------------------------------------------------------------- loop
  function resize() {
    const w = innerWidth, h = innerHeight;
    R.resize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    G.director?.resize?.(camera.aspect);
  }
  addEventListener('resize', resize);
  addEventListener('orientationchange', () => setTimeout(resize, 250));
  resize();

  function stepRound(dt) {
    switch (G.state) {
      case 'between':
        G.timer -= dt; if (G.timer <= 0) nextPitch(); break;
      case 'windup':
        G.timer -= dt;
        if (!G.armed && G.timer < 0.15) { ui.armInput?.(true); G.armed = true; }
        if (G.timer <= 0) {
          G.state = 'pitch'; G.pt = Math.max(0, -G.timer);
          ui.pitchCallout?.(G.pitch);
          audio.sfx?.('pitch_whoosh', { dur: G.pitch.flightTime });
          G.stamp = { real: performance.now(), pt: G.pt, rate: G.pitch.clockRate ? G.pitch.clockRate(G.pt) : 1 };
        }
        break;
      case 'pitch': {
        const p = G.pitch;
        const rate = p.clockRate ? p.clockRate(G.pt) : 1;
        G.pt += dt * rate;
        G.stamp = { real: performance.now(), pt: G.pt, rate };
        const res = G.result;
        if (res && res.kind !== 'whiff' && G.pt >= res.contactT) {
          G.actors.setPitchTime(res.contactT, p);
          contact();
          break;
        }
        G.actors.setPitchTime(G.pt, p);
        G.director?.pitchProgress?.(G.pt / p.flightTime);
        if (G.pt >= p.flightTime + D.TUNING.takeGrace) {
          G.director?.pitchProgress?.(null);
          if (res && res.kind === 'whiff') { G.actors.take(res); finishPlay(res); }
          else if (!res) {
            const take = G.round.resolveTake(p);
            G.actors.take(take);
            ui.armInput?.(false); G.armed = false;
            finishPlay(take);
          }
        }
        break;
      }
      case 'flight': {
        const res = G.result;
        if (G.hitstop > 0) { G.hitstop -= dt; break; }
        const path = res.path;
        const end = path ? path.pts[path.pts.length - 4] : 0;
        const homer = res.kind === 'homer';
        // pacing: a beat of slow-mo off the bat, then brisk
        G.timeScale = G.tau < 0.22 ? (homer ? 0.45 : 0.7) : homer ? (res.outOfPark ? 1.15 : 1.3) : 1.6;
        const dts = G.director?.timeScale; if (Number.isFinite(dts) && dts > 0) G.timeScale *= clamp(dts, 0.2, 1.5);   // director slow-mo hint
        G.tau += dt * G.timeScale;
        if (homer && G.homerCamAt == null && path && G.tau >= Math.max(0.9, (path.fenceT ?? end * 0.7) - 1.3)) {
          G.homerCamAt = G.tau;
          if (res.outOfPark) G.director?.setMode('outOfPark', { result: res, landmarks: G.stadium?.landmarks, parkId: G.parkId, occluders: G.stadium?.group,
            onCue: (name, info) => { if (DEBUG) console.log('[oop cue]', name); if (name === 'overTheTop') oopMoment(res); } });
          else G.director?.setMode('homer', { result: res });
        }
        if (homer && res.outOfPark && G.oopBack != null && G.tau >= G.oopBack - 0.1) oopMoment(res);
        if (!path || G.tau >= end) {
          if (path) G.actors.ballFlightT?.(end);
          G.actors.settle(res);
          finishPlay(res);
        } else G.actors.ballFlightT(G.tau);
        break;
      }
      case 'result':
        G.timer += dt;
        if (G.post) {
          const P = G.post;
          if (P.boothDone && G.lastResult?.outOfPark && !P.boothEnded) { P.boothEnded = true; if (P.wave) P.waveAt = Math.max(G.timer + 0.25, 1.25); else G.resultHold = Math.min(G.resultHold, Math.max(G.timer + 0.6, 3.6)); }
          if (P.wave && !P.waveOn && P.waveAt >= 0 && G.timer >= P.waveAt) startWave();
          if (P.wave && !P.waveOn && G.timer >= G.resultHold - 0.05) startWave();   // never lose the wave to the clock
        }
        if (G.timer >= G.resultHold) {
          if (booth?.showing) booth.hide?.();
          if (G.round.over) endRound();
          else { G.director?.setMode('batting'); G.actors.reset?.(); G.state = 'between'; G.timer = 0.55; ui.armInput?.(false); G.armed = false; }
        }
        break;
      default: break;
    }
  }

  let last = performance.now(), T = 0, fpsAcc = 0, fpsN = 0, errN = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (G.frozen) { last = now; return; }
    const dt = clamp((now - last) / 1000, 0, DT_MAX) * WARP; last = now; T += dt;
    try {
      if (G.playing && G.round) stepRound(dt);
      audio.update?.(dt);
      if (G.show3D) {
        R.beginFrame?.(dt);
        G.stadium?.update(dt, T);
        G.actors?.update(dt, T);
        G.director?.update(dt, T);
        R.render(scene, camera);
      }
    } catch (e) {
      if (errN++ < 3) console.error('[wcd] frame error', e);
    }
    if (DEBUG) { fpsAcc += dt; fpsN++; if (fpsAcc > 2) { console.log('[fps]', (fpsN / fpsAcc).toFixed(1), R.quality); fpsAcc = 0; fpsN = 0; } }
  }
  window.addEventListener('keydown', e => {
    if ((e.code === 'Space' || e.code === 'Enter') && G.state === 'result') onEvent('skip', {});
  });
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  // ---------------------------------------------------------------- boot
  ui.boot(0.02, 'LOADING THE PARK');
  requestAnimationFrame(t => { last = t; frame(t); });
  // Wait only for the key art (capped) — everything else streams in behind the menus.
  await Promise.race([A.ready(orient), sleep(6000)]);
  bootDone = true; ui.boot(1, 'PLAY BALL');
  await sleep(450);
  // First visit: let the HOW TO PLAY cards play once on the loading screen (tap skips). Later visits go straight in.
  if (!params.has('autoplay') && !LS.get('wcd-tut-seen', false) && ui.bootTutorial) {
    try { await ui.bootTutorial({ maxMs: 14000 }); } catch (e) { /* never block the title */ }
    LS.set('wcd-tut-seen', true);
  }
  if (params.has('autoplay')) {
    G.mode = params.get('autoplay') === 'daily' ? 'daily' : 'free';
    if (!profile.name) profile.name = params.get('name') || 'Tester';
    if (params.get('park')) G.parkId = params.get('park');
    if (params.get('char')) G.charId = params.get('char');
    await startRound();
    setTimeout(() => onEvent('intro-done'), 1500);
  } else showTitle();
}
