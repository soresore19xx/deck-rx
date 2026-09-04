/*
 *	C surface of the DRM core, for callers that are not C++ — Swift, here.
 *	Nothing in this header is C++, so it can be handed straight to swiftc
 *	with -import-objc-header.
 *
 *	Licence: the core is GPL-2.0-or-later (see README.md); this file is part
 *	of it.
 */

#ifndef	__DRM_BRIDGE__
#define	__DRM_BRIDGE__

#include	<stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DrmHandle DrmHandle;

/*	Both callbacks arrive on the decoder's own worker thread, never on the
 *	thread that called drm_create. Anything touching UI has to hop.
 *
 *	drm_state_cb keys, and what the value looks like:
 *	  timeSync facSync sdcSync faadSync   "yes" / "no"
 *	  mode                                "A".."D"
 *	  spectrum                            "0".."5"
 *	  facMer sdcMer mscMer                a number, one decimal
 *	  service channel_2 channel_3         text off the air
 *	  datacoding                          "QAM16" / "QAM64" ...
 *	  audioMode                           "AAC" / "xHE-AAC"
 *	  aacData                             "24000 mono"
 *	  message                             the running text
 *	  timeText                            the broadcast clock
 *	Only changes are reported; the same value is never sent twice in a row.
 */
typedef void (*drm_state_cb) (void *ctx, const char *key, const char *value);

/*	48000 Hz, stereo, interleaved, -1..1. frames counts sample pairs. */
typedef void (*drm_audio_cb) (void *ctx, const float *pcm, int frames);

DrmHandle	*drm_create	(drm_state_cb, drm_audio_cb, void *ctx);

/*	Input is 12000 Hz complex, interleaved re/im. samples counts the
 *	complex values, so the array holds 2 * samples floats. */
void		drm_feed	(DrmHandle *, const float *iq, int samples);

void		drm_destroy	(DrmHandle *);

/*	Non-zero when the build actually carries the decoder. Lets a caller
 *	that links a stub tell the difference at runtime. */
int		drm_available	(void);

#ifdef __cplusplus
}
#endif
#endif
