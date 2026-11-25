import AppKit
import WebKit

/// A borderless window that may cover the whole screen, menu bar area included,
/// and never takes focus.
private final class DesktopWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// One screen's wallpaper: a window at the desktop level holding a WKWebView
/// that shows web/wallpaper.html.
final class WallpaperWindow: NSObject, WKNavigationDelegate, WKUIDelegate {
    let displayID: CGDirectDisplayID
    private(set) var name: String
    private let window: NSWindow
    private let webView: WKWebView
    private let folder: URL
    private var ready = false, probed = false, closed = false
    private var want = -1.0, sent = -1.0
    private var url: URL?
    private var loads = 0

    /// Called when the window's visibility changes or the page becomes ready.
    var onChange: (() -> Void)?

    init(screen: NSScreen, displayID: CGDirectDisplayID, folder: URL, devTools: Bool) {
        self.displayID = displayID
        self.folder = folder.absoluteURL.standardizedFileURL
        name = screen.localizedName

        window = DesktopWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "Aether"
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.isOpaque = true
        window.backgroundColor = .black
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.isExcludedFromWindowsMenu = true

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.suppressesIncrementalRendering = true
        webView = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        if #available(macOS 13.3, *) { webView.isInspectable = devTools }
        webView.isHidden = true   // black window until the page has loaded, never a white flash

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        window.contentView?.addSubview(webView)
        window.setFrame(screen.frame, display: false)

        NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged),
                                               name: NSWindow.didChangeOcclusionStateNotification, object: window)
        window.orderFront(nil)
    }

    /// Visible somewhere on screen. Fully covered windows, other Spaces' fullscreen
    /// apps, a locked or sleeping screen all count as not visible.
    var visible: Bool { window.occlusionState.contains(.visible) }

    var windowNumber: Int { window.windowNumber }

    func load(_ url: URL) {
        self.url = url
        ready = false
        sent = -1
        loads += 1
        // if the page never finishes loading (WebKit doesn't always say why), try again
        let attempt = loads
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, !self.closed, !self.ready, self.loads == attempt else { return }
            Log.write("\(self.name): page hasn't loaded after 15 s, trying again")
            self.reload()
        }
        webView.loadFileURL(url, allowingReadAccessTo: folder)
    }

    func reload() {
        if let url { load(url) }
    }

    /// Follow the screen to a new position, size or name.
    func place(on screen: NSScreen) {
        name = screen.localizedName
        if window.frame != screen.frame {
            window.setFrame(screen.frame, display: true)
            Log.write("\(name): \(Int(screen.frame.width))x\(Int(screen.frame.height)) pt at \(Int(screen.frame.minX)),\(Int(screen.frame.minY))")
        }
        window.orderFront(nil)
    }

    /// The page's level: 0 pauses (it fades out and stops drawing), anything else is the brightness.
    func setLevel(_ level: Double) {
        want = level
        push()
    }

    private func push() {
        guard ready, want >= 0, abs(want - sent) > 1e-6 else { return }
        sent = want
        let v = String(format: "%.3f", want)
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('aether-level', { detail: \(v) }))") { [weak self] _, error in
            if let error, let self { Log.write("\(self.name): level failed: \(error.localizedDescription)"); self.sent = -1 }
        }
    }

    /// Saves a picture of the page next to the log (for --snapshot and troubleshooting).
    func snapshot(to file: URL) {
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            guard let self else { return }
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                Log.write("\(self.name): snapshot failed: \(error?.localizedDescription ?? "no image")")
                return
            }
            do { try png.write(to: file); Log.write("\(self.name): snapshot saved to \(file.path)") }
            catch { Log.write("\(self.name): snapshot failed: \(error.localizedDescription)") }
        }
    }

    @objc private func occlusionChanged() {
        onChange?()
    }

    func close() {
        closed = true
        NotificationCenter.default.removeObserver(self)
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        window.orderOut(nil)
        window.close()
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // only the page and its files; nothing else, ever
        guard let u = action.request.url else { decisionHandler(.cancel); return }
        let root = folder.resolvingSymlinksInPath().path + "/"
        let inside = u.isFileURL && u.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(root)
        if !inside { Log.write("\(name): refused to open \(u.isFileURL ? u.path : u.absoluteString)") }
        decisionHandler(inside ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !closed else { return }
        ready = true
        webView.isHidden = false
        push()
        onChange?()
        if !probed { probed = true; probe() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Log.write("\(name): page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Log.write("\(name): page failed to load: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !closed else { return }
        Log.write("\(name): web content process ended, reloading")
        ready = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, !self.closed else { return }
            self.reload()
        }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    /// Log what WebGL the page gets, once: without float render targets it shows only Nebula and Julia.
    private func probe() {
        let js = """
        (function () {
          var c = document.createElement('canvas'), g = c.getContext('webgl2');
          if (!g) return 'no WebGL2: the page cannot draw';
          var f = !!g.getExtension('EXT_color_buffer_float');
          var r = g.getParameter(g.RENDERER);
          var lose = g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
          return 'WebGL2 (' + r + '), float render targets: ' + (f ? 'yes, all ten scenes' : 'no, Nebula and Julia only');
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, error in
            guard let self else { return }
            Log.write("\(self.name): \(result as? String ?? "WebGL check failed: \(error?.localizedDescription ?? "?")")")
        }
    }
}
