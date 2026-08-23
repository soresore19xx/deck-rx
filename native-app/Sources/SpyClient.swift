import Foundation
import Network

/// SpyServer protocol client — the app's own connection to the receiver.
///
/// Ported from `src/SpyClient.ts`, which is itself matched against SDR++'s
/// `spyserver_client.cpp`. The wire format is not ours to invent, so this is a
/// transcription rather than a design: same protocol version, same command and
/// message ids, same little-endian field order. Where the TypeScript carries a
/// comment explaining why something is the way it is, that reason is carried
/// over with it — those notes are the record of what went wrong once.
///
/// Deliberately knows nothing about demodulation, audio or display. It hands up
/// device info, sync state and raw IQ, and nothing else.
final class SpyClient {

    // MARK: wire constants

    /// 2.0.1700
    private static let protocolVersion: UInt32 = (2 << 24) | (0 << 16) | 1700
    private static let cmdHeaderSize = 8
    private static let msgHeaderSize = 20

    private static let cmdHello: UInt32 = 0
    private static let cmdSetSetting: UInt32 = 2

    enum Setting: UInt32 {
        case streamingMode = 0
        case streamingEnabled = 1
        case gain = 2
        case iqFormat = 100
        case iqFrequency = 101
        case iqDecimation = 102
        case iqDigitalGain = 103
    }

    static let streamModeIQOnly: UInt32 = 1

    enum IQFormat: UInt32 {
        case uint8 = 1
        case int16 = 2
        case float = 4
    }

    private static let msgDeviceInfo: UInt16 = 0
    private static let msgClientSync: UInt16 = 1
    private static let msgUint8IQ: UInt16 = 100
    private static let msgInt16IQ: UInt16 = 101
    private static let msgFloatIQ: UInt16 = 103

    enum DeviceType: UInt32 {
        case airspyOne = 1
        case airspyHF = 2
        case rtlsdr = 3
    }

    // MARK: payloads

    struct DeviceInfo {
        var deviceType: UInt32
        var deviceSerial: UInt32
        var maxSampleRate: UInt32
        var maxBandwidth: UInt32
        var decimationStages: UInt32
        var gainStages: UInt32
        var maxGainIndex: UInt32
        var minFrequency: UInt32
        var maxFrequency: UInt32
        var resolution: UInt32
        var minIQDecimation: UInt32
        var forcedIQFormat: UInt32
    }

    struct SyncInfo {
        var canControl: Bool
        var gain: UInt32
        var deviceCenterFreq: UInt32
        var iqCenterFreq: UInt32
        var fftCenterFreq: UInt32
        var minIQCenterFreq: UInt32
        var maxIQCenterFreq: UInt32
    }

    struct IQPacket {
        var format: IQFormat
        var body: Data
        /// Upper 16 bits of MessageType.
        var gainDb: UInt16
    }

    // MARK: callbacks

    var onDeviceInfo: ((DeviceInfo) -> Void)?
    var onSync: ((SyncInfo) -> Void)?
    var onIQ: ((IQPacket) -> Void)?
    var onDisconnect: (() -> Void)?
    var onError: ((Error) -> Void)?

    // MARK: state

    private var conn: NWConnection?
    private var buf = Data()
    private var intentionalClose = false
    private let queue = DispatchQueue(label: "deck-rx.spyclient")

    /// Application-level dead-connection watchdog. Yanking the LAN cable leaves
    /// the TCP socket nominally open from our side — the OS will not notice for
    /// about two hours by default — so no disconnect or error ever fires. Track
    /// the time of the last received byte and declare the link dead if nothing
    /// arrives for `watchdogTimeout` while streaming: SpyServer sends IQ and
    /// sync packets continuously when active, so 5 s of silence is unambiguous.
    private var lastRx = Date.distantPast
    private var watchdog: DispatchSourceTimer?
    private static let watchdogTimeout: TimeInterval = 5
    private static let watchdogInterval: TimeInterval = 1

    // MARK: connect / disconnect

    enum ClientError: Error, LocalizedError {
        case connectTimeout(TimeInterval)
        case notConnected

        var errorDescription: String? {
            switch self {
            case .connectTimeout(let s): return "TCP connect timeout (\(Int(s * 1000)) ms)"
            case .notConnected:          return "not connected"
            }
        }
    }

