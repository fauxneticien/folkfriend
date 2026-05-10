---
title: Deployment
nav_order: 6
---

# Deployment & how the Rust + Vue app fit together

This page answers the question:

> *How does the deployment work? How does the web app work with the Rust
> aspects of the codebase (assume no Rust familiarity)?*

## TL;DR

```
rust/  --(wasm-pack)-->  app/src/wasm/folkfriend.{js,wasm}
app/   --(vue-cli build)-->  app/dist/
app/dist/  --(firebase deploy)-->  https://folkfriend.app
```

The Vue frontend is a fairly normal PWA. The Rust crate is compiled to
**WebAssembly** with `wasm-pack` and the resulting glue JS + `.wasm` file
are dropped into the Vue source tree like any other JS module. Firebase
Hosting serves the static build.

## What is "WebAssembly", briefly?

WebAssembly (WASM) is a portable binary instruction format that runs in
the browser at near-native speed. You can compile C, C++, Rust (and
others) to a `.wasm` file, then load it from JavaScript and call its
exported functions almost as if they were normal JS functions. Numeric
arguments cross the boundary cheaply; strings and arrays cost a copy.

For FolkFriend the appeal of WASM is:

- The whole signal-processing + search pipeline stays in one Rust
  codebase, shared between the web app and the CLI binary.
- DSP runs at speeds comparable to native code; far faster than
  hand-written JS.
- No server is needed for transcription — every user's phone or laptop
  does its own work.

## How Rust is compiled for the web

There are two relevant build scripts in `rust/`:

```sh
# rust/binary_build.sh  — native CLI
cargo build --release

# rust/wasm_build.sh — browser bundle
wasm-pack build --target bundler --release
mkdir -p ../app/src/wasm/
cp pkg/* ../app/src/wasm/
```

`wasm-pack` runs `cargo` under the hood with the `wasm32-unknown-unknown`
target and then post-processes the result. The output (`pkg/`) contains:

- `folkfriend_bg.wasm` — the actual compiled binary code.
- `folkfriend.js` — auto-generated JS glue that loads the wasm, exposes
  the `#[wasm_bindgen]`-marked Rust types as JS classes, and handles
  marshalling.
- TypeScript declarations and a `package.json`.

These files are copied into `app/src/wasm/`. `vue.config.js` enables
`experiments.asyncWebAssembly` so that webpack treats `.wasm` imports
correctly.

The Cargo manifest declares two build artefacts:

```toml
[lib]
name = "folkfriend"
crate-type = ["cdylib", "rlib"]

[[bin]]
name = "folkfriend"
path = "src/bin.rs"
```

`cdylib` is what makes a `.wasm` shareable; `rlib` is the standard Rust
library format used when the binary depends on the same crate.

## How JS calls into Rust

`rust/src/lib.rs` defines two structs:

- `FolkFriend` — the "real" API, used by the native CLI.
- `FolkFriendWASM` — a thin wrapper marked `#[wasm_bindgen]` whose method
  signatures use only types that survive the JS↔WASM round-trip cleanly
  (`String`, `u32`, `*mut f32`, `JsValue`, etc.).

`FolkFriendWASM` is exported as a JS class. In `app/src/services/worker.js`:

```js
import('@/wasm/folkfriend.js').then(wasm => {
    this.folkfriendWASM = new wasm.FolkFriendWASM();
    this.setLoadedWASM();
});
```

After construction, calls like `this.folkfriendWASM.set_sample_rate(48000)`
and `this.folkfriendWASM.run_transcription_query(contourStr)` cross the
boundary as if they were normal JS methods.

### The clever bit: shared memory for audio frames

PCM audio comes in as 1024 `Float32`s every ~21 ms (at 48 kHz). Copying
them into a JS object, JSON-serialising them, and copying back into WASM
linear memory would be wasteful. Instead, FolkFriend uses a pattern that
works directly on WASM's linear memory:

```rust
// rust/src/lib.rs
pub fn alloc_single_pcm_window(&mut self) -> *mut f32 {
    let mut buf: [f32; SPEC_WINDOW_SIZE] = [0.; SPEC_WINDOW_SIZE];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);   // hand ownership over to JS via raw pointer
    return ptr;
}
pub fn get_allocated_pcm_window(&mut self, ptr: *mut f32) -> js_sys::Float32Array {
    unsafe { js_sys::Float32Array::view(slice::from_raw_parts(ptr, SPEC_WINDOW_SIZE)) }
}
pub fn feed_single_pcm_window(&mut self, ptr: *mut f32) {
    let pcm_window = unsafe { slice::from_raw_parts(ptr, SPEC_WINDOW_SIZE) };
    self.ff.feed_single_pcm_window(pcm_window.try_into().unwrap());
}
```

