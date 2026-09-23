import Foundation
import Network

/// rtl_tcp client, presented to LocalRadio as an `IQSource`.
///
/// Ported from `src/RtlTcpClient.ts`, rule for rule. The two share their tests'
/// numbers (test/rtlTcp.test.ts and Tests/RtlTcpTests.swift) rather than code;
/// a change on one side has to land on the other.
///
/// Why this exists next to SpyClient: SpyServer's RTL-SDR support is thin. It
/// never calls rtlsdr_set_tuner_gain_mode or rtlsdr_set_agc_mode (neither
/// symbol is in the binary), so on the RTL-SDR Blog V4 the gain control did
/// nothing at all — measured 2026-09-22, index 0/4/8/16 gave the same spectrum.
/// rtl_tcp exposes the device's own controls, including gain by index, which
/// is what the profile has always stored.
///
/// Two things rtl_tcp does not have, and how they are covered here:
///
///   - **No device/sync messages.** The whole handshake is 12 bytes: "RTL0",
///     the tuner type and the number of gain steps. DeviceInfo and SyncInfo are
///     synthesised from that plus what is known about the hardware.
///
///   - **No server-side decimation.** SpyServer hands out an already-decimated
///     stream; rtl_tcp hands out whatever the RTL2832U is clocked at. The
///     requested IQ rate is met by asking the device for the lowest native rate
///     that is a power-of-two multiple of it, then halving the rest here.
///
/// Levels are kept interchangeable with the SpyServer path: 8-bit samples are
/// scaled to int16 and the same decimation digital gain SpyServer would have
/// applied is applied here, so a stored gain index sounds the same either way.
final class RtlTcpClient: IQSource {

    // MARK: wire constants

    static let headerSize = 12
    static let magic = "RTL0"

    static let cmdSetFreq: UInt8 = 0x01
    static let cmdSetSampleRate: UInt8 = 0x02
    static let cmdSetGainMode: UInt8 = 0x03
    static let cmdSetAgcMode: UInt8 = 0x08
    static let cmdSetTunerGainIndex: UInt8 = 0x0d

    /// Tuner type ids reported in the rtl_tcp header.
    static let tunerNames: [UInt32: String] = [
        0: "unknown", 1: "E4000", 2: "FC0012", 3: "FC0013",
        4: "FC2580", 5: "R820T", 6: "R828D",
    ]

    /// Base sample rate this client claims, so decimation maths matches SpyServer's.
    static let maxSampleRate: UInt32 = 2_400_000

    /// Default port for this protocol when the config carries none. Not rtl_tcp's
    /// own 1234: the V4 is served on 8890, next to the HF+'s 8888
    /// (`defaultPort` in src/iqClient.ts).
    static let defaultPort: UInt16 = RadioConfig.rtlTcpDefaultPort

    // MARK: rate planning

    /// The RTL2832U's two usable sample-rate windows. Anything between them or
    /// outside them is rejected by librtlsdr (or produces dropped samples).
    static func isValidRate(_ hz: Double) -> Bool {
        (hz >= 225_001 && hz <= 300_000) || (hz >= 900_001 && hz <= 3_200_000)
    }

    /// A native device rate for a requested IQ rate, plus the power-of-two
    /// decimation left to do here.
    ///
    /// The lowest rate in the *upper* window, not the lowest overall
    /// (`RTL_MIN_DEVICE_RATE` in src/RtlTcpClient.ts). rtl_tcp forwards
    /// librtlsdr's 256 KB buffers whole, so at 300 kS/s the stream came as one
    /// 0.44 s lurch every 0.44 s, and smoothing it cost every retune half a
    /// second (2026-09-24). At 1.2 MS/s the buffer is 0.11 s.
    static let minDeviceRate: Double = 900_001

    static func planRate(_ target: Double) -> (deviceRate: UInt32, decimation: Int) {
        if target >= 3_200_000 { return (3_200_000, 1) }
        var m = 1
        while m <= 64 {
            let rate = target * Double(m)
            if rate > 3_200_000 { break }
            if rate >= minDeviceRate && isValidRate(rate) { return (UInt32(rate), m) }
            m *= 2
        }
        // Nothing lands on a native rate (a target that is not a clean divisor
        // of one). Take the lowest window and decimate to the nearest whole
        // factor; the IQ rate is then approximate.
        let f = max(1, Int(pow(2, (log2(960_000 / target)).rounded())))
        return (960_000, f)
    }

