// ============================================================================
// WINDY CITY DERBY — ACTORS. Batter, pitcher, ball, read ring, strike zone,
// contact FX, Statcast tracer, landing marker. Everything that moves.
// Owner: ACTORS. Imports only data.js, fx.js and camera.js (ballTrack).
//
//   const actors = createActors(THREE, { scene, assets, charId, parkId })
//   startPitch(pitch) → { releaseIn }      windup; ball appears at release
//   setPitchTime(t, pitch)                 ball on pitch.posAt(t) (+ trail, ring, zone)
//   swing()                                contact frame lands TUNING.swingLead s later
//   contact(result)                        hit-stop FX, tracer starts
//   ballFlightT(tau)                       ball along result.path at tau
//   settle(result)                         ball at rest, landing marker + "452 FT"
//   take(result)                           ball into the mitt
//   reset()  setCharacter(id)  update(dt, t)  dispose()
// Extras (not in CONTRACT, optional): setLighting({tint, sunDir, shadow}),
//   onEvent callback in opts: ('release'|'mitt'|'land'|'fence', payload), fx, state.
//
// Art: 'swing_<id>' / 'pitcher' strips via assets.get()/meta(); if absent (or
// they arrive later) a procedural low-poly 3D fox is used and swapped out.
// ============================================================================
import { CHAR_BY_ID, CHARACTERS, PITCHES, TUNING, ZONE, RELEASE, surfaceHeight } from './data.js';
import { createFX } from './fx.js';
import { ballTrack } from './camera.js';

const BOX_X = 3.0, BOX_Z = 0.3;          // batter's box centre (|x|), z
const MITT_Z = 3.0;                       // catcher's mitt plane
const PITCHER_PLANE_Z = -55.6;            // pitcher billboard plane
const RUBBER_Y = 0.83;
const BALL_R = 0.121;                     // regulation radius (ft)
const BALL_VIS = 2.1;                     // on-screen readability scale
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------
const SPR_VS = /* glsl */`
uniform float uShear;
uniform float uBreath;
uniform float uH;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec3 p = position;
  float h = clamp(p.y / uH, 0.0, 1.0);
  p.x += uShear * h * h * uH;
  p.y *= 1.0 + uBreath * h;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const SPR_FS = /* glsl */`
uniform sampler2D map;
uniform vec4 uRect;
uniform vec4 uRect2;
uniform float uGhost;
uniform float uMirror;
uniform float uOpacity;
uniform vec3 uTint;
uniform float uLift;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec2 uv = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  vec4 c = texture2D(map, uRect.xy + uv * uRect.zw);
  if (uGhost > 0.001) { vec4 g = texture2D(map, uRect2.xy + uv * uRect2.zw) * uGhost; c += g * (1.0 - c.a); }
  c *= uOpacity;
  if (c.a < 0.012) discard;
  c.rgb = c.rgb * uTint + uLift * c.a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float ff = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float ff = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    c.rgb = mix(c.rgb, fogColor * c.a, ff);
  #endif
  gl_FragColor = c;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SHD_FS = /* glsl */`
uniform sampler2D map;
uniform vec4 uRect;
uniform float uMirror;
uniform float uShadow;
varying vec2 vUv;
void main() {
  vec2 uv = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  float a = texture2D(map, uRect.xy + uv * uRect.zw, 2.5).a;
  a *= uShadow * smoothstep(0.0, 0.08, vUv.y + 0.02) * (1.0 - 0.45 * vUv.y);
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;
const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPulse;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float d = (r - 0.86) / 0.055;
  float a = exp(-d * d) + 0.35 * exp(-((r - 0.86) / 0.16) * ((r - 0.86) / 0.16));
  a += uPulse * 0.5 * smoothstep(0.86, 0.0, r);
  // four tick marks
  float ang = atan(p.y, p.x);
  float tick = smoothstep(0.93, 0.99, abs(cos(ang * 2.0))) * smoothstep(1.0, 0.9, r) * smoothstep(0.9, 0.96, r);
  a += tick * 0.9;
  a *= uOpacity * step(r, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.45 * exp(-d * d)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const ZONE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vec2 q = vUv * uSize;                // feet from the corner
  vec2 e = min(q, uSize - q);          // distance to nearest edges
  float lw = 0.045;
  float edge = 1.0 - smoothstep(lw * 0.5, lw, min(e.x, e.y));
  // corner brackets: strong near corners, faint along edges
  float cx = step(e.x, 0.34), cy = step(e.y, 0.34);
  float bracket = edge * max(cx * step(e.y, lw * 1.2), cy * step(e.x, lw * 1.2));
  float a = bracket * 0.95 + edge * 0.28 + 0.035;
  a *= uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const MARK_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ring = exp(-pow((r - 0.8) / 0.05, 2.0));
  float inner = exp(-pow((r - 0.45) / 0.03, 2.0)) * 0.6;
  float dot = exp(-r * r * 40.0);
  float ripple = exp(-pow((r - fract(uTime * 0.7)) / 0.05, 2.0)) * (1.0 - fract(uTime * 0.7));
  float a = (ring + inner + dot + ripple * 0.8 + 0.12 * smoothstep(0.8, 0.0, r)) * uOpacity * step(r, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), dot * 0.7), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const BEAM_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float a = pow(1.0 - vUv.y, 1.6) * uOpacity * (0.55 + 0.45 * sin(vUv.x * 6.2832 * 3.0 + vUv.y * 4.0));
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a * 0.55);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
// canvas helpers (textures made once)
// ---------------------------------------------------------------------------
function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function ballTexture(THREE) {
  const W = 512, H = 256, c = mkCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#f3efe6'; g.fillRect(0, 0, W, H);
  // leather grain
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n - 2; }
  g.putImageData(img, 0, 0);
  // seam: tennis-ball curve on the unit sphere, drawn in equirect space
  const a = 0.72, b = 0.28, cc = 2 * Math.sqrt(a * b);
  const P = t => { const x = a * Math.cos(t) + b * Math.cos(3 * t), y = a * Math.sin(t) - b * Math.sin(3 * t), z = cc * Math.sin(2 * t); const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
  const toUV = ([x, y, z]) => { let u = Math.atan2(x, z) / (2 * Math.PI) + 0.5; const v = Math.acos(clamp(y, -1, 1)) / Math.PI; return [u * W, v * H]; };
  const N = 900;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2, p = P(t), q = P(t + 0.004);
      const [u, v] = toUV(p), [u2, v2] = toUV(q);
      if (Math.abs(u2 - u) > W / 2) continue;
      if (pass === 0) { // seam groove
        g.strokeStyle = 'rgba(150,140,125,0.55)'; g.lineWidth = 3.2; g.beginPath(); g.moveTo(u, v); g.lineTo(u2, v2); g.stroke();
      } else if (i % 9 === 0) { // red stitches (V pairs either side)
        const dx = u2 - u, dy = v2 - v, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, tx = dx / l, ty = dy / l;
        const s = 1 + 0.6 * Math.abs(p[1]);
        g.strokeStyle = '#c8202a'; g.lineWidth = 2.1; g.lineCap = 'round';
        for (const side of [-1, 1]) {
          g.beginPath();
          g.moveTo(u + nx * side * 2.5 * s, v + ny * side * 2.5 * s);
          g.lineTo(u + nx * side * 8.5 * s - tx * 3.5 * s, v + ny * side * 8.5 * s - ty * 3.5 * s);
          g.stroke();
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
function radialTexture(THREE, stops, size = 128) {
  const c = mkCanvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function labelCanvas(text, sub, gold, reuse) {
  const W = 640, H = 240, c = reuse || mkCanvas(W, H), g = c.getContext('2d');
  g.shadowBlur = 0; g.textAlign = 'left';
  g.clearRect(0, 0, W, H);
  const font = (w, s) => `italic ${w} ${s}px "Arial Black", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`;
  g.font = font(900, 118);
  const num = text, unit = 'FT';
  const wn = g.measureText(num).width; g.font = font(900, 58); const wu = g.measureText(unit).width;
  const tw = wn + 14 + wu, pw = tw + 96, ph = 150, px = (W - pw) / 2, py = 26;
  // pill
  const r = ph / 2;
  g.beginPath(); g.moveTo(px + r, py); g.lineTo(px + pw - r, py); g.arc(px + pw - r, py + r, r, -Math.PI / 2, Math.PI / 2); g.lineTo(px + r, py + ph); g.arc(px + r, py + r, r, Math.PI / 2, Math.PI * 1.5); g.closePath();
  const bg = g.createLinearGradient(0, py, 0, py + ph);
  bg.addColorStop(0, gold ? 'rgba(60,38,4,0.86)' : 'rgba(8,16,36,0.84)'); bg.addColorStop(1, gold ? 'rgba(24,14,0,0.9)' : 'rgba(3,7,18,0.9)');
  g.fillStyle = bg; g.fill();
  g.lineWidth = 6; g.strokeStyle = gold ? '#ffd257' : 'rgba(170,215,255,0.9)'; g.stroke();
  // text
  const tg = g.createLinearGradient(0, py + 20, 0, py + ph - 20);
  if (gold) { tg.addColorStop(0, '#fff6c9'); tg.addColorStop(0.55, '#ffd04a'); tg.addColorStop(1, '#ff9d1a'); }
  else { tg.addColorStop(0, '#ffffff'); tg.addColorStop(1, '#cfe6ff'); }
  const x0 = (W - tw) / 2, base = py + ph / 2 + 42;
  g.font = font(900, 118); g.fillStyle = tg; g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 8; g.fillText(num, x0, base);
  g.font = font(900, 58); g.fillText(unit, x0 + wn + 14, base);
  if (sub) { g.shadowBlur = 0; g.font = `700 30px "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`; g.fillStyle = gold ? '#ffe39a' : '#bcd6ff'; g.textAlign = 'center'; g.fillText(sub, W / 2, py + ph + 44); }
  return c;
}

