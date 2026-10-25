#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-10-24-120000
# Builds the RTL-SDR DriverKit extension the iPad app carries, from sources this
# repository does not hold: fetches RTLBridge, patches it, renames it into the
# app's bundle id and lets Xcode sign it.
#
# The driver is arvedviehweger/RTL-SDR-USB-iPadOS (Apache-2.0) on top of
# gnuradio4-blocks' RTL2832Device (MIT). Ours here is the patch and this
# script. See README.md.
#
# Usage: ./build-driver.sh          fetch, patch and build
#        ./build-driver.sh clean    throw the build directory away
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"

# Pinned: the patch is written against this tree.
UPSTREAM_REPO=https://github.com/arvedviehweger/RTL-SDR-USB-iPadOS.git
UPSTREAM_COMMIT=17179afd2924c475089db696cdb9c3b490a3e49c   # 2026-10-15, build 16
UPSTREAM_ID=com.m0kds.RTL-SDR-Host
UPSTREAM_TEAM=K89F9CL4ZU

# The driver has to sit under the app's own bundle id, or iPadOS will not
# take it from the app.
APP_ID="com.hogehoge.deckrx.ipad"

if [ "${1:-}" = "clean" ]; then rm -rf "$B"; echo "removed $B"; exit 0; fi
mkdir -p "$B" || exit 1

# The team: DECKRX_TEAM, or the one on the profile build-ios.sh already uses.
TEAM="${DECKRX_TEAM:-}"
if [ -z "$TEAM" ]; then
  for f in ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
           ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
    [ -f "$f" ] || continue
    appid="$(security cms -D -i "$f" 2>/dev/null \
             | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)"
    case "${appid#*.}" in
      "$APP_ID"|com.hogehoge.\*) TEAM="${appid%%.*}"; break ;;
    esac
  done
fi
[ -n "$TEAM" ] || { echo "ERROR: no team - set DECKRX_TEAM"; exit 1; }
echo "==> team $TEAM"

SRC="$B/rtlbridge"
if [ ! -d "$SRC/.git" ]; then
  echo "==> cloning RTL-SDR-USB-iPadOS"
  git clone --quiet "$UPSTREAM_REPO" "$SRC" || { echo "ERROR: clone failed"; exit 1; }
fi
git -C "$SRC" fetch --quiet origin 2>/dev/null
git -C "$SRC" reset --quiet --hard
git -C "$SRC" checkout --quiet "$UPSTREAM_COMMIT" \
  || { echo "ERROR: commit $UPSTREAM_COMMIT not in $UPSTREAM_REPO"; exit 1; }
git -C "$SRC" submodule update --quiet --init --recursive || { echo "ERROR: submodule"; exit 1; }
git -C "$SRC/third_party/gnuradio4-blocks" reset --quiet --hard

# R828D (RTL-SDR Blog V4) PLL: without this the V4 hears noise on every band.
git -C "$SRC/third_party/gnuradio4-blocks" apply "$HERE/r828d-pll.patch" \
  || { echo "ERROR: r828d-pll.patch does not apply"; exit 1; }

# Airspy HF+: the same dext matches it, selects its IQ alternate setting,
# streams it into the same ring and passes control transfers through.
# libairspyhf, built into the app (below), does the rest.
git -C "$SRC" apply "$HERE/airspyhf-dext.patch" \
  || { echo "ERROR: airspyhf-dext.patch does not apply"; exit 1; }

# libairspyhf for the app, pinned. build-ios.sh compiles it against
# airspyhf/libusb_dext.c, the libusb stand-in that talks to this driver.
AIRSPYHF_REPO=https://github.com/airspy/airspyhf.git
AIRSPYHF_COMMIT=24fe8ffcb00b14f827268bbad89ae1392de055e5
AH="$B/airspyhf"
if [ ! -d "$AH/.git" ]; then
  echo "==> cloning airspyhf"
  git clone --quiet "$AIRSPYHF_REPO" "$AH" || { echo "ERROR: airspyhf clone failed"; exit 1; }
fi
git -C "$AH" fetch --quiet origin 2>/dev/null
git -C "$AH" checkout --quiet "$AIRSPYHF_COMMIT" \
  || { echo "ERROR: commit $AIRSPYHF_COMMIT not in $AIRSPYHF_REPO"; exit 1; }

# Rename into the app. The build number is the time: iPadOS only swaps a
# running driver for a newer one when the number has gone up. Dotted, because
# the kernel parses a dext's version like a kext's: at most 4 digits per field
# (xnu libkern/OSKextVersion.c). A plain 202610241215 is rejected outright --
# driverkitd realizes the dext and the kernel never loads its personalities.
DEXT_BUILD="$(date +%Y.%m%d.%H%M)"
P="$SRC/RTL-SDR.xcodeproj/project.pbxproj"
sed -i '' -e "s/$UPSTREAM_ID/$APP_ID/g" -e "s/$UPSTREAM_TEAM/$TEAM/g" \
          -e "s/CURRENT_PROJECT_VERSION = [0-9]*;/CURRENT_PROJECT_VERSION = $DEXT_BUILD;/g" "$P"
sed -i '' -e "s/$UPSTREAM_ID/$APP_ID/g" "$SRC/RTL-SDR/Info.plist"
if grep -q "$UPSTREAM_ID\|$UPSTREAM_TEAM" "$P" "$SRC/RTL-SDR/Info.plist"; then
  echo "ERROR: upstream ids left after the rename"; exit 1
fi

# Built through the host app's scheme, not the driver's alone: automatic
# signing then registers both ids - the driver's, and the app's with
# communicates-with-drivers - and leaves a profile for each. build-ios.sh
# signs Deck RX with the app one; the host app itself is never installed.
echo "==> xcodebuild (build $DEXT_BUILD) ..."
LOG="$B/xcodebuild.log"
( cd "$SRC" && xcodebuild -project RTL-SDR.xcodeproj -scheme "RTL-SDR Host" -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$B/dd" \
    -allowProvisioningUpdates build ) > "$LOG" 2>&1
if ! grep -q "BUILD SUCCEEDED" "$LOG"; then
  grep -E "error:" "$LOG" | sort -u | head -20
  echo "ERROR: xcodebuild failed - $LOG"; exit 1
fi

DEXT="$(find "$B/dd/Build/Products" -name "$APP_ID.driver.dext" -path '*SystemExtensions*' | head -1)"
[ -n "$DEXT" ] || { echo "ERROR: no $APP_ID.driver.dext in the build"; exit 1; }
rm -rf "$B/$APP_ID.driver.dext"
cp -R "$DEXT" "$B/" || exit 1
echo "built: $B/$APP_ID.driver.dext ($DEXT_BUILD)"
