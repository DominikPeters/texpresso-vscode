#!/usr/bin/env node
/* Summarize fixed-interval source-version/paint observations. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const filename = process.argv[2];
if (!filename) throw Error('Usage: node scripts/profiling/rapid-summary.cjs artifacts/profile-rapid-vscode/browser.jsonl');
const rows = fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const median = values => { const a=values.filter(Number.isFinite).sort((a,b)=>a-b); return a.length ? (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2 : null; };
const groups = new Map();
for(const row of rows) {
  // Older recordings label PNG refinement eligibility, not actual SVG upgrades.
  // Recover the latter from production Auto's explicit background preview-svg.
  const traceFile = path.join(path.dirname(filename), `${row.fixture}-${row.codec}-${row.repeat}-requests.json`);
  const upgradeRequests = row.codec === 'auto' && fs.existsSync(traceFile) ?
    JSON.parse(fs.readFileSync(traceFile,'utf8')).filter(e=>e.sent?.[0]==='preview-svg').map(e=>e.sent) : [];
  const upgrades = new Set(upgradeRequests.map(command=>command[1]));
  for(const frame of row.frames) frame.upgrade ??= upgrades.has(frame.request);
  for(const phase of row.rapidPhases || []) {
    const visible = row.frames.filter(f=>f.type==='image' && f.paintedAt>=phase.start && f.paintedAt<=phase.end);
    phase.refinementsDuringInput = visible.filter(f=>f.upgrade && f.paintedAt<=phase.lastInputAt).length;
    phase.refinementsAfterInput = visible.filter(f=>f.upgrade && f.paintedAt>phase.lastInputAt).length;
    const firstSequence = Math.min(...row.inputs.filter(i=>i.phase===phase.name).map(i=>i.sequence));
    phase.upgradeRequestsDuringInput = upgradeRequests.filter(c=>c[5]>=firstSequence && c[5]<phase.finalSequence).length;
    phase.upgradeRequestsAfterInput = upgradeRequests.filter(c=>c[5]===phase.finalSequence).length;
    const key = `${row.fixture}/${row.codec}/${phase.name}`;
    const list=groups.get(key)||[]; list.push({row,phase}); groups.set(key,list);
  }
}
const summary = [...groups].map(([key,all])=>{
  // Invalid/older unvalidated schedules are diagnostic observations only.
  const entries = all.filter(e=>e.phase.validComparison===true);
  return {
    key,sessions:all.length,validSessions:entries.length,excludedSessions:all.length-entries.length,
    lastKeyToPaintMs:median(entries.map(e=>e.phase.lastKeyToPaint)),
    firstPaintMs:median(entries.map(e=>e.phase.firstPaintMs)),
    coalescedInputs:median(entries.map(e=>e.phase.coalescedInputs)),
    visibleFrames:median(entries.map(e=>e.phase.visibleFrames)),
    deliveredFrames:median(entries.map(e=>e.phase.deliveredFrames)),
    discardedFrames:entries.reduce((n,e)=>n+(e.phase.cancelledBeforeMount||0)+(e.phase.supersededBeforePaint||0),0),
    staleAtPaint:entries.reduce((n,e)=>n+e.phase.staleAtPaint,0),
    upgradeRequestsDuringInput:entries.reduce((n,e)=>n+e.phase.upgradeRequestsDuringInput,0),
    upgradeRequestsAfterInput:entries.reduce((n,e)=>n+e.phase.upgradeRequestsAfterInput,0),
    refinementsDuringInput:entries.reduce((n,e)=>n+e.phase.refinementsDuringInput,0),
    refinementsAfterInput:entries.reduce((n,e)=>n+e.phase.refinementsAfterInput,0),
    bytes:median(entries.map(e=>e.phase.bytes)),
    errors:all.reduce((n,e)=>n+e.row.errors.length,0),
    timerLatenessMs:median(entries.flatMap(e=>e.row.inputs.filter(i=>i.phase===e.phase.name).map(i=>i.timerDelayMs))),
    caughtUpPaintMs:median(entries.flatMap(e=>e.row.inputs.filter(i=>i.phase===e.phase.name).map(i=>i.caughtUpPaintMs)))
  };
});
fs.writeFileSync(path.join(path.dirname(filename),'rapid-summary.json'), JSON.stringify(summary,null,2)+'\n');
console.table(summary.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='number'?Math.round(value*10)/10:value]))));
