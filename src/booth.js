// ============================================================================
// WINDY CITY DERBY — BOOTH CAM. Picture-in-picture broadcast cutaway for
// out-of-the-park home runs. Owner: CINEMA.
//
//   const booth = createBooth(root /* UI root element */, { assets, audio, base = 'assets/' })
//   booth.show({ parkId, bonus, distance, name, streak, timeOfDay, line }) → Promise<void>
//   booth.hide()        // skip now (resolves the pending show)
//   booth.preload(parkId?)  booth.dispose()   booth.showing
//
// WRIGLEY FIELD — "RUSTY BRUSHWOOD", the Blufox Booth's original silver-muzzled
// veteran red fox (loud plaid sport coat, headset boom mic, pencil behind the ear,
// BLUFOX press credential) leaning out of the press-level booth window over the
// crowd: 5 painted frames cut together like a live camera op, parallax layers,
// handheld drift + shake, foreground crowd bokeh, live CC captions, voiced call.
// RATE FIELD — no booth fox: a big-board takeover graphic (pinwheels, LED text)
// with the ballpark PA announcer's line.
//
// Never blocks input (only the PiP itself is tappable — tap / Esc = skip), sits in
// the bottom corner away from the pitch path and the result banner, and resolves
// even if every asset is missing. Voice plays through audio.playClip(key) when the
// AUDIO module + assets.buffer(key) can serve it, else through its own WebAudio.
// ============================================================================

const LINES = {
  waveland:   { vo: 'vo_rusty_waveland',   text: 'Get the gloves out on Waveland! That ball just left the neighborhood! Tail up, Chicago!', dur: 5.9, seq: [0, 2, 1, 3] },
  sheffield:  { vo: 'vo_rusty_sheffield',  text: 'Way up… and onto Sheffield Avenue! Somebody check the windshields!', dur: 5.8, seq: [0, 2, 1, 4] },
  rooftop:    { vo: 'vo_rusty_rooftop',    text: "Up on the rooftop! Pass that one around the party, folks, it's a keeper!", dur: 4.9, seq: [0, 1, 3, 4] },
  scoreboard: { vo: 'vo_rusty_scoreboard', text: 'Over the scoreboard! Nobody does that! That ball needs a bus ticket home!', dur: 5.6, seq: [0, 2, 3, 1] },
  monster:    { vo: 'vo_rusty_monster',    text: 'Oh, that is a Blufox BLAST! Tail up, Chicago!', dur: 4.3, seq: [0, 1, 3, 4] },
  b2b:        { vo: 'vo_rusty_b2b',        text: "Back-to-back! Somebody water the ivy, it's on fire!", dur: 4.2, seq: [0, 3, 1, 4] },
  generic:    { vo: 'vo_rusty_generic',    text: "That one's got a passport! Clean out of the ballpark!", dur: 3.9, seq: [0, 2, 1, 3] },
  pa_out:     { vo: 'vo_pa_out',           text: 'Ladies and gentlemen… that ball has LEFT the ballpark!', dur: 6.0, pa: true },
  pa_board:   { vo: 'vo_pa_board',         text: 'Over the big board! Light up those pinwheels!', dur: 4.9, pa: true },
};
/** asset keys → files (relative to `base`) — mirrored in scratch/cinema/manifest-add.json */
export const BOOTH_FILES = {
  booth_rusty: 'booth/booth_rusty.webp', booth_bg_day: 'booth/booth_bg_day.webp', booth_bg_night: 'booth/booth_bg_night.webp',
  vo_rusty_waveland: 'vo/rusty_waveland.mp3', vo_rusty_sheffield: 'vo/rusty_sheffield.mp3', vo_rusty_rooftop: 'vo/rusty_rooftop.mp3',
  vo_rusty_scoreboard: 'vo/rusty_scoreboard.mp3', vo_rusty_monster: 'vo/rusty_monster.mp3', vo_rusty_b2b: 'vo/rusty_b2b.mp3',
  vo_rusty_generic: 'vo/rusty_generic.mp3', vo_pa_out: 'vo/pa_out.mp3', vo_pa_board: 'vo/pa_board.mp3',
};
export const ANNOUNCER = { name: 'RUSTY BRUSHWOOD', title: 'THE BLUFOX BOOTH' };

