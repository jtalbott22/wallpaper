"""Linux host for the web engine: web/wallpaper.html in a WebKitGTK view.

This is what the macOS and Windows apps show, so Linux gets the same scenes
(all sixteen), quality presets and math cards. The GNOME Shell extension
launches it as `python3 -m aether.webhost --wallpaper` and turns its window
into the desktop wallpaper, exactly as it does for the native renderer.

Signals, as for the native renderer:
  SIGUSR1  pause (the page fades out and stops drawing)
  SIGUSR2  resume
  SIGHUP   re-read ~/.config/aether/wallpaper.json (brightness, scene,
           quality, math card, "next scene" and "show the math" requests)

It prints `scene: <name>` whenever a scene starts, which the extension shows
in its top bar menu.

    python3 -m aether.webhost            # in a normal window, for trying it out
"""
import argparse
import json
import os
import signal
import sys
import urllib.parse

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gdk, GLib, Gtk, WebKit2   # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(REPO, 'web', 'wallpaper.html')

# menu names (shared with the native renderer) -> the web engine's keys
KEYS = {
    'Nebula': 'nebula', 'Julia': 'julia', 'Reaction': 'reaction', 'Physarum': 'physarum',
    'Attractor': 'attractor', 'Silk': 'silk', 'Chaos': 'chaos', 'Galaxy': 'galaxy', 'Ink': 'ink',
    'Particle Life': 'life', 'Cymatics': 'cymatics', 'Turing': 'turing', 'Free Energy': 'soup',
    'Cosmos': 'cosmos', 'Liquid': 'liquid', 'Mandelbulb': 'bulb',
}
QUALITIES = ('saver', 'balanced', 'high', 'max')


def settings_path():
    base = os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'aether', 'wallpaper.json')


def read_settings():
    try:
        with open(settings_path()) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    try:
        level = min(1.5, max(0.05, float(d.get('brightness', 1.0))))
    except (TypeError, ValueError):
        level = 1.0
    scene = d.get('scene')
    return {
        'level': level,
        'scene': KEYS.get(scene) if scene else None,
        'quality': d.get('quality') if d.get('quality') in QUALITIES else 'balanced',
        'math': d.get('mathOnStart', True) is not False,
        'next': d.get('next', 0),
        'ask': d.get('showMath', 0),
    }


def unix_signal_add():
    """GLibUnix.signal_add on newer PyGObject, GLib.unix_signal_add before it."""
    try:
        gi.require_version('GLibUnix', '2.0')
        from gi.repository import GLibUnix
        return GLibUnix.signal_add
    except (ImportError, ValueError, AttributeError):
        return GLib.unix_signal_add


def log(msg):
    print(msg, flush=True)


