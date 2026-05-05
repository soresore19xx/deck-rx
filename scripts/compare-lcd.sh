#!/usr/bin/env bash
# Compare ~/ICON LCD dumps against a saved baseline using ImageMagick.
#
# Usage:
#   ./scripts/compare-lcd.sh save        # snapshot current ~/ICON to ~/ICON-baseline
#   ./scripts/compare-lcd.sh             # diff current vs baseline, write diff PNGs
#
# Override the baseline directory with ICON_BASELINE=<path>.
set -uo pipefail

BASE="${ICON_BASELINE:-${HOME}/ICON-baseline}"
CUR="${HOME}/ICON"
DIFF="${HOME}/ICON-diff"
TAGS=(tune volume options am-options)

if [[ "${1:-}" == "save" ]]; then
  mkdir -p "$BASE"
  for t in "${TAGS[@]}"; do
    src="${CUR}/deck-rx-lcd-${t}.png"
    if [[ -e "$src" ]]; then
      cp "$src" "${BASE}/deck-rx-lcd-${t}.png"
      echo "  saved $t"
    else
      echo "  skip $t (no current)"
    fi
  done
  echo ">> baseline: $BASE"
  exit 0
fi

mkdir -p "$DIFF"
echo ">> diff (baseline=$BASE current=$CUR)"
any_diff=0
have_baseline=0
for t in "${TAGS[@]}"; do
  b="${BASE}/deck-rx-lcd-${t}.png"
  c="${CUR}/deck-rx-lcd-${t}.png"
  if [[ ! -e "$b" ]]; then echo "  $t: no baseline";       continue; fi
  if [[ ! -e "$c" ]]; then echo "  $t: no current";        continue; fi
  have_baseline=1
  d="${DIFF}/deck-rx-lcd-${t}-diff.png"
  ae=$(compare -metric AE "$b" "$c" "$d" 2>&1)
  if [[ "$ae" =~ ^[0-9]+$ ]] && (( ae > 0 )); then any_diff=1; fi
  echo "  $t: ${ae} px diff -> $d"
done

if (( have_baseline == 0 )); then
  echo ">> no baseline yet — run: $0 save"
  exit 1
fi
if (( any_diff > 0 )); then
  echo ">> there are visual differences; inspect ${DIFF}/"
  exit 2
fi
echo ">> identical to baseline"
