// ============================================================================
// WINDY CITY DERBY — DIRECTOR. Every camera move in the game.
// Owner: CINEMA (v2; v1 by ACTORS).
//
//   const dir = createDirector(THREE, camera, { parkId, bats, occluders })
//   dir.setMode('title'|'select'|'batting'|'follow'|'homer'|'result'
//               |'outOfPark'|'wave'|'booth', opts)
//     'outOfPark' { result, landmarks?, parkId?, onCue?(name, info) }  — multi-shot sequence:
//         CHASE (trail the ball over the ivy / bleachers) → CATCH (street / rooftop / lot level,
//         slow-mo as it comes over the back row, ballhawks, impact) → WIDE (reverse angle back
//         at the park). Cues: 'overTheWall', 'overTheTop', 'landing', 'reverse'.
//     'wave'      { fromSpray, dur=2.6 }   sweeping crowd pan across the bowl
//     'booth'     { pos, look }            3D push-in on the press-level booth windows
//     'batting'   { override?:{pos,look,fov} }   sideways-batter broadcast framing
//   dir.follow(result)   // == setMode('follow', { result })
//   dir.shake(amount)    // 0..1 trauma (0.6 = sweet contact)
//   dir.pitchProgress(u) // optional: u = pitch time / flight time while the pitch is live (push-in), null after
//   dir.timeScale        // suggested game-clock multiplier for the current shot (slow-mo moments; 1 = none)
//   dir.shotName         // e.g. 'oop:catch'
//   dir.update(dt, t)    // writes camera.position / quaternion / fov (+ cinemaPost letterbox/slowmo)
//   dir.resize(aspect)   dir.fovFor(aspect) → vertical fov (deg) of the batting cam
//
// Ball tracking: actors.js publishes the live ball position into `ballTrack`
// (exported below) from ballFlightT()/settle(); the director reads it, so the
// camera follows the ball exactly under the game's slow-mo / hit-stop clock.
// If nothing publishes (director used alone) it falls back to its own clock.
//
// Everything is blended: on every setMode the current camera pose is captured
// and eased into the new shot (no pops). World units = feet, see data.js.
// ============================================================================
import { fenceDistance, surfaceHeight, scoreboardDistance, PARKS } from './data.js';

/** Live ball state shared by actors.js → camera.js (single game instance). */
export const ballTrack = { x: 0, y: 3, z: -1.2, tau: 0, live: false, landed: false, seq: 0, stamp: 0 };
/**
 * Live cinematic post state shared by camera.js → render.js (single game instance).
 * letterbox 0..0.3 (fraction of half-height covered by each bar), slowmo 0..1 (replay tint),
 * flash / aberr 0..1 impact punches, exposure multiplier, bloomBoost 0..1.
 */
export const cinemaPost = { letterbox: 0, slowmo: 0, flash: 0, aberr: 0, exposure: 1, bloomBoost: 0 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const DEG = Math.PI / 180;

// ============================================================================
// Occluder grid: a uniform-grid ray accelerator over the stadium's static meshes,
// built once per occluder root (cached), time-sliced across frames. Used only to
// pick an unobstructed homer camera (a few dozen rays once per homer).
// ============================================================================
const GRIDS = new WeakMap();
/** @internal exported for tests */
export function occluderGrid(THREE, root) {
  if (!root) return null;
  let G = GRIDS.get(root);
  if (G) return G;
  G = { ready: false, n: 0, tris: null, step: null, raycast: null, stats: null };
  GRIDS.set(root, G);
  const meshes = [];
  try { root.updateMatrixWorld(true); } catch (e) { /* ignore */ }
  root.traverseVisible(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position) return;
    if (o.userData && o.userData.noOcclude) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    // see-through (alpha-tested chain-link, cut-out signs, nets) and FX never occlude
    if (!m || m.depthWrite === false || m.blending === THREE.AdditiveBlending || m.alphaTest > 0 || (m.transparent && (m.opacity ?? 1) < 0.35) || m.visible === false) return;
    meshes.push(o);                                                   // sky domes don't write depth → skipped above
  });
  let total = 0;
  for (const m of meshes) { const g = m.geometry; total += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3); }
  const T = new Float32Array(total * 9);
  const triDark = new Uint8Array(Math.max(1, total));
  const lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const meshLum = meshes.map(m => { const mt = Array.isArray(m.material) ? m.material[0] : m.material; return mt.color ? lum(mt.color) : 1; });
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  const v = new THREE.Vector3();
  // --- phase 1: extract world-space triangles (sliced by mesh) ---
  let mi = 0, w = 0, phase = 1;
  let dims, cs, counts, start, list, ti = 0;
  const cellRange = (i, out) => {
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let k = 0; k < 3; k++) { const x = T[i + k * 3], y = T[i + k * 3 + 1], z = T[i + k * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    out[0] = clamp(Math.floor((x0 - min[0]) / cs[0]), 0, dims[0] - 1); out[3] = clamp(Math.floor((x1 - min[0]) / cs[0]), 0, dims[0] - 1);
    out[1] = clamp(Math.floor((y0 - min[1]) / cs[1]), 0, dims[1] - 1); out[4] = clamp(Math.floor((y1 - min[1]) / cs[1]), 0, dims[1] - 1);
    out[2] = clamp(Math.floor((z0 - min[2]) / cs[2]), 0, dims[2] - 1); out[5] = clamp(Math.floor((z1 - min[2]) / cs[2]), 0, dims[2] - 1);
  };
  const rng = [0, 0, 0, 0, 0, 0];
  G.step = (budget = 6000) => {
    if (G.ready) return true;
    let done = 0;
    if (phase === 1) {
      while (mi < meshes.length && done < budget) {
        const mIndex = mi, m = meshes[mi++], g = m.geometry, pos = g.attributes.position, idx = g.index, mw = m.matrixWorld;
        const mt = Array.isArray(m.material) ? m.material[0] : m.material, vc = mt.vertexColors && g.attributes.color ? g.attributes.color : null;
        const nt = Math.floor((idx ? idx.count : pos.count) / 3);
        for (let t = 0; t < nt; t++) {
          const w0 = w;
          for (let k = 0; k < 3; k++) { v.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(mw); T[w++] = v.x; T[w++] = v.y; T[w++] = v.z; }
          const cx = (T[w0] + T[w0 + 3] + T[w0 + 6]) / 3, cz = (T[w0 + 2] + T[w0 + 5] + T[w0 + 8]) / 3, cy = (T[w0 + 1] + T[w0 + 4] + T[w0 + 7]) / 3;
          if (cx * cx + cz * cz > 1300 * 1300 || cy > 700) { w = w0; continue; }   // distant city / skyline: irrelevant
          let L = meshLum[mIndex];
          if (vc) { let a = 0; for (let k = 0; k < 3; k++) { const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k; a += 0.2126 * vc.getX(vi) + 0.7152 * vc.getY(vi) + 0.0722 * vc.getZ(vi); } L *= a / 3; }
          triDark[w0 / 9] = L < 0.12 ? 1 : 0;
          for (let k = 0; k < 9; k += 3) {
            const x = T[w0 + k], y = T[w0 + k + 1], z = T[w0 + k + 2];
            if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
          }
        }
        done += nt;
      }
      if (mi >= meshes.length) {
        G.n = w / 9;
        for (let k = 0; k < 3; k++) { min[k] = Math.max(min[k], k === 1 ? -50 : -1400) - 1; max[k] = Math.min(max[k], k === 1 ? 700 : 1400) + 1; }
        cs = [24, 12, 24];
        dims = [0, 1, 2].map(k => Math.max(1, Math.min(96, Math.ceil((max[k] - min[k]) / cs[k]))));
        for (let k = 0; k < 3; k++) cs[k] = (max[k] - min[k]) / dims[k];
        counts = new Uint32Array(dims[0] * dims[1] * dims[2] + 1);
        phase = 2; ti = 0;
      }
      return false;
    }
    if (phase === 2 || phase === 3) {
      while (ti < G.n && done < budget) {
        cellRange(ti * 9, rng);
        for (let z = rng[2]; z <= rng[5]; z++) for (let y = rng[1]; y <= rng[4]; y++) for (let x = rng[0]; x <= rng[3]; x++) {
          const c = x + dims[0] * (y + dims[1] * z);
          if (phase === 2) counts[c]++; else list[start[c] + counts[c]++] = ti;
        }
        ti++; done++;
      }
      if (ti >= G.n) {
        if (phase === 2) {
          start = new Uint32Array(counts.length); let acc = 0;
          for (let c = 0; c < counts.length; c++) { start[c] = acc; acc += counts[c]; counts[c] = 0; }
          list = new Uint32Array(acc); phase = 3; ti = 0;
        } else { G.ready = true; G.stats = { tris: G.n, meshes: meshes.length, dims, entries: list.length }; }
      }
      return G.ready;
    }
    return G.ready;
  };
  const mail = new Uint32Array(Math.max(1, total)); let rayId = 0;
  /** nearest hit distance along a unit ray, ≤ far, else Infinity */
  G.raycast = (ox, oy, oz, dx, dy, dz, far) => {
    if (!G.ready) return Infinity;
    rayId = (rayId + 1) >>> 0; if (rayId === 0) { mail.fill(0); rayId = 1; }
    // clip to grid bounds
    let t0 = 0, t1 = far;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < min[k] || o[k] > max[k]) return Infinity; continue; }
      let a = (min[k] - o[k]) / d[k], b = (max[k] - o[k]) / d[k]; if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity;
    }
    const cell = [0, 0, 0], stp = [0, 0, 0], tMax = [0, 0, 0], tDel = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = o[k] + d[k] * (t0 + 1e-4);
      cell[k] = clamp(Math.floor((p - min[k]) / cs[k]), 0, dims[k] - 1);
      if (d[k] > 0) { stp[k] = 1; tMax[k] = (min[k] + (cell[k] + 1) * cs[k] - o[k]) / d[k]; tDel[k] = cs[k] / d[k]; }
      else if (d[k] < 0) { stp[k] = -1; tMax[k] = (min[k] + cell[k] * cs[k] - o[k]) / d[k]; tDel[k] = -cs[k] / d[k]; }
      else { stp[k] = 0; tMax[k] = Infinity; tDel[k] = Infinity; }
    }
    let best = Infinity, bestTri = -1;
    for (let guard = 0; guard < 600; guard++) {
      const c = cell[0] + dims[0] * (cell[1] + dims[1] * cell[2]);
      const s0 = start[c], s1 = s0 + counts[c];
      for (let j = s0; j < s1; j++) {
        const tri = list[j]; if (mail[tri] === rayId) continue; mail[tri] = rayId;
        const i = tri * 9;
        const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
        const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz; if (det > -1e-9 && det < 1e-9) continue;
        const inv = 1 / det, sx = ox - T[i], sy = oy - T[i + 1], sz = oz - T[i + 2];
        const uu = (sx * px + sy * py + sz * pz) * inv; if (uu < 0 || uu > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const vv = (dx * qx + dy * qy + dz * qz) * inv; if (vv < 0 || uu + vv > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-3 && tt < best) { best = tt; bestTri = tri; }
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (best <= tMax[k] || tMax[k] > t1) break;
      cell[k] += stp[k]; if (cell[k] < 0 || cell[k] >= dims[k]) break;
      tMax[k] += tDel[k];
    }
    G.hitDark = best <= far && bestTri >= 0 ? triDark[bestTri] === 1 : false;
    return best <= far ? best : Infinity;
  };
  return G;
}

