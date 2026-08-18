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
│   ├── stationLabel.ts             # Station-name lookup (JP DB -> EIBI), shared
│   └── actions/                    # Stream Deck action classes
├── scripts/                        # Tooling helpers
│   └── dump-lcd.sh                 # capture all 4 LCD panels as PNGs in ~/ICON/
├── mac-app/                        # Companion .app (Stream Deck profile focus target)
│   ├── Sources/main.swift          # AppKit status window
│   └── build-app.sh                # swiftc + bundle -> /Applications/deck-rx.app
└── com.hogehoge.deck-rx.sdPlugin/
    ├── manifest.json
    ├── layouts/                    # Encoder LCD layouts
    ├── ui/                         # Property Inspector HTML
    ├── imgs/                       # Action icons
    └── config.example.json         # Copy to config.json and edit
```
