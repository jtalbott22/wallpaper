# Aether: notes for Claude sessions

This repository is worked on from several machines (Linux laptop, Mac,
Windows PC, and iPhone testing through Safari). Read this before deciding
whether a change applies to another platform.

## One engine, every platform

`web/aether-bg.js` is the engine almost everywhere. A fix there reaches
all of these at once:

| Where | What runs it |
|---|---|
| Linux desktop (default) | `aether/webhost.py`: GTK 4 + WebKitGTK 6.0 (GTK 3 + 4.1 fallback) showing `web/wallpaper.html`; the GNOME extension in `gnome-extension/` puts it behind the desktop |
| macOS | `macos/`: WKWebView showing `web/wallpaper.html` |
| Windows | `windows/`: WebView2 showing `web/wallpaper.html` |
| Browsers, phones, iPhone Safari | `web/aether.html` (interactive) and the background on joshuaallentalbott.com |

So engine fixes made while testing on an iPhone or a Mac **do** apply to
Linux: it is the same file in WebKit.

The only separate engines are the Linux **native** renderer `aether/`
(Python, OpenGL 4.3 compute shaders, the original ten scenes) and the old
CPU renderer `mirage/`. They are fallbacks the user can choose from the
Linux top bar menu (Renderer); they don't share code with the web engine.

## Hosts talk to the page the same way

URL parameters on `wallpaper.html`: `level`, `aether` (one scene), `quality`
(`saver|balanced|high|max`), `math=0`, `skip=key,key` (left out of the
rotation), `fps` (cap). Live changes are window events: `aether-level`,
`aether-skip`, `aether-show-math`, `aether-math-auto`, `aether-fps`. The page
reports back with `aether-scene` and `aether-quality`, both as DOM events and
to `window.webkit.messageHandlers.aether` (WebKitGTK, WKWebView) or
`window.chrome.webview` (WebView2). `window.Aether` is the scripting API
`aether.html` uses. Keep these compatible: every host depends on them.

When adding a menu feature to one host, the others usually want it too:
the Linux menu lives in `gnome-extension/extension.js` (settings in
`~/.config/aether/wallpaper.json`, re-read by the renderer on SIGHUP),
macOS in `macos/Sources/Aether/App.swift`, Windows in
`windows/src/HostContext.cs`.

## Testing

- Linux: `python3 -m aether.webhost --debug` runs the web host in a window
  and logs the frame rate. Extension changes need a log out and back in on
  Wayland; `./install-wallpaper.sh` installs them.
- Headless Chromium with SwiftShader is too slow for the heaviest scenes
  (Turing, Cosmos, Liquid, Mandelbulb); test those on real GPUs.
- The site (joshuaallentalbott.com) serves `aether-bg.js` and `aether.html`
  copied from `web/`; the home page background must keep working with
  defaults (five calm scenes, no quality preset).
