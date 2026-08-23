import Foundation

/// The app's own receiver: SpyServer in, spectrum frames out.
///
/// Phase 1 of docs/standalone-app-port.md. This is the spectrum path only —
/// no demodulation, no audio. It exists so the app can draw a live spectrum
/// with the plugin stopped, and so the FFT size stops being capped by what a
/// 200x100 LCD needed.
///
/// Emits `SpectrumFeed.Frame`, the same shape the plugin's socket delivers, so
/// the view does not know or care which source it is looking at. That is what
/// makes the two comparable side by side while both exist.
final class LocalRadio {

    private let client = SpyClient()
    private var fft: FFTPipeline?
    private let am = AMDemod()
    private let other = Demods()
    private let sink = AudioSink()
    private let leveler = OutputLeveler()
    private let iqnr = IqNr()
    /// Persisted settings. The app owns this; the plugin's config seeds it on a
    /// first run and is never written back to.
    var config = RadioConfig.load() {
        didSet { queue.async { self.configureDemods() } }
    }
    private let queue = DispatchQueue(label: "deck-rx.localradio")

    private(set) var isConnected = false
    /// Signal meters, measured from the IQ the demodulator just saw. dBFS
    /// against int16 full scale, so they read the same as the plugin's.
    private(set) var rssiDbfs: Double = -120
    private(set) var snrDb: Double = 0
    private(set) var lastError: String?
    private(set) var deviceInfo: SpyClient.DeviceInfo?

    var onFrame: ((SpectrumFeed.Frame) -> Void)?
    var onState: (() -> Void)?

    // Settings the caller drives.
    var fftSize = 4096 { didSet { queue.async { self.fft = FFTPipeline(self.fftSize) } } }
    var fps = 30
    var smoothingFactor: Float = 30
    /// Offset from the device's MinimumIQDecimation, matching SDR++'s srId.
    /// 1 puts an Airspy HF+ at about 456 kHz, which is the plugin's default and
    /// the reason far-adjacent FM stations stopped aliasing into baseband.
    var decimationOffset: UInt32 { config.iqDecimation }
    var gain: UInt32 { config.gain }
    /// Audio decimation from the IQ rate. 456 kHz / 48 = 9.5 kHz, which is
    /// enough for a 9 kHz AM channel and cheap to filter.
    /// IQ rate over this is the audio rate. The plugin's own default is 4,
    /// which at 456 kHz gives 114 kHz — deliberately high, because the FM
    /// stereo subcarrier lives at 38 kHz and has to survive the decimation.
    var audioDecimate: Int { config.audioDecimate * 12 }
    var bandwidthHz: Double { config.bandwidth(for: mode) }
    /// Demod mode. The numbering is not ours to choose: SDR++ assigns it, the
    /// plugin follows it, and it travels inside every preset and bookmark —
    /// `MODE_NAMES` in Receiver.swift is the same list.
    ///   0 NFM, 1 WFM, 2 AM, 3 DSB, 4 USB, 5 CW, 6 LSB, 7 RAW
    var mode: Int = 2 {
        // Persisted so the app comes back where it was left, not where the
        // plugin last happened to be.
        didSet {
            guard mode != oldValue else { return }
            config.mode = mode
            config.save()
            queue.async {
                self.configureDemods()
                self.applyNrMode()
                // Channel count is a property of the graph, so a mode change
                // that crosses mono/stereo has to rebuild it.
                if self.audioEnabled { self.restartAudio() }
            }
        }
    }
    var audioEnabled = false {
        didSet { if !audioEnabled { sink.stop() } else { restartAudio() } }
    }
    /// Master trim on top of the per-mode makeup, matching cfg.audioGain.
    var audioGain: Double { config.audioGain }
    /// IF noise reduction, FM modes only. Off by default, as on the deck.
    var iqNrEnabled = false { didSet { queue.async { self.applyNrMode() } } }
    /// Adaptive output AGC. Off by default: the static per-mode makeup is the
    /// leveller, and this one's level-riding is audible.
    var levelingEnabled: Bool {
        get { leveler.config.enabled }
        set {
            leveler.config.enabled = newValue
            if !newValue { leveler.reset() }
            config.levelingEnabled = newValue
            config.save()
        }
    }
    var volume: Double {
        get { sink.volume }
        set { sink.volume = newValue; config.volume = newValue; config.save() }
    }
    var muted: Bool {
        get { sink.muted }
        set { sink.muted = newValue; config.muted = newValue; config.save() }
    }
    private(set) var audioRate: Double = 0

