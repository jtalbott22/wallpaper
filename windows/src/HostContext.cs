using System.Drawing.Drawing2D;
using System.Globalization;
using Microsoft.Web.WebView2.Core;
using static Aether.Native;
using Timer = System.Windows.Forms.Timer;

namespace Aether;

/// <summary>
/// The whole app: one wallpaper view per monitor, the reasons to pause them,
/// and the tray icon.
/// </summary>
sealed class HostContext : ApplicationContext
{
    static readonly (string Key, string Title)[] Scenes =
    {
        ("nebula", "Nebula"), ("julia", "Julia"), ("reaction", "Reaction"), ("physarum", "Physarum"), ("attractor", "Attractor"),
        ("silk", "Silk"), ("chaos", "Chaos"), ("galaxy", "Galaxy"), ("ink", "Ink"), ("life", "Particle Life"),
        ("cymatics", "Cymatics"), ("turing", "Turing"), ("soup", "Free Energy"), ("cosmos", "Cosmos"), ("liquid", "Liquid"),
        ("bulb", "Mandelbulb"),
    };

    static readonly (string Key, string Title, string Note)[] Qualities =
    {
        ("saver", "Battery saver", "30 fps, lower resolution"),
        ("balanced", "Balanced", "30 fps"),
        ("high", "High", "60 fps, higher resolution, ray-marched shadows and the Mandelbulb"),
        ("max", "Maximum", "60 fps, up to full display resolution"),
    };

    readonly Settings settings = Settings.Load();
    readonly bool devTools;
    readonly string? sceneOverride;   // --scene, for this run only
    readonly int debugPort;
    readonly string webFolder;
    readonly Dictionary<string, WallpaperView> views = new(StringComparer.OrdinalIgnoreCase);
    readonly MessageWindow messages;
    readonly Timer rebuildTimer = new(), checkTimer = new() { Interval = 200 }, pollTimer = new() { Interval = 2000 },
        saveTimer = new() { Interval = 800 };
    readonly List<IntPtr> hooks = new();
    readonly WinEventProc hookProc;   // kept alive for the hooks

    CoreWebView2Environment? env;
    DesktopLayout? layout;
    List<MonitorInfo> monitors = new();
    HashSet<string> covered = new(StringComparer.OrdinalIgnoreCase);
    bool locked, saver, battery, building, rebuildAgain, exiting;
    string lastState = "";

    readonly NotifyIcon tray;
    Icon? trayIcon;
    string trayIconKey = "";
    readonly ToolStripMenuItem statusItem, pauseItem, loginItem, sceneMenu, nextItem, rotMenu, rotAllItem,
        qualityMenu, mathItem, mathAutoItem;
    readonly ToolStripLabel brightLabel;
    readonly TrackBar slider;

