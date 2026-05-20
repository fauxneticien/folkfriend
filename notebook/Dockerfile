# syntax=docker/dockerfile:1.6
#
# Two-stage build for the FolkFriend pipeline notebook:
#   1. Compile the Rust crate to a Node-targeted WebAssembly module.
#   2. Assemble a small Node runtime image with the WASM, scripts, and npm
#      dependencies baked in. Running the image executes all four pipeline
#      stages and writes notebook.html into /app/data (bind-mountable).
#
# Build context must be the repository root, since stage 1 needs rust/
# and stage 2 needs notebook/.
#   docker build -f notebook/Dockerfile -t folkfriend-notebook .

# ---------------------------------------------------------------------------
# Stage 1 — build folkfriend.wasm for the Node.js target.
# ---------------------------------------------------------------------------
FROM rust:1.83-bookworm AS wasm-builder

RUN cargo install wasm-pack --locked --version 0.13.1

WORKDIR /build/rust
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/src ./src

# Cargo.lock in the repo pins wasm-bindgen to a version compatible with
# modern Rust toolchains (see commit history).
RUN wasm-pack build --target nodejs --out-dir /out/wasm --release


# ---------------------------------------------------------------------------
# Stage 2 — Node runtime that runs the pipeline.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

# Copy WASM first so npm install can resolve "folkfriend-wasm": "file:./wasm".
COPY --from=wasm-builder /out/wasm ./wasm
COPY notebook/package.json ./

# node-web-audio-api ships prebuilt binaries for x86_64-linux-gnu; no extra
# build tools required.
RUN npm install --omit=dev

# Pipeline scripts + default sample input.
COPY notebook/01_decode-wav.js \
     notebook/02_transcribe.js \
     notebook/03_contour-to-abc.js \
     notebook/04_query.js \
     notebook/build-notebook.js \
     ./
COPY notebook/input.wav ./input.wav

# /app/data and /app/cache are populated either by the pipeline run or by
# volume mounts at runtime.
RUN mkdir -p data cache

# Cache the tune-index in a directory that's easy to mount as a named volume.
ENV TUNE_INDEX_PATH=/app/cache/tune-index.json

# Run the four pipeline stages, then mirror notebook.html into the
# bind-mounted ./data directory so it lands on the host.
CMD ["sh", "-c", "node 01_decode-wav.js && node 02_transcribe.js && node 03_contour-to-abc.js && node 04_query.js && node build-notebook.js && cp notebook.html data/notebook.html"]
