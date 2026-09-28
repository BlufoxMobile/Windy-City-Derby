// ============================================================================
// WINDY CITY DERBY — src/audio.js   (owner: AUDIO)   v2 "broadcast" build
// Procedural WebAudio only: every sound is synthesised in the browser. No audio
// files, no network, no copyrighted music. The one exception is playClip(): voice
// lines other modules hand over through assets.buffer(key) (decoded lazily).
//
//   createAudio()                      → Audio (context made on unlock())
//   createAudio({ context, ... })      → same API bound to an injected (Offline)AudioContext
//
// Graph:  voices → buses {sfx, crowd(+amb), music, organ, voice}
//         crowd/amb → crowdDuck ─┐   music/organ → duck → musicOn gate ─┐
//         sends → stadium reverb (convolver IR) + PA slap echo + city echo ─┤
//         mix → sub HPF → glue comp → master(mute) → limiter → trim → soft-clip (≤ −0.5 dBFS) → out
// Music runs ONLY on a lookahead scheduler (setInterval 25 ms, 120 ms ahead of
// ctx.currentTime); update(dt) merely nudges it. Buffers are synthesised in pure JS
// in ≤10 ms idle slices from createAudio() on (before the unlock gesture), heavy
// jobs are resumable generators, so unlock() only wraps ready Float32Arrays.
// All riffs/cues are ORIGINAL compositions (RIFFS / CUES below).
//
// Physical grounding (see final report): bat–ball contact ≈0.5–0.7 ms; the sweet-spot
// "crack" is dominated by the air-expulsion pulse (band centred ≈1.4–2 kHz, small
// peaks ≈300 Hz / ≈1 kHz), a mis-hit "clunk" by the first bending mode (≈170 Hz,
// Q≈10, ~50 ms) — Adair (ASA 141), Russell (Acoustics Today 2017), THT/BP spectra.
// ============================================================================

export const SFX_NAMES = ['bat_sweet', 'bat_solid', 'bat_weak', 'foul', 'whiff', 'mitt', 'pitch_whoosh', 'homer_horn',
  'fireworks', 'crowd_roar', 'crowd_groan', 'streak', 'record', 'out', 'ui_tap', 'ui_back', 'ui_confirm', 'countdown', 'ding',
  // v2
  'swing_whoosh', 'wave_swell', 'out_of_park', 'pinwheels', 'ballpark_bell', 'crowd_ooh', 'anticipation', 'crowd_hey',
  'clap_chant', 'whistle', 'vendor', 'el_train', 'train_horn', 'siren', 'car_alarm', 'car_horn', 'ballhawks', 'flag_snap'];
export const ORGAN_RIFFS = ['charge', 'walkup', 'homer', 'stretch', 'tension', 'wave', 'outOfPark'];
export const MUSIC_CUES = ['title', 'batting', 'roundOver'];

const LOOKAHEAD = 0.12;      // s scheduled ahead of ctx.currentTime
const TICK_MS = 25;          // scheduler interval
const MAX_VOICES = 64;       // concurrent one-shot sources (soft cap)
const TAU = Math.PI * 2;
const GEN_SR = 48000, CROWD_SR = 22050, FX_SR = 32000; // Safari-safe buffer rates (≥ 22050)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dbg = db => Math.pow(10, db / 20);
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function nm(s) { // 'C#4' | 'Bb3' → midi
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
  if (!m) throw new Error('audio: bad note ' + s);
  return 12 * (+m[3] + 1) + NOTE_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// table sine/cosine (4096 pts, linear interp) for hot generator loops; arg in radians, any sign
const SINT = (() => { const t = new Float32Array(4097); for (let i = 0; i <= 4096; i++) t[i] = Math.sin(TAU * i / 4096); return t; })();
function SIN(x) { let p = x * (4096 / TAU); p -= Math.floor(p / 4096) * 4096; const i = p | 0, f = p - i; return SINT[i] + (SINT[i + 1] - SINT[i]) * f; }
const COS = x => SIN(x + Math.PI / 2);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ============================================================================
// DSP — pure JS generators (Float32Array). Node-testable, deterministic.
// ============================================================================
class BQ { // RBJ biquad
  constructor(type, f, q = 0.707, sr = 44100, g = 0) { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(type, f, q, sr, g); }
  set(type, f, q, sr, g = 0) {
    f = clamp(f, 10, sr * 0.49);
    const w = TAU * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = Math.pow(10, g / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'ls') { const sq = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq); a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; }
    else { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; } // peak
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
function peakOf(...chs) { let p = 0; for (const a of chs) for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > p) p = v; } return p; }
function normalize(a, peak = 1) { const p = peakOf(a); if (p > 0) { const k = peak / p; for (let i = 0; i < a.length; i++) a[i] *= k; } return a; }
function normalize2(L, R, peak = 1) { const p = peakOf(L, R); if (p > 0) { const k = peak / p; for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; } } return [L, R]; }
function rmsOf(a, thr = 1e-4) { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v > thr || v < -thr) { s += v * v; n++; } } return n ? Math.sqrt(s / n) : 0; }
function rmsNorm(a, target = 0.2, peakCap = 0.98) { // loudness-consistent (RMS over the voiced part), peak-capped
  const r = rmsOf(a); if (!r) return a; let k = target / r; const p = peakOf(a); if (p * k > peakCap) k = peakCap / p;
  for (let i = 0; i < a.length; i++) a[i] *= k; return a;
}
function fadeEdges(a, inN = 0, outN = 0) {
  for (let i = 0; i < inN && i < a.length; i++) a[i] *= i / inN;
  for (let i = 0; i < outN && i < a.length; i++) a[a.length - 1 - i] *= i / outN;
  return a;
}
const panLR = p => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];
function PL(keys) { // piecewise-linear evaluator for monotonically increasing t; keys [[t, v], ...] (or a constant)
  const K = Array.isArray(keys) ? (keys.length > 1 ? keys : [keys[0] || [0, 0], keys[0] || [0, 0]]) : [[0, +keys || 0], [1, +keys || 0]];
  let k = 0; const n = K.length;
  return t => {
    while (k < n - 2 && t >= K[k + 1][0]) k++;
    const a = K[k], b = K[k + 1];
    if (t <= a[0]) return a[1]; if (t >= b[0]) return b[1];
    return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  };
}
function brownStep(r, y, leak = 0.996) { return y * leak + (r() * 2 - 1) * 0.06; }