    /// Tune step for tick-based control. Follows the mode so a knob click
    /// means the same thing it does on the deck.
    var tuneStepHz: Double { config.step(for: mode) }
    private(set) var frequency: UInt32 = 1_134_000
    private(set) var iqRate: UInt32 = 0
    var iqRateHz: UInt32 { iqRate }
    private var seq: UInt32 = 0

    /// Rolling IQ, trimmed to what the current FFT needs. Frames are built on a
    /// timer rather than per packet: packet size is the server's business, and
    /// tying the frame rate to it would make fps meaningless.
    private var iq = Data()
    private var frameTimer: DispatchSourceTimer?

    // MARK: control

    /// Connects using the persisted server address unless one is given. The
    /// app is meant to work with no plugin present, so the config is the source
    /// of truth for where the receiver is.
    func connect(host: String? = nil, port: UInt16? = nil, frequency freq: UInt32? = nil) {
        let host = host ?? config.host
        let port = port ?? UInt16(clamping: config.port)
        frequency = freq ?? UInt32(max(0, config.frequencyHz))
        sink.volume = config.volume
        sink.muted = config.muted
        leveler.config.enabled = config.levelingEnabled
        iqNrEnabled = config.fmIfnr
        lastError = nil
        queue.async { self.fft = FFTPipeline(self.fftSize) }

        client.onDeviceInfo = { [weak self] info in self?.start(with: info) }
        client.onIQ = { [weak self] pkt in self?.absorb(pkt) }
        client.onDisconnect = { [weak self] in
            guard let self else { return }
            self.isConnected = false
            self.stopFrameTimer()
            DispatchQueue.main.async { self.onState?() }
        }
        client.onError = { [weak self] e in
            guard let self else { return }
            self.lastError = e.localizedDescription
            DispatchQueue.main.async { self.onState?() }
        }

        client.connect(host: host, port: port) { [weak self] result in
            guard let self else { return }
            if case .failure(let e) = result {
                self.lastError = e.localizedDescription
                self.isConnected = false
                DispatchQueue.main.async { self.onState?() }
            }
        }
    }

    func disconnect() {
        sink.stop()
        client.stopStreaming()
        client.disconnect()
        isConnected = false
        stopFrameTimer()
        iq.removeAll(keepingCapacity: false)
        DispatchQueue.main.async { self.onState?() }
    }

    func tune(ticks: Int) {
        let delta = Double(ticks) * tuneStepHz
        let next = max(0, Double(frequency) + delta)
        setFrequency(UInt32(next))
    }

    func setFrequency(_ hz: UInt32) {
        frequency = hz
        config.frequencyHz = Double(hz)
        config.save()
        guard isConnected else { return }
        client.setFrequency(hz)
        am.resetForRetune()
        other.resetForRetune()
        // The bins are about to describe a different part of the spectrum; the
        // old ones are not a smaller version of the new ones.
        queue.async { self.iq.removeAll(keepingCapacity: true) }
    }

    // MARK: start-up

    private func start(with info: SpyClient.DeviceInfo) {
        deviceInfo = info
        let decStage = decimationOffset + info.minIQDecimation
        iqRate = UInt32(Double(info.maxSampleRate) / Double(1 << decStage))
        let g = min(gain, info.maxGainIndex)
        let digital = computeDigitalGain(deviceType: info.deviceType, deviceGain: g,
                                         decimationStage: decStage, maxGainIndex: info.maxGainIndex)

        // SDR++'s start order (main.cpp): FORMAT, DECIMATION, FREQUENCY, MODE,
        // GAIN, DIGITAL_GAIN, ENABLED. Servers have been observed to ignore
        // settings sent after streaming starts, so the order is not cosmetic.
        client.setSetting(.iqFormat, SpyClient.IQFormat.int16.rawValue)
        client.setSetting(.iqDecimation, decStage)
        client.setSetting(.iqFrequency, frequency)
        client.setSetting(.streamingMode, SpyClient.streamModeIQOnly)
        client.setSetting(.gain, g)
        client.setSetting(.iqDigitalGain, digital)
        client.setSetting(.streamingEnabled, 1)

        isConnected = true
        audioRate = Double(iqRate) / Double(max(1, audioDecimate))
        configureDemods()
        if audioEnabled { restartAudio() }
        startFrameTimer()
        DispatchQueue.main.async { self.onState?() }
    }

