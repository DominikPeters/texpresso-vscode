#!/usr/bin/env node
'use strict';
// Snapshot 0 is the original page, 1 is the first edit, and 2 the second.
// Use 0 -> 1: alternating reflow tests return to a short edit at snapshot 2.
const fs=require('node:fs'),path=require('node:path');
const {compare}=require('./xdv-stability.cjs');
function snapshots(output) {
  const metadata=JSON.parse(fs.readFileSync(path.join(output,'metadata.json')));
  const rows=fs.readFileSync(path.join(output,'samples.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const result=[];
  for(const fixture of metadata.fixtures) {
    const scenarios=[...new Set(rows.filter(r=>r.fixture===fixture.id&&r.variant==='cached').map(r=>r.scenario))];
    for(const scenario of scenarios) {
      const directory=path.join(output,'xdv',fixture.id,scenario,'cached');
      const files=fs.readdirSync(directory).filter(file=>file.endsWith('.xdv')).sort();
      if(files.length<2)throw Error('Missing initial/first-edit XDV snapshots');
      // Native request selected the focus page. Infer it from a new explicit
      // field where present; old runs can recover it from their supplied config.
      const page=fixture.focusPage;
      if(!Number.isInteger(page))throw Error('Fixture metadata must include focusPage');
      result.push({fixture:fixture.id,scenario,snapshots:[files[0],files[1]],comparison:compare(fs.readFileSync(path.join(directory,files[0])),fs.readFileSync(path.join(directory,files[1])),{page})});
    }
  }
  return result;
}
module.exports={snapshots};
if(require.main===module)fs.writeFileSync(path.join(process.argv[2],'xdv-stability.json'),JSON.stringify(snapshots(process.argv[2]),null,2)+'\n');
