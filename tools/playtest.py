#!/usr/bin/env python3
"""Headless play-through of the integrated game (dev.html) that SWINGS WITH REAL INPUT.

  flock /tmp/wcd-render.lock timeout 600 python3 tools/playtest.py --park wrigley --char rocco --homers 5 --out scratch/pt \
        [--swing swipe|button|mouse|key] [--speed 0.95] [--noise 0.0] [--w 390 --h 844] [--warp 1] [--quality low] \
        [--cond night,clear,18,0] [--seed 123] [--mode free|daily] [--build]

Every swing is a trusted browser input event dispatched through CDP (Input.dispatchTouchEvent / dispatchMouseEvent /
dispatchKeyEvent) — never window.__wcd.debugSwing. CDP's `timestamp` field sets each event's timeStamp exactly, so a
swipe's kinematics (speed, angle, start time) are precise even though headless SwiftShader renders at a few fps:
  * swipe: finger lands, holds (sub-pixel jitter) and then moves at a constant speed that maps to --speed through
    ui.js SWIPE (v = vMax · b^(1/gamma) short-sides/s), natural direction for the hitter, angled for the ideal
    uppercut, starting in the aim lane for the ideal aim. Its START is timed for a perfect swing at that bat speed.
  * button: the SWING button is pressed at the perfect moment (aim lanes tapped first); mouse: the same swipe with
    the mouse; key: space (shift = max effort).
The first --homers pitches are swung perfectly (± --noise s); after that the bot swings way early for quick outs.
Checks (printed, exit 3 on failure): each swing event's batSpeed ≈ requested (±0.06), its start t ≈ the swipe's first
movement (±3 ms), recognition latency, the first swipe during the coach mark is not swallowed.
Takes screenshots at key moments; prints console errors; exits 2 on page errors.
"""
import asyncio, argparse, json, os, sys, time, random, math
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--park', default='wrigley'); ap.add_argument('--char', default='nova')
ap.add_argument('--homers', type=int, default=3, help='perfect swings before making quick outs')
ap.add_argument('--out', default='scratch/pt'); ap.add_argument('--w', type=int, default=390); ap.add_argument('--h', type=int, default=844)
ap.add_argument('--warp', type=float, default=3, help='game speed between pitches (fast-forward)')
ap.add_argument('--pitch-warp', type=float, default=0.18, help='game speed from the windup to contact (CDP input needs the time)')
ap.add_argument('--no-coach-shot', action='store_true', help="don't let pitch 1 go by to photograph the coach mark")
ap.add_argument('--build', action='store_true', help='use dist/index.html instead of dev.html')
ap.add_argument('--mode', default='free'); ap.add_argument('--timeout', type=int, default=900)
ap.add_argument('--swing', default='swipe', choices=['swipe', 'button', 'mouse', 'key'])
ap.add_argument('--speed', type=float, default=0.9, help='bat speed to swipe at (0..1)')
ap.add_argument('--noise', type=float, default=0.0, help='timing noise sigma (s) on the scripted swings')
ap.add_argument('--quality', default='low'); ap.add_argument('--cond', default=None); ap.add_argument('--seed', default=None)
ap.add_argument('--shots', default='all', help="'all' or 'min'")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
base = 'http://localhost:8765/dist/index.html' if a.build else 'http://localhost:8765/dev.html'
url = f"{base}?autoplay={a.mode}&debug&warp={a.warp}&dtmax=0.35&park={a.park}&char={a.char}&name=Tester"
if a.cond: url += f"&cond={a.cond}"
if a.seed: url += f"&seed={a.seed}"

JS_STATE = """(()=>{const G=window.__wcd;if(!G)return null;const r=G.round;return {state:G.state,pitchN:r&&r.pitchCount,outs:r&&r.outs,hr:r&&r.homers,
 score:r&&r.score,over:r&&r.over,swung:!!G.swung,armed:!!G.armed,kind:G.result&&G.result.kind,oop:!!(G.result&&G.result.outOfPark),dist:G.result&&G.result.distance,
 homerCam:G.homerCamAt!=null,tau:G.tau,timer:G.timer,shot:G.director&&G.director.shotName,wave:!!(G.post&&G.post.waveOn),
 coach:!!document.querySelector('.coach.show'),bc:!!document.querySelector('.bc-oop'),bw:!!document.querySelector('.bc-wave'),booth:!!(G.booth&&G.booth.showing)}})()"""

