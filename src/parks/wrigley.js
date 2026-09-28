// ============================================================================
// WINDY CITY DERBY — WRIGLEY FIELD (v2).  Owner: WRIGLEY agent.
//
//   buildWrigleyStadium(THREE, { timeOfDay, weather, wind, assets, quality, assetBase? }) → Stadium
//
// Stadium API (CONTRACT-v2): attach(scene), detach(scene), update(dt,t), setBoard({...}), celebrate({...}),
//   setCrowd(level), wave({fromSpray,laps}) → s, outOfPark({spray,distance,landing,bonus}), landmarks, crowd,
//   lights, sunDir, info(), dispose(), group.
//
// Everything is procedural geometry in world FEET (home plate apex at the origin, CF = −Z) and honours
// data.js exactly: fenceDistance() (ivy wall), surfaceHeight() (bleacher treads, Waveland/Sheffield,
// rooftop roofs at rooftops.h), scoreboardDistance() (CF board face), videoBoards (LF/RF boards), wells,
// booth. Real-park reference: scratch/research/parks.md (ranked identifiers 1–8 are all built here).
//
// Optional photo textures (Higgsfield, assets/parks/wrigley/*.webp) are taken from the Assets store when the
// manifest lists them (keys wrigley_*), otherwise loaded directly from `assetBase` and swapped in when they
// arrive. Every one has a procedural fallback, so a missing file never breaks the park.
// No team names, logos, mascots or sponsor marks anywhere: ads are BLUFOX MOBILE or invented businesses.
// ============================================================================
import { PARKS, WEATHER, fenceDistance, surfaceHeight, scoreboardDistance, makeRng } from '../data.js';
import { createCrowd } from '../crowd.js';

const D2R = Math.PI / 180;
const SQ = Math.SQRT1_2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const dirXZ = s => [Math.sin(s * D2R), -Math.cos(s * D2R)];
const polar = (s, r, y = 0) => [Math.sin(s * D2R) * r, y, -Math.cos(s * D2R) * r];
const sprayOf = (x, z) => Math.atan2(x, -z) / D2R;

// Asset keys (manifest, see scratch/wrigley/manifest-add.json) → file under assets/parks/wrigley/
const WR_ASSETS = {
  wrigley_facades: 'facades.webp', wrigley_facades_win: 'facades_win.webp', wrigley_ivy: 'ivy.webp',
  wrigley_ivy_n: 'ivy_n.webp', wrigley_ivy_leaves: 'ivy_leaves.webp', wrigley_juniper: 'juniper.webp',
};

// ---------------------------------------------------------------------------
// Time-of-day / weather look
// ---------------------------------------------------------------------------
function makeLook(tod, weather) {
  const L = {
    day: {  // 1:20 pm summer game: high sun behind the 1B side of home, hard light on the scoreboard & bleachers
      keyEl: 57, keyAz: 158, keyColor: '#fff4e4', keyI: 3.05, shadowI: 1, rim: null,
      hemiSky: '#bad4f4', hemiGround: '#6e7c4c', hemiI: 0.72, envI: 0.82,
      fog: '#c6d8ea', fogD: 0.00027, lamps: 0.0, glare: 0, crowd: 1.0, crowdShade: 0.6, windows: 0, glowK: 0.0,
      skyBright: 1, skyDesat: 0, haze: '#dfe9f3', hazeAmt: 0.05, night: 0, board: 0.05, video: 1.0, string: 0, streetLamps: 0,
    },
    dusk: { // lights on, sun just gone behind the 3B grandstand, golden rim from the left
      keyEl: 58, keyAz: 172, keyColor: '#ffe8d0', keyI: 1.55, shadowI: 0.8, rim: { el: 6, az: -102, color: '#ffab5e', i: 1.7 },
      hemiSky: '#d9a07e', hemiGround: '#4a4238', hemiI: 0.56, envI: 0.55,
      fog: '#c49c8a', fogD: 0.00031, lamps: 2.4, glare: 0.62, crowd: 0.74, crowdShade: 0.5, windows: 0.65, glowK: 0.55,
      skyBright: 1, skyDesat: 0, haze: '#f0b58a', hazeAmt: 0.05, night: 0.4, board: 0.42, video: 1.25, string: 0.55, streetLamps: 0.6,
    },
    night: { // 5,700 K LED roof banks, floodlit scoreboard, glowing boards, rooftop string lights
      keyEl: 58, keyAz: 170, keyColor: '#f1f5ff', keyI: 2.15, shadowI: 0.78, rim: { el: 34, az: 24, color: '#e0e8ff', i: 0.55 },
      hemiSky: '#3d4a73', hemiGround: '#28301f', hemiI: 0.42, envI: 0.45,
      fog: '#0e1628', fogD: 0.00023, lamps: 5.0, glare: 1, crowd: 0.6, crowdShade: 0.44, windows: 1, glowK: 1.0,
      skyBright: 1, skyDesat: 0, haze: '#1a2644', hazeAmt: 0.04, night: 1, board: 0.8, video: 1.55, string: 1, streetLamps: 1,
    },
  }[tod];
  L.wet = 0; L.dry = 0;
  const W = WEATHER[weather] || WEATHER.clear;
  L.fogD = L.fogD + W.fog * (tod === 'night' ? 0.0022 : 0.0031);
  if (weather === 'overcast') {
    L.keyI *= tod === 'day' ? 0.42 : 0.8; L.shadowI *= 0.4; L.hemiI *= 1.9; L.envI *= 1.25;
    L.keyColor = '#eef1f5'; L.hemiSky = tod === 'night' ? '#39435c' : '#b7bec8';
    L.fog = tod === 'night' ? '#1a2030' : tod === 'dusk' ? '#8f8a8a' : '#b3bac2';
    L.skyDesat = 0.72; L.skyBright = 0.88; L.haze = L.fog; L.hazeAmt = 0.28; L.crowd *= 0.92;
    if (L.rim) L.rim.i *= 0.35;
  } else if (weather === 'heat') {
    L.keyColor = tod === 'night' ? '#fff0dc' : '#ffdcae'; L.keyI *= 1.08; L.hemiSky = tod === 'night' ? L.hemiSky : '#eed8b8';
    L.fog = tod === 'night' ? '#2a2430' : tod === 'dusk' ? '#e2a67e' : '#e8d4b4';
    L.hazeAmt = 0.6; L.skyDesat = 0.35; L.skyBright = 1.06; L.dry = 1; L.fogD += 0.0008; L.hemiI *= 1.1; L.haze = tod === 'night' ? '#3a2e36' : '#f8d7a8';
  } else if (weather === 'drizzle') {
    L.keyI *= tod === 'day' ? 0.34 : 0.72; L.shadowI *= 0.3; L.hemiI *= 2.05; L.envI *= 1.2;
    L.keyColor = '#ecebe6'; L.hemiSky = tod === 'night' ? '#343a4c' : '#adb0b2';
    L.fog = tod === 'night' ? '#171b25' : tod === 'dusk' ? '#716d70' : '#90969b';
    L.skyDesat = 0.85; L.skyBright = 0.72; L.haze = L.fog; L.hazeAmt = 0.42; L.wet = 1;
    L.crowd *= 0.88; if (L.rim) L.rim.i *= 0.2;
    if (tod === 'day') { L.glowK = 0.25; L.windows = 0.3; L.board = 0.2; L.lamps = 1.6; L.glare = 0.3; }
  }
  return L;
}

// ---------------------------------------------------------------------------
// canvas helpers (module cache for condition-independent textures)
// ---------------------------------------------------------------------------
const CANVAS_CACHE = new Map();
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function cached(key, fn) { if (!CANVAS_CACHE.has(key)) CANVAS_CACHE.set(key, fn()); return CANVAS_CACHE.get(key); }
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(hex, k) { const [r, g, b] = hexRgb(hex); const f = v => clamp(Math.round(v * k), 0, 255); return `rgb(${f(r)},${f(g)},${f(b)})`; }
const FONT = '"Arial Narrow","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif';
const FONTB = '"Arial Black","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif';

function noiseCanvas(size = 256) {
  return cached('noise' + size, () => {
    const c = mkCanvas(size, size), g = c.getContext('2d'); const img = g.createImageData(size, size);
    const r = makeRng('noise');
    const chans = [[4, 8, 16], [8, 16, 32], [32, 64, 128]];
    const lat = {}; const L = n => lat[n] || (lat[n] = Float32Array.from({ length: n * n }, r));
    const vn = (n, x, y) => {
      const a = L(n), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const X0 = ((x0 % n) + n) % n, Y0 = ((y0 % n) + n) % n, X1 = (X0 + 1) % n, Y1 = (Y0 + 1) % n;
      return lerp(lerp(a[Y0 * n + X0], a[Y0 * n + X1], sx), lerp(a[Y1 * n + X0], a[Y1 * n + X1], sx), sy);
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = 0, amp = 0.5, tot = 0;
        for (const n of chans[ch]) { v += vn(n, x / size * n, y / size * n) * amp; tot += amp; amp *= 0.5; }
        img.data[o + ch] = clamp(Math.round(v / tot * 255), 0, 255);
      }
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  });
}
// 3-lobed Boston-ivy leaf
function ivyLeaf(g, x, y, s, rot, col) {
  const pts = [[0, -1], [0.3, -0.42], [0.95, -0.6], [0.58, 0.02], [0.8, 0.55], [0.22, 0.42], [0, 0.78], [-0.22, 0.42], [-0.8, 0.55], [-0.58, 0.02], [-0.95, -0.6], [-0.3, -0.42]];
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(s / 2, s / 2);
  g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath();
  g.fillStyle = col; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 0.06; g.beginPath();
  g.moveTo(0, 0.6); g.lineTo(0, -0.85); g.moveTo(0, 0.1); g.lineTo(0.75, -0.45); g.moveTo(0, 0.1); g.lineTo(-0.75, -0.45); g.stroke();
  g.restore();
}
const IVY_GREENS = ['#2e6b2c', '#357a31', '#3f8738', '#2a5f27', '#4a9440', '#24541f', '#3b7d33', '#51993f', '#5f9e3a'];
function ivyCanvas() {
  return cached('ivy', () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('ivy');
    g.fillStyle = '#12260f'; g.fillRect(0, 0, S, S);
    for (let k = 0; k < 3400; k++) {
      const x = r() * S, y = r() * S, s = 13 + r() * 17, rot = (r() - 0.5) * 1.4 + Math.PI;
      const col = pick(r, IVY_GREENS);
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        if (x + ox < -30 || x + ox > S + 30 || y + oy < -30 || y + oy > S + 30) continue;
        g.fillStyle = 'rgba(0,0,0,0.3)'; ivyLeaf(g, x + ox + 1.5, y + oy + 2, s, rot, 'rgba(0,0,0,0.3)');
        ivyLeaf(g, x + ox, y + oy, s, rot, col);
      }
    }
    return c;
  });
}
function flatNormalCanvas() { return cached('flatN', () => { const c = mkCanvas(4, 4), g = c.getContext('2d'); g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 4, 4); return c; }); }
// 4x4 atlas of ivy sprigs with alpha (fallback for wrigley_ivy_leaves)
function leavesCanvas() {
  return cached('leaves', () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('leaves');
    g.clearRect(0, 0, S, S);
    for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
      const x0 = cx * 128 + 64, y0 = cy * 128 + 70, n = 3 + Math.floor(r() * 4);
      g.strokeStyle = '#4d5a2a'; g.lineWidth = 2.5;
      for (let k = 0; k < n; k++) {
        const a = -Math.PI / 2 + (k - (n - 1) / 2) * 0.62 + (r() - 0.5) * 0.3, L = 26 + r() * 20;
        const x = x0 + Math.cos(a) * L, y = y0 + Math.sin(a) * L * 0.9;
        g.beginPath(); g.moveTo(x0, y0 + 36); g.quadraticCurveTo(x0, y0, x, y); g.stroke();
        ivyLeaf(g, x, y, 40 + r() * 16, a + Math.PI / 2 + Math.PI, pick(r, IVY_GREENS));
      }
    }
    return c;
  });
}
function juniperCanvas() {
  return cached('juniper', () => {
    const S = 256, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('juni');
    g.fillStyle = '#16261c'; g.fillRect(0, 0, S, S);
    for (let k = 0; k < 900; k++) {
      const x = r() * S, y = r() * S, rr = 6 + r() * 14;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const gr = g.createRadialGradient(x + ox - rr * 0.3, y + oy - rr * 0.4, 1, x + ox, y + oy, rr);
        gr.addColorStop(0, pick(r, ['#3f5f45', '#35533c', '#2d4a35', '#46684a'])); gr.addColorStop(1, 'rgba(18,34,24,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x + ox, y + oy, rr, 0, 7); g.fill();
      }
    }
    return c;
  });
}
function brickCanvas(neutral) { // neutral = light grey bricks (tinted per building by vertex colour)
  return cached('brick' + (neutral ? 'N' : ''), () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('brick' + neutral);
    g.fillStyle = neutral ? '#8f8a82' : '#b5a893'; g.fillRect(0, 0, S, S);
    const rows = 16, bh = S / rows, bw = S / 6;
    const cols = neutral ? ['#e6e1d8', '#d8d2c6', '#cfc8bb', '#ece8e0', '#c8c1b4', '#ddd6c9'] : ['#8e3b2a', '#a2472f', '#7c3325', '#b0553a', '#944030', '#6e2e22', '#a85236'];
    for (let j = 0; j < rows; j++) {
      const off = (j % 2) * bw / 2;
      for (let i = -1; i < 7; i++) {
        const x = i * bw + off; g.fillStyle = pick(r, cols); g.fillRect(x + 2, j * bh + 2, bw - 4, bh - 4);
        for (let k = 0; k < 10; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,240,220'},${0.05 + r() * 0.07})`; g.fillRect(x + 3 + r() * (bw - 10), j * bh + 3 + r() * (bh - 8), 2 + r() * 8, 2 + r() * 3); }
      }
    }
    return c;
  });
}
// Photo-facade fallback: 3 cells (red brick / tan brick / greystone) stacked vertically, 1024x768 each.
function facadeFallback() {
  return cached('facadeFB', () => {
    const W = 512, CH = 384, c = mkCanvas(W, CH * 3), g = c.getContext('2d'); const r = makeRng('facFB');
    const V = [{ wall: '#8a3f2c', trim: '#d8cfbd', win: '#2a333b', frame: '#f0ede4' }, { wall: '#b98e5c', trim: '#e2d6bf', win: '#27313a', frame: '#1f4a3a' }, { wall: '#b4afa4', trim: '#d9d5cc', win: '#1f262c', frame: '#20252a' }];
    V.forEach((v, k) => {
      const y0 = k * CH; g.fillStyle = v.wall; g.fillRect(0, y0, W, CH);
      g.globalAlpha = 0.25; g.drawImage(brickCanvas(false), 0, y0, W, CH); g.globalAlpha = 1;
      g.fillStyle = shade(v.wall, 0.55); g.fillRect(0, y0, W, CH * 0.07); g.fillStyle = v.trim; g.fillRect(0, y0 + CH * 0.07, W, CH * 0.015);
      for (const bx of [0.04, 0.66]) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(bx * W, y0 + CH * 0.09, W * 0.3, CH * 0.8); }
      for (let f = 0; f < 3; f++) {
        const fy = y0 + CH * (0.13 + f * 0.28); g.fillStyle = v.trim; g.fillRect(0, fy + CH * 0.2, W, CH * 0.012);
        for (let i = 0; i < 7; i++) {
          if (f === 2 && i === 3) { g.fillStyle = '#2a2320'; g.fillRect(W * 0.43, fy + CH * 0.02, W * 0.14, CH * 0.24); continue; }
          const x = W * (0.06 + i * 0.13); g.fillStyle = v.frame; g.fillRect(x - 3, fy - 3, W * 0.08 + 6, CH * 0.18 + 6);
          g.fillStyle = v.win; g.fillRect(x, fy, W * 0.08, CH * 0.18); g.fillStyle = 'rgba(200,210,220,0.35)'; g.fillRect(x, fy, W * 0.08, CH * 0.07);
        }
      }
    });
    return c;
  });
}
function facadeWinFallback() { // R = glow, G = window id, B = door
  return cached('facadeWinFB', () => {
    const W = 256, CH = 192, c = mkCanvas(W, CH * 3), g = c.getContext('2d'); const r = makeRng('facWin');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, CH * 3);
    for (let k = 0; k < 3; k++) for (let f = 0; f < 3; f++) for (let i = 0; i < 7; i++) {
      const y0 = k * CH + CH * (0.13 + f * 0.28), door = f === 2 && i === 3;
      g.fillStyle = `rgb(${door ? 230 : 200},${Math.floor(r() * 250)},${door ? 255 : 0})`;
      if (door) g.fillRect(W * 0.43, y0 + CH * 0.02, W * 0.14, CH * 0.24); else g.fillRect(W * (0.06 + i * 0.13), y0, W * 0.08, CH * 0.18);
    }
    return c;
  });
}
function tallCanvas(lit) { // modern high-rise facade tile (1 tile = 40 ft wide x 60 ft = 5 floors)
  return cached('tall' + (lit ? 'L' : ''), () => {
    const W = 128, H = 192, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('tall');
    g.fillStyle = lit ? '#000' : '#39414b'; g.fillRect(0, 0, W, H);
    for (let f = 0; f < 5; f++) for (let i = 0; i < 4; i++) {
      const x = i * 32 + 3, y = f * 38.4 + 5;
      if (!lit) { g.fillStyle = r() < 0.5 ? '#4c6a86' : '#3a5068'; g.fillRect(x, y, 26, 28); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, 26, 8); }
      else if (r() < 0.55) { g.fillStyle = r() < 0.7 ? '#ffd79a' : '#d9e6ff'; g.globalAlpha = 0.45 + r() * 0.55; g.fillRect(x, y, 26, 28); g.globalAlpha = 1; }
    }
    return c;
  });
}
function streetCanvas() { // u: along the street (40 ft), v: across the band d = 58.4 … 98 (sidewalk | Waveland | sidewalk)
  return cached('street', () => {
    const W = 512, H = 512, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('street');
    const py = d => H - (d - 58.4) / (98 - 58.4) * H; // canvas y for a band depth d (v up = far side)
    g.fillStyle = '#3b3d40'; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 5000; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.07})`; g.fillRect(r() * W, r() * H, 2, 2); }
    for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.1})`; g.beginPath(); g.ellipse(r() * W, py(66 + r() * 24), 10 + r() * 30, 4 + r() * 10, 0, 0, 7); g.fill(); }
    for (let k = 0; k < 6; k++) { g.fillStyle = `rgba(80,82,86,${0.5})`; const x = r() * W, y = py(66 + r() * 24); g.fillRect(x, y, 40 + r() * 80, 18 + r() * 30); }
    // sidewalks
    for (const [d0, d1] of [[58.4, 65], [91, 98]]) {
      g.fillStyle = '#a5a197'; g.fillRect(0, py(d1), W, py(d0) - py(d1));
      g.fillStyle = 'rgba(0,0,0,0.18)'; for (let x = 0; x < W; x += 64) g.fillRect(x, py(d1), 2, py(d0) - py(d1));
      for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`; g.fillRect(r() * W, py(d1) + r() * (py(d0) - py(d1)), 2, 2); }
    }
    g.fillStyle = '#c9c4b8'; g.fillRect(0, py(65) - 3, W, 5); g.fillRect(0, py(91) - 2, W, 5);   // curbs
    g.fillStyle = '#e3c448'; g.fillRect(0, py(78) - 4, W, 3); g.fillRect(0, py(78) + 2, W, 3);  // double yellow
    g.fillStyle = 'rgba(235,235,230,0.55)'; g.fillRect(0, py(72), W, 2); g.fillRect(0, py(84), W, 2);
    // manhole
    g.fillStyle = '#2a2b2d'; g.beginPath(); g.arc(W * 0.7, py(75), 12, 0, 7); g.fill(); g.strokeStyle = '#55565a'; g.lineWidth = 2; g.stroke();
    return c;
  });
}
function chainCanvas() {
  return cached('chain', () => {
    const S = 64, c = mkCanvas(S, S), g = c.getContext('2d');
    g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(150,158,152,1)'; g.lineWidth = 7;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(S, S); g.moveTo(S, 0); g.lineTo(0, S); g.stroke();
    return c;
  });
}
function netCanvas() {
  return cached('net', () => { const S = 32, c = mkCanvas(S, S), g = c.getContext('2d'); g.strokeStyle = 'rgba(30,30,30,0.95)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 1); g.lineTo(S, 1); g.moveTo(1, 0); g.lineTo(1, S); g.stroke(); return c; });
}
function lampCanvas() { // LED bank: grid of square fixtures
  return cached('lamps', () => {
    const S = 128, c = mkCanvas(S, S), g = c.getContext('2d');
    g.fillStyle = '#23272c'; g.fillRect(0, 0, S, S);
    const nx = 4, ny = 4, sx = S / nx, sy = S / ny;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = i * sx + 5, y = j * sy + 5, w = sx - 10, h = sy - 10;
      g.fillStyle = '#6b7178'; g.fillRect(x - 2, y - 2, w + 4, h + 4);
      const gr = g.createLinearGradient(x, y, x, y + h); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#dfe6f0');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.25)'; for (let k = 1; k < 4; k++) g.fillRect(x + k * w / 4, y, 1, h);
    }
    return c;
  });
}
function glowCanvas() {
  return cached('glow', () => { const S = 64, c = mkCanvas(S, S), g = c.getContext('2d'); const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,250,235,0.5)'); gr.addColorStop(1, 'rgba(255,240,220,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); return c; });
}
function gravelCanvas() {
  return cached('gravel', () => { const S = 256, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('grav'); g.fillStyle = '#7d766b'; g.fillRect(0, 0, S, S); for (let k = 0; k < 7000; k++) { g.fillStyle = pick(r, ['#6a6358', '#8e877b', '#5d574e', '#9c9588', '#746c60']); g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3); } for (let k = 0; k < 18; k++) { g.fillStyle = 'rgba(70,80,50,0.35)'; g.beginPath(); g.ellipse(r() * S, r() * S, 6 + r() * 20, 4 + r() * 12, r() * 3, 0, 7); g.fill(); } return c; });
}
function seatsCanvas() { // grandstand seat rows: Wrigley-green seats on concrete (tile = 4 rows)
  return cached('seatsGS', () => {
    const W = 256, H = 256, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('seatsGS');
    g.fillStyle = '#7f7d76'; g.fillRect(0, 0, W, H);
    const rh = H / 4;
    for (let j = 0; j < 4; j++) {
      const y = j * rh;
      g.fillStyle = '#5c5a55'; g.fillRect(0, y, W, rh * 0.16);
      g.fillStyle = '#1d4a33'; g.fillRect(0, y + rh * 0.42, W, rh * 0.42);
      g.fillStyle = '#2d6446'; g.fillRect(0, y + rh * 0.42, W, rh * 0.07);
      g.fillStyle = 'rgba(0,0,0,0.4)'; for (let x = 0; x < W; x += 16) g.fillRect(x, y + rh * 0.42, 2, rh * 0.42);
    }
    for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.08})`; g.fillRect(r() * W, r() * H, 2, 2); }
    return c;
  });
}

// ---------------------------------------------------------------------------
// Fallback sky (procedural gradient, clouds, distant skyline on the left, lake on the right) —
// same layout as the sky_wrigley_* assets so the azimuth mapping works for both.
// ---------------------------------------------------------------------------
function paintSky(tod, W = 2048, H = 880) {
  return cached(`sky_wrigley_${tod}`, () => {
    const c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('skyw' + tod);
    const hz = Math.round(H * 0.78);
    const pal = { day: ['#1d58c4', '#3f82dc', '#8fbdec', '#d6e8f6'], dusk: ['#1f2150', '#5a3a7e', '#d45d7c', '#ffb25a'], night: ['#02050d', '#060f24', '#0f1f45', '#2c3558'] }[tod];
    let gr = g.createLinearGradient(0, 0, 0, hz);
    gr.addColorStop(0, pal[0]); gr.addColorStop(0.5, pal[1]); gr.addColorStop(0.85, pal[2]); gr.addColorStop(1, pal[3]);
    g.fillStyle = gr; g.fillRect(0, 0, W, hz);
    if (tod === 'dusk') { const sg = g.createRadialGradient(W * 0.9, hz, 0, W * 0.9, hz, H * 0.8); sg.addColorStop(0, 'rgba(255,236,170,1)'); sg.addColorStop(0.15, 'rgba(255,190,110,0.8)'); sg.addColorStop(0.5, 'rgba(255,120,90,0.25)'); sg.addColorStop(1, 'rgba(255,110,90,0)'); g.fillStyle = sg; g.fillRect(0, 0, W, hz); }
    if (tod === 'night') for (let k = 0; k < 1100; k++) { const y = r() * hz * 0.9, a = (0.25 + r() * 0.75) * (1 - y / hz * 0.8); g.fillStyle = `rgba(255,255,255,${a})`; g.fillRect(r() * W, y, r() < 0.06 ? 2 : 1, r() < 0.06 ? 2 : 1); }
    const puff = (cx, cy, w, top, base) => {
      const n = 9 + Math.floor(r() * 9);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = cx + (t - 0.5) * w, rr = w * (0.09 + 0.16 * Math.sin(Math.PI * t) * (0.6 + r() * 0.6)), y = cy - rr * 0.6;
        for (const ox of [-W, 0, W]) { const q = g.createLinearGradient(0, y - rr, 0, cy); q.addColorStop(0, top); q.addColorStop(1, base); g.fillStyle = q; g.beginPath(); g.arc(x + ox, y, rr, 0, 7); g.fill(); }
      }
    };
    if (tod === 'day') for (let k = 0; k < 24; k++) { const cy = hz * (0.3 + r() * 0.62); puff(r() * W, cy, (110 + r() * 240) * (0.45 + cy / hz * 0.75), '#ffffff', '#b3c2d4'); }
    else if (tod === 'dusk') for (let k = 0; k < 24; k++) { g.fillStyle = r() < 0.5 ? 'rgba(140,70,130,0.7)' : 'rgba(255,150,110,0.7)'; g.beginPath(); g.ellipse(r() * W, hz * (0.2 + r() * 0.7), 140 + r() * 380, 6 + r() * 14, 0, 0, 7); g.fill(); }
    else for (let k = 0; k < 14; k++) { g.fillStyle = 'rgba(40,52,84,0.75)'; g.beginPath(); g.ellipse(r() * W, hz * (0.3 + r() * 0.6), 150 + r() * 300, 8 + r() * 12, 0, 0, 7); g.fill(); }
    gr = g.createLinearGradient(0, hz, 0, H);
    const gc = tod === 'day' ? ['#6f7d74', '#3f4b40'] : tod === 'dusk' ? ['#3d3040', '#1b1a22'] : ['#0f1424', '#05070c'];
    gr.addColorStop(0, gc[0]); gr.addColorStop(1, gc[1]); g.fillStyle = gr; g.fillRect(0, hz, W, H - hz);
    g.fillStyle = tod === 'day' ? '#3474ab' : tod === 'dusk' ? '#6d5a86' : '#0f1b35'; g.fillRect(W * 0.55, hz - 6, W * 0.45, 10);
    const haze = tod === 'day' ? [150, 170, 195] : tod === 'dusk' ? [70, 50, 90] : [14, 20, 38];
    for (let x = W * 0.02; x < W * 0.5; x += 5 + r() * 12) {
      const f = 1 - Math.abs((x / W - 0.18) / 0.3), h = 10 + r() * r() * 90 * Math.max(0.15, f), w = 6 + r() * 14, k = 0.75 + r() * 0.2;
      g.fillStyle = `rgb(${Math.round(haze[0] * k)},${Math.round(haze[1] * k)},${Math.round(haze[2] * k)})`; g.fillRect(x, hz - h, w, h);
      if (tod !== 'day') for (let q = 0; q < h * w / 50; q++) { g.fillStyle = 'rgba(255,214,150,0.9)'; g.fillRect(x + r() * w, hz - r() * h, 1.5, 1.5); }
    }
    return c;
  });
}

