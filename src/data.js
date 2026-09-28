// ============================================================================
// WINDY CITY DERBY — shared data + tuning. SINGLE SOURCE OF TRUTH.
// Every module imports from here. Pure JS: no DOM, no three.js (runs in node).
// Owner: lead (park geometry etc.). v2: PLAY owns TUNING, scoring, bonus labels/
// points, classifyLanding / isOutOfPark. Everyone else: READ only.
// ----------------------------------------------------------------------------
// WORLD UNITS = FEET. Home plate apex at origin. +Y up.
// The batting camera sits behind home plate and looks toward center field,
// which is the -Z direction (three.js cameras look down -Z by default).
// So on screen during batting: screen-right = +X = first-base / right-field side.
//   Pitcher's rubber (0, 0.83, -60.5) · 2B (0,0,-127.28) · 1B (+63.64,0,-63.64)
//   3B (-63.64,0,-63.64)
// SPRAY ANGLE (deg): 0 = dead center, -45 = left-field (3B) line, +45 = right-
// field (1B) line. Direction on the ground for spray s: (sin s, 0, -cos s).
// ============================================================================

export const VERSION = '2.0.0';
export const GAME_TITLE = 'WINDY CITY DERBY';
export const OUTS_PER_ROUND = 10;

// ---------------------------------------------------------------------------
// CHARACTERS — 6 anthropomorphic fox hitters.
//  stats: 1-10 display bars only (UI). swing: the numbers the sim uses.
//  window     timing sigma in SECONDS: quality_t = exp(-(err/window)^2)
//  whiffAt    |timing err| beyond window*whiffAt = swing and miss
//  aimTol     tolerance for aim-vs-pitch-location mismatch (bigger = forgiving)
//  evMax/evMin exit velocity (mph) at perfect / worst contact
//  launch     base launch angle (deg) on a perfect swing at a belt-high pitch
//  breakWindowMul  multiplies window AND aimTol vs changeup/curveball/slider
//  readBonus  0..1 — "the eye": read ring shows earlier & already includes the
//             break; pitch clock runs slower near the plate (see TUNING.eye*)
//  streakEv   +mph per consecutive homer in the current streak (cap streakEvCap)
// ---------------------------------------------------------------------------
export const CHARACTERS = [
  { id: 'rocco', name: 'Rocco', gender: 'M', bats: 'R', role: 'POWER SLUGGER',
    tagline: 'Huge distance. Tiny sweet spot.',
    stats: { power: 10, contact: 3, eye: 5, clutch: 5 },
    swing: { window: 0.062, whiffAt: 2.6, aimTol: 0.55, evMax: 119, evMin: 68, launch: 27, breakWindowMul: 1, readBonus: 0, streakEv: 0, streakEvCap: 0 },
    colors: { fur: '#9aa9b8', jersey: '#0f2f7a', accent: '#ffb000' } },
  { id: 'jett', name: 'Jett', gender: 'M', bats: 'L', role: 'CONTACT HITTER',
    tagline: 'Big sweet spot. Less carry.',
    stats: { power: 5, contact: 10, eye: 6, clutch: 5 },
    swing: { window: 0.090, whiffAt: 2.8, aimTol: 1.10, evMax: 107, evMin: 74, launch: 25, breakWindowMul: 1, readBonus: 0, streakEv: 0, streakEvCap: 0 },
    colors: { fur: '#d9662b', jersey: '#0f2f7a', accent: '#35d0ff' } },
  { id: 'dex', name: 'Dex', gender: 'M', bats: 'L', role: 'THE EYE',
    tagline: 'Extra time to read every pitch.',
    stats: { power: 6, contact: 7, eye: 10, clutch: 5 },
    swing: { window: 0.064, whiffAt: 2.6, aimTol: 0.85, evMax: 109, evMin: 72, launch: 26, breakWindowMul: 1, readBonus: 1, streakEv: 0, streakEvCap: 0 },
    colors: { fur: '#eef2f6', jersey: '#0f2f7a', accent: '#7cff6b' } },
  { id: 'blaze', name: 'Blaze', gender: 'F', bats: 'R', role: 'MOONSHOT SLUGGER',
    tagline: 'Sky-high launch. Hates breaking balls.',
    stats: { power: 9, contact: 5, eye: 4, clutch: 5 },
    swing: { window: 0.078, whiffAt: 2.5, aimTol: 0.75, evMax: 115, evMin: 70, launch: 33, breakWindowMul: 0.55, readBonus: 0, streakEv: 0, streakEvCap: 0 },
    colors: { fur: '#e2481f', jersey: '#0f2f7a', accent: '#ff7a1a' } },
  { id: 'nova', name: 'Nova', gender: 'F', bats: 'R', role: 'ALL-AROUND',
    tagline: 'Balanced everything. No weak spots.',
    stats: { power: 7, contact: 7, eye: 7, clutch: 7 },
    swing: { window: 0.068, whiffAt: 2.6, aimTol: 0.85, evMax: 110, evMin: 72, launch: 27, breakWindowMul: 1, readBonus: 0.25, streakEv: 0, streakEvCap: 0 },
    colors: { fur: '#2f7dff', jersey: '#0f2f7a', accent: '#bfe3ff' } },
  { id: 'skye', name: 'Skye', gender: 'F', bats: 'L', role: 'CLUTCH',
    tagline: 'Power grows with every straight homer.',
    stats: { power: 6, contact: 7, eye: 6, clutch: 10 },
    swing: { window: 0.084, whiffAt: 2.6, aimTol: 0.85, evMax: 104, evMin: 72, launch: 27, breakWindowMul: 1, readBonus: 0, streakEv: 3.5, streakEvCap: 17.5 },
    colors: { fur: '#8f7dff', jersey: '#0f2f7a', accent: '#ff5fd2' } },
];
export const CHAR_BY_ID = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

