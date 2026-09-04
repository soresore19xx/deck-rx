#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-04-210000
# Builds the headless DRM core plus its CLI harness. No Qt, no GUI toolkit: if
# this compiles, the decoder is ready to be called from Swift. The harness is
# also the regression test — run it on a recording whose decode is known.
#
# fetch.sh copies this next to the patched core and calls it from there.
# Usage: EIGEN_DIR=... FDK_DIR=... ./build-cli.sh
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="${UP_DIR:-$HERE/../drm-receiver}"
EIGEN="${EIGEN_DIR:?set EIGEN_DIR to the Eigen headers}"
FDK="${FDK_DIR:?set FDK_DIR to the fdk-aac output}"
MP=/opt/local

INC="-I$HERE -I$HERE/data -I$HERE/equalizer -I$HERE/fac -I$HERE/msc -I$HERE/ofdm"
INC="$INC -I$HERE/parameters -I$HERE/sdc -I$HERE/support"
INC="$INC -I$UP/kiss"
INC="$INC -I$EIGEN -I$FDK/include -I$MP/include"

# Excluded, in two groups. up-converter, estimator-1, lowpassfir, drm-bandfilter
# and lowpassfilter sit in the tree but upstream never builds them either (they
# are absent from drm-receiver.pro) and they no longer compile — up-converter.h
# wants a LowPassFIR type nothing declares any more. iqdisplay and eqdisplay are
# Qwt widgets, which is the whole point of this build. rate-converter went when
# libsamplerate did. drm_bridge is for embedders; the harness calls C++ directly.
SRC=$(find "$HERE" -name "*.cpp" -not -path "$HERE/build/*" -not -path "$HERE/out/*" \
        -not -name "up-converter.cpp" -not -name "estimator-1.cpp" \
        -not -name "lowpassfir.cpp" -not -name "drm-bandfilter.cpp" \
        -not -name "lowpassfilter.cpp" -not -name "rate-converter.cpp" \
        -not -name "iqdisplay.cpp" -not -name "eqdisplay.cpp" | sort)

mkdir -p "$HERE/build"
# fdk-aac is the only library the core itself needs. sndfile and samplerate are
# for drm-cli reading a file; an embedder links neither of them.
# Remove the old binary first: a failed link used to leave the previous one in
# place and the OK line below then reported success over a stale build.
rm -f "$HERE/build/drm-cli"
clang++ -std=c++17 -O2 -w -D__WITH_FDK_AAC__ $INC $SRC \
  -L"$FDK/macos" -lfdk-aac -L$MP/lib -lsndfile -lsamplerate \
  -o "$HERE/build/drm-cli" 2>&1 | head -40
[ -x "$HERE/build/drm-cli" ] && echo "OK: $HERE/build/drm-cli" || echo "BUILD FAILED"
