#!/usr/bin/env node
/* Compiler rollback coverage, using local TeX Live and the headless frontend.
 * TEXPRESSO_BINARY=... node scripts/profiling/checkpoints.cjs [fresh-output]
 * TEXPRESSO_CHECKPOINT_REPEATS=3 increases independent sessions per edit site. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Run}=require('../profile-preview.cjs');
const {decode}=require('./png-regions.cjs');
const out=path.resolve(process.argv[2]||'artifacts/profile-checkpoints');
if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('Choose a fresh output directory');
fs.mkdirSync(out,{recursive:true});
const binary=path.resolve(process.env.TEXPRESSO_BINARY||'native/.bundles/darwin-arm64-preview/bin/texpresso');
const repeats=Number(process.env.TEXPRESSO_CHECKPOINT_REPEATS||1),rows=[];
const pagesList=(process.env.TEXPRESSO_CHECKPOINT_PAGES||'1,2').split(',').map(Number);
const sites=(process.env.TEXPRESSO_CHECKPOINT_SITES||'before,loop,inside,after').split(',');
function fixture(pages,site,repeat){
 const id=`page${pages}-${site}-${repeat}`,root=path.join(out,id);fs.mkdirSync(root);
 const text=String.raw`\documentclass{article}
\usepackage{tikz}
\pagestyle{empty}
\begin{document}
`+(pages===2?'First page.\\newpage\n':'')+String.raw`
Before figure marker aaaa.\par
\begin{tikzpicture}[x=0.15cm,y=0.15cm]
\foreach \x in {0,...,20} {\foreach \y in {0,...,20} {
\draw[blue,line width=0.2pt] (\x,\y) circle[radius=0.3];
\draw[red,line width=0.2pt] (\x,\y) -- +(0.45,0.55);
}}
\draw[black,thick] (0,0) .. controls (12,1.0) .. (20,20);
\end{tikzpicture}\par
After figure marker aaaa.\par
\end{document}
`;
 const file=path.join(root,'main.tex');fs.writeFileSync(file,text);
 return {id,root,file,text,pages,kind:'tikz'};
}
function pixels(bytes){const p=decode(bytes);return {width:p.width,height:p.height,channels:p.channels,raw:p.raw};}
(async()=>{
 for(let repeat=0;repeat<repeats;repeat++)for(const pages of pagesList)for(const site of sites){
  const f=fixture(pages,site,repeat),run=new Run(f,binary,'png',800,out,repeat),page=pages-1;
  const operations=[],frames=[];let frame,alternate;
  try{
   run.started=performance.now();await run.session.start();frame=await run.operation('initial',page);const initial=run.operations.at(-1);
   for(let edit=0;edit<4;edit++){
    const start=run.profile.length;
    frame=await run.operation(edit===0?'first-edit':`warm-edit-${edit}`,page,()=>{
     const pattern=site==='loop'?/(radius=)(0\.[34])/:site==='inside'?/(12,)([12]\.0)(\))/:site==='before'?/(Before figure marker )([ab]{4})/:/(After figure marker )([ab]{4})/;
     const match=run.text.match(pattern);assert.ok(match);
     run.replace(match.index+match[1].length,match[2].length,site==='loop'?(match[2]==='0.3'?'0.4':'0.3'):site==='inside'?(match[2]==='1.0'?'2.0':'1.0'):(match[2]==='aaaa'?'bbbb':'aaaa'));
    });
    frames.push(frame);if(edit===0)alternate=run.text;
    const rollback=run.profile.slice(start).filter(e=>e.stage==='compiler-rollback');
    operations.push({...run.operations.at(-1),rollback,checkpoints:run.profile.slice(start).filter(e=>e.stage==='compiler-checkpoint')});
   }
   fs.writeFileSync(path.join(f.root,'trace.txt'),run.trace);
   // Check BOTH source states against independent fresh engines. Timing
   // rows exclude these correctness runs and decoded-image comparisons.
   for(const [variant,text] of [f.text,alternate].entries()){
    fs.writeFileSync(f.file,text);
    const reference=new Run({...f,id:f.id+'-reference-'+variant,text},binary,'png',800,out,repeat);
    try{await reference.session.start();const clean=await reference.render(page);
     for(let i=0;i<frames.length;i++)if((i%2===0?1:0)===variant)
      assert.deepEqual(pixels(frames[i].bytes),pixels(clean.bytes),'rollback matches clean compile after edit '+i);
    }finally{await reference.dispose();}
   }
   rows.push({fixture:f.id,pages,site,initial,operations});
   console.log(f.id,operations.map(o=>`${o.name}:${o.ms.toFixed(1)}ms`).join(' '));
  }finally{await run.dispose();}
  fs.writeFileSync(path.join(out,'checkpoints.json'),JSON.stringify({schema:1,binary,repeats,rows},null,2));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