// ---------------------------------------------------------------------------
// PARKS. Fence profile = [sprayDeg, distanceFt] control points, linear interp.
// surfaceHeight() below is the authoritative "where does a ball come to rest"
// function. The stadium mesh MUST sit on/under it (stands, street, rooftops).
// ---------------------------------------------------------------------------
export const PARKS = {
  // v2 geometry — from scratch/research/parks.md (real-park research, Sep 2026).
  // Everything here is in feet. Presentation-only fields (wells, videoBoards,
  // fanDeck, booth) must be honoured by the park builders; the sim uses
  // fence/stands/street/rooftops/scoreboard/videoBoards for ball collision.
  wrigley: {
    id: 'wrigley', name: 'WRIGLEY FIELD', side: 'NORTH SIDE',
    blurb: 'Ivy on brick. Rooftops across the street. Lake wind decides everything.',
    fence: [[-45, 355], [-40, 356], [-33, 360], [-24, 368], [-12, 385], [0, 400], [12, 385], [24, 368], [33, 360], [40, 355], [45, 353]],
    fenceH: 11.5,                 // brick + ivy (basket above it)
    wells: { spray: [[-45, -40], [40, 45]], h: 15 },    // corner "wells": wall rises to 15 ft (presentation)
    stands: { depth: 58, startH: 12, topH: 42 },        // outfield bleachers, well to well
    street: { width: 40, h: 0 },  // Waveland Ave (LF–CF) / Sheffield Ave (RF): curb to curb + sidewalks, ballhawks
    rooftops: { depth: 80, h: 44, spray: [[-45, -35], [-31, -6], [6, 15], [29, 45]] }, // 3-story six-flats with rooftop bleachers; gaps = Kenmore Ave (-33) and the demolished lots behind the RF board
    scoreboard: { spray: [-5, 5], h: 87, depth: 12 },   // hand-operated CF scoreboard (75 x 27 ft face, base ~60 ft) + clock crown & flag masthead above (presentation)
    videoBoards: [                                       // atop the back of the bleachers; balls that hit them bounce back (sim), "OFF THE VIDEO BOARD!"
      { id: 'lf', spray: [-30, -17], bottom: 45, top: 87 },   // 95 x 42 ft
      { id: 'rf', spray: [16, 27], bottom: 50, top: 81 },     // ~75 x 31 ft
    ],
    booth: { pos: [0, 50, 92], look: [0, 10, -60] },    // TV/radio booth windows at the front of the upper deck behind home (announcer cutaway)
    windScale: 1.0,               // lake wind
    palette: { primary: '#1f4fbf', secondary: '#c8372d', trim: '#2e6b34', ink: '#0b1630',
      ivy: '#3F6B2E', ivyLight: '#5E8C3A', ivyShadow: '#24401C', brick: '#8C3B2C', scoreboard: '#1F4A33', seats: '#1D4A33',
      steel: '#2E5A43', track: '#9A4636', dirt: '#A2643F', grass: '#3E7A33', pole: '#F2C200', basket: '#6E7670',
      roofBrick: '#7A3B2A', roofTan: '#B08D6A', greystone: '#B7B2A6', juniper: '#22362A' },
    bonus: {                      // (PLAY owns labels/points) out-of-the-park keys are listed in outOfPark below
      street_l:   { label: 'ON WAVELAND!', points: 1000 },
      street_r:   { label: 'ON SHEFFIELD!', points: 1000 },
      rooftop:    { label: 'ROOFTOP SHOT!', points: 1500 },
      videoboard: { label: 'OFF THE VIDEO BOARD!', points: 350 },
      board:      { label: 'OFF THE SCOREBOARD!', points: 750 },
      over_cf:    { label: 'OVER THE SCOREBOARD!', points: 2000 },
    },
    outOfPark: ['street_l', 'street_r', 'rooftop', 'over_cf'],   // bonus keys that mean the ball LEFT the ballpark
  },
  rate: {
    id: 'rate', name: 'RATE FIELD', side: 'SOUTH SIDE',
    blurb: 'Modern bowl, giant video board, pinwheels and fireworks on every homer.',
    fence: [[-45, 330], [-38, 338], [-30, 352], [-20, 375], [-10, 392], [0, 400], [10, 392], [20, 375], [30, 352], [38, 340], [45, 335]],
    fenceH: 8,                    // dark-green padded wall
    stands: { depth: 62, startH: 9, topH: 32 },   // LF/RF bench bleachers (CF: tiered ivy batter's eye + Fan Deck in the same band)
    street: { width: 48, h: 30 },  // open 100-level outfield concourse behind the bleachers (h = concourse deck height)
    rooftops: null,
    scoreboard: { spray: [-8, 8], h: 110, depth: 14 }, // CF video board 134 x 60 ft (bottom ~50, top ~110) with the PINWHEELS on top (presentation)
    videoBoards: [
      { id: 'lf', spray: [-41, -35], bottom: 40, top: 76 },
      { id: 'rf', spray: [35, 41], bottom: 40, top: 76 },
    ],
    fanDeck: { spray: [-7, 7], d: [38, 62], h: 42 },   // two-level Fan Deck above the CF batter's eye, just in front of the big board (d = ft beyond the fence)
    booth: { pos: [0, 78, 118], look: [0, 10, -60] },  // 400-level press box behind home
    windScale: 0.6,
    palette: { primary: '#16181c', secondary: '#c9d1d9', trim: '#ffffff', ink: '#0a0b0d',
      wall: '#1E3F2E', seats: '#21492F', eyeIvy: '#2F5A2A', steel: '#151515', concourse: '#6E6E68', precast: '#D9D6CC',
      track: '#8C5A40', dirt: '#9E5E3B', grass: '#3F7B36', pole: '#F4C300', boardFrame: '#0D0D0D',
      pinwheels: ['#E53935', '#1E6FE0', '#F9C80E', '#2EB872', '#FFFFFF'] },
    bonus: {
      concourse:   { label: 'CONCOURSE SHOT!', points: 300 },
      fan_deck:    { label: 'ONTO THE FAN DECK!', points: 400 },
      videoboard:  { label: 'OFF THE CORNER BOARD!', points: 350 },
      board:       { label: 'OFF THE BIG BOARD!', points: 750 },
      over_cf:     { label: 'OVER THE BIG BOARD!', points: 2000 },
      out_of_park: { label: 'OUT OF THE PARK!', points: 1250 },
    },
    outOfPark: ['over_cf', 'out_of_park'],
  },
};
export const PARK_IDS = ['wrigley', 'rate'];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Fence distance (ft) at spray angle (deg). Outside ±45 returns the line value. */
export function fenceDistance(parkId, spray) {
  const f = PARKS[parkId].fence; const s = clamp(spray, f[0][0], f[f.length - 1][0]);
  for (let i = 0; i < f.length - 1; i++) {
    const [a0, d0] = f[i], [a1, d1] = f[i + 1];
    if (s >= a0 && s <= a1) return lerp(d0, d1, (s - a0) / (a1 - a0 || 1));
  }
  return f[f.length - 1][1];
}

