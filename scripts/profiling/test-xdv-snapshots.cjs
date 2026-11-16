'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {snapshots}=require('./xdv-snapshots.cjs');
function stream(program) {
  const pre=Buffer.alloc(15);pre[0]=247;pre[1]=7;
  const bop=Buffer.alloc(45);bop[0]=139;
  return Buffer.concat([pre,bop,Buffer.from(program),Buffer.from([140])]);
}
test('reflow comparison uses the first edit even when the second returns to short text',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'txp-xdv-snapshots-'));
  try {
    fs.writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({fixtures:[{id:'public',focusPage:0}]}));
    fs.writeFileSync(path.join(directory,'samples.jsonl'),JSON.stringify({fixture:'public',scenario:'reflow',variant:'cached'})+'\n');
    const dump=path.join(directory,'xdv/public/reflow/cached');fs.mkdirSync(dump,{recursive:true});
    for(const [index,program] of [[0,[65]],[1,[66,66,66]],[2,[65]]])fs.writeFileSync(path.join(dump,index+'.xdv'),stream(program));
    const result=snapshots(directory);
    assert.deepEqual(result[0].snapshots,['0.xdv','1.xdv']);
    assert.equal(result[0].comparison.pages[0].instructionDiff.distance,4);
    assert.equal(result[0].comparison.pages[0].newInstructions,3);
    assert.ok(!JSON.stringify(result).includes(directory));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
