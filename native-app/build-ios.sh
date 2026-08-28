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
     Sources/StationLabel.swift Sources/RadioConfig.swift Sources/PresetStore.swift \
     Sources/SpectrumView.swift Sources/FreqView.swift Sources/SignalMeter.swift"

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

# The icon. A bare swiftc build has no asset catalogue, so the PNGs go in the
# bundle root and Info.plist names them: iOS still resolves that older form, and
# it needs no actool. Without any of it the home screen shows a black tile.
RSVG="$(command -v rsvg-convert || true)"
ICON_SVG="$HERE/icon-ios.svg"
if [ -n "$RSVG" ] && [ -f "$ICON_SVG" ]; then
  echo "==> rendering icons ..."
  for spec in 40:AppIcon20x20@2x 58:AppIcon29x29@2x 80:AppIcon40x40@2x \
              120:AppIcon60x60@2x 152:AppIcon76x76@2x 167:AppIcon83.5x83.5@2x \
              1024:AppIcon1024; do
    px="${spec%%:*}"; name="${spec##*:}"
    "$RSVG" -w "$px" -h "$px" "$ICON_SVG" -o "$APP/$name.png" || echo "WARN: icon $name failed"
  done
else
  echo "WARN: rsvg-convert or icon-ios.svg missing - the app will show a black icon"
fi

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
	<key>CFBundleIcons</key>
	<dict>
		<key>CFBundlePrimaryIcon</key>
		<dict>
			<key>CFBundleIconFiles</key>
			<array>
				<string>AppIcon20x20</string>
				<string>AppIcon29x29</string>
				<string>AppIcon40x40</string>
				<string>AppIcon60x60</string>
				<string>AppIcon76x76</string>
				<string>AppIcon83.5x83.5</string>
			</array>
			<key>UIPrerenderedIcon</key><false/>
		</dict>
	</dict>
	<key>CFBundleIcons~ipad</key>
	<dict>
		<key>CFBundlePrimaryIcon</key>
		<dict>
			<key>CFBundleIconFiles</key>
			<array>
				<string>AppIcon20x20</string>
				<string>AppIcon29x29</string>
				<string>AppIcon40x40</string>
				<string>AppIcon76x76</string>
				<string>AppIcon83.5x83.5</string>
			</array>
			<key>UIPrerenderedIcon</key><false/>
		</dict>
	</dict>
	<key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
	<!-- Landscape only. This is a receiver front panel: a preset list beside a
	     spectrum beside its controls is a wide arrangement, and the portrait
	     layout was a compromise nobody asked for — the iPad is held landscape
	     when it is being a radio. -->
	<key>UISupportedInterfaceOrientations</key>
	<array>
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
  echo "  Xcode > Settings > Accounts > + > Apple ID, then that account's"
  echo "  Manage Certificates > + > Apple Development."
  echo "  A Developer Program certificate lasts a year; a free Apple ID gives"
  echo "  seven days, after which the installed app stops launching."
  exit 1
fi
echo "==> identity: $IDENTITY"

# Pick the profile that is actually for this app, not simply the newest one.
# Newest is right exactly once — the first time a profile exists at all. After
# that, any other app built on this Mac leaves a newer one, and signing with it
# fails on the device with a mismatch that reads like a certificate problem.
PROFILE=""
for f in ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
         ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
  [ -f "$f" ] || continue
  appid="$(security cms -D -i "$f" 2>/dev/null \
           | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)"
  # The value is TEAMID.<app id>. Strip the team, then take an exact match, or
  # a wildcard whose prefix this bundle actually sits under: com.hogehoge.*
  # covers com.hogehoge.deckrx.ipad and com.other.* does not. Matching any
  # wildcard would sign with a profile the device then refuses, which reads on
  # the iPad as a corrupt app rather than as the wrong profile.
  want="${appid#*.}"
  case "$want" in
    "$BUNDLE_ID") PROFILE="$f"; break ;;
    *".*")
      prefix="${want%\*}"
      case "$BUNDLE_ID" in
        "$prefix"*) PROFILE="$f"; break ;;
      esac
      ;;
  esac
done
if [ -z "$PROFILE" ]; then
  echo "ERROR: no provisioning profile for $BUNDLE_ID."
  echo
  echo "  This is a bare swiftc build, not an Xcode project, so nothing here"
  echo "  asks Xcode to create one. With a Developer Program account, either:"
  echo
  echo "   a) developer.apple.com > Certificates, Identifiers & Profiles:"
  echo "      register the iPad's UDID under Devices, add an App ID for"
  echo "      $BUNDLE_ID (or a wildcard), create an iOS App Development"
  echo "      profile from it, download it, and double-click it — or drop it in"
  echo "      ~/Library/MobileDevice/Provisioning Profiles/"
  echo "   b) or make a throwaway Xcode project with this bundle id, let"
  echo "      automatic signing issue the profile once, then never open it"
  echo "      again. This script finds what Xcode leaves behind."
  echo
  echo "  A wildcard App ID is worth preferring: it covers this bundle id and"
  echo "  anything else built the same way, and the search above accepts it."
  exit 1
fi
echo "==> profile: $(basename "$PROFILE")"
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
# The identifier out of the JSON rather than out of the table. The table's
# columns shift with name length and with whatever devicectl decides to show,
# so picking a field by position works until the day the iPad is called
# something else.
DEVJSON="$(mktemp -t deckrx-devices)"
xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1 || true
DEVICE="$(python3 - "$DEVJSON" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for dev in d.get("result", {}).get("devices", []):
    props = dev.get("deviceProperties", {})
    hw = dev.get("hardwareProperties", {})
    name = props.get("name", "")
    if "ipad" in name.lower() or hw.get("deviceType") == "iPad":
        print(dev.get("identifier", ""))
        break
PYEOF
)"
rm -f "$DEVJSON"
if [ -z "$DEVICE" ]; then
  echo "No iPad visible to devicectl. Connect it by cable, unlock it and trust"
  echo "this Mac, then re-run — or install by hand:"
  echo "  xcrun devicectl device install app --device <id> \"$APP\""
  exit 0
fi
echo "==> installing on $DEVICE"
xcrun devicectl device install app --device "$DEVICE" "$APP"
