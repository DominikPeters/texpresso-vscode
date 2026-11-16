#!/usr/bin/env node
'use strict';
// Compact source-free output; never copies manuscript text, frames or traces.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const [damageDir,sharpDir,legacyDir,output]=process.argv.slice(2);
const read=(directory,file)=>JSON.parse(fs.readFileSync(path.join(directory,file)));
const rows=(directory,file)=>fs.readFileSync(path.join(directory,file),'utf8').trim().split('\n').map(JSON.parse);
const stats=values=>{
  if(!values.length)return undefined;
  const a=[...values].sort((a,b)=>a-b),n=a.length;
  return {n,median:n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2,p95:a[Math.ceil(n*.95)-1],min:a[0],max:a[n-1]};
};
const damage=rows(damageDir,'samples.jsonl').filter(r=>!r.warmup),native=[];
assert.equal(read(damageDir,'complete.json').exactComparisons,63);
for(const fixture of [...new Set(damage.map(r=>r.fixture))])for(const scenario of [...new Set(damage.filter(r=>r.fixture===fixture).map(r=>r.scenario))]) {
  const baseline=damage.filter(r=>r.fixture===fixture&&r.scenario===scenario&&r.variant==='baseline');
  const candidate=damage.filter(r=>r.fixture===fixture&&r.scenario===scenario&&r.variant==='damage');
  assert.equal(baseline.length,6);assert.equal(candidate.length,6);
  assert.ok(candidate.every(r=>r.damage.exact));
  native.push({fixture,scenario,grid:candidate[0].grid,clip:candidate[0].clip,pixels:candidate[0].pixels,
    baselineExportMs:stats(baseline.map(r=>r.exportMs)),baselineDrawMs:stats(baseline.map(r=>r.stages['png-draw'])),
    candidateAnalysisMs:stats(candidate.map(r=>r.damage.analysisMs)),candidateDrawAndCopyMs:stats(candidate.map(r=>r.damage.renderMs)),
    // Excludes the full verification render and metadata/cache bookkeeping.
    candidateComponentSumMs:stats(candidate.map(r=>r.damage.analysisMs+r.damage.renderMs+r.stages['png-compare']+r.stages['png-encode'])),
    changedCells:candidate.map(r=>r.damage.changedCells),totalCells:candidate[0].damage.totalCells,
    operations:stats(candidate.map(r=>r.damage.operations)),pngBytes:stats(candidate.map(r=>r.pngBytes)),
    supported:candidate.every(r=>r.damage.supported),pixelHashes:candidate.map(r=>r.pixelSha256)});
}
function summarizeBrowser(dir,variant) {
  // Repeated fixture/DPR entries are instrumentation warmups or the explicitly
  // recorded before/after fractional-position check. The last is authoritative.
  const all=rows(dir,'browser.jsonl'),latest=new Map();
  for(const row of all)latest.set(row.fixture+':'+row.dpr,row);
  return [...latest.values()].map(row=>{
    assert.deepEqual(row.errors,[]);
    const inputs=row.inputs.filter(r=>Number.isFinite(r.caughtUpPaintMs));
    const samples=row.surfaceSamples.filter(s=>row.rapidPhases.some(p=>s.at>=p.start&&s.at<=p.end)&&Number.isFinite(s.density));
    const sharp=samples.filter(s=>s.density>=.98 || (s.detailCoversVisible&&s.detailDensity>=.98));
    const memory=series=>{
      const totals=(series||[]).map(s=>s.tasks.filter(t=>!t.zombie));
      const cpu=new Map();
      for(const ts of totals)for(const t of ts) {
        const before=cpu.get(t.pid);
        cpu.set(t.pid,before?[Math.min(before[0],t.cpuNs),Math.max(before[1],t.cpuNs)]:[t.cpuNs,t.cpuNs]);
      }
      return {samples:totals.length,maxTaskRssSum:Math.max(0,...totals.map(ts=>ts.reduce((n,t)=>n+t.rss,0))),
        maxTaskFootprintSum:Math.max(0,...totals.map(ts=>ts.reduce((n,t)=>n+t.footprint,0))),
        observedTaskCpuSeconds:[...cpu.values()].reduce((n,[lo,hi])=>n+hi-lo,0)/1e9};
    };
    const result={variant,fixture:row.fixture,dpr:row.dpr,viewport:row.viewport,ua:row.ua,
      caughtUpPaintMs:stats(inputs.map(r=>r.caughtUpPaintMs)),exactPaintMs:stats(inputs.map(r=>r.exactPaintMs).filter(Number.isFinite)),
      fixedZoomSamples:samples.length,sharpFixedZoomSamples:sharp.length,density:stats(samples.map(s=>s.density)),
      deviceOriginError:stats(samples.flatMap(s=>(s.physicalOrigin||[]).map(n=>Math.abs(n-Math.round(n))))),
      oldestPendingInputAgeMs:stats(samples.map(s=>s.oldestPendingInputAgeMs)),
      mountedCanvasPixels:stats(row.surfaceSamples.map(s=>s.canvasPixels)),decodedCacheEstimate:stats(row.surfaceSamples.map(s=>s.residentBytes)),
      nativeMemory:memory(row.memory),browserMemory:memory(row.browserMemory),browserProcesses:row.browserProcesses?.map(p=>({type:p.type,id:p.id})),
      phases:row.rapidPhases.map(p=>({name:p.name,inputs:p.count,visibleFrames:p.visibleFrames,lastKeyToPaint:p.lastKeyToPaint,staleAtPaint:p.staleAtPaint})),
      activeNativeExportMs:stats(row.frames.filter(f=>f.type==='image'&&f.page===0&&f.paintedAt).map(f=>f.exportMs).filter(Number.isFinite))};
    return result;
  });
}
const sharp=summarizeBrowser(sharpDir,'surfaces'),legacy=summarizeBrowser(legacyDir,'legacy');
const fractionalBefore=rows(sharpDir,'browser.jsonl').find(r=>r.dpr===1.25);
const beforeSamples=fractionalBefore.surfaceSamples.filter(s=>fractionalBefore.rapidPhases.some(p=>s.at>=p.start&&s.at<=p.end));
const result={damageMetadata:read(damageDir,'metadata.json'),exactComparisons:read(damageDir,'complete.json'),native,
  browser:{sharpMetadata:read(sharpDir,'metadata.json'),legacyMetadata:read(legacyDir,'metadata.json'),
    fractionalOriginBefore:stats(beforeSamples.flatMap(s=>(s.physicalOrigin||[]).map(n=>Math.abs(n-Math.round(n))))),cases:[...sharp,...legacy]}};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(output);
