#if DRM_ENABLED
import Foundation

/// Brings the receiver's IQ down to the 12 kHz complex stream the DRM decoder
/// wants, at whatever rate the SpyServer happens to be delivering.
///
/// The rate is always `maxSampleRate / 2^n`, so against 12000 it is 76/2^n:
/// 76, 38 and 19 are whole numbers, 9.5 and 4.75 are not. A plain decimator
/// would cover two thirds of the cases and quietly mistune the rest, so this is
/// a rational resampler — 12000/inRate reduced to L/M — which is exact for all
/// of them and costs the same.
///
/// Polyphase, so the filter is evaluated only at output instants: the tap count
/// is set by the input rate but the arithmetic is paid at 12 kHz. At 456 kHz in
/// that is 1672 taps and about 20 M multiplies a second.
final class DrmResampler {
    private var taps = [Double]()
    private var perPhase = 0
    private var L = 1
    private var M = 1
    /// Newest-first delay line of input samples, long enough for one dot product.
    private var lineI = [Double]()
    private var lineQ = [Double]()
    private var head = 0
    /// Absolute counts, never wrapped. At 456 kHz in and 12 kHz out, `inCount`
    /// takes twenty thousand years to reach the top of an Int and
    /// `outCount * M` a good deal longer, so rebasing them would only be a
    /// chance to get the arithmetic wrong.
    private var outCount = 0
    private var inCount = 0
    private var shiftPhase: Double = 0
    private var shiftInc: Double = 0

    private(set) var inRate: Double = 0

    /// Rebuilds the filter for a new input rate. Cheap to call with the rate it
    /// already has — it returns without touching the delay line, so a caller
    /// may do it per packet.
    func configure(inRate: Double) {
        guard inRate > 0, inRate != self.inRate else { return }
        self.inRate = inRate

        // 12000 / inRate in lowest terms.
        var a = 12000, b = Int(inRate.rounded())
        while b != 0 { (a, b) = (b, a % b) }
        let g = max(1, abs(a))
        L = 12000 / g
        M = Int(inRate.rounded()) / g

        // Designed at the upsampled rate. The pass band only has to hold the
        // DRM block (+-5 kHz); the transition may run past the 6 kHz output
        // Nyquist because what folds back lands in the 5-6 kHz guard, where
        // there is no wanted signal — only whatever the adjacent channel left.
        let fs = inRate * Double(L)
        let fc = 5500.0
        let transBw = 1500.0
        var n = max(63, Int((5.5 * fs / transBw).rounded()))
        n += (L - n % L) % L          // whole number of phases
        perPhase = n / L
        taps = [Double](repeating: 0, count: n)

        let wc = 2 * Double.pi * fc / fs
        let mid = Double(n - 1) / 2
        var sum = 0.0
        for i in 0..<n {
            let k = Double(i) - mid
            let sinc = k == 0 ? wc / Double.pi : sin(wc * k) / (Double.pi * k)
            let w = 0.42
                - 0.5 * cos(2 * Double.pi * Double(i) / Double(n - 1))
                + 0.08 * cos(4 * Double.pi * Double(i) / Double(n - 1))
            taps[i] = sinc * w
            sum += taps[i]
        }
        // Unity gain at DC after the zero stuffing L-1 samples out of every L
        // has thrown away.
        if sum != 0 {
            let inv = Double(L) / sum
            for i in 0..<n { taps[i] *= inv }
        }

        lineI = [Double](repeating: 0, count: perPhase)
        lineQ = [Double](repeating: 0, count: perPhase)
        head = 0
        outCount = 0
        inCount = 0
    }

    /// How far to move the band, at the input rate. A signal sitting `offset`
    /// above centre is brought down by passing `-offset`, the same convention
    /// `IQShift` uses.
    func setShift(hz: Double) {
        shiftInc = inRate > 0 ? 2 * Double.pi * hz / inRate : 0
    }

    func reset() {
        for i in 0..<lineI.count { lineI[i] = 0; lineQ[i] = 0 }
        head = 0
        outCount = 0
        inCount = 0
        shiftPhase = 0
    }

