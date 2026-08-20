# Repository layout

[← Back to README](../README.md)

```
~/dev/deck-rx/
├── src/                            # TypeScript source
│   ├── SpyClient.ts                # SpyServer protocol (HELLO / SET_SETTING / IQ)
│   ├── spyService.ts               # Singleton service, state, persistence
│   ├── demodulator.ts              # FM/WFM/Stereo/AM DSP
│   ├── dspFilters.ts               # Biquad IIR (LP/HP/BP)
│   ├── AudioOutput.ts              # ffmpeg pipe + device-name resolution
│   ├── audioDevices.ts             # SwitchAudioSource + ffmpeg device map
│   ├── dialDisplay.ts              # 7-segment, header, footer, volume bar SVGs
│   ├── icons.ts                    # Knob, options panel SVGs
│   ├── statusFeed.ts               # Live status feed for the companion app
│   ├── controlServer.ts            # Loopback HTTP endpoint for an external knob
│   ├── spectrumFeed.ts             # Binary FFT frames over a Unix socket
│   ├── headless.ts                 # Entry point: the receiver without Stream Deck
│   ├── log.ts                      # Logger seam (SDK for the plugin, stderr headless)
│   ├── presetList.ts               # Preset list, SDK-free so the core can load it
│   ├── tuneMath.ts                 # VFO step math shared by the dial + control server
│   ├── stationLabel.ts             # Station-name lookup (JP DB -> EIBI), shared
│   └── actions/                    # Stream Deck action classes
├── scripts/                        # Tooling helpers
│   └── dump-lcd.sh                 # capture all 4 LCD panels as PNGs in ~/ICON/
├── mac-app/                        # Companion .app (Stream Deck profile focus target)
│   ├── Sources/main.swift          # AppKit status window
│   ├── Sources/SpectrumFeed.swift  # Reads the plugin's spectrum socket
│   ├── Sources/SpectrumView.swift  # Spectrum + waterfall drawing
│   └── build-app.sh                # swiftc + bundle -> /Applications/deck-rx.app
└── com.hogehoge.deck-rx.sdPlugin/
    ├── manifest.json
    ├── layouts/                    # Encoder LCD layouts
    ├── ui/                         # Property Inspector HTML
    ├── imgs/                       # Action icons
    └── config.example.json         # Copy to config.json and edit
```
