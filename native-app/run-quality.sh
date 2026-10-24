#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-10-25-031500
# Quality bench: the receiver measured the way it is used — through
# LocalRadio, packet by packet, at every IQ rate the HF+ and the V4 run, with
# a neighbour, an echo, a weak signal and a station off the centre — and every
# rule that fails listed at the end. -O, like run-bench.sh. About 20 minutes.
#   QUALITY_ONLY="WFM stereo"  one mode     QUALITY_RATE="V4 2.4M"  one rate
#   QUALITY_EQ=0               multipath equaliser off
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Never the user's own settings (see run-tests.sh).
T="$(mktemp -d)"
export DECK_RX_RECEIVER_CONFIG="$T/receiver.json"
export DECK_RX_GAIN_MEMORY_PATH="$T/gain-memory.json"
export DECK_RX_STATION_MONO_PATH="$T/station-mono.json"
export DECK_RX_SYNC_HUBS=""
export DECK_RX_SYNC_STATE="$T/sync-state.json"
OUT="$HERE/.quality-bin"
SRC="Sources/LocalRadio.swift Sources/GainSearch.swift Sources/Sync.swift Sources/AppServer.swift Sources/SpyClient.swift \
     Sources/FFT.swift Sources/AMDemod.swift Sources/BrickWall.swift Sources/Demods.swift Sources/AutoNotch.swift Sources/AudioNr.swift \
     Sources/AudioSink.swift Sources/AudioLeveling.swift Sources/IqNr.swift \
     Sources/StationLabel.swift Sources/RadioConfig.swift Sources/DeviceSettings.swift Sources/PresetStore.swift \
     Sources/Receiver.swift Sources/SpectrumFeed.swift Sources/Platform.swift \
     Sources/FreqView.swift Sources/SpectrumView.swift \
     Sources/IQSource.swift Sources/RtlTcpClient.swift Sources/WefaxDecode.swift"
if ! ( cd "$HERE" && swiftc -O $SRC Quality/main.swift -o "$OUT" \
        -framework AppKit -framework Network -framework AVFoundation -framework Accelerate ); then
  echo "ERROR: quality build failed"; exit 1
fi
"$OUT"
rc=$?
rm -f "$OUT"
exit $rc
