import Foundation
import Network

/// Serves the three interfaces the plugin's own core serves, so a front-end can
/// talk to this app exactly as it talks to the plugin: the loopback control
/// endpoint, the status feed file, and the spectrum socket.
///
/// This is what inverts the dependency. The app already consumes these when the
/// plugin is running; producing them is what lets the deck — and `knobctl`,
/// which has spoken this protocol since it was written — drive the app instead.
///
/// **Only one process can own these at a time.** Every binding is attempted and
/// allowed to fail: with the plugin running it owns them, and this stays quiet
/// rather than fighting over a port. `isServing` says which way round it ended
/// up, and it is checked, not assumed.
final class AppServer {

    private let radio: LocalRadio
    private var listener: NWListener?
    private var spectrumFd: Int32 = -1
    private var spectrumSource: DispatchSourceRead?
    private var spectrumClients: [Int32] = []
    private var statusTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "deck-rx.appserver")

    private(set) var isServing = false
    private(set) var lastError: String?

    /// Set when the control port is already taken — which means the plugin is
    /// up. Not an error: it is the normal state on this machine.
    private(set) var portBusy = false

    var onStateChange: (() -> Void)?

    private let controlPort: UInt16
    private let spectrumPath: String
    private let statusPath: String

    init(radio: LocalRadio,
         controlPort: UInt16 = 8771,
         spectrumPath: String = "/tmp/deck-rx-spectrum.sock",
         statusPath: String = Receiver.statusPath) {
        self.radio = radio
        self.controlPort = controlPort
        self.spectrumPath = spectrumPath
        self.statusPath = statusPath
    }

    // MARK: lifecycle

    func start() {
        startControl()
        startSpectrum()
        startStatus()
    }

    func stop() {
        listener?.cancel(); listener = nil
        statusTimer?.cancel(); statusTimer = nil
        spectrumSource?.cancel(); spectrumSource = nil
        for c in spectrumClients { close(c) }
        spectrumClients.removeAll()
        if spectrumFd >= 0 { close(spectrumFd); spectrumFd = -1 }
        unlink(spectrumPath)
        isServing = false
        DispatchQueue.main.async { self.onStateChange?() }
    }

    // MARK: control endpoint

    private func startControl() {
        guard let port = NWEndpoint.Port(rawValue: controlPort) else { return }
        // Listens on every interface, deliberately. requiredInterfaceType was
        // set here once and had no effect anyway — the socket came up on
        // *:8771 regardless — but the reachable version is the useful one:
        // another machine can drive this receiver over the LAN, which is the
        // whole point of an app that copies between Macs.
        let params = NWParameters.tcp
        // Deliberately not reusing the address. If something else holds this
        // port it is the plugin, and quietly sharing it would give two
        // receivers answering the same requests at random.
        guard let l = try? NWListener(using: params, on: port) else {
            portBusy = true
            lastError = "control port \(controlPort) busy"
            return
        }
        l.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        l.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.isServing = true
                DispatchQueue.main.async { self.onStateChange?() }
            case .failed(let e):
                self.portBusy = true
                self.lastError = e.localizedDescription
                self.listener = nil
                DispatchQueue.main.async { self.onStateChange?() }
            default: break
            }
        }
        listener = l
        l.start(queue: queue)
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let head = String(data: data, encoding: .utf8) else {
                conn.cancel(); return
            }
            let line = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
            let parts = line.split(separator: " ")
            guard parts.count >= 2 else { conn.cancel(); return }
            let (status, body) = self.handle(String(parts[1]))
            let resp = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\n"
                + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    /// The plugin's paths and semantics, including the ones that exist for a
    /// reason worth keeping: `/preset` answers 409 when there is nothing to
    /// land on, so a dead control path cannot be mistaken for a working one.
    private func handle(_ target: String) -> (String, String) {
        let comps = URLComponents(string: "http://x" + target)
        let path = comps?.path ?? target
        var q: [String: String] = [:]
        for item in comps?.queryItems ?? [] { q[item.name] = item.value }

        func ok(_ extra: String = "") -> (String, String) {
            ("200 OK", extra.isEmpty ? "{\"ok\":true}" : "{\"ok\":true,\(extra)}")
        }
        func bad(_ why: String) -> (String, String) {
            ("400 Bad Request", "{\"ok\":false,\"error\":\"\(why)\"}")
        }

        switch path {
        case "/health":
            // Enough to diagnose a receiver that came up but is not receiving,
            // without needing the window in front of you. A machine nobody sits
            // at has no other way to say what went wrong.
            let err = radio.lastError.map { "\"\($0)\"" } ?? "null"
            return ok("\"receiver\":\"native-app\",\"connected\":\(radio.isConnected)"
                + ",\"host\":\"\(radio.config.host)\",\"port\":\(radio.config.port)"
                + ",\"autoDirect\":\(radio.config.autoDirect)"
                + ",\"autoAudio\":\(radio.config.autoAudio)"
                + ",\"audio\":\(radio.audioEnabled)"
                + ",\"iqRateHz\":\(radio.iqRate)"
                + ",\"canControl\":\(radio.canControl)"
                + ",\"deviceFreqHz\":\(radio.deviceFreq)"
                + ",\"stereo\":\(radio.stereoLocked)"
                + ",\"pilot\":\(String(format: "%.6f", radio.pilotMetric))"
                + ",\"lastError\":\(err)")

        case "/tune":
            // 409 rather than a silent 200: a caller that cannot steer the
            // device has to be able to tell that from one that can.
            guard radio.canControl else {
                return ("409 Conflict",
                        "{\"ok\":false,\"error\":\"another client owns the device\""
                        + ",\"deviceFreqHz\":\(radio.deviceFreq)}")
            }
            if let hz = q["hz"].flatMap(Double.init) {
                radio.setFrequency(UInt32(max(0, hz)))
                return ok("\"freqHz\":\(Int(hz))")
            }
            if let t = q["ticks"].flatMap(Int.init) {
                radio.tune(ticks: t)
                return ok("\"freqHz\":\(radio.frequency)")
            }
            return bad("need hz or ticks")

        case "/volume":
            if let v = q["v"].flatMap(Double.init) {
                radio.volume = min(max(v, 0), 1)
            } else if let d = q["d"].flatMap(Int.init) {
                radio.volume = min(max(radio.volume + Double(d) * 0.05, 0), 1)
            } else {
                return bad("need v or d")
            }
            return ok("\"volume\":\(radio.volume)")

        case "/mute":
            radio.muted.toggle()
            return ok("\"muted\":\(radio.muted)")

        case "/power":
            if radio.isConnected { radio.disconnect() } else { radio.connect() }
            return ok("\"enabled\":\(radio.isConnected)")

        case "/mode":
            guard let m = q["m"].flatMap(Int.init) else { return bad("need m") }
            radio.mode = m
            return ok("\"mode\":\(m)")

        case "/preset":
            guard let d = q["d"].flatMap(Int.init), d != 0 else { return bad("need d") }
            guard let landed = radio.stepPreset(d > 0 ? 1 : -1) else {
                // 409, not a silent 200. A control path with nothing to land on
                // must not look identical to a working one from the far side.
                return ("409 Conflict", "{\"ok\":false,\"error\":\"no receivable preset\"}")
            }
            return ok("\"freqHz\":\(landed)")

        case "/step":
            if let hz = q["hz"].flatMap(Double.init), hz > 0 {
                radio.config.tuneStepByMode[String(radio.mode)] = hz
                radio.config.save()
            }
            return ok("\"tuneStepHz\":\(Int(radio.tuneStepHz))")

        case "/options":
            // The demod's own settings, mode-scoped and flat — fm.stereo,
            // am.sync, ssb.bandwidth, gain — because a checkbox changes exactly
            // one of them and a GET anyone can type beats a tidy document.
            if let set = q["set"], let raw = q["value"] {
                if !applyOption(set, raw) { return bad("unknown option \(set)") }
            }
            return ("200 OK", optionsJSON())

        case "/receiver":
            // Receiver-wide settings, including the server address. Without
            // this the window can drive the radio but not configure it, and on
            // a machine with no plugin there is nowhere else to set the host.
            if q["action"] == "importSdrpp" {
                guard let r = try? PresetStore.importFromSdrpp() else {
                    return ("500 Internal Server Error", "{\"ok\":false,\"error\":\"import failed\"}")
                }
                return ("200 OK", "{\"added\":\(r.added),\"skipped\":\(r.skipped)"
                    + ",\"migrated\":\(r.migrated),\"lists\":\(r.lists)}")
            }
            if let set = q["set"], let raw = q["value"] {
                if !applyReceiver(set, raw) { return bad("unknown setting \(set)") }
            }
            return ("200 OK", receiverJSON())

        case "/stations":
            // Names for the frequencies a front-end is about to label on its
            // spectrum, resolved through the same lookup that names the station
            // above the readout, so the two can never disagree.
            return ("200 OK", stationsJSON(from: q["from"].flatMap(Double.init),
                                           to: q["to"].flatMap(Double.init)))

        default:
            return ("404 Not Found", "{\"ok\":false,\"error\":\"unknown path\"}")
        }
    }

    // MARK: settings

    private func json(_ o: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    private func optionsJSON() -> String {
        let c = radio.config
        return json([
            "mode": radio.mode,
            "fm": ["bandwidth": c.fmBandwidthHz, "deemphasis": c.fmDeemphasis,
                   "ifnr": c.fmIfnr, "highPass": c.fmHighPass, "lowPass": c.fmLowPass,
                   "stereo": c.fmStereo],
            "am": ["bandwidth": c.amBandwidthHz, "carrierAgc": c.amCarrierAgc,
                   "agcAttack": c.amAgcAttack, "agcDecay": c.amAgcDecay, "sync": c.amSync],
            "ssb": ["bandwidthHz": c.ssbBandwidthHz, "bfoPitchHz": c.cwBfoHz],
            // One gain here, reported under both keys: the plugin keeps a
            // separate AM and FM gain because its dial does. This receiver has
            // one, and claiming two would let the panel show a value that
            // nothing reads.
            "gain": ["am": Int(c.gain), "fm": Int(c.gain),
                     "max": Int(radio.deviceInfo?.maxGainIndex ?? 8)],
        ])
    }

    private func receiverJSON() -> String {
        let c = radio.config
        return json([
            "tuneMode": c.tuneMode,
            "jpRegion": c.jpRegion,
            "regions": StationLabel.Region.allCases.map(\.rawValue),
            "autoSyncSdrpp": c.autoSyncSdrpp,
            "audioDevice": c.audioDevice,
            "audioDevices": AudioSink.outputDeviceNames(),
            // The icecast path is the plugin's; this receiver only has a local
            // sink, so it says so rather than offering a mode it cannot enter.
            "audioSink": "local",
            "host": c.host,
            "port": c.port,
        ])
    }

    private func stationsJSON(from: Double?, to: Double?) -> String {
        let region = StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto
        let list = Receiver.presets()
            .filter { (from == nil || $0.freq >= from!) && (to == nil || $0.freq <= to!) }
            .map { p -> [String: Any] in
                ["freq": p.freq,
                 "name": StationLabel.lookup(freqHz: p.freq, region: region) ?? p.name]
            }
        return json(["stations": list])
    }

    /// Returns false for a name it does not know, so the caller answers 400
    /// rather than reporting success for a setting that went nowhere.
    private func applyOption(_ name: String, _ raw: String) -> Bool {
        let b = raw == "1" || raw == "true"
        let n = Double(raw) ?? 0
        var c = radio.config
        switch name {
        case "fm.bandwidth":   c.fmBandwidthHz = n
        case "fm.deemphasis":  c.fmDeemphasis = raw
        case "fm.ifnr":        c.fmIfnr = b; radio.iqNrEnabled = b
        case "fm.highPass":    c.fmHighPass = b
        case "fm.lowPass":     c.fmLowPass = b
        case "fm.stereo":      c.fmStereo = b
        case "am.bandwidth":   c.amBandwidthHz = n
        case "am.carrierAgc":  c.amCarrierAgc = b
        case "am.agcAttack":   c.amAgcAttack = n
        case "am.agcDecay":    c.amAgcDecay = n
        case "am.sync":        c.amSync = b
        case "ssb.bandwidth", "ssb.bandwidthHz": c.ssbBandwidthHz = n
        case "ssb.bfo", "ssb.bfoPitchHz":        c.cwBfoHz = n
        case "gain":           c.gain = UInt32(max(0, min(n, 64)))
        default: return false
        }
        c.save()
        radio.config = c
        return true
    }

    private func applyReceiver(_ name: String, _ raw: String) -> Bool {
        var c = radio.config
        switch name {
        case "tuneMode":      c.tuneMode = raw
        case "jpRegion":      c.jpRegion = raw
        case "autoSyncSdrpp": c.autoSyncSdrpp = (raw == "1" || raw == "true")
        case "audioDevice":   c.audioDevice = raw
        case "uiScale":
            guard UI.names.contains(raw) else { return false }
            c.uiScale = raw
        case "host":
            let h = raw.trimmingCharacters(in: .whitespaces)
            guard !h.isEmpty else { return false }
            c.host = h
        case "port":
            guard let p = Int(raw), p > 0, p < 65536 else { return false }
            c.port = p
        default: return false
        }
        c.save()
        radio.config = c
        // The address only takes effect on the next connection, so dial it now
        // — otherwise the field accepts a new host and nothing happens.
        if name == "host" || name == "port", radio.isConnected {
            radio.disconnect()
            radio.connect()
        }
        return true
    }

    // MARK: status feed

    /// 4 Hz, the rate the plugin publishes at, so a reader's freshness window
    /// means the same thing whichever receiver is behind it.
    private func startStatus() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 0.25)
        t.setEventHandler { [weak self] in self?.writeStatus() }
        statusTimer = t
        t.resume()
    }

    private func writeStatus() {
        guard isServing else { return }   // the plugin owns the feed otherwise
        let live = radio.isConnected
        let name = StationLabel.lookup(freqHz: Double(radio.frequency),
                                       region: StationLabel.Region(rawValue: radio.config.jpRegion) ?? .kanto)
        var o: [String: Any] = [
            "ts": Date().timeIntervalSince1970 * 1000,
            "connected": radio.isConnected,
            "enabled": radio.isConnected,
            "audio": radio.audioEnabled,
            "freqHz": Double(radio.frequency),
            "mode": radio.mode,
            "volume": radio.volume,
            "muted": radio.muted,
            "station": name ?? "",
            "bandwidthHz": radio.bandwidthHz,
            "stereo": live && radio.isStereoMode && radio.stereoLocked,
            "tuneStepHz": radio.tuneStepHz,
            "device": radio.deviceInfo.map { "SpyServer type \($0.deviceType)" } ?? "",
            "iqRateHz": Double(radio.iqRate),
            "audioSink": radio.audioEnabled ? "local" : "off",
            "host": radio.config.host,
            "port": radio.config.port,
            "canControl": radio.canControl,
            "uiScale": radio.config.uiScale,
            "uiScales": UI.names,
        ]
        // Null rather than a stale number when nothing is live — the same
        // choice the plugin makes, and the reason its meters blank instead of
        // freezing at the last value.
        o["rssiDbfs"] = live ? radio.rssiDbfs : NSNull()
        o["snrDb"] = live ? radio.snrDb : NSNull()
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        let tmp = statusPath + ".tmp"
        try? d.write(to: URL(fileURLWithPath: tmp), options: .atomic)
        _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: statusPath),
                                                   withItemAt: URL(fileURLWithPath: tmp))
    }

    // MARK: spectrum socket

    /// Wire format is the plugin's: 24-byte header ('DRXS', version 1, bin
    /// count, IQ rate, centre frequency, sequence) then binCount float32.
    private static let magic: UInt32 = 0x53585244

    private func startSpectrum() {
        guard isServingCandidate else { return }
        // sun_path is 104 bytes and bind fails silently past it. Say so rather
        // than leaving a reader to wonder why nothing ever connects.
        let maxPath = MemoryLayout<sockaddr_un>.size - MemoryLayout<sa_family_t>.size
        guard spectrumPath.utf8.count < maxPath else {
            lastError = "spectrum path too long (\(spectrumPath.utf8.count) >= \(maxPath))"
            return
        }
        unlink(spectrumPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { lastError = "spectrum socket(): errno \(errno)"; return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        // Build the path bytes separately: writing into sun_path while also
        // reading its size through the same struct is an exclusivity violation.
        var pathBytes = Array(spectrumPath.utf8.prefix(cap - 1)).map { CChar($0) }
        pathBytes.append(0)
        withUnsafeMutablePointer(to: &addr.sun_path) { p in
            p.withMemoryRebound(to: CChar.self, capacity: cap) { dst in
                for (i, c) in pathBytes.enumerated() { dst[i] = c }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) }
        }
        guard bound == 0 else { lastError = "spectrum bind: errno \(errno)"; close(fd); return }
        guard listen(fd, 4) == 0 else { lastError = "spectrum listen: errno \(errno)"; close(fd); return }
        spectrumFd = fd
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let c = accept(self.spectrumFd, nil, nil)
            if c >= 0 { self.spectrumClients.append(c) }
        }
        spectrumSource = src
        src.resume()
    }

    /// The control listener decides who owns the interfaces; the socket follows
    /// it so the two can never end up split between processes.
    private var isServingCandidate: Bool { !portBusy }

    /// Called from the radio's frame callback. Drops for a reader that has
    /// fallen behind rather than queueing: a late spectrum frame is worthless.
    func publish(_ frame: SpectrumFeed.Frame) {
        queue.async {
            guard !self.spectrumClients.isEmpty else { return }
            var buf = Data(capacity: 24 + frame.bins.count * 4)
            func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { buf.append(contentsOf: $0) } }
            put32(Self.magic)
            buf.append(1); buf.append(0); buf.append(0); buf.append(0)   // version, flags
            put32(UInt32(frame.bins.count))
            put32(frame.iqRate)
            put32(frame.centerFreq)
            put32(frame.seq)
            frame.bins.withUnsafeBufferPointer { p in
                buf.append(UnsafeRawBufferPointer(p).bindMemory(to: UInt8.self))
            }
            var dead: [Int32] = []
            buf.withUnsafeBytes { raw in
                for c in self.spectrumClients {
                    let n = send(c, raw.baseAddress, raw.count, Int32(MSG_DONTWAIT))
                    if n < 0 && errno != EAGAIN && errno != EWOULDBLOCK { dead.append(c) }
                }
            }
            for c in dead {
                close(c)
                self.spectrumClients.removeAll { $0 == c }
            }
        }
    }
}
