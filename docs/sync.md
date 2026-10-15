# Sync between the plugin, Solo and the iPad

Optional. Keeps the presets and the per-station RF gains (the ones the
automatic search chose and the ones saved by hand) the same on every deck-rx
receiver you run: the Stream Deck plugin, Deck RX Solo on each Mac, and the
iPad. Solo and the iPad also share the stations kept in mono
(`station-mono.json`; the plugin has no such setting and leaves them alone).
Display settings, volume and the like stay per device.

Part of [deck-rx](../README.md).

## What you need

- One machine that is always on and that every device can reach over HTTP:
  any Mac with Node 20+ and this repository built (`npm run build`).
- Port 8772 open to the devices. It is plain HTTP with no authentication, so
  keep it on a network you trust; it carries station lists and gain indices,
  nothing else.

## How it works

One small HTTP server, the **hub** (`src/syncHub.ts`, built to
`com.hogehoge.deck-rx.sdPlugin/bin/sync-hub.js`), listens on port 8772 on
every interface. Each receiver keeps its own files exactly as before — the
preset store, `gain-memory.json` and, on Solo and the iPad,
`station-mono.json` — and those files are its **local cache**:

- every 30 s (the iPad: while it is in front) a receiver compares its files
  with what the hub last confirmed (`sync-state.json` beside them), sends what
  differs, and writes in what the hub answers with;
- with the hub out of reach nothing changes for the receiver, and an edit made
  meanwhile is still a difference on the next round, so it goes up then;
- per entry the newer change wins; a deletion travels as an explicit "deleted"
  so a station removed on one device does not come back from another;
- a receiver's very first sync only fills gaps on the hub, never overrides.

No edit site knows about sync: the SDR++ import, the PI, the Add / Edit sheet
and the gain search all write the files as before, and the next round picks the
change up. The SDR++ file itself is still only read.

Rules: `src/syncCore.ts` and `native-app/Sources/Sync.swift`, the same cases in
`test/syncCore.test.ts` and `native-app/Tests/main.swift`.

## Running the hub

On the always-on Mac, from the repository:

```sh
npm install && npm run build
scripts/install-sync-hub.sh
curl -s http://localhost:8772/health
```

The installer writes the LaunchAgent `com.hogehoge.deckrx-sync` (started at
login, kept alive) and logs to `~/Library/Logs/deck-rx-sync.log`. The hub's
data is `~/Library/Application Support/deck-rx-sync/store.json`.

## Pointing the receivers at it

Sync is off until a receiver is given the hub's address. The value is
`host` or `host:port` (8772 if no port), or a URL; more than one,
comma-separated, are tried in order — useful when a device may be on either
of two networks.

| Receiver | Where |
| --- | --- |
| Solo | Options → SERVER → **Sync hub**, applied on Enter |
| iPad | Options → RECEIVER → **Sync hub**, tap to enter |
| plugin | `"syncHubs": "host"` in `config.json`, then restart the plugin |

An empty value turns sync off again. `DECK_RX_SYNC_HUBS` in the environment
overrides the setting (empty: off); the test runners set it empty, a sandboxed
plugin instance (`DECK_RX_CONFIG_PATH`) never syncs, and neither does an iPad
simulator build unless `DECK_RX_SYNC_HUBS` names a hub.

## Before the first sync

The first sync of each device adds whatever stations the hub does not have
yet. If the devices hold different versions of the same list — renamed
stations, test entries — make them the same first, or the hub collects every
variant.
