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

echo "==> swiftc build (-O) ..."
if ! ( cd "$HERE" && swiftc Sources/*.swift -o "$BIN" -framework AppKit -O ); then
  echo "ERROR: swiftc build failed"; exit 1
fi
[ -x "$BIN" ] || { echo "ERROR: binary missing ($BIN)"; exit 1; }

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || { echo "ERROR: mkdir failed"; exit 1; }
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>deck-rx-receiver</string>
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
