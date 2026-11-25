// Aether Live Wallpaper — GNOME Shell extension.
//
// Launches `python3 -m aether --wallpaper` (or the older `mirage` CPU renderer)
// as a Wayland client the shell owns, then turns its window into a
// desktop-layer window: stacked below everything
// (including the Desktop Icons window), on every workspace, hidden from the
// dock / Alt-Tab / Overview, and sized to the primary monitor.
//
// It also pauses the renderer (SIGUSR1) while a maximized or fullscreen window
// covers the primary monitor or the screen is locked, resumes it (SIGUSR2)
// afterwards, and restarts it if it crashes.
//
// A top bar menu (the same ring-and-swirl icon as the macOS menu bar item)
// sets brightness, picks or skips scenes, pauses, and opens the interactive
// web page. Settings live in ~/.config/aether/wallpaper.json, and the
// renderer re-reads them on SIGHUP.
//
// The window-handling technique mirrors Ubuntu's Desktop Icons (DING)
// extension, which does the same thing for its own desktop window.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SIGHUP = 1;
const SIGUSR1 = 10;
const SIGUSR2 = 12;
const SIGTERM = 15;

// names as `python3 -m aether --list` prints them
const SCENES = ['Nebula', 'Julia', 'Reaction', 'Physarum', 'Attractor',
    'Silk', 'Chaos', 'Galaxy', 'Ink', 'Particle Life'];
const LEVEL_MIN = 0.05, LEVEL_MAX = 1.5;

const AetherIndicator = GObject.registerClass(
class AetherIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Aether', false);
        this._ext = ext;
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([ext.path, 'icons', 'aether-symbolic.svg']))),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        const menu = this.menu;
        this._status = new PopupMenu.PopupMenuItem('Starting…', {reactive: false});
        menu.addMenuItem(this._status);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._brightLabel = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this._brightLabel);
        this._sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        this._slider = new Slider(0);
        this._slider.accessible_name = 'Brightness';
        this._slider.x_expand = true;
        this._sliderItem.add_child(this._slider);
        this._slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            const v = Math.round((LEVEL_MIN + this._slider.value * (LEVEL_MAX - LEVEL_MIN)) * 20) / 20;
            this._ext._setBrightness(v);
        });
        menu.addMenuItem(this._sliderItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pauseItem = menu.addAction('Pause', () => this._ext._togglePause());
        this._sceneMenu = new PopupMenu.PopupSubMenuMenuItem('Scene');
        this._sceneItems = new Map();
        const all = this._sceneMenu.menu.addAction('All scenes, in turn', () => this._ext._setScene(null));
        this._sceneItems.set(null, all);
        this._sceneMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const name of SCENES)
            this._sceneItems.set(name, this._sceneMenu.menu.addAction(name, () => this._ext._setScene(name)));
        menu.addMenuItem(this._sceneMenu);
        this._nextItem = menu.addAction('Next Scene', () => this._ext._nextScene());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        menu.addAction('Open Aether in Browser', () => this._ext._openPage());
        menu.addAction('Restart Wallpaper', () => this._ext._restart());

        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this.sync();
        });
        this.sync();
    }

    sync() {
        const ext = this._ext, st = ext._settings;
        const live = ext._engine === 'aether';
        this._status.label.text = ext._statusText();
        const pct = Math.round(st.brightness * 100);
        this._brightLabel.label.text = live ? `Brightness  ${pct}%` : 'Brightness (Aether only)';
        const v = (st.brightness - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN);
        if (Math.abs(this._slider.value - v) > 0.02) {
            this._syncing = true;
            this._slider.value = v;
            this._syncing = false;
        }
        this._slider.reactive = live;
        this._pauseItem.label.text = st.paused ? 'Resume' : 'Pause';
        this._sceneMenu.label.text = `Scene: ${st.scene ?? 'All, in turn'}`;
        for (const [name, item] of this._sceneItems) {
            item.setOrnament(name === (st.scene ?? null)
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        this._sceneMenu.setSensitive(live);
        this._nextItem.setSensitive(live);
        this._icon.opacity = ext._paused || !ext._proc ? 128 : 255;
    }
});

