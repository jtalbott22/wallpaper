"""Particle Life: several species of particles with an asymmetric web of
attractions and repulsions. From those simple rules emerge cells, worms,
orbiting clusters and chasing 'creatures'. The rule matrix slowly mutates
and a drifting temperature shakes matter between crystal, liquid and gas,
so the ecosystem never settles into one state."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

MAXK = 6

STEP_CS = glsl.comp('''
layout(std430, binding = 0) readonly buffer Src { vec4 S[]; };
layout(std430, binding = 1) writeonly buffer Dst { vec4 D[]; };
layout(std430, binding = 2) readonly buffer Spc { uint T[]; };
uniform float uM[36];
uniform uint uN, uFrame;
uniform int uK;
uniform float uRmax, uBeta, uFriction, uForce, uDt, uTemp;
uniform vec2 uWorld;
shared vec2 tp[256];
shared uint ts[256];
void main() {
    uint i = gl_GlobalInvocationID.x;
    uint li = gl_LocalInvocationID.x;
    bool live = i < uN;
    vec4 me = live ? S[i] : vec4(0.0);
    uint si = live ? T[i] : 0u;
    vec2 acc = vec2(0.0);
    float r2max = uRmax * uRmax;
    for (uint base = 0u; base < uN; base += 256u) {
        uint j = base + li;
        tp[li] = j < uN ? S[j].xy : vec2(1e6);
        ts[li] = j < uN ? T[j] : 0u;
        barrier();
        for (uint k = 0u; k < 256u; k++) {
            vec2 d = tp[k] - me.xy;
            d -= uWorld * round(d / uWorld);
            float r2 = dot(d, d);
            if (r2 > 1e-10 && r2 < r2max) {
                float r = sqrt(r2);
                float x = r / uRmax;
                float f = x < uBeta ? x / uBeta - 1.0
                        : uM[int(si) * uK + int(ts[k])] * (1.0 - abs(2.0 * x - 1.0 - uBeta) / (1.0 - uBeta));
                acc += d / r * f;
            }
        }
        barrier();
    }
    if (!live) return;
    acc *= uRmax * uForce;
    uint s = pcg(i * 9781u + uFrame * 6271u);
    acc += randGauss(s) * uTemp;
    vec2 v = me.zw * uFriction + acc * uDt;
    vec2 p = me.xy + v * uDt;
    p = mod(p, uWorld);
    D[i] = vec4(p, v);
}
''')

INIT_CS = glsl.comp('''
layout(std430, binding = 0) writeonly buffer Dst { vec4 D[]; };
layout(std430, binding = 2) writeonly buffer Spc { uint T[]; };
uniform uint uN, uSeed;
uniform int uK, uMode;
uniform vec2 uWorld;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    uint s = pcg(i * 2654435761u + uSeed);
    vec2 p;
    if (uMode == 0) p = vec2(rnd(s), rnd(s)) * uWorld;
    else { float a = rnd(s) * TAU, r = sqrt(rnd(s)) * 0.3; p = uWorld * 0.5 + r * vec2(cos(a), sin(a)); }
    D[i] = vec4(p, 0.0, 0.0);
    T[i] = i % uint(uK);
}
''')

DRAW_VS = glsl.vert('''
layout(std430, binding = 0) readonly buffer Src { vec4 S[]; };
layout(std430, binding = 2) readonly buffer Spc { uint T[]; };
uniform vec2 uWorld;
uniform float uSize, uIntensity;
uniform int uK;
uniform vec4 uHues[2];
out vec3 vCol;
void main() {
    vec4 p = S[gl_VertexID];
    vec2 ndc = p.xy / uWorld * 2.0 - 1.0;
    gl_Position = vec4(ndc, 0.0, 1.0);
    int k = int(T[gl_VertexID]);
    float h = k < 4 ? uHues[0][k] : uHues[1][k - 4];
    float spd = length(p.zw);
    vCol = pal(h) * uIntensity * (0.8 + 0.6 * clamp(spd * 4.0, 0.0, 1.0));
    gl_PointSize = uSize;
}
''', palette=True)

DRAW_FS = glsl.HEADER + '''
in vec3 vCol;
out vec4 fragColor;
void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    float g = exp(-r2 * 3.5) + 0.6 * exp(-r2 * 18.0);
    fragColor = vec4(vCol * g, 1.0);
}
'''


class Life(Scene):
    name = 'Particle Life'
    weight = 1.1

    def setup(self):
        r = self.rng
        self.k = r.choice([3, 4, 4, 5, 5, 6])
        self.n = 4096
        self.world = (self.aspect, 1.0)
        self.a = self.keep(G.Buffer(self.n * 16))
        self.b = self.keep(G.Buffer(self.n * 16))
        self.spec = self.keep(G.Buffer(self.n * 4))
        self.mat = [Drift(r, -1.0, 1.0, (25, 70)) for _ in range(self.k * self.k)]
        self.temp = Drift(r, 0.0, 0.6, (15, 40), start=0.0)
        self.rmax = r.uniform(0.09, 0.115)
        self.beta = 0.3
        self.force = r.uniform(8.0, 12.0)
        self.trail = r.uniform(0.55, 0.75)
        self.frame = 0
        hues = [0.42 + 0.53 * i / max(1, self.k - 1) for i in range(self.k)]
        r.shuffle(hues)
        hues += [0.8] * (8 - len(hues))
        self.hues = [tuple(hues[0:4]), tuple(hues[4:8])]
        self.p_step = self.program('life.step', cs=STEP_CS)
        self.p_init = self.program('life.init', cs=INIT_CS)
        self.p_draw = self.program('life.draw', vs=DRAW_VS, fs=DRAW_FS)
        self.a.bind_base(0)
        self.spec.bind_base(2)
        self.p_init.use().set(uK=self.k, uMode=r.choice([0, 0, 1]), uWorld=self.world)
        self.p_init.set_uint('uN', self.n).set_uint('uSeed', r.getrandbits(31))
        self.p_init.dispatch((self.n + 255) // 256)
        G.barrier()
        self.heat_at = r.uniform(25, 50)

    def describe(self):
        return f'Particle Life ({self.k} species)'

    def step(self, dt):
        for m in self.mat:
            m.update(dt)
        self.temp.update(dt)
        if self.t > self.heat_at:
            # an occasional 'heat wave' melts structures before they re-form
            self.temp.retarget(self.rng.uniform(0.8, 1.2), dur=self.rng.uniform(5, 9))
            self.heat_at = self.t + self.rng.uniform(35, 60)
        elif self.temp.u > 0.98 and self.temp.value > 0.75:
            self.temp.retarget(0.0, dur=self.rng.uniform(8, 14))
        sim_dt = 0.02 * min(2.0, dt * 30) * 0.8
        friction = 0.5 ** (sim_dt / 0.04)
        mat = [m.value for m in self.mat] + [0.0] * (36 - len(self.mat))
        self.p_step.use().set(uK=self.k, uRmax=self.rmax, uBeta=self.beta, uFriction=friction,
                              uForce=self.force, uDt=sim_dt, uTemp=self.temp.value * 2.0, uWorld=self.world)
        import ctypes as C
        gl.Uniform1fv(self.p_step.loc('uM'), 36, (C.c_float * 36)(*mat))
        self.p_step.set_uint('uN', self.n).set_uint('uFrame', self.frame)
        for _ in range(2):
            self.a.bind_base(0)
            self.b.bind_base(1)
            self.spec.bind_base(2)
            self.p_step.dispatch((self.n + 255) // 256)
            G.barrier(G.SHADER_STORAGE_BARRIER_BIT)
            self.a, self.b = self.b, self.a
        self.frame += 1

    def draw(self):
        self.fade(self.out, self.trail)
        self.out.bind()
        gl.Enable(G.BLEND)
        gl.BlendFunc(G.ONE, G.ONE)
        gl.Enable(G.PROGRAM_POINT_SIZE)
        self.a.bind_base(0)
        self.spec.bind_base(2)
        self.p_draw.use().set(uWorld=self.world, uSize=max(3.0, self.h * 0.0085), uIntensity=0.35 * (1 - self.trail) / 0.35,
                              uK=self.k, uPal=self.palette.bind(7))
        self.p_draw.set_vec4_array('uHues', self.hues)
        self.ctx.vao.bind()
        gl.DrawArrays(G.POINTS, 0, self.n)
        gl.Disable(G.BLEND)
