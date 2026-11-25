using static Aether.Native;

namespace Aether;

/// <summary>A display, in physical screen pixels.</summary>
sealed record MonitorInfo(IntPtr Handle, string Device, Rectangle Bounds, bool Primary);

static class Monitors
{
    public static List<MonitorInfo> All()
    {
        var list = new List<MonitorInfo>();
        EnumDisplayMonitors(0, 0, (IntPtr h, IntPtr _, ref RECT __, IntPtr ___) =>
        {
            var mi = new MONITORINFOEX { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<MONITORINFOEX>() };
            if (GetMonitorInfo(h, ref mi))
                list.Add(new MonitorInfo(h, mi.szDevice, mi.rcMonitor.ToRectangle(), (mi.dwFlags & 1) != 0));
            return true;
        }, 0);
        return list;
    }

    static readonly HashSet<string> ShellClasses = new(StringComparer.Ordinal)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    };

    /// <summary>
    /// The monitors (by device name) that a maximized or fullscreen window
    /// covers. Minimized, hidden, cloaked (other virtual desktops, closed
    /// Start/Search) and click-through overlay windows don't count.
    /// </summary>
    public static HashSet<string> Covered(IReadOnlyList<MonitorInfo> monitors, out string by)
    {
        var who = new List<string>();
        var covered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        uint self = (uint)Environment.ProcessId;
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) || IsIconic(h) || IsCloaked(h)) return true;
            GetWindowThreadProcessId(h, out uint pid);
            if (pid == self) return true;
            uint ex = (uint)GetWindowLongPtr(h, GWL_EXSTYLE);
            if ((ex & WS_EX_TRANSPARENT) != 0) return true;
            if (ShellClasses.Contains(ClassOf(h))) return true;

            int before = covered.Count;
            if (IsZoomed(h))
            {
                IntPtr hm = MonitorFromWindow(h, MONITOR_DEFAULTTONULL);
                foreach (var m in monitors) if (m.Handle == hm) covered.Add(m.Device);
            }
            else if (GetWindowRect(h, out var wr))
            {
                var r = wr.ToRectangle();
                foreach (var m in monitors) if (r.Contains(m.Bounds)) covered.Add(m.Device);
            }
            if (covered.Count > before)
            {
                string name;
                try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = "?"; }
                who.Add($"{name} ({ClassOf(h)}{(IsZoomed(h) ? ", maximized" : ", fullscreen")})");
            }
            return covered.Count < monitors.Count;
        }, 0);
        by = string.Join(", ", who);
        return covered;
    }
}