JS-side (`worker.js`):

```js
const ptr = await folkfriendWASM.alloc_single_pcm_window();
const arr = await folkfriendWASM.get_allocated_pcm_window(ptr);
arr.set(PCMWindow);                          // copy directly into WASM memory
await folkfriendWASM.feed_single_pcm_window(ptr);
```

The `Float32Array` returned by `get_allocated_pcm_window` is a **view onto
the WASM linear memory**, not a copy. Writing into it writes straight into
the place Rust will read from on the next call. This avoids per-frame
allocation churn.

## How the worker thread is wired up

`app/src/services/backend.js`:

```js
const worker = new Worker(new URL('@/services/worker.js', import.meta.url));
this.folkfriendWorker = Comlink.wrap(worker);
```

[Comlink](https://github.com/GoogleChromeLabs/comlink) makes a Web Worker
behave like a remote object: you call `worker.method(args)` from the main
thread and it returns a `Promise` resolving with whatever the worker
returned. The actual messaging is `postMessage`, but the API hides that.

`worker.js` calls `Comlink.expose(folkfriendWASMWrapper)` so its methods
are accessible from `backend.js`. The whole call chain for a single PCM
window is therefore:

```
ScriptProcessorNode.onaudioprocess          (main thread)
  → ffBackend.feedSinglePCMWindow           (main thread)
  → worker.feedSinglePCMWindow              (postMessage to worker)
  → wasm.feed_single_pcm_window             (WASM in worker)
  → Rust modified_autocorrelation           (WASM compute)
  → push frame onto FeatureExtractor.features
```

## How the static site is built

```sh
cd app/
npm install
npm run build       # vue-cli-service build → app/dist/
```

`vue-cli` handles JS bundling, code-splitting, the service-worker, and
the WASM async-import support. The output `app/dist/` is a vanilla static
website — no server-side runtime.

## Hosting

`app/firebase.json`:

```json
{
  "hosting": {
    "public": "dist",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
```

`app/.firebaserc`:

```json
{
  "projects": {
    "dev": "folkfriend-dev",
    "prod": "folk-friend"
  }
}
```

Deployment is done with the Firebase CLI:

```sh
cd app/
npm run build
firebase deploy --only hosting       # uses default project (prod)
# or
firebase deploy --only hosting -P dev
```

The `rewrites` rule sends every URL to `index.html` so the Vue Router
(`mode: 'history'`) can take over routing on the client.

The tune index is hosted as a separate Firebase site,
`folkfriend-app-data.web.app`, populated by a sibling repository.

## Service worker / PWA

`app/src/registerServiceWorker.js` registers a service worker (only in
production builds, generated by `@vue/cli-plugin-pwa`) which caches the
app shell. Combined with the IndexedDB-cached tune index, the app is
fully functional offline once it's been opened with a network connection
once.

`app/public/site.webmanifest` declares it installable as a standalone
PWA (`display: standalone`, theme/background colours, icons).

## Analytics

Firebase Analytics is wired up in `App.vue::initAnalytics` (the api key in
that file is fine to be public — Firebase keys are not secrets). Custom
events get logged from `store.logAnalyticsEvent`, e.g. `transcription`,
`transcription_query`, `tune_index_init`. There is no other backend.

## What's *not* deployed anywhere

- No transcription API.
- No speech-to-text service.
- No model server.
- No WebSocket / streaming endpoint.
- No paid third-party APIs.

The whole "intelligence" of the app lives in the static
`folkfriend_bg.wasm` blob (~200 kB) and the static
`folkfriend-non-user-data.json` blob (~30 MB) downloaded once, plus the
Vue UI on top.

## Local development summary

```sh
# Build the WASM and copy it into the Vue source tree
cd rust/
./wasm_build.sh

# Pull a fresh copy of the tune index for offline dev (optional)
cd ../app/
./download_tune_data.sh

# Run the dev server
npm install
npm run serve            # http://localhost:8080
```

If you change anything under `rust/`, re-run `./wasm_build.sh` and the Vue
dev server will hot-reload the new wasm.

## Native CLI for debugging

The same crate also produces a CLI binary, which is invaluable for
debugging since you can save intermediate stages as PNGs:

```sh
cd rust/
cargo run -- transcribe wavs/soup_dragon.wav --debug
```

This writes:

- `wavs/soup_dragon.a-features.png` — the feature matrix (heatmap).
- `wavs/soup_dragon.b-lattice-path.png` — the chosen path through the
  lattice.
- `wavs/soup_dragon.c-decoded-contour.png` — the final quaver-quantised
  contour.

These are extremely useful when working out *why* a transcription went
wrong: you can see which frames the energy showed up in, and where the
DP made a bad choice.
