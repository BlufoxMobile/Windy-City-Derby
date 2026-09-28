// ============================================================================
// WINDY CITY DERBY — leaderboard Worker (Cloudflare module Worker).
// Binding: one KV namespace bound as BOARD.
//
//   GET  /ping                         → {ok, game:'windy-city-derby', version, kv}
//   GET  /top?board=today|alltime|longest&date=YYYY-MM-DD&district=&limit=25
//                                      → {ok, board, date, district, rows:[{rank,name,score,homers,longest,charId,parkId,district,updated}]}
//   POST /submit  {name, district, charId, parkId, mode, date, score, homers, longest, bestStreak, pitches, v}
//                                      → {ok, rank|null, boards:{alltime, today, longest}, improved:{alltime, today, longest}}
//
// KV layout (each board = ONE JSON value, ≤100 rows, best row per lowercased name):
//   'alltime'        ranked by score
//   'longest'        ranked by longest homer (ft)
//   'daily:<date>'   ranked by score, daily-challenge submissions only
// A board is written ONLY when a submission changes it (KV free tier: 1,000 writes/day,
// 1 write/sec per key). Ranks come from the in-memory board, never from a KV read-back,
// so eventual consistency can't produce an error.
//
// Self-contained on purpose (paste into the Cloudflare dashboard as-is). The constants below
// mirror src/data.js — tools/worker-test.mjs asserts they stay in sync.
// ============================================================================

const GAME = 'windy-city-derby';
const VERSION = '2.1.0';
const CHAR_IDS = ['rocco', 'jett', 'dex', 'blaze', 'nova', 'skye'];
const PARK_IDS = ['wrigley', 'rate'];
const DISTRICTS = ['North Side', 'South Side', 'East Side', 'West Side', 'Big South'];
const MODES = ['free', 'daily'];
const MAX_ROWS = 100;
const LIMITS = { score: 250000, homers: 100, longest: 620, bestStreak: 100, pitches: 400 };
const RATE = { max: 20, windowMs: 60000 };
const MAX_BODY = 4096;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(obj, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...CORS } });
}
const fail = (status, error, extra) => json({ ok: false, error, ...(extra || {}) }, status);

