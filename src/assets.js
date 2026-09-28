// ============================================================================
// WINDY CITY DERBY — asset loader. Owner: ACTORS (v2; was NET).
//
//   loadAssets({ manifestUrl, onProgress, priority }) → Promise<Assets>
//   Assets: { get(key), meta(key), texture(THREE, key, opts), receipt, …extras }
//   v2 extras: buffer(key) → ArrayBuffer|null   (type:'audio' / 'binary' entries)
//              model(key)  → Promise<gltf|null>  (type:'model' GLB, meshopt OK; cached)
//              load(key)   → Promise<value|null> (starts a lazy key of any type)
//              entry(key)  → manifest entry (loaded or not), state(key)
//
// Manifest entry types (v2): images as before;
//   { "src": "models/nova.glb", "type": "model", "lazy": true }   — only fetched on model()/load()
//   { "src": "vo/booth_1.m4a", "type": "audio" [, "lazy": true] } — raw bytes → buffer(key)
// Lazy entries never count toward the boot progress bar / receipt.total.
//
// Design notes (the HARD LESSON from the last game):
//   * Every image has its OWN stall window (default 8 s) that is reset every
//     time bytes arrive. A slow-but-moving download never times out; only a
//     request that goes silent does. There is NO shared wall-clock deadline.
//   * 4 download lanes, priority keys first, 1 retry per image (404 = no retry).
//   * The promise never rejects. A missing/broken manifest → empty Assets.
//   * The returned promise also carries `.assets` — the live store — so the
//     game can start using images that already landed while the rest load.
//
// Orientation (important for WebGL): WebGL ignores texture.flipY for
// ImageBitmap sources. So GL-destined keys (sky_*, tex_*, swing_*, pitcher)
// are decoded with createImageBitmap(…, {imageOrientation:'flipY'}) and their
// textures get flipY=false — they render upright with standard UVs, no copy.
// DOM-destined keys (portrait_*, celebrate_*, title_*, park_*, anything else)
// are decoded as HTMLImageElement (blob: URL + img.decode()) so the UI can use
// them directly (<img>, .src, drawImage) and the browser may purge them.
// get(key) ALWAYS returns something drawable in natural (upright) orientation.
// ============================================================================

const GL_KEY = /^(sky_|tex_|swing_|pitcher)/;
const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif', gif: 'image/gif' };

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

class LoadError extends Error {
  constructor(code, { permanent = false, status = 0 } = {}) { super(code); this.code = code; this.permanent = permanent; this.status = status; }
}

function makeCanvas(w, h) {
  if (hasDOM) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  return null;
}
const isBitmap = x => typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap;
const dimsOf = x => ({ w: x.naturalWidth || x.videoWidth || x.width || 0, h: x.naturalHeight || x.videoHeight || x.height || 0 });

// ---------------------------------------------------------------------------
// createImageBitmap capability probe: exists AND honours imageOrientation:'flipY'
// (old Safari/Firefox silently ignore options → we fall back to <img>).
// ---------------------------------------------------------------------------
let probePromise = null;
function probeBitmapFlip() {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    if (typeof createImageBitmap !== 'function' || !hasDOM) return false;
    try {
      const c = makeCanvas(1, 2); const g = c.getContext('2d');
      g.fillStyle = '#ff0000'; g.fillRect(0, 0, 1, 1); g.fillStyle = '#0000ff'; g.fillRect(0, 1, 1, 1);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!blob) return false;
      const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
      const c2 = makeCanvas(1, 2); const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(bmp, 0, 0); const d = g2.getImageData(0, 0, 1, 1).data;
      if (bmp.close) bmp.close();
      return d[2] > 160 && d[0] < 96; // top pixel is now the blue one
    } catch { return false; }
  })();
  return probePromise;
}

