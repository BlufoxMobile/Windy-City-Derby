// ============================================================================
// WINDY CITY DERBY — renderer, broadcast-grade post, quality tiers, watchdog.
// Owner: CINEMA (v2). Contract API (CONTRACT.md) unchanged:
//   createRenderer(canvas, { quality:'high'|'medium'|'low', adaptive=true }) → R
//   R: { renderer, render(scene, camera), resize(cssW, cssH), setQuality(tier), quality,
//        dispose(), beginFrame(dtSeconds) }
// v2 extras (all optional — call with ?.):
//   R.setGrade({ parkId, timeOfDay, weather })  per-look colour grade + bloom (eases over ~0.8 s)
//   R.pulse({ flash, aberr })                   one-shot impact punch (white pop / lens fringe), decays
//   R.post                                      live shared cinema state (camera.js `cinemaPost`):
//                                               letterbox / slowmo / flash / aberr — the director drives it
//   R.onQualityChange(tier, prev, reason)       R.stats  R.adaptive
//
// Pipeline per tier
//   high   scene → 4× MSAA HalfFloat RT → dual-filter bloom (½ res, 5 mips) → FINAL
//          (exposure + white balance + ACES + lift/gamma/gain + split tone + contrast/sat +
//           vignette + grain + letterbox + impact flash/fringe) → screen.      DPR ≤ 2
//   medium scene → HalfFloat RT (no MSAA) → bloom (¼ res, 4 mips) → FINAL with built-in FXAA.  DPR ≤ 1.5
//   low    direct render, ACES + per-look exposure only (cheapest possible).  DPR 1
// Post never throws the game: any GL failure falls back to direct rendering.
// ============================================================================
import * as THREE from 'three';
import { cinemaPost } from './camera.js';

