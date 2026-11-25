"""Mirage GTK application: fullscreen animated wallpaper."""
import math
import time
import os
import random
import signal
import sys

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib

from .scheduler import Scheduler
from .renderer import Renderer
from .perf import QualityController
from .util import clamp

class MirageApp:
    def __init__(self, args):
        self.args = args
        self.seed = args.seed if args.seed is not None else random.SystemRandom().randint(0, 1 << 30)
        self.paused = False
        self.wallpaper = getattr(args, 'wallpaper', False)
        self.want_fullscreen = args.fullscreen and not self.wallpaper
        self.label_fade = not self.wallpaper
        self.hint_visible = not self.wallpaper
        self.ext_paused = False          # paused by the shell extension (SIGUSR1/2)
        self.timer_id = 0
        self.on_battery = False
        self.battery_fps = getattr(args, 'battery_fps', 15)
        self.fps = args.fps
        self.real_pointer = (0.5, 0.5)
        self.real_pointer_time = 0.0
        self.phantom = (0.5, 0.5)
        self.last_tick = time.time()
        self.frame_ms = max(1, 1000 // args.fps)
        self.elapsed = 0.0
        self.scene_switch_time = 0.0
        self.scene_label_fade_start = 0.0
        self.hint_fade_start = time.time()

        self.window = Gtk.Window(title='Mirage Wallpaper' if self.wallpaper else 'Mirage')
        self.window.set_default_size(1280, 720)
        self.window.set_decorated(False)
        if self.wallpaper:
            # The GNOME Shell extension does the real work on Wayland (stacking,
            # hiding from the window list, placement). These hints only take
            # effect under X11 but are harmless elsewhere.
            self.window.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
            self.window.set_accept_focus(False)
            self.window.set_focus_on_map(False)
            self.window.set_skip_taskbar_hint(True)
            self.window.set_skip_pager_hint(True)
            self.window.set_keep_below(True)
            self.window.stick()
        else:
            self.window.set_focus_on_map(True)
        self.window.connect('delete-event', lambda *_: self.quit())
        self.window.connect('key-press-event', self.on_keypress)
        self.window.connect('motion-notify-event', self.on_motion)
        self.window.connect('realize', self.on_realize)
        self.window.connect('size-allocate', self.on_resize)

        # image beneath, overlay labels on top
        self.image = Gtk.Image()
        self.image.set_halign(Gtk.Align.FILL)
        self.image.set_valign(Gtk.Align.FILL)
        self.image.set_size_request(640, 360)

        self.name_label = Gtk.Label(label='')
        self.name_label.set_halign(Gtk.Align.START)
        self.name_label.set_valign(Gtk.Align.START)
        self.name_label.set_opacity(0.0)
        self.name_label.get_style_context().add_class('mirage-name-label')

        self.hint_label = Gtk.Label(label='')
        self.hint_label.set_halign(Gtk.Align.FILL)
        self.hint_label.set_valign(Gtk.Align.END)
        self.hint_label.set_opacity(0.0)
        self.hint_label.get_style_context().add_class('mirage-hint-label')

        self.paused_label = Gtk.Label(label='')
        self.paused_label.set_halign(Gtk.Align.CENTER)
        self.paused_label.set_valign(Gtk.Align.CENTER)
        self.paused_label.set_opacity(0.0)
        self.paused_label.get_style_context().add_class('mirage-paused-label')

        self.overlay = Gtk.Overlay()
        self.overlay.add(self.image)
        if not self.wallpaper:
            self.overlay.add_overlay(self.name_label)
            self.overlay.add_overlay(self.hint_label)
            self.overlay.add_overlay(self.paused_label)
        self.window.add(self.overlay)

        screen = Gdk.Screen.get_default()
        self.w = screen.get_width()
        self.h = screen.get_height()
        if self.wallpaper:
            display = Gdk.Display.get_default()
            mon = display.get_primary_monitor() or display.get_monitor(0)
            if mon is not None:
                geo = mon.get_geometry()
                self.w, self.h = geo.width, geo.height
            self.window.set_default_size(self.w, self.h)

        self.quality_ctrl = QualityController(quality=args.quality)
        self.renderer = Renderer(self.w, self.h, self.quality_ctrl.quality)
        self.scheduler = Scheduler(self.w, self.h, seed=self.seed,
                                   initial_scene=self.args.scene,
                                   initial_palette=self.args.palette)

        self.window.show_all()
        self._apply_css()
        self._log(f"Mirage ready: {self.scheduler.current.name} / {self.scheduler.current_palette.name} (quality={self.quality_ctrl.quality:.2f})")
        self._set_label_scene(self.scheduler.current.name)
        if not self.wallpaper:
            self.hint_label.set_label('space / n  next scene      p  pause      h  hints      F11  fullscreen      esc  quit')
            self.hint_label.set_opacity(1.0)
            self.hint_fade_start = time.time()

    # ---- GTK plumbing --------------------------------------------------
    def _apply_css(self):
        css = '''
        label.mirage-name-label { font-family: "Cantarell", "sans-serif"; font-size: 26px; font-weight: 600; color: rgba(236, 241, 255, 0.95); padding: 42px 48px; }
        label.mirage-hint-label { font-family: "Cantarell", "sans-serif"; font-size: 15px; color: rgba(222, 230, 246, 0.85); padding: 0 0 34px 0; }
        label.mirage-paused-label { font-family: "Cantarell", "sans-serif"; font-size: 28px; font-weight: 600; color: rgba(236, 241, 255, 0.92); }
        '''
        try:
            provider = Gtk.CssProvider()
            provider.load_from_data(css.encode('utf-8'))
            screen = Gdk.Screen.get_default()
            Gtk.StyleContext.add_provider_for_screen(
                screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        except Exception:
            pass

    def _log(self, msg):
        if self.args.debug:
            print(msg, file=sys.stderr, flush=True)

    def _set_label_scene(self, name):
        if self.label_fade:
            self.name_label.set_label(name)
            self.scene_label_fade_start = time.time()

    def on_realize(self, widget):
        if self.want_fullscreen:
            self.window.fullscreen()

    def on_resize(self, widget, event):
        w = widget.get_allocated_width()
        h = widget.get_allocated_height()
        if w < 64 or h < 64:
            return
        self.image.set_size_request(w, h)
        if w != self.w or h != self.h:
            self.w, self.h = w, h
            self.renderer.resize(w, h)
            self.scheduler.resize(w, h)

    def on_motion(self, widget, event):
        w = widget.get_allocated_width() or 1
        h = widget.get_allocated_height() or 1
        self.real_pointer = (event.x / w, event.y / h)
        self.real_pointer_time = time.time()
        return False

    def on_keypress(self, widget, event):
        if self.wallpaper:
            return False
        if event.keyval == Gdk.KEY_Escape:
            self.quit()
            return True
        if event.keyval == Gdk.KEY_F11:
            self.want_fullscreen = not self.want_fullscreen
            if self.want_fullscreen:
                self.window.fullscreen()
            else:
                self.window.unfullscreen()
            return True
        if event.keyval in (Gdk.KEY_space, Gdk.KEY_n):
            self.skip_scene()
            return True
        if event.keyval == Gdk.KEY_p:
            self.paused = not self.paused
            self.paused_label.set_label('paused\n\npress P to resume' if self.paused else '')
            self.paused_label.set_opacity(1.0 if self.paused else 0.0)
            return True
        if event.keyval == Gdk.KEY_h:
            self.hint_visible = not self.hint_visible
            self.hint_label.set_opacity(1.0 if self.hint_visible else 0.0)
            self.hint_fade_start = time.time()
            return True
        return False

    def skip_scene(self):
        if not self.paused:
            self.renderer.begin_crossfade()
            self.scheduler.force_next(self.elapsed, self.pointer())
            self._set_label_scene(self.scheduler.current.name)
            self.hint_fade_start = time.time()

    # ---- phantom pointer ---------------------------------------------
    def pointer(self):
        now = time.time()
        if now - self.real_pointer_time < 4.0:
            return self.real_pointer
        t = now * 0.11
        x = 0.5 + 0.36 * math.sin(t * 1.07) + 0.12 * math.sin(t * 2.3 + 1.7)
        y = 0.5 + 0.30 * math.sin(t * 0.83 + 2.1) + 0.10 * math.sin(t * 1.9)
        self.phantom = (clamp(x, 0.02, 0.98), clamp(y, 0.02, 0.98))
        return self.phantom

    # ---- main loop ---------------------------------------------------
    def tick(self):
        now = time.time()
        dt = min(0.12, now - self.last_tick)
        self.last_tick = now
        if not self.paused:
            self.elapsed += dt
            pointer = self.pointer()
            changed, _ = self.scheduler.advance(dt, self.elapsed, pointer)
            if changed:
                self.renderer.begin_crossfade()
                self._set_label_scene(self.scheduler.current.name)
                self._log(f"Scene -> {self.scheduler.current.name} ({self.scheduler.current_palette.name})")
                self.scene_switch_time = now
            self.renderer.begin_frame()
            self.scheduler.draw(self.renderer.ctx, self.elapsed, pointer)
            self.renderer.advance_fade(dt)
            pixbuf = self._make_pixbuf()
            self.image.set_from_pixbuf(pixbuf)
            # adaptive quality: gentle raise, fast lower
            self.quality_ctrl.observe(dt * 1000.0)
            new_q = self.quality_ctrl.quality
            if new_q != self.renderer.quality:
                self._log(f"Quality -> {new_q:.2f}")
            self.renderer.set_quality(new_q)
        self._update_labels()
        return GLib.SOURCE_CONTINUE

    def _make_pixbuf(self):
        self.renderer.composite()
        data = self.renderer.get_display_data()
        w, h = self.renderer.get_display_size()
        return GdkPixbuf.Pixbuf.new_from_data(
            bytes(data), GdkPixbuf.Colorspace.RGB, True, 8, w, h, w * 4)

    def _update_labels(self):
        now = time.time()
        # scene name: fade in on change, fade out over ~5s
        if self.label_fade:
            since = now - self.scene_label_fade_start
            if since < 0.4:
                alpha = since / 0.4
            elif since < 4.5:
                alpha = 1.0
            elif since < 6.5:
                alpha = 1.0 - (since - 4.5)
            else:
                alpha = 0.0
            self.name_label.set_opacity(clamp(alpha, 0.0, 1.0))
        # hint: visible for first ~6s, fades out over 4s
        if self.hint_visible:
            since = now - self.hint_fade_start
            if since < 6.0:
                alpha = 1.0
            elif since < 10.0:
                alpha = 1.0 - (since - 6.0) / 4.0
            else:
                alpha = 0.0
                self.hint_visible = False
            self.hint_label.set_opacity(clamp(alpha, 0.0, 1.0))

    # ---- frame timer / wallpaper power management ----------------------
    def _current_fps(self):
        if self.on_battery:
            return max(1, min(self.fps, self.battery_fps))
        return self.fps

    def _start_timer(self):
        self._stop_timer()
        self.frame_ms = max(1, 1000 // self._current_fps())
        self.last_tick = time.time()
        self.timer_id = GLib.timeout_add(self.frame_ms, self.tick)

    def _stop_timer(self):
        if self.timer_id:
            GLib.source_remove(self.timer_id)
            self.timer_id = 0

    def _set_ext_paused(self, paused):
        if paused == self.ext_paused:
            return GLib.SOURCE_CONTINUE
        self.ext_paused = paused
        self._log('Paused by shell' if paused else 'Resumed by shell')
        if paused:
            self._stop_timer()
        else:
            self._start_timer()
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
                    kind = f.read().strip()
                if kind != 'Mains':
                    continue
                saw_mains = True
                with open(os.path.join(base, name, 'online')) as f:
                    if f.read().strip() == '1':
                        return False
            except OSError:
                continue
        return saw_mains

    def _check_power(self):
        on_battery = self._read_on_battery()
        if on_battery != self.on_battery:
            self.on_battery = on_battery
            self._log(f"Power -> {'battery' if on_battery else 'AC'} ({self._current_fps()} fps)")
            if self.timer_id:
                self._start_timer()
        return GLib.SOURCE_CONTINUE

    # ---- run ----------------------------------------------------------
    def run(self):
        self.window.show_all()
        if self.wallpaper:
            # SIGUSR1 = pause, SIGUSR2 = resume (sent by the GNOME Shell extension)
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1,
                                 lambda: self._set_ext_paused(True))
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2,
                                 lambda: self._set_ext_paused(False))
            self.on_battery = self._read_on_battery()
            GLib.timeout_add_seconds(20, self._check_power)
        for sig in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self._on_quit_signal)
        self._start_timer()
        self.window.connect('destroy', lambda *_: Gtk.main_quit())
        Gtk.main()

    def _on_quit_signal(self):
        self.quit()
        return GLib.SOURCE_REMOVE

    def quit(self):
        Gtk.main_quit()
