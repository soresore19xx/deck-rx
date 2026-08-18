// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-08-18-195032
// Companion window app for deck-rx. Its structural job is to exist as a
// focusable macOS app so a Stream Deck profile can be bound to it; it also
// shows the receiver's live state (frequency, mode, S/N meters, link).
// ====================

import AppKit

// MARK: - Paths
//
// The plugin resolves the same two paths with the same rule, so both ends
// agree without configuration: a RAM-backed volume when present (no SSD wear
// at all), /tmp otherwise.

func resolveBaseDir() -> String {
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: "/Volumes/RAMDisk", isDirectory: &isDir), isDir.boolValue {
        return "/Volumes/RAMDisk"
    }
    return "/tmp"
}

let baseDir = resolveBaseDir()
let statusPath = baseDir + "/deck-rx-status.json"
let alivePath = baseDir + "/deck-rx-app.alive"
let configPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin/config.json")
    .path
let pidPath = "/tmp/deck-rx.pid"

// The plugin writes the status feed only while this flag stays fresh, so a
// closed companion app costs the plugin nothing.
func touchAliveFlag() {
    let fm = FileManager.default
    if fm.fileExists(atPath: alivePath) {
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: alivePath)
    } else {
        fm.createFile(atPath: alivePath, contents: Data())
    }
}

// MARK: - State

struct Snapshot {
    var freqHz: Double?
    var mode: Int?
    var volume: Double?
    var muted: Bool?
    var host: String?
    var port: Int?
    var connected: Bool?
    var enabled: Bool?
    var rssiDbfs: Double?
    var snrDb: Double?
    var live = false            // status feed is present and fresh
    var writes: Double = 0
    var bytesWritten: Double = 0
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

    // config.json is the always-available baseline: the plugin persists
    // frequency/mode within 500 ms and volume within 300 ms of a change.
    if let cfg = readJSON(configPath) {
        s.freqHz = cfg["lastFrequency"] as? Double
        s.mode = cfg["demodMode"] as? Int
        s.volume = cfg["volume"] as? Double
        s.muted = cfg["muted"] as? Bool
        s.host = cfg["host"] as? String
        s.port = cfg["port"] as? Int
    }

    // The live feed wins where it overlaps, and is the only source for the
    // meters and the link state.
    if let st = readJSON(statusPath), let ts = st["ts"] as? Double {
        // Older than 3 s means the plugin stopped feeding (exited, or it
        // decided nobody was reading); fall back to config.json values.
        if Date().timeIntervalSince1970 * 1000 - ts < 3000 {
            s.live = true
            if let v = st["freqHz"] as? Double { s.freqHz = v }
            if let v = st["mode"] as? Int { s.mode = v }
            if let v = st["volume"] as? Double { s.volume = v }
            if let v = st["muted"] as? Bool { s.muted = v }
            s.connected = st["connected"] as? Bool
            s.enabled = st["enabled"] as? Bool
            s.rssiDbfs = st["rssiDbfs"] as? Double
            s.snrDb = st["snrDb"] as? Double
            s.writes = st["writes"] as? Double ?? 0
            s.bytesWritten = st["bytesWritten"] as? Double ?? 0
        }
    }
    return s
}

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
        var text = String(format: "%.3f", hz / 1000)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text + " kHz"
    }
    return String(format: "%.3f MHz", hz / 1_000_000)
}

// MARK: - Views

final class BarView: NSView {
    var value: CGFloat = 0 { didSet { needsDisplay = true } }
    var tint: NSColor = NSColor(red: 0.35, green: 0.85, blue: 0.45, alpha: 1)

    override var intrinsicContentSize: NSSize { NSSize(width: 168, height: 8) }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds
        let radius = r.height / 2
        NSColor(white: 0.16, alpha: 1).setFill()
        NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
        guard value > 0 else { return }
        let w = max(r.height, r.width * min(1, value))
        tint.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: r.height),
                     xRadius: radius, yRadius: radius).fill()
    }
}

func makeLabel(_ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor) -> NSTextField {
    let f = NSTextField(labelWithString: "")
    f.font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
    f.textColor = color
    return f
}

final class StatusView: NSView {
    private let dim = NSColor(white: 0.72, alpha: 1)
    private let faint = NSColor(white: 0.42, alpha: 1)

    private let freqLabel = makeLabel(34, .medium, .white)
    private let modeLabel = makeLabel(14, .regular, NSColor(white: 0.72, alpha: 1))
    private let sBar = BarView()
    private let nBar = BarView()
    private let sNum = makeLabel(12, .regular, NSColor(white: 0.72, alpha: 1))
    private let nNum = makeLabel(12, .regular, NSColor(white: 0.72, alpha: 1))
    private let linkLabel = makeLabel(12, .regular, NSColor(white: 0.72, alpha: 1))
    private let pluginLabel = makeLabel(12, .regular, NSColor(white: 0.72, alpha: 1))
    private let feedLabel = makeLabel(10, .regular, NSColor(white: 0.42, alpha: 1))

    // Write-rate accounting, derived from the feed's own counters.
    private var prevWrites: Double?
    private var prevBytes: Double = 0
    private var prevAt = Date()
    private var wps: Double = 0
    private var bps: Double = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        nBar.tint = NSColor(red: 0.40, green: 0.70, blue: 0.95, alpha: 1)

