// ============================================================================
// WINDY CITY DERBY — src/audio.js   (owner: AUDIO)
// Procedural WebAudio only. No audio files, no network, no dependencies.
//
//   createAudio()                      → Audio (CONTRACT signature, context made on unlock())
//   createAudio({ context, ... })      → same API bound to an injected (Offline)AudioContext
//
// Graph:  voices → buses {sfx, crowd, music, organ}
//         music/organ → duck → musicOn gate ─┐
//         sends → stadium reverb (convolver) + PA slap-echo ─┤
//         mix → glue compressor → master(mute) → limiter → trim → safety soft-clip (≤ −0.6 dBFS) → out
// Music is driven ONLY by a lookahead scheduler (setInterval 25 ms, 120 ms ahead of
// ctx.currentTime). update(dt) merely nudges the same scheduler; nothing is timed off rAF.
// All riffs / cues are ORIGINAL compositions (see RIFFS / CUES below).
// ============================================================================

export const SFX_NAMES = ['bat_sweet', 'bat_solid', 'bat_weak', 'foul', 'whiff', 'mitt', 'pitch_whoosh', 'homer_horn',
  'fireworks', 'crowd_roar', 'crowd_groan', 'streak', 'record', 'out', 'ui_tap', 'ui_back', 'ui_confirm', 'countdown', 'ding'];
export const ORGAN_RIFFS = ['charge', 'walkup', 'homer', 'stretch', 'tension'];
export const MUSIC_CUES = ['title', 'batting', 'roundOver'];

const LOOKAHEAD = 0.12;      // s scheduled ahead of ctx.currentTime
const TICK_MS = 25;          // scheduler interval
const MAX_VOICES = 48;       // concurrent one-shot sfx sources
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dbg = db => Math.pow(10, db / 20);
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
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
    else { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; } // peak
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
// two-pole modal resonator, unit impulse response amplitude ≈ 1
function modal(f, tau, sr) { const r = Math.exp(-1 / (tau * sr)), w = TAU * Math.min(f, sr * 0.45) / sr; return { c1: 2 * r * Math.cos(w), c2: -r * r, g: Math.sin(w), y1: 0, y2: 0 }; }
function mrun(m, x) { const y = x + m.c1 * m.y1 + m.c2 * m.y2; m.y2 = m.y1; m.y1 = y; return y * m.g; }
function peakOf(...chs) { let p = 0; for (const a of chs) for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > p) p = v; } return p; }
function normalize(a, peak = 1) { const p = peakOf(a); if (p > 0) { const k = peak / p; for (let i = 0; i < a.length; i++) a[i] *= k; } return a; }
function normalize2(L, R, peak = 1) { const p = peakOf(L, R); if (p > 0) { const k = peak / p; for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; } } return [L, R]; }
function fadeEdges(a, inN = 0, outN = 0) {
  for (let i = 0; i < inN && i < a.length; i++) a[i] *= i / inN;
  for (let i = 0; i < outN && i < a.length; i++) a[a.length - 1 - i] *= i / outN;
  return a;
}
const panLR = p => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

