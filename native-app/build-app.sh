#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-08-20-221500
# Builds two bundles from one source tree:
#   /Applications/Deck RX.app       front-end onto the plugin's receiver
#   /Applications/Deck RX Solo.app  the same window with its own receiver
# They differ only by the STANDALONE compile flag, so a fix to the display
# lands in both and cannot drift.
# This bundle is the focus target a Stream Deck profile binds to (AppIdentifier),
# so the deck follows the window instead of being switched by hand.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Which bundle to build. Both by default.
VARIANT="${1:-both}"
BIN="$HERE/deck-rx-receiver"

# --- icons: one per bundle, or the two apps are indistinguishable in the Dock ---
# The front-end wears the plugin's own icon, because that is what it is a face
# for. Solo has its own: a square pale-blue plate rather than a grey disc, so shape
# and colour both separate them, and the pair still reads apart at 16 px.
RSVG="$(command -v rsvg-convert || true)"

# $1 source SVG, $2 .icns to write. Re-rendered only when the SVG is newer than
# the .icns, so a plain rebuild costs nothing. Without rsvg-convert the app falls
# back to the generic bundle icon, which is exactly how it looked before this
# step existed — a missing renderer must not fail the build.
render_icon() {
  local svg="$1" icns="$2" iconset="${2%.icns}.iconset"
  [ -n "$RSVG" ] && [ -f "$svg" ] || return 0
  { [ ! -f "$icns" ] || [ "$svg" -nt "$icns" ]; } || return 0
  echo "==> rendering icon from $svg ..."
  rm -rf "$iconset"; mkdir -p "$iconset"
  for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
              128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
              512:icon_512x512 1024:icon_512x512@2x; do
    px="${spec%%:*}"; name="${spec##*:}"
    "$RSVG" -w "$px" -h "$px" "$svg" -o "$iconset/$name.png" || echo "WARN: render $name failed"
  done
  iconutil -c icns "$iconset" -o "$icns" || echo "WARN: iconutil failed (app keeps the default icon)"
  rm -rf "$iconset"
}

render_icon "$HERE/../com.hogehoge.deck-rx.sdPlugin/imgs/icon-source.svg" "$HERE/deck-rx-receiver.icns"
render_icon "$HERE/icon-solo.svg" "$HERE/deck-rx-solo.icns"

# --- build one bundle ---
# $1 app path, $2 bundle id, $3 display name, $4 extra swiftc flags, $5 icon base
build_variant() {
  local APP="$1" BUNDLE_ID="$2" NAME="$3" FLAGS="$4" ICON="$5"
  local EXE="$APP/Contents/MacOS/deck-rx-receiver"
  local ICNS="$HERE/$ICON.icns"

  # Two slices and lipo rather than thin: an arm64-only bundle does not launch
  # at all on an Intel Mac, and the failure reads as a broken app rather than a
  # wrong architecture. Both target the macOS floor the Info.plist declares.
  local DEPLOY_TARGET="12.0"
  local SLICE_ARM="$HERE/.slice-arm64" SLICE_X86="$HERE/.slice-x86_64"
  rm -f "$SLICE_ARM" "$SLICE_X86"

  echo "==> $NAME: swiftc (-O, arm64) ..."
  if ! ( cd "$HERE" && swiftc $SRC_FILES -o "$SLICE_ARM" -framework AppKit -O $FLAGS \
          -target "arm64-apple-macos$DEPLOY_TARGET" ); then
    echo "ERROR: swiftc build failed (arm64, $NAME)"; return 1
  fi

  # The x86_64 slice may fail without taking the build down: a machine without
  # the cross SDK should still get a working native binary. It says so, so a
  # thin bundle is never a silent surprise.
  echo "==> $NAME: swiftc (-O, x86_64) ..."
  if ( cd "$HERE" && swiftc $SRC_FILES -o "$SLICE_X86" -framework AppKit -O $FLAGS \
          -target "x86_64-apple-macos$DEPLOY_TARGET" ); then
    lipo -create "$SLICE_ARM" "$SLICE_X86" -output "$BIN" || { echo "ERROR: lipo failed"; return 1; }
  else
    echo "WARN: x86_64 slice failed to build - $NAME will be arm64 only"
    cp "$SLICE_ARM" "$BIN"
  fi
  rm -f "$SLICE_ARM" "$SLICE_X86"
  [ -x "$BIN" ] || { echo "ERROR: binary missing ($BIN)"; return 1; }

  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || { echo "ERROR: mkdir failed"; return 1; }
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>deck-rx-receiver</string>
	<key>CFBundleIconFile</key><string>$ICON</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>$DEPLOY_TARGET</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
  cp "$BIN" "$EXE" || { echo "ERROR: could not install executable"; return 1; }
  chmod +x "$EXE"
  # Clear the other variant's icon if an earlier build left one behind: two
  # .icns in Resources with the plist naming the stale one is a bundle that
  # keeps the face it was meant to lose.
  rm -f "$APP/Contents/Resources/deck-rx-receiver.icns" "$APP/Contents/Resources/deck-rx-solo.icns"
  [ -f "$ICNS" ] && cp -p "$ICNS" "$APP/Contents/Resources/$ICON.icns"

  # Station databases. Only the standalone build reads them — the front-end
  # gets station names from the plugin's status feed.
  # presets.json is bundled too. The first cut left it out on the grounds that
  # one host's station list is not a default for another machine — wrong here,
  # where every machine is the same user's, in the same region, wanting the same
  # stations. A copied .app with an empty preset list is not a working receiver.
  for f in jp-stations.json eibi.txt callsigns.json presets.json; do
    if [ -n "$FLAGS" ] && [ -f "$DATA_SRC/$f" ]; then
      cp -p "$DATA_SRC/$f" "$APP/Contents/Resources/$f"
    elif [ -n "$FLAGS" ]; then
      echo "WARN: $f missing - $NAME will show no station names"
    else
      # Clear a copy an earlier build left behind, or the front-end ships a
      # megabyte of data it never opens.
      rm -f "$APP/Contents/Resources/$f"
    fi
  done

  # Do NOT ad-hoc sign (-s -). TCC identifies ad-hoc code by its cdhash, so
  # every rebuild looks like a different app and the Local Network permission
  # this app needs to reach the SpyServer is asked for again. Signed with a
  # stable identity it is keyed on bundle ID + team, and the grant survives.
  # Same fix as clip-search's native-gui/build-app.sh. The certificate name is
  # never written down here: it contains a real name, so pull it from security.
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
            | awk '/Developer ID Application|Apple Development/ {print $2; exit}')
  if [ -n "$SIGN_ID" ] && codesign --force --deep -s "$SIGN_ID" "$APP" 2>/dev/null; then
    echo "signature OK (stable identity - no re-prompt after a rebuild)"
  elif codesign --force --deep -s - "$APP" 2>/dev/null; then
    echo "WARN: ad-hoc signature (no certificate) -> permission asked again every build"
  else
    rm -rf "$APP/Contents/_CodeSignature"
    echo "signing failed -> runs unsigned, locally"
  fi
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  # Bump the bundle directory's own mtime before re-registering. Everything this
  # script writes lands inside Contents/, which leaves the .app's timestamp
  # untouched, and IconServices keeps serving the cached icon off it: the first
  # build after Solo got its own icon still showed the front-end's disc at 32 and
  # 128 px, and only the 16 px size had changed.
  touch "$APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$APP" 2>/dev/null || true
  echo "deployed: $EXE  ($(lipo -archs "$EXE"))"
}