        let stack = NSStackView(views: [
            freqLabel, modeLabel,
            spacer(10),
            meterRow("S", sBar, sNum),
            meterRow("N", nBar, nNum),
            spacer(10),
            linkLabel, pluginLabel,
            spacer(4),
            feedLabel,
        ])
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

    private func meterRow(_ name: String, _ bar: BarView, _ num: NSTextField) -> NSStackView {
        let tag = makeLabel(12, .regular, faint)
        tag.stringValue = name
        tag.widthAnchor.constraint(equalToConstant: 14).isActive = true
        num.alignment = .right
        num.widthAnchor.constraint(equalToConstant: 72).isActive = true
        let row = NSStackView(views: [tag, bar, num])
        row.orientation = .horizontal
        row.spacing = 8
        row.alignment = .centerY
        return row
    }

    func refresh() {
        let s = snapshot()
        freqLabel.stringValue = formatFreq(s.freqHz)

        var parts = [modeName(s.mode)]
        if let v = s.volume { parts.append("VOL \(Int((v * 100).rounded()))") }
        if s.muted == true { parts.append("MUTED") }
        modeLabel.stringValue = parts.joined(separator: "  ·  ")

        // Meter scaling mirrors spyDialTune.ts so the window and the LCD agree:
        // RSSI -100..-10 dBFS and SNR 0..60 dB map onto the full bar.
        if let rssi = s.rssiDbfs {
            sBar.value = CGFloat(max(0, min(100, (rssi + 100) * 100 / 90)) / 100)
            sNum.stringValue = rssi > -119 ? "\(Int(rssi.rounded())) dBFS" : "-"
        } else {
            sBar.value = 0
            sNum.stringValue = "-"
        }
        if let snr = s.snrDb {
            nBar.value = CGFloat(max(0, min(100, snr * 100 / 60)) / 100)
            nNum.stringValue = snr > 0.5 ? "\(Int(snr.rounded())) dB" : "-"
        } else {
            nBar.value = 0
            nNum.stringValue = "-"
        }

        let addr = s.host.map { "\($0):\(s.port ?? 0)" } ?? "(config unreadable)"
        if !s.live {
            linkLabel.stringValue = "LINK     no feed  ·  \(addr)"
            linkLabel.textColor = faint
        } else if s.connected == true && s.enabled == true {
            linkLabel.stringValue = "LINK     connected  ·  \(addr)"
            linkLabel.textColor = NSColor(red: 0.35, green: 0.85, blue: 0.45, alpha: 1)
        } else if s.enabled == false {
            linkLabel.stringValue = "LINK     master off  ·  \(addr)"
            linkLabel.textColor = NSColor(red: 0.95, green: 0.75, blue: 0.35, alpha: 1)
        } else {
            linkLabel.stringValue = "LINK     disconnected  ·  \(addr)"
            linkLabel.textColor = NSColor(red: 0.95, green: 0.45, blue: 0.40, alpha: 1)
        }

        if let pid = s.pluginPid {
            pluginLabel.stringValue = "PLUGIN   running (pid \(pid))"
            pluginLabel.textColor = dim
        } else {
            pluginLabel.stringValue = "PLUGIN   not running"
            pluginLabel.textColor = NSColor(red: 0.95, green: 0.45, blue: 0.40, alpha: 1)
        }

        updateFeedLine(s)
    }

    private func updateFeedLine(_ s: Snapshot) {
        guard s.live else {
            feedLabel.stringValue = "feed: none — showing config.json (writes: 0)"
            return
        }
        let now = Date()
        let dt = now.timeIntervalSince(prevAt)
        if let pw = prevWrites, dt >= 1.0 {
            // Exponential smoothing keeps the readout from twitching.
            wps = 0.5 * wps + 0.5 * ((s.writes - pw) / dt)
            bps = 0.5 * bps + 0.5 * ((s.bytesWritten - prevBytes) / dt)
            prevWrites = s.writes
            prevBytes = s.bytesWritten
            prevAt = now
        } else if prevWrites == nil {
            prevWrites = s.writes
            prevBytes = s.bytesWritten
            prevAt = now
        }
        let volume = baseDir == "/Volumes/RAMDisk" ? "RAMDisk (no SSD wear)" : baseDir
        feedLabel.stringValue = String(format: "feed: %@  ·  %.1f w/s  ·  %.0f B/s  ·  %.0f writes total",
                                       volume, wps, bps, s.writes)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var view: StatusView!
    private var refreshTimer: Timer?
    private var aliveTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        touchAliveFlag()

        view = StatusView(frame: NSRect(x: 0, y: 0, width: 420, height: 310))
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
        // 4 Hz: fast enough for the meters to look live, slow enough to stay
        // invisible in CPU terms.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.view.refresh()
        }
        aliveTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            touchAliveFlag()
        }
    }

    // Closing the window must not quit: the app has to stay launchable from the
    // Dock so focusing it keeps driving the Stream Deck profile switch.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Drop the flag so the plugin stops writing immediately rather than
        // waiting for it to go stale.
        try? FileManager.default.removeItem(atPath: alivePath)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
