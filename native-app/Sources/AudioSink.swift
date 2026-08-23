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

    /// Ring buffer, frames interleaved. Sized for roughly a second at any
    /// plausible rate —
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

    /// Capacity is rounded to an even number of samples so a stereo frame
    /// never straddles the wrap.
    /// Output devices the engine can reach, for the panel's picker. Empty
    /// first entry means "system default", which is what the panel expects.
    static func outputDeviceNames() -> [String] {
        var names: [String] = []
        var size = UInt32(0)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &addr, 0, nil, &size) == noErr else { return names }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var ids = [AudioObjectID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &ids) == noErr else { return names }
        for id in ids {
            // Output devices only: a microphone in an output picker is noise.
            var cfgAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain)
            var cfgSize = UInt32(0)
            guard AudioObjectGetPropertyDataSize(id, &cfgAddr, 0, nil, &cfgSize) == noErr,
                  cfgSize > 0 else { continue }
            let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(cfgSize),
                                                       alignment: MemoryLayout<AudioBufferList>.alignment)
            defer { buf.deallocate() }
            guard AudioObjectGetPropertyData(id, &cfgAddr, 0, nil, &cfgSize, buf) == noErr else { continue }
            let abl = UnsafeMutableAudioBufferListPointer(buf.assumingMemoryBound(to: AudioBufferList.self))
            guard abl.reduce(0, { $0 + Int($1.mNumberChannels) }) > 0 else { continue }

            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            // Unmanaged, because taking a raw pointer to a CFString variable
            // hands CoreAudio the address of a reference rather than a slot to
            // write one into.
            var nameRef: Unmanaged<CFString>?
            var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            if AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &nameRef) == noErr,
               let s = nameRef?.takeRetainedValue() as String?, !s.isEmpty {
                names.append(s)
            }
        }
        return names
    }

    init(capacity: Int = 96_000) {
        self.capacity = capacity - (capacity % 2)
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
    private var channels: AVAudioChannelCount = 1

    func start(sourceRate rate: Double, channels ch: AVAudioChannelCount = 1) throws {
        guard rate > 0 else { return }
        if sourceRate == rate, channels == ch, engine.isRunning { return }
        stop()
        sourceRate = rate
        channels = ch

        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: ch) else { return }
        let node = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let self else {
                for buf in abl { memset(buf.mData, 0, Int(buf.mDataByteSize)) }
                return noErr
            }
            // Non-interleaved: one buffer per channel. The ring holds frames
            // interleaved, so a frame is `chans` consecutive samples.
            let chans = Int(self.channels)
            let n = Int(frameCount)
            // Realtime thread: no allocation, no Swift runtime calls that can
            // lock. Reading the indices without the lock is a deliberate,
            // single-producer/single-consumer trade — a torn read costs at
            // worst one frame of stale length, never a crash.
            var r = self.readIndex
            let w = self.writeIndex
            var available = w - r
            if available < 0 { available += self.capacity }
            let takeFrames = min(n, available / chans)
            for c in 0..<min(chans, abl.count) {
                guard let out = abl[c].mData?.assumingMemoryBound(to: Float.self) else { continue }
                var idx = r + c
                if idx >= self.capacity { idx -= self.capacity }
                for i in 0..<takeFrames {
                    out[i] = self.ring[idx]
                    idx += chans
                    if idx >= self.capacity { idx -= self.capacity }
                }
                for i in takeFrames..<n { out[i] = 0 }
            }
            if takeFrames < n { self.underruns += n - takeFrames }
            r += takeFrames * chans
            while r >= self.capacity { r -= self.capacity }
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
        if used >= capacity - Int(channels) {
            // Land on a frame boundary, or a stereo read would swap L and R
            // from here on.
            let chans = Int(channels)
            var back = capacity / 2
            back -= back % chans
            var r = w - back
            if r < 0 { r += capacity }
            readIndex = r
        }
        lock.unlock()
    }
}
