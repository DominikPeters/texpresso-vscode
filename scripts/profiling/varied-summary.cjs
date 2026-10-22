#!/usr/bin/env node
/* Compact actual-Code sustained-edit observations. Retains validity limits;
 * an offscreen neighbor paint cannot establish visible edited-source latency. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {sustainedPlans}=require('./varied-fixture.cjs');
const output=path.resolve(process.argv[2]||'artifacts/profile-varied-vscode');
const plans=new Map(sustainedPlans().map(p=>[p.id,p]));
const percentile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)]:null;
const visiblePaint=p=>p.varied==='paint'&&!p.superseded&&p.shells?.some(s=>s.page===p.header.page&&s.visible&&s.sequence===p.header.sequence);
const results=[];
const compactSnapshot=s=>s?{toolbar:s.toolbar,visibility:s.visibility,count:s.count,visiblePages:s.shells?.filter(p=>p.visible).map(p=>p.page),shellCount:s.shells?.length,latestSequence:s.latestSequence}:undefined;
for(const file of fs.readdirSync(output).filter(f=>/^varied-.*\.json$/.test(f))){
 const r=JSON.parse(fs.readFileSync(path.join(output,file),'utf8'));
 if(!r.fixture||!r.phases||!r.inputs||!r.browser)continue;
 const paints=r.browser.filter(visiblePaint),states=r.messages.filter(m=>m.received?.[0]==='preview-state');
 const complete=states.filter(m=>m.received[4]).at(-1)?.received;
 const forwards=r.messages.filter(m=>m.received?.[0]==='preview-forward');
 const targetForPaint=f=>forwards.filter(m=>m.at<=f.hostAt&&m.received[1]===f.header.revision&&m.received[2]===f.header.sequence).at(-1)?.received;
 const isTargetPaint=f=>targetForPaint(f)?.[3]===f.header.page;
 const phases=r.phases.map(p=>{
  const input=r.inputs.filter(i=>i.phase===p.name),plan=plans.get(p.name);
  if(!input.length)return{name:p.name,commandCount:p.commands?.length||0,commandsByVerb:Object.fromEntries([...new Set((p.commands||[]).map(c=>c.sent?.[0]))].map(verb=>[verb,p.commands.filter(c=>c.sent?.[0]===verb).length])),snapshot:compactSnapshot(p.snapshot)};
  const visible=paints.filter(f=>f.hostAt>=p.start&&f.hostAt<=p.end),selected=visible.filter(isTargetPaint);
  const first=selected.find(f=>f.header.sequence>=input[0].sequence);
  // The harness waits for current native target page AND revision before saving
  // this final latency; retain that strict result rather than accepting a neighbor.
  const final=p.finalPaintMs===null?undefined:visible.find(f=>f.header.page===p.expectedPage&&f.header.sequence>=input.at(-1).sequence&&Math.abs(f.hostAt-input.at(-1).applied-p.finalPaintMs)<.01);
  const perInput=input.map(i=>{const exact=selected.find(f=>f.header.sequence===i.sequence&&f.hostAt>=i.completed),caught=selected.find(f=>f.header.sequence>=i.sequence&&f.hostAt>=i.completed);return{index:i.index,sequence:i.sequence,latenessMs:i.lateness,commandMs:i.completed-i.applied,exactPaintMs:exact?exact.hostAt-i.applied:null,caughtUpPaintMs:caught?caught.hostAt-i.applied:null};});
  const interval=plan?.intervalMs||100,expectedSpan=(input.length-1)*interval,actualSpan=input.at(-1).applied-input[0].applied,maxLateness=Math.max(...input.map(i=>i.lateness));
  const visibility=r.browser.filter(b=>b.phase===p.name&&b.visibility).map(b=>b.visibility);
  const native=(r.native||[]).filter(n=>n.phase===p.name&&n.at>=p.start&&n.at<=p.end),rollbacks=native.filter(n=>n.stage==='compiler-rollback');
  const targetPages=[...new Set(forwards.filter(m=>m.at>=p.start&&m.at<=p.end).map(m=>m.received[3]))].sort((a,b)=>a-b);
  const records=r.messages.filter(m=>m.at>=p.start&&m.at<=p.end&&m.received?.requestId).map(m=>m.received);
  const fallbackCounts=Object.fromEntries([...new Set(records.filter(h=>h.fallback).map(h=>h.fallback))].map(reason=>[reason,records.filter(h=>h.fallback===reason).length]));
  const worst=[...perInput].filter(i=>i.caughtUpPaintMs!==null).sort((a,b)=>b.caughtUpPaintMs-a.caughtUpPaintMs).slice(0,2);
  return{name:p.name,anchor:p.anchor,inputCount:input.length,scheduledIntervalMs:interval,expectedInputSpanMs:expectedSpan,actualInputSpanMs:actualSpan,maxInputLatenessMs:maxLateness,
   validCadence:maxLateness<=20&&(expectedSpan===0||actualSpan<=expectedSpan*1.2),observedVisible:visibility.length>0&&visibility.every(v=>v==='visible'),
   firstVisibleChangedSourceMs:first?first.hostAt-input[0].applied:null,lastKeyToVisibleSourceMs:typeof p.finalPaintMs==='number'?p.finalPaintMs:null,
   finalExpectedPage:p.expectedPage,finalExpectedRevision:final?.header.revision,visiblePaintsWithoutKnownTarget:visible.filter(f=>!targetForPaint(f)).length,perInputEndpoint:'Visible frame with matching native source-follow sequence/revision/page known by paint receipt; missing matches are not proof of source coalescing',
   harnessFirstPaintMs:p.firstPaintMs,harnessFinalPaintMs:p.finalPaintMs,exactInputPaints:perInput.filter(i=>i.exactPaintMs!==null).length,
   caughtUpMedianMs:percentile(perInput.map(i=>i.caughtUpPaintMs).filter(v=>v!==null),.5),caughtUpP95Ms:percentile(perInput.map(i=>i.caughtUpPaintMs).filter(v=>v!==null),.95),
   nativeStageTimingsAvailable:!!r.native?.length,rootRollbacks:r.native?.length?rollbacks.filter(n=>n.resumeTokens===0).length:null,checkpointRollbacks:r.native?.length?rollbacks.filter(n=>n.resumeTokens>0).length:null,sourceTargetNativePages:targetPages,
   caughtUpMaxMs:worst[0]?.caughtUpPaintMs??null,worstInputs:worst,frameCounts:{svg:records.filter(h=>h.mime==='image/svg+xml').length,png:records.filter(h=>h.mime==='image/png').length,hostAnnotatedFallbacks:fallbackCounts},
   staleVisiblePaints:selected.filter(f=>{const latest=input.filter(i=>i.completed<=f.hostAt).at(-1);return latest&&f.header.sequence<latest.sequence;}).length,
   browserErrors:r.browser.filter(b=>b.phase===p.name&&b.varied==='message'&&b.type==='error').map(b=>({text:b.text,sequence:b.sequence})),
   snapshot:compactSnapshot(p.snapshot),...(process.argv.includes('--inputs')?{inputs:perInput}:{})};
 });
 const completedPhases=new Set(r.phases.map(p=>p.name));
 const incompleteInputPhases=[...new Set(r.inputs.map(i=>i.phase))].filter(p=>!completedPhases.has(p));
 const result={metadata:r.metadata,fixture:r.fixture,preflightOnly:r.inputs.length===0,incompleteInputPhases,completedPageCount:complete?.[3],completedPageCountSequence:complete?.[2],lastInputSequence:r.inputs.at(-1)?.sequence,completeCurrentSource:r.inputs.length>0&&complete?.[2]===r.inputs.at(-1)?.sequence,error:r.error||null,warnings:r.warnings||[],nodeMemory:r.nodeMemory,probes:(r.probes||[]).map(p=>({phrase:p.phrase,line1:p.line1,column:p.column,nativePage:p.nativePage,revision:p.revision,sequence:p.sequence,snapshot:compactSnapshot(p.snapshot)})),phases};
 results.push(result);
 console.log(JSON.stringify({fixture:r.fixture.id,engine:r.metadata.engine,legacyFollow:r.metadata.legacyFollow,preflightOnly:result.preflightOnly,incompleteInputPhases,completedPages:result.completedPageCount,error:result.error,phases:phases.map(p=>({name:p.name,count:p.inputCount,valid:p.validCadence,visible:p.observedVisible,first:p.firstVisibleChangedSourceMs,last:p.lastKeyToVisibleSourceMs,maxLateness:p.maxInputLatenessMs,exact:p.exactInputPaints,rootReplays:p.rootRollbacks,idleCommands:p.commandCount}))}));
}
if(!results.length)throw Error('No sustained actual-Code result files in '+output);
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify({endpoint:'Final: harness-verified current native target page/revision plus visible production mount and two animation frames. Per-input: matching source-follow target required. Neither is compositor presentation',source:output,results},null,2)+'\n');
