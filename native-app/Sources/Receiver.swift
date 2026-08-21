import Foundation

/// Everything this app knows about the receiver, and the only ways it changes it.
///
/// Reads come from the plugin's status feed (a small JSON file refreshed 4×/s)
/// and writes go to its control endpoint on 127.0.0.1:8771 — the same two
/// channels the Stream Deck plugin and the BRIMFORD knob already use. This app
/// owns no receiver state of its own: every control call is fire-and-forget and
/// the next status read is the truth.
enum Receiver {
    // MARK: paths

    static let baseDir: String = {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: "/Volumes/RAMDisk", isDirectory: &isDir), isDir.boolValue {
            return "/Volumes/RAMDisk"
        }
        return "/tmp"
    }()
    static let statusPath = ProcessInfo.processInfo.environment["DECK_RX_STATUS_PATH"]
        ?? (baseDir + "/deck-rx-status.json")
    /// The plugin writes the feed only while this flag stays fresh, so a closed
    /// app costs it nothing.
    static let alivePath = baseDir + "/deck-rx-app.alive"
    static let pluginDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin")
    static let presetsPath = pluginDir.appendingPathComponent("data/presets.json").path
    static let controlPort = Int(ProcessInfo.processInfo.environment["DECK_RX_CONTROL_PORT"] ?? "") ?? 8771

    static func touchAlive() {
        let fm = FileManager.default
        if fm.fileExists(atPath: alivePath) {
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: alivePath)
        } else {
            fm.createFile(atPath: alivePath, contents: Data())
        }
    }

    // MARK: status

    struct Status {
        var connected = false
        var enabled = false
        var freqHz: Double = 0
        var mode: Int = 1
        var volume: Double = 0
        var muted = false
        var rssiDbfs: Double = -120
        var snrDb: Double = 0
        var station = ""
        var bandwidthHz: Double = 0
        var tuneStepHz: Double = 0
        var stereo = false
        var device = ""
        var iqRateHz: Double = 0
        var decStage = 0
        var audioDrops = 0
        var audioDevice = ""
        var host = ""
        var port = 0
        var fresh = false      // feed updated recently — otherwise nothing is live
    }

    static func status() -> Status {
        var s = Status()
        guard let data = FileManager.default.contents(atPath: statusPath),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return s }
        s.connected = j["connected"] as? Bool ?? false
        s.enabled   = j["enabled"] as? Bool ?? false
        s.freqHz    = j["freqHz"] as? Double ?? 0
        s.mode      = j["mode"] as? Int ?? 1
        s.volume    = j["volume"] as? Double ?? 0
        s.muted     = j["muted"] as? Bool ?? false
        s.rssiDbfs  = j["rssiDbfs"] as? Double ?? -120
        s.snrDb     = j["snrDb"] as? Double ?? 0
        s.station   = j["station"] as? String ?? ""
        s.bandwidthHz = j["bandwidthHz"] as? Double ?? 0
        s.tuneStepHz  = j["tuneStepHz"] as? Double ?? 0
        s.stereo      = j["stereo"] as? Bool ?? false
        s.device      = j["device"] as? String ?? ""
        s.iqRateHz    = j["iqRateHz"] as? Double ?? 0
        s.decStage    = j["decStage"] as? Int ?? 0
        s.audioDrops  = j["audioDrops"] as? Int ?? 0
        s.audioDevice = j["audioDevice"] as? String ?? ""
        s.host      = j["host"] as? String ?? ""
        s.port      = j["port"] as? Int ?? 0
        if let ts = j["ts"] as? Double {
            s.fresh = Date().timeIntervalSince1970 * 1000 - ts < 2000
        }
        return s
    }

    // MARK: presets

    struct Preset { let name: String; let freq: Double; let mode: Int }

    /// The deck-rx-owned store the plugin maintains (data/presets.json), read
    /// directly. Never written from here — the plugin owns that file.
    static func presets() -> [Preset] {
        guard let data = FileManager.default.contents(atPath: presetsPath),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let lists = root["lists"] as? [String: Any] else { return [] }
        var out: [Preset] = []
        for (_, listAny) in lists {
            guard let list = listAny as? [String: Any],
                  let marks = list["bookmarks"] as? [String: Any] else { continue }
            for (name, bAny) in marks {
                guard let b = bAny as? [String: Any],
                      let f = b["frequency"] as? Double else { continue }
                out.append(Preset(name: name, freq: f, mode: b["mode"] as? Int ?? 1))
            }
        }
        return out.sorted { $0.freq < $1.freq }
    }

    // MARK: control

    /// Fire-and-forget GET on the control endpoint. Failures are logged, never
    /// surfaced as an alert: the receiver may simply not be running, and a
    /// modal per click would make the app unusable in that state.
    private static func call(_ path: String) {
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)\(path)") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { _, resp, err in
            if let err { NSLog("[control] \(path): \(err.localizedDescription)"); return }
            if let http = resp as? HTTPURLResponse, http.statusCode >= 300 {
                NSLog("[control] \(path): HTTP \(http.statusCode)")
            }
        }.resume()
    }

    static func tune(ticks: Int)   { call("/tune?ticks=\(ticks)") }
    static func tune(hz: Int)      { call("/tune?hz=\(hz)") }
    static func volume(delta: Int) { call("/volume?d=\(delta)") }
    /// Absolute 0..1 — what a click on the volume bar means.
    static func volume(level: Double) { call(String(format: "/volume?v=%.3f", max(0, min(1, level)))) }
    static func toggleMute()       { call("/mute?toggle=1") }
    static func togglePower()      { call("/power?toggle=1") }
    static func preset(step: Int)  { call("/preset?d=\(step > 0 ? 1 : -1)") }
    /// Demod mode by index (see MODE_NAMES). A preset's mode travels with it.
    static func mode(_ m: Int)     { call("/mode?m=\(m)") }

    /// The demod's own settings, as the receiver reports them. Read on a timer
    /// and after every change, so a value altered from the deck shows up here
    /// rather than this app keeping a private idea of the receiver's state.
    static func options(set name: String? = nil, value: String? = nil,
                        then: @escaping ([String: Any]) -> Void) {
        var query = ""
        if let name, let value,
           let n = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let v = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            query = "?set=\(n)&value=\(v)"
        }
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/options\(query)") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async { then(j) }
        }.resume()
    }

    /// Broadcaster names for the spectrum's labels, resolved by the receiver
    /// through the same JP DB lookup that names the station above the
    /// frequency readout — a preset's own text is the user's bookmark wording
    /// ("MW TBS"), not what the station is called.
    static func stations(then: @escaping ([(freq: Double, name: String)]) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/stations") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            let out: [(freq: Double, name: String)] = arr.compactMap {
                guard let f = $0["freq"] as? Double, let n = $0["name"] as? String else { return nil }
                return (freq: f, name: n)
            }
            DispatchQueue.main.async { then(out) }
        }.resume()
    }

    /// The VFO step. Japanese medium wave is spaced 9 kHz, so a receiver left
    /// on a 10 kHz step cannot land on 954 kHz at all — the app has to be able
    /// to change this, not just inherit whatever the deck last selected.
    static func step(hz: Int? = nil, cycle: Int? = nil,
                     then: ((Int, [Int]) -> Void)? = nil) {
        var query = ""
        if let hz { query = "?hz=\(hz)" } else if let cycle { query = "?d=\(cycle > 0 ? 1 : -1)" }
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/step\(query)") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let step = j["stepHz"] as? Int else { return }
            let values = j["values"] as? [Int] ?? []
            DispatchQueue.main.async { then?(step, values) }
        }.resume()
    }

    /// Spectrum display settings live on the receiver, not in this app: the
    /// FFT runs there, and the deck's own FFT dial shares the pipeline. The
    /// endpoint reports the values actually in force, clamped, so the UI can
    /// render from the answer rather than assume its request was taken.
    static func spectrum(fft: Int? = nil, fps: Int? = nil, smooth: Int? = nil,
                         then: ((Int, Int, Int) -> Void)? = nil) {
        var parts: [String] = []
        if let fft { parts.append("fft=\(fft)") }
        if let fps { parts.append("fps=\(fps)") }
        if let smooth { parts.append("smooth=\(smooth)") }
        let query = parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/spectrum\(query)") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let size = j["fftSize"] as? Int, let rate = j["fps"] as? Int,
                  let sm = j["smoothSpeed"] as? Int else { return }
            DispatchQueue.main.async { then?(size, rate, sm) }
        }.resume()
    }
}

