// Exhaustive tests for the settings that depend on which receiver is connected.
//
// These exist because the feature was shipped broken once. On 2026-09-21,
// pointing Deck RX Solo at a second SpyServer carrying an RTL-SDR Blog V4
// carried the Airspy HF+'s stored `iqDecimation: 0` across, asked the server
// for 2.4 MHz, never tuned, and played noise — while `/health` cheerfully said
// `connected: true, canControl: true`. Nothing in the app could have caught
// that, because the resolution lived inside a method that needed a socket.
//
// So the rules were pulled out into DeviceSettingsResolver, and this file walks
// them: every device type crossed with every mode, both directions of the
// stored-value error, the transitions between receivers, and the invariants
// that have to hold whatever is stored.

import Foundation

// MARK: - fixtures

/// The two receivers actually in use here, plus the shapes the resolver has to
/// survive. Values are what the servers really report (measured 2026-09-21 with
/// DRM_LOG_DEVINFO=1 against sserv).
enum Rx {
    static func info(type: UInt32, serial: UInt32 = 1, maxRate: UInt32,
                     stages: UInt32 = 8, maxGain: UInt32 = 8,
                     minDec: UInt32 = 0, minFreq: UInt32 = 0,
                     maxFreq: UInt32 = 1_700_000_000) -> SpyClient.DeviceInfo {
        SpyClient.DeviceInfo(deviceType: type, deviceSerial: serial,
                             maxSampleRate: maxRate, maxBandwidth: maxRate,
                             decimationStages: stages, gainStages: 0,
                             maxGainIndex: maxGain, minFrequency: minFreq,
                             maxFrequency: maxFreq, resolution: 0,
                             minIQDecimation: minDec, forcedIQFormat: 0)
    }
    /// Airspy HF+ Discovery behind spyserver: type 2, 912 kHz, 8 gain steps.
    static let hfp = info(type: 2, serial: 0x3B52_8D80, maxRate: 912_000, maxGain: 8)
    /// RTL-SDR Blog V4 behind spyserver: type 3, 2.4 MHz, 29 gain steps.
    static let v4 = info(type: 3, serial: 0x0000_0001, maxRate: 2_400_000,
                         maxGain: 29, minFreq: 500_000, maxFreq: 1_766_000_000)
    /// A second V4 on the same host — same type, different serial.
    static let v4b = info(type: 3, serial: 0x0000_0002, maxRate: 2_400_000, maxGain: 29)
    /// Airspy R2: type 1, the third type the protocol names.
    static let airspyOne = info(type: 1, serial: 7, maxRate: 10_000_000, maxGain: 21)
    /// A device the app has never heard of, reporting a modest rate.
    static let unknown = info(type: 99, serial: 3, maxRate: 768_000, maxGain: 4)
    /// A server that insists on some decimation of its own.
    static let flooredV4 = info(type: 3, serial: 9, maxRate: 2_400_000, maxGain: 29, minDec: 2)
}

let allModes = [RxMode.nfm, RxMode.wfm, RxMode.am, RxMode.dsb, 4, 5]
let allDevices: [(String, SpyClient.DeviceInfo)] = [
    ("HF+", Rx.hfp), ("V4", Rx.v4), ("AirspyOne", Rx.airspyOne),
    ("unknown", Rx.unknown), ("V4+minDec", Rx.flooredV4),
]

func rate(_ i: SpyClient.DeviceInfo, _ offset: UInt32) -> Double {
    DeviceSettingsResolver.iqRate(i, offset: offset)
}

/// A config as it ships, with the pieces these tests vary.
func cfg(iqDec: UInt32 = 1, audioDec: Int = 4,
         amGain: UInt32? = nil, fmGain: UInt32? = nil,
         devices: [String: RadioConfig.DeviceProfile] = [:]) -> RadioConfig {
    var c = RadioConfig()
    c.iqDecimation = iqDec
    c.audioDecimate = audioDec
    c.amGain = amGain
    c.fmGain = fmGain
    c.devices = devices
    return c
}

// MARK: - tests

