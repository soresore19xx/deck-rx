#!/usr/bin/env bash
# Capture all 4 deck-rx LCD panels as PNGs in ~/ICON/.
#
# Flow:
#   1. wipe stale /tmp/deck-rx-lcd-*.svg
#   2. enable the dump gate (touch /tmp/deck-rx-lcd-dump)
#   3. confirm the plugin is running (do NOT bounce — see note below)
#   4. wait while the user switches through each LCD panel on the device
#      — the visible action's WillAppear / footerTimer triggers the render
#        that writes /tmp/deck-rx-lcd-<tag>.svg, so each panel must be
#        shown once
#   5. rsvg-convert -z 2 each SVG -> ~/ICON/deck-rx-lcd-<tag>.png
#   6. disable the dump gate so the plugin stops touching /tmp on every frame
set -uo pipefail
# NOTE: `set -e` is intentionally OFF — bash's `(( expr ))` returns exit 1
# whenever the arithmetic expression evaluates to 0, so e.g.
# `(( ready == ${#TAGS[@]} )) && break` would falsely trip `set -e` while
# `ready` is still less than the number of tags, killing the script before
# the wait loop could finish.

OUT="${HOME}/ICON"
FLAG=/tmp/deck-rx-lcd-dump
TAGS=(tune volume options am-options)
TIMEOUT=120   # seconds to wait for the user to cycle through panels

mkdir -p "$OUT"

echo ">> wiping stale dumps"
for t in "${TAGS[@]}"; do rm -f "/tmp/deck-rx-lcd-${t}.svg"; done

echo ">> enabling dump gate ($FLAG)"
touch "$FLAG"

echo ">> plugin status"
# We deliberately do NOT bounce the plugin here. The render path checks
# for the dump flag on every frame (see dialDisplay.ts dumpAndB64 /
# dumpTuneLcd), so a fresh `touch` is enough to start dumping in the
# already-running plugin. Bouncing would respawn the plugin and capture
# its pre-SpyServer-connect frame (signal=0, header stale) — exactly the
# regression that produced the white-bars / no-meter dump on 2026-05-05.
PID_FILE=/tmp/deck-rx.pid
if [[ -s "$PID_FILE" ]] && ps -p "$(cat "$PID_FILE")" >/dev/null 2>&1; then
  echo "   plugin running (PID $(cat "$PID_FILE"))"
else
  echo "   WARNING: plugin not running — open Stream Deck app with the"
  echo "   deck-rx panels in the active profile, otherwise capture will"
  echo "   time out."
fi

cat <<EOF

>> waiting for SVGs (timeout ${TIMEOUT}s)
   On the Stream Deck, switch through each LCD panel:
       tune  /  volume  /  options  /  am-options
   This script auto-continues once all 4 SVGs land in /tmp.

EOF

deadline=$((SECONDS + TIMEOUT))
last=-1
while (( SECONDS < deadline )); do
  ready=0
  for t in "${TAGS[@]}"; do [[ -s "/tmp/deck-rx-lcd-${t}.svg" ]] && (( ready++ )); done
  if (( ready != last )); then
    printf "   captured %d/%d\n" "$ready" "${#TAGS[@]}"
    last=$ready
  fi
  (( ready == ${#TAGS[@]} )) && break
  sleep 1
done

echo ">> disabling dump gate"
rm -f "$FLAG"

missing=()
for t in "${TAGS[@]}"; do
  src="/tmp/deck-rx-lcd-${t}.svg"
  if [[ ! -s "$src" ]]; then missing+=("$t"); continue; fi
  cp "$src" "${OUT}/deck-rx-lcd-${t}.svg"
  rsvg-convert -z 2 "$src" -o "${OUT}/deck-rx-lcd-${t}.png"
  printf "   OK  %s (.svg + .png)\n" "${OUT}/deck-rx-lcd-${t}"
done

if (( ${#missing[@]} > 0 )); then
  echo
  echo "!! missing (panel never rendered): ${missing[*]}"
  exit 1
fi

echo
echo ">> done"
