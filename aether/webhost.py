"""Linux host for the web engine: web/wallpaper.html in a WebKitGTK view.

This is what the macOS and Windows apps show, so Linux gets the same scenes
(all sixteen), quality presets and math cards. The GNOME Shell extension
launches it as `python3 -m aether.webhost --wallpaper` and turns its window
into the desktop wallpaper, exactly as it does for the native renderer.

Signals, as for the native renderer:
  SIGUSR1  pause (the page fades out and stops drawing)
  SIGUSR2  resume
  SIGHUP   re-read ~/.config/aether/wallpaper.json (brightness, scene,
           quality, math card, scenes left out of the rotation, and "next
           scene" and "show the math" requests)

It prints `scene: <name>` whenever a scene starts, which the extension shows
in its top bar menu.

    python3 -m aether.webhost            # in a normal window, for trying it out

It prefers GTK 4 with WebKitGTK 6.0 (gir1.2-webkit-6.0), which draws at the
screen's real scale, fractional ones like 125% included. Without it, it uses
GTK 3 with WebKitGTK 4.1, which draws at the next whole scale (200% for 125%)
and leaves GNOME to shrink every frame: the same picture for much more GPU
work. AETHER_WEBKIT=4.1 forces the GTK 3 path.
"""
import argparse
import json
import os
import signal
import sys
import urllib.parse

import gi


def _pick_toolkit():
    if os.environ.get('AETHER_WEBKIT') != '4.1':
        try:
            gi.require_version('Gtk', '4.0')
            gi.require_version('Gdk', '4.0')
            gi.require_version('WebKit', '6.0')
            return 4
        except ValueError:
            pass
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('WebKit2', '4.1')
    return 3


GTK = _pick_toolkit()
if GTK == 4:
    from gi.repository import Gdk, GLib, Gtk, WebKit   # noqa: E402
else:
    from gi.repository import Gdk, GLib, Gtk               # noqa: E402
    from gi.repository import WebKit2 as WebKit           # noqa: E402

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
        'skip': sorted(KEYS[n] for n in d.get('skip', []) if n in KEYS) if isinstance(d.get('skip'), list) else [],
        'ask': d.get('showMath', 0),
    }


FPS_PROBE = r'''
(function () {
  var n = 0, t0 = performance.now(), c = document.getElementById('aether-bg'), gpu = '?';
  try {
    var g = document.createElement('canvas').getContext('webgl2'), e = g && g.getExtension('WEBGL_debug_renderer_info');
    gpu = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : (g ? g.getParameter(g.RENDERER) : 'no WebGL2');
  } catch (err) {}
  (function tick() { n++; requestAnimationFrame(tick); })();
  setInterval(function () {
    var now = performance.now(), fps = Math.round(n * 10000 / (now - t0)) / 10;
    n = 0; t0 = now;
    try {
      window.webkit.messageHandlers.aether.postMessage({ event: 'aether-fps', detail: {
        fps: fps, w: c.width, h: c.height, cw: innerWidth, ch: innerHeight, dpr: devicePixelRatio, gpu: gpu } });
    } catch (err) {}
  }, 5000);
})();
'''


def unix_signal_add():
    """GLibUnix.signal_add on newer PyGObject, GLib.unix_signal_add before it."""
    try:
        gi.require_version('GLibUnix', '2.0')
        from gi.repository import GLibUnix
        return GLibUnix.signal_add
    except (ImportError, ValueError, AttributeError):
        return GLib.unix_signal_add


def on_battery():
    """True when a mains supply exists and none is online (same test as the native renderer)."""
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


def log(msg):
    print(msg, flush=True)