// ---------------------------------------------------------------------------
// geometry kit
// ---------------------------------------------------------------------------
function makeGeoKit(THREE) {
  const C = new THREE.Color();
  function finish(geo, color, extra) {
    if (!geo.index) { const n = geo.attributes.position.count; geo.setIndex(Array.from({ length: n }, (_, i) => i)); }
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (color !== undefined && color !== null) {
      C.set(color); const n = geo.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = C.r; a[i * 3 + 1] = C.g; a[i * 3 + 2] = C.b; }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
    }
    if (extra) for (const k in extra) { const n = geo.attributes.position.count, a = new Float32Array(n).fill(extra[k]); geo.setAttribute(k, new THREE.Float32BufferAttribute(a, 1)); }
    return geo;
  }
  function grid(rows, uvs, color, extra) { // rows[i][j] = [x,y,z]; uvs[i][j] = [u,v]
    const ni = rows.length, nj = rows[0].length;
    const pos = new Float32Array(ni * nj * 3), uv = new Float32Array(ni * nj * 2), idx = [];
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      const k = i * nj + j, p = rows[i][j]; pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
      if (uvs) { uv[k * 2] = uvs[i][j][0]; uv[k * 2 + 1] = uvs[i][j][1]; }
    }
    for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) { const a = i * nj + j, b = (i + 1) * nj + j, c = (i + 1) * nj + j + 1, d = i * nj + j + 1; idx.push(a, b, d, b, c, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    return finish(geo, color, extra);
  }
  function quad(a, b, c, d, color, uvRect, extra) { // a,b bottom (l→r), c,d top (r→l)
    const [u0, v0, u1, v1] = uvRect || [0, 0, 1, 1];
    return grid([[a, d], [b, c]], [[[u0, v0], [u0, v1]], [[u1, v0], [u1, v1]]], color, extra);
  }
  function box(cx, cy, cz, sx, sy, sz, color, rotY = 0, extra) { const g = new THREE.BoxGeometry(sx, sy, sz); if (rotY) g.rotateY(rotY); g.translate(cx, cy, cz); return finish(g, color, extra); }
  // oriented box: centre c, unit axes t (length), n (depth), up; sizes
  function obox(c, t, n, sx, sy, sz, color, extra) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(t[0], 0, t[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], 0, n[1]));
    m.setPosition(c[0], c[1], c[2]); g.applyMatrix4(m); return finish(g, color, extra);
  }
  function cyl(x0, y0, z0, x1, y1, z1, r0, r1, seg, color, extra, closed = false) {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1e-3;
    const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, !closed); g.translate(0, L / 2, 0);
    const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d)); g.translate(x0, y0, z0);
    return finish(g, color, extra);
  }
  function bar(a, b, w, color, extra) { // square beam between two 3D points
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-3;
    const g = new THREE.BoxGeometry(w, L, w); g.translate(0, L / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L))); g.translate(a[0], a[1], a[2]);
    return finish(g, color, extra);
  }
  // merge; attributes missing in some geometries are zero-filled
  function merge(list) {
    list = list.filter(Boolean); if (!list.length) return null;
    const spec = {}; for (const g of list) for (const n in g.attributes) spec[n] = g.attributes[n].itemSize;
    let nv = 0, ni = 0; for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const out = new THREE.BufferGeometry(); const arrs = {};
    for (const n in spec) arrs[n] = new Float32Array(nv * spec[n]);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const g of list) {
      const n0 = g.attributes.position.count;
      for (const n in spec) { const a = g.attributes[n]; if (a) arrs[n].set(a.array.length === n0 * spec[n] ? a.array : a.array.subarray(0, n0 * spec[n]), vo * spec[n]); else if (n === 'color') arrs[n].fill(1, vo * 3, (vo + n0) * 3); }
      if (g.index) { const gi = g.index.array; for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo; io += gi.length; }
      else { for (let k = 0; k < n0; k++) idx[io + k] = vo + k; io += n0; }
      vo += n0; g.dispose();
    }
    for (const n in spec) out.setAttribute(n, new THREE.BufferAttribute(arrs[n], spec[n]));
    out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere();
    return out;
  }
  return { finish, grid, quad, box, obox, cyl, bar, merge };
}

// ===========================================================================
// MAIN
// ===========================================================================
export function buildWrigleyStadium(THREE, opts = {}) {
  const parkId = 'wrigley', PK = PARKS.wrigley, PAL = PK.palette;
  const tod = ['day', 'dusk', 'night'].includes(opts.timeOfDay) ? opts.timeOfDay : 'day';
  const weather = WEATHER[opts.weather] ? opts.weather : 'clear';
  const wind = { mph: Math.max(0, +(opts.wind && opts.wind.mph) || 0), dir: +(opts.wind && opts.wind.dir) || 0 };
  const quality = ['high', 'medium', 'low'].includes(opts.quality) ? opts.quality : 'high';
  const HIGH = quality === 'high', LOW = quality === 'low';
  const assets = opts.assets || null;
  const LOOK = makeLook(tod, weather);
  const TM = [['start', performance.now()]]; const mark = n => TM.push([n, performance.now()]);
  const K = makeGeoKit(THREE);
  const R = makeRng('wrigley:v2');
  const disposables = [];
  const group = new THREE.Group(); group.name = 'stadium:wrigley';
  const aniso = HIGH ? 8 : quality === 'medium' ? 4 : 2;
  let disposed = false;
  const OF = PK.stands, ST = PK.street, RT = PK.rooftops, SB = PK.scoreboard;
  const FENCE_H = PK.fenceH, WELL_H = (PK.wells && PK.wells.h) || FENCE_H;
  const fenceAt = s => fenceDistance(parkId, s);
  const sH = d => surfaceHeight(parkId, 0, fenceAt(0) + d);                 // bleacher surface at depth d beyond the wall
  const inWell = s => PK.wells ? PK.wells.spray.some(([a, b]) => s >= a - 0.5 && s <= b + 0.5) : false;
  const wellK = s => { if (!PK.wells) return 0; let k = 0; for (const [a, b] of PK.wells.spray) k = Math.max(k, smooth(a - 0.9, a + 0.2, s) * (1 - smooth(b - 0.2, b + 0.9, s))); return k; };
  const wallH = s => lerp(FENCE_H, WELL_H, wellK(s));
  const assetBase = opts.assetBase || (() => { try { return new URL('assets/parks/wrigley/', document.baseURI).href; } catch (e) { return 'assets/parks/wrigley/'; } })();

  // -------------------------------------------------------------- assets
  const isBitmap = im => typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap;
  const natural = im => { if (!isBitmap(im)) return im; const c = mkCanvas(im.width, im.height); c.getContext('2d').drawImage(im, 0, 0); return c; };
  function assetImage(key) {
    try {
      const im = assets && assets.get && assets.get(key);
      if (im && (im.naturalWidth || im.width) > 0 && (im.complete === undefined || im.complete)) return im;
    } catch (e) { /* missing */ }
    return null;
  }
  function assetMeta(key) { try { return (assets && assets.meta && assets.meta(key)) || null; } catch (e) { return null; } }
  function tex(src, { wrap = 'repeat', srgb = true, mips = true, flipY = true } = {}) {
    src = natural(src); const t = new THREE.Texture(src); t.needsUpdate = true;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const w = wrap === 'mirror' ? THREE.MirroredRepeatWrapping : wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapS = t.wrapT = w; t.anisotropy = aniso; t.flipY = flipY;
    t.generateMipmaps = mips; t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    disposables.push(t); return t;
  }
  const downscale = (im, maxW) => { const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height; if (w <= maxW) return im; const c = mkCanvas(maxW, Math.round(h * maxW / w)); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); return c; };
  // Photo textures: sync from the Assets store if the manifest has the key, else fetch the file and swap it in.
  const photo = { requested: 0, loaded: 0, fromStore: 0 };
  function usePhoto(key, t, maxW = 4096) {
    const file = WR_ASSETS[key]; photo.requested++;
    const apply = (im, fromStore) => {
      if (disposed) return;
      const src = downscale(natural(im), maxW); if (!fromStore) t.dispose(); t.image = src; t.flipY = true; t.needsUpdate = true; photo.loaded++; if (fromStore) photo.fromStore++;
    };
    const im = assetImage(key);
    if (im) { apply(im, true); return; }
    if (opts.photos === false || typeof Image === 'undefined' || !file) return;
    const img = new Image(); img.decoding = 'async';
    img.onload = () => { (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => apply(img, false)); };
    img.onerror = () => { /* keep the procedural fallback */ };
    img.src = assetBase + file;
  }
  const col = hex => new THREE.Color(hex);

  mark('textures');
  // -------------------------------------------------------------- textures
  const T = {};
  T.noise = tex(noiseCanvas(256), { srgb: false });
  { const im = assetImage('tex_brick'); T.brick = tex(im || brickCanvas(false)); }
  T.brickN = tex(brickCanvas(true));
  T.ivy = tex(ivyCanvas()); usePhoto('wrigley_ivy', T.ivy, LOW ? 512 : 1024);
  T.ivyN = tex(flatNormalCanvas(), { srgb: false }); usePhoto('wrigley_ivy_n', T.ivyN, 512);
  T.leaves = tex(leavesCanvas(), { wrap: 'clamp' }); usePhoto('wrigley_ivy_leaves', T.leaves, LOW ? 512 : 1024);
  T.juniper = tex(juniperCanvas()); usePhoto('wrigley_juniper', T.juniper, 512);
  T.facade = tex(facadeFallback(), { wrap: 'clamp' }); usePhoto('wrigley_facades', T.facade, LOW ? 512 : 1024);
  T.win = tex(facadeWinFallback(), { wrap: 'clamp', srgb: false }); usePhoto('wrigley_facades_win', T.win, 512);
  T.street = tex(streetCanvas());
  T.chain = tex(chainCanvas());
  T.net = tex(netCanvas());
  T.lamps = tex(lampCanvas());
  T.glow = tex(glowCanvas(), { wrap: 'clamp' });
  T.gravel = tex(gravelCanvas());
  T.seatsGS = tex(seatsCanvas());
  T.tall = tex(tallCanvas(false)); T.tallLit = tex(tallCanvas(true));

  mark('materials');
  // -------------------------------------------------------------- materials
  const side = THREE.DoubleSide;
  const M = {};
  const wetRough = r => lerp(r, Math.min(r, 0.42), LOOK.wet);
  const GLOWK = { value: LOOK.glowK }, NOISE = { value: T.noise }, WINK = { value: LOOK.windows }, TIME = { value: 0 };
  // Standard-material hook: world-space grime + optional per-vertex night glow (attribute `glow`).
  function hookStd(m, key, { glow = false, glowCol = null, grime = 0, fine = 0 } = {}) {
    m.customProgramCacheKey = () => 'wr-' + key;
    m.onBeforeCompile = sh => {
      sh.uniforms.uGlowK = GLOWK; sh.uniforms.uNoiseT = NOISE;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWPx;${glow ? '\nattribute float glow;\nvarying float vGlow;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWPx = (modelMatrix * vec4(transformed, 1.0)).xyz;${glow ? '\nvGlow = glow;' : ''}`);
      let f = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPx;\nuniform sampler2D uNoiseT;\nuniform float uGlowK;${glow ? '\nvarying float vGlow;' : ''}`);
      if (grime > 0) f = f.replace('#include <color_fragment>', `#include <color_fragment>
        { float gn = texture2D(uNoiseT, vWPx.xz / 41.0 + vec2(vWPx.y / 57.0, 0.0)).g; float gf = texture2D(uNoiseT, vWPx.xz / 3.7 + vec2(0.0, vWPx.y / 4.3)).b;
          diffuseColor.rgb *= mix(${(1 - grime).toFixed(3)}, 1.05, gn) * mix(${(1 - fine).toFixed(3)}, ${(1 + fine * 0.35).toFixed(3)}, gf); }`);
      if (glow) f = f.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${glowCol ? `vec3(${glowCol})` : 'diffuseColor.rgb'} * (vGlow >= 10.0 ? (vGlow - 10.0) * max(uGlowK, 0.45) : vGlow * uGlowK);`);
      sh.fragmentShader = f;
    };
  }
  // Ivy: big soft patches of lighter/darker/yellower growth, darker at the base (AO), glossy leaves
  function hookIvy(m, key) {
    m.customProgramCacheKey = () => 'wr-' + key;
    m.onBeforeCompile = sh => {
      sh.uniforms.uNoiseT = NOISE;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPx;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPx = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPx;\nuniform sampler2D uNoiseT;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          { float n1 = texture2D(uNoiseT, vWPx.xz / 70.0).r, n2 = texture2D(uNoiseT, vWPx.xz / 14.0 + vec2(0.0, vWPx.y / 9.0)).g;
            diffuseColor.rgb *= mix(0.74, 1.14, n1) * mix(0.9, 1.07, n2);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.14, 1.08, 0.66), smoothstep(0.6, 0.92, n2) * 0.4);
            diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.2, 3.2, vWPx.y)); }`);
    };
  }
  M.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: wetRough(0.8), metalness: 0.05, side }); hookStd(M.paint, 'paint', { glow: true, grime: 0.16, fine: 0.1 });
  M.glass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.75, envMapIntensity: 1.5, side }); hookStd(M.glass, 'glass', { glow: true, glowCol: '1.0, 0.82, 0.58' });
  M.brick = new THREE.MeshStandardMaterial({ map: T.brick, vertexColors: true, roughness: wetRough(0.92), side }); hookStd(M.brick, 'brick', { grime: 0.2, fine: 0.06 });
  M.brickN = new THREE.MeshStandardMaterial({ map: T.brickN, vertexColors: true, roughness: wetRough(0.92), side }); hookStd(M.brickN, 'brickN', { glow: true, grime: 0.22 });
  M.ivy = new THREE.MeshStandardMaterial({ map: T.ivy, normalMap: T.ivyN, normalScale: new THREE.Vector2(1.25, 1.25), roughness: wetRough(0.58), metalness: 0, side, color: col('#e8f2e0') }); hookIvy(M.ivy, 'ivy');
  M.leaves = new THREE.MeshStandardMaterial({ map: T.leaves, alphaTest: 0.5, vertexColors: true, roughness: wetRough(0.5), side }); hookIvy(M.leaves, 'leaves');
  M.juniper = new THREE.MeshStandardMaterial({ map: T.juniper, roughness: 0.92, side, color: col('#f0fff0') });
  M.street = new THREE.MeshStandardMaterial({ map: T.street, roughness: wetRough(0.93), side }); hookStd(M.street, 'street', { grime: 0.12 });
  M.gravel = new THREE.MeshStandardMaterial({ map: T.gravel, roughness: 1, side });
  M.seatsGS = new THREE.MeshStandardMaterial({ map: T.seatsGS, roughness: wetRough(0.82), side });
  M.lamps = new THREE.MeshStandardMaterial({ map: T.lamps, emissiveMap: T.lamps, emissive: col('#fbfcff'), emissiveIntensity: LOOK.lamps, roughness: 0.4, side });
  M.chain = new THREE.MeshStandardMaterial({ map: T.chain, transparent: true, depthWrite: false, alphaTest: 0.01, side, roughness: 0.5, metalness: 0.5, color: col('#b6bdb8') });
  M.net = new THREE.MeshBasicMaterial({ map: T.net, transparent: true, opacity: 0.5, depthWrite: false, side, color: col('#222222') });
  M.tall = new THREE.MeshStandardMaterial({ map: T.tall, emissiveMap: T.tallLit, emissive: col('#ffe2b0'), emissiveIntensity: LOOK.windows * 1.1, roughness: 0.6, metalness: 0.2 });
  // photo facades: 3-cell atlas (0 red brick, 1 tan brick, 2 greystone), per-building window lighting at night
  M.facade = new THREE.MeshStandardMaterial({ map: T.facade, roughness: wetRough(0.88), side });
  M.facade.customProgramCacheKey = () => 'wr-facade';
  M.facade.onBeforeCompile = sh => {
    sh.uniforms.uWin = { value: T.win }; sh.uniforms.uWinK = WINK;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float fv;\nattribute float seed;\nvarying float vFv;\nvarying float vSeed;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFv = fv; vSeed = seed;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D uWin; uniform float uWinK; varying float vFv; varying float vSeed;
      vec2 fAtlas(vec2 uv){ return vec2(fract(uv.x), (2.0 - vFv + clamp(uv.y, 0.004, 0.996)) / 3.0); }`)
      .replace('#include <map_fragment>', `vec2 fUV = fAtlas(vMapUv); vec2 gdx = dFdx(vMapUv * vec2(1.0, 0.3333)), gdy = dFdy(vMapUv * vec2(1.0, 0.3333));
        diffuseColor *= textureGrad(map, fUV, gdx, gdy);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 wm = textureGrad(uWin, fUV, gdx, gdy).rgb; float on = step(0.37, fract(wm.g * 7.31 + vSeed));
          vec3 wc = mix(vec3(1.0, 0.76, 0.46), vec3(0.74, 0.84, 1.0), step(0.88, fract(wm.g * 3.7 + vSeed * 1.3)));
          totalEmissiveRadiance += wc * wm.r * max(on, wm.b) * uWinK * 1.35; }`);
  };
  Object.values(M).forEach(m => m && disposables.push(m));

  // bins: material key → list of geometries
  const BINS = {};
  const add = (key, geo) => { if (!geo) return; (BINS[key] || (BINS[key] = [])).push(geo); };
  // Raw batches: fast path for thousands of quads / template copies (leaf cards, city, trees).
  const RAW = {}, TPL = {}, _c = new THREE.Color();
  const rawBin = (key, ex) => RAW[key] || (RAW[key] = { pos: [], nor: [], uv: [], col: [], ex: Object.fromEntries((ex || []).map(n => [n, []])), idx: [] });
  function rawQuad(key, a, b, c, d, color, uvRect, extra, normal) { // same vertex order/uv as K.quad
    const B = rawBin(key, extra && Object.keys(extra)), base = B.pos.length / 3;
    let nx, ny, nz;
    if (normal) [nx, ny, nz] = normal;
    else {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    }
    B.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let k = 0; k < 4; k++) B.nor.push(nx, ny, nz);
    const [u0, v0, u1, v1] = uvRect || [0, 0, 1, 1];
    B.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    if (color != null) { if (typeof color === 'object' && color.isColor) _c.copy(color); else _c.set(color); for (let k = 0; k < 4; k++) B.col.push(_c.r, _c.g, _c.b); }
    if (extra) for (const n in extra) for (let k = 0; k < 4; k++) B.ex[n].push(extra[n]);
    B.idx.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
  }
  function tpl(name, make) {
    if (!TPL[name]) { const g0 = make(), g = g0.index ? g0.toNonIndexed() : g0; g.deleteAttribute('normal'); g.computeVertexNormals(); TPL[name] = { p: g.attributes.position.array, n: g.attributes.normal.array }; g.dispose(); }
    return TPL[name];
  }
  function rawTpl(key, t, ox, oy, oz, sx, sy, sz, color, rotY = 0) { // flat-shaded template copy (scale, rotY, offset)
    const B = rawBin(key), base = B.pos.length / 3, nv = t.p.length / 3; _c.set(color);
    const cr = Math.cos(rotY), sr = Math.sin(rotY);
    for (let i = 0; i < nv; i++) {
      const x = t.p[i * 3] * sx, y = t.p[i * 3 + 1] * sy, z = t.p[i * 3 + 2] * sz;
      B.pos.push(x * cr + z * sr + ox, y + oy, -x * sr + z * cr + oz);
      const nx = t.n[i * 3], nz = t.n[i * 3 + 2]; B.nor.push(nx * cr + nz * sr, t.n[i * 3 + 1], -nx * sr + nz * cr);
      B.uv.push(0, 0); B.col.push(_c.r, _c.g, _c.b); B.idx.push(base + i);
    }
  }
  const TP = {
    ico: () => tpl('ico', () => new THREE.IcosahedronGeometry(1, 1)),
    ico0: () => tpl('ico0', () => new THREE.IcosahedronGeometry(1, 0)),
    trunk: () => tpl('trunk', () => new THREE.CylinderGeometry(0.75, 1, 1, 5, 1, true).translate(0, 0.5, 0)),
    tank: () => tpl('tank', () => new THREE.CylinderGeometry(1, 1, 1, 10, 1, false).translate(0, 0.5, 0)),
    cone: () => tpl('cone', () => new THREE.ConeGeometry(1, 1, 10, 1, true).translate(0, 0.5, 0)),
    cube: () => tpl('cube', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
    wheel: () => tpl('wheel', () => new THREE.CylinderGeometry(1, 1, 1, 8, 1, false).rotateX(Math.PI / 2)),
  };
  const TREE_GREENS = tod === 'dusk' ? ['#3d5a2a', '#46652f', '#34502a', '#51702f'] : ['#2f5a2a', '#3a6a30', '#2a4f26', '#44702f', '#35622d', '#4d7a34'];
  function tree(x, z, sz, color) { // Lakeview parkway tree: trunk + 3 overlapping crowns (low-poly far away)
    rawTpl('paint', TP.trunk(), x, 0, z, 0.8, sz * 1.1, 0.8, '#4a3a2c');
    const c2 = new THREE.Color(color), far = Math.hypot(x, z) > 900, crown = far ? TP.ico0() : TP.ico();
    for (let k = 0; k < (far ? 2 : 3); k++) {
      const a = R() * 6.28, d = sz * 0.35;
      rawTpl('paint', crown, x + Math.cos(a) * d, sz * (1.55 + R() * 0.35), z + Math.sin(a) * d, sz * (0.7 + R() * 0.25), sz * (0.62 + R() * 0.2), sz * (0.7 + R() * 0.25), '#' + c2.clone().multiplyScalar(0.85 + R() * 0.3).getHexString());
    }
  }

  // ======================================================================
  // CROWDS (src/crowd.js): bowl + bleachers, rooftop decks, ballhawk clusters on the streets
  // ======================================================================
  const crowdLook = { crowd: LOOK.crowd, crowdShade: LOOK.crowdShade, night: LOOK.night };
  const mkCrowd = () => createCrowd(THREE, { parkId, quality, look: crowdLook, assets });
  const crowdMain = mkCrowd(), crowdRoof = mkCrowd();
  const hawks = []; // { crowd, obj, home:[x,z], street:'l'|'r' }
  const SECTION = { lfBleachers: 1, rfBleachers: 2, corner: 3, lowerDeck: 4, upperDeck: 5, rooftop: 6, backRail: 7, standing: 8, hawk: 9 };
  // Register a fan row along a polyline [[x,z],...] at seat height y (chunked so long curves stay smooth)
  function fanRow(crowd, line, y, o) {
    let acc = 0, start = line[0];
    for (let i = 1; i < line.length; i++) {
      acc += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (acc >= 14 || i === line.length - 1) { crowd.addRow([start[0], y, start[1]], [line[i][0], y, line[i][1]], o); start = line[i]; acc = 0; }
    }
  }

  // ======================================================================
  // RIBBON SWEEPS — each segment [v0,y0,v1,y1,color,glow] is extruded along a path (flat-shaded between
  // segments, smooth along the path). path[i] = { p:[x,z], n:[nx,nz] (outward), s }
  // ======================================================================
  const COLC = new Map(); const colOf = c => { let v = COLC.get(c); if (!v) { v = new THREE.Color(c); COLC.set(c, v); } return v; };
  function ribbons(path, segsFn, { uScale = 10, vScale = 10, vMode = 'len', vOf = null } = {}) {
    const S0 = segsFn(0, path[0]), ns = S0.length, np = path.length;
    const pos = new Float32Array(np * ns * 6), uv = new Float32Array(np * ns * 4), cl = new Float32Array(np * ns * 6), gl = new Float32Array(np * ns * 2);
    const acc = new Float64Array(ns * 2);
    for (let i = 0; i < np; i++) {
      const P = path[i], S = i ? segsFn(i, P) : S0;
      for (let j = 0; j < ns; j++) {
        const sg = S[j], c = sg[4] != null ? colOf(sg[4]) : null, len = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]);
        for (let e = 0; e < 2; e++) {
          const v = e ? sg[2] : sg[0], y = e ? sg[3] : sg[1], k = (i * ns + j) * 2 + e;
          const x = P.p[0] + P.n[0] * v, z = P.p[1] + P.n[1] * v;
          if (i) { const q = k - ns * 2; acc[j * 2 + e] += Math.hypot(x - pos[q * 3], z - pos[q * 3 + 2]); }
          pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
          uv[k * 2] = acc[j * 2 + e] / uScale;
          uv[k * 2 + 1] = vOf ? vOf(v, y) : vMode === 'y' ? y / vScale : (e ? len : 0) / vScale;
          if (c) { cl[k * 3] = c.r; cl[k * 3 + 1] = c.g; cl[k * 3 + 2] = c.b; } else { cl[k * 3] = cl[k * 3 + 1] = cl[k * 3 + 2] = 1; }
          gl[k] = sg[5] || 0;
        }
      }
    }
    const idx = [];
    for (let i = 0; i < np - 1; i++) for (let j = 0; j < ns; j++) { const a = (i * ns + j) * 2, b = a + 1, c = a + ns * 2, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(cl, 3)); g.setAttribute('glow', new THREE.BufferAttribute(gl, 1));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  // Polygon cap (profile outline [[v,y]...]) placed at path point p with offset dir n
  function capAt(p, n, outline, color, key = 'paint', uvS = null) {
    outline = outline.filter((q, i) => { const o = outline[(i + outline.length - 1) % outline.length]; return Math.abs(o[0] - q[0]) > 1e-4 || Math.abs(o[1] - q[1]) > 1e-4; });
    const sh = new THREE.Shape(outline.map(([v, y]) => new THREE.Vector2(v, y)));
    const g = new THREE.ShapeGeometry(sh), pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const v = pos.getX(i), y = pos.getY(i); pos.setXYZ(i, p[0] + n[0] * v, y, p[1] + n[1] * v); if (uvS) uv.setXY(i, v / uvS[0], y / uvS[1]); }
    g.deleteAttribute('normal'); g.computeVertexNormals();
    add(key, K.finish(g, color));
  }
  function offsetLine(path, v) { return path.map(({ p, n }) => [p[0] + n[0] * v, p[1] + n[1] * v]); }
  function walk(line, step, fn) { // fn(x,z,tx,tz,dist,i) every `step` along a polyline
    let acc = 0, next = step / 2;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      while (next <= acc + L) { const f = (next - acc) / L; fn(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, tx, tz, next, i); next += step; }
      acc += L;
    }
    return acc;
  }
  const vnoise = (x, y) => Math.sin(x * 0.9 + Math.sin(y * 1.7) * 2) * 0.5 + Math.sin(x * 0.37 - y * 0.8 + 1.3) * 0.35 + Math.sin(x * 2.3 + y * 0.4) * 0.15;

  mark('boundary');
  // ======================================================================
  // FIELD BOUNDARY — tiny foul territory, low brick wall, 58 ft backstop
  // ======================================================================
  const CFG = { foul: { near: 42, pole: 15, backstop: 58 }, wallH: 3.6, poleH: 66, eye: 7, rowD: 2.9 };
  const LpR = fenceAt(45), LpL = fenceAt(-45);
  const extGS = OF.depth;
  function wallOffset(u, Lp) { return u >= Lp ? CFG.foul.pole : lerp(CFG.foul.near, CFG.foul.pole, u / Lp); }
  function foulPt(sign, u) { const Lp = sign > 0 ? LpR : LpL, w = wallOffset(u, Lp); return [sign * SQ * u + sign * SQ * w, -SQ * u + SQ * w]; }
  function backstopPt(th) { const a = th <= 180 ? (th - 135) / 45 : (225 - th) / 45; const Rr = lerp(CFG.foul.near, CFG.foul.backstop, (1 - Math.cos(Math.PI * a)) / 2); return [Math.sin(th * D2R) * Rr, -Math.cos(th * D2R) * Rr]; }
  function spraySamples(a, b, step) {
    const set = new Set(); for (let s = a; s <= b + 1e-6; s += step) set.add(+s.toFixed(4));
    set.add(a); set.add(b); for (const [s] of PK.fence) if (s > a && s < b) set.add(s);
    return [...set].sort((x, y) => x - y);
  }
  const ofPath = ss => ss.map(s => { const r = fenceAt(s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
  function computeNormals(path) { // outward miter normals
    const segN = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i].p, b = path[i + 1].p, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      let n = [dz / L, -dx / L]; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2; if (n[0] * mx + n[1] * mz < 0) n = [-n[0], -n[1]];
      segN.push(n);
    }
    for (let i = 0; i < path.length; i++) {
      const n0 = segN[Math.max(0, i - 1)], n1 = segN[Math.min(segN.length - 1, i)];
      let nx = n0[0] + n1[0], nz = n0[1] + n1[1]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const c = Math.max(0.5, nx * n0[0] + nz * n0[1]); path[i].n = [nx / c, nz / c];
    }
  }
  // Grandstand path: RF corner → 1B wall → behind home → 3B wall → LF corner
  const gsPath = [];
  {
    const us = u0 => { const out = []; for (let u = 0; u < u0; u += 20) out.push(u); out.push(u0); return out; };
    const uR = [...new Set([...us(LpR), LpR, LpR + extGS])].sort((a, b) => b - a);
    for (const u of uR) gsPath.push({ p: foulPt(1, u), u, side: 1 });
    for (let th = 140; th <= 220; th += 4) gsPath.push({ p: backstopPt(th), u: 0, side: 0, th });
    const uL = [...new Set([...us(LpL), LpL, LpL + extGS])].sort((a, b) => a - b);
    for (const u of uL) gsPath.push({ p: foulPt(-1, u), u, side: -1 });
    for (let i = gsPath.length - 1; i > 0; i--) if (Math.hypot(gsPath[i].p[0] - gsPath[i - 1].p[0], gsPath[i].p[1] - gsPath[i - 1].p[1]) < 0.5) gsPath.splice(i, 1);
    computeNormals(gsPath);
  }
  // playing-field outline (floor polygon + warning track)
  const loop = [];
  {
    for (const s of spraySamples(-45, 45, 1)) { const r = fenceAt(s); loop.push([Math.sin(s * D2R) * r, -Math.cos(s * D2R) * r]); }
    for (const u of [LpR, ...Array.from({ length: 16 }, (_, k) => LpR * (1 - (k + 1) / 16))]) loop.push(foulPt(1, u));
    for (let th = 140; th <= 220; th += 5) loop.push(backstopPt(th));
    for (let k = 0; k <= 16; k++) loop.push(foulPt(-1, LpL * k / 16));
  }
  let area = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const orient = Math.sign(area) || 1;

  mark('field');
  // ======================================================================
  // FIELD SURFACE — Kentucky bluegrass crosshatch, reddish clay, RED warning track
  // ======================================================================
  {
    const shape = new THREE.Shape(); loop.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2);
    g.deleteAttribute('normal'); K.finish(g, null, { zone: 0 });
    add('field', g);
    const rings = 14, segs = 48, rows = [];
    for (let i = 0; i <= rings; i++) {
      const rr = 9.6 * i / rings, row = [];
      for (let j = 0; j <= segs; j++) { const a = j / segs * Math.PI * 2, x = Math.cos(a) * rr, z = -59 + Math.sin(a) * rr; const d = Math.hypot(x, z + 60.2); row.push([x, 0.83 * (1 - smooth(1.6, 9.2, d)) - 0.03, z]); }
      rows.push(row);
    }
    add('field', K.grid(rows, null, null, { zone: 0 }));
    const n = loop.length, inner = [];
    const segNormal = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [-dz / L * orient, dx / L * orient]; };
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
      const n0 = segNormal(a, b), n1 = segNormal(b, c);
      let nx = n0[0] + n1[0], nz = n0[1] + n1[1]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const w = Math.hypot(b[0], b[1]) > 200 ? 15 : 9; // 15 ft track in the outfield, narrower along the brick in foul ground
      const k = w / Math.max(0.55, nx * n0[0] + nz * n0[1]); inner.push([b[0] + nx * k, b[1] + nz * k]);
    }
    const rowsT = []; for (let i = 0; i <= n; i++) { const k = i % n; rowsT.push([[loop[k][0], 0.12, loop[k][1]], [inner[k][0], 0.12, inner[k][1]]]); }
    add('field', K.grid(rowsT, null, null, { zone: 1 }));
  }
  M.field = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side, envMapIntensity: LOOK.wet ? 0.55 : 1 });
  disposables.push(M.field);
  const fieldU = {
    uNoise: { value: T.noise }, uGrass: { value: col(PAL.grass).multiplyScalar(1.02) }, uDirt: { value: col('#9a5d3c') }, uDirtDark: { value: col('#7e4a2e') },
    uTrack: { value: col(PAL.track) }, uChalk: { value: col('#f6f3ea') }, uStripeW: { value: 16 }, uWet: { value: LOOK.wet }, uDry: { value: LOOK.dry },
  };
  M.field.customProgramCacheKey = () => 'wr-field';
  M.field.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, fieldU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float zone;\nvarying float vZone;\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvZone = zone;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying float vZone; varying vec3 vWP;
