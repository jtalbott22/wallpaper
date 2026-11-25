"""Math helpers and smooth noise for Mirage."""
import math
import random


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)


def lerp(a, b, t):
    return a + (b - a) * t


def ease_in_out(t):
    t = clamp(t)
    return t * t * (3.0 - 2.0 * t)


def ease_out_cubic(t):
    t = clamp(t)
    return 1.0 - (1.0 - t) ** 3


TAU = 2.0 * math.pi


def rand_range(rng, lo, hi):
    return lo + (hi - lo) * rng.random()


class SmoothNoise:
    """1-D smooth noise from a sum of sinusoids.

    Deterministic given a seed, so scenes drift gently without
    ever repeating exactly.
    """

    def __init__(self, seed, n_harmonics=4):
        rng = random.Random(seed)
        self.harmonics = []
        for i in range(n_harmonics):
            # integer-ish frequency, so the noise is periodic in a very
            # long window, avoiding obvious loops over minutes
            f = 1.0 + i * 2.0 + rng.random()
            amp = 1.0 / (i + 1.0)
            phase = rng.random() * TAU
            self.harmonics.append((f, amp, phase))
        self.max_amp = sum(amp for _, amp, _ in self.harmonics)

    def __call__(self, t):
        """Return value in roughly [-1, 1]."""
        v = 0.0
        for f, amp, phase in self.harmonics:
            v += amp * math.sin(t * f * 0.37 + phase)
        return v / self.max_amp


class RNG:
    """Small wrapper so scenes share one seeded random stream."""

    def __init__(self, seed=None):
        self._rng = random.Random(seed)

    def random(self):
        return self._rng.random()

    def uniform(self, lo, hi):
        return lo + (hi - lo) * self._rng.random()

    def gauss(self, mu=0.0, sigma=1.0):
        return self._rng.gauss(mu, sigma)

    def choice(self, seq):
        return self._rng.choice(seq)

    def randint(self, lo, hi):
        return self._rng.randint(lo, hi)

    def shuffled(self, seq):
        lst = list(seq)
        self._rng.shuffle(lst)
        return lst