DATA_SRC="$HERE/../com.hogehoge.deck-rx.sdPlugin/data"

# The front-end has no receiver in it, so the receiver sources are not compiled
# into it at all — not merely switched off. Dead code that cannot run is still
# code that has to be read.
# RadioConfig is shared, not receiver-only: the display scale lives in it, and
# that is the window's setting rather than the radio's. Without it here the
# front-end could not read the scale it was saved at, nor change it.
SHARED="Sources/main.swift Sources/Receiver.swift Sources/SpectrumFeed.swift \
        Sources/SpectrumView.swift Sources/OptionsPanel.swift Sources/FreqView.swift \
        Sources/Platform.swift Sources/RadioConfig.swift Sources/SignalMeter.swift"
RECEIVER="Sources/LocalRadio.swift Sources/AppServer.swift Sources/SpyClient.swift \
          Sources/FFT.swift Sources/AMDemod.swift Sources/Demods.swift \
          Sources/AudioSink.swift Sources/AudioLeveling.swift Sources/IqNr.swift \
          Sources/StationLabel.swift Sources/PresetStore.swift \
          Sources/WefaxDecode.swift Sources/WefaxWindow.swift"

# --- DRM (shortwave digital radio), built only when the core is present ---
# The decoder is not in this repository; drm/fetch.sh downloads and patches it.
# So it may simply not be here, and that must not be an error: with it the Solo
# bundle gets a DRM window, without it the app is exactly what it was.
# Point DRM_CORE_DIR somewhere else to use another copy.
DRM_CORE_DIR="${DRM_CORE_DIR:-$HERE/drm/build/drm-core}"
DRM_FDK_DIR="${DRM_FDK_DIR:-$HERE/drm/build/fdk/out}"
DRM_FLAGS=""
if [ -f "$DRM_CORE_DIR/out/macos/libdrmcore.a" ] && [ -f "$DRM_FDK_DIR/macos/libfdk-aac.a" ]; then
  RECEIVER="$RECEIVER Sources/DrmDecode.swift Sources/DrmWindow.swift"
  DRM_FLAGS="-D DRM_ENABLED -import-objc-header $DRM_CORE_DIR/drm_bridge.h -L$DRM_CORE_DIR/out/macos -ldrmcore -L$DRM_FDK_DIR/macos -lfdk-aac -lc++"
  echo "DRM: linking $DRM_CORE_DIR/out/macos/libdrmcore.a"
else
  echo "DRM: core not built - Solo will have no DRM window"
  echo "     (run drm/fetch.sh to add it)"
fi

if [ "$VARIANT" = "both" ] || [ "$VARIANT" = "front" ]; then
  SRC_FILES="$SHARED"
  build_variant "/Applications/Deck RX.app" "com.hogehoge.deckrx.receiver" "Deck RX" "" \
                "deck-rx-receiver" || exit 1
fi
if [ "$VARIANT" = "both" ] || [ "$VARIANT" = "solo" ]; then
  SRC_FILES="$SHARED $RECEIVER"
  build_variant "/Applications/Deck RX Solo.app" "com.hogehoge.deckrx.solo" "Deck RX Solo" "-D STANDALONE $DRM_FLAGS" \
                "deck-rx-solo" || exit 1
fi
