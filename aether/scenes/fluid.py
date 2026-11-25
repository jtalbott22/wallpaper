"""Ink: a stable-fluids simulation (semi-Lagrangian advection, vorticity
confinement, Jacobi pressure solve). A few unseen 'brushes' wander the
canvas, gently stirring the water and bleeding coloured ink into it."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

SPLAT_FS = glsl.frag('''
uniform sampler2D uSrc;
uniform vec4 uPts[6];     // xy pos (uv), zw force / dye scale
uniform vec4 uCols[6];    // rgb colour, a radius
uniform int uN, uDye;
uniform float uAspect;
void main() {
    vec4 c = texture(uSrc, vUv);
    for (int i = 0; i < 6; i++) {
        if (i >= uN) break;
        vec2 d = vUv - uPts[i].xy;
        d = d - round(d);                 // wrap-aware
        d.x *= uAspect;
        float g = exp(-dot(d, d) / uCols[i].a);
        if (uDye == 1) c.rgb += uCols[i].rgb * g;
        else c.xy += uPts[i].zw * g;
    }
    fragColor = c;
}
''')

ADVECT_FS = glsl.frag('''
uniform sampler2D uVel, uSrc;
uniform vec2 uVelTexel;
uniform float uDt, uDissipation;
void main() {
    vec2 v = texture(uVel, vUv).xy;
    vec2 coord = vUv - uDt * v * uVelTexel;
    fragColor = texture(uSrc, coord) / (1.0 + uDissipation * uDt);
}
''')

CURL_FS = glsl.frag('''
uniform sampler2D uVel;
uniform vec2 uTexel;
void main() {
    float L = texture(uVel, vUv - vec2(uTexel.x, 0)).y, R = texture(uVel, vUv + vec2(uTexel.x, 0)).y;
    float T = texture(uVel, vUv + vec2(0, uTexel.y)).x, B = texture(uVel, vUv - vec2(0, uTexel.y)).x;
    fragColor = vec4(0.5 * (R - L - T + B), 0, 0, 1);
}
''')

VORT_FS = glsl.frag('''
uniform sampler2D uVel, uCurl;
uniform vec2 uTexel;
uniform float uCurlStrength, uDt;
void main() {
    float L = texture(uCurl, vUv - vec2(uTexel.x, 0)).x, R = texture(uCurl, vUv + vec2(uTexel.x, 0)).x;
    float T = texture(uCurl, vUv + vec2(0, uTexel.y)).x, B = texture(uCurl, vUv - vec2(0, uTexel.y)).x;
    float C = texture(uCurl, vUv).x;
    vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    f /= length(f) + 1e-4;
    f *= uCurlStrength * C;
    f.y *= -1.0;
    vec2 v = texture(uVel, vUv).xy + f * uDt;
    fragColor = vec4(clamp(v, -1000.0, 1000.0), 0, 1);
}
''')

DIV_FS = glsl.frag('''
uniform sampler2D uVel;
uniform vec2 uTexel;
void main() {
    float L = texture(uVel, vUv - vec2(uTexel.x, 0)).x, R = texture(uVel, vUv + vec2(uTexel.x, 0)).x;
    float T = texture(uVel, vUv + vec2(0, uTexel.y)).y, B = texture(uVel, vUv - vec2(0, uTexel.y)).y;
    fragColor = vec4(0.5 * (R - L + T - B), 0, 0, 1);
}
''')

PRESSURE_FS = glsl.frag('''
uniform sampler2D uP, uDiv;
uniform vec2 uTexel;
void main() {
    float L = texture(uP, vUv - vec2(uTexel.x, 0)).x, R = texture(uP, vUv + vec2(uTexel.x, 0)).x;
    float T = texture(uP, vUv + vec2(0, uTexel.y)).x, B = texture(uP, vUv - vec2(0, uTexel.y)).x;
    float d = texture(uDiv, vUv).x;
    fragColor = vec4((L + R + B + T - d) * 0.25, 0, 0, 1);
}
''')

GRAD_FS = glsl.frag('''
uniform sampler2D uP, uVel;
uniform vec2 uTexel;
void main() {
    float L = texture(uP, vUv - vec2(uTexel.x, 0)).x, R = texture(uP, vUv + vec2(uTexel.x, 0)).x;
    float T = texture(uP, vUv + vec2(0, uTexel.y)).x, B = texture(uP, vUv - vec2(0, uTexel.y)).x;
    vec2 v = texture(uVel, vUv).xy - vec2(R - L, T - B) * 0.5;
    fragColor = vec4(v, 0, 1);
}
''')

SCALE_FS = glsl.frag('''
uniform sampler2D uSrc;
uniform float uK;
void main() { fragColor = texture(uSrc, vUv) * uK; }
''')

SHOW_FS = glsl.frag('''
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uShade;
void main() {
    vec3 c = texture(uDye, vUv).rgb;
    float l = dot(texture(uDye, vUv - vec2(uTexel.x, 0)).rgb, vec3(0.33));
    float r = dot(texture(uDye, vUv + vec2(uTexel.x, 0)).rgb, vec3(0.33));
    float d = dot(texture(uDye, vUv - vec2(0, uTexel.y)).rgb, vec3(0.33));
    float u = dot(texture(uDye, vUv + vec2(0, uTexel.y)).rgb, vec3(0.33));
    vec3 n = normalize(vec3((l - r) * uShade, (d - u) * uShade, 1.0));
    float diff = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.8))) * 1.15, 0.55, 1.3);
    // soft-clip so dense ink saturates gracefully instead of blowing out
    c = c / (1.0 + 0.2 * dot(c, vec3(0.33)));
    fragColor = vec4(c * diff * 1.8, 1.0);
}
''')


class Brush:
    def __init__(self, rng, k):
        self.rng = rng
        self.x, self.y = rng.random(), rng.random()
        self.phase = rng.uniform(0, 100)
        self.speed = rng.uniform(0.07, 0.13)
        self.heading = rng.uniform(0, math.tau)
        self.turn = Drift(rng, -0.9, 0.9, (3, 9))
        self.hue = Drift(rng, 0.55, 0.9, (10, 25))
        self.on = Drift(rng, 0.0, 1.0, (4, 12))
        self.vx = self.vy = 0.0

    def update(self, dt):
        self.turn.update(dt)
        self.hue.update(dt)
        self.on.update(dt)
        self.heading += self.turn.value * dt
        self.vx = math.cos(self.heading) * self.speed
        self.vy = math.sin(self.heading) * self.speed
        self.x = (self.x + self.vx * dt) % 1.0
        self.y = (self.y + self.vy * dt) % 1.0


class Ink(Scene):
    name = 'Ink'
    weight = 0.75
    duration = (70.0, 130.0)

    def setup(self):
        r = self.rng
        self.vw, self.vh = max(32, self.w // 4), max(32, self.h // 4)
        self.dw, self.dh = self.w, self.h
        mk = lambda w, h, f=G.RGBA16F: G.PingPong(w, h, f, G.LINEAR, G.REPEAT)
        self.vel = self.keep(mk(self.vw, self.vh))
        self.dye = self.keep(mk(self.dw, self.dh))
        self.prs = self.keep(mk(self.vw, self.vh))
        self.div = self.keep(G.RenderTarget(self.vw, self.vh, G.RGBA16F, G.NEAREST, G.REPEAT))
        self.curl = self.keep(G.RenderTarget(self.vw, self.vh, G.RGBA16F, G.NEAREST, G.REPEAT))
        self.brushes = [Brush(r, k) for k in range(r.choice([2, 3, 3, 4]))]
        self.curl_strength = r.uniform(6, 14)
        self.dye_fade = Drift(r, 0.16, 0.28, (20, 40))
        self.vel_fade = r.uniform(0.25, 0.5)
        self.force = r.uniform(140, 220)
        self.next_puff = r.uniform(5, 12)
        self.puff = None
        P = lambda n, src: self.program('ink.' + n, vs=glsl.FULLSCREEN_VS, fs=src)
        self.p_splat = P('splat', SPLAT_FS)
        self.p_adv = P('advect', ADVECT_FS)
        self.p_curl = P('curl', CURL_FS)
        self.p_vort = P('vort', VORT_FS)
        self.p_div = P('div', DIV_FS)
        self.p_prs = P('pressure', PRESSURE_FS)
        self.p_grad = P('grad', GRAD_FS)
        self.p_scale = P('scale', SCALE_FS)
        self.p_show = self.program('ink.show', vs=glsl.FULLSCREEN_VS, fs=SHOW_FS)

    def describe(self):
        return f'Ink ({len(self.brushes)} brushes)'

    def _pal(self, x):
        from ..palettes import sample
        name = self.palette.target if (self.palette.target and self.palette.mix > 0.5) else self.palette.cur
        return sample(name, x)

    def _pass(self, prog, dst, **tex):
        dst.bind()
        prog.use()
        for unit, (name, t) in enumerate(tex.items()):
            t.bind(unit)
            prog.set(**{name: unit})
        self.ctx.fullscreen()

    def step(self, dt):
        dt = min(dt, 1 / 20)
        self.dye_fade.update(dt)
        pts, cols = [], []
        for b in self.brushes:
            b.update(dt)
            on = max(0.0, (b.on.value - 0.25) / 0.75)
            if on <= 0.01:
                continue
            col = self._pal(b.hue.value)
            k = on * dt * 4.0
            f = self.vw * self.force * on * dt
            pts.append((b.x, b.y, b.vx * f, b.vy * f))
            cols.append((col[0] * k, col[1] * k, col[2] * k, 0.00008 + 0.00012 * on))
        if self.t > self.next_puff:
            self.next_puff = self.t + self.rng.uniform(8, 18)
            a = self.rng.uniform(0, math.tau)
            col = self._pal(self.rng.uniform(0.6, 1.0))
            m = self.vw * 0.6
            pts.append((self.rng.random(), self.rng.random(), math.cos(a) * m, math.sin(a) * m))
            cols.append((col[0] * 1.2, col[1] * 1.2, col[2] * 1.2, 0.0015))
        aspect = self.w / self.h
        vtex = (1.0 / self.vw, 1.0 / self.vh)
        if pts:
            for dye, pp in ((0, self.vel), (1, self.dye)):
                pp.dst.bind()
                self.p_splat.use().set(uSrc=0, uN=len(pts), uDye=dye, uAspect=aspect)
                self.p_splat.set_vec4_array('uPts', pts).set_vec4_array('uCols', cols)
                pp.src.tex.bind(0)
                self.ctx.fullscreen()
                pp.swap()
        # vorticity
        self.curl.bind(); self.p_curl.use().set(uVel=0, uTexel=vtex); self.vel.src.tex.bind(0); self.ctx.fullscreen()
        self.vel.dst.bind(); self.p_vort.use().set(uVel=0, uCurl=1, uTexel=vtex, uCurlStrength=self.curl_strength, uDt=dt)
        self.vel.src.tex.bind(0); self.curl.tex.bind(1); self.ctx.fullscreen(); self.vel.swap()
        # projection
        self.div.bind(); self.p_div.use().set(uVel=0, uTexel=vtex); self.vel.src.tex.bind(0); self.ctx.fullscreen()
        self.prs.dst.bind(); self.p_scale.use().set(uSrc=0, uK=0.8); self.prs.src.tex.bind(0); self.ctx.fullscreen(); self.prs.swap()
        self.p_prs.use().set(uP=0, uDiv=1, uTexel=vtex)
        self.div.tex.bind(1)
        for _ in range(20):
            self.prs.dst.bind(); self.prs.src.tex.bind(0); self.ctx.fullscreen(); self.prs.swap()
        self.vel.dst.bind(); self.p_grad.use().set(uP=0, uVel=1, uTexel=vtex)
        self.prs.src.tex.bind(0); self.vel.src.tex.bind(1); self.ctx.fullscreen(); self.vel.swap()
        # advection (velocity in sim-texels per second)
        self.vel.dst.bind(); self.p_adv.use().set(uVel=0, uSrc=1, uVelTexel=vtex, uDt=dt, uDissipation=self.vel_fade)
        self.vel.src.tex.bind(0); self.vel.src.tex.bind(1); self.ctx.fullscreen(); self.vel.swap()
        self.dye.dst.bind(); self.p_adv.use().set(uVel=0, uSrc=1, uVelTexel=vtex, uDt=dt, uDissipation=self.dye_fade.value)
        self.vel.src.tex.bind(0); self.dye.src.tex.bind(1); self.ctx.fullscreen(); self.dye.swap()

    def draw(self):
        self.out.bind()
        self.p_show.use().set(uDye=0, uTexel=(1.0 / self.dw, 1.0 / self.dh), uShade=6.0)
        self.dye.src.tex.bind(0)
        self.ctx.fullscreen()
