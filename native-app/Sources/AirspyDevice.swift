import Foundation
import CAirspyHF

/// An Airspy HF+ on this machine's own USB, wearing the SpyServer client's face.
///
/// Everything downstream — the demodulators, the RSSI correction, the fax and
/// DRM taps — reads `SpyClient`'s int16 packets and was matched against the
/// plugin one field at a time. So this class converts rather than re-designs:
/// it fills in the same `DeviceInfo`, accepts the same setting ids in the same
/// order, and hands up the same interleaved int16 IQ. `LocalRadio` is unaware
/// which source it is holding.
///
/// libairspyhf calls back on its own USB thread. Only conversion happens there;
/// everything that touches device state runs on `queue`.
final class AirspyDevice: IQSource {

    var onDeviceInfo: ((SpyClient.DeviceInfo) -> Void)?
    var onIQ: ((SpyClient.IQPacket) -> Void)?
    var onSync: ((SpyClient.SyncInfo) -> Void)?
    var onDisconnect: (() -> Void)?
    var onError: ((Error) -> Void)?

    enum DeviceError: Error, LocalizedError {
        case notFound(Int32)
        case rateUnavailable(UInt32)
        case startFailed(Int32)
        case busy

        var errorDescription: String? {
            switch self {
            case .notFound:                return "no Airspy HF+ on USB (is another app holding it?)"
            case .rateUnavailable(let hz): return "device cannot produce \(hz) Hz IQ"
            case .startFailed(let r):      return "airspyhf_start failed (\(r))"
            case .busy:                    return "device already open"
            }
        }
    }

    /// An HF+ has one RF control: a 0..8 step attenuator, 6 dB a step. The index
    /// is kept the way the server's is — **higher means more gain**, so 8 is
    /// wide open and 0 is 48 dB down — because a config carried from the server
    /// path has to keep its meaning here. `maxGainIndex` in `DeviceInfo` says
    /// the same, so the Gain row's range does not change with the source.
    private static let gainSteps: UInt32 = 8

    /// Samples per packet handed up. The device's own callback block is larger
    /// than a SpyServer packet, and the pipeline measures inter-packet gaps to
    /// spot stalls; keeping the packet size in the same range keeps that
    /// diagnostic reading the same on both sources.
    private static let packetSamples = 4096

    private let queue = DispatchQueue(label: "deck-rx.airspyhf")
    /// Guards the two things the USB callback touches that `queue` also does:
    /// the carry-over buffer and the decimator. Without it a rate change or a
    /// close would free an array the callback was appending to — which is not a
    /// tidy crash at the point of the mistake but heap corruption that surfaces
    /// somewhere else entirely (first time out: inside libusb, one close later).
    private let bufLock = NSLock()
    private var dev: OpaquePointer?
    private var rates: [UInt32] = []
    private var maxRate: UInt32 = 0
    private var deviceRate: UInt32 = 0
    private var centerHz: UInt32 = 0
    private var gainIndex: UInt32 = 8
    private var decimator: IQDecimator?
    private var streaming = false
    private var intentionalClose = false

    /// Carries the odd tail of a converted block into the next one, so what
    /// goes up is a steady packet size rather than whatever USB happened to
    /// deliver.
    private var pending: [Int16] = []

    /// Same idea as the client's watchdog: a device that has been unplugged
    /// stops calling back without reporting anything, and the app would sit
    /// there looking connected. Streaming means samples every few milliseconds,
    /// so two seconds of silence is unambiguous.
    private var lastSampleAt = Date.distantPast
    private var watchdog: DispatchSourceTimer?
    private var sync: DispatchSourceTimer?
    /// The same five seconds the network client allows. Two was picked because
    /// a device streams far more steadily than a LAN, and it fired on a healthy
    /// stream — a stall this end has to be unambiguous before the stream is torn
    /// down for it.
    private static let watchdogTimeout: TimeInterval = 5

    // MARK: open / close

