---
title: FolkFriend Developer Docs
nav_order: 1
---

# FolkFriend Developer Documentation

[FolkFriend](https://folkfriend.app) is a Progressive Web App (PWA) that listens to
short clips of traditional instrumental folk music — typically Irish/Scottish
session tunes — transcribes them to musical notation, and matches the
transcription against a database of about 30,000 tunes scraped from
[thesession.org](https://thesession.org).

The whole pipeline runs **client-side** in the browser. There is no server
"transcription API". Audio captured from the microphone (or an uploaded file)
is fed straight into a WebAssembly (WASM) module compiled from the project's
Rust library, and even the tune index is downloaded once and then queried
locally.

These docs are aimed at developers who want to understand how the app works.
If you only want to *use* the app, just go to
[folkfriend.app](https://folkfriend.app).

## Pages

1. [Architecture overview](architecture.md) — what runs where, and how the
   pieces communicate.
2. [Audio preprocessing](audio-preprocessing.md) — answers "what does the
   frontend do to the audio? does it resample? what's the output?".
3. [The transcription model](transcription-model.md) — answers "is there a
   neural net? are there weights? or is it deterministic?".
4. [Tune matching](tune-matching.md) — answers "how does it search the
   thesession.org database?".
5. [Deployment](deployment.md) — answers "how does Rust talk to the Vue
   webapp, and how does the whole thing get on the internet?".

## Two-line summary

> FolkFriend is a hand-engineered DSP pipeline (FFT-based pitch detection +
> dynamic-programming note decoding) compiled to WebAssembly, plus an
> n-gram + Needleman–Wunsch string search over a downloaded JSON tune
> database. There are **no learned model weights**.

## Repository layout

| Directory | Description |
| ---       | ---         |
| `app/`    | Vue 2 + Vuetify Progressive Web App, deployed to `folkfriend.app` via Firebase Hosting. |
| `rust/`   | Rust crate `folkfriend`. Builds both a native CLI binary and a WebAssembly bundle that the PWA imports. |
| `scripts/`| Python helpers for evaluating the transcription/query pipeline against an offline dataset. |
| `resources/` | Misc. assets (favicons, the SVG "gears" animation generator). |

The Rust crate is the source of truth for all DSP, decoding, and search
logic. The Vue app is mostly UI, microphone plumbing, and result rendering.