// frame strip order: 0 lean-in (anticipation) · 1 calling it · 2 pointing · 3 arms up · 4 thumbs-up wink
// fox box in % of the cam: x centre, bottom, height (the ledge hides everything below 67.8 %)
const FRAMES = [
  { x: 50, bottom: 79, h: 76 },
  { x: 51, bottom: 88, h: 82 },
  { x: 54, bottom: 88, h: 82 },
  { x: 50, bottom: 90, h: 84 },
  { x: 50, bottom: 88, h: 82 },
];
const LEDGE = 67.8;   // % of cam height where the booth ledge top sits (from the painted plate)

/** Which call Rusty makes for a given landing. */
export function pickLine({ parkId = 'wrigley', bonus = null, distance = 0, streak = 0, line = null } = {}) {
  if (line && LINES[line]) return line;
  if (parkId === 'rate') return bonus === 'over_cf' ? 'pa_board' : 'pa_out';
  if (bonus === 'street_l') return 'waveland';
  if (bonus === 'street_r') return 'sheffield';
  if (bonus === 'rooftop') return 'rooftop';
  if (bonus === 'over_cf' || bonus === 'board') return 'scoreboard';
  if (streak >= 2) return 'b2b';
  return distance >= 470 ? 'monster' : 'generic';
}

