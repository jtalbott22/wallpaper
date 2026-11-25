import AppKit

let options = Options(CommandLine.arguments)
Log.echo = options.verbose

if options.quit {
    DistributedNotificationCenter.default().postNotificationName(AppDelegate.quitNotification, object: nil,
                                                                 userInfo: nil, deliverImmediately: true)
    exit(0)
}

if let on = options.login {
    do {
        try LoginItem.set(on)
        print("Open at Login: \(LoginItem.describe(LoginItem.status))")
        exit(0)
    } catch {
        FileHandle.standardError.write("Open at Login: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}

// one copy at a time
if let id = Bundle.main.bundleIdentifier,
   NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0 != .current }) {
    Log.write("already running, exiting")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
let delegate = AppDelegate(options: options)
app.delegate = delegate
app.run()
