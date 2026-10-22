/* Compare real native full PNG and negotiated patches on the existing corpus.
 * Uses local TeX Live, headless rendering and no downloads. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {Run,fixtures}=require('../profile-preview.cjs');
const output=path.resolve(process.argv[2]||'artifacts/profile-png-native');
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Choose a new output directory');
fs.mkdirSync(output,{recursive:true});
const binary=path.resolve(process.env.TEXPRESSO_BINARY||'native/.bundles/darwin-arm64-preview/bin/texpresso');
const list=fixtures(output,[1],['sparse','dense','packed','tikz']);
const rows=[];
(async()=>{
 for(const fixture of list)for(const patches of [false,true]){
  const run=new Run(fixture,binary,'png',1600,output,0);let base=0;
  if(patches)run.render=async page=>{
   for(;;){await run.until(()=>run.state&&run.state[2]===run.session.previewSequence,'source barrier');
    const id=++run.id;run.session.send(['preview-png',id,page,run.width,run.state[1],run.state[2],base]);
    await run.until(()=>run.frames.has(id)||run.retries.has(id),'PNG patch');
    if(run.frames.has(id)){const frame=run.frames.get(id);run.frames.delete(id);base=frame.header.rasterId;return frame;}
   }
  };
  try{
   await run.session.start();const initial=await run.render(0),samples=[];
   for(let i=0;i<9;i++){
    run.edit(0,fixture.kind==='tikz');const frame=await run.render(0);
    await new Promise(resolve=>setTimeout(resolve,10));
    const rss=Number(cp.execFileSync('ps',['-o','rss=','-p',String(run.pid)],{encoding:'utf8'}).trim())*1024;
    if(i>=2)samples.push({bytes:frame.bytes.length,patch:frame.header.patch,rss,
      stages:run.profile.filter(p=>p.request===frame.header.requestId)});
   }
   rows.push({fixture:fixture.id,patches,width:initial.header.width,height:initial.header.height,initialBytes:initial.bytes.length,samples});
   console.log(fixture.id,patches?'patch':'full',samples.map(s=>s.bytes).join(','));
  }finally{await run.dispose();}
 }
 fs.writeFileSync(path.join(output,'native-png.json'),JSON.stringify({schema:1,rows},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
