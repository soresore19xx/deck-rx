// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-10-10-020000
// Presets and per-station gains kept in step with the plugin and the other
// devices through the hub on mini4: a port of src/syncCore.ts + syncClient.ts.
// ====================
import Foundation

/// The rules, as `src/syncCore.ts` states them; the tests on both sides run
/// the same cases. The local files are the cache: a sync compares them with
/// what the hub last confirmed, sends what differs, and folds in the answer.
/// An edit made while the hub is out of reach is still a difference next time.
enum SyncCore {
    /// A preset ({frequency, bandwidth, mode}) or a gain index.
    enum Value: Codable, Equatable {
        case num(Double)
        case obj([String: Double])

        init(from d: Decoder) throws {
            let c = try d.singleValueContainer()
            if let n = try? c.decode(Double.self) { self = .num(n); return }
            self = .obj(try c.decode([String: Double].self))
        }
        func encode(to e: Encoder) throws {
            var c = e.singleValueContainer()
            switch self {
            case .num(let n): try c.encode(n)
            case .obj(let o): try c.encode(o)
            }
        }
    }

    struct Record: Codable, Equatable {
        var c: String
        var k: String
        var v: Value?
        var t: Double
        var s: Int?

        private enum Keys: String, CodingKey { case c, k, v, t, s }
        // A deletion must go out as `"v": null`: the synthesized encoder would
        // leave the key out, and the hub turns a record without one away.
        func encode(to e: Encoder) throws {
            var x = e.container(keyedBy: Keys.self)
            try x.encode(c, forKey: .c)
            try x.encode(k, forKey: .k)
            if let v { try x.encode(v, forKey: .v) } else { try x.encodeNil(forKey: .v) }
            try x.encode(t, forKey: .t)
            try x.encodeIfPresent(s, forKey: .s)
        }
    }

    struct BaseEntry: Codable, Equatable { var v: Value?; var t: Double }
    typealias Snapshot = [String: [String: Value]]
    typealias Base = [String: [String: BaseEntry]]

    static let presets = "preset", gainAuto = "gainAuto", gainSaved = "gainSaved"

    /// This side's changes since the hub last confirmed (`diffLocal`).
    static func diff(local: Snapshot, base: Base, t: [String: Double], first: Bool) -> [Record] {
        var out: [Record] = []
        for c in Set(local.keys).union(base.keys).sorted() {
            let lc = local[c] ?? [:], bc = base[c] ?? [:]
            for k in Set(lc.keys).union(bc.keys).sorted() {
                let lv = lc[k], bv = bc[k]?.v
                if lv == bv { continue }
                out.append(Record(c: c, k: k, v: lv, t: first ? 0 : (t[c] ?? 0)))
            }
        }
        return out
    }

    /// Fold the hub's answer in (`applyRemote`); the collections that changed.
    @discardableResult
    static func apply(local: inout Snapshot, base: inout Base, remote: [Record]) -> Set<String> {
        var changed = Set<String>()
        for r in remote {
            base[r.c, default: [:]][r.k] = BaseEntry(v: r.v, t: r.t)
            if local[r.c]?[r.k] == r.v { continue }
            local[r.c, default: [:]][r.k] = r.v
            changed.insert(r.c)
        }
        return changed
    }

    /// `list::name` → {frequency, bandwidth, mode}.
    static func snapshot(of lists: [String: [String: PresetStore.Entry]]) -> [String: Value] {
        var out: [String: Value] = [:]
        for (list, entries) in lists {
            for (name, e) in entries {
                out["\(list)::\(name)"] = .obj(["frequency": e.frequency, "bandwidth": e.bandwidth,
                                                 "mode": Double(e.mode)])
            }
        }
        return out
    }

    /// Apply preset records onto `lists`.
    static func applyPresets(_ remote: [Record], to lists: inout [String: [String: PresetStore.Entry]]) {
        for r in remote where r.c == presets {
            guard let sep = r.k.range(of: "::") else { continue }
            let list = String(r.k[..<sep.lowerBound]), name = String(r.k[sep.upperBound...])
            if case .obj(let o)? = r.v, let f = o["frequency"] {
                lists[list, default: [:]][name] = PresetStore.Entry(
                    frequency: f, bandwidth: o["bandwidth"] ?? 0, mode: Int(o["mode"] ?? 1))
            } else {
                lists[list]?[name] = nil
            }
        }
    }
}

/// The app's side of sync, on a timer. `onChange` runs on the main thread
/// when another device's change has been written into the local files.
final class SyncClient {
    static let shared = SyncClient()

