/*
 * libusb, as far as libairspyhf needs it, on the app's DriverKit driver.
 *
 * libairspyhf is the Airspy HF+'s own library: it knows the device's commands,
 * its sample-rate table, its calibration and its IQ correction, and the Mac
 * app links it as it is. On the iPad there is no libusb, so this file is the
 * libusb it is linked against. Control transfers go to the driver one by one
 * (kRTLSDRMethodControlTransfer). The stream is not transfer by transfer: the
 * driver keeps the bulk endpoint busy itself and writes what arrives into the
 * shared ring the RTL-SDR uses too, and the "transfers" libairspyhf submits
 * are filled from that ring, oldest first, a whole transfer at a time.
 *
 * One device: the HF+. libairspyhf opens it with the serial unused, so the
 * descriptor here has no serial string.
 */
#include "libusb.h"

#include <IOKit/IOKitLib.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "RTLSDRShared.h"
#include "RTLSDRBridge.h"
#include "usb_open.h"

enum { kQueued = 1, kCancelled = 2 };
#define MAX_QUEUED 64

struct libusb_context { int unused; };
struct libusb_device { uint16_t vid, pid; };
struct libusb_device_handle {
    uint32_t                conn;
    RTLSDRRingBuffer       *ring;
    uint64_t                cursor;     /* next ring byte to hand out     */
    int                     streaming;  /* the driver's stream is running */
    pthread_mutex_t         lock;
    struct libusb_transfer *queue[MAX_QUEUED];
    int                     count;
};

static struct libusb_context g_ctx;
static struct libusb_device  g_hfplus = { RTLSDR_AIRSPYHF_VID, RTLSDR_AIRSPYHF_PID };
/* The open handle the event loop serves. libairspyhf opens one device. */
static libusb_device_handle *g_handle;
/* Guards g_handle where another thread reads it (deckrx_hf_stats, from the
 * app's diagnostics timer) against libusb_close freeing it and unmapping its
 * ring under that read. */
static pthread_mutex_t g_handle_lock = PTHREAD_MUTEX_INITIALIZER;

/* Bytes skipped because the driver had lapped this reader, since start. */
static uint64_t g_lapped;

void deckrx_hf_stats(uint64_t *ringDrop, uint64_t *lapped)
{
    pthread_mutex_lock(&g_handle_lock);
    libusb_device_handle *h = g_handle;
    if (ringDrop) *ringDrop = (h && h->ring) ? h->ring->dropCount : 0;
    pthread_mutex_unlock(&g_handle_lock);
    if (lapped) *lapped = __atomic_load_n(&g_lapped, __ATOMIC_RELAXED);
}


int libusb_init(libusb_context **ctx) { if (ctx) *ctx = &g_ctx; return 0; }
void libusb_exit(libusb_context *ctx) { (void)ctx; }
int libusb_set_option(libusb_context *ctx, enum libusb_option option, ...)
{
    (void)ctx; (void)option;
    return 0;
}

ssize_t libusb_get_device_list(libusb_context *ctx, libusb_device ***list)
{
    (void)ctx;
    libusb_device **l = calloc(2, sizeof(*l));
    if (!l)
        return LIBUSB_ERROR_NO_MEM;
    ssize_t n = 0;
    /* Already open counts as present: the driver serves one client. */
    if (g_handle || deckrx_usb_present(g_hfplus.vid, g_hfplus.pid))
        l[n++] = &g_hfplus;
    *list = l;
    return n;
}

void libusb_free_device_list(libusb_device **list, int unref) { (void)unref; free(list); }

int libusb_get_device_descriptor(libusb_device *dev, struct libusb_device_descriptor *d)
{
    memset(d, 0, sizeof(*d));
    d->bLength = 18;
    d->bDescriptorType = 1;
    d->idVendor = dev->vid;
    d->idProduct = dev->pid;
    d->bNumConfigurations = 1;
    return 0;
}

int libusb_open(libusb_device *dev, libusb_device_handle **out)
{
    *out = NULL;
    if (g_handle)
        return LIBUSB_ERROR_BUSY;
    uint32_t conn = deckrx_usb_open(dev->vid, dev->pid);
    if (!conn)
        return LIBUSB_ERROR_NO_DEVICE;
    uint64_t size = 0;
    RTLSDRRingBuffer *ring = rtlsdrhost_map_memory(conn, kRTLSDRMemoryTypeIQRing, &size);
    if (!ring || size < sizeof(RTLSDRRingBuffer)) {
        rtlsdrhost_close(conn);
        return LIBUSB_ERROR_IO;
    }
    libusb_device_handle *h = calloc(1, sizeof(*h));
    if (!h) {
        rtlsdrhost_close(conn);
        return LIBUSB_ERROR_NO_MEM;
    }
    h->conn = conn;
    h->ring = ring;
    pthread_mutex_init(&h->lock, NULL);
    pthread_mutex_lock(&g_handle_lock);
    g_handle = h;
    pthread_mutex_unlock(&g_handle_lock);
    *out = h;
    return 0;
}

static void stop_stream(libusb_device_handle *h)
{
    if (h->streaming) {
        uint64_t out = 0;
        rtlsdrhost_call(h->conn, kRTLSDRMethodStopStream, 0, &out);
        h->streaming = 0;
    }
}

void libusb_close(libusb_device_handle *h)
{
    if (!h)
        return;
    pthread_mutex_lock(&h->lock);
    stop_stream(h);
    pthread_mutex_unlock(&h->lock);
    /* Unpublished before the connection (and with it the ring's mapping)
     * goes, so the stats never read a ring that is being unmapped. */
    pthread_mutex_lock(&g_handle_lock);
    if (g_handle == h)
        g_handle = NULL;
    pthread_mutex_unlock(&g_handle_lock);
    rtlsdrhost_close(h->conn);
    pthread_mutex_destroy(&h->lock);
    free(h);
}

int libusb_wrap_sys_device(libusb_context *ctx, intptr_t fd, libusb_device_handle **h)
{
    (void)ctx; (void)fd; (void)h;
    return LIBUSB_ERROR_NOT_SUPPORTED;
}

int libusb_get_string_descriptor_ascii(libusb_device_handle *h, uint8_t i,
                                       unsigned char *data, int length)
{
    (void)h; (void)i; (void)data; (void)length;
    return LIBUSB_ERROR_NOT_SUPPORTED;
}

/* The driver selects the configuration and the alternate setting itself. */
int libusb_set_configuration(libusb_device_handle *h, int c) { (void)h; (void)c; return 0; }
int libusb_claim_interface(libusb_device_handle *h, int i) { (void)h; (void)i; return 0; }
int libusb_release_interface(libusb_device_handle *h, int i) { (void)h; (void)i; return 0; }
int libusb_set_interface_alt_setting(libusb_device_handle *h, int i, int a)
{
    (void)h; (void)i; (void)a;
    return 0;
}

int libusb_clear_halt(libusb_device_handle *h, unsigned char endpoint)
{
    (void)endpoint;
    uint64_t out = 0;
    return rtlsdrhost_call(h->conn, kRTLSDRMethodClearHalt, 0, &out) == 0 ? 0 : LIBUSB_ERROR_IO;
}

int libusb_control_transfer(libusb_device_handle *h, uint8_t type, uint8_t req,
                            uint16_t value, uint16_t index, unsigned char *data,
                            uint16_t length, unsigned int timeout)
{
    if (length > RTLSDR_CONTROL_MAX_DATA)
        return LIBUSB_ERROR_INVALID_PARAM;
    const int isIn = (type & 0x80) != 0;
    uint8_t in[sizeof(RTLSDRControlSetup) + RTLSDR_CONTROL_MAX_DATA];
    RTLSDRControlSetup s = { type, req, value, index, length, timeout };
    memcpy(in, &s, sizeof(s));
    size_t inLen = sizeof(s);
    if (!isIn && length) {
        memcpy(in + sizeof(s), data, length);
        inLen += length;
    }
    uint64_t got = 0;
    uint32_t gotCount = 1;
    uint8_t outBuf[RTLSDR_CONTROL_MAX_DATA];
    size_t outLen = isIn ? length : 0;
    kern_return_t kr = IOConnectCallMethod((io_connect_t)h->conn, kRTLSDRMethodControlTransfer,
                                           NULL, 0, in, inLen, &got, &gotCount,
                                           isIn ? outBuf : NULL, isIn ? &outLen : NULL);
    if (kr != KERN_SUCCESS)
        return LIBUSB_ERROR_PIPE;
    if (isIn) {
        size_t n = outLen < length ? outLen : length;
        if (n)
            memcpy(data, outBuf, n);
        return (int)n;
    }
    return (int)got;
}

struct libusb_transfer *libusb_alloc_transfer(int iso_packets)
{
    (void)iso_packets;
    return calloc(1, sizeof(struct libusb_transfer));
}

void libusb_free_transfer(struct libusb_transfer *t) { free(t); }

