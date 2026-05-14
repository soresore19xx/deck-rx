#!/bin/bash
# Rebuild naudiodon + segfault-handler against Stream Deck's bundled Node
# (currently 20.20.0) and swap in an arm64-capable libportaudio.dylib from
# MacPorts. Run by `npm run rebuild-native` (and by `postinstall` if
# DECK_RX_AUTOREBUILD_NATIVE=1 is set, so the default `npm install` from a
# fresh clone doesn't slow down for users who don't want naudiodon).
#
# Manual one-shot:
#   $ npm run rebuild-native
#
# Prereqs:
#   - Stream Deck app installed at /Applications/Elgato Stream Deck.app
#     (its bundled Node lives under ~/Library/Application Support/...)
#   - MacPorts portaudio installed (arm64): `sudo port install portaudio`
#   - Xcode CLT for node-gyp (`xcode-select --install`)

set -e

SD_NODE_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"
PA_DYLIB="/opt/local/lib/libportaudio.2.dylib"

if [ ! -d "$SD_NODE_DIR" ]; then
  echo "[rebuild-native] $SD_NODE_DIR not found — is Stream Deck installed?" >&2
  exit 1
fi
if [ ! -f "$PA_DYLIB" ]; then
  echo "[rebuild-native] $PA_DYLIB not found — run: sudo port install portaudio" >&2
  exit 1
fi

# Pick the highest Stream Deck Node version directory present (Stream Deck
# usually only bundles one). e.g. 20.20.0
SD_NODE_VER=$(ls -1 "$SD_NODE_DIR" | sort -V | tail -1)
echo "[rebuild-native] target Stream Deck Node: $SD_NODE_VER"

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# 1. Swap the bundled (i386+x86_64) libportaudio for the MacPorts arm64
#    build, keeping @loader_path/libportaudio.dylib as the install_name so
#    naudiodon.node finds it without polluting LC_RPATH.
echo "[rebuild-native] swapping libportaudio.dylib (arm64 from MacPorts)..."
cp "$PA_DYLIB" "$ROOT/node_modules/naudiodon/portaudio/bin/libportaudio.dylib"
install_name_tool -id @loader_path/libportaudio.dylib \
  "$ROOT/node_modules/naudiodon/portaudio/bin/libportaudio.dylib"

# 2. Rebuild naudiodon native binding against SD's Node ABI.
echo "[rebuild-native] rebuilding naudiodon for Node $SD_NODE_VER..."
cd "$ROOT/node_modules/naudiodon"
rm -rf build
npx --yes node-gyp@10 rebuild \
  --target="$SD_NODE_VER" \
  --arch=arm64 \
  --target_platform=darwin

# 3. Same for segfault-handler (naudiodon's debug dependency).
if [ -d "$ROOT/node_modules/segfault-handler" ]; then
  echo "[rebuild-native] rebuilding segfault-handler for Node $SD_NODE_VER..."
  cd "$ROOT/node_modules/segfault-handler"
  rm -rf build
  npx --yes node-gyp@10 rebuild \
    --target="$SD_NODE_VER" \
    --arch=arm64 \
    --target_platform=darwin
fi

echo "[rebuild-native] done."
