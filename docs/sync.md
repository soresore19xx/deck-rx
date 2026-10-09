# Sync between the plugin, Solo and the iPad

Presets and the per-station RF gains (the ones the automatic search chose and
the ones saved by hand) are kept in step across every deck-rx receiver: the
Stream Deck plugin, Deck RX Solo on each Mac, and the iPad. Display settings,
volume and the like stay per device.

## How

One small HTTP server, the **hub**, runs on mini4 (`src/syncHub.ts`, built to
`com.hogehoge.deck-rx.sdPlugin/bin/sync-hub.js`, port 8772 on every
interface). Each receiver keeps its own files exactly as before — the preset
store and `gain-memory.json` — and those files are its **local cache**:

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

Receivers try `http://192.168.0.51:8772` then `http://192.168.1.51:8772` (the
iPad's segment). `DECK_RX_SYNC_HUBS` overrides the list, and an empty value
turns sync off; the test runners set it empty, and a harness plugin instance
(`DECK_RX_CONFIG_PATH`) never syncs.

Rules: `src/syncCore.ts` and `native-app/Sources/Sync.swift`, the same cases in
`test/syncCore.test.ts` and `native-app/Tests/main.swift`.

## The hub on mini4

```
cd ~/Dev/deck-rx && npm run build && scripts/install-sync-hub.sh
curl -s http://192.168.0.51:8772/health
```

The installer writes the LaunchAgent `com.hogehoge.deckrx-sync` (started at
login, kept alive) and logs to `~/Library/Logs/deck-rx-sync.log`. The hub's
data is `~/Library/Application Support/deck-rx-sync/store.json`.