const RESTART_DELAYS_S = [2, 5, 15, 60];
const MAX_CRASHES = 6;             // within CRASH_WINDOW_S -> give up
const CRASH_WINDOW_S = 300;

export default class AetherWallpaperExtension extends Extension {
    enable() {
        this._client = null;
        this._proc = null;
        this._cancellable = null;
        this._window = null;
        this._windowSignals = [];
        this._signals = [];
        this._paused = false;
        this._crashTimes = [];
        this._relaunchId = 0;
        this._checkId = 0;
        this._saveId = 0;
        this._indicator = null;
        this._settings = this._loadSettings();

        this._repoDir = this._readRepoDir();
        this._engine = this._readEngine();
        if (!this._repoDir) {
            console.error(`${this.uuid}: no repository directory configured; run install-wallpaper.sh from the wallpaper repository.`);
            return;
        }

        const wm = global.window_manager;
        this._connect(wm, 'map', (_wm, actor) => {
            this._onMap(actor.get_meta_window());
            this._queueCheck();
        });
        for (const sig of ['destroy', 'minimize', 'unminimize', 'size-changed', 'switch-workspace'])
            this._connect(wm, sig, () => this._queueCheck());
        this._connect(global.display, 'restacked', () => this._queueCheck());
        this._connect(global.display, 'in-fullscreen-changed', () => this._queueCheck());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._placeWindow());
        this._connect(Main.sessionMode, 'updated', () => {
            this._syncIndicator();
            this._queueCheck();
        });

