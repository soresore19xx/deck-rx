# mac-app — deck-rx companion window

A minimal AppKit app whose structural purpose is to **exist as a focusable macOS
application**, so that a Stream Deck profile can be bound to it. Stream Deck
switches to a profile automatically when the application it is bound to becomes
frontmost (the profile's "application" setting, stored as `AppIdentifier` in the
profile manifest). Without a real `.app` bundle there is nothing for the plugin's
profile to attach to, and the profile has to be selected by hand.

The window is not a placeholder rectangle: it mirrors the state the plugin
already persists, so it is useful on its own.

```
NHK第1 JOAK
594 kHz
AM  ·  VOL 70  ·  MUTED

S  ==============-----   -18 dBFS
N  =-------------------    3 dB

LINK     connected  ·  192.168.0.142:8888
PLUGIN   running (pid 57988)
feed: RAMDisk (no SSD wear) · 3.8 w/s · 1088 B/s · 353 writes total
```

## Build / install

```sh
./build-app.sh          # -> /Applications/deck-rx.app
open /Applications/deck-rx.app
```

`swiftc` (Command Line Tools) is the only hard requirement. `rsvg-convert` is
optional and only used to render the app icon from the plugin's own
`imgs/icon-source.svg`; without it the app gets the generic bundle icon.
The script is idempotent — re-run it after any source change.

## Where the displayed state comes from

Two sources, in layers:

| Field | Source |
| --- | --- |
| frequency / mode / volume / muted / server | `config.json` (baseline; the plugin persists frequency+mode within 500 ms and volume within 300 ms of a change) |
| S / N meters, link state, master on/off, station name | `deck-rx-status.json` — the live feed written by `src/statusFeed.ts` |
| plugin running / stopped | `/tmp/deck-rx.pid` + `kill(pid, 0)` |

The feed wins where the two overlap. A feed older than 3 s is ignored, so the
window degrades to the `config.json` baseline instead of showing frozen meters.
Meter scaling mirrors `spyDialTune.ts` (RSSI -100..-10 dBFS, SNR 0..60 dB) so
the window and the Stream Deck LCD always agree. The station name comes from
`src/stationLabel.ts`, the same lookup the LCD header uses (JP scraped tables
first, EIBI below 30 MHz), cached per frequency+region with a 30 s TTL because
EIBI matches on day and time of day. Frequencies neither database knows keep
the row and show a dash — collapsing it shifted every line below and made the
window jump while tuning. A station tagged with another region is a miss by
design (`lookupJpStation` filters by the active region), so e.g. 1179 kHz
MBSラジオ shows a dash while the region is 関東.

### The feed writes nothing when nobody is looking

The app refreshes `deck-rx-app.alive` every 5 s and deletes it on quit. The
plugin writes the status file only while that flag is fresher than 15 s — so a
closed companion app costs the plugin one `stat()` per tick and nothing else.
Identical payloads are skipped as well, with a 2 s heartbeat so a reader can
still tell an idle feed from a dead one.

Plugin instances spawned by the test harness (they carry `DECK_RX_CONFIG_PATH`)
disable the feed, so a test run cannot overwrite the real receiver's status
while the app is open. Both sides resolve the directory with the same rule: `/Volumes/RAMDisk` when it
is mounted (RAM-backed, so the feed causes no SSD wear at all), `/tmp`
otherwise. Overridable on the plugin side via `DECK_RX_STATUS_PATH`,
`DECK_RX_STATUS_ALIVE` and `DECK_RX_STATUS_INTERVAL_MS` (default 250 ms).

### Measured cost

With the app open and the receiver connected (AM, meters moving):

| | |
| --- | --- |
| payload | 320 B |
| write rate | 3.9 writes/s (the 250 ms tick) |
| byte rate | 1.1 KB/s = 3.9 MB/h = 92 MB/day |
| on RAMDisk | no SSD wear; RAM footprint stays at one 320 B file |
| on /tmp (fallback) | ~4 KB of SSD allocation per write under APFS copy-on-write, i.e. roughly 1.4 GB/day — the reason RAMDisk is preferred |
| plugin CPU | no measurable change (1.29 s vs 1.39 s of CPU time per 10 s with the feed off; the difference is inside the DSP's own noise) |
| with the app closed | 0 writes |

The window shows this accounting live in its bottom line, computed from the
`writes` / `bytesWritten` counters the feed carries in its own payload.

## Binding a Stream Deck profile to it

1. Create the dedicated deck-rx profile in the Stream Deck app.
2. In the profile list, open that profile's settings and set its application to
   `/Applications/deck-rx.app`.
3. Focusing the app (Dock click, Cmd-Tab) now switches the deck to that profile;
   the deck reverts to the default profile when the app loses focus.

Closing the window does not quit the app, and clicking the Dock icon re-opens
it — focusing the app is what drives the switch, so it stays available.
