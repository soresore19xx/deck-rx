# Debug helpers

[← Back to README](../README.md)

## LCD panel screenshots

Touching `/tmp/deck-rx-lcd-dump` arms a render-time hook that writes the raw
source SVG of each encoder LCD to `/tmp/deck-rx-lcd-<tag>.svg`
(`tag` ∈ `tune` / `volume` / `options` / `am-options`). Without the flag the
hook is a single `existsSync` check per render and adds no overhead, so it
can be left in production builds.

`scripts/dump-lcd.sh` runs the full capture loop: wipe stale dumps, set the
flag, bounce the plugin (kills the PID in `/tmp/deck-rx.pid` rather than
`pkill -f "<pattern>"` — see the script comment for why), wait up to 120 s
while you cycle through each panel on the device (Stream Deck only
re-renders the *visible* action), then `rsvg-convert -z 2` into
`~/ICON/deck-rx-lcd-<tag>.png` and clear the flag. Use this for README /
store screenshots without having to crop a Stream Deck app window capture.

Forgotten flags from a previous session (`mtime > 10 min`) are GC'd at
plugin startup, so the dump path can't stay armed across restarts. The
script's touch-then-bounce flow keeps the flag fresh, so legitimate
capture sessions are unaffected.

`scripts/lint-lcd.py` parses the dump SVGs and reports overlapping
`<text>` / `<polygon>` boxes (e.g. clock vs 7-seg digits in dial-tune).
`scripts/compare-lcd.sh save` snapshots `~/ICON/` to `~/ICON-baseline/`,
and `compare-lcd.sh` (no args) diffs current PNGs against that baseline
via ImageMagick `compare -metric AE`, dumping diff overlays into
`~/ICON-diff/` — handy when verifying that a render-side tweak only
affected what you intended.

## Dump vs on-device render — render-engine differences

The dump path (rsvg-convert + Pango + fontconfig) and the on-device
path (Stream Deck SDK + Core Text on macOS) draw the same SVG with
**different glyph metrics**. Pango's monospace fallback (Liberation
Mono on most fontconfig setups) tracks wider than Core Text's Menlo,
so a `<text>` element that fits cleanly on-device may overlap an
adjacent shape in the dump. `dumpTuneLcd` accepts this asymmetry as
a fact of life and applies a **dump-only fixup** to the Tune dial's
clock — when inlining freqDisplay's body for the dump SVG, it regex-
swaps the clock `<text>`'s attributes (single-family `Menlo` to bypass
Liberation Mono and avoid Illustrator "missing font" warnings,
`letter-spacing="-2"` to compensate Pango's wider tracking,
`x="189"` for visual centring against the digits). The on-device
output (via `setFeedback`) keeps `seg7svg`'s unmodified `<text>` and
is unaffected. If you ever add another tight-layout text element,
extend the same regex pattern in `dumpTuneLcd` rather than touching
`seg7svg` (which would shift the on-device render too).