// ---------------------------------------------------------------------------
// sprite strips: repack into a 3×2 grid (≤2048 px), premultiplied alpha.
// Pitcher: erase detached bright islands (the ball in the release frame) and
// remember where it was so the 3D ball can appear exactly in the hand.
// ---------------------------------------------------------------------------
function prepStrip(THREE, img, meta, { erase = false, analyze = false } = {}) {
  const frames = meta.frames || 6;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const fw = meta.fw || iw / frames, fh = meta.fh || ih;
  const cols = 3, rows = Math.ceil(frames / cols), pad = 4;
  const sc = Math.min(1, 2048 / (cols * (fw + pad * 2)), 2048 / (rows * (fh + pad * 2)));
  const cw = Math.round(fw * sc), ch = Math.round(fh * sc);
  const cellW = cw + pad * 2, cellH = ch + pad * 2;
  const W = cols * cellW, H = rows * cellH;
  const cv = mkCanvas(W, H), g = cv.getContext('2d', { willReadFrequently: erase || analyze });
  const rects = [], info = { frames: [], ball: null };
  for (let f = 0; f < frames; f++) {
    const col = f % cols, row = Math.floor(f / cols), x0 = col * cellW + pad, y0 = row * cellH + pad;
    g.drawImage(img, f * fw, 0, fw, fh, x0, y0, cw, ch);
    rects.push([x0 / W, 1 - (y0 + ch) / H, cw / W, ch / H]);
    if (!erase && !analyze) continue;
    let data;
    try { data = g.getImageData(x0, y0, cw, ch); } catch { continue; }
    const px = data.data, N = cw * ch;
    // feet extent (bottom 9% rows) for stance centring
    let fmin = cw, fmax = -1;
    for (let y = Math.floor(ch * 0.91); y < ch; y++) for (let x = 0; x < cw; x++) if (px[(y * cw + x) * 4 + 3] > 128) { if (x < fmin) fmin = x; if (x > fmax) fmax = x; }
    const fi = { feet: fmax >= 0 ? [fmin / cw, fmax / cw] : null };
    if (erase) {
      const lab = new Int32Array(N), stack = new Int32Array(N);
      const areas = [0], sums = [0], cxs = [0], cys = [0];
      let nl = 0;
      for (let i = 0; i < N; i++) {
        if (lab[i] || px[i * 4 + 3] <= 60) continue;
        nl++; let sp = 0, area = 0, lum = 0, sx = 0, sy = 0; stack[sp++] = i; lab[i] = nl;
        while (sp) {
          const j = stack[--sp]; area++; const o = j * 4; lum += px[o] * 0.3 + px[o + 1] * 0.59 + px[o + 2] * 0.11;
          const x = j % cw, y = (j / cw) | 0; sx += x; sy += y;
          if (x > 0 && !lab[j - 1] && px[(j - 1) * 4 + 3] > 60) { lab[j - 1] = nl; stack[sp++] = j - 1; }
          if (x < cw - 1 && !lab[j + 1] && px[(j + 1) * 4 + 3] > 60) { lab[j + 1] = nl; stack[sp++] = j + 1; }
          if (y > 0 && !lab[j - cw] && px[(j - cw) * 4 + 3] > 60) { lab[j - cw] = nl; stack[sp++] = j - cw; }
          if (y < ch - 1 && !lab[j + cw] && px[(j + cw) * 4 + 3] > 60) { lab[j + cw] = nl; stack[sp++] = j + cw; }
        }
        areas.push(area); sums.push(lum / area); cxs.push(sx / area); cys.push(sy / area);
      }
      let big = 0; for (let l = 1; l <= nl; l++) big = Math.max(big, areas[l]);
      let changed = false;
      for (let l = 1; l <= nl; l++) {
        if (areas[l] > 25 && areas[l] < big * 0.03 && sums[l] > 140) {
          const r = Math.sqrt(areas[l] / Math.PI) + 3;
          const cx = cxs[l], cy = cys[l];
          for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(ch, Math.ceil(cy + r)); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(cw, Math.ceil(cx + r)); x++) {
            const j = y * cw + x; if (lab[j] === l || ((x - cx) ** 2 + (y - cy) ** 2 < r * r && px[j * 4 + 3] < 200)) { px[j * 4 + 3] = 0; }
          }
          changed = true;
          if (!info.ball || f === (meta.releaseFrame ?? 3)) info.ball = { frame: f, u: cx / cw, v: cy / ch, r: r / ch };
        }
      }
      if (changed) g.putImageData(data, x0, y0);
    }
    info.frames[f] = fi;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.premultiplyAlpha = true;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return { tex, rects, info, fw, fh, W, H };
}

// ---------------------------------------------------------------------------
// Sprite actor: Y-billboard quad + sheared ground shadow + contact blob
// ---------------------------------------------------------------------------
function makeSpriteActor(THREE, parent, blobTex, strip, meta, { mirror = false, name = 'sprite' } = {}) {
  const Hft = meta.heightFt || 6.5;
  const Wft = Hft * strip.fw / strip.fh;
  let ax = meta.anchor ? meta.anchor[0] : 0.5; const ay = meta.anchor ? meta.anchor[1] : 0.99;
  if (mirror) ax = 1 - ax;
  const geo = new THREE.PlaneGeometry(Wft, Hft);
  geo.translate(Wft * (0.5 - ax), Hft * (ay - 0.5), 0);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    map: { value: strip.tex }, uRect: { value: new THREE.Vector4(...strip.rects[0]) }, uRect2: { value: new THREE.Vector4(...strip.rects[0]) },
    uGhost: { value: 0 }, uMirror: { value: mirror ? 1 : 0 }, uOpacity: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
    uShear: { value: 0 }, uBreath: { value: 0 }, uH: { value: Hft }, uLift: { value: 0 }, uShadow: { value: 0.32 },
  }]);
  uniforms.map.value = strip.tex;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SPR_VS, fragmentShader: SPR_FS, transparent: true, depthWrite: true, fog: true, premultipliedAlpha: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name; mesh.renderOrder = 2; mesh.frustumCulled = false;
  const shMat = new THREE.ShaderMaterial({ uniforms, vertexShader: SPR_VS, fragmentShader: SHD_FS, transparent: true, depthWrite: false, premultipliedAlpha: true });
  const shadow = new THREE.Mesh(geo, shMat);
  shadow.matrixAutoUpdate = false; shadow.renderOrder = 1; shadow.frustumCulled = false;
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55, color: 0x000000 }));
  blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1;
  const group = new THREE.Group(); group.name = name + '-group';
  group.add(mesh, shadow, blob);
  parent.add(group);
  const sun = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  const proj = new THREE.Matrix4();
  const S = { mesh, shadow, blob, uniforms, group, W: Wft, H: Hft, sun, yawOverride: null, groundY: 0 };
  mesh.onBeforeRender = (r, sc, cam) => {
    const yaw = S.yawOverride != null ? S.yawOverride : Math.atan2(cam.position.x - group.position.x, cam.position.z - group.position.z);
    mesh.rotation.set(0, yaw, 0); mesh.updateMatrix(); mesh.matrixWorld.multiplyMatrices(group.matrixWorld, mesh.matrix);
  };
  // shadow renders before the sprite: compute its matrix in its own hook too
  shadow.onBeforeRender = (r, sc, cam) => {
    const yaw = S.yawOverride != null ? S.yawOverride : Math.atan2(cam.position.x - group.position.x, cam.position.z - group.position.z);
    mesh.rotation.set(0, yaw, 0); mesh.updateMatrix();
    const L = S.sun; const ly = Math.max(L.y, 0.28);
    proj.set(1, -L.x / ly, 0, 0, 0, 0, 0, 0.035, 0, -L.z / ly, 1, 0, 0, 0, 0, 1);
    shadow.matrixWorld.copy(group.matrixWorld).multiply(proj).multiply(mesh.matrix);
  };
  S.setFrame = (f, ghostF, ghost) => {
    const r = strip.rects[clamp(f | 0, 0, strip.rects.length - 1)];
    uniforms.uRect.value.set(r[0], r[1], r[2], r[3]);
    if (ghostF != null && ghost > 0) { const q = strip.rects[clamp(ghostF | 0, 0, strip.rects.length - 1)]; uniforms.uRect2.value.set(q[0], q[1], q[2], q[3]); uniforms.uGhost.value = ghost; }
    else uniforms.uGhost.value = 0;
  };
  S.dispose = () => { parent.remove(group); geo.dispose(); mat.dispose(); shMat.dispose(); blob.geometry.dispose(); blob.material.dispose(); };
  return S;
}

