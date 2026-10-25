#include "usb_open.h"

#include <IOKit/IOKitLib.h>
#include <string.h>

#include "RTLSDRShared.h"
#include "RTLSDRBridge.h"

uint32_t deckrx_usb_open(uint16_t vid, uint16_t pid)
{
    io_iterator_t it = IO_OBJECT_NULL;
    if (IOServiceGetMatchingServices(0, IOServiceNameMatching("RTL_SDR"), &it) != KERN_SUCCESS)
        return 0;
    io_connect_t found = IO_OBJECT_NULL;
    io_service_t service;
    while (found == IO_OBJECT_NULL && (service = IOIteratorNext(it)) != IO_OBJECT_NULL) {
        io_connect_t c = IO_OBJECT_NULL;
        kern_return_t kr = IOServiceOpen(service, mach_task_self_, 0, &c);
        IOObjectRelease(service);
        if (kr != KERN_SUCCESS)
            continue;
        RTLSDRDeviceInfo info;
        size_t size = sizeof(info);
        memset(&info, 0, sizeof(info));
        if (rtlsdrhost_get_struct((uint32_t)c, kRTLSDRMethodGetDeviceInfo, &info, &size) == 0
            && size >= sizeof(info)
            && info.idVendor == vid && (pid == 0 || info.idProduct == pid)) {
            found = c;
        } else {
            IOServiceClose(c);
        }
    }
    IOObjectRelease(it);
    return (uint32_t)found;
}

int deckrx_usb_present(uint16_t vid, uint16_t pid)
{
    uint32_t c = deckrx_usb_open(vid, pid);
    if (!c)
        return 0;
    rtlsdrhost_close(c);
    return 1;
}
