#!/usr/bin/env node
// Stage 01 — decode WAV (mirrors app/src/services/audio.js:18-55).
//
// Usage:  node 01_decode-wav.js [path/to/input.wav]
// Output: data/01_decoded-audio.json
//
// We use node-web-audio-api's OfflineAudioContext so decodeAudioData() auto-
// resamples to 48 kHz identically to the browser path in the Vue app.

const fs = require('fs');
const path = require('path');
const { OfflineAudioContext } = require('node-web-audio-api');

const SAMPLE_RATE = 48000;

async function main() {
    const inputPath = process.argv[2] || path.join(__dirname, 'input.wav');
    const outputPath = path.join(__dirname, 'data', '01_decoded-audio.json');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const wavBytes = fs.readFileSync(inputPath);
    console.log(`Read ${inputPath} (${wavBytes.length} bytes)`);

    // Probe length by decoding once at default rate to learn duration, then
    // re-decode into a correctly-sized OfflineAudioContext. (Mirrors how the
    // app reads `audio.duration` from <audio> metadata.)
    const probeCtx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
    const probeBuffer = await probeCtx.decodeAudioData(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));

    const offlineCtx = new OfflineAudioContext({
        numberOfChannels: 1,
        length: probeBuffer.length,
        sampleRate: SAMPLE_RATE,
    });
    const decoded = await offlineCtx.decodeAudioData(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));

    const channelData = decoded.getChannelData(0);
    const sampleRate = decoded.sampleRate;
    const length = decoded.length;
    const durationSec = decoded.duration;

    console.log(`Decoded: sampleRate=${sampleRate} Hz, length=${length} samples, duration=${durationSec.toFixed(3)} s`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const out = {
        sourceFile: path.relative(__dirname, inputPath),
        sourceBytes: wavBytes.length,
        sampleRate,
        length,
        durationSec,
        channelData: Array.from(channelData),
    };
    fs.writeFileSync(outputPath, JSON.stringify(out));
    console.log(`Wrote ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
