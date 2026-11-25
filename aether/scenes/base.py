"""Scene base class and helpers for slowly evolving parameters."""
import math

from .. import gl as G
from ..gl import gl
from ..palettes import PaletteTexture
from .. import glsl

_FS_VS = glsl.FULLSCREEN_VS
_NOOP_FS = glsl.HEADER + 'out vec4 c; void main(){ c = vec4(0.0); }'


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3.0 - 2.0 * x)


class Drift:
    """A value that glides between random waypoints, so parameters keep
    evolving without ever looping."""

    def __init__(self, rng, lo, hi, period=(15.0, 40.0), start=None, waypoints=None):
        self.rng = rng
        self.lo, self.hi = lo, hi
        self.period = period
        self.waypoints = waypoints
        self.a = start if start is not None else self._pick()
        self.b = self._pick()
        self.u = 0.0
        self.dur = rng.uniform(*period)
        self.value = self.a

    def _pick(self):
        if self.waypoints:
            return self.rng.choice(self.waypoints)
        return self.rng.uniform(self.lo, self.hi)

    def retarget(self, value=None, dur=None):
        self.a = self.value
        self.b = value if value is not None else self._pick()
        self.u = 0.0
        self.dur = dur or self.rng.uniform(*self.period)

    def update(self, dt):
        self.u += dt / self.dur
        if self.u >= 1.0:
            self.a, self.b = self.b, self._pick()
            self.u = 0.0
            self.dur = self.rng.uniform(*self.period)
        s = smooth(self.u)
        if isinstance(self.a, (tuple, list)):
            self.value = tuple(x + (y - x) * s for x, y in zip(self.a, self.b))
        else:
            self.value = self.a + (self.b - self.a) * s
        return self.value

    def __float__(self):
        return float(self.value)


class SceneContext:
    """Shared GL resources: program cache, empty VAO, fullscreen draw."""

    def __init__(self, log=None):
        self.vao = G.EmptyVAO()
        self.programs = {}
        self.log = log or (lambda *_: None)

    def program(self, label, vs=None, fs=None, cs=None):
        p = self.programs.get(label)
        if p is None:
            p = G.Program(label, vs=vs, fs=fs, cs=cs)
            self.programs[label] = p
        return p

    def fullscreen(self):
        self.vao.bind()
        gl.DrawArrays(G.TRIANGLES, 0, 3)


class Scene:
    name = 'scene'
    # relative pick weight and typical on-screen duration (seconds)
    weight = 1.0
    duration = (70.0, 140.0)

    def __init__(self, ctx, rng, w, h):
        self.ctx = ctx
        self.rng = rng
        self.w, self.h = int(w), int(h)
        self.aspect = self.w / self.h
        # pixels relative to 1280x720: keeps additive brightness resolution-independent
        self.area = (self.w * self.h) / (1280.0 * 720.0)
        self.t = 0.0
        self.palette = PaletteTexture(rng)
        self.out = G.RenderTarget(self.w, self.h, G.RGBA16F)
        self._resources = [self.out, self.palette]
        self.setup()

    # -- to override ------------------------------------------------------
    def setup(self):
        pass

    def step(self, dt):
        pass

    def draw(self):
        """Render into self.out (bound by caller)."""

    def describe(self):
        return self.name

    # -- framework -----------------------------------------------------------
    def keep(self, *res):
        self._resources.extend(res)
        return res[0] if len(res) == 1 else res

    def program(self, label, **src):
        return self.ctx.program(label, **src)

    def update(self, dt):
        self.t += dt
        self.palette.update(dt)
        self.step(dt)

    def render(self):
        gl.Disable(G.BLEND)
        self.draw()
        gl.Disable(G.BLEND)
        return self.out.tex

    def fade(self, rt, keep):
        """Multiply everything in rt by `keep` (trail persistence)."""
        rt.bind()
        gl.Enable(G.BLEND)
        gl.BlendColor(0.0, 0.0, 0.0, float(keep))
        gl.BlendFunc(G.ZERO, G.CONSTANT_ALPHA)
        self.ctx.program('noop', vs=_FS_VS, fs=_NOOP_FS).use()
        self.ctx.fullscreen()
        gl.Disable(G.BLEND)

    def release(self):
        for r in self._resources:
            try:
                r.delete()
            except Exception:
                pass
        self._resources = []


def perspective(fovy, aspect, near, far):
    f = 1.0 / math.tan(fovy / 2)
    nf = 1.0 / (near - far)
    # column-major
    return [f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, 2 * far * near * nf, 0]


def look_at(eye, target, up=(0, 1, 0)):
    ex, ey, ez = eye
    fx, fy, fz = target[0] - ex, target[1] - ey, target[2] - ez
    fl = math.sqrt(fx * fx + fy * fy + fz * fz)
    fx, fy, fz = fx / fl, fy / fl, fz / fl
    ux, uy, uz = up
    sx, sy, sz = fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux
    sl = math.sqrt(sx * sx + sy * sy + sz * sz)
    sx, sy, sz = sx / sl, sy / sl, sz / sl
    ux, uy, uz = sy * fz - sz * fy, sz * fx - sx * fz, sx * fy - sy * fx
    return [sx, ux, -fx, 0,
            sy, uy, -fy, 0,
            sz, uz, -fz, 0,
            -(sx * ex + sy * ey + sz * ez), -(ux * ex + uy * ey + uz * ez), (fx * ex + fy * ey + fz * ez), 1]


def matmul(a, b):
    """Column-major 4x4 multiply a*b."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def orbit_camera(t, radius, height, speed, aspect, fov=0.9, target=(0, 0, 0), phase=0.0):
    a = phase + t * speed
    eye = (target[0] + radius * math.cos(a), target[1] + height, target[2] + radius * math.sin(a))
    return matmul(perspective(fov, aspect, 0.05, 100.0), look_at(eye, target))
