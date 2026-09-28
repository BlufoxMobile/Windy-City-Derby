// ============================================================================
// WINDY CITY DERBY — ACTORS. Batter, pitcher, ball, read ring, strike zone,
// contact FX, Statcast tracer, landing marker. Everything that moves.
// Owner: ACTORS. Imports data.js, fx.js, camera.js (ballTrack), sim.js (swingLeadFor).
//
//   const actors = createActors(THREE, { scene, assets, charId, parkId })
//   startPitch(pitch) → { releaseIn }      windup; ball appears at release
//   setPitchTime(t, pitch)                 ball on pitch.posAt(t) (+ trail, ring, zone)
//   swing(opts?) → { leadT }               bat meets the ball exactly leadT s later (default swingLeadFor(0.72))
//   contact(result)                        hit-stop FX, tracer starts
//   ballFlightT(tau)                       ball along result.path at tau
//   settle(result)                         ball at rest, landing marker + "452 FT"
//   take(result)                           ball into the mitt
//   reset()  setCharacter(id)  update(dt, t)  dispose()
// Extras (not in CONTRACT, optional): setLighting({tint, sunDir, shadow}),
//   onEvent callback in opts: ('release'|'mitt'|'land'|'fence', payload), fx, state.
//
// Art (v2): rigged, PBR-lit 3D foxes — 'model_<id>' / 'model_pitcher' GLBs loaded
// lazily via assets.model(). The batter is animated procedurally at bone level
// (sideways square stance, load, stride, kinematic-sequence swing whose contact
// lands exactly leadT after swing({batSpeed, leadT, aim, uppercut, pitchLoc,
// kind?, result?}), follow-through, finish, bat flip / relax). The pitcher plays
// the rig's baked mocap delivery retimed to TUNING.windupTime and pinned to RELEASE.
// Fallbacks while a model loads or if it fails: the v1 'swing_<id>' / 'pitcher'
// sprite strips (lazy), else a procedural low-poly fox.
// Extras: batter3D, pitcher3D, modelsReady() → Promise, state.art/leadT/batterPhase.
// ============================================================================
import { CHAR_BY_ID, CHARACTERS, PITCHES, TUNING, ZONE, RELEASE, RUBBER, surfaceHeight } from './data.js';
import { createFX } from './fx.js';
import { ballTrack } from './camera.js';
import * as SIM from './sim.js';

const leadFor = bs => { try { const f = SIM.swingLeadFor; if (typeof f === 'function') { const v = f(bs); if (Number.isFinite(v) && v > 0) return v; } } catch (e) { /* sim without swingLeadFor */ } return TUNING.swingLead; };

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

// ============================================================================
// RIGGED 3D FOXES — Meshy GLBs with a Mixamo-style 24-bone skeleton
// (Hips, Left/RightUpLeg, Leg, Foot, ToeBase, Spine02, Spine01, Spine,
//  Left/RightShoulder, Arm, ForeArm, Hand, neck, Head, head_end, headfront).
// Everything is solved procedurally at bone level every frame:
//   · RIG SPACE = the model's own space in metres: +Z = facing, +X = the model's
//     LEFT, +Y up, origin between the feet (rest A-pose).
//   · Poses are authored for a RIGHT-handed batter in rig space: +X = the pitcher
//     side (front), −X = catcher side (back), +Z = toward the plate. A lefty uses
//     the MIRRORED pose (x → −x, yaw/roll negated, front limb = right side), so the
//     skin, lighting and the BLUFOX script are never mirrored.
//   · Bone rotations are written as rig-space DELTAS from the rest pose
//     (Δ × restRigQ) → independent of the per-model bone axes.
//   · Two-bone IK (bend-plane frames, pole vectors) for arms and legs, look-at for
//     neck/head, hammer-grip hand frames from the bat, and added bones for a finger
//     curl (grip) and a 3-segment tail with spring secondary motion.
// ============================================================================
const RIG_BONES = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'Spine02', 'Spine01', 'Spine', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'neck', 'Head', 'headfront'];
const smooth01 = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const easeOutPow = (x, q) => 1 - Math.pow(1 - clamp(x, 0, 1), q);

/** symmetric 3x3 eigen-decomposition (Jacobi) → eigenvectors sorted by eigenvalue desc */
function eigSym3(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 24; it++) {
    let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  return [0, 1, 2].map(i => ({ val: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.val - x.val);
}

/**
 * Meshy splits UVs almost per triangle (≈3 vertices per position) and the normals
 * are per island → faceted shading. Average area-weighted face normals across all
 * vertices that share a position; keep the original where it would break a crease.
 */
function smoothSplitNormals(THREE, geo, creaseDeg = 55) {
  const P = geo.attributes.position, N0 = geo.attributes.normal, idx = geo.index;
  if (!P || !N0 || !idx) return;
  const n = P.count, ids = new Int32Array(n), map = new Map();
  let np = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.round(P.getX(i) * 2e4) + ',' + Math.round(P.getY(i) * 2e4) + ',' + Math.round(P.getZ(i) * 2e4);
    let id = map.get(k); if (id === undefined) { id = np++; map.set(k, id); } ids[i] = id;
  }
  const acc = new Float32Array(np * 3), I = idx.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < I.length; t += 3) {
    a.fromBufferAttribute(P, I[t]); b.fromBufferAttribute(P, I[t + 1]); c.fromBufferAttribute(P, I[t + 2]);
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);       // |e1| = 2·area → area-weighted
    for (let k = 0; k < 3; k++) { const id = ids[I[t + k]] * 3; acc[id] += e1.x; acc[id + 1] += e1.y; acc[id + 2] += e1.z; }
  }
  const out = new Float32Array(n * 3), cosMax = Math.cos(creaseDeg * Math.PI / 180), v = new THREE.Vector3(), o = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const id = ids[i] * 3; v.set(acc[id], acc[id + 1], acc[id + 2]).normalize();
    o.fromBufferAttribute(N0, i).normalize();
    if (!(v.lengthSq() > 0.5) || v.dot(o) < cosMax) v.copy(o);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out, 3));
}

/**
 * One-time preparation of a loaded gltf (idempotent — cached on gltf.userData):
 * bone map, rest pose in rig space, proportions, material fix-up, added finger +
 * tail bones (weights re-assigned from the Hand / Hips bones).
 */
