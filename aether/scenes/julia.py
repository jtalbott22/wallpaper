"""Julia: the Julia set of z^2 + c, with c gliding along the edge of the
Mandelbrot set, where every point gives a different intricate shape.
Distance-estimated glow keeps the filaments soft and alias-free."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

FS = glsl.frag('''
uniform vec2 uC, uCenter;
uniform float uZoom, uRot, uAspect, uPx, uTrapR, uInterior;
uniform int uMaxIter;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec3 sampleAt(vec2 uv) {
    vec2 z = rot2(uRot) * uv * uZoom + uCenter;
    vec2 dz = vec2(1.0, 0.0);
    float trap = 1e9, m2 = 0.0;
    int i;
    for (i = 0; i < uMaxIter; i++) {
        dz = 2.0 * cmul(z, dz);
        z = cmul(z, z) + uC;
        m2 = dot(z, z);
        trap = min(trap, abs(length(z) - uTrapR));
        if (m2 > 1024.0) break;
    }
    if (i >= uMaxIter) {
        // interior: dim, softly lit by the orbit trap
        float g = exp(-trap * 6.0);
        return pal(0.25 + 0.5 * g) * (0.04 + 0.5 * g * g) * uInterior;
    }
    float sn = float(i) - log2(log2(m2)) + 4.0;
    float d = 0.5 * sqrt(m2) * log(m2) / max(length(dz), 1e-9);
    float edge = exp(-d / (uPx * 2.5));
    float halo = exp(-d / (uPx * 10.0));
    float band = 1.0 - exp(-sn * 0.035);
    vec3 col = pal(0.12 + 0.55 * band) * (0.12 + 0.35 * band);
    col += pal(0.55 + 0.35 * band) * halo * 0.35;
    col += pal(0.9) * edge * 0.9;
    return col;
}
void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 o = vec2(0.25, -0.25) * uPx / uZoom;
    vec3 c = sampleAt(uv + o) + sampleAt(uv - o);
    fragColor = vec4(c * 0.5, 1.0);
}
''', palette=True)


class Julia(Scene):
    name = 'Julia'
    weight = 0.9

    def setup(self):
        r = self.rng
        self.path = r.choice(['cardioid', 'cardioid', 'cardioid', 'bulb'])
        self.theta = r.uniform(0, math.tau)
        self.omega = r.choice([-1, 1]) * r.uniform(0.006, 0.014)
        self.radial = Drift(r, 0.975, 1.012, (12, 30))
        self.zoom = Drift(r, 2.4, 3.4, (20, 45))
        self.rot_speed = r.choice([-1, 1]) * r.uniform(0.006, 0.02)
        self.trap = Drift(r, 0.2, 1.0, (20, 40))
        self.interior = r.uniform(0.25, 0.55)
        self.prog = self.program('julia', vs=glsl.FULLSCREEN_VS, fs=FS)

    def describe(self):
        return f'Julia ({self.path})'

    def c(self):
        th, k = self.theta, self.radial.value
        if self.path == 'cardioid':
            cx = 0.5 * math.cos(th) - 0.25 * math.cos(2 * th)
            cy = 0.5 * math.sin(th) - 0.25 * math.sin(2 * th)
            # scale towards/away from the cardioid's cusp-free centre
            return (0.25 + (cx - 0.25) * k, cy * k)
        return (-1.0 + 0.25 * k * math.cos(th), 0.25 * k * math.sin(th))

    def step(self, dt):
        self.radial.update(dt)
        self.zoom.update(dt)
        self.trap.update(dt)
        # move faster through the cusp region where little changes
        self.theta += self.omega * dt

    def draw(self):
        self.out.bind()
        zoom = self.zoom.value
        self.prog.use().set(uC=self.c(), uCenter=(0.0, 0.0), uZoom=zoom, uRot=self.t * self.rot_speed,
                            uAspect=self.aspect, uPx=zoom / self.h, uTrapR=self.trap.value,
                            uInterior=self.interior, uMaxIter=160, uPal=self.palette.bind(7))
        self.ctx.fullscreen()
