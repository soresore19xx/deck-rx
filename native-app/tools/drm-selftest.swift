// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-09-04-220000
// Proves the Swift half of the DRM path — DrmResampler and the C bridge —
// against a recording whose decode is already known, without a receiver, a
// window or a sound card.
//
// The C++ core has its own harness (drm-core/drm-cli). This one exists because
// the core being right says nothing about the resampler in front of it: that is
// new code, it runs at whatever odd rate the SpyServer picks, and a mistake in
// it looks exactly like bad propagation.
//
//   swiftc -O -D DRM_ENABLED -import-objc-header <core>/drm_bridge.h \
//          ../Sources/DrmDecode.swift drm-selftest.swift \
//          -L<core>/out/macos -ldrmcore -L<fdk>/macos -lfdk-aac -lc++ -o drm-selftest
//   ./drm-selftest <file.s16> <inRateHz> <offsetHz>
//
// The file is int16 interleaved IQ, the layout the SpyServer sends.
// ====================
import Foundation

// swiftc only allows top-level statements in a file called main.swift.
@main
enum DrmSelfTest {
    static func main() {

    let args = CommandLine.arguments
    guard args.count >= 4,
          let iq = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
          let inRate = Double(args[2]),
          let offset = Double(args[3])
    else {
        FileHandle.standardError.write("usage: drm-selftest <file.s16> <inRateHz> <offsetHz>\n".data(using: .utf8)!)
        exit(2)
    }

    let samples = iq.count / 4
    print("in: \(args[1])  \(samples) samples @ \(Int(inRate)) Hz, offset \(Int(offset)) Hz")

    let session = DrmSession()
    var audioFrames = 0
    var seen = [String: String]()

    session.onState = { key, value in
        seen[key] = value
        print("STATE \(key) = \(value)")
    }
    session.onAudio = { pcm in
        audioFrames += pcm.count / 2
    }
    session.start(inRate: inRate, shiftHz: -offset)

    // Fed in packet-sized bites on another thread, the way the receiver does it,
    // with the main queue left free to deliver the state callbacks.
    let feeder = DispatchQueue(label: "drm-selftest.feed")
    feeder.async {
        let chunk = Int(inRate / 10) * 4          // 100 ms
        var at = 0
        while at < iq.count {
            let n = min(chunk, iq.count - at)
            session.feed(iq.subdata(in: at ..< (at + n)))
            at += n
            // The decoder's input ring is finite; real time is what it is sized
            // for. Four times that keeps the test short without overrunning it.
            Thread.sleep(forTimeInterval: 0.1 / 4)
        }
        // The worker is still a second or two behind at this point.
        Thread.sleep(forTimeInterval: 2)
        DispatchQueue.main.async {
            let ok = seen["facSync"] == "yes" && seen["sdcSync"] == "yes" && audioFrames > 0
            print("---")
            print("service   : \(seen["service"] ?? "-")")
            print("coding    : \(seen["datacoding"] ?? "-")")
            print("audio     : \(seen["audioMode"] ?? "-") \(seen["aacData"] ?? "")")
            print("audio out : \(String(format: "%.1f", Double(audioFrames) / 48000)) s")
            print(ok ? "PASS" : "FAIL")
            exit(ok ? 0 : 1)
        }
    }

    RunLoop.main.run()

    }
}
