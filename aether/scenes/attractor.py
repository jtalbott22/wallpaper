"""Attractor: millions of points per second iterate a Clifford / de Jong map
and pile up into a luminous density field. The four map coefficients glide
between pre-screened 'interesting' waypoints, so the shape continuously
folds, tears and re-blooms; sometimes with kaleidoscopic symmetry."""
import math
import threading

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

ITER_CS = glsl.comp('''
layout(std430, binding = 0) buffer Walkers { vec2 W[]; };
layout(r32ui, binding = 0) uniform uimage2D uCount;
layout(r32ui, binding = 1) uniform uimage2D uTone;
uniform uint uN, uSeed, uFrame;
uniform int uType, uIters, uSym;
uniform vec4 uP;          // a b c d
uniform float uScale, uRot;
uniform vec2 uCenter;
uniform vec2 uSize;
vec2 mapf(vec2 p) {
    float a = uP.x, b = uP.y, c = uP.z, d = uP.w;
    if (uType == 0) return vec2(sin(a * p.y) + c * cos(a * p.x), sin(b * p.x) + d * cos(b * p.y));
    return vec2(sin(a * p.y) - cos(b * p.x), sin(c * p.x) - cos(d * p.y));
}
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    vec2 p = W[i];
    uint s = pcg(i * 747796405u ^ uFrame * 2891336453u ^ uSeed);
    if (any(isnan(p)) || uFrame == 0u) p = vec2(rnd(s), rnd(s)) * 2.0 - 1.0;
    // tiny jitter keeps walkers from collapsing onto one identical orbit
    p += (vec2(rnd(s), rnd(s)) - 0.5) * 2e-3;
    // and a few re-seed each frame (their first iterations are not drawn)
    int skip = 0;
    if (rnd(s) < 0.004) { p = vec2(rnd(s), rnd(s)) * 2.0 - 1.0; skip = 6; }
    mat2 R = rot2(uRot);
    for (int k = 0; k < uIters; k++) {
        vec2 q = mapf(p);
        float tone = clamp(length(q - p) * 0.25, 0.0, 1.0);
        p = q;
        if (k < skip) continue;
        vec2 v = p;
        if (uSym > 1) v = rot2(TAU * floor(rnd(s) * float(uSym)) / float(uSym)) * v;
        v = R * (v - uCenter) * uScale;
        vec2 px = (v * 0.5 * uSize.y) + uSize * 0.5;
        ivec2 ip = ivec2(px);
        if (ip.x >= 0 && ip.y >= 0 && ip.x < int(uSize.x) && ip.y < int(uSize.y)) {
            imageAtomicAdd(uCount, ip, 1u);
            imageAtomicAdd(uTone, ip, uint(tone * 64.0));
        }
    }
    W[i] = p;
}
''')

DECAY_CS = glsl.comp('''
layout(r32ui, binding = 0) uniform uimage2D uCount;
layout(r32ui, binding = 1) uniform uimage2D uTone;
uniform ivec2 uSizeI;
uniform float uKeep;
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    if (p.x >= uSizeI.x || p.y >= uSizeI.y) return;
    uint c = imageLoad(uCount, p).x;
    uint t = imageLoad(uTone, p).x;
    imageStore(uCount, p, uvec4(uint(float(c) * uKeep)));
    imageStore(uTone, p, uvec4(uint(float(t) * uKeep)));
}
''', local=(16, 16, 1))

SHOW_FS = glsl.frag('''
uniform usampler2D uCount, uTone;
uniform float uRef, uGlow;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float c = float(texelFetch(uCount, p, 0).x);
    // gentle 3x3 smoothing of the density for softness
    float cs = c * 4.0;
    cs += float(texelFetch(uCount, p + ivec2(1, 0), 0).x) + float(texelFetch(uCount, p - ivec2(1, 0), 0).x);
    cs += float(texelFetch(uCount, p + ivec2(0, 1), 0).x) + float(texelFetch(uCount, p - ivec2(0, 1), 0).x);
    cs /= 8.0;
    float tone = c > 0.0 ? float(texelFetch(uTone, p, 0).x) / (c * 64.0) : 0.0;
    float v = log(1.0 + cs) / log(1.0 + uRef);
    v = clamp(v, 0.0, 1.2);
    float x = clamp(v * (0.78 + 0.4 * tone), 0.0, 1.0);
    vec3 col = pal(x) * (0.15 + v * v * uGlow);
    fragColor = vec4(col, 1.0);
}
''', palette=True)


def _clifford(p, x, y):
    a, b, c, d = p
    return math.sin(a * y) + c * math.cos(a * x), math.sin(b * x) + d * math.cos(b * y)


def _dejong(p, x, y):
    a, b, c, d = p
    return math.sin(a * y) - math.cos(b * x), math.sin(c * x) - math.cos(d * y)


def frame_of(kind, p, n=2500):
    """Iterate on the CPU; return (spread ratio, centre x, centre y, half-extent)."""
    f = _clifford if kind == 0 else _dejong
    x, y = 0.1, 0.1
    cells = set()
    x0 = y0 = 1e9
    x1 = y1 = -1e9
    for i in range(n):
        x, y = f(p, x, y)
        if i > 50:
            cells.add((int(x * 10), int(y * 10)))
            x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
    ext = max(x1 - x0, y1 - y0, 0.2) / 2
    return len(cells) / n, (x0 + x1) / 2, (y0 + y1) / 2, ext


def interesting(kind, p, n=2500):
    """Cheap CPU check: does the orbit spread out over many cells?"""
    ratio = frame_of(kind, p, n)[0]
    return 0.14 < ratio < 0.42


