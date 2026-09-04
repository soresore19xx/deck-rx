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
# Usage: ./notarize.sh ["/Applications/Deck RX Solo.app"] [keychain-profile]
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_IN="${1:-/Applications/Deck RX Solo.app}"
PROFILE="${2:-deck-rx-notary}"
OUT="$HERE/build/release"

[ -d "$APP_IN" ] || { echo "ERROR: no bundle at $APP_IN"; exit 1; }

# --- licence gate ---------------------------------------------------------
# A DRM build carries fdk-aac, whose licence grants no patent rights and so
# does not combine with the GPL in a binary that is handed on. Source is
# unaffected; a binary is not. This is the one place that rule can be enforced
# instead of remembered, so it is enforced here.
EXE_IN="$APP_IN/Contents/MacOS/deck-rx-receiver"
# grep -c and a count, not grep -q: under `set -o pipefail` the -q form closes
# the pipe on its first match, nm dies of SIGPIPE, and the pipeline reports
# failure — so the test read "no DRM here" on exactly the bundles it is meant
# to catch. A licence check that fails open is worse than none.
DRM_SYMS=0
[ -f "$EXE_IN" ] && DRM_SYMS=$(nm -a "$EXE_IN" 2>/dev/null | grep -c "drm_create" || true)
if [ "${DRM_SYMS:-0}" -gt 0 ]; then
  cat <<'DRM'
ERROR: this bundle has the DRM decoder in it, and must not be distributed.

fdk-aac's licence does not combine with the GPL in a binary that is passed on.
Build one without it and notarise that instead:

  ./build-app.sh solo   with drm/build absent, or
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
ERROR: no "Developer ID Application" certificate in the keychain.

Only the team's Account Holder can make one, and only from a paid membership:
  Xcode > Settings > Accounts > (your Apple ID) > Manage Certificates...
  > + > Developer ID Application
It lands in the login keychain by itself. (Or developer.apple.com >
Certificates > + > Developer ID Application, with a CSR from Keychain Access.)

Apple Development certificates cannot be used here and cannot be notarised.
NOCERT
  exit 1
fi

# --- the credentials ------------------------------------------------------
if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  cat <<CREDS
ERROR: no notarytool credentials stored under "$PROFILE".

Store them once; they go into the keychain, not into this script:

  xcrun notarytool store-credentials "$PROFILE" \\
    --key /path/to/AuthKey_XXXXXXXX.p8 --key-id XXXXXXXX --issuer <issuer-uuid>

The App Store Connect API key (Users and Access > Integrations > App Store
Connect API) is the better half of the choice: an app-specific password would
work too, but this leaves no password anywhere. Keep the .p8 outside the repo.
CREDS
  exit 1
fi

# --- work on a copy -------------------------------------------------------
NAME="$(basename "$APP_IN")"
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

# --- sign for distribution -------------------------------------------------
# --options runtime is what notarisation requires; --timestamp is what keeps
# the signature valid after the certificate expires. No --deep: it is the wrong
# tool and Apple says so — sign nested code first, then the bundle. There is
# none here, so the bundle is the whole job.
echo "==> signing with Developer ID"
codesign --force --timestamp --options runtime \
         --sign "$SIGN_ID" "$APP" \
  || { echo "ERROR: codesign failed"; exit 1; }
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2

# --- notarise --------------------------------------------------------------
ZIP="$OUT/${NAME%.app}.zip"
ditto -c -k --keepParent "$APP" "$ZIP" || exit 1
echo "==> submitting to Apple (this takes a few minutes)"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait \
  || { echo "ERROR: notarisation failed - 'xcrun notarytool log <id> --keychain-profile $PROFILE' says why"; exit 1; }

echo "==> stapling"
xcrun stapler staple "$APP" || { echo "ERROR: stapling failed"; exit 1; }

# The ticket has to be inside the zip that is actually handed over, so it is
# rebuilt after stapling rather than before.
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP" || exit 1

# --- prove it --------------------------------------------------------------
echo "==> Gatekeeper"
spctl -a -vv "$APP" 2>&1 | head -4
echo
echo "ready: $ZIP"
echo "A recipient can open this without xattr -dr com.apple.quarantine."