// ---- BAT / BALL IMPACT — modal synthesis of a hand-held wooden bat ----------------
// Free-free beam mode shapes φn(ξ) (ξ = impact distance from the barrel end / bat length).
// The node pattern of a real (tapered) bat is close: mode-1 barrel node ≈0.22, mode-2 ≈0.13,
// the "sweet zone" sits between them (≈5–7 in on a 34 in bat).
const BEAM_BL = [4.7300, 7.8532, 10.9956, 14.1372, 17.2788, 20.4204];
function beamShape(n, xi) { // numerically stable form; φ(0) = 2
  const b = BEAM_BL[n], x = b * xi, den = Math.sinh(b) - Math.sin(b);
  const s = (Math.cosh(b) - Math.cos(b)) / den, oms = (Math.cos(b) - Math.sin(b) - Math.exp(-b)) / den;
  return Math.cos(x) - s * Math.sin(x) + 0.5 * (oms * Math.exp(x) + (1 + s) * Math.exp(-x));
}
// Spectrum of a half-sine force pulse of duration Tc (normalised to 1 at DC).
function halfSineSpec(f, Tc) { const u = 2 * f * Tc, d = 1 - u * u; return Math.abs(d) < 1e-3 ? Math.PI / 4 : Math.abs(Math.cos(Math.PI * f * Tc) / d); }
// Hand-held wood bat: audible bending modes [Hz, decay τ s] (grip damps the low modes: mode 1 Q≈10).
const BAT_MODES = [[175, 0.020], [560, 0.016], [1100, 0.012], [1760, 0.008], [2520, 0.0055], [3380, 0.004]];
// Contact presets. Tc = contact time (ms), xi = impact point, air = air-expulsion pulse weight,
// modal = bending-wave weight, body = ball/barrel "thock" (≈300 Hz) weight, sizzle = turbulence noise.
const BAT = {
  sweet:  { xi: 0.175, air: 1.0, modal: 0.2, body: 0.07, sizzle: 0.1, rad: 1.0 },
  solid:  { xi: 0.255, air: 0.8, modal: 0.5, body: 0.13, sizzle: 0.08, rad: 1.0 },
  jam:    { xi: 0.44, air: 0.34, modal: 1.35, body: 0.4, sizzle: 0.08, rad: 0.55, sting: 0.8 },
  end:    { xi: 0.035, air: 0.45, modal: 1.3, body: 0.22, sizzle: 0.12, rad: 0.85 },
  tick:   { xi: 0.2, air: 0.3, modal: 0.22, body: 0.04, sizzle: 0.4, rad: 1.3, glance: 1 },
};
function genBat(sr, P, Tc, seed) {
  const r = mulberry(seed), dur = P.glance ? 0.25 : 0.5, n = Math.round(dur * sr);
  const air = new Float32Array(n), modal = new Float32Array(n), body = new Float32Array(n), fizz = new Float32Array(n);
  const tc = Tc * 0.001 * (1 + (r() - 0.5) * 0.06);
  // (1) air expelled from between ball and barrel: monopole p ∝ d²V/dt², V(t) = sin³(πt/Ta)
  //     (smooth compression/restitution bump).  Ta ≈ 1.25·Tc puts the band centre where
  //     field recordings put it (≈1.4–2 kHz for 0.7–0.5 ms contact).
  const Ta = tc * 1.25, na = Math.max(4, Math.round(Ta * sr));
  for (let i = 0; i <= na && i < n; i++) {
    const u = Math.PI * i / na, s = Math.sin(u), c = Math.cos(u);
    air[i] = 3 * s * (2 * c * c - s * s);                 // ∝ d²(sin³)/du²
  }
  // a smaller secondary puff as the ball restitutes and the seams/cover slap (≈0.3 ms later)
  const d2 = Math.round((0.25 + r() * 0.15) * tc * sr), na2 = Math.max(3, Math.round(na * 0.6));
  for (let i = 0; i <= na2 && d2 + i < n; i++) { const u = Math.PI * i / na2, s = Math.sin(u), c = Math.cos(u); air[d2 + i] -= 0.35 * 3 * s * (2 * c * c - s * s); }
  // (2) turbulence "sizzle" of the jet (band 2–9 kHz), follows |dV/dt| then a 2.5 ms tail
  { const h = new BQ('hp', 2000, 0.7, sr), l = new BQ('lp', 7000, 0.7, sr), kt = Math.exp(-1 / (0.0025 * sr)); let tail = 0;
    for (let i = 0; i < Math.min(n, Math.round(0.03 * sr)); i++) {
      const u = Math.PI * Math.min(i, na) / na, jet = i <= na ? Math.abs(Math.sin(u) * Math.sin(u) * Math.cos(u)) * 2.6 : 0;
      tail = Math.max(tail * kt, jet);
      fizz[i] = l.run(h.run((r() * 2 - 1) * tail));
    } }
  // (3) bending modes: amplitude ∝ |φn(ξ)| · F(fn;Tc) · radiation(fn)  (thin cylinder radiates highs better)
  const xi = P.xi + (r() - 0.5) * 0.012;
  BAT_MODES.forEach(([f0, tau], k) => {
    const f = f0 * (1 + (r() - 0.5) * 0.05), shape = beamShape(k, xi) / 2;   // signed residue → correct (anti)resonances
    let a = shape * halfSineSpec(f, tc) * Math.pow(f / 1000, 0.55 * P.rad);
    if (P.sting && k === 0) a *= 1 + P.sting;             // jammed: handle whips — the "sting" mode
    const w = TAU * f / sr, kd = Math.exp(-1 / (tau * (0.9 + r() * 0.2) * sr)), cw = Math.cos(w), sw = Math.sin(w);
    let c = 1, s = 0, env = a;
    for (let i = 0; i < n && (env > 1e-7 || env < -1e-7); i++) { const cc = c * cw - s * sw; s = s * cw + c * sw; c = cc; modal[i] += s * env * Math.min(1, i / (tc * sr + 1)); env *= kd; }
  });
  // (4) ball–barrel "thock": the compressed core (≈300 Hz, heavily damped) — the small 300 Hz peak in field spectra
  { const f = 290 + r() * 40, w = TAU * f / sr, kd = Math.exp(-1 / (0.0035 * sr)); let env = 1;
    for (let i = 0; i < n && env > 1e-6; i++) { body[i] = Math.sin(w * i) * env * Math.min(1, i / (tc * sr * 0.5 + 1)); env *= kd; } }
  // mix by ENERGY share (what loudness tracks)
  const en = a => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return e || 1; };
  const tot = P.air + P.modal + P.body + P.sizzle;
  const ga = Math.sqrt(P.air / tot / en(air)), gm = Math.sqrt(P.modal / tot / en(modal)), gb = Math.sqrt(P.body / tot / en(body)), gz = Math.sqrt(P.sizzle / tot / en(fizz));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = air[i] * ga + modal[i] * gm + body[i] * gb + fizz[i] * gz;
  fadeEdges(out, 0, Math.round(0.03 * sr));
  return normalize(out, 1);
}
// ---- catcher's mitt: air popped out of the pocket + leather slap + pocket/hand modes ----
function genMitt(sr, seed, hard) { // hard 0..1 (≈75 → 98 mph)
  const r = mulberry(seed), n = Math.round(0.32 * sr), out = new Float32Array(n);
  const Ta = (1.7 - 0.6 * hard) * 0.001, na = Math.round(Ta * sr);
  const pop = new Float32Array(n), slap = new Float32Array(n), modes = new Float32Array(n), hand = new Float32Array(n);
  for (let i = 0; i <= na; i++) { const u = Math.PI * i / na, s = Math.sin(u), c = Math.cos(u); pop[i] = 3 * s * (2 * c * c - s * s); }
  { const h = new BQ('hp', 1100, 0.7, sr), l = new BQ('lp', 5200, 0.7, sr), k = Math.exp(-1 / ((0.004 - 0.0015 * hard) * sr)); let e = 1;
    for (let i = 0; i < 0.05 * sr; i++) { slap[i] = l.run(h.run((r() * 2 - 1) * e)); e *= k; } }
  [[215, 1, 0.012], [405, 0.7, 0.008], [730, 0.4, 0.005], [1330, 0.22, 0.003]].forEach(([f, a, tau]) => {
    const w = TAU * f * (1 + (r() - 0.5) * 0.06) / sr, kd = Math.exp(-1 / (tau * sr)); let env = a;
    for (let i = 0; i < n && env > 1e-6; i++) { modes[i] += Math.sin(w * i) * env * Math.min(1, i / (0.0008 * sr)); env *= kd; }
  });
  { const l = new BQ('lp', 220, 0.7, sr), k = Math.exp(-1 / (0.016 * sr)); let e = 1; // catcher's hand/arm absorbing the ball
    for (let i = 0; i < n; i++) { hand[i] = l.run((r() * 2 - 1) * e); e *= k; } }
  const en = a => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return e || 1; };
  const W = [0.5 + 0.1 * hard, 0.1 + 0.08 * hard, 0.26, 0.1], tot = W.reduce((a, b) => a + b, 0);
  const gs = [pop, slap, modes, hand].map((a, j) => Math.sqrt(W[j] / tot / en(a)));
  for (let i = 0; i < n; i++) out[i] = pop[i] * gs[0] + slap[i] * gs[1] + modes[i] * gs[2] + hand[i] * gs[3];
  fadeEdges(out, 0, Math.round(0.03 * sr));
  return normalize(out, 1);
}
// ---- tonewheel key click: the 9 busbar contacts closing a few 100 µs apart ----
function genKeyClick(sr, seed) {
  const r = mulberry(seed), n = Math.round(0.012 * sr), out = new Float32Array(n);
  const bp = new BQ('bp', 2600 + r() * 2200, 0.8, sr), hp = new BQ('hp', 700, 0.7, sr);
  const bounces = Array.from({ length: 4 + Math.floor(r() * 4) }, () => [Math.round(r() * 0.004 * sr), 0.4 + r() * 0.6]);
  for (let i = 0; i < n; i++) {
    let e = 0; for (const [at, a] of bounces) if (i >= at) e += a * Math.exp(-(i - at) / (0.0006 * sr));
    out[i] = hp.run(bp.run((r() * 2 - 1) * e) + (r() * 2 - 1) * e * 0.25);
  }
  return normalize(fadeEdges(out, 0, 24), 1);
}
// ---- drums (music cues) -----------------------------------------------------------
function genKick(sr, seed) {
  const r = mulberry(seed), n = Math.round(0.45 * sr), out = new Float32Array(n), hp = new BQ('hp', 2500, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = 56 + 120 * Math.exp(-t / 0.028) + 260 * Math.exp(-t / 0.003); ph += TAU * f / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.13) * (1 - Math.exp(-t / 0.0008)) + hp.run((r() * 2 - 1) * Math.exp(-t / 0.0025)) * 0.6;
  }
  return normalize(fadeEdges(out, 0, Math.round(0.08 * sr)), 1);
}
function genSnare(sr, seed) {
  const r = mulberry(seed), n = Math.round(0.32 * sr), out = new Float32Array(n);
  const bp = new BQ('bp', 3200, 0.55, sr), hp = new BQ('hp', 850, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tone = Math.sin(TAU * 186 * t) * Math.exp(-t / 0.055) * 0.55 + Math.sin(TAU * 332 * t) * Math.exp(-t / 0.035) * 0.3;
    out[i] = tone * (1 - Math.exp(-t / 0.0007)) + hp.run(bp.run((r() * 2 - 1))) * Math.exp(-t / 0.07) * 1.6;
  }
  return normalize(fadeEdges(out, 0, Math.round(0.06 * sr)), 1);
}
function genHat(sr, seed, open) {
  const r = mulberry(seed), n = Math.round((open ? 0.6 : 0.12) * sr), out = new Float32Array(n);
  const hp = new BQ('hp', 7200, 0.7, sr), bp = new BQ('bp', 10500, 0.7, sr);
  const partials = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * 1.9);
  for (let i = 0; i < n; i++) {
    const t = i / sr; let m = 0; for (const f of partials) m += Math.sin(TAU * f * t) > 0 ? 1 : -1;
    out[i] = hp.run(bp.run((r() * 2 - 1) * 0.8 + m * 0.08)) * Math.exp(-t / (open ? 0.2 : 0.028));
  }
  return normalize(fadeEdges(out, 0, Math.round((open ? 0.15 : 0.02) * sr)), 1);
}
function genCymbal(sr, seed, dur, reverse) { // crash / reverse-cymbal swell (stereo)
  const r = mulberry(seed), n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const f = [0, 1].map(() => [new BQ('hp', 3200, 0.7, sr), new BQ('peak', 6500, 1, sr, 5)]);
  const P = Array.from({ length: 12 }, () => { const w = TAU * (3000 + r() * 9000) / sr, p = r() * TAU; return { cw: Math.cos(w), sw: Math.sin(w), c: Math.cos(p), s: Math.sin(p), a: 0.03 + r() * 0.06, k: reverse ? 1 : Math.exp(-1 / ((0.3 + r() * 1.2) * sr)) }; });
  const kd = Math.exp(-1 / (0.6 * sr)), ka = Math.exp(-1 / (0.002 * sr));
  let ed = 1, ea = 1;
  for (let i = 0; i < n; i++) {
    const env = reverse ? Math.pow(i / n, 2.6) : ed * (1 - ea); ed *= kd; ea *= ka;
    let m = 0;
    for (let j = 0; j < P.length; j++) { const q = P[j], c = q.c * q.cw - q.s * q.sw; q.s = q.s * q.cw + q.c * q.sw; q.c = c; m += q.s * q.a; q.a *= q.k; }
    L[i] = f[0][1].run(f[0][0].run((r() * 2 - 1) + m)) * env;
    R[i] = f[1][1].run(f[1][0].run((r() * 2 - 1) + m)) * env;
    if (!reverse && i < 0.012 * sr) { const b = 0.6 * (1 - i / (0.012 * sr)); L[i] += (r() * 2 - 1) * b; R[i] += (r() * 2 - 1) * b; }
  }
  const fo = reverse ? 160 : Math.round(0.35 * sr); fadeEdges(L, 0, fo); fadeEdges(R, 0, fo);
  return normalize2(L, R, 1);
}
// ---- hand claps: 2–3 skin impacts (palm cavity resonance 0.8–2.5 kHz) + short room ----
function genClapBurst(sr, r, out, at, gain, pan, fc, stereo, lpHz) {
  const bp = new BQ('bp', fc, 0.9, sr), hp = new BQ('hp', 500, 0.7, sr), lp = lpHz ? new BQ('lp', lpHz, 0.7, sr) : null;
  const n = Math.round(0.07 * sr), [gl, gr] = panLR(pan), s1 = Math.round((0.004 + r() * 0.004) * sr), s2 = Math.round((0.009 + r() * 0.006) * sr);
  const ks = Math.exp(-1 / (0.003 * sr)), kb = Math.exp(-1 / (0.024 * sr)); let e0 = 1, e1 = 0.6, e2 = 0.6, eb = 0.3;
  for (let i = 0; i < n; i++) {
    const env = e0 + (i >= s1 ? e1 : 0) + (i >= s2 ? e2 : 0) + eb; e0 *= ks; if (i >= s1) e1 *= ks; if (i >= s2) e2 *= ks; eb *= kb;
    let v = hp.run(bp.run(r() * 2 - 1)) * env * gain; if (lp) v = lp.run(v);
    const k = at + i; if (k >= out[0].length) break;
    out[0][k] += v * gl; if (stereo) out[1][k] += v * gr;
  }
}
function genClap(sr, seed) { const r = mulberry(seed), a = new Float32Array(Math.round(0.2 * sr)); genClapBurst(sr, r, [a], 0, 1, 0, 1250, false); return normalize(a, 1); }
function genCrowdClap(sr, seed, people = 40) { // one beat of a section clapping together (±25 ms human spread)
  const r = mulberry(seed), n = Math.round(0.36 * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let p = 0; p < people; p++) {
    const dist = r(), j = Math.max(0, Math.round((0.035 + (r() + r() + r() - 1.5) * 0.03) * sr + dist * 0.012 * sr));
    genClapBurst(sr, r, [L, R], j, (0.25 + 0.75 * (1 - dist)) * (0.5 + 0.5 * r()), r() * 2 - 1, 800 + r() * 1700, true, 2500 + 6000 * (1 - dist));
  }
  return normalize2(L, R, 1);
}
// ---- finger / lip whistles (breathy, pitch-contoured) ----
function genWhistle(sr, seed, kind) {
  const r = mulberry(seed);
  const shapes = [ // [dur, f0 keys (relative), amp keys]
    [0.55, [[0, 0.82], [0.12, 1.0], [0.55, 1.05]], [[0, 0], [0.05, 1], [0.42, 0.9], [0.55, 0]]],                       // rising "fweeet"
    [1.2, [[0, 0.95], [0.1, 1.0], [1.1, 0.97], [1.2, 0.9]], [[0, 0], [0.06, 1], [1.05, 0.85], [1.2, 0]]],               // long steady, vibrato
    [0.9, [[0, 1], [0.18, 1.02], [0.2, 0.9], [0.3, 0.95], [0.5, 1.0], [0.52, 0.88], [0.9, 0.95]], [[0, 0], [0.03, 1], [0.17, 0.9], [0.2, 0.1], [0.23, 1], [0.48, 0.9], [0.5, 0.1], [0.53, 1], [0.85, 0.8], [0.9, 0]]], // "wheet-wheet-wheet"
    [0.7, [[0, 1.12], [0.05, 1.1], [0.7, 0.8]], [[0, 0], [0.04, 1], [0.5, 0.8], [0.7, 0]]],                           // falling
    [1.6, [[0, 0.9], [0.3, 1.1], [0.6, 1.0], [1.0, 1.12], [1.6, 1.05]], [[0, 0], [0.08, 1], [1.4, 0.85], [1.6, 0]]],    // long stadium siren whistle
  ][kind % 5];
  const [dur, fk, ak] = shapes, n = Math.round(dur * sr), out = new Float32Array(n);
  const base = 2300 + r() * 1200, fP = PL(fk), aP = PL(ak), vib = 4.5 + r() * 2.5, vd = kind === 1 ? 0.018 : 0.007;
  const nb = new BQ('bp', base, 6, sr); let ph = 0, jit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; if ((i & 31) === 0) { jit = (jit + (r() - 0.5) * 0.004) * 0.97; nb.set('bp', base * fP(t), 6, sr); }
    const f = base * fP(t) * (1 + jit + vd * SIN(TAU * vib * t)); ph += f / sr; if (ph > 1) ph -= 1;
    const a = aP(t); out[i] = (SIN(TAU * ph) + 0.08 * SIN(2 * TAU * ph) + nb.run(r() * 2 - 1) * 1.6 + (r() * 2 - 1) * 0.02) * a;
  }
  return normalize(fadeEdges(out, 64, 128), 1);
}
// ---- noise beds ---------------------------------------------------------------
function genWhite(sr, dur, seed) { const r = mulberry(seed), a = new Float32Array(Math.round(dur * sr)); for (let i = 0; i < a.length; i++) a[i] = r() * 2 - 1; return a; }
function genPink(sr, dur, seed) { // stereo seamless loop (equal-power crossfade)
  const r = mulberry(seed), n = Math.round(dur * sr), xf = Math.round(0.4 * sr), out = [];
  for (let c = 0; c < 2; c++) {
    const tmp = new Float32Array(n + xf); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n + xf; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      tmp[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    const a = tmp.slice(0, n);
    for (let i = 0; i < xf; i++) { const k = i / xf; a[i] = tmp[i] * Math.sqrt(k) + tmp[n + i] * Math.sqrt(1 - k); }
    out.push(a);
  }
  return normalize2(out[0], out[1], 0.9);
}

// ---- VOICES — Klatt-style cascade formant synthesis for crowd texture -------------
// Never exposed solo: every voice is one of dozens mixed at a distance, pitch-shifted by
// resampling (a different "person" per instance), low-passed by air absorption and sent to
// the stadium reverb. Formants: Hillenbrand/Peterson–Barney adult-male means [F1..F4],[B1..B4].
const FMT = {
  i: [[270, 2290, 3010, 3700], [60, 90, 150, 200]],   e: [[530, 1840, 2480, 3500], [70, 100, 150, 200]],
  ae: [[660, 1720, 2410, 3500], [80, 100, 150, 200]], a: [[730, 1090, 2440, 3500], [90, 110, 160, 200]],
  o: [[570, 840, 2410, 3400], [80, 90, 150, 200]],    oh: [[450, 800, 2600, 3400], [70, 80, 150, 200]],
  u: [[300, 870, 2240, 3300], [60, 80, 140, 200]],    uh: [[640, 1190, 2390, 3500], [80, 100, 150, 200]],
  er: [[490, 1350, 1690, 3300], [70, 100, 110, 200]], n: [[280, 1300, 2500, 3400], [100, 300, 300, 300]],
};
// Rosenberg glottal flow + its derivative (radiated), for modal (0) and pressed/shouted (1) phonation.
const GL = (() => {
  const mk = (tp, tn) => {
    const N = 1024, g = new Float32Array(N + 2), d = new Float32Array(N + 2);
    for (let i = 0; i <= N + 1; i++) { const p = (i % N) / N; g[i] = p < tp ? 0.5 * (1 - Math.cos(Math.PI * p / tp)) : p < tp + tn ? Math.cos(Math.PI / 2 * (p - tp) / tn) : 0; }
    let m = 0; for (let i = 0; i <= N; i++) { d[i] = g[(i + 1) % N] - g[(i + N - 1) % N]; m = Math.max(m, Math.abs(d[i])); }
    for (let i = 0; i <= N + 1; i++) d[i] /= m; return { g, d };
  };
  return [mk(0.44, 0.2), mk(0.36, 0.08)];
})();
/**
 * genUtt(sr, U, r) — one utterance. All tracks are piecewise-linear keyframes [[t, v], …] (t in s):
 *  U.f0 (Hz), U.amp, U.vow ([[t,'a'],…] formant targets), U.voi (voicing 0..1), U.fric ([[t, amp, fcHz]]),
 *  U.effort (0 speech … 1 shout; number or keys), U.fs (formant scale; ≈1.17 female), U.breath, U.vib [Hz, depth], U.jit
 */
function genUtt(sr, U, r) {
  const n = Math.max(64, Math.round(U.dur * sr)), out = new Float32Array(n);
  const f0P = PL(U.f0), aP = PL(U.amp), vP = PL(U.voi || 1), eP = PL(U.effort ?? 0.3);
  const fk = U.fric || [[0, 0, 4000]], fr = [PL(fk.map(k => [k[0], k[1]])), PL(fk.map(k => [k[0], k[2] || 4000]))];
  const vk = U.vow.map(([t, v]) => [t, FMT[v] || FMT.uh]);
  const Fp = [0, 1, 2, 3].map(j => PL(vk.map(([t, f]) => [t, f[0][j]]))), Bp = [0, 1, 2, 3].map(j => PL(vk.map(([t, f]) => [t, f[1][j]])));
  const fs = U.fs || 1, br = U.breath ?? 0.15, nf = U.nf || 4, vib = U.vib || [5, 0], jitA = U.jit ?? 0.012, lim = sr * 0.45;
  const G0 = GL[0], G1 = GL[1], co = new Float64Array(12), st = new Float64Array(8);
  let ph = r(), jit = 0, shim = 0, f0 = 100, A = 0, Av = 1, An = 0, eff = 0.3, a0 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr;
      jit = (jit + (r() - 0.5) * jitA) * 0.96;
      f0 = f0P(t) * (1 + jit + vib[1] * Math.sin(TAU * vib[0] * t));
      A = aP(t); Av = vP(t); eff = clamp(eP(t), 0, 1);
      for (let j = 0; j < nf; j++) {
        const F = Math.min(Fp[j](t) * fs * (j === 0 ? 1 + 0.18 * eff : 1), lim), B = Bp[j](t) * (1 + 0.35 * eff);
        const C = -Math.exp(-TAU * B / sr), Bc = 2 * Math.exp(-Math.PI * B / sr) * Math.cos(TAU * F / sr);
        co[j * 3] = 1 - Bc - C; co[j * 3 + 1] = Bc; co[j * 3 + 2] = C;
      }
      { An = fr[0](t); if (An > 0) { const w = TAU * Math.min(fr[1](t), lim) / sr, al = Math.sin(w) / 4.4, q0 = 1 + al; a0 = al / q0; a1 = -2 * Math.cos(w) / q0; a2 = (1 - al) / q0; } }
    }
    ph += f0 / sr; if (ph >= 1) { ph -= 1; shim = (r() - 0.5) * 0.14; }
    const gp = ph * 1024, gi = gp | 0, gf = gp - gi;
    const d = (G0.d[gi] + (G0.d[gi + 1] - G0.d[gi]) * gf) * (1 - eff) + (G1.d[gi] + (G1.d[gi + 1] - G1.d[gi]) * gf) * eff;
    const g = G0.g[gi] * (1 - eff) + G1.g[gi] * eff;
    let x = (d * (1 + shim) + (r() * 2 - 1) * br * (0.2 + g)) * Av;
    for (let j = 0; j < nf; j++) { const y = co[j * 3] * x + co[j * 3 + 1] * st[j * 2] + co[j * 3 + 2] * st[j * 2 + 1]; st[j * 2 + 1] = st[j * 2]; st[j * 2] = y; x = y; }
    if (An > 0) { const w2 = r() * 2 - 1, y = a0 * w2 - a0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = w2; y2 = y1; y1 = y; x += y * An * 0.25; }
    out[i] = x * A;
  }
  return out;
}
// keyframe helpers: a step with a short ramp, and a tiny DSL for building utterances
function Keys(v0) { const k = [[0, v0]]; k.to = (t, v, ramp = 0.012) => { k.push([t, k[k.length - 1][1]], [t + ramp, v]); return k; }; k.at = (t, v) => { k.push([t, v]); return k; }; return k; }
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'uh', 'ae', 'er', 'oh'];
function talkUtt(r, fem, laugh) { // a conversational phrase: 3–7 syllables with fricatives / stops / nasals
  const pick = a => a[Math.floor(r() * a.length)];
  const b = (fem ? 205 : 118) * (0.85 + r() * 0.3), fs = fem ? 1.15 + r() * 0.05 : 0.97 + r() * 0.06;
  const amp = Keys(0), voi = Keys(0), fric = [[0, 0, 4000]], vow = [], f0 = [];
  let t = 0.01; const nSyl = laugh ? 4 + Math.floor(r() * 3) : 3 + Math.floor(r() * 5), decl = 0.1 + 0.2 * r();
  for (let k = 0; k < nSyl; k++) {
    const stress = laugh ? 1 - k * 0.1 : (r() < 0.35 ? 1.15 : 1), c = laugh ? 'h' : pick(['f', 'f', 'p', 'p', 'n', 'n', '-', 'h']);
    if (c === 'f' || c === 'h') { const d = laugh ? 0.035 : 0.04 + r() * 0.05, fc = c === 'h' ? 1500 + r() * 800 : 2800 + r() * 3600;
      voi.to(t, c === 'h' ? 0 : 0.08); amp.to(t, 0.6); fric.push([t, 0, fc], [t + 0.01, c === 'h' ? 0.5 : 0.8, fc], [t + d - 0.01, c === 'h' ? 0.35 : 0.7, fc], [t + d, 0, fc]); t += d; }
    else if (c === 'p') { const d = 0.03 + r() * 0.03, fc = 1500 + r() * 2500; voi.to(t, 0); amp.to(t, 0.02, 0.008); t += d; amp.to(t, 0.7, 0.003); fric.push([t, 0, fc], [t + 0.002, 1.2, fc], [t + 0.014, 0, fc]); t += 0.012; }
    else if (c === 'n') { const d = 0.035 + r() * 0.04; voi.to(t, 0.45); amp.to(t, 0.55); vow.push([t + d / 2, 'n']); t += d; }
    const dv = laugh ? 0.07 + r() * 0.03 : (0.07 + r() * 0.12) * stress;
    voi.to(t, 1, 0.01); amp.to(t, stress * (0.85 + 0.15 * r()), 0.015);
    vow.push([t + dv * 0.5, laugh ? pick(['a', 'ae', 'uh']) : pick(VOWELS)]);
    const u = t / 1.5, ff = b * (1 - decl * Math.min(1, u)) * (laugh ? 1.3 - 0.07 * k : 1) * (stress > 1 ? 1.12 : 1);
    f0.push([t, ff * (0.97 + 0.06 * r())], [t + dv, ff * (0.92 + 0.08 * r())]);
    t += dv;
    if (!laugh && r() < 0.18) { amp.to(t, 0.05, 0.03); voi.to(t, 0); t += 0.06 + r() * 0.1; } // micro-pause
  }
  amp.to(t, 0, 0.04); voi.to(t + 0.03, 0); t += 0.06;
  if (!vow.length) vow.push([0, 'uh']); if (f0.length < 2) f0.push([0, b], [t, b]);
  return { dur: t, f0, amp: amp.slice(), vow, voi: voi.slice(), fric, fs, effort: laugh ? 0.45 : 0.12 + 0.2 * r(), breath: laugh ? 0.35 : 0.12 + 0.1 * r(), jit: 0.015 };
}
function shoutUtt(r, kind, fem) { // a single fan's cheer / hey / woo / aah / whoa
  const b = (fem ? 360 : 225) * (0.85 + r() * 0.35), fs = fem ? 1.14 + r() * 0.06 : 1.0 + r() * 0.06;
  const vib = [4.5 + r() * 2.5, 0.012 + r() * 0.02], common = { fs, vib, breath: 0.28 + r() * 0.22, jit: 0.02 };
  if (kind === 'yeah') { const d = 0.8 + r() * 1.0; return { ...common, dur: d, effort: 0.8 + 0.2 * r(), vow: [[0, 'i'], [0.1, 'e'], [0.28, 'ae'], [0.55, 'a'], [d, 'a']],
    f0: [[0, b * 0.9], [0.16, b * 1.15], [d * 0.6, b * 1.08], [d, b * 0.82]], amp: [[0, 0], [0.06, 1], [d * 0.62, 0.9], [d, 0]] }; }
  if (kind === 'woo') { const d = 0.9 + r() * 0.8; return { ...common, dur: d, effort: 0.7, breath: 0.45, vow: [[0, 'u'], [d * 0.8, 'u'], [d, 'oh']],
    f0: [[0, b * 0.95], [d * 0.3, b * 1.55], [d * 0.75, b * 1.45], [d, b * 1.05]], amp: [[0, 0], [0.1, 0.8], [d * 0.35, 1], [d * 0.8, 0.8], [d, 0]] }; }
  if (kind === 'hey') { const d = 0.3 + r() * 0.16; return { ...common, dur: d, effort: 0.95, vow: [[0, 'e'], [d * 0.6, 'e'], [d, 'i']], fric: [[0, 0, 1700], [0.005, 0.7, 1700], [0.045, 0.5, 1900], [0.06, 0, 2000]],
    voi: [[0, 0], [0.045, 0], [0.06, 1]], f0: [[0, b * 1.1], [d * 0.45, b * 1.18], [d, b * 0.82]], amp: [[0, 0], [0.01, 0.8], [0.07, 1], [d * 0.7, 0.85], [d, 0]] }; }
  if (kind === 'aah') { const d = 1.0 + r() * 1.2; return { ...common, dur: d, effort: 0.75 + 0.25 * r(), vow: [[0, 'ae'], [0.2, 'a'], [d, r() < 0.5 ? 'a' : 'uh']],
    f0: [[0, b * 0.95], [0.25, b * 1.12], [d * 0.7, b * 1.05], [d, b * 0.85]], amp: [[0, 0], [0.08, 1], [d * 0.7, 0.9], [d, 0]] }; }
  if (kind === 'go') { const d = 0.45 + r() * 0.3; return { ...common, dur: d, effort: 0.9, vow: [[0, 'oh'], [d, 'u']], fric: [[0, 0, 1300], [0.002, 1, 1300], [0.016, 0, 1300]],
    voi: [[0, 0], [0.014, 0], [0.022, 1]], f0: [[0, b * 1.2], [d, b * 0.9]], amp: [[0, 0], [0.02, 1], [d * 0.6, 0.9], [d, 0]] }; }
  // 'whoa'
  const d = 1.0 + r() * 0.6; return { ...common, dur: d, effort: 0.75, vow: [[0, 'u'], [d * 0.3, 'oh'], [d * 0.6, 'a'], [d, 'a']],
    f0: [[0, b * 0.85], [d * 0.5, b * 1.2], [d, b * 0.9]], amp: [[0, 0], [0.1, 0.8], [d * 0.55, 1], [d, 0]] };
}
function oohUtt(r, fem, d = 4.2) { // the rising "ooooOOOH" as a fly ball carries
  const b = (fem ? 300 : 180) * (0.85 + r() * 0.3);
  return { dur: d, fs: fem ? 1.15 : 1.0 + r() * 0.05, vib: [5 + r() * 2, 0.012], breath: 0.4, jit: 0.018, nf: 3,
    effort: [[0, 0.25], [d * 0.6, 0.5], [d * 0.92, 0.85], [d, 0.8]],
    vow: [[0, 'u'], [d * 0.55, 'u'], [d * 0.88, 'oh'], [d, 'o']],
    f0: [[0, b * 0.8], [d * 0.5, b * 0.98], [d * 0.9, b * 1.32], [d, b * 1.28]],
    amp: [[0, 0], [0.25, 0.22], [d * 0.5, 0.45], [d * 0.9, 1], [d, 0.7]] };
}
function awwUtt(r, fem) { // groan on the catch
  const b = (fem ? 290 : 185) * (0.85 + r() * 0.3), d = 1.2 + r() * 0.8;
  return { dur: d, fs: fem ? 1.14 : 1.0, vib: [4.5, 0.012], breath: 0.35, jit: 0.02, effort: 0.55,
    vow: [[0, 'a'], [d * 0.45, 'o'], [d, 'u']], f0: [[0, b * 1.28], [d * 0.3, b * 1.02], [d, b * 0.7]], amp: [[0, 0], [0.09, 1], [d * 0.5, 0.75], [d, 0]] };
}
function whoaUtt(r, fem) { // a section of the wave: "whoooOOOAAA" as they stand
  const b = (fem ? 300 : 185) * (0.85 + r() * 0.3), d = 2.1 + r() * 0.5;
  return { dur: d, fs: fem ? 1.15 : 1.0 + r() * 0.05, vib: [5 + r() * 2, 0.015], breath: 0.38, jit: 0.02,
    effort: [[0, 0.3], [d * 0.6, 0.95], [d, 0.7]], vow: [[0, 'u'], [d * 0.35, 'oh'], [d * 0.55, 'o'], [d * 0.72, 'a'], [d, 'uh']],
    f0: [[0, b * 0.75], [d * 0.35, b * 0.95], [d * 0.65, b * 1.38], [d * 0.8, b * 1.3], [d, b * 0.95]],
    amp: [[0, 0], [0.2, 0.25], [d * 0.4, 0.5], [d * 0.66, 1], [d * 0.82, 0.8], [d, 0]] };
}
function vendorUtt(r, k) { // distant stadium vendor bark: the sing-song CONTOUR only (no words)
  const b = 150 + r() * 25, common = { fs: 1.0, vib: [5, 0.01], breath: 0.25, jit: 0.02, effort: 0.8 };
  if (k === 0) return { ...common, dur: 1.25, vow: [[0, 'e'], [0.4, 'e'], [0.55, 'oh'], [1.25, 'o']], fric: [[0, 0, 1700], [0.005, 0.6, 1700], [0.05, 0, 1700]], voi: [[0, 0], [0.04, 0], [0.06, 1]],
    f0: [[0, b * 1.15], [0.42, b * 1.22], [0.6, b * 1.02], [1.25, b * 0.78]], amp: [[0, 0], [0.06, 1], [0.42, 0.9], [0.5, 0.6], [0.6, 1], [1.05, 0.8], [1.25, 0]] };
  if (k === 1) return { ...common, dur: 1.3, vow: [[0, 'a'], [0.2, 'a'], [0.3, 'uh'], [0.5, 'a'], [0.62, 'ae'], [1.3, 'a']],
    voi: [[0, 1], [0.2, 1], [0.22, 0], [0.27, 0], [0.29, 1], [0.48, 1], [0.5, 0], [0.55, 0], [0.57, 1]],
    f0: [[0, b], [0.2, b * 1.02], [0.3, b * 1.08], [0.48, b * 1.1], [0.6, b * 1.34], [1.3, b * 1.2]], amp: [[0, 0], [0.03, 0.9], [0.2, 0.85], [0.3, 0.9], [0.48, 0.85], [0.6, 1], [1.1, 0.85], [1.3, 0]] };
  return { ...common, dur: 1.4, vow: [[0, 'i'], [0.5, 'i'], [1.0, 'er'], [1.4, 'er']], fric: [[0, 0, 1800], [0.005, 0.6, 1800], [0.05, 0, 1800]], voi: [[0, 0], [0.04, 0], [0.06, 1]],
    f0: [[0, b * 1.3], [0.5, b * 1.34], [1.4, b * 0.8]], amp: [[0, 0], [0.07, 1], [1.1, 0.8], [1.4, 0]] };
}
// Banks: generator jobs (yield per utterance so the idle slicer can pause between voices).
function* genBank(kind, seed) {
  const r = mulberry(seed), sr = CROWD_SR, out = [];
  const plan = {
    talk: Array.from({ length: 22 }, (_, k) => () => talkUtt(r, r() < 0.45, k % 7 === 6)),
    shout: Array.from({ length: 22 }, (_, k) => () => shoutUtt(r, ['yeah', 'woo', 'hey', 'aah', 'yeah', 'go', 'aah', 'whoa', 'yeah', 'hey', 'woo'][k % 11], r() < 0.4)),
    ooh: Array.from({ length: 6 }, (_, k) => () => oohUtt(r, k % 2 === 1)),
    aww: Array.from({ length: 6 }, (_, k) => () => awwUtt(r, k % 2 === 1)),
    whoa: Array.from({ length: 6 }, (_, k) => () => whoaUtt(r, k % 2 === 1)),
    vendor: Array.from({ length: 3 }, (_, k) => () => vendorUtt(r, k)),
  }[kind];
  for (const mk of plan) { out.push(rmsNorm(fadeEdges(genUtt(sr, mk(), r), 16, 64), 0.2)); yield; }
  return out;
}
// mix instances of bank utterances into a stereo buffer (resampled = a different speaker; one-pole LP = distance)
function mixInst(sr, L, R, bank, it, wrap) {
  const g = bank[it.g % bank.length], rate = it.rate, len = Math.floor((g.length - 1) / rate), n = L.length;
  const [gl, gr] = panLR(it.pan), a = 1 - Math.exp(-TAU * it.lp / sr), fin = it.fadeIn ? Math.round(it.fadeIn * sr) : 0;
  let y = 0, k = it.at;
  for (let j = 0; j < len; j++, k++) {
    const sp = j * rate, i0 = sp | 0, fr = sp - i0; y += a * (g[i0] + (g[i0 + 1] - g[i0]) * fr - y);
    if (k >= n) { if (!wrap) break; k -= n; }
    const v = y * it.gain * (fin && j < fin ? j / fin : 1);
    L[k] += v * gl; R[k] += v * gr;
  }
  return len;
}
const distGain = d => 0.12 + 0.88 * Math.pow(1 - d, 2), distLP = d => 900 + 5200 * Math.pow(1 - d, 1.6);
// seamless loop: a crowd of `voices` people talking (phrases + pauses), near voices are few
function* genMurmur(dur, seed, voices, talk, o = {}) {
  const r = mulberry(seed), sr = CROWD_SR, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let v = 0; v < voices; v++) {
    const dist = o.far ? 0.45 + 0.55 * r() : Math.pow(r(), 0.6), pan = (r() * 2 - 1) * (o.width ?? 0.95), rate = (o.rate ?? 1) * (0.9 + r() * 0.22);
    const gain = distGain(dist) * (dist < 0.2 ? 0.6 : 1), lp = distLP(dist) * (o.lpk ?? 1);
    let pos = Math.floor(r() * n), total = 0;
    while (total < n) {
      const g = Math.floor(r() * talk.length), len = mixInst(sr, L, R, talk, { g, rate, pan, lp, gain: gain * (0.7 + 0.3 * r()), at: pos }, true);
      const gap = len + Math.floor(sr * (0.2 + r() * (o.busy ? 0.5 : 1.3))); pos = (pos + gap) % n; total += gap;
    }
    if ((v & 3) === 3) yield;
  }
  return normalize2(L, R, 0.9);
}
// seamless loop of a cheering crowd: dense overlapping shouts
function* genRoar(dur, seed, count, shout) {
  const r = mulberry(seed), sr = CROWD_SR, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const dist = Math.pow(r(), 0.55);
    mixInst(sr, L, R, shout, { g: Math.floor(r() * 1e6), rate: 0.84 + r() * 0.36, pan: (r() * 2 - 1) * 0.95, lp: distLP(dist) * 1.1, gain: distGain(dist) * (0.6 + 0.4 * r()), at: Math.floor(r() * n) }, true);
    if ((k & 7) === 7) yield;
  }
  return normalize2(L, R, 0.9);
}
// one-shot crowd reaction: `count` voices, onsets clustered in `spread` s, a `late` fraction joining later
function* genShoutMix(dur, bank, seed, count, spread, late = 0, o = {}) {
  const r = mulberry(seed), sr = CROWD_SR, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const isLate = r() < late, dist = Math.pow(r(), 0.6);
    const at = Math.floor(sr * (isLate ? spread + r() * dur * 0.4 : -Math.log(1 - r() * 0.95) * spread * 0.35));
    mixInst(sr, L, R, bank, { g: Math.floor(r() * 1e6), rate: (o.rate ?? 1) * (0.88 + r() * 0.26), pan: (r() * 2 - 1) * (o.width ?? 0.95), lp: distLP(dist) * (o.lpk ?? 1),
      gain: distGain(dist) * (isLate ? 0.6 : 1) * (0.7 + 0.3 * r()), at: Math.min(n - 1, at), fadeIn: o.fadeIn }, false);
    if ((k & 7) === 7) yield;
  }
  fadeEdges(L, 0, Math.round(0.25 * sr)); fadeEdges(R, 0, Math.round(0.25 * sr));
  return normalize2(L, R, 0.95);
}