# Plan the perfect swing for the live pitch: waits (in page) for the pitch to be in flight, then returns the page-clock
# time (performance.now() ms) the swing must START for zero timing error at bat speed b, plus aim/uppercut/geometry.
JS_PLAN = """async ([b, noise, mode]) => {
  const G = window.__wcd; const S = await import('/src/sim.js'); const D = await import('/src/data.js'); const U = await import('/src/ui.js');
  const W = innerWidth, H = innerHeight;
  // wait until just before the perfect swing START, then FREEZE the game clock (G.freeze) so slow CDP input can land
  const p0 = G.pitch; const Tstar0 = p0 ? S.perfectTap(p0, b) + noise : 0;
  await new Promise(r => { const iv = setInterval(() => {
    if (!G.pitch || G.pitch !== p0 || G.swung || G.state === 'result' || (G.state === 'pitch' && G.pt >= Tstar0 - 0.03)) { clearInterval(iv); if (G.state === 'pitch' && G.pitch === p0 && !G.swung) G.freeze(true); r(); }
  }, 2); });
  if (G.state !== 'pitch' || G.swung || G.pitch !== p0) return null;
  const p = G.pitch, ch = D.CHAR_BY_ID[G.charId];
  const Tstar = Tstar0;
  const warp = G.warp ? G.warp() : +(new URLSearchParams(location.search).get('warp') || 1);
  const rate = G.stamp.rate || 1;
  const tStart = G.stamp.real + (Tstar - G.stamp.pt) / (warp * rate) * 1000;
  const aim = S.idealAim(ch, p.plateLoc[0], p.type), up = S.idealUppercut(ch, p.plateLoc[1], p.type);
  const Ssz = Math.min(Math.max(Math.min(W, H), U.SWIPE.scaleMin), U.SWIPE.scaleMax);
  const vS = U.SWIPE.vMax * Math.pow(Math.max(0.02, b), 1 / U.SWIPE.gamma);      // short sides per second
  const vpx = vS * Ssz / 1000;                                                  // px per ms
  const angDeg = up === 0 ? 0 : Math.sign(up) * (U.SWIPE.upDead + Math.abs(up) * (U.SWIPE.upFull - U.SWIPE.upDead));
  const x0 = W * (0.5 + 0.44 * aim);
  const btn = document.querySelector('.swing-btn')?.getBoundingClientRect();
  const seg = [...document.querySelectorAll('.aim-seg button')].map(e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  return { tStart, now: G.frozenAt, origin: performance.timeOrigin, aim, up, angDeg, vpx, x0, y0: H * 0.8, dir: ch.bats === 'L' ? -1 : 1,
    n: p.n, Tstar, W, H, btn: btn ? [btn.x + btn.width / 2, btn.y + btn.height / 2] : null, seg, lane: aim < -1/3 ? 0 : aim > 1/3 ? 2 : 1, bats: ch.bats };
}"""

