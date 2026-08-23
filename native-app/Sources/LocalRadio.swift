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
    private let queue = DispatchQueue(label: "deck-rx.localradio")

    private(set) var isConnected = false
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
    var decimationOffset: UInt32 = 1
    var gain: UInt32 = 5
    /// Audio decimation from the IQ rate. 456 kHz / 48 = 9.5 kHz, which is
    /// enough for a 9 kHz AM channel and cheap to filter.
    var audioDecimate = 48
    var bandwidthHz: Double = 9000
    /// Demod mode, using the plugin's numbering so the two agree:
    /// 0 WFM, 1 NFM, 2 AM, 3 USB, 4 LSB, 5 CW.
    var mode: Int = 2 { didSet { if mode != oldValue { queue.async { self.configureDemods() } } } }
    var audioEnabled = false {
        didSet { if !audioEnabled { sink.stop() } else { restartAudio() } }
    }
    var volume: Double { get { sink.volume } set { sink.volume = newValue } }
    var muted: Bool { get { sink.muted } set { sink.muted = newValue } }
    private(set) var audioRate: Double = 0

    /// Tune step for tick-based control. Follows the mode so a knob click
    /// means the same thing it does on the deck.
    var tuneStepHz: Double {
        switch mode {
        case 0, 1: return 100_000     // FM broadcast raster
        case 2:    return 9_000       // JP medium wave
        default:   return 1_000
        }
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

    // MARK: control

    func connect(host: String, port: UInt16, frequency freq: UInt32) {
        frequency = freq
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
        am.setBandwidth(audioRate: audioRate, bandwidthHz: bandwidthHz, iqRate: iq)
        am.configureSync(rate: audioRate)
        other.reset()
        other.setWfmAudioBand(iqRate: iq)
        other.setWfmIfBandwidth(iqRate: iq, cutoffHz: 80000)
        other.setDeemphasis(audioRate: audioRate, tau: 50e-6)   // 50 us, the JP/EU curve
        other.setupSSB(iqRate: iq, audioRate: audioRate)
        other.setupCW(iqRate: iq)
        other.setAudioFilters(rate: audioRate, lowPassHz: 0, highPassHz: 0)
    }

    private func demodulate(_ body: Data) -> [Float] {
        let g = Double(gain) / 10.0
        switch mode {
        case 0:  return other.processWFM(int16IQ: body, decimate: audioDecimate)
        case 1:  return other.processFM(int16IQ: body, decimate: audioDecimate)
        case 3:  return other.processSSB(int16IQ: body, decimate: audioDecimate, upperSideband: true)
        case 4:  return other.processSSB(int16IQ: body, decimate: audioDecimate, upperSideband: false)
        case 5:  return other.processCW(int16IQ: body, decimate: audioDecimate)
        default: return am.process(int16IQ: body, decimate: audioDecimate, gainScale: g)
        }
    }

    private func restartAudio() {
        guard audioRate > 0 else { return }
        do { try sink.start(sourceRate: audioRate) }
        catch { lastError = "audio: \(error.localizedDescription)" }
    }

    private func absorb(_ pkt: SpyClient.IQPacket) {
        guard pkt.format == .int16 else { return }   // we asked for int16
        queue.async {
            // Demodulate per packet, not per display frame: audio has to be
            // continuous, and the frame timer deliberately skips samples.
            if self.audioEnabled, self.audioRate > 0 {
                let pcm = self.demodulate(pkt.body)
                if !pcm.isEmpty { self.sink.write(pcm) }
            }
            self.iq.append(pkt.body)
            // Keep a little more than one transform's worth. Unbounded growth
            // here is how a receiver quietly turns into a memory leak.
            let need = self.fftSize * 4 * 2
            if self.iq.count > need {
                self.iq.removeSubrange(0 ..< (self.iq.count - need))
            }
        }
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
        let frame = SpectrumFeed.Frame(bins: bins, iqRate: iqRate,
                                       centerFreq: frequency, seq: seq)
        DispatchQueue.main.async { self.onFrame?(frame) }
    }
}
