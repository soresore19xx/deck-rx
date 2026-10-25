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

#ifdef __cplusplus
}
#endif

#endif /* DECKRX_USB_OPEN_H */
