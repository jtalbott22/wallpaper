"""Reaction: Gray-Scott reaction-diffusion, rendered as glossy enamel under a
slowly circling light. Feed/kill rates wander between the classic regimes
(coral, mitosis, worms, mazes, solitons, spirals) and vary gently across
the screen, so several 'species' of pattern grow side by side and invade
one another. Fresh seeds are dropped now and then to start new growth."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

# (feed, kill) in Karl Sims units (Da=1, Db=0.5, dt=1)
REGIMES = {
    'coral': (0.0545, 0.062),
    'mitosis': (0.0367, 0.0649),
    'worms': (0.046, 0.063),
    'maze': (0.029, 0.057),
    'holes': (0.039, 0.058),
    'solitons': (0.030, 0.062),
    'spirals': (0.014, 0.045),
    'fingerprint': (0.037, 0.060),
    'pulsing': (0.025, 0.060),
}

STEP_CS = glsl.comp('''
layout(rg32f, binding = 0) readonly uniform image2D uSrc;
layout(rg32f, binding = 1) writeonly uniform image2D uDst;
uniform ivec2 uSizeI;
uniform vec2 uFK, uFK2;
uniform float uVarScale, uTime;
uniform vec4 uSeedPt;   // xy = position (px), z = radius, w = active
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    if (p.x >= uSizeI.x || p.y >= uSizeI.y) return;
    #define S(dx, dy) imageLoad(uSrc, (p + ivec2(dx, dy) + uSizeI) % uSizeI).xy
    vec2 c = S(0, 0);
    vec2 lap = -c
        + 0.2 * (S(1, 0) + S(-1, 0) + S(0, 1) + S(0, -1))
        + 0.05 * (S(1, 1) + S(-1, 1) + S(1, -1) + S(-1, -1));
    // spatial variation between two regimes
    vec2 q = vec2(p) / float(uSizeI.y) * uVarScale;
    float m = smoothstep(-0.35, 0.35, snoise(vec3(q, uTime * 0.01)));
    vec2 fk = mix(uFK, uFK2, m);
    float a = c.x, b = c.y;
    float abb = a * b * b;
    a += (1.0 * lap.x - abb + fk.x * (1.0 - a));
    b += (0.5 * lap.y + abb - (fk.y + fk.x) * b);
    if (uSeedPt.w > 0.5) {
        vec2 d = vec2(p) - uSeedPt.xy;
        if (dot(d, d) < uSeedPt.z * uSeedPt.z) { b = max(b, 0.6); a = min(a, 0.4); }
    }
    imageStore(uDst, p, vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 0.0));
}
''', local=(16, 16, 1))

INIT_CS = glsl.comp('''
layout(rg32f, binding = 1) writeonly uniform image2D uDst;
uniform ivec2 uSizeI;
uniform uint uSeed;
uniform int uMode;
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    if (p.x >= uSizeI.x || p.y >= uSizeI.y) return;
    vec2 uv = vec2(p) / vec2(uSizeI);
    vec2 c = (vec2(p) - vec2(uSizeI) * 0.5) / float(uSizeI.y);
    float b = 0.0;
    float sd = float(uSeed % 1000u);
    if (uMode == 0) {               // scattered blobs
        float n = snoise(vec3(uv * vec2(float(uSizeI.x) / float(uSizeI.y), 1.0) * 9.0, sd));
        b = n > 0.45 ? 0.7 : 0.0;
    } else if (uMode == 1) {        // ring
        float r = length(c);
        b = abs(r - 0.28) < 0.012 ? 0.7 : 0.0;
    } else {                        // central seed + specks
        b = length(c) < 0.04 ? 0.7 : 0.0;
        if (hash12(vec2(p) + sd) > 0.9993) b = 0.7;
    }
    imageStore(uDst, p, vec4(1.0, b, 0.0, 0.0));
}
''', local=(16, 16, 1))

SHOW_FS = glsl.frag('''
uniform sampler2D uState;
uniform vec2 uTexel;
uniform vec3 uLight;
uniform float uRelief;
void main() {
    float b = texture(uState, vUv).y;
    float bl = texture(uState, vUv - vec2(uTexel.x, 0)).y, br = texture(uState, vUv + vec2(uTexel.x, 0)).y;
    float bd = texture(uState, vUv - vec2(0, uTexel.y)).y, bu = texture(uState, vUv + vec2(0, uTexel.y)).y;
    vec3 n = normalize(vec3((bl - br) * uRelief, (bd - bu) * uRelief, 1.0));
    vec3 L = normalize(uLight);
    float diff = max(dot(n, L), 0.0);
    vec3 H = normalize(L + vec3(0, 0, 1));
    float spec = pow(max(dot(n, H), 0.0), 60.0);
    float x = smoothstep(0.05, 0.42, b);
    vec3 base = pal(0.04 + 0.8 * x);
    vec3 col = base * (0.12 + 1.0 * diff) + pal(0.97) * spec * (0.25 + 0.9 * x);
    col += pal(0.85) * pow(x, 6.0) * 0.6;   // inner glow on the thickest parts
    fragColor = vec4(col * 0.6, 1.0);
}
''', palette=True)


class Reaction(Scene):
    name = 'Reaction'
    weight = 1.0
    duration = (80.0, 150.0)

    def setup(self):
        r = self.rng
        self.sw, self.sh = max(64, self.w // 2), max(64, self.h // 2)
        self.a = self.keep(G.Texture(self.sw, self.sh, G.RG32F, G.LINEAR, G.REPEAT))
        self.b = self.keep(G.Texture(self.sw, self.sh, G.RG32F, G.LINEAR, G.REPEAT))
        names = list(REGIMES)
        r.shuffle(names)
        wps = [REGIMES[n] for n in names]
        self.fk = Drift(r, 0, 0, (30, 60), start=wps[0], waypoints=wps)
        self.fk2 = Drift(r, 0, 0, (30, 60), start=wps[1], waypoints=wps)
        self.regimes = names[:2]
        self.var_scale = r.uniform(0.8, 2.0)
        self.relief = r.uniform(5.0, 9.0)
        self.light_speed = r.choice([-1, 1]) * r.uniform(0.05, 0.12)
        self.steps_per_frame = 12
        self.next_seed = r.uniform(6, 14)
        self.p_step = self.program('rd.step', cs=STEP_CS)
        self.p_init = self.program('rd.init', cs=INIT_CS)
        self.p_show = self.program('rd.show', vs=glsl.FULLSCREEN_VS, fs=SHOW_FS)
        self.b.bind_image(1, G.WRITE_ONLY)
        self.p_init.use().set(uMode=r.choice([0, 0, 0, 1, 2])).set_ivec2('uSizeI', self.sw, self.sh).set_uint('uSeed', r.getrandbits(31))
        self.p_init.dispatch((self.sw + 15) // 16, (self.sh + 15) // 16)
        G.barrier()
        self.a, self.b = self.b, self.a

    def describe(self):
        return f'Reaction ({self.regimes[0]} / {self.regimes[1]})'

    def step(self, dt):
        self.fk.update(dt)
        self.fk2.update(dt)
        seed = (0.0, 0.0, 0.0, 0.0)
        if self.t > self.next_seed:
            self.next_seed = self.t + self.rng.uniform(7, 16)
            seed = (self.rng.uniform(0, self.sw), self.rng.uniform(0, self.sh), self.rng.uniform(3, 7), 1.0)
        n = max(1, int(round(self.steps_per_frame * min(2.0, dt * 30))))
        self.p_step.use().set(uFK=self.fk.value, uFK2=self.fk2.value, uVarScale=self.var_scale, uTime=self.t)
        self.p_step.set_ivec2('uSizeI', self.sw, self.sh)
        gx, gy = (self.sw + 15) // 16, (self.sh + 15) // 16
        for i in range(n):
            self.p_step.set(uSeedPt=seed if i == 0 else (0.0, 0.0, 0.0, 0.0))
            self.a.bind_image(0, G.READ_ONLY)
            self.b.bind_image(1, G.WRITE_ONLY)
            self.p_step.dispatch(gx, gy)
            G.barrier(G.SHADER_IMAGE_ACCESS_BARRIER_BIT)
            self.a, self.b = self.b, self.a
        G.barrier(G.TEXTURE_FETCH_BARRIER_BIT)

    def draw(self):
        self.out.bind()
        la = self.t * self.light_speed
        self.p_show.use().set(uState=0, uTexel=(1.0 / self.sw, 1.0 / self.sh),
                              uLight=(math.cos(la), math.sin(la), 0.9), uRelief=self.relief, uPal=self.palette.bind(7))
        self.a.bind(0)
        self.ctx.fullscreen()