// ---- PARK AMBIENCE --------------------------------------------------------------
// Wrigley: the elevated Red Line a block east (≈150 m): steel-structure rumble, rail-joint clatter
// from every axle, flange squeal on the curve, all through distance/air absorption.
function* genTrain(seed) {
  const r = mulberry(seed), sr = CROWD_SR, dur = 13, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const tc = 6.4, v = 12, dmin = 150, dist = t => Math.sqrt(dmin * dmin + (v * (t - tc)) ** 2), panAt = t => clamp(0.55 + 0.3 * Math.tanh((t - tc) / 4), -1, 1);
  const lvl = t => { const d = dist(t), trainLen = 110, over = clamp(1 - Math.abs(v * (t - tc)) / (trainLen + 160), 0, 1); return (dmin / d) * (0.35 + 0.65 * over); };
  { // rumble + structure roar
    const p1 = new BQ('peak', 62, 1.4, sr, 6), p2 = new BQ('peak', 108, 1.6, sr, 6), p3 = new BQ('lp', 380, 0.7, sr), q1 = new BQ('bp', 380, 0.7, sr), q2 = new BQ('bp', 950, 0.8, sr);
    let y = 0, a = 0, gl = 0, gr = 0;
    for (let i = 0; i < n; i++) { if ((i & 63) === 0) { const t = i / sr; a = lvl(t); [gl, gr] = panLR(panAt(t)); } y = brownStep(r, y, 0.995); const w = r() * 2 - 1; const s = (p3.run(p2.run(p1.run(y))) * 0.4 + q1.run(w) * 0.6 + q2.run(w) * 0.36) * a; L[i] += s * gl; R[i] += s * gr; }
  }
  yield;
  { // wheel clatter: 6 cars × 4 axles crossing rail joints every 11.9 m (the classic ka-thunk … ka-thunk)
    const axles = []; for (let c = 0; c < 6; c++) for (const tr of [2.3, 12.3]) for (const ax of [-1.05, 1.05]) axles.push(c * 14.6 + tr + ax);
    const joints = []; for (let x = -170; x <= 170; x += 11.9) joints.push(x);
    const k1 = TAU * 150 / sr, k2 = TAU * 410 / sr, k3 = TAU * 1350 / sr, kd = Math.exp(-1 / (0.022 * sr)), kd3 = Math.exp(-1 / (0.006 * sr));
    for (const j of joints) for (const a of axles) {
      const t = tc + (j + a - 60) / v; if (t < 0.05 || t > dur - 0.2) continue;
      const d = Math.sqrt(dmin * dmin + j * j), amp = 0.8 * (dmin / d) * (0.7 + 0.3 * r()), [gl, gr] = panLR(clamp(0.55 + j / 400, -1, 1));
      const i0 = Math.round(t * sr); let e = amp, e3 = amp * 0.55;
      for (let i = 0; i < 0.06 * sr && i0 + i < n; i++) { const s = (SIN(k1 * i) + 0.5 * SIN(k2 * i)) * e + SIN(k3 * i) * e3; L[i0 + i] += s * gl; R[i0 + i] += s * gr; e *= kd; e3 *= kd3; }
    }
  }
  yield;
  { // flange squeal on the curve (narrow tones ≈3 kHz with slow FM / random AM)
    const t0 = tc - 2.5 + r(), t1 = tc + 3 + r(); let ph1 = 0, ph2 = 0, am = 0.5;
    for (let i = Math.round(t0 * sr); i < Math.min(n, t1 * sr); i++) {
      const t = i / sr, u = (t - t0) / (t1 - t0), env = Math.sin(Math.PI * u) ** 2 * lvl(t);
      if ((i & 63) === 0) am = clamp(am + (r() - 0.5) * 0.25, 0.1, 1);
      const f = 3050 + 70 * Math.sin(TAU * 0.7 * t) + 25 * Math.sin(TAU * 5.3 * t); ph1 += f / sr; ph2 += f * 1.505 / sr;
      const s = (SIN(TAU * ph1) + 0.35 * SIN(TAU * ph2)) * env * am * 0.07, pg = panAt(t) * 0.25 + 0.75; L[i] += s * (1 - pg) * 1.4; R[i] += s * pg * 1.4;
    }
  }
  // air absorption over ~150 m: gentle LP
  for (const ch of [L, R]) { const f = new BQ('lp', 2600, 0.6, sr); for (let i = 0; i < n; i++) ch[i] = f.run(ch[i]); }
  fadeEdges(L, Math.round(1.5 * sr), Math.round(2 * sr)); fadeEdges(R, Math.round(1.5 * sr), Math.round(2 * sr));
  return normalize2(L, R, 0.9);
}
// Rate Field: the Dan Ryan Expressway behind LF — tyre roar, engine rumble, vehicle passes. Seamless loop.
function* genTraffic(seed) {
  const r = mulberry(seed), sr = CROWD_SR, dur = 12, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  { const bl = new BQ('bp', 650, 0.5, sr), br = new BQ('bp', 700, 0.5, sr), ll = new BQ('lp', 110, 0.7, sr), lr = new BQ('lp', 110, 0.7, sr); let yl = 0, yr = 0;
    for (let i = 0; i < n; i++) { yl = brownStep(r, yl); yr = brownStep(r, yr); L[i] += bl.run(r() * 2 - 1) * 0.5 + ll.run(yl) * 2.2; R[i] += br.run(r() * 2 - 1) * 0.45 + lr.run(yr) * 2.0; } }
  yield;
  for (let k = 0; k < 6; k++) { // passes (wrap around the loop so it tiles)
    const tc = r() * dur, sig = 1.2 + r() * 1.8, truck = r() < 0.35, a = (truck ? 0.9 : 0.55) * (0.6 + 0.4 * r()), dir = r() < 0.5 ? 1 : -1;
    const bp = new BQ('bp', 900, 0.7, sr); let ph = 0; const fe = truck ? 38 + r() * 12 : 0;
    let env = 0, gl = 0, gr = 0; const c0 = Math.round(tc * sr);
    for (let j = -Math.round(2.5 * sig * sr); j < 2.5 * sig * sr; j++) {
      if ((j & 63) === 0) { const u = j / sr / sig; env = Math.exp(-0.5 * u * u) * a; bp.set('bp', 900 * (1 + 0.18 * Math.tanh(-u)), 0.7, sr); [gl, gr] = panLR(clamp(-0.55 + dir * 0.35 * Math.tanh(u), -1, 1)); }
      let s = bp.run(r() * 2 - 1) * env; if (truck) { ph += fe / sr; if (ph > 1) ph -= 1; s += (SIN(TAU * ph) + 0.5 * SIN(2 * TAU * ph) + 0.3 * SIN(3 * TAU * ph)) * env * 0.35; }
      let i = (c0 + j) % n; if (i < 0) i += n; L[i] += s * gl; R[i] += s * gr;
    }
  }
  for (const ch of [L, R]) { const f = new BQ('lp', 1400, 0.6, sr); for (let i = 0; i < n; i++) ch[i] = f.run(ch[i]); }
  return normalize2(L, R, 0.9);
}
// distant transit-train horn: two blasts of a three-note chord
function genTrainHorn(sr, seed) {
  const r = mulberry(seed), dur = 3.2, n = Math.round(dur * sr), out = new Float32Array(n);
  const fs = [311, 370, 466].map(f => f * (0.99 + r() * 0.02)), blasts = [[0.05, 0.85], [1.15, 1.9]];
  const lp = new BQ('lp', 1600, 0.7, sr), pk = new BQ('peak', 900, 1, sr, 5); const ph = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = i / sr; let env = 0; for (const [a, b] of blasts) if (t >= a && t < b + 0.25) env = Math.max(env, Math.min(1, (t - a) / 0.05) * (t < b ? 1 : Math.exp(-(t - b) / 0.08)));
    let s = 0; for (let j = 0; j < 3; j++) { ph[j] += fs[j] * (1 + 0.004 * Math.sin(TAU * 3 * t)) / sr; const p = ph[j] % 1; s += (2 * p - 1) * 0.33; }
    out[i] = pk.run(lp.run(s)) * env;
  }
  return normalize(fadeEdges(out, 32, 600), 1);
}
// flags snapping in the lake wind (Wrigley scoreboard masthead)
function genFlag(sr, seed) {
  const r = mulberry(seed), dur = 3, n = Math.round(dur * sr), out = new Float32Array(n);
  const bp = new BQ('bp', 700, 0.6, sr), hp = new BQ('hp', 1800, 0.7, sr); let t = 0.05;
  const env = new Float32Array(n), snap = new Float32Array(n);
  while (t < dur - 0.2) { const i0 = Math.round(t * sr), a = 0.4 + 0.6 * r(); for (let i = 0; i < 0.12 * sr && i0 + i < n; i++) { env[i0 + i] += a * Math.exp(-i / (0.035 * sr)); if (i < 0.004 * sr) snap[i0 + i] += a * (1 - i / (0.004 * sr)); } t += 0.09 + r() * 0.22; }
  for (let i = 0; i < n; i++) out[i] = bp.run(r() * 2 - 1) * env[i] * 2 + hp.run((r() * 2 - 1) * snap[i]) * 0.45;
  return normalize(fadeEdges(out, 200, 2000), 1);
}

// ---- fireworks: one shell = launch thump (+ optional whistle) → boom → glitter crackle, stereo ----
function genShell(sr, seed, whistle) {
  const r = mulberry(seed), dur = 3.3, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const p = (r() - 0.5) * 1.2, [pl, pr] = panLR(p * 0.3);
  { const lp = new BQ('lp', 500, 0.7, sr); let ph = 0, e1 = 1, e2 = 1, e3 = 1; const k1 = Math.exp(-1 / (0.02 * sr)), k2 = Math.exp(-1 / (0.03 * sr)), k3 = Math.exp(-1 / (0.05 * sr));
    for (let i = 0; i < 0.25 * sr; i++) { ph += TAU * (70 + 60 * e1) / sr; const v = (lp.run(r() * 2 - 1) * e2 * 0.5 + Math.sin(ph) * e3 * 0.45) * 0.45; L[i] += v * pl; R[i] += v * pr; e1 *= k1; e2 *= k2; e3 *= k3; } }
  if (whistle) { let ph = 0; const [wl, wr] = panLR(p * 0.5), o = Math.round(0.04 * sr);
    for (let i = 0; i < 0.8 * sr; i++) { const t = i / sr; ph += TAU * (1300 + 1500 * t / 0.8 + 40 * Math.sin(TAU * 11 * t)) / sr; const v = Math.sin(ph) * 0.05 * Math.min(1, t / 0.1) * Math.min(1, (0.8 - t) / 0.2); L[o + i] += v * wl; R[o + i] += v * wr; } }
  const ib = Math.round((0.72 + r() * 0.28) * sr), [gl, gr] = panLR(p);
  { let y = 0; const h = new BQ('hp', 900, 0.7, sr); let ph = 0;
    const k1 = Math.exp(-1 / (0.09 * sr)), k2 = Math.exp(-1 / (0.05 * sr)), k3 = Math.exp(-1 / (0.45 * sr)), k4 = Math.exp(-1 / (0.002 * sr)), k5 = Math.exp(-1 / (0.22 * sr)), k6 = Math.exp(-1 / (0.02 * sr));
    let e1 = 1, e2 = 1, e3 = 1, e4 = 1, e5 = 1, e6 = 1; const nb = Math.min(n - ib, Math.round(2.2 * sr)); const mid = new BQ('peak', 320, 0.9, sr, 9);
    for (let i = 0; i < nb; i++) {
      y += Math.min(1, TAU * (110 + 1400 * e1) / sr) * ((r() * 2 - 1) - y);
      ph += TAU * (42 + 30 * e2) / sr;
      const v = (mid.run(y) * 2.2 * e3 * (1 - e4) + Math.sin(ph) * 0.3 * e5 + (e6 > 1e-4 ? h.run(r() * 2 - 1) * e6 * 0.9 : 0)) * 0.9;
      L[ib + i] += v * gl; R[ib + i] += v * gr;
      e1 *= k1; e2 *= k2; e3 *= k3; e4 *= k4; e5 *= k5; e6 *= k6;
    } }
  { let t = 0.2;
    while (t < 2.1) {
      t += -Math.log(1 - r()) / (95 * Math.exp(-t / 0.7) + 7);
      const a = (0.25 + 0.9 * r()) * Math.exp(-t / 1.25), len = 3 + Math.floor(r() * 8), pp = clamp(p + (r() - 0.5) * 1.2, -1, 1), k0 = ib + Math.round(t * sr);
      const cl = Math.cos((pp + 1) * Math.PI / 4), cr = Math.sin((pp + 1) * Math.PI / 4);
      let prev = 0; for (let j = 0; j < len && k0 + j < n; j++) { const v = r() * 2 - 1, x = (v - prev) * a * Math.exp(-j / (len * 0.4)); L[k0 + j] += x * cl; R[k0 + j] += x * cr; prev = v; }
    } }
  fadeEdges(L, 0, 2000); fadeEdges(R, 0, 2000);
  return normalize2(L, R, 1);
}
// ---- the ballpark bell: a hand-rung bronze bell (hum / prime / minor-third tierce / quint / nominal …) ----
function genBell(sr, seed, strikes = 4) {
  const r = mulberry(seed), dur = 5, n = Math.round(dur * sr), out = new Float32Array(n), f = 620 + r() * 60;
  const P = [[0.5, 0.35, 2.6], [1.0, 0.5, 1.8], [1.19, 0.55, 1.4], [1.5, 0.3, 1.0], [2.0, 1.0, 0.9], [2.52, 0.35, 0.55], [2.67, 0.3, 0.5], [3.01, 0.28, 0.4], [4.05, 0.18, 0.25], [5.4, 0.1, 0.14]];
  const hits = Array.from({ length: strikes }, (_, k) => [0.02 + k * (0.5 + r() * 0.08), k === 0 ? 1 : 0.7 + 0.3 * r()]);
  for (const [t0, a0] of hits) {
    const i0 = Math.round(t0 * sr);
    for (const [k, a, tau] of P) { const w = TAU * f * k * (1 + (r() - 0.5) * 0.002) / sr, kd = Math.exp(-1 / (tau * sr)), p0 = r() * TAU, cw = Math.cos(w), sw = Math.sin(w); let e = a * a0, c = Math.cos(p0), sn = Math.sin(p0);
      for (let i = 0; i + i0 < n && e > 1e-4; i++) { const cc = c * cw - sn * sw; sn = sn * cw + c * sw; c = cc; out[i0 + i] += sn * e * (i < 24 ? i / 24 : 1); e *= kd; } }
    const bp = new BQ('bp', 3200, 1.2, sr); for (let i = 0; i < 0.006 * sr; i++) out[i0 + i] += bp.run(r() * 2 - 1) * a0 * 1.2 * (1 - i / (0.006 * sr)); // clapper
  }
  return normalize(fadeEdges(out, 0, Math.round(0.6 * sr)), 1);
}
// ---- Rate Field pinwheels: spin-up whirr (rotor hum + blade-pass chop) + electric sparkle ----
function* genPinwheels(sr, seed) {
  const r = mulberry(seed), dur = 6.5, n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  { const bpL = new BQ('bp', 700, 0.8, sr), bpR = new BQ('bp', 760, 0.8, sr), lp = new BQ('bp', 420, 1.2, sr); let ph = 0, rot = 0;   // motor whine, not sub
    let spin = 0, sp = 0.4;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) { const t = i / sr; spin = clamp(t / 1.6, 0, 1) * (t > dur - 1.5 ? (dur - t) / 1.5 : 1); sp = 0.4 + 4.6 * spin; } // rev/s
      rot += sp / sr; if (rot > 1) rot -= 1; ph += (18 + 48 * spin) / sr; if (ph > 1) ph -= 1;
      const chop = 0.55 + 0.45 * COS(TAU * rot * 4), hum = lp.run(ph * 2 - 1) * 0.5 * spin;
      L[i] += (bpL.run(r() * 2 - 1) * chop * 0.5 * spin + hum) * (0.8 + 0.2 * COS(TAU * rot)); R[i] += (bpR.run(r() * 2 - 1) * chop * 0.5 * spin + hum) * (0.8 + 0.2 * SIN(TAU * rot));
    } }
  yield;
  { let t = 0.15; // sparkle: tiny inharmonic chimes + crackle, dense at first
    while (t < dur - 0.4) {
      t += -Math.log(1 - r()) / (38 * Math.exp(-t / 2.2) + 6);
      const i0 = Math.round(t * sr), f0 = 2800 + r() * 5200, a = 0.12 + 0.2 * r(), [gl, gr] = panLR(r() * 1.6 - 0.8);
      const ks = [1, 1.47, 2.09], taus = [0.09, 0.06, 0.04].map(x => x * (0.6 + r()));
      for (let j = 0; j < 3; j++) { const w = TAU * f0 * ks[j] / sr, kd = Math.exp(-1 / (taus[j] * sr)), cw = Math.cos(w), sw = Math.sin(w); let e = a / (j + 1), c = 1, sn = 0; for (let i = 0; i < 0.3 * sr && i0 + i < n && e > 1e-3; i++) { const cc = c * cw - sn * sw; sn = sn * cw + c * sw; c = cc; const s = sn * e; L[i0 + i] += s * gl; R[i0 + i] += s * gr; e *= kd; } }
      if (r() < 0.35) { for (let i = 0; i < 6 && i0 + i < n; i++) { const s = (r() * 2 - 1) * a * 1.5; L[i0 + i] += s * gl; R[i0 + i] += s * gr; } }
    } }
  fadeEdges(L, 400, Math.round(0.4 * sr)); fadeEdges(R, 400, Math.round(0.4 * sr));
  return normalize2(L, R, 1);
}
// ---- stadium reverb impulse response (stereo) ------------------------------------------
// Open-air bowl: sparse early reflections (backstop, dugouts, lower-deck face, roof overhang),
// then discrete diffuse CLUSTERS from the far stands / bleachers / facades (0.2–0.9 s round trips,
// each darker from air absorption), then a low-density tail (RT60 ≈ 2.3 s mid, faster HF decay).
function genIR(sr, seed, dur = 2.6) {
  const r = mulberry(seed), n = Math.round(dur * sr), out = [];
  const early = [[0.009, 0.5], [0.014, 0.42], [0.021, 0.36], [0.031, 0.3], [0.044, 0.28], [0.061, 0.24], [0.083, 0.2], [0.115, 0.17], [0.15, 0.14]];
  const clusters = [[0.21, 0.24, 0.018], [0.33, 0.21, 0.024], [0.45, 0.18, 0.03], [0.59, 0.15, 0.035], [0.73, 0.12, 0.04], [0.88, 0.08, 0.05]];
  for (let c = 0; c < 2; c++) {
    const a = new Float32Array(n); let y = 0, y2 = 0, k = 0, dec = 1; const kd = Math.exp(-6.9 / (2.3 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 63) === 0) k = 1 - Math.exp(-TAU * (650 + 6500 * Math.exp(-t / 0.5)) / sr);
      y += k * ((r() * 2 - 1) - y); y2 += k * (y - y2);
      const density = Math.min(1, Math.max(0, (t - 0.03) / 0.35)) * (0.35 + 0.65 * Math.min(1, t / 0.9));
      a[i] = y2 * dec * density * 0.42; dec *= kd;
    }
    for (const [tt, g] of early) { const k0 = Math.round(tt * (1 + (c ? 0.08 : -0.06)) * sr); for (let j = 0; j < 20; j++) if (k0 + j < n) a[k0 + j] += g * (r() * 2 - 1) * Math.exp(-j / 5); }
    for (const [tt, g, w] of clusters) {
      const k0 = Math.round(tt * (1 + (c ? 0.05 : -0.04) + (r() - 0.5) * 0.03) * sr), len = Math.round(w * sr), lp = new BQ('lp', 1400 + 7000 * Math.exp(-tt / 0.45), 0.7, sr);
      for (let j = 0; j < len * 3 && k0 + j < n; j++) a[k0 + j] += lp.run((r() * 2 - 1) * g * (j < len * 0.15 ? j / (len * 0.15) : Math.exp(-(j - len * 0.15) / len)));
    }
    out.push(fadeEdges(a, 0, 600));
  }
  return out;
}
// ---- simple additive tones (UI) --------------------------------------------------------
function genAdd(sr, dur, parts, clickAmt = 0, seed = 1) {
  const r = mulberry(seed), n = Math.round(dur * sr), out = new Float32Array(n);
  for (const p of parts) {
    const t0 = p.t0 || 0, att = p.att || 0.002, hold = p.hold || 0, kd = Math.exp(-1 / (p.tau * sr)), w = TAU * p.f / sr, cw = Math.cos(w), sw = Math.sin(w);
    let ph = 0, c = 1, sn = 0, env = 1;
    for (let i = Math.round(t0 * sr); i < n; i++) {
      const t = i / sr - t0;
      let v;
      if (p.f1) { ph += TAU * (p.f1 + (p.f - p.f1) * Math.exp(-t / (p.glide || 0.05))) / sr; v = Math.sin(ph); }
      else { const cc = c * cw - sn * sw; sn = sn * cw + c * sw; c = cc; v = sn; }
      let e; if (t < att) e = t / att; else if (t < att + hold) e = 1; else { e = env; env *= kd; }
      out[i] += v * p.a * e;
    }
  }
  if (clickAmt) for (let i = 0; i < 0.004 * sr; i++) out[i] += (r() * 2 - 1) * clickAmt * Math.exp(-i / sr / 0.0007);
  return normalize(fadeEdges(out, 16, Math.round(Math.max(0.01, dur * 0.2) * sr)), 1);
}
const BELL = (f, tauK = 1) => [1, 2.0, 2.76, 4.07, 5.4, 6.8].map((k, j) => ({ f: f * k, a: [1, 0.5, 0.42, 0.2, 0.12, 0.06][j], att: 0.0015, tau: [0.7, 0.35, 0.25, 0.12, 0.08, 0.05][j] * tauK }));

export const _dsp = { BQ, genBat, BAT, genMitt, genKeyClick, genKick, genSnare, genHat, genCymbal, genClap, genCrowdClap, genWhistle, genPink, genWhite,
  genUtt, talkUtt, shoutUtt, genBank, genMurmur, genRoar, genShoutMix, genTrain, genTraffic, genTrainHorn, genFlag, genShell, genBell, genPinwheels, genIR,
  genAdd, BELL, mulberry, beamShape, halfSineSpec, FMT };

