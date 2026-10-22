import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PreviewController } from '../../preview-controller';
import type { TexpressoSession } from '../../session';
import type { Command } from '../../protocol';

function solidPng(width:number,height:number,color:[number,number,number]):Buffer {
  const chunk=(type:string,bytes:Buffer)=>{const name=Buffer.from(type),body=Buffer.concat([name,bytes]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++){crc=(crc>>>1)^((crc&1)?0xedb88320:0);}}
    const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1);for(let x=0;x<width;x++){row[x*3+1]=color[0];row[x*3+2]=color[1];row[x*3+3]=color[2];}
  const pixels=Buffer.alloc(row.length*height);for(let y=0;y<height;y++){row.copy(pixels,y*row.length);}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

// Real production DOM/controller/renderer, with deterministic native responses.
// This isolates ownership/anchoring/frontier scheduling from compiler timing.
export async function checkContinuousPreview(extensionUri: vscode.Uri): Promise<void> {
  const repo=path.resolve(__dirname,'../../..');
  const bootstrap=await fs.readFile(path.join(repo,'src/test/fixtures/continuous-webview.js'),'utf8');
  const main=(await fs.readFile(vscode.Uri.joinPath(extensionUri,'media/preview.js').fsPath,'utf8')).replaceAll('acquireVsCodeApi','continuousApi');
  const make=async(unknown=false,png=false)=>{
    const reports:any[]=[],commands:Command[]=[],pending:Command[]=[],opened:string[]=[];
    const regionPending:{command:Command;purpose:string}[]=[];
    let panel:vscode.WebviewPanel|undefined,controller:PreviewController;
    let count=unknown?1:png?2:6,complete=!unknown,revision=1,sequence=0,actionId=0;
    const session={embedded:true,state:'running',paused:false,previewSequence:0,previewSvg:true,previewBackground:true,previewLinks:true,previewRegions:png,
      document:{fileName:'/fixture/continuous.tex'},send:(command:Command)=>{
        commands.push(command);
        if(command[0]==='preview-region'){regionPending.push({command,purpose:(controller as any).inFlight?.region?.purpose});}
        if(/^preview-(?:render|png|svg|auto|background)$/.test(command[0])){pending.push(command);}
        if(command[0]==='preview-cancel'){for(let i=pending.length-1;i>=0;i--){if(command[1]===0||pending[i][1]===command[1]){pending.splice(i,1);}}}
      }};
    const createPanel=(...args:Parameters<typeof vscode.window.createWebviewPanel>)=>{
      const real=vscode.window.createWebviewPanel(...args);panel=real;
      return {get visible(){return real.visible;},onDidChangeViewState:real.onDidChangeViewState.bind(real),onDidDispose:real.onDidDispose.bind(real),dispose:()=>real.dispose(),webview:{
        cspSource:real.webview.cspSource,asWebviewUri:real.webview.asWebviewUri.bind(real.webview),postMessage:real.webview.postMessage.bind(real.webview),
        onDidReceiveMessage:(callback:(message:unknown)=>void)=>real.webview.onDidReceiveMessage(message=>{if(message.continuousCheck){reports.push(message);}else {callback(message);}}),
        set html(value:string){const nonce=value.match(/data-instance="([^"]+)"/)![1];
          value=value.replace(/style-src ([^;]+);/,`style-src $1 'nonce-${nonce}';`);
          value=value.replace('</head>',`<style nonce="${nonce}">html,body{width:800px;height:700px;overflow:hidden}</style></head>`);
          value=value.replace(/<script nonce=/,()=>`<script nonce="${nonce}">${bootstrap.replace('__FORMAT__',JSON.stringify(png?'png':'svg')).replace('__ZOOM__',JSON.stringify(png?'1':'0.5'))}</script><script nonce=`);
          value=value.replace(/<script nonce="[^"]+" src="[^"]*\/preview\.js"><\/script>/,()=>`<script nonce="${nonce}">${main}</script>`);real.webview.html=value;
        }}};
    };
    const api={Uri:vscode.Uri,ViewColumn:vscode.ViewColumn,env:{openExternal:async(uri:vscode.Uri)=>{opened.push(uri.toString());return true;}},window:{createWebviewPanel:createPanel}} as unknown as typeof vscode;
    controller=new PreviewController(api,extensionUri,session as unknown as TexpressoSession,()=>{},()=>{});
    const until=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+30000;while(!check()){
      const failure=reports.find(r=>r.continuousCheck==='failure');if(failure||Date.now()>deadline){throw Error(label+': '+JSON.stringify({failure,reports:reports.slice(-8),commands:commands.slice(-12)}));}
      await new Promise(resolve=>setTimeout(resolve,10));}};
    const action=async(name:string,extra:object={})=>{const id=++actionId;await panel!.webview.postMessage({continuousAction:{id,name,...extra}});await until(()=>reports.some(r=>r.action===id),'browser action '+name);return reports.find(r=>r.action===id)!;};
    const state=(newCount=count,newComplete=complete,nativePage=0)=>{count=newCount;complete=newComplete;controller.handle(['preview-state',revision,sequence,count,complete,nativePage]);};
    const respond=(command:Command,height=unknown?900:300)=>{
      const page=command[2] as number;if(unknown&&page>=count){count=page+1;}
      state(count,complete,page);
      // Identical encoded content deliberately has page-specific metadata/bounds.
      const bytes=png?solidPng(600,300,[255,255,255]):Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300"><path fill="#fff" d="M0 0H600V300H0Z"/><path fill="#246" d="M20 20H200V60H20Z"/></svg>');
      controller.handle({header:{requestId:command[1] as number,page,revision:command[4] as number,sequence:command[5] as number,bounds:[0,0,600,height],width:600,height:300,mime:png?'image/png':'image/svg+xml',byteLength:bytes.length,
        annotations:{links:[{bounds:[20,20,200,60],uri:`https://example.com/page-${page}`}],destinations:[]}},bytes});
    };
    const respondRegion=(entry:{command:Command;purpose:string},color:[number,number,number])=>{
      const command=entry.command,bounds=command.slice(6,10) as number[],ratio=(bounds[3]-bounds[1])/(bounds[2]-bounds[0]);
      const width=Math.max(1,Math.min(command[3] as number,Math.floor(Math.sqrt(4000000/ratio)))),height=Math.max(1,Math.ceil(width*ratio));
      const bytes=solidPng(width,height,color);
      controller.handle({header:{requestId:command[1] as number,page:command[2] as number,revision:command[4] as number,sequence:command[5] as number,bounds:bounds as [number,number,number,number],width,height,mime:'image/png',byteLength:bytes.length},bytes});
    };
    const drain=async(limit=30)=>{for(let i=0;i<limit;i++){if(!pending.length){await new Promise(resolve=>setTimeout(resolve,30));if(!pending.length){return;}}const command=pending.shift()!;respond(command);await until(()=>reports.some(r=>r.continuousCheck==='decoded'&&r.request===command[1])||(controller as any).inFlight?.id!==command[1],'page decode '+command[2]);}throw Error('unbounded render queue');};
    state();await until(()=>reports.some(r=>r.continuousCheck==='ready')&&pending.length>0,'continuous startup ready');
    return {controller,panel:()=>panel!,session,reports,commands,pending,regionPending,opened,until,action,state,respond,respondRegion,drain,
      invalidate:()=>{session.previewSequence=++sequence;revision++;controller.handle({sourceSequence:sequence});controller.handle(['preview-invalidated',revision,sequence]);state();}};
  };
  const f=await make();
  try {
    const initial=f.pending.shift()!;assert.equal(initial[2],0);f.respond(initial);
    await f.until(()=>f.reports.some(r=>r.continuousCheck==='decoded'&&r.request===initial[1])&&f.pending.some(c=>c[2]===1),'visible neighbor demand');
    const before=await f.action('scroll',{top:100});const neighbor=f.pending.splice(f.pending.findIndex(c=>c[2]===1),1)[0];f.respond(neighbor,600);
    await f.until(()=>f.reports.some(r=>r.continuousCheck==='decoded'&&r.request===neighbor[1]),'neighbor decoded');
    const after=await f.action('snapshot');
    assert.ok(Math.abs(after.scrollTop-before.scrollTop)<1,'mixed-size neighbor decode preserves scrollTop');
    const centered=after.shells.find((s:any)=>s.top<=after.height/2&&s.bottom>=after.height/2);
    assert.equal(after.toolbar,centered?.page,'toolbar follows the page under viewport center after geometry correction');
    const pages=after.shells.filter((s:any)=>s.visible&&s.rendered);assert.ok(pages.some((s:any)=>s.page===0)&&pages.some((s:any)=>s.page===1),'adjacent pages remain visible together');
    assert.notEqual(pages.find((s:any)=>s.page===0).root,pages.find((s:any)=>s.page===1).root,'identical content has independent mounted roots');
    f.state(6,true,5);const observation=await f.action('snapshot');assert.equal(observation.toolbar,after.toolbar,'native current page cannot select browser toolbar');assert.ok(Math.abs(observation.scrollTop-after.scrollTop)<1);
    const stableLayout=await f.action('snapshot');f.state(1,false,0);await new Promise(resolve=>setTimeout(resolve,160));const prefix=await f.action('snapshot');
    assert.equal(prefix.stackHeight,stableLayout.stackHeight,'temporary incomplete compiler prefix retains learned full-document geometry');
    assert.ok(Math.abs(prefix.scrollTop-stableLayout.scrollTop)<1,'prefix rollback cannot jump the viewport');assert.equal(prefix.epoch,stableLayout.epoch,'compiler prefix notifications cannot create a user-scroll epoch');
    f.state(6,true,0);
    await f.action('link',{page:0});await f.action('link',{page:1});await f.until(()=>f.opened.length===2,'owning page links');
    assert.deepEqual(f.opened,['https://example.com/page-0','https://example.com/page-1']);
    await f.action('inverse',{page:1});await f.drain();await f.until(()=>f.commands.some(c=>c[0]==='preview-inverse'&&c[3]===1),'page-one inverse routing');
    await f.action('remember-link',{page:1});const opened=f.opened.length;f.invalidate();await f.action('click-remembered');assert.equal(f.opened.length,opened,'stale detached link cannot navigate');
    f.state(10000,true,0);await f.action('jump',{page:4000});await f.drain();const far=await f.action('snapshot');
    assert.ok(far.shellCount>0&&far.shellCount<=12,'ten-thousand-page catalogue mounts at most12shells');assert.ok(Number.isFinite(far.residentBytes)&&far.residentBytes<=32*1024*1024,'all resident page surfaces share the32MiB budget');
    assert.ok(far.shells.some((s:any)=>s.page===4000&&s.rendered),'explicit far jump reaches its page without mounting document prefix');
    const rendersBeforeEmpty=f.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0])).length;
    f.state(0,true,0);const empty=await f.action('snapshot');
    assert.equal(empty.toolbarValue,'','zero-page document has no selected physical page');assert.equal(empty.toolbarDisabled,true,'zero-page page selector is disabled');
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(f.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0])).length,rendersBeforeEmpty,'terminal empty document cannot enqueue vanished pages');
    f.state(3,true,0);await f.action('jump',{page:0});await f.drain();const recovered=await f.action('snapshot');
    assert.equal(recovered.toolbarDisabled,false);assert.ok(recovered.shells.some((s:any)=>s.page===0&&s.rendered),'nonempty output recovers after an empty document');
    console.log('PASS: continuous real webview shows adjacent pages, preserves anchors, isolates surfaces/metadata and bounds distant-page resources');
  } finally {f.controller.dispose();}
  const unknown=await make(true);
  try {
    await unknown.drain();await new Promise(resolve=>setTimeout(resolve,500));await unknown.drain();
    const rendered=unknown.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0]));
    assert.ok(rendered.length>0&&Math.max(...rendered.map(c=>c[2] as number))<=2,'stationary unknown frontier advances at most two pages during initial fill');
    const settled=rendered.length;await new Promise(resolve=>setTimeout(resolve,350));await unknown.drain();
    assert.equal(unknown.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0])).length,settled,'response arrival does not create another scroll epoch');
    console.log('PASS: unknown frontier settles without runaway compilation or export');
  } finally {unknown.controller.dispose();}
  const resources=await make(false,true);
  const region=async(purpose:string,page:number,color:[number,number,number])=>{
    await resources.until(()=>resources.regionPending.some(r=>r.purpose===purpose&&r.command[2]===page),'native '+purpose+' request for page '+page);
    const index=resources.regionPending.findIndex(r=>r.purpose===purpose&&r.command[2]===page),entry=resources.regionPending.splice(index,1)[0];
    resources.respondRegion(entry,color);
    await resources.until(()=>resources.reports.some(r=>r.continuousCheck==='decoded'&&r.request===entry.command[1]),'native '+purpose+' decoded on page '+page);
  };
  try {
    await resources.drain();await region('detail',0,[180,180,180]);
    const firstDetail=await resources.action('snapshot');assert.ok(firstDetail.shells.find((s:any)=>s.page===0)?.detailSrc,'first active page mounts its high-resolution detail');
    await resources.action('jump',{page:1});await resources.drain();await region('detail',1,[200,200,200]);
    const secondDetail=await resources.action('snapshot');assert.ok(!secondDetail.shells.find((s:any)=>s.page===0)?.detailSrc,'changing detail owner releases the previous IMG source');
    assert.equal(secondDetail.shells.filter((s:any)=>s.detailSrc).length,1,'only one page retains decoded high-resolution detail');
    await resources.action('remember-detail',{page:1});
    await resources.action('lens',{page:0});await region('region',0,[255,0,0]);const firstLens=await resources.action('snapshot');
    assert.ok(firstLens.lensConnected&&!firstLens.lensHidden&&firstLens.lensWidth>0&&firstLens.lensSrc,'native magnifier crop is mounted on first page');
    const closed=await resources.action('close-lens');assert.equal(closed.lensSrc,null,'closing magnifier releases its native tile source');
    await resources.action('lens',{page:1});await region('region',1,[0,0,255]);const secondLens=await resources.action('snapshot');
    assert.ok(secondLens.lensConnected&&!secondLens.lensHidden&&secondLens.lensWidth>0,'second-page native crop is mounted in the live lens');
    assert.notEqual(secondLens.lensIdentity,firstLens.lensIdentity,'second owner replaces the current global IMG, not its captured detached predecessor');
    assert.notEqual(secondLens.lensSrc,firstLens.lensSrc,'second owner displays its own newly decoded native region');
    await resources.action('close-lens');resources.state(10000,true,1);const evicted=await resources.action('jump',{page:4000});
    assert.equal(evicted.rememberedDetailConnected,false);assert.equal(evicted.rememberedDetailSrc,null,'eviction releases the detached detail IMG decoded pixels');
    console.log('PASS: magnifier crops mount across page owners; one shared detail crop releases IMG sources on owner change and eviction');
  } finally {resources.controller.dispose();}
}