const CSS = `
@font-face { font-family: 'WCDB Cond'; font-style: normal; font-weight: 800; font-display: swap; src: url('__BASE__fonts/barlow-condensed-800.woff2') format('woff2'); }
@font-face { font-family: 'WCDB Cond'; font-style: italic; font-weight: 800; font-display: swap; src: url('__BASE__fonts/barlow-condensed-800-italic.woff2') format('woff2'); }
@font-face { font-family: 'WCDB Cond'; font-style: normal; font-weight: 700; font-display: swap; src: url('__BASE__fonts/barlow-condensed-700.woff2') format('woff2'); }
.wcdb { position: absolute; inset: 0; pointer-events: none; z-index: 6; font-family: 'WCDB Cond', 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.wcdb * { box-sizing: border-box; }
.wcdb-pip { position: absolute; left: calc(env(safe-area-inset-left, 0px) + 10px); bottom: calc(env(safe-area-inset-bottom, 0px) + 78px);
  width: min(70vw, 340px); pointer-events: auto; cursor: pointer; transform-origin: 0% 100%; opacity: 0; visibility: hidden;
  filter: drop-shadow(0 10px 24px rgba(0,0,0,.55)); -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
@media (orientation: landscape) { .wcdb-pip { left: auto; right: calc(env(safe-area-inset-right, 0px) + 12px); bottom: calc(env(safe-area-inset-bottom, 0px) + 12px); width: min(31vw, 320px); transform-origin: 100% 100%; } }
@media (min-width: 900px) and (min-height: 600px) { .wcdb-pip { width: 340px; } }
.wcdb-pip.on { visibility: visible; animation: wcdbIn .5s cubic-bezier(.2,1.25,.3,1) both; }
.wcdb-pip.off { visibility: visible; animation: wcdbOut .32s cubic-bezier(.6,0,.8,.3) both; }
@keyframes wcdbIn { 0% { opacity: 0; transform: translateY(18px) scale(.72) rotate(-2deg); } 60% { opacity: 1; } 100% { opacity: 1; transform: none; } }
@keyframes wcdbOut { 0% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(14px) scale(.8); } }
.wcdb-frame { position: relative; border-radius: 9px; padding: 3px; background: linear-gradient(135deg, #3a8bff, #1f4fbf 40%, #0b1630 70%, #3a8bff); }
.wcdb-cam { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #0b1410; isolation: isolate; }
.wcdb-rig { position: absolute; inset: 0; will-change: transform; transform-origin: 50% 42%; }
.wcdb-bg, .wcdb-ledge { position: absolute; left: -53.2%; top: -58.3%; width: 200%; height: 200.9%; background-size: 100% 100%; will-change: transform; }
.wcdb-ledge { clip-path: inset(62.76% 0 0 0); -webkit-clip-path: inset(62.76% 0 0 0); z-index: 3; }
.wcdb-bg { background-color: #173a28; }
.wcdb-fox { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 2; will-change: transform; }
.wcdb-fx { position: absolute; aspect-ratio: 4 / 5; background-repeat: no-repeat; background-size: 500% 100%; opacity: 0; transform-origin: 50% 90%; }
.wcdb-fx.cur { opacity: 1; }
.wcdb-night .wcdb-fx { filter: brightness(.8) sepia(.14) saturate(1.08) contrast(1.06); }
.wcdb-crowd { position: absolute; left: -6%; bottom: -6%; width: 112%; height: 46%; z-index: 4; filter: blur(2.4px); will-change: transform; }
.wcdb-sheen { position: absolute; inset: 0; z-index: 5; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,.42) 100%), linear-gradient(180deg, rgba(255,255,255,.05), transparent 30%); }
.wcdb-flash { position: absolute; inset: 0; z-index: 6; background: #fff; opacity: 0; pointer-events: none; }
.wcdb-bug { position: absolute; top: 9px; left: 10px; z-index: 7; display: flex; gap: 5px; align-items: center; }
.wcdb-bug b { display: inline-flex; align-items: center; gap: 4px; font: 800 10.5px/1 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .14em; padding: 4px 6px 3px; border-radius: 3px; color: #fff; }
.wcdb-bug .live { background: #d9261c; box-shadow: 0 0 10px rgba(217,38,28,.6); }
.wcdb-bug .live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: wcdbBlink 1s steps(1) infinite; }
.wcdb-bug .cam { background: rgba(4,8,20,.72); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
@keyframes wcdbBlink { 50% { opacity: .2; } }
.wcdb-l3 { position: absolute; left: -3px; right: 18%; bottom: -14px; z-index: 8; display: flex; flex-direction: column; align-items: flex-start; transform: translateX(-8px); opacity: 0; transition: transform .45s cubic-bezier(.2,1.2,.3,1), opacity .3s; }
.wcdb-pip.l3on .wcdb-l3 { transform: none; opacity: 1; }
.wcdb-l3 .nm { position: relative; font: italic 800 17px/1 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .05em; color: #0b1630; padding: 5px 12px 3px 10px;
  background: linear-gradient(90deg, #ffd66b, #ffb000); clip-path: polygon(0 0, 100% 0, calc(100% - 9px) 100%, 0 100%); white-space: nowrap; }
.wcdb-l3 .sub { font: 800 9.5px/1 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .2em; color: #fff; padding: 4px 12px 4px 10px; background: rgba(8,20,52,.94);
  clip-path: polygon(0 0, 100% 0, calc(100% - 7px) 100%, 0 100%); white-space: nowrap; box-shadow: inset 3px 0 0 #3a8bff; }
.wcdb-cc { position: absolute; left: 2px; right: -30%; bottom: calc(100% + 7px); z-index: 8; font: 700 12.5px/1.25 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .04em; text-transform: uppercase;
  color: #fff; text-shadow: 0 1px 2px #000; min-height: 1em; }
.wcdb-cc span { background: rgba(0,0,0,.78); padding: 2px 5px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
@media (orientation: landscape) { .wcdb-cc { left: -30%; right: 2px; text-align: right; } .wcdb-l3 { bottom: -12px; } }
.wcdb-skip { position: absolute; right: 7px; top: 8px; z-index: 7; font: 800 9.5px/1 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .18em; color: rgba(255,255,255,.85); background: rgba(4,8,20,.55); padding: 4px 6px 3px; border-radius: 3px; }
/* ---- Rate Field big board takeover ---- */
.wcdb-board { position: absolute; inset: 0; background: #050607; overflow: hidden; }
.wcdb-pins { position: absolute; left: 36%; right: 17%; top: 4%; height: 25%; display: flex; justify-content: space-between; align-items: center; z-index: 2; }
.wcdb-pins i { display: block; height: 88%; aspect-ratio: 1; border-radius: 50%; animation: wcdbSpin .7s linear infinite; box-shadow: 0 0 12px rgba(255,255,255,.35);
  background: radial-gradient(circle, #fff 0 9%, transparent 10%), conic-gradient(var(--a) 0 25%, var(--b) 0 50%, var(--a) 0 75%, var(--b) 0); }
.wcdb-pins i:nth-child(even) { animation-direction: reverse; animation-duration: .55s; }
@keyframes wcdbSpin { to { transform: rotate(360deg); } }
.wcdb-led { position: absolute; left: 4%; right: 4%; top: 33%; bottom: 7%; border-radius: 3px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2%;
  background: radial-gradient(ellipse at 50% 40%, #13213f, #04070e 75%); box-shadow: inset 0 0 0 2px #1d1f22, 0 0 0 3px #0d0d0d; overflow: hidden; }
.wcdb-led::after { content: ''; position: absolute; inset: 0; background: radial-gradient(circle, transparent 55%, rgba(0,0,0,.32) 62%) 0 0 / 3px 3px; pointer-events: none; }
.wcdb-led .l1 { font: italic 800 clamp(18px, 8.4cqw, 34px)/.95 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .03em; color: #fff3a8; text-shadow: 0 0 2px #fff, 0 0 9px rgba(255,210,70,.95), 0 0 24px rgba(255,120,20,.7); white-space: nowrap; animation: wcdbPulse .45s ease-in-out infinite alternate; }
.wcdb-led .l2 { font: italic 800 clamp(22px, 11cqw, 44px)/.9 'WCDB Cond', 'Barlow Condensed', sans-serif; color: #fff; text-shadow: 0 0 2px #fff, 0 0 12px rgba(120,190,255,.95); font-variant-numeric: tabular-nums; }
.wcdb-led .l3 { font: 800 clamp(8px, 3.3cqw, 13px)/1 'WCDB Cond', 'Barlow Condensed', sans-serif; letter-spacing: .3em; color: #9fd0ff; }
.wcdb-cam.board { container-type: inline-size; }
@keyframes wcdbPulse { to { filter: brightness(1.35); } }
.wcdb-chase { position: absolute; inset: 0; z-index: 3; pointer-events: none; border-radius: 6px;
  background: repeating-linear-gradient(90deg, #ffd23a 0 6px, transparent 6px 12px) top / 200% 3px no-repeat, repeating-linear-gradient(90deg, #ffd23a 0 6px, transparent 6px 12px) bottom / 200% 3px no-repeat;
  animation: wcdbChase .5s linear infinite; opacity: .9; }
@keyframes wcdbChase { to { background-position: 12px 0, -12px 100%; } }
.wcdb-spark { position: absolute; width: 5px; height: 5px; border-radius: 50%; z-index: 1; background: #fff; box-shadow: 0 0 8px 3px var(--c); animation: wcdbSpark 1.2s ease-out infinite; opacity: 0; }
@keyframes wcdbSpark { 0% { opacity: 1; transform: translate(0,0) scale(1.4); } 100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(.2); } }
@media (prefers-reduced-motion: reduce) { .wcdb-pins i, .wcdb-chase, .wcdb-spark, .wcdb-led .l1 { animation: none; } }
`;