    // MARK: IQ -> frames

    /// Rebuilds every filter for the current rates and mode. Cheap enough to
    /// run on any change, and doing it in one place is what keeps the AM and
    /// non-AM paths from drifting into different ideas of the same rate.
    private func configureDemods() {
        guard iqRate > 0, audioRate > 0 else { return }
        let iq = Double(iqRate)
        am.reset()
        am.setBandwidth(audioRate: audioRate, bandwidthHz: config.amBandwidthHz, iqRate: iq)
        am.configureSync(rate: audioRate)
        am.agcEnabled = config.amCarrierAgc
        am.syncEnabled = config.amSync
        other.reset()
        other.setWfmAudioBand(iqRate: iq)
        other.setWfmIfBandwidth(iqRate: iq, cutoffHz: config.fmBandwidthHz / 2)
        other.setDeemphasis(audioRate: audioRate, tau: config.deemphasisTau)
        other.setupSSB(iqRate: iq, audioRate: audioRate)
        other.setupCW(iqRate: iq)
        other.setAudioFilters(rate: audioRate, lowPassHz: 0, highPassHz: 0)
        other.setStereoAudioFilters(rate: audioRate, lowPassHz: 0, highPassHz: 0)
        applyNrMode()
    }

    /// WFM is the only stereo mode, so the sink's channel count follows it.
    var isStereoMode: Bool { mode == 1 && config.fmStereo }
    var stereoLocked: Bool { other.stereoLocked }

    private func applyNrMode() {
        iqnr.reset()
        iqnr.setMode(iqNrEnabled ? mode : -1)
    }

    /// Test seam. Demodulation is otherwise reachable only through a live
    /// SpyServer connection, which is exactly why the mode routing went wrong
    /// unnoticed — there was no way to ask "which detector does index 1 pick?"
    /// without a receiver on the air.
    func demodulateForTesting(_ body: Data, iqRate rate: UInt32) -> [Float] {
        iqRate = rate
        audioRate = Double(rate) / Double(max(1, audioDecimate))
        configureDemods()
        return demodulate(body)
    }

    private func demodulate(_ rawBody: Data) -> [Float] {
        // NR runs on the IQ before the demodulator, which is where the FMIF
        // tracking filter belongs — after detection the noise is already mixed
        // into the audio.
        let body = iqNrEnabled ? iqnr.process(rawBody) : rawBody
        let g = Double(gain) / 10.0
        switch mode {
        case 0:  return other.processFM(int16IQ: body, decimate: audioDecimate)
        case 1, 3:
                 return config.fmStereo && mode == 1
                    ? other.processWFMStereo(int16IQ: body, decimate: audioDecimate)
                    : other.processWFM(int16IQ: body, decimate: audioDecimate)
        case 4:  return other.processSSB(int16IQ: body, decimate: audioDecimate, upperSideband: true)
        case 6:  return other.processSSB(int16IQ: body, decimate: audioDecimate, upperSideband: false)
        case 5:  return other.processCW(int16IQ: body, decimate: audioDecimate)
        default: return am.process(int16IQ: body, decimate: audioDecimate, gainScale: g)
        }
    }

    /// Makeup, optional AGC, then the soft ceiling — the plugin's order, and
    /// the order matters: limiting before the gain would waste the headroom the
    /// makeup is there to use.
    private func level(_ pcm: inout [Float]) {
        let makeup = (AudioLeveling.modeMakeup[mode] ?? 1) * audioGain
        let dt = audioRate > 0 ? Double(pcm.count) / (audioRate * (isStereoMode ? 2 : 1)) : 0
        let g = leveler.observe(pcm, makeup: makeup, dt: dt) * makeup
        guard g != 1 || leveler.config.enabled else { return }
        for i in 0..<pcm.count {
            // int16 domain, because that is what the limiter's knee is
            // calibrated in.
            let v = Double(pcm[i]) * 32768 * g
            pcm[i] = Float(AudioLeveling.softLimit(v) / 32768)
        }
    }