    // MARK: IQSource

    var onDeviceInfo: ((SpyClient.DeviceInfo) -> Void)?
    var onIQ: ((SpyClient.IQPacket) -> Void)?
    var onSync: ((SpyClient.SyncInfo) -> Void)?
    var onDisconnect: (() -> Void)?
    var onError: ((Error) -> Void)?

    enum RtlError: Error, LocalizedError {
        case notRtlTcp(String)
        case connectTimeout(TimeInterval)

        var errorDescription: String? {
            switch self {
            case .notRtlTcp(let m):      return "not an rtl_tcp server (magic \"\(m)\")"
            case .connectTimeout(let s): return "TCP connect timeout (\(Int(s * 1000)) ms)"
            }
        }
    }

    // MARK: state — all of it on `queue`

    private let queue = DispatchQueue(label: "deck-rx.rtltcp")
    /// Tests drive the protocol without a queue or a socket; see `init`.
    private let inline: Bool
    private var conn: NWConnection?
    private var intentionalClose = false
    private var gotHeader = false
    private var buf = Data()

    /// Same dead-connection watchdog as SpyClient: rtl_tcp streams continuously
    /// once connected, so silence is unambiguous.
    private var lastRx = Date.distantPast
    private var watchdog: DispatchSourceTimer?
    private static let watchdogTimeout: TimeInterval = 5
    private static let watchdogInterval: TimeInterval = 1

    /// rtl_tcp has no "stop" command — it streams from the moment it accepts
    /// the socket until the socket closes. Streaming off means we stop
    /// forwarding.
    private var streaming = false
    private var streamedOnce = false

    private var info: SpyClient.DeviceInfo?
    private var decStage: UInt32 = 0
    private var digitalGainDb: Double = 0
    private var gainIndex: UInt32 = 0
    private var freqHz: UInt32 = 0
    private var deviceRate: UInt32 = 0
    private var decimation = 1
    private let decimator = HalvingDecimator()

    /// Samples that arrive before this are dropped. A sample-rate command takes
    /// effect at the server the moment it lands, but whatever was already in
    /// rtl_tcp's buffers and in flight on the socket is at the *old* rate —
    /// about 150 ms of it, measured going from 2.4 MS/s down to 300 kS/s.
    /// Handing that to the demodulator feeds it samples that mean a different
    /// span of time than it thinks, which is a burst of noise at every band
    /// change. There is no marker in the stream for where the new rate begins,
    /// so the only defence is to wait out the transit.
    private var flushUntil = Date.distantPast
    static let rateSettle: TimeInterval = 0.4
    private let rateSettleTime: TimeInterval

    /// Where commands go. The socket in normal use; a recorder in the tests.
    var send: ((Data) -> Void)?

    /// rtl_tcp does not stream, it lurches. It forwards whatever librtlsdr
    /// hands it, and librtlsdr hands over 256 KB at a time (the library's
    /// default buffer, which rtl_tcp has no option to change). At the 300 kS/s
    /// this receiver runs at that is one delivery every 0.44 s, each carrying
    /// 0.44 s of signal. SpyServer sends small messages continuously, and the
    /// spectrum and the audio sink downstream are built for that: fed in
    /// lurches, the trace updated twice a second and the audio ran dry between
    /// deliveries. Worse, handling a whole lurch in one go held up the socket,
    /// rtl_tcp queued what it could not send ("ll+, now N" in its log, 361 times
    /// in three hours on 2026-09-24), and at 19 it gave up on the client.
    ///
    /// So the socket side only converts and stores, and a timer releases the
    /// samples at the rate they represent — the stream SpyServer would have
    /// sent, at the cost of about one delivery's worth of latency.
    private let pacer = IQPacer()
    private var paceTimer: DispatchSourceTimer?
    private let pace: Bool
    static let paceInterval: TimeInterval = 0.010

    /// `inline` runs every entry point on the caller's thread instead of the
    /// client's queue, and hands IQ up as it is converted rather than paced.
    /// It exists for the tests, which drive `feed` and `setSetting` directly
    /// and look at the result on the next line; the pacer has its own tests.
    init(rateSettle: TimeInterval = RtlTcpClient.rateSettle, inline: Bool = false) {
        self.rateSettleTime = rateSettle
        self.inline = inline
        self.pace = !inline
    }

