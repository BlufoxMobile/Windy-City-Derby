// ============================================================================
// WINDY CITY DERBY — RATE FIELD (South Side, 333 W. 35th St.).  Owner: RATE agent.
//   buildRateStadium(THREE, { parkId:'rate', timeOfDay, weather, wind, assets, quality }) → Stadium
// Stadium (CONTRACT.md + CONTRACT-v2.md):
//   attach(scene), detach(scene), update(dt,t), setBoard({name,homers,outs,score,lastFt,message[,charId]}),
//   celebrate({spray,distance,bonus}), setCrowd(level), wave({fromSpray,laps}) → s,
//   outOfPark({spray,distance,landing,bonus}), landmarks{booth,street,boards,...}, crowd, lights, sunDir,
//   info(), dispose(), group
// Everything is built procedurally from src/data.js (PARKS.rate — frozen v2 geometry) so the
// mesh sits exactly on fenceDistance()/surfaceHeight()/scoreboardDistance()/videoBoards/fanDeck.
// Identifiers (scratch/research/parks.md, in rank order): the 134x60 ft CF video board with the
// row of PINWHEELS on top + fireworks; the flat black-truss roof over the steep 500 level that
// stops at the foul poles; the tiered ivy batter's eye + two-level Fan Deck; the dark-green 8 ft
// wall + all-green bowl; the open outfield concourse; light towers + Dan Ryan traffic.
// Optional art (assets/parks/rate/*, see scratch/rate/manifest-add.json) — all have fallbacks.
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
const PARK = 'rate';

// Visual-only configuration (the sim's geometry lives in data.js).
const CFG = {
  foul: { near: 48, pole: 22, backstop: 62 },   // foul-territory wall: offset from the line at home / at the pole; backstop radius
  wallH: 5,                                     // padded field wall along the lines
  poleH: 84,
  grass: '#3b7b34', grassB: '#4d9442', dirt: '#9a5a38', dirtDark: '#7a4429', track: '#86573e', chalk: '#f5f4ee',
  stripeW: 16,
  seat: '#1f4a2f', seatHi: '#2c6340', concrete: '#8a8a84', concreteDk: '#5f605c', steel: '#151515', steelHi: '#2a2c2e',
  wall: '#1E3F2E', precast: '#D9D6CC', concourse: '#6E6E68', eyeIvy: '#2F5A2A', frame: '#0D0D0D',
  // CF bearing ≈ 120° (ESE): spray s ↔ compass bearing 120 + s. North = spray −120.
  bearing: 120,
};
// compass unit vectors in world XZ
const COMPASS = (() => { const v = b => dirXZ(b - CFG.bearing); return { N: v(0), E: v(90), S: v(180), W: v(270) }; })();

