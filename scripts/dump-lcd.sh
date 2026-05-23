#!/usr/bin/env bash
# Capture each visible deck-rx LCD panel as a PNG.
#
# Flow:
#   1. wipe stale /tmp/deck-rx-lcd-*.svg
#   2. enable the dump gate (touch /tmp/deck-rx-lcd-dump)
#   3. confirm the plugin is running (do NOT bounce — see note below)
#   4. wait while the user switches through each LCD panel on the device
#      — the visible action's willAppear / next-render triggers the dump
#        path that writes /tmp/deck-rx-lcd-<tag>.svg, so each panel must
#        be shown once
#   5. strip the offline-dim opacity wrapper (the plugin renders dimmed
#      when connected=false; for documentation we want the bright running
#      colour scheme)
#   6. rsvg-convert -z 2 each SVG -> destination
#   7. disable the dump gate so the plugin stops touching /tmp on every
#      frame
#
# Usage:
#   scripts/dump-lcd.sh           # snapshot the active Stream Deck page
#                                 # (one force-render + 2.5 s settle); write
#                                 # whatever 4 dials are on-screen to
#                                 # ~/ICON/deck-rx-lcd-*.{svg,png}. Off-page
#                                 # dials are quietly skipped — typical use.
#   scripts/dump-lcd.sh --all     # multi-page mode: wait up to 180 s for
#                                 # every dial in TAGS to appear (user
#                                 # cycles through pages); exit 1 if any
#                                 # never rendered.
#   scripts/dump-lcd.sh --docs    # also write docs/lcd-*.png (uses the
#                                 # README's lcd-<label>.png naming so a
#                                 # commit drops new screenshots into the
#                                 # dial-layouts gallery). Combinable with
#                                 # --all.
set -uo pipefail

DOCS_MODE=0
if [[ "${1:-}" == "--docs" ]]; then DOCS_MODE=1; fi

OUT="${HOME}/ICON"
FLAG=/tmp/deck-rx-lcd-dump
FORCE=/tmp/deck-rx-lcd-force   # edge-trigger: plugin re-renders every active dial once, then unlinks
# Each entry: dump-tag => docs-png-label (what render-all-dials.mjs writes
# into docs/). Tags must match the dumpAndB64 / dumpTuneLcd <tag> argument
# in src/actions/spy*.ts.
declare -A LABEL=(
  [tune]="tune"
  [volume]="volume"
  [options]="options-fm"
  [am-options]="options-am"
  [options-combo]="options-combo"
  [band-select]="band-select"
  [options-auto]="options-auto"
  [options-2col]="options-2col"
  [ssb-options]="options-ssb"
  [fft]="fft"
  [fft-lcdx2-single]="fft-lcdx2-single"
  [fft-lcdx2-left]="fft-lcdx2-left"
  [fft-lcdx2-right]="fft-lcdx2-right"
)
TAGS=("${!LABEL[@]}")
# Default behaviour: capture whatever the active Stream Deck page renders
# in 2.5 seconds of force-render firings, then exit. The earlier 180 s
# wait was for the multi-page "cover all 9 dials" workflow — most usage
# is just "snapshot what's on screen right now" so a short window is
# friendlier. --all keeps the old multi-page polling loop.
TIMEOUT=2.5
ALL_MODE=0
if [[ "${1:-}" == "--all"  || "${2:-}" == "--all"  ]]; then ALL_MODE=1; TIMEOUT=180; fi

mkdir -p "$OUT"

echo ">> wiping stale dumps"
for t in "${TAGS[@]}"; do rm -f "/tmp/deck-rx-lcd-${t}.svg"; done

echo ">> enabling dump gate ($FLAG)"
touch "$FLAG"

PID_FILE=/tmp/deck-rx.pid
if [[ -s "$PID_FILE" ]] && ps -p "$(cat "$PID_FILE")" >/dev/null 2>&1; then
  echo "   plugin running (PID $(cat "$PID_FILE"))"
else
  echo "   WARNING: plugin not running — open Stream Deck app with the"
  echo "   deck-rx panels in the active profile, otherwise capture will"
  echo "   time out."
fi

if (( ALL_MODE )); then
  cat <<EOF

>> waiting for SVGs (timeout ${TIMEOUT}s, --all mode)
   Switch pages on the Stream Deck to cover every dial in:
       targets: ${TAGS[*]}
   Each page change re-fires force-render so the 4 newly-visible dials
   write their SVGs immediately. Script keeps polling until all
   targets land OR you Ctrl-C with what you have.

EOF
else
  echo ">> snapshotting active page (force-render + 2.5 s settle)"
fi
# Edge-trigger force-render NOW so currently-visible dials write their SVGs
# without the user having to interact. Plugin's spyService watcher polls
# at 250 ms, fires every subscribeForceRender listener, then unlinks.
touch "$FORCE"

if (( ALL_MODE )); then
  deadline=$((SECONDS + TIMEOUT))
  last=-1
  last_force=$SECONDS
  while (( SECONDS < deadline )); do
    ready=0
    for t in "${TAGS[@]}"; do [[ -s "/tmp/deck-rx-lcd-${t}.svg" ]] && (( ready++ )); done
    if (( ready != last )); then
      printf "   captured %d/%d\n" "$ready" "${#TAGS[@]}"
      last=$ready
    fi
    (( ready == ${#TAGS[@]} )) && break
    if (( SECONDS - last_force >= 3 )); then
      touch "$FORCE"
      last_force=$SECONDS
    fi
    sleep 1
  done
else
  # Single-shot: give the watcher ~2.5 s to fire force-render, render
  # the active dials, and write SVGs.
  sleep 2.5
  ready=0
  for t in "${TAGS[@]}"; do [[ -s "/tmp/deck-rx-lcd-${t}.svg" ]] && (( ready++ )); done
  printf "   captured %d of %d possible tags (active page only)\n" "$ready" "${#TAGS[@]}"
fi

echo ">> disabling dump gate"
rm -f "$FLAG" "$FORCE"

# Strip the offline-dim opacity wrapper so the docs PNG shows the bright
# running colour scheme. The connected-state isn't reachable from the
# dump path (no SpyServer = always offline = dim), but the SVG is otherwise
# the actual layout. Rewriting opacity is safe + idempotent.
strip_dim() {
  local src="$1" dst="$2"
  sed 's|opacity="0\.30"|opacity="1"|g' "$src" > "$dst"
}

missing=()
for t in "${TAGS[@]}"; do
  src="/tmp/deck-rx-lcd-${t}.svg"
  if [[ ! -s "$src" ]]; then missing+=("$t"); continue; fi
  bright="/tmp/deck-rx-lcd-${t}-bright.svg"
  strip_dim "$src" "$bright"
  cp "$src" "${OUT}/deck-rx-lcd-${t}.svg"
  rsvg-convert -z 2 "$bright" -o "${OUT}/deck-rx-lcd-${t}.png"
  printf "   OK  %s (.svg + .png)\n" "${OUT}/deck-rx-lcd-${t}"
  if (( DOCS_MODE )); then
    docs_png="docs/lcd-${LABEL[$t]}.png"
    rsvg-convert -z 2 "$bright" -o "$docs_png"
    printf "   OK  %s\n" "$docs_png"
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo
  if (( ALL_MODE )); then
    echo "!! missing (panel never rendered): ${missing[*]}"
    echo "   To capture these, show them on the Stream Deck and re-run."
    exit 1
  fi
  # Default single-shot: missing tags are expected (off-page dials).
  # No error, just inform.
  echo "   skipped (not on active page): ${missing[*]}"
fi

echo
echo ">> done"