    private func onQueue(_ f: @escaping () -> Void) {
        if inline { f() } else { queue.async(execute: f) }
    }

    // MARK: connect / disconnect

    func open(host: String, port: UInt16, completion: @escaping (Result<Void, Error>) -> Void) {
        connect(host: host, port: port, completion: completion)
    }

    /// `completion` fires once, on the internal queue. The explicit timeout is
    /// SpyClient's reason: an unreachable host would otherwise block for the
    /// OS SYN-retry period and stall the reconnect loop that long.
    func connect(host: String, port: UInt16, timeout: TimeInterval = 5,
                 completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            intentionalClose = false
            gotHeader = false
            buf = Data()
            streaming = false
            streamedOnce = false
            // A fresh rtl_tcp session remembers nothing, so the rate has to be
            // sent again on the next stream start even if it has not changed.
            deviceRate = 0

            let params = NWParameters.tcp
            if let tcp = params.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
                tcp.enableKeepalive = true
                tcp.keepaliveIdle = 30
            }
            let c = NWConnection(host: NWEndpoint.Host(host),
                                 port: NWEndpoint.Port(rawValue: port)
                                     ?? NWEndpoint.Port(rawValue: Self.defaultPort)!,
                                 using: params)
            conn = c
            send = { [weak c] d in c?.send(content: d, completion: .idempotent) }

            var settled = false
            func settle(_ r: Result<Void, Error>) {
                guard !settled else { return }
                settled = true
                completion(r)
            }
            let deadline = DispatchWorkItem { [weak self] in
                guard !settled else { return }
                self?.conn?.cancel()
                self?.conn = nil
                settle(.failure(RtlError.connectTimeout(timeout)))
            }
            queue.asyncAfter(deadline: .now() + timeout, execute: deadline)

