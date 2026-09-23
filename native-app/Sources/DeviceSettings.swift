// Everything whose right value depends on WHICH receiver is on the other end.
//
// The protocol carries several settings as *offsets and divisors* rather than
// absolute values — `iqDecimation` is a number of halvings, `audioDecimate` is
// a divisor, a gain is an index into a list whose length the device chooses. A
// value chosen on one receiver therefore means something else on the next one,
// and deck-rx stored exactly one set of them.
//
// On 2026-09-21 that broke in the field: pointing Deck RX Solo at a second
// SpyServer carrying an RTL-SDR Blog V4, while carrying the Airspy HF+'s stored
// `iqDecimation: 0`, asked the server for 2.4 MHz. It connected, reported
// `canControl: true`, never tuned at all, and played nothing but noise.
//
// SDR++ solves this by keying a `devices` map by name and serial in every
// source config it writes (spyserver_config.json, rtl_sdr_config.json,
// airspyhf_config.json). RadioConfig.devices is the same idea; this file is the
// resolution that goes with it, kept free of sockets and app state so the whole
// thing is testable.

import Foundation

/// The mode numbers used throughout, named once so the rules below read.
enum RxMode {
    static let nfm = 0
    static let wfm = 1
    static let am  = 2
    static let dsb = 3

    /// Stereo lives on WFM alone (`LocalRadio.isStereoMode`).
    static func isWideFM(_ mode: Int) -> Bool { mode == wfm }
}

/// The bands a gain is kept for (`gainBand` in src/deviceSettings.ts).
///
/// What overloads a front end is what the antenna delivers, so the band decides
/// the gain, not the demod mode: on 2026-09-23 the V4 behind a 6 dB pad wanted
/// index 3 on mediumwave (intermod at 1026 kHz appears from 6 up), while
/// shortwave wants it far higher. With one value per mode, mediumwave and
/// shortwave AM fought over `amGain`, and SSB on mediumwave borrowed the FM
/// value. AM and the rest stay apart inside a band because the non-AM value is
/// also the post-demod level for FM, SSB and CW (LocalRadio's fmScale).
enum GainBand: String, CaseIterable {
    case mw, hf, vhf

    /// Top of shortwave. Above it: VHF, FM broadcast and up.
    static let hfTopHz: Double = 30_000_000

    /// mw below 2 MHz (and when the frequency is unknown), hf to 30 MHz, vhf above.
    static func of(_ freqHz: Double) -> GainBand {
        if DeviceSettingsResolver.isMediumwave(freqHz) { return .mw }
        return freqHz < hfTopHz ? .hf : .vhf
    }
}

/// What a receiver needs to be told, once its identity is known.
struct DeviceSettings: Equatable {
    /// Absolute stage sent to the server: the stored offset plus the device's
    /// own `minIQDecimation` floor.
    var decStage: UInt32
    var iqRate: UInt32
    /// Clamped to this device's `maxGainIndex`.
    var gainIndex: UInt32
    var audioDecimate: Int
    /// The offset that produced `decStage`, i.e. what belongs in the profile.
    var iqDecimationOffset: UInt32
}

enum DeviceSettingsResolver {

    // MARK: floors

    /// Lowest IQ rate that still carries the mode.
    ///
    /// WFM occupies about 100 kHz once its deviation and stereo subcarrier are
    /// counted, so it needs 200 kHz to be sampled with any margin. Everything
    /// else here is narrow — NFM is 12.5 kHz, AM 9 kHz, SSB under 3 kHz — and
    /// 96 kHz is comfortable for all of them. (96 kHz is also what the
    /// unattended probes ask for, so a capture and a listen agree.)
    static func minIQRate(mode: Int) -> Double {
        RxMode.isWideFM(mode) ? 200_000 : 96_000
    }

    /// Highest IQ rate to choose on this device's behalf when falling back.
    ///
    /// Not a hardware limit — a deliberate refusal to default anywhere near a
    /// device's maximum. SpyServer's RTL-SDR support is thin (its own floor for
    /// these sits at 24 MHz until `minimum_frequency` is set) and SDRangel
    /// carries the same shape of bug: issue #2521, "Decimation lower than 16/8
    /// causes reception issues on RTL-SDR Blog V4". A user who asks for the top
    /// rate still gets it; this only governs what is picked automatically.
    static let maxAutoIQRate: Double = 1_000_000

