// ============================================================================
// WINDY CITY DERBY — crowd (v2).  Owner: CROWD agent.
// Tens of thousands of individual fans for every seat the park builders
// register, in ONE draw call. Shared by both parks (src/parks/*.js).
// Pure three.js — THREE is passed in.
//
// FROZEN API (park builders code against it):
//   const crowd = createCrowd(THREE, { parkId, quality, look, assets });
//   crowd.addRow([x0,y0,z0], [x1,y1,z1], { spacing, fill, kind, facing, section });
//   crowd.addFan(x, y, z, { facing, kind, section, standing });
//   const obj = crowd.build();          // THREE.Object3D — add it to your group
//   crowd.update(dt, t);                // every frame
//   crowd.setExcite(0..1);              // overall energy (0.3 idle … 0.85 homer in flight)
//   crowd.flash(spray);                 // homer reaction around a spray angle
//   crowd.wave({ fromSpray, laps, speed }) → seconds;   // THE WAVE
//        fromSpray: where it starts (deg, spray convention; ±180 = behind home; default -35 = LF bleachers)
//        laps: times round the bowl (default 1.5)   speed: ft/s along the seats (default 40 ≈ 12 m/s ≈ 20 seats/s)
//        → seconds until the last fan sits down (≈ laps × bowl length / speed + 3.7 s; a 1-lap Wrigley wave ≈ 35-45 s).
//        It travels clockwise seen from above (LF → CF → RF → behind home), section by section (every row of a
//        section rises together), with anticipation, stragglers, refusers, a crescendo and a ragged finish.
//        Separate crowds of the same park (bowl / rooftops …) share one wave geometry, so call wave() on
//        each in the same frame and they ripple as one.
//   crowd.celebrate({ spray, big })     // everyone up (out-of-the-park, walk-off moments)
//   crowd.count, crowd.dispose()
//
// OPTIONAL ADDITIONS (safe to ignore; all no-ops before build()):
//   crowd.flash(spray, { landing:[x,y,z], big })   // landing → hot zone is a true radius round the ball
//   crowd.groan(amount=1)               // slump / hands on heads (an out). ALSO fires automatically when
//                                       //  setExcite rises to ≥0.5 (ball in play) then drops <0.42 with no
//                                       //  flash/celebrate in between — i.e. the game's existing setCrowd calls.
//   crowd.scramble([x,y,z], { radius }) // street ballhawks (kind 2 near that height) sprint to the ball
//   crowd.wave({ ..., dir:-1 })         // counter-clockwise
//   crowd.waveFront() → { active, spray, pos:[x,y,z], t, dur, progress } — where the crest is now (cameras/audio)
//   crowd.setLook(look)                 // retime lighting without a rebuild (same shape as createCrowd's look)
//   crowd.setQuality(tier)              // high|medium|low: atlas resolution (density is fixed at build)
//   crowd.stats() → { count, drawCalls, triangles, atlas:'ai'|'procedural', cells }
//   look extras: { tint:'#hex'|[r,g,b], shadeTint, sun:[x,y,z] (toward the sun) } — all optional
//
// Coordinates: world feet, home plate at origin, CF = -Z. Spray angle of a
// point = atan2(x, -z) in degrees. y = seat/bench surface height (the fan's
// seat). For kind 2 (always standing) y = the FLOOR they stand on (street,
// sidewalk, rooftop deck). facing = [fx, fz] unit vector the fan looks toward;
// default: home plate.
// kind: 0 = sunlit, 1 = in shade (under a roof/upper deck), 2 = street/standing
// (ballhawks on Waveland, rooftop decks — always standing).
//
// TECHNIQUE: instanced impostor cards (one quad per fan) sampling a 32-person x
// 5-pose photographic sprite atlas (assets/crowd/crowd_atlas.webp, generated
// with Higgsfield; shirts keyed magenta and caps keyed cyan so every fan gets
// its own park-coloured shirt/cap at runtime). Legs/pants are procedural below
// the waist cut so fans can stand up. All behaviour (idle fidgets, clapping,
// standing, homer hot zones, groans, THE WAVE, ballhawk scrambles, night phone
// lights) is evaluated per fan in the vertex shader from a handful of uniforms —
// zero per-frame CPU work per fan. Alpha-to-coverage + mip-aware coverage keeps
// distant fans from shimmering; falls back to a hard cut without MSAA.
// If the atlas asset is missing a procedural atlas with the same layout is
// painted on a canvas, so the crowd still looks right.
// ============================================================================

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Atlas layout + per-identity metadata (matches assets/crowd/crowd_atlas.webp; a
// manifest entry may override with `cells: {...}`). Cell index = id*poses + pose,
// col = idx % cols, row = floor(idx / cols) (row 0 = top of the image).
// Poses: 0 relaxed, 1 clap (open), 2 clap (closed), 3 arms up, 4 hands on head.
const ATLAS_META = {
  cols: 16, rows: 10, poses: 5, waistV: 0.035, relH: 0.575, ids: 32,
  waist: [0.3, 0.37, 0.324, 0.305, 0.345, 0.303, 0.256, 0.351, 0.332, 0.327, 0.327, 0.338, 0.333, 0.348, 0.284, 0.34, 0.303, 0.329, 0.311, 0.31, 0.321, 0.307, 0.234, 0.333, 0.272, 0.229, 0.295, 0.231, 0.289, 0.258, 0.22, 0.324],
  height: [0.576, 0.566, 0.581, 0.571, 0.576, 0.557, 0.483, 0.586, 0.576, 0.571, 0.557, 0.591, 0.576, 0.557, 0.566, 0.571, 0.566, 0.576, 0.581, 0.566, 0.576, 0.571, 0.435, 0.581, 0.576, 0.547, 0.576, 0.547, 0.576, 0.576, 0.547, 0.571],
  groan: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1],
  skin: [[0.722, 0.51, 0.427], [0.82, 0.565, 0.529], [0.547, 0.341, 0.247], [0.851, 0.624, 0.537], [0.69, 0.443, 0.353], [0.875, 0.659, 0.569], [0.675, 0.463, 0.373], [0.733, 0.502, 0.451], [0.576, 0.365, 0.251], [0.878, 0.608, 0.541], [0.827, 0.576, 0.439], [0.859, 0.604, 0.529], [0.765, 0.514, 0.416], [0.58, 0.365, 0.298], [0.647, 0.42, 0.322], [0.796, 0.541, 0.427], [0.824, 0.6, 0.518], [0.51, 0.325, 0.255], [0.878, 0.635, 0.573], [0.851, 0.616, 0.494], [0.827, 0.6, 0.533], [0.745, 0.539, 0.439], [0.871, 0.678, 0.588], [0.788, 0.537, 0.498], [0.8, 0.565, 0.498], [0.718, 0.443, 0.318], [0.761, 0.529, 0.478], [0.835, 0.576, 0.475], [0.851, 0.604, 0.51], [0.533, 0.318, 0.231], [0.871, 0.624, 0.545], [0.651, 0.42, 0.341]],
};
const CELL_FT = 4.0;                 // atlas cell height in feet (a relaxed adult is relH of it: ~2.3 ft waist→crown)

// Fan colours. [hex, weight]. Wrigley: royal blue / white / red; Rate: black / silver / white;
// + neutrals everywhere and a little Blufox navy/blue.
const BLUFOX = [['#101c3d', 3], ['#2f80ff', 1]];
const NEUTRAL = [['#c9b48a', 2], ['#3f6a3a', 1.5], ['#6b2a35', 1], ['#e3cc45', 1], ['#e2813a', 0.8], ['#d58db0', 1.2],
  ['#5a3d2b', 1], ['#2c7f8a', 1], ['#b0b8c4', 2.5], ['#4a5a78', 2], ['#8a1c2b', 0.6], ['#f2e6d0', 1.2]];
