// ============================================================================
// WINDY CITY DERBY — the ballparks (Wrigley Field + Rate Field).
// Owner: STADIUM. API (CONTRACT.md):
//   buildStadium(THREE, { parkId, timeOfDay, weather, wind, assets, quality }) → Stadium
//   Stadium: { attach(scene), detach(scene), update(dt, t), setBoard({...}), celebrate({...}),
//              setCrowd(level), sunDir: THREE.Vector3, dispose() }
// Fully procedural geometry. Honors data.js exactly: fenceDistance(), fenceH,
// surfaceHeight() (bleachers / street / concourse / rooftops), scoreboardDistance()
// (front face of the CF board) and foul poles at ±45°.
// Only imports data.js — three.js is passed in by the caller.
// ============================================================================
import { PARKS, WEATHER, fenceDistance, surfaceHeight, scoreboardDistance, makeRng } from './data.js';

const D2R = Math.PI / 180;
const SQ = Math.SQRT1_2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const dirXZ = s => [Math.sin(s * D2R), -Math.cos(s * D2R)];

// Visual-only park configuration (anything the sim cares about lives in data.js).
const CFG = {
  wrigley: {
    foul: { near: 44, pole: 16, backstop: 60 },
    wallH: 3.5,
    grass: '#3d8434', dirt: '#ad6a3d', dirtDark: '#8e5431', track: '#8b4a31', chalk: '#f6f3ea',
    stripe: 0, stripeW: 15,
    wallCap: '#3b4d3c', fieldWallPaint: '#1f5a32', steel: '#1d5a34', steelDark: '#1e4a30', roof: '#66706a', underside: '#3c4a41', concourse: '#3a3f3a',
    seatsOF: ['#3f4b41', '#8e959b'], seatsGS: ['#8b8b84', '#1f5b36'], seatsUp: ['#86877f', '#1f5b36'],
    batterEye: '#1a3a22', pole: '#ffcc00', poleH: 72,
    shirts: ['#1f4fbf', '#c8372d', '#f2f2f2', '#1f4fbf', '#2a3f7a', '#c8372d', '#dfe4ea', '#1f4fbf', '#8a9098', '#243a6b'],
  },
  rate: {
    foul: { near: 48, pole: 22, backstop: 62 },
    wallH: 5,
    grass: '#3a8233', dirt: '#9c613c', dirtDark: '#7c4a2c', track: '#7c4b34', chalk: '#f6f6f2',
    stripe: 1, stripeW: 17,
    wallCap: '#1b1d22', fieldWallPaint: '#16181c', steel: '#2a2e35', steelDark: '#121418', roof: '#474c54', underside: '#25282e', concourse: '#4b4f56',
    seatsOF: ['#4f535a', '#1b2230'], seatsGS: ['#5a5d63', '#1b2433'], seatsUp: ['#5a5d63', '#1d2636'],
    batterEye: '#0b0c0e', pole: '#f4d200', poleH: 82,
    shirts: ['#16181c', '#f2f2f2', '#c9d1d9', '#16181c', '#2b2f36', '#f2f2f2', '#16181c', '#8b939c', '#3b4048', '#c9d1d9'],
  },
};

// Time-of-day / weather look.
function makeLook(tod, weather) {
  const L = {
    day: {
      keyEl: 50, keyAz: -150, keyColor: '#fff2df', keyI: 3.0, shadowI: 1,
      rim: null, hemiSky: '#bcd6f5', hemiGround: '#5f6a44', hemiI: 0.55, envI: 0.62,
      fog: '#c3d6ea', fogD: 0.00032, lamps: 0, glare: 0, crowd: 1.0, crowdShade: 0.62, windows: 0,
      skyBright: 1, skyDesat: 0, haze: '#dfe9f3', hazeAmt: 0.06, night: 0,
    },
    dusk: {
      keyEl: 62, keyAz: 172, keyColor: '#ffe9d2', keyI: 1.55, shadowI: 0.85,
      rim: { el: 7, az: -72, color: '#ffae66', i: 1.6 }, hemiSky: '#e0a07c', hemiGround: '#3a3530', hemiI: 0.45, envI: 0.45,
      fog: '#caa08a', fogD: 0.00036, lamps: 2.2, glare: 0.55, crowd: 0.7, crowdShade: 0.48, windows: 0.55,
      skyBright: 1, skyDesat: 0, haze: '#f0b58a', hazeAmt: 0.05, night: 0.35,
    },
    night: {
      keyEl: 60, keyAz: 168, keyColor: '#eef2ff', keyI: 2.05, shadowI: 0.75,
      rim: { el: 30, az: 40, color: '#dfe6ff', i: 0.5 }, hemiSky: '#43507a', hemiGround: '#1b2016', hemiI: 0.32, envI: 0.4,
      fog: '#0e1628', fogD: 0.00026, lamps: 5.0, glare: 1, crowd: 0.56, crowdShade: 0.4, windows: 1.0,
      skyBright: 1, skyDesat: 0, haze: '#1a2644', hazeAmt: 0.04, night: 1,
    },
  }[tod];
  L.wet = 0; L.dry = 0;
  const W = WEATHER[weather] || WEATHER.clear;
  L.fogD = L.fogD + W.fog * (tod === 'night' ? 0.0022 : 0.0031);
  if (weather === 'overcast') {
    L.keyI *= tod === 'day' ? 0.42 : 0.8; L.shadowI *= 0.4; L.hemiI *= 1.9; L.envI *= 1.25;
    L.keyColor = '#eef1f5'; L.hemiSky = tod === 'night' ? '#39435c' : '#b7bec8';
    L.fog = tod === 'night' ? '#1a2030' : tod === 'dusk' ? '#8f8a8a' : '#b3bac2';
    L.skyDesat = 0.72; L.skyBright = 0.88; L.haze = L.fog; L.hazeAmt = 0.28;
    if (L.rim) L.rim.i *= 0.35;
  } else if (weather === 'heat') {
    L.keyColor = tod === 'night' ? '#fff0dc' : '#ffdcae'; L.keyI *= 1.08; L.hemiSky = tod === 'night' ? L.hemiSky : '#eed8b8';
    L.fog = tod === 'night' ? '#2a2430' : tod === 'dusk' ? '#e2a67e' : '#e8d4b4';
    L.haze = tod === 'night' ? '#3a2e36' : '#f6ddb6'; L.hazeAmt = 0.62; L.skyDesat = 0.35; L.skyBright = 1.06; L.dry = 1; L.fogD += 0.0008; L.hemiI *= 1.1; L.haze = tod === 'night' ? '#3a2e36' : '#f8d7a8';
  } else if (weather === 'drizzle') {
    L.keyI *= tod === 'day' ? 0.34 : 0.72; L.shadowI *= 0.3; L.hemiI *= 1.8; L.envI *= 1.2;
    L.keyColor = '#ecebe6'; L.hemiSky = tod === 'night' ? '#343a4c' : '#adb0b2'; L.hemiI *= 1.15;
    L.fog = tod === 'night' ? '#171b25' : tod === 'dusk' ? '#716d70' : '#90969b';
    L.skyDesat = 0.85; L.skyBright = 0.72; L.haze = L.fog; L.hazeAmt = 0.42; L.wet = 1;
    L.crowd *= 0.9; if (L.rim) L.rim.i *= 0.2;
  }
  return L;
}

// ---------------------------------------------------------------------------
// canvas helpers (module-level cache for condition-independent textures)
// ---------------------------------------------------------------------------
const CANVAS_CACHE = new Map();
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function cached(key, fn) { if (!CANVAS_CACHE.has(key)) CANVAS_CACHE.set(key, fn()); return CANVAS_CACHE.get(key); }
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(hex, k) { const [r, g, b] = hexRgb(hex); const f = v => clamp(Math.round(v * k), 0, 255); return `rgb(${f(r)},${f(g)},${f(b)})`; }
function mixHex(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], t))).join(',')})`; }

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

// 3-lobed ivy leaf
function ivyLeaf(g, x, y, s, rot, col) {
  const pts = [[0, -1], [0.3, -0.42], [0.95, -0.6], [0.58, 0.02], [0.8, 0.55], [0.22, 0.42], [0, 0.78], [-0.22, 0.42], [-0.8, 0.55], [-0.58, 0.02], [-0.95, -0.6], [-0.3, -0.42]];
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(s / 2, s / 2);
  g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath();
  g.fillStyle = 'rgba(0,0,0,0.32)'; g.save(); g.translate(0.12, 0.16); g.fill(); g.restore();
  g.fillStyle = col; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = 0.07; g.beginPath();
  g.moveTo(0, 0.6); g.lineTo(0, -0.85); g.moveTo(0, 0.1); g.lineTo(0.75, -0.45); g.moveTo(0, 0.1); g.lineTo(-0.75, -0.45); g.stroke();
  g.restore();
}
function ivyCanvas() {
  return cached('ivy', () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('ivy');
    g.fillStyle = '#16301a'; g.fillRect(0, 0, S, S);
    const greens = ['#2e6b2c', '#357a31', '#3f8738', '#2a5f27', '#4a9440', '#24541f', '#3b7d33', '#51993f'];
    const reds = ['#9e2f24', '#b8452a', '#c9642c', '#8a2a2a', '#b3532d'];
    for (let k = 0; k < 3200; k++) {
      const x = r() * S, y = r() * S, s = 13 + r() * 17, rot = (r() - 0.5) * 1.4 + Math.PI;
      const col = r() < 0.075 ? pick(r, reds) : pick(r, greens);
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        if (x + ox < -30 || x + ox > S + 30 || y + oy < -30 || y + oy > S + 30) continue;
        ivyLeaf(g, x + ox, y + oy, s, rot, col);
      }
    }
    return c;
  });
}
function brickCanvas() {
  return cached('brick', () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('brick');
    g.fillStyle = '#b5a893'; g.fillRect(0, 0, S, S);
    const rows = 12, bh = S / rows, bw = S / 5;
    const cols = ['#8e3b2a', '#a2472f', '#7c3325', '#b0553a', '#944030', '#6e2e22', '#a85236'];
    for (let j = 0; j < rows; j++) {
      const off = (j % 2) * bw / 2;
      for (let i = -1; i < 6; i++) {
        const x = i * bw + off, col = pick(r, cols);
        g.fillStyle = col; g.fillRect(x + 3, j * bh + 3, bw - 6, bh - 6);
        for (let k = 0; k < 18; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,220,200'},${0.06 + r() * 0.08})`; g.fillRect(x + 3 + r() * (bw - 10), j * bh + 3 + r() * (bh - 9), 2 + r() * 8, 2 + r() * 4); }
      }
    }
    return c;
  });
}
// Stand surface: rows of seats (tile = 4 rows along the slope)
function seatsCanvas(key, concrete, seat) {
  return cached('seats' + key, () => {
    const W = 256, H = 256, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('seats' + key);
    g.fillStyle = concrete; g.fillRect(0, 0, W, H);
    const rh = H / 4;
    for (let j = 0; j < 4; j++) {
      const y = j * rh;
      g.fillStyle = shade(concrete, 0.78); g.fillRect(0, y, W, rh * 0.18);           // riser shadow
      g.fillStyle = seat; g.fillRect(0, y + rh * 0.5, W, rh * 0.34);                    // seats
      g.fillStyle = shade(seat, 1.25); g.fillRect(0, y + rh * 0.5, W, rh * 0.06);       // seat top highlight
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let x = 0; x < W; x += 16) g.fillRect(x, y + rh * 0.5, 2, rh * 0.34);        // seat gaps
    }
    for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.08})`; g.fillRect(r() * W, r() * H, 2, 2); }
    return c;
  });
}
// Procedural crowd (fallback for tex_crowd_*): 6 rows x 10 fans, rows overlap like a photo.
function crowdCanvas(parkId, shirts) {
  return cached('crowd' + parkId, () => {
    const W = 1024, H = 576, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('crowd' + parkId);
    const seat = parkId === 'rate' ? '#1c2230' : '#1f4a33';
    g.fillStyle = shade(seat, 0.8); g.fillRect(0, 0, W, H);
    const rows = 6, rh = H / rows, pw = W / 10;
    const skins = ['#f1c9a5', '#e0ac85', '#c68d63', '#a86f4a', '#7a4d32', '#5a3826', '#f5d6bd', '#d49b76'];
    const hairs = ['#2a1d14', '#4a3222', '#141010', '#6b4b2e', '#b58b5a', '#8a8a8a', '#3b2a1e'];
    for (let j = 0; j < rows; j++) {
      const baseY = j * rh;
      g.fillStyle = seat; g.fillRect(0, baseY + rh * 0.62, W, rh * 0.5);
      for (let i = -1; i < 11; i++) {
        const cx = ((i + 0.5 + (r() - 0.5) * 0.25) * pw + W) % W, headY = baseY + rh * (0.26 + r() * 0.1);
        const shirt = pick(r, shirts), skin = pick(r, skins), hr = pw * (0.16 + r() * 0.03);
        for (const ox of [-W, 0, W]) {
          const x = cx + ox; if (x < -pw || x > W + pw) continue;
          if (r() < 0.22) { // arms up
            g.strokeStyle = skin; g.lineWidth = pw * 0.09; g.lineCap = 'round';
            g.beginPath(); g.moveTo(x - pw * 0.25, headY + hr * 2); g.lineTo(x - pw * 0.32, headY - hr * 1.3); g.moveTo(x + pw * 0.25, headY + hr * 2); g.lineTo(x + pw * 0.33, headY - hr * 1.2); g.stroke();
          }
          g.fillStyle = shirt; g.beginPath();
          g.moveTo(x - pw * 0.36, baseY + rh * 1.12); g.lineTo(x - pw * 0.34, headY + hr * 1.6);
          g.quadraticCurveTo(x, headY + hr * 0.9, x + pw * 0.34, headY + hr * 1.6); g.lineTo(x + pw * 0.36, baseY + rh * 1.12); g.fill();
          g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x - pw * 0.36, headY + hr * 2.4, pw * 0.72, 3);
          g.fillStyle = skin; g.beginPath(); g.ellipse(x, headY, hr * 0.92, hr, 0, 0, Math.PI * 2); g.fill();
          if (r() < 0.45) { g.fillStyle = pick(r, shirts); g.beginPath(); g.ellipse(x, headY - hr * 0.45, hr * 1.02, hr * 0.62, 0, Math.PI, 0); g.fill(); g.fillRect(x - hr * 0.2, headY - hr * 0.45, hr * 1.4, hr * 0.22); }
          else { g.fillStyle = pick(r, hairs); g.beginPath(); g.ellipse(x, headY - hr * 0.35, hr, hr * 0.7, 0, Math.PI, 0); g.fill(); }
        }
      }
    }
    return c;
  });
}
// Building facades atlas: 4 variants stacked vertically, each 512x512 = 40 ft x 52 ft (4 floors + cornice).
// lit=true → emissive version (lit windows only).
function facadeCanvas(lit) {
  return cached('facade' + (lit ? 'L' : ''), () => {
    const W = 512, VH = 512, c = mkCanvas(W, VH * 4), g = c.getContext('2d'); const r = makeRng('facade');
    const vars = [
      { wall: '#8a3a28', trim: '#d8cfbd', win: '#1f2a33' },   // red brick walk-up
      { wall: '#7a5a3e', trim: '#e4d8c0', win: '#232b31' },   // brownstone
      { wall: '#a3764f', trim: '#efe6d2', win: '#1e262c' },   // tan brick
      { wall: '#2b3139', trim: '#9aa6b2', win: '#3d5a78' },   // modern glass/steel
    ];
    if (lit) { g.fillStyle = '#000'; g.fillRect(0, 0, W, VH * 4); }
    vars.forEach((v, k) => {
      const y0 = k * VH, fl = VH * 48 / 52 / 4; // floor height px (4 floors below the cornice)
      if (!lit) {
        g.fillStyle = v.wall; g.fillRect(0, y0, W, VH);
        const img = brickCanvas();
        if (k < 3) { g.globalAlpha = 0.35; g.drawImage(img, 0, y0, W, VH); g.drawImage(img, 0, y0 + VH / 2, W, VH / 2); g.globalAlpha = 1; }
        g.fillStyle = v.trim; g.fillRect(0, y0, W, VH * 0.035); g.fillRect(0, y0 + VH * 0.06, W, VH * 0.012);
      }
      for (let f = 0; f < 4; f++) {
        const fy = y0 + VH * 4 / 52 + f * fl; // floors from top
        if (k === 3) {
          if (!lit) { g.fillStyle = v.win; g.fillRect(0, fy + fl * 0.08, W, fl * 0.78); g.fillStyle = v.trim; for (let x = 0; x < W; x += 64) g.fillRect(x, fy, 6, fl); g.fillRect(0, fy + fl * 0.86, W, fl * 0.14); }
          else for (let x = 0; x < W; x += 64) if (r() < 0.55) { g.fillStyle = r() < 0.5 ? '#ffe2a8' : '#dfe8ff'; g.globalAlpha = 0.5 + r() * 0.5; g.fillRect(x + 8, fy + fl * 0.1, 50, fl * 0.74); g.globalAlpha = 1; }
          continue;
        }
        const nW = 5, ww = W / nW;
        for (let i = 0; i < nW; i++) {
          const wx = i * ww + ww * 0.24, wy = fy + fl * 0.22, wwid = ww * 0.52, wh = fl * 0.58;
          if (f === 3 && (i === 2)) { // storefront / door at ground floor
            if (!lit) { g.fillStyle = '#1b1f22'; g.fillRect(i * ww + ww * 0.12, fy + fl * 0.18, ww * 0.76, fl * 0.82); g.fillStyle = shade(v.trim, 0.9); g.fillRect(i * ww + ww * 0.08, fy + fl * 0.12, ww * 0.84, fl * 0.08); }
            else if (r() < 0.8) { g.fillStyle = '#ffcf85'; g.globalAlpha = 0.8; g.fillRect(i * ww + ww * 0.16, fy + fl * 0.24, ww * 0.68, fl * 0.7); g.globalAlpha = 1; }
            continue;
          }
          if (!lit) {
            g.fillStyle = v.trim; g.fillRect(wx - 5, wy - 7, wwid + 10, wh + 12);
            g.fillStyle = v.win; g.fillRect(wx, wy, wwid, wh);
            g.fillStyle = 'rgba(160,190,220,0.18)'; g.fillRect(wx, wy, wwid, wh * 0.45);
            g.fillStyle = v.trim; g.fillRect(wx + wwid / 2 - 2, wy, 4, wh); g.fillRect(wx, wy + wh * 0.5 - 2, wwid, 4);
          } else if (r() < 0.58) {
            g.fillStyle = r() < 0.75 ? '#ffd48f' : '#cfe0ff'; g.globalAlpha = 0.45 + r() * 0.55;
            g.fillRect(wx, wy, wwid, wh); g.globalAlpha = 1;
          }
        }
      }
    });
    return c;
  });
}
function lampCanvas() {
  return cached('lamps', () => {
    const S = 128, c = mkCanvas(S, S), g = c.getContext('2d');
    g.fillStyle = '#20242a'; g.fillRect(0, 0, S, S);
    const n = 6, st = S / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = i * st + st / 2, y = j * st + st / 2;
      const gr = g.createRadialGradient(x, y, 1, x, y, st * 0.42);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.55, '#f4f6ff'); gr.addColorStop(1, '#9aa3b0');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, st * 0.4, 0, Math.PI * 2); g.fill();
    }
    return c;
  });
}
function glowCanvas() {
  return cached('glow', () => {
    const S = 64, c = mkCanvas(S, S), g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,250,235,0.55)'); gr.addColorStop(1, 'rgba(255,240,220,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S); return c;
  });
}
function netCanvas() {
  return cached('net', () => {
    const S = 32, c = mkCanvas(S, S), g = c.getContext('2d');
    g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(30,30,30,0.95)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 1); g.lineTo(S, 1); g.moveTo(1, 0); g.lineTo(1, S); g.stroke();
    return c;
  });
}
function chainCanvas() {
  return cached('chain', () => {
    const S = 32, c = mkCanvas(S, S), g = c.getContext('2d');
    g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(70,80,72,1)'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(S, S); g.moveTo(S, 0); g.lineTo(0, S); g.stroke();
    return c;
  });
}
function asphaltCanvas() {
  return cached('asphalt', () => {
    const W = 256, H = 256, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('asph');
    // u = along the street (tile 40 ft), v = across (70 ft: sidewalk | road | sidewalk)
    g.fillStyle = '#3a3c3f'; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 2500; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`; g.fillRect(r() * W, r() * H, 2, 2); }
    const sw = H * 12 / 70;
    g.fillStyle = '#9b9890'; g.fillRect(0, 0, W, sw); g.fillRect(0, H - sw, W, sw);
    g.fillStyle = '#6c6a64'; for (let x = 0; x < W; x += 32) { g.fillRect(x, 0, 2, sw); g.fillRect(x, H - sw, 2, sw); }
    g.fillStyle = '#c8c3b6'; g.fillRect(0, sw - 3, W, 3); g.fillRect(0, H - sw, W, 3);
    g.fillStyle = '#e8c547'; g.fillRect(0, H / 2 - 4, W, 3); g.fillRect(0, H / 2 + 2, W, 3);
    g.fillStyle = 'rgba(240,240,240,0.8)'; for (let x = 0; x < W; x += 64) { g.fillRect(x, sw + (H / 2 - sw) * 0.5, 30, 2); g.fillRect(x + 32, H / 2 + (H / 2 - sw) * 0.5, 30, 2); }
    return c;
  });
}
// ---------------------------------------------------------------------------
// 5x7 block font (for the hand-operated style scoreboard)
// ---------------------------------------------------------------------------
const FONT = (() => {
  const src = {
    A: '.###.' + '#...#' + '#...#' + '#####' + '#...#' + '#...#' + '#...#', B: '####.#...##...#####.#...##...#####.', C: '.###.#...##....#....#....#...#.###.',
    D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
    G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '.###...#....#....#....#....#...###.',
    J: '..###...#....#....#....##..#..##...', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
    M: '#...###.###.#.##.#.##...##...##...#', N: '#...##...###..##.#.##..###...##...#', O: '.###.#...##...##...##...##...#.###.',
    P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
    S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
    V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
    Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
    0: '.###.#...##..###.#.###..##...#.###.', 1: '..#...##....#....#....#....#...###.', 2: '.###.#...#....#...#...#...#...#####',
    3: '####.....#....#.###.....#....#####.', 4: '...#...##..#.#.#..#.#####...#....#.', 5: '######....####.....#....##...#.###.',
    6: '..##..#...#....####.#...##...#.###.', 7: '#####....#...#...#...#....#....#...', 8: '.###.#...##...#.###.#...##...#.###.',
    9: '.###.#...##...#.####....#...#..##..', '-': '...............' + '.###.' + '...............', '.': '.........................' + '.##..' + '.##..',
    '!': '..#....#....#....#....#.........#..', ':': '......##...##.........##...##......', ',': '.....................##....#...#...',
    "'": '..#....#...#........................', '/': '....#....#...#...#...#...#....#....', '#': '.#.#.' + '#####' + '.#.#.' + '.#.#.' + '#####' + '.#.#.' + '.....',
    '&': '.##..#..#.#.#...#...#.#.##..#..##.#', '+': '.......#....#..#####..#....#.......', '?': '.###.#...#....#...#...#.........#..',
  };
  const out = {};
  for (const k in src) out[k] = src[k];
  return out;
})();
function blockText(g, text, x, y, u, color, align = 'left') {
  text = String(text).toUpperCase();
  const w = text.length * 6 * u - u;
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.fillStyle = color;
  for (const ch of text) {
    const gl = FONT[ch];
    if (gl) for (let i = 0; i < 35; i++) if (gl[i] === '#') g.fillRect(cx + (i % 5) * u + u * 0.1, y + Math.floor(i / 5) * u + u * 0.1, u * 0.8, u * 0.8);
    cx += 6 * u;
  }
  return w;
}
const fmtN = n => Math.round(+n || 0).toLocaleString('en-US');

