'use strict';
const fs=require('node:fs'),path=require('node:path');
const dirs=process.argv.slice(2);if(!dirs.length)throw Error('Supply measurement directories');
const rows=dirs.flatMap(dir=>fs.existsSync(path.join(dir,'sessions.jsonl'))?fs.readFileSync(path.join(dir,'sessions.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]);
const quantile=(values,q)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*q)-1)]:null;};
const stats=values=>({n:values.filter(Number.isFinite).length,p50:quantile(values,.5),p95:quantile(values,.95),max:quantile(values,1)});
const groups=new Map();
for(const row of rows.filter(r=>!r.warmup)){
 const key=[row.fixture,row.width,row.dpr,row.codec].join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
}
const cells=[...groups].map(([key,sessions])=>{
 const operations={};
 for(const name of new Set(sessions.flatMap(s=>s.operations.map(o=>o.name)))){
  const ops=sessions.flatMap(s=>s.operations.filter(o=>o.name===name));
  operations[name]={firstVisualMs:stats(ops.map(o=>o.firstVisualMs)),sharpMs:stats(ops.map(o=>o.sharpMs)),durableSharpMs:stats(ops.map(o=>o.durableSharpMs)),
   sharpnessRegressions:ops.filter(o=>o.qualityTimeline?.some((q,i)=>i>0&&!q.sharp)).length,
   firstVisualBeyondQualityWindow:ops.filter(o=>o.qualityTimeline&&o.firstVisualMs>=2200).length,
   finalNotSharp:ops.filter(o=>(o.finalQuality||o.quality)?.sharp===false).length,
   neverSharp:ops.filter(o=>o.sharpMs===null).length,finalMimes:ops.map(o=>o.finalQuality?.mime||o.quality?.mime),
   finalRatios:ops.map(o=>({base:o.finalQuality?.baseRatio,detail:o.finalQuality?.detailRatio,detailCovers:o.finalQuality?.detailCovers}))};
 }
 const footprints=sessions.map(s=>Math.max(0,...s.nativeMemory.flatMap(m=>m.tasks.filter(t=>t.pid===s.viewerPid).map(t=>t.peakFootprint)))/1048576);
 const cpu=sessions.map(s=>Math.max(0,...s.nativeMemory.flatMap(m=>m.tasks.filter(t=>t.pid===s.viewerPid).map(t=>t.cpuNs)))/1e6);
 const editFrames=s=>s.frames.filter(f=>f.type==='image'&&f.page===s.focusPage&&f.sequence>=3&&f.sequence<=10&&!f.stale&&f.displayed!==false);
 return {key,sessions:sessions.length,keys:sessions.map(s=>s.key),pacedMs:stats(sessions.flatMap(s=>s.inputs.filter(i=>i.kind==='paced').map(i=>i.latencyMs))),
  coldMs:stats(sessions.flatMap(s=>s.inputs.filter(i=>i.kind==='cold').map(i=>i.latencyMs))),
  burstMs:stats(sessions.filter(s=>s.burst.validCadence).map(s=>s.burst.lastKeyToPaintMs)),
  cadenceRejected:sessions.filter(s=>!s.burst.validCadence).length,maximumLatenessMs:stats(sessions.map(s=>s.burst.maximumLatenessMs)),
  recoveries:sessions.flatMap(s=>s.errors),hidden:sessions.filter(s=>s.hidden||s.visibility.some(v=>v.state==='hidden')).length,
  repetitions:sessions.map(s=>({repeat:s.repeat,key:s.key,pacedMs:stats(s.inputs.filter(i=>i.kind==='paced').map(i=>i.latencyMs)),
    burstMs:s.burst.validCadence?s.burst.lastKeyToPaintMs:null,load:s.load,
    editFrames:editFrames(s).map(f=>({mime:f.mime,svgPatch:f.svgPatch,pngPatch:f.pngPatch,renderMs:f.renderMs,
      exportMs:s.headers.find(h=>h.requestId===f.id)?.exportMs})),
    zeroLimitAutoRequests:s.requests.filter(r=>r.command[0]==='preview-auto'&&r.command[6]===0).length})),
  operations,viewerPeakMiB:stats(footprints),viewerCpuMs:stats(cpu),
  browserResidentMiB:stats(sessions.map(s=>Math.max(...s.operations.map(o=>o.memory?.residentBytes||0))/1048576)),
  numberBridge:{changed:sessions.reduce((n,s)=>n+(s.numberBridge?.changed||0),0),headers:sessions.reduce((n,s)=>n+(s.numberBridge?.headers||0),0),
   meanHeaderMs:sessions.reduce((n,s)=>n+(s.numberBridge?.headerMs||0),0)/Math.max(1,sessions.reduce((n,s)=>n+(s.numberBridge?.headers||0),0)),
   maxHeaderMs:Math.max(...sessions.map(s=>s.numberBridge?.maxHeaderMs||0))}};
});
const result={schema:1,created:new Date().toISOString(),sessions:rows.length,measured:rows.filter(r=>!r.warmup).length,
 warmups:rows.filter(r=>r.warmup).length,quantiles:'Nearest rank. Warmed edits within one session are correlated; session pairs, not keys, are experimental repetitions.',
 cells,inputs:dirs.map(dir=>({metadata:fs.readdirSync(dir).filter(n=>/^metadata-dpr\d.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')))}))};
fs.writeFileSync(path.join(dirs[0],'summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({sessions:result.sessions,measured:result.measured,cells:cells.map(c=>({key:c.key,n:c.sessions,typing:c.pacedMs.p50,burst:c.burstMs.p50,zoom125:c.operations['zoom-125']?.sharpMs.p50,zoom200:c.operations['zoom-200']?.sharpMs.p50,neverSharp:Object.values(c.operations).reduce((n,o)=>n+o.neverSharp,0)}))},null,2));