// ---------------------------------------------------------------------------
// Procedural low-poly fox (fallback art). Keypoint rig + 2-bone IK.
// Rig space: +X forward (batter → plate, pitcher → home), +Y up, +Z = the
// actor's RIGHT side (batter: catcher side; pitcher: throwing-arm side).
// ---------------------------------------------------------------------------
const V3 = (THREE, a) => new THREE.Vector3(a[0], a[1], a[2]);
function buildFox(THREE, { fur = '#d9662b', jersey = '#0f2f7a', accent = '#ffb000', pants = '#f1f0ec', headwear = 'helmet', bat = true, number = '' } = {}) {
  const g = new THREE.Group(); g.name = 'fox';
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.82, metalness: o.m ?? 0, flatShading: o.flat ?? true, emissive: o.e ?? 0x000000, emissiveIntensity: o.ei ?? 1 });
  const mats = {
    fur: M(fur), light: M('#f4efe6'), dark: M('#221c1a'), jersey: M(jersey, { r: 0.7 }), accent: M(accent, { r: 0.6 }),
    pants: M(pants, { r: 0.85 }), shoe: M('#15181f', { r: 0.5 }), helmet: M(jersey, { r: 0.22, m: 0.25 }), bat: M('#c48a52', { r: 0.45 }),
    eye: M('#1a120c', { r: 0.2 }), glint: M('#ffffff', { e: 0xffffff, ei: 0.8 }), inner: M('#f2c6a8'), sock: M(jersey, { r: 0.8 }),
  };
  const limb = new THREE.CylinderGeometry(1, 0.82, 1, 7, 1); limb.translate(0, 0.5, 0);
  const ico1 = new THREE.IcosahedronGeometry(1, 1), ico0 = new THREE.IcosahedronGeometry(1, 0);
  const torsoG = new THREE.CylinderGeometry(1, 0.72, 1, 8, 1); torsoG.translate(0, 0.5, 0);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const parts = {};
  const add = (name, geo, mat, parent = g) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.name = name; parent.add(m); parts[name] = m; return m; };
  for (const s of ['B', 'F']) {
    add('thigh' + s, limb, mats.pants); add('knee' + s, ico1, mats.pants); add('shin' + s, limb, mats.sock);
    add('shoe' + s, box, mats.shoe); add('uarm' + s, limb, mats.jersey); add('farm' + s, limb, mats.fur);
    add('hand' + s, ico1, mats.accent); add('shoulder' + s, ico1, mats.jersey); add('elbow' + s, ico0, mats.fur);
    add('stripe' + s, limb, mats.accent);
  }
  add('pelvis', ico1, mats.pants); add('belt', new THREE.CylinderGeometry(1, 1, 1, 8, 1), mats.dark);
  add('torso', torsoG, mats.jersey); add('chestM', ico1, mats.jersey); add('collar', new THREE.TorusGeometry(0.2, 0.05, 4, 10), mats.accent);
  add('neck', limb, mats.light);
  // tail
  const tailR = [0.24, 0.36, 0.45, 0.46, 0.38, 0.24];
  const tailD = [0.42, 0.72, 1.05, 1.38, 1.66, 1.86], tailH = [-0.1, -0.42, -0.72, -0.84, -0.72, -0.44];
  for (let i = 0; i < 6; i++) add('tail' + i, ico1, i === 5 ? mats.light : mats.fur);
  // head
  const head = new THREE.Group(); head.name = 'head'; g.add(head); parts.head = head;
  const hp = (name, geo, mat, pos, scl, rot) => { const m = add(name, geo, mat, head); m.position.set(...pos); m.scale.set(...scl); if (rot) m.rotation.set(...rot); return m; };
  hp('skull', ico1, mats.fur, [0, 0, 0], [0.45, 0.42, 0.47]);
  hp('cheekL', ico1, mats.light, [0.19, -0.13, 0.2], [0.2, 0.15, 0.2]);
  hp('cheekR', ico1, mats.light, [-0.19, -0.13, 0.2], [0.2, 0.15, 0.2]);
  hp('snout', new THREE.ConeGeometry(0.2, 0.58, 6), mats.fur, [0, -0.06, 0.5], [1, 1, 0.85], [Math.PI / 2, 0, 0]);
  hp('jaw', new THREE.ConeGeometry(0.16, 0.5, 6), mats.light, [0, -0.15, 0.46], [1, 1, 0.7], [Math.PI / 2, 0, 0]);
  hp('nose', ico0, mats.dark, [0, -0.04, 0.8], [0.075, 0.06, 0.06]);
  hp('eyeL', ico1, mats.eye, [0.17, 0.06, 0.37], [0.07, 0.085, 0.05]);
  hp('eyeR', ico1, mats.eye, [-0.17, 0.06, 0.37], [0.07, 0.085, 0.05]);
  hp('glintL', ico0, mats.glint, [0.155, 0.09, 0.41], [0.022, 0.022, 0.022]);
  hp('glintR', ico0, mats.glint, [-0.185, 0.09, 0.41], [0.022, 0.022, 0.022]);
  const earG = new THREE.ConeGeometry(0.17, 0.52, 4);
  hp('earL', earG, mats.fur, [0.25, 0.46, -0.04], [1, 1, 0.55], [0, 0, -0.28]);
  hp('earR', earG, mats.fur, [-0.25, 0.46, -0.04], [1, 1, 0.55], [0, 0, 0.28]);
  hp('earInL', earG, mats.inner, [0.245, 0.43, 0.0], [0.55, 0.7, 0.3], [0, 0, -0.28]);
  hp('earInR', earG, mats.inner, [-0.245, 0.43, 0.0], [0.55, 0.7, 0.3], [0, 0, 0.28]);
  hp('earTipL', earG, mats.dark, [0.305, 0.66, -0.04], [0.42, 0.3, 0.25], [0, 0, -0.28]);
  hp('earTipR', earG, mats.dark, [-0.305, 0.66, -0.04], [0.42, 0.3, 0.25], [0, 0, 0.28]);
  if (headwear === 'helmet') {
    hp('helmet', new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mats.helmet, [0, 0.06, -0.03], [1, 0.95, 1.08]);
    hp('brim', new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12, 1, false, -Math.PI / 2, Math.PI), mats.helmet, [0, 0.08, 0.36], [1, 1, 0.9]);
    hp('stripe', new THREE.TorusGeometry(0.505, 0.035, 4, 18, Math.PI), mats.accent, [0, 0.06, -0.03], [1, 0.95, 1.08], [0, Math.PI / 2, 0]);
    hp('flap', new THREE.SphereGeometry(0.2, 8, 6), mats.helmet, [0.4, -0.12, -0.02], [0.45, 1, 1]);
  } else {
    hp('cap', new THREE.SphereGeometry(0.47, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.48), mats.helmet, [0, 0.1, -0.03], [1, 0.8, 1.05]);
    hp('brim', new THREE.CylinderGeometry(0.34, 0.34, 0.04, 12, 1, false, -Math.PI / 2, Math.PI), mats.helmet, [0, 0.12, 0.38], [0.95, 1, 1.25]);
  }
  // jersey number on the back (the camera sees the batter's back)
  if (number && typeof document !== 'undefined') {
    const c = mkCanvas(128, 128), cg = c.getContext('2d');
    cg.font = 'italic 900 96px "Arial Black", Arial, sans-serif'; cg.textAlign = 'center'; cg.textBaseline = 'middle';
    cg.lineWidth = 10; cg.strokeStyle = accent; cg.strokeText(number, 64, 68); cg.fillStyle = '#ffffff'; cg.fillText(number, 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.name = 'number'; g.add(m); parts.number = m;
  }
  if (bat) {
    const bg = new THREE.CylinderGeometry(0.115, 0.045, 2.75, 10, 1); bg.translate(0, 1.375, 0);
    add('bat', bg, mats.bat);
    const kn = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 10); add('knob', kn, mats.dark);
    const tape = new THREE.CylinderGeometry(0.052, 0.05, 0.55, 10); tape.translate(0, 0.35, 0); add('tape', tape, mats.accent);
  }
  add('heldBall', ico1, M('#f3efe6', { r: 0.5 })); parts.heldBall.visible = false;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });

  // ---- posing
  const Y = new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), t3 = new THREE.Vector3(), t4 = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  const J = {}; for (const k of ['hipB', 'hipF', 'kneeB', 'kneeF', 'shB', 'shF', 'elB', 'elF', 'head', 'up', 'sH', 'sS', 'fwd', 'fwdT', 'pole']) J[k] = new THREE.Vector3();
  function seg(m, a, b, r, rz) {
    t1.subVectors(b, a); const len = t1.length() || 1e-4; t1.divideScalar(len);
    m.position.copy(a); m.quaternion.setFromUnitVectors(Y, t1); m.scale.set(r, len, rz ?? r);
  }
  function ik(A, C, l1, l2, pole, out) {
    t2.subVectors(C, A); let d = t2.length(); d = clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999); t2.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    t3.subVectors(pole, A); t3.addScaledVector(t2, -t3.dot(t2)); if (t3.lengthSq() < 1e-8) t3.set(0, -1, 0); t3.normalize();
    return out.copy(A).addScaledVector(t2, a).addScaledVector(t3, h);
  }
  function basis(m, x, y, pos, sx, sy, sz) {
    t4.crossVectors(x, y).normalize(); const xx = t1.crossVectors(y, t4).normalize();
    mtx.makeBasis(xx, y, t4); m.quaternion.setFromRotationMatrix(mtx); m.position.copy(pos); m.scale.set(sx, sy, sz);
  }
  /** kp: {footB, footF, pelvis, th, chest, ph, handB, handF, look, batKnob?, batDir?, heldBall?, time} (THREE.Vector3s / numbers) */
  function pose(kp) {
    const P = parts;
    J.sH.set(Math.sin(kp.th), 0, Math.cos(kp.th));
    J.fwd.crossVectors(Y, J.sH).normalize();
    J.hipB.copy(kp.pelvis).addScaledVector(J.sH, 0.34); J.hipB.y -= 0.12;
    J.hipF.copy(kp.pelvis).addScaledVector(J.sH, -0.34); J.hipF.y -= 0.12;
    for (const s of ['B', 'F']) {
      const hip = J['hip' + s], foot = kp['foot' + s];
      J.pole.copy(hip).addScaledVector(J.fwd, 2).addScaledVector(J.sH, s === 'B' ? 0.35 : -0.35); J.pole.y -= 0.6;
      t4.copy(foot); t4.y += 0.2;
      ik(hip, t4, 1.5, 1.42, J.pole, J['knee' + s]);
      seg(P['thigh' + s], hip, J['knee' + s], 0.36, 0.36);
      P['knee' + s].position.copy(J['knee' + s]); P['knee' + s].scale.setScalar(0.3);
      seg(P['shin' + s], J['knee' + s], t4, 0.25);
      seg(P['stripe' + s], t1.copy(J['knee' + s]).lerp(t4, 0.5), t2.copy(J['knee' + s]).lerp(t4, 0.62), 0.265);
      // shoe: along the hip-forward, lifted heel shows as pitch
      const shoe = P['shoe' + s];
      shoe.position.set(foot.x + J.fwd.x * 0.18, foot.y + 0.12, foot.z + J.fwd.z * 0.18);
      shoe.rotation.set(0, Math.atan2(-J.fwd.z, J.fwd.x), foot.y > 0.1 ? -0.5 : 0, 'YXZ');
      shoe.scale.set(0.82, 0.28, 0.38);
    }
    P.pelvis.position.copy(kp.pelvis); P.pelvis.quaternion.setFromUnitVectors(t1.set(0, 0, 1), J.sH); P.pelvis.scale.set(0.56, 0.46, 0.7);
    J.up.subVectors(kp.chest, kp.pelvis).normalize();
    J.sS.set(Math.sin(kp.ph), 0, Math.cos(kp.ph));
    basis(P.belt, J.sS, J.up, t3.copy(kp.pelvis).addScaledVector(J.up, 0.3), 0.66, 0.14, 0.52);
    // torso: x = shoulder line, y = up
    const tLen = kp.pelvis.distanceTo(kp.chest) + 0.15;
    basis(P.torso, J.sS, J.up, t3.copy(kp.pelvis).addScaledVector(J.up, 0.1), 0.78, tLen, 0.52);
    basis(P.chestM, J.sS, J.up, t3.copy(kp.chest).addScaledVector(J.up, -0.3), 0.86, 0.5, 0.58);
    J.fwdT.crossVectors(Y, J.sS).normalize();
    if (P.number) { // on the back of the jersey
      P.number.position.copy(kp.pelvis).lerp(kp.chest, 0.66).addScaledVector(J.fwdT, -0.56);
      P.number.quaternion.setFromUnitVectors(t1.set(0, 0, 1), t2.copy(J.fwdT).negate());
    }
    J.shB.copy(kp.chest).addScaledVector(J.sS, 0.74).addScaledVector(J.up, -0.12);
    J.shF.copy(kp.chest).addScaledVector(J.sS, -0.74).addScaledVector(J.up, -0.12);
    for (const s of ['B', 'F']) {
      const sh = J['sh' + s], hand = kp['hand' + s];
      P['shoulder' + s].position.copy(sh); P['shoulder' + s].scale.setScalar(0.31);
      J.pole.copy(sh).addScaledVector(J.fwdT, -0.8).addScaledVector(J.sS, s === 'B' ? 0.9 : -0.9); J.pole.y -= 1.2;
      ik(sh, hand, 1.08, 1.02, J.pole, J['el' + s]);
      seg(P['uarm' + s], sh, J['el' + s], 0.25, 0.25);
      P['elbow' + s].position.copy(J['el' + s]); P['elbow' + s].scale.setScalar(0.19);
      seg(P['farm' + s], J['el' + s], hand, 0.2, 0.2);
      P['hand' + s].position.copy(hand); P['hand' + s].scale.setScalar(0.2);
    }
    // neck + head
    J.head.copy(kp.chest).addScaledVector(J.up, 0.72); J.head.addScaledVector(J.fwdT, 0.06);
    seg(P.neck, t1.copy(kp.chest).addScaledVector(J.up, -0.05), J.head, 0.2);
    P.collar.position.copy(kp.chest).addScaledVector(J.up, 0.02); P.collar.quaternion.setFromUnitVectors(t1.set(0, 0, 1), J.up);
    P.collar.scale.set(1.2, 1.2, 1.2);
    const head = P.head; head.position.copy(J.head);
    t2.subVectors(kp.look, J.head).normalize();                 // head +Z looks at target
    t3.crossVectors(Y, t2).normalize(); t4.crossVectors(t2, t3).normalize();
    mtx.makeBasis(t3, t4, t2); head.quaternion.setFromRotationMatrix(mtx);
    // tail (behind the pelvis, swishing)
    const tt = kp.time || 0;
    for (let i = 0; i < 6; i++) {
      const k = i / 5, sw = Math.sin(tt * 2.1 - i * 0.6) * 0.1 * (0.2 + k);
      const tp = t1.copy(kp.pelvis).addScaledVector(J.fwd, -tailD[i]).addScaledVector(J.sH, sw + k * 0.12);
      tp.y += tailH[i];
      const m = P['tail' + i]; m.position.copy(tp); const r = tailR[i];
      // align with the curve (next minus previous segment)
      const i0 = Math.max(0, i - 1), i1 = Math.min(5, i + 1);
      t3.copy(J.fwd).multiplyScalar(-(tailD[i1] - tailD[i0])); t3.y = tailH[i1] - tailH[i0]; t3.normalize();
      m.quaternion.setFromUnitVectors(t2.set(0, 1, 0), t3);
      m.scale.set(r, r * 1.35, r * 0.92);
    }
    if (P.bat && kp.batDir) {
      seg(P.bat, kp.batKnob, t1.copy(kp.batKnob).addScaledVector(kp.batDir, 2.75), 1);
      P.bat.scale.set(1, 1, 1);
      P.knob.position.copy(kp.batKnob); P.knob.quaternion.copy(P.bat.quaternion);
      P.tape.position.copy(kp.batKnob); P.tape.quaternion.copy(P.bat.quaternion);
    }
    if (kp.heldBall) { P.heldBall.visible = true; P.heldBall.position.copy(kp.heldBall); P.heldBall.scale.setScalar(0.14); }
    else P.heldBall.visible = false;
  }
  function dispose() {
    g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); } });
    for (const k in mats) mats[k].dispose();
  }
  function setColors({ fur: f, jersey: j, accent: a }) {
    if (f) mats.fur.color.set(f); if (j) { mats.jersey.color.set(j); mats.helmet.color.set(j); mats.sock.color.set(j); } if (a) mats.accent.color.set(a);
  }
  return { group: g, parts, pose, dispose, setColors, mats };
}