    /// Lowest audio rate that still carries the mode.
    ///
    /// WFM stereo puts its pilot at 19 kHz and the difference signal at 38 kHz,
    /// so nothing below 76 kHz keeps stereo at all; 96 kHz leaves room for the
    /// reconstruction filter. NFM's 12.5 kHz is happy at 48 kHz. AM, DSB, SSB
    /// and CW live inside a few kHz and 24 kHz is ample.
    ///
    /// Getting this wrong is not subtle, and it has happened here: a 9.5 kHz
    /// audio rate once put a 6 kHz tone out at 3.5 kHz.
    static func minAudioRate(mode: Int) -> Double {
        switch mode {
        case RxMode.wfm: return 96_000
        case RxMode.nfm: return 48_000
        default:         return 24_000
        }
    }

    // MARK: pieces

    /// IQ rate a stage would produce on this device.
    static func iqRate(_ info: SpyClient.DeviceInfo, offset: UInt32) -> Double {
        Double(info.maxSampleRate) / Double(1 << (offset + info.minIQDecimation))
    }

    /// Keep a stored offset while the rate it produces is usable here; else the
    /// lowest rate that still covers the mode.
    static func decimationOffset(for info: SpyClient.DeviceInfo,
                                 stored: UInt32, mode: Int) -> UInt32 {
        let floor = minIQRate(mode: mode)
        let storedRate = iqRate(info, offset: stored)
        if storedRate >= floor && storedRate <= maxAutoIQRate { return stored }
        var s: UInt32 = 0
        while s + 1 <= info.decimationStages, iqRate(info, offset: s + 1) >= floor { s += 1 }
        return s
    }

    /// Halve a stored divisor until the audio rate clears the mode's floor.
    static func audioDecimation(iqRate: UInt32, mode: Int, stored: Int) -> Int {
        let floor = minAudioRate(mode: mode)
        var d = max(1, stored)
        while d > 1 && Double(iqRate) / Double(d) < floor { d /= 2 }
        return d
    }

    /// Where to start a receiver's gain when nothing has been stored for it.
    ///
    /// An 8 bit front end is a different proposition: on the V4 the top of the
    /// range saturates mediumwave outright. Measured 2026-09-21 at 774 kHz —
    /// C/N 31.7 dB at index 0, 11.6 at 1, 3.1 at 2 — while the strong locals
    /// (594/810/954/1134/1242, all of them powerful in central Tokyo) barely
    /// moved and hid the collapse entirely. Everything else keeps the previous
    /// behaviour of starting at the device's maximum.
    static func defaultGainIndex(for info: SpyClient.DeviceInfo,
                                 freqHz: Double = 0) -> UInt32 {
        guard info.deviceType == SpyClient.DeviceType.rtlsdr.rawValue else {
            return info.maxGainIndex
        }
        return min(isMediumwave(freqHz) ? rtlMWGainIndex : rtlHFGainIndex,
                   info.maxGainIndex)
    }

    /// Where mediumwave stops mattering for this decision.
    static let mediumwaveTopHz: Double = 2_000_000
    /// ~0.9 dB on the tuner's 29 step list: 0.00% clipped, and within 0.7 dB of
    /// the HF+ on the same antenna (594 kHz, 2026-09-21).
    static let rtlMWGainIndex: UInt32 = 1
    /// ~32.8 dB, the same list. Nothing saturates on shortwave, and the floor
    /// of the list throws about 6 dB of SNR away (measured the same day).
    static let rtlHFGainIndex: UInt32 = 17

    /// An unknown frequency counts as mediumwave: overload is the worse mistake.
    static func isMediumwave(_ freqHz: Double) -> Bool {
        !(freqHz >= mediumwaveTopHz)
    }

