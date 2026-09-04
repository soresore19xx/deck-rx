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
SIGN_LOG="$OUT/codesign.log"
if ! codesign --force --timestamp --options runtime \
              --sign "$SIGN_ID" "$APP" 2>"$SIGN_LOG"; then
  cat "$SIGN_LOG"
  if grep -q "errSecInternalComponent" "$SIGN_LOG"; then
    cat <<'SESSION'

That error means the signing key was not reachable, not that anything is wrong
with it: over ssh, codesign cannot get at the login keychain, whichever machine
holds the certificate. Run this from a window in the desktop session instead.
An ssh caller can still start it there without a password:

  open -a Terminal /path/to/a/wrapper.command

SESSION
  fi
  echo "ERROR: codesign failed"; exit 1
fi
rm -f "$SIGN_LOG"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2

# --- notarise --------------------------------------------------------------
# A zip, never a .dmg: notarytool mounts a disk image to look inside it, and a
# mount that gets stuck leaves the tool waiting forever with nothing in Apple s
# history to show for it.
ZIP="$OUT/${NAME%.app}.zip"
ditto -c -k --keepParent "$APP" "$ZIP" || exit 1
echo "==> submitting to Apple (this takes a few minutes)"
xcrun notarytool submit "$ZIP" "${NOTARY_ARGS[@]}" --wait \
  || { echo "ERROR: notarisation failed - notarytool log <id> says why"; exit 1; }

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
