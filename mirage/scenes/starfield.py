"""Void: a slow parallax starfield with occasional shooting stars."""
import math
import cairo

from ..util import TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class StarfieldHorizon(Scene):
    name = "Starfield Horizon"
    phase = "void"
    family = "void"
    duration = (24.0, 44.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.stars = []
        for layer in range(3):
            n = (140, 80, 36)[layer]
            for _ in range(n):
                self.stars.append({
                    'x': rng.uniform(0, 1), 'y': rng.uniform(0, 1),
                    'layer': layer,
                    'size': (0.9 + layer * 0.7) * rng.uniform(0.7, 1.4),
                    'tw': rng.uniform(1.0, 3.4),
                    'phase': rng.uniform(0, TAU),
                })
        self.shoot = None
        self._next_shoot = rng.uniform(6.0, 16.0)

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        speeds = (0.004, 0.010, 0.022)
        for s in self.stars:
            s['y'] += speeds[s['layer']] * dt
            if s['y'] > 1.02:
                s['y'] = -0.02
                s['x'] = self.rng.uniform(0, 1)
        self._next_shoot -= dt
        if self._next_shoot <= 0.0 and self.shoot is None:
            self.shoot = {'x': self.rng.uniform(0.15, 0.85), 'y': self.rng.uniform(0.05, 0.4),
                          'vx': self.rng.uniform(-0.35, 0.35),
                          'vy': self.rng.uniform(0.35, 0.6),
                          'life': 1.0}
            self._next_shoot = self.rng.uniform(9.0, 22.0)
        if self.shoot:
            sh = self.shoot
            sh['x'] += sh['vx'] * dt
            sh['y'] += sh['vy'] * dt
            sh['life'] -= dt * 1.6
            if sh['life'] <= 0.0:
                self.shoot = None

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        ctx.save()
        for s in self.stars:
            tw = 0.55 + 0.45 * math.sin(elapsed * s['tw'] + s['phase'])
            alpha = (0.35 + 0.65 * tw) * (0.55 + 0.45 * s['layer'] / 2.0)
            if s['layer'] == 2:
                surf = glow_sprite(self.palette.accent(0), 32)
                size = s['size'] * 22
                draw_glow(ctx, surf, s['x'] * self.w, s['y'] * self.h, size, alpha)
            else:
                ctx.set_source_rgba(1.0, 0.98, 0.95, alpha)
                ctx.arc(s['x'] * self.w, s['y'] * self.h, s['size'] * 1.3, 0, TAU)
                ctx.fill()
        ctx.restore()
        if self.shoot:
            sh = self.shoot
            x = sh['x'] * self.w
            y = sh['y'] * self.h
            tail = 0.06
            ctx.save()
            ctx.set_operator(cairo.OPERATOR_ADD)
            ctx.set_line_width(1.8)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.set_source_rgba(1.0, 0.98, 0.92, sh['life'] * 0.85)
            ctx.move_to(x + -sh['vx'] * tail * self.w, y + -sh['vy'] * tail * self.h)
            ctx.line_to(x, y)
            ctx.stroke()
            surf = glow_sprite(self.palette.accent(0), 32)
            draw_glow(ctx, surf, x, y, 26, sh['life'], cairo.OPERATOR_ADD)
            ctx.restore()
