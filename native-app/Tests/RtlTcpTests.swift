// The rtl_tcp client, without a server.
//
// The same cases and the same numbers as test/rtlTcp.test.ts: the two clients
// share no code, so they share these instead. The client runs `inline` here —
// every entry point on the caller's thread — and its commands go to a recorder
// instead of a socket.

import Foundation

/// A client wired to a command recorder.
private final class Rig {
    let c: RtlTcpClient
    var sent = [Data]()
    var infos = [SpyClient.DeviceInfo]()
    var syncs = [SpyClient.SyncInfo]()
    var packets = [SpyClient.IQPacket]()
    var errors = [Error]()

    init(settle: TimeInterval = 0) {
        c = RtlTcpClient(rateSettle: settle, inline: true)
        c.send = { [unowned self] d in self.sent.append(d) }
        c.onDeviceInfo = { [unowned self] in self.infos.append($0) }
        c.onSync = { [unowned self] in self.syncs.append($0) }
        c.onIQ = { [unowned self] in self.packets.append($0) }
        c.onError = { [unowned self] in self.errors.append($0) }
    }

    /// The 5-byte commands sent so far, decoded.
    var cmds: [(cmd: UInt8, param: UInt32)] {
        sent.filter { $0.count == 5 }.map { d in
            let b = [UInt8](d)
            return (b[0], UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4]))
        }
    }
    func last(_ cmd: UInt8) -> UInt32? { cmds.last { $0.cmd == cmd }?.param }

    static func header(tuner: UInt32, gains: UInt32) -> Data {
        var d = Data("RTL0".utf8)
        for v in [tuner, gains] {
            var be = v.bigEndian
            Swift.withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        }
        return d
    }
    /// R828D, 29 gain steps — the Blog V4.
    func handshake() { c.feed(Rig.header(tuner: 6, gains: 29)) }

    /// All emitted IQ as int16 values, I and Q interleaved.
    var samples: [Int16] {
        packets.flatMap { p in
            p.body.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        }
    }
}

