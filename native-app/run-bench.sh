#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-08-070200
# Demodulator benchmarks: the same sources run-tests.sh builds, at -O, with
# Bench/main.swift on top. Answers "can this IQ rate be run with audio" as a
# number, without the GUI or a receiver.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/.bench-bin"
SRC="Sources/LocalRadio.swift Sources/AppServer.swift Sources/SpyClient.swift \
     Sources/IQSource.swift \
     Sources/FFT.swift Sources/AMDemod.swift Sources/Demods.swift \
     Sources/AudioSink.swift Sources/AudioLeveling.swift Sources/IqNr.swift \
     Sources/StationLabel.swift Sources/RadioConfig.swift Sources/PresetStore.swift \
     Sources/Receiver.swift Sources/SpectrumFeed.swift Sources/Platform.swift \
     Sources/FreqView.swift Sources/SpectrumView.swift Sources/WefaxDecode.swift"
if ! ( cd "$HERE" && swiftc -O $SRC Bench/main.swift -o "$OUT" \
        -framework AppKit -framework Network -framework AVFoundation -framework Accelerate ); then
  echo "ERROR: bench build failed"; exit 1
fi
"$OUT"
rc=$?
rm -f "$OUT"
exit $rc