    /// Opens the first device on the bus. `host` and `port` are ignored: they
    /// describe the other source, and the protocol is shared.
    func open(host: String, port: UInt16, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            self.intentionalClose = false
            // A previous handle is closed first, so a reconnect after an unplug
            // does not leak one per attempt.
            self.closeDevice()

            var d: OpaquePointer?
            let r = airspyhf_open(&d)
            guard r == AIRSPYHF_SUCCESS.rawValue, let dev = d else {
                completion(.failure(DeviceError.notFound(r)))
                return
            }
            self.dev = dev
            // IQ correction, IF shift and fine tuning, which is what SDR++ and
            // SpyServer both run the device with. Off, the image of a strong
            // medium-wave carrier lands on the other side of centre.
            airspyhf_set_lib_dsp(dev, 1)

            self.rates = Self.readRates(dev)
            self.maxRate = self.rates.max() ?? 768_000
            guard self.maxRate > 0 else {
                self.closeDevice()
                completion(.failure(DeviceError.rateUnavailable(0)))
                return
            }

            completion(.success(()))
            self.emitDeviceInfo(dev)
            self.startSyncFeed()
        }
    }

    func disconnect() {
        queue.async {
            self.intentionalClose = true
            self.closeDevice()
        }
    }

    func stopStreaming() {
        queue.async {
            guard let dev = self.dev, self.streaming else { return }
            airspyhf_stop(dev)
            self.streaming = false
            self.stopWatchdog()
        }
    }

    /// On `queue`. Order is the whole point: `airspyhf_stop` does not return
    /// until the library has joined its streaming thread, so after it no
    /// callback can be running and the buffers are ours to clear. Clearing them
    /// first — or closing without stopping — is a use-after-free with the USB
    /// thread still in `deliver`.
    private func closeDevice() {
        stopWatchdog()
        sync?.cancel(); sync = nil
        if let dev {
            if streaming { airspyhf_stop(dev) }
            streaming = false
            airspyhf_close(dev)
        }
        dev = nil
        streaming = false
        bufLock.lock()
        pending.removeAll(keepingCapacity: true)
        decimator = nil
        bufLock.unlock()
    }

    private static func readRates(_ dev: OpaquePointer) -> [UInt32] {
        // The library's two-call convention: length 0 writes the count into the
        // first element, and only then is the buffer size known.
        var count: UInt32 = 0
        guard airspyhf_get_samplerates(dev, &count, 0) == AIRSPYHF_SUCCESS.rawValue, count > 0 else {
            return []
        }
        var buf = [UInt32](repeating: 0, count: Int(count))
        guard airspyhf_get_samplerates(dev, &buf, count) == AIRSPYHF_SUCCESS.rawValue else { return [] }
        return buf.filter { $0 > 0 }
    }

    private func emitDeviceInfo(_ dev: OpaquePointer) {
        var serial: UInt32 = 0
        var read = airspyhf_read_partid_serialno_t()
        if airspyhf_board_partid_serialno_read(dev, &read) == AIRSPYHF_SUCCESS.rawValue {
            serial = read.serial_no.3        // the low word, which is what the server reports
        }
        // `maxSampleRate` is not decoration: the core derives its IQ rate from
        // it as maxSampleRate >> decimation, so it has to be the rate the
        // device's own family halves from. 912 kHz gives 456 and 228 natively,
        // which are the rates the plugin and this app actually run at.
        let info = SpyClient.DeviceInfo(
            deviceType: SpyClient.DeviceType.airspyHF.rawValue,
            deviceSerial: serial,
            maxSampleRate: maxRate,
            maxBandwidth: maxRate,
            decimationStages: 8,
            gainStages: 1,
            maxGainIndex: Self.gainSteps,
            // The HF+ tunes 0.5-31 MHz and 60-260 MHz. The gap is the device's,
            // not the server's, and the core clamps rather than maps, so the
            // ends are what it is told; the gap itself is handled where the
            // dial handles it.
            minFrequency: 0,
            maxFrequency: 260_000_000,
            resolution: 18,
            minIQDecimation: 0,
            forcedIQFormat: 0)
        onDeviceInfo?(info)
    }

    // MARK: settings

    /// The same ids the server takes, applied to the device. The core sends
    /// them in SDR++'s start order and finishes with `streamingEnabled`, which
    /// is where the stream is actually started — a sample rate cannot be
    /// changed under a running transfer, so the order is load-bearing here too.
    func setSetting(_ setting: SpyClient.Setting, _ value: UInt32) {
        queue.async {
            switch setting {
            case .iqFormat, .streamingMode, .iqDigitalGain:
                // int16 is what we produce, IQ-only is all a device does, and
                // there is no digital gain to apply: the packets say 0 dB and
                // the core's RSSI correction subtracts exactly that.
                break
            case .iqDecimation:
                self.applyRate(stage: value)
            case .iqFrequency:
                self.applyFrequency(value)
            case .gain:
                self.applyGain(value)
            case .streamingEnabled:
                value == 0 ? self.stopStreamingLocked() : self.startStreaming()
            }
        }
    }

    func setFrequency(_ hz: UInt32) { setSetting(.iqFrequency, hz) }

    /// On `queue`.
    private func applyRate(stage: UInt32) {
        let want = UInt32(Double(maxRate) / Double(1 << stage))
        guard want > 0 else { return }
        // Native if the device has it; otherwise the smallest native rate that
        // is a power-of-two multiple, and software decimation covers the rest.
        // 114 kHz — the rate the offline fax and DRM captures ask for — is 228
        // kHz halved once.
        var chosen = rates.contains(want) ? want : 0
        var extra = 1
        if chosen == 0 {
            for r in rates.sorted() where r % want == 0 {
                let f = Int(r / want)
                if f > 0, (f & (f - 1)) == 0 { chosen = r; extra = f; break }
            }
        }
        guard chosen > 0 else {
            onError?(DeviceError.rateUnavailable(want))
            return
        }
        deviceRate = chosen
        bufLock.lock()
        decimator = extra > 1 ? IQDecimator(stages: Int(log2(Double(extra)))) : nil
        pending.removeAll(keepingCapacity: true)
        bufLock.unlock()
        if let dev { airspyhf_set_samplerate(dev, chosen) }
    }

    /// On `queue`.
    private func applyFrequency(_ hz: UInt32) {
        centerHz = hz
        guard let dev else { return }
        airspyhf_set_freq(dev, hz)
    }

    /// On `queue`. Index 8 is no attenuation; every step down is 6 dB more.
    private func applyGain(_ index: UInt32) {
        gainIndex = min(index, Self.gainSteps)
        guard let dev else { return }
        airspyhf_set_hf_att(dev, UInt8(Self.gainSteps - gainIndex))
    }

    // MARK: streaming

    /// On `queue`.
    private func startStreaming() {
        guard let dev, !streaming else { return }
        if deviceRate == 0 { applyRate(stage: 0) }
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        let cb: airspyhf_sample_block_cb_fn = { transfer in
            guard let t = transfer, let ctx = t.pointee.ctx else { return 0 }
            Unmanaged<AirspyDevice>.fromOpaque(ctx).takeUnretainedValue().deliver(t.pointee)
            return 0
        }
        let r = airspyhf_start(dev, cb, ctx)
        guard r == AIRSPYHF_SUCCESS.rawValue else {
            onError?(DeviceError.startFailed(r))
            return
        }
        streaming = true
        startWatchdog()
    }

    /// On `queue`.
    private func stopStreamingLocked() {
        guard let dev, streaming else { return }
        airspyhf_stop(dev)
        streaming = false
        stopWatchdog()
    }

    /// The USB thread. Convert, decimate if the rate is not one the device has,
    /// and hand up packets of a steady size.
    private func deliver(_ t: airspyhf_transfer_t) {
        let n = Int(t.sample_count)
        guard n > 0, let samples = t.samples else { return }
        lastSampleAt = Date()

        var floats = [Float](unsafeUninitializedCapacity: n * 2) { buf, count in
            samples.withMemoryRebound(to: Float.self, capacity: n * 2) { src in
                buf.baseAddress!.update(from: src, count: n * 2)
            }
            count = n * 2
        }

        var packets: [Data] = []
        bufLock.lock()
        if let d = decimator { floats = d.process(floats) }
        if !floats.isEmpty {
            // Full scale is ±1.0, and the pipeline reads int16 against 32767,
            // which is the scaling SpyServer's int16 stream uses. Keeping it
            // identical is what lets a level measured through the server and one
            // measured here be compared at all.
            var out = [Int16](repeating: 0, count: floats.count)
            for i in 0..<floats.count {
                let v = floats[i] * 32767
                // A NaN would trap on the way to Int16, and one bad sample must
                // not be the end of the receiver.
                out[i] = v.isFinite ? Int16(max(-32767, min(32767, v.rounded()))) : 0
            }
            pending.append(contentsOf: out)
            let stride = Self.packetSamples * 2
            while pending.count >= stride {
                let chunk = Array(pending[0 ..< stride])
                pending.removeFirst(stride)
                packets.append(chunk.withUnsafeBufferPointer { Data(buffer: $0) })
            }
        }
        bufLock.unlock()

        // Outside the lock: this walks into the demodulators, and holding a
        // lock the next USB callback needs while they run would stall the bus.
        for body in packets {
            onIQ?(SpyClient.IQPacket(format: .int16, body: body, gainDb: 0))
        }
    }

    // MARK: watchdog / sync

    private func startWatchdog() {
        lastSampleAt = Date()
        stopWatchdog()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, self.streaming else { return }
            let silent = Date().timeIntervalSince(self.lastSampleAt)
            guard silent > Self.watchdogTimeout else { return }
            // Stop, but do not close: closing belongs to the reconnect, which
            // runs through `open` and closes there. Tearing the handle down
            // from inside a timer is how the first version crashed.
            print("[usb] no samples for \(String(format: "%.1f", silent)) s - stopping the stream")
            if let dev = self.dev { airspyhf_stop(dev) }
            self.streaming = false
            self.stopWatchdog()
            if !self.intentionalClose { self.onDisconnect?() }
        }
        watchdog = t
        t.resume()
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    /// The server sends a sync message continuously; the core reads it for the
    /// centre frequency and for whether it is allowed to steer. A device we
    /// hold is always ours to steer, so this says so once a second rather than
    /// leaving the display with nothing to follow.
    private func startSyncFeed() {
        sync?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, self.dev != nil else { return }
            self.onSync?(SpyClient.SyncInfo(
                canControl: true,
                gain: self.gainIndex,
                deviceCenterFreq: self.centerHz,
                iqCenterFreq: self.centerHz,
                fftCenterFreq: self.centerHz,
                minIQCenterFreq: 0,
                maxIQCenterFreq: 260_000_000))
        }
        sync = t
        t.resume()
    }
}