    /// The highest gain index this device has. Nothing narrower.
    ///
    /// There was a mediumwave ceiling here for a day — an 8 bit front end is
    /// measurably worse at high gain on that band (index 0 against 5 on the V4:
    /// the 594 kHz carrier fell from 51 to 32 dB over the floor and the band
    /// filled with peaks that are not stations) — and it was wrong to put it
    /// here. It applied when a stream started and not when a gain was changed
    /// while listening, so the control worked and then undid itself on the next
    /// connect. A setting that argues with the person holding it is worse than
    /// a setting that lets them be wrong. The band still chooses the DEFAULT,
    /// which is what protects the case nobody has an opinion about.
    static func gainCeiling(for info: SpyClient.DeviceInfo, freqHz: Double) -> UInt32 {
        info.maxGainIndex
    }

    // MARK: resolution

    /// Everything above, applied in order, for one connection.
    ///
    /// Reads the profile stored for this receiver first and the top-level
    /// values second, so a receiver that has been seen before comes back as it
    /// was left, and one that has not inherits whatever is in force — corrected
    /// where that would not work here.
    static func resolve(info: SpyClient.DeviceInfo,
                        config: RadioConfig,
                        mode: Int,
                        freqHz: Double = 0) -> DeviceSettings {
        let key = RadioConfig.deviceKey(type: info.deviceType, serial: info.deviceSerial)
        let profile = config.devices[key]

        let offset = decimationOffset(for: info,
                                      stored: profile?.iqDecimation ?? config.iqDecimation,
                                      mode: mode)
        let stage = offset + info.minIQDecimation
        let rate = UInt32(Double(info.maxSampleRate) / Double(1 << stage))

        // The band's slot first; a band with nothing filed falls back to the
        // per-mode value, which is how a profile written before slots existed
        // keeps behaving the way it did.
        let slot = profile?.gains?[GainBand.of(freqHz).rawValue]
        let storedGain = mode == RxMode.am ? (slot?.am ?? profile?.amGain ?? config.amGain)
                                           : (slot?.fm ?? profile?.fmGain ?? config.fmGain)
        let fallback: UInt32 = defaultGainIndex(for: info, freqHz: freqHz)
        let ceiling: UInt32 = gainCeiling(for: info, freqHz: freqHz)
        let gain: UInt32 = min(storedGain ?? fallback, ceiling)

        let audio = audioDecimation(iqRate: rate, mode: mode,
                                    stored: profile?.audioDecimate ?? config.audioDecimate)

        return DeviceSettings(decStage: stage, iqRate: rate, gainIndex: gain,
                              audioDecimate: audio, iqDecimationOffset: offset)
    }

    /// Fold resolved settings back into the config and file them under this
    /// receiver, so the next connection to it restores them rather than
    /// re-deriving them — and so the UI agrees with what was sent.
    ///
    /// Both gains are set for the band being tuned — the one in use from `s`,
    /// the other resolved the same way — so a later mode switch finds this
    /// band's value rather than whatever band was used last.
    static func adopt(_ s: DeviceSettings, into config: inout RadioConfig,
                      info: SpyClient.DeviceInfo, mode: Int, freqHz: Double = 0) {
        let key = RadioConfig.deviceKey(type: info.deviceType, serial: info.deviceSerial)
        let other = resolve(info: info, config: config,
                            mode: mode == RxMode.am ? RxMode.nfm : RxMode.am,
                            freqHz: freqHz).gainIndex
        config.iqDecimation = s.iqDecimationOffset
        config.audioDecimate = s.audioDecimate
        if mode == RxMode.am {
            config.amGain = s.gainIndex; config.fmGain = other
        } else {
            config.fmGain = s.gainIndex; config.amGain = other
        }
        config.captureProfile(for: key, freqHz: freqHz)
    }

    /// Both gains for the band `freqHz` falls in, as a retune into it resolves them.
    static func bandGains(info: SpyClient.DeviceInfo, config: RadioConfig,
                          freqHz: Double) -> (am: UInt32, fm: UInt32) {
        (resolve(info: info, config: config, mode: RxMode.am, freqHz: freqHz).gainIndex,
         resolve(info: info, config: config, mode: RxMode.nfm, freqHz: freqHz).gainIndex)
    }
}
