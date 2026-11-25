"""Fractal Mirror: a slowly revolving recursive spiral - self-similar by design."""
import math
import cairo

from ..util import TAU, SmoothNoise
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class FractalMirror(Scene):
    name = "Fractal Mirror"
    phase = "fractal"
    family = "fractal"
    duration = (26.0, 44.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.rot_speed = rng.uniform(0.05, 0.10)
        self.seed = rng.uniform(0, 1000)
        self.rings = 7
        self.dots_per_ring = 44
        self.scale = rng.uniform(0.020, 0.026)

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        cx = self.w * 0.5
        cy = self.h * 0.5
        base_r = min(self.w, self.h) * 0.46
        rot = elapsed * self.rot_speed
        # slow breathing zoom
        zoom = 1.0 + 0.06 * math.sin(elapsed * 0.23)
        # halo behind everything
        halo = glow_sprite(self.palette.accent(0), 128, 0.22, 0.10)
        draw_glow(ctx, halo, cx, cy, base_r * 2.1 * zoom, 0.5, cairo.OPERATOR_ADD)
        # recursive spiral rings
        for k in range(self.rings):
            ring_frac = k / (self.rings - 1)          # 0 inner .. 1 outer
            radius = base_r * self.scale * zoom * (1.0 + k * 0.55) * (0.55 + 0.45 * math.sin(elapsed * 0.31 + k))
            radius = base_r * (0.10 + ring_frac * 0.95) * zoom * 0.95
            alpha = 0.75 - ring_frac * 0.5
            idx = k % 3
            surf = glow_sprite(self.palette.accent(idx), 24)
            count = self.dots_per_ring
            for i in range(count):
                theta = (i / count) * TAU + rot * (0.6 + ring_frac * 0.8)
                # self-similarity: modulate radius by ring-scaled harmonic
                r = radius * (1.0 + 0.14 * math.sin(theta * (2 + k % 3) + elapsed * 0.4 + k))
                x = cx + math.cos(theta) * r
                y = cy + math.sin(theta) * r * 0.92
                size = (2.5 + (1.0 - ring_frac) * 9.0) * (0.75 + 0.25 * math.sin(elapsed * 1.3 + i))
                alpha_dot = alpha * (0.55 + 0.45 * math.sin(elapsed * 0.9 + i * 0.7 + k))
                draw_glow(ctx, surf, x, y, size, max(0.05, alpha_dot), cairo.OPERATOR_ADD)
        # center heart
        heart = glow_sprite(self.palette.accent(1), 64, 0.9, 0.35)
        draw_glow(ctx, heart, cx, cy, base_r * 0.30 * zoom, 0.9, cairo.OPERATOR_ADD)
