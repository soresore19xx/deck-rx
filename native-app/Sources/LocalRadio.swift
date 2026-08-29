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
    /// Output is silenced until this instant. The plugin keeps the same window
    /// (spyService.ts:362) and opens it around anything that steps the signal —
    /// a gain change, a retune, a mode change — because the step itself is
    /// louder than the programme. Nothing here had it.
    private var muteUntil = Date.distantPast
    /// The pending gain apply, so a run of taps becomes one apply.
    private var gainApply: DispatchWorkItem?

    /// Longest gap between two IQ packets in the last ten seconds, in ms.
    ///
    /// This is what separates the two causes of an output underrun. IQ arrives
    /// continuously while the stream runs, so a large gap means the samples
    /// were late — the network or the server. A small gap with drops climbing
    /// means they arrived on time and this end could not keep up. Without it,
    /// "the audio breaks up" is a description that fits both.
    private(set) var maxPacketGapMs: Double = 0
    private var lastPacketAt = Date.distantPast
    private var gapWindowStart = Date.distantPast
    private let iqnr = IqNr()
    /// Persisted settings. The app owns this; the plugin's config seeds it on a
    /// first run and is never written back to.
    var config = RadioConfig.load() {
        didSet { applyConfig(changedFrom: oldValue) }
    }
    /// Audio only, and at a priority that says so. Demodulating a packet and
    /// handing it to the sink is the one thing here with a deadline.
    private let queue = DispatchQueue(label: "deck-rx.localradio", qos: .userInitiated)
    /// The spectrum and the meters. Both were on the audio queue, which meant
    /// every packet paid for a 456 kHz RMS pass and a `Data` head-removal
    /// before the next one could be demodulated, and the 30 Hz FFT could land
    /// between a packet and its audio. None of that has a deadline; audio does.
    private let auxQueue = DispatchQueue(label: "deck-rx.localradio.display", qos: .utility)

    private(set) var isConnected = false
    /// Signal meters, measured from the IQ the demodulator just saw. dBFS
    /// against int16 full scale, so they read the same as the plugin's.
    /// SpyServer takes several clients at once, but only the first one may
    /// steer the device. A later client's retune is accepted and ignored — no
    /// error, no reply, the frequency simply does not move. Reported so the
    /// window can say so instead of looking broken.
    private(set) var canControl = true
    /// What the server says the device is actually tuned to. When we cannot
    /// control it, this is where the radio really is, and the frequency we
    /// asked for is fiction.
    private(set) var deviceFreq: UInt32 = 0
    private(set) var rssiDbfs: Double = -120
    private(set) var snrDb: Double = 0
    private(set) var lastError: String?
    private(set) var deviceInfo: SpyClient.DeviceInfo?

    var onFrame: ((SpectrumFeed.Frame) -> Void)?
    var onState: (() -> Void)?

    // Settings the caller drives.
    var fftSize = 4096 { didSet { auxQueue.async { self.fft = FFTPipeline(self.fftSize) } } }
    var fps = 30
    var smoothingFactor: Float = 30
    /// Offset from the device's MinimumIQDecimation, matching SDR++'s srId.
    /// 1 puts an Airspy HF+ at about 456 kHz, which is the plugin's default and
    /// the reason far-adjacent FM stations stopped aliasing into baseband.
    var decimationOffset: UInt32 { config.iqDecimation }
    /// The device's own ceiling, and the gain index in force for each demod
    /// family. Resolved the way the plugin resolves it (spyService.ts:469-472):
    /// the stored index when there is one, the device's maximum when there is
    /// not, clamped to that maximum either way. 8 stands in until the first
    /// DeviceInfo arrives — the ceiling both options panels are built around.
    var maxGainIndex: UInt32 { deviceInfo?.maxGainIndex ?? 8 }
    var amGainIndex: UInt32 { min(config.amGain ?? maxGainIndex, maxGainIndex) }
    var fmGainIndex: UInt32 { min(config.fmGain ?? maxGainIndex, maxGainIndex) }
    /// What the server is told to use. AM is the split, exactly as
    /// spyService.ts:1214 draws it — every other mode takes the FM value.
    var gain: UInt32 { mode == 2 ? amGainIndex : fmGainIndex }
    /// Audio decimation from the IQ rate; the audio rate is the IQ rate over
    /// this. Exactly what the plugin does — `Math.max(1, cfg.audioDecimate)`,
    /// spyService.ts:1206 — and nothing else.
    ///
    /// This used to be `config.audioDecimate * 12`, a factor that exists in no
    /// other implementation. With the plugin's own config (audioDecimate 4,
    /// iqDecimation 1) it turned a 114 kHz audio rate into 9.5 kHz, whose
    /// Nyquist is 4.75 kHz — below the 15 kHz the anti-alias filter in front of
    /// the decimator is set to. Measured: a 6 kHz tone came out at 3.5 kHz.
    /// That is what made sibilants sound wrong, and it was invented here.
    var audioDecimate: Int { max(1, config.audioDecimate) }

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
            // spyService.ts:1135 and :1168. Crossing the AM boundary changes
            // the gain the server is holding as well as the detector, and that
            // transient is the loudest in the system.
            let crossesAM = (mode == 2) != (oldValue == 2)
            muteUntil = max(muteUntil, Date().addingTimeInterval(crossesAM ? 0.25 : 0.1))
            queue.async {
                self.configureDemods()
                // Crossing the boundary changes which of the two gain indices
                // is in force, so the server has to be told
                // (spyService.ts:1164). Without this the AM value stayed on
                // the device through an FM session and back. On the queue, as
                // applyConfig sends it: it resets both demodulators.
                if crossesAM { self.sendGain() }
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
    var tuneStepHz: Double { config.step(for: mode, hz: Double(frequency)) }

    /// Remember the step against the band it was chosen in, the way the plugin
    /// does on a band crossing (spyService.ts:1091), so moving away and back
    /// returns the step the user set there.
    func setTuneStep(_ hz: Double) {
        guard hz > 0 else { return }
        config.tuneStepByMode[RadioConfig.stepKey(mode: mode, hz: Double(frequency))] = hz
        config.tuneStepHz = hz
        config.save()
    }
    private(set) var frequency: UInt32 = 1_134_000
    private(set) var iqRate: UInt32 = 0
    var iqRateHz: UInt32 { iqRate }
    private var seq: UInt32 = 0

    /// Rolling IQ, trimmed to what the current FFT needs. Frames are built on a
    /// timer rather than per packet: packet size is the server's business, and
    /// tying the frame rate to it would make fps meaningless.
    private var iq = Data()
    private var frameTimer: DispatchSourceTimer?

    /// Reconnect state. A receiver that drops off the air and stays off is
    /// worse than one that never started: the window keeps showing the last
    /// frequency and nothing says the link is gone.
    private var wantConnection = false
    private var reconnectTimer: DispatchSourceTimer?
    private var reconnectDelay: TimeInterval = 1
    private static let reconnectMax: TimeInterval = 30

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
        connectHost = host
        connectPort = port
        wantConnection = true
        reconnectDelay = 1
        openConnection()
    }

    private var connectHost = ""
    private var connectPort: UInt16 = 5555

    /// The connection attempt itself, separated from `connect` so a retry does
    /// not re-run the setup — and so the address it dials is the one recorded,
    /// not whatever the config says now.
    private func openConnection() {
        let host = connectHost
        let port = connectPort
        // The error is NOT cleared here. Each retry used to blank it, so a
        // receiver that had been failing for an hour showed nothing at all
        // between attempts. It clears when a connection actually succeeds.
        auxQueue.async { self.fft = FFTPipeline(self.fftSize) }

        client.onDeviceInfo = { [weak self] info in self?.start(with: info) }
        client.onIQ = { [weak self] pkt in self?.absorb(pkt) }
        client.onSync = { [weak self] sync in
            guard let self else { return }
            let was = self.canControl
            self.canControl = sync.canControl
            self.deviceFreq = sync.iqCenterFreq
            // Follow the device when we cannot steer it, or the readout claims
            // a frequency the receiver is not on.
            if !sync.canControl, sync.iqCenterFreq > 0, self.frequency != sync.iqCenterFreq {
                self.frequency = sync.iqCenterFreq
            }
            if was != sync.canControl { DispatchQueue.main.async { self.onState?() } }
        }
        client.onDisconnect = { [weak self] in
            guard let self else { return }
            self.isConnected = false
            self.stopFrameTimer()
            DispatchQueue.main.async { self.onState?() }
            self.scheduleReconnect()
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
                self.scheduleReconnect()
            }
        }
    }

    /// Backs off to `reconnectMax` and stays there. The server being down for
    /// an hour is normal; hammering it every second for that hour is not, and
    /// giving up entirely means noticing by ear that the radio went quiet.
    private func scheduleReconnect() {
        guard wantConnection else { return }
        reconnectTimer?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, Self.reconnectMax)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + delay)
        t.setEventHandler { [weak self] in
            guard let self, self.wantConnection, !self.isConnected else { return }
            self.lastError = "reconnecting..."
            DispatchQueue.main.async { self.onState?() }
            self.openConnection()
        }
        reconnectTimer = t
        t.resume()
    }

    func disconnect() {
        wantConnection = false
        // Asked for, so there is nothing to report. Any error still in flight
        // describes the connection we are closing on purpose.
        lastError = nil
        reconnectTimer?.cancel(); reconnectTimer = nil
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
        // Refuse rather than pretend. A second client's retune is dropped by
        // the server without a word, so accepting it here would leave the
        // window showing a frequency nothing is receiving.
        guard canControl else { return }
        frequency = hz
        config.frequencyHz = Double(hz)
        config.save()
        guard isConnected else { return }
        // spyService.ts:789. `resetForRetune()` zeroes the AM DC and carrier
        // AGC, which then needs 150-200 ms to re-converge on the new station's
        // level; the FM modes settle in half that. Without the window the
        // residual level step is audible as a click on every retune.
        muteUntil = max(muteUntil, Date().addingTimeInterval(mode == 2 ? 0.2 : 0.1))
        client.setFrequency(hz)
        am.resetForRetune()
        other.resetForRetune()
        // The bins are about to describe a different part of the spectrum; the
        // old ones are not a smaller version of the new ones.
        auxQueue.async { self.iq.removeAll(keepingCapacity: true) }
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
        lastError = nil
        reconnectDelay = 1        // a good connection earns a fast first retry
        reconnectTimer?.cancel(); reconnectTimer = nil
        configureDemods()
        // spyService.ts:1265 — covers the device's own start-up pop and the
        // demodulator's first samples (atan2 on a near-zero previous I/Q, AM's
        // DC settling).
        muteUntil = max(muteUntil, Date().addingTimeInterval(0.5))
        if audioEnabled { restartAudio() }
        startFrameTimer()
        DispatchQueue.main.async { self.onState?() }
    }

    // MARK: IQ -> frames

    /// Rebuilds every filter for the current rates and mode. Cheap enough to
    /// run on any change, and doing it in one place is what keeps the AM and
    /// non-AM paths from drifting into different ideas of the same rate.
    private func configureDemods() {
        guard iqRate > 0 else { return }
        // Derived here rather than at the call sites: it follows the mode as
        // well as the IQ rate, and a mode change that did not recompute it
        // left the FM detectors running at the rate AM had asked for.
        audioRate = Double(iqRate) / Double(max(1, audioDecimate))
        let iq = Double(iqRate)
        am.reset()
        am.setBandwidth(audioRate: audioRate, bandwidthHz: config.amBandwidthHz, iqRate: iq)
        am.configureSync(rate: audioRate)
        // rate -> per-sample alpha at the live audio rate (spyService.ts:947).
        am.agcAttack = max(0, min(1, config.amAgcAttack / audioRate))
        am.agcDecay = max(0, min(1, config.amAgcDecay / audioRate))
        am.agcEnabled = config.amCarrierAgc
        am.syncEnabled = config.amSync
        other.reset()
        other.setWfmAudioBand(iqRate: iq)
        other.setWfmIfBandwidth(iqRate: iq, cutoffHz: config.fmBandwidthHz / 2)
        other.setDeemphasis(audioRate: audioRate, tau: config.deemphasisTau)
        other.setupSSB(iqRate: iq, audioRate: audioRate)
        other.setupCW(iqRate: iq)
        // The plugin's own values (spyService.ts:862): the low pass is 15 kHz
        // when asked for and 0.45 of the audio rate when not — never off — and
        // the high pass is 30 Hz or nothing. Both were hard-coded to zero here,
        // so "Audio LPF" and "Audio HPF" in the options sheet did nothing at
        // all and the audio kept whatever the decimator handed over.
        let lpf = config.fmLowPass ? 15_000 : audioRate * 0.45
        let hpf = config.fmHighPass ? 30.0 : 0
        other.setAudioFilters(rate: audioRate, lowPassHz: lpf, highPassHz: hpf)
        other.setStereoAudioFilters(rate: audioRate, lowPassHz: lpf, highPassHz: hpf)
        applyNrMode()
    }

    /// Samples the output asked for and the ring did not have. The honest
    /// measure of "the audio breaks up": it climbs only when the producer is
    /// behind, so a flat count during choppy audio points at the output side
    /// instead.
    var audioUnderruns: Int { sink.underruns }

    /// WFM is the only stereo mode, so the sink's channel count follows it.
    var isStereoMode: Bool { mode == 1 && config.fmStereo }
    var stereoLocked: Bool { other.stereoLocked }
    var pilotMetric: Double { other.pilotMetric }

    /// Push `config` into the running receiver.
    ///
    /// Called from `config`'s own `didSet`, so it does not matter who wrote the
    /// setting — the iPad's options sheet, the control server, or a restore.
    /// Rebuilding the filters was already happening; the two things that were
    /// not are the reason the panel looked inert:
    ///
    /// - **RF gain lives on the server.** It is not a filter here, so nothing
    ///   was rebuilt and nothing was sent. The control had no effect at all.
    /// - **Stereo changes the shape of the audio graph.** Turning it off makes
    ///   the demodulator produce one channel while the sink is still wired for
    ///   two, so a mono signal is read as interleaved stereo — which is what
    ///   "the audio breaks when I turn stereo off" was.
    ///
    /// `previous` skips the parts that did not move. Passing nil applies
    /// everything, for a caller who changed something outside `config`.
    func applyConfig(changedFrom previous: RadioConfig? = nil) {
        if let p = previous, p == config { return }
        let gainChanged = previous.map {
            $0.amGain != config.amGain || $0.fmGain != config.fmGain
        } ?? true
        let graphChanged = previous.map {
            $0.fmStereo != config.fmStereo || $0.audioDecimate != config.audioDecimate
        } ?? true
        queue.async {
            self.configureDemods()
            if gainChanged { self.sendGain() }
            if graphChanged, self.audioEnabled { self.restartAudio() }
        }
    }

    /// The gain settings the server holds, resent at the value config now says.
    /// Same pair and the same derivation as the connect sequence, so a gain
    /// changed while running lands where a gain chosen before connecting does.
    /// The plugin's `setGainInternal` (spyService.ts:722), step for step.
    ///
    /// Sending the two settings is only part of it. Changing the gain is an
    /// amplitude step on the IQ followed by the server's own AGC settling, and
    /// the demodulator's running state then describes a signal that no longer
    /// exists. Without the mute a pop punches through; without the full reset
    /// the detectors take their own time to catch up — which is what "the gain
    /// does nothing" sounds like. The debounce groups a run of taps into one
    /// apply, and `reset()` clears state without touching the coefficients.
    private func sendGain() {
        guard isConnected, deviceInfo != nil else { return }
        muteUntil = max(muteUntil, Date().addingTimeInterval(0.2))
        am.reset()
        other.reset()
        gainApply?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isConnected, let info = self.deviceInfo else { return }
            let decStage = self.decimationOffset + info.minIQDecimation
            let g = min(self.gain, info.maxGainIndex)
            let digital = computeDigitalGain(deviceType: info.deviceType, deviceGain: g,
                                             decimationStage: decStage,
                                             maxGainIndex: info.maxGainIndex)
            // Re-muted and reset around the apply itself, so the transient is
            // covered even after the debounce window has elapsed.
            self.muteUntil = max(self.muteUntil, Date().addingTimeInterval(0.15))
            self.am.reset()
            self.other.reset()
            self.client.setSetting(.gain, g)
            self.client.setSetting(.iqDigitalGain, digital)
        }
        gainApply = work
        queue.asyncAfter(deadline: .now() + 0.08, execute: work)
    }

    private func applyNrMode() {
        iqnr.reset()
        iqnr.setMode(iqNrEnabled ? mode : -1)
    }

    /// Test seam. Demodulation is otherwise reachable only through a live
    /// SpyServer connection, which is exactly why the mode routing went wrong
    /// unnoticed — there was no way to ask "which detector does index 1 pick?"
    /// without a receiver on the air.
    func demodulateForTesting(_ body: Data, iqRate rate: UInt32) -> [Float] {
        // On the same queue everything else uses. Setting `mode` posts
        // configureDemods asynchronously, so calling in from a test thread
        // raced it and the result depended on which landed first — the suite
        // gave a different count on consecutive runs.
        queue.sync {
            iqRate = rate
            configureDemods()
            return demodulate(body)
        }
    }

    private func demodulate(_ rawBody: Data) -> [Float] {
        // NR runs on the IQ before the demodulator, which is where the FMIF
        // tracking filter belongs — after detection the noise is already mixed
        // into the audio.
        let body = iqNrEnabled ? iqnr.process(rawBody) : rawBody
        // The gain index as a ratio of the device's maximum, which is what the
        // plugin scales the demodulators with (spyService.ts:1349). AM detects
        // an amplitude, so the RF gain reaches its audio on its own; every
        // other mode here detects an angle and is amplitude-invariant, so the
        // RF gain moves the RSSI and nothing else. Carrying the ratio into the
        // demodulator's own output gain is what makes the Gain row an
        // attenuator for them — 8/8 full, 0/8 silent — instead of an inert
        // control. This was the whole of "FM gain does nothing".
        let maxG = Double(maxGainIndex)
        let fmScale = maxG > 0 ? Double(fmGainIndex) / maxG : 1
        let amScale = maxG > 0 ? Double(amGainIndex) / maxG : 1
        switch mode {
        case 0:  return other.processFM(int16IQ: body, decimate: audioDecimate,
                                        gain: 6000 * fmScale)
        case 1, 3:
                 return config.fmStereo && mode == 1
                    ? other.processWFMStereo(int16IQ: body, decimate: audioDecimate,
                                             gain: 2000 * fmScale)
                    : other.processWFM(int16IQ: body, decimate: audioDecimate,
                                       gain: 3000 * fmScale)
        case 4:  return other.processSSB(int16IQ: body, decimate: audioDecimate,
                                         upperSideband: true, gain: 48000 * fmScale)
        case 6:  return other.processSSB(int16IQ: body, decimate: audioDecimate,
                                         upperSideband: false, gain: 48000 * fmScale)
        case 5:  return other.processCW(int16IQ: body, decimate: audioDecimate,
                                        gain: 96000 * fmScale)
        default: return am.process(int16IQ: body, decimate: audioDecimate, gainScale: amScale)
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
        // Measured on arrival, before the queue: the point is when the bytes
        // reached this process, not when it got round to them.
        let now = Date()
        if lastPacketAt != .distantPast {
            let gap = now.timeIntervalSince(lastPacketAt) * 1000
            if gap > maxPacketGapMs { maxPacketGapMs = gap }
        }
        lastPacketAt = now
        // A rolling ten-second window, so the number describes now rather than
        // the worst moment since the app started.
        if now.timeIntervalSince(gapWindowStart) > 10 {
            gapWindowStart = now
            maxPacketGapMs = 0
        }
        queue.async {
            // Demodulate per packet, not per display frame: audio has to be
            // continuous, and the frame timer deliberately skips samples.
            if self.audioEnabled, self.audioRate > 0 {
                var pcm = self.demodulate(pkt.body)
                if !pcm.isEmpty {
                    self.level(&pcm)
                    // spyService.ts:1418 — silence while the window is open.
                    if Date() < self.muteUntil {
                        for i in 0..<pcm.count { pcm[i] = 0 }
                    }
                    self.sink.write(pcm)
                }
            }
        }
        // Not on the audio queue: the RMS pass walks every sample in the packet
        // and the trim below is a memmove, and the audio behind them would wait
        // for both.
        auxQueue.async {
            self.measure(pkt.body, gainDb: pkt.gainDb)
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
    private func measure(_ body: Data, gainDb: UInt16) {
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
        // The server reports the gain it applied in the packet header, and the
        // plugin backs it out (spyService.ts:1313) so the reading describes the
        // signal rather than the receiver's own amplification. Same smoothing
        // as there, 0.9/0.1: at 0.8/0.2 the needle chased the modulation.
        let corrected = db - Double(gainDb)
        rssiDbfs = rssiDbfs * 0.9 + corrected * 0.1
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
        let t = DispatchSource.makeTimerSource(queue: auxQueue)
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
        // Smoothed like the plugin's (spyService.ts:1321). Unsmoothed, this is
        // one FFT frame's peak-over-median and it flickers with the modulation.
        snrDb = snrDb * 0.9 + max(0, peak - median) * 0.1
        let frame = SpectrumFeed.Frame(bins: bins, iqRate: iqRate,
                                       centerFreq: frequency, seq: seq)
        DispatchQueue.main.async { self.onFrame?(frame) }
    }
}
