#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {percentile}=require('../profile-preview.cjs');
const q=values=>{values=values.filter(Number.isFinite);return values.length?{n:values.length,p50:percentile(values,.5),p95:percentile(values,.95)}:undefined;};
function summarize(directories){
 const runs=directories.flatMap(directory=>fs.readFileSync(path.join(directory,'browser.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>({...JSON.parse(s),cpuTimebase:JSON.parse(fs.readFileSync(path.join(directory,'metadata.json'),'utf8')).cpuTimebase})));
 const groups=[];
 for(const fixture of [...new Set(runs.map(r=>r.fixture))])for(const codec of ['png','svg','auto']){
  const selected=runs.filter(r=>r.fixture===fixture&&r.codec===codec&&r.repeat>0);if(!selected.length)continue;
  const operations={};
  for(const name of new Set(selected.flatMap(r=>r.rows.map(o=>o.name)))){
   const rows=selected.flatMap(r=>r.rows.filter(o=>o.name===name));
   operations[name]={firstPaintMs:q(rows.map(o=>o.ms)),settledPaintMs:q(rows.map(o=>o.settledMs)),
    frames:q(rows.map(o=>o.frames.length)),bytes:q(rows.map(o=>o.frames.reduce((n,f)=>n+f.bytes+f.patchBytes,0))),
    svgFirst:rows.filter(o=>o.firstMime==='image/svg+xml').length,svgFinal:rows.filter(o=>o.finalMime==='image/svg+xml').length,
    patchCount:rows.flatMap(o=>o.frames).filter(f=>f.rasterPatch||f.svgPatch).length,
    controllerMs:q(rows.map(o=>o.frames.reduce((n,f)=>n+(f.processingMs||0),0))),
    decodeApplyMs:q(rows.map(o=>o.frames.reduce((n,f)=>n+(f.dispatchToDecoded||0),0))),
    finalKeyMs:q(rows.map(o=>o.lastInputAt===undefined?undefined:o.frames[0].paintedAt-o.lastInputAt))};
  }
  const firstEdits=selected.map(r=>r.rows.find(o=>o.name==='edit-letter')).filter(Boolean);
  const warmEdits=selected.flatMap(r=>r.rows.filter(o=>o.name==='edit-letter').slice(1));
  const stages={};
  for(const stage of new Set(selected.flatMap(r=>r.nativeProfile.map(p=>p.stage)))) stages[stage]=q(selected.map(r=>r.nativeProfile.filter(p=>p.stage===stage).reduce((n,p)=>n+p.ms,0)));
  const memory=selected.map(r=>{
   const viewer=r.viewerPid||r.memory.find(s=>s.group)?.group;
   const samples=r.memory.filter(s=>s.tasks.some(t=>t.pid===viewer));
   const cpus=new Map();for(const s of r.memory)for(const t of s.tasks)cpus.set(t.pid,Math.max(cpus.get(t.pid)||0,t.cpuTicks===undefined && r.cpuTimebase ? t.cpuNs*r.cpuTimebase.numer/r.cpuTimebase.denom : t.cpuNs));
   return {viewerPeak:Math.max(0,...samples.map(s=>s.tasks.find(t=>t.pid===viewer).peakFootprint)),
    taskSumPeak:Math.max(0,...r.memory.map(s=>s.tasks.reduce((n,t)=>n+t.footprint,0))),
    nativeCpuMs:[...cpus.values()].reduce((n,c)=>n+c,0)/1e6,viewerCpuMs:(cpus.get(viewer)||0)/1e6};
  });
  groups.push({fixture,codec,sessions:selected.length,operations,firstEditMs:q(firstEdits.map(o=>o.ms)),warmTypingMs:q(warmEdits.map(o=>o.ms)),
   nativeStagesTotalMs:stages,viewerPeakMiB:q(memory.map(m=>m.viewerPeak/2**20)),taskSumPeakMiB:q(memory.map(m=>m.taskSumPeak/2**20)),
   nativeSampledCpuMs:q(memory.map(m=>m.nativeCpuMs)),viewerCpuMs:q(memory.map(m=>m.viewerCpuMs)),
   totalImageBytes:q(selected.map(r=>r.frames.reduce((n,f)=>n+f.bytes+f.patchBytes,0))),
   peakHeapMiB:q(selected.map(r=>Math.max(...r.rows.map(o=>o.heapBytes||0))/2**20)),
   errors:selected.flatMap(r=>r.errors||[])});
 }
 return {created:new Date().toISOString(),warmup:'Repetition 0 excluded separately for each fixture/codec',runs:runs.length,groups};
}
if(require.main===module)console.log(JSON.stringify(summarize(process.argv.slice(2)),null,2));
module.exports={summarize};