/**
 * Height (ft) of the resting surface at spray angle s (deg) and horizontal
 * distance r (ft) from home plate. 0 on the field. Beyond the fence:
 *  bleachers/seats rise linearly startH → topH over stands.depth,
 *  then the street/concourse (street.h) for street.width,
 *  then (Wrigley only, inside rooftops.spray ranges) rooftop buildings rooftops.h,
 *  then ground (0) forever. The CF scoreboard is a WALL, not a surface — see
 *  scoreboardHit().
 */
export function surfaceHeight(parkId, s, r) {
  const P = PARKS[parkId]; const fr = fenceDistance(parkId, s);
  if (r < fr) return 0;
  const d = r - fr;
  if (d < P.stands.depth) return lerp(P.stands.startH, P.stands.topH, d / P.stands.depth);
  const d2 = d - P.stands.depth;
  if (d2 < P.street.width) return P.street.h;
  if (P.rooftops) {
    const inRange = P.rooftops.spray.some(([a, b]) => s >= a && s <= b);
    if (inRange && d2 - P.street.width < P.rooftops.depth) return P.rooftops.h;
  }
  return 0;
}

/** Distance (ft) from home to the FRONT face of the CF scoreboard at spray s, or null if s is outside it. */
export function scoreboardDistance(parkId, s) {
  const P = PARKS[parkId]; const sb = P.scoreboard;
  if (!sb || s < sb.spray[0] || s > sb.spray[1]) return null;
  return fenceDistance(parkId, s) + P.stands.depth;
}

