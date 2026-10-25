/*
 * Opens the app driver's user client for one USB device. The driver serves
 * every device it matches under the same service name (RTL_SDR), so with a V4
 * and an HF+ plugged in together "the first service" can be either; this asks
 * each one which device it drives.
 */
#ifndef DECKRX_USB_OPEN_H
#define DECKRX_USB_OPEN_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* A connection to the service driving vid:pid (pid 0 = any of the vendor's),
 * or 0 when none is present. Close it with rtlsdrhost_close. */
uint32_t deckrx_usb_open(uint16_t vid, uint16_t pid);

/* Whether such a service is present, without opening it for long. */
int deckrx_usb_present(uint16_t vid, uint16_t pid);

/* The HF+ stream's losses since it started, for the diagnostics line: bytes
 * the driver dropped because the app was behind, and bytes the libusb
 * stand-in skipped when lapped. Defined in airspyhf/libusb_dext.c, so only in
 * a build that carries the HF+. */
void deckrx_hf_stats(uint64_t *ringDrop, uint64_t *lapped);

/* libairspyhf with airspyhf.patch: skip the zero-IF IQ correction (broadcast
 * FM), or run it again. Only in a build that carries the HF+. */
void airspyhf_deckrx_skip_iq_balancer(int skip);

#ifdef __cplusplus
}
#endif

#endif /* DECKRX_USB_OPEN_H */