    public HostContext(bool devTools, int debugPort, string? scene = null)
    {
        this.devTools = devTools;
        sceneOverride = scene != null && Scenes.Any(x => x.Key == scene) ? scene : null;
        if (scene != null && sceneOverride == null) Log.Write($"unknown scene '{scene}'");
        settings.Skip = Scenes.Select(x => x.Key).Where(settings.Skip.Contains).ToList();   // known keys, menu order
        this.debugPort = debugPort;
        webFolder = FindWebFolder();
        Log.Write("page folder " + webFolder);

        // tray
        statusItem = new ToolStripMenuItem("Starting…") { Enabled = false };
        brightLabel = new ToolStripLabel();
        slider = new TrackBar
        {
            Minimum = 5, Maximum = 150, TickFrequency = 25, SmallChange = 5, LargeChange = 10,
            AutoSize = false, Width = 200, Height = 32, TickStyle = TickStyle.None,
            Value = (int)Math.Round(settings.Brightness * 100),
        };
        slider.ValueChanged += (_, _) => SetBrightness(slider.Value / 100.0);
        var sliderHost = new ToolStripControlHost(slider) { AutoSize = false, Width = 210, Height = 34, Margin = new Padding(8, 0, 0, 4) };
        pauseItem = new ToolStripMenuItem("Pause", null, (_, _) => SetPaused(!settings.Paused));
        loginItem = new ToolStripMenuItem("Start at login", null, (_, _) => ToggleLogin());
        sceneMenu = new ToolStripMenuItem("Scene");
        sceneMenu.DropDownItems.Add(SceneItem(null, "All scenes, in turn"));
        sceneMenu.DropDownItems.Add(new ToolStripSeparator());
        foreach (var (key, title) in Scenes) sceneMenu.DropDownItems.Add(SceneItem(key, title));
        nextItem = new ToolStripMenuItem("Next scene", null, (_, _) => NextScene());

        // switch scenes you don't like out of the rotation (they can still be picked under Scene)
        rotMenu = new ToolStripMenuItem("Scenes in rotation");
        foreach (var (key, title) in Scenes)
        {
            var item = new ToolStripMenuItem(title) { Tag = key };
            item.Click += (_, _) => SetInRotation(key, settings.Skip.Contains(key));
            rotMenu.DropDownItems.Add(item);
        }
        rotMenu.DropDownItems.Add(new ToolStripSeparator());
        rotAllItem = new ToolStripMenuItem("Put all back", null, (_, _) => ResetRotation());
        rotMenu.DropDownItems.Add(rotAllItem);
        // stay open while switching several scenes
        rotMenu.DropDown.Closing += (_, e) =>
        {
            if (e.CloseReason == ToolStripDropDownCloseReason.ItemClicked) e.Cancel = true;
        };

        qualityMenu = new ToolStripMenuItem("Quality");
        foreach (var (key, title, note) in Qualities)
        {
            var item = new ToolStripMenuItem(title) { Tag = key, ToolTipText = note };
            item.Click += (_, _) => SetQuality(key);
            qualityMenu.DropDownItems.Add(item);
        }
        qualityMenu.DropDownItems.Add(new ToolStripSeparator());
        qualityMenu.DropDownItems.Add(new ToolStripMenuItem("Resolution adapts per scene to keep motion smooth") { Enabled = false });

        mathItem = new ToolStripMenuItem("Show the math", null, (_, _) => ShowMath());
        mathAutoItem = new ToolStripMenuItem("Show the math when a scene starts", null, (_, _) => ToggleMathAuto());

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            statusItem, new ToolStripSeparator(), brightLabel, sliderHost, new ToolStripSeparator(),
            pauseItem, sceneMenu, rotMenu, nextItem, qualityMenu, new ToolStripSeparator(),
            mathItem, mathAutoItem, new ToolStripSeparator(),
            loginItem, new ToolStripSeparator(),
            new ToolStripMenuItem("Open Aether in browser", null, (_, _) => OpenPage()),
            new ToolStripMenuItem("Reload", null, (_, _) => Reload()),
            new ToolStripMenuItem("Open log folder", null, (_, _) => OpenFolder(Log.Folder)),
            new ToolStripMenuItem("Exit", null, (_, _) => ExitThread()),
        });
        menu.Opening += (_, _) => { loginItem.Checked = Startup.Enabled; UpdateMenu(); };
        tray = new NotifyIcon { Text = "Aether", ContextMenuStrip = menu };
        SetTrayIcon(false);
        tray.Visible = true;
        tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)   // left click opens the same menu
                typeof(NotifyIcon).GetMethod("ShowContextMenu",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)?.Invoke(tray, null);
        };

        // what to listen to
        messages = new MessageWindow();
        messages.TaskbarCreated += () => { Log.Write("Explorer restarted"); DisposeViews(); layout = null; ScheduleRebuild(1500); };
        messages.DisplayChanged += () => { ScheduleRebuild(400); UpdateMenu(); };
        messages.ThemeChanged += UpdateMenu;   // light or dark taskbar
        messages.SessionLock += isLocked => { locked = isLocked; Log.Write(isLocked ? "session locked" : "session unlocked"); Evaluate(); };

        hookProc = OnWinEvent;
        Hook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND);
        Hook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND);
        Hook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND);
        Hook(EVENT_OBJECT_DESTROY, 0x8003 /* SHOW, HIDE */);
        Hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE);
        Hook(EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED);

        rebuildTimer.Tick += (_, _) => { rebuildTimer.Stop(); _ = RebuildAsync(); };
        checkTimer.Tick += (_, _) => { checkTimer.Stop(); Evaluate(); };
        pollTimer.Tick += (_, _) => Poll();
        saveTimer.Tick += (_, _) => { saveTimer.Stop(); settings.Save(); };

        saver = PowerSaving();
        battery = OnBattery();
        if (battery && settings.BatteryFps > 0) Log.Write($"on battery: {settings.BatteryFps} fps cap");
        pollTimer.Start();
        UpdateMenu();
        ScheduleRebuild(1);
    }

    // ---- building the views --------------------------------------------------

    void ScheduleRebuild(int delayMs)
    {
        if (exiting) return;
        rebuildTimer.Stop();
        rebuildTimer.Interval = Math.Max(1, delayMs);
        rebuildTimer.Start();
    }

    async Task RebuildAsync()
    {
        if (building) { rebuildAgain = true; return; }
        building = true;
        try
        {
            if (env == null)
            {
                try
                {
                    var options = new CoreWebView2EnvironmentOptions(
                        debugPort > 0 ? $"--remote-debugging-port={debugPort}" : null);
                    env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Log.Folder, "WebView2"), options);
                    Log.Write("WebView2 " + env.BrowserVersionString);
                }
                catch (WebView2RuntimeNotFoundException)
                {
                    MessageBox.Show("Aether needs the Microsoft Edge WebView2 Runtime.\n\nInstall it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start Aether again.",
                        "Aether", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    ExitThread();
                    return;
                }
                env.BrowserProcessExited += (_, _) => { if (!exiting) { Log.Write("WebView2 browser exited"); env = null; DisposeViews(); ScheduleRebuild(2000); } };
            }

            if (layout == null || !layout.IsAlive)
            {
                var found = Desktop.Find();
                if (found == null) { Log.Write("desktop not ready, retrying"); ScheduleRebuild(1000); return; }
                if (layout?.Parent != found.Parent) DisposeViews();
                layout = found;
                Log.Write($"desktop layout: {found.Kind}, parent 0x{found.Parent:X}");
            }

            var lay = layout;
            monitors = Monitors.All();
            foreach (var dev in views.Keys.ToList())
            {
                var v = views[dev];
                if (!v.Alive || !monitors.Any(m => m.Device.Equals(dev, StringComparison.OrdinalIgnoreCase)))
                {
                    v.Dispose();
                    views.Remove(dev);
                }
            }
            foreach (var m in monitors)
            {
                if (views.TryGetValue(m.Device, out var v)) { v.Place(m, lay); continue; }
                try
                {
                    v = new WallpaperView(m, lay);
                    v.Lost += OnViewLost;
                    v.SceneChanged += _ => UpdateMenu();
                    v.SetFps(FpsCap());
                    views[m.Device] = v;
                    Log.Write($"{m.Device}: {m.Bounds.Width}x{m.Bounds.Height} at {m.Bounds.X},{m.Bounds.Y}");
                    await v.StartAsync(env, webFolder, PageUrl(), devTools);
                }
                catch (Exception e)
                {
                    Log.Write($"{m.Device}: {e.Message}");
                    if (views.Remove(m.Device, out var bad)) bad.Dispose();
                    ScheduleRebuild(3000);
                }
            }
            Evaluate();
        }
        finally
        {
            building = false;
            if (rebuildAgain) { rebuildAgain = false; ScheduleRebuild(100); }
        }
    }

    void OnViewLost(WallpaperView v, string why)
    {
        if (exiting) return;
        Log.Write($"{v.Monitor.Device}: lost ({why})");
        ScheduleRebuild(1000);   // never tear down from inside WM_DESTROY
    }

    void DisposeViews()
    {
        foreach (var v in views.Values) { v.Lost -= OnViewLost; v.Dispose(); }
        views.Clear();
    }

    void Reload()
    {
        DisposeViews();
        layout = null;
        ScheduleRebuild(1);
    }

    string PageUrl()
    {
        var url = $"{WallpaperView.Origin}wallpaper.html?level={settings.Brightness.ToString("0.##", CultureInfo.InvariantCulture)}";
        if ((sceneOverride ?? settings.Scene) is { } s) url += "&aether=" + s;
        url += "&quality=" + settings.Quality;
        if (!settings.MathOnStart) url += "&math=0";
        if (settings.Skip.Count > 0) url += "&skip=" + string.Join(",", settings.Skip);
        int fps = FpsCap();
        if (fps > 0) url += "&fps=" + fps;
        return url;
    }

    int FpsCap() => battery ? settings.BatteryFps : 0;

    void NavigateAll()
    {
        var url = PageUrl();
        foreach (var v in views.Values) v.Navigate(url);
        UpdateMenu();
    }

    static string FindWebFolder()
    {
        // inside a checkout, use the repository's web/ so edits show up on Reload
        var dir = new DirectoryInfo(AppContext.BaseDirectory).Parent;
        for (; dir != null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "web", "wallpaper.html")) &&
                File.Exists(Path.Combine(dir.FullName, "windows", "Aether.csproj")))
                return Path.Combine(dir.FullName, "web");
        return Path.Combine(AppContext.BaseDirectory, "web");   // the copy shipped next to the exe
    }

    // ---- pausing -------------------------------------------------------------

    void Hook(uint min, uint max)
    {
        var h = SetWinEventHook(min, max, 0, hookProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (h != 0) hooks.Add(h);
    }

    void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (ev >= 0x8000 && (idObject != 0 || idChild != 0 || hwnd == 0)) return;   // windows only, not carets or controls
        checkTimer.Stop();
        checkTimer.Start();
    }

    void Poll()
    {
        bool s = PowerSaving();
        if (s != saver) { saver = s; Log.Write(s ? "energy saver on" : "energy saver off"); }
        bool b = OnBattery();
        if (b != battery)
        {
            battery = b;
            Log.Write(b ? "power: battery" + (settings.BatteryFps > 0 ? $", {settings.BatteryFps} fps cap" : "") : "power: mains");
            foreach (var v in views.Values) v.SetFps(FpsCap());
        }
        if (layout != null && !layout.IsAlive) { Log.Write("desktop window gone"); DisposeViews(); layout = null; ScheduleRebuild(500); }
        Evaluate();
    }

    /// <summary>Send each monitor its level: the brightness, or 0 if it should be paused.</summary>
    void Evaluate()
    {
        if (exiting) return;
        string by = "";
        covered = monitors.Count > 0 ? Monitors.Covered(monitors, out by) : new(StringComparer.OrdinalIgnoreCase);
        string? all = Reason();
        foreach (var (dev, v) in views)
            v.SetLevel(all != null || covered.Contains(dev) ? 0 : settings.Brightness);

        var state = all ?? (covered.Count > 0 ? $"covered: {string.Join(", ", covered.Order())} by {by}" : "running");
        if (state != lastState) { Log.Write("state " + state); lastState = state; }
        UpdateMenu();
    }

    string? Reason() => settings.Paused ? "paused" : locked ? "locked" : saver ? "energy saver" : null;

    void SetPaused(bool paused)
    {
        settings.Paused = paused;
        settings.Save();
        Evaluate();
    }

    void SetBrightness(double level)
    {
        settings.Brightness = Math.Clamp(level, 0.05, 1.5);
        saveTimer.Stop(); saveTimer.Start();
        Evaluate();
    }

    // ---- tray ----------------------------------------------------------------

    ToolStripMenuItem SceneItem(string? scene, string label)
    {
        var item = new ToolStripMenuItem(label) { Tag = scene };
        item.Click += (_, _) =>
        {
            settings.Scene = scene;
            settings.Save();
            Log.Write("scene: " + (scene ?? "all"));
            NavigateAll();
        };
        return item;
    }

    void SetInRotation(string key, bool on)
    {
        settings.Skip.Remove(key);
        if (!on) settings.Skip.Add(key);
        settings.Skip = Scenes.Select(x => x.Key).Where(settings.Skip.Contains).ToList();   // menu order
        settings.Save();
        SendSkip();
    }

    void ResetRotation()
    {
        settings.Skip.Clear();
        settings.Save();
        SendSkip();
    }

    void SendSkip()
    {
        Log.Write("left out of the rotation: " + (settings.Skip.Count > 0 ? string.Join(", ", settings.Skip) : "none"));
        var json = System.Text.Json.JsonSerializer.Serialize(settings.Skip);
        foreach (var v in views.Values) v.Send("aether-skip", json);
        UpdateMenu();
    }

    void SetQuality(string key)
    {
        if (key == settings.Quality) return;
        settings.Quality = key;
        settings.Save();
        Log.Write("quality: " + key);
        NavigateAll();   // the page reads its preset when it loads
    }

    void ShowMath()
    {
        foreach (var v in views.Values) v.Send("aether-show-math");
    }

    void ToggleMathAuto()
    {
        settings.MathOnStart = !settings.MathOnStart;
        settings.Save();
        foreach (var v in views.Values) v.Send("aether-math-auto", settings.MathOnStart ? "true" : "false");
        UpdateMenu();
    }

    void NextScene()
    {
        foreach (var v in views.Values) v.Run("window.Aether && Aether.next()");
    }

    /// <summary>The interactive page (web/aether.html) in the default browser.</summary>
    void OpenPage()
    {
        var page = Path.Combine(webFolder, "aether.html");
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(page) { UseShellExecute = true });
        }
        catch (Exception e)
        {
            Log.Write("open page: " + e.Message);
            MessageBox.Show($"Cannot open {page}\n\n{e.Message}", "Aether", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void ToggleLogin()
    {
        try { Startup.Enabled = !Startup.Enabled; }
        catch (Exception e) { Log.Write("start at login: " + e.Message); }
        loginItem.Checked = Startup.Enabled;
    }

    void UpdateMenu()
    {
        string? all = Reason();
        int n = views.Count, c = views.Keys.Count(covered.Contains);
        string status = n == 0 ? "Starting…"
            : all != null ? $"Paused ({all})"
            : c == n ? $"Paused (covered by a {(n == 1 ? "window" : "window on every display")})"
            : c > 0 ? $"Running on {n - c} of {n} displays"
            : n == 1 ? "Running" : $"Running on {n} displays";
        var showing = views.Where(kv => !covered.Contains(kv.Key)).OrderBy(kv => kv.Key)
            .Select(kv => kv.Value.SceneName).OfType<string>().Distinct().ToList();
        statusItem.Text = all == null && c < n && showing.Count > 0 ? status + " · " + string.Join(", ", showing) : status;
        pauseItem.Text = settings.Paused ? "Resume" : "Pause";
        brightLabel.Text = $"Brightness  {Math.Round(settings.Brightness * 100)}%";
        string sceneTitle = "All, in turn";
        foreach (ToolStripItem i in sceneMenu.DropDownItems)
            if (i is ToolStripMenuItem mi)
            {
                mi.Checked = Equals(mi.Tag, settings.Scene);
                if (mi.Checked && mi.Tag != null) sceneTitle = mi.Text ?? "";
            }
        sceneMenu.Text = "Scene: " + sceneTitle;

        int left = 0;
        foreach (ToolStripItem i in rotMenu.DropDownItems)
            if (i is ToolStripMenuItem mi && mi.Tag is string key)
            {
                mi.Checked = !settings.Skip.Contains(key);
                if (!mi.Checked) left++;
            }
        rotMenu.Text = left > 0 ? $"Scenes in rotation: {Scenes.Length - left} of {Scenes.Length}" : "Scenes in rotation: all";
        rotAllItem.Enabled = left > 0;

        string qualityTitle = "Balanced";
        foreach (ToolStripItem i in qualityMenu.DropDownItems)
            if (i is ToolStripMenuItem mi && mi.Tag is string key)
            {
                mi.Checked = key == settings.Quality;
                if (mi.Checked) qualityTitle = mi.Text ?? "";
            }
        qualityMenu.Text = "Quality: " + qualityTitle;
        mathAutoItem.Checked = settings.MathOnStart;
        mathItem.Enabled = n > 0 && all == null;
        nextItem.Enabled = n > 0 && all == null;
        SetTrayIcon(all != null || (n > 0 && c == n));
        var tip = "Aether: " + status;
        tray.Text = tip.Length > 127 ? tip[..127] : tip;
    }

    /// <summary>The Aether mark in the taskbar's colour, dimmed while paused.</summary>
    void SetTrayIcon(bool dim)
    {
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        bool light = LightTaskbar();
        var key = $"{size}/{light}/{dim}";
        if (key == trayIconKey) return;
        var old = trayIcon;
        trayIcon = Icons.TrayIcon(size, light, dim);
        trayIconKey = key;
        tray.Icon = trayIcon;
        old?.Dispose();
    }

    static bool LightTaskbar()
    {
        using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return k?.GetValue("SystemUsesLightTheme") is int v && v != 0;
    }

    static void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
    }

    protected override void ExitThreadCore()
    {
        exiting = true;
        foreach (var t in new[] { rebuildTimer, checkTimer, pollTimer, saveTimer }) t.Stop();
        foreach (var h in hooks) UnhookWinEvent(h);
        hooks.Clear();
        settings.Save();
        DisposeViews();
        Desktop.Repaint(layout);
        tray.Visible = false;
        tray.Dispose();
        messages.Dispose();
        base.ExitThreadCore();
    }
}

