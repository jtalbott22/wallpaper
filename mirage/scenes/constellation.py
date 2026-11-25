"""Solid: a constellation of drifting nodes, joined when nearby."""
import math
import cairo

from ..util import SmoothNoise, clamp, TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class ConstellationDrift(Scene):
    name = "Constellation Drift"
    phase = "solid"
    family = "solid"
    duration = (24.0, 42.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.nodes = []
        for _ in range(70):
            self.nodes.append({
                'bx': rng.uniform(0.06, 0.94),
                'by': rng.uniform(0.08, 0.92),
                'phase': rng.uniform(0, TAU),
                'idx': rng.randint(0, 3),
                'size': rng.uniform(0.6, 1.5),
                'tw': rng.uniform(1.2, 2.8),
            })

    def _pos(self, n, elapsed):
        return (n['bx'] + self.noise(elapsed * 0.09 + n['phase']) * 0.045,
                n['by'] + self.noise(elapsed * 0.11 + n['phase'] * 1.3 + 50.0) * 0.045)

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        pos = [self._pos(n, elapsed) for n in self.nodes]
        # lines
        max_d2 = 0.13 * 0.13
        ctx.save()
        for i in range(len(pos)):
            for j in range(i + 1, len(pos)):
                dx = pos[i][0] - pos[j][0]
                dy = pos[i][1] - pos[j][1]
                d2 = dx * dx + dy * dy
                if d2 < max_d2:
                    d = math.sqrt(d2)
                    a = (1.0 - d / 0.13) * 0.30
                    r, g, b = self.palette.accent(self.nodes[i]['idx'])
                    # simple mid color blend
                    r2, g2, b2 = self.palette.accent(self.nodes[j]['idx'])
                    r = (r + r2) * 0.5; g = (g + g2) * 0.5; b = (b + b2) * 0.5
                    ctx.set_source_rgba(r, g, b, a)
                    ctx.move_to(pos[i][0] * self.w, pos[i][1] * self.h)
                    ctx.line_to(pos[j][0] * self.w, pos[j][1] * self.h)
                    ctx.stroke()
        ctx.restore()
        ctx.save()
        ctx.set_line_width(0.8)
        # nodes
        for n, (x, y) in zip(self.nodes, pos):
            twinkle = 0.72 + 0.28 * math.sin(elapsed * n['tw'] + n['phase'])
            surf = glow_sprite(self.palette.accent(n['idx']), 32)
            size = n['size'] * 22
            draw_glow(ctx, surf, x * self.w, y * self.h, size, twinkle * 0.8)
        ctx.restore()
