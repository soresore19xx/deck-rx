# RTL-SDR on the iPad's own USB

The iPad build can carry a DriverKit driver for RTL2832U dongles, so an RTL-SDR
(the RTL-SDR Blog V4 is the one tested) plugged into the iPad is a source of its
own — **RTL-SDR (USB)** in the source menu — with no server and no second app.

Only iPads with an M-series chip run DriverKit drivers. On any other iPad the
source is offered and fails to open.

```sh
native-app/rtlusb/build-driver.sh      # fetch, patch, build and sign the driver
native-app/build-ios.sh device         # picks it up and carries it
```

Then, once, on the iPad: **Settings > Apps > Deck RX**, turn the driver on, and
plug the dongle in (again, if it was already in).

## Where it comes from

Nothing of the driver is checked in here. `build-driver.sh` clones
[arvedviehweger/RTL-SDR-USB-iPadOS](https://github.com/arvedviehweger/RTL-SDR-USB-iPadOS)
(RTLBridge, Apache-2.0) at a pinned commit, with its submodule
[gnuradio4-blocks](https://github.com/gnuradio/gnuradio4-blocks) (MIT), and:

- applies `r828d-pll.patch` to gnuradio4-blocks' `RTL2832Device.hpp`;
- renames the driver to `com.hogehoge.deckrx.ipad.driver` — iPadOS only takes a
  driver from the app whose bundle id it sits under;
- builds it with Xcode's automatic signing, which registers both ids and leaves
  a profile for the app that carries `communicates-with-drivers`.
  `build-ios.sh` signs Deck RX with that profile when the driver is there.

The app side is RTLBridge's IOKit bridge (`RTLSDRBridge.c`), compiled in from
the fetched tree, and `Sources/RtlUsbLink.swift`, which reads the driver's
sample ring and turns rtl_tcp's commands into the driver's calls. The receiver
behind it is `RtlTcpClient`, the same one the RTL-TCP source uses: the link
speaks rtl_tcp's bytes, so rate planning, gain and pacing are shared.

## The PLL patch

Without it the V4 heard noise on every band, in RTLBridge's own FM radio as
much as here. Two differences from librtlsdr's `r82xx_set_pll`
(rtl-sdr-blog), both in `setPll()`:

- the VCO fine-tune reference is 1 on the R828D, not 2;
- the fine tune moves only the divider register (SEL_DIV). The VCO and
  sigma-delta maths keep the divider the loop chose. Recomputing it put the VCO
  outside its range whenever the adjustment fired, and the PLL never locked.

It also does what rtl-sdr-blog does around the lock for the R828D (refdiv2 off,
autotune 128 kHz then 8 kHz, VCO current at its maximum), and logs
`[RTL2832] PLL not locked at … Hz` when the lock bit stays clear.

Measured 2026-10-24 on an iPad Pro 12.9" (M1) with a Blog V4: noise before,
stations after.
