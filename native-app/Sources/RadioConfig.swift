import Foundation

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
struct RadioConfig: Codable {
    var host = "127.0.0.1"
    var port = 5555
    var frequencyHz: Double = 1_134_000
    var mode = 2
    var gain: UInt32 = 5
    var volume: Double = 0.9
    var muted = false
    /// Offset from the device's MinimumIQDecimation, SDR++'s srId.
    var iqDecimation: UInt32 = 1
    var jpRegion = "kanto"

    var tuneStepHz: Double = 9000
    /// Per-mode step, keyed by mode index as a string — the plugin's shape, so
    /// the two files stay readable by each other.
    var tuneStepByMode: [String: Double] = [:]

    var amBandwidthHz: Double = 9000
    var amCarrierAgc = false
    var amSync = false
    var fmBandwidthHz: Double = 150_000
    var fmStereo = true
    var fmIfnr = false
    /// "50us" (JP/EU) or "75us" (US). Stored as the plugin stores it.
    var fmDeemphasis = "75us"
    var fmHighPass = false
    var fmLowPass = false
    var amAgcAttack: Double = 20
    var amAgcDecay: Double = 5
    var ssbBandwidthHz: Double = 2400
    var cwBfoHz: Double = 700
    /// "preset" walks the store; "vfo" steps by tuneStepHz. The plugin's own
    /// wording, so the two files stay readable by each other.
    var tuneMode = "preset"
    var autoSyncSdrpp = false
    /// Empty means the system default output. A name that no longer exists
    /// falls back to the default rather than going silent.
    var audioDevice = ""

    var audioDecimate = 4
    var audioGain: Double = 1
    var levelingEnabled = false
    /// Come up receiving instead of waiting for DIRECT to be pressed. A machine
    /// whose job is to be a receiver should not need a click to become one, and
    /// it is the only way to drive the app on a box nobody sits at.
    var autoDirect = false
    /// Same for the audio path. Ignored unless autoDirect is on — there is
    /// nothing to demodulate otherwise.
    var autoAudio = false

    /// Seconds of tau for the de-emphasis IIR.
    var deemphasisTau: Double { fmDeemphasis == "50us" ? 50e-6 : 75e-6 }

    func step(for mode: Int) -> Double {
        tuneStepByMode[String(mode)] ?? tuneStepHz
    }

    /// 0 NFM and 1 WFM are the FM family; 3 DSB rides the FM path too, as it
    /// does in the plugin.
    func bandwidth(for mode: Int) -> Double {
        mode == 0 || mode == 1 || mode == 3 ? fmBandwidthHz : amBandwidthHz
    }


    /// Declaring any initialiser suppresses the implicit one, and every
    /// property already carries its default.
    init() {}

