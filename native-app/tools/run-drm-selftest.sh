#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-04-215500
# Builds and runs the Swift-side DRM check against a recording whose decode is
# known, at each of the IQ rates the SpyServer actually hands out. The awkward
# ones are the point: 12000/inRate is 1/19 at 228 kHz but 2/19 at 114 kHz, and a
# resampler that only handles the whole ratios passes two thirds of the time.
# Usage: ./run-drm-selftest.sh
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="${DRM_CORE_DIR:-$HERE/../drm/build/drm-core}"
FDK="${DRM_FDK_DIR:-$HERE/../drm/build/fdk/out}"
TMP="${TMPDIR:-/tmp}/drm-selftest"
SAMPLES="${DRM_SAMPLES:-$HERE/../drm/samples}"
WAV="$SAMPLES/DW_ModeB_10kHz.wav"

[ -f "$CORE/out/macos/libdrmcore.a" ] || { echo "no core at $CORE (run ../drm/fetch.sh)"; exit 1; }
# The reference recording is a DW broadcast off the DRM sample pages; it is
# not in the repository. Point DRM_SAMPLES at wherever it was kept.
[ -f "$WAV" ] || { echo "no reference recording at $WAV (set DRM_SAMPLES)"; exit 1; }
mkdir -p "$TMP"

echo "==> building"
swiftc -O -D DRM_ENABLED -import-objc-header "$CORE/drm_bridge.h" \
  "$HERE/../Sources/DrmDecode.swift" "$HERE/drm-selftest.swift" \
  -L"$CORE/out/macos" -ldrmcore -L"$FDK/macos" -lfdk-aac -lc++ \
  -o "$TMP/drm-selftest" || exit 1

# The sample is a real audio recording with the DRM block at 12 kHz. Fed in as
# I with Q=0 it is exactly what a receiver delivers, mirror image and all — the
# resampler's own filter is what has to reject the mirror.
fail=0
for rate in 48000 114000 228000; do
  raw="$TMP/dw${rate}.s16"
  if [ ! -f "$raw" ]; then
    if [ "$rate" = 48000 ]; then src="$WAV"
    else src="$TMP/dw${rate}.wav"; sox "$WAV" -r "$rate" "$src" rate -v || exit 1
    fi
    node -e '
const fs=require("fs");const b=fs.readFileSync(process.argv[1]);
let p=12,off=0,len=0,ch=1;
while(p+8<=b.length){const id=b.toString("ascii",p,p+4),sz=b.readUInt32LE(p+4);
 if(id==="fmt ")ch=b.readUInt16LE(p+10);
 if(id==="data"){off=p+8;len=sz;break;} p+=8+sz+(sz&1);}
const n=Math.floor(len/2/ch), o=Buffer.alloc(n*4);
for(let i=0;i<n;i++){o.writeInt16LE(b.readInt16LE(off+2*i*ch),4*i);o.writeInt16LE(0,4*i+2);}
fs.writeFileSync(process.argv[2],o);' "$src" "$raw" || exit 1
  fi
  echo "==> $rate Hz"
  "$TMP/drm-selftest" "$raw" "$rate" 12000 | tail -6
  [ "${PIPESTATUS[0]}" = 0 ] || fail=1
done
[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail
