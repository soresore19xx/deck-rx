/*
 * What rtlusb/airspyhf.patch adds to libairspyhf, for builds that compile the
 * patched library (the Mac's Solo, when rtlusb/build-driver.sh has fetched
 * it). The iPad build declares the same in usb_open.h.
 */
#ifndef DECKRX_AIRSPYHF_H
#define DECKRX_AIRSPYHF_H

#ifdef __cplusplus
extern "C" {
#endif

/* Skip the zero-IF IQ correction (broadcast FM), or run it again. */
void airspyhf_deckrx_skip_iq_balancer(int skip);

#ifdef __cplusplus
}
#endif

#endif /* DECKRX_AIRSPYHF_H */