// ---------------------------------------------------------------------------
// Time-of-day / weather look. Day = flat hazy summer light; night = white LED.
// ---------------------------------------------------------------------------
function makeLook(tod, weather) {
  const L = {
    day: {
      keyEl: 57, keyAz: 104, keyColor: '#fff4e2', keyI: 2.75, shadowI: 0.92,
      rim: null, hemiSky: '#c9dcf2', hemiGround: '#5d6446', hemiI: 0.72, envI: 0.62,
      fog: '#c9d6e2', fogD: 0.00030, lamps: 0.15, glare: 0, crowd: 1.0, crowdShade: 0.6, windows: 0.06,
      skyBright: 1, skyDesat: 0.08, haze: '#dde6ee', hazeAmt: 0.16, night: 0, boardGain: 0.9, fieldLux: 1,
    },
    dusk: {
      keyEl: 54, keyAz: 168, keyColor: '#fff0dc', keyI: 1.95, shadowI: 0.7,
      rim: { el: 7, az: 176, color: '#ff9a52', i: 1.35 }, hemiSky: '#9a86b0', hemiGround: '#3a3230', hemiI: 0.5, envI: 0.45,
      fog: '#b9909a', fogD: 0.00034, lamps: 2.6, glare: 0.6, crowd: 0.78, crowdShade: 0.5, windows: 0.65,
      skyBright: 1, skyDesat: 0, haze: '#e8a58c', hazeAmt: 0.08, night: 0.4, boardGain: 1.15, fieldLux: 1,
    },
    night: {
      keyEl: 58, keyAz: 176, keyColor: '#f2f5ff', keyI: 2.2, shadowI: 0.7,
      rim: { el: 34, az: 18, color: '#dfe6ff', i: 0.62 }, hemiSky: '#4a5a86', hemiGround: '#1c2218', hemiI: 0.4, envI: 0.42,
      fog: '#0d1424', fogD: 0.00024, lamps: 5.2, glare: 1, crowd: 0.62, crowdShade: 0.44, windows: 1.0,
      skyBright: 1, skyDesat: 0, haze: '#1b2748', hazeAmt: 0.05, night: 1, boardGain: 1.3, fieldLux: 1,
    },
  }[tod];
  L.wet = 0; L.dry = 0;
  const W = WEATHER[weather] || WEATHER.clear;
  L.fogD = L.fogD + W.fog * (tod === 'night' ? 0.0020 : 0.0028);
  if (weather === 'overcast') {
    L.keyI *= tod === 'day' ? 0.45 : tod === 'dusk' ? 0.55 : 0.85; L.shadowI *= 0.4; L.hemiI *= 1.8; L.envI *= 1.25;
    L.keyColor = tod === 'dusk' ? '#e8d2c4' : '#eef1f5'; L.hemiSky = tod === 'night' ? '#39435c' : '#b7bec8';
    L.fog = tod === 'night' ? '#1a2030' : tod === 'dusk' ? '#8f8a8a' : '#b3bac2';
    L.skyDesat = 0.72; L.skyBright = 0.86; L.haze = L.fog; L.hazeAmt = 0.3;
    if (L.rim) L.rim.i *= 0.4;
  } else if (weather === 'heat') {
    L.keyColor = tod === 'night' ? '#fff0dc' : tod === 'dusk' ? '#ffb877' : '#ffe2b8'; L.keyI *= 1.06;
    if (tod !== 'night') L.hemiSky = tod === 'dusk' ? '#c7948a' : '#eadcc4';
    L.fog = tod === 'night' ? '#2a2430' : tod === 'dusk' ? '#d99f80' : '#e4d6bc';
    L.haze = tod === 'night' ? '#3a2e36' : tod === 'dusk' ? '#f0b48c' : '#f2dcb8'; L.hazeAmt = 0.5; L.skyDesat = 0.28; L.skyBright = 1.04;
    L.dry = 1; L.fogD += 0.0007; L.hemiI *= 1.08;
  } else if (weather === 'drizzle') {
    L.keyI *= tod === 'day' ? 0.34 : 0.7; L.shadowI *= 0.3; L.hemiI *= 1.9; L.envI *= 1.2;
    L.keyColor = '#ecebe6'; L.hemiSky = tod === 'night' ? '#343a4c' : '#adb0b2';
    L.fog = tod === 'night' ? '#171b25' : tod === 'dusk' ? '#716d70' : '#90969b';
    L.skyDesat = 0.85; L.skyBright = 0.72; L.haze = L.fog; L.hazeAmt = 0.45; L.wet = 1;
    L.crowd *= 0.9; if (L.rim) L.rim.i *= 0.25;
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
const FONT = '"Arial Black","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif';
const fmtN = n => Math.round(+n || 0).toLocaleString('en-US');

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

// dense clipped hedge / ivy (batter's eye). Tileable 512².
function hedgeCanvas() {
  return cached('hedge', () => {
    const S = 512, c = mkCanvas(S, S), g = c.getContext('2d'); const r = makeRng('hedge');
    g.fillStyle = '#14260f'; g.fillRect(0, 0, S, S);
    const greens = ['#2c5626', '#33612b', '#3b6d30', '#284f22', '#447a36', '#22461d', '#37672e', '#4f8740', '#2f5a28'];
    const leaf = (x, y, s, rot, col) => {
      g.save(); g.translate(x, y); g.rotate(rot); g.scale(s, s * 0.62);
      g.fillStyle = 'rgba(0,0,0,0.28)'; g.beginPath(); g.ellipse(0.18, 0.28, 1, 1, 0, 0, 7); g.fill();
      g.fillStyle = col; g.beginPath(); g.ellipse(0, 0, 1, 1, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,230,0.10)'; g.beginPath(); g.ellipse(-0.25, -0.3, 0.55, 0.4, 0, 0, 7); g.fill();
      g.restore();
    };
    for (let k = 0; k < 9000; k++) {
      const x = r() * S, y = r() * S, s = 4 + r() * 5.5, rot = r() * Math.PI;
      const col = pick(r, greens);
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        if (x + ox < -12 || x + ox > S + 12 || y + oy < -12 || y + oy > S + 12) continue;
        leaf(x + ox, y + oy, s, rot, col);
      }
    }
    // clumps: large-scale light/dark variation
    for (let k = 0; k < 40; k++) {
      const x = r() * S, y = r() * S, rr = 30 + r() * 60;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rr);
        const a = r() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(170,220,120,0.07)';
        gr.addColorStop(0, a); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x + ox - rr, y + oy - rr, rr * 2, rr * 2);
      }
    }
    return c;
  });
}
// padded outfield wall: 8 ft pads, seams every 5 ft. u tile = 20 ft (4 pads), v = 0 bottom … 1 top.
function padsCanvas() {
  return cached('pads', () => {
    const W = 512, H = 128, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('pads');
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#2a5540'); gr.addColorStop(0.08, '#21473a'); gr.addColorStop(0.5, '#1e4032'); gr.addColorStop(0.92, '#1a372b'); gr.addColorStop(1, '#10241b');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 4; i++) {
      const x = i * W / 4;
      const sg = g.createLinearGradient(x, 0, x + W / 4, 0);
      sg.addColorStop(0, 'rgba(0,0,0,0.35)'); sg.addColorStop(0.04, 'rgba(0,0,0,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,0.035)'); sg.addColorStop(0.96, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.3)');
      g.fillStyle = sg; g.fillRect(x, 0, W / 4, H);
      g.fillStyle = '#0b1a13'; g.fillRect(x, 0, 2, H);
    }
    // vinyl scuffs + ball marks
    for (let k = 0; k < 120; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '200,220,210'},${0.03 + r() * 0.05})`; g.beginPath(); g.ellipse(r() * W, H * (0.2 + r() * 0.7), 2 + r() * 6, 1 + r() * 3, r() * 3, 0, 7); g.fill(); }
    g.fillStyle = '#0e1c16'; g.fillRect(0, 0, W, 5);                       // top cap edge
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 5, W, 2);
    return c;
  });
}
// stadium seats: tile = 28 ft along the row (16 seats). canvas top = seat back, middle = pan, bottom = concrete
function seatsCanvas() {
  return cached('seats', () => {
    const W = 1024, H = 64, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('seats');
    const sw = W / 16;
    g.fillStyle = '#5d5e5a'; g.fillRect(0, 0, W, H);                       // concrete showing between seats
    for (let i = 0; i < 16; i++) {
      const x = i * sw, fade = 0.9 + r() * 0.2;
      g.fillStyle = shade(CFG.seat, fade); g.fillRect(x + 3, 0, sw - 6, H * 0.52);                 // back
      g.fillStyle = shade(CFG.seatHi, fade * 1.05); g.fillRect(x + 3, 0, sw - 6, H * 0.07);        // back top highlight
      g.fillStyle = shade(CFG.seat, fade * 0.8); g.fillRect(x + 5, H * 0.56, sw - 10, H * 0.3);    // pan
      g.fillStyle = '#1b1d1c'; g.fillRect(x, H * 0.5, 3, H * 0.4);                                 // arm rests
    }
    return c;
  });
}
// tinted suite / press-box glass. lit = emissive interior (night). tile 24 ft x 12 ft, 6 panes
function glassCanvas(lit) {
  return cached('glass' + (lit ? 'L' : ''), () => {
    const W = 256, H = 128, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('glass' + (lit ? 'L' : ''));
    const n = 6, pw = W / n;
    if (!lit) {
      const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#5d7486'); gr.addColorStop(0.35, '#2c3b47'); gr.addColorStop(1, '#141b21');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      for (let i = 0; i < n; i++) { g.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.18})`; g.fillRect(i * pw + 3, H * 0.55, pw - 6, H * 0.45); g.fillStyle = 'rgba(210,225,240,0.10)'; g.fillRect(i * pw + 3, 4, pw - 6, H * 0.12); }
      g.fillStyle = 'rgba(220,235,250,0.08)'; g.beginPath(); g.moveTo(W * 0.1, 0); g.lineTo(W * 0.45, 0); g.lineTo(W * 0.2, H); g.lineTo(0, H); g.fill();
    } else {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        const on = r() > 0.1, cool = r() < 0.35;
        if (!on) continue;
        const gr = g.createLinearGradient(0, 0, 0, H);
        gr.addColorStop(0, cool ? 'rgba(235,242,255,0.95)' : 'rgba(255,238,210,0.95)'); gr.addColorStop(0.14, cool ? 'rgba(150,165,190,0.45)' : 'rgba(165,150,130,0.4)'); gr.addColorStop(1, 'rgba(22,26,32,0.25)');
        g.fillStyle = gr; g.fillRect(i * pw + 2, 3, pw - 4, H - 6);
        g.fillStyle = 'rgba(0,0,0,0.6)';
        for (let k = 0; k < 3; k++) if (r() < 0.55) { const x = i * pw + 6 + r() * (pw - 18); g.beginPath(); g.ellipse(x + 5, H * 0.56, 4.5, 5.5, 0, 0, 7); g.fill(); g.fillRect(x - 1, H * 0.64, 12, H * 0.36); }
        if (r() < 0.3) { g.fillStyle = 'rgba(120,170,255,0.8)'; g.fillRect(i * pw + pw * 0.3, H * 0.22, pw * 0.4, H * 0.16); }
      }
    }
    g.fillStyle = lit ? '#000' : '#0b0d0f';
    for (let i = 0; i <= n; i++) g.fillRect(i * pw - 1.5, 0, 3, H);    // mullions
    g.fillRect(0, 0, W, 4); g.fillRect(0, H - 4, W, 4); g.fillRect(0, H * 0.72, W, 2);
    return c;
  });
}
// the gray/white precast exterior (atlas of 4 variants, 512x512 each = 40 x 40 ft):
// 0 ground-level arcade, 1 solid precast with a row of windows, 2 banded ramp level, 3 black steel screen + fins
function precastCanvas(lit, art = null) {
  return cached('precast' + (lit ? 'L' : '') + (art ? 'A' : ''), () => {
    const W = 512, VH = 512, c = mkCanvas(W, VH * 4), g = c.getContext('2d'); const r = makeRng('precast');
    g.fillStyle = lit ? '#000' : CFG.precast; g.fillRect(0, 0, W, VH * 4);
    const grain = y0 => { for (let q = 0; q < 1100; q++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${r() * 0.05})`; g.fillRect(r() * W, y0 + r() * VH, 3, 3); } };
    const px = f => f * VH / 40;             // ft → px
    // 0: arcade — two tall arches per 40 ft, piers, cornice (art: assets/parks/rate/rate_precast.webp)
    if (art) {
      if (!lit) g.drawImage(art, 0, 0, W, VH);
      else { // night: the dark concourse behind the arches / windows glows warm
        const t = mkCanvas(W, VH), tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(art, 0, 0, W, VH);
        const d = tg.getImageData(0, 0, W, VH), a = d.data;
        for (let i = 0; i < a.length; i += 4) {
          const l = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) / 255, k = clamp((0.34 - l) / 0.22, 0, 1);
          a[i] = 255 * k * 0.85; a[i + 1] = 205 * k * 0.85; a[i + 2] = 150 * k * 0.85; a[i + 3] = 255;
        }
        g.putImageData(d, 0, 0);
      }
    } else { const y0 = 0;
      if (!lit) { grain(y0); g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(0, y0 + px(4), W, 3); g.fillStyle = '#c9c5ba'; g.fillRect(0, y0, W, px(3.2)); }
      for (let i = 0; i < 2; i++) {
        const cx = (i + 0.5) * W / 2, hw = px(7), top = y0 + px(9), base = y0 + VH;
        g.fillStyle = lit ? `rgba(255,${210 + r() * 25},${160 + r() * 40},0.8)` : '#20252a';
        g.beginPath(); g.moveTo(cx - hw, base); g.lineTo(cx - hw, top + hw); g.arc(cx, top + hw, hw, Math.PI, 0); g.lineTo(cx + hw, base); g.fill();
        if (!lit) { g.strokeStyle = '#b3aea3'; g.lineWidth = 7; g.stroke(); g.fillStyle = '#121212'; g.fillRect(cx - hw, top + hw + px(6), hw * 2, 5); g.fillStyle = 'rgba(120,130,140,0.25)'; g.fillRect(cx - hw + 6, top + hw + px(7), hw * 2 - 12, px(18)); }
      }
    }
    // 1: solid precast, horizontal reveals, one row of square windows
    { const y0 = VH;
      if (!lit) { grain(y0); g.fillStyle = 'rgba(0,0,0,0.11)'; for (let y = 0; y < VH; y += px(8)) g.fillRect(0, y0 + y, W, 3); }
      for (let i = 0; i < 4; i++) { g.fillStyle = lit ? (r() < 0.7 ? 'rgba(255,225,180,0.7)' : 'rgba(0,0,0,0)') : '#2a3036'; g.fillRect(i * W / 4 + px(2.5), y0 + px(15), px(5), px(6)); }
    }
    // 2: ramp level — deep horizontal openings with railings
    { const y0 = VH * 2;
      if (!lit) grain(y0);
      for (let k = 0; k < 3; k++) { const y = y0 + px(3 + k * 13); g.fillStyle = lit ? 'rgba(255,230,190,0.45)' : '#2b3035'; g.fillRect(0, y, W, px(6)); if (!lit) { g.fillStyle = '#151515'; g.fillRect(0, y + px(3.2), W, 3); for (let x = 0; x < W; x += 16) g.fillRect(x, y + px(3.2), 2, px(2.8)); } }
    }
    // 3: upper exterior — black steel screen with vertical fins
    { const y0 = VH * 3;
      if (!lit) { g.fillStyle = '#1b1d1f'; g.fillRect(0, y0, W, VH); g.fillStyle = '#34373a'; for (let x = 0; x < W; x += 32) g.fillRect(x, y0, 5, VH); g.fillStyle = 'rgba(255,255,255,0.05)'; for (let y = 0; y < VH; y += 6) g.fillRect(0, y0 + y, W, 1); g.fillStyle = '#c9c5ba'; g.fillRect(0, y0 + VH - px(2.5), W, px(2.5)); }
    }
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
    g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(96,104,100,1)'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(S, S); g.moveTo(S, 0); g.lineTo(0, S); g.stroke();
    return c;
  });
}
// black-and-white wind screen behind the last row of the 500 level
function screenCanvas() {
  return cached('screen', () => {
    const W = 256, H = 64, c = mkCanvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#e9e9e4'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#151515'; g.fillRect(0, 0, W, 6); g.fillRect(0, H - 10, W, 10);
    for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 4, H);
    g.fillStyle = 'rgba(0,0,0,0.08)'; for (let y = 8; y < H - 10; y += 4) g.fillRect(0, y, W, 1);
    return c;
  });
}
// concession fronts atlas: 4 x 4 cells (menu boards, shutters, fictional stands). lit variant = emissive.
const STANDS = ['SOUTH SIDE DOGS', '35TH ST GRILL', 'BLUFOX MOBILE', 'BRIDGEPORT BREWS', 'POLISH & FRIES', 'ELOTE', 'TACO STAND', 'NACHOS', 'ICE CREAM', 'CRAFT BEER', 'BBQ PIT', 'PIZZA', 'LEMONADE', 'KETTLE CORN', 'THE PATIO', 'KIDS ZONE'];
function standsCanvas(lit) {
  return cached('stands' + (lit ? 'L' : ''), () => {
    const W = 1024, H = 512, cw = W / 4, ch = H / 4, c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('stands');
    g.fillStyle = lit ? '#000' : '#1a1c1e'; g.fillRect(0, 0, W, H);
    const signCols = ['#b31b1b', '#0d3a9a', '#e0a100', '#1d6b3a', '#c45a12', '#5a1d8a', '#0f7f8f', '#8a1d4a'];
    STANDS.forEach((name, i) => {
      const x = (i % 4) * cw, y = Math.floor(i / 4) * ch, blu = name.startsWith('BLUFOX');
      const sc = blu ? '#0d3a9a' : signCols[i % signCols.length];
      if (!lit) {
        g.fillStyle = '#2a2d31'; g.fillRect(x + 2, y + 2, cw - 4, ch - 4);
        g.fillStyle = sc; g.fillRect(x + 6, y + 6, cw - 12, ch * 0.28);
        g.fillStyle = '#fff'; g.font = `900 ${Math.round(ch * 0.17)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(name, x + cw / 2, y + 6 + ch * 0.14, cw - 24);
        g.fillStyle = '#0f1113'; g.fillRect(x + 10, y + ch * 0.4, cw - 20, ch * 0.2);                 // menu board
        g.fillStyle = 'rgba(255,255,255,0.55)'; for (let k = 0; k < 6; k++) g.fillRect(x + 16 + k * (cw - 32) / 6, y + ch * 0.44, (cw - 32) / 6 - 8, ch * 0.12);
        g.fillStyle = '#9ea3a8'; g.fillRect(x + 8, y + ch * 0.64, cw - 16, ch * 0.05);                 // counter
        g.fillStyle = '#50565c'; g.fillRect(x + 8, y + ch * 0.69, cw - 16, ch * 0.29);
        if (blu) { g.fillStyle = '#ff8a1f'; g.fillRect(x + 6, y + 6 + ch * 0.28 - 5, cw - 12, 5); }
      } else {
        g.fillStyle = sc; g.globalAlpha = 0.95; g.fillRect(x + 6, y + 6, cw - 12, ch * 0.28); g.globalAlpha = 1;
        g.fillStyle = '#fff'; g.font = `900 ${Math.round(ch * 0.17)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(name, x + cw / 2, y + 6 + ch * 0.14, cw - 24);
        g.fillStyle = 'rgba(255,245,225,0.9)'; g.fillRect(x + 10, y + ch * 0.4, cw - 20, ch * 0.2);
        g.fillStyle = `rgba(255,${200 + r() * 40},150,0.55)`; g.fillRect(x + 8, y + ch * 0.64, cw - 16, ch * 0.34);
      }
    });
    g.textAlign = 'left';
    return c;
  });
}
// city facades: 4 variants stacked, each 512x512 = 40 ft x 52 ft. lit → emissive windows.
// 0 red-brick two-flat (Bridgeport), 1 greystone / tan brick, 2 mid-rise brick apartments, 3 glass/concrete tower
function facadeCanvas(lit) {
  return cached('facade' + (lit ? 'L' : ''), () => {
    const W = 512, VH = 512, c = mkCanvas(W, VH * 4), g = c.getContext('2d'); const r = makeRng('facade');
    const vars = [{ wall: '#8a3f2c', trim: '#d8cfbd', win: '#1f2a33' }, { wall: '#a58e6e', trim: '#ede3cf', win: '#232b31' }, { wall: '#7b4b36', trim: '#cfc6b4', win: '#1e262c' }, { wall: '#9ea4a8', trim: '#c8cdd0', win: '#34506a' }];
    if (lit) { g.fillStyle = '#000'; g.fillRect(0, 0, W, VH * 4); }
    vars.forEach((v, k) => {
      const y0 = k * VH, fl = VH / 5;
      if (!lit) {
        g.fillStyle = v.wall; g.fillRect(0, y0, W, VH);
        for (let q = 0; q < 1400; q++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,230,210'},${r() * 0.07})`; g.fillRect(r() * W, y0 + r() * VH, 4, 2); }
        g.fillStyle = v.trim; g.fillRect(0, y0, W, VH * 0.03);
      }
      for (let f = 0; f < 5; f++) {
        const fy = y0 + f * fl;
        if (k === 3) {
          if (!lit) { g.fillStyle = v.win; g.fillRect(0, fy + fl * 0.12, W, fl * 0.62); g.fillStyle = 'rgba(200,220,240,0.18)'; g.fillRect(0, fy + fl * 0.12, W, fl * 0.2); g.fillStyle = v.trim; for (let x = 0; x < W; x += 51) g.fillRect(x, fy, 5, fl); }
          else for (let x = 0; x < W; x += 51) if (r() < 0.5) { g.fillStyle = r() < 0.6 ? '#ffe2a8' : '#dfe8ff'; g.globalAlpha = 0.45 + r() * 0.5; g.fillRect(x + 6, fy + fl * 0.14, 42, fl * 0.58); g.globalAlpha = 1; }
          continue;
        }
        const nW = k === 2 ? 6 : 4, ww = W / nW;
        for (let i = 0; i < nW; i++) {
          const wx = i * ww + ww * 0.22, wy = fy + fl * 0.2, wwid = ww * 0.56, wh = fl * 0.58;
          if (!lit) {
            g.fillStyle = v.trim; g.fillRect(wx - 4, wy - 6, wwid + 8, wh + 10);
            g.fillStyle = v.win; g.fillRect(wx, wy, wwid, wh);
            g.fillStyle = 'rgba(160,190,220,0.16)'; g.fillRect(wx, wy, wwid, wh * 0.42);
            g.fillStyle = v.trim; g.fillRect(wx + wwid / 2 - 2, wy, 4, wh);
          } else if (r() < 0.55) {
            g.fillStyle = r() < 0.78 ? '#ffd48f' : '#cfe0ff'; g.globalAlpha = 0.4 + r() * 0.6; g.fillRect(wx, wy, wwid, wh); g.globalAlpha = 1;
          }
        }
      }
    });
    return c;
  });
}
// LED ribbon (scrolls). 2048 x 64
function ribbonCanvas() {
  return cached('ribbon', () => {
    const W = 2048, H = 64, c = mkCanvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#040506'; g.fillRect(0, 0, W, H);
    const items = [['BLUFOX MOBILE', '#ffffff', '#1d5bd8'], ['WINDY CITY DERBY', '#ffffff', null], ['SOUTH SIDE', '#dfe6ee', null], ['RATE FIELD', '#ffffff', null], ['35TH STREET', '#c9d1d9', null], ['SWING FOR THE FENCES', '#ffffff', null], ['BLUFOX MOBILE', '#ffffff', '#1d5bd8'], ['GO GO GO', '#f4f5f7', null]];
    let x = 20; g.font = `900 40px ${FONT}`; g.textBaseline = 'middle';
    for (const [t, fg, bgc] of items) {
      const w = g.measureText(t).width;
      if (bgc) { g.fillStyle = bgc; g.fillRect(x - 12, 6, w + 24, H - 12); g.fillStyle = '#ff8a1f'; g.fillRect(x - 12, H - 12, w + 24, 5); }
      g.fillStyle = fg; g.fillText(t, x, 34); x += w + 34;
      g.fillStyle = '#6f7c8c'; g.beginPath(); g.moveTo(x - 20, 24); g.lineTo(x - 8, 32); g.lineTo(x - 20, 40); g.fill(); x += 16;
      if (x > W - 200) break;
    }
    g.fillStyle = 'rgba(0,0,0,0.4)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    for (let xx = 0; xx < W; xx += 3) g.fillRect(xx, 0, 1, H);
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
// Fallback sky (procedural gradient + clouds + a hazy downtown skyline on the right half for the
// north window). 2048 x 878 like the art skies (horizon at 0.86).
function paintSky(tod, W = 2048, H = 878) {
  return cached('sky_rate_' + tod, () => {
    const c = mkCanvas(W, H), g = c.getContext('2d'); const r = makeRng('skyrate' + tod);
    const hz = Math.round(H * 0.86);
    const pal = { day: ['#2a66c8', '#4a8ad8', '#9cc2ea', '#dbe8f3'], dusk: ['#23244f', '#5b3d7e', '#d0617e', '#ffb35e'], night: ['#03060e', '#081228', '#13234a', '#2e3a5e'] }[tod];
    let gr = g.createLinearGradient(0, 0, 0, hz);
    gr.addColorStop(0, pal[0]); gr.addColorStop(0.5, pal[1]); gr.addColorStop(0.85, pal[2]); gr.addColorStop(1, pal[3]);
    g.fillStyle = gr; g.fillRect(0, 0, W, hz);
    if (tod === 'night') for (let k = 0; k < 1000; k++) { const y = r() * hz * 0.85, a = (0.25 + r() * 0.75) * (1 - y / hz * 0.8); g.fillStyle = `rgba(255,255,255,${a})`; g.fillRect(r() * W, y, r() < 0.06 ? 2 : 1, r() < 0.06 ? 2 : 1); }
    const cloud = (cx, cy, w, top, base) => {
      const n = 9 + Math.floor(r() * 9);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = cx + (t - 0.5) * w, rr = w * (0.09 + 0.15 * Math.sin(Math.PI * t) * (0.6 + r() * 0.6)), y = cy - rr * 0.6;
        const q = g.createLinearGradient(0, y - rr, 0, cy); q.addColorStop(0, top); q.addColorStop(1, base);
        g.fillStyle = q; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
      }
    };
    if (tod === 'day') for (let k = 0; k < 24; k++) { const cy = hz * (0.25 + r() * 0.6); cloud(r() * W, cy, (110 + r() * 220) * (0.45 + cy / hz * 0.7), '#ffffff', '#b2c1d4'); }
    else for (let k = 0; k < 22; k++) { const cy = hz * (0.2 + r() * 0.62); g.fillStyle = tod === 'dusk' ? `rgba(${200 + r() * 55},${90 + r() * 60},${110 + r() * 40},0.7)` : 'rgba(40,52,84,0.7)'; g.beginPath(); g.ellipse(r() * W, cy, 140 + r() * 360, 5 + r() * 14, 0, 0, 7); g.fill(); }
    const haze = tod === 'day' ? [150, 170, 195] : tod === 'dusk' ? [70, 50, 90] : [14, 20, 38];
    for (let x = W * 0.3; x < W * 0.95; x += 5 + r() * 12) {
      const f = 1 - Math.abs((x / W - 0.62) * 2.6), h = 12 + r() * r() * 150 * Math.max(0.15, f), w = 8 + r() * 20;
      g.fillStyle = `rgb(${haze.map(v => Math.round(v * (0.75 + r() * 0.2))).join(',')})`; g.fillRect(x, hz - h, w, h);
      if (tod !== 'day') for (let q = 0; q < h * w / 60; q++) { g.fillStyle = 'rgba(255,214,150,0.85)'; g.fillRect(x + r() * w, hz - r() * h, 1.5, 1.5); }
    }
    gr = g.createLinearGradient(0, hz, 0, H); const gc = tod === 'day' ? ['#7b8790', '#3f4b40'] : tod === 'dusk' ? ['#3d3040', '#1b1a22'] : ['#0f1424', '#05070c'];
    gr.addColorStop(0, gc[0]); gr.addColorStop(1, gc[1]); g.fillStyle = gr; g.fillRect(0, hz, W, H - hz);
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
  function grid(rows, uvs, color, extra) { // rows[i][j] = [x,y,z]
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
  function wallBox(ax, az, bx, bz, t, y0, y1, color) { // box between two ground points, thickness t, y0..y1
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    const g = new THREE.BoxGeometry(L, y1 - y0, t); g.rotateY(-Math.atan2(dz, dx)); g.translate((ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2);
    return finish(g, color);
  }
  function beam(a, b, w, h, color) { // box from 3D point a to b (w wide, h tall cross-section)
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1e-3;
    const g = new THREE.BoxGeometry(w, L, h); g.translate(0, L / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
    g.applyQuaternion(q); g.translate(a[0], a[1], a[2]);
    return finish(g, color);
  }
  function cyl(x0, y0, z0, x1, y1, z1, r0, r1, seg, color, capped = false) {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, !capped); g.translate(0, L / 2, 0);
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
  return { finish, grid, quad, box, wallBox, beam, cyl, merge };
}

// ===========================================================================
// MAIN
// ===========================================================================
export function buildRateStadium(THREE, opts = {}) {
  const parkId = PARK, PK = PARKS.rate, C = CFG;
  const tod = ['day', 'dusk', 'night'].includes(opts.timeOfDay) ? opts.timeOfDay : 'night';
  const weather = WEATHER[opts.weather] ? opts.weather : 'clear';
  const wind = { mph: Math.max(0, +(opts.wind && opts.wind.mph) || 0), dir: +(opts.wind && opts.wind.dir) || 0 };
  const quality = ['high', 'medium', 'low'].includes(opts.quality) ? opts.quality : 'high';
  const HI = quality === 'high', LO = quality === 'low';
  const assets = opts.assets || null;
  const LOOK = makeLook(tod, weather);
  const NIGHT = LOOK.night;
  const TM = [['start', performance.now()]]; const mark = n => TM.push([n, performance.now()]);
  const K = makeGeoKit(THREE);
  const R = makeRng('rate-field');
  const disposables = [];
  const group = new THREE.Group(); group.name = 'stadium:rate';
  const aniso = HI ? 8 : quality === 'medium' ? 4 : 2;
  const OF = PK.stands, CON = { d0: OF.depth, d1: OF.depth + PK.street.width, h: PK.street.h };
  const SB = PK.scoreboard, FD = PK.fanDeck;
  const FACE = { y0: 50, y1: SB.h - 2.5 };      // LED face (60 ft tall incl. frame: 50 → 110)
  const fenceAt = s => fenceDistance(parkId, s);
  const polar = (s, r, y = 0) => [Math.sin(s * D2R) * r, y, -Math.cos(s * D2R) * r];
  const sH = d => surfaceHeight(parkId, 0, fenceAt(0) + d);   // outfield profile (spray-independent in d)

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
  const usedArt = [];
  const art = (key, w, h, fallback) => { const im = assetImage(key); if (im) { usedArt.push(key); return toCanvas(im, w, h); } return fallback(); };
  T.noise = tex(noiseCanvas(256), { srgb: false });
  T.hedge = tex(art('rate_hedge', 512, 512, hedgeCanvas));
  T.pads = tex(padsCanvas());
  T.seats = tex(seatsCanvas());
  T.glass = tex(glassCanvas(false)); T.glassLit = tex(glassCanvas(true));
  const pcArt = assetImage('rate_precast'); if (pcArt) usedArt.push('rate_precast');
  T.precast = tex(precastCanvas(false, pcArt)); T.precastLit = LOOK.windows > 0.1 ? tex(precastCanvas(true, pcArt)) : null;
  T.facade = tex(facadeCanvas(false)); T.facadeLit = LOOK.windows > 0.1 ? tex(facadeCanvas(true)) : null;
  T.stands = tex(standsCanvas(false)); T.standsLit = tex(standsCanvas(true));
  T.lamps = tex(lampCanvas());
  T.net = tex(netCanvas()); T.chain = tex(chainCanvas()); T.screen = tex(screenCanvas());
  T.ribbon = tex(ribbonCanvas()); T.ribbon.wrapT = THREE.ClampToEdgeWrapping;

  mark('materials');
  // -------------------------------------------------------------- materials
  const side = THREE.DoubleSide;
  const M = {};
  const wetRough = r => lerp(r, Math.min(r, 0.4), LOOK.wet);
  // world-space grime/noise on flat painted surfaces (one extra fetch) — breaks up CG flatness
  const grime = (mat, amt = 0.14, scale = 41) => {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uNoiseG = { value: T.noise };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW; uniform sampler2D uNoiseG;')
        .replace('#include <color_fragment>', `#include <color_fragment>
        { vec2 q = vGW.xz / ${scale.toFixed(1)} + vec2(vGW.y / ${(scale * 1.3).toFixed(1)}, -vGW.y / ${(scale * 1.7).toFixed(1)});
          float n = texture2D(uNoiseG, q).r * 0.6 + texture2D(uNoiseG, q * 5.3).g * 0.4;
          diffuseColor.rgb *= mix(1.0 - ${amt.toFixed(3)}, 1.0 + ${(amt * 0.6).toFixed(3)}, n); }`);
    };
    return mat;
  };
  M.paint = grime(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: wetRough(0.8), metalness: 0.05, side }));
  M.steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: wetRough(0.5), metalness: 0.55, side });
  M.seats = new THREE.MeshStandardMaterial({ map: T.seats, roughness: wetRough(0.62), metalness: 0.05, side });
  M.hedge = new THREE.MeshStandardMaterial({ map: T.hedge, roughness: wetRough(0.95), side, color: new THREE.Color(0.86, 0.96, 0.84) });
  M.pads = new THREE.MeshStandardMaterial({ map: T.pads, roughness: wetRough(0.5), metalness: 0.05, side });
  M.glass = new THREE.MeshStandardMaterial({ map: T.glass, roughness: 0.14, metalness: 0.15, side, envMapIntensity: 0.8, color: col('#9fb4c4'), emissiveMap: T.glassLit, emissive: col('#fff2e0'), emissiveIntensity: 1.1 * LOOK.windows });
  M.precast = grime(new THREE.MeshStandardMaterial({ map: T.precast, roughness: wetRough(0.85), side }), 0.1, 29);
  M.facade = new THREE.MeshStandardMaterial({ map: T.facade, vertexColors: true, roughness: wetRough(0.88), side });
  M.stands = new THREE.MeshStandardMaterial({ map: T.stands, roughness: 0.6, side, emissiveMap: T.standsLit, emissive: col('#ffffff'), emissiveIntensity: 0.25 + 1.0 * LOOK.windows });
  M.lamps = new THREE.MeshStandardMaterial({ map: T.lamps, emissiveMap: T.lamps, emissive: col('#fffaf0'), emissiveIntensity: LOOK.lamps, roughness: 0.4, side });
  M.net = new THREE.MeshBasicMaterial({ map: T.net, transparent: true, opacity: 0.4, depthWrite: false, side, color: col('#1c1c1c') });
  M.chain = new THREE.MeshStandardMaterial({ map: T.chain, alphaTest: 0.35, side, roughness: 0.5, metalness: 0.5 });
  M.screen = new THREE.MeshStandardMaterial({ map: T.screen, roughness: 0.8, side });
  M.ribbon = new THREE.MeshBasicMaterial({ map: T.ribbon, toneMapped: false, color: col(tod === 'day' ? '#b8bec6' : '#ffffff'), side });
  // atlas selection (4 variants stacked vertically): attribute fv, uv.y repeats inside the variant
  const atlas = mat => {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float fv;\nvarying float vFv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvFv = fv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFv;\nvec4 atlasSample(sampler2D t, vec2 uv){ vec2 g = vec2(uv.x, uv.y * 0.25); return textureGrad(t, vec2(uv.x, (vFv + fract(uv.y)) * 0.25), dFdx(g), dFdy(g)); }')
        .replace('texture2D( map, vMapUv )', 'atlasSample( map, vMapUv )').replace('texture2D( emissiveMap, vEmissiveMapUv )', 'atlasSample( emissiveMap, vEmissiveMapUv )');
    };
    return mat;
  };
  if (T.precastLit) { M.precast.emissiveMap = T.precastLit; M.precast.emissive = col('#ffdcae'); M.precast.emissiveIntensity = 0.9 * LOOK.windows; }
  if (T.facadeLit) { M.facade.emissiveMap = T.facadeLit; M.facade.emissive = col('#ffd9a0'); M.facade.emissiveIntensity = 1.2 * LOOK.windows; }
  atlas(M.precast); atlas(M.facade);
  Object.values(M).forEach(m => m && disposables.push(m));

  // bins: material key → list of geometries
  const BINS = {};
  const DEBUG_NAN = !!opts.debugNaN;
  const add = (key, geo) => { if (!geo) return; if (DEBUG_NAN) { const a = geo.attributes.position.array; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { console.warn('[rate] NaN in', key, new Error().stack.split('\n').slice(1, 4).join(' | ')); break; } } (BINS[key] || (BINS[key] = [])).push(geo); };
  // raw batches: fast path for thousands of quads / template copies (city, trees, cars)
  const RAW = {}, TPL = {}, _c = new THREE.Color();
  const rawBin = (key, ex) => RAW[key] || (RAW[key] = { pos: [], nor: [], uv: [], col: [], ex: Object.fromEntries((ex || []).map(n => [n, []])), idx: [] });
  function rawQuad(key, a, b, c, d, color, uvRect, extra) {
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
  function rawTpl(key, t, ox, oy, oz, sx, sy, sz, color, rotY = 0) {
    const B = rawBin(key), base = B.pos.length / 3, nv = t.p.length / 3; _c.set(color);
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    for (let i = 0; i < nv; i++) {
      const lx = t.p[i * 3] * sx, lz = t.p[i * 3 + 2] * sz, nx = t.n[i * 3], nz = t.n[i * 3 + 2];
      B.pos.push(lx * cs + lz * sn + ox, t.p[i * 3 + 1] * sy + oy, -lx * sn + lz * cs + oz);
      B.nor.push(nx * cs + nz * sn, t.n[i * 3 + 1], -nx * sn + nz * cs);
      B.uv.push(0, 0); B.col.push(_c.r, _c.g, _c.b); B.idx.push(base + i);
    }
  }
  const TP = {
    ico: () => tpl('ico', () => new THREE.IcosahedronGeometry(1, 1)),
    ico0: () => TPL.blob || (TPL.blob = (() => { const g = new THREE.IcosahedronGeometry(1, 0), a = g.attributes.position.array, n = new Float32Array(a.length);   // smooth (spherical) normals → soft round crowns
      for (let i = 0; i < a.length; i += 3) { const L = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1; n[i] = a[i] / L; n[i + 1] = a[i + 1] / L; n[i + 2] = a[i + 2] / L; }
      const o = { p: Float32Array.from(a), n }; g.dispose(); return o; })()),
    trunk: () => tpl('trunk', () => new THREE.CylinderGeometry(0.75, 1, 1, 5, 1, true).translate(0, 0.5, 0)),
    box: () => tpl('box', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
    cone: () => tpl('cone', () => new THREE.ConeGeometry(1, 1, 8, 1, true).translate(0, 0.5, 0)),
    pole: () => tpl('pole', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true).translate(0, 0.5, 0)),
  };
  function tree(x, z, sz, color) {
    const c2 = shade(color, 1.14), c3 = shade(color, 0.86);
    rawTpl('paint', TP.trunk(), x, 0, z, 0.8, sz * 1.0, 0.8, '#4a3a2c');
    rawTpl('paint', TP.ico0(), x, sz * 1.45, z, sz * 0.95, sz * 0.8, sz * 0.95, color);
    rawTpl('paint', TP.ico0(), x + sz * 0.42, sz * 1.62, z - sz * 0.25, sz * 0.62, sz * 0.58, sz * 0.62, c2);
    if (!LO) rawTpl('paint', TP.ico0(), x - sz * 0.38, sz * 1.3, z + sz * 0.3, sz * 0.6, sz * 0.52, sz * 0.6, c3);
  }

  // -------------------------------------------------------------- sweep helpers
  // path[i] = { p:[x,z], n:[nx,nz] } ; strip.pts = [[v,y], ...]  (v = offset along n)
  function sweep(path, strip) {
    const pts = strip.pts, nj = pts.length, rows = [], uvs = [];
    const accV = [0]; for (let j = 1; j < nj; j++) accV.push(accV[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    const uS = strip.uScale || 10, vS = strip.vScale || 10;
    const accU = new Array(nj).fill(0);
    for (let i = 0; i < path.length; i++) {
      const { p, n } = path[i], row = [], uvr = [];
      for (let j = 0; j < nj; j++) {
        const [v, y] = pts[j];
        const x = p[0] + n[0] * v, z = p[1] + n[1] * v;
        if (i > 0) { const q = rows[i - 1][j]; accU[j] += Math.hypot(x - q[0], z - q[2]); }
        row.push([x, y, z]); uvr.push([(strip.uFixed ? strip.uFixed(i, path.length) : accU[j] / uS), strip.vFixed ? strip.vFixed[j] : accV[j] / vS]);
      }
      rows.push(row); uvs.push(uvr);
    }
    return K.grid(rows, uvs, strip.color === undefined ? null : strip.color, strip.extra);
  }
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
  const offsetLine = (path, v) => path.map(({ p, n }) => [p[0] + n[0] * v, p[1] + n[1] * v]);
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
  function lineLen(line) { let L = 0; for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); return L; }
  function spraySamples(a, b, step) {
    const set = new Set();
    for (let s = a; s <= b + 1e-6; s += step) set.add(+s.toFixed(4));
    set.add(a); set.add(b);
    for (const [s] of PK.fence) if (s > a && s < b) set.add(s);
    return [...set].sort((x, y) => x - y);
  }
  const ofPath = (ss, extraD = 0) => ss.map(s => { const r = fenceAt(s) + extraD, d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });

  // -------------------------------------------------------------- CROWD (src/crowd.js — frozen API)
  const SUN = (() => { const el = LOOK.keyEl * D2R, az = LOOK.keyAz * D2R; return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]; })();
  const crowd = createCrowd(THREE, { parkId, quality, look: { crowd: LOOK.crowd, crowdShade: LOOK.crowdShade, night: NIGHT, sun: SUN }, assets });
  const SECTION = { lower: 0, club: 1, upper: 2, bleachers: 3, deck: 4, concourse: 5 };
  let rowsAdded = 0;
  // register a seat row along a polyline of [x,z] points at seat height y. facing: fn(x,z)→[fx,fz] or null (→ home)
  function crowdLine(line, y, o = {}) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
      let facing = null;
      if (o.facing) facing = o.facing((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      crowd.addRow([a[0], y, a[1]], [b[0], y, b[1]], { spacing: o.spacing || 1.85, fill: o.fill ?? 0.93, kind: o.kind || 0, facing, section: o.section || 0 });
      rowsAdded++;
    }
  }

  mark('boundary');
  // ======================================================================
  // FIELD BOUNDARY
  // ======================================================================
  const LpR = fenceAt(45), LpL = fenceAt(-45);
  function wallOffset(u, Lp) { return u >= Lp ? C.foul.pole : lerp(C.foul.near, C.foul.pole, u / Lp); }
  function foulPt(sign, u) { // point on the foul-side wall, sign +1 = 1B/RF side
    const Lp = sign > 0 ? LpR : LpL, w = wallOffset(u, Lp);
    return [sign * SQ * u + sign * SQ * w, -SQ * u + SQ * w];
  }
  function backstopPt(th) { // th: 135..225 (spray-style angle behind home)
    const a = th <= 180 ? (th - 135) / 45 : (225 - th) / 45;
    const Rr = lerp(C.foul.near, C.foul.backstop, (1 - Math.cos(Math.PI * a)) / 2);
    return [Math.sin(th * D2R) * Rr, -Math.cos(th * D2R) * Rr];
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
    return path;
  }
  // Grandstand path from the RF corner (u = uMax past... along the 1B wall) round home to the LF corner.
  function gsPathFor(uMaxR, uMaxL, step = 22) {
    const out = [];
    const us = (u0) => { const a = []; for (let u = 0; u < u0; u += step) a.push(u); a.push(u0); return a; };
    const uR = [...new Set([...us(Math.min(uMaxR, LpR)), Math.min(uMaxR, LpR), uMaxR])].sort((a, b) => b - a);
    for (const u of uR) out.push({ p: foulPt(1, u), u, side: 1 });
    for (let th = 140; th <= 220; th += 4) out.push({ p: backstopPt(th), u: 0, side: 0, th });
    const uL = [...new Set([...us(Math.min(uMaxL, LpL)), Math.min(uMaxL, LpL), uMaxL])].sort((a, b) => a - b);
    for (const u of uL) out.push({ p: foulPt(-1, u), u, side: -1 });
    for (let i = out.length - 1; i > 0; i--) if (Math.hypot(out[i].p[0] - out[i - 1].p[0], out[i].p[1] - out[i - 1].p[1]) < 0.5) out.splice(i, 1);
    return computeNormals(out);
  }
  // Closed loop of the playing field (floor polygon + warning track)
  const loop = [];
  for (const s of spraySamples(-45, 45, 1)) { const r = fenceAt(s); loop.push([Math.sin(s * D2R) * r, -Math.cos(s * D2R) * r]); }
  for (const u of [LpR, ...Array.from({ length: 16 }, (_, k) => LpR * (1 - (k + 1) / 16))]) loop.push(foulPt(1, u));
  for (let th = 140; th <= 220; th += 5) loop.push(backstopPt(th));
  for (let k = 0; k <= 16; k++) loop.push(foulPt(-1, LpL * k / 16));
  let area = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const orient = Math.sign(area) || 1;

  mark('field');
  // ======================================================================
  // FIELD — bluegrass with bold groundskeeper patterns, reddish-brown clay
  // (brought over from old Comiskey), crushed-stone warning track.
  // ======================================================================
  {
    const shape = new THREE.Shape(); loop.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2);
    g.deleteAttribute('normal'); K.finish(g, null, { zone: 0 });
    add('field', g);
    const rings = 14, segs = 48, rows = [];
    for (let i = 0; i <= rings; i++) {
      const rr = 9.6 * i / rings, row = [];
      for (let j = 0; j <= segs; j++) {
        const a = j / segs * Math.PI * 2, x = Math.cos(a) * rr, z = -59 + Math.sin(a) * rr;
        const d = Math.hypot(x, z + 60.2);
        row.push([x, 0.83 * (1 - smooth(1.6, 9.2, d)) - 0.03, z]);
      }
      rows.push(row);
    }
    add('field', K.grid(rows, null, null, { zone: 0 }));
    // warning track ribbon (15 ft, inward from the boundary)
    const n = loop.length, inner = [];
    const segNormal = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [-dz / L * orient, dx / L * orient]; };
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
      const n0 = segNormal(a, b), n1 = segNormal(b, c);
      let nx = n0[0] + n1[0], nz = n0[1] + n1[1]; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const k = 15 / Math.max(0.55, nx * n0[0] + nz * n0[1]);
      inner.push([b[0] + nx * k, b[1] + nz * k]);
    }
    const rowsT = [];
    for (let i = 0; i <= n; i++) { const k = i % n; rowsT.push([[loop[k][0], 0.12, loop[k][1]], [inner[k][0], 0.12, inner[k][1]]]); }
    add('field', K.grid(rowsT, null, null, { zone: 1 }));
  }
  M.field = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side, envMapIntensity: LOOK.wet ? 0.6 : 0.9 });
  disposables.push(M.field);
  const fieldU = {
    uNoise: { value: T.noise }, uGrass: { value: col(C.grass) }, uGrassB: { value: col(C.grassB) }, uDirt: { value: col(C.dirt) }, uDirtDark: { value: col(C.dirtDark) },
    uTrack: { value: col(C.track) }, uChalk: { value: col(C.chalk) }, uStripeW: { value: C.stripeW }, uWet: { value: LOOK.wet }, uDry: { value: LOOK.dry },
  };
  M.field.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, fieldU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float zone;\nvarying float vZone;\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvZone = zone;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vZone; varying vec3 vWP;
