#!/usr/bin/env node
/* ALISA semantic-memory model setup (Node 18+, no dependencies). Run once, on a computer WITH internet, inside the ALISA folder:
     node setup-embedding-model.js                                   # onnxruntime-web (if missing) + all-MiniLM-L6-v2 (quantized, ~23 MB) + vocab
     node setup-embedding-model.js --model <url|path> --vocab <url|path>   # any BERT-style sentence-embedding ONNX + its vocab.txt
   Result:  models/embed/model.onnx + models/embed/vocab.txt  (and vendor/ort* if they were missing — shared with the speaker-verification feature).
   Requirements for a custom model: inputs input_ids / attention_mask (/ token_type_ids), output last_hidden_state [1,T,D] (or a pooled [1,D]); uncased BERT WordPiece vocab.
   The default URLs below are NOT verified from the build environment — if one 404s, download the files yourself and pass --model/--vocab.
   After installing: restart server.js, reload ALISA twice, then Settings → ALISA MIND → "Test semantic". */
'use strict';
const fs = require('fs'), path = require('path');
const ORT = '1.20.1', ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT + '/dist/';
const MODEL = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', VOCAB = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/vocab.txt';
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const dest = (d, f) => { fs.mkdirSync(path.join(__dirname, d), { recursive: true }); return path.join(__dirname, d, f); };
async function get(src, to, check) {
  process.stdout.write('  ' + path.basename(to) + ' … ');
  try {
    const b = /^https?:/.test(src) ? Buffer.from(await (async () => { const r = await fetch(src); if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })()) : fs.readFileSync(src);
    if (check) check(b); fs.writeFileSync(to, b); console.log((b.length / 1048576).toFixed(2) + ' MB ok'); return true;
  } catch (e) { console.log('FAILED (' + e.message + ')'); return false; }
}
(async () => {
  let ok = true;
  console.log('1) onnxruntime-web ' + ORT + ' → vendor/ (skipped if already present)');
  for (const f of ['ort.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) { const to = dest('vendor', f); if (fs.existsSync(to)) { console.log('  ' + f + ' already present'); continue; } ok = (await get(ORT_BASE + f, to)) && ok; }
  console.log('2) vocabulary → models/embed/vocab.txt');
  ok = (await get(arg('--vocab') || VOCAB, dest('models/embed', 'vocab.txt'), b => { const t = b.toString('utf8'); if (!/^\[CLS\]$/m.test(t) || !/^\[SEP\]$/m.test(t) || !/^\[UNK\]$/m.test(t)) throw new Error('not a BERT vocab.txt'); })) && ok;
  console.log('3) embedding model → models/embed/model.onnx');
  ok = (await get(arg('--model') || MODEL, dest('models/embed', 'model.onnx'), b => { if (b.length < 1e6) throw new Error('file too small to be a model (' + b.length + ' bytes)'); })) && ok;
  console.log(ok ? '\nDone. Restart server.js, reload ALISA twice, open Settings → ALISA MIND → "Test semantic".' : '\nSome files failed. Download them manually and pass --model <file> --vocab <file>. Until then ALISA keeps using keyword retrieval.');
  process.exit(ok ? 0 : 1);
})();
