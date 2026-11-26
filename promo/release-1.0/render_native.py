"""Scene footage from the native GPU renderer, frame by frame (no flicker, exact 30 fps)."""
import os
import sys

sys.path.insert(0, '/home/jtalbott/wallpaper')
from aether.headless import HeadlessContext   # noqa: E402
from aether import preview                    # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
FPS = 30
# name: (scene, seed, size, start second, frames)
SHOTS = {
    'hook':    ('Galaxy', 23, (1080, 1920), 26.0, 240),
    'ubuntu':  ('Silk', 2026, (1920, 1080), 28.0, 200),
    'mac':     ('Particle Life', 42, (1920, 1080), 28.0, 140),
    'windows': ('Reaction', 2026, (1920, 1080), 28.0, 140),
}
HeadlessContext()
from aether import gl as G                     # noqa: E402
from aether.gl import gl                       # noqa: E402
from aether.engine import Engine               # noqa: E402

for name in (sys.argv[1:] or SHOTS):
    scene, seed, (w, h), start, n = SHOTS[name]
    d = os.path.join(OUT, 'foot-' + name)
    os.makedirs(d, exist_ok=True)
    eng = Engine(w, h, quality=1.0, seed=seed, scene=scene, log=lambda *_: None)
    rt = G.RenderTarget(w, h, G.RGBA8)
    dt, t, saved = 1.0 / FPS, 0.0, 0
    while saved < n:
        eng.frame(dt, rt.fbo.id, w, h)
        gl.Finish()
        t += dt
        if t >= start - 1e-6:
            preview._read_rgb(rt).save(os.path.join(d, f'{saved:04d}.jpg'), quality=92)
            saved += 1
    eng.release()
    rt.delete()
    print(name, scene, saved, flush=True)