            c.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    deadline.cancel()
                    self.startWatchdog()
                    self.receiveLoop()
                    settle(.success(()))
                case .failed(let e):
                    deadline.cancel()
                    self.stopWatchdog()
                    self.conn = nil
                    if settled {
                        if !self.intentionalClose { self.onError?(e); self.onDisconnect?() }
                    } else {
                        settle(.failure(e))
                    }
                case .cancelled:
                    self.stopWatchdog()
                    if !self.intentionalClose { self.onDisconnect?() }
                default:
                    break
                }
            }
            c.start(queue: queue)
        }
    }

    func disconnect() {
        onQueue { [self] in
            intentionalClose = true
            streaming = false
            stopWatchdog()
            stopPacing()
            conn?.cancel()
            conn = nil
            send = nil
            buf = Data()
        }
    }

    // MARK: settings

    /// SpyServer's settings vocabulary, translated. Settings that have no
    /// rtl_tcp equivalent (IQ format, streaming mode) are accepted and ignored:
    /// the format is always 8-bit here and always converted to int16 on the way
    /// out.
    func setSetting(_ setting: SpyClient.Setting, _ value: UInt32) {
        onQueue { [self] in
            switch setting {
            case .iqDecimation:     decStage = value
            case .iqDigitalGain:    digitalGainDb = Double(value)
            case .iqFrequency:      applyFrequency(value)
            case .gain:             applyGain(value)
            case .streamingEnabled: if value != 0 { startStream() } else { streaming = false }
            default:                break
            }
        }
    }

    func setFrequency(_ hz: UInt32) { setSetting(.iqFrequency, hz) }

    func stopStreaming() { onQueue { [self] in streaming = false } }

    private func applyFrequency(_ hz: UInt32) {
        freqHz = hz
        // What is held was received on the old frequency; releasing it after
        // the retune would play the previous station for up to a second.
        pacer.clear()
        sendCmd(Self.cmdSetFreq, freqHz)
        emitSync()
    }

    private func applyGain(_ index: UInt32) {
        // UInt32 cannot go below zero; a negative index from the TS side
        // arrives here as a huge value and is clamped to the top, which is the
        // one place the two differ — and SpyClient.Setting takes UInt32 anyway.
        let top = info?.maxGainIndex ?? index
        gainIndex = min(top, index)
        // Order matters: librtlsdr ignores a gain until the tuner is out of
        // AGC. rtl_tcp's own `-g 0` startup flag means *automatic*, not 0.0 dB,
        // so a client that never sends these two is running on AGC unknowingly.
        sendCmd(Self.cmdSetGainMode, 1)
        sendCmd(Self.cmdSetAgcMode, 0)
        sendCmd(Self.cmdSetTunerGainIndex, gainIndex)
        emitSync()
    }

    private func startStream() {
        let target = (Double(Self.maxSampleRate) / pow(2, Double(decStage))).rounded()
        let plan = Self.planRate(target)
        if plan.deviceRate != deviceRate || plan.decimation != decimation {
            deviceRate = plan.deviceRate
            decimation = plan.decimation
            decimator.configure(deviceRate: Double(plan.deviceRate), factor: plan.decimation)
            sendCmd(Self.cmdSetSampleRate, plan.deviceRate)
            flushUntil = Date().addingTimeInterval(rateSettleTime)
        }
        // Re-assert frequency and gain: a reconnect gets a fresh rtl_tcp session
        // that remembers nothing, and LocalRadio sets them once per start.
        if freqHz > 0 { sendCmd(Self.cmdSetFreq, freqHz) }
        sendCmd(Self.cmdSetGainMode, 1)
        sendCmd(Self.cmdSetAgcMode, 0)
        sendCmd(Self.cmdSetTunerGainIndex, gainIndex)
        streaming = true
        streamedOnce = true
        pacer.clear()
        startPacing()
    }

    private func sendCmd(_ cmd: UInt8, _ param: UInt32) {
        var d = Data(capacity: 5)
        d.append(cmd)
        var be = param.bigEndian
        Swift.withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        send?(d)
    }

    // MARK: watchdog

    private func startWatchdog() {
        lastRx = Date()
        stopWatchdog()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
        t.setEventHandler { [weak self] in
            guard let self, self.streamedOnce else { return }   // nothing expected yet
            guard Date().timeIntervalSince(self.lastRx) > Self.watchdogTimeout else { return }
            self.stopWatchdog()
            self.conn?.cancel()
            self.conn = nil
            if !self.intentionalClose { self.onDisconnect?() }
        }
        watchdog = t
        t.resume()
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    // MARK: receive

    private func receiveLoop() {
        conn?.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.feed(data) }
            if let error {
                if !self.intentionalClose { self.onError?(error) }
                return
            }
            if isComplete {
                self.stopWatchdog()
                if !self.intentionalClose { self.onDisconnect?() }
                return
            }
            self.receiveLoop()
        }
    }

    /// One read's worth of bytes from the server. On `queue` (or inline).
    func feed(_ data: Data) {
        lastRx = Date()
        var chunk = data
        if !gotHeader {
            buf.append(chunk)
            guard buf.count >= Self.headerSize else { return }
            let hdr = Data(buf.prefix(Self.headerSize))
            chunk = Data(buf.dropFirst(Self.headerSize))
            buf = Data()
            gotHeader = true
            handleHeader(hdr)
            if chunk.isEmpty { return }
        }
        guard streaming else { return }
        emitIQ(chunk)
    }

    private func handleHeader(_ hdr: Data) {
        let magic = String(decoding: hdr.prefix(4), as: UTF8.self)
        guard magic == Self.magic else {
            onError?(RtlError.notRtlTcp(magic))
            return
        }
        let b = [UInt8](hdr)
        func be32(_ o: Int) -> UInt32 {
            UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3])
        }
        let gainCount = be32(8)
        let i = SpyClient.DeviceInfo(
            deviceType: SpyClient.DeviceType.rtlsdr.rawValue,
            // rtl_tcp does not carry a serial. Zero is what SpyServer reported
            // for this hardware too, so the per-receiver profile key
            // ("3:00000000") is the same through either client.
            deviceSerial: 0,
            maxSampleRate: Self.maxSampleRate,
            maxBandwidth: Self.maxSampleRate,
            // 2.4 MS/s down to 18.75 kS/s, matching what the planner can reach.
            decimationStages: 7,
            gainStages: gainCount,
            maxGainIndex: gainCount > 0 ? gainCount - 1 : 0,
            // The Blog V4 reaches the broadcast bands through its own
            // upconverter, so the floor is not the bare tuner's 24 MHz.
            minFrequency: 0,
            maxFrequency: 1_766_000_000,
            resolution: 8,
            minIQDecimation: 0,
            forcedIQFormat: 0)
        info = i
        onDeviceInfo?(i)
        emitSync()
    }

    private func emitSync() {
        guard let i = info else { return }
        // rtl_tcp gives every client full control of the device, and the last
        // command wins. There is no "another client owns this" state to report.
        onSync?(SpyClient.SyncInfo(
            canControl: true, gain: gainIndex,
            deviceCenterFreq: freqHz, iqCenterFreq: freqHz, fftCenterFreq: freqHz,
            minIQCenterFreq: i.minFrequency, maxIQCenterFreq: i.maxFrequency))
    }

    /// 8-bit unsigned IQ in, int16 IQ out, with the decimation digital gain
    /// SpyServer would have applied. rtl_tcp writes whole IQ pairs, but a TCP
    /// read can split one, so a trailing byte is carried into the next chunk.
    private func emitIQ(_ incoming: Data) {
        if Date() < flushUntil {
            // Still draining samples taken at the previous rate. Drop them, and
            // the half-pair carry with them, so the next real sample starts on I.
            buf = Data()
            return
        }
        var chunk = incoming
        if !buf.isEmpty {
            chunk = buf + chunk
            buf = Data()
        }
        let pairs = chunk.count >> 1
        if pairs == 0 { buf = chunk; return }
        if chunk.count & 1 != 0 {
            buf = Data(chunk.suffix(1))
            chunk = Data(chunk.prefix(chunk.count - 1))
        }
        let scale = 256 * pow(10, digitalGainDb / 20)
        var out = [Int16]()
        out.reserveCapacity((pairs / decimation + 2) * 2)
        func put(_ i: Double, _ q: Double) {
            out.append(Int16(max(-32768, min(32767, i.rounded()))))
            out.append(Int16(max(-32768, min(32767, q.rounded()))))
        }
        chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let p = raw.bindMemory(to: UInt8.self)
            if decimation == 1 {
                for n in 0..<pairs {
                    put((Double(p[n * 2]) - 127.5) * scale, (Double(p[n * 2 + 1]) - 127.5) * scale)
                }
            } else {
                for n in 0..<pairs {
                    decimator.process((Double(p[n * 2]) - 127.5) * scale,
                                      (Double(p[n * 2 + 1]) - 127.5) * scale, put)
                }
            }
        }
        guard !out.isEmpty else { return }
        let body = out.withUnsafeBufferPointer { ptr -> Data in
            // int16 little-endian, as SpyServer sends it. Apple platforms are
            // little-endian, so the in-memory layout is already the wire layout.
            Data(buffer: ptr)
        }
        if pace {
            pacer.push(out, now: ProcessInfo.processInfo.systemUptime)
            return
        }
        deliver(body)
    }

    /// SpyServer reports the gain the stream was produced at in the message
    /// header; rtl_tcp has no such field, so report what was asked for.
    private func deliver(_ body: Data) {
        onIQ?(SpyClient.IQPacket(format: .int16, body: body, gainDb: UInt16(truncatingIfNeeded: gainIndex)))
    }

    // MARK: pacing

    private func startPacing() {
        guard pace else { return }
        pacer.rate = Double(deviceRate) / Double(decimation)
        guard paceTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.paceInterval, repeating: Self.paceInterval,
                   leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in
            guard let self, self.streaming else { return }
            let s = self.pacer.take(now: ProcessInfo.processInfo.systemUptime)
            guard !s.isEmpty else { return }
            self.deliver(s.withUnsafeBufferPointer { Data(buffer: $0) })
        }
        paceTimer = t
        t.resume()
    }

    private func stopPacing() {
        paceTimer?.cancel()
        paceTimer = nil
        pacer.clear()
    }
}

