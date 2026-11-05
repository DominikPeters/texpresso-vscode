import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';
import { diagnostics } from './diagnostics';

const binary = process.env.TEXPRESSO_BINARY;
const enabled = !!binary && process.env.TEXPRESSO_TEST_PREVIEW === '1';
type State = Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
type Target = Extract<PreviewMessage, ['preview-forward', ...unknown[]]>;

async function fixture(text: string, check: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-page-cache-')));
  const originalProfile = process.env.TEXPRESSO_PROFILE, originalVideo = process.env.SDL_VIDEODRIVER;
  process.env.TEXPRESSO_PROFILE = '1'; process.env.SDL_VIDEODRIVER = 'texpresso-no-video-driver';
  const f = await setup(root, text);
  try { await f.session.start(); await check(f); }
  catch (error) { await diagnostics(root, '', f.debug()); throw error; }
  finally {
    await f.session.dispose(); await fs.rm(root, { recursive: true, force: true });
    if (originalProfile === undefined) { delete process.env.TEXPRESSO_PROFILE; } else { process.env.TEXPRESSO_PROFILE = originalProfile; }
    if (originalVideo === undefined) { delete process.env.SDL_VIDEODRIVER; } else { process.env.SDL_VIDEODRIVER = originalVideo; }
  }
}
async function setup(root: string, initial: string) {
  let text=initial, state: State | undefined, failure: Error | undefined, debug='', raw='', id=0;
  const main=document(path.join(root,'main.tex'),text); main.getText=()=>text;
  await fs.writeFile(main.fileName,text);
  const frames=new Map<number,PreviewImage>(), retries=new Set<number>(), targets: Target[]=[], sources: {line:number;word?:string}[]=[];
  const profile: {stage:string;page:number;request:number;bytes:number;ms:number}[]=[];
  const session=new TexpressoSession(main,{...config,command:binary!,packageProvider:'texlive',previewLocation:'editor',autoRerun:false,watchDependencies:false},
    new SessionPaths(main.fileName,false),()=>[main],{
      state() {}, output() {}, error:e=>{failure=e;},
      synctex:(_file,line,_column,word)=>sources.push({line,word}),
      debug:s=>{debug=(debug+s).slice(-200000);raw+=s;const lines=raw.split('\n');raw=lines.pop()!;
        for(const line of lines){const at=line.indexOf('[profile] ');if(at>=0){try{profile.push(JSON.parse(line.slice(at+10)));}catch{/* Interleaved compiler stderr. */}}}},
      preview:event=>{if('header' in event){frames.set(event.header.requestId,event);}else if(Array.isArray(event)){
        if(event[0]==='preview-state'){state=event;}if(event[0]==='preview-retry'){retries.add(event[1]);}
        if(event[0]==='preview-forward'){targets.push(event);}if(event[0]==='preview-error'){failure=new Error(event[2]);}}}
    });
  const until=async(check:()=>boolean)=>{const end=Date.now()+30000;while(!check()){
    if(failure||Date.now()>end){throw failure||new Error('Cache test timeout\n'+debug.slice(-10000));}await new Promise(r=>setTimeout(r,10));}};
  const render=async(page:number,svg=false,width=700,base?:number)=>{
    for(let attempt=0;attempt<30;attempt++){
      await until(()=>!!state&&state[2]===session.previewSequence);
      const request=++id;
      if(base!==undefined){session.send(['preview-png',request,page,width,state![1],state![2],base]);}
      else{session.send([svg?'preview-svg':'preview-render',request,page,width,state![1],state![2]]);}
      await until(()=>frames.has(request)||retries.has(request));if(frames.has(request)){return frames.get(request)!;}
    }throw Error('Too many cache test retries');
  };
  const change=(old:string,replacement:string)=>{
    const offset=text.indexOf(old);assert.ok(offset>=0,'find edited source');
    const pos=(n:number)=>{const before=text.slice(0,n);return{line:before.split('\n').length-1,character:n-before.lastIndexOf('\n')-1};};
    const range={start:pos(offset),end:pos(offset+old.length)} as vscode.Range;
    text=text.slice(0,offset)+replacement+text.slice(offset+old.length);
    session.sync.change(main,[{range,rangeOffset:offset,rangeLength:old.length,text:replacement}]);
  };
  const forward=async(needle:string)=>{
    const line=text.slice(0,text.indexOf(needle)).split('\n').length-1,count=targets.length;
    session.sync.syncForward(main,line);await until(()=>targets.length>count);return targets.at(-1)!;
  };
  return{root,session,main,profile,frames,targets,sources,until,render,change,forward,debug:()=>debug,text:()=>text};
}