// ---------------------------------------------------------------------------
// Fallback sky (procedural gradient, clouds, distant Chicago skyline)
// ---------------------------------------------------------------------------
function paintSky(parkId, tod, W = 2048, H = 880) {
  return cached(`sky_${parkId}_${tod}`, () => {
    const c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('sky' + parkId + tod);
    const hz = Math.round(H * 0.8);
    const pal = {
      day: ['#1d58c4', '#3f82dc', '#8fbdec', '#d6e8f6'],
      dusk: ['#1f2150', '#5a3a7e', '#d45d7c', '#ffb25a'],
      night: ['#02050d', '#060f24', '#0f1f45', '#2c3558'],
    }[tod];
    let gr = g.createLinearGradient(0, 0, 0, hz);
    gr.addColorStop(0, pal[0]); gr.addColorStop(0.5, pal[1]); gr.addColorStop(0.85, pal[2]); gr.addColorStop(1, pal[3]);
    g.fillStyle = gr; g.fillRect(0, 0, W, hz);
    const sunX = W * 0.14;
    if (tod === 'dusk') { const sg = g.createRadialGradient(sunX, hz, 0, sunX, hz, H * 0.75); sg.addColorStop(0, 'rgba(255,236,170,1)'); sg.addColorStop(0.12, 'rgba(255,190,110,0.8)'); sg.addColorStop(0.45, 'rgba(255,120,90,0.25)'); sg.addColorStop(1, 'rgba(255,110,90,0)'); g.fillStyle = sg; g.fillRect(0, 0, W, hz); }
    if (tod === 'night') {
      for (let k = 0; k < 1100; k++) { const y = r() * hz * 0.9, a = (0.25 + r() * 0.75) * (1 - y / hz * 0.8); g.fillStyle = `rgba(255,255,255,${a})`; const sz = r() < 0.06 ? 2 : 1; g.fillRect(r() * W, y, sz, sz); }
      g.fillStyle = '#f4f1e6'; g.beginPath(); g.arc(W * 0.8, hz * 0.22, 14, 0, 7); g.fill(); g.fillStyle = pal[1]; g.beginPath(); g.arc(W * 0.8 + 6, hz * 0.22 - 3, 13, 0, 7); g.fill();
      const lp = g.createLinearGradient(0, hz * 0.7, 0, hz); lp.addColorStop(0, 'rgba(255,150,80,0)'); lp.addColorStop(1, 'rgba(255,150,90,0.28)'); g.fillStyle = lp; g.fillRect(0, hz * 0.7, W, hz * 0.3);
    }
    // cumulus: flat-bottomed clusters, shaded base, sunlit tops
    const cumulus = (cx, cy, w, top, base) => {
      const n = 9 + Math.floor(r() * 9), puffs = [];
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, x = cx + (t - 0.5) * w + (r() - 0.5) * w * 0.12, rr = w * (0.09 + 0.16 * Math.sin(Math.PI * t) * (0.6 + r() * 0.6)); puffs.push([x, cy - rr * (0.55 + r() * 0.35), rr]); }
      for (const ox of [-W, 0, W]) {
        if (cx + ox < -w || cx + ox > W + w) continue;
        g.save(); g.beginPath(); g.rect(cx + ox - w, 0, w * 2, cy); g.clip();
        for (const [x, y, rr] of puffs) {
          const q = g.createLinearGradient(0, y - rr, 0, cy); q.addColorStop(0, top); q.addColorStop(0.55, top); q.addColorStop(1, base);
          g.fillStyle = q; g.beginPath(); g.arc(x + ox, y, rr, 0, 7); g.fill();
        }
        for (const [x, y, rr] of puffs) {
          const q = g.createRadialGradient(x + ox - rr * 0.3, y - rr * 0.5, 0, x + ox - rr * 0.3, y - rr * 0.5, rr * 0.8);
          q.addColorStop(0, 'rgba(255,255,255,0.55)'); q.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = q; g.beginPath(); g.arc(x + ox, y, rr, 0, 7); g.fill();
        }
        g.restore();
      }
    };
    const streak = (cx, cy, w, h, colTop, colBot) => {
      for (const ox of [-W, 0, W]) {
        const q = g.createLinearGradient(0, cy - h, 0, cy + h); q.addColorStop(0, colTop); q.addColorStop(1, colBot);
        g.fillStyle = q; g.globalAlpha = 0.85; g.beginPath(); g.ellipse(cx + ox, cy, w, h, (r() - 0.5) * 0.03, 0, 7); g.fill(); g.globalAlpha = 1;
      }
    };
    if (tod === 'day') {
      for (let k = 0; k < 26; k++) { const cy = hz * (0.3 + r() * 0.62), w = (110 + r() * 240) * (0.45 + cy / hz * 0.75); cumulus(r() * W, cy, w, '#ffffff', '#aebdd0'); }
      for (let k = 0; k < 10; k++) streak(r() * W, hz * (0.08 + r() * 0.3), 90 + r() * 200, 3 + r() * 5, 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.1)');
    } else if (tod === 'dusk') {
      for (let k = 0; k < 26; k++) { const cy = hz * (0.2 + r() * 0.72), d = Math.abs((r() * W) - sunX); streak(r() * W, cy, 140 + r() * 380, 6 + r() * 16 * (1 - cy / hz * 0.5), 'rgba(120,70,130,0.9)', cy > hz * 0.6 ? 'rgba(255,170,110,0.95)' : 'rgba(250,120,130,0.9)'); }
    } else {
      for (let k = 0; k < 14; k++) streak(r() * W, hz * (0.3 + r() * 0.6), 150 + r() * 300, 8 + r() * 12, 'rgba(40,52,84,0.8)', 'rgba(60,62,90,0.75)');
    }
    // distant ground band
    gr = g.createLinearGradient(0, hz, 0, H);
    const gcol = tod === 'day' ? ['#7b8790', '#3f4b40'] : tod === 'dusk' ? ['#3d3040', '#1b1a22'] : ['#0f1424', '#05070c'];
    gr.addColorStop(0, gcol[0]); gr.addColorStop(1, gcol[1]); g.fillStyle = gr; g.fillRect(0, hz, W, H - hz);
    if (parkId === 'wrigley') { // Lake Michigan on the right
      const lk = tod === 'day' ? '#3474ab' : tod === 'dusk' ? '#6d5a86' : '#0f1b35';
      g.fillStyle = lk; g.fillRect(W * 0.57, hz - 7, W * 0.43, 12);
      g.fillStyle = tod === 'day' ? 'rgba(255,255,255,0.25)' : 'rgba(255,200,150,0.18)'; g.fillRect(W * 0.57, hz - 7, W * 0.43, 2);
    }
    // skyline (atmospheric: hazy, horizon-tinted), iconic towers + filler
    const haze = tod === 'day' ? [150, 170, 195] : tod === 'dusk' ? [70, 50, 90] : [14, 20, 38];
    const x0 = parkId === 'wrigley' ? W * 0.04 : W * 0.26, x1 = parkId === 'wrigley' ? W * 0.44 : W * 0.84, sc = parkId === 'wrigley' ? 0.5 : 1;
    const towers = [];
    for (let x = x0; x < x1; x += 5 + r() * 12) { const f = 1 - Math.abs((x - x0) / (x1 - x0) - 0.55) * 1.6; towers.push([x, (14 + r() * r() * 120 * Math.max(0.2, f)) * sc, (8 + r() * 20) * sc, 'box', r()]); }
    const mid = x0 + (x1 - x0) * 0.55;
    towers.push([mid - 50 * sc, 215 * sc, 30 * sc, 'willis', 0.1], [mid + 160 * sc, 178 * sc, 24 * sc, 'hancock', 0.2], [mid + 70 * sc, 168 * sc, 20 * sc, 'spire', 0.3], [mid - 140 * sc, 150 * sc, 22 * sc, 'aon', 0.15], [mid + 20 * sc, 130 * sc, 18 * sc, 'box', 0.5]);
    towers.sort((a, b) => b[4] - a[4]); // far (hazy) first
    for (const [x, h, w, kind, depth] of towers) {
      const k = tod === 'day' ? 0.72 + depth * 0.2 : 0.6 + depth * 0.5;
      g.fillStyle = `rgb(${Math.round(haze[0] * k)},${Math.round(haze[1] * k)},${Math.round(haze[2] * k)})`;
      if (kind === 'willis') { g.fillRect(x, hz - h * 0.66, w, h * 0.66); g.fillRect(x + w * 0.15, hz - h * 0.84, w * 0.7, h * 0.2); g.fillRect(x + w * 0.33, hz - h, w * 0.34, h * 0.18); g.fillRect(x + w * 0.38, hz - h * 1.13, 2, h * 0.14); g.fillRect(x + w * 0.62, hz - h * 1.13, 2, h * 0.14); }
      else if (kind === 'hancock') { g.beginPath(); g.moveTo(x - w * 0.18, hz); g.lineTo(x + w * 0.12, hz - h); g.lineTo(x + w * 0.88, hz - h); g.lineTo(x + w * 1.18, hz); g.fill(); g.fillRect(x + w * 0.3, hz - h * 1.2, 2, h * 0.2); g.fillRect(x + w * 0.68, hz - h * 1.2, 2, h * 0.2); }
      else if (kind === 'spire') { g.fillRect(x, hz - h * 0.8, w, h * 0.8); g.fillRect(x + w * 0.15, hz - h * 0.9, w * 0.7, h * 0.1); g.fillRect(x + w * 0.3, hz - h * 0.97, w * 0.4, h * 0.07); g.fillRect(x + w * 0.47, hz - h * 1.12, 2, h * 0.15); }
      else g.fillRect(x, hz - h, w, h);
      if (tod === 'day') { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, hz - h * (kind === 'willis' ? 0.66 : 1), w * 0.35, h); }
      else { const n = Math.floor(h * w / 55); for (let q = 0; q < n; q++) { g.fillStyle = r() < 0.7 ? 'rgba(255,214,150,0.9)' : 'rgba(200,220,255,0.85)'; g.fillRect(x + r() * w, hz - r() * h * 0.95, 1.5, 1.5); } if (h > 120 * sc) { g.fillStyle = '#ff3030'; g.fillRect(x + w * 0.38, hz - h * 1.13, 3, 3); } }
    }
    if (tod !== 'day') for (let k = 0; k < 1600; k++) { g.fillStyle = `rgba(255,${190 + r() * 50},${120 + r() * 60},${0.35 + r() * 0.5})`; g.fillRect(r() * W, hz + 2 + r() * (H - hz) * 0.9, 1.5, 1.5); }
    return c;
  });
}

// ---------------------------------------------------------------------------
// geometry helpers
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
  // rows[i][j] = [x,y,z]; uvs[i][j] = [u,v]
  function grid(rows, uvs, color, extra) {
    const ni = rows.length, nj = rows[0].length;
    const pos = new Float32Array(ni * nj * 3), uv = new Float32Array(ni * nj * 2), idx = [];
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      const k = i * nj + j, p = rows[i][j]; pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
      if (uvs) { uv[k * 2] = uvs[i][j][0]; uv[k * 2 + 1] = uvs[i][j][1]; }
    }
    for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) {
      const a = i * nj + j, b = (i + 1) * nj + j, c = (i + 1) * nj + j + 1, d = i * nj + j + 1;
      idx.push(a, b, d, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    return finish(geo, color, extra);
  }
  function quad(a, b, c, d, color, uvRect, extra) { // a,b bottom (l→r), c,d top (r→l)
    const [u0, v0, u1, v1] = uvRect || [0, 0, 1, 1];
    return grid([[a, d], [b, c]], [[[u0, v0], [u0, v1]], [[u1, v0], [u1, v1]]], color, extra);
  }
  function box(cx, cy, cz, sx, sy, sz, color, rotY = 0, extra) {
    const g = new THREE.BoxGeometry(sx, sy, sz); if (rotY) g.rotateY(rotY); g.translate(cx, cy, cz); return finish(g, color, extra);
  }
  // box between two ground points (a→b), thickness t, from y0 to y1
  function wallBox(ax, az, bx, bz, t, y0, y1, color) {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    const g = new THREE.BoxGeometry(L, y1 - y0, t); g.rotateY(-Math.atan2(dz, dx)); g.translate((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2);
    return finish(g, color);
  }
  function cyl(x0, y0, z0, x1, y1, z1, r0, r1, seg, color) {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, true); g.translate(0, L / 2, 0);
    const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d)); g.translate(x0, y0, z0);
    return finish(g, color);
  }
  function merge(list) {
    list = list.filter(Boolean); if (!list.length) return null;
    const names = Object.keys(list[0].attributes);
    let nv = 0, ni = 0; for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
    const out = new THREE.BufferGeometry(); const arrs = {};
    for (const n of names) arrs[n] = new Float32Array(nv * list[0].attributes[n].itemSize);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const g of list) {
      for (const n of names) { const a = g.attributes[n]; if (!a) throw new Error('merge: missing attribute ' + n); arrs[n].set(a.array, vo * a.itemSize); }
      const gi = g.index.array; for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
      io += gi.length; vo += g.attributes.position.count; g.dispose();
    }
    for (const n of names) out.setAttribute(n, new THREE.BufferAttribute(arrs[n], list[0].attributes[n].itemSize));
    out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere();
    return out;
  }
  return { finish, grid, quad, box, wallBox, cyl, merge };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
