"""Headless rendering: preview PNGs, contact sheets and benchmarks."""
import time

from . import gl as G
from .gl import gl
from .headless import HeadlessContext
from .engine import Engine
from .scenes import REGISTRY


def _read_rgb(rt):
    import ctypes as C
    from PIL import Image
    rt.fbo.bind()
    gl.PixelStorei(G.PACK_ALIGNMENT, 1)
    buf = C.create_string_buffer(rt.w * rt.h * 4)
    gl.ReadPixels(0, 0, rt.w, rt.h, G.RGBA, G.UNSIGNED_BYTE, buf)
    img = Image.frombuffer('RGBA', (rt.w, rt.h), buf.raw, 'raw', 'RGBA', 0, 1).convert('RGB')
    return img.transpose(Image.FLIP_TOP_BOTTOM)


def render_frames(scene, size, times, fps=30, seed=1, quality=0.75, log=print):
    """Simulate `scene` and grab frames at the given times (seconds)."""
    w, h = size
    eng = Engine(w, h, quality=quality, seed=seed, scene=scene, log=log)
    out = G.RenderTarget(w, h, G.RGBA8)
    dt = 1.0 / fps
    t = 0.0
    shots = []
    for target in sorted(times):
        while t < target - 1e-6:
            eng.frame(dt, out.fbo.id, w, h)
            gl.Finish()
            t += dt
        shots.append(_read_rgb(out))
    name = eng.current_name()
    eng.release()
    out.delete()
    return name, shots


def sheet(scenes, size, times, path, seed=1, quality=0.75):
    from PIL import Image, ImageDraw
    ctx = HeadlessContext()
    w, h = size
    rows = []
    for sc in scenes:
        t0 = time.time()
        name, shots = render_frames(sc, size, times, seed=seed, quality=quality, log=lambda *_: None)
        print(f'{name}: {time.time() - t0:.1f}s', flush=True)
        rows.append((name, shots))
    img = Image.new('RGB', (w * len(times), h * len(rows)), 'black')
    d = ImageDraw.Draw(img)
    for r, (name, shots) in enumerate(rows):
        for c, s in enumerate(shots):
            img.paste(s, (c * w, r * h))
            d.text((c * w + 6, r * h + 4), f'{name}  t={times[c]:.0f}s', fill=(255, 255, 255))
    img.save(path)
    print('wrote', path)


def bench(size, seconds=10, quality=0.75, scenes=None, seed=3):
    """Render each scene frame by frame (finishing each frame, like a real
    paced display) and report average and worst GPU frame times."""
    HeadlessContext()
    print(gl.GetString(G.RENDERER).decode(), '|', gl.GetString(G.VERSION).decode())
    w, h = size
    out = G.RenderTarget(w, h, G.RGBA8)
    results = []
    for cls in (scenes or REGISTRY):
        name = cls if isinstance(cls, str) else cls.name
        eng = Engine(w, h, quality=quality, seed=seed, scene=name, log=lambda *_: None)
        for _ in range(10):
            eng.frame(1 / 30, out.fbo.id, w, h)
            gl.Finish()
        times = []
        for _ in range(int(seconds * 30)):
            t0 = time.perf_counter()
            eng.frame(1 / 30, out.fbo.id, w, h)
            gl.Finish()
            times.append((time.perf_counter() - t0) * 1000)
        avg = sum(times) / len(times)
        worst = sorted(times)[int(len(times) * 0.99) - 1]
        results.append((eng.current_name(), avg, worst))
        print(f'{eng.current_name():32s} avg {avg:6.2f} ms   p99 {worst:6.2f} ms   (~{min(999, 1000 / avg):5.1f} fps)', flush=True)
        eng.release()
    out.delete()
    return results