function prepRigModel(THREE, gltf, { fingers = true, tail = true, palmFacesBody = true } = {}) {
  if (gltf.userData && gltf.userData.__wcdRig) return gltf.userData.__wcdRig;
  const root = gltf.scene;
  root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  let mesh = null; const meshes = [];
  root.traverse(o => { if (o.isSkinnedMesh) { meshes.push(o); if (!mesh || o.geometry.attributes.position.count > mesh.geometry.attributes.position.count) mesh = o; } });
  if (!mesh) throw new Error('no skinned mesh');
  const byName = {};
  root.traverse(o => { if (o.isBone) { const n = o.name.replace(/^mixamorig[:_]?/i, ''); byName[n] = o; byName[n.toLowerCase()] = o; } });
  const bone = n => byName[n] || byName[n.toLowerCase()] || null;
  for (const n of RIG_BONES) if (!bone(n)) throw new Error('missing bone ' + n);
  const hips = bone('Hips'), arm = hips.parent;
  const armQ = new THREE.Quaternion(), armP = new THREE.Vector3(), armSv = new THREE.Vector3();
  arm.matrixWorld.decompose(armP, armQ, armSv);
  const armS = armSv.x;
  const R = { root, mesh, meshes, bones: {}, armQ, armQi: armQ.clone().invert(), armP, armS, rest: {}, M: {}, extra: {}, handFrame: {}, clips: gltf.animations || [] };
  const rest = R.rest;
  const addRest = (name, b) => {
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    b.matrixWorld.decompose(p, q, s);
    rest[name] = { lq: b.quaternion.clone(), lp: b.position.clone(), q, p, parent: null };
    R.bones[name] = b;
  };
  for (const n of RIG_BONES) addRest(n, bone(n));
  const parentName = n => { const par = R.bones[n].parent; for (const k in R.bones) if (R.bones[k] === par) return k; return null; };
  for (const n of RIG_BONES) rest[n].parent = parentName(n);
  // proportions
  const P = n => rest[n].p;
  const M = R.M;
  M.hipY = P('Hips').y; M.thigh = P('LeftUpLeg').distanceTo(P('LeftLeg')); M.shin = P('LeftLeg').distanceTo(P('LeftFoot'));
  M.uarm = P('LeftArm').distanceTo(P('LeftForeArm')); M.farm = P('LeftForeArm').distanceTo(P('LeftHand'));
  M.shY = (P('LeftArm').y + P('RightArm').y) / 2; M.shX = (P('LeftArm').x - P('RightArm').x) / 2;
  M.ankleY = (P('LeftFoot').y + P('RightFoot').y) / 2; M.ballY = (P('LeftToeBase').y + P('RightToeBase').y) / 2;
  M.hipW = (P('LeftUpLeg').x - P('RightUpLeg').x) / 2;
  M.headY = P('Head').y;
  // rest skinned vertex positions (rig space)
  const pos = mesh.geometry.attributes.position, N = pos.count;
  const vp = new Float32Array(N * 3), tv = new THREE.Vector3();
  for (let i = 0; i < N; i++) { mesh.getVertexPosition(i, tv); tv.applyMatrix4(mesh.matrixWorld); vp[i * 3] = tv.x; vp[i * 3 + 1] = tv.y; vp[i * 3 + 2] = tv.z; }
  let minY = 1e9, maxY = -1e9; for (let i = 0; i < N; i++) { minY = Math.min(minY, vp[i * 3 + 1]); maxY = Math.max(maxY, vp[i * 3 + 1]); }
  M.height = maxY - minY; M.minY = minY;
  for (const m of meshes) { try { smoothSplitNormals(THREE, m.geometry); } catch (e) { /* keep file normals */ } }
  // ---- materials: PBR that actually lights (Meshy ships emissive = base colour, metal 1)
  const rim = { value: new THREE.Color(0, 0, 0) };
  R.rim = rim;
  for (const m of meshes) {
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of mats) {
      if (!mt || !mt.isMeshStandardMaterial) continue;
      mt.metalness = 0; mt.roughness = 0.74; mt.emissive && mt.emissive.set(0x000000); mt.emissiveMap = null; mt.emissiveIntensity = 0;
      mt.envMapIntensity = 0.85; mt.side = THREE.FrontSide;
      if (mt.map) { mt.map.anisotropy = 4; mt.map.colorSpace = THREE.SRGBColorSpace; }
      mt.onBeforeCompile = sh => {
        sh.uniforms.uRim = rim;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float fr = 1.0 - saturate(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += uRim * (fr * fr * fr) * (0.35 + 0.65 * saturate(normal.y + 0.6)); }');
      };
      mt.customProgramCacheKey = () => 'wcd-fox-rim';
      mt.needsUpdate = true;
    }
  }
  // ---- skin augmentation
  const sk = mesh.skeleton;
  const idx = n => sk.bones.indexOf(R.bones[n]);
  const siA = mesh.geometry.attributes.skinIndex, swA = mesh.geometry.attributes.skinWeight;
  // influences in typed arrays (4 per vertex); small [bone, w] lists only for vertices we touch
  const IJ = new Uint16Array(N * 4), IW = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { IJ[i * 4] = siA.getX(i); IJ[i * 4 + 1] = siA.getY(i); IJ[i * 4 + 2] = siA.getZ(i); IJ[i * 4 + 3] = siA.getW(i); IW[i * 4] = swA.getX(i); IW[i * 4 + 1] = swA.getY(i); IW[i * 4 + 2] = swA.getZ(i); IW[i * 4 + 3] = swA.getW(i); }
  const infOf = i => [[IJ[i * 4], IW[i * 4]], [IJ[i * 4 + 1], IW[i * 4 + 1]], [IJ[i * 4 + 2], IW[i * 4 + 2]], [IJ[i * 4 + 3], IW[i * 4 + 3]]];
  const wOf = (i, b) => { let w = 0; for (let k = 0; k < 4; k++) if (IJ[i * 4 + k] === b) w += IW[i * 4 + k]; return w; };
  const bonesArr = sk.bones.slice(), inverses = sk.boneInverses.map(m => m.clone());
  const addBone = (name, parentBoneName, rigPos) => {
    const par = R.bones[parentBoneName] || R.extra[parentBoneName];
    const b = new THREE.Bone(); b.name = 'wcd_' + name;
    // local position: parent-local of the rig-space point (parent at rest)
    const lp = rigPos.clone(); par.updateMatrixWorld(true); par.worldToLocal(lp);
    b.position.copy(lp); par.add(b); b.updateMatrixWorld(true);
    const parIdx = bonesArr.indexOf(par);
    const inv = new THREE.Matrix4().makeTranslation(-lp.x, -lp.y, -lp.z).multiply(inverses[parIdx]);
    bonesArr.push(b); inverses.push(inv);
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(); b.matrixWorld.decompose(p, q, s);
    rest[name] = { lq: b.quaternion.clone(), lp: b.position.clone(), q, p, parent: R.bones[parentBoneName] ? parentBoneName : parentBoneName };
    R.extra[name] = b; R.bones[name] = b;
    return bonesArr.length - 1;
  };
  const setInf = (i, list) => { // list [[bone,w]] → keep top 4, renormalise
    list.sort((a, b) => b[1] - a[1]); let s = 0; for (let k = 0; k < 4 && k < list.length; k++) s += list[k][1];
    for (let k = 0; k < 4; k++) { const e = list[k]; IJ[i * 4 + k] = e ? e[0] : 0; IW[i * 4 + k] = e && s > 0 ? e[1] / s : 0; }
  };
  const reassign = (i, fromBone, parts) => { // move fraction of fromBone's weight onto parts [[bone, frac]]
    const map = new Map(); for (let k = 0; k < 4; k++) { const j = IJ[i * 4 + k], w = IW[i * 4 + k]; if (w > 0) map.set(j, (map.get(j) || 0) + w); }
    const w0 = map.get(fromBone) || 0; if (w0 <= 0) return;
    let used = 0; for (const [b, f] of parts) { if (f <= 0) continue; map.set(b, (map.get(b) || 0) + w0 * f); used += f; }
    map.set(fromBone, w0 * Math.max(0, 1 - used));
    setInf(i, [...map.entries()]);
  };
  let changed = false;
  // hand frames (always computed: used for grip / ball / glove placement)
  for (const side of ['Left', 'Right']) {
    const hb = idx(side + 'Hand'), W0 = rest[side + 'Hand'].p;
    let n = 0; const c = [0, 0, 0]; const pts = [];
    for (let i = 0; i < N; i++) if (wOf(i, hb) > 0.5) { const x = vp[i * 3] - W0.x, y = vp[i * 3 + 1] - W0.y, z = vp[i * 3 + 2] - W0.z; pts.push(i); c[0] += x; c[1] += y; c[2] += z; n++; }
    const fr = { f: new THREE.Vector3(0, -1, 0), p: new THREE.Vector3(side === 'Left' ? -1 : 1, 0, 0), len: 0.17, n };
    if (n > 30) {
      c[0] /= n; c[1] /= n; c[2] /= n;
      const cov = [0, 0, 0, 0, 0, 0];
      for (const i of pts) { const x = vp[i * 3] - W0.x - c[0], y = vp[i * 3 + 1] - W0.y - c[1], z = vp[i * 3 + 2] - W0.z - c[2]; cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z; }
      const e = eigSym3(cov);
      const f = new THREE.Vector3(...e[0].vec); if (f.dot(new THREE.Vector3(...c)) < 0) f.negate();
      // finger direction: blend the principal axis with the forearm axis (robust for chunky gloves)
      const fa = new THREE.Vector3().subVectors(W0, rest[side + 'ForeArm'].p).normalize();
      f.lerp(fa, 0.35).normalize();
      const p = new THREE.Vector3(...e[2].vec); p.addScaledVector(f, -p.dot(f)).normalize();
      if (palmFacesBody) { if (p.x * (side === 'Left' ? 1 : -1) > 0) p.negate(); }      // palm toward the body midline
      else if (p.z < 0) p.negate();                                                         // palm forward (pads to camera)
      let len = 0; for (const i of pts) { const s = (vp[i * 3] - W0.x) * f.x + (vp[i * 3 + 1] - W0.y) * f.y + (vp[i * 3 + 2] - W0.z) * f.z; if (s > len) len = s; }
      fr.f.copy(f); fr.p.copy(p); fr.len = len;
    }
    R.handFrame[side] = fr;
    if (fingers && n > 30) {
      // knuckle line at ~52% of the hand length; two segments; thumb side excluded (thumb dir = ±f×p by chirality)
      const f = fr.f, p = fr.p, t = side === 'Right' ? new THREE.Vector3().crossVectors(f, p) : new THREE.Vector3().crossVectors(p, f);
      const kn = fr.len * 0.5, k2 = fr.len * 0.74;
      const b1 = addBone(side + 'Fing1', side + 'Hand', W0.clone().addScaledVector(f, kn).addScaledVector(p, 0.004));
      const b2 = addBone(side + 'Fing2', side + 'Fing1', W0.clone().addScaledVector(f, k2).addScaledVector(p, 0.004));
      // thumb lateral extent → exclusion threshold
      let tMax = 0; for (let i = 0; i < N; i++) if (wOf(i, hb) > 0.3) { const x = vp[i * 3] - W0.x, y = vp[i * 3 + 1] - W0.y, z = vp[i * 3 + 2] - W0.z; tMax = Math.max(tMax, x * t.x + y * t.y + z * t.z); }
      const b3 = addBone(side + 'Thumb', side + 'Hand', W0.clone().addScaledVector(f, fr.len * 0.22).addScaledVector(t, tMax * 0.35).addScaledVector(p, 0.006));
      fr.t = t.clone(); fr.tMax = tMax;
      for (let i = 0; i < N; i++) {
        if (wOf(i, hb) <= 0.05) continue;
        const x = vp[i * 3] - W0.x, y = vp[i * 3 + 1] - W0.y, z = vp[i * 3 + 2] - W0.z;
        const s = x * f.x + y * f.y + z * f.z, lat = x * t.x + y * t.y + z * t.z;
        const thumbK = 1 - smooth01((lat - tMax * 0.45) / (tMax * 0.25 + 1e-4));        // 0 on the thumb
        const c1 = smooth01((s - kn + 0.012) / 0.024) * thumbK, c2 = smooth01((s - k2 + 0.01) / 0.02) * thumbK;
        const th = (1 - thumbK) * smooth01((s - fr.len * 0.16) / (fr.len * 0.12));
        if (c1 > 0.001 || th > 0.001) { reassign(i, hb, [[b1, c1 - c2], [b2, c2], [b3, th]]); changed = true; }
      }
    }
  }
  // below the hip joint nothing should follow the spine/arms (Meshy sometimes binds the seat/tail to Spine)
  {
    const hipsI = idx('Hips'), H0y = rest.Hips.p.y;
    const upper = new Set(['Spine02', 'Spine01', 'Spine', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'neck', 'Head'].map(idx));
    for (let i = 0; i < N; i++) {
      const y = vp[i * 3 + 1]; if (y > H0y - 0.03) continue;
      let moved = 0, any = false;
      for (let k = 0; k < 4; k++) if (IW[i * 4 + k] > 0 && upper.has(IJ[i * 4 + k])) { any = true; break; }
      if (!any) continue;
      const list = [];
      for (const [j, w] of infOf(i)) { if (w <= 0) continue; if (upper.has(j)) moved += w; else list.push([j, w]); }
      if (moved > 0) { list.push([hipsI, moved]); setInf(i, list); changed = true; }
    }
  }
  if (tail) {
    // tail = midline vertices below the crotch that are NOT bound to a leg
    const hb = idx('Hips'), H0 = rest.Hips.p;
    const legs = new Set(['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'].map(idx));
    const crotchY = Math.min(rest.LeftUpLeg.p.y, rest.RightUpLeg.p.y) - 0.04;
    const cand = [];
    for (let i = 0; i < N; i++) {
      const y = vp[i * 3 + 1], x = vp[i * 3];
      if (y > crotchY + 0.03 || y < 0.05 || Math.abs(x - H0.x) > 0.13) continue;
      let legW = 0; for (let k = 0; k < 4; k++) if (legs.has(IJ[i * 4 + k])) legW += IW[i * 4 + k];
      const core = Math.abs(x - H0.x) < 0.06 && y < crotchY - 0.08;       // legs never occupy the midline down there
      if (legW > 0.35 && !(core && legW < 0.85)) continue;
      cand.push(i);
    }
    if (cand.length > 150) {
      let yMin = 1e9; for (const i of cand) yMin = Math.min(yMin, vp[i * 3 + 1]);
      const band = (y0, y1) => { const c = new THREE.Vector3(); let n = 0; for (const i of cand) { const y = vp[i * 3 + 1]; if (y >= y0 && y <= y1) { c.x += vp[i * 3]; c.y += y; c.z += vp[i * 3 + 2]; n++; } } return n ? c.divideScalar(n) : null; };
      const yTop = crotchY + 0.06, Lt = Math.max(0.2, yTop - yMin);
      const r0 = band(crotchY - 0.1, crotchY + 0.03) || new THREE.Vector3(H0.x, yTop, H0.z - 0.12);
      const r1 = band(yTop - Lt * 0.5, yTop - Lt * 0.36) || r0.clone().add(new THREE.Vector3(0, -Lt * 0.42, -0.04));
      const r2 = band(yTop - Lt * 0.8, yTop - Lt * 0.66) || r1.clone().add(new THREE.Vector3(0, -Lt * 0.3, 0));
      const t0 = addBone('Tail0', 'Hips', new THREE.Vector3(r0.x, yTop, r0.z));
      const t1 = addBone('Tail1', 'Tail0', r1);
      const t2 = addBone('Tail2', 'Tail1', r2);
      const u1 = (yTop - r1.y) / Lt, u2 = (yTop - r2.y) / Lt;
      for (const i of cand) {
        const y = vp[i * 3 + 1], u = clamp((yTop - y) / Lt, 0, 1);
        const rootK = smooth01((crotchY + 0.03 - y) / 0.1);   // blend into the seat near the root
        let a0, a1, a2;
        if (u < u1) { const k = u / u1; a0 = 1 - k; a1 = k; a2 = 0; } else if (u < u2) { const k = (u - u1) / (u2 - u1); a0 = 0; a1 = 1 - k; a2 = k; } else { a0 = 0; a1 = 0; a2 = 1; }
        // everything non-leg on these vertices → Hips first, then share onto the tail chain
        const list = []; let other = 0;
        for (const [j, w] of infOf(i)) { if (w <= 0) continue; if (legs.has(j)) list.push([j, w]); else other += w; }
        list.push([hb, other]); setInf(i, list);
        reassign(i, hb, [[t0, a0 * rootK], [t1, a1 * rootK], [t2, a2 * rootK]]);
      }
      R.tail = { len: Lt, n: cand.length };
      changed = true;
    }
  }
  if (changed) {
    mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(IJ, 4));
    mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(IW, 4));
    const skel = new THREE.Skeleton(bonesArr, inverses);
    mesh.bind(skel, mesh.bindMatrix);
    for (const m of meshes) if (m !== mesh && m.skeleton === sk) m.bind(skel, m.bindMatrix);
  }
  // rest local transforms for every bone (to restore)
  R.restLocals = [];
  mesh.skeleton.bones.forEach(b => R.restLocals.push([b, b.position.clone(), b.quaternion.clone()]));
  gltf.userData = gltf.userData || {};
  gltf.userData.__wcdRig = R;
  return R;
}

/**
 * Per-frame solver bound to a prepared model. solve(P, mirror) takes a pose in
 * RHB rig space (see makePose) and writes bone locals. Units: metres (rig).
 */
