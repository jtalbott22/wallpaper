"""Swarm: soft wandering fireflies with an occasional shy recoil from the cursor."""
import math
import cairo

from ..util import SmoothNoise, clamp, TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class FirefliesSwarm(Scene):
    name = "Fireflies Swarm"
    phase = "swarm"
    family = "swarm"
    duration = (24.0, 42.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.flies = []
        for _ in range(55):
            self.flies.append({
                'x': rng.uniform(0, 1), 'y': rng.uniform(0, 1),
                'heading': rng.uniform(0, TAU),
                'speed': rng.uniform(0.02, 0.05),
                'idx': rng.randint(0, 3),
                'size': rng.uniform(0.55, 1.25),
                'tw': rng.uniform(1.4, 3.2),
                'phase': rng.uniform(0, TAU),
            })

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        for f in self.flies:
            f['heading'] += self.noise(elapsed * 0.35 + f['phase']) * dt * 2.6
            # shy recoil from the pointer
            dx = f['x'] - pointer[0]
            dy = f['y'] - pointer[1]
            d = math.hypot(dx, dy)
            if d < 0.16 and d > 1e-4:
                push = (0.16 - d) * 6.0
                f['x'] += (dx / d) * push * dt
                f['y'] += (dy / d) * push * dt
            f['x'] += math.cos(f['heading']) * f['speed'] * dt
            f['y'] += math.sin(f['heading']) * f['speed'] * dt
            f['x'] = clamp(f['x'], -0.05, 1.05)
            f['y'] = clamp(f['y'], -0.05, 1.05)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        # faint horizon glow
        glow = glow_sprite(self.palette.accent(0), 128, 0.22, 0.12)
        draw_glow(ctx, glow, self.w * 0.5, self.h * 0.98, self.w * 0.8, 0.5, cairo.OPERATOR_ADD)
        for f in self.flies:
            tw = 0.5 + 0.5 * math.sin(elapsed * f['tw'] + f['phase'])
            alpha = 0.30 + 0.70 * tw
            x = f['x'] * self.w
            y = f['y'] * self.h
            surf = glow_sprite(self.palette.accent(f['idx']), 32)
            size = f['size'] * 26
            draw_glow(ctx, surf, x, y, size, alpha, cairo.OPERATOR_ADD)
