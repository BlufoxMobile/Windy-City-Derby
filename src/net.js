// ============================================================================
// WINDY CITY DERBY — leaderboard client. Owner: NET.
//
//   createBoard({ endpoint }) → Board
//   Board: {
//     ping() → Promise<bool>,
//     top({ board:'today'|'alltime'|'longest', date, district, limit })
//        → Promise<{ ok, rows:[{rank,name,score,homers,longest,charId,parkId,district,updated,me?}], remote, board, date, district, error? }>
//     submit(summary & { name, district }) → Promise<{ ok, remote, rank|null, boards, queued?, improved?, error? }>
//     local: { best(parkId?), history(), record(summary) },
//     pending() → number, flush() → Promise<number>        // offline queue helpers
//   }
// Nothing here ever throws or rejects: network trouble → local data + queued resend.
// ============================================================================
import { CHARACTERS, PARK_IDS, DISTRICTS, VERSION, BOARD_ENDPOINT, chicagoDate } from './data.js';

const LOCAL_KEY = 'wcd-local-v1';
const QUEUE_KEY = 'wcd-queue-v1';
const CHAR_IDS = new Set(CHARACTERS.map(c => c.id));
const LIMITS = { score: 250000, homers: 100, longest: 620, bestStreak: 100, pitches: 400 };
const LOCAL_ROWS = 50, HISTORY = 50, QUEUE_MAX = 25, QUEUE_TTL = 7 * 864e5, RECENT_TTL = 5 * 60e3, TOP_TTL = 10e3;

