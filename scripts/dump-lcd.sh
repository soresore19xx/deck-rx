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
#   scripts/dump-lcd.sh           # write to ~/ICON/deck-rx-lcd-*.{svg,png}
#   scripts/dump-lcd.sh --docs    # write to docs/lcd-*.png as well
#                                 # (uses the README's lcd-<label>.png naming
#                                 # so commit drops the new screenshots
#                                 # straight into the dial-layouts gallery)
set -uo pipefail

DOCS_MODE=0
if [[ "${1:-}" == "--docs" ]]; then DOCS_MODE=1; fi

OUT="${HOME}/ICON"
FLAG=/tmp/deck-rx-lcd-dump
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
)
TAGS=("${!LABEL[@]}")
TIMEOUT=180   # seconds to wait for the user to cycle through panels

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

cat <<EOF

>> waiting for SVGs (timeout ${TIMEOUT}s)
   On the Stream Deck, switch through each LCD panel you want captured:
       ${TAGS[*]}
   Already-displayed panels are dumped immediately. Pages / profiles
   that aren't currently shown stay missing — show them, the visible
   render fires once and writes the SVG, then move to the next.
   Script keeps polling until all 9 land OR you Ctrl-C with what you have.

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
  echo "!! missing (panel never rendered): ${missing[*]}"
  echo "   To capture these, show them on the Stream Deck and re-run."
  exit 1
fi

echo
echo ">> done"
