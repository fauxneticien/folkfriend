# FolkFriend pipeline notebook

A standalone, step-by-step walkthrough of the FolkFriend audio pipeline. Each
stage is a small Node.js script of the form `output = process(input)`, with
intermediates written to `data/` in inspectable form. `build-notebook.js`
renders all stages as a single static HTML notebook.

Mirrors the browser pipeline in `app/src/services/audio.js` and
`app/src/services/worker.js`, calling the same WASM build as the Vue app.

## Pipeline

| # | Script | Input | Output |
|---|---|---|---|
| 01 | `01_decode-wav.js [input.wav]` | WAV bytes | `data/01_decoded-audio.json` |
| 02 | `02_transcribe.js`             | decoded PCM | `data/02_contour.json` |
| 03 | `03_contour-to-abc.js`         | contour string | `data/03_abc.txt` |
| 04 | `04_query.js`                  | contour string | `data/04_matches.json` |
| —  | `build-notebook.js`            | all data files | `notebook.html` |

Stages 03 and 04 both consume `data/02_contour.json` (parallel branches, just
like the Vue app's ABC view vs. search results).

## Docker (no local Rust/Node needed)

```bash
# From the repo root
docker compose -f notebook/docker-compose.yaml run --rm notebook
```

This builds the WASM, installs npm deps, and runs all four stages. Outputs
land in `notebook/data/` on the host (including `data/notebook.html`). The
32 MB tune index is cached in a named volume so it's only downloaded once.

To process a different WAV, drop it next to `docker-compose.yaml` as
`input.wav` and uncomment the bind mount in the compose file.

## One-time setup

```bash
# 1. Build the WASM for Node.js (writes notebook/wasm/)
cd ../rust
wasm-pack build --target nodejs --out-dir ../notebook/wasm --release
cd ../notebook

# 2. Install npm deps (web-audio-api for browser-faithful WAV decoding)
npm install
```

If the WASM build complains about old `wasm-bindgen`, run
`cargo update -p wasm-bindgen --precise 0.2.88` in `../rust/` first.

## Running

```bash
# All stages + HTML build
npm run all

# Or stage by stage
node 01_decode-wav.js          # uses notebook/input.wav by default
node 02_transcribe.js
node 03_contour-to-abc.js
node 04_query.js               # downloads tune-index.json on first run (~32 MB)
node build-notebook.js         # writes notebook.html
```

Open `notebook.html` in a browser to see the rendered notebook.

To run with a different audio file:

```bash
node 01_decode-wav.js path/to/other.wav
node 02_transcribe.js && node 03_contour-to-abc.js && node 04_query.js
node build-notebook.js
```

## Why `node-web-audio-api`?

The Vue app decodes audio via `OfflineAudioContext.decodeAudioData()`, which
auto-resamples to 48 kHz. We use the `node-web-audio-api` npm package to keep
the decoded PCM byte-for-byte equivalent to what the browser sees.

## Data formats

- `01_decoded-audio.json` — `{ sampleRate, length, durationSec, channelData: [Float32 array as plain JSON] }`. ~9 MB for ~10 s of audio; gitignored. Swap to a `.f32` binary sidecar if size becomes a problem.
- `02_contour.json` — `{ contourString, numWindows, sampleRate, timing }`.
- `03_abc.txt` — raw ABC notation.
- `04_matches.json` — `{ contourString, queryMs, matches: [...] }` with the top 20 ranked tunes.

## Future: finer-grained stages (v2)

To expose the intermediate features and lattice path, add three thin
`#[wasm_bindgen]` accessors to `rust/src/lib.rs` (one for features, one for the
lattice path, one to combine path+features into a contour) and split stage 02
into three numbered scripts: `02_extract-features.js`, `03_decode-lattice.js`,
`04_extract-contour.js`. `build-notebook.js` can grow heatmap (features) and
path overlay (lattice) previews for the new cells.