// ---------------------------------------------------------------------------
// Helpers shared with the UI
// ---------------------------------------------------------------------------
/** Same rules as the Worker: letters/digits/space/.'- only, accents stripped, spaces collapsed, ≤16 chars. */
export function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { /* ignore */ }
  return s.replace(/[^A-Za-z0-9 .'-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
}
/** Canonical district name from DISTRICTS (case-insensitive) or ''. */
export function normalizeDistrict(d) {
  if (typeof d !== 'string') return '';
  const k = d.trim().toLowerCase();
  return DISTRICTS.find(x => x.toLowerCase() === k) || '';
}

const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
const nowMs = () => Date.now();
const metricOf = board => (board === 'longest' ? 'longest' : 'score');
const normBoard = b => { const s = String(b || 'today').toLowerCase(); return s === 'daily' ? 'today' : ['today', 'alltime', 'longest'].includes(s) ? s : 'today'; };

// ---------------------------------------------------------------------------
// localStorage — every access guarded; in-memory mirror when storage is blocked.
// ---------------------------------------------------------------------------
const mem = new Map();
const store = {
  get(key, fallback) {
    try { const s = globalThis.localStorage && globalThis.localStorage.getItem(key); if (s != null) return JSON.parse(s); } catch { /* ignore */ }
    return mem.has(key) ? JSON.parse(mem.get(key)) : fallback;
  },
  set(key, val) {
    const s = JSON.stringify(val); mem.set(key, s);
    try { globalThis.localStorage && globalThis.localStorage.setItem(key, s); } catch { /* quota / private mode */ }
  },
};

// ---------------------------------------------------------------------------
// Ranking helpers (same algorithm as worker/worker.js)
// ---------------------------------------------------------------------------
function sortRows(rows, metric) {
  return rows.sort((a, b) => (b[metric] - a[metric]) || ((a.updated || 0) - (b.updated || 0)) || String(a.name).localeCompare(String(b.name)));
}
function rankRows(rows, metric) {
  let prev = null, prevRank = 0;
  return rows.map((r, i) => { const rank = r[metric] === prev ? prevRank : i + 1; prev = r[metric]; prevRank = rank; return { ...r, rank }; });
}
function rankOf(rows, id, metric) {
  const me = rows.find(r => r.id === id); if (!me) return null;
  let better = 0; for (const r of rows) if (r[metric] > me[metric]) better++;
  return better + 1;
}
function upsert(rows, row, metric, cap) {
  const i = rows.findIndex(r => r.id === row.id);
  if (i >= 0) {
    if (!(row[metric] > rows[i][metric])) return { rows, changed: false, rank: rankOf(rows, row.id, metric) };
    const next = rows.slice(); next[i] = row; sortRows(next, metric);
    return { rows: next, changed: true, rank: rankOf(next, row.id, metric) };
  }
  const next = sortRows([...rows, row], metric);
  if (next.length > cap) next.length = cap;
  const rank = rankOf(next, row.id, metric);
  return { rows: next, changed: rank !== null, rank };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------
function buildPayload(s) {
  const summary = s || {};
  const homers = int(summary.homers, 0, LIMITS.homers);
  let longest = homers > 0 ? int(summary.longest, 1, LIMITS.longest) : 0;
  const mode = summary.mode === 'daily' ? 'daily' : 'free';
  const date = typeof summary.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(summary.date) ? summary.date : chicagoDate();
  return {
    name: sanitizeName(summary.name),
    district: normalizeDistrict(summary.district),
    charId: CHAR_IDS.has(summary.charId) ? summary.charId : 'nova',
    parkId: PARK_IDS.includes(summary.parkId) ? summary.parkId : 'wrigley',
    mode, date,
    score: Math.min(int(summary.score, 0, LIMITS.score), homers * 5300 + 200),
    homers, longest,
    bestStreak: Math.min(int(summary.bestStreak, 0, LIMITS.bestStreak), homers),
    pitches: int(summary.pitches != null ? summary.pitches : summary.pitchCount, 0, LIMITS.pitches),
    v: String(summary.v || VERSION),
    sid: Math.random().toString(36).slice(2, 10) + nowMs().toString(36),
    t: nowMs(),
  };
}
const WIRE = ['name', 'district', 'charId', 'parkId', 'mode', 'date', 'score', 'homers', 'longest', 'bestStreak', 'pitches', 'v', 'sid'];
const wire = p => { const o = {}; for (const k of WIRE) o[k] = p[k]; return o; };

// ---------------------------------------------------------------------------
// Local board + personal bests
// ---------------------------------------------------------------------------
function emptyLocal() { return { v: 1, history: [], boards: { alltime: [], longest: [], daily: {} }, best: null, name: '' }; }
function loadLocal() {
  const d = store.get(LOCAL_KEY, null);
  if (!d || typeof d !== 'object' || d.v !== 1) return emptyLocal();
  d.history = Array.isArray(d.history) ? d.history : [];
  d.boards = d.boards && typeof d.boards === 'object' ? d.boards : { alltime: [], longest: [], daily: {} };
  for (const k of ['alltime', 'longest']) if (!Array.isArray(d.boards[k])) d.boards[k] = [];
  if (!d.boards.daily || typeof d.boards.daily !== 'object') d.boards.daily = {};
  return d;
}
function blankBest() { return { score: 0, homers: 0, longest: 0, bestStreak: 0, rounds: 0, parks: {}, chars: {} }; }
function bumpBest(b, p) {
  b.rounds = (b.rounds || 0) + 1;
  b.score = Math.max(b.score || 0, p.score); b.homers = Math.max(b.homers || 0, p.homers);
  b.longest = Math.max(b.longest || 0, p.longest); b.bestStreak = Math.max(b.bestStreak || 0, p.bestStreak || 0);
}

/** Records a round locally (history, bests, local boards). Returns local ranks {alltime,today,longest}. */
function recordLocal(p, { board = true } = {}) {
  const L = loadLocal();
  L.history.unshift({ date: p.date, mode: p.mode, parkId: p.parkId, charId: p.charId, score: p.score, homers: p.homers, longest: p.longest, bestStreak: p.bestStreak, name: p.name, t: p.t });
  if (L.history.length > HISTORY) L.history.length = HISTORY;
  const B = L.best && typeof L.best === 'object' ? L.best : blankBest();
  bumpBest(B, p);
  B.parks = B.parks || {}; B.chars = B.chars || {};
  B.parks[p.parkId] = B.parks[p.parkId] || { score: 0, homers: 0, longest: 0, bestStreak: 0, rounds: 0 }; bumpBest(B.parks[p.parkId], p);
  B.chars[p.charId] = B.chars[p.charId] || { score: 0, homers: 0, longest: 0, bestStreak: 0, rounds: 0 }; bumpBest(B.chars[p.charId], p);
  L.best = B;
  const ranks = { alltime: null, today: null, longest: null };
  if (board && p.name && p.name.length >= 2) {
    const row = { id: p.name.toLowerCase(), name: p.name, score: p.score, homers: p.homers, longest: p.longest, charId: p.charId, parkId: p.parkId, district: p.district, updated: p.t };
    let r = upsert(L.boards.alltime, row, 'score', LOCAL_ROWS); L.boards.alltime = r.rows; ranks.alltime = r.rank;
    if (p.longest > 0) { r = upsert(L.boards.longest, row, 'longest', LOCAL_ROWS); L.boards.longest = r.rows; ranks.longest = r.rank; }
    if (p.mode === 'daily') {
      r = upsert(L.boards.daily[p.date] || [], row, 'score', LOCAL_ROWS); L.boards.daily[p.date] = r.rows; ranks.today = r.rank;
      const dates = Object.keys(L.boards.daily).sort(); while (dates.length > 7) delete L.boards.daily[dates.shift()];
    }
    L.name = p.name;
  }
  store.set(LOCAL_KEY, L);
  return ranks;
}

function localTop(board, date, district, limit) {
  const L = loadLocal();
  let rows = board === 'today' ? (L.boards.daily[date] || []) : (L.boards[board] || []);
  const metric = metricOf(board);
  rows = sortRows(rows.slice(), metric);
  if (district) rows = rows.filter(r => r.district === district);
  if (board === 'longest') rows = rows.filter(r => r.longest > 0);
  return rankRows(rows, metric).slice(0, limit).map(r => toPublic(r, L.name));
}
function toPublic(r, meName) {
  const out = {
    rank: r.rank, name: String(r.name || ''), score: r.score | 0, homers: r.homers | 0, longest: r.longest | 0,
    charId: r.charId || '', parkId: r.parkId || '', district: r.district || '',
    updated: typeof r.updated === 'number' ? new Date(r.updated).toISOString() : (r.updated || null),
  };
  if (meName && out.name.toLowerCase() === meName.toLowerCase()) out.me = true;
  return out;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
/**
 * @param {{endpoint?:string, timeoutMs?:number, flushDelayMs?:number}} [opts]
 *   endpoint defaults to BOARD_ENDPOINT; '' / null = offline-only (local board).
 */
export function createBoard(opts = {}) {
  const endpointRaw = opts.endpoint === undefined ? BOARD_ENDPOINT : opts.endpoint;
  const base = typeof endpointRaw === 'string' ? endpointRaw.trim().replace(/\/+$/, '') : '';
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
  const flushDelayMs = opts.flushDelayMs >= 0 ? opts.flushDelayMs : 1500;
  const inflight = new Set();
  const topCache = new Map();
  let recent = null;      // last successful submission — patched into /top while KV propagates
  let flushing = null;

  function netErr(code, retryable, status = 0, data = null) { const e = new Error(code); e.isNet = true; e.retryable = retryable; e.status = status; e.data = data; return e; }

  async function request(path, { method = 'GET', body } = {}) {
    if (!base) throw netErr('offline', true);
    if (typeof fetch !== 'function') throw netErr('no-fetch', true);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch { /* ignore */ } rej(netErr('timeout', true)); }, timeoutMs); });
    timeout.catch(() => {});
    try {
      const init = { method, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined };
      // text/plain keeps the POST a CORS "simple request" → no preflight round-trip on slow store Wi-Fi.
      if (body != null) { init.body = body; init.headers = { 'content-type': 'text/plain;charset=UTF-8' }; }
      const res = await Promise.race([fetch(base + path, init), timeout]);
      const text = await Promise.race([res.text(), timeout]);
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      // Captive portals / proxies answer 200 with HTML: treat any non-JSON as a retryable failure.
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') throw netErr('non-json', true, res.status);
      if (!res.ok || !data.ok) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429 || data.retry === true;
        throw netErr(String(data.error || ('http ' + res.status)), retryable, res.status, data);
      }
      return data;
    } catch (e) {
      if (e && e.isNet) throw e;
      throw netErr(e && e.name === 'AbortError' ? 'timeout' : 'network', true);
    } finally { clearTimeout(timer); }
  }

  // ---- queue (persisted) ----
  const queueGet = () => { const q = store.get(QUEUE_KEY, []); return Array.isArray(q) ? q.filter(p => p && p.sid && nowMs() - (p.t || 0) < QUEUE_TTL) : []; };
  const queueSet = q => store.set(QUEUE_KEY, q.slice(-QUEUE_MAX));
  const queuePush = p => { const q = queueGet().filter(x => x.sid !== p.sid); q.push(p); queueSet(q); };
  const queueDrop = sid => queueSet(queueGet().filter(x => x.sid !== sid));

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let sent = 0;
      if (!base) return 0;
      for (const p of queueGet()) {
        if (inflight.has(p.sid)) continue;
        inflight.add(p.sid);
        try { await request('/submit', { method: 'POST', body: JSON.stringify(wire(p)) }); queueDrop(p.sid); sent++; topCache.clear(); }
        catch (e) { if (e && e.retryable) break; queueDrop(p.sid); console.warn('[board] dropped queued score:', e && e.message); }
        finally { inflight.delete(p.sid); }
      }
      if (sent) console.log('[board] flushed', sent, 'queued score(s)');
      return sent;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function patchRecent(rows, board, date, district, limit) {
    if (!recent || nowMs() - recent.t > RECENT_TTL) return rows;
    if (board === 'today' && !(recent.mode === 'daily' && recent.date === date)) return rows;
    if (district && recent.row.district !== district) return rows;
    const metric = metricOf(board);
    if (board === 'longest' && !(recent.row.longest > 0)) return rows;
    const id = recent.row.name.toLowerCase();
    const mine = rows.find(r => String(r.name).toLowerCase() === id);
    if (mine && mine[metric] >= recent.row[metric]) return rows;
    const merged = rows.filter(r => r !== mine);
    // insert after every row that is >= (ties: existing rows achieved it first)
    let at = merged.findIndex(r => r[metric] < recent.row[metric]); if (at < 0) at = merged.length;
    merged.splice(at, 0, { ...recent.row, rank: 0 });
    let prev = null, prevRank = 0;
    return merged.slice(0, limit).map((r, i) => { const rank = r[metric] === prev ? prevRank : i + 1; prev = r[metric]; prevRank = rank; return { ...r, rank }; });
  }

  const board = {
    endpoint: base,

    async ping() {
      try { const d = await request('/ping'); return d.ok === true && d.game === 'windy-city-derby'; }
      catch { return false; }
    },

    async top(q = {}) {
      const b = normBoard(q.board);
      const date = typeof q.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : chicagoDate();
      const district = normalizeDistrict(q.district || '');
      const limit = Math.max(1, Math.min(100, (q.limit | 0) || 25));
      const meName = loadLocal().name;
      if (base) {
        const qs = `board=${b}&date=${date}&district=${encodeURIComponent(district)}&limit=${limit}`;
        const c = topCache.get(qs);
        if (c && nowMs() - c.t < TOP_TTL) return { ...c.v, rows: c.v.rows.map(r => ({ ...r })) };
        try {
          const d = await request('/top?' + qs);
          if (!Array.isArray(d.rows)) throw netErr('bad rows', true);
          let rows = d.rows.filter(r => r && typeof r.name === 'string').map(r => ({
            rank: r.rank | 0, name: r.name, score: r.score | 0, homers: r.homers | 0, longest: r.longest | 0,
            charId: r.charId || '', parkId: r.parkId || '', district: r.district || '', updated: r.updated || null,
          }));
          rows = patchRecent(rows, b, date, district, limit);
          if (meName) for (const r of rows) if (r.name.toLowerCase() === meName.toLowerCase()) r.me = true;
          const v = { ok: true, remote: true, board: b, date, district, rows };
          topCache.set(qs, { t: nowMs(), v });
          return { ...v, rows: rows.map(r => ({ ...r })) };
        } catch (e) {
          return { ok: true, remote: false, board: b, date, district, rows: localTop(b, date, district, limit), error: (e && e.message) || 'network' };
        }
      }
      return { ok: true, remote: false, board: b, date, district, rows: localTop(b, date, district, limit), error: 'offline' };
    },

    async submit(summary) {
      let p;
      try { p = buildPayload(summary); } catch (e) { return { ok: false, remote: false, rank: null, boards: null, error: 'bad summary' }; }
      const localRanks = recordLocal(p);
      const localRank = p.mode === 'daily' ? localRanks.today : localRanks.alltime;
      if (p.name.length < 2) return { ok: false, remote: false, rank: null, boards: null, error: 'name' };
      if (!base) return { ok: true, remote: false, queued: false, rank: localRank, boards: localRanks, error: 'offline' };
      // Persist BEFORE sending: if the tab dies mid-request the score is re-sent on next launch (upserts are idempotent).
      queuePush(p); inflight.add(p.sid);
      try {
        const d = await request('/submit', { method: 'POST', body: JSON.stringify(wire(p)) });
        queueDrop(p.sid); topCache.clear();
        recent = { t: nowMs(), mode: p.mode, date: p.date, row: { name: d.name || p.name, score: p.score, homers: p.homers, longest: p.longest, charId: p.charId, parkId: p.parkId, district: p.district, updated: new Date().toISOString() } };
        setTimeout(() => { flush(); }, 0);
        const boards = d.boards && typeof d.boards === 'object' ? { alltime: d.boards.alltime ?? null, today: d.boards.today ?? null, longest: d.boards.longest ?? null } : { alltime: null, today: null, longest: null };
        return { ok: true, remote: true, rank: d.rank ?? null, boards, improved: d.improved || null };
      } catch (e) {
        if (e && e.retryable) return { ok: true, remote: false, queued: true, rank: localRank, boards: localRanks, error: e.message };
        queueDrop(p.sid);
        return { ok: false, remote: true, rank: null, boards: null, error: (e && e.message) || 'rejected' };
      } finally { inflight.delete(p.sid); }
    },

    local: {
      /** Personal bests on this device. best() → {score,homers,longest,bestStreak,rounds,parks:{…},chars:{…}}; best(parkId) → that park's. */
      best(parkId) {
        const B = loadLocal().best || blankBest();
        if (parkId) { const x = (B.parks || {})[parkId]; return x ? { ...x } : { score: 0, homers: 0, longest: 0, bestStreak: 0, rounds: 0 }; }
        return JSON.parse(JSON.stringify(B));
      },
      /** Recent rounds on this device, newest first (≤50). */
      history() { return loadLocal().history.map(h => ({ ...h })); },
      /** Record a round that is NOT being submitted (e.g. player has no name). submit() records automatically. */
      record(summary) { try { recordLocal(buildPayload(summary), { board: false }); } catch { /* ignore */ } },
      /** Last name used for a submission on this device ('' if none). */
      name() { return loadLocal().name || ''; },
    },

    pending() { return queueGet().length; },
    flush,
  };

  if (base && queueGet().length) setTimeout(() => { flush(); }, flushDelayMs);
  return board;
}
