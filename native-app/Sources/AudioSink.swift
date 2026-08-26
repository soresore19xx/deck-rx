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
    /// The gain the last sample actually left with. A buffer ramps from here
    /// to the current volume rather than starting at it: read once per buffer
    /// and applied flat, a change lands as a step at the buffer boundary, and
    /// dragging a slider is one step per buffer — a run of clicks, which is
    /// what a volume control is never supposed to make. Starts at silence so
    /// the first buffer after a start fades in instead of popping.
    private var appliedGain: Float = 0

    /// Capacity is rounded to an even number of samples so a stereo frame
    /// never straddles the wrap.
    /// Output devices the engine can reach, for the panel's picker. Empty
    /// first entry means "system default", which is what the panel expects.
    static func outputDeviceNames() -> [String] {
        #if os(iOS)
        // No picker on iOS: the output route belongs to the system and the
        // user changes it in Control Center. An empty list is what the panel
        // already renders as "system default", which is the truth here.
        return []
        #else
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
        #endif
    }

    init(capacity: Int = 96_000) {
        self.capacity = capacity - (capacity % 2)
        ring = UnsafeMutablePointer<Float>.allocate(capacity: capacity)
        ring.initialize(repeating: 0, count: capacity)
        #if os(iOS)
        observeSessionEvents()
        #endif
    }

    deinit {
        stop()
        ring.deallocate()
        #if os(iOS)
        for t in observers { NotificationCenter.default.removeObserver(t) }
        #endif
    }

    #if os(iOS)
    private var observers: [NSObjectProtocol] = []

    /// Category `.playback` is what makes this a receiver rather than a beep:
    /// it keeps audio alive with the screen locked and with the ring/silent
    /// switch set to silent. Combined with the bundle's `audio` background
    /// mode, the radio keeps playing when the app is not on screen.
    private func configureSession() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playback, mode: .default, options: [])
        try s.setActive(true)
    }

    /// A phone call, Siri, or a yanked headphone jack stops the engine without
    /// telling the producer, and the app then looks connected while playing
    /// nothing. Restarting on both notifications is the difference between a
    /// two-second gap and a silence that only a relaunch clears.
    private func observeSessionEvents() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main) { [weak self] note in
                guard let self,
                      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
                self.resumeAfterSystemStop()
            })
        observers.append(nc.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main) { [weak self] _ in
                self?.resumeAfterSystemStop()
            })
    }

    private func resumeAfterSystemStop() {
        guard sourceRate > 0, !engine.isRunning else { return }
        try? configureSession()
        try? engine.start()
    }
    #endif

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

        #if os(iOS)
        try configureSession()
        #endif

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
        // Fade in again from silence on the next buffer, as at a cold start.
        appliedGain = 0
    }

    /// Queues demodulated samples. Drops the oldest rather than blocking when
    /// the producer outruns the device: late audio is worthless, and blocking
    /// here would stall the network thread that feeds it.
    func write(_ samples: [Float]) {
        guard !samples.isEmpty, engine.isRunning else { return }
        let target = Float(muted ? 0 : min(max(volume, 0), 1))
        // Spread the change across the buffer. At the rates this runs at a
        // buffer is tens of milliseconds, so even a full-scale move arrives as
        // a fast fade rather than an edge — and muting stops popping too.
        let start = appliedGain
        let step = (target - start) / Float(samples.count)
        var gain = start
        lock.lock()
        var w = writeIndex
        for s in samples {
            ring[w] = s * gain
            gain += step
            w += 1
            if w == capacity { w = 0 }
        }
        appliedGain = target
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