test('unchanged native page reuse validates programs/fonts/geometry while refreshing source and link metadata',
  {skip:!enabled,timeout:120000},async()=>fixture(String.raw`\documentclass{article}
\usepackage[xetex,hidelinks]{hyperref}
\usepackage{tikz}
\pagestyle{empty}
\begin{document}
First page unchanged.
\newpage
\hypertarget{stable}{Stable anchor.}
\href{https://example.com/old}{Stable linked words.}
\par\noindent{\large Font-sensitive paragraph.}
\begin{tikzpicture}\draw[blue,thick] (0,0)--(2,1);\end{tikzpicture}
\newpage
Last page untouched.
\end{document}
`,async f=>{
    await f.render(0);
    const original=await f.render(1,true);assert.equal(original.header.mime,'image/svg+xml');
    const hitStart=f.profile.length;await f.render(0);const returned=await f.render(1,true);
    assert.deepEqual(returned.bytes,original.bytes);assert.deepEqual(returned.header.annotations,original.header.annotations);
    await f.until(()=>f.profile.slice(hitStart).some(p=>p.stage.startsWith('page-list-cache-')&&p.page===1));
    assert.ok(f.profile.slice(hitStart).some(p=>p.stage==='page-list-cache-hit'&&p.page===1),f.debug().slice(-6000));
    assert.ok(f.profile.slice(hitStart).some(p=>p.stage==='page-export-cache-hit'&&p.page===1),'returning to a page skips export too');
    const png=await f.render(1,false,700,0),noop=await f.render(1,false,700,png.header.rasterId);
    assert.equal(noop.bytes.length,0);assert.deepEqual(noop.header.patch?.rect,[0,0,0,0],'export hits preserve PNG no-op patch semantics');
    const beforeDraws=f.profile.filter(p=>p.stage==='png-draw'&&p.page===1).length;
    const full=await f.render(1);assert.deepEqual(full.bytes,png.bytes);
    assert.equal(f.profile.filter(p=>p.stage==='png-draw'&&p.page===1).length,beforeDraws,'cached raster needs no redraw');

    const beforeComment=f.profile.length;f.change('First page unchanged.','% Added source line without changing output\nFirst page unchanged.');
    const shifted=await f.render(1,true);assert.ok(shifted.header.sequence>original.header.sequence);
    assert.deepEqual(shifted.bytes,original.bytes,'a source-only change keeps exact vectors');
    await f.until(()=>f.profile.slice(beforeComment).some(p=>p.stage.startsWith('page-list-cache-')&&p.page===1));
    assert.ok(f.profile.slice(beforeComment).some(p=>p.stage==='page-list-cache-hit'&&p.page===1),f.debug().slice(-6000));
    await f.until(()=>f.profile.slice(beforeComment).some(p=>p.stage==='page-export-cache-hit'&&p.page===1));
    const target=await f.forward('Stable linked words.');assert.equal(target[3],1);
    const sourceCount=f.sources.length;
    f.session.send(['preview-inverse',target[1],target[2],1,target[4],target[5]]);
    await f.until(()=>f.sources.length>sourceCount);
    const line1=f.text().slice(0,f.text().indexOf('\\href{')).split('\n').length;
    assert.equal(f.sources.at(-1)!.line,line1,'cache reuse still uses fresh SyncTeX source lines');

    f.change('https://example.com/old','https://example.com/new');const link=await f.render(1,true);
    assert.deepEqual(link.bytes,original.bytes,'changing only a URI leaves vectors identical');
    assert.ok(link.header.annotations!.links.some(l=>l.uri==='https://example.com/new'));
    assert.ok(!link.header.annotations!.links.some(l=>l.uri==='https://example.com/old'),'link metadata is not inherited from pixel cache');
    f.change('\\large Font-sensitive','\\Huge Font-sensitive');const font=await f.render(1,true);
    assert.notDeepEqual(font.bytes,link.bytes,'font scale/spec changes invalidate the list/export');
    f.change('\\Huge Font-sensitive','\\large Font-sensitive');const restored=await f.render(1,true);
    assert.deepEqual(restored.bytes,link.bytes,'restoring exact content can reuse its old immutable render');
    f.change('\\pagestyle{empty}', '\\usepackage[paperwidth=400pt,paperheight=600pt]{geometry}\\pagestyle{empty}');
    const resized=await f.render(1,true);assert.notDeepEqual(resized.header.bounds,restored.header.bounds,'page dimensions participate in validation');
    assert.ok(f.profile.every(p=>!p.stage.startsWith('page-list-cache-')||p.bytes<=32*1024*1024));
    assert.ok(f.profile.every(p=>p.stage!=='page-export-cache-hit'||p.bytes<=32*1024*1024));
  }));

