#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-05-010000
# Turns a locally built bundle into one that opens on someone else's Mac:
# re-signs it with Developer ID and the hardened runtime, sends it to Apple to
# be notarised, staples the ticket, and checks the result with spctl.
#
# build-app.sh deliberately does none of this. It signs with whatever identity
# is to hand so the Local Network permission survives a rebuild, and that is a
# development signature: Gatekeeper rejects it on any machine that did not
# build it. This script is the other half, run when a build is actually going
# somewhere.
#
# It works on a COPY. /Applications is never touched.
#
# Usage: ./notarize.sh [--dmg] ["/Applications/Deck RX Solo.app"] [profile]
#          --dmg   build a disk image with the app, an uninstaller and a drag
#                  target, signed and notarised in its own right
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

WANT_DMG=0
if [ "${1:-}" = "--dmg" ]; then WANT_DMG=1; shift; fi
APP_IN="${1:-/Applications/Deck RX Solo.app}"
PROFILE="${2:-deck-rx-notary}"
OUT="$HERE/build/release"

[ -d "$APP_IN" ] || { echo "ERROR: no bundle at $APP_IN"; exit 1; }

# --- licence gate ---------------------------------------------------------
# A DRM build carries fdk-aac, whose licence grants no patent rights and so
# does not combine with the GPL in a binary that is handed on. Source is
# unaffected; a binary is not. This is the one place that rule can be enforced
# instead of remembered, so it is enforced here.
#
# grep -c and a count, not grep -q: under `set -o pipefail` the -q form closes
# the pipe on its first match, nm dies of SIGPIPE, and the pipeline reports
# failure — so the test read "no DRM here" on exactly the bundles it is meant
# to catch. A licence check that fails open is worse than none.
EXE_IN="$APP_IN/Contents/MacOS/deck-rx-receiver"
DRM_SYMS=0
[ -f "$EXE_IN" ] && DRM_SYMS=$(nm -a "$EXE_IN" 2>/dev/null | grep -c "drm_create" || true)
if [ "${DRM_SYMS:-0}" -gt 0 ]; then
  cat <<'DRM'
ERROR: this bundle has the DRM decoder in it, and must not be distributed.

fdk-aac's licence does not combine with the GPL in a binary that is passed on.
Build one without it and notarise that instead:

  DRM_CORE_DIR=/nonexistent ./build-app.sh solo

Keep the DRM build for yourself; that is allowed and always was.
DRM
  exit 1
fi

# --- the certificate ------------------------------------------------------
# Apple Development will not do: notarisation accepts Developer ID only, and a
# development signature is what makes spctl say "rejected" in the first place.
SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
          | awk '/Developer ID Application/ {print $2; exit}')
if [ -z "$SIGN_ID" ]; then
  cat <<'NOCERT'
ERROR: no "Developer ID Application" certificate in this keychain.

Check the other machines before making one. A team may hold at most five, and
a Developer ID certificate CANNOT BE REVOKED from the portal — a wasted slot
stays wasted.

If one has to be made, do it through developer.apple.com and not through
Xcode's Manage Certificates: Xcode issues off the old G1 intermediate, whose
leaf expires when G1 does (2027-02-01) however new the certificate is. Upload
a CSR from Keychain Access and choose the "G2 Sub-CA (Xcode 11.4.1 or later)"
sub-CA explicitly; that gives the full term.

Apple Development certificates cannot be used here and cannot be notarised.
NOCERT
  exit 1
fi

# A Developer ID signature carries the certificate's subject, which is a real
# person's name for an individual membership: `codesign -dvv` on anything this
# script produces shows it, and so does the recipient's Gatekeeper dialogue.
# That is inherent to the mechanism, not something the script can hide.
echo "note: the signature will carry the certificate holder's name in the clear"