/**
 * Classify where a homer ended up → bonus key (or null). (PLAY owns this.)
 * landing = { spray, r, y } of the final resting point plus the flight's obstacle flags:
 *   clearedBoard / hitBoard  — over / off the CF scoreboard (Wrigley) or big board (Rate)
 *   videoBoard               — id of the PARKS[p].videoBoards entry it bounced off (or null)
 *   fanDeck                  — (Rate) came down on / into the Fan Deck
 * Wrigley: anything that clears the back of the bleachers has LEFT THE PARK — onto Waveland
 * (spray < 0: LF–CF) or Sheffield (RF), or up on a rooftop across the street.
 * Rate: past the bleachers onto the open outfield concourse (in the park), beyond it = out of the park.
 */
export function classifyLanding(parkId, { spray, r, y = null, hitBoard, clearedBoard, videoBoard = null, fanDeck = false }) {
  const P = PARKS[parkId]; const fr = fenceDistance(parkId, spray);
  if (clearedBoard) return 'over_cf';
  if (hitBoard) return 'board';
  if (videoBoard) return 'videoboard';
  if (fanDeck && P.bonus.fan_deck) return 'fan_deck';
  const d = r - fr;
  if (d < P.stands.depth) return null;                 // in the seats — a normal homer
  const d2 = d - P.stands.depth;
  if (parkId === 'wrigley') {
    const onRoofBand = P.rooftops && d2 >= P.street.width && d2 - P.street.width < P.rooftops.depth
      && P.rooftops.spray.some(([a, b]) => spray >= a && spray <= b);
    if (onRoofBand && (y == null || y >= P.rooftops.h - 1)) return 'rooftop';
    return spray < 0 ? 'street_l' : 'street_r';
  }
  return d2 < P.street.width ? 'concourse' : 'out_of_park';
}

/** true if this bonus key means the ball LEFT the ballpark (PARKS[p].outOfPark). */
export function isOutOfPark(parkId, bonus) {
  const P = PARKS[parkId]; return !!(bonus && P && P.outOfPark && P.outOfPark.includes(bonus));
}