export function buildStadium(THREE, opts = {}) {
  const parkId = PARKS[opts.parkId] ? opts.parkId : 'wrigley';
  const PK = PARKS[parkId], C = CFG[parkId];
  const tod = ['day', 'dusk', 'night'].includes(opts.timeOfDay) ? opts.timeOfDay : 'day';
  const weather = WEATHER[opts.weather] ? opts.weather : 'clear';
  const wind = { mph: Math.max(0, +(opts.wind && opts.wind.mph) || 0), dir: +(opts.wind && opts.wind.dir) || 0 };
  const quality = ['high', 'medium', 'low'].includes(opts.quality) ? opts.quality : 'high';
  const assets = opts.assets || null;
  const LOOK = makeLook(tod, weather);
  const TM = [['start', performance.now()]]; const mark = n => TM.push([n, performance.now()]);
  const K = makeGeoKit(THREE);
  const R = makeRng('stadium:' + parkId);
  const disposables = [];
  const group = new THREE.Group(); group.name = 'stadium:' + parkId;
  const aniso = quality === 'high' ? 8 : quality === 'medium' ? 4 : 2;
  const isW = parkId === 'wrigley';
  const OF = PK.stands; // outfield stands {depth,startH,topH}

  // -------------------------------------------------------------- assets
  function assetImage(key) {
    try {
      const im = assets && assets.get && assets.get(key);
      if (im && (im.naturalWidth || im.width) > 0 && (im.complete === undefined || im.complete)) return im;
    } catch (e) { /* missing */ }
    return null;
  }
  function assetMeta(key) { try { return (assets && assets.meta && assets.meta(key)) || null; } catch (e) { return null; } }
  function toCanvas(im, w, h) { const c = mkCanvas(w || im.naturalWidth || im.width, h || im.naturalHeight || im.height); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); return c; }
  function tex(src, { wrap = 'repeat', srgb = true, mips = true, flipY = true } = {}) {
    const t = new THREE.CanvasTexture(src);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const w = wrap === 'mirror' ? THREE.MirroredRepeatWrapping : wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapS = t.wrapT = w; t.anisotropy = aniso; t.flipY = flipY;
    t.generateMipmaps = mips; t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    disposables.push(t); return t;
  }
  const col = hex => new THREE.Color(hex);

  mark('textures');
  // -------------------------------------------------------------- textures
  const T = {};
  T.noise = tex(noiseCanvas(256), { srgb: false });
  { const im = assetImage('tex_ivy'); T.ivy = tex(im ? toCanvas(im, 512, 512) : ivyCanvas()); }
  { const im = assetImage('tex_brick'); T.brick = tex(im ? toCanvas(im, 512, 512) : brickCanvas()); }
  {
    const key = isW ? 'tex_crowd_north' : 'tex_crowd_south', im = assetImage(key);
    T.crowd = tex(im ? toCanvas(im, 1024, 580) : crowdCanvas(parkId, C.shirts), { wrap: 'clamp' });
    T.crowdReal = !!im;
  }
  T.seatsOF = tex(seatsCanvas(parkId + 'OF', ...C.seatsOF));
  T.seatsGS = tex(seatsCanvas(parkId + 'GS', ...C.seatsGS));
  T.facade = tex(facadeCanvas(false));
  T.facadeLit = LOOK.windows > 0 ? tex(facadeCanvas(true)) : null;
  T.lamps = tex(lampCanvas());
  T.glow = tex(glowCanvas(), { wrap: 'clamp' });
  T.net = tex(netCanvas());
  T.chain = tex(chainCanvas());
  if (isW) T.asphalt = tex(asphaltCanvas());

  // Rate outfield wall pads
  if (!isW) {
    const c = cached('pads', () => {
      const W = 256, H = 64, cv = mkCanvas(W, H), g = cv.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#2a2e35'); gr.addColorStop(0.5, '#1c1f24'); gr.addColorStop(1, '#131519');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.fillStyle = '#8f98a3'; g.fillRect(0, 0, W, 3); for (let x = 0; x < W; x += 64) { g.fillStyle = '#0b0c0e'; g.fillRect(x, 0, 3, H); g.fillStyle = 'rgba(200,210,220,0.25)'; g.fillRect(x + 3, 0, 1, H); }
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, 6, W, 10);
      return cv;
    });
    T.pads = tex(c);
  }

  mark('materials');
  // -------------------------------------------------------------- materials
  const side = THREE.DoubleSide;
  const M = {};
  const wetRough = r => lerp(r, Math.min(r, 0.42), LOOK.wet);
  M.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: wetRough(0.78), metalness: 0.08, side });
  M.brick = new THREE.MeshStandardMaterial({ map: T.brick, roughness: wetRough(0.92), side });
  M.ivy = isW ? new THREE.MeshStandardMaterial({ map: T.ivy, roughness: wetRough(0.7), side, color: new THREE.Color(1.15, 1.5, 1.0) }) : null;
  M.pads = !isW ? new THREE.MeshStandardMaterial({ map: T.pads, roughness: wetRough(0.55), metalness: 0.1, side }) : null;
  M.seatsOF = new THREE.MeshStandardMaterial({ map: T.seatsOF, roughness: wetRough(0.85), side });
  M.seatsGS = new THREE.MeshStandardMaterial({ map: T.seatsGS, roughness: wetRough(0.85), side });
  M.facade = new THREE.MeshStandardMaterial({ map: T.facade, roughness: wetRough(0.88), side });
  if (T.facadeLit) { M.facade.emissiveMap = T.facadeLit; M.facade.emissive = col('#ffd9a0'); M.facade.emissiveIntensity = 1.25 * LOOK.windows; }
  // atlas: 4 facade variants stacked vertically; attribute fv selects one, uv.y repeats per 52 ft
  M.facade.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float fv;\nvarying float vFv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvFv = fv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFv;\nvec4 atlasSample(sampler2D t, vec2 uv){ vec2 g = vec2(uv.x, uv.y * 0.25); return textureGrad(t, vec2(uv.x, (vFv + fract(uv.y)) * 0.25), dFdx(g), dFdy(g)); }')
      .replace('texture2D( map, vMapUv )', 'atlasSample( map, vMapUv )').replace('texture2D( emissiveMap, vEmissiveMapUv )', 'atlasSample( emissiveMap, vEmissiveMapUv )');
  };
  M.lamps = new THREE.MeshStandardMaterial({ map: T.lamps, emissiveMap: T.lamps, emissive: col('#fffaf0'), emissiveIntensity: LOOK.lamps, roughness: 0.4, side });
  M.net = new THREE.MeshBasicMaterial({ map: T.net, transparent: true, opacity: 0.55, depthWrite: false, side, color: col('#222222') });
  M.chain = new THREE.MeshStandardMaterial({ map: T.chain, alphaTest: 0.35, transparent: false, side, roughness: 0.6, metalness: 0.4 });
  M.eye = new THREE.MeshStandardMaterial({ map: T.ivy, roughness: 0.95, side, color: isW ? new THREE.Color(0.22, 0.34, 0.2) : new THREE.Color(0.1, 0.11, 0.11) });
  {
    const rc = cached('roof', () => { const W = 128, cv = mkCanvas(W, W), g = cv.getContext('2d'); const r = makeRng('roof');
      g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, W, W);
      for (let x = 0; x < W; x += 8) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, 0, 2, W); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + 5, 0, 2, W); }
      for (let y = 0; y < W; y += 64) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y, W, 2); }
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.08})`; g.fillRect(r() * W, r() * W, 10 + r() * 30, 6 + r() * 20); }
      return cv; });
    T.roof = tex(rc);
    M.roof = new THREE.MeshStandardMaterial({ map: T.roof, color: col(C.roof), roughness: wetRough(0.7), metalness: 0.25, side });
  }
  M.street = isW ? new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: wetRough(0.95), side }) : null;
  M.cityGround = new THREE.MeshStandardMaterial({ roughness: 1, color: col(tod === 'night' ? '#8a8a8a' : '#ffffff') });
  Object.values(M).forEach(m => m && disposables.push(m));

  // bins: material key → list of geometries
  const BINS = {};
  const add = (key, geo) => { if (!geo) return; (BINS[key] || (BINS[key] = [])).push(geo); };
  // Raw batches: a fast path for thousands of quads / template copies (city, trees).
  const RAW = {}, TPL = {}, _c = new THREE.Color();
  const rawBin = (key, ex) => RAW[key] || (RAW[key] = { pos: [], nor: [], uv: [], col: [], ex: Object.fromEntries((ex || []).map(n => [n, []])), idx: [] });
  function rawQuad(key, a, b, c, d, color, uvRect, extra) { // same vertex order/uv as K.quad
    const B = rawBin(key, extra && Object.keys(extra)), base = B.pos.length / 3;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    B.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let k = 0; k < 4; k++) B.nor.push(nx, ny, nz);
    const [u0, v0, u1, v1] = uvRect || [0, 0, 1, 1];
    B.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    if (color != null) { _c.set(color); for (let k = 0; k < 4; k++) B.col.push(_c.r, _c.g, _c.b); }
    if (extra) for (const n in extra) for (let k = 0; k < 4; k++) B.ex[n].push(extra[n]);
    B.idx.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
  }
  function tpl(name, make) {
    if (!TPL[name]) { const g0 = make(), g = g0.index ? g0.toNonIndexed() : g0; g.deleteAttribute('normal'); g.computeVertexNormals(); TPL[name] = { p: g.attributes.position.array, n: g.attributes.normal.array }; g.dispose(); }
    return TPL[name];
  }
  function rawTpl(key, t, ox, oy, oz, sx, sy, sz, color) { // flat-shaded template copy (scale + offset)
    const B = rawBin(key), base = B.pos.length / 3, nv = t.p.length / 3; _c.set(color);
    for (let i = 0; i < nv; i++) {
      B.pos.push(t.p[i * 3] * sx + ox, t.p[i * 3 + 1] * sy + oy, t.p[i * 3 + 2] * sz + oz); B.nor.push(t.n[i * 3], t.n[i * 3 + 1], t.n[i * 3 + 2]);
      B.uv.push(0, 0); B.col.push(_c.r, _c.g, _c.b); B.idx.push(base + i);
    }
  }
  const TP = {
    ico: () => tpl('ico', () => new THREE.IcosahedronGeometry(1, 0)),
    trunk: () => tpl('trunk', () => new THREE.CylinderGeometry(0.75, 1, 1, 5, 1, true).translate(0, 0.5, 0)),
    tank: () => tpl('tank', () => new THREE.CylinderGeometry(1, 1, 1, 10, 1, false).translate(0, 0.5, 0)),
    cone: () => tpl('cone', () => new THREE.ConeGeometry(1, 1, 10, 1, true).translate(0, 0.5, 0)),
    leg: () => tpl('leg', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
  };
  function tree(x, z, sz, color) {
    rawTpl('paint', TP.trunk(), x, 0, z, 0.9, sz, 0.9, '#4a3a2c');
    rawTpl('paint', TP.ico(), x, sz * 1.45, z, sz, sz * 0.9, sz, color);
  }

  mark('boundary');
  // ======================================================================
  // FIELD BOUNDARY (the playing surface outline)
  // ======================================================================
  const LpR = fenceDistance(parkId, 45), LpL = fenceDistance(parkId, -45);
  const extGS = OF.depth + (isW ? 0 : PK.street.width); // grandstand runs this far past the poles
  function wallOffset(u, Lp) { return u >= Lp ? C.foul.pole : lerp(C.foul.near, C.foul.pole, u / Lp); }
  function foulPt(sign, u) { // point on the foul-side wall, sign +1 = 1B/RF side
    const Lp = sign > 0 ? LpR : LpL, w = wallOffset(u, Lp);
    return [sign * SQ * u + sign * SQ * w, -SQ * u + SQ * w];
  }
  function backstopPt(th) { // th: 135..225 (deg, spray-style angle)
    const a = th <= 180 ? (th - 135) / 45 : (225 - th) / 45;
    const Rr = lerp(C.foul.near, C.foul.backstop, (1 - Math.cos(Math.PI * a)) / 2);
    return [Math.sin(th * D2R) * Rr, -Math.cos(th * D2R) * Rr];
  }
  // outfield spray samples incl. all profile control points
  function spraySamples(a, b, step) {
    const set = new Set();
    for (let s = a; s <= b + 1e-6; s += step) set.add(+s.toFixed(4));
    set.add(a); set.add(b);
    for (const [s] of PK.fence) if (s > a && s < b) set.add(s);
    return [...set].sort((x, y) => x - y);
  }
  const fenceAt = s => fenceDistance(parkId, s);
  const polar = (s, r, y = 0) => [Math.sin(s * D2R) * r, y, -Math.cos(s * D2R) * r];

  // Grandstand path: RF corner (past the pole) → along 1B wall → behind home → 3B wall → LF corner.
  const gsPath = [];
  {
    const us = u0 => { const out = []; for (let u = 0; u < u0; u += 22) out.push(u); out.push(u0); return out; };
    const uR = [...new Set([...us(LpR), LpR, LpR + extGS])].sort((a, b) => b - a);
    for (const u of uR) gsPath.push({ p: foulPt(1, u), u, side: 1 });
    for (let th = 140; th <= 220; th += 5) gsPath.push({ p: backstopPt(th), u: 0, side: 0, th });
    const uL = [...new Set([...us(LpL), LpL, LpL + extGS])].sort((a, b) => a - b);
    for (const u of uL) gsPath.push({ p: foulPt(-1, u), u, side: -1 });
    // dedupe consecutive near-identical points
    for (let i = gsPath.length - 1; i > 0; i--) if (Math.hypot(gsPath[i].p[0] - gsPath[i - 1].p[0], gsPath[i].p[1] - gsPath[i - 1].p[1]) < 0.5) gsPath.splice(i, 1);
    computeNormals(gsPath);
  }
  function computeNormals(path) { // outward (away from home) miter normals
    const segN = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i].p, b = path[i + 1].p, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      let n = [dz / L, -dx / L]; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (n[0] * mx + n[1] * mz < 0) n = [-n[0], -n[1]];
      segN.push(n);
    }
    for (let i = 0; i < path.length; i++) {
      const n0 = segN[Math.max(0, i - 1)], n1 = segN[Math.min(segN.length - 1, i)];
      let nx = n0[0] + n1[0], nz = n0[1] + n1[1]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const c = Math.max(0.5, nx * n0[0] + nz * n0[1]);
      path[i].n = [nx / c, nz / c];
    }
  }

  // Closed boundary loop of the playing field (for the floor polygon + warning track)
  const loop = [];
  {
    for (const s of spraySamples(-45, 45, 1)) { const r = fenceAt(s); loop.push([Math.sin(s * D2R) * r, -Math.cos(s * D2R) * r]); }
    // RF jog + 1B wall down to home
    for (const u of [LpR, ...Array.from({ length: 16 }, (_, k) => LpR * (1 - (k + 1) / 16))]) loop.push(foulPt(1, u));
    for (let th = 140; th <= 220; th += 5) loop.push(backstopPt(th));
    for (let k = 0; k <= 16; k++) loop.push(foulPt(-1, LpL * k / 16));
  }
  // signed area → orientation, for inward normals
  let area = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const orient = Math.sign(area) || 1;

  mark('field');
  // ======================================================================
  // FIELD SURFACE (procedural grass / dirt / chalk shader)
  // ======================================================================
  {
    const shape = new THREE.Shape(); loop.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2);
    g.deleteAttribute('normal'); K.finish(g, null, { zone: 0 });
    add('field', g);
    // mound (raised 10", centered 18" in front of the rubber)
    const rings = 14, segs = 48, rows = [];
    for (let i = 0; i <= rings; i++) {
      const rr = 9.6 * i / rings, row = [];
      for (let j = 0; j <= segs; j++) {
        const a = j / segs * Math.PI * 2, x = Math.cos(a) * rr, z = -59 + Math.sin(a) * rr;
        const d = Math.hypot(x, z + 60.2);
        const h = 0.83 * (1 - smooth(1.6, 9.2, d)) - 0.03;
        row.push([x, h, z]);
      }
      rows.push(row);
    }
    add('field', K.grid(rows, null, null, { zone: 0 }));
    // warning track ribbon (15 ft, inward from the boundary)
    const n = loop.length, inner = [];
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
      const n0 = segNormal(a, b), n1 = segNormal(b, c);
      let nx = n0[0] + n1[0], nz = n0[1] + n1[1]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const k = 15 / Math.max(0.55, nx * n0[0] + nz * n0[1]);
      inner.push([b[0] + nx * k, b[1] + nz * k]);
    }
    function segNormal(a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [-dz / L * orient, dx / L * orient]; }
    const rowsT = [];
    for (let i = 0; i <= n; i++) { const k = i % n; rowsT.push([[loop[k][0], 0.14, loop[k][1]], [inner[k][0], 0.14, inner[k][1]]]); }
    add('field', K.grid(rowsT, null, null, { zone: 1 }));
    // quick sanity: the track inner normal should point toward the infield
    const test = inner[Math.floor(n * 0.25)];
    if (Math.hypot(test[0], test[1]) > Math.hypot(loop[Math.floor(n * 0.25)][0], loop[Math.floor(n * 0.25)][1])) console.warn('[stadium] track offset flipped');
  }
  M.field = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side, envMapIntensity: LOOK.wet ? 0.55 : 1 });
  disposables.push(M.field);
  const fieldU = {
    uNoise: { value: T.noise }, uGrass: { value: col(C.grass) }, uDirt: { value: col(C.dirt) }, uDirtDark: { value: col(C.dirtDark) },
    uTrack: { value: col(C.track) }, uChalk: { value: col(C.chalk) }, uStripeW: { value: C.stripeW }, uPattern: { value: C.stripe }, uWet: { value: LOOK.wet }, uDry: { value: LOOK.dry },
  };
  M.field.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, fieldU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float zone;\nvarying float vZone;\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvZone = zone;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vZone; varying vec3 vWP;
uniform sampler2D uNoise; uniform vec3 uGrass, uDirt, uDirtDark, uTrack, uChalk; uniform float uStripeW, uPattern, uWet, uDry;
float gRough;
float fillAA(float sd){ float w = fwidth(sd) * 0.8 + 1e-4; return 1.0 - smoothstep(-w, w, sd); }
float lineAA(float d, float hw){ return fillAA(abs(d) - hw); }
float sdBox2(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sqWave(float x){ float fw = fwidth(x) + 1e-4; float t = abs(fract(x) - 0.5); float s = clamp((t - 0.25) / fw + 0.5, 0.0, 1.0); return mix(s, 0.5, smoothstep(0.25, 0.6, fw)); }
vec3 fieldColor(){
  vec2 p = vWP.xz;
  float a = dot(p, vec2(0.70710678, -0.70710678));
  float b = dot(p, vec2(-0.70710678, -0.70710678));
  vec3 nz = texture2D(uNoise, p / 150.0).rgb;
  vec3 nm = texture2D(uNoise, p / 21.0).rgb;
  vec3 nf = texture2D(uNoise, p / 2.3).rgb;
  vec3 V = normalize(vWP - cameraPosition);
  // ---- grass with mow stripes (view-dependent sheen)
  float st, sheen;
  if (uPattern < 0.5) {
    st = sqWave(p.x / (2.0 * uStripeW) + 0.25);
    float cr = sqWave(p.y / (2.0 * uStripeW * 2.4));
    sheen = (st * 2.0 - 1.0) * clamp(-V.z * 3.0, -1.0, 1.0) * 0.85 + (cr * 2.0 - 1.0) * 0.22;
  } else {
    float s1 = sqWave(a / (2.0 * uStripeW)), s2 = sqWave(b / (2.0 * uStripeW));
    st = abs(s1 - s2);
    sheen = (s1 * 2.0 - 1.0) * clamp(dot(V.xz, vec2(0.7071, -0.7071)) * 3.0, -1.0, 1.0) * 0.36 + (s2 * 2.0 - 1.0) * clamp(dot(V.xz, vec2(-0.7071, -0.7071)) * 3.0, -1.0, 1.0) * 0.36;
  }
  vec3 grass = uGrass * (1.0 + sheen * 0.075);
  grass *= mix(0.86, 1.1, nz.r) * mix(0.92, 1.06, nm.g) * mix(0.9, 1.1, nf.b);
  grass = mix(grass, grass * vec3(1.1, 1.05, 0.78), smoothstep(0.55, 0.85, nz.g) * 0.35);
  grass *= mix(1.0, 0.8, uWet);
  grass = mix(grass, grass * vec3(1.18, 1.06, 0.62), uDry * (0.18 + 0.25 * smoothstep(0.45, 0.85, nz.b)));
  // ---- dirt regions
  float dArc = max(length(p - vec2(0.0, -60.5)) - 95.0, max(-a - 3.0, -b - 3.0));
  float sq = sdBox2(vec2(a, b), vec2(45.0), vec2(42.0)) ;
  float dirtSd = max(dArc, -(sq + 0.0));
  float dHome = length(p - vec2(0.0, -0.7)) - 13.0;
  float dMound = length(p - vec2(0.0, -59.0)) - 9.0;
  vec2 odc = vec2(abs(p.x) - 24.0, p.y - 8.0);
  float dOnDeck = length(odc) - 2.6;
  dirtSd = min(min(dirtSd, dHome), min(dMound, dOnDeck));
  float dirtM = fillAA(dirtSd);
  vec3 nx = texture2D(uNoise, p / 0.55).rgb;
  vec3 dirt = uDirt * mix(0.84, 1.1, nm.r) * mix(0.84, 1.1, nf.g) * mix(0.84, 1.12, nx.b) * mix(0.92, 1.05, texture2D(uNoise, p / 6.5).r);
  dirt *= 1.0 - 0.05 * sqWave(dot(p, vec2(0.6, 0.8)) / 1.1) * smoothstep(20.0, 60.0, length(p));
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 2.5, length(p - vec2(0.0, -60.2))) * 0.75);   // mound clay
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 3.0, length(p - vec2(0.0, -0.7))) * 0.45);    // wet plate area
  dirt *= mix(vec3(1.0), vec3(0.74, 0.68, 0.64), uWet);
  // grass lip: slightly darker grass just outside the dirt edges
  grass *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.4, dirtSd)) * step(0.0, dirtSd);
  vec3 c = mix(grass, dirt, dirtM);
  gRough = mix(mix(0.82, 0.98, nf.r), 1.0, dirtM);
  // ---- warning track
  float trk = step(0.5, vZone);
  vec3 track = uTrack * mix(0.8, 1.12, nm.b) * mix(0.9, 1.1, nf.r) * mix(1.0, 0.6, uWet);
  c = mix(c, track, trk);
  // ---- chalk
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

  // Home plate, bases, rubber, (white) + dirt lip
  {
    const plate = new THREE.Shape([[0, 0], [0.708, -0.708], [0.708, -1.417], [-0.708, -1.417], [-0.708, -0.708]].map(([x, z]) => new THREE.Vector2(x, -z)));
    const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.08, bevelEnabled: false }); pg.rotateX(-Math.PI / 2); pg.deleteAttribute('normal'); pg.computeVertexNormals();
    add('paint', K.finish(pg, '#f4f2ec'));
    const bases = [[63.64, -63.64], [0, -127.28], [-63.64, -63.64]];
    for (const [x, z] of bases) add('paint', K.box(x, 0.15, z, 1.25, 0.3, 1.25, '#f7f6f0', Math.PI / 4));
    add('paint', K.box(0, 0.83, -60.75, 2, 0.12, 0.5, '#f7f6f0'));
  }

  // ======================================================================
  // SWEEP BUILDER — profiles swept along a path
  // path[i] = { p:[x,z], n:[nx,nz] } ; strip.pts = [[v,y], ...]
  // ======================================================================
  function sweep(path, strip) {
    const pts = strip.pts, nj = pts.length, rows = [], uvs = [];
    const accV = [0]; for (let j = 1; j < nj; j++) accV.push(accV[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    const uS = strip.uScale || 10, vS = strip.vScale || 10;
    const accU = new Array(nj).fill(0);
    for (let i = 0; i < path.length; i++) {
      const { p, n } = path[i], row = [], uvr = [];
      for (let j = 0; j < nj; j++) {
        const [v, y] = pts[j];
        let x = p[0] + n[0] * v, z = p[1] + n[1] * v;
        if (i > 0) { const q = rows[i - 1][j]; accU[j] += Math.hypot(x - q[0], z - q[2]); }
        let yy = y;
        if (strip.disp) { const d = strip.disp(i, j, x, yy, z, accU[j]); x += n[0] * d; z += n[1] * d; }
        row.push([x, yy, z]); uvr.push([accU[j] / uS, strip.vFixed ? strip.vFixed[j] : accV[j] / vS]);
      }
      rows.push(row); uvs.push(uvr);
    }
    return K.grid(rows, uvs, strip.color, strip.extra);
  }
  // Cap polygon at a path end: outline [[v,y]...] placed at point p with offset dir n
  function capAt(p, n, outline, color, key = 'paint', uvS = null, extra = null) {
    const sh = new THREE.Shape(outline.map(([v, y]) => new THREE.Vector2(v, y)));
    const g = new THREE.ShapeGeometry(sh);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const v = pos.getX(i), y = pos.getY(i); pos.setXYZ(i, p[0] + n[0] * v, y, p[1] + n[1] * v);
      if (uvS) uv.setXY(i, v / uvS[0], y / uvS[1]);
    }
    g.deleteAttribute('normal'); g.computeVertexNormals();
    add(key, K.finish(g, color, extra));
  }
  // textured end wall of a stand (brick at Wrigley, modern panels at Rate)
  const endCap = (p, n, outline) => (isW ? capAt(p, n, outline, null, 'brick', [3.2, 3.0]) : capAt(p, n, outline, null, 'facade', [40, 52], { fv: 0 }));
  // resample a path (list of {p,n}) at a given offset v, returning points spaced ~step along it
  function offsetLine(path, v) { return path.map(({ p, n }) => [p[0] + n[0] * v, p[1] + n[1] * v]); }
  function walk(line, step, fn) { // calls fn(x,z,tx,tz,dist) every `step` along polyline
    let acc = 0, next = step / 2;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      while (next <= acc + L) { const f = (next - acc) / L; fn(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, tx, tz, next, i); next += step; }
      acc += L;
    }
    return acc;
  }

  // ======================================================================
  // CROWD — instanced strips (one strip = a row of fans), billboard-free:
  // each strip faces the field; the shader bobs individual fans.
  // ======================================================================
  const crowdI = []; // [x,y,z,w, tx,tz,h,band, u0,phase,spray,kind]
  const BANDS = 6, USPAN = 0.5; // a strip shows half the texture width (≈5 fans)
  const crowdDensity = quality === 'low' ? 0.7 : 1;
  function crowdRows(path, v0, y0, v1, y1, opt = {}) {
    const rowD = opt.rowD || 3.0, W = opt.w || 9.5;
    const len = Math.hypot(v1 - v0, y1 - y0), nRows = Math.max(1, Math.floor(Math.abs(v1 - v0) / rowD));
    const rise = (y1 - y0) / nRows;
    for (let k = 0; k < nRows; k++) {
      if (opt.skipRow && opt.skipRow(k, nRows)) continue;
      const f = (k + 0.35) / nRows, v = lerp(v0, v1, f), y = lerp(y0, y1, f);
      const line = offsetLine(path, v);
      const kind = opt.shadeFrom !== undefined ? (v > opt.shadeFrom ? 1 : 0) : (opt.kind || 0);
      const h = Math.max(1.6, rise * 1.35 + 0.5);
      walk(line, W, (x, z, tx, tz, dist) => {
        if (opt.gap && (dist % opt.gap) < W * 0.5) return; // aisles
        if (R() > crowdDensity * (opt.fill || 0.97)) return;
        if (opt.filter && !opt.filter(x, z)) return;
        // face the field: front normal cross(t, up) = (-tz, 0, tx) must point toward home-ish
        let ttx = tx, ttz = tz;
        const fx = -ttz, fz = ttx; const toward = opt.facing ? opt.facing(x, z) : [-x, -z];
        if (fx * toward[0] + fz * toward[1] < 0) { ttx = -ttx; ttz = -ttz; }
        const spray = Math.atan2(x, -z) / D2R;
        crowdI.push(x, y - 0.25, z, W * 1.04, ttx, ttz, h, Math.floor(R() * BANDS), R() * (1 - USPAN), R(), spray, kind);
      });
    }
  }

  mark('outfield');
  // ======================================================================
  // OUTFIELD: wall + stands (radial, exactly surfaceHeight), corner fills
  // ======================================================================
  const sprayOF = spraySamples(-45, 45, 1);
  const sprayFine = spraySamples(-45, 45, 0.25);
  const ofPath = ss => ss.map(s => { const r = fenceAt(s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
  const pathOF = ofPath(sprayOF), pathOFfine = ofPath(sprayFine);
  const cornerPath = sign => { // straight path from the pole outward into foul ground; offset along the line
    const Lp = sign > 0 ? LpR : LpL, L = [sign * SQ, -SQ], N = [sign * SQ, SQ];
    const out = [];
    for (let k = 0; k <= 3; k++) { const w = C.foul.pole * k / 3; out.push({ p: [L[0] * Lp + N[0] * w, L[1] * Lp + N[1] * w], n: L }); }
    return out;
  };
  const cornerR = cornerPath(1), cornerL = cornerPath(-1);
  const H0 = PK.fenceH, capD = 1.5;
  // outfield seat profile evaluated from surfaceHeight() at spray 0 (profile is spray-independent in d)
  const sH = d => surfaceHeight(parkId, 0, fenceAt(0) + d);
  const ofSeat = []; for (let d = capD; d <= OF.depth - 0.01; d += OF.depth / 12) ofSeat.push([d, sH(d)]);
  ofSeat.push([OF.depth - 0.01, sH(OF.depth - 0.01)]);
  if (Math.abs(sH(capD) - lerp(OF.startH, OF.topH, capD / OF.depth)) > 0.01) console.warn('[stadium] surfaceHeight mismatch');
  const topH = OF.topH;
  function buildOutfieldOn(path, pathFine, isCorner) {
    // wall face
    if (isW) {
      const ivyV = []; for (let k = 0; k <= 6; k++) ivyV.push([0, H0 * k / 6]);
      const noise = (x, y) => Math.sin(x * 0.9 + Math.sin(y * 1.7) * 2) * 0.5 + Math.sin(x * 0.37 - y * 0.8) * 0.5;
      add('ivy', sweep(pathFine, { pts: ivyV, uScale: 6, vScale: 6, disp: (i, j, x, y, z, u) => (j === 0 ? 0 : -0.35 - 0.3 * noise(u, y)) }));
    } else {
      add('pads', sweep(path, { pts: [[0, 0], [0, H0]], uScale: 8, vFixed: [0, 1] }));
    }
    add('paint', sweep(path, { pts: [[0, H0], [capD, H0]], color: C.wallCap }));
    add('paint', sweep(path, { pts: [[capD, H0], [capD, sH(capD)]], color: C.wallCap }));
  }
  function seatsOn(path, eyeZone) {
    add(eyeZone ? 'eye' : 'seatsOF', sweep(path, { pts: ofSeat, uScale: eyeZone ? 7 : 14, vScale: eyeZone ? 7 : 11.6 }));
  }
  buildOutfieldOn(pathOF, pathOFfine, false);
  buildOutfieldOn(cornerR, cornerR, true); buildOutfieldOn(cornerL, cornerL, true);
  // seats (split around the batter's eye)
  const eye = isW ? 6 : 7;
  seatsOn(ofPath(spraySamples(-45, -eye, 1)));
  seatsOn(ofPath(spraySamples(eye, 45, 1)));
  seatsOn(ofPath(spraySamples(-eye, eye, 1)), true);
  seatsOn(cornerR); seatsOn(cornerL);
  // outfield crowd
  {
    const rowD = isW ? 2.9 : 3.0;
    const skip = !isW ? (k, n) => { const d = lerp(capD, OF.depth, (k + 0.35) / n); return d > 43 && d < 48; } : null;
    const oc = { rowD, gap: 64, skipRow: skip, fill: isW ? 0.97 : 0.93 };
    crowdRows(ofPath(spraySamples(-45, -eye - 0.6, 1)), capD, sH(capD), OF.depth - 1, sH(OF.depth - 1), oc);
    crowdRows(ofPath(spraySamples(eye + 0.6, 45, 1)), capD, sH(capD), OF.depth - 1, sH(OF.depth - 1), oc);
    for (const cp of [cornerR, cornerL]) crowdRows(cp, capD, sH(capD), OF.depth - 1, sH(OF.depth - 1), { ...oc, gap: 0, facing: () => [-cp[0].n[0], -cp[0].n[1]] });
  }
  // top of stands, back wall, street/concourse
  const backTop = topH + 3.2;
  if (isW) {
    for (const pth of [pathOF, cornerR, cornerL]) {
      add('paint', sweep(pth, { pts: [[OF.depth - 0.01, topH], [OF.depth + 1.2, topH]], color: '#4b5a4c' }));
      add('paint', sweep(pth, { pts: [[OF.depth, topH], [OF.depth, backTop]], color: C.steel }));
      add('brick', sweep(pth, { pts: [[OF.depth + 1.2, backTop], [OF.depth + 1.2, 0]], uScale: 3.2, vScale: 3.0 }));
      add('paint', sweep(pth, { pts: [[OF.depth, backTop], [OF.depth + 1.2, backTop]], color: C.steel }));
    }
    // Waveland (LF) / Sheffield (RF) — the street band (y = street.h = 0)
    const stS = spraySamples(-50, 50, 1).map(s => { const r = fenceAt(s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    const d0 = OF.depth + 1.2, d1 = OF.depth + PK.street.width;
    add('street', sweep(stS, { pts: [[d0, 0.08], [d1, 0.08]], uScale: 40, vFixed: [0.02, 0.98] }));
    // parked cars along both curbs + a few ballhawks
    const carCols = ['#2b3e63', '#8f1d1d', '#d9d9d6', '#1b1c1e', '#6b7078', '#355c3a', '#b8a27a', '#20476e'];
    for (const dd of [d0 + 16, d1 - 16]) {
      walk(offsetLine(stS, dd), 22, (x, z, tx, tz) => {
        if (R() < 0.3) return;
        const a = Math.atan2(tz, tx), cc = pick(R, carCols);
        add('paint', K.box(x, 2.1, z, 15, 2.6, 6, cc, -a));
        add('paint', K.box(x - tx * 0.8, 4.1, z - tz * 0.8, 8, 1.8, 5.4, shade(cc, 0.6).replace('rgb', 'rgb'), -a));
      });
    }
  } else {
    // Rate: upper concourse (street.h = 60) for street.width, then the outer facade
    const cd0 = OF.depth - 0.01, cd1 = OF.depth + PK.street.width, cH = PK.street.h;
    for (const pth of [pathOF, cornerR, cornerL]) {
      add('paint', sweep(pth, { pts: [[cd0, sH(cd0)], [cd0, cH]], color: C.concourse }));
      add('paint', sweep(pth, { pts: [[cd0, cH], [cd1, cH]], color: C.concourse }));
      add('paint', sweep(pth, { pts: [[cd1, cH], [cd1, cH + 3.6]], color: C.steel }));
      add('paint', sweep(pth, { pts: [[cd1, cH + 3.6], [cd1 + 1, cH + 3.6], [cd1 + 1, 0]], color: '#2e3238' }));
    }
    // concourse crowd (standing fans)
    crowdRows(ofPath(spraySamples(-44, -10, 1)), cd0 + 4, cH, cd0 + 14, cH, { rowD: 5, gap: 40, fill: 0.6 });
    crowdRows(ofPath(spraySamples(10, 44, 1)), cd0 + 4, cH, cd0 + 14, cH, { rowD: 5, gap: 40, fill: 0.6 });
  }
  // corner fill end caps (the side of the outfield stands facing the grandstand)
  {
    const outline = isW
      ? [[0, 0], [0, H0], [capD, H0], [capD, sH(capD)], [OF.depth, topH], [OF.depth, backTop], [OF.depth + 1.2, backTop], [OF.depth + 1.2, 0]]
      : [[0, 0], [0, H0], [capD, H0], [capD, sH(capD)], [OF.depth, topH], [OF.depth, PK.street.h], [OF.depth + PK.street.width, PK.street.h], [OF.depth + PK.street.width + 1, PK.street.h + 3.6], [OF.depth + PK.street.width + 1, 0]];
    for (const cp of [cornerR, cornerL]) { const e = cp[cp.length - 1]; endCap(e.p, e.n, outline); }
  }

  // Distance markers + foul poles
  const SIGNS = []; // {text, kind}
  {
    const marks = [[-42, -45], [-22, -22], [0, 0], [22, 22], [42, 45]];
    for (const [s, sv] of marks) {
      const txt = String(Math.round(fenceAt(sv)));
      SIGNS.push({ kind: isW ? 'plate' : 'paint', text: txt, s, r: fenceAt(s), y: isW ? 6.4 : 4.2, w: isW ? 7 : 8, h: isW ? 3.2 : 3.6 });
    }
    for (const sg of [-1, 1]) {
      const r = fenceAt(45 * sg), [x, z] = [Math.sin(45 * sg * D2R) * r, -Math.cos(45 * sg * D2R) * r];
      add('paint', K.cyl(x, 0, z, x, C.poleH, z, 0.75, 0.55, 10, C.pole));
      // fair-side screen (wing)
      const t = dirXZ(45 * sg + 90 * -sg); // toward fair territory, tangent to the fence
      add('chain', K.quad([x, H0 + 1, z], [x + t[0] * 2.2, H0 + 1, z + t[1] * 2.2], [x + t[0] * 2.2, C.poleH - 3, z + t[1] * 2.2], [x, C.poleH - 3, z], null, [0, 0, 1.5, (C.poleH - H0) / 1.5]));
      add('paint', K.quad([x + t[0] * 2.2, H0 + 1, z + t[1] * 2.2], [x + t[0] * 2.3, H0 + 1, z + t[1] * 2.3], [x + t[0] * 2.3, C.poleH - 3, z + t[1] * 2.3], [x + t[0] * 2.2, C.poleH - 3, z + t[1] * 2.2], C.pole));
    }
  }
  // Wrigley basket (wire basket leaning over the track from the wall top)
  if (isW) add('chain', sweep(pathOF, { pts: [[0.2, H0], [-2.6, H0 + 3.2]], uScale: 1.2, vScale: 1.2 }));

  mark('grandstand');
  // ======================================================================
  // GRANDSTAND (swept profile along the foul walls + behind home)
  // ======================================================================
  const GS = isW ? {
    strips: [
      { key: 'brick', pts: [[0, 0], [0, C.wallH]], uScale: 3.2, vScale: 3.0 },
      { key: 'paint', color: C.fieldWallPaint, pts: [[0, C.wallH], [1.5, C.wallH], [1.5, 4.3]] },
      { key: 'seatsGS', pts: [[1.5, 4.3], [82, 35]], uScale: 14, vScale: 12 },
      { key: 'paint', color: C.concourse, pts: [[82, 35], [82, 57]] },
      { key: 'paint', color: C.underside, pts: [[56, 43.5], [130, 82]] },
      { key: 'paint', color: C.steel, pts: [[56, 43.5], [56, 49]] },
      { key: 'paint', color: '#e9ece6', pts: [[56, 49], [56, 50]] },
      { key: 'paint', color: C.steel, pts: [[56, 50], [56, 50.6]] },
      { key: 'seatsGS', pts: [[56, 50.6], [128, 88]], uScale: 14, vScale: 12 },
      { key: 'paint', color: C.steel, pts: [[128, 88], [128, 97]] },
      { key: 'roof', pts: [[60, 100], [134, 97]], uScale: 16, vScale: 16 },
      { key: 'paint', color: C.underside, pts: [[60, 98.4], [134, 95.4]] },
      { key: 'paint', color: C.steel, pts: [[60, 98.4], [60, 100]] },
      { key: 'brick', pts: [[134, 0], [134, 42]], uScale: 3.2, vScale: 3.0 },
      { key: 'paint', color: C.steelDark, pts: [[134, 42], [134, 97]] },
    ],
    crowd: [[1.5, 4.3, 82, 35, 2.9, 57], [56, 50.6, 128, 88, 2.9, 62]],
    outline: [[0, 0], [0, C.wallH], [1.5, C.wallH], [1.5, 4.3], [56, 25.1], [56, 52.6], [60, 100], [134, 97], [134, 0]],
    colsLow: { v: 54, y1: 43.5, every: 30 }, colsUp: { v: 64, y1: 98.4, every: 34 },
    roofV: [60, 134], roofY: 100, lampV: 96, net: [C.wallH, 30], dugout: [60, 122],
  } : {
    strips: [
      { key: 'pads', pts: [[0, 0], [0, C.wallH]], uScale: 8, vFixed: [0, 1] },
      { key: 'paint', color: C.wallCap, pts: [[0, C.wallH], [1.5, C.wallH], [1.5, 5.8]] },
      { key: 'seatsGS', pts: [[1.5, 5.8], [88, 40]], uScale: 14, vScale: 12 },
      { key: 'facadeGlass', pts: [[88, 40], [88, 54.2]], uScale: 40, vFixed: [0.3, 0.72], extra: { fv: 0 } },
      { key: 'paint', color: C.underside, pts: [[72, 44], [160, 100]] },
      { key: 'paint', color: C.steel, pts: [[72, 44], [72, 45.5]] },
      { key: 'ribbon', pts: [[72, 45.5], [72, 50.5]], uScale: 80 },
      { key: 'paint', color: C.steel, pts: [[72, 50.5], [72, 52.5]] },
      { key: 'seatsGS', pts: [[72, 52.5], [158, 118]], uScale: 14, vScale: 12 },
      { key: 'paint', color: C.steel, pts: [[158, 118], [158, 126]] },
      { key: 'roof', pts: [[106, 130], [168, 126]], uScale: 16, vScale: 16 },
      { key: 'paint', color: C.underside, pts: [[106, 128], [168, 124]] },
      { key: 'paint', color: C.steel, pts: [[106, 128], [106, 130]] },
      { key: 'paint', color: '#2b2f36', pts: [[168, 0], [168, 126]] },
    ],
    crowd: [[1.5, 5.8, 88, 40, 3.0, 73], [72, 52.5, 158, 118, 3.0, 108]],
    outline: [[0, 0], [0, C.wallH], [1.5, C.wallH], [1.5, 5.8], [72, 34.6], [72, 52.5], [106, 78.2], [106, 130], [168, 126], [168, 0]],
    colsLow: null, colsUp: { v: 120, y1: 128, every: 40 },
    roofV: [106, 168], roofY: 130, lampV: 110, net: [C.wallH, 34], dugout: [62, 126],
  };
  const vAt = (pts, v) => { // y on a 2-pt seat line at offset v
    const [[a, ya], [b, yb]] = pts; return lerp(ya, yb, clamp((v - a) / (b - a), 0, 1));
  };
  for (const s of GS.strips) add(s.key, sweep(gsPath, s));
  // end caps
  endCap(gsPath[0].p, gsPath[0].n, GS.outline);
  endCap(gsPath[gsPath.length - 1].p, gsPath[gsPath.length - 1].n, GS.outline);
  // crowd
  for (const [v0, y0, v1, y1, rowD, shadeFrom] of GS.crowd) crowdRows(gsPath, v0, y0, v1 - 0.8, y1 - 0.8 * (y1 - y0) / (v1 - v0), { rowD, gap: 58, shadeFrom, fill: 0.95 });
  // columns
  const lowSeat = GS.strips.find(s => s.key === 'seatsGS').pts, upSeat = GS.strips.filter(s => s.key === 'seatsGS')[1].pts;
  if (GS.colsLow) walk(offsetLine(gsPath, GS.colsLow.v), GS.colsLow.every, (x, z) => add('paint', K.cyl(x, vAt(lowSeat, GS.colsLow.v) - 1, z, x, GS.colsLow.y1, z, 0.7, 0.7, 8, C.steel)));
  if (GS.colsUp) walk(offsetLine(gsPath, GS.colsUp.v), GS.colsUp.every, (x, z) => add('paint', K.cyl(x, vAt(upSeat, GS.colsUp.v) - 1, z, x, GS.colsUp.y1, z, 0.8, 0.8, 8, C.steel)));
  // backstop netting (behind home, dugout to dugout)
  {
    const sub = gsPath.filter(q => q.side === 0 || q.u <= GS.dugout[1] + 5);
    add('net', sweep(sub, { pts: [[-0.4, GS.net[0]], [-0.4, GS.net[1]]], uScale: 0.5, vScale: 0.5 }));
    add('paint', sweep(sub, { pts: [[-0.4, GS.net[1] - 0.7], [-0.4, GS.net[1]]], color: '#2a2a2a' }));
  }
  // dugouts
  for (const sg of [1, -1]) {
    const [u0, u1] = GS.dugout, a = foulPt(sg, u0), b = foulPt(sg, u1);
    const N = [sg * SQ, SQ]; const ax = a[0] - N[0] * 0.12, az = a[1] - N[1] * 0.12, bx = b[0] - N[0] * 0.12, bz = b[1] - N[1] * 0.12;
    add('paint', K.quad([ax, 0.02, az], [bx, 0.02, bz], [bx, C.wallH - 0.4, bz], [ax, C.wallH - 0.4, az], '#0c0e0d'));
    const roofC = isW ? '#1f5a32' : '#22252b';
    add('paint', K.quad([ax - N[0] * 1.2, C.wallH - 0.4, az - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH - 0.4, bz - N[1] * 1.2], [bx + N[0] * 8, C.wallH - 0.4, bz + N[1] * 8], [ax + N[0] * 8, C.wallH - 0.4, az + N[1] * 8], roofC));
    add('paint', K.quad([ax - N[0] * 1.2, C.wallH - 0.4, az - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH - 0.4, bz - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH + 0.3, bz - N[1] * 1.2], [ax - N[0] * 1.2, C.wallH + 0.3, az - N[1] * 1.2], roofC));
    // railing
    add('paint', K.wallBox(ax - N[0] * 1.0, az - N[1] * 1.0, bx - N[0] * 1.0, bz - N[1] * 1.0, 0.15, C.wallH + 0.3, C.wallH + 3.2, '#8a9096'));
  }

  mark('lights');
  // ======================================================================
  // LIGHT BANKS (+ glare at dusk/night)
  // ======================================================================
  const glare = []; // [x,y,z,size,r,g,b,a]
  function lightBank(x, y, z, w, h, aim = [0, 25, -150]) {
    // steel frame + lamp panel facing `aim`
    const dx = aim[0] - x, dz = aim[2] - z, L = Math.hypot(dx, dz), fx = dx / L, fz = dz / L;
    const tx = -fz, tz = fx; // panel tangent
    const tilt = 0.32; // lean toward the field (top toward aim)
    const b0 = [x - tx * w / 2, y, z - tz * w / 2], b1 = [x + tx * w / 2, y, z + tz * w / 2];
    const t1 = [b1[0] + fx * h * tilt, y + h, b1[2] + fz * h * tilt], t0 = [b0[0] + fx * h * tilt, y + h, b0[2] + fz * h * tilt];
    const off = (p, k) => [p[0] - fx * k, p[1], p[2] - fz * k];
    add('lamps', K.quad(b0, b1, t1, t0, null, [0, 0, Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 6))]));
    add('paint', K.quad(off(b0, 1.2), off(b1, 1.2), off(t1, 1.2), off(t0, 1.2), '#30353b'));
    // frame edges
    add('paint', K.cyl(b0[0], y - 0.6, b0[2], b1[0], y - 0.6, b1[2], 0.5, 0.5, 6, '#3b4046'));
    add('paint', K.cyl(t0[0], y + h + 0.6, t0[2], t1[0], y + h + 0.6, t1[2], 0.5, 0.5, 6, '#3b4046'));
    if (LOOK.glare > 0) {
      const nx = Math.max(2, Math.round(w / 9)), ny = Math.max(1, Math.round(h / 9));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const fu = (i + 0.5) / nx, fv = (j + 0.5) / ny;
        const px = lerp(b0[0], b1[0], fu) + fx * (h * tilt * fv + 1.5), pz = lerp(b0[2], b1[2], fu) + fz * (h * tilt * fv + 1.5), py = y + h * fv;
        glare.push(px, py, pz, 9 + 4 * LOOK.glare, 1, 0.97, 0.9, 0.7 * LOOK.glare);
      }
      glare.push(x + fx * 4, y + h / 2, z + fz * 4, Math.max(w, h) * 1.25, 1, 0.95, 0.85, 0.22 * LOOK.glare);
    }
  }
  {
    const roofTopY = v => { const rp = GS.strips.find(s => s.key === 'roof').pts; return vAt(rp, v); };
    const us = isW ? [70, 180, 290] : [40, 110, 180, 250, 320];
    for (const sg of [1, -1]) for (const u of us) {
      const p = foulPt(sg, u), N = [sg * SQ, SQ], v = GS.lampV;
      const x = p[0] + N[0] * v, z = p[1] + N[1] * v, y = roofTopY(v);
      if (isW) { // mast on the roof
        add('paint', K.cyl(x, y, z, x, y + 20, z, 0.9, 0.9, 6, C.steel));
        add('paint', K.cyl(x - 6 * N[1], y, z + 6 * N[0], x, y + 20, z, 0.5, 0.5, 5, C.steel));
        lightBank(x, y + 20, z, 34, 14);
      } else {
        const fx = p[0] + N[0] * (GS.roofV[0] + 1), fz = p[1] + N[1] * (GS.roofV[0] + 1);
        add('paint', K.cyl(fx, GS.roofY, fz, fx, GS.roofY + 4, fz, 0.6, 0.6, 6, C.steel));
        lightBank(fx, GS.roofY + 4, fz, 30, 11);
      }
    }
    if (!isW) { // behind home, on the canopy
      for (const th of [160, 180, 200]) { const p = backstopPt(th), n = dirXZ(th); const x = p[0] + n[0] * (GS.roofV[0] + 1), z = p[1] + n[1] * (GS.roofV[0] + 1); lightBank(x, GS.roofY + 4, z, 30, 11); }
    }
    // outfield towers
    const towerS = isW ? [-33, 33] : [-36, 36];
    for (const s of towerS) {
      const d = isW ? OF.depth - 3 : OF.depth + PK.street.width - 3, r = fenceAt(s) + d, [x, , z] = polar(s, r);
      const y0 = isW ? topH : PK.street.h, top = isW ? 112 : 150;
      add('paint', K.cyl(x, y0, z, x, top, z, isW ? 2.2 : 3.4, isW ? 1.2 : 1.6, 4, isW ? C.steel : '#3a3f46'));
      add('paint', K.box(x, top - 1, z, 12, 2, 12, isW ? C.steel : '#3a3f46', -s * D2R));
      lightBank(x, top, z, isW ? 28 : 38, isW ? 13 : 17, [0, 20, -120]);
    }
  }

  mark('board');
  // ======================================================================
  // CF SCOREBOARD (Wrigley: classic green board + clock) / VIDEO BOARD (Rate)
  // ======================================================================
  const SB = PK.scoreboard;
  const boardCanvas = mkCanvas(1024, isW ? 512 : 288), bg = boardCanvas.getContext('2d');
  T.board = tex(boardCanvas, { wrap: 'clamp' });
  M.board = isW
    ? new THREE.MeshStandardMaterial({ map: T.board, emissiveMap: T.board, emissive: col('#ffffff'), emissiveIntensity: tod === 'day' ? 0.08 : 0.35, roughness: 0.85, side })
    : new THREE.MeshBasicMaterial({ map: T.board, toneMapped: false, side, color: col(tod === 'day' ? '#e6e6e6' : '#ffffff') });
  disposables.push(M.board);
  {
    const sArr = spraySamples(SB.spray[0], SB.spray[1], 0.5);
    const front = sArr.map(s => { const r = scoreboardDistance(parkId, s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    const depth = SB.depth;
    const faceY = isW ? [57, 84] : [63, 106.5], baseY = isW ? topH : PK.street.h, topY = isW ? 85 : SB.h;
    // face (canvas): v range of the canvas region
    const v0 = isW ? 1 - 320 / 512 : 0;
    add('board', sweep(front, { pts: [[-0.3, faceY[0]], [-0.3, faceY[1]]], uScale: 1, vFixed: [v0, 1] }));
    // fix u to 0..1 over the width
    {
      const g = BINS.board[BINS.board.length - 1], uv = g.attributes.uv, n = uv.count; let maxU = 0;
      for (let i = 0; i < n; i++) maxU = Math.max(maxU, uv.getX(i));
      for (let i = 0; i < n; i++) uv.setX(i, uv.getX(i) / maxU);
    }
    const frameC = isW ? '#1f4a2c' : '#0d0e11';
    add('paint', sweep(front, { pts: [[0, baseY], [0, faceY[0]]], color: isW ? '#23452e' : '#16181c' }));
    add('paint', sweep(front, { pts: [[0, faceY[1]], [0, topY]], color: frameC }));
    add('paint', sweep(front, { pts: [[0, topY], [depth, topY]], color: frameC }));
    add('paint', sweep(front, { pts: [[depth, topY], [depth, baseY]], color: isW ? '#2c3a30' : '#1b1d22' }));
    // side caps
    for (const e of [front[0], front[front.length - 1]]) capAt(e.p, e.n, [[0, baseY], [0, topY], [depth, topY], [depth, baseY]], frameC);
    // bezel lips around the face
    add('paint', sweep(front, { pts: [[-1.2, faceY[0] - 0.8], [-1.2, faceY[0]], [0, faceY[0]]], color: frameC }));
    add('paint', sweep(front, { pts: [[0, faceY[1]], [-1.2, faceY[1]], [-1.2, faceY[1] + 0.8]], color: frameC }));
    if (isW) {
      // clock housing on top, clock face uses the canvas region (0..192, 320..512)
      const r = scoreboardDistance(parkId, 0), [cx, , cz] = polar(0, r);
      add('paint', K.box(cx, (topY + SB.h) / 2, cz - 3, 16, SB.h - topY, 6, '#1f4a2c'));
      add('paint', K.box(cx, SB.h + 0.35, cz - 3, 17, 0.7, 7, '#e8e2c8'));
      const cw = 8.2, ch0 = topY + 0.9;
      add('board', K.quad([cx - cw / 2, ch0, cz + 0.12], [cx + cw / 2, ch0, cz + 0.12], [cx + cw / 2, ch0 + cw, cz + 0.12], [cx - cw / 2, ch0 + cw, cz + 0.12], null, [0, 0, 192 / 1024, 192 / 512]));
    } else {
      // legs from the concourse
      for (const s of [-7.5, -2.5, 2.5, 7.5]) { const rr = scoreboardDistance(parkId, clamp(s, SB.spray[0], SB.spray[1])) + depth / 2, [x, , z] = polar(s, rr); add('paint', K.box(x, PK.street.h + 1.5, z, 3, 3, depth * 0.7, '#0d0e11', -s * D2R)); }
    }
  }

  mark('rooftops');
  // ======================================================================
  // WRIGLEY: rooftop buildings across Waveland/Sheffield (surfaceHeight = rooftops.h)
  // RATE: ribbon boards + concourse extras
  // ======================================================================
  function building(s0, s1, rFront, rBack, h, variant, roofCol) {
    // straight chord front between spray s0..s1 at radius rFront(s), back at rBack(s)
    const A = polar(s0, rFront(s0)), B = polar(s1, rFront(s1)), Cc = polar(s1, rBack(s1)), Dd = polar(s0, rBack(s0));
    const fw = Math.hypot(B[0] - A[0], B[2] - A[2]), sw = Math.hypot(Dd[0] - A[0], Dd[2] - A[2]);
    const face = (p, q, w) => K.quad([p[0], 0, p[2]], [q[0], 0, q[2]], [q[0], h, q[2]], [p[0], h, p[2]], null, [0, 0, w / 40, h / 52], { fv: 3 - variant });
    add('facade', face(A, B, fw)); add('facade', face(B, Cc, sw)); add('facade', face(Cc, Dd, fw)); add('facade', face(Dd, A, sw));
    add('paint', K.quad([A[0], h, A[2]], [B[0], h, B[2]], [Cc[0], h, Cc[2]], [Dd[0], h, Dd[2]], roofCol || '#55524d'));
    return { A, B, Cc, Dd };
  }
  const SIGN_TEXTS = [];
  if (isW) {
    const RT = PK.rooftops, rf = s => fenceAt(s) + OF.depth + PK.street.width, rb = s => rf(s) + RT.depth;
    const signPlan = { 1: 'BLUFOX MOBILE', 4: 'NORTH SIDE', 8: 'EST. 1914', 11: 'WINDY CITY' };
    let bi = 0;
    for (const [a, b] of RT.spray) {
      const n = Math.max(1, Math.round((b - a) / 5.6)), step = (b - a) / n;
      for (let k = 0; k < n; k++, bi++) {
        const s0 = a + k * step, s1 = a + (k + 1) * step; // contiguous: surfaceHeight = rooftops.h across the whole range
        const variant = [0, 1, 2, 0, 2, 1][bi % 6];
        const { A, B } = building(s0, s1, rf, rb, RT.h, variant, '#4a4744');
        // rooftop bleachers: parapet rail, low risers from the roof deck (52) + crowd
        const P0 = { p: [A[0], A[2]] }, P1 = { p: [B[0], B[2]] };
        const mid = (s0 + s1) / 2, nrm = dirXZ(mid);
        const pth = [{ p: P0.p, n: nrm }, { p: P1.p, n: nrm }];
        add('paint', sweep(pth, { pts: [[0.3, RT.h], [0.3, RT.h + 3.2]], color: '#2c2f33' }));
        add('seatsOF', sweep(pth, { pts: [[4, RT.h + 0.2], [34, RT.h + 7]], uScale: 14, vScale: 11.6 }));
        add('paint', sweep(pth, { pts: [[34, RT.h + 7], [34, RT.h], [4, RT.h], [4, RT.h + 0.2]], color: '#3b3f44' }));
        crowdRows(pth, 5, RT.h + 0.4, 33, RT.h + 6.8, { rowD: 3.2, gap: 0, kind: 0, fill: 0.9, facing: () => [-nrm[0], -nrm[1]] });
        // steel canopy frame posts
        for (const f of [0.08, 0.92]) { const x = lerp(A[0], B[0], f) + nrm[0] * 34, z = lerp(A[2], B[2], f) + nrm[1] * 34; add('paint', K.cyl(x, RT.h, z, x, RT.h + 16, z, 0.4, 0.4, 5, '#2f3338')); }
        add('paint', sweep([{ p: [A[0] + nrm[0] * 34, A[2] + nrm[1] * 34], n: nrm }, { p: [B[0] + nrm[0] * 34, B[2] + nrm[1] * 34], n: nrm }], { pts: [[-1, RT.h + 16], [3, RT.h + 16.8]], color: '#2f3338' }));
        if (signPlan[bi]) {
          const x0 = lerp(A[0], B[0], 0.12) + nrm[0] * 42, z0 = lerp(A[2], B[2], 0.12) + nrm[1] * 42, x1 = lerp(A[0], B[0], 0.88) + nrm[0] * 42, z1 = lerp(A[2], B[2], 0.88) + nrm[1] * 42;
          const sy = RT.h + 18, sh = 9;
          SIGN_TEXTS.push({ text: signPlan[bi], quad: [[x0, sy, z0], [x1, sy, z1], [x1, sy + sh, z1], [x0, sy + sh, z0]] });
          for (const f of [0.15, 0.85]) { const x = lerp(x0, x1, f), z = lerp(z0, z1, f); add('paint', K.cyl(x, RT.h, z, x, sy, z, 0.35, 0.35, 5, '#2f3338')); }
          add('paint', K.quad([x0 + nrm[0] * 0.6, sy, z0 + nrm[1] * 0.6], [x1 + nrm[0] * 0.6, sy, z1 + nrm[1] * 0.6], [x1 + nrm[0] * 0.6, sy + sh, z1 + nrm[1] * 0.6], [x0 + nrm[0] * 0.6, sy + sh, z0 + nrm[1] * 0.6], '#1b1d20'));
        }
      }
    }
    // street signs at the bleacher corners
    // the classic red marquee outside, behind home plate (park name only — no team text)
    {
      const zc = C.foul.backstop + 134 + 20, y0 = 15, w = 36, h = 15;
      for (const x of [-w / 2 + 3, w / 2 - 3]) add('paint', K.box(x, y0 / 2, zc, 1.8, y0, 1.8, '#2b2b2b'));
      add('paint', K.box(0, y0 + h / 2, zc, w + 2.4, h + 2.4, 3.2, '#6e0e12'));
      add('paint', K.box(0, y0 + h + 2.2, zc, w * 0.6, 2.2, 2.4, '#6e0e12'));
      SIGN_TEXTS.push({ text: 'WRIGLEY FIELD', marquee: true, quad: [[-w / 2, y0, zc + 1.7], [w / 2, y0, zc + 1.7], [w / 2, y0 + h, zc + 1.7], [-w / 2, y0 + h, zc + 1.7]] });
    }
    SIGN_TEXTS.push({ text: 'WAVELAND AVE', street: true, quad: streetSign(-40) });
    SIGN_TEXTS.push({ text: 'SHEFFIELD AVE', street: true, quad: streetSign(40) });
    function streetSign(s) {
      const r = fenceAt(s) + OF.depth + 8, [x, , z] = polar(s, r), t = dirXZ(s + 90), n = dirXZ(s);
      add('paint', K.cyl(x, 0, z, x, 14, z, 0.2, 0.2, 5, '#3a4a3a'));
      const w = 7, y = 12.2, h = 1.6;
      return [[x - t[0] * w / 2 - n[0] * 0.3, y, z - t[1] * w / 2 - n[1] * 0.3], [x + t[0] * w / 2 - n[0] * 0.3, y, z + t[1] * w / 2 - n[1] * 0.3], [x + t[0] * w / 2 - n[0] * 0.3, y + h, z + t[1] * w / 2 - n[1] * 0.3], [x - t[0] * w / 2 - n[0] * 0.3, y + h, z - t[1] * w / 2 - n[1] * 0.3]];
    }
  }

  // Rate ribbon boards (outfield mid-rail at d=45 + grandstand club fascia)
  let ribbonTex = null;
  if (!isW) {
    const c = mkCanvas(1024, 64), g = c.getContext('2d');
    const draw = () => {
      g.fillStyle = '#050608'; g.fillRect(0, 0, 1024, 64);
      const items = ['BLUFOX MOBILE', 'WINDY CITY DERBY', 'SOUTH SIDE', 'RATE FIELD', 'SWING FOR THE FENCES'];
      let x = 12; g.font = '900 40px "Arial Black","Helvetica Neue",Arial,sans-serif'; g.textBaseline = 'middle';
      items.forEach((t, i) => { g.fillStyle = i % 2 ? '#dfe6ee' : '#ffffff'; g.fillText(t, x, 34); x += g.measureText(t).width + 18; g.fillStyle = '#8fa0b4'; g.fillRect(x, 26, 14, 14); x += 32; });
      g.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = 0; y < 64; y += 3) g.fillRect(0, y, 1024, 1);
    };
    draw();
    ribbonTex = tex(c); ribbonTex.wrapT = THREE.ClampToEdgeWrapping;
    M.ribbon = new THREE.MeshBasicMaterial({ map: ribbonTex, toneMapped: false, color: col(tod === 'day' ? '#bfc4ca' : '#ffffff'), side });
    disposables.push(M.ribbon);
    // ribbons face home plate: seen from behind (camera further out than the board) show a dark back panel
    M.ribbon.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vRW;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nif (dot(normalize(vRW.xz), cameraPosition.xz - vRW.xz) > 0.0) diffuseColor.rgb = vec3(0.035, 0.038, 0.045);');
    };
    const dR = 45, yR = sH(dR);
    for (const rng of [[-44, -eye - 0.5], [eye + 0.5, 44]]) add('ribbon', sweep(ofPath(spraySamples(rng[0], rng[1], 1)), { pts: [[dR, yR - 0.2], [dR, yR + 2.6]], uScale: 45, vFixed: [0, 1] }));
    // fix ribbon uv v for grandstand strip (sweep used vScale default) → set v to [0,1]
    for (const g of BINS.ribbon || []) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) > 0.01 ? 1 : 0); }
  }

  mark('city');
  // ======================================================================
  // CITY — Chicago street grid. Both parks face NE, so the N-S/E-W grid runs at
  // 45° to the CF axis (parallel to the foul lines). Blocks of 2-4 flat walk-ups,
  // parkway trees, the odd wooden water tank; far blocks are cheap massing.
  // ======================================================================
  const GA = [SQ, -SQ], GB = [-SQ, -SQ];            // grid axes: A → RF (east), B → LF (north)
  const BA = 330, BB = 620, STW = 66;               // block pitch along A / B, street right-of-way
  const offA = isW ? 150 : 95, offB = isW ? 270 : 180;
  const toW = (a, b) => [GA[0] * a + GB[0] * b, GA[1] * a + GB[1] * b];
  const rClear = isW ? 640 : 720;                   // nothing inside this radius but plaza/parking
  {
    const nearR = quality === 'low' ? 1250 : quality === 'medium' ? 1600 : 1900, farR = 3600;
    const roofCols = ['#4a4845', '#5e5a55', '#3f3d3b', '#55524e', '#6a655e'];
    const box = (a0, a1, b0, b1, h, variant) => {
      const P = [toW(a0, b0), toW(a1, b0), toW(a1, b1), toW(a0, b1)];
      for (let k = 0; k < 4; k++) {
        const p = P[k], q = P[(k + 1) % 4], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        rawQuad('facade', [p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], h, q[1]], [p[0], h, p[1]], null, [0, 1 - h / 52, L / 40, 1], { fv: 3 - variant });
      }
      rawQuad('paint', [P[0][0], h, P[0][1]], [P[1][0], h, P[1][1]], [P[2][0], h, P[2][1]], [P[3][0], h, P[3][1]], pick(R, roofCols));
      return P;
    };
    const tank = (a, b, h) => { // classic Chicago wooden water tank on legs
      const [x, z] = toW(a, b), r = 5 + R() * 2;
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) rawTpl('paint', TP.leg(), x + dx * r * 0.6, h, z + dz * r * 0.6, 0.7, 9, 0.7, '#2d2b29');
      rawTpl('paint', TP.tank(), x, h + 9, z, r, 12, r, '#6b4a33');
      rawTpl('paint', TP.cone(), x, h + 21, z, r * 1.05, 5, r * 1.05, '#3a2f28');
    };
    const heightFor = (r) => {
      const q = R();
      if (r > (isW ? 2100 : 1300) && q < (isW ? 0.03 : 0.05)) return 110 + R() * 150;
      if (r > 900 && q < (isW ? 0.05 : 0.1)) return 54 + R() * 30;
      return isW ? (q < 0.4 ? 27 + R() * 4 : q < 0.85 ? 35 + R() * 6 : 44 + R() * 8) : (q < 0.5 ? 22 + R() * 10 : 32 + R() * 14);
    };
    const variantFor = h => (h > 90 ? 3 : h > 52 ? (R() < 0.5 ? 2 : 3) : isW ? Math.floor(R() * 3) : (R() < 0.25 ? 3 : Math.floor(R() * 3)));
    let nTrees = 0; const maxTrees = quality === 'low' ? 90 : quality === 'medium' ? 180 : 280;
    for (let ia = -13; ia <= 12; ia++) for (let ib = -7; ib <= 6; ib++) {
      const a0 = ia * BA + offA + STW / 2, a1 = (ia + 1) * BA + offA - STW / 2, b0 = ib * BB + offB + STW / 2, b1 = (ib + 1) * BB + offB - STW / 2;
      const [cx, cz] = toW((a0 + a1) / 2, (b0 + b1) / 2), rc = Math.hypot(cx, cz);
      if (rc > farR) continue;
      const lotOK = (a, b) => { const [x, z] = toW(a, b); return Math.hypot(x, z) > rClear; };
      if (rc > nearR) { // massing: a few long runs of buildings along both long edges
        for (const [e0, e1] of [[a0 + 6, a0 + 66], [a1 - 66, a1 - 6]]) {
          let b = b0 + 4;
          while (b < b1 - 20) {
            const len = Math.min(b1 - 4 - b, 90 + R() * 160); if (!lotOK((e0 + e1) / 2, b + len / 2)) { b += len + 8; continue; }
            const h = heightFor(rc); box(e0, e1, b, b + len, h, variantFor(h)); b += len + 6 + R() * 10;
          }
        }
        continue;
      }
      // near blocks: individual lots along both long edges (fronts on the A-streets)
      for (const side of [0, 1]) {
        let b = b0 + 4;
        while (b < b1 - 10) {
          const w = pick(R, [25, 25, 25, 30, 37, 50]), gap = 3 + R() * 5;
          if (b + w > b1 - 4) break;
          const dep = 50 + R() * 26, e0 = side ? a1 - 10 - dep : a0 + 10, e1 = side ? a1 - 10 : a0 + 10 + dep;
          if (lotOK((e0 + e1) / 2, b + w / 2)) {
            const h = heightFor(rc); box(e0, e1, b, b + w, h, variantFor(h));
            if (h < 60 && R() < 0.035) tank((e0 + e1) / 2, b + w / 2, h);
            if (nTrees < maxTrees && R() < 0.45) { // parkway tree in front
              const ta = side ? a1 + 5 : a0 - 5, [tx, tz] = toW(ta, b + w / 2);
              if (Math.hypot(tx, tz) > rClear - 30) {
                const sz = 9 + R() * 7; nTrees++;
                tree(tx, tz, sz, pick(R, ['#2f5a2a', '#3a6a30', '#2a4f26', '#44702f', tod === 'dusk' ? '#56662b' : '#35622d']));
              }
            }
          }
          b += w + gap;
        }
      }
    }
    // Wrigleyville trees just beyond the CF corner of Waveland & Sheffield
    if (isW) for (let k = 0; k < 12; k++) {
      const s = -11 + R() * 22, rr = fenceAt(s) + OF.depth + PK.street.width + 14 + R() * 40, [x, , z] = polar(s, rr), sz = 10 + R() * 7;
      tree(x, z, sz, pick(R, ['#2f5a2a', '#3a6a30', '#2a4f26']));
    }
  }
  // ground: one texture tile per city block (streets, sidewalks, alley, yards)
  {
    const c = cached('block' + parkId, () => {
      const W = 256, H = 480, cv = mkCanvas(W, H), g = cv.getContext('2d'); const r = makeRng('block' + parkId);
      const sa = W * (STW / 2) / BA, sb = H * (STW / 2) / BB;       // street half-widths in px
      g.fillStyle = '#44464a'; g.fillRect(0, 0, W, H);                 // asphalt
      g.fillStyle = '#9d9a92'; g.fillRect(sa - 9, sb - 9, W - 2 * sa + 18, H - 2 * sb + 18); // sidewalk ring
      g.fillStyle = '#56713f'; g.fillRect(sa - 4, sb - 4, W - 2 * sa + 8, H - 2 * sb + 8);   // parkway grass
      g.fillStyle = isW ? '#5b5148' : '#56585d'; g.fillRect(sa, sb, W - 2 * sa, H - 2 * sb); // lots
      for (let k = 0; k < 90; k++) { g.fillStyle = r() < 0.6 ? '#4d6a38' : '#6b665d'; g.fillRect(sa + 30 + r() * (W - 2 * sa - 70), sb + r() * (H - 2 * sb - 20), 12 + r() * 16, 10 + r() * 20); }
      g.fillStyle = '#4a4b4e'; g.fillRect(W / 2 - 6, sb, 12, H - 2 * sb);   // alley
      for (let k = 0; k < 1800; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.05})`; g.fillRect(r() * W, r() * H, 2, 2); }
      return cv;
    });
    T.block = tex(c);
    const g = new THREE.CircleGeometry(6000, 96); g.rotateX(-Math.PI / 2); g.translate(0, -0.35, 0);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); uv.setXY(i, (x * GA[0] + z * GA[1] - offA) / BA, (x * GB[0] + z * GB[1] - offB) / BB); }
    M.cityGround.map = T.block; M.cityGround.needsUpdate = true;
    const m = new THREE.Mesh(g, M.cityGround); m.receiveShadow = true; m.name = 'ground'; m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m); disposables.push(g);
    // plaza / parking around the park
    const pc = cached('plaza' + parkId, () => {
      const W = 128, cv = mkCanvas(W, W), gg = cv.getContext('2d'); const r = makeRng('plaza' + parkId);
      gg.fillStyle = isW ? '#55565a' : '#3f4145'; gg.fillRect(0, 0, W, W);
      for (let k = 0; k < 900; k++) { gg.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.06})`; gg.fillRect(r() * W, r() * W, 2, 2); }
      if (!isW) { gg.fillStyle = 'rgba(235,235,225,0.75)'; for (let x = 0; x < W; x += 16) { gg.fillRect(x, 4, 2, 44); gg.fillRect(x, 80, 2, 44); } gg.fillRect(0, 48, W, 2); gg.fillRect(0, 78, W, 2); }
      else { gg.fillStyle = 'rgba(255,255,255,0.05)'; for (let x = 0; x < W; x += 32) { gg.fillRect(x, 0, 1, W); gg.fillRect(0, x, W, 1); } }
      return cv;
    });
    T.plaza = tex(pc); T.plaza.repeat.set(1, 1);
    M.plaza = new THREE.MeshStandardMaterial({ map: T.plaza, roughness: wetRough(0.95) }); disposables.push(M.plaza);
    const pg = new THREE.CircleGeometry(rClear + 30, 72); pg.rotateX(-Math.PI / 2); pg.translate(0, -0.18, 0);
    const pp = pg.attributes.position, pu = pg.attributes.uv;
    for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i); pu.setXY(i, (x * GA[0] + z * GA[1]) / 64, (x * GB[0] + z * GB[1]) / 64); }
    const pm = new THREE.Mesh(pg, M.plaza); pm.receiveShadow = true; pm.name = 'plaza'; pm.matrixAutoUpdate = false; pm.updateMatrix();
    group.add(pm); disposables.push(pg);
  }

  mark('signs');
  // ======================================================================
  // SIGNS atlas (distance markers, rooftop signs, street signs)
  // ======================================================================
  {
    const items = [...SIGNS.map(s => ({ ...s })), ...SIGN_TEXTS];
    const AW = 1024, rowH = 96, cols = 4, cw = AW / cols;
    const rowsN = Math.ceil(items.length / cols) || 1, AH = Math.max(64, rowsN * rowH);
    const c = mkCanvas(AW, AH), g = c.getContext('2d');
    g.clearRect(0, 0, AW, AH);
    items.forEach((it, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * rowH; it.uv = [x / AW, 1 - (y + rowH) / AH, (x + cw) / AW, 1 - y / AH];
      if (it.kind === 'plate') { g.fillStyle = '#163d24'; g.fillRect(x + 2, y + 2, cw - 4, rowH - 4); g.strokeStyle = '#e8e4d4'; g.lineWidth = 4; g.strokeRect(x + 8, y + 8, cw - 16, rowH - 16); blockText(g, it.text, x + cw / 2, y + rowH / 2 - 24, 7, '#f3f0e4', 'center'); }
      else if (it.kind === 'paint') { blockText(g, it.text, x + cw / 2, y + rowH / 2 - 28, 8, '#f4f5f7', 'center'); }
      else if (it.marquee) {
        g.fillStyle = '#c0141f'; g.fillRect(x + 2, y + 2, cw - 4, rowH - 4);
        g.fillStyle = '#ffffff'; g.font = '900 32px Georgia,"Times New Roman",serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(it.text, x + cw / 2, y + 26, cw - 16);
        g.fillStyle = '#111317'; g.fillRect(x + 12, y + 48, cw - 24, 38); blockText(g, 'WINDY CITY DERBY', x + cw / 2, y + 56, 2.6, '#f4f1e5', 'center'); g.textAlign = 'left';
      }
      else if (it.street) { g.fillStyle = '#1f6b3a'; g.fillRect(x + 2, y + 24, cw - 4, 48); g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(x + 6, y + 28, cw - 12, 40); g.fillStyle = '#fff'; g.font = '700 30px Arial,Helvetica,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(it.text, x + cw / 2, y + 49); g.textAlign = 'left'; it.uv = [x / AW, 1 - (y + 72) / AH, (x + cw) / AW, 1 - (y + 24) / AH]; }
      else {
        const blu = it.text.startsWith('BLUFOX');
        g.fillStyle = blu ? '#0d3a9a' : '#f1ece0'; g.fillRect(x + 2, y + 2, cw - 4, rowH - 4);
        g.fillStyle = blu ? '#ffffff' : '#9b1c1c'; g.font = `900 ${blu ? 34 : 40}px "Arial Black","Helvetica Neue",Arial,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(it.text, x + cw / 2, y + rowH / 2 + 2, cw - 20); g.textAlign = 'left';
        if (blu) { g.fillStyle = '#ff8a1f'; g.fillRect(x + 12, y + rowH - 16, cw - 24, 6); }
      }
    });
    T.signs = tex(c, { wrap: 'clamp' });
    M.signs = new THREE.MeshStandardMaterial({ map: T.signs, alphaTest: 0.4, roughness: 0.7, side, emissiveMap: T.signs, emissive: col('#ffffff'), emissiveIntensity: tod === 'day' ? 0.0 : tod === 'dusk' ? 0.25 : 0.5 });
    disposables.push(M.signs);
    for (const it of items) {
      if (it.quad) { add('signs', K.quad(...it.quad, null, it.uv)); continue; }
      const s = it.s, r = it.r - (isW ? 0.75 : 0.06), t = dirXZ(s + 90), [x, , z] = polar(s, r);
      const w = it.w, h = it.h, y = it.y;
      add('signs', K.quad([x - t[0] * w / 2, y, z - t[1] * w / 2], [x + t[0] * w / 2, y, z + t[1] * w / 2], [x + t[0] * w / 2, y + h, z + t[1] * w / 2], [x - t[0] * w / 2, y + h, z - t[1] * w / 2], null, it.uv));
    }
  }

  mark('flags');
  // ======================================================================
  // FLAGS (wind readout) — shader-animated, stream toward wind.dir
  // ======================================================================
  const flagSpecs = []; // {anchor:[x,y,z], w, h, cell}
  {
    // atlas 512x192: 4x2 cells of 128x96: 0 US, 1 Chicago, 2 Blufox, 3..7 pennants
    const c = mkCanvas(512, 192), g = c.getContext('2d');
    const cell = (i, fn) => { g.save(); g.translate((i % 4) * 128, Math.floor(i / 4) * 96); fn(); g.restore(); };
    cell(0, () => { // US
      for (let k = 0; k < 13; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#b22234'; g.fillRect(0, k * 96 / 13, 128, 96 / 13 + 0.5); }
      g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 54, 52);
      g.fillStyle = '#fff'; for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(5 + i * 9 + (j % 2) * 4, 6 + j * 10, 1.6, 0, 7); g.fill(); }
    });
    cell(1, () => { // Chicago city flag
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#b3ddf2'; g.fillRect(0, 16, 128, 16); g.fillRect(0, 64, 128, 16);
      g.fillStyle = '#ff0000';
      for (let k = 0; k < 4; k++) { const cx = 25 + k * 26, cy = 48; g.beginPath(); for (let p = 0; p < 12; p++) { const a = p * Math.PI / 6 - Math.PI / 2, rr = p % 2 ? 4.2 : 9.5; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); g.fill(); }
    });
    cell(2, () => { g.fillStyle = '#0d3a9a'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#ff8a1f'; g.fillRect(0, 80, 128, 16); g.fillStyle = '#fff'; g.font = '900 24px "Arial Black",Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BLUFOX', 64, 42); });
    const pens = isW ? ['#1f4fbf', '#c8372d', '#ffffff', '#2e6b34', '#1f4fbf'] : ['#16181c', '#c9d1d9', '#ffffff', '#3b4048', '#c9d1d9'];
    pens.forEach((pc, i) => cell(3 + i, () => { g.fillStyle = pc; g.beginPath(); g.moveTo(0, 8); g.lineTo(128, 48); g.lineTo(0, 88); g.closePath(); g.fill(); g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, 8, 10, 80); }));
    T.flags = tex(c, { wrap: 'clamp' });
    // placements
    if (isW) {
      const r = scoreboardDistance(parkId, 0) + SB.depth * 0.5;
      for (const [s, cellI, hgt] of [[0, 0, 124], [-4.5, 1, 112], [4.5, 2, 112]]) { const [x, , z] = polar(s, s === 0 ? r + 3 : scoreboardDistance(parkId, s) + SB.depth * 0.5); add('paint', K.cyl(x, 85, z, x, hgt, z, 0.3, 0.25, 6, '#d8d8d0')); flagSpecs.push({ a: [x, hgt - 0.6, z], w: s === 0 ? 15 : 12, h: s === 0 ? 8 : 6.5, cell: cellI }); }
    } else {
      for (const [s, cellI] of [[-12, 0], [12, 1], [-15, 2]]) { const rr = fenceAt(s) + OF.depth + 20, [x, , z] = polar(s, rr); add('paint', K.cyl(x, PK.street.h, z, x, 128, z, 0.35, 0.3, 6, '#d8d8d0')); flagSpecs.push({ a: [x, 127.4, z], w: 14, h: 7.5, cell: cellI }); }
    }
    // foul pole pennants
    for (const sg of [-1, 1]) { const r = fenceAt(45 * sg), [x, , z] = polar(45 * sg, r); flagSpecs.push({ a: [x, C.poleH, z], w: 7, h: 3.5, cell: 3 + (sg > 0 ? 1 : 0) }); }
    // roof pennants along the grandstand
    walk(offsetLine(gsPath, GS.roofV[0] + 2), quality === 'low' ? 70 : 42, (x, z, tx, tz, dist, i) => {
      const y = GS.roofY + 0.5; add('paint', K.cyl(x, y, z, x, y + 12, z, 0.15, 0.12, 4, '#cfcfcf'));
      flagSpecs.push({ a: [x, y + 11.6, z], w: 6, h: 3.4, cell: 3 + (flagSpecs.length % 5) });
    });
  }

  mark('merge');
  // ======================================================================
  // Build meshes from bins
  // ======================================================================
  for (const key in RAW) {
    const B = RAW[key]; if (!B.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    if (B.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    for (const n in B.ex) g.setAttribute(n, new THREE.Float32BufferAttribute(B.ex[n], 1));
    g.setIndex(B.idx); add(key, g);
  }
  const matFor = key => ({
    paint: M.paint, roof: M.roof, eye: M.eye, brick: M.brick, ivy: M.ivy, pads: M.pads, seatsOF: M.seatsOF, seatsGS: M.seatsGS, facade: M.facade,
    facadeGlass: M.facade, lamps: M.lamps, net: M.net, chain: M.chain, street: M.street, field: M.field, board: M.board,
    signs: M.signs, ribbon: M.ribbon,
  }[key]);
  // facadeGlass: map to the glass variant of the atlas
  const meshes = {};
  const castKeys = new Set(['paint', 'roof', 'eye', 'brick', 'ivy', 'pads', 'seatsOF', 'seatsGS', 'facade', 'facadeGlass', 'board']);
  for (const key in BINS) {
    const geo = K.merge(BINS[key]); if (!geo) continue;
    const mat = matFor(key); if (!mat) { geo.dispose(); continue; }
    const m = new THREE.Mesh(geo, mat); m.name = key;
    m.castShadow = castKeys.has(key) && quality !== 'low'; m.receiveShadow = key !== 'lamps' && key !== 'net';
    if (key === 'net') m.renderOrder = 2;
    m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m); meshes[key] = (meshes[key] || []); meshes[key].push(m); disposables.push(geo);
  }

  mark('crowd');
  // ---- crowd instanced mesh
  let crowd = null;
  {
    const nI = crowdI.length / 12;
    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const A = new Float32Array(nI * 4), B = new Float32Array(nI * 4), Cc = new Float32Array(nI * 4);
    for (let i = 0; i < nI; i++) { for (let k = 0; k < 4; k++) { A[i * 4 + k] = crowdI[i * 12 + k]; B[i * 4 + k] = crowdI[i * 12 + 4 + k]; Cc[i * 4 + k] = crowdI[i * 12 + 8 + k]; } }
    base.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4));
    base.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 4));
    base.setAttribute('iC', new THREE.InstancedBufferAttribute(Cc, 4));
    base.instanceCount = nI;
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTex: { value: T.crowd }, uTime: { value: 0 }, uExcite: { value: 0.3 }, uHotSpray: { value: 0 }, uHot: { value: 0 },
      uLight: { value: LOOK.crowd }, uShade: { value: LOOK.crowdShade }, uFlash: { value: 0 }, uNight: { value: LOOK.night },
      uTint: { value: col(tod === 'dusk' ? '#ffe2c8' : tod === 'night' ? '#e6ecff' : weather === 'heat' ? '#fff0da' : '#ffffff') },
    }]);
    u.uTex.value = T.crowd;
    const mat = new THREE.ShaderMaterial({
      uniforms: u, fog: true, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 iA; attribute vec4 iB; attribute vec4 iC;
        uniform float uTime, uExcite, uHotSpray, uHot;
        varying vec2 vUv; varying float vPh; varying float vEx; varying float vKind; varying float vY;
        #include <common>
        #include <fog_pars_vertex>
        void main(){
          vec3 t = vec3(iB.x, 0.0, iB.y);
          float hot = uHot * exp(-pow((iC.z - uHotSpray) / 10.0, 2.0));
          float ex = clamp(uExcite + hot, 0.0, 1.6);
          float hop = max(0.0, sin(uTime * 7.3 + iC.y * 40.0)) * 0.45 * ex * ex;
          vec3 f = vec3(-t.z, 0.0, t.x);
          vec3 upv = normalize(vec3(0.0, 1.0, 0.0) - f * 0.85);
          vec3 p = iA.xyz + t * (position.x * iA.w) + upv * (position.y * (iB.z * 1.3 + hop));
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vUv = vec2(iC.x + uv.x * ${USPAN.toFixed(3)}, 1.0 - (iB.w + 1.0 - uv.y) / ${BANDS.toFixed(1)});
          vPh = iC.y; vEx = ex; vKind = iC.w; vY = uv.y;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uTime, uLight, uShade, uFlash, uNight; uniform vec3 uTint;
        varying vec2 vUv; varying float vPh; varying float vEx; varying float vKind; varying float vY;
        #include <common>
        #include <fog_pars_fragment>
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec2 uv = vUv;
          float colI = floor(uv.x * 10.0);
          float h = h21(vec2(colI, floor(vPh * 997.0)));
          float bob = max(0.0, sin(uTime * (5.0 + 4.0 * h) + h * 50.0)) * vEx;
          uv.y -= bob * 0.28 / ${BANDS.toFixed(1)};
          vec3 c = texture2D(uTex, uv).rgb;
          if (!gl_FrontFacing) c = c * 0.55 + vec3(0.02);
          float lit = mix(uLight, uShade, step(0.5, vKind));
          c *= lit * uTint * (1.0 + uFlash * 0.6) * (0.84 + 0.22 * fract(vPh * 7.13)) * mix(0.55, 1.0, smoothstep(0.0, 0.75, vY));
          float fl = step(0.9992 - 0.003 * vEx * uNight, h21(vec2(colI + vPh * 131.0, floor(uTime * 14.0))));
          c += fl * uNight * vec3(2.2);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    crowd = new THREE.Mesh(base, mat); crowd.frustumCulled = false; crowd.name = 'crowd';
    group.add(crowd); disposables.push(base, mat);
  }

  // ---- flags mesh
  let flagMesh = null;
  {
    const nx = 10, ny = 5, per = (nx + 1) * (ny + 1), N = flagSpecs.length;
    const pos = new Float32Array(N * per * 3), anc = new Float32Array(N * per * 3), loc = new Float32Array(N * per * 4), uv = new Float32Array(N * per * 2), idx = [];
    flagSpecs.forEach((f, k) => {
      const cu = (f.cell % 4) / 4, cv = 1 - (Math.floor(f.cell / 4) + 1) / 2;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const o = k * per + j * (nx + 1) + i;
        anc.set(f.a, o * 3); pos.set(f.a, o * 3);
        loc.set([i / nx, j / ny, f.w, f.h], o * 4);
        uv.set([cu + (i / nx) * 0.25, cv + (1 - j / ny) * 0.5], o * 2);
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = k * per + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aAnchor', new THREE.BufferAttribute(anc, 3));
    g.setAttribute('aLoc', new THREE.BufferAttribute(loc, 4)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const wd = dirXZ(wind.dir), strength = clamp(wind.mph / 18, 0, 1);
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTex: { value: null }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2(wd[0], wd[1]) }, uStr: { value: wind.mph < 2 ? 0 : 0.18 + 0.82 * strength }, uLight: { value: tod === 'day' ? 1.0 : 0.8 } }]);
    u.uTex.value = T.flags;
    const mat = new THREE.ShaderMaterial({
      uniforms: u, fog: true, side: THREE.DoubleSide, transparent: false,
      vertexShader: `
        attribute vec3 aAnchor; attribute vec4 aLoc;
        uniform float uTime, uStr; uniform vec2 uWind;
        varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_vertex>
        void main(){
          vec3 dir = normalize(vec3(uWind.x, 0.0, uWind.y));
          float droop = mix(1.05, 0.08, uStr);
          vec3 xa = normalize(dir * cos(droop) + vec3(0.0, -sin(droop), 0.0));
          vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), dir));
          vec3 ya = normalize(cross(xa, sd));
          if (ya.y > 0.0) ya = -ya;
          float ph = aAnchor.x * 0.13 + aAnchor.z * 0.07;
          float k = aLoc.x;
          float arg = k * 7.5 - uTime * (2.5 + 10.0 * uStr) + ph;
          float amp = (0.05 + 0.2 * uStr) * aLoc.w * k;
          vec3 p = aAnchor + xa * (k * aLoc.z) + ya * (aLoc.y * aLoc.w) + sd * sin(arg) * amp;
          p.y -= (1.0 - uStr) * k * k * aLoc.z * 0.25;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv; vSh = 0.78 + 0.22 * cos(arg);
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uLight;
        varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_fragment>
        void main(){
          vec4 c = texture2D(uTex, vUv);
          if (c.a < 0.4) discard;
          gl_FragColor = vec4(c.rgb * vSh * uLight * (gl_FrontFacing ? 1.0 : 0.8), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    flagMesh = new THREE.Mesh(g, mat); flagMesh.frustumCulled = false; flagMesh.name = 'flags';
    group.add(flagMesh); disposables.push(g, mat);
  }

  // ---- glare sprites + fireworks share one points shader
  const pointsMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 700 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec4 aCol; attribute float aSize; uniform float uScale; varying vec4 vC;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 480.0); vC = aCol; }`,
    fragmentShader: `
      varying vec4 vC;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.2); if (a <= 0.002) discard; gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  disposables.push(pointsMat);
  const scaleHook = (renderer, scene, camera) => {
    if (!camera.isPerspectiveCamera) return;
    const h = renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(_v2).y : 800;
    pointsMat.uniforms.uScale.value = h * 0.5 / Math.tan(camera.fov * 0.5 * D2R) / (camera.zoom ? 1 / camera.zoom : 1);
  };
  const _v2 = new THREE.Vector2();
  if (glare.length) {
    const n = glare.length / 8, pos = new Float32Array(n * 3), colA = new Float32Array(n * 4), size = new Float32Array(n);
    for (let i = 0; i < n; i++) { pos.set(glare.slice(i * 8, i * 8 + 3), i * 3); size[i] = glare[i * 8 + 3]; colA.set(glare.slice(i * 8 + 4, i * 8 + 8), i * 4); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(colA, 4)); g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const pts = new THREE.Points(g, pointsMat); pts.frustumCulled = false; pts.onBeforeRender = scaleHook; pts.name = 'glare'; pts.renderOrder = 5;
    group.add(pts); disposables.push(g);
  }

  // fireworks (Rate: every homer)
  const FW = (() => {
    const N = quality === 'high' ? 1800 : quality === 'medium' ? 1100 : 600;
    const pos = new Float32Array(N * 3), colA = new Float32Array(N * 4), size = new Float32Array(N);
    const vel = new Float32Array(N * 3), life = new Float32Array(N), maxL = new Float32Array(N), kind = new Uint8Array(N), rgb = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage), aCol = new THREE.BufferAttribute(colA, 4).setUsage(THREE.DynamicDrawUsage), aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', aPos); g.setAttribute('aCol', aCol); g.setAttribute('aSize', aSize);
    const pts = new THREE.Points(g, pointsMat); pts.frustumCulled = false; pts.onBeforeRender = scaleHook; pts.visible = false; pts.name = 'fireworks'; pts.renderOrder = 6;
    group.add(pts); disposables.push(g);
    let cursor = 0, active = 0; const queue = [];
    const PAL = [[1, 0.25, 0.2], [0.3, 0.55, 1], [1, 0.8, 0.3], [0.4, 1, 0.5], [1, 0.4, 0.9], [0.9, 0.95, 1], [1, 0.55, 0.15]];
    function spawn(k, x, y, z, vx, vy, vz, L, c, sz) {
      const i = cursor; cursor = (cursor + 1) % N;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
      life[i] = L; maxL[i] = L; kind[i] = k; rgb.set(c, i * 3); size[i] = sz;
    }
    function launch(delay, x, z) { queue.push({ at: delay, x, z }); }
    function update(dt) {
      for (let q = queue.length - 1; q >= 0; q--) {
        queue[q].at -= dt;
        if (queue[q].at <= 0) {
          const { x, z } = queue.splice(q, 1)[0];
          spawn(1, x, SB.h + 2, z, (R() - 0.5) * 14, 58 + R() * 16, (R() - 0.5) * 14, 0.7 + R() * 0.25, [1, 0.85, 0.6], 4.5);
        }
      }
      if (!queue.length && !active) { pts.visible = false; return; }
      pts.visible = true; active = 0;
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) { colA[i * 4 + 3] = 0; continue; }
        active++;
        life[i] -= dt;
        const k = kind[i];
        vel[i * 3 + 1] -= 32 * dt * (k === 1 ? 1 : 0.45);
        const drag = k === 2 ? Math.exp(-1.6 * dt) : 1; vel[i * 3] *= drag; vel[i * 3 + 1] *= drag; vel[i * 3 + 2] *= drag;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        const f = clamp(life[i] / maxL[i], 0, 1);
        let a = k === 1 ? 1 : k === 3 ? f * 0.6 : Math.pow(f, 0.7) * (0.75 + 0.25 * Math.sin(life[i] * 40 + i));
        colA[i * 4] = rgb[i * 3] * 2.2; colA[i * 4 + 1] = rgb[i * 3 + 1] * 2.2; colA[i * 4 + 2] = rgb[i * 3 + 2] * 2.2; colA[i * 4 + 3] = a;
        if (k === 1) {
          if (R() < 0.8) spawn(3, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], (R() - 0.5) * 6, -8, (R() - 0.5) * 6, 0.5, [1, 0.7, 0.4], 2.2);
          if (life[i] <= 0) { // burst
            const c = PAL[Math.floor(R() * PAL.length)], c2 = R() < 0.35 ? PAL[Math.floor(R() * PAL.length)] : c;
            const n = quality === 'low' ? 60 : 110, sp = 36 + R() * 18;
            for (let b = 0; b < n; b++) {
              const u = R() * 2 - 1, th = R() * Math.PI * 2, s = Math.sqrt(1 - u * u), v = sp * (0.85 + R() * 0.3);
              spawn(2, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], Math.cos(th) * s * v, u * v + 6, Math.sin(th) * s * v, 1.3 + R() * 0.8, b % 3 ? c : c2, 7);
            }
          }
        }
      }
      aPos.needsUpdate = aCol.needsUpdate = aSize.needsUpdate = true;
    }
    return { launch, update };
  })();

  // rain (drizzle)
  let rain = null;
  if (weather === 'drizzle') {
    const N = quality === 'high' ? 2600 : quality === 'medium' ? 1700 : 900;
    const seed = new Float32Array(N * 2 * 3), endA = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { const x = R(), y = R(), z = R(); seed.set([x, y, z, x, y, z], i * 6); endA[i * 2] = 0; endA[i * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(seed, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(endA, 1));
    const wd = dirXZ(wind.dir), wv = wind.mph * 1.466 * 0.8;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFall: { value: new THREE.Vector3(wd[0] * wv, -28, wd[1] * wv) }, uBox: { value: new THREE.Vector3(150, 90, 150) }, uCol: { value: col(tod === 'night' ? '#9fb2d6' : '#d4dbe4') } },
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute float aEnd; uniform float uTime; uniform vec3 uCam, uFall, uBox; varying float vA;
        void main(){
          vec3 p = position * uBox + uFall * uTime;
          vec3 o = uCam - uBox * 0.5; p = mod(p - o, uBox) + o;
          p -= uFall * 0.05 * aEnd;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          vA = (1.0 - aEnd * 0.8) * smoothstep(0.0, 8.0, -mv.z);
        }`,
      fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ gl_FragColor = vec4(uCol, 0.32 * vA);
        #include <colorspace_fragment>
      }`,
    });
    rain = new THREE.LineSegments(g, mat); rain.frustumCulled = false; rain.name = 'rain'; rain.renderOrder = 8;
    rain.onBeforeRender = (r, s, cam) => { cam.getWorldPosition(mat.uniforms.uCam.value); };
    group.add(rain); disposables.push(g, mat);
  }

  mark('sky');
  // ======================================================================
  // SKY dome (asset sky mapped by azimuth with mirror repeat + gradient dome)
  // ======================================================================
  let skySrc = null, horizonF = 0.8, skyBitmap = false;
  {
    const key = `sky_${parkId}_${tod}`, im = assetImage(key), meta = assetMeta(key);
    if (im) { skySrc = im; skyBitmap = typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap; horizonF = (meta && meta.horizon) || (isW ? 0.78 : 0.86); }
    else { skySrc = paintSky(parkId, tod); horizonF = 0.8; }
  }
  mark('sky_src');
  const skyAvg = (y0, y1) => { // average color of rows [y0,y1] (fractions)
    const c = mkCanvas(8, 4), g = c.getContext('2d', { willReadFrequently: true });
    const sw = skySrc.naturalWidth || skySrc.width, sh = skySrc.naturalHeight || skySrc.height;
    g.drawImage(skySrc, 0, sh * y0, sw, Math.max(1, sh * (y1 - y0)), 0, 0, 8, 4);
    const d = g.getImageData(0, 0, 8, 4).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`;
  };
  const topCol = skyAvg(0, 0.04), botCol = skyAvg(0.94, 1), horizCol = skyAvg(horizonF - 0.05, horizonF);
  mark('sky_avg');
  const VDPP = 0.0733; // vertical degrees per source pixel (at 878 px tall)
  const elTop = horizonF * 878 * VDPP, elBot = -(1 - horizonF) * 878 * VDPP;
  T.sky = tex(skySrc, { wrap: 'clamp', flipY: !skyBitmap });
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: T.sky }, uTop: { value: col(topCol) }, uBot: { value: col(botCol) }, uZen: { value: col(topCol).multiplyScalar(tod === 'day' ? 0.85 : 0.7) },
      uH: { value: horizonF }, uElTop: { value: elTop }, uElBot: { value: elBot }, uHaze: { value: col(LOOK.haze) }, uHazeAmt: { value: LOOK.hazeAmt },
      uDesat: { value: LOOK.skyDesat }, uBright: { value: LOOK.skyBright }, uDrift: { value: 0 },
      uFlip: { value: skyBitmap ? 1 : 0 }, uGlow: { value: tod === 'night' ? 0.42 : tod === 'dusk' ? 0.16 : 0 }, uGlowCol: { value: col(tod === 'night' ? '#9aa9d0' : '#ffd2a8') },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform sampler2D uSky; uniform vec3 uTop, uBot, uZen, uHaze; uniform float uH, uElTop, uElBot, uHazeAmt, uDesat, uBright, uDrift, uGlow, uFlip; uniform vec3 uGlowCol;
      varying vec3 vW;
      #include <common>
      void main(){
        vec3 d = normalize(vW - cameraPosition);
        float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
        float az = atan(d.x, -d.z) + uDrift;
        float u = az / PI + 0.5;
        u = 1.0 - abs(1.0 - mod(u, 2.0));
        float v; // 0 = top of image
        if (el >= 0.0) v = uH * (1.0 - el / uElTop); else v = uH + (1.0 - uH) * (el / uElBot);
        vec3 c;
        float tv = clamp(v, 0.002, 0.998); vec3 img = texture2D(uSky, vec2(clamp(u, 0.001, 0.999), uFlip > 0.5 ? tv : 1.0 - tv)).rgb;
        if (v < 0.0) { float t = clamp(-v / 0.35, 0.0, 1.0); c = mix(uTop, uZen, t); c = mix(img, c, smoothstep(0.0, 0.06, -v)); }
        else if (v > 1.0) c = uBot;
        else { c = img; c = mix(c, mix(uTop, uZen, 0.0), smoothstep(0.06, 0.0, v) * 0.5); }
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(c, vec3(l), uDesat) * uBright;
        c = mix(c, uHaze, uHazeAmt * (1.0 - smoothstep(0.0, 22.0, abs(el))) );
        c += uGlowCol * uGlow * exp(-max(el - 2.0, 0.0) / 6.5) * smoothstep(-6.0, 1.0, el);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  skyMat.toneMapped = false;
  mark('sky_mat');
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), skyMat);
  skyMesh.renderOrder = -1000; skyMesh.frustumCulled = false; skyMesh.name = 'sky';
  group.add(skyMesh); disposables.push(skyMesh.geometry, skyMat);

  mark('sky_mesh');
  // environment (equirect canvas → auto PMREM by three)
  let envTex = null;
  {
    const W = 256, H = 128, c = mkCanvas(W, H), g = c.getContext('2d');
    const rowOf = el => (90 - el) / 180 * H;
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, topCol); gr.addColorStop(rowOf(elTop) / H, topCol); gr.addColorStop(rowOf(0) / H, horizCol);
    const ground = tod === 'day' ? '#4a5a3c' : tod === 'dusk' ? '#3a3228' : '#12160f';
    gr.addColorStop(Math.min(0.99, rowOf(-6) / H), ground); gr.addColorStop(1, shade(ground, 0.6));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const y0 = rowOf(elTop), y1 = rowOf(elBot);
    // u: LF (-X) at 0/1, CF at .25, RF at .5, behind at .75 → image left→right over [0,.5], mirrored over [.5,1]
    g.drawImage(skySrc, 0, y0, W / 2, y1 - y0);
    g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(skySrc, 0, y0, W / 2, y1 - y0); g.restore();
    g.fillStyle = ground; g.globalAlpha = 0.85; g.fillRect(0, rowOf(-4), W, H); g.globalAlpha = 1;
    if (LOOK.lamps > 0) { g.fillStyle = 'rgba(255,250,235,0.9)'; for (let i = 0; i < 10; i++) { g.beginPath(); g.arc(i * W / 10 + 12, rowOf(24), 3, 0, 7); g.fill(); } }
    envTex = tex(c, { wrap: 'clamp', mips: false });
    envTex.mapping = THREE.EquirectangularReflectionMapping;
  }

  mark('lightsetup');
  // ======================================================================
  // LIGHTS
  // ======================================================================
  const toDir = (el, az) => new THREE.Vector3(Math.sin(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), -Math.cos(az * D2R) * Math.cos(el * D2R)).normalize();
  const sunDir = toDir(LOOK.keyEl, LOOK.keyAz);
  const key = new THREE.DirectionalLight(col(LOOK.keyColor), LOOK.keyI);
  const target = new THREE.Object3D(); target.position.set(0, 0, -170); group.add(target); key.target = target;
  key.position.copy(target.position).addScaledVector(sunDir, 900);
  key.castShadow = quality !== 'low';
  if (key.castShadow) {
    const sz = quality === 'high' ? 2048 : 1024; key.shadow.mapSize.set(sz, sz);
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.35; key.shadow.intensity = LOOK.shadowI;
    // fit an ortho frustum around the playing field in light space
    const m = new THREE.Matrix4().lookAt(key.position, target.position, new THREE.Vector3(0, 1, 0));
    m.setPosition(key.position); const inv = m.clone().invert();
    const v = new THREE.Vector3(); let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    for (const [x, z] of loop) for (const y of [0, 14]) { v.set(x, y, z).applyMatrix4(inv); mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x); mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y); mnz = Math.min(mnz, v.z); mxz = Math.max(mxz, v.z); }
    const cam = key.shadow.camera; cam.left = mnx - 4; cam.right = mxx + 4; cam.bottom = mny - 4; cam.top = mxy + 4; cam.near = Math.max(1, -mxz - 500); cam.far = -mnz + 60;
    cam.updateProjectionMatrix();
  }
  group.add(key);
  const hemi = new THREE.HemisphereLight(col(LOOK.hemiSky), col(LOOK.hemiGround), LOOK.hemiI); group.add(hemi);
  let rimLight = null;
  if (LOOK.rim) { rimLight = new THREE.DirectionalLight(col(LOOK.rim.color), LOOK.rim.i); rimLight.position.copy(toDir(LOOK.rim.el, LOOK.rim.az)).multiplyScalar(900); rimLight.target = target; group.add(rimLight); }

  mark('boarddraw');
  // ======================================================================
  // BOARD DRAWING
  // ======================================================================
  const board = { name: 'PLAYER', homers: 0, outs: 0, score: 0, lastFt: 0, message: 'WINDY CITY DERBY' };
  const cel = { t: -1, dur: 5.5, distance: 0, bonus: null, spray: 0 };
  let boardDirty = true, boardClock = 0, clockMin = { day: 13 * 60 + 20, dusk: 18 * 60 + 42, night: 20 * 60 + 5 }[tod], clockAcc = 0;
  function drawWrigleyBoard(t) {
    const g = bg, W = 1024, H = 320;
    g.fillStyle = '#1c4b2c'; g.fillRect(0, 0, W, 512);
    g.fillStyle = '#245a36'; for (let x = 0; x < W; x += 64) g.fillRect(x, 0, 2, H);
    g.strokeStyle = '#e9e5d3'; g.lineWidth = 5; g.strokeRect(6, 6, W - 12, H - 12);
    const slot = (x, y, w, h) => { g.fillStyle = '#0f2d19'; g.fillRect(x, y, w, h); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y, w, 4); };
    const cream = '#f4f1e5', yel = '#ffd34a';
    const celebrating = cel.t >= 0 && cel.t < cel.dur;
    // row 1: message
    slot(24, 20, W - 48, 70);
    let msg = board.message || 'WINDY CITY DERBY';
    if (celebrating) msg = (Math.floor(cel.t * 2.2) % 2 === 0) ? 'HOME RUN!' : `${Math.round(cel.distance)} FT`;
    const u1 = Math.min(7, (W - 80) / (msg.length * 6));
    blockText(g, msg, W / 2, 55 - 3.5 * u1, u1, celebrating ? yel : cream, 'center');
    // row 2: batter + HR
    blockText(g, 'BATTER', 34, 124, 3.4, '#bcd6bf');
    slot(150, 104, 520, 62); const nm = String(board.name || 'PLAYER').slice(0, 12); blockText(g, nm, 166, 114, Math.min(6, 500 / (nm.length * 6)), cream);
    blockText(g, 'HR', 730, 124, 3.4, '#bcd6bf'); slot(790, 104, 200, 62); blockText(g, String(board.homers | 0), 890, 114, 6, cream, 'center');
    // row 3: line-score style outs 1..10
    blockText(g, 'OUTS', 34, 206, 3.4, '#bcd6bf');
    for (let i = 0; i < 10; i++) {
      const x = 150 + i * 85; blockText(g, String(i + 1), x + 34, 180, 2.4, '#bcd6bf', 'center');
      slot(x + 6, 200, 58, 48); if (i < (board.outs | 0)) blockText(g, 'X', x + 35, 207, 4.8, cream, 'center');
    }
    // row 4: score + last
    blockText(g, 'SCORE', 34, 276, 3.4, '#bcd6bf'); slot(150, 262, 380, 50); blockText(g, fmtN(board.score).replace(/,/g, ','), 340, 270, 5, cream, 'center');
    blockText(g, 'LAST', 560, 276, 3.4, '#bcd6bf'); slot(650, 262, 340, 50); blockText(g, board.lastFt ? `${Math.round(board.lastFt)} FT` : '---', 820, 270, 5, cream, 'center');
    // clock face (0..192, 320..512)
    const cx = 96, cy = 416, rr = 90;
    g.fillStyle = '#1c4b2c'; g.fillRect(0, 320, 192, 192);
    g.fillStyle = '#f7f4ea'; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.fill();
    g.strokeStyle = '#1c4b2c'; g.lineWidth = 6; g.stroke();
    g.fillStyle = '#1a1a1a';
    for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6; g.fillRect(cx + Math.sin(a) * 72 - 4, cy - Math.cos(a) * 72 - 4, 8, 8); }
    const hh = (clockMin / 60) % 12, mm = clockMin % 60;
    const hand = (a, len, w) => { g.save(); g.translate(cx, cy); g.rotate(a); g.fillRect(-w / 2, -len, w, len + 10); g.restore(); };
    hand(hh / 12 * Math.PI * 2, 48, 9); hand(mm / 60 * Math.PI * 2, 70, 6);
    g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill();
  }
  function pinwheel(g, x, y, r, a, colors) {
    for (let k = 0; k < 8; k++) {
      const a0 = a + k * Math.PI / 4;
      g.fillStyle = colors[k % colors.length];
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      g.quadraticCurveTo(x + Math.cos(a0 + 0.5) * r * 0.9, y + Math.sin(a0 + 0.5) * r * 0.9, x + Math.cos(a0 + 0.78) * r * 0.35, y + Math.sin(a0 + 0.78) * r * 0.35);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, r * 0.1, 0, 7); g.fill();
  }
  const FONTV = '"Arial Black","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif';
  function drawVideoBoard(t) {
    const g = bg, W = 1024, H = 288;
    const celebrating = cel.t >= 0 && cel.t < cel.dur;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    if (celebrating) {
      const k = cel.t;
      const flash = Math.max(0, 1 - k * 2.5);
      const grd = g.createLinearGradient(0, 0, W, H);
      const hue = (k * 120) % 360;
      grd.addColorStop(0, `hsl(${hue},85%,${18 + flash * 60}%)`); grd.addColorStop(0.5, `hsl(${(hue + 60) % 360},90%,${10 + flash * 60}%)`); grd.addColorStop(1, `hsl(${(hue + 200) % 360},85%,${16 + flash * 60}%)`);
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      // radial burst rays
      g.save(); g.translate(W / 2, H / 2); g.rotate(k * 0.6);
      for (let i = 0; i < 24; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.02)'; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 700, i * Math.PI / 12, (i + 1) * Math.PI / 12); g.fill(); }
      g.restore();
      const pc = ['#ff3b3b', '#ffd23b', '#3bff7a', '#3bb4ff', '#b43bff', '#ff8a3b', '#ffffff', '#3bffe8'];
      pinwheel(g, 120, H / 2, 96, k * 7, pc); pinwheel(g, W - 120, H / 2, 96, -k * 7, pc);
      pinwheel(g, 250, 60, 34, -k * 9, pc); pinwheel(g, W - 250, H - 56, 34, k * 9, pc);
      const s = 1 + 0.12 * Math.sin(k * 9) * Math.exp(-k * 0.6);
      g.save(); g.translate(W / 2, H / 2 - 24); g.scale(s, s); g.textAlign = 'center';
      g.font = `900 104px ${FONTV}`; g.lineWidth = 10; g.strokeStyle = '#000'; g.strokeText('HOME RUN', 0, 0); g.fillStyle = '#ffffff'; g.fillText('HOME RUN', 0, 0);
      g.restore();
      g.textAlign = 'center'; g.font = `900 46px ${FONTV}`; g.fillStyle = '#ffe14d'; g.strokeStyle = '#000'; g.lineWidth = 6;
      const sub = cel.bonus && PK.bonus[cel.bonus] ? `${Math.round(cel.distance)} FT · ${PK.bonus[cel.bonus].label}` : `${Math.round(cel.distance)} FT`;
      g.strokeText(sub, W / 2, H / 2 + 62, W - 300); g.fillText(sub, W / 2, H / 2 + 62, W - 300);
      g.textAlign = 'left';
    } else {
      const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#0b0f17'); grd.addColorStop(1, '#141a25'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
      const sx = ((t * 160) % (W + 600)) - 300; const sw = g.createLinearGradient(sx - 200, 0, sx + 200, 0); sw.addColorStop(0, 'rgba(120,160,255,0)'); sw.addColorStop(0.5, 'rgba(120,160,255,0.10)'); sw.addColorStop(1, 'rgba(120,160,255,0)'); g.fillStyle = sw; g.fillRect(0, 0, W, H);
      // header
      const hg = g.createLinearGradient(0, 0, 0, 44); hg.addColorStop(0, '#e9eef4'); hg.addColorStop(1, '#9aa5b1'); g.fillStyle = hg; g.fillRect(0, 0, W, 44);
      g.fillStyle = '#0b0d10'; g.font = `900 28px ${FONTV}`; g.fillText('RATE FIELD', 18, 23); g.textAlign = 'right'; g.fillText('WINDY CITY DERBY', W - 18, 23); g.textAlign = 'left';
      // name block
      g.fillStyle = '#9fb0c4'; g.font = `800 22px ${FONTV}`; g.fillText('NOW BATTING', 26, 72);
      g.fillStyle = '#ffffff'; g.font = `900 64px ${FONTV}`; g.fillText(String(board.name || 'PLAYER').slice(0, 14), 24, 118, 296);
      pinwheel(g, 346, 104, 22, t * 1.4, ['#ffffff', '#8f9aa6', '#c9d1d9', '#4a5260']);
      // stat tiles
      const tiles = [['HR', String(board.homers | 0)], ['OUTS', `${board.outs | 0}/10`], ['SCORE', fmtN(board.score)], ['LAST', board.lastFt ? `${Math.round(board.lastFt)} FT` : '—']];
      const tw = [104, 128, 190, 180]; let tx = 1024 - tw.reduce((a, b) => a + b + 10, 0) - 2;
      tiles.forEach(([lab, val], i) => {
        g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(tx, 58, tw[i], 96);
        g.fillStyle = '#c9d1d9'; g.fillRect(tx, 58, tw[i], 4);
        g.fillStyle = '#9fb0c4'; g.font = `800 20px ${FONTV}`; g.fillText(lab, tx + 12, 80);
        g.fillStyle = '#ffffff'; g.font = `900 40px ${FONTV}`; g.fillText(val, tx + 12, 124, tw[i] - 20);
        tx += tw[i] + 10;
      });
      // outs dots
      for (let i = 0; i < 10; i++) { g.fillStyle = i < (board.outs | 0) ? '#ff4b3a' : 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(34 + i * 30, 170, 10, 0, 7); g.fill(); }
      // message ticker
      g.fillStyle = '#0d1a33'; g.fillRect(0, 200, W, 88); g.fillStyle = '#2f80ff'; g.fillRect(0, 200, W, 5);
      g.fillStyle = '#ffffff'; g.font = `900 50px ${FONTV}`; g.textAlign = 'center'; g.fillText(String(board.message || 'WINDY CITY DERBY').toUpperCase(), W / 2, 248, W - 60); g.textAlign = 'left';
    }
    // LED grid
    g.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  }
  function redrawBoard(t) { if (isW) drawWrigleyBoard(t); else drawVideoBoard(t); T.board.needsUpdate = true; boardDirty = false; }
  redrawBoard(0);

  mark('end');
  // ======================================================================
  // STATE + API
  // ======================================================================
  const crowdU = crowd.material.uniforms;
  let exciteTarget = 0.3, excite = 0.3, boost = 0, lastT = 0;
  const fogCol = col(LOOK.fog).lerp(col(horizCol), weather === 'clear' || weather === 'heat' ? 0.6 : 0.3);
  const fog = new THREE.FogExp2(fogCol, LOOK.fogD);
  const bgColor = fogCol.clone();
  const saved = { background: null, fog: null, environment: null, envI: 1, had: false };

  const api = {
    group, sunDir: sunDir.clone(), parkId, timeOfDay: tod, weather, quality,
    lights: { key, hemi, rim: rimLight },
    attach(scene) {
      if (!scene) return;
      if (!saved.had) { saved.background = scene.background; saved.fog = scene.fog; saved.environment = scene.environment; saved.envI = scene.environmentIntensity ?? 1; saved.had = true; }
      scene.add(group);
      scene.background = bgColor; scene.fog = fog; scene.environment = envTex;
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
      dt = clamp(+dt || 0, 0, 0.1); lastT = t;
      boost = Math.max(0, boost - dt);
      const tgt = Math.max(exciteTarget, boost > 0 ? 1.1 : 0);
      excite += (tgt - excite) * (1 - Math.exp(-dt * 3.5));
      crowdU.uTime.value = t; crowdU.uExcite.value = excite;
      crowdU.uHot.value = Math.max(0, crowdU.uHot.value - dt * 0.18);
      crowdU.uFlash.value = Math.max(0, crowdU.uFlash.value - dt * 1.6);
      flagMesh.material.uniforms.uTime.value = t;
      if (rain) rain.material.uniforms.uTime.value = t;
      if (ribbonTex) ribbonTex.offset.x = (t * 0.035) % 1;
      skyMat.uniforms.uDrift.value = t * 0.0006;
      FW.update(dt);
      // board animation cadence
      if (cel.t >= 0) { cel.t += dt; if (cel.t > cel.dur) { cel.t = -1; boardDirty = true; } }
      clockAcc += dt; if (clockAcc >= 60) { clockAcc -= 60; clockMin++; boardDirty = true; }
      boardClock += dt;
      const animating = cel.t >= 0 || !isW;
      const rate = cel.t >= 0 ? (isW ? 1 / 8 : 1 / 24) : 1 / 10;
      if (boardDirty || (animating && boardClock >= rate)) { boardClock = 0; redrawBoard(t); }
    },
    setBoard(s = {}) {
      for (const k of ['name', 'homers', 'outs', 'score', 'lastFt', 'message']) if (s[k] !== undefined && s[k] !== null) board[k] = s[k];
      boardDirty = true;
    },
    celebrate({ spray = 0, distance = 0, bonus = null } = {}) {
      cel.t = 0; cel.distance = +distance || 0; cel.bonus = bonus; cel.spray = +spray || 0; boardDirty = true;
      crowdU.uHotSpray.value = cel.spray; crowdU.uHot.value = 0.9; crowdU.uFlash.value = 1; boost = 4.5;
      if (!isW) {
        const n = quality === 'low' ? 5 : 9, r = scoreboardDistance(parkId, 0) + 6;
        for (let i = 0; i < n; i++) { const s = (i / (n - 1) - 0.5) * 2 * (SB.spray[1] - 1), [x, , z] = polar(s, r + R() * 6); FW.launch(i * 0.28 + R() * 0.15, x, z); }
        for (let i = 0; i < Math.ceil(n / 2); i++) { const [x, , z] = polar((R() - 0.5) * 12, r); FW.launch(2.4 + i * 0.35, x, z); }
      }
    },
    setCrowd(level) { exciteTarget = clamp(+level || 0, 0, 1); },
    info() {
      let tris = 0, calls = 0;
      group.traverse(o => { if (o.isMesh || o.isPoints || o.isLineSegments) { calls++; const g = o.geometry; const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3; tris += o.isInstancedMesh || g.isInstancedBufferGeometry ? n * (g.instanceCount || 1) : n; } });
      const timing = {}; for (let i = 1; i < TM.length; i++) timing[TM[i - 1][0]] = Math.round(TM[i][1] - TM[i - 1][1]);
      return { timing, calls, tris: Math.round(tris), crowd: crowdI.length / 12, flags: flagSpecs.length, skyAsset: !!assetImage(`sky_${parkId}_${tod}`), crowdAsset: T.crowdReal };
    },
    dispose() {
      for (const d of disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
      group.clear();
    },
  };
  return api;
}
