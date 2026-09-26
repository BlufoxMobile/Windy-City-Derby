#!/usr/bin/env python3
"""Headless screenshot + console harness for Windy City Derby.
Usage: python3 tools/shot.py URL OUT.png [--w 390] [--h 844] [--wait 4000] [--eval "js"] [--eval-after "js"] [--dpr 1] [--click x,y]
Serve the project first:  (cd /home/claude/derby && python3 -m http.server 8765 >/dev/null 2>&1 &)
Prints every console message and page error. Exit code 2 if any pageerror occurred.
"""
import sys, argparse, asyncio, json
from playwright.async_api import async_playwright
ap = argparse.ArgumentParser()
ap.add_argument('url'); ap.add_argument('out')
ap.add_argument('--w', type=int, default=390); ap.add_argument('--h', type=int, default=844)
ap.add_argument('--dpr', type=float, default=1)
ap.add_argument('--wait', type=int, default=4000)
ap.add_argument('--eval', default=None, help='JS run right after load (before wait)')
ap.add_argument('--eval-after', default=None, help='JS run after wait, result printed')
ap.add_argument('--click', default=None, help='x,y CSS px to click after load')
a = ap.parse_args()
async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium' if False else None,
            args=['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(viewport={'width':a.w,'height':a.h}, device_scale_factor=a.dpr, has_touch=True)
        pg.on('console', lambda m: print(f'[console.{m.type}]', m.text[:400]))
        pg.on('pageerror', lambda e: (errs.append(str(e)), print('[PAGEERROR]', str(e)[:600])))
        await pg.goto(a.url, wait_until='load', timeout=60000)
        if a.eval:
            r = await pg.evaluate(a.eval); print('[eval]', json.dumps(r)[:1500] if r is not None else '')
        if a.click:
            x,y = map(float, a.click.split(',')); await pg.mouse.click(x,y)
        await pg.wait_for_timeout(a.wait)
        if a.eval_after:
            r = await pg.evaluate(a.eval_after); print('[eval-after]', json.dumps(r)[:3000] if r is not None else '')
        await pg.screenshot(path=a.out)
        await b.close()
    print('[shot]', a.out, 'errors:', len(errs))
    sys.exit(2 if errs else 0)
asyncio.run(main())
