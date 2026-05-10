---
title: Audio preprocessing
nav_order: 3
---

# Frontend audio preprocessing

This page answers the questions:

> *What is the frontend audio preprocessing? Does it resample the audio? What
> is the output of the frontend preprocessing (e.g. a windowed STFT
> matrix)?*

Short answers:

- **No, the audio is not resampled.** The preprocessing is sample-rate
  aware: it accepts whatever sample rate the browser provides (typically
  44,100 Hz or 48,000 Hz) and adapts the analysis bins accordingly. The
  only exception is uploaded files, where the browser's
  `OfflineAudioContext` is used to decode the file at a fixed 48 kHz — a
  side-effect of how `decodeAudioData` works.
- **The output is *not* an STFT magnitude matrix.** It is something more
  specialised: a **48 × N matrix of MIDI-binned "modified autocorrelation"
  energies**, where 48 is the number of MIDI pitches FolkFriend supports
  (C2 to B6 inclusive) and N is the number of 1024-sample frames in the
  recording. After noise filtering only the **5 strongest pitches per frame
  are kept**; the other 43 cells in each column are zeroed.

The rest of this page walks through the pipeline.

## 1. Capture (Vue / Web Audio API)

`app/src/services/mic.js` opens an `AudioContext` and connects:

```
MediaStreamSource (mic) → ScriptProcessorNode(bufferSize=1024) → destination
```

A `ScriptProcessorNode` is used (rather than the modern `AudioWorklet`)
because of stubborn browser-support edge cases — see the comments in
`mic.js`. Every `onaudioprocess` event delivers exactly **1024 mono
`Float32` samples** in `[-1, 1]`. That window is forwarded into WASM
unmodified.

The browser's chosen sample rate is read from `audioCtx.sampleRate` and
passed to the WASM backend with `setSampleRate(sr)` once at the start of
recording. The WASM side validates that
`SAMPLE_RATE_MIN < sr < SAMPLE_RATE_MAX` (3,952 Hz — 66,974 Hz), which
covers every realistic device. See `rust/src/feature/signal.rs`.

For **file uploads**, `app/src/services/audio.js` does:

```js
const audioContext = new OfflineAudioContext(1, audio.duration * 48000, 48000);
const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
return decodedBuffer.getChannelData(0);
```

`decodeAudioData` happily handles compressed formats (MP3 / OGG / etc.) and
**implicitly resamples** the result to the context's sample rate (48 kHz
here). This is the only resampling step in the system, and it only happens
to non-WAV uploads.

## 2. Window length

Every analysis frame is exactly **`SPEC_WINDOW_SIZE = 1024` samples**.
`feed_signal` simply slices the input PCM into non-overlapping 1024-sample
windows (`signal[i..i+1024]` step 1024 — no overlap, no hop). At 48 kHz
that is 46.875 frames per second; at 44.1 kHz, ~43 fps. FolkFriend never
needs to know the exact frame rate because tempo is derived later, see
[The transcription model](transcription-model.md).

## 3. Per-window analysis: a "modified autocorrelation"

The core DSP step lives in
`rust/src/feature/autocorrelate.rs::modified_autocorrelation`. It is *not*
a plain magnitude STFT. Pseudocode:

```
1. Apply Blackman window of length 1024.
2. FFT (forward, length-1024, Radix-4 from rustfft).
3. Compute |X|^(1/3) for each bin (k=1/3 magnitude compression,
   approximating Tolonen-Karjalainen multipitch detection).
   Implementation note: we compute (re^2 + im^2)^(1/6), which equals
   (|X|^2)^(1/6) = |X|^(1/3), because that's faster than calling .norm().
4. FFT again on that real, even sequence. Because the input is real and
   even, a second forward FFT is equivalent to an inverse FFT, so this
   second pass produces a (compressed) autocorrelation. The same
   FFT object is reused.
5. Half-wave rectify: clamp negative values to 0.
6. Linearly interpolate the resulting bins onto MIDI-pitch frequencies.
```

