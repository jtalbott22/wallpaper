"""Silk: a quarter-million particles riding 3D curl noise, leaving luminous
threads. The flow field itself evolves, so the threads keep re-braiding."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift, orbit_camera

STRUCT = '''
struct Particle { vec4 pos; vec4 vel; };   // pos.w = age, vel.w = lifetime
layout(std430, binding = 0) buffer Parts { Particle P[]; };
uniform uint uCount, uSeed;
uniform int uShape;
uniform float uRadius;

vec3 spawn(inout uint s) {
    if (uShape == 0) {                       // sphere volume
        return randSphere(s) * uRadius * pow(rnd(s), 0.33);
    } else if (uShape == 1) {                // torus
        float a = rnd(s) * TAU;
        vec2 g = randGauss(s) * 0.18 * uRadius;
        vec3 c = vec3(cos(a), 0.0, sin(a)) * uRadius * 0.75;
        return c + vec3(cos(a) * g.x, g.y, sin(a) * g.x);
    } else if (uShape == 2) {                // two lobes
        float side = rnd(s) < 0.5 ? -1.0 : 1.0;
        return vec3(side * uRadius * 0.55, 0.0, 0.0) + randSphere(s) * uRadius * 0.45 * pow(rnd(s), 0.33);
    } else {                                 // thin disk
        float a = rnd(s) * TAU, r = sqrt(rnd(s)) * uRadius;
        return vec3(cos(a) * r, (rnd(s) - 0.5) * 0.08 * uRadius, sin(a) * r);
    }
}
'''

INIT_CS = glsl.comp(STRUCT + '''
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uCount) return;
    uint s = pcg(i * 9781u + uSeed);
    vec3 p = spawn(s);
    float life = mix(3.0, 11.0, rnd(s));
    P[i].pos = vec4(p, rnd(s) * life);
    P[i].vel = vec4(0.0, 0.0, 0.0, life);
}
''')

UPDATE_CS = glsl.comp(STRUCT + '''
uniform float uDt, uTime, uScale, uSpeed, uEvo, uSwirl;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uCount) return;
    Particle p = P[i];
    vec3 x = p.pos.xyz;
    vec3 v = curlNoise(x * uScale + vec3(0.0, uTime * uEvo, uTime * uEvo * 0.37)) * uSpeed;
    v += uSwirl * vec3(-x.z, 0.0, x.x);
    float r = length(x);
    v -= x * smoothstep(uRadius * 0.8, uRadius * 1.4, r) * 1.2;   // soft container
    x += v * uDt;
    p.pos.w += uDt;
    if (p.pos.w > p.vel.w) {
        uint s = pcg(i * 7919u + uSeed + uint(uTime * 60.0) * 131u);
        x = spawn(s);
        p.pos.w = 0.0;
        p.vel.w = mix(3.0, 11.0, rnd(s));
        v = vec3(0.0);
    }
    p.pos.xyz = x;
    p.vel.xyz = mix(p.vel.xyz, v, 0.5);
    P[i] = p;
}
''')

DRAW_VS = glsl.vert('''
struct Particle { vec4 pos; vec4 vel; };
layout(std430, binding = 0) readonly buffer Parts { Particle P[]; };
uniform mat4 uMVP;
uniform float uIntensity, uPointSize, uColorMode, uTime, uSpeed;
out vec3 vCol;
void main() {
    Particle p = P[gl_VertexID];
    gl_Position = uMVP * vec4(p.pos.xyz, 1.0);
    float life = p.vel.w, age = p.pos.w;
    float fade = smoothstep(0.0, 0.8, age) * smoothstep(life, life - 1.5, age);
    float spd = length(p.vel.xyz) / max(uSpeed, 1e-3);
    float c1 = clamp(0.25 + spd * 0.45, 0.0, 1.0);
    float c2 = clamp(0.5 + 0.45 * snoise(p.pos.xyz * 0.6 + uTime * 0.02), 0.0, 1.0);
    float c = mix(c1, c2, uColorMode);
    float depth = clamp(1.6 - gl_Position.w * 0.25, 0.25, 1.4);
    vCol = pal(0.35 + 0.65 * c) * uIntensity * fade * depth;
    gl_PointSize = uPointSize;
}
''', palette=True)

DRAW_FS = glsl.HEADER + '''
in vec3 vCol;
out vec4 fragColor;
void main() { fragColor = vec4(vCol, 1.0); }
'''


class Silk(Scene):
    name = 'Silk'
    weight = 1.2

    def setup(self):
        r = self.rng
        self.count = 1 << 18
        self.buf = self.keep(G.Buffer(self.count * 32))
        self.shape = r.choice([0, 0, 1, 2, 3])
        self.radius = 1.6
        self.seed = r.getrandbits(31)
        self.scale = Drift(r, 0.35, 1.1, (20, 45))
        self.speed = Drift(r, 0.35, 0.8, (15, 35))
        self.swirl = Drift(r, -0.35, 0.35, (25, 60))
        self.evo = r.uniform(0.03, 0.07)
        self.trail = Drift(r, 0.88, 0.95, (20, 50))
        self.color_mode = Drift(r, 0.0, 1.0, (25, 60))
        self.cam_r = Drift(r, 3.6, 5.2, (25, 50))
        self.cam_h = Drift(r, -1.5, 2.2, (25, 50))
        self.cam_speed = r.choice([-1, 1]) * r.uniform(0.03, 0.06)
        self.p_init = self.program('silk.init', cs=INIT_CS)
        self.p_update = self.program('silk.update', cs=UPDATE_CS)
        self.p_draw = self.program('silk.draw', vs=DRAW_VS, fs=DRAW_FS)
        self.buf.bind_base(0)
        self.p_init.use().set(uShape=self.shape, uRadius=self.radius).set_uint('uCount', self.count).set_uint('uSeed', self.seed)
        self.p_init.dispatch((self.count + 255) // 256)
        G.barrier()

    def describe(self):
        return f'Silk ({["sphere", "torus", "twin", "disk"][self.shape]})'

    def step(self, dt):
        for d in (self.scale, self.speed, self.swirl, self.trail, self.color_mode, self.cam_r, self.cam_h):
            d.update(dt)
        self.buf.bind_base(0)
        self.p_update.use().set(uDt=float(dt), uTime=self.t, uScale=self.scale.value, uSpeed=self.speed.value,
                                uEvo=self.evo, uSwirl=self.swirl.value, uShape=self.shape, uRadius=self.radius)
        self.p_update.set_uint('uCount', self.count).set_uint('uSeed', self.seed)
        self.p_update.dispatch((self.count + 255) // 256)
        G.barrier(G.SHADER_STORAGE_BARRIER_BIT | G.VERTEX_ATTRIB_ARRAY_BARRIER_BIT)

    def draw(self):
        self.fade(self.out, self.trail.value)
        self.out.bind()
        gl.Enable(G.BLEND)
        gl.BlendFunc(G.ONE, G.ONE)
        gl.Enable(G.PROGRAM_POINT_SIZE)
        mvp = orbit_camera(self.t, self.cam_r.value, self.cam_h.value, self.cam_speed, self.aspect, fov=0.85)
        scale = self.h / 720.0
        self.p_draw.use().set(uMVP=mvp, uIntensity=0.022 * self.area * (1.0 - self.trail.value) / 0.08, uPointSize=max(1.0, 1.0 * scale),
                              uColorMode=self.color_mode.value, uTime=self.t, uSpeed=self.speed.value,
                              uPal=self.palette.bind(7))
        self.buf.bind_base(0)
        self.ctx.vao.bind()
        gl.DrawArrays(G.POINTS, 0, self.count)
        gl.Disable(G.BLEND)