// ============================================================================
// ORGAN — tonewheel drawbar registrations (16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1')
// Harmonic (of the 16' sub-fundamental) for each drawbar. The octave family is exact; the
// fifth-family mutations (5⅓' 2⅔' 1⅓') come off tonewheels tuned to the TEMPERED fifth
// (−1.96 ¢) and the 1⅗' tierce to the tempered third (+13.7 ¢) — the slow beating against
// the octave bars is the tonewheel shimmer. So each note = octave wave + mutation wave (+ tierce).
// ============================================================================
const DRAWBAR_H = [1, 3, 2, 4, 6, 8, 10, 12, 16];
const OCT_BARS = [0, 2, 3, 5, 8], MUT_BARS = [1, 4, 7], TIERCE_BAR = 6;
const MUT_RATIO = 3 * Math.pow(2, -1.955 / 1200), TIERCE_RATIO = 10 * Math.pow(2, 13.686 / 1200);
const REG = {
  lead:  { bars: [8, 8, 8, 6, 0, 0, 0, 0, 5], perc: 3, percLevel: 0.75, percTau: 0.16, click: 0.3, level: 0.26, temper: true },
  full:  { bars: [8, 8, 8, 8, 6, 6, 4, 5, 6], perc: 0, click: 0.25, level: 0.22, temper: true },
  comp:  { bars: [6, 8, 8, 5, 0, 0, 0, 0, 3], perc: 0, click: 0.22, level: 0.2 },
  soft:  { bars: [0, 0, 8, 6, 0, 3, 0, 0, 0], perc: 2, percLevel: 0.45, percTau: 0.22, click: 0.12, level: 0.27 },
  flute: { bars: [0, 0, 8, 4, 0, 3, 0, 0, 0], perc: 2, percLevel: 0.35, percTau: 0.3, click: 0.1, level: 0.24 },
  bass:  { bars: [0, 0, 7, 8, 5, 3, 0, 0, 0], perc: 0, click: 0.3, level: 0.34, decay: [0.22, 0.55] },
};
function waveSet(reg, seed) { // → { oct:[re,im], mut:[re,im]|null, tierce:amp|0 } (all RMS-normalised together to 0.5)
  // reg.temper: separate tempered mutation/tierce oscillators (lead + full chords, where the shimmer is audible);
  // otherwise the mutations are folded into the single wave at exact harmonics (one oscillator per note — CPU).
  const r = mulberry(seed), amp = lv => (lv ? Math.pow(10, (lv - 8) * 3 / 20) : 0);
  let ss = 0; reg.bars.forEach(lv => { const a = amp(lv); ss += a * a; });
  const s = 0.5 / Math.sqrt(ss / 2 || 1);
  const oct = [new Float32Array(17), new Float32Array(17)], mut = [new Float32Array(5), new Float32Array(5)];
  let hasMut = false;
  for (const j of OCT_BARS) { const a = amp(reg.bars[j]) * s, p = r() * TAU, k = DRAWBAR_H[j]; oct[0][k] += a * Math.sin(p); oct[1][k] += a * Math.cos(p); }
  MUT_BARS.forEach((j, q) => { const a = amp(reg.bars[j]) * s; if (!a) return; const p = r() * TAU;
    if (reg.temper) { hasMut = true; const k = [1, 2, 4][q]; mut[0][k] += a * Math.sin(p); mut[1][k] += a * Math.cos(p); }
    else { const k = DRAWBAR_H[j]; oct[0][k] += a * Math.sin(p); oct[1][k] += a * Math.cos(p); } });
  let tierce = amp(reg.bars[TIERCE_BAR]) * s;
  if (tierce && !reg.temper) { const p = r() * TAU; oct[0][10] += tierce * Math.sin(p); oct[1][10] += tierce * Math.cos(p); tierce = 0; }
  return { oct, mut: hasMut ? mut : null, tierce };
}

// ============================================================================
// SCORE — original organ riffs + music cues. Notation: 'note:beats', chords
// '[C4 E4 G4]:1', named voicings '$F9:1', rests 'r:1', staccato suffix "'",
// velocity suffix '*0.8'. Drum grids: 16 steps per bar, X accent x hit o ghost.
// ============================================================================
const CH = {
  F9: 'A3 Eb4 G4 C5', Bb9: 'D4 F4 Ab4 C5', C9: 'E4 G4 Bb4 D5', Dm7: 'F4 A4 C5 D5', Gm7: 'F4 Bb4 D5',
  Bb6: 'D4 F4 G4 Bb4', Eb6: 'Eb4 G4 Bb4 C5', C7: 'E4 G4 Bb4 C5', F7: 'Eb4 F4 A4 C5', Gm7b: 'F4 Bb4 D5 G5',
  G9: 'B3 F4 A4', C9w: 'E4 Bb4 D5', D9: 'F#4 C5 E5', G6: 'E4 G4 B4 D5',
  wF: 'A3 C4 F4', wC7: 'Bb3 C4 E4', wBb: 'Bb3 D4 F4', wDm: 'A3 D4 F4', wG7: 'B3 D4 F4', wF7: 'A3 C4 Eb4',
};
function seq(inst, at, str, o = {}) {
  const out = []; let b = at;
  for (const tk of str.match(/\[[^\]]*\][^\s]*|\S+/g) || []) {
    if (tk === '|') continue;
    const m = /^(.+?):([0-9./]+)('?)(?:\*([0-9.]+))?$/.exec(tk);
    if (!m) throw new Error('audio: bad token ' + tk);
    const d = m[2].includes('/') ? m[2].split('/')[0] / m[2].split('/')[1] : +m[2], X = m[1];
    if (X !== 'r') {
      const notes = X[0] === '[' ? X.slice(1, -1).trim().split(/\s+/).map(nm) : X[0] === '$' ? CH[X.slice(1)].split(' ').map(nm) : [nm(X)];
      out.push({ i: inst, b, d, n: notes, v: (m[4] ? +m[4] : 1) * (o.v ?? 0.8), gate: m[3] ? 0.42 : (o.gate ?? 0.93), reg: o.reg, np: o.np });
    }
    b += d;
  }
  return out;
}
function grid(inst, at, str, o = {}) {
  const out = [], s = str.replace(/[|\s]/g, '');
  for (let k = 0; k < s.length; k++) { const v = { X: 1, x: 0.7, o: 0.38 }[s[k]]; if (v) out.push({ i: inst, b: at + k * (o.step || 0.25), v: v * (o.v ?? 1) }); }
  return out;
}
function gliss(at, from, to, beats, o = {}) { // white-key palm glissando
  const keys = []; for (let m = from; m <= to; m++) if ([0, 2, 4, 5, 7, 9, 11].includes(m % 12)) keys.push(m);
  const d = beats / keys.length;
  return keys.map((m, k) => ({ i: 'org', b: at + k * d, d: d * 1.6, n: [m], v: (o.v ?? 0.7) * (0.75 + 0.25 * k / keys.length), gate: 1, reg: o.reg || 'full', np: true, nc: k % 2 === 1 }));
}
const les = (b, fast) => ({ i: 'leslie', b, fast });
const hits = (inst, beats, v = 1) => beats.map(b => ({ i: inst, b, v }));
const bars = (n, fn) => Array.from({ length: n }, (_, k) => fn(k, k * 4));
function track(name, bpm, o, parts) {
  const evs = parts.flat(3).filter(Boolean).sort((a, b) => a.b - b.b || (a.i === 'leslie' ? -1 : b.i === 'leslie' ? 1 : 0));
  const len = o.loop || Math.max(...evs.map(e => e.b + (e.d || 0)));
  return { name, bpm, swing: o.swing || 0.5, loop: o.loop || 0, evs, len, yieldToRiff: !!o.yieldToRiff, beatsPerBar: o.bpb || 4 };
}

// ---- TITLE: organ-funk shuffle in F, 16 bars (A = hook, B = comp + fills) ----
const TITLE = (() => {
  const chA = ['F9', 'F9', 'Bb9', 'F9', 'C9', 'Bb9'];
  const P1 = c => `$${c}:.5' r:1 $${c}:.5' r:1 $${c}:1`;
  const P2 = c => `$${c}:.75 $${c}:.5' r:.75 $${c}:.5' r:.5 $${c}:1`;
  const b7 = "$F9:.5' r:.5 $F9:.5' r:.5 $Dm7:1.5 r:.5", b8 = "$Gm7:.5' r:.5 $Gm7:.5' r:.5 $C9:1.5 r:.5";
  const bass = ['F2:1 r:.5 F2:.5 A2:1 C3:1', 'F2:1 r:.5 F2:.5 Eb3:1 A2:1', 'Bb2:1 r:.5 Bb2:.5 Ab2:1 B2:1', 'C3:1 r:.5 A2:.5 G2:1 B2:1',
    'C3:1 r:.5 C3:.5 Bb2:1 G2:1', 'Bb2:1 r:.5 Bb2:.5 F2:1 A2:1', 'F2:1 A2:1 D3:1 C3:1', 'G2:1 Bb2:1 C3:1 E2:1'];
  const hook = 'r:.5 C5:.5 D5:.5 F5:.5 G5:1 F5:.5 D5:.5 | Eb5:.5 D5:.5 C5:1 r:2 | r:.5 D5:.5 F5:.5 G5:.5 Ab5:.5 A5:.5 C6:1 | A5:.5 G5:.5 F5:1 r:2 |' +
    ' r:.5 G5:.5 E5:.5 C5:.5 Bb4:1 C5:1 | D5:1.5 C5:.5 Bb4:1 r:1 | A4:.5 C5:.5 F5:.5 A5:.5 D6:1 C6:1 | Bb5:.5 A5:.5 G5:.5 F5:.5 E5:1 r:1';
  const fills = 'r:4 | r:2.5 A5:.25 C6:.25 A5:.5 F5:.5 | r:4 | r:2 F5:.5 Ab5:.5 A5:.5 C6:.5 | r:4 | r:2 D5:.5 F5:.5 G5:.5 Bb5:.5 | r:4 | r:3.5 E6:.5';
  const groove = bar => {
    const fill = bar % 8 === 7, at = bar * 4;
    return [
      grid('kick', at, fill ? 'X.......X.x.....' : 'X.....x.X.....x.', { v: 0.9 }),
      grid('snare', at, fill ? '....X...X.xoXxXx' : '....X......oX..o', { v: 0.75 }),
      grid('hat', at, fill ? 'X.x.X.x.X.......' : 'X.x.X.x.X.x.X.x.', { v: 0.42 }),
      bar % 8 === 3 ? hits('ohat', [at + 3.5], 0.4) : null,
      bar % 8 === 0 ? hits('crash', [at], 0.5) : null,
    ];
  };
  return track('title', 108, { swing: 0.6, loop: 64 }, [
    bars(16, (k, at) => groove(k)),
    bars(16, (k, at) => seq('bass', at, bass[k % 8], { reg: 'bass', v: 0.8, gate: 0.8 })),
    bars(16, (k, at) => { const s = k % 8, A = k < 8; return seq('org', at, s === 6 ? b7 : s === 7 ? b8 : (A ? P1 : P2)(chA[s]), { reg: 'comp', v: A ? 0.55 : 0.68 }); }),
    seq('org', 0, hook, { reg: 'lead', v: 0.85 }),
    seq('org', 32, fills, { reg: 'lead', v: 0.7 }),
    gliss(62, nm('C5'), nm('D6'), 1.4, { reg: 'lead', v: 0.55 }),
    les(0, false), les(24, true), les(32, false), les(56, true),
  ]);
})();

// ---- BATTING: sparse Bb vamp that yields to riffs, 16 bars ----
const BATTING = (() => {
  const comp = ['$Bb6:1.5 r:2.5', 'r:4', '$Eb6:1.5 r:2.5', 'r:4', '$Bb6:1.5 r:2.5', 'r:4', '$C7:1.5 r:.5 $F7:1.5 r:.5', 'r:4',
    '$Bb6:1.5 r:2.5', 'r:4', '$Eb6:1.5 r:2.5', 'r:4', '$Gm7b:1.5 r:2.5', 'r:4', '$C7:1.5 r:.5 $F7:1.5 r:.5', 'r:4'];
  const licks = { 1: 'r:2 F4:.5 G4:.5 Bb4:1', 3: 'r:2.5 C5:.5 Db5:.25 D5:.75', 5: 'r:2 C5:.5 Bb4:.5 G4:.5 F4:.5', 7: 'r:2 D5:.5 C5:.5 Bb4:1',
    9: 'r:2.5 G4:.5 Bb4:.5 C5:.5', 11: 'r:2 Eb5:.5 D5:.5 C5:.5 Bb4:.5', 13: 'r:3 F5:1/3 G5:1/3 F5:1/3', 15: 'r:2 Bb4:.5 C5:.5 D5:1' };
  const bass = { 0: 'Bb2:1', 2: 'Eb3:1', 4: 'Bb2:1', 6: 'C3:1 r:1 F2:1', 8: 'Bb2:1', 10: 'Eb3:1', 12: 'G2:1', 14: 'C3:1 r:1 F2:1' };
  return track('batting', 88, { swing: 0.58, loop: 64, yieldToRiff: true }, [
    bars(16, (k, at) => seq('org', at, comp[k], { reg: 'soft', v: 0.5 })),
    bars(16, (k, at) => licks[k] ? seq('org', at, licks[k], { reg: 'soft', v: 0.5 }) : null),
    bars(16, (k, at) => bass[k] ? seq('bass', at, bass[k], { reg: 'bass', v: 0.5 }) : null),
    les(0, false),
  ]);
})();

// ---- ROUND OVER sting ----
const ROUNDOVER = track('roundOver', 100, {}, [
  { i: 'rcym', b: 0, v: 0.6 },
  seq('org', 0, 'D4:1/3 F4:1/3 G4:1/3 A4:1/3 C5:1/3 D5:1/3', { reg: 'lead', v: 0.8 }),
  seq('org', 2, '[F4 Bb4 D5 F5 Bb5]:5', { reg: 'full', v: 1 }),
  seq('bass', 2, 'Bb1:5', { reg: 'bass', v: 0.9 }),
  hits('kick', [2], 1), hits('crash', [2], 0.8),
  les(0, true), les(3.5, false),
]);

// ---- ORGAN RIFFS (all original) ----
const RIFFS = {
  // rising pentatonic triplet fanfare → stop-time stabs → big D chord → crowd "HEY!"
  charge: track('charge', 138, {}, [
    seq('org', 0, 'D4:1/3 E4:1/3 F#4:1/3 A4:1/3 B4:1/3 D5:1/3 E5:1/3 F#5:1/3 A5:1/3 B5:.5 r:.5', { reg: 'lead', v: 0.9 }),
    seq('org', 0, "[D4 F#4 A4]:.5' r:.5 [D4 G4 B4]:.5' r:.5 [E4 A4 C#5]:.5' r:.5 [G4 B4 D5]:.5'", { reg: 'comp', v: 0.55 }),
    seq('org', 4, "[A4 C#5 E5 A5]:.5' [A4 C#5 E5 A5]:.5' [D5 F#5 A5 D6]:2.2", { reg: 'full', v: 1 }),
    seq('bass', 0, "D2:1 r:1 E2:.5 r:.5 G2:.5' r:.5 A2:.5' A2:.5' D2:2.2", { reg: 'bass', v: 0.85 }),
    hits('kick', [0, 2, 3, 5], 0.9), hits('snare', [4, 4.5], 0.9), hits('crash', [5], 0.7),
    { i: 'hey', b: 7.35, v: 1 }, hits('cclap', [7.35], 0.7),
    les(0, false), les(2, true),
  ]),
  // shuffle vamp in G with crowd clapping on 2 & 4
  walkup: track('walkup', 118, { swing: 0.64 }, [
    seq('bass', 0, 'G2:.75 G2:.25 Bb2:.5 B2:.5 D3:.5 E3:.5 F3:.5 E3:.5 | C3:.75 C3:.25 Eb3:.5 E3:.5 G3:.5 A3:.5 Bb3:.5 A3:.5 |' +
      " G2:.75 G2:.25 Bb2:.5 B2:.5 D3:.5 E3:.5 F3:.5 E3:.5 | D3:.5' r:.5 D3:.5' r:.5 G2:2", { reg: 'bass', v: 0.8, gate: 0.85 }),
    seq('org', 0, "r:.5 $G9:.25' r:.75 $G9:.25' r:1.25 $G9:.5' r:.5 | r:.5 $C9w:.25' r:.75 $C9w:.25' r:1.25 $C9w:.5' r:.5 |" +
      " r:.5 $G9:.25' r:.75 $G9:.25' r:2.25 | $D9:.5' r:.5 $D9:.5' r:.5 $G6:2", { reg: 'comp', v: 0.7 }),
    seq('org', 8, 'r:2 D5:1/3 F5:1/3 G5:1/3 Bb5:.5 A5:.5 | r:2 G5:2', { reg: 'lead', v: 0.75 }),
    hits('cclap', [1, 3, 5, 7, 9, 11], 0.45),
    les(0, false), les(14, true),
  ]),
  // palm gliss → I–bVII–IV–V–I celebration with trill, Leslie wide open
  homer: track('homer', 132, {}, [
    gliss(0, nm('C4'), nm('C6'), 0.85, { reg: 'full', v: 0.7 }),
    seq('org', 1, "[C4 E4 G4 C5 E5]:1.5 [C4 E4 G4 C5 E5]:.5' [Bb3 D4 F4 Bb4 D5]:.5' [Bb3 D4 F4 Bb4 D5]:.5' [A3 C4 F4 A4 C5 F5]:1.5 [G3 B3 D4 G4 B4 D5]:.5' [C4 E4 G4 C5 E5 G5]:3", { reg: 'full', v: 1 }),
    seq('org', 6.5, Array.from({ length: 14 }, (_, k) => (k % 2 ? 'G5' : 'A5') + ':.125').join(' '), { reg: 'lead', v: 0.45, np: true }),
    seq('bass', 1, 'C2:1.5 r:.5 Bb1:1 F2:1.5 G2:.5 C2:3', { reg: 'bass', v: 0.9 }),
    hits('crash', [1, 6], 0.75), hits('kick', [1, 3, 4, 6], 1), hits('snare', [2.5, 3, 3.5, 5.5], 0.8),
    grid('snare', 4.5, 'ooxxXX', { v: 0.7 }),
    les(0, true), les(8.2, false),
  ]),
  // lilting 3/4 waltz in F — oom-pah-pah, 16 bars
  stretch: (() => {
    const mel = 'A4:2 Bb4:1 | C5:2 A4:1 | G4:1 A4:1 Bb4:1 | D5:3 | C5:2 Bb4:1 | A4:2 F4:1 | G4:3 | C4:1 D4:1 E4:1 |' +
      ' A4:2 Bb4:1 | C5:2 F5:1 | E5:1 D5:1 C5:1 | D5:2 Bb4:1 | A4:1 G4:1 A4:1 | C5:2 E4:1 | G4:3 | F4:3';
    const chords = ['wF', 'wF', 'wC7', 'wBb', 'wF', 'wDm', 'wG7', 'wC7', 'wF', 'wF7', 'wC7', 'wBb', 'wF', 'wC7', 'wC7', null];
    const roots = ['F2', 'C2', 'C2', 'Bb1', 'F2', 'D2', 'G2', 'C2', 'F2', 'A2', 'C2', 'Bb1', 'F2', 'C2', 'G2', 'F2'];
    return track('stretch', 150, { bpb: 3 }, [
      seq('org', 0, mel, { reg: 'flute', v: 0.8 }),
      chords.map((c, k) => c ? seq('org', k * 3 + 1, `$${c}:.6' r:.4 $${c}:.6'`, { reg: 'comp', v: 0.42 }) : null),
      roots.map((n, k) => seq('bass', k * 3, `${n}:${k === 15 ? 3 : 1}`, { reg: 'bass', v: 0.7, gate: 0.85 })),
      seq('org', 45, '[F3 A3 C4 F4 A4 C5]:3', { reg: 'full', v: 0.6 }),
      hits('cclap', [24, 27, 30, 33, 36, 39, 42], 0.25),
      les(0, false), les(45, true),
    ]);
  })(),
  // last-outs ostinato in D minor: pulsing fifths, swelling chords, heartbeat kick, crowd claps every beat
  tension: track('tension', 124, { loop: 16 }, [
    seq('bass', 0, "D3:.5' A3:.5' D3:.5' A3:.5' D3:.5' A3:.5' C4:.5' A3:.5' | D3:.5' A3:.5' D3:.5' A3:.5' D3:.5' A3:.5' Bb3:.5' A3:.5' |" +
      " Bb2:.5' F3:.5' Bb2:.5' F3:.5' Bb2:.5' F3:.5' G3:.5' F3:.5' | A2:.5' E3:.5' A2:.5' E3:.5' A2:.5' E3:.5' G3:.5' C#4:.5'", { reg: 'bass', v: 0.62 }),
    seq('org', 0, '[D4 F4 A4]:8 [D4 F4 Bb4]:4 [C#4 E4 G4 A4]:4', { reg: 'comp', v: 0.4, gate: 0.97 }),
    seq('org', 0, 'r:4 | r:2 D5:1 E5:1 | F5:3 E5:1 | E5:2 C#5:2', { reg: 'lead', v: 0.5 }),
    bars(4, (k, at) => grid('kick', at, 'X..x............', { v: 0.6 })),
    hits('cclap', Array.from({ length: 16 }, (_, k) => k), 0.34),
    les(0, true),
  ]),
  // THE WAVE: chromatically climbing block chords, swelling with the crowd, Leslie spinning up → big D + trill
  wave: track('wave', 104, {}, [
    seq('org', 0, "[G3 B3 D4 G4]:1*0.55 [Ab3 C4 Eb4 Ab4]:1*0.6 [A3 C#4 E4 A4]:1*0.66 [Bb3 D4 F4 Bb4]:1*0.72 [B3 D#4 F#4 B4]:1*0.78 [C4 E4 G4 C5]:1*0.84 [C#4 F4 G#4 C#5]:1*0.9 [D4 F#4 A4 D5 F#5]:3.6*1", { reg: 'full', v: 1, gate: 0.97 }),
    seq('org', 7.2, Array.from({ length: 22 }, (_, k) => (k % 2 ? 'E6' : 'F#6') + ':.125').join(' '), { reg: 'lead', v: 0.4, np: true }),
    seq('bass', 0, 'G2:1 Ab2:1 A2:1 Bb2:1 B2:1 C3:1 C#3:1 D2:3.6', { reg: 'bass', v: 0.85, gate: 0.9 }),
    hits('kick', [0, 1, 2, 3, 4, 5, 6, 7], 0.75), grid('snare', 5, 'o.o.x.x.xxxxXXXX', { v: 0.8 }), hits('crash', [7], 0.8),
    les(0, false), les(3, true), les(10.4, false),
  ]),
  // OUT OF THE PARK: gliss → stacked I–IV fanfare → climbing bVI–bVII → huge I with trill and drum fill
  outOfPark: track('outOfPark', 136, {}, [
    gliss(0, nm('C4'), nm('E6'), 0.9, { reg: 'full', v: 0.75 }),
    seq('org', 1, "[C4 E4 G4 C5]:.5' [C4 E4 G4 C5]:.5' [E4 G4 C5 E5]:.5' [G4 C5 E5 G5]:1.5 [F4 A4 C5 F5]:.5' [F4 A4 C5 F5]:.5' [A4 C5 F5 A5]:.5' [C5 F5 A5 C6]:1.5" +
      " [Ab4 C5 Eb5 Ab5]:1 [Bb4 D5 F5 Bb5]:1 [C5 E5 G5 C6]:4.5", { reg: 'full', v: 1 }),
    seq('org', 10, Array.from({ length: 30 }, (_, k) => (k % 2 ? 'D6' : 'E6') + ':.125').join(' '), { reg: 'lead', v: 0.42, np: true }),
    seq('bass', 1, "C2:.5' C2:.5' r:.5 C2:1.5 F2:.5' F2:.5' r:.5 F2:1.5 Ab2:1 Bb2:1 C2:4.5", { reg: 'bass', v: 0.9 }),
    hits('crash', [1, 5, 9, 11], 0.8), hits('kick', [1, 2.5, 3, 5, 6.5, 7, 9, 10, 11], 1), hits('snare', [2, 4, 6, 8], 0.85),
    grid('snare', 9.5, 'xxXX', { v: 0.8 }), { i: 'hey', b: 11, v: 1 },
    les(0, true), les(14.5, false),
  ]),
};
const CUES = { title: TITLE, batting: BATTING, roundOver: ROUNDOVER };
export const _score = { RIFFS, CUES, REG, seq, nm };