func runDeviceSettingsTests() {
    print("\ndevice settings — floors")

    // The floors are the whole basis of the fallback, so they are pinned
    // directly rather than only through their consequences.
    check("WFM needs the widest IQ (stereo subcarrier at 38 kHz)",
          DeviceSettingsResolver.minIQRate(mode: RxMode.wfm) == 200_000)
    check("narrow modes share one lower IQ floor",
          DeviceSettingsResolver.minIQRate(mode: RxMode.am) == 96_000
          && DeviceSettingsResolver.minIQRate(mode: RxMode.nfm) == 96_000
          && DeviceSettingsResolver.minIQRate(mode: 4) == 96_000)
    check("WFM's audio floor clears 2x38 kHz",
          DeviceSettingsResolver.minAudioRate(mode: RxMode.wfm) >= 76_000)
    check("NFM asks less than WFM but more than AM",
          DeviceSettingsResolver.minAudioRate(mode: RxMode.nfm)
          < DeviceSettingsResolver.minAudioRate(mode: RxMode.wfm)
          && DeviceSettingsResolver.minAudioRate(mode: RxMode.nfm)
          > DeviceSettingsResolver.minAudioRate(mode: RxMode.am))
    check("AM's audio floor still passes a 9 kHz channel",
          DeviceSettingsResolver.minAudioRate(mode: RxMode.am) / 2 >= 9_000)

    print("\ndevice settings — the bug that started this")

    // The exact failure, in the exact numbers it happened with.
    let v4FromHfpConfig = DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 0), mode: RxMode.am)
    check("V4 + the HF+'s stored 0 does NOT ask for 2.4 MHz",
          v4FromHfpConfig.iqRate != 2_400_000, "got \(v4FromHfpConfig.iqRate) Hz")
    check("V4 + the HF+'s stored 0 lands at 150 kHz",
          v4FromHfpConfig.iqRate == 150_000, "got \(v4FromHfpConfig.iqRate) Hz")
    check("...and the HF+ itself still gets its full 912 kHz",
          DeviceSettingsResolver.resolve(info: Rx.hfp, config: cfg(iqDec: 0), mode: RxMode.am)
            .iqRate == 912_000)

    print("\ndevice settings — every device x every mode")

    // The invariants have to hold for every combination, not just the two
    // receivers on the desk.
    for (name, dev) in allDevices {
        for mode in allModes {
            let s = DeviceSettingsResolver.resolve(info: dev, config: cfg(iqDec: 0, audioDec: 4), mode: mode)
            let iqFloor = DeviceSettingsResolver.minIQRate(mode: mode)
            let auFloor = DeviceSettingsResolver.minAudioRate(mode: mode)
            let audioRate = Double(s.iqRate) / Double(s.audioDecimate)
            // A device may simply be unable to reach a floor; what must never
            // happen is choosing something below it when a higher stage exists.
            let reachable = rate(dev, 0) >= iqFloor
            check("\(name)/\(mode): IQ rate clears the mode's floor",
                  !reachable || Double(s.iqRate) >= iqFloor,
                  "\(s.iqRate) Hz vs floor \(iqFloor)")
            check("\(name)/\(mode): audio rate clears the mode's floor",
                  !reachable || audioRate >= auFloor || s.audioDecimate == 1,
                  "\(audioRate) Hz vs floor \(auFloor), decimate \(s.audioDecimate)")
            check("\(name)/\(mode): gain is within the device's range",
                  s.gainIndex <= dev.maxGainIndex,
                  "\(s.gainIndex) of \(dev.maxGainIndex)")
            check("\(name)/\(mode): audio decimation is at least 1",
                  s.audioDecimate >= 1)
            check("\(name)/\(mode): the server's own decimation floor is respected",
                  s.decStage >= dev.minIQDecimation,
                  "stage \(s.decStage) vs min \(dev.minIQDecimation)")
            check("\(name)/\(mode): the stage and the offset agree",
                  s.decStage == s.iqDecimationOffset + dev.minIQDecimation)
        }
    }

    print("\ndevice settings — stored values in both directions")

    // Too high (the V4 bug) and too low (a stage that starves the mode) are
    // both corrections; a value in range is left alone.
    check("a stage that is too high for the device is replaced",
          DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 0), mode: RxMode.am).iqRate
          <= UInt32(DeviceSettingsResolver.maxAutoIQRate))
    check("a stage that starves the mode is replaced",
          Double(DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 7), mode: RxMode.am).iqRate)
          >= DeviceSettingsResolver.minIQRate(mode: RxMode.am))
    check("a stage that works is kept untouched",
          DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 4), mode: RxMode.am)
            .iqDecimationOffset == 4)
    check("WFM rejects a stage AM would have accepted",
          DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 4), mode: RxMode.wfm)
            .iqDecimationOffset != 4,
          "150 kHz is below WFM's 200 kHz floor")

    print("\ndevice settings — audio decimation")

    check("HF+ at 912 kHz keeps audioDecimate 4 for WFM",
          DeviceSettingsResolver.audioDecimation(iqRate: 912_000, mode: RxMode.wfm, stored: 4) == 4)
    check("V4 at 150 kHz drops it so WFM keeps its subcarrier",
          150_000.0 / Double(DeviceSettingsResolver.audioDecimation(iqRate: 150_000, mode: RxMode.wfm, stored: 4))
          >= 96_000)
    check("AM at 150 kHz is content with 4",
          DeviceSettingsResolver.audioDecimation(iqRate: 150_000, mode: RxMode.am, stored: 4) == 4)
    check("NFM sits between them",
          DeviceSettingsResolver.audioDecimation(iqRate: 150_000, mode: RxMode.nfm, stored: 4) == 2,
          "got \(DeviceSettingsResolver.audioDecimation(iqRate: 150_000, mode: RxMode.nfm, stored: 4))")
    check("it never returns 0, whatever it is handed",
          DeviceSettingsResolver.audioDecimation(iqRate: 48_000, mode: RxMode.wfm, stored: 0) >= 1
          && DeviceSettingsResolver.audioDecimation(iqRate: 48_000, mode: RxMode.wfm, stored: -3) >= 1)
    check("it only ever halves, so it stays a power-of-two chain",
          [1, 2, 4, 8].contains(
            DeviceSettingsResolver.audioDecimation(iqRate: 300_000, mode: RxMode.wfm, stored: 8)))

    print("\ndevice settings — default gain")

    // An 8 bit front end must not start at the top; everything else keeps the
    // behaviour it has always had.
    // With no frequency to go on this is the mediumwave answer, which is the
    // safe one: see "gain by band" below.
    check("RTL-SDR starts at the bottom of its 29 steps",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.v4)
            == DeviceSettingsResolver.rtlMWGainIndex)
    check("Airspy HF+ still starts at its maximum",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.hfp) == Rx.hfp.maxGainIndex)
    check("Airspy R2 is unaffected too",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.airspyOne) == Rx.airspyOne.maxGainIndex)
    check("an unknown device keeps the old default",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.unknown) == Rx.unknown.maxGainIndex)
    // On shortwave, where nothing caps it. Mediumwave has its own rule.
    check("a stored gain beats the default on the V4",
          DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(amGain: 12),
                                         mode: RxMode.am, freqHz: 6_030_000)
            .gainIndex == 12)
    check("a stored gain above the device's range is clamped, not rejected",
          DeviceSettingsResolver.resolve(info: Rx.hfp, config: cfg(amGain: 99), mode: RxMode.am)
            .gainIndex == Rx.hfp.maxGainIndex)
    check("AM and FM gains stay separate",
          DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(amGain: 3, fmGain: 17),
                                         mode: RxMode.am, freqHz: 6_030_000).gainIndex == 3
          && DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(amGain: 3, fmGain: 17),
                                            mode: RxMode.wfm, freqHz: 100_100_000).gainIndex == 17)

    print("\ndevice settings — profiles and switching receivers")

    let hfpKey = RadioConfig.deviceKey(type: Rx.hfp.deviceType, serial: Rx.hfp.deviceSerial)
    let v4Key  = RadioConfig.deviceKey(type: Rx.v4.deviceType,  serial: Rx.v4.deviceSerial)
    let v4bKey = RadioConfig.deviceKey(type: Rx.v4b.deviceType, serial: Rx.v4b.deviceSerial)
    check("the key separates two receivers of the same type",
          v4Key != v4bKey, "\(v4Key) vs \(v4bKey)")
    check("the key separates different types", hfpKey != v4Key)

    // The sequence a user actually performs: connect, switch, come back.
    var c = cfg(iqDec: 0, audioDec: 4, amGain: 0)

    let s1 = DeviceSettingsResolver.resolve(info: Rx.hfp, config: c, mode: RxMode.am)
    DeviceSettingsResolver.adopt(s1, into: &c, info: Rx.hfp, mode: RxMode.am)
    check("HF+ connects at 912 kHz and is filed under its own key",
          s1.iqRate == 912_000 && c.devices[hfpKey]?.iqDecimation == 0)

    let s2 = DeviceSettingsResolver.resolve(info: Rx.v4, config: c, mode: RxMode.am)
    DeviceSettingsResolver.adopt(s2, into: &c, info: Rx.v4, mode: RxMode.am)
    check("switching to the V4 corrects the rate", s2.iqRate == 150_000)
    check("...and stores the corrected value, not the inherited one",
          c.devices[v4Key]?.iqDecimation == s2.iqDecimationOffset
          && c.devices[v4Key]?.iqDecimation != 0)
    check("...without disturbing the HF+'s profile",
          c.devices[hfpKey]?.iqDecimation == 0)

    let s3 = DeviceSettingsResolver.resolve(info: Rx.hfp, config: c, mode: RxMode.am)
    check("going back to the HF+ restores 912 kHz, not the V4's setting",
          s3.iqRate == 912_000, "got \(s3.iqRate)")

    let s4 = DeviceSettingsResolver.resolve(info: Rx.v4, config: c, mode: RxMode.am)
    check("going back to the V4 restores its own setting without re-deriving",
          s4.iqDecimationOffset == s2.iqDecimationOffset && s4.iqRate == 150_000)

    // A second identical dongle must not inherit the first one's profile.
    let s5 = DeviceSettingsResolver.resolve(info: Rx.v4b, config: c, mode: RxMode.am)
    check("a second V4 resolves from the top-level values, not its twin's profile",
          c.devices[v4bKey] == nil && s5.iqRate >= 96_000)

    // Adoption has to be idempotent, or every reconnect would rewrite the file.
    var c2 = c
    let again = DeviceSettingsResolver.resolve(info: Rx.v4, config: c2, mode: RxMode.am)
    DeviceSettingsResolver.adopt(again, into: &c2, info: Rx.v4, mode: RxMode.am)
    check("re-adopting an unchanged profile changes nothing",
          c2.devices[v4Key] == c.devices[v4Key])

    // Mode-specific values must not leak into the other mode's slot.
    var c3 = cfg(iqDec: 4, audioDec: 4, amGain: 2, fmGain: 9)
    let fmS = DeviceSettingsResolver.resolve(info: Rx.v4, config: c3, mode: RxMode.wfm)
    DeviceSettingsResolver.adopt(fmS, into: &c3, info: Rx.v4, mode: RxMode.wfm)
    check("adopting in FM leaves the AM gain alone",
          c3.devices[v4Key]?.amGain == 2, "got \(String(describing: c3.devices[v4Key]?.amGain))")
    check("adopting in FM stores the FM gain",
          c3.devices[v4Key]?.fmGain == fmS.gainIndex)

    print("\ndevice settings — odd shapes")

    // A server reporting a floor of its own: the offset is relative to it.
    let fl = DeviceSettingsResolver.resolve(info: Rx.flooredV4, config: cfg(iqDec: 0), mode: RxMode.am)
    check("minIQDecimation is added on top of the offset",
          fl.decStage == fl.iqDecimationOffset + 2, "stage \(fl.decStage)")
    check("the rate matches the absolute stage, not the offset",
          fl.iqRate == UInt32(2_400_000 / (1 << fl.decStage)))

    // A device too small to reach a mode's floor must still produce something
    // usable rather than dividing by zero or looping.
    let tiny = Rx.info(type: 3, maxRate: 48_000, stages: 2, maxGain: 4)
    for mode in allModes {
        let s = DeviceSettingsResolver.resolve(info: tiny, config: cfg(iqDec: 5), mode: mode)
        check("a device below every floor still resolves (mode \(mode))",
              s.iqRate > 0 && s.audioDecimate >= 1 && s.decStage <= tiny.decimationStages,
              "\(s.iqRate) Hz, decimate \(s.audioDecimate), stage \(s.decStage)")
    }

    // decimationStages is a ceiling, and a stored offset beyond it must not be
    // handed to the server.
    let s6 = DeviceSettingsResolver.resolve(info: Rx.v4, config: cfg(iqDec: 99), mode: RxMode.am)
    check("an absurd stored offset is replaced, not passed through",
          s6.iqDecimationOffset <= Rx.v4.decimationStages, "offset \(s6.iqDecimationOffset)")

    print("\ndevice settings — gain by band on an 8 bit front end")

    // Reported from the listening chair 2026-09-21: strong stations audible on
    // frequencies they are not on. The gain such a front end can stand is a
    // property of the band, not of the demod mode deck-rx files it under.
    let mw = 594_000.0, hf = 6_030_000.0
    check("mediumwave starts at the bottom of the list",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.v4, freqHz: mw)
            == DeviceSettingsResolver.rtlMWGainIndex)
    check("shortwave starts well up it",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.v4, freqHz: hf)
            == DeviceSettingsResolver.rtlHFGainIndex)
    check("every other receiver still starts at its maximum",
          DeviceSettingsResolver.defaultGainIndex(for: Rx.hfp, freqHz: mw)
            == Rx.hfp.maxGainIndex
            && DeviceSettingsResolver.defaultGainIndex(for: Rx.hfp, freqHz: hf)
            == Rx.hfp.maxGainIndex)
    check("an unknown frequency counts as mediumwave",
          DeviceSettingsResolver.isMediumwave(0)
            && DeviceSettingsResolver.defaultGainIndex(for: Rx.v4)
            == DeviceSettingsResolver.rtlMWGainIndex)
    check("the boundary is 2 MHz",
          DeviceSettingsResolver.isMediumwave(1_999_999)
            && !DeviceSettingsResolver.isMediumwave(2_000_000))

    // The reported fault: one gain per demod mode means SSB on mediumwave
    // reaches for the value last used on shortwave.
    let capped = DeviceSettingsResolver.resolve(
        info: Rx.v4, config: cfg(fmGain: 6), mode: RxMode.dsb, freqHz: mw)
    check("a gain stored for another band is capped on mediumwave",
          capped.gainIndex == DeviceSettingsResolver.rtlMWGainIndex,
          "gain \(capped.gainIndex)")
    let keptHF = DeviceSettingsResolver.resolve(
        info: Rx.v4, config: cfg(fmGain: 6), mode: RxMode.dsb, freqHz: hf)
    check("and kept on shortwave", keptHF.gainIndex == 6, "gain \(keptHF.gainIndex)")
    let hfpMW = DeviceSettingsResolver.resolve(
        info: Rx.hfp, config: cfg(amGain: 6), mode: RxMode.am, freqHz: mw)
    check("a receiver that is not an 8 bit stick is not capped",
          hfpMW.gainIndex == 6, "gain \(hfpMW.gainIndex)")
    let bandA = DeviceSettingsResolver.resolve(
        info: Rx.v4, config: cfg(iqDec: 4), mode: RxMode.am, freqHz: mw)
    let bandB = DeviceSettingsResolver.resolve(
        info: Rx.v4, config: cfg(iqDec: 4), mode: RxMode.am, freqHz: hf)
    check("the band changes the gain and nothing else",
          bandA.iqRate == bandB.iqRate && bandA.decStage == bandB.decStage
            && bandA.audioDecimate == bandB.audioDecimate)

    print("\ndevice settings — the profile carries every field")

    // Found on the deck 2026-09-21, not here: two places built a DeviceProfile
    // and one of them left `audioDecimate` out, so the value `adopt` had just
    // filed was overwritten with nothing and the audio divisor stopped being
    // per-receiver. There is one builder now, and these pin it.
    var p = cfg(iqDec: 4, audioDec: 8, amGain: 1, fmGain: 6)
    let inForce = p.profileInForce()
    check("every field of the profile is filled",
          inForce.iqDecimation == 4 && inForce.audioDecimate == 8
            && inForce.amGain == 1 && inForce.fmGain == 6,
          "\(String(describing: inForce))")

    p.captureProfile(for: "3:00000000")
    check("capturing files exactly what is in force",
          p.devices["3:00000000"] == inForce)

    // The round trip that matters: file one receiver, move to another, come
    // back, and every field returns — audioDecimate included.
    p.iqDecimation = 3; p.audioDecimate = 2; p.amGain = 7; p.fmGain = 2
    p.captureProfile(for: "2:31313038")
    check("both receivers are on file", p.devices.count == 2)
    check("the other receiver restores all four values",
          p.applyProfile(for: "3:00000000")
            && p.iqDecimation == 4 && p.audioDecimate == 8
            && p.amGain == 1 && p.fmGain == 6,
          "iqDec \(p.iqDecimation) audioDec \(p.audioDecimate) "
            + "am \(String(describing: p.amGain)) fm \(String(describing: p.fmGain))")
    check("filing one receiver leaves the other alone",
          p.devices["2:31313038"]?.audioDecimate == 2
            && p.devices["2:31313038"]?.iqDecimation == 3)
    check("a receiver never seen restores nothing",
          p.applyProfile(for: "9:DEADBEEF") == false)
}
