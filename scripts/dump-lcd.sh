#!/usr/bin/env bash
# Capture all 4 deck-rx LCD panels as PNGs in ~/ICON/.
#
# Flow:
#   1. wipe stale /tmp/deck-rx-lcd-*.svg
#   2. enable the dump gate (touch /tmp/deck-rx-lcd-dump)
#   3. bounce the plugin (Stream Deck respawns it within ~5 s)
#   4. wait while the user switches through each LCD panel on the device
#      — the visible action's WillAppear is what triggers the render that
#        writes /tmp/deck-rx-lcd-<tag>.svg, so each panel must be shown once
#   5. rsvg-convert -z 2 each SVG -> ~/ICON/deck-rx-lcd-<tag>.png
#   6. disable the dump gate so the plugin stops touching /tmp on every frame
set -euo pipefail

OUT="${HOME}/ICON"
FLAG=/tmp/deck-rx-lcd-dump
TAGS=(tune volume options am-options)
TIMEOUT=120   # seconds to wait for the user to cycle through panels

mkdir -p "$OUT"

echo ">> wiping stale dumps"
for t in "${TAGS[@]}"; do rm -f "/tmp/deck-rx-lcd-${t}.svg"; done

echo ">> enabling dump gate ($FLAG)"
touch "$FLAG"

echo ">> bouncing plugin"
# Use the plugin's own PID file rather than `pkill -f "<pattern>"`. With
# pkill -f, the parent shell's COMMAND row (which contains this script's
# full body, including the literal pattern) matches and gets SIGTERM'd
# itself — that crashed the Claude Code TUI three times in a row before
# we tracked it down (2026-05-05).
PID_FILE=/tmp/deck-rx.pid
if [[ -s "$PID_FILE" ]]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
else
  echo "   (no $PID_FILE — plugin not running yet; Stream Deck will spawn it)"
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
