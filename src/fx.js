// ============================================================================
// WINDY CITY DERBY — FX. Pooled GPU particles, glowing ribbons (Statcast tracer,
// pitch trails, swing swooshes), fireworks, confetti, shock rings.
// Owner: ACTORS. Only depends on the THREE instance passed in.
//
//   const fx = createFX(THREE, scene, { quality })
//   fx.burst(kind, pos, opts)      kinds: 'sparks' 'flash' 'flare' 'shock' 'dust'
//                                  'puff' 'debris' 'splinters' 'glitter' 'confetti'
//                                  'turf' 'embers' 'ring' (oriented shock ring)
//   fx.tracer(path, color, opts) → handle { setHead(t), setTail(t), setOpacity(a),
//                                  fade(sec), setColor(c), setWidth(ft), release() }
//   fx.fireworks(pos, n, opts)     n shells launched from pos
//   fx.update(dt)  fx.clear()  fx.dispose()
//
// Near-zero allocation per frame: SoA typed arrays, swap-remove, preallocated
// temporaries. Every particle is one instance of a quad (InstancedBufferGeometry).
// ============================================================================

const PART_VS = /* glsl */`
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute vec4 iPar;   // size, stretch, shape, rot
varying vec2 vUv;
varying vec4 vCol;
varying float vShape;
varying float vShade;
void main() {
  vUv = position.xy + 0.5;
  vCol = iCol;
  vShape = iPar.z;
  vShade = 1.0;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float size = iPar.x;
  vec2 c = position.xy;
  vec2 ax = vec2(1.0, 0.0);
  vec2 ay = vec2(0.0, 1.0);
  float len = size;
  float shape = iPar.z;
  if (shape > 0.5 && shape < 1.5 && iPar.y > 0.0) {
    // spark streak: stretch along the screen-space velocity
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 d = mv.xy * vv.z - vv.xy * mv.z;
    float dl = length(d);
    if (dl > 1e-5) { ax = d / dl; ay = vec2(-ax.y, ax.x); }
    len = size + iPar.y * length(vv);
    mv.xy -= ax * (len - size) * 0.5;
  } else if (shape > 2.5 && shape < 3.5) {
    // confetti: spin + flutter
    float r = iPar.w;
    float cr = cos(r), sr = sin(r);
    ax = vec2(cr, sr); ay = vec2(-sr, cr);
    float fl = cos(r * 1.73 + iPar.y);
    c.x *= 0.35 + 0.65 * abs(fl);
    c.y *= 0.55;
    vShade = 0.55 + 0.45 * abs(fl);
  } else if (shape > 4.5 && shape < 5.5) {
    // anamorphic flare: long horizontal streak
    len = size * max(iPar.y, 1.0);
    size = size * 0.18;
  }
  mv.xy += ax * c.x * len + ay * c.y * size;
  gl_Position = projectionMatrix * mv;
}`;

const PART_FS = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying float vShape;
varying float vShade;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a;
  vec3 col = vCol.rgb;
  if (vShape < 0.5) {                     // soft glow dot
    a = exp(-r * r * 4.5);
    col *= 1.0 + 1.6 * exp(-r * r * 22.0);
  } else if (vShape < 1.5) {              // spark streak, hot core
    a = exp(-r * r * 3.2);
    col = mix(col, vec3(1.0), exp(-r * r * 14.0) * 0.8);
  } else if (vShape < 2.5) {              // smoke / dust puff
    a = smoothstep(1.0, 0.05, r);
    a *= a * (0.8 + 0.2 * sin(p.x * 5.0 + p.y * 3.0));
  } else if (vShape < 3.5) {              // confetti
    a = step(r, 1.35);
    col *= vShade;
  } else if (vShape < 4.5) {              // 4-point star glint
    float sx = exp(-abs(p.y) * 14.0) * (1.0 - abs(p.x));
    float sy = exp(-abs(p.x) * 14.0) * (1.0 - abs(p.y));
    a = max(sx, sy) + exp(-r * r * 9.0);
    col *= 1.0 + exp(-r * r * 30.0);
  } else if (vShape < 5.5) {              // anamorphic flare
    a = exp(-abs(p.y) * 3.0) * pow(max(1.0 - abs(p.x), 0.0), 2.0);
  } else {                                // camera-facing shock ring
    float d = (r - 0.82) / 0.07;
    a = exp(-d * d) + 0.25 * exp(-((r - 0.7) / 0.18) * ((r - 0.7) / 0.18));
    a *= step(r, 1.0);
  }
  a *= vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RIB_VS = /* glsl */`
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aT;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uMinPx;
uniform float uMaxPx;
varying float vT;
varying float vSide;
varying float vFade;
void main() {
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c = mvp * vec4(position, 1.0);
  vec4 p = mvp * vec4(aPrev, 1.0);
  vec4 n = mvp * vec4(aNext, 1.0);
  float aspect = uViewport.x / max(uViewport.y, 1.0);
  float ok = step(0.3, c.w) * step(0.3, p.w) * step(0.3, n.w);
  vec2 ps = p.xy / max(p.w, 0.3);
  vec2 ns = n.xy / max(n.w, 0.3);
  vec2 d = ns - ps; d.x *= aspect;
  float L = length(d);
  d = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-d.y, d.x); nrm.x /= aspect;
  float wWorld = uWidth * projectionMatrix[1][1] / max(c.w, 0.3);
  float wMin = uMinPx * 2.0 / max(uViewport.y, 1.0);
  float wMax = uMaxPx * 2.0 / max(uViewport.y, 1.0);
  float w = clamp(wWorld, wMin, max(wMin, wMax)) * 0.5;
  c.xy += nrm * w * aSide * c.w;
  vT = aT; vSide = aSide; vFade = ok;
  gl_Position = c;
}`;

