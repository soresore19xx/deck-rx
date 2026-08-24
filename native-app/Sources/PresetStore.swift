import Foundation

/// The deck-rx-owned preset store, and the SDR++ import that fills it.
///
/// Port of `src/presets.ts`. Two rules come across with it and neither is
/// negotiable:
///
///   * **SDR++'s `frequency_manager_config.json` is read-only.** Its parser is
///     strict — indent 4, float bandwidths, ASCII or Latin-1 names — and any
///     in-place rewrite, a plain JSON round-trip included, breaks SDR++ on its
///     next launch.
///   * **The deck-rx store is UTF-8 clean**, which is why it exists separately:
///     Japanese broadcaster names round-trip here and would not there.
enum PresetStore {

    struct Entry: Codable {
        var frequency: Double
        var bandwidth: Double
        var mode: Int
    }

    struct ImportResult {
        var added = 0
        var skipped = 0
        var migrated = 0
        var lists = 0
    }

    static var storePath: String { Receiver.presetsPath }

    /// Where SDR++ keeps its bookmarks. Only ever read, never written — see
    /// CLAUDE.md. On iOS there is no SDR++ to read from and the path resolves
    /// to a container file that does not exist; the importer reports "no such
    /// file" the same way it does on a Mac without SDR++ installed.
    static var sdrppPath: String {
        Plat.appSupport
            .appendingPathComponent("sdrpp/frequency_manager_config.json")
            .path
    }

    // MARK: load / save

    /// Missing or unreadable returns empty rather than throwing: a machine with
    /// no presets yet is the normal first run, not a failure.
    static func load(path: String? = nil) -> [String: [String: Entry]] {
        guard let d = FileManager.default.contents(atPath: path ?? storePath),
              let root = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let lists = root["lists"] as? [String: Any] else { return [:] }
        var out: [String: [String: Entry]] = [:]
        for (listName, listAny) in lists {
            guard let list = listAny as? [String: Any],
                  let bms = list["bookmarks"] as? [String: Any] else { continue }
            var entries: [String: Entry] = [:]
            for (name, e) in bms {
                guard let d = e as? [String: Any],
                      let f = num(d["frequency"]) else { continue }
                entries[name] = Entry(frequency: f,
                                      bandwidth: num(d["bandwidth"]) ?? 0,
                                      mode: d["mode"] as? Int ?? 1)
            }
            out[listName] = entries
        }
        return out
    }

    private static func num(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    static func save(_ lists: [String: [String: Entry]], path: String? = nil) throws {
        var root: [String: Any] = [:]
        var out: [String: Any] = [:]
        for (listName, entries) in lists {
            var bms: [String: Any] = [:]
            for (name, e) in entries {
                bms[name] = ["frequency": e.frequency, "bandwidth": e.bandwidth, "mode": e.mode]
            }
            out[listName] = ["bookmarks": bms]
        }
        root["lists"] = out
        let d = try JSONSerialization.data(withJSONObject: root,
                                           options: [.prettyPrinted, .sortedKeys])
        try d.write(to: URL(fileURLWithPath: path ?? storePath), options: .atomic)
    }

    // MARK: import

    private static func isAscii(_ s: String) -> Bool { s.allSatisfy { $0.isASCII } }

    /// Collapses entries that share a frequency. Identity is the frequency, not
    /// the name: the same station arriving twice under two spellings is one
    /// station. The JP DB's name wins when it knows the frequency; failing
    /// that, a non-ASCII name beats an ASCII one, because the ASCII one is the
    /// SDR++ placeholder.
    static func dedupeByFrequency(_ bookmarks: [String: Entry]) -> ([String: Entry], Int) {
        var byFreq: [Int: [(String, Entry)]] = [:]
        for (name, e) in bookmarks {
            byFreq[Int(e.frequency.rounded()), default: []].append((name, e))
        }
        var result: [String: Entry] = [:]
        var removed = 0
        for (freq, entries) in byFreq {
            if entries.count == 1 {
                result[entries[0].0] = entries[0].1
                continue
            }
            let jp = StationLabel.rawName(freqHz: Double(freq))
            var pick: (String, Entry)
            if let jp {
                pick = entries.first { $0.0 == jp } ?? (jp, entries[0].1)
            } else {
                pick = entries.first { !isAscii($0.0) } ?? entries[0]
            }
            result[pick.0] = pick.1
            removed += entries.count - 1
        }
        return (result, removed)
    }

    /// Merges SDR++'s bookmarks into the deck-rx store. Never writes to SDR++.
    /// The region is not a parameter: naming here is region-less on purpose,
    /// so a bookmarked out-of-region station keeps its real name.
    static func importFromSdrpp(sdrPath: String? = nil,
                                storePath: String? = nil) throws -> ImportResult {
        let src = load(path: sdrPath ?? Self.sdrppPath)
        var dst = load(path: storePath)
        var r = ImportResult()

        for (listName, srcEntries) in src {
            let isNewList = dst[listName] == nil
            var dstEntries = dst[listName] ?? [:]
            let (cleaned, removed) = dedupeByFrequency(dstEntries)
            dstEntries = cleaned
            r.migrated += removed
            var changed = removed > 0

            var existingByFreq: [Int: String] = [:]
            for (n, e) in dstEntries { existingByFreq[Int(e.frequency.rounded())] = n }

            // Sorted by frequency, not by whatever order the JSON happened to
            // be in. The plugin iterates file order, which decides an outcome
            // it should not: a simulcast broadcaster is one name at two
            // frequencies (NHK at 594 kHz and 82.5 MHz), the store is
            // name-keyed, so whichever is seen first wins and the other is
            // dropped. That made the result depend on the order SDR++ happened
            // to write its file. Ascending frequency keeps the MW entry, which
            // is the one whose name came from the MW table.
            for (bmName, bm) in srcEntries.sorted(by: { $0.value.frequency < $1.value.frequency }) {
                let freq = Int(bm.frequency.rounded())
                // Replace SDR++'s ASCII placeholder with the JP DB's broadcaster
                // name where one exists. Shortwave and unknown frequencies keep
                // the SDR++ name.
                let finalName = StationLabel.rawName(freqHz: Double(freq)) ?? bmName
                // Frequency is identity, so a frequency already present is a
                // skip regardless of what it is called.
                if existingByFreq[freq] != nil { r.skipped += 1; continue }
                // A different frequency already under this name is also a skip:
                // the store is name-keyed, so adding would overwrite whatever
                // the user put there by hand.
                if dstEntries[finalName] != nil { r.skipped += 1; continue }
                dstEntries[finalName] = Entry(frequency: Double(freq),
                                              bandwidth: bm.bandwidth, mode: bm.mode)
                existingByFreq[freq] = finalName
                r.added += 1
                changed = true
            }
            if isNewList && changed { r.lists += 1 }
            dst[listName] = dstEntries
        }
        try save(dst, path: storePath)
        return r
    }
}
