# Aether for macOS

A small native host that shows [`web/wallpaper.html`](../web/wallpaper.html)
as your desktop background, under the desktop icons and widgets, on every
screen and every Space. It's Swift with WKWebView, about 700 lines, built
with Swift Package Manager. You don't need an Xcode project.

## Requirements

- macOS 13 Ventura or newer (tested on macOS 26 on an M1 Pro)
- Swift 5.9 or newer: either Xcode or just the Command Line Tools
  (`xcode-select --install`)

## Install

From Terminal in the repository:

```bash
macos/build.sh --install --open-at-login
```

This builds `Aether.app`, copies it to `~/Applications`, opens it, and adds
it to your login items. Leave out `--open-at-login` to choose later from the
menu. Running it again updates the app in place (it quits the running copy
first).

Options:

| | |
|---|---|
| `--install` | copy the app to `~/Applications` and open it |
| `--open-at-login` | with `--install`: also open it at every login |
| `--dest <folder>` | install somewhere else, for example `/Applications` |
| `--no-start` | don't open it after installing |
| `--universal` | build for Apple silicon and Intel (needs Xcode) |
| `--uninstall` | quit it, remove the login item, delete the app |

Without `--install` it only builds `macos/build/Aether.app`.

### Opening an unsigned app the first time

The app is signed ad hoc, not with an Apple Developer ID. An app you built
yourself on your own Mac opens normally. If you copy `Aether.app` to another
Mac (AirDrop, a download, a zip), macOS blocks it the first time with
"Apple could not verify Aether is free of malware". To open it anyway:

1. Try to open it once and click **Done** (not Move to Trash).
2. Open **System Settings › Privacy & Security**, scroll down to the message
   about Aether and click **Open Anyway**, then confirm with your password.

On macOS 14 and older, Control-click the app in Finder, choose **Open**, then
**Open** again. Or remove the quarantine flag from Terminal:

```bash
xattr -dr com.apple.quarantine ~/Applications/Aether.app
```

After the first time it opens normally.

## Build and run from the repository

```bash
cd macos
swift run Aether --verbose
```

Run from inside the checkout (with `swift run` or as `macos/build/Aether.app`),
it loads the page from the repository's `web/` folder, so after editing
`web/aether-bg.js` choose **Reload** from its menu to see the change. An
installed copy uses the `web/` folder inside the app. Open at Login only
works from `Aether.app`, not from `swift run`.

## Using it

Aether lives in the menu bar (a small circle). Click it for:

- **Brightness** slider (5–150%), saved
- **Pause / Resume**, saved
- **Scene**: all ten in turn, or stay on one
- **Open at Login**: registers the app with `SMAppService.mainApp`; it also
  appears in System Settings › General › Login Items
- **Reload**, **Show Log**, **Quit Aether**

The icon dims while the wallpaper is paused. There's no Dock icon.

It pauses on its own (sending the page level 0, which fades it out and stops
drawing, so a paused wallpaper costs nothing) and resumes afterwards:

- on a screen where windows cover the whole desktop, per screen (a
  fullscreen app, or windows that together hide every pixel of it)
- while the screen is locked, asleep, or showing the screen saver, and while
  another user is logged in with fast user switching
- while Low Power Mode is on

On an M1 Pro it uses about 10% of one CPU core while drawing, and none while
covered or paused.

Settings are in `~/Library/Preferences/com.joshuaallentalbott.aether.plist`
(`defaults read com.joshuaallentalbott.aether`), the log in
`~/Library/Logs/Aether/aether.log`.

Command-line options for the binary (`~/Applications/Aether.app/Contents/MacOS/Aether`):

| | |
|---|---|
| `--quit` | close the running copy |
| `--open-at-login on` / `off` | change the login item and exit |
| `--verbose` | also print the log to the terminal |
| `--devtools` | let Safari's Web Inspector attach (Safari › Develop › your Mac › Aether) |
| `--scene <name>` | stay on one scene this time, without changing the saved choice (`silk`, `life`, ...) |
| `--snapshot [seconds]` | after 10 seconds (or the number given), save a picture of each screen's page next to the log |

## How it works

- **The desktop layer.** Each screen gets a borderless window at
  `CGWindowLevelForKey(.desktopWindow)`: above the system wallpaper, below
  Finder's desktop icons and the desktop widgets. It ignores the mouse, so
  clicks reach the desktop as usual. Its collection behaviour
  (`.canJoinAllSpaces`, `.stationary`, `.ignoresCycle`) puts it on every
  Space, keeps it still in Mission Control and out of ⌘` cycling.
- **Screens.** Windows are keyed by display ID. Plugging a screen in or out,
  or changing its resolution or arrangement
  (`didChangeScreenParametersNotification`), adds, moves and removes them.
- **The page** is loaded with `loadFileURL(_:allowingReadAccessTo:)`, with
  read access to `web/` only, and the brightness goes in as `?level=`.
  Pausing and brightness changes are sent live with the `aether-level` event.
  Navigation anywhere outside `web/` is refused. If the web content process
  dies, the page reloads.
- **Covered?** Each window watches its `occlusionState`. macOS takes care of
  the hard part: it reports the window as not visible when other windows hide
  all of it, when another Space's fullscreen app is showing, and when the
  screen is off. Changes are settled for 200 ms before acting on them.
- **Locked, asleep and Low Power Mode** come from `com.apple.screenIsLocked` /
  `screenIsUnlocked`, the screen saver's start and stop notifications,
  `NSWorkspace`'s sleep, wake and session notifications, and
  `ProcessInfo.isLowPowerModeEnabled`.
- **WebGL.** WKWebView gives the page WebGL 2 with `EXT_color_buffer_float`,
  so all ten scenes run. The log names the renderer the first time the page
  loads.

## Troubleshooting

- **Nothing shows.** Choose **Show Log** from the menu. It lists each screen,
  the WebGL the page got and, when it's paused, why.
- **It says "covered" but I can see the desktop.** Something on that screen
  is fully opaque and full size, for example a fullscreen app on another
  Space or an app that draws its own desktop. Look for its window in Mission
  Control.
- **Black screen instead of the animation.** Start it with `--devtools`, then
  in Safari enable Settings › Advanced › Show features for web developers and
  open Develop › (your Mac) › wallpaper.html to see the console.
- **Open at Login is shown with a dash.** macOS is waiting for you to allow it
  in System Settings › General › Login Items.
- **Uninstall:** `macos/build.sh --uninstall`. To also forget the settings:
  `defaults delete com.joshuaallentalbott.aether`.

## Files

```
Package.swift                  Swift package, macOS 13+
build.sh                       build Aether.app; install, open at login, uninstall
make-icon.sh                   app icon from a Nebula screenshot
Info.plist                     bundle info (menu bar app, no Dock icon)
Sources/Aether/main.swift      command-line options, one copy at a time
Sources/Aether/App.swift       the app: windows per screen, pause rules, menu bar item
Sources/Aether/WallpaperWindow.swift  one screen's desktop-level window and WKWebView
Sources/Aether/Settings.swift  saved settings, Open at Login, the log
```