function createRigSolver(THREE, R) {
  const V = () => new THREE.Vector3(), Qn = () => new THREE.Quaternion();
  const rq = {}, rp = {};
  for (const n in R.rest) { rq[n] = Qn(); rp[n] = V(); }
  const rest = R.rest, B = R.bones, armS = R.armS;
  const t1 = V(), t2 = V(), t3 = V(), t4 = V(), t5 = V(), t6 = V(), t7 = V();
  const q1 = Qn(), q2 = Qn(), q3 = Qn(), q4 = Qn(), qI = Qn();
  const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
  const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
  const eu = (out, yaw, pitch, roll) => { // Ry(yaw)·Rx(pitch)·Rz(roll)
    q1.setFromAxisAngle(Y, yaw); q2.setFromAxisAngle(X, pitch); q3.setFromAxisAngle(Z, roll);
    return out.copy(q1).multiply(q2).multiply(q3);
  };
  // frame(x-axis a, y-axis b) → quaternion (b is the primary axis)
  const frameQ = (out, yAxis, xHint) => {
    t6.copy(xHint).addScaledVector(yAxis, -xHint.dot(yAxis));
    if (t6.lengthSq() < 1e-10) t6.set(1, 0, 0).addScaledVector(yAxis, -yAxis.x);
    t6.normalize(); t7.crossVectors(t6, yAxis);
    m1.makeBasis(t6, yAxis, t7); return out.setFromRotationMatrix(m1);
  };
  const deltaQ = (out, y0, x0, y1, x1) => { frameQ(q4, y0, x0); frameQ(out, y1, x1); return out.multiply(q4.invert()); };
  function setRig(name, q) {
    rq[name].copy(q);
    const r = rest[name], par = r.parent;
    const b = B[name];
    if (!par) { // Hips: parent is the armature
      b.quaternion.copy(R.armQi).multiply(q);
    } else {
      b.quaternion.copy(rq[par]).invert().multiply(q);
      rp[name].copy(r.lp).multiplyScalar(armS).applyQuaternion(rq[par]).add(rp[par]);
    }
  }
  function setHips(q, pos) {
    rq.Hips.copy(q); rp.Hips.copy(pos);
    B.Hips.quaternion.copy(R.armQi).multiply(q);
    t1.copy(pos).sub(R.armP).applyQuaternion(R.armQi).divideScalar(armS);
    B.Hips.position.copy(t1);
  }
  const deltaSet = (name, dq) => { q1.copy(dq).multiply(rest[name].q); setRig(name, q1); };
  /** two-bone IK. A root joint, C target, poleDir = where the middle joint should point. Returns middle joint pos in out. */
  function ik2(A, C, l1, l2, poleDir, out, bend) {
    t1.subVectors(C, A); let d = t1.length(); const dMax = (l1 + l2) * 0.9995, dMin = Math.abs(l1 - l2) + 1e-4;
    if (d > dMax) { t1.multiplyScalar(dMax / d); d = dMax; } if (d < dMin) { t1.multiplyScalar(dMin / Math.max(d, 1e-6)); d = dMin; }
    t1.divideScalar(d);
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    bend.copy(poleDir).addScaledVector(t1, -poleDir.dot(t1));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).addScaledVector(t1, -t1.z);
    bend.normalize();
    return out.copy(A).addScaledVector(t1, a).addScaledVector(bend, h);
  }
  const _E = V(), _bend = V(), _d = V(), _n = V(), _d0 = V(), _n0 = V(), _b0 = V(), _Cc = V();
  /** solve a 2-bone chain: names [root, mid, end]; target position for end joint; pole; restBend (rig dir the mid joint points when bent) */
  function chain(n0, n1, n2, target, pole, restBend, parentDelta) {
    const A = rp[n0], l1 = rest[n0].p.distanceTo(rest[n1].p), l2 = rest[n1].p.distanceTo(rest[n2].p);
    ik2(A, target, l1, l2, pole, _E, _bend);
    // upper bone
    _d0.subVectors(rest[n1].p, rest[n0].p).normalize(); _b0.copy(restBend).addScaledVector(_d0, -restBend.dot(_d0)).normalize();
    _n0.crossVectors(_d0, _b0);
    _d.subVectors(_E, A).normalize(); _n.crossVectors(_d, _bend).normalize();
    deltaQ(q3, _d0, _n0, _d, _n); deltaSet(n0, q3);
    // lower bone
    _d0.subVectors(rest[n2].p, rest[n1].p).normalize(); _b0.copy(restBend).addScaledVector(_d0, -restBend.dot(_d0)).normalize();
    _n0.crossVectors(_d0, _b0);
    rp[n1].copy(rest[n1].lp).multiplyScalar(armS).applyQuaternion(rq[n0]).add(rp[n0]);   // fresh mid joint (FK)
    _Cc.copy(target); t2.subVectors(_Cc, rp[n1]); if (t2.lengthSq() < 1e-10) t2.copy(_d);
    _d.copy(t2).normalize(); _n.crossVectors(_d, _bend).normalize();
    if (_n.lengthSq() < 1e-8) _n.copy(_n0);
    deltaQ(q3, _d0, _n0, _d, _n); deltaSet(n1, q3);
    return _E;
  }
  // forearm twist share: rotate `mid` about its own +Y by frac of the end bone's local twist
  function shareTwist(mid, end, frac) {
    q1.copy(rq[mid]).invert().multiply(rq[end]);            // end local (w.r.t. mid)
    q2.set(0, q1.y, 0, q1.w); if (q2.lengthSq() < 1e-10) return; q2.normalize();
    qI.identity().slerp(q2, frac);
    q3.copy(rq[mid]).multiply(qI); setRig(mid, q3); setRig(end, rq[end]);
  }
  const S = {}; for (const k of ['F', 'B']) S[k] = {};
  const _grip = V(), _a = V(), _f = V(), _p = V(), _W = V(), _hint = V(), _pole = V(), _tmp = V(), _ank = V(), _look = V();
  const _qP = Qn(), _qC = Qn(), _qH = Qn(), _qS = Qn();
  const mirrorV = (out, v, mir) => out.set(mir ? -v[0] : v[0], v[1], v[2]);
  const RB = V().set(0, 0, -1), RK = V().set(0, 0, 1);
  const bat = { knob: V(), dir: V(), up: V(), q: Qn(), top: V(), bot: V() };
  const _hq = Qn(), _hq2 = Qn(), _bq = Qn(), _relQ = Qn(), _relP = V();
  /** hand frame for a grip on the bat (hammer grip, thumb → barrel) */
  function gripFrame(side, a, gripPt, shoulder, elbowPole, roll, outW, outQ) {
    const HF = R.handFrame[side];
    const l1 = rest[side + 'Arm'].p.distanceTo(rest[side + 'ForeArm'].p);
    // forearm estimate: from the approximate elbow to the grip
    _hint.copy(gripPt).sub(t5.copy(shoulder).addScaledVector(elbowPole, l1 * 0.85));
    _f.copy(_hint).addScaledVector(a, -_hint.dot(a));
    if (_f.lengthSq() < 1e-8) _f.set(0, -1, 0).addScaledVector(a, a.y);
    _f.normalize();
    if (roll) { q1.setFromAxisAngle(a, roll); _f.applyQuaternion(q1); }
    if (side === 'Right') _p.crossVectors(a, _f); else _p.crossVectors(_f, a);
    _p.normalize();
    const palmLen = HF.len * 0.52, palmOff = 0.028;
    outW.copy(gripPt).addScaledVector(_f, -palmLen).addScaledVector(_p, -palmOff);
    // Δ from rest hand frame (f0, p0) → (f, p)
    deltaQ(q2, HF.f, HF.p, _f, _p);
    outQ.copy(q2).multiply(rest[side + 'Hand'].q);
    return outQ;
  }
  const lookRest = { f: V(), u: V() };
  lookRest.f.subVectors(rest.headfront.p, rest.Head.p).setY(0).normalize();
  if (lookRest.f.lengthSq() < 0.5) lookRest.f.set(0, 0, 1);
  lookRest.u.set(0, 1, 0);
  const tailSt = { s: 0, l: 0 };
  const dbg = { topTarget: V(), botTarget: V() };

  /**
   * P: pose (RHB rig space). mir: mirror for a left-handed batter.
   * batLen / gripBot / gripTop in rig metres (distance from knob).
   */
  function solve(P, mir, opt) {
    const sg = mir ? -1 : 1;
    const Fs = mir ? 'Right' : 'Left', Bs = mir ? 'Left' : 'Right';
    // ---- pelvis
    eu(_qP, sg * P.pelYaw, P.pelPitch, sg * P.pelRoll);
    q4.copy(_qP).multiply(rest.Hips.q);
    mirrorV(_tmp, P.pel, mir); _tmp.add(rest.Hips.p);
    // keep both legs reachable: auto-drop the pelvis if an ankle target is out of reach
    let drop = 0;
    for (const [side, ft] of [[Fs, P.fF], [Bs, P.fB]]) {
      footAnkle(side, ft, mir, _ank);
      // hip joint position under the tentative pelvis
      t3.copy(rest[side + 'UpLeg'].p).sub(rest.Hips.p).applyQuaternion(_qP).add(_tmp);
      const L = (rest[side + 'UpLeg'].p.distanceTo(rest[side + 'Leg'].p) + rest[side + 'Leg'].p.distanceTo(rest[side + 'Foot'].p)) * 0.985;
      const dx = Math.hypot(_ank.x - t3.x, _ank.z - t3.z), dy = t3.y - _ank.y;
      if (dx < L) { const need = dy - Math.sqrt(L * L - dx * dx); if (need > drop) drop = need; }
    }
    _tmp.y -= drop;
    setHips(q4, _tmp);
    // ---- legs
    for (const [side, ft, kp] of [[Fs, P.fF, P.kF], [Bs, P.fB, P.kB]]) {
      footAnkle(side, ft, mir, _ank);
      setRig(side + 'UpLeg', q4.copy(rq.Hips).multiply(q1.copy(rest.Hips.q).invert()).multiply(rest[side + 'UpLeg'].q)); // provisional (for rp)
      mirrorV(_pole, kp, mir).normalize();
      chain(side + 'UpLeg', side + 'Leg', side + 'Foot', _ank, _pole, RK);
      // foot + toe
      eu(q1, sg * ft.yaw, 0, 0); q2.setFromAxisAngle(X, ft.heel); q3.copy(q1).multiply(q2);
      q4.copy(q3).multiply(rest[side + 'Foot'].q); setRig(side + 'Foot', q4);
      q4.copy(q1).multiply(rest[side + 'ToeBase'].q); setRig(side + 'ToeBase', q4);
    }
    // ---- spine
    eu(_qC, sg * P.chYaw, P.chPitch, sg * P.chRoll);
    _qS.copy(_qP).slerp(_qC, 0.38); deltaSet('Spine02', _qS);
    _qS.copy(_qP).slerp(_qC, 0.72); deltaSet('Spine01', _qS);
    deltaSet('Spine', _qC);
    // ---- neck / head: look-at with eyes level
    rp.neck.copy(rest.neck.lp).multiplyScalar(armS).applyQuaternion(rq[rest.neck.parent]).add(rp[rest.neck.parent]);   // fresh neck joint
    if (P.look) {
      mirrorV(_look, P.look, mir);
      t1.subVectors(_look, rp.neck); t1.y -= 0.08; t1.normalize();
      // clamp relative to the chest facing
      t2.copy(Z).applyQuaternion(_qC); t2.y = 0; t2.normalize();
      const yawRel = Math.atan2(t1.x * t2.z - t1.z * t2.x, t1.x * t2.x + t1.z * t2.z);
      const lim = 1.75;
      if (Math.abs(yawRel) > lim) { const k = (Math.abs(yawRel) - lim) * Math.sign(yawRel); q1.setFromAxisAngle(Y, -k); t1.applyQuaternion(q1); }
      t1.y = clamp(t1.y, -0.8, 0.6); t1.normalize();
      _hint.copy(Y).addScaledVector(t1, -t1.y).normalize();
      // tilt (head roll) from the pose
      if (P.headRoll) { q1.setFromAxisAngle(t1, sg * P.headRoll); _hint.applyQuaternion(q1); }
      frameQ(q1, lookRest.u, lookRest.f); // rest: up primary, forward hint
      frameQ(q2, _hint, t1);
      _qH.copy(q2).multiply(q1.invert());
      _qH.slerp(_qC, 1 - (P.lookW ?? 1));
    } else _qH.copy(_qC);
    _qS.copy(_qC).slerp(_qH, 0.45); deltaSet('neck', _qS);
    deltaSet('Head', _qH);
    // ---- clavicles follow the chest (+ a little reach toward the hands)
    deltaSet('LeftShoulder', _qC); deltaSet('RightShoulder', _qC);
    for (const a of ['LeftArm', 'RightArm']) rp[a].copy(rest[a].lp).multiplyScalar(armS).applyQuaternion(rq[rest[a].parent]).add(rp[rest[a].parent]);   // fresh shoulder joints
    // ---- bat + arms
    const BL = opt.batLen, gB = opt.gripBot, gT = opt.gripTop;
    const topW = P.topOn ?? 1, botW = P.botOn ?? 1;
    mirrorV(_a, P.bat, mir).normalize();
    mirrorV(_grip, P.grip, mir);                  // bottom-hand grip point
    bat.knob.copy(_grip).addScaledVector(_a, -gB);
    const Ts = Bs, Bh = Fs;                       // top hand = back side, bottom hand = front side
    // top hand
    const topGrip = t4.copy(bat.knob).addScaledVector(_a, gT);
    mirrorV(_pole, P.eB, mir).normalize();
    gripFrame(Ts, _a, topGrip, rp[Ts + 'Arm'], _pole, (P.rollB || 0) * sg, _W, _hq);
    if (topW < 1 && P.freeB) { mirrorV(t5, P.freeB, mir); _W.lerp(t5, 1 - topW); }
    reach(Ts, _W, _pole);
    chain(Ts + 'Arm', Ts + 'ForeArm', Ts + 'Hand', _W, _pole, RB);
    dbg.topTarget.copy(_W);
    if (topW < 1) { q1.copy(rq[Ts + 'ForeArm']).multiply(q2.copy(rest[Ts + 'ForeArm'].q).invert()).multiply(rest[Ts + 'Hand'].q); _hq.slerp(q1, 1 - topW); }
    setRig(Ts + 'Hand', _hq); shareTwist(Ts + 'ForeArm', Ts + 'Hand', 0.55);
    // the bat rides the top hand when it's on the bat (grip never separates)
    if (!opt.batFree) {
      if (topW >= 0.999) {
        // relative bat pose to the top hand from the target frames; re-derive from the solved hand
        _relP.copy(bat.knob).sub(_W); q1.copy(_hq).invert(); _relP.applyQuaternion(q1);
        const solvedW = rp[Ts + 'Hand'];
        _relQ.copy(q1); // hand⁻¹
        t5.copy(_relP).applyQuaternion(rq[Ts + 'Hand']).add(solvedW);
        bat.knob.copy(t5);
        _a.applyQuaternion(_relQ).applyQuaternion(rq[Ts + 'Hand']).normalize();
      }
    }
    bat.dir.copy(_a);
    // bottom hand
    const botGrip = t4.copy(bat.knob).addScaledVector(_a, gB);
    mirrorV(_pole, P.eF, mir).normalize();
    gripFrame(Bh, _a, botGrip, rp[Bh + 'Arm'], _pole, (P.rollF || 0) * sg, _W, _hq2);
    if (botW < 1 && P.freeF) { mirrorV(t5, P.freeF, mir); _W.lerp(t5, 1 - botW); }
    reach(Bh, _W, _pole);
    chain(Bh + 'Arm', Bh + 'ForeArm', Bh + 'Hand', _W, _pole, RB);
    dbg.botTarget.copy(_W);
    if (botW < 1) { q1.copy(rq[Bh + 'ForeArm']).multiply(q2.copy(rest[Bh + 'ForeArm'].q).invert()).multiply(rest[Bh + 'Hand'].q); _hq2.slerp(q1, 1 - botW); }
    setRig(Bh + 'Hand', _hq2); shareTwist(Bh + 'ForeArm', Bh + 'Hand', 0.55);
    // fingers
    for (const [side, g] of [[Ts, (P.curlB ?? 1) * topW], [Bh, (P.curlF ?? 1) * botW]]) curl(side, g);
    // bat orientation quaternion (bat mesh +Y = axis)
    bat.q.setFromUnitVectors(Y, bat.dir);
    // ---- tail
    if (R.bones.Tail0) {
      const s = P.tailS || 0, l = P.tailL || 0;
      for (let i = 0; i < 3; i++) {
        // cumulative chain: each segment adds its share on top of its parent's delta
        const n = 'Tail' + i, k = (i + 1) / 3, par = rest[n].parent;
        // the root rides the pelvis; the lower segments hang back toward gravity (undo most of the pelvis pitch)
        const parDelta = q4.copy(rq[par]).multiply(q2.copy(rest[par].q).invert());
        q1.setFromAxisAngle(Z, sg * s * 0.45 * k); q2.setFromAxisAngle(X, l * 0.3 + (i === 0 ? 0.04 : -P.pelPitch * (i === 1 ? 0.55 : 0.3)));
        q3.copy(parDelta).multiply(q1).multiply(q2);
        deltaSet(n, q3);
      }
    }
    return bat;
  }
  function reach(side, W, pole) { // clavicle: rotate a little toward the wrist target
    const sh = side + 'Shoulder', a = side + 'Arm';
    t1.subVectors(rp[a], rp[sh]).normalize();
    t2.subVectors(W, rp[sh]).normalize();
    q1.setFromUnitVectors(t1, t2); const ang = 2 * Math.acos(clamp(q1.w, -1, 1)); qI.identity().slerp(q1, Math.min(0.14, 0.26 / Math.max(ang, 1e-3)));
    q2.copy(qI).multiply(rq[sh]); setRig(sh, q2); setRig(a, rq[a]);
    // re-derive the arm root position from the new clavicle
    rp[a].copy(rest[a].lp).multiplyScalar(armS).applyQuaternion(rq[sh]).add(rp[sh]);
  }
  function curl(side, g) {
    const f1 = side + 'Fing1', f2 = side + 'Fing2';
    if (!B[f1]) return;
    const HF = R.handFrame[side];
    // curl axis in hand-local space: rest (f × p) expressed in the hand's rest frame
    t1.crossVectors(HF.f, HF.p).normalize().applyQuaternion(q1.copy(rest[side + 'Hand'].q).invert());
    q2.setFromAxisAngle(t1, 1.45 * g + 0.12); B[f1].quaternion.copy(q2);
    q3.setFromAxisAngle(t1, 1.25 * g + 0.1); B[f2].quaternion.copy(q3);
    if (B[side + 'Thumb'] && HF.t) { // thumb wraps over the handle: rotate about (t × p)
      t2.crossVectors(HF.t, HF.p).normalize().applyQuaternion(q1);
      q2.setFromAxisAngle(t2, 1.15 * g); B[side + 'Thumb'].quaternion.copy(q2);
    }
  }
  const _fq = Qn(), _fv = V();
  function footAnkle(side, ft, mir, out) {
    // ankle = ball + R(yaw, heel) · (restAnkle − restBall)
    const sg = mir ? -1 : 1;
    eu(_fq, sg * ft.yaw, 0, 0); q2.setFromAxisAngle(X, ft.heel); _fq.multiply(q2);
    _fv.subVectors(rest[side + 'Foot'].p, rest[side + 'ToeBase'].p).applyQuaternion(_fq);
    out.set(mir ? -ft.b[0] : ft.b[0], ft.b[1], ft.b[2]).add(_fv);
    return out;
  }
  function restPose() { for (const [b, p, q] of R.restLocals) { b.position.copy(p); b.quaternion.copy(q); } }
  return { solve, restPose, rq, rp, bat, dbg };
}

