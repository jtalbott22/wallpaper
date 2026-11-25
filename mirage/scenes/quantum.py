"""Quantum: a lattice of nodes pulsing with wave interference from the cursor."""
import math
import cairo

from ..util import clamp, TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class QuantumInterference(Scene):
    name = "Quantum Interference"
    phase = "quantum"
    family = "quantum"
    duration = (24.0, 44.0)

    COLS = 9
    ROWS = 6

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.rings = []          # expanding interference rings
        self._next_ring = 1.5

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        # spawn expanding rings from the pointer position
        self._next_ring -= dt
        if self._next_ring <= 0.0:
            self.rings.append({'x': pointer[0], 'y': pointer[1], 'r': 0.0, 'alpha': 0.55})
            self._next_ring = 2.6 + self.rng.uniform(0.0, 1.2)
        for ring in self.rings:
            ring['r'] += dt * 0.35
            ring['alpha'] -= dt * 0.30
        self.rings = [r for r in self.rings if r['alpha'] > 0.02 and r['r'] < 1.4]

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        cols, rows = self.COLS, self.ROWS
        for i in range(cols):
            for j in range(rows):
                x = (i + 0.5) / cols
                y = (j + 0.5) / rows
                # interference of two sources: pointer + central bias
                d_ptr = math.hypot(x - pointer[0], y - pointer[1])
                d_center = math.hypot(x - 0.5, y - 0.55)
                v = abs(math.sin(d_ptr * 34 - elapsed * 2.6) * 0.65
                       + math.sin(d_center * 26 - elapsed * 1.9) * 0.55)
                v = clamp(v, 0.0, 1.0)
                alpha = 0.14 + v * 0.75
                r, g, b = self.palette.accent((i + j) % 4)
                surf = glow_sprite((r, g, b), 32)
                size = 7 + v * 26
                draw_glow(ctx, surf, x * self.w, y * self.h, size, alpha, cairo.OPERATOR_ADD)
        # expanding rings
        for ring in self.rings:
            ctx.save()
            r, g, b = self.palette.accent(0)
            ctx.set_source_rgba(r, g, b, ring['alpha'] * 0.6)
            ctx.set_line_width(1.6)
            ctx.arc(ring['x'] * self.w, ring['y'] * self.h,
                    ring['r'] * min(self.w, self.h), 0, TAU)
            ctx.stroke()
            ctx.restore()
        # pointer presence
        surf = glow_sprite(self.palette.accent(0), 64, 0.8, 0.3)
        draw_glow(ctx, surf, pointer[0] * self.w, pointer[1] * self.h, 46, 0.5, cairo.OPERATOR_ADD)