func runRtlTcpTests() {
    print("\nrtl_tcp — sample-rate windows and planning")

    check("accepts only the two windows librtlsdr supports",
          !RtlTcpClient.isValidRate(225_000) && RtlTcpClient.isValidRate(250_000)
            && RtlTcpClient.isValidRate(300_000) && !RtlTcpClient.isValidRate(600_000)
            && !RtlTcpClient.isValidRate(900_000) && RtlTcpClient.isValidRate(1_200_000)
            && RtlTcpClient.isValidRate(2_400_000) && !RtlTcpClient.isValidRate(3_300_000))

    let p300 = RtlTcpClient.planRate(300_000)
    check("meets 300 kS/s natively, with no client-side decimation",
          p300.deviceRate == 300_000 && p300.decimation == 1)

    var everyStage = true
    var plans = [Int: (deviceRate: UInt32, decimation: Int)]()
    for stage in 0...7 {
        let target = (Double(RtlTcpClient.maxSampleRate) / pow(2, Double(stage))).rounded()
        let p = RtlTcpClient.planRate(target)
        plans[stage] = p
        let exact = Double(p.deviceRate) / Double(p.decimation) == target
        let pow2 = p.decimation > 0 && (p.decimation & (p.decimation - 1)) == 0
        if !(RtlTcpClient.isValidRate(Double(p.deviceRate)) && exact && pow2) { everyStage = false }
    }
    check("covers every decimation stage the client advertises", everyStage)
    check("rates in the gap between the windows are reached from above",
          plans[2]! == (1_200_000, 2) && plans[4]! == (300_000, 2),
          "stage 2 \(plans[2]!) stage 4 \(plans[4]!)")
    check("prefers the lowest native rate, to keep the stream off the LAN",
          RtlTcpClient.planRate(150_000).deviceRate == 300_000)
    let big = RtlTcpClient.planRate(4_000_000)
    check("clamps above the device maximum", big.deviceRate == 3_200_000 && big.decimation == 1)

    print("\nrtl_tcp — handshake")

    do {
        let r = Rig()
        r.handshake()
        let i = r.infos.first
        check("synthesises a DeviceInfo", i != nil)
        if let i {
            check("whose profile key matches the SpyServer one",
                  RadioConfig.deviceKey(type: i.deviceType, serial: i.deviceSerial) == "3:00000000")
            check("with 29 gain steps as index 0-28", i.maxGainIndex == 28)
            check("and no decimation floor, at 2.4 MS/s",
                  i.minIQDecimation == 0 && i.maxSampleRate == RtlTcpClient.maxSampleRate)
        }
        check("names tuner 6 R828D", RtlTcpClient.tunerNames[6] == "R828D")
        check("emits a sync that grants control — rtl_tcp has no exclusive owner",
              r.syncs.first?.canControl == true)
    }
    do {
        let r = Rig()
        r.c.feed(Data("HTTP".utf8) + Data(count: 8))
        check("reports an error rather than decoding garbage when the magic is wrong",
              r.errors.count == 1 && r.infos.isEmpty
                && (r.errors.first?.localizedDescription.contains("not an rtl_tcp server") ?? false),
              "\(r.errors)")
    }
    do {
        // The header can arrive in pieces like anything else on TCP.
        let r = Rig()
        let h = Rig.header(tuner: 6, gains: 29)
        r.c.feed(h.prefix(5))
        check("waits for the whole 12-byte header", r.infos.isEmpty)
        r.c.feed(h.dropFirst(5))
        check("and then takes it", r.infos.count == 1)
    }

    print("\nrtl_tcp — settings translation")

    do {
        // This is the whole reason the V4 moved off SpyServer: librtlsdr
        // ignores a gain unless gain mode is manual first, and rtl_tcp's own
        // `-g 0` startup flag means *automatic*.
        let r = Rig()
        r.handshake()
        r.sent = []
        r.c.setSetting(.gain, 12)
        let cmds = r.cmds
        let modeAt = cmds.firstIndex { $0.cmd == RtlTcpClient.cmdSetGainMode }
        let gainAt = cmds.firstIndex { $0.cmd == RtlTcpClient.cmdSetTunerGainIndex }
        check("leaves the tuner AGC before setting a gain index",
              modeAt != nil && gainAt != nil && gainAt! > modeAt!
                && cmds[modeAt!].param == 1
                && r.last(RtlTcpClient.cmdSetAgcMode) == 0
                && r.last(RtlTcpClient.cmdSetTunerGainIndex) == 12,
              "\(cmds)")
    }
    do {
        let r = Rig()
        r.handshake()
        r.c.setSetting(.gain, 99)
        check("clamps a gain index to what the device reported",
              r.last(RtlTcpClient.cmdSetTunerGainIndex) == 28)
    }
    do {
        let r = Rig()
        r.handshake()
        r.c.setSetting(.iqDecimation, 3)       // 2.4 MS/s >> 3 = 300 kS/s
        r.c.setSetting(.iqFrequency, 810_000)
        r.c.setSetting(.streamingEnabled, 1)
        check("turns a decimation stage into a device sample rate on stream start",
              r.last(RtlTcpClient.cmdSetSampleRate) == 300_000
                && r.last(RtlTcpClient.cmdSetFreq) == 810_000)
    }
    do {
        let r = Rig()
        r.handshake()
        r.c.setSetting(.iqFrequency, 954_000)
        r.c.setSetting(.gain, 7)
        r.sent = []
        r.c.setSetting(.streamingEnabled, 1)
        check("re-asserts frequency and gain on stream start, for reconnects",
              r.last(RtlTcpClient.cmdSetFreq) == 954_000
                && r.last(RtlTcpClient.cmdSetTunerGainIndex) == 7)
    }
    do {
        let r = Rig()
        r.handshake()
        r.c.setFrequency(594_000)
        check("a retune is reported back as the sync's centre",
              r.syncs.last?.iqCenterFreq == 594_000)
    }

    print("\nrtl_tcp — IQ conversion")

    func stream(_ stage: UInt32, _ digitalDb: UInt32, _ body: [UInt8]) -> Rig {
        let r = Rig()
        r.handshake()
        r.c.setSetting(.iqDecimation, stage)
        r.c.setSetting(.iqDigitalGain, digitalDb)
        r.c.setSetting(.streamingEnabled, 1)
        r.c.feed(Data(body))
        return r
    }

    do {
        let r = stream(3, 0, [255, 0, 128, 127])
        let v = r.samples
        check("maps 8-bit unsigned to int16, centred and scaled",
              r.packets.count == 1 && r.packets[0].format == .int16
                && v == [Int16((127.5 * 256).rounded()), Int16((-127.5 * 256).rounded()), 128, -128],
              "\(v)")
    }
    do {
        let plain = Double(stream(3, 0, [140, 128]).samples[0])
        let lifted = Double(stream(3, 9, [140, 128]).samples[0])
        check("applies the same decimation digital gain SpyServer would have",
              abs(lifted / plain - pow(10, 9.0 / 20)) < 0.01, "\(lifted / plain)")
    }
    do {
        let v = stream(3, 20, [255, 0]).samples
        check("clamps rather than wrapping when the digital gain overdrives int16",
              v == [32767, -32768], "\(v)")
    }
    do {
        // A TCP read can end between the I and the Q byte. Losing that byte
        // would swap I and Q for the rest of the stream.
        let r = Rig()
        r.handshake()
        r.c.setSetting(.iqDecimation, 3)
        r.c.setSetting(.iqDigitalGain, 0)
        r.c.setSetting(.streamingEnabled, 1)
        r.c.feed(Data([255]))
        r.c.feed(Data([0, 128, 128]))
        let v = r.samples
        check("carries a split IQ pair across chunk boundaries",
              v.count == 4 && v[0] == Int16((127.5 * 256).rounded())
                && v[1] == Int16((-127.5 * 256).rounded()),
              "\(v)")
    }
    do {
        let r = Rig()
        r.handshake()
        r.c.feed(Data([255, 0, 128, 128]))
        check("emits nothing while streaming is off", r.packets.isEmpty)
    }
    do {
        // Stage 4 is 150 kS/s, reached from 300 kS/s by halving once, so half
        // as many pairs come out as go in.
        let body = [UInt8](repeating: 128, count: 4096)
        let r = stream(4, 0, body)
        let pairsOut = r.samples.count / 2
        check("decimates by the planned factor", pairsOut == body.count / 2 / 2, "\(pairsOut)")
    }
    do {
        // Bytes that arrive together with the header are IQ, not lost.
        let r = Rig()
        r.c.setSetting(.iqDecimation, 3)
        r.c.setSetting(.streamingEnabled, 1)
        r.c.feed(Rig.header(tuner: 6, gains: 29) + Data([255, 0]))
        check("keeps IQ that arrives in the same read as the header", r.samples.count == 2)
    }

    print("\nrtl_tcp — rate-change settling")

    do {
        let r = Rig(settle: 10)
        r.handshake()
        r.c.setSetting(.iqDecimation, 3)
        r.c.setSetting(.streamingEnabled, 1)
        r.c.feed(Data([255, 0, 128, 128]))
        check("drops the samples still in flight at the previous rate", r.packets.isEmpty)
    }
    do {
        let r = Rig(settle: 0)
        r.handshake()
        r.c.setSetting(.iqDecimation, 3)
        r.c.setSetting(.streamingEnabled, 1)
        r.c.stopStreaming()
        r.sent = []
        r.c.setSetting(.streamingEnabled, 1)
        check("does not resend the rate when it has not changed",
              r.last(RtlTcpClient.cmdSetSampleRate) == nil)
        r.c.feed(Data([255, 0, 128, 128]))
        check("and streams straight away on restart", r.packets.count == 1)
    }

    print("\nrtl_tcp — source selection")
    check("default port is 8890, the V4's, not rtl_tcp's own 1234",
          RtlTcpClient.defaultPort == 8890)
}
