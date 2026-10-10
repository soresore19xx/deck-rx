// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-10-09-234500
// Automatic per-station RF gain for the app's own receiver: the rules
// (a port of src/gainSearch.ts) and the file that remembers the choice.
// ====================
import Foundation

/// Try a handful of gain indices on a station, keep the one with the best
/// carrier-to-noise, and remember it per receiver and channel.
///
/// A transcription of `src/gainSearch.ts`, same numbers throughout — the
/// plugin and the app must choose the same gain on the same station, and the
/// tests on both sides use the same cases. Why it exists: one gain per
/// receiver and band cannot serve both ends of FM broadcast on the V4 (a gain
/// high enough for a neighbouring prefecture's 79.5 MHz overloads the strong
/// Tokyo stations; one low enough for those loses 79.5).
enum GainSearch {

    /// Channel used for the measurement per demod mode (0 NFM 1 WFM 2 AM
    /// 3 DSB 4 USB 5 CW 6 LSB 7 RAW): offset from the tuned frequency and width.
    static func measureChannel(mode: Int) -> (offsetHz: Double, widthHz: Double)? {
        switch mode {
        case 0: return (0, 12_500)
        case 1: return (0, 180_000)
        case 2, 3: return (0, 9_000)
        case 4: return (1_500, 3_000)
        case 6: return (-1_500, 3_000)
        case 5: return (0, 500)
        default: return nil
        }
    }

    /// HF+ (8) → 0 2 4 6 8, V4 (29) → 0 6 12 18 24 29.
    static func coarseGains(maxGain: Int) -> [Int] {
        guard maxGain > 0 else { return [0] }
        let step = max(1, Int((Double(maxGain) / 5).rounded()))
        var out: [Int] = []
        var g = 0
        while g < maxGain { out.append(g); g += step }
        out.append(maxGain)
        var seen = Set<Int>()
        return out.filter { seen.insert($0).inserted }
    }

    /// The midpoints either side of the best coarse point.
    static func refineGains(best: Int, maxGain: Int, coarse: [Int]) -> [Int] {
        let step = coarse.count > 1 ? coarse[1] - coarse[0] : 1
        let half = step / 2
        guard half >= 1 else { return [] }
        return [best - half, best + half].filter { $0 >= 0 && $0 <= maxGain && !coarse.contains($0) }
    }

    /// C/N in dB from one fftshift'd dBFS spectrum (bin N/2 = the IQ centre).
    /// `centreOffsetHz` is where the tuned frequency sits against the IQ centre.
    static func channelCnDb(bins: [Float], iqRate: Double, centreOffsetHz: Double, mode: Int) -> Double? {
        channelLevels(bins: bins, iqRate: iqRate, centreOffsetHz: centreOffsetHz, mode: mode)?.cn
    }

    /// AM, DSB and CW are judged by their carrier (the strongest bin in the
    /// channel), which stands still under modulation; the others by the mean.
    private static func hasCarrier(_ mode: Int) -> Bool { mode == 2 || mode == 3 || mode == 5 }

    /// `cn` as channelCnDb, `signalDb` (carrier or channel mean) and `floorDb`
    /// (median bin outside the channel), dBFS — `channelLevels` exactly.
    static func channelLevels(bins: [Float], iqRate: Double, centreOffsetHz: Double,
                              mode: Int) -> (cn: Double, signalDb: Double, floorDb: Double)? {
        guard let ch = measureChannel(mode: mode), bins.count >= 64, iqRate > 0 else { return nil }
        let n = bins.count
        let hzPerBin = iqRate / Double(n)
        let centre = centreOffsetHz + ch.offsetHz
        let half = ch.widthHz / 2
        let edge = iqRate * 0.45          // off the decimation filter's skirts
        var sum = 0.0, count = 0
        var top = -Double.infinity
        var floor: [Float] = []
        for i in 0..<n {
            let f = (Double(i) - Double(n) / 2) * hzPerBin
            if abs(f) > edge { continue }
            let d = abs(f - centre)
            if d <= half {
                sum += pow(10, Double(bins[i]) / 10); count += 1
                top = max(top, Double(bins[i]))
            } else if d > half * 1.2 + hzPerBin { floor.append(bins[i]) }
        }
        guard count >= 1, floor.count >= 16 else { return nil }
        floor.sort()
        let floorDb = Double(floor[floor.count >> 1])
        let meanDb = 10 * log10(sum / Double(count))
        return (meanDb - floorDb, hasCarrier(mode) ? top : meanDb, floorDb)
    }

    /// IQ peak allowed at the chosen gain. C/N peaks on the step just under
    /// overload, so the best-C/N gain sits at the edge: on the V4 90.5 MHz
    /// peaked at -1.7 dBFS and 82.5 MHz at -0.3 (2026-10-09).
    static let maxPeakDbfs = -6.0
    /// Below this best C/N there is no station to judge by; nothing is chosen.
    static let minCnDb = 6.0

    /// A step up is taken while the floor rises by less than this share of
    /// the signal's rise (GAIN_FLOOR_RISE_SHARE).
    static let floorRiseShare = 0.5