class Attractor(Scene):
    name = 'Attractor'
    weight = 1.0

    def setup(self):
        r = self.rng
        self.kind = r.choice([0, 0, 1])
        self.sym = r.choice([1, 1, 1, 1, 2, 3, 4, 6])
        self.n = 1 << 17
        self.iters = 12
        self.walkers = self.keep(G.Buffer(self.n * 8))
        self.count = self.keep(G.Texture(self.w, self.h, G.R32UI))
        self.tone = self.keep(G.Texture(self.w, self.h, G.R32UI))
        self.seed = r.getrandbits(31)
        self.frame = 0
        # random walk through parameter space, only stepping between points
        # where the start, middle and end of each glide are all interesting
        self.p_cur = self._pick()
        self.p_next = self._neighbour(self.p_cur)
        self.f_cur = frame_of(self.kind, self.p_cur)[1:]
        self.f_next = frame_of(self.kind, self.p_next)[1:]
        self._ahead = None
        self._plan_ahead()
        self.u = 0.0
        self.leg = r.uniform(14, 26)
        self.keep_d = Drift(r, 0.88, 0.95, (20, 40))
        self.rot_speed = r.choice([-1, 1]) * r.uniform(0.004, 0.015)
        self.zoom = Drift(r, 0.92, 1.15, (20, 40))
        self.p_iter = self.program('attr.iter', cs=ITER_CS)
        self.p_decay = self.program('attr.decay', cs=DECAY_CS)
        self.p_show = self.program('attr.show', vs=glsl.FULLSCREEN_VS, fs=SHOW_FS)

    def _pick(self):
        r = self.rng
        for _ in range(200):
            if self.kind == 0:
                p = (r.uniform(-2.2, 2.2), r.uniform(-2.2, 2.2), r.uniform(-1.4, 1.4), r.uniform(-1.4, 1.4))
            else:
                p = tuple(r.uniform(-3.0, 3.0) for _ in range(4))
            if interesting(self.kind, p):
                return p
        return (-1.4, 1.6, 1.0, 0.7)

    def _plan_ahead(self):
        """Search for the following waypoint in a background thread so the
        CPU-side checks never stall a frame."""
        start = self.p_next
        box = {}

        def work():
            q = self._neighbour(start)
            box['p'] = q
            box['f'] = frame_of(self.kind, q)[1:]
        th = threading.Thread(target=work, daemon=True)
        th.start()
        self._ahead = (th, box)

    def _neighbour(self, p):
        r = self.rng
        for step in (0.45, 0.3, 0.18, 0.1):
            for _ in range(12):
                q = tuple(x + r.uniform(-step, step) for x in p)
                mid = tuple((a + b) / 2 for a, b in zip(p, q))
                if interesting(self.kind, q, 1200) and interesting(self.kind, mid, 1200):
                    return q
        return self._pick()

    def describe(self):
        k = 'Clifford' if self.kind == 0 else 'de Jong'
        return f'Attractor ({k}{", %d-fold" % self.sym if self.sym > 1 else ""})'

    def step(self, dt):
        self.u = min(1.0, self.u + dt / self.leg)
        th, box = self._ahead
        if self.u >= 1.0 and not th.is_alive() and 'p' in box:
            self.p_cur, self.f_cur = self.p_next, self.f_next
            self.p_next, self.f_next = box['p'], box['f']
            self.u = 0.0
            self.leg = self.rng.uniform(14, 26)
            self._plan_ahead()
        e = self.u * self.u * (3 - 2 * self.u)
        p = tuple(a + (b - a) * e for a, b in zip(self.p_cur, self.p_next))
        cx, cy, ext = (a + (b - a) * e for a, b in zip(self.f_cur, self.f_next))
        self.keep_d.update(dt)
        self.zoom.update(dt)
        if self.sym > 1:
            # symmetric copies rotate about the origin: frame the full disc
            extent, cx, cy = math.hypot(abs(cx) + ext, abs(cy) + ext) * 0.98, 0.0, 0.0
        else:
            extent = ext
        scale = 0.86 / extent * self.zoom.value
        keep = self.keep_d.value ** (dt * 30)
        self.count.bind_image(0)
        self.tone.bind_image(1)
        self.p_decay.use().set(uKeep=keep).set_ivec2('uSizeI', self.w, self.h)
        self.p_decay.dispatch((self.w + 15) // 16, (self.h + 15) // 16)
        G.barrier(G.SHADER_IMAGE_ACCESS_BARRIER_BIT)
        self.walkers.bind_base(0)
        iters = max(2, int(self.iters * min(2.0, dt * 30)))
        self.p_iter.use().set(uType=self.kind, uIters=iters, uSym=self.sym, uP=p, uScale=scale, uCenter=(cx, cy),
                              uRot=self.t * self.rot_speed, uSize=(float(self.w), float(self.h)))
        self.p_iter.set_uint('uN', self.n).set_uint('uSeed', self.seed).set_uint('uFrame', self.frame)
        self.p_iter.dispatch((self.n + 255) // 256)
        G.barrier(G.SHADER_IMAGE_ACCESS_BARRIER_BIT | G.TEXTURE_FETCH_BARRIER_BIT)
        self.frame += 1
        self._expected = self.n * iters / max(0.02, 1 - keep)

    def draw(self):
        self.out.bind()
        ref = self._expected / (self.w * self.h) * 6.0
        self.p_show.use().set(uCount=0, uTone=1, uRef=max(4.0, ref * 1.6), uGlow=1.15, uPal=self.palette.bind(7))
        self.count.bind(0)
        self.tone.bind(1)
        self.ctx.fullscreen()
