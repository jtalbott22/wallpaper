"""Physarum: half a million slime-mold agents that follow and reinforce each
other's chemical trails, growing living transport networks. Up to three
species that avoid one another; their sensing parameters drift, so the
network keeps reorganising (veins -> cells -> waves -> veins)."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

INIT_CS = glsl.comp('''
layout(std430, binding = 0) buffer Agents { vec4 ag[]; };
uniform uint uCount, uSeed;
uniform int uPattern, uSpecies;
uniform vec2 uSize;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uCount) return;
    uint s = pcg(i * 2654435761u + uSeed);
    float sp = float(i % uint(uSpecies));
    vec2 c = uSize * 0.5;
    float R = min(uSize.x, uSize.y);
    vec2 p; float h;
    if (uPattern == 0) {              // scattered
        p = vec2(rnd(s), rnd(s)) * uSize; h = rnd(s) * TAU;
    } else if (uPattern == 1) {       // burst from a disc
        float a = rnd(s) * TAU, r = sqrt(rnd(s)) * R * 0.12;
        p = c + r * vec2(cos(a), sin(a)); h = a;
    } else if (uPattern == 2) {       // ring collapsing inward
        float a = rnd(s) * TAU, r = R * (0.36 + 0.04 * rnd(s));
        p = c + r * vec2(cos(a), sin(a)); h = a + PI;
    } else {                          // species in sectors
        float a = (sp + rnd(s)) / float(uSpecies) * TAU, r = sqrt(rnd(s)) * R * 0.42;
        p = c + r * vec2(cos(a), sin(a)); h = rnd(s) * TAU;
    }
    ag[i] = vec4(p, h, sp);
}
''')

AGENT_CS = glsl.comp('''
layout(std430, binding = 0) buffer Agents { vec4 ag[]; };
layout(rgba16f, binding = 0) uniform image2D uTrail;
uniform uint uCount, uSeed, uFrame;
uniform vec2 uSize;
uniform vec4 uSA, uRA, uSD, uSpeed, uDeposit;
uniform float uRepel, uStepScale;
float sense(vec2 p, vec4 mask) {
    ivec2 q = ivec2(mod(p, uSize));
    return dot(imageLoad(uTrail, q), mask);
}
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i >= uCount) return;
    vec4 a = ag[i];
    int s = int(a.w + 0.5);
    vec4 mask = vec4(-uRepel, -uRepel, -uRepel, 0.0);
    mask[s] = 1.0;
    float sa = uSA[s], ra = uRA[s], sd = uSD[s];
    vec2 pos = a.xy;
    float h = a.z;
    float f = sense(pos + sd * vec2(cos(h), sin(h)), mask);
    float l = sense(pos + sd * vec2(cos(h + sa), sin(h + sa)), mask);
    float r = sense(pos + sd * vec2(cos(h - sa), sin(h - sa)), mask);
    uint seed = pcg(i ^ (uFrame * 2654435761u) ^ uSeed);
    float rn = rnd(seed);
    if (f >= l && f >= r) {
    } else if (f < l && f < r) {
        h += (rn - 0.5) * 2.0 * ra;
    } else if (l > r) {
        h += ra * (0.7 + 0.3 * rn);
    } else {
        h -= ra * (0.7 + 0.3 * rn);
    }
    pos += uSpeed[s] * uStepScale * vec2(cos(h), sin(h));
    pos = mod(pos, uSize);
    ivec2 q = ivec2(pos);
    vec4 t = imageLoad(uTrail, q);
    t[s] = min(t[s] + uDeposit[s], 60.0);
    imageStore(uTrail, q, t);
    ag[i] = vec4(pos, h, a.w);
}
''')

DIFFUSE_CS = glsl.comp('''
layout(rgba16f, binding = 0) readonly uniform image2D uSrc;
layout(rgba16f, binding = 1) writeonly uniform image2D uDst;
uniform ivec2 uSizeI;
uniform float uDiffuse, uDecay;
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    if (p.x >= uSizeI.x || p.y >= uSizeI.y) return;
    vec4 sum = vec4(0.0);
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            ivec2 q = (p + ivec2(x, y) + uSizeI) % uSizeI;
            sum += imageLoad(uSrc, q);
        }
    vec4 c = imageLoad(uSrc, p);
    imageStore(uDst, p, mix(c, sum / 9.0, uDiffuse) * uDecay);
}
''', local=(16, 16, 1))

SHOW_FS = glsl.frag('''
uniform sampler2D uTrail;
uniform int uSpecies;
uniform vec3 uHue;     // palette position per species
uniform float uGain;
uniform vec2 uTexel;
void main() {
    vec4 t = texture(uTrail, vUv) * uGain;
    // a hint of relief lighting from the trail gradient
    float tl = dot(texture(uTrail, vUv - uTexel).rgb, vec3(1.0));
    float tr = dot(texture(uTrail, vUv + uTexel).rgb, vec3(1.0));
    float light = clamp(1.0 + (tr - tl) * 0.04 * uGain, 0.6, 1.5);
    vec3 col = vec3(0.0);
    for (int s = 0; s < 3; s++) {
        if (s >= uSpecies) break;
        float v = t[s];
        float x = 1.0 - exp(-v * 0.55);
        col += pal(x * uHue[s]) * (0.2 + 1.3 * x * x * x);
    }
    fragColor = vec4(col * light * 0.6, 1.0);
}
''', palette=True)


class Physarum(Scene):
    name = 'Physarum'
    weight = 1.1

    def setup(self):
        r = self.rng
        self.species = r.choice([1, 1, 2, 3, 3])
        self.count = (1 << 19) if self.species == 1 else 3 * (1 << 17) if self.species == 3 else (1 << 19)
        self.size = (self.w, self.h)
        self.scale = self.h / 540.0
        self.agents = self.keep(G.Buffer(self.count * 16))
        self.trail_a = self.keep(G.Texture(self.w, self.h, G.RGBA16F, G.LINEAR, G.REPEAT))
        self.trail_b = self.keep(G.Texture(self.w, self.h, G.RGBA16F, G.LINEAR, G.REPEAT))
        self.pattern = r.choice([0, 1, 2, 2, 3] if self.species > 1 else [0, 1, 2, 2])
        self.frame = 0
        self.seed = r.getrandbits(31)
        # per-species drifting behaviour (degrees / pixels)
        self.sa = [Drift(r, 15, 60, (20, 50)) for _ in range(3)]
        self.ra = [Drift(r, 12, 50, (20, 50)) for _ in range(3)]
        self.sd = [Drift(r, 5, 17, (20, 50)) for _ in range(3)]
        self.sp = [Drift(r, 0.8, 1.6, (20, 50)) for _ in range(3)]
        self.decay = Drift(r, 0.86, 0.94, (25, 60))
        self.diffuse = r.uniform(0.3, 0.9)
        self.repel = r.uniform(0.4, 1.2)
        hues = [r.uniform(0.78, 0.9), r.uniform(0.5, 0.65), r.uniform(0.66, 0.78)]
        r.shuffle(hues)
        self.hues = tuple(hues) if self.species > 1 else (0.92, 0.92, 0.92)
        self.p_init = self.program('phys.init', cs=INIT_CS)
        self.p_agent = self.program('phys.agent', cs=AGENT_CS)
        self.p_diff = self.program('phys.diffuse', cs=DIFFUSE_CS)
        self.p_show = self.program('phys.show', vs=glsl.FULLSCREEN_VS, fs=SHOW_FS)
        self.agents.bind_base(0)
        self.p_init.use().set(uPattern=self.pattern, uSpecies=self.species, uSize=(float(self.w), float(self.h)))
        self.p_init.set_uint('uCount', self.count).set_uint('uSeed', self.seed)
        self.p_init.dispatch((self.count + 255) // 256)
        G.barrier()

    def describe(self):
        return f'Physarum ({self.species} species)'

    def _vec(self, drifts, f=1.0):
        v = [d.value * f for d in drifts]
        return (v[0], v[1], v[2], 0.0)

    def step(self, dt):
        for group in (self.sa, self.ra, self.sd, self.sp):
            for d in group:
                d.update(dt)
        self.decay.update(dt)
        step_scale = self.scale * min(2.0, dt * 30.0)
        deg = math.pi / 180
        self.agents.bind_base(0)
        self.trail_a.bind_image(0, G.READ_WRITE)
        self.p_agent.use().set(uSize=(float(self.w), float(self.h)), uSA=self._vec(self.sa, deg), uRA=self._vec(self.ra, deg),
                               uSD=self._vec(self.sd, self.scale), uSpeed=self._vec(self.sp),
                               uDeposit=(1.0, 1.0, 1.0, 0.0), uRepel=self.repel, uStepScale=step_scale)
        self.p_agent.set_uint('uCount', self.count).set_uint('uSeed', self.seed).set_uint('uFrame', self.frame)
        self.p_agent.dispatch((self.count + 255) // 256)
        G.barrier(G.SHADER_IMAGE_ACCESS_BARRIER_BIT)
        self.trail_a.bind_image(0, G.READ_ONLY)
        self.trail_b.bind_image(1, G.WRITE_ONLY)
        decay = self.decay.value ** (dt * 30.0)
        self.p_diff.use().set(uDiffuse=self.diffuse, uDecay=decay).set_ivec2('uSizeI', self.w, self.h)
        self.p_diff.dispatch((self.w + 15) // 16, (self.h + 15) // 16)
        G.barrier(G.SHADER_IMAGE_ACCESS_BARRIER_BIT | G.TEXTURE_FETCH_BARRIER_BIT)
        self.trail_a, self.trail_b = self.trail_b, self.trail_a
        self.frame += 1

    def draw(self):
        self.out.bind()
        gain = 0.35 * (1.0 / max(0.5, (1 - self.decay.value) * 20))
        self.p_show.use().set(uTrail=0, uSpecies=self.species, uHue=self.hues, uGain=gain,
                              uTexel=(1.0 / self.w, 1.0 / self.h), uPal=self.palette.bind(7))
        self.trail_a.bind(0)
        self.ctx.fullscreen()

