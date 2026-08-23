# Standalone app port — plan of record

**Decision (2026-08-23):** the native app becomes a complete receiver in
Swift. Not a front-end that needs the plugin running, and not a remote
front-end talking to studio over the network — a `.app` that can be copied to
any Mac and used.

**Why:** the current split buys nothing. The app already owns no receiver
state, so it is useless without the plugin on the same machine, and in
exchange the whole thing inherits Node plus two ABI-locked native modules
(`naudiodon`, `deck-rx-asrc`) that must be rebuilt against whatever Node the
Stream Deck app ships. Portability is the point; a receiver that only runs on
studio is what the user does not want.

## What actually has to move

Measured 2026-08-23. Line counts are the TypeScript being replaced, not an
estimate of the Swift.

### Ports (the real work)

| Source | Lines | Notes |
| --- | --- | --- |
| `SpyClient.ts` | 249 | SpyServer wire protocol. Compact and fully specified — binary framing, a handful of commands, three IQ formats. Lowest-risk piece, and everything else waits on it. |
| `demodulator.ts` | 1096 | WFM/NFM/AM/SSB/CW, AGC, FM stereo PLL. The largest single body of tuned behaviour. |
| `dspFilters.ts` | 165 | Filter design/state used by the above. |
| `iqnr.ts` / `ifnr.ts` | 434 | Noise reduction, pre- and post-demod. |
| `audioLeveling.ts` | 154 | Per-band makeup, opt-in AGC, tanh limiter. Already unit-tested — port the tests too. |
| `spyService.ts` | 1814 | **Only the receiver half.** Much of this file is Stream Deck listener plumbing (`subscribeX`/`unsubscribeX` pairs, settings persistence for dials) that the app does not need in that shape. The connect / retune / gain / demod-option state machine is what ports. |
| `bandPolicy.ts`, `deviceBands.ts` | 176 | Receivable-range rules, incl. the Airspy HF+ 31-60 MHz gap. |

### Replaced by system frameworks (deleted, not ported)

| Source | Lines | Replacement |
| --- | --- | --- |
| `fft.ts` | 144 | Accelerate / vDSP |
| `AudioOutput.ts` | 619 | AVAudioEngine |
| `asrc.ts` + `native/samplerate` | 77 + native | AVAudioConverter |
| `audioDevices.ts` | 71 | AVAudioEngine device enumeration |

**This is the payoff.** Both native modules disappear, and with them
`npm run rebuild-native` and the Stream Deck Node ABI coupling.

### Stays in Node, unchanged

The station-database scrapers (`japanStationsScraper.ts` 521,
`musenScraper.ts` 314, `eibi.ts` 211) are offline tools that produce JSON. The
app reads their output. Porting them would be work with no user-visible
return.

### Not needed in the app

`icons.ts`, `dialDisplay.ts`, `actions/` — Stream Deck rendering.

## Phases

Ordered so the riskiest unknown is settled first and each phase ends in
something that can be run.

1. **Swift `SpyClient`** — connect, device info, set frequency / gain /
   decimation, receive IQ. Ends when the app draws a live spectrum from its
   own connection with the plugin stopped.
2. **Audio out** — AVAudioEngine sink + AVAudioConverter resampling, driven by
   a single demod (AM first: it is the one with the longest history of
   trouble, so it is the honest test). Ends when the app is audible on its own.
3. **Remaining demods + options** — WFM/NFM/SSB/CW, the per-mode option sets,
   noise reduction, levelling. Ends when the app matches the plugin by ear and
   by meter on every band.
4. **Deck becomes a client** — the plugin drops its own signal path and drives
   the app through the control endpoint, the way `knobctl` already does. One
   receiver implementation, two front-ends.

Phases 1-3 leave the plugin untouched and working. Nothing user-visible is
removed until 4, and 4 is a separate decision.

## Risks worth naming up front

- **Two implementations exist during phases 1-3.** A demod fix made in one and
  not the other is the obvious failure. Mitigation: no phase is "done" until
  the app is compared against the plugin on the same signal, and phase 4 ends
  the duplication rather than leaving it standing.
- **`demodulator.ts` carries tuning that is not obvious from the code.** The AM
  path in particular has a documented history (see the noise investigation in
  memory: the root cause was a CoreAudio reader stall, and the fix is a
  two-stage response in `write()`). Porting it as if it were plain DSP will
  reintroduce settled bugs. Read the git history of each function before
  porting it, per CLAUDE.md.
- **AVAudioEngine is not a drop-in for the PortAudio path.** The current sink
  has drift compensation and queue policy that exist because of measured
  failures, not theory.

## Status

Phase 1 not started. Nothing in this plan has been implemented yet.