const TIERS = ['low', 'medium', 'high'];
const DOWN = { high: 'medium', medium: 'low', low: 'low' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// Looks. Display-space grade applied AFTER ACES (like a LUT) so park artists'
// lighting keeps its intent; exposure/white balance are applied before ACES.
// ---------------------------------------------------------------------------
const BASE = {
  exposure: 1.0, wb: [1, 1, 1], contrast: 1.04, sat: 1.06, vibrance: 0.10,
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  shadowTint: [0.5, 0.5, 0.5], highTint: [0.5, 0.5, 0.5], split: 0.0,
  vignette: 0.22, bloom: 0.16, threshold: 1.05, knee: 0.5, radius: 0.72, grain: 0.018,
};
const LOOKS = {
  day:   { exposure: 1.0,  wb: [1.02, 1.0, 0.97], contrast: 1.07, sat: 1.07, vibrance: 0.14, lift: [0.0, 0.004, 0.014], gain: [1.02, 1.0, 0.98],
           shadowTint: [0.44, 0.5, 0.58], highTint: [0.56, 0.52, 0.46], split: 0.10, vignette: 0.2, bloom: 0.12, threshold: 1.25, knee: 0.45, radius: 0.62 },
  dusk:  { exposure: 1.06, wb: [1.05, 0.99, 0.93], contrast: 1.08, sat: 1.1, vibrance: 0.16, lift: [0.004, 0.006, 0.02], gain: [1.04, 0.99, 0.95],
           shadowTint: [0.4, 0.5, 0.62], highTint: [0.62, 0.52, 0.4], split: 0.24, vignette: 0.3, bloom: 0.3, threshold: 0.92, knee: 0.55, radius: 0.75 },
  night: { exposure: 1.1,  wb: [0.98, 1.0, 1.04], contrast: 1.1, sat: 1.06, vibrance: 0.12, lift: [0.002, 0.006, 0.022], gamma: [1.0, 1.0, 0.98], gain: [1.0, 1.0, 1.02],
           shadowTint: [0.4, 0.48, 0.64], highTint: [0.56, 0.52, 0.46], split: 0.2, vignette: 0.34, bloom: 0.5, threshold: 0.78, knee: 0.6, radius: 0.82 },
};
const WEATHER = {
  clear: {}, heat: { wb: [1.04, 1.0, 0.94], sat: 0.02, lift: [0.01, 0.008, 0.0], bloom: 0.04 },
  overcast: { sat: -0.12, contrast: -0.04, vibrance: -0.06, wb: [0.98, 1.0, 1.03], bloom: 0.02 },
  drizzle: { sat: -0.16, contrast: -0.05, vibrance: -0.06, wb: [0.97, 1.0, 1.04], bloom: 0.08, threshold: -0.08, vignette: 0.04 },
};
const PARKLOOK = {   // Wrigley: warm vintage / Rate: cooler modern broadcast
  wrigley: { wb: [1.012, 1.0, 0.985], gain: [1.01, 1.0, 0.99] },
  rate: { wb: [0.99, 1.0, 1.015], contrast: 0.02 },
};
function buildLook({ parkId = 'wrigley', timeOfDay = 'day', weather = 'clear' } = {}) {
  const L = JSON.parse(JSON.stringify(BASE));
  const merge = (o, add) => {
    if (!o) return;
    for (const k in o) {
      const v = o[k];
      if (Array.isArray(v)) L[k] = add ? L[k].map((x, i) => (k === 'lift' ? x + v[i] : x * v[i])) : v.slice();
      else L[k] = add ? L[k] + v : v;
    }
  };
  merge(LOOKS[timeOfDay] || LOOKS.day, false);
  merge(WEATHER[weather], true);
  merge(PARKLOOK[parkId], true);
  return L;
}
const SCALARS = ['exposure', 'contrast', 'sat', 'vibrance', 'split', 'vignette', 'bloom', 'threshold', 'knee', 'radius', 'grain'];
const VECS = ['wb', 'lift', 'gamma', 'gain', 'shadowTint', 'highTint'];

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
const VS = /* glsl */`
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// 13-tap "COD:AW" downsample; PREFILTER = soft-knee threshold + Karis average (kills fireflies).
const DOWN_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // 1 / source size
uniform vec4 uThresh;     // threshold, threshold - knee, 2*knee, 0.25/knee
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
#ifdef PREFILTER
vec3 pf(vec3 c) {
  c = min(c, vec3(64.0));
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThresh.y, 0.0, uThresh.z);
  rq = uThresh.w * rq * rq;
  return c * max(rq, br - uThresh.x) / max(br, 1e-4);
}
vec3 kw(vec3 a, vec3 b, vec3 c, vec3 d) {     // Karis-weighted 4-tap group
  a = pf(a); b = pf(b); c = pf(c); d = pf(d);
  float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
#endif
void main() {
  vec3 A = tap(vec2(-1.0, -1.0)), B = tap(vec2(0.0, -1.0)), C = tap(vec2(1.0, -1.0));
  vec3 D = tap(vec2(-0.5, -0.5)), E = tap(vec2(0.5, -0.5));
  vec3 F = tap(vec2(-1.0, 0.0)), G = tap(vec2(0.0, 0.0)), H = tap(vec2(1.0, 0.0));
  vec3 I = tap(vec2(-0.5, 0.5)), J = tap(vec2(0.5, 0.5));
  vec3 K = tap(vec2(-1.0, 1.0)), L = tap(vec2(0.0, 1.0)), M = tap(vec2(1.0, 1.0));
#ifdef PREFILTER
  vec3 c = kw(D, E, I, J) * 0.5 + (kw(A, B, F, G) + kw(B, C, G, H) + kw(F, G, K, L) + kw(G, H, L, M)) * 0.125;
#else
  vec3 c = (D + E + I + J) * 0.125 + (A + C + K + M) * 0.03125 + (B + F + H + L) * 0.0625 + G * 0.125;
#endif
  gl_FragColor = vec4(c, 1.0);
}`;

// 3×3 tent upsample, blended additively onto the next-larger mip.
const UP_FS = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 c = tap(vec2(0.0)) * 4.0
    + (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0
    + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(c * (uWeight / 16.0), 1.0);
}`;

const FINAL_FS = /* glsl */`
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uTexel;        // 1 / scene size
uniform float uAspect;
uniform float uBloom;
uniform vec3 uWB;
uniform float uContrast, uSat, uVibrance, uSplit, uVignette, uGrain, uTime;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint;
uniform float uLetterbox, uFlash, uAberr, uSlowmo;
varying vec2 vUv;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hdr(vec2 uv) { return texture2D(tScene, uv).rgb; }
float hl(vec2 uv) { float l = luma(hdr(uv)); return l / (1.0 + l); }   // perceptual-ish luma for edge detection
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main() {
  vec2 uv = vUv;
  vec3 c;
#ifdef FXAA
  { // FXAA (console-style): 4 diagonal luma taps, 2+2 taps along the edge
    float lNW = hl(uv + vec2(-1.0, -1.0) * uTexel), lNE = hl(uv + vec2(1.0, -1.0) * uTexel);
    float lSW = hl(uv + vec2(-1.0, 1.0) * uTexel), lSE = hl(uv + vec2(1.0, 1.0) * uTexel);
    vec3 cM = hdr(uv); float lM = luma(cM); lM = lM / (1.0 + lM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
    dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
    if (lMax - lMin < max(0.04, lMax * 0.125)) c = cM;
    else {
      vec3 a = 0.5 * (hdr(uv + dir * (1.0 / 3.0 - 0.5)) + hdr(uv + dir * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (hdr(uv - dir * 0.5) + hdr(uv + dir * 0.5));
      float lb = luma(b); lb = lb / (1.0 + lb);
      c = (lb < lMin || lb > lMax) ? a : b;
    }
  }
#else
  c = hdr(uv);
#endif
  // lens fringe on impacts (radial chromatic aberration), only while uAberr > 0
  if (uAberr > 0.001) {
    vec2 d = (uv - 0.5) * uAberr * 0.012;
    c.r = hdr(uv + d).r; c.b = hdr(uv - d).b;
  }
#ifdef BLOOM
  c += texture2D(tBloom, uv).rgb * uBloom;
#endif
  c *= uWB;
  c = ACESFilmicToneMapping(c);                     // includes toneMappingExposure
  c = sRGBTransferOETF(vec4(clamp(c, 0.0, 1.0), 1.0)).rgb;   // → display space: grade like a LUT
  // lift / gamma / gain
  c = pow(max(uGain * (c + uLift * (1.0 - c)), vec3(0.0)), 1.0 / uGamma);
  // split toning (shadows ← cool, highlights ← warm), luminance-preserving overlay
  float l = luma(c);
  vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.1, 0.9, l));
  vec3 ov = mix(2.0 * c * tint, 1.0 - 2.0 * (1.0 - c) * (1.0 - tint), step(0.5, c));
  c = mix(c, ov, uSplit);
  // contrast (S-curve around 0.5) + saturation + vibrance (protects already-saturated colours)
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  l = luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float vib = uVibrance * (1.0 - (mx - mn));
  c = mix(vec3(l), c, uSat * (1.0 + vib) * (1.0 - 0.35 * uSlowmo));
  c = mix(c, c * vec3(0.96, 1.0, 1.06), 0.35 * uSlowmo);                    // replay: cooler, calmer
  // vignette (aspect-correct, soft)
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0) * 2.0;
  float v = 1.0 - uVignette * smoothstep(0.35, 1.45, dot(q, q));
  c *= v;
  // impact flash
  c = mix(c, vec3(1.0, 0.98, 0.94), clamp(uFlash, 0.0, 1.0) * 0.55);
#ifdef GRAIN
  c += (hash(uv * 911.0 + fract(uTime * 7.13)) - 0.5) * uGrain;
#endif
  // letterbox bars (cinematic moments)
  if (uLetterbox > 0.0005) {
    float e = abs(uv.y - 0.5) * 2.0, edge = 1.0 - uLetterbox;
    c *= 1.0 - smoothstep(edge - 0.004, edge + 0.002, e);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------
export function createRenderer(canvas, { quality = 'high', adaptive = true } = {}) {
  let tier = TIERS.includes(quality) ? quality : 'high';

  let renderer;
  const base = { canvas, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance' };
  try { renderer = new THREE.WebGLRenderer({ ...base, antialias: tier !== 'low' }); }
  catch (e) { console.warn('[render] retry without MSAA', e); renderer = new THREE.WebGLRenderer({ ...base, antialias: false }); }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;

  let cssW = Math.max(1, canvas.clientWidth || (typeof innerWidth !== 'undefined' ? innerWidth : 390) || 390);
  let cssH = Math.max(1, canvas.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 844) || 844);
  let refreshMaterials = false;

  const dprFor = t => {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    return t === 'high' ? Math.min(dpr, 2) : t === 'medium' ? Math.min(dpr, 1.5) : 1;
  };

  // -------------------------------------------------------------- grade state
  let lookKey = '', lookAuto = true;
  const target = buildLook({});
  const cur = JSON.parse(JSON.stringify(target));
  let lookBlend = 1;           // ≥1 → settled
  const lookFrom = JSON.parse(JSON.stringify(target));
  function setGrade(o = {}, instant = false) {
    const key = `${o.parkId || 'wrigley'}|${o.timeOfDay || 'day'}|${o.weather || 'clear'}`;
    if (!o.__auto) lookAuto = false;
    if (key === lookKey) return;
    lookKey = key;
    const L = buildLook(o);
    for (const k of SCALARS) { lookFrom[k] = cur[k]; target[k] = L[k]; }
    for (const k of VECS) { lookFrom[k] = cur[k].slice(); target[k] = L[k].slice(); }
    lookBlend = instant ? 1 : 0;
    if (instant) { for (const k of SCALARS) cur[k] = target[k]; for (const k of VECS) cur[k] = target[k].slice(); }
  }
  // Fallback when nobody calls setGrade: guess the time of day from the fog colour.
  let autoScene = null, autoFog = null;
  function autoLook(scene) {
    if (!lookAuto || !scene) return;
    const f = scene.fog && scene.fog.color ? scene.fog.color : (scene.background && scene.background.isColor ? scene.background : null);
    if (scene === autoScene && f === autoFog) return;
    autoScene = scene; autoFog = f;
    if (!f) return;
    const l = 0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b;
    const warm = f.r - f.b;
    const tod = l < 0.035 ? 'night' : (warm > 0.06 && l < 0.35) ? 'dusk' : 'day';
    setGrade({ timeOfDay: tod, __auto: true }, true);
  }
  // one-shot pulse (decays in render)
  const pulse = { flash: 0, aberr: 0 };
  const _cc = new THREE.Color();

  // -------------------------------------------------------------- post objects
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(quadGeo, null); quad.frustumCulled = false;
  const mkMat = (fs, uniforms, defines = {}) => new THREE.RawShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, defines, depthTest: false, depthWrite: false });

  const U = {
    tScene: { value: null }, tBloom: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 },
    uBloom: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, toneMappingExposure: { value: 1 },
    uContrast: { value: 1 }, uSat: { value: 1 }, uVibrance: { value: 0 }, uSplit: { value: 0 }, uVignette: { value: 0 }, uGrain: { value: 0 }, uTime: { value: 0 },
    uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
    uShadowTint: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uHighTint: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uLetterbox: { value: 0 }, uFlash: { value: 0 }, uAberr: { value: 0 }, uSlowmo: { value: 0 },
  };
  let P = null;   // { sceneRT, mips:[], down0, down, up, final, levels, bloomScale }

  function destroyPost() {
    if (!P) return;
    try {
      P.sceneRT.dispose(); for (const m of P.mips) m.dispose();
      P.down0.dispose(); P.down.dispose(); P.up.dispose(); P.final.dispose();
    } catch (e) { /* ignore */ }
    P = null;
  }
  function buildPost(t) {
    destroyPost();
    if (t === 'low') return;
    try {
      const high = t === 'high';
      const pr = renderer.getPixelRatio();
      const W = Math.max(1, Math.round(cssW * pr)), H = Math.max(1, Math.round(cssH * pr));
      const sceneRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: high ? 4 : 0, depthBuffer: true, stencilBuffer: false });
      sceneRT.texture.name = 'wcd-scene'; sceneRT.texture.generateMipmaps = false;
      const levels = high ? 5 : 4, bloomScale = high ? 2 : 4;
      const mips = [];
      for (let i = 0; i < levels; i++) {
        const w = Math.max(1, Math.round(W / (bloomScale * 2 ** i))), h = Math.max(1, Math.round(H / (bloomScale * 2 ** i)));
        const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
        rt.texture.generateMipmaps = false; rt.texture.minFilter = THREE.LinearFilter; rt.texture.magFilter = THREE.LinearFilter;
        mips.push(rt);
      }
      const down0 = mkMat(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: new THREE.Vector4() } }, { PREFILTER: '' });
      const down = mkMat(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: new THREE.Vector4() } });
      const up = mkMat(UP_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
      up.blending = THREE.AdditiveBlending; up.transparent = true;
      const defines = { BLOOM: '' }; if (!high) defines.FXAA = ''; else defines.GRAIN = '';
      const final = mkMat(FINAL_FS, U, defines);
      P = { sceneRT, mips, down0, down, up, final, levels, bloomScale, W, H };
      U.uTexel.value.set(1 / W, 1 / H);
    } catch (e) {
      console.warn('[render] post-processing unavailable, rendering direct', e);
      destroyPost();
    }
  }

  function apply(t) {
    const prevShadow = renderer.shadowMap.enabled + ':' + renderer.shadowMap.type;
    renderer.setPixelRatio(dprFor(t));
    renderer.shadowMap.enabled = t !== 'low';
    renderer.shadowMap.type = t === 'high' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
    renderer.shadowMap.needsUpdate = true;
    if (prevShadow !== renderer.shadowMap.enabled + ':' + renderer.shadowMap.type) refreshMaterials = true;
    renderer.setSize(cssW, cssH, false);
    buildPost(t);
  }

  // -------------------------------------------------------------- per-frame
  let lastNow = 0, time = 0, sceneCalls = 0, sceneTris = 0;
  function stepLook(dt) {
    if (lookBlend < 1) {
      lookBlend = Math.min(1, lookBlend + dt / 0.8);
      const k = lookBlend * lookBlend * (3 - 2 * lookBlend);
      for (const s of SCALARS) cur[s] = lookFrom[s] + (target[s] - lookFrom[s]) * k;
      for (const v of VECS) for (let i = 0; i < 3; i++) cur[v][i] = lookFrom[v][i] + (target[v][i] - lookFrom[v][i]) * k;
    }
    pulse.flash = Math.max(0, pulse.flash - dt * 3.2);
    pulse.aberr = Math.max(0, pulse.aberr - dt * 2.2);
  }
  function pushUniforms() {
    const cp = cinemaPost;
    U.uBloom.value = cur.bloom * (1 + 0.5 * (cp.bloomBoost || 0));
    U.uWB.value.set(cur.wb[0], cur.wb[1], cur.wb[2]);
    U.toneMappingExposure.value = cur.exposure * (cp.exposure || 1);
    U.uContrast.value = cur.contrast; U.uSat.value = cur.sat; U.uVibrance.value = cur.vibrance; U.uSplit.value = cur.split;
    U.uVignette.value = cur.vignette + 0.12 * (cp.letterbox > 0 ? 1 : 0) * Math.min(1, cp.letterbox * 8);
    U.uGrain.value = cur.grain;
    U.uLift.value.set(cur.lift[0], cur.lift[1], cur.lift[2]); U.uGamma.value.set(cur.gamma[0], cur.gamma[1], cur.gamma[2]); U.uGain.value.set(cur.gain[0], cur.gain[1], cur.gain[2]);
    U.uShadowTint.value.set(cur.shadowTint[0], cur.shadowTint[1], cur.shadowTint[2]); U.uHighTint.value.set(cur.highTint[0], cur.highTint[1], cur.highTint[2]);
    U.uLetterbox.value = clamp(cp.letterbox || 0, 0, 0.3);
    U.uFlash.value = Math.max(pulse.flash, cp.flash || 0);
    U.uAberr.value = Math.max(pulse.aberr, cp.aberr || 0);
    U.uSlowmo.value = clamp(cp.slowmo || 0, 0, 1);
    U.uTime.value = time;
    U.uAspect.value = cssW / cssH;
  }
  function blit(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quad, quadCam); }

  function renderPost(scene, camera) {
    const { sceneRT, mips, down0, down, up, final } = P;
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;
    // bloom: prefilter → down chain → up chain (additive)
    const th = cur.threshold, kn = Math.max(1e-3, th * cur.knee);
    down0.uniforms.uThresh.value.set(th, th - kn, 2 * kn, 0.25 / kn);
    down0.uniforms.tSrc.value = sceneRT.texture; down0.uniforms.uTexel.value.set(1 / P.W, 1 / P.H);
    blit(down0, mips[0]);
    for (let i = 1; i < mips.length; i++) {
      down.uniforms.tSrc.value = mips[i - 1].texture; down.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      blit(down, mips[i]);
    }
    const autoClear = renderer.autoClear; renderer.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      up.uniforms.tSrc.value = mips[i].texture; up.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      up.uniforms.uWeight.value = cur.radius;
      blit(up, mips[i - 1]);
    }
    renderer.autoClear = autoClear;
    U.tScene.value = sceneRT.texture; U.tBloom.value = mips[0].texture;
    pushUniforms();
    blit(final, null);
  }

  // ------------------------------------------------------------ watchdog
  // EMA of frame time; if it stays above 22 ms for ~2 s (after a warm-up), step
  // down one tier. Only ever steps DOWN on its own → can never oscillate.
  const WD = { ema: 1 / 60, over: 0, warm: 0, enabled: !!adaptive };

  const R = {
    renderer,
    get quality() { return tier; },
    onQualityChange: null,
    post: cinemaPost,
    setGrade,
    pulse(o = {}) { if (o.flash) pulse.flash = Math.max(pulse.flash, o.flash); if (o.aberr) pulse.aberr = Math.max(pulse.aberr, o.aberr); },
    get grade() { return { key: lookKey, auto: lookAuto, ...JSON.parse(JSON.stringify(cur)) }; },
    render(scene, camera) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      const dt = lastNow ? clamp(now - lastNow, 0, 0.1) : 0.016; lastNow = now; time += dt;
      renderer.info.reset();
      if (refreshMaterials && scene) {
        refreshMaterials = false;
        scene.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.needsUpdate = true; }); });
      }
      autoLook(scene);
      stepLook(dt);
      if (P) {
        try { renderPost(scene, camera); return; }
        catch (e) { console.warn('[render] post failed, falling back', e); destroyPost(); renderer.setRenderTarget(null); }
      }
      renderer.toneMappingExposure = cur.exposure * (cinemaPost.exposure || 1);
      renderer.setRenderTarget(null);
      const lb = clamp(cinemaPost.letterbox || 0, 0, 0.3);
      if (lb > 0.002) {   // low tier: letterbox via scissor (costs nothing, saves fill)
        renderer.getClearColor(_cc); const ca = renderer.getClearAlpha();
        renderer.setScissorTest(false); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, false);
        renderer.setClearColor(_cc, ca);
        const bar = Math.round(cssH * lb / 2);
        renderer.setScissor(0, bar, cssW, cssH - 2 * bar); renderer.setScissorTest(true);
        renderer.render(scene, camera);
        renderer.setScissorTest(false);
      } else renderer.render(scene, camera);
      sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;
    },
    resize(w, h) {
      cssW = Math.max(1, Math.round(w || cssW)); cssH = Math.max(1, Math.round(h || cssH));
      renderer.setPixelRatio(dprFor(tier));
      renderer.setSize(cssW, cssH, false);
      if (P) {
        const pr = renderer.getPixelRatio(), W = Math.max(1, Math.round(cssW * pr)), H = Math.max(1, Math.round(cssH * pr));
        if (W !== P.W || H !== P.H) buildPost(tier);
      }
    },
    setQuality(t, reason = 'user') {
      if (!TIERS.includes(t)) return tier;
      const prev = tier;
      tier = t; apply(t);
      WD.over = 0; WD.warm = 0; WD.ema = 1 / 60;
      if (reason === 'user') WD.enabled = !!adaptive; // a manual pick re-arms the watchdog
      if (prev !== t) { try { R.onQualityChange?.(t, prev, reason); } catch (e) { console.warn(e); } }
      return tier;
    },
    beginFrame(dt) {
      if (!WD.enabled || !(dt > 0) || dt > 0.25) return; // hidden tab / hitch: ignore
      WD.warm += dt;
      WD.ema += (dt - WD.ema) * 0.06;
      if (WD.warm < 3) return;
      if (WD.ema > 0.022) WD.over += dt; else WD.over = Math.max(0, WD.over - dt * 0.5);
      if (WD.over >= 2 && tier !== 'low') {
        const next = DOWN[tier];
        console.info(`[render] quality ${tier} → ${next} (avg frame ${(WD.ema * 1000).toFixed(1)} ms)`);
        R.setQuality(next, 'watchdog');
      }
    },
    get adaptive() { return WD.enabled; },
    set adaptive(v) { WD.enabled = !!v; WD.over = 0; WD.warm = 0; },
    /** calls/tris of the SCENE pass; `total*` include post passes */
    get stats() { const i = renderer.info; return { calls: sceneCalls, tris: sceneTris, totalCalls: i.render.calls, totalTris: i.render.triangles, tier, ema: WD.ema, post: !!P, look: lookKey }; },
    dispose() {
      destroyPost(); quadGeo.dispose();
      renderer.dispose();
    },
  };
  apply(tier);
  return R;
}
