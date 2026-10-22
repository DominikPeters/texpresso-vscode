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
