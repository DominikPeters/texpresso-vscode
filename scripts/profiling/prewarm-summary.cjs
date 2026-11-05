#!/usr/bin/env node
/* Summarize finite cursor-prewarming experiments; never infer compositor paint. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const output=path.resolve(process.argv[2]||'artifacts/profile-prewarming');
const metadata=JSON.parse(fs.readFileSync(path.join(output,'metadata.json'),'utf8'));
const sessions=fs.readFileSync(path.join(output,'browser.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const compact=sessions.map(s=>({memory:{samples:s.memory?.length||0,peakTaskCount:Math.max(0,...(s.memory||[]).map(m=>m.tasks.length)),peakSummedTaskFootprintBytes:Math.max(0,...(s.memory||[]).map(m=>m.tasks.reduce((n,t)=>n+t.footprint,0))),accounting:'Per-task macOS footprint sum; not a deduplicated physical total or PSS'},fixture:s.fixture,mode:s.prewarmMode,codec:s.codec,autoRerun:s.autoRerun,uiChecks:s.uiChecks,errors:s.errors,
  prewarmEvents:s.prewarmEvents,
  compilerEvents:(s.nativeProfile||[]).filter(p=>p.stage==='compiler-rollback'||p.stage==='compiler-checkpoint'),
  phases:s.rapidPhases.map(p=>({...p,hostPrepareToFirstAppliedInputMs:p.hostPrepareToFirstAppliedInputMs>=0?p.hostPrepareToFirstAppliedInputMs:undefined})),
  inputs:s.inputs.map(i=>({id:i.id,sequence:i.sequence,scheduledAt:i.scheduledAt,injectedAt:i.injectedAt,hostAppliedAt:i.hostAppliedAt,
    timerDelayMs:i.timerDelayMs,exactPaintMs:i.exactPaintMs,caughtUpPaintMs:i.caughtUpPaintMs})),
  frames:s.frames.filter(f=>f.type==='image').map(f=>({request:f.request,page:f.page,sequence:f.sequence,mime:f.mime,bytes:f.bytes,patchBytes:f.patchBytes,
    svgPatch:f.svgPatch,rasterPatch:f.rasterPatch,cacheReference:f.cacheReference,upgrade:f.upgrade,exportMs:f.exportMs,
    dispatched:f.dispatched,paintedAt:f.paintedAt,cancelledBeforeMount:f.cancelledBeforeMount,supersededBeforePaint:f.supersededBeforePaint}))}));
for(const s of compact){
  const p=s.phases[0];
  if(!p)throw Error('Missing finite sentence phase in '+s.fixture);
  console.log(JSON.stringify({mode:s.mode,count:p.count,cadenceValid:p.validComparison,maxTimerLatenessMs:p.maxTimerLatenessMs,
    firstChangedPaintMs:p.firstPaintMs,firstKeyCaughtUpMs:s.inputs[0].caughtUpPaintMs,lastKeyPaintMs:p.lastKeyToPaint,
    hostPrepareToFirstInputMs:p.hostPrepareToFirstAppliedInputMs,visibleFrames:p.visibleFrames,coalescedInputs:p.coalescedInputs,
    staleAtPaint:p.staleAtPaint,prepare:s.prewarmEvents,errors:s.errors}));
}
const snapshot={metadata,endpoint:'Double requestAnimationFrame paint opportunity of an acknowledged source frame; not compositor presentation',sessions:compact};
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(snapshot,null,2)+'\n');