test('native page caches evict distant content and bypass external-resource pages',
  {skip:!enabled,timeout:120000},async()=>fixture('\\documentclass{article}\n\\usepackage{graphicx}\n\\pagestyle{empty}\n\\begin{document}\n'+
    Array.from({length:12},(_,i)=>`Unique page ${i}.\\par ${i===11?'\\includegraphics[width=30pt]{picture.pdf}':''}${i===11?'':'\\newpage'}\n`).join('')+'\\end{document}\n',async f=>{
    const paint='0 0 1 rg 0 0 20 20 re f',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << >> /Contents 4 0 R >>',`<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
    const xref=pdf.length;pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await fs.writeFile(path.join(f.root,'picture.pdf'),pdf);
    const first=await f.render(0,false,300);
    for(let page=1;page<11;page++){await f.render(page,false,300);}
    const afterEviction=f.profile.length;const returned=await f.render(0,false,300);
    assert.deepEqual(returned.bytes,first.bytes);
    await f.until(()=>f.profile.slice(afterEviction).some(p=>p.stage==='page-list-cache-miss'&&p.page===0));
    const beforeImage=f.profile.length;const image=await f.render(11,false,300);await f.render(0,false,300);const repeated=await f.render(11,false,300);
    assert.deepEqual(image.bytes,repeated.bytes);
    await f.until(()=>f.profile.slice(beforeImage).filter(p=>p.stage==='page-list-cache-bypass'&&p.page===11).length>=2);
    assert.equal(f.profile.slice(beforeImage).filter(p=>p.stage==='page-export-cache-hit'&&p.page===11).length,0,'external resources are never reused without a dependency manifest');
    assert.ok(f.profile.every(p=>!p.stage.startsWith('page-list-cache-')||p.bytes<=32*1024*1024));
  }));

test('native cache bypasses unfinished PDF paths carried between page frames',
  {skip:!enabled,timeout:60000},async()=>fixture(String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
\special{pdf:code 0 0 m 40 0 l}
A path begins on this page.
\newpage
\special{pdf:code S}
Its stroke completes on this page.
\end{document}
`,async f=>{
    await f.render(0,false,300);const first=await f.render(1,false,300);
    const before=f.profile.length;await f.render(0,false,300);const repeated=await f.render(1,false,300);
    assert.deepEqual(repeated.bytes,first.bytes);
    await f.until(()=>f.profile.slice(before).some(p=>p.stage==='page-list-cache-bypass'&&p.page===1));
    assert.equal(f.profile.slice(before).filter(p=>p.stage==='page-export-cache-hit').length,0,'carried path state cannot be hidden behind cached page bytes');
  }));