// ---- BAT / contact family ---------------------------------------------------
// Three separately-normalised layers mixed with explicit weights:
//  crack: noise burst (instant attack, decay tau) band-limited hp..lp   → weight wc
//  knock: decaying sinusoid modes [Hz, amp, tau] (the wood)              → weight wk
//  thump: low pitch-dropping sine [startHz, endHz, tau]                  → weight wt
const CONTACT = {
  bat_sweet: { dur: 0.42, crack: [0.0038, 1000, 9500], wc: 0.54, click: 0.9, wk: 0.42, wt: 0.04, th: [300, 125, 0.018],
    modes: [[905, 0.45, 0.01], [1215, 0.8, 0.011], [1840, 0.8, 0.014], [2730, 1, 0.02], [3990, 0.6, 0.012], [5520, 0.35, 0.007], [2960, 0.22, 0.075]] },
  bat_solid: { dur: 0.42, crack: [0.0052, 700, 6800], wc: 0.45, click: 0.6, wk: 0.45, wt: 0.1, th: [270, 105, 0.024],
    modes: [[212, 0.35, 0.04], [645, 0.85, 0.028], [1290, 0.8, 0.022], [2160, 0.5, 0.015], [3150, 0.3, 0.01]] },
  bat_weak: { dur: 0.45, crack: [0.0075, 300, 2600], wc: 0.2, click: 0.3, wk: 0.6, wt: 0.2, th: [230, 85, 0.034],
    modes: [[158, 1, 0.07], [458, 0.85, 0.05], [1015, 0.45, 0.032], [1525, 0.45, 0.065], [2375, 0.2, 0.04]] },
  foul: { dur: 0.25, crack: [0.0014, 2600, 11000], wc: 0.7, click: 0.8, wk: 0.28, wt: 0.02, th: [210, 130, 0.01],
    modes: [[2260, 0.6, 0.014], [3390, 0.45, 0.009], [4720, 0.25, 0.006]] },
  mitt: { dur: 0.3, crack: [0.0055, 380, 5200], wc: 0.55, click: 0.5, wk: 0.35, wt: 0.1, th: [210, 80, 0.026],
    modes: [[312, 0.8, 0.02], [565, 0.65, 0.014], [995, 0.5, 0.009], [1720, 0.35, 0.006], [2600, 0.2, 0.004]] },
};
function genContact(sr, P, seed) {
  const r = mulberry(seed), n = Math.round(P.dur * sr);
  const crack = new Float32Array(n), knock = new Float32Array(n), thump = new Float32Array(n);
  const [ct, hp, lp] = P.crack, h1 = new BQ('hp', hp, 0.7, sr), h2 = new BQ('hp', hp, 0.7, sr), l1 = new BQ('lp', lp, 0.7, sr);
  const kc = Math.exp(-1 / (ct * sr)); let ec = 1;
  for (let i = 0; i < n; i++) { let e = (r() * 2 - 1) * ec; ec *= kc; if (i < 3) e += [1, -0.7, 0.25][i] * P.click; crack[i] = l1.run(h2.run(h1.run(e))); }
  for (const [f0, a, tau] of P.modes) {
    const w = TAU * f0 * (1 + (r() - 0.5) * 0.04) / sr, cw = Math.cos(w), sw = Math.sin(w), k = Math.exp(-1 / (tau * (0.9 + r() * 0.2) * sr));
    const p0 = r() * TAU; let c = Math.cos(p0), sn = Math.sin(p0), env = a, att = 0;
    for (let i = 0; i < n && env > 1e-5; i++) { const cc = c * cw - sn * sw; sn = sn * cw + c * sw; c = cc; att = att < 1 ? att + 1 / (0.0002 * sr) : 1; knock[i] += sn * env * att; env *= k; }
  }
  { const [f0, f1, tau] = P.th, kf = Math.exp(-1 / (0.01 * sr)), kt = Math.exp(-1 / (tau * sr)); let ph = 0, fe = 1, te = 1;
    for (let i = 0; i < n && te > 1e-5; i++) { ph += TAU * (f1 + (f0 - f1) * fe) / sr; fe *= kf; thump[i] = Math.sin(ph) * te * Math.min(1, i / (0.0006 * sr)); te *= kt; } }
  // balance by ENERGY share (wc/wk/wt), which is what loudness tracks — peak-normalising noise hides how thin it is
  const en = a => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return e || 1; };
  const gc = Math.sqrt(P.wc / en(crack)), gk = Math.sqrt(P.wk / en(knock)), gt = Math.sqrt(P.wt / en(thump));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = crack[i] * gc + knock[i] * gk + thump[i] * gt;
  fadeEdges(out, 0, Math.round(0.02 * sr));
  return normalize(out, 1);
}
function genKeyClick(sr, seed) { // tonewheel key-contact click
  const r = mulberry(seed), n = Math.round(0.014 * sr), out = new Float32Array(n);
  const bp = new BQ('bp', 2400 + r() * 1800, 0.9, sr);
  for (let i = 0; i < n; i++) { const t = i / sr; out[i] = bp.run((r() * 2 - 1) * Math.exp(-t / 0.0014)) + (i === 0 ? 0.4 : 0) + Math.sin(TAU * 95 * t) * Math.exp(-t / 0.004) * 0.15; }
  return normalize(fadeEdges(out, 0, 20), 1);
}
// ---- drums -------------------------------------------------------------------
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
function genClapBurst(sr, r, out, at, gain, pan, fc, stereo) { // one person's clap
  const bp = new BQ('bp', fc, 0.9, sr), hp = new BQ('hp', 600, 0.7, sr);
  const n = Math.round(0.07 * sr), [gl, gr] = panLR(pan), spikes = [0, 0.006 + r() * 0.004, 0.013 + r() * 0.005];
  for (let i = 0; i < n; i++) {
    const t = i / sr; let env = 0;
    for (const s of spikes) if (t >= s) env += Math.exp(-(t - s) / 0.0035) * (s ? 0.7 : 1);
    env += Math.exp(-t / 0.028) * 0.35;
    const v = hp.run(bp.run(r() * 2 - 1)) * env * gain, k = at + i;
    if (k >= out[0].length) break;
    out[0][k] += v * gl; if (stereo) out[1][k] += v * gr;
  }
}
function genClap(sr, seed) { const r = mulberry(seed), a = new Float32Array(Math.round(0.2 * sr)); genClapBurst(sr, r, [a], 0, 1, 0, 1250, false); return normalize(a, 1); }
function genCrowdClap(sr, seed, people = 30) {
  const r = mulberry(seed), n = Math.round(0.34 * sr), L = new Float32Array(n), R = new Float32Array(n);
  for (let p = 0; p < people; p++) {
    const j = Math.max(0, Math.round((0.03 + (r() + r() + r() - 1.5) * 0.028) * sr));
    genClapBurst(sr, r, [L, R], j, 0.35 + r() * 0.65, r() * 2 - 1, 800 + r() * 1700, true);
  }
  return normalize2(L, R, 1);
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
// ---- voices (formant synthesis) for crowd babble / cheers / groans ---------------
const GLOT = (() => { const t = new Float32Array(1025); for (let i = 0; i <= 1024; i++) { const ph = i / 1024; t[i] = ph < 0.4 ? 0.5 * (1 - Math.cos(Math.PI * ph / 0.4)) : ph < 0.56 ? Math.cos(Math.PI * (ph - 0.4) / 0.32) : 0; } return t; })();
const VOW = { a: [760, 1150, 2500], o: [560, 880, 2450], u: [330, 880, 2300], e: [540, 1850, 2550], i: [300, 2250, 3000], ae: [680, 1700, 2450], uh: [540, 1220, 2420] };
function genGrain(sr, s, r) {
  const n = Math.max(32, Math.round(s.dur * sr)), out = new Float32Array(n);
  const bw = s.bw || [95, 120, 170], co = new Float64Array(9), st = new Float64Array(6);
  const v0 = VOW[s.v0], v1 = VOW[s.v1 || s.v0];
  let ph = r(), gPrev = 0, jit = 0, vibv = 0;
  const att = s.att || 0.03, rel = s.rel || 0.06;
  for (let i = 0; i < n; i++) {
    const t = i / sr, u = i / n;
    if ((i & 31) === 0) {
      const k = u * u * (3 - 2 * u);
      for (let j = 0; j < 3; j++) {
        const F = Math.min((v0[j] + (v1[j] - v0[j]) * k) * s.fs, sr * 0.45), B = bw[j];
        const C = -Math.exp(-TAU * B / sr), Bc = 2 * Math.exp(-Math.PI * B / sr) * Math.cos(TAU * F / sr);
        co[j * 3] = 1 - Bc - C; co[j * 3 + 1] = Bc; co[j * 3 + 2] = C;
      }
      jit = (jit + (r() - 0.5) * 0.02) * 0.97;
    }
    const f0 = ((1 - u) * (1 - u) * s.f0[0] + 2 * u * (1 - u) * s.f0[1] + u * u * s.f0[2]) *
      (1 + jit + (s.vib && (i & 7) === 0 ? (vibv = s.vib[1] * Math.sin(TAU * s.vib[0] * t)) : vibv));
    ph += f0 / sr; if (ph >= 1) ph -= 1;
    const gp = ph * 1024, gi = gp | 0, g = GLOT[gi] + (GLOT[gi + 1] - GLOT[gi]) * (gp - gi);
    let x = (g - gPrev) * sr / f0 * 0.25 + (r() * 2 - 1) * s.breath * (0.35 + g); gPrev = g;
    for (let j = 0; j < 3; j++) { const y = co[j * 3] * x + co[j * 3 + 1] * st[j * 2] + co[j * 3 + 2] * st[j * 2 + 1]; st[j * 2 + 1] = st[j * 2]; st[j * 2] = y; x = y; }
    out[i] = x * Math.min(1, t / att) * Math.min(1, (s.dur - t) / rel);
  }
  return normalize(out, 1);
}
const GRAIN_SR = 22050;
function makeGrains(kind, seed) {
  const r = mulberry(seed), vs = Object.keys(VOW), out = [];
  const pick = a => a[Math.floor(r() * a.length)];
  if (kind === 'talk') for (let k = 0; k < 22; k++) {
    const fem = r() < 0.45, f = (fem ? 185 : 102) * (0.85 + r() * 0.35);
    out.push(genGrain(GRAIN_SR, { dur: 0.09 + r() * 0.2, v0: pick(vs), v1: pick(vs), fs: fem ? 1.17 : 1, f0: [f * (1 + (r() - 0.5) * 0.2), f * (1 + (r() - 0.3) * 0.2), f * (0.85 + r() * 0.2)], breath: 0.12 + r() * 0.2, att: 0.02, rel: 0.05 }, r));
  }
  if (kind === 'cheer') for (let k = 0; k < 12; k++) {
    const fem = r() < 0.4, f = (fem ? 330 : 230) * (0.9 + r() * 0.3), woo = k % 4 === 3;
    out.push(genGrain(GRAIN_SR, woo
      ? { dur: 0.9 + r() * 0.6, v0: 'u', v1: 'o', fs: fem ? 1.15 : 1.02, f0: [f * 0.85, f * 1.45, f * 1.25], vib: [5.5 + r() * 2, 0.025], breath: 0.4, att: 0.08, rel: 0.3, bw: [120, 150, 200] }
      : { dur: 0.8 + r() * 0.8, v0: pick(['a', 'ae', 'e', 'a']), v1: pick(['a', 'o', 'a']), fs: (fem ? 1.18 : 1.05) * (1 + r() * 0.08), f0: [f, f * (1.1 + r() * 0.15), f * 0.9], vib: [5 + r() * 2, 0.02 + r() * 0.02], breath: 0.45 + r() * 0.25, att: 0.06, rel: 0.35, bw: [130, 160, 220] }, r));
  }
  if (kind === 'hey') for (let k = 0; k < 8; k++) {
    const fem = r() < 0.4, f = (fem ? 350 : 250) * (0.9 + r() * 0.25);
    out.push(genGrain(GRAIN_SR, { dur: 0.22 + r() * 0.1, v0: 'e', v1: 'i', fs: fem ? 1.15 : 1.02, f0: [f * 1.05, f * 1.08, f * 0.8], breath: 0.5, att: 0.012, rel: 0.09, bw: [130, 160, 220] }, r));
  }
  if (kind === 'groan') for (let k = 0; k < 10; k++) {
    const fem = r() < 0.4, f = (fem ? 260 : 175) * (0.9 + r() * 0.25);
    out.push(genGrain(GRAIN_SR, { dur: 0.9 + r() * 0.6, v0: pick(['a', 'o']), v1: pick(['o', 'u']), fs: fem ? 1.12 : 1, f0: [f * 1.1, f * 0.95, f * 0.7], vib: [4.5, 0.015], breath: 0.35, att: 0.1, rel: 0.4 }, r));
  }
  return out;
}
function mixGrains(sr, n, grains, r, inst, { wrap = false } = {}) {
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const it of inst) {
    const g = grains[it.g % grains.length], rate = it.rate, len = Math.floor((g.length - 1) / rate);
    const [gl, gr] = panLR(it.pan); const a = 1 - Math.exp(-TAU * it.lp / sr); let y = 0;
    for (let j = 0; j < len; j++) {
      const sp = j * rate, i0 = sp | 0, fr = sp - i0; y += a * (g[i0] * (1 - fr) + g[i0 + 1] * fr - y);
      let k = it.at + j; if (k >= n) { if (!wrap) break; k %= n; }
      L[k] += y * it.gain * gl; R[k] += y * it.gain * gr;
    }
  }
  return [L, R];
}
function genBabble(dur, grains, seed, voices = 24) { // seamless loop of distant crowd conversation
  const r = mulberry(seed), sr = GRAIN_SR, n = Math.round(dur * sr), inst = [];
  for (let v = 0; v < voices; v++) {
    const dist = r(), pan = r() * 2 - 1, rate = 0.86 + r() * 0.36, gain = 0.2 + 0.8 * Math.pow(1 - dist, 1.5), lp = 900 + 4200 * (1 - dist);
    let pos = Math.floor(r() * n), total = 0;
    while (total < n) {
      const g = Math.floor(r() * grains.length), len = Math.floor(grains[g].length / rate);
      inst.push({ g, rate, pan, lp, gain: gain * (0.6 + 0.4 * r()), at: pos });
      let gap = len + Math.floor(sr * (0.015 + r() * 0.07)); if (r() < 0.2) gap += Math.floor(sr * (0.25 + r()));
      pos = (pos + gap) % n; total += gap;
    }
  }
  return normalize2(...mixGrains(sr, n, grains, r, inst, { wrap: true }), 0.9);
}
function genShoutMix(dur, grains, seed, count, spread, late = 0) { // cheer / hey / groan crowd layers
  const r = mulberry(seed), sr = GRAIN_SR, n = Math.round(dur * sr), inst = [];
  for (let k = 0; k < count; k++) {
    const isLate = r() < late, dist = r();
    inst.push({ g: Math.floor(r() * 1e6), rate: 0.88 + r() * 0.3, pan: r() * 2 - 1, lp: 1500 + 5500 * (1 - dist), gain: (0.3 + 0.7 * (1 - dist)) * (isLate ? 0.55 : 1),
      at: Math.floor(sr * (isLate ? spread + r() * dur * 0.45 : Math.max(0, (r() + r()) * 0.5 * spread))) });
  }
  const [L, R] = mixGrains(sr, n, grains, r, inst);
  fadeEdges(L, 0, Math.round(0.2 * sr)); fadeEdges(R, 0, Math.round(0.2 * sr));
  return normalize2(L, R, 0.95);
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
  { let y = 0; const h = new BQ('hp', 900, 0.7, sr); let ph = 0; // boom
    const k1 = Math.exp(-1 / (0.09 * sr)), k2 = Math.exp(-1 / (0.05 * sr)), k3 = Math.exp(-1 / (0.45 * sr)), k4 = Math.exp(-1 / (0.002 * sr)), k5 = Math.exp(-1 / (0.22 * sr)), k6 = Math.exp(-1 / (0.02 * sr));
    let e1 = 1, e2 = 1, e3 = 1, e4 = 1, e5 = 1, e6 = 1; const nb = Math.min(n - ib, Math.round(2.2 * sr)); const mid = new BQ('peak', 320, 0.9, sr, 9);
    for (let i = 0; i < nb; i++) {
      y += Math.min(1, TAU * (110 + 1400 * e1) / sr) * ((r() * 2 - 1) - y);
      ph += TAU * (42 + 30 * e2) / sr;
      const v = (mid.run(y) * 2.2 * e3 * (1 - e4) + Math.sin(ph) * 0.3 * e5 + (e6 > 1e-4 ? h.run(r() * 2 - 1) * e6 * 0.9 : 0)) * 0.9;
      L[ib + i] += v * gl; R[ib + i] += v * gr;
      e1 *= k1; e2 *= k2; e3 *= k3; e4 *= k4; e5 *= k5; e6 *= k6;
    } }
  { let t = 0.2; // glitter crackle
    while (t < 2.1) {
      t += -Math.log(1 - r()) / (95 * Math.exp(-t / 0.7) + 7);
      const a = (0.25 + 0.9 * r()) * Math.exp(-t / 1.25), len = 3 + Math.floor(r() * 8), pp = clamp(p + (r() - 0.5) * 1.2, -1, 1), k0 = ib + Math.round(t * sr);
      const cl = Math.cos((pp + 1) * Math.PI / 4), cr = Math.sin((pp + 1) * Math.PI / 4);
      let prev = 0; for (let j = 0; j < len && k0 + j < n; j++) { const v = r() * 2 - 1, x = (v - prev) * a * Math.exp(-j / (len * 0.4)); L[k0 + j] += x * cl; R[k0 + j] += x * cr; prev = v; }
    } }
  fadeEdges(L, 0, 2000); fadeEdges(R, 0, 2000);
  return normalize2(L, R, 1);
}
// ---- stadium reverb impulse response (stereo) ----------------------------------------
function genIR(sr, seed, dur = 2.4) {
  const r = mulberry(seed), n = Math.round(dur * sr), out = [];
  const taps = [[0.011, 0.55], [0.017, 0.45], [0.026, 0.4], [0.039, 0.35], [0.056, 0.3], [0.083, 0.22], [0.19, 0.3], [0.31, 0.18], [0.46, 0.1]];
  for (let c = 0; c < 2; c++) {
    const a = new Float32Array(n); let y = 0, k = 0, dec = 1; const kd = Math.exp(-6.9 / (dur * 0.92 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 63) === 0) k = 1 - Math.exp(-TAU * (380 + 4200 * Math.exp(-t / 0.45)) / sr);
      y += k * ((r() * 2 - 1) - y);
      a[i] = y * dec * Math.min(1, Math.max(0, (t - 0.018) / 0.03)) * 0.5; dec *= kd;
    }
    for (const [tt, g] of taps) { const k0 = Math.round((tt * (1 + (c ? 0.07 : -0.05))) * sr); for (let j = 0; j < 24; j++) if (k0 + j < n) a[k0 + j] += g * (r() * 2 - 1) * Math.exp(-j / 6); }
    out.push(fadeEdges(a, 0, 400));
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

export const _dsp = { BQ, genContact, CONTACT, genKick, genSnare, genHat, genCymbal, genClap, genCrowdClap, genPink, genWhite,
  genGrain, makeGrains, genBabble, genShoutMix, genShell, genIR, genAdd, genKeyClick, BELL, mulberry };

// ============================================================================
// ORGAN — tonewheel drawbar registrations (16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1')
// Harmonic of the 16' sub-fundamental for each drawbar:
// ============================================================================
const DRAWBAR_H = [1, 3, 2, 4, 6, 8, 10, 12, 16];
const REG = {
  lead:  { bars: [8, 8, 8, 6, 0, 0, 0, 0, 5], perc: 3, percLevel: 0.75, percTau: 0.16, click: 0.3, level: 0.26 },
  full:  { bars: [8, 8, 8, 8, 6, 6, 4, 5, 6], perc: 0, click: 0.25, level: 0.22 },
  comp:  { bars: [6, 8, 8, 5, 0, 0, 0, 0, 3], perc: 0, click: 0.22, level: 0.2 },
  soft:  { bars: [0, 0, 8, 6, 0, 3, 0, 0, 0], perc: 2, percLevel: 0.45, percTau: 0.22, click: 0.12, level: 0.27 },
  flute: { bars: [0, 0, 8, 4, 0, 3, 0, 0, 0], perc: 2, percLevel: 0.35, percTau: 0.3, click: 0.1, level: 0.24 },
  bass:  { bars: [0, 0, 7, 8, 5, 3, 0, 0, 0], perc: 0, click: 0.3, level: 0.34, decay: [0.22, 0.55] },
};
function waveCoefs(reg, seed) {
  const r = mulberry(seed), re = new Float32Array(17), im = new Float32Array(17); let ss = 0;
  reg.bars.forEach((lv, j) => { if (!lv) return; const a = Math.pow(10, (lv - 8) * 3 / 20), k = DRAWBAR_H[j], p = r() * TAU; re[k] += a * Math.sin(p); im[k] += a * Math.cos(p); ss += a * a; });
  const s = 0.5 / Math.sqrt(ss / 2 || 1); // RMS-normalise every registration to 0.5
  for (let k = 0; k < 17; k++) { re[k] *= s; im[k] *= s; }
  return [re, im];
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

// ---- ORGAN RIFFS ----
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
};
const CUES = { title: TITLE, batting: BATTING, roundOver: ROUNDOVER };
export const _score = { RIFFS, CUES, REG, seq, nm };

// ============================================================================
// SAMPLE DATA — generated in pure JS (no AudioContext needed), cached at module
// level and shared by every createAudio() instance. Generation starts in idle
// slices as soon as createAudio() runs (before the unlock gesture), so unlock()
// only wraps ready-made Float32Arrays into AudioBuffers.
// Each job: key → list of variant generators returning channel arrays.
// ============================================================================
const GEN_SR = 48000;
const GRAINS = {};
const grainsOf = kind => GRAINS[kind] || (GRAINS[kind] = makeGrains(kind, { talk: 11, cheer: 12, hey: 13, groan: 14 }[kind]));
const V = (n, fn) => Array.from({ length: n }, (_, k) => () => fn(k + 1));
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
  bat_sweet: V(3, s => [genContact(GEN_SR, CONTACT.bat_sweet, 100 + s)]),
  bat_solid: V(3, s => [genContact(GEN_SR, CONTACT.bat_solid, 200 + s)]),
  bat_weak: V(2, s => [genContact(GEN_SR, CONTACT.bat_weak, 300 + s)]),
  foul: V(2, s => [genContact(GEN_SR, CONTACT.foul, 400 + s)]),
  mitt: V(3, s => [genContact(GEN_SR, CONTACT.mitt, 500 + s)]),
  pink: V(1, () => genPink(GEN_SR, 3, 920)),
  g_talk: V(1, () => (grainsOf('talk'), [])), g_cheer: V(1, () => (grainsOf('cheer'), [])), g_hey: V(1, () => (grainsOf('hey'), [])), g_groan: V(1, () => (grainsOf('groan'), [])),
  babble: V(1, () => genBabble(6, grainsOf('talk'), 930, 20)),
  crash: V(1, () => genCymbal(GEN_SR, 900, 2.5, false)),
  ohat: V(1, () => [genHat(GEN_SR, 810, true)]),
  rcym: V(1, () => genCymbal(GEN_SR, 901, 1.2, true)),
  ir: V(1, () => genIR(GEN_SR, 980, 2.4)),
  cclap: V(3, s => genCrowdClap(GEN_SR, 910 + s)),
  cheer: V(2, s => genShoutMix(3.6, grainsOf('cheer'), 940 + s, 44, 0.35, 0.3)),
  hey: V(1, () => genShoutMix(0.8, grainsOf('hey'), 950, 34, 0.05)),
  groan: V(1, () => genShoutMix(2.8, grainsOf('groan'), 960, 36, 0.25, 0.15)),
  clap: V(1, () => [genClap(GEN_SR, 820)]),
  shout: V(12, k => [[...grainsOf('cheer'), ...grainsOf('hey')][(k * 7) % 20]]),
  shell: V(4, s => genShell(32000, 970 + s, s === 2)),
};
const JOB_SR = { babble: GRAIN_SR, cheer: GRAIN_SR, hey: GRAIN_SR, groan: GRAIN_SR, shout: GRAIN_SR, shell: 32000 };
// priority order for idle pre-generation: [key, variantIndex]
const PREGEN = [
  ...['click', 'kick', 'snare', 'hat', 'white', 'ui_tap', 'ui_back', 'ui_confirm', 'beep', 'beep_go', 'ding'].flatMap(k => JOBS[k].map((_, i) => [k, i])),
  ['bat_sweet', 0], ['bat_solid', 0], ['bat_weak', 0], ['foul', 0], ['mitt', 0], ['pink', 0], ['g_talk', 0], ['babble', 0], ['crash', 0], ['ohat', 0], ['rcym', 0],
  ['ir', 0], ['cclap', 0], ['g_cheer', 0], ['cheer', 0], ['g_groan', 0], ['groan', 0], ['g_hey', 0], ['hey', 0], ['clap', 0], ['shell', 0], ['shell', 1],
  ...['bat_sweet', 'bat_solid', 'bat_weak', 'foul', 'mitt', 'cclap', 'cheer', 'shout', 'shell'].flatMap(k => JOBS[k].map((_, i) => [k, i]).filter(([, i]) => i > (k === 'shell' ? 1 : 0) || k === 'shout')),
];
const DATA = {};           // key → [variant channel-arrays] (sparse while generating)
const IR_BY_RATE = {};
const dataReady = new Set();
function genData(key, i) {
  const d = DATA[key] || (DATA[key] = []);
  if (!d[i]) { try { d[i] = JOBS[key][i](); } catch (e) { d[i] = null; if (typeof console !== 'undefined') console.warn('[audio] gen failed', key, e); } }
  if (JOBS[key].every((_, k) => d[k] !== undefined)) dataReady.add(key);
  return d[i];
}
let pregenIdx = 0, pregenRunning = false;
const pregenListeners = new Set();
function schedIdle(fn) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.requestIdleCallback) g.requestIdleCallback(fn, { timeout: 120 }); else setTimeout(fn, 8);
}
function pregenStep() {
  const t0 = Date.now();
  const emit = (k, i) => pregenListeners.forEach(f => { try { f(k, i); } catch (e) { /* a listener must never stop generation */ } });
  while (pregenIdx < PREGEN.length && Date.now() - t0 < 12) { const [k, i] = PREGEN[pregenIdx++]; genData(k, i); emit(k, i); }
  if (pregenIdx < PREGEN.length) schedIdle(pregenStep); else { pregenRunning = false; emit(null, -1); }
}
function startPregen() { if (pregenRunning || pregenIdx >= PREGEN.length || typeof setTimeout === 'undefined') return; pregenRunning = true; schedIdle(pregenStep); }
export const _data = { get JOBS() { return JOBS; }, get PREGEN() { return PREGEN; }, get DATA() { return DATA; }, genData: (k, i) => genData(k, i) };
function pregenAllSync() { while (pregenIdx < PREGEN.length) { const [k, i] = PREGEN[pregenIdx++]; genData(k, i); } }

