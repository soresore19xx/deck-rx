// Asynchronous Sample Rate Converter — N-API wrapper around libsamplerate.
//
// Why this exists: when feeding PCM from SpyServer's demod path into a USB
// audio device through PortAudio (naudiodon), the writer-side rate
// (SpyServer/Airspy crystal) and the reader-side rate (DX7s/CoreAudio
// crystal) drift apart by a few ppm. Over hours that adds up to tens of
// milliseconds, eventually exhausting PortAudio's internal queue cushion
// and producing audible underrun ("ビリビリ") buzz. SDR++ avoids this by
// pushing PCM through a libsamplerate-based ASRC whose ratio is tuned to
// match the reader rate in real time; this addon ports the same idea.
//
// Public API (exposed as `SampleRateConverter`):
//   new SampleRateConverter({ channels, quality?, ratio? })
//     - channels: number of interleaved channels (e.g. 2 for stereo)
//     - quality: 0=SINC_BEST 1=SINC_MEDIUM 2=SINC_FASTEST 3=ZERO_ORDER 4=LINEAR
//     - ratio:   output_rate / input_rate (default 1.0)
//   process(Int16Array in) → Int16Array out   (PCM in == PCM out at new rate)
//   setRatio(number)  — adjust the ratio dynamically; takes effect on the
//                       NEXT process() call (libsamplerate interpolates
//                       internally so transitions are smooth).
//   getRatio() → number
//   reset()           — clear the resampler's internal filter state; call
//                       on freq retunes to avoid leftover history pop.

#include <napi.h>
#include <samplerate.h>
#include <vector>
#include <string>

class SampleRateConverter : public Napi::ObjectWrap<SampleRateConverter> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  SampleRateConverter(const Napi::CallbackInfo& info);
  ~SampleRateConverter();

private:
  Napi::Value Process(const Napi::CallbackInfo& info);
  Napi::Value SetRatio(const Napi::CallbackInfo& info);
  Napi::Value GetRatio(const Napi::CallbackInfo& info);
  Napi::Value Reset(const Napi::CallbackInfo& info);

  SRC_STATE* state = nullptr;
  int channels = 2;
  double ratio = 1.0;

  // Reusable conversion buffers — sized on demand, never shrunk, so steady
  // state does no allocations per process() call.
  std::vector<float> inBuf;
  std::vector<float> outBuf;
};

Napi::Object SampleRateConverter::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "SampleRateConverter", {
    InstanceMethod("process", &SampleRateConverter::Process),
    InstanceMethod("setRatio", &SampleRateConverter::SetRatio),
    InstanceMethod("getRatio", &SampleRateConverter::GetRatio),
    InstanceMethod("reset", &SampleRateConverter::Reset),
  });
  exports.Set("SampleRateConverter", func);
  return exports;
}

SampleRateConverter::SampleRateConverter(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<SampleRateConverter>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected options object {channels, quality?, ratio?}")
      .ThrowAsJavaScriptException();
    return;
  }
  Napi::Object opts = info[0].As<Napi::Object>();
  channels = opts.Has("channels") ? opts.Get("channels").As<Napi::Number>().Int32Value() : 2;
  int quality = opts.Has("quality") ? opts.Get("quality").As<Napi::Number>().Int32Value() : SRC_LINEAR;
  ratio = opts.Has("ratio") ? opts.Get("ratio").As<Napi::Number>().DoubleValue() : 1.0;

  if (channels < 1 || channels > 8) {
    Napi::RangeError::New(env, "channels must be in [1, 8]").ThrowAsJavaScriptException();
    return;
  }

  int err = 0;
  state = src_new(quality, channels, &err);
  if (!state) {
    Napi::Error::New(env, std::string("src_new: ") + src_strerror(err))
      .ThrowAsJavaScriptException();
    return;
  }
}

SampleRateConverter::~SampleRateConverter() {
  if (state) {
    src_delete(state);
    state = nullptr;
  }
}

Napi::Value SampleRateConverter::Process(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Int16Array input").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_int16_array) {
    Napi::TypeError::New(env, "Expected Int16Array").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Int16Array input = ta.As<Napi::Int16Array>();
  size_t inSamples = input.ElementLength();
  if (inSamples == 0) {
    return Napi::Int16Array::New(env, 0);
  }
  if (inSamples % channels != 0) {
    Napi::TypeError::New(env, "input samples not a multiple of channels")
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  size_t inFrames = inSamples / channels;

  // Int16 → Float32 in our reusable buffer.
  inBuf.resize(inSamples);
  src_short_to_float_array(input.Data(), inBuf.data(), (int)inSamples);

  // Output frame upper bound: inFrames * max(ratio, 1.0) + small headroom
  // covers up-conversion (ratio > 1) and the resampler's lookahead margin.
  double r = ratio;
  double rUp = r > 1.0 ? r : 1.0;
  size_t outFramesMax = (size_t)(inFrames * rUp) + 64;
  outBuf.resize(outFramesMax * channels);

  SRC_DATA data;
  data.data_in = inBuf.data();
  data.data_out = outBuf.data();
  data.input_frames = (long)inFrames;
  data.output_frames = (long)outFramesMax;
  data.input_frames_used = 0;
  data.output_frames_gen = 0;
  data.end_of_input = 0;
  data.src_ratio = r;

  int err = src_process(state, &data);
  if (err) {
    Napi::Error::New(env, std::string("src_process: ") + src_strerror(err))
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t outSamples = (size_t)data.output_frames_gen * channels;
  Napi::Int16Array output = Napi::Int16Array::New(env, outSamples);
  if (outSamples > 0) {
    src_float_to_short_array(outBuf.data(), output.Data(), (int)outSamples);
  }
  return output;
}

Napi::Value SampleRateConverter::SetRatio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected ratio number").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ratio = info[0].As<Napi::Number>().DoubleValue();
  // src_set_ratio lets libsamplerate interpolate internally between the
  // previous ratio and the new one over the NEXT process() call, instead
  // of switching abruptly mid-buffer. For drift compensation the changes
  // are tiny (<10 ppm steps) but smoothing keeps the output spectrally
  // clean.
  src_set_ratio(state, ratio);
  return env.Undefined();
}

Napi::Value SampleRateConverter::GetRatio(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), ratio);
}

Napi::Value SampleRateConverter::Reset(const Napi::CallbackInfo& info) {
  src_reset(state);
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return SampleRateConverter::Init(env, exports);
}

NODE_API_MODULE(asrc, Init)