/// Cascaded 2:1 decimation for the rates an HF+ does not have natively.
///
/// Each stage low-passes below the next Nyquist before dropping every other
/// complex sample. The filter is the point: dropping samples on their own folds
/// everything above the new Nyquist back into the band, which is precisely the
/// bug the Swift port shipped once in its audio path — on medium wave it puts
/// one station on top of another rather than making a hiss.
final class IQDecimator {
    private var stages: [Stage]

    init(stages count: Int) {
        let taps = IQDecimator.lowpass(taps: 31, cutoff: 0.22)
        self.stages = (0..<max(0, count)).map { _ in Stage(h: taps) }
    }

    func process(_ input: [Float]) -> [Float] {
        var x = input
        for i in stages.indices { x = stages[i].process(x) }
        return x
    }

    /// Windowed sinc, Hamming. Cutoff is a fraction of the input rate and sits
    /// under the quarter-rate the 2:1 drop needs, so the transition band has
    /// somewhere to go.
    private static func lowpass(taps: Int, cutoff: Double) -> [Float] {
        let m = taps - 1
        var h = [Double](repeating: 0, count: taps)
        for i in 0...m {
            let k = Double(i) - Double(m) / 2
            let sinc = k == 0 ? 2 * cutoff : sin(2 * .pi * cutoff * k) / (.pi * k)
            let w = 0.54 - 0.46 * cos(2 * .pi * Double(i) / Double(m))
            h[i] = sinc * w
        }
        let sum = h.reduce(0, +)
        return h.map { Float($0 / sum) }
    }

    /// One 2:1 stage. `pos` carries the output phase across block boundaries —
    /// without it a block whose length is not what the last one was shifts the
    /// decimation phase and the stream develops a stutter.
    private struct Stage {
        let h: [Float]
        var z: [Float]
        var pos: Int

        init(h: [Float]) {
            self.h = h
            self.z = [Float](repeating: 0, count: (h.count - 1) * 2)
            self.pos = h.count - 1
        }

        mutating func process(_ x: [Float]) -> [Float] {
            guard !x.isEmpty else { return [] }
            var buf = z
            buf.append(contentsOf: x)
            let complexCount = buf.count / 2
            let m = h.count
            var out = [Float]()
            out.reserveCapacity(x.count / 2)
            var k = pos
            while k < complexCount {
                var accI: Float = 0, accQ: Float = 0
                for j in 0..<m {
                    let idx = (k - j) * 2
                    accI += h[j] * buf[idx]
                    accQ += h[j] * buf[idx + 1]
                }
                out.append(accI)
                out.append(accQ)
                k += 2
            }
            let keep = m - 1
            let drop = max(0, complexCount - keep)
            if drop > 0 { buf.removeFirst(drop * 2) }
            z = buf
            pos = k - drop
            return out
        }
    }
}
