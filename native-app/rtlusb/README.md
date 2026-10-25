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

## The Airspy HF+ (`airspyhf-dext.patch`, `airspyhf/`)

The same driver also matches the HF+ (03eb:800c). For it, `airspyhf-dext.patch`
makes the driver skip the RTL2832 set-up, select the interface's alternate
setting 1 (the only one with the IQ endpoint), stream the endpoint into the
same ring in 16 KiB transfers, and pass raw control transfers through
(`kRTLSDRMethodControlTransfer`, plus `kRTLSDRMethodClearHalt`). The device
info now says which USB device a service drives, and `usb_open.c` picks the
service by vendor, so a V4 and an HF+ plugged in together each reach their own.

Everything the HF+ needs beyond that is libairspyhf's
([airspy/airspyhf](https://github.com/airspy/airspyhf), BSD), which
`build-driver.sh` fetches at a pinned commit and `build-ios.sh` compiles
unmodified against `airspyhf/libusb.h` and `airspyhf/libusb_dext.c` — the
part of libusb the library uses, implemented on the driver. Its transfers are
filled from the ring a whole transfer at a time, oldest first, as the library's
callback wants them. The Mac's `Sources/AirspyDevice.swift` drives it.

`airspyhf.patch` changes the library in two places: the zero-IF IQ correction's
per-block ramp had its weights reversed (each update stepped at a block
boundary), and `airspyhf_deckrx_skip_iq_balancer()` turns that correction off,
which the app does for broadcast FM — on wide FM the correction's wandering
estimate is heard as crackle at 912 kHz, the zero-IF rate (docs/ipad.md).
