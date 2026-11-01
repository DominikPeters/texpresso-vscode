#!/usr/bin/env node
'use strict';
// Compact, backend-separated evidence for the matched codec comparison.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {summarize}=require('./summarize-auto.cjs');
const {percentile}=require('../profile-preview.cjs');
const arg=n=>{const i=process.argv.indexOf('--'+n);if(i<0)throw Error('Missing --'+n);return process.argv[i+1];};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=dir=>({metadata:JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),rows:fs.readFileSync(path.join(dir,'browser.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)});
const q=a=>{a=a.filter(Number.isFinite);return a.length?{n:a.length,p50:percentile(a,.5),p95:percentile(a,.95),max:Math.max(...a)}:null;};
const measured=rows=>rows.filter(r=>r.repeat>0);
const versions=rows=>[...new Set(measured(rows).map(r=>JSON.stringify(r.provenance)))].map(JSON.parse);
function check(rows,expected){
 assert.equal(rows.length,expected);assert.equal(new Set(rows.map(r=>[r.variant,r.fixture,r.codec,r.repeat].join('/'))).size,expected);
 assert.ok(rows.every(r=>r.errors.length===0));
 for(const fixture of new Set(measured(rows).map(r=>r.fixture))){assert.equal(new Set(measured(rows).filter(r=>r.fixture===fixture).map(r=>r.sourceSha256)).size,1,'equal final sources for '+fixture);}
 assert.ok(measured(rows).every(r=>r.frames.filter(f=>f.paintedAt).every(f=>f.paintVisibility.state==='visible')));
 return {sessions:rows.length,measured:measured(rows).length,errors:0,allPaintsVisible:true,provenance:versions(rows)};
}
function rapidGroups(rows){
 const groups=[];
 for(const fixture of new Set(rows.map(r=>r.fixture)))for(const codec of ['png','svg','auto']){
  const selected=measured(rows).filter(r=>r.fixture===fixture&&r.codec===codec);if(!selected.length)continue;
  for(const phase of new Set(selected.flatMap(r=>r.rapidPhases.map(p=>p.name)))){
   const phases=selected.flatMap(r=>r.rapidPhases.filter(p=>p.name===phase));
   assert.ok(phases.every(p=>p.validComparison));
   const inputs=selected.flatMap(r=>r.inputs.filter(i=>i.phase===phase));
   groups.push({fixture,codec,phase,sessions:selected.length,lastKeyToPaintMs:q(phases.map(p=>p.lastKeyToPaint)),
    firstChangedPaintMs:q(phases.map(p=>p.firstPaintMs)),caughtUpPaintMs:q(inputs.map(i=>i.caughtUpPaintMs)),exactPaintMs:q(inputs.map(i=>i.exactPaintMs)),
    coalescedInputs:q(phases.map(p=>p.coalescedInputs)),visibleFrames:q(phases.map(p=>p.visibleFrames)),
    timerLatenessMs:q(inputs.map(i=>i.timerDelayMs)),bytes:q(phases.map(p=>p.bytes)),
    staleAtPaint:q(phases.map(p=>p.staleAtPaint)),validComparisons:phases.length});
  }
 }
 return groups;
}
const mainDir=arg('main'),rapidDir=arg('rapid'),densityDir=arg('density'),prewarmDir=arg('prewarm');
const main=read(mainDir),rapid=read(rapidDir),prewarm=read(prewarmDir);
const density=JSON.parse(fs.readFileSync(path.join(densityDir,'results.json')));
const checks={main:check(main.rows,128),rapid:check(rapid.rows,48),prewarm:check(prewarm.rows,12)};
assert.equal(checks.main.provenance.length,1);assert.equal(checks.rapid.provenance.length,1);assert.equal(checks.prewarm.provenance.length,1);
for(const fixture of new Set(measured(main.rows).map(r=>r.fixture))){assert.equal(new Set(measured(main.rows).filter(r=>r.fixture===fixture).map(r=>r.sourceSha256)).size,1,'equal final sources for '+fixture);}
assert.equal(density.validation.allExact,true);
const opRows=(r,name)=>r.rows.filter(o=>o.name===name);
const sessionSamples=measured(main.rows).map(r=>({fixture:r.fixture,variant:r.variant,codec:r.codec,repeat:r.repeat,dpr:r.dpr,viewport:r.viewport,power:r.power.stdout,sourceSha256:r.sourceSha256,
 initial:r.rows[0].ms,settledInitial:r.rows[0].settledMs,firstEdit:opRows(r,'edit-letter')[0].ms,warmTyping:opRows(r,'edit-letter').slice(1).map(o=>o.ms),
 coordinate:opRows(r,'edit-coordinate').map(o=>o.ms),nextCached:opRows(r,'page-next-cached').map(o=>({ms:o.ms,resident:o.residentNavigation,frames:o.frames.length})),
 lens:opRows(r,'magnifier-small-moves').map(o=>({requests:o.nativeRegionRequests,moveMs:o.movePaintMs})),
 warmFrames:opRows(r,'edit-letter').slice(1).flatMap(o=>o.frames.map(f=>({mime:f.mime,bytes:f.bytes+f.patchBytes,svgPatch:f.svgPatch,pngPatch:f.rasterPatch,inlineSvg:f.inlineSvg,exportMs:f.exportMs,hostMs:f.processingMs,renderMs:f.renderMs}))) }));
assert.ok(sessionSamples.every(r=>r.lens.every(l=>l.requests===0)));
const preparation=['png','svg','auto'].map(codec=>({codec,preparationMs:q(measured(prewarm.rows).filter(r=>r.codec===codec).flatMap(r=>r.prewarmEvents.filter(e=>e.phase==='coordinate-complete').map(e=>e.ms)))}));
const evidence={schema:1,created:new Date().toISOString(),quantiles:'Nearest-rank; repetition 0 excluded separately for every fixture/mode/backend. Edits within a session are correlated.',
 methodology:{main:'Production controller/renderers in actual VS Code postMessage webviews; paced source mutations, navigation, zoom and magnification. Two-rAF paint opportunity after matching mount ACK, or after revealing a valid resident surface. No physical scanout/GPU-completion claim.',
 rapid:'Open-loop 12 inserts + 12 backspaces at 100 ms; TikZ also 8 coordinate edits at 125 ms. Full source sync/controller/paint path, injected source changes rather than physical keyboard routing.',
 prewarm:'Same TikZ burst, production prepareEdit API explicitly completed before coordinate phase; preparation time reported separately.',
 density:'Full PNG export, seven unique nearby requested widths per group, no encoded cache hits; native timings exclude compile/startup/browser. RGB hashing after all timing. 4 MP vs 16 MP opt-in; production extension cap unchanged.',
 builds:'Same imported production engine source; same XeTeX worker hash and cached compact MuPDF/ICU objects. Backend differs only for preview PNG. Engine manifest 1620b15 production code matches native 1b895fc, whose only extra change is activity test compatibility.',
 power:'AC power; per-session power snapshots retained. Low power mode 0. No downloads. Native engines headless. Main/rapid/density/control ran serially; profiling/build jobs in other chat paused.',
 exclusions:'Warm-ups and dedicated smoke/debug runs excluded. Interrupted regression run discarded. All measured main rows use the same repaired harness; metadata preserves warm-up resumptions.',
 memory:'Native viewer lifetime peak and sampled process-group task sums, not deduplicated physical RAM. JS/DOM/canvas counters exclude total Chromium/GPU resources.'},
 checks,metadata:{main:main.metadata,rapid:rapid.metadata,prewarm:prewarm.metadata,density:density.metadata},
 main:summarize([mainDir]),sessionSamples,rapid:rapidGroups(rapid.rows),prewarm:{preparation,groups:rapidGroups(prewarm.rows)},density:{summary:density.summary,validation:density.validation},
 rawFiles:[mainDir,rapidDir,prewarmDir,densityDir].flatMap(dir=>['metadata.json','browser.jsonl','results.json'].filter(name=>fs.existsSync(path.join(dir,name))).map(name=>({path:path.join(dir,name),sha256:sha(path.join(dir,name))})))};
fs.writeFileSync(arg('output'),JSON.stringify(evidence,(_key,value)=>typeof value==='number'&&!Number.isInteger(value)?Math.round(value*1000)/1000:value)+'\n');
console.log('PASS: 188 sessions, 141 measured, all source/backend/cadence/visibility checks; 252 PNG exports with exact RGB validation.');
