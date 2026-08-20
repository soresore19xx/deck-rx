import Foundation

/// Reads spectrum frames from the plugin's Unix socket (src/spectrumFeed.ts).
///
/// Wire format, little-endian: 24-byte header then `binCount` float32 dBFS.
/// The reader syncs on the magic and derives the frame length from binCount,
/// so a partial read or a mid-stream connect recovers on the next frame
/// boundary instead of desynchronising.
///
/// Nothing on the plugin side is computed until something connects here, and
/// the plugin drops frames for a reader that falls behind rather than queueing
/// them — a late spectrum is worthless, so the newest frame always wins.
final class SpectrumFeed {
    struct Frame {
        let bins: [Float]      // dBFS, low frequency first
        let iqRate: UInt32     // Hz, the span the bins cover
        let centerFreq: UInt32 // Hz, at bins[count/2]
        let seq: UInt32
    }

    private static let magic: UInt32 = 0x53585244 // 'DRXS'
    private static let headerBytes = 24

    private let path: String
    private let onFrame: (Frame) -> Void
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var retryTimer: Timer?

    /// `dropped` counts frames the socket delivered while we were busy — it is
    /// the honest way to notice the UI is not keeping up.
    private(set) var connected = false

    init(path: String = "/tmp/deck-rx-spectrum.sock", onFrame: @escaping (Frame) -> Void) {
        self.path = path
        self.onFrame = onFrame
    }

    func start() {
        connect()
        // The plugin may not be running yet, or may restart under us. Retrying
        // on a timer keeps the app usable across a plugin bounce without the
        // user having to reopen anything.
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self, !self.connected else { return }
            self.connect()
        }
    }

    func stop() {
        retryTimer?.invalidate(); retryTimer = nil
        teardown()
    }

    private func teardown() {
        source?.cancel(); source = nil
        if fd >= 0 { close(fd); fd = -1 }
        buffer.removeAll(keepingCapacity: true)
        connected = false
    }

    private func connect() {
        teardown()
        // sockaddr_un.sun_path is 104 bytes on macOS; a longer path fails with
        // a misleading EADDRINUSE, so refuse it here rather than puzzle later.
        guard path.utf8.count < 104 else {
            NSLog("[spectrum] socket path too long: \(path)")
            return
        }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { p in
            path.withCString { cs in
                strncpy(UnsafeMutableRawPointer(p).assumingMemoryBound(to: CChar.self), cs, 103)
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) { p -> Bool in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, size) == 0 }
        }
        guard ok else { close(s); return }

        fd = s
        connected = true
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: .main)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        src.setCancelHandler { }
        src.resume()
        source = src
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { teardown(); return }   // plugin went away — the retry timer reconnects
        buffer.append(contentsOf: chunk[0..<n])
        drain()
    }

    private func drain() {
        while true {
            guard buffer.count >= Self.headerBytes else { return }
            if u32(0) != Self.magic {
                // Re-sync: drop one byte and look again. Only happens on a
                // mid-stream connect, and costs at most one frame.
                buffer.removeFirst()
                continue
            }
            let count = Int(u32(8))
            guard count > 0, count <= 65536 else { buffer.removeFirst(); continue }
            let total = Self.headerBytes + count * 4
            guard buffer.count >= total else { return }

            var bins = [Float](repeating: 0, count: count)
            buffer.withUnsafeBytes { raw in
                let base = raw.baseAddress!.advanced(by: Self.headerBytes)
                memcpy(&bins, base, count * 4)
            }
            let frame = Frame(bins: bins, iqRate: u32(12), centerFreq: u32(16), seq: u32(20))
            buffer.removeFirst(total)
            onFrame(frame)
        }
    }

    private func u32(_ off: Int) -> UInt32 {
        buffer.withUnsafeBytes { raw in
            raw.loadUnaligned(fromByteOffset: off, as: UInt32.self).littleEndian
        }
    }
}
