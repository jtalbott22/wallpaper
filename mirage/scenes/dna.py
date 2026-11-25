"""DNA: a slowly rotating double helix with rungs, drifting gently."""
import math
import cairo

from ..util import TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class DNAHelix(Scene):
    name = "DNA Helix"
    phase = "bio"
    family = "bio"
    duration = (24.0, 42.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.speed = rng.uniform(0.55, 0.9)
        self.width_frac = rng.uniform(0.13, 0.20)
        self.center_y = 0.5

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        cx = self.w * 0.5
        base_r = min(self.w, self.h)
        amp = self.width_frac * base_r
        top = 0.06 * self.h
        bottom = 0.94 * self.h
        n = 46
        spacing = (bottom - top) / (n - 1)
        points = []
        for i in range(n):
            y = top + i * spacing
            theta = elapsed * self.speed + i * 0.42
            xs = cx + math.sin(theta) * amp
            xs2 = cx + math.sin(theta + math.pi) * amp
            z = 0.5 + 0.5 * math.cos(theta)
            points.append((y, xs, xs2, z))
        # rungs
        ctx.save()
        ctx.set_line_width(1.3)
        for i in range(0, n, 2):
            y, xs, xs2, z = points[i]
            alpha = 0.16 + z * 0.32
            ctx.set_source_rgba(0.88, 0.93, 1.0, alpha)
            ctx.move_to(xs, y)
            ctx.line_to(xs2, y)
            ctx.stroke()
        ctx.restore()
        # soft heart glow behind the helix
        heart = glow_sprite(self.palette.accent(0), 128, 0.30, 0.12)
        draw_glow(ctx, heart, cx, self.h * 0.5, base_r * 0.95, 0.35, cairo.OPERATOR_ADD)
        # strands
        r_a, g_a, b_a = self.palette.accent(0)
        r_b, g_b, b_b = self.palette.accent(1)
        for i in range(n):
            y, xs, xs2, z = points[i]
            size = (8 + z * 18)
            surf_a = glow_sprite((r_a, g_a, b_a), 32)
            draw_glow(ctx, surf_a, xs, y, size, 0.35 + z * 0.65, cairo.OPERATOR_ADD)
            surf_b = glow_sprite((r_b, g_b, b_b), 32)
            draw_glow(ctx, surf_b, xs2, y, size, 0.35 + (1.0 - z) * 0.65, cairo.OPERATOR_ADD)