// ---------------------------------------------------------------------------
// PITCHES. mph ranges are displayed as-is; the on-screen flight time is scaled
// by TUNING.pitchTimeScale so a phone thumb can hit it.
//  move: [dx, dy] total late break in FEET at the plate (for a RHP; the sim
//        mirrors nothing — all pitchers are the same right-handed fox).
//        dx>0 = toward +X (first-base side). breakStart = fraction of flight
//        after which the break is applied (ease-in).
// ---------------------------------------------------------------------------
export const PITCHES = {
  meatball: { label: 'MEATBALL',  mph: [58, 66], move: [0, 0],        breakStart: 1,    color: '#ffffff' },
  fastball: { label: 'FASTBALL',  mph: [86, 97], move: [-0.25, 0.15], breakStart: 0.55, color: '#ff4b3a' },
  changeup: { label: 'CHANGEUP',  mph: [76, 84], move: [-0.55, -0.55], breakStart: 0.55, color: '#ffc83a' },
  curveball:{ label: 'CURVEBALL', mph: [72, 80], move: [0.55, -1.55], breakStart: 0.45, color: '#3aa8ff' },
  slider:   { label: 'SLIDER',    mph: [82, 88], move: [1.25, -0.45], breakStart: 0.55, color: '#b46bff' },
};
export const BREAKING = new Set(['changeup', 'curveball', 'slider']);

/**
 * Pitch mix by pitch number n (1-based) in a round. Returns weights.
 * Ramp: meatballs → fastballs → changeups → breaking balls.
 */
export function pitchMix(n) {
  if (n <= 3) return { meatball: 1 };
  if (n <= 7) return { meatball: 0.35, fastball: 0.65 };
  if (n <= 12) return { fastball: 0.6, changeup: 0.3, meatball: 0.1 };
  if (n <= 18) return { fastball: 0.45, changeup: 0.2, curveball: 0.2, slider: 0.15 };
  return { fastball: 0.4, changeup: 0.2, curveball: 0.2, slider: 0.2 };
}
/** 0..1 difficulty ramp used for velocity-within-range and location spread. */
export const rampAt = n => clamp((n - 3) / 18, 0, 1);

// Strike zone at the front of the plate (z = 0), in feet. Ball radius included.
export const ZONE = { x: [-0.83, 0.83], y: [1.6, 3.5] };
export const RELEASE = [-1.8, 5.9, -54.0];       // right-handed fox pitcher, 6.5 ft extension
export const RUBBER = [0, 0.83, -60.5];

// ---------------------------------------------------------------------------
// TUNING — sim + presentation constants shared across modules.
// ---------------------------------------------------------------------------
export const TUNING = {
  pitchTimeScale: 1.75,     // real flight time x this = game flight time
  windupTime: 1.05,         // s from pitcher start to release (actors match this)
  swingLead: 0.12,          // s from swing start to bat-on-ball at the REFERENCE bat speed (button / space / swing() with no args)
  // v2 swipe swing (PLAY): batSpeed ∈ [0,1] from the swipe; the lead (swing start → contact frame) shrinks with speed.
  // sim.swingLeadFor(b) is piecewise-linear through (0, swingLeadSlow) (batSpeedRef, swingLead) (1, swingLeadFast).
  batSpeedRef: 0.72,        // button mode / keyboard space / a "normal" swipe
  swingLeadSlow: 0.20,      // s at batSpeed 0 (lazy flick)
  swingLeadFast: 0.09,      // s at batSpeed 1 (MAX EFFORT)
  maxEffortAt: 0.92,        // batSpeed ≥ this → "MAX EFFORT" flash
  batMph: [48, 82],         // displayed bat speed (mph) at batSpeed 0 / 1 (linear)
  contactZ: -1.2,           // ft — contact plane just in front of the plate
  inputLatencyComp: 0.025,  // s credited back to every tap (touch pipeline latency)
  eyeSlowFrac: 0.4,         // last 40% of flight is slowed for readBonus hitters…
  eyeSlowAmount: 0.18,      // …by up to 18% (x readBonus)
  ringShowFrac: 0.42,       // read ring appears after this fraction of flight (normal)
  ringShowFracEye: 0.22,    // …for readBonus=1 (lerp by readBonus)
  takeGrace: 0.18,          // s after the ball crosses the plate before it counts as a take
  gravity: 32.174,          // ft/s^2
  // ball flight — sim agent calibrates these so 105 mph @ 28° ≈ 405 ft (no wind)
  dragK: 0.0017,            // quadratic drag coefficient (1/ft)
  liftK: 0.00032,           // backspin lift coefficient
  mph: 1.46667,             // mph → ft/s
  maxFlightTime: 9,
  // scoring
  streakMult: [1, 1, 1.5, 2, 2.5, 3],   // index = current streak length (capped at last)
  clutchMult: 1.5,                        // homer with outs === OUTS_PER_ROUND - 1
  moonshotFt: 450, moonshotPts: 100,
  wayOutFt: 500, wayOutPts: 250,
  recordPts: 250,                         // new personal longest at this park
  waveEvery: 3,                           // round.apply() emits 'wave' when the homer streak reaches 3, 6, 9, …
  maxHomerFt: 610,                        // hard cap on a reported homer distance (leaderboard Worker rejects longest > 620)
};

