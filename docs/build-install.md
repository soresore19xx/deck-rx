# Build & install

[← Back to README](../README.md)

## Developer prerequisites

| | Version |
|--|--|
| macOS | 11+ |
| Stream Deck software | 6.6 or later |
| Stream Deck **+** hardware (encoder + LCD) | for the dial actions |
| Node.js (via nodebrew / nvm / fnm etc.) | 20 or later |
| Stream Deck CLI (`streamdeck` command) | install with `npm install -g @elgato/cli` |
| MacPorts: ffmpeg, switchaudio-osx | runtime audio bridge |
| MacPorts: librsvg, ImageMagick, sox | optional — only needed for the LCD dump / audio analysis scripts |

```sh
# Runtime prerequisites
sudo port install ffmpeg switchaudio-osx

# Stream Deck CLI (provides the `streamdeck` command used below)
npm install -g @elgato/cli

# Project install + build
npm install
npm run build
```

The Node SDK package (`@elgato/streamdeck`) is pulled in by `npm install` —
no separate global install required.

After the first build, symlink the plugin into Stream Deck's plugin directory **before**
restarting Stream Deck (otherwise builds will not be reflected):

```sh
ln -s "$(pwd)/com.hogehoge.deck-rx.sdPlugin" \
      "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin"
```

The `postbuild` script aborts if the plugin entry is not a symlink.

Copy `com.hogehoge.deck-rx.sdPlugin/config.example.json` to `config.json` and adjust:

- `host` / `port` — your SpyServer address
- `ffmpeg.deviceName` — output device name from `SwitchAudioSource -t output -a`, or `"default"`
- `ffmpeg.mode` — `"local"` for AudioToolbox, `"icecast"` for streaming

Audio output mode is also switchable from the **Tune dial Property Inspector**
without editing `config.json`:

- `Output: Local Device` — pick a CoreAudio device from the dropdown
- `Output: Icecast Stream` — fill in the source URL (e.g.
  `icecast://source@host:port/mount`) and the icecast `source-password` (the
  PI uses `<input type="password">` so the value is masked). The plugin
  stores the URL and the password as separate fields in `config.json`
  (`ffmpeg.icecastUrl` / `ffmpeg.icecastPassword`) and only re-combines them
  on the ffmpeg command line at spawn. icecast 2 stock requires a non-empty
  source-password — there is no truly anonymous source mode.

Switching Output between Local and Icecast tears the previous ffmpeg child
down and **awaits its exit** (Promise-based `stop()`) before spawning the
new one, so AudioToolbox isn't claimed by two processes at once and the
sample-rate negotiation doesn't get stuck at the device default (which
would otherwise make the audio play back at the wrong speed).