// ============================================================================
// ENGINE
// ============================================================================
const SFX_DB = { // mix levels (dB) at the sfx/crowd bus
  bat_sweet: 0, bat_solid: -2, bat_weak: -4, foul: -7, whiff: -9, mitt: -4, pitch_whoosh: -11, homer_horn: -5, fireworks: -3,
  crowd_roar: -1, crowd_groan: -3, streak: -7, record: -7, out: -9, ui_tap: -15, ui_back: -15, ui_confirm: -13, countdown: -12, ding: -11,
};
const warp = (b, sw) => { if (sw === 0.5) return b; const k = Math.floor(b), f = b - k; return k + (f < 0.5 ? f * sw / 0.5 : sw + (f - 0.5) * (1 - sw) / 0.5); };
function clipCurve(ceil = 0.94, knee = 0.8, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); c[i] = Math.sign(x) * (a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee))); }
  return c;
}
function driveCurve(k = 1.6, n = 2048) { const c = new Float32Array(n), d = Math.tanh(k); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / d; } return c; }

const NOOP = () => {};

/**
 * createAudio(opts?) → Audio
 *  opts.context   inject an AudioContext / OfflineAudioContext (tests). Omit in the game: the
 *                 context is created lazily inside unlock() (a user gesture).
 *  opts.bed       false = no continuous crowd bed (isolated renders)       (default true)
 *  opts.connect   false = do not connect the output to ctx.destination    (default true)
 *  opts.seed      RNG seed for the runtime randomness                      (default random)
 */
