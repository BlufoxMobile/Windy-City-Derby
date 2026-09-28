// ============================================================================
// WINDY CITY DERBY — UI (all DOM). Owner: PLAY (v2; v1 UI agent).
// createUI(root, { onEvent, assets, characters, parks }) → UI   (see CONTRACT.md / CONTRACT-v2.md)
// Imports only data.js. Never touches three.js, the game, audio or the network.
// Every screen renders something good with NO assets (procedural fallbacks).
//
// v2 SWING INPUT (the game only ever sees onEvent('swing', { aim, t, batSpeed, uppercut, via })):
//   swipe (default) — drag across the plate. t = the moment the finger STARTED moving (back-dated from the
//     pointer samples, so recognising the gesture never eats the player's timing); emitted as soon as the
//     swipe is unambiguous (≥ 7.5% of the short screen side and ≥ 3 samples / 40 ms, or on lift).
//     batSpeed = (peak speed in screen-heights/s ÷ SWIPE.vMax)^SWIPE.gamma — the same on every phone.
//     A righty's natural swipe is left → right across the plate (a lefty's right → left); the other way
//     works too at SWIPE.reverseMul of the speed. uppercut = the swipe's angle (up = loft). aim = where
//     the swipe STARTS (the PULL / CENTER / OPPO lanes along the bottom).
//   button — a big SWING button (press = swing start, batSpeed = TUNING.batSpeedRef) + PULL/CENTER/OPPO.
//   keyboard — space = swing (ref speed), shift+space = max effort, ←/→ = aim.
// ============================================================================
import {
  CHARACTERS as DEF_CHARS, PARKS as DEF_PARKS, DISTRICTS, OUTS_PER_ROUND, PITCHES, WEATHER, TUNING,
  windLabel, chicagoDate, fenceDistance, hashString, isOutOfPark, VERSION,
} from './data.js';

/** Swipe → swing tuning (exported for tests / tools). Speeds in short-screen-sides per second. */
export const SWIPE = {
  minFrac: 0.075,     // displacement to recognise a swipe (× short side ≈ 29 px on a 390-wide phone)
  liftFrac: 0.045,    // …or this much if the finger already lifted (a quick flick)
  minSamples: 3, maxWait: 40,   // samples after the movement start, or ms, before judging speed
  moveEps: 3,         // px — the finger counts as moving past this
  vMax: 5.2,          // S/s that maps to batSpeed 1 (a hard, confident swipe)
  gamma: 0.7,         // batSpeed = (v / vMax)^gamma: a lazy flick (~1 S/s) ≈ 0.3, a brisk swipe (~3.3 S/s) ≈ 0.72
  reverseMul: 0.88,   // swiping against your natural direction still swings, just not as hard
  upDead: 6, upFull: 38,        // deg — uppercut dead zone / full loft
  scaleMin: 300, scaleMax: 720, // clamp for the short side (desktop windows)
};
export const AIM_LANE = 0.7;       // button mode: PULL / OPPO aim magnitude

// ---------------------------------------------------------------- utilities
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmtDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : ''; };
const TOD = { day: 'DAY', dusk: 'DUSK', night: 'NIGHT' };
const reduceMotion = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
/** Allowed name chars: letters, digits, space . ' _ -   (2–16 after trim). */
export function sanitizeName(s, { final = false } = {}) {
  let v = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .'_-]/g, '').replace(/\s+/g, ' ').replace(/^ /, '').slice(0, 16);
  if (final) v = v.trim();
  return v;
}
const hexLum = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.5;
  const n = parseInt(m[1], 16); const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

