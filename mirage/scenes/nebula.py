"""Gas: slow drifting soft blobs, like an evolving nebula."""
import math
import cairo

from ..util import SmoothNoise, clamp, TAU
from ..sprites import glow_sprite, draw_glow
from .base import Scene


class NebulaDrift(Scene):
    name = "Nebula Drift"
    phase = "gas"
    family = "gas"
    duration = (26.0, 46.0)

    def __init__(self, rng, palette, width, height):
        super().__init__(rng, palette, width, height)
        self.noise = SmoothNoise(rng.uniform(1, 1000))
        self.blobs = []
        # jittered grid: guarantees full, even coverage of the frame
        cells = [(cx, cy) for cx in (0.18, 0.5, 0.82) for cy in (0.20, 0.5, 0.80)]
        # pick 8 cells without relying on a shuffle() method (raw Random and
        # the RNG wrapper have different helper APIs)
        chosen = []
        while cells and len(chosen) < 8:
            i = min(int(rng.random() * len(cells)), len(cells) - 1)
            chosen.append(cells.pop(i))
        for i in range(len(chosen)):
            bx = chosen[i][0] + rng.uniform(-0.10, 0.10)
            by = chosen[i][1] + rng.uniform(-0.10, 0.10)
            bx = clamp(bx, 0.10, 0.90)
            by = clamp(by, 0.10, 0.90)
            self.blobs.append({
                'bx': bx,
                'by': by,
                'x': bx,
                'y': by,
                'size': rng.uniform(0.24, 0.42),
                'idx': rng.randint(0, 3),
                'phase': rng.uniform(0, TAU),
                'speed': rng.uniform(0.4, 1.0),
                'alpha': rng.uniform(0.26, 0.44),
            })

    def update(self, dt, elapsed, pointer):
        super().update(dt, elapsed, pointer)
        for blob in self.blobs:
            # oscillate gently around a stable base position: this keeps the
            # frame evenly filled instead of letting blobs drift off-frame
            t = elapsed * 0.05 * blob['speed'] + blob['phase']
            blob['x'] = clamp(blob['bx'] + self.noise(t) * 0.10, 0.03, 0.97)
            blob['y'] = clamp(blob['by'] + self.noise(t * 1.7 + 40.0) * 0.08, 0.03, 0.97)

    def draw(self, ctx, elapsed, pointer):
        self.background(ctx)
        for blob in self.blobs:
            pulse = 0.82 + 0.18 * math.sin(elapsed * 0.35 * blob['speed'] + blob['phase'])
            x = blob['x'] * self.w
            y = blob['y'] * self.h
            size = blob['size'] * min(self.w, self.h) * 1.35
            surf = glow_sprite(self.palette.accent(blob['idx']), 64)
            draw_glow(ctx, surf, x, y, size, blob['alpha'] * pulse, cairo.OPERATOR_ADD)
