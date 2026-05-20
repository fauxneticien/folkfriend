#!/usr/bin/env node
// Stage 02 — transcribe PCM to a contour string.
//
// Usage:  node 02_transcribe.js [data/01_decoded-audio.json]
// Output: data/02_contour.json
//
// Mirrors app/src/services/worker.js feedSinglePCMWindow + transcribePCMBuffer.

const fs = require('fs');
const path = require('path');
const wasm = require('./wasm/folkfriend.js');

const SPEC_WINDOW_SIZE = 1024;

function main() {
    const inputPath = process.argv[2] || path.join(__dirname, 'data', '01_decoded-audio.json');
    const outputPath = path.join(__dirname, 'data', '02_contour.json');

    const decoded = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const { sampleRate, length, channelData } = decoded;
    console.log(`Loaded ${inputPath}: sampleRate=${sampleRate}, length=${length}`);

    const ff = new wasm.FolkFriendWASM();
    ff.set_sample_rate(sampleRate);

    const numWindows = Math.floor(length / SPEC_WINDOW_SIZE);
    if (numWindows === 0) {
        throw new Error('PCM signal too short for a single window');
    }
    console.log(`Feeding ${numWindows} PCM windows of ${SPEC_WINDOW_SIZE} samples...`);

    const t0 = Date.now();
    for (let i = 0; i < numWindows; i++) {
        const ptr = ff.alloc_single_pcm_window();
        const view = ff.get_allocated_pcm_window(ptr);
        for (let j = 0; j < SPEC_WINDOW_SIZE; j++) {
            view[j] = channelData[i * SPEC_WINDOW_SIZE + j];
        }
        ff.feed_single_pcm_window(ptr);
    }
    const feedMs = Date.now() - t0;

    const t1 = Date.now();
    const contourString = ff.transcribe_pcm_buffer();
    const transcribeMs = Date.now() - t1;

    console.log(`Feed: ${feedMs} ms, transcribe: ${transcribeMs} ms`);
    console.log(`Contour string (length ${contourString.length}): ${contourString}`);

    const out = {
        sourceFile: path.relative(__dirname, inputPath),
        sampleRate,
        specWindowSize: SPEC_WINDOW_SIZE,
        numWindows,
        contourString,
        timing: { feedMs, transcribeMs },
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
    console.log(`Wrote ${outputPath}`);
}

main();
