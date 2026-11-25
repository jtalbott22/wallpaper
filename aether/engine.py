"""Aether engine: scene scheduling, organic dissolves, bloom and tone mapping.

Pure OpenGL; the caller provides a current GL 4.3 context and a target
framebuffer (GTK's GLArea in the app, an offscreen FBO for previews).
"""
import math
import random

from . import gl as G
from .gl import gl
from . import glsl
from .scenes import REGISTRY
from .scenes.base import SceneContext, smooth

TRANSITION_S = 6.0
BLOOM_LEVELS = 6
TARGET_LUM = 0.04

DISSOLVE_FS = glsl.frag('''
uniform sampler2D uA, uB;
uniform float uP, uSeed, uAspect;
void main() {
    vec3 a = safe(texture(uA, vUv).rgb);
    vec3 b = safe(texture(uB, vUv).rgb);
    vec2 q = vUv * vec2(uAspect, 1.0) * 1.7 + uSeed;
    float n = vfbm(q, 5);
    n = clamp((n - 0.2) / 0.6, 0.0, 1.0);
    const float w = 0.22;
    float t = uP * (1.0 + 2.0 * w) - w;
    float m = smoothstep(n - w, n + w, t);
    // overall brightness dips a little mid-transition for a softer change
    float dip = 1.0 - 0.18 * sin(uP * PI);
    fragColor = vec4(mix(a, b, m) * dip, 1.0);
}
''')

COPY_FS = glsl.frag('''
uniform sampler2D uA;
void main() { fragColor = vec4(texture(uA, vUv).rgb, 1.0); }
''')

# Jimenez 13-tap downsample (Call of Duty: AW), Karis-weighted on the first pass
DOWN_FS = glsl.frag('''
uniform sampler2D uSrc;
uniform vec2 uTexel;   // texel size of the source
uniform int uFirst;
vec3 s(vec2 o) { return safe(texture(uSrc, vUv + o * uTexel).rgb); }
float karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
    vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
    vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
    vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
    vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
    vec3 col;
    if (uFirst == 1) {
        vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
        vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
        vec3 g4 = (j + k + l + m) * 0.25;
        float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125;
        float w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
        col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    } else {
        col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    }
    fragColor = vec4(max(col, 0.0), 1.0);
}
''')

UP_FS = glsl.frag('''
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
vec3 s(vec2 o) { return texture(uSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
    vec3 c = s(vec2(0)) * 4.0
           + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
           + (s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1)));
    fragColor = vec4(c / 16.0, 1.0);
}
''')

FINAL_FS = glsl.frag('''
uniform sampler2D uHdr, uBloom;
uniform float uBloomStrength, uExposure, uTime, uFade;
uniform vec2 uRes;
vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
    vec3 hdr = safe(texture(uHdr, vUv).rgb);
    vec3 bloom = safe(texture(uBloom, vUv).rgb);
    vec3 col = hdr + bloom * uBloomStrength;
    col *= uExposure * uFade;
    vec2 v = vUv - 0.5;
    col *= 1.0 - dot(v, v) * 0.55;             // soft vignette
    col = aces(col);
    col = pow(col, vec3(1.0 / 2.2));
    // triangular dither to kill banding in dark gradients
    float n = hash12(gl_FragCoord.xy + fract(uTime) * 97.0) + hash12(gl_FragCoord.yx * 1.37 + 11.0) - 1.0;
    col += n / 255.0;
    fragColor = vec4(col, 1.0);
}
''')