    var onPresetsChanged: (() -> Void)?
    /// mini4 on the Macs' segment, then on the iPad's.
    private let hubs: [String] = {
        if let e = ProcessInfo.processInfo.environment["DECK_RX_SYNC_HUBS"] {
            return e.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return ["http://192.168.0.51:8772", "http://192.168.1.51:8772"]
    }()
    private let queue = DispatchQueue(label: "deck-rx.sync", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var running = false
    private var lastHub: String?
    private(set) var lastResult = "not yet"

    private struct State: Codable { var seq: Int; var base: SyncCore.Base }

    private var statePath: String {
        if let p = ProcessInfo.processInfo.environment["DECK_RX_SYNC_STATE"], !p.isEmpty { return p }
        return Plat.appSupport.appendingPathComponent("deck-rx/sync-state.json").path
    }

    /// Every 30 s from now, the first after 2 s. Again on a later call only
    /// restarts the timer (the iPad calls this on becoming active).
    func start() {
        guard !hubs.isEmpty else { NSLog("[sync] no hub configured — sync disabled"); return }
        queue.async {
            self.timer?.cancel()
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + 2, repeating: 30)
            t.setEventHandler { [weak self] in self?.syncOnce() }
            t.resume()
            self.timer = t
        }
    }

    /// The iPad stops while in the background; what changed meanwhile goes
    /// up on the next start.
    func stop() {
        queue.async { self.timer?.cancel(); self.timer = nil }
    }

    private func loadState() -> State {
        if let d = FileManager.default.contents(atPath: statePath),
           let s = try? JSONDecoder().decode(State.self, from: d) { return s }
        return State(seq: 0, base: [:])
    }

    private static func mtimeMs(_ path: String) -> Double {
        let a = try? FileManager.default.attributesOfItem(atPath: path)
        return ((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    }

    private struct Answer: Codable { var seq: Int; var records: [SyncCore.Record] }
    private struct Request: Codable { var since: Int; var records: [SyncCore.Record]; var who: String }

    private func post(_ hub: String, _ req: Request) -> Answer? {
        guard let url = URL(string: "\(hub)/sync"), let body = try? JSONEncoder().encode(req) else { return nil }
        var r = URLRequest(url: url, timeoutInterval: 5)
        r.httpMethod = "POST"
        r.httpBody = body
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let sem = DispatchSemaphore(value: 0)
        var out: Answer?
        URLSession.shared.dataTask(with: r) { data, resp, _ in
            defer { sem.signal() }
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data else { return }
            out = try? JSONDecoder().decode(Answer.self, from: data)
        }.resume()
        _ = sem.wait(timeout: .now() + 7)
        return out
    }

    /// One round, on `queue`.
    private func syncOnce() {
        guard !running else { return }
        running = true
        defer { running = false }
        var state = loadState()
        let gm = GainMemory.shared
        let maps = gm.maps()
        var local: SyncCore.Snapshot = [
            SyncCore.presets: SyncCore.snapshot(of: PresetStore.load()),
            SyncCore.gainAuto: maps.gains.mapValues { .num(Double($0)) },
            SyncCore.gainSaved: maps.saved.mapValues { .num(Double($0)) },
        ]
        let first = state.seq == 0 && state.base.isEmpty
        let t = [SyncCore.presets: Self.mtimeMs(PresetStore.storePath),
                 SyncCore.gainAuto: gm.mtimeMs, SyncCore.gainSaved: gm.mtimeMs]
        let recs = SyncCore.diff(local: local, base: state.base, t: t, first: first)
#if os(iOS)
        let who = "ipad"
#else
        let who = "solo"
#endif
        let order = lastHub.map { h in [h] + hubs.filter { $0 != h } } ?? hubs
        var answer: Answer?
        for hub in order {
            if let a = post(hub, Request(since: state.seq, records: recs, who: who)) {
                answer = a; lastHub = hub; break
            }
        }
        guard let answer else {
            if lastResult != "offline" { NSLog("[sync] hub out of reach, working from the local files") }
            lastResult = "offline"
            return
        }
        let changed = SyncCore.apply(local: &local, base: &state.base, remote: answer.records)
        if changed.contains(SyncCore.presets) {
            // Re-read just before writing: only the keys the hub sent change.
            var lists = PresetStore.load()
            SyncCore.applyPresets(answer.records, to: &lists)
            try? PresetStore.save(lists)
            DispatchQueue.main.async { self.onPresetsChanged?() }
        }
        if changed.contains(SyncCore.gainAuto) || changed.contains(SyncCore.gainSaved) {
            var g: [String: Int?] = [:], s: [String: Int?] = [:]
            for r in answer.records {
                var v: Int? = nil
                if case .num(let n)? = r.v { v = Int(n) }
                if r.c == SyncCore.gainAuto { g[r.k] = .some(v) }
                if r.c == SyncCore.gainSaved { s[r.k] = .some(v) }
            }
            gm.apply(gains: g, saved: s)
        }
        state.seq = answer.seq
        if let d = try? JSONEncoder().encode(state) {
            try? d.write(to: URL(fileURLWithPath: statePath), options: .atomic)
        }
        if !recs.isEmpty || !changed.isEmpty || lastResult != "synced" {
            NSLog("[sync] \(lastHub ?? ""): sent \(recs.count), took in \(changed.sorted().joined(separator: ",")) (seq \(answer.seq))")
        }
        lastResult = "synced"
    }
}
