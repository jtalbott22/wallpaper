# Windows and macOS

The Linux version (`aether/` + `gnome-extension/`) uses OpenGL 4.3 compute
shaders, GTK 4 and a GNOME Shell extension. None of that carries over well:
macOS stops at OpenGL 4.1 with no compute shaders, and Windows has no GNOME
and no easy GTK 4.

The web port does run everywhere. [`web/wallpaper.html`](../web/wallpaper.html)
is a full-screen, full-strength version of it made for desktop wallpaper
hosts, so both platforms use that page and only need a thin native wrapper.

## The shared page: `web/wallpaper.html`

- Loads `web/aether-bg.js` on black, at full strength, without parallax, with
  a higher resolution budget than the page background (about 1.2 megapixels).
- `?aether=physarum` stays on one scene; `?level=0.8` sets brightness (0–1.5).
- A host pauses it by sending level 0 and resumes with any other level:

  ```js
  window.dispatchEvent(new CustomEvent('aether-level', { detail: 0 }))
  ```

  At 0 it fades out and stops drawing, so a paused wallpaper costs nothing.
- It caps itself at 30 fps, pauses when the page is hidden, and lowers its
  resolution if the GPU can't keep up.
- Five scenes: Nebula, Julia, Reaction, Physarum and Attractor. Reaction,
  Physarum and Attractor need `EXT_color_buffer_float`. Without it, the page
  shows only Nebula and Julia.

Tested so far only in headless Chromium on Linux (software WebGL). It has
not yet run in WebView2 or WKWebView.

## Try it now, no code

- **Windows:** install [Lively Wallpaper](https://www.rocksdanister.com/lively/)
  (free, open source). Add wallpaper → choose `web\wallpaper.html` from this
  repository.
- **macOS:** install [Plash](https://sindresorhus.com/plash) (free). Add a
  website with the file URL of `web/wallpaper.html`, for example
  `file:///Users/you/wallpaper/web/wallpaper.html`.

Both pause on their own when a fullscreen app is in front.

## Native wrapper: Windows

Brief for a Claude Code session on the Windows machine:

> In this repository (pull first), add a native Windows wallpaper host under
> `windows/` that shows `web/wallpaper.html` behind the desktop icons. Don't
> change the Linux code; changes to `web/aether-bg.js` are fine if they
> stay compatible with the page background on joshuaallentalbott.com.
>
> - C# / .NET 8 with WebView2 (WinForms or WPF), no installer framework.
>   Load the page from the repository folder via a virtual host mapping
>   (`SetVirtualHostNameToFolderMapping`) rather than `file://`.
> - Put the window behind the icons with the WorkerW technique: send `0x052C`
>   to `Progman`, then parent into the right `WorkerW`. Windows 11 24H2
>   changed this layering, so handle both the old and new layouts and
>   survive an Explorer restart (re-attach on `TaskbarCreated`).
> - Cover every monitor, one WebView per monitor, and follow monitor and DPI
>   changes.
> - Pause (send level 0) while a maximized or fullscreen window covers that
>   monitor, while the session is locked, and in battery saver; resume after.
> - A tray icon with a brightness slider, pause and resume, and "start at
>   login" (HKCU `Run` key). Save the brightness.
> - A `windows/README.md` and a "Windows" section in the main README with
>   build and install steps. Done means it runs behind the icons on Windows
>   11, pauses and resumes correctly, and starts at login.

## Native wrapper: macOS

Brief for a Claude Code session on the Mac:

> In this repository (pull first), add a native macOS wallpaper host under
> `macos/` that shows `web/wallpaper.html` as the desktop background. Don't
> change the Linux code; changes to `web/aether-bg.js` are fine if they
> stay compatible with the page background on joshuaallentalbott.com.
>
> - Swift, built with Swift Package Manager (`swift build`) plus a small
>   script that wraps the binary in an `.app` bundle; no Xcode project needed.
> - One borderless `NSWindow` per screen at the desktop window level
>   (`CGWindowLevelForKey(.desktopWindow)`), with collection behaviour
>   `.canJoinAllSpaces`, `.stationary` and `.ignoresCycle`, ignoring mouse
>   events, following screen changes. Each holds a `WKWebView` loading the
>   page with read access to `web/`.
> - Pause (send level 0) when the window is fully covered (watch
>   `NSWindow.occlusionState`), when the screen is locked or asleep, and in
>   Low Power Mode; resume after.
> - A menu bar item with a brightness slider, pause and resume, and "Open at
>   login" (`SMAppService.mainApp`). Save the brightness.
> - A `macos/README.md` and a "macOS" section in the main README with build
>   and install steps, including how to open an unsigned app the first time.
>   Done means it runs behind the desktop on every Space and screen, pauses
>   when covered, and opens at login.
