namespace Aether;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        // Aether.exe --exit asks a running copy to close cleanly
        using var exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\AetherWallpaperHostExit");
        if (args.Contains("--exit", StringComparer.OrdinalIgnoreCase)) { exitSignal.Set(); return 0; }

        using var single = new Mutex(true, @"Local\AetherWallpaperHost", out bool first);
        if (!first) return 0;   // already running: its tray icon has the controls
        exitSignal.Reset();

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (_, e) => Log.Write("error: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write("fatal: " + e.ExceptionObject);

        // --devtools: right-click menu and F12 in the wallpaper; --debug-port=9222: Chrome DevTools Protocol
        bool devTools = args.Contains("--devtools", StringComparer.OrdinalIgnoreCase);
        int debugPort = args.Select(a => a.StartsWith("--debug-port=", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(a["--debug-port=".Length..], out int p) ? p : 0).DefaultIfEmpty(0).Max();
        // --scene physarum: stay on one scene for this run (the tray's Scene choice is the saved one)
        int si = Array.FindIndex(args, a => a.Equals("--scene", StringComparison.OrdinalIgnoreCase));
        string? scene = si >= 0 && si + 1 < args.Length ? args[si + 1].ToLowerInvariant() : null;
        Log.Write($"start {Application.ProductVersion} on {Environment.OSVersion.Version}");
        var host = new HostContext(devTools, debugPort, scene);
        var ui = SynchronizationContext.Current!;
        ThreadPool.RegisterWaitForSingleObject(exitSignal, (_, _) => ui.Post(_ => host.ExitThread(), null), null, -1, true);
        Application.Run(host);
        Log.Write("exit");
        return 0;
    }
}
