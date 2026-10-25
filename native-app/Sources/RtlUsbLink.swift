import Foundation

/// An RTL-SDR on the iPad's own USB port, through the DriverKit driver the app
/// carries (rtlusb/build-driver.sh), presented to `RtlTcpClient` as if it were
/// an rtl_tcp server.
///
/// The driver came with an app of its own, RTLBridge, that served the dongle as
/// rtl_tcp on 127.0.0.1:1234, and Deck RX connected to that. It worked, but it
/// was two apps to start in the right order (asked 2026-10-24). This is the
/// part of RTLBridge that talks to the driver, without the socket: the same
/// 12-byte header, the same 8-bit IQ, the same 5-byte commands. So the rate
/// planning, the gain handling and the pacing are `RtlTcpClient`'s, unchanged,
/// and nothing upstream of it can tell the two apart.
///
/// The IOKit side is RTLBridge's own C bridge (RTLSDRBridge.c), compiled in by
/// build-ios.sh from the fetched tree; the command mapping follows its
/// RTLTCPServer.handleCommand.
final class RtlUsbLink: RtlByteLink {

    enum LinkError: Error, LocalizedError {
        case noDriver
        case noRing
        case startFailed(Int32, Int64)

        var errorDescription: String? {
            switch self {
            case .noDriver:
                return "no RTL-SDR - plug it in, and turn its driver on in Settings > Apps > Deck RX"
            case .noRing:
                return "the RTL-SDR driver did not share its sample buffer"
            case .startFailed(let kr, let rc):
                return "the RTL-SDR did not start streaming (kr=\(kr), rc=\(rc))"
            }
        }
    }

    /// RTLSDRRingBuffer's header: writeCount, readCount, dropCount, dataSize.
    private static let ringHeader = 32
    private static let pollInterval: TimeInterval = 0.005

    private var conn: UInt32 = 0
    private var ring: UnsafeMutableRawPointer?
    private var cursor: UInt64 = 0
    private var timer: DispatchSourceTimer?

    /// Commands run here, not on the caller's queue. A retune is a run of
    /// tuner register writes over USB control transfers, and the call blocks
    /// until they are done; on the caller's queue that also stopped the ring
    /// poll and RtlTcpClient's pacer, which share it, so every retune was an
    /// audio gap as long as the tuning (2026-10-25). The driver streams on a
    /// queue of its own meanwhile, so nothing is lost by not waiting.
    private let cmdQueue = DispatchQueue(label: "deck-rx.rtlusb.cmd", qos: .userInitiated)
    /// The slowest command since the last `diagNote`, in seconds.
    private var slowestCmd: Double = 0
    private let slowLock = NSLock()

    var diagNote: String {
        slowLock.lock(); defer { slowLock.unlock() }
        let s = String(format: " usbCmdMax=%.0fms", slowestCmd * 1000)
        slowestCmd = 0
        return s
    }

    /// The rtl_tcp header's gain-step count, per tuner type, as librtlsdr
    /// reports it (RTLTCPServer.gainCount in RTLBridge).
    static func gainCount(tuner: UInt32) -> UInt32 {
        switch tuner {
        case 1:    return 14      // E4000
        case 2:    return 5       // FC0012
        case 3:    return 23      // FC0013
        case 4:    return 1       // FC2580
        case 5, 6: return 29      // R820T / R828D
        default:   return 0
        }
    }