    /// int16 interleaved IQ in, interleaved float re/im at 12 kHz out.
    func process(int16IQ iq: Data) -> [Float] {
        guard perPhase > 0 else { return [] }
        let n = iq.count / 4
        guard n > 0 else { return [] }
        var out = [Float]()
        out.reserveCapacity(n * L / M * 2 + 8)

        var p = shiftPhase
        let inc = shiftInc
        let scale = 1.0 / 32768.0

        iq.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            guard let s = src.baseAddress else { return }
            for i in 0..<n {
                let o = i * 4
                var I = Double(s.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian) * scale
                var Q = Double(s.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian) * scale
                if inc != 0 {
                    let c = cos(p), sn = sin(p)
                    let ri = I * c - Q * sn
                    let rq = I * sn + Q * c
                    I = ri; Q = rq
                    p += inc
                    if p > Double.pi { p -= 2 * Double.pi }
                    else if p < -Double.pi { p += 2 * Double.pi }
                }

                lineI[head] = I
                lineQ[head] = Q
                inCount += 1

                // Every output whose input pointer has now arrived. With
                // L <= M there is at most one per input sample, but the loop
                // costs nothing and does not assume it.
                while true {
                    let phase = (outCount * M) % L
                    let base = (outCount * M - phase) / L
                    if base > inCount - 1 { break }
                    var accI = 0.0, accQ = 0.0
                    // x[base - m] is (inCount - 1 - (base - m)) steps back.
                    var idx = head - (inCount - 1 - base)
                    while idx < 0 { idx += perPhase }
                    var t = phase
                    for _ in 0..<perPhase {
                        let tap = taps[t]
                        accI += tap * lineI[idx]
                        accQ += tap * lineQ[idx]
                        t += L
                        idx = idx > 0 ? idx - 1 : perPhase - 1
                    }
                    out.append(Float(accI))
                    out.append(Float(accQ))
                    outCount += 1
                }

                head = head < perPhase - 1 ? head + 1 : 0
            }
        }
        shiftPhase = p
        return out
    }
}

/// One live DRM decode: the C++ core behind `drm_bridge.h`, plus the resampler
/// that feeds it.
///
/// The core's callbacks arrive on its own worker thread. Everything this class
/// hands upward is dispatched to the main queue first, so a window can bind
/// straight to it.
final class DrmSession {
    /// Latest value of every field the decoder reports, keyed as in
    /// `drm_bridge.h`. Main queue only.
    private(set) var state = [String: String]()
    /// Called on the main queue after `state` changes, with the key that moved.
    var onState: ((String, String) -> Void)?
    /// Decoded audio, 48 kHz stereo interleaved. Called on the decoder thread —
    /// it is meant to go straight into an audio sink.
    var onAudio: (([Float]) -> Void)?

    private var handle: OpaquePointer?
    private let resampler = DrmResampler()
    private let lock = NSLock()

    var isRunning: Bool { handle != nil }

    func start(inRate: Double, shiftHz: Double) {
        stop()
        resampler.configure(inRate: inRate)
        resampler.setShift(hz: shiftHz)
        state.removeAll()

        let ctx = Unmanaged.passUnretained(self).toOpaque()
        handle = drm_create({ ctx, key, value in
            guard let ctx, let key, let value else { return }
            let me = Unmanaged<DrmSession>.fromOpaque(ctx).takeUnretainedValue()
            let k = String(cString: key), v = String(cString: value)
            DispatchQueue.main.async {
                me.state[k] = v
                me.onState?(k, v)
            }
        }, { ctx, pcm, frames in
            guard let ctx, let pcm, frames > 0 else { return }
            let me = Unmanaged<DrmSession>.fromOpaque(ctx).takeUnretainedValue()
            guard let sink = me.onAudio else { return }
            sink(Array(UnsafeBufferPointer(start: pcm, count: Int(frames) * 2)))
        }, ctx)
    }

    func stop() {
        lock.lock()
        let h = handle
        handle = nil
        lock.unlock()
        if let h { drm_destroy(h) }
        resampler.reset()
    }

    /// The shift changes whenever the user retunes without the device moving.
    func setShift(hz: Double) { resampler.setShift(hz: hz) }

    /// Raw int16 IQ straight off the wire, at the rate `start` was told about.
    func feed(_ iq: Data) {
        lock.lock()
        let h = handle
        lock.unlock()
        guard let h else { return }
        let block = resampler.process(int16IQ: iq)
        guard !block.isEmpty else { return }
        block.withUnsafeBufferPointer { p in
            guard let base = p.baseAddress else { return }
            drm_feed(h, base, Int32(block.count / 2))
        }
    }

    deinit { stop() }
}
#endif
