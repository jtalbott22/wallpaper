"""Record a smooth scroll of the site (local copy, identical to live) at exact 30 fps."""
import functools
import http.server
import math
import os
import threading

from playwright.sync_api import sync_playwright

SITE = os.path.expanduser('~/joshuaallentalbott.com')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'foot-site')
os.makedirs(OUT, exist_ok=True)
step = lambda i: 34 if i % 3 == 2 else 33
N = 240


def ease(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
h.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]

with sync_playwright() as p:
    b = p.chromium.launch(args=['--enable-gpu', '--use-angle=gl', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, color_scheme='dark', device_scale_factor=1.5)
    # brighter than the 20% default so the background reads on a phone screen
    ctx.add_init_script("try { localStorage.setItem('aether-level', '0.6') } catch (e) {}")
    pg = ctx.new_page()
    pg.set_default_timeout(120000)
    pg.goto(f'http://127.0.0.1:{port}/index.html', wait_until='load')
    pg.wait_for_timeout(7000)                 # let the background fade in and develop
    # each capture takes about half a second, so slow the animation to match playback
    pg.evaluate('window.Aether && Aether.speed(0.1)')
    max_y = pg.evaluate('document.documentElement.scrollHeight - innerHeight')
    depth = min(max_y, 3200)
    toggled = opened = False
    for i in range(N):
        t = i / 30
        if t < 0.6:
            y = 0
        elif t < 4.6:
            y = depth * ease((t - 0.6) / 4.0)           # down
        elif t < 6.0:
            y = depth * (1 - ease((t - 4.6) / 1.4))     # back to the top
        else:
            y = 0
        pg.evaluate(f'window.scrollTo({{top: {y:.1f}, behavior: "instant"}})')
        if t > 6.3 and not opened:
            opened = True
            pg.mouse.move(1150, 40)
            pg.click('#bgBtn')
        if opened:
            pg.hover('.bg-open + .bg-open') if t > 7.0 else None
        pg.screenshot(path=os.path.join(OUT, f'{i:04d}.jpg'), type='jpeg', quality=92)
    print('site frames', N, 'depth', depth, 'of', max_y, flush=True)
    b.close()
