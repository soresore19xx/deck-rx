# Server-side setup (SpyServer on Linux)

[← Back to README](../README.md)

Every deck-rx receiver talks to a running SpyServer (or to `rtl_tcp`). The
receivers sit on USB on a Linux machine — a single-board computer, a small PC,
or a Linux VM with the USB devices passed through — and SpyServer publishes
each of them on the LAN on a port of its own.

The deployment these pages are tested against: **Ubuntu 24.04 (aarch64)** in a
VM on a Mac mini (VirtualBuddy, both receivers passed through over USB; see
[A Linux VM on a Mac](#a-linux-vm-on-a-mac-virtualbuddy) for the VM itself),
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

## A Linux VM on a Mac (VirtualBuddy)

Skip this section if the Linux machine is a real one. SpyServer has no macOS
build, so on a Mac it runs in a Linux VM, and the receivers have to reach that
VM over USB.

Tested: Mac mini (M4) on macOS 27.2.1, VirtualBuddy 2.2 beta 5 (build 417),
Ubuntu 24.04.5 arm64 guest.

### Why VirtualBuddy

USB passthrough on Apple's Virtualization framework arrived with macOS 27
(`VZUSBPassthroughDevice`, with the Accessory Access framework handing the
device over). VirtualBuddy implements it from **2.2 beta 4**; the stable 2.1
has no USB passthrough, so this is a beta build. UTM shares USB only on its
QEMU backend (UTM 4.7.5 when this VM was built), not on the Apple backend.

Use the signed release build. Bridged networking needs the
`com.apple.vm.networking` entitlement and USB passthrough needs
`com.apple.developer.accessory-access.usb`; both are granted to VirtualBuddy's
developer, so a fork built and signed by anyone else loses both.

### VM hardware

| item | setting |
| --- | --- |
| type | Linux |
| CPU / memory | 2 vCPU / 2 GB (the guest uses about 270 MB) |
| boot disk | 16 GB |
| network | two NICs, both **Bridge** (one per LAN segment, see below) |
| USB | the receivers, by vendor / product ID |
| sound, shared folders, Rosetta | none |

VirtualBuddy keeps a VM in `~/Library/Application Support/VirtualBuddy/<name>.vbvm`:
the disk is `Disk.img` and the settings are `.vbdata/Config.plist` (a binary
plist). Quit VirtualBuddy before editing that file by hand: a running
VirtualBuddy writes its in-memory settings back on the next boot and the edit
is lost.

### Installing the guest

The usual route is VirtualBuddy's new-VM wizard with the Ubuntu Server 24.04
arm64 ISO (not tried here). The VM tested here was made from the Ubuntu cloud
image instead, which skips the installer:

1. Create the VM bundle: the wizard, quitting VirtualBuddy before the
   installer runs. (The tested VM's bundle was written by hand.)
2. Convert the cloud image (`noble-server-cloudimg-arm64.img`, qcow2) to raw,
   grow it, and put it in place of the bundle's `Disk.img`:
   ```sh
   qemu-img convert -O raw noble-server-cloudimg-arm64.img Disk.img
   qemu-img resize -f raw Disk.img 16G
   ```
   The cloud image is EFI-bootable; the `.tar.gz` variant (a bare ext4) is not.
3. Attach a cloud-init NoCloud seed as a second, read-only storage device: a
   small FAT image labelled `CIDATA` holding `user-data` and `meta-data`. This
   VM's seed sets the host name, one user with an SSH public key, no password
   login over SSH, and installs `avahi-daemon` (so `<hostname>.local`
   resolves) and `usbutils`. Give that user a password for `sudo` rather than
   passwordless sudo.
4. Boot. cloud-init grows the root filesystem to the disk.

The guest runs Ubuntu's own `linux-image-generic` kernel, so `apt` keeps the
kernel current — unlike the vendor kernels some single-board computers ship,
which `apt` cannot upgrade.

### Network

Each NIC is bridged to a host interface (in the VM's network settings, choose
a bridge rather than NAT and pick the Mac's interface). Bridging gives the
guest its own address on the LAN, so clients connect to it directly. This VM
has two NICs,
one on each LAN segment the clients live on, and SpyServer and sshd listen on
`0.0.0.0`, so a client on either segment reaches it without a router in
between, and losing one segment does not cut the VM off.

Addresses are static, set by netplan and matched on the MAC address
VirtualBuddy gives each NIC. cloud-init's network handling is switched off so
it does not write its DHCP config back:

`/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`:

```yaml
network: {config: disabled}
```

`/etc/cloud/cloud.cfg.d/99-hostname.cfg` (keeps a host name changed after the
first boot):

```yaml
preserve_hostname: true
manage_etc_hosts: false
```

`/etc/netplan/60-spyserver.yaml` (mode 600; move cloud-init's
`50-cloud-init.yaml` out of the directory). The addresses here are
documentation examples:

```yaml
network:
  version: 2
  ethernets:
    enp0s1:
      match:
        macaddress: "02:00:00:00:00:01"   # the first NIC's MAC in VirtualBuddy
      set-name: enp0s1
      dhcp4: false
      dhcp6: false
      addresses: [192.0.2.10/24]
      routes:
        - to: default
          via: 192.0.2.1
          metric: 100                     # the default route
      nameservers:
        addresses: [192.0.2.1]
    enp0s2:
      match:
        macaddress: "02:00:00:00:00:02"   # the second NIC's MAC
      set-name: enp0s2
      dhcp4: false
      dhcp6: false
      addresses: [198.51.100.10/24]
      routes:
        - to: default
          via: 198.51.100.1
          metric: 200                     # used only if the first is gone
      nameservers:
        addresses: [198.51.100.1]
```

Apply it with `sudo netplan try` (it rolls back after 120 s unless you
confirm) rather than `netplan apply`: a typo over SSH otherwise cuts the
connection you would fix it through.

### USB passthrough

1. In the VM's settings, under USB, add each receiver (**Choose USB Device**
   with the receiver plugged in, or **Enter USB Device IDs**): Airspy HF+
   `03eb:800c`, RTL-SDR Blog V4 `0bda:2838`.
2. With the VM running, plug the receiver into the Mac. It appears in the menu
   bar's **Virtual Machine Accessories** menu (not in System Settings); assign
   it to VirtualBuddy. VirtualBuddy then attaches it to the VM by its IDs.
3. In the guest, `lsusb` lists the device and `airspyhf_info` / `rtl_test`
   open it.

Once assigned, a receiver goes back to the VM by itself after a Mac restart,
and when it is plugged in while the VM is running. The udev rule further down
restarts its SpyServer when it comes back.

Measured: the HF+ at its full 912 kS/s through the VM (`airspyhf_rx` for
20 s) dropped no samples. Isochronous USB devices are not supported by the
framework; SDR receivers use bulk transfers and are not affected.

Traps, all seen on this VM:

- **Unplugging a passed-through receiver can hang the VM** (ping answers, SSH
  and SpyServer accept and then say nothing). Hand the receiver back to the
  Mac in the Virtual Machine Accessories menu, or shut the VM down, before
  pulling the cable. If it has hung, quit VirtualBuddy by force and boot the
  VM again. Plugging an unrelated USB device into the Mac has hung it once
  too.
- **Shutting the guest down from inside returned both receivers to the Mac**,
  and they stayed there until assigned again in the menu.
- **The menu assigns whatever you pick, not only receivers.** A USB Ethernet
  adapter assigned to VirtualBuddy by mistake disappears from macOS every time
  the VM boots. Assign only the receivers.
- **A USB hub can change the HF+'s levels.** Through one dock the HF+ read
  10 dB lower on every signal (with a 12 dB lower noise floor) than plugged
  into the Mac directly. Compare a known station both ways before settling.

### Starting and stopping

VirtualBuddy has no command-line control and no headless mode: the VM window
always opens, and `open <name>.vbvm` only opens the window without booting.
Booting goes through a deep link, which VirtualBuddy accepts only after
checking the code signature of the process that sent it, so the sender must
still be running; a bare `open "virtualbuddy://…"` exits too early and is
refused. This works:

```sh
osascript -e 'open location "virtualbuddy://boot?name=<VM name>"' -e 'delay 30'
```

The first time, VirtualBuddy asks to approve `osascript` as a client; the
approval is kept across restarts. To start the VM at login, run that from a
login script after launching VirtualBuddy (`open -a VirtualBuddy`). The Mac
has to log a user in automatically, since VirtualBuddy is a GUI app. The
window can then be hidden:

```sh
osascript -e 'tell application "System Events" to set visible of process "VirtualBuddy" to false'
```

`virtualbuddy://stop?name=<VM name>` pulls the power at once. For an
ordinary stop, `sudo poweroff` in the guest first, and expect to assign the
receivers to VirtualBuddy again afterwards (see the traps above).

### Console

There is no serial console; the VM window is the only way in when the guest's
network is down. Its virtual keyboard passes the physical key positions, so
choose the guest's keymap to match the keyboard (`jp106` for a JIS keyboard).
Keys that exist only on JIS keyboards (Yen and Ro, HID International3 and
International1) do not reach the guest at all, which leaves `\`, `|` and `_`
without a key under `jp106`; map them onto keys that do arrive in
`/etc/console-setup/remap.inc` if the console is ever needed. Day-to-day work
goes over SSH.

### Trimming the guest (optional)

None of these are needed by SpyServer; disabling them leaves avahi, cron,
dbus, polkit, rsyslog, ssh, SpyServer, unattended-upgrades and systemd's own
services:

```sh
sudo systemctl disable --now multipathd.service multipathd.socket \
  motd-news.timer update-notifier-download.timer update-notifier-motd.timer \
  sysstat.service sysstat-collect.timer sysstat-summary.timer fwupd-refresh.timer
sudo systemctl mask --now fwupd ModemManager udisks2
```

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
list_in_directory = 0
device_type      = RTL-SDR
device_serial    = 0
rtl_sampling_mode = 0                  # direct sampling off
minimum_frequency = 0
maximum_frequency = 1766000000
```

Leave direct sampling off for the RTL-SDR Blog V4: it upconverts HF itself.
Without the `minimum_frequency` line SpyServer refuses to tune the RTL-SDR
below 24 MHz, so mediumwave and shortwave are out of reach.

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