const SHIRTS = {
  wrigley: [['#1b47b8', 24], ['#0e2f7a', 8], ['#f0f0ee', 15], ['#c6202f', 9], ['#13203f', 7], ['#7da3dd', 4],
    ['#8b8e93', 6], ['#1a1b1e', 5], ...BLUFOX, ...NEUTRAL],
  rate: [['#16181c', 26], ['#26282d', 8], ['#c4ccd4', 12], ['#f0f0ee', 14], ['#8b8e93', 8], ['#3a3d44', 5], ['#13203f', 4],
    ['#b3202a', 1.5], ['#1b47b8', 1.5], ['#7da3dd', 1], ...BLUFOX, ...NEUTRAL],
};
const CAPS = {
  wrigley: [['#1b47b8', 50], ['#13203f', 12], ['#c6202f', 8], ['#f0f0ee', 7], ['#1a1b1e', 7], ['#8b8e93', 5], ['#101c3d', 5], ['#c9b48a', 2]],
  rate: [['#16181c', 60], ['#8b8e93', 8], ['#c4ccd4', 6], ['#f0f0ee', 9], ['#13203f', 8], ['#b3202a', 2], ['#101c3d', 5], ['#c9b48a', 2]],
};
const PANTS = [['#3b4f73', 40], ['#24324d', 16], ['#b39f7a', 11], ['#1d1e22', 13], ['#6b6e73', 8], ['#4a4033', 5], ['#7d8aa3', 4]];

