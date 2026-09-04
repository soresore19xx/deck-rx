# Build & install

[← Back to README](../README.md)

## Developer prerequisites

| | Version / source |
|--|--|
| macOS | 11+ (Apple Silicon recommended; native binding ships as arm64) |
| Stream Deck software | 6.6 or later |
| Stream Deck **+** hardware (encoder + LCD) | for the dial actions |
| Node.js (via nodebrew / nvm / fnm etc.) | 20 or later, for development |
| Stream Deck CLI (`streamdeck` command) | `npm install -g @elgato/cli` |
| MacPorts: `portaudio` | runtime audio bridge (always needed — naudiodon talks PortAudio directly) |
| MacPorts: `ffmpeg` | optional — only if you want the icecast publish path |
| Xcode Command Line Tools | needed by node-gyp for the native rebuild |
| MacPorts: `librsvg`, `ImageMagick`, `sox` | optional — LCD dump / audio analysis scripts |

```sh
sudo port install portaudio
# Optional, only if you'll use the icecast publish path:
sudo port install ffmpeg
# node-gyp toolchain:
xcode-select --install   # if not already installed
# Stream Deck CLI (provides the `streamdeck` command):
npm install -g @elgato/cli
```

(Earlier versions of deck-rx also required `switchaudio-osx` for the PI
output-device dropdown. That dependency was dropped in favour of
`naudiodon.getDevices()` / `getHostAPIs()`, which return the same
CoreAudio device list and current system default — in-process, no
external CLI.)

## First install

```sh
npm install
npm run rebuild-native   # see "Native audio binding (naudiodon)" below
npm run build
```

The order matters — `rebuild-native` rewrites `node_modules/naudiodon/build/`
in place against Stream Deck's bundled Node ABI; running it before `build`
keeps the bundle consistent with the binding that will be loaded at
runtime.

## Plugin symlink

After the first build, symlink the plugin source tree into Stream Deck's
plugin directory **before** restarting Stream Deck (otherwise builds will
not be reflected — Stream Deck will keep loading whatever copy is currently
under its own Plugins folder):

```sh
ln -s "$(pwd)/com.hogehoge.deck-rx.sdPlugin" \
      "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.deck-rx.sdPlugin"
```

The `postbuild` script aborts if the plugin entry is not a symlink, so a
misconfigured install fails loudly instead of leaving you debugging a
stale bundle.

## Native audio binding (naudiodon)

