# Build & install

[← Back to README](../README.md)

## What to install

### To use it

Nothing from MacPorts:

- **Deck RX Solo** from the release dmg links what it needs statically
  (libairspyhf and libusb included).
- **The iPad app** likewise.
- **The plugin**, once built, carries its own copies of PortAudio and
  libsamplerate next to its native modules. The one program it runs outside
  itself is `ffmpeg`, and only for the icecast publish path. It looks for it
  in `/opt/local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`.

### To build it

The build scripts look for libraries under MacPorts' `/opt/local`, so
[install MacPorts](https://www.macports.org/install.php) first. Everything else
comes from Apple.

| To build | From Apple, or anywhere | From MacPorts |
| --- | --- | --- |
| the Stream Deck plugin | Xcode Command Line Tools (for node-gyp); Node.js 20 or later, from any source; the Stream Deck app 7.1 or later, whose own Node the native modules are built for | `portaudio`, `libsamplerate` — required. `npm run rebuild-native` copies both into the plugin |
| Deck RX Solo and the Mac front-end | Xcode Command Line Tools (`swiftc`) | `airspyhf` and `libusb` — optional: the Airspy HF+ USB source, in the arm64 slice only. `librsvg` — optional: the app icons; without `rsvg-convert` the apps get the generic icon |
| the iPad app | Xcode (the iOS SDK; the USB driver is built with `xcodebuild`) | `librsvg` — optional, as above |
| DRM, in Solo and the iPad app (`native-app/drm/fetch.sh`) | `git`, `curl` | `autoconf`, `automake`, `libtool` — they generate fdk-aac's `configure` |
| a [sync hub](sync.md) | Node.js 20 or later | — |

```sh
xcode-select --install
sudo port install portaudio libsamplerate          # the plugin
sudo port install airspyhf libusb librsvg          # Solo's USB source; the app icons
sudo port install autoconf automake libtool        # DRM
sudo port install ffmpeg                           # icecast publish, if you use it
```

The PI's output-device dropdown comes from `naudiodon.getDevices()` /
`getHostAPIs()` in-process; no other audio tool is needed.

How the Mac apps and the iPad app are built: [native-app.md](native-app.md),
[ipad.md](ipad.md).

### Developer tools (optional)

| Tool | MacPorts | Used by |
| --- | --- | --- |
| `rsvg-convert` | `librsvg` | `scripts/dump-lcd.sh`, `scripts/lint-lcd.py`, `scripts/render-all-dials.mjs` |
| `magick`, `compare` | `ImageMagick7`, with `/opt/local/lib/ImageMagick7/bin` on `PATH` (the older `ImageMagick` port has `compare` but no `magick`) | `scripts/render-all-dials.mjs` (the montage), `scripts/compare-lcd.sh` |
| `sox` | `sox` | `native-app/tools/run-drm-selftest.sh` |
| `socat` | `socat` | `native-app/tools/spyserver-relay.sh` |
| libsndfile, libsamplerate | `libsndfile`, `libsamplerate` | `native-app/drm/build-cli.sh` (the DRM command-line harness) |

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
`~/Library/Application Support/com.elgato.StreamDeck/NodeJS/<ver>/`. Which
major it runs is set by `Nodejs.Version` in the plugin's `manifest.json` —
`24` since 2026-11 (Node 20 reached end-of-life on 2026-04-30 and no longer
gets security fixes); at the time of writing that resolves to `24.22.1`.
Stream Deck downloads the runtime the first time a plugin asks for it
(Stream Deck 7.1 or later). The naudiodon binary you'd get from a
bare `npm install` is built against your *development* Node, which is
usually a different ABI — load that into Stream Deck's runtime and you
get a `NODE_MODULE_VERSION` mismatch or, more commonly, the
`bindings` package fails to find any `.node` at all.

### `npm run rebuild-native` — what it does

[`scripts/rebuild-native.sh`](../scripts/rebuild-native.sh) automates
four steps:

1. **Swap libportaudio.dylib for the MacPorts arm64 build.** The naudiodon
   package ships a pre-built `node_modules/naudiodon/portaudio/bin/libportaudio.dylib`
   that's an i386+x86_64 fat binary — useless on Apple Silicon. The
   script copies `/opt/local/lib/libportaudio.2.dylib` (MacPorts, arm64)
   over it and rewrites the `LC_ID_DYLIB` to `@loader_path/libportaudio.dylib`
   via `install_name_tool` so the binding resolves it without polluting
   `LC_RPATH`.

2. **Rebuild `naudiodon.node` against Stream Deck's bundled Node.** Reads
   the major from `manifest.json` (`Nodejs.Version`) and picks the highest
   directory of that major under `~/Library/Application Support/com.elgato.StreamDeck/NodeJS/`
   (several majors can sit there side by side when other plugins ask for
   other versions; directories only — there is a `manifest.json` sibling
   file in the same parent that an unfiltered `ls` would silently pick
   up), and invokes `npx node-gyp@10 rebuild --target=$VER --arch=arm64
   --target_platform=darwin`. It stops with an error if that major has
   not been downloaded yet — start the plugin once so Stream Deck fetches it.

3. **Same for `segfault-handler`** (a debug dependency naudiodon imports
   at runtime).

4. **Build `deck-rx-asrc`**, the in-tree libsamplerate binding in
   `native/samplerate`, the same way, then copy
   `/opt/local/lib/libsamplerate.0.dylib` next to `asrc.node` and point the
   binding at the copy (`@loader_path`), so the plugin does not need MacPorts
   at runtime.

After the script completes you should have:

```
node_modules/naudiodon/build/Release/naudiodon.node
node_modules/segfault-handler/build/Release/segfault-handler.node
native/samplerate/build/Release/asrc.node
native/samplerate/build/Release/libsamplerate.0.dylib
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
SD_NODE="$(ls -d "$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"/24.*/ | tail -1)node"
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
- After changing `Nodejs.Version` in `manifest.json` (a new major is a new
  ABI — e.g. 20 → 24 moved `NODE_MODULE_VERSION` from 115 to 137)
- After `sudo port upgrade portaudio` or `libsamplerate` (the plugin carries
  copies of the installed MacPorts versions)
- If `node_modules/naudiodon/build/` disappears for any reason
  (`npm install` after deleting `package-lock.json` can wipe it)

## Configuration

Copy `com.hogehoge.deck-rx.sdPlugin/config.example.json` to `config.json`
and adjust:

- `host` / `port` — your SpyServer address (the example's `192.168.1.100` is a
  placeholder).
- `syncHubs` — the address of a [sync hub](sync.md), or empty for none.
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
