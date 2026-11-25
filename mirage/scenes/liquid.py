"""Liquid: soft particles advected by a swirling pseudo-noise field."""
import math
import cairo

from ..util import clamp
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class LiquidFlow(Scene):
    name = "Liquid Flow"
    phase = "liquid"
    family = "liquid"
    duration = (24.0, 44.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.seed_x = rng.uniform(0, 1000)
        self.seed_y = rng.uniform(0, 1000)
        self.particles = []
        N = 90
        for _ in range(N):
            x, y = rng.uniform(0, 1), rng.uniform(0, 1)
            self.particles.append({
                'x': x, 'y': y, 'px': x, 'py': y,
                'size': rng.uniform(0.5, 1.4),
                'idx': rng.randint(0, 3),
                'speed': rng.uniform(0.35, 0.75),
                'life': rng.uniform(0.4, 1.0),
            })

    def _angle(self, x, y, t):
        return (math.sin(y * 0.0045 + t * 0.25 + self.seed_x)
                + math.cos(x * 0.0045 - t * 0.21 + self.seed_y)) * 1.1

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        for p in self.particles:
            p['px'], p['py'] = p['x'], p['y']
            a = self._angle(p['x'], p['y'], elapsed)
            p['x'] += math.cos(a) * p['speed'] * dt * 0.05
            p['y'] += math.sin(a) * p['speed'] * dt * 0.05
            # gentle attraction toward the pointer (phantom cursor too)
            dx = (pointer[0] - p['x'])
            dy = (pointer[1] - p['y'])
            dist = math.hypot(dx, dy)
            if dist < 0.28:
                pull = (0.28 - dist) * 0.35
                p['x'] += dx * pull * dt * 4.0
                p['y'] += dy * pull * dt * 4.0
            p['x'] = (p['x'] + 1.0) % 1.0
            p['y'] = (p['y'] + 1.0) % 1.0

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        max_line = 0.09
        for p in self.particles:
            x = p['x'] * self.w
            y = p['y'] * self.h
            px = p['px'] * self.w
            py = p['py'] * self.h
            line_len = math.hypot(x - px, y - py) / max(self.w, 1)
            if line_len > max_line:
                # wrap-safe line: skip if it jumped across the seam
                continue
            r, g, b = self.palette.accent(p['idx'])
            ctx.save()
            ctx.set_source_rgba(r, g, b, 0.35 * p['life'])
            ctx.set_line_width(1.4)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.move_to(px, py)
            ctx.line_to(x, y)
            ctx.stroke()
            ctx.restore()
            surf = glow_sprite(self.palette.accent(p['idx']), 24)
            draw_glow(ctx, surf, x, y, p['size'] * 26, 0.55, cairo.OPERATOR_ADD)