/// <summary>
/// A hidden top-level window for broadcasts: TaskbarCreated (Explorer
/// restarted), display and DPI changes, and session lock / unlock.
/// </summary>
sealed class MessageWindow : NativeWindow, IDisposable
{
    readonly uint taskbarCreated = RegisterWindowMessage("TaskbarCreated");
    public event Action? TaskbarCreated, DisplayChanged, ThemeChanged;
    public event Action<bool>? SessionLock;

    public MessageWindow()
    {
        CreateHandle(new CreateParams { Caption = "Aether messages", ExStyle = (int)WS_EX_TOOLWINDOW });
        WTSRegisterSessionNotification(Handle, 0 /* this session */);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == (int)taskbarCreated) TaskbarCreated?.Invoke();
        else if (m.Msg is WM_DISPLAYCHANGE or WM_DPICHANGED) DisplayChanged?.Invoke();
        else if (m.Msg == WM_SETTINGCHANGE && (int)m.WParam == 0x2F /* SPI_SETWORKAREA */) DisplayChanged?.Invoke();
        else if (m.Msg == WM_SETTINGCHANGE && m.LParam != 0 &&
                 System.Runtime.InteropServices.Marshal.PtrToStringUni(m.LParam) == "ImmersiveColorSet") ThemeChanged?.Invoke();
        else if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            if ((int)m.WParam == WTS_SESSION_LOCK) SessionLock?.Invoke(true);
            else if ((int)m.WParam == WTS_SESSION_UNLOCK) SessionLock?.Invoke(false);
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (Handle != 0) { WTSUnRegisterSessionNotification(Handle); DestroyHandle(); }
    }
}