# --- the credentials ------------------------------------------------------
# Two ways in, because the keychain is not always reachable. An App Store
# Connect API key can be passed straight in, which is what works over ssh where
# a keychain profile cannot be read; a stored profile is tidier when running
# locally. Neither puts a secret in this file.
NOTARY_ARGS=()
if [ -n "${NOTARY_KEY:-}" ]; then
  [ -f "$NOTARY_KEY" ] || { echo "ERROR: NOTARY_KEY=$NOTARY_KEY not found"; exit 1; }
  : "${NOTARY_KEY_ID:?set NOTARY_KEY_ID alongside NOTARY_KEY}"
  : "${NOTARY_ISSUER:?set NOTARY_ISSUER alongside NOTARY_KEY}"
  NOTARY_ARGS=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
elif xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  NOTARY_ARGS=(--keychain-profile "$PROFILE")
else
  cat <<CREDS
ERROR: no notarytool credentials.

Either point at an App Store Connect API key:

  NOTARY_KEY=/path/AuthKey_XXXXXXXX.p8 NOTARY_KEY_ID=XXXXXXXX \\
  NOTARY_ISSUER=<issuer-uuid> ./notarize.sh ...

or store one in the keychain once and let the default profile find it:

  xcrun notarytool store-credentials "$PROFILE" \\
    --key /path/AuthKey_XXXXXXXX.p8 --key-id XXXXXXXX --issuer <issuer-uuid>

A team API key (Users and Access > Integrations > App Store Connect API) does
not expire and leaves no password anywhere. Keep the .p8 outside the repo.
CREDS
  exit 1
fi

# --- helpers ---------------------------------------------------------------
# --options runtime is what notarisation requires; --timestamp is what keeps
# the signature valid after the certificate expires. No --deep: it is the wrong
# tool and Apple says so — sign nested code first, then the bundle.
sign_it() {   # $1 = bundle
  local target="$1" log="$OUT/codesign.log" hits
  if codesign --force --timestamp --options runtime \
              --sign "$SIGN_ID" "$target" 2>"$log"; then
    rm -f "$log"; return 0
  fi
  cat "$log"
  hits=$(grep -c "errSecInternalComponent" "$log" || true)
  if [ "${hits:-0}" -gt 0 ]; then
    cat <<'SESSION'

That error means the signing key was not reachable, not that anything is wrong
with it: over ssh, codesign cannot get at the login keychain, whichever machine
holds the certificate. Run this from a window in the desktop session instead.
An ssh caller can still start it there without a password:

  open -a Terminal /path/to/a/wrapper.command

SESSION
  fi
  rm -f "$log"
  return 1
}

# A zip or a dmg, never a folder. notarytool mounts a disk image to look inside
# it, and a mount that gets stuck leaves the tool waiting forever with nothing
# in Apple's history to show for it — kill notarytool, then
# `hdiutil detach <dev> -force`.
notarise() {  # $1 = file to submit
  xcrun notarytool submit "$1" "${NOTARY_ARGS[@]}" --wait
}

# --- work on a copy -------------------------------------------------------
NAME="$(basename "$APP_IN")"
BASE="${NAME%.app}"
APP="$OUT/$NAME"
rm -rf "$OUT"; mkdir -p "$OUT" || exit 1
ditto "$APP_IN" "$APP" || { echo "ERROR: copy failed"; exit 1; }

# presets.json is this machine's own station list. Bundling it is right for a
# second Mac of the same owner and wrong for a stranger, who should start with
# an empty list rather than someone else's listening.
if [ -f "$APP/Contents/Resources/presets.json" ]; then
  rm -f "$APP/Contents/Resources/presets.json"
  echo "removed the bundled preset list (it is this machine's, not a default)"
fi

# --- the uninstaller -------------------------------------------------------
# Only for a disk image. Dragging an app to the Bin leaves its preferences,
# caches, saved window state and settings behind, and nobody should have to be
# told four paths to be rid of it.
UNINST=""
if [ "$WANT_DMG" = 1 ]; then
  SRC_SCPT="$HERE/dist/uninstall.applescript"
  [ -f "$SRC_SCPT" ] || { echo "ERROR: $SRC_SCPT missing"; exit 1; }
  UNINST="$OUT/Uninstall $BASE.app"
  echo "==> building the uninstaller"
  # An AppleScript applet, not a .command: osacompile produces a real bundle
  # with a Mach-O stub, so it can be signed and notarised with everything else.
  osacompile -o "$UNINST" "$SRC_SCPT" >/dev/null 2>&1 \
    || { echo "ERROR: osacompile failed"; exit 1; }
  PL="$UNINST/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.hogehoge.deckrx.uninstall" "$PL" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.hogehoge.deckrx.uninstall" "$PL" >/dev/null
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Uninstall $BASE" "$PL" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Uninstall $BASE" "$PL" >/dev/null
fi

