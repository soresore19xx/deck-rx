#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-04-213000
# Builds the DRM core as a static library for every slice deck-rx ships, so the
# app links an archive instead of carrying a build system for 100 C++ files.
#   out/macos/libdrmcore.a     arm64 + x86_64, macOS 12.0
#   out/ios/libdrmcore.a       arm64, iOS 15.0
#   out/ios-sim/libdrmcore.a   arm64 + x86_64, iOS 15.0 simulator
# The only external library it needs is fdk-aac; ../vendor/build-fdk-aac.sh
# produces static slices of that to match.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="${UP_DIR:-$HERE/../drm-receiver}"
EIGEN="${EIGEN_DIR:?set EIGEN_DIR to the Eigen headers}"
FDK="${FDK_DIR:?set FDK_DIR to the fdk-aac output}"
OUT="$HERE/out"

[ -d "$EIGEN/Eigen" ] || { echo "ERROR: Eigen headers not at $EIGEN"; exit 1; }

INC="-I$HERE -I$HERE/data -I$HERE/equalizer -I$HERE/fac -I$HERE/msc -I$HERE/ofdm"
INC="$INC -I$HERE/parameters -I$HERE/sdc -I$HERE/support -I$UP/kiss"
INC="$INC -I$EIGEN -I$FDK/include"

# drm-cli.cpp is the test harness and carries main(); it never goes in the
# library. The other exclusions are files upstream does not build either.
# Anchored on $HERE, not "*/build/*": the whole core sits under drm/build/,
# so a wildcard match excluded every source in it and ar got an empty set.
SRC=$(find "$HERE" -name "*.cpp" -not -path "$HERE/build/*" -not -path "$HERE/out/*" \
        -not -name "drm-cli.cpp" \
        -not -name "up-converter.cpp" -not -name "estimator-1.cpp" \
        -not -name "lowpassfir.cpp" -not -name "drm-bandfilter.cpp" \
        -not -name "lowpassfilter.cpp" -not -name "rate-converter.cpp" \
        -not -name "iqdisplay.cpp" -not -name "eqdisplay.cpp" | sort)

# $1 label, $2 arch list, $3 sdk name, $4 version flag
build_one() {
  local label="$1" arches="$2" sdkname="$3" vflag="$4"
  local sdk; sdk=$(xcrun --sdk "$sdkname" --show-sdk-path 2>/dev/null)
  [ -n "$sdk" ] || { echo "WARN: no $sdkname SDK - skipping $label"; return 0; }
  local slices=""
  for arch in $arches; do
    local o="$HERE/.obj-$label-$arch"
    rm -rf "$o"; mkdir -p "$o"
    echo "==> drmcore: $label/$arch"
    local failed=0
    for f in $SRC; do
      local base; base=$(echo "${f#$HERE/}" | tr '/' '_')
      clang++ -std=c++17 -O2 -w -D__WITH_FDK_AAC__ -arch "$arch" \
        -isysroot "$sdk" "$vflag" $INC -c "$f" -o "$o/${base%.cpp}.o" \
        || { echo "ERROR: $f"; failed=1; break; }
    done
    [ "$failed" = 0 ] || { echo "WARN: $label/$arch failed"; continue; }
    ar rcs "$o/libdrmcore.a" "$o"/*.o || { echo "WARN: ar failed"; continue; }
    slices="$slices $o/libdrmcore.a"
  done
  [ -n "$slices" ] || { echo "ERROR: no slice for $label"; return 1; }
  mkdir -p "$OUT/$label"
  lipo -create $slices -output "$OUT/$label/libdrmcore.a" || return 1
  echo "    $(lipo -archs "$OUT/$label/libdrmcore.a") -> $OUT/$label/libdrmcore.a"
}

build_one macos   "arm64 x86_64" macosx           "-mmacosx-version-min=12.0"
build_one ios     "arm64"        iphoneos         "-miphoneos-version-min=15.0"
build_one ios-sim "arm64 x86_64" iphonesimulator  "-mios-simulator-version-min=15.0"
