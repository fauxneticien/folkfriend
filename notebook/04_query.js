#!/usr/bin/env node
// Stage 04 — query the tune index with a contour string.
//
// Usage:  node 04_query.js [data/02_contour.json]
// Output: data/04_matches.json
//
// Mirrors app/src/services/worker.js runTranscriptionQuery. Downloads the
// tune index to notebook/tune-index.json on first run.

const fs = require('fs');
const path = require('path');
const https = require('https');
const wasm = require('./wasm/folkfriend.js');

const TUNE_INDEX_URL = 'https://folkfriend-app-data.web.app/folkfriend-non-user-data.json';
const TUNE_INDEX_PATH = process.env.TUNE_INDEX_PATH || path.join(__dirname, 'tune-index.json');

function download(url, destPath) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading tune index from ${url} ...`);
        const file = fs.createWriteStream(destPath);
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        });
        req.on('error', reject);
    });
}

async function main() {
    const inputPath = process.argv[2] || path.join(__dirname, 'data', '02_contour.json');
    const outputPath = path.join(__dirname, 'data', '04_matches.json');

    const { contourString } = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`Loaded contour: ${contourString}`);

    if (!fs.existsSync(TUNE_INDEX_PATH)) {
        await download(TUNE_INDEX_URL, TUNE_INDEX_PATH);
    }
    const indexBytes = fs.statSync(TUNE_INDEX_PATH).size;
    console.log(`Loading tune index (${(indexBytes / 1024 / 1024).toFixed(1)} MB) ...`);
    const t0 = Date.now();
    const indexData = JSON.parse(fs.readFileSync(TUNE_INDEX_PATH, 'utf8'));
    console.log(`Parsed index in ${Date.now() - t0} ms`);

    const ff = new wasm.FolkFriendWASM();
    const t1 = Date.now();
    ff.load_index_from_json_obj(indexData);
    console.log(`Loaded index into WASM in ${Date.now() - t1} ms`);

    const t2 = Date.now();
    const matches = JSON.parse(ff.run_transcription_query(contourString));
    const queryMs = Date.now() - t2;
    console.log(`Query: ${queryMs} ms, ${matches.length} results`);

    console.log('Top 3 matches:');
    for (const m of matches.slice(0, 3)) {
        console.log(`  ${m.score.toFixed(3)}  ${m.display_name}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ contourString, queryMs, matches }, null, 2));
    console.log(`Wrote ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
