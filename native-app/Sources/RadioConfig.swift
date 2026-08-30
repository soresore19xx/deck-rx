import Foundation

struct RadioConfig: Codable, Equatable {
    var host = "127.0.0.1"
    var port = 5555
    var frequencyHz: Double = 1_134_000
    var mode = 2
    /// RF gain index, kept per demod family the way the plugin keeps it
    /// (spyService.ts:107). AM is usually pulled down to dodge IMD from a
    /// strong medium-wave neighbour while FM wants all of it, and one number
    /// cannot be both. nil means "never chosen here", which resolves to the
    /// device's own maxGainIndex — what the plugin seeds them with on the first
    /// DeviceInfo (spyService.ts:469).
    var amGain: UInt32?
    var fmGain: UInt32?
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
    /// SDR++'s slider units, as the plugin stores them: attack 1..200, decay
    /// 1..20, converted to a per-sample alpha at apply time. 50 and 5 are
    /// DEFAULT_AM_OPTIONS (spyService.ts:76).
    var amAgcAttack: Double = 50
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
    /// "min", "middle" or "max". Applied at construction — every constraint
    /// constant and font size is baked in when the window is built — so
    /// changing it swaps in a freshly built view rather than taking a relaunch.
    /// Read and written by both bundles: it describes the window, not the radio.
    var uiScale = "max"
    /// Fraction of the spectrum panel given to the trace; the rest is the
    /// waterfall. Dragged on the rail between the two, and kept because how
    /// much history a band is worth is a habit, not a per-session decision.
    var spectrumSplit: Double = 0.45
    /// The display's own settings: the dB window the trace is drawn in, the
    /// zoom, and how far back the waterfall reaches. Kept because they are
    /// ridden constantly and were rebuilt from scratch on every launch — a
    /// receiver that came up on a band you had already set the window for
    /// showed a flat line until you set it again. Defaults match the FFT
    /// dial's on the deck, so the two displays start out saying the same
    /// thing about the same signal.
    var spectrumDbFloor: Double = -160
    var spectrumDbCeil: Double = -1
    var spectrumZoom: Double = 1
    /// The transform itself: how big, how often, and how much frame-to-frame
    /// averaging (a divisor — 1 is off, larger is slower). The Mac's toolbar
    /// has written these since it had one; they simply had nowhere to live, so
    /// every launch started at the defaults again.
    var spectrumFftSize = 4096
    var spectrumFps = 30
    /// SDR++'s "FFT smoothing speed", and the plugin's (spectrumFeed.ts:51):
    /// **larger follows the trace faster**, which is less averaging, and the
    /// coefficient is normalised by the frame rate so changing the rate changes
    /// how often the trace is drawn rather than how smooth it is.
    /// alpha = min(1, speed / (fps * 10)).
    var spectrumSmoothSpeed: Double = 30
    var waterfallSeconds: Double = 45
    /// The IQ width the receiver last reported. Kept so the display can place
    /// the presets on a scale at startup, before any frame — and even with the
    /// plugin down, when there is no status feed to ask.
    var spectrumSpanHz: Double = 0

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
    /// Zero when the setting is "off", as the plugin has it
    /// (spyService.ts:855) — the sheet offers off / 50us / 75us and "off" has
    /// to mean off. This used to fall through to 75 µs for anything that was
    /// not "50us", so the option could not be turned off at all.
    var deemphasisTau: Double {
        switch fmDeemphasis {
        case "50us": return 50e-6
        case "75us": return 75e-6
        default:     return 0
        }
    }

    /// The band a step is filed under. AM is split because 9 kHz is the medium
    /// wave raster and 5 kHz the short-wave one; everything else has one raster
    /// per mode. spyService.ts:196.
    static func stepBand(ofHz hz: Double) -> String {
        if hz < 1_800_000 { return "mw" }      // long and medium wave
        if hz < 30_000_000 { return "sw" }     // the rest of HF
        return "vhf"
    }

    /// The key a remembered step is filed under — the plugin's own shape, so
    /// the two config files stay readable by each other. spyService.ts:233.
    static func stepKey(mode: Int, hz: Double) -> String {
        mode == 2 ? "2:\(stepBand(ofHz: hz))" : String(mode)
    }

    /// The step a band is channelised on, for when nothing has been chosen.
    /// spyService.ts:218. Japanese FM sits on a 100 kHz raster; tuning it in
    /// 9 kHz — which is what a bare `tuneStepHz` gave every mode here — takes
    /// eleven presses to reach the next station.
    static func defaultStep(mode: Int, hz: Double) -> Double? {
        switch mode {
        case 1: return 100_000                                       // WFM
        case 0: return 12_500                                        // NFM
        case 2: return stepBand(ofHz: hz) == "sw" ? 5_000 : 9_000    // AM
        case 4, 6: return 1_000                                      // USB / LSB
        case 5: return 100                                           // CW
        default: return nil
        }
    }

    /// The steps worth offering in a mode, so a picker never lists a raster the
    /// band has no use for: WFM never wants 100 Hz and CW never wants 1 MHz.
    /// spyService.ts:181-185 and :237, value for value.
    static func stepValues(for mode: Int) -> [Double] {
        switch mode {
        case 1:    return [10_000, 25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]
        case 0:    return [1_000, 5_000, 9_000, 10_000, 12_500, 25_000, 50_000, 100_000]
        case 2:    return [100, 1_000, 5_000, 9_000, 10_000, 25_000]
        case 4, 6: return [50, 100, 500, 1_000, 5_000, 10_000]
        case 5:    return [10, 50, 100, 500, 1_000]
        default:   return [10, 50, 100, 500, 1_000, 5_000, 9_000, 10_000, 12_500,
                           25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]
        }
    }

