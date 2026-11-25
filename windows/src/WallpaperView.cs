using System.Globalization;
using Microsoft.Web.WebView2.Core;
using static Aether.Native;

namespace Aether;

/// <summary>
/// One monitor's wallpaper: a child window in the desktop layer holding a
/// WebView2 that shows web/wallpaper.html.
/// </summary>
sealed class WallpaperView : NativeWindow, IDisposable
{
    public const string HostName = "aether.example";
    public static readonly string Origin = $"https://{HostName}/";

    public MonitorInfo Monitor { get; private set; }
    DesktopLayout layout;
    CoreWebView2Controller? controller;
    bool ready, closed;
    double want = -1, sent = -1;

    /// <summary>The window or its browser went away underneath us (Explorer or WebView2 restarted).</summary>
    public event Action<WallpaperView, string>? Lost;

    public WallpaperView(MonitorInfo monitor, DesktopLayout layout)
    {
        Monitor = monitor;
        this.layout = layout;
        CreateHandle(new CreateParams
        {
            Caption = "Aether",
            Parent = layout.Parent,
            Style = unchecked((int)(WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS)),
            ExStyle = (int)WS_EX_NOACTIVATE,
        });
        if (!Desktop.Attach(Handle, layout, monitor.Bounds))
            throw new InvalidOperationException("could not parent into the desktop");
    }

    public async Task StartAsync(CoreWebView2Environment env, string webFolder, string url, bool devTools)
    {
        var c = await env.CreateCoreWebView2ControllerAsync(Handle);
        if (closed) { c.Close(); return; }
        controller = c;
        c.DefaultBackgroundColor = Color.Black;
        var wv = c.CoreWebView2;
        var s = wv.Settings;
        s.AreDefaultContextMenusEnabled = devTools;
        s.AreDevToolsEnabled = devTools;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        wv.SetVirtualHostNameToFolderMapping(HostName, webFolder, CoreWebView2HostResourceAccessKind.Allow);

        wv.NavigationStarting += (_, e) =>
        {
            ready = false; sent = -1;
            if (!e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
        };
        wv.NavigationCompleted += (_, e) =>
        {
            ready = e.IsSuccess;
            if (!e.IsSuccess) Log.Write($"{Monitor.Device}: page failed to load ({e.WebErrorStatus})");
            Push();
        };
        wv.NewWindowRequested += (_, e) => e.Handled = true;
        wv.ProcessFailed += (_, e) =>
        {
            Log.Write($"{Monitor.Device}: WebView2 {e.ProcessFailedKind}");
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                Lost?.Invoke(this, "browser process exited");
            else if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited
                     or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                try { wv.Reload(); } catch { Lost?.Invoke(this, "reload failed"); }
        };

        Fit();
        c.IsVisible = true;
        wv.Navigate(url);
    }

    /// <summary>Run a line of script in the page, once it has loaded.</summary>
    public void Run(string script)
    {
        if (ready && controller != null) _ = controller.CoreWebView2.ExecuteScriptAsync(script);
    }

    public void Navigate(string url)
    {
        if (controller != null) controller.CoreWebView2.Navigate(url);
    }

    /// <summary>Follow the monitor to a new position or size, or a new desktop parent.</summary>
    public void Place(MonitorInfo monitor, DesktopLayout layout)
    {
        Monitor = monitor;
        this.layout = layout;
        if (Handle != 0) Desktop.Attach(Handle, layout, monitor.Bounds);
        Fit();
    }

    public bool Alive => !closed && Handle != 0 && IsWindow(Handle) && GetParent(Handle) == layout.Parent;

    /// <summary>The page's level: 0 pauses (it fades out and stops drawing), anything else is the brightness.</summary>
    public void SetLevel(double level)
    {
        want = level;
        Push();
    }

    void Push()
    {
        if (!ready || controller == null || Math.Abs(want - sent) < 1e-6 || want < 0) return;
        sent = want;
        var v = want.ToString("0.###", CultureInfo.InvariantCulture);
        _ = controller.CoreWebView2.ExecuteScriptAsync(
            $"window.dispatchEvent(new CustomEvent('aether-level', {{ detail: {v} }}))");
    }

    void Fit()
    {
        if (controller == null || Handle == 0) return;
        GetClientRect(Handle, out var r);
        controller.Bounds = new Rectangle(0, 0, r.Right - r.Left, r.Bottom - r.Top);
        controller.NotifyParentWindowPositionChanged();
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case WM_ERASEBKGND:   // black until the page draws
                GetClientRect(m.HWnd, out var r);
                FillRect(m.WParam, ref r, GdiStockObject(4 /* BLACK_BRUSH */));
                m.Result = 1;
                return;
            case WM_MOUSEACTIVATE:
                m.Result = MA_NOACTIVATE;
                return;
            case 0x0005: // WM_SIZE
                Fit();
                break;
            case WM_DESTROY:
                if (!closed)
                {
                    // Explorer destroyed the desktop window we live in
                    closed = true;
                    Lost?.Invoke(this, "desktop window destroyed");
                }
                break;
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        closed = true;
        try { controller?.Close(); } catch { }
        controller = null;
        if (Handle != 0) DestroyHandle();
    }
}
