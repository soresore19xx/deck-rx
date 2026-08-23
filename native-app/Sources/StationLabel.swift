import Foundation

/// Station-name lookup, read straight from the plugin's data files.
///
/// Ports `src/stationLabel.ts`, `src/japanStations.ts` and `src/eibi.ts`. The
/// files are the deck-rx-owned store; nothing here writes to them.
///
/// Priority is the plugin's, and the order matters:
///   1. jp-stations.json, filtered to the active region. Wins for FM (EIBI has
///      nothing above 30 MHz) and for domestic MW that EIBI does not list.
///   2. EIBI, for international shortwave, matched on day and time of day.
///   3. Nothing — the caller falls back to the preset name.
enum StationLabel {

    // MARK: regions

    enum Region: String, CaseIterable {
        case kanto, hokkaido, tohoku, tokai, kinki, chugoku, kyushu, okinawa

        var label: String {
            switch self {
            case .kanto: return "関東"
            case .hokkaido: return "北海道"
            case .tohoku: return "東北"
            case .tokai: return "東海"
            case .kinki: return "近畿"
            case .chugoku: return "中国"
            case .kyushu: return "九州"
            case .okinawa: return "沖縄"
            }
        }

        /// Prefectures each 総合通信局 covers. Used to prefer a same-region
        /// callsign when several licences share a frequency — over half of the
        /// freq+band buckets have more than one, and without this the lookup
        /// picked whichever came first and mis-attributed the station.
        ///
        /// 関東 includes 山梨県: administrative scope, not geography, and the
        /// JP DB tags it that way.
        var prefectures: [String] {
            switch self {
            case .kanto:    return ["東京都", "神奈川県", "千葉県", "埼玉県", "茨城県", "栃木県", "群馬県", "山梨県"]
            case .hokkaido: return ["北海道"]
            case .tohoku:   return ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]
            case .tokai:    return ["静岡県", "愛知県", "三重県", "岐阜県"]
            case .kinki:    return ["大阪府", "京都府", "兵庫県", "奈良県", "和歌山県", "滋賀県"]
            case .chugoku:  return ["鳥取県", "島根県", "岡山県", "広島県", "山口県"]
            case .kyushu:   return ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県"]
            case .okinawa:  return ["沖縄県"]
            }
        }
    }

    // MARK: data

    private struct JpStation {
        var freqHz: Double
        var band: String          // "FM" | "MW"
        var name: String
        var region: String?
        var callsign: String?
        var siteName: String?
    }

    private struct Callsign {
        var freqHz: Double
        var band: String
        var callsign: String
        var location: String
    }

    private struct EibiEntry {
        var freqKhz: Int
        var startMin: Int
        var endMin: Int
        var dayCode: String
        var name: String
    }

    // 5 kHz sits well inside the 100 kHz FM grid; 500 Hz absorbs float drift on
    // MW without ever reaching an adjacent channel.
    private static let fmTolerance: Double = 5000
    private static let mwTolerance: Double = 500

    private static var auto: [JpStation] = []
    private static var manual: [JpStation] = []
    private static var callsigns: [Callsign] = []
    private static var eibi: [EibiEntry] = []
    private static var loaded = false

    /// The plugin's own data directory, resolved the same way the preset store
    /// is. Read-only from here: the plugin owns these files, and SDR++ owns the
    /// bookmark file they were built from.
    static var dataDir = Receiver.pluginDir.appendingPathComponent("data").path

    /// Loaded once. A missing file is not an error: the caller falls back to the
    /// preset name, which is better than refusing to show a frequency at all.
    private static func load() {
        guard !loaded else { return }
        loaded = true
        loadJp()
        loadCallsigns()
        loadEibi()
    }

    private static func station(from d: [String: Any]) -> JpStation? {
        guard let f = d["freqHz"] as? Double ?? (d["freqHz"] as? Int).map(Double.init),
              let b = d["band"] as? String, let n = d["name"] as? String else { return nil }
        return JpStation(freqHz: f, band: b, name: n,
                         region: d["region"] as? String,
                         callsign: d["callsign"] as? String,
                         siteName: d["siteName"] as? String)
    }

    private static func loadJp() {
        guard let data = FileManager.default.contents(atPath: "\(dataDir)/jp-stations.json"),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        auto = (root["stations"] as? [[String: Any]] ?? []).compactMap(station(from:))
        manual = (root["manualStations"] as? [[String: Any]] ?? []).compactMap(station(from:))
    }

    private static func loadCallsigns() {
        guard let data = FileManager.default.contents(atPath: "\(dataDir)/callsigns.json"),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["callsigns"] as? [[String: Any]] else { return }
        callsigns = list.compactMap { d in
            guard let f = d["freqHz"] as? Double ?? (d["freqHz"] as? Int).map(Double.init),
                  let b = d["band"] as? String, let c = d["callsign"] as? String else { return nil }
            return Callsign(freqHz: f, band: b, callsign: c, location: d["location"] as? String ?? "")
        }
    }

    /// Fixed-column format, the same slices the plugin cuts:
    /// freq 0..14, time 14..23, days+ITU 23..34, name 34..58.
    private static func loadEibi() {
        // EIBI ships Latin-1 in places; UTF-8 first, then fall back rather than
        // losing the whole file over one accented station name.
        let path = "\(dataDir)/eibi.txt"
        guard let text = (try? String(contentsOfFile: path, encoding: .utf8))
                ?? (try? String(contentsOfFile: path, encoding: .isoLatin1)) else { return }
        var out: [EibiEntry] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = Array(raw.hasSuffix("\r") ? String(raw.dropLast()) : String(raw))
            guard line.count >= 50 else { continue }
            func slice(_ a: Int, _ b: Int) -> String {
                String(line[a..<min(b, line.count)]).trimmingCharacters(in: .whitespaces)
            }
            guard let freq = Double(slice(0, 14)), freq > 0 else { continue }
            let timeStr = slice(14, 23)
            let t = Array(timeStr)
            guard t.count == 9, t[4] == "-",
                  let sh = Int(String(t[0...1])), let sm = Int(String(t[2...3])),
                  let eh = Int(String(t[5...6])), let em = Int(String(t[7...8])) else { continue }
            let name = slice(34, 58)
            // Jammers are not stations, and "spur" rows catalogue parasitic
            // emissions — showing either as a station name is worse than a dash.
            guard !name.isEmpty, !name.contains("Jammer") else { continue }
            let dItu = slice(23, 34).split(separator: " ").map(String.init).filter { !$0.isEmpty }
            let dayCode = dItu.count >= 2 ? dItu[0] : ""
            guard dayCode != "spur" else { continue }
            out.append(EibiEntry(freqKhz: Int(freq.rounded()),
                                 startMin: sh * 60 + sm, endMin: eh * 60 + em,
                                 dayCode: dayCode, name: name))
        }
        eibi = out.sorted { $0.freqKhz < $1.freqKhz }
    }

    // MARK: lookup

    /// The label the LCD and the status feed both show, or nil.
    static func lookup(freqHz: Double, region: Region, now: Date = Date()) -> String? {
        load()
        if let jp = lookupJp(freqHz: freqHz, region: region) { return format(jp) }
        if freqHz >= 16_000, freqHz <= 30_000_000,
           let e = lookupEibi(freqHz: freqHz, now: now) { return e.name }
        return nil
    }

    /// The bare broadcaster name, with no callsign or site annotation. What
    /// the preset importer wants: a stable key, not a display label.
    ///
    /// Deliberately **not** region-filtered, matching the plugin's importer.
    /// A bookmark is a station the user chose to keep, which is often exactly
    /// the out-of-region one they are DX-ing; filtering here would leave those
    /// under SDR++'s ASCII placeholder while every local station got its real
    /// name. Display lookup still filters — that one is about what is
    /// receivable here, which is a different question.
    static func rawName(freqHz: Double, region: Region? = nil) -> String? {
        load()
        return lookupJp(freqHz: freqHz, region: region)?.name
    }

    private static func format(_ s: JpStation) -> String {
        var name = s.name
        if name == "NHK" { name = s.band == "MW" ? "NHK第1" : "NHK-FM" }
        if let c = s.callsign { name = "\(name) \(c)" }
        if let site = s.siteName { return "\(name) (\(site))" }
        return name
    }

    private static func scan(_ list: [JpStation], _ freqHz: Double,
                             _ band: String, _ tol: Double) -> (JpStation, Double)? {
        var best: JpStation?
        var bestDelta = Double.greatestFiniteMagnitude
        for s in list where s.band == band {
            let d = abs(s.freqHz - freqHz)
            if d <= tol, d < bestDelta { best = s; bestDelta = d }
        }
        return best.map { ($0, bestDelta) }
    }

    private static func lookupJp(freqHz: Double, region: Region?) -> JpStation? {
        let band: String
        if freqHz >= 76_000_000, freqHz <= 108_000_000 { band = "FM" }
        else if freqHz >= 522_000, freqHz <= 1_710_000 { band = "MW" }
        else { return nil }
        let tol = band == "FM" ? fmTolerance : mwTolerance

        // Region filter. Entries with no region are kept: those are the
        // deliberately global ones. Treating hand-curated entries as always
        // global — the old rule — leaked 近畿 stations into 関東 lookups.
        let inRegion: (JpStation) -> Bool = { s in
            guard let region else { return true }
            return s.region == nil || s.region == region.rawValue
        }
        let m = scan(manual.filter(inRegion), freqHz, band, tol)
        let a = scan(auto.filter(inRegion), freqHz, band, tol)

        // A hand-curated entry wins a tie: those exist to override the
        // scraper's generic naming.
        var best: JpStation?
        if let m, let a { best = m.1 <= a.1 ? m.0 : a.0 }
        else { best = m?.0 ?? a?.0 }
        guard var b = best else { return nil }
        if b.callsign == nil, let region,
           let c = findCallsign(freqHz: freqHz, band: band, region: region) {
            b.callsign = c
        }
        return b
    }

    private static func findCallsign(freqHz: Double, band: String, region: Region) -> String? {
        let tol = band == "FM" ? fmTolerance : mwTolerance
        let prefs = region.prefectures
        var sameRegion: (String, Double)?
        var any: (String, Double)?
        for c in callsigns where c.band == band {
            let d = abs(c.freqHz - freqHz)
            guard d <= tol else { continue }
            if any == nil || d < any!.1 { any = (c.callsign, d) }
            if prefs.contains(where: { c.location.contains($0) }) {
                if sameRegion == nil || d < sameRegion!.1 { sameRegion = (c.callsign, d) }
            }
        }
        return (sameRegion ?? any)?.0
    }

    // MARK: EIBI

    private static func windowLength(_ e: EibiEntry) -> Int {
        var n = e.endMin - e.startMin
        if n <= 0 { n += 1440 }
        return n
    }

    private static func isActive(_ e: EibiEntry, _ nowMin: Int) -> Bool {
        e.startMin <= e.endMin ? (nowMin >= e.startMin && nowMin <= e.endMin)
                               : (nowMin >= e.startMin || nowMin <= e.endMin)
    }

    private static func lookupEibi(freqHz: Double, now: Date) -> EibiEntry? {
        guard !eibi.isEmpty else { return nil }
        let khz = Int((freqHz / 1000).rounded())
        var lo = 0, hi = eibi.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if eibi[mid].freqKhz < khz { lo = mid + 1 } else { hi = mid }
        }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.hour, .minute, .weekday, .day, .month], from: now)
        let nowMin = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        var matches: [EibiEntry] = []
        var i = lo
        while i < eibi.count, eibi[i].freqKhz == khz {
            if isActive(eibi[i], nowMin), dayMatches(eibi[i].dayCode, c) { matches.append(eibi[i]) }
            i += 1
        }
        // Shortest window first: a slot that runs all day is a weaker claim on
        // this minute than one that runs for thirty.
        return matches.min { windowLength($0) < windowLength($1) }
    }

    private static let dayCodes: [String: Int] = ["Su": 0, "Mo": 1, "Tu": 2, "We": 3,
                                                  "Th": 4, "Fr": 5, "Sa": 6]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// Unknown codes fail open: showing a station that might not be on beats
    /// blanking one that is.
    static func dayMatches(_ code: String, _ c: DateComponents) -> Bool {
        if code.isEmpty { return true }
        // Informational tags carry no day constraint.
        if ["irr", "spur", "tent", "alt", "Last7", "Tests", "Days"].contains(code) { return true }
        let dow = (c.weekday ?? 1) - 1        // Calendar: Sun = 1; EIBI table: Sun = 0

        let ch = Array(code)
        // "4May" — day of month plus month name.
        if ch.count >= 4, let d = Int(String(ch.prefix(while: { $0.isNumber }))), d > 0 {
            let rest = String(ch.drop(while: { $0.isNumber }))
            if rest.count == 3, let mi = months.firstIndex(of: rest) {
                return (c.day ?? 0) == d && (c.month ?? 0) == mi + 1
            }
        }
        // "1.Sa" — nth weekday of the month.
        if ch.count == 4, ch[1] == ".", let n = Int(String(ch[0])),
           let target = dayCodes[String(ch[2...3])] {
            guard dow == target else { return false }
            return ((c.day ?? 1) - 1) / 7 + 1 == n
        }
        // "Mo-Fr", including wrapping ranges like "We-Mo".
        if ch.count == 5, ch[2] == "-",
           let from = dayCodes[String(ch[0...1])], let to = dayCodes[String(ch[3...4])] {
            return from <= to ? (dow >= from && dow <= to) : (dow >= from || dow <= to)
        }
        if code.contains(",") {
            return code.split(separator: ",").contains { dayMatches(String($0), c) }
        }
        // "157" = Mon, Fri, Sun. EIBI digits are 1=Mon..7=Sun.
        if ch.allSatisfy({ $0.isNumber }) {
            for d in ch {
                guard let n = Int(String(d)) else { continue }
                let mapped = n == 7 ? 0 : n
                if n >= 1, n <= 7, mapped == dow { return true }
            }
            return false
        }
        // "SaSu" — concatenated pairs.
        if ch.count >= 4, ch.count % 2 == 0 {
            var i = 0
            while i < ch.count {
                if dayCodes[String(ch[i...i+1])] == dow { return true }
                i += 2
            }
            return false
        }
        if let d = dayCodes[code] { return d == dow }
        return true
    }
}