    /// What was last chosen for this mode and band, or the band's own raster,
    /// or the current step. spyService.ts:1070.
    func step(for mode: Int, hz: Double) -> Double {
        let key = Self.stepKey(mode: mode, hz: hz)
        if let v = tuneStepByMode[key], v > 0 { return v }
        // A config written before AM was split by band carries a bare "2".
        // That value was chosen on medium wave, which is where the old default
        // sat, so it belongs to that band.
        if key == "2:mw", let v = tuneStepByMode["2"], v > 0 { return v }
        if let d = Self.defaultStep(mode: mode, hz: hz) { return d }
        return tuneStepHz
    }

    /// 0 NFM and 1 WFM are the FM family; 3 DSB rides the FM path too, as it
    /// does in the plugin.
    func bandwidth(for mode: Int) -> Double {
        mode == 0 || mode == 1 || mode == 3 ? fmBandwidthHz : amBandwidthHz
    }


    /// Declaring any initialiser suppresses the implicit one, and every
    /// property already carries its default.
    init() {}

    /// The single `gain` this file carried before AM and FM were told apart.
    /// Not a property any more, so the synthesised keys no longer name it.
    private enum LegacyKeys: String, CodingKey { case gain, spectrumSmooth }

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
        // A file written before AM and FM were told apart carries one `gain`.
        // It belongs to AM: that is the mode it would have been lowered in.
        // Same migration as spyService.ts:626.
        let legacyGain: UInt32? = (try? decoder.container(keyedBy: LegacyKeys.self))
            .flatMap { (try? $0.decodeIfPresent(UInt32.self, forKey: .gain)) ?? nil }
        amGain = (try? c.decodeIfPresent(UInt32.self, forKey: .amGain)) .flatMap { $0 } ?? legacyGain
        fmGain = (try? c.decodeIfPresent(UInt32.self, forKey: .fmGain)) .flatMap { $0 }
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
        uiScale = (try? c.decodeIfPresent(String.self, forKey: .uiScale)) .flatMap { $0 } ?? d.uiScale
        spectrumSplit = (try? c.decodeIfPresent(Double.self, forKey: .spectrumSplit)) .flatMap { $0 } ?? d.spectrumSplit
        spectrumDbFloor = (try? c.decodeIfPresent(Double.self, forKey: .spectrumDbFloor)) .flatMap { $0 } ?? d.spectrumDbFloor
        spectrumDbCeil = (try? c.decodeIfPresent(Double.self, forKey: .spectrumDbCeil)) .flatMap { $0 } ?? d.spectrumDbCeil
        spectrumZoom = (try? c.decodeIfPresent(Double.self, forKey: .spectrumZoom)) .flatMap { $0 } ?? d.spectrumZoom
        spectrumFftSize = (try? c.decodeIfPresent(Int.self, forKey: .spectrumFftSize)) .flatMap { $0 } ?? d.spectrumFftSize
        spectrumFps = (try? c.decodeIfPresent(Int.self, forKey: .spectrumFps)) .flatMap { $0 } ?? d.spectrumFps
        // The old key held a divisor — alpha = 1 / value — which ran the other
        // way: larger meant smoother. Converted at the frame rate it was stored
        // with, so a file written under the old meaning keeps the trace it had.
        if let sp = (try? c.decodeIfPresent(Double.self, forKey: .spectrumSmoothSpeed)) .flatMap({ $0 }) {
            spectrumSmoothSpeed = sp
        } else if let old = (try? decoder.container(keyedBy: LegacyKeys.self))
            .flatMap({ (try? $0.decodeIfPresent(Double.self, forKey: .spectrumSmooth)) ?? nil }), old > 0 {
            spectrumSmoothSpeed = min(1000, max(1, (1 / old) * Double(spectrumFps) * 10))
        } else {
            spectrumSmoothSpeed = d.spectrumSmoothSpeed
        }
        waterfallSeconds = (try? c.decodeIfPresent(Double.self, forKey: .waterfallSeconds)) .flatMap { $0 } ?? d.waterfallSeconds
        spectrumSpanHz = (try? c.decodeIfPresent(Double.self, forKey: .spectrumSpanHz)) .flatMap { $0 } ?? d.spectrumSpanHz
        audioDecimate = (try? c.decodeIfPresent(Int.self, forKey: .audioDecimate)) .flatMap { $0 } ?? d.audioDecimate
        audioGain = (try? c.decodeIfPresent(Double.self, forKey: .audioGain)) .flatMap { $0 } ?? d.audioGain
        levelingEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .levelingEnabled)) .flatMap { $0 } ?? d.levelingEnabled
        autoDirect = (try? c.decodeIfPresent(Bool.self, forKey: .autoDirect)) .flatMap { $0 } ?? d.autoDirect
        autoAudio = (try? c.decodeIfPresent(Bool.self, forKey: .autoAudio)) .flatMap { $0 } ?? d.autoAudio
    }

    // MARK: persistence

    private static let ownPath: String = {
        let dir = Plat.appSupport.appendingPathComponent("deck-rx")
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
        if let v = j["gain"] as? Int { c.amGain = UInt32(max(0, v)) }   // pre-split files
        if let v = j["amGain"] as? Int { c.amGain = UInt32(max(0, v)) }
        if let v = j["fmGain"] as? Int { c.fmGain = UInt32(max(0, v)) }
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