    /// Connects and sends HELLO. `completion` fires once, on the internal queue.
    ///
    /// The explicit timeout is not decoration: without it an unreachable host
    /// (firewall drop, no route) blocks for the OS SYN-retry timeout — about
    /// 75 s — and stalls a reconnect loop for exactly that long.
    func connect(host: String, port: UInt16, timeout: TimeInterval = 5,
                 completion: @escaping (Result<Void, Error>) -> Void) {
        intentionalClose = false
        buf = Data()

        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            // Slow safety net only. macOS default idle before the first probe is
            // about two hours, which is why the watchdog above exists at all.
            tcp.enableKeepalive = true
            tcp.keepaliveIdle = 30
        }
        let c = NWConnection(host: NWEndpoint.Host(host),
                             port: NWEndpoint.Port(rawValue: port) ?? 5555,
                             using: params)
        conn = c

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
            settle(.failure(ClientError.connectTimeout(timeout)))
        }
        queue.asyncAfter(deadline: .now() + timeout, execute: deadline)

        c.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                deadline.cancel()
                self.sendHello()
                self.startWatchdog()
                self.receiveLoop()
                settle(.success(()))
            case .failed(let e):
                deadline.cancel()
                self.stopWatchdog()
                self.conn = nil
                if settled {
                    self.onError?(e)
                    if !self.intentionalClose { self.onDisconnect?() }
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

    func disconnect() {
        intentionalClose = true
        stopWatchdog()
        conn?.cancel()
        conn = nil
        buf = Data()
    }

    // MARK: watchdog

    private func startWatchdog() {
        lastRx = Date()
        stopWatchdog()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            guard Date().timeIntervalSince(self.lastRx) > Self.watchdogTimeout else { return }
            self.stopWatchdog()
            // Force the socket shut so any later write fails fast, then surface
            // it as a disconnect — what the OS would have reported itself if it
            // had noticed the link was gone.
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

    // MARK: commands

    func setSetting(_ setting: Setting, _ value: UInt32) {
        var body = Data(capacity: 8)
        body.appendLE(setting.rawValue)
        body.appendLE(value)
        sendCmd(Self.cmdSetSetting, body)
    }

    func setFrequency(_ hz: UInt32) { setSetting(.iqFrequency, hz) }
    func stopStreaming() { setSetting(.streamingEnabled, 0) }

    private func sendHello() {
        // The client name is "SDR++" on purpose: some servers gate behaviour on
        // it, and matching the reference client is the only way to be sure we
        // are treated identically.
        let name = Array("SDR++".utf8)
        var body = Data(capacity: 4 + name.count)
        body.appendLE(Self.protocolVersion)
        body.append(contentsOf: name)
        sendCmd(Self.cmdHello, body)
    }

    private func sendCmd(_ cmd: UInt32, _ body: Data) {
        guard let c = conn else { return }
        var out = Data(capacity: Self.cmdHeaderSize + body.count)
        out.appendLE(cmd)
        out.appendLE(UInt32(body.count))
        out.append(body)
        c.send(content: out, completion: .contentProcessed { [weak self] e in
            if let e { self?.onError?(e) }
        })
    }

    // MARK: receive

    private func receiveLoop() {
        conn?.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.lastRx = Date()
                self.buf.append(data)
                self.drain()
            }
            if let error {
                self.onError?(error)
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

    /// Header layout: ProtocolID(0) MessageType(4) StreamType(8)
    /// SequenceNumber(12) BodySize(16).
    private func drain() {
        while buf.count >= Self.msgHeaderSize {
            let messageTypeRaw = buf.readLE32(at: 4)
            let bodySize = Int(buf.readLE32(at: 16))
            guard buf.count >= Self.msgHeaderSize + bodySize else { break }
            let body = buf.subdata(in: Self.msgHeaderSize ..< (Self.msgHeaderSize + bodySize))
            buf.removeSubrange(0 ..< (Self.msgHeaderSize + bodySize))

            let msgType = UInt16(messageTypeRaw & 0xFFFF)
            let gainDb = UInt16((messageTypeRaw >> 16) & 0xFFFF)
            handle(msgType, gainDb, body)
        }
    }

    private func handle(_ type: UInt16, _ gainDb: UInt16, _ body: Data) {
        switch type {
        case Self.msgDeviceInfo where body.count >= 48:
            onDeviceInfo?(DeviceInfo(
                deviceType:       body.readLE32(at: 0),
                deviceSerial:     body.readLE32(at: 4),
                maxSampleRate:    body.readLE32(at: 8),
                maxBandwidth:     body.readLE32(at: 12),
                decimationStages: body.readLE32(at: 16),
                gainStages:       body.readLE32(at: 20),
                maxGainIndex:     body.readLE32(at: 24),
                minFrequency:     body.readLE32(at: 28),
                maxFrequency:     body.readLE32(at: 32),
                resolution:       body.readLE32(at: 36),
                minIQDecimation:  body.readLE32(at: 40),
                forcedIQFormat:   body.readLE32(at: 44)))

        case Self.msgClientSync where body.count >= 36:
            onSync?(SyncInfo(
                canControl:       body.readLE32(at: 0) != 0,
                gain:             body.readLE32(at: 4),
                deviceCenterFreq: body.readLE32(at: 8),
                iqCenterFreq:     body.readLE32(at: 12),
                fftCenterFreq:    body.readLE32(at: 16),
                minIQCenterFreq:  body.readLE32(at: 20),
                maxIQCenterFreq:  body.readLE32(at: 24)))

        case Self.msgUint8IQ: onIQ?(IQPacket(format: .uint8, body: body, gainDb: gainDb))
        case Self.msgInt16IQ: onIQ?(IQPacket(format: .int16, body: body, gainDb: gainDb))
        case Self.msgFloatIQ: onIQ?(IQPacket(format: .float, body: body, gainDb: gainDb))
        default: break
        }
    }
}

/// Mirrors SDR++'s `computeDigitalGain` (spyserver_client.cpp). The 3.01 is
/// 10·log10(2) — one decimation stage halves the bandwidth, and the digital
/// gain compensates so the level does not step when decimation changes.
func computeDigitalGain(deviceType: UInt32, deviceGain: UInt32,
                        decimationStage: UInt32, maxGainIndex: UInt32) -> UInt32 {
    switch SpyClient.DeviceType(rawValue: deviceType) {
    case .airspyOne:
        let v = Double(maxGainIndex) - Double(deviceGain) + Double(decimationStage) * 3.01
        return UInt32(max(0, v.rounded()))
    case .airspyHF, .rtlsdr:
        return UInt32(max(0, (Double(decimationStage) * 3.01).rounded()))
    default:
        return 0
    }
}

// MARK: - little-endian helpers

private extension Data {
    mutating func appendLE(_ v: UInt32) {
        var le = v.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }

    func readLE32(at offset: Int) -> UInt32 {
        // Data slices can carry a non-zero startIndex, so never index from 0.
        let i = index(startIndex, offsetBy: offset)
        return UInt32(self[i])
            | UInt32(self[index(i, offsetBy: 1)]) << 8
            | UInt32(self[index(i, offsetBy: 2)]) << 16
            | UInt32(self[index(i, offsetBy: 3)]) << 24
    }
}