// ============================================================================
// SAMPLE DATA — generated in pure JS (no AudioContext needed), cached at module
// level and shared by every createAudio() instance. Generation starts in idle
// slices as soon as createAudio() runs (before the unlock gesture). Heavy jobs are
// generators (yield between voices) so a slice can pause mid-job. unlock() only
// wraps ready-made Float32Arrays into AudioBuffers (lazily, on first use).
// ============================================================================
const BANKS = {};
const BANK_SEED = { talk: 11, shout: 12, ooh: 13, aww: 14, whoa: 15, vendor: 16 };
function bankOf(kind) { if (!BANKS[kind]) { if (DATA['b_' + kind]) delete DATA['b_' + kind]; genData('b_' + kind, 0); } return BANKS[kind] || []; }
function* thenFree(gen, kind) { const v = yield* gen; delete BANKS[kind]; return v; } // single-use banks: free the voices once mixed
function* bankJob(kind) { BANKS[kind] = yield* genBank(kind, BANK_SEED[kind]); return []; }
const V = (n, fn) => Array.from({ length: n }, (_, k) => () => fn(k + 1));
const heyBank = () => bankOf('shout').filter((_, k) => k % 11 === 2 || k % 11 === 9);
const JOBS = {
  click: V(4, s => [genKeyClick(GEN_SR, 600 + s)]),
  kick: V(1, () => [genKick(GEN_SR, 7)]),
  snare: V(2, s => [genSnare(GEN_SR, 700 + s)]),
  hat: V(2, s => [genHat(GEN_SR, 800 + s, false)]),
  white: V(1, () => [genWhite(GEN_SR, 1.5, 830)]),
  ui_tap: V(1, () => [genAdd(GEN_SR, 0.07, [{ f: 1320, a: 1, tau: 0.018 }, { f: 2640, a: 0.22, tau: 0.01 }], 0.25)]),
  ui_back: V(1, () => [genAdd(GEN_SR, 0.14, [{ f: 740, f1: 430, glide: 0.04, a: 1, att: 0.004, tau: 0.045 }, { f: 1480, f1: 860, glide: 0.04, a: 0.18, att: 0.004, tau: 0.03 }])]),
  ui_confirm: V(1, () => [genAdd(GEN_SR, 0.4, [{ f: 1047, a: 0.75, tau: 0.06 }, { f: 2094, a: 0.12, tau: 0.03 }, { f: 1568, a: 1, tau: 0.13, t0: 0.075 }, { f: 3136, a: 0.18, tau: 0.07, t0: 0.075 }, { f: 4327, a: 0.08, tau: 0.05, t0: 0.075 }])]),
  beep: V(1, () => [genAdd(GEN_SR, 0.2, [{ f: 880, a: 1, att: 0.003, hold: 0.07, tau: 0.03 }, { f: 1760, a: 0.22, att: 0.003, hold: 0.05, tau: 0.02 }])]),
  beep_go: V(1, () => [genAdd(GEN_SR, 0.6, [{ f: 1760, a: 1, att: 0.003, hold: 0.12, tau: 0.16 }, { f: 880, a: 0.5, att: 0.003, hold: 0.1, tau: 0.2 }, { f: 2640, a: 0.18, att: 0.003, tau: 0.08 }])]),
  ding: V(1, () => [genAdd(GEN_SR, 2.0, BELL(1318.5), 0.15)]),
  // bat: variant index = bat-speed bucket (slow / mid / fast → shorter contact, brighter crack)
  bat_sweet: [0.68, 0.6, 0.53].map((tc, k) => () => [genBat(GEN_SR, BAT.sweet, tc, 101 + k)]),
  bat_solid: [0.74, 0.66, 0.6].map((tc, k) => () => [genBat(GEN_SR, k === 1 ? { ...BAT.solid, xi: 0.115 } : BAT.solid, tc, 201 + k)]),
  bat_jam: [1.0, 0.9].map((tc, k) => () => [genBat(GEN_SR, { ...BAT.jam, xi: 0.42 + 0.05 * k }, tc, 301 + k)]),
  bat_end: [0.82, 0.74].map((tc, k) => () => [genBat(GEN_SR, { ...BAT.end, xi: 0.03 + 0.02 * k }, tc, 351 + k)]),
  foul: [0.32, 0.38].map((tc, k) => () => [genBat(GEN_SR, BAT.tick, tc, 401 + k)]),
  mitt: [0, 0.5, 1].map((h, k) => () => [genMitt(GEN_SR, 501 + k, h)]),
  pink: V(1, () => genPink(GEN_SR, 3, 920)),
  // crowd voice banks + mixes (22.05 kHz)
  b_talk: [() => bankJob('talk')], b_shout: [() => bankJob('shout')], b_ooh: [() => bankJob('ooh')],
  b_aww: [() => bankJob('aww')], b_whoa: [() => bankJob('whoa')], b_vendor: [() => bankJob('vendor')],
  murmur: [() => genMurmur(10, 930, 34, bankOf('talk'))],
  rooftop: [() => thenFree(genMurmur(9, 931, 22, bankOf('talk'), { far: true, busy: true, rate: 1.05, width: 0.8, lpk: 0.55 }), 'talk')],
  roar: [() => genRoar(8, 932, 90, bankOf('shout'))],
  cheer: [0, 1].map(k => () => (k ? thenFree(genShoutMix(4.5, bankOf('shout'), 941, 70, 0.3, 0.3), 'shout') : genShoutMix(4.5, bankOf('shout'), 940, 70, 0.3, 0.3))),  // the singles keep their own refs
  ooh: [() => thenFree(genShoutMix(4.4, bankOf('ooh'), 945, 55, 0.4, 0.05, { fadeIn: 0.05 }), 'ooh')],
  groan: [() => thenFree(genShoutMix(2.8, bankOf('aww'), 960, 45, 0.25, 0.15), 'aww')],
  hey: [() => genShoutMix(0.9, heyBank(), 950, 34, 0.05)],
  whoa: [() => thenFree(genShoutMix(2.9, bankOf('whoa'), 970, 36, 0.12, 0, { width: 0.3 }), 'whoa')],
  shout: V(12, k => [bankOf('shout')[(k * 7) % 22]]),
  vendor: V(3, k => { const v = bankOf('vendor')[k - 1]; if (k === 3) delete BANKS.vendor; return [v]; }),
  crash: V(1, () => genCymbal(GEN_SR, 900, 2.5, false)),
  ohat: V(1, () => [genHat(GEN_SR, 810, true)]),
  rcym: V(1, () => genCymbal(GEN_SR, 901, 1.2, true)),
  ir: V(1, () => genIR(GEN_SR, 980, 2.6)),
  cclap: V(3, s => genCrowdClap(GEN_SR, 910 + s)),
  clap: V(1, () => [genClap(GEN_SR, 820)]),
  whistle: V(5, k => [genWhistle(FX_SR, 880 + k, k - 1)]),
  shell: V(4, s => genShell(FX_SR, 970 + s, s === 2)),
  // park-specific (queued by setPark)
  bell: V(1, () => [genBell(FX_SR, 990, 4)]),
  pinwheels: V(1, () => genPinwheels(FX_SR, 991)),
  train: V(1, () => genTrain(992)),
  traffic: V(1, () => genTraffic(993)),
  trainhorn: V(1, () => [genTrainHorn(CROWD_SR, 994)]),
  flag: V(2, k => [genFlag(CROWD_SR, 995 + k)]),
};
const JOB_SR = {};
['murmur', 'rooftop', 'roar', 'cheer', 'ooh', 'groan', 'hey', 'whoa', 'shout', 'vendor', 'train', 'traffic', 'trainhorn', 'flag'].forEach(k => { JOB_SR[k] = CROWD_SR; });
['whistle', 'shell', 'bell', 'pinwheels'].forEach(k => { JOB_SR[k] = FX_SR; });
const all = k => JOBS[k].map((_, i) => [k, i]);
// priority order for idle pre-generation: [key, variantIndex]
const PREGEN = [
  ...['click', 'kick', 'snare', 'hat', 'white', 'ui_tap', 'ui_back', 'ui_confirm', 'beep', 'beep_go', 'ding'].flatMap(all),     // title music + UI
  ['bat_sweet', 1], ['bat_solid', 1], ['bat_jam', 0], ['bat_end', 0], ['foul', 0], ['mitt', 1], ['pink', 0], ['ir', 0],          // first swing
  ['b_talk', 0], ['murmur', 0], ['cclap', 0], ['whistle', 0], ['whistle', 1], ['b_shout', 0], ['roar', 0], ['cheer', 0],          // crowd bed + roar
  ['b_ooh', 0], ['ooh', 0], ['b_aww', 0], ['groan', 0], ['hey', 0], ...all('shout'),
];
const PARK_SLOT = PREGEN.length;
PREGEN.push(
  ...['bat_sweet', 'bat_solid', 'bat_jam', 'bat_end', 'foul', 'mitt', 'cclap', 'whistle'].flatMap(all),
  ['crash', 0], ['ohat', 0], ['rcym', 0], ['clap', 0], ['shell', 0], ['shell', 1], ['cheer', 1], ['b_vendor', 0], ...all('vendor'),
  ['b_whoa', 0], ['whoa', 0], ['shell', 2], ['shell', 3],
);
const PARK_JOBS = { wrigley: [['rooftop', 0], ['flag', 0], ['flag', 1], ['train', 0]], rate: [['traffic', 0], ['pinwheels', 0], ['bell', 0], ['trainhorn', 0]] };
const DATA = {};           // key → [variant channel-arrays] (sparse while generating); RELEASED once wrapped
const ABUF = {};           // key → [AudioBuffer] shared by every instance (AudioBuffers are not bound to a context)
const RELEASED = Object.freeze([]);
const KEEP_DATA = new Set(['ir']);  // the convolver may need the raw IR again at another sample rate
const RUNNING = {};        // 'key|i' → paused generator
const IR_BY_RATE = {};
function genData(key, i, deadline) { // → channel arrays | null (failed) | undefined (paused: deadline hit)
  const d = DATA[key] || (DATA[key] = []);
  if (d[i] !== undefined) return d[i];
  const id = key + '|' + i;
  let it = RUNNING[id];
  if (!it) {
    let res;
    try { res = JOBS[key][i](); } catch (e) { d[i] = null; if (typeof console !== 'undefined') console.warn('[audio] gen failed', key, e); return null; }
    if (!res || typeof res.next !== 'function') { d[i] = res || null; return d[i]; }
    it = RUNNING[id] = res;
  }
  try {
    for (;;) {
      const s = it.next();
      if (s.done) { delete RUNNING[id]; d[i] = s.value || null; return d[i]; }
      if (deadline && nowMs() > deadline) return undefined;
    }
  } catch (e) { delete RUNNING[id]; d[i] = null; if (typeof console !== 'undefined') console.warn('[audio] gen failed', key, e); return null; }
}
let pregenIdx = 0, pregenRunning = false;
const pregenListeners = new Set();
function schedIdle(fn) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.requestIdleCallback) g.requestIdleCallback(fn, { timeout: 100 }); else setTimeout(fn, 6);
}
function pregenStep() {
  const t0 = nowMs(), deadline = t0 + 9;
  const emit = (k, i) => pregenListeners.forEach(f => { try { f(k, i); } catch (e) { /* a listener must never stop generation */ } });
  while (pregenIdx < PREGEN.length && nowMs() < deadline) {
    const [k, i] = PREGEN[pregenIdx];
    const r = genData(k, i, deadline);
    if (r === undefined) break;                 // paused mid-job; resume next slice
    pregenIdx++; emit(k, i);
  }
  if (pregenIdx < PREGEN.length) schedIdle(pregenStep); else { pregenRunning = false; emit(null, -1); }
}
function startPregen() { if (pregenRunning || pregenIdx >= PREGEN.length || typeof setTimeout === 'undefined') return; pregenRunning = true; schedIdle(pregenStep); }
function queueJobs(list) { // insert right after the essential crowd section (or next, if already past it)
  const todo = list.filter(([k, i]) => !(DATA[k] && DATA[k][i] !== undefined));
  if (!todo.length) return;
  PREGEN.splice(Math.max(pregenIdx, PARK_SLOT), 0, ...todo);
}
function pregenAllSync() { while (pregenIdx < PREGEN.length) { const [k, i] = PREGEN[pregenIdx++]; genData(k, i); } }
export const _data = { get JOBS() { return JOBS; }, get PREGEN() { return PREGEN; }, get DATA() { return DATA; }, get BANKS() { return BANKS; }, get ABUF() { return ABUF; }, PARK_JOBS, genData: (k, i) => genData(k, i), queueJobs, pregenAllSync };

// ============================================================================
// ENGINE
// ============================================================================
const SFX_DB = { // mix levels (dB) at the sfx/crowd bus — tuned against offline renders (see harness / scratch/audio)
  bat_sweet: 2, bat_solid: 1, bat_weak: 1, foul: -2, whiff: -4, mitt: -2, pitch_whoosh: -8, homer_horn: -9, fireworks: -5,
  crowd_roar: -1, crowd_groan: -3, streak: -8, record: -8, out: -11, ui_tap: -15, ui_back: -15, ui_confirm: -13, countdown: -12, ding: -11,
  swing_whoosh: -3, wave_swell: -2, out_of_park: -1, pinwheels: -10, ballpark_bell: -8, crowd_ooh: -3, anticipation: 0, crowd_hey: -5,
  clap_chant: 2, whistle: -16, vendor: -14, el_train: -14, train_horn: -19, siren: -17, car_alarm: -19, car_horn: -21, ballhawks: -9, flag_snap: -6,
};
const GLUE_MAKEUP_DB = 3.9;   // measured (see harness probe_gain*)
const PARK_FX = { wrigley: { echo: 0.31, fb: 0.26 }, rate: { echo: 0.26, fb: 0.22 } };
const warp = (b, sw) => { if (sw === 0.5) return b; const k = Math.floor(b), f = b - k; return k + (f < 0.5 ? f * sw / 0.5 : sw + (f - 0.5) * (1 - sw) / 0.5); };
function clipCurve(ceil = 0.94, knee = 0.8, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); c[i] = Math.sign(x) * (a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee))); }
  return c;
}
function driveCurve(k = 1.6, n = 2048) { const c = new Float32Array(n), d = Math.tanh(k); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / d; } return c; }
function silentWavURI() { // 0.25 s of 8-bit silence (generated; used only for the pre-16.4 iOS silent-switch fallback)
  const n = 2000, b = new Uint8Array(44 + n), dv = new DataView(b.buffer), w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, 'data'); dv.setUint32(40, n, true); b.fill(128, 44);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return 'data:audio/wav;base64,' + (typeof btoa !== 'undefined' ? btoa(s) : '');
}
const NOOP = () => {};
function resample(x, from, to) { // linear-interpolation resample (IRs are noise-like and band-limited: plenty)
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), k = from / to;
  for (let i = 0; i < n; i++) { const p = i * k, j = p | 0, f = p - j; y[i] = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * f; }
  return y;
}

/**
 * createAudio(opts?) → Audio
 *  opts.context   inject an AudioContext / OfflineAudioContext (tests). Omit in the game: the
 *                 context is created lazily inside unlock() (a user gesture).
 *  opts.assets    Assets store (for playClip; or call audio.setAssets(assets) later)
 *  opts.park      'wrigley' | 'rate' (or call audio.setPark later)
 *  opts.bed       false = no continuous crowd bed / ambience (isolated renders)   (default true)
 *  opts.connect   false = do not connect the output to ctx.destination           (default true)
 *  opts.seed      RNG seed for the runtime randomness                             (default random)
 */