class WebHost:
    def __init__(self, args):
        self.args = args
        self.paused = False
        self.ready = False
        self.s = read_settings()
        if args.scene:
            self.s['scene'] = KEYS.get(args.scene, args.scene.lower())
        if args.quality:
            self.s['quality'] = args.quality

        GLib.set_prgname('aether-wallpaper')
        self.window = Gtk.Window(title='Aether Wallpaper' if args.wallpaper else 'Aether')
        self.window.set_decorated(not args.wallpaper)
        w, h = 1280, 720
        if args.wallpaper:
            mon = Gdk.Display.get_default().get_primary_monitor() or Gdk.Display.get_default().get_monitor(0)
            if mon:
                geo = mon.get_geometry()
                w, h = geo.width, geo.height
        self.window.set_default_size(w, h)
        self.window.connect('destroy', lambda *_: Gtk.main_quit())

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler('aether')
        ucm.connect('script-message-received::aether', self._on_message)
        self.view = WebKit2.WebView.new_with_user_content_manager(ucm)
        st = self.view.get_settings()
        st.set_enable_webgl(True)
        st.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        st.set_allow_file_access_from_file_urls(True)
        st.set_enable_developer_extras(bool(args.devtools))
        st.set_enable_write_console_messages_to_stdout(bool(args.debug))
        self.view.set_background_color(Gdk.RGBA(0, 0, 0, 1))
        self.view.connect('context-menu', lambda *_: not args.devtools)
        self.view.connect('load-changed', self._on_load)
        self.view.connect('web-process-terminated', self._on_crash)
        self.window.add(self.view)
        self.load()

    # ---- page --------------------------------------------------------------
    def url(self):
        q = {'level': f"{0 if self.paused else self.s['level']:.2f}", 'quality': self.s['quality']}
        if self.s['scene']:
            q['aether'] = self.s['scene']
        if not self.s['math']:
            q['math'] = '0'
        return 'file://' + urllib.parse.quote(PAGE) + '?' + urllib.parse.urlencode(q)

    def load(self):
        self.ready = False
        u = self.url()
        log(f"loading wallpaper.html (quality {self.s['quality']}, scene {self.s['scene'] or 'all'})")
        self.view.load_uri(u)

    def send(self, event, detail='null'):
        if not self.ready:
            return
        js = f"window.dispatchEvent(new CustomEvent({json.dumps(event)}, {{ detail: {detail} }}))"
        self.view.evaluate_javascript(js, -1, None, None, None, None, None)

    def _on_load(self, view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.ready = True
            # the level from the URL is only read on load; keep a pause that arrived meanwhile
            self.send('aether-level', '0' if self.paused else f"{self.s['level']}")

    def _on_crash(self, view, reason):
        log(f'web process ended ({reason.value_nick}); reloading')
        GLib.timeout_add_seconds(2, lambda: (self.load(), GLib.SOURCE_REMOVE)[1])

    def _on_message(self, ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_json(0))
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        d = msg.get('detail') or {}
        if msg.get('event') == 'aether-scene' and d.get('why') == 'start':
            log(f"scene: {d.get('name', '?')}")
            if self.args.debug:
                log(f"  at {d.get('width')}x{d.get('height')}")
        elif msg.get('event') == 'aether-quality' and self.args.debug:
            log(f"quality: {d.get('scene')} now {int(d.get('pixels', 0)) // 1000}k pixels ({d.get('why')})")

    # ---- signals -----------------------------------------------------------
    def pause(self, paused):
        if paused != self.paused:
            self.paused = paused
            self.send('aether-level', '0' if paused else f"{self.s['level']}")
        return GLib.SOURCE_CONTINUE

    def reread(self):
        old, new = self.s, read_settings()
        self.s = new
        if (new['scene'], new['quality']) != (old['scene'], old['quality']):
            self.load()
            return GLib.SOURCE_CONTINUE
        if new['level'] != old['level'] and not self.paused:
            self.send('aether-level', f"{new['level']}")
        if new['math'] != old['math']:
            self.send('aether-math-auto', 'true' if new['math'] else 'false')
        if new['next'] != old['next']:
            self.view.evaluate_javascript('window.Aether && Aether.next()', -1, None, None, None, None, None)
        if new['ask'] != old['ask']:
            self.send('aether-show-math')
        return GLib.SOURCE_CONTINUE

    def run(self):
        add = unix_signal_add()
        add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, lambda: self.pause(True))
        add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, lambda: self.pause(False))
        add(GLib.PRIORITY_DEFAULT, signal.SIGHUP, self.reread)
        for sig in (signal.SIGTERM, signal.SIGINT):
            add(GLib.PRIORITY_DEFAULT, sig, lambda: (Gtk.main_quit(), GLib.SOURCE_REMOVE)[1])
        self.window.show_all()
        Gtk.main()


def main():
    ap = argparse.ArgumentParser(description='Aether web engine (web/wallpaper.html) in a WebKitGTK window.')
    ap.add_argument('--wallpaper', action='store_true', help='Desktop-wallpaper mode for the GNOME Shell extension.')
    ap.add_argument('--scene', help='Stay on one scene (a name like "Free Energy" or a key like soup).')
    ap.add_argument('--quality', choices=QUALITIES, help='Override the saved quality preset.')
    ap.add_argument('--debug', action='store_true', help='Log scene sizes, quality changes and the page console.')
    ap.add_argument('--devtools', action='store_true', help='Allow the WebKit inspector (right-click).')
    args = ap.parse_args()
    if not os.path.exists(PAGE):
        sys.exit(f'aether.webhost: {PAGE} is missing')
    WebHost(args).run()


if __name__ == '__main__':
    main()