async def main():
    errs = []; shots = set(); checks = []; t0 = time.time()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'])
        ctx = await b.new_context(viewport={'width': a.w, 'height': a.h}, has_touch=True, device_scale_factor=1)
        await ctx.add_init_script(f"""try{{localStorage.setItem('wcd-settings', JSON.stringify({{sound:true,music:true,haptics:false,quality:'{a.quality}',swing:'{'button' if a.swing == 'button' else 'swipe'}'}}));localStorage.removeItem('wcd-coach-v2');}}catch(e){{}}""")
        pg = await ctx.new_page()
        cdp = await ctx.new_cdp_session(pg)
        def con(m):
            t = m.text
            if m.type in ('error', 'warning') and 'GL_INVALID' not in t and 'GPU stall' not in t: print(f'[{m.type}]', t[:300])
            if '[swing]' in t or 'unhandled' in t or '[oop cue]' in t: print('  ', t[:260])
            if m.type == 'error': errs.append(t)
        pg.on('console', con)
        pg.on('pageerror', lambda e: (errs.append(str(e)), print('[PAGEERROR]', str(e)[:500])))
        await pg.goto(url, wait_until='load', timeout=60000)

        async def shot(name, force=False):
            if name in shots and not force: return
            if a.shots == 'min' and not name.startswith(('00', '05', '06', '08', '09')): return
            shots.add(name)
            # freeze the game clock while SwiftShader captures (slow) so the moment photographed is the moment asked for
            was = await pg.evaluate("(()=>{const G=window.__wcd;if(!G||!G.freeze)return true;const w=!!G.frozen;G.freeze(true);return w})()")
            try: await pg.screenshot(path=f'{a.out}/{name}.png')
            finally:
                if not was: await pg.evaluate("window.__wcd&&window.__wcd.freeze&&window.__wcd.freeze(false)")
            print('  shot', name, f'{time.time() - t0:.0f}s')

        def ts(origin, ms): return (origin + ms) / 1000.0
        async def touch(kind, pts, stamp):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y} for x, y in pts], 'timestamp': stamp})
        async def swipe(plan, t_start):
            """finger down at t_start-40ms, sub-pixel jitter at t_start, then constant speed every 8 ms for ~0.34 W"""
            o = plan['origin']; vx = plan['vpx'] * math.cos(math.radians(plan['angDeg'])) * plan['dir']; vy = -plan['vpx'] * math.sin(math.radians(plan['angDeg']))
            x0 = max(12, min(plan['W'] - 12, plan['x0'])); y0 = plan['y0']
            L = min(0.34 * plan['W'], (plan['W'] - 10 - x0) if plan['dir'] > 0 else (x0 - 10)); L = max(L, 60)
            dur = L / max(0.05, plan['vpx']); steps = max(4, min(9, int(dur / 8)))   # few events: CDP input is slow headless
            if a.swing == 'mouse':
                await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x0, 'y': y0, 'timestamp': ts(o, t_start - 80)})
                await cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x0, 'y': y0, 'button': 'left', 'clickCount': 1, 'timestamp': ts(o, t_start - 40)})
                await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x0 + 0.4, 'y': y0, 'button': 'left', 'buttons': 1, 'timestamp': ts(o, t_start)})
                for k in range(1, steps + 1):
                    await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x0 + vx * 8 * k, 'y': y0 + vy * 8 * k, 'button': 'left', 'buttons': 1, 'timestamp': ts(o, t_start + 8 * k)})
                await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x0 + vx * 8 * steps, 'y': y0 + vy * 8 * steps, 'button': 'left', 'clickCount': 1, 'timestamp': ts(o, t_start + 8 * steps + 6)})
            else:
                await touch('touchStart', [(x0, y0)], ts(o, t_start - 40))
                await touch('touchMove', [(x0 + 0.4, y0)], ts(o, t_start))
                for k in range(1, steps + 1): await touch('touchMove', [(x0 + vx * 8 * k, y0 + vy * 8 * k)], ts(o, t_start + 8 * k))
                await touch('touchEnd', [], ts(o, t_start + 8 * steps + 6))
        async def press_button(plan, t_start):
            o = plan['origin']
            if plan['seg']:
                sx, sy = plan['seg'][plan['lane']]
                await touch('touchStart', [(sx, sy)], ts(o, t_start - 300)); await touch('touchEnd', [], ts(o, t_start - 260))
            bx, by = plan['btn']
            await touch('touchStart', [(bx, by)], ts(o, t_start)); await touch('touchEnd', [], ts(o, t_start + 70))
        async def key_swing(plan, t_start):
            o = plan['origin']; mods = 8 if a.speed >= 0.99 else 0
            await cdp.send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': ' ', 'code': 'Space', 'windowsVirtualKeyCode': 32, 'modifiers': mods, 'text': ' ', 'timestamp': ts(o, t_start)})
            await cdp.send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': ' ', 'code': 'Space', 'windowsVirtualKeyCode': 32, 'modifiers': mods, 'timestamp': ts(o, t_start + 60)})

        swings = 0; last_n = -1; plans = {}; intro_tapped = False; result_seen = set()
        while time.time() - t0 < a.timeout:
            st = await pg.evaluate(JS_STATE)
            if not st: await asyncio.sleep(0.4); continue
            s = st['state']
            if s == 'intro':
                await shot('00_intro')
                if not intro_tapped:   # tap to skip — through the real intro overlay
                    intro_tapped = True; now = await pg.evaluate('performance.now()'); o = await pg.evaluate('performance.timeOrigin')
                    await touch('touchStart', [(a.w / 2, a.h * 0.5)], ts(o, now)); await touch('touchEnd', [], ts(o, now + 60))
            if s in ('windup', 'pitch') and not st['swung'] and st['pitchN'] is not None and st['pitchN'] != last_n:
                n = st['pitchN']; last_n = n
                await pg.evaluate(f"window.__wcd.setWarp({a.pitch_warp})")
                if n == 1 and not a.no_coach_shot and a.shots == 'all':
                    # let the first pitch go by: photograph the coach mark + the pitch in flight (a take — no swing)
                    await pg.evaluate("new Promise(r=>{const G=window.__wcd;const iv=setInterval(()=>{if(G.state!=='windup'&&G.state!=='pitch'||(G.state==='pitch'&&G.pt>G.pitch.flightTime*0.4)){clearInterval(iv);G.freeze(true);r()}},5)})")
                    await pg.evaluate("window.__wcd.freeze(false)||true"); await pg.wait_for_timeout(60); await pg.evaluate("window.__wcd.freeze(true)")
                    await shot('01_pitch_coach'); await pg.evaluate("window.__wcd.freeze(false)"); continue
                if swings < a.homers:
                    bs = 0.72 if a.swing == 'button' or (a.swing == 'key' and a.speed < 0.99) else (1.0 if a.swing == 'key' else a.speed)
                    noise = random.gauss(0, a.noise) if a.noise else 0
                    plan = await pg.evaluate(JS_PLAN, [bs, noise, a.swing])
                    if not plan: print(f'pitch {n}: missed the window'); continue
                    lag = plan['now'] - plan['tStart']      # (the game clock is frozen until the swing registers)
                    if a.swing in ('swipe', 'mouse'): await swipe(plan, plan['tStart'])
                    elif a.swing == 'button': await press_button(plan, plan['tStart'])
                    else: await key_swing(plan, plan['tStart'])
                    await pg.evaluate("new Promise(r=>{const G=window.__wcd;const t0=performance.now();const iv=setInterval(()=>{if(G.swung||performance.now()-t0>8000){clearInterval(iv);G.freeze(false);r()}},5)})")
                    plans[n] = {**plan, 'bs': bs, 'noise': noise, 'lagMs': round(lag, 1)}
                    done_ms = (await pg.evaluate('performance.now()')) - plan['tStart']
                    print(f"  plan p{n}: start in {-lag:.0f} ms (page clock), input dispatched by {done_ms:+.0f} ms, b={bs:.2f} aim={plan['aim']:+.2f} up={plan['up']:+.2f}")
                    swings += 1
                else:
                    # quick out: swing way early as soon as input is armed (during the windup) — clock frozen meanwhile
                    await pg.evaluate("new Promise(r=>{const G=window.__wcd;const iv=setInterval(()=>{if(G.armed||G.state!=='windup'){clearInterval(iv);if(G.state==='windup')G.freeze(true);r()}},2)})")
                    now = await pg.evaluate('window.__wcd.frozen ? window.__wcd.frozenAt : performance.now()'); o = await pg.evaluate('performance.timeOrigin')
                    if a.swing == 'button':
                        bxy = await pg.evaluate("(()=>{const r=document.querySelector('.swing-btn').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
                        await touch('touchStart', [tuple(bxy)], ts(o, now)); await touch('touchEnd', [], ts(o, now + 50))
                    elif a.swing == 'key':
                        await key_swing({'origin': o}, now)
                    else:
                        await swipe({'origin': o, 'vpx': 1.6, 'angDeg': 0, 'dir': 1, 'x0': a.w * 0.3, 'y0': a.h * 0.8, 'W': a.w}, now)
                    await pg.evaluate("new Promise(r=>{const G=window.__wcd;const t0=performance.now();const iv=setInterval(()=>{if(G.swung||performance.now()-t0>8000){clearInterval(iv);G.freeze(false);r()}},5)})")
                    swings += 1
            if s == 'pitch' and st['swung'] and a.shots == 'all': await shot('03a_swing')
            if s in ('flight', 'result', 'between'):
                w = 1.0 if s == 'flight' or (s == 'result' and (st['pitchN'], st['kind']) not in result_seen) else a.warp if s == 'result' else a.pitch_warp
                await pg.evaluate(f"window.__wcd.warp()!=={w}&&window.__wcd.setWarp({w})")
            if s == 'flight':
                if st['kind'] == 'homer' and not st['homerCam']: await shot('03_follow_homer')
                if st['homerCam'] and not st['oop']: await shot('04_homer_cam')
                if st['oop'] and st['bc']: await shot('04b_oop_callout')
                if st['oop'] and st['homerCam']: await shot('04c_oop_cam')
                if st['kind'] not in ('homer', 'whiff', None): await shot('03b_follow_out')
            if s == 'result':
                key = (st['pitchN'], st['kind'])
                if key not in result_seen:
                    result_seen.add(key)
                    await pg.evaluate("new Promise(r=>{const G=window.__wcd;const t=performance.now();const iv=setInterval(()=>{if(G.state!=='result'||G.timer>1.1||performance.now()-t>4000){clearInterval(iv);r()}},10)})")
                    nm = ('05_result_oop' if st['oop'] else '05_result_homer') if st['kind'] == 'homer' else ('05b_result_' + str(st['kind']))
                    await shot(nm)
                    if st['oop']:
                        await pg.evaluate("new Promise(r=>{const G=window.__wcd;const t=performance.now();const iv=setInterval(()=>{if(G.state!=='result'||G.timer>2.6||performance.now()-t>6000){clearInterval(iv);r()}},10)})")
                        await shot('05c_oop_booth')
                if st['wave']: await shot('08_wave')
            if s == 'over':
                await asyncio.sleep(4); await shot('06_round_over')
                await asyncio.sleep(5); await shot('07_round_over_board'); break
            await asyncio.sleep(0.12)

        # ---------------------------------------------------------------- checks
        log = await pg.evaluate("(window.__wcd&&window.__wcd.swings)||[]")
        last_ui = await pg.evaluate("(()=>{const u=window.__wcd&&window.__wcd.ui;return u&&u.lastSwing})()")
        print('\nSWINGS  n  via      want b  got b   Δt(ms)  err(ms)  lat(ms)  kind     timing     ev    la   dist  oop')
        bad = 0
        for r in log:
            pl = plans.get(r['n'])
            want = pl['bs'] if pl else None
            dt_ms = None
            if pl:
                # tapT the game computed vs. the perfect start (+ requested noise), in game seconds → ms
                dt_ms = (r['tapT'] - (pl['Tstar'])) * 1000
            ok_b = want is None or abs(r['batSpeed'] - want) <= 0.06
            ok_t = dt_ms is None or abs(dt_ms) <= 3.0
            if pl and not (ok_b and ok_t): bad += 1
            print(f"  {'ok ' if ok_b and ok_t else 'BAD'} {r['n']:>2} {r['via']:<7} {('%.2f' % want) if want is not None else '  - '}   {r['batSpeed']:.2f}  {('%+6.1f' % dt_ms) if dt_ms is not None else '    - '}  {r['err'] * 1000:+7.1f}  {str(r.get('latency')):>6}   {r['kind']:<8} {r['timing']:<10} {r.get('ev') or 0:5.1f} {r.get('la') or 0:5.1f} {r.get('dist') or 0:5} {r.get('oop')}")
        planned = len([n for n in plans]); got = len([r for r in log if r['n'] in plans])
        if got < planned: print(f'  BAD {planned - got} planned swing(s) never reached the game (swallowed input?)'); bad += 1
        first = log[0] if log else None
        print(f"\nfirst swing reached the game: {bool(first)} (coach mark was {'shown' if '01_coach_windup' in shots else 'not captured'})")
        st = await pg.evaluate(JS_STATE); print('final', json.dumps(st))
        await b.close()
    print('errors:', len(errs))
    for e in errs[:10]: print('  ', e[:300])
    if errs: sys.exit(2)
    if bad: print(f'{bad} swing check(s) failed'); sys.exit(3)

asyncio.run(main())
