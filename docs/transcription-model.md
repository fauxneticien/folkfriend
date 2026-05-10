---
title: The transcription model
nav_order: 4
---

# The transcription model

This page answers the questions:

> *What is the model? Where are the weights? Are there even model weights?
> Is the model a deterministic transcription with hard-coded note intervals
> and then string matching over the session ABC database?*

**Direct answer:** there is **no neural network** and there are **no learned
weights** anywhere in the production app. The transcription is a fully
deterministic DSP + dynamic-programming pipeline. It uses a small
**hand-tuned table of pitch-interval log-likelihoods** that act like a
language model over note transitions, but those numbers were tuned by
inspection, not by gradient descent. They live in source as plain
constants, not in any weights file.

The README hints at this — *"if you are unfamiliar with rust, you can find
implementations of all the key parts of FolkFriend in Python 3 in the
commit history of this repository"*. The repo is one self-contained
algorithmic system, not a model deployment.

There is no `.onnx`, `.tflite`, `.bin`, `.pt`, or `.safetensors` file
shipped with the app or downloaded at runtime. The only data downloaded at
runtime is the **tune index** (`folkfriend-non-user-data.json`), which is
the searchable corpus of tunes from thesession.org, not model parameters.

## What "the model" actually is

After feature extraction (see [Audio preprocessing](audio-preprocessing.md))
the input to "the model" is a `48 × N` matrix of MIDI-binned energies. The
model's job is to turn that into a string of MIDI notes.

It is a **two-stage decoder**:

1. **Lattice decoder** (Viterbi-style dynamic programming). Find the
   single best path through a 48-row × N-column score grid, scoring each
   transition as `feature_energy + pitch_interval_score`. Output: a length-N
   sequence of pitches, one per audio frame.
2. **Tempo + quantiser**. Collapse repeated pitches into "notes" with a
   duration in frames, drop very short or very quiet notes, then sweep
   tempos from 60 to 240 BPM and choose the tempo whose quaver grid best
   explains the observed note durations. Output: a "contour" — one MIDI
   pitch per quaver.

Optionally, a third step ("octave correction") shifts the whole contour
down an octave if 85% of the notes are above MIDI 76 (open E on a fiddle).
This corrects systematic octave errors when the user is playing tin
whistle, which has very strong harmonics.

All three steps live in `rust/src/decode/`.

### Stage 1: Viterbi-ish lattice search

