"""Orbital Garden: a slowly turning star system with fading trails."""
import math
import cairo

from ..util import TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class OrbitalGarden(Scene):
    name = "Orbital Garden"
    phase = "orbital"
    family = "cosmos"
    duration = (26.0, 46.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.bodies = []
        n = rng.randint(3, 5)
        for i in range(n):
            self.bodies.append({
                'r': 0.14 + i * 0.105 + rng.uniform(-0.02, 0.03),
                'speed': rng.uniform(0.10, 0.16) / (1.0 + i * 0.35),
                'angle': rng.uniform(0, TAU),
                'size': rng.uniform(0.9, 1.6),
                'idx': rng.randint(0, 3),
                'trail': [],
            })

    def cx_frac(self): return 0.5
    def cy_frac(self): return 0.52

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        # keep ring geometry and body motion in the SAME coordinate system:
        # radius measured in pixels relative to the smaller dimension
        base_r = min(self.w, self.h)
        cx = self.cx_frac() * self.w
        cy = self.cy_frac() * self.h
        for b in self.bodies:
            b['angle'] += b['speed'] * dt
            x = cx + math.cos(b['angle']) * b['r'] * base_r
            y = cy + math.sin(b['angle']) * b['r'] * 0.62 * base_r
            b['trail'].append((x, y))
            if len(b['trail']) > 26:
                b['trail'].pop(0)

    def _ellipse_path(self, ctx, cx, cy, rx, ry, segments=80):
        # absolute-coordinate path: no transforms, so repeated calls never
        # accumulate offsets (this used to leak translations across bodies)
        ctx.new_path()
        for i in range(segments + 1):
            a = i / segments * TAU
            x = cx + math.cos(a) * rx
            y = cy + math.sin(a) * ry
            if i == 0:
                ctx.move_to(x, y)
            else:
                ctx.line_to(x, y)
        ctx.close_path()

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        cx = self.cx_frac() * self.w
        cy = self.cy_frac() * self.h
        base_r = min(self.w, self.h)
        # orbit rings (thin translucent ellipses)
        ctx.save()
        ctx.set_line_width(0.8)
        for b in self.bodies:
            r, g, bl = self.palette.accent(b['idx'])
            ctx.set_source_rgba(r, g, bl, 0.16)
            self._ellipse_path(ctx, cx, cy, b['r'] * base_r, b['r'] * base_r * 0.62)
            ctx.stroke()
        ctx.restore()
        # star (center)
        pulse = 0.9 + 0.1 * math.sin(elapsed * 0.9)
        surf = glow_sprite(self.palette.accent(0), 128, 0.95, 0.4)
        draw_glow(ctx, surf, cx, cy, base_r * 0.30 * pulse, 0.95, cairo.OPERATOR_ADD)
        # trails
        for b in self.bodies:
            r, g, bl = self.palette.accent(b['idx'])
            trail = b['trail']
            n = len(trail)
            if n >= 2:
                ctx.save()
                ctx.set_line_width(1.4)
                ctx.set_line_cap(cairo.LINE_CAP_ROUND)
                for i in range(1, n):
                    alpha = (i / n) * 0.5
                    ctx.set_source_rgba(r, g, bl, alpha)
                    ctx.move_to(trail[i-1][0], trail[i-1][1])
                    ctx.line_to(trail[i][0], trail[i][1])
                    ctx.stroke()
                ctx.restore()
        # bodies
        for b in self.bodies:
            if not b['trail']:
                continue
            x, y = b['trail'][-1]
            r, g, bl = self.palette.accent(b['idx'])
            surf = glow_sprite((r, g, bl), 32)
            draw_glow(ctx, surf, x, y, b['size'] * 30, 0.95, cairo.OPERATOR_ADD)
