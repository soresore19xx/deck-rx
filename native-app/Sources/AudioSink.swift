import AVFoundation
import Foundation

/// Audio output for the standalone path: AVAudioEngine with a source node.
///
/// Replaces `src/AudioOutput.ts` (PortAudio through naudiodon) and
/// `src/asrc.ts` (libsamplerate). Both were native Node modules pinned to the
/// Stream Deck app's ABI, and both are gone here: the engine resamples between
/// the demodulator's rate and the device's, and it owns the device.
///
/// A source node is a pull model — the render callback asks for samples on a
/// realtime thread. Nothing in that callback may allocate, lock or block, so
/// the queue is a plain preallocated ring and the callback only ever reads it.
final class AudioSink {

    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode?
    private var sourceRate: Double = 0

    /// Ring buffer, mono. Sized for roughly a second at any plausible rate —
    /// enough to ride out a scheduling hiccup, short enough that recovery from
    /// an underrun is not audible as a long delay.
    private var ring: UnsafeMutablePointer<Float>
    private let capacity: Int
    private var writeIndex = 0
    private var readIndex = 0
    private let lock = NSLock()

    /// Counts samples the callback wanted and did not have. The honest way to
    /// notice the producer is not keeping up, rather than guessing from a
    /// description of the sound.
    private(set) var underruns: Int = 0

    var volume: Double = 0.9
    var muted = false

    init(capacity: Int = 96_000) {
        self.capacity = capacity
        ring = UnsafeMutablePointer<Float>.allocate(capacity: capacity)
        ring.initialize(repeating: 0, count: capacity)
    }

    deinit {
        stop()
        ring.deallocate()
    }

    /// (Re)starts the engine for a producer running at `rate` Hz.
    /// Called again with a different rate rebuilds the graph — the engine
    /// converts to whatever the output device is actually running at.
    func start(sourceRate rate: Double) throws {
        guard rate > 0 else { return }
        if sourceRate == rate, engine.isRunning { return }
        stop()
        sourceRate = rate

        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else { return }
        let node = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let self, let out = abl[0].mData?.assumingMemoryBound(to: Float.self) else {
                for buf in abl { memset(buf.mData, 0, Int(buf.mDataByteSize)) }
                return noErr
            }
            let n = Int(frameCount)
            // Realtime thread: no allocation, no Swift runtime calls that can
            // lock. Reading the indices without the lock is a deliberate,
            // single-producer/single-consumer trade — a torn read costs at
            // worst one frame of stale length, never a crash.
            var r = self.readIndex
            let w = self.writeIndex
            var available = w - r
            if available < 0 { available += self.capacity }
            let take = min(n, available)
            for i in 0..<take {
                out[i] = self.ring[r]
                r += 1
                if r == self.capacity { r = 0 }
            }
            if take < n {
                for i in take..<n { out[i] = 0 }
                self.underruns += n - take
            }
            self.readIndex = r
            return noErr
        }
        source = node
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 1
        engine.prepare()
        try engine.start()
    }

    func stop() {
        if engine.isRunning { engine.stop() }
        if let s = source { engine.detach(s); source = nil }
        sourceRate = 0
        lock.lock(); writeIndex = 0; readIndex = 0; lock.unlock()
    }

    /// Queues demodulated samples. Drops the oldest rather than blocking when
    /// the producer outruns the device: late audio is worthless, and blocking
    /// here would stall the network thread that feeds it.
    func write(_ samples: [Float]) {
        guard !samples.isEmpty, engine.isRunning else { return }
        let gain = Float(muted ? 0 : min(max(volume, 0), 1))
        lock.lock()
        var w = writeIndex
        for s in samples {
            ring[w] = s * gain
            w += 1
            if w == capacity { w = 0 }
        }
        writeIndex = w
        // If the writer has lapped the reader, the reader's position is now
        // meaningless; put it a whole buffer behind so it reads fresh samples
        // instead of a mixture of two eras.
        var used = w - readIndex
        if used < 0 { used += capacity }
        if used >= capacity - 1 {
            var r = w - (capacity / 2)
            if r < 0 { r += capacity }
            readIndex = r
        }
        lock.unlock()
    }
}
