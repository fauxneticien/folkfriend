# Minimal image for local development of the folkfriend Rust CLI.
# Provides the Rust toolchain plus the system libraries that reqwest's
# native-tls backend needs to link against (libssl, pkg-config, ca-certs).
FROM rust:1.75-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/rust
