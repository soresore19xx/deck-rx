// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-08-18-195032
// Companion window app for deck-rx. Its only structural job is to exist as a
// focusable macOS app so a Stream Deck profile can be bound to it; it also
// mirrors the plugin's persisted state so the window is not empty.
// ====================

import AppKit

// MARK: - State sources
//
// The plugin owns no IPC endpoint yet, so state is read from two artefacts it
// already maintains:
//   * config.json  - persisted last frequency / demod mode / volume / host
//   * /tmp/deck-rx.pid - live plugin process id (written by src/index.ts)
// If a richer feed is added later it should land in statusPath; the fields
// found there win over config.json without any change here.

let configPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin/config.json")
    .path
let statusPath = "/tmp/deck-rx-status.json"
let pidPath = "/tmp/deck-rx.pid"

struct Snapshot {
    var freqHz: Double?
    var mode: Int?
    var volume: Double?
    var muted: Bool?
    var host: String?
    var port: Int?
    var source: String = "-"
    var pluginPid: pid_t?
}

func readJSON(_ path: String) -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func livePid() -> pid_t? {
    guard let raw = try? String(contentsOfFile: pidPath, encoding: .utf8),
          let pid = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    // kill(pid, 0) succeeds for a live process; EPERM means alive but not ours.
    if kill(pid, 0) == 0 || errno == EPERM { return pid }
    return nil
}

func snapshot() -> Snapshot {
    var s = Snapshot()
    s.pluginPid = livePid()

    if let cfg = readJSON(configPath) {
        s.source = "config.json"
        s.freqHz = cfg["lastFrequency"] as? Double
        s.mode = cfg["demodMode"] as? Int
        s.volume = cfg["volume"] as? Double
        s.muted = cfg["muted"] as? Bool
        s.host = cfg["host"] as? String
        s.port = cfg["port"] as? Int
    }
    // Optional live feed; overrides whatever config.json had.
    if let st = readJSON(statusPath) {
        s.source = "status.json"
        if let v = st["freqHz"] as? Double { s.freqHz = v }
        if let v = st["mode"] as? Int { s.mode = v }
        if let v = st["volume"] as? Double { s.volume = v }
        if let v = st["muted"] as? Bool { s.muted = v }
    }
    return s
}

// MARK: - Formatting

// Mode numbering follows spyService.ts: 0=NFM 1=WFM 2=AM 4=USB 5=CW 6=LSB.
func modeName(_ m: Int?) -> String {
    switch m {
    case 0: return "NFM"
    case 1: return "WFM"
    case 2: return "AM"
    case 4: return "USB"
    case 5: return "CW"
    case 6: return "LSB"
    default: return "--"
    }
}

func formatFreq(_ hz: Double?) -> String {
    guard let hz = hz, hz > 0 else { return "--- ---" }
    if hz < 30_000_000 {
        let khz = hz / 1000
        let text = String(format: "%.3f", khz)
        // Trim trailing zeros so 954.000 reads as 954.
        var trimmed = text
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return trimmed + " kHz"
    }
    return String(format: "%.3f MHz", hz / 1_000_000)
}

// MARK: - UI

final class StatusView: NSView {
    private let freqLabel = StatusView.label(size: 34, weight: .medium, color: .white)
    private let modeLabel = StatusView.label(size: 14, weight: .regular, color: NSColor(white: 0.72, alpha: 1))
    private let pluginLabel = StatusView.label(size: 12, weight: .regular, color: NSColor(white: 0.72, alpha: 1))
    private let serverLabel = StatusView.label(size: 12, weight: .regular, color: NSColor(white: 0.72, alpha: 1))
    private let sourceLabel = StatusView.label(size: 10, weight: .regular, color: NSColor(white: 0.42, alpha: 1))

    static func label(size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: "")
        f.font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
        f.textColor = color
        return f
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor

        let stack = NSStackView(views: [freqLabel, modeLabel, spacer(8), pluginLabel, serverLabel, spacer(4), sourceLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -22),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func spacer(_ h: CGFloat) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }

    func refresh() {
        let s = snapshot()
        freqLabel.stringValue = formatFreq(s.freqHz)

        var parts = [modeName(s.mode)]
        if let v = s.volume { parts.append("VOL \(Int((v * 100).rounded()))") }
        if s.muted == true { parts.append("MUTED") }
        modeLabel.stringValue = parts.joined(separator: "  ·  ")

        if let pid = s.pluginPid {
            pluginLabel.stringValue = "PLUGIN   running (pid \(pid))"
            pluginLabel.textColor = NSColor(red: 0.35, green: 0.85, blue: 0.45, alpha: 1)
        } else {
            pluginLabel.stringValue = "PLUGIN   not running"
            pluginLabel.textColor = NSColor(red: 0.95, green: 0.45, blue: 0.40, alpha: 1)
        }

        if let h = s.host {
            serverLabel.stringValue = "SERVER   \(h):\(s.port ?? 0)"
        } else {
            serverLabel.stringValue = "SERVER   (config unreadable)"
        }
        sourceLabel.stringValue = "source: \(s.source)"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var view: StatusView!
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        view = StatusView(frame: NSRect(x: 0, y: 0, width: 400, height: 230))
        window = NSWindow(contentRect: view.frame,
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered,
                          defer: false)
        window.title = "deck-rx"
        window.contentView = view
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        // Ask before naming the autosave: once the name is set the window has a
        // frame either way, so "was it ever saved?" can no longer be answered.
        let hasSavedFrame = UserDefaults.standard.string(forKey: "NSWindow Frame deckRxMain") != nil
        window.setFrameAutosaveName("deckRxMain")
        if !hasSavedFrame { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        view.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.view.refresh()
        }
    }

    // Closing the window must not quit: the app has to stay launchable from the
    // Dock so focusing it keeps driving the Stream Deck profile switch.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