// ---------------------------------------------------------------------------
// Byte transport with a per-request STALL window (reset on every chunk).
// ---------------------------------------------------------------------------
function fetchBytes(url, { stallMs, maxAttemptMs, onBytes, transport }) {
  const useXHR = transport === 'xhr' || (transport !== 'fetch' && (typeof fetch !== 'function' || typeof ReadableStream === 'undefined'));
  return useXHR && typeof XMLHttpRequest === 'function' ? xhrBytes(url, { stallMs, maxAttemptMs, onBytes }) : streamBytes(url, { stallMs, maxAttemptMs, onBytes });
}

async function streamBytes(url, { stallMs, maxAttemptMs, onBytes }) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let why = null, stallT = 0;
  // Every await is raced against `killP`, so a stall ends the attempt even where abort() is a no-op.
  let rejectKill; const killP = new Promise((_, rej) => { rejectKill = rej; }); killP.catch(() => {});
  const abort = code => { if (!why) why = code; try { ctrl && ctrl.abort(); } catch { /* ignore */ } rejectKill(new LoadError(why)); };
  const arm = () => { clearTimeout(stallT); stallT = setTimeout(() => abort('stall'), stallMs); };
  const hardT = setTimeout(() => abort('max-time'), maxAttemptMs);
  const guard = p => Promise.race([p, killP]);
  arm();
  try {
    let res;
    try { res = await guard(fetch(url, ctrl ? { signal: ctrl.signal, credentials: 'same-origin' } : { credentials: 'same-origin' })); }
    catch (e) { throw new LoadError(why || 'network'); }
    if (!res.ok) throw new LoadError('http ' + res.status, { permanent: res.status === 404 || res.status === 410 || res.status === 403, status: res.status });
    arm();
    const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.body || typeof res.body.getReader !== 'function') {
      const b = await guard(res.blob()).catch(() => { throw new LoadError(why || 'network'); });
      onBytes(b.size, len || b.size);
      return b;
    }
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      let r;
      try { r = await guard(reader.read()); } catch { throw new LoadError(why || 'network'); }
      if (r.done) break;
      chunks.push(r.value); got += r.value.byteLength; arm(); onBytes(got, len);
    }
    if (why) throw new LoadError(why);
    if (len && got < len) throw new LoadError('truncated');
    if (!got) throw new LoadError('empty');
    return new Blob(chunks, { type: type.startsWith('image/') ? type : guessType(url) });
  } finally {
    clearTimeout(stallT); clearTimeout(hardT);
  }
}

function xhrBytes(url, { stallMs, maxAttemptMs, onBytes }) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    let settled = false, stallT = 0, hardT = 0;
    const done = (err, val) => { if (settled) return; settled = true; clearTimeout(stallT); clearTimeout(hardT); err ? reject(err) : resolve(val); };
    const kill = code => { if (settled) return; done(new LoadError(code)); try { x.abort(); } catch { /* ignore */ } }; // settle first: abort() fires onabort synchronously
    const arm = () => { if (settled) return; clearTimeout(stallT); stallT = setTimeout(() => kill('stall'), stallMs); };
    x.open('GET', url, true); x.responseType = 'blob';
    x.onreadystatechange = () => { if (x.readyState >= 2) arm(); };
    x.onprogress = e => { arm(); onBytes(e.loaded, e.lengthComputable ? e.total : 0); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300 && x.response && x.response.size) {
        let b = x.response; if (!b.type || !b.type.startsWith('image/')) b = new Blob([b], { type: guessType(url) });
        onBytes(b.size, b.size); done(null, b);
      } else done(new LoadError('http ' + x.status, { permanent: x.status === 404 || x.status === 410 || x.status === 403, status: x.status }));
    };
    x.onerror = () => done(new LoadError('network'));
    x.onabort = () => done(new LoadError('aborted'));
    arm(); hardT = setTimeout(() => kill('max-time'), maxAttemptMs);
    try { x.send(); } catch { done(new LoadError('network')); }
  });
}