// ---------------------------------------------------------------- icons (inline SVG, currentColor)
const IC = {
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="3.6" stroke-dasharray="2.9 2.75"/><circle cx="12" cy="12" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0zM7 5H3.5c0 3 1.5 5 4 5.3M17 5h3.5c0 3-1.5 5-4 5.3M12 13v4M8 21h8l-1-4H9z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="15" r="2.2" fill="currentColor"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.4" fill="currentColor"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  dusk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 16a5.5 5.5 0 0 1 11 0z" fill="currentColor"/><path d="M2.5 19.5h19M12 4.5v3M4.8 8.8l2 2M19.2 8.8l-2 2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.2 6.3 6.3 2.2-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.2z" fill="currentColor"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" fill="currentColor"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.3A3.4 3.4 0 0 0 7 18.5z" fill="currentColor"/></svg>',
  rain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.3A3.4 3.4 0 0 0 7 14.5z" fill="currentColor"/><path d="M8 17.5l-1 3M12.5 17.5l-1 3M17 17.5l-1 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  heat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8c1 3.6 5.6 5.7 5.6 11a5.6 5.6 0 0 1-11.2 0c0-2.6 1.3-4.3 2.6-5.6.2 1.8 1 3 2.2 3.4-.6-3.1-.1-6.2.8-8.8z" fill="currentColor"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 19 11h-4.4v10.5H9.4V11H5z" fill="currentColor"/></svg>',
  calm: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.6 6a8.6 8.6 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V5.5l11-2v12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.8" fill="currentColor"/><circle cx="17.5" cy="15.5" r="2.8" fill="currentColor"/></svg>',
  buzz: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="3.5" width="9" height="17" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 8.5v7M20 8.5v7M1.8 10.5v3M22.2 10.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gfx: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8.5 20.5h7M12 17v3.5M6.5 13.5l3.5-4 2.7 2.6 2.1-2 2.7 3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  fire: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.8 3.5 5.8 5.6 5.8 11.2A5.8 5.8 0 0 1 6.2 14c0-2.7 1.4-4.5 2.7-5.8.3 1.9 1.1 3.1 2.3 3.6-.7-3.3 0-6.5.8-9.3z" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.5s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z" fill="currentColor"/><circle cx="12" cy="10.5" r="2.4" fill="#05070d"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7M6 9.5V20h4.5v-5.5h3V20H18V9.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  again: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3.5v4h-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
IC.swipe = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15.5c3.2-1.8 6.6-2.7 10-2.7 2.6 0 5 .5 7.3 1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m17.6 11.4 3.2 3.1-3.9 1.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="4.2" cy="15" r="2.2" fill="currentColor"/></svg>';
IC.bat = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 19.8 3 18.6l9.7-10.1c1.8-1.9 4.8-4.6 6.6-5.3 1-.4 1.9.5 1.5 1.5-.7 1.8-3.4 4.8-5.3 6.6z" fill="currentColor"/><circle cx="5.2" cy="5.4" r="2.1" fill="currentColor"/></svg>';
const weatherIcon = (w, tod) => (w === 'drizzle' ? IC.rain : w === 'overcast' ? IC.cloud : w === 'heat' ? IC.heat : tod === 'day' ? IC.sun : IC.star);
const todIcon = tod => (tod === 'night' ? IC.moon : tod === 'dusk' ? IC.dusk : IC.sun);
const windArrow = wind => {
  const mph = num(wind?.mph); const dir = num(wind?.dir);
  return mph < 2 ? `<i class="wx-wind calm">${IC.calm}</i>` : `<i class="wx-wind" style="--dir:${dir}deg">${IC.arrow}</i>`;
};

// Stylised fox silhouette (fallback portrait). Colours from the character.
function foxSVG(c, uid) {
  const col = c?.colors || {}; const acc = col.accent || '#35d0ff'; const fur = col.fur || '#d9662b'; const jer = col.jersey || '#0f2f7a';
  const g = `fx${uid}`;
  return `<svg class="fox-sil" viewBox="0 0 200 260" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
  <defs>
    <linearGradient id="${g}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fur}"/><stop offset="1" stop-color="${fur}" stop-opacity=".55"/></linearGradient>
    <linearGradient id="${g}j" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${jer}"/><stop offset="1" stop-color="#050a1a"/></linearGradient>
    <radialGradient id="${g}g" cx=".5" cy=".42" r=".55"><stop offset="0" stop-color="${acc}" stop-opacity=".55"/><stop offset="1" stop-color="${acc}" stop-opacity="0"/></radialGradient>
  </defs>
  <ellipse cx="100" cy="120" rx="100" ry="120" fill="url(#${g}g)"/>
  <path d="M22 262c6-50 30-74 78-78 48 4 72 28 78 78z" fill="url(#${g}j)" stroke="${acc}" stroke-opacity=".6" stroke-width="1.5"/>
  <path d="M100 186l-17 30 17 46 17-46z" fill="#f4efe6" opacity=".9"/>
  <path d="M60 206c4 18 10 36 14 56M140 206c-4 18-10 36-14 56" stroke="${acc}" stroke-width="3" opacity=".75" fill="none"/>
  <path d="M56 26 88 88 44 100z" fill="url(#${g}f)"/><path d="M144 26 112 88 156 100z" fill="url(#${g}f)"/>
  <path d="M60 42 80 84 54 90z" fill="#1b1410" opacity=".45"/><path d="M140 42 120 84 146 90z" fill="#1b1410" opacity=".45"/>
  <path d="M100 68c32 0 55 17 58 42 2 16-8 24-20 30l-30 30q-8 8-16 0l-30-30c-12-6-22-14-20-30 3-25 26-42 58-42z" fill="url(#${g}f)"/>
  <path d="M42 112c16 16 34 22 48 52l10 8 10-8c14-30 32-36 48-52-4 24-26 30-42 48l-16 16-16-16c-16-18-38-24-42-48z" fill="#f4efe6" opacity=".95"/>
  <path d="M50 102c0-44 100-44 100 0l14 4-12 6c-10-20-80-20-94 0l-12-6z" fill="${jer}" stroke="${acc}" stroke-width="2"/>
  <path d="M99 62v36" stroke="${acc}" stroke-width="4" opacity=".8"/>
  <path d="M72 116q9-6 17 1-9 5-17-1zM128 116q-9-6-17 1 9 5 17-1z" fill="${acc}"/>
  <circle cx="100" cy="171" r="5.5" fill="#15100c"/>
</svg>`;
}

// Generic Chicago-ish skyline silhouette (no landmarks' trademarks — just towers).
function skylineSVG(cls = 'skyline') {
  const B = [[0, 26, 60], [24, 18, 88], [40, 30, 70], [68, 14, 120], [80, 22, 96], [100, 34, 150], [132, 16, 110], [146, 26, 210, 1], [170, 20, 130], [188, 30, 176], [216, 18, 104], [232, 26, 140], [256, 36, 250, 2], [290, 22, 160], [310, 18, 120], [326, 30, 186], [354, 16, 96], [368, 28, 230, 1], [394, 22, 140], [414, 34, 110], [446, 18, 150], [462, 26, 90], [486, 30, 124], [514, 20, 80], [532, 30, 104], [560, 40, 64]];
  let d = '';
  for (const [x, w, h, ant] of B) {
    d += `M${x} 300V${300 - h}h${w}V300z`;
    if (ant === 1) d += `M${x + w / 2 - 1.5} ${300 - h}v-26h3v26z`;
    if (ant === 2) d += `M${x + 7} ${300 - h}v-40h3v40zM${x + w - 10} ${300 - h}v-40h3v40zM${x + 4} ${300 - h}l4-12h${w - 16}l4 12z`;
  }
  let win = '';
  for (let i = 0; i < 90; i++) { const b = B[(i * 7) % B.length]; const x = b[0] + 3 + ((i * 13) % Math.max(4, b[1] - 6)); const y = 300 - b[2] + 8 + ((i * 29) % Math.max(10, b[2] - 16)); win += `M${x} ${y}h2v3h-2z`; }
  return `<svg class="${cls}" viewBox="0 0 600 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><path d="${d}" fill="currentColor"/><path d="${win}" fill="#ffd98a" opacity=".55"/></svg>`;
}

// ============================================================================
export function createUI(root, { onEvent = () => {}, assets = null, characters = DEF_CHARS, parks = DEF_PARKS } = {}) {
  const CH = Array.isArray(characters) && characters.length ? characters : DEF_CHARS;
  const CHB = Object.fromEntries(CH.map(c => [c.id, c]));
  const PK = parks && typeof parks === 'object' ? parks : DEF_PARKS;
  const PARK_LIST = Object.keys(PK);
  const emit = (type, payload = {}) => { try { onEvent(type, payload); } catch (e) { console.error('[ui] onEvent', type, e); } };
  let uidN = 0; const uid = () => (++uidN).toString(36);

  // ------------------------------------------------------------ state
  const saved = LS.get('wcd-settings', {}) || {};
  const S = {
    screen: null, screenEl: null, flow: 'free', name: sanitizeName(LS.get('wcd-ui-name', ''), { final: true }), district: LS.get('wcd-ui-district', '') || '',
    charId: CH[0].id, bats: CH[0].bats || 'R', hud: null, hudOn: false, armed: false, aim: 0, swings: 0,
    prefs: { sound: saved.sound !== false, music: saved.music !== false, haptics: saved.haptics !== false, quality: saved.quality || 'auto', swing: saved.swing === 'button' ? 'button' : 'swipe' },
    coach: LS.get('wcd-coach-v2', {}) || {},
    knownBest: num(LS.get('wcd-ui-best', 0)), boardCtl: null, lastSummary: null,
  };
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const cancel = id => { if (id) { clearTimeout(id); timers.delete(id); } };
  const buzz = ms => { if (S.prefs.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* */ } } };

  // ------------------------------------------------------------ art helpers
  const urlCache = new Map();
  function artURL(key) {
    if (urlCache.has(key)) return urlCache.get(key);
    let url = null;
    try {
      const a = assets && assets.get ? assets.get(key) : null;
      if (a) {
        if (typeof a.src === 'string' && a.src && (a.naturalWidth || a.width || a.complete !== false)) url = a.src;
        else if (a.width && a.height && typeof document !== 'undefined') { // ImageBitmap / canvas → data URL once
          const k = Math.min(1, 640 / a.height); const cv = document.createElement('canvas');
          cv.width = Math.round(a.width * k); cv.height = Math.round(a.height * k);
          cv.getContext('2d').drawImage(a, 0, 0, cv.width, cv.height);
          url = cv.toDataURL('image/webp', 0.9);
        }
      }
    } catch (e) { url = null; }
    if (url) urlCache.set(key, url);
    return url;
  }
  const imgTag = (key, cls = '', alt = '') => { const u = artURL(key); return u ? `<img class="${cls}" src="${esc(u)}" alt="${esc(alt)}" draggable="false" decoding="async">` : ''; };
  const portraitTag = (c, cls = 'pt') => imgTag('portrait_' + c.id, cls, c.name) || `<span class="${cls} pt-fallback">${foxSVG(c, uid())}</span>`;
  const avatarTag = id => { const c = CHB[id]; if (!c) return '<span class="ava ava-none"></span>'; const u = artURL('portrait_' + c.id); return `<span class="ava" style="--acc:${esc(c.colors?.accent || '#2f80ff')}">${u ? `<img src="${esc(u)}" alt="" draggable="false">` : foxSVG(c, uid())}</span>`; };
  const parkAccent = p => { const pal = p?.palette || {}; return hexLum(pal.primary) < 0.03 ? (pal.secondary || '#c9d1d9') : (pal.primary || '#2f80ff'); };
  const parkOf = p => (typeof p === 'string' ? PK[p] : p) || PK[PARK_LIST[0]];
  const charOf = c => (typeof c === 'string' ? CHB[c] : c && c.id ? (CHB[c.id] || c) : null) || CHB[S.charId] || CH[0];
  const condChips = (cond, { long = false } = {}) => {
    if (!cond) return '';
    const tod = cond.timeOfDay || 'day'; const w = cond.weather || 'clear'; const wl = windLabel(cond.wind || { mph: 0, dir: 0 });
    return `<span class="chip">${todIcon(tod)}${TOD[tod] || esc(tod).toUpperCase()}</span>`
      + `<span class="chip">${weatherIcon(w, tod)}${esc(WEATHER[w]?.label || w).toUpperCase()}</span>`
      + `<span class="chip chip-wind">${windArrow(cond.wind)}${long ? 'WIND ' : ''}${esc(wl)}</span>`;
  };

  // ------------------------------------------------------------ DOM skeleton
  root.classList?.add('wcd-root');
  const W = document.createElement('div');
  W.className = 'wcd' + (reduceMotion ? ' wcd-rm' : '');
  W.innerHTML = `<div class="wcd-screens"></div>
  <div class="wcd-hud" aria-hidden="true">
    <div id="tapzone" class="wcd-tapzone"></div>
    <canvas class="swipe-trail"></canvas>
    <div class="hud-top">
      <div class="hud-bug">
        <div class="hud-ava"></div>
        <div class="hud-id"><div class="hud-name"></div>
          <div class="hud-outs"><span class="pips">${'<i></i>'.repeat(OUTS_PER_ROUND)}</span><span class="hud-outs-n"></span></div></div>
      </div>
      <div class="hud-board">
        <div class="hud-kv hud-sc"><span class="k">SCORE</span><span class="v js-score">0</span></div>
        <div class="hud-kv hud-hr"><span class="k">HR</span><span class="v js-hr">0</span></div>
      </div>
    </div>
    <div class="hud-sub">
      <div class="hud-streak"></div>
      <div class="hud-wind"></div>
    </div>
    <div class="hud-lanes">
      <div class="lanes"><div class="lane" data-l="0"><span></span></div><div class="lane" data-l="1"><span></span></div><div class="lane" data-l="2"><span></span></div></div>
      <div class="aim-mk"><i></i></div>
      <div class="hud-hint">SWIPE ACROSS THE PLATE</div>
    </div>
    <div class="hud-btns">
      <div class="aim-seg" role="radiogroup" aria-label="Aim"><button data-aim="0" role="radio"><span></span></button><button data-aim="1" role="radio"><span>CENTER</span></button><button data-aim="2" role="radio"><span></span></button></div>
      <button class="swing-btn" aria-label="Swing"><i class="sb-ring"></i><span>SWING</span></button>
    </div>
    <div class="coach"><div class="coach-art"><i class="coach-path"></i><i class="coach-dot"></i></div><div class="coach-t"></div></div>
    <div class="bat-flash"></div>
  </div>
  <div class="wcd-fx"></div>
  <div class="wcd-toasts" role="status" aria-live="polite"></div>
  <div class="wcd-modal"></div>`;
  root.appendChild(W);
  const L = {
    screens: W.querySelector('.wcd-screens'), hud: W.querySelector('.wcd-hud'), tap: W.querySelector('#tapzone'),
    fx: W.querySelector('.wcd-fx'), toasts: W.querySelector('.wcd-toasts'), modal: W.querySelector('.wcd-modal'),
  };
  const H = {
    ava: W.querySelector('.hud-ava'), name: W.querySelector('.hud-name'), pips: [...W.querySelectorAll('.pips i')], outsN: W.querySelector('.hud-outs-n'),
    score: W.querySelector('.js-score'), hr: W.querySelector('.js-hr'), streak: W.querySelector('.hud-streak'), wind: W.querySelector('.hud-wind'),
    lanes: [...W.querySelectorAll('.lane')], mk: W.querySelector('.aim-mk'), hint: W.querySelector('.hud-hint'), bug: W.querySelector('.hud-bug'),
    trail: W.querySelector('.swipe-trail'), btns: W.querySelector('.hud-btns'), seg: [...W.querySelectorAll('.aim-seg button')], swingBtn: W.querySelector('.swing-btn'),
    coach: W.querySelector('.coach'), coachT: W.querySelector('.coach-t'), flash: W.querySelector('.bat-flash'),
  };

  // ------------------------------------------------------------ count-up
  const counters = new WeakMap();
  function countUp(el, to, { from = null, ms = 900, delay = 0, f = fmt } = {}) {
    if (!el) return;
    const prev = counters.get(el); if (prev) cancelAnimationFrame(prev.raf);
    const start = from == null ? num(prev?.val, 0) : from;
    const rec = { val: to, raf: 0 }; counters.set(el, rec);
    if (reduceMotion || ms <= 0 || start === to) { el.textContent = f(to); return; }
    const t0 = performance.now() + delay;
    el.textContent = f(start);
    const step = now => {
      const k = clamp((now - t0) / ms, 0, 1); const e = 1 - (1 - k) ** 3;
      el.textContent = f(start + (to - start) * e);
      if (k < 1) rec.raf = requestAnimationFrame(step);
    };
    rec.raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ screens
  function clearFx() {
    cancel(S.introT); cancel(S.introT2); cancel(S.resT); cancel(S.callT);
    S.introEl = null; L.fx.innerHTML = '';
  }
  function hudOff() {
    if (S.hudOn) S.hud = null;
    S.hudOn = false; S.armed = false; W.classList.remove('hud-on', 'armed');
  }
  function mount(name, html, { keepHud = false } = {}) {
    clearFx(); if (!keepHud) hudOff();
    closeModal(true);
    const el = document.createElement('section');
    el.className = `wcd-screen scr-${name}`;
    el.setAttribute('data-screen', name);
    el.innerHTML = html;
    const old = S.screenEl;
    if (old) { old.classList.add('is-leaving'); old.setAttribute('inert', ''); old.removeAttribute('data-screen'); setTimeout(() => old.remove(), 420); }
    L.screens.appendChild(el);
    S.screen = name; S.screenEl = el; S.boardCtl = null; S.bootEl = null; S.keyNav = null;
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || !el.contains(b) || b.disabled) return;
      buzz(6);
      const act = b.getAttribute('data-act');
      emit('sfx', { name: act === 'back' || act === 'home' ? 'ui_back' : /^(play|daily|go|again|select|park)$/.test(act) ? 'ui_confirm' : 'ui_tap' });
      el.dispatchEvent(new CustomEvent('wcd-act', { detail: { act, el: b } }));
    });
    return el;
  }
  const onAct = (el, fn) => el.addEventListener('wcd-act', e => fn(e.detail.act, e.detail.el));
  const header = (title, { back = true, step = '', right = '' } = {}) => `<header class="scr-head">
      ${back ? `<button class="icon-btn" data-act="back" aria-label="Back">${IC.back}</button>` : '<span class="icon-sp"></span>'}
      <div class="hd-title"><span class="scr-step">${esc(step)}</span><h2>${esc(title)}</h2></div>
      ${right || '<span class="icon-sp"></span>'}</header>`;
  const stepLabel = n => (S.flow === 'daily' ? `DAILY CHALLENGE · STEP ${n} OF 2` : `FREE PLAY · STEP ${n} OF 3`);

  // ---- boot -----------------------------------------------------------------
  function boot(progress = 0, label = '') {
    const p = clamp(num(progress), 0, 1);
    if (S.screen !== 'boot' || !S.bootEl) {
      const el = mount('boot', `<div class="bg-stadium"><i class="flare f1"></i><i class="flare f2"></i>${skylineSVG()}<i class="field"></i></div>
        <div class="boot-c">
          <div class="brand stg" style="--i:0"><span class="brand-dot"></span>BLUFOX MOBILE PRESENTS</div>
          <h1 class="logo stg" style="--i:1"><span class="l1">WINDY CITY</span><span class="l2">DERBY</span><i class="logo-ball"></i></h1>
          <div class="boot-bar stg" style="--i:2"><i class="fill"></i></div>
          <div class="boot-row stg" style="--i:3"><span class="boot-lab"></span><span class="boot-pct"></span></div>
        </div>`);
      S.bootEl = el;
    }
    const el = S.bootEl; if (!el) return;
    el.querySelector('.fill').style.transform = `scaleX(${p})`;
    el.querySelector('.boot-pct').textContent = `${Math.round(p * 100)}%`;
    el.querySelector('.boot-lab').textContent = String(label || (p >= 1 ? 'PLAY BALL' : 'LOADING')).toUpperCase().slice(0, 48);
    el.classList.toggle('done', p >= 1);
  }

  // ---- title ----------------------------------------------------------------
  function title({ daily = null, best = null } = {}) {
    if (best && num(best.score) > S.knownBest) S.knownBest = num(best.score);
    const tp = artURL('title_portrait'), tl = artURL('title_landscape');
    const hasArt = !!(tp || tl);
    const art = hasArt ? `<div class="title-art${tp ? ' has-p' : ''}${tl ? ' has-l' : ''}">${tp ? `<img class="ta-p" src="${esc(tp)}" alt="" draggable="false">` : ''}${tl ? `<img class="ta-l" src="${esc(tl)}" alt="" draggable="false">` : ''}</div>` : '';
    const dp = daily ? parkOf(daily.parkId) : null;
    const dailyCard = daily ? `<button class="daily-card stg" style="--i:1;--pc:${esc(parkAccent(dp))}" data-act="daily">
        <span class="dc-l"><span class="dc-k">${IC.cal}DAILY CHALLENGE<em>${esc(fmtDate(daily.date))}</em></span>
        <span class="dc-park">${esc(dp?.name || '')}</span>
        <span class="dc-cond">${condChips(daily)}</span></span>
        <span class="dc-go">${IC.play}</span></button>` : '';
    const bestChip = best && num(best.score) > 0 ? `<div class="best-chip stg" style="--i:3"><span class="k">${IC.trophy}YOUR BEST</span><b>${fmt(best.score)}</b><span class="s">${num(best.homers)} HR · ${num(best.longest)} FT</span></div>` : '';
    const el = mount('title', `${art || `<div class="bg-stadium bg-title"><i class="flare f1"></i><i class="flare f2"></i><i class="sweep"></i>${skylineSVG()}<i class="field"></i></div>`}
      <div class="title-scrim"></div>
      ${hasArt ? '' : `<h1 class="logo logo-title"><span class="brand">BLUFOX MOBILE</span><span class="l1">WINDY CITY</span><span class="l2">DERBY</span><i class="logo-ball"></i></h1>`}
      <div class="title-ui ${hasArt ? 'with-art' : 'no-art'}">
        <button class="btn btn-primary btn-xl stg" style="--i:0" data-act="play"><span>${IC.play}PLAY</span></button>
        ${dailyCard}
        <div class="title-row stg" style="--i:2">
          <button class="btn btn-ghost" data-act="board"><span>${IC.trophy}LEADERBOARD</span></button>
          ${bestChip}
          <button class="icon-btn title-gear" data-act="settings" aria-label="Settings">${IC.gear}</button>
        </div>
      </div>`);
    onAct(el, act => {
      if (act === 'play') { S.flow = 'free'; emit('play', {}); }
      else if (act === 'daily') { S.flow = 'daily'; emit('daily', { date: daily?.date, parkId: daily?.parkId }); }
      else if (act === 'board') { leaderboard(null, { tab: 'today', district: '' }); emit('board', { tab: 'today', district: '' }); }
      else if (act === 'settings') emit('settings', {});
    });
  }

  // ---- name entry -----------------------------------------------------------
  const jerseyNum = n => (n ? ((hashString(n.toUpperCase()) >>> 0) % 99) + 1 : 26);
  function jerseySVG(id) {
    return `<svg viewBox="0 0 300 250" aria-hidden="true"><defs>
      <linearGradient id="jg${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a4bb0"/><stop offset=".55" stop-color="#0f2f7a"/><stop offset="1" stop-color="#081a48"/></linearGradient>
      <linearGradient id="js${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <path id="jp${id}" d="M70 104 Q150 62 230 104"/></defs>
      <path d="M112 14q38 22 76 0l54 18 52 58-36 34-26-24 4 142H64l4-142-26 24L6 90l52-58z" fill="url(#jg${id})" stroke="#4d95ff" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M112 14q38 22 76 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".9"/>
      <path d="M22 72l30 32M278 72l-30 32" stroke="#fff" stroke-width="5" opacity=".85"/><path d="M28 64l30 32M272 64l-30 32" stroke="#2f80ff" stroke-width="3"/>
      <path d="M68 124v118M232 124v118" stroke="#35a0ff" stroke-width="2" opacity=".55"/>
      <path d="M112 14q38 22 76 0l54 18 52 58-36 34-26-24 4 142H64l4-142-26 24L6 90l52-58z" fill="url(#js${id})"/>
      <text class="jn"><textPath href="#jp${id}" startOffset="50%" text-anchor="middle"></textPath></text>
      <text class="jnum" x="150" y="206" text-anchor="middle"></text>
      <text class="jtag" x="150" y="234" text-anchor="middle">WINDY CITY DERBY</text></svg>`;
  }
  function nameEntry({ name = '', district = '' } = {}) {
    const n0 = sanitizeName(name || S.name, { final: true }); let dist = district || S.district || '';
    if (!DISTRICTS.includes(dist)) dist = '';
    const el = mount('name', `<div class="bg-panel"></div>${header('WHO\'S UP?', { step: stepLabel(1) })}
      <div class="name-c">
        <div class="jersey stg" style="--i:0">${jerseySVG(uid())}</div>
        <p class="lede stg" style="--i:0">Your name goes on the company-wide leaderboard.</p>
        <label class="name-plate stg" style="--i:1"><span class="np-k">PLAYER NAME</span>
          <input class="name-in" type="text" inputmode="text" maxlength="16" autocomplete="nickname" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="YOUR NAME" value="${esc(n0)}" aria-label="Player name, 2 to 16 characters">
          <span class="np-meta"><span class="np-hint">2–16 LETTERS OR NUMBERS</span><span class="np-count"></span></span></label>
        <div class="dist stg" style="--i:2"><div class="dist-k">${IC.pin}DISTRICT <em>OPTIONAL</em></div>
          <div class="chips">${DISTRICTS.map(d => `<button class="chip-btn" data-act="dist" data-d="${esc(d)}" aria-pressed="${d === dist}">${esc(d).toUpperCase()}</button>`).join('')}</div></div>
      </div>
      <footer class="scr-foot stg" style="--i:3"><button class="btn btn-primary btn-lg js-go" data-act="go"><span>CONTINUE${IC.play}</span></button></footer>`);
    const inp = el.querySelector('.name-in'); const go = el.querySelector('.js-go'); const cnt = el.querySelector('.np-count');
    const jn = el.querySelector('.jn textPath'), jnText = el.querySelector('.jn'), jnum = el.querySelector('.jnum'), jer = el.querySelector('.jersey');
    const paintJersey = v => {
      const t = v ? v.toUpperCase() : 'YOUR NAME'; jn.textContent = t; jnText.classList.toggle('ph', !v);
      const est = t.length * 17; if (est > 170) { jnText.setAttribute('textLength', '170'); jnText.setAttribute('lengthAdjust', 'spacingAndGlyphs'); } else { jnText.removeAttribute('textLength'); }
      jnum.textContent = jerseyNum(v);
    };
    const validate = () => { const v = sanitizeName(inp.value, { final: true }); go.disabled = v.length < 2; cnt.textContent = `${v.length}/16`; el.querySelector('.name-plate').classList.toggle('ok', v.length >= 2); paintJersey(v); return v; };
    inp.addEventListener('input', () => { const pos = inp.selectionStart; const s = sanitizeName(inp.value); if (s !== inp.value) { inp.value = s; try { inp.setSelectionRange(pos - 1, pos - 1); } catch { /* */ } } validate(); });
    const submit = () => { const v = validate(); if (v.length < 2) { el.querySelector('.name-plate').classList.remove('shake'); void el.offsetWidth; el.querySelector('.name-plate').classList.add('shake'); return; }
      jer.classList.remove('bump'); void jer.offsetWidth; jer.classList.add('bump');
      S.name = v; S.district = dist; LS.set('wcd-ui-name', v); LS.set('wcd-ui-district', dist); inp.blur(); emit('name', { name: v, district: dist }); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    onAct(el, (act, b) => {
      if (act === 'back') emit('back', { from: 'name' });
      else if (act === 'go') submit();
      else if (act === 'dist') { const d = b.getAttribute('data-d'); dist = dist === d ? '' : d; el.querySelectorAll('[data-act="dist"]').forEach(x => x.setAttribute('aria-pressed', String(x.getAttribute('data-d') === dist))); }
    });
    validate();
  }

  // ---- character select ----------------------------------------------------
  const STATS = [['power', 'POWER'], ['contact', 'CONTACT'], ['eye', 'EYE'], ['clutch', 'CLUTCH']];
  function characterSelect({ selected = null } = {}) {
    let sel = CHB[selected] ? selected : CHB[S.charId] ? S.charId : CH[0].id;
    const cards = CH.map((c, i) => `<button class="cs-card" data-act="pick" data-id="${esc(c.id)}" style="--acc:${esc(c.colors?.accent || '#35d0ff')};--fur:${esc(c.colors?.fur || '#888')};--i:${i}" aria-label="${esc(c.name)}, ${esc(c.role)}">
        <span class="cs-art"><i class="cs-glow"></i><i class="cs-num">${String(i + 1).padStart(2, '0')}</i>${portraitTag(c, 'cs-pt')}</span>
        <span class="cs-info">
          <span class="cs-name">${esc(c.name)}</span>
          <span class="cs-top"><span class="cs-role">${esc(c.role)}</span><span class="cs-bats">BATS ${esc(c.bats)}</span></span>
          <span class="cs-tag">${esc(c.tagline)}</span>
          <span class="cs-stats">${STATS.map(([k, lab]) => { const v = clamp(num(c.stats?.[k]), 0, 10); return `<span class="st${v >= 10 ? ' max' : ''}"><span class="st-k">${lab}</span><i class="st-bar"><s style="--v:${v / 10}"></s></i><b>${v}</b></span>`; }).join('')}</span>
        </span></button>`).join('');
    const thumbs = CH.map(c => `<button class="cs-th" data-act="thumb" data-id="${esc(c.id)}" aria-label="${esc(c.name)}">${avatarTag(c.id)}</button>`).join('');
    const el = mount('character', `<div class="bg-panel"></div>${header('CHOOSE YOUR FOX', { step: stepLabel(2) })}
      <div class="cs-track" tabindex="-1">${cards}</div>
      <footer class="scr-foot cs-foot"><div class="cs-thumbs">${thumbs}</div>
        <button class="btn btn-primary btn-lg js-sel" data-act="select"><span class="js-sel-t"></span></button></footer>`);
    const track = el.querySelector('.cs-track'); const cardEls = [...el.querySelectorAll('.cs-card')];
    const isCarousel = () => getComputedStyle(track).display === 'flex';
    const setSel = (id, { scroll = false, smooth = true } = {}) => {
      if (!CHB[id]) return; sel = id; S.charId = id;
      cardEls.forEach(c => c.classList.toggle('on', c.getAttribute('data-id') === id));
      el.querySelectorAll('.cs-th').forEach(t => t.classList.toggle('on', t.getAttribute('data-id') === id));
      el.querySelector('.js-sel-t').innerHTML = `BAT WITH ${esc(CHB[id].name).toUpperCase()}${IC.play}`;
      if (scroll && isCarousel()) {
        const card = cardEls.find(c => c.getAttribute('data-id') === id);
        if (card) { const left = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2; try { track.scrollTo({ left, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' }); } catch { track.scrollLeft = left; } }
      }
    };
    let st = 0; let lock = 0;
    track.addEventListener('scroll', () => {
      if (!isCarousel() || performance.now() < lock) return;
      cancel(st); st = later(() => {
        const mid = track.scrollLeft + track.clientWidth / 2; let best = null, bd = 1e9;
        for (const c of cardEls) { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = c; } }
        if (best && best.getAttribute('data-id') !== sel) { setSel(best.getAttribute('data-id')); buzz(4); }
      }, 90);
    }, { passive: true });
    onAct(el, (act, b) => {
      if (act === 'back') emit('back', { from: 'character' });
      else if (act === 'pick' || act === 'thumb') {
        const id = b.getAttribute('data-id');
        if (act === 'pick' && id === sel && !isCarousel()) return emit('character', { charId: id });
        lock = performance.now() + 450; setSel(id, { scroll: true });
      } else if (act === 'select') emit('character', { charId: sel });
    });
    S.keyNav = key => {
      const i = CH.findIndex(c => c.id === sel);
      if (key === 'ArrowRight' || key === 'ArrowLeft') { lock = performance.now() + 450; setSel(CH[(i + (key === 'ArrowRight' ? 1 : CH.length - 1)) % CH.length].id, { scroll: true }); buzz(4); return true; }
      if (key === 'Enter') { emit('character', { charId: sel }); return true; }
      return false;
    };
    setSel(sel);
    requestAnimationFrame(() => { lock = performance.now() + 300; setSel(sel, { scroll: true, smooth: false }); });
  }

  // ---- park select -----------------------------------------------------------
  function parkSelect({ daily = null, conditionsPreview = null, selected = null } = {}) {
    const cards = PARK_LIST.map((id, i) => {
      const p = PK[id]; const pal = p.palette || {}; const u = artURL('park_' + id);
      const prev = conditionsPreview ? (conditionsPreview[id] || (conditionsPreview.timeOfDay ? conditionsPreview : null)) : null;
      const bon = Object.values(p.bonus || {}).map(b => `<span>${esc(String(b.label).replace(/!$/, ''))} <b>+${num(b.points)}</b></span>`).join('');
      const isDaily = daily && daily.parkId === id;
      const sideBg = hexLum(pal.primary) < 0.03 ? (pal.secondary || '#c9d1d9') : (pal.primary || '#1f4fbf');
      return `<button class="pk-card${selected === id ? ' on' : ''}" data-act="park" data-id="${esc(id)}" style="--sbg:${esc(sideBg)};--sfg:${hexLum(sideBg) > 0.35 ? '#0a0b0d' : '#ffffff'};--pc:${esc(parkAccent(p))};--p1:${esc(pal.primary || '#1f4fbf')};--p2:${esc(pal.secondary || '#c8372d')};--p3:${esc(pal.trim || '#2e6b34')};--i:${i}">
        <span class="pk-img">${u ? `<img src="${esc(u)}" alt="" draggable="false">` : `<i class="pk-fallback pk-fb-${esc(id)}">${skylineSVG('pk-sky')}</i>`}</span>
        <span class="pk-stripe"><i></i><i></i><i></i></span>
        ${isDaily ? '<span class="pk-daily">TODAY\'S DAILY PARK</span>' : ''}
        <span class="pk-body">
          <span class="pk-side">${esc(p.side || '')}</span>
          <span class="pk-name">${esc(p.name)}</span>
          <span class="pk-blurb">${esc(p.blurb || '')}</span>
          <span class="pk-dims"><span>LF<b>${Math.round(fenceDistance(id, -45))}</b></span><span>CF<b>${Math.round(fenceDistance(id, 0))}</b></span><span>RF<b>${Math.round(fenceDistance(id, 45))}</b></span><span>WALL<b>${num(p.fenceH)}′</b></span></span>
          <span class="pk-bonus">${bon}</span>
          ${prev ? `<span class="pk-cond">${condChips(prev)}</span>` : ''}
        </span>
        <span class="pk-go">PLAY HERE${IC.play}</span></button>`;
    }).join('');
    const el = mount('park', `<div class="bg-panel"></div>${header('PICK YOUR PARK', { step: stepLabel(3) })}
      <div class="pk-list">${cards}</div>
      ${conditionsPreview ? '' : '<p class="pk-note">Time of day, weather and wind roll when you step in.</p>'}`);
    onAct(el, (act, b) => {
      if (act === 'back') emit('back', { from: 'park' });
      else if (act === 'park') { b.classList.add('picked'); emit('park', { parkId: b.getAttribute('data-id') }); }
    });
  }

  // ---- intro (over the batting view) --------------------------------------
  function intro({ park = null, conditions = null, char = null, mode = 'free', daily = null, hold = 3400 } = {}) {
    closeScreen(); clearFx(); hudOff(); closeModal(true);
    const p = parkOf(park); const c = charOf(char); const cond = conditions || (daily ? daily : null) || { timeOfDay: 'day', weather: 'clear', wind: { mph: 0, dir: 0 } };
    if (c) { S.charId = c.id; S.bats = c.bats || 'R'; }
    const isDaily = mode === 'daily';
    const el = document.createElement('div');
    el.className = 'intro'; el.style.setProperty('--pc', parkAccent(p)); el.style.setProperty('--hold', `${Math.max(600, hold)}ms`);
    el.innerHTML = `<i class="intro-dim"></i><i class="intro-wipe w1"></i><i class="intro-wipe w2"></i>
      <div class="intro-card">
        <div class="ic-mode">${isDaily ? `${IC.cal}DAILY CHALLENGE · ${esc(fmtDate(daily?.date || chicagoDate()))}` : 'FREE PLAY'}</div>
        <div class="ic-park">${esc(p?.name || '')}</div>
        <div class="ic-side"><i></i>${esc(p?.side || '')}<i></i></div>
        <div class="ic-cond">${condChips(cond, { long: true })}</div>
        <div class="ic-bat">${c ? `${avatarTag(c.id)}<span class="ic-bat-t"><small>NOW BATTING</small><b>${esc(c.name)}</b><em>${esc(c.role)} · BATS ${esc(c.bats)}</em></span>` : ''}</div>
        <div class="ic-rule"><b>${OUTS_PER_ROUND}</b> OUTS · SWING AWAY</div>
        <div class="ic-timer"><i></i></div>
      </div>
      <div class="intro-skip">TAP TO SKIP</div>`;
    L.fx.appendChild(el); S.introEl = el;
    let done = false;
    const finish = () => {
      if (done) return; done = true; cancel(S.introT);
      el.classList.add('out'); S.introT2 = later(() => { el.remove(); if (S.introEl === el) S.introEl = null; }, 380);
      emit('intro-done', {});
    };
    el.addEventListener('pointerdown', e => { e.preventDefault(); buzz(6); finish(); });
    S.introFinish = finish;
    S.introT = later(finish, Math.max(600, hold));
  }

  // ---- HUD ------------------------------------------------------------------
  function laneLabels() {
    const labs = S.bats === 'L' ? ['OPPO', 'CENTER', 'PULL'] : ['PULL', 'CENTER', 'OPPO'];
    H.lanes.forEach((l, i) => { l.querySelector('span').textContent = labs[i]; });
    H.seg.forEach((b, i) => { b.querySelector('span').textContent = labs[i]; });
    W.classList.toggle('bats-l', S.bats === 'L');
  }
  function hud(state = {}) {
    const st = state || {};
    const c = CHB[st.charId] || CHB[S.charId] || CH[0];
    S.charId = c.id; S.bats = st.bats || c.bats || 'R'; if (st.parkId) S.parkId = st.parkId;
    if (!S.hudOn) { closeScreen(); W.classList.add('hud-on'); S.hudOn = true; laneLabels(); setAim(S.aim); }
    if (st.name) S.name = sanitizeName(st.name, { final: true }) || S.name;
    if (H.ava.getAttribute('data-id') !== c.id) { H.ava.innerHTML = avatarTag(c.id); H.ava.setAttribute('data-id', c.id); laneLabels(); }
    H.name.innerHTML = `<b>${esc((st.name || S.name || c.name)).toUpperCase()}</b><em>${esc(c.name).toUpperCase()}</em>`;
    const outs = clamp(num(st.outs), 0, OUTS_PER_ROUND);
    H.pips.forEach((p, i) => { const was = p.classList.contains('used'); const on = i < outs; p.classList.toggle('used', on); if (on && !was) { p.classList.remove('pop'); void p.offsetWidth; p.classList.add('pop'); } p.classList.toggle('last', !on && i === OUTS_PER_ROUND - 1 && outs === OUTS_PER_ROUND - 1); });
    H.outsN.innerHTML = `<b>${outs}</b>/${OUTS_PER_ROUND}`;
    H.outsN.setAttribute('aria-label', `${outs} of ${OUTS_PER_ROUND} outs`);
    H.bug.classList.toggle('final', outs === OUTS_PER_ROUND - 1);
    L.fx.querySelectorAll('.res-outs[data-pending] b').forEach(b => { b.textContent = outs; b.parentElement.removeAttribute('data-pending'); });
    const prevScore = S.hud ? num(S.hud.score) : 0;
    countUp(H.score, num(st.score), { from: prevScore, ms: num(st.score) > prevScore ? 900 : 0 });
    if (num(st.score) > prevScore) { H.score.parentElement.classList.remove('bump'); void H.score.offsetWidth; H.score.parentElement.classList.add('bump'); }
    const hrPrev = S.hud ? num(S.hud.homers) : 0; H.hr.textContent = num(st.homers);
    if (num(st.homers) > hrPrev) { H.hr.parentElement.classList.remove('bump'); void H.hr.offsetWidth; H.hr.parentElement.classList.add('bump'); }
    const streak = num(st.streak), mult = num(st.mult, 1);
    const clutch = outs === OUTS_PER_ROUND - 1;
    let sh = '';
    if (streak >= 1) sh += `<span class="badge b-streak">${IC.fire}<b>${streak}</b> STRAIGHT${mult > 1 ? `<em>NEXT HR ×${mult}</em>` : ''}</span>`;
    if (clutch) sh += `<span class="badge b-clutch">FINAL OUT<em>CLUTCH ×1.5</em></span>`;
    H.streak.innerHTML = sh;
    if (st.wind) H.wind.innerHTML = `<span class="wind-chip">${windArrow(st.wind)}<span>${esc(windLabel(st.wind))}</span></span>`;
    S.hud = { ...st, outs };
  }
  function hideHud() { hudOff(); clearFx(); }

  // ---- aim + input ----------------------------------------------------------
  const pullSign = () => (S.bats === 'L' ? 1 : -1);          // field direction of PULL for this hitter
  const laneOf = v => (v < -1 / 3 ? 0 : v > 1 / 3 ? 2 : 1);    // screen lane (0 left … 2 right)
  function setAim(v) {
    S.aim = clamp(num(v), -1, 1);
    H.mk.style.setProperty('--x', `${50 + S.aim * 44}%`);
    const lane = laneOf(S.aim);
    H.lanes.forEach((l, i) => l.classList.toggle('on', i === lane));
    H.seg.forEach((b, i) => { b.classList.toggle('on', i === lane); b.setAttribute('aria-checked', String(i === lane)); });
  }
  const aimFromX = x => { const r = L.tap.getBoundingClientRect(); const f = r.width ? (x - r.left) / r.width : 0.5; return clamp((f - 0.5) / 0.44, -1, 1); };
  const batMph = b => Math.round(TUNING.batMph[0] + (TUNING.batMph[1] - TUNING.batMph[0]) * clamp(num(b), 0, 1));
  // event.timeStamp is on the performance.now() clock in every current browser; fall back if a platform hands us epoch ms / 0
  const tsOf = e => { const n = performance.now(), t = e && e.timeStamp; return Number.isFinite(t) && t > 0 && Math.abs(t - n) < 60000 ? t : n; };
  const shortSide = () => clamp(Math.min(innerWidth || 390, innerHeight || 844), SWIPE.scaleMin, SWIPE.scaleMax);

  // ------------------------------------------------ swing mode (swipe | button)
  function setSwingMode(mode) {
    S.prefs.swing = mode === 'button' ? 'button' : 'swipe';
    W.classList.toggle('mode-button', S.prefs.swing === 'button');
    W.classList.toggle('mode-swipe', S.prefs.swing !== 'button');
    if (S.armed) coachMaybe();
  }

  // ------------------------------------------------ coach mark (never blocks input, never holds the sim)
  const COACH_N = 2;   // show until this many swings in the mode (persisted)
  function coachMaybe() {
    const m = S.prefs.swing, seen = num(S.coach[m]);
    if (!S.armed || seen >= COACH_N) { H.coach.classList.remove('show'); return; }
    const natural = S.bats === 'L' ? 'rtl' : 'ltr';
    H.coach.className = `coach show c-${m} c-${natural}`;
    H.coachT.innerHTML = m === 'button'
      ? `${IC.bat}<span><b>TAP SWING</b> AS IT ARRIVES · PICK YOUR LANE</span>`
      : `${IC.swipe}<span><b>SWIPE ACROSS THE PLATE</b> · FASTER = HARDER</span>`;
  }
  function coachDone() {
    const m = S.prefs.swing; S.coach[m] = num(S.coach[m]) + 1; LS.set('wcd-coach-v2', S.coach);
    H.coach.classList.remove('show');
  }

  // ------------------------------------------------ swipe trail (2D canvas, only animates while visible)
  const TR = { ctx: null, dpr: 1, w: 0, h: 0, pts: [], live: false, endAt: 0, raf: 0, col: '#35d0ff', hot: 0 };
  function trailSize() {
    const cv = H.trail; if (!cv) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1), w = innerWidth, h = innerHeight;
    if (TR.w !== w || TR.h !== h || TR.dpr !== dpr) { TR.w = w; TR.h = h; TR.dpr = dpr; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    if (!TR.ctx) TR.ctx = cv.getContext('2d');
  }
  function trailBegin(x, y, t) { trailSize(); TR.pts = [{ x, y, t }]; TR.live = true; TR.hot = 0; TR.col = '#bfe9ff'; trailKick(); }
  function trailAdd(x, y, t) { if (TR.live) { TR.pts.push({ x, y, t }); if (TR.pts.length > 90) TR.pts.splice(0, TR.pts.length - 90); } }
  function trailEnd() { TR.live = false; TR.endAt = performance.now(); trailKick(); }
  function trailKick() { if (!TR.raf && TR.ctx) TR.raf = requestAnimationFrame(trailDraw); }
  function trailDraw() {
    TR.raf = 0; const c = TR.ctx; if (!c) return;
    const now = performance.now(), dpr = TR.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, TR.w * dpr, TR.h * dpr);
    const life = 230, fadeOut = TR.live ? 1 : clamp(1 - (now - TR.endAt) / 260, 0, 1);
    const newest = TR.pts.length ? TR.pts[TR.pts.length - 1].t : now;
    const tNow = TR.live ? Math.min(now, newest + 120) : Math.min(TR.endAt, newest + 120);   // a still finger keeps its trail a beat
    const pts = TR.pts.filter(p => tNow - p.t < life + 40);
    if (pts.length > 1 && fadeOut > 0) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.lineCap = 'round'; c.lineJoin = 'round'; c.globalCompositeOperation = 'lighter';
      const passes = [[26, 0.10, TR.col], [13, 0.28, TR.col], [5.5, 0.9, '#ffffff']];
      for (const [wd, al, col] of passes) {
        c.strokeStyle = col;
        for (let i = 1; i < pts.length; i++) {
          const k = clamp(1 - (tNow - pts[i].t) / life, 0, 1); if (k <= 0) continue;
          c.globalAlpha = al * k * fadeOut; c.lineWidth = wd * (0.35 + 0.65 * k) * (1 + TR.hot * 0.35);
          c.beginPath(); c.moveTo(pts[i - 1].x, pts[i - 1].y); c.lineTo(pts[i].x, pts[i].y); c.stroke();
        }
      }
      const h = pts[pts.length - 1];   // glowing head under the finger
      if (TR.live) { const g = c.createRadialGradient(h.x, h.y, 0, h.x, h.y, 34); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(53,208,255,0)'); c.globalAlpha = 1; c.fillStyle = g; c.beginPath(); c.arc(h.x, h.y, 34, 0, Math.PI * 2); c.fill(); }
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    }
    if (TR.live || fadeOut > 0) TR.raf = requestAnimationFrame(trailDraw); else c.clearRect(0, 0, TR.w * dpr, TR.h * dpr);
  }

  // ------------------------------------------------ bat-speed flash (bottom band, below the pitch path)
  function batFlash(b, x) {
    const el = H.flash; if (!el) return;
    const mph = batMph(b), max = b >= TUNING.maxEffortAt;
    const tier = max ? 't-max' : b >= 0.8 ? 't-hard' : b >= 0.45 ? 't-mid' : 't-easy';
    el.className = `bat-flash ${tier}`; void el.offsetWidth;
    el.style.setProperty('--x', `${clamp(x ?? innerWidth / 2, 90, innerWidth - 90)}px`);
    el.innerHTML = `${max ? '<span class="bf-max">MAX EFFORT</span>' : ''}<span class="bf-row"><b>${mph}</b><small>MPH</small><i class="bf-bar"><s style="--v:${clamp(b, 0.04, 1).toFixed(3)}"></s></i></span>`;
    el.classList.add('show');
    cancel(S.flashT); S.flashT = later(() => el.classList.remove('show'), max ? 1100 : 800);
  }

  // ------------------------------------------------ the swing itself (all input paths end here)
  function armInput(on) {
    S.armed = !!on; W.classList.toggle('armed', S.armed);
    if (S.armed) { clearResult(); coachMaybe(); }
    else {
      H.hint.classList.remove('show'); H.coach.classList.remove('show');
      // The game disarms when a result's hold ends → take the result card down then (not if it was shown < 0.4 s ago).
      if (S.resAt && performance.now() - S.resAt > 400) clearResult();
    }
  }
  function doSwing({ aim = S.aim, t = performance.now(), batSpeed = TUNING.batSpeedRef, uppercut = 0, via = 'tap', x = null, extra = {} } = {}) {
    setAim(aim); S.swings++;
    S.armed = false; W.classList.remove('armed');          // one swing per pitch (the game re-arms the next one)
    buzz(batSpeed >= TUNING.maxEffortAt ? [10, 20, 14] : 8);
    H.hint.classList.remove('show'); coachDone();
    W.classList.remove('swung'); void W.offsetWidth; W.classList.add('swung');
    if (via !== 'button') batFlash(batSpeed, x);
    S.lastSwing = { batSpeed, uppercut, via, aim: S.aim, t };
    emit('swing', { aim: S.aim, t, batSpeed: Math.round(batSpeed * 1000) / 1000, uppercut: Math.round(uppercut * 1000) / 1000, via, ...extra });
  }

  // ------------------------------------------------ swipe recogniser
  const SW = { id: null, pts: [], x0: 0, y0: 0, moveT: null, done: false, armedAtDown: false };
  const dist0 = p => Math.hypot(p.x - SW.x0, p.y - SW.y0);
  /** Estimate when the finger started moving: once it is clearly moving (> moveEps px), interpolate the moment the
   *  displacement first passed 1 px (walking back over slow first samples, so a lazy flick isn't dated late). */
  function moveStart() {
    const P = SW.pts;
    for (let i = 1; i < P.length; i++) {
      if (dist0(P[i]) < SWIPE.moveEps) continue;
      let k = i; while (k > 1 && dist0(P[k - 1]) >= 1) k--;
      const dk = dist0(P[k]), dj = dist0(P[k - 1]), f = clamp((1 - dj) / Math.max(1e-6, dk - dj), 0, 1);
      return P[k - 1].t + (P[k].t - P[k - 1].t) * f;
    }
    return null;
  }
  function swipeEval(final) {
    if (SW.done || SW.id == null) return;
    const P = SW.pts, last = P[P.length - 1], S0 = shortSide();
    const dx = last.x - SW.x0, dy = last.y - SW.y0, D = Math.hypot(dx, dy);
    if (SW.moveT == null) SW.moveT = moveStart();
    if (SW.moveT == null || D < (final ? SWIPE.liftFrac : SWIPE.minFrac) * S0) return;
    const after = P.filter(p => p.t > SW.moveT).length, since = last.t - SW.moveT;
    if (!final && after < SWIPE.minSamples && since < SWIPE.maxWait) return;
    SW.done = true;
    if (!S.armed) return;                                // a swipe between pitches does nothing
    // peak speed: fastest ≥ 10 ms window, never below the average since the movement started
    let vPeak = 0;
    for (let i = P.length - 1; i > 0; i--) {
      let j = i - 1; while (j > 0 && P[i].t - P[j].t < 10) j--;
      const dt = P[i].t - P[j].t; if (dt >= 6) vPeak = Math.max(vPeak, Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) / dt);
    }
    const vAvg = D / Math.max(8, since);
    const v = Math.max(vPeak, vAvg) * 1000 / S0;         // short sides per second
    const natural = S.bats === 'L' ? -1 : 1;             // +1 = left → right
    const horiz = Math.abs(dx) >= 0.3 * D;
    const reverse = horiz && Math.sign(dx) !== natural;
    let batSpeed = Math.pow(clamp(v / SWIPE.vMax, 0, 1), SWIPE.gamma) * (reverse ? SWIPE.reverseMul : 1);
    const ang = Math.atan2(-dy, Math.max(1e-6, Math.abs(dx))) * 180 / Math.PI;   // + = finger moving up the screen
    const uppercut = Math.sign(ang) * clamp((Math.abs(ang) - SWIPE.upDead) / (SWIPE.upFull - SWIPE.upDead), 0, 1);
    TR.col = batSpeed >= TUNING.maxEffortAt ? '#ffc23a' : batSpeed >= 0.8 ? '#ff8a3a' : '#35d0ff'; TR.hot = clamp((batSpeed - 0.5) * 2, 0, 1);
    doSwing({ aim: aimFromX(SW.x0), t: SW.moveT, batSpeed, uppercut, via: 'swipe', x: last.x,
      extra: { speed: Math.round(v * 100) / 100, dir: Math.sign(dx) || natural, natural: !reverse, recognizedAt: last.t, latency: Math.round(last.t - SW.moveT) } });
  }
  function pushSamples(e) {
    let list = null;
    try { list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null; } catch { list = null; }
    if (!list || !list.length) list = [e];
    for (const ev of list) { const p = { x: ev.clientX, y: ev.clientY, t: tsOf(ev) }; SW.pts.push(p); trailAdd(p.x, p.y, p.t); }
    if (SW.pts.length > 160) SW.pts.splice(1, SW.pts.length - 160);
  }
  L.tap.addEventListener('pointerdown', e => {
    if (!S.hudOn) return;
    e.preventDefault();
    if (S.prefs.swing === 'button') {                    // button mode: the field only skips result holds
      if (!S.armed) emit('skip', {}); else { H.swingBtn.classList.remove('nudge'); void H.swingBtn.offsetWidth; H.swingBtn.classList.add('nudge'); }
      return;
    }
    if (SW.id != null && SW.id !== e.pointerId) return;   // ignore a second finger
    try { L.tap.setPointerCapture(e.pointerId); } catch { /* */ }
    const t = tsOf(e);
    SW.id = e.pointerId; SW.pts = [{ x: e.clientX, y: e.clientY, t }]; SW.x0 = e.clientX; SW.y0 = e.clientY; SW.moveT = null; SW.done = false; SW.armedAtDown = S.armed;
    trailBegin(e.clientX, e.clientY, t);
    if (!S.armed) emit('skip', {});
    else setAim(aimFromX(e.clientX));
  }, { passive: false });
  L.tap.addEventListener('pointermove', e => {
    if (!S.hudOn) return;
    if (e.pointerId !== SW.id) { if (e.pointerType === 'mouse' && S.prefs.swing !== 'button' && !e.buttons) setAim(aimFromX(e.clientX)); return; }
    pushSamples(e); swipeEval(false);
  });
  const swipeUp = e => {
    if (e.pointerId !== SW.id) return;
    if (e.type === 'pointerup') { pushSamples(e); swipeEval(true); }
    if (!SW.done && S.armed && SW.armedAtDown && e.type === 'pointerup') { H.hint.classList.add('show'); cancel(S.hintT); S.hintT = later(() => H.hint.classList.remove('show'), 1400); }
    SW.id = null; trailEnd();
    try { L.tap.releasePointerCapture(e.pointerId); } catch { /* */ }
  };
  L.tap.addEventListener('pointerup', swipeUp);
  L.tap.addEventListener('pointercancel', swipeUp);
  L.tap.addEventListener('lostpointercapture', e => { if (e.pointerId === SW.id) { SW.id = null; trailEnd(); } });
  L.tap.addEventListener('contextmenu', e => e.preventDefault());

  // ------------------------------------------------ button mode
  H.swingBtn.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    if (!S.hudOn) return;
    H.swingBtn.classList.remove('hit'); void H.swingBtn.offsetWidth; H.swingBtn.classList.add('hit');
    if (!S.armed) { emit('skip', {}); return; }
    doSwing({ aim: S.aim, t: tsOf(e), batSpeed: TUNING.batSpeedRef, uppercut: 0, via: 'button' });
  }, { passive: false });
  H.seg.forEach((b, i) => b.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); if (!S.hudOn) return;
    const v = i === 1 ? 0 : (i === 0 ? -1 : 1) * AIM_LANE;   // screen-left lane = LF side
    setAim(v); buzz(5); emit('aim', { aim: S.aim });
  }, { passive: false }));
  [H.swingBtn, ...H.seg].forEach(b => b.addEventListener('contextmenu', e => e.preventDefault()));
  addEventListener('resize', () => { if (TR.ctx) trailSize(); });

  const typing = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const onKey = e => {
    if (typing(e.target)) return;
    if (L.modal.classList.contains('open')) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } return; }
    if (S.introEl && (e.code === 'Space' || e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); S.introFinish?.(); return; }
    if (S.hudOn) {
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault(); if (e.repeat) return;
        if (S.armed) doSwing({ aim: S.aim, t: tsOf(e), batSpeed: e.shiftKey ? 1 : TUNING.batSpeedRef, uppercut: 0, via: 'key' });
        else emit('skip', {});
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setAim(Math.round((S.aim + (e.key === 'ArrowLeft' ? -0.5 : 0.5)) * 2) / 2); emit('aim', { aim: S.aim }); }
      return;
    }
    const onBtn = e.target && e.target.closest && e.target.closest('button');
    if (S.keyNav && !(e.key === 'Enter' && onBtn) && S.keyNav(e.key)) { e.preventDefault(); return; }
    if (e.key === 'Escape' && S.screenEl) { const b = S.screenEl.querySelector('[data-act="back"],[data-act="home"]'); if (b) { e.preventDefault(); b.click(); } }
  };
  window.addEventListener('keydown', onKey);

  // ---- pitch callout ----------------------------------------------------------
  function pitchCallout(pitch, { ms = 1700 } = {}) {
    if (!pitch) return;
    clearResult(); cancel(S.callT); L.fx.querySelector('.pcall')?.remove();
    const def = PITCHES[pitch.type] || {};
    const el = document.createElement('div');
    el.className = 'pcall'; el.style.setProperty('--pcol', def.color || '#ffffff');
    el.innerHTML = `<i class="pc-dot"></i><span class="pc-t">${esc(pitch.label || def.label || String(pitch.type || 'PITCH').toUpperCase())}</span><span class="pc-v"><b>${Math.round(num(pitch.mph))}</b>MPH</span>${pitch.n ? `<span class="pc-n">P${num(pitch.n)}</span>` : ''}`;
    L.fx.appendChild(el);
    S.callT = later(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }

  // ---- result -----------------------------------------------------------------
  const OUT_HEAD = { whiff: 'WHIFF', foul: 'FOUL — OUT', grounder: 'GROUNDER', popup: 'POP OUT', liner: 'LINE OUT', flyout: 'FLY OUT', strike: 'STRIKE — OUT', ball: 'BALL' };
  const PLAIN = new Set(['CALLED STRIKE', 'SWING & MISS', 'FOUL BALL', 'GROUNDER', 'POP UP', 'LINE OUT', 'FLY OUT', 'OUT', 'BALL']);
  const dirLabel = spray => { const s = num(spray); const pull = S.bats === 'L' ? s > 15 : s < -15; const oppo = S.bats === 'L' ? s < -15 : s > 15; return pull ? 'PULL' : oppo ? 'OPPO' : 'CENTER'; };
  const timingCls = t => (t === 'PERFECT' ? 't-perfect' : /WAY/.test(t || '') ? 't-way' : 't-ok');
  function clearResult() { cancel(S.resT); S.resAt = 0; L.fx.querySelectorAll('.res,.celeb').forEach(n => { n.classList.add('out'); setTimeout(() => n.remove(), 300); }); }
  function result(res, applied = {}, { ms = 0 } = {}) {
    if (!res) return;
    clearResult(); L.fx.querySelector('.pcall')?.remove();
    L.fx.querySelectorAll('.bc-oop').forEach(n => { n.classList.add('out'); setTimeout(() => n.remove(), 420); });  // the slam hands over to the card
    S.resAt = performance.now();
    const ap = applied || {}; const calls = Array.isArray(ap.callouts) ? ap.callouts : [];
    const kind = res.kind || 'flyout'; const homer = kind === 'homer';
    const el = document.createElement('div');
    const line = [];
    if (res.swung && kind !== 'whiff' && num(res.exitVelo) > 0) { line.push(`${Math.round(num(res.exitVelo))} MPH`); line.push(`${Math.round(num(res.launch))}°`); line.push(dirLabel(res.spray)); }
    const timing = res.swung && res.timingLabel ? `<span class="res-timing ${timingCls(res.timingLabel)}">${esc(res.timingLabel)}</span>` : '';
    const bs = res.swung && Number.isFinite(num(res.batSpeed, NaN)) ? clamp(num(res.batSpeed), 0, 1) : null;
    const batChip = bs == null ? '' : `<span class="res-bat${bs >= TUNING.maxEffortAt ? ' max' : bs >= 0.8 ? ' hard' : ''}"><span class="rb-k">BAT SPEED</span><b>${num(res.batMph) || batMph(bs)}</b><small>MPH</small><i class="rb-bar"><s style="--v:${Math.max(0.04, bs).toFixed(3)}"></s></i>${bs >= TUNING.maxEffortAt ? '<em>MAX</em>' : ''}</span>`;
    if (homer) {
      const d = Math.round(num(res.distance));
      const onlyDist = calls.length <= 1 && num(ap.mult, 1) <= 1;
      const rows = onlyDist ? '' : calls.map((c, i) => {
        const text = c.kind === 'distance' ? 'DISTANCE' : String(c.text || '').replace(/\s*\+\d[\d,]*$/, '');
        const pts = num(c.points);
        return `<li class="rc rc-${esc(c.kind || 'x')}" style="--i:${i}"><span>${esc(text)}</span>${pts ? `<b>+${fmt(pts)}</b>` : ''}</li>`;
      }).join('');
      const big = d >= 450 || !!res.bonus || num(ap.streak) >= 2 || calls.some(c => c.kind === 'record');
      const oop = !!res.outOfPark || (res.bonus && isOutOfPark(S.parkId || 'wrigley', res.bonus));
      el.className = `res res-homer${d >= 450 ? ' long' : ''}${oop ? ' oop' : ''}${calls.some(c => c.kind === 'record') ? ' record' : ''}`;
      el.innerHTML = `<div class="res-hero"><div class="res-head"><span>${oop ? 'OUT OF THE PARK' : 'HOME RUN'}</span></div>
          <div class="res-dist"><b class="js-d">0</b><span>FT</span></div>
          <div class="res-meta">${line.length ? `<span class="res-line">${line.join(' · ')}</span>` : ''}${timing}${batChip}</div></div>
        ${rows ? `<ul class="res-calls">${rows}</ul>` : ''}
        <div class="res-total${onlyDist ? ' solo' : ''}">${num(ap.mult, 1) > 1 ? `<span class="res-mult">×${num(ap.mult)}</span>` : ''}<b>+${fmt(ap.scoreDelta)}</b><small>PTS</small></div>`;
      L.fx.appendChild(el);
      countUp(el.querySelector('.js-d'), d, { from: 0, ms: 950, delay: 180 });
      if (big) {
        const u = artURL('celebrate_' + S.charId);
        if (u) { el.classList.add(S.bats === 'L' ? 'celeb-r' : 'celeb-l'); const cel = document.createElement('div'); cel.className = `celeb${S.bats === 'L' ? ' lefty' : ''}`; cel.style.setProperty('--acc', CHB[S.charId]?.colors?.accent || '#35d0ff'); cel.innerHTML = `<i class="celeb-glow"></i><img src="${esc(u)}" alt="" draggable="false">`; L.fx.insertBefore(cel, el); }
      }
      S.resT = later(clearResult, ms || 6000);
    } else {
      const head = OUT_HEAD[kind] || 'OUT';
      const extra = calls.filter(c => !(c.kind === 'out' && PLAIN.has(String(c.text || '').toUpperCase())) && c.kind !== 'ball')
        .map((c, i) => `<li class="rc rc-${esc(c.kind || 'x')}" style="--i:${i}"><span>${esc(c.text)}</span></li>`).join('');
      const dist = res.swung && num(res.distance) > 5 && kind !== 'whiff' ? `${Math.round(num(res.distance))} FT · ` : '';
      const sub = kind === 'ball' ? 'NO OUT · GOOD EYE' : kind === 'strike' ? 'CALLED STRIKE · IT WAS IN THE ZONE' : '';
      el.className = `res res-out k-${esc(kind)}${kind === 'ball' ? ' is-ball' : ''}`;
      el.innerHTML = `<div class="res-hero"><div class="res-head"><span>${esc(head)}</span></div>
          <div class="res-meta">${dist || line.length ? `<span class="res-line">${dist}${line.join(' · ')}</span>` : ''}${sub ? `<span class="res-line">${sub}</span>` : ''}${timing}${batChip}</div></div>
        ${extra ? `<ul class="res-calls">${extra}</ul>` : ''}
        ${ap.out ? `<div class="res-outs" data-pending="1">OUT <b>${clamp(num(S.hud?.outs) + 1, 1, OUTS_PER_ROUND)}</b> OF ${OUTS_PER_ROUND}</div>` : ''}`;
      L.fx.appendChild(el);
      S.resT = later(clearResult, ms || 5000);
    }
  }

  // ---- broadcast callouts: OUT OF THE PARK / THE WAVE (upper band — never over the pitch path) ------------------
  const OOP_WHERE = {
    street_l: 'ONTO WAVELAND AVE', street_r: 'ONTO SHEFFIELD AVE', rooftop: 'UP ON THE ROOFTOPS', over_cf: null, out_of_park: 'INTO THE PARKING LOT',
  };
  function outOfPark({ parkId = S.parkId || 'wrigley', bonus = null, distance = 0, ms = 3200 } = {}) {
    const P = PK[parkId] || PK.wrigley;
    L.fx.querySelector('.bc-oop')?.remove();
    const where = bonus === 'over_cf' ? (parkId === 'rate' ? 'OVER THE BIG BOARD' : 'OVER THE SCOREBOARD') : (OOP_WHERE[bonus] || 'CLEAN OUT OF THE YARD');
    const pal = P.palette || {};
    const el = document.createElement('div');
    el.className = `bc bc-oop p-${esc(parkId)}`;
    el.style.setProperty('--c1', parkId === 'rate' ? '#0d0f13' : (pal.primary || '#1f4fbf'));
    el.style.setProperty('--c2', parkId === 'rate' ? '#c9d1d9' : (pal.secondary || '#c8372d'));
    el.innerHTML = `<i class="bc-flash"></i><div class="bc-bar"><i class="bc-sweep"></i>
        <span class="bc-kick"><i></i>${esc(P.name || '')}<i></i></span>
        <span class="bc-t"><span class="w1">OUT OF</span><span class="w2">THE PARK</span></span>
        <span class="bc-sub"><b>${esc(where)}</b>${distance ? `<em>${Math.round(num(distance))} FT</em>` : ''}</span></div>
      <div class="bc-sparks">${'<i></i>'.repeat(14)}</div>`;
    L.fx.appendChild(el);
    buzz([30, 50, 30, 50, 80]);
    later(() => { el.classList.add('out'); later(() => el.remove(), 420); }, Math.max(1200, ms));
    return el;
  }
  function wave({ streak = 3, ms = 2600 } = {}) {
    L.fx.querySelector('.bc-wave')?.remove(); clearResult();
    const el = document.createElement('div');
    el.className = 'bc bc-wave';
    el.innerHTML = `<div class="bw-card"><div class="bw-crowd">${Array.from({ length: 22 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
        <span class="bw-t">THE WAVE!</span><span class="bw-sub"><b>${num(streak)}</b> STRAIGHT · THE WHOLE PARK IS UP</span></div>`;
    L.fx.appendChild(el);
    later(() => { el.classList.add('out'); later(() => el.remove(), 420); }, Math.max(1200, ms));
    return el;
  }

  // ---- leaderboard panel (shared by roundOver + leaderboard screen) -------------
  const TABS = [['today', 'TODAY'], ['alltime', 'ALL-TIME'], ['longest', 'LONGEST']];
  function boardPanel(host, { tab = 'today', district = '', me = null, compact = false, onChange }) {
    const P = { tab, district };
    host.innerHTML = `<div class="lb${compact ? ' lb-compact' : ''}">
      <div class="lb-tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="lb-tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>
      <div class="lb-dist chips">${['', ...DISTRICTS].map(d => `<button class="chip-btn sm" data-d="${esc(d)}" aria-pressed="${d === district}">${d ? esc(d).toUpperCase() : 'ALL'}</button>`).join('')}</div>
      <div class="lb-note"></div>
      <ol class="lb-list"></ol></div>`;
    const list = host.querySelector('.lb-list'); const note = host.querySelector('.lb-note');
    const sync = () => {
      host.querySelectorAll('.lb-tab').forEach(b => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === P.tab)));
      host.querySelectorAll('.lb-dist .chip-btn').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-d') === P.district)));
      host.querySelector('.lb').setAttribute('data-tab', P.tab);
    };
    let busy = false;
    const loading = () => { busy = true; list.innerHTML = '<li class="lb-skel"></li>'.repeat(compact ? 4 : 7); note.textContent = ''; list.classList.add('is-loading'); };
    const render = (data, t = P.tab, d = P.district) => {
      if (busy && (t !== P.tab || (d || '') !== P.district)) return; // stale response for a tab the player already left
      busy = false; P.tab = t; P.district = d || ''; sync(); list.classList.remove('is-loading');
      const rows = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
      const longest = P.tab === 'longest';
      note.innerHTML = data && data.remote === false ? '<span class="off">OFFLINE</span> Showing scores saved on this device.' : data && data.ok === false ? '<span class="off">UNAVAILABLE</span> Leaderboard couldn\'t load. Your score is saved on this device.' : '';
      if (!rows.length) { list.innerHTML = `<li class="lb-empty">${P.tab === 'today' ? 'No scores yet today.' : 'No scores yet.'}<b>BE THE FIRST ON THE BOARD</b></li>`; return; }
      let meHit = false;
      list.innerHTML = rows.slice(0, compact ? 25 : 50).map((r, i) => {
        const rank = num(r.rank, i + 1); const isMe = !meHit && me && String(r.name || '').toLowerCase() === String(me.name || '').toLowerCase() && (longest ? num(r.longest) === num(me.longest) : num(r.score) === num(me.score));
        if (isMe) meHit = true;
        const pk = PK[r.parkId];
        return `<li class="lb-row${rank <= 3 ? ` top top${rank}` : ''}${isMe ? ' me' : ''}" style="--i:${Math.min(i, 12)}">
          <span class="lb-rank">${rank}</span>${avatarTag(r.charId)}
          <span class="lb-who"><b>${esc(String(r.name || 'PLAYER').slice(0, 16))}</b><small>${esc(r.district ? String(r.district).toUpperCase() : '')}${r.district && pk ? ' · ' : ''}${pk ? esc(pk.name) : ''}</small></span>
          <span class="lb-sub">${longest ? `${fmt(r.score)}<small>PTS</small>` : `${num(r.homers)}<small>HR</small>`}</span>
          <span class="lb-val">${longest ? `${fmt(r.longest)}<small>FT</small>` : fmt(r.score)}</span></li>`;
      }).join('');
      const meRow = list.querySelector('.me'); if (meRow && !compact) try { meRow.scrollIntoView({ block: 'nearest' }); } catch { /* */ }
    };
    host.addEventListener('click', e => {
      const t = e.target.closest('.lb-tab'); const d = e.target.closest('.lb-dist .chip-btn');
      if (!t && !d) return;
      buzz(5); emit('sfx', { name: 'ui_tap' });
      if (t) P.tab = t.getAttribute('data-tab');
      if (d) P.district = d.getAttribute('data-d');
      sync(); loading(); onChange?.(P.tab, P.district);
    });
    sync();
    return { render, loading, get tab() { return P.tab; }, get district() { return P.district; } };
  }

  // ---- round over -------------------------------------------------------------
  function roundOver(summary = {}, opts = {}) {
    const s = summary || {}; S.lastSummary = s;
    const c = CHB[s.charId] || CHB[S.charId] || CH[0]; const p = PK[s.parkId];
    const prevBest = Math.max(S.knownBest, num(LS.get('wcd-ui-best', 0)));
    const isPB = typeof opts.personalBest === 'boolean' ? opts.personalBest : num(s.score) > 0 && num(s.score) > prevBest;
    if (num(s.score) > prevBest) { S.knownBest = num(s.score); LS.set('wcd-ui-best', S.knownBest); }
    const celebU = num(s.homers) > 0 ? artURL('celebrate_' + c.id) : null;
    const hero = celebU ? `<img class="ro-fox" src="${esc(celebU)}" alt="" draggable="false">` : `<span class="ro-fox ro-fox-p">${portraitTag(c, 'ro-pt')}</span>`;
    const daily = s.mode === 'daily';
    const me = { name: opts.name || S.name, score: num(s.score), longest: num(s.longest) };
    const el = mount('roundover', `<div class="bg-panel bg-ro"></div>
      <div class="ro-grid">
        <div class="ro-main">
          <div class="ro-kick stg" style="--i:0"><span class="ro-tag">${daily ? `${IC.cal}DAILY CHALLENGE · ${esc(fmtDate(s.date))}` : `FREE PLAY${p ? ` · ${esc(p.name)}` : ''}`}</span></div>
          <div class="ro-hero stg" style="--i:1;--acc:${esc(c.colors?.accent || '#35d0ff')}">
            <div class="ro-foxwrap">${hero}</div>
            <div class="ro-score"><span class="k">FINAL SCORE</span><b class="js-final">0</b>
              ${isPB ? '<span class="pb-flag">NEW PERSONAL BEST</span>' : ''}
              <span class="ro-who">${me.name ? `${esc(me.name).toUpperCase()} · ` : ''}${esc(c.name).toUpperCase()} · ${esc(c.role)}</span></div>
          </div>
          <div class="ro-tiles stg" style="--i:2">
            <div class="tile"><span class="k">HOME RUNS</span><b>${num(s.homers)}</b></div>
            <div class="tile${num(s.longest) >= 450 ? ' gold' : ''}"><span class="k">LONGEST</span><b>${num(s.longest)}<small>FT</small></b></div>
            <div class="tile"><span class="k">BEST STREAK</span><b>${num(s.bestStreak)}</b></div>
            ${num(s.outOfPark) ? `<div class="tile gold oop"><span class="k">OUT OF PARK</span><b>${num(s.outOfPark)}</b></div>` : `<div class="tile"><span class="k">AVG DIST</span><b>${num(s.avgDistance) || '—'}${num(s.avgDistance) ? '<small>FT</small>' : ''}</b></div>`}
          </div>
          <div class="ro-post stg" style="--i:3"><span class="spin"></span><span class="ro-post-t">POSTING TO LEADERBOARD…</span></div>
        </div>
        <div class="ro-actions stg" style="--i:4">
          <button class="btn btn-primary btn-lg" data-act="again"><span>${IC.again}PLAY AGAIN</span></button>
          <div class="ro-row"><button class="btn btn-ghost" data-act="change"><span>${IC.swap}CHANGE FOX</span></button>
          <button class="btn btn-ghost" data-act="home"><span>${IC.home}HOME</span></button></div>
        </div>
        <div class="ro-board stg" style="--i:3"><div class="ro-board-h"><span>${IC.trophy}LEADERBOARD</span><em>${daily ? esc(fmtDate(s.date || chicagoDate())) : 'ALL-TIME'}</em></div><div class="js-lb"></div></div>
      </div>`);
    countUp(el.querySelector('.js-final'), num(s.score), { from: 0, ms: 1400, delay: 350 });
    const date = s.date || chicagoDate();
    const fetcher = typeof opts.board === 'function' ? opts.board : null;
    let reqN = 0;
    const load = (tab, district) => {
      const n = ++reqN;
      if (fetcher) {
        Promise.resolve().then(() => fetcher({ board: tab, date, district, limit: 25 }))
          .then(d => { if (n === reqN && S.boardCtl === ctl) ctl.render(d, tab, district); })
          .catch(() => { if (n === reqN && S.boardCtl === ctl) ctl.render({ ok: false, rows: [], remote: false }, tab, district); });
      } else emit('board-tab', { tab, district, from: 'roundover' });
    };
    // Daily-challenge rounds rank on TODAY; free play ranks ALL-TIME (the Worker/net.js rank follows the round's mode).
    const homeTab = daily ? 'today' : 'alltime', rankWord = daily ? 'TODAY' : 'ALL-TIME';
    const ctl = boardPanel(el.querySelector('.js-lb'), { tab: homeTab, district: '', me, compact: true, onChange: load });
    S.boardCtl = ctl; ctl.loading();
    const post = el.querySelector('.ro-post'); const postT = el.querySelector('.ro-post-t');
    const setPost = (cls, html) => { post.className = `ro-post show ${cls}`; postT.innerHTML = html; };
    const sub = opts.submitting;
    if (sub && typeof sub.then === 'function') {
      sub.then(r => {
        if (S.boardCtl !== ctl) return;
        if (!r) { setPost('warn', me.name ? 'SCORE NOT POSTED' : 'ADD A NAME TO POST SCORES'); load(homeTab, ''); return; }
        const rank = num(r.rank) || num(r.boards && r.boards[homeTab]) || 0;
        const lr = num(r.boards && r.boards.longest);
        const longTxt = lr && lr <= 10 ? ` <span class="ro-post-sub">· LONGEST <b>#${lr}</b></span>` : '';
        if (r.ok && r.remote !== false) setPost(rank && rank <= 3 ? 'gold' : 'ok', rank ? `${IC.check}POSTED · <b>#${rank}</b> ${rankWord}${longTxt}` : `${IC.check}POSTED TO THE LEADERBOARD`);
        else if (r.ok) setPost('warn', rank ? `SAVED ON THIS DEVICE · #${rank}${daily ? ' TODAY' : ''} · OFFLINE` : 'SAVED ON THIS DEVICE · LEADERBOARD OFFLINE');
        else setPost('warn', 'COULDN\'T POST · SAVED ON THIS DEVICE');
        const b = r.boards && r.boards[homeTab];
        if (b && (Array.isArray(b) || Array.isArray(b.rows))) ctl.render(Array.isArray(b) ? { ok: true, rows: b, remote: r.remote } : { remote: r.remote, ...b }, homeTab, '');
        else load(homeTab, '');
      }, () => { if (S.boardCtl === ctl) { setPost('warn', 'COULDN\'T REACH THE LEADERBOARD'); load(homeTab, ''); } });
    } else { setPost('muted', 'PRACTICE ROUND · NOT POSTED'); load(homeTab, ''); }
    onAct(el, act => {
      if (act === 'again') emit('again', {});
      else if (act === 'change') emit('change-fox', {});
      else if (act === 'home') emit('home', {});
    });
  }

  // ---- leaderboard screen ---------------------------------------------------------
  function leaderboard(data = null, { tab = 'today', district = '' } = {}) {
    // If the round-over screen is up, feed its embedded board instead of switching screens.
    if (S.screen === 'roundover' && S.boardCtl) { S.boardCtl.render(data, tab, district); return; }
    if (S.screen === 'leaderboard' && S.boardCtl) { S.boardCtl.render(data, tab, district); return; }
    const el = mount('leaderboard', `<div class="bg-panel"></div>${header('LEADERBOARD', { step: `BLUFOX MOBILE · ${fmtDate(chicagoDate())}`, right: '' })}
      <div class="lbs-c"><div class="js-lb"></div></div>`);
    const ctl = boardPanel(el.querySelector('.js-lb'), { tab, district, me: { name: S.name, score: S.knownBest, longest: -1 }, onChange: (t, d) => emit('board-tab', { tab: t, district: d, from: 'leaderboard' }) });
    S.boardCtl = ctl;
    if (data) ctl.render(data, tab, district); else ctl.loading();
    onAct(el, act => { if (act === 'back') emit('home', { from: 'leaderboard' }); });
  }

  // ---- toast -------------------------------------------------------------------
  function toast(text, { ms = 2400, kind = '' } = {}) {
    const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = String(text ?? '');
    L.toasts.appendChild(t);
    while (L.toasts.children.length > 3) L.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms);
  }

  // ---- settings (modal over whatever is showing) -------------------------------------
  function closeModal(silent = false) {
    if (!L.modal.classList.contains('open')) return;
    L.modal.classList.remove('open'); const m = L.modal.firstElementChild; if (m) m.classList.add('out');
    setTimeout(() => { if (!L.modal.classList.contains('open')) L.modal.innerHTML = ''; }, 260);
    if (!silent) emit('settings-close', { ...S.prefs });
  }
  function settings(cur = {}) {
    Object.assign(S.prefs, Object.fromEntries(Object.entries(cur || {}).filter(([k]) => k in S.prefs)));
    setSwingMode(S.prefs.swing);
    const P = S.prefs;
    const tog = (k, lab, ic, sub) => `<button class="set-row" data-k="${k}" role="switch" aria-checked="${!!P[k]}"><span class="set-ic">${ic}</span><span class="set-t"><b>${lab}</b><small>${sub}</small></span><span class="sw"><i></i></span></button>`;
    L.modal.innerHTML = `<div class="modal-back" data-close="1"></div><div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-h"><h2>SETTINGS</h2><button class="icon-btn" data-close="1" aria-label="Close">${IC.check}</button></div>
      <div class="set-col">
      ${tog('sound', 'SOUND', IC.sound, 'Bat cracks, crowd, organ')}
      ${tog('music', 'MUSIC', IC.music, 'Ballpark organ between pitches')}
      ${tog('haptics', 'HAPTICS', IC.buzz, 'Vibration on contact')}</div>
      <div class="set-col">
      <div class="set-row set-q"><span class="set-ic">${IC.swipe}</span><span class="set-t"><b>SWING CONTROL</b><small>Swipe across the plate, or a big SWING button</small></span></div>
      <div class="seg seg2" role="radiogroup" aria-label="Swing control">${[['swipe', 'SWIPE'], ['button', 'BUTTON']].map(([k, l]) => `<button role="radio" data-sw="${k}" aria-checked="${P.swing === k}">${l}</button>`).join('')}</div>
      <div class="set-row set-q"><span class="set-ic">${IC.gfx}</span><span class="set-t"><b>GRAPHICS</b><small>Lower = smoother on older phones</small></span></div>
      <div class="seg" role="radiogroup" aria-label="Graphics quality">${['auto', 'high', 'medium', 'low'].map(q => `<button role="radio" data-q="${q}" aria-checked="${P.quality === q}">${q.toUpperCase()}</button>`).join('')}</div>
      <button class="btn btn-primary btn-md modal-done" data-close="1"><span>DONE</span></button>
      <div class="modal-foot">WINDY CITY DERBY v${esc(VERSION)} · BLUFOX MOBILE</div></div></div>`;
    L.modal.classList.add('open');
    const m = L.modal.querySelector('.modal');
    m.addEventListener('click', e => {
      const r = e.target.closest('.set-row[data-k]'); const q = e.target.closest('[data-q]'); const sw = e.target.closest('[data-sw]');
      if (sw) { setSwingMode(sw.getAttribute('data-sw')); m.querySelectorAll('[data-sw]').forEach(b => b.setAttribute('aria-checked', String(b === sw))); buzz(6); emit('setting', { swing: S.prefs.swing }); emit('sfx', { name: 'ui_tap' }); }
      if (r) { const k = r.getAttribute('data-k'); P[k] = !P[k]; r.setAttribute('aria-checked', String(P[k])); buzz(6); emit('setting', { [k]: P[k] }); emit('sfx', { name: 'ui_tap' }); }
      if (q) { P.quality = q.getAttribute('data-q'); m.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-checked', String(b === q))); buzz(6); emit('setting', { quality: P.quality }); emit('sfx', { name: 'ui_tap' }); }
    });
    L.modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { buzz(5); emit('sfx', { name: 'ui_back' }); closeModal(); }));
  }

  // ---- hide -----------------------------------------------------------------------
  function closeScreen() {
    const old = S.screenEl; if (!old) return;
    old.classList.add('is-leaving'); old.setAttribute('inert', ''); setTimeout(() => old.remove(), 420);
    S.screen = null; S.screenEl = null; S.boardCtl = null; S.bootEl = null;
  }
  function hide() { closeScreen(); clearFx(); closeModal(true); }

  setAim(0); laneLabels(); setSwingMode(S.prefs.swing);

  return {
    boot, title, nameEntry, characterSelect, parkSelect, intro, hud, hideHud, pitchCallout,
    aim: setAim, armInput, result, roundOver, leaderboard, toast, settings, hide,
    /** v2 */ outOfPark, wave, setSwingMode, get swingMode() { return S.prefs.swing; }, get lastSwing() { return S.lastSwing || null; },
    /** extras (not in CONTRACT; safe to ignore) */
    get screen() { return S.screen; }, get aimValue() { return S.aim; }, el: W,
    dispose() { window.removeEventListener('keydown', onKey); timers.forEach(clearTimeout); W.remove(); },
  };
}
