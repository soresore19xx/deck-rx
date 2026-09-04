/*
 *	Part of the headless DRM core extracted from JvanKatwijk/drm-receiver.
 *	Original decoder (C) Jan van Katwijk, GPL-2.0-or-later; this file is
 *	new and carries the same licence as the code it is built into.
 *
 *	Everything the decoder used Qt for was reporting its own state to a
 *	window: sync lamps, MER readouts, the station name, the running text.
 *	Not one signal carried DSP data. So Qt comes out and this takes its
 *	place — one struct of callbacks, set once by whoever embeds the core.
 *
 *	Every callback may be left empty; the decoder never inspects them.
 *
 *	THREADING: these are called from the decoder's own worker thread, not
 *	from whatever thread built the object. Qt used to queue them onto the
 *	GUI thread on the caller's behalf; nothing does that here, so an
 *	embedder that touches UI in them has to hop threads itself.
 */

#ifndef	__DRM_UI__
#define	__DRM_UI__

#include	<functional>
#include	<string>

struct	drmUI {
//	the three sync lamps, plus the audio decoder's own
	std::function<void (bool)>		timeSync;
	std::function<void (bool)>		facSync;
	std::function<void (bool)>		sdcSync;
	std::function<void (bool)>		faadSync;

//	1..4 = mode A..D, and the spectrum occupancy 0..5
	std::function<void (int)>		mode;
	std::function<void (int)>		spectrum;

//	modulation error ratios and the two frequency offsets, in Hz
	std::function<void (float)>		facMer;
	std::function<void (float)>		sdcMer;
	std::function<void (float)>		mscMer;
	std::function<void (float)>		fineOffset;
	std::function<void (float)>		coarseOffset;

//	text the receiver picks up off the air
	std::function<void (const std::string &)>	service;	// channel 1
	std::function<void (const std::string &)>	channel_2;
	std::function<void (const std::string &)>	channel_3;
	std::function<void (const std::string &)>	channel_4;
	std::function<void (const std::string &)>	datacoding;
	std::function<void (const std::string &)>	audioMode;
	std::function<void (const std::string &)>	aacData;
	std::function<void (const std::string &)>	message;
	std::function<void (const std::string &)>	timeText;

//	"there is PCM in the ring buffer you handed us"
	std::function<void ()>			audioAvailable;
};

#endif