/// Turns deliveries that arrive in lurches into a steady stream at the rate
/// they represent (see `RtlTcpClient.pacer`). Pure bookkeeping on interleaved
/// int16 IQ with the clock passed in, so it is tested without waiting.
///
/// Release starts once a prefill is held — the longest of the recent delivery
/// gaps and a quarter, so the next lurch lands before the store runs dry — and
/// goes back to prefilling if it does run dry. A store that grows past the
/// prefill plus a second (the device clock running faster than ours, or a
/// stall) is cut back to the prefill from the old end, so latency cannot creep.
///
/// Recent gaps, not the longest ever: the prefill is paid again on every
/// retune, and one stall remembered forever held it at the one-second cap —
/// every preset jump then took a second to be heard (2026-09-24).
final class IQPacer {
    /// IQ pairs per second to release.
    var rate: Double = 0
    private var store = [Int16]()
    private var head = 0
    private var releasing = false
    private var lastTake: TimeInterval?
    private var owed: Double = 0
    private var lastPush: TimeInterval?
    private var gaps = [TimeInterval]()
    private static let gapWindow = 16
    private(set) var underruns = 0
    private(set) var trims = 0

    /// Pairs held and not yet released.
    var held: Int { (store.count - head) / 2 }

    /// The longest of the last few delivery gaps.
    var maxGap: TimeInterval { gaps.max() ?? 0 }
    var prefill: TimeInterval { min(0.5, max(0.03, maxGap * 1.25)) }

