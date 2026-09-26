#!/usr/bin/env node
// ============================================================================
// WINDY CITY DERBY — Worker tests (node ≥18, no deps).
//
//   node tools/worker-test.mjs                  run the unit tests (fake Map-backed KV + write counter)
//   node tools/worker-test.mjs --serve 8787     run worker/worker.js as a local HTTP mock endpoint for
//        [--lag 0]                              tools/harness/net.html (+ /__test/* routes: captive portal,
//                                               hanging endpoint, stalled/trickling image downloads, stats)
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/worker.js';
import * as D from '../src/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fake KV
// ---------------------------------------------------------------------------
export function makeKV({ lagMs = 0 } = {}) {
  const map = new Map(); const prev = new Map(); const putAt = new Map();
  const kv = {
    map, writes: 0, reads: 0, failGet: false, failPut: false, lagMs, log: [],
    async get(key, type) {
      kv.reads++;
      if (kv.failGet) throw new Error('KV get failed');
      let v = map.has(key) ? map.get(key) : null;
      // eventual consistency: for lagMs after a put, reads may return the previous value
      if (kv.lagMs && putAt.has(key) && Date.now() - putAt.get(key) < kv.lagMs) v = prev.has(key) ? prev.get(key) : null;
      if (v == null) return null;
      const t = typeof type === 'string' ? type : type && type.type;
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      if (kv.failPut) throw new Error('KV put failed');
      if (typeof value !== 'string') throw new Error('test KV expects string values');
      kv.writes++; kv.log.push(key);
      prev.set(key, map.has(key) ? map.get(key) : null); putAt.set(key, Date.now());
      map.set(key, value);
    },
  };
  return kv;
}

// ---------------------------------------------------------------------------
// --serve mode
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--serve')) {
  const port = +args[args.indexOf('--serve') + 1] || 8787;
  const lag = args.includes('--lag') ? +args[args.indexOf('--lag') + 1] || 0 : 0;
  serve(port, lag);
} else {
  await runTests();
}

