"""Chaos: a hundred thousand particles trace a 3D strange attractor
(Lorenz, Aizawa, Thomas, Halvorsen, Dadras, Rossler...). Every so often the
governing equations are blended into a different system, and the whole
glowing cloud pours itself from one shape into the next."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift, orbit_camera

# name: (python derivative, glsl derivative, time scale)
SYSTEMS = {
    'Lorenz': (lambda x, y, z: (10 * (y - x), x * (28 - z) - y, x * y - 8 / 3 * z),
               'vec3(10.0 * (p.y - p.x), p.x * (28.0 - p.z) - p.y, p.x * p.y - 2.6666667 * p.z)', 0.35),
    'Aizawa': (lambda x, y, z: ((z - 0.7) * x - 3.5 * y, 3.5 * x + (z - 0.7) * y,
                                0.6 + 0.95 * z - z ** 3 / 3 - (x * x + y * y) * (1 + 0.25 * z) + 0.1 * z * x ** 3),
               'vec3((p.z - 0.7) * p.x - 3.5 * p.y, 3.5 * p.x + (p.z - 0.7) * p.y, '
               '0.6 + 0.95 * p.z - p.z * p.z * p.z / 3.0 - (p.x * p.x + p.y * p.y) * (1.0 + 0.25 * p.z) + 0.1 * p.z * p.x * p.x * p.x)', 1.2),
    'Thomas': (lambda x, y, z: (math.sin(y) - 0.208186 * x, math.sin(z) - 0.208186 * y, math.sin(x) - 0.208186 * z),
               'vec3(sin(p.y) - 0.208186 * p.x, sin(p.z) - 0.208186 * p.y, sin(p.x) - 0.208186 * p.z)', 4.0),
    'Halvorsen': (lambda x, y, z: (-1.89 * x - 4 * y - 4 * z - y * y, -1.89 * y - 4 * z - 4 * x - z * z,
                                   -1.89 * z - 4 * x - 4 * y - x * x),
                  'vec3(-1.89 * p.x - 4.0 * p.y - 4.0 * p.z - p.y * p.y, -1.89 * p.y - 4.0 * p.z - 4.0 * p.x - p.z * p.z, '
                  '-1.89 * p.z - 4.0 * p.x - 4.0 * p.y - p.x * p.x)', 0.6),
    'Dadras': (lambda x, y, z: (y - 3 * x + 2.7 * y * z, 1.7 * y - x * z + z, 2 * x * y - 9 * z),
               'vec3(p.y - 3.0 * p.x + 2.7 * p.y * p.z, 1.7 * p.y - p.x * p.z + p.z, 2.0 * p.x * p.y - 9.0 * p.z)', 0.7),
    'Rossler': (lambda x, y, z: (-y - z, x + 0.2 * y, 0.2 + z * (x - 5.7)),
                'vec3(-p.y - p.z, p.x + 0.2 * p.y, 0.2 + p.z * (p.x - 5.7))', 2.2),
}
NAMES = list(SYSTEMS)

# centre and scale (world units per attractor unit), from long RK4 runs
FRAMES = {
    'Lorenz': ((0.0, 0.0, 24.93), 0.0377),
    'Aizawa': ((-0.039, -0.231, 0.771), 0.7423),
    'Thomas': ((1.353, 1.353, 1.353), 0.3855),
    'Halvorsen': ((-2.91, -2.91, -2.91), 0.1029),
    'Dadras': ((-1.243, -1.986, 0.817), 0.0568),
    'Rossler': ((1.164, -1.471, 11.309), 0.0841),
}

_fns = '\n'.join(f'vec3 f{i}(vec3 p) {{ return {SYSTEMS[n][1]}; }}' for i, n in enumerate(NAMES))
_switch = '\n'.join(f'    if (k == {i}) return f{i}(p);' for i in range(len(NAMES)))

FIELD = _fns + f'''
vec3 fsys(int k, vec3 p) {{
{_switch}
    return vec3(0.0);
}}
uniform int uA, uB;
uniform vec4 uCenA, uCenB;   // xyz centre, w scale (world units per attractor unit)
uniform float uTsA, uTsB, uMix;
vec3 world_vel(vec3 w) {{
    vec3 va = vec3(0.0), vb = vec3(0.0);
    if (uMix < 0.999) {{ vec3 a = w / uCenA.w + uCenA.xyz; va = fsys(uA, a) * uCenA.w * uTsA; }}
    if (uMix > 0.001) {{ vec3 b = w / uCenB.w + uCenB.xyz; vb = fsys(uB, b) * uCenB.w * uTsB; }}
    vec3 v = mix(va, vb, uMix);
    float sp = length(v);
    return sp > 3.5 ? v * (3.5 / sp) : v;   // never let anything streak across the screen
}}
'''

STRUCT = '''
struct Particle { vec4 pos; vec4 vel; };
layout(std430, binding = 0) buffer Parts { Particle P[]; };
uniform uint uN, uSeed, uFrame;
'''

INIT_CS = glsl.comp(STRUCT + '''
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    uint s = pcg(i * 2654435761u + uSeed);
    P[i].pos = vec4(randSphere(s) * 0.6 * pow(rnd(s), 0.33), rnd(s));
    P[i].vel = vec4(0.0);
}
''')

STEP_CS = glsl.comp(STRUCT + FIELD + '''
uniform float uDt;
uniform int uSub;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    Particle pt = P[i];
    vec3 w = pt.pos.xyz;
    float h = uDt / float(uSub);
    vec3 v = vec3(0.0);
    for (int k = 0; k < uSub; k++) {
        vec3 k1 = world_vel(w);
        vec3 k2 = world_vel(w + k1 * h * 0.5);
        v = k2;
        w += k2 * h;
    }
    if (any(isnan(w)) || length(w) > 3.6) {
        uint s = pcg(i * 7919u + uFrame * 104729u + uSeed);
        // re-seed next to a random other particle so it rejoins the flow
        uint j = uint(rnd(s) * float(uN)) % uN;
        w = P[j].pos.xyz + randSphere(s) * 0.02;
        v = vec3(0.0);
    }
    pt.pos.xyz = w;
    pt.vel.xyz = mix(pt.vel.xyz, v, 0.3);
    P[i] = pt;
}
''')

DRAW_VS = glsl.vert('''
struct Particle { vec4 pos; vec4 vel; };
layout(std430, binding = 0) readonly buffer Parts { Particle P[]; };
uniform mat4 uMVP;
uniform float uIntensity, uSize, uSpeedRef, uHueSpread;
out vec3 vCol;
void main() {
    Particle p = P[gl_VertexID];
    gl_Position = uMVP * vec4(p.pos.xyz, 1.0);
    float spd = clamp(length(p.vel.xyz) / uSpeedRef, 0.0, 1.5);
    float x = 0.4 + 0.35 * spd + (p.pos.w - 0.5) * uHueSpread;
    float depth = clamp(1.8 - gl_Position.w * 0.22, 0.3, 1.5);
    vCol = pal(clamp(x, 0.25, 0.86)) * uIntensity * depth;
    gl_PointSize = uSize;
}
''', palette=True)

DRAW_FS = glsl.HEADER + '''
in vec3 vCol;
out vec4 fragColor;
void main() { fragColor = vec4(vCol, 1.0); }
'''


class Chaos(Scene):
    name = 'Chaos'
    weight = 1.0

    def setup(self):
        r = self.rng
        self.n = 1 << 17
        self.buf = self.keep(G.Buffer(self.n * 32))
        order = NAMES[:]
        r.shuffle(order)
        self.order = order
        self.idx = 0
        self.frames = {}
        self.a = self.b = order[0]
        self.mix = 0.0
        self.morph_t = None
        self.next_morph = r.uniform(30, 45)
        self.speed = r.uniform(0.8, 1.1)
        self.trail = Drift(r, 0.86, 0.93, (20, 45))
        self.cam_r = Drift(r, 3.2, 4.4, (25, 50))
        self.cam_h = Drift(r, -1.0, 2.0, (25, 50))
        self.cam_speed = r.choice([-1, 1]) * r.uniform(0.04, 0.07)
        self.hue_spread = r.uniform(0.05, 0.3)
        self.frame = 0
        self.seed = r.getrandbits(31)
        self.p_init = self.program('chaos.init', cs=INIT_CS)
        self.p_step = self.program('chaos.step', cs=STEP_CS)
        self.p_draw = self.program('chaos.draw', vs=DRAW_VS, fs=DRAW_FS)
        self.buf.bind_base(0)
        self.p_init.use().set_uint('uN', self.n).set_uint('uSeed', self.seed)
        self.p_init.dispatch((self.n + 255) // 256)
        G.barrier()
        for _ in range(90):
            self._integrate(1 / 15)

    def _frame(self, name):
        c, k = FRAMES[name]
        return c, k * 1.5

    def describe(self):
        return f'Chaos ({self.a if self.mix < 0.5 else self.b})'

    def step(self, dt):
        self.trail.update(dt)
        self.cam_r.update(dt)
        self.cam_h.update(dt)
        nxt = self.order[(self.idx + 1) % len(self.order)]
        if self.morph_t is None and self.t > self.next_morph:
            self.idx = (self.idx + 1) % len(self.order)
            self.b = self.order[self.idx]
            self.morph_t = 0.0
        if self.morph_t is not None:
            self.morph_t += dt / 12.0
            u = min(1.0, self.morph_t)
            self.mix = u * u * (3 - 2 * u)
            if u >= 1.0:
                self.a, self.mix, self.morph_t = self.b, 0.0, None
                self.next_morph = self.t + self.rng.uniform(28, 45)
        self._integrate(dt)

    def _integrate(self, dt):
        ca, sa = self._frame(self.a)
        cb, sb = self._frame(self.b)
        self.buf.bind_base(0)
        self.p_step.use().set(uA=NAMES.index(self.a), uB=NAMES.index(self.b), uCenA=(*ca, sa), uCenB=(*cb, sb),
                              uTsA=SYSTEMS[self.a][2], uTsB=SYSTEMS[self.b][2], uMix=self.mix,
                              uDt=min(dt, 0.07) * 0.5 * self.speed, uSub=3)
        self.p_step.set_uint('uN', self.n).set_uint('uSeed', self.seed).set_uint('uFrame', self.frame)
        self.p_step.dispatch((self.n + 255) // 256)
        G.barrier(G.SHADER_STORAGE_BARRIER_BIT | G.VERTEX_ATTRIB_ARRAY_BARRIER_BIT)
        self.frame += 1

    def draw(self):
        self.fade(self.out, self.trail.value)
        self.out.bind()
        gl.Enable(G.BLEND)
        gl.BlendFunc(G.ONE, G.ONE)
        gl.Enable(G.PROGRAM_POINT_SIZE)
        mvp = orbit_camera(self.t, self.cam_r.value, self.cam_h.value, self.cam_speed, self.aspect, fov=0.85)
        self.buf.bind_base(0)
        self.p_draw.use().set(uMVP=mvp, uIntensity=0.05 * self.area * (1 - self.trail.value) / 0.1,
                              uSize=max(1.0, self.h / 720.0), uSpeedRef=1.6, uHueSpread=self.hue_spread,
                              uPal=self.palette.bind(7))
        self.ctx.vao.bind()
        gl.DrawArrays(G.POINTS, 0, self.n)
        gl.Disable(G.BLEND)
