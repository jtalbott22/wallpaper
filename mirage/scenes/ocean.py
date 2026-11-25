"""Ocean: layered translucent swells rolling across the lower frame."""
import math
import cairo

from ..util import SmoothNoise, TAU
from ..sprites import glow_sprite, draw_glow, draw_surface, vgradient_sprite
from .base import Scene


class OceanSwell(Scene):
    name = "Ocean Swell"
    phase = "liquid"
    family = "liquid"
    duration = (26.0, 46.0)

    STEPS = 120

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.layers = []
        for i in range(4):
            self.layers.append({
                'base_y': 0.26 + i * 0.155,
                'amp': (0.05 + i * 0.025) * rng.uniform(0.8, 1.2),
                'wavelength': rng.uniform(0.0022, 0.005),
                'speed': rng.uniform(0.30, 0.75) * (1.0 + i * 0.18),
                'phase': rng.uniform(0, TAU),
                'alpha': 0.20 + i * 0.045,
                'idx': i % 3,
            })

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)

    def _wave_y(self, layer, x_frac, elapsed):
        mod = 0.6 + 0.6 * self.noise(elapsed * 0.06 + layer['phase'] + x_frac * 1.4)
        return layer['base_y'] + (
            math.sin(x_frac * layer['wavelength'] * self.w * TAU + elapsed * layer['speed'] + layer['phase'])
            * layer['amp'] * mod
            + self.noise(elapsed * 0.10 + layer['phase'] + x_frac * 1.6) * layer['amp'] * 0.45)

    def _crest_path(self, ctx, layer, elapsed):
        steps = self.STEPS
        pts = []
        for i in range(steps + 1):
            xf = i / steps
            pts.append((xf * self.w, self._wave_y(layer, xf, elapsed) * self.h))
        ctx.move_to(pts[0][0], pts[0][1])
        for i in range(1, len(pts)):
            ctx.line_to(pts[i][0], pts[i][1])

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        # pale glow low in the sky
        surf = glow_sprite(self.palette.accent(0), 128, 0.26, 0.12)
        draw_glow(ctx, surf, self.w * 0.5, self.h * 0.94, self.w * 0.75, 0.5, cairo.OPERATOR_ADD)
        # soft glow hugging the horizon so the upper frame isn't empty
        surf = glow_sprite(self.palette.accent(0), 128, 0.20, 0.12)
        draw_glow(ctx, surf, self.w * 0.5, self.h * 0.28, self.w * 0.9, 0.70, cairo.OPERATOR_ADD)
        for layer in self.layers:
            r, g, b = self.palette.accent(layer['idx'])
            grad = vgradient_sprite((r, g, b),
                                    [(0.0, layer['alpha']), (0.6, layer['alpha'] * 0.45), (1.0, 0.0)],
                                    width=8, height=220)
            # fill region under the crest
            ctx.save()
            ctx.new_path()
            self._crest_path(ctx, layer, elapsed)
            ctx.line_to(self.w, self.h)
            ctx.line_to(0, self.h)
            ctx.close_path()
            ctx.clip()
            draw_surface(ctx, grad, 0, 0, self.w, self.h)
            ctx.restore()
            # soft crest: wide translucent stroke + thin bright core
            ctx.save()
            ctx.set_operator(cairo.OPERATOR_ADD)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.set_source_rgba(r, g, b, layer['alpha'] * 1.6)
            ctx.set_line_width(6.0)
            ctx.new_path()
            self._crest_path(ctx, layer, elapsed)
            ctx.stroke()
            ctx.set_source_rgba(min(1.0, r * 1.4), min(1.0, g * 1.4), min(1.0, b * 1.4), layer['alpha'] * 2.4)
            ctx.set_line_width(1.6)
            ctx.new_path()
            self._crest_path(ctx, layer, elapsed)
            ctx.stroke()
            ctx.restore()
