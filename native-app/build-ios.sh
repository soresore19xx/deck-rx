#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-08-24-000000
# Builds the iPadOS bundle from the same Sources/ tree as build-app.sh.
# Usage: ./build-ios.sh sim [install]   simulator build (no signing needed)
#        ./build-ios.sh device          device build, signed for the iPad
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-sim}"
DO_INSTALL="${2:-install}"

BUNDLE_ID="com.hogehoge.deckrx.ipad"
NAME="Deck RX"
DEPLOY_TARGET="17.0"
DATA_SRC="$HERE/../com.hogehoge.deck-rx.sdPlugin/data"

# The receiver is compiled from the same files the Mac app uses. AppKit's views
# and AppServer are the only things left out: the first are being ported, and
# the second is the Stream Deck plugin's control endpoint, which has nothing to
# answer on an iPad.
SRC="Sources/Platform.swift Sources/Receiver.swift Sources/SpectrumFeed.swift \
     Sources/iOSApp.swift Sources/LocalRadio.swift Sources/SpyClient.swift \
     Sources/FFT.swift Sources/AMDemod.swift Sources/Demods.swift \
     Sources/AudioSink.swift Sources/AudioLeveling.swift Sources/IqNr.swift \
     Sources/StationLabel.swift Sources/RadioConfig.swift Sources/PresetStore.swift"

case "$TARGET" in
  sim)    SDK=iphonesimulator; TRIPLE="arm64-apple-ios$DEPLOY_TARGET-simulator"; PLATFORM=iPhoneSimulator ;;
  device) SDK=iphoneos;        TRIPLE="arm64-apple-ios$DEPLOY_TARGET";           PLATFORM=iPhoneOS ;;
  *) echo "usage: $0 [sim|device] [install|no-install]"; exit 2 ;;
esac

APP="$HERE/build/$TARGET/$NAME.app"
rm -rf "$APP"; mkdir -p "$APP" || exit 1

echo "==> swiftc ($TRIPLE) ..."
( cd "$HERE" && xcrun -sdk "$SDK" swiftc $SRC -o "$APP/DeckRX" -target "$TRIPLE" -O \
      -module-name DeckRX ) \
  || { echo "ERROR: swiftc build failed"; exit 1; }

# iOS reads a flat bundle: the executable and the resources sit at the top,
# with no Contents/ in between. Receiver.seedData() copies these out on first
# run, so the app has station names on a device that has never seen the plugin.
for f in jp-stations.json eibi.txt callsigns.json presets.json; do
  if [ -f "$DATA_SRC/$f" ]; then cp -p "$DATA_SRC/$f" "$APP/$f"
  else echo "WARN: $f missing - no station names for it"; fi
done

# UILaunchScreen is not decoration: without it iPadOS runs the app in
# compatibility mode, letterboxed into a phone-sized rectangle.
# NSLocalNetworkUsageDescription is what makes a connection to a SpyServer on
# the LAN possible at all — without it the first connect is refused by privacy,
# which looks exactly like a server that is down.
cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>DeckRX</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>$PLATFORM</string></array>
	<key>MinimumOSVersion</key><string>$DEPLOY_TARGET</string>
	<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
	<key>UILaunchScreen</key><dict/>
	<key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UIBackgroundModes</key><array><string>audio</string></array>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key><false/>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UIWindowSceneSessionRoleApplication</key>
			<array>
				<dict>
					<key>UISceneConfigurationName</key><string>Default</string>
					<key>UISceneDelegateClassName</key><string>SceneDelegate</string>
				</dict>
			</array>
		</dict>
	</dict>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Connects to your SpyServer on the local network.</string>
</dict>
</plist>
PLIST

if [ "$TARGET" = "sim" ]; then
  codesign --force -s - "$APP" 2>/dev/null && echo "ad-hoc signed"
  echo "built: $APP"
  [ "$DO_INSTALL" = "install" ] || exit 0
  BOOTED="$(xcrun simctl list devices booted | grep -c Booted)"
  if [ "$BOOTED" = "0" ]; then
    echo "no booted simulator - boot one, then: xcrun simctl install booted \"$APP\""
    exit 0
  fi
  xcrun simctl install booted "$APP" || { echo "ERROR: install failed"; exit 1; }
  xcrun simctl launch booted "$BUNDLE_ID" || { echo "ERROR: launch failed"; exit 1; }
  exit 0
fi

# --- device: signed, or it will not install ---
# A development certificate has to exist first (Xcode > Settings > Accounts >
# Manage Certificates). Saying so beats letting codesign fail with "no identity
# found", which reads like a broken script rather than a missing account.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
            | grep -o '"Apple Development: [^"]*"' | head -1 | tr -d '"')"
if [ -z "$IDENTITY" ]; then
  echo "ERROR: no Apple Development certificate in the keychain."
  echo "  Xcode > Settings > Accounts > (Apple ID) > Manage Certificates > + > Apple Development"
  echo "  then connect the iPad once so Xcode registers it and issues a profile."
  exit 1
fi

PROFILE="$(ls -t ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
           ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision 2>/dev/null | head -1)"
if [ -z "$PROFILE" ]; then
  echo "ERROR: no provisioning profile. Connect the iPad to Xcode once with"
  echo "  automatic signing on, so a profile for $BUNDLE_ID is issued."
  exit 1
fi
cp "$PROFILE" "$APP/embedded.mobileprovision"

TEAM="$(security cms -D -i "$PROFILE" 2>/dev/null \
        | plutil -extract Entitlements.com\\.apple\\.developer\\.team-identifier raw - 2>/dev/null)"
ENT="$HERE/build/$TARGET/entitlements.plist"
cat > "$ENT" <<ENTS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
	<key>com.apple.developer.team-identifier</key><string>$TEAM</string>
	<key>get-task-allow</key><true/>
</dict>
</plist>
ENTS

codesign --force --sign "$IDENTITY" --entitlements "$ENT" --timestamp=none "$APP" \
  || { echo "ERROR: codesign failed"; exit 1; }
echo "signed: $APP"

[ "$DO_INSTALL" = "install" ] || exit 0
DEVICE="$(xcrun devicectl list devices 2>/dev/null | grep -i 'ipad' | awk '{print $(NF-1)}' | head -1)"
if [ -z "$DEVICE" ]; then
  echo "iPad not visible to devicectl. Connect it (and trust this Mac), then:"
  echo "  xcrun devicectl device install app --device <id> \"$APP\""
  exit 0
fi
xcrun devicectl device install app --device "$DEVICE" "$APP"
