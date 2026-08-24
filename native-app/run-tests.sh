#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-08-23-183000
# Builds and runs the standalone receiver's tests. Same bare swiftc the app is
# built with, so there is only ever one toolchain to keep working.
# ====================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/.tests-bin"

# The receiver sources, plus FreqView for its formatting. main.swift and the
# rest of the views stay out — they would drag in a second `main`. FreqView
# holds no top-level code, and how it groups a frequency is exactly the kind of
# rule that is cheap to get wrong and silent when it is.
SRC="Sources/LocalRadio.swift Sources/AppServer.swift Sources/SpyClient.swift \
     Sources/FFT.swift Sources/AMDemod.swift Sources/Demods.swift \
     Sources/AudioSink.swift Sources/AudioLeveling.swift Sources/IqNr.swift \
     Sources/StationLabel.swift Sources/RadioConfig.swift Sources/PresetStore.swift \
     Sources/Receiver.swift Sources/SpectrumFeed.swift Sources/Platform.swift \
     Sources/FreqView.swift"

echo "==> building tests ..."
if ! ( cd "$HERE" && swiftc $SRC Tests/main.swift -o "$OUT" \
        -framework AppKit -framework Network -framework AVFoundation -framework Accelerate ); then
  echo "ERROR: test build failed"; exit 1
fi

echo "==> running ..."
"$OUT"
rc=$?
rm -f "$OUT"
exit $rc
