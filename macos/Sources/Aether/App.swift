import AppKit
import ServiceManagement

struct Options {
    var devTools = false
    var snapshot: Double?
    var verbose = false
    var quit = false
    var login: Bool?
    var scene: String?

    init(_ args: [String]) {
        var i = 1
        while i < args.count {
            switch args[i] {
            case "--devtools": devTools = true
            case "--snapshot":
                if i + 1 < args.count, let s = Double(args[i + 1]) { snapshot = s; i += 1 } else { snapshot = 10 }
            case "--verbose", "-v": verbose = true
            case "--quit": quit = true
            case "--scene":
                if i + 1 < args.count { scene = args[i + 1].lowercased(); i += 1 }
            case "--open-at-login":
                if i + 1 < args.count, ["on", "off"].contains(args[i + 1]) { login = args[i + 1] == "on"; i += 1 }
                else { login = true }
            case "--help", "-h":
                print("""
                usage: Aether [--scene <name>] [--devtools] [--snapshot [seconds]] [--verbose]
                       Aether --quit                  close the running copy
                       Aether --open-at-login on|off  change the login item and exit
                """)
                exit(0)
            default: break   // ignore what macOS passes, like -NSDocumentRevisionsDebugMode
            }
            i += 1
        }
    }
}

/// The whole app: one wallpaper window per screen, the reasons to pause them,
/// and the menu bar item.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let scenes = [("nebula", "Nebula"), ("julia", "Julia"), ("reaction", "Reaction"), ("physarum", "Physarum"),
                         ("attractor", "Attractor"), ("silk", "Silk"), ("chaos", "Chaos"), ("galaxy", "Galaxy"),
                         ("ink", "Ink"), ("life", "Particle Life"), ("cymatics", "Cymatics"), ("turing", "Turing"),
                         ("soup", "Free Energy"), ("cosmos", "Cosmos"), ("liquid", "Liquid"), ("bulb", "Mandelbulb")]
    static let qualities = [("saver", "Battery Saver", "30 fps, lower resolution"),
                            ("balanced", "Balanced", "30 fps"),
                            ("high", "High", "60 fps, higher resolution, ray-marched shadows and the Mandelbulb"),
                            ("max", "Maximum", "60 fps, up to full display resolution")]
    static let quitNotification = Notification.Name(bundleID + ".quit")

    let options: Options
    let settings = Settings()
    let webFolder = AppDelegate.findWebFolder()
    var views: [CGDirectDisplayID: WallpaperWindow] = [:]
    var locked = false, asleep = false, screensaver = false, switchedOut = false, lowPower = false
    var lastState = ""
    var rebuildWork: DispatchWorkItem?, checkWork: DispatchWorkItem?

    var statusItem: NSStatusItem!
    let menu = NSMenu()
    let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    let brightLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let slider = NSSlider(value: 100, minValue: 5, maxValue: 150, target: nil, action: nil)
    var pauseItem: NSMenuItem!, loginItem: NSMenuItem!, sceneMenu = NSMenu(), qualityMenu = NSMenu()
    var rotationItem: NSMenuItem!, rotationMenu = NSMenu(), rotationReset: NSMenuItem!
    var mathItem: NSMenuItem!, mathAutoItem: NSMenuItem!

    init(options: Options) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        Log.write("Aether \(version) on macOS \(ProcessInfo.processInfo.operatingSystemVersionString), page folder \(webFolder.path)")
        if !FileManager.default.fileExists(atPath: webFolder.appendingPathComponent("wallpaper.html").path) {
            Log.write("wallpaper.html is missing from \(webFolder.path)")
        }
        buildMenu()
        watch()
        lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        locked = AppDelegate.screenIsLocked()
        if lowPower { Log.write("Low Power Mode on") }
        rebuild()
        if let after = options.snapshot {
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in self?.snapshot() }
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        for v in views.values { v.close() }
        views.removeAll()
        Log.write("quit")
    }

    // MARK: screens

    func scheduleRebuild(_ delay: Double) {
        rebuildWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.rebuild() }
        rebuildWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    func rebuild() {
        var seen = Set<CGDirectDisplayID>()
        for screen in NSScreen.screens {
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { continue }
            seen.insert(id)
            if let v = views[id] { v.place(on: screen); continue }
            let v = WallpaperWindow(screen: screen, displayID: id, folder: webFolder, devTools: options.devTools)
            v.onChange = { [weak self] in self?.scheduleCheck() }
            v.onScene = { [weak self] _ in self?.updateMenu() }
            views[id] = v
            let f = screen.frame
            Log.write("\(v.name): \(Int(f.width))x\(Int(f.height)) pt at \(Int(f.minX)),\(Int(f.minY)), scale \(screen.backingScaleFactor)")
            v.load(pageURL())
        }
        for (id, v) in views where !seen.contains(id) {
            Log.write("\(v.name): removed")
            v.close()
            views[id] = nil
        }
        evaluate()
    }

    func pageURL() -> URL {
        var c = URLComponents(url: webFolder.appendingPathComponent("wallpaper.html"), resolvingAgainstBaseURL: true)!
        var q = [URLQueryItem(name: "level", value: String(format: "%.2f", settings.brightness))]
        if let s = options.scene ?? settings.scene { q.append(URLQueryItem(name: "aether", value: s)) }
        q.append(URLQueryItem(name: "quality", value: settings.quality))
        if !settings.mathOnStart { q.append(URLQueryItem(name: "math", value: "0")) }
        let skipped = settings.skipped
        if !skipped.isEmpty { q.append(URLQueryItem(name: "skip", value: skipped.joined(separator: ","))) }
        c.queryItems = q
        return c.url!
    }

    static func findWebFolder() -> URL {
        // inside a checkout, use the repository's web/ so edits show up on Reload
        var dir = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        let fm = FileManager.default
        while let d = dir, d.path != "/" {
            if fm.fileExists(atPath: d.appendingPathComponent("web/wallpaper.html").path),
               fm.fileExists(atPath: d.appendingPathComponent("macos/Package.swift").path) {
                return d.appendingPathComponent("web", isDirectory: true)
            }
            dir = d.deletingLastPathComponent()
        }
        // the copy inside Aether.app
        // (resourceURL is relative to the bundle: make it absolute, or the query string drops the base)
        return (Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")).absoluteURL.appendingPathComponent("web", isDirectory: true)
    }

    func reload() {
        Log.write("reload")
        for v in views.values { v.close() }
        views.removeAll()
        rebuild()
    }

    func snapshot() {
        for v in views.values {
            v.snapshot(to: Log.folder.appendingPathComponent("snapshot-\(v.displayID).png"))
        }
    }

    // MARK: pausing

    func watch() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.scheduleRebuild(0.4)
        }
        nc.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            let on = ProcessInfo.processInfo.isLowPowerModeEnabled
            if on != self.lowPower { self.lowPower = on; Log.write(on ? "Low Power Mode on" : "Low Power Mode off"); self.evaluate() }
        }

        let ws = NSWorkspace.shared.notificationCenter
        func on(_ name: Notification.Name, _ body: @escaping (AppDelegate) -> Void) {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                body(self)
                self.evaluate()
            }
        }
        on(NSWorkspace.screensDidSleepNotification) { $0.asleep = true; Log.write("screens asleep") }
        on(NSWorkspace.screensDidWakeNotification) { $0.asleep = false; Log.write("screens awake") }
        on(NSWorkspace.willSleepNotification) { $0.asleep = true; Log.write("going to sleep") }
        on(NSWorkspace.didWakeNotification) { $0.asleep = false; Log.write("woke up"); $0.scheduleRebuild(1) }
        on(NSWorkspace.sessionDidResignActiveNotification) { $0.switchedOut = true; Log.write("switched to another user") }
        on(NSWorkspace.sessionDidBecomeActiveNotification) { $0.switchedOut = false; Log.write("switched back") }

        let dc = DistributedNotificationCenter.default()
        func onDistributed(_ name: String, _ body: @escaping (AppDelegate) -> Void) {
            dc.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                body(self)
                self.evaluate()
            }
        }
        onDistributed("com.apple.screenIsLocked") { $0.locked = true; Log.write("screen locked") }
        onDistributed("com.apple.screenIsUnlocked") { $0.locked = false; Log.write("screen unlocked") }
        onDistributed("com.apple.screensaver.didstart") { $0.screensaver = true; Log.write("screen saver started") }
        onDistributed("com.apple.screensaver.didstop") { $0.screensaver = false; Log.write("screen saver stopped") }
        dc.addObserver(forName: AppDelegate.quitNotification, object: nil, queue: .main) { _ in
            Log.write("asked to quit")
            NSApp.terminate(nil)
        }
    }

    static func screenIsLocked() -> Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    /// Occlusion changes come in bursts while windows move; settle for a moment first.
    func scheduleCheck() {
        checkWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.evaluate() }
        checkWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: w)
    }

    func reason() -> String? {
        if settings.paused { return "paused" }
        if locked { return "locked" }
        if switchedOut { return "another user" }
        if asleep { return "asleep" }
        if screensaver { return "screen saver" }
        if lowPower { return "Low Power Mode" }
        return nil
    }

    /// Send each screen its level: the brightness, or 0 if it should be paused.
    func evaluate() {
        let all = reason()
        var covered: [String] = []
        for v in views.values.sorted(by: { $0.displayID < $1.displayID }) {
            let hidden = !v.visible
            if hidden { covered.append(v.name) }
            v.setLevel(all != nil || hidden ? 0 : settings.brightness)
        }
        let state = all ?? (covered.isEmpty ? "running" : "covered: " + covered.joined(separator: ", "))
        if state != lastState { Log.write("state " + state); lastState = state }
        updateMenu()
    }

    // MARK: menu

    func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = AppDelegate.icon()
        statusItem.button?.toolTip = "Aether"
        statusItem.menu = menu
        menu.delegate = self
        menu.autoenablesItems = false

        statusLine.isEnabled = false
        brightLine.isEnabled = false
        slider.target = self
        slider.action = #selector(sliderMoved)
        slider.isContinuous = true
        slider.doubleValue = settings.brightness * 100
        slider.frame = NSRect(x: 18, y: 2, width: 200, height: 24)
        let sliderView = NSView(frame: NSRect(x: 0, y: 0, width: 236, height: 28))
        sliderView.addSubview(slider)
        let sliderItem = NSMenuItem()
        sliderItem.view = sliderView

        pauseItem = NSMenuItem(title: "Pause", action: #selector(togglePause), keyEquivalent: "")
        loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        let sceneItem = NSMenuItem(title: "Scene", action: nil, keyEquivalent: "")
        sceneItem.submenu = sceneMenu
        sceneMenu.autoenablesItems = false
        sceneMenu.addItem(sceneEntry(nil, "All Scenes, in Turn"))
        sceneMenu.addItem(.separator())
        for (key, title) in AppDelegate.scenes { sceneMenu.addItem(sceneEntry(key, title)) }
        // a check mark per scene: unchecked ones are left out of the rotation
        rotationItem = NSMenuItem(title: "Scenes in Rotation", action: nil, keyEquivalent: "")
        rotationItem.submenu = rotationMenu
        rotationMenu.autoenablesItems = false
        for (key, title) in AppDelegate.scenes {
            let item = NSMenuItem(title: title, action: #selector(toggleRotation(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            rotationMenu.addItem(item)
        }
        rotationMenu.addItem(.separator())
        rotationReset = NSMenuItem(title: "Put All Back", action: #selector(resetRotation), keyEquivalent: "")
        rotationReset.target = self
        rotationMenu.addItem(rotationReset)
        let qualityItem = NSMenuItem(title: "Quality", action: nil, keyEquivalent: "")
        qualityItem.submenu = qualityMenu
        qualityMenu.autoenablesItems = false
        for (key, title, note) in AppDelegate.qualities {
            let item = NSMenuItem(title: title, action: #selector(pickQuality(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = key
            item.toolTip = note
            qualityMenu.addItem(item)
        }
        qualityMenu.addItem(.separator())
        let qnote = NSMenuItem(title: "Resolution adapts per scene to keep motion smooth", action: nil, keyEquivalent: "")
        qnote.isEnabled = false
        qualityMenu.addItem(qnote)
        mathItem = NSMenuItem(title: "Show the Math (?)", action: #selector(showMath), keyEquivalent: "/")
        mathItem.keyEquivalentModifierMask = [.command, .shift]
        mathAutoItem = NSMenuItem(title: "Show the Math When a Scene Starts", action: #selector(toggleMathAuto), keyEquivalent: "")

        for item in [statusLine, .separator(), brightLine, sliderItem, .separator(),
                     pauseItem!, sceneItem, rotationItem!, qualityItem, .separator(),
                     mathItem!, mathAutoItem!, .separator(), loginItem!, .separator(),
                     NSMenuItem(title: "Reload", action: #selector(reloadClicked), keyEquivalent: "r"),
                     NSMenuItem(title: "Show Log", action: #selector(showLog), keyEquivalent: ""),
                     .separator(),
                     NSMenuItem(title: "Quit Aether", action: #selector(quitClicked), keyEquivalent: "q")] {
            if item.action != nil { item.target = self }
            menu.addItem(item)
        }
        updateMenu()
    }

    func sceneEntry(_ scene: String?, _ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(pickScene(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = scene
        return item
    }

    func menuWillOpen(_ menu: NSMenu) {
        updateMenu()
    }

    func updateMenu() {
        guard statusItem != nil else { return }
        let all = reason()
        let n = views.count, c = views.values.filter { !$0.visible }.count
        let status: String
        if n == 0 { status = "Starting…" }
        else if let all { status = "Paused (\(all))" }
        else if c == n { status = n == 1 ? "Paused (covered)" : "Paused (covered on every display)" }
        else if c > 0 { status = "Running on \(n - c) of \(n) displays" }
        else { status = n == 1 ? "Running" : "Running on \(n) displays" }
        let showing = views.values.sorted(by: { $0.displayID < $1.displayID }).compactMap { $0.sceneName }
        statusLine.title = all == nil && c < n && !showing.isEmpty ? status + " · " + showing.joined(separator: ", ") : status
        for item in qualityMenu.items where item.action != nil {
            item.state = (item.representedObject as? String) == settings.quality ? .on : .off
        }
        mathAutoItem.state = settings.mathOnStart ? .on : .off
        pauseItem.title = settings.paused ? "Resume" : "Pause"
        brightLine.title = "Brightness  \(Int((settings.brightness * 100).rounded()))%"
        for item in sceneMenu.items where item.action != nil {
            item.state = (item.representedObject as? String) == settings.scene ? .on : .off
        }
        let skipped = settings.skipped
        for item in rotationMenu.items where item.action == #selector(toggleRotation(_:)) {
            item.state = skipped.contains(item.representedObject as? String ?? "") ? .off : .on
        }
        let total = AppDelegate.scenes.count
        rotationItem.title = skipped.isEmpty ? "Scenes in Rotation: All" : "Scenes in Rotation: \(total - skipped.count) of \(total)"
        rotationReset.isEnabled = !skipped.isEmpty
        if LoginItem.available {
            let s = LoginItem.status
            loginItem.isEnabled = true
            loginItem.state = s == .enabled ? .on : s == .requiresApproval ? .mixed : .off
            loginItem.toolTip = s == .requiresApproval ? "Allow Aether in System Settings › General › Login Items" : nil
        } else {
            loginItem.isEnabled = false
            loginItem.toolTip = "Only from Aether.app (run macos/build.sh)"
        }
        statusItem.button?.appearsDisabled = all != nil || (n > 0 && c == n)
        statusItem.button?.toolTip = "Aether: " + status
    }

    /// A small orb, drawn as a template so it follows the menu bar's colour.
    static func icon() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
            let orb = NSBezierPath(ovalIn: r.insetBy(dx: 2.5, dy: 2.5))
            NSColor.black.setStroke()
            orb.lineWidth = 1.4
            orb.stroke()
            let core = NSBezierPath(ovalIn: NSRect(x: 5.5, y: 8, width: 5, height: 5))
            NSColor.black.setFill()
            core.fill()
            let swirl = NSBezierPath()
            swirl.move(to: NSPoint(x: 4.5, y: 7))
            swirl.curve(to: NSPoint(x: 13.5, y: 9), controlPoint1: NSPoint(x: 7, y: 3.5), controlPoint2: NSPoint(x: 12, y: 5))
            swirl.lineWidth = 1.2
            swirl.stroke()
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = "Aether"
        return img
    }

    @objc func sliderMoved() {
        let v = (slider.doubleValue / 5).rounded() * 5 / 100
        guard abs(v - settings.brightness) > 1e-6 else { return }
        settings.brightness = v
        evaluate()
    }

    @objc func togglePause() {
        settings.paused.toggle()
        Log.write(settings.paused ? "paused from the menu" : "resumed from the menu")
        evaluate()
    }

    @objc func pickQuality(_ sender: NSMenuItem) {
        guard let q = sender.representedObject as? String, q != settings.quality else { return }
        settings.quality = q
        Log.write("quality: \(q)")
        let url = pageURL()
        for v in views.values { v.load(url) }
        updateMenu()
    }

    @objc func showMath() {
        for v in views.values { v.send("aether-show-math") }
    }

    @objc func toggleMathAuto() {
        settings.mathOnStart.toggle()
        for v in views.values { v.send("aether-math-auto", settings.mathOnStart ? "true" : "false") }
        updateMenu()
    }

    @objc func toggleRotation(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        var skipped = settings.skipped
        if let i = skipped.firstIndex(of: key) { skipped.remove(at: i) } else { skipped.append(key) }
        settings.skipped = skipped
        Log.write("left out of the rotation: \(skipped.isEmpty ? "none" : skipped.joined(separator: ", "))")
        sendSkipped()
        updateMenu()
    }

    @objc func resetRotation() {
        settings.skipped = []
        Log.write("every scene back in the rotation")
        sendSkipped()
        updateMenu()
    }

    /// Tells the open pages (no reload); new pages get it from the URL.
    func sendSkipped() {
        let json = "[" + settings.skipped.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        for v in views.values { v.send("aether-skip", json) }
    }

    @objc func pickScene(_ sender: NSMenuItem) {
        settings.scene = sender.representedObject as? String
        Log.write("scene: \(settings.scene ?? "all")")
        let url = pageURL()
        for v in views.values { v.load(url) }
        updateMenu()
    }

    @objc func toggleLogin() {
        do {
            try LoginItem.set(!(LoginItem.status == .enabled || LoginItem.status == .requiresApproval))
            if LoginItem.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch {
            Log.write("open at login: \(error.localizedDescription)")
            let alert = NSAlert()
            alert.messageText = "Aether couldn't change Open at Login"
            alert.informativeText = error.localizedDescription + "\n\nYou can add Aether yourself in System Settings › General › Login Items."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
        updateMenu()
    }

    @objc func reloadClicked() { reload() }

    @objc func showLog() {
        Log.write("log opened")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            if FileManager.default.fileExists(atPath: Log.file.path) {
                NSWorkspace.shared.activateFileViewerSelecting([Log.file])
            } else {
                NSWorkspace.shared.open(Log.folder)
            }
        }
    }

    @objc func quitClicked() { NSApp.terminate(nil) }
}
