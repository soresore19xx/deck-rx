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

    /// How far behind the demodulator the listener is, in seconds.
    ///
    /// What the ring holds has been produced and not yet played, so its depth
    /// is the distance between a signal arriving and the same signal being
    /// audible. On iOS the session's own output latency is added: over
    /// Bluetooth that is the larger half of the answer by some way.
    var latencySeconds: Double {
        guard sourceRate > 0, channels > 0, engine.isRunning else { return 0 }
        lock.lock()
        var used = writeIndex - readIndex
        lock.unlock()
        if used < 0 { used += capacity }
        var secs = Double(used / Int(channels)) / sourceRate
        #if os(iOS)
        secs += AVAudioSession.sharedInstance().outputLatency
        #endif
        return secs
    }

    /// Output stays silent until this many frames are banked. Reading from a
    /// ring that has just started filling means the very first jitter empties
    /// it, and every refill after that starts from empty again — audible as
    /// the audio breaking up every few seconds while the numbers say the
    /// stream is fine. A fifth of a second is below the threshold where a
    /// tuning action feels delayed.
    private var priming = true
    private var primeFrames = 0

    /// Fractional position inside the current frame, and how fast the reader
    /// walks the ring. 1.0 is "one input frame per output frame".
    private var readFrac: Double = 0
    private var rate: Double = 1

    /// How fast to read, given how full the ring is.
    ///
    /// The sender's clock (the receiver's crystal, by way of the server) and
    /// this device's audio clock are independent and drift apart by tens of
    /// parts per million. With a fixed conversion ratio that difference has
    /// nowhere to go: the ring fills until it overflows, or empties until it
    /// underruns, and the only question is which. The plugin answers it with
    /// libsamplerate, trimming the resampling ratio to hold its queue at a
    /// set depth. This is the same loop, one level down — the ring is read a
    /// hair faster when it is fuller than the target and a hair slower when it
    /// is emptier, which is what keeps latency at the target instead of
    /// wandering between the prime depth and the ring's size.
    ///
    /// The correction is capped at 0.4%, two orders of magnitude more than the
    /// drift it exists to cancel, and it is approached slowly: a ratio that
    /// jumps is heard as a pitch waver, where 0.4% held steady is under three
    /// cents and inaudible.
    static func trackedRate(fillFrames: Int, target: Int, current: Double) -> Double {
        guard target > 0 else { return 1 }
        let err = Double(fillFrames - target) / Double(target)
        let wanted = 1 + max(-0.004, min(0.004, err * 0.05))
        return current + 0.02 * (wanted - current)
    }

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

    /// Which output to play through, by the name the picker showed. Empty is
    /// the system default.
    ///
    /// This was collected, stored, listed in the panel and never once applied:
    /// the setting round-tripped through the config file while the audio went
    /// to whatever the system default was. A row that remembers a choice and
    /// ignores it is worse than no row, and it reads as "the app has no sound"
    /// when the default output is not what you are listening on.
    var deviceName: String = ""

    #if !os(iOS)
    /// The device id behind a name from `outputDeviceNames()`, or nil. Matched
    /// exactly, including the trailing spaces CoreAudio puts in some names
    /// ("DX7s ", "SMSL USB AUDIO ") — those are part of the name, and trimming
    /// here would fail to find the very devices the picker offered.
    private static func outputDeviceID(named name: String) -> AudioObjectID? {
        guard !name.isEmpty else { return nil }
        var size = UInt32(0)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &addr, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &ids) == noErr else { return nil }
        for id in ids {
            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var nameRef: Unmanaged<CFString>?
            var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &nameRef) == noErr,
                  let s = nameRef?.takeRetainedValue() as String?, s == name else { continue }
            return id
        }
        return nil
    }
    #endif

    /// Default sized for the rate this actually runs at: 114 kHz stereo is
    /// 228 000 samples a second, so the old 96 000 was 0.42 s of cushion —
    /// less than a single Wi-Fi retransmission burst. The plugin rides out
    /// stalls of 250-630 ms without dropping anything (README, "Reader-stall
    /// absorb"), and this is the equivalent room: about 1.1 s.
    init(capacity: Int = 262_144) {
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

        // 0.12 s. The depth only has to cover jitter now that trackedRate
        // cancels the drift, and this is what the user hears as the delay
        // between turning the dial and the audio following.
        primeFrames = Int(rate * 0.12)
        priming = true
        readFrac = 0
        self.rate = 1
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
            // Silence while priming, and not counted as a drop: nothing has
            // been lost, the buffer is simply still filling.
            if self.priming {
                if available / chans >= self.primeFrames {
                    self.priming = false
                } else {
                    for c in 0..<min(chans, abl.count) {
                        if let out = abl[c].mData?.assumingMemoryBound(to: Float.self) {
                            for i in 0..<n { out[i] = 0 }
                        }
                    }
                    return noErr
                }
            }
            var availFrames = available / chans
            self.rate = Self.trackedRate(fillFrames: availFrames,
                                         target: self.primeFrames,
                                         current: self.rate)
            // Channel pointers taken once. Non-interleaved output is one buffer
            // per channel, and there are only ever one or two of them, so this
            // costs no allocation on a realtime thread.
            let out0 = abl.count > 0 ? abl[0].mData?.assumingMemoryBound(to: Float.self) : nil
            let out1 = chans > 1 && abl.count > 1
                ? abl[1].mData?.assumingMemoryBound(to: Float.self) : nil
            var idx = r
            var frac = self.readFrac
            var produced = 0
            // Two frames of headroom: interpolation reads the next one as well.
            while produced < n && availFrames >= 2 {
                let f = Float(frac)
                var i0 = idx
                if i0 >= self.capacity { i0 -= self.capacity }
                var i1 = i0 + chans
                if i1 >= self.capacity { i1 -= self.capacity }
                if let o = out0 { o[produced] = self.ring[i0] * (1 - f) + self.ring[i1] * f }
                if let o = out1 {
                    var j0 = i0 + 1, j1 = i1 + 1
                    if j0 >= self.capacity { j0 -= self.capacity }
                    if j1 >= self.capacity { j1 -= self.capacity }
                    o[produced] = self.ring[j0] * (1 - f) + self.ring[j1] * f
                }
                produced += 1
                frac += self.rate
                while frac >= 1 {
                    frac -= 1
                    idx += chans
                    if idx >= self.capacity { idx -= self.capacity }
                    availFrames -= 1
                }
            }
            if let o = out0 { for i in produced..<n { o[i] = 0 } }
            if let o = out1 { for i in produced..<n { o[i] = 0 } }
            if produced < n {
                self.underruns += n - produced
                // Ran dry: refill before reading again, instead of scraping
                // the bottom of the ring buffer by buffer for the next second.
                self.priming = true
                self.rate = 1
                frac = 0
            }
            self.readFrac = frac
            self.readIndex = idx
            return noErr
        }
        source = node
        engine.attach(node)
        #if !os(iOS)
        // Before the graph is built and before the engine starts: the output
        // unit's device cannot be changed underneath a running engine, and the
        // mixer's format is negotiated against whatever device is set here.
        // A name that no longer resolves — the device was unplugged since it
        // was chosen — falls through to the system default rather than
        // refusing to play at all.
        if let id = Self.outputDeviceID(named: deviceName) {
            do { try engine.outputNode.auAudioUnit.setDeviceID(id) }
            catch { NSLog("[audio] could not open \(deviceName): \(error.localizedDescription)") }
        }
        #endif
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 1
        engine.prepare()
        try engine.start()
    }

    // MARK: post-mix capture

    private var mixTapFd: Int32 = -1
    private var mixTapBytes = 0
    private var mixTapPath = ""
    private var mixTapLastCheck = Date.distantPast
    private var mixTapInstalled = false

    /// What the engine hands the device, after its own rate conversion — the
    /// counterpart of the plugin's post-ASRC tap, and the half of the path the
    /// demodulator-side flag cannot see.
    ///
    /// `touch /tmp/deck-rx-solo-postmix-record` to start, `rm` to stop. The
    /// producer side runs at the audio rate (114 kHz here) and AVAudioEngine
    /// converts to whatever the output device wants; distortion that appears
    /// only between the two taps belongs to that conversion or to the volume
    /// ramp, neither of which the earlier tap passes through.
    ///
    /// An engine tap is delivered on its own queue, not the render thread, so
    /// writing a file from it is what the API is for.
    private func pollMixTap() {
        let now = Date()
        guard now.timeIntervalSince(mixTapLastCheck) > 0.5 else { return }
        mixTapLastCheck = now
        let wanted = FileManager.default.fileExists(atPath: "/tmp/deck-rx-solo-postmix-record")
        if wanted, !mixTapInstalled, engine.isRunning {
            let bus = engine.mainMixerNode.outputFormat(forBus: 0)
            guard bus.sampleRate > 0, bus.channelCount > 0 else { return }
            let ch = Int(bus.channelCount), rate = Int(bus.sampleRate)
            let stamp = ISO8601DateFormatter().string(from: now)
                .replacingOccurrences(of: ":", with: "-")
                .replacingOccurrences(of: "T", with: "-")
                .replacingOccurrences(of: "Z", with: "")
            let path = "/tmp/deck-rx-solo-postmix-\(stamp).wav"
            var h = Data(count: 44)
            func put32(_ o: Int, _ v: Int) {
                var le = UInt32(truncatingIfNeeded: v).littleEndian
                withUnsafeBytes(of: &le) { h.replaceSubrange(o..<o+4, with: $0) }
            }
            func put16(_ o: Int, _ v: Int) {
                var le = UInt16(truncatingIfNeeded: v).littleEndian
                withUnsafeBytes(of: &le) { h.replaceSubrange(o..<o+2, with: $0) }
            }
            h.replaceSubrange(0..<4, with: Array("RIFF".utf8)); put32(4, 36)
            h.replaceSubrange(8..<12, with: Array("WAVE".utf8))
            h.replaceSubrange(12..<16, with: Array("fmt ".utf8))
            put32(16, 16); put16(20, 1); put16(22, ch); put32(24, rate)
            put32(28, rate * ch * 2); put16(32, ch * 2); put16(34, 16)
            h.replaceSubrange(36..<40, with: Array("data".utf8)); put32(40, 0)
            let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
            guard fd >= 0 else { return }
            _ = h.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, 44) }
            mixTapFd = fd; mixTapBytes = 0; mixTapPath = path
            engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buf, _ in
                guard let self, self.mixTapFd >= 0,
                      let chans = buf.floatChannelData else { return }
                let n = Int(buf.frameLength), c = Int(buf.format.channelCount)
                var pcm = [Int16](repeating: 0, count: n * c)
                for f in 0..<n {
                    for k in 0..<c {
                        let v = max(-1, min(1, Double(chans[k][f]))) * 32767
                        pcm[f * c + k] = Int16(v.rounded())
                    }
                }
                pcm.withUnsafeBytes { _ = Darwin.write(self.mixTapFd, $0.baseAddress, $0.count) }
                self.mixTapBytes += pcm.count * 2
            }
            mixTapInstalled = true
            NSLog("[tap] post-mix → \(path) (\(rate) Hz x \(ch) ch)")
        } else if !wanted, mixTapInstalled {
            closeMixTap()
        }
    }

    private func closeMixTap() {
        guard mixTapInstalled else { return }
        engine.mainMixerNode.removeTap(onBus: 0)
        mixTapInstalled = false
        guard mixTapFd >= 0 else { return }
        var riff = UInt32(36 + mixTapBytes).littleEndian
        var data = UInt32(mixTapBytes).littleEndian
        withUnsafeBytes(of: &riff) { _ = pwrite(mixTapFd, $0.baseAddress, 4, 4) }
        withUnsafeBytes(of: &data) { _ = pwrite(mixTapFd, $0.baseAddress, 4, 40) }
        close(mixTapFd)
        NSLog("[tap] post-mix closed: \(mixTapPath) (\(mixTapBytes) bytes)")
        mixTapFd = -1; mixTapBytes = 0
    }

    func stop() {
        closeMixTap()
        readFrac = 0
        rate = 1
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
        pollMixTap()
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
            // A fifth of a second of audio, not half the ring: with a ring this
            // size, half of it would put the listener most of a second behind
            // the tuning knob for the rest of the session.
            var back = min(capacity / 2, Int(sourceRate * 0.12) * chans)
            back -= back % chans
            var r = w - back
            if r < 0 { r += capacity }
            readIndex = r
        }
        lock.unlock()
    }
}