uniform sampler2D uNoise; uniform vec3 uGrass, uGrassB, uDirt, uDirtDark, uTrack, uChalk; uniform float uStripeW, uWet, uDry;
float gRough;
float fillAA(float sd){ float w = fwidth(sd) * 0.8 + 1e-4; return 1.0 - smoothstep(-w, w, sd); }
float lineAA(float d, float hw){ return fillAA(abs(d) - hw); }
float sdBox2(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sqWave(float x){ float fw = fwidth(x) + 1e-4; float t = abs(fract(x) - 0.5); float s = clamp((t - 0.25) / fw + 0.5, 0.0, 1.0); return mix(s, 0.5, smoothstep(0.25, 0.6, fw)); }
vec3 fieldColor(){
  vec2 p = vWP.xz;
  float a = dot(p, vec2(0.70710678, -0.70710678));   // along the 1B line
  float b = dot(p, vec2(-0.70710678, -0.70710678));  // along the 3B line
  vec3 nz = texture2D(uNoise, p / 150.0).rgb;
  vec3 nm = texture2D(uNoise, p / 21.0).rgb;
  vec3 nf = texture2D(uNoise, p / 2.3).rgb;
  vec3 V = normalize(vWP - cameraPosition);
  float R = length(p);
  // ---- grass: checkerboard mowed along both foul lines (squares -> diamonds from the plate),
  //      plus a wide arc band cut round the infield: bold, crisp, view-dependent sheen
  float W = uStripeW;
  float s1 = sqWave(a / (2.0 * W)), s2 = sqWave(b / (2.0 * W));
  float d1 = clamp(dot(V.xz, vec2(0.7071, -0.7071)) * 2.5, -1.0, 1.0);
  float d2 = clamp(dot(V.xz, vec2(-0.7071, -0.7071)) * 2.5, -1.0, 1.0);
  float sheen = (s1 * 2.0 - 1.0) * (0.42 + 0.58 * d1) * 0.5 + (s2 * 2.0 - 1.0) * (0.42 + 0.58 * d2) * 0.5;
  vec3 grass = mix(uGrass, uGrassB, 0.5 + sheen * 0.5);
  grass *= mix(0.9, 1.07, nz.r) * mix(0.94, 1.05, nm.g) * mix(0.9, 1.08, nf.b);
  grass = mix(grass, grass * vec3(1.08, 1.04, 0.8), smoothstep(0.6, 0.9, nz.g) * 0.25);
  grass *= mix(1.0, 0.8, uWet);
  grass = mix(grass, grass * vec3(1.16, 1.05, 0.66), uDry * (0.14 + 0.2 * smoothstep(0.45, 0.85, nz.b)));
  // ---- dirt
  float dArc = max(length(p - vec2(0.0, -60.5)) - 95.0, max(-a - 3.0, -b - 3.0));
  float sq = sdBox2(vec2(a, b), vec2(45.0), vec2(42.0));
  float dirtSd = max(dArc, -sq);
  float dHome = length(p - vec2(0.0, -0.7)) - 13.0;
  float dMound = length(p - vec2(0.0, -59.0)) - 9.0;
  vec2 odc = vec2(abs(p.x) - 30.0, p.y - 10.0);
  float dOnDeck = length(odc) - 2.6;
  dirtSd = min(min(dirtSd, dHome), min(dMound, dOnDeck));
  float dirtM = fillAA(dirtSd);
  vec3 nx = texture2D(uNoise, p / 0.55).rgb;
  vec3 dirt = uDirt * mix(0.86, 1.1, nm.r) * mix(0.86, 1.08, nf.g) * mix(0.86, 1.1, nx.b) * mix(0.93, 1.05, texture2D(uNoise, p / 6.5).r);
  dirt *= 1.0 - 0.045 * sqWave(dot(p, vec2(0.6, 0.8)) / 1.1) * smoothstep(20.0, 60.0, R);   // drag marks
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 2.5, length(p - vec2(0.0, -60.2))) * 0.75);
  dirt = mix(dirt, uDirtDark, smoothstep(9.0, 3.0, length(p - vec2(0.0, -0.7))) * 0.45);
  dirt *= mix(vec3(1.0), vec3(0.72, 0.66, 0.62), uWet);
  grass *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.4, dirtSd)) * step(0.0, dirtSd);   // lip
  vec3 c = mix(grass, dirt, dirtM);
  gRough = mix(mix(0.82, 0.98, nf.r), 1.0, dirtM);
  // ---- crushed-stone warning track
  float trk = step(0.5, vZone);
  vec3 track = uTrack * mix(0.82, 1.1, nm.b) * mix(0.86, 1.12, nf.r) * mix(0.9, 1.1, nx.g) * mix(1.0, 0.62, uWet);
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
  // plate, bases, rubber
  {
    const plate = new THREE.Shape([[0, 0], [0.708, -0.708], [0.708, -1.417], [-0.708, -1.417], [-0.708, -0.708]].map(([x, z]) => new THREE.Vector2(x, -z)));
    const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.08, bevelEnabled: false }); pg.rotateX(-Math.PI / 2); pg.deleteAttribute('normal'); pg.computeVertexNormals();
    add('paint', K.finish(pg, '#f4f2ec'));
    for (const [x, z] of [[63.64, -63.64], [0, -127.28], [-63.64, -63.64]]) add('paint', K.box(x, 0.15, z, 1.25, 0.3, 1.25, '#f7f6f0', Math.PI / 4));
    add('paint', K.box(0, 0.83, -60.75, 2, 0.12, 0.5, '#f7f6f0'));
  }

  // ======================================================================
  // STEPPED SEATING (shared by the bleachers and the grandstand decks)
  // ======================================================================
  function pathAt(path, P) { // interpolate a path at continuous parameter P = i + f
    const i = clamp(Math.floor(P), 0, path.length - 2), f = clamp(P - i, 0, 1), a = path[i], b = path[i + 1];
    return { p: [lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f)], n: [lerp(a.n[0], b.n[0], f), lerp(a.n[1], b.n[1], f)], t: (() => { const dx = b.p[0] - a.p[0], dz = b.p[1] - a.p[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; })(), i, f };
  }
  function subPath(path, P0, P1) {
    if (P1 - P0 < 1e-4) return null;
    const out = [pathAt(path, P0)];
    for (let i = Math.ceil(P0 + 1e-6); i < P1 - 1e-6; i++) out.push({ p: path[i].p, n: path[i].n });
    out.push(pathAt(path, P1));
    return out;
  }
  // aisle parameters along a path: every `every` ft of arc at offset v (radial aisles)
  function aislesFor(path, v, every) {
    const line = offsetLine(path, v), res = []; let acc = 0, next = every * 0.5;
    for (let i = 0; i < line.length - 1; i++) {
      const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
      while (next <= acc + L && L > 1e-6) { res.push({ P: i + (next - acc) / L, segL: L }); next += every; }
      acc += L;
    }
    return { list: res, total: acc };
  }
  /** Stepped seating: rows from (v0,y0) to (v1,y1) along `path`. Treads follow the given line at mid-tread. */
  function seating(path, o) {
    const { v0, v1, rows } = o, y0 = o.y0, y1 = o.y1;
    const dv = (v1 - v0) / rows, dy = (y1 - y0) / rows;
    const vm = (v0 + v1) / 2;
    const A = o.aisle ? aislesFor(path, vm, o.aisle) : { list: [] };
    const aw = o.aisleW || 3.8;
    // gaps between aisles in path parameters (shrunk by half an aisle, using the local segment length)
    const gaps = [];
    const ends = [0, ...A.list.map(a => a.P), path.length - 1];
    for (let k = 0; k < ends.length - 1; k++) {
      const a = ends[k], b = ends[k + 1];
      const da = k === 0 ? 0 : (aw / 2) / A.list[k - 1].segL, db = k === ends.length - 2 ? 0 : (aw / 2) / A.list[k].segL;
      if (b - db > a + da) gaps.push([a + da, b - db]);
    }
    // concrete steps (duplicated corner points → crisp normals)
    const pts = [];
    for (let k = 0; k < rows; k++) {
      const vA = v0 + k * dv, vB = vA + dv, yk = y0 + k * dy;
      pts.push([vA, yk], [vB, yk], [vB, yk], [vB, yk + dy]);
    }
    add('paint', sweep(path, { pts, color: o.concrete || C.concrete }));
    // seats (per gap) + crowd rows
    const seatPts = []; // relative profile of one seat row on a tread
    const sp = o.seatScale || 1;
    for (let k = 0; k < rows; k++) {
      const vA = v0 + k * dv, yk = y0 + k * dy;
      const prof = [[vA + 0.5 * sp, yk + 1.4 * sp], [vA + 1.6 * sp, yk + 1.55 * sp], [vA + 1.8 * sp, yk + 2.85 * sp]];
      seatPts.push(prof);
      const shaded = o.kindAt ? o.kindAt(vA + dv / 2, k) : 0;
      if (o.noCrowd) continue;
      for (const [P0, P1] of gaps) {
        const sub = subPath(path, P0, P1); if (!sub) continue;
        crowdLine(offsetLine(sub, vA + 1.15 * sp), yk + 1.5 * sp, { fill: o.fill ?? 0.93, kind: shaded, section: o.section || 0, spacing: o.spacing || 1.85 });
      }
    }
    for (const [P0, P1] of gaps) {
      const sub = subPath(path, P0, P1); if (!sub || sub.length < 2) continue;
      for (const prof of seatPts) add('seats', sweep(sub, { pts: prof, uScale: 28, vFixed: [0.14, 0.46, 1.0] }));
    }
    // aisle stairs (lighter concrete strip over the step profile)
    for (const a of A.list) {
      const q = pathAt(path, a.P), t = q.t;
      const mini = [{ p: [q.p[0] - t[0] * aw / 2, q.p[1] - t[1] * aw / 2], n: q.n }, { p: [q.p[0] + t[0] * aw / 2, q.p[1] + t[1] * aw / 2], n: q.n }];
      add('paint', sweep(mini, { pts: pts.map(([v, y]) => [v, y + 0.04]), color: o.stairColor || '#9b9b94' }));
    }
    return { dv, dy, rows, gaps, aisles: A.list, topY: y0 + rows * dy, yAt: v => y0 + clamp(Math.floor((v - v0) / dv), 0, rows - 1) * dy };
  }

  mark('outfield');
  // ======================================================================
  // OUTFIELD — padded wall, bleachers, batter's eye, Fan Deck, concourse
  // ======================================================================
  const H0 = PK.fenceH;                                        // 8 ft
  const EYE = FD.spray[1];                                     // batter's eye / Fan Deck half-width (7°)
  const rampSlope = (OF.topH - OF.startH) / OF.depth;
  const ramp = d => OF.startH + rampSlope * d;                 // == surfaceHeight beyond the fence
  if (Math.abs(ramp(20) - sH(20)) > 0.01) console.warn('[rate] surfaceHeight mismatch');
  const BL = { v0: 1.5, v1: OF.depth - 0.4, rows: 22 };
  BL.dv = (BL.v1 - BL.v0) / BL.rows; BL.y0 = ramp(BL.v0 + BL.dv / 2); BL.y1 = BL.y0 + rampSlope * (BL.v1 - BL.v0); BL.dy = (BL.y1 - BL.y0) / BL.rows;
  const blTop = BL.y1;                                         // top tread (≈ 32)
  const cornerPath = sign => { // straight path from the pole outward into foul ground; offsets run along the line
    const Lp = sign > 0 ? LpR : LpL, L = [sign * SQ, -SQ], N = [sign * SQ, SQ], out = [];
    for (let k = 0; k <= 3; k++) { const w = C.foul.pole * k / 3; out.push({ p: [L[0] * Lp + N[0] * w, L[1] * Lp + N[1] * w], n: L }); }
    return out;
  };
  const cornerR = cornerPath(1), cornerL = cornerPath(-1);
  const pathLF = ofPath(spraySamples(-45, -EYE, 0.5)), pathRF = ofPath(spraySamples(EYE, 45, 0.5));
  const pathEye = ofPath(spraySamples(-EYE, EYE, 0.5));
  const pathAll = ofPath(spraySamples(-45, 45, 0.5));
  // --- wall: pads + cap (whole outfield incl. the corner jogs) ; chain-link bullpen windows
  const PENS = [{ s0: 17, s1: 26, floor: 0, name: 'visitors' }, { s0: -44, s1: -37.5, floor: 2.5, name: 'home' }];
  const inPen = s => PENS.find(p => s > p.s0 && s < p.s1);
  {
    const segs = []; let cur = null;
    for (const q of pathAll) { const pen = !!inPen(q.s); if (!cur || cur.pen !== pen) { if (cur) cur.pts.push(q); cur = { pen, pts: [q] }; segs.push(cur); } else cur.pts.push(q); }
    for (const sg of segs) {
      if (sg.pts.length < 2) continue;
      if (sg.pen) { // chain-link panel in the wall + dark frame
        const pen = inPen(sg.pts[Math.floor(sg.pts.length / 2)].s);
        add('chain', sweep(sg.pts, { pts: [[-0.05, pen.floor + 0.4], [-0.05, H0 - 0.4]], uScale: 1.3, vScale: 1.3 }));
        add('paint', sweep(sg.pts, { pts: [[0, H0 - 0.5], [0, H0]], color: '#0f1d16' }));
        add('paint', sweep(sg.pts, { pts: [[0, 0], [0, pen.floor + 0.4]], color: '#0f1d16' }));
      } else add('pads', sweep(sg.pts, { pts: [[0, 0], [0, H0]], uScale: 20, vFixed: [0, 1] }));
    }
    for (const cp of [cornerR, cornerL]) add('pads', sweep(cp, { pts: [[0, 0], [0, H0]], uScale: 20, vFixed: [0, 1] }));
    for (const pth of [pathAll, cornerR, cornerL]) {
      add('paint', sweep(pth, { pts: [[0, H0], [BL.v0, H0]], color: '#121a16' }));
      add('paint', sweep(pth, { pts: [[BL.v0, H0], [BL.v0, BL.y0]], color: '#1b1f1d' }));
    }
    // bullpens under the front bleacher rows (seen through the chain-link)
    for (const pen of PENS) {
      const ph = ofPath(spraySamples(pen.s0, pen.s1, 0.5)), depth = 26, yTop = ramp(depth) - 0.5;
      add('paint', sweep(ph, { pts: [[0.1, pen.floor], [depth, pen.floor]], color: pen.floor > 0 ? '#3c6a34' : '#3a6b33' }));   // turf
      add('paint', sweep(ph, { pts: [[depth, pen.floor], [depth, yTop]], color: '#101412' }));                                   // back wall
      add('paint', sweep(ph, { pts: [[0.2, yTop], [depth, yTop]], color: '#0c0f0e' }));                                         // ceiling
      for (const e of [ph[0], ph[ph.length - 1]]) capAt(e.p, e.n, [[0.1, pen.floor], [0.1, yTop], [depth, yTop], [depth, pen.floor]], '#121614');
      if (pen.floor > 0) add('paint', sweep(ph, { pts: [[0.1, 0], [0.1, pen.floor]], color: '#101412' }));
      for (const f of [0.3, 0.7]) { // two mounds + rubbers
        const s = lerp(pen.s0, pen.s1, f), [x, , z] = polar(s, fenceAt(s) + 15);
        add('paint', K.cyl(x, pen.floor, z, x, pen.floor + 0.6, z, 5, 3.6, 12, '#8e5634', true));
        add('paint', K.box(x, pen.floor + 0.65, z, 2, 0.1, 0.5, '#f4f4ee', -s * D2R));
      }
      const s = (pen.s0 + pen.s1) / 2, [x, , z] = polar(s, fenceAt(s) + depth - 2);
      add('paint', K.box(x, pen.floor + 1.2, z, 30, 0.4, 2.2, '#3a3f45', -s * D2R));                                            // bench
    }
  }
  // --- bleachers (LF + RF, bench-style green seats), corner jogs
  const bleacherKind = () => 0;
  const blOpts = { v0: BL.v0, v1: BL.v1, rows: BL.rows, y0: BL.y0, y1: BL.y1, aisle: 56, aisleW: 4, section: SECTION.bleachers, fill: 0.94, kindAt: bleacherKind };
  const blL = seating(pathLF, blOpts), blR = seating(pathRF, blOpts);
  seating(cornerR, { ...blOpts, aisle: 0 }); seating(cornerL, { ...blOpts, aisle: 0 });
  // two original-color blue seats (one per side)
  for (const s of [-27, 29]) { const k = 9, v = BL.v0 + k * BL.dv, [x, , z] = polar(s, fenceAt(s) + v + 1.2); add('paint', K.box(x, BL.y0 + k * BL.dy + 2.2, z, 1.6, 1.3, 0.35, '#1e5fd0', -s * D2R)); }
  // bleacher end walls facing the batter's eye (stepped outline down to the ground)
  {
    const outline = [[0, 0], [0, H0], [BL.v0, H0]];
    for (let k = 0; k < BL.rows; k++) { const vA = BL.v0 + k * BL.dv, yk = BL.y0 + k * BL.dy; outline.push([vA, yk + (k ? 0 : 0)], [vA + BL.dv, yk]); }
    outline.push([BL.v1, blTop + 3.2], [OF.depth, blTop + 3.2], [OF.depth, 0]);
    for (const e of [pathLF[pathLF.length - 1], pathRF[0]]) capAt(e.p, e.n, outline, '#23262a');
    for (const cp of [cornerR, cornerL]) { const e = cp[cp.length - 1]; capAt(e.p, e.n, [...outline.slice(0, -1), [CON.d1 + 1, blTop + 3.2], [CON.d1 + 1, 0]], '#8f8d86'); }
  }
  // back rail on the top row (black steel + glass)
  for (const pth of [pathLF, pathRF, cornerR, cornerL]) {
    add('paint', sweep(pth, { pts: [[BL.v1, blTop], [OF.depth, blTop], [OF.depth, CON.h]], color: '#3b3d3f' }));
    add('steel', sweep(pth, { pts: [[OF.depth - 0.2, blTop + 3.3], [OF.depth + 0.2, blTop + 3.3]], color: C.steel }));
  }
  // front railing along the wall top (thin black rail on posts)
  for (const pth of [pathLF, pathRF]) {
    add('steel', sweep(pth, { pts: [[0.6, H0 + 3.1], [0.6, H0 + 3.4]], color: '#101010' }));
    walk(offsetLine(pth, 0.6), 8, (x, z) => add('steel', K.box(x, H0 + 1.7, z, 0.16, 3.4, 0.16, '#101010')));
  }

  // --- CF: tiered ivy batter's eye (follows surfaceHeight within each tier)
  const TIERS = 5, tierD = 10;
  {
    const hN = (i, j) => { const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; return h - Math.floor(h); };
    for (let k = 0; k < TIERS; k++) {
      const dA = k === 0 ? BL.v0 : k * tierD, dB = (k + 1) * tierD;
      const top = ramp((dA + dB) / 2), prevTop = k === 0 ? H0 : ramp((k - 1) * tierD + tierD / 2);
      const wallTop = top - 1.3;
      add('paint', sweep(pathEye, { pts: [[dA, prevTop - 0.8], [dA, wallTop]], color: '#141516' }));             // planter face
      add('paint', sweep(pathEye, { pts: [[dA, wallTop], [dA + 0.6, wallTop]], color: '#232426' }));
      // hedge: rounded front, top rising ~60% of the ramp slope inside the tier, bumpy
      const rise = rampSlope * (dB - dA) * 0.6;
      const prof = [[dA + 0.5, wallTop], [dA + 0.25, top - 0.7], [dA + 0.7, top - 0.1], [dA + 1.9, top + 0.1 - rise * 0.42], [dA + (dB - dA) * 0.55, top + 0.05], [dB - 0.2, top - 0.05 + rise * 0.45], [dB + 0.1, top + rise * 0.45 - 0.4]];
      const g = sweep(pathEye, { pts: prof, uScale: 7, vScale: 7 });
      const pos = g.attributes.position; const nj = prof.length;
      for (let i = 0; i < pos.count; i++) { const ii = Math.floor(i / nj), jj = i % nj; if (jj === 0) continue; pos.setY(i, pos.getY(i) + (hN(ii, jj + k * 7) - 0.5) * 0.55); }
      g.computeVertexNormals();
      add('hedge', g);
    }
    // side walls of the tiers against the bleachers are the bleacher end caps; under the Fan Deck front
    // the top tier continues to d = 50, then the lower Fan Deck level.
  }
  // --- Fan Deck (two levels): lower at the concourse level (d 50–62), upper floor at FD.h (d 38–62)
  const FDl = { d0: 50, d1: OF.depth, h: CON.h };
  {
    const pDeck = ofPath(spraySamples(FD.spray[0], FD.spray[1], 0.5));
    // lower level
    add('paint', sweep(pDeck, { pts: [[FDl.d0, ramp(FDl.d0 - 5) - 1], [FDl.d0, FDl.h], [FDl.d1, FDl.h]], color: '#4a4b48' }));
    add('steel', sweep(pDeck, { pts: [[FDl.d0 + 0.3, FDl.h + 3.4], [FDl.d0 + 0.3, FDl.h + 3.7]], color: '#0e0e0e' }));
    add('glassRail', sweep(pDeck, { pts: [[FDl.d0 + 0.3, FDl.h + 0.3], [FDl.d0 + 0.3, FDl.h + 3.4]], uScale: 4, vScale: 4 }));
    // upper slab + fascia + glass rail
    const y1 = FD.h, y0 = FD.h - 1.6;
    add('paint', sweep(pDeck, { pts: [[FD.d[0], y1], [FD.d[1], y1]], color: '#5a5a55' }));
    add('paint', sweep(pDeck, { pts: [[FD.d[1], y0], [FD.d[0], y0]], color: '#1a1b1c' }));
    add('paint', sweep(pDeck, { pts: [[FD.d[0], y0], [FD.d[0], y1]], color: '#0f0f10' }));
    add('glassRail', sweep(pDeck, { pts: [[FD.d[0] + 0.3, y1 + 0.2], [FD.d[0] + 0.3, y1 + 3.6]], uScale: 4, vScale: 4 }));
    add('steel', sweep(pDeck, { pts: [[FD.d[0] + 0.3, y1 + 3.6], [FD.d[0] + 0.3, y1 + 3.9]], color: '#0e0e0e' }));
    for (const e of [pDeck[0], pDeck[pDeck.length - 1]]) {
      capAt(e.p, e.n, [[FD.d[0], y0], [FD.d[0], y1], [FD.d[1], y1], [FD.d[1], y0]], '#151516');
      const r0 = Math.hypot(e.p[0], e.p[1]), a = [e.p[0] + e.n[0] * FD.d[0], e.p[1] + e.n[1] * FD.d[0]], b = [e.p[0] + e.n[0] * FD.d[1], e.p[1] + e.n[1] * FD.d[1]];
      if (r0 > 0) add('glassRail', K.quad([a[0], y1 + 0.2, a[1]], [b[0], y1 + 0.2, b[1]], [b[0], y1 + 3.6, b[1]], [a[0], y1 + 3.6, a[1]], null, [0, 0, (FD.d[1] - FD.d[0]) / 4, 0.9]));
    }
    // columns under the upper front edge
    for (const s of [-6, -2, 2, 6]) { const r = fenceAt(s) + FD.d[0] + 1.2, [x, , z] = polar(s, r); add('steel', K.box(x, (ramp(FD.d[0] + 1) + y0) / 2, z, 1.1, y0 - ramp(FD.d[0] + 1), 1.1, '#101010', -s * D2R)); }
    // string lights under the slab + along the rail (glow points added later)
    // fans: standing rows on both levels + high-top tables
    const deckRows = (d0, d1, y, n) => { for (let k = 0; k < n; k++) { const d = lerp(d0, d1, (k + 0.5) / n); crowdLine(offsetLine(ofPath(spraySamples(FD.spray[0] + 0.3, FD.spray[1] - 0.3, 1)), d), y, { kind: 2, section: SECTION.deck, fill: k === 0 ? 0.95 : 0.6, spacing: 2.3 }); } };
    deckRows(FD.d[0] + 1.6, FD.d[1] - 3, y1, 5);
    deckRows(FDl.d0 + 1.6, FDl.d1 - 2, FDl.h, 3);
    for (let k = 0; k < 7; k++) { const s = lerp(-5.5, 5.5, k / 6), [x, , z] = polar(s, fenceAt(s) + FD.d[0] + 12); add('paint', K.cyl(x, y1, z, x, y1 + 3.4, z, 0.25, 0.25, 6, '#1a1a1a')); add('paint', K.cyl(x, y1 + 3.4, z, x, y1 + 3.55, z, 1.4, 1.4, 10, '#303234', true)); }
  }

  // --- the open 100-level outfield concourse (surfaceHeight = street.h for street.width)
  const FV = k => 3 - k;                                        // atlas variant → shader index (canvas top = variant 0)
  const SIGNS = [];                                             // text quads for the signs atlas
  const glowPts = [];                                           // [x,y,z,size,r,g,b,a] steady glows (lamps, string lights)
  {
    for (const pth of [pathAll, cornerR, cornerL]) {
      add('paint', sweep(pth, { pts: [[OF.depth, CON.h], [CON.d1, CON.h]], color: C.concourse }));
      add('paint', sweep(pth, { pts: [[CON.d1, CON.h], [CON.d1, CON.h + 3.8], [CON.d1 + 1.2, CON.h + 3.8]], color: '#77766f' }));
      add('precast', sweep(pth, { pts: [[CON.d1 + 1.2, 0], [CON.d1 + 1.2, CON.h + 3.8]], uScale: 40, vFixed: [0, (CON.h + 3.8) / 40], extra: { fv: FV(0) } }));
      add('steel', sweep(pth, { pts: [[CON.d1 - 0.3, CON.h + 3.8], [CON.d1 - 0.3, CON.h + 4.3]], color: '#111' }));
    }
    // brick portals (piers + black steel lintel) along the outer edge, LF and RF (not behind the big board)
    const portalRanges = [[-44.5, -9.5], [9.5, 44.5]];
    for (const [a, b] of portalRanges) {
      const pth = ofPath(spraySamples(a, b, 0.5), 0);
      add('steel', sweep(pth, { pts: [[CON.d1 - 3, CON.h + 18.5], [CON.d1 - 3, CON.h + 20.5], [CON.d1 - 5, CON.h + 20.5]], color: '#131313' }));
      walk(offsetLine(pth, CON.d1 - 3), 34, (x, z, tx, tz) => add('paint', K.box(x, CON.h + 9.5, z, 4.2, 19, 4.2, '#7a3d2c', -Math.atan2(tz, tx))));
    }
    // concession stands (fictional names; lit menu boards at night)
    const stand = (s0, s1, cell, d0 = 84, d1 = 100, h = 14) => {
      const A = polar(s0, fenceAt(s0) + d0, CON.h), B = polar(s1, fenceAt(s1) + d0, CON.h), Cb = polar(s1, fenceAt(s1) + d1, CON.h), Db = polar(s0, fenceAt(s0) + d1, CON.h);
      const up = p => [p[0], p[1] + h, p[2]];
      const cu = (cell % 4) / 4, cv = 1 - (Math.floor(cell / 4) + 1) / 4;
      add('stands', K.quad(A, B, up(B), up(A), null, [cu, cv, cu + 0.25, cv + 0.25]));
      add('paint', K.quad(B, Cb, up(Cb), up(B), '#2b2e31')); add('paint', K.quad(Db, A, up(A), up(Db), '#2b2e31')); add('paint', K.quad(Cb, Db, up(Db), up(Cb), '#26282a'));
      const o = 3.5, nA = dirXZ(s0), nB = dirXZ(s1);
      const A2 = [A[0] - nA[0] * o, A[1] + h + 0.4, A[2] - nA[1] * o], B2 = [B[0] - nB[0] * o, B[1] + h + 0.4, B[2] - nB[1] * o];
      add('paint', K.quad(A2, B2, [Cb[0], Cb[1] + h + 0.4, Cb[2]], [Db[0], Db[1] + h + 0.4, Db[2]], '#161718'));   // roof + canopy overhang
      add('paint', K.quad([A2[0], A2[1] - 1.1, A2[2]], [B2[0], B2[1] - 1.1, B2[2]], B2, A2, '#101010'));          // fascia
      if (NIGHT > 0.2) { const m = polar((s0 + s1) / 2, fenceAt((s0 + s1) / 2) + d0 - 2, CON.h + h - 1); glowPts.push(m[0], m[1], m[2], 16, 1, 0.9, 0.7, 0.35 * NIGHT); }
    };
    stand(-34.5, -30.5, 0); stand(-25.5, -21, 1); stand(-14.5, -10.5, 2); stand(10.5, 14.5, 4); stand(18.5, 23, 3); stand(-20.3, -18.6, 5, 86, 96, 11); stand(24, 26.5, 9, 86, 98, 12);
    // canopies (black steel frames) over the LF/RF concourse
    const canopy = (s0, s1, d0 = 68, d1 = 106, y = CON.h + 20) => {
      const pth = ofPath(spraySamples(s0, s1, 0.5));
      add('paint', sweep(pth, { pts: [[d1, y], [d0, y + 1.4]], color: '#1d1f21' }));
      add('steel', sweep(pth, { pts: [[d0, y + 1.4], [d0, y + 0.2]], color: '#0c0c0c' }));
      walk(offsetLine(pth, d0 + 1), 24, (x, z) => add('steel', K.box(x, CON.h + (y - CON.h) / 2 + 0.4, z, 0.8, y - CON.h + 1, 0.8, '#0c0c0c')));
    };
    canopy(-35, -9.5); canopy(9.5, 27);
    // the shower (carried over from old Comiskey) on the LCF concourse
    {
      const [x, , z] = polar(-17, fenceAt(-17) + 74, CON.h);
      add('paint', K.cyl(x, CON.h, z, x, CON.h + 0.6, z, 5, 5, 16, '#c9ccce', true));
      add('steel', K.cyl(x + 3, CON.h, z, x + 3, CON.h + 13, z, 0.35, 0.35, 8, '#c7cbcf'));
      add('steel', K.beam([x + 3, CON.h + 13, z], [x, CON.h + 13, z], 0.5, 0.5, '#c7cbcf'));
      add('steel', K.cyl(x, CON.h + 12.6, z, x, CON.h + 13.1, z, 1.3, 0.6, 12, '#aeb3b8', true));
    }
    // kids' zone (multi-level play structure) in the LF corner
    {
      const base = (s0, s1, d0, d1, y0, y1, c) => { const sm = (s0 + s1) / 2, r0 = fenceAt(sm) + d0, r1 = fenceAt(sm) + d1, [x, , z] = polar(sm, (r0 + r1) / 2), w = (s1 - s0) * D2R * (r0 + r1) / 2; add('paint', K.box(x, (y0 + y1) / 2, z, w, y1 - y0, r1 - r0, c, -sm * D2R)); };
      base(-44.5, -36.5, 72, 104, CON.h, CON.h + 10, '#1d4ed8');
      base(-43.5, -38.5, 76, 98, CON.h + 10, CON.h + 11, '#f7b801');
      base(-43, -40.5, 78, 90, CON.h + 11, CON.h + 21, '#d62828');
      base(-39.5, -37.5, 88, 100, CON.h + 11, CON.h + 18, '#16a34a');
      base(-42.8, -40.7, 79, 89, CON.h + 21, CON.h + 23, '#f7b801');
      const [tx, , tz] = polar(-38.5, fenceAt(-38.5) + 80);
      for (let k = 0; k < 10; k++) { const a = k * 0.6, y = CON.h + 20 - k * 1.9; add('paint', K.cyl(tx + Math.cos(a) * 4, y, tz + Math.sin(a) * 4, tx + Math.cos(a + 0.6) * 4, y - 1.9, tz + Math.sin(a + 0.6) * 4, 1.4, 1.4, 8, '#ffcc00')); }
      const pth = ofPath(spraySamples(-44.5, -36.5, 0.5));
      add('chain', sweep(pth, { pts: [[71.5, CON.h + 10], [71.5, CON.h + 16]], uScale: 1.3, vScale: 1.3 }));
      SIGNS.push({ kind: 'panel', text: 'KIDS ZONE', bg: '#f7b801', fg: '#1d2b6b', quad: (() => { const a = polar(-43.4, fenceAt(-43.4) + 71.3, CON.h + 3), b = polar(-38, fenceAt(-38) + 71.3, CON.h + 3); return [a, b, [b[0], CON.h + 8.5, b[2]], [a[0], CON.h + 8.5, a[2]]]; })() });
    }
    // RF craft-beer hall + patio
    {
      const s0 = 30.5, s1 = 42.5, d0 = 82, d1 = 106, h = 22;
      const pth = ofPath(spraySamples(s0, s1, 0.5));
      add('glass', sweep(pth, { pts: [[d0, CON.h + 1], [d0, CON.h + h - 3]], uScale: 24, vFixed: [0, 1.0] }));
      add('paint', sweep(pth, { pts: [[d0, CON.h], [d0, CON.h + 1]], color: '#1c1c1c' }));
      add('paint', sweep(pth, { pts: [[d0 - 3, CON.h + h - 3], [d0 - 3, CON.h + h], [d1, CON.h + h]], color: '#141414' }));
      for (const e of [pth[0], pth[pth.length - 1]]) capAt(e.p, e.n, [[d0, CON.h], [d0, CON.h + h], [d1, CON.h + h], [d1, CON.h]], '#2a2320');
      walk(offsetLine(pth, d0 - 0.2), 12, (x, z) => add('steel', K.box(x, CON.h + h / 2, z, 0.6, h, 0.6, '#0e0e0e')));
      const sa = polar(32.5, fenceAt(32.5) + d0 - 3.3, CON.h + h - 2.7), sb = polar(40.5, fenceAt(40.5) + d0 - 3.3, CON.h + h - 2.7);
      SIGNS.push({ kind: 'panel', text: 'BRIDGEPORT BREW HALL', bg: '#111214', fg: '#f3c969', lit: true, quad: [sa, sb, [sb[0], sb[1] + 2.4, sb[2]], [sa[0], sa[1] + 2.4, sa[2]]] });
      // patio: tables + umbrellas + string lights
      for (let k = 0; k < 9; k++) {
        const s = lerp(s0 + 1, s1 - 1, (k % 5) / 4) + (k > 4 ? 1.2 : 0), d = k > 4 ? 76 : 70, [x, , z] = polar(s, fenceAt(s) + d);
        add('paint', K.cyl(x, CON.h, z, x, CON.h + 3.4, z, 0.2, 0.2, 6, '#222'));
        add('paint', K.cyl(x, CON.h + 3.4, z, x, CON.h + 3.6, z, 1.6, 1.6, 10, '#3a3d40', true));
        if (k % 2 === 0) { add('paint', K.cyl(x, CON.h + 3.6, z, x, CON.h + 9.5, z, 0.12, 0.12, 5, '#ddd')); add('paint', K.cyl(x, CON.h + 8.2, z, x, CON.h + 9.6, z, 5.2, 0.2, 10, k % 4 ? '#12357a' : '#f3f3ee')); }
      }
      crowdLine(offsetLine(ofPath(spraySamples(s0 + 0.5, s1 - 0.5, 1)), 73), CON.h, { kind: 2, section: SECTION.concourse, fill: 0.5, spacing: 3 });
      crowdLine(offsetLine(ofPath(spraySamples(s0 + 0.5, s1 - 0.5, 1)), 79), CON.h, { kind: 2, section: SECTION.concourse, fill: 0.35, spacing: 3 });
      if (NIGHT > 0.2 || tod === 'dusk') walk(offsetLine(pth, d0 - 8), 4, (x, z, tx, tz, dist) => { const sag = Math.abs(Math.sin(dist / 24 * Math.PI)) * 1.6; glowPts.push(x, CON.h + 11 - sag, z, 2.4, 1, 0.82, 0.5, 0.8 * Math.max(NIGHT, 0.5)); });
    }
    // fans milling on the concourse walkway behind the bleachers (standing)
    for (const [a, b] of [[-35, -9], [9, 29]]) {
      crowdLine(offsetLine(ofPath(spraySamples(a, b, 1)), 66), CON.h, { kind: 2, section: SECTION.concourse, fill: 0.3, spacing: 2.6 });
      crowdLine(offsetLine(ofPath(spraySamples(a, b, 1)), 76), CON.h, { kind: 2, section: SECTION.concourse, fill: 0.22, spacing: 2.6 });
    }
  }

  mark('board');
  // ======================================================================
  // CF VIDEO BOARD (134 x 60 ft, black frame) — the face follows scoreboardDistance() exactly
  // ======================================================================
  const sbArr = spraySamples(SB.spray[0], SB.spray[1], 0.25);
  const sbFront = sbArr.map(s => { const r = scoreboardDistance(parkId, s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
  const BOARD = { inset: 2.4 };
  {
    const depth = SB.depth, bot = CON.h, top = SB.h;
    add('paint', sweep(sbFront, { pts: [[0, bot], [0, FACE.y0 - 6]], color: '#0b0b0c' }));
    add('ribbon', sweep(sbFront, { pts: [[-0.1, FACE.y0 - 6], [-0.1, FACE.y0 - 1]], uScale: 60, vFixed: [0, 1] }));
    add('paint', sweep(sbFront, { pts: [[0, FACE.y0 - 1], [0, top]], color: C.frame }));
    add('paint', sweep(sbFront, { pts: [[0, top], [depth, top]], color: '#121212' }));
    add('paint', sweep(sbFront, { pts: [[depth, top], [depth, bot]], color: '#161718' }));
    for (const e of [sbFront[0], sbFront[sbFront.length - 1]]) capAt(e.p, e.n, [[0, bot], [0, top], [depth, top], [depth, bot]], '#101011');
    // bezel lip round the LED face
    const inner = sbArr.filter(s => s >= SB.spray[0] + 0.3 && s <= SB.spray[1] - 0.3);
    const fr = inner.map(s => { const r = scoreboardDistance(parkId, s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    add('paint', sweep(fr, { pts: [[0, FACE.y0 + BOARD.inset - 0.8], [-1.1, FACE.y0 + BOARD.inset - 0.8], [-1.1, FACE.y0 + BOARD.inset]], color: '#1b1c1e' }));
    add('paint', sweep(fr, { pts: [[-1.1, FACE.y1 - BOARD.inset], [-1.1, FACE.y1 - BOARD.inset + 0.8], [0, FACE.y1 - BOARD.inset + 0.8]], color: '#1b1c1e' }));
    // back of the board: steel grid (reverse angles)
    const back = sbArr.filter((_, i) => i % 8 === 0);
    for (const s of back) { const r = scoreboardDistance(parkId, s) + depth + 0.3, [x, , z] = polar(s, r); add('steel', K.box(x, (bot + top) / 2, z, 1.2, top - bot, 0.8, '#1d1f22', -s * D2R)); }
    const backPath = sbFront.map(q => ({ p: [q.p[0] + q.n[0] * (depth + 0.3), q.p[1] + q.n[1] * (depth + 0.3)], n: q.n }));
    for (const y of [45, 65, 85, 105]) add('steel', sweep(backPath, { pts: [[0, y], [0, y + 1.2]], color: '#1d1f22' }));
    // pinwheel rail on top + mortar racks behind
    add('steel', sweep(sbFront, { pts: [[2, top + 0.2], [2, top + 2], [4, top + 2]], color: '#0d0d0d' }));
    for (let k = 0; k < 9; k++) { const s = lerp(-7, 7, k / 8), [x, , z] = polar(s, scoreboardDistance(parkId, s) + depth - 3, top); add('paint', K.box(x, top + 1.5, z, 5, 3, 3, '#232323', -s * D2R)); }
  }
  // LED face mesh (own material, see board canvas below)
  const faceGeo = (() => {
    const inner = sbArr.filter(s => s >= SB.spray[0] + 0.3 && s <= SB.spray[1] - 0.3);
    const fr = inner.map(s => { const r = scoreboardDistance(parkId, s), d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    const g = sweep(fr, { pts: [[-0.35, FACE.y0 + BOARD.inset], [-0.35, FACE.y1 - BOARD.inset]], uFixed: (i, n) => i / (n - 1), vFixed: [0, 1] });
    let w = 0; for (let i = 1; i < fr.length; i++) w += Math.hypot(fr[i].p[0] - fr[i - 1].p[0], fr[i].p[1] - fr[i - 1].p[1]);
    BOARD.w = w; BOARD.h = FACE.y1 - FACE.y0 - 2 * BOARD.inset;
    return g;
  })();
  // CF board centre + normal for landmarks / cameras
  BOARD.center = polar(0, scoreboardDistance(parkId, 0) - 0.4, (FACE.y0 + FACE.y1) / 2);

  // ======================================================================
  // LF / RF corner video boards (PARKS.rate.videoBoards) — face at fence + stands.depth
  // ======================================================================
  const VB = PK.videoBoards.map(b => {
    const ss = spraySamples(b.spray[0], b.spray[1], 0.25);
    const front = ss.map(s => { const r = fenceAt(s) + OF.depth, d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    const depth = 6;
    add('paint', sweep(front, { pts: [[0, b.bottom], [0, b.top]], color: C.frame }));
    add('paint', sweep(front, { pts: [[0, b.top], [depth, b.top]], color: '#121212' }));
    add('paint', sweep(front, { pts: [[depth, b.top], [depth, b.bottom], [0, b.bottom]], color: '#151617' }));
    for (const e of [front[0], front[front.length - 1]]) capAt(e.p, e.n, [[0, b.bottom], [0, b.top], [depth, b.top], [depth, b.bottom]], '#101011');
    // legs down to the concourse (+ cross brace)
    for (const s of [b.spray[0] + 1, b.spray[1] - 1]) for (const dd of [1.5, depth - 1.5]) { const [x, , z] = polar(s, fenceAt(s) + OF.depth + dd); add('steel', K.box(x, (CON.h + b.bottom) / 2, z, 1.4, b.bottom - CON.h, 1.4, '#111', -s * D2R)); }
    { const a = polar(b.spray[0] + 1, fenceAt(b.spray[0] + 1) + OF.depth + depth - 1.5, CON.h + 1), c = polar(b.spray[1] - 1, fenceAt(b.spray[1] - 1) + OF.depth + depth - 1.5, b.bottom - 1); add('steel', K.beam(a, c, 0.6, 0.6, '#111')); }
    const inner = ss.filter(s => s >= b.spray[0] + 0.25 && s <= b.spray[1] - 0.25);
    const fr = inner.map(s => { const r = fenceAt(s) + OF.depth, d = dirXZ(s); return { p: [d[0] * r, d[1] * r], n: d, s }; });
    const u0 = b.id === 'lf' ? 0 : 0.5;
    const g = sweep(fr, { pts: [[-0.3, b.bottom + 1.6], [-0.3, b.top - 1.6]], uFixed: (i, n) => u0 + 0.5 * i / (n - 1), vFixed: [0, 1] });
    const sm = (b.spray[0] + b.spray[1]) / 2;
    return { id: b.id, geo: g, center: polar(sm, fenceAt(sm) + OF.depth - 0.4, (b.bottom + b.top) / 2), spray: b.spray, bottom: b.bottom, top: b.top };
  });

  mark('towers');
  // ======================================================================
  // LIGHT BANKS (outfield towers + the grandstand roof ring) + glare
  // ======================================================================
  const glare = [];
  function lightBank(x, y, z, w, h, aim = [0, 25, -150], tilt = 0.3) {
    const dx = aim[0] - x, dz = aim[2] - z, L = Math.hypot(dx, dz), fx = dx / L, fz = dz / L;
    const tx = -fz, tz = fx;
    const b0 = [x - tx * w / 2, y, z - tz * w / 2], b1 = [x + tx * w / 2, y, z + tz * w / 2];
    const t1 = [b1[0] + fx * h * tilt, y + h, b1[2] + fz * h * tilt], t0 = [b0[0] + fx * h * tilt, y + h, b0[2] + fz * h * tilt];
    const off = (p, k) => [p[0] - fx * k, p[1], p[2] - fz * k];
    add('lamps', K.quad(b0, b1, t1, t0, null, [0, 0, Math.max(1, Math.round(w / 5)), Math.max(1, Math.round(h / 5))]));
    add('paint', K.quad(off(b0, 1.4), off(b1, 1.4), off(t1, 1.4), off(t0, 1.4), '#2a2d31'));
    add('steel', K.beam([b0[0], y - 0.6, b0[2]], [b1[0], y - 0.6, b1[2]], 0.8, 0.8, '#2f3337'));
    add('steel', K.beam([t0[0], y + h + 0.6, t0[2]], [t1[0], y + h + 0.6, t1[2]], 0.8, 0.8, '#2f3337'));
    for (let k = 1; k < Math.round(w / 8); k++) { const f = k / Math.round(w / 8); add('steel', K.beam([lerp(b0[0], b1[0], f), y, lerp(b0[2], b1[2], f)], [lerp(t0[0], t1[0], f), y + h, lerp(t0[2], t1[2], f)], 0.35, 0.35, '#2f3337')); }
    if (LOOK.glare > 0) {
      const nx = Math.max(2, Math.round(w / 8)), ny = Math.max(1, Math.round(h / 8));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const fu = (i + 0.5) / nx, fv = (j + 0.5) / ny;
        const px = lerp(b0[0], b1[0], fu) + fx * (h * tilt * fv + 1.5), pz = lerp(b0[2], b1[2], fu) + fz * (h * tilt * fv + 1.5), py = y + h * fv;
        glare.push(px, py, pz, 8 + 4 * LOOK.glare, 1, 0.98, 0.93, 0.75 * LOOK.glare);
      }
      glare.push(x + fx * 4, y + h / 2, z + fz * 4, Math.max(w, h) * 1.3, 1, 0.96, 0.9, 0.24 * LOOK.glare);
    }
  }
  const TOWERS = [];
  for (const s of [-28, 28]) {
    const r = fenceAt(s) + CON.d1 + 6, [x, , z] = polar(s, r), top = 150;
    add('steel', K.cyl(x, 0, z, x, top, z, 3.4, 1.8, 8, '#2b2e32', false));
    add('paint', K.box(x, top - 1, z, 14, 2, 14, '#2b2e32', -s * D2R));
    add('steel', K.beam([x, top - 10, z], [x, top, z], 0.1, 0.1, '#2b2e32'));
    lightBank(x, top + 1, z, 46, 21, [0, 25, -120], 0.26);
    // banners on the pole (fictional: neighbourhood / year the park opened)
    const t = dirXZ(s + 90), n = dirXZ(s), w = 7, y0 = 62, y1 = 104;
    const p = [x - n[0] * 3.6, z - n[1] * 3.6];
    for (const [k, txt] of [[-1, 'SOUTH SIDE'], [1, 'EST. 1991']]) {
      const cx = p[0] + t[0] * k * (w / 2 + 0.2), cz = p[1] + t[1] * k * (w / 2 + 0.2);
      SIGNS.push({ kind: 'banner', text: txt, quad: [[cx - t[0] * w / 2, y0, cz - t[1] * w / 2], [cx + t[0] * w / 2, y0, cz + t[1] * w / 2], [cx + t[0] * w / 2, y1, cz + t[1] * w / 2], [cx - t[0] * w / 2, y1, cz - t[1] * w / 2]] });
    }
    TOWERS.push({ s, x, z, top });
  }

  mark('grandstand');
  // ======================================================================
  // GRANDSTAND — 100 level, 200 suites, 300 club, 400 press level, steep 500 upper deck under a flat
  // roof on black wrought-iron-style trusses. All four levels stop at the foul poles.
  // v = offset from the field wall (outward), y = height.
  // ======================================================================
  const GSP = {
    low: { v0: 1.5, v1: 86, y0: 6, y1: 36, rows: 30 },
    suite: { v: 66, y0: 37.5, glass: [39, 49], ribbon: [50.5, 53] },
    club: { v0: 66.5, v1: 84, y0: 53.5, y1: 59.5, rows: 5 },
    press: { v: PK.booth.pos[2] - C.foul.backstop, y0: 69, glass: [71, 85], top: 86.5 },   // booth window face = PARKS.rate.booth
    fascia: { v: 55, ribbon: [88, 91.2] },
    up: { v0: 57, v1: 146, y0: 92.5, y1: 146, rows: 32 },
    screen: { v: 150, y1: 157 },
    roof: { v0: 84, v1: 162, y0: 165, y1: 170 },
    ext: 162,
  };
  const gsLow = gsPathFor(LpR + 20, LpL + 20, 22);
  const gsUp = gsPathFor(LpR - 8, LpL - 8, 22);
  const GS_LEN = lineLen(offsetLine(gsUp, 0));
  // field wall + cap
  add('pads', sweep(gsLow, { pts: [[0, 0], [0, C.wallH]], uScale: 20, vFixed: [0.2, 1] }));
  add('paint', sweep(gsLow, { pts: [[0, C.wallH], [GSP.low.v0, C.wallH], [GSP.low.v0, GSP.low.y0]], color: '#121a16' }));
  // 100 level
  const lowShade = v => (v > GSP.suite.v + 2 ? 1 : 0);
  const low = seating(gsLow, { ...GSP.low, aisle: 46, aisleW: 4, section: SECTION.lower, fill: 0.95, kindAt: lowShade });
  add('paint', sweep(gsLow, { pts: [[GSP.low.v1, GSP.low.y1], [92, GSP.low.y1], [92, 40.5]], color: '#6d6d68' }));
  add('precast', sweep(gsLow, { pts: [[92.3, 0], [92.3, 40.5]], uScale: 40, vFixed: [0, 40.5 / 40], extra: { fv: FV(0) } }));
  // lower-bowl end caps (stepped) at the outfield corners
  {
    const ol = [[0, 0], [0, C.wallH], [GSP.low.v0, C.wallH]];
    for (let k = 0; k < GSP.low.rows; k++) { const vA = GSP.low.v0 + k * low.dv, yk = GSP.low.y0 + k * low.dy; ol.push([vA, yk], [vA + low.dv, yk]); }
    ol.push([92, GSP.low.y1], [92, 40.5], [92.3, 40.5], [92.3, 0]);
    for (const e of [gsLow[0], gsLow[gsLow.length - 1]]) capAt(e.p, e.n, ol, null, 'precast', [40, 40], { fv: FV(1) });
  }
  // 200 suites: soffit, glass, ribbon
  const S2 = GSP.suite;
  add('paint', sweep(gsUp, { pts: [[92, S2.y0], [S2.v, S2.y0], [S2.v, S2.glass[0]]], color: '#2c2e30' }));
  add('glass', sweep(gsUp, { pts: [[S2.v, S2.glass[0]], [S2.v, S2.glass[1]]], uScale: 24, vFixed: [0, 1] }));
  add('paint', sweep(gsUp, { pts: [[S2.v, S2.glass[1]], [S2.v, S2.ribbon[0]]], color: '#1b1c1d' }));
  add('ribbon', sweep(gsUp, { pts: [[S2.v - 0.05, S2.ribbon[0]], [S2.v - 0.05, S2.ribbon[1]]], uScale: 100, vFixed: [0, 1] }));
  add('paint', sweep(gsUp, { pts: [[S2.v, S2.ribbon[1]], [GSP.club.v0, GSP.club.y0]], color: '#1b1c1d' }));
  // 300 club seats + club concourse glass
  seating(gsUp, { ...GSP.club, aisle: 60, aisleW: 4, section: SECTION.club, fill: 0.85, kindAt: () => 1 });
  add('glass', sweep(gsUp, { pts: [[GSP.club.v1, GSP.club.y1], [GSP.club.v1, GSP.press.y0]], uScale: 24, vFixed: [0, 1] }));
  // 400 level: soffit + press box / suite glass (booth windows behind home) + upper fascia with ribbon
  const P4 = GSP.press;
  add('paint', sweep(gsUp, { pts: [[GSP.club.v1, P4.y0], [P4.v, P4.y0], [P4.v, P4.glass[0]]], color: '#2a2c2e' }));
  add('glass', sweep(gsUp, { pts: [[P4.v, P4.glass[0]], [P4.v, P4.glass[1]]], uScale: 24, vFixed: [0, 1] }));
  add('paint', sweep(gsUp, { pts: [[P4.v, P4.glass[1]], [P4.v, P4.top], [GSP.fascia.v, P4.top], [GSP.fascia.v, GSP.fascia.ribbon[0]]], color: '#171819' }));
  add('ribbon', sweep(gsUp, { pts: [[GSP.fascia.v - 0.05, GSP.fascia.ribbon[0]], [GSP.fascia.v - 0.05, GSP.fascia.ribbon[1]]], uScale: 100, vFixed: [0, 1] }));
  add('paint', sweep(gsUp, { pts: [[GSP.fascia.v, GSP.fascia.ribbon[1]], [GSP.fascia.v, GSP.up.y0 - 0.5], [GSP.up.v0, GSP.up.y0 - 0.5], [GSP.up.v0, GSP.up.y0]], color: '#171819' }));
  // press-box window mullion glow strip + a booth sill (for the announcer push-in)
  // 500 level: steep upper deck
  const upShade = v => (v > GSP.roof.v0 + 4 ? 1 : 0);
  const up = seating(gsUp, { ...GSP.up, aisle: 50, aisleW: 4, section: SECTION.upper, fill: 0.9, kindAt: upShade, seatScale: 0.95 });
  add('paint', sweep(gsUp, { pts: [[GSP.up.v1, GSP.up.y1], [GSP.screen.v, GSP.up.y1]], color: '#6d6d68' }));
  add('screen', sweep(gsUp, { pts: [[GSP.screen.v, GSP.up.y1], [GSP.screen.v, GSP.screen.y1]], uScale: 32, vFixed: [0, 1] }));
  add('paint', sweep(gsUp, { pts: [[GSP.screen.v, GSP.screen.y1], [GSP.ext, GSP.screen.y1]], color: '#2b2c2d' }));
  // flat roof (+ black front fascia) ~20 ft above the top row, covering the back 2/3 of the 500 level
  const RF_ = GSP.roof;
  add('paint', sweep(gsUp, { pts: [[RF_.v1, RF_.y0], [RF_.v0, RF_.y0]], color: '#1c1d1e' }));
  add('paint', sweep(gsUp, { pts: [[RF_.v0, RF_.y0], [RF_.v0, RF_.y1]], color: '#0c0c0c' }));
  add('paint', sweep(gsUp, { pts: [[RF_.v0, RF_.y1], [RF_.v1, RF_.y1], [RF_.v1, RF_.y0]], color: '#5c5e5f' }));
  // exterior precast facade (4 stacked bands: arches, openings, ramp slots, dark steel)
  for (let k = 0; k < 4; k++) add('precast', sweep(gsUp, { pts: [[GSP.ext, k * 40], [GSP.ext, Math.min(k * 40 + 40, GSP.screen.y1)]], uScale: 40, vFixed: [0, (Math.min(k * 40 + 40, GSP.screen.y1) - k * 40) / 40], extra: { fv: FV(k) } }));
  // exterior piers (vertical rhythm) + two zig-zag ramp towers behind the 1B / 3B ends
  walk(offsetLine(gsUp, GSP.ext + 1.2), 40, (x, z, tx, tz) => add('paint', K.box(x, GSP.screen.y1 / 2, z, 3.2, GSP.screen.y1, 2.4, '#cbc7bc', -Math.atan2(tz, tx))));
  for (const sg of [1, -1]) {
    const u = 236, q = { p: foulPt(sg, u), n: [sg * SQ, SQ] }, t = [-SQ * sg, SQ * 0 - SQ], L = 72, D = 54;
    const tt = [sg * SQ, -SQ];                                    // along the line
    const o = [q.p[0] + q.n[0] * (GSP.ext + 4 + D / 2), q.p[1] + q.n[1] * (GSP.ext + 4 + D / 2)];
    const at = (a, b, y) => [o[0] + tt[0] * a + q.n[0] * b, y, o[1] + tt[1] * a + q.n[1] * b];
    for (const [a, b] of [[-L / 2, -D / 2], [L / 2, -D / 2], [-L / 2, D / 2], [L / 2, D / 2]]) { const c0 = at(a, b, 0); add('paint', K.box(c0[0], 71, c0[2], 4, 142, 4, '#c9c5ba')); }
    for (let k = 0; k < 6; k++) {
      const y0 = k * 23, y1 = y0 + 23, dir = k % 2 ? -1 : 1;
      for (const b of [-D / 4, D / 4]) {
        const bb = k % 2 ? b : b;
        const A = at(-L / 2 * dir, bb - D / 4 + 1, y0), B = at(L / 2 * dir, bb - D / 4 + 1, y1), Cc = at(L / 2 * dir, bb + D / 4 - 1, y1), Dd = at(-L / 2 * dir, bb + D / 4 - 1, y0);
        if (b > 0 === (k % 2 === 0)) { add('paint', K.quad(A, B, Cc, Dd, '#b9b5ab')); add('paint', K.quad(Dd, Cc, B, A, '#8f8b83')); add('steel', K.beam([A[0], A[1] + 3.5, A[2]], [B[0], B[1] + 3.5, B[2]], 0.3, 0.3, '#1b1b1b')); }
      }
      const f = at(-L / 2, -D / 2 - 0.1, y1 - 1.2), g2 = at(L / 2, -D / 2 - 0.1, y1 - 1.2);
      add('paint', K.quad([f[0], y1 - 3, f[2]], [g2[0], y1 - 3, g2[2]], [g2[0], y1, g2[2]], [f[0], y1, f[2]], '#d3cfc5'));
    }
  }
  // upper-structure end caps at the poles
  {
    const olA = [[92, 0], [92, S2.y0], [S2.v, S2.y0], [S2.v, GSP.club.y0], [GSP.club.v1, GSP.club.y1], [GSP.club.v1, P4.y0], [P4.v, P4.y0], [P4.v, P4.top], [GSP.fascia.v, P4.top], [GSP.fascia.v, GSP.up.y0 - 0.5], [GSP.up.v0, GSP.up.y0], [GSP.up.v1, GSP.up.y1], [GSP.screen.v, GSP.screen.y1], [GSP.ext, GSP.screen.y1], [GSP.ext, 0]];
    const olB = [[RF_.v0, RF_.y0], [RF_.v0, RF_.y1], [RF_.v1, RF_.y1], [RF_.v1, RF_.y0]];
    for (const e of [gsUp[0], gsUp[gsUp.length - 1]]) { capAt(e.p, e.n, olA, null, 'precast', [40, 40], { fv: FV(1) }); capAt(e.p, e.n, olB, '#0c0c0c'); }
  }
  // exposed black lattice truss along the roof's front edge (+ small ornamental rings)
  {
    const v = RF_.v0 + 0.4, yb = RF_.y0 - 7.5, yt = RF_.y0 - 0.2;
    add('steel', sweep(gsUp, { pts: [[v - 0.6, yb], [v + 0.6, yb]], color: C.steel }));
    add('steel', sweep(gsUp, { pts: [[v, yb - 0.5], [v, yb + 0.5]], color: C.steel }));
    const line = offsetLine(gsUp, v); let k = 0;
    walk(line, LO ? 12 : 6.5, (x, z, tx, tz) => {
      const h = LO ? 12 : 6.5, s = (k++ % 2) ? 1 : -1;
      add('steel', K.beam([x - tx * h / 2 * s, yb, z - tz * h / 2 * s], [x + tx * h / 2 * s, yt, z + tz * h / 2 * s], 0.35, 0.35, C.steel));
      if (!LO && k % 4 === 0) { const cy = (yb + yt) / 2, rr = 1.6; for (let j = 0; j < 6; j++) { const a0 = j / 6 * Math.PI * 2, a1 = (j + 1) / 6 * Math.PI * 2; add('steel', K.beam([x + tx * Math.cos(a0) * rr, cy + Math.sin(a0) * rr, z + tz * Math.cos(a0) * rr], [x + tx * Math.cos(a1) * rr, cy + Math.sin(a1) * rr, z + tz * Math.cos(a1) * rr], 0.2, 0.2, C.steel)); } }
    });
  }
  // black steel trusses with wrought-iron-style ornament under the roof
  {
    const every = LO ? 64 : 38, cols = [];
    walk(offsetLine(gsUp, 0), every, (x0, z0, tx, tz, dist, i) => cols.push(pathAt(gsUp, i + clamp((() => { const a = gsUp[i].p, b = gsUp[i + 1].p, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return Math.hypot(x0 - a[0], z0 - a[1]) / L; })(), 0, 1))));
    const P = (q, v, y) => [q.p[0] + q.n[0] * v, y, q.p[1] + q.n[1] * v];
    const colV = GSP.ext - 3, y0 = RF_.y0 - 0.4;
    for (const q of cols) {
      add('steel', K.beam(P(q, colV, GSP.up.y1 - 6), P(q, colV, y0), 1.8, 1.8, C.steel));                    // back column
      const chord = []; const nSeg = 8;
      for (let k = 0; k <= nSeg; k++) { const f = k / nSeg, v = lerp(colV, RF_.v0 + 1, f); chord.push([v, lerp(y0 - 9, y0 - 2.2, f) - Math.sin(f * Math.PI) * 1.4]); }
      for (let k = 0; k < nSeg; k++) {
        add('steel', K.beam(P(q, chord[k][0], chord[k][1]), P(q, chord[k + 1][0], chord[k + 1][1]), 0.9, 0.9, C.steel));   // bottom chord (arched)
        add('steel', K.beam(P(q, chord[k][0], y0), P(q, chord[k + 1][0], y0), 1.1, 1.1, C.steel));                          // top chord
        const m = [(chord[k][0] + chord[k + 1][0]) / 2, (chord[k][1] + chord[k + 1][1]) / 2];
        add('steel', K.beam(P(q, chord[k][0], chord[k][1]), P(q, m[0], y0), 0.45, 0.45, C.steel));                          // warren web
        add('steel', K.beam(P(q, m[0], y0), P(q, chord[k + 1][0], chord[k + 1][1]), 0.45, 0.45, C.steel));
        if (!LO) { // ornament: a small ring in each bay (wrought-iron look)
          const cx = m[0], cy = (m[1] + y0) / 2 + 0.4, rr = Math.min(1.5, (y0 - m[1]) * 0.32), nR = 6;
          for (let j = 0; j < nR; j++) { const a0 = j / nR * Math.PI * 2, a1 = (j + 1) / nR * Math.PI * 2; add('steel', K.beam(P(q, cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr), P(q, cx + Math.cos(a1) * rr, cy + Math.sin(a1) * rr), 0.22, 0.22, C.steel)); }
        }
      }
      add('steel', K.beam(P(q, RF_.v0 + 1, chord[nSeg][1]), P(q, RF_.v0 + 1, y0), 0.8, 0.8, C.steel));
    }
    // longitudinal purlins under the roof
    for (const v of [RF_.v0 + 1, lerp(RF_.v0, colV, 0.5), colV]) add('steel', sweep(gsUp, { pts: [[v - 0.5, y0], [v + 0.5, y0]], color: C.steel }));
  }
  // roof light banks along the front edge of the roof
  {
    const line = offsetLine(gsUp, RF_.v0 + 6);
    walk(line, LO ? 110 : 78, (x, z, tx, tz, dist, i) => {
      const q = pathAt(gsUp, i + 0.5); const a = [x - q.n[0] * 200, 20, z - q.n[1] * 200];
      add('steel', K.box(x, RF_.y1 + 2, z, 2, 4, 2, '#1a1a1a'));
      lightBank(x, RF_.y1 + 4, z, 32, 12, a, 0.34);
    });
  }
  // backstop + line netting (since 2019: dugout to the foul pole)
  {
    const sub = gsLow.filter(q => q.side === 0 || q.u <= LpR - 6);
    const netH = q => (q.side === 0 ? 32 : lerp(32, C.wallH + 9, smooth(40, 160, q.u)));
    const rows = sub.map(q => [[q.p[0] - q.n[0] * 0.4, C.wallH, q.p[1] - q.n[1] * 0.4], [q.p[0] - q.n[0] * 0.4, netH(q), q.p[1] - q.n[1] * 0.4]]);
    let acc = 0; const uvs = rows.map((r, i) => { if (i) acc += Math.hypot(r[0][0] - rows[i - 1][0][0], r[0][2] - rows[i - 1][0][2]); return [[acc / 0.5, 0], [acc / 0.5, (r[1][1] - r[0][1]) / 0.5]]; });
    add('net', K.grid(rows, uvs, null));
    add('steel', K.grid(sub.map(q => [[q.p[0] - q.n[0] * 0.4, netH(q) - 0.5, q.p[1] - q.n[1] * 0.4], [q.p[0] - q.n[0] * 0.4, netH(q), q.p[1] - q.n[1] * 0.4]]), null, '#1a1a1a'));
  }
  // dugouts (home = 3B side)
  for (const sg of [1, -1]) {
    const a = foulPt(sg, 60), b = foulPt(sg, 126);
    const N = [sg * SQ, SQ]; const ax = a[0] - N[0] * 0.12, az = a[1] - N[1] * 0.12, bx = b[0] - N[0] * 0.12, bz = b[1] - N[1] * 0.12;
    add('paint', K.quad([ax, 0.02, az], [bx, 0.02, bz], [bx, C.wallH - 0.4, bz], [ax, C.wallH - 0.4, az], '#0b0d0c'));
    add('paint', K.quad([ax - N[0] * 1.2, C.wallH - 0.4, az - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH - 0.4, bz - N[1] * 1.2], [bx + N[0] * 8, C.wallH - 0.4, bz + N[1] * 8], [ax + N[0] * 8, C.wallH - 0.4, az + N[1] * 8], '#17191b'));
    add('paint', K.quad([ax - N[0] * 1.2, C.wallH - 0.4, az - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH - 0.4, bz - N[1] * 1.2], [bx - N[0] * 1.2, C.wallH + 0.3, bz - N[1] * 1.2], [ax - N[0] * 1.2, C.wallH + 0.3, az - N[1] * 1.2], '#1E3F2E'));
    add('steel', K.wallBox(ax - N[0] * 1.0, az - N[1] * 1.0, bx - N[0] * 1.0, bz - N[1] * 1.0, 0.15, C.wallH + 0.3, C.wallH + 3.2, '#8a9096'));
  }
  // foul poles (yellow) + fair-side screens
  for (const sg of [-1, 1]) {
    const r = fenceAt(45 * sg), [x, , z] = polar(45 * sg, r);
    add('paint', K.cyl(x, 0, z, x, C.poleH, z, 0.8, 0.55, 10, C.pole || '#F4C300'));
    const t = dirXZ(45 * sg - 90 * sg);
    add('chain', K.quad([x, H0 + 1, z], [x + t[0] * 2.4, H0 + 1, z + t[1] * 2.4], [x + t[0] * 2.4, C.poleH - 4, z + t[1] * 2.4], [x, C.poleH - 4, z], null, [0, 0, 1.6, (C.poleH - H0) / 1.5]));
    add('paint', K.quad([x + t[0] * 2.4, H0 + 1, z + t[1] * 2.4], [x + t[0] * 2.5, H0 + 1, z + t[1] * 2.5], [x + t[0] * 2.5, C.poleH - 4, z + t[1] * 2.5], [x + t[0] * 2.4, C.poleH - 4, z + t[1] * 2.4], '#F4C300'));
  }

  mark('outside');
  // ======================================================================
  // OUTSIDE THE PARK — compass-aligned South Side: the Dan Ryan (14 lanes + the CTA Red Line in the
  // median) just east of the park, parking lots north (old Comiskey site) and south, Bridgeport's
  // low-rise grid to the west, mid/high-rise towers across the expressway.
  // compass coords: e = dot(p, E), n = dot(p, N)   (home plate = origin)
  // ======================================================================
  const E_ = COMPASS.E, N_ = COMPASS.N;
  const toW = (e, n) => [E_[0] * e + N_[0] * n, E_[1] * e + N_[1] * n];
  const RYAN = { e: 820, half: 150, len: 7000 };
  const LOTS = [{ e0: -640, e1: 640, n0: 250, n1: 1060 }, { e0: -620, e1: 600, n0: -1180, n1: -470 }, { e0: 470, e1: 640, n0: -470, n1: 250 }, { e0: -640, e1: -300, n0: -470, n1: 250 }];
  const PLZ = { cz: -150, rx: 470, rz: 420 };                 // plaza ellipse round the park footprint
  const rPlaza = 470;
  const inLot = (e, n) => LOTS.some(L => e > L.e0 && e < L.e1 && n > L.n0 && n < L.n1);
  const clearOfPark = (x, z, m = 0) => Math.hypot(x / (PLZ.rx + m), (z - PLZ.cz) / (PLZ.rz + m)) > 1;
  // ---- ground (one draw call, procedural zones)
  {
    const g = new THREE.CircleGeometry(9000, 120); g.rotateX(-Math.PI / 2); g.translate(0, -0.3, 0);
    M.ground = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0, color: col('#ffffff') });
    const gU = { uNoise: { value: T.noise }, uE: { value: new THREE.Vector2(E_[0], E_[1]) }, uN: { value: new THREE.Vector2(N_[0], N_[1]) }, uRyan: { value: RYAN.e }, uNight: { value: NIGHT }, uWet: { value: LOOK.wet }, uPlaza: { value: new THREE.Vector3(PLZ.rx, PLZ.rz, PLZ.cz) } };
    const lotsGLSL = LOTS.map(L => `max(max(${L.e0.toFixed(1)} - e, e - ${L.e1.toFixed(1)}), max(${L.n0.toFixed(1)} - n, n - ${L.n1.toFixed(1)}))`).reduce((a, b) => `min(${a}, ${b})`);
    M.ground.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, gU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWP; uniform sampler2D uNoise; uniform vec2 uE, uN; uniform float uRyan, uNight, uWet; uniform vec3 uPlaza;
vec3 gPool;
float lineAA(float d, float hw){ float w = fwidth(d) + 1e-3; return 1.0 - smoothstep(hw - w, hw + w, abs(d)); }
float sdLots(float e, float n){ return ${lotsGLSL}; }
vec3 groundColor(){
  vec2 p = vWP.xz; float e = dot(p, uE), n = dot(p, uN), r = length(p);
  float nz = texture2D(uNoise, p / 173.0).r, nm = texture2D(uNoise, p / 23.0).g, nf = texture2D(uNoise, p / 3.1).b;
  vec3 asph = vec3(0.20, 0.205, 0.215) * mix(0.85, 1.12, nm) * mix(0.9, 1.08, nf);
  vec3 conc = vec3(0.50, 0.495, 0.47) * mix(0.9, 1.06, nm);
  vec3 grass = vec3(0.21, 0.30, 0.14) * mix(0.75, 1.15, nz) * mix(0.85, 1.1, nf);
  vec3 c; gPool = vec3(0.0);
  float dl = sdLots(e, n);
  float dr = abs(e - uRyan);
  if (length(vec2(p.x / uPlaza.x, (p.y - uPlaza.z) / uPlaza.y)) < 1.0) {   // plaza + service roads round the park
    c = conc * mix(0.92, 1.0, lineAA(mod(e, 20.0) - 10.0, 9.7)) * mix(0.92, 1.0, lineAA(mod(n, 20.0) - 10.0, 9.7));
    gPool = vec3(1.0, 0.86, 0.66) * 0.10;
  } else if (dr < 150.0) {                             // the Dan Ryan
    float d = dr;
    if (d < 30.0) {                                    // median: CTA Red Line on ballast
      c = vec3(0.33, 0.30, 0.27) * mix(0.8, 1.1, nf);
      float rails = max(max(lineAA(d - 5.6, 0.25), lineAA(d - 10.4, 0.25)), max(lineAA(d - 17.6, 0.25), lineAA(d - 22.4, 0.25)));
      c = mix(c, vec3(0.12, 0.11, 0.1), rails);
      c = mix(c, vec3(0.24, 0.2, 0.16), lineAA(mod(n, 2.5) - 1.25, 0.35) * (step(d, 12.0) * step(4.0, d) + step(d, 24.0) * step(16.0, d)) * 0.6);
    } else if (d < 132.0) {
      c = asph * 0.95;
      float dash = step(0.5, fract(n / 40.0));
      float lanes = max(max(lineAA(d - 42.0, 0.3), lineAA(d - 54.0, 0.3)), max(lineAA(d - 66.0, 0.3), max(lineAA(d - 102.0, 0.3), lineAA(d - 114.0, 0.3)))) * dash;
      float edges = max(max(lineAA(d - 31.5, 0.35), lineAA(d - 77.0, 0.35)), max(lineAA(d - 91.0, 0.35), lineAA(d - 130.5, 0.35)));
      c = mix(c, vec3(0.85), lanes * 0.8);
      c = mix(c, vec3(0.86, 0.76, 0.35), edges * 0.7);
      if (d > 78.0 && d < 90.0) c = conc * 0.8;
      gPool = vec3(1.0, 0.8, 0.55) * 0.07 * (0.6 + 0.4 * lineAA(mod(n, 160.0) - 80.0, 30.0));
    } else c = grass * 0.9;
  } else if (dl < 0.0) {                               // parking lots: stalls, aisles, light-pole pools
    c = asph * 1.05;
    float rn = mod(n, 62.0), re = mod(e, 9.0);
    float stall = (step(rn, 18.0) + step(44.0, rn)) * lineAA(re - 4.5, 4.28);
    c = mix(c, vec3(0.82), stall * 0.75);
    c = mix(c, vec3(0.82), (lineAA(rn - 18.0, 0.25) + lineAA(rn - 44.0, 0.25)) * 0.5);
    vec2 q = vec2(mod(e, 150.0) - 75.0, mod(n, 124.0) - 31.0);
    gPool = vec3(1.0, 0.93, 0.8) * 0.42 * exp(-dot(q, q) / 2600.0);
    c = mix(c, conc, smoothstep(-8.0, 0.0, dl));        // curb
  } else {                                             // city grid (Bridgeport / Bronzeville)
    float be = mod(e - 140.0, 330.0), bn = mod(n + 30.0, 600.0);
    float dE = min(be, 330.0 - be), dN = min(bn, 600.0 - bn);
    float dS = min(dE, dN);
    if (dS < 21.0) {
      c = asph; c = mix(c, vec3(0.8, 0.72, 0.35), lineAA(dS, 0.25) * 0.5);
      gPool = vec3(1.0, 0.78, 0.5) * 0.16 * (0.4 + 0.6 * exp(-pow(mod((dE < dN ? n : e), 110.0) - 55.0, 2.0) / 900.0));
    } else if (dS < 33.0) { c = (dS > 23.0 && dS < 28.0) ? grass : conc; }
    else {
      c = grass;
      float alley = abs(be - 165.0);
      if (alley < 8.0) c = asph * 1.1;
      c = mix(c, vec3(0.34, 0.32, 0.30), step(0.6, texture2D(uNoise, p / 61.0).b) * 0.5);
    }
  }
  c *= mix(1.0, 0.72, uWet);
  return c;
}`)
        .replace('#include <map_fragment>', 'diffuseColor.rgb = groundColor();')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gPool * diffuseColor.rgb * 9.0 * uNight;');
    };
    const m = new THREE.Mesh(g, M.ground); m.receiveShadow = true; m.name = 'ground'; m.matrixAutoUpdate = false; m.updateMatrix(); m.renderOrder = -10;
    group.add(m); disposables.push(g, M.ground);
  }
  // ---- city massing on the compass grid (facade atlas), trees
  {
    const nearR = LO ? 1500 : quality === 'medium' ? 2100 : 2600, farR = LO ? 2600 : 4200;
    const roofCols = ['#4a4845', '#5e5a55', '#3f3d3b', '#55524e', '#6a655e'];
    const box = (e0, e1, n0, n1, h, variant) => {
      const P = [toW(e0, n0), toW(e1, n0), toW(e1, n1), toW(e0, n1)];
      const k = 0.78 + R() * 0.34, warm = (R() - 0.5) * 0.12, tint = `rgb(${Math.round(255 * clamp(k + warm, 0, 1))},${Math.round(255 * k)},${Math.round(255 * clamp(k - warm, 0, 1))})`;
      for (let k = 0; k < 4; k++) {
        const p = P[k], q = P[(k + 1) % 4], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        rawQuad('facade', [p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], h, q[1]], [p[0], h, p[1]], tint, [0, 1 - h / 52, L / 40, 1], { fv: FV(variant) });
      }
      rawQuad('paint', [P[0][0], h, P[0][1]], [P[1][0], h, P[1][1]], [P[2][0], h, P[2][1]], [P[3][0], h, P[3][1]], pick(R, roofCols));
    };
    const okLot = (e, n, m = 0) => { const [x, z] = toW(e, n); return clearOfPark(x, z, 40 + m) && Math.abs(e - RYAN.e) > RYAN.half + 40 && !LOTS.some(L => e > L.e0 - 30 && e < L.e1 + 30 && n > L.n0 - 30 && n < L.n1 + 30); };
    let nTrees = 0; const maxTrees = LO ? 120 : quality === 'medium' ? 260 : 440;
    const greens = ['#2f5a2a', '#3a6a30', '#2a4f26', '#44702f', '#35622d', '#2d5b33'];
    for (let ia = -12; ia <= 14; ia++) for (let ib = -9; ib <= 9; ib++) {
      const a0 = ia * 330 + 140 + 33, a1 = (ia + 1) * 330 + 140 - 33, b0 = ib * 600 - 30 + 33, b1 = (ib + 1) * 600 - 30 - 33;
      const [cx, cz] = toW((a0 + a1) / 2, (b0 + b1) / 2), rc = Math.hypot(cx, cz);
      if (rc > farR) continue;
      const east = a0 > RYAN.e + RYAN.half;
      if (rc > nearR) { // far massing
        for (const [e0, e1] of [[a0 + 4, a0 + 90], [a1 - 90, a1 - 4]]) {
          let b = b0 + 4;
          while (b < b1 - 30) { const len = Math.min(b1 - 4 - b, 90 + R() * 150); if (okLot((e0 + e1) / 2, b + len / 2)) { const h = east ? 40 + R() * 60 : 26 + R() * 18; box(e0, e1, b, b + len, h, east ? (R() < 0.5 ? 2 : 3) : Math.floor(R() * 2)); } b += len + 10 + R() * 12; }
        }
        continue;
      }
      for (const sd of [0, 1]) { // lots fronting the N-S streets
        let b = b0 + 4;
        while (b < b1 - 10) {
          const w = east ? pick(R, [40, 60, 80]) : pick(R, [25, 25, 25, 30, 37, 50]), gap = east ? 12 + R() * 20 : 3 + R() * 5;
          if (b + w > b1 - 4) break;
          const dep = east ? 60 + R() * 40 : 50 + R() * 24, e0 = sd ? a1 - 8 - dep : a0 + 8, e1 = sd ? a1 - 8 : a0 + 8 + dep;
          if (okLot((e0 + e1) / 2, b + w / 2)) {
            const h = east ? (R() < 0.25 ? 70 + R() * 40 : 34 + R() * 24) : (R() < 0.55 ? 24 + R() * 8 : 32 + R() * 10);
            box(e0, e1, b, b + w, h, east ? (h > 60 ? 3 : 2) : (R() < 0.7 ? 0 : 1));
            if (nTrees < maxTrees && R() < (east ? 0.3 : 0.55)) {
              const ta = sd ? a1 + 5 : a0 - 5, [tx, tz] = toW(ta, b + w / 2);
              if (clearOfPark(tx, tz, 10)) { nTrees++; tree(tx, tz, 9 + R() * 8, pick(R, greens)); }
            }
          }
          b += w + gap;
        }
      }
    }
    // towers across the Dan Ryan (mid/high-rise slabs) — the "towers" seen past LF
    const towers = [[1350, -760, 150, 70], [1480, -300, 176, 60], [1650, 180, 190, 75], [1900, -1050, 140, 90], [2150, -520, 205, 70], [2400, 80, 168, 64], [2250, 520, 150, 60], [1750, -1400, 132, 80]];
    for (const [e, n, h, w] of towers) box(e - w / 2, e + w / 2, n - 55, n + 55, h, h > 160 ? 3 : 2);
    // IIT-style low campus blocks just across the expressway
    for (let k = 0; k < 8; k++) { const e = RYAN.e + RYAN.half + 90 + (k % 4) * 110, n = -300 + Math.floor(k / 4) * 260 + R() * 40; box(e - 40, e + 40, n - 70, n + 70, 30 + R() * 22, 3); }
    // park trees along the plaza edge + Armour Square park (south-west)
    for (let k = 0; k < (LO ? 30 : 70); k++) { const a = R() * Math.PI * 2, rr = rPlaza + 10 + R() * 40, x = Math.cos(a) * rr, z = Math.sin(a) * rr; const [e, n] = [x * E_[0] + z * E_[1], x * N_[0] + z * N_[1]]; if (!inLot(e, n) && Math.abs(e - RYAN.e) > RYAN.half + 5) tree(x, z, 10 + R() * 6, pick(R, greens)); }
    for (let k = 0; k < (LO ? 30 : 80); k++) { const [x, z] = toW(-700 + R() * 300, -1000 + R() * 420); tree(x, z, 11 + R() * 7, pick(R, greens)); }
  }
  // ---- expressway structure: barriers, the 35th St bridge + Sox-35th station canopy, sound walls
  {
    const ln = (e, n0, n1) => { const a = toW(e, n0), b = toW(e, n1); return [a, b]; };
    for (const e of [RYAN.e - 30, RYAN.e + 30, RYAN.e - 84, RYAN.e + 84]) { const [a, b] = ln(e, -RYAN.len / 2, RYAN.len / 2); add('paint', K.wallBox(a[0], a[1], b[0], b[1], 1.6, 0, 3.4, '#8f8e88')); }
    for (const e of [RYAN.e - 136, RYAN.e + 136]) { const [a, b] = ln(e, -RYAN.len / 2, RYAN.len / 2); add('paint', K.wallBox(a[0], a[1], b[0], b[1], 1.2, 0, 4, '#7d7c77')); }
    const nB = 290; // 35th Street bridge
    const a = toW(RYAN.e - 175, nB), b = toW(RYAN.e + 175, nB), t = [N_[0], N_[1]];
    for (const off of [-28, 28]) add('paint', K.wallBox(a[0] + t[0] * off, a[1] + t[1] * off, b[0] + t[0] * off, b[1] + t[1] * off, 2, 17, 21.5, '#9a9890'));
    { const A = toW(RYAN.e - 175, nB - 28), B = toW(RYAN.e + 175, nB - 28), Cc = toW(RYAN.e + 175, nB + 28), Dd = toW(RYAN.e - 175, nB + 28); add('paint', K.quad([A[0], 18, A[1]], [B[0], 18, B[1]], [Cc[0], 18, Cc[1]], [Dd[0], 18, Dd[1]], '#3d3e40')); add('paint', K.quad([Dd[0], 16.8, Dd[1]], [Cc[0], 16.8, Cc[1]], [B[0], 16.8, B[1]], [A[0], 16.8, A[1]], '#55544f')); }
    for (const e of [RYAN.e - 92, RYAN.e - 36, RYAN.e + 36, RYAN.e + 92]) { const p = toW(e, nB); add('paint', K.box(p[0], 8.5, p[1], 5, 17, 40, '#8b8a84', -Math.atan2(N_[1], N_[0]))); }
    // station platform + canopy in the median, just south of the bridge
    const s0 = toW(RYAN.e, nB - 40), s1 = toW(RYAN.e, nB - 420);
    add('paint', K.wallBox(s0[0], s0[1], s1[0], s1[1], 14, 0, 3.8, '#8e8d86'));
    add('paint', K.wallBox(s0[0], s0[1], s1[0], s1[1], 18, 14, 15.2, '#2a2e33'));
    walk([s0, s1], 40, (x, z) => add('steel', K.box(x, 9, z, 0.8, 11, 0.8, '#2a2e33')));
  }
  // ---- parking-lot light poles + parked cars (instanced)
  const lotPoles = [];
  for (const L of LOTS) for (let e = Math.ceil(L.e0 / 150) * 150 + 75; e < L.e1; e += 150) for (let n = Math.ceil(L.n0 / 124) * 124 + 31; n < L.n1; n += 124) lotPoles.push(toW(e, n));
  for (const [x, z] of lotPoles) {
    if (!clearOfPark(x, z, 0)) continue;
    add('steel', K.cyl(x, 0, z, x, 42, z, 0.6, 0.4, 6, '#55595e'));
    add('paint', K.box(x, 42.5, z, 7, 1, 2, '#2a2c2e', -Math.atan2(N_[1], N_[0])));
    if (NIGHT > 0.2) glowPts.push(x, 41.6, z, 18, 1, 0.9, 0.72, 0.55 * NIGHT);
  }
  let carMesh = null;
  {
    const slots = [];
    const stride = LO ? 6 : quality === 'medium' ? 3 : 2;
    let c = 0;
    for (const L of LOTS) for (let n0 = Math.ceil(L.n0 / 62) * 62; n0 < L.n1 - 20; n0 += 62) for (const row of [9, 53]) for (let e = L.e0 + 8; e < L.e1 - 8; e += 9) {
      if ((c++ % stride) !== 0) continue;
      const n = n0 + row; if (n > L.n1 - 8) continue;
      const [x, z] = toW(e + 4.5, n); if (!clearOfPark(x, z, 4)) continue;
      if (R() < (tod === 'night' ? 0.28 : 0.2)) continue;
      slots.push([x, z]);
    }
    const body = new THREE.BoxGeometry(6.2, 3.1, 15).translate(0, 1.95, 0), cab = new THREE.BoxGeometry(5.4, 2.2, 7.4).translate(0, 4.4, -0.8);
    const g = K.merge([K.finish(body), K.finish(cab)]);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.55 });
    carMesh = new THREE.InstancedMesh(g, mat, slots.length);
    const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), yA = new THREE.Vector3(0, 1, 0), ang = Math.atan2(E_[0], E_[1]);
    const carCols = ['#1d1f22', '#e8e8e6', '#8d9196', '#2b3e63', '#7a1c1c', '#c9ccce', '#3d4a3a', '#151515', '#5e6c7c', '#b0a58d'];
    slots.forEach(([x, z], i) => { q.setFromAxisAngle(yA, ang + (R() - 0.5) * 0.05); mm.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1)); carMesh.setMatrixAt(i, mm); carMesh.setColorAt(i, col(pick(R, carCols))); });
    carMesh.castShadow = false; carMesh.receiveShadow = true; carMesh.name = 'cars'; carMesh.frustumCulled = false;
    group.add(carMesh); disposables.push(g, mat);
  }
  // ---- Dan Ryan traffic + Red Line trains: instanced boxes moved in the vertex shader
  const traffic = (() => {
    const lanes = [];                                // [eOffset, dir(+1 = northbound)]
    for (const d of [36, 48, 60, 72, 96, 108, 120]) { lanes.push([d, 1]); lanes.push([-d, -1]); }
    const perLane = LO ? 14 : quality === 'medium' ? 22 : 30, L = RYAN.len;
    const n = lanes.length * perLane;
    const base = new THREE.BoxGeometry(6, 4.4, 15).translate(0, 2.2, 0);
    const g = new THREE.InstancedBufferGeometry(); g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('normal', base.attributes.normal);
    const A = new Float32Array(n * 4), Cc = new Float32Array(n * 3);
    const cols = ['#1d1f22', '#e8e8e6', '#8d9196', '#2b3e63', '#7a1c1c', '#c9ccce', '#151515', '#5e6c7c', '#f2f2f0', '#3b3f45'];
    let i = 0;
    for (const [off, dir] of lanes) for (let k = 0; k < perLane; k++, i++) {
      A[i * 4] = off; A[i * 4 + 1] = dir; A[i * 4 + 2] = (k + R() * 0.7) / perLane * L; A[i * 4 + 3] = (Math.abs(off) < 80 ? 88 : 64) * (0.85 + R() * 0.3);
      const cc = col(pick(R, cols)); Cc[i * 3] = cc.r; Cc[i * 3 + 1] = cc.g; Cc[i * 3 + 2] = cc.b;
    }
    // trains (8 cars x 2 directions) share the same shader: lane = ±8 (median tracks), long cars
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 4)); g.setAttribute('iC', new THREE.InstancedBufferAttribute(Cc, 3));
    g.instanceCount = n;
    const U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uE: { value: new THREE.Vector2(E_[0], E_[1]) }, uN: { value: new THREE.Vector2(N_[0], N_[1]) }, uRyan: { value: RYAN.e }, uLen: { value: L }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uAmb: { value: 0.5 }, uKey: { value: 1 }, uNight: { value: NIGHT } }]);
    const vs = `
      attribute vec4 iA; attribute vec3 iC; uniform float uTime, uRyan, uLen; uniform vec2 uE, uN;
      varying vec3 vN; varying vec3 vC; varying float vFront; varying vec3 vWP;
      #include <common>
      #include <fog_pars_vertex>
      void main(){
        float along = mod(iA.z + uTime * iA.w * iA.y, uLen) - uLen * 0.5;
        vec3 fwd = vec3(uN.x, 0.0, uN.y) * iA.y, rt = vec3(uE.x, 0.0, uE.y);
        vec3 c = rt * (uRyan + iA.x) + vec3(uN.x, 0.0, uN.y) * along;
        vec3 p = c + rt * position.x + vec3(0.0, position.y, 0.0) + fwd * position.z;
        vN = normalize(rt * normal.x + vec3(0.0, normal.y, 0.0) + fwd * normal.z); vC = iC; vFront = position.z; vWP = p;
        vec4 mvPosition = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`;
    const fs = `
      uniform vec3 uSun; uniform float uAmb, uKey, uNight; varying vec3 vN; varying vec3 vC; varying float vFront; varying vec3 vWP;
      #include <common>
      #include <fog_pars_fragment>
      void main(){
        float l = uAmb + uKey * max(0.0, dot(normalize(vN), uSun));
        vec3 c = vC * l;
        c += uNight * (step(7.2, vFront) * vec3(1.6, 1.5, 1.3) + step(vFront, -7.2) * vec3(1.4, 0.05, 0.03));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`;
    const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: vs, fragmentShader: fs, fog: true });
    const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.name = 'traffic'; mesh.userData.noOcclude = true;
    group.add(mesh); disposables.push(g, mat, base);
    // head/tail light points (night): additive, view-dependent
    let lights = null;
    if (NIGHT > 0.2) {
      const P = new Float32Array(n * 2 * 3), IA = new Float32Array(n * 2 * 4), S = new Float32Array(n * 2);
      for (let j = 0; j < n; j++) for (let h = 0; h < 2; h++) { const o = j * 2 + h; IA.set(A.subarray(j * 4, j * 4 + 4), o * 4); S[o] = h ? -1 : 1; }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(P, 3)); lg.setAttribute('iA', new THREE.BufferAttribute(IA, 4)); lg.setAttribute('aS', new THREE.BufferAttribute(S, 1));
      const lm = new THREE.ShaderMaterial({
        uniforms: { uTime: U.uTime, uE: U.uE, uN: U.uN, uRyan: U.uRyan, uLen: U.uLen, uScale: { value: 700 }, uNight: { value: NIGHT } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute vec4 iA; attribute float aS; uniform float uTime, uRyan, uLen, uScale; uniform vec2 uE, uN; varying vec3 vC; varying float vA;
          void main(){ float along = mod(iA.z + uTime * iA.w * iA.y, uLen) - uLen * 0.5; vec3 fwd = vec3(uN.x, 0.0, uN.y) * iA.y, rt = vec3(uE.x, 0.0, uE.y);
            vec3 p = rt * (uRyan + iA.x) + vec3(uN.x, 0.0, uN.y) * along + fwd * (7.8 * aS) + vec3(0.0, 2.4, 0.0);
            vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
            vec3 toCam = normalize(cameraPosition - p); float facing = dot(toCam, fwd * aS);
            vA = (0.35 + 0.65 * smoothstep(-0.2, 0.8, facing)) * smoothstep(3400.0, 800.0, length(mv.xyz));
            vC = aS > 0.0 ? vec3(1.0, 0.95, 0.85) : vec3(1.0, 0.12, 0.06);
            gl_PointSize = clamp(9.0 * uScale / max(1.0, -mv.z), 1.5, 26.0); }`,
        fragmentShader: `uniform float uNight; varying vec3 vC; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = pow(max(0.0, 1.0 - length(d) * 2.0), 1.8) * vA * uNight; if (a < 0.01) discard; gl_FragColor = vec4(vC * a * 1.6, 1.0);
          #include <colorspace_fragment>
        }`,
      });
      lights = new THREE.Points(lg, lm); lights.frustumCulled = false; lights.name = 'trafficLights'; lights.renderOrder = 6;
      group.add(lights); disposables.push(lg, lm);
    }
    // Red Line: two 8-car trains
    const tBase = new THREE.BoxGeometry(9.5, 11, 48).translate(0, 5.5, 0);
    const tg = new THREE.InstancedBufferGeometry(); tg.index = tBase.index; tg.setAttribute('position', tBase.attributes.position); tg.setAttribute('normal', tBase.attributes.normal);
    const TA = new Float32Array(16 * 4), TC = new Float32Array(16 * 3);
    for (let k = 0; k < 16; k++) { const dir = k < 8 ? 1 : -1, j = k % 8; TA[k * 4] = dir > 0 ? 8 : -8; TA[k * 4 + 1] = dir; TA[k * 4 + 2] = (k < 8 ? 0 : L * 0.45) + j * 49 * dir * -1 + L; TA[k * 4 + 3] = 70; TC.set([0.72, 0.74, 0.77], k * 3); }
    tg.setAttribute('iA', new THREE.InstancedBufferAttribute(TA, 4)); tg.setAttribute('iC', new THREE.InstancedBufferAttribute(TC, 3)); tg.instanceCount = 16;
    const tMesh = new THREE.Mesh(tg, mat); tMesh.frustumCulled = false; tMesh.name = 'redline'; tMesh.userData.noOcclude = true;
    group.add(tMesh); disposables.push(tg, tBase);
    return { U, lights, setScale(v) { if (lights) lights.material.uniforms.uScale.value = v; } };
  })();

  mark('signs');
  // ======================================================================
  // SIGNS atlas: wall distance numbers, BLUFOX pads, panels, light-tower banners
  // ======================================================================
  {
    for (const [s, sv] of [[-43.2, -45], [-20, -20], [0, 0], [20, 20], [43.2, 45]]) SIGNS.push({ kind: 'num', text: String(Math.round(fenceAt(sv))), s, r: fenceAt(s) - 0.07, y: 1.6, w: 8.6, h: 4.6 });
    for (const s of [-31.5, 31.5]) SIGNS.push({ kind: 'pad', text: 'BLUFOX MOBILE', s, r: fenceAt(s) - 0.07, y: 2.2, w: 17, h: 3.4 });
    const AW = 1024, rowH = 128, cols = 4, cw = AW / cols;
    const rowsN = Math.ceil(SIGNS.length / cols) || 1, AH = Math.max(128, rowsN * rowH);
    const c = mkCanvas(AW, AH), g = c.getContext('2d');
    g.clearRect(0, 0, AW, AH);
    SIGNS.forEach((it, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * rowH; it.uv = [x / AW, 1 - (y + rowH) / AH, (x + cw) / AW, 1 - y / AH];
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (it.kind === 'num') { g.fillStyle = '#f4f5f2'; g.font = `900 ${rowH * 0.86}px "Helvetica Neue",Helvetica,Arial,sans-serif`; g.fillText(it.text, x + cw / 2, y + rowH * 0.54, cw - 8); }
      else if (it.kind === 'pad') { g.fillStyle = '#f4f5f2'; g.font = `900 ${rowH * 0.42}px ${FONT}`; g.fillText(it.text, x + cw / 2, y + rowH * 0.5, cw - 10); g.fillStyle = '#ff8a1f'; g.fillRect(x + cw * 0.2, y + rowH * 0.8, cw * 0.6, 6); }
      else if (it.kind === 'banner') { // drawn rotated (the quad maps it vertically)
        g.fillStyle = '#0f1012'; g.fillRect(x + 2, y + 2, cw - 4, rowH - 4); g.strokeStyle = '#c9d1d9'; g.lineWidth = 4; g.strokeRect(x + 8, y + 8, cw - 16, rowH - 16);
        g.fillStyle = '#ffffff'; g.font = `900 ${rowH * 0.42}px ${FONT}`; g.fillText(it.text, x + cw / 2, y + rowH / 2 + 2, cw - 28);
      } else { g.fillStyle = it.bg || '#111'; g.fillRect(x + 2, y + 2, cw - 4, rowH - 4); g.fillStyle = it.fg || '#fff'; g.font = `900 ${rowH * 0.4}px ${FONT}`; g.fillText(it.text, x + cw / 2, y + rowH / 2 + 2, cw - 16); }
    });
    g.textAlign = 'left';
    T.signs = tex(c, { wrap: 'clamp' });
    M.signs = new THREE.MeshStandardMaterial({ map: T.signs, alphaTest: 0.4, roughness: 0.7, side, emissiveMap: T.signs, emissive: col('#ffffff'), emissiveIntensity: 0.04 + 0.3 * LOOK.windows });
    disposables.push(M.signs);
    const quadUV = (a, b, c2, d, uvs) => { const g2 = K.quad(a, b, c2, d, null); const uv = g2.attributes.uv; // grid order: a, d, b, c
      uv.setXY(0, ...uvs[0]); uv.setXY(1, ...uvs[3]); uv.setXY(2, ...uvs[1]); uv.setXY(3, ...uvs[2]); return g2; };
    for (const it of SIGNS) {
      const [u0, v0, u1, v1] = it.uv;
      if (it.quad) {
        if (it.kind === 'banner') add('signs', quadUV(...it.quad, [[u0, v1], [u0, v0], [u1, v0], [u1, v1]]));   // rotated 90°
        else add('signs', K.quad(...it.quad, null, it.uv));
        continue;
      }
      // follow the wall's own chord (the fence radius changes with spray), a hair in front of the pads
      const ha = (it.w / 2) / it.r / D2R, s0 = it.s - ha, s1 = it.s + ha;
      const A = polar(s0, fenceAt(s0) - 0.09, it.y), B = polar(s1, fenceAt(s1) - 0.09, it.y);
      const Mm = polar(it.s, fenceAt(it.s) - 0.09); const mid = [(A[0] + B[0]) / 2, (A[2] + B[2]) / 2], dm = Math.hypot(mid[0], mid[1]) - Math.hypot(Mm[0], Mm[2]);
      const k = dm > 0 ? -dm : 0, n0 = dirXZ(it.s);
      const off = p0 => [p0[0] + n0[0] * k, p0[1], p0[2] + n0[1] * k];
      const A2 = off(A), B2 = off(B);
      add('signs', K.quad(A2, B2, [B2[0], it.y + it.h, B2[2]], [A2[0], it.y + it.h, A2[2]], null, it.uv));
    }
  }

  mark('merge');
  // ======================================================================
  // Build meshes from bins
  // ======================================================================
  M.glassRail = new THREE.MeshStandardMaterial({ color: col('#b9c7cf'), roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side });
  disposables.push(M.glassRail);
  for (const key in RAW) {
    const B = RAW[key]; if (!B.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    if (B.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
    for (const n in B.ex) g.setAttribute(n, new THREE.Float32BufferAttribute(B.ex[n], 1));
    g.setIndex(B.idx); add(key, g);
  }
  const matFor = key => M[key] || null;
  const meshes = {};
  const OCCLUDERS = new Set(['paint', 'precast', 'pads', 'hedge', 'glass', 'stands', 'facade', 'screen']);
  const castKeys = new Set(['paint', 'steel', 'seats', 'hedge', 'pads', 'precast', 'glass', 'stands', 'lamps', 'screen']);
  for (const key in BINS) {
    const mat = matFor(key);
    if (!mat) { console.warn('[rate] no material for bin', key); BINS[key].forEach(g => g.dispose()); continue; }
    const geo = K.merge(BINS[key]); if (!geo) continue;
    const m = new THREE.Mesh(geo, mat); m.name = key;
    m.castShadow = castKeys.has(key) && !LO; m.receiveShadow = key !== 'lamps' && key !== 'net' && key !== 'ribbon' && key !== 'glassRail';
    if (!OCCLUDERS.has(key)) m.userData.noOcclude = true;           // camera occluder grid (src/camera.js): big shells only
    if (key === 'net' || key === 'glassRail') m.renderOrder = 2;
    m.matrixAutoUpdate = false; m.updateMatrix();
    group.add(m); meshes[key] = m; disposables.push(geo);
  }

  mark('pinwheels');
  // ======================================================================
  // PINWHEELS on top of the big board — spin + chase lights (vertex-shader rotation, 1 draw call)
  // ======================================================================
  const PW = { n: 7, r: 7.6, y: SB.h + 1.2 + 7.6, list: [] };
  let pinMesh = null;
  const pinU = { uSpin: { value: 0 }, uGlow: { value: 0.1 + 0.9 * NIGHT }, uChase: { value: 0 }, uTime: { value: 0 } };
  {
    const pal = [...PK.palette.pinwheels, '#ff8a1f', '#9b3dff', '#00c2d1'];
    const pos = [], aC = [], aT = [], aN = [], colA = [], bulb = [], ph = [], idx = [];
    const pushV = (x, y, z, c, center, t, n, b, p) => { pos.push(x, y, z); aC.push(...center); aT.push(t[0], t[1]); aN.push(n[0], n[1]); colA.push(c.r, c.g, c.b); bulb.push(b); ph.push(p); return pos.length / 3 - 1; };
    for (let k = 0; k < PW.n; k++) {
      const s = lerp(SB.spray[0] + 1.1, SB.spray[1] - 1.1, k / (PW.n - 1));
      const r = scoreboardDistance(parkId, s) + 3, center = polar(s, r, PW.y), t = dirXZ(s + 90), n = dirXZ(s + 180);
      PW.list.push({ s, center });
      // mast (static, steel bin was merged already → add to paint via a small separate mesh below)
      const bladeCols = []; for (let b = 0; b < 8; b++) bladeCols.push(col(pal[(b + k * 3) % pal.length]));
      for (let b = 0; b < 8; b++) {
        const a0 = b * Math.PI / 4 + k * 0.3, R0 = PW.r;
        const P1 = [Math.cos(a0) * R0, Math.sin(a0) * R0], P2 = [Math.cos(a0 + 0.5) * R0 * 0.93, Math.sin(a0 + 0.5) * R0 * 0.93], P3 = [Math.cos(a0 + 0.8) * R0 * 0.36, Math.sin(a0 + 0.8) * R0 * 0.36];
        const cc = bladeCols[b], z = 0.02 * b;
        const h = pushV(0, 0, z, cc, center, t, n, 0, k), v1 = pushV(P1[0], P1[1], z, cc, center, t, n, 0, k), v2 = pushV(P2[0], P2[1], z, cc, center, t, n, 0, k), v3 = pushV(P3[0], P3[1], z, cc, center, t, n, 0, k);
        idx.push(h, v1, v2, h, v2, v3);
        // bulb strip along the outer edge
        const e1 = pushV(P1[0], P1[1], z + 0.05, cc, center, t, n, 1, k), e2 = pushV(P2[0], P2[1], z + 0.05, cc, center, t, n, 1, k);
        const i1 = pushV(P1[0] * 0.88, P1[1] * 0.88, z + 0.05, cc, center, t, n, 1, k), i2 = pushV(P2[0] * 0.88, P2[1] * 0.88, z + 0.05, cc, center, t, n, 1, k);
        idx.push(i1, e1, e2, i1, e2, i2);
      }
      const white = col('#f2f2f2'), hubC = [];
      for (let j = 0; j < 10; j++) { const a = j / 10 * Math.PI * 2; hubC.push(pushV(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.3, white, center, t, n, 0.5, k)); }
      const hc = pushV(0, 0, 0.35, white, center, t, n, 0.5, k);
      for (let j = 0; j < 10; j++) idx.push(hc, hubC[j], hubC[(j + 1) % 10]);
      // mast + back brace
      add('pinStatic', K.cyl(center[0] - n[0] * 0.6, SB.h, center[2] - n[1] * 0.6, center[0] - n[0] * 0.6, PW.y, center[2] - n[1] * 0.6, 0.45, 0.35, 6, '#0e0e0e'));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(aC, 3)); g.setAttribute('aTan', new THREE.Float32BufferAttribute(aT, 2)); g.setAttribute('aNrm', new THREE.Float32BufferAttribute(aN, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colA, 3)); g.setAttribute('aBulb', new THREE.Float32BufferAttribute(bulb, 1)); g.setAttribute('aPh', new THREE.Float32BufferAttribute(ph, 1));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...BOARD.center), 120);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3, side, emissive: col('#ffffff'), emissiveIntensity: 1 });
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, pinU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aCenter; attribute vec2 aTan; attribute vec2 aNrm; attribute float aBulb; attribute float aPh; uniform float uSpin; varying float vBulb; varying float vAng; varying float vPh;')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(aNrm.x, 0.0, aNrm.y);')
        .replace('#include <begin_vertex>', `float dirS = mod(aPh, 2.0) < 0.5 ? 1.0 : -1.0; float ang = uSpin * dirS + aPh * 0.7;
          float cs = cos(ang), sn = sin(ang); vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);
          vec3 transformed = aCenter + vec3(aTan.x, 0.0, aTan.y) * q.x + vec3(0.0, q.y, 0.0) + vec3(aNrm.x, 0.0, aNrm.y) * position.z;
          vBulb = aBulb; vAng = atan(position.y, position.x) + ang; vPh = aPh;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow, uChase, uTime; varying float vBulb; varying float vAng; varying float vPh;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float chase = 0.5 + 0.5 * sin(vAng * 8.0 - uTime * 14.0 + vPh * 1.3);
          float bulbs = vBulb > 0.75 ? (0.35 + 0.65 * step(0.45, chase)) : (vBulb > 0.25 ? 0.8 : 0.18);
          totalEmissiveRadiance = vColor * (uGlow * bulbs * (vBulb > 0.75 ? 3.0 : 1.0) + uChase * bulbs * (vBulb > 0.75 ? 7.0 : 1.2));`);
    };
    pinMesh = new THREE.Mesh(g, mat); pinMesh.name = 'pinwheels'; pinMesh.castShadow = !LO; pinMesh.userData.noOcclude = true;
    group.add(pinMesh); disposables.push(g, mat);
    M.pinStatic = M.steel;
    const sg = K.merge(BINS.pinStatic); delete BINS.pinStatic;
    const sm = new THREE.Mesh(sg, M.steel); sm.name = 'pinStatic'; sm.userData.noOcclude = true; sm.matrixAutoUpdate = false; sm.updateMatrix(); group.add(sm); disposables.push(sg);
  }

  mark('boards');
  // ======================================================================
  // VIDEO BOARD MATERIAL (LED pixel grid, flash) — CF board + corner boards
  // ======================================================================
  const boardMat = (map, leds, gain) => {
    const U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uGain: { value: gain }, uFlash: { value: 0 }, uLeds: { value: new THREE.Vector2(leds[0], leds[1]) } }]);
    U.uMap.value = map;
    const m = new THREE.ShaderMaterial({
      uniforms: U, fog: true, side,
      vertexShader: `varying vec2 vUv;
        #include <common>
        #include <fog_pars_vertex>
        void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `uniform sampler2D uMap; uniform float uGain, uFlash; uniform vec2 uLeds; varying vec2 vUv;
        #include <common>
        #include <fog_pars_fragment>
        void main(){
          vec3 c = texture2D(uMap, vUv).rgb;
          vec2 g = vUv * uLeds; vec2 f = fract(g) - 0.5;
          float k = clamp(1.0 - max(fwidth(g.x), fwidth(g.y)) * 1.4, 0.0, 1.0);
          float dotm = smoothstep(0.48, 0.28, length(f));
          c *= mix(1.0, 0.45 + 0.95 * dotm, k * 0.85);
          c = c * uGain + vec3(uFlash);
          if (!gl_FrontFacing) c = vec3(0.02);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    m.toneMapped = false; disposables.push(m); return m;
  };
  const bc = mkCanvas(1024, 460), bg = bc.getContext('2d');
  T.board = tex(bc, { wrap: 'clamp' });
  const MB = boardMat(T.board, [448, 200], LOOK.boardGain);
  const boardMesh = new THREE.Mesh(faceGeo, MB); boardMesh.name = 'cfBoard'; group.add(boardMesh); disposables.push(faceGeo);
  const cbc = mkCanvas(512, 224), cbg = cbc.getContext('2d');
  T.cboard = tex(cbc, { wrap: 'clamp' });
  const MCB = boardMat(T.cboard, [160, 136], LOOK.boardGain);
  const cbGeo = K.merge(VB.map(v => v.geo));
  const cbMesh = new THREE.Mesh(cbGeo, MCB); cbMesh.name = 'cornerBoards'; group.add(cbMesh); disposables.push(cbGeo);

  mark('flags');
  // ======================================================================
  // FLAGS (wind readout) — shader-animated, stream toward wind.dir; they frame the big board
  // ======================================================================
  const flagSpecs = [];
  {
    const c = mkCanvas(512, 192), g = c.getContext('2d');
    const cell = (i, fn) => { g.save(); g.translate((i % 4) * 128, Math.floor(i / 4) * 96); fn(); g.restore(); };
    cell(0, () => { for (let k = 0; k < 13; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#b22234'; g.fillRect(0, k * 96 / 13, 128, 96 / 13 + 0.5); } g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 54, 52); g.fillStyle = '#fff'; for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(5 + i * 9 + (j % 2) * 4, 6 + j * 10, 1.6, 0, 7); g.fill(); } });
    cell(1, () => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#b3ddf2'; g.fillRect(0, 16, 128, 16); g.fillRect(0, 64, 128, 16); g.fillStyle = '#ff0000'; for (let k = 0; k < 4; k++) { const cx = 25 + k * 26, cy = 48; g.beginPath(); for (let p = 0; p < 12; p++) { const a = p * Math.PI / 6 - Math.PI / 2, rr = p % 2 ? 4.2 : 9.5; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); g.fill(); } });
    cell(2, () => { g.fillStyle = '#0d3a9a'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#ff8a1f'; g.fillRect(0, 80, 128, 16); g.fillStyle = '#fff'; g.font = `900 24px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BLUFOX', 64, 42); });
    cell(3, () => { g.fillStyle = '#16181c'; g.fillRect(0, 0, 128, 96); g.fillStyle = '#c9d1d9'; g.fillRect(0, 40, 128, 16); });
    T.flags = tex(c, { wrap: 'clamp' });
    for (const [s, cellI, hgt] of [[-12.2, 0, 128], [-10.4, 1, 120], [10.6, 2, 120]]) {
      const [x, , z] = polar(s, fenceAt(s) + CON.d1 - 5);
      add('flagPole', K.cyl(x, CON.h, z, x, hgt, z, 0.35, 0.28, 6, '#d8d8d0'));
      flagSpecs.push({ a: [x, hgt - 0.6, z], w: s === -12.2 ? 15 : 12.5, h: s === -12.2 ? 8 : 6.6, cell: cellI });
    }
    const fp = K.merge(BINS.flagPole); delete BINS.flagPole;
    const fpm = new THREE.Mesh(fp, M.steel); fpm.userData.noOcclude = true; fpm.matrixAutoUpdate = false; fpm.updateMatrix(); group.add(fpm); disposables.push(fp);
  }
  let flagMesh = null;
  {
    const nx = 10, ny = 5, per = (nx + 1) * (ny + 1), N = flagSpecs.length;
    const pos = new Float32Array(N * per * 3), anc = new Float32Array(N * per * 3), loc = new Float32Array(N * per * 4), uv = new Float32Array(N * per * 2), idx = [];
    flagSpecs.forEach((f, k) => {
      const cu = (f.cell % 4) / 4, cv = 1 - (Math.floor(f.cell / 4) + 1) / 2;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const o = k * per + j * (nx + 1) + i;
        anc.set(f.a, o * 3); pos.set(f.a, o * 3); loc.set([i / nx, j / ny, f.w, f.h], o * 4); uv.set([cu + (i / nx) * 0.25, cv + (1 - j / ny) * 0.5], o * 2);
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
      uniforms: u, fog: true, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 aAnchor; attribute vec4 aLoc; uniform float uTime, uStr; uniform vec2 uWind; varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_vertex>
        void main(){
          vec3 dir = normalize(vec3(uWind.x, 0.0, uWind.y));
          float droop = mix(1.05, 0.08, uStr);
          vec3 xa = normalize(dir * cos(droop) + vec3(0.0, -sin(droop), 0.0));
          vec3 sd = normalize(cross(vec3(0.0, 1.0, 0.0), dir));
          vec3 ya = normalize(cross(xa, sd)); if (ya.y > 0.0) ya = -ya;
          float ph = aAnchor.x * 0.13 + aAnchor.z * 0.07, k = aLoc.x;
          float arg = k * 7.5 - uTime * (2.5 + 10.0 * uStr) + ph, amp = (0.05 + 0.2 * uStr) * aLoc.w * k;
          vec3 p = aAnchor + xa * (k * aLoc.z) + ya * (aLoc.y * aLoc.w) + sd * sin(arg) * amp;
          p.y -= (1.0 - uStr) * k * k * aLoc.z * 0.25;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition;
          vUv = uv; vSh = 0.78 + 0.22 * cos(arg);
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uLight; varying vec2 vUv; varying float vSh;
        #include <common>
        #include <fog_pars_fragment>
        void main(){ vec4 c = texture2D(uTex, vUv); if (c.a < 0.4) discard; gl_FragColor = vec4(c.rgb * vSh * uLight * (gl_FrontFacing ? 1.0 : 0.8), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    flagMesh = new THREE.Mesh(g, mat); flagMesh.frustumCulled = false; flagMesh.name = 'flags'; flagMesh.userData.noOcclude = true;
    group.add(flagMesh); disposables.push(g, mat);
  }

  // ---- glare + glow sprites and fireworks share one additive points shader
  const pointsMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 700 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec4 aCol; attribute float aSize; uniform float uScale; varying vec4 vC;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 0.0, 480.0); vC = aCol; }`,
    fragmentShader: `varying vec4 vC;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.2); if (a <= 0.002) discard; gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  disposables.push(pointsMat);
  const _v2 = new THREE.Vector2();
  const scaleHook = (renderer, scene, camera) => {
    if (!camera.isPerspectiveCamera) return;
    const h = renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(_v2).y : 800;
    const v = h * 0.5 / Math.tan(camera.fov * 0.5 * D2R) * (camera.zoom || 1);
    pointsMat.uniforms.uScale.value = v; traffic.setScale(v);
  };
  {
    // Fan Deck string lights + pinwheel-axis beacons (night)
    if (NIGHT > 0.2 || tod === 'dusk') {
      walk(offsetLine(ofPath(spraySamples(FD.spray[0], FD.spray[1], 0.5)), FD.d[0] + 0.5), 3.5, (x, z) => glowPts.push(x, FD.h + 3.9, z, 1.8, 1, 0.85, 0.55, 0.9));
    }
    const all = [...glare, ...glowPts];
    if (all.length) {
      const n = all.length / 8, pos = new Float32Array(n * 3), colA = new Float32Array(n * 4), size = new Float32Array(n);
      for (let i = 0; i < n; i++) { pos.set(all.slice(i * 8, i * 8 + 3), i * 3); size[i] = all[i * 8 + 3]; colA.set(all.slice(i * 8 + 4, i * 8 + 8), i * 4); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(colA, 4)); g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      const pts = new THREE.Points(g, pointsMat); pts.frustumCulled = false; pts.onBeforeRender = scaleHook; pts.name = 'glare'; pts.renderOrder = 5;
      group.add(pts); disposables.push(g);
    }
  }

  mark('fireworks');
  // ======================================================================
  // FIREWORKS — fired from behind the big board (every homer; a barrage when it leaves the park)
  // kinds: 1 shell (rising), 2 star, 3 spark trail, 4 comet (from the board top), 5 willow (gold, hangs)
  // ======================================================================
  const FW = (() => {
    const N = HI ? 2600 : quality === 'medium' ? 1500 : 760;
    const pos = new Float32Array(N * 3), colA = new Float32Array(N * 4), size = new Float32Array(N);
    const vel = new Float32Array(N * 3), life = new Float32Array(N), maxL = new Float32Array(N), kind = new Uint8Array(N), rgb = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage), aCol = new THREE.BufferAttribute(colA, 4).setUsage(THREE.DynamicDrawUsage), aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', aPos); g.setAttribute('aCol', aCol); g.setAttribute('aSize', aSize);
    const pts = new THREE.Points(g, pointsMat); pts.frustumCulled = false; pts.onBeforeRender = scaleHook; pts.visible = false; pts.name = 'fireworks'; pts.renderOrder = 6;
    group.add(pts); disposables.push(g);
    let cursor = 0, active = 0; const queue = [];
    const PAL = [[1, 0.22, 0.18], [0.25, 0.5, 1], [1, 0.8, 0.25], [0.3, 1, 0.45], [1, 0.35, 0.9], [0.92, 0.96, 1], [1, 0.55, 0.12], [0.2, 0.95, 1]];
    function spawn(k, x, y, z, vx, vy, vz, L, c, sz) {
      const i = cursor; cursor = (cursor + 1) % N;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
      life[i] = L; maxL[i] = L; kind[i] = k; rgb.set(c, i * 3); size[i] = sz;
    }
    function shell(delay, x, z, o = {}) { queue.push({ at: delay, type: 'shell', x, z, ...o }); }
    function comet(delay, x, z, o = {}) { queue.push({ at: delay, type: 'comet', x, z, ...o }); }
    function burst(i) {
      const c = PAL[Math.floor(R() * PAL.length)], c2 = R() < 0.35 ? PAL[Math.floor(R() * PAL.length)] : c;
      const willow = R() < 0.22;
      const n = LO ? 55 : quality === 'medium' ? 85 : 120, sp = (willow ? 26 : 38) + R() * 16;
      for (let b = 0; b < n; b++) {
        const u = R() * 2 - 1, th = R() * Math.PI * 2, s = Math.sqrt(1 - u * u), v = sp * (0.85 + R() * 0.3);
        spawn(willow ? 5 : 2, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], Math.cos(th) * s * v, u * v + 5, Math.sin(th) * s * v, willow ? 2.6 + R() * 0.8 : 1.3 + R() * 0.8, willow ? [1, 0.72, 0.3] : (b % 3 ? c : c2), willow ? 6 : 7.5);
      }
    }
    function update(dt) {
      for (let q = queue.length - 1; q >= 0; q--) {
        queue[q].at -= dt;
        if (queue[q].at <= 0) {
          const e = queue.splice(q, 1)[0];
          if (e.type === 'shell') spawn(1, e.x, SB.h + 2, e.z, (R() - 0.5) * 16, (e.vy || 64) + R() * 18, (R() - 0.5) * 12, 0.75 + R() * 0.3, [1, 0.85, 0.6], 4.5);
          else { const c = PAL[Math.floor(R() * PAL.length)]; for (let k = 0; k < 6; k++) spawn(4, e.x, SB.h + 3, e.z, (R() - 0.5) * 10 + (e.vx || 0), 70 + R() * 20, (R() - 0.5) * 6, 1.4 + R() * 0.4, c, 5); }
        }
      }
      if (!queue.length && !active) { pts.visible = false; return; }
      pts.visible = true; active = 0;
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) { colA[i * 4 + 3] = 0; continue; }
        active++;
        life[i] -= dt;
        const k = kind[i];
        vel[i * 3 + 1] -= 32 * dt * (k === 1 || k === 4 ? 1 : k === 5 ? 0.3 : 0.45);
        const drag = k === 2 ? Math.exp(-1.6 * dt) : k === 5 ? Math.exp(-2.4 * dt) : 1; vel[i * 3] *= drag; vel[i * 3 + 1] *= drag; vel[i * 3 + 2] *= drag;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        const f = clamp(life[i] / maxL[i], 0, 1);
        const a = k === 1 ? 1 : k === 3 ? f * 0.6 : k === 4 ? 0.9 * f : k === 5 ? Math.pow(f, 0.5) * (0.7 + 0.3 * Math.sin(life[i] * 30 + i)) : Math.pow(f, 0.7) * (0.75 + 0.25 * Math.sin(life[i] * 40 + i));
        colA[i * 4] = rgb[i * 3] * 2.4; colA[i * 4 + 1] = rgb[i * 3 + 1] * 2.4; colA[i * 4 + 2] = rgb[i * 3 + 2] * 2.4; colA[i * 4 + 3] = a;
        if ((k === 1 || k === 4 || k === 5) && R() < (k === 5 ? 0.25 : 0.8)) spawn(3, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], (R() - 0.5) * 5, -6, (R() - 0.5) * 5, k === 5 ? 0.9 : 0.5, k === 4 ? rgb.slice(i * 3, i * 3 + 3) : [1, 0.7, 0.4], k === 5 ? 3 : 2.2);
        if (k === 1 && life[i] <= 0) burst(i);
      }
      aPos.needsUpdate = aCol.needsUpdate = aSize.needsUpdate = true;
    }
    return { shell, comet, update, get active() { return active + queue.length; } };
  })();
  const boardTopPt = (s, back = 5) => polar(s, scoreboardDistance(parkId, clamp(s, SB.spray[0], SB.spray[1])) + SB.depth - back);
  function fireworksShow(big) {
    const n = big ? (LO ? 12 : 22) : (LO ? 5 : 9);
    for (let i = 0; i < n; i++) { const s = (i / Math.max(1, n - 1) - 0.5) * 2 * (SB.spray[1] - 0.5), [x, , z] = boardTopPt(s + (R() - 0.5)); FW.shell(i * (big ? 0.2 : 0.28) + R() * 0.15, x, z, { vy: 58 + R() * 20 }); }
    for (let i = 0; i < PW.n; i++) { const [x, , z] = boardTopPt(PW.list[i].s, 8); FW.comet(0.1 + i * 0.12, x, z, { vx: (i - 3) * 2 }); }
    if (big) {
      for (let i = 0; i < (LO ? 6 : 14); i++) { const [x, , z] = boardTopPt((R() - 0.5) * 14); FW.shell(2.6 + i * 0.22, x, z, { vy: 70 + R() * 22 }); }
      for (let i = 0; i < PW.n; i++) { const [x, , z] = boardTopPt(PW.list[i].s, 8); FW.comet(3.2 + i * 0.1, x, z); FW.comet(4.4 + (PW.n - i) * 0.1, x, z); }
      for (let i = 0; i < (LO ? 5 : 10); i++) { const [x, , z] = boardTopPt((R() - 0.5) * 12); FW.shell(5.6 + i * 0.12, x, z, { vy: 80 + R() * 16 }); }
    } else for (let i = 0; i < Math.ceil(n / 2); i++) { const [x, , z] = boardTopPt((R() - 0.5) * 12); FW.shell(2.3 + i * 0.35, x, z); }
  }

  // ---- rain (drizzle)
  let rain = null;
  if (weather === 'drizzle') {
    const N = HI ? 2600 : quality === 'medium' ? 1700 : 900;
    const seed = new Float32Array(N * 2 * 3), endA = new Float32Array(N * 2);
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
    rain = new THREE.LineSegments(g, mat); rain.frustumCulled = false; rain.name = 'rain'; rain.renderOrder = 8;
    rain.onBeforeRender = (r, s, cam) => { cam.getWorldPosition(mat.uniforms.uCam.value); };
    group.add(rain); disposables.push(g, mat);
  }

  mark('sky');
  // ======================================================================
  // SKY — the art skies (sky_rate_*) carry a downtown skyline. Rate Field faces AWAY from downtown,
  // so the dome uses only the sky above the skyline everywhere, and shows the skyline band only in
  // a window due north (spray ≈ −120°, behind the 3B stands) at a realistic low elevation.
  // ======================================================================
  const SKYCFG = { day: { cut: 0.60, x0: 0.25 }, dusk: { cut: 0.50, x0: 0.28 }, night: { cut: 0.55, x0: 0.06 } }[tod];
  let skySrc = null, horizonF = 0.86, skyBitmap = false, skyArt = false;
  {
    const key = `sky_rate_${tod}`, im = assetImage(key), meta = assetMeta(key);
    if (im) { skySrc = im; skyArt = true; skyBitmap = typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap; horizonF = (meta && meta.horizon) || 0.86; }
    else { skySrc = paintSky(tod); horizonF = 0.86; SKYCFG.cut = 0.8; SKYCFG.x0 = 0.1; }
  }
  const skyAvg = (y0, y1, x0 = 0, x1 = 1) => {
    const c = mkCanvas(8, 4), g = c.getContext('2d', { willReadFrequently: true });
    const sw = skySrc.naturalWidth || skySrc.width, sh = skySrc.naturalHeight || skySrc.height;
    g.drawImage(skySrc, sw * x0, sh * y0, Math.max(1, sw * (x1 - x0)), Math.max(1, sh * (y1 - y0)), 0, 0, 8, 4);
    const d = g.getImageData(0, 0, 8, 4).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`;
  };
  const topCol = skyAvg(0, 0.04), horizCol = skyAvg(SKYCFG.cut - 0.05, SKYCFG.cut), lowCol = skyAvg(SKYCFG.cut - 0.02, SKYCFG.cut, 0, 0.2);
  const VDPP = 0.0733;
  const elTop = horizonF * 878 * VDPP;
  T.sky = tex(skySrc, { wrap: 'clamp', flipY: !skyBitmap });
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: T.sky }, uTop: { value: col(topCol) }, uHor: { value: col(horizCol) }, uZen: { value: col(topCol).multiplyScalar(tod === 'day' ? 0.86 : 0.7) },
      uH: { value: horizonF }, uCut: { value: SKYCFG.cut }, uX0: { value: SKYCFG.x0 }, uElTop: { value: elTop }, uHaze: { value: col(LOOK.haze) }, uHazeAmt: { value: LOOK.hazeAmt },
      uDesat: { value: LOOK.skyDesat }, uBright: { value: LOOK.skyBright }, uDrift: { value: 0 }, uFlip: { value: skyBitmap ? 1 : 0 },
      uGlow: { value: tod === 'night' ? 0.34 : tod === 'dusk' ? 0.14 : 0 }, uGlowCol: { value: col(tod === 'night' ? '#8e9cc6' : '#ffd2a8') }, uArt: { value: skyArt ? 1 : 0 },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform sampler2D uSky; uniform vec3 uTop, uHor, uZen, uHaze, uGlowCol; uniform float uH, uCut, uX0, uElTop, uHazeAmt, uDesat, uBright, uDrift, uGlow, uFlip, uArt;
      varying vec3 vW;
      #include <common>
      vec3 img(vec2 uv){ float v = clamp(uv.y, 0.002, 0.998); return texture2D(uSky, vec2(clamp(uv.x, 0.001, 0.999), uFlip > 0.5 ? v : 1.0 - v)).rgb; }
      void main(){
        vec3 d = normalize(vW - cameraPosition);
        float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
        float azr = atan(d.x, -d.z), az = degrees(azr);
        float u = (azr + uDrift) / PI + 0.5; u = 1.0 - abs(1.0 - mod(u, 2.0));
        // sky only (image rows above the skyline), stretched down to 1.5 deg
        float e0 = 1.5, f = clamp((el - e0) / (uElTop - e0), 0.0, 1.0);
        vec3 c = img(vec2(u, uCut * (1.0 - f)));
        if (f >= 1.0) c = mix(uTop, uZen, clamp((el - uElTop) / 30.0, 0.0, 1.0));
        c = mix(uHor, c, smoothstep(-1.0, e0 + 1.0, el));
        // downtown skyline, due north (az ≈ −120°), squeezed to ~6 deg high over a ~72 deg window
        float w = smoothstep(-160.0, -148.0, az) * (1.0 - smoothstep(-92.0, -80.0, az)) * uArt;
        if (w > 0.0 && el < 7.0 && el > -1.5) {
          float ux = uX0 + (az + 156.0) / 72.0 * (1.0 - uX0);
          float vv = mix(uH, uCut, clamp(el / 6.2, 0.0, 1.0));
          vec3 s = img(vec2(ux, vv));
          c = mix(c, s, w * smoothstep(7.0, 5.6, el) * smoothstep(-1.5, -0.3, el));
        }
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(c, vec3(l), uDesat) * uBright;
        c = mix(c, uHaze, uHazeAmt * (1.0 - smoothstep(0.0, 18.0, abs(el))));
        c += uGlowCol * uGlow * exp(-max(el - 1.0, 0.0) / 7.0) * smoothstep(-6.0, 1.0, el);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  skyMat.toneMapped = false;
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(4200, 48, 24), skyMat);
  skyMesh.renderOrder = -1000; skyMesh.frustumCulled = false; skyMesh.name = 'sky';
  group.add(skyMesh); disposables.push(skyMesh.geometry, skyMat);
  // environment (equirect canvas → PMREM by three): sky rows above the skyline + ground
  let envTex = null;
  {
    const W = 256, H = 128, c = mkCanvas(W, H), g = c.getContext('2d');
    const rowOf = el => (90 - el) / 180 * H;
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, topCol); gr.addColorStop(rowOf(elTop) / H, topCol); gr.addColorStop(rowOf(0) / H, horizCol);
    const ground = tod === 'day' ? '#4a5a3c' : tod === 'dusk' ? '#3a3228' : '#12160f';
    gr.addColorStop(Math.min(0.99, rowOf(-6) / H), ground); gr.addColorStop(1, shade(ground, 0.6));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const sw = skySrc.naturalWidth || skySrc.width, sh = skySrc.naturalHeight || skySrc.height;
    g.drawImage(skySrc, 0, 0, sw, sh * SKYCFG.cut, 0, rowOf(elTop), W / 2, rowOf(1.5) - rowOf(elTop));
    g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(skySrc, 0, 0, sw, sh * SKYCFG.cut, 0, rowOf(elTop), W / 2, rowOf(1.5) - rowOf(elTop)); g.restore();
    g.fillStyle = ground; g.globalAlpha = 0.85; g.fillRect(0, rowOf(-3), W, H); g.globalAlpha = 1;
    if (LOOK.lamps > 1) { g.fillStyle = 'rgba(255,250,235,0.95)'; for (let i = 0; i < 14; i++) { g.beginPath(); g.arc(i * W / 14 + 8, rowOf(22), 3, 0, 7); g.fill(); } }
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
  key.castShadow = !LO;
  if (key.castShadow) {
    const sz = HI ? 2048 : 1024; key.shadow.mapSize.set(sz, sz);
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.35; key.shadow.intensity = LOOK.shadowI;
    const m = new THREE.Matrix4().lookAt(key.position, target.position, new THREE.Vector3(0, 1, 0));
    m.setPosition(key.position); const inv = m.clone().invert();
    const v = new THREE.Vector3(); let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    for (const [x, z] of loop) for (const y of [0, 14]) { v.set(x, y, z).applyMatrix4(inv); mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x); mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y); mnz = Math.min(mnz, v.z); mxz = Math.max(mxz, v.z); }
    const cam = key.shadow.camera; cam.left = mnx - 4; cam.right = mxx + 4; cam.bottom = mny - 4; cam.top = mxy + 4; cam.near = Math.max(1, -mxz - (NIGHT > 0.3 ? 135 : 600)); cam.far = -mnz + 80;   // under the lights only low structures shadow the field
    cam.updateProjectionMatrix();
  }
  group.add(key);
  const hemi = new THREE.HemisphereLight(col(LOOK.hemiSky), col(LOOK.hemiGround), LOOK.hemiI); group.add(hemi);
  let rimLight = null;
  if (LOOK.rim) { rimLight = new THREE.DirectionalLight(col(LOOK.rim.color), LOOK.rim.i); rimLight.position.copy(toDir(LOOK.rim.el, LOOK.rim.az)).multiplyScalar(900); rimLight.target = target; group.add(rimLight); }
  traffic.U.uSun.value.copy(sunDir); traffic.U.uAmb.value = 0.25 + LOOK.hemiI * 0.5; traffic.U.uKey.value = LOOK.keyI * 0.3;

  mark('boarddraw');
  // ======================================================================
  // BOARD GRAPHICS (live broadcast look). Idle: redrawn only when setBoard() changes something.
  // Takeovers (homer / out of the park) animate at ~12 Hz for a few seconds.
  // ======================================================================
  const board = { name: 'PLAYER', homers: 0, outs: 0, score: 0, lastFt: 0, message: 'WINDY CITY DERBY', charId: null };
  const cel = { t: -1, dur: 6.5, distance: 0, bonus: null, spray: 0, big: false };
  let boardDirty = true, boardClock = 0, cornerDirty = true, cornerClock = 0, cornerPhase = 0, waveMsgT = 0;
  const PWC = PK.palette.pinwheels;
  function pinGfx(g, x, y, r, a, colors) {
    for (let k = 0; k < 8; k++) {
      const a0 = a + k * Math.PI / 4; g.fillStyle = colors[k % colors.length];
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      g.quadraticCurveTo(x + Math.cos(a0 + 0.5) * r * 0.9, y + Math.sin(a0 + 0.5) * r * 0.9, x + Math.cos(a0 + 0.78) * r * 0.35, y + Math.sin(a0 + 0.78) * r * 0.35);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, r * 0.12, 0, 7); g.fill();
  }
  function foxMark(g, x, y, s, c) { // simple fox head (fallback when there's no portrait)
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = c; g.beginPath(); g.moveTo(-1, -0.9); g.lineTo(-0.55, -0.1); g.lineTo(0.55, -0.1); g.lineTo(1, -0.9); g.lineTo(0.75, 0.2); g.lineTo(0, 1); g.lineTo(-0.75, 0.2); g.closePath(); g.fill();
    g.fillStyle = '#f4efe6'; g.beginPath(); g.moveTo(-0.62, 0.22); g.lineTo(0, 1); g.lineTo(0.62, 0.22); g.lineTo(0, 0.45); g.closePath(); g.fill();
    g.fillStyle = '#111'; g.beginPath(); g.arc(-0.3, 0.1, 0.09, 0, 7); g.arc(0.3, 0.1, 0.09, 0, 7); g.fill(); g.beginPath(); g.arc(0, 0.92, 0.1, 0, 7); g.fill();
    g.restore();
  }
  function drawIdle(g, W, H) {
    let gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#0a0e16'); gr.addColorStop(1, '#111827'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.025)'; for (let x = -H; x < W; x += 26) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.lineTo(x + H + 10, 0); g.lineTo(x + 10, H); g.fill(); }
    // header
    gr = g.createLinearGradient(0, 0, 0, 56); gr.addColorStop(0, '#eef2f6'); gr.addColorStop(1, '#a9b3be'); g.fillStyle = gr; g.fillRect(0, 0, W, 56);
    g.fillStyle = '#0b0d10'; g.font = `900 32px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText('RATE FIELD', 22, 30);
    g.textAlign = 'right'; g.fillText('WINDY CITY DERBY', W - 22, 30); g.textAlign = 'left';
    pinGfx(g, 262, 28, 20, 0.3, PWC);
    // portrait panel
    const px = 22, py = 74, pw = 300, ph = 290;
    gr = g.createLinearGradient(px, py, px, py + ph); gr.addColorStop(0, '#1d3b8f'); gr.addColorStop(1, '#0b1638'); g.fillStyle = gr; g.fillRect(px, py, pw, ph);
    const por = board.charId ? assetImage('portrait_' + board.charId) : null;
    if (por) { const iw = por.naturalWidth || por.width, ih = por.naturalHeight || por.height, k = Math.max(pw / iw, ph / ih) * 1.02; g.save(); g.beginPath(); g.rect(px, py, pw, ph); g.clip(); g.drawImage(por, px + (pw - iw * k) / 2, py + ph - ih * k + 10, iw * k, ih * k); g.restore(); }
    else foxMark(g, px + pw / 2, py + ph / 2 - 10, 105, '#e2672a');
    g.strokeStyle = '#c9d1d9'; g.lineWidth = 4; g.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    // name + stat tiles
    const nx = px + pw + 28;
    g.fillStyle = '#9fb0c4'; g.font = `800 26px ${FONT}`; g.fillText('NOW BATTING', nx, 98);
    g.fillStyle = '#ffffff'; g.font = `900 86px ${FONT}`; g.fillText(String(board.name || 'PLAYER').toUpperCase().slice(0, 14), nx - 4, 160, W - nx - 24);
    const tiles = [['HR', String(board.homers | 0)], ['OUTS', `${board.outs | 0}/10`], ['SCORE', fmtN(board.score)], ['LAST', board.lastFt ? `${Math.round(board.lastFt)} FT` : '—']];
    const tw = [(W - nx - 24 - 36) * 0.18, (W - nx - 24 - 36) * 0.22, (W - nx - 24 - 36) * 0.32, (W - nx - 24 - 36) * 0.28];
    let tx = nx;
    tiles.forEach(([lab, val], i) => {
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(tx, 208, tw[i], 124); g.fillStyle = i === 0 ? '#ff4b3a' : '#c9d1d9'; g.fillRect(tx, 208, tw[i], 6);
      g.fillStyle = '#9fb0c4'; g.font = `800 24px ${FONT}`; g.fillText(lab, tx + 14, 238);
      g.fillStyle = '#ffffff'; g.font = `900 54px ${FONT}`; g.fillText(val, tx + 12, 292, tw[i] - 22);
      tx += tw[i] + 12;
    });
    for (let i = 0; i < 10; i++) { g.fillStyle = i < (board.outs | 0) ? '#ff4b3a' : 'rgba(255,255,255,0.16)'; g.beginPath(); g.arc(nx + 12 + i * 34, 352, 11, 0, 7); g.fill(); }
    // ticker
    g.fillStyle = '#0d1a33'; g.fillRect(0, 384, W, H - 384); g.fillStyle = '#2f80ff'; g.fillRect(0, 384, W, 6);
    g.fillStyle = '#ffffff'; g.font = `900 52px ${FONT}`; g.textAlign = 'center'; g.fillText(String(waveMsgT > 0 ? 'THE WAVE!  STAND UP, SOUTH SIDE!' : (board.message || 'WINDY CITY DERBY')).toUpperCase(), W / 2, 426, W - 60); g.textAlign = 'left';
  }
  function drawTakeover(g, W, H, k) {
    const flash = Math.max(0, 1 - k * 2.2), hue = (k * 90) % 360;
    const gr = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.7);
    gr.addColorStop(0, `hsl(${hue},80%,${22 + flash * 60}%)`); gr.addColorStop(0.6, `hsl(${(hue + 50) % 360},85%,${10 + flash * 50}%)`); gr.addColorStop(1, `hsl(${(hue + 190) % 360},80%,${6 + flash * 40}%)`);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.save(); g.translate(W / 2, H / 2); g.rotate(k * 0.7);
    for (let i = 0; i < 28; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.02)'; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 900, i * Math.PI / 14, (i + 1) * Math.PI / 14); g.fill(); }
    g.restore();
    pinGfx(g, 120, H / 2, 104, k * 8, PWC); pinGfx(g, W - 120, H / 2, 104, -k * 8, PWC);
    pinGfx(g, 270, 70, 38, -k * 11, PWC); pinGfx(g, W - 270, H - 66, 38, k * 11, PWC);
    if (cel.big) for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2 + k, rr = 60 + ((k * 260 + i * 37) % 260); g.fillStyle = `hsla(${(i * 40 + k * 200) % 360},100%,70%,${Math.max(0, 1 - rr / 320)})`; g.beginPath(); g.arc(W / 2 + Math.cos(a) * rr * 1.7, H / 2 + Math.sin(a) * rr * 0.8, 7, 0, 7); g.fill(); }
    const s = 1 + 0.12 * Math.sin(k * 9) * Math.exp(-k * 0.6);
    g.save(); g.translate(W / 2, H / 2 - 36); g.scale(s, s); g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = cel.big ? 'OUT OF THE PARK!' : 'HOME RUN!';
    g.font = `900 ${cel.big ? 92 : 124}px ${FONT}`; g.lineWidth = 12; g.strokeStyle = '#000'; g.strokeText(big, 0, 0, W - 290); g.fillStyle = '#ffffff'; g.fillText(big, 0, 0, W - 290);
    g.restore();
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `900 58px ${FONT}`; g.lineWidth = 7; g.strokeStyle = '#000';
    const lbl = cel.bonus && PK.bonus[cel.bonus] && !(cel.big && cel.bonus === 'out_of_park') ? ` · ${PK.bonus[cel.bonus].label}` : '';
    const sub = `${Math.round(cel.distance)} FT${lbl}`;
    g.fillStyle = '#ffe14d'; g.strokeText(sub, W / 2, H / 2 + 62, W - 320); g.fillText(sub, W / 2, H / 2 + 62, W - 320);
    g.font = `900 34px ${FONT}`; g.fillStyle = '#ffffff'; g.strokeText(String(board.name || '').toUpperCase(), W / 2, H / 2 + 124, W - 360); g.fillText(String(board.name || '').toUpperCase(), W / 2, H / 2 + 124, W - 360);
    g.textAlign = 'left';
  }
  function redrawBoard(t) {
    const W = bc.width, H = bc.height;
    if (cel.t >= 0 && cel.t < cel.dur) drawTakeover(bg, W, H, cel.t); else drawIdle(bg, W, H);
    T.board.needsUpdate = true; boardDirty = false;
  }
  function drawCorner(g, x0, W, H, which) {
    g.save(); g.beginPath(); g.rect(x0, 0, W, H); g.clip(); g.translate(x0, 0);
    const celeb = cel.t >= 0 && cel.t < cel.dur;
    if (celeb) {
      const on = Math.floor(cel.t * 4) % 2 === 0;
      g.fillStyle = on ? '#ffffff' : '#0d1a33'; g.fillRect(0, 0, W, H);
      g.fillStyle = on ? '#0d1a33' : '#ffe14d'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${cel.big ? 40 : 50}px ${FONT}`; g.fillText(cel.big ? 'GONE!' : 'HOME RUN', W / 2, H * 0.36, W - 16);
      g.font = `900 64px ${FONT}`; g.fillText(`${Math.round(cel.distance)} FT`, W / 2, H * 0.7, W - 16);
    } else if ((cornerPhase + (which === 'rf' ? 1 : 0)) % 2 === 0) {
      g.fillStyle = '#0d3a9a'; g.fillRect(0, 0, W, H); g.fillStyle = '#ff8a1f'; g.fillRect(0, H - 26, W, 26);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `900 46px ${FONT}`; g.fillText('BLUFOX', W / 2, H * 0.34, W - 20); g.fillText('MOBILE', W / 2, H * 0.6, W - 20);
      g.font = `800 17px ${FONT}`; g.fillStyle = '#0b1638'; g.fillText('SWITCH & SAVE ON THE SOUTH SIDE', W / 2, H - 13, W - 16);
    } else {
      const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#0a0e16'); grd.addColorStop(1, '#141c2c'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
      g.fillStyle = '#c9d1d9'; g.fillRect(0, 0, W, 40); g.fillStyle = '#0b0d10'; g.font = `900 24px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(which === 'lf' ? 'HOME RUNS' : 'SCORE', W / 2, 21, W - 12);
      g.fillStyle = '#fff'; g.font = `900 ${which === 'lf' ? 110 : 64}px ${FONT}`; g.fillText(which === 'lf' ? String(board.homers | 0) : fmtN(board.score), W / 2, H * 0.52, W - 20);
      g.fillStyle = '#9fb0c4'; g.font = `800 22px ${FONT}`; g.fillText(which === 'lf' ? (board.lastFt ? `LAST ${Math.round(board.lastFt)} FT` : 'SWING AWAY') : `OUTS ${board.outs | 0}/10`, W / 2, H * 0.86, W - 16);
    }
    g.restore(); g.textAlign = 'left';
  }
  function redrawCorners() { const W = cbc.width / 2, H = cbc.height; drawCorner(cbg, 0, W, H, 'lf'); drawCorner(cbg, W, W, H, 'rf'); T.cboard.needsUpdate = true; cornerDirty = false; }
  redrawBoard(0); redrawCorners();

  mark('crowdbuild');
  const crowdObj = crowd.build(); if (crowdObj) { crowdObj.traverse(o => { o.userData.noOcclude = true; }); group.add(crowdObj); }

  mark('end');
  // ======================================================================
  // STATE + API
  // ======================================================================
  let exciteTarget = 0.3, boostT = 0, lastT = 0, flashV = 0;
  const pin = { spin: 0, vel: 0, chase: 0 };
  const fogCol = col(LOOK.fog).lerp(col(horizCol), weather === 'clear' || weather === 'heat' ? 0.55 : 0.3);
  const fog = new THREE.FogExp2(fogCol, LOOK.fogD);
  const bgColor = fogCol.clone();
  const saved = { background: null, fog: null, environment: null, envI: 1, had: false };
  const landmarks = {
    booth: { pos: PK.booth.pos.slice(), look: PK.booth.look.slice() },
    street: polar(-20, fenceAt(-20) + (CON.d0 + CON.d1) / 2, CON.h),                  // the LCF concourse
    boards: [
      { id: 'cf', pos: BOARD.center, w: BOARD.w, h: BOARD.h, normal: [0, 0, 1], spray: SB.spray.slice(), bottom: FACE.y0, top: SB.h },
      ...VB.map(v => ({ id: v.id, pos: v.center, spray: v.spray.slice(), bottom: v.bottom, top: v.top, normal: (() => { const s = (v.spray[0] + v.spray[1]) / 2, d = dirXZ(s); return [-d[0], 0, -d[1]]; })() })),
    ],
    pinwheels: PW.list.map(p => p.center),
    fanDeck: polar(0, fenceAt(0) + (FD.d[0] + FD.d[1]) / 2, FD.h),
    lot: (() => { const p = toW(250, -760); return [p[0], 0, p[1]]; })(),        // south lot (beyond RF)
    ryan: (() => { const p = toW(RYAN.e, -200); return [p[0], 0, p[1]]; })(),    // the Dan Ryan behind LF/CF
    towers: TOWERS.map(t => [t.x, t.top, t.z]),
  };

  const api = {
    group, sunDir: sunDir.clone(), parkId, timeOfDay: tod, weather, quality,
    lights: { key, hemi, rim: rimLight },
    crowd, landmarks,
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
      boostT = Math.max(0, boostT - dt);
      if (waveMsgT > 0) { waveMsgT -= dt; if (waveMsgT <= 0) boardDirty = true; }
      crowd.setExcite(boostT > 0 ? 1 : exciteTarget);
      crowd.update(dt, t);
      flagMesh.material.uniforms.uTime.value = t;
      if (rain) rain.material.uniforms.uTime.value = t;
      T.ribbon.offset.x = (t * 0.018) % 1;
      skyMat.uniforms.uDrift.value = t * 0.0005;
      traffic.U.uTime.value = t;
      FW.update(dt);
      // pinwheels: idle = still (softly lit at night); homer = spin up + chase lights, then coast down
      const idleVel = 0;
      pin.vel = lerp(pin.vel, idleVel, 1 - Math.exp(-dt * (cel.t >= 0 ? 0.25 : 0.8)));
      pin.spin += pin.vel * dt; pin.chase = Math.max(0, pin.chase - dt * 0.22);
      pinU.uSpin.value = pin.spin; pinU.uTime.value = t; pinU.uChase.value = pin.chase;
      flashV = Math.max(0, flashV - dt * 2.5); MB.uniforms.uFlash.value = flashV * 0.6; MCB.uniforms.uFlash.value = flashV * 0.4;
      // board cadence
      if (cel.t >= 0) { cel.t += dt; if (cel.t > cel.dur) { cel.t = -1; boardDirty = true; cornerDirty = true; } }
      boardClock += dt; cornerClock += dt;
      if (cornerClock > 8 && cel.t < 0) { cornerClock = 0; cornerPhase++; cornerDirty = true; }
      const animRate = LO ? 1 / 8 : 1 / 12;
      if (boardDirty || (cel.t >= 0 && boardClock >= animRate)) { boardClock = 0; redrawBoard(t); }
      if (cornerDirty || (cel.t >= 0 && Math.floor((cel.t - dt) * 4) !== Math.floor(cel.t * 4))) redrawCorners();
    },
    setBoard(s = {}) {
      let ch = false;
      for (const k of ['name', 'homers', 'outs', 'score', 'lastFt', 'message', 'charId']) if (s[k] !== undefined && s[k] !== null && board[k] !== s[k]) { board[k] = s[k]; ch = true; }
      if (ch) { boardDirty = true; cornerDirty = true; }
    },
    celebrate({ spray = 0, distance = 0, bonus = null } = {}) {
      if (cel.big && cel.t >= 0 && cel.t < 1.5) { crowd.flash(+spray || 0); return; }   // already running the out-of-the-park show
      cel.t = 0; cel.distance = +distance || 0; cel.bonus = bonus; cel.spray = +spray || 0; cel.big = false; cel.dur = 6.5;
      boardDirty = true; cornerDirty = true; flashV = 1; boostT = 4.5;
      pin.vel = 9; pin.chase = 1.4;
      crowd.flash(cel.spray);
      fireworksShow(false);
    },
    outOfPark({ spray = 0, distance = 0, landing = null, bonus = 'out_of_park' } = {}) {
      cel.t = 0; cel.distance = +distance || 0; cel.bonus = bonus; cel.spray = +spray || 0; cel.big = true; cel.dur = 9;
      boardDirty = true; cornerDirty = true; flashV = 1.4; boostT = 8;
      pin.vel = 16; pin.chase = 2.2;
      crowd.celebrate({ spray: cel.spray, big: true });
      fireworksShow(true);
    },
    wave({ fromSpray = -70, laps = 1.5, speed } = {}) {
      boostT = Math.max(boostT, 2);
      const secs = crowd.wave({ fromSpray, laps, ...(speed ? { speed } : {}) }) || 0;
      waveMsgT = Math.max(3, secs); boardDirty = true;
      return secs;
    },
    setCrowd(level) { exciteTarget = clamp(+level || 0, 0, 1); },
    info() {
      let tris = 0, calls = 0;
      group.traverse(o => { if ((o.isMesh || o.isPoints || o.isLineSegments) && o.visible !== false) { calls++; const g = o.geometry; const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3; tris += o.isInstancedMesh ? n * o.count : g.isInstancedBufferGeometry ? n * (g.instanceCount || 1) : (o.isPoints ? 0 : n); } });
      const timing = {}; for (let i = 1; i < TM.length; i++) timing[TM[i - 1][0]] = Math.round(TM[i][1] - TM[i - 1][1]);
      return { timing, buildMs: Math.round(TM[TM.length - 1][1] - TM[0][1]), calls, tris: Math.round(tris), crowd: crowd.count, crowdRows: rowsAdded, skyAsset: skyArt, art: usedArt.slice(), fireworks: FW.active };
    },
    dispose() {
      for (const d of disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
      try { crowd.dispose(); } catch (e) { /* ignore */ }
      if (carMesh) try { carMesh.dispose(); } catch (e) { /* ignore */ }
      group.clear();
    },
  };
  return api;
}
