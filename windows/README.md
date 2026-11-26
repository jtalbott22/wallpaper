# Aether for Windows

A small native host that shows [`web/wallpaper.html`](../web/wallpaper.html)
as your desktop wallpaper, behind the desktop icons, on every monitor.
It's C# / .NET 8 with WebView2, under 1,000 lines, no installer framework.

## Requirements

- Windows 10 or 11 (tested on Windows 11 build 26300, which uses the 24H2 desktop layout)
- The [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) to build
  it (a newer SDK works too)
- The Microsoft Edge WebView2 Runtime, which Windows 11 already has
  ([download](https://go.microsoft.com/fwlink/p/?LinkId=2124703) for Windows 10)

## Install from a single Aether.exe

`build-exe.ps1` makes one self-contained `windows\dist\Aether.exe` (about
65 MB) with .NET and the page built in, to copy to any PC:

```powershell
.\windows\build-exe.ps1
```

Double-click it and it offers to **Install** (or **Update**) for the current
user, with no admin rights: it copies itself to `%LOCALAPPDATA%\Programs\Aether`,
adds a Start menu entry, starts at login if the box is ticked, and lists
itself in **Settings › Apps**, where **Uninstall** removes it again.
**Just run it** runs it from where it is without installing. The page is
unpacked to `%LOCALAPPDATA%\Aether\web`. Flags for scripts:
`--install [--start-at-login]`, `--uninstall [--quiet]`, `--no-install`.

The exe isn't signed, so the first time SmartScreen may say "Windows
protected your PC": choose **More info › Run anyway**.

## Install with the script

From PowerShell in the repository:

```powershell
.\windows\install.ps1 -StartAtLogin
```

This builds a release copy into `%LOCALAPPDATA%\Programs\Aether`, adds
Aether to the Start menu, starts it, and adds it to your login items. Leave
out `-StartAtLogin` to choose later from the tray menu. Running the script
again updates it in place (it closes the running copy first).

Options:

| | |
|---|---|
| `-SelfContained` | bundle .NET, for a machine without the .NET 8 Desktop Runtime (about 150 MB) |
| `-Destination <folder>` | install somewhere else |
| `-NoStart` | don't start it after installing |
| `-NoShortcut` | don't add a Start menu entry |
| `-Uninstall` | close it, delete it, and remove the Start menu and login entries |

If PowerShell refuses to run the script, allow local scripts for this
session first: `Set-ExecutionPolicy -Scope Process Bypass`.

## Build and run from the repository

```powershell
cd windows
dotnet build -c Release
.\bin\Release\net8.0-windows\Aether.exe
```

Run from inside the checkout, it loads the page from the repository's `web/`
folder, so after editing `web/aether-bg.js` choose **Reload** in the tray menu
to see the change. An installed copy uses the `web/` folder shipped next to
the exe.

## Using it

Aether lives in the notification area (click the ^ arrow if it's hidden).
Click its icon for:

- **Brightness** slider (5–150%), saved
- **Pause / Resume**, saved
- The status line says what's playing on each display
- **Scene**: all of them in turn, or stay on one
- **Scenes in rotation**: tick scenes on or off (the menu stays open while you
  do); a scene left out can still be picked under **Scene**. **Put all back**
  restores them. Changes apply live, without a reload
- **Next scene**: move on now
- **Quality**: Battery saver, Balanced (default), High (60 fps, ray-marched
  shadows and the Mandelbulb) or Maximum (60 fps, up to full resolution);
  resolution adapts per scene to keep motion smooth
- **Show the math**: the card with the current scene's equations, and
  **Show the math when a scene starts** to turn that card on or off
- **Start at login**: adds or removes `Aether` under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- **Open Aether in browser**: the hands-on page, `web/aether.html`
- **Reload**, **Open log folder**, **Exit**

The tray icon is the Aether mark (ring, core and swirl), the same one as the
macOS menu bar, the GNOME top bar and the web page's favicon. It follows the
taskbar's light or dark colour and greys out while the wallpaper is paused.
The exe, taskbar and Start menu use the favicon form, a white mark on a black
rounded square (`Aether.ico`). The drawing lives in `src/Icons.cs`; after
changing it, run `.\make-icon.ps1` to regenerate `Aether.ico`.

It pauses on its own (sending the page level 0, which fades it out and stops
drawing, so a paused wallpaper costs nothing) and resumes afterwards:

- on a monitor that a maximized or fullscreen window covers, per monitor
- while the session is locked
- while battery saver / energy saver is on

On battery (and not in battery saver) it caps the frame rate at 20 fps, as
the Linux host does; set `"BatteryFps"` in settings.json to change that, or
0 for no cap.

Settings are in `%APPDATA%\Aether\settings.json` (brightness, pause, scene,
quality, math on start, scenes left out, battery fps), the log in
`%LOCALAPPDATA%\Aether\aether.log`, which also records each scene as it
starts and quality changes the page makes.

`Aether.exe --exit` closes a running copy cleanly. `Aether.exe --scene physarum`
stays on one scene for that run without changing the saved choice.

## How it works

- **Behind the icons.** Sending message `0x052C` to `Progman` makes Explorer
  split the desktop into the icon layer (`SHELLDLL_DefView`) and a `WorkerW`
  behind it. Before Windows 11 24H2 that `WorkerW` is a top-level window,
  found right after the one that holds `SHELLDLL_DefView`; from 24H2 on it's a
  child of `Progman` itself, below `SHELLDLL_DefView`. `Desktop.cs` handles
  both and logs which one it found. Each monitor gets a child window of that
  `WorkerW` holding a WebView2.
- **Explorer restarts.** When Explorer restarts, the desktop windows (and so
  ours) are destroyed. Aether notices (`TaskbarCreated`, its window being
  destroyed, or a 2-second check) and attaches again.
- **Monitors and DPI.** One view per monitor, positioned in physical pixels
  (the app is per-monitor DPI aware v2). Display, work-area and DPI changes
  reposition, add and remove views; WebView2 follows each monitor's scale.
- **The page** is served from `https://aether.example/` through
  `SetVirtualHostNameToFolderMapping`, not `file://`, and the brightness
  goes in as `?level=`. Pausing and brightness changes are sent live with the
  `aether-level` event.
- **Covered?** Window events (foreground, move/size, minimize, show/hide,
  cloak) trigger a check, debounced to 200 ms, plus one every 2 seconds. A
  monitor counts as covered when a visible, uncloaked, non-minimized window is
  maximized on it or covers all of it. Click-through overlays don't count.

## Troubleshooting

- **Nothing shows.** Open the log (tray → Open log folder). It names the
  desktop layout it found and, when it's paused, why, including which window
  covers the screen.
- **Black screen instead of the animation.** Check the log for
  "page failed to load". Start it with `--devtools` to get a right-click menu
  with Inspect, or `--debug-port=9222` to attach Chrome DevTools at
  `http://localhost:9222`.
- **Wallpaper stays after Exit.** Explorer repaints the normal wallpaper when
  Aether exits; if a frame lingers, right-click the desktop and choose
  Refresh.

## Files

```
Aether.csproj         .NET 8 WinForms project; copies web/ next to the exe
Aether.ico            app icon, generated by make-icon.ps1
app.manifest          Windows 10/11 compatibility
install.ps1           build, install, Start menu entry, start at login, uninstall
build-exe.ps1         the single self-installing Aether.exe in dist\
make-icon.ps1         regenerates Aether.ico from src/Icons.cs
src/Program.cs        single instance, --exit, command-line flags
src/HostContext.cs    the app: views per monitor, pause rules, tray menu, broadcasts
src/WallpaperView.cs  one monitor's child window and WebView2
src/Desktop.cs        the WorkerW technique, classic and 24H2 layouts
src/Monitors.cs       monitor list and "is it covered" check
src/Icons.cs          the Aether mark: tray icon and app icon
src/Settings.cs       settings.json, the Run key, the log
src/Installer.cs      the single exe's self-install, uninstall and built-in page
src/Native.cs         Win32 declarations
```
