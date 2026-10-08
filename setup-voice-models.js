#!/usr/bin/env node
/* ALISA voice-model setup (Node 18+, no dependencies). Run once, on a computer WITH internet, inside the ALISA folder:
     node setup-voice-models.js                      # downloads onnxruntime-web into ./vendor and tries the default speaker model
     node setup-voice-models.js --model <url|path>   # use a speaker model you downloaded yourself (recommended if the default fails)
   Result:  vendor/ort.min.js (+ .wasm/.mjs)   and   models/speaker.onnx
   Model must be EXACTLY voxceleb_resnet34_LM.onnx (size + SHA-256 are enforced below). `node setup-voice-models.js --verify` checks what is installed. */
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
// Voice-model test build: ONLY this exact model is accepted (must equal EXPECT in security.js; a test keeps them in sync). Anything else is rejected and NOT written.
const EXPECTED={sha256:'7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068',bytes:26530309};
const checkModel=b=>{const h=crypto.createHash('sha256').update(b).digest('hex');return b.length!==EXPECTED.bytes?'size '+b.length+' != expected '+EXPECTED.bytes:h!==EXPECTED.sha256?'SHA-256 '+h+' != expected '+EXPECTED.sha256:null};
const ORT='1.20.1',BASE='https://cdn.jsdelivr.net/npm/onnxruntime-web@'+ORT+'/dist/';
const DEFAULT_MODEL='https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx';   // NOT verified — pass --model if this 404s
const out=(d,f)=>{fs.mkdirSync(path.join(__dirname,d),{recursive:true});return path.join(__dirname,d,f)};
async function get(url,dest){process.stdout.write('  '+path.basename(dest)+' … ');
 try{const r=await fetch(url);if(!r.ok)throw new Error('HTTP '+r.status);const b=Buffer.from(await r.arrayBuffer());if(b.length<50000||b.slice(0,1).toString()=='<')throw new Error('unexpected content ('+b.length+' bytes)');fs.writeFileSync(dest,b);console.log((b.length/1048576).toFixed(1)+' MB ok');return true}
 catch(e){console.log('FAILED ('+e.message+')');return false}}
async function main(){
 if(process.argv.includes('--verify')){const f=path.join(__dirname,'models','speaker.onnx');let e;try{e=checkModel(fs.readFileSync(f))}catch(x){e='cannot read models/speaker.onnx ('+x.code+')'}
  const miss=['ort.min.js','ort-wasm-simd-threaded.wasm','ort-wasm-simd-threaded.mjs'].filter(n=>!fs.existsSync(path.join(__dirname,'vendor',n)));
  console.log(e?'models/speaker.onnx: REJECTED — '+e:'models/speaker.onnx: OK (exact pinned model)');console.log(miss.length?'vendor/: MISSING '+miss.join(', '):'vendor/: all three runtime files present (no pinned hash is known for them; sanity-checked at download only)');process.exit(e||miss.length?1:0)}
 const mi=process.argv.indexOf('--model'),src=mi>0?process.argv[mi+1]:DEFAULT_MODEL;let ok=true;
 console.log('1) onnxruntime-web '+ORT+' → vendor/');
 for(const f of['ort.min.js','ort-wasm-simd-threaded.wasm','ort-wasm-simd-threaded.mjs'])ok=await get(BASE+f,out('vendor',f))&&ok;
 console.log('2) speaker model → models/speaker.onnx (must be the exact pinned model)');
 let buf=null;
 if(src&&!/^https?:/.test(src)){try{buf=fs.readFileSync(src)}catch(e){console.log('  FAILED ('+e.message+')');ok=false}}
 else if(src){try{const r=await fetch(src);if(!r.ok)throw new Error('HTTP '+r.status);buf=Buffer.from(await r.arrayBuffer())}catch(e){console.log('  FAILED ('+e.message+')');ok=false}}
 if(buf){const bad=checkModel(buf);if(bad){console.log('  REJECTED — not the pinned model: '+bad+'\n  Nothing was written to models/.');ok=false}else{fs.writeFileSync(out('models','speaker.onnx'),buf);console.log('  speaker.onnx '+(buf.length/1048576).toFixed(1)+' MB — size and SHA-256 verified')}}
 console.log(ok?'\nDone. Restart server.js, reload ALISA twice, then open Settings → My Voice (status must read MODEL_READY) and RE-ENROLL.'
  :'\nSetup FAILED. Provide the exact pinned model (voxceleb_resnet34_LM.onnx, SHA-256 '+EXPECTED.sha256+') with:\n  node setup-voice-models.js --model /path/to/voxceleb_resnet34_LM.onnx');
 process.exit(ok?0:1)}
if(require.main===module)main();else module.exports={EXPECTED,checkModel};