    func start(queue: DispatchQueue, onBytes: @escaping (Data) -> Void) -> Error? {
        conn = rtlsdrhost_open()
        guard conn != 0 else { return LinkError.noDriver }
        var size: UInt64 = 0
        guard let p = rtlsdrhost_map_memory(conn, UInt32(kRTLSDRMemoryTypeIQRing), &size) else {
            close()
            return LinkError.noRing
        }
        ring = p

        var info = RTLSDRDeviceInfo()
        var infoSize = MemoryLayout<RTLSDRDeviceInfo>.size
        let tuner: UInt32 =
            rtlsdrhost_get_struct(conn, UInt32(kRTLSDRMethodGetDeviceInfo), &info, &infoSize) == 0
            ? info.tunerType : 0

        // RTLBridge's onClientReady: stop, reset, zero the counters, start.
        call(kRTLSDRMethodStopStream)
        call(kRTLSDRMethodResetBuffer)
        for off in [0, 8, 16] { p.storeBytes(of: UInt64(0), toByteOffset: off, as: UInt64.self) }
        cursor = 0
        let started = call(kRTLSDRMethodStartStream)
        guard started.kr == 0, started.rc == 0 else {
            close()
            return LinkError.startFailed(started.kr, started.rc)
        }

        var header = Data("RTL0".utf8)
        for v in [tuner, Self.gainCount(tuner: tuner)] {
            var be = v.bigEndian
            withUnsafeBytes(of: &be) { header.append(contentsOf: $0) }
        }
        queue.async { onBytes(header) }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.pollInterval, repeating: Self.pollInterval,
                   leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            if let d = self?.read(), !d.isEmpty { onBytes(d) }
        }
        timer = t
        t.resume()
        return nil
    }

    func command(_ d: Data) {
        guard d.count == 5 else { return }
        // In order, after any earlier command; `conn` is read on this queue,
        // which is also where `close` clears it.
        cmdQueue.async { [weak self] in self?.run(d) }
    }

    private func run(_ d: Data) {
        guard conn != 0 else { return }
        let b = [UInt8](d)
        let param = UInt64(UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4]))
        let sel: UInt32
        switch b[0] {
        case 0x01: sel = UInt32(kRTLSDRMethodSetCenterFreq)
        case 0x02: sel = UInt32(kRTLSDRMethodSetSampleRate)
        case 0x03: sel = UInt32(kRTLSDRMethodSetTunerGainMode)
        case 0x04: sel = UInt32(kRTLSDRMethodSetTunerGain)
        case 0x05: sel = UInt32(kRTLSDRMethodSetFreqCorrection)
        case 0x07: sel = UInt32(kRTLSDRMethodSetTestmode)
        case 0x08: sel = UInt32(kRTLSDRMethodSetAgcMode)
        case 0x09: sel = UInt32(kRTLSDRMethodSetDirectSampling)
        case 0x0a: sel = UInt32(kRTLSDRMethodSetOffsetTuning)
        case 0x0d: sel = UInt32(kRTLSDRMethodSetGainByIndex)
        case 0x0e: sel = UInt32(kRTLSDRMethodSetBiasTee)
        default:   return
        }
        var out: UInt64 = 0
        let t0 = ProcessInfo.processInfo.systemUptime
        _ = rtlsdrhost_call(conn, sel, param, &out)
        let took = ProcessInfo.processInfo.systemUptime - t0
        slowLock.lock(); slowestCmd = max(slowestCmd, took); slowLock.unlock()
    }

    func close() {
        timer?.cancel()
        timer = nil
        // Behind any command still queued, so none runs on a closed handle.
        cmdQueue.sync {
            if conn != 0 {
                call(kRTLSDRMethodStopStream)
                rtlsdrhost_close(conn)
                conn = 0
            }
        }
        ring = nil
    }

    @discardableResult
    private func call<T: BinaryInteger>(_ selector: T, _ arg: UInt64 = 0) -> (kr: Int32, rc: Int64) {
        var out: UInt64 = 0
        let kr = rtlsdrhost_call(conn, UInt32(selector), arg, &out)
        return (kr, Int64(bitPattern: out))
    }

    /// Everything produced since the last call; a lapped reader jumps to the
    /// newest window, as RTLSDRClient.readIQ does.
    private func read() -> Data? {
        guard let base = ring else { return nil }
        let w = base.load(fromByteOffset: 0, as: UInt64.self)
        let dataSize = base.load(fromByteOffset: 24, as: UInt64.self)
        guard dataSize > 0 else { return nil }
        var r = cursor
        var avail = w &- r
        if avail == 0 { return nil }
        if avail > dataSize {
            r = w &- dataSize
            avail = dataSize
        }
        let count = Int(avail)
        let src = base.advanced(by: Self.ringHeader)
        var out = Data(count: count)
        out.withUnsafeMutableBytes { raw in
            guard let dst = raw.baseAddress else { return }
            let off = Int(r % dataSize)
            let first = min(count, Int(dataSize) - off)
            memcpy(dst, src.advanced(by: off), first)
            if count > first { memcpy(dst.advanced(by: first), src, count - first) }
        }
        cursor = r &+ avail
        base.storeBytes(of: cursor, toByteOffset: 8, as: UInt64.self)
        return out
    }
}