uniform sampler2D uNoise; uniform vec3 uGrass, uDirt, uDirtDark, uTrack, uChalk; uniform float uStripeW, uWet, uDry;
float gRough;
float fillAA(float sd){ float w = fwidth(sd) * 0.8 + 1e-4; return 1.0 - smoothstep(-w, w, sd); }
float lineAA(float d, float hw){ return fillAA(abs(d) - hw); }
float sdBox2(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sqWave(float x){ float fw = fwidth(x) + 1e-4; float t = abs(fract(x) - 0.5); float s = clamp((t - 0.25) / fw + 0.5, 0.0, 1.0); return mix(s, 0.5, smoothstep(0.25, 0.6, fw)); }
vec3 fieldColor(){
  vec2 p = vWP.xz;
  float a = dot(p, vec2(0.70710678, -0.70710678));
  float b = dot(p, vec2(-0.70710678, -0.70710678));
  vec3 nz = texture2D(uNoise, p / 150.0).rgb, nm = texture2D(uNoise, p / 21.0).rgb, nf = texture2D(uNoise, p / 2.3).rgb;
  vec3 V = normalize(vWP - cameraPosition);
  // crosshatch: two mowing passes parallel to the foul lines; each pass's sheen depends on the view direction
  float s1 = sqWave(a / (2.0 * uStripeW)), s2 = sqWave(b / (2.0 * uStripeW));
  float va = clamp(dot(V.xz, vec2(0.7071, -0.7071)) * 2.4, -1.0, 1.0), vb = clamp(dot(V.xz, vec2(-0.7071, -0.7071)) * 2.4, -1.0, 1.0);
  float sheen = (s1 * 2.0 - 1.0) * va * 0.55 + (s2 * 2.0 - 1.0) * vb * 0.55;
  vec3 grass = uGrass * (1.0 + sheen * 0.1);
  grass *= mix(0.88, 1.08, nz.r) * mix(0.93, 1.05, nm.g) * mix(0.9, 1.1, nf.b);
  grass = mix(grass, grass * vec3(1.08, 1.05, 0.8), smoothstep(0.58, 0.86, nz.g) * 0.3);
  grass *= mix(1.0, 0.8, uWet);
  grass = mix(grass, grass * vec3(1.18, 1.06, 0.62), uDry * (0.16 + 0.22 * smoothstep(0.45, 0.85, nz.b)));
  float dArc = max(length(p - vec2(0.0, -60.5)) - 95.0, max(-a - 3.0, -b - 3.0));
  float sq = sdBox2(vec2(a, b), vec2(45.0), vec2(42.0));
  float dirtSd = max(dArc, -sq);
  float dHome = length(p - vec2(0.0, -0.7)) - 13.0;
  float dMound = length(p - vec2(0.0, -59.0)) - 9.0;
  vec2 odc = vec2(abs(p.x) - 26.0, p.y - 10.0); float dOnDeck = length(odc) - 2.6;
  // base cut-outs + the path from home to the mound is grass at Wrigley (dirt only at the plate & mound)
  dirtSd = min(min(dirtSd, dHome), min(dMound, dOnDeck));
  float dirtM = fillAA(dirtSd);
  vec3 nx = texture2D(uNoise, p / 0.55).rgb;
  vec3 dirt = uDirt * mix(0.84, 1.1, nm.r) * mix(0.86, 1.1, nf.g) * mix(0.86, 1.1, nx.b) * mix(0.92, 1.05, texture2D(uNoise, p / 6.5).r);
  dirt *= 1.0 - 0.05 * sqWave(dot(p, vec2(0.6, 0.8)) / 1.1) * smoothstep(20.0, 60.0, length(p));
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 2.5, length(p - vec2(0.0, -60.2))) * 0.7);
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 3.0, length(p - vec2(0.0, -0.7))) * 0.4);
  dirt = mix(dirt, uDirtDark, (1.0 - smoothstep(0.0, 4.0, abs(length(vec2(a, b) - vec2(90.0, 0.0)) - 3.0))) * 0.0);
  dirt *= mix(vec3(1.0), vec3(0.72, 0.66, 0.62), uWet);
  grass *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 1.4, dirtSd)) * step(0.0, dirtSd);
  vec3 c = mix(grass, dirt, dirtM);
  gRough = mix(mix(0.82, 0.98, nf.r), 1.0, dirtM);
  float trk = step(0.5, vZone);
  vec3 track = uTrack * mix(0.82, 1.1, nm.b) * mix(0.88, 1.1, nf.r) * mix(0.92, 1.06, nx.g) * mix(1.0, 0.62, uWet);
  c = mix(c, track, trk);
  float lw = 0.17, ch = 0.0;
  ch = max(ch, lineAA(b, lw) * step(5.3, a));
  ch = max(ch, lineAA(a, lw) * step(5.3, b));
  float bx = sdBox2(vec2(abs(p.x), p.y), vec2(3.208, -0.708), vec2(2.0, 3.0));
  ch = max(ch, lineAA(bx, 0.14));
  float cb = sdBox2(p, vec2(0.0, 6.29), vec2(1.79, 4.0));
  ch = max(ch, lineAA(cb, 0.14) * step(2.45, p.y) * (1.0 - trk));
  ch = max(ch, lineAA(b + 3.0, 0.14) * step(45.0, a) * step(a, 90.0));
  float cbL = sdBox2(vec2(a, b), vec2(80.0, -17.0), vec2(10.0, 5.0));
  float cbR = sdBox2(vec2(a, b), vec2(-17.0, 80.0), vec2(5.0, 10.0));
  ch = max(ch, lineAA(min(abs(cbL), abs(cbR)), 0.12) * (1.0 - trk));
  ch = max(ch, lineAA(dOnDeck, 0.12));
  ch *= mix(0.85, 1.0, nf.r);
  c = mix(c, uChalk * mix(1.0, 0.8, uWet), ch);
  gRough = mix(gRough, 0.8, ch);
  gRough = mix(gRough, mix(0.72, 0.5, dirtM), uWet);
  return c;
}`)
      .replace('#include <map_fragment>', 'diffuseColor.rgb = fieldColor();')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gRough;');
  };
  // Home plate, bases, rubber
  {
    const plate = new THREE.Shape([[0, 0], [0.708, -0.708], [0.708, -1.417], [-0.708, -1.417], [-0.708, -0.708]].map(([x, z]) => new THREE.Vector2(x, -z)));
    const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.08, bevelEnabled: false }); pg.rotateX(-Math.PI / 2); pg.deleteAttribute('normal'); pg.computeVertexNormals();
    add('paint', K.finish(pg, '#f4f2ec'));
    for (const [x, z] of [[63.64, -63.64], [0, -127.28], [-63.64, -63.64]]) add('paint', K.box(x, 0.15, z, 1.25, 0.3, 1.25, '#f7f6f0', Math.PI / 4));
    add('paint', K.box(0, 0.83, -60.75, 2, 0.12, 0.5, '#f7f6f0'));
  }

  mark('wall');
  // ======================================================================
  // 1. THE IVY WALL — brick, Boston ivy (displaced sheet + leaf cards), hand-trimmed around the distance
  //    markers, 6 maintenance doors and the bullpen windows; the basket above; 15 ft wells in the corners.
  // ======================================================================
  const pathOF = ofPath(spraySamples(-45, 45, 0.5));
  const pathFine = ofPath(spraySamples(-45, 45, 0.25));
  const accU = [0]; for (let i = 1; i < pathFine.length; i++) accU.push(accU[i - 1] + Math.hypot(pathFine[i].p[0] - pathFine[i - 1].p[0], pathFine[i].p[1] - pathFine[i - 1].p[1]));
  const wallLen = accU[accU.length - 1];
  const uAtSpray = s => { for (let i = 1; i < pathFine.length; i++) if (pathFine[i].s >= s) { const f = (s - pathFine[i - 1].s) / (pathFine[i].s - pathFine[i - 1].s || 1); return lerp(accU[i - 1], accU[i], f); } return wallLen; };
  const wallAtU = u => { // point/normal/spray on the wall line at arc length u
    let i = 1; while (i < accU.length - 1 && accU[i] < u) i++;
    const f = clamp((u - accU[i - 1]) / (accU[i] - accU[i - 1] || 1), 0, 1), a = pathFine[i - 1], b = pathFine[i];
    const n = [lerp(a.n[0], b.n[0], f), lerp(a.n[1], b.n[1], f)], L = Math.hypot(n[0], n[1]) || 1;
    return { p: [lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f)], n: [n[0] / L, n[1] / L], s: lerp(a.s, b.s, f) };
  };
  // ivy-free cut-outs (u = arc length along the wall, y) — markers, doors, bullpen windows
  const CUT = [];
  const MARKERS = [[-45, -43.2], [-24, -24], [0, 0], [24, 24], [45, 43.2]];
  for (const [sv, sp] of MARKERS) { const u = uAtSpray(sp); CUT.push({ kind: 'marker', u0: u - 3.7, u1: u + 3.7, y0: 5.6, y1: 9.7, s: sp, text: String(Math.round(fenceAt(sv))) }); }
  for (const sp of [-38.2, -18.5, -8.6, 8.6, 18.5, 38.2]) { const u = uAtSpray(sp); CUT.push({ kind: 'door', u0: u - 2.7, u1: u + 2.7, y0: 0, y1: 8.6, s: sp }); }
  for (const [a, b] of [[-31.6, -27.2], [27.2, 31.6]]) CUT.push({ kind: 'pen', u0: uAtSpray(a), u1: uAtSpray(b), y0: 2.4, y1: 7.0, s: (a + b) / 2 });
  const inCut = (u, y, m = 0) => CUT.some(c => u > c.u0 - m && u < c.u1 + m && y > c.y0 - m && y < c.y1 + m);
  const ivyTop = (u, s) => wallH(s) + 0.22 + 0.42 * (0.5 + 0.5 * vnoise(u * 0.23, 3.1)) + 0.25 * Math.max(0, vnoise(u * 0.9, 7.7));
  const ivyBot = u => 0.45 + 0.28 * (0.5 + 0.5 * vnoise(u * 0.31, 1.7));
  const ivyOut = (u, y) => 0.32 + 0.55 * (0.5 + 0.5 * vnoise(u * 0.35, y * 0.45)) + 0.18 * vnoise(u * 1.3, y * 1.1);
  // brick wall behind the ivy + wall cap (concrete coping) + well walls
  add('brick', ribbons(pathOF, (i, P) => [[0.12, 0, 0.12, wallH(P.s), '#b8a8a0']], { uScale: 4, vScale: 3.6, vMode: 'y' }));
  add('paint', ribbons(pathOF, (i, P) => [[-0.2, wallH(P.s), 1.5, wallH(P.s), '#5b5a52'], [-0.2, wallH(P.s) - 0.5, -0.2, wallH(P.s), '#4c4b45']]));
  // ivy sheet with holes
  {
    const NJ = LOW ? 5 : 9, np = pathFine.length, pos = [], uv = [], idx = [];
    for (let i = 0; i < np; i++) {
      const P = pathFine[i], u = accU[i], yb = ivyBot(u), yt = ivyTop(u, P.s);
      for (let j = 0; j <= NJ; j++) {
        const t = j / NJ, y = lerp(yb, yt, t);
        let d = j === 0 ? 0.12 : ivyOut(u, y) * (j === NJ ? 0.55 : 1);
        let v = -d; if (j === NJ) v = 0.35 + 0.3 * (0.5 + 0.5 * vnoise(u * 0.5, 9)); // top row curls over the coping
        pos.push(P.p[0] + P.n[0] * v, j === NJ ? yt + 0.15 : y, P.p[1] + P.n[1] * v);
        uv.push(u / 11, y / 11);
      }
    }
    const W = NJ + 1;
    for (let i = 0; i < np - 1; i++) for (let j = 0; j < NJ; j++) {
      const ya = pos[(i * W + j) * 3 + 1], yb2 = pos[(i * W + j + 1) * 3 + 1];
      if (CUT.some(c => accU[i + 1] > c.u0 && accU[i] < c.u1 && yb2 > c.y0 && ya < c.y1)) continue;
      const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, d = i * W + j + 1; idx.push(a, b, d, b, c, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); add('ivy', g);
  }
  // leaf cards: ragged top silhouette, leaves standing off the face, a little over the coping
  {
    const N = HIGH ? 7600 : quality === 'medium' ? 3400 : 0;
    const up = [0, 1, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = a => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
    const rot = (v, k, a) => { const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2], x = cross(k, v); return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)]; };
    for (let k = 0; k < N; k++) {
      const top = k < N * 0.38, u = R() * wallLen, W0 = wallAtU(u), H = wallH(W0.s);
      let y, out;
      if (top) { y = H - 0.35 + R() * 1.0; out = ivyOut(u, y) * 0.6 + 0.1 - (R() < 0.35 ? 0.9 : 0); }
      else { y = ivyBot(u) + 0.3 + R() * (H - ivyBot(u) - 0.5); out = ivyOut(u, y) + 0.04 + R() * 0.3; }
      if (inCut(u, y, 0.45) || (top && inCut(u, H - 1, 0.3))) continue;
      const F = [-W0.n[0], 0, -W0.n[1]], Tg = [-W0.n[1], 0, W0.n[0]];
      const pitch = top ? -(0.3 + R() * 0.9) : (R() - 0.35) * 1.1, yaw = (R() - 0.5) * 0.9, roll = (R() - 0.5) * 2.6;
      let U = rot(up, Tg, pitch), Tt = Tg.slice();
      U = rot(U, up, yaw); Tt = rot(Tt, up, yaw);
      const Nn = norm(cross(Tt, U)); const U2 = rot(U, Nn, roll), T2 = rot(Tt, Nn, roll);
      const sz = (top ? 1.2 : 0.95) + R() * 0.7, hx = sz * 0.5, hy = sz * 0.5;
      const c = [W0.p[0] - W0.n[0] * out, y, W0.p[1] - W0.n[1] * out];
      const P = (sx, sy) => [c[0] + T2[0] * sx * hx + U2[0] * sy * hy, c[1] + T2[1] * sx * hx + U2[1] * sy * hy, c[2] + T2[2] * sx * hx + U2[2] * sy * hy];
      const cell = Math.floor(R() * 16), cx = cell % 4, cy = Math.floor(cell / 4);
      const t = 0.78 + R() * 0.36, yel = R() < 0.2 ? 1 : 0;
      const tint = new THREE.Color(t * (yel ? 1.08 : 1), t * (yel ? 1.06 : 1), t * (yel ? 0.78 : 1));
      const nrm = norm([F[0] * 0.8, 0.45, F[2] * 0.8]);
      rawQuad('leaves', P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), tint, [cx / 4 + 0.004, 1 - (cy + 1) / 4 + 0.004, (cx + 1) / 4 - 0.004, 1 - cy / 4 - 0.004], null, nrm);
    }
  }
  // cut-out contents: distance-marker plates, green steel doors, bullpen windows (brick reveals around them)
  const SIGNS = []; // { text, kind, quad:[a,b,c,d], glow }
  for (const c of CUT) {
    const um = (c.u0 + c.u1) / 2, W0 = wallAtU(um), tg = [-W0.n[1], W0.n[0]], w = c.u1 - c.u0;
    const at = (du, y, v) => [W0.p[0] + tg[0] * du + W0.n[0] * v, y, W0.p[1] + tg[1] * du + W0.n[1] * v];
    if (c.kind === 'marker') {
      SIGNS.push({ kind: 'marker', text: c.text, quad: [at(-w / 2 + 0.35, c.y0 + 0.3, -0.9), at(w / 2 - 0.35, c.y0 + 0.3, -0.9), at(w / 2 - 0.35, c.y1 - 0.3, -0.9), at(-w / 2 + 0.35, c.y1 - 0.3, -0.9)] });
      add('paint', K.quad(at(-w / 2 + 0.2, c.y0 + 0.15, -0.85), at(w / 2 - 0.2, c.y0 + 0.15, -0.85), at(w / 2 - 0.2, c.y1 - 0.15, -0.85), at(-w / 2 + 0.2, c.y1 - 0.15, -0.85), '#20241f'));
      for (const du of [-w / 2 + 1.2, w / 2 - 1.2]) add('paint', K.bar(at(du, c.y0 + 0.4, -0.85), at(du, c.y0 + 0.4, 0.1), 0.18, '#3a3d38'));
    } else if (c.kind === 'door') {
      add('paint', K.quad(at(-w / 2 + 0.55, 0, 0.0), at(w / 2 - 0.55, 0, 0.0), at(w / 2 - 0.55, c.y1 - 0.5, 0.0), at(-w / 2 + 0.55, c.y1 - 0.5, 0.0), '#2c4a37'));
      add('paint', K.quad(at(-w / 2 + 0.3, c.y1 - 0.5, -0.05), at(w / 2 - 0.3, c.y1 - 0.5, -0.05), at(w / 2 - 0.3, c.y1 - 0.2, -0.05), at(-w / 2 + 0.3, c.y1 - 0.2, -0.05), '#6d6c66'));
      add('paint', K.quad(at(-0.05, 0.2, -0.03), at(0.05, 0.2, -0.03), at(0.05, c.y1 - 0.8, -0.03), at(-0.05, c.y1 - 0.8, -0.03), '#1a2c21'));
      add('paint', K.box(...at(0.9, 4.1, -0.12), 0.35, 0.12, 0.2, '#b9b6a8'));
    } else {
      const gw = w - 1.2, n = Math.max(2, Math.round(gw / 5));
      add('glass', K.quad(at(-gw / 2, c.y0 + 0.4, 0.02), at(gw / 2, c.y0 + 0.4, 0.02), at(gw / 2, c.y1 - 0.4, 0.02), at(-gw / 2, c.y1 - 0.4, 0.02), '#24463a', null, { glow: 0.35 }));
      for (let q = 0; q <= n; q++) { const du = -gw / 2 + gw * q / n; add('paint', K.quad(at(du - 0.18, c.y0 + 0.4, -0.02), at(du + 0.18, c.y0 + 0.4, -0.02), at(du + 0.18, c.y1 - 0.4, -0.02), at(du - 0.18, c.y1 - 0.4, -0.02), '#1c3326')); }
      add('paint', K.quad(at(-gw / 2 - 0.2, c.y0 + 0.2, -0.1), at(gw / 2 + 0.2, c.y0 + 0.2, -0.1), at(gw / 2 + 0.2, c.y0 + 0.45, -0.1), at(-gw / 2 - 0.2, c.y0 + 0.45, -0.1), '#8e8a7e'));
    }
  }
  // the basket: chain-link from 2 ft below the wall top, 3 ft out and 1 ft above it, with a steel lip + arms
  {
    const bp = ofPath(spraySamples(-39.6, 39.6, 0.5));
    add('chain', ribbons(bp, (i, P) => [[0.05, wallH(P.s) - 2.0, -3.0, wallH(P.s) + 1.0, null]], { uScale: 0.3, vScale: 0.3 }));
    add('paint', ribbons(bp, (i, P) => { const H = wallH(P.s) + 1.0; return [[-2.95, H - 0.1, -3.2, H - 0.1, '#5f6862'], [-3.2, H - 0.1, -3.2, H + 0.14, '#6e7670'], [-3.2, H + 0.14, -2.95, H + 0.14, '#7d857f']]; }));
    walk(offsetLine(bp, 0), 14, (x, z, tx, tz) => { const nx = tz, nz = -tx, s = sprayOf(x, z), H = wallH(s), o = (nx * x + nz * z) > 0 ? 1 : -1; add('paint', K.bar([x, H - 2.0, z], [x - nx * o * 3.1, H + 1.0, z - nz * o * 3.1], 0.09, '#6e7670')); });
  }
  // foul poles (yellow) with fair-side screens; pennants added with the flags
  const POLES = [];
  for (const sg of [-1, 1]) {
    const s = 45 * sg, r = fenceAt(s), [x, , z] = polar(s, r);
    add('paint', K.cyl(x, 0, z, x, CFG.poleH, z, 0.75, 0.45, 12, PAL.pole));
    add('paint', K.cyl(x, CFG.poleH, z, x, CFG.poleH + 0.8, z, 0.5, 0.05, 8, PAL.pole));
    const t = dirXZ(s - 90 * sg);
    add('screen', K.quad([x, wallH(s) + 0.5, z], [x + t[0] * 2.6, wallH(s) + 0.5, z + t[1] * 2.6], [x + t[0] * 2.6, CFG.poleH - 4, z + t[1] * 2.6], [x, CFG.poleH - 4, z], null, [0, 0, 2.6 / 0.3, (CFG.poleH - 4 - wallH(s)) / 0.3]));
    add('paint', K.cyl(x + t[0] * 2.6, wallH(s) + 0.5, z + t[1] * 2.6, x + t[0] * 2.6, CFG.poleH - 4, z + t[1] * 2.6, 0.12, 0.12, 5, PAL.pole));
    POLES.push({ x, z, s });
  }
  M.screen = new THREE.MeshStandardMaterial({ map: T.chain, transparent: true, depthWrite: false, alphaTest: 0.01, side, roughness: 0.6, color: col('#ffd21a') }); disposables.push(M.screen);

  mark('bleachers');
  // ======================================================================
  // 4. BLEACHERS — boomerang deck well to well: concrete steps, green benches, aisles, back rail;
  //    the CF batter's eye (juniper bed + dark-glass suite) between them. Treads sit on surfaceHeight().
  // ======================================================================
  const ROWS = [];
  for (let d = 1.5; d + CFG.rowD <= OF.depth - 1.3; d += CFG.rowD) ROWS.push({ d0: d, d1: d + CFG.rowD, y: +sH(d + CFG.rowD * 0.5).toFixed(3) });
  const lastRow = ROWS[ROWS.length - 1];
  const CONC = '#a29e94', RISER = '#737069', CAPC = '#5b5a52';
  const treadSegs = H => {
    const out = []; let yp = H;
    for (const r of ROWS) { out.push([r.d0, yp, r.d0, r.y, RISER], [r.d0, r.y, r.d1, r.y, CONC]); yp = r.y; }
    out.push([lastRow.d1, yp, lastRow.d1, OF.topH, RISER], [lastRow.d1, OF.topH, OF.depth, OF.topH, CONC]);
    return out;
  };
  const cornerPath = sign => { // straight fill from the pole into foul ground (joins the grandstand end)
    const Lp = sign > 0 ? LpR : LpL, L = [sign * SQ, -SQ], N = [sign * SQ, SQ], out = [];
    for (let k = 0; k <= 3; k++) { const w = CFG.foul.pole * k / 3; out.push({ p: [L[0] * Lp + N[0] * w, L[1] * Lp + N[1] * w], n: L, s: 45 * sign }); }
    return out;
  };
  const cornerR = cornerPath(1), cornerL = cornerPath(-1);
  for (const cp of [cornerR, cornerL]) {
    add('brick', ribbons(cp, () => [[0.12, 0, 0.12, WELL_H, '#b8a8a0']], { uScale: 4, vScale: 3.6, vMode: 'y' }));
    add('ivy', ribbons(cp, (i, P) => [[-0.5 - 0.3 * (i % 2), 0.5, -0.45, WELL_H + 0.45, null]], { uScale: 11, vScale: 11, vMode: 'y' }));
    add('paint', ribbons(cp, () => [[-0.2, WELL_H, 1.5, WELL_H, '#5b5a52']]));
  }
  const eye = CFG.eye;
  const secL = ofPath(spraySamples(-45, -eye, 0.5)), secR = ofPath(spraySamples(eye, 45, 0.5));
  for (const pth of [secL, secR, cornerR, cornerL]) add('paint', ribbons(pth, (i, P) => treadSegs(wallH(P.s))));
  // side walls of the stepped sections (facing the batter's eye and the grandstand ends)
  const stepOutline = H => { const o = [[0, 0], [0, H], [1.5, H]]; let yp = H; for (const r of ROWS) { o.push([r.d0, yp], [r.d0, r.y]); yp = r.y; } o.push([lastRow.d1, yp], [lastRow.d1, OF.topH], [OF.depth, OF.topH], [OF.depth, 0]); return o; };
  for (const e of [secL[secL.length - 1], secR[0], cornerR[cornerR.length - 1], cornerL[cornerL.length - 1]]) capAt(e.p, e.n, stepOutline(wallH(e.s)), '#8d8a81');
  // benches (split by aisles) + fans on them
  const AISLES = [-39, -31, -23, -15, 15, 23, 31, 39];
  const benchSegs = () => { const out = []; for (const r of ROWS) out.push([r.d0 + 0.6, r.y + 1.0, r.d0 + 0.6, r.y + 1.42, '#1f4631'], [r.d0 + 0.6, r.y + 1.42, r.d0 + 1.6, r.y + 1.42, '#2c6044'], [r.d0 + 1.1, r.y, r.d0 + 1.1, r.y + 1.0, '#3b3d3a']); return out; };
  const benchRuns = [];
  for (const [a, b] of [[-44.6, -eye - 0.4], [eye + 0.4, 44.6]]) {
    const cuts = [a, ...AISLES.filter(x => x > a && x < b).flatMap(x => [x - 0.32, x + 0.32]), b];
    for (let k = 0; k < cuts.length; k += 2) benchRuns.push(ofPath(spraySamples(cuts[k], cuts[k + 1], 0.5)));
  }
  benchRuns.push(cornerR, cornerL);
  for (const run of benchRuns) {
    add('paint', ribbons(run, () => benchSegs()));
    const sL = run[0].s < 0, corner = run === cornerR || run === cornerL;
    for (const r of ROWS) fanRow(crowdMain, offsetLine(run, r.d0 + 1.1), r.y + 1.42, { spacing: 1.85, fill: 0.95, kind: 0, section: corner ? SECTION.corner : sL ? SECTION.lfBleachers : SECTION.rfBleachers });
  }
  // back rail + standing-room fans along it (they look out over Waveland / Sheffield)
  for (const pth of [secL, secR, cornerR, cornerL]) {
    add('paint', ribbons(pth, () => [[OF.depth - 0.35, OF.topH, OF.depth - 0.35, OF.topH + 3.3, '#233f2e'], [OF.depth - 0.35, OF.topH + 3.3, OF.depth + 0.2, OF.topH + 3.3, '#2d5139']]));
    fanRow(crowdMain, offsetLine(pth, OF.depth - 1.1), OF.topH, { spacing: 2.4, fill: 0.4, kind: 2, section: SECTION.backRail });
  }
  // batter's eye: juniper bed rising to the dark-glass suite under the scoreboard
  {
    const ss = spraySamples(-eye, eye, 0.25), rows = [], uvs = [], dN = 14;
    let u = 0, prev = null;
    for (const s of ss) {
      const P = ofPath([s])[0]; if (prev) u += Math.hypot(P.p[0] - prev[0], P.p[1] - prev[1]); prev = P.p;
      const row = [], uvr = [];
      for (let k = 0; k <= dN; k++) {
        const d = k === 0 ? 1.5 : lerp(1.5, 44, k / dN), y = k === 0 ? wallH(s) : sH(d) + 0.5 + 0.8 * (0.5 + 0.5 * vnoise(u * 0.4, d * 0.5));
        row.push([P.p[0] + P.n[0] * d, y, P.p[1] + P.n[1] * d]); uvr.push([u / 9, (d + (k === 0 ? -1.5 : 0)) / 9]);
      }
      rows.push(row); uvs.push(uvr);
    }
    add('juniper', K.grid(rows, uvs));
    const eyeP = ofPath(ss);
    add('paint', ribbons(eyeP, () => [[1.5, wallH(0) - 0.1, 1.5, wallH(0) + 1.2, '#2f4a35']]));
    const y44 = sH(44);
    add('glass', ribbons(eyeP, () => [[44.2, y44 + 0.3, 44.2, OF.topH - 0.9, '#16241e', 0.35]]));
    add('paint', ribbons(eyeP, () => [[44.0, y44 - 0.2, 44.0, y44 + 0.3, '#2b2d2b'], [44.1, OF.topH - 0.9, 44.1, OF.topH, '#1d3a29'], [44.1, OF.topH, OF.depth, OF.topH, '#2a2c2a']]));
    walk(offsetLine(eyeP, 44.0), 7.5, (x, z) => add('paint', K.cyl(x, y44 + 0.3, z, x, OF.topH - 0.9, z, 0.18, 0.18, 4, '#1b3025')));
  }
  // bleacher exterior facing the streets: brick with arched gates, a green steel frieze on top
  {
    const back = ofPath(spraySamples(-45, 45, 1));
    add('brick', ribbons(back, () => [[OF.depth + 0.05, 0, OF.depth + 0.05, OF.topH - 5, '#c0b0a6']], { uScale: 4, vScale: 3.6, vMode: 'y' }));
    add('paint', ribbons(back, () => [[OF.depth + 0.05, OF.topH - 5, OF.depth + 0.05, OF.topH + 0.6, '#264532'], [OF.depth + 0.05, OF.topH + 0.6, OF.depth + 0.8, OF.topH + 0.6, '#2f523b']]));
    walk(offsetLine(back, OF.depth + 0.12), 24, (x, z, tx, tz) => {
      const a = [x - tx * 4, 0.3, z - tz * 4], b = [x + tx * 4, 0.3, z + tz * 4];
      add('paint', K.quad(a, b, [b[0], 9.5, b[2]], [a[0], 9.5, a[2]], '#1d2b22', null, { glow: 0.12 }));
      add('paint', K.quad([a[0], 9.5, a[2]], [b[0], 9.5, b[2]], [b[0], 10.2, b[2]], [a[0], 10.2, a[2]], '#b9ad97'));
      for (const h of [16, 24, 32]) add('paint', K.quad([x - tx * 3, h, z - tz * 3], [x + tx * 3, h, z + tz * 3], [x + tx * 3, h + 3.4, z + tz * 3], [x - tx * 3, h + 3.4, z - tz * 3], '#253028', null, { glow: 0.25 }));
    });
    for (const cp of [cornerR, cornerL]) { const e = cp[cp.length - 1]; capAt([e.p[0] + e.n[0] * 0, e.p[1] + e.n[1] * 0], e.n, [[OF.depth, 0], [OF.depth, OF.topH + 0.6], [OF.depth + 0.8, OF.topH + 0.6], [OF.depth + 0.8, 0]], '#7f4a38'); }
  }

  mark('scoreboard');
  // ======================================================================
  // 2. THE HAND-OPERATED CF SCOREBOARD — forest-green steel, white numerals, the dot clock in its raised
  //    crown, the cross-shaped flag masthead (US flag + three strands of generic pennants), floodlights.
  //    Flat face at z = SBZ (the sim face is fenceDistance+stands.depth: 451.8 ft at ±5°, 458 ft at 0°).
  // ======================================================================
  const SBZ = -(scoreboardDistance(parkId, -2.5) * Math.cos(2.5 * D2R));
  const SBHW = Math.abs(SBZ) * Math.tan(SB.spray[1] * D2R), SBY0 = 60, SBY1 = SB.h, SBZ1 = SBZ - SB.depth;
  const CROWN = { hw: 8.6, y1: SBY1 + 10.4, z0: SBZ - 0.6, z1: SBZ - 6.8 }, MAST = { top: CROWN.y1 + 40, arm: CROWN.y1 + 29.5, z: SBZ - 3.6 };
  const BW = LOW ? 1024 : 2048, BH = BW / 2, FACE_H = Math.round(BW * (SBY1 - SBY0) / (2 * SBHW));
  const boardCanvas = mkCanvas(BW, BH), bg = boardCanvas.getContext('2d');
  T.board = tex(boardCanvas, { wrap: 'clamp' });
  M.board = new THREE.MeshStandardMaterial({ map: T.board, emissiveMap: T.board, emissive: col('#ffffff'), emissiveIntensity: LOOK.board, roughness: 0.82, metalness: 0.1, side });
  disposables.push(M.board);
  {
    const G = '#1d4431', GD = '#15352a', z0 = SBZ;
    add('board', K.quad([-SBHW, SBY0, z0 + 0.08], [SBHW, SBY0, z0 + 0.08], [SBHW, SBY1, z0 + 0.08], [-SBHW, SBY1, z0 + 0.08], null, [0, 1 - FACE_H / BH, 1, 1]));
    add('paint', K.box(0, (SBY0 - 1.6 + SBY1) / 2, (z0 - 0.3 + SBZ1) / 2, 2 * SBHW + 1.6, SBY1 - SBY0 + 1.6, Math.abs(SBZ1 - (z0 - 0.3)), G));
    // open steel frame between the bleacher rim and the board (sky shows through)
    const zf = z0 - 1.0, zb = SBZ1 + 1.0, posts = 7;
    for (let k = 0; k < posts; k++) {
      const x = -SBHW + 0.8 + k * (2 * SBHW - 1.6) / (posts - 1);
      for (const zz of [zf, zb]) add('paint', K.box(x, (OF.topH + SBY0) / 2, zz, 1.3, SBY0 - OF.topH, 1.3, GD));
      add('paint', K.box(x, OF.topH + 0.8, (zf + zb) / 2, 0.9, 1.6, zf - zb, GD));
      if (k < posts - 1) { const x2 = -SBHW + 0.8 + (k + 1) * (2 * SBHW - 1.6) / (posts - 1); add('paint', K.bar([x, OF.topH + 1, zf], [x2, SBY0 - 2, zf], 0.55, GD)); add('paint', K.bar([x2, OF.topH + 1, zf], [x, SBY0 - 2, zf], 0.55, GD)); }
    }
    add('paint', K.box(0, OF.topH + 0.8, zf, 2 * SBHW, 1.6, 1.2, GD)); add('paint', K.box(0, OF.topH + 0.8, zb, 2 * SBHW, 1.6, 1.2, GD));
    // bezel around the face
    for (const [x0, x1, y0, y1] of [[-SBHW - 0.8, SBHW + 0.8, SBY1 - 0.2, SBY1 + 0.7], [-SBHW - 0.8, SBHW + 0.8, SBY0 - 0.8, SBY0 + 0.15], [-SBHW - 0.8, -SBHW + 0.15, SBY0, SBY1], [SBHW - 0.15, SBHW + 0.8, SBY0, SBY1]])
      add('paint', K.box((x0 + x1) / 2, (y0 + y1) / 2, z0 + 0.1, x1 - x0, y1 - y0, 0.6, GD));
    // base: vertical steel ribs, operator windows, catwalk + railing
    add('paint', K.box(0, SBY0 - 1.05, z0 + 1.5, 2 * SBHW + 1.6, 0.35, 3.4, '#46514a'));
    for (let x = -SBHW; x <= SBHW + 1e-6; x += 4) add('paint', K.box(x, SBY0 - 1.05 + 1.8, z0 + 3.1, 0.12, 3.4, 0.12, '#2a302c'));
    add('paint', K.box(0, SBY0 + 1.9, z0 + 3.1, 2 * SBHW, 0.16, 0.16, '#2a302c'));
    // support columns down behind the bleachers, over the Waveland/Sheffield corner
    for (const x of [-30, -10, 10, 30]) add('paint', K.box(x, OF.topH / 2, SBZ1 + 2.5, 1.6, OF.topH, 1.6, GD));
    // crown with the dot clock
    add('paint', K.box(0, (SBY1 + CROWN.y1) / 2, (CROWN.z0 + CROWN.z1) / 2, 2 * CROWN.hw, CROWN.y1 - SBY1, CROWN.z0 - CROWN.z1, G));
    add('paint', K.box(0, CROWN.y1 + 0.25, (CROWN.z0 + CROWN.z1) / 2, 2 * CROWN.hw + 0.6, 0.5, CROWN.z0 - CROWN.z1 + 0.6, '#d8d2bb'));
    add('paint', K.box(0, SBY1 + 0.4, (z0 + SBZ1) / 2, 2 * SBHW + 1.8, 0.8, Math.abs(SBZ1 - z0) + 0.4, '#1a3b2c'));
    const CS = 256 * BW / 2048, cr = 3.9, cy = (SBY1 + CROWN.y1) / 2 + 0.2, cu = CS / BW, cvv = CS / BH;
    add('board', K.quad([-cr, cy - cr, CROWN.z0 + 0.06], [cr, cy - cr, CROWN.z0 + 0.06], [cr, cy + cr, CROWN.z0 + 0.06], [-cr, cy + cr, CROWN.z0 + 0.06], null, [0, 0, cu, cvv]));
    // masthead: pole, yardarm, finial, the blue & white result lights
    add('paint', K.cyl(0, CROWN.y1, MAST.z, 0, MAST.top, MAST.z, 0.42, 0.26, 10, '#dcdcd4'));
    add('paint', K.bar([-9.2, MAST.arm, MAST.z], [9.2, MAST.arm, MAST.z], 0.28, '#dcdcd4'));
    add('paint', K.box(0, MAST.top + 0.45, MAST.z, 0.7, 0.7, 0.7, '#e7d9a0'));
    add('paint', K.box(-1.5, MAST.arm + 0.6, MAST.z, 0.9, 0.9, 0.9, '#3f78ff', 0, { glow: 2.2 }));
    add('paint', K.box(1.5, MAST.arm + 0.6, MAST.z, 0.9, 0.9, 0.9, '#f4f6ff', 0, { glow: 2.2 }));
    // floodlight fixtures on arms at the base of the face
    for (let k = 0; k < 6; k++) { const x = -SBHW + 6 + k * (2 * SBHW - 12) / 5; add('paint', K.box(x, SBY0 - 2.3, z0 + 3.2, 1.6, 0.9, 1.1, '#2a2e2b')); add('paint', K.box(x, SBY0 - 1.8, z0 + 3.2, 1.3, 0.12, 0.8, '#fff6e2', 0, { glow: 3 })); }
  }

  mark('videoboards');
  // ======================================================================
  // 5. LF & RF VIDEO BOARDS atop the back of the bleachers (data.js videoBoards) — live broadcast graphics
  // ======================================================================
  const VW = LOW ? 512 : 1024;
  const vidCanvas = mkCanvas(VW, VW), vg = vidCanvas.getContext('2d');
  T.video = tex(vidCanvas, { wrap: 'clamp' });
  M.video = new THREE.MeshBasicMaterial({ map: T.video, toneMapped: false, side, color: col('#ffffff').multiplyScalar(LOOK.video) });
  M.video.customProgramCacheKey = () => 'wr-led';
  M.video.onBeforeCompile = sh => {
    sh.uniforms.uRes = { value: new THREE.Vector2(VW * 0.5, VW * 0.5) };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uRes;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        { vec2 q = vMapUv * uRes; vec2 f = fract(q) - 0.5; float fw = max(fwidth(q.x), fwidth(q.y));
          float dotm = smoothstep(0.52, 0.2, length(f)); float k = smoothstep(0.9, 0.3, fw);
          diffuseColor.rgb *= mix(1.0, 0.35 + 1.05 * dotm, k); }`);
  };
  disposables.push(M.video);
  const VB = {}; // id → { A, B, n, t, bottom, top, screenTop, uv:[v0,v1], w, h }
  {
    let vRow = 0;
    for (const b of PK.videoBoards) {
      const rA = fenceAt(b.spray[0]) + OF.depth, rB = fenceAt(b.spray[1]) + OF.depth;
      const A = polar(b.spray[0], rA), B = polar(b.spray[1], rB);
      const w = Math.hypot(B[0] - A[0], B[2] - A[2]), t = [(B[0] - A[0]) / w, (B[2] - A[2]) / w];
      let n = [t[1], -t[0]]; const mx = (A[0] + B[0]) / 2, mz = (A[2] + B[2]) / 2; if (n[0] * mx + n[1] * mz < 0) n = [-n[0], -n[1]];
      const signH = b.id === 'lf' ? 7 : 5.5, screenTop = b.top - signH, h = screenTop - b.bottom;
      const ph = Math.round(VW * h / w), v1 = 1 - vRow / VW, v0 = 1 - (vRow + ph) / VW; vRow += ph + 8;
      const off = (p, d, y) => [p[0] + n[0] * d, y, p[2] + n[1] * d];
      add('video', K.quad(off(A, -0.1, b.bottom + 0.4), off(B, -0.1, b.bottom + 0.4), off(B, -0.1, screenTop - 0.3), off(A, -0.1, screenTop - 0.3), null, [0, v0, 1, v1]));
      const c = [mx + n[0] * 3.62, (b.bottom + b.top) / 2, mz + n[1] * 3.62];
      add('paint', K.obox(c, t, n, w + 1.6, b.top - b.bottom + 0.8, 7, '#2b3036'));   // charcoal steel housing (reads from the street)
      // back-of-board bracing: horizontal ribs + verticals so the housing isn't a featureless slab from Waveland/Sheffield
      for (let k = 0; k <= 4; k++) {
        const y = b.bottom + (b.top - b.bottom) * (0.06 + 0.88 * k / 4);
        add('paint', K.obox([mx + n[0] * 7.4, y, mz + n[1] * 7.4], t, n, w + 1.2, 0.9, 0.7, '#4a5057'));
      }
      for (const f of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        const px = lerp(A[0], B[0], f) + n[0] * 7.4, pz = lerp(A[2], B[2], f) + n[1] * 7.4;
        add('paint', K.box(px, (b.bottom + b.top) / 2, pz, 0.9, b.top - b.bottom + 0.8, 0.7, '#4a5057'));
      }
      SIGNS.push({ kind: 'boardtop', text: b.id === 'lf' ? 'BLUFOX MOBILE' : 'WINDY CITY DERBY', glow: 1.2, quad: [off(A, -0.12, screenTop + 0.4), off(B, -0.12, screenTop + 0.4), off(B, -0.12, b.top - 0.4), off(A, -0.12, b.top - 0.4)] });
      // steel under-structure: beam at the bleacher rim, columns down to the sidewalk, bracing
      add('paint', K.obox([mx - n[0] * 0.2, (OF.topH + b.bottom) / 2 + 0.2, mz - n[1] * 0.2], t, n, w + 1, b.bottom - OF.topH + 0.4, 1.4, '#1b2d23'));
      for (const f of [0.08, 0.5, 0.92]) {
        const px = lerp(A[0], B[0], f) + n[0] * 5.5, pz = lerp(A[2], B[2], f) + n[1] * 5.5;
        add('paint', K.box(px, b.bottom / 2, pz, 1.8, b.bottom, 1.8, '#1b2d23'));
        add('paint', K.bar([px, 6, pz], [px - n[0] * 5, b.bottom - 1, pz - n[1] * 5], 0.6, '#1b2d23'));
      }
      // LED light bank on top
      const la = off(A, 0.6, b.top + 0.6), lb = off(B, 0.6, b.top + 0.6);
      add('lamps', K.quad([lerp(la[0], lb[0], 0.1), la[1], lerp(la[2], lb[2], 0.1)], [lerp(la[0], lb[0], 0.9), la[1], lerp(la[2], lb[2], 0.9)], [lerp(la[0], lb[0], 0.9) - n[0] * 1.2, la[1] + 3.2, lerp(la[2], lb[2], 0.9) - n[1] * 1.2], [lerp(la[0], lb[0], 0.1) - n[0] * 1.2, la[1] + 3.2, lerp(la[2], lb[2], 0.1) - n[1] * 1.2], null, [0, 0, Math.round(w * 0.8 / 4), 1]));
      VB[b.id] = { A, B, n, t, w, h, bottom: b.bottom, top: b.top, screenTop, v0, v1, ph, row: 1 - v1, c: [mx, (b.bottom + screenTop) / 2, mz] };
    }
  }

  mark('streets');
  // ======================================================================
  // 7. WAVELAND & SHEFFIELD — sidewalks, curbs, 2 lanes + parking, cars, street lights, ballhawks
  // ======================================================================
  const D0 = OF.depth + 0.4, D1 = OF.depth + ST.width;       // band: 58.4 … 98
  const vStreet = v => clamp((v - 58.4) / (98 - 58.4), 0, 1);
  const streetPath = ofPath(spraySamples(-57, 57, 1));
  add('street', ribbons(streetPath, () => [[D0, 0.45, 65, 0.45], [65, 0.45, 65, 0.06], [65, 0.06, 91, 0.06], [91, 0.06, 91, 0.45], [91, 0.45, D1, 0.45]], { uScale: 40, vOf: v => vStreet(v) }));
  // CF: the Waveland/Sheffield intersection opens up behind the scoreboard
  add('street', ribbons(ofPath(spraySamples(-6, 6, 1)), () => [[D1, 0.06, D1 + 64, 0.06]], { uScale: 40, vOf: () => 0.42 }));
  const CARS = []; // { p:[x,z], t:[tx,tz], street }
  const CARCOL = ['#2b3e63', '#8f1d1d', '#d9d9d6', '#1b1c1e', '#6b7078', '#355c3a', '#b8a27a', '#20476e', '#efefea', '#3d3f44', '#7a1f24', '#9aa2aa'];
  function car(x, z, tx, tz, color) {
    const t = [tx, tz], n = [-tz, tx];
    const at = (a, b, y) => [x + t[0] * a + n[0] * b, y, z + t[1] * a + n[1] * b];
    add('paint', K.obox(at(0, 0, 1.75), t, n, 14.6, 2.1, 6.0, color));
    add('paint', K.obox(at(-0.4, 0, 3.05), t, n, 13.4, 0.55, 5.8, color));
    add('glass', K.obox(at(-0.9, 0, 3.95), t, n, 7.4, 1.5, 5.4, '#1c2329'));
    add('paint', K.obox(at(-1.0, 0, 4.78), t, n, 6.6, 0.2, 5.2, color));
    for (const a of [-4.7, 4.7]) for (const b of [-2.75, 2.75]) add('paint', K.obox(at(a, b, 1.1), t, n, 2.3, 2.2, 0.75, '#141414'));
    for (const b of [-2.1, 2.1]) { add('paint', K.obox(at(7.32, b, 2.1), t, n, 0.1, 0.5, 1.1, '#fff4dc', { glow: 0.0 })); add('paint', K.obox(at(-7.32, b, 2.3), t, n, 0.1, 0.5, 1.0, '#c01818')); }
    CARS.push({ p: [x, z], t });
  }
  {
    const nC = HIGH ? 1 : quality === 'medium' ? 0.6 : 0.3;
    for (const [dd, dir] of [[88.2, 1], [67.8, -1]]) walk(offsetLine(streetPath, dd), 21, (x, z, tx, tz) => {
      const s = sprayOf(x, z); if (Math.abs(s) < 7 || Math.abs(s) > 52) return;
      if (R() > (dd > 80 ? 0.72 : 0.45) * nC) return;
      car(x, z, tx * dir, tz * dir, pick(R, CARCOL));
    });
  }
  // street lights (far sidewalk) with pools of light at night; wall packs on the bleacher back
  const LAMPS = []; // [x,y,z,size]
  walk(offsetLine(streetPath, 94.5), 88, (x, z, tx, tz) => {
    const s = sprayOf(x, z), n = dirXZ(s);
    add('paint', K.cyl(x, 0, z, x, 25, z, 0.36, 0.24, 8, '#39413b'));
    const hx = x - n[0] * 7.5, hz = z - n[1] * 7.5;
    add('paint', K.bar([x, 24.2, z], [hx, 25.2, hz], 0.3, '#39413b'));
    add('paint', K.box(hx, 25.0, hz, 2.4, 0.6, 1.2, '#2e3431', Math.atan2(n[0], n[1])));
    add('paint', K.box(hx, 24.62, hz, 1.9, 0.12, 0.9, '#ffe4b8', Math.atan2(n[0], n[1]), { glow: 3.2 }));
    LAMPS.push([hx, 24.4, hz, 6]);
  });
  walk(offsetLine(streetPath, OF.depth + 0.6), 42, (x, z) => { add('paint', K.box(x, 13.5, z, 1.4, 0.8, 0.9, '#ffe9c4', 0, { glow: 2 })); LAMPS.push([x, 13.4, z, 3.5]); });
  // street name signs at the corners
  for (const [s, text] of [[-44, 'WAVELAND AV'], [-9, 'WAVELAND AV'], [9, 'SHEFFIELD AV'], [44, 'SHEFFIELD AV']]) {
    const r = fenceAt(s) + 93, [x, , z] = polar(s, r), tg = dirXZ(s + 90), nn = dirXZ(s);
    add('paint', K.cyl(x, 0, z, x, 13.5, z, 0.18, 0.18, 6, '#39413b'));
    const w = 6.4, y = 11.6, h = 1.3, o = -0.25;
    SIGNS.push({ kind: 'street', text, quad: [[x - tg[0] * w / 2 + nn[0] * o, y, z - tg[1] * w / 2 + nn[1] * o], [x + tg[0] * w / 2 + nn[0] * o, y, z + tg[1] * w / 2 + nn[1] * o], [x + tg[0] * w / 2 + nn[0] * o, y + h, z + tg[1] * w / 2 + nn[1] * o], [x - tg[0] * w / 2 + nn[0] * o, y + h, z - tg[1] * w / 2 + nn[1] * o]] });
  }
  // BALLHAWKS — standing in the street (mostly Waveland), each cluster its own crowd so it can scramble
  {
    const spots = LOW ? [[-34, 76], [-22, 80], [18, 79]] : [[-40, 75], [-34, 79], [-28, 74], [-22, 81], [-16, 77], [-11, 73], [13, 78], [21, 74], [32, 80], [40, 76]];
    for (const [s, d] of spots) {
      const [cx, , cz] = polar(s, fenceAt(s) + d), cr = mkCrowd(), n = 2 + Math.floor(R() * 3);
      for (let k = 0; k < n; k++) {
        const dx = (R() - 0.5) * 11, dz = (R() - 0.5) * 7, wx = cx + dx, wz = cz + dz, L = Math.hypot(wx, wz) || 1;
        cr.addFan(dx, 0.06, dz, { facing: [-wx / L, -wz / L], kind: 2, section: SECTION.hawk, standing: true });
      }
      hawks.push({ crowd: cr, home: [cx, cz], street: s < 0 ? 'l' : 'r', s, pos: [cx, cz], target: null, t: 0, speed: 16 + R() * 10 });
    }
  }

  mark('rooftops');
  // ======================================================================
  // 3. ROOFTOP BUILDINGS across Waveland (LF) & Sheffield (RF): three-story brick / greystone six-flats
  //    (photo facades), side fire escapes, steel rooftop bleachers full of standing fans, signs, string
  //    lights. Roofs at rooftops.h (surfaceHeight). Gaps: Kenmore Ave (LF) and the empty lots behind the
  //    RF board. The red-brick firehouse sits across Waveland from the LF corner.
  // ======================================================================
  const RF0 = OF.depth + ST.width, rFront = s => fenceAt(s) + RF0;
  const BUILDINGS = []; // for landmarks / string lights
  const STRINGS = [];   // string-light bulbs [x,y,z]
  const ROOF_SIGNS = ['BLUFOX MOBILE', 'WAVELAND ROOFTOP', 'LAKEVIEW', 'NORTH SIDE', 'SHEFFIELD ROOFTOP', 'BLUFOX MOBILE', 'WINDY CITY', 'EST. 1914', 'ROOFTOP CLUB', 'NORTHSIDE NOODLE CO.'];
  const STEELS = ['#1f2326', '#264230', '#1f2326', '#8e969c', '#2a3c52', '#264230'];
  const BRICK_TINT = ['#96503a', '#cda77a', '#bdb8ad'];
  let signIdx = 0, bldgIdx = 0;
  function sideWindows(a, b, hMax, tint, exposed) { // a,b = [x,z] along the side wall (front→back)
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let n = [t[1], -t[0]];
    for (let f = 0; f < 3; f++) for (let d = 6; d < L - 4; d += exposed ? 9 : 14) {
      const y = 4 + f * 12.6, p0 = [a[0] + t[0] * d, a[1] + t[1] * d], p1 = [p0[0] + t[0] * 3.2, p0[1] + t[1] * 3.2];
      for (const sg of [1, -1]) {
        const o = [n[0] * 0.06 * sg, n[1] * 0.06 * sg];
        add('paint', K.quad([p0[0] + o[0], y, p0[1] + o[1]], [p1[0] + o[0], y, p1[1] + o[1]], [p1[0] + o[0], y + 5.2, p1[1] + o[1]], [p0[0] + o[0], y + 5.2, p0[1] + o[1]], '#2b3035', null, { glow: R() < 0.55 ? 0.85 : 0 }));
      }
    }
  }
  function fireEscape(a, b, n) { // on a side wall: platforms at each floor + stairs + rails (dark steel)
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], d0 = L * 0.3;
    const P = (d, o, y) => [a[0] + t[0] * d + n[0] * o, y, a[1] + t[1] * d + n[1] * o];
    for (const y of [12.2, 24.8, 37.4]) {
      add('paint', K.obox(P(d0 + 6, 1.8, y), t, n, 12, 0.18, 3.6, '#24272a'));
      add('paint', K.obox(P(d0 + 6, 3.55, y + 1.6), t, n, 12, 0.12, 0.12, '#24272a'));
      for (let k = 0; k <= 4; k++) add('paint', K.box(...P(d0 + k * 3, 3.55, y + 0.8), 0.1, 1.6, 0.1, '#24272a'));
      if (y > 13) add('paint', K.bar(P(d0 + 1, 2.6, y - 12.4), P(d0 + 9, 2.6, y), 0.35, '#2a2d30'));
    }
    add('paint', K.bar(P(d0 + 11, 2.6, 5), P(d0 + 11, 2.6, 12.2), 0.18, '#2a2d30'));
  }
  // one building on the band between sprays s0..s1 (front straight chord), optional rooftop bleachers
  function building(s0, s1, { fv = 0, roof = true, exposedL = false, exposedR = false, depth = RT.depth, style = 0 } = {}) {
    const A = polar(s0, rFront(s0)), B = polar(s1, rFront(s1)), H = RT.h;
    const w = Math.hypot(B[0] - A[0], B[2] - A[2]), t = [(B[0] - A[0]) / w, (B[2] - A[2]) / w];
    let n = [t[1], -t[0]]; const mx = (A[0] + B[0]) / 2, mz = (A[2] + B[2]) / 2; if (n[0] * mx + n[1] * mz < 0) n = [-n[0], -n[1]];
    const C = [B[0] + n[0] * depth, 0, B[2] + n[1] * depth], D = [A[0] + n[0] * depth, 0, A[2] + n[1] * depth];
    const seed = R(), tint = BRICK_TINT[fv];
    add('facade', K.quad([A[0], 0, A[2]], [B[0], 0, B[2]], [B[0], H, B[2]], [A[0], H, A[2]], null, [0, 0, 1, 1], { fv, seed }));
    const side = (p, q) => add('brickN', K.quad([p[0], 0, p[2]], [q[0], 0, q[2]], [q[0], H, q[2]], [p[0], H, p[2]], tint, [0, 0, Math.hypot(q[0] - p[0], q[2] - p[2]) / 4, H / 3.6]));
    side(B, C); side(C, D); side(D, A);
    sideWindows([B[0], B[2]], [C[0], C[2]], H, tint, exposedR); sideWindows([A[0], A[2]], [D[0], D[2]], H, tint, exposedL);
    if (exposedR) fireEscape([B[0], B[2]], [C[0], C[2]], t);
    if (exposedL) fireEscape([A[0], A[2]], [D[0], D[2]], [-t[0], -t[1]]);
    add('paint', K.quad([A[0], H, A[2]], [B[0], H, B[2]], [C[0], H, C[2]], [D[0], H, D[2]], '#403d3a'));
    const par = (p, q) => add('brickN', K.quad([p[0], H, p[2]], [q[0], H, q[2]], [q[0], H + 2.2, q[2]], [p[0], H + 2.2, p[2]], tint, [0, 0, Math.hypot(q[0] - p[0], q[2] - p[2]) / 4, 2.2 / 3.6]));
    par(B, C); par(C, D); par(D, A);
    add('paint', K.box(...[C[0] - n[0] * 8 - t[0] * 6, H + 2.5, C[2] - n[1] * 8 - t[1] * 6], 5, 5, 3.5, '#8b8f92', Math.atan2(t[0], t[1])));
    const bl = { A, B, t, n, w, mid: [mx, H, mz], s: (s0 + s1) / 2 };
    BUILDINGS.push(bl);
    if (roof) rooftopStands(bl, style);
    return bl;
  }
  function rooftopStands(bl, style) {
    const { A, B, t, n, w } = bl, H = RT.h, NR = LOW ? 5 : style === 1 ? 6 : 8, steel = STEELS[bldgIdx++ % STEELS.length];
    const inset = 2.2, A2 = [A[0] + t[0] * inset, A[2] + t[1] * inset], B2 = [B[0] - t[0] * inset, B[2] - t[1] * inset];
    const pth = [{ p: A2, n }, { p: B2, n }];
    const rows = []; for (let k = 0; k < NR; k++) rows.push({ d0: 3 + k * 2.8, d1: 5.8 + k * 2.8, y: H + 3.4 + k * 2.15 });
    const top = rows[NR - 1], dBack = top.d1 + 3.2, yTop = top.y;
    const segs = [[1.2, H, 1.2, H + 2.6, steel], [1.2, H + 2.6, 3, H + 2.6, '#a9adb0']];
    let yp = H + 2.6;
    for (const r of rows) { segs.push([r.d0, yp, r.d0, r.y, steel], [r.d0, r.y, r.d1, r.y, '#b3b8bb']); yp = r.y; }
    segs.push([top.d1, yp, dBack, yp, '#a9adb0'], [dBack, yp, dBack, H, steel]);
    add('paint', ribbons(pth, () => segs));
    for (const e of [pth[0], pth[1]]) { const o = [[1.2, H], [1.2, H + 2.6]]; for (const r of rows) o.push([r.d0, o[o.length - 1][1]], [r.d0, r.y]); o.push([dBack, yTop], [dBack, H]); capAt(e.p, e.n, dedupe(o), steel); }
    // railings (front + top back) and posts
    const rail = (d, y0, y1) => add('paint', ribbons(pth, () => [[d, y1, d + 0.25, y1, steel], [d, y0 + 0.9, d, y0 + 1.05, steel]]));
    rail(1.1, H + 2.6, H + 6.0); rail(dBack - 0.3, yTop, yTop + 3.6);
    walk([A2, B2], 7, (x, z) => { add('paint', K.box(x + n[0] * 1.2, H + 4.3, z + n[1] * 1.2, 0.16, 3.4, 0.16, steel)); add('paint', K.box(x + n[0] * (dBack - 0.2), yTop + 1.8, z + n[1] * (dBack - 0.2), 0.16, 3.6, 0.16, steel)); });
    // fans on every tier (standing, kind 2)
    for (const r of rows) fanRow(crowdRoof, [[A2[0] + n[0] * (r.d0 + 1.4), A2[1] + n[1] * (r.d0 + 1.4)], [B2[0] + n[0] * (r.d0 + 1.4), B2[1] + n[1] * (r.d0 + 1.4)]], r.y, { spacing: 2.0, fill: 0.86, kind: 2, section: SECTION.rooftop });
    fanRow(crowdRoof, [[A2[0] + n[0] * (dBack - 1.4), A2[1] + n[1] * (dBack - 1.4)], [B2[0] + n[0] * (dBack - 1.4), B2[1] + n[1] * (dBack - 1.4)]], yTop, { spacing: 2.3, fill: 0.7, kind: 2, section: SECTION.rooftop });
    // canopy (style 0), billboard sign (style 2), flags (style 1)
    const P = (f, d, y) => [lerp(A2[0], B2[0], f) + n[0] * d, y, lerp(A2[1], B2[1], f) + n[1] * d];
    if (style === 0) {
      for (const f of [0.03, 0.5, 0.97]) add('paint', K.cyl(...P(f, dBack - 0.4, yTop), ...P(f, dBack - 0.4, yTop + 10.5), 0.22, 0.22, 6, steel));
      for (const f of [0.03, 0.5, 0.97]) add('paint', K.cyl(...P(f, 2.2, H + 1.3), ...P(f, 2.2, yTop + 9.2), 0.18, 0.18, 6, steel));
      const c0 = P(0, 1.2, yTop + 9.0), c1 = P(1, 1.2, yTop + 9.0), c2 = P(1, dBack + 0.4, yTop + 10.6), c3 = P(0, dBack + 0.4, yTop + 10.6);
      add('paint', K.quad(c0, c1, c2, c3, bldgIdx % 2 ? '#e9ebe8' : '#2c5a40'));
      for (let k = 0; k <= 16; k++) { const f = k / 16, sag = Math.sin(Math.PI * f) * 1.4; STRINGS.push(P(f, 1.4, yTop + 8.6 - sag), P(f, (1.4 + dBack) / 2, yTop + 9.4 - sag)); }
    } else if (style === 2) {
      const text = ROOF_SIGNS[signIdx++ % ROOF_SIGNS.length], y0 = yTop + 3, y1 = yTop + 14;
      for (const f of [0.18, 0.82]) add('paint', K.cyl(...P(f, dBack + 0.6, yTop), ...P(f, dBack + 0.6, y1), 0.35, 0.35, 6, steel));
      SIGNS.push({ kind: 'roof', text, glow: 0.9, quad: [P(0.06, dBack + 0.2, y0), P(0.94, dBack + 0.2, y0), P(0.94, dBack + 0.2, y1), P(0.06, dBack + 0.2, y1)] });
      add('paint', K.quad(P(0.05, dBack + 0.5, y0 - 0.3), P(0.95, dBack + 0.5, y0 - 0.3), P(0.95, dBack + 0.5, y1 + 0.3), P(0.05, dBack + 0.5, y1 + 0.3), '#1b1d20'));
      for (let k = 0; k <= 14; k++) { const f = k / 14, sag = Math.sin(Math.PI * f) * 1.2; STRINGS.push(P(f, 1.3, H + 5.2 - sag * 0.4), P(f, dBack - 0.4, yTop + 4 - sag)); }
    } else {
      for (const f of [0.04, 0.96]) { add('paint', K.cyl(...P(f, dBack, yTop), ...P(f, dBack, yTop + 18), 0.14, 0.1, 5, '#d0d0c8')); ROOF_FLAGS.push({ a: P(f, dBack, yTop + 17.4), cell: f < 0.5 ? 0 : 1 }); }
      for (let k = 0; k <= 16; k++) { const f = k / 16, sag = Math.sin(Math.PI * f) * 1.5; STRINGS.push(P(f, 1.3, H + 5.0 - sag * 0.4), P(f, dBack - 0.3, yTop + 3.8 - sag)); }
    }
  }
  function dedupe(o) { const out = []; for (const p of o) { const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-4 || Math.abs(q[1] - p[1]) > 1e-4) out.push(p); } return out; }
  const ROOF_FLAGS = [];
  // lot plan per rooftop range: widths in ft along the front line (gaps = gangways)
  const sprayForArc = (s, ft) => ft / (rFront(s) * D2R);
  function lotsIn(a, b, widths) {
    const out = []; let s = a + sprayForArc(a, 1.2);
    for (const wft of widths) { const s1 = s + sprayForArc(s, wft); if (s1 > b - 0.05) break; out.push([s, s1]); s = s1 + sprayForArc(s1, 3 + R() * 1.5); }
    return out;
  }
  {
    const [rA, rB, rC, rD] = RT.spray; // [-45,-35] [-31,-6] [6,15] [29,45]
    // LF corner: the firehouse, then one six-flat up to Kenmore
    const fireL = lotsIn(rA[0], rA[1], [42, 34]);
    const fh = fireL[0];
    if (fh) firehouse(fh[0], fh[1]);
    if (fireL[1]) building(fireL[1][0], rA[1] - sprayForArc(rA[1], 1), { fv: 2, exposedR: true, style: 1 });
    const wv = lotsIn(rB[0], rB[1], [50, 47, 52, 49]);
    wv.forEach(([s0, s1], i) => building(s0, i === wv.length - 1 ? rB[1] - sprayForArc(rB[1], 1) : s1, { fv: [1, 0, 2, 0][i % 4], exposedL: i === 0, exposedR: i === wv.length - 1, style: [2, 0, 2, 1][i % 4] }));
    const rc = lotsIn(rC[0], rC[1], [37, 34]);
    rc.forEach(([s0, s1], i) => building(s0, i === rc.length - 1 ? rC[1] - sprayForArc(rC[1], 1) : s1, { fv: [0, 1][i], exposedL: i === 0, exposedR: i === rc.length - 1, style: [0, 2][i] }));
    const sh = lotsIn(rD[0], rD[1], [42, 40, 41]);
    sh.forEach(([s0, s1], i) => building(s0, i === sh.length - 1 ? rD[1] - sprayForArc(rD[1], 1) : s1, { fv: [2, 0, 1][i % 3], exposedL: i === 0, style: [1, 2, 0][i % 3] }));
  }
  function firehouse(s0, s1) { // red-brick firehouse, apparatus doors, hose tower — no rooftop bleachers
    const A = polar(s0, rFront(s0)), B = polar(s1, rFront(s1)), H = RT.h;
    const w = Math.hypot(B[0] - A[0], B[2] - A[2]), t = [(B[0] - A[0]) / w, (B[2] - A[2]) / w];
    let n = [t[1], -t[0]]; if (n[0] * (A[0] + B[0]) + n[1] * (A[2] + B[2]) < 0) n = [-n[0], -n[1]];
    const dep = 72, C = [B[0] + n[0] * dep, 0, B[2] + n[1] * dep], D = [A[0] + n[0] * dep, 0, A[2] + n[1] * dep];
    SIGNS.push({ kind: 'firehouse', quad: [[A[0], 0, A[2]], [B[0], 0, B[2]], [B[0], H, B[2]], [A[0], H, A[2]]] });
    for (const [p, q] of [[B, C], [C, D], [D, A]]) add('brick', K.quad([p[0], 0, p[2]], [q[0], 0, q[2]], [q[0], H, q[2]], [p[0], H, p[2]], '#d8c8c0', [0, 0, Math.hypot(q[0] - p[0], q[2] - p[2]) / 4, H / 3.6]));
    add('paint', K.quad([A[0], H, A[2]], [B[0], H, B[2]], [C[0], H, C[2]], [D[0], H, D[2]], '#3d3a37'));
    const tw = [C[0] - n[0] * 10 - t[0] * 7, C[2] - n[1] * 10 - t[1] * 7];
    add('brick', K.obox([tw[0], H + 7, tw[1]], t, n, 11, 14, 11, '#d8c8c0'));
    add('paint', K.obox([tw[0], H + 14.3, tw[1]], t, n, 12, 0.6, 12, '#b9ad97'));
    add('paint', K.cyl(A[0] + t[0] * 4 + n[0] * 2, H, A[2] + t[1] * 4 + n[1] * 2, A[0] + t[0] * 4 + n[0] * 2, H + 22, A[2] + t[1] * 4 + n[1] * 2, 0.14, 0.1, 5, '#d0d0c8'));
    ROOF_FLAGS.push({ a: [A[0] + t[0] * 4 + n[0] * 2, H + 21.4, A[2] + t[1] * 4 + n[1] * 2], cell: 0 });
    BUILDINGS.push({ A, B, t, n, w, mid: [(A[0] + B[0]) / 2, H, (A[2] + B[2]) / 2], s: (s0 + s1) / 2, firehouse: true });
  }
  // Kenmore Ave heading north through the gap in the Waveland rooftops
  const KEN = { s: (RT.spray[0][1] + RT.spray[1][0]) / 2 };
  {
    const P0 = polar(KEN.s, rFront(KEN.s) - 1), dn = dirXZ(-37), tn = [-dn[1], dn[0]], L = 520, hw = 23;
    const pts = [[-hw, 0.45], [-hw + 7, 0.45], [-hw + 7, 0.06], [hw - 7, 0.06], [hw - 7, 0.45], [hw, 0.45]];
    for (let k = 0; k < pts.length - 1; k++) {
      const [a, ya] = pts[k], [b, yb] = pts[k + 1];
      const va = vStreet(lerp(58.4, 98, (a + hw) / (2 * hw))), vb = vStreet(lerp(58.4, 98, (b + hw) / (2 * hw)));
      const A = [P0[0] + tn[0] * a, ya, P0[2] + tn[1] * a], B = [P0[0] + tn[0] * b, yb, P0[2] + tn[1] * b];
      const quadG = K.grid([[A, [A[0] + dn[0] * L, ya, A[2] + dn[1] * L]], [B, [B[0] + dn[0] * L, yb, B[2] + dn[1] * L]]], [[[0, va], [L / 40, va]], [[0, vb], [L / 40, vb]]]);
      add('street', quadG);
    }
    for (let d = 30; d < L; d += 21) for (const o of [-12.5, 12.5]) if (R() < 0.7) car(P0[0] + tn[0] * o + dn[0] * d, P0[2] + tn[1] * o + dn[1] * d, dn[0] * Math.sign(o), dn[1] * Math.sign(o), pick(R, CARCOL));
    KEN.p0 = P0; KEN.dn = dn; KEN.tn = tn; KEN.L = L;
  }
  // RF: the demolished lots behind the video board — gravel, a screened construction fence, a trailer
  {
    const lots = ofPath(spraySamples(RT.spray[2][1] + 0.4, RT.spray[3][0] - 0.4, 1));
    add('gravel', ribbons(lots, () => [[RF0 + 0.5, 0.1, RF0 + RT.depth, 0.1]], { uScale: 24, vScale: 24 }));
    add('paint', ribbons(lots, () => [[RF0 + 1.2, 0.1, RF0 + 1.2, 7.5, '#2c4a36']]));
    walk(offsetLine(lots, RF0 + 1.3), 10, (x, z) => add('paint', K.cyl(x, 0, z, x, 8, z, 0.12, 0.12, 4, '#7c8480')));
    const [tx, , tz] = polar(22, rFront(22) + 38), tn = dirXZ(22 + 90);
    add('paint', K.obox([tx, 5, tz], tn, dirXZ(22), 32, 9, 9, '#d9d6cc')); add('paint', K.obox([tx + 26, 3, tz - 12], tn, dirXZ(22), 16, 6, 8, '#3c5d8a'));
  }

  mark('grandstand');
  // ======================================================================
  // 6. GRANDSTAND — low brick wall, lower deck, mezzanine suites, upper-deck fascia with ribbon boards and
  //    the press/broadcast booth windows directly behind home (PK.booth.pos), upper deck, pitched roof with
  //    the 6 light towers, steel columns, dugouts (home on the 3B side), brick backstop + net.
  // ======================================================================
  const GS = { fv: PK.booth.pos[2] - CFG.foul.backstop, low: [[1.2, 4.4], [74, 31]], up: [[36, 57], [100, 83.5]], roof: [42, 104, 93.5, 95.8], back: 104 };
  const FAS = GS.fv; // upper-deck fascia offset (booth z = backstop + FAS)
  const upSeatY = v => lerp(GS.up[0][1], GS.up[1][1], (v - GS.up[0][0]) / (GS.up[1][0] - GS.up[0][0]));
  const lowSeatY = v => lerp(GS.low[0][1], GS.low[1][1], (v - GS.low[0][0]) / (GS.low[1][0] - GS.low[0][0]));
  const undersideY = v => lerp(44, 71, (v - FAS) / (100 - FAS));
  const roofY = v => lerp(GS.roof[2], GS.roof[3], (v - GS.roof[0]) / (GS.roof[1] - GS.roof[0]));
  const STEEL = '#2a5a40', STEEL2 = '#3a6a50';
  // split the path at the booth (behind home, |x| ≤ ~34 ft at the fascia)
  const iB0 = gsPath.findIndex(q => q.side === 0 && q.th >= 160), iB1 = gsPath.findIndex(q => q.side === 0 && q.th >= 200);
  const gsA = gsPath.slice(0, iB0 + 1), gsB = gsPath.slice(iB0, iB1 + 1), gsC = gsPath.slice(iB1);
  add('brick', ribbons(gsPath, () => [[0, 0, 0, CFG.wallH, '#c7b7ad']], { uScale: 4, vScale: 3.6, vMode: 'y' }));
  add('paint', ribbons(gsPath, () => [[-0.05, CFG.wallH, 1.2, CFG.wallH, '#244a33'], [1.2, CFG.wallH, 1.2, 4.4, '#244a33']]));
  add('seatsGS', ribbons(gsPath, () => [[1.2, 4.4, 74, 31]], { uScale: 14, vScale: 12 }));
  add('glass', ribbons(gsPath, () => [[74, 31, 74, 42, '#1c2b25', 0.3]]));
  walk(offsetLine(gsPath, 73.8), 9, (x, z) => add('paint', K.box(x, 36.5, z, 0.7, 11, 0.7, '#1d3527')));
  add('paint', ribbons(gsPath, () => [[73.7, 36.2, 73.7, 36.8, '#1d3527']]));
  add('paint', ribbons(gsPath, () => [[74, 42, 74, undersideY(74), '#223a2c'], [FAS, 44, 100, 71, '#3a473f'], [FAS, 44, FAS, 47.4, STEEL],
    [100, 83.5, 100, 93.2, '#27402f'], [GS.roof[0], 93.2, GS.roof[1], 95.5, '#39423c'], [GS.roof[0], 93.2, GS.roof[0], 94.3, STEEL], [GS.roof[0], 94.3, GS.roof[1], 96.6, '#6a706b'],
    [GS.back, 40, GS.back, 96.6, '#284631']]));
  add('brick', ribbons(gsPath, () => [[GS.back, 0, GS.back, 40, '#c7b7ad']], { uScale: 4, vScale: 3.6, vMode: 'y' }));
  add('paint', ribbons(gsPath, () => [[GS.back + 0.2, 40, GS.back + 0.2, 42.2, '#cfc6ae'], [GS.back + 0.2, 42.2, GS.back + 1.2, 42.2, '#bdb39a']]));
  walk(offsetLine(gsPath, GS.back + 0.18), 24, (x, z, tx, tz) => {
    const q = (a, b, y0, y1, c, gl = 0, dv = 0) => { const nx = tz, nz = -tx, o = (nx * x + nz * z) > 0 ? dv : -dv; add('paint', K.quad([x + tx * a + nx * o, y0, z + tz * a + nz * o], [x + tx * b + nx * o, y0, z + tz * b + nz * o], [x + tx * b + nx * o, y1, z + tz * b + nz * o], [x + tx * a + nx * o, y1, z + tz * a + nz * o], c, null, { glow: gl })); };
    q(-4.5, 4.5, 0.2, 12.5, '#1b211d', 0.35); q(-5.2, 5.2, 12.5, 14.2, '#cfc6ae'); q(-0.6, 0.6, 13.9, 15.6, '#cfc6ae');
    q(-3.4, 3.4, 22, 31, '#232a27', 0.5); q(-3.8, 3.8, 21.4, 22, '#cfc6ae');
    q(-12.0, -10.6, 42.2, 96.4, '#1d3d2b', 0, 0.35); q(-9.6, 9.6, 50, 63, '#141a17', 0.3); q(-9.6, 9.6, 71, 85, '#141a17', 0.3);
    q(-9.6, 9.6, 56, 57, '#2f5a42', 0, 0.2); q(-9.6, 9.6, 78, 79, '#2f5a42', 0, 0.2);
  });
  // roof-top clutter: HVAC boxes along the back half
  walk(offsetLine(gsPath, 88), 64, (x, z, tx, tz) => add('paint', K.box(x, roofY(88) + 1.9, z, 8, 3.2, 5, '#8c9192', Math.atan2(tx, tz))));
  // fascia middle band: ribbon boards along the lines, booth windows behind home
  M.ribbon = null;
  for (const p of [gsA, gsC]) { add('paint', ribbons(p, () => [[FAS, 51.0, FAS, 56, STEEL], [FAS, 56, FAS + 2, 56, STEEL2]])); add('ribbon', ribbons(p, () => [[FAS - 0.08, 47.4, FAS - 0.08, 51.0]], { uScale: 64, vOf: (v, y) => (y - 47.4) / 3.6 })); add('paint', ribbons(p, () => [[FAS, 47.4, FAS, 51, '#111']])); }
  // upper seats: along the lines from the fascia; behind home the press box sits in front of them
  for (const p of [gsA, gsC]) add('seatsGS', ribbons(p, () => [[36, 57, 100, 83.5]], { uScale: 14, vScale: 12 }));
  add('seatsGS', ribbons(gsB, () => [[47, upSeatY(47), 100, 83.5]], { uScale: 14, vScale: 12 }));
  add('paint', ribbons(gsB, () => [[FAS, 55.0, FAS, 56, STEEL, 10.25], [FAS, 56, FAS + 2, 56, STEEL2], [FAS, 56, 47, 57.6, '#39423c'], [47, 57.6, 47, upSeatY(47), '#223a2c'], [FAS + 0.5, 44, FAS + 0.5, 46.6, STEEL]]));
  // end caps of the grandstand (face the bleacher corners)
  const gsOutline = [[0, 0], [0, CFG.wallH], [1.2, CFG.wallH], [1.2, 4.4], [FAS, lowSeatY(FAS)], [FAS, 56], [36, 57], [GS.roof[0], upSeatY(GS.roof[0])], [GS.roof[0], 94.3], [GS.roof[1], 96.6], [GS.back, 96.6], [GS.back, 0]];
  capAt(gsPath[0].p, gsPath[0].n, gsOutline, '#284631');
  capAt(gsPath[gsPath.length - 1].p, gsPath[gsPath.length - 1].n, gsOutline, '#284631');
  // crowd: lower deck (shade under the upper deck) and upper deck (shade under the roof)
  for (let v = 2.4; v < 72.6; v += 2.9) {
    const shadeK = v > FAS + 2 ? 1 : 0;
    fanRow(crowdMain, offsetLine(gsPath, v), lowSeatY(v) - 0.2, { spacing: 2.0, fill: 0.9, kind: shadeK, section: SECTION.lowerDeck });
  }
  for (let v = 37.6; v < 99; v += 2.9) {
    for (const p of v < 48 ? [gsA, gsC] : [gsPath]) fanRow(crowdMain, offsetLine(p, v), upSeatY(v) - 0.2, { spacing: 2.0, fill: 0.86, kind: v > GS.roof[0] + 1 ? 1 : 0, section: SECTION.upperDeck });
  }
  // columns: lower deck holds the upper deck (the famous obstructed-view posts), upper deck holds the roof
  walk(offsetLine(gsPath, FAS - 5), 27, (x, z) => add('paint', K.cyl(x, lowSeatY(FAS - 5) - 1, z, x, undersideY(FAS - 5) + 0.5, z, 0.62, 0.62, 8, STEEL)));
  walk(offsetLine(gsPath, 58), 30, (x, z) => add('paint', K.cyl(x, upSeatY(58) - 1, z, x, roofY(58) - 1.2, z, 0.7, 0.7, 8, STEEL)));
  // press box / broadcast booths: a row of windows behind home, the centre one open with a lit booth inside
  const BOOTHW = []; // window centres (for landmarks)
  {
    const r = CFG.foul.backstop + FAS, y0 = 47.0, y1 = 54.4, n = 11, span = 40; // degrees of arc
    for (let k = 0; k < n; k++) {
      const th0 = 180 - span / 2 + k * span / n, th1 = th0 + span / n;
      const a = polar(th0, r), b = polar(th1, r), mid = polar((th0 + th1) / 2, r), nn = dirXZ((th0 + th1) / 2);
      const inset = 0.55, at = (p, du, dv, y) => { const tg = [(b[0] - a[0]), (b[2] - a[2])], L = Math.hypot(tg[0], tg[1]); return [p[0] + tg[0] / L * du + nn[0] * dv, y, p[2] + tg[1] / L * du + nn[1] * dv]; };
      const w = Math.hypot(b[0] - a[0], b[2] - a[2]), open = k === (n - 1) / 2 || k % 3 === 1;
      // mullion (between windows) + sill + head
      add('paint', K.quad(at(a, -0.1, -0.1, y0 - 0.6), at(a, inset, -0.1, y0 - 0.6), at(a, inset, -0.1, y1 + 0.6), at(a, -0.1, -0.1, y1 + 0.6), '#e6e2d4'));
      add('paint', K.quad(at(a, 0, -0.35, y0 - 0.05), at(b, 0, -0.35, y0 - 0.05), at(b, 0, 0.3, y0 - 0.05), at(a, 0, 0.3, y0 - 0.05), '#d9d4c3'));
      add('paint', K.quad(at(a, 0, -0.1, y0 - 0.6), at(b, 0, -0.1, y0 - 0.6), at(b, 0, -0.1, y0), at(a, 0, -0.1, y0), '#e6e2d4'));
      add('paint', K.quad(at(a, 0, -0.1, y1), at(b, 0, -0.1, y1), at(b, 0, -0.1, y1 + 0.6), at(a, 0, -0.1, y1 + 0.6), '#e6e2d4'));
      const x0 = inset, x1 = w;
      if (open) { // booth interior: back wall (lit), side walls, desk at the sill, two monitors, ceiling light
        const D = 9;
        add('paint', K.quad(at(a, x0, D, y0 - 1.5), at(a, x1, D, y0 - 1.5), at(a, x1, D, y1 + 1), at(a, x0, D, y1 + 1), '#8c7a64', null, { glow: 10.7 }));
        add('paint', K.quad(at(a, x0, 0, y1 + 0.9), at(a, x1, 0, y1 + 0.9), at(a, x1, D, y1 + 0.9), at(a, x0, D, y1 + 0.9), '#6a625a', null, { glow: 10.4 }));
        add('paint', K.quad(at(a, x0, 0, y0 - 0.1), at(a, x1, 0, y0 - 0.1), at(a, x1, D, y0 - 0.1), at(a, x0, D, y0 - 0.1), '#2e2a26'));
        for (const xs of [x0, x1]) add('paint', K.quad(at(a, xs, 0, y0 - 0.1), at(a, xs, D, y0 - 0.1), at(a, xs, D, y1 + 0.9), at(a, xs, 0, y1 + 0.9), '#76695c', null, { glow: 10.5 }));
        add('paint', K.quad(at(a, x0 + 0.1, 0.4, y0 + 2.4), at(a, x1 - 0.1, 0.4, y0 + 2.4), at(a, x1 - 0.1, 2.6, y0 + 2.4), at(a, x0 + 0.1, 2.6, y0 + 2.4), '#3b2d22'));
        for (const f of [0.3, 0.7]) { const xm = lerp(x0, x1, f); add('paint', K.quad(at(a, xm - 0.9, 2.3, y0 + 2.5), at(a, xm + 0.9, 2.3, y0 + 2.5), at(a, xm + 0.9, 2.6, y0 + 3.8), at(a, xm - 0.9, 2.6, y0 + 3.8), '#9fc3ff', null, { glow: 11.4 })); }
        add('paint', K.quad(at(a, lerp(x0, x1, 0.3), 3, y1 + 0.85), at(a, lerp(x0, x1, 0.7), 3, y1 + 0.85), at(a, lerp(x0, x1, 0.7), 5, y1 + 0.85), at(a, lerp(x0, x1, 0.3), 5, y1 + 0.85), '#fff3da', null, { glow: 12.5 }));
        if (k === (n - 1) / 2) SIGNS.push({ kind: 'booth', text: 'WCD RADIO', glow: 10.6, quad: [at(a, x0 + 0.3, -0.25, y1 + 0.65), at(a, x1 - 0.3, -0.25, y1 + 0.65), at(a, x1 - 0.3, -0.25, y1 + 2.15), at(a, x0 + 0.3, -0.25, y1 + 2.15)] });
      } else {
        add('glass', K.quad(at(a, x0, 0.4, y0), at(a, x1, 0.4, y0), at(a, x1, 0.4, y1), at(a, x0, 0.4, y1), '#2c3a33', null, { glow: 10.35 }));
      }
      if (k === n - 1) add('paint', K.quad(at(b, -inset, -0.1, y0 - 0.6), at(b, 0.1, -0.1, y0 - 0.6), at(b, 0.1, -0.1, y1 + 0.6), at(b, -inset, -0.1, y1 + 0.6), '#e6e2d4'));
      BOOTHW.push(mid);
    }
    // bunting fans under the booth windows (old-time ballpark look, generic red / white / blue)
    for (let k = 0; k < 7; k++) {
      const th = 180 - 15 + k * 5, c = polar(th, r - 0.25), tg = dirXZ(th + 90), hw = 2.6;
      SIGNS.push({ kind: 'bunting', quad: [[c[0] - tg[0] * hw, 44.3, c[2] - tg[1] * hw], [c[0] + tg[0] * hw, 44.3, c[2] + tg[1] * hw], [c[0] + tg[0] * hw, 46.8, c[2] + tg[1] * hw], [c[0] - tg[0] * hw, 46.8, c[2] - tg[1] * hw]] });
    }
  }
  // dugouts — home on the 3B side, visitors on the 1B side, well down the lines (2017–18 rebuild)
  for (const sg of [1, -1]) {
    const u0 = 66, u1 = 124, a = foulPt(sg, u0), b = foulPt(sg, u1);
    const N = [sg * SQ, SQ], ax = a[0] - N[0] * 0.1, az = a[1] - N[1] * 0.1, bx = b[0] - N[0] * 0.1, bz = b[1] - N[1] * 0.1;
    add('paint', K.quad([ax, -1.5, az], [bx, -1.5, bz], [bx, CFG.wallH - 0.5, bz], [ax, CFG.wallH - 0.5, az], '#0d0f0e'));
    add('paint', K.quad([ax - N[0] * 1.4, CFG.wallH - 0.5, az - N[1] * 1.4], [bx - N[0] * 1.4, CFG.wallH - 0.5, bz - N[1] * 1.4], [bx + N[0] * 9, CFG.wallH - 0.5, bz + N[1] * 9], [ax + N[0] * 9, CFG.wallH - 0.5, az + N[1] * 9], '#1f5a32'));
    add('brick', K.quad([ax - N[0] * 1.4, CFG.wallH - 0.5, az - N[1] * 1.4], [bx - N[0] * 1.4, CFG.wallH - 0.5, bz - N[1] * 1.4], [bx - N[0] * 1.4, CFG.wallH + 0.4, bz - N[1] * 1.4], [ax - N[0] * 1.4, CFG.wallH + 0.4, az - N[1] * 1.4], '#c7b7ad', [0, 0, (u1 - u0) / 4, 0.25]));
    add('paint', K.bar([ax - N[0] * 1.1, CFG.wallH + 3.2, az - N[1] * 1.1], [bx - N[0] * 1.1, CFG.wallH + 3.2, bz - N[1] * 1.1], 0.14, '#8a9096'));
    for (let f = 0; f <= 1.0001; f += 0.125) { const x = lerp(ax, bx, f) - N[0] * 1.1, z = lerp(az, bz, f) - N[1] * 1.1; add('paint', K.box(x, CFG.wallH + 1.8, z, 0.12, 2.8, 0.12, '#8a9096')); }
  }
  // backstop netting (dugout to dugout)
  {
    const sub = gsPath.filter(q => q.side === 0 || q.u <= 128);
    add('net', ribbons(sub, () => [[-0.4, CFG.wallH, -0.4, 31]], { uScale: 0.5, vScale: 0.5, vMode: 'y' }));
    add('paint', ribbons(sub, () => [[-0.4, 30.4, -0.4, 31, '#2a2a2a']]));
    walk(offsetLine(sub, -0.4), 40, (x, z) => add('paint', K.cyl(x, CFG.wallH, z, x, 31, z, 0.12, 0.12, 5, '#2a2a2a')));
  }

  mark('towers');
  // the 6 roof light towers (33 ft steel lattice, rectangular LED banks) + glare at dusk/night
  const glare = []; // [x,y,z,size,r,g,b,a]
  function lightBank(x, y, z, w, h, aim, glareK = 1) {
    const dx = aim[0] - x, dz = aim[2] - z, L = Math.hypot(dx, dz), fx = dx / L, fz = dz / L, tx = -fz, tz = fx, tilt = 0.34;
    const b0 = [x - tx * w / 2, y, z - tz * w / 2], b1 = [x + tx * w / 2, y, z + tz * w / 2];
    const t1 = [b1[0] + fx * h * tilt, y + h, b1[2] + fz * h * tilt], t0 = [b0[0] + fx * h * tilt, y + h, b0[2] + fz * h * tilt];
    const off = (p, k) => [p[0] - fx * k, p[1], p[2] - fz * k];
    add('lamps', K.quad(b0, b1, t1, t0, null, [0, 0, Math.max(1, Math.round(w / 5)), Math.max(1, Math.round(h / 5))]));
    add('paint', K.quad(off(b0, 1.1), off(b1, 1.1), off(t1, 1.1), off(t0, 1.1), '#2b3035'));
    add('paint', K.bar(off(b0, 0.5), off(b1, 0.5), 0.5, '#3b4046')); add('paint', K.bar(off(t0, 0.5), off(t1, 0.5), 0.5, '#3b4046'));
    add('paint', K.bar(off(b0, 0.5), off(t0, 0.5), 0.5, '#3b4046')); add('paint', K.bar(off(b1, 0.5), off(t1, 0.5), 0.5, '#3b4046'));
    if (LOOK.glare > 0) {
      const nx = Math.max(2, Math.round(w / 7)), ny = Math.max(1, Math.round(h / 6));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const fu = (i + 0.5) / nx, fv = (j + 0.5) / ny;
        glare.push(lerp(b0[0], b1[0], fu) + fx * (h * tilt * fv + 1.2), y + h * fv, lerp(b0[2], b1[2], fu) + fz * (h * tilt * fv + 1.2), 7 + 3 * LOOK.glare, 1, 0.98, 0.95, 0.75 * LOOK.glare * glareK);
      }
      glare.push(x + fx * 4, y + h / 2, z + fz * 4, Math.max(w, h) * 1.3, 0.95, 0.97, 1, 0.24 * LOOK.glare * glareK);
    }
  }
  for (const sg of [1, -1]) for (const u of [72, 178, 284]) {
    const p = foulPt(sg, u), N = [sg * SQ, SQ], v = 80, x = p[0] + N[0] * v, z = p[1] + N[1] * v, y = roofY(v) + 1.1, Ht = 33;
    const t = [-N[1], N[0]], c = (a, b, yy) => [x + t[0] * a + N[0] * b, yy, z + t[1] * a + N[1] * b];
    const legs = [[-2.2, -2.2], [2.2, -2.2], [2.2, 2.2], [-2.2, 2.2]];
    for (const [a, b] of legs) add('paint', K.bar(c(a, b, y), c(a * 0.55, b * 0.55, y + Ht), 0.32, '#39433d'));
    for (let k = 0; k < 6; k++) {
      const y0 = y + k * Ht / 6, y1 = y0 + Ht / 6, s0 = lerp(1, 0.55, k / 6), s1 = lerp(1, 0.55, (k + 1) / 6);
      for (let q = 0; q < 4; q++) { const [a0, b0] = legs[q], [a1, b1] = legs[(q + 1) % 4]; add('paint', K.bar(c(a0 * s0, b0 * s0, y0), c(a1 * s1, b1 * s1, y1), 0.14, '#39433d')); }
    }
    add('paint', K.box(x, y + Ht + 0.3, z, 7, 0.6, 7, '#39433d', Math.atan2(t[0], t[1])));
    lightBank(x, y + Ht + 0.8, z, 30, 13, [0, 12, -175]);
  }
  // light banks on top of the video boards
  for (const id of ['lf', 'rf']) { const b = VB[id]; if (!b) continue; const c = [(b.A[0] + b.B[0]) / 2, b.top + 2, (b.A[2] + b.B[2]) / 2]; if (LOOK.glare > 0) for (let f = 0.15; f < 0.9; f += 0.14) glare.push(lerp(b.A[0], b.B[0], f) - b.n[0] * 0.4, b.top + 2.2, lerp(b.A[2], b.B[2], f) - b.n[1] * 0.4, 6, 1, 0.98, 0.95, 0.6 * LOOK.glare); void c; }
  // scoreboard floodlights + masthead lights (glare), street lights
  if (LOOK.glare > 0) {
    for (let k = 0; k < 6; k++) glare.push(-SBHW + 6 + k * (2 * SBHW - 12) / 5, SBY0 - 1.7, SBZ + 3.3, 5, 1, 0.96, 0.88, 0.55 * LOOK.glare);
    glare.push(-1.5, MAST.arm + 0.6, MAST.z, 4.5, 0.4, 0.55, 1, 0.9 * LOOK.glare, 1.5, MAST.arm + 0.6, MAST.z, 4.5, 1, 1, 1, 0.9 * LOOK.glare);
  }
  if (LOOK.streetLamps > 0) for (const [x, y, z, sz] of LAMPS) glare.push(x, y, z, sz, 1, 0.86, 0.62, 0.8 * LOOK.streetLamps);

  mark('ribbon');
  // ribbon boards (upper-deck fascia) — scrolling LED text
  const ribCanvas = mkCanvas(LOW ? 1024 : 2048, 64), rg = ribCanvas.getContext('2d');
  T.ribbon = tex(ribCanvas); T.ribbon.wrapT = THREE.ClampToEdgeWrapping;
  M.ribbon = new THREE.MeshBasicMaterial({ map: T.ribbon, toneMapped: false, side, color: col('#ffffff').multiplyScalar(LOOK.video * 0.9) });
  disposables.push(M.ribbon);
  let ribbonMsg = null;
  function drawRibbon(hot) {
    const W = ribCanvas.width, g = rg;
    g.fillStyle = '#040506'; g.fillRect(0, 0, W, 64);
    const items = hot ? [hot, '★', hot, '★', hot, '★'] : ['BLUFOX MOBILE', '◆', 'WINDY CITY DERBY', '◆', 'WRIGLEY FIELD', '◆', 'NORTH SIDE', '◆', 'BLUFOX MOBILE', '◆', 'SWING FOR WAVELAND', '◆'];
    let x = 20; g.font = `900 42px ${FONTB}`; g.textBaseline = 'middle';
    let i = 0; while (x < W) { const t = items[i % items.length]; g.fillStyle = hot ? '#ffd23f' : (t === '◆' ? '#ff8a1f' : i % 4 === 0 ? '#ffffff' : '#9fd0ff'); g.fillText(t, x, 34); x += g.measureText(t).width + 26; i++; }
    g.fillStyle = 'rgba(0,0,0,0.4)'; for (let y = 0; y < 64; y += 4) g.fillRect(0, y, W, 1);
    T.ribbon.needsUpdate = true;
  }
  drawRibbon(null);

  // the classic red marquee outside behind home (park name only)
  {
    const zc = CFG.foul.backstop + GS.back + 24, y0 = 15, w = 36, h = 15;
    for (const x of [-w / 2 + 3, w / 2 - 3]) add('paint', K.box(x, y0 / 2, zc, 1.8, y0, 1.8, '#2b2b2b'));
    add('paint', K.box(0, y0 + h / 2, zc, w + 2.4, h + 2.4, 3.2, '#6e0e12'));
    add('paint', K.box(0, y0 + h + 2.2, zc, w * 0.6, 2.2, 2.4, '#6e0e12'));
    SIGNS.push({ kind: 'marquee', glow: 1, quad: [[w / 2, y0, zc + 1.7], [-w / 2, y0, zc + 1.7], [-w / 2, y0 + h, zc + 1.7], [w / 2, y0 + h, zc + 1.7]] });
  }

  mark('city');
  // ======================================================================
  // LAKEVIEW beyond the rooftops — Chicago grid (true bearing: CF ≈ 37° east of north), walk-ups with photo
  // facades, parkway trees, wooden water tanks, a few lakefront high-rises far out beyond RF.
  // ======================================================================
  const GB = dirXZ(-37), GA = dirXZ(53); // north, east
  const BA = 256, BB = 660, STW = 66;
  const kpt = polar(KEN.s, rFront(KEN.s)), cpt = polar(0, fenceAt(0) + 78);
  const offA = kpt[0] * GA[0] + kpt[2] * GA[1], offB = cpt[0] * GB[0] + cpt[2] * GB[1];
  const toW = (a, b) => [GA[0] * a + GB[0] * b, GA[1] * a + GB[1] * b];
  function parkClear(x, z) {
    const r = Math.hypot(x, z), s = sprayOf(x, z);
    if (Math.abs(s) <= 46) {
      const d = r - fenceAt(clamp(s, -45, 45));
      if (d < RF0 + 8) return true;
      if (RT.spray.some(([a, b]) => s >= a - 0.6 && s <= b + 0.6)) return d < RF0 + RT.depth + 28;
      if (s > RT.spray[2][1] && s < RT.spray[3][0]) return d < RF0 + RT.depth + 20;
      if (Math.abs(s) < RT.spray[2][0]) return d < RF0 + 130;
      return d < RF0 + 30;
    }
    const u1 = (x - z) * SQ, w1 = (x + z) * SQ, u3 = (-x - z) * SQ, w3 = (z - x) * SQ;
    if (u1 > -60 && u1 < LpR + 100 && w1 > -10 && w1 < 180) return true;
    if (u3 > -60 && u3 < LpL + 100 && w3 > -10 && w3 < 180) return true;
    return r < 240;
  }
  {
    const nearR = LOW ? 1150 : quality === 'medium' ? 1500 : 1850, farR = 3400;
    const roofCols = ['#4a4845', '#5e5a55', '#3f3d3b', '#55524e', '#6a655e'];
    const box = (a0, a1, b0, b1, h, fv) => {
      const P = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)], seed = R(), tall = h > RT.h + 0.5;
      for (let k = 0; k < 4; k++) {
        const p = P[k], q = P[(k + 1) % 4], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (tall) rawQuad('tall', [p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], h, q[1]], [p[0], h, p[1]], null, [0, 0, L / 40, h / 60]);
        else rawQuad('facade', [p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], h, q[1]], [p[0], h, p[1]], null, [0, 1 - h / RT.h, L / 58.7, 1], { fv, seed });
      }
      rawQuad('paint', [P[0][0], h, P[0][1]], [P[1][0], h, P[1][1]], [P[2][0], h, P[2][1]], [P[3][0], h, P[3][1]], pick(R, roofCols));
    };
    const tank = (a, b, h) => {
      const [x, z] = toW(a, b), r = 5 + R() * 2;
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) rawTpl('paint', TP.cube(), x + dx * r * 0.6, h, z + dz * r * 0.6, 0.7, 9, 0.7, '#2d2b29');
      rawTpl('paint', TP.tank(), x, h + 9, z, r, 12, r, '#6b4a33'); rawTpl('paint', TP.cone(), x, h + 21, z, r * 1.05, 5, r * 1.05, '#3a2f28');
    };
    const heightFor = r => { const q = R(); if (r > 900 && q < 0.035) return 58 + R() * 50; return q < 0.35 ? 30 + R() * 4 : q < 0.85 ? 36 + R() * 6 : RT.h; };
    let nTrees = 0; const maxTrees = LOW ? 110 : quality === 'medium' ? 240 : 420;
    for (let ia = -12; ia <= 12; ia++) for (let ib = -5; ib <= 5; ib++) {
      const a0 = ia * BA + offA + STW / 2, a1 = (ia + 1) * BA + offA - STW / 2, b0 = ib * BB + offB + STW / 2, b1 = (ib + 1) * BB + offB - STW / 2;
      const [cx, cz] = toW((a0 + a1) / 2, (b0 + b1) / 2), rc = Math.hypot(cx, cz);
      if (rc > farR + 400) continue;
      const lotOK = (a, b) => { const [x, z] = toW(a, b), r = Math.hypot(x, z); return r < farR && !parkClear(x, z); };
      if (rc > nearR) {
        for (const [e0, e1] of [[a0 + 8, a0 + 70], [a1 - 70, a1 - 8]]) {
          let b = b0 + 4;
          while (b < b1 - 20) { const len = Math.min(b1 - 4 - b, 70 + R() * 140); if (lotOK((e0 + e1) / 2, b + len / 2)) { const h = heightFor(rc); box(e0, e1, b, b + len, h, Math.floor(R() * 3)); } b += len + 6 + R() * 10; }
        }
        continue;
      }
      for (const side of [0, 1]) {
        let b = b0 + 4;
        while (b < b1 - 10) {
          const w = pick(R, [25, 25, 30, 37, 50, 50]), gap = 3 + R() * 4;
          if (b + w > b1 - 4) break;
          const dep = 55 + R() * 25, e0 = side ? a1 - 10 - dep : a0 + 10, e1 = side ? a1 - 10 : a0 + 10 + dep;
          if (lotOK((e0 + e1) / 2, b + w / 2) && lotOK(e0, b) && lotOK(e1, b + w)) {
            const h = heightFor(rc); box(e0, e1, b, b + w, h, Math.floor(R() * 3));
            if (h < 50 && R() < 0.04) tank((e0 + e1) / 2, b + w / 2, h);
          }
          if (nTrees < maxTrees && R() < 0.62) { const ta = side ? a1 + 6 : a0 - 6, [tx, tz] = toW(ta, b + w / 2); if (!parkClear(tx, tz) && Math.hypot(tx, tz) < farR) { nTrees++; tree(tx, tz, 9 + R() * 7, pick(R, TREE_GREENS)); } }
          b += w + gap;
        }
      }
    }
    // Kenmore: parkway trees both sides; trees behind the scoreboard corner
    for (let d = 40; d < KEN.L; d += 34) for (const o of [-19.5, 19.5]) if (R() < 0.85) tree(KEN.p0[0] + KEN.tn[0] * o + KEN.dn[0] * d, KEN.p0[2] + KEN.tn[1] * o + KEN.dn[1] * d, 9 + R() * 6, pick(R, TREE_GREENS));
    for (let k = 0; k < (LOW ? 6 : 14); k++) { const s = -8 + R() * 16, [x, , z] = polar(s, rFront(s) + 60 + R() * 60); if (!parkClear(x, z) || Math.abs(s) < 5.5) tree(x, z, 10 + R() * 6, pick(R, TREE_GREENS)); }
    // lakefront high-rises, ~a mile out beyond RF / RCF
    for (let k = 0; k < 10; k++) {
      const s = 26 + k * 5 + R() * 3, r = 3500 + R() * 900, [x, , z] = polar(s, r), hw = 30 + R() * 22, h = 190 + R() * 220;
      const a = x * GA[0] + z * GA[1], b = x * GB[0] + z * GB[1]; box(a - hw, a + hw, b - hw * 1.2, b + hw * 1.2, h, 0);
    }
  }
  // ground: city-block tile (streets, sidewalks, parkways, alleys) + a plaza apron around the ballpark
  {
    const c = cached('block_wrigley', () => {
      const W = 256, H = 660, cv = mkCanvas(W, H), g = cv.getContext('2d'); const r = makeRng('block');
      const sa = W * (STW / 2) / BA, sb = H * (STW / 2) / BB;
      g.fillStyle = '#44464a'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#9d9a92'; g.fillRect(sa - 9, sb - 9, W - 2 * sa + 18, H - 2 * sb + 18);
      g.fillStyle = '#56713f'; g.fillRect(sa - 4, sb - 4, W - 2 * sa + 8, H - 2 * sb + 8);
      g.fillStyle = '#5b5148'; g.fillRect(sa, sb, W - 2 * sa, H - 2 * sb);
      for (let k = 0; k < 110; k++) { g.fillStyle = r() < 0.6 ? '#4d6a38' : '#6b665d'; g.fillRect(sa + 20 + r() * (W - 2 * sa - 50), sb + r() * (H - 2 * sb - 20), 12 + r() * 16, 10 + r() * 20); }
      g.fillStyle = '#4a4b4e'; g.fillRect(W / 2 - 6, sb, 12, H - 2 * sb);
      for (let k = 0; k < 2400; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.05})`; g.fillRect(r() * W, r() * H, 2, 2); }
      return cv;
    });
    T.block = tex(c);
    M.cityGround = new THREE.MeshStandardMaterial({ map: T.block, roughness: 1, color: col(tod === 'night' ? '#8a8a8a' : '#ffffff') }); disposables.push(M.cityGround);
    const g = new THREE.CircleGeometry(6000, 96); g.rotateX(-Math.PI / 2); g.translate(0, -0.35, 0);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); uv.setXY(i, (x * GA[0] + z * GA[1] - offA) / BA + 0.5 * (STW / BA) * 0, (x * GB[0] + z * GB[1] - offB) / BB); }
    const m = new THREE.Mesh(g, M.cityGround); m.receiveShadow = true; m.name = 'ground'; m.matrixAutoUpdate = false; m.updateMatrix(); m.userData.noOcclude = true;
    group.add(m); disposables.push(g);
    const pc = cached('plaza_w', () => { const W = 128, cv = mkCanvas(W, W), gg = cv.getContext('2d'); const r = makeRng('plazaw'); gg.fillStyle = '#5a5b5e'; gg.fillRect(0, 0, W, W); for (let k = 0; k < 900; k++) { gg.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`; gg.fillRect(r() * W, r() * W, 2, 2); } gg.fillStyle = 'rgba(255,255,255,0.05)'; for (let x = 0; x < W; x += 32) { gg.fillRect(x, 0, 1, W); gg.fillRect(0, x, W, 1); } return cv; });
    T.plaza = tex(pc);
    M.plaza = new THREE.MeshStandardMaterial({ map: T.plaza, roughness: wetRough(0.95) }); disposables.push(M.plaza);
    const outline = [...offsetLine(gsPath, GS.back + 40), ...ofPath(spraySamples(-57, 57, 2)).map(P => [P.p[0] + P.n[0] * (D1 + 2), P.p[1] + P.n[1] * (D1 + 2)])];
    const sh = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const pg = new THREE.ShapeGeometry(sh); pg.rotateX(-Math.PI / 2); pg.translate(0, -0.18, 0);
    const pp = pg.attributes.position, pu = pg.attributes.uv; for (let i = 0; i < pp.count; i++) pu.setXY(i, pp.getX(i) / 48, pp.getZ(i) / 48);
    const pm = new THREE.Mesh(pg, M.plaza); pm.receiveShadow = true; pm.name = 'plaza'; pm.matrixAutoUpdate = false; pm.updateMatrix(); pm.userData.noOcclude = true;
    group.add(pm); disposables.push(pg);
  }

  mark('signs');
  // ======================================================================
  // SIGNS atlas (distance plates, board-top signs, rooftop signs, street signs, firehouse, bunting, marquee)
  // ======================================================================
  {
    const SZ = { marker: [256, 128], street: [256, 48], boardtop: [1024, 80], roof: [512, 128], firehouse: [512, 512], bunting: [128, 64], marquee: [512, 224], booth: [256, 64] };
    const AW = 1024; let x = 0, y = 0, rowH = 0;
    const items = SIGNS.map(s => ({ ...s, sz: SZ[s.kind] || [256, 96] })).sort((a, b) => b.sz[1] - a.sz[1]);
    for (const it of items) { const [w, h] = it.sz; if (x + w > AW) { x = 0; y += rowH + 4; rowH = 0; } it.px = [x, y, w, h]; x += w + 4; rowH = Math.max(rowH, h); }
    const AH = Math.pow(2, Math.ceil(Math.log2(Math.max(64, y + rowH))));
    const c = mkCanvas(AW, AH), g = c.getContext('2d'); g.clearRect(0, 0, AW, AH);
    const center = (t, cx, cy, font, color, maxW) => { g.font = font; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, cx, cy, maxW); g.textAlign = 'left'; };
    for (const it of items) {
      const [x0, y0, w, h] = it.px; it.uv = [x0 / AW + 0.5 / AW, 1 - (y0 + h) / AH + 0.5 / AH, (x0 + w) / AW - 0.5 / AW, 1 - y0 / AH - 0.5 / AH];
      g.save(); g.translate(x0, y0);
      if (it.kind === 'marker') { // green plate, white painted numerals (ivy trimmed around it)
        g.fillStyle = '#1b3d28'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, h - 8);
        g.save(); g.translate(w / 2, h / 2 + 4); g.scale(0.82, 1); center(it.text, 0, 0, `700 98px ${FONT}`, '#f2f1ea', 400); g.restore();
      } else if (it.kind === 'street') {
        g.fillStyle = '#1f6b3a'; g.fillRect(0, 0, w, h); g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, h - 8); center(it.text, w / 2, h / 2 + 1, `700 28px ${FONT}`, '#ffffff', w - 16);
      } else if (it.kind === 'boardtop') {
        const blu = it.text.startsWith('BLUFOX'); g.fillStyle = blu ? '#0d3a9a' : '#101216'; g.fillRect(0, 0, w, h);
        center(it.text, w / 2, h / 2 + 2, `900 60px ${FONTB}`, '#ffffff', w - 60); g.fillStyle = '#ff8a1f'; g.fillRect(0, h - 8, w, 8);
      } else if (it.kind === 'roof') {
        const blu = it.text.startsWith('BLUFOX'), dark = /ROOFTOP|CLUB/.test(it.text);
        g.fillStyle = blu ? '#0d3a9a' : dark ? '#16301f' : '#f1ece0'; g.fillRect(0, 0, w, h); g.strokeStyle = blu ? '#ff8a1f' : dark ? '#e8d9a8' : '#9b1c1c'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
        center(it.text, w / 2, h / 2 + 3, `900 ${it.text.length > 14 ? 44 : 56}px ${FONTB}`, blu ? '#ffffff' : dark ? '#f2e6c0' : '#9b1c1c', w - 40);
      } else if (it.kind === 'firehouse') {
        g.fillStyle = '#8a3a2a'; g.fillRect(0, 0, w, h); g.globalAlpha = 0.55; g.drawImage(brickCanvas(false), 0, 0, w, h); g.globalAlpha = 1;
        g.fillStyle = '#5e2a20'; g.fillRect(0, 0, w, 26); g.fillStyle = '#d6ccb4'; g.fillRect(0, 26, w, 10); g.fillRect(0, 214, w, 16);
        center('ENGINE 78', w / 2, 222, `700 15px ${FONT}`, '#5a3326', 300);
        for (let i = 0; i < 4; i++) { const wx = 40 + i * 116; g.fillStyle = '#d6ccb4'; g.fillRect(wx - 6, 70, 76, 118); g.fillStyle = '#26303a'; g.fillRect(wx, 76, 64, 106); g.fillStyle = '#d6ccb4'; g.fillRect(wx + 30, 76, 4, 106); g.fillRect(wx, 126, 64, 4); }
        for (const dx of [40, 272]) { g.fillStyle = '#d6ccb4'; g.fillRect(dx - 10, 262, 220, 250); g.fillStyle = '#a3161a'; g.fillRect(dx, 272, 200, 240); for (let j = 0; j < 5; j++) { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(dx, 272 + j * 48, 200, 3); } g.fillStyle = '#2a3542'; for (let i = 0; i < 4; i++) g.fillRect(dx + 12 + i * 48, 292, 38, 26); }
      } else if (it.kind === 'bunting') {
        const cols = ['#b3202a', '#f4f2ec', '#1f3c8a', '#f4f2ec', '#b3202a']; g.clearRect(0, 0, w, h);
        for (let k = 0; k < 5; k++) { g.fillStyle = cols[k]; g.beginPath(); g.moveTo(w / 2, 0); g.arc(w / 2, 0, h * (1 - k * 0.19), 0, Math.PI); g.closePath(); g.fill(); }
        g.fillStyle = '#1f3c8a'; g.fillRect(0, 0, w, 8);
      } else if (it.kind === 'marquee') {
        g.fillStyle = '#c0141f'; g.fillRect(0, 0, w, h); center('WRIGLEY FIELD', w / 2, 58, `900 64px Georgia,"Times New Roman",serif`, '#ffffff', w - 30);
        g.fillStyle = '#111317'; g.fillRect(20, 110, w - 40, 96); center('WINDY CITY DERBY', w / 2, 142, `700 40px ${FONT}`, '#f4f1e5', w - 60); center('TODAY · HOME RUN DERBY', w / 2, 184, `700 30px ${FONT}`, '#ffcf5a', w - 60);
      } else if (it.kind === 'booth') {
        g.fillStyle = '#1f3c8a'; g.fillRect(0, 0, w, h); center(it.text, w / 2, h / 2 + 2, `900 34px ${FONTB}`, '#ffffff', w - 16);
      }
      g.restore();
    }
    T.signs = tex(c, { wrap: 'clamp' });
    M.signs = new THREE.MeshStandardMaterial({ map: T.signs, alphaTest: 0.4, roughness: 0.7, side }); hookStd(M.signs, 'signs', { glow: true });
    disposables.push(M.signs);
    for (const it of items) add('signs', K.quad(...it.quad, null, it.uv, { glow: it.glow || (it.kind === 'marker' ? 0.15 : 0) }));
  }

  mark('flags');
  // ======================================================================
  // FLAGS — wind-driven shader: masthead US flag + 15 generic pennants, foul-pole pennants, roof flags
  // ======================================================================
  const flagSpecs = [];
  {
    const c = mkCanvas(512, 288), g = c.getContext('2d');
    const cell = (i, fn) => { g.save(); g.translate((i % 4) * 128, Math.floor(i / 4) * 96); fn(); g.restore(); };
    cell(0, () => { for (let k = 0; k < 13; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#b22234'; g.fillRect(0, k * 96 / 13, 128, 96 / 13 + 0.5); } g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 54, 52); g.fillStyle = '#fff'; for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(5 + i * 9 + (j % 2) * 4, 6 + j * 10, 1.6, 0, 7); g.fill(); } });
    cell(1, () => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#b3ddf2'; g.fillRect(0, 16, 128, 16); g.fillRect(0, 64, 128, 16); g.fillStyle = '#ff0000'; for (let k = 0; k < 4; k++) { const cx = 25 + k * 26, cy = 48; g.beginPath(); for (let p = 0; p < 12; p++) { const a = p * Math.PI / 6 - Math.PI / 2, rr = p % 2 ? 4.2 : 9.5; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); g.fill(); } });
    cell(2, () => { g.fillStyle = '#0d3a9a'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#ff8a1f'; g.fillRect(0, 80, 128, 16); g.fillStyle = '#fff'; g.font = `900 24px ${FONTB}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BLUFOX', 64, 42); });
    const P = [['#1f3c8a', '#ffffff'], ['#b3202a', '#ffffff'], ['#f4f2ec', '#1f3c8a'], ['#2e6b34', '#f2c230'], ['#f2c230', '#1f3c8a'], ['#5a2a7a', '#ffffff'], ['#0f6e7a', '#f4f2ec'], ['#e86a1f', '#1a1a1a'], ['#1a1a1a', '#e8e8e0']];
    P.forEach(([a, b], i) => cell(3 + i, () => { g.fillStyle = a; g.fillRect(0, 0, 128, 96); g.fillStyle = b; if (i % 3 === 0) g.fillRect(0, 36, 128, 24); else if (i % 3 === 1) { g.fillRect(0, 0, 30, 96); } else { g.beginPath(); g.moveTo(0, 0); g.lineTo(128, 96); g.lineTo(96, 96); g.lineTo(0, 24); g.closePath(); g.fill(); } }));
    T.flags = tex(c, { wrap: 'clamp' });
    // masthead
    flagSpecs.push({ a: [0.3, MAST.top - 0.6, MAST.z], w: 12, h: 6.4, cell: 0 });
    let pc = 0;
    for (const x of [-8.8, 0, 8.8]) for (let k = 0; k < 5; k++) flagSpecs.push({ a: [x + (x === 0 ? 0.3 : 0), MAST.arm - 1.6 - k * 4.1, MAST.z], w: 3.9, h: 2.5, cell: 3 + (pc++ % 9) });
    for (let k = 0; k < 3; k++) add('paint', K.cyl(k * 8.8 - 8.8, MAST.arm, MAST.z, k * 8.8 - 8.8, MAST.arm - 21, MAST.z, 0.03, 0.03, 3, '#d0d0c8'));
    for (const P0 of POLES) for (let k = 0; k < 2; k++) flagSpecs.push({ a: [P0.x, CFG.poleH - 1 - k * 4, P0.z], w: 5.5, h: 3.2, cell: 3 + ((k + (P0.s > 0 ? 3 : 0)) % 9) });
    // grandstand roof flags
    walk(offsetLine(gsPath, GS.roof[0] + 1.5), LOW ? 80 : 44, (x, z) => { const y = roofY(GS.roof[0] + 1.5) + 1; add('paint', K.cyl(x, y, z, x, y + 13, z, 0.14, 0.11, 4, '#cfcfcf')); flagSpecs.push({ a: [x, y + 12.5, z], w: 5.2, h: 3.2, cell: 3 + (flagSpecs.length % 9) }); });
    for (const f of ROOF_FLAGS) flagSpecs.push({ a: f.a, w: 6.5, h: 3.8, cell: f.cell });
  }

  mark('merge');
  // ======================================================================
  // meshes from bins (one draw call per material)
  // ======================================================================
  for (const key in RAW) {
    const B = RAW[key]; if (!B.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    if (B.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    for (const n in B.ex) g.setAttribute(n, new THREE.Float32BufferAttribute(B.ex[n], 1));
    g.setIndex(g.attributes.position.count > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
    if (key === 'leaves') { add(key, g); continue; }
    // Lakeview (city blocks, trees): separate meshes, never used as camera occluders
    const m = new THREE.Mesh(g, { paint: M.paint, facade: M.facade, tall: M.tall }[key]); m.name = 'city:' + key; m.userData.noOcclude = true;
    m.receiveShadow = false; m.castShadow = false; m.matrixAutoUpdate = false; m.updateMatrix(); group.add(m); disposables.push(g);
  }
  const matFor = key => ({ paint: M.paint, glass: M.glass, brick: M.brick, brickN: M.brickN, ivy: M.ivy, leaves: M.leaves, juniper: M.juniper, facade: M.facade, tall: M.tall,
    lamps: M.lamps, net: M.net, chain: M.chain, screen: M.screen, street: M.street, gravel: M.gravel, seatsGS: M.seatsGS, field: M.field, board: M.board, video: M.video, ribbon: M.ribbon, signs: M.signs }[key]);
  const castKeys = new Set(['paint', 'brick', 'brickN', 'ivy', 'seatsGS', 'facade', 'board', 'juniper']);
  const VC_KEYS = new Set(['paint', 'glass', 'brick', 'brickN', 'leaves']);
  for (const key in BINS) {
    if (VC_KEYS.has(key)) for (const g of BINS[key]) if (!g.attributes.color) K.finish(g, '#ffffff');
    const geo = K.merge(BINS[key]); if (!geo) continue;
    const mat = matFor(key); if (!mat) { geo.dispose(); continue; }
    const m = new THREE.Mesh(geo, mat); m.name = key;
    m.castShadow = castKeys.has(key) && !LOW; m.receiveShadow = !['lamps', 'net', 'chain', 'screen', 'video', 'ribbon'].includes(key);
    if (key === 'net' || key === 'chain' || key === 'screen') { m.renderOrder = 2; m.userData.noOcclude = true; }
    if (key === 'leaves') { m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: T.leaves, alphaTest: 0.5 }); disposables.push(m.customDepthMaterial); m.castShadow = HIGH; }
    m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m); disposables.push(geo);
  }

  mark('crowd');
  // ---- crowds
  const crowdObjs = [];
  { const o = crowdMain.build(); o.name = 'crowd'; group.add(o); crowdObjs.push(o); }
  { const o = crowdRoof.build(); o.name = 'crowd:rooftops'; group.add(o); crowdObjs.push(o); }
  for (const h of hawks) { const o = h.crowd.build(); o.name = 'crowd:ballhawks'; o.position.set(h.home[0], 0, h.home[1]); o.updateMatrix(); group.add(o); h.obj = o; }
  const allCrowds = [crowdMain, crowdRoof, ...hawks.map(h => h.crowd)];

  // ---- flags mesh
  let flagMesh = null;
  {
    const nx = 10, ny = 5, per = (nx + 1) * (ny + 1), N = flagSpecs.length;
    const pos = new Float32Array(N * per * 3), anc = new Float32Array(N * per * 3), loc = new Float32Array(N * per * 4), uv = new Float32Array(N * per * 2), idx = [];
    flagSpecs.forEach((f, k) => {
      const cu = (f.cell % 4) / 4, cv = 1 - (Math.floor(f.cell / 4) + 1) / 3;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const o = k * per + j * (nx + 1) + i; anc.set(f.a, o * 3); pos.set(f.a, o * 3); loc.set([i / nx, j / ny, f.w, f.h], o * 4); uv.set([cu + (i / nx) * 0.25, cv + (1 - j / ny) / 3], o * 2); }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = k * per + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aAnchor', new THREE.BufferAttribute(anc, 3)); g.setAttribute('aLoc', new THREE.BufferAttribute(loc, 4)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const wd = dirXZ(wind.dir), strength = clamp(wind.mph / 16, 0, 1);
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTex: { value: null }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2(wd[0], wd[1]) }, uStr: { value: wind.mph < 2 ? 0.05 : 0.25 + 0.75 * strength }, uLight: { value: tod === 'day' ? 1.0 : tod === 'dusk' ? 0.8 : 0.7 } }]);
    u.uTex.value = T.flags;
    const mat = new THREE.ShaderMaterial({
      uniforms: u, fog: true, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 aAnchor; attribute vec4 aLoc; uniform float uTime, uStr; uniform vec2 uWind; varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_vertex>
        void main(){
          vec3 dir = normalize(vec3(uWind.x, 0.0, uWind.y)); float droop = mix(1.1, 0.06, uStr);
          vec3 xa = normalize(dir * cos(droop) + vec3(0.0, -sin(droop), 0.0)); vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), dir)); vec3 ya = normalize(cross(xa, sd)); if (ya.y > 0.0) ya = -ya;
          float ph = aAnchor.x * 0.13 + aAnchor.z * 0.07 + aAnchor.y * 0.21; float k = aLoc.x;
          float arg = k * 7.5 - uTime * (3.0 + 11.0 * uStr) + ph; float amp = (0.06 + 0.24 * uStr) * aLoc.w * k;
          vec3 p = aAnchor + xa * (k * aLoc.z) + ya * (aLoc.y * aLoc.w) + sd * (sin(arg) + 0.35 * sin(arg * 2.3 + 1.7)) * amp;
          p.y -= (1.0 - uStr) * k * k * aLoc.z * 0.25;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition; vUv = uv; vSh = 0.74 + 0.26 * cos(arg);
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uLight; varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_fragment>
        void main(){ vec4 c = texture2D(uTex, vUv); gl_FragColor = vec4(c.rgb * vSh * uLight * (gl_FrontFacing ? 1.0 : 0.82), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    flagMesh = new THREE.Mesh(g, mat); flagMesh.frustumCulled = false; flagMesh.name = 'flags'; flagMesh.userData.noOcclude = true;
    group.add(flagMesh); disposables.push(g, mat);
  }

  // ---- points: glare sprites, rooftop string lights, camera flashes, car-alarm hazards (one shader)
  const pointsMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 700 }, uTime: TIME },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec4 aCol; attribute float aSize; uniform float uScale; uniform float uTime; varying vec4 vC;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 420.0); vC = aCol; }`,
    fragmentShader: `varying vec4 vC;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.2); if (a * vC.a <= 0.002) discard; gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  disposables.push(pointsMat);
  const _v2 = new THREE.Vector2();
  const scaleHook = (renderer, scene, camera) => { if (!camera.isPerspectiveCamera) return; const h = renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(_v2).y : 800; pointsMat.uniforms.uScale.value = h * 0.5 / Math.tan(camera.fov * 0.5 * D2R) * (camera.zoom || 1); };
  function makePoints(n, name, dynamic) {
    const pos = new Float32Array(n * 3), colA = new Float32Array(n * 4), size = new Float32Array(n), g = new THREE.BufferGeometry();
    const aP = new THREE.BufferAttribute(pos, 3), aC = new THREE.BufferAttribute(colA, 4), aS = new THREE.BufferAttribute(size, 1);
    if (dynamic) { aP.setUsage(THREE.DynamicDrawUsage); aC.setUsage(THREE.DynamicDrawUsage); }
    g.setAttribute('position', aP); g.setAttribute('aCol', aC); g.setAttribute('aSize', aS);
    const pts = new THREE.Points(g, pointsMat); pts.frustumCulled = false; pts.onBeforeRender = scaleHook; pts.name = name; pts.renderOrder = 5; pts.userData.noOcclude = true;
    group.add(pts); disposables.push(g);
    return { pts, pos, colA, size, aP, aC, aS, n };
  }
  if (glare.length) {
    const n = glare.length / 8, P = makePoints(n, 'glare', false);
    for (let i = 0; i < n; i++) { P.pos.set(glare.slice(i * 8, i * 8 + 3), i * 3); P.size[i] = glare[i * 8 + 3]; P.colA.set(glare.slice(i * 8 + 4, i * 8 + 8), i * 4); }
  }
  if (LOOK.string > 0 && STRINGS.length) {
    const P = makePoints(STRINGS.length, 'stringlights', false);
    STRINGS.forEach((p, i) => { P.pos.set(p, i * 3); P.size[i] = 2.1; const w = R(); P.colA.set(w < 0.8 ? [1, 0.78, 0.45, 0.95 * LOOK.string] : [1, 0.5, 0.35, 0.9 * LOOK.string], i * 4); });
  }
  // camera-flash candidates: seats in the bleachers + rooftops + lower deck
  const FLASH_POS = [];
  for (let k = 0; k < 900; k++) {
    const q = R();
    if (q < 0.55) { const s = (R() < 0.5 ? -1 : 1) * (eye + R() * (45 - eye)), d = 3 + R() * 52, [x, , z] = polar(s, fenceAt(s) + d); FLASH_POS.push([x, sH(d) + 3.4, z, s]); }
    else if (q < 0.8 && BUILDINGS.length) { const b = pick(R, BUILDINGS); if (b.firehouse) continue; const f = R(), d = 4 + R() * 18; FLASH_POS.push([lerp(b.A[0], b.B[0], f) + b.n[0] * d, RT.h + 3 + d * 0.65 + 4, lerp(b.A[2], b.B[2], f) + b.n[1] * d, b.s]); }
    else { const P = gsPath[Math.floor(R() * gsPath.length)], v = 5 + R() * 60; FLASH_POS.push([P.p[0] + P.n[0] * v, lowSeatY(v) + 3, P.p[1] + P.n[1] * v, sprayOf(P.p[0], P.p[1])]); }
  }
  const FL = makePoints(HIGH ? 90 : 50, 'flashes', true); let flCursor = 0, flRate = 0, flSpray = 0;
  const flLife = new Float32Array(FL.n);
  function flashAt(sprayC, spread) {
    for (let tries = 0; tries < 12; tries++) {
      const p = FLASH_POS[Math.floor(R() * FLASH_POS.length)];
      if (Math.abs(p[3] - sprayC) > spread) continue;
      const i = flCursor; flCursor = (flCursor + 1) % FL.n; FL.pos.set(p.slice(0, 3), i * 3); FL.size[i] = 3.2 + R() * 1.6; flLife[i] = 0.09 + R() * 0.06; FL.aS.needsUpdate = true; return;
    }
  }
  const AL = makePoints(6, 'alarm', true); const alarm = { t: -1, car: null };

  // ---- rain (drizzle)
  let rain = null;
  if (weather === 'drizzle') {
    const N = HIGH ? 2600 : quality === 'medium' ? 1700 : 900;
    const seed = new Float32Array(N * 6), endA = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { const x = R(), y = R(), z = R(); seed.set([x, y, z, x, y, z], i * 6); endA[i * 2] = 0; endA[i * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(seed, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(endA, 1));
    const wd = dirXZ(wind.dir), wv = wind.mph * 1.466 * 0.8;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFall: { value: new THREE.Vector3(wd[0] * wv, -28, wd[1] * wv) }, uBox: { value: new THREE.Vector3(150, 90, 150) }, uCol: { value: col(tod === 'night' ? '#9fb2d6' : '#d4dbe4') } },
      transparent: true, depthWrite: false,
      vertexShader: `attribute float aEnd; uniform float uTime; uniform vec3 uCam, uFall, uBox; varying float vA;
        void main(){ vec3 p = position * uBox + uFall * uTime; vec3 o = uCam - uBox * 0.5; p = mod(p - o, uBox) + o; p -= uFall * 0.05 * aEnd;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; vA = (1.0 - aEnd * 0.8) * smoothstep(0.0, 8.0, -mv.z); }`,
      fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ gl_FragColor = vec4(uCol, 0.32 * vA);
        #include <colorspace_fragment>
      }`,
    });
    rain = new THREE.LineSegments(g, mat); rain.frustumCulled = false; rain.name = 'rain'; rain.renderOrder = 8; rain.userData.noOcclude = true;
    rain.onBeforeRender = (r, s, cam) => { cam.getWorldPosition(mat.uniforms.uCam.value); };
    group.add(rain); disposables.push(g, mat);
  }

  mark('sky');
  // ======================================================================
  // SKY — the backdrop's downtown skyline is mapped BEHIND home plate / the 1B grandstand (spray ≈ 131°,
  // as at the real park); the batter looks at its cloud field and Lakeview roofs.
  // ======================================================================
  let skySrc = null, horizonF = 0.78, skyBitmap = false;
  {
    const key = `sky_wrigley_${tod}`, im = assetImage(key), meta = assetMeta(key);
    if (im) { skySrc = natural(im); skyBitmap = false; horizonF = (meta && meta.horizon) || 0.78; } else { skySrc = paintSky(tod); horizonF = 0.78; }
  }
  const SKY_ROWS = 100, skyPix = (() => { const c = mkCanvas(8, SKY_ROWS), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(skySrc, 0, 0, 8, SKY_ROWS); return g.getImageData(0, 0, 8, SKY_ROWS).data; })();
  const skyAvg = (y0, y1) => { // average colour of rows [y0,y1] (fractions of the image height)
    const r0 = clamp(Math.floor(y0 * SKY_ROWS), 0, SKY_ROWS - 1), r1 = clamp(Math.ceil(y1 * SKY_ROWS), r0 + 1, SKY_ROWS);
    let r = 0, gg = 0, b = 0, n = 0; for (let y = r0; y < r1; y++) for (let x = 0; x < 8; x++) { const i = (y * 8 + x) * 4; r += skyPix[i]; gg += skyPix[i + 1]; b += skyPix[i + 2]; n++; }
    return `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`;
  };
  const topCol = skyAvg(0, 0.04), botCol = skyAvg(0.94, 1), horizCol = skyAvg(horizonF - 0.05, horizonF), hazeSky = skyAvg(horizonF - 0.16, horizonF - 0.1);
  const VDPP = 0.0733, elTop = horizonF * 878 * VDPP, elBot = -(1 - horizonF) * 878 * VDPP;
  T.sky = tex(skySrc, { wrap: 'clamp', flipY: !skyBitmap });
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: T.sky }, uTop: { value: col(topCol) }, uBot: { value: col(botCol) }, uZen: { value: col(topCol).multiplyScalar(tod === 'day' ? 0.85 : 0.7) },
      uH: { value: horizonF }, uElTop: { value: elTop }, uElBot: { value: elBot }, uHaze: { value: col(LOOK.haze) }, uHazeAmt: { value: LOOK.hazeAmt },
      uDesat: { value: LOOK.skyDesat }, uBright: { value: LOOK.skyBright }, uDrift: { value: 0 }, uS0: { value: 86 }, uHz: { value: col(hazeSky).lerp(col(LOOK.fog), 0.3).multiplyScalar(tod === 'night' ? 0.8 : 1) }, uDark: { value: tod === 'night' ? 1 : 0 },
      uGlow: { value: tod === 'night' ? 0.5 : tod === 'dusk' ? 0.18 : 0 }, uGlowCol: { value: col(tod === 'night' ? '#b08a70' : '#ffd2a8') },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform sampler2D uSky; uniform vec3 uTop, uBot, uZen, uHaze, uGlowCol; uniform float uH, uElTop, uElBot, uHazeAmt, uDesat, uBright, uDrift, uGlow, uS0, uDark; uniform vec3 uHz;
      varying vec3 vW;
      #include <common>
      void main(){
        vec3 d = normalize(vW - cameraPosition);
        float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
        float s = degrees(atan(d.x, -d.z)) + uDrift;
        float u = (s - uS0) / 180.0; u = 1.0 - abs(1.0 - mod(u, 2.0));
        float v = el >= 0.0 ? uH * (1.0 - el / uElTop) : uH + (1.0 - uH) * (el / uElBot);
        float tv = clamp(v, 0.002, 0.998); vec3 img = texture2D(uSky, vec2(clamp(u, 0.001, 0.999), 1.0 - tv)).rgb;
        vec3 c;
        if (v < 0.0) { float t = clamp(-v / 0.35, 0.0, 1.0); c = mix(uTop, uZen, t); c = mix(img, c, smoothstep(0.0, 0.06, -v)); }
        else if (v > 1.0) c = uBot; else c = img;
        float sa = degrees(atan(d.x, -d.z)); float front = smoothstep(-112.0, -84.0, sa) * (1.0 - smoothstep(64.0, 96.0, sa));
        c = mix(c, uHz, front * (1.0 - smoothstep(5.5, 13.0, el)) * (1.0 - smoothstep(-2.0, -6.0, el)));
        float l = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(c, vec3(l), uDesat) * uBright;
        c = mix(c, uHaze, uHazeAmt * (1.0 - smoothstep(0.0, 22.0, abs(el))));
        c *= mix(1.0, 0.42, uDark * smoothstep(3.0, 26.0, el));
        c += uGlowCol * uGlow * exp(-max(el - 1.5, 0.0) / 6.0) * smoothstep(-6.0, 1.0, el);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), skyMat);
  skyMesh.renderOrder = -1000; skyMesh.frustumCulled = false; skyMesh.name = 'sky';
  group.add(skyMesh); disposables.push(skyMesh.geometry, skyMat);
  // environment (equirect canvas → PMREM by three)
  let envTex = null;
  {
    const W = 256, H = 128, c = mkCanvas(W, H), g = c.getContext('2d'), rowOf = el => (90 - el) / 180 * H;
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, topCol); gr.addColorStop(rowOf(elTop) / H, topCol); gr.addColorStop(rowOf(0) / H, horizCol);
    const ground = tod === 'day' ? '#4a5a3c' : tod === 'dusk' ? '#3a3228' : '#12160f';
    gr.addColorStop(Math.min(0.99, rowOf(-6) / H), ground); gr.addColorStop(1, shade(ground, 0.6)); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const y0 = rowOf(elTop), y1 = rowOf(elBot);
    if (skyBitmap) { g.save(); g.translate(0, y0 + y1); g.scale(1, -1); }
    g.drawImage(skySrc, 0, y0, W / 2, y1 - y0); g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(skySrc, 0, y0, W / 2, y1 - y0); g.restore();
    if (skyBitmap) g.restore();
    g.fillStyle = ground; g.globalAlpha = 0.85; g.fillRect(0, rowOf(-4), W, H); g.globalAlpha = 1;
    if (LOOK.lamps > 0) { g.fillStyle = 'rgba(255,252,240,0.95)'; for (let i = 0; i < 10; i++) { g.beginPath(); g.arc(i * W / 10 + 12, rowOf(26), 3, 0, 7); g.fill(); } }
    envTex = tex(c, { wrap: 'clamp', mips: false }); envTex.mapping = THREE.EquirectangularReflectionMapping;
  }

  mark('lightsetup');
  // ======================================================================
  // LIGHTS — one shadow-casting key (sun / roof banks) fitted around the field, hemisphere fill, rim
  // ======================================================================
  const toDir = (el, az) => new THREE.Vector3(Math.sin(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), -Math.cos(az * D2R) * Math.cos(el * D2R)).normalize();
  const sunDir = toDir(LOOK.keyEl, LOOK.keyAz);
  const key = new THREE.DirectionalLight(col(LOOK.keyColor), LOOK.keyI);
  const target = new THREE.Object3D(); target.position.set(0, 0, -190); group.add(target); key.target = target;
  key.position.copy(target.position).addScaledVector(sunDir, 900);
  key.castShadow = !LOW;
  if (key.castShadow) {
    const sz = HIGH ? 2048 : 1024; key.shadow.mapSize.set(sz, sz); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.35; key.shadow.intensity = LOOK.shadowI;
    const m = new THREE.Matrix4().lookAt(key.position, target.position, new THREE.Vector3(0, 1, 0)); m.setPosition(key.position); const inv = m.clone().invert();
    const v = new THREE.Vector3(); let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    const pts = [...loop.map(([x, z]) => [x, z]), ...offsetLine(pathOF, OF.depth).filter((_, i) => i % 4 === 0)];
    for (const [x, z] of pts) for (const y of [0, 16]) { v.set(x, y, z).applyMatrix4(inv); mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x); mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y); mnz = Math.min(mnz, v.z); mxz = Math.max(mxz, v.z); }
    const cam = key.shadow.camera; cam.left = mnx - 4; cam.right = mxx + 4; cam.bottom = mny - 4; cam.top = mxy + 4; cam.near = Math.max(1, -mxz - 500); cam.far = -mnz + 80; cam.updateProjectionMatrix();
  }
  group.add(key);
  const hemi = new THREE.HemisphereLight(col(LOOK.hemiSky), col(LOOK.hemiGround), LOOK.hemiI); group.add(hemi);
  let rimLight = null;
  if (LOOK.rim) { rimLight = new THREE.DirectionalLight(col(LOOK.rim.color), LOOK.rim.i); rimLight.position.copy(toDir(LOOK.rim.el, LOOK.rim.az)).multiplyScalar(900); rimLight.target = target; group.add(rimLight); }

  mark('boarddraw');
  // ======================================================================
  // BOARD PAINTING — the hand-operated scoreboard (derby as a line score), LF/RF video boards
  // ======================================================================
  const board = { name: 'PLAYER', homers: 0, outs: 0, score: 0, lastFt: 0, message: '', longest: 0 };
  const line = { name: '', runs: new Array(10).fill(null), outs: 0, homers: 0 }, history = [];
  const cel = { t: -1, dur: 6, distance: 0, bonus: null, spray: 0, oop: false };
  const clockMin0 = { day: 13 * 60 + 35, dusk: 19 * 60 + 42, night: 20 * 60 + 55 }[tod]; let clockMin = clockMin0, clockAcc = 0;
  let boardDirty = true, videoClock = 0, videoDirty = true, lastSB = -1;
  const WHITE = '#f2f1ea', YEL = '#f2c230', GRN = '#1f4a33';
  const windTxt = (() => { const a = ((wind.dir + 540) % 360) - 180, m = Math.round(wind.mph); if (m < 2) return 'CALM'; if (Math.abs(a) <= 22) return 'OUT ' + m; if (Math.abs(a) >= 158) return 'IN ' + m; if (Math.abs(a) < 68) return (a < 0 ? 'OUT LF ' : 'OUT RF ') + m; if (Math.abs(a) > 112) return (a < 0 ? 'IN RF ' : 'IN LF ') + m; return (a < 0 ? 'R-L ' : 'L-R ') + m; })();
  const sbBase = (() => { // static layer: plates, seams, headers, labels
    const c = mkCanvas(BW, FACE_H), g = c.getContext('2d'), k = BW / 2048, r = makeRng('sbbase');
    g.fillStyle = GRN; g.fillRect(0, 0, BW, FACE_H);
    for (let i = 0; i < 2600 * k; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '220,235,220'},${r() * 0.05})`; g.fillRect(r() * BW, r() * FACE_H, 2 + r() * 6 * k, 1 + r() * 3 * k); }
    for (let x = 0; x < BW; x += 128 * k) { g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x, 0, 2 * k, FACE_H); g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(x + 2 * k, 0, 2 * k, FACE_H); }
    for (let y = 0; y < FACE_H; y += 116 * k) { g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, y, BW, 2 * k); }
    g.strokeStyle = 'rgba(230,240,225,0.55)'; g.lineWidth = 5 * k; g.strokeRect(12 * k, 12 * k, BW - 24 * k, FACE_H - 24 * k);
    g.fillStyle = 'rgba(230,240,225,0.35)'; g.fillRect(BW / 2 - 3 * k, 18 * k, 6 * k, FACE_H - 150 * k);
    const txt = (t, x, y, px, color = WHITE, align = 'left', sx = 0.8) => { g.save(); g.translate(x, y); g.scale(sx, 1); g.font = `700 ${px * k}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(t, 0, 0); g.restore(); };
    for (const col0 of [0, 1024]) {
      const X = x => (col0 + x) * k;
      txt(col0 ? 'TODAY' : 'WINDY CITY DERBY', X(38), 56 * k, 46);
      if (!col0) for (let i = 0; i < 10; i++) txt(String(i + 1), X(292 + i * 66), 56 * k, 40, WHITE, 'center');
      if (!col0) txt('HR', X(965), 56 * k, 40, WHITE, 'center');
      for (let rI = 0; rI < 5; rI++) {
        const y = (104 + rI * 94) * k;
        g.fillStyle = 'rgba(4,20,12,0.42)';
        if (!col0) { g.fillRect(X(30), y, 220 * k, 78 * k); for (let i = 0; i < 10; i++) g.fillRect(X(262 + i * 66), y, 58 * k, 78 * k); g.fillRect(X(930), y, 70 * k, 78 * k); }
        else { g.fillRect(X(30), y, 250 * k, 78 * k); for (let i = 0; i < 9; i++) g.fillRect(X(300 + i * 74), y, 66 * k, 78 * k); }
      }
      if (col0) ['LAST', 'LONG', 'SCORE', 'OUTS', 'WIND'].forEach((t, rI) => txt(t, X(155), (143 + rI * 94) * k, 66, WHITE, 'center', 0.72));
    }
    // bottom band: message plates (left), ball/strike/out unit (centre), at-bat (right)
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(30 * k, 590 * k, 900 * k, 84 * k); g.fillRect(1120 * k, 590 * k, 900 * k, 84 * k);
    g.fillStyle = '#10261a'; g.fillRect(940 * k, 584 * k, 168 * k, 96 * k);
    ['B', 'S', 'O'].forEach((t, i) => txt(t, (958 + i * 0) * k, (604 + i * 28) * k, 24, WHITE, 'left', 1));
    return c;
  })();
  function plateText(g, t, x, y, w, h, px, color, k) { g.save(); g.translate(x + w / 2, y + h / 2 + 3 * k); g.scale(0.7, 1); g.font = `900 ${px * k}px ${FONTB}`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 0, 0, w / 0.7 - 6 * k); g.restore(); }
  function drawScoreboard() {
    const g = bg, k = BW / 2048, celebrating = cel.t >= 0 && cel.t < cel.dur;
    g.drawImage(sbBase, 0, 0);
    // left column: the current hitter's line (per out, homers hit) + earlier rounds
    const lines = [{ name: line.name || board.name, runs: line.runs, total: board.homers | 0, live: true }, ...history];
    for (let rI = 0; rI < 5; rI++) {
      const L = lines[rI]; if (!L) continue; const y = (104 + rI * 94) * k;
      plateText(g, String(L.name || '').toUpperCase().slice(0, 7), 30 * k, y, 220 * k, 78 * k, 70, WHITE, k);
      for (let i = 0; i < 10; i++) {
        const v = L.runs[i], cur = L.live && i === Math.min(9, board.outs | 0);
        if (v == null && !cur) continue;
        plateText(g, String(v || 0), (262 + i * 66) * k, y, 58 * k, 78 * k, 86, cur ? YEL : WHITE, k);
      }
      plateText(g, String(L.total), 930 * k, y, 70 * k, 78 * k, 86, WHITE, k);
    }
    // right column: numbers slotted plate by plate
    const vals = [board.lastFt ? String(Math.round(board.lastFt)) : '', board.longest ? String(Math.round(board.longest)) : '', String(Math.round(board.score) || 0), String(board.outs | 0), windTxt];
    vals.forEach((v, rI) => { const chars = v.split(''), y = (104 + rI * 94) * k; for (let i = 0; i < Math.min(9, chars.length); i++) plateText(g, chars[i], (1024 + 300 + i * 74) * k, y, 66 * k, 78 * k, 86, WHITE, k); });
    // message band + at-bat
    let msg = String(board.message || 'WRIGLEY FIELD').toUpperCase();
    if (celebrating) msg = cel.oop ? ((Math.floor(cel.t * 1.6) % 2) ? `${Math.round(cel.distance)} FT` : 'OUT OF THE PARK') : ((Math.floor(cel.t * 1.8) % 2) ? `${Math.round(cel.distance)} FT` : 'HOME RUN');
    plateText(g, msg.slice(0, 22), 30 * k, 590 * k, 900 * k, 84 * k, 70, celebrating ? YEL : WHITE, k);
    plateText(g, 'BATTER ' + String(board.name || '').toUpperCase().slice(0, 10), 1120 * k, 590 * k, 900 * k, 84 * k, 64, WHITE, k);
    // B/S/O lamps (the one electronic unit)
    for (let i = 0; i < 3; i++) for (let j = 0; j < (i === 0 ? 3 : 2); j++) {
      const on = i === 2 ? j < ((board.outs | 0) % 3) : celebrating ? (Math.floor(cel.t * 4 + j) % 2 === 0) : false;
      g.fillStyle = on ? (i === 0 ? '#7dff7a' : '#ff5b4a') : '#2c3a31'; g.beginPath(); g.arc((1000 + j * 30) * k, (604 + i * 28) * k, 10 * k, 0, 7); g.fill();
    }
    drawClock();
    T.board.needsUpdate = true; boardDirty = false;
  }
  function drawClock() { // green face, dots instead of numerals, cream hands (region: bottom-left 256x256)
    const g = bg, q = BW / 2048, cx = 128 * q, cy = BH - 128 * q, rr = 118 * q;
    g.save(); g.fillStyle = GRN; g.fillRect(0, BH - 256 * q, 256 * q, 256 * q); g.translate(cx, cy); g.scale(q, q); g.translate(-128, -128);
    const X = 128, Y = 128, RR = 118;
    g.fillStyle = '#e9e3cc'; g.beginPath(); g.arc(X, Y, RR, 0, 7); g.fill();
    g.fillStyle = '#1d4a33'; g.beginPath(); g.arc(X, Y, RR - 10, 0, 7); g.fill();
    g.fillStyle = '#f2efe2'; for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6, r0 = k % 3 === 0 ? 11 : 7.5; g.beginPath(); g.arc(X + Math.sin(a) * 88, Y - Math.cos(a) * 88, r0, 0, 7); g.fill(); }
    const hh = (clockMin / 60) % 12, mm = clockMin % 60;
    const hand = (a, len, w) => { g.save(); g.translate(X, Y); g.rotate(a); g.fillRect(-w / 2, -len, w, len + 12); g.restore(); };
    hand(hh / 12 * Math.PI * 2, 56, 11); hand(mm / 60 * Math.PI * 2, 84, 7);
    g.beginPath(); g.arc(X, Y, 9, 0, 7); g.fill(); g.restore(); void rr;
  }
  const ADS = [['BLUFOX MOBILE', 'Chicago’s neighborhood wireless store', '#0d3a9a', '#ff8a1f'], ['LAKESHORE LEMONADE', 'Ice cold · every aisle', '#f2c230', '#1a1a1a'], ['NORTHSIDE NOODLE CO.', 'Clark & Addison since forever', '#b3202a', '#ffffff'], ['WINDY CITY DERBY', 'Hit it onto Waveland', '#101820', '#ff8a1f']];
  function drawVideo(t) {
    const g = vg, s = VW / 1024, celebrating = cel.t >= 0 && cel.t < cel.dur;
    for (const id of ['lf', 'rf']) {
      const b = VB[id]; if (!b) continue;
      const W = VW, H = b.ph, y0 = Math.round(b.row * VW);
      g.save(); g.beginPath(); g.rect(0, y0, W, H); g.clip(); g.translate(0, y0);
      const ctext = (txt, x, y, px, color, stroke = 0, maxW = W - 40 * s, weight = 900) => { g.font = `${weight} ${px * s}px ${FONTB}`; g.textAlign = 'center'; g.textBaseline = 'middle'; if (stroke) { g.lineWidth = stroke * s; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(txt, x, y, maxW); } g.fillStyle = color; g.fillText(txt, x, y, maxW); };
      if (celebrating) {
        const k = cel.t, hue = (k * 90) % 360, flash = Math.max(0, 1 - k * 2.2);
        const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, `hsl(${(hue + 210) % 360},85%,${14 + flash * 50}%)`); grd.addColorStop(1, `hsl(${(hue + 250) % 360},90%,${8 + flash * 50}%)`); g.fillStyle = grd; g.fillRect(0, 0, W, H);
        g.save(); g.translate(W / 2, H / 2); g.rotate(k * 0.5); for (let i = 0; i < 24; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.09)' : 'rgba(255,200,120,0.03)'; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 900 * s, i * Math.PI / 12, (i + 1) * Math.PI / 12); g.fill(); } g.restore();
        const sc = 1 + 0.1 * Math.sin(k * 9) * Math.exp(-k * 0.7);
        const label = cel.bonus && PK.bonus[cel.bonus] ? PK.bonus[cel.bonus].label : '';
        if (id === 'lf') {
          g.save(); g.translate(W / 2, H * 0.4); g.scale(sc, sc); ctext(cel.oop ? 'OUT OF THE PARK!' : 'HOME RUN!', 0, 0, cel.oop ? 100 : 128, '#ffffff', 12, W - 60 * s); g.restore();
          ctext(`${String(board.name || '').toUpperCase()} · ${Math.round(cel.distance)} FT`, W / 2, H * 0.8, 50, '#ffd23f', 6);
        } else {
          ctext(`${Math.round(cel.distance)}`, W * 0.42, H * 0.46, 170, '#ffffff', 12); ctext('FT', W * 0.8, H * 0.52, 80, '#ffd23f', 8);
          if (label) ctext(label, W / 2, H * 0.86, 46, '#ffffff', 6);
        }
      } else if (id === 'lf') {
        const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#0b1a36'); grd.addColorStop(1, '#050a16'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
        const sx = ((t * 120) % (W + 700 * s)) - 350 * s, sw = g.createLinearGradient(sx - 220 * s, 0, sx + 220 * s, 0); sw.addColorStop(0, 'rgba(80,140,255,0)'); sw.addColorStop(0.5, 'rgba(80,140,255,0.14)'); sw.addColorStop(1, 'rgba(80,140,255,0)'); g.fillStyle = sw; g.fillRect(0, 0, W, H);
        g.fillStyle = '#ff8a1f'; g.fillRect(28 * s, 26 * s, 260 * s, 54 * s); ctext('NOW BATTING', 158 * s, 54 * s, 34, '#0b1020', 0, 250 * s);
        g.textAlign = 'left'; g.font = `900 ${118 * s}px ${FONTB}`; g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.fillText(String(board.name || 'PLAYER').toUpperCase().slice(0, 14), 28 * s, 150 * s, W * 0.62);
        const tiles = [['HR', String(board.homers | 0)], ['OUTS', `${board.outs | 0}/10`], ['SCORE', (Math.round(board.score) || 0).toLocaleString('en-US')], ['LAST', board.lastFt ? `${Math.round(board.lastFt)}` : '—']];
        tiles.forEach(([lab, val], i) => { const x = (28 + i * 245) * s, y = 225 * s; g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, y, 230 * s, 110 * s); g.fillStyle = '#ff8a1f'; g.fillRect(x, y, 230 * s, 6 * s); g.textAlign = 'left'; g.font = `800 ${26 * s}px ${FONTB}`; g.fillStyle = '#9fb3d4'; g.fillText(lab, x + 14 * s, y + 32 * s); g.font = `900 ${56 * s}px ${FONTB}`; g.fillStyle = '#ffffff'; g.fillText(val, x + 14 * s, y + 80 * s, 205 * s); });
        g.fillStyle = '#0d3a9a'; g.fillRect(W - 300 * s, 20 * s, 280 * s, 70 * s); ctext('BLUFOX', W - 160 * s, 48 * s, 40, '#ffffff'); g.fillStyle = '#ff8a1f'; g.fillRect(W - 300 * s, 80 * s, 280 * s, 10 * s);
      } else {
        const phase = Math.floor(t / 7) % 4;
        if (phase === 0 || phase === 2) {
          const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, '#0d2a66'); grd.addColorStop(1, '#16408f'); g.fillStyle = grd; g.fillRect(0, 0, W, H); g.fillStyle = '#ff8a1f'; g.fillRect(0, H - 16 * s, W, 16 * s);
          if (phase === 0) { ctext(board.lastFt ? 'LAST HIT' : 'WRIGLEY FIELD', W / 2, H * 0.2, 44, '#9fc0ff'); ctext(board.lastFt ? `${Math.round(board.lastFt)} FT` : 'EST. 1914', W / 2, H * 0.58, 140, '#ffffff', 8); }
          else { ctext('LAKE WIND', W / 2, H * 0.2, 44, '#9fc0ff'); ctext(windTxt.replace('OUT', 'OUT').replace('IN', 'IN'), W / 2, H * 0.58, 120, '#ffffff', 8); ctext('MPH', W * 0.5, H * 0.87, 40, '#9fc0ff'); }
        } else {
          const [a, b2, c1, c2] = ADS[(Math.floor(t / 28) + (phase === 3 ? 1 : 0)) % ADS.length];
          g.fillStyle = c1; g.fillRect(0, 0, W, H); g.fillStyle = 'rgba(255,255,255,0.07)'; for (let x = -H; x < W; x += 60 * s) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.lineTo(x + H + 24 * s, 0); g.lineTo(x + 24 * s, H); g.fill(); }
          ctext(a, W / 2, H * 0.44, a.length > 14 ? 84 : 104, c2, 0, W - 50 * s); ctext(b2, W / 2, H * 0.78, 38, c2 === '#1a1a1a' ? '#1a1a1a' : '#ffffff', 0, W - 60 * s, 700);
        }
      }
      g.restore();
    }
    T.video.needsUpdate = true; videoDirty = false;
  }
  drawScoreboard(); drawVideo(0);

  mark('end');
  // ======================================================================
  // STATE + API
  // ======================================================================
  let exciteTarget = 0.3, boost = 0, lastT = 0;
  const fogCol = col(LOOK.fog).lerp(col(horizCol), weather === 'clear' || weather === 'heat' ? 0.55 : 0.3);
  const fog = new THREE.FogExp2(fogCol, LOOK.fogD), bgColor = fogCol.clone();
  const saved = { background: null, fog: null, environment: null, envI: 1, had: false };
  const setAllExcite = v => { for (const c of allCrowds) { try { c.setExcite(v); } catch (e) { /* stub */ } } };
  setAllExcite(exciteTarget);
  // Crowd facade (frozen Crowd API) over bowl + rooftops + ballhawks
  const crowdAPI = {
    get count() { return allCrowds.reduce((n, c) => n + (c.count || 0), 0); },
    addRow: (...a) => crowdMain.addRow(...a), addFan: (...a) => crowdMain.addFan(...a), build: () => group,
    update: (dt, t) => { for (const c of allCrowds) c.update(dt, t); },
    setExcite: v => { exciteTarget = clamp(+v || 0, 0, 1); setAllExcite(exciteTarget); },
    flash: (spray = 0) => { crowdMain.flash(spray); crowdRoof.flash(spray); },
    wave: (o = {}) => Math.max(crowdMain.wave(o) || 0, crowdRoof.wave(o) || 0),
    celebrate: (o = {}) => { for (const c of allCrowds) c.celebrate(o); },
    dispose: () => { for (const c of allCrowds) { try { c.dispose(); } catch (e) { /* ignore */ } } },
  };
  const boards = [
    { id: 'scoreboard', pos: [0, (SBY0 + SBY1) / 2, SBZ], normal: [0, 0, 1], w: 2 * SBHW, h: SBY1 - SBY0, top: MAST.top },
    ...['lf', 'rf'].map(id => { const b = VB[id]; return b && { id, pos: b.c, normal: [-b.n[0], 0, -b.n[1]], w: b.w, h: b.screenTop - b.bottom, bottom: b.bottom, top: b.top }; }).filter(Boolean),
  ];
  const landmarks = {
    booth: { pos: PK.booth.pos.slice(), look: PK.booth.look.slice(), windows: BOOTHW },
    street: polar(-24, fenceAt(-24) + 78, 0),
    streets: { waveland: polar(-24, fenceAt(-24) + 78, 0), sheffield: polar(30, fenceAt(30) + 78, 0), kenmore: [KEN.p0[0] + KEN.dn[0] * 120, 0, KEN.p0[2] + KEN.dn[1] * 120] },
    boards,
    rooftops: BUILDINGS.filter(b => !b.firehouse).map(b => [b.mid[0] + b.n[0] * 14, RT.h + 8, b.mid[2] + b.n[1] * 14]),
    firehouse: (BUILDINGS.find(b => b.firehouse) || {}).mid || null,
    scoreboard: { pos: [0, (SBY0 + SBY1) / 2, SBZ], clock: [0, (SBY1 + CROWN.y1) / 2, CROWN.z0], mast: [0, MAST.top, MAST.z] },
  };

  const api = {
    group, sunDir: sunDir.clone(), parkId, timeOfDay: tod, weather, quality,
    lights: { key, hemi, rim: rimLight },
    crowd: crowdAPI, landmarks,
    attach(scene) {
      if (!scene) return;
      if (!saved.had) { saved.background = scene.background; saved.fog = scene.fog; saved.environment = scene.environment; saved.envI = scene.environmentIntensity ?? 1; saved.had = true; }
      scene.add(group); scene.background = bgColor; scene.fog = fog; scene.environment = envTex;
      if ('environmentIntensity' in scene) scene.environmentIntensity = LOOK.envI;
    },
    detach(scene) {
      if (!scene) return;
      scene.remove(group);
      if (saved.had) {
        if (scene.background === bgColor) scene.background = saved.background;
        if (scene.fog === fog) scene.fog = saved.fog;
        if (scene.environment === envTex) scene.environment = saved.environment;
        if ('environmentIntensity' in scene) scene.environmentIntensity = saved.envI;
        saved.had = false;
      }
    },
    update(dt = 0.016, t = lastT + dt) {
      dt = clamp(+dt || 0, 0, 0.1); lastT = t; TIME.value = t;
      if (boost > 0) { boost -= dt; if (boost <= 0) setAllExcite(exciteTarget); }
      crowdAPI.update(dt, t);
      flagMesh.material.uniforms.uTime.value = t;
      if (rain) rain.material.uniforms.uTime.value = t;
      T.ribbon.offset.x = (t * 0.03) % 1;
      skyMat.uniforms.uDrift.value = t * 0.03;
      // ballhawks scramble to the ball, linger, then wander back
      for (const h of hawks) {
        if (!h.target && h.pos[0] === h.home[0] && h.pos[1] === h.home[1]) continue;
        h.t += dt;
        const goal = h.target && h.t < h.hold ? h.target : h.home;
        if (h.t < h.delay) continue;
        const dx = goal[0] - h.pos[0], dz = goal[1] - h.pos[1], L = Math.hypot(dx, dz), sp = (goal === h.home ? 6 : h.speed) * Math.min(1, (h.t - h.delay) * 2);
        if (L < 0.3) { if (goal === h.home) { h.pos = h.home.slice(); h.target = null; } }
        else { const st = Math.min(L, sp * dt); h.pos[0] += dx / L * st; h.pos[1] += dz / L * st; }
        h.obj.position.set(h.pos[0], Math.abs(Math.sin(h.t * 11)) * (L > 1 && goal !== h.home ? 0.35 : 0), h.pos[1]); h.obj.updateMatrix();
      }
      // camera flashes
      const want = flRate * dt; flRate = Math.max(LOOK.night * 0.8, flRate - dt * 8);
      let nf = Math.floor(want) + (R() < want % 1 ? 1 : 0); while (nf-- > 0) flashAt(flSpray, flRate > 5 ? 70 : 200);
      let any = false; for (let i = 0; i < FL.n; i++) { if (flLife[i] > 0) { flLife[i] -= dt; any = true; } FL.colA[i * 4] = FL.colA[i * 4 + 1] = FL.colA[i * 4 + 2] = 1.6; FL.colA[i * 4 + 3] = flLife[i] > 0 ? 1 : 0; }
      if (any || FL._any) { FL.aC.needsUpdate = true; FL.aP.needsUpdate = true; } FL._any = any;
      // car alarm (hazards blinking near the landing)
      if (alarm.t >= 0) {
        alarm.t += dt; const on = Math.floor(alarm.t * 3.2) % 2 === 0 && alarm.t < 7.5;
        for (let i = 0; i < 6; i++) AL.colA[i * 4 + 3] = on ? (i < 4 ? 1 : 0.7) : 0;
        AL.aC.needsUpdate = true; if (alarm.t > 7.6) alarm.t = -1;
      }
      // boards
      if (cel.t >= 0) { cel.t += dt; if (cel.t > cel.dur) { cel.t = -1; cel.oop = false; cel.dur = 6; boardDirty = true; videoDirty = true; drawRibbon(null); } }
      clockAcc += dt; if (clockAcc >= 60) { clockAcc -= 60; clockMin++; boardDirty = true; }
      const sbStep = cel.t >= 0 ? Math.floor(cel.t * 3.6) : -1; if (sbStep !== lastSB) { lastSB = sbStep; if (cel.t >= 0) boardDirty = true; }
      if (boardDirty) drawScoreboard();
      videoClock += dt;
      const vRate = cel.t >= 0 ? 1 / 15 : 1 / 6;
      if (videoDirty || videoClock >= vRate) { videoClock = 0; drawVideo(t); }
    },
    setBoard(s = {}) {
      for (const k of ['name', 'homers', 'outs', 'score', 'lastFt', 'message']) if (s[k] !== undefined && s[k] !== null) board[k] = s[k];
      board.longest = Math.max(board.longest || 0, +board.lastFt || 0);
      const outs = board.outs | 0, hr = board.homers | 0, nm = String(board.name || '');
      if (outs < line.outs || hr < line.homers || (line.name && nm !== line.name)) {
        if (line.outs > 0 || line.homers > 0) { history.unshift({ name: line.name, runs: line.runs.slice(), total: line.homers }); if (history.length > 4) history.length = 4; }
        line.runs.fill(null); line.outs = 0; line.homers = 0; board.longest = +board.lastFt || 0;
      }
      line.name = nm;
      for (let i = 0; i < Math.min(10, outs); i++) if (line.runs[i] == null) line.runs[i] = 0;
      if (hr > line.homers) { const slot = Math.min(9, outs); line.runs[slot] = (line.runs[slot] || 0) + (hr - line.homers); }
      line.homers = hr; line.outs = outs;
      boardDirty = true; videoDirty = true;
    },
    celebrate({ spray = 0, distance = 0, bonus = null } = {}) {
      if (cel.oop && cel.t >= 0 && cel.t < 2) { cel.distance = +distance || cel.distance; cel.bonus = bonus || cel.bonus; return; }
      cel.t = 0; cel.distance = +distance || 0; cel.bonus = bonus; cel.spray = +spray || 0; cel.oop = false; cel.dur = 6;
      boardDirty = true; videoDirty = true; drawRibbon('HOME RUN');
      crowdAPI.flash(cel.spray); boost = 4.5; setAllExcite(1);
      flRate = 26; flSpray = cel.spray;
    },
    outOfPark({ spray = 0, distance = 0, landing = null, bonus = null } = {}) {
      cel.t = 0; cel.distance = +distance || 0; cel.bonus = bonus; cel.spray = +spray || 0; cel.oop = true; cel.dur = 7.5;
      boardDirty = true; videoDirty = true; drawRibbon('OUT OF THE PARK');
      const L = landing && landing.length >= 3 ? landing : polar(spray, fenceAt(spray) + OF.depth + 20, 0);
      crowdAPI.celebrate({ spray: cel.spray, big: true }); crowdAPI.flash(cel.spray); boost = 7; setAllExcite(1);
      flRate = 60; flSpray = cel.spray;
      for (const h of hawks) {
        const d = Math.hypot(h.pos[0] - L[0], h.pos[1] - L[2]);
        if (d > 300) continue;
        const a = R() * Math.PI * 2, rr = 4 + R() * 9;
        h.target = [L[0] + Math.cos(a) * rr, L[2] + Math.sin(a) * rr]; h.t = 0; h.delay = 0.15 + R() * 0.6 + d / 400; h.hold = 6.5 + R() * 2.5;
      }
      let best = null, bd = 160;
      for (const c of CARS) { const d = Math.hypot(c.p[0] - L[0], c.p[1] - L[2]); if (d < bd) { bd = d; best = c; } }
      if (best) {
        const { p, t } = best, n = [-t[1], t[0]], P = (a, b, y) => [p[0] + t[0] * a + n[0] * b, y, p[1] + t[1] * a + n[1] * b];
        [P(7.3, 2.3, 2.2), P(7.3, -2.3, 2.2), P(-7.3, 2.3, 2.4), P(-7.3, -2.3, 2.4), P(7.4, 1.6, 2.0), P(7.4, -1.6, 2.0)].forEach((q, i) => { AL.pos.set(q, i * 3); AL.size[i] = i < 4 ? 2.6 : 3.4; AL.colA.set(i < 4 ? [1.6, 0.7, 0.1, 0] : [1.4, 1.4, 1.3, 0], i * 4); });
        AL.aP.needsUpdate = true; AL.aS.needsUpdate = true; alarm.t = 0; alarm.car = best;
      }
      return 7.5;
    },
    wave({ fromSpray = -70, laps = 1.5, speed } = {}) { return crowdAPI.wave({ fromSpray, laps, speed }); },
    setCrowd(level) { crowdAPI.setExcite(level); },
    info() {
      let tris = 0, calls = 0;
      group.traverse(o => { if (o.isMesh || o.isPoints || o.isLineSegments) { calls++; const g = o.geometry; const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3; tris += g.isInstancedBufferGeometry ? n * (g.instanceCount || 1) : n; } });
      const timing = {}; for (let i = 1; i < TM.length; i++) timing[TM[i - 1][0]] = Math.round(TM[i][1] - TM[i - 1][1]);
      return { timing, meshes: calls, tris: Math.round(tris), crowd: crowdAPI.count, flags: flagSpecs.length, photo: { ...photo }, skyAsset: !!assetImage(`sky_wrigley_${tod}`), buildings: BUILDINGS.length, cars: CARS.length, hawks: hawks.length };
    },
    dispose() {
      disposed = true;
      crowdAPI.dispose();
      for (const d of disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
      group.clear();
    },
  };
  return api;
}