The two-FFT-with-fractional-power-in-the-middle is a standard trick for
sharpening pitch peaks. Setting `k = 1/3` is recommended by
[Tolonen & Karjalainen, 2000](https://labrosa.ee.columbia.edu/~dpwe/papers/ToloK2000-mupitch.pdf).

### Why "modified autocorrelation" and not STFT?

A vanilla STFT magnitude tells you "how much energy is at each frequency".
That is not great for pitch perception of harmonic instruments — a violin
playing A4 will produce strong energy at 440, 880, 1320, 1760 Hz, etc.,
and the STFT can't tell you which of those is the fundamental.

The modified autocorrelation collapses the harmonic series back onto the
fundamental period, which is the right primitive for monophonic pitch
detection. After this step, an A4 should ideally produce a single big
spike at the bin corresponding to MIDI 69, not five spikes spread up the
spectrum.

### Sample-rate awareness via interpolation

The `compute_interp_inds` function in `rust/src/feature/interpolate.rs`
precomputes, for the given sample rate, a list of `(hi_index, lo_index,
hi_weight, lo_weight)` tuples — one per output bin. Each output bin is the
linear combination of two adjacent autocorrelation bins, chosen so that
the bin centres land exactly on the desired MIDI frequency. This means the
**same MIDI grid is produced regardless of input sample rate** (within the
3,952–66,974 Hz support range), so the rest of the pipeline doesn't need
to care.

The mapping is:

- Output is `SPEC_BINS_NUM = SPEC_BINS_PER_MIDI * MIDI_NUM = 3 * 48 = 144`
  bins, linearly spaced in MIDI between MIDI 47.66 and MIDI 95.33.
- These 144 bins are then summed three at a time into the **48 final
  per-MIDI-note bins** (one bin per semitone in the supported range).
- MIDI range supported is `MIDI_LOW=48` (C2, 130.81 Hz) to `MIDI_HIGH=95`
  (B6, 1975.5 Hz) inclusive.

## 4. Postprocessing each frame

Still inside `modified_autocorrelation`, two cheap heuristics are applied
before the frame is written to the feature matrix:

### Octave folding

For each pitch class, walk up the octaves (`musical_key`,
`musical_key + 12`, `musical_key + 24`, …). If a higher octave has more
energy than the one below, *move* the lower octave's energy up into the
higher one. This is intentional because the autocorrelation step
sometimes leaves a residual peak at twice the period (one octave below
the true fundamental), and folding cleans it up. Total energy is
conserved.

### Top-K pruning

`RETAINED_FEATURES_PER_FRAME = 5`. Every frame is sorted by energy and
all but the top 5 entries are zeroed. The decoder doesn't care about
the long tail of low-energy bins, and this drastically reduces the
amount of work the dynamic programming step has to do later.

## 5. Output: the feature matrix

After all windows have been processed, `FeatureExtractor.features` is a
`Vec<[f32; 48]>` — one column per 1024-sample window, 48 rows for the
supported MIDI pitches, and at most 5 non-zero entries per column.

That matrix is what the decoder consumes. You can dump it to a PNG with
the `--debug` flag of the CLI binary — see `bin.rs::save_features_as_img`
— which is genuinely useful for understanding what the model is "seeing".

## At a glance

| Stage | Operates on | Produces | Code |
|---|---|---|---|
| Mic capture | MediaStream | 1024-sample `Float32` windows | `app/src/services/mic.js` |
| Window function | 1024 samples | windowed samples | `rust/.../feature/window.rs` (Blackman) |
| FFT | windowed samples | complex spectrum | `rustfft::Radix4` |
| Magnitude compression | spectrum | `|X|^(1/3)` | `feature/autocorrelate.rs` |
| Second FFT | compressed spectrum | (modified) autocorrelation | `rustfft::Radix4` |
| MIDI rebinning | autocorrelation | 144 → 48 MIDI bins | `feature/interpolate.rs` |
| Octave fold + top-5 prune | 48-bin frame | sparse 48-bin frame | `feature/autocorrelate.rs` |
| Accumulate | many frames | `48 × N` feature matrix | `feature/mod.rs` |

## What it deliberately does *not* do

- No silence trimming (the unused `Normalisable::normalise` shows commented-out
  code for it).
- No per-frame loudness normalisation while recording (only globally,
  inside the decoder).
- No pre-emphasis filter, no mel/log scale (mel doesn't help for
  monophonic pitch).
- No overlapping windows. Windows are completely contiguous.