// ---------------------------------------------------------------------------
// Pose (RHB rig space). Vectors are [x,y,z] arrays; directions need not be unit.
// ---------------------------------------------------------------------------
const POSE_V = ['pel', 'grip', 'bat', 'kF', 'kB', 'eF', 'eB', 'look', 'freeF', 'freeB'];
const POSE_N = ['pelYaw', 'pelPitch', 'pelRoll', 'chYaw', 'chPitch', 'chRoll', 'lookW', 'headRoll', 'rollF', 'rollB', 'topOn', 'botOn', 'curlF', 'curlB', 'tailS', 'tailL'];
const FOOT_N = ['yaw', 'heel'];
function makePose() {
  const p = {};
  for (const k of POSE_V) p[k] = [0, 0, 0];
  for (const k of POSE_N) p[k] = 0;
  p.lookW = 1; p.topOn = 1; p.botOn = 1; p.curlF = 1; p.curlB = 1;
  p.fF = { b: [0, 0, 0], yaw: 0, heel: 0 }; p.fB = { b: [0, 0, 0], yaw: 0, heel: 0 };
  return p;
}
function copyPose(o, a) {
  for (const k of POSE_V) { o[k][0] = a[k][0]; o[k][1] = a[k][1]; o[k][2] = a[k][2]; }
  for (const k of POSE_N) o[k] = a[k];
  for (const f of ['fF', 'fB']) { o[f].b[0] = a[f].b[0]; o[f].b[1] = a[f].b[1]; o[f].b[2] = a[f].b[2]; o[f].yaw = a[f].yaw; o[f].heel = a[f].heel; }
  return o;
}
function lerpPoseR(o, a, b, k) {
  for (const key of POSE_V) { const A = a[key], Bv = b[key], O = o[key]; O[0] = A[0] + (Bv[0] - A[0]) * k; O[1] = A[1] + (Bv[1] - A[1]) * k; O[2] = A[2] + (Bv[2] - A[2]) * k; }
  for (const key of POSE_N) o[key] = a[key] + (b[key] - a[key]) * k;
  for (const f of ['fF', 'fB']) { const A = a[f], Bf = b[f], O = o[f]; for (let i = 0; i < 3; i++) O.b[i] = A.b[i] + (Bf.b[i] - A.b[i]) * k; O.yaw = A.yaw + (Bf.yaw - A.yaw) * k; O.heel = A.heel + (Bf.heel - A.heel) * k; }
  return o;
}
/** uniform Catmull-Rom over pose keys (C1 across keys); s ∈ [0, keys.length-1] */
function catmullPose(o, keys, s) {
  const n = keys.length; s = clamp(s, 0, n - 1);
  const i = Math.min(n - 2, Math.floor(s)), f = s - i;
  const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(n - 1, i + 2)];
  const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
  for (const key of POSE_V) for (let j = 0; j < 3; j++) o[key][j] = cr(p0[key][j], p1[key][j], p2[key][j], p3[key][j]);
  for (const key of POSE_N) o[key] = cr(p0[key], p1[key], p2[key], p3[key]);
  for (const ff of ['fF', 'fB']) { for (let j = 0; j < 3; j++) o[ff].b[j] = cr(p0[ff].b[j], p1[ff].b[j], p2[ff].b[j], p3[ff].b[j]); o[ff].yaw = cr(p0[ff].yaw, p1[ff].yaw, p2[ff].yaw, p3[ff].yaw); o[ff].heel = cr(p0[ff].heel, p1[ff].heel, p2[ff].heel, p3[ff].heel); }
  return o;
}
const v3n = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; return a; };
const v3slerp = (o, a, b, k) => { // on unit vectors
  const A = v3n(a.slice()), Bv = v3n(b.slice());
  let d = clamp(A[0] * Bv[0] + A[1] * Bv[1] + A[2] * Bv[2], -1, 1);
  const th = Math.acos(d);
  if (th < 1e-4) { o[0] = A[0]; o[1] = A[1]; o[2] = A[2]; return o; }
  const s = Math.sin(th), wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
  o[0] = A[0] * wa + Bv[0] * wb; o[1] = A[1] * wa + Bv[1] * wb; o[2] = A[2] * wa + Bv[2] * wb; return o;
};
const rotAbout = (o, v, n, th) => { // Rodrigues, n unit
  const c = Math.cos(th), s = Math.sin(th), d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const cx = n[1] * v[2] - n[2] * v[1], cy = n[2] * v[0] - n[0] * v[2], cz = n[0] * v[1] - n[1] * v[0];
  o[0] = v[0] * c + cx * s + n[0] * d * (1 - c); o[1] = v[1] * c + cy * s + n[1] * d * (1 - c); o[2] = v[2] * c + cz * s + n[2] * d * (1 - c); return o;
};

// ---------------------------------------------------------------------------
// Wooden bat: lathe profile (34", knob, taper, cupped barrel), grain + lacquer.
// Geometry in rig metres along +Y from the knob.
// ---------------------------------------------------------------------------
const BAT_STYLE = {
  rocco: { barrel: '#1b1b1f', handle: '#101013', grain: 0.25, tape: '#caa23c' },
  jett: { barrel: '#d8b27a', handle: '#d8b27a', grain: 1, tape: '#2a2f38' },
  dex: { barrel: '#e3c48e', handle: '#e3c48e', grain: 1, tape: '#2b3a2a' },
  blaze: { barrel: '#d6a86c', handle: '#1a1718', grain: 1, tape: '#1a1718' },
  nova: { barrel: '#cf9a5c', handle: '#cf9a5c', grain: 1, tape: '#20304f' },
  skye: { barrel: '#dcb682', handle: '#171417', grain: 1, tape: '#171417' },
};
function makeBat(THREE, lenM, style, hq) {
  const inch = lenM / 34;
  const prof = [[0, 0], [0.62, 0], [0.86, 0.12], [0.85, 0.32], [0.56, 0.5], [0.47, 0.85], [0.46, 3], [0.47, 9], [0.5, 12], [0.58, 15], [0.72, 18], [0.9, 21], [1.06, 24], [1.19, 27], [1.26, 30], [1.28, 32.4], [1.25, 33.5], [1.05, 33.9], [0.55, 34], [0, 34]];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r * inch, y * inch));
  const geo = new THREE.LatheGeometry(pts, hq ? 18 : 12);
  geo.computeVertexNormals();
  // v coordinate along the length for the grain/colour map
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - pos.getY(i) / lenM);   // canvas top = barrel end
  const W = 64, H = 512, c = mkCanvas(W, H), g = c.getContext('2d');
  const handleEnd = 0.36;
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, style.barrel); grd.addColorStop(1 - handleEnd - 0.08, style.barrel); grd.addColorStop(1 - handleEnd + 0.04, style.handle); grd.addColorStop(1, style.handle);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  // grain streaks (flame) along the length
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * W, w = 0.6 + Math.random() * 2.2, a = (0.08 + Math.random() * 0.16) * style.grain;
    g.fillStyle = `rgba(92,52,20,${a})`; g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= H; y += 16) g.lineTo(x + Math.sin(y * 0.02 + i) * 3 + w, y);
    for (let y = H; y >= 0; y -= 16) g.lineTo(x + Math.sin(y * 0.02 + i) * 3, y);
    g.fill();
  }
  // grip tape (handle) + knob band
  g.fillStyle = style.tape; g.fillRect(0, H * (1 - 0.3), W, H * 0.3 - H * 0.012);
  g.fillStyle = 'rgba(255,255,255,0.08)'; for (let y = H * 0.7; y < H * 0.985; y += 7) g.fillRect(0, y, W, 2);
  // BLUFOX barrel stamp (tiny oval)
  g.fillStyle = 'rgba(20,24,40,0.55)'; g.fillRect(W * 0.35, H * 0.12, W * 0.3, H * 0.09);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 4;
  const mat = hq && THREE.MeshPhysicalMaterial
    ? new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.55, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 0.6 })
    : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0, envMapIntensity: 0.6 });
  const mesh = new THREE.Mesh(geo, mat); mesh.name = 'bat'; mesh.castShadow = true; mesh.frustumCulled = false;
  mesh.userData.dispose = () => { geo.dispose(); mat.dispose(); tex.dispose(); };
  return mesh;
}
/** Pitcher's glove: dark leather mitt built from squashed spheres (bone-local units) */
function makeGlove(THREE, unit) {
  const g = new THREE.Group(); g.name = 'glove';
  const mat = new THREE.MeshStandardMaterial({ color: '#2a1d16', roughness: 0.62, metalness: 0 });
  const lace = new THREE.MeshStandardMaterial({ color: '#8a5a33', roughness: 0.7 });
  const sph = new THREE.SphereGeometry(1, 14, 10);
  const add = (m, p, s) => { const o = new THREE.Mesh(sph, m); o.position.set(p[0] * unit, p[1] * unit, p[2] * unit); o.scale.set(s[0] * unit, s[1] * unit, s[2] * unit); o.castShadow = true; g.add(o); return o; };
  add(mat, [0, 0.1, 0], [0.058, 0.1, 0.03]);           // palm + back
  add(mat, [0, 0.2, 0], [0.066, 0.075, 0.034]);          // fingers
  add(mat, [0.05, 0.08, 0.005], [0.028, 0.07, 0.026]);   // thumb stall
  add(lace, [0.012, 0.24, 0.01], [0.04, 0.04, 0.012]);   // web
  g.userData.dispose = () => { sph.dispose(); mat.dispose(); lace.dispose(); };
  return g;
}

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
// 3D BATTER: stance → load (windup) → stride (pitch) → swing (contact exactly
// leadT after swing()) → extension → follow-through → finish → outcome beat.
// ============================================================================
const BAT_FT = 34 / 12;                 // 34" bat
const GRIP_BOT_IN = 1.4, GRIP_TOP_IN = 5.4, SWEET_IN = 28.6;
const DEF_LEAD = () => TUNING.swingLead;

