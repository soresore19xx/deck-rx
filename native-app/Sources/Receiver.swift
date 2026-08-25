import Foundation

/// Display scale. One knob for the whole window: an 11-inch screen is 1366 x
/// 768 and the layout's own minimum was taller than that, so nothing short of
/// shrinking the parts makes it fit. Fonts and fixed dimensions both go through
/// here — scaling only the text leaves the panels their full width and gains
/// nothing.
enum UI {
    static var scale: CGFloat = 1

    static func from(_ name: String) -> CGFloat {
        switch name {
        // "normal"/"compact"/"tiny" were the first names; a config written
        // under them still loads rather than silently reverting to max.
        case "min",    "tiny":    return 0.72
        case "middle", "compact": return 0.85
        default:                  return 1
        }
    }
    static let names = ["min", "middle", "max"]

    /// The frequency readout and the station line above it take a second
    /// reduction on top of the window scale. They are the largest things on
    /// screen by a wide margin — a 96 pt seven-segment row and a 26 pt name —
    /// so scaling them with everything else still leaves them dominating a
    /// small window while the panels around them have given all they can.
    static var headline: CGFloat { scale < 0.8 ? scale * 0.78 : scale < 1 ? scale * 0.88 : 1 }

    /// Dimension scaled for those two, rounded.
    static func H(_ v: CGFloat) -> CGFloat { (v * headline).rounded() }
}

/// Scaled dimension. Rounded, because a half-pixel constraint on every panel
/// edge is how a layout starts looking soft.
func S(_ v: CGFloat) -> CGFloat { (v * UI.scale).rounded() }


/// The receiver's persisted settings, owned by the app.
///
/// Reads the plugin's `config.json` when one is there, so the app comes up on
/// the same server, frequency, mode, bandwidth and tune step the deck was last
/// using instead of on invented defaults. Writes to its **own** file: the
/// plugin owns that config, and two processes writing one JSON file is how a
/// setting silently reverts.
///
/// A missing file on either side is normal, not an error — a fresh machine has
/// no plugin at all, which is the entire point of the port.


/// Everything this app knows about the receiver, and the only ways it changes it.
///
/// Reads come from the plugin's status feed (a small JSON file refreshed 4×/s)
/// and writes go to its control endpoint on 127.0.0.1:8771 — the same two
/// channels the Stream Deck plugin and the BRIMFORD knob already use. This app
/// owns no receiver state of its own: every control call is fire-and-forget and
/// the next status read is the truth.
enum Receiver {
    // MARK: paths

    static let baseDir: String = Plat.scratch
    static let statusPath = ProcessInfo.processInfo.environment["DECK_RX_STATUS_PATH"]
        ?? (baseDir + "/deck-rx-status.json")
    /// The plugin writes the feed only while this flag stays fresh, so a closed
    /// app costs it nothing.
    static let alivePath = baseDir + "/deck-rx-app.alive"
    /// Resolves inside the app container on iOS, where it never exists. The
    /// seeding below already skips a candidate that is not there, so an absent
    /// plugin needs no special case beyond this one.
    static let pluginDir = Plat.appSupport
        .appendingPathComponent("com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin")
    /// The app's own data directory. Everything the receiver needs to run —
    /// presets, the station databases — lives here, not in the plugin bundle:
    /// a machine with no plugin has no such bundle, and that machine is the
    /// whole point of the standalone app.
    ///
    /// Seeded once from the plugin's copy when there is one, and from the
    /// bundled resources otherwise. After that it is the app's, and the plugin
    /// never touches it.
    static let dataDir: String = {
        let dir = Plat.appSupport.appendingPathComponent("deck-rx/data")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }()

    static let presetsPath = dataDir + "/presets.json"

