// ============================================================================
// WINDY CITY DERBY — DIRECTOR. Every camera move in the game.
// Owner: ACTORS.
//
//   const dir = createDirector(THREE, camera, { parkId, bats })
//   dir.setMode('title'|'select'|'batting'|'follow'|'homer'|'result', opts)
//   dir.follow(result)   // == setMode('follow', { result })
//   dir.shake(amount)    // 0..1 trauma (0.6 = sweet contact)
//   dir.update(dt, t)    // writes camera.position / quaternion / fov
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

  function battingPose(o, t) {
    const k = shapeK();
    // High catcher cam behind the batter's back shoulder. High enough that the
    // pitch lane passes well clear of the helmet; landscape pulls back + inside.
    o.pos.set(sgn * lerp(3.4, 0.9, k), lerp(13.2, 10.2, k), lerp(18, 26, k));
    o.look.set(-sgn * lerp(0.9, 1.5, k), lerp(-8, 2.4, k), -60);
    o.fov = fovFor(aspect);
    // idle drift (subtle handheld breathing)
    o.pos.x += Math.sin(t * 0.21) * 0.10 + Math.sin(t * 0.53) * 0.03;
    o.pos.y += Math.sin(t * 0.17 + 1.3) * 0.07;
    o.look.x += Math.sin(t * 0.13 + 0.4) * 0.22;
    o.look.y += Math.sin(t * 0.19) * 0.12;
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

  // ------------------------------------------------------------ API
  function setMode(m, o = {}) {
    if (!['title', 'select', 'batting', 'follow', 'homer', 'result'].includes(m)) m = 'batting';
    const prev = mode;
    mode = m; opts = o || {}; modeT = 0;
    from.pos.copy(out.pos); from.look.copy(out.look); from.fov = out.fov;
    smInit = false; blend = 0; arcH = 0; orbit.on = false;
    switch (m) {
      case 'title': blendDur = prev === 'title' ? 0.01 : 1.6; rates.pos = 2; rates.look = 2; break;
      case 'select': blendDur = 1.4; rates.pos = 3; rates.look = 3; break;
      case 'batting': blendDur = (prev === 'follow' || prev === 'homer') ? 1.0 : prev === 'batting' ? 0.5 : 1.5; rates.pos = 5; rates.look = 5; break;
      case 'follow':
        if (o.result) initFollow(o.result);
        blendDur = 0.55; rates.pos = 6; rates.look = F.kind === 'foul' ? 3.5 : 12; rates.fov = 4; break;
      case 'homer':
        if (o.result && o.result !== F.result) initFollow(o.result);
        initHomer();
        orbit.on = true; orbit.a.subVectors(out.pos, F.ball); orbit.d0 = orbit.a.length(); orbit.a.normalize();
        blendDur = shot === 'reverse' ? 0.95 : 0.95; rates.pos = 8; rates.look = 16; rates.fov = 6; break;
      case 'result': blendDur = 2.0; rates.pos = 2; rates.look = 2; break;
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
      default: battingPose(raw, t);
    }
  }

  const shakeOff = V(), right = V(), camUp = V();
  function update(dt = 1 / 60, t) {
    dt = clamp(dt, 0, 0.1);
    if (occ && !occ.ready) occ.step(5000);
    time = t != null ? t : time + dt;
    modeT += dt;
    computeRaw(time, dt);
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
