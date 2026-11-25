"""Scene scheduler: never repeats back-to-back, drifts durations and palettes."""
import random

from .palettes import PALETTES
from .scenes.registry import SCENES


class Scheduler:
    def __init__(self, screen_w, screen_h, seed=None, initial_scene=None, initial_palette=None):
        self.rng = random.Random(seed)
        self.screen_w = screen_w
        self.screen_h = screen_h
        self._history = []
        self._palette_history = []
        self.current = None
        self.current_palette = None
        self.elapsed_in_scene = 0.0
        self.duration = self.rng.uniform(*SCENES[0].duration)
        self._initial_scene = initial_scene
        self._initial_palette = initial_palette
        self._pick_next()

    def _resolve_initial(self):
        """Consume the one-shot initial overrides, returning them or None."""
        scene = self._initial_scene
        palette = self._initial_palette
        self._initial_scene = None
        self._initial_palette = None
        return scene, palette

    def _push_history(self, scene_cls, palette):
        self._history.append(scene_cls.name)
        if len(self._history) > 3:
            self._history.pop(0)
        self._palette_history.append(palette.name)
        if len(self._palette_history) > 3:
            self._palette_history.pop(0)

    def _make_current(self, scene_cls, palette):
        self._push_history(scene_cls, palette)
        self.current = scene_cls(self.rng, palette, self.screen_w, self.screen_h)
        self.current_palette = palette
        self.duration = self.rng.uniform(*scene_cls.duration)
        self.elapsed_in_scene = 0.0

    def _pick_next(self):
        initial_scene, initial_palette = self._resolve_initial()

        # forced scene/palette: scene name wins, palette disambiguates or is random
        if initial_scene is not None:
            scene_cls = next((s for s in SCENES if s.name == initial_scene), None)
            if scene_cls is None:
                raise ValueError(f"unknown scene: {initial_scene}")
            if initial_palette is not None:
                palette = next((p for p in PALETTES if p.name == initial_palette), None)
                if palette is None:
                    raise ValueError(f"unknown palette: {initial_palette}")
            else:
                palette = self.rng.choice(PALETTES)
            self._make_current(scene_cls, palette)
            return

        # palette-only override: scene is still randomized
        if initial_palette is not None:
            palette = next((p for p in PALETTES if p.name == initial_palette), None)
            if palette is None:
                raise ValueError(f"unknown palette: {initial_palette}")
            pool = [s for s in SCENES if s.name not in self._history]
            if not pool:
                self._history = self._history[-2:]
                pool = [s for s in SCENES if s.name not in self._history]
            scene_cls = self.rng.choice(pool)
            self._make_current(scene_cls, palette)
            return

        # normal pick
        pool = [s for s in SCENES if s.name not in self._history]
        if not pool:
            self._history = self._history[-2:]
            pool = [s for s in SCENES if s.name not in self._history]
        scene_cls = self.rng.choice(pool)
        palette_pool = [p for p in PALETTES if p.name not in self._palette_history]
        if not palette_pool:
            self._palette_history = self._palette_history[-2:]
            palette_pool = [p for p in PALETTES if p.name not in self._palette_history]
        palette = self.rng.choice(palette_pool)
        self._make_current(scene_cls, palette)

    def advance(self, dt, elapsed, pointer):
        """Update current scene. Returns (changed, palette)."""
        changed = False
        self.elapsed_in_scene += dt
        if self.elapsed_in_scene >= self.duration:
            self._pick_next()
            changed = True
            return changed, self.current_palette
        self.current.update(dt, elapsed, pointer)
        return changed, self.current_palette

    def force_next(self, elapsed, pointer):
        """Manual skip (user pressed space/n)."""
        self._pick_next()
        return True, self.current_palette

    def draw(self, ctx, elapsed, pointer):
        self.current.draw(ctx, elapsed, pointer)

    def resize(self, screen_w, screen_h):
        self.screen_w = screen_w
        self.screen_h = screen_h
        if self.current is not None:
            self.current.resize(screen_w, screen_h)