function hexRGB(h) { const n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function toRGB(v, d) {
  if (Array.isArray(v)) return [+v[0] || 0, +v[1] || 0, +v[2] || 0];
  if (typeof v === 'string') return hexRGB(v);
  return d;
}
function picker(list) {
  const tot = list.reduce((s, e) => s + e[1], 0);
  const cols = list.map(e => hexRGB(e[0]));
  const cum = []; let acc = 0; for (const e of list) { acc += e[1] / tot; cum.push(acc); }
  return r => { for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return cols[i]; return cols[cols.length - 1]; };
}
// cheap deterministic hash of integers → [0,1)
function ih(a, b = 0, c = 0) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// smooth value noise in 2D (for empty-seat clusters)
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = ih(xi, yi), b = ih(xi + 1, yi), c = ih(xi, yi + 1), d = ih(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------------------------------------------------------------------------
// Procedural fallback atlas: same layout + key colours as the painted one.
// ---------------------------------------------------------------------------
function paintFallbackAtlas(meta) {
  const W = 1024, H = 1024;
  let c = null;
  try {
    if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = W; c.height = H; }
    else if (typeof OffscreenCanvas === 'function') c = new OffscreenCanvas(W, H);
  } catch (e) { c = null; }
  if (!c) return null;
  const g = c.getContext('2d');
  const cw = W / meta.cols, ch = H / meta.rows;
  const hair = ['#1b1511', '#2e2119', '#4b3322', '#6b4a2d', '#b88a4e', '#d9c08a', '#8e4a26', '#9a9a96', '#d8d6cf'];
  const MAG = '#ff00ff', CY = '#00ffff';
  for (let id = 0; id < meta.ids; id++) {
    const sk = meta.skin[id] || [0.8, 0.6, 0.5];
    const skin = `rgb(${sk.map(v => Math.round(v * 255)).join(',')})`;
    const skinD = `rgb(${sk.map(v => Math.round(v * 200)).join(',')})`;
    const hr = hair[Math.floor(ih(id, 3) * hair.length)];
    const style = Math.floor(ih(id, 5) * 5);             // 0 short, 1 long, 2 bald, 3 cap, 4 ponytail
    const cap = style === 3 || (meta.caps && meta.caps[id] && style !== 1);
    const kid = (meta.height[id] || 0.57) < 0.5 ? 0.8 : 1;
    const bw = (0.95 + 0.25 * ih(id, 7)) * kid;           // build
    for (let p = 0; p < meta.poses; p++) {
      const idx = id * meta.poses + p, col = idx % meta.cols, row = Math.floor(idx / meta.cols);
      const ox = col * cw + cw / 2, by = (row + 1) * ch - meta.waistV * ch;
      const U = ch;                                        // 1 unit = cell height
      const X = u => ox + u * U, Y = v => by - v * U * kid;
      g.save();
      g.beginPath(); g.rect(col * cw + 1, row * ch + 1, cw - 2, ch - 2); g.clip();
      const sh = 0.37 * kid, shW = 0.17 * bw, wsW = 0.14 * bw;
      // arms (behind torso for up poses)
      const arm = (sx, ex, ey, hx, hy) => {
        g.strokeStyle = MAG; g.lineCap = 'round'; g.lineWidth = 0.075 * U * bw;
        g.beginPath(); g.moveTo(X(sx), Y(sh - 0.03)); g.lineTo(X(ex), Y(ey)); g.stroke();
        g.strokeStyle = skin; g.lineWidth = 0.06 * U * bw;
        g.beginPath(); g.moveTo(X(ex), Y(ey)); g.lineTo(X(hx), Y(hy)); g.stroke();
        g.fillStyle = skin; g.beginPath(); g.arc(X(hx), Y(hy), 0.035 * U, 0, 7); g.fill();
      };
      const A = [
        [[-shW, -shW - 0.03, 0.17, -wsW - 0.02, 0.05], [shW, shW + 0.03, 0.17, wsW + 0.02, 0.05]],
        [[-shW, -shW - 0.02, 0.14, -0.06, 0.25], [shW, shW + 0.02, 0.14, 0.06, 0.25]],
        [[-shW, -shW + 0.0, 0.14, -0.012, 0.25], [shW, shW - 0.0, 0.14, 0.012, 0.25]],
        [[-shW, -shW - 0.08, sh + 0.2, -shW - 0.11, sh + 0.36], [shW, shW + 0.08, sh + 0.2, shW + 0.11, sh + 0.36]],
        [[-shW, -shW - 0.1, sh + 0.12, -0.05, sh + 0.25], [shW, shW + 0.1, sh + 0.12, 0.05, sh + 0.25]],
      ][p];
      if (p >= 3) for (const a of A) arm(...a);
      // torso
      const grd = g.createLinearGradient(X(-shW), 0, X(shW), 0);
      grd.addColorStop(0, '#c000c0'); grd.addColorStop(0.35, MAG); grd.addColorStop(0.7, MAG); grd.addColorStop(1, '#a800a8');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(X(-wsW), Y(0)); g.lineTo(X(-shW - 0.01), Y(sh - 0.06));
      g.quadraticCurveTo(X(-shW), Y(sh), X(-0.05), Y(sh + 0.01));
      g.lineTo(X(0.05), Y(sh + 0.01)); g.quadraticCurveTo(X(shW), Y(sh), X(shW + 0.01), Y(sh - 0.06));
      g.lineTo(X(wsW), Y(0)); g.closePath(); g.fill();
      // neck + head
      g.fillStyle = skinD; g.fillRect(X(-0.03), Y(sh + 0.06), 0.06 * U, 0.07 * U * kid);
      const hy = sh + 0.13;
      if (style === 1) { g.fillStyle = hr; g.beginPath(); g.ellipse(X(0), Y(hy - 0.025), 0.072 * U, 0.105 * U * kid, 0, 0, 7); g.fill(); }
      g.fillStyle = skin; g.beginPath(); g.ellipse(X(0), Y(hy), 0.062 * U, 0.082 * U * kid, 0, 0, 7); g.fill();
      if (cap) {
        g.fillStyle = CY; g.beginPath(); g.ellipse(X(0), Y(hy + 0.035), 0.068 * U, 0.055 * U * kid, 0, Math.PI, 0); g.fill();
        g.fillRect(X(-0.07), Y(hy + 0.04), 0.14 * U, 0.02 * U);
      } else if (style !== 2) {
        g.fillStyle = hr; g.beginPath(); g.ellipse(X(0), Y(hy + 0.03), 0.066 * U, 0.06 * U * kid, 0, Math.PI, 0); g.fill();
        if (style === 4) { g.beginPath(); g.ellipse(X(0.06), Y(hy - 0.02), 0.02 * U, 0.07 * U, 0.3, 0, 7); g.fill(); }
      }
      // eyes / mouth hint
      g.fillStyle = 'rgba(20,10,5,0.75)';
      g.fillRect(X(-0.03), Y(hy + 0.005), 0.012 * U, 0.01 * U); g.fillRect(X(0.018), Y(hy + 0.005), 0.012 * U, 0.01 * U);
      if (p === 3 || p === 4) { g.beginPath(); g.ellipse(X(0), Y(hy - 0.045), 0.014 * U, 0.012 * U, 0, 0, 7); g.fill(); }
      if (p < 3) for (const a of A) arm(...a);
      if (p === 4) for (const a of A) { g.fillStyle = skin; g.beginPath(); g.arc(X(a[3]), Y(a[4]), 0.035 * U, 0, 7); g.fill(); }
      g.restore();
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Shared between every crowd instance (a park may build several: bowl, rooftops, ballhawk clusters):
//  * ONE GPU copy of the atlas per image + tier (ref-counted),
//  * ONE wave geometry per park, so separate crowds ripple in sync.
// ---------------------------------------------------------------------------
const ATLAS_CACHE = new Map();       // key → { tex, refs, kind, owned, key }
const IMG_IDS = new WeakMap(); let imgSeq = 0;
function acquireAtlas(THREE, assets, tier) {
  let img = null;
  try { img = assets && assets.get ? assets.get('crowd_atlas') : null; } catch (e) { img = null; }
  let key = 'proc';
  if (img) { let id = IMG_IDS.get(img); if (!id) { id = ++imgSeq; IMG_IDS.set(img, id); } key = `ai${id}|${tier === 'low' ? 'lo' : 'hi'}`; }
  let e = ATLAS_CACHE.get(key);
  if (!e && img) {
    let tex = null, owned = true;
    try {
      if (tier === 'low' && typeof document !== 'undefined') {
        const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;     // 1024² on low: ¼ the memory
        c.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
        tex = new THREE.CanvasTexture(c);
      } else if (assets.texture) { tex = assets.texture(THREE, 'crowd_atlas', { wrap: 'clamp', srgb: true }); owned = false; }
      if (!tex) { tex = new THREE.Texture(img); owned = true; }
    } catch (err) { tex = null; }
    if (tex) e = { tex, refs: 0, kind: 'ai', owned, key };
  }
  if (!e) {
    key = 'proc'; e = ATLAS_CACHE.get(key);
    if (!e) { const c = paintFallbackAtlas(ATLAS_META); if (!c) return null; e = { tex: new THREE.CanvasTexture(c), refs: 0, kind: 'procedural', owned: true, key }; }
  }
  const t = e.tex;
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  if (!ATLAS_CACHE.has(e.key)) {
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 1; t.needsUpdate = true;
    ATLAS_CACHE.set(e.key, e);
  }
  e.refs++;
  return e;
}
function releaseAtlas(e) {
  if (!e) return;
  if (--e.refs <= 0) { ATLAS_CACHE.delete(e.key); if (e.owned) { try { e.tex.dispose(); } catch (err) { /* ignore */ } } }
}
const RINGS = new Map();             // parkId → { NB, members:Set, w, pos, loop }
function ringFor(pid) {
  let r = RINGS.get(pid);
  if (!r) { r = { NB: 180, members: new Set(), w: null, pos: null, loop: 1600 }; RINGS.set(pid, r); }
  return r;
}
function recomputeRing(r) {
  const NB = r.NB, radB = Array.from({ length: NB }, () => []), pos = Array.from({ length: NB }, () => [0, 0, 0, 0]);
  for (const m of r.members) {
    const S = m.samples; if (!S) continue;
    for (let i = 0; i < NB; i++) { const a = S.rad[i]; for (let k = 0; k < a.length; k++) radB[i].push(a[k]); const p = S.pos[i]; pos[i][0] += p[0]; pos[i][1] += p[1]; pos[i][2] += p[2]; pos[i][3] += p[3]; }
  }
  const rb = radB.map(a => { if (!a.length) return NaN; a.sort((x, y) => x - y); return a[a.length >> 1]; });
  const known = []; rb.forEach((v, i) => { if (isFinite(v)) known.push([i, v]); });
  for (let i = 0; i < NB; i++) if (!isFinite(rb[i])) {
    if (!known.length) { rb[i] = 250; continue; }
    let best = 250, bd = 1e9; for (const [j, v] of known) { const d = Math.min(Math.abs(i - j), NB - Math.abs(i - j)); if (d < bd) { bd = d; best = v; } }
    rb[i] = best;
  }
  const w = new Float64Array(NB + 1);
  for (let i = 0; i < NB; i++) w[i + 1] = w[i] + clamp(rb[i], 40, 700) * (360 / NB) * D2R;
  r.w = w; r.loop = w[NB]; r.pos = pos;
  for (const m of r.members) { try { m.rewave(); } catch (e) { /* ignore */ } }
}

export function createCrowd(THREE, { parkId = 'wrigley', quality = 'high', look = {}, assets = null } = {}) {
  const pid = parkId === 'rate' ? 'rate' : 'wrigley';
  const fans = [];           // [x,y,z, fx,fz, kind, section, seed, standing]
  const STRIDE = 9;
  const density = quality === 'low' ? 0.8 : quality === 'medium' ? 0.92 : 1;
  let tier = quality;
  let rnd = 1234567;
  const R = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };

  // ---- state (CPU side: a handful of scalars) ----
  let U = null, mesh = null, geo = null, mat = null, atlasE = null, atlasKind = 'none';
  let meta = ATLAS_META;
  let now = 0, excite = 0.3, exciteT = 0.3, riseT = -1e9, hotT = -1e9;
  const hot = { t: 1e6, amt: 0, spray: 0, land: null, radius: 16 };
  const cel = { t: 1e6, amt: 0 };
  const gro = { t: 1e6, amt: 0 };
  const scr = { t: 1e6, amt: 0, p: [0, 0, 0] };
  const W = { active: false, t: 0, from: 0, speed: 40, total: 0, dur: 0, dir: 1 };
  // wave coordinate: every fan maps to a 'section angle' th (deg, spray convention, -180..180) = where its
  // facing line meets a 200-ft circle round home, so a whole section column (all rows) rises together; the
  // bowl's arc length w(th) is integrated from the median fan radius per 2-degree bin → constant seat speed.
  const ring = ringFor(pid);
  const member = { samples: null, rewave: () => rewave() };
  let thA = null;
  let camInfoCache = new WeakMap();

  const api = {
    count: 0,
    addFan(x, y, z, o = {}) {
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      const kind = o.kind === 1 ? 1 : o.kind === 2 ? 2 : 0;
      // empty seats: sold-out crowds still have scattered empties + small empty clusters
      let keep = density * (o.fill ?? 1);
      if (kind !== 2) {
        const n = vnoise(x / 23 + 17.3, z / 23 - 4.1 + y / 31);
        if (n > 0.78) keep *= 1 - clamp((n - 0.78) / 0.12, 0, 1) * 0.75;
      }
      if (R() > keep) return;
      let fx, fz;
      if (o.facing) { [fx, fz] = o.facing; const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L; }
      else { const L = Math.hypot(x, z) || 1; fx = -x / L; fz = -z / L; }
      fans.push(x, y, z, fx, fz, kind, +o.section || 0, R(), o.standing ? 1 : 0);
      api.count = fans.length / STRIDE;
    },
    addRow(p0, p1, o = {}) {
      if (!p0 || !p1) return;
      const sp = Math.max(0.8, o.spacing || 1.9);
      const L = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
      const n = Math.max(1, Math.floor(L / sp));
      const fill = o.fill ?? 0.95;
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5 + (R() - 0.5) * 0.12) / n;
        api.addFan(p0[0] + (p1[0] - p0[0]) * f + (R() - 0.5) * 0.1, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f + (R() - 0.5) * 0.1,
          { ...o, fill });
      }
    },
    build() { return build(); },
    update(dt, t) {
      dt = isFinite(dt) ? clamp(dt, 0, 1) : 0;
      now += dt;
      if (!U) return;
      excite += (exciteT - excite) * (1 - Math.exp(-dt * 2.2));
      U.uTime.value = now % 7200;
      U.uExcite.value = excite;
      const hT = now - hot.t, cT = now - cel.t, gT = now - gro.t, sT = now - scr.t;
      U.uHot.value.set(hot.spray, hT < 16 ? hot.amt : 0, hT, hot.radius);
      U.uCel.value.set(cT < 16 ? cel.amt : 0, cT);
      U.uGroan.value.set(gT < 6 ? gro.amt : 0, gT);
      const sAmt = sT < 9 ? scr.amt : scr.amt * Math.max(0, 1 - (sT - 9) / 10);
      U.uScr.value.set(scr.p[0], scr.p[2], sT, sT < 19 ? sAmt : 0);
      U.uScrY.value = scr.p[1];
      // THE WAVE
      if (W.active) {
        W.t += dt;
        const D = waveD(W.t);
        const tot = W.total;
        // crescendo: ~3/4 of the bowl joins at first, nearly everyone by a quarter lap; ragged + dying at the end
        const p = (0.74 + 0.23 * smooth01(D / (tot * 0.25 + 1))) * (1 - 0.6 * smooth01((D - tot * 0.85) / (tot * 0.15 + 1)));
        U.uWave.value.set(D, W.from, W.speed, tot);
        U.uWave2.value.set(ring.loop, W.dir, p, 1);
        if (W.t > W.dur) { W.active = false; U.uWave2.value.w = 0; }
      }
    },
    setExcite(v) {
      const nv = clamp(+v || 0, 0, 1);
      // auto-groan: excitement rose (ball in play) and fell again with no homer in between → an out / foul
      if (nv >= 0.5 && exciteT < 0.5) riseT = now;
      if (nv < 0.42 && exciteT >= 0.5 && riseT > hotT) { riseT = -1e9; api.groan(clamp((exciteT - 0.3) * 2.2, 0.35, 1)); }
      exciteT = nv;
    },
    flash(spray = 0, o = {}) {
      hotT = now;
      hot.t = now; hot.amt = o.big ? 1 : 0.9; hot.spray = +spray || 0; hot.radius = o.big ? 22 : 16;
      hot.land = Array.isArray(o.landing) && o.landing.length >= 3 && o.landing.every(isFinite) ? o.landing.slice(0, 3) : null;
      if (U) {
        if (hot.land) U.uHotP.value.set(hot.land[0], hot.land[2], 1); else U.uHotP.value.set(0, 0, 0);
      }
      if (exciteT < 0.7) exciteT = 0.7;
    },
    wave({ fromSpray = -35, laps = 1.5, speed = 40, dir = 1 } = {}) {
      if (!U) return 0;
      speed = clamp(+speed || 40, 8, 400);
      laps = clamp(+laps || 1, 0.25, 6);
      W.active = true; W.t = 0; W.speed = speed; W.dir = dir < 0 ? -1 : 1;
      W.from = wFromSpray(+fromSpray || 0);
      W.total = laps * ring.loop;
      // D(t) = speed*(t - 0.5 - 0.6*(1-exp(-t/0.8)))  → ends when the last fans sit (D = total + 1.6 s of travel)
      W.dur = W.total / speed + 1.6 + 0.5 + 0.6 + 1.0;   // + stragglers
      U.uWave.value.set(waveD(0), W.from, speed, W.total);
      U.uWave2.value.set(ring.loop, W.dir, 0.55, 1);
      return W.dur;
    },
    celebrate({ spray = 0, big = true } = {}) {
      hotT = now;
      cel.t = now; cel.amt = big ? 1 : 0.6;
      api.flash(spray, { big });
      exciteT = Math.max(exciteT, big ? 0.9 : 0.75);
    },
    // ---- optional additions ----
    groan(amount = 1) { gro.t = now; gro.amt = clamp(+amount || 0, 0, 1); },
    scramble(p, o = {}) {
      if (!Array.isArray(p) || p.length < 3 || !p.every(isFinite)) return;
      scr.t = now; scr.amt = 1; scr.p = p.slice(0, 3);
      if (U) U.uScrR.value = clamp(+o.radius || 170, 20, 400);
    },
    waveFront() {
      if (!W.active || !ring.w) return { active: false, spray: 0, pos: null, t: 0, dur: 0, progress: 1 };
      const D = waveD(W.t);
      const wf = ((W.from + W.dir * D) % ring.loop + ring.loop) % ring.loop;
      const th = thOfW(wf), b = posAt(th);
      return { active: true, spray: th, pos: b, t: W.t, dur: W.dur, progress: clamp(D / (W.total || 1), 0, 1) };
    },
    setLook(l = {}) { look = { ...look, ...l }; applyLook(); },
    setQuality(q) { if (q === tier || !['high', 'medium', 'low'].includes(q)) return; tier = q; if (atlasKind === 'ai') useAtlas(); },
    stats() { return { count: api.count, drawCalls: mesh ? 1 : 0, triangles: api.count * 2, atlas: atlasKind, cells: meta.ids * meta.poses }; },
    dispose() {
      try { if (geo) geo.dispose(); if (mat) mat.dispose(); } catch (e) { /* ignore */ }
      releaseAtlas(atlasE); atlasE = null;
      if (ring.members.delete(member) && ring.members.size) recomputeRing(ring);
      geo = mat = null; U = null;
    },
  };

  function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function waveD(t) { return W.speed * (t - 0.5 - 0.6 * (1 - Math.exp(-t / 0.8))); }
  function rewave() {
    if (!geo || !thA) return;
    const at = geo.getAttribute('iB'); if (!at) return;
    const arr = at.array, n = Math.min(thA.length, arr.length / 4);
    for (let i = 0; i < n; i++) arr[i * 4 + 3] = wOfTh(thA[i]);
    at.needsUpdate = true;
  }
  function sectionTh(x, z, fx, fz) {
    const R0 = 200, pf = x * fx + z * fz, pp = x * x + z * z;
    const disc = pf * pf - pp + R0 * R0;
    let sv = -pf;
    if (disc >= 0) { const q = Math.sqrt(disc), a = -pf + q, b = -pf - q; sv = Math.abs(a) < Math.abs(b) ? a : b; }
    return Math.atan2(x + fx * sv, -(z + fz * sv)) / D2R;
  }
  function wOfTh(th) {            // arc length (ft) from th = -180
    if (!ring.w) return (th + 180) * D2R * 250;
    const f = clamp((th + 180) / 360 * ring.NB, 0, ring.NB - 1e-6), i = Math.floor(f);
    return ring.w[i] + (ring.w[i + 1] - ring.w[i]) * (f - i);
  }
  function thOfW(w) {
    if (!ring.w) return w / (250 * D2R) - 180;
    let lo = 0, hi = ring.NB;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ring.w[m] <= w) lo = m; else hi = m; }
    const f = (w - ring.w[lo]) / Math.max(1e-6, ring.w[lo + 1] - ring.w[lo]);
    return -180 + (lo + clamp(f, 0, 1)) * 360 / ring.NB;
  }
  function posAt(th) {
    const nb = ring.NB; let i = Math.floor((th + 180) / 360 * nb); i = ((i % nb) + nb) % nb;
    for (let k = 0; k < nb; k++) { for (const j of [i + k, i - k]) { const b = ring.pos && ring.pos[((j % nb) + nb) % nb]; if (b && b[3] > 0) return [b[0] / b[3], b[1] / b[3], b[2] / b[3]]; } }
    return [Math.sin(th * D2R) * 380, 25, -Math.cos(th * D2R) * 380];
  }
  function wFromSpray(s) { s = ((s + 180) % 360 + 360) % 360 - 180; return wOfTh(s); }

  // ---------------------------------------------------------------------------
  function readMeta() {
    try {
      const m = assets && assets.meta && assets.meta('crowd_atlas');
      if (m && m.cells && m.cells.cols && m.cells.ids) return { ...ATLAS_META, ...m.cells };
    } catch (e) { /* ignore */ }
    return ATLAS_META;
  }
  function useAtlas() {
    if (!U) return;
    const e = acquireAtlas(THREE, assets, tier);
    if (!e) return;
    releaseAtlas(atlasE); atlasE = e; atlasKind = e.kind;
    meta = e.kind === 'ai' ? readMeta() : ATLAS_META;
    const tex = e.tex;
    U.uAtlas.value = tex;
    const im = tex.image || {};
    const iw = im.width || im.naturalWidth || 1024, ihh = im.height || im.naturalHeight || 1024;
    U.uAtlasPx.value.set(iw, ihh);
    U.uGrid.value.set(meta.cols, meta.rows);
    U.uPoses.value = meta.poses; U.uWaistV.value = meta.waistV;
    U.uCellAspect.value = (iw / meta.cols) / (ihh / meta.rows);
  }

  function applyLook() {
    if (!U) return;
    const night = clamp(+look.night || 0, 0, 1);
    const lit = look.crowd ?? 1, shd = look.crowdShade ?? 0.6;
    // default grade: warm-white day → golden dusk (night≈0.4) → cool LED night; look.tint overrides
    const dayTint = [1.0, 0.985, 0.955], duskTint = [1.07, 0.93, 0.8], nightTint = [0.94, 0.97, 1.06];
    const tk = night < 0.4 ? night / 0.4 : (night - 0.4) / 0.6, ta = night < 0.4 ? dayTint : duskTint, tb = night < 0.4 ? duskTint : nightTint;
    const tint = toRGB(look.tint, ta.map((v, i) => v + (tb[i] - v) * tk));
    const sTint = toRGB(look.shadeTint, [0.86, 0.92, 1.06]);
    U.uLit.value.set(tint[0] * lit, tint[1] * lit, tint[2] * lit);
    U.uShd.value.set(sTint[0] * shd, sTint[1] * shd, sTint[2] * shd);
    U.uNight.value = night;
    if (Array.isArray(look.sun) && look.sun.every(isFinite)) {
      const L = Math.hypot(look.sun[0], look.sun[2]) || 1;
      U.uSun.value.set(look.sun[0] / L, look.sun[2] / L, 1);
    } else U.uSun.value.set(0, 1, 0);
  }

  // ---------------------------------------------------------------------------
  function build() {
    const n = fans.length / STRIDE; api.count = n;
    if (mesh && mesh.userData.builtN === n) return mesh;
    meta = (assets && assets.get && assets.get('crowd_atlas')) ? readMeta() : ATLAS_META;
    // wave geometry (shared per park, see ring): section angle per fan + radius samples per 2° bin
    const NB = ring.NB, radB = Array.from({ length: NB }, () => []), posB = Array.from({ length: NB }, () => [0, 0, 0, 0]);
    thA = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE, x = fans[o], z = fans[o + 2], r = Math.hypot(x, z), th = sectionTh(x, z, fans[o + 3], fans[o + 4]); thA[i] = th;
      if (r < 40) continue;                        // local-space clusters (e.g. ballhawks in a moved group) don't shape the bowl
      const bi = clamp(Math.floor((th + 180) / 360 * NB), 0, NB - 1);
      if (radB[bi].length < 64 && ((i & 3) === 0 || radB[bi].length < 8)) radB[bi].push(r);
      const b = posB[bi]; b[0] += x; b[1] += fans[o + 1]; b[2] += z; b[3]++;
    }
    member.samples = { rad: radB, pos: posB };
    ring.members.add(member);

    const pickShirt = picker(SHIRTS[pid]), pickCap = picker(CAPS[pid]), pickPants = picker(PANTS);
    const blufoxShirt = picker([['#101c3d', 3], ['#2f80ff', 1.2], ['#1b2b57', 1]]);
    const iA = new Float32Array(n * 4), iB = new Float32Array(n * 4), iD = new Float32Array(n * 4), iE = new Float32Array(n * 2);
    const iS = new Uint8Array(n * 4), iC = new Uint8Array(n * 4), iP = new Uint8Array(n * 4), iK = new Uint8Array(n * 4);
    const ids = meta.ids;
    const put8 = (arr, i, rgb, a) => { arr[i * 4] = Math.round(rgb[0] * 255); arr[i * 4 + 1] = Math.round(rgb[1] * 255); arr[i * 4 + 2] = Math.round(rgb[2] * 255); arr[i * 4 + 3] = Math.round(clamp(a, 0, 1) * 255); };
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    const night = +look.night || 0;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const x = fans[o], y = fans[o + 1], z = fans[o + 2], kind = fans[o + 5], seed = fans[o + 7];
      const si = Math.floor(seed * 1e7);
      const spray = Math.atan2(x, -z) / D2R, dist = Math.hypot(x, z);
      iA.set([x, y, z, seed], i * 4);
      iB.set([fans[o + 3], fans[o + 4], kind + (fans[o + 8] ? 0.25 : 0), 0], i * 4);
      iE[i * 2] = spray; iE[i * 2 + 1] = dist;
      // identity (+ mirror). Kids (short cells) are rarer.
      let id = Math.floor(ih(si, 11) * ids);
      if ((meta.height[id] || 0.57) < 0.5 && ih(si, 12) < 0.6) id = Math.floor(ih(si, 13) * ids);
      const mirror = ih(si, 14) < 0.5 ? 1 : 0;
      const groanOK = meta.groan ? (meta.groan[id] ? 2 : 0) : 2;
      const shorts = ih(si, 15) < (night > 0.5 ? 0.14 : 0.34) ? 4 : 0;
      const phone = ih(si, 16) < 0.2 ? 8 : 0;
      const refuse = ih(si, 17) < 0.07 ? 16 : 0;
      const street = kind === 2 && y < 8 ? 32 : 0;
      const hsc = 0.93 + 0.14 * ih(si, 18);
      iD.set([id, mirror + groanOK + shorts + phone + refuse + street, hsc, meta.waist[id] || 0.3], i * 4);
      // shirts: park palette + group correlation (friends sit together) + a Blufox outing in LCF
      const gx = Math.floor(x / 9), gy = Math.floor(y / 3.2), gz = Math.floor(z / 9);
      let shirt;
      const blufox = kind !== 2 && dist > 300 && Math.abs(spray + 12) < 2.6 && y > 14;
      if (blufox && ih(si, 19) < 0.72) shirt = blufoxShirt(ih(si, 20));
      else if (ih(si, 21) < 0.3) shirt = pickShirt(ih(gx, gy, gz));
      else shirt = pickShirt(ih(si, 22));
      const cap = blufox && ih(si, 23) < 0.7 ? hexRGB('#101c3d') : pickCap(ih(si, 24));
      const pants = pickPants(ih(si, 25));
      const sk = meta.skin[id] || [0.8, 0.6, 0.5];
      put8(iS, i, shirt, 0.25 + 0.75 * ih(si, 26));        // a: clap propensity
      put8(iC, i, cap, ih(si, 27));                          // a: wave lateness
      put8(iP, i, pants, ih(si, 28));                        // a: brightness jitter
      put8(iK, i, sk, ih(si, 29));                           // a: stand-up threshold
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }

    if (geo) geo.dispose();
    geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
    geo.setAttribute('iD', new THREE.InstancedBufferAttribute(iD, 4));
    geo.setAttribute('iE', new THREE.InstancedBufferAttribute(iE, 2));
    geo.setAttribute('iS', new THREE.InstancedBufferAttribute(iS, 4, true));
    geo.setAttribute('iC', new THREE.InstancedBufferAttribute(iC, 4, true));
    geo.setAttribute('iP', new THREE.InstancedBufferAttribute(iP, 4, true));
    geo.setAttribute('iK', new THREE.InstancedBufferAttribute(iK, 4, true));
    geo.instanceCount = n;
    recomputeRing(ring);                           // also re-maps every other crowd of this park (rewave)
    if (n > 0) {
      const c = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      const r = Math.hypot(maxX - minX, maxY - minY + 12, maxZ - minZ) / 2 + 200; // + scramble/stand reach
      geo.boundingSphere = new THREE.Sphere(c, r);
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(minX - 200, minY - 5, minZ - 200), new THREE.Vector3(maxX + 200, maxY + 12, maxZ + 200));
    } else { geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1); }

    if (!mat) {
      U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uAtlas: { value: null }, uAtlasPx: { value: new THREE.Vector2(1024, 1024) }, uGrid: { value: new THREE.Vector2(16, 10) },
        uPoses: { value: 5 }, uWaistV: { value: 0.035 }, uCellFt: { value: CELL_FT }, uCellAspect: { value: 0.625 },
        uTime: { value: 0 }, uExcite: { value: 0.3 },
        uHot: { value: new THREE.Vector4(0, 0, 1e6, 16) }, uHotP: { value: new THREE.Vector3(0, 0, 0) },
        uCel: { value: new THREE.Vector2(0, 1e6) }, uGroan: { value: new THREE.Vector2(0, 1e6) },
        uWave: { value: new THREE.Vector4(-1e6, 0, 40, 0) }, uWave2: { value: new THREE.Vector4(1600, 1, 0.5, 0) },
        uScr: { value: new THREE.Vector4(0, 0, 1e6, 0) }, uScrY: { value: 0 }, uScrR: { value: 170 },
        uLit: { value: new THREE.Vector3(1, 1, 1) }, uShd: { value: new THREE.Vector3(0.6, 0.6, 0.6) }, uNight: { value: 0 },
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uHardCut: { value: 0 }, uViewH: { value: 844 },
      }]);
      mat = new THREE.ShaderMaterial({
        uniforms: U, vertexShader: VERT, fragmentShader: FRAG, fog: true, side: THREE.DoubleSide,
        transparent: false, depthWrite: true, alphaToCoverage: true,
      });
      mat.name = 'crowd';
    }
    applyLook();
    useAtlas();
    if (!mesh) {
      mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'crowd';
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData.noOcclude = true;            // camera occluder grid: never treat the fan cards as walls
      mesh.onBeforeRender = (renderer) => {
        if (!U) return;
        const rt = renderer.getRenderTarget();
        let msaa;
        if (rt) msaa = (rt.samples | 0) > 0;
        else {
          let c = camInfoCache.get(renderer);
          if (c === undefined) { try { c = !!renderer.getContext().getContextAttributes().antialias; } catch (e) { c = false; } camInfoCache.set(renderer, c); }
          msaa = c;
        }
        U.uHardCut.value = msaa ? 0 : 1;
        const h = rt ? rt.height : (renderer.domElement ? renderer.domElement.height : 844);
        U.uViewH.value = h || 844;
      };
    } else mesh.geometry = geo;
    mesh.frustumCulled = true;
    mesh.userData.builtN = n;
    // late-arriving art
    if (atlasKind !== 'ai' && assets && typeof assets.ready === 'function') {
      try { assets.ready('crowd_atlas').then(img => { if (img && U && atlasKind !== 'ai') useAtlas(); }).catch(() => {}); } catch (e) { /* ignore */ }
    }
    return mesh;
  }
  return api;
}

