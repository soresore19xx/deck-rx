#!/bin/bash
# === Claude origin ===
# Created/placed by Anthropic Claude Code at: 2026-09-13-162500
# Installs a launchd-kept TCP relay so a client on one wired segment can reach
# a SpyServer that only lives on another (the iPad case: docs/ipad.md).
# ====================
#
# Usage:
#   spyserver-relay.sh install <bind-ip> <upstream-host:port> [listen-port]
#   spyserver-relay.sh remove  <bind-ip>
#   spyserver-relay.sh status
#
# One relay per bind address. The listener is bound to that address only and
# accepts connections from its own /24 only, so a relay on a wired interface
# is not reachable from Wi-Fi even though the port is the same. The default
# listen port is 5555, SpyServer's own default, which is also why this Mac's
# nginx on 8888 is not in the way.
#
# The relay is a plain byte pipe (socat). SpyServer sees the Mac as an
# ordinary client; nothing in the protocol is touched.

set -eu

LABEL_PREFIX=com.hogehoge.spyserver-relay
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

die() { echo "spyserver-relay: $*" >&2; exit 1; }

label_for() { echo "$LABEL_PREFIX.$1"; }
plist_for() { echo "$AGENTS/$(label_for "$1").plist"; }

cmd_install() {
    local bind="${1:-}" upstream="${2:-}" port="${3:-5555}"
    [ -n "$bind" ] && [ -n "$upstream" ] || die "install needs <bind-ip> <upstream-host:port>"
    case "$upstream" in *:*) ;; *) die "upstream must be host:port";; esac
    local socat; socat="$(command -v socat || true)"
    [ -n "$socat" ] || die "socat not found (MacPorts: port install socat)"
    ifconfig | grep -q "inet $bind " || die "$bind is not an address of this Mac"

    local label plist range
    label="$(label_for "$bind")"; plist="$(plist_for "$bind")"
    range="${bind%.*}.0/24"
    mkdir -p "$AGENTS"

    # Replace, not append: bootout first if a previous copy is loaded.
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true

    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$socat</string>
        <string>-d</string><string>-d</string>
        <string>TCP-LISTEN:$port,bind=$bind,range=$range,fork,reuseaddr,nodelay</string>
        <string>TCP:$upstream,nodelay</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/$label.log</string>
    <key>StandardErrorPath</key><string>/tmp/$label.log</string>
</dict>
</plist>
EOF

    launchctl bootstrap "$DOMAIN" "$plist"
    # Through launchd, not by hand: the only proof the agent works is the
    # agent working.
    launchctl kickstart -k "$DOMAIN/$label"
    sleep 1
    lsof -nP -iTCP:"$port" -sTCP:LISTEN | grep -q "$bind:$port" \
        || die "installed, but nothing is listening on $bind:$port — see /tmp/$label.log"
    echo "relay up: $bind:$port -> $upstream (from $range only), log /tmp/$label.log"
}

cmd_remove() {
    local bind="${1:-}"
    [ -n "$bind" ] || die "remove needs <bind-ip>"
    local label plist
    label="$(label_for "$bind")"; plist="$(plist_for "$bind")"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "relay removed: $label"
}

cmd_status() {
    local found=0
    for p in "$AGENTS/$LABEL_PREFIX".*.plist; do
        [ -e "$p" ] || continue
        found=1
        local label; label="$(basename "$p" .plist)"
        if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
            echo "$label: loaded"
        else
            echo "$label: plist present, not loaded"
        fi
    done
    [ "$found" = 1 ] || echo "no relay installed"
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep socat || true
}

case "${1:-}" in
    install) shift; cmd_install "$@";;
    remove)  shift; cmd_remove "$@";;
    status)  cmd_status;;
    *) sed -n '8,11p' "$0" >&2; exit 2;;
esac