export function createAudio(opts = {}) {
  const O = Object.assign({ context: null, bed: true, connect: true, seed: (Math.random() * 2 ** 31) | 0 }, opts || {});
  const W = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  const AC = W.AudioContext || W.webkitAudioContext || null;
  const OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext || null;
  let ctx = O.context || null;
  const offline = !!(ctx && OAC && ctx instanceof OAC);
  const S = {
    unlocked: false, built: false, muted: false, musicOn: true, crowd: 0.25, crowdApplied: -1,
    cue: null, musicTrk: null, riff: null, riffUntil: 0, queuedRiff: null, tracks: [],
    buf: {}, waves: {}, voices: 0, lastSfx: {}, vnow: null, timer: null, bed: null, resumeAt: -1e9,
    nextEvt: 0, clapRunUntil: 0, rng: mulberry(O.seed), readyResolve: null, lastPick: {},
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

  // ---------------------------------------------------------------- helpers
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const BF = (type, f, q = 0.707, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (gain) b.gain.value = gain; return b; };
  const chain = (...ns) => { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; };
  function setp(param, v, t, tau) {
    try {
      if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
      else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
      if (tau) param.setTargetAtTime(v, t, tau); else param.setValueAtTime(v, t);
    } catch (e) { try { param.value = v; } catch (e2) { /* ignore */ } }
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
  function sends(node, verb, echo) {
    const out = [];
    if (verb) { const s = G(verb); node.connect(s); s.connect(N.verbIn); out.push(s); }
    if (echo) { const s = G(echo); node.connect(s); s.connect(N.echoIn); out.push(s); }
    return out;
  }
  function playBuf(buf, t, o = {}) {
    if (!buf) return null;
    const src = ctx.createBufferSource(); src.buffer = buf;
    if (o.rate && o.rate !== 1) src.playbackRate.value = o.rate;
    if (o.loop) src.loop = true;
    const g = G(o.gain ?? 1); src.connect(g);
    let tail = g; const extra = [g];
    if (o.pan) { tail = panNode(o.pan); g.connect(tail); extra.push(tail); }
    tail.connect(o.dest || N.sfx);
    extra.push(...sends(tail, o.verb, o.echo));
    src.start(Math.max(0, t), o.offset || 0);
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
  function wrap(key, i, sync) {
    const bl = S.buf[key] || (S.buf[key] = []);
    if (bl[i]) return bl[i];
    const d = DATA[key] && DATA[key][i] !== undefined ? DATA[key][i] : sync ? genData(key, i) : undefined;
    if (!d) return null;
    try { bl[i] = mkBuf(d, JOB_SR[key] || GEN_SR); } catch (e) { return null; }
    return bl[i];
  }
  function has(key) { return !!(DATA[key] && DATA[key].some(Boolean)); }
  function getBuf(key, sync = true) { // random ready variant (avoids immediate repeats); sync-generates variant 0 if nothing exists yet
    const n = JOBS[key].length, ready = [];
    for (let i = 0; i < n; i++) if (DATA[key] && DATA[key][i]) ready.push(i);
    if (!ready.length) { const b = sync ? wrap(key, 0, true) : null; return b; }
    let k = ready[Math.floor(rnd() * ready.length)];
    if (ready.length > 1 && k === S.lastPick[key]) k = ready[(ready.indexOf(k) + 1) % ready.length];
    S.lastPick[key] = k; return wrap(key, k, false);
  }
  function setIR() { // ConvolverNode needs a buffer at the context's own sample rate
    if (!N.verb || N.verb.buffer) return;
    const rate = ctx.sampleRate;
    const d = rate === GEN_SR && has('ir') ? DATA.ir[0] : (IR_BY_RATE[rate] || (IR_BY_RATE[rate] = genIR(rate, 980, 2.4)));
    try { N.verb.buffer = mkBuf(d, rate); } catch (e) { if (typeof console !== 'undefined') console.warn('[audio] reverb IR', e); }
  }
  function onPregen(key) {
    if (!S.built) return;
    if (key === 'ir' || key === null) setIR();
    if (S.bedPending && has('pink') && has('babble')) startBed(T());
    if (key === null) { S.readyResolve && S.readyResolve(true); S.readyResolve = null; pregenListeners.delete(onPregen); }
  }

  // ---------------------------------------------------------------- graph
  function build() {
    const c = ctx;
    N.mix = G(1);
    N.glue = c.createDynamicsCompressor();
    Object.entries({ threshold: -16, knee: 12, ratio: 2, attack: 0.012, release: 0.25 }).forEach(([k, v]) => { N.glue[k].value = v; });
    N.master = G(S.muted ? 0 : 1);
    N.limiter = c.createDynamicsCompressor();
    Object.entries({ threshold: -6, knee: 0, ratio: 20, attack: 0.001, release: 0.09 }).forEach(([k, v]) => { N.limiter[k].value = v; });
    N.trim = G(dbg(-2));
    N.clip = c.createWaveShaper(); N.clip.curve = clipCurve(); N.clip.oversample = 'none';
    N.sub = BF('highpass', 32, 0.6);
    chain(N.mix, N.sub, N.glue, N.master, N.limiter, N.trim, N.clip);
    N.out = N.clip; N.preClip = N.trim;
    if (O.connect !== false) N.clip.connect(c.destination);
    // stadium reverb + PA slap echo
    N.verbIn = G(1); N.verb = c.createConvolver(); N.verbRet = G(dbg(-3));
    chain(N.verbIn, BF('highpass', 170), N.verb, BF('lowpass', 5200, 0.6), BF('peaking', 450, 0.9, 2), N.verbRet, N.mix);
    N.echoIn = G(1); N.echo = c.createDelay(1); N.echo.delayTime.value = 0.27;
    const eh = BF('highpass', 300), el = BF('lowpass', 2600), fb = G(0.24); N.echoRet = G(0.3);
    chain(N.echoIn, eh, N.echo, el, fb, N.echo); el.connect(N.echoRet); N.echoRet.connect(N.mix);
    // buses
    N.sfx = G(1); N.crowd = G(dbg(-2)); N.music = G(dbg(-3)); N.organ = G(dbg(-1));
    N.sfx.connect(N.mix); N.crowd.connect(N.mix); sends(N.crowd, 0.1, 0);
    N.musicDuck = G(1); N.organDuck = G(1); N.musicGate = G(S.musicOn ? 1 : 0); N.organGate = G(S.musicOn ? 1 : 0);
    chain(N.music, BF('highpass', 48, 0.6), N.musicDuck, N.musicGate, N.mix); chain(N.organ, N.organDuck, N.organGate, N.mix);
    sends(N.musicGate, 0.16, 0); sends(N.organGate, 0.45, 0.2);
    buildOrgan();
    S.built = true;
  }
  function buildOrgan() {
    const c = ctx;
    for (const k of Object.keys(REG)) { const [re, im] = waveCoefs(REG[k], 1000 + k.length * 7); S.waves[k] = c.createPeriodicWave(re, im, { disableNormalization: true }); }
    S.waves.cos = c.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true });
    S.waves.sin = c.createPeriodicWave(new Float32Array([0, 0]), new Float32Array([0, 1]), { disableNormalization: true });
    N.organIn = G(1);
    // "C3" scanner-chorus: modulated short delay blended with dry
    const dry = G(0.78), wet = G(0.34), cd = c.createDelay(0.02); cd.delayTime.value = 0.0035;
    const cl = c.createOscillator(); cl.frequency.value = 6.8; const cdep = G(0.0005); chain(cl, cdep, cd.delayTime); cl.start();
    const pre = G(1.1); N.organIn.connect(dry); dry.connect(pre); chain(N.organIn, cd, wet, pre);
    // tube-ish overdrive
    const drive = c.createWaveShaper(); drive.curve = driveCurve(1.6); drive.oversample = '2x';
    const post = G(0.62); chain(pre, drive, post);
    // rotary speaker: crossover 800 Hz → horn (bright, deep AM/doppler) + drum (warm, subtle)
    const out = G(1);
    const rotor = (speed) => { const oc = c.createOscillator(), os = c.createOscillator(); oc.setPeriodicWave(S.waves.cos); os.setPeriodicWave(S.waves.sin); oc.frequency.value = speed; os.frequency.value = speed; oc.start(); os.start(); return { oc, os }; };
    const stage = (src, spd, dly, dDepth, am, amDepth, panDepth) => {
      const r = rotor(spd), d = c.createDelay(0.02); d.delayTime.value = dly;
      const a = G(am), p = panNode(0);
      chain(src, d, a, p, out);
      chain(r.oc, G(dDepth), d.delayTime); chain(r.oc, G(amDepth), a.gain);
      if (p.pan) chain(r.os, G(panDepth), p.pan);
      return r;
    };
    const lo = chain(post, BF('lowpass', 800), BF('lowpass', 800)), hi = chain(post, BF('highpass', 800), BF('highpass', 800));
    N.horn = stage(hi, 0.8, 0.0024, 0.00075, 0.7, 0.3, 0.8);
    N.drum = stage(lo, 0.67, 0.0016, 0.00025, 0.87, 0.13, -0.3);
    N.leslieFast = false;
    chain(out, BF('highpass', 85, 0.6), BF('lowpass', 7800, 0.6), N.organ);
  }
  function setLeslie(fast, t) {
    if (!N.horn) return;
    N.leslieFast = fast;
    const H = fast ? [6.7, 0.35] : [0.8, 0.55], D = fast ? [5.8, 1.2] : [0.67, 1.9];
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
      last = osc(null, mtof(m) / 2, t0, stop, g, wave);
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
  function crowdClap(t, v) { if (!has('cclap')) return; playBuf(getBuf('cclap'), t, { dest: N.crowd, gain: v * 0.55, rate: 0.96 + rnd() * 0.08, verb: 0.12 }); }
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

  // ---------------------------------------------------------------- crowd bed
  function startBed(t) {
    if (!O.bed || S.bed || !live()) return;
    if (!has('pink') || !has('babble')) { S.bedPending = true; return; }
    const pink = getBuf('pink'), bab = getBuf('babble');
    S.bedPending = false;
    const B = S.bed = {};
    B.roarG = G(0); B.roarLP = BF('lowpass', 800, 0.5); B.roarPk = BF('peaking', 1150, 0.8, 4);
    B.roarSrc = ctx.createBufferSource(); B.roarSrc.buffer = pink; B.roarSrc.loop = true;
    chain(B.roarSrc, BF('highpass', 120), B.roarLP, B.roarPk, B.roarG, N.crowd);
    B.murG = G(0); B.murSrc = ctx.createBufferSource(); B.murSrc.buffer = bab; B.murSrc.loop = true;
    chain(B.murSrc, BF('highpass', 170), BF('peaking', 2600, 0.7, -3), B.murG, N.crowd);
    B.l1 = ctx.createOscillator(); B.l1.frequency.value = 0.085; B.l1g = G(0); chain(B.l1, B.l1g, B.roarG.gain);
    B.l2 = ctx.createOscillator(); B.l2.frequency.value = 0.21; B.l2g = G(0); chain(B.l2, B.l2g, B.murG.gain);
    const t0 = Math.max(0, t);
    B.roarSrc.start(t0, rnd() * 3); B.murSrc.start(t0, rnd() * 5); B.l1.start(t0); B.l2.start(t0);
    S.crowdApplied = -1; applyCrowd(t0, 0.6);
    S.nextEvt = t0 + 0.5 + rnd();
  }
  function applyCrowd(t, tauOverride) {
    const B = S.bed; if (!B) return;
    const L = S.crowd, up = L >= S.crowdApplied, tau = tauOverride ?? (up ? 0.12 : 0.9);
    const roar = 0.03 + 0.08 * L + 0.62 * L * L, mur = 0.34 + 0.26 * L;
    setp(B.roarG.gain, roar, t, tau); setp(B.l1g.gain, roar * 0.2, t, tau);
    setp(B.murG.gain, mur, t, tau); setp(B.l2g.gain, mur * 0.12, t, tau);
    setp(B.roarLP.frequency, 650 + 3300 * L, t, tau);
    setp(B.murSrc.playbackRate, 1 + 0.09 * L, t, tau * 1.5);
    S.crowdApplied = L;
  }
  function crowdEvents(now, horizon) {
    if (S.nextEvt < now - 0.5) S.nextEvt = now + rnd();
    while (S.nextEvt < horizon) {
      const t = S.nextEvt, L = S.crowd, r = rnd();
      S.nextEvt += -Math.log(1 - rnd() * 0.999) / (0.12 + 0.9 * L * L);
      if (S.muted) continue;
      if (r < 0.45 && has('shout')) {
        playBuf(getBuf('shout'), t, { dest: N.crowd, gain: (0.05 + 0.13 * L) * (0.4 + 0.6 * rnd()), rate: 0.9 + rnd() * 0.25, pan: rnd() * 1.8 - 0.9, verb: 0.3 });
      } else if (r < 0.72) {
        whistle(t, 0.025 + 0.05 * L, rnd() * 1.6 - 0.8);
      } else if (L > 0.4 && t > S.clapRunUntil && has('cclap') && !S.riff) {
        const n = 6 + Math.floor(rnd() * 7), iv = 0.4 + rnd() * 0.08;
        for (let k = 0; k < n; k++) crowdClap(t + k * iv, 0.25 + 0.35 * (k / n) * L);
        S.clapRunUntil = t + n * iv + 2;
      }
    }
  }
  function whistle(t, gain, pan) {
    const f = 2300 + rnd() * 900, dur = 0.25 + rnd() * 0.45, two = rnd() < 0.35;
    const g = G(0), p = panNode(pan); chain(g, p, N.crowd); sends(p, 0.35, 0);
    const o = osc('sine', f * 0.94, t, t + dur + (two ? dur + 0.12 : 0) + 0.1, g);
    o.frequency.linearRampToValueAtTime(f, t + 0.08);
    const env = (t0, d) => { g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.03); g.gain.setValueAtTime(gain, t0 + d - 0.05); g.gain.linearRampToValueAtTime(0, t0 + d); };
    env(t, dur); if (two) { o.frequency.setValueAtTime(f * 0.97, t + dur + 0.12); o.frequency.linearRampToValueAtTime(f * 1.03, t + 2 * dur + 0.12); env(t + dur + 0.12, dur); }
    track1(o, [g, p]);
  }

  // ---------------------------------------------------------------- SFX
  const noiseSrc = (t, stop, dest, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = getBuf('white'); s.loop = true; s.playbackRate.value = rate; s.connect(dest); s.start(t, rnd()); s.stop(stop); return s; };
  function duck(t, depth, hold) {
    for (const d of [N.musicDuck, N.organDuck]) { setp(d.gain, depth, t, 0.02); d.gain.setTargetAtTime(1, t + hold, 0.25); }
  }
  const SFX = {
    bat_sweet(t, o, g) { playBuf(getBuf('bat_sweet'), t, { gain: g, rate: 0.98 + rnd() * 0.04, pan: o.pan, verb: 0.2, echo: 0.24 }); duck(t, 0.45, 0.4); },
    bat_solid(t, o, g) { playBuf(getBuf('bat_solid'), t, { gain: g, rate: 0.97 + rnd() * 0.05, pan: o.pan, verb: 0.18, echo: 0.2 }); duck(t, 0.6, 0.3); },
    bat_weak(t, o, g) { playBuf(getBuf('bat_weak'), t, { gain: g, rate: 0.96 + rnd() * 0.06, pan: o.pan, verb: 0.15, echo: 0.18 }); },
    foul(t, o, g) { playBuf(getBuf('foul'), t, { gain: g, rate: 0.97 + rnd() * 0.06, pan: o.pan, verb: 0.15, echo: 0.2 }); },
    mitt(t, o, g) { playBuf(getBuf('mitt'), t, { gain: g, rate: 0.96 + rnd() * 0.08, pan: o.pan ?? 0.05, verb: 0.16, echo: 0.3 }); },
    whiff(t, o, g) { // bat swoosh: swept band-passed noise, travelling across the stereo field
      const dur = 0.3, bp = BF('bandpass', 500, 1.3), env = G(0), p = panNode(o.pan ?? -0.4), stop = t + dur + 0.05;
      const s = noiseSrc(t, stop, bp); chain(bp, env, p, N.sfx); sends(p, 0.12, 0);
      bp.frequency.setValueAtTime(420, t); bp.frequency.exponentialRampToValueAtTime(2300, t + 0.11); bp.frequency.exponentialRampToValueAtTime(650, t + dur);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 2.2, t + 0.1); env.gain.setTargetAtTime(0, t + 0.12, 0.05);
      if (p.pan) { p.pan.setValueAtTime((o.pan ?? -0.5), t); p.pan.linearRampToValueAtTime(-(o.pan ?? -0.5), t + dur); }
      track1(s, [bp, env, p]);
    },
    pitch_whoosh(t, o, g) { // release "fwip" + ball hiss growing as it approaches the catcher-cam
      const dur = clamp(o.dur ?? 0.72, 0.3, 1.6), stop = t + dur + 0.12;
      const bp = BF('bandpass', 700, 2.2), env = G(0), p = panNode(-0.12);
      const s = noiseSrc(t, stop, bp); chain(bp, env, p, N.sfx);
      bp.frequency.setValueAtTime(650, t); bp.frequency.exponentialRampToValueAtTime(1500, t + dur);
      env.gain.setValueAtTime(0.0001, t); env.gain.exponentialRampToValueAtTime(g * 0.25, t + dur * 0.55); env.gain.exponentialRampToValueAtTime(g * 1.8, t + dur * 0.97); env.gain.linearRampToValueAtTime(0, t + dur + 0.1);
      if (p.pan) p.pan.linearRampToValueAtTime(0.05, t + dur);
      const fb = BF('highpass', 1400), fe = G(0); const f = noiseSrc(t, t + 0.08, fb, 0.8); chain(fb, fe, N.sfx);
      fe.gain.setValueAtTime(g * 0.3, t); fe.gain.setTargetAtTime(0, t + 0.005, 0.015);
      track1(s, [bp, env, p]); track1(f, [fb, fe]);
      duck(t, 0.55, dur + 0.2);
    },
    homer_horn(t, o, g) { // stadium air-horn chord: detuned saw stacks → buzz → horn-bell resonances
      const dur = o.dur ?? 2.1, stop = t + dur + 0.6;
      const sum = G(1), sh = ctx.createWaveShaper(); sh.curve = driveCurve(2.4); sh.oversample = '2x';
      const env = G(0), out = G(g * 0.9);
      chain(sum, BF('highpass', 110), sh, BF('peaking', 520, 1.1, 4), BF('peaking', 1500, 1.2, 6), BF('peaking', 2400, 1.4, 4), BF('lowpass', 6500, 0.7), env, out, N.sfx);
      sends(out, 0.5, 0.28);
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
      const nb = BF('bandpass', 1800, 0.8), ne = G(0); const nz = noiseSrc(t, t + 0.4, nb); chain(nb, ne, env); // breath at onset
      ne.gain.setValueAtTime(0.5, t); ne.gain.setTargetAtTime(0, t + 0.01, 0.07);
      track1(oscs[0], [sum, sh, env, out]); track1(nz, [nb, ne]);
      duck(t, 0.5, dur);
    },
    fireworks(t, o, g) { // o.n shells (default 3), staggered like a real volley
      const n = clamp(o.n ?? 3, 1, 6);
      for (let k = 0; k < n; k++) playBuf(getBuf('shell'), t + k * 0.42 + (k ? rnd() * 0.18 : 0), { gain: g * (k ? 0.8 + rnd() * 0.2 : 1), pan: (rnd() - 0.5) * 0.6, verb: 0.45, echo: 0.2 });
    },
    crowd_roar(t, o, g) { // shouted-vowel crowd + broadband roar swell
      const k = (o.intensity ?? 1);
      playBuf(getBuf('cheer'), t, { dest: N.crowd, gain: g * 0.95 * k, rate: 0.98 + rnd() * 0.05, verb: 0.2 });
      playBuf(getBuf('cheer'), t + 0.12, { dest: N.crowd, gain: g * 0.6 * k, rate: 1.06 + rnd() * 0.05, pan: 0.3, verb: 0.2 });
      const src = ctx.createBufferSource(); src.buffer = getBuf('pink'); src.loop = true;
      const bp = BF('bandpass', 1300, 0.55), lp = BF('lowpass', 1200), env = G(0);
      chain(src, bp, lp, env, N.crowd);
      lp.frequency.setValueAtTime(900, t); lp.frequency.linearRampToValueAtTime(5200, t + 0.35); lp.frequency.setTargetAtTime(1600, t + 1.6, 0.9);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 1.5 * k, t + 0.3); env.gain.setValueAtTime(g * 1.4 * k, t + 1.4); env.gain.setTargetAtTime(0, t + 1.4, 0.9);
      src.start(t, rnd() * 3); src.stop(t + 5.5); track1(src, [bp, lp, env]);
    },
    crowd_groan(t, o, g) {
      playBuf(getBuf('groan'), t, { dest: N.crowd, gain: g, rate: 0.97 + rnd() * 0.05, verb: 0.2 });
      const src = ctx.createBufferSource(); src.buffer = getBuf('pink'); src.loop = true;
      const lp = BF('lowpass', 1300, 0.7), env = G(0); chain(src, BF('highpass', 180), lp, env, N.crowd);
      lp.frequency.setValueAtTime(1400, t); lp.frequency.exponentialRampToValueAtTime(420, t + 1.4);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g * 0.7, t + 0.15); env.gain.setTargetAtTime(0, t + 0.3, 0.5);
      src.start(t, rnd() * 3); src.stop(t + 3); track1(src, [lp, env]);
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
      startBed(t);
      if (S.cue) { const c = S.cue; S.cue = null; music(c); }
      if (!offline && !S.timer) S.timer = setInterval(() => { try { tick(); } catch (e) { /* */ } }, TICK_MS);
      if (!offline && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVis);
        W.addEventListener && W.addEventListener('pageshow', onVis);
      }
    }
    if (!offline && ctx.state !== 'running' && !S.muted && !hidden()) resume();
  }
  function resume() { S.resumeAt = Date.now(); try { const p = ctx.resume(); p && p.catch && p.catch(NOOP); } catch (e) { /* */ } }
  function onVis() {
    if (!ctx || offline) return;
    try {
      if (hidden()) { const p = ctx.suspend(); p && p.catch && p.catch(NOOP); }
      else if (S.unlocked && !S.muted) resume();
    } catch (e) { /* */ }
  }
  function setMuted(b) {
    S.muted = !!b;
    if (!ctx || !S.built) return;
    const now = T(); setp(N.master.gain, S.muted ? 0 : 1, now, 0.03);
    if (offline) return;
    clearTimeout(S.muteT);
    if (S.muted) S.muteT = setTimeout(() => { if (S.muted && ctx.state === 'running') { const p = ctx.suspend(); p && p.catch && p.catch(NOOP); } }, 250);
    else if (S.unlocked && !hidden()) resume();
  }
  function setMusicOn(b) {
    S.musicOn = !!b;
    if (!ctx || !S.built) return;
    const now = T(); for (const g of [N.musicGate, N.organGate]) setp(g.gain, S.musicOn ? 1 : 0, now, 0.08);
  }
  function sfx(name, o) {
    o = o || {};
    const fn = SFX[name];
    if (!fn || !live() || S.muted) return;
    if (!offline && ctx.state !== 'running' && Date.now() - S.resumeAt > 1500) return; // (a resume is in flight → schedule anyway)
    const t = T() + Math.max(0, +o.delay || 0);
    if (S.lastSfx[name] != null && Math.abs(t - S.lastSfx[name]) < 0.03) return; // retrigger guard
    if (S.voices > MAX_VOICES && !/^bat_|homer_horn|mitt/.test(name)) return;
    S.lastSfx[name] = t;
    fn(t, o, dbg(SFX_DB[name] ?? -6) * (o.gain ?? 1));
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
  function update() { try { if (live()) { if (S.bedPending && has('pink') && has('babble')) startBed(T()); tick(); } } catch (e) { /* never throw from the frame loop */ } }
  function dispose() {
    pregenListeners.delete(onPregen);
    try { clearInterval(S.timer); S.timer = null; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); } catch (e) { /* */ }
    try { if (!O.context && ctx && ctx.close) ctx.close(); } catch (e) { /* */ }
  }
  const safe = fn => function (...a) { try { return fn.apply(null, a); } catch (e) { if (typeof console !== 'undefined') console.warn('[audio]', e); return undefined; } };
  const api = {
    unlock: safe(unlock), setMuted: safe(setMuted), setMusicOn: safe(setMusicOn), sfx: safe(sfx), setCrowd: safe(setCrowd),
    music: safe(music), organ: safe(organ), update: safe(update), dispose: safe(dispose),
    get muted() { return S.muted; }, get musicOn() { return S.musicOn; }, get context() { return ctx; },
    get state() { return ctx ? ctx.state : 'none'; }, get unlocked() { return S.unlocked; }, ready,
    // ---- test / harness hooks (not part of the contract) ----
    _advance: safe(t => { S.vnow = t; tick(t); }),    // offline: move the virtual clock + run the scheduler
    get _nodes() { return N; }, get _state() { return S; },
  };
  return api;
}