class Engine:
    def __init__(self, out_w, out_h, quality=0.75, seed=None, scene=None,
                 log=None, durations=None, bloom=0.32, exposure=1.0):
        self.log = log or (lambda *_: None)
        self.rng = random.Random(seed)
        self.ctx = SceneContext(self.log)
        self.quality = quality
        self.forced_scene = scene
        self.durations = durations  # (lo, hi) override for testing
        self.bloom_strength = bloom
        self.exposure = exposure
        self.time = 0.0
        self.auto_exposure = 1.0
        self.lum = None
        self.frame_no = 0
        self.history = []
        self.cur = None
        self.nxt = None
        self.trans = 0.0
        self.scene_t_end = 0.0
        self.fade_in = 0.0
        self.out_w = self.out_h = 0
        self.iw = self.ih = 0
        self._rts = []
        self.p_dissolve = self.ctx.program('dissolve', vs=glsl.FULLSCREEN_VS, fs=DISSOLVE_FS)
        self.p_copy = self.ctx.program('copy', vs=glsl.FULLSCREEN_VS, fs=COPY_FS)
        self.p_down = self.ctx.program('bloom_down', vs=glsl.FULLSCREEN_VS, fs=DOWN_FS)
        self.p_up = self.ctx.program('bloom_up', vs=glsl.FULLSCREEN_VS, fs=UP_FS)
        self.p_final = self.ctx.program('final', vs=glsl.FULLSCREEN_VS, fs=FINAL_FS)
        self.resize(out_w, out_h)

    # ---- sizing ---------------------------------------------------------------
    def resize(self, out_w, out_h, quality=None):
        if quality is not None:
            self.quality = quality
        iw = max(64, int(round(out_w * self.quality / 2)) * 2)
        ih = max(64, int(round(out_h * self.quality / 2)) * 2)
        self.out_w, self.out_h = out_w, out_h
        if (iw, ih) == (self.iw, self.ih):
            return
        self.iw, self.ih = iw, ih
        for rt in self._rts:
            rt.delete()
        self.comp = G.RenderTarget(iw, ih, G.RGBA16F)
        self.bloom = []
        w, h = iw, ih
        for _ in range(BLOOM_LEVELS):
            w, h = max(2, w // 2), max(2, h // 2)
            self.bloom.append(G.RenderTarget(w, h, G.RGBA16F))
        self._rts = [self.comp] + self.bloom
        # scenes are resolution-bound: restart with fresh ones at the new size
        had = self.cur is not None
        for s in (self.cur, self.nxt):
            if s:
                s.release()
        self.cur = self.nxt = None
        if had:
            self.fade_in = 0.0
        self.log(f'Internal resolution {iw}x{ih} (quality {self.quality:.2f})')

    # ---- scheduling ---------------------------------------------------------------
    def _pick_class(self):
        if self.forced_scene:
            for cls in REGISTRY:
                if cls.name.lower() == self.forced_scene.lower() or cls.__name__.lower() == self.forced_scene.lower():
                    return cls
            raise SystemExit(f'unknown scene {self.forced_scene!r}; try --list')
        recent = set(self.history[-max(1, min(4, len(REGISTRY) - 2)):])
        options = [c for c in REGISTRY if c.name not in recent] or list(REGISTRY)
        weights = [c.weight for c in options]
        return self.rng.choices(options, weights)[0]

    def _new_scene(self):
        cls = self._pick_class()
        seed = self.rng.getrandbits(32)
        scene = cls(self.ctx, random.Random(seed), self.iw, self.ih)
        lo, hi = self.durations or cls.duration
        scene.lifetime = self.rng.uniform(lo, hi)
        self.history.append(cls.name)
        self.log(f'Scene -> {scene.describe()} [{scene.palette.cur}] for {scene.lifetime:.0f}s (seed {seed})')
        return scene

    def skip(self):
        if self.cur and not self.nxt:
            self.cur.lifetime = self.cur.t

    # ---- frame ------------------------------------------------------------------------
    def frame(self, dt, target_fbo, vw, vh):
        dt = min(dt, 0.1)
        self.time += dt
        if self.cur is None:
            self.cur = self._new_scene()
        self.fade_in = min(1.0, self.fade_in + dt / 2.5)

        # advance scenes
        self.cur.update(dt)
        if self.nxt is None and self.cur.t >= self.cur.lifetime and not self.forced_scene:
            self.nxt = self._new_scene()
            self.trans = 0.0
        if self.nxt is not None:
            self.nxt.update(dt)
            self.trans += dt / TRANSITION_S

        gl.Disable(G.DEPTH_TEST)
        gl.Disable(G.SCISSOR_TEST)
        a = self.cur.render()
        src = a
        if self.nxt is not None:
            b = self.nxt.render()
            self.comp.bind()
            self.p_dissolve.use().set(uA=0, uB=1, uP=smooth(self.trans), uSeed=float(len(self.history) * 13.7 % 100),
                                      uAspect=self.iw / self.ih)
            a.bind(0)
            b.bind(1)
            self.ctx.fullscreen()
            src = self.comp.tex
            if self.trans >= 1.0:
                self.cur.release()
                self.cur, self.nxt = self.nxt, None

        # bloom chain
        gl.Disable(G.BLEND)
        prev = src
        for i, rt in enumerate(self.bloom):
            rt.bind()
            self.p_down.use().set(uSrc=0, uTexel=(1.0 / prev.w, 1.0 / prev.h), uFirst=1 if i == 0 else 0)
            prev.bind(0)
            self.ctx.fullscreen()
            prev = rt.tex
        gl.Enable(G.BLEND)
        gl.BlendFunc(G.ONE, G.ONE)
        for i in range(len(self.bloom) - 1, 0, -1):
            dst, s = self.bloom[i - 1], self.bloom[i]
            dst.bind()
            self.p_up.use().set(uSrc=0, uTexel=(1.0 / s.w, 1.0 / s.h), uRadius=1.0)
            s.tex.bind(0)
            self.ctx.fullscreen()
        gl.Disable(G.BLEND)
        self._meter(dt)

        # final composite to the target
        gl.BindFramebuffer(G.FRAMEBUFFER, target_fbo)
        gl.Viewport(0, 0, vw, vh)
        self.p_final.use().set(uHdr=0, uBloom=1, uBloomStrength=self.bloom_strength / BLOOM_LEVELS,
                               uExposure=self.exposure * self.auto_exposure, uTime=self.time, uFade=smooth(self.fade_in),
                               uRes=(float(vw), float(vh)))
        src.bind(0)
        self.bloom[0].tex.bind(1)
        self.ctx.fullscreen()

    def _meter(self, dt):
        """Slow auto-exposure from the smallest bloom level (a tiny readback
        every 15 frames), so every scene sits at a similar, calm brightness."""
        self.frame_no += 1
        if self.frame_no % 15 == 1:
            import ctypes as C
            rt = self.bloom[-1]
            buf = (C.c_float * (rt.w * rt.h * 4))()
            rt.fbo.bind()
            gl.ReadPixels(0, 0, rt.w, rt.h, G.RGBA, G.FLOAT, buf)
            n = rt.w * rt.h
            lum = sum(0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2] for i in range(n)) / n
            if lum == lum:  # not NaN
                self.lum = lum
        if self.lum is not None:
            target = (TARGET_LUM / max(self.lum, 1e-4)) ** 0.5
            target = min(max(target, 0.75), 1.4)
            k = 1.0 - math.exp(-dt / 3.0)
            self.auto_exposure += (target - self.auto_exposure) * k

    def current_name(self):
        return self.cur.describe() if self.cur else ''

    def release(self):
        for s in (self.cur, self.nxt):
            if s:
                s.release()
        for rt in self._rts:
            rt.delete()