// ---------------------------------------------------------------------------
// Dates (America/Chicago)
// ---------------------------------------------------------------------------
function chicagoDate(ms) {
  const d = new Date(ms);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return new Date(ms - 6 * 3600e3).toISOString().slice(0, 10); }
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayNumber(s) {
  if (!DATE_RE.test(s)) return NaN;
  const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const back = new Date(t).toISOString().slice(0, 10);
  return back === s ? Math.round(t / 86400000) : NaN; // rejects 2026-02-31 etc.
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { /* ignore */ }
  return s.replace(/[^A-Za-z0-9 .'-]+/g, '').replace(/\s+/g, ' ').trim();
}
function canonicalDistrict(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  if (!k) return '';
  const hit = DISTRICTS.find(d => d.toLowerCase() === k);
  return hit === undefined ? null : hit;
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validate(b, nowMs) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  const name = sanitizeName(b.name);
  if (name.length < 2 || name.length > 16) return 'name must be 2-16 letters/digits';
  if (!CHAR_IDS.includes(b.charId)) return 'bad charId';
  if (!PARK_IDS.includes(b.parkId)) return 'bad parkId';
  const district = canonicalDistrict(b.district);
  if (district === null) return 'bad district';
  const mode = b.mode == null ? 'free' : b.mode;
  if (!MODES.includes(mode)) return 'bad mode';
  if (!isInt(b.score, 0, LIMITS.score)) return 'bad score';
  if (!isInt(b.homers, 0, LIMITS.homers)) return 'bad homers';
  if (!isInt(b.longest, 0, LIMITS.longest)) return 'bad longest';
  if (b.bestStreak != null && !isInt(b.bestStreak, 0, Math.min(LIMITS.bestStreak, b.homers))) return 'bad bestStreak';
  if (b.pitches != null && !isInt(b.pitches, 0, LIMITS.pitches)) return 'bad pitches';
  if (b.score > b.homers * 5300 + 200) return 'implausible score';
  if ((b.longest > 0) !== (b.homers > 0)) return 'implausible longest';
  const today = chicagoDate(nowMs);
  let date = today;
  if (mode === 'daily') {
    const dn = dayNumber(typeof b.date === 'string' ? b.date : '');
    if (!Number.isFinite(dn)) return 'bad date';
    if (Math.abs(dn - dayNumber(today)) > 1) return 'daily date out of window';
    date = b.date;
  }
  return {
    id: name.toLowerCase(), name, district, mode, date,
    charId: b.charId, parkId: b.parkId, score: b.score, homers: b.homers, longest: b.longest,
  };
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------
const metricOf = board => (board === 'longest' ? 'longest' : 'score');

function sortRows(rows, metric) {
  // primary metric desc; ties keep the earlier achiever first; then name for determinism
  return rows.sort((a, b) => (b[metric] - a[metric]) || ((a.updated || 0) - (b.updated || 0)) || String(a.name).localeCompare(String(b.name)));
}
/** Standard competition ranking ("1, 2, 2, 4"). */
function rankRows(rows, metric) {
  let prevVal = null, prevRank = 0;
  return rows.map((r, i) => { const rank = r[metric] === prevVal ? prevRank : i + 1; prevVal = r[metric]; prevRank = rank; return { r, rank }; });
}
function rankOf(rows, id, metric) {
  const me = rows.find(r => r.id === id); if (!me) return null;
  let better = 0; for (const r of rows) if (r[metric] > me[metric]) better++;
  return better + 1;
}

/** Upsert the player's best. Returns { rows, changed, rank }. Never mutates the input. */
function upsert(rows, row, metric) {
  const i = rows.findIndex(r => r.id === row.id);
  if (i >= 0) {
    if (!(row[metric] > rows[i][metric])) return { rows, changed: false, rank: rankOf(rows, row.id, metric) };
    const next = rows.slice(); next[i] = row;
    sortRows(next, metric);
    return { rows: next, changed: true, rank: rankOf(next, row.id, metric) };
  }
  if (rows.length >= MAX_ROWS) {
    let min = Infinity; for (const r of rows) if (r[metric] < min) min = r[metric];
    if (!(row[metric] > min)) return { rows, changed: false, rank: null }; // doesn't make the board
  }
  const next = sortRows([...rows, row], metric);
  if (next.length > MAX_ROWS) next.length = MAX_ROWS;
  const rank = rankOf(next, row.id, metric);
  return { rows: next, changed: rank !== null, rank };
}

/** Read a board. Throws on KV failure (so we never overwrite a board we couldn't read). */
async function readBoard(kv, key) {
  const text = await kv.get(key);
  if (text == null) return [];
  let v; try { v = JSON.parse(text); } catch { return []; } // corrupted value → start fresh
  if (!Array.isArray(v)) return [];
  return v.filter(r => r && typeof r.id === 'string' && Number.isFinite(r.score) && Number.isFinite(r.longest));
}

function publicRow(r, rank) {
  return {
    rank, name: r.name, score: r.score, homers: r.homers, longest: r.longest, charId: r.charId, parkId: r.parkId,
    district: r.district || '', updated: r.updated ? new Date(r.updated).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Rate limit (best-effort, per isolate, in-memory)
// ---------------------------------------------------------------------------
const hits = new Map();
function rateLimited(ip, nowMs) {
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || nowMs - v[v.length - 1] > RATE.windowMs) hits.delete(k);
  const arr = (hits.get(ip) || []).filter(t => nowMs - t < RATE.windowMs);
  if (arr.length >= RATE.max) { hits.set(ip, arr); return true; }
  arr.push(nowMs); hits.set(ip, arr);
  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleTop(url, env, nowMs) {
  if (!env.BOARD) return fail(503, 'kv not bound', { retry: true });
  const q = url.searchParams;
  let board = (q.get('board') || 'today').toLowerCase();
  if (board === 'daily') board = 'today';
  if (!['today', 'alltime', 'longest'].includes(board)) return fail(400, 'bad board');
  const date = q.get('date') || chicagoDate(nowMs);
  if (board === 'today' && !Number.isFinite(dayNumber(date))) return fail(400, 'bad date');
  const district = canonicalDistrict(q.get('district') || '');
  if (district === null) return fail(400, 'bad district');
  let limit = parseInt(q.get('limit') || '25', 10);
  if (!Number.isFinite(limit)) limit = 25;
  limit = Math.max(1, Math.min(MAX_ROWS, limit));
  const key = board === 'today' ? 'daily:' + date : board;
  let rows;
  try { rows = await readBoard(env.BOARD, key); } catch { return fail(503, 'kv read failed', { retry: true }); }
  const metric = metricOf(board);
  sortRows(rows, metric);
  if (district) rows = rows.filter(r => r.district === district);
  const ranked = rankRows(rows, metric).slice(0, limit).map(({ r, rank }) => publicRow(r, rank));
  return json({ ok: true, board, date: board === 'today' ? date : chicagoDate(nowMs), district, rows: ranked }, 200, 'public, max-age=10');
}

async function handleSubmit(req, env, nowMs) {
  if (!env.BOARD) return fail(503, 'kv not bound', { retry: true });
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'anon';
  if (rateLimited(ip, nowMs)) return fail(429, 'slow down', { retry: true });
  const declared = parseInt(req.headers.get('content-length') || '0', 10);
  if (declared > MAX_BODY) return fail(413, 'too large');
  let text;
  try { text = await req.text(); } catch { return fail(400, 'unreadable body'); }
  if (text.length > MAX_BODY) return fail(413, 'too large');
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'bad json'); }
  const v = validate(body, nowMs);
  if (typeof v === 'string') return fail(400, v);

  const row = { id: v.id, name: v.name, score: v.score, homers: v.homers, longest: v.longest, charId: v.charId, parkId: v.parkId, district: v.district, updated: nowMs };
  const targets = [{ board: 'alltime', key: 'alltime' }];
  if (v.mode === 'daily') targets.push({ board: 'today', key: 'daily:' + v.date });
  if (v.longest > 0) targets.push({ board: 'longest', key: 'longest' });

  let current;
  try { current = await Promise.all(targets.map(t => readBoard(env.BOARD, t.key))); }
  catch { return fail(503, 'kv read failed', { retry: true }); }

  const boards = { alltime: null, today: null, longest: null };
  const improved = { alltime: false, today: false, longest: false };
  const writes = [];
  targets.forEach((t, i) => {
    const res = upsert(current[i], row, metricOf(t.board));
    boards[t.board] = res.rank;
    improved[t.board] = res.changed;
    if (res.changed) writes.push(env.BOARD.put(t.key, JSON.stringify(res.rows)));
  });
  if (writes.length) {
    try { await Promise.all(writes); }
    catch { return fail(503, 'kv write failed', { retry: true }); } // idempotent: the client re-sends later
  }
  const rank = v.mode === 'daily' ? boards.today : boards.alltime;
  return json({ ok: true, rank, boards, improved, date: v.date, name: v.name });
}

export default {
  async fetch(req, env, ctx) {
    void ctx;
    const nowMs = env && Number.isFinite(+env.NOW_MS) && +env.NOW_MS > 0 ? +env.NOW_MS : Date.now(); // NOW_MS: test hook only
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/ping' || path === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');
        return json({ ok: true, game: GAME, version: VERSION, kv: !!(env && env.BOARD) });
      }
      if (path === '/top') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');
        return await handleTop(url, env || {}, nowMs);
      }
      if (path === '/submit') {
        if (req.method !== 'POST') return fail(405, 'method not allowed');
        return await handleSubmit(req, env || {}, nowMs);
      }
      return fail(404, 'not found');
    } catch (e) {
      return fail(500, 'server error', { retry: true });
    }
  },
};
