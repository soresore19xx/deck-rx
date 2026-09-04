/*
 *	Harness for the headless DRM core. Reads a recording, tunes it, and
 *	prints what the decoder reports — no Qt, no window, no sound card.
 *
 *	This is the regression test for the Qt strip: the reference run is the
 *	GUI app on 2026-09-04 decoding DW_ModeB_10kHz.wav, which reported
 *	facSync/sdcSync yes, service "DW DRM", QAM64, AAC 24000 mono, and the
 *	Sines relay-station text. The lines below are printed in the same
 *	"STATE key = value" shape so the two runs diff directly.
 *
 *	usage: drm-cli <file.wav> [offsetHz]
 *	  offsetHz   where the DRM block sits in the recording; the usual
 *	             sample files put it at 12000, which is the default.
 *	env:
 *	  DRM_SPEED      feed rate as a multiple of real time (default 1.0)
 *	  DRM_AUDIO_OUT  write the decoded 48 kHz stereo to this wav
 */

#include	<cstdio>
#include	<cstdlib>
#include	<cstring>
#include	<cmath>
#include	<string>
#include	<vector>
#include	<complex>
#include	<thread>
#include	<chrono>
#include	<map>

#include	<sndfile.h>
#include	<samplerate.h>

#include	"ringbuffer.h"
#include	"fir-filters.h"
#include	"drm-ui.h"
#include	"drm-decoder.h"

#define	WORK_RATE	48000		// what we resample the file to
#define	DECIMATION	4		// 48000 / 4 = 12000 = WORKING_RATE

//	Only changes are printed. A run of any length then stays short enough
//	to read, and a diff against the reference shows real differences
//	instead of repetition.
static std::map<std::string, std::string> lastValue;

static void say (const char *key, const std::string &val) {
	auto it = lastValue. find (key);
	if (it != lastValue. end () && it -> second == val)
	   return;
	lastValue [key] = val;
	fprintf (stdout, "STATE %s = %s\n", key, val. c_str ());
	fflush (stdout);
}

static void sayF (const char *key, float v) {
	char b [32];
	snprintf (b, sizeof (b), "%.1f", v);
	say (key, b);
}

//	Reads the file, converts to mono float at WORK_RATE.
static bool loadFile (const char *name, std::vector<float> &out, int &rate) {
SF_INFO	info;
	memset (&info, 0, sizeof (info));
	SNDFILE *f = sf_open (name, SFM_READ, &info);
	if (f == nullptr) {
	   fprintf (stderr, "cannot open %s: %s\n", name, sf_strerror (nullptr));
	   return false;
	}
	fprintf (stderr, "in: %s  %lld frames @ %d Hz, %d channel(s)\n",
	                  name, (long long)info. frames,
	                  info. samplerate, info. channels);

	std::vector<float> raw (info. frames * info. channels);
	sf_readf_float (f, raw. data (), info. frames);
	sf_close (f);

//	mono
	std::vector<float> mono (info. frames);
	for (sf_count_t i = 0; i < info. frames; i ++) {
	   float s = 0;
	   for (int c = 0; c < info. channels; c ++)
	      s += raw [i * info. channels + c];
	   mono [i] = s / info. channels;
	}

	if (info. samplerate == WORK_RATE) {
	   out = mono;
	   rate = WORK_RATE;
	   return true;
	}

//	libsamplerate, the same library the GUI app uses for this step
	double ratio = (double)WORK_RATE / info. samplerate;
	out. resize ((size_t)(mono. size () * ratio) + 16);
	SRC_DATA d;
	memset (&d, 0, sizeof (d));
	d. data_in	= mono. data ();
	d. input_frames	= mono. size ();
	d. data_out	= out. data ();
	d. output_frames = out. size ();
	d. src_ratio	= ratio;
	int e = src_simple (&d, SRC_SINC_FASTEST, 1);
	if (e != 0) {
	   fprintf (stderr, "resample failed: %s\n", src_strerror (e));
	   return false;
	}
	out. resize (d. output_frames_gen);
	fprintf (stderr, "resampled %d -> %d Hz (%zu samples)\n",
	                  info. samplerate, WORK_RATE, out. size ());
	rate = WORK_RATE;
	return true;
}