// ---------------------------------------------------------------------------
// CONDITIONS — time of day, weather, wind.
// wind.dir = spray angle the wind blows TOWARD (0 = straight out to CF,
// 180 = straight in from CF, -45/+45 = toward the LF/RF lines).
// ---------------------------------------------------------------------------
export const TIMES = ['day', 'dusk', 'night'];
export const WEATHER = {
  clear:    { label: 'CLEAR',    carry: 1.00, fog: 0.0 },
  overcast: { label: 'OVERCAST', carry: 0.99, fog: 0.25 },
  heat:     { label: 'SUMMER HEAT', carry: 1.03, fog: 0.08 },
  drizzle:  { label: 'DRIZZLE',  carry: 0.97, fog: 0.35 },
};
export function windLabel({ mph, dir }) {
  if (mph < 2) return 'CALM';
  const a = ((dir + 540) % 360) - 180; // -180..180
  const m = Math.round(mph);
  if (Math.abs(a) <= 22) return `OUT TO CF ${m} MPH`;
  if (Math.abs(a) >= 158) return `IN FROM CF ${m} MPH`;
  if (a < 0 && a > -68) return `OUT TO LF ${m} MPH`;
  if (a > 0 && a < 68) return `OUT TO RF ${m} MPH`;
  if (a <= -112) return `IN FROM RF ${m} MPH`;
  if (a >= 112) return `IN FROM LF ${m} MPH`;
  return a < 0 ? `R TO L ${m} MPH` : `L TO R ${m} MPH`;
}

// ---------------------------------------------------------------------------
// RNG + dates
// ---------------------------------------------------------------------------
export function hashString(str) { // cyrb53 → 32-bit
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
}
/** mulberry32 — returns () => [0,1) */
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 'YYYY-MM-DD' in America/Chicago. */
export function chicagoDate(d = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

/** Random free-play conditions for a park. rng = makeRng(...) */
export function randomConditions(parkId, rng) {
  const P = PARKS[parkId];
  const tod = TIMES[Math.floor(rng() * 3)];
  const wr = rng(); const weather = wr < 0.55 ? 'clear' : wr < 0.75 ? 'overcast' : wr < 0.9 ? 'heat' : 'drizzle';
  const mph = Math.round((2 + rng() * 18) * P.windScale);
  const dirs = [0, 180, -30, 30, 150, -150, 90, -90];
  const dir = dirs[Math.floor(rng() * dirs.length)] + Math.round((rng() - 0.5) * 20);
  return { timeOfDay: tod, weather, wind: { mph, dir } };
}

/**
 * The DAILY CHALLENGE for a Chicago date. Everyone gets the same park,
 * conditions and — via pitchSeed — the exact same pitch sequence.
 */
export function dailyConfig(dateStr = chicagoDate()) {
  const rng = makeRng('windy-city-derby:' + dateStr);
  const parkId = PARK_IDS[Math.floor(rng() * PARK_IDS.length)];
  const cond = randomConditions(parkId, rng);
  return { date: dateStr, parkId, ...cond, pitchSeed: hashString('pitches:' + dateStr) };
}

export const DISTRICTS = ['North Side', 'South Side', 'East Side', 'West Side', 'Big South'];

// Leaderboard endpoint (Cloudflare Worker). Game must work offline if it's down.
export const BOARD_ENDPOINT = 'https://windy-city-derby.jeff-bilbrey-jb.workers.dev';

// Asset keys the art pipeline produces (assets/manifest.json). Any may be missing.
export const ASSET_KEYS = {
  title: ['title_portrait', 'title_landscape'],
  portraits: CHARACTERS.map(c => 'portrait_' + c.id),
  swings: CHARACTERS.map(c => 'swing_' + c.id),
  pitcher: 'pitcher',
  skies: PARK_IDS.flatMap(p => TIMES.map(t => `sky_${p}_${t}`)),
  textures: ['tex_ivy', 'tex_brick', 'tex_crowd_north', 'tex_crowd_south'],
};
