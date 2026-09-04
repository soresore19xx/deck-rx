/*
 *	Implementation of the C surface. Owns the ring buffer the decoder writes
 *	its audio into, and turns the drmUI callbacks into key/value strings so
 *	a caller needs no C++ types at all.
 *
 *	Licence: GPL-2.0-or-later, with the rest of the core.
 */

#include	"drm_bridge.h"

#include	<complex>
#include	<map>
#include	<mutex>
#include	<string>
#include	<vector>

#include	"ringbuffer.h"
#include	"drm-ui.h"
#include	"drm-decoder.h"

struct	DrmHandle {
	RingBuffer<std::complex<float>>	audio;
	drm_state_cb			onState;
	drm_audio_cb			onAudio;
	void				*ctx;
//	Deduplication lives here rather than in the caller: the decoder reports
//	the same MER and the same station name many times a second, and a Swift
//	closure per repeat is pure waste.
	std::map<std::string, std::string> last;
	std::mutex			lastLock;
	std::vector<float>		pcm;
	drmDecoder			*dec;

		DrmHandle () : audio (32768), onState (nullptr),
		               onAudio (nullptr), ctx (nullptr), dec (nullptr) {}

	void	say (const char *key, const std::string &value) {
	   if (onState == nullptr)
	      return;
	   {
	      std::lock_guard<std::mutex> g (lastLock);
	      auto it = last. find (key);
	      if (it != last. end () && it -> second == value)
	         return;
	      last [key] = value;
	   }
	   onState (ctx, key, value. c_str ());
	}

	void	sayBool (const char *key, bool v) {
	   say (key, v ? "yes" : "no");
	}

	void	sayFloat (const char *key, float v) {
	   char b [32];
	   snprintf (b, sizeof (b), "%.1f", v);
	   say (key, b);
	}

	void	drain () {
	   if (onAudio == nullptr) {
//	Nobody wants the audio, but the buffer still has to be emptied or the
//	decoder writes into a full ring for the rest of the session.
	      std::complex<float> sink [1024];
	      while (audio. GetRingBufferReadAvailable () >= 1024)
	         audio. getDataFromBuffer (sink, 1024);
	      return;
	   }
	   std::complex<float> buf [1024];
	   while (audio. GetRingBufferReadAvailable () >= 1024) {
	      audio. getDataFromBuffer (buf, 1024);
	      pcm. resize (2048);
	      for (int i = 0; i < 1024; i ++) {
	         pcm [2 * i]	 = real (buf [i]);
	         pcm [2 * i + 1] = imag (buf [i]);
	      }
	      onAudio (ctx, pcm. data (), 1024);
	   }
	}
};

DrmHandle	*drm_create (drm_state_cb onState,
	                     drm_audio_cb onAudio,
	                     void *ctx) {
	DrmHandle *h	= new DrmHandle ();
	h -> onState	= onState;
	h -> onAudio	= onAudio;
	h -> ctx	= ctx;

	drmUI ui;
	ui. timeSync	= [h] (bool v) { h -> sayBool ("timeSync", v); };
	ui. facSync	= [h] (bool v) { h -> sayBool ("facSync",  v); };
	ui. sdcSync	= [h] (bool v) { h -> sayBool ("sdcSync",  v); };
	ui. faadSync	= [h] (bool v) { h -> sayBool ("faadSync", v); };
	ui. mode	= [h] (int l)  { h -> say ("mode",
	                                   std::string (1, (char)('A' + l - 1))); };
	ui. spectrum	= [h] (int l)  { h -> say ("spectrum", std::to_string (l)); };
	ui. facMer	= [h] (float v) { h -> sayFloat ("facMer", v); };
	ui. sdcMer	= [h] (float v) { h -> sayFloat ("sdcMer", v); };
	ui. mscMer	= [h] (float v) { h -> sayFloat ("mscMer", v); };
	ui. service	= [h] (const std::string &s) { h -> say ("service", s); };
	ui. channel_2	= [h] (const std::string &s) { h -> say ("channel_2", s); };
	ui. channel_3	= [h] (const std::string &s) { h -> say ("channel_3", s); };
	ui. datacoding	= [h] (const std::string &s) { h -> say ("datacoding", s); };
	ui. audioMode	= [h] (const std::string &s) { h -> say ("audioMode", s); };
	ui. aacData	= [h] (const std::string &s) { h -> say ("aacData", s); };
	ui. message	= [h] (const std::string &s) { h -> say ("message", s); };
	ui. timeText	= [h] (const std::string &s) { h -> say ("timeText", s); };
	ui. audioAvailable = [h] () { h -> drain (); };

	h -> dec = new drmDecoder (ui, &h -> audio);
	return h;
}

void	drm_feed (DrmHandle *h, const float *iq, int samples) {
	if ((h == nullptr) || (h -> dec == nullptr) || (samples <= 0))
	   return;
//	std::complex<float> is required to be layout-compatible with two floats,
//	so the caller's interleaved array is already the right shape.
	h -> dec -> processBuffer
	              ((std::complex<float> *)(const void *)iq, samples);
}

void	drm_destroy (DrmHandle *h) {
	if (h == nullptr)
	   return;
	delete h -> dec;
	delete h;
}

int	drm_available (void) {
	return 1;
}
