#!/usr/bin/env node
// Build a static HTML notebook that renders each pipeline stage as a "cell".
// Reads data/*.json + data/03_abc.txt and writes notebook.html.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'notebook.html');

const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function readJSON(name) {
    const p = path.join(DATA, name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(name) {
    const p = path.join(DATA, name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
}

function previewFloatArray(arr, head = 16, tail = 16) {
    const n = arr.length;
    if (n <= head + tail) return arr.map(v => v.toFixed(6)).join(', ');
    const h = arr.slice(0, head).map(v => v.toFixed(6));
    const t = arr.slice(n - tail).map(v => v.toFixed(6));
    return `[${h.join(', ')}, … ${n - head - tail} more …, ${t.join(', ')}]`;
}

function waveformSVG(samples, width = 800, height = 120) {
    const buckets = width;
    const step = samples.length / buckets;
    const mins = new Float32Array(buckets);
    const maxs = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * step);
        const end = Math.min(samples.length, Math.floor((b + 1) * step));
        let mn = Infinity, mx = -Infinity;
        for (let i = start; i < end; i++) {
            const v = samples[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        if (mn === Infinity) { mn = 0; mx = 0; }
        mins[b] = mn;
        maxs[b] = mx;
    }
    let peak = 0;
    for (let i = 0; i < buckets; i++) {
        peak = Math.max(peak, Math.abs(mins[i]), Math.abs(maxs[i]));
    }
    if (peak === 0) peak = 1;
    const yMid = height / 2;
    const yScale = (height / 2) / peak;
    let path = '';
    for (let b = 0; b < buckets; b++) {
        const y1 = yMid - maxs[b] * yScale;
        const y2 = yMid - mins[b] * yScale;
        path += `M${b} ${y1.toFixed(2)}L${b} ${y2.toFixed(2)}`;
    }
    return `<svg class="waveform" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#0d1117"/>
  <line x1="0" y1="${yMid}" x2="${width}" y2="${yMid}" stroke="#30363d" stroke-width="1"/>
  <path d="${path}" stroke="#58a6ff" stroke-width="1" fill="none"/>
</svg>`;
}

function cell({ stage, title, description, command, inputHTML, outputHTML }) {
    return `
<section class="cell">
  <div class="cell-header">
    <span class="badge">${esc(stage)}</span>
    <h2>${esc(title)}</h2>
  </div>
  <p class="description">${esc(description)}</p>
  <div class="prompt"><span class="prompt-label">In&nbsp;[${esc(stage)}]:</span><pre class="command">$ ${esc(command)}</pre></div>
  <div class="io-grid">
    <div class="io io-input">
      <h3>Input</h3>
      ${inputHTML}
    </div>
    <div class="io io-output">
      <h3>Output</h3>
      ${outputHTML}
    </div>
  </div>
</section>`;
}

function fmtKV(obj) {
    return `<table class="kv"><tbody>${Object.entries(obj).map(
        ([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code></td></tr>`
    ).join('')}</tbody></table>`;
}

function build() {
    const stage1 = readJSON('01_decoded-audio.json');
    const stage2 = readJSON('02_contour.json');
    const stage3Abc = readText('03_abc.txt');
    const stage4 = readJSON('04_matches.json');

    const cells = [];

    // --- Stage 01 ---
    if (stage1) {
        const samples = stage1.channelData;
        const inputHTML = fmtKV({
            file: stage1.sourceFile,
            bytes: stage1.sourceBytes,
        }) + `<p class="note">Raw WAV bytes (binary container with PCM samples + format header).</p>`;
        const outputHTML = `
            ${fmtKV({
                sampleRate: stage1.sampleRate + ' Hz',
                length: stage1.length + ' samples',
                durationSec: stage1.durationSec.toFixed(3) + ' s',
                channels: 1,
            })}
            <h4>Waveform (channel 0, downsampled)</h4>
            ${waveformSVG(samples)}
            <h4>channelData preview</h4>
            <pre class="data">${esc(previewFloatArray(samples))}</pre>`;
        cells.push(cell({
            stage: '01',
            title: 'Decode WAV',
            description: 'Decode container bytes to Float32 PCM samples. Auto-resamples to 48 kHz via OfflineAudioContext (identical to the browser path in app/src/services/audio.js).',
            command: `node 01_decode-wav.js ${stage1.sourceFile}`,
            inputHTML,
            outputHTML,
        }));
    }

    // --- Stage 02 ---
    if (stage2) {
        const inputHTML = fmtKV({
            sampleRate: stage2.sampleRate + ' Hz',
            length: (stage2.numWindows * stage2.specWindowSize) + ' samples used',
            specWindowSize: stage2.specWindowSize,
            numWindows: stage2.numWindows,
        }) + `<p class="note">Float32 PCM array sliced into 1024-sample windows.</p>`;
        const outputHTML = `
            ${fmtKV({
                contourLength: stage2.contourString.length,
                feedMs: stage2.timing.feedMs,
                transcribeMs: stage2.timing.transcribeMs,
            })}
            <h4>Contour string</h4>
            <pre class="data">${esc(stage2.contourString)}</pre>
            <p class="note">Each character encodes a MIDI pitch (a=C2 … V=B6). Capitals indicate held notes, lowercase indicates onsets; <code>x</code> = rest, others encode quavers/triplets.</p>`;
        cells.push(cell({
            stage: '02',
            title: 'Transcribe PCM → contour string',
            description: 'Feed 1024-sample PCM windows into the WASM core. Internally: blackman window → FFT → autocorrelation-style feature (frames × 48 MIDI bins) → beam-search lattice path → octave-corrected contour.',
            command: `node 02_transcribe.js data/01_decoded-audio.json`,
            inputHTML,
            outputHTML,
        }));
    }

    // --- Stage 03 ---
    if (stage3Abc && stage2) {
        const inputHTML = `
            <h4>Contour string</h4>
            <pre class="data">${esc(stage2.contourString)}</pre>`;
        const outputHTML = `
            <h4>ABC notation</h4>
            <pre class="data abc">${esc(stage3Abc.trim())}</pre>
            <p class="note">Pure transformation: maps each contour character to ABC pitch letters and infers the most likely key/mode.</p>`;
        cells.push(cell({
            stage: '03',
            title: 'Contour string → ABC notation',
            description: 'Render the transcribed contour as human-readable ABC notation (the standard text format for folk music).',
            command: `node 03_contour-to-abc.js data/02_contour.json`,
            inputHTML,
            outputHTML,
        }));
    }

    // --- Stage 04 ---
    if (stage4) {
        const inputHTML = `
            <h4>Contour string</h4>
            <pre class="data">${esc(stage4.contourString)}</pre>
            <p class="note">Tune index loaded from <code>tune-index.json</code> (downloaded once from folkfriend-app-data.web.app).</p>`;
        const top = stage4.matches.slice(0, 5);
        const rows = top.map((m, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${m.score.toFixed(3)}</td>
              <td>${esc(m.display_name)}</td>
              <td><code>${esc(m.setting && m.setting.mode ? m.setting.mode : '')}</code></td>
              <td><code>${esc(m.setting && m.setting.meter ? m.setting.meter : '')}</code></td>
              <td><code>${esc(m.setting_id || '')}</code></td>
            </tr>`).join('');
        const outputHTML = `
            ${fmtKV({
                queryMs: stage4.queryMs,
                totalResults: stage4.matches.length,
            })}
            <h4>Top 5 matches</h4>
            <table class="matches">
              <thead><tr><th>#</th><th>Score</th><th>Tune</th><th>Mode</th><th>Meter</th><th>Setting ID</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <p class="note">Two-pass search: fast n-gram heuristic, then Needleman–Wunsch alignment refinement.</p>`;
        cells.push(cell({
            stage: '04',
            title: 'Query tune index',
            description: 'Look up the contour string against the thesession.org-derived tune index. Returns the top 20 candidates with similarity scores.',
            command: `node 04_query.js data/02_contour.json`,
            inputHTML,
            outputHTML,
        }));
    }

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FolkFriend Pipeline — Notebook</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 980px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    background: #ffffff;
    color: #24292f;
    line-height: 1.55;
  }
  h1 { font-size: 1.85rem; margin: 0 0 0.4rem; }
  h2 { font-size: 1.2rem; margin: 0; }
  h3 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.04em; color: #57606a; margin: 0 0 0.5rem; }
  h4 { font-size: 0.85rem; margin: 0.9rem 0 0.35rem; color: #57606a; }
  header.page { border-bottom: 1px solid #d0d7de; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
  header.page p { color: #57606a; margin: 0.25rem 0 0; }
  .cell {
    border: 1px solid #d0d7de;
    border-radius: 8px;
    padding: 1.1rem 1.25rem;
    margin: 1.25rem 0;
    background: #f6f8fa;
  }
  .cell-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.35rem; }
  .badge {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    background: #218bff;
    color: white;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .description { color: #57606a; margin: 0.15rem 0 0.9rem; }
  .prompt { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 1rem; }
  .prompt-label { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #218bff; font-size: 0.85rem; padding-top: 0.55rem; }
  .command {
    flex: 1;
    background: #0d1117;
    color: #c9d1d9;
    padding: 0.55rem 0.8rem;
    border-radius: 6px;
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.85rem;
    overflow-x: auto;
  }
  .io-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.9rem;
  }
  @media (max-width: 760px) { .io-grid { grid-template-columns: 1fr; } }
  .io {
    background: white;
    border: 1px solid #d8dee4;
    border-radius: 6px;
    padding: 0.8rem 0.95rem;
  }
  .io-output { background: #f0fdf4; }
  pre.data, pre.command {
    white-space: pre-wrap;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.78rem;
  }
  pre.data {
    background: #ffffff;
    border: 1px solid #eaeef2;
    padding: 0.55rem 0.7rem;
    border-radius: 4px;
    margin: 0.25rem 0 0.5rem;
    max-height: 240px;
    overflow: auto;
  }
  pre.data.abc { white-space: pre; word-break: normal; }
  table.kv, table.matches { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
  table.kv th { text-align: left; padding: 0.18rem 0.6rem 0.18rem 0; color: #57606a; font-weight: 500; width: 35%; vertical-align: top; }
  table.kv td { padding: 0.18rem 0; word-break: break-word; }
  table.matches th, table.matches td { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eaeef2; text-align: left; }
  table.matches th { color: #57606a; font-weight: 600; }
  .note { color: #57606a; font-size: 0.82rem; margin: 0.4rem 0 0; }
  .waveform { width: 100%; height: 120px; display: block; border-radius: 4px; }
  code { background: #eaeef2; padding: 0.05rem 0.35rem; border-radius: 3px; font-size: 0.82rem; }
  footer { margin-top: 2rem; color: #57606a; font-size: 0.85rem; }
</style>
</head>
<body>
<header class="page">
  <h1>FolkFriend pipeline — notebook</h1>
  <p>Each cell runs one stage of the audio → tune-match pipeline, persisting its output to <code>data/</code> for the next stage to consume. Mirrors the browser path in <code>app/src/services/audio.js</code> and <code>worker.js</code>.</p>
</header>
${cells.join('\n')}
<footer>Generated by <code>build-notebook.js</code> at ${new Date().toISOString()}.</footer>
</body>
</html>
`;

    fs.writeFileSync(OUT, html);
    console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB, ${cells.length} cells)`);
}

build();