Local audio output goes through [`naudiodon`](https://github.com/Streampunk/naudiodon),
a thin Node binding to PortAudio that talks directly to CoreAudio's HAL.
No intermediate ffmpeg process is involved on the local path — that's
deliberate, because ffmpeg's `-f audiotoolbox` sink wedges every ~5 h of
continuous playback (ffmpeg keeps accepting PCM writes but no audio
reaches the device).

`naudiodon` is a native module, so it needs a `.node` binary whose
Node.js ABI version matches the Node runtime that loads it. Stream Deck
ships its **own** bundled Node under
`~/Library/Application Support/com.elgato.StreamDeck/NodeJS/<ver>/` (at
the time of writing, `20.20.0`). The naudiodon binary you'd get from a
bare `npm install` is built against your *development* Node, which is
usually a different ABI — load that into Stream Deck's runtime and you
get a `NODE_MODULE_VERSION` mismatch or, more commonly, the
`bindings` package fails to find any `.node` at all.

### `npm run rebuild-native` — what it does

[`scripts/rebuild-native.sh`](../scripts/rebuild-native.sh) automates
three steps:

1. **Swap libportaudio.dylib for the MacPorts arm64 build.** The naudiodon
   package ships a pre-built `node_modules/naudiodon/portaudio/bin/libportaudio.dylib`
   that's an i386+x86_64 fat binary — useless on Apple Silicon. The
   script copies `/opt/local/lib/libportaudio.2.dylib` (MacPorts, arm64)
   over it and rewrites the `LC_ID_DYLIB` to `@loader_path/libportaudio.dylib`
   via `install_name_tool` so the binding resolves it without polluting
   `LC_RPATH`.

2. **Rebuild `naudiodon.node` against Stream Deck's bundled Node.** Picks
   the highest directory under `~/Library/Application Support/com.elgato.StreamDeck/NodeJS/`
   (filtered to actual directories — there is a `manifest.json` sibling
   file in the same parent that an unfiltered `ls` would silently pick
   up), and invokes `npx node-gyp@10 rebuild --target=$VER --arch=arm64
   --target_platform=darwin`.

3. **Same for `segfault-handler`** (a debug dependency naudiodon imports
   at runtime).

After the script completes you should have:

```
node_modules/naudiodon/build/Release/naudiodon.node
node_modules/segfault-handler/build/Release/segfault-handler.node
```

Verify with `file`:

```sh
file node_modules/naudiodon/build/Release/naudiodon.node
# → Mach-O 64-bit bundle arm64
```

### Verifying the binding from outside the plugin

If audio is silent and you want to know whether the binding itself is
healthy (vs. some higher-up problem like spyService not enabling the
stream), load `naudiodon` directly from Stream Deck's bundled Node and
enumerate output devices:

```sh
SD_NODE="$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node"
"$SD_NODE" -e '
  const pa = require("./node_modules/naudiodon");
  console.log("loaded OK");
  for (const d of pa.getDevices().filter(d => d.maxOutputChannels > 0)) {
    console.log("  id=" + d.id, JSON.stringify(d.name), "ch=" + d.maxOutputChannels);
  }
'
```

If this lists devices the binding is fine — investigate spyService /
startAudio / the SpyServer connection instead. If it errors out, run
`npm run rebuild-native` again and check the script output for failures
(particularly the `node-gyp rebuild` step).

### When to re-run rebuild-native

- After `npm install` for the first time
- After `npm install <something>` that touches `naudiodon` (rare)
- After Stream Deck app upgrades its bundled Node version (the directory
  name under `NodeJS/` changes — current binding becomes ABI-stale)
- After `sudo port upgrade portaudio` (the dylib swap is against the
  installed MacPorts version)
- If `node_modules/naudiodon/build/` disappears for any reason
  (`npm install` after deleting `package-lock.json` can wipe it)

## Configuration

Copy `com.hogehoge.deck-rx.sdPlugin/config.example.json` to `config.json`
and adjust:

- `host` / `port` — your SpyServer address.
- `naudiodon.deviceName` — CoreAudio output device name (one of the
  entries naudiodon enumerates via `getDevices()`; the PI dropdown
  shows the same names), or `"default"` to follow the system default
  device.
- `ffmpeg.mode` — `"local"` for normal listening (audio goes through
  naudiodon), `"icecast"` to publish PCM as MP3 to an icecast server.
- `ffmpeg.icecastUrl` / `ffmpeg.icecastPassword` / `ffmpeg.bitrate` —
  only relevant when `mode === "icecast"`. The URL is the bare
  `icecast://user@host:port/mount` form; the source-password is held
  separately so the PI can render it with `<input type="password">`.
  ffmpeg combines them at spawn time.

You can also reach these settings from the **Tune dial Property Inspector**
without editing `config.json` directly:

- `Output: Local Device` — pick a CoreAudio device from the dropdown
  (populated via `naudiodon.getDevices()` filtered to output-capable
  devices; the "System Default (XXX)" label is sourced from
  `naudiodon.getHostAPIs().HostAPIs[0].defaultOutput`).
- `Output: Icecast Stream` — fill in the source URL and source-password.

Switching between Local and Icecast tears the previous audio sink down
and awaits its exit (Promise-based `stop()`) before spawning the new
one. For icecast → local, this matters because the ffmpeg child holding
the network socket has to release it cleanly; for local → local with a
device change, naudiodon's PortAudio stream is recreated against the new
device id.
