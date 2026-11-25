"""Galaxy: two (sometimes three) spiral galaxies on a close encounter, as in
Toomre & Toomre's classic simulations. A quarter-million stars feel the
gravity of the galactic cores; the encounter tears out tidal tails and
bridges that slowly wrap and fall back."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift, orbit_camera

STRUCT = '''
struct Star { vec4 pos; vec4 vel; };   // pos.w = galaxy index, vel.w = brightness
layout(std430, binding = 0) buffer Stars { Star S[]; };
uniform uint uN, uSeed;
uniform int uNG;
uniform vec4 uCore[3];      // xyz pos, w mass
uniform vec4 uCoreV[3];     // xyz vel
uniform vec4 uNormal[3];    // disk normal, w = spin sign
uniform vec4 uDisk[3];      // x scale length, y max radius
uniform float uEps;
'''

INIT_CS = glsl.comp(STRUCT + '''
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    uint s = pcg(i * 2246822519u + uSeed);
    // distribute stars in proportion to mass
    float tot = 0.0;
    for (int g = 0; g < uNG; g++) tot += uCore[g].w;
    float pick = rnd(s) * tot, acc = 0.0;
    int g = 0;
    for (int k = 0; k < uNG; k++) { acc += uCore[k].w; if (pick <= acc) { g = k; break; } }
    vec3 n = normalize(uNormal[g].xyz);
    vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
    vec3 t2 = cross(n, t1);
    float sl = uDisk[g].x * sqrt(uCore[g].w);
    float r = min(-log(max(1e-4, rnd(s))) * sl + 0.08, uDisk[g].y * sqrt(uCore[g].w));
    float a = rnd(s) * TAU;
    // two-armed spiral density wave: bias angles toward arms
    a += 0.6 * sin(2.0 * a - r * 3.0) * step(0.35, rnd(s));
    vec3 radial = cos(a) * t1 + sin(a) * t2;
    vec3 p = uCore[g].xyz + radial * r + n * randGauss(s).x * 0.04 * (1.0 + r * 0.3);
    float M = uCore[g].w;
    float vc = sqrt(M * r * r / pow(r * r + uEps * uEps, 1.5));
    vec3 tang = cross(n, radial) * uNormal[g].w;
    vec3 v = uCoreV[g].xyz + tang * vc;
    float bright = 0.5 + 0.5 * exp(-r / sl) + (rnd(s) < 0.02 ? 2.0 : 0.0);
    S[i].pos = vec4(p, float(g));
    S[i].vel = vec4(v, bright);
}
''')

STEP_CS = glsl.comp(STRUCT + '''
uniform float uDt;
uniform int uSub;
vec3 accel(vec3 p) {
    vec3 a = vec3(0.0);
    for (int g = 0; g < uNG; g++) {
        vec3 d = uCore[g].xyz - p;
        float r2 = dot(d, d) + uEps * uEps;
        a += uCore[g].w * d * inversesqrt(r2 * r2 * r2);
    }
    return a;
}
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uN) return;
    Star st = S[i];
    vec3 p = st.pos.xyz, v = st.vel.xyz;
    float h = uDt / float(uSub);
    for (int k = 0; k < uSub; k++) {
        v += accel(p) * h;
        p += v * h;
    }
    st.pos.xyz = p;
    st.vel.xyz = v;
    S[i] = st;
}
''')

DRAW_VS = glsl.vert('''
struct Star { vec4 pos; vec4 vel; };
layout(std430, binding = 0) readonly buffer Stars { Star S[]; };
uniform mat4 uMVP;
uniform float uIntensity, uSize;
uniform vec3 uHue;
out vec3 vCol;
void main() {
    Star st = S[gl_VertexID];
    gl_Position = uMVP * vec4(st.pos.xyz, 1.0);
    int g = int(st.pos.w + 0.5);
    float h = uHue[g];
    float spd = length(st.vel.xyz);
    float b = st.vel.w;
    vec3 c = mix(pal(h), pal(0.97), clamp((b - 1.0) * 0.5, 0.0, 1.0));
    float depth = clamp(2.2 - gl_Position.w * 0.12, 0.3, 1.6);
    vCol = c * uIntensity * b * depth;
    gl_PointSize = uSize * (b > 1.8 ? 2.0 : 1.0);
}
''', palette=True)

DRAW_FS = glsl.HEADER + '''
in vec3 vCol;
out vec4 fragColor;
void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    fragColor = vec4(vCol * exp(-dot(d, d) * 2.0), 1.0);
}
'''


def _rand_unit(r):
    z = r.uniform(-1, 1)
    a = r.uniform(0, math.tau)
    s = math.sqrt(1 - z * z)
    return (s * math.cos(a), s * math.sin(a), z)


class Galaxy(Scene):
    name = 'Galaxy'
    weight = 0.9
    duration = (80.0, 130.0)

    def setup(self):
        r = self.rng
        self.ng = r.choice([2, 2, 2, 3])
        self.n = 1 << 18
        self.eps = 0.12
        self.buf = self.keep(G.Buffer(self.n * 32))
        masses = [1.0] + [r.uniform(0.35, 1.0) for _ in range(self.ng - 1)]
        # set up a near-parabolic encounter in the xz-plane
        D = r.uniform(3.6, 4.6)
        b = r.uniform(0.9, 1.6)
        cores = []
        if self.ng == 2:
            m1, m2 = masses
            mt = m1 + m2
            v = math.sqrt(2 * mt / math.hypot(D, b)) * r.uniform(0.75, 0.95)
            rel_p = (D, 0.0, b)
            rel_v = (-v, 0.0, 0.0)
            cores.append([(-rel_p[0] * m2 / mt, 0.0, -rel_p[2] * m2 / mt), (-rel_v[0] * m2 / mt, 0, 0), m1])
            cores.append([(rel_p[0] * m1 / mt, 0.0, rel_p[2] * m1 / mt), (rel_v[0] * m1 / mt, 0, 0), m2])
        else:
            for k in range(3):
                a = k * math.tau / 3 + r.uniform(-0.3, 0.3)
                pos = (math.cos(a) * D * 0.8, r.uniform(-0.4, 0.4), math.sin(a) * D * 0.8)
                tang = (-math.sin(a), 0.0, math.cos(a))
                sp = r.uniform(0.25, 0.4)
                vel = (tang[0] * sp - pos[0] * 0.06, 0.0, tang[2] * sp - pos[2] * 0.06)
                cores.append([pos, vel, masses[k]])
            # zero net momentum
            mt = sum(c[2] for c in cores)
            px = sum(c[1][0] * c[2] for c in cores) / mt
            pz = sum(c[1][2] * c[2] for c in cores) / mt
            for c in cores:
                c[1] = (c[1][0] - px, 0.0, c[1][2] - pz)
        self.cores = [[list(c[0]), list(c[1]), c[2]] for c in cores]
        self.normals = []
        for k in range(self.ng):
            n = _rand_unit(r)
            if r.random() < 0.5:
                n = (n[0] * 0.4, 1.0, n[2] * 0.4)  # mostly face-on to the orbital plane
            self.normals.append((*n, r.choice([-1.0, 1.0])))
        self.disks = [(r.uniform(0.28, 0.42), r.uniform(1.6, 2.2), 0, 0) for _ in range(self.ng)]
        hues = [r.uniform(0.55, 0.7), r.uniform(0.75, 0.9), r.uniform(0.62, 0.8)]
        r.shuffle(hues)
        self.hues = tuple(hues)
        self.time_scale = r.uniform(0.11, 0.15)
        self.cam_r = Drift(r, 8.0, 11.0, (25, 50))
        self.cam_h = Drift(r, 2.0, 6.5, (25, 50))
        self.cam_speed = r.choice([-1, 1]) * r.uniform(0.02, 0.04)
        self.trail = r.uniform(0.45, 0.65)
        self.p_init = self.program('gal.init', cs=INIT_CS)
        self.p_step = self.program('gal.step', cs=STEP_CS)
        self.p_draw = self.program('gal.draw', vs=DRAW_VS, fs=DRAW_FS)
        self.buf.bind_base(0)
        self._core_uniforms(self.p_init)
        self.p_init.set_uint('uN', self.n).set_uint('uSeed', r.getrandbits(31))
        self.p_init.dispatch((self.n + 255) // 256)
        G.barrier()

    def describe(self):
        return f'Galaxy ({self.ng} cores)'

    def _core_uniforms(self, p):
        p.use().set(uNG=self.ng, uEps=self.eps)
        pad = lambda l: l + [(0.0, 0.0, 0.0, 0.0)] * (3 - len(l))
        p.set_vec4_array('uCore', pad([(*c[0], c[2]) for c in self.cores]))
        p.set_vec4_array('uCoreV', pad([(*c[1], 0.0) for c in self.cores]))
        p.set_vec4_array('uNormal', pad(list(self.normals)))
        p.set_vec4_array('uDisk', pad(list(self.disks)))

    def _advance_cores(self, h):
        # mutual gravity between cores (softened), leapfrog
        cs = self.cores
        soft = 0.25
        acc = []
        for i, a in enumerate(cs):
            ax = ay = az = 0.0
            for j, b in enumerate(cs):
                if i == j:
                    continue
                dx, dy, dz = b[0][0] - a[0][0], b[0][1] - a[0][1], b[0][2] - a[0][2]
                r2 = dx * dx + dy * dy + dz * dz + soft * soft
                f = b[2] / (r2 * math.sqrt(r2))
                ax, ay, az = ax + dx * f, ay + dy * f, az + dz * f
            acc.append((ax, ay, az))
        for c, a in zip(cs, acc):
            c[1] = [c[1][k] + a[k] * h for k in range(3)]
            c[0] = [c[0][k] + c[1][k] * h for k in range(3)]

    def step(self, dt):
        self.cam_r.update(dt)
        self.cam_h.update(dt)
        sim = min(dt, 0.07) * self.time_scale * 2.0  # simulation time units per real second ~0.25
        sub = 4
        for _ in range(sub):
            self._advance_cores(sim / sub)
        self.buf.bind_base(0)
        self._core_uniforms(self.p_step)
        self.p_step.set(uDt=sim, uSub=sub).set_uint('uN', self.n)
        self.p_step.dispatch((self.n + 255) // 256)
        G.barrier(G.SHADER_STORAGE_BARRIER_BIT | G.VERTEX_ATTRIB_ARRAY_BARRIER_BIT)

    def draw(self):
        self.fade(self.out, self.trail)
        self.out.bind()
        gl.Enable(G.BLEND)
        gl.BlendFunc(G.ONE, G.ONE)
        gl.Enable(G.PROGRAM_POINT_SIZE)
        mt = sum(c[2] for c in self.cores)
        com = tuple(sum(c[0][k] * c[2] for c in self.cores) / mt for k in range(3))
        mvp = orbit_camera(self.t, self.cam_r.value, self.cam_h.value, self.cam_speed, self.aspect, fov=0.8, target=com)
        self.buf.bind_base(0)
        self.p_draw.use().set(uMVP=mvp, uIntensity=0.1 * self.area * (1 - self.trail) / 0.45,
                              uSize=max(1.0, self.h / 700.0), uHue=self.hues, uPal=self.palette.bind(7))
        self.ctx.vao.bind()
        gl.DrawArrays(G.POINTS, 0, self.n)
        gl.Disable(G.BLEND)
