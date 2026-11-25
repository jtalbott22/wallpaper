"""Nebula: a calm interlude. Layered domain-warped noise (fbm of fbm of fbm)
billows like interstellar gas, lit from within, over a field of softly
twinkling stars, while the view drifts and slowly turns."""
import math

from .. import gl as G
from ..gl import gl
from .. import glsl
from .base import Scene, Drift

FS = glsl.frag('''
uniform float uTime, uAspect, uScale, uWarp, uRot, uStarDensity;
uniform vec2 uDrift;
float stars(vec2 p, float dens) {
    vec2 i = floor(p), f = fract(p);
    float h = hash12(i);
    if (h > dens) return 0.0;
    vec2 c = vec2(hash12(i + 3.1), hash12(i + 7.7)) * 0.8 + 0.1;
    float d = length(f - c);
    float tw = 0.6 + 0.4 * sin(uTime * (0.5 + 2.0 * hash12(i + 1.3)) + h * 50.0);
    return exp(-d * d * 900.0) * tw * (0.3 + 2.0 * hash12(i + 9.1));
}
void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 p = rot2(uRot) * uv * uScale + uDrift;
    float t = uTime * 0.015;
    vec2 q = vec2(vfbm(p + vec2(0.0, t), 5), vfbm(p + vec2(5.2, 1.3) - t, 5));
    vec2 r = vec2(vfbm(p + uWarp * q + vec2(1.7, 9.2) + 0.15 * t, 5),
                  vfbm(p + uWarp * q + vec2(8.3, 2.8) + 0.126 * t, 5));
    float f = vfbm(p + uWarp * r, 5);
    float dens = smoothstep(0.35, 1.05, f * f * 1.6 + 0.25 * length(q));
    float x = clamp(dens * 0.75 + 0.25 * r.x, 0.0, 1.0);
    vec3 gas = pal(x * 0.9) * (0.03 + 0.75 * dens * dens);
    // dark dust lanes
    float dust = smoothstep(0.45, 0.75, vfbm(p * 1.8 + 3.0 * r + 11.0, 4));
    gas *= 1.0 - 0.7 * dust;
    // embedded bright knots
    gas += pal(0.92) * pow(smoothstep(0.7, 1.0, f * dens + 0.2), 4.0) * 0.5;
    vec2 sp = uv * 220.0 + uDrift * 40.0;
    float st = stars(sp, uStarDensity) + 0.6 * stars(sp * 0.55 + 13.0, uStarDensity * 0.8);
    vec3 col = gas + vec3(0.85, 0.9, 1.0) * st * (1.0 - 0.8 * dens);
    fragColor = vec4(col, 1.0);
}
''', palette=True)


class Nebula(Scene):
    name = 'Nebula'
    weight = 0.7
    duration = (60.0, 110.0)

    def setup(self):
        r = self.rng
        self.scale = Drift(r, 1.4, 2.6, (25, 50))
        self.warp = Drift(r, 3.0, 5.0, (25, 50))
        self.rot_speed = r.choice([-1, 1]) * r.uniform(0.004, 0.012)
        self.vel = (r.uniform(-0.02, 0.02), r.uniform(-0.02, 0.02))
        self.origin = (r.uniform(-50, 50), r.uniform(-50, 50))
        self.stars = r.uniform(0.04, 0.09)
        self.prog = self.program('nebula', vs=glsl.FULLSCREEN_VS, fs=FS)
        # the nebula is soft: render it at half resolution and upscale
        self.lw, self.lh = max(64, self.w // 2), max(64, self.h // 2)
        self.low = self.keep(G.RenderTarget(self.lw, self.lh, G.RGBA16F))
        self.p_copy = self.program('copy', vs=glsl.FULLSCREEN_VS, fs=glsl.frag(
            'uniform sampler2D uA; void main() { fragColor = vec4(texture(uA, vUv).rgb, 1.0); }'))

    def step(self, dt):
        self.scale.update(dt)
        self.warp.update(dt)

    def draw(self):
        self.low.bind()
        drift = (self.origin[0] + self.vel[0] * self.t, self.origin[1] + self.vel[1] * self.t)
        self.prog.use().set(uTime=self.t, uAspect=self.aspect, uScale=self.scale.value, uWarp=self.warp.value,
                            uRot=self.t * self.rot_speed, uDrift=drift, uStarDensity=self.stars,
                            uPal=self.palette.bind(7))
        self.ctx.fullscreen()
        self.out.bind()
        self.p_copy.use().set(uA=0)
        self.low.tex.bind(0)
        self.ctx.fullscreen()
