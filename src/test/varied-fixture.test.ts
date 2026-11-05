import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { createVariedFixture, sourceLocation, applyInput, sustainedPlans } = require('../../scripts/profiling/varied-fixture.cjs');

test('sustained-edit corpus has deterministic flowing pages and distinct UTF-8 source anchors', () => {
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-unit-'));
  try {
    for(const targetPages of [30,100]) {
      const a=createVariedFixture(output,{targetPages,id:'first-'+targetPages});
      const b=createVariedFixture(output,{targetPages,id:'second-'+targetPages});
      assert.equal(a.text,b.text,'the text does not depend on output path or run identifier');
      assert.doesNotMatch(a.text,/\\(?:newpage|clearpage)\b/,'pagination must permit genuine boundary reflow');
      const offsets=['early','middle','late'].map(anchor=>{
        const location=sourceLocation(a.text,anchor);
        assert.equal(location.byteOffset,Buffer.byteLength(a.text.slice(0,location.offset)));
        assert.ok(location.byteOffset>location.offset,'Unicode before every anchor exercises byte/UTF-16 conversion');
        assert.ok(location.visibleLine<location.line,'a rendered paragraph can be targeted independently of its cursor comment');
        assert.ok(a.text.includes('\\hypertarget{'+location.destination+'}'));
        return location.offset;
      });
      assert.ok(offsets[0]<offsets[1]&&offsets[1]<offsets[2]);
    }
  } finally {fs.rmSync(output,{recursive:true,force:true});}
});

test('finite typing plans preserve anchor identity and exact undo restores the pre-paste source', () => {
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-plan-'));
  try {
    let text=createVariedFixture(output,{targetPages:30}).text,prePaste='';
    for(const plan of sustainedPlans()) {
      if(plan.intervalMs===100&&plan.inputs.length>1) {
        assert.ok((plan.inputs.length-1)*plan.intervalMs>=10000);
        assert.ok((plan.inputs.length-1)*plan.intervalMs<=30000);
      }
      if(plan.id==='paste-incomplete-repair'){prePaste=text;}
      for(const input of plan.inputs){text=applyInput(text,input);}
      for(const anchor of ['early','middle','late']){assert.ok(sourceLocation(text,anchor));}
      if(plan.id==='undo-pasted-block'){assert.equal(text,prePaste,'undo must restore all earlier typing without deleting the cursor marker');}
    }
    assert.throws(()=>applyInput(text,{anchor:'middle',deleteBefore:'not the actual source tail'}),/tail mismatch/);
    assert.throws(()=>sourceLocation(text+'\n%<VARIED-CURSOR:early>','early'),/ambiguous/);
  } finally {fs.rmSync(output,{recursive:true,force:true});}
});