        this._syncIndicator();
        this._launch();
    }

    disable() {
        // Runs on logout and when the extension is turned off. (The extension
        // stays enabled on the lock screen via "unlock-dialog" so the renderer is
        // paused there instead of killed and relaunched.)
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._forgetWindow();
        this._indicator?.destroy();
        this._indicator = null;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._writeSettings();
        }
        if (this._relaunchId) {
            GLib.source_remove(this._relaunchId);
            this._relaunchId = 0;
        }
        if (this._checkId) {
            GLib.source_remove(this._checkId);
            this._checkId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proc) {
            try {
                this._proc.send_signal(SIGTERM);
            } catch (e) {
                console.warn(`${this.uuid}: ${e.message}`);
            }
        }
        this._proc = null;
        this._client = null;
    }

    // ---- configuration --------------------------------------------------
    _readRepoDir() {
        try {
            const file = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'mirage-dir']));
            const [, bytes] = file.load_contents(null);
            const dir = new TextDecoder().decode(bytes).trim();
            if (dir && GLib.file_test(GLib.build_filenamev([dir, 'aether', '__main__.py']), GLib.FileTest.EXISTS))
                return dir;
            if (dir && GLib.file_test(GLib.build_filenamev([dir, 'mirage', '__main__.py']), GLib.FileTest.EXISTS))
                return dir;
            console.error(`${this.uuid}: ${dir} does not contain the mirage package`);
        } catch (e) {
            console.error(`${this.uuid}: cannot read mirage-dir: ${e.message}`);
        }
        return null;
    }

    // Which renderer to run: 'aether' (GPU, default) or 'mirage' (CPU).
    _readEngine() {
        try {
            const file = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'engine']));
            const [, bytes] = file.load_contents(null);
            const name = new TextDecoder().decode(bytes).trim();
            if (['aether', 'mirage'].includes(name))
                return name;
        } catch (e) {
            // no file: use the default
        }
        return 'aether';
    }

    // ---- settings + top bar menu -------------------------------------------
    _settingsFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'aether', 'wallpaper.json']));
    }

    _loadSettings() {
        const st = {brightness: 1, scene: null, paused: false, next: 0};
        try {
            const [, bytes] = this._settingsFile().load_contents(null);
            const d = JSON.parse(new TextDecoder().decode(bytes));
            if (Number.isFinite(d.brightness))
                st.brightness = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, d.brightness));
            if (SCENES.includes(d.scene))
                st.scene = d.scene;
            st.paused = !!d.paused;
            if (Number.isInteger(d.next))
                st.next = d.next;
        } catch (e) {
            // no file yet: defaults
        }
        return st;
    }

    _writeSettings() {
        try {
            const file = this._settingsFile();
            const dir = file.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            file.replace_contents(new TextEncoder().encode(`${JSON.stringify(this._settings, null, 2)}\n`),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`${this.uuid}: cannot save settings: ${e.message}`);
        }
    }

    // write now and tell the renderer (debounced while a slider is dragged)
    _saveSettings(tellRenderer = true) {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._saveId = 0;
            this._writeSettings();
            if (tellRenderer && this._engine === 'aether' && this._proc && this._window) {
                try {
                    this._proc.send_signal(SIGHUP);
                } catch (e) {
                    console.warn(`${this.uuid}: ${e.message}`);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _setBrightness(v) {
        v = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, v));
        if (Math.abs(v - this._settings.brightness) < 1e-6)
            return;
        this._settings.brightness = v;
        this._saveSettings();
        this._indicator?.sync();
    }

    _setScene(name) {
        this._settings.scene = name;
        this._saveSettings();
        this._indicator?.sync();
    }

    _nextScene() {
        this._settings.next = (this._settings.next + 1) % 1000000;
        this._saveSettings();
    }

    _togglePause() {
        this._settings.paused = !this._settings.paused;
        console.log(`${this.uuid}: ${this._settings.paused ? 'paused' : 'resumed'} from the menu`);
        this._saveSettings(false);
        this._queueCheck();
        this._indicator?.sync();
    }

    _openPage() {
        const page = GLib.build_filenamev([this._repoDir, 'web', 'aether.html']);
        try {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(page).get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Aether', `Cannot open ${page}: ${e.message}`);
        }
    }

    _restart() {
        this._crashTimes = [];
        this._engine = this._readEngine();   // undo a fallback to Mirage
        if (this._proc) {
            // the exit handler relaunches it
            try {
                this._proc.send_signal(SIGTERM);
            } catch (e) {
                console.warn(`${this.uuid}: ${e.message}`);
            }
        } else if (!this._relaunchId) {
            this._launch();
        }
    }

    _statusText() {
        if (!this._proc)
            return 'Not running';
        const engine = this._engine === 'mirage' ? ' (Mirage, CPU)' : '';
        if (!this._window)
            return `Starting…${engine}`;
        if (this._settings.paused)
            return `Paused${engine}`;
        if (this._paused)
            return `Paused while a window covers the screen${engine}`;
        return `Running${engine}`;
    }

    _syncIndicator() {
        // no top bar menu on the lock screen
        const want = !Main.sessionMode.isLocked;
        if (want && !this._indicator) {
            const ind = new AetherIndicator(this);
            this._indicator = ind;
            // the panel can destroy it first when the whole shell shuts down
            ind.connect('destroy', () => {
                if (this._indicator === ind)
                    this._indicator = null;
            });
            Main.panel.addToStatusArea(this.uuid, ind);
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    // ---- process supervision ------------------------------------------
    _launch() {
        this._relaunchId = 0;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.set_cwd(this._repoDir);
        const argv = ['python3', '-m', this._engine, '--wallpaper'];
        launcher.setenv('GDK_BACKEND', 'wayland', true);

        try {
            this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
            this._proc = this._client.get_subprocess();
        } catch (e) {
            console.error(`${this.uuid}: failed to start ${this._engine}: ${e.message}`);
            this._client = null;
            this._proc = null;
            this._scheduleRelaunch();
            return;
        } finally {
            launcher.close?.();
        }

        this._paused = false;
        const proc = this._proc;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._readOutput(Gio.DataInputStream.new(proc.get_stdout_pipe()), cancellable);
        proc.wait_async(cancellable, () => {
            if (cancellable.is_cancelled() || proc !== this._proc)
                return;
            console.warn(`${this.uuid}: renderer exited (status ${proc.get_status()})`);
            this._forgetWindow();
            this._proc = null;
            this._client = null;
            this._indicator?.sync();
            this._scheduleRelaunch();
        });
    }

    _readOutput(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (s, res) => {
            try {
                const [line] = s.read_line_finish_utf8(res);
                if (line === null)
                    return;
                console.log(`wallpaper (${this._engine}): ${line}`);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`${this.uuid}: ${e.message}`);
                return;
            }
            this._readOutput(stream, cancellable);
        });
    }

    _scheduleRelaunch() {
        const now = GLib.get_monotonic_time() / 1e6;
        this._crashTimes = this._crashTimes.filter(t => now - t < CRASH_WINDOW_S);
        this._crashTimes.push(now);
        if (this._crashTimes.length > MAX_CRASHES) {
            if (this._engine === 'aether') {
                console.error(`${this.uuid}: Aether keeps exiting; falling back to the Mirage CPU renderer.`);
                this._engine = 'mirage';
                this._crashTimes = [];
            } else {
                console.error(`${this.uuid}: Mirage keeps exiting; giving up until the extension is re-enabled.`);
                return;
            }
        }
        const delay = RESTART_DELAYS_S[Math.min(this._crashTimes.length - 1, RESTART_DELAYS_S.length - 1)];
        this._relaunchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._launch();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- window handling ------------------------------------------------
    _onMap(window) {
        if (!window || !this._client || this._window === window)
            return;
        let ours = false;
        try {
            ours = this._client.owns_window(window);
        } catch (e) {
            return;
        }
        if (!ours)
            return;

        this._forgetWindow();
        this._window = window;
        window.set_type(Meta.WindowType.DESKTOP);
        window.hide_from_window_list();
        window.stick();
        window.lower();
        this._windowSignals = [
            window.connect_after('raised', () => window.lower()),
            window.connect('notify::minimized', () => {
                if (window.minimized)
                    window.unminimize();
            }),
            window.connect('notify::above', () => {
                if (window.above)
                    window.unmake_above();
            }),
            window.connect('unmanaged', () => this._forgetWindow()),
        ];
        this._placeWindow();
        this._indicator?.sync();
        console.log(`${this.uuid}: renderer window is now the wallpaper`);
    }

    _forgetWindow() {
        if (this._window) {
            for (const id of this._windowSignals)
                this._window.disconnect(id);
        }
        this._windowSignals = [];
        this._window = null;
    }

    _placeWindow() {
        const window = this._window;
        const mon = Main.layoutManager.primaryMonitor;
        if (!window || !mon)
            return;
        window.move_resize_frame(false, mon.x, mon.y, mon.width, mon.height);
    }

    // ---- stacking + pause policy ---------------------------------------
    _queueCheck() {
        if (this._checkId)
            return;
        this._checkId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._checkId = 0;
            this._keepAtBottom();
            this._setPaused(this._shouldPause());
            return GLib.SOURCE_REMOVE;
        });
    }

    _keepAtBottom() {
        const window = this._window;
        if (!window)
            return;
        // DING lowers its own desktop window after other windows map; make
        // sure the wallpaper ends up underneath it. lower() does not emit "raised",
        // so this settles after one extra restack.
        const stack = global.display.sort_windows_by_stacking(global.display.list_all_windows());
        if (stack.length && stack[0] !== window)
            window.lower();
    }

    _shouldPause() {
        if (Main.sessionMode.isLocked || this._settings.paused)
            return true;
        const mon = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        for (const w of ws.list_windows()) {
            if (w === this._window || w.minimized || w.get_monitor() !== mon)
                continue;
            if (w.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (!w.showing_on_its_workspace())
                continue;
            if (w.is_fullscreen() || w.is_maximized())
                return true;
        }
        return false;
    }

    _setPaused(paused) {
        if (!this._proc || paused === this._paused)
            return;
        try {
            this._proc.send_signal(paused ? SIGUSR1 : SIGUSR2);
            this._paused = paused;
            console.log(`${this.uuid}: ${paused ? 'paused' : 'resumed'}`);
            this._indicator?.sync();
        } catch (e) {
            console.warn(`${this.uuid}: ${e.message}`);
        }
    }
}
