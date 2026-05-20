#!/usr/bin/env node
// Stage 03 — contour string -> ABC notation.
//
// Usage:  node 03_contour-to-abc.js [data/02_contour.json]
// Output: data/03_abc.txt
//
// Mirrors app/src/services/worker.js contourToAbc.

const fs = require('fs');
const path = require('path');
const wasm = require('./wasm/folkfriend.js');

function main() {
    const inputPath = process.argv[2] || path.join(__dirname, 'data', '02_contour.json');
    const outputPath = path.join(__dirname, 'data', '03_abc.txt');

    const { contourString } = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`Loaded contour (${contourString.length} chars): ${contourString}`);

    const ff = new wasm.FolkFriendWASM();
    const abc = ff.contour_to_abc(contourString);

    console.log('---- ABC ----');
    console.log(abc);
    console.log('-------------');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, abc);
    console.log(`Wrote ${outputPath}`);
}

main();
