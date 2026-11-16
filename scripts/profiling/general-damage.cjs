#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Engine}=require('./surface-export.cjs'),{prepare,fingerprint}=require('./real-corpus.cjs');
const {decode}=require('./clipped-raster.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const point=text=>{const lines=text.split('\n');return [lines.length-1,lines.at(-1).length];};
function replace(engine,text) {
  let start=0,end=engine.text.length,tail=text.length;
  while(start<end&&start<tail&&engine.text[start]===text[start])start++;
  while(end>start&&tail>start&&engine.text[end-1]===text[tail-1]){end--;tail--;}
  engine.send(['change-range',engine.file,...point(engine.text.slice(0,start)),...point(engine.text.slice(0,end)),text.slice(start,tail)]);
  engine.text=text;engine.send(['preview-barrier',++engine.sequence]);
}
async function main() {
  const [config,baseline,experiment,outputArg]=process.argv.slice(2),output=path.resolve(outputArg);
  if(fs.existsSync(output))throw Error('Use a fresh output directory');
  fs.mkdirSync(output,{recursive:true});const fixtures=prepare(config,output),samples=[],inputs=JSON.parse(fs.readFileSync(config));
  const meta={created:new Date().toISOString(),cpu:'Apple M1 Pro',platform:process.platform,architecture:process.arch,
    harnessSha256:sha(fs.readFileSync(__filename)),experimentManifest:JSON.parse(fs.readFileSync(path.join(path.dirname(experiment),'manifest.json'))),
    fixtures:fixtures.map(f=>({id:f.id,sourceSha256:f.sourceSha256,originalSha256:f.originalSha256,viewportPoint:inputs.find(i=>i.id===f.id).viewportPoint,clipOffset:inputs.find(i=>i.id===f.id).clipOffset,theme:inputs.find(i=>i.id===f.id).theme,compatibility:f.compatibility}))};
  fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(meta,null,2));
  for(const fixture of fixtures)for(const scenario of (inputs.find(i=>i.id===fixture.id).scenarios||['small','reflow',...(inputs.find(i=>i.id===fixture.id).figureChange?['figure']:[])]))for(const [variant,binary] of [['baseline',baseline],['flat',experiment],['direct',experiment]]) {
    process.env.TEXPRESSO_DAMAGE_DIRECT=variant==='direct'?'1':'0';
    const engine=new Engine(path.resolve(binary),fixture.file);
    try {
      let initial=await engine.surface(fixture.focusPage,1000,[0,0,1000,8192]);
      const bounds=initial.header.bounds,w=bounds[2]-bounds[0],h=bounds[3]-bounds[1];
      engine.send(['synctex-forward',fixture.file,fixture.text.slice(0,fixture.editOffset).split('\n').length]);
      await engine.until(()=>engine.forward?.[2]===engine.sequence);assert.equal(engine.forward[3],fixture.focusPage);
      const input=inputs.find(i=>i.id===fixture.id),focus=input.viewportPoint||engine.forward.slice(4,6);
      const grid=Math.min(4000,Math.floor(Math.sqrt(15000000*w/h))),scale=grid/w,gh=Math.ceil(h*scale-1e-4);
      const x=Math.floor(Math.max(0,Math.min(grid-2048,(focus[0]-bounds[0])*scale-1024))/512)*512;
      const y=w>h?0:Math.floor(Math.max(0,Math.min(gh-1536,(focus[1]-bounds[1])*scale-512))/512)*512;
      const offset=input.clipOffset||[0,0];
      const clip=[x+offset[0],y+offset[1],Math.min(grid,x+2048-offset[0]),Math.min(gh,y+1536-offset[1])];
      if(input.theme)engine.send(['theme',...input.theme]);
      let frame=await engine.surface(fixture.focusPage,grid,clip),base=frame.header.rasterId;
      let composite=decode(frame.bytes),visibleChanges=0;
      for(let repeat=0;repeat<7;repeat++) {
        const insert=scenario!=='reflow'||repeat%2 ? ' X'+repeat :
          ' '+('Additional words make this paragraph wrap onto further lines and move the following content. '.repeat(w>h?1:8))+repeat;
        let text=fixture.text.slice(0,fixture.editOffset)+insert+fixture.text.slice(fixture.editOffset);
        if(scenario==='figure' && repeat%2===0) {
          const change=inputs.find(i=>i.id===fixture.id).figureChange;
          assert.ok(text.includes(change.from));text=text.replace(change.from,change.to);
        }
        replace(engine,text);
        frame=await engine.surface(fixture.focusPage,grid,clip,base);base=frame.header.rasterId;
        if(scenario==='small')assert.ok(frame.bytes.length>0,'Each typing edit must change visible pixels');
        assert.ok(frame.stages['png-draw']!==undefined,'Every edit must rasterize or analyze, never be a page-export cache hit');
        if(frame.header.patch) {
          const [px,py,pw,ph]=frame.header.patch.rect;
          if(frame.bytes.length) {
            const patch=decode(frame.bytes);assert.equal(patch.width,pw);assert.equal(patch.height,ph);
            for(let row=0;row<ph;row++)patch.rgb.copy(composite.rgb,((py+row)*composite.width+px)*3,row*pw*3,(row+1)*pw*3);
            visibleChanges++;
          }
        } else {composite=decode(frame.bytes);visibleChanges++;}
        const row={fixture:fixture.id,scenario,variant,repeat,warmup:repeat===0,grid,clip,sourceSha256:sha(Buffer.from(text)),
          pixels:frame.header.width*frame.header.height,pngBytes:frame.bytes.length,pixelSha256:sha(composite.rgb),
          exportMs:frame.header.exportMs,stages:frame.stages,damage:frame.damage};
        if(variant!=='baseline')assert.equal(row.damage?.exact,true,'Every candidate image must pass full-reference verification');
        samples.push(row);fs.appendFileSync(path.join(output,'samples.jsonl'),JSON.stringify(row)+'\n');
      }
      assert.ok(visibleChanges>0,'The measured edit must change pixels inside the viewport');
      console.log(fixture.id,scenario,variant,'complete');
    } finally {await engine.close();}
    assert.equal(fingerprint(fixture.projectRoot).sha256,fixture.projectFingerprint.sha256);
  }
  for(const row of samples.filter(r=>r.variant!=='baseline')) {
    const baseline=samples.find(r=>r.fixture===row.fixture&&r.scenario===row.scenario&&r.variant==='baseline'&&r.repeat===row.repeat);
    assert.equal(row.sourceSha256,baseline.sourceSha256);assert.deepEqual(row.clip,baseline.clip);
    assert.equal(row.pixelSha256,baseline.pixelSha256,'Candidate patch chain and unmodified engine must reconstruct identical pixels');
  }
  fs.writeFileSync(path.join(output,'complete.json'),JSON.stringify({exactComparisons:samples.filter(r=>r.variant!=='baseline').length,samples:samples.length}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