# --- sign ------------------------------------------------------------------
echo "==> signing with Developer ID"
sign_it "$APP" || { echo "ERROR: codesign failed"; exit 1; }
if [ -n "$UNINST" ]; then
  sign_it "$UNINST" || { echo "ERROR: codesign (uninstaller) failed"; exit 1; }
fi
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2

# --- notarise the bundles --------------------------------------------------
# One submission covering everything that can be dragged out of the image. The
# ticket is per binary, so each is stapled separately afterwards and then works
# on a machine that never sees the image again.
ZIP="$OUT/$BASE.zip"
STAGE="$OUT/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$NAME"
[ -n "$UNINST" ] && ditto "$UNINST" "$STAGE/$(basename "$UNINST")"
ditto -c -k --keepParent "$STAGE" "$ZIP" || exit 1

echo "==> submitting to Apple (this takes a few minutes)"
notarise "$ZIP" || { echo "ERROR: notarisation failed - notarytool log <id> says why"; exit 1; }

echo "==> stapling"
xcrun stapler staple "$APP" || { echo "ERROR: stapling failed"; exit 1; }
if [ -n "$UNINST" ]; then
  xcrun stapler staple "$UNINST" || { echo "ERROR: stapling the uninstaller failed"; exit 1; }
fi
rm -rf "$STAGE"

if [ "$WANT_DMG" = 0 ]; then
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP" || exit 1
  echo "==> Gatekeeper"
  spctl -a -vv "$APP" 2>&1 | head -4
  echo
  echo "ready: $ZIP"
  echo "A recipient can open this without xattr -dr com.apple.quarantine."
  exit 0
fi

# --- the disk image --------------------------------------------------------
rm -f "$ZIP"
DMGDIR="$OUT/dmg"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
             "$APP/Contents/Info.plist" 2>/dev/null || echo "")
# Read from the bundle rather than passed in: a file called 1.0 holding 0.9 is
# worse than one with no version at all.
DMG="$OUT/$BASE${VERSION:+ $VERSION}.dmg"
rm -rf "$DMGDIR" "$DMG"; mkdir -p "$DMGDIR" || exit 1
ditto "$APP" "$DMGDIR/$NAME"
ditto "$UNINST" "$DMGDIR/$(basename "$UNINST")"
ln -s /Applications "$DMGDIR/Applications"

# GPLv3 asks that whoever receives a binary is told where its source is. A file
# in the image is the cheapest way to mean it.
cat > "$DMGDIR/SOURCE.txt" <<'SRC'
Deck RX - GPL-3.0-or-later.

The complete source for this build, and the licence, are at

    https://github.com/soresore19xx/deck-rx

To install: drag the app onto the Applications shortcut.
To remove it later, along with its settings: run the uninstaller.
SRC

echo "==> building the disk image"
hdiutil create -volname "$BASE" -srcfolder "$DMGDIR" -ov -format UDZO "$DMG" >/dev/null \
  || { echo "ERROR: hdiutil failed"; exit 1; }

echo "==> signing the disk image"
codesign --force --timestamp --sign "$SIGN_ID" "$DMG" \
  || { echo "ERROR: signing the dmg failed"; exit 1; }

echo "==> submitting the disk image"
notarise "$DMG" || { echo "ERROR: notarising the dmg failed"; exit 1; }
xcrun stapler staple "$DMG" || { echo "ERROR: stapling the dmg failed"; exit 1; }

echo "==> Gatekeeper"
spctl -a -vv -t open --context context:primary-signature "$DMG" 2>&1 | head -3
spctl -a -vv "$APP" 2>&1 | head -3
echo
echo "ready: $DMG"
echo "The image, the app and the uninstaller are each notarised and stapled."
