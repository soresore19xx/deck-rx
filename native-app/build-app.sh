#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-08-20-221500
# Builds /Applications/Deck RX.app — the native receiver front-end (design D).
# This bundle is the focus target a Stream Deck profile binds to (AppIdentifier),
# so the deck follows the window instead of being switched by hand.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Deck RX.app"
BIN="$HERE/deck-rx-receiver"
EXE="$APP/Contents/MacOS/deck-rx-receiver"
SVG="$HERE/../com.hogehoge.deck-rx.sdPlugin/imgs/icon-source.svg"
ICONSET="$HERE/deck-rx-receiver.iconset"
ICNS="$HERE/deck-rx-receiver.icns"

# --- binary: universal (arm64 + x86_64) ---
# Built as two slices and lipo'd rather than left thin: an arm64-only bundle
# launches nowhere on an Intel Mac, and the failure looks like a broken app
# rather than a wrong architecture. Both slices target the same macOS 12.0
# floor the Info.plist declares.
DEPLOY_TARGET="12.0"
SLICE_ARM="$HERE/.slice-arm64"
SLICE_X86="$HERE/.slice-x86_64"
rm -f "$SLICE_ARM" "$SLICE_X86"

echo "==> swiftc build (-O, arm64) ..."
if ! ( cd "$HERE" && swiftc Sources/*.swift -o "$SLICE_ARM" -framework AppKit -O \
        -target "arm64-apple-macos$DEPLOY_TARGET" ); then
  echo "ERROR: swiftc build failed (arm64)"; exit 1
fi

# The x86_64 slice is allowed to fail without taking the build down: a machine
# without the cross SDK should still get a working native binary rather than
# nothing at all. It says so, so a thin bundle is never a silent surprise.
echo "==> swiftc build (-O, x86_64) ..."
if ( cd "$HERE" && swiftc Sources/*.swift -o "$SLICE_X86" -framework AppKit -O \
        -target "x86_64-apple-macos$DEPLOY_TARGET" ); then
  lipo -create "$SLICE_ARM" "$SLICE_X86" -output "$BIN" \
    || { echo "ERROR: lipo failed"; exit 1; }
else
  echo "WARN: x86_64 slice failed to build - bundle will be arm64 only"
  cp "$SLICE_ARM" "$BIN"
fi
rm -f "$SLICE_ARM" "$SLICE_X86"
[ -x "$BIN" ] || { echo "ERROR: binary missing ($BIN)"; exit 1; }
echo "==> architectures: $(lipo -archs "$BIN")"

# --- icon: rendered from the plugin's own icon-source.svg ---
# Re-rendered only when the SVG is newer than the .icns, so a plain rebuild
# costs nothing. Without rsvg-convert the app falls back to the generic bundle
# icon, which is exactly how it looked before this step existed — a missing
# renderer must not fail the build.
RSVG="$(command -v rsvg-convert || true)"
if [ -n "$RSVG" ] && [ -f "$SVG" ] && { [ ! -f "$ICNS" ] || [ "$SVG" -nt "$ICNS" ]; }; then
  echo "==> rendering icon from $SVG ..."
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
              128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
              512:icon_512x512 1024:icon_512x512@2x; do
    px="${spec%%:*}"; name="${spec##*:}"
    "$RSVG" -w "$px" -h "$px" "$SVG" -o "$ICONSET/$name.png" || echo "WARN: render $name failed"
  done
  iconutil -c icns "$ICONSET" -o "$ICNS" || echo "WARN: iconutil failed (app keeps the default icon)"
  rm -rf "$ICONSET"
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || { echo "ERROR: mkdir failed"; exit 1; }
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>deck-rx-receiver</string>
	<key>CFBundleIconFile</key><string>deck-rx-receiver</string>
	<key>CFBundleIdentifier</key><string>com.hogehoge.deckrx.receiver</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>Deck RX</string>
	<key>CFBundleDisplayName</key><string>Deck RX</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
cp "$BIN" "$EXE" || { echo "ERROR: could not install executable"; exit 1; }
chmod +x "$EXE"
[ -f "$ICNS" ] && cp -p "$ICNS" "$APP/Contents/Resources/deck-rx-receiver.icns"

if codesign --force --deep -s - "$APP" 2>/dev/null; then
  echo "ad-hoc signature OK"
else
  rm -rf "$APP/Contents/_CodeSignature"
  echo "signing failed -> runs unsigned, locally"
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true
echo "deployed: $EXE"
