"""Base class for all Mirage scenes."""
import math
import cairo

from ..sprites import draw_surface, bg_gradient_sprite


class Scene:
    name = "Scene"
    phase = ""
    family = ""
    duration = (22.0, 42.0)

    def __init__(self, rng, palette, width, height):
        self.rng = rng
        self.palette = palette
        self.w = width
        self.h = height
        self.age = 0.0

    def resize(self, width, height):
        self.w = width
        self.h = height

    def on_change(self, palette):
        self.palette = palette
        self.age = 0.0

    def update(self, dt, elapsed, pointer):
        self.age += dt

    def draw(self, ctx, elapsed, pointer):
        raise NotImplementedError

    def background(self, ctx):
        p = self.palette
        bg = bg_gradient_sprite(p.bg, p.bg2, height=128)
        draw_surface(ctx, bg, 0, 0, self.w, self.h)

    def glow_color(self, i=0):
        return self.palette.accent(i)

    def accent_alpha(self, i, alpha):
        r, g, b = self.palette.accent(i)
        return (r, g, b, alpha)