function guessType(url) { const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url)); return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'; }

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------
function fitWithin(w, h, maxDim) {
  if (!w || !h || Math.max(w, h) <= maxDim) return null;
  const s = maxDim / Math.max(w, h);
  return { w: Math.max(1, Math.min(maxDim, Math.round(w * s))), h: Math.max(1, Math.min(maxDim, Math.round(h * s))) };
}

function canvasResize(src, w, h, { flipV = false } = {}) {
  const c = makeCanvas(w, h); if (!c) return null;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  if (flipV) { g.translate(0, h); g.scale(1, -1); }
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/** GL-destined: vertically FLIPPED ImageBitmap (upload-ready with flipY=false). */
async function decodeBitmapFlipped(blob, entry, maxDim) {
  const opt = { imageOrientation: 'flipY', premultiplyAlpha: 'none' };
  const fit = fitWithin(entry.w | 0, entry.h | 0, maxDim);
  if (fit) Object.assign(opt, { resizeWidth: fit.w, resizeHeight: fit.h, resizeQuality: 'high' });
  let bmp = await createImageBitmap(blob, opt);
  const fit2 = fitWithin(bmp.width, bmp.height, maxDim); // resize ignored, or manifest lacked w/h
  if (fit2) {
    // Source is already flipped → do NOT pass imageOrientation again.
    let b2 = null;
    try { b2 = await createImageBitmap(bmp, { resizeWidth: fit2.w, resizeHeight: fit2.h, resizeQuality: 'high', premultiplyAlpha: 'none' }); } catch { b2 = null; }
    if (b2 && Math.max(b2.width, b2.height) <= maxDim) { if (bmp.close) bmp.close(); bmp = b2; }
    else {
      if (b2 && b2.close) b2.close();
      const c = canvasResize(bmp, fit2.w, fit2.h); // canvas keeps the flipped orientation
      if (c) { if (bmp.close) bmp.close(); return { src: c, flipped: true, w: fit2.w, h: fit2.h }; }
    }
  }
  return { src: bmp, flipped: true, w: bmp.width, h: bmp.height };
}

/** DOM-destined (and fallback for everything): decoded HTMLImageElement from a blob: URL. */
async function decodeImage(blob, maxDim) {
  if (!hasDOM || typeof Image !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) {
    if (typeof createImageBitmap === 'function') {
      // Worker/OffscreenCanvas context: natural bitmap drawn into a canvas (so textures honour flipY).
      const b = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
      const fit = fitWithin(b.width, b.height, maxDim) || { w: b.width, h: b.height };
      const c = canvasResize(b, fit.w, fit.h); if (b.close) b.close();
      if (!c) throw new LoadError('decode');
      return { src: c, flipped: false, w: fit.w, h: fit.h, objUrl: null };
    }
    throw new LoadError('decode');
  }
  const objUrl = URL.createObjectURL(blob);
  const img = new Image(); img.decoding = 'async'; img.src = objUrl;
  try {
    if (typeof img.decode === 'function') {
      try { await img.decode(); }
      catch (e) { // Safari sometimes rejects decode() for images that load fine
        if (!(img.complete && img.naturalWidth)) await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(e); if (img.complete && img.naturalWidth) res(); });
      }
    } else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  } catch { URL.revokeObjectURL(objUrl); throw new LoadError('decode'); }
  const { w, h } = dimsOf(img);
  if (!w || !h) { URL.revokeObjectURL(objUrl); throw new LoadError('decode'); }
  const fit = fitWithin(w, h, maxDim);
  if (fit) { const c = canvasResize(img, fit.w, fit.h); if (c) return { src: c, flipped: false, w: fit.w, h: fit.h, objUrl }; }
  return { src: img, flipped: false, w, h, objUrl };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
async function fetchText(url, timeoutMs) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let t = 0;
  let timedOut = false;
  const to = new Promise((_, rej) => { t = setTimeout(() => { timedOut = true; rej(new LoadError('timeout')); try { ctrl && ctrl.abort(); } catch { /* ignore */ } }, timeoutMs); });
  to.catch(() => {});
  try {
    const res = await Promise.race([fetch(url, { cache: 'no-cache', credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined }), to]);
    if (!res.ok) throw new LoadError('http ' + res.status, { permanent: res.status === 404, status: res.status });
    return await Promise.race([res.text(), to]);
  } catch (e) {
    if (e instanceof LoadError) throw e;
    throw new LoadError(timedOut ? 'timeout' : 'network');
  } finally { clearTimeout(t); }
}