// keyframe helpers: poses are {key: [x,y,z] | number}
function lerpPose(out, a, b, k) {
  for (const key in a) {
    const va = a[key], vb = b[key] ?? va;
    if (typeof va === 'number') out[key] = lerp(va, vb, k);
    else { const o = out[key]; o.x = lerp(va[0], vb[0], k); o.y = lerp(va[1], vb[1], k); o.z = lerp(va[2], vb[2], k); }
  }
  return out;
}
function samplePose(out, keys, times, t) {
  let i = 0;
  while (i < times.length - 2 && t > times[i + 1]) i++;
  const k = smooth(times[i], times[i + 1], t);
  return lerpPose(out, keys[i], keys[i + 1], k);
}

// Batter keys (righty, rig space: origin = stance centre, +X toward plate, -Z toward pitcher)
const BK = [
  { footB: [-0.15, 0, 1.05], footF: [0.05, 0, -1.05], pelvis: [-0.2, 2.86, 0.05], th: -0.05, chest: [-0.3, 4.45, 0.12], ph: -0.22, hands: [-0.25, 4.72, 0.98], batDir: [0.12, 0.82, 0.56] },
  { footB: [-0.15, 0, 1.05], footF: [0.05, 0.38, -0.9], pelvis: [-0.3, 2.82, 0.22], th: -0.25, chest: [-0.4, 4.42, 0.3], ph: -0.48, hands: [-0.35, 4.85, 1.22], batDir: [0.32, 0.74, 0.6] },
  { footB: [-0.15, 0, 1.05], footF: [0.12, 0, -1.72], pelvis: [-0.15, 2.64, -0.2], th: 0.08, chest: [-0.3, 4.24, 0.02], ph: -0.25, hands: [-0.2, 4.4, 1.0], batDir: [0.55, 0.42, 0.72] },
  { footB: [-0.05, 0.2, 0.92], footF: [0.12, 0, -1.72], pelvis: [0.02, 2.64, -0.3], th: 0.85, chest: [0.08, 4.24, -0.3], ph: 0.95, hands: [0.95, 3.3, -0.55], batDir: [0.9, -0.04, -0.43] },
  { footB: [0.05, 0.28, 0.75], footF: [0.12, 0, -1.72], pelvis: [0.05, 2.7, -0.35], th: 1.2, chest: [0.0, 4.3, -0.42], ph: 1.55, hands: [0.4, 4.2, -1.35], batDir: [-0.5, 0.3, -0.81] },
  { footB: [0.1, 0.28, 0.7], footF: [0.12, 0, -1.72], pelvis: [0.05, 2.76, -0.35], th: 1.25, chest: [-0.05, 4.36, -0.42], ph: 1.78, hands: [-0.38, 4.95, -0.75], batDir: [-0.5, -0.35, 0.79] },
];
// Pitcher keys (rig space: origin = rubber, +X toward home, +Z = throwing-arm side)
const PK = [
  { footB: [0, 0, 0.5], footF: [0.1, 0, -0.5], pelvis: [0, 3.0, 0], th: 0, chest: [0.02, 4.6, 0], ph: 0, handB: [0.55, 4.0, 0.12], handF: [0.58, 4.05, -0.12] },
  { footB: [0, 0, 0.35], footF: [0.35, 2.2, -0.15], pelvis: [0, 3.1, 0.1], th: -1.3, chest: [-0.1, 4.7, 0.12], ph: -1.4, handB: [0.2, 4.55, 0.05], handF: [0.25, 4.6, -0.1] },
  { footB: [0.1, 0.2, 0.45], footF: [4.3, 0, -0.35], pelvis: [2.0, 2.6, 0.1], th: -0.6, chest: [1.8, 4.2, 0.2], ph: -0.9, handB: [-0.6, 5.3, 1.6], handF: [3.2, 4.4, -0.8] },
  { footB: [1.3, 0.8, 0.5], footF: [4.3, 0, -0.35], pelvis: [3.2, 2.55, 0.0], th: 0.6, chest: [4.8, 4.15, 0.4], ph: 0.7, handB: [6.5, 5.07, 1.8], handF: [4.4, 3.6, -0.7] },
  { footB: [3.4, 1.5, 0.7], footF: [4.3, 0, -0.35], pelvis: [3.8, 2.3, -0.1], th: 1.1, chest: [5.2, 3.3, -0.2], ph: 1.3, handB: [5.3, 1.9, -1.2], handF: [4.8, 3.3, -0.9] },
  { footB: [4.6, 0, 0.8], footF: [4.4, 0, -0.9], pelvis: [4.3, 2.6, 0], th: 0, chest: [4.6, 4.15, 0], ph: 0, handB: [5.2, 3.5, 0.3], handF: [5.2, 3.5, -0.3] },
];
// The 3D fox group is yawed by FOX_YAW so its back (and number) faces the high
// catcher cam like the sprite art. Keys above are authored world-aligned; feet (all
// keys) and the contact/follow/finish keys are un-rotated so they stay world-exact
// (no foot sliding, bat meets the ball over the plate).
const FOX_YAW = 0.55;
function unrotKey(k, a, all) {
  const o = {}, c = Math.cos(-a), sn = Math.sin(-a);
  for (const key in k) {
    const v = k[key];
    if (typeof v === 'number') o[key] = all && (key === 'th' || key === 'ph') ? v - a : v;
    else if (all || key === 'footB' || key === 'footF') o[key] = [v[0] * c + v[2] * sn, v[1], -v[0] * sn + v[2] * c];
    else o[key] = v.slice();
  }
  return o;
}
const BKR = BK.map((k, i) => unrotKey(k, FOX_YAW, i >= 3));
const JERSEY_NO = { rocco: '44', jett: '2', dex: '8', blaze: '17', nova: '7', skye: '11' };

// ---------------------------------------------------------------------------
// Tracer colour by quality (gold for 450+)
// ---------------------------------------------------------------------------
function tracerColor(res) {
  if (!res) return '#ffffff';
  if (res.kind === 'homer' && (res.distance || 0) >= TUNING.moonshotFt) return '#ffc23a';
  if (res.kind === 'foul') return '#cfd8e6';
  const q = res.quality ?? 0.5;
  if (res.kind === 'homer') return q > 0.85 ? '#ff5a2a' : '#ff7a3a';
  if (q > 0.8) return '#ff8a3a';
  if (q > 0.55) return '#35d0ff';
  return '#8fa8ff';
}

