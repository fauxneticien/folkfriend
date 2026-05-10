---
title: Architecture overview
nav_order: 2
---

# Architecture overview

FolkFriend is structured as three cooperating layers:

```
+----------------------------------------------------+
|  Vue 2 PWA  (app/)                                 |
|  - UI, routing, history, settings                  |
|  - Microphone capture (Web Audio API)              |
|  - File upload + decode via OfflineAudioContext    |
+--------------------------+-------------------------+
                           | Comlink (postMessage)
+--------------------------v-------------------------+
|  Web Worker  (app/src/services/worker.js)          |
|  - Owns the WebAssembly instance                   |
|  - Holds the tune index in WASM linear memory      |
+--------------------------+-------------------------+
                           | wasm-bindgen
+--------------------------v-------------------------+
|  WebAssembly  (rust/, compiled with wasm-pack)     |
|  - Feature extraction (FFT-based)                  |
|  - Note decoding (Viterbi-style DP)                |
|  - Contour query (n-gram + Needleman-Wunsch)       |
|  - Contour -> ABC notation                         |
+----------------------------------------------------+
```

The **same Rust crate** also builds a standalone CLI binary (`folkfriend`)
using `src/bin.rs`, which can transcribe `.wav` files and query the index.
This means everything that runs in the browser also runs natively, which
makes debugging and dataset evaluation much easier.

## Data flow for a recognition request

1. **User taps the record button.** `RecorderButton.vue` switches the store
   into `RECORDING` and calls `MicService.startRecording()`.
2. **Mic plumbing.** `mic.js` requests `getUserMedia({audio:…})`, opens an
   `AudioContext`, and connects a `ScriptProcessorNode` of buffer size
   `1024` samples. `AudioContext.sampleRate` is read from the browser
   (almost always 44.1 kHz or 48 kHz), passed to the WASM via
   `set_sample_rate(sr)`, and never resampled — the DSP is parameterised on
   the input sample rate (see [Audio preprocessing](audio-preprocessing.md)).
3. **Frame streaming.** Every `onaudioprocess` event delivers exactly 1024
   `Float32` samples. `backend.js -> worker.js` allocates a buffer in WASM
   linear memory (`alloc_single_pcm_window`), `Float32Array.set`s the PCM
   data into it, and calls `feed_single_pcm_window`. Inside Rust, that one
   window is immediately turned into a single feature frame and appended to
   `self.feature_extractor.features`.
4. **Stop / submit.** When the user releases the button (or after a 10 s
   timeout in non-advanced mode), the recorder calls
   `transcribe_pcm_buffer()`. Rust runs the Viterbi-style note decoder over
   the accumulated feature matrix and returns a string of characters
   (one per quaver) representing the MIDI contour.
5. **Query.** Unless "advanced mode" is on, the contour is then passed to
   `run_transcription_query`, which scores every setting in the loaded tune
   index and returns the top 20.
6. **Render.** Vue navigates to `/results`, and a `ResultRow` component
   renders each match. Tapping a result loads the ABC for that setting and
   renders sheet music with `abcjs`.

## Threading model

The browser main thread only handles UI and microphone capture (the
`ScriptProcessorNode` callback runs on the audio thread internally, but is
exposed to JS on the main thread). All Rust/WASM work happens in a dedicated
**Web Worker** (`worker.js`), accessed via [Comlink](https://github.com/GoogleChromeLabs/comlink).
This means even slow operations (loading the ~30 MB tune index, running a
query) don't block the UI.

The worker holds a single instance of `FolkFriendWASM`, which is the
`#[wasm_bindgen]`-exported facade defined in `rust/src/lib.rs`. Every method
on that struct corresponds to one round-trip across the WASM boundary.

## State that lives where

| State | Lives in | Reason |
|---|---|---|
| `Float32` PCM buffers (1024 samples) | WASM linear memory | Avoid copying between JS and WASM heap. |
| Feature matrix (per recording) | Rust `Vec<Frame>` inside `FeatureExtractor` | Freed by `flush_pcm_buffer()`. |
| Tune index (~30k settings) | Rust `HashMap` inside `QueryEngine` | Loaded once at startup. |
| ABC notation strings | JS object `abcStringBySetting` in the worker | Stripped out before going to WASM, because string copies across the FFI are slow. |
| User history, settings | `idb-keyval` (IndexedDB) and `localStorage` | Persists across sessions. |

The note about ABC strings is worth highlighting: the index downloaded from
`folkfriend-app-data.web.app` includes ABC notation for every setting, but
ABC is only ever rendered in the UI, never used by the matching algorithm
(which works on the integer "contour"). So the worker pulls ABC out of the
JSON before passing the rest to WASM, and reinjects it whenever a setting
needs to be displayed. See `worker.js -> fetchTuneIndexData` and
`settingsFromTuneID`.