function normalizeManifest(j) {
  const out = {};
  if (!j || typeof j !== 'object') return out;
  let src = j.images && typeof j.images === 'object' ? j.images : j.assets && typeof j.assets === 'object' ? j.assets : j;
  if (Array.isArray(src)) src = Object.fromEntries(src.filter(e => e && e.key).map(e => [e.key, e]));
  for (const [k, e] of Object.entries(src)) if (e && typeof e === 'object' && typeof e.src === 'string' && e.src) out[k] = Object.freeze({ ...e });
  return out;
}

async function loadManifest(url, timeoutMs, log) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await fetchText(url, timeoutMs);
      return normalizeManifest(JSON.parse(text));
    } catch (e) {
      if (log) console.warn('[assets] manifest attempt', attempt + 1, 'failed:', e && (e.code || e.message));
      if (e && e.permanent) break;
      if (attempt === 0) await sleep(500);
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string} [opts.manifestUrl='assets/manifest.json']  image srcs resolve relative to it
 * @param {(fraction:number, key:string)=>void} [opts.onProgress]  0..1, monotonic, byte-smoothed
 * @param {string[]} [opts.priority]  keys to load first (in this order)
 * Test/tuning knobs (optional): lanes=4, stallMs=8000, retries=1, maxDim=4096, manifestTimeoutMs=7000,
 *   maxAttemptMs=180000, transport:'fetch'|'xhr', decoder:'auto'|'image', glKeys: string[]|fn, log=true
 * @returns {Promise<Assets> & {assets: Assets}}  never rejects
 */
export function loadAssets(opts = {}) {
  const cfg = {
    manifestUrl: opts.manifestUrl || 'assets/manifest.json',
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    priority: Array.isArray(opts.priority) ? opts.priority.filter(k => typeof k === 'string') : [],
    lanes: Math.max(1, Math.min(8, opts.lanes | 0 || 4)),
    stallMs: opts.stallMs > 0 ? opts.stallMs : 8000,
    retries: Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 1,
    maxDim: opts.maxDim > 0 ? opts.maxDim : 4096,
    manifestTimeoutMs: opts.manifestTimeoutMs > 0 ? opts.manifestTimeoutMs : 7000,
    maxAttemptMs: opts.maxAttemptMs > 0 ? opts.maxAttemptMs : 180000,
    transport: opts.transport || 'auto',
    decoder: opts.decoder || 'auto',
    isGL: typeof opts.glKeys === 'function' ? opts.glKeys : Array.isArray(opts.glKeys) ? k => opts.glKeys.includes(k) : k => GL_KEY.test(k),
    log: opts.log !== false,
  };
  const store = createStore(cfg);
  const p = run(cfg, store).then(() => store.api, e => { console.warn('[assets] loader error', e); store.finish(); return store.api; });
  p.assets = store.api;
  return p;
}

async function run(cfg, store) {
  const t0 = now();
  store.t0 = t0;
  let base;
  try { base = new URL(cfg.manifestUrl, hasDOM ? document.baseURI : (typeof location !== 'undefined' ? location.href : 'http://localhost/')); }
  catch { base = null; }
  const entries = base ? await loadManifest(base.href, cfg.manifestTimeoutMs, cfg.log) : {};
  const keys = Object.keys(entries);
  const seen = new Set(); const order = [], lazy = [];
  // a lazy key named in `priority` is fetched eagerly (e.g. the current fox's model), the rest wait for load()/model()
  const prio = new Set(cfg.priority);
  for (const k of [...cfg.priority, ...keys]) if (entries[k] && !seen.has(k)) { seen.add(k); (isLazy(entries[k]) && !prio.has(k) ? lazy : order).push(k); }
  store.setManifest(entries, order, base, lazy);
  store.cfg = cfg;
  if (!order.length) { store.finish(); return; }

  const bitmapOK = cfg.decoder !== 'image' && (await probeBitmapFlip());
  store.receipt.decoder = bitmapOK ? 'bitmap+image' : 'image';

  let next = 0;
  const lane = async () => { while (next < order.length) { const k = order[next++]; await loadOne(k, cfg, store, bitmapOK); } };
  await Promise.all(Array.from({ length: Math.min(cfg.lanes, order.length) }, lane));
  store.finish();
}