export function createDirector(THREE, camera, { parkId = 'wrigley', bats = 'R', occluders = null } = {}) {
  const V = () => new THREE.Vector3();
  const P = PARKS[parkId] || PARKS.wrigley;
  const sgn = bats === 'L' ? 1 : -1;            // camera sits on the batter's back side
  let aspect = camera.aspect || 390 / 844;
  let mode = 'batting', modeT = 0, opts = {};
  let homerCount = 0, shot = 'reverse';
  let trauma = 0, time = 0;
  let occ = occluders ? occluderGrid(THREE, occluders) : null;
  let lastPick = null;
  let lastDt = 1 / 60, HTS = 1;

  // pose state
  const out = { pos: V().copy(camera.position), look: V(), fov: camera.fov || 50 };
  const tmp = V();
  camera.getWorldDirection(tmp);
  out.look.copy(camera.position).addScaledVector(tmp, 80);
  const from = { pos: V().copy(out.pos), look: V().copy(out.look), fov: out.fov };
  const raw = { pos: V(), look: V(), fov: 50 };
  const sm = { pos: V(), look: V(), fov: 50 };
  const raw2 = { pos: V(), look: V(), fov: 50 };
  let smInit = false;
  let blend = 1, blendDur = 1, arcH = 0;
  const orbit = { on: false, a: null, b: null, m: null, d0: 0, q: null };
  const rates = { pos: 4, look: 8, fov: 3 };

  // follow state
  const F = {
    result: null, pts: null, n: 0, endT: 0, landT: 0, homer: false, spray: 0, dist: 0, fence: 400,
    land: V(), apex: V(), rest: V(), start: V(), ball: V(), clock: 0, seq: -1, camPos: V(), kind: '',
  };
  const tv = V(), tu = V(), tw = V(), up = new THREE.Vector3(0, 1, 0);
  orbit.a = V(); orbit.b = V(); orbit.m = V(); orbit.q = new THREE.Quaternion(); const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ov = V();

  // ------------------------------------------------------------ framing
  function fovFor(a = aspect) {
    // vertical fov: keep ≥30° horizontal in portrait, ≥40° vertical in landscape
    const hMin = 30 * DEG;
    const v = 2 * Math.atan(Math.tan(hMin / 2) / Math.max(a, 0.2)) / DEG;
    return clamp(Math.max(40, v), 40, 62);
  }
  // 0 = tall portrait … 1 = wide landscape
  const shapeK = () => smooth(0.55, 1.7, aspect);

  // Broadcast "high home" batting cam for the SIDEWAYS batter (RHB on −X facing +X, lefty
  // mirrored): behind the plate and off the batter's back shoulder, high enough that the pitch
  // lane clears his helmet. The batter reads large in the lower third (his back + closed front
  // shoulder), the pitch lane and plate sit just inside him, and the top of frame carries the
  // pitcher, the infield, the wall and the park's signature structures (Wrigley scoreboard +
  // rooftops / Rate board + pinwheels). Landscape pulls back and centres.
  // FRAMING can be tuned live: dir.framing = { portrait:{...}, landscape:{...} }.
  const FRAMING = {
    portrait:  { x: 4.0, y: 12.0, z: 17.6, lx: 1.2, ly: -5.4, fovAdd: 0 },
    landscape: { x: 1.5, y: 10.4, z: 27.0, lx: 1.6, ly: 1.2, fovAdd: 0 },
  };
  const PT = { u: null, push: 0, lastU: null };
  function battingPose(o, t) {
    const k = shapeK();
    const A = FRAMING.portrait, B = FRAMING.landscape;
    o.pos.set(sgn * lerp(A.x, B.x, k), lerp(A.y, B.y, k), lerp(A.z, B.z, k));
    o.look.set(-sgn * lerp(A.lx, B.lx, k), lerp(A.ly, B.ly, k), -60);
    o.fov = fovFor(aspect) + lerp(A.fovAdd, B.fovAdd, k);
    // idle life: slow breathing handheld drift (two incommensurate sines per axis)
    o.pos.x += Math.sin(t * 0.21) * 0.10 + Math.sin(t * 0.53) * 0.03;
    o.pos.y += Math.sin(t * 0.17 + 1.3) * 0.07 + Math.sin(t * 0.61) * 0.02;
    o.look.x += Math.sin(t * 0.13 + 0.4) * 0.22;
    o.look.y += Math.sin(t * 0.19) * 0.12;
    // pitch-tracking push: an operator leaning in as the ball comes (≈1.4° tighter, look eases
    // a touch toward the plate), released after the pitch.
    const want = PT.u == null ? 0 : smooth(0.05, 0.9, PT.u);
    PT.push += (want - PT.push) * (1 - Math.exp(-lastDt * (PT.u == null ? 2.2 : 4.5)));
    o.fov -= 1.4 * PT.push;
    o.look.y -= 0.8 * PT.push * (1 - k);
    o.pos.z -= 0.6 * PT.push;
    if (opts.override) applyOverride(o);
  }
  function applyOverride(o) {
    const ov = opts.override;
    if (ov.pos) o.pos.set(ov.pos[0], ov.pos[1], ov.pos[2]);
    if (ov.look) o.look.set(ov.look[0], ov.look[1], ov.look[2]);
    if (ov.fov) o.fov = ov.fov;
  }

  function titlePose(o, t) {
    // slow, high orbit over the park with a gentle push and height breathing
    const a = Math.sin(t * 0.045) * 1.05 + 0.15 * Math.sin(t * 0.11);
    const R = 390 + 40 * Math.sin(t * 0.07);
    const cz = -170;
    o.pos.set(Math.sin(a) * R, 172 + 20 * Math.sin(t * 0.06 + 1), cz + Math.cos(a) * R);
    o.look.set(Math.sin(a) * -40, 72, -250 + 30 * Math.sin(t * 0.05));
    o.fov = clamp(fovFor(aspect) * 0.95, 38, 58);
  }
  function selectPose(o, t) {
    // low hero angle from behind the batter's back shoulder, looking up past him at the park
    const k = shapeK();
    o.pos.set(sgn * lerp(6.2, 7.5, k) + Math.sin(t * 0.2) * 0.35, lerp(2.3, 2.8, k), lerp(15.5, 17, k) + Math.sin(t * 0.13) * 0.4);
    o.look.set(sgn * lerp(0.6, -0.8, k), lerp(8.5, 7.5, k), -40);
    o.fov = clamp(fovFor(aspect) * 0.92, 36, 58);
  }
  function resultPose(o, t) {
    const r = opts.result;
    if (r && r.path && r.path.landing) {
      const L = r.path.rest || r.path.landing;
      const a = t * 0.06;
      tv.set(L[0], L[1], L[2]);
      o.look.copy(tv).multiplyScalar(0.6);
      o.look.y = 20;
      o.pos.set(Math.sin(a) * 60 + sgn * 30, 175, 150);
    } else {
      const a = Math.sin(t * 0.05) * 0.5;
      o.pos.set(Math.sin(a) * 200, 175 + 15 * Math.sin(t * 0.08), 150 + Math.cos(a) * 30);
      o.look.set(0, 25, -230);
    }
    o.fov = clamp(fovFor(aspect), 40, 60);
  }

  // ------------------------------------------------------------ follow
  function sampleAt(tau, outV) {
    const pts = F.pts; if (!pts || F.n < 1) return outV.copy(F.start);
    if (tau <= pts[0]) return outV.set(pts[1], pts[2], pts[3]);
    // fixed 1/60 s sampling → direct index, then fix up
    let i = clamp(Math.floor((tau - pts[0]) * 60), 0, F.n - 2);
    while (i > 0 && pts[i * 4] > tau) i--;
    while (i < F.n - 2 && pts[(i + 1) * 4] < tau) i++;
    const o = i * 4, t0 = pts[o], t1 = pts[o + 4];
    const f = t1 > t0 ? clamp((tau - t0) / (t1 - t0), 0, 1) : 1;
    return outV.set(lerp(pts[o + 1], pts[o + 5], f), lerp(pts[o + 2], pts[o + 6], f), lerp(pts[o + 3], pts[o + 7], f));
  }
  function initFollow(result) {
    F.result = result; F.kind = result?.kind || '';
    const path = result && result.path;
    F.pts = path && path.pts ? path.pts : null;
    F.n = F.pts ? Math.floor(F.pts.length / 4) : 0;
    F.endT = F.n ? F.pts[(F.n - 1) * 4] : 0;
    const cp = result?.contactPos || [0, 3, -1.2];
    F.start.set(cp[0], cp[1], cp[2]);
    if (path && path.landing) F.land.set(path.landing[0], path.landing[1], path.landing[2]); else F.land.copy(F.start);
    if (path && path.apex) F.apex.set(path.apex[0], path.apex[1], path.apex[2]); else F.apex.copy(F.start);
    if (path && path.rest) F.rest.set(path.rest[0], path.rest[1], path.rest[2]); else F.rest.copy(F.land);
    F.landT = result?.hangTime || F.endT;
    F.homer = result?.kind === 'homer';
    F.spray = Math.atan2(F.land.x, -F.land.z) / DEG;
    F.dist = Math.hypot(F.land.x, F.land.z);
    F.fence = fenceDistance(parkId, clamp(F.spray, -45, 45));
    F.clock = 0; F.seq = ballTrack.seq; F.stamp0 = ballTrack.stamp; F.wait = 0;
    F.ball.copy(F.start);
    // chase position (elevated, behind home, leaning toward the ball's side)
    const deep = F.dist > 160 || F.homer;
    const high = F.apex.y > 70 && F.dist < 170;
    const back = F.land.z > 5; // foul back / behind
    const k = shapeK();
    if (back) F.camPos.set(sgn * 10, 16, 36);
    else if (high) F.camPos.set(sgn * 9 + F.land.x * 0.12, 16, 40 + k * 8);
    else if (deep) F.camPos.set(sgn * 5 + F.land.x * 0.07, 32 + Math.min(F.apex.y, 150) * 0.14, 44 + k * 10);
    else F.camPos.set(sgn * 5 + F.land.x * 0.2, 20, 34 + k * 8);
  }
  function currentBall(dt) {
    // trust the shared track only once actors.js has written it after this follow() began
    if (ballTrack.live && ballTrack.stamp !== F.stamp0) {
      F.ball.set(ballTrack.x, ballTrack.y, ballTrack.z);
      F.clock = ballTrack.tau; F.wait = 0;
    } else if ((F.wait += dt) > 0.3) { // nobody is publishing: run our own clock
      F.clock += dt * 1.25;
      sampleAt(F.clock, F.ball);
    } else F.ball.copy(F.start);
    return F.ball;
  }
  function framedFov(camPos, look, radius, minF, maxF) {
    const D = Math.max(1, camPos.distanceTo(look));
    const h = 2 * Math.atan(radius / D);                            // needed angle across
    const vFromH = 2 * Math.atan(Math.tan(h / 2) / Math.max(aspect, 0.2)); // if width is the limit
    const need = Math.max(h, aspect < 1 ? vFromH : h) / DEG;
    return clamp(need, minF, maxF);
  }
  function keepInFrame(o, target, maxFrac) {
    // pull the look point toward `target` until target is within maxFrac of the half-fov
    const half = (o.fov * DEG) / 2;
    const hHalf = Math.atan(Math.tan(half) * aspect);
    const lim = Math.min(half, hHalf) * maxFrac;
    tu.copy(o.look).sub(o.pos).normalize();
    tw.copy(target).sub(o.pos).normalize();
    const ang = Math.acos(clamp(tu.dot(tw), -1, 1));
    if (ang > lim && ang > 1e-4) {
      const f = 1 - lim / ang;
      const d = o.look.distanceTo(o.pos);
      tu.lerp(tw, f).normalize();
      o.look.copy(o.pos).addScaledVector(tu, d);
    }
  }
  // vertical fov (deg) needed to fit points around the look direction (camera basis)
  const _f = V(), _r = V(), _u = V();
  function fitFov(pos, look, pts, margin) {
    _f.subVectors(look, pos).normalize();
    _r.crossVectors(_f, up); if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0); _r.normalize();
    _u.crossVectors(_r, _f);
    let v = 0, h = 0;
    for (let i = 0; i < pts.length; i++) {
      tv.subVectors(pts[i], pos); const z = tv.dot(_f); if (z < 1) continue;
      const x = Math.abs(tv.dot(_r)) / z, y = Math.abs(tv.dot(_u)) / z;
      if (x > h) h = x; if (y > v) v = y;
    }
    const vN = 2 * Math.atan(v * margin), hN = 2 * Math.atan((h * margin) / Math.max(aspect, 0.2));
    return Math.max(vN, hN) / DEG;
  }
  const fitPts = [V(), V(), V(), V()];
  function followPose(o, t, dt) {
    const B = currentBall(dt);
    const tau = F.clock;
    const landed = tau >= F.landT - 0.02;
    battingPose(raw2, t);
    // ease the camera from the batting cam up to the chase point over ~0.9 s of game time
    const e = easeIO(smooth(0, 1.0, modeT));
    o.pos.copy(raw2.pos).lerp(F.camPos, e);
    // look target: weighted centre of the ball and where it is going; zoom to fit both
    const wl = landed ? 1.6 : 0.9 * smooth(0.3, 1.1, modeT) * smooth(0.0, 0.6, tau / Math.max(F.landT, 0.1));
    tv.copy(F.land).lerp(F.rest, landed ? 0.5 : 0);
    o.look.copy(B).addScaledVector(tv, wl).divideScalar(1 + wl);
    if (F.kind === 'grounder' || F.kind === 'liner') o.look.y = Math.max(o.look.y, 3);
    const base = fovFor(aspect);
    fitPts[0].copy(B); fitPts[1].copy(tv); fitPts[2].copy(tv); fitPts[2].y += 12;
    fitPts[3].copy(modeT < 1.3 && !landed ? F.start : B);        // keep the arc's origin in shot early on
    const need = fitFov(o.pos, o.look, fitPts, landed ? 1.9 : 1.3);
    o.fov = clamp(need, 28, base + 4);
    o.fov = lerp(base, o.fov, smooth(0.1, 0.8, modeT));
    // never swing the camera to look backwards (fouls behind the plate)
    if (o.look.z > o.pos.z - 20) o.look.z = o.pos.z - 20;
  }

  // ------------------------------------------------------------ homer shots
  const H = { pos: V(), look: V(), fov: 45 };
  // ---- candidate homer poses ------------------------------------------------
  const cand = [];
  for (let i = 0; i < 10; i++) cand.push({ name: '', kind: 'reverse', pos: V(), look: V(), fov: 50, bias: 0, score: 0, valid: true, occl: 0, clutter: 0 });
  const ringTw = V();
  function reversePos(out, side, rAdd, yAdd, latD, close) {
    const s = clamp(F.spray, -60, 60) * DEG;
    const ux = Math.sin(s), uz = -Math.cos(s), lx = Math.cos(s), lz = Math.sin(s);
    const r = close ? Math.max(F.dist + 22, F.fence + 18) : Math.max(F.dist + 32, F.fence + P.stands.depth * 0.5) + rAdd;   // always beyond the landing
    out.set(ux * r + lx * side * latD, 0, uz * r + lz * side * latD);
    const cs = Math.atan2(out.x, -out.z) / DEG, cr = Math.hypot(out.x, out.z);
    const surf = surfaceHeight(parkId, clamp(cs, -45, 45), cr);
    let y = close ? Math.max(surf + 20, F.land.y + 30, 34) : Math.max(surf + 45, F.land.y + 60, 90);
    const sb = scoreboardDistance(parkId, cs);
    if (sb != null && cr > sb - 12) y = Math.max(y, P.scoreboard.h + 30);
    out.y = y + yAdd;
    return out;
  }
  function modelHeight(x, z) {           // analytic park surface (data.js) at a point
    if (z > 0) return 0;
    const s = Math.atan2(x, -z) / DEG; if (Math.abs(s) > 45) return 0;
    const r = Math.hypot(x, z), fr = fenceDistance(parkId, s);
    return r < fr ? 0 : surfaceHeight(parkId, s, r);
  }
  function modelHitT(ox, oy, oz, dx, dy, dz, far, step = 2.5) {
    for (let t = 1; t <= far; t += step) if (oy + dy * t <= modelHeight(ox + dx * t, oz + dz * t)) return t;
    return Infinity;
  }
  const _tg = [V(), V(), V(), V(), V(), V()], _tw = [3, 2, 1.5, 1, 1, 1];
  const _pf = V(), _pr = V(), _pu = V();
  // 7×4 probe grid through a pose's frame: structure / dark masses / near foreground → clutter; count field hits
  const ROWS_FULL = [-0.88, -0.62, -0.36, -0.1, 0.3, 0.75], ROWS_MID = [-0.8, -0.5, -0.2, 0.25];
  function probeFrame(p, look, fov, countField, rows = ROWS_FULL) {
    let clutter = 0, field = 0;
    _pf.subVectors(look, p); const lookD = Math.max(1, _pf.length()); _pf.divideScalar(lookD);
    _pr.crossVectors(_pf, up); if (_pr.lengthSq() < 1e-6) _pr.set(1, 0, 0); _pr.normalize(); _pu.crossVectors(_pr, _pf);
    const tv2 = Math.tan((fov * DEG) / 2), th2 = tv2 * aspect, far = Math.min(260, lookD * 0.85);
    const wRow = 4 / rows.length;             // keep scores comparable across grid densities
    for (let iy = 0; iy < rows.length; iy++) for (let ix = 0; ix < 7; ix++) {
      const sx = -0.9 + ix * 0.3, sy = rows[iy];
      tv.copy(_pf).addScaledVector(_pr, sx * th2).addScaledVector(_pu, sy * tv2).normalize();
      const tg = occ.raycast(p.x, p.y, p.z, tv.x, tv.y, tv.z, far);
      if (countField) { // rays reaching the playing surface (traced analytically past `far`)
        const tf = tg === Infinity ? modelHitT(p.x, p.y, p.z, tv.x, tv.y, tv.z, 900, 8) : tg;
        if (tf < Infinity) { const hx = p.x + tv.x * tf, hy = p.y + tv.y * tf, hz = p.z + tv.z * tf; if (hy < 3 && hz < 5 && Math.hypot(hx, hz) < fenceDistance(parkId, clamp(Math.atan2(hx, -hz) / DEG, -45, 45)) - 2) field++; }
      }
      if (tg === Infinity) continue;
      const tm = modelHitT(p.x, p.y, p.z, tv.x, tv.y, tv.z, far + 20);
      if (tg < tm - 8) clutter += 0.4 * wRow;          // structure the park surface model doesn't explain (pole, tower, roof, board)
      else if (occ.hitDark) clutter += 0.3 * wRow;     // dark mass (batter's eye, roof, steel) filling the frame
      else if (tg < 35) clutter += 0.1 * wRow;         // legit surface, but a big near foreground
    }
    return { clutter, field: field * wRow };
  }
  // where update()'s orbit swoop puts the camera at time-fraction u (mirrors the orbit code)
  const _op = V(), _ol = V(), _ob = V(), _oa = V(), _om = V(), _obb = V(), _oq = new THREE.Quaternion(), _oq2 = new THREE.Quaternion();
  function orbitSample(c, u, outPos, outLook) {
    const k = u * u * (3 - 2 * u);
    sampleAt(F.clock + u * 0.95 * 1.25, _ob);                   // ball then (homer pacing ≈ 1.25× game time)
    _oa.subVectors(out.pos, F.ball); const d0 = _oa.length() || 1; _oa.divideScalar(d0);
    _obb.subVectors(c.pos, _ob); const d1 = _obb.length() || 1; _obb.divideScalar(d1);
    _ol.copy(_oa).setY(0); tu.set(-_ol.z, 0, _ol.x); if (tu.dot(_obb) < 0) tu.negate();
    _om.copy(_oa).add(_obb).setY(0).addScaledVector(tu.normalize(), 0.9).normalize(); _om.y = 0.35 * (_oa.y + _obb.y) + 0.12; _om.normalize();
    if (k < 0.5) { _oq2.setFromUnitVectors(_oa, _om); _oq.identity().slerp(_oq2, k * 2); tw.copy(_oa).applyQuaternion(_oq); }
    else { _oq2.setFromUnitVectors(_om, _obb); _oq.identity().slerp(_oq2, k * 2 - 1); tw.copy(_om).applyQuaternion(_oq); }
    outPos.copy(_ob).addScaledVector(tw, lerp(d0, d1, k));
    outPos.y = Math.max(outPos.y, lerp(out.pos.y, c.pos.y, k), 175 * Math.pow(Math.sin(Math.PI * k), 0.6));
    outLook.copy(_ob).lerp(c.look, k * k);
    return outPos;
  }
  function scoreCandidate(c) {
    c.valid = true; c.occl = 0; c.clutter = 0;
    const p = c.pos;
    if (p.y < modelHeight(p.x, p.z) + 8) { c.valid = false; return (c.score = 1e3); }
    if (occ.raycast(p.x, p.y, p.z, 0, 1, 0, 30) < Infinity) { c.valid = false; return (c.score = 1e3); }
    // reverse cameras inside the CF board / batter's-eye sector look down on a dark, shadowed mass
    if (c.kind === 'reverse' && P.scoreboard) { const cs = Math.atan2(p.x, -p.z) / DEG; if (Math.abs(cs) < P.scoreboard.spray[1] + 6) c.clutter += 0.8; }
    // sight lines to what the shot must show
    _tg[0].copy(F.land); _tg[0].y += 3;
    sampleAt(Math.max(0, F.landT - 0.12), _tg[1]); sampleAt(Math.max(0, F.landT - 0.35), _tg[2]); sampleAt(Math.max(0, F.landT - 0.7), _tg[3]);
    _tg[4].copy(F.apex); _tg[5].set(0, 6, -60);
    for (let i = 0; i < 6; i++) {
      tv.subVectors(_tg[i], p); const d = tv.length(); if (d < 4) continue; tv.divideScalar(d);
      if (occ.raycast(p.x, p.y, p.z, tv.x, tv.y, tv.z, d - 2.5) < Infinity) c.occl += _tw[i];
    }
    // in-frame clutter: 7×4 probes; a hit much nearer than the park surface model = structure in the lens
    // the fov this shot will actually render with at landing (see homerPose)
    let fov = c.fov;
    if (c.kind === 'reverse') {
      fitPts[0].copy(F.land); fitPts[1].copy(INFIELD); fitPts[2].copy(ringTw); fitPts[3].copy(F.land);
      const need = fitFov(p, c.look, fitPts, 1.12);
      if (need > 80) c.occl += 1.5;                 // can't frame landing + field together from here
      fov = clamp(need, c.fov, 80);
    }
    else { fitPts[0].copy(F.start); fitPts[1].copy(F.apex); fitPts[2].copy(F.land); fitPts[3].copy(F.land); fov = clamp(fitFov(p, c.look, fitPts, 1.18), 22, 64); }
    const pr = probeFrame(p, c.look, fov, true);
    c.clutter += pr.clutter; c.field = pr.field;
    if (pr.field < 5) c.clutter += 0.6 + (5 - pr.field) * 0.1;   // weak framing: not enough field in the shot
    // mid-swoop: the orbit passes through the park on its way here — frame + proximity at two phases
    for (const u of [0.55, 0.8]) {
      orbitSample(c, u, _op, _ol);
      c.clutter += 0.75 * probeFrame(_op, _ol, c.fov, false, ROWS_MID).clutter;
      for (let a = 0; a < 6; a++) {       // anything within 40 ft of the lens (tower, lamp bank, roof edge)
        const dx = a === 0 ? 1 : a === 1 ? -1 : 0, dy = a === 2 ? 1 : a === 3 ? -1 : 0, dz = a === 4 ? 1 : a === 5 ? -1 : 0;
        const t = occ.raycast(_op.x, _op.y, _op.z, dx, dy, dz, 40);
        if (t < Infinity && (dy >= 0 || t < (_op.y - modelHeight(_op.x, _op.z)) - 8)) c.clutter += 0.35;
      }
    }
    return (c.score = c.occl + c.clutter + c.bias);
  }
  function blimpPos(out) { tw.copy(F.land).multiplyScalar(0.5); return out.set(tw.x + sgn * 45, 470, tw.z + 210); }
  function initHomer() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const k = shapeK();
    const preferBlimp = !opts.shot && homerCount % 3 === 2;
    shot = opts.shot || (preferBlimp ? 'blimp' : 'reverse');
    homerCount++;
    let side = F.spray > 3 ? 1 : F.spray < -3 ? -1 : (sgn > 0 ? -1 : 1);
    if (Math.abs(F.spray) > 24) side = -Math.sign(F.spray);
    const revFov = lerp(56, 44, k), blimpFov = lerp(46, 36, k);
    lastPick = null;
    if (opts.occluders && opts.occluders !== occluders) occ = occluderGrid(THREE, opts.occluders);
    if (occ && !opts.shot) {
      if (!occ.ready) { let g = 0; while (!occ.step(1e9) && g++ < 10); }
      ringTw.set(F.land.x * 0.35, 18, F.land.z * 0.35);
      let n = 0;
      const add = (name, kind, bias, fov) => { const c = cand[n++]; c.name = name; c.kind = kind; c.bias = bias; c.fov = fov; return c; };
      const revLook = c => reverseFrame(c.pos, F.land, c.look);
      if (preferBlimp) { const c = add('blimp', 'blimp', -0.2, blimpFov); blimpPos(c.pos); c.look.copy(F.land).multiplyScalar(0.5); c.look.y = 0; }
      let c;
      c = add('reverse', 'reverse', 0, revFov); reversePos(c.pos, side, 0, 0, 60, false); revLook(c);
      c = add('reverse-alt', 'reverse', 0.1, revFov); reversePos(c.pos, -side, 0, 0, 60, false); revLook(c);
      c = add('reverse-high', 'reverse', 0.2, revFov); reversePos(c.pos, side, 15, 70, 60, false); revLook(c);
      c = add('reverse-alt-high', 'reverse', 0.3, revFov); reversePos(c.pos, -side, 15, 70, 60, false); revLook(c);
      c = add('reverse-far', 'reverse', 0.35, revFov); reversePos(c.pos, side * 0.5, 75, 140, 60, false); revLook(c);
      c = add('seats', 'reverse', 0.4, revFov); reversePos(c.pos, side, 0, 0, 40, true); revLook(c);
      c = add('seats-alt', 'reverse', 0.5, revFov); reversePos(c.pos, -side, 0, 0, 40, true); revLook(c);
      if (!preferBlimp) { c = add('blimp', 'blimp', 0.45, blimpFov); blimpPos(c.pos); c.look.copy(F.land).multiplyScalar(0.5); c.look.y = 0; }
      let best = null, evald = 0;
      for (let i = 0; i < n; i++) {
        const sc = scoreCandidate(cand[i]); evald = i + 1;
        if (!best || sc < best.score) best = cand[i];
        if (cand[i].valid && cand[i].occl === 0 && cand[i].clutter === 0) break;   // clean → take it (ordered by preference)
      }
      lastPick = { name: best.name, score: +best.score.toFixed(2), occl: best.occl, clutter: +best.clutter.toFixed(1), tried: cand.slice(0, evald).map(q => q.name + ':' + (q.valid ? q.score.toFixed(1) : 'X')).join(' '), ms: +((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(1) };
      shot = best.kind; H.pos.copy(best.pos); H.fov = best.fov; arcH = shot === 'reverse' ? 60 : 0;
      return;
    }
    if (shot === 'reverse') {
      // beyond the landing spot, off toward the foul-line side (keeps the CF board out of
      // the lens) unless the ball is near a line — then toward centre, away from the grandstands
      reversePos(H.pos, side, 0, 0, 60, false);
      H.fov = revFov;
      arcH = 60;
    } else { // blimp: high above, looking down the whole arc
      blimpPos(H.pos);
      H.fov = blimpFov;
      arcH = 0;
    }
  }
  const INFIELD = new THREE.Vector3(0, 4, -75);
  /** reverse-shot aim: between the subject (ball / landing) and the infield, biased to the subject */
  function reverseFrame(pos, subject, out) {
    ringTw.set(F.land.x * 0.35, 18, F.land.z * 0.35);
    return out.copy(subject).multiplyScalar(0.55).addScaledVector(INFIELD, 0.25).addScaledVector(ringTw, 0.2);
  }
  function homerPose(o, t, dt) {
    const B = currentBall(dt);
    const landed = F.clock >= F.landT - 0.02;
    o.pos.copy(H.pos);
    // slow drift for life
    o.pos.x += Math.sin(t * 0.3) * 3; o.pos.y += Math.sin(t * 0.23) * 2;
    if (shot === 'reverse') {
      // look back toward home: the ball flying in at us, the landing spot AND the field in frame
      reverseFrame(o.pos, landed ? F.land : B, o.look);
      fitPts[0].copy(B); fitPts[1].copy(F.land); fitPts[2].copy(INFIELD); fitPts[3].copy(ringTw);
      o.fov = clamp(fitFov(o.pos, o.look, fitPts, 1.12), H.fov, 80);
    } else {
      // blimp: fit the whole arc (contact → apex → landing) plus the live ball
      fitPts[0].copy(F.start); fitPts[1].copy(F.apex); fitPts[2].copy(F.land); fitPts[3].copy(B);
      o.look.copy(F.start).add(F.land).multiplyScalar(0.5).lerp(B, 0.2); o.look.y *= 0.4;
      o.fov = clamp(fitFov(o.pos, o.look, fitPts, 1.18), 22, 64);
    }
    keepInFrame(o, B, 0.8);
  }

  // ============================================================ OUT OF THE PARK
  // Three broadcast shots cut together on the ball's own clock (ballTrack.tau), each
  // placement validated against the occluder grid + the analytic park surface:
  //   CHASE  trail the ball (behind + above + off-axis) over the ivy and the bleachers
  //   CATCH  beyond the bleachers at street / rooftop / parking-lot level, looking back up
  //          as the ball clears the back row (slow-mo), then down to the bounce (impact)
  //   WIDE   high reverse angle from beyond the landing back at the ballpark (identifiable:
  //          bleachers, scoreboard / big board, light towers, rooftops) while the booth calls it
  const O = {
    on: false, stage: '', stageT: 0, stageReal: 0, cut: false, kind: 'street', tFence: 0, tBack: 0, tLand: 0, tEnd: 0, tDrop: 0,
    rBack: 0, fr: 400, chase: { d: 58, h: 20, s: 12 }, catchPos: V(), widePos: V(), wideLook: V(), side: 1, ts: 1, slowAcc: 0,
    cued: {}, landedAt: -1, plan: {}, lb: 0, restSeen: false, planned: null, plannedTau: 0, tSee: 0,
  };
  const _qa1 = V(), _qb1 = V(), _qc1 = V(), _qd1 = V(), _qe1 = V();
  const polar = (out, sprayDeg, r, y) => { const s = sprayDeg * DEG; return out.set(Math.sin(s) * r, y, -Math.cos(s) * r); };
  const sprayOf = v => Math.atan2(v.x, -v.z) / DEG;
  const radOf = v => Math.hypot(v.x, v.z);
  /** analytic resting surface (data.js) incl. the area beyond the foul lines (0) */
  function surfAt(x, z) {
    if (z > 0) return 0;
    const s = Math.atan2(x, -z) / DEG; if (Math.abs(s) > 47) return 0;
    return surfaceHeight(parkId, clamp(s, -45, 45), Math.hypot(x, z));
  }
  function tauAtRadius(R) {
    const pts = F.pts; if (!pts) return F.landT;
    for (let i = 0; i < F.n; i++) { const o = i * 4; if (Math.hypot(pts[o + 1], pts[o + 3]) >= R) return pts[o]; }
    return F.landT;
  }
  function tauDropBelow(y, after) {       // first tau after `after`, descending, with ball.y < y
    const pts = F.pts; if (!pts) return F.landT;
    for (let i = 1; i < F.n; i++) { const o = i * 4; if (pts[o] > after && pts[o + 2] < y && pts[o + 2] < pts[o - 2]) return pts[o]; }
    return F.landT;
  }
  /** clear of geometry: above the surface and nothing within `r` along the 6 axes (+ up to 30) */
  function clearAt(p, r = 5) {
    if (p.y < surfAt(p.x, p.z) + 3.5) return false;
    if (!occ || !occ.ready) return true;
    if (occ.raycast(p.x, p.y, p.z, 0, 1, 0, 12) < Infinity) return false;            // tucked under a deck / board / roof
    const D = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
    for (const d of D) if (occ.raycast(p.x, p.y, p.z, d[0], d[1], d[2], r) < Infinity) return false;
    return true;
  }
  /** line of sight a → b (ignores the last `slack` ft) */
  function los(a, b, slack = 2.5) {
    if (!occ || !occ.ready) return true;
    tv.subVectors(b, a); const d = tv.length(); if (d < 1) return true; tv.divideScalar(d);
    return occ.raycast(a.x, a.y, a.z, tv.x, tv.y, tv.z, d - slack) === Infinity && modelHitT(a.x, a.y, a.z, tv.x, tv.y, tv.z, d - slack, 4) === Infinity;
  }
  /** how cluttered / blocked a view is: structure in the lens + a blocked centre line */
  function viewPenalty(p, look, fov) {
    if (!occ || !occ.ready) return 0;
    _pf.subVectors(look, p); const d = Math.max(1, _pf.length()); _pf.divideScalar(d);
    _pr.crossVectors(_pf, up); if (_pr.lengthSq() < 1e-6) _pr.set(1, 0, 0); _pr.normalize(); _pu.crossVectors(_pr, _pf);
    const tv2 = Math.tan((fov * DEG) / 2), th2 = tv2 * aspect;
    let pen = 0, cover = 0;
    const lim = Math.min(0.5 * d, 160);
    for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 5; ix++) {
      tv.copy(_pf).addScaledVector(_pr, (-0.8 + ix * 0.4) * th2).addScaledVector(_pu, (-0.75 + iy * 0.5) * tv2).normalize();
      const t = occ.raycast(p.x, p.y, p.z, tv.x, tv.y, tv.z, lim);
      if (t < 45) pen += (1 - t / 45) * 0.3;               // something big right in front of the lens
      if (t < lim && tv.y > -0.25) cover++;                // foreground mass between us and the subject (ground excluded)
    }
    const fc = cover / 20;
    if (fc > 0.3) pen += 4 * (fc - 0.3);
    const hit = occ.raycast(p.x, p.y, p.z, _pf.x, _pf.y, _pf.z, Math.min(d, 400));
    if (hit < 70) pen += 2 * (1 - hit / 70) + 0.5;
    return pen;
  }
  function flightDir(tau, outV) {        // horizontal unit direction of travel at tau
    sampleAt(tau, _qa1); sampleAt(tau + 0.12, _qb1);
    outV.set(_qb1.x - _qa1.x, 0, _qb1.z - _qa1.z);
    if (outV.lengthSq() < 1e-6) outV.set(F.land.x - F.start.x, 0, F.land.z - F.start.z);
    return outV.normalize();
  }
  function chasePos(tau, B, c, outV) {   // camera for the chase at ball position B
    flightDir(tau, _qc1);
    _qd1.set(-_qc1.z, 0, _qc1.x);           // right of travel
    outV.copy(B).addScaledVector(_qc1, -c.d).addScaledVector(_qd1, c.s * O.side);
    outV.y = B.y + c.h;
    const floor = surfAt(outV.x, outV.z) + 14; if (outV.y < floor) outV.y = floor;
    return outV;
  }
  function planChase(tau0) {
    const opts2 = [{ d: 62, h: 9, s: 15 }, { d: 58, h: 16, s: -16 }, { d: 66, h: 26, s: 18 }, { d: 72, h: 40, s: -12 }, { d: 84, h: 64, s: 0 }];
    const t1 = Math.max(tau0 + 0.1, O.tBack);
    let best = opts2[opts2.length - 1], bestBad = 1e9;
    for (const c of opts2) {
      let bad = 0, prev = null;
      for (let i = 0; i <= 10; i++) {
        const tau = lerp(tau0, t1, i / 10); sampleAt(tau, _qe1);
        const p = chasePos(tau, _qe1, c, V());
        if (!clearAt(p, 4)) bad += 3;
        if (!los(p, _qe1, 1.5)) bad += 1;
        if (prev && occ && occ.ready) { tv.subVectors(p, prev); const d = tv.length(); if (d > 0.5) { tv.divideScalar(d); if (occ.raycast(prev.x, prev.y, prev.z, tv.x, tv.y, tv.z, d) < Infinity) bad += 4; } }
        prev = p;
      }
      if (bad < bestBad) { bestBad = bad; best = c; }
      if (bad === 0) break;
    }
    O.chase = { ...best }; O.plan.chase = { ...best, bad: bestBad };
  }
  function planCatch() {
    const L = F.land, s = clamp(sprayOf(L), -60, 60) * DEG;
    const out = V().set(Math.sin(s), 0, -Math.cos(s)), tan = V().set(Math.cos(s), 0, Math.sin(s));
    const roofY = (P.rooftops ? P.rooftops.h : 40) + 8;
    sampleAt(O.tBack, _qa1); const overTop = _qa1.clone();
    sampleAt(lerp(O.tBack, O.tLand, 0.55), _qb1); const mid = _qb1.clone();
    sampleAt(Math.max(0, O.tLand - 0.25), _qc1); const late = _qc1.clone();
    const tgtL = L.clone(); tgtL.y += 2.5;
    const toPark = V().subVectors(overTop, L).setY(0).normalize();     // where the ball comes in from
    const cands = [];
    // along the street / roof row (both ways), a little toward the far curb, eye level over the ballhawks;
    // plus a couple of looser "across" angles as fallbacks
    // ring radius of the lane the camera should stand in at spray `sd` (street centre / roof row / lot)
    const laneR = sd => {
      const fr = fenceDistance(parkId, clamp(sd, -45, 45)), b = fr + P.stands.depth;
      if (O.kind === 'roof') return b + P.street.width + (P.rooftops ? P.rooftops.depth * 0.3 : 20);
      if (O.kind === 'lot') return Math.max(radOf(L), b + P.street.width + 30);
      return b + P.street.width * 0.5;
    };
    const sL = sprayOf(L), rLand = radOf(L);
    for (const [lat, off, dist, hy] of [[1, 4, 118, 9], [-1, 4, 118, 9], [1, 0, 150, 11], [-1, 0, 150, 11], [1, 8, 92, 8], [-1, 8, 92, 8],
      [1, -6, 130, 14], [-1, -6, 130, 14], [0.5, 0, 110, 16], [-0.5, 0, 110, 16], [1, 0, 180, 18], [-1, 0, 180, 18]]) {
      const sd = sL + lat * (dist / Math.max(rLand, 200)) / DEG;           // arc-length offset along the lane
      const r = laneR(sd) + off;
      const p = V(); polar(p, sd, r, 0);
      if (Math.abs(lat) < 1) p.addScaledVector(out, 25);
      p.y = O.kind === 'roof' ? Math.max(roofY, surfAt(p.x, p.z) + 6) : surfAt(p.x, p.z) + hy;
      cands.push({ p, lat, fwd: off, dist, extra: 0 });
      if (Math.abs(lat) >= 1 && dist <= 150) { const q = p.clone(); q.y += 38; cands.push({ p: q, lat, fwd: off, dist, extra: 0.9 }); }   // "cherry-picker" height
    }
    let best = null;
    const dbg = [];
    for (const c of cands) {
      let sc = 0; const why = [];
      if (!clearAt(c.p, 4)) { c.score = 1e3; dbg.push([c.p.toArray().map(Math.round), 'X']); continue; }
      if (!los(c.p, tgtL)) { sc += 4; why.push('L'); }
      let vis = 0;
      for (let i = 0; i < 7; i++) { sampleAt(lerp(O.tBack - 0.15, O.tLand - 0.05, i / 6), _qe1); if (los(c.p, _qe1, 1)) vis++; }
      sc += 6 * (1 - vis / 7); if (vis < 7) why.push('v' + vis);
      // framing: the fall (overTop → landing) should fit a sane lens from here
      fitPts[0].copy(overTop); fitPts[1].copy(tgtL); fitPts[2].copy(mid); fitPts[3].copy(late);
      _qd1.copy(mid).lerp(tgtL, 0.5);
      const need = fitFov(c.p, _qd1, fitPts, 1.2);
      if (need > 75) { sc += 2; why.push('F'); } else if (need > 62) { sc += 0.6; why.push('f'); }
      const v1 = viewPenalty(c.p, _qd1, clamp(need, 36, 70)); sc += v1;
      _qe1.copy(overTop).lerp(mid, 0.5); const v2 = 0.5 * viewPenalty(c.p, _qe1, 50); sc += v2;
      // the ball should come in across / toward the lens, not straight away from it
      tv.subVectors(c.p, L).setY(0).normalize();
      sc += 0.6 * clamp(-tv.dot(toPark), 0, 1);
      c.score = sc + c.dist * 0.001 + (c.extra || 0);
      dbg.push([c.p.toArray().map(Math.round), +c.score.toFixed(2), why.join('') + ' v' + v1.toFixed(1) + '/' + v2.toFixed(1)]);
      if (!best || c.score < best.score) best = c;
    }
    O.plan.catchCands = dbg;
    if (!best || best.score >= 1e3) { const p = V().copy(L).addScaledVector(tan, 110); p.y = Math.max(O.kind === 'roof' ? roofY : 0, surfAt(p.x, p.z)) + 10; best = { p, score: 99, lat: 1 }; }
    O.catchPos.copy(best.p); O.plan.catch = { pos: best.p.toArray().map(Math.round), score: +best.score.toFixed(2) };
    O.tSee = O.tLand;
    for (let tt = O.tBack - 0.3; tt < O.tLand; tt += 0.05) { sampleAt(tt, _qe1); if (los(best.p, _qe1, 1)) { O.tSee = tt; break; } }
    O.side = best.lat != null && best.lat < 0 ? -1 : 1;
  }
  function planWide() {
    const L = F.land, s = clamp(sprayOf(L), -60, 60) * DEG;
    const out = V().set(Math.sin(s), 0, -Math.cos(s)), tan = V().set(Math.cos(s), 0, Math.sin(s));
    const look = V(); polar(look, clamp(sprayOf(L) * 0.6, -30, 30), O.fr * 0.55, 18);
    look.lerp(L, 0.25);
    let best = null;
    for (const [lat, fwd, h] of [[0.6, 90, 165], [-0.6, 90, 165], [1, 60, 135], [-1, 60, 135], [0.35, 140, 200], [-0.35, 140, 200], [1, 30, 110], [-1, 30, 110], [0, 190, 240]]) {
      const p = V().copy(L).addScaledVector(tan, lat * 70 * O.side).addScaledVector(out, fwd);
      p.y = Math.max(h, surfAt(p.x, p.z) + 30);
      let sc = 0;
      if (!clearAt(p, 6)) continue;
      if (!los(p, L)) sc += 3;
      if (!los(p, look)) sc += 1.2;
      polar(_qa1, 0, O.fr * 0.45, 4); if (!los(p, _qa1)) sc += 0.8;       // a slice of the infield: it's the ballpark
      sc += Math.abs(lat) < 0.2 ? 0.4 : 0;                                  // edge-on arc reads as a line
      sc += viewPenalty(p, look, 52);
      sc += fwd * 0.002;
      if (!best || sc < best.sc) best = { p, sc };
    }
    if (!best) { const p = V().copy(L).addScaledVector(out, 60); p.y = 140; best = { p, sc: 99 }; }
    O.widePos.copy(best.p); O.wideLook.copy(look);
    O.plan.wide = { pos: best.p.toArray().map(Math.round), score: +best.sc.toFixed(2) };
  }
  /** the expensive part (occluder raycasts, ~5-20 ms): done at contact, inside the hit-stop, when possible */
  function planOOP(res, tauEst) {
    if (occ && !occ.ready) { let g = 0; while (!occ.step(1e9) && g++ < 10); }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    O.plan = {};
    const bonus = res?.bonus || null;
    O.kind = parkId === 'rate' ? 'lot' : bonus === 'rooftop' ? 'roof' : bonus === 'over_cf' ? 'board' : 'street';
    const sL = clamp(F.spray, -45, 45);
    O.fr = fenceDistance(parkId, sL);
    O.rBack = O.fr + P.stands.depth;
    O.tFence = res?.path?.fenceT ?? tauAtRadius(O.fr);
    O.tBack = Math.min(tauAtRadius(O.rBack), F.landT - 0.2);
    O.tLand = F.landT; O.tEnd = F.endT;
    O.tDrop = Math.min(O.tLand - 0.45, Math.max(O.tBack + 0.5, tauDropBelow((parkId === 'rate' ? 60 : P.stands.topH + 22), (O.tBack + O.tLand) * 0.5 - 0.5)));
    O.side = F.spray >= 0 ? -1 : 1;
    planCatch();
    planChase(Math.max(0, tauEst));
    planWide();
    O.plan.ms = +(((typeof performance !== 'undefined' ? performance.now() : 0) - t0)).toFixed(1);
    O.plan.kind = O.kind;
    O.planned = res; O.plannedTau = tauEst;
  }
  function initOOP() {
    const res = opts.result || F.result;
    if (res && res !== F.result) initFollow(res);
    if (opts.occluders && opts.occluders !== occluders && !occ) occ = occluderGrid(THREE, opts.occluders);
    O.on = true; O.cued = {}; O.landedAt = -1; O.slowAcc = 0; O.ts = 1; O.restSeen = false;
    const tau = ballTrack.live && ballTrack.stamp !== F.stamp0 ? ballTrack.tau : F.clock;
    if (O.planned !== res || Math.abs(O.plannedTau - tau) > 0.8) planOOP(res, tau);
    else O.plan.cached = true;
    O.plan.t = { see: +O.tSee.toFixed(2), fence: +O.tFence.toFixed(2), back: +O.tBack.toFixed(2), drop: +O.tDrop.toFixed(2), land: +O.tLand.toFixed(2), end: +O.tEnd.toFixed(2), now: +tau.toFixed(2) };
    O.stage = '';
    goStage(tau < Math.max(O.tBack - 0.6, O.tSee - 0.5) ? 'chase' : 'catch', false);
  }
  function goStage(st, cut = true) {
    if (O.stage === st) return;
    O.stage = st; O.stageT = 0; O.stageReal = 0; O.cut = cut;
    if (st === 'catch') cue('overTheTop');
    if (st === 'wide') cue('reverse');
  }
  function cue(name, info) {
    if (O.cued[name]) return; O.cued[name] = true;
    try { opts.onCue && opts.onCue(name, info || { stage: O.stage, kind: O.kind, landing: F.land.toArray() }); } catch (e) { console.warn('[camera] onCue', e); }
  }
  function oopPose(o, t, dt) {
    const B = currentBall(dt);
    const tau = F.clock;
    O.stageT += dt; O.stageReal += dt;
    if (tau >= O.tFence) cue('overTheWall');
    // ---- stage transitions
    if (O.stage === 'chase' && tau >= Math.min(O.tLand - 0.5, Math.max(O.tBack - 0.18, O.tSee - 0.06))) goStage('catch');
    if (O.stage === 'catch') {
      if (O.landedAt < 0 && tau >= O.tLand - 0.02) { O.landedAt = O.stageReal; cue('landing', { stage: 'catch', kind: O.kind, landing: F.land.toArray() }); cinemaPost.flash = Math.max(cinemaPost.flash, 0.18); cinemaPost.aberr = Math.max(cinemaPost.aberr, 0.8); trauma = Math.min(1, trauma + 0.35); }
      const settled = ballTrack.landed && ballTrack.stamp === O.lastStamp; O.lastStamp = ballTrack.stamp;
      if (O.landedAt >= 0 && (O.stageReal - O.landedAt > 1.35 || (settled && O.stageReal - O.landedAt > 0.8))) goStage('wide');
      if (O.stageReal > 9) goStage('wide');
    }
    // ---- time-scale hint (slow-mo while the ball clears the back row, capped at 1.7 s real)
    let ts = 1;
    if (O.stage === 'chase') ts = tau > O.tBack - 0.9 ? 0.75 : 1;
    else if (O.stage === 'catch' && O.landedAt < 0) {
      if (tau < Math.max(O.tDrop, O.tSee + 0.45) && O.slowAcc < 1.7) { ts = 0.32; O.slowAcc += dt; }
      else ts = tau < O.tLand ? 0.7 : 1;
    }
    O.ts += (ts - O.ts) * (1 - Math.exp(-dt * 7));
    // ---- poses
    const base = fovFor(aspect);
    if (O.stage === 'chase') {
      chasePos(tau, B, O.chase, o.pos);
      flightDir(tau, _qc1);
      // look ahead of the ball toward where it's going (the bleachers + street beyond)
      o.look.copy(B).addScaledVector(_qc1, 150); o.look.y = Math.max(F.land.y + 10, B.y * 0.62 - 6);
      fitPts[0].copy(B); fitPts[1].copy(B); fitPts[2].copy(F.land); fitPts[3].copy(F.land);
      o.fov = clamp(fitFov(o.pos, o.look, fitPts, 1.2), base * 0.78, base + 8);
    } else if (O.stage === 'catch') {
      o.pos.copy(O.catchPos);
      o.pos.x += Math.sin(t * 0.8) * 0.35; o.pos.y += Math.sin(t * 1.1) * 0.25;
      // ball-first while it's in the air, then settle toward the landing / roll
      const w = O.landedAt >= 0 ? 0.25 : smooth(O.tBack, O.tLand, tau) * 0.45;
      o.look.copy(B).lerp(F.land, w);
      fitPts[0].copy(B); fitPts[1].copy(F.land); fitPts[2].copy(F.land); fitPts[2].y += 8; fitPts[3].copy(B);
      o.fov = clamp(fitFov(o.pos, o.look, fitPts, O.landedAt >= 0 ? 1.7 : 1.25), O.landedAt >= 0 ? 40 : 30, 70);
    } else {
      // wide reverse: slow push + drift, the park behind the resting ball
      const u = Math.min(1, O.stageReal / 5);
      o.pos.copy(O.widePos).lerp(O.wideLook, 0.1 * u);
      o.pos.x += Math.sin(t * 0.25) * 3; o.pos.y += Math.sin(t * 0.3) * 1.5;
      o.look.copy(O.wideLook).lerp(B, 0.18);
      fitPts[0].copy(B); fitPts[1].copy(O.wideLook); fitPts[2].copy(F.land); fitPts[3].copy(O.wideLook);
      o.fov = clamp(fitFov(o.pos, o.look, fitPts, 1.35), 34, 64);
    }
  }

  // ============================================================ WAVE (crowd sweep)
  function wavePose(o, t) {
    const dur = opts.dur || 2.6;
    const u = clamp(modeT / dur, 0, 1), e = u * u * (3 - 2 * u);
    const dirS = (opts.fromSpray ?? 0) > 0 ? 1 : -1;        // start where the wave starts
    const k = shapeK();
    const a = lerp(dirS * 78, -dirS * 64, e) * DEG;           // 0 = behind home plate
    const R = lerp(150, 175, k);
    // camera over the infield grass, counter-arcing slightly for parallax
    o.pos.set(-Math.sin(a) * 26, lerp(30, 36, k) + 4 * Math.sin(Math.PI * u), -112 - Math.cos(a) * 12);
    o.look.set(Math.sin(a) * R, 26, Math.cos(a) * R * 0.78);
    o.fov = clamp(fovFor(aspect) * lerp(0.92, 0.8, k), 34, 60);
  }

  // ============================================================ BOOTH push-in
  function boothPose(o, t) {
    const bp = opts.pos || (P.booth && P.booth.pos) || [0, 50, 92];
    const bl = opts.look || (P.booth && P.booth.look) || [0, 10, -60];
    _qa1.set(bp[0], bp[1], bp[2]); _qb1.set(bl[0], bl[1], bl[2]).sub(_qa1).setY(0).normalize();
    const u = clamp(modeT / (opts.dur || 2.4), 0, 1), e = 1 - Math.pow(1 - u, 3);
    const d = lerp(115, 44, e);
    o.pos.copy(_qa1).addScaledVector(_qb1, d);
    o.pos.x += lerp(18, 3, e) * (sgn > 0 ? -1 : 1);
    o.pos.y = _qa1.y + lerp(4, 0.5, e) + Math.sin(t * 1.2) * 0.2;
    o.look.copy(_qa1); o.look.y += 1.5;
    o.fov = lerp(44, 33, e);
  }

  // ------------------------------------------------------------ API
  function setMode(m, o = {}) {
    if (!['title', 'select', 'batting', 'follow', 'homer', 'result', 'outOfPark', 'wave', 'booth'].includes(m)) m = 'batting';
    const prev = mode;
    mode = m; opts = o || {}; modeT = 0;
    if (m !== 'outOfPark') { O.on = false; O.ts = 1; }
    from.pos.copy(out.pos); from.look.copy(out.look); from.fov = out.fov;
    smInit = false; blend = 0; arcH = 0; orbit.on = false;
    switch (m) {
      case 'title': blendDur = prev === 'title' ? 0.01 : 1.6; rates.pos = 2; rates.look = 2; break;
      case 'select': blendDur = 1.4; rates.pos = 3; rates.look = 3; break;
      case 'batting': blendDur = (prev === 'follow' || prev === 'homer') ? 1.0 : prev === 'batting' ? 0.5 : 1.5; rates.pos = 5; rates.look = 5; break;
      case 'follow':
        if (o.result) initFollow(o.result);
        // out of the park: pre-plan the whole sequence now (contact / hit-stop) instead of mid-flight
        if (o.result && o.result.outOfPark && o.result.path && o.result.path.pts) {
          try { const fT = o.result.path.fenceT ?? F.landT * 0.7; planOOP(o.result, Math.max(0.9, fT - 1.3)); } catch (e) { console.warn('[camera] oop plan', e); }
        }
        blendDur = 0.55; rates.pos = 6; rates.look = F.kind === 'foul' ? 3.5 : 12; rates.fov = 4; break;
      case 'homer':
        if (o.result && o.result !== F.result) initFollow(o.result);
        initHomer();
        orbit.on = true; orbit.a.subVectors(out.pos, F.ball); orbit.d0 = orbit.a.length(); orbit.a.normalize();
        blendDur = shot === 'reverse' ? 0.95 : 0.95; rates.pos = 8; rates.look = 16; rates.fov = 6; break;
      case 'result': blendDur = 2.0; rates.pos = 2; rates.look = 2; break;
      case 'outOfPark':
        initOOP();
        blendDur = prev === 'follow' || prev === 'homer' ? 0.6 : 0.001; rates.pos = 9; rates.look = 14; rates.fov = 6; break;
      case 'wave': blendDur = prev === 'batting' ? 0.45 : 0.3; rates.pos = 6; rates.look = 6; rates.fov = 4; break;
      case 'booth': blendDur = 0.001; rates.pos = 5; rates.look = 8; rates.fov = 4; break;
      default: break;
    }
    if (opts.instant) blendDur = 0.001;
  }

  function follow(result) { setMode('follow', { result }); }

  function shake(amount = 0.5) { trauma = clamp(trauma + amount, 0, 1); }

  function computeRaw(t, dt) {
    switch (mode) {
      case 'title': titlePose(raw, t); break;
      case 'select': selectPose(raw, t); break;
      case 'follow': followPose(raw, t, dt); break;
      case 'homer': homerPose(raw, t, dt); break;
      case 'result': resultPose(raw, t); break;
      case 'outOfPark': oopPose(raw, t, dt); break;
      case 'wave': wavePose(raw, t); break;
      case 'booth': boothPose(raw, t); break;
      default: battingPose(raw, t);
    }
  }

  const shakeOff = V(), right = V(), camUp = V();
  function update(dt = 1 / 60, t) {
    dt = clamp(dt, 0, 0.1); lastDt = Math.max(dt, 1e-4);
    if (occ && !occ.ready) occ.step(5000);
    time = t != null ? t : time + dt;
    modeT += dt;
    computeRaw(time, dt);
    if (O.on && O.cut) {   // hard broadcast cut inside the out-of-park sequence
      O.cut = false; smInit = false; blend = 1; orbit.on = false; arcH = 0;
      from.pos.copy(raw.pos); from.look.copy(raw.look); from.fov = raw.fov;
    }
    if (!smInit) { sm.pos.copy(raw.pos); sm.look.copy(raw.look); sm.fov = raw.fov; smInit = true; }
    else {
      sm.pos.lerp(raw.pos, 1 - Math.exp(-dt * rates.pos));
      sm.look.lerp(raw.look, 1 - Math.exp(-dt * rates.look));
      sm.fov = lerp(sm.fov, raw.fov, 1 - Math.exp(-dt * rates.fov));
    }
    blend = Math.min(1, blend + dt / Math.max(blendDur, 1e-3));
    const k = orbit.on ? blend * blend * (3 - 2 * blend) : easeIO(blend);
    if (orbit.on && blend < 1) {
      // orbit around the live ball: start offset → (over the top) → final offset
      const B = F.ball;
      orbit.b.subVectors(sm.pos, B); const d1 = orbit.b.length(); orbit.b.normalize();
      // sideways midpoint (a horizontal drone orbit), slightly raised
      _ov.copy(orbit.a).setY(0); tu.set(-_ov.z, 0, _ov.x); if (tu.dot(orbit.b) < 0) tu.negate();
      orbit.m.copy(orbit.a).add(orbit.b).setY(0).addScaledVector(tu.normalize(), 0.9).normalize();
      orbit.m.y = 0.35 * (orbit.a.y + orbit.b.y) + 0.12; orbit.m.normalize();
      if (k < 0.5) { _qa.setFromUnitVectors(orbit.a, orbit.m); orbit.q.identity().slerp(_qa, k * 2); _ov.copy(orbit.a).applyQuaternion(orbit.q); }
      else { _qb.setFromUnitVectors(orbit.m, orbit.b); orbit.q.identity().slerp(_qb, k * 2 - 1); _ov.copy(orbit.m).applyQuaternion(orbit.q); }
      out.pos.copy(B).addScaledVector(_ov, lerp(orbit.d0, d1, k));
      // clearance arc: stay above grandstand roofs / light towers mid-orbit
      out.pos.y = Math.max(out.pos.y, lerp(from.pos.y, sm.pos.y, k), 175 * Math.pow(Math.sin(Math.PI * k), 0.6));
      out.look.copy(B).lerp(sm.look, k * k);
      out.fov = lerp(from.fov, sm.fov, k);
    } else {
      out.pos.copy(from.pos).lerp(sm.pos, k);
      if (arcH > 0 && blend < 1) out.pos.y += Math.sin(Math.PI * k) * arcH;
      out.look.copy(from.look).lerp(sm.look, k);
      out.fov = lerp(from.fov, sm.fov, k);
    }
    if ((mode === 'follow' || mode === 'homer') && F.pts) keepInFrame(out, F.ball, F.kind === 'foul' ? 0.94 : 0.86);
    if (mode === 'outOfPark' && F.pts && O.stage !== 'wide') keepInFrame(out, F.ball, O.stage === 'chase' ? 0.7 : 0.8);
    // never let a blend or drift carry the lens into the park surface
    { const floor = surfAt(out.pos.x, out.pos.z) + 2.5; if (out.pos.y < floor) out.pos.y = floor; }
    // cinematic post: letterbox for the big moments, replay tint while slowed, impact punches decay
    const lbT = mode === 'outOfPark' ? (aspect < 1 ? 0.07 : 0.1) : 0;
    O.lb += (lbT - O.lb) * (1 - Math.exp(-dt * (lbT > O.lb ? 5 : 3)));
    cinemaPost.letterbox = O.lb < 0.002 ? 0 : O.lb;
    cinemaPost.slowmo = mode === 'outOfPark' ? clamp((1 - O.ts) / 0.68, 0, 1) : 0;
    cinemaPost.flash = Math.max(0, cinemaPost.flash - dt * 2.5);
    cinemaPost.aberr = Math.max(0, cinemaPost.aberr - dt * 1.8);
    cinemaPost.bloomBoost = mode === 'outOfPark' ? 0.6 : mode === 'homer' ? 0.35 : 0;
    // regular homers: a short breath of slow motion as the ball clears the wall
    { const fT = F.result && F.result.path ? F.result.path.fenceT : null;
      const want = mode === 'homer' && fT != null && Math.abs(F.clock - fT) < 0.28 ? 0.7 : 1;
      HTS += (want - HTS) * (1 - Math.exp(-dt * 8)); }

    camera.position.copy(out.pos);
    camera.up.copy(up);
    camera.lookAt(out.look);
    // trauma shake: position + rotation jitter, squared falloff
    if (trauma > 0.001) {
      const s = trauma * trauma;
      const f = time * 38;
      const nx = Math.sin(f * 1.13) * 0.6 + Math.sin(f * 2.71 + 1.7) * 0.4;
      const ny = Math.sin(f * 1.37 + 0.5) * 0.6 + Math.sin(f * 2.19 + 2.3) * 0.4;
      const nr = Math.sin(f * 0.93 + 4.1) * 0.7 + Math.sin(f * 2.43) * 0.3;
      right.setFromMatrixColumn(camera.matrix, 0); camUp.setFromMatrixColumn(camera.matrix, 1);
      shakeOff.copy(right).multiplyScalar(nx * 0.35 * s).addScaledVector(camUp, ny * 0.25 * s);
      camera.position.add(shakeOff);
      camera.rotateZ(nr * 0.022 * s);
      camera.rotateX(ny * 0.012 * s);
      trauma = Math.max(0, trauma - dt * 1.7);
    }
    if (Math.abs(camera.fov - out.fov) > 1e-3) { camera.fov = out.fov; camera.updateProjectionMatrix(); }
  }

  function resize(a) {
    if (a && isFinite(a)) aspect = a;
    if (camera.aspect !== aspect && camera.isPerspectiveCamera) { camera.aspect = aspect; camera.updateProjectionMatrix(); }
  }

  // start in batting framing, eased from wherever the camera is now
  setMode('batting');
  blendDur = 1.2;

  return {
    setMode, follow, shake, update, resize, fovFor,
    /** u = pitch time / flight time while the pitch is live; null/undefined when it isn't */
    pitchProgress(u) { PT.u = u == null || !isFinite(u) ? null : u; },
    get timeScale() { return mode === 'outOfPark' ? O.ts : mode === 'homer' ? HTS : 1; },
    get shotName() { return mode === 'outOfPark' ? 'oop:' + O.stage : mode === 'homer' ? 'homer:' + shot : mode; },
    get oopPlan() { return O.plan; },
    framing: FRAMING,
    get mode() { return mode; }, get shot() { return shot; }, get pick() { return lastPick; }, __cand: () => cand.filter(c => c.name).map(c => [c.name, +(c.field ?? -1).toFixed(1), +c.clutter.toFixed(2), c.occl, c.pos.toArray().map(Math.round)]), get occluderStats() { return occ ? (occ.ready ? occ.stats : 'building') : null; },
    /** debug: current pose */ get pose() { return { pos: out.pos.toArray(), look: out.look.toArray(), fov: out.fov }; },
    /** debug: raycast the occluders from pos toward look through a 7×4 grid (fov deg) */
    debugProbe(pos, look, fov = 44, far = 400) {
      if (!occ || !occ.ready) return null;
      const p = tw.set(pos[0], pos[1], pos[2]), f = _pf.set(look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]).normalize();
      _pr.crossVectors(f, up).normalize(); _pu.crossVectors(_pr, f);
      const tv2 = Math.tan((fov * DEG) / 2), th2 = tv2 * aspect, rows = [];
      for (const sy of [0.85, 0.3, -0.3, -0.85]) { const row = []; for (let ix = 0; ix < 7; ix++) { const sx = -0.9 + ix * 0.3; tv.copy(f).addScaledVector(_pr, sx * th2).addScaledVector(_pu, sy * tv2).normalize(); const tg = occ.raycast(p.x, p.y, p.z, tv.x, tv.y, tv.z, far); const tm = modelHitT(p.x, p.y, p.z, tv.x, tv.y, tv.z, far); row.push((tg === Infinity ? '---' : Math.round(tg)) + '/' + (tm === Infinity ? '---' : Math.round(tm)) + (occ.hitDark ? 'D' : '')); } rows.push(row.join(' ')); }
      return rows;
    },
    dispose() {},
  };
}