// ============================================================================
// Shaders
// ============================================================================
const VERT = /* glsl */`
attribute vec4 iA;   // x y z seed
attribute vec4 iB;   // fx fz kind(+0.25 standing) waveW
attribute vec4 iD;   // identity flags heightScale waistHalfW
attribute vec2 iE;   // spray dist
attribute vec4 iS;   // shirt rgb, clap propensity
attribute vec4 iC;   // cap rgb, wave lateness
attribute vec4 iP;   // pants rgb, brightness jitter
attribute vec4 iK;   // skin rgb, stand threshold
uniform vec2 uGrid; uniform float uPoses, uWaistV, uCellFt, uCellAspect;
uniform float uTime, uExcite;
uniform vec4 uHot; uniform vec3 uHotP;
uniform vec2 uCel, uGroan;
uniform vec4 uWave, uWave2;
uniform vec4 uScr; uniform float uScrY, uScrR;
uniform vec3 uLit, uShd, uSun; uniform float uNight, uViewH;
varying vec2 vUv; varying vec2 vOrg;
varying vec3 vShirt; varying vec3 vCap; varying vec3 vPants; varying vec3 vSkin; varying vec3 vLit;
varying vec4 vLeg; varying vec3 vGlow; varying float vBack;
#include <common>
#include <fog_pars_vertex>
float hh(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hs(float s, float k){ return hh(s * 1.618 + k * 17.371 + 0.5); }
float bit(float f, float b){ return mod(floor(f / b), 2.0); }
vec3 lin(vec3 c){ return c * c * (0.35 + 0.65 * c); }   // ≈ sRGB→linear, no pow()
float wprof(float tau){ return smoothstep(-0.24, 0.28, tau) * (1.0 - smoothstep(0.8, 1.3, tau)); }
void main(){
  float seed = iA.w;
  float sd = floor(seed * 100000.0);
  float kind = floor(iB.z + 0.01);
  bool alwaysUp = kind > 1.5 || fract(iB.z) > 0.1;
  float ident = iD.x, flags = iD.y, hsc = iD.z;
  bool mirror = bit(flags, 1.0) > 0.5, groanOK = bit(flags, 2.0) > 0.5, shorts = bit(flags, 4.0) > 0.5;
  bool phone = bit(flags, 8.0) > 0.5, refuse = bit(flags, 16.0) > 0.5, street = bit(flags, 32.0) > 0.5;
  float T = uTime, ex = uExcite;
  vec3 P = iA.xyz;
  vec3 wP = (modelMatrix * vec4(P, 1.0)).xyz;
  float dist = length(cameraPosition - wP);
  // cull the whole fan early when it is off screen (half the bowl is behind the batting camera)
  vec4 cc = projectionMatrix * (viewMatrix * vec4(wP + vec3(0.0, 3.0, 0.0), 1.0));
  float mx = 7.0 * abs(projectionMatrix[0][0]), my = 7.0 * abs(projectionMatrix[1][1]);   // ~7 ft of slack (card, hops)
  if (cc.w < -7.0 || abs(cc.x) > cc.w * 1.02 + mx || abs(cc.y) > cc.w * 1.02 + my) {
    if (uScr.w < 0.001) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  }
  float pxH = uCellFt * hsc * projectionMatrix[1][1] * 0.5 * uViewH / max(dist, 1.0);   // cell height in px
  float farK = smoothstep(9.0, 4.0, pxH);          // 1 = tiny on screen

  // -------- idle: slots of 5-14 s; stretch/stand, clap, talk, fidget --------
  float per = 5.0 + 9.0 * hs(sd, 1.0);
  float tt = T + hs(sd, 2.0) * per;
  float slot = floor(tt / per), tin = tt - slot * per;
  float r1 = hs(sd + slot * 7.13, 3.0), r2 = hs(sd + slot * 7.13, 4.0), r3 = hs(sd + slot * 7.13, 5.0);
  float stand = 0.0, pose = 0.0, hop = 0.0, slump = 0.0, glow = 0.0, waveLift = 0.0;
  float sway = 0.026 * sin(T * (0.5 + 0.5 * hs(sd, 30.0)) + sd);
  if (r1 < 0.012 + 0.07 * ex * ex) {
    float a = per * 0.12, b = a + 1.2 + per * 0.4 * r2;
    stand = smoothstep(a, a + 0.55, tin) * (1.0 - smoothstep(b, b + 0.55, tin));
  }
  float clapHz = 1.9 + 1.5 * hs(sd, 6.0);
  float cph = fract(T * clapHz * mix(1.0, 0.45, farK) + hs(sd, 7.0));
  float clapPose = cph < 0.4 ? 2.0 : 1.0;
  float pClap = clamp(iS.a * (0.06 + 0.95 * ex * ex), 0.0, 0.95);
  if (r2 < pClap && tin < per * (0.3 + 0.65 * r3)) pose = clapPose;
  // excitement → people rise ("ooooh" on a deep fly); low thresholds rise first
  float thr = iK.a;
  // (during THE WAVE most of the bowl stays seated between passes so the band reads)
  stand = max(stand, smoothstep(0.42 + thr * 0.5, 0.5 + thr * 0.5, ex) * (1.0 - 0.8 * uWave2.w));

  // -------- homer hot zone --------
  if (uHot.y > 0.001) {
    float Th = uHot.z, prox;
    if (uHotP.z > 0.5) { float d = distance(P.xz, uHotP.xy); prox = exp(-d * d / 13000.0); }
    else { float dsp = iE.x - uHot.x; prox = exp(-dsp * dsp / (uHot.w * uHot.w)) * (iE.y > 250.0 ? 1.0 : 0.5); }
    if (hs(sd, 9.0) < (0.4 + 0.6 * prox) * uHot.y) {
      float dl = 0.06 + 0.55 * hs(sd, 10.0) * (1.0 - 0.6 * prox);
      float Dd = 2.8 + 3.5 * hs(sd, 11.0) + 4.5 * prox;
      float up = smoothstep(dl, dl + 0.35, Th) * (1.0 - smoothstep(Dd, Dd + 0.8, Th));
      stand = max(stand, up);
      float armsT = dl + 0.7 + (1.2 + 2.4 * prox) * hs(sd, 12.0);
      if (up > 0.5) { pose = (Th < armsT || fract(Th * 0.37 + hs(sd, 31.0)) < 0.12) ? 3.0 : clapPose; }
      hop += up * step(Th, armsT) * (0.12 + 0.36 * prox) * abs(sin((Th - dl) * (6.0 + 3.0 * hs(sd, 13.0))));
      glow = max(glow, up * step(0.55, hs(sd, 32.0)) * step(fract(Th * 0.9 + hs(sd, 33.0)), 0.5));
    }
  }
  // -------- everyone up --------
  if (uCel.x > 0.001) {
    float Tc = uCel.y;
    if (hs(sd, 14.0) < uCel.x * 0.97) {
      float dl = 0.1 + 0.7 * hs(sd, 15.0);
      float Dd = 5.5 + 6.5 * hs(sd, 16.0);
      float up = smoothstep(dl, dl + 0.4, Tc) * (1.0 - smoothstep(Dd, Dd + 0.9, Tc));
      stand = max(stand, up);
      float armsT = dl + 1.6 + 2.8 * hs(sd, 17.0);
      if (up > 0.5) pose = (Tc < armsT || fract(Tc * 0.31 + hs(sd, 18.0)) < 0.18) ? 3.0 : clapPose;
      hop += up * step(Tc, armsT + 0.8) * 0.3 * abs(sin((Tc - dl) * (5.5 + 3.5 * hs(sd, 19.0))));
      glow = max(glow, up * step(0.5, hs(sd, 34.0)));
    }
  }
  // -------- groan (an out) --------
  if (uGroan.x > 0.001) {
    float Tg = uGroan.y;
    float g = uGroan.x * (1.0 - smoothstep(1.8, 3.2 + 1.6 * hs(sd, 20.0), Tg));
    stand *= 1.0 - uGroan.x * smoothstep(0.15, 0.7 + 0.5 * hs(sd, 35.0), Tg) * (1.0 - smoothstep(3.0, 4.5, Tg));
    if (groanOK && hs(sd, 21.0) < 0.3 * g && Tg > 0.12 + 0.35 * hs(sd, 22.0)) pose = 4.0;
    else if (pose > 0.5 && pose < 2.5) pose = 0.0;       // stop clapping
    slump = g * 0.14;
  }
  // -------- THE WAVE --------
  if (uWave2.w > 0.5 && !(street && hs(sd, 36.0) > 0.3)) {
    float loop = uWave2.x, spd = uWave.z, D = uWave.x;
    float off = mod((iB.w - uWave.y) * uWave2.y, loop);
    float k = floor((D - off) / loop);
    float late = iC.a;
    float delay = late * late * late * 0.85 - 0.14 * step(0.95, late);     // most on time, a few late, a few early
    float tau = ((D - off - k * loop) / spd - delay) / (1.0 + 0.35 * farK);   // a touch wider far away
    float valid = step(0.0, k) * step(off + k * loop, uWave.w);
    float tauN = tau - loop / spd / (1.0 + 0.35 * farK);
    float validN = step(off + (k + 1.0) * loop, uWave.w);
    float joinP = uWave2.z;
    float kk = tau < 1.2 ? k : k + 1.0;
    bool joins = !refuse && hs(sd + kk * 13.0, 23.0) < joinP;
    float w = joins ? max(valid * wprof(tau), validN * wprof(tauN)) : 0.0;
    float amp = mix(0.7, 1.0, smoothstep(0.5, 0.9, joinP + 0.2 * hs(sd, 37.0)));
    // anticipation: the ones about to go lean in / half-rise
    float pre = validN * smoothstep(-1.4, -0.35, tauN) * (1.0 - smoothstep(-0.3, -0.1, tauN)) + valid * smoothstep(-1.4, -0.35, tau) * (1.0 - smoothstep(-0.3, -0.1, tau));
    stand = max(stand * (1.0 - w), max(w * amp, 0.12 * pre * float(joins)));
    if (w > 0.45 && hs(sd, 24.0) < 0.86) pose = 3.0;
    else if (pre > 0.5 && joins && pose < 0.5 && hs(sd, 38.0) < 0.5) pose = 1.0;
    // far away (a few px tall) the band is exaggerated a little so it reads like it does on TV
    hop += w * (0.38 + 1.3 * farK) * sin(3.14159 * clamp((tau - 0.05) / 0.8, 0.0, 1.0));
    waveLift = w;
    sway += w * 0.05 * (hs(sd, 39.0) - 0.5);
    glow = max(glow, w * step(0.62, hs(sd, 40.0)));
  }
  // -------- ballhawks scramble --------
  float run = 0.0;
  if (uScr.w > 0.001 && street && abs(P.y - uScrY) < 10.0) {
    vec2 to = uScr.xy - P.xz; float d = length(to);
    if (d < uScrR) {
      float react = 0.15 + 0.7 * hs(sd, 25.0);
      float v = 12.0 + 10.0 * hs(sd, 26.0);
      float stopR = 2.5 + 9.0 * hs(sd, 27.0) + d * 0.06;
      float reach = max(0.0, d - stopR);
      float s = clamp(v * (uScr.z - react), 0.0, reach);
      P.xz += to / max(d, 1e-3) * s * uScr.w;
      run = (uScr.z > react && s < reach - 0.3) ? 1.0 : 0.0;
      if (run > 0.5) { pose = fract(T * 2.6 + seed) < 0.5 ? 1.0 : 2.0; hop += 0.22 * abs(sin(T * 8.5 + sd)); }
      else if (uScr.z > react + 0.5 && uScr.z < 7.0) {
        pose = hs(sd, 28.0) < 0.2 ? 3.0 : (groanOK && hs(sd, 29.0) < 0.5 ? 4.0 : 0.0);
      }
      sway += run * 0.07 * sin(T * 8.5 + sd);
    }
  }
  if (alwaysUp) stand = 1.0;
  if (!groanOK && pose > 3.5) pose = 0.0;
  // night: occasional phone flash / camera; phone lights up in big moments
  float flashSlot = floor(T * 5.0 + hs(sd, 41.0) * 5.0);
  float camFlash = step(1.0 - 0.0002 * (0.4 + ex), hs(sd + flashSlot * 3.7, 42.0));
  glow = max(glow * (phone ? 1.0 : 0.0) * (0.55 + 0.45 * sin(T * 3.0 + sd)), camFlash * 0.9);
  glow *= uNight;

  // -------- atlas cell --------
  float cellIdx = ident * uPoses + pose;
  float col = mod(cellIdx, uGrid.x), row = floor(cellIdx / uGrid.x);
  vOrg = vec2(col / uGrid.x, 1.0 - (row + 1.0) / uGrid.y);

  // -------- card geometry (feet) --------
  float cellH = uCellFt * hsc * (1.0 + 0.16 * farK * waveLift), cellW = cellH * uCellAspect;
  float topV = pose > 2.5 && pose < 3.5 ? 1.0 : (pose > 3.5 ? 0.76 : 0.69);
  float legFt = kind > 1.5 ? 3.35 * hsc : mix(0.95, 3.35 * hsc, stand);
  float waistY = kind > 1.5 ? P.y + 3.35 * hsc : P.y + 0.55 + stand * 1.35 * hsc;
  waistY += hop - slump;
  float yBot = -legFt / cellH, yTop = topV - uWaistV;
  float vy = mix(yBot, yTop, position.y);
  float vx = position.x;
  vec2 lp = vec2(vx * cellW, vy * cellH);
  float sn = sway, cs = 1.0 - 0.5 * sway * sway;                  // small-angle rotation
  lp = vec2(cs * lp.x - sn * lp.y, sn * lp.x + cs * lp.y);
  // face the field; turn partially toward the camera so side views never go edge-on
  vec2 f = normalize(iB.xy + 1e-5);
  vec2 toC = cameraPosition.xz - wP.xz; toC /= max(length(toC), 1e-3);
  float fd = dot(f, toC);
  float back = step(fd, -0.08);
  vec2 nrm = back > 0.5 ? f : normalize(f + 1.25 * toC);           // up to ~50° toward the camera
  vec3 right = vec3(nrm.y, 0.0, -nrm.x);
  // lean the card back toward a camera above (TV high-home / aerial) so fans never flatten; pivot = waist
  float elev = (cameraPosition.y - wP.y - 2.0) / max(dist, 1.0);
  float pitch = clamp(elev, -0.15, 0.85) * 0.55 * (1.0 - back);
  vec3 upv = normalize(vec3(-nrm.x * pitch, 1.0, -nrm.y * pitch));
  vec3 pos = vec3(P.x, waistY, P.z) + right * lp.x + upv * lp.y;
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  vUv = vec2(mirror ? -vx : vx, vy);
  vShirt = lin(iS.rgb); vCap = lin(iC.rgb); vPants = lin(iP.rgb); vSkin = lin(iK.rgb);
  float jit = 0.88 + 0.22 * iP.a;
  vec3 L = kind > 0.5 && kind < 1.5 ? uShd : uLit;
  float sunK = uSun.z > 0.5 && kind < 0.5 ? 0.8 + 0.32 * max(0.0, dot(nrm, uSun.xy)) : 1.0;
  // seated fans sit in the shadow of the row in front; standing (and wave) fans come up into the light
  vLit = L * jit * sunK * (back > 0.5 ? 0.62 : 1.0) * mix(0.9, 1.04, stand) * (1.0 + (0.16 + 0.45 * farK) * waveLift);
  vBack = back;
  vLeg = vec4(legFt / cellH, iD.w, kind > 1.5 ? 1.0 : stand, shorts ? 1.0 : 0.0);
  vec2 gp = pose > 2.5 && pose < 3.5 ? vec2((hs(sd, 43.0) < 0.5 ? -0.3 : 0.3), 0.9) : (pose > 0.5 && pose < 2.5 ? vec2(0.0, 0.25) : vec2(0.18, 0.06));
  vGlow = vec3(glow, gp.x * (mirror ? -1.0 : 1.0), gp.y - uWaistV);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform sampler2D uAtlas; uniform vec2 uAtlasPx, uGrid; uniform float uWaistV, uHardCut, uNight;
varying vec2 vUv; varying vec2 vOrg;
varying vec3 vShirt; varying vec3 vCap; varying vec3 vPants; varying vec3 vSkin; varying vec3 vLit;
varying vec4 vLeg; varying vec3 vGlow; varying float vBack;
#include <common>
#include <fog_pars_fragment>
void main(){
  vec2 uv = vUv;
  float cy = uv.y + uWaistV;
  vec2 auv = vOrg + vec2(clamp(uv.x + 0.5, 0.004, 0.996) / uGrid.x, clamp(cy, 0.002, 0.998) / uGrid.y);
  vec4 tx = texture2D(uAtlas, auv);
  vec2 dx = dFdx(auv * uAtlasPx), dy = dFdy(auv * uAtlasPx);
  float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  float a = tx.a * (1.0 + max(lod, 0.0) * 0.3) * step(uWaistV - 0.003, cy);
  float aS = clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
  // chroma keys → per-fan shirt / cap colour (shading from the painted fabric)
  vec3 c = tx.rgb;
  float mxRB = max(c.r, c.b), mnRB = min(c.r, c.b), mxGB = max(c.g, c.b), mnGB = min(c.g, c.b);
  float km = clamp((mnRB - c.g) * 8.0, 0.0, 1.0) * smoothstep(0.5, 0.8, mnRB / max(mxRB, 1e-4));
  float kc = clamp((mnGB - c.r) * 8.0, 0.0, 1.0) * smoothstep(0.5, 0.8, mnGB / max(mxGB, 1e-4));
  // despill the anti-aliased key edges (collars, sleeves, cap brims) before tinting
  vec3 cd = c;
  float sM = max(0.0, mnRB - c.g), sC = max(0.0, mnGB - c.r);
  cd.rb -= vec2(sM); cd.gb -= vec2(sC);
  vec3 col = mix(max(cd, vec3(0.0)), vShirt * (0.1 + 1.12 * pow(mxRB, 0.7)), km);
  col = mix(col, vCap * (0.12 + 1.05 * pow(mxGB, 0.7)), kc);
  // seen from behind: faces become the back of the head (hair), arms/shirts stay
  if (vBack > 0.5) {
    float headZone = smoothstep(0.43, 0.47, cy) * (1.0 - smoothstep(0.12, 0.16, abs(uv.x))) * (1.0 - km) * (1.0 - kc);
    col = mix(col, vec3(0.045, 0.033, 0.026) + col * 0.12, headZone);
  }
  // procedural legs / lap below the waist cut
  float legLen = vLeg.x, hw0 = vLeg.y * 0.92, standK = vLeg.z;
  float t = clamp(-uv.y / max(legLen, 1e-3), 0.0, 1.0);
  float ax = abs(uv.x);
  float fw = fwidth(uv.x) * 0.8 + 1e-4;
  // seated: hips + two knees pointing at the viewer (foreshortened thighs); standing: two legs to the floor
  float kneeR = hw0 * 0.36;
  float hwS = hw0 * 0.8;
  vec2 kq = vec2(ax - hw0 * 0.4, (uv.y + legLen * 0.34) * 1.5);
  float seatedIn = max((1.0 - smoothstep(hwS - fw, hwS + fw, ax)) * (1.0 - step(0.3, t)), 1.0 - smoothstep(kneeR - fw, kneeR + fw, length(kq)));
  float hw = hw0 * mix(0.8, 0.5, t);
  float gap = hw0 * 0.24 * smoothstep(0.08, 0.5, t);
  float standIn = (1.0 - smoothstep(hw - fw, hw + fw, ax)) * smoothstep(gap - fw, gap + fw, ax);
  float legA = mix(seatedIn, standIn, step(0.5, standK)) * step(uv.y, 0.008) * step(-legLen, uv.y);
  vec3 lc = (vLeg.w > 0.5 && t > 0.34 && standK > 0.5) ? vSkin * 0.9 : vPants;
  if (standK > 0.5 && t > 0.93) lc = vec3(0.035);
  float lx = standK > 0.5 ? clamp((ax - gap) / max(hw - gap, 1e-3), 0.0, 1.0) : clamp(ax / max(hwS, 1e-3), 0.0, 1.0) * 0.5 + 0.25;
  lc *= 0.62 + 0.38 * sin(3.14159 * lx);
  lc *= standK > 0.5 ? mix(1.0, 0.55, smoothstep(0.1, 0.9, t)) : mix(0.6, 0.95, smoothstep(0.02, 0.4, t)) * (1.0 - 0.5 * smoothstep(0.35, 0.55, t));
  col = mix(lc, col, aS);
  float A = max(aS, legA);
  // light: row AO toward the bottom, heads catch the light
  float ao = mix(0.62, 1.0, smoothstep(-0.12, 0.42, uv.y));
  col *= vLit * ao * (1.0 + uNight * 0.22 * smoothstep(0.25, 0.62, uv.y));
  // night phone lights / camera flashes (never smaller than ~1.5 px)
  if (vGlow.x > 0.001) {
    vec2 d = (uv - vGlow.yz) * vec2(1.0, 0.62);
    float r = max(0.035, 1.6 * fwidth(uv.x));
    float g = vGlow.x * exp(-dot(d, d) / (r * r));
    col += vec3(1.0, 0.96, 0.86) * g * 7.0;
    A = max(A, smoothstep(0.08, 0.35, g));
  }
  if (uHardCut > 0.5) { if (A < 0.5) discard; A = 1.0; }
  else if (A < 0.02) discard;
  gl_FragColor = vec4(col, A);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