int libusb_submit_transfer(struct libusb_transfer *t)
{
    libusb_device_handle *h = t->dev_handle ? t->dev_handle : g_handle;
    if (!h)
        return LIBUSB_ERROR_NO_DEVICE;
    t->dev_handle = h;
    pthread_mutex_lock(&h->lock);
    if (h->count >= MAX_QUEUED) {
        pthread_mutex_unlock(&h->lock);
        return LIBUSB_ERROR_BUSY;
    }
    if (!h->streaming) {
        uint64_t out = 0;
        /* From now: what the ring held belongs to an earlier stream. */
        h->cursor = h->ring->writeCount;
        if (rtlsdrhost_call(h->conn, kRTLSDRMethodStartStream, 0, &out) != 0) {
            pthread_mutex_unlock(&h->lock);
            return LIBUSB_ERROR_IO;
        }
        h->streaming = 1;
    }
    t->deckrx_state = kQueued;
    h->queue[h->count++] = t;
    pthread_mutex_unlock(&h->lock);
    return 0;
}

int libusb_cancel_transfer(struct libusb_transfer *t)
{
    libusb_device_handle *h = t->dev_handle ? t->dev_handle : g_handle;
    if (!h)
        return LIBUSB_ERROR_NOT_FOUND;
    pthread_mutex_lock(&h->lock);
    int found = 0;
    for (int i = 0; i < h->count; i++)
        if (h->queue[i] == t) { t->deckrx_state = kCancelled; found = 1; }
    pthread_mutex_unlock(&h->lock);
    return found ? 0 : LIBUSB_ERROR_NOT_FOUND;
}

/* Under the lock: takes `t` out of the queue. */
static void unqueue(libusb_device_handle *h, int i)
{
    memmove(&h->queue[i], &h->queue[i + 1], (size_t)(h->count - i - 1) * sizeof(h->queue[0]));
    h->count--;
}

/* Hands out what is ready: cancelled transfers, then filled ones in order.
 * Callbacks run outside the lock, as they resubmit. Returns how many. */
static int deliver(libusb_device_handle *h)
{
    int done = 0;
    for (;;) {
        struct libusb_transfer *t = NULL;
        pthread_mutex_lock(&h->lock);
        for (int i = 0; i < h->count; i++) {
            if (h->queue[i]->deckrx_state == kCancelled) {
                t = h->queue[i];
                unqueue(h, i);
                t->status = LIBUSB_TRANSFER_CANCELLED;
                t->actual_length = 0;
                break;
            }
        }
        if (!t && h->count > 0) {
            struct libusb_transfer *head = h->queue[0];
            RTLSDRRingBuffer *ring = h->ring;
            uint64_t w = ring->writeCount;
            uint64_t size = ring->dataSize ? ring->dataSize : RTLSDR_RING_DATA_SIZE;
            if (w - h->cursor > size) {         /* lapped: skip to what is left */
                __atomic_fetch_add(&g_lapped, (w - size) - h->cursor, __ATOMIC_RELAXED);
                h->cursor = w - size;
            }
            if (w - h->cursor >= (uint64_t)head->length) {
                uint64_t off = h->cursor % size;
                uint64_t first = size - off;
                if (first > (uint64_t)head->length)
                    first = (uint64_t)head->length;
                memcpy(head->buffer, ring->data + off, (size_t)first);
                if ((uint64_t)head->length > first)
                    memcpy(head->buffer + first, ring->data, (size_t)(head->length - first));
                h->cursor += (uint64_t)head->length;
                ring->readCount = h->cursor;
                t = head;
                unqueue(h, 0);
                t->status = LIBUSB_TRANSFER_COMPLETED;
                t->actual_length = t->length;
            }
        }
        if (!t && h->count == 0)
            stop_stream(h);                     /* everything cancelled */
        pthread_mutex_unlock(&h->lock);
        if (!t)
            return done;
        t->deckrx_state = 0;
        done++;
        if (t->callback)
            t->callback(t);
    }
}

int libusb_handle_events_timeout_completed(libusb_context *ctx, struct timeval *tv, int *completed)
{
    (void)ctx; (void)completed;
    libusb_device_handle *h = g_handle;
    if (!h)
        return LIBUSB_ERROR_NO_DEVICE;
    long waitUs = tv ? tv->tv_sec * 1000000L + tv->tv_usec : 0;
    long slept = 0;
    for (;;) {
        if (deliver(h) > 0)
            return 0;
        if (slept >= waitUs)
            return 0;
        /* The driver fills the ring every few ms; 1 ms is well under one
         * transfer at any HF+ rate (16 KiB = 4.5 ms at 912 kS/s). */
        usleep(1000);
        slept += 1000;
    }
}

void libusb_interrupt_event_handler(libusb_context *ctx) { (void)ctx; }