function createFoxBatter(THREE, gltf, char, env) {
  const R = prepRigModel(THREE, gltf, { fingers: true, tail: true, palmFacesBody: true });
  const solver = createRigSolver(THREE, R);
  const M = R.M;
  const lefty = char.bats === 'L';
  const heightFt = env.heightFt || 6.1;
  const k = heightFt / M.height;                         // ft per rig metre
  const z0 = (R.rest.LeftFoot.p.z + R.rest.RightFoot.p.z) / 2;
  const O = [0, 0, z0];
  const C_R = [-env.boxX, 0, env.boxZ];
  // holder: world = C + k·Ry(yaw)·(rig − O)
  const holder = new THREE.Group(); holder.name = 'batter-3d';
  const yaw = lefty ? -Math.PI / 2 : Math.PI / 2;
  holder.rotation.y = yaw; holder.scale.setScalar(k);
  const cx = lefty ? env.boxX : -env.boxX;
  // Ry(yaw)·(0,0,z0) = (sin(yaw)·z0, 0, cos(yaw)·z0)
  holder.position.set(cx - k * Math.sin(yaw) * z0, 0, env.boxZ - k * Math.cos(yaw) * z0);
  holder.add(R.root);
  env.root.add(holder);
  solver.restPose();
  // ---- world ↔ RHB-rig conversions (analytic; the lefty is the mirror image)
  const w2r = (out, x, y, z) => { if (lefty) x = -x; const dx = x - C_R[0], dz = z - C_R[2]; out[0] = O[0] + (-dz) / k; out[1] = y / k; out[2] = O[2] + dx / k; return out; };
  const d2r = (out, x, y, z) => { if (lefty) x = -x; out[0] = -z; out[1] = y; out[2] = x; return out; };
  const r2w = (out, v) => { const rx = v[0] - O[0], ry = v[1], rz = v[2] - O[2]; let x = C_R[0] + k * rz, y = k * ry, z = C_R[2] - k * rx; if (lefty) x = -x; out.set(x, y, z); return out; };
  // bat (world-space mesh, feet)
  const style = BAT_STYLE[char.id] || BAT_STYLE.nova;
  const bat = makeBat(THREE, BAT_FT, style, env.quality !== 'low');
  env.root.add(bat);
  const batLenR = BAT_FT / k, gB = GRIP_BOT_IN / 12 / k, gT = GRIP_TOP_IN / 12 / k, ssR = (SWEET_IN - GRIP_BOT_IN) / 12 / k;
  const solveOpt = { batLen: batLenR, gripBot: gB, gripTop: gT, batFree: false };
  // contact blob (soft AO under the feet; the real shadow comes from the park's key light)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: env.blobTex, transparent: true, depthWrite: false, opacity: env.quality === 'low' ? 0.5 : 0.3, color: 0x000000 }));
  blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1; blob.scale.set(4.4, 3.2, 1);
  env.root.add(blob);

  // ---------------------------------------------------------------- poses
  const sh = M.shY;
  const STANCE = makePose();
  function stanceBase(o) {
    o.pel[0] = -0.012; o.pel[1] = -0.125; o.pel[2] = -0.075; o.pelYaw = -0.05; o.pelPitch = 0.27; o.pelRoll = 0;
    o.chYaw = -0.12; o.chPitch = 0.44; o.chRoll = 0.07;
    o.fF.b = [0.37, M.ballY, z0 + 0.1]; o.fF.yaw = 0.16; o.fF.heel = 0;
    o.fB.b = [-0.35, M.ballY, z0 + 0.09]; o.fB.yaw = -0.2; o.fB.heel = 0;
    o.kF = [-0.3, 0, 1]; o.kB = [0.3, 0, 1];
    o.grip = [-0.23, sh - 0.03, z0 + 0.2];
    o.bat = [-0.46, 0.72, -0.52];
    o.eF = [0.3, -0.9, 0.2]; o.eB = [-0.55, -0.5, -0.66];
    o.lookW = 1; o.headRoll = 0; o.rollF = 0; o.rollB = 0; o.topOn = 1; o.botOn = 1; o.curlF = 1; o.curlB = 1;
    o.freeF = [0.15, sh - 0.55, z0 + 0.1]; o.freeB = [-0.2, sh - 0.55, z0 + 0.05];
    return o;
  }
  stanceBase(STANCE);
  const LOADD = { pelX: -0.045, pelYaw: -0.13, chYaw: -0.2, grip: [-0.055, 0.03, -0.025], heelF: 0.32 };
  const STRIDE = 0.22;
  const cur = makePose(), tmpA = makePose(), tmpB = makePose(), tmpC = makePose(), snap = makePose(), blendFrom = makePose();
  copyPose(cur, STANCE);
  const st = {
    phase: 'idle',           // idle | swing | post | take | recover
    clock: 0, L: DEF_LEAD(), kappa: 0.72, F: 0.42, hitstop: 0, resKind: null, res: null,
    keys: null, gKeys: null, batLaw: null, blendT: 1, blendDur: 0.001, blendOn: false,
    postT: 0, flip: null, lookLive: false, rate: 1, tail: { s: 0, v: 0, l: 0, lv: 0 }, lastPelYaw: 0, gesture: null, idleFor: 0,
  };
  const look = [0, 0, 0], tmp3 = [0, 0, 0], tmp4 = [0, 0, 0];
  const _w = new THREE.Vector3(), _w2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _hq = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  function startBlend(dur) { copyPose(blendFrom, cur); st.blendT = 0; st.blendDur = Math.max(0.001, dur); st.blendOn = true; }

  // pre-pitch + pitch driven base pose (stance / load / stride / launch)
  function basePose(o, t, ctx) {
    copyPose(o, STANCE);
    // idle life
    const br = Math.sin(t * 1.9);
    o.chPitch += 0.016 * br; o.pel[1] += 0.004 * br; o.grip[1] += 0.006 * br;
    o.pel[0] += 0.012 * Math.sin(t * 0.55); o.chYaw += 0.025 * Math.sin(t * 0.43 + 1);
    const burst = smooth01((Math.sin(t * 0.37) - 0.2) * 3);                   // waggle comes in bursts
    const wg = 0.09 * Math.sin(t * 5.1) * burst + 0.035 * Math.sin(t * 2.3);
    rotAbout(o.bat, v3n(o.bat), [0, 1, 0], wg);
    o.bat[1] += 0.05 * Math.sin(t * 3.3) * burst;
    o.grip[0] += 0.012 * Math.sin(t * 2.3 + 0.5) * burst; o.grip[2] += 0.01 * Math.cos(t * 2.3) * burst;
    // load during the windup
    const W = TUNING.windupTime;
    const lam = ctx.windupT >= 0 ? smooth01((ctx.windupT - (W - 0.62)) / 0.46) : 0;
    const damp = 1 - lam * 0.85;                                                   // quiet the waggle when loading
    o.bat[0] = o.bat[0] * damp + STANCE.bat[0] * (1 - damp); o.bat[2] = o.bat[2] * damp + STANCE.bat[2] * (1 - damp);
    o.pel[0] += LOADD.pelX * lam; o.pelYaw += LOADD.pelYaw * lam; o.chYaw += LOADD.chYaw * lam;
    o.grip[0] += LOADD.grip[0] * lam; o.grip[1] += LOADD.grip[1] * lam; o.grip[2] += LOADD.grip[2] * lam;
    o.fF.heel += LOADD.heelF * lam; o.kF[0] -= 0.3 * lam;
    o.bat[0] += 0.16 * lam;                                                        // tip wraps a touch toward the pitcher
    // stride after release
    if (ctx.pt >= 0 && ctx.pitch) {
      const ft = clamp(ctx.pitch.flightTime || 0.9, 0.5, 1.5);
      const sg = smooth01(ctx.pt / (ft * 0.5));
      o.fF.b[0] += STRIDE * sg; o.fF.b[1] += 0.07 * Math.sin(Math.PI * clamp(ctx.pt / (ft * 0.5), 0, 1));
      o.fF.heel = LOADD.heelF * (1 - smooth01((ctx.pt / (ft * 0.5) - 0.55) / 0.45)) - 0.12 * Math.sin(Math.PI * clamp(ctx.pt / (ft * 0.42), 0, 1));
      o.kF[0] += 0.25 * sg;
      o.pel[0] += 0.065 * sg; o.pel[1] -= 0.022 * sg; o.pelYaw += 0.05 * sg;
      o.grip[0] -= 0.01 * sg;
      // trigger: tiny hands-back pulse as the foot lands
      const trig = Math.exp(-Math.pow((ctx.pt - ft * 0.5) / 0.06, 2));
      o.grip[0] -= 0.015 * trig; o.grip[1] += 0.008 * trig;
      // take: pitch passed without a swing → give, track into the mitt
      const tk = smooth01((ctx.pt - ft) / 0.3);
      if (tk > 0) {
        o.grip[1] -= 0.07 * tk; o.grip[0] += 0.03 * tk; o.bat[0] -= 0.25 * tk; o.bat[1] += 0.2 * tk;
        o.chPitch -= 0.08 * tk; o.pel[1] += 0.02 * tk; o.pelYaw -= 0.04 * tk; o.fF.heel = 0;
      }
    }
    // eyes: pitcher before release, then the ball
    if (ctx.ballPos) w2r(o.look, ctx.ballPos[0], ctx.ballPos[1], ctx.ballPos[2]);
    else w2r(o.look, RELEASE[0], RELEASE[1] + 0.4, RELEASE[2]);
    // idle gesture between pitches: top hand taps the helmet brim, bat rests in the bottom hand
    const G = st.gesture;
    if (G && ctx.windupT < 0) {
      const u = (t - G.t0) / G.dur;
      if (u >= 1) st.gesture = null;
      else {
        const e = smooth01(u / 0.22) * (1 - smooth01((u - 0.72) / 0.28));
        o.topOn = 1 - e; o.curlB = 1 - 0.6 * e;
        o.freeB = [0.04, M.headY + 0.12, z0 + 0.16];
        o.grip = [lerp(o.grip[0], -0.12, e), lerp(o.grip[1], sh - 0.22, e), lerp(o.grip[2], z0 + 0.26, e)];
        v3slerp(o.bat, o.bat, [-0.25, 0.92, 0.3], e);
        o.chPitch -= 0.14 * e; o.eB = [-0.3, -0.2, -0.9];
        o.look[1] -= 3 * e * Math.sin(Math.PI * clamp(u * 1.6, 0, 1));
      }
    }
    return o;
  }

  // ---------------------------------------------------------------- swing construction
  function contactKey(o, S0, Cr, a_c, kap, pyFt, low) {
    copyPose(o, S0);
    o.pel[0] = Math.max(S0.pel[0], 0) + 0.035; o.pel[1] = S0.pel[1] - 0.012 - 0.05 * low; o.pel[2] = S0.pel[2] + 0.02;
    o.pelYaw = 0.92 + 0.32 * kap; o.pelPitch = 0.16 + 0.1 * low; o.pelRoll = -0.04;
    o.chYaw = 0.3 + 0.22 * kap; o.chPitch = 0.34 + 0.22 * low; o.chRoll = 0.2 + 0.2 * low + 0.06 * kap;
    o.fF.b = [STANCE.fF.b[0] + STRIDE, M.ballY, STANCE.fF.b[2]]; o.fF.yaw = 0.38 + 0.1 * kap; o.fF.heel = 0;
    o.fB.b = [STANCE.fB.b[0] + 0.035, M.ballY + 0.01, STANCE.fB.b[2] + 0.02]; o.fB.yaw = 0.75 + 0.35 * kap; o.fB.heel = 0.42 + 0.22 * kap;
    o.kF = [0.15, 0.2, 1]; o.kB = [0.85, -0.25, 0.55];
    o.eF = [0.45, -0.85, -0.25]; o.eB = [-0.05, -1, 0.15];
    o.look = Cr.slice();
    o.lookW = 1;
    return o;
  }
  function planeDir(out, law, th) { // a_c cosθ + v_c sinθ
    const c = Math.cos(th), s = Math.sin(th), a = law.a, v = law.v;
    out[0] = a[0] * c + v[0] * s; out[1] = a[1] * c + v[1] * s; out[2] = a[2] * c + v[2] * s; return out;
  }
  function buildSwing(o) {
    const kap = clamp(o.batSpeed ?? 0.72, 0, 1);
    const L = clamp(o.leadT ?? DEF_LEAD(), 0.05, 0.4);
    st.L = L; st.kappa = kap; st.F = lerp(0.54, 0.38, kap);
    const S0 = copyPose(snap, cur);
    // ---- where will the ball be at contact? (world)
    const res = o.result || null;
    const aimR = (lefty ? -1 : 1) * clamp(o.aim ?? 0, -1, 1);
    let cp = null, sprayR = aimR * 36;
    if (res && res.contactPos) { cp = res.contactPos; if (Number.isFinite(res.spray)) sprayR = (lefty ? -1 : 1) * res.spray; }
    else {
      const zc = TUNING.contactZ + 0.85 * aimR;
      const p = env.pitch();
      if (p && p.posAt) { const tz = p.flightTime * (54 + zc) / 54; const q = p.posAt(tz); cp = [q[0], q[1], zc]; }
      else { const pl = o.pitchLoc || [0, 2.6]; cp = [pl[0], pl[1], zc]; }
      sprayR = clamp(aimR * 34 - (zc - TUNING.contactZ) * 6, -45, 45);
    }
    const pyFt = cp[1];
    const low = clamp((2.5 - pyFt) / 0.9, -1, 1);
    const up = clamp(o.uppercut ?? 0, -1, 1);
    const phi = clamp(0.34 + (2.55 - pyFt) * 0.3 - up * 0.08, 0.02, 0.9);
    const s = sprayR * Math.PI / 180;
    const Cr = w2r([0, 0, 0], cp[0], cp[1], cp[2]);
    // bat direction at contact (RHB world): (cos s·cosφ, −sinφ, sin s·cosφ) → RHB rig (−z, y, x)
    const rdir = (x, y, z) => [-z, y, x];
    const a_c = v3n(rdir(Math.cos(s) * Math.cos(phi), -Math.sin(phi), Math.sin(s) * Math.cos(phi)));
    // hands at contact, reach-limited
    const grip = [Cr[0] - a_c[0] * ssR, Cr[1] - a_c[1] * ssR, Cr[2] - a_c[2] * ssR];
    const armL = (M.uarm + M.farm) * 0.94;
    const shF = [M.shX * 0.6, sh - 0.06, z0 + 0.06];
    const dx = grip[0] - shF[0], dy = grip[1] - shF[1], dz = grip[2] - shF[2], d = Math.hypot(dx, dy, dz);
    if (d > armL) { const f = armL / d; grip[0] = shF[0] + dx * f; grip[1] = shF[1] + dy * f; grip[2] = shF[2] + dz * f; }
    if (grip[2] < z0 + 0.16) grip[2] = z0 + 0.16;                                // never inside the body
    // re-aim the barrel from the (possibly clamped) hands to the ball
    let ac2 = v3n([Cr[0] - grip[0], Cr[1] - grip[1], Cr[2] - grip[2]]);
    // dry-run the solver on the contact pose: if the top (back) arm can't reach, slide the hands toward it
    {
      const Ck = contactKey(tmpC, S0, Cr, ac2, kap, pyFt, low);
      const topSide = lefty ? 'Left' : 'Right';
      for (let it = 0; it < 3; it++) {
        Ck.grip = grip.slice(); Ck.bat = ac2.slice();
        solver.solve(Ck, lefty, solveOpt);
        const mv = solver.rp[topSide + 'Hand'].clone().sub(solver.dbg.topTarget);
        if (lefty) mv.x = -mv.x;
        if (mv.length() < 0.006) break;
        grip[0] += mv.x; grip[1] += mv.y; grip[2] += mv.z;
        ac2 = v3n([Cr[0] - grip[0], Cr[1] - grip[1], Cr[2] - grip[2]]);
      }
    }
    // swing plane: v_c = hit direction ⟂ a_c (with attack angle)
    const att = 0.14 + up * 0.16;
    const hw = rdir(Math.sin(s), Math.sin(att), -Math.cos(s));
    const dd = hw[0] * ac2[0] + hw[1] * ac2[1] + hw[2] * ac2[2];
    const v_c = v3n([hw[0] - ac2[0] * dd, hw[1] - ac2[1] * dd, hw[2] - ac2[2] * dd]);
    const law = { a: ac2, v: v_c, thS: 2.05 + 0.15 * kap, uS: 0.34, p: 1.7 };
    // ---- keys
    const C = contactKey(tmpA, S0, Cr, ac2, kap, pyFt, low);
    C.grip = grip;
    const E = copyPose(makePose(), C), Wr = copyPose(makePose(), C), Fi = copyPose(makePose(), C);
    const vc = v_c;
    E.grip = [grip[0] + vc[0] * 0.26 + ac2[0] * 0.08, grip[1] + 0.03, grip[2] + vc[2] * 0.26 + ac2[2] * 0.08];
    E.pelYaw = C.pelYaw + 0.32; E.chYaw = C.chYaw + 0.75; E.chRoll = C.chRoll * 0.45; E.chPitch = 0.28 + 0.1 * low; E.pel[0] += 0.02; E.pel[1] += 0.02;
    E.fB.yaw = C.fB.yaw + 0.25; E.fB.heel = C.fB.heel + 0.18; E.eF = [0.6, -0.7, 0.2]; E.eB = [0.35, -0.9, 0.2];
    // hands relative to the rotated chest: local (lateral → front-shoulder side, up, forward of the chest)
    const chestPt = (chYaw, lx, ly, lz) => { const c = Math.cos(chYaw), sn = Math.sin(chYaw); return [C.pel[0] * 0.5 + lx * c + lz * sn, ly, z0 + 0.02 - lx * sn + lz * c]; };
    Wr.grip = chestPt(C.chYaw + 1.3 + 0.2 * kap, 0.1, sh - 0.02 - 0.06 * (1 - kap), 0.3);
    Wr.pelYaw = C.pelYaw + 0.5 + 0.1 * kap; Wr.chYaw = C.chYaw + 1.3 + 0.2 * kap; Wr.chPitch = 0.16; Wr.chRoll = -0.04;
    Wr.fB.yaw = 1.2; Wr.fB.heel = 0.85; Wr.kB = [0.95, -0.2, 0.2]; Wr.eF = [0.9, -0.2, -0.4]; Wr.eB = [0.7, -0.6, 0.4]; Wr.pel[1] += 0.03;
    Fi.pelYaw = 1.5 + 0.2 * kap; Fi.chYaw = 1.95 + 0.4 * kap; Fi.chPitch = 0.1; Fi.chRoll = -0.1;
    Fi.grip = chestPt(Fi.chYaw, 0.13, sh + 0.12 - 0.14 * (1 - kap), 0.2);
    Fi.fB.yaw = 1.45; Fi.fB.heel = 1.0; Fi.fB.b = [STANCE.fB.b[0] + 0.08, M.ballY + 0.02, STANCE.fB.b[2] + 0.05];
    Fi.fF.yaw = 0.55; Fi.kB = [1, -0.3, 0.05]; Fi.kF = [0.4, 0.2, 1];
    Fi.eF = [0.8, 0.1, -0.6]; Fi.eB = [0.6, -0.4, 0.6]; Fi.pel[1] += 0.04; Fi.pel[0] += 0.02;
    if (o.kind === 'whiff') { // over-swing: more rotation, weight spills forward, head pulls off
      Fi.chYaw += 0.25; Fi.pelYaw += 0.12; Fi.pel[0] += 0.05; Fi.pel[1] -= 0.02; Fi.chPitch += 0.12; Wr.chYaw += 0.15;
    }
    // post-contact look: along the hit direction, up
    const lk = [Cr[0] + vc[0] * 2.5, Cr[1] + 1.2, Cr[2] + vc[2] * 2.5];
    E.look = lk.slice(); Wr.look = lk.slice(); Fi.look = lk.slice(); E.lookW = 0.9; Wr.lookW = 0.85; Fi.lookW = 0.85;
    st.keys = [copyPose(makePose(), S0), copyPose(makePose(), C), E, Wr, Fi];
    // grip keys incl. the slot (hands drop to the back shoulder/chest and start forward, inside the ball)
    const slot = [lerp(S0.grip[0], grip[0], 0.2) - 0.02, lerp(S0.grip[1], grip[1], 0.5) + 0.02, lerp(S0.grip[2], grip[2], 0.3)];
    st.gKeys = [S0.grip.slice(), slot, grip.slice(), E.grip, Wr.grip, Fi.grip];
    // bat directions post-contact
    const ext = planeDir([0, 0, 0], law, 1.95);
    // wrap + finish in the rotated chest frame: f = chest facing, l = lead-shoulder side
    const fr = th => ({ f: [Math.sin(th), 0, Math.cos(th)], l: [Math.cos(th), 0, -Math.sin(th)] });
    const W_ = fr(Wr.chYaw), F_ = fr(Fi.chYaw);
    const wrapD = v3n([0.15 * W_.f[0] + 0.55 * W_.l[0], 0.8, 0.15 * W_.f[2] + 0.55 * W_.l[2]]);
    const finD = v3n([-0.72 * F_.f[0] + 0.3 * F_.l[0], -0.45 - 0.2 * kap, -0.72 * F_.f[2] + 0.3 * F_.l[2]]);
    const angle = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
    law.ext = ext; law.wrap = wrapD; law.fin = finD; law.thE = 1.95;
    law.segs = [1.95, angle(ext, wrapD), angle(wrapD, finD)];
    law.tot = law.segs[0] + law.segs[1] + law.segs[2];
    const omega = law.thS * law.p / ((1 - law.uS) * L);
    law.q = clamp(omega * st.F / law.tot, 1.6, 6.5);
    law.S0bat = S0.bat.slice();
    st.batLaw = law;
    st.contactR = Cr;
    return { Cr, law };
  }
  function batDirAt(out, t) {
    const law = st.batLaw, L = st.L;
    if (t <= L) {
      const u = clamp(t / L, 0, 1);
      if (u < law.uS) { planeDir(tmp3, law, -law.thS); tmp3[1] += 0.45; v3n(tmp3); return v3slerp(out, law.S0bat, tmp3, smooth01(u / law.uS)); }
      const w = (u - law.uS) / (1 - law.uS);
      planeDir(out, law, -law.thS * (1 - Math.pow(w, law.p)));
      out[1] += 0.45 * (1 - w) * (1 - w);
      return v3n(out);
    }
    const x = clamp((t - L) / st.F, 0, 1);
    let Th = law.tot * (1 - Math.pow(1 - x, law.q));
    if (Th < law.segs[0]) return planeDir(out, law, Th);
    Th -= law.segs[0];
    if (Th < law.segs[1]) return v3slerp(out, law.ext, law.wrap, Th / law.segs[1]);
    Th -= law.segs[1];
    return v3slerp(out, law.wrap, law.fin, clamp(Th / Math.max(1e-3, law.segs[2]), 0, 1));
  }
  const gTmp = [0, 0, 0];
  function gripAt(out, t) {
    const L = st.L, G = st.gKeys;
    let sg;
    if (t <= L) { const u = clamp(t / L, 0, 1); sg = 2 * (u + 0.18 * u * (1 - u)); }
    else sg = 2 + 3 * easeOutPow((t - L) / st.F, 2.3);
    const n = G.length, i = Math.min(n - 2, Math.floor(sg)), f = sg - i;
    const p0 = G[Math.max(0, i - 1)], p1 = G[i], p2 = G[i + 1], p3 = G[Math.min(n - 1, i + 2)];
    for (let j = 0; j < 3; j++) out[j] = 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * f + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * f * f + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * f * f * f);
    return out;
  }
  function swingPose(o, t) {
    const L = st.L, K = st.keys;
    let sH, sC;
    if (t <= L) { const u = clamp(t / L, 0, 1); sH = u + 0.6 * u * (1 - u); sC = Math.pow(u, 1.25); }
    else { const x = (t - L) / st.F; sH = 1 + 3 * easeOutPow(x, 1.9); sC = 1 + 3 * easeOutPow(x, 2.2); }
    catmullPose(tmpB, K, sH);    // pelvis, legs
    catmullPose(tmpC, K, sC);    // chest, head, arms
    copyPose(o, tmpC);
    o.pel = tmpB.pel.slice(); o.pelYaw = tmpB.pelYaw; o.pelPitch = tmpB.pelPitch; o.pelRoll = tmpB.pelRoll;
    o.fF = { b: tmpB.fF.b.slice(), yaw: tmpB.fF.yaw, heel: tmpB.fF.heel }; o.fB = { b: tmpB.fB.b.slice(), yaw: tmpB.fB.yaw, heel: Math.max(0, tmpB.fB.heel) };
    o.kF = tmpB.kF.slice(); o.kB = tmpB.kB.slice();
    // front foot: plant quickly if the swing started before the stride landed
    if (t <= L) {
      const pk = smooth01(t / Math.max(0.03, L * 0.45));
      o.fF.b[1] = lerp(K[0].fF.b[1], M.ballY, pk); o.fF.heel = lerp(K[0].fF.heel, 0, pk);
      o.fF.b[0] = lerp(K[0].fF.b[0], K[1].fF.b[0], pk);
    }
    gripAt(o.grip, t);
    batDirAt(o.bat, t);
    // eyes stay on the contact point through contact, then chase the ball
    if (t > L + 0.06 && env.ballLive()) { const b = env.ballPos(); w2r(o.look, b[0], b[1], b[2]); o.lookW = 0.85; }
    return o;
  }

  // ---------------------------------------------------------------- outcome beats
  function afterPose(o, kind, tt) { // tt: seconds since the finish
    copyPose(o, st.keys[4]);
    if (kind === 'homer') {
      // bat flip: top hand off at 0.05, toss at 0.3 → admire, chest up, eyes on the ball
      const off = smooth01(tt / 0.2), toss = smooth01((tt - 0.12) / 0.22);
      o.topOn = 1 - off; o.freeB = [-0.12, sh - 0.45, z0 + 0.08];
      o.grip = [lerp(o.grip[0], 0.32, toss), lerp(o.grip[1], sh - 0.1, toss), lerp(o.grip[2], z0 + 0.35, toss)];
      o.bat = v3n([lerp(o.bat[0], 0.2, toss), lerp(o.bat[1], 0.9, toss), lerp(o.bat[2], 0.1, toss)]);
      const rel = smooth01((tt - 0.3) / 0.5);
      o.botOn = st.flip ? 1 - smooth01((tt - 0.34) / 0.25) : 1;
      o.freeF = [0.22, sh - 0.5, z0 + 0.14];
      o.chYaw = lerp(o.chYaw, 1.35, rel); o.pelYaw = lerp(o.pelYaw, 1.2, rel); o.chPitch = lerp(o.chPitch, -0.05, rel); o.chRoll = lerp(o.chRoll, 0, rel);
      o.fB.heel = lerp(o.fB.heel, 0.45, rel); o.kB = [0.8, -0.2, 0.6];
      o.lookW = 1;
    } else {
      const k2 = smooth01(tt / 0.6);
      if (kind === 'whiff') { o.chPitch += 0.18 * k2; o.look[1] -= 1.2 * k2; }
      // relax: bat down in the top hand, bottom hand off, head drops a touch
      o.botOn = 1 - smooth01((tt - 0.1) / 0.3);
      o.grip = [lerp(o.grip[0], -0.05, k2), lerp(o.grip[1], sh - 0.52, k2), lerp(o.grip[2], z0 + 0.28, k2)];
      o.bat = v3n([lerp(o.bat[0], 0.25, k2), lerp(o.bat[1], -0.85, k2), lerp(o.bat[2], 0.45, k2)]);
      o.chYaw = lerp(o.chYaw, 0.9, k2); o.pelYaw = lerp(o.pelYaw, 0.8, k2); o.chPitch = lerp(o.chPitch, 0.25, k2);
      o.fB.heel = lerp(o.fB.heel, 0.2, k2); o.fB.yaw = lerp(o.fB.yaw, 0.7, k2);
      o.eB = [-0.2, -1, 0.1]; o.lookW = 0.8;
    }
    if (env.ballLive()) { const b = env.ballPos(); w2r(o.look, b[0], b[1] + 2, b[2]); }
    return o;
  }

  // ---------------------------------------------------------------- bat physics (flip)
  const batPhys = { on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), bounces: 0, rest: false };
  function startFlip(big) {
    if (batPhys.on) return;
    batPhys.on = true; batPhys.bounces = 0; batPhys.rest = false;
    batPhys.p.copy(bat.position); batPhys.q.copy(bat.quaternion);
    const side = lefty ? 1 : -1;
    if (big) { // the flip: tossed up and away toward the dugout side, end over end
      batPhys.v.set(side * (3.5 + Math.random()), 9 + Math.random() * 2, -4 - Math.random() * 2);
      batPhys.w.set(0, 0, 1).applyQuaternion(bat.quaternion).cross(UP).normalize().multiplyScalar(11 + Math.random() * 5);
      batPhys.w.y += 2.5 * side;
    } else {   // the drop: let go, it falls and clatters
      batPhys.v.set(side * 1.2, 1.5, -1); batPhys.w.set(side * 2, 0.5, 1.5);
    }
    solveOpt.batFree = true;
  }
  const _ax = new THREE.Vector3(), _tip = new THREE.Vector3(), _knob = new THREE.Vector3();
  function stepFlip(dt) {
    if (!batPhys.on || batPhys.rest) return;
    const g = TUNING.gravity;
    batPhys.v.y -= g * dt;
    batPhys.p.addScaledVector(batPhys.v, dt);
    const wl = batPhys.w.length();
    if (wl > 1e-4) { _q.setFromAxisAngle(_ax.copy(batPhys.w).divideScalar(wl), wl * dt); batPhys.q.premultiply(_q); }
    // ground contact on either end (knob at p, tip = p + axis·len)
    _ax.set(0, 1, 0).applyQuaternion(batPhys.q);
    _tip.copy(batPhys.p).addScaledVector(_ax, BAT_FT);
    const low = Math.min(batPhys.p.y, _tip.y) - 0.1;
    if (low < 0) {
      batPhys.p.y -= low;
      if (batPhys.v.y < 0) {
        batPhys.v.y *= -0.32; batPhys.v.x *= 0.55; batPhys.v.z *= 0.55; batPhys.w.multiplyScalar(0.45); batPhys.bounces++;
        if (batPhys.bounces === 1) env.fx.burst('dust', [batPhys.p.x, 0.1, batPhys.p.z], { count: 5, size: 0.5, speed: 2, life: 0.7, opacity: 0.3, lift: 0.4 });
      }
      // lie flat: ease the axis toward horizontal
      _w.copy(_ax); _w.y = 0; if (_w.lengthSq() > 1e-6) { _w.normalize(); _q.setFromUnitVectors(_ax, _w); _hq.identity().slerp(_q, Math.min(1, dt * 6)); batPhys.q.premultiply(_hq); }
      if (batPhys.bounces >= 3 || (Math.abs(batPhys.v.y) < 0.8 && batPhys.bounces > 0)) { batPhys.v.set(0, 0, 0); batPhys.w.set(0, 0, 0); if (Math.abs(_ax.y) < 0.05) batPhys.rest = true; }
    }
    bat.position.copy(batPhys.p); bat.quaternion.copy(batPhys.q);
  }

  // ---------------------------------------------------------------- per-frame
  const _bw = new THREE.Vector3(), _bd = new THREE.Vector3();
  function update(dt, time, ctx) {
    const sdt = st.hitstop > 0 ? 0 : dt;
    if (st.hitstop > 0) st.hitstop -= dt;
    let target = tmpA;
    if (st.phase === 'swing') {
      st.clock += sdt * (st.clock > st.L ? st.rate : 1);
      if (st.clock >= st.L + st.F) { st.phase = 'post'; st.postT = 0; }
      swingPose(target, Math.min(st.clock, st.L + st.F));
    }
    if (st.phase === 'post') {
      st.postT += sdt * st.rate;
      const kind = st.resKind || 'foul';
      const hold = kind === 'homer' ? 0.22 : 0.28;
      if (st.postT < hold) swingPose(target, st.L + st.F);
      else afterPose(target, kind, st.postT - hold);
      const big = !st.res || (st.res.distance || 0) >= 425 || st.res.contact === 'sweet';
      if (kind === 'homer' && !st.flip && st.postT > hold + (big ? 0.4 : 0.22)) { st.flip = true; startFlip(big); }
    } else if (st.phase === 'idle') {
      st.idleFor = ctx.windupT >= 0 ? 0 : st.idleFor + dt;
      if (!st.gesture && st.idleFor > 3.2 && Math.random() < dt * 0.35) { st.gesture = { t0: time, dur: 1.5 }; st.idleFor = -4 - Math.random() * 4; }
      basePose(target, time, ctx);
    }
    // blend layer (transitions into/out of phases)
    if (st.blendOn) {
      st.blendT += dt;
      const kk = smooth01(st.blendT / st.blendDur);
      lerpPoseR(cur, blendFrom, target, kk);
      // directions: renormalise
      v3n(cur.bat);
      if (kk >= 1) st.blendOn = false;
    } else copyPose(cur, target);
    // tail: spring driven by pelvis yaw velocity + idle sway
    const yv = (cur.pelYaw - st.lastPelYaw) / Math.max(dt, 1e-3); st.lastPelYaw = cur.pelYaw;
    const T = st.tail, idle = 0.16 * Math.sin(time * 1.15) + 0.06 * Math.sin(time * 2.6 + 1);
    const tgt = idle - clamp(yv * 0.09, -0.9, 0.9);
    T.v += ((tgt - T.s) * 70 - T.v * 9) * dt; T.s += T.v * dt;
    const ltg = 0.1 + 0.08 * Math.sin(time * 0.9) + (st.phase === 'swing' ? 0.25 : 0);
    T.lv += ((ltg - T.l) * 40 - T.lv * 8) * dt; T.l += T.lv * dt;
    cur.tailS = T.s; cur.tailL = T.l;
    // solve
    const b = solver.solve(cur, lefty, solveOpt);
    // bat in world space
    if (!batPhys.on) {
      holder.updateMatrixWorld(true);
      _bw.copy(b.knob).applyMatrix4(holder.matrixWorld);
      _bd.copy(b.dir).applyQuaternion(holder.quaternion).normalize();
      bat.position.copy(_bw); bat.quaternion.setFromUnitVectors(UP, _bd);
    } else stepFlip(dt);
    // blob follows the pelvis
    _w.copy(solver.rp.Hips).applyMatrix4(holder.matrixWorld);
    blob.position.set(_w.x, 0.02, _w.z);
  }
  // barrel-tip world samples for the swoosh trail
  function sweepPoints(out, n, t0, t1) {
    const g = [0, 0, 0], d = [0, 0, 0], tip = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const t = t0 + (t1 - t0) * i / (n - 1);
      gripAt(g, t); batDirAt(d, t);
      const L2 = batLenR - gB;
      tip[0] = g[0] + d[0] * L2; tip[1] = g[1] + d[1] * L2; tip[2] = g[2] + d[2] * L2;
      r2w(_w, tip);
      out[i * 4] = t; out[i * 4 + 1] = _w.x; out[i * 4 + 2] = _w.y; out[i * 4 + 3] = _w.z;
    }
    return out;
  }

  const api = {
    kind: 'model', holder, bat, R,
    swing(o = {}) {
      const tb = buildSwing(o);
      st.phase = 'swing'; st.clock = 0; st.resKind = o.kind === 'whiff' ? 'whiff' : null; st.res = o.result || null; st.flip = false; st.rate = 1; st.postT = 0;
      st.blendOn = false;
      return { leadT: st.L, contactR: tb.Cr };
    },
    contact(res) {
      st.res = res; st.resKind = res && res.kind || 'foul';
      if (st.phase === 'swing' && st.clock < st.L) st.clock = st.L;
      const sweet = res && (res.contact === 'sweet' || (res.quality ?? 0) > 0.85);
      st.hitstop = sweet ? 0.085 : 0.03;
    },
    whiff() { st.resKind = 'whiff'; },
    take() { /* the base pose already gives with the pitch; nothing extra */ },
    reset(snapBack) {
      if (batPhys.on) { batPhys.on = false; solveOpt.batFree = false; snapBack = true; }
      const wasBusy = st.phase !== 'idle';
      st.phase = 'idle'; st.clock = 0; st.flip = false; st.resKind = null; st.res = null; st.rate = 1;
      if (snapBack) { st.blendOn = false; }
      else if (wasBusy) startBlend(0.45);
    },
    setRate(r) { st.rate = clamp(r, 0.2, 1.2); },
    get swinging() { return st.phase === 'swing'; },
    get clock() { return st.clock; },
    get phase() { return st.phase; },
    get leadT() { return st.L; },
    sweepPoints, update,
    pose: cur,
    dispose() {
      env.root.remove(holder); holder.remove(R.root); solver.restPose();
      env.root.remove(bat); bat.userData.dispose && bat.userData.dispose();
      env.root.remove(blob); blob.geometry.dispose(); blob.material.dispose();
    },
    debug: { st, solver, w2r, r2w, k, solveOpt, lefty },
  };
  update(0, 0, { windupT: -1, pt: -1, pitch: null });
  return api;
}

