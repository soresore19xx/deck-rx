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
93.000 MHz
WFM  ·  VOL 70  ·  MUTED

PLUGIN   running (pid 1758)
SERVER   192.168.0.142:8888
source: config.json
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

The plugin exposes no IPC endpoint, so the app reads artefacts the plugin
already maintains, once per second:

| Field | Source |
| --- | --- |
| frequency / mode / volume / muted / server | `com.hogehoge.deck-rx.sdPlugin/config.json` (via the Stream Deck plugin symlink) |
| plugin running / stopped | `/tmp/deck-rx.pid` + `kill(pid, 0)` |

`config.json` is written when the plugin persists state, so the values track the
radio with a short lag rather than instantly.

If a live feed is added later, write `/tmp/deck-rx-status.json` with any of
`freqHz`, `mode`, `volume`, `muted`; those fields win over `config.json` and the
app needs no change. Mode numbering follows `spyService.ts`
(0=NFM, 1=WFM, 2=AM, 4=USB, 5=CW, 6=LSB).

## Binding a Stream Deck profile to it

1. Create the dedicated deck-rx profile in the Stream Deck app.
2. In the profile list, open that profile's settings and set its application to
   `/Applications/deck-rx.app`.
3. Focusing the app (Dock click, Cmd-Tab) now switches the deck to that profile;
   the deck reverts to the default profile when the app loses focus.

Closing the window does not quit the app, and clicking the Dock icon re-opens
it — focusing the app is what drives the switch, so it stays available.
