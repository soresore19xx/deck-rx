# spyserver-ex

Stream Deck + plugin to control a remote [SpyServer](https://airspy.com/) and listen to AM/FM radio directly from the Stream Deck encoder dials.

The plugin connects over TCP to a SpyServer (e.g., an Airspy HF+ Discovery on a NanoPi), pulls down INT16 IQ samples, demodulates them in TypeScript, and pipes the resulting PCM through `ffmpeg` to a chosen macOS CoreAudio device.

## Features

| Item | Status |
|---|---|
| Volume | ✅ |
| AM/SW Bandwidth | ✅ |
| Carrier AGC | ✅ |
| AGC Attack | ✅ |
| AGC Decay | ✅ |
| IFNR (IF Noise Reduction) | ❌ Not implemented (UI toggle only) |
| Stereo PLL (better separation) | ❌ Simple squaring approach only |

### Implemented

- **SpyServer Tune** (button) — tune to a preset frequency from SDR++ bookmark file
- **SpyServer Dial** (encoder) — VFO / preset scrolling, 7-segment LCD, FM stereo lock badge, ATS-Mini-style 30-segment N (SNR) / S (RSSI) signal-strength bars
- **SpyServer Volume** (encoder) — rotate to adjust 0–150 %, push to mute
- **SpyServer Options** (encoder) — De-emphasis (off/50µs/75µs), IFNR, HiPass, LoPass, Stereo
- **SpyServer AM Options** (encoder) — Bandwidth (4/6/9/12 kHz), Carrier AGC, Attack, Decay
- **SpyServer Status** (encoder) — Conn / Host / Device / Frequency / Sample-rate readout
- WFM stereo decoder (19 kHz pilot squaring + 38 kHz BPF + matrix, with `2(L−R)` matrix correction)
- AM envelope detector with running DC removal, post-envelope LPF, asymmetric attack/decay AGC
- 50 µs / 75 µs FM de-emphasis (single-pole IIR)
- IQ-derived RSSI (RMS power, gain-compensated dBFS) and SNR (instantaneous-power variance ratio) — computed locally since SpyServer does not expose chip-level meters
- Dynamic mute on retune / startup to suppress pop noise
- Audio device selection by **name** (resilient against ffmpeg re-numbering)
- ATS-Mini-style metallic dial knob graphic (toothed rim, radial gradient, position dot)

## Repository layout

```
~/dev/spyserver-ex/
├── src/                            # TypeScript source
│   ├── SpyClient.ts                # SpyServer protocol (HELLO / SET_SETTING / IQ)
│   ├── spyService.ts               # Singleton service, state, persistence
│   ├── demodulator.ts              # FM/WFM/Stereo/AM DSP
│   ├── dspFilters.ts               # Biquad IIR (LP/HP/BP)
│   ├── AudioOutput.ts              # ffmpeg pipe + device-name resolution
│   ├── audioDevices.ts             # SwitchAudioSource + ffmpeg device map
│   ├── dialDisplay.ts              # 7-segment, header, footer, volume bar SVGs
│   ├── icons.ts                    # Knob, options panel SVGs
│   └── actions/                    # Stream Deck action classes
└── com.hogehoge.spyserver-ex.sdPlugin/
    ├── manifest.json
    ├── layouts/                    # Encoder LCD layouts
    ├── ui/                         # Property Inspector HTML
    ├── imgs/                       # Action icons
    └── config.example.json         # Copy to config.json and edit
```

## Build & install

```sh
# Prerequisites (MacPorts):
sudo port install ffmpeg switchaudio-osx

npm install
npm run build
```

After the first build, symlink the plugin into Stream Deck's plugin directory **before**
restarting Stream Deck (otherwise builds will not be reflected):

```sh
ln -s "$(pwd)/com.hogehoge.spyserver-ex.sdPlugin" \
      "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.hogehoge.spyserver-ex.sdPlugin"
```

The `postbuild` script aborts if the plugin entry is not a symlink.

Copy `com.hogehoge.spyserver-ex.sdPlugin/config.example.json` to `config.json` and adjust:

- `host` / `port` — your SpyServer address
- `ffmpeg.deviceName` — output device name from `SwitchAudioSource -t output -a`, or `"default"`
- `ffmpeg.mode` — `"local"` for AudioToolbox, `"icecast"` for streaming

## Architecture notes

- **SpyServer protocol** (Airspy spec, version 2.0.1700) is implemented from scratch following SDR++'s `spyserver_client.cpp`. Order of `SET_SETTING` commands matters: `IQ_FORMAT → IQ_DECIMATION → IQ_FREQUENCY → STREAMING_MODE → GAIN → IQ_DIGITAL_GAIN → STREAMING_ENABLED`.
- **Audio device by name**: `ffmpeg -f audiotoolbox <N>` indices change whenever a device is plugged in or removed. We persist the device **name** and resolve the current index every time `ffmpeg` is spawned, falling back to `default` if the named device is not found.
- **Pop suppression**: ffmpeg stdin gets a 40 ms silence prefill at startup; the iq listener writes silent PCM for the first 500 ms (startup) / 100 ms (retune); the demodulator skips `atan2(0,0)` when both vectors are near zero.
- **Volume**: in-memory state updates instantly; disk persistence is debounced 300 ms. Encoder rotation uses progressive acceleration (2 % / 3 % / 5 % per tick depending on spin speed).
- **Stereo decode**: 19 kHz pilot is bandpass-filtered, squared, then bandpass-filtered at 38 kHz to recover the subcarrier reference. The reference is amplitude-normalised by the smoothed pilot power (so it stays unit-magnitude regardless of signal level) before mixing with the FM-demodulated signal to recover L−R. The matrix uses `L = (L+R) + 2(L−R), R = (L+R) − 2(L−R)` to compensate for the half-amplitude DSB-SC mixer loss.
- **AM AGC**: asymmetric IIR tracks `|envelope|` with a fast attack and slow decay, dividing the signal by the tracker to normalise toward a fixed target amplitude.
- **Signal-strength bars** (Dial LCD bottom): direct port of the ATS-Mini plugin's segmented bar (30 segments, 4 px wide × 1 px gap, green `#00ff00` / red `#ff0000`). RSSI maps `−100..−20 dBFS → 0..100 %` so a moderate FM station shows red on a few top segments at the 10/17 split, mirroring the ATS-Mini S9 boundary. SNR is all-green like ATS-Mini's. Note: an Airspy HF+ via SpyServer is a direct-conversion receiver — there is no chip-level RSSI/SNR register; both meters are computed from the IQ stream and will not perfectly match a SI4732-class superhet receiver.

## License

Personal project. No license granted.
