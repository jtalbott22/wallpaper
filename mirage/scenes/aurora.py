"""Aurora: wide translucent curtains of light, swaying gently across the sky."""
import math
import cairo

from ..util import SmoothNoise, TAU
from ..sprites import glow_sprite, draw_glow, curtain_sprite
from .base import Scene


class AuroraRibbons(Scene):
    name = "Aurora Curtain"
    phase = "plasma"
    family = "plasma"
    duration = (26.0, 44.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.ribbons = []
        n = 5
        for i in range(n):
            # spread curtains across the full frame so no region is dark
            base_x = (i + 0.5) / n + rng.uniform(-0.04, 0.04)
            self.ribbons.append({
                'base_x': base_x,
                'width': rng.uniform(0.24, 0.36),
                'height': rng.uniform(1.35, 1.55),
                'speed': rng.uniform(0.12, 0.34),
                'phase': rng.uniform(0, TAU),
                'idx': rng.randint(0, 2),
                'alpha': rng.uniform(0.46, 0.62),
                'tilt': rng.uniform(-0.05, 0.05),
            })

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        # dim glow high in the sky
        surf = glow_sprite(self.palette.accent(0), 128, 0.18, 0.12)
        draw_glow(ctx, surf, self.w * 0.5, self.h * 0.04, self.w * 1.0, 0.60, cairo.OPERATOR_ADD)
        # soft reflected glow along the bottom so the lower frame isn't empty
        surf = glow_sprite(self.palette.accent(2), 128, 0.15, 0.10)
        draw_glow(ctx, surf, self.w * 0.5, self.h * 1.04, self.w * 0.95, 0.65, cairo.OPERATOR_ADD)
        for rib in self.ribbons:
            r, g, b = self.palette.accent(rib['idx'])
            sway = math.sin(elapsed * rib['speed'] + rib['phase']) * 0.05
            drift = self.noise(elapsed * 0.35 + rib['phase']) * 0.06
            x_frac = rib['base_x'] + sway + drift
            breathe = 0.75 + 0.25 * math.sin(elapsed * (rib['speed'] * 0.5) + rib['phase'] * 2.0)
            alpha = rib['alpha'] * breathe
            grad = curtain_sprite((r, g, b), 64, 128)
            tilt = rib['tilt'] + math.sin(elapsed * rib['speed'] * 0.5 + rib['phase']) * 0.045
            # wide soft pass
            ctx.save()
            ctx.translate(x_frac * self.w, -self.h * 0.20)
            ctx.rotate(tilt)
            ctx.scale((rib['width'] * self.w) / 64, (rib['height'] * self.h) / 128)
            ctx.set_operator(cairo.OPERATOR_ADD)
            ctx.set_source_surface(grad, 0, 0)
            ctx.paint_with_alpha(alpha)
            ctx.restore()
            # narrow bright core pass (brighter, softer-edged column)
            ctx.save()
            ctx.translate(x_frac * self.w, -self.h * 0.20)
            ctx.rotate(tilt)
            ctx.scale((rib['width'] * self.w * 0.42) / 64, (rib['height'] * self.h) / 128)
            ctx.set_operator(cairo.OPERATOR_ADD)
            ctx.set_source_surface(grad, 0, 0)
            ctx.paint_with_alpha(alpha * 0.55)
            ctx.restore()
            # bright shimmer at the top of the curtain
            surf = glow_sprite((r, g, b), 64, min(1.0, alpha * 1.4), alpha * 0.9)
            draw_glow(ctx, surf, x_frac * self.w, self.h * 0.05,
                      rib['width'] * self.w * 1.25, alpha * 0.55, cairo.OPERATOR_ADD)
