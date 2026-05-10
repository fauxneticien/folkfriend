---
title: Tune matching
nav_order: 5
---

# Tune matching against the thesession.org index

Once a recording has been turned into a "contour" string (see
[The transcription model](transcription-model.md)), FolkFriend ranks tunes
in its index by similarity to that string. There are also "name queries"
where the user types text into the search bar and the same machinery is
reused to fuzzy-match tune titles.

The matching is a **two-pass string search** — fast n-gram filtering
followed by Needleman-Wunsch sequence alignment — entirely client-side,
over a downloaded JSON file.

## The tune index

`worker.js -> fetchTuneIndexData()` downloads
`https://folkfriend-app-data.web.app/folkfriend-non-user-data.json`. This
file is built by a separate
[folkfriend-app-data](https://github.com/TomWyllie/folkfriend-app-data)
pipeline that scrapes [thesession.org](https://thesession.org). Its
schema (in Rust, `rust/src/index/schema.rs`) is:

```rust
struct TuneIndex {
    settings: HashMap<SettingID, Setting>,    // ~30k entries
    aliases:  HashMap<TuneID,    Vec<String>>, // tune name + alternative names
}

struct Setting {
    tune_id: TuneID,
    meter:   String,   // e.g. "4/4"
    mode:    String,   // e.g. "Edor"
    abc:     String,   // ABC notation for rendering
    dance:   String,   // e.g. "reel", "jig"
    contour: String,   // pre-computed contour string for matching
}
```

A *tune* may have many *settings* (alternative arrangements). Each setting
has its own pre-computed `contour` string in exactly the same alphabet
that the transcriber emits.

The index is cached in IndexedDB (`idb-keyval`) under the key `tuneIndex`.
A small `nud-meta.json` is also fetched on each launch, and if the
remote `v` is more than 28 days newer than the cached one, the index is
re-downloaded (otherwise it would burn ~30 MB of bandwidth on every
launch).

To save memory and FFI cost, the worker **strips the `abc` field out of
every setting before passing the index across into WebAssembly**, keeping
ABC strings in a JS map (`abcStringBySetting`). ABC is only used by the
sheet-music renderer (`abcjs`) and is reinjected when a setting is
displayed.

## Pass 1 — n-gram heuristic

`rust/src/query/heuristic.rs::run_transcription_query`.

1. Cut the query contour into all overlapping **quadgrams** (4-character
   substrings).
2. Build an [Aho-Corasick](https://docs.rs/aho-corasick/) automaton from
   those quadgrams.
3. For each setting in the index, count how many overlapping matches its
   `contour` field has. That count is its score.
4. Sort by descending score, keep the top `QUERY_REPASS_SIZE = 2000`.

This is fast (a handful of milliseconds) because Aho-Corasick scans every
setting in linear time. It's a good filter but it has no idea about
*ordering* — `"abcd...wxyz"` and `"wxyz...abcd"` get identical scores. So
we follow up with a proper sequence alignment on the survivors.

For **name queries** (text-search of tune titles) the same approach is
used but with **trigrams** (`QUERY_NGRAM_SIZE_NAME = 3`), and there is no
second pass — the heuristic ranking is the final ranking, broken by
shortest-alias-first.

## Pass 2 — Needleman-Wunsch

`rust/src/query/nw.rs::needleman_wunsch`.

A memory-efficient (single-row) Needleman-Wunsch global alignment with:

- match score `+2`
- mismatch score `-2`
- gap score `-1`

The score is normalised by the length of the shorter string and divided
by 2 so that it lies in `[0, 1]`, where 1 = perfect match. That's the
score you see in the CLI/web output (e.g. `0.872093` in the README
example).

## Putting them together

`rust/src/query/mod.rs::run_contour_query`:

```text
contour
  -> heuristic (Aho-Corasick over all settings, take top 2000)
  -> NW alignment for each of those 2000 settings
  -> sort by NW score, descending
  -> deduplicate by tune_id (keep best-scoring setting per tune)
  -> truncate to top 100
```

The WASM wrapper truncates further to **20** results before returning,
because that's all the UI shows.

The `tune_id` deduplication is important: thesession has ~10–30 settings
of popular tunes like *Drowsy Maggie*, and without dedup the results page
would just be 20 copies of the same tune.

## Worked example

Running the CLI on the bundled `wavs/soup_dragon.wav`:

```
$ cargo run -- query wavs/soup_dragon.wav

=== Query for file "wavs/soup_dragon.wav" ===
"10785"  "soup dragon, the"  0.872093
"414"    "seamus cooley's"   0.5697674
"9477"   "gan ainm"          0.53488374
...
```

The first column is `tune_id` (lookup on thesession.org by appending
to `https://thesession.org/tunes/`). The third column is the normalised
NW score.

## Name search

Typed name queries route through `run_name_query` (see `Search.vue`'s
`nameQuery` method) which uses the trigram-based heuristic over the
`aliases` table, then sorts by score with shorter-alias-as-tiebreak. There's
no NW second pass — names are short enough that direct n-gram counts work
fine.

## Why string matching, not vector embeddings?

You could in principle embed both the audio and each tune into a fixed
vector and do nearest-neighbour search. FolkFriend doesn't, for several
reasons that fit its constraints:

- The transcriber already emits a discrete sequence in a 48-character
  alphabet, so n-grams are a perfectly natural representation.
- Aho-Corasick + NW are tiny (compiled into 200 kB of WASM) and run on
  any device, with no separate model file.
- Every tune in the corpus already has a contour string computed offline,
  so there's no inference cost at index-build time either.
- The result is interpretable — you can see *which* fragments matched,
  which is good for debugging.
