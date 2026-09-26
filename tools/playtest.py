#!/usr/bin/env python3
"""Headless play-through of the integrated game (dev.html) with a scripted batter.
python3 tools/playtest.py --park wrigley --char rocco --homers 4 --out scratch/pt [--w 390 --h 844] [--warp 4] [--build]
Takes screenshots at key moments, prints every console error, exits 2 on page errors.
"""
import asyncio, argparse, json, os, sys, time, random
from playwright.async_api import async_playwright
ap = argparse.ArgumentParser()
ap.add_argument('--park', default='wrigley'); ap.add_argument('--char', default='nova')
ap.add_argument('--homers', type=int, default=3, help='perfect swings before making quick outs')
ap.add_argument('--out', default='scratch/pt'); ap.add_argument('--w', type=int, default=390); ap.add_argument('--h', type=int, default=844)
ap.add_argument('--warp', type=float, default=4); ap.add_argument('--build', action='store_true', help='use dist/index.html instead of dev.html')
ap.add_argument('--mode', default='free'); ap.add_argument('--timeout', type=int, default=900)
ap.add_argument('--noise', type=float, default=0.0, help='timing noise sigma (s) on the scripted swings')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
base = 'http://localhost:8765/dist/index.html' if a.build else 'http://localhost:8765/dev.html'
url = f"{base}?autoplay={a.mode}&debug&warp={a.warp}&park={a.park}&char={a.char}&name=Tester"
JS_STATE = "(()=>{const G=window.__wcd;if(!G)return null;const r=G.round;return {state:G.state,pitchN:r&&r.pitchCount,outs:r&&r.outs,hr:r&&r.homers,score:r&&r.score,over:r&&r.over,swung:!!G.swung,kind:G.result&&G.result.kind,dist:G.result&&G.result.distance,homerCam:G.homerCamAt!=null,tau:G.tau,px:G.pitch&&G.pitch.plateLoc&&G.pitch.plateLoc[0],perfect:G.pitch&&G.pitch.perfectTapT}})()"
async def main():
    errs = []; shots = set()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(viewport={'width':a.w,'height':a.h}, has_touch=True)
        def con(m):
            t = m.text
            if m.type in ('error','warning') or '[swing]' in t or 'unhandled' in t: print(f'[{m.type}]', t[:300])
            if m.type == 'error': errs.append(t)
        pg.on('console', con)
        pg.on('pageerror', lambda e: (errs.append(str(e)), print('[PAGEERROR]', str(e)[:500])))
        await pg.goto(url, wait_until='load', timeout=60000)
        t0 = time.time(); swings = 0; last_n = -1; results = []
        async def shot(name):
            if name in shots: return
            shots.add(name); await pg.screenshot(path=f'{a.out}/{name}.png'); print('  shot', name)
        while time.time() - t0 < a.timeout:
            st = await pg.evaluate(JS_STATE)
            if not st: await asyncio.sleep(0.5); continue
            s = st['state']
            if s == 'intro': await shot('00_intro')
            if s in ('windup','pitch') and not st['swung'] and st['pitchN'] is not None:
                n = st['pitchN']
                if s == 'windup': await shot('01_windup')
                if n != last_n:
                    last_n = n
                    # let the ball travel a bit so the pitch is visible, then swing
                    if swings == 0:
                        await pg.evaluate("new Promise(r=>{const G=window.__wcd;const iv=setInterval(()=>{if(G.state==='pitch'&&G.pt>G.pitch.flightTime*0.55){clearInterval(iv);r()}},30)})")
                        await shot('02_pitch_midflight')
                    if swings < a.homers:
                        tap = f"G.pitch.perfectTapT+({random.gauss(0,a.noise) if a.noise else 0})"
                        aim = "Math.max(-1,Math.min(1,G.pitch.plateLoc[0]/0.83*0.8))"
                    else:
                        tap = "-0.5"; aim = "0"   # way early → whiff, quick out
                    r = await pg.evaluate(f"(()=>{{const G=window.__wcd;const res=G.debugSwing({tap},{aim});return res?{{kind:res.kind,timing:res.timingLabel,contact:res.contact,ev:res.exitVelo,la:res.launch,spray:res.spray,dist:res.distance}}:null}})()")
                    swings += 1; results.append(r); print(f'pitch {n}: {r}')
            if s == 'flight':
                if st['kind'] == 'homer' and not st['homerCam']: await shot('03_follow_homer')
                if st['homerCam']: await shot('04_homer_cam')
                if st['kind'] != 'homer' and st['kind'] and st['kind'] != 'whiff': await shot('03b_follow_out')
            if s == 'result':
                nm = '05_result_homer' if st['kind'] == 'homer' else ('05b_result_' + str(st['kind']))
                if nm not in shots:
                    await asyncio.sleep(1.6); await shot(nm)
            if s == 'over':
                await asyncio.sleep(4); await shot('06_round_over')
                await asyncio.sleep(6); await shot('07_round_over_board'); break
            await asyncio.sleep(0.12)
        st = await pg.evaluate(JS_STATE); print('final', json.dumps(st))
        await b.close()
    print('errors:', len(errs))
    for e in errs[:10]: print('  ', e[:300])
    sys.exit(2 if errs else 0)
asyncio.run(main())