export function createAudio(opts = {}) {
  const O = Object.assign({ context: null, bed: true, connect: true, seed: (Math.random() * 2 ** 31) | 0, assets: null, park: null }, opts || {});
  const W = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  const AC = W.AudioContext || W.webkitAudioContext || null;
  const OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext || null;
  let ctx = O.context || null;
  const offline = !!(ctx && OAC && ctx instanceof OAC);
  const S = {
    unlocked: false, built: false, muted: false, musicOn: true, crowd: 0.25, crowdApplied: -1, crowdHold: 0, holdUntil: 0,
    cue: null, musicTrk: null, riff: null, riffUntil: 0, queuedRiff: null, tracks: [],
    buf: {}, waves: {}, voices: 0, lastSfx: {}, vnow: null, timer: null, bed: null, resumeAt: -1e9,
    nextEvt: 0, clapRunUntil: 0, chantAt: 0, vendorAt: 0, nextTrain: 0, nextHorn: 0, nextFlag: 0, clipUntil: 0,
    park: null, wind: 8, assets: O.assets, clips: {}, clipJobs: {}, ooh: null, silentEl: null,
    rng: mulberry(O.seed), readyResolve: null, lastPick: {},
    stats: { ticks: 0, played: 0, late: 0, maxLead: 0, minLead: 1 },
  };
  const N = {};
  const ready = new Promise(res => { S.readyResolve = res; });
  pregenListeners.add(onPregen);
  if (!offline && typeof window !== 'undefined' && (AC || ctx)) startPregen();
  const rnd = () => S.rng();
  const T = () => (S.vnow != null ? S.vnow : ctx ? ctx.currentTime : 0);
  const live = () => !!(ctx && S.built && S.unlocked);
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  const lvl = name => dbg(SFX_DB[name] ?? -6);

  // ---------------------------------------------------------------- helpers
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const BF = (type, f, q = 0.707, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (gain) b.gain.value = gain; return b; };
  const chain = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; };
  const comp = (threshold, knee, ratio, attack, release) => { const c = ctx.createDynamicsCompressor(); Object.entries({ threshold, knee, ratio, attack, release }).forEach(([k, v]) => { c[k].value = v; }); return c; };
  function holdAt(param, t) {
    try { if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t); else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); } } catch (e) { /* */ }
  }
  function setp(param, v, t, tau) {
    try { holdAt(param, t); if (tau) param.setTargetAtTime(v, t, tau); else param.setValueAtTime(v, t); } catch (e) { try { param.value = v; } catch (e2) { /* ignore */ } }
  }
  function mkBuf(chs, sr) {
    const b = ctx.createBuffer(chs.length, chs[0].length, sr || ctx.sampleRate);
    chs.forEach((d, i) => { if (b.copyToChannel) b.copyToChannel(d, i); else b.getChannelData(i).set(d); });
    return b;
  }
  function panNode(p) { if (!ctx.createStereoPanner) return G(1); const n = ctx.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return n; }
  function track1(src, extra) { // voice accounting + cleanup
    S.voices++;
    src.onended = () => { S.voices = Math.max(0, S.voices - 1); try { src.disconnect(); extra && extra.forEach(n => n.disconnect()); } catch (e) { /* */ } };
  }
  function sends(node, verb, echo, city) {
    const out = [];
    if (verb) { const s = G(verb); node.connect(s); s.connect(N.verbIn); out.push(s); }
    if (echo) { const s = G(echo); node.connect(s); s.connect(N.echoIn); out.push(s); }
    if (city) { const s = G(city); node.connect(s); s.connect(N.cityIn); out.push(s); }
    return out;
  }
  function playBuf(buf, t, o = {}) {
    if (!buf) return null;
    const src = ctx.createBufferSource(); src.buffer = buf;
    if (o.rate && o.rate !== 1) src.playbackRate.value = o.rate;
    if (o.loop) src.loop = true;
    const g = G(o.fadeIn ? 0 : (o.gain ?? 1)); const extra = [g];
    let head = src;
    if (o.lp) { const f = BF('lowpass', o.lp, 0.6); head.connect(f); head = f; extra.push(f); }
    if (o.hp) { const f = BF('highpass', o.hp, 0.6); head.connect(f); head = f; extra.push(f); }
    head.connect(g);
    let tail = g;
    if (o.pan) { tail = panNode(o.pan); g.connect(tail); extra.push(tail); }
    tail.connect(o.dest || N.sfx);
    extra.push(...sends(tail, o.verb, o.echo, o.city));
    const t0 = Math.max(0, t);
    if (o.fadeIn) { g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(o.gain ?? 1, t0 + o.fadeIn); }
    src.start(t0, Math.min(o.offset || 0, Math.max(0, buf.duration - 0.01)));
    if (o.stop) src.stop(o.stop);
    track1(src, extra);
    return { src, g };
  }
  function osc(type, f, t, stop, dest, waveObj) {
    const o = ctx.createOscillator(); if (waveObj) o.setPeriodicWave(waveObj); else o.type = type;
    o.frequency.setValueAtTime(f, Math.max(0, t)); o.connect(dest); o.start(Math.max(0, t)); o.stop(stop);
    return o;
  }

  // ---------------------------------------------------------------- buffers
  // S.buf[key][i] = AudioBuffer wrapped lazily from the shared DATA cache.
  // Wrapped once per page into a module-level AudioBuffer cache; the Float32 source is then
  // released (live contexts only) so each sound lives in memory once.
  function wrap(key, i, sync) {
    const bl = ABUF[key] || (ABUF[key] = []);
    if (bl[i]) return bl[i];
    const d = DATA[key] && DATA[key][i] !== undefined ? DATA[key][i] : sync ? genData(key, i) : undefined;
    if (!d || !d.length || !d[0]) return null;
    try { bl[i] = mkBuf(d, JOB_SR[key] || GEN_SR); } catch (e) { return null; }
    if (!offline && !KEEP_DATA.has(key)) DATA[key][i] = RELEASED;
    return bl[i];
  }
  const ok = (key, i) => !!((ABUF[key] && ABUF[key][i]) || (DATA[key] && DATA[key][i] && DATA[key][i].length));
  function has(key) { if (!JOBS[key]) return false; for (let i = 0; i < JOBS[key].length; i++) if (ok(key, i)) return true; return false; }
  function getBuf(key, sync = true) { // random ready variant (avoids immediate repeats); sync-generates variant 0 if nothing exists yet
    if (!JOBS[key]) return null;
    const n = JOBS[key].length, rdy = [];
    for (let i = 0; i < n; i++) if (ok(key, i)) rdy.push(i);
    if (!rdy.length) return sync ? wrap(key, 0, true) : null;
    let k = rdy[Math.floor(rnd() * rdy.length)];
    if (rdy.length > 1 && k === S.lastPick[key]) k = rdy[(rdy.indexOf(k) + 1) % rdy.length];
    S.lastPick[key] = k; return wrap(key, k, false);
  }
  function varBuf(key, i) { return (ok(key, i) ? wrap(key, i, false) : null) || getBuf(key, true); } // exact variant, else any
  function setIR() { // ConvolverNode needs a buffer at the context's own sample rate
    if (!N.verb || N.verb.buffer) return;
    const rate = ctx.sampleRate;
    const src = has('ir') ? DATA.ir[0] : null; if (!src && rate === GEN_SR) return;          // not generated yet → onPregen('ir') retries
    const d = rate === GEN_SR ? src : (IR_BY_RATE[rate] || (IR_BY_RATE[rate] = src ? src.map(ch => resample(ch, GEN_SR, rate)) : genIR(rate, 980, 2.6)));
    try { N.verb.buffer = mkBuf(d, rate); } catch (e) { if (typeof console !== 'undefined') console.warn('[audio] reverb IR', e); }
  }
  function onPregen(key) {
    if (!S.built) return;
    if (key === 'ir' || key === null) setIR();
    if (S.bed && (key === null || /^(pink|murmur|roar|rooftop|traffic)$/.test(key))) bedLayers(T());
    if (key === null) { S.readyResolve && S.readyResolve(true); S.readyResolve = null; }
  }

  // ---------------------------------------------------------------- graph
  function build() {
    const c = ctx;
    N.mix = G(1);
    N.sub = BF('highpass', 36, 0.7); N.shelf = BF('lowshelf', 110, 0.7, -1.5);
    // DynamicsCompressorNode applies automatic make-up gain (0.6 × its full-range reduction, same kernel in
    // Chrome/WebKit/Gecko). The glue's is cancelled explicitly so it only compresses downward; the limiter's
    // small +1.1 dB is absorbed by the trim → small-signal gain of the whole master ≈ unity (probe_gain40).
    N.glue = comp(-14, 8, 2, 0.015, 0.3); N.glueMk = G(dbg(-GLUE_MAKEUP_DB));
    N.master = G(S.muted ? 0 : 1);
    N.limiter = comp(-2, 0, 20, 0.001, 0.08);
    N.trim = G(dbg(-0.9));
    N.clip = c.createWaveShaper(); N.clip.curve = clipCurve(0.95, 0.86); N.clip.oversample = 'none';
    N.post = G(1);   // transient SFX + voice join here: they bypass the glue (its 6 ms look-ahead would blunt a 0.6 ms bat crack)
    chain(N.mix, N.sub, N.shelf, N.glue, N.glueMk, N.post, N.master, N.limiter, N.trim, N.clip);
    N.out = N.clip; N.preClip = N.trim;
    if (O.connect !== false) N.clip.connect(c.destination);
    // stadium reverb (convolver) — the open-air bowl
    N.verbIn = G(1); N.verb = c.createConvolver(); N.verbRet = G(dbg(-3));
    chain(N.verbIn, BF('highpass', 170), N.verb, BF('lowpass', 6000, 0.6), BF('peaking', 450, 0.9, 1.5), N.verbRet, N.mix);
    // PA slap echo off the far stands (feedback delay, band-limited like a PA horn)
    N.echoIn = G(1); N.echo = c.createDelay(1); N.echo.delayTime.value = PARK_FX.wrigley.echo;
    const eh = BF('highpass', 300), el = BF('lowpass', 2800); N.echoFb = G(PARK_FX.wrigley.fb); N.echoRet = G(0.3);
    chain(N.echoIn, eh, N.echo, el, N.echoFb, N.echo); el.connect(N.echoRet); N.echoRet.connect(N.mix);
    // city echo: discrete slaps off the buildings beyond the outfield (multi-tap, each darker)
    N.cityIn = G(1); const ch = BF('highpass', 220); N.cityIn.connect(ch);
    [[0.23, 0.34, -0.55, 3600], [0.37, 0.27, 0.5, 2900], [0.52, 0.2, -0.25, 2300], [0.74, 0.13, 0.6, 1800]].forEach(([d, g, p, lp]) => {
      const dl = c.createDelay(1); dl.delayTime.value = d; const tail = chain(ch, dl, BF('lowpass', lp, 0.6), G(g), panNode(p)); tail.connect(N.mix); const vs = G(0.25); tail.connect(vs); vs.connect(N.verbIn);
    });
    // buses
    N.sfx = G(1); N.crowd = G(dbg(-2)); N.amb = G(dbg(-4)); N.crowdDuck = G(1); N.crowdPump = G(1); N.voice = G(1);
    N.music = G(dbg(-3)); N.organ = G(dbg(-1));
    chain(N.sfx, BF('highpass', 30, 0.7), N.post); N.crowd.connect(N.crowdDuck); N.amb.connect(N.crowdDuck); chain(N.crowdDuck, N.crowdPump, N.mix); N.voice.connect(N.post);
    sends(N.crowd, 0.1, 0); sends(N.amb, 0.12, 0);
    N.musicDuck = G(1); N.organDuck = G(1); N.musicGate = G(S.musicOn ? 1 : 0); N.organGate = G(S.musicOn ? 1 : 0);
    chain(N.music, BF('highpass', 48, 0.6), N.musicDuck, N.musicGate, N.mix); chain(N.organ, N.organDuck, N.organGate, N.mix);
    sends(N.musicGate, 0.16, 0); sends(N.organGate, 0.42, 0.2);
    buildOrgan();
    S.built = true;
  }
  function buildOrgan() {
    const c = ctx;
    for (const k of Object.keys(REG)) {
      const w = waveSet(REG[k], 1000 + k.length * 7);
      S.waves[k] = { oct: c.createPeriodicWave(w.oct[0], w.oct[1], { disableNormalization: true }), mut: w.mut ? c.createPeriodicWave(w.mut[0], w.mut[1], { disableNormalization: true }) : null, tierce: w.tierce };
    }
    S.waves.cos = c.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true });
    S.waves.sin = c.createPeriodicWave(new Float32Array([0, 0]), new Float32Array([0, 1]), { disableNormalization: true });
    N.organIn = G(1);
    // C-3 scanner chorus: modulated short delay blended with dry
    const dry = G(0.78), wet = G(0.34), cd = c.createDelay(0.02); cd.delayTime.value = 0.0035;
    const cl = c.createOscillator(); cl.frequency.value = 6.8; const cdep = G(0.0005); chain(cl, cdep, cd.delayTime); cl.start();
    const pre = G(1.1); N.organIn.connect(dry); dry.connect(pre); chain(N.organIn, cd, wet, pre);
    // tube preamp overdrive
    const drive = c.createWaveShaper(); drive.curve = driveCurve(1.6); drive.oversample = '2x';
    const post = G(0.62); chain(pre, drive, post);
    // Leslie 122: 800 Hz crossover → treble horn + bass drum rotors; two mics 90° apart, so the
    // left mic sees the cos phase and the right the sin phase of each rotor (doppler + AM + stereo swirl).
    const merger = c.createChannelMerger(2);
    const rotor = (src, spd, dly, dDepth, amDepth) => {
      const oc = c.createOscillator(), os = c.createOscillator(); oc.setPeriodicWave(S.waves.cos); os.setPeriodicWave(S.waves.sin);
      oc.frequency.value = spd; os.frequency.value = spd; oc.start(); os.start();
      [[0, oc], [1, os]].forEach(([chn, lfo]) => {
        const d = c.createDelay(0.02); d.delayTime.value = dly; const a = G(1 - amDepth);
        chain(src, d, a); a.connect(merger, 0, chn);
        chain(lfo, G(-dDepth), d.delayTime); chain(lfo, G(amDepth), a.gain);   // facing the mic: nearest (shortest delay) + loudest
      });
      return { oc, os };
    };
    const lo = chain(post, BF('lowpass', 800), BF('lowpass', 800), BF('peaking', 140, 1, 2)), hi = chain(post, BF('highpass', 800), BF('highpass', 800), BF('peaking', 2800, 1, 2.5), BF('lowpass', 7500, 0.7));
    N.horn = rotor(hi, 0.83, 0.003, 0.00045, 0.3);
    N.drum = rotor(lo, 0.67, 0.002, 0.00022, 0.14);
    N.leslieFast = false;
    chain(merger, BF('highpass', 70, 0.6), BF('lowpass', 8000, 0.6), N.organ);
  }
  function setLeslie(fast, t) { // horn spins up in ≈1 s, the heavy drum takes ≈4–5 s (and longer to coast down)
    if (!N.horn) return;
    N.leslieFast = fast;
    const H = fast ? [6.7, 0.32] : [0.83, 0.6], D = fast ? [5.9, 1.5] : [0.67, 2.4];
    for (const o of [N.horn.oc, N.horn.os]) setp(o.frequency, H[0], t, H[1]);
    for (const o of [N.drum.oc, N.drum.os]) setp(o.frequency, D[0], t, D[1]);
  }

  // ---------------------------------------------------------------- instruments
  function organNote(ev, t, dur, dest) {
    const reg = REG[ev.reg || 'comp'], wave = S.waves[ev.reg || 'comp'], n = ev.n.length;
    const peak = ev.v * reg.level / Math.pow(n, 0.35);
    const g = ctx.createGain(); g.gain.value = 0; g.connect(dest);
    const t0 = Math.max(0, t), end = t0 + Math.max(0.03, dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    if (reg.decay) g.gain.setTargetAtTime(peak * reg.decay[1], t0 + 0.006, reg.decay[0]);
    g.gain.setTargetAtTime(0, end, 0.014);
    const stop = end + 0.12; let last = null;
    for (const m of ev.n) {
      const sub = mtof(m) / 2;
      last = osc(null, sub, t0, stop, g, wave.oct);
      if (wave.mut) osc(null, sub * MUT_RATIO, t0, stop, g, wave.mut);
      if (wave.tierce) { const tg = G(wave.tierce); tg.connect(g); osc('sine', sub * TIERCE_RATIO, t0, stop, tg); }
      if (reg.perc && !ev.np) {
        const pg = ctx.createGain(); pg.gain.setValueAtTime(0, t0); pg.gain.linearRampToValueAtTime(reg.percLevel / Math.sqrt(n), t0 + 0.003); pg.gain.setTargetAtTime(0, t0 + 0.003, reg.percTau);
        pg.connect(g); osc('sine', mtof(m) * reg.perc, t0, Math.min(stop, t0 + reg.percTau * 7), pg);
      }
    }
    if (reg.click && !ev.nc) playBuf(getBuf('click'), t0, { dest, gain: reg.click * ev.v * (0.6 + 0.6 * rnd()) * 0.5 });
    if (last) { S.voices++; last.onended = () => { S.voices = Math.max(0, S.voices - 1); try { g.disconnect(); } catch (e) { /* */ } }; }
  }
  const DRUM_DB = { kick: -4, snare: -6, hat: -13, ohat: -14, crash: -12, rcym: -9, clap: -8 };
  function drum(kind, t, v, dest) { playBuf(getBuf(kind, !!{ kick: 1, snare: 1, hat: 1 }[kind]), t, { dest, gain: v * dbg(DRUM_DB[kind] ?? -6), rate: kind === 'hat' ? 0.97 + rnd() * 0.06 : 1 }); }
  function crowdClap(t, v, o = {}) { if (!has('cclap')) return; playBuf(getBuf('cclap'), t, { dest: N.crowd, gain: v * 0.55, rate: (o.rate ?? 1) * (0.96 + rnd() * 0.08), pan: o.pan, verb: 0.14 }); }
  function crowdHey(t, v) { if (!has('hey')) return; playBuf(getBuf('hey'), t, { dest: N.crowd, gain: v * 0.9, verb: 0.25, echo: 0.2 }); }

  // ---------------------------------------------------------------- scheduler
  function startTrack(def, t) {
    const trk = { name: def.name, def, i: 0, t0: t, spb: 60 / def.bpm, iter: 0, done: false, gOrg: G(1), gMus: G(1) };
    trk.gOrg.connect(N.organIn); trk.gMus.connect(N.music);
    trk.end = def.loop ? Infinity : t + def.len * trk.spb;
    S.tracks.push(trk);
    return trk;
  }
  function stopTrack(trk, t, fade = 0.3) {
    if (!trk || trk.stopped) return;
    trk.done = true; trk.stopped = true; trk.end = Math.min(trk.end, t + fade);
    for (const g of [trk.gOrg, trk.gMus]) setp(g.gain, 0, t, fade / 3);
    if (!offline) setTimeout(() => { try { trk.gOrg.disconnect(); trk.gMus.disconnect(); } catch (e) { /* */ } }, (fade + 1.5) * 1000);
  }
  function playEvent(trk, ev, t) {
    if (ev.i === 'leslie') return setLeslie(ev.fast, t);
    if (S.muted || !S.musicOn) return;
    if (trk.def.yieldToRiff && t < S.riffUntil + 0.25) return;
    const sw = trk.def.swing, dur = ev.d != null ? (warp(ev.b + ev.d, sw) - warp(ev.b, sw)) * trk.spb * (ev.gate ?? 0.93) : 0;
    switch (ev.i) {
      case 'org': case 'bass': return organNote(ev, t, dur, trk.gOrg);
      case 'cclap': return crowdClap(t, ev.v);
      case 'hey': return crowdHey(t, ev.v);
      default: return drum(ev.i, t, ev.v, trk.gMus);
    }
  }
  function advance(trk, now, horizon) {
    const evs = trk.def.evs; if (!evs.length) { trk.done = true; return; }
    if (!trk.begun) { // anchor lazily: a cue must never lose its downbeat to a stall / a context that started late
      trk.begun = true;
      if (trk.t0 < now + 0.02) { const d = now + 0.02 - trk.t0; trk.t0 += d; if (isFinite(trk.end)) trk.end += d; if (S.riff === trk) S.riffUntil = trk.end; }
    }
    let guard = 0;
    while (!trk.done && guard++ < 4096) {
      const ev = evs[trk.i], t = trk.t0 + warp(ev.b, trk.def.swing) * trk.spb;
      if (t > horizon) break;
      if (t >= now - 0.04) { playEvent(trk, ev, Math.max(t, now)); const st = S.stats, lead = t - now; st.played++; if (lead > st.maxLead) st.maxLead = lead; if (lead < st.minLead) st.minLead = lead; }
      else { S.stats.late++; if (ev.i === 'leslie') setLeslie(ev.fast, now); }
      if (++trk.i >= evs.length) {
        if (trk.def.loop) { trk.i = 0; trk.t0 += trk.def.loop * trk.spb; trk.iter++; } else trk.done = true;
      }
    }
  }
  function tick(nowArg) {
    if (!live()) return;
    const now = nowArg != null ? nowArg : T();
    if (!offline && ctx.state !== 'running') return;
    const horizon = now + LOOKAHEAD; S.stats.ticks++;
    if (S.queuedRiff && horizon >= S.riffUntil) { const q = S.queuedRiff; S.queuedRiff = null; startRiff(RIFFS[q], Math.max(S.riffUntil, now + 0.02)); }
    for (const trk of S.tracks) if (!trk.done) advance(trk, now, horizon);
    S.tracks = S.tracks.filter(trk => !trk.done || now < trk.end + 1);
    if (S.crowdHold && now > S.holdUntil) { S.crowdHold = 0; applyCrowd(now); }
    if (S.bed) crowdEvents(now, horizon);
  }
  function startRiff(def, t) {
    const trk = startTrack(def, t);
    S.riff = trk; S.riffUntil = trk.end;
    const m = S.musicTrk;
    if (m && !m.stopped && !m.def.yieldToRiff) { // duck a non-yielding cue (title) under the riff
      for (const g of [m.gOrg, m.gMus]) { setp(g.gain, 0.3, t, 0.08); if (isFinite(trk.end)) g.gain.setTargetAtTime(1, trk.end, 0.3); }
    }
    return trk;
  }
  function stopRiff(t, fade) {
    if (S.riff && !S.riff.stopped) stopTrack(S.riff, t, fade);
    S.riff = null; S.riffUntil = Math.min(S.riffUntil, t);
    const m = S.musicTrk; if (m && !m.stopped) for (const g of [m.gOrg, m.gMus]) setp(g.gain, 1, t, 0.2);
  }

  // ---------------------------------------------------------------- crowd bed + park ambience
  // Layers: wash (the far-field ocean of ~40k voices: speech-shaped noise), murmur (34 talkers),
  // roar (90 cheering voices, fades in with excitement), park (Wrigley rooftop parties / Rate expressway).
  function startBed(t) {
    if (!O.bed || S.bed || !live()) return;
    const B = S.bed = { layers: {} };
    B.sum = G(1); B.ant = G(1); chain(B.sum, B.ant, N.crowd);
    B.lfoA = ctx.createOscillator(); B.lfoA.frequency.value = 0.071; B.lfoB = ctx.createOscillator(); B.lfoB.frequency.value = 0.173;
    const t0 = Math.max(0, t); B.lfoA.start(t0); B.lfoB.start(t0);
    S.nextEvt = t0 + 0.4 + rnd(); S.nextTrain = t0 + 25 + rnd() * 35; S.nextHorn = t0 + 40 + rnd() * 60; S.nextFlag = t0 + 2;
    bedLayers(t0);
  }
  function mkLayer(key, idx, filters, dest, lfo) {
    const buf = ok(key, idx) ? wrap(key, idx, false) : null; if (!buf) return null;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = G(0); chain(src, ...filters, g, dest);
    const mod = G(0); if (lfo) { lfo.connect(mod); mod.connect(g.gain); }
    src.start(Math.max(0, T()), rnd() * buf.duration * 0.9);
    return { key, src, g, mod, f: filters };
  }
  function bedLayers(t) {
    const B = S.bed; if (!B) return;
    const Ls = B.layers;
    if (!Ls.wash && has('pink')) Ls.wash = mkLayer('pink', 0, [BF('highpass', 150), BF('peaking', 520, 0.8, 5), BF('lowpass', 1500, 0.6)], B.sum, B.lfoA);
    if (!Ls.mur && has('murmur')) Ls.mur = mkLayer('murmur', 0, [BF('highpass', 120), BF('peaking', 1800, 0.7, -3.5)], B.sum, B.lfoB);   // distance: darker than close speech
    if (!Ls.roar && has('roar')) Ls.roar = mkLayer('roar', 0, [BF('highpass', 140), BF('lowpass', 2000, 0.6)], B.sum, B.lfoA);
    const pk = S.park === 'rate' ? 'traffic' : S.park === 'wrigley' ? 'rooftop' : null;
    if (Ls.park && Ls.park.key !== pk) { const old = Ls.park; setp(old.g.gain, 0, T(), 0.4); try { old.src.stop(T() + 2); } catch (e) { /* */ } Ls.park = null; }
    if (pk && !Ls.park && has(pk)) Ls.park = mkLayer(pk, 0, pk === 'rooftop' ? [BF('highpass', 180), BF('lowpass', 2200, 0.6)] : [BF('highpass', 45)], N.amb, null);
    S.crowdApplied = -1; applyCrowd(t, 0.7);
  }
  function applyCrowd(t, tauOverride) {
    const B = S.bed; if (!B) return;
    const L = clamp(Math.max(S.crowd, S.crowdHold), 0, 1), up = L >= S.crowdApplied, tau = tauOverride ?? (up ? 0.14 : 1.0), Ls = B.layers;
    // absolute targets (final output, bed only): L=0 ≈ −34 dBFS · 0.35 ≈ −29 · 0.7 ≈ −22 · 1 ≈ −17 (crowd_levels case)
    if (Ls.wash) { const v = 0.07 + 0.09 * L + 0.65 * L * L; setp(Ls.wash.g.gain, v, t, tau); setp(Ls.wash.mod.gain, v * 0.16, t, tau); setp(Ls.wash.f[2].frequency, 1300 + 3600 * L, t, tau); }
    if (Ls.mur) { const v = 0.14 * (1 + L); setp(Ls.mur.g.gain, v, t, tau); setp(Ls.mur.mod.gain, v * 0.12, t, tau); setp(Ls.mur.src.playbackRate, 1 + 0.05 * L, t, tau * 1.5); }
    if (Ls.roar) { const v = 1.4 * Math.pow(smooth(0.2, 1, L), 2); setp(Ls.roar.g.gain, v, t, tau); setp(Ls.roar.mod.gain, v * 0.12, t, tau); setp(Ls.roar.f[1].frequency, 1700 + 5600 * L, t, tau); }
    if (Ls.park) { const v = Ls.park.key === 'traffic' ? 0.075 : 0.05 + 0.04 * L; setp(Ls.park.g.gain, v, t, tau * 2); }
    S.crowdApplied = L;
  }
  function holdCrowd(level, until) { S.crowdHold = Math.max(S.crowdHold, level); S.holdUntil = Math.max(S.holdUntil, until); applyCrowd(T()); }
  function crowdEvents(now, horizon) {
    if (S.nextEvt < now - 0.5) S.nextEvt = now + rnd();
    while (S.nextEvt < horizon) {
      const t = S.nextEvt, L = Math.max(S.crowd, S.crowdHold), r = rnd();
      S.nextEvt += -Math.log(1 - rnd() * 0.999) / (0.3 + 1.5 * L * L);
      if (S.muted || t < S.clipUntil) continue;
      if (r < 0.3) shoutGroup(t, 1 + Math.floor(rnd() * 3), { gain: 0.05 + 0.12 * L });
      else if (r < 0.48) whistle(t, 0.3 + 0.7 * L);
      else if (r < 0.58) nearClaps(t, L);
      else if (r < 0.68 && L > 0.25 && t > S.clapRunUntil && !S.riff) { const n = 6 + Math.floor(rnd() * 7), iv = 0.4 + rnd() * 0.08; for (let k = 0; k < n; k++) crowdClap(t + k * iv, 0.25 + 0.35 * (k / n) * L); S.clapRunUntil = t + n * iv + 2; }
      else if (r < 0.74 && L > 0.2 && L < 0.75 && t > S.chantAt && !S.riff) { SFX.clap_chant(t, { level: L }, lvl('clap_chant')); S.chantAt = t + 30 + rnd() * 30; }
      else if (r < 0.84 && L < 0.65 && t > S.vendorAt && has('vendor')) { SFX.vendor(t, {}, lvl('vendor')); S.vendorAt = t + 9 + rnd() * 12; }
      else shoutGroup(t, 2 + Math.floor(rnd() * 3), { gain: 0.04 + 0.08 * L, far: true });
    }
    if (S.muted) return;
    if (S.park === 'wrigley') {
      if (now > S.nextTrain) { if (has('train')) SFX.el_train(now + 0.1, {}, lvl('el_train')); S.nextTrain = now + 55 + rnd() * 70; }
      if (S.wind > 5 && now > S.nextFlag) { if (has('flag')) SFX.flag_snap(now + 0.1, {}, lvl('flag_snap')); S.nextFlag = now + 3 + rnd() * 60 / S.wind; }
    } else if (S.park === 'rate' && now > S.nextHorn) { if (has('trainhorn')) SFX.train_horn(now + 0.1, {}, lvl('train_horn')); S.nextHorn = now + 80 + rnd() * 90; }
  }
  function shoutGroup(t, n, o = {}) { // a few fans yelling together, somewhere in the stands (never a lone exposed voice)
    if (!has('shout')) return;
    const pan = rnd() * 1.8 - 0.9, far = o.far;
    for (let k = 0; k < n; k++) playBuf(getBuf('shout'), t + rnd() * 0.12, { dest: N.crowd, gain: (o.gain ?? 0.1) * (0.6 + 0.4 * rnd()), rate: 0.86 + rnd() * 0.3, pan: clamp(pan + (rnd() - 0.5) * 0.3, -1, 1), lp: far ? 1600 + rnd() * 800 : 2600 + rnd() * 2400, verb: far ? 0.45 : 0.3 });
  }
  function whistle(t, k, pan) {
    if (!has('whistle')) return;
    const far = rnd();
    playBuf(getBuf('whistle'), t, { dest: N.crowd, gain: lvl('whistle') * k * (0.35 + 0.65 * (1 - far)), rate: 0.9 + rnd() * 0.2, pan: pan ?? rnd() * 1.8 - 0.9, lp: 3500 + 6000 * (1 - far), verb: 0.35 });
  }
  function nearClaps(t, L) { // one or two nearby fans clapping steadily
    if (!has('clap')) return;
    const n = 4 + Math.floor(rnd() * 6), iv = 0.36 + rnd() * 0.12, pan = rnd() * 1.6 - 0.8;
    for (let k = 0; k < n; k++) playBuf(getBuf('clap'), t + k * iv + (rnd() - 0.5) * 0.02, { dest: N.crowd, gain: (0.04 + 0.05 * L) * (0.8 + 0.2 * rnd()), rate: 0.9 + rnd() * 0.2, pan, lp: 5000, verb: 0.2 });
  }
  function applause(t, dur, k) { // dense, unsynchronised clapping of thousands
    if (!has('cclap')) return;
    const n = Math.round(dur * (5 + 5 * k));
    for (let j = 0; j < n; j++) { const u = j / n; crowdClap(t + u * dur + rnd() * 0.1, (0.35 + 0.3 * k) * (1 - 0.6 * u) * (0.7 + 0.3 * rnd()), { pan: rnd() * 1.8 - 0.9, rate: 0.85 + rnd() * 0.3 }); }
  }
  function roarBurst(t, g, k, o = {}) { // the explosive broadband onset of a stadium roar (far-field wash)
    const pink = getBuf('pink'); if (!pink) return;
    const src = ctx.createBufferSource(); src.buffer = pink; src.loop = true;
    const bp = BF('bandpass', 1100, 0.5), lp = BF('lowpass', 900), env = G(0), p = panNode(0);
    chain(src, bp, lp, env, p, N.crowd); const sx = sends(p, 0.25, 0, o.city || 0);
    const hold = o.hold ?? 1.3;
    lp.frequency.setValueAtTime(900, t); lp.frequency.linearRampToValueAtTime(5200, t + 0.35); lp.frequency.setTargetAtTime(1700, t + hold + 0.3, 0.9);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 1.3 * k, t + 0.28); env.gain.setValueAtTime(g * 1.2 * k, t + hold); env.gain.setTargetAtTime(0, t + hold, 0.9);
    src.start(t, rnd() * 2); src.stop(t + hold + 4.5); track1(src, [bp, lp, env, p, ...sx]);
  }
  function stopOoh(t, fade) { const o = S.ooh; if (!o || t > o.until) return; S.ooh = null; setp(o.g.gain, 0, t, fade / 3); try { o.src.stop(t + fade + 0.2); } catch (e) { /* */ } }
  function noiseSrc(t, stop, dest, rate = 1) { const s = ctx.createBufferSource(); s.buffer = getBuf('white'); s.loop = true; s.playbackRate.value = rate; s.connect(dest); s.start(t, rnd()); s.stop(stop); return s; }
  function duck(t, depth, hold, crowd = 0) {
    for (const d of [N.musicDuck, N.organDuck]) { setp(d.gain, depth, t, 0.02); d.gain.setTargetAtTime(1, t + hold, 0.25); }
    if (crowd) { setp(N.crowdDuck.gain, crowd, t, 0.05); N.crowdDuck.gain.setTargetAtTime(1, t + hold, 0.35); }
  }
  const ramp = (p, pts) => { for (const [v, tt, lin] of pts) { if (lin) p.linearRampToValueAtTime(v, tt); else p.exponentialRampToValueAtTime(Math.max(1e-5, v), tt); } };

  // ---------------------------------------------------------------- SFX
  function batHit(t, o, g, cls) {
    const s = clamp(o.batSpeed ?? 0.72, 0, 1), c = String(o.contact || ''), bucket = s < 0.4 ? 0 : s < 0.78 ? 1 : 2;
    const q = clamp(o.quality ?? (cls === 'sweet' ? 0.95 : cls === 'solid' ? 0.7 : 0.35), 0, 1);
    let key = 'bat_solid', idx = bucket, blend = null;
    if (cls === 'sweet') { key = 'bat_sweet'; if (q < 0.8) blend = ['bat_solid', bucket, 0.5]; }
    else if (cls === 'solid') { if (/jam/.test(c)) { key = 'bat_jam'; idx = 0; } else if (/end/.test(c)) { key = 'bat_end'; idx = 0; } else if (q > 0.78) blend = ['bat_sweet', bucket, (q - 0.78) * 3]; }
    else { key = /end/.test(c) ? 'bat_end' : /jam/.test(c) ? 'bat_jam' : /topped|under/.test(c) ? 'bat_solid' : (rnd() < 0.5 ? 'bat_jam' : 'bat_end'); idx = key === 'bat_solid' ? 0 : bucket >= 1 ? 1 : 0; }
    const pan = o.pan ?? (o.bats === 'L' ? 0.12 : -0.12), level = g * dbg(-7 + 7 * s);
    playBuf(varBuf(key, idx), t, { gain: level, rate: 0.985 + rnd() * 0.03, pan, verb: cls === 'weak' ? 0.18 : 0.24, echo: cls === 'weak' ? 0.1 : 0.2, city: cls === 'sweet' ? 0.07 : 0 });
    if (blend && blend[2] > 0) playBuf(varBuf(blend[0], blend[1]), t, { gain: level * clamp(blend[2], 0, 1) * 0.6, rate: 0.99 + rnd() * 0.02, pan, verb: 0.2 });
    duck(t, cls === 'sweet' ? 0.4 : 0.6, cls === 'sweet' ? 0.45 : 0.3);
    if (N.crowdPump) { holdAt(N.crowdPump.gain, t); N.crowdPump.gain.setTargetAtTime(cls === 'weak' ? 0.8 : 0.6, t, 0.004); N.crowdPump.gain.setTargetAtTime(1, t + 0.09, 0.12); } // the crowd "breathes in" under the crack
  }
  const SFX = {
    bat_sweet(t, o, g) { batHit(t, o, g, 'sweet'); },
    bat_solid(t, o, g) { batHit(t, o, g, 'solid'); },
    bat_weak(t, o, g) { batHit(t, o, g, 'weak'); },
    foul(t, o, g) { // a well-struck foul still cracks; a tip is a sharp high tick
      if ((o.quality ?? 0) > 0.55) return batHit(t, o, g * dbg(2), 'solid');
      const s = clamp(o.batSpeed ?? 0.72, 0, 1);
      playBuf(getBuf('foul'), t, { gain: g * dbg(-5 + 5 * s), rate: 0.97 + rnd() * 0.06, pan: o.pan ?? -0.1, verb: 0.16, echo: 0.2 });
    },
    mitt(t, o, g) { // leather pop, harder for faster pitches, slapping back off the stands
      const h = clamp(((o.mph ?? 90) - 75) / 23, 0, 1), idx = h < 0.33 ? 0 : h < 0.7 ? 1 : 2;
      playBuf(varBuf('mitt', idx), t, { gain: g * dbg(-3 + 4 * h), rate: 0.97 + rnd() * 0.06, pan: o.pan ?? 0.04, verb: 0.16, echo: 0.28 });
    },
    swing_whoosh(t, o, g) { // the bat cutting air: aeolian noise ∝ speed, band centre rises with speed, peaks at contact
      // leadT = s from the CALL to bat-on-ball (a `delay` only trims the start of the whoosh, never moves its peak)
      const s = clamp(o.batSpeed ?? 0.72, 0, 1), tc = (t - Math.max(0, +o.delay || 0)) + clamp(+o.leadT || (0.2 - 0.11 * s), 0.04, 0.4);
      if (t > tc - 0.03) t = tc - 0.03;
      const lead = tc - t; S.swingTc = tc;
      const tail = 0.13 + 0.08 * (1 - s) + (o.miss ? 0.1 : 0), stop = tc + tail + 0.12, amp = Math.max(1e-4, g * (0.14 + 0.86 * s * s));
      const side = o.bats === 'L' ? 1 : -1, p = panNode(side * 0.4);
      const bp = BF('bandpass', 300, 1.3), lpw = BF('lowpass', 2400 + 1600 * s, 0.7), e1 = G(0), s1 = noiseSrc(t, stop, bp); chain(bp, lpw, e1, p, N.sfx); const sx = sends(p, 0.1, 0);
      const f0 = 240 + 260 * s, fpk = 650 + 1150 * s;
      bp.frequency.setValueAtTime(f0, t); ramp(bp.frequency, [[fpk, tc], [fpk * 0.55, tc + tail]]);
      e1.gain.setValueAtTime(1e-5, t); ramp(e1.gain, [[amp * 0.1, t + lead * 0.55], [amp, tc], [amp * 0.02, tc + tail], [0, tc + tail + 0.04, 1]]);
      const hp = BF('highpass', 2600), e2 = G(0), s2 = noiseSrc(t, stop, hp); chain(hp, e2, p);
      e2.gain.setValueAtTime(1e-5, t); ramp(e2.gain, [[amp * 0.12 * (0.4 + 0.6 * s), tc - 0.008], [1e-5, tc + tail * 0.7]]);
      track1(s1, [bp, lpw, e1, p, ...sx]); track1(s2, [hp, e2]);
      if (s > 0.35) { const lp = BF('lowpass', 210, 0.9), e3 = G(0), s3 = noiseSrc(t, stop, lp); chain(lp, e3, p); e3.gain.setValueAtTime(1e-5, t); ramp(e3.gain, [[amp * 1.3 * (s - 0.35), tc], [1e-5, tc + tail * 0.8]]); track1(s3, [lp, e3]); }
      if (p.pan) { p.pan.setValueAtTime(side * 0.45, t); p.pan.linearRampToValueAtTime(-side * 0.25, tc + tail); }
    },
    whiff(t, o, g) { // after a swing_whoosh: the follow-through as the bat wraps around; alone (v1 callers): the whole swing
      if (S.lastSfx.swing_whoosh != null && t - S.lastSfx.swing_whoosh < 0.6) {
        if (S.swingTc && S.swingTc > t && S.swingTc - t < 0.4) t = S.swingTc - 0.01;   // follow-through starts where the ball wasn't
        const s = clamp(o.batSpeed ?? 0.72, 0, 1), bp = BF('bandpass', 520 + 300 * s, 1.1), lpw = BF('lowpass', 2500, 0.7), e = G(0), p = panNode(o.bats === 'L' ? -0.3 : 0.3), stop = t + 0.4;
        const src = noiseSrc(t, stop, bp); chain(bp, lpw, e, p, N.sfx); const sx = sends(p, 0.12, 0);
        ramp(bp.frequency, [[240, t + 0.28]]); e.gain.setValueAtTime(1e-5, t); ramp(e.gain, [[g * (0.4 + 0.5 * s), t + 0.05], [1e-5, t + 0.3]]);
        track1(src, [bp, lpw, e, p, ...sx]);
      } else SFX.swing_whoosh(t, { ...o, leadT: 0.05, miss: true }, g * dbg(2));
    },
    pitch_whoosh(t, o, g) { // the ball arriving at the catcher cam: level ∝ 1/r, seam flutter at 2× spin, tiny Doppler lift
      const dur = clamp(o.dur ?? 0.45, 0.25, 1.6), mph = clamp(o.mph ?? 90, 60, 105), k = (mph - 60) / 45, stop = t + dur + 0.15;
      const off = /curve|slurve|knuck/i.test(o.type || '') ? 0.6 : /change|split/i.test(o.type || '') ? 0.8 : 1;
      const bp = BF('bandpass', 1300 + 900 * k, 1.6), lpw = BF('lowpass', 5000, 0.7), am = G(1), env = G(0), p = panNode(-0.12);
      const s = noiseSrc(t, stop, bp); chain(bp, lpw, am, env, p, N.sfx);
      const fl = ctx.createOscillator(); fl.frequency.value = (38 + 12 * k) * 2 * off; const fg = G(0.28); chain(fl, fg, am.gain); fl.start(t); fl.stop(stop);
      const n = 32, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const u = i / (n - 1), r = 62 - 54 * u; curve[i] = g * (0.5 + 0.9 * k) * (8 / r) * Math.min(1, u * 8); }
      curve[n - 2] *= 0.45; curve[n - 1] = 0;   // the curve lands at 0 itself: Chrome pads curves to a render quantum, so a follow-up event can overlap
      try { env.gain.setValueCurveAtTime(curve, t, dur); } catch (e) { env.gain.linearRampToValueAtTime(g, t + dur); }
      try { env.gain.setTargetAtTime(0, t + dur + 0.03, 0.02); } catch (e) { /* curve already ends at 0 */ }
      bp.frequency.setValueAtTime((1300 + 900 * k) * 0.94, t); bp.frequency.linearRampToValueAtTime((1300 + 900 * k) * 1.06, t + dur);
      if (p.pan) p.pan.linearRampToValueAtTime(0.05, t + dur);
      const hp = BF('highpass', 4200), he = G(0), h = noiseSrc(t, stop, hp); chain(hp, he, p);
      try { he.gain.setValueCurveAtTime(curve.map(v => v * 0.08), t, dur); } catch (e) { /* */ } try { he.gain.setTargetAtTime(0, t + dur + 0.03, 0.02); } catch (e) { /* */ }
      const fb = BF('highpass', 1400), fe = G(0), f = noiseSrc(t, t + 0.08, fb, 0.8); chain(fb, fe, N.sfx); // release "fwip"
      fe.gain.setValueAtTime(g * 0.3, t); fe.gain.setTargetAtTime(0, t + 0.005, 0.015);
      track1(s, [bp, lpw, am, env, p, fg]); track1(h, [hp, he]); track1(f, [fb, fe]);
      duck(t, 0.6, dur + 0.2);
    },
    homer_horn(t, o, g) { // stadium air-horn chord: detuned saw stacks → buzz → horn-bell resonances
      const dur = o.dur ?? 2.1, stop = t + dur + 0.6;
      const sum = G(1), sh = ctx.createWaveShaper(); sh.curve = driveCurve(2.4); sh.oversample = '2x';
      const env = G(0), out = G(g * 0.9);
      chain(sum, BF('highpass', 110), sh, BF('peaking', 520, 1.1, 4), BF('peaking', 1500, 1.2, 6), BF('peaking', 2400, 1.4, 4), BF('lowpass', 6500, 0.7), env, out, N.sfx);
      const sx = sends(out, 0.5, 0.28, 0.2);
      const oscs = [];
      [nm('F3'), nm('A3'), nm('C4'), nm('D4')].forEach((m, k) => {
        for (const det of [-7, 6]) {
          const f = mtof(m), o1 = ctx.createOscillator(); o1.type = 'sawtooth';
          o1.frequency.setValueAtTime(f * 0.955, t); o1.frequency.setTargetAtTime(f, t, 0.045); o1.detune.value = det + (rnd() - 0.5) * 4;
          const og = G(0.16 - k * 0.015); chain(o1, og, sum); o1.start(t); o1.stop(stop); oscs.push(o1);
        }
      });
      const vib = ctx.createOscillator(); vib.frequency.value = 5.2; const vg = G(0); chain(vib, vg); oscs.forEach(x => vg.connect(x.detune)); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(7, t + 0.8); vib.start(t); vib.stop(stop);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.05); env.gain.setValueAtTime(1, t + dur - 0.15); env.gain.linearRampToValueAtTime(0.85, t + dur); env.gain.setTargetAtTime(0, t + dur, 0.09);
      const nb = BF('bandpass', 1800, 0.8), ne = G(0); const nz = noiseSrc(t, t + 0.4, nb); chain(nb, ne, env);
      ne.gain.setValueAtTime(0.5, t); ne.gain.setTargetAtTime(0, t + 0.01, 0.07);
      track1(oscs[0], [sum, sh, env, out, ...sx]); track1(nz, [nb, ne]);
      duck(t, 0.5, dur);
    },
    fireworks(t, o, g) { // o.n shells (default 3), staggered like a real volley; booms slap back off the buildings
      const n = clamp(o.n ?? 3, 1, 12), gap = o.barrage ? 0.26 : 0.42;
      for (let k = 0; k < n; k++) playBuf(getBuf('shell'), t + k * gap + (k ? rnd() * 0.18 : 0), { gain: g * (k ? 0.8 + rnd() * 0.2 : 1), pan: (rnd() - 0.5) * 0.7, verb: 0.45, echo: 0.12, city: 0.3 });
    },
    crowd_roar(t, o, g) { // ooh → ROAR: vowel crowd + broadband onset + whistles + applause; scaled by distance
      const k = clamp(o.intensity ?? (o.distance ? (o.distance - 330) / 150 : 1), 0.3, 1);
      stopOoh(t, 0.3);
      if (has('cheer')) {
        playBuf(getBuf('cheer'), t, { dest: N.crowd, gain: g * (0.55 + 0.5 * k), rate: 0.98 + rnd() * 0.04, verb: 0.22 });
        playBuf(getBuf('cheer'), t + 0.1 + rnd() * 0.1, { dest: N.crowd, gain: g * 0.45 * k, rate: 1.04 + rnd() * 0.05, pan: 0.25, verb: 0.25 });
      }
      roarBurst(t, g, k, { hold: 1.1 + 0.6 * k });
      for (let j = 0; j < 2 + Math.round(4 * k); j++) whistle(t + 0.5 + rnd() * 2.5, 0.7 + 0.3 * k);
      applause(t + 1.1, 3 + k, k);
      holdCrowd(0.7 + 0.3 * k, t + 2.5 + 1.5 * k);
    },
    crowd_groan(t, o, g) { // the "ooh" deflates into an "awww"
      stopOoh(t, 0.18);
      playBuf(getBuf('groan', false), t, { dest: N.crowd, gain: g, rate: 0.97 + rnd() * 0.05, verb: 0.22 });
      const pink = getBuf('pink'); if (!pink) return;
      const src = ctx.createBufferSource(); src.buffer = pink; src.loop = true;
      const lp = BF('lowpass', 1300, 0.7), env = G(0); chain(src, BF('highpass', 180), lp, env, N.crowd);
      lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(420, t + 1.4);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 0.6, t + 0.15); env.gain.setTargetAtTime(0, t + 0.3, 0.5);
      src.start(t, rnd() * 2); src.stop(t + 3); track1(src, [lp, env]);
    },
    crowd_ooh(t, o, g) { // rising "ooooOOOH" as a fly ball carries — climax aligned to `dur` (hang time / fence time)
      const buf = getBuf('ooh', false); if (!buf) return;
      const dur = clamp(o.dur ?? 3, 0.8, buf.duration - 0.2), k = clamp(o.intensity ?? 0.8, 0.2, 1);
      stopOoh(t, 0.1);
      const h = playBuf(buf, t, { dest: N.crowd, gain: g * (0.5 + 0.5 * k), offset: Math.max(0, buf.duration - 0.15 - dur), fadeIn: 0.15, verb: 0.22 });
      if (h) S.ooh = { ...h, until: t + dur + 0.6 };
    },
    anticipation(t, o, g) { // the crowd leans in during the windup: bed swells ~+3 dB, a whistle, a shout
      const B = S.bed, dur = clamp(o.dur ?? 1.5, 0.4, 3);
      if (B) { holdAt(B.ant.gain, t); B.ant.gain.linearRampToValueAtTime(dbg(2.2) * g, t + dur); B.ant.gain.setTargetAtTime(1, t + dur + 0.3, 0.7); }
      if (rnd() < 0.7) whistle(t + rnd() * dur * 0.6, 0.6);
      shoutGroup(t + rnd() * dur * 0.5, 2, { gain: 0.08 });
    },
    crowd_hey(t, o, g) { playBuf(getBuf('hey', false), t, { dest: N.crowd, gain: g, verb: 0.25, echo: 0.2 }); },
    clap_chant(t, o, g) { // "clap-clap · clap-clap-clap" — a section starts it, the park joins in
      const L = o.level ?? S.crowd, bars = o.bars ?? 4, e8 = 0.21, pat = [0, 1, 3, 4, 5];
      for (let b = 0; b < bars; b++) for (const s of pat) { const u = (b + s / 8) / bars; crowdClap(t + (b * 8 + s) * e8, g * (0.35 + 0.65 * u) * (0.8 + 0.4 * L), { pan: (rnd() - 0.5) * 0.4 }); }
      S.clapRunUntil = t + bars * 8 * e8 + 2;
    },
    whistle(t, o, g) { whistle(t, g / lvl('whistle'), o.pan); },
    vendor(t, o, g) { const b = getBuf('vendor', false); if (b) playBuf(b, t, { dest: N.crowd, gain: g, rate: 0.95 + rnd() * 0.1, pan: o.pan ?? (rnd() < 0.5 ? -1 : 1) * (0.4 + rnd() * 0.5), lp: 2000, hp: 220, verb: 0.55, echo: 0.1 }); },
    el_train(t, o, g) { const b = getBuf('train', false); if (b) playBuf(b, t, { dest: N.amb, gain: g, verb: 0.15 }); },
    train_horn(t, o, g) { const b = getBuf('trainhorn', false); if (b) playBuf(b, t, { dest: N.amb, gain: g, pan: -0.6, lp: 1700, verb: 0.45, city: 0.2 }); },
    flag_snap(t, o, g) { const b = getBuf('flag', false); if (b) playBuf(b, t, { dest: N.amb, gain: g * clamp(S.wind / 15, 0.3, 1.3), rate: 0.9 + rnd() * 0.2, pan: (rnd() - 0.5) * 0.4, lp: 3500, verb: 0.2 }); },
    siren(t, o, g) { // the old South Side homer siren: a wailing rotor (rising, holding, falling)
      const d = o.dur ?? 4.2, stop = t + d + 0.5, lp = BF('lowpass', 1900, 0.8), pk = BF('peaking', 800, 1.2, 5), env = G(0), p = panNode(o.pan ?? 0.05);
      chain(lp, pk, env, p, N.sfx); const sx = sends(p, 0.45, 0, 0.3);
      const a = ctx.createOscillator(), b = ctx.createOscillator(); a.type = 'sawtooth'; b.type = 'square'; const bg = G(0.3); a.connect(lp); chain(b, bg, lp);
      for (const x of [a, b]) { x.frequency.setValueAtTime(220, t); x.frequency.linearRampToValueAtTime(640, t + d * 0.38); x.frequency.setValueAtTime(640, t + d * 0.55); x.frequency.linearRampToValueAtTime(230, t + d); x.start(t); x.stop(stop); }
      b.detune.value = 8; env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g, t + 0.4); env.gain.setValueAtTime(g, t + d * 0.7); env.gain.linearRampToValueAtTime(0, t + d);
      track1(a, [lp, pk, env, p, bg, ...sx]);
    },
    car_alarm(t, o, g) { // a car on Waveland decides to join in: whooping, then a two-tone
      const d = 2.6, stop = t + d + 0.2, bp = BF('bandpass', 1400, 1.2), env = G(0), p = panNode(o.pan ?? 0.4);
      chain(bp, env, p, N.amb); const sx = sends(p, 0.4, 0, 0.35);
      const x = ctx.createOscillator(); x.type = 'square'; x.frequency.setValueAtTime(900, t);
      for (let k = 0; k < 6; k++) { x.frequency.linearRampToValueAtTime(1750, t + k * 0.22 + 0.2); x.frequency.setValueAtTime(900, t + k * 0.22 + 0.21); }
      for (let k = 0; k < 4; k++) { x.frequency.setValueAtTime(1300, t + 1.35 + k * 0.32); x.frequency.setValueAtTime(950, t + 1.51 + k * 0.32); }
      x.connect(bp); x.start(t); x.stop(stop);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g, t + 0.05); env.gain.setValueAtTime(g, t + d - 0.1); env.gain.linearRampToValueAtTime(0, t + d);
      track1(x, [bp, env, p, ...sx]);
    },
    car_horn(t, o, g) { // two honks from the street
      const bp = BF('bandpass', 700, 1), pk = BF('peaking', 1800, 1.5, 4), env = G(0), p = panNode(o.pan ?? 0.3), stop = t + 1;
      chain(bp, pk, env, p, N.amb); const sx = sends(p, 0.35, 0, 0.3);
      const xs = [410, 516].map(f => { const x = ctx.createOscillator(); x.type = 'square'; x.frequency.value = f; x.connect(bp); x.start(t); x.stop(stop); return x; });
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g, t + 0.02); env.gain.setValueAtTime(g, t + 0.16); env.gain.linearRampToValueAtTime(0, t + 0.19);
      env.gain.setValueAtTime(0, t + 0.3); env.gain.linearRampToValueAtTime(g, t + 0.32); env.gain.setValueAtTime(g, t + 0.68); env.gain.linearRampToValueAtTime(0, t + 0.72);
      track1(xs[0], [bp, pk, env, p, ...sx]);
    },
    ballhawks(t, o, g) { // Waveland/Sheffield ballhawks scramble: shouts + running footsteps on pavement
      const pan = clamp(o.pan ?? 0, -1, 1);
      if (has('shout')) for (let k = 0; k < 7; k++) playBuf(getBuf('shout'), t + k * 0.22 + rnd() * 0.3, { dest: N.amb, gain: g * (0.5 + 0.5 * rnd()), rate: 0.85 + rnd() * 0.25, pan: clamp(pan + (rnd() - 0.5) * 0.5, -1, 1), lp: 2400, verb: 0.35, city: 0.3 });
      const w = getBuf('white');
      for (let r = 0; r < 3; r++) { const iv = 0.28 + rnd() * 0.06, t0 = t + 0.1 + rnd() * 0.3; for (let k = 0; k < 9; k++) {
        const tt = t0 + k * iv + (rnd() - 0.5) * 0.03, a = g * 0.55 * (1 - k / 11);
        playBuf(w, tt, { dest: N.amb, gain: a, offset: rnd(), stop: tt + 0.035, lp: 900, pan: clamp(pan + (r - 1) * 0.2, -1, 1), verb: 0.25 });
        playBuf(w, tt, { dest: N.amb, gain: a * 0.4, offset: rnd(), stop: tt + 0.006, hp: 2500, pan: clamp(pan + (r - 1) * 0.2, -1, 1) });
      } }
    },
    wave_swell(t, o, g) { // "whoooOOOAAA" rolling section by section around the bowl, panned as it passes
      const dur = clamp(o.dur ?? 6, 3, 16), laps = clamp(Math.round(o.laps ?? 1), 1, 3), per = dur / laps, n = 9;
      const dir = (o.fromSpray ?? -20) <= 0 ? 1 : -1;
      holdCrowd(0.62, t + dur + 0.5);
      if (!has('whoa')) { roarBurst(t, g * 0.6, 0.7, { hold: dur * 0.8 }); return; }
      for (let l = 0; l < laps; l++) for (let k = 0; k < n; k++) {
        const u = k / (n - 1), tk = t + l * per + u * Math.max(0.5, per - 2.3), near = Math.sin(Math.PI * u);   // sections behind home are nearest the camera
        playBuf(getBuf('whoa'), tk, { dest: N.crowd, gain: g * (0.4 + 0.6 * near) * (l ? 0.85 : 1), rate: 0.94 + rnd() * 0.12, pan: dir * (-0.95 + 1.9 * u), lp: 2600 + 4500 * near, verb: 0.3 });
        if (has('clap') && rnd() < 0.8) playBuf(getBuf('clap'), tk + 0.9, { dest: N.crowd, gain: g * 0.05 * near, rate: 0.5 + rnd() * 0.2, pan: dir * (-0.95 + 1.9 * u), lp: 2500, verb: 0.2 }); // seats snapping up
      }
    },
    out_of_park(t, o, g) { // it's GONE — biggest roar of the night, slapping back off the buildings, then the street/lot reacts
      const park = o.park || o.parkId || S.park || 'wrigley', d = o.distance ?? 470, k = clamp((d - 400) / 80, 0.7, 1);
      const side = { street_l: -0.6, street_r: 0.6, rooftop: rnd() < 0.5 ? -0.5 : 0.5, over_cf: 0, out_of_park: 0, concourse: -0.3 }[o.bonus] ?? 0;
      const pan = o.spray != null && isFinite(+o.spray) ? clamp(+o.spray / 45, -1, 1) * 0.7 : side;
      stopOoh(t, 0.25);
      holdCrowd(1, t + 5.5);
      if (has('cheer')) for (let j = 0; j < 2; j++) playBuf(getBuf('cheer'), t + j * 0.16, { dest: N.crowd, gain: g * 0.75 * k, rate: 0.95 + 0.1 * rnd(), pan: j ? 0.35 : -0.35, verb: 0.3, city: 0.35 });
      roarBurst(t, g * 1.1, k, { hold: 2.6, city: 0.45 });
      for (let j = 0; j < 8; j++) whistle(t + 0.4 + rnd() * 3.2, 1);
      applause(t + 1.6, 4.5, 1);
      duck(t, 0.35, 1.0);
      if (park === 'wrigley') {
        if (has('cheer')) playBuf(getBuf('cheer'), t + 0.45, { dest: N.amb, gain: g * 0.45, rate: 1.06, pan, lp: 2000, verb: 0.4, city: 0.3 }); // rooftop decks erupt
        SFX.ballhawks(t + 1.0 + rnd() * 0.4, { pan }, lvl('ballhawks'));
        if (d > 440 || rnd() < 0.6) SFX.car_alarm(t + 1.5 + rnd() * 0.6, { pan }, lvl('car_alarm'));
        SFX.car_horn(t + 2.4 + rnd() * 0.8, { pan: pan * 0.8 }, lvl('car_horn'));
      } else {
        SFX.siren(t + 0.15, {}, lvl('siren'));
        SFX.fireworks(t + 0.3, { n: 8, barrage: true }, lvl('fireworks'));
        SFX.pinwheels(t + 0.1, {}, lvl('pinwheels'));
      }
    },
    pinwheels(t, o, g) { const b = getBuf('pinwheels', false); if (b) playBuf(b, t, { gain: g, verb: 0.35, city: 0.12, pan: o.pan ?? 0 }); },
    ballpark_bell(t, o, g) { // the bell by the Fan Deck, rung n times (1–4)
      const b = getBuf('bell', false); if (!b) return; const n = clamp(Math.round(o.n ?? 4), 1, 4);
      const h = playBuf(b, t, { gain: g, pan: o.pan ?? 0.12, lp: 4500, verb: 0.45, echo: 0.15 });
      if (h && n < 4) { const te = t + 0.02 + n * 0.54 - 0.03; h.g.gain.setValueAtTime(g, te); h.g.gain.setTargetAtTime(0, te, 0.35); }   // damp it by hand before the next strike
    },
    streak(t, o, g) { // power-up arpeggio + shimmer + a cheer that grows with the streak
      const n = clamp(o.n ?? 2, 2, 6), steps = [0, 4, 7, 12, 16, 19, 24];
      for (let k = 0; k < n + 1; k++) playBuf(getBuf('ding'), t + k * 0.075, { gain: g * (0.55 + 0.1 * k), rate: Math.pow(2, (steps[k] - 5) / 12), pan: -0.6 + 1.2 * k / n, verb: 0.3 });
      const hp = BF('highpass', 6500), env = G(0); const s = noiseSrc(t, t + 0.9, hp); chain(hp, env, N.sfx); sends(env, 0.3, 0);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 0.35, t + 0.25); env.gain.setTargetAtTime(0, t + 0.3, 0.15); track1(s, [hp, env]);
      if (has('cheer')) playBuf(getBuf('cheer'), t + 0.05, { dest: N.crowd, gain: g * (0.9 + 0.25 * n), rate: 1.04 + 0.02 * n, verb: 0.2 });
    },
    record(t, o, g) { // NEW RECORD: low boom + two-octave pentatonic sparkle + chord
      playBuf(getBuf('kick'), t, { gain: g * 0.7, rate: 1.15, verb: 0.3 }); playBuf(getBuf('snare'), t, { gain: g * 0.5, rate: 0.8, verb: 0.4 });
      const pent = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
      pent.forEach((s, k) => playBuf(getBuf('ding'), t + 0.03 + k * 0.042, { gain: g * (0.35 + 0.05 * k), rate: Math.pow(2, (s - 9) / 12), pan: -0.8 + 1.6 * k / pent.length, verb: 0.35 }));
      [12, 16, 19].forEach(s => playBuf(getBuf('ding'), t + 0.55, { gain: g * 0.7, rate: Math.pow(2, (s - 9) / 12), verb: 0.4 }));
    },
    out(t, o, g) { // two-note muted-brass "wah-wah" (generic, not a tune)
      [[nm('G3'), 0, 0.26], [nm('D3'), 0.3, 0.46]].forEach(([m, dt, d]) => {
        const t0 = t + dt, lp = BF('lowpass', 300, 5), env = G(0); chain(lp, env, N.sfx); sends(env, 0.15, 0);
        const os = [-8, 8].map(det => { const x = osc('sawtooth', mtof(m), t0, t0 + d + 0.2, lp); x.detune.value = det; if (dt) x.frequency.setTargetAtTime(mtof(m) * 0.94, t0 + d * 0.6, 0.12); return x; });
        lp.frequency.setValueAtTime(320, t0); lp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.09); lp.frequency.exponentialRampToValueAtTime(600, t0 + d);
        env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(g * 0.5, t0 + 0.03); env.gain.setValueAtTime(g * 0.5, t0 + d - 0.05); env.gain.linearRampToValueAtTime(0, t0 + d + 0.06);
        track1(os[0], [lp, env]);
      });
    },
    ui_tap(t, o, g) { playBuf(getBuf('ui_tap'), t, { gain: g, rate: o.rate || 1 }); },
    ui_back(t, o, g) { playBuf(getBuf('ui_back'), t, { gain: g }); },
    ui_confirm(t, o, g) { playBuf(getBuf('ui_confirm'), t, { gain: g, verb: 0.1 }); },
    countdown(t, o, g) { const go = o.final || o.n === 0; playBuf(getBuf(go ? 'beep_go' : 'beep'), t, { gain: g * (go ? 1.1 : 1), verb: 0.12 }); },
    ding(t, o, g) { playBuf(getBuf('ding'), t, { gain: g, rate: o.rate || 1, verb: 0.2 }); },
  };

  // ---------------------------------------------------------------- voice clips (booth / PA announcer)
  function decode(ab) {
    return new Promise(res => {
      let done = false; const ok = b => { if (!done) { done = true; res(b || null); } }, bad = () => ok(null);
      try { const p = ctx.decodeAudioData(ab, ok, bad); if (p && p.then) p.then(ok, bad); } catch (e) { bad(); }
    });
  }
  function getClip(key) { // → Promise<AudioBuffer|null>; decode once, cache
    if (key && typeof key === 'object') { // an AudioBuffer / ArrayBuffer handed over directly
      if (typeof key.getChannelData === 'function') return Promise.resolve(key);
      if (key instanceof ArrayBuffer) return decode(key.slice(0));
      return Promise.resolve(null);
    }
    if (S.clips[key]) return Promise.resolve(S.clips[key]);
    if (S.clipJobs[key]) return S.clipJobs[key];
    const A = S.assets || fallbackAssets;
    const job = (async () => {
      if (!A || !ctx) return null;
      let ab = null;
      try { ab = typeof A.buffer === 'function' ? A.buffer(key) : null; } catch (e) { ab = null; }
      if (!ab && typeof A.load === 'function') { try { await A.load(key); ab = A.buffer ? A.buffer(key) : null; } catch (e) { ab = null; } }
      if (ab && typeof ab.getChannelData === 'function') return (S.clips[key] = ab);
      if (!(ab instanceof ArrayBuffer) && !(ab && ab.buffer instanceof ArrayBuffer)) return null;
      const bytes = ab instanceof ArrayBuffer ? ab.slice(0) : ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength); // decode detaches → copy
      const b = await decode(bytes);
      if (b) S.clips[key] = b;
      return b;
    })().catch(() => null);
    S.clipJobs[key] = job; job.then(b => { if (!b) delete S.clipJobs[key]; });
    return job;
  }
  const CLIP_FX = { booth: { hp: 90, lp: 12000, pk: [3000, 2], verb: 0.04, echo: 0 }, pa: { hp: 180, lp: 6500, pk: [1600, 3], verb: 0.32, echo: 0.28 }, radio: { hp: 320, lp: 3600, pk: [1800, 4], verb: 0.02, echo: 0 }, dry: null };
  let fallbackAssets = null;
  async function playClip(key, o = {}) {
    if (o && o.assets && !S.assets) fallbackAssets = o.assets;
    if (!live()) return null;
    const buf = await getClip(key);
    if (!buf || !live() || S.muted) return null;
    const t = T() + Math.max(0, +o.delay || 0.02), dur = buf.duration, fx = CLIP_FX[o.fx || 'booth'];
    const src = ctx.createBufferSource(); src.buffer = buf; const g = G(o.gain ?? 1), extra = [g];
    let head = src;
    if (fx) {
      const c1 = comp(-22, 8, 3, 0.004, 0.12), f1 = BF('highpass', fx.hp, 0.7), f2 = BF('peaking', fx.pk[0], 1, fx.pk[1]), f3 = BF('lowpass', fx.lp, 0.7);
      chain(src, f1, f2, f3, c1); head = c1; extra.push(c1, f1, f2, f3);
    }
    head.connect(g); let tail = g;
    if (o.pan) { tail = panNode(o.pan); g.connect(tail); extra.push(tail); }
    tail.connect(N.voice); if (fx) extra.push(...sends(tail, fx.verb, fx.echo));
    if (o.duck !== false) { const dk = typeof o.duck === 'number' ? o.duck : 1; duck(t, dbg(-13 * dk), dur, dbg(-8 * dk)); }
    S.clipUntil = Math.max(S.clipUntil, t + dur);
    let endRes; const ended = new Promise(res => { endRes = res; });
    src.start(t); track1(src, extra); const prev = src.onended; src.onended = () => { prev && prev(); endRes(true); };
    return { key: typeof key === 'string' ? key : null, duration: dur, startAt: t, ended, stop: (fade = 0.1) => { try { setp(g.gain, 0, T(), fade / 3); src.stop(T() + fade + 0.05); } catch (e) { /* */ } } };
  }
  function prepareClip(key) { if (!ctx) return Promise.resolve(false); return getClip(key).then(b => !!b); }

  // ---------------------------------------------------------------- iOS: unlock + silent switch
  // WebAudio on iOS Safari follows the ring/silent switch unless the page's audio session is
  // "playback". Safari ≥16.4 exposes navigator.audioSession; older iOS needs a looping silent
  // <audio> element started inside the gesture. Only applied while sound is ON.
  const isIOS = () => { try { const n = navigator; return /iP(hone|ad|od)/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1); } catch (e) { return false; } };
  function audioSession(on) {
    if (offline) return;
    try {
      const as = typeof navigator !== 'undefined' ? navigator.audioSession : null;
      if (as) { const want = on ? 'playback' : 'auto'; if (as.type !== want) as.type = want; return; }
      if (!isIOS() || typeof document === 'undefined') return;
      if (on) {
        if (!S.silentEl) { const a = document.createElement('audio'); a.setAttribute('x-webkit-airplay', 'deny'); a.setAttribute('playsinline', ''); a.preload = 'auto'; a.loop = true; a.src = silentWavURI(); S.silentEl = a; }
        const p = S.silentEl.play(); p && p.catch && p.catch(NOOP);
      } else if (S.silentEl) S.silentEl.pause();
    } catch (e) { /* */ }
  }
  function onGesture() { // after unlock(): every later tap re-arms the context (iOS 'interrupted' / suspended states)
    if (!S.unlocked || !ctx || offline || S.muted || hidden()) return;
    if (ctx.state !== 'running') resume();
    if (S.silentEl && S.silentEl.paused) audioSession(true);
  }
  let gestureBound = false;
  function bindGestures() {
    if (gestureBound || offline || typeof W.addEventListener !== 'function') return; gestureBound = true;
    for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) W.addEventListener(ev, onGesture, { capture: true, passive: true });
  }

  // ---------------------------------------------------------------- public API
  function unlock() {
    if (!ctx) {
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return; } }
    }
    if (!S.built) build();
    if (!S.unlocked) {
      S.unlocked = true;
      const t = T();
      if (offline) pregenAllSync(); else startPregen();
      onPregen(pregenIdx >= PREGEN.length ? null : 'ir');
      try { const b = ctx.createBuffer(1, 1, ctx.sampleRate); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) { /* iOS unlock ping */ }
      setLeslie(false, t);
      if (S.park) setPark(S.park); else if (O.park) setPark(O.park);
      startBed(t);
      if (S.cue) { const c = S.cue; S.cue = null; music(c); }
      if (!offline && !S.timer) S.timer = setInterval(() => { try { tick(); } catch (e) { /* */ } }, TICK_MS);
      if (!offline && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVis);
        W.addEventListener && W.addEventListener('pageshow', onVis);
      }
      bindGestures();
    }
    if (!S.muted) audioSession(true);
    if (!offline && ctx.state !== 'running' && !S.muted && !hidden()) resume();
  }
  function resume() { S.resumeAt = Date.now(); try { const p = ctx.resume(); p && p.catch && p.catch(NOOP); } catch (e) { /* */ } }
  function onVis() {
    if (!ctx || offline) return;
    try {
      if (hidden()) { const p = ctx.suspend(); p && p.catch && p.catch(NOOP); if (S.silentEl) S.silentEl.pause(); }
      else if (S.unlocked && !S.muted) { resume(); if (S.silentEl) audioSession(true); }
    } catch (e) { /* */ }
  }
  function setMuted(b) {
    S.muted = !!b;
    if (!ctx || !S.built) return;
    const now = T(); setp(N.master.gain, S.muted ? 0 : 1, now, 0.03);
    if (offline) return;
    audioSession(!S.muted);
    clearTimeout(S.muteT);
    if (S.muted) S.muteT = setTimeout(() => { if (S.muted && ctx.state === 'running') { const p = ctx.suspend(); p && p.catch && p.catch(NOOP); } }, 250);
    else if (S.unlocked && !hidden()) resume();
  }
  function setMusicOn(b) {
    S.musicOn = !!b;
    if (!ctx || !S.built) return;
    const now = T(); for (const g of [N.musicGate, N.organGate]) setp(g.gain, S.musicOn ? 1 : 0, now, 0.08);
  }
  function setPark(parkId, o = {}) { // park acoustics + ambience layers; queues that park's buffers
    const p = PARK_FX[parkId] ? parkId : null; if (!p) return;
    S.park = p; if (o.wind != null && isFinite(+o.wind)) S.wind = +o.wind;
    queueJobs(PARK_JOBS[p]); if (!offline) startPregen(); else PARK_JOBS[p].forEach(([k, i]) => genData(k, i));
    if (!ctx || !S.built) return;
    const t = T(); setp(N.echo.delayTime, PARK_FX[p].echo, t, 0.05); setp(N.echoFb.gain, PARK_FX[p].fb, t, 0.05);
    if (S.bed) { bedLayers(t); if (p === 'wrigley') S.nextTrain = Math.min(S.nextTrain, t + 25 + rnd() * 20); }
  }
  function sfx(name, o) {
    o = o || {};
    const fn = SFX[name];
    if (!fn || !live() || S.muted) return;
    if (!offline && ctx.state !== 'running' && Date.now() - S.resumeAt > 1500) return; // (a resume is in flight → schedule anyway)
    const t = T() + Math.max(0, +o.delay || 0);
    if (!S.park && (o.park || o.parkId)) setPark(o.park || o.parkId);
    if (S.lastSfx[name] != null && Math.abs(t - S.lastSfx[name]) < 0.03) return; // retrigger guard
    if (S.voices > MAX_VOICES && !/^bat_|homer_horn|mitt|swing_whoosh|out_of_park|crowd_roar/.test(name)) return;
    fn(t, o, lvl(name) * (o.gain ?? 1));
    S.lastSfx[name] = t;
  }
  function setCrowd(level) {
    const L = clamp(+level || 0, 0, 1); S.crowd = L;
    if (live() && S.bed) applyCrowd(T());
  }
  function music(cue) {
    cue = cue || null;
    if (cue && !CUES[cue]) return;
    if (!live()) { S.cue = cue; return; }
    const now = T(), cur = S.musicTrk;
    if (cue && cur && !cur.stopped && cur.name === cue && (cur.def.loop || now < cur.end)) { S.cue = cue; return; }
    S.cue = cue;
    if (cur) stopTrack(cur, now, 0.45);
    S.musicTrk = null;
    if (cue !== 'batting' || (S.riff && S.riff.def.loop)) { stopRiff(now, 0.35); S.queuedRiff = null; }
    if (!cue) return;
    S.musicTrk = startTrack(CUES[cue], now + 0.06);
    tick(now);
  }
  function organ(riff) {
    if (!live()) return;
    const now = T();
    if (riff == null) { S.queuedRiff = null; stopRiff(now, 0.25); return; }
    const def = RIFFS[riff]; if (!def) return;
    const cur = S.riff && !S.riff.stopped && now < S.riff.end ? S.riff : null;
    if (def.loop && cur && cur.name === riff) return;                       // tension already running
    if (def.loop && cur && !cur.def.loop && cur.end - now > 0.15) { S.queuedRiff = riff; return; } // let a one-shot finish
    S.queuedRiff = null;
    stopRiff(now, 0.12);
    startRiff(def, now + 0.04);
    tick(now);
  }
  function update() { try { if (live()) tick(); } catch (e) { /* never throw from the frame loop */ } }
  function dispose() {
    pregenListeners.delete(onPregen);
    try { clearInterval(S.timer); S.timer = null; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); } catch (e) { /* */ }
    try { if (gestureBound) for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) W.removeEventListener(ev, onGesture, { capture: true }); } catch (e) { /* */ }
    try { if (S.silentEl) { S.silentEl.pause(); S.silentEl = null; } } catch (e) { /* */ }
    try { if (!O.context && ctx && ctx.close) ctx.close(); } catch (e) { /* */ }
  }
  const safe = fn => function (...a) { try { return fn.apply(null, a); } catch (e) { if (typeof console !== 'undefined') console.warn('[audio]', e); return undefined; } };
  const safeP = fn => function (...a) { try { return Promise.resolve(fn.apply(null, a)).catch(() => null); } catch (e) { return Promise.resolve(null); } };
  if (O.park) S.park = PARK_FX[O.park] ? O.park : null;
  const api = {
    unlock: safe(unlock), setMuted: safe(setMuted), setMusicOn: safe(setMusicOn), sfx: safe(sfx), setCrowd: safe(setCrowd),
    music: safe(music), organ: safe(organ), update: safe(update), dispose: safe(dispose),
    // v2
    setPark: safe(setPark), setAssets: safe(a => { S.assets = a || null; }), playClip: safeP(playClip), prepareClip: safeP(prepareClip),
    get muted() { return S.muted; }, get musicOn() { return S.musicOn; }, get context() { return ctx; }, get park() { return S.park; },
    get state() { return ctx ? ctx.state : 'none'; }, get unlocked() { return S.unlocked; }, ready,
    // ---- test / harness hooks (not part of the contract) ----
    _advance: safe(t => { S.vnow = t; tick(t); }),    // offline: move the virtual clock + run the scheduler
    get _nodes() { return N; }, get _state() { return S; },
  };
  return api;
}