`rust/src/decode/beam_search.rs` (despite the filename, it's not a beam
search — it's an exact DP).

For each frame `t` from 1 to `N-1`, and each of the 48 pitches, compute the
best-scoring incoming state from frame `t-1`:

```
score[t][p] = energy[t][p]
            + max over p_prev of (
                score[t-1][p_prev] + pitch_score(p - p_prev)
              )
```

Then back-trace from the highest-scoring final cell. The result is a
`LatticePath` — a sequence of 48-bin row indices, one per frame.

#### The "pitch model"

`rust/src/decode/pitch_model.rs` defines `PitchModel::score(interval)`,
which is the only place the algorithm's "musical knowledge" comes from.
The base table (in semitones, log-domain) is:

```
-12   ~ -2.64        // octave down
-11   ~ -4.39        // major 7th down  (rare in folk)
-10   ~ -2.97
-9    ~ -2.17
-8    ~ -2.31
-7    ~ -1.16        // 5th down
-6    ~ -3.73        // tritone — very unlikely
-5    ~ -0.63
-4    ~ -0.68
-3    ~ -0.39
-2    ~ -0.24
-1    ~ -1.38
 0    ~ "stay on the same note" — handled separately
+1    ~ -1.30
+2    ~  0.00        // most likely interval — wholetone up
+3    ~ -0.34
...
+12   ~ -3.41
```

These are **rough log-likelihoods of seeing each interval in folk music**.
They were tuned by hand looking at corpus statistics; you can confirm they
sit in the source as literal constants, not loaded from a file. Anything
beyond ±12 semitones gets a very poor score (`all_other_scores`), because
in folk a leap of more than an octave between adjacent quavers is
exceptionally rare.

The whole table is shifted by `PITCH_MODEL_SHIFT = -7.0` and scaled by
`PITCH_MODEL_WEIGHT = 0.05` before being added to the energy term.
Repeating the same note (`interval == 0`) is given a flat
`BASE_ENERGY_SCORE = -0.18`, which acts as a small "stay" cost and
prevents the decoder from getting stuck on one pitch in silence.

#### Why this is not "machine-learned"

Nothing in this pipeline calls a neural net. There is no inference. There
are no batched matrix multiplies. The path through the lattice is found by
DP, and the only "learned-looking" thing is that 25-element table — and
those numbers are baked into the source.

If you wanted to swap in a learned acoustic / language model, the natural
spots would be:

- Replace the per-frame `energy` term with a CNN over spectrograms.
- Replace `pitch_score` with the output of a small RNN/Transformer over
  pitch sequences.

Neither is currently done.

### Stage 2: tempo selection and quaver quantisation

`rust/src/decode/contour.rs`.

After Stage 1 we have the most-likely pitch in each frame. Adjacent
frames with the same pitch are merged into `Note { pitch, duration_in_frames,
power }`. Notes that are too short (`duration < 3` frames or `< 0.2`
quavers) or too quiet (`power < 0.1`) are dropped. If fewer than three
notes survive, the decoder bails with a `DecoderError` ("Could not detect
any notes" — what the UI surfaces).

Then for `bpm` in `60..240` step 5:

1. Compute `frames_per_quaver(bpm, sample_rate)`.
2. For each note, round `duration_in_frames / frames_per_quaver` to an
   integer number of quavers.
3. Score the assignment by combining a quantisation-error term and a very
   simple linear log-likelihood of "how many notes do we expect to be N
   quavers long" (`3.0 - 0.5 * length`).

The best-scoring tempo wins. The contour is then constructed by
repeating each note's pitch by its rounded quaver count, producing one
MIDI pitch per quaver.

Finally, `decode::types::contour_to_contour_string` maps each MIDI value
to a single character using the alphabet in `ff_config::CONTOUR_TO_QUERY_CHAR`
(`a` = MIDI 48, `b` = MIDI 49, …, capitals continue past `z`). This is
why the example output in the README is the cryptic-looking
`"CEExxvxCEECACCCCACEECACEExxvxCEECACCCEECAxv"`: it's just the
quaver-by-quaver pitch sequence written one character per pitch.

### Stage 3: octave correction (optional)

`rust/src/decode/octave.rs`. If 85% of the contour's notes are above
MIDI 76, shift everything above MIDI 60 down by 12 semitones. Only triggers
on suspiciously high transcriptions, mostly tin-whistle recordings.

## So what's the answer to "is it deterministic with hardcoded intervals
and string matching"?

Yes — exactly that.

| Step | Deterministic? | Where the constants come from |
|---|---|---|
| Modified autocorrelation features | Yes | Standard DSP (Tolonen 2000) |
| Octave fold | Yes | Heuristic |
| Top-5 prune | Yes | Constant `RETAINED_FEATURES_PER_FRAME=5` |
| Lattice DP | Yes (exact DP) | – |
| Pitch interval scores | Yes | Hand-tuned 25-value table in `pitch_model.rs` |
| Tempo sweep | Yes | Linear scan 60–240 BPM in steps of 5 |
| Quantiser scoring | Yes | Linear log-likelihood model |
| Octave correction | Yes | Threshold (85%, MIDI 76) |
| Tune search | Yes | n-grams + Needleman-Wunsch (next page) |

So: hand-engineered pitch detection → hand-engineered note decoding →
hand-engineered string match against a downloaded JSON corpus.

## Where are the "weights" stored, then?

The closest thing to weights is the contents of `ff_config.rs` and
`pitch_model.rs`. Both are **plain Rust source files** compiled into the
binary, so they ship as part of `folkfriend_bg.wasm` (around 200 kB) and
require no runtime download. There's no separate weights file to manage,
version, or load.
