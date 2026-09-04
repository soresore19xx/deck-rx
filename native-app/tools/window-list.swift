// === Claude origin ===
// Created/placed by Anthropic Claude Code at: 2026-09-05-030000
// Prints the on-screen window ids and sizes of an app, so a screenshot can be
// taken of a window rather than of the whole desktop.
//
// `screencapture -l<id>` needs an id and there is no way to get one from the
// shell. Reading the window list needs no permission — only window *titles*
// are privileged, and this does not ask for them — whereas capturing does, so
// the capture itself still has to run from the desktop session.
//
//   swiftc -O window-list.swift -o window-list
//   ./window-list "Deck RX Solo"
// ====================
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Deck RX Solo"

guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                            kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("cannot read the window list\n".data(using: .utf8)!)
    exit(1)
}

var found = 0
for w in list {
    guard let name = w[kCGWindowOwnerName as String] as? String, name.contains(owner),
          let id = w[kCGWindowNumber as String] as? Int,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          let width = b["Width"] as? Double, let height = b["Height"] as? Double
    else { continue }
    // Menu-bar items and other tiny surfaces share the owner name; a window
    // worth photographing is not 30 px tall.
    if width < 200 || height < 120 { continue }
    let x = b["X"] as? Double ?? 0, y = b["Y"] as? Double ?? 0
    print("\(id) \(Int(width))x\(Int(height)) at \(Int(x)),\(Int(y))")
    found += 1
}
if found == 0 {
    FileHandle.standardError.write("no windows for \"\(owner)\"\n".data(using: .utf8)!)
    exit(2)
}