// ============================================================================
// 3D PITCHER: the rig's baked 'baseball_pitching' mocap clip, retimed so the
// ball leaves the hand exactly TUNING.windupTime after startPitch(), placed so
// the hand is AT data.js RELEASE at that instant (root slide + arm IK trim),
// ball in the hand before release, procedural glove on the left hand.
// ============================================================================
function createFoxPitcher(THREE, gltf, env) {
  const R = prepRigModel(THREE, gltf, { fingers: false, tail: true, palmFacesBody: false });
  const clip = (R.clips || []).find(c => /pitch/i.test(c.name)) || (R.clips || [])[0];
  if (!clip) throw new Error('pitcher clip missing');
  const root = R.root;
  const holder = new THREE.Group(); holder.name = 'pitcher-3d';
  const outer = new THREE.Group(); outer.name = 'pitcher-slide';
  outer.add(holder); holder.add(root); env.root.add(outer);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip); action.play(); action.setEffectiveWeight(1);
  const B = R.bones;
  const sample = (t) => { action.time = t; mixer.update(0); root.updateMatrixWorld(true); };
  // ---- find the release frame: peak throwing-hand speed in [1.0, 2.2] s
  const hp = new THREE.Vector3(), hp0 = new THREE.Vector3();
  let best = 0, tRel = 1.62;
  sample(1.0); B.RightHand.getWorldPosition(hp0);
  for (let t = 1.0 + 1 / 60; t <= Math.min(2.2, clip.duration); t += 1 / 60) {
    sample(t); B.RightHand.getWorldPosition(hp);
    const sp = hp.distanceTo(hp0) * 60; if (sp > best) { best = sp; tRel = t; } hp0.copy(hp);
  }
  tRel -= 1 / 60;                                                  // the ball leaves just before peak speed
  sample(tRel); const relHand = new THREE.Vector3(); B.RightHand.getWorldPosition(relHand);
  // advance the hand to the palm (ball sits ~7 cm along the hand)
  const HF = R.handFrame.Right;
  const palmLocal = new THREE.Vector3().copy(HF.f).multiplyScalar(HF.len * 0.45).addScaledVector(HF.p, 0.03);
  // bone-local offset (rest): rig → hand local
  const restHandQi = R.rest.RightHand.q.clone().invert();
  const palmBoneLocal = palmLocal.clone().applyQuaternion(restHandQi).divideScalar(R.armS);
  const palmAt = (out) => { out.copy(palmBoneLocal); B.RightHand.localToWorld(out); return out; };
  palmAt(relHand);
  sample(0); const foot0 = new THREE.Vector3(); B.RightFoot.getWorldPosition(foot0);
  // scale: release height above the mound
  // scale: between 'hand exactly at release height' and a 6.1 ft fox; the arm IK trims the rest
  const k = clamp(lerp((RELEASE[1] - RUBBER_Y) / Math.max(0.8, relHand.y), 6.1 / R.M.height, 0.55), 2.6, 4.2);
  holder.scale.setScalar(k);
  const yaw = -Math.PI / 2;                                         // model +X (glove side / stride) → toward home (+Z)
  holder.rotation.y = yaw;
  // model → world (before placement): Ry(yaw)·(k·v)
  const toW = (v) => new THREE.Vector3(v.x, v.y, v.z).multiplyScalar(k).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const relW = toW(relHand), footW = toW(foot0);
  // pivot foot on the rubber's front edge at the set; x so the hand hits RELEASE.x
  const px = RELEASE[0] - relW.x;
  const pz = RUBBER[2] + 0.35 - footW.z;
  holder.position.set(px, RUBBER_Y, pz);
  const slideZ = RELEASE[2] - (pz + relW.z);                        // extra drift to reach the release depth
  // glove on the left hand, ball in the right
  const unit = 1 / R.armS;                                          // bone-local units per rig metre
  const glove = makeGlove(THREE, unit);
  const HL = R.handFrame.Left;
  const gq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), HL.f.clone().applyQuaternion(R.rest.LeftHand.q.clone().invert()));
  glove.quaternion.copy(gq);
  glove.position.copy(HL.f).multiplyScalar(0.02).applyQuaternion(R.rest.LeftHand.q.clone().invert()).multiplyScalar(unit);
  B.LeftHand.add(glove);
  const held = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ color: '#f1ece2', roughness: 0.55 }));
  held.scale.setScalar(0.121 * 1.35 / k * unit); held.position.copy(palmBoneLocal); held.castShadow = true;
  B.RightHand.add(held);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: env.blobTex, transparent: true, depthWrite: false, opacity: env.quality === 'low' ? 0.45 : 0.28, color: 0x000000 }));
  blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1; blob.scale.set(4, 4.4, 1);
  env.root.add(blob);
  // ---- time mapping
  const W = TUNING.windupTime;
  const tauOf = c => (c < 0 ? 0 : c <= W ? tRel * (c / W) : Math.min(clip.duration, tRel + (c - W) * 1.0));
  const slideOf = tau => { // 0 → 1 over the stride, hold, back to 0 during the recovery walk-back
    const a = smooth01((tau - 0.85) / (tRel - 0.85)), b = 1 - smooth01((tau - 2.4) / 0.9);
    return a * b;
  };
  // arm IK trim toward RELEASE around the release instant
  const S = new THREE.Vector3(), E = new THREE.Vector3(), Wp = new THREE.Vector3(), T = new THREE.Vector3(), E2 = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qw = new THREE.Quaternion(), qp = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  function trimArm(w) {
    if (w <= 0.001) return;
    outer.updateMatrixWorld(true);
    B.RightArm.getWorldPosition(S); B.RightForeArm.getWorldPosition(E); palmAt(Wp);
    T.set(RELEASE[0], RELEASE[1], RELEASE[2]).lerp(Wp, 1 - w);
    // shift the palm target into a wrist target
    B.RightHand.getWorldPosition(v1); T.sub(Wp).add(v1); Wp.copy(v1);
    const l1 = S.distanceTo(E), l2 = E.distanceTo(Wp);
    const dir = v2.subVectors(T, S); let d = dir.length(); d = clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999); dir.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pole = v1.subVectors(E, S); pole.addScaledVector(dir, -pole.dot(dir)); if (pole.lengthSq() < 1e-8) pole.set(0, 1, 0); pole.normalize();
    E2.copy(S).addScaledVector(dir, a).addScaledVector(pole, h);
    // upper arm
    qa.setFromUnitVectors(v1.subVectors(E, S).normalize(), v2.subVectors(E2, S).normalize());
    B.RightArm.getWorldQuaternion(qw); qw.premultiply(qa); B.RightArm.parent.getWorldQuaternion(qp); B.RightArm.quaternion.copy(qp.invert().multiply(qw));
    B.RightArm.updateMatrixWorld(true);
    // forearm
    B.RightForeArm.getWorldPosition(E); B.RightHand.getWorldPosition(Wp);
    qb.setFromUnitVectors(v1.subVectors(Wp, E).normalize(), v2.subVectors(T, E).normalize());
    B.RightForeArm.getWorldQuaternion(qw); qw.premultiply(qb); B.RightForeArm.parent.getWorldQuaternion(qp); B.RightForeArm.quaternion.copy(qp.invert().multiply(qw));
    B.RightForeArm.updateMatrixWorld(true);
  }
  const snapQ = [], snapP = [];
  const bonesList = R.mesh.skeleton.bones;
  let blendT = 1;
  let lastTau = 0;
  function update(dt, time, clock) {
    const tau = tauOf(clock);
    action.time = tau; mixer.update(0);
    // tail swish
    if (B.Tail0) { const s = 0.12 * Math.sin(time * 1.2) + 0.25 * Math.sin(tau * 3.1) * smooth01(tau - 0.8) * (1 - smooth01(tau - 2.8)); for (let i = 0; i < 3; i++) B['Tail' + i].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), s * (0.3 + 0.25 * i)); }
    // idle breathing on the set
    if (clock < 0) { const br = Math.sin(time * 1.7) * 0.02; qa.setFromAxisAngle(new THREE.Vector3(1, 0, 0), br); B.Spine01.quaternion.multiply(qa); }
    // blend from the previous pose after a restart
    if (blendT < 1) {
      blendT = Math.min(1, blendT + dt / 0.28); const kk = smooth01(blendT);
      for (let i = 0; i < bonesList.length; i++) { const b = bonesList[i]; if (!snapQ[i]) continue; b.quaternion.slerpQuaternions(snapQ[i], b.quaternion.clone(), kk); b.position.lerpVectors(snapP[i], b.position.clone(), kk); }
    }
    outer.position.z = slideZ * slideOf(tau);
    // IK trim + ball
    const w = Math.exp(-Math.pow((tau - tRel) / 0.07, 2));
    root.updateMatrixWorld(true);
    trimArm(w);
    held.visible = clock < W;
    lastTau = tau;
    B.Hips.getWorldPosition(v1); blob.position.set(v1.x, RUBBER_Y + 0.03, v1.z);
  }
  return {
    kind: 'model', holder: outer, R, tRel, k, slideZ,
    update,
    restart() { for (let i = 0; i < bonesList.length; i++) { snapQ[i] = bonesList[i].quaternion.clone(); snapP[i] = bonesList[i].position.clone(); } blendT = 0; },
    handWorld(out) { outer.updateMatrixWorld(true); return palmAt(out); },
    dispose() {
      action.stop(); mixer.uncacheRoot(root);
      B.LeftHand.remove(glove); glove.userData.dispose(); B.RightHand.remove(held); held.geometry.dispose(); held.material.dispose();
      holder.remove(root); env.root.remove(outer); env.root.remove(blob); blob.geometry.dispose(); blob.material.dispose();
      for (const [b, p, q] of R.restLocals) { b.position.copy(p); b.quaternion.copy(q); }
    },
  };
}