// ============================================================================
export function createActors(THREE, { scene, assets, charId = 'nova', parkId = 'wrigley', fx: fxIn, onEvent, quality = 'high' } = {}) {
  const root = new THREE.Group(); root.name = 'actors';
  scene.add(root);
  const fx = fxIn || createFX(THREE, scene, { quality });
  const ownsFx = !fxIn;
  const emit = (type, payload) => { try { onEvent && onEvent(type, payload); } catch (e) { /* never break the loop */ } };
  const A = {
    img(k) { try { const im = assets && assets.get ? assets.get(k) : null; if (!im) return null; if (im.complete === false) return null; return (im.naturalWidth || im.width) ? im : null; } catch { return null; } },
    meta(k) { try { return assets && assets.meta ? assets.meta(k) : null; } catch { return null; } },
  };

  // shared textures
  const blobTex = radialTexture(THREE, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
  const glowTex = radialTexture(THREE, [[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,0.6)'], [0.5, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]);

  // light probe (tint + sun) — refreshed from the scene a few times per second
  const light = { tint: new THREE.Color(1, 1, 1), sun: new THREE.Vector3(0.35, 0.85, 0.4).normalize(), shadow: 0.34, override: null, lum: 1 };
  const _c = new THREE.Color(), _c2 = new THREE.Color(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
  function probeLight() {
    if (light.override) return;
    let sumR = 0, sumG = 0, sumB = 0, sun = null, sunI = 0;
    scene.traverseVisible(o => {
      if (!o.isLight) return;
      if (o.isAmbientLight) { _c.copy(o.color).multiplyScalar(o.intensity); }
      else if (o.isHemisphereLight) { _c.copy(o.color).lerp(o.groundColor, 0.3).multiplyScalar(o.intensity); }
      else if (o.isDirectionalLight) {
        _c.copy(o.color).multiplyScalar(o.intensity * (o.castShadow ? 0.75 : 0.35));   // rims count less
        const w = o.intensity * (o.castShadow ? 2 : 1); if (w > sunI) { sunI = w; sun = o; }
      } else return;
      sumR += _c.r; sumG += _c.g; sumB += _c.b;
    });
    if (sumR + sumG + sumB <= 0) { light.tint.setRGB(1, 1, 1); return; }
    const mx = Math.max(sumR, sumG, sumB);
    const lum = 0.2126 * sumR + 0.7152 * sumG + 0.0722 * sumB;
    light.lum = lum;
    const bright = clamp(0.55 + 0.45 * lum / 2.2, 0.62, 1.04);
    _c2.setRGB(sumR / mx, sumG / mx, sumB / mx);
    light.tint.setRGB(1, 1, 1).lerp(_c2, 0.5).multiplyScalar(bright);
    if (sun) {
      sun.getWorldPosition(_v); if (sun.target) sun.target.getWorldPosition(_v2); else _v2.set(0, 0, 0);
      light.sun.subVectors(_v, _v2).normalize();
      light.shadow = clamp(0.18 + 0.1 * sun.intensity, 0.12, 0.42);
    }
  }

  // ------------------------------------------------------------ batter
  let char = CHAR_BY_ID[charId] || CHARACTERS[0];
  const B = { sprite: null, fox: null, key: '', side: 1, swinging: false, clock: 0, frame: 0, lastFrame: 0, ghost: 0, ghostF: 0, hitstop: 0, contactAt: TUNING.swingLead,
    kp: null, adjust: { y: 0, x: 0 }, idleT: Math.random() * 10, strip: null, stanceOff: 0, checkT: 0 };
  function batterSideSign() { return char.bats === 'L' ? 1 : -1; }   // x sign of the batter's box
  function buildBatter() {
    disposeBatter();
    const key = 'swing_' + char.id;
    const img = A.img(key), meta = A.meta(key);
    const mirror = char.bats === 'L';
    const sx = batterSideSign();
    if (img && meta) {
      try {
        const strip = prepStrip(THREE, img, meta, { analyze: true });
        B.strip = strip;
        const sp = makeSpriteActor(THREE, root, blobTex, strip, meta, { mirror, name: 'batter' });
        // centre the STANCE (not the back foot anchor) in the box
        const feet = strip.info.frames[0] && strip.info.frames[0].feet;
        const ax = meta.anchor ? meta.anchor[0] : 0.5;
        const sc = feet ? (feet[0] + feet[1]) / 2 : ax + 0.15;
        B.stanceOff = (sc - ax) * sp.W;                       // + = stance centre is screen-right of anchor (unmirrored)
        sp.group.position.set(sx * BOX_X - (mirror ? -1 : 1) * B.stanceOff, 0, BOX_Z);
        sp.blob.position.set((mirror ? -1 : 1) * B.stanceOff, 0.02, 0.05);
        sp.blob.scale.set(sp.W * 0.42, sp.H * 0.18, 1);
        B.sprite = sp; B.key = key;
      } catch (e) { console.warn('[actors] batter sprite failed, using 3D fox', e); B.sprite = null; }
    }
    if (!B.sprite) {
      const fox = buildFox(THREE, { fur: char.colors.fur, jersey: char.colors.jersey, accent: char.colors.accent, headwear: 'helmet', bat: true, number: JERSEY_NO[char.id] || '' });
      fox.group.position.set(sx * BOX_X, 0, BOX_Z);
      fox.group.rotation.y = mirror ? -FOX_YAW : FOX_YAW;
      if (mirror) fox.group.scale.x = -1;
      const s = char.id === 'rocco' ? 1.06 : char.gender === 'F' ? 0.95 : 1.0;
      fox.group.scale.multiplyScalar(s); if (mirror) fox.group.scale.x = -Math.abs(fox.group.scale.x);
      root.add(fox.group);
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.5, color: 0x000000 }));
      blob.rotation.x = -Math.PI / 2; blob.position.set(sx * BOX_X, 0.02, BOX_Z); blob.scale.set(3.4, 4.2, 1); blob.renderOrder = 1;
      root.add(blob); fox.blob = blob;
      B.fox = fox; B.key = '';
      B.kp = {}; for (const k in BKR[0]) B.kp[k] = typeof BKR[0][k] === 'number' ? 0 : new THREE.Vector3();
      B.kp.handB = new THREE.Vector3(); B.kp.handF = new THREE.Vector3(); B.kp.batKnob = new THREE.Vector3(); B.kp.look = new THREE.Vector3();
      fox.group.updateMatrixWorld(true);
      B.lookPitcher = fox.group.worldToLocal(new THREE.Vector3(0, 5.2, -58));
    }
  }
  function disposeBatter() {
    if (B.sprite) { B.sprite.dispose(); B.strip && B.strip.tex.dispose(); B.sprite = null; B.strip = null; }
    if (B.fox) { root.remove(B.fox.group); root.remove(B.fox.blob); B.fox.blob.geometry.dispose(); B.fox.blob.material.dispose(); B.fox.dispose(); B.fox = null; }
  }
  // swing frame schedule: 1 load, 2 stride, 3 CONTACT at exactly swingLead, 4, 5 hold
  function swingFrame(c) {
    const L = TUNING.swingLead;
    if (c < L * 0.5) return 1;
    if (c < L) return 2;
    if (c < L + 0.065) return 3;
    if (c < L + 0.165) return 4;
    return 5;
  }
  const _kpA = {}, _kpB = {};
  function initKp(o) { for (const k in BKR[0]) o[k] = typeof BK[0][k] === 'number' ? 0 : new THREE.Vector3(); return o; }
  initKp(_kpA); initKp(_kpB);
  const BT = () => { const L = TUNING.swingLead; return [0, L * 0.5, L, L + 0.07, L + 0.19, L + 0.34]; };
  function poseFoxBatter(t) {
    const fox = B.fox, kp = B.kp;
    if (!B.swinging) {
      lerpPose(kp, BKR[0], BKR[0], 0);
      // idle: breathing, bat waggle, weight shift
      const br = Math.sin(t * 2.0) * 0.035, wg = Math.sin(t * 3.1) * 0.08 + Math.sin(t * 7.3) * 0.02 * (Math.sin(t * 0.7) > 0.3 ? 1 : 0);
      kp.chest.y += br; kp.hands.y += br * 0.8; kp.pelvis.x += Math.sin(t * 0.9) * 0.04;
      kp.batDir.x += wg; kp.batDir.z += Math.sin(t * 2.3) * 0.06; kp.batDir.normalize();
    } else {
      const c = B.clock;
      const keys = BKR, times = BT();
      samplePose(kp, keys, times, c);
      // contact-frame adjust to the pitch height / plate x
      const w = Math.max(0, 1 - Math.abs(c - TUNING.swingLead) / 0.09);
      kp.hands.y += B.adjust.y * w; kp.hands.x += B.adjust.x * w;
      kp.batDir.y += B.adjust.y * 0.12 * w;
      kp.batDir.normalize();
    }
    kp.handF.copy(kp.hands); kp.handB.copy(kp.hands).addScaledVector(kp.batDir, 0.32);
    kp.batKnob.copy(kp.hands).addScaledVector(kp.batDir, -0.14);
    kp.look.copy(B.lookPitcher); // pitcher, in rig space
    if (B.swinging && B.clock > TUNING.swingLead + 0.1 && B.flightLook) kp.look.copy(B.flightLook);
    kp.time = t;
    fox.pose(kp);
  }

  // ------------------------------------------------------------ pitcher
  const PT = { sprite: null, fox: null, clock: -1, strip: null, ballU: null, kp: null, checkT: 0, releaseFrame: 3 };
  function buildPitcher() {
    disposePitcher();
    const img = A.img('pitcher'), meta = A.meta('pitcher');
    if (img && meta) {
      try {
        const strip = prepStrip(THREE, img, meta, { erase: true });
        const sp = makeSpriteActor(THREE, root, blobTex, strip, meta, { mirror: false, name: 'pitcher' });
        sp.uniforms.uShadow.value = 0.28;
        PT.releaseFrame = meta.releaseFrame ?? 3;
        const ball = strip.info.ball;
        const ax = meta.anchor ? meta.anchor[0] : 0.5, ay = meta.anchor ? meta.anchor[1] : 0.99;
        // offset of the (erased) ball from the anchor in feet, for release alignment
        PT.ballOff = ball ? [(ball.u - ax) * sp.W, (ay - ball.v) * sp.H] : [-1.5, 5.0];
        sp.group.position.set(RELEASE[0] - PT.ballOff[0], RUBBER_Y, PITCHER_PLANE_Z);
        sp.blob.scale.set(sp.W * 0.5, sp.H * 0.2, 1); sp.blob.position.set(0.2, 0.02, 0);
        const baseHook = sp.mesh.onBeforeRender;
        const planeProj = (cam) => { // keep the release hand on RELEASE as seen from this camera
          const cz = cam.position.z;
          if (cz > PITCHER_PLANE_Z + 20) {
            const s = (cz - PITCHER_PLANE_Z) / (cz - RELEASE[2]);
            const x = cam.position.x + (RELEASE[0] - cam.position.x) * s;
            sp.group.position.x = x - PT.ballOff[0];
          } else sp.group.position.x = RELEASE[0] - PT.ballOff[0];
          sp.group.updateMatrixWorld();
        };
        sp.shadow.onBeforeRender = ((orig) => (r, s, cam, ...rest) => { planeProj(cam); orig(r, s, cam, ...rest); })(sp.shadow.onBeforeRender);
        sp.mesh.onBeforeRender = (r, s, cam, ...rest) => { planeProj(cam); baseHook(r, s, cam, ...rest); };
        PT.sprite = sp; PT.strip = strip;
      } catch (e) { console.warn('[actors] pitcher sprite failed, using 3D fox', e); PT.sprite = null; }
    }
    if (!PT.sprite) {
      const fox = buildFox(THREE, { fur: '#8a8f99', jersey: '#2a2e36', accent: '#c9d1d9', pants: '#c9ccd2', headwear: 'cap', bat: false });
      fox.group.position.set(0, RUBBER_Y, -60.5);
      fox.group.rotation.y = -Math.PI / 2;
      root.add(fox.group);
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.45, color: 0x000000 }));
      blob.rotation.x = -Math.PI / 2; blob.position.set(0, RUBBER_Y + 0.02, -59); blob.scale.set(3.5, 5, 1); blob.renderOrder = 1;
      root.add(blob); fox.blob = blob;
      PT.fox = fox;
      PT.kp = {}; for (const k in PK[0]) PT.kp[k] = typeof PK[0][k] === 'number' ? 0 : new THREE.Vector3();
      PT.kp.look = new THREE.Vector3(60.5, 3.2, 0); PT.held = new THREE.Vector3();
    }
  }
  function disposePitcher() {
    if (PT.sprite) { PT.sprite.dispose(); PT.strip && PT.strip.tex.dispose(); PT.sprite = null; PT.strip = null; }
    if (PT.fox) { root.remove(PT.fox.group); root.remove(PT.fox.blob); PT.fox.blob.geometry.dispose(); PT.fox.blob.material.dispose(); PT.fox.dispose(); PT.fox = null; }
  }
  const WT = () => { const W = TUNING.windupTime; return [0, W * 0.38, W * 0.78, W, W + 0.2, W + 0.65]; };
  function pitcherFrame(c) {
    const W = TUNING.windupTime;
    if (c < 0) return 0;
    if (c < W * 0.24) return 0;
    if (c < W * 0.6) return 1;
    if (c < W) return 2;
    if (c < W + 0.11) return 3;
    if (c < W + 0.42) return 4;
    return 5;
  }
  function poseFoxPitcher(t) {
    const kp = PT.kp;
    const c = PT.clock;
    if (c < 0) {
      lerpPose(kp, PK[0], PK[0], 0);
      kp.chest.y += Math.sin(t * 1.8) * 0.03;
    } else samplePose(kp, PK, WT(), c);
    if (c < TUNING.windupTime) { PT.held.copy(kp.handB); PT.held.x += 0.12; kp.heldBall = PT.held; } else kp.heldBall = null;
    kp.time = t;
    PT.fox.pose(kp);
  }

  // ------------------------------------------------------------ ball
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTexture(THREE), roughness: 0.48, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.18 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 22, 14), ballMat);
  ball.name = 'ball'; ball.visible = false; ball.castShadow = false; ball.frustumCulled = false;
  root.add(ball);
  const vp = new THREE.Vector2();
  let ballMinPx = 3.6, haloScale = 1;
  ball.onBeforeRender = (r, s, cam) => {
    // keep the ball readable: never smaller than ~ballMinPx CSS px radius
    r.getDrawingBufferSize(vp);
    const d = Math.max(0.1, cam.position.distanceTo(ball.position));
    const f = cam.projectionMatrix.elements[5];
    const pxPerFt = f * vp.y * 0.5 / d;
    const need = (ballMinPx * r.getPixelRatio()) / (BALL_R * pxPerFt);
    const sc = Math.max(BALL_VIS, need);
    ball.scale.setScalar(sc); ball.updateMatrix(); ball.matrixWorld.multiplyMatrices(root.matrixWorld, ball.matrix);
    haloScale = sc;
  };
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
  halo.visible = false; halo.renderOrder = 11; halo.frustumCulled = false;
  root.add(halo);
  halo.onBeforeRender = () => { halo.scale.setScalar(BALL_R * haloScale * 7 * H.haloK); halo.updateMatrix(); halo.matrixWorld.multiplyMatrices(root.matrixWorld, halo.matrix); };
  const H = { haloK: 1 };
  const ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, color: 0x000000, transparent: true, depthWrite: false, opacity: 0.4 }));
  ballShadow.rotation.x = -Math.PI / 2; ballShadow.visible = false; ballShadow.renderOrder = 1;
  root.add(ballShadow);
  const spinAxis = new THREE.Vector3(1, 0, 0), _q = new THREE.Quaternion();
  let spinRate = 0;

  function placeBall(x, y, z) {
    ball.position.set(x, y, z); halo.position.set(x, y, z);
    // blob shadow on whatever surface is below
    const r = Math.hypot(x, z), s = Math.atan2(x, -z) * 180 / Math.PI;
    let gy = 0;
    try { gy = z < 0 && Math.abs(s) <= 50 ? surfaceHeight(parkId, s, r) : 0; } catch { gy = 0; }
    const h = Math.max(0, y - gy);
    ballShadow.position.set(x, gy + 0.03, z);
    const sz = 0.5 + h * 0.035;
    ballShadow.scale.set(sz, sz, 1);
    ballShadow.material.opacity = clamp(0.45 - h * 0.006, 0, 0.45) * light.shadow / 0.34;
    ballShadow.visible = ball.visible && h < 70;
  }

  // ------------------------------------------------------------ read ring + zone
  const ringMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0 }, uPulse: { value: 0 } }, vertexShader: QUAD_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, depthTest: false });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
  ring.renderOrder = 20; ring.visible = false; ring.frustumCulled = false; ring.name = 'read-ring';
  ring.onBeforeRender = (r, s, cam) => { ring.quaternion.copy(cam.quaternion); ring.updateMatrix(); ring.matrixWorld.multiplyMatrices(root.matrixWorld, ring.matrix); };
  root.add(ring);
  const zx = ZONE.x[1] - ZONE.x[0], zy = ZONE.y[1] - ZONE.y[0];
  const zoneMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color('#dff1ff') }, uOpacity: { value: 0 }, uSize: { value: new THREE.Vector2(zx, zy) } }, vertexShader: QUAD_VS, fragmentShader: ZONE_FS, transparent: true, depthWrite: false, depthTest: false });
  const zone = new THREE.Mesh(new THREE.PlaneGeometry(zx, zy), zoneMat);
  zone.position.set((ZONE.x[0] + ZONE.x[1]) / 2, (ZONE.y[0] + ZONE.y[1]) / 2, 0); zone.renderOrder = 19; zone.visible = false; zone.name = 'zone';
  root.add(zone);

  // ------------------------------------------------------------ landing marker + label + beam
  const markMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color('#35d0ff') }, uOpacity: { value: 0 }, uTime: { value: 0 } }, vertexShader: QUAD_VS, fragmentShader: MARK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), markMat);
  marker.rotation.x = -Math.PI / 2; marker.visible = false; marker.renderOrder = 9; root.add(marker);
  const beamGeo = new THREE.CylinderGeometry(1, 1.4, 1, 20, 1, true); beamGeo.translate(0, 0.5, 0);
  const beamMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color('#ffd257') }, uOpacity: { value: 0 } }, vertexShader: QUAD_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(beamGeo, beamMat); beam.visible = false; beam.renderOrder = 9; root.add(beam);
  const labelTex = new THREE.CanvasTexture(labelCanvas('000', '', false)); labelTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthTest: false, depthWrite: false }));
  label.visible = false; label.renderOrder = 30; label.center.set(0.5, 0.0); label.frustumCulled = false;
  const LBL = { frac: 0.07, base: new THREE.Vector3(), t: 0, aspect: 640 / 240, op: 0 };
  label.onBeforeRender = (r, s, cam) => {
    r.getDrawingBufferSize(vp);
    const aspect = vp.x / Math.max(1, vp.y);
    const frac = aspect > 1 ? 0.12 : 0.072;
    const d = Math.max(1, cam.position.distanceTo(LBL.base));
    const f = cam.projectionMatrix.elements[5];
    const hWorld = 2 * frac * d / f;
    const pop = 1 + 0.25 * Math.exp(-LBL.t * 10) * Math.sin(LBL.t * 30);
    label.scale.set(hWorld * LBL.aspect * pop, hWorld * pop, 1);
    label.position.copy(LBL.base); label.position.y += d * 0.035 + 2 + Math.sin(LBL.t * 2) * d * 0.004;
    label.updateMatrix(); label.matrixWorld.multiplyMatrices(root.matrixWorld, label.matrix);
  };
  root.add(label);

  // ------------------------------------------------------------ play state
  const S = {
    phase: 'idle',            // idle | windup | pitch | caught | flight | rest
    pitch: null, pt: -1, trail: null, ringSnapT: -1, lastRingX: 0, lastRingY: 0,
    result: null, tracer: null, tau: 0, landT: 0, landed: false, fenceDone: false, pts: null, n: 0,
    caught: false, caughtAt: 0, hideAt: -1, zoneA: 0, zoneTarget: 0, markA: 0, markTarget: 0,
    settleT: -1, settleFrom: new THREE.Vector3(), settleDir: new THREE.Vector3(), restPos: new THREE.Vector3(),
    swoosh: null, swooshPts: new Float32Array(32 * 4), time: 0, released: false, lastT: 0,
  };
  const trailBuf = new Float32Array(200 * 4);

  function buildTrail(pitch) {
    const end = pitch.flightTime + 0.6, N = Math.min(199, Math.ceil(end * 120));
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * end, p = pitch.posAt(t);
      trailBuf[i * 4] = t; trailBuf[i * 4 + 1] = p[0]; trailBuf[i * 4 + 2] = p[1]; trailBuf[i * 4 + 3] = p[2];
    }
    if (S.trail) S.trail.release();
    const col = (PITCHES[pitch.type] && PITCHES[pitch.type].color) || '#ffffff';
    S.trail = fx.tracer(trailBuf, col, { count: N + 1, head: 0, tail: -0.1, tailSoft: 0.1, width: 0.45, minPx: 4, maxPx: 9, opacity: 0.55, headK: 12, core: 0.7, gain: 1.2 });
  }

  function mittPoint(pitch, out) {
    // where the pitch path crosses z = MITT_Z (linear in z along posAt)
    const ft = pitch.flightTime, tM = ft * (1 + MITT_Z / 54);
    const p = pitch.posAt(tM);
    return out.set(p[0], Math.max(0.6, p[1]), MITT_Z);
  }
  const _mitt = new THREE.Vector3();
  function mittPop(kind) {
    if (S.caught) return;
    S.caught = true; S.caughtAt = S.time; S.hideAt = S.time + 0.5;
    const m = S.pitch ? mittPoint(S.pitch, _mitt) : _mitt.set(0, 2.5, MITT_Z);
    placeBall(m.x, m.y, m.z);
    fx.burst('puff', m, { count: 7, size: 0.35, speed: 3, life: 0.5, color: '#efe6d4', opacity: 0.6, lift: 0.5 });
    fx.burst('shock', m, { r0: 0.2, r1: 1.4, life: 0.18, opacity: 0.6, color: kind === 'strike' ? '#ffd7a0' : '#ffffff' });
    spinRate = 0;
    if (S.trail) S.trail.fade(0.15);
    emit('mitt', { pos: m.toArray(), kind });
  }

  // ------------------------------------------------------------ swing swoosh (sprite batter)
  function buildSwoosh() {
    const sx = batterSideSign();
    const loc = S.pitch ? S.pitch.plateLoc : [0, 2.6];
    const L = TUNING.swingLead;
    // control points (world): behind the batter → through the contact point → around the front
    // barrel path: stance bat tip (up behind the helmet) → down through the ball → around
    const cp = [
      [sx * 4.8, 7.1, 0.6, 0.0],
      [sx * 4.6, 6.1, 1.3, L * 0.38],
      [sx * 3.1, 4.5, 1.1, L * 0.72],
      [loc[0] + sx * 0.25, loc[1] + 0.15, TUNING.contactZ + 0.1, L],
      [-sx * 0.2, loc[1] + 1.0, -2.8, L + 0.06],
      [sx * 3.0, 4.9, -2.5, L + 0.14],
    ];
    const n = 30, P = S.swooshPts;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * (cp.length - 1), k = Math.min(cp.length - 2, Math.floor(u)), f = u - k;
      const p0 = cp[Math.max(0, k - 1)], p1 = cp[k], p2 = cp[k + 1], p3 = cp[Math.min(cp.length - 1, k + 2)];
      for (let c = 0; c < 4; c++) { // catmull-rom per component (t is component 3)
        const v = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * f + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * f * f + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * f * f * f);
        P[i * 4 + (c === 3 ? 0 : c + 1)] = v;
      }
    }
    if (S.swoosh) S.swoosh.release();
    S.swoosh = fx.tracer(P, '#e8f4ff', { count: n, head: 0, tail: -0.05, tailSoft: 0.045, width: 0.9, minPx: 4, maxPx: 26, opacity: 0.7, headK: 16, core: 0.9, gain: 1.4 });
  }

  // ------------------------------------------------------------ API
  function startPitch(pitch) {
    resetPlay(false);
    S.pitch = pitch; S.phase = 'windup'; S.pt = -1; S.released = false;
    PT.clock = 0;
    S.zoneTarget = 1;
    if (pitch && pitch.posAt) buildTrail(pitch);
    halo.material.color.setRGB(1.4, 1.4, 1.4);
    const col = (PITCHES[pitch?.type] && PITCHES[pitch.type].color) || '#ffffff';
    ringMat.uniforms.uColor.value.set(col).lerp(_c.set('#ffffff'), 0.35);
    return { releaseIn: TUNING.windupTime };
  }

  function setPitchTime(t, pitch) {
    pitch = pitch || S.pitch; if (!pitch) return;
    if (pitch !== S.pitch) { S.pitch = pitch; if (pitch.posAt) buildTrail(pitch); }
    if (S.phase === 'flight' || S.phase === 'rest') return;
    if (t < 0) { ball.visible = false; return; }
    if (!S.released) {
      S.released = true;
      if (PT.clock < TUNING.windupTime) PT.clock = TUNING.windupTime; // keep the arm in sync with the ball
      fx.burst('flash', RELEASE, { size: 0.5, life: 0.1, opacity: 0.35 });
      emit('release', { pitch });
    }
    S.phase = S.caught ? 'caught' : 'pitch'; S.pt = t;
    if (S.caught) return;
    const p = pitch.posAt(t);
    if (p[2] >= MITT_Z) { mittPop(S.result && S.result.kind === 'whiff' ? 'whiff' : 'take'); return; }
    ball.visible = true; halo.visible = true; H.haloK = 0.55;
    placeBall(p[0], p[1], p[2]);
    // spin: backspin for heaters, topspin curve, side spin slider
    const type = pitch.type;
    if (type === 'curveball') spinAxis.set(-1, 0, 0); else if (type === 'slider') spinAxis.set(-0.3, 0.9, 0).normalize(); else spinAxis.set(1, 0, 0);
    spinRate = type === 'changeup' ? 11 : 26;
    if (S.trail) { S.trail.setHead(t); S.trail.setTail(t - 0.11); }
    // read ring
    const R = pitch.ring;
    if (R) {
      const vis = t >= R.showAt && t <= pitch.flightTime + 0.06;
      if (vis) {
        const snapK = R.snapAt > R.showAt ? smooth(R.snapAt, R.snapAt + 0.07, t) : 1;
        const x = lerp(R.preLoc[0], R.trueLoc[0], snapK), y = lerp(R.preLoc[1], R.trueLoc[1], snapK);
        ring.position.set(x, y, 0);
        const k = clamp((t - R.showAt) / Math.max(0.05, pitch.flightTime - R.showAt), 0, 1);
        const rad = lerp(1.05, 0.3, k * k * (3 - 2 * k));
        ring.scale.setScalar(rad);
        const fadeIn = smooth(R.showAt, R.showAt + 0.08, t);
        const fadeOut = 1 - smooth(pitch.flightTime - 0.02, pitch.flightTime + 0.06, t);
        ringMat.uniforms.uOpacity.value = 0.95 * fadeIn * fadeOut;
        const pulseT = t - R.snapAt;
        ringMat.uniforms.uPulse.value = R.snapAt > R.showAt && pulseT > 0 && pulseT < 0.2 ? 1 - pulseT / 0.2 : 0;
        ring.visible = true;
      } else ring.visible = false;
    }
  }

  function swing() {
    B.swinging = true; B.clock = 0; B.ghost = 0; B.hitstop = 0;
    B.flightLook = null;
    if (S.pitch) {
      const [px, py] = S.pitch.plateLoc || [0, 2.6];
      B.adjust.y = clamp(py - 2.55, -1.0, 1.1) * 0.85;
      B.adjust.x = clamp((batterSideSign() < 0 ? px : -px) * 0.4, -0.4, 0.4);
    } else { B.adjust.y = 0; B.adjust.x = 0; }
    if (B.sprite) buildSwoosh();
    fx.burst('dust', [batterSideSign() * BOX_X, 0.1, BOX_Z - 1.2], { count: 6, size: 0.5, speed: 2.5, life: 0.8, opacity: 0.35, lift: 0.6 });
  }

  const _dir = new THREE.Vector3(), _cp = new THREE.Vector3();
  function contact(result) {
    const res = result || {};
    S.result = res; S.phase = 'flight'; S.tau = 0; S.landed = false; S.fenceDone = false;
    const path = res.path;
    S.pts = path && path.pts ? path.pts : null; S.n = S.pts ? Math.floor(S.pts.length / 4) : 0;
    S.landT = res.hangTime || (S.n ? S.pts[(S.n - 1) * 4] : 0);
    const cp = res.contactPos || (S.pts ? [S.pts[1], S.pts[2], S.pts[3]] : [0, 2.6, TUNING.contactZ]);
    _cp.set(cp[0], cp[1], cp[2]);
    // batter: make sure we're on the contact frame, then hit-stop
    if (B.clock < TUNING.swingLead) B.clock = TUNING.swingLead;
    B.swinging = true;
    const sweet = res.contact === 'sweet' || (res.quality ?? 0) > 0.85;
    const q = clamp(res.quality ?? 0.5, 0, 1);
    B.hitstop = sweet ? 0.085 : 0.03;
    // launch direction
    if (S.n > 3) _dir.set(S.pts[9] - S.pts[1], S.pts[10] - S.pts[2], S.pts[11] - S.pts[3]).normalize(); else _dir.set(0, 0.3, -1).normalize();
    // FX
    const foul = res.kind === 'foul';
    // FX scale with contact quality: weak contact is a dull thud, not a shockwave
    const strong = q >= 0.55;
    fx.burst('flash', _cp, { size: 0.45 + q * q * 2.3, life: sweet ? 0.2 : strong ? 0.12 : 0.08, color: sweet ? '#fff1c8' : '#ffffff', opacity: 0.45 + 0.55 * q });
    if (q > 0.62) fx.burst('flare', _cp, { size: 2 + q * 3, life: 0.22, color: sweet ? '#ffd9a0' : '#cfe8ff', aspect: 8, opacity: 0.5 + 0.4 * q });
    if (strong) fx.burst('shock', _cp, { r0: 0.3, r1: 1.2 + q * (sweet ? 4.2 : 2.4), life: sweet ? 0.28 : 0.2, opacity: sweet ? 0.8 : 0.45 });
    fx.burst('sparks', _cp, { dir: _dir, count: Math.round(4 + q * q * (sweet ? 56 : 30)), speed: 25 + q * 65, spread: sweet ? 0.75 : 1.0, color: sweet ? '#fff0b0' : '#ffe0a0', color2: sweet ? '#ff6a1a' : '#ff9a4a', life: 0.2 + 0.25 * q });
    if (!strong) fx.burst('puff', _cp, { count: 5, size: 0.3, speed: 2.5, life: 0.4, color: '#efe6d4', opacity: 0.35, lift: 0.3 });
    if (sweet) {
      fx.ring(_v.copy(_cp).addScaledVector(_dir, 1.2), _dir, { r0: 0.3, r1: 5.5, life: 0.32, color: '#ffe2b0', opacity: 0.9, thick: 0.1 });
      fx.burst('glitter', _cp, { count: 14, speed: 10, life: 0.6, size: 0.45, color: '#fff2c0' });
    }
    if (res.contact === 'jammed' || res.contact === 'off the end') fx.burst('splinters', _cp, { dir: _dir, count: 10, speed: 18 });
    fx.burst('dust', [batterSideSign() * BOX_X, 0.1, BOX_Z - 1.4], { count: sweet ? 12 : 7, size: 0.6, speed: 4, life: 1.1, opacity: 0.4, lift: 1 });
    // tracer
    if (S.tracer) S.tracer.release();
    S.tracer = null;
    if (S.pts && S.n > 1) {
      S.tracer = fx.tracer(S.pts, tracerColor(res), { count: S.n, head: 0, tail: -1, tailSoft: 0.12, width: foul ? 1.2 : 2.2, minPx: foul ? 4 : 7, maxPx: foul ? 8 : 16, opacity: foul ? 0.5 : 1, headK: 1.4, core: 1, gain: foul ? 1 : 1.9 });
    }
    if (S.trail) S.trail.fade(0.12);
    ring.visible = false; S.zoneTarget = 0;
    H.haloK = 1.2;
    halo.material.color.set(tracerColor(res)).lerp(_c.set('#ffffff'), 0.35).multiplyScalar(2.4);
    spinRate = 40; spinAxis.set(1, 0, 0);
    ball.visible = true; halo.visible = true;
    placeBall(_cp.x, _cp.y, _cp.z);
    // publish for the director
    ballTrack.x = _cp.x; ballTrack.y = _cp.y; ballTrack.z = _cp.z; ballTrack.tau = 0; ballTrack.live = true; ballTrack.landed = false; ballTrack.seq++; ballTrack.stamp++;
    if (S.n && B.fox) { const e = (S.n - 1) * 4; B.fox.group.updateMatrixWorld(true); B.flightLook = B.fox.group.worldToLocal(new THREE.Vector3(S.pts[e + 1], S.pts[e + 2] + 30, S.pts[e + 3])); }
  }

  function samplePath(tau, out) {
    const pts = S.pts, n = S.n;
    if (!pts || n < 1) return out.copy(_cp);
    if (tau <= pts[0]) return out.set(pts[1], pts[2], pts[3]);
    let i = clamp(Math.floor((tau - pts[0]) * 60), 0, n - 2);
    while (i > 0 && pts[i * 4] > tau) i--;
    while (i < n - 2 && pts[(i + 1) * 4] < tau) i++;
    const o = i * 4, t0 = pts[o], t1 = pts[o + 4];
    const f = t1 > t0 ? clamp((tau - t0) / (t1 - t0), 0, 1) : 1;
    return out.set(lerp(pts[o + 1], pts[o + 5], f), lerp(pts[o + 2], pts[o + 6], f), lerp(pts[o + 3], pts[o + 7], f));
  }

  const _bp = new THREE.Vector3();
  function ballFlightT(tau) {
    if (!S.result) return;
    if (S.phase !== 'flight') S.phase = 'flight';
    S.tau = tau;
    samplePath(tau, _bp);
    ball.visible = true; halo.visible = true;
    placeBall(_bp.x, _bp.y, _bp.z);
    if (S.tracer) S.tracer.setHead(tau);
    ballTrack.x = _bp.x; ballTrack.y = _bp.y; ballTrack.z = _bp.z; ballTrack.tau = tau; ballTrack.live = true; ballTrack.stamp++;
    const path = S.result.path;
    if (!S.fenceDone && path && path.fenceT != null && tau >= path.fenceT && S.result.kind === 'homer') {
      S.fenceDone = true; emit('fence', { pos: _bp.toArray() });
    }
    if (!S.landed && tau >= S.landT - 1e-3 && path && path.landing) {
      S.landed = true; ballTrack.landed = true;
      landingFx();
    }
  }

  function landingFx() {
    const res = S.result, path = res.path, L = path.landing;
    const homer = res.kind === 'homer';
    const inField = L[1] < 1.5 && !homer;
    const p = [L[0], L[1], L[2]];
    if (inField) fx.burst('turf', p, { count: 10, size: 1.0, speed: 6, clods: 8, opacity: 0.5 });
    else fx.burst('dust', p, { count: 12, size: 1.8, speed: 7, life: 1.3, color: '#b8b2a6', opacity: 0.45, lift: 2 });
    if (homer) {
      fx.burst('glitter', p, { count: 36, speed: 24, lift: 16, size: 2.2, life: 1.8, color: tracerColor(res), color2: '#ffffff', grav: 9 });
      fx.burst('shock', p, { r0: 2, r1: 26, life: 0.5, opacity: 0.7, color: tracerColor(res) });
      fx.ring(p, [0, 1, 0], { r0: 2, r1: 30, life: 0.9, color: tracerColor(res), opacity: 0.9, thick: 0.08 });
    }
    emit('land', { pos: p, homer });
  }

  function settle(result) {
    const res = result || S.result; if (!res) return;
    if (res !== S.result) contact(res);
    const path = res.path;
    const n = S.n;
    if (n) { const e = (n - 1) * 4; S.restPos.set(S.pts[e + 1], S.pts[e + 2], S.pts[e + 3]); } else S.restPos.copy(_cp);
    if (S.tracer) S.tracer.setHead(1e9);
    if (!S.landed && path && path.landing) { S.landed = true; landingFx(); }
    S.phase = 'rest'; ballTrack.landed = true; ballTrack.x = S.restPos.x; ballTrack.y = S.restPos.y; ballTrack.z = S.restPos.z; ballTrack.stamp++;
    // small hop + roll if the sim stopped the ball dead on impact (seats / street / rooftop)
    const L = path && path.landing;
    const dead = L && Math.hypot(L[0] - S.restPos.x, L[2] - S.restPos.z) < 1.0 && S.restPos.y > 0.5;
    if (dead) {
      S.settleT = 0; S.settleFrom.copy(S.restPos);
      S.settleDir.set(S.restPos.x, 0, S.restPos.z).normalize();
    } else S.settleT = -1;
    placeBall(S.restPos.x, S.restPos.y, S.restPos.z);
    spinRate = 0; H.haloK = 0.9;
    // landing marker + distance label (not for fouls / grounders)
    const showLabel = res.kind !== 'foul' && res.kind !== 'grounder' && (res.distance || 0) > 60 && L;
    if (showLabel) {
      const gold = res.kind === 'homer' && res.distance >= TUNING.moonshotFt;
      const col = res.kind === 'homer' ? (gold ? '#ffd257' : '#ff8a3a') : '#35d0ff';
      markMat.uniforms.uColor.value.set(col);
      const mk = res.kind === 'homer' ? 11 : 7;
      marker.position.set(L[0], L[1] + 0.25, L[2]); marker.scale.setScalar(mk); marker.visible = true; S.markTarget = 1;
      if (res.kind === 'homer') {
        beam.position.set(L[0], L[1], L[2]); beam.scale.set(3, 90, 3); beam.visible = true; beamMat.uniforms.uColor.value.set(col);
      }
      const sub = res.kind === 'homer' ? `${Math.round(res.exitVelo || 0)} MPH · ${Math.round(res.launch || 0)}°` : '';
      const c = labelCanvas(String(Math.round(res.distance)), sub, gold, labelTex.image);
      labelTex.needsUpdate = true;
      LBL.aspect = c.width / c.height; LBL.base.set(L[0], L[1], L[2]); label.position.copy(LBL.base); LBL.t = 0; label.visible = true; LBL.op = 0;
      if (gold) fx.fireworks([L[0], L[1] + 10, L[2]], 3, { height: 90, spreadX: 50, stagger: 0.18, size: 0.9, palette: ['#ffcf3a', '#fff2c0', '#ff9d1a'] });
      if (res.kind === 'homer') fx.burst('confetti', [L[0], L[1] + 25, L[2]], { count: 70, speed: 20, radius: 8, size: 1.3, lift: 14 });
    }
  }

  function take(result) {
    if (S.phase === 'flight' || S.phase === 'rest') return;
    if (!S.caught) mittPop(result && result.kind);
    S.phase = 'caught';
    ring.visible = false; S.zoneTarget = 0;
  }

  function resetPlay(full = true) {
    S.phase = 'idle'; S.pt = -1; S.result = null; S.caught = false; S.hideAt = -1; S.settleT = -1; S.landed = false; S.released = false;
    ball.visible = false; halo.visible = false; ballShadow.visible = false; ring.visible = false;
    if (S.trail) { S.trail.release(); S.trail = null; }
    if (S.swoosh) { S.swoosh.release(); S.swoosh = null; }
    if (S.tracer) { S.tracer.fade(0.35, true); S.tracer = null; }
    S.markTarget = 0; label.visible = false; beam.visible = false;
    ballTrack.live = false; ballTrack.landed = false;
    if (full) { S.zoneTarget = 0; }
    B.swinging = false; B.clock = 0; B.ghost = 0; B.hitstop = 0; B.flightLook = null;
    PT.clock = -1;
  }
  function reset() { resetPlay(true); S.pitch = null; }

  function setCharacter(id) {
    const c = CHAR_BY_ID[id]; if (!c) return;
    char = c; B.swinging = false; buildBatter();
  }

  // ------------------------------------------------------------ update
  let probeT = 0;
  function update(dt = 1 / 60, t) {
    dt = clamp(dt || 0, 0, 0.1);
    S.time = t != null ? t : S.time + dt;
    const time = S.time;
    // late-arriving art → swap the procedural fox for the sprite
    B.checkT -= dt; if (B.checkT <= 0) {
      B.checkT = 1;
      if (!B.sprite && A.img('swing_' + char.id) && A.meta('swing_' + char.id)) buildBatter();
      if (!PT.sprite && A.img('pitcher') && A.meta('pitcher')) buildPitcher();
    }
    probeT -= dt; if (probeT <= 0) { probeT = 0.5; probeLight(); }

    // hit-stop
    let bdt = dt, fdt = dt;
    if (B.hitstop > 0) { B.hitstop -= dt; bdt = 0; fdt = dt * 0.2; }

    // ---- batter
    if (B.swinging) {
      const prevF = B.frame;
      B.clock += bdt;
      B.frame = swingFrame(B.clock + dt * 0.5 * (bdt > 0 ? 1 : 0));   // nearest display frame
      if (B.frame !== prevF) { B.ghostF = prevF; B.ghost = B.frame >= 2 && B.frame <= 4 ? 0.5 : 0.25; }
    } else { B.frame = 0; }
    B.ghost = Math.max(0, B.ghost - dt / 0.07);
    if (B.sprite) {
      const sp = B.sprite, U = sp.uniforms;
      sp.setFrame(B.frame, B.ghostF, B.ghost);
      if (!B.swinging) {
        const w = Math.sin(time * 0.62) > 0.55 ? Math.sin(time * 9.5) * 0.35 : 0;   // occasional bat waggle
        U.uShear.value = (Math.sin(time * 1.55) * 0.006 + w * 0.008) * (B.sprite ? 1 : 0) * (char.bats === 'L' ? -1 : 1);
        U.uBreath.value = Math.sin(time * 2.0) * 0.006;
      } else { U.uShear.value *= 0.8; U.uBreath.value = 0; }
      U.uTint.value.copy(light.tint); sp.sun.copy(light.sun); U.uShadow.value = light.shadow;
      sp.blob.material.opacity = 0.35 + light.shadow * 0.5;
    } else if (B.fox) {
      poseFoxBatter(time);
    }
    // swoosh follows the swing clock
    if (S.swoosh) {
      if (B.swinging && B.clock < TUNING.swingLead + 0.2) { S.swoosh.setHead(B.clock); S.swoosh.setTail(B.clock - 0.055); }
      else { S.swoosh.release(); S.swoosh = null; }
    }

    // ---- pitcher
    if (PT.clock >= 0) PT.clock += dt;
    if (PT.clock > TUNING.windupTime + 2.2) PT.clock = -1;          // back to the set position
    if (PT.sprite) {
      const f = pitcherFrame(PT.clock >= 0 ? PT.clock + dt * 0.5 : PT.clock);
      PT.sprite.setFrame(f);
      const U = PT.sprite.uniforms;
      U.uBreath.value = PT.clock < 0 ? Math.sin(time * 1.7) * 0.006 : 0;
      U.uTint.value.copy(light.tint); PT.sprite.sun.copy(light.sun); U.uShadow.value = light.shadow * 0.9;
    } else if (PT.fox) poseFoxPitcher(time);

    // ---- ball spin, hide after catch, settle hop
    if (ball.visible && spinRate > 0) { _q.setFromAxisAngle(spinAxis, spinRate * 6.283 * dt * (B.hitstop > 0 ? 0.1 : 1)); ball.quaternion.premultiply(_q); }
    if (S.hideAt > 0 && time >= S.hideAt) { ball.visible = false; halo.visible = false; ballShadow.visible = false; S.hideAt = -1; }
    if (S.settleT >= 0) {
      S.settleT += dt;
      const k = S.settleT, hop = Math.abs(Math.sin(k * 7.5)) * 2.2 * Math.exp(-k * 3.2), roll = 3.5 * (1 - Math.exp(-k * 2.2));
      placeBall(S.settleFrom.x + S.settleDir.x * roll, S.settleFrom.y + hop, S.settleFrom.z + S.settleDir.z * roll);
      ballTrack.x = ball.position.x; ballTrack.y = ball.position.y; ballTrack.z = ball.position.z; ballTrack.stamp++;
      if (k > 1.6) S.settleT = -1;
    }
    halo.material.opacity = S.phase === 'flight' || S.phase === 'rest' ? 0.75 : 0.35;

    // ---- zone / marker fades
    S.zoneA += (S.zoneTarget * 0.55 - S.zoneA) * (1 - Math.exp(-dt * (S.zoneTarget ? 5 : 9)));
    zoneMat.uniforms.uOpacity.value = S.zoneA; zone.visible = S.zoneA > 0.01;
    S.markA += (S.markTarget - S.markA) * (1 - Math.exp(-dt * 6));
    markMat.uniforms.uOpacity.value = S.markA; markMat.uniforms.uTime.value = time; marker.visible = S.markA > 0.01;
    beamMat.uniforms.uOpacity.value = S.markA * 0.9;
    if (label.visible) { LBL.t += dt; label.material.opacity = clamp(LBL.t * 5, 0, 1); }

    fx.update(fdt);
  }

  function dispose() {
    reset();
    disposeBatter(); disposePitcher();
    for (const o of [ball, halo, ballShadow, ring, zone, marker, beam, label]) { root.remove(o); o.geometry && o.geometry.dispose(); o.material.map && o.material.map !== blobTex && o.material.map !== glowTex && o.material.map.dispose(); o.material.dispose(); }
    blobTex.dispose(); glowTex.dispose();
    if (ownsFx) fx.dispose();
    scene.remove(root);
  }
  function setLighting({ tint, sunDir, shadow } = {}) {
    light.override = tint || sunDir || shadow != null ? true : null;
    if (tint) light.tint.set(tint);
    if (sunDir) light.sun.set(sunDir[0] ?? sunDir.x, sunDir[1] ?? sunDir.y, sunDir[2] ?? sunDir.z).normalize();
    if (shadow != null) light.shadow = shadow;
  }

  buildBatter();
  buildPitcher();
  probeLight();

  return {
    startPitch, setPitchTime, swing, contact, ballFlightT, settle, take, reset, setCharacter, update, dispose,
    setLighting, fx, root,
    get state() { return { phase: S.phase, batterFrame: B.frame, swingClock: B.clock, pitcherFrame: pitcherFrame(PT.clock >= 0 ? PT.clock + 1 / 120 : PT.clock), pitcherClock: PT.clock, art: { batter: !!B.sprite, pitcher: !!PT.sprite }, tint: light.tint.getHexString(), ball: ball.position.toArray(), ballVisible: ball.visible }; },
  };
}
