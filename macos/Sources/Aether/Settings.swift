import Foundation
import ServiceManagement

let bundleID = "com.joshuaallentalbott.aether"

/// Saved in the app's user defaults (`defaults read com.joshuaallentalbott.aether`).
final class Settings {
    private let defaults: UserDefaults

    init() {
        // the same settings whether it runs as Aether.app or straight from `swift run`
        defaults = Bundle.main.bundleIdentifier == bundleID ? .standard : (UserDefaults(suiteName: bundleID) ?? .standard)
    }

    /// 0.05–1.5, as the page's level.
    var brightness: Double {
        get {
            let v = defaults.object(forKey: "brightness") as? Double ?? 1
            return v.isFinite ? min(1.5, max(0.05, v)) : 1
        }
        set { defaults.set(min(1.5, max(0.05, newValue)), forKey: "brightness") }
    }

    /// Paused from the menu.
    var paused: Bool {
        get { defaults.bool(forKey: "paused") }
        set { defaults.set(newValue, forKey: "paused") }
    }

    /// saver, balanced, high or max: the page adapts resolution per scene within it.
    var quality: String {
        get { defaults.string(forKey: "quality").flatMap { ["saver", "balanced", "high", "max"].contains($0) ? $0 : nil } ?? "balanced" }
        set { defaults.set(newValue, forKey: "quality") }
    }

    /// Show a scene's math when it starts.
    var mathOnStart: Bool {
        get { defaults.object(forKey: "mathOnStart") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "mathOnStart") }
    }

    /// nil: all scenes in turn.
    var scene: String? {
        get { defaults.string(forKey: "scene") }
        set { defaults.set(newValue, forKey: "scene") }
    }
}

/// "Open at Login", through `SMAppService.mainApp`. Only works from inside Aether.app.
enum LoginItem {
    static var available: Bool { Bundle.main.bundleIdentifier == bundleID }

    static var status: SMAppService.Status { SMAppService.mainApp.status }

    static var enabled: Bool { available && status == .enabled }

    static func set(_ on: Bool) throws {
        guard available else { throw NSError(domain: "Aether", code: 1, userInfo: [NSLocalizedDescriptionKey: "Open at Login needs Aether.app (run macos/build.sh)"]) }
        if on {
            if status != .enabled { try SMAppService.mainApp.register() }
        } else if status == .enabled || status == .requiresApproval {
            try SMAppService.mainApp.unregister()
        }
        Log.write("open at login: \(describe(status))")
    }

    static func describe(_ s: SMAppService.Status) -> String {
        switch s {
        case .enabled: return "on"
        case .notRegistered: return "off"
        case .requiresApproval: return "waiting for approval in System Settings › General › Login Items"
        case .notFound: return "not found"
        @unknown default: return "unknown (\(s.rawValue))"
        }
    }
}

/// A small rolling log in ~/Library/Logs/Aether/aether.log.
enum Log {
    static let folder = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Aether", isDirectory: true)
    static let file = folder.appendingPathComponent("aether.log")
    static var echo = false
    private static let queue = DispatchQueue(label: "aether.log")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    static func write(_ line: String) {
        let text = "\(stamp.string(from: Date()))  \(line)\n"
        if echo { FileHandle.standardError.write(text.data(using: .utf8)!) }
        queue.async {
            let fm = FileManager.default
            try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: file.path))?[.size] as? Int, size > 512 * 1024 {
                let old = file.appendingPathExtension("old")
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: file, to: old)
            }
            if let h = try? FileHandle(forWritingTo: file) {
                h.seekToEndOfFile()
                h.write(text.data(using: .utf8)!)
                try? h.close()
            } else {
                try? text.data(using: .utf8)!.write(to: file)
            }
        }
    }
}
