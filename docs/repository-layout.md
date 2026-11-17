# Repository layout

[← Back to README](../README.md)

```
deck-rx/
├── src/                            # the plugin and its receiver core (TypeScript)
│   ├── index.ts                    # plugin entry: registers the actions
│   ├── headless.ts                 # entry point: the receiver without Stream Deck
│   ├── spyService.ts               # the receiver: state, persistence, audio, tuning
│   ├── iqClient.ts                 # picks the source (SpyServer / rtl_tcp) per config
│   ├── SpyClient.ts                # SpyServer protocol
│   ├── RtlTcpClient.ts             # rtl_tcp protocol
│   ├── channel.ts                  # channel stage: each mode cut out of the IQ first
│   ├── demodulator.ts              # WFM (stereo) / NFM / AM / SSB / CW
│   ├── dspFilters.ts               # biquads, FIRs, the multipath equaliser
│   ├── autoNotch.ts, ifnr.ts, iqnr.ts   # auto notch, audio NR, IQ NR
│   ├── audioLeveling.ts            # per-mode makeup, optional AGC, soft limiter
│   ├── AudioOutput.ts, asrc.ts     # naudiodon output with the ASRC; ffmpeg for Icecast
│   ├── audioDevices.ts             # output-device list for the PI (naudiodon)
│   ├── gainSearch.ts, gainMemory.ts     # automatic per-station RF gain
│   ├── deviceSettings.ts, deviceBands.ts # per-receiver settings and tunable ranges
│   ├── bandPolicy.ts, tuneMath.ts  # band → mode, VFO / preset stepping
│   ├── fft.ts, spectrumFeed.ts     # FFT dials and the spectrum socket
│   ├── statusFeed.ts               # live status for the Mac front-end
│   ├── controlServer.ts            # loopback HTTP control endpoint
│   ├── syncClient.ts, syncCore.ts, syncHub.ts   # optional preset / gain sync
│   ├── presets.ts, presetList.ts   # the preset store and the SDR++ import
│   ├── stationLabel.ts, japanStations*.ts, musenScraper.ts, eibi.ts  # station names
│   ├── dialDisplay.ts, icons.ts    # LCD drawing
│   ├── log.ts                      # logger seam (SDK in the plugin, stderr headless)
│   └── actions/                    # one file per Stream Deck action
├── test/                           # vitest suites, harness/ (a mocked Stream Deck + SpyServer)
├── scripts/                        # build helpers, LCD dump / render, station-DB refresh, sync-hub installer
├── native/samplerate/              # libsamplerate addon behind the plugin's ASRC
├── com.hogehoge.deck-rx.sdPlugin/
│   ├── manifest.json
│   ├── layouts/                    # encoder LCD layouts
│   ├── ui/                         # Property Inspector HTML
│   ├── imgs/                       # action icons
│   ├── data/                       # station databases (JP, callsigns, EIBI)
│   └── config.example.json         # copy to config.json and edit
├── native-app/                     # Solo, the Mac front-end and the iPad app (Swift)
│   ├── Sources/                    # one tree for all three; main.swift is the Mac window,
│   │                               # iOSApp.swift the iPad's, LocalRadio.swift the receiver
│   ├── Tests/, Quality/, Bench/    # tests, the receiver quality run, benchmarks
│   ├── build-app.sh                # Deck RX.app and Deck RX Solo.app
│   ├── build-ios.sh                # the iPad app (simulator or device)
│   ├── notarize.sh                 # Developer ID signing, notarisation, the release dmg
│   ├── drm/                        # fetches and builds the optional DRM decoder
│   ├── rtlusb/                     # fetches and builds the iPad's USB driver (RTL-SDR, HF+)
│   └── tools/                      # spyserver-relay.sh and DRM self-test helpers
└── docs/
```
