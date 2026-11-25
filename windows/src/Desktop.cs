using static Aether.Native;

namespace Aether;

/// <summary>Where on the desktop a wallpaper window goes, so it draws behind the icons.</summary>
/// <param name="Parent">The window to parent into.</param>
/// <param name="Kind">Which layout Explorer is using, for the log.</param>
sealed record DesktopLayout(IntPtr Parent, IntPtr Progman, string Kind)
{
    public bool IsAlive => IsWindow(Parent) && IsWindow(Progman);
}

static class Desktop
{
    /// <summary>
    /// The WorkerW technique. Sending 0x052C to Progman makes Explorer split the
    /// desktop into the icon layer (SHELLDLL_DefView) and a WorkerW behind it,
    /// and a child of that WorkerW draws between the wallpaper and the icons.
    ///
    /// Before Windows 11 24H2 the WorkerW is a top-level window, the next one
    /// after the WorkerW holding SHELLDLL_DefView. From 24H2 on, Progman keeps
    /// SHELLDLL_DefView and gets a child WorkerW of its own, below the icons.
    /// </summary>
    public static DesktopLayout? Find()
    {
        IntPtr progman = FindWindow("Progman", null);
        if (progman == 0) return null;

        SendMessageTimeout(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, out _);
        SendMessageTimeout(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, out _);

        // 24H2 and later: Progman > { SHELLDLL_DefView, WorkerW }
        IntPtr defView = FindWindowEx(progman, 0, "SHELLDLL_DefView", null);
        IntPtr child = FindWindowEx(progman, 0, "WorkerW", null);
        if (defView != 0 && child != 0) return new DesktopLayout(child, progman, "24H2 (WorkerW inside Progman)");

        // Older: top-level WorkerW > SHELLDLL_DefView, and the wallpaper WorkerW right after it
        IntPtr workerW = 0;
        EnumWindows((h, _) =>
        {
            if (FindWindowEx(h, 0, "SHELLDLL_DefView", null) != 0)
            {
                workerW = FindWindowEx(0, h, "WorkerW", null);
                return false;
            }
            return true;
        }, 0);
        if (workerW != 0) return new DesktopLayout(workerW, progman, "classic (top-level WorkerW)");

        // Explorer is still starting, or didn't split the desktop yet
        return null;
    }

    /// <summary>Make <paramref name="hwnd"/> a child of the desktop layer, covering <paramref name="screenBounds"/>.</summary>
    public static bool Attach(IntPtr hwnd, DesktopLayout layout, Rectangle screenBounds)
    {
        if (GetParent(hwnd) != layout.Parent)
        {
            uint style = (uint)GetWindowLongPtr(hwnd, GWL_STYLE);
            style = (style & ~WS_POPUP) | WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
            SetWindowLongPtr(hwnd, GWL_STYLE, (IntPtr)style);
            if (SetParent(hwnd, layout.Parent) == 0 && GetParent(hwnd) != layout.Parent)
                return false;
        }
        Place(hwnd, layout, screenBounds);
        return true;
    }

    /// <summary>Move an attached window so it covers <paramref name="screenBounds"/> (screen pixels).</summary>
    public static void Place(IntPtr hwnd, DesktopLayout layout, Rectangle screenBounds)
    {
        var r = new RECT(screenBounds);
        MapWindowPoints(0, layout.Parent, ref r, 2);   // screen → parent client coordinates
        SetWindowPos(hwnd, 0, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW);
    }

    /// <summary>Ask Explorer to repaint the plain wallpaper after we leave.</summary>
    public static void Repaint(DesktopLayout? layout)
    {
        foreach (var h in new[] { layout?.Parent ?? 0, layout?.Progman ?? FindWindow("Progman", null) })
            if (h != 0 && IsWindow(h))
                RedrawWindow(h, 0, 0, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
    }
}
