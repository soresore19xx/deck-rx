{
  "targets": [
    {
      "target_name": "asrc",
      "sources": ["src/asrc.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/opt/local/include"
      ],
      "libraries": [
        "-L/opt/local/lib",
        "-lsamplerate"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
        "OTHER_CFLAGS": ["-O2"]
      }
    }
  ]
}
