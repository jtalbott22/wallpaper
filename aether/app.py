"""GTK4 front end: a GLArea driven by the frame clock.

Window mode is for watching/testing (Space = next scene, F11 = fullscreen,
Esc = quit). Wallpaper mode is what the GNOME Shell extension launches: no
input handling; SIGUSR1 pauses, SIGUSR2 resumes; lower frame rate on battery.
SIGHUP re-reads the settings the top bar menu writes (see settings_path()).
"""
import json
import os
import signal
import sys
import time

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gtk, Gdk, GLib

from . import gl as G
from .gl import gl


def settings_path():
    """Settings shared with the GNOME Shell extension's top bar menu."""
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'aether', 'wallpaper.json')


def read_settings():
    try:
        with open(settings_path()) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


class AetherApp:
    def __init__(self, args):
        self.args = args
        self.wallpaper = args.wallpaper
        self.fps = max(1, args.fps)
        self.battery_fps = max(1, args.battery_fps)
        self.on_battery = False
        self.paused = False
        self.engine = None
        self.last_render = None
        self.last_frame_time = None
        self.frames = 0
        self.fps_t0 = time.monotonic()
        self.loop = GLib.MainLoop()
        # brightness, scene and "next scene" from the top bar menu (wallpaper mode)
        self.level = 1.0
        self.next_count = None
        if self.wallpaper:
            self._apply_settings(first=True)

        self.window = Gtk.Window(title='Aether Wallpaper' if self.wallpaper else 'Aether')
        self.window.set_decorated(False)
        w, h = 1280, 720
        if self.wallpaper:
            mons = Gdk.Display.get_default().get_monitors()
            if mons.get_n_items():
                geo = mons.get_item(0).get_geometry()
                w, h = geo.width, geo.height
        self.window.set_default_size(w, h)
        self.window.connect('close-request', self._on_close)

        self.area = Gtk.GLArea()
        self.area.set_allowed_apis(Gdk.GLAPI.GL)
        self.area.set_required_version(4, 3)
        self.area.set_has_depth_buffer(False)
        self.area.set_has_stencil_buffer(False)
        self.area.set_auto_render(False)
        self.area.set_hexpand(True)
        self.area.set_vexpand(True)
        self.area.connect('realize', self._on_realize)
        self.area.connect('unrealize', self._on_unrealize)
        self.area.connect('render', self._on_render)
        self.window.set_child(self.area)

        if not self.wallpaper:
            keys = Gtk.EventControllerKey()
            keys.connect('key-pressed', self._on_key)
            self.window.add_controller(keys)
            if args.fullscreen:
                self.window.fullscreen()

    # ---- logging ---------------------------------------------------------------
    def log(self, msg):
        if self.args.debug:
            print(msg, file=sys.stderr, flush=True)

    # ---- GL lifecycle ----------------------------------------------------------
    def _on_realize(self, area):
        area.make_current()
        err = area.get_error()
        if err is not None:
            print(f'aether: cannot create an OpenGL 4.3 context: {err.message}', file=sys.stderr)
            self.loop.quit()
            return
        self.log(f'GL: {gl.GetString(G.RENDERER).decode()} | {gl.GetString(G.VERSION).decode()}')
        self.area.add_tick_callback(self._on_tick)

    def _on_unrealize(self, area):
        area.make_current()
        if self.engine:
            self.engine.release()
            self.engine = None

    def _on_render(self, area, context):
        fbo = G.get_int(G.FRAMEBUFFER_BINDING)
        _, _, vw, vh = G.get_int(G.VIEWPORT, 4)
        if vw < 16 or vh < 16:
            return True
        now = time.monotonic()
        dt = 1.0 / self.fps if self.last_render is None else now - self.last_render
        self.last_render = now
        # With fractional scaling GTK renders at the next integer scale and the
        # compositor shrinks it; size the simulation from the real pixel count.
        quality = self.args.quality
        surface = self.window.get_surface()
        if surface is not None and area.get_width() > 0:
            buffer_scale = vw / area.get_width()
            real_scale = surface.get_scale() if hasattr(surface, 'get_scale') else buffer_scale
            if buffer_scale > real_scale > 0:
                quality *= real_scale / buffer_scale
        if self.engine is None:
            from .engine import Engine
            self.engine = Engine(vw, vh, quality=quality, seed=self.args.seed,
                                 scene=self.args.scene, log=self.log)
            self.engine.level = self.engine._level = self.level
        elif (vw, vh) != (self.engine.out_w, self.engine.out_h) or abs(quality - self.engine.quality) > 1e-3:
            self.engine.resize(vw, vh, quality)
        try:
            self.engine.frame(dt, fbo, vw, vh)
        except Exception as e:  # never leave a frozen frame up silently
            print(f'aether: render error: {e}', file=sys.stderr, flush=True)
            raise
        self.frames += 1
        if self.args.debug and now - self.fps_t0 > 10:
            self.log(f'{self.frames / (now - self.fps_t0):.1f} fps at {vw}x{vh}')
            self.frames, self.fps_t0 = 0, now
        return True

    def _on_tick(self, widget, clock):
        if self.paused:
            return GLib.SOURCE_CONTINUE
        t = clock.get_frame_time() / 1e6
        fps = min(self.fps, self.battery_fps) if self.on_battery else self.fps
        # small tolerance so a 60 Hz clock lands cleanly on 30 fps
        if self.last_frame_time is None or t - self.last_frame_time >= 1.0 / fps - 0.004:
            self.last_frame_time = t
            self.area.queue_render()
        return GLib.SOURCE_CONTINUE

    # ---- input (window mode) ----------------------------------------------------
    def _on_key(self, ctrl, keyval, keycode, state):
        if keyval == Gdk.KEY_Escape:
            self.quit()
        elif keyval in (Gdk.KEY_space, Gdk.KEY_n):
            if self.engine:
                self.engine.skip()
        elif keyval == Gdk.KEY_F11:
            if self.window.is_fullscreen():
                self.window.unfullscreen()
            else:
                self.window.fullscreen()
        elif keyval == Gdk.KEY_p:
            self._set_paused(not self.paused)
        else:
            return False
        return True

    # ---- wallpaper plumbing -----------------------------------------------------
    def _apply_settings(self, first=False):
        d = read_settings()
        try:
            self.level = min(1.5, max(0.05, float(d.get('brightness', 1.0))))
        except (TypeError, ValueError):
            self.level = 1.0
        scene = d.get('scene') or None
        nxt = d.get('next', 0)
        if first:
            if scene and not self.args.scene:
                from .scenes import REGISTRY
                if any(c.name.lower() == str(scene).lower() for c in REGISTRY):
                    self.args.scene = scene
            self.next_count = nxt
            return GLib.SOURCE_CONTINUE
        self.log(f'Settings: brightness {self.level:.2f}, scene {scene or "all"}')
        eng = self.engine
        if eng is not None:
            eng.level = self.level
            if (scene or None) != (eng.forced_scene or None):
                from .scenes import REGISTRY
                if scene is None or any(c.name.lower() == str(scene).lower() for c in REGISTRY):
                    eng.forced_scene = scene
                    if scene:
                        eng.skip()
            if nxt != self.next_count:
                eng.skip()
            if self.paused:   # show the new brightness even while paused
                eng._level = self.level
                self.area.queue_render()
        self.next_count = nxt
        return GLib.SOURCE_CONTINUE

    def _set_paused(self, paused):
        if paused != self.paused:
            self.paused = paused
            self.last_render = None   # don't count the paused time as one huge step
            self.log('Paused' if paused else 'Resumed')
        return GLib.SOURCE_CONTINUE

    @staticmethod
    def _read_on_battery():
        base = '/sys/class/power_supply'
        try:
            names = os.listdir(base)
        except OSError:
            return False
        saw_mains = False
        for name in names:
            try:
                with open(os.path.join(base, name, 'type')) as f:
                    if f.read().strip() != 'Mains':
                        continue
                saw_mains = True
                with open(os.path.join(base, name, 'online')) as f:
                    if f.read().strip() == '1':
                        return False
            except OSError:
                continue
        return saw_mains

    def _check_power(self):
        b = self._read_on_battery()
        if b != self.on_battery:
            self.on_battery = b
            self.log(f"Power -> {'battery' if b else 'AC'}")
        return GLib.SOURCE_CONTINUE

    def _on_close(self, *_):
        self.quit()
        return True

    def quit(self):
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    def run(self):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, lambda: self._set_paused(True))
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, lambda: self._set_paused(False))
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGHUP, self._apply_settings)
        for sig in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self.quit)
        self.on_battery = self._read_on_battery()
        GLib.timeout_add_seconds(20, self._check_power)
        self.window.present()
        self.loop.run()
        self.window.destroy()