    /// Decoded key by key, each falling back to its default.
    ///
    /// The synthesised initialiser treats a missing key as an error, so adding
    /// one field made every older file fail to decode as a whole and fall back
    /// to defaults — silently, and for every setting at once. On a machine with
    /// no plugin to seed from, that turned autoDirect off and the receiver
    /// simply never connected, with the file on disk still saying it should.
    init(from decoder: Decoder) throws {
        let d = RadioConfig()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) .flatMap { $0 } ?? d.host
        port = (try? c.decodeIfPresent(Int.self, forKey: .port)) .flatMap { $0 } ?? d.port
        frequencyHz = (try? c.decodeIfPresent(Double.self, forKey: .frequencyHz)) .flatMap { $0 } ?? d.frequencyHz
        mode = (try? c.decodeIfPresent(Int.self, forKey: .mode)) .flatMap { $0 } ?? d.mode
        gain = (try? c.decodeIfPresent(UInt32.self, forKey: .gain)) .flatMap { $0 } ?? d.gain
        volume = (try? c.decodeIfPresent(Double.self, forKey: .volume)) .flatMap { $0 } ?? d.volume
        muted = (try? c.decodeIfPresent(Bool.self, forKey: .muted)) .flatMap { $0 } ?? d.muted
        iqDecimation = (try? c.decodeIfPresent(UInt32.self, forKey: .iqDecimation)) .flatMap { $0 } ?? d.iqDecimation
        jpRegion = (try? c.decodeIfPresent(String.self, forKey: .jpRegion)) .flatMap { $0 } ?? d.jpRegion
        tuneStepHz = (try? c.decodeIfPresent(Double.self, forKey: .tuneStepHz)) .flatMap { $0 } ?? d.tuneStepHz
        tuneStepByMode = (try? c.decodeIfPresent([String: Double].self, forKey: .tuneStepByMode)) .flatMap { $0 } ?? d.tuneStepByMode
        amBandwidthHz = (try? c.decodeIfPresent(Double.self, forKey: .amBandwidthHz)) .flatMap { $0 } ?? d.amBandwidthHz
        amCarrierAgc = (try? c.decodeIfPresent(Bool.self, forKey: .amCarrierAgc)) .flatMap { $0 } ?? d.amCarrierAgc
        amSync = (try? c.decodeIfPresent(Bool.self, forKey: .amSync)) .flatMap { $0 } ?? d.amSync
        fmBandwidthHz = (try? c.decodeIfPresent(Double.self, forKey: .fmBandwidthHz)) .flatMap { $0 } ?? d.fmBandwidthHz
        fmStereo = (try? c.decodeIfPresent(Bool.self, forKey: .fmStereo)) .flatMap { $0 } ?? d.fmStereo
        fmIfnr = (try? c.decodeIfPresent(Bool.self, forKey: .fmIfnr)) .flatMap { $0 } ?? d.fmIfnr
        fmDeemphasis = (try? c.decodeIfPresent(String.self, forKey: .fmDeemphasis)) .flatMap { $0 } ?? d.fmDeemphasis
        fmHighPass = (try? c.decodeIfPresent(Bool.self, forKey: .fmHighPass)) .flatMap { $0 } ?? d.fmHighPass
        fmLowPass = (try? c.decodeIfPresent(Bool.self, forKey: .fmLowPass)) .flatMap { $0 } ?? d.fmLowPass
        amAgcAttack = (try? c.decodeIfPresent(Double.self, forKey: .amAgcAttack)) .flatMap { $0 } ?? d.amAgcAttack
        amAgcDecay = (try? c.decodeIfPresent(Double.self, forKey: .amAgcDecay)) .flatMap { $0 } ?? d.amAgcDecay
        ssbBandwidthHz = (try? c.decodeIfPresent(Double.self, forKey: .ssbBandwidthHz)) .flatMap { $0 } ?? d.ssbBandwidthHz
        cwBfoHz = (try? c.decodeIfPresent(Double.self, forKey: .cwBfoHz)) .flatMap { $0 } ?? d.cwBfoHz
        tuneMode = (try? c.decodeIfPresent(String.self, forKey: .tuneMode)) .flatMap { $0 } ?? d.tuneMode
        autoSyncSdrpp = (try? c.decodeIfPresent(Bool.self, forKey: .autoSyncSdrpp)) .flatMap { $0 } ?? d.autoSyncSdrpp
        audioDevice = (try? c.decodeIfPresent(String.self, forKey: .audioDevice)) .flatMap { $0 } ?? d.audioDevice
        audioDecimate = (try? c.decodeIfPresent(Int.self, forKey: .audioDecimate)) .flatMap { $0 } ?? d.audioDecimate
        audioGain = (try? c.decodeIfPresent(Double.self, forKey: .audioGain)) .flatMap { $0 } ?? d.audioGain
        levelingEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .levelingEnabled)) .flatMap { $0 } ?? d.levelingEnabled
        autoDirect = (try? c.decodeIfPresent(Bool.self, forKey: .autoDirect)) .flatMap { $0 } ?? d.autoDirect
        autoAudio = (try? c.decodeIfPresent(Bool.self, forKey: .autoAudio)) .flatMap { $0 } ?? d.autoAudio
    }

    // MARK: persistence

    private static let ownPath: String = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/deck-rx")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("receiver.json").path
    }()

    private static var pluginPath: String {
        Receiver.pluginDir.appendingPathComponent("config.json").path
    }

    /// The app's own file wins when it exists — it is the record of what the
    /// user did here. The plugin's config is the seed for a first run, so a
    /// machine that has both does not start from scratch.
    static func load() -> RadioConfig {
        if let c = loadOwn() { return c }
        return loadFromPlugin() ?? RadioConfig()
    }

    private static func loadOwn() -> RadioConfig? {
        guard let d = FileManager.default.contents(atPath: ownPath) else { return nil }
        return try? JSONDecoder().decode(RadioConfig.self, from: d)
    }

    /// Reads the plugin's config by hand rather than through Codable: its shape
    /// is the plugin's to change, and a decoding failure there must not stop the
    /// app from starting.
    static func loadFromPlugin() -> RadioConfig? {
        guard let d = FileManager.default.contents(atPath: pluginPath),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        var c = RadioConfig()
        if let v = j["host"] as? String, !v.isEmpty { c.host = v }
        if let v = j["port"] as? Int, v > 0 { c.port = v }
        if let v = j["lastFrequency"] as? Double, v > 0 { c.frequencyHz = v }
        if let v = j["demodMode"] as? Int { c.mode = v }
        if let v = j["amGain"] as? Int { c.gain = UInt32(max(0, v)) }
        if let v = j["volume"] as? Double { c.volume = v }
        if let v = j["muted"] as? Bool { c.muted = v }
        if let v = j["iqDecimation"] as? Int { c.iqDecimation = UInt32(max(0, v)) }
        if let v = j["jpRegion"] as? String { c.jpRegion = v }
        if let v = j["tuneStepHz"] as? Double { c.tuneStepHz = v }
        if let v = j["tuneStepByMode"] as? [String: Any] {
            for (k, raw) in v {
                if let d = raw as? Double { c.tuneStepByMode[k] = d }
                else if let i = raw as? Int { c.tuneStepByMode[k] = Double(i) }
            }
        }
        if let v = j["audioDecimate"] as? Int, v > 0 { c.audioDecimate = v }
        if let v = j["audioGain"] as? Double { c.audioGain = v }
        if let v = j["audioLeveling"] as? Bool { c.levelingEnabled = v }
        if let v = j["tuneMode"] as? String { c.tuneMode = v }
        if let v = j["autoSyncSdrpp"] as? Bool { c.autoSyncSdrpp = v }
        if let nd = j["naudiodon"] as? [String: Any], let v = nd["deviceName"] as? String {
            c.audioDevice = v
        }
        if let am = j["am"] as? [String: Any] {
            if let v = am["bandwidth"] as? Double { c.amBandwidthHz = v }
            if let v = am["carrierAgc"] as? Bool { c.amCarrierAgc = v }
            if let v = am["sync"] as? Bool { c.amSync = v }
            if let v = am["agcAttack"] as? Double { c.amAgcAttack = v }
            if let v = am["agcDecay"] as? Double { c.amAgcDecay = v }
        }
        if let ssb = j["ssb"] as? [String: Any] {
            if let v = ssb["bandwidthHz"] as? Double { c.ssbBandwidthHz = v }
            if let v = ssb["bfoPitchHz"] as? Double { c.cwBfoHz = v }
        }
        if let fm = j["fm"] as? [String: Any] {
            if let v = fm["highPass"] as? Bool { c.fmHighPass = v }
            if let v = fm["lowPass"] as? Bool { c.fmLowPass = v }
            if let v = fm["bandwidth"] as? Double { c.fmBandwidthHz = v }
            if let v = fm["stereo"] as? Bool { c.fmStereo = v }
            if let v = fm["ifnr"] as? Bool { c.fmIfnr = v }
            if let v = fm["deemphasis"] as? String { c.fmDeemphasis = v }
        }
        return c
    }

    /// Best-effort. Losing a setting is worth less than crashing on a full disk
    /// or a read-only home.
    func save() {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let d = try? e.encode(self) else { return }
        try? d.write(to: URL(fileURLWithPath: Self.ownPath), options: .atomic)
    }
}
