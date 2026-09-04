#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-04-212000
# Builds fdk-aac as a static library for every slice deck-rx ships, so the DRM
# decoder can be linked into the app instead of pulling a MacPorts dylib.
# A packaged build is one architecture and usually a dylib, which would cost
# the Mac app its x86_64 slice and is not loadable on iOS at all.
#   out/macos/libfdk-aac.a       arm64 + x86_64, macOS 12.0
#   out/ios/libfdk-aac.a         arm64, iOS 15.0 (device)
#   out/ios-sim/libfdk-aac.a     arm64 + x86_64, iOS 15.0 simulator
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${FDK_SRC:-$HERE/fdk-aac-2.0.3}"
OUT="${FDK_OUT:-$HERE/out}"
[ -d "$SRC" ] || { echo "ERROR: $SRC missing (fetch.sh downloads it)"; exit 1; }

# $1 label, $2 arch list, $3 -isysroot SDK, $4 version flag
build_one() {
  local label="$1" arches="$2" sdk="$3" vflag="$4"
  local slices=""
  for arch in $arches; do
    local b="$OUT/../.build-$label-$arch"
    rm -rf "$b"; mkdir -p "$b" || return 1
    echo "==> fdk-aac: $label/$arch"
    ( cd "$b" && "$SRC/configure" \
        --host="$arch-apple-darwin" \
        --disable-shared --enable-static \
        CC="clang -arch $arch -isysroot $sdk $vflag" \
        CXX="clang++ -arch $arch -isysroot $sdk $vflag" \
        CFLAGS="-O2" CXXFLAGS="-O2" \
        >/dev/null 2>&1 && make -j8 >/dev/null 2>&1 ) \
      || { echo "WARN: $label/$arch failed"; continue; }
    slices="$slices $b/.libs/libfdk-aac.a"
  done
  [ -n "$slices" ] || { echo "ERROR: no slice built for $label"; return 1; }
  mkdir -p "$OUT/$label"
  lipo -create $slices -output "$OUT/$label/libfdk-aac.a" || return 1
  echo "    $(lipo -archs "$OUT/$label/libfdk-aac.a") -> $OUT/$label/libfdk-aac.a"
}

MACSDK=$(xcrun --sdk macosx --show-sdk-path)
IOSSDK=$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)
SIMSDK=$(xcrun --sdk iphonesimulator --show-sdk-path 2>/dev/null)

build_one macos   "arm64 x86_64" "$MACSDK" "-mmacosx-version-min=12.0"
[ -n "$IOSSDK" ] && build_one ios     "arm64"        "$IOSSDK" "-miphoneos-version-min=15.0"
[ -n "$SIMSDK" ] && build_one ios-sim "arm64 x86_64" "$SIMSDK" "-mios-simulator-version-min=15.0"

mkdir -p "$OUT/include/fdk-aac"
cp -R "$SRC/libAACdec/include/"* "$SRC/libSYS/include/"* "$OUT/include/fdk-aac/" 2>/dev/null
# fdk-aac's public header is aacdecoder_lib.h plus the SYS headers it includes.
echo "headers -> $OUT/include/fdk-aac"
