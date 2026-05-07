# Server-side setup (SpyServer on Linux ARM/aarch64)

[← Back to README](../README.md)

The plugin talks to a running SpyServer. The reference deployment is an
Airspy HF+ Discovery on a NanoPi Zero2 (aarch64) running Ubuntu 24.04, with
SpyServer published on the LAN at port 8888.

## Hardware

- Airspy HF+ Discovery (USB ID `03eb:800c`) — covers DC..31 MHz + 60..260 MHz
- Linux SBC reachable from the Mac (NanoPi Zero2 / Raspberry Pi / etc.)
- Antenna appropriate for the bands you care about (MW loop, SW long-wire, FM stub, …)

## Dependencies

```sh
sudo apt update
sudo apt install -y libusb-1.0-0 libairspyhf1
# Optional userspace tool used to verify the device is detected
sudo apt install -y airspyhf-tools  # provides airspyhf_info
```

The HF+ ships an upstream `libairspyhf1` (1.6.8 in Ubuntu 24.04) which is
the runtime SpyServer dlopens for Airspy HF+ devices.

## udev rule

Without a udev rule the device is owned by root and SpyServer can't open
it as a non-root service user.

`/etc/udev/rules.d/52-airspyhf.rules`:

```
ATTR{idVendor}=="03eb", ATTR{idProduct}=="800c", SYMLINK+="airspyhf-%k", MODE="660", GROUP="plugdev", TAG+="uaccess"
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

SpyServer is a closed-source binary distribution from Airspy. Download the
ARM64 build from <https://airspy.com/download/> ("airspyserver-arm64-…tar.gz")
and place the binary plus default config:

```sh
sudo install -m 755 spyserver /usr/local/bin/spyserver
sudo install -m 644 spyserver.config /usr/local/etc/spyserver.config
```

## Config

`/usr/local/etc/spyserver.config` (key fields, comments stripped):

```ini
bind_host        = 0.0.0.0
bind_port        = 8888-9000           # picks first free port in range
list_in_directory = 1
maximum_clients  = 3
allow_control    = 1
device_type      = AirspyHF+
device_serial    = 0xXXXXXXXXXXXXXXXX  # adjust to your device
fft_fps          = 20
fft_bin_bits     = 16
input_buffer_size_ms = 10
input_buffer_count   = 4
output_buffer_size_ms = 30
```

`device_serial` is shown by `airspyhf_info`.

## systemd service

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

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now spyserver
systemctl status spyserver --no-pager
```

## Verify

```sh
ss -tlnp | grep 8888              # SpyServer listening
journalctl -u spyserver -n 30     # recent log
airspyhf_info                      # confirms device + serial
```

From the Mac running Deck RX:

```sh
nc -zv <server-ip> 8888           # TCP connect smoke-test
```

## Notes / gotchas

- If the system runs `apt-daily-upgrade`, the package manager's
  `systemd daemon-reexec` can occasionally tear down USB binfmt state on
  boards using Rosetta or other binfmt translators; SpyServer survives
  this on a pure aarch64 host but fails on x64 binaries running under
  Rosetta. The reference deployment is native aarch64 to avoid this.
- The HF+ has on-chip AGC / preamp; the Stream Deck "Gain" dial controls
  SpyServer's `SETTING_GAIN` index (0..maxGainIndex) which the HF+ maps
  to LNA bypass + attenuator stages rather than continuous LNA gain.