class WebHost:
    def __init__(self, args):
        self.args = args
        self.paused = False
        self.ready = False
        self.battery = on_battery()
        self.s = read_settings()
        if args.scene:
            self.s['scene'] = KEYS.get(args.scene, args.scene.lower())
        if args.quality:
            self.s['quality'] = args.quality

        GLib.set_prgname('aether-wallpaper')
        self.loop = GLib.MainLoop()
        self.window = Gtk.Window(title='Aether Wallpaper' if args.wallpaper else 'Aether')
        self.window.set_decorated(not args.wallpaper)
        w, h = 1280, 720
        if args.wallpaper:
            geo = self._monitor_geometry()
            if geo:
                w, h = geo.width, geo.height
        self.window.set_default_size(w, h)

        ucm = WebKit.UserContentManager()
        if GTK == 4:
            ucm.register_script_message_handler('aether', None)
        else:
            ucm.register_script_message_handler('aether')
        ucm.connect('script-message-received::aether', self._on_message)
        if args.debug:
            # frame-rate readout: page callbacks per second, canvas size and pixel ratio
            ucm.add_script(WebKit.UserScript.new(FPS_PROBE, WebKit.UserContentInjectedFrames.TOP_FRAME,
                                                 WebKit.UserScriptInjectionTime.END, None, None))
        if GTK == 4:
            self.view = WebKit.WebView(user_content_manager=ucm)
        else:
            self.view = WebKit.WebView.new_with_user_content_manager(ucm)
        st = self.view.get_settings()
        st.set_enable_webgl(True)
        try:
            st.set_hardware_acceleration_policy(WebKit.HardwareAccelerationPolicy.ALWAYS)
        except AttributeError:
            pass   # WebKitGTK 6.0 always accelerates
        st.set_allow_file_access_from_file_urls(True)
        st.set_enable_developer_extras(bool(args.devtools))
        st.set_enable_write_console_messages_to_stdout(bool(args.debug))
        black = Gdk.RGBA()
        black.parse('black')
        self.view.set_background_color(black)
        self.view.connect('context-menu', lambda *_: not args.devtools)
        self.view.connect('load-changed', self._on_load)
        self.view.connect('web-process-terminated', self._on_crash)
        if GTK == 4:
            self.window.set_child(self.view)
            self.window.connect('close-request', lambda *_: (self.quit(), True)[1])
        else:
            self.window.add(self.view)
            self.window.connect('destroy', lambda *_: self.quit())
        log(f'GTK {GTK} with WebKitGTK {WebKit.get_major_version()}.{WebKit.get_minor_version()}')
        self.load()

    @staticmethod
    def _monitor_geometry():
        display = Gdk.Display.get_default()
        if GTK == 4:
            mons = display.get_monitors()
            mon = mons.get_item(0) if mons.get_n_items() else None
        else:
            mon = display.get_primary_monitor() or display.get_monitor(0)
        return mon.get_geometry() if mon else None

    def quit(self):
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    # ---- page --------------------------------------------------------------
    def url(self):
        q = {'level': f"{0 if self.paused else self.s['level']:.2f}", 'quality': self.s['quality']}
        if self.s['scene']:
            q['aether'] = self.s['scene']
        if not self.s['math']:
            q['math'] = '0'
        if self.s['skip']:
            q['skip'] = ','.join(self.s['skip'])
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
        if event == WebKit.LoadEvent.FINISHED:
            self.ready = True
            # the level from the URL is only read on load; keep a pause that arrived meanwhile
            self.send('aether-level', '0' if self.paused else f"{self.s['level']}")
            self.send_fps()

    def _on_crash(self, view, reason):
        log(f'web process ended ({reason.value_nick}); reloading')
        GLib.timeout_add_seconds(2, lambda: (self.load(), GLib.SOURCE_REMOVE)[1])

    def _on_message(self, ucm, result):
        try:
            value = result if GTK == 4 else result.get_js_value()
            msg = json.loads(value.to_json(0))
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        d = msg.get('detail') or {}
        if msg.get('event') == 'aether-scene' and d.get('why') == 'start':
            log(f"scene: {d.get('name', '?')}")
            if self.args.debug:
                log(f"  at {d.get('width')}x{d.get('height')}")
        elif msg.get('event') == 'aether-fps':
            log(f"fps: {d.get('fps')} (canvas {d.get('w')}x{d.get('h')}, window {d.get('cw')}x{d.get('ch')} css px, "
                f"pixel ratio {d.get('dpr')}, {d.get('gpu')})")
        elif msg.get('event') == 'aether-quality' and self.args.debug:
            log(f"quality: {d.get('scene')} now {int(d.get('pixels', 0)) // 1000}k pixels ({d.get('why')})")

    def send_fps(self):
        cap = self.args.battery_fps if self.battery else 0
        self.send('aether-fps', str(cap))

    def check_power(self):
        b = on_battery()
        if b != self.battery:
            self.battery = b
            log(f"power: {'battery' if b else 'mains'}")
            self.send_fps()
        return GLib.SOURCE_CONTINUE

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
        if new['skip'] != old['skip']:
            self.send('aether-skip', json.dumps(new['skip']))
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
            add(GLib.PRIORITY_DEFAULT, sig, self.quit)
        GLib.timeout_add_seconds(20, self.check_power)
        if self.battery and self.args.battery_fps > 0:
            log(f'on battery: {self.args.battery_fps} fps cap')
        if GTK == 4:
            self.window.present()
        else:
            self.window.show_all()
        self.loop.run()


def main():
    ap = argparse.ArgumentParser(description='Aether web engine (web/wallpaper.html) in a WebKitGTK window.')
    ap.add_argument('--wallpaper', action='store_true', help='Desktop-wallpaper mode for the GNOME Shell extension.')
    ap.add_argument('--scene', help='Stay on one scene (a name like "Free Energy" or a key like soup).')
    ap.add_argument('--quality', choices=QUALITIES, help='Override the saved quality preset.')
    ap.add_argument('--battery-fps', type=int, default=20,
                    help='Frame-rate cap on battery (default 20, like the native renderer; 0 for none).')
    ap.add_argument('--debug', action='store_true', help='Log scene sizes, quality changes and the page console.')
    ap.add_argument('--devtools', action='store_true', help='Allow the WebKit inspector (right-click).')
    args = ap.parse_args()
    if not os.path.exists(PAGE):
        sys.exit(f'aether.webhost: {PAGE} is missing')
    WebHost(args).run()


if __name__ == '__main__':
    main()