    func push(_ iq: [Int16], now: TimeInterval) {
        if let last = lastPush {
            gaps.append(now - last)
            if gaps.count > Self.gapWindow { gaps.removeFirst() }
        }
        lastPush = now
        if head > 0 && head * 2 > store.count {
            store.removeFirst(head)
            head = 0
        }
        store.append(contentsOf: iq)
        let cap = Int((prefill + 1.0) * rate)
        if rate > 0, held > cap {
            let keep = Int(prefill * rate)
            head += (held - keep) * 2
            trims += 1
        }
    }

    /// What is due since the last call, as interleaved IQ. Empty while
    /// prefilling.
    func take(now: TimeInterval) -> [Int16] {
        guard rate > 0 else { return [] }
        if !releasing {
            guard Double(held) >= prefill * rate else { return [] }
            releasing = true
            lastTake = now
            owed = 0
            return []
        }
        owed += (now - (lastTake ?? now)) * rate
        lastTake = now
        var n = Int(owed)
        owed -= Double(n)
        if n > held {
            n = held
            releasing = false
            underruns += 1
        }
        guard n > 0 else { return [] }
        let out = Array(store[head ..< head + n * 2])
        head += n * 2
        return out
    }

    /// Forget what is held: it belongs to a frequency or a rate no longer in
    /// force. The observed gap is kept — it is a property of the server.
    func clear() {
        store.removeAll(keepingCapacity: true)
        head = 0
        releasing = false
        lastTake = nil
        owed = 0
        lastPush = nil
    }
}

/// Cascade of halving low-pass stages (`HalvingDecimator` in
/// src/RtlTcpClient.ts). Each stage runs at half the rate of the one before
/// it, so the total cost is under twice the first stage.
final class HalvingDecimator {
    private var stages = [ComplexFirLpf]()
    private var counters = [Int]()

    func configure(deviceRate: Double, factor: Int) {
        stages = []
        counters = []
        let n = max(0, Int(log2(Double(max(1, factor))).rounded()))
        // The band the last stage keeps. Earlier stages only have to stop what
        // would fold INTO it, which leaves them a wide transition and a short
        // filter — 31 taps instead of 70-odd at 1.2 MS/s.
        let pass = deviceRate / pow(2, Double(n)) * 0.40
        var rate = deviceRate
        for s in 0..<n {
            let out = rate / 2
            let f = ComplexFirLpf()
            if s == n - 1 {
                // Passband to 0.40 of the output rate, stopband from 0.475 —
                // aliasing folds at 0.5, and the demodulator only ever uses the
                // middle of the band, so a sharper skirt buys nothing.
                f.setLowPass(fs: rate, fc: out * 0.40, transBw: out * 0.15)
            } else {
                // Flat to `pass`, stopped from `out - pass` (what folds onto ±pass).
                f.setLowPass(fs: rate, fc: out / 2, transBw: max(out * 0.15, out - 2 * pass))
            }
            stages.append(f)
            counters.append(0)
            rate = out
        }
    }

    /// Feed one input sample; `out` is called only when a sample survives.
    func process(_ i: Double, _ q: Double, _ out: (Double, Double) -> Void) {
        var si = i, sq = q
        for s in 0..<stages.count {
            let f = stages[s]
            f.step(si, sq)
            counters[s] = (counters[s] + 1) & 1
            if counters[s] != 0 { return }   // drop the odd samples
            si = f.lastI
            sq = f.lastQ
        }
        out(si, sq)
    }
}