    /// Copies a data file in if it is not there yet. Never overwrites: the
    /// user's presets are edited here, and re-seeding would silently undo that.
    static func seedDataFile(_ name: String) {
        let fm = FileManager.default
        let dst = dataDir + "/" + name
        guard !fm.fileExists(atPath: dst) else { return }
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent(name).path,
            pluginDir.appendingPathComponent("data/" + name).path,
        ].compactMap { $0 }
        for src in candidates where fm.fileExists(atPath: src) {
            try? fm.copyItem(atPath: src, toPath: dst)
            return
        }
    }

    static func seedData() {
        for f in ["presets.json", "jp-stations.json", "eibi.txt", "callsigns.json"] {
            seedDataFile(f)
        }
    }
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
        var audioSink = "local"
        var host = ""
        var port = 0
        var fresh = false      // feed updated recently — otherwise nothing is live
    }

    /// Installed while the app is receiving on its own. Every control below
    /// consults it first, so the existing call sites do not each need to know
    /// which receiver is live — returning true means the direct path took it.
    struct DirectControl {
        var status: () -> Status
        var tuneHz: (Int) -> Void
        var tuneTicks: (Int) -> Void
        var mode: (Int) -> Void
        var volume: (Double) -> Void
        var toggleMute: () -> Void
    }
    static var direct: DirectControl?

    static func status() -> Status {
        if let d = direct { return d.status() }
        return status_fromFeed()
    }

    /// The feed on its own, with no direct-control override. The direct path
    /// starts from this so fields it does not own — station name above all —
    /// keep working whenever the plugin happens to be up too.
    static func status_fromFeed() -> Status {
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
        s.audioSink   = j["audioSink"] as? String ?? "local"
        s.host      = j["host"] as? String ?? ""
        s.port      = j["port"] as? Int ?? 0
        if let ts = j["ts"] as? Double {
            s.fresh = Date().timeIntervalSince1970 * 1000 - ts < 2000
        }
        return s
    }

    // MARK: presets

    struct Preset { let name: String; let freq: Double; let mode: Int }

    /// Broadcast bands worth a shortcut, with the demod each one implies.
    /// Ranges are the broadcast allocations, not the amateur ones — this is a
    /// shortcut for "take me to where the stations are".
    struct Band { let name: String; let lo: Double; let hi: Double; let mode: Int }
    static let bands: [Band] = [
        Band(name: "MW",  lo:    531_000, hi:   1_602_000, mode: 2),
        Band(name: "49m", lo:  5_900_000, hi:   6_200_000, mode: 2),
        Band(name: "41m", lo:  7_200_000, hi:   7_450_000, mode: 2),
        Band(name: "31m", lo:  9_400_000, hi:   9_900_000, mode: 2),
        Band(name: "25m", lo: 11_600_000, hi:  12_100_000, mode: 2),
        Band(name: "19m", lo: 15_100_000, hi:  15_800_000, mode: 2),
        Band(name: "FM",  lo: 76_000_000, hi:  95_000_000, mode: 1),
    ]

    /// The broadcast band a frequency belongs to, for grouping the preset list.
    ///
    /// Coarse on purpose. Grouping by metre band — the names on the BAND JUMP
    /// buttons — sounds better and reads worse: a store holding 5750, 6055,
    /// 7325, 9975 and 17650 falls into seven groups for eight entries, because
    /// half of them sit between the broadcast bands rather than inside one.
    static func bandName(ofHz hz: Double) -> String {
        if hz < 1_800_000 { return "MW" }        // long wave and medium wave
        if hz < 30_000_000 { return "SW" }       // everything else on HF
        if hz < 108_000_000 { return "FM" }      // the broadcast band and below it
        return "VHF"
    }

    /// Jump to a band: the first preset inside it if there is one — landing on
    /// a station beats landing on the band edge — otherwise the low edge.
    static func jump(to band: Band) {
        let target = presets().first { $0.freq >= band.lo && $0.freq <= band.hi }
        mode(target?.mode ?? band.mode)
        tune(hz: Int(target?.freq ?? band.lo))
    }

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

    static func tune(ticks: Int)   {
        if let d = direct { d.tuneTicks(ticks); return }
        call("/tune?ticks=\(ticks)")
    }
    static func tune(hz: Int)      {
        if let d = direct { d.tuneHz(hz); return }
        call("/tune?hz=\(hz)")
    }
    static func volume(delta: Int) { call("/volume?d=\(delta)") }
    /// Absolute 0..1 — what a click on the volume bar means.
    static func volume(level: Double) {
        if let d = direct { d.volume(max(0, min(1, level))); return }
        call(String(format: "/volume?v=%.3f", max(0, min(1, level))))
    }
    static func toggleMute()       {
        if let d = direct { d.toggleMute(); return }
        call("/mute?toggle=1")
    }
    static func togglePower()      { call("/power?toggle=1") }
    static func preset(step: Int)  { call("/preset?d=\(step > 0 ? 1 : -1)") }
    /// Demod mode by index (see MODE_NAMES). A preset's mode travels with it.
    static func mode(_ m: Int)     {
        if let d = direct { d.mode(m); return }
        call("/mode?m=\(m)")
    }

    /// Receiver-wide settings: tune mode, JP region, audio sink and the SDR++
    /// import. The deck exposes these through its Property Inspector; this is
    /// the same set, so the window is not a read-only view of the radio.
    static func receiver(set name: String? = nil, value: String? = nil,
                         action: String? = nil,
                         then: @escaping ([String: Any]) -> Void) {
        var parts: [String] = []
        if let action { parts.append("action=\(action)") }
        if let name, let value,
           let n = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let v = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            parts.append("set=\(n)"); parts.append("value=\(v)")
        }
        let query = parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
        guard let url = URL(string: "http://127.0.0.1:\(controlPort)/receiver\(query)") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 8
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async { then(j) }
        }.resume()
    }

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
/// so a frequency reads identically on the deck and here:
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
