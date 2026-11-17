# Server-side setup (SpyServer on Linux)

[← Back to README](../README.md)

Every deck-rx receiver talks to a running SpyServer (or to `rtl_tcp`). The
receivers sit on USB on a Linux machine — a single-board computer, a small PC,
or a Linux VM with the USB devices passed through — and SpyServer publishes
each of them on the LAN on a port of its own.

The deployment these pages are tested against: **Ubuntu 24.04 (aarch64)** in a
VM on a Mac mini (VirtualBuddy, USB passed through by vendor / product ID),
with two SpyServer instances:

| port | receiver | config | service |
| --- | --- | --- | --- |
| 8888 | Airspy HF+ Discovery | `/usr/local/etc/spyserver.config` | `spyserver.service` |
| 8889 | RTL-SDR Blog V4 | `/usr/local/etc/spyserver-rtlsdr.config` | `spyserver-rtlsdr.service` |

One receiver is enough; the second instance is only for a second device.

## Hardware

- Airspy HF+ Discovery (USB ID `03eb:800c`) — 0.5–31 MHz and 60–260 MHz
- optionally an RTL-SDR, such as the RTL-SDR Blog V4 (USB ID `0bda:2838`)
- a Linux machine the Mac can reach
- an antenna for the bands you care about; two receivers on one antenna need a
  proper 2-way splitter, not a T: a T gives no isolation between the two
  receivers and presents 25 Ω to the antenna

## Libraries

SpyServer loads the device library at run time.

```sh
sudo apt update
sudo apt install -y libusb-1.0-0 rtl-sdr librtlsdr2   # rtl-sdr only for an RTL-SDR
```

For the HF+, `libairspyhf` — either the distribution's `libairspyhf1` or a
build of [airspyhf](https://github.com/airspy/airspyhf) installed under
`/usr/local/lib` (what the tested VM uses). `airspyhf_info` (from the same
project) confirms the device is seen and prints its serial.

## udev rules

Without a rule the device is owned by root and SpyServer can't open it as a
service user. `/etc/udev/rules.d/52-airspyhf.rules`:

```
ATTR{idVendor}=="03eb", ATTR{idProduct}=="800c", SYMLINK+="airspyhf-%k", MODE="660", GROUP="plugdev", TAG+="uaccess"
```

`librtlsdr2` installs its own rule for RTL-SDR dongles.

A second rule restarts a receiver's SpyServer when its device comes back, so a
replugged cable (or a VM that re-attaches the USB) recovers without a hand:

```
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="03eb", ATTR{idProduct}=="800c", RUN+="/usr/bin/systemctl --no-block restart spyserver.service"
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0bda", ATTR{idProduct}=="2838", RUN+="/usr/bin/systemctl --no-block restart spyserver-rtlsdr.service"
```

```sh
sudo udevadm control --reload && sudo udevadm trigger
```

## Service user

```sh
sudo useradd --system --shell /sbin/nologin --home-dir /home/spyserver --create-home spyserver
sudo usermod -aG plugdev spyserver   # so udev's GROUP=plugdev grants USB access
```

## Install the SpyServer binary

SpyServer is a closed-source binary from Airspy. Download the build for your
machine (ARM64 here) from <https://airspy.com/download/> and place the binary
and its default config:

```sh
sudo install -m 755 spyserver /usr/local/bin/spyserver
sudo install -m 644 spyserver.config /usr/local/etc/spyserver.config
```

The same binary drives an RTL-SDR (`device_type = RTL-SDR`); nothing else needs
to be installed for it beyond the library above.

## Config

`/usr/local/etc/spyserver.config` (key fields, comments stripped):

```ini
bind_host        = 0.0.0.0
bind_port        = 8888-9000           # picks the first free port in the range
list_in_directory = 1
maximum_clients  = 3
allow_control    = 1
device_type      = AirspyHF+
device_serial    = 0xXXXXXXXXXXXXXXXX  # from airspyhf_info
fft_fps          = 20
fft_bin_bits     = 16
input_buffer_size_ms = 10
input_buffer_count   = 4
output_buffer_size_ms = 30
```

For the second receiver, a copy as `/usr/local/etc/spyserver-rtlsdr.config`
with a fixed port and the other device:

```ini
bind_port        = 8889
device_type      = RTL-SDR
device_serial    = 0
```

Leave direct sampling off for the RTL-SDR Blog V4: it upconverts HF itself.

## systemd services

`/etc/systemd/system/spyserver.service`:

```ini
[Unit]
Description=Spy Server
After=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=/usr/local/bin/spyserver /usr/local/etc/spyserver.config
User=spyserver

[Install]
WantedBy=multi-user.target
```

`spyserver-rtlsdr.service` is the same with the other config path. A SpyServer
holding a device that has gone away can ignore SIGTERM, so both carry a drop-in
that stops it after 5 s rather than systemd's default 90
(`/etc/systemd/system/spyserver.service.d/stop-timeout.conf`, and the same for
the other):

```ini
[Service]
TimeoutStopSec=5
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now spyserver spyserver-rtlsdr
systemctl status spyserver spyserver-rtlsdr --no-pager
```

`rtl_tcp` can serve the RTL-SDR instead (port 8890 here); the clients speak it
too. It and `spyserver-rtlsdr` cannot both hold the dongle, so enable one.

## Verify

```sh
ss -tlnp | grep -E '8888|8889'    # SpyServer listening
journalctl -u spyserver -n 30     # recent log
airspyhf_info                     # confirms the HF+ and its serial
```

From the Mac running Deck RX:

```sh
nc -zv <server-address> 8888      # TCP connect smoke-test
```

## Notes

- The HF+'s gain setting is SpyServer's `SETTING_GAIN` index
  (0..maxGainIndex), which the HF+ maps to LNA bypass and attenuator stages
  rather than a continuous LNA gain.
- SpyServer gives control of a device to the first client and lets the others
  listen; deck-rx says so on screen (LISTEN ONLY) rather than retuning in vain.
