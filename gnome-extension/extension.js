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
// The window-handling technique mirrors Ubuntu's Desktop Icons (DING)
// extension, which does the same thing for its own desktop window.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SIGUSR1 = 10;
const SIGUSR2 = 12;
const SIGTERM = 15;

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
        this._connect(Main.sessionMode, 'updated', () => this._queueCheck());

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
        if (Main.sessionMode.isLocked)
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
        } catch (e) {
            console.warn(`${this.uuid}: ${e.message}`);
        }
    }
}