    private func restartAudio() {
        guard audioRate > 0 else { return }
        do { try sink.start(sourceRate: audioRate, channels: isStereoMode ? 2 : 1) }
        catch { lastError = "audio: \(error.localizedDescription)" }
    }

    private func absorb(_ pkt: SpyClient.IQPacket) {
        guard pkt.format == .int16 else { return }   // we asked for int16
        queue.async {
            // Demodulate per packet, not per display frame: audio has to be
            // continuous, and the frame timer deliberately skips samples.
            if self.audioEnabled, self.audioRate > 0 {
                var pcm = self.demodulate(pkt.body)
                if !pcm.isEmpty {
                    self.level(&pcm)
                    self.sink.write(pcm)
                }
            }
            self.measure(pkt.body)
            self.iq.append(pkt.body)
            // Keep a little more than one transform's worth. Unbounded growth
            // here is how a receiver quietly turns into a memory leak.
            let need = self.fftSize * 4 * 2
            if self.iq.count > need {
                self.iq.removeSubrange(0 ..< (self.iq.count - need))
            }
        }
    }

    /// RSSI is the packet's mean power; SNR is the peak bin over the median
    /// bin of the last spectrum frame. Median rather than mean for the floor —
    /// a strong carrier drags a mean upward and would report its own presence
    /// as a worse noise floor.
    private func measure(_ body: Data) {
        let n = body.count / 4
        guard n > 0 else { return }
        var sumSq = 0.0
        body.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let base = raw.baseAddress!
            for i in 0..<n {
                let I = Double(base.loadUnaligned(fromByteOffset: i * 4, as: Int16.self).littleEndian)
                let Q = Double(base.loadUnaligned(fromByteOffset: i * 4 + 2, as: Int16.self).littleEndian)
                sumSq += I * I + Q * Q
            }
        }
        let meanP = sumSq / Double(n)
        let db = meanP > 1 ? 10 * log10(meanP / (32767.0 * 32767.0)) : -120
        rssiDbfs = rssiDbfs * 0.8 + db * 0.2
    }

    /// Preset stepping, shared with the control endpoint. Returns the frequency
    /// landed on, or nil when there is nothing receivable to land on — the
    /// caller turns that into a 409 rather than a silent success.
    func stepPreset(_ dir: Int) -> UInt32? {
        let presets = Receiver.presets().sorted { $0.freq < $1.freq }
        guard !presets.isEmpty else { return nil }
        let cur = Double(frequency)
        let next: Receiver.Preset?
        if dir > 0 {
            next = presets.first { $0.freq > cur + 1 } ?? presets.first
        } else {
            next = presets.last { $0.freq < cur - 1 } ?? presets.last
        }
        guard let p = next else { return nil }
        mode = p.mode
        setFrequency(UInt32(max(0, p.freq)))
        return UInt32(max(0, p.freq))
    }

    private func startFrameTimer() {
        stopFrameTimer()
        let t = DispatchSource.makeTimerSource(queue: queue)
        let period = 1.0 / Double(max(1, fps))
        t.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in self?.buildFrame() }
        frameTimer = t
        t.resume()
    }

    private func stopFrameTimer() {
        frameTimer?.cancel()
        frameTimer = nil
    }

    private func buildFrame() {
        guard let fft, iq.count >= fftSize * 4,
              let bins = fft.process(int16IQ: iq, smoothingFactor: smoothingFactor) else { return }
        seq &+= 1
        // SNR from the frame we just built: peak over median. Free here, and
        // it saves a second FFT purely for the meter.
        let sorted = bins.sorted()
        let median = Double(sorted[sorted.count / 2])
        let peak = Double(sorted[sorted.count - 1])
        snrDb = max(0, peak - median)
        let frame = SpectrumFeed.Frame(bins: bins, iqRate: iqRate,
                                       centerFreq: frequency, seq: seq)
        DispatchQueue.main.async { self.onFrame?(frame) }
    }
}
