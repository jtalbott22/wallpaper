"""Adaptive quality: keeps the wallpaper smooth on weak hardware.

Watches an exponential moving average of frame time and steps the
internal render scale in or out. Raises slowly, lowers fast, and never
goes above 1.0 nor below 0.30.
"""


class QualityController:
    def __init__(self, quality=0.5, min_q=0.30, max_q=1.0, target_ms=26.0):
        self.quality = quality
        self.min_q = min_q
        self.max_q = max_q
        self.target_ms = target_ms
        self.ema_ms = target_ms
        self._since_check = 0
        self.evaluations = 0

    def observe(self, frame_ms):
        self.ema_ms = 0.9 * self.ema_ms + 0.1 * frame_ms
        self._since_check += 1
        if self._since_check < 90:
            return self.quality
        self._since_check = 0
        self.evaluations += 1
        if self.ema_ms > self.target_ms * 1.45:
            self.quality = max(self.min_q, self.quality - 0.12)
        elif self.ema_ms < self.target_ms * 0.75 and self.evaluations % 3 == 0:
            self.quality = min(self.max_q, self.quality + 0.06)
        return self.quality