const entryKind = e => (e && (e.type === 'model' || /\.(glb|gltf)(?:[?#]|$)/i.test(e.src)) ? 'model'
  : e && (e.type === 'audio' || e.type === 'binary' || /\.(mp3|m4a|aac|ogg|wav|bin)(?:[?#]|$)/i.test(e.src)) ? 'buffer' : 'image');
const isLazy = e => !!(e && (e.lazy === true || entryKind(e) === 'model'));

// GLTFLoader + meshopt decoder, imported on first use (keeps this module node-safe; esbuild inlines it)
let gltfLoaderP = null;
function gltfLoader() {
  if (!gltfLoaderP) {
    gltfLoaderP = (async () => {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
      const L = new GLTFLoader();
      try { await MeshoptDecoder.ready; L.setMeshoptDecoder(MeshoptDecoder); } catch (e) { console.warn('[assets] meshopt decoder unavailable', e); }
      return L;
    })();
    gltfLoaderP.catch(() => { gltfLoaderP = null; });
  }
  return gltfLoaderP;
}
async function decodeModel(blob, url) {
  const L = await gltfLoader();
  const ab = await blob.arrayBuffer();
  const base = String(url).replace(/[^/]*(?:[?#].*)?$/, '');
  return await new Promise((res, rej) => L.parse(ab, base, res, rej));
}

async function loadOne(key, cfg, store, bitmapOK) {
  const rec = store.recs.get(key);
  rec.state = 'loading';
  const e = rec.entry;
  const kind = entryKind(e);
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    rec.attempts = attempt + 1;
    try {
      store.partial(key, 0);
      const blob = await fetchBytes(rec.url, { stallMs: cfg.stallMs, maxAttemptMs: cfg.maxAttemptMs, transport: cfg.transport, onBytes: (got, len) => { const exp = len || e.bytes || 0; store.partial(key, exp ? got / exp : 0.5); } });
      rec.bytes = blob.size;
      if (kind === 'model') { const gltf = await decodeModel(blob, rec.url); store.okValue(key, gltf, blob); return; }
      if (kind === 'buffer') { const ab = await blob.arrayBuffer(); store.okValue(key, ab, blob); return; }
      const dec = bitmapOK && cfg.isGL(key, e) ? await decodeBitmapFlipped(blob, e, cfg.maxDim) : await decodeImage(blob, cfg.maxDim);
      store.ok(key, dec, blob);
      return;
    } catch (err) {
      const code = (err && (err.code || err.name || err.message)) || 'error';
      rec.errors.push(code);
      const permanent = err && err.permanent;
      if (cfg.log) console.warn(`[assets] ${key} attempt ${attempt + 1} failed: ${code}${permanent || attempt === cfg.retries ? '' : ' — retrying'}`);
      if (permanent || attempt === cfg.retries) break;
      store.receipt.retried.push(key);
      await sleep(350 + 400 * attempt);
    }
  }
  store.fail(key);
}

// ---------------------------------------------------------------------------
// Store / public Assets object
// ---------------------------------------------------------------------------
function createStore(cfg) {
  const recs = new Map();
  const texCache = new Map();
  const partials = new Map();
  let total = 0, doneN = 0, lastFrac = 0, lastEmit = 0, finished = false;
  let resolveDone; const donePromise = new Promise(r => { resolveDone = r; });
  let manifestKnown = false, resolveManifest; const manifestPromise = new Promise(r => { resolveManifest = r; });
  const receipt = { loaded: 0, failed: [], total: 0, ms: 0, bytes: 0, retried: [], decoder: 'pending', done: false };

  const emit = (key, force) => {
    if (!cfg.onProgress) return;
    let sum = doneN; for (const v of partials.values()) sum += v;
    const f = total ? Math.min(1, Math.max(lastFrac, sum / total)) : 1;
    const t = now();
    if (!force && (t - lastEmit < 120 || f - lastFrac < 0.002)) return;
    lastFrac = f; lastEmit = t;
    try { cfg.onProgress(f, key || ''); } catch (e) { console.warn('[assets] onProgress threw', e); }
  };

  const settle = rec => { const ws = rec.waiters; rec.waiters = []; for (const w of ws) w(rec.state === 'ok' ? view(rec) : null); };

  const store = {
    recs, receipt, t0: now(),
    setManifest(entries, order, base, lazy = []) {
      total = order.length; receipt.total = total; manifestKnown = true;
      for (const k of [...order, ...lazy]) {
        const e = entries[k];
        let url = e.src;
        try {
          const u = new URL(e.src, base || undefined);
          const ver = e.v != null ? e.v : e.bytes;
          if (ver != null && !u.searchParams.has('v') && u.protocol !== 'data:' && u.protocol !== 'blob:') u.searchParams.set('v', String(ver));
          url = u.href;
        } catch { /* keep raw */ }
        const isL = lazy.includes(k);
        recs.set(k, { key: k, entry: e, url, state: isL ? 'lazy' : 'queued', lazy: isL, kind: entryKind(e), value: null, src: null, flipped: false, w: 0, h: 0, blob: null, objUrl: null, natural: null, mirrored: null, attempts: 0, errors: [], waiters: [], bytes: 0 });
      }
      resolveManifest();
    },
    /** non-image payload (gltf / ArrayBuffer) */
    okValue(key, value, blob) {
      const r = recs.get(key); Object.assign(r, { state: 'ok', value, blob: null });
      receipt.bytes += blob && blob.size || 0;
      if (!r.lazy) { partials.delete(key); doneN++; receipt.loaded++; emit(key, true); }
      else receipt.lazyLoaded = (receipt.lazyLoaded || 0) + 1;
      settle(r);
    },
    /** kick off a lazy key (idempotent); resolves when settled */
    startLazy(key) {
      const r = recs.get(key);
      if (!r) return Promise.resolve(null);
      if (r.state === 'lazy') {
        r.state = 'loading';
        const cfg = store.cfg || { retries: 1, stallMs: 8000, maxAttemptMs: 180000, transport: 'auto', maxDim: 4096, isGL: k => GL_KEY.test(k), log: true };
        probeBitmapFlip().then(ok => loadOne(key, cfg, store, cfg.decoder !== 'image' && ok)).catch(e => { console.warn('[assets] lazy', key, e); store.fail(key); });
      }
      if (r.state === 'ok' || r.state === 'failed') return Promise.resolve(r.state === 'ok' ? (r.value || view(r)) : null);
      return new Promise(res => r.waiters.push(() => res(r.state === 'ok' ? (r.value || view(r)) : null)));
    },
    partial(key, frac) { if (!finished && isFinite(frac)) { partials.set(key, Math.max(0, Math.min(0.98, frac))); emit(key, false); } },
    ok(key, dec, blob) {
      const r = recs.get(key); Object.assign(r, { state: 'ok', src: dec.src, flipped: !!dec.flipped, w: dec.w, h: dec.h, blob, objUrl: dec.objUrl || null });
      receipt.bytes += blob.size || 0;
      if (!r.lazy) { partials.delete(key); doneN++; receipt.loaded++; emit(key, true); }
      settle(r);
    },
    fail(key) {
      const r = recs.get(key); r.state = 'failed';
      if (r.lazy) { (receipt.lazyFailed || (receipt.lazyFailed = [])).push(key); settle(r); return; }
      partials.delete(key); doneN++;
      receipt.failed.push(key); emit(key, true); settle(r);
    },
    finish() {
      if (finished) return; finished = true; manifestKnown = true; resolveManifest();
      receipt.ms = Math.round(now() - store.t0); receipt.done = true;
      for (const r of recs.values()) if (!r.lazy && (r.state === 'queued' || r.state === 'loading')) { r.state = 'failed'; if (!receipt.failed.includes(r.key)) receipt.failed.push(r.key); settle(r); }
      if (cfg.onProgress) { lastFrac = 1; try { cfg.onProgress(1, ''); } catch { /* ignore */ } }
      if (cfg.log) {
        const why = receipt.failed.map(k => { const r = recs.get(k); return r && r.errors.length ? `${k} [${r.errors.join(',')}]` : k; });
        console.log(`[assets] ${receipt.loaded}/${receipt.total} loaded in ${(receipt.ms / 1000).toFixed(1)}s${why.length ? ` (failed: ${why.join(', ')})` : ''}`);
      }
      resolveDone(receipt);
    },
  };

  // natural-orientation drawable for get()
  function view(r) {
    if (!r || r.state !== 'ok') return null;
    if (r.kind && r.kind !== 'image') return r.value;
    if (!r.flipped) return r.src;
    if (!r.natural) r.natural = canvasResize(r.src, r.w, r.h, { flipV: true }) || r.src;
    return r.natural;
  }

  // Horizontally mirrored copy (per FRAME for strips so frame i stays at i/frames), same vertical orientation as src.
  function mirrored(r) {
    if (r.mirrored) return r.mirrored;
    const frames = Math.max(1, (r.entry.frames | 0) || 1);
    const c = makeCanvas(r.w, r.h); if (!c) return null;
    const g = c.getContext('2d'); const fw = r.w / frames;
    for (let i = 0; i < frames; i++) {
      g.save(); g.translate((i + 1) * fw, 0); g.scale(-1, 1);
      g.drawImage(r.src, i * fw, 0, fw, r.h, 0, 0, fw, r.h);
      g.restore();
    }
    r.mirrored = c; return c;
  }

  const whenManifest = (key, fn) => {
    const r = recs.get(key);
    if (r) return fn(r);
    return manifestKnown || finished ? Promise.resolve(null) : manifestPromise.then(() => (recs.has(key) ? fn(recs.get(key)) : null));
  };
  const api = {
    /** Decoded image (HTMLImageElement | HTMLCanvasElement | ImageBitmap) in natural orientation, or null. */
    get(key) { const r = recs.get(key); return r && r.kind !== 'image' ? null : view(r); },
    /** Manifest entry for a LOADED key (w,h,frames,fw,fh,anchor,heightFt,contactFrame,horizon,…) or null. */
    meta(key) { const r = recs.get(key); return r && r.state === 'ok' ? r.entry : null; },
    /** Manifest entry whether or not it has loaded (lazy keys included), or null. */
    entry(key) { const r = recs.get(key); return r ? r.entry : null; },
    /** 'lazy'|'queued'|'loading'|'ok'|'failed'|null */
    state(key) { const r = recs.get(key); return r ? r.state : null; },
    /** true if the key loaded. */
    has(key) { const r = recs.get(key); return !!r && r.state === 'ok'; },
    /** Raw bytes of an audio/binary entry (null until loaded; a lazy entry starts loading on first call). */
    buffer(key) {
      const r = recs.get(key); if (!r) return null;
      if (r.state === 'ok') return r.kind === 'buffer' ? r.value : null;
      if (r.state === 'lazy' && r.kind === 'buffer') store.startLazy(key);
      return null;
    },
    /** Promise<gltf|null> for a type:'model' entry (GLB). Starts the download on first call; cached. Never rejects. */
    model(key) { return whenManifest(key, r => (r.kind === 'model' ? store.startLazy(key) : null)).catch(() => null); },
    /** Promise<value|null>: start (if lazy) and await any key — image, buffer or model. */
    load(key) { return whenManifest(key, r => (r.lazy ? store.startLazy(key) : api.ready(key))).catch(() => null); },
    /** Decoded pixel size actually held (after any >4096 downscale). */
    size(key) { const r = recs.get(key); return r && r.state === 'ok' ? { w: r.w, h: r.h } : null; },
    /** A URL usable in <img src> / CSS background-image (blob: URL of the downloaded bytes), or null. */
    url(key) {
      const r = recs.get(key); if (!r || r.state !== 'ok') return null;
      if (!r.objUrl && r.blob && typeof URL !== 'undefined' && URL.createObjectURL) r.objUrl = URL.createObjectURL(r.blob);
      return r.objUrl || r.url;
    },
    /** Resolves with get(key) (or null) once the key has settled — use to swap in late art. */
    ready(key) {
      const r = recs.get(key);
      if (!r) return manifestKnown || finished ? Promise.resolve(null) : manifestPromise.then(() => (recs.has(key) ? api.ready(key) : null));
      if (r.lazy && r.state === 'lazy') return store.startLazy(key);
      if (r.state === 'ok' || r.state === 'failed') return Promise.resolve(view(r));
      return new Promise(res => r.waiters.push(res));
    },
    /** Keys that loaded OK. */
    keys() { return [...recs.values()].filter(r => r.state === 'ok').map(r => r.key); },
    /**
     * Cached THREE.Texture (null if missing). opts: { repeat:[x,y]|n, srgb=true, mirror=false (horizontal flip;
     * per-frame for strips), wrap:'clamp'|'repeat'|'mirror' (default: 'repeat' if repeat given or key starts with
     * tex_, else 'clamp'), anisotropy, mipmaps=true }. Same opts → same Texture object (shared!).
     */
    texture(THREE, key, opts = {}) {
      const r = recs.get(key);
      if (!THREE || !r || r.state !== 'ok' || (r.kind && r.kind !== 'image') || !r.src) return null;
      const o = opts || {};
      const rep = Array.isArray(o.repeat) ? [+o.repeat[0] || 1, +(o.repeat[1] ?? o.repeat[0]) || 1] : typeof o.repeat === 'number' ? [o.repeat, o.repeat] : null;
      const srgb = o.srgb !== false; const mirror = !!o.mirror;
      const wrap = o.wrap || (rep || /^tex_/.test(key) ? 'repeat' : 'clamp');
      const mip = o.mipmaps !== false;
      const ck = `${key}|${rep ? rep.join('x') : '-'}|${srgb ? 's' : 'l'}|${mirror ? 'm' : '-'}|${wrap}|${mip ? 1 : 0}|${o.anisotropy || 0}`;
      const hit = texCache.get(ck); if (hit) return hit;
      let img = mirror ? mirrored(r) || r.src : r.src;
      let flipY = !r.flipped;
      if (isBitmap(img) && flipY) { img = canvasResize(img, r.w, r.h) || img; } // WebGL ignores flipY for ImageBitmap
      const t = new THREE.Texture(img);
      t.name = key; t.flipY = flipY; t.premultiplyAlpha = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : (THREE.NoColorSpace !== undefined ? THREE.NoColorSpace : '');
      const W = wrap === 'mirror' ? THREE.MirroredRepeatWrapping : wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.wrapS = W; t.wrapT = W;
      if (rep) t.repeat.set(rep[0], rep[1]);
      if (o.anisotropy) t.anisotropy = o.anisotropy;
      if (!mip) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
      t.needsUpdate = true;
      texCache.set(ck, t);
      return t;
    },
    /** Raw manifest entries (loaded or not). */
    get manifest() { const o = {}; for (const r of recs.values()) o[r.key] = r.entry; return o; },
    receipt,
    /** Promise<receipt> resolved when every image has settled. */
    done: donePromise,
  };
  store.api = api;
  return store;
}
