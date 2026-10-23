#!/usr/bin/env node
/* Compact actual-Code sustained-edit observations. Retains validity limits;
 * an offscreen neighbor paint cannot establish visible edited-source latency. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {scenarioPlans}=require('./varied-fixture.cjs');
const output=path.resolve(process.argv[2]||'artifacts/profile-varied-vscode');

const percentile=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)]:null;
const visiblePaint=p=>p.varied==='paint'&&!p.superseded&&p.shells?.some(s=>s.page===p.header.page&&s.visible&&s.sequence===p.header.sequence);
const results=[];
const compactSnapshot=s=>s?{toolbar:s.toolbar,visibility:s.visibility,count:s.count,visiblePages:s.shells?.filter(p=>p.visible).map(p=>p.page),shellCount:s.shells?.length,latestSequence:s.latestSequence,viewport:s.viewport,resources:s.resources}:undefined;
for(const file of fs.readdirSync(output).filter(f=>/^varied-.*\.json$/.test(f))){
 const r=JSON.parse(fs.readFileSync(path.join(output,file),'utf8'));
 if(!r.fixture||!r.phases||!r.inputs||!r.browser)continue;
 const plans=new Map(scenarioPlans(r.metadata?.scenario).map(p=>[p.id,p]));
 const paints=r.browser.filter(visiblePaint),states=r.messages.filter(m=>m.received?.[0]==='preview-state');
 const complete=states.filter(m=>m.received[4]).at(-1)?.received;
 const forwards=r.messages.filter(m=>m.received?.[0]==='preview-forward');
 const targetForPaint=f=>forwards.filter(m=>(m.generation??0)===(f.header.profileGeneration??0)&&m.at<=f.hostAt&&m.received[1]===f.header.revision&&m.received[2]===f.header.sequence).at(-1)?.received;
 const isTargetPaint=f=>targetForPaint(f)?.[3]===f.header.page;
 const phases=r.phases.map(p=>{
  const input=r.inputs.filter(i=>i.phase===p.name),plan=plans.get(p.name);
  if(!input.length)return{name:p.name,commandCount:p.commands?.length||0,commandsByVerb:Object.fromEntries([...new Set((p.commands||[]).map(c=>c.sent?.[0]))].map(verb=>[verb,p.commands.filter(c=>c.sent?.[0]===verb).length])),snapshot:compactSnapshot(p.snapshot)};
  const visible=paints.filter(f=>(f.header.profileGeneration??0)===(p.generation??0)&&f.hostAt>=p.start&&f.hostAt<=p.end),selected=visible.filter(isTargetPaint);
  const first=selected.find(f=>f.header.sequence>=input[0].sequence);
  // The harness waits for current native target page AND revision before saving
  // this final latency; retain that strict result rather than accepting a neighbor.
  const final=p.finalPaintMs===null?undefined:visible.find(f=>f.header.page===p.expectedPage&&f.header.sequence>=input.at(-1).sequence&&Math.abs(f.hostAt-input.at(-1).applied-p.finalPaintMs)<.01);
  const perInput=input.map(i=>{const exact=selected.find(f=>f.header.sequence===i.sequence&&f.hostAt>=i.completed),caught=selected.find(f=>f.header.sequence>=i.sequence&&f.hostAt>=i.completed);return{index:i.index,sequence:i.sequence,sourceValid:i.sourceValid,manualViewport:i.manualViewport,latenessMs:i.lateness,commandMs:i.completed-i.applied,exactPaintMs:exact?exact.hostAt-i.applied:null,caughtUpPaintMs:caught?caught.hostAt-i.applied:null};});
  // Count progress only while valid edited source is pending and automatic source
  // following is intended. An open argument or deliberate navigation is excluded.
  const events=[...input.map(i=>({at:i.applied,input:i})),...selected.map(f=>({at:f.hostAt,paint:f}))].sort((a,b)=>a.at-b.at);
  let eligible=false,pending,latest=0,painted=0,maxNoProgress=0,excludedMs=0,lastAt=p.start,validityAvailable=input.every(i=>typeof i.sourceValid==='boolean');
  for(const e of events){
   if(!eligible)excludedMs+=Math.max(0,e.at-lastAt);
   if(e.input){
    const next=e.input.sourceValid===true&&!e.input.manualViewport;
    if(!next&&pending!==undefined){maxNoProgress=Math.max(maxNoProgress,e.at-pending);pending=undefined;}
    eligible=next;latest=e.input.sequence;
    if(eligible&&latest>painted&&pending===undefined)pending=e.at;
   }else if(eligible&&e.paint.header.sequence>painted){
    painted=e.paint.header.sequence;
    if(pending!==undefined){maxNoProgress=Math.max(maxNoProgress,e.at-pending);pending=painted<latest?e.at:undefined;}
   }
   lastAt=e.at;
  }
  if(eligible&&pending!==undefined)maxNoProgress=Math.max(maxNoProgress,p.end-pending);
  const validLatencies=perInput.filter((i,j)=>i.sourceValid===true&&!i.manualViewport&&i.caughtUpPaintMs!==null&&!input.some(other=>other.applied>input[j].applied&&other.applied<input[j].applied+i.caughtUpPaintMs&&(other.sourceValid!==true||other.manualViewport))).map(i=>i.caughtUpPaintMs);
  // Separate user-visible epoch progress from exact-current edited-source
  // attribution. A stale but newer foreground surface can advance this metric;
  // it cannot satisfy the exact source/page/revision timing above.
  // The edited target can be an adjacent visible sheet while the viewport
  // center/toolbar remains on its neighbor. Resolve source affinity by epoch,
  // never by the toolbar; an unrelated visible neighbor cannot qualify.
  const visualTarget=f=>forwards.filter(m=>(m.generation??0)===(f.header.profileGeneration??0)&&m.at<=f.hostAt&&m.received[2]===f.header.sequence).at(-1)?.received[3];
  const foreground=visible.filter(f=>f.header.page===visualTarget(f)&&f.header.sequence>=input[0].sequence);
  const pageEpochs=new Map(),surfaceContents=new Map(),advances=[],changedAdvances=[],lags=[],ages=[];let visualRegressions=0,contentChanges=0,newSurfaceAllocations=0,comparableSurfaceFrames=0;
  const surfaceKey=f=>JSON.stringify([f.header.page,f.header.mime,f.header.width,f.header.height,f.header.bounds]);
  for(const f of paints.filter(f=>(f.header.profileGeneration??0)===(p.generation??0)&&f.hostAt<p.start)){pageEpochs.set(f.header.page,{sequence:f.header.sequence,revision:f.header.revision,contentId:f.contentId});surfaceContents.set(surfaceKey(f),f.contentId);}
  for(const f of foreground){
   const old=pageEpochs.get(f.header.page),epoch=f.header.sequence;
   if(old&&(epoch<old.sequence||(epoch===old.sequence&&f.header.revision<old.revision))){visualRegressions++;continue;}
   const key=surfaceKey(f),comparable=surfaceContents.has(key),changed=comparable&&surfaceContents.get(key)!==f.contentId;
   if(comparable)comparableSurfaceFrames++;else newSurfaceAllocations++;
   surfaceContents.set(key,f.contentId);if(changed)contentChanges++;
   if(!old||epoch>old.sequence||(epoch===old.sequence&&f.header.revision>old.revision)){advances.push(f);if(changed)changedAdvances.push(f);}
   pageEpochs.set(f.header.page,{sequence:epoch,revision:f.header.revision,contentId:f.contentId});
   const latest=input.filter(i=>i.applied<=f.hostAt).at(-1),origin=input.find(i=>i.sequence===epoch);
   if(latest)lags.push(Math.max(0,latest.sequence-epoch));
   if(origin)ages.push(f.hostAt-origin.applied);
  }
  const foregroundGap=frames=>{
  const visualEvents=[...input.map(i=>({at:i.applied,input:i})),...frames.map(f=>({at:f.hostAt,paint:f}))].sort((a,b)=>a.at-b.at);
  let visualEligible=false,visualPending,visualLatest=0,visualPainted=0,visualGap=0;
  for(const e of visualEvents){
   if(e.input){const next=e.input.sourceValid===true&&!e.input.manualViewport;
    if(!next&&visualPending!==undefined){visualGap=Math.max(visualGap,e.at-visualPending);visualPending=undefined;}
    visualEligible=next;visualLatest=e.input.sequence;
    if(next&&visualLatest>visualPainted&&visualPending===undefined)visualPending=e.at;
   }else if(visualEligible){
    visualPainted=Math.max(visualPainted,e.paint.header.sequence);
    if(visualPending!==undefined){visualGap=Math.max(visualGap,e.at-visualPending);visualPending=visualPainted<visualLatest?e.at:undefined;}
   }
  }
  if(visualEligible&&visualPending!==undefined)visualGap=Math.max(visualGap,p.end-visualPending);
  return visualGap;
  };
  const visualGap=foregroundGap(advances),changedGap=foregroundGap(changedAdvances);
  const visualProgress={endpoint:'Monotonic visible source-follow page epochs (native generation/sequence affinity, independent of toolbar); can include older epochs and is not exact-current edited-source correctness',frames:foreground.length,advances:advances.length,contentChanges,contentMetric:'Encoded surface changes compared only at identical page/mime/bounds/pixel dimensions; not OCR or proof each letter is visible',comparableSurfaceFrames,newSurfaceAllocations,regressions:visualRegressions,
   longestPendingGapMs:validityAvailable&&input.some(i=>i.sourceValid&&!i.manualViewport)?visualGap:null,contentChangingAdvances:changedAdvances.length,longestContentChangingPendingGapMs:validityAvailable&&input.some(i=>i.sourceValid&&!i.manualViewport)?changedGap:null,
   sequenceLagMedian:percentile(lags,.5),sequenceLagP95:percentile(lags,.95),sequenceLagMax:percentile(lags,1),
   displayedSourceAgeMedianMs:percentile(ages,.5),displayedSourceAgeP95Ms:percentile(ages,.95)};
  const interval=plan?.intervalMs||100,expectedSpan=(input.length-1)*interval,actualSpan=input.at(-1).applied-input[0].applied,maxLateness=Math.max(...input.map(i=>i.lateness));
  const visibility=r.browser.filter(b=>b.phase===p.name&&b.visibility).map(b=>b.visibility);
  const native=(r.native||[]).filter(n=>n.phase===p.name&&n.at>=p.start&&n.at<=p.end),rollbacks=native.filter(n=>n.stage==='compiler-rollback');
  const targetPages=[...new Set(forwards.filter(m=>m.at>=p.start&&m.at<=p.end).map(m=>m.received[3]))].sort((a,b)=>a-b);
  const records=r.messages.filter(m=>m.at>=p.start&&m.at<=p.end&&m.received?.requestId).map(m=>m.received);
  const browserFailures=r.messages.filter(m=>m.at>=p.start&&m.at<=p.end&&m.browserSent&&['rasterize','decode-error','cache-miss'].includes(m.browserSent.type));
  const commands=r.messages.filter(m=>m.at>=p.start&&m.at<=p.end&&m.sent);
  const duringInput=r.messages.filter(m=>m.at>=input[0].applied&&m.at<=input.at(-1).completed);
  const fallbackCounts=Object.fromEntries([...new Set(records.filter(h=>h.fallback).map(h=>h.fallback))].map(reason=>[reason,records.filter(h=>h.fallback===reason).length]));
  const worst=[...perInput].filter(i=>i.caughtUpPaintMs!==null).sort((a,b)=>b.caughtUpPaintMs-a.caughtUpPaintMs).slice(0,2);
  return{name:p.name,anchor:p.anchor,inputCount:input.length,scheduledIntervalMs:interval,expectedInputSpanMs:expectedSpan,actualInputSpanMs:actualSpan,maxInputLatenessMs:maxLateness,
   validCadence:maxLateness<=20&&(expectedSpan===0||actualSpan<=expectedSpan*1.2),observedVisible:visibility.length>0&&visibility.every(v=>v==='visible'),
   firstVisibleChangedSourceMs:first?first.hostAt-input[0].applied:null,lastKeyToVisibleSourceMs:typeof p.finalPaintMs==='number'?p.finalPaintMs:null,
   finalExpectedPage:p.expectedPage,finalExpectedRevision:final?.header.revision,visiblePaintsWithoutKnownTarget:visible.filter(f=>!targetForPaint(f)).length,perInputEndpoint:'Visible frame with matching native source-follow sequence/revision/page known by paint receipt; missing matches are not proof of source coalescing',
   harnessFirstPaintMs:p.firstPaintMs,harnessFinalPaintMs:p.finalPaintMs,exactInputPaints:perInput.filter(i=>i.exactPaintMs!==null).length,
   caughtUpMedianMs:percentile(perInput.map(i=>i.caughtUpPaintMs).filter(v=>v!==null),.5),caughtUpP95Ms:percentile(perInput.map(i=>i.caughtUpPaintMs).filter(v=>v!==null),.95),
   nativeStageTimingsAvailable:!!r.native?.length,rootRollbacks:r.native?.length?rollbacks.filter(n=>n.resumeTokens===0).length:null,checkpointRollbacks:r.native?.length?rollbacks.filter(n=>n.resumeTokens>0).length:null,sourceTargetNativePages:targetPages,
   visualProgress,validSourceProgress:validityAvailable?{longestNoProgressMs:input.some(i=>i.sourceValid===true&&!i.manualViewport)?maxNoProgress:null,excludedInvalidOrManualMs:excludedMs,eligibleInputs:validLatencies.length,medianMs:percentile(validLatencies,.5),p95Ms:percentile(validLatencies,.95),p99Ms:percentile(validLatencies,.99),maxMs:percentile(validLatencies,1)}:null,caughtUpMaxMs:worst[0]?.caughtUpPaintMs??null,worstInputs:worst,inputWindow:{start:input[0].applied,end:input.at(-1).completed,svgHeaders:duringInput.filter(m=>m.received?.mime==='image/svg+xml').length,pngHeaders:duringInput.filter(m=>m.received?.mime==='image/png').length,budgetRejections:duringInput.filter(m=>m.browserSent?.type==='rasterize'&&m.browserSent.reason==='budget').length},budgetStart:compactSnapshot(p.budgetStart),browserFailures:browserFailures.map(m=>({at:m.at,type:m.browserSent.type,reason:m.browserSent.reason,page:m.browserSent.page,budget:m.browserSent.budget})),commandsByVerb:Object.fromEntries([...new Set(commands.map(c=>c.sent[0]))].map(verb=>[verb,commands.filter(c=>c.sent[0]===verb).length])),nativeHeaderExportMedianMs:{svg:percentile(records.filter(h=>h.mime==='image/svg+xml'&&Number.isFinite(h.exportMs)).map(h=>h.exportMs),.5),png:percentile(records.filter(h=>h.mime==='image/png'&&Number.isFinite(h.exportMs)).map(h=>h.exportMs),.5)},nativeStageMedianMs:Object.fromEntries(['svg-export','png-draw','png-color','png-compare','png-encode'].map(stage=>[stage,percentile(native.filter(n=>n.stage===stage).map(n=>n.ms),.5)])),frameCounts:{svg:records.filter(h=>h.mime==='image/svg+xml').length,png:records.filter(h=>h.mime==='image/png').length,hostAnnotatedFallbacks:fallbackCounts},
   staleVisiblePaints:selected.filter(f=>{const latest=input.filter(i=>i.completed<=f.hostAt).at(-1);return latest&&f.header.sequence<latest.sequence;}).length,
   browserErrors:r.browser.filter(b=>b.phase===p.name&&b.varied==='message'&&b.type==='error').map(b=>({text:b.text,sequence:b.sequence})),
   snapshot:compactSnapshot(p.snapshot),...(process.argv.includes('--inputs')?{inputs:perInput}:{})};
 });
 const completedPhases=new Set(r.phases.map(p=>p.name));
 const incompleteInputPhases=[...new Set(r.inputs.map(i=>i.phase))].filter(p=>!completedPhases.has(p));
 const checkpointMemory=(r.checkpoints||[]).map(c=>({name:c.name,generation:c.generation,sequence:c.sequence,at:c.at,
  snapshot:compactSnapshot(c.snapshot),native:c.native?{tasks:c.native.tasks.length,statusAvailable:c.native.tasks.every(t=>t.status>0),liveTasks:c.native.tasks.filter(t=>t.status>0&&t.status!==5).length,zombies:c.native.tasks.filter(t=>t.status===5).length,adoptedByInit:c.native.tasks.filter(t=>t.ppid===1).length,unknownStatusTasks:c.native.tasks.filter(t=>!t.status).length,liveRssSum:c.native.tasks.some(t=>t.status>0)?c.native.tasks.filter(t=>t.status>0&&t.status!==5).reduce((n,t)=>n+t.rss,0):null,liveFootprintSum:c.native.tasks.some(t=>t.status>0)?c.native.tasks.filter(t=>t.status>0&&t.status!==5).reduce((n,t)=>n+t.footprint,0):null,rssSum:c.native.tasks.reduce((n,t)=>n+t.rss,0),footprintSum:c.native.tasks.reduce((n,t)=>n+t.footprint,0)}:null,
  node:c.node,sources:c.sources}));
 const finalSequence=r.finalSource?.sequence??r.inputs.at(-1)?.sequence;
 const rendering={headers:{svg:r.messages.filter(m=>m.received?.mime==='image/svg+xml').length,png:r.messages.filter(m=>m.received?.mime==='image/png').length},browserRejections:r.messages.filter(m=>m.browserSent?.type==='rasterize').map(m=>({phase:m.phase,page:m.browserSent.page,reason:m.browserSent.reason,budget:m.browserSent.budget})),nativeStageCounts:Object.fromEntries(['svg-export','png-draw','png-color','png-compare','png-encode'].map(stage=>[stage,(r.native||[]).filter(n=>n.stage===stage).length]))};
 const result={metadata:r.metadata,rendering,convergenceChecks:r.convergenceChecks,sourceReplays:r.sourceReplays,sourceReplayOverflow:r.sourceReplayOverflow,editedFiles:r.editedFiles,recoveries:r.recoveries||[],checkpointMemory,memorySampleCount:r.memory?.length||0,fixture:r.fixture,preflightOnly:r.inputs.length===0,incompleteInputPhases,completedPageCount:complete?.[3],completedPageCountSequence:complete?.[2],lastInputSequence:r.inputs.at(-1)?.sequence,finalSource:r.finalSource,completeCurrentSource:r.inputs.length>0&&complete?.[2]===finalSequence,error:r.error||null,warnings:r.warnings||[],nodeMemory:r.nodeMemory,probes:(r.probes||[]).map(p=>({round:p.round,phrase:p.phrase,document:p.document,line1:p.line1,column:p.column,nativePage:p.nativePage,revision:p.revision,sequence:p.sequence,snapshot:compactSnapshot(p.snapshot)})),phases};
 results.push(result);
 console.log(JSON.stringify({fixture:r.fixture.id,engine:r.metadata.engine,legacyFollow:r.metadata.legacyFollow,preflightOnly:result.preflightOnly,incompleteInputPhases,completedPages:result.completedPageCount,error:result.error,phases:phases.map(p=>({name:p.name,count:p.inputCount,valid:p.validCadence,visible:p.observedVisible,first:p.firstVisibleChangedSourceMs,last:p.lastKeyToVisibleSourceMs,maxLateness:p.maxInputLatenessMs,exact:p.exactInputPaints,rootReplays:p.rootRollbacks,idleCommands:p.commandCount}))}));
}
if(!results.length)throw Error('No sustained actual-Code result files in '+output);
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify({endpoint:'Final: harness-verified current native target page/revision plus visible production mount and two animation frames. Per-input: matching source-follow target required. Neither is compositor presentation',source:output,results},null,2)+'\n');