test('long session keeps included buffers separate and undo/redo restores the exact pasted claim', () => {
  const { scenarioPlans } = require('../../scripts/profiling/varied-fixture.cjs');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-long-'));
  try {
    const fixture=createVariedFixture(output,{targetPages:30,included:true});
    const sources=new Map<string,string>([['varied.tex',fixture.text],...fixture.files.map((file: any)=>[file.relative,file.text])]);
    assert.match(fixture.text,/\\input\{chapter\}/);
    assert.doesNotMatch(fixture.text,/%<VARIED-CURSOR:included>/);
    assert.ok(sourceLocation(sources.get('chapter.tex'),'included').byteOffset>sourceLocation(sources.get('chapter.tex'),'included').offset);
    let prePaste='',pasted='';
    const plans=scenarioPlans('long');
    const typingMs=plans.reduce((sum: number,p: any)=>sum+(p.inputs.length-1)*p.intervalMs,0);
    assert.ok(typingMs>=120000&&typingMs<=180000,'the finite typing workload lasts two to three minutes');
    for(const plan of plans){
      let text=sources.get(plan.document)!;
      if(plan.id==='long-incomplete-repair'){prePaste=text;}
      for(const input of plan.inputs){
        assert.equal(typeof input.sourceValid,'boolean','every long input explicitly classifies source validity');
        text=applyInput(text,input);
      }
      sources.set(plan.document,text);
      if(plan.id==='long-incomplete-repair'){pasted=text;assert.notEqual(pasted,prePaste);}
      if(plan.id==='long-undo'){assert.equal(text,prePaste);}
      if(plan.id==='long-redo'){assert.equal(text,pasted);}
    }
    assert.ok(sources.get('varied.tex')!.includes('The final argument must also update'));
    assert.ok(sources.get('chapter.tex')!.includes('included recovery remains current'));
    assert.equal(fs.readFileSync(fixture.files[0].file,'utf8'),fixture.files[0].text,'applying unsaved edit plans never changes the on-disk include');
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});

test('controlled renderer comparison reuses identical valid source edits and a bounded fallback phase', () => {
  const { scenarioPlans } = require('../../scripts/profiling/varied-fixture.cjs');
  const plans=scenarioPlans('compare');
  assert.deepEqual(plans.map((p: any)=>p.id),['controlled-prose','repeated-budget-fallback']);
  const prose=plans[0];
  assert.ok((prose.inputs.length-1)*prose.intervalMs>=19000);
  assert.ok((prose.inputs.length-1)*prose.intervalMs<=25000);
  assert.ok(plans.every((p: any)=>p.inputs.every((input: any)=>input.sourceValid===true)));
  assert.ok(plans[1].inputs.length<=30);
  assert.equal(plans[1].sourceFollow,false,'budget test preserves a manually chosen two-page viewport');
});

test('progress summary excludes an explicit unfinished-source interval and never credits a neighbor paint', () => {
  const cp = require('node:child_process');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-progress-'));
  try {
    const phase='long-incomplete-repair';
    const inputs=[{applied:0,completed:1,sequence:1,sourceValid:true},{applied:100,completed:101,sequence:2,sourceValid:false},
      {applied:1000,completed:1001,sequence:3,sourceValid:true},{applied:1100,completed:1101,sequence:4,sourceValid:true}]
      .map((input,index)=>({...input,phase,index,scheduled:input.applied,lateness:0}));
    const paint=(at: number,sequence: number,page=0)=>({varied:'paint',hostAt:at,phase,visibility:'visible',header:{sequence,revision:sequence,page},shells:[{page,visible:true,sequence}]});
    const snapshot={visibility:'visible',shells:[{page:0,visible:true,sequence:4}]};
    const result={metadata:{scenario:'long'},fixture:{id:'unit-progress'},inputs,
      browser:[paint(60,1),paint(1050,3,1),paint(1200,4)],
      messages:[1,3,4].map(sequence=>({at:sequence===1?2:sequence===3?1002:1102,received:['preview-forward',sequence,sequence,0]})),native:[],
      phases:[{name:phase,start:0,end:1300,expectedPage:0,finalPaintMs:100,snapshot}],probes:[]};
    fs.writeFileSync(path.join(output,'varied-unit.json'),JSON.stringify(result));
    const saved=path.join(output,'summary.json');
    cp.execFileSync(process.execPath,[path.resolve(__dirname,'../../scripts/profiling/varied-summary.cjs'),output,saved]);
    const summary=JSON.parse(fs.readFileSync(saved,'utf8')).results[0].phases[0];
    assert.equal(summary.validSourceProgress.longestNoProgressMs,200,'900 ms of deliberately incomplete source is not a performance stall');
    assert.equal(summary.visiblePaintsWithoutKnownTarget,0,'neighbor has a known source target but cannot satisfy it');
    assert.equal(summary.exactInputPaints,2,'the neighbor page cannot establish an exact input paint');
    assert.equal(summary.lastKeyToVisibleSourceMs,100);
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});

test('monotonic foreground progress is separate from exact source-frame timing and detects regressions', () => {
  const cp = require('node:child_process');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-visual-'));
  try {
    const phase='long-middle';
    const inputs=[0,100,200,300].map((at,index)=>({phase,index,sequence:index+1,applied:at,completed:at+1,scheduled:at,lateness:0,sourceValid:true,manualViewport:false}));
    const frame=(sequence: number,hostAt: number)=>({varied:'paint',phase,hostAt,toolbar:0,visibility:'visible',contentId:'content-'+sequence,
      header:{sequence,revision:sequence,page:0},shells:[{page:0,visible:true,sequence}]});
    const result={metadata:{scenario:'long'},fixture:{id:'unit-visual'},inputs,
      browser:[frame(1,160),frame(2,260),frame(3,360),frame(4,450),frame(2,480)],
      messages:[{at:2,received:['preview-forward',1,1,0]},{at:102,received:['preview-forward',99,2,0]},
        {at:202,received:['preview-forward',99,3,0]},{at:310,received:['preview-forward',4,4,0]}],native:[],
      phases:[{name:phase,start:0,end:500,expectedPage:0,finalPaintMs:150}],probes:[]};
    fs.writeFileSync(path.join(output,'varied-unit.json'),JSON.stringify(result));
    const saved=path.join(output,'summary.json');
    cp.execFileSync(process.execPath,[path.resolve(__dirname,'../../scripts/profiling/varied-summary.cjs'),output,saved]);
    const summary=JSON.parse(fs.readFileSync(saved,'utf8')).results[0].phases[0];
    assert.equal(summary.validSourceProgress.longestNoProgressMs,290,'missing matching source targets remain absent from the strict metric');
    assert.equal(summary.visualProgress.longestPendingGapMs,160,'older but advancing foreground epochs can establish visual progress');
    assert.equal(summary.visualProgress.sequenceLagMax,1,'the age of advancing display content remains visible');
    assert.equal(summary.visualProgress.regressions,1,'a later older epoch is reported instead of credited as progress');
    assert.equal(summary.lastKeyToVisibleSourceMs,150,'the separate visual metric cannot replace the exact final-input endpoint');
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});


test('visual progress follows the edited adjacent page rather than the toolbar or an unrelated neighbor', () => {
  const cp = require('node:child_process');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-adjacent-'));
  try {
    const phase='long-middle';
    const inputs=[0,100].map((at,index)=>({phase,index,sequence:index+1,applied:at,completed:at+1,scheduled:at,lateness:0,sourceValid:true,manualViewport:false}));
    const frame=(page:number,sequence:number,hostAt:number)=>({varied:'paint',phase,hostAt,toolbar:0,visibility:'visible',contentId:`page${page}-epoch${sequence}`,
      header:{sequence,revision:sequence,page},shells:[{page,visible:true,sequence}]});
    const result={metadata:{scenario:'long'},fixture:{id:'unit-adjacent'},inputs,
      browser:[frame(1,0,-10),frame(0,1,20),frame(1,1,50),frame(0,2,120),frame(1,2,150)],
      messages:[{at:2,received:['preview-forward',1,1,1]},{at:102,received:['preview-forward',2,2,1]}],native:[],
      phases:[{name:phase,start:0,end:200,expectedPage:1,finalPaintMs:50}],probes:[]};
    fs.writeFileSync(path.join(output,'varied-unit.json'),JSON.stringify(result));
    const saved=path.join(output,'summary.json');
    cp.execFileSync(process.execPath,[path.resolve(__dirname,'../../scripts/profiling/varied-summary.cjs'),output,saved]);
    const summary=JSON.parse(fs.readFileSync(saved,'utf8')).results[0].phases[0];
    assert.equal(summary.visualProgress.frames,2,'only the edited target page contributes visual progress');
    assert.equal(summary.visualProgress.contentChangingAdvances,2,'adjacent edited-page pixels count even while toolbar shows page zero');
    assert.equal(summary.visualProgress.longestPendingGapMs,50,'unrelated neighbor images cannot shorten the source progress gap');
    assert.equal(summary.lastKeyToVisibleSourceMs,50);
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});

test('encoded progress compares compatible geometry instead of treating a new raster allocation as text', () => {
  const cp = require('node:child_process');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'txp-varied-geometry-'));
  try {
    const phase='long-middle';
    const inputs=[0,100,200].map((at,index)=>({phase,index,sequence:index+1,applied:at,completed:at+1,scheduled:at,lateness:0,sourceValid:true,manualViewport:false}));
    const frame=(sequence:number,hostAt:number,width:number,contentId:string)=>({varied:'paint',phase,hostAt,toolbar:0,visibility:'visible',contentId,
      header:{sequence,revision:sequence,page:0,width,height:300,mime:'image/png',bounds:[0,0,600,300]},shells:[{page:0,visible:true,sequence}]});
    const result={metadata:{scenario:'long'},fixture:{id:'unit-geometry'},inputs,
      browser:[frame(0,-10,600,'before'),frame(1,50,600,'changed'),frame(2,150,900,'resized'),frame(3,250,600,'changed')],
      messages:inputs.map(i=>({at:i.applied+2,received:['preview-forward',i.sequence,i.sequence,0]})),native:[],
      phases:[{name:phase,start:0,end:300,expectedPage:0,finalPaintMs:50}],probes:[]};
    fs.writeFileSync(path.join(output,'varied-unit.json'),JSON.stringify(result));
    const saved=path.join(output,'summary.json');
    cp.execFileSync(process.execPath,[path.resolve(__dirname,'../../scripts/profiling/varied-summary.cjs'),output,saved]);
    const metric=JSON.parse(fs.readFileSync(saved,'utf8')).results[0].phases[0].visualProgress;
    assert.equal(metric.contentChanges,1,'resizing and restoring a known surface do not count as edited pixels');
    assert.equal(metric.newSurfaceAllocations,1);assert.equal(metric.comparableSurfaceFrames,2);
    assert.equal(metric.contentChangingAdvances,1);
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});
