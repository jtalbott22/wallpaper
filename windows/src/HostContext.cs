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
    static readonly string[] Scenes = { "nebula", "julia", "reaction", "physarum", "attractor" };

    readonly Settings settings = Settings.Load();
    readonly bool devTools;
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
    bool locked, saver, building, rebuildAgain, exiting;
    string lastState = "";

    readonly NotifyIcon tray;
    readonly Icon iconOn, iconOff;
    readonly ToolStripMenuItem statusItem, pauseItem, loginItem, sceneMenu;
    readonly ToolStripLabel brightLabel;
    readonly TrackBar slider;

    public HostContext(bool devTools, int debugPort)
    {
        this.devTools = devTools;
        this.debugPort = debugPort;
        webFolder = FindWebFolder();
        Log.Write("page folder " + webFolder);

        // tray
        iconOn = MakeIcon(true); iconOff = MakeIcon(false);
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
        foreach (var s in Scenes) sceneMenu.DropDownItems.Add(SceneItem(s, CultureInfo.InvariantCulture.TextInfo.ToTitleCase(s)));

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            statusItem, new ToolStripSeparator(), brightLabel, sliderHost, new ToolStripSeparator(),
            pauseItem, sceneMenu, loginItem, new ToolStripSeparator(),
            new ToolStripMenuItem("Reload", null, (_, _) => Reload()),
            new ToolStripMenuItem("Open log folder", null, (_, _) => OpenFolder(Log.Folder)),
            new ToolStripMenuItem("Exit", null, (_, _) => ExitThread()),
        });
        menu.Opening += (_, _) => { loginItem.Checked = Startup.Enabled; UpdateMenu(); };
        tray = new NotifyIcon { Icon = iconOn, Text = "Aether", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)   // left click opens the same menu
                typeof(NotifyIcon).GetMethod("ShowContextMenu",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)?.Invoke(tray, null);
        };

        // what to listen to
        messages = new MessageWindow();
        messages.TaskbarCreated += () => { Log.Write("Explorer restarted"); DisposeViews(); layout = null; ScheduleRebuild(1500); };
        messages.DisplayChanged += () => ScheduleRebuild(400);
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
        return settings.Scene is { } s ? url + "&aether=" + s : url;
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
            foreach (var v in views.Values) v.Navigate(PageUrl());
            UpdateMenu();
        };
        return item;
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
        statusItem.Text = status;
        pauseItem.Text = settings.Paused ? "Resume" : "Pause";
        brightLabel.Text = $"Brightness  {Math.Round(settings.Brightness * 100)}%";
        foreach (ToolStripItem i in sceneMenu.DropDownItems)
            if (i is ToolStripMenuItem mi) mi.Checked = Equals(mi.Tag, settings.Scene);
        var paused = all != null || (n > 0 && c == n);
        tray.Icon = paused ? iconOff : iconOn;
        var tip = "Aether: " + status;
        tray.Text = tip.Length > 127 ? tip[..127] : tip;
    }

    static Icon MakeIcon(bool on)
    {
        int s = Math.Max(16, SystemInformation.SmallIconSize.Width);
        using var bmp = new Bitmap(s, s);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new RectangleF(0.5f, 0.5f, s - 1.5f, s - 1.5f);
            using var path = new GraphicsPath();
            path.AddEllipse(rect);
            using var brush = new PathGradientBrush(path)
            {
                CenterPoint = new PointF(s * 0.38f, s * 0.34f),
                CenterColor = on ? Color.FromArgb(255, 255, 220, 150) : Color.FromArgb(255, 170, 170, 170),
                SurroundColors = new[] { on ? Color.FromArgb(255, 70, 40, 160) : Color.FromArgb(255, 70, 70, 70) },
            };
            g.FillEllipse(brush, rect);
        }
        IntPtr h = bmp.GetHicon();
        var icon = (Icon)Icon.FromHandle(h).Clone();
        DestroyIcon(h);
        return icon;
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
    public event Action? TaskbarCreated, DisplayChanged;
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