/** @internal test hooks (node tests / harness) */
export const __rig = { prepRigModel, createRigSolver, makePose, copyPose, lerpPoseR };

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
  const B = { sprite: null, fox: null, model: null, modelFor: '', modelWant: '', key: '', side: 1, swinging: false, clock: 0, frame: 0, lastFrame: 0, ghost: 0, ghostF: 0, hitstop: 0, contactAt: TUNING.swingLead, leadT: TUNING.swingLead, lastTau: 0, rate: 1,
    kp: null, adjust: { y: 0, x: 0 }, idleT: Math.random() * 10, strip: null, stanceOff: 0, checkT: 0 };
  function batterSideSign() { return char.bats === 'L' ? 1 : -1; }   // x sign of the batter's box
  // ---- rigged 3D model (preferred): lazy-loaded GLB via assets.model('model_<id>')
  const MODELS = { gltf: {}, failed: {} };
  const modelEntry = k => { try { return assets && (assets.entry ? assets.entry(k) : assets.meta ? assets.meta(k) : null); } catch { return null; } };
  // sprite strips are lazy in the v2 manifest: fetch one only when its 3D model is unavailable
  const wantSprite = key => { try { if (assets && assets.load && !A.img(key)) assets.load(key); } catch { /* ignore */ } };
  function requestModel(key, onReady, fallbackKey) {
    if (MODELS.gltf[key]) return onReady(MODELS.gltf[key]);
    if (MODELS.failed[key] || !assets || typeof assets.model !== 'function') { if (fallbackKey) wantSprite(fallbackKey); return; }
    let p; try { p = assets.model(key); } catch (e) { p = null; }
    if (!p || !p.then) { if (fallbackKey) wantSprite(fallbackKey); return; }
    p.then(g => { if (!g || !g.scene) { MODELS.failed[key] = true; if (fallbackKey) wantSprite(fallbackKey); return; } MODELS.gltf[key] = g; onReady(g); })
      .catch(e => { MODELS.failed[key] = true; if (fallbackKey) wantSprite(fallbackKey); console.warn('[actors] model failed', key, e); });
  }
  const envBase = () => ({ root, fx, blobTex, quality,
    pitch: () => S.pitch, ballLive: () => ball.visible && (S.phase === 'flight' || S.phase === 'rest' || S.phase === 'pitch'), ballPos: () => ball.position.toArray() });
  function mountBatterModel(g) {
    if (B.model && B.modelFor === char.id) return;
    const id = char.id;
    const entry = modelEntry('model_' + id) || {};
    let m = null;
    try { m = createFoxBatter(THREE, g, char, { ...envBase(), boxX: 2.75, boxZ: BOX_Z, heightFt: entry.heightFt || (id === 'rocco' ? 6.55 : char.gender === 'F' ? 6.0 : 6.2) }); }
    catch (e) { console.warn('[actors] 3D batter failed, keeping fallback', e); MODELS.failed['model_' + id] = true; wantSprite('swing_' + id); return; }
    // model is up → drop the fallback art
    disposeBatter(true);
    B.model = m; B.modelFor = id; B.key = 'model_' + id;
  }
  function buildBatter() {
    disposeBatter();
    B.modelWant = 'model_' + char.id;
    if (!MODELS.failed[B.modelWant] && modelEntry(B.modelWant)) {
      const want = char.id;
      requestModel(B.modelWant, g => { if (char.id !== want) return; if (B.swinging) { B.pendingModel = g; return; } mountBatterModel(g); }, 'swing_' + want);
      if (B.model) return;
    } else wantSprite('swing_' + char.id);
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
  function disposeBatter(keepModel = false) {
    if (!keepModel && B.model) { B.model.dispose(); B.model = null; B.modelFor = ''; }
    if (B.sprite) { B.sprite.dispose(); B.strip && B.strip.tex.dispose(); B.sprite = null; B.strip = null; }
    if (B.fox) { root.remove(B.fox.group); root.remove(B.fox.blob); B.fox.blob.geometry.dispose(); B.fox.blob.material.dispose(); B.fox.dispose(); B.fox = null; }
  }
  // swing frame schedule: 1 load, 2 stride, 3 CONTACT at exactly swingLead, 4, 5 hold
  function swingFrame(c) {
    const L = B.leadT;
    if (c < L * 0.5) return 1;
    if (c < L) return 2;
    if (c < L + 0.065) return 3;
    if (c < L + 0.165) return 4;
    return 5;
  }
  const _kpA = {}, _kpB = {};
  function initKp(o) { for (const k in BKR[0]) o[k] = typeof BK[0][k] === 'number' ? 0 : new THREE.Vector3(); return o; }
  initKp(_kpA); initKp(_kpB);
  const BT = () => { const L = B.leadT; return [0, L * 0.5, L, L + 0.07, L + 0.19, L + 0.34]; };
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
      const w = Math.max(0, 1 - Math.abs(c - B.leadT) / 0.09);
      kp.hands.y += B.adjust.y * w; kp.hands.x += B.adjust.x * w;
      kp.batDir.y += B.adjust.y * 0.12 * w;
      kp.batDir.normalize();
    }
    kp.handF.copy(kp.hands); kp.handB.copy(kp.hands).addScaledVector(kp.batDir, 0.32);
    kp.batKnob.copy(kp.hands).addScaledVector(kp.batDir, -0.14);
    kp.look.copy(B.lookPitcher); // pitcher, in rig space
    if (B.swinging && B.clock > B.leadT + 0.1 && B.flightLook) kp.look.copy(B.flightLook);
    kp.time = t;
    fox.pose(kp);
  }

  // ------------------------------------------------------------ pitcher
  const PT = { sprite: null, fox: null, model: null, clock: -1, strip: null, ballU: null, kp: null, checkT: 0, releaseFrame: 3, fast: false };
  function mountPitcherModel(g) {
    if (PT.model) return;
    let m = null;
    try { m = createFoxPitcher(THREE, g, envBase()); }
    catch (e) { console.warn('[actors] 3D pitcher failed, keeping fallback', e); MODELS.failed.model_pitcher = true; wantSprite('pitcher'); return; }
    disposePitcher(true);
    PT.model = m;
  }
  function buildPitcher() {
    disposePitcher();
    if (!MODELS.failed.model_pitcher && modelEntry('model_pitcher')) {
      requestModel('model_pitcher', g => { if (PT.clock >= 0 && PT.clock < TUNING.windupTime + 0.3) { PT.pendingModel = g; return; } mountPitcherModel(g); }, 'pitcher');
      if (PT.model) return;
    } else wantSprite('pitcher');
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
  function disposePitcher(keepModel = false) {
    if (!keepModel && PT.model) { PT.model.dispose(); PT.model = null; }
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

  function buildSwoosh3D(bs) {
    if (!B.model) return;
    const n = 30, L = B.leadT;
    const P = B.model.sweepPoints(S.swooshPts, n, L * 0.42, L + 0.13);
    if (S.swoosh) S.swoosh.release();
    S.swoosh = fx.tracer(P, '#e8f4ff', { count: n, head: 0, tail: -0.05, tailSoft: 0.05, width: 0.55 + 0.45 * bs, minPx: 3, maxPx: 12 + 14 * bs, opacity: 0.25 + 0.4 * bs, headK: 16, core: 0.9, gain: 1 + 0.5 * bs });
  }

  // ------------------------------------------------------------ API
  function startPitch(pitch) {
    resetPlay(false);
    S.pitch = pitch; S.phase = 'windup'; S.pt = -1; S.released = false;
    if (PT.model && PT.clock >= 0) PT.model.restart();       // mid-recovery → blend into the new windup
    PT.clock = 0; PT.fast = false;
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

  function swing(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const bs = Number.isFinite(o.batSpeed) ? clamp(o.batSpeed, 0, 1) : 0.72;
    B.leadT = Number.isFinite(o.leadT) && o.leadT > 0 ? o.leadT : leadFor(bs);
    B.batSpeed = bs;
    B.swinging = true; B.clock = 0; B.ghost = 0; B.hitstop = 0;
    B.flightLook = null;
    if (B.model) {
      B.model.swing({ ...o, batSpeed: bs, leadT: B.leadT, pitchLoc: o.pitchLoc || (S.pitch && S.pitch.plateLoc) });
      buildSwoosh3D(bs);
      fx.burst('dust', [batterSideSign() * 2.75 + (char.bats === 'L' ? -0.3 : 0.3), 0.1, BOX_Z - 1.4], { count: Math.round(4 + 6 * bs), size: 0.45, speed: 2 + 2 * bs, life: 0.8, opacity: 0.3, lift: 0.5 });
      return { leadT: B.leadT };
    }
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
    if (B.model) {
      if (!B.model.swinging && B.model.phase !== 'post') { B.leadT = 0.02; B.model.swing({ result: res, leadT: 0.02, batSpeed: res.batSpeed ?? 0.72 }); }
      B.model.contact(res);
    }
    if (B.clock < B.leadT) B.clock = B.leadT;
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
    B.lastTau = 0;
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
    B.swinging = false; B.clock = 0; B.ghost = 0; B.hitstop = 0; B.flightLook = null; B.rate = 1;
    if (B.model) B.model.reset();
    if (B.pendingModel) { const g = B.pendingModel; B.pendingModel = null; mountBatterModel(g); }
    // a 3D pitcher mid-recovery finishes his clip quickly instead of popping to the set
    if (PT.model && PT.clock >= TUNING.windupTime) PT.fast = true; else PT.clock = -1;
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
      if (!B.model && !B.sprite && A.img('swing_' + char.id) && A.meta('swing_' + char.id)) buildBatter();
      if (!PT.model && !PT.sprite && A.img('pitcher') && A.meta('pitcher')) buildPitcher();
      if (!B.model && !B.swinging && B.pendingModel) { const g = B.pendingModel; B.pendingModel = null; mountBatterModel(g); }
      if (!PT.model && PT.pendingModel && PT.clock < 0) { const g = PT.pendingModel; PT.pendingModel = null; mountPitcherModel(g); }
    }
    probeT -= dt; if (probeT <= 0) { probeT = 0.5; probeLight(); updateRim(); }

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
    } else if (B.model) {
      // follow the game's slow-mo during the flight (the follow-through stretches with it)
      if (S.phase === 'flight' && dt > 0) { const r = (S.tau - B.lastTau) / dt; B.lastTau = S.tau; B.rate += (clamp(r || 1, 0.3, 1) - B.rate) * Math.min(1, dt * 12); }
      else B.rate += (1 - B.rate) * Math.min(1, dt * 6);
      B.model.setRate(B.rate);
      B.model.update(dt, time, { windupT: PT.clock, pt: S.released ? S.pt : -1, pitch: S.pitch, ballPos: ball.visible && S.phase === 'pitch' ? [ball.position.x, ball.position.y, ball.position.z] : null });
      if (B.swinging) B.clock = B.model.clock;
    } else if (B.fox) {
      poseFoxBatter(time);
    }
    // swoosh follows the swing clock
    if (S.swoosh) {
      if (B.swinging && B.clock < B.leadT + 0.2) { S.swoosh.setHead(B.clock); S.swoosh.setTail(B.clock - (B.model ? 0.07 : 0.055)); }
      else { S.swoosh.release(); S.swoosh = null; }
    }

    // ---- pitcher
    if (PT.clock >= 0) PT.clock += dt * (PT.fast ? 2.4 : 1);
    if (PT.clock > TUNING.windupTime + (PT.model ? 2.7 : 2.2)) { PT.clock = -1; PT.fast = false; }   // back to the set position
    if (PT.sprite) {
      const f = pitcherFrame(PT.clock >= 0 ? PT.clock + dt * 0.5 : PT.clock);
      PT.sprite.setFrame(f);
      const U = PT.sprite.uniforms;
      U.uBreath.value = PT.clock < 0 ? Math.sin(time * 1.7) * 0.006 : 0;
      U.uTint.value.copy(light.tint); PT.sprite.sun.copy(light.sun); U.uShadow.value = light.shadow * 0.9;
    } else if (PT.model) PT.model.update(dt, time, PT.clock);
    else if (PT.fox) poseFoxPitcher(time);

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

  function updateRim() {
    // subtle fresnel rim so the foxes read against the crowd at night (stronger when the scene is dark)
    const k = clamp(1.25 - light.lum * 0.45, 0.18, 0.75) * 0.32;
    for (const m of [B.model, PT.model]) if (m && m.R && m.R.rim) m.R.rim.value.copy(light.tint).lerp(_c.set('#cfe0ff'), 0.5).multiplyScalar(k);
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
    /** batter/pitcher controllers (3D) — for harnesses / cinematics */
    get batter3D() { return B.model; }, get pitcher3D() { return PT.model; },
    /** Promise that resolves when the 3D batter + pitcher are mounted (or failed). */
    modelsReady() { const ks = ['model_' + char.id, 'model_pitcher']; return Promise.all(ks.map(k => (modelEntry(k) && assets.model ? assets.model(k) : null))).then(() => new Promise(r => setTimeout(r, 0))); },
    get state() { return { phase: S.phase, batterFrame: B.frame, swingClock: B.clock, pitcherFrame: pitcherFrame(PT.clock >= 0 ? PT.clock + 1 / 120 : PT.clock), pitcherClock: PT.clock, art: { batter: B.model ? 'model' : B.sprite ? 'sprite' : 'fox', pitcher: PT.model ? 'model' : PT.sprite ? 'sprite' : 'fox' }, leadT: B.leadT, batterPhase: B.model ? B.model.phase : null, tint: light.tint.getHexString(), ball: ball.position.toArray(), ballVisible: ball.visible }; },
  };
}
