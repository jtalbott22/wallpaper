"""Plasma: warm embers rising and shimmering like an inverted flame."""
import math
import cairo

from ..util import SmoothNoise, clamp, TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class PlasmaRise(Scene):
    name = "Plasma Rise"
    phase = "plasma"
    family = "plasma"
    duration = (22.0, 40.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.embers = []
        for _ in range(70):
            self._spawn(self.embers, rng, initial=True)

    def _spawn(self, embers, rng, initial=False):
        embers.append({
            'x': rng.uniform(0.0, 1.0),
            'y': rng.uniform(0.0, 1.0) if initial else 1.05,
            'vy': rng.uniform(0.030, 0.085),
            'size': rng.uniform(0.008, 0.020),
            'idx': rng.randint(0, 3),
            'tw': rng.uniform(0, TAU),
            'life': 1.0,
        })

    def _respawn(self, ember, rng):
        ember['x'] = rng.uniform(0.0, 1.0)
        ember['y'] = 1.06
        ember['vy'] = rng.uniform(0.030, 0.085)
        ember['size'] = rng.uniform(0.008, 0.020)
        ember['idx'] = rng.randint(0, 3)
        ember['life'] = 1.0

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        for e in self.embers:
            e['y'] -= e['vy'] * dt
            e['x'] += self.noise(elapsed * 0.4 + e['tw']) * dt * 0.05
            e['life'] = clamp((e['y'] - 0.0) * 2.0, 0.0, 1.0) if e['y'] > 0.5 else clamp(e['life'] - dt * 0.1, 0.3, 1.0)
            e['life'] = clamp(e['life'] * (1.0 - dt * 0.01), 0.25, 1.0)
            if e['y'] < -0.06:
                self._respawn(e, self.rng)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        # warm glow low in the frame
        surf = glow_sprite(self.palette.accent(0), 128, inner_alpha=0.35, mid_alpha=0.2)
        draw_glow(ctx, surf, self.w * 0.5, self.h * 1.02, self.w * 0.85, 0.35, cairo.OPERATOR_ADD)
        for e in self.embers:
            twinkle = 0.7 + 0.3 * math.sin(elapsed * 2.2 + e['tw'])
            x = e['x'] * self.w
            y = e['y'] * self.h
            size = e['size'] * min(self.w, self.h) * 4.0
            surf = glow_sprite(self.palette.accent(e['idx']), 32)
            draw_glow(ctx, surf, x, y, size, e['life'] * twinkle * 0.85, cairo.OPERATOR_ADD)
