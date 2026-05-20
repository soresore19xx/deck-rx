#!/bin/bash
# Rebuild native modules against Stream Deck's bundled Node ABI:
#   - naudiodon         (PortAudio binding, with arm64 libportaudio swap)
#   - segfault-handler  (naudiodon's debug dep)
#   - deck-rx-asrc      (libsamplerate binding, in-tree at native/samplerate)
#
# Run by `npm run rebuild-native`. Stream Deck currently bundles Node
# 20.20.0; this script auto-detects whichever version is installed.
#
# Manual one-shot:
#   $ npm run rebuild-native
#
# Prereqs:
#   - Stream Deck app installed at /Applications/Elgato Stream Deck.app
#   - MacPorts portaudio       (arm64): `sudo port install portaudio`
#   - MacPorts libsamplerate   (arm64): `sudo port install libsamplerate`
#   - Xcode CLT for node-gyp           : `xcode-select --install`

set -e

SD_NODE_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"
PA_DYLIB="/opt/local/lib/libportaudio.2.dylib"
SRC_DYLIB="/opt/local/lib/libsamplerate.0.dylib"

if [ ! -d "$SD_NODE_DIR" ]; then
  echo "[rebuild-native] $SD_NODE_DIR not found — is Stream Deck installed?" >&2
  exit 1
fi
if [ ! -f "$PA_DYLIB" ]; then
  echo "[rebuild-native] $PA_DYLIB not found — run: sudo port install portaudio" >&2
  exit 1
fi
if [ ! -f "$SRC_DYLIB" ]; then
  echo "[rebuild-native] $SRC_DYLIB not found — run: sudo port install libsamplerate" >&2
  exit 1
fi

# Pick the highest Stream Deck Node version directory present.
# NOTE: filter to directories — `$SD_NODE_DIR` also contains a `manifest.json`
# sibling file that a naive `sort -V | tail -1` would pick up instead of
# "20.20.0", silently passing `--target=manifest.json` to node-gyp.
SD_NODE_VER=$(find "$SD_NODE_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort -V | tail -1)
if [ -z "$SD_NODE_VER" ]; then
  echo "[rebuild-native] no Node version directory under $SD_NODE_DIR" >&2
  exit 1
fi
echo "[rebuild-native] target Stream Deck Node: $SD_NODE_VER"

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# ─── 1. naudiodon ──────────────────────────────────────────────────────────
# Swap the bundled (i386+x86_64) libportaudio for the MacPorts arm64 build,
# keeping @loader_path/libportaudio.dylib as the install_name so naudiodon.node
# finds it without polluting LC_RPATH.
echo "[rebuild-native] swapping libportaudio.dylib (arm64 from MacPorts)..."
cp "$PA_DYLIB" "$ROOT/node_modules/naudiodon/portaudio/bin/libportaudio.dylib"
install_name_tool -id @loader_path/libportaudio.dylib \
  "$ROOT/node_modules/naudiodon/portaudio/bin/libportaudio.dylib"

echo "[rebuild-native] rebuilding naudiodon for Node $SD_NODE_VER..."
( cd "$ROOT/node_modules/naudiodon" \
  && rm -rf build \
  && npx --yes node-gyp@10 rebuild \
       --target="$SD_NODE_VER" \
       --arch=arm64 \
       --target_platform=darwin )

# ─── 2. segfault-handler ───────────────────────────────────────────────────
if [ -d "$ROOT/node_modules/segfault-handler" ]; then
  echo "[rebuild-native] rebuilding segfault-handler for Node $SD_NODE_VER..."
  ( cd "$ROOT/node_modules/segfault-handler" \
    && rm -rf build \
    && npx --yes node-gyp@10 rebuild \
         --target="$SD_NODE_VER" \
         --arch=arm64 \
         --target_platform=darwin )
fi

# ─── 3. deck-rx-asrc (libsamplerate) ───────────────────────────────────────
echo "[rebuild-native] rebuilding deck-rx-asrc for Node $SD_NODE_VER..."
( cd "$ROOT/native/samplerate" \
  && rm -rf build \
  && npx --yes node-gyp@10 rebuild \
       --target="$SD_NODE_VER" \
       --arch=arm64 \
       --target_platform=darwin )

# Bundle libsamplerate next to asrc.node so the plugin works without
# requiring MacPorts to be in the runtime's library search path. Pattern
# mirrors naudiodon's libportaudio.dylib treatment.
ASRC_OUT="$ROOT/native/samplerate/build/Release"
echo "[rebuild-native] bundling libsamplerate.0.dylib next to asrc.node..."
cp "$SRC_DYLIB" "$ASRC_OUT/libsamplerate.0.dylib"
chmod u+w "$ASRC_OUT/libsamplerate.0.dylib"
install_name_tool -id @loader_path/libsamplerate.0.dylib \
  "$ASRC_OUT/libsamplerate.0.dylib"
install_name_tool -change "$SRC_DYLIB" @loader_path/libsamplerate.0.dylib \
  "$ASRC_OUT/asrc.node" 2>/dev/null || true
# Re-sign so Gatekeeper accepts the modified files. Ad-hoc signing is
# sufficient — neither file is shipped to end users via Apple notarisation.
codesign -s - -f "$ASRC_OUT/libsamplerate.0.dylib" "$ASRC_OUT/asrc.node" 2>/dev/null || true

echo "[rebuild-native] done."
