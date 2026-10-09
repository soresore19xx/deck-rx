#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-10-10-013000
# Installs the deck-rx sync hub (src/syncHub.ts) as a LaunchAgent on the machine
# it runs on (mini4). Run there, from the repo, after `npm run build`.
# ====================
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HUB="$REPO/com.hogehoge.deck-rx.sdPlugin/bin/sync-hub.js"
NODE="${NODE:-$(command -v node)}"
LABEL=com.hogehoge.deckrx-sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/deck-rx-sync.log"

[ -f "$HUB" ] || { echo "ERROR: $HUB missing - run npm run build first"; exit 1; }
[ -x "$NODE" ] || { echo "ERROR: node not found"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array><string>$NODE</string><string>$HUB</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG</string>
	<key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -s -m 3 http://127.0.0.1:8772/health && echo