    struct Result {
        let gain: Int; let cn: Double; var peakDb: Double? = nil
        var signalDb: Double? = nil; var floorDb: Double? = nil
    }

    /// `pickGain` exactly: among the gains that leave the headroom, climb from
    /// the lowest and stop where the floor rises by `floorRiseShare` or more
    /// of the signal's rise, or the signal stops rising — past that the noise
    /// is the antenna's and more gain only lifts the floor. Until the station
    /// stands `minCnDb` clear, any step that improves C/N is taken. Results
    /// without levels fall back to the lowest gain within `toleranceDb` of the
    /// best C/N (the rule before, which chose 24-26 on medium wave where 6-12
    /// gave the same C/N: user, 2026-10-10). The lowest gain tried when none
    /// leaves the headroom; nil when nothing was measured or no gain shows a
    /// station.
    static func pickGain(_ results: [Result], toleranceDb: Double = 1,
                         maxPeakDb: Double = maxPeakDbfs) -> Int? {
        guard !results.isEmpty else { return nil }
        guard results.map(\.cn).max()! >= minCnDb else { return nil }
        let clean = results.filter { $0.peakDb == nil || $0.peakDb! <= maxPeakDb }
        if clean.isEmpty { return results.map(\.gain).min() }
        if clean.contains(where: { $0.signalDb == nil || $0.floorDb == nil }) {
            let best = clean.map(\.cn).max()!
            return clean.filter { $0.cn >= best - toleranceDb }.map(\.gain).min()
        }
        let up = clean.sorted { $0.gain < $1.gain }
        var at = up[0]
        for next in up.dropFirst() {
            if at.cn < minCnDb {
                if next.cn > at.cn { at = next; continue }
                break
            }
            let dSignal = next.signalDb! - at.signalDb!
            let dFloor = next.floorDb! - at.floorDb!
            if dSignal <= 0 || dFloor >= floorRiseShare * dSignal { break }
            at = next
        }
        return at.gain
    }

    /// Receiver, channel to 100 Hz, demod mode — `gainMemoryKey` exactly.
    static func key(deviceKey: String, freqHz: Double, mode: Int) -> String {
        "\(deviceKey)|\(Int((freqHz / 100).rounded()) * 100)|\(mode)"
    }
}

/// The gains the search chose (`gains`) and the ones the user saved for a
/// station on purpose (`saved`), in the plugin's file layout. A saved gain
/// wins and is never searched over. Its own file beside receiver.json.
final class GainMemory {
    static let shared = GainMemory()

    private struct File: Codable {
        var version = 1
        var gains: [String: Int] = [:]
        var saved: [String: Int]? = [:]
    }
    private var file: File
    private let path: String
    private let lock = NSLock()

    /// `DECK_RX_GAIN_MEMORY_PATH` redirects it, and the test runner sets it.
    init(path: String? = nil) {
        if let p = path ?? ProcessInfo.processInfo.environment["DECK_RX_GAIN_MEMORY_PATH"], !p.isEmpty {
            self.path = p
        } else {
            let dir = Plat.appSupport.appendingPathComponent("deck-rx")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            self.path = dir.appendingPathComponent("gain-memory.json").path
        }
        if let d = FileManager.default.contents(atPath: self.path),
           let f = try? JSONDecoder().decode(File.self, from: d) {
            file = f
        } else {
            file = File()
        }
    }

    enum Source: String { case saved, auto }

    func recall(_ key: String) -> Int? {
        lock.lock(); defer { lock.unlock() }
        return file.saved?[key] ?? file.gains[key]
    }

    func source(_ key: String) -> Source? {
        lock.lock(); defer { lock.unlock() }
        if file.saved?[key] != nil { return .saved }
        if file.gains[key] != nil { return .auto }
        return nil
    }

    func remember(_ key: String, _ gain: Int) {
        lock.lock(); defer { lock.unlock() }
        guard file.gains[key] != gain else { return }
        file.gains[key] = gain
        write()
    }

    func save(_ key: String, _ gain: Int) {
        lock.lock(); defer { lock.unlock() }
        guard file.saved?[key] != gain else { return }
        if file.saved == nil { file.saved = [:] }
        file.saved![key] = gain
        write()
    }

    func forget(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        guard file.gains[key] != nil || file.saved?[key] != nil else { return }
        file.gains[key] = nil
        file.saved?[key] = nil
        write()
    }

    /// Both maps, for sync (Sync.swift).
    func maps() -> (gains: [String: Int], saved: [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        return (file.gains, file.saved ?? [:])
    }

    /// Apply what sync settled on: `nil` deletes the key.
    func apply(gains: [String: Int?], saved: [String: Int?]) {
        lock.lock(); defer { lock.unlock() }
        for (k, v) in gains { file.gains[k] = v }
        if file.saved == nil { file.saved = [:] }
        for (k, v) in saved { file.saved![k] = v }
        write()
    }

    /// When the file last changed, in ms since 1970; 0 when there is none.
    var mtimeMs: Double {
        let a = try? FileManager.default.attributesOfItem(atPath: path)
        return ((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    }

    /// Atomic; a lost write costs one more search, nothing else.
    private func write() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let d = try? enc.encode(file) else { return }
        try? d.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