const RIB_FS = /* glsl */`
uniform vec3 uColor;
uniform float uHead;
uniform float uTail;
uniform float uTailSoft;
uniform float uOpacity;
uniform float uHeadK;
uniform float uCore;
uniform float uGain;
varying float vT;
varying float vSide;
varying float vFade;
void main() {
  if (vT > uHead || vT < uTail) discard;
  float d2 = vSide * vSide;
  float glow = exp(-d2 * 5.0) - 0.0067;
  float core = exp(-d2 * 70.0);
  float along = smoothstep(uTail, uTail + uTailSoft, vT);
  float hg = exp(-(uHead - vT) * uHeadK);
  vec3 col = uColor * uGain * (glow * (0.55 + 1.1 * hg)) + vec3(1.0) * core * uCore * uGain * (0.5 + 1.2 * hg);
  float a = clamp(glow * 0.75 + core, 0.0, 1.0) * along * uOpacity * vFade;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RING_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uThick;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float d = (r - (1.0 - uThick)) / uThick;
  float a = exp(-d * d * 2.5) * step(r, 1.0);
  a += 0.18 * smoothstep(1.0 - uThick * 3.0, 1.0, r) * step(r, 1.0);
  a *= uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * (1.0 + exp(-d * d * 12.0)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const RING_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------
const FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r0', 'g0', 'b0', 'r1', 'g1', 'b1',
  'a0', 'fin', 'fout', 'drag', 'grav', 'str', 'shape', 'rot', 'rotv', 'flick', 'seed'];

function makePool(THREE, parent, max, additive, renderOrder) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aPos = mk(3), aVel = mk(3), aCol = mk(4), aPar = mk(4);
  geo.setAttribute('iPos', aPos); geo.setAttribute('iVel', aVel); geo.setAttribute('iCol', aCol); geo.setAttribute('iPar', aPar);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PART_VS, fragmentShader: PART_FS, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = renderOrder; mesh.name = additive ? 'fx-glow' : 'fx-solid';
  parent.add(mesh);
  const S = {};
  for (const f of FIELDS) S[f] = new Float32Array(max);
  let n = 0;
  let time = 0;

  function spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a0, drag, grav, str, shape) {
    let i;
    if (n < max) i = n++;
    else { // pool full → recycle the oldest-looking slot (highest age/life)
      i = 0; let best = -1;
      for (let k = 0; k < n; k += 7) { const q = S.age[k] / S.life[k]; if (q > best) { best = q; i = k; } }
    }
    S.x[i] = x; S.y[i] = y; S.z[i] = z; S.vx[i] = vx; S.vy[i] = vy; S.vz[i] = vz;
    S.age[i] = 0; S.life[i] = Math.max(0.016, life); S.s0[i] = s0; S.s1[i] = s1;
    S.r0[i] = c0.r; S.g0[i] = c0.g; S.b0[i] = c0.b; const cc = c1 || c0; S.r1[i] = cc.r; S.g1[i] = cc.g; S.b1[i] = cc.b;
    S.a0[i] = a0; S.fin[i] = 0; S.fout[i] = 0.35; S.drag[i] = drag; S.grav[i] = grav; S.str[i] = str; S.shape[i] = shape;
    S.rot[i] = 0; S.rotv[i] = 0; S.flick[i] = 0; S.seed[i] = Math.random() * 6.283;
    return i;
  }
  function copy(to, from) { for (const f of FIELDS) { const a = S[f]; a[to] = a[from]; } }

  function update(dt) {
    time += dt;
    const P = aPos.array, V = aVel.array, C = aCol.array, R = aPar.array;
    for (let i = 0; i < n; i++) {
      let age = S.age[i] + dt;
      if (age >= S.life[i]) { n--; if (i !== n) copy(i, n); i--; continue; }
      S.age[i] = age;
      const k = age / S.life[i];
      const dr = Math.exp(-S.drag[i] * dt);
      S.vx[i] *= dr; S.vy[i] = S.vy[i] * dr - S.grav[i] * dt; S.vz[i] *= dr;
      S.x[i] += S.vx[i] * dt; S.y[i] += S.vy[i] * dt; S.z[i] += S.vz[i] * dt;
      S.rot[i] += S.rotv[i] * dt;
      const e = 1 - (1 - k) * (1 - k);
      const size = S.s0[i] + (S.s1[i] - S.s0[i]) * e;
      let a = S.a0[i];
      const fi = S.fin[i], fo = S.fout[i];
      if (fi > 0 && k < fi) a *= k / fi;
      if (k > 1 - fo) a *= (1 - k) / fo;
      if (S.flick[i] > 0) a *= 1 - S.flick[i] * (0.5 + 0.5 * Math.sin(time * 38 + S.seed[i] * 9));
      const j3 = i * 3, j4 = i * 4;
      P[j3] = S.x[i]; P[j3 + 1] = S.y[i]; P[j3 + 2] = S.z[i];
      V[j3] = S.vx[i]; V[j3 + 1] = S.vy[i]; V[j3 + 2] = S.vz[i];
      C[j4] = S.r0[i] + (S.r1[i] - S.r0[i]) * k; C[j4 + 1] = S.g0[i] + (S.g1[i] - S.g0[i]) * k; C[j4 + 2] = S.b0[i] + (S.b1[i] - S.b0[i]) * k; C[j4 + 3] = a;
      R[j4] = size; R[j4 + 1] = S.shape[i] === 3 ? S.seed[i] : S.str[i]; R[j4 + 2] = S.shape[i]; R[j4 + 3] = S.rot[i];
    }
    geo.instanceCount = n;
    if (n > 0) {
      aPos.clearUpdateRanges(); aPos.addUpdateRange(0, n * 3); aPos.needsUpdate = true;
      aVel.clearUpdateRanges(); aVel.addUpdateRange(0, n * 3); aVel.needsUpdate = true;
      aCol.clearUpdateRanges(); aCol.addUpdateRange(0, n * 4); aCol.needsUpdate = true;
      aPar.clearUpdateRanges(); aPar.addUpdateRange(0, n * 4); aPar.needsUpdate = true;
    }
    mesh.visible = n > 0;
  }
  return {
    S, spawn, update, mesh, get count() { return n; }, clear() { n = 0; geo.instanceCount = 0; mesh.visible = false; },
    dispose() { parent.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------------------
// Ribbon (tracer / trail / swoosh). Screen-extruded, world width with a pixel floor.
// ---------------------------------------------------------------------------
function makeRibbon(THREE, parent, cap) {
  const geo = new THREE.BufferGeometry();
  let capacity = 0;
  let attrs = null;
  const uniforms = {
    uViewport: { value: new THREE.Vector2(390, 844) }, uWidth: { value: 1.2 }, uMinPx: { value: 3 }, uMaxPx: { value: 1e4 },
    uColor: { value: new THREE.Color(1, 1, 1) }, uHead: { value: 0 }, uTail: { value: -1 }, uTailSoft: { value: 0.12 },
    uOpacity: { value: 1 }, uHeadK: { value: 3 }, uCore: { value: 1 }, uGain: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: RIB_VS, fragmentShader: RIB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 12; mesh.visible = false; mesh.name = 'fx-ribbon';
  const vp = new THREE.Vector2();
  mesh.onBeforeRender = (renderer) => { renderer.getDrawingBufferSize(vp); uniforms.uViewport.value.copy(vp); const pr = renderer.getPixelRatio(); uniforms.uMinPx.value = mesh.userData.minPx * pr; uniforms.uMaxPx.value = mesh.userData.maxPx * pr; };
  mesh.userData.minPx = 3; mesh.userData.maxPx = 1e4;
  parent.add(mesh);

  function alloc(n) {
    capacity = Math.max(n, 16);
    const V = capacity * 2;
    attrs = {
      position: new THREE.BufferAttribute(new Float32Array(V * 3), 3),
      aPrev: new THREE.BufferAttribute(new Float32Array(V * 3), 3),
      aNext: new THREE.BufferAttribute(new Float32Array(V * 3), 3),
      aSide: new THREE.BufferAttribute(new Float32Array(V), 1),
      aT: new THREE.BufferAttribute(new Float32Array(V), 1),
    };
    for (const k in attrs) geo.setAttribute(k, attrs[k]);
    const idx = new (V > 65535 ? Uint32Array : Uint16Array)((capacity - 1) * 6);
    for (let i = 0, o = 0; i < capacity - 1; i++) {
      const a = i * 2; idx[o++] = a; idx[o++] = a + 1; idx[o++] = a + 2; idx[o++] = a + 1; idx[o++] = a + 3; idx[o++] = a + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    for (let i = 0; i < V; i++) attrs.aSide.array[i] = (i & 1) ? -1 : 1;
    attrs.aSide.needsUpdate = true;
  }
  alloc(cap);

  /** pts: Float32Array [t,x,y,z]*; count = number of points */
  function setPath(pts, count) {
    const n = Math.min(count ?? Math.floor(pts.length / 4), Math.floor(pts.length / 4));
    if (n < 2) { mesh.visible = false; return 0; }
    if (n > capacity) alloc(n);
    const P = attrs.position.array, Pr = attrs.aPrev.array, Nx = attrs.aNext.array, T = attrs.aT.array;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const x = pts[o + 1], y = pts[o + 2], z = pts[o + 3];
      let px, py, pz, nx, ny, nz;
      if (i > 0) { px = pts[o - 3]; py = pts[o - 2]; pz = pts[o - 1]; } else { px = 2 * x - pts[o + 5]; py = 2 * y - pts[o + 6]; pz = 2 * z - pts[o + 7]; }
      if (i < n - 1) { nx = pts[o + 5]; ny = pts[o + 6]; nz = pts[o + 7]; } else { nx = 2 * x - px; ny = 2 * y - py; nz = 2 * z - pz; }
      for (let s = 0; s < 2; s++) {
        const v = (i * 2 + s) * 3;
        P[v] = x; P[v + 1] = y; P[v + 2] = z;
        Pr[v] = px; Pr[v + 1] = py; Pr[v + 2] = pz;
        Nx[v] = nx; Nx[v + 1] = ny; Nx[v + 2] = nz;
        T[i * 2 + s] = pts[o];
      }
    }
    for (const k of ['position', 'aPrev', 'aNext', 'aT']) attrs[k].needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
    mesh.visible = true;
    return n;
  }
  return { mesh, uniforms, setPath, dispose() { parent.remove(mesh); geo.dispose(); mat.dispose(); } };
}

// ---------------------------------------------------------------------------
export function createFX(THREE, scene, opts = {}) {
  const quality = opts.quality || 'high';
  const root = new THREE.Group(); root.name = 'fx';
  scene.add(root);
  const glow = makePool(THREE, root, quality === 'low' ? 900 : 2200, true, 14);
  const solid = makePool(THREE, root, quality === 'low' ? 300 : 700, false, 13);

  // temporaries
  const C0 = new THREE.Color(), C1 = new THREE.Color(), CW = new THREE.Color(1, 1, 1);
  const tv = new THREE.Vector3(), tu = new THREE.Vector3(), tw = new THREE.Vector3();
  const rnd = Math.random;
  const col = (c, out) => (c == null ? out.set(1, 1, 1) : c.isColor ? out.copy(c) : out.set(c));

  // oriented shock rings (bat crack sonic ring, landing ripples)
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uThick: { value: 0.12 } },
      vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    m.visible = false; m.frustumCulled = false; m.renderOrder = 13;
    m.userData = { age: 0, life: 1, r0: 1, r1: 2, a0: 1, active: false };
    root.add(m); rings.push(m);
  }
  function ring(pos, normal, { color = '#ffffff', r0 = 0.3, r1 = 4, life = 0.35, opacity = 1, thick = 0.12, delay = 0 } = {}) {
    let m = rings.find(r => !r.userData.active) || rings.reduce((a, b) => (a.userData.age / a.userData.life > b.userData.age / b.userData.life ? a : b));
    const u = m.userData;
    u.active = true; u.age = -delay; u.life = life; u.r0 = r0; u.r1 = r1; u.a0 = opacity;
    m.material.uniforms.uColor.value.set(color); m.material.uniforms.uThick.value = thick;
    m.position.set(pos[0] ?? pos.x, pos[1] ?? pos.y, pos[2] ?? pos.z);
    tv.set(normal[0] ?? normal.x, normal[1] ?? normal.y, normal[2] ?? normal.z).normalize();
    m.quaternion.setFromUnitVectors(tu.set(0, 0, 1), tv);
    m.scale.setScalar(r0); m.visible = delay <= 0; m.material.uniforms.uOpacity.value = delay <= 0 ? opacity : 0;
    return m;
  }

  // ribbons
  const ribbons = [];
  function getRibbon(cap) {
    let r = ribbons.find(x => !x.inUse);
    if (!r) { r = makeRibbon(THREE, root, cap || 700); r.inUse = false; ribbons.push(r); }
    r.inUse = true; r.fadeRate = 0; r.autoRelease = false; r.mesh.userData.minPx = 3;
    return r;
  }

  function tracer(path, color = '#ffb347', o = {}) {
    const pts = path && path.pts ? path.pts : path;
    const r = getRibbon(pts ? pts.length / 4 : 64);
    const U = r.uniforms;
    col(color, U.uColor.value);
    U.uWidth.value = o.width ?? 1.3; r.mesh.userData.minPx = o.minPx ?? 3.2; r.mesh.userData.maxPx = o.maxPx ?? 1e4;
    U.uHead.value = o.head ?? 0; U.uTail.value = o.tail ?? -1; U.uTailSoft.value = o.tailSoft ?? 0.25;
    U.uOpacity.value = o.opacity ?? 1; U.uHeadK.value = o.headK ?? 2.2; U.uCore.value = o.core ?? 1; U.uGain.value = o.gain ?? 1;
    const n = pts ? r.setPath(pts, o.count) : 0;
    const h = {
      ribbon: r, mesh: r.mesh, points: n,
      setPath(p, count) { const q = p && p.pts ? p.pts : p; h.points = r.setPath(q, count); return h; },
      setHead(t) { U.uHead.value = t; return h; },
      setTail(t) { U.uTail.value = t; return h; },
      setOpacity(a) { U.uOpacity.value = a; r.fadeRate = 0; r.mesh.visible = a > 0.001 && h.points > 1; return h; },
      get opacity() { return U.uOpacity.value; },
      fade(sec = 0.4, release = false) { r.fadeRate = U.uOpacity.value / Math.max(0.01, sec); r.autoRelease = release; if (r.fadeRate <= 0 && release) h.release(); return h; },
      setColor(c) { col(c, U.uColor.value); return h; },
      setWidth(w, minPx) { U.uWidth.value = w; if (minPx != null) r.mesh.userData.minPx = minPx; return h; },
      release() { r.inUse = false; r.mesh.visible = false; r.fadeRate = 0; },
    };
    r.handle = h;
    return h;
  }

  // ---------------------------------------------------------------- bursts
  function randDir(out) { // uniform on sphere
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return out.set(s * Math.cos(th), u, s * Math.sin(th));
  }
  function coneDir(out, dx, dy, dz, spread) { // random direction within a cone around d
    randDir(tw); out.set(dx, dy, dz).normalize().addScaledVector(tw, spread).normalize();
    return out;
  }

  function burst(kind, pos, o = {}) {
    const x = pos[0] ?? pos.x, y = pos[1] ?? pos.y, z = pos[2] ?? pos.z;
    const k = o.scale ?? 1;
    const d = o.dir ? (Array.isArray(o.dir) ? tu.set(o.dir[0], o.dir[1], o.dir[2]) : tu.copy(o.dir)) : tu.set(0, 1, 0);
    switch (kind) {
      case 'sparks': {
        const n = o.count ?? 40; col(o.color ?? '#ffd27a', C0); col(o.color2 ?? '#ff5a1f', C1);
        for (let i = 0; i < n; i++) {
          coneDir(tv, d.x, d.y, d.z, o.spread ?? 0.9);
          const sp = (o.speed ?? 55) * (0.35 + rnd() * 0.9) * k;
          const j = glow.spawn(x, y, z, tv.x * sp, tv.y * sp, tv.z * sp, (o.life ?? 0.42) * (0.5 + rnd() * 0.8), 0.07 * k, 0.03 * k, C0, C1, 1, 3.2, 26, 0.018, 1);
          glow.S.fout[j] = 0.6;
        }
        break;
      }
      case 'flash': {
        col(o.color ?? '#fff4dc', C0);
        const j = glow.spawn(x, y, z, 0, 0, 0, o.life ?? 0.16, (o.size ?? 2.2) * k, (o.size ?? 2.2) * k * 2.4, C0, C0, o.opacity ?? 1, 0, 0, 0, 0);
        glow.S.fout[j] = 0.8;
        break;
      }
      case 'flare': {
        col(o.color ?? '#bfe6ff', C0);
        const j = glow.spawn(x, y, z, 0, 0, 0, o.life ?? 0.22, (o.size ?? 5) * k, (o.size ?? 5) * k * 1.6, C0, C0, o.opacity ?? 0.9, 0, 0, o.aspect ?? 7, 5);
        glow.S.fout[j] = 0.85;
        break;
      }
      case 'shock': { // camera-facing ring
        col(o.color ?? '#ffffff', C0);
        const j = glow.spawn(x, y, z, 0, 0, 0, o.life ?? 0.3, (o.r0 ?? 0.5) * 2 * k, (o.r1 ?? 6) * 2 * k, C0, C0, o.opacity ?? 0.9, 0, 0, 0, 6);
        glow.S.fout[j] = 0.9;
        break;
      }
      case 'ring': ring([x, y, z], o.normal || [d.x, d.y, d.z], o); break;
      case 'glitter': {
        const n = o.count ?? 24; col(o.color ?? '#ffe7a3', C0); col(o.color2 ?? o.color ?? '#ffffff', C1);
        for (let i = 0; i < n; i++) {
          randDir(tv); const sp = (o.speed ?? 14) * (0.3 + rnd()) * k;
          const j = glow.spawn(x, y, z, tv.x * sp, Math.abs(tv.y) * sp * 0.8 + (o.lift ?? 4), tv.z * sp, (o.life ?? 1.3) * (0.6 + rnd() * 0.7), (o.size ?? 0.9) * k, 0.2 * k, C0, C1, 1, 1.4, o.grav ?? 5, 0, 4);
          glow.S.flick[j] = 0.7;
        }
        break;
      }
      case 'embers': {
        const n = o.count ?? 20; col(o.color ?? '#ffb040', C0); col(o.color2 ?? '#ff3a10', C1);
        for (let i = 0; i < n; i++) {
          randDir(tv); const sp = (o.speed ?? 8) * (0.3 + rnd()) * k;
          const j = glow.spawn(x, y, z, tv.x * sp, Math.abs(tv.y) * sp + 3, tv.z * sp, (o.life ?? 1.2) * (0.6 + rnd() * 0.7), (o.size ?? 0.35) * k, 0.1 * k, C0, C1, 1, 1.0, -2, 0, 0);
          glow.S.flick[j] = 0.5;
        }
        break;
      }
      case 'dust': case 'puff': case 'turf': {
        const n = o.count ?? (kind === 'puff' ? 8 : 14);
        col(o.color ?? (kind === 'turf' ? '#5f7f3a' : kind === 'puff' ? '#e8e0d0' : '#b99468'), C0);
        C1.copy(C0).lerp(CW, 0.25);
        for (let i = 0; i < n; i++) {
          randDir(tv); if (tv.y < 0) tv.y = -tv.y * 0.4;
          const sp = (o.speed ?? 6) * (0.3 + rnd()) * k;
          const s0 = (o.size ?? 0.9) * k * (0.6 + rnd() * 0.6);
          const j = solid.spawn(x + tv.x * 0.3 * k, y + tv.y * 0.1, z + tv.z * 0.3 * k, tv.x * sp + d.x * 3, tv.y * sp * 0.6 + (o.lift ?? 1.5), tv.z * sp + d.z * 3,
            (o.life ?? 1.1) * (0.6 + rnd() * 0.7), s0, s0 * (o.grow ?? 3), C0, C1, (o.opacity ?? 0.55), 2.2, o.grav ?? -0.4, 0, 2);
          solid.S.fin[j] = 0.12; solid.S.fout[j] = 0.7;
        }
        if (kind === 'turf') { // a few grass/dirt clods
          col('#3f5f22', C0);
          for (let i = 0; i < (o.clods ?? 10); i++) {
            randDir(tv); const sp = (o.speed ?? 6) * (0.8 + rnd()) * k;
            const j = solid.spawn(x, y + 0.1, z, tv.x * sp, Math.abs(tv.y) * sp + 6 * k, tv.z * sp, 0.7 + rnd() * 0.5, 0.25 * k, 0.2 * k, C0, C0, 1, 0.5, 30, 0, 3);
            solid.S.rotv[j] = (rnd() - 0.5) * 20;
          }
        }
        break;
      }
      case 'debris': case 'splinters': {
        const n = o.count ?? 12; col(o.color ?? (kind === 'splinters' ? '#d8b27a' : '#8a6a44'), C0);
        for (let i = 0; i < n; i++) {
          coneDir(tv, d.x, d.y, d.z, o.spread ?? 1.1); const sp = (o.speed ?? 22) * (0.3 + rnd()) * k;
          const j = solid.spawn(x, y, z, tv.x * sp, tv.y * sp + 4, tv.z * sp, 0.6 + rnd() * 0.6, (o.size ?? 0.18) * k, (o.size ?? 0.18) * k, C0, C0, 1, 0.8, 28, 0, 3);
          solid.S.rotv[j] = (rnd() - 0.5) * 40;
        }
        break;
      }
      case 'confetti': {
        const n = o.count ?? 80;
        const pal = o.palette || ['#ffcf3a', '#2f80ff', '#ff4b6e', '#ffffff', '#35d0ff', '#ff7a1a'];
        for (let i = 0; i < n; i++) {
          col(pal[i % pal.length], C0);
          randDir(tv);
          const sp = (o.speed ?? 16) * (0.3 + rnd()) * k;
          const j = solid.spawn(x + tv.x * (o.radius ?? 2), y + tv.y * (o.radius ?? 2), z + tv.z * (o.radius ?? 2),
            tv.x * sp, Math.abs(tv.y) * sp + (o.lift ?? 10), tv.z * sp, (o.life ?? 3.2) * (0.7 + rnd() * 0.5), (o.size ?? 0.55) * k, (o.size ?? 0.55) * k, C0, C0, 1, 2.2, 7, 0, 3);
          solid.S.rotv[j] = (rnd() - 0.5) * 16; solid.S.rot[j] = rnd() * 6.28; solid.S.fout[j] = 0.25;
        }
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- fireworks
  const SHELL_PAL = ['#ffcf3a', '#ff4b3a', '#3aa8ff', '#ffffff', '#7cff6b', '#ff5fd2', '#b46bff', '#35d0ff'];
  const shells = [];
  for (let i = 0; i < 24; i++) shells.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, fuse: 1, c: new THREE.Color(), c2: new THREE.Color(), size: 1, kind: 0, trailAcc: 0, delay: 0 });
  function fireworks(pos, n = 5, o = {}) {
    const x = pos[0] ?? pos.x, y = pos[1] ?? pos.y, z = pos[2] ?? pos.z;
    const pal = o.palette || SHELL_PAL;
    for (let i = 0; i < n; i++) {
      const s = shells.find(q => !q.on); if (!s) break;
      s.on = true; s.t = 0; s.delay = (o.stagger ?? 0.22) * i + rnd() * 0.12;
      s.x = x + (rnd() - 0.5) * (o.spreadX ?? 60); s.y = y; s.z = z + (rnd() - 0.5) * (o.spreadZ ?? 20);
      const h = (o.height ?? 170) * (0.75 + rnd() * 0.5);
      s.vy = Math.sqrt(2 * 32 * h); s.vx = (rnd() - 0.5) * 20; s.vz = (rnd() - 0.5) * 20;
      s.fuse = s.vy / 32 * (0.92 + rnd() * 0.1);
      s.c.set(pal[Math.floor(rnd() * pal.length)]); s.c2.set(pal[Math.floor(rnd() * pal.length)]);
      s.size = (o.size ?? 1) * (0.8 + rnd() * 0.5); s.kind = Math.floor(rnd() * 3); s.trailAcc = 0;
    }
  }
  function explode(s) {
    const n = Math.round((quality === 'low' ? 45 : 90) * s.size);
    const sp0 = 62 * s.size;
    for (let i = 0; i < n; i++) {
      randDir(tv);
      const sp = s.kind === 1 ? sp0 : sp0 * (0.55 + rnd() * 0.45);
      const c = (i & 1) ? s.c : s.c2;
      C1.copy(c).multiplyScalar(0.35);
      const j = glow.spawn(s.x, s.y, s.z, tv.x * sp + s.vx * 0.3, tv.y * sp + s.vy * 0.2, tv.z * sp + s.vz * 0.3, 1.5 + rnd() * 0.9, 2.2 * s.size, 1.3 * s.size, c, C1, 1, 1.25, 16, 0.07, 1);
      glow.S.fout[j] = 0.5;
      if (s.kind === 2) glow.S.flick[j] = 0.6;
    }
    col('#fff6e0', C0);
    glow.spawn(s.x, s.y, s.z, 0, 0, 0, 0.35, 30 * s.size, 70 * s.size, C0, s.c, 0.9, 0, 0, 0, 0);
    if (s.kind === 0) { // crackle glitter after the break
      for (let i = 0; i < 26; i++) {
        randDir(tv); const sp = sp0 * 0.5 * rnd();
        const j = glow.spawn(s.x, s.y, s.z, tv.x * sp, tv.y * sp, tv.z * sp, 1.6 + rnd() * 0.8, 1.6 * s.size, 0.6 * s.size, CW, s.c, 1, 1.4, 10, 0, 4);
        glow.S.flick[j] = 0.9; glow.S.fin[j] = 0.4;
      }
    }
  }
  function updateShells(dt) {
    for (const s of shells) {
      if (!s.on) continue;
      if (s.delay > 0) { s.delay -= dt; continue; }
      s.t += dt;
      s.vy -= 32 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.trailAcc += dt;
      while (s.trailAcc > 1 / 45) {
        s.trailAcc -= 1 / 45;
        C1.copy(s.c).multiplyScalar(0.4);
        glow.spawn(s.x, s.y, s.z, (rnd() - 0.5) * 4, -6 + rnd() * 3, (rnd() - 0.5) * 4, 0.45 + rnd() * 0.3, 1.6, 0.4, CW, C1, 0.8, 1.5, 10, 0, 0);
      }
      if (s.t >= s.fuse) { explode(s); s.on = false; }
    }
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    updateShells(dt);
    glow.update(dt); solid.update(dt);
    for (const m of rings) {
      const u = m.userData; if (!u.active) continue;
      u.age += dt;
      if (u.age < 0) continue;
      const k = u.age / u.life;
      if (k >= 1) { u.active = false; m.visible = false; continue; }
      m.visible = true;
      const e = 1 - Math.pow(1 - k, 3);
      m.scale.setScalar(u.r0 + (u.r1 - u.r0) * e);
      m.material.uniforms.uOpacity.value = u.a0 * (1 - k) * (1 - k);
    }
    for (const r of ribbons) {
      if (r.fadeRate > 0) {
        const U = r.uniforms; U.uOpacity.value = Math.max(0, U.uOpacity.value - r.fadeRate * dt);
        if (U.uOpacity.value <= 0) { r.fadeRate = 0; r.mesh.visible = false; if (r.autoRelease) { r.autoRelease = false; r.inUse = false; } }
      }
    }
  }

  function clear() {
    glow.clear(); solid.clear();
    for (const s of shells) s.on = false;
    for (const m of rings) { m.userData.active = false; m.visible = false; }
    for (const r of ribbons) { r.mesh.visible = false; r.fadeRate = 0; r.inUse = false; }
  }

  function dispose() {
    clear(); glow.dispose(); solid.dispose();
    for (const m of rings) { root.remove(m); m.material.dispose(); }
    ringGeo.dispose();
    for (const r of ribbons) r.dispose();
    scene.remove(root);
  }

  return {
    burst, tracer, fireworks, update, clear, dispose, ring, root,
    get counts() { return { glow: glow.count, solid: solid.count, ribbons: ribbons.filter(r => r.inUse).length }; },
  };
}
