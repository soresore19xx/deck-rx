#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-04-223000
# Builds the DRM decoder deck-rx links against, from sources this repository
# does not carry: it fetches them, patches them, and compiles static libraries.
#
# Nothing here is checked in except our own patch and our own files. The
# decoder is JvanKatwijk/drm-receiver (GPL-2.0-or-later) and the audio comes
# from Fraunhofer's fdk-aac, whose licence grants no patent rights and so does
# not combine with the GPL in a *distributed binary*. Since the only thing that
# ever leaves this repository is source, that question never arises — but a
# binary built here must not be handed on. See README.md.
#
# Usage: ./fetch.sh           fetch, patch and build everything
#        ./fetch.sh clean     throw the build directory away
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$HERE/build"

# Pinned, not "latest": the patch below is written against this tree, and a
# decoder that silently moved underneath it would fail in the DSP rather than
# in the build.
UPSTREAM_REPO=https://github.com/JvanKatwijk/drm-receiver.git
UPSTREAM_COMMIT=ca8e7e06bb88a200365f908b680735587165d669   # 2025-10-17
EIGEN_URL=https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz
FDK_URL=https://github.com/mstorsjo/fdk-aac/archive/refs/tags/v2.0.3.tar.gz

if [ "${1:-}" = "clean" ]; then rm -rf "$B"; echo "removed $B"; exit 0; fi
mkdir -p "$B" || exit 1

# --- 1. the decoder ------------------------------------------------------
SRC="$B/drm-receiver"
if [ ! -d "$SRC/.git" ]; then
  echo "==> cloning drm-receiver"
  git clone --quiet "$UPSTREAM_REPO" "$SRC" || { echo "ERROR: clone failed"; exit 1; }
fi
git -C "$SRC" fetch --quiet origin 2>/dev/null
git -C "$SRC" checkout --quiet "$UPSTREAM_COMMIT" \
  || { echo "ERROR: commit $UPSTREAM_COMMIT not in $UPSTREAM_REPO"; exit 1; }
echo "    at $(git -C "$SRC" rev-parse --short HEAD)"

# --- 2. the core, patched ------------------------------------------------
CORE="$B/drm-core"
rm -rf "$CORE"; mkdir -p "$CORE" || exit 1
# the-dll is the Windows SDRuno plugin; Release/ is its build litter.
( cd "$SRC/the-decoder" && tar cf - --exclude the-dll --exclude Release . ) \
  | ( cd "$CORE" && tar xf - ) || { echo "ERROR: copy failed"; exit 1; }
# Four headers the decoder includes but keeps elsewhere in the tree.
cp -p "$SRC/various/ringbuffer.h" "$SRC/radio-constants.h" \
      "$SRC/filters/fir-filters.h" "$SRC/filters/fir-filters.cpp" "$CORE/support/" \
  || { echo "ERROR: support headers missing"; exit 1; }

echo "==> applying qt-strip.patch"
( cd "$CORE" && patch -p1 --quiet < "$HERE/qt-strip.patch" ) \
  || { echo "ERROR: patch did not apply - upstream moved?"; exit 1; }

cp -p "$HERE/src/"* "$CORE/" || exit 1
cp -p "$HERE/make-lib.sh" "$HERE/build-cli.sh" "$CORE/" || exit 1
chmod +x "$CORE/make-lib.sh" "$CORE/build-cli.sh"

# --- 3. Eigen (headers only) ---------------------------------------------
if [ ! -d "$B/eigen-3.4.0/Eigen" ]; then
  echo "==> fetching Eigen 3.4.0"
  curl -sSL --max-time 300 "$EIGEN_URL" -o "$B/eigen.tar.gz" \
    || { echo "ERROR: Eigen download failed"; exit 1; }
  tar xzf "$B/eigen.tar.gz" -C "$B" && rm -f "$B/eigen.tar.gz"
fi
[ -d "$B/eigen-3.4.0/Eigen" ] || { echo "ERROR: Eigen not unpacked"; exit 1; }

# --- 4. fdk-aac, static, every slice -------------------------------------
if [ ! -d "$B/fdk-aac-2.0.3" ]; then
  echo "==> fetching fdk-aac 2.0.3"
  curl -sSL --max-time 600 "$FDK_URL" -o "$B/fdk-aac.tar.gz" \
    || { echo "ERROR: fdk-aac download failed"; exit 1; }
  tar xzf "$B/fdk-aac.tar.gz" -C "$B" && rm -f "$B/fdk-aac.tar.gz"
  [ -d "$B/fdk-aac-2.0.3" ] || mv "$B"/fdk-aac-* "$B/fdk-aac-2.0.3"
fi
# The GitHub tarball has no configure script; autoreconf makes one.
if [ ! -x "$B/fdk-aac-2.0.3/configure" ]; then
  echo "==> autoreconf fdk-aac"
  ( cd "$B/fdk-aac-2.0.3" && ./autogen.sh >/dev/null 2>&1 ) \
    || { echo "ERROR: autogen failed (needs autoconf/automake/libtool)"; exit 1; }
fi
FDK_SRC="$B/fdk-aac-2.0.3" FDK_OUT="$B/fdk/out" "$HERE/build-fdk-aac.sh" || exit 1

# --- 5. the libraries deck-rx links --------------------------------------
EIGEN_DIR="$B/eigen-3.4.0" FDK_DIR="$B/fdk/out" "$CORE/make-lib.sh" || exit 1

cat <<DONE

Built. Point the app builds at these (they are the defaults):
  DRM_CORE_DIR=$CORE
  DRM_FDK_DIR=$B/fdk/out
Then: ../build-app.sh solo   and   ../build-ios.sh device
DONE