export function createBooth(root, { assets = null, audio = null, base = 'assets/', autoPreload = true } = {}) {
  const hasDOM = typeof document !== 'undefined' && root && root.appendChild;
  const NOOP = { show: () => Promise.resolve(), hide() {}, dispose() {}, preload() { return Promise.resolve(); }, get showing() { return false; } };
  if (!hasDOM) return NOOP;
  if (base && !base.endsWith('/')) base += '/';

  // ---------------------------------------------------------------- CSS + DOM
  if (!document.getElementById('wcdb-css')) {
    const st = document.createElement('style'); st.id = 'wcdb-css'; st.textContent = CSS.replace(/__BASE__/g, base);
    document.head.appendChild(st);
  }
  const el = document.createElement('div'); el.className = 'wcdb';
  el.innerHTML = `<div class="wcdb-pip" role="status" aria-live="polite"><div class="wcdb-frame"><div class="wcdb-cam"></div></div>
    <div class="wcdb-bug"><b class="live">LIVE</b><b class="cam">BOOTH CAM</b></div><span class="wcdb-skip">SKIP ›</span>
    <div class="wcdb-l3"><div class="nm"></div><div class="sub"></div></div><div class="wcdb-cc"><span></span></div></div>`;
  root.appendChild(el);
  const pip = el.querySelector('.wcdb-pip'), cam = el.querySelector('.wcdb-cam'), cc = el.querySelector('.wcdb-cc span');
  const bugCam = el.querySelector('.wcdb-bug .cam'), l3n = el.querySelector('.wcdb-l3 .nm'), l3s = el.querySelector('.wcdb-l3 .sub');

  // ---------------------------------------------------------------- loading
  const urlFor = key => { try { const u = assets && assets.url && assets.url(key); if (u) return u; } catch (e) { /* */ } return base + BOOTH_FILES[key]; };
  const imgs = {}, bufs = {}, durs = {};
  const loading = {};
  function loadImg(key) {
    if (loading[key]) return loading[key];
    return (loading[key] = new Promise(res => {
      try {
        const im = new Image(); im.decoding = 'async';
        im.onload = () => { imgs[key] = im.src; res(true); };
        im.onerror = () => res(false);
        im.src = urlFor(key);
      } catch (e) { res(false); }
    }));
  }
  function decodeDur(buf) {
    try {
      const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      if (!OAC) return Promise.resolve(null);
      const oc = new OAC(1, 2, 44100);
      return new Promise(r => { const p = oc.decodeAudioData(buf.slice(0), b => r(b), () => r(null)); if (p && p.catch) p.catch(() => r(null)); });
    } catch (e) { return Promise.resolve(null); }
  }
  function loadBuf(key) {
    if (loading[key]) return loading[key];
    return (loading[key] = (async () => {
      let ab = null;
      try { ab = assets && assets.buffer ? assets.buffer(key) : null; } catch (e) { ab = null; }
      if (!ab && assets && assets.load) { try { await assets.load(key); ab = assets.buffer ? assets.buffer(key) : null; } catch (e) { ab = null; } }
      if (!ab && typeof fetch === 'function') {
        try { const r = await fetch(base + BOOTH_FILES[key]); if (r.ok) ab = await r.arrayBuffer(); } catch (e) { ab = null; }
      }
      if (!ab) return false;
      bufs[key] = ab;
      const d = await decodeDur(ab); if (d) { durs[key] = d.duration; bufs[key + ':decoded'] = d; }
      return true;
    })());
  }
  function preload(parkId) {
    const keys = parkId === 'rate' ? ['vo_pa_out', 'vo_pa_board'] : parkId === 'wrigley'
      ? ['booth_rusty', 'booth_bg_day', 'booth_bg_night', ...Object.values(LINES).filter(l => !l.pa).map(l => l.vo)]
      : Object.keys(BOOTH_FILES);
    return Promise.all(keys.map(k => (k.startsWith('vo_') ? loadBuf(k) : loadImg(k)))).then(() => true);
  }
  let preT = 0;
  if (autoPreload) preT = setTimeout(() => { preload(); }, 6000);

  // ---------------------------------------------------------------- own audio fallback
  let actx = null, voiceSrc = null, voiceGain = null;
  const unlock = () => {
    try {
      if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); }
      if (actx.state !== 'running') { const p = actx.resume(); if (p && p.catch) p.catch(() => {}); }
      const b = actx.createBuffer(1, 1, actx.sampleRate), s = actx.createBufferSource(); s.buffer = b; s.connect(actx.destination); s.start(0);
    } catch (e) { /* */ }
  };
  const unlockOnce = () => { unlock(); if (actx && actx.state === 'running') { removeEventListener('pointerdown', unlockOnce, true); removeEventListener('keydown', unlockOnce, true); } };
  addEventListener('pointerdown', unlockOnce, true); addEventListener('keydown', unlockOnce, true);

  let clipHandle = null, voiceToken = 0;
  async function playVoice(key, pa) {
    const muted = !!(audio && (audio.muted === true || (typeof audio.muted === 'function' && audio.muted())));
    if (muted) return false;
    const tok = ++voiceToken;
    // 1) the AUDIO module: ducks crowd + music and adds the booth room / keeps the PA dry (echo is baked in)
    try {
      if (audio && typeof audio.playClip === 'function') {
        const h = await audio.playClip(key, { gain: 1, duck: 0.9, fx: pa ? 'dry' : 'booth', assets });
        if (h) { if (tok !== voiceToken || !S) { try { h.stop && h.stop(0.05); } catch (e) { /* */ } return false; } clipHandle = h; return true; }
      }
    } catch (e) { /* fall through */ }
    if (tok !== voiceToken || !S) return false;
    // 2) own WebAudio (no AUDIO module, clip not in the manifest, …)
    try {
      if (!bufs[key]) await loadBuf(key);
      if (!bufs[key] || tok !== voiceToken || !S) return false;
      unlock(); if (!actx) return false;
      let buf = bufs[key + ':ctx'];
      if (!buf) { buf = await new Promise(r => { const p = actx.decodeAudioData(bufs[key].slice(0), b => r(b), () => r(null)); if (p && p.catch) p.catch(() => r(null)); }); bufs[key + ':ctx'] = buf; }
      if (!buf || tok !== voiceToken || !S) return false;
      stopVoice();
      voiceGain = actx.createGain(); voiceGain.gain.value = 1; voiceGain.connect(actx.destination);
      voiceSrc = actx.createBufferSource(); voiceSrc.buffer = buf; voiceSrc.connect(voiceGain); voiceSrc.start();
      return true;
    } catch (e) { return false; }
  }
  function stopVoice() {
    try { if (voiceSrc) { const t = actx.currentTime; voiceGain.gain.setTargetAtTime(0, t, 0.05); voiceSrc.stop(t + 0.25); } } catch (e) { /* */ }
    voiceSrc = null;
    try { if (clipHandle && typeof clipHandle.stop === 'function') clipHandle.stop(0.12); } catch (e) { /* */ }
    clipHandle = null;
  }

  // ---------------------------------------------------------------- scene builders
  let layers = null;
  function crowdCanvas(night) {
    const c = document.createElement('canvas'); c.className = 'wcdb-crowd'; c.width = 360; c.height = 130;
    const g = c.getContext('2d'); if (!g) return c;
    // bokeh lights behind the heads (night: warm/cool stadium lights; day: sun glints)
    for (let i = 0; i < (night ? 26 : 12); i++) {
      const x = Math.random() * 360, y = 10 + Math.random() * 70, r = 5 + Math.random() * 12;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const col = night ? (Math.random() < 0.6 ? '255,214,150' : '160,200,255') : '255,244,220';
      gr.addColorStop(0, `rgba(${col},${night ? 0.5 : 0.28})`); gr.addColorStop(0.7, `rgba(${col},${night ? 0.22 : 0.1})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    // out-of-focus fans: heads, shoulders, raised arms and a few caps
    const tones = night ? ['#07090c', '#0b0e12', '#10141a', '#151a20'] : ['#1a1512', '#2a211b', '#3a2c22', '#1c2430', '#402f25'];
    for (let i = 0; i < 16; i++) {
      const x = (i / 15) * 380 - 10 + (Math.random() - 0.5) * 18, y = 92 + Math.random() * 26, s = 22 + Math.random() * 16;
      g.fillStyle = tones[(Math.random() * tones.length) | 0];
      if (Math.random() < 0.45) { g.save(); g.translate(x + s * 0.4, y - s * 0.6); g.rotate((Math.random() - 0.5) * 0.7); g.fillRect(-4, -s * 1.3, 8, s * 1.4); g.beginPath(); g.arc(0, -s * 1.35, 6, 0, 7); g.fill(); g.restore(); }
      g.beginPath(); g.ellipse(x, y + s * 0.95, s * 1.15, s * 0.8, 0, 0, 7); g.fill();
      g.beginPath(); g.ellipse(x, y, s * 0.5, s * 0.58, 0, 0, 7); g.fill();
      if (Math.random() < 0.3) { g.fillStyle = Math.random() < 0.5 ? '#1f4fbf' : '#c8372d'; g.globalAlpha = night ? 0.45 : 0.8; g.beginPath(); g.ellipse(x, y - s * 0.3, s * 0.52, s * 0.28, 0, Math.PI, 0); g.fill(); g.globalAlpha = 1; }
    }
    const fade = g.createLinearGradient(0, 0, 0, 130); fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = fade; g.fillRect(0, 0, 360, 130);
    return c;
  }
  function buildWrigley(night) {
    cam.className = 'wcdb-cam' + (night ? ' wcdb-night' : '');
    cam.innerHTML = '';
    const rig = document.createElement('div'); rig.className = 'wcdb-rig';
    const bgKey = night ? 'booth_bg_night' : 'booth_bg_day';
    const bg = document.createElement('div'); bg.className = 'wcdb-bg';
    const bgUrl = imgs[bgKey] || imgs.booth_bg_day || imgs.booth_bg_night;
    if (bgUrl) bg.style.backgroundImage = `url("${bgUrl}")`;
    else bg.style.background = 'linear-gradient(180deg,#0f2a1d 0 30%,#3a2a18 30% 62%,#1D4A33 62%)';
    const ledge = bg.cloneNode(); ledge.className = 'wcdb-ledge';
    if (!bgUrl) { ledge.style.background = 'linear-gradient(180deg,#24593e,#163827)'; }
    const fox = document.createElement('div'); fox.className = 'wcdb-fox';
    const fa = document.createElement('div'), fb = document.createElement('div'); fa.className = fb.className = 'wcdb-fx';
    if (imgs.booth_rusty) fa.style.backgroundImage = fb.style.backgroundImage = `url("${imgs.booth_rusty}")`;
    fox.append(fa, fb);
    const crowd = crowdCanvas(night);
    const sheen = document.createElement('div'); sheen.className = 'wcdb-sheen';
    const flash = document.createElement('div'); flash.className = 'wcdb-flash';
    rig.append(bg, fox, ledge, crowd);
    cam.append(rig, sheen, flash);
    layers = { rig, bg, ledge, fox, fa, fb, crowd, flash, cur: -1, ab: 0, hasFox: !!imgs.booth_rusty };
    bugCam.textContent = 'BOOTH CAM';
  }
  function buildRate({ distance, name, bonus }) {
    cam.className = 'wcdb-cam board'; cam.innerHTML = '';
    const pal = ['#E53935', '#1E6FE0', '#F9C80E', '#2EB872', '#FFFFFF', '#E53935', '#1E6FE0'];
    const pins = pal.map((a, i) => `<i style="--a:${a};--b:${pal[(i + 2) % pal.length]}"></i>`).join('');
    const sparks = Array.from({ length: 12 }, (_, i) => {
      const x = 10 + Math.random() * 80, y = 20 + Math.random() * 50, a = Math.random() * 6.28, d = 30 + Math.random() * 40;
      return `<span class="wcdb-spark" style="left:${x}%;top:${y}%;--c:${pal[i % 5]};--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;animation-delay:${(Math.random() * 1.2).toFixed(2)}s"></span>`;
    }).join('');
    const head = bonus === 'over_cf' ? 'OVER THE BIG BOARD!' : 'OUT OF THE PARK!';
    cam.innerHTML = `<div class="wcdb-board">${sparks}<div class="wcdb-pins">${pins}</div><div class="wcdb-led"><div class="l1">${head}</div><div class="l2">${Math.round(distance || 0)} FT</div><div class="l3">${esc(String(name || 'BLUFOX').toUpperCase())}</div></div></div><div class="wcdb-chase"></div><div class="wcdb-flash"></div>`;
    layers = { rig: null, flash: cam.querySelector('.wcdb-flash'), board: cam.querySelector('.wcdb-board') };
    bugCam.textContent = 'BIG BOARD';
  }
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function setFrame(i, cut) {
    const L = layers; if (!L || !L.fa || L.cur === i) return;
    const F = FRAMES[i] || FRAMES[1];
    const next = L.ab ? L.fa : L.fb, prev = L.ab ? L.fb : L.fa; L.ab ^= 1;
    next.style.backgroundPosition = `${i * 25}% 0`;
    const hPct = F.h, top = F.bottom - F.h;
    // width in % of cam width: h% of H × 0.8 aspect × (9/16)
    const wPct = hPct * 0.8 * 9 / 16;
    next.style.height = hPct + '%'; next.style.width = wPct + '%'; next.style.top = top + '%'; next.style.left = (F.x - wPct / 2) + '%';
    next.style.transition = cut ? 'none' : 'opacity .09s linear';
    prev.style.transition = cut ? 'none' : 'opacity .12s linear';
    next.classList.add('cur'); prev.classList.remove('cur');
    L.cur = i; L.cutAt = now(); L.kick = cut ? 1 : 0.5;
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  // ---------------------------------------------------------------- timeline
  let S = null;   // active show state
  function tick() {
    if (!S) return;
    const t = now() - S.t0;
    const L = layers;
    if (L && L.rig) {
      // camera: breathing handheld drift + slow push, plus a snap on every cut
      const k = Math.max(0, 1 - (now() - (L.cutAt || 0)) * 3.5);
      const push = 1.16 + Math.min(t, S.dur) / S.dur * 0.07 + 0.05 * k * k * (L.kick || 0);
      const sh = S.shake * Math.exp(-(t - S.shakeAt) * 5) * (t > S.shakeAt ? 1 : 0);
      const hx = Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1) * 0.25 + (Math.random() - 0.5) * sh * 3;
      const hy = Math.sin(t * 1.7 + 0.5) * 0.45 + Math.sin(t * 3.7) * 0.2 + (Math.random() - 0.5) * sh * 3;
      const rot = Math.sin(t * 0.9) * 0.25 + (Math.random() - 0.5) * sh * 0.8;
      L.rig.style.transform = `translate(${hx.toFixed(2)}%, ${hy.toFixed(2)}%) scale(${push.toFixed(4)}) rotate(${rot.toFixed(3)}deg)`;
      // parallax: plate far, fox mid, crowd near (moves opposite and most)
      const px = Math.sin(t * 0.55) * 1.0, py = Math.sin(t * 0.8 + 0.3) * 0.4;
      L.bg.style.transform = L.ledge.style.transform = `translate(${(-px * 0.25).toFixed(2)}%, ${(-py * 0.2).toFixed(2)}%)`;
      const lean = Math.sin(t * 2.2) * 0.8 + (L.kick ? k * 1.5 : 0);
      L.fox.style.transform = `translate(${(px * 0.6).toFixed(2)}%, ${(py * 0.5 + Math.sin(t * 4.2) * 0.25).toFixed(2)}%) rotate(${(lean * 0.4).toFixed(2)}deg) scale(${(1 + 0.012 * Math.sin(t * 3.1)).toFixed(4)})`;
      L.crowd.style.transform = `translate(${(-px * 3).toFixed(2)}%, ${(Math.abs(Math.sin(t * 5.5)) * -5 * S.cheer).toFixed(2)}%)`;
      // frame sequence (cuts timed across the call)
      const seq = S.line.seq || [1];
      const vt = Math.max(0, t - S.voiceAt);
      let idx = 0;
      if (t < S.voiceAt + 0.05) idx = seq[0];
      else { const u = Math.min(0.999, vt / Math.max(0.5, S.dur - S.voiceAt)); idx = seq[Math.min(seq.length - 1, 1 + Math.floor(u * (seq.length - 1)))]; }
      if (idx !== L.cur) { setFrame(idx, true); if (idx === 3 || idx === 1) { S.shake = 1; S.shakeAt = t; } }
    }
    if (L && L.flash) L.flash.style.opacity = Math.max(0, 0.85 - t * 5).toFixed(3);
    // captions: word-by-word like live CC
    if (S.words) {
      const vt = t - S.voiceAt;
      const n = vt < 0 ? 0 : Math.min(S.words.length, Math.ceil((vt / Math.max(0.6, (S.dur - S.voiceAt) * 0.82)) * S.words.length));
      if (n !== S.shown) { S.shown = n; cc.textContent = S.words.slice(0, n).join(' '); cc.style.display = n ? '' : 'none'; }
    }
    if (t > 0.55 && !S.l3) { S.l3 = true; pip.classList.add('l3on'); }
    if (t >= S.dur) { finish(); return; }
    S.raf = requestAnimationFrame(tick);
  }
  function finish() {
    if (!S) return;
    const s = S; S = null;
    cancelAnimationFrame(s.raf); clearTimeout(s.voiceTimer); voiceToken++;
    stopVoice();
    pip.classList.remove('on', 'l3on'); pip.classList.add('off');
    clearTimeout(s.offT);
    s.offT = setTimeout(() => { pip.classList.remove('off'); if (!S) cam.innerHTML = ''; layers = null; }, 340);
    s.resolve();
  }

  async function show(o = {}) {
    if (S) finish();
    const parkId = o.parkId === 'rate' ? 'rate' : 'wrigley';
    const key = pickLine({ ...o, parkId });
    const line = LINES[key];
    const night = o.timeOfDay === 'night' || o.timeOfDay === 'dusk';
    // give late assets a moment, never long
    const need = parkId === 'wrigley' ? [loadImg('booth_rusty'), loadImg(night ? 'booth_bg_night' : 'booth_bg_day'), loadBuf(line.vo)] : [loadBuf(line.vo)];
    await Promise.race([Promise.all(need), new Promise(r => setTimeout(r, 350))]);
    if (parkId === 'wrigley') {
      buildWrigley(night);
      l3n.textContent = ANNOUNCER.name; l3s.textContent = `${ANNOUNCER.title} · WRIGLEY FIELD`;
    } else {
      buildRate({ distance: o.distance, name: o.name, bonus: o.bonus });
      l3n.textContent = 'RATE FIELD'; l3s.textContent = 'SOUTH SIDE · PUBLIC ADDRESS';
    }
    const vd = durs[line.vo] || line.dur;
    return new Promise(resolve => {
      S = { t0: now(), dur: 0.55 + vd + 0.55, voiceAt: 0.55, line, key, resolve, raf: 0, shake: 0, shakeAt: 0, cheer: 1, shown: -1, l3: false,
            words: line.text.toUpperCase().split(/\s+/) };
      cc.textContent = ''; cc.style.display = 'none';
      pip.classList.remove('off', 'l3on'); void pip.offsetWidth; pip.classList.add('on');
      if (layers && layers.fa) { if (layers.hasFox) setFrame(line.seq ? line.seq[0] : 1, true); else { layers.fa.style.display = layers.fb.style.display = 'none'; } }
      S.voiceTimer = setTimeout(() => { if (S && S.key === key) playVoice(line.vo, !!line.pa); }, 550);
      S.raf = requestAnimationFrame(tick);
    });
  }
  function hide() { if (S) { clearTimeout(S.voiceTimer); finish(); } }
  const onTap = e => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); hide(); };
  pip.addEventListener('pointerdown', onTap);
  const onKey = e => { if (S && (e.key === 'Escape' || e.key === 'Esc')) hide(); };
  addEventListener('keydown', onKey);

  return {
    show, hide, preload,
    get showing() { return !!S; },
    get line() { return S ? S.key : null; },
    lines: LINES,
    dispose() {
      hide(); clearTimeout(preT);
      pip.removeEventListener('pointerdown', onTap); removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', unlockOnce, true); removeEventListener('keydown', unlockOnce, true);
      el.remove();
      try { actx && actx.close && actx.close(); } catch (e) { /* */ }
    },
  };
}
