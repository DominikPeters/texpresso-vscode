#!/usr/bin/env node
/* Exact preview demo corpus and native source-to-image timings. No downloads.
 * require(...).richFixture(output,id) also supplies the browser/VS Code corpus. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {Run}=require('../profile-preview.cjs');
const repo=path.resolve(__dirname,'../..');
function richFixture(output,id='rich-demo'){
 const root=path.join(path.resolve(output),id);fs.mkdirSync(root,{recursive:true});
 for(const ext of ['tex','bib']) fs.copyFileSync(path.join(repo,'scripts/preview-demo','showcase.'+ext),path.join(root,'showcase.'+ext));
 for(const ext of ['bbl','aux','out']) {
  const source=path.join(repo,'artifacts/preview-demo/sample','showcase.'+ext);
  if(!fs.existsSync(source))throw Error('Run npm run demo:preview once to generate local bibliography/reference fixtures');
  fs.copyFileSync(source,path.join(root,'showcase.'+ext));
 }
 const file=path.join(root,'showcase.tex');
 return {id,root,file,text:fs.readFileSync(file,'utf8'),pages:3,kind:'rich'};
}
async function main(){
 const output=path.resolve(process.argv[2]||'artifacts/profile-rich-demo-native');
 if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Choose a fresh output directory');
 fs.mkdirSync(output,{recursive:true});
 const binary=path.resolve(process.env.TEXPRESSO_BINARY||'native/.bundles/darwin-arm64-preview/bin/texpresso');
 const rows=[];
 for(const autoRerun of [false,true].filter(value=>!process.env.TEXPRESSO_RICH_RERUN||String(value)===process.env.TEXPRESSO_RICH_RERUN)){
  const fixture=richFixture(output,'rich-rerun-'+autoRerun),run=new Run(fixture,binary,'png',1600,output,0);
  run.session.autoRerun=autoRerun;run.session.configuration.autoRerun=autoRerun;
  const events=[];let raw='';const start=performance.now(),debug=run.session.events.debug;
  run.session.events.debug=text=>{raw+=text;debug(text);};
  run.onPreview=event=>events.push({at:performance.now()-start,event:'header'in event?{...event.header}:event});
  try{
   run.started=performance.now();await run.session.start();await run.operation('initial',0);
   await new Promise(resolve=>setTimeout(resolve,1600));
   const sentence='Edit this sentence and watch the preview change.';
   let at=run.text.indexOf(sentence)+sentence.length;
   for(const [name,insert,idle] of [['first-edit',' I',0],['warm-edit','t',0],['warm-edit',' works',1600],['after-idle-edit',' instantly',0]]){
    await run.operation(name,0,()=>{run.replace(at,0,insert);at+=insert.length;});
    if(idle)await new Promise(resolve=>setTimeout(resolve,idle));
   }
   fs.writeFileSync(path.join(fixture.root,'trace.log'),raw);
   rows.push({autoRerun,operations:run.operations,profile:run.profile,events});
   console.log(autoRerun?'rerun':'no-rerun',run.operations.map(o=>`${o.name}:${o.ms.toFixed(1)}ms`).join(' '));
  }finally{await run.dispose();}
 }
 fs.writeFileSync(path.join(output,'native.json'),JSON.stringify({schema:1,binary,rows},null,2));
}
module.exports={richFixture};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