int	main (int argc, char **argv) {
	if (argc < 2) {
	   fprintf (stderr, "usage: %s <file.wav> [offsetHz]\n", argv [0]);
	   return 2;
	}
	const char *inFile = argv [1];
	int offsetHz = argc > 2 ? atoi (argv [2]) : 12000;
	double speed = getenv ("DRM_SPEED") ? atof (getenv ("DRM_SPEED")) : 1.0;
	if (speed <= 0)
	   speed = 1.0;
	const char *audioOutName = getenv ("DRM_AUDIO_OUT");
//	DRM_IQ_OUT writes what the decoder is actually fed, at 12 kHz complex,
//	so the front end can be checked apart from the decoder.
	const char *iqOutName = getenv ("DRM_IQ_OUT");

	std::vector<float> samples;
	int rate = 0;
	if (!loadFile (inFile, samples, rate))
	   return 1;
	fprintf (stderr, "tuning %d Hz off centre, feeding at %.1fx real time\n",
	                  offsetHz, speed);

	RingBuffer<std::complex<float>> audioBuffer (32768);

	SNDFILE *audioOut = nullptr;
	if (audioOutName != nullptr) {
	   SF_INFO o;
	   memset (&o, 0, sizeof (o));
	   o. samplerate	= 48000;
	   o. channels		= 2;
	   o. format		= SF_FORMAT_WAV | SF_FORMAT_PCM_16;
	   audioOut = sf_open (audioOutName, SFM_WRITE, &o);
	   if (audioOut == nullptr)
	      fprintf (stderr, "cannot write %s\n", audioOutName);
	}

	long audioFrames = 0;

	drmUI ui;
	ui. timeSync	= [] (bool f) { say ("timeSync", f ? "yes" : "no"); };
	ui. facSync	= [] (bool f) { say ("facSync",  f ? "yes" : "no"); };
	ui. sdcSync	= [] (bool f) { say ("sdcSync",  f ? "yes" : "no"); };
	ui. faadSync	= [] (bool f) { say ("faadSync", f ? "yes" : "no"); };
	ui. mode	= [] (int l)  { say ("mode", std::string (1, (char)('A' + l - 1))); };
	ui. spectrum	= [] (int l)  { say ("spectrum", std::to_string (l)); };
	ui. facMer	= [] (float v) { sayF ("facMer", v); };
	ui. sdcMer	= [] (float v) { sayF ("sdcMer", v); };
	ui. mscMer	= [] (float v) { sayF ("mscMer", v); };
	ui. service	= [] (const std::string &s) { say ("service", s); };
	ui. channel_2	= [] (const std::string &s) { say ("channel_2", s); };
	ui. channel_3	= [] (const std::string &s) { say ("channel_3", s); };
	ui. datacoding	= [] (const std::string &s) { say ("datacoding", s); };
	ui. audioMode	= [] (const std::string &s) { say ("audioMode", s); };
	ui. aacData	= [] (const std::string &s) { say ("aacData", s); };
	ui. message	= [] (const std::string &s) { say ("message", s); };
	ui. timeText	= [] (const std::string &s) { say ("timeText", s); };
//	The offsets and channel_4 move constantly; they would drown the log.

	ui. audioAvailable = [&] () {
	   std::complex<float> buf [1024];
	   while (audioBuffer. GetRingBufferReadAvailable () >= 1024) {
	      audioBuffer. getDataFromBuffer (buf, 1024);
	      audioFrames += 1024;
	      if (audioOut != nullptr) {
	         float pcm [2 * 1024];
	         for (int i = 0; i < 1024; i ++) {
	            pcm [2 * i]	    = real (buf [i]);
	            pcm [2 * i + 1] = imag (buf [i]);
	         }
	         sf_writef_float (audioOut, pcm, 1024);
	      }
	      if (audioFrames % (48000 * 5) < 1024)
	         fprintf (stdout, "AUDIO %ld frames (%.1f s)\n",
	                           audioFrames, audioFrames / 48000.0);
	   }
	};

	SNDFILE *iqOut = nullptr;
	if (iqOutName != nullptr) {
	   SF_INFO o;
	   memset (&o, 0, sizeof (o));
	   o. samplerate	= WORKING_RATE;
	   o. channels		= 2;
	   o. format		= SF_FORMAT_WAV | SF_FORMAT_FLOAT;
	   iqOut = sf_open (iqOutName, SFM_WRITE, &o);
	}

	drmDecoder theDecoder (ui, &audioBuffer);

//	Down to 12 kHz complex: mix the wanted block to DC, then one
//	decimating low-pass. This is what the GUI app does with its shifter
//	and its decimator; there is nothing DRM-specific about it.
//	The DRM block is 10 kHz wide, so this filter has to pass +-5 kHz and be
//	down by 6 kHz (Nyquist after the decimation). 31 taps at 48 kHz gives a
//	transition around 1.5 kHz wide, which eats the outer carriers: with it
//	the decoder reached time sync and read mode B / spectrum 3 off the air
//	but never got a valid FAC. The GUI app avoids this with a 377-tap FFT
//	filter; 255 taps here is the same idea done directly.
	decimatingFIR	decimator (255, 5300, WORK_RATE, DECIMATION);
	double phase = 0;
	const double dPhase = -2.0 * M_PI * offsetHz / WORK_RATE;

	std::vector<std::complex<float>> block;
	block. reserve (1024);
	const size_t chunk = WORK_RATE / 10;		// 100 ms of input
	auto started = std::chrono::steady_clock::now ();

	for (size_t base = 0; base < samples. size (); base += chunk) {
	   size_t n = std::min (chunk, samples. size () - base);
	   block. clear ();
	   for (size_t i = 0; i < n; i ++) {
	      std::complex<float> v (samples [base + i] * cos (phase),
	                             samples [base + i] * sin (phase));
	      phase += dPhase;
	      if (phase < -2 * M_PI)
	         phase += 2 * M_PI;
	      std::complex<float> out;
	      if (decimator. Pass (v, &out))
	         block. push_back (out);
	   }
	   if (!block. empty ()) {
	      if (iqOut != nullptr)
	         sf_writef_float (iqOut, (const float *)block. data (),
	                                                block. size ());
	      theDecoder. processBuffer (block. data (), block. size ());
	   }

	   double played = (double)(base + n) / WORK_RATE;
	   auto due = started + std::chrono::milliseconds
	                          ((long long)(played * 1000 / speed));
	   std::this_thread::sleep_until (due);
	}

//	let the tail work through
	std::this_thread::sleep_for (std::chrono::seconds (2));
	fprintf (stdout, "done. audio decoded: %.1f s\n", audioFrames / 48000.0);
	if (audioOut != nullptr)
	   sf_close (audioOut);
	if (iqOut != nullptr)
	   sf_close (iqOut);
	return 0;
}