let MODE_NAMES = ["NFM", "WFM", "AM", "DSB", "USB", "CW", "LSB", "RAW"]

func modeName(_ m: Int) -> String { m >= 0 && m < MODE_NAMES.count ? MODE_NAMES[m] : "—" }

/// Same thresholds as the plugin's own readout (src/dialDisplay.ts freqParts),
/// so a frequency reads identically on the deck, in the companion app and here:
/// MHz above 30 MHz, whole kHz on shortwave and medium wave, one decimal below
/// 1 MHz. Inventing a different rule here is how "1.242 MHz" ends up facing a
/// user who thinks in "1242 kHz".
/// Short human form for a step or bandwidth: 10 Hz, 9 kHz, 1 MHz.
func formatStep(_ hz: Double) -> String {
    if hz >= 1_000_000 { return String(format: "%g MHz", hz / 1_000_000) }
    if hz >= 1_000 { return String(format: "%g kHz", hz / 1_000) }
    return String(format: "%g Hz", hz)
}

func formatFreq(_ hz: Double) -> (String, String) {
    if hz <= 0 { return ("—", "") }
    if hz >= 30_000_000 { return (String(format: "%.2f", hz / 1_000_000), "MHz") }
    if hz >= 1_000_000  { return (String(format: "%.0f", hz / 1000), "kHz") }
    return (String(format: "%.1f", hz / 1000), "kHz")
}
