import Foundation

#if canImport(UIKit)
import UIKit
typealias XColor = UIColor
typealias XView = UIView
typealias XFont = UIFont
#else
import AppKit
typealias XColor = NSColor
typealias XView = NSView
typealias XFont = NSFont
#endif

/// The handful of drawing calls that are spelled differently on each platform.
///
/// Everything else in the views is already CoreGraphics, which is the same on
/// both — these are the seams, and keeping them in one place is what lets a
/// view like the spectrum be one file rather than two that drift.
extension XView {
    /// UIKit spells this as a method; AppKit as a property.
    func redraw() {
        #if canImport(UIKit)
        setNeedsDisplay()
        #else
        needsDisplay = true
        #endif
    }

    /// Give the view a backing layer and a ground colour. UIKit views always
    /// have a layer; AppKit ones have to be asked for one first.
    func setBacking(_ color: XColor) {
        #if canImport(UIKit)
        layer.backgroundColor = color.cgColor
        #else
        wantsLayer = true
        layer?.backgroundColor = color.cgColor
        #endif
    }

    /// Device pixels per point, for the one thing that is sized in pixels
    /// rather than points: the waterfall's bitmap. Sizing it in points let a
    /// 2x display stretch each pixel over four, and the waterfall alone looked
    /// soft against crisp text.
    var pixelScale: CGFloat {
        #if canImport(UIKit)
        return window?.screen.scale ?? traitCollection.displayScale
        #else
        return window?.backingScaleFactor ?? 1
        #endif
    }

    /// The cursor rects need rebuilding. Nothing to do where there is no
    /// cursor.
    func invalidateCursors() {
        #if !canImport(UIKit)
        window?.invalidateCursorRects(for: self)
        #endif
    }

    /// The context a draw(_:) override is drawing into.
    var currentContext: CGContext? {
        #if canImport(UIKit)
        return UIGraphicsGetCurrentContext()
        #else
        return NSGraphicsContext.current?.cgContext
        #endif
    }
}

/// A monospaced face at a weight, on either platform. The window is built on
/// one, and the weights are named the same in both frameworks.
func xMono(_ size: CGFloat, _ weight: XFont.Weight = .regular) -> XFont {
    XFont.monospacedSystemFont(ofSize: size, weight: weight)
}

/// The one place a platform difference is allowed to live.
///
/// The receiver — protocol, FFT, demodulators, audio queue — is the same code
/// on both platforms, and stays that way: a second copy of the demodulator for
/// iOS is how the two would quietly stop agreeing about what a signal sounds
/// like. What actually differs is where files go, and that is small enough to
/// answer here rather than with `#if` scattered through the sources.
///
/// macOS keeps every path exactly where it was. Nothing below changes what the
/// existing app reads or writes.
enum Plat {

    /// Application Support, per platform.
    ///
    /// macOS: the real home directory, next to the plugin this app grew out of.
    /// iOS: the app container. There is no user home to reach for, and the
    /// container's Application Support is already private to this app, so the
    /// bundle-id subdirectory the Mac needs is not needed here.
    static let appSupport: URL = {
        #if os(macOS)
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support")
        #else
        let fm = FileManager.default
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
        #endif
    }()

    /// Scratch directory for the status feed and the liveness flag.
    ///
    /// Those two are the front-end's channel to the plugin, which exists only
    /// on the Mac. On iOS the path is still defined — the code that names it
    /// compiles for both — but nothing there writes or reads it.
    static let scratch: String = {
        #if os(macOS)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: "/Volumes/RAMDisk", isDirectory: &isDir),
           isDir.boolValue {
            return "/Volumes/RAMDisk"
        }
        return "/tmp"
        #else
        return NSTemporaryDirectory()
        #endif
    }()

    /// True where a Stream Deck plugin can exist at all. Guards the paths that
    /// only mean something next to one: the plugin's config seed, its data
    /// directory, the SDR++ bookmark file the importer reads.
    #if os(macOS)
    static let hasPluginHost = true
    #else
    static let hasPluginHost = false
    #endif
}


/// The window's palette, in a form both platforms can build a colour from.
///
/// KNOWN DUPLICATION, deliberate for now: `enum P` in main.swift still carries
/// its own copies of these same values, and is under active edit there. Folding
/// `P` onto this is a job for when the AppKit views are ported, not a silent
/// refactor underneath work in progress. Until then, a change to a shade has to
/// be made in both places — which is exactly why it should not stay this way.
enum Pal {
    static let bg     = XColor(red: 0.071, green: 0.075, blue: 0.086, alpha: 1) // #121316
    static let panel  = XColor(red: 0.090, green: 0.094, blue: 0.110, alpha: 1) // #17181C
    static let sunken = XColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1) // #0C0D0F
    static let rule   = XColor(red: 0.271, green: 0.286, blue: 0.322, alpha: 1) // #454952
    static let text   = XColor(red: 0.941, green: 0.949, blue: 0.961, alpha: 1) // #F0F2F5
    static let dim    = XColor(red: 0.765, green: 0.788, blue: 0.816, alpha: 1) // #C3C9D0
    static let faint  = XColor(red: 0.596, green: 0.627, blue: 0.659, alpha: 1) // #98A0A8
    static let accent = XColor(red: 0.349, green: 0.851, blue: 0.451, alpha: 1) // #59D973
    static let blue   = XColor(red: 0.400, green: 0.702, blue: 0.949, alpha: 1) // #66B3F2
    static let warn   = XColor(red: 0.949, green: 0.749, blue: 0.349, alpha: 1) // #F2BF59
}