function serve(port, lag) {
  let kv = makeKV({ lagMs: lag });
  const env = () => ({ BOARD: kv });
  const stallHits = {};
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-expose-headers': 'content-length' };
  const sendJSON = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)); };
  const fileFor = q => { const p = path.resolve(ROOT, (q.get('src') || '').replace(/^\/+/, '')); if (!p.startsWith(ROOT) || !fs.existsSync(p)) return null; return fs.readFileSync(p); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    try {
      if (p.startsWith('/__test/')) {
        if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
        if (p.startsWith('/__test/portal')) { // captive portal: 200 + HTML for everything
          res.writeHead(200, { 'content-type': 'text/html', ...CORS });
          return res.end('<!doctype html><html><body><h1>Store Guest Wi-Fi</h1><p>Accept the terms to continue.</p></body></html>');
        }
        if (p.startsWith('/__test/hang')) { setTimeout(() => { try { res.destroy(); } catch { /* ignore */ } }, 30000); return; }
        if (p === '/__test/reset') { kv = makeKV({ lagMs: +(url.searchParams.get('lag') || lag) }); for (const k of Object.keys(stallHits)) delete stallHits[k]; return sendJSON(res, { ok: true }); }
        if (p === '/__test/lag') { kv.lagMs = +(url.searchParams.get('ms') || 0); return sendJSON(res, { ok: true, lagMs: kv.lagMs }); }
        if (p === '/__test/stats') return sendJSON(res, { ok: true, writes: kv.writes, reads: kv.reads, keys: [...kv.map.keys()], stallHits, boards: Object.fromEntries([...kv.map].map(([k, v]) => [k, JSON.parse(v).length])) });
        if (p.startsWith('/__test/stall/')) {
          // 1st request per name: headers + first 4 KB, then silence (never finishes). Later requests: the whole file.
          const name = p.slice('/__test/stall/'.length); const buf = fileFor(url.searchParams);
          if (!buf) return sendJSON(res, { ok: false, error: 'no src' }, 404);
          stallHits[name] = (stallHits[name] || 0) + 1;
          res.writeHead(200, { 'content-type': 'image/webp', 'content-length': buf.length, 'cache-control': 'no-store', ...CORS });
          if (stallHits[name] === 1) { res.write(buf.subarray(0, 4096)); setTimeout(() => { try { res.destroy(); } catch { /* ignore */ } }, 60000); return; }
          return res.end(buf);
        }
        if (p.startsWith('/__test/trickle/')) {
          // Slow but ALWAYS moving: `parts` chunks, `gap` ms apart (total ≫ stall window, each gap < it).
          const name = p.slice('/__test/trickle/'.length); const buf = fileFor(url.searchParams);
          if (!buf) return sendJSON(res, { ok: false, error: 'no src' }, 404);
          stallHits[name] = (stallHits[name] || 0) + 1;
          const parts = +(url.searchParams.get('parts') || 8), gap = +(url.searchParams.get('gap') || 2000);
          res.writeHead(200, { 'content-type': 'image/webp', 'content-length': buf.length, 'cache-control': 'no-store', ...CORS });
          const step = Math.ceil(buf.length / parts); let i = 0;
          const tick = () => { if (res.destroyed) return; res.write(buf.subarray(i * step, (i + 1) * step)); i++; if (i < parts) setTimeout(tick, gap); else res.end(); };
          return tick();
        }
        return sendJSON(res, { ok: false, error: 'unknown test route' }, 404);
      }
      // everything else → the real Worker
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      headers.set('cf-connecting-ip', 'harness-' + Math.floor(Date.now() / 1000)); // rate limiter is unit-tested; don't trip it here
      const request = new Request(url.href, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await worker.fetch(request, env(), { waitUntil() {} });
      const out = {}; response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error('[mock] error', e); try { sendJSON(res, { ok: false, error: 'mock crashed' }, 500); } catch { /* ignore */ }
    }
  });
  server.listen(port, () => console.log(`[mock] worker/worker.js on http://localhost:${port} (kv lag ${lag} ms)`));
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
async function runTests() {
  let pass = 0, failN = 0; const failures = [];
  const ok = (cond, msg) => { if (cond) pass++; else { failN++; failures.push(msg); console.log('  FAIL', msg); } };
  const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  let ipN = 0;
  const NOW = Date.parse('2026-09-26T15:00:00Z'); // 10:00 CDT, Chicago date 2026-09-26
  const mkEnv = (kv, now = NOW) => ({ BOARD: kv, NOW_MS: String(now) });
  async function call(env, method, p, body, { ip, raw, headers = {} } = {}) {
    const init = { method, headers: { 'cf-connecting-ip': ip || 'ip-' + (++ipN), ...headers } };
    if (body !== undefined) init.body = raw ? body : JSON.stringify(body);
    const res = await worker.fetch(new Request('https://wcd.test' + p, init), env, { waitUntil() {} });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const base = (o = {}) => ({ name: 'Jeff B', district: 'North Side', charId: 'rocco', parkId: 'wrigley', mode: 'free', date: '2026-09-26', score: 4200, homers: 6, longest: 452, bestStreak: 3, pitches: 18, v: D.VERSION, ...o });
  const section = t => console.log('\n# ' + t);

  section('ping / CORS / routing');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    let r = await call(env, 'GET', '/ping');
    eq(r.json, { ok: true, game: 'windy-city-derby', version: D.VERSION, kv: true }, 'ping payload (version matches data.js)');
    eq(r.headers.get('access-control-allow-origin'), '*', 'ping has CORS *');
    r = await call({}, 'GET', '/ping'); eq(r.json.kv, false, 'ping kv:false without binding');
    r = await call(env, 'OPTIONS', '/submit', undefined, { headers: { origin: 'https://x.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    eq(r.status, 204, 'OPTIONS preflight 204');
    ok(/POST/.test(r.headers.get('access-control-allow-methods') || ''), 'preflight allows POST');
    ok(/content-type/i.test(r.headers.get('access-control-allow-headers') || ''), 'preflight allows content-type');
    eq(r.headers.get('access-control-allow-origin'), '*', 'preflight CORS *');
    r = await call(env, 'GET', '/nope'); eq([r.status, r.json.ok, r.headers.get('access-control-allow-origin')], [404, false, '*'], '404 JSON with CORS');
    r = await call(env, 'GET', '/submit'); eq(r.status, 405, 'GET /submit → 405');
    r = await call(env, 'POST', '/top', {}); eq(r.status, 405, 'POST /top → 405');
    r = await call(env, 'POST', '/submit', base()); eq(r.headers.get('access-control-allow-origin'), '*', 'POST response has CORS');
    r = await call(env, 'POST', '/submit', 'not json {', { raw: true }); eq([r.status, r.json.error], [400, 'bad json'], 'bad JSON → 400');
    r = await call(env, 'POST', '/submit', '[1,2]', { raw: true }); eq(r.status, 400, 'array body → 400');
    r = await call(env, 'POST', '/submit', JSON.stringify({ ...base(), pad: 'x'.repeat(5000) }), { raw: true }); eq(r.status, 413, 'oversized body → 413');
    r = await call(env, 'POST', '/submit', base(), { headers: { 'content-type': 'text/plain;charset=UTF-8' } }); eq(r.json.ok, true, 'text/plain body accepted (no-preflight client path)');
  }

  section('validation');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const bad = async (o, msg) => { const r = await call(env, 'POST', '/submit', base(o)); ok(r.status === 400 && r.json.ok === false, `${msg} → 400 (got ${r.status} ${r.text})`); };
    const good = async (o, msg) => { const r = await call(env, 'POST', '/submit', base(o)); ok(r.status === 200 && r.json.ok === true, `${msg} → 200 (got ${r.status} ${r.text})`); return r; };
    await bad({ name: 'J' }, 'name 1 char'); await bad({ name: '!!@@##' }, 'name empty after sanitizing'); await bad({ name: 'A!' }, 'name 1 char after sanitizing');
    await bad({ name: 'x'.repeat(17) }, 'name 17 chars'); await bad({ name: 42 }, 'name not a string');
    let r = await good({ name: "  Zoë  O'Neil-Jr.  " }, 'accents / punctuation sanitized');
    eq(r.json.name, "Zoe O'Neil-Jr.", 'sanitized name echoed');
    await good({ name: 'x'.repeat(16) }, 'name 16 chars');
    for (const c of D.CHARACTERS) await good({ charId: c.id, name: 'Char ' + c.id }, `charId ${c.id} (from data.js)`);
    await bad({ charId: 'fox' }, 'unknown charId'); await bad({ charId: 'Rocco' }, 'charId case-sensitive');
    for (const p of D.PARK_IDS) await good({ parkId: p, name: 'Park ' + p }, `parkId ${p} (from data.js)`);
    await bad({ parkId: 'fenway' }, 'unknown parkId');
    for (const d of D.DISTRICTS) await good({ district: d, name: 'D ' + d.slice(0, 10) }, `district ${d} (from data.js)`);
    await good({ district: '', name: 'No District' }, 'empty district'); await good({ district: 'big south', name: 'Lower Case' }, 'district case-insensitive');
    await bad({ district: 'Gold Coast' }, 'unknown district');
    await bad({ score: 12.5 }, 'non-integer score'); await bad({ score: -1 }, 'negative score'); await bad({ score: '4200' }, 'string score');
    await bad({ score: 60001, homers: 60, longest: 500 }, 'score > 60000'); await good({ score: 60000, homers: 60, longest: 500, bestStreak: 20, name: 'Max Score' }, 'score 60000');
    await bad({ homers: 61 }, 'homers 61'); await bad({ longest: 621 }, 'longest 621'); await good({ longest: 620, name: 'Max Long' }, 'longest 620');
    await bad({ score: 6 * 3200 + 201 }, 'implausible score (> homers*3200+200)'); await good({ score: 6 * 3200 + 200, name: 'Edge Score' }, 'score == homers*3200+200');
    await bad({ homers: 0, longest: 400, score: 0, bestStreak: 0 }, 'longest>0 with 0 homers'); await bad({ homers: 2, longest: 0, score: 800 }, 'homers>0 with longest 0');
    await good({ homers: 0, longest: 0, score: 0, bestStreak: 0, name: 'Zero Round' }, 'zero round');
    await bad({ score: 201, homers: 0, longest: 0, bestStreak: 0 }, 'score 201 with 0 homers');
    await bad({ bestStreak: 7 }, 'bestStreak > homers'); await bad({ pitches: -3 }, 'negative pitches');
    await bad({ mode: 'ranked' }, 'unknown mode');
  }

  section('daily date window (America/Chicago)');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const d = async (date, want, msg, e = env) => { const r = await call(e, 'POST', '/submit', base({ mode: 'daily', date, name: 'Daily ' + date.slice(5) })); eq(r.status, want, msg); };
    await d('2026-09-26', 200, 'today OK'); await d('2026-09-25', 200, 'yesterday OK'); await d('2026-09-27', 200, 'tomorrow OK');
    await d('2026-09-24', 400, '2 days ago rejected'); await d('2026-09-28', 400, '2 days ahead rejected');
    await d('2026-02-31', 400, 'impossible date rejected'); await d('09/26/2026', 400, 'bad format rejected');
    // 23:30 CDT on 9/26 = 04:30Z on 9/27: Chicago "today" is still 9/26
    const late = mkEnv(makeKV(), Date.parse('2026-09-27T04:30:00Z'));
    await d('2026-09-25', 200, 'late-night Chicago: 9/25 still inside window', late);
    await d('2026-09-28', 400, 'late-night Chicago: 9/28 (UTC tomorrow+1) rejected', late);
    const r = await call(env, 'POST', '/submit', base({ mode: 'free', date: '1999-01-01', name: 'Free Old' }));
    eq(r.status, 200, 'free mode ignores date');
  }

  section('ranking, ties, boards');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const sub = async (name, score, extra = {}) => (await call(env, 'POST', '/submit', base({ name, score, ...extra }))).json;
    let j = await sub('Alpha', 5000); eq([j.rank, j.boards.alltime], [1, 1], 'first player rank 1');
    j = await sub('Bravo', 7000, { longest: 480 }); eq(j.rank, 1, 'Bravo takes #1');
    env.NOW_MS = String(NOW + 1000);
    j = await sub('Charlie', 5000, { longest: 430 }); eq(j.rank, 2, 'Charlie ties Alpha → rank 2');
    j = await sub('Delta', 3000, { longest: 490 }); eq([j.rank, j.boards.longest], [4, 1], 'Delta rank 4 (competition ranking), longest #1');
    let t = await call(env, 'GET', '/top?board=alltime');
    eq(t.json.rows.map(r => [r.rank, r.name]), [[1, 'Bravo'], [2, 'Alpha'], [2, 'Charlie'], [4, 'Delta']], 'alltime order: ties share rank, earlier achiever first');
    ok(t.json.rows.every(r => ['rank', 'name', 'score', 'homers', 'longest', 'charId', 'parkId', 'district', 'updated'].every(k => k in r)), 'rows have the contract fields');
    eq(t.headers.get('cache-control'), 'public, max-age=10', '/top cache-control max-age=10');
    t = await call(env, 'GET', '/top?board=longest');
    eq(t.json.rows.map(r => [r.rank, r.name, r.longest]), [[1, 'Delta', 490], [2, 'Bravo', 480], [3, 'Alpha', 452], [4, 'Charlie', 430]], 'longest board ranks by longest');
    j = await sub('alpha', 9000); eq(j.rank, 1, 'improvement (name key is case-insensitive) → #1');
    t = await call(env, 'GET', '/top?board=alltime');
    eq(t.json.rows.map(r => r.name), ['alpha', 'Bravo', 'Charlie', 'Delta'], 'one row per lowercased name; display name updated');
    t = await call(env, 'GET', '/top?board=alltime&limit=2'); eq(t.json.rows.length, 2, 'limit respected');
    t = await call(env, 'GET', '/top?board=alltime&limit=5000'); eq(t.json.rows.length, 4, 'limit clamped');
    t = await call(env, 'GET', '/top?board=today'); eq([t.status, t.json.rows.length, t.json.date], [200, 0, '2026-09-26'], 'free-mode rounds are not on today\'s daily board; default date = Chicago today');
    t = await call(env, 'GET', '/top?board=weekly'); eq(t.status, 400, 'unknown board → 400');
    t = await call(env, 'GET', '/top?board=today&date=2026-13-01'); eq(t.status, 400, 'bad date → 400');
    // daily board
    j = await sub('Echo', 6000, { mode: 'daily', date: '2026-09-26' }); eq([j.rank, j.boards.today, j.boards.alltime], [1, 1, 3], 'daily submit returns today rank as rank');
    j = await sub('Fox', 6500, { mode: 'daily', date: '2026-09-25' });
    t = await call(env, 'GET', '/top?board=today&date=2026-09-26'); eq(t.json.rows.map(r => r.name), ['Echo'], 'daily boards are per date');
    t = await call(env, 'GET', '/top?board=daily&date=2026-09-25'); eq(t.json.rows.map(r => r.name), ['Fox'], "'daily' alias for today board");
  }

  section('district filter');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const rows = [['Amy', 9000, 'Big South'], ['Ben', 8000, 'North Side'], ['Cal', 7000, 'Big South'], ['Dee', 6000, ''], ['Eve', 5000, 'Big South']];
    for (const [name, score, district] of rows) await call(env, 'POST', '/submit', base({ name, score, district }));
    let t = await call(env, 'GET', '/top?board=alltime&district=Big%20South');
    eq(t.json.rows.map(r => [r.rank, r.name]), [[1, 'Amy'], [2, 'Cal'], [3, 'Eve']], 'district filter ranks within district');
    eq(t.json.district, 'Big South', 'district echoed canonically');
    t = await call(env, 'GET', '/top?board=alltime&district=big%20south'); eq(t.json.rows.length, 3, 'district filter case-insensitive');
    t = await call(env, 'GET', '/top?board=alltime&district=Nowhere'); eq(t.status, 400, 'unknown district → 400');
    t = await call(env, 'GET', '/top?board=alltime&district='); eq(t.json.rows.length, 5, 'empty district = everyone');
  }

  section('write avoidance (KV free tier)');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const w0 = () => kv.writes;
    let before = w0(); await call(env, 'POST', '/submit', base({ name: 'Writer', score: 5000, longest: 450 }));
    eq(w0() - before, 2, 'first free-mode submit writes alltime + longest (2)');
    before = w0(); await call(env, 'POST', '/submit', base({ name: 'Writer', score: 4000, longest: 440 }));
    eq(w0() - before, 0, 'worse score + worse longest → 0 writes');
    before = w0(); await call(env, 'POST', '/submit', base({ name: 'writer', score: 5000, longest: 450 }));
    eq(w0() - before, 0, 'identical score → 0 writes');
    before = w0(); const r1 = await call(env, 'POST', '/submit', base({ name: 'Writer', score: 4800, longest: 470 }));
    eq([w0() - before, kv.log.at(-1)], [1, 'longest'], 'better longest only → 1 write (longest)');
    eq(r1.json.improved, { alltime: false, today: false, longest: true }, 'improved flags');
    before = w0(); await call(env, 'POST', '/submit', base({ name: 'Writer', score: 0, homers: 0, longest: 0, bestStreak: 0 }));
    eq(w0() - before, 0, 'zero round → 0 writes (never touches longest)');
    before = w0(); await call(env, 'POST', '/submit', base({ name: 'Daily Guy', mode: 'daily', date: '2026-09-26' }));
    eq(w0() - before, 3, 'first daily submit writes alltime + daily + longest (3)');
    before = w0(); await call(env, 'POST', '/submit', base({ name: 'Daily Guy', mode: 'daily', date: '2026-09-26', score: 100, longest: 300 }));
    eq(w0() - before, 0, 'worse daily → 0 writes');
    // full board (100 rows): below the cut → 0 writes, rank null; above the cut → 1 write, stays at 100
    const kv2 = makeKV(); const env2 = mkEnv(kv2);
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, score: 1000 + i * 10, homers: 5, longest: 400, charId: 'nova', parkId: 'rate', district: '', updated: NOW - 1e6 + i }));
    kv2.map.set('alltime', JSON.stringify(full)); kv2.map.set('longest', JSON.stringify(full));
    before = kv2.writes; let r = await call(env2, 'POST', '/submit', base({ name: 'Too Low', score: 1000, longest: 400 }));
    eq([kv2.writes - before, r.json.boards.alltime, r.json.boards.longest], [0, null, null], 'below the 100-row cut (tie with last) → 0 writes, rank null');
    before = kv2.writes; r = await call(env2, 'POST', '/submit', base({ name: 'Just In', score: 1005, longest: 400 }));
    eq([kv2.writes - before, r.json.boards.alltime], [1, 100], 'just above the cut → 1 write, rank 100');
    eq(JSON.parse(kv2.map.get('alltime')).length, 100, 'board capped at 100 rows');
    ok(!JSON.parse(kv2.map.get('alltime')).some(x => x.id === 'p0'), 'lowest row evicted');
    const size = kv2.map.get('alltime').length; ok(size < 25000, `one board value is small (${size} bytes)`);
  }

  section('KV failures + eventual consistency');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    await call(env, 'POST', '/submit', base({ name: 'Keeper', score: 5000 }));
    kv.failGet = true; let before = kv.writes;
    let r = await call(env, 'POST', '/submit', base({ name: 'Newbie', score: 9000 }));
    eq([r.status, r.json.retry, kv.writes - before], [503, true, 0], 'KV read failure → 503 retry, never overwrites a board it could not read');
    r = await call(env, 'GET', '/top?board=alltime'); eq(r.status, 503, '/top KV failure → 503');
    kv.failGet = false; kv.failPut = true;
    r = await call(env, 'POST', '/submit', base({ name: 'Newbie', score: 9000 })); eq([r.status, r.json.retry], [503, true], 'KV write failure → 503 retry');
    kv.failPut = false;
    kv.map.set('longest', '{corrupt'); r = await call(env, 'POST', '/submit', base({ name: 'Fixer', score: 100, longest: 350, homers: 1, bestStreak: 1 }));
    eq([r.status, r.json.boards.longest], [200, 1], 'corrupted board value → treated as empty, rebuilt');
    // lagging KV: reads return the stale value for a while after a write
    const lag = makeKV({ lagMs: 60000 }); const envL = mkEnv(lag);
    r = await call(envL, 'POST', '/submit', base({ name: 'Lag One', score: 3000 })); eq([r.status, r.json.rank], [200, 1], 'lagging KV: first submit ok');
    r = await call(envL, 'POST', '/submit', base({ name: 'Lag Two', score: 4000 })); eq([r.status, r.json.ok], [200, true], 'lagging KV: read-back lag never errors');
    r = await call(envL, 'GET', '/top?board=alltime'); eq(r.status, 200, 'lagging KV: /top still 200');
  }

  section('rate limit');
  {
    const kv = makeKV(); const env = mkEnv(kv);
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await call(env, 'POST', '/submit', base({ name: 'Spammer', score: i }), { ip: '9.9.9.9' })).status);
    eq([codes.slice(0, 20).every(c => c === 200), codes[20]], [true, 429], '21st submit in a minute from one IP → 429');
    const other = await call(env, 'POST', '/submit', base({ name: 'Neighbor' }), { ip: '8.8.8.8' }); eq(other.status, 200, 'other IP unaffected');
    const reads = await call(env, 'GET', '/top?board=alltime', undefined, { ip: '9.9.9.9' }); eq(reads.status, 200, 'reads not rate-limited');
  }

  section('data.js sync');
  {
    const src = fs.readFileSync(path.join(ROOT, 'worker/worker.js'), 'utf8');
    const arr = n => JSON.parse(src.match(new RegExp(`const ${n} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
    eq(arr('CHAR_IDS'), D.CHARACTERS.map(c => c.id), 'CHAR_IDS == data.js CHARACTERS');
    eq(arr('PARK_IDS'), D.PARK_IDS, 'PARK_IDS == data.js');
    eq(arr('DISTRICTS'), D.DISTRICTS, 'DISTRICTS == data.js');
    ok(src.includes(`const VERSION = '${D.VERSION}'`), 'VERSION == data.js');
    ok(/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(D.BOARD_ENDPOINT), 'BOARD_ENDPOINT looks like a workers.dev URL');
  }

  console.log(`\n${failN ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${failN} failed`);
  if (failN) { console.log(failures.map(f => ' - ' + f).join('\n')); process.exit(1); }
}
