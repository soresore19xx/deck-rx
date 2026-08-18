#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-08-18-195032
# Builds /Applications/deck-rx.app from mac-app/Sources (swiftc + hand-assembled
# bundle + ad-hoc signature). The bundle exists so a Stream Deck profile can be
# bound to it via the profile's "application" setting. Idempotent.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/deck-rx.app"
BIN="$HERE/deck-rx"
ICONSET="$HERE/deck-rx.iconset"
ICNS="$HERE/deck-rx.icns"
SVG="$HERE/../com.hogehoge.deck-rx.sdPlugin/imgs/icon-source.svg"
EXE="$APP/Contents/MacOS/deck-rx"

# --- 1. build the binary ---
# No `set -e`: the codesign step below needs its own fallback path.
echo "==> swiftc build (-O) ..."
if ! ( cd "$HERE" && swiftc Sources/*.swift -o "$BIN" -framework AppKit -O ); then
  echo "ERROR: swiftc build failed"; exit 1
fi
[ -x "$BIN" ] || { echo "ERROR: binary missing ($BIN)"; exit 1; }

# --- 2. icon: rendered from the plugin's own icon-source.svg when possible ---
RSVG="$(command -v rsvg-convert || true)"
if [ -n "$RSVG" ] && [ -f "$SVG" ] && { [ ! -f "$ICNS" ] || [ "$SVG" -nt "$ICNS" ]; }; then
  echo "==> rendering icon from $SVG ..."
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
              128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
              512:icon_512x512 1024:icon_512x512@2x; do
    px="${spec%%:*}"; name="${spec##*:}"
    "$RSVG" -w "$px" -h "$px" "$SVG" -o "$ICONSET/$name.png" || { echo "WARN: render $name failed"; }
  done
  iconutil -c icns "$ICONSET" -o "$ICNS" || echo "WARN: iconutil failed (app will use the default icon)"
  rm -rf "$ICONSET"
fi

# --- 3. assemble the bundle ---
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" \
  || { echo "ERROR: mkdir failed ($APP)"; exit 1; }

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>deck-rx</string>
	<key>CFBundleIconFile</key>
	<string>deck-rx</string>
	<key>CFBundleIdentifier</key>
	<string>com.hogehoge.deckrx</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>deck-rx</string>
	<key>CFBundleDisplayName</key>
	<string>deck-rx</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
PLIST
[ -s "$APP/Contents/Info.plist" ] || { echo "ERROR: Info.plist write failed"; exit 1; }

[ -f "$ICNS" ] && cp -p "$ICNS" "$APP/Contents/Resources/deck-rx.icns"

cp "$BIN" "$EXE" || { echo "ERROR: could not install executable ($EXE)"; exit 1; }
chmod +x "$EXE" || { echo "ERROR: chmod failed"; exit 1; }

# --- 4. ad-hoc signature (fall back to unsigned local app) ---
if codesign --force --deep -s - "$APP" 2>/dev/null; then
  echo "ad-hoc signature OK"
else
  rm -rf "$APP/Contents/_CodeSignature"
  echo "signing failed -> removed _CodeSignature (runs unsigned, locally)"
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Let LaunchServices notice the bundle so it shows up in pickers immediately.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "deployed: $EXE"
echo "launch test: open \"$APP\""
