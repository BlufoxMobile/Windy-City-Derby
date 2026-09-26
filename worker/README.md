# Windy City Derby — leaderboard Worker

One Cloudflare **module Worker** (`worker.js`, self-contained, no build step) plus one **KV namespace** bound as `BOARD`.
The game calls it at `BOARD_ENDPOINT` from `src/data.js`:

```
https://windy-city-derby.jeff-bilbrey-jb.workers.dev
         └─ Worker name ─┘ └─ account workers.dev subdomain ─┘
```

So the Worker **must be named `windy-city-derby`**, on the Cloudflare account whose workers.dev subdomain is
`jeff-bilbrey-jb`. (If the subdomain differs, change `BOARD_ENDPOINT` in `src/data.js` to match.)
The game works fully offline if the Worker is missing: scores are kept on the device and queued, then sent later.

## Deploy — Cloudflare dashboard (no tools needed, ~5 minutes)

1. **Create the KV namespace.** Dashboard → *Storage & Databases* → *KV* → **Create a namespace** →
   name it `windy-city-derby-board` → *Add*.
2. **Create the Worker.** *Compute (Workers)* → *Workers & Pages* → **Create** → *Create Worker* (Start with "Hello World")
   → name it **`windy-city-derby`** → **Deploy**.
3. **Upload the code.** On the new Worker click **Edit code**. Delete everything in `worker.js` in the editor, paste the
   full contents of this folder's `worker.js`, click **Deploy**. (The file uses `export default { fetch }`, so the
   editor treats it as an ES module — nothing to configure.)
4. **Bind KV as `BOARD`.** Worker → *Settings* → *Bindings* → **Add** → *KV namespace* →
   Variable name **`BOARD`** (exactly, uppercase) → KV namespace `windy-city-derby-board` → **Save/Deploy**.
5. **Check it.** Open `https://windy-city-derby.jeff-bilbrey-jb.workers.dev/ping` — you should see
   `{"ok":true,"game":"windy-city-derby","version":"1.0.0","kv":true}`.
   `"kv":false` means step 4 didn't take (wrong variable name or not redeployed).

## Deploy — wrangler (CLI alternative)

```bash
npm i -g wrangler && wrangler login
wrangler kv namespace create BOARD          # prints: id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

`worker/wrangler.toml`:

```toml
name = "windy-city-derby"
main = "worker.js"
compatibility_date = "2024-09-23"
workers_dev = true

[[kv_namespaces]]
binding = "BOARD"
id = "PASTE_THE_ID_FROM_ABOVE"
```

```bash
cd worker && wrangler deploy
curl https://windy-city-derby.jeff-bilbrey-jb.workers.dev/ping
```

## API

| | |
|---|---|
| `GET /ping` | `{ok, game:'windy-city-derby', version, kv}` |
| `GET /top?board=today\|alltime\|longest&date=YYYY-MM-DD&district=&limit=25` | `{ok, board, date, district, rows:[{rank,name,score,homers,longest,charId,parkId,district,updated}]}` · `cache-control: public, max-age=10` · `today` = the daily-challenge board for `date` (default: today in Chicago) · ranks are "1, 2, 2, 4" (ties share a rank; earlier achiever listed first) · `district` filter ranks within the district |
| `POST /submit` | body `{name, district, charId, parkId, mode, date, score, homers, longest, bestStreak, pitches, v}` → `{ok, rank, boards:{alltime,today,longest}, improved:{…}, name, date}` (`rank` = today's rank for daily rounds, else all-time; `null` = not on that board) |

Errors are JSON `{ok:false, error}` with CORS headers: `400` validation / bad JSON, `404`, `405`, `413` body > 4 KB,
`429` rate limit (20 submits/min/IP, best-effort per isolate), `503 {retry:true}` KV read/write failure (the client
queues and re-sends — submissions are idempotent).

**Validation:** name 2–16 chars after stripping everything except letters/digits/space/`.'-` (accents are folded:
"Zoë" → "Zoe"); `charId` ∈ rocco jett dex blaze nova skye; `parkId` ∈ wrigley rate; `district` ∈ North Side, South Side,
East Side, West Side, Big South or empty (case-insensitive); integers `score` 0–60000, `homers` 0–60, `longest` 0–620;
`score ≤ homers×3200+200`; `longest > 0` exactly when `homers > 0`; daily rounds must be dated within ±1 day of
today's America/Chicago date.

## Storage + free-tier budget

- KV keys: `alltime`, `longest`, `daily:YYYY-MM-DD` — each is ONE JSON array, max 100 rows, one row per player
  (keyed by lowercased name, keeps their best).
- A board is written **only when the submission changes it** (a new personal best that makes the top 100). A worse or
  equal round costs 0 writes. A first daily round costs 3 writes; typical play is 0–2. Free tier = 1,000 writes/day,
  100,000 reads/day (each submit reads 2–3 keys, each `/top` reads 1).
- Old `daily:` keys are tiny and harmless; delete them in the dashboard (KV → namespace → keys) if you ever want to.
- There is deliberately **no admin/reset endpoint**. To remove a row or reset a board, edit/delete the key in the
  dashboard KV browser (the value is plain JSON).

## Known limits

- KV is eventually consistent (up to ~60 s between locations). The Worker never reads back what it just wrote — ranks
  in the `/submit` response come from the board it just computed — and the game client patches the player's own
  fresh row into `/top` results for a few minutes, so nobody sees their score "missing".
- Two players finishing within the same second on different Cloudflare locations can race (last write wins; the
  other's row reappears on their next personal best). Fine for a company game; a Durable Object would be the fix
  if it ever matters.

## Tests

```bash
node tools/worker-test.mjs              # unit tests: validation, ranking/ties, district filter, daily window,
                                        # write-avoidance, CORS/OPTIONS, bad JSON, KV failures, rate limit
node tools/worker-test.mjs --serve 8787 # run this Worker locally (in-memory KV) for tools/harness/net.html
```
