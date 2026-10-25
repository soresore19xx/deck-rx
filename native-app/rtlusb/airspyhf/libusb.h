/*
 * The part of libusb-1.0's interface that libairspyhf uses, for the iPad,
 * where there is no libusb: libusb_dext.c implements it on the app's DriverKit
 * driver. Names, types and values follow libusb.h, so airspyhf.c compiles
 * unmodified against it.
 */
#ifndef DECKRX_LIBUSB_H
#define DECKRX_LIBUSB_H

#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/time.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LIBUSB_CALL

typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;

enum libusb_error {
    LIBUSB_SUCCESS = 0,
    LIBUSB_ERROR_IO = -1,
    LIBUSB_ERROR_INVALID_PARAM = -2,
    LIBUSB_ERROR_ACCESS = -3,
    LIBUSB_ERROR_NO_DEVICE = -4,
    LIBUSB_ERROR_NOT_FOUND = -5,
    LIBUSB_ERROR_BUSY = -6,
    LIBUSB_ERROR_TIMEOUT = -7,
    LIBUSB_ERROR_OVERFLOW = -8,
    LIBUSB_ERROR_PIPE = -9,
    LIBUSB_ERROR_INTERRUPTED = -10,
    LIBUSB_ERROR_NO_MEM = -11,
    LIBUSB_ERROR_NOT_SUPPORTED = -12,
    LIBUSB_ERROR_OTHER = -99
};

enum libusb_endpoint_direction {
    LIBUSB_ENDPOINT_OUT = 0x00,
    LIBUSB_ENDPOINT_IN = 0x80
};

enum libusb_request_type {
    LIBUSB_REQUEST_TYPE_STANDARD = (0x00 << 5),
    LIBUSB_REQUEST_TYPE_CLASS = (0x01 << 5),
    LIBUSB_REQUEST_TYPE_VENDOR = (0x02 << 5),
    LIBUSB_REQUEST_TYPE_RESERVED = (0x03 << 5)
};

enum libusb_request_recipient {
    LIBUSB_RECIPIENT_DEVICE = 0x00,
    LIBUSB_RECIPIENT_INTERFACE = 0x01,
    LIBUSB_RECIPIENT_ENDPOINT = 0x02,
    LIBUSB_RECIPIENT_OTHER = 0x03
};

enum libusb_transfer_status {
    LIBUSB_TRANSFER_COMPLETED,
    LIBUSB_TRANSFER_ERROR,
    LIBUSB_TRANSFER_TIMED_OUT,
    LIBUSB_TRANSFER_CANCELLED,
    LIBUSB_TRANSFER_STALL,
    LIBUSB_TRANSFER_NO_DEVICE,
    LIBUSB_TRANSFER_OVERFLOW
};

enum libusb_transfer_type {
    LIBUSB_TRANSFER_TYPE_CONTROL = 0,
    LIBUSB_TRANSFER_TYPE_ISOCHRONOUS = 1,
    LIBUSB_TRANSFER_TYPE_BULK = 2,
    LIBUSB_TRANSFER_TYPE_INTERRUPT = 3
};

enum libusb_option {
    LIBUSB_OPTION_LOG_LEVEL = 0,
    LIBUSB_OPTION_USE_USBDK = 1,
    LIBUSB_OPTION_NO_DEVICE_DISCOVERY = 2
};

struct libusb_device_descriptor {
    uint8_t  bLength;
    uint8_t  bDescriptorType;
    uint16_t bcdUSB;
    uint8_t  bDeviceClass;
    uint8_t  bDeviceSubClass;
    uint8_t  bDeviceProtocol;
    uint8_t  bMaxPacketSize0;
    uint16_t idVendor;
    uint16_t idProduct;
    uint16_t bcdDevice;
    uint8_t  iManufacturer;
    uint8_t  iProduct;
    uint8_t  iSerialNumber;
    uint8_t  bNumConfigurations;
};

struct libusb_transfer;
typedef void (LIBUSB_CALL *libusb_transfer_cb_fn)(struct libusb_transfer *transfer);

struct libusb_transfer {
    libusb_device_handle *dev_handle;
    uint8_t flags;
    unsigned char endpoint;
    unsigned char type;
    unsigned int timeout;
    enum libusb_transfer_status status;
    int length;
    int actual_length;
    libusb_transfer_cb_fn callback;
    void *user_data;
    unsigned char *buffer;
    int num_iso_packets;
    /* the stand-in's own bookkeeping */
    int deckrx_state;
};

int  libusb_init(libusb_context **ctx);
void libusb_exit(libusb_context *ctx);
int  libusb_set_option(libusb_context *ctx, enum libusb_option option, ...);

ssize_t libusb_get_device_list(libusb_context *ctx, libusb_device ***list);
void libusb_free_device_list(libusb_device **list, int unref_devices);
int  libusb_get_device_descriptor(libusb_device *dev, struct libusb_device_descriptor *desc);
int  libusb_open(libusb_device *dev, libusb_device_handle **dev_handle);
void libusb_close(libusb_device_handle *dev_handle);
int  libusb_wrap_sys_device(libusb_context *ctx, intptr_t sys_dev, libusb_device_handle **dev_handle);
int  libusb_get_string_descriptor_ascii(libusb_device_handle *dev_handle, uint8_t desc_index,
                                        unsigned char *data, int length);

int  libusb_set_configuration(libusb_device_handle *dev_handle, int configuration);
int  libusb_claim_interface(libusb_device_handle *dev_handle, int interface_number);
int  libusb_release_interface(libusb_device_handle *dev_handle, int interface_number);
int  libusb_set_interface_alt_setting(libusb_device_handle *dev_handle, int interface_number,
                                      int alternate_setting);
int  libusb_clear_halt(libusb_device_handle *dev_handle, unsigned char endpoint);

int  libusb_control_transfer(libusb_device_handle *dev_handle, uint8_t request_type,
                             uint8_t bRequest, uint16_t wValue, uint16_t wIndex,
                             unsigned char *data, uint16_t wLength, unsigned int timeout);

struct libusb_transfer *libusb_alloc_transfer(int iso_packets);
void libusb_free_transfer(struct libusb_transfer *transfer);
int  libusb_submit_transfer(struct libusb_transfer *transfer);
int  libusb_cancel_transfer(struct libusb_transfer *transfer);
int  libusb_handle_events_timeout_completed(libusb_context *ctx, struct timeval *tv, int *completed);
void libusb_interrupt_event_handler(libusb_context *ctx);

static inline void libusb_fill_bulk_transfer(struct libusb_transfer *transfer,
    libusb_device_handle *dev_handle, unsigned char endpoint, unsigned char *buffer,
    int length, libusb_transfer_cb_fn callback, void *user_data, unsigned int timeout)
{
    transfer->dev_handle = dev_handle;
    transfer->endpoint = endpoint;
    transfer->type = LIBUSB_TRANSFER_TYPE_BULK;
    transfer->timeout = timeout;
    transfer->buffer = buffer;
    transfer->length = length;
    transfer->user_data = user_data;
    transfer->callback = callback;
}

#ifdef __cplusplus
}
#endif

#endif /* DECKRX_LIBUSB_H */
