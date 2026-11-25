"""Curated gradient palettes, built as 256-texel linear-light textures.

Every palette starts near black so it can map density / intensity directly
onto a dark desktop without glare.
"""
import math

from . import gl as G

PALETTES = {
    'ember':    ['#000000', '#1a0510', '#6b0f1a', '#d9480f', '#ffb347', '#fff3c4'],
    'abyss':    ['#000005', '#021a3a', '#035e7b', '#11b5a4', '#9ff7e0', '#ffffff'],
    'aurora':   ['#01030a', '#0b2a3c', '#087f5b', '#63e6be', '#d0bfff', '#ffffff'],
    'nebula':   ['#020008', '#2a0a4a', '#7b2cbf', '#e0529c', '#ffb86b', '#fff4e0'],
    'glacier':  ['#000308', '#0a2540', '#1971c2', '#74c0fc', '#e7f5ff', '#ffffff'],
    'gilded':   ['#000000', '#1c1200', '#5c3d00', '#c08a1e', '#ffd77a', '#fffaf0'],
    'orchid':   ['#050008', '#3a0a2a', '#a61e4d', '#f783ac', '#ffe3ec', '#ffffff'],
    'verdant':  ['#000400', '#0b2a14', '#2b8a3e', '#a9e34b', '#f4fce3', '#ffffff'],
    'magma':    ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
    'opal':     ['#05040a', '#23395b', '#406e8e', '#8ea8c3', '#cbf7ed', '#ffffff'],
    'dusk':     ['#05010a', '#2d1b4e', '#6a2c70', '#b83b5e', '#f08a5d', '#f9ed69'],
    'neon':     ['#000008', '#10002b', '#3c096c', '#7b2cbf', '#00d4ff', '#e0fbff'],
    'silver':   ['#000000', '#101418', '#3a4550', '#8a99a8', '#dfe7ee', '#ffffff'],
    'tidepool': ['#000204', '#06263a', '#1b6c8c', '#e9a03b', '#fbe3b0', '#ffffff'],
    'reef':     ['#020006', '#1d0b3a', '#0f6f8f', '#2ec4b6', '#ff9f1c', '#fff1d6'],
}


def _hex(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


def _lin(c):
    return c ** 2.2


def sample(name, x):
    stops = [_hex(h) for h in PALETTES[name]]
    n = len(stops) - 1
    x = min(max(x, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    f = x - i
    f = f * f * (3 - 2 * f)  # smooth between stops
    a, b = stops[i], stops[i + 1]
    return [_lin(a[k] + (b[k] - a[k]) * f) for k in range(3)]


def build(name, n=256):
    out = []
    for i in range(n):
        out.extend(sample(name, i / (n - 1)) + [1.0])
    return out


class PaletteTexture:
    """A palette that can crossfade to another one over time."""

    def __init__(self, rng, name=None):
        self.rng = rng
        self.names = list(PALETTES)
        self.cur = name or rng.choice(self.names)
        self.target = None
        self.mix = 0.0
        self.mix_speed = 0.0
        self.tex = G.Texture(256, 1, G.RGBA32F, G.LINEAR, G.CLAMP_TO_EDGE)
        self._a = build(self.cur)
        self._b = None
        self.tex.upload_floats(self._a)
        self.next_change = rng.uniform(35, 70)
        self.t = 0.0

    def start_blend(self, name=None, seconds=10.0):
        choices = [n for n in self.names if n != self.cur]
        self.target = name or self.rng.choice(choices)
        self._b = build(self.target)
        self.mix = 0.0
        self.mix_speed = 1.0 / seconds

    def update(self, dt, auto=True):
        self.t += dt
        if auto and self.target is None and self.t > self.next_change:
            self.start_blend(seconds=self.rng.uniform(8, 14))
        if self.target is not None:
            self.mix = min(1.0, self.mix + dt * self.mix_speed)
            m = self.mix * self.mix * (3 - 2 * self.mix)
            a, b = self._a, self._b
            self.tex.upload_floats([a[i] + (b[i] - a[i]) * m for i in range(len(a))])
            if self.mix >= 1.0:
                self.cur, self._a, self.target, self._b = self.target, self._b, None, None
                self.t = 0.0
                self.next_change = self.rng.uniform(35, 70)

    def bind(self, unit=7):
        self.tex.bind(unit)
        return unit

    def delete(self):
        self.tex.delete()
