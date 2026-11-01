import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PreviewController } from '../../preview-controller';
import type { TexpressoSession } from '../../session';
import type { Command } from '../../protocol';

function solidPng(width:number,height:number,color:[number,number,number],ink?:[number,number,number,number]):Buffer {
  const chunk=(type:string,bytes:Buffer)=>{const name=Buffer.from(type),body=Buffer.concat([name,bytes]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++){crc=(crc>>>1)^((crc&1)?0xedb88320:0);}}
    const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const row=Buffer.alloc(width*3+1);for(let x=0;x<width;x++){row[x*3+1]=color[0];row[x*3+2]=color[1];row[x*3+3]=color[2];}
  const pixels=Buffer.alloc(row.length*height);for(let y=0;y<height;y++){row.copy(pixels,y*row.length);if(ink&&y>=ink[1]&&y<ink[3]){for(let x=ink[0];x<ink[2];x++){const offset=y*row.length+x*3+1;pixels[offset]=34;pixels[offset+1]=68;pixels[offset+2]=102;}}}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

// Real production DOM/controller/renderer, with deterministic native responses.
// This isolates ownership/anchoring/frontier scheduling from compiler timing.
export async function checkContinuousPreview(extensionUri: vscode.Uri): Promise<void> {
  const repo=path.resolve(__dirname,'../../..');
  const bootstrap=await fs.readFile(path.join(repo,'src/test/fixtures/continuous-webview.js'),'utf8');
  const main=(await fs.readFile(vscode.Uri.joinPath(extensionUri,'media/preview.js').fsPath,'utf8')).replaceAll('acquireVsCodeApi','continuousApi');
  const make=async(unknown=false,png=false,regions=png,fitText:false|'text'|'legacy'|'blank'=false)=>{
    const reports:any[]=[],commands:Command[]=[],pending:Command[]=[],opened:string[]=[];
    const regionPending:{command:Command;purpose:string}[]=[],rasters=new Map<number,number>();
    let panel:vscode.WebviewPanel|undefined,controller:PreviewController;
    let count=fitText?1:unknown?1:png?2:6,complete=!unknown,revision=1,sequence=0,actionId=0;
    let fitBounds:[number,number,number,number]=[40,50,400,290];
    const session={embedded:true,state:'running',paused:false,previewSequence:0,previewSvg:true,previewBackground:true,previewLinks:true,previewRegions:regions,previewPngPatches:png&&!!fitText,
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
          value=value.replace('</head>',`<style nonce="${nonce}">html,body{width:800px;height:${fitText?300:700}px;overflow:hidden}</style></head>`);
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
    const respond=(command:Command,height=unknown?900:300,color:[number,number,number]=[255,255,255],frame:{textBounds?:[number,number,number,number];noop?:boolean}={})=>{
      const page=command[2] as number;if((unknown||fitText&&!complete)&&page>=count){count=page+1;}
      state(count,complete,page);
      // Identical encoded content deliberately has page-specific metadata/bounds.
      const bounds:[number,number,number,number]=fitText?[-40,20,560,320]:[0,0,600,height];
      if(frame.textBounds){fitBounds=frame.textBounds;}
      const textBounds=frame.textBounds||(fitText==='text'?fitBounds:undefined);
      const ink=fitText&&fitText!=='blank'?(textBounds||[40,50,400,290]):undefined;
      const rasterHeight=300,id=command[1] as number,base=rasters.get(page);
      const pixels=ink?[ink[0]-bounds[0],ink[1]-bounds[1],ink[2]-bounds[0],ink[3]-bounds[1]] as [number,number,number,number]:undefined;
      const svg=fitText?`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="-40 20 600 300"><path fill="#fff" d="M-40 20H560V320H-40Z"/>${ink?`<path fill="#246" d="M${ink[0]} ${ink[1]}H${ink[2]}V${ink[3]}H${ink[0]}Z"/>`:''}</svg>`:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300"><path fill="#fff" d="M0 0H600V300H0Z"/><path fill="#246" d="M20 20H200V60H20Z"/></svg>';
      if(frame.noop){assert.ok(png&&base!==undefined,'metadata-only PNG requires an existing native raster');}
      const bytes=frame.noop?Buffer.alloc(0):png?solidPng(600,rasterHeight,color,pixels):Buffer.from(svg);
      if(png&&fitText){rasters.set(page,id);}
      controller.handle({header:{requestId:id,page,revision:command[4] as number,sequence:command[5] as number,bounds,width:600,height:rasterHeight,mime:png?'image/png':'image/svg+xml',byteLength:bytes.length,
        ...(textBounds?{textBounds}:{}),...(png&&fitText?{rasterId:id}:{}),...(frame.noop?{patch:{base:base!,rect:[0,0,0,0] as [number,number,number,number]}}:{}),
        annotations:{links:[{bounds:[20,20,200,60],uri:`https://example.com/page-${page}`}],destinations:[]}},bytes});
    };
    const respondRegion=(entry:{command:Command;purpose:string},color:[number,number,number])=>{
      const command=entry.command,bounds=command.slice(6,10) as number[],ratio=(bounds[3]-bounds[1])/(bounds[2]-bounds[0]);
      const width=Math.max(1,Math.min(command[3] as number,Math.floor(Math.sqrt(4000000/ratio)))),height=Math.max(1,Math.ceil(width*ratio));
      const bytes=solidPng(width,height,color);
      controller.handle({header:{requestId:command[1] as number,page:command[2] as number,revision:command[4] as number,sequence:command[5] as number,bounds:bounds as [number,number,number,number],width,height,mime:'image/png',byteLength:bytes.length},bytes});
    };
    const drain=async(limit=30)=>{for(let i=0;i<limit;i++){if(!pending.length){await new Promise(resolve=>setTimeout(resolve,30));if(!pending.length){return;}}const command=pending.shift()!;if((controller as any).inFlight?.id!==command[1]){continue;}respond(command);await until(()=>reports.some(r=>r.continuousCheck==='decoded'&&r.request===command[1])||(controller as any).inFlight?.id!==command[1],'page decode '+command[2]);}throw Error('unbounded render queue');};
    state();await until(()=>reports.some(r=>r.continuousCheck==='ready')&&pending.length>0,'continuous startup ready');
    return {controller,panel:()=>panel!,session,reports,commands,pending,regionPending,opened,until,action,state,respond,respondRegion,drain,
      forward:(page:number,x:number,y:number)=>{controller.beginSourceFollow();controller.handle(['preview-forward',revision,sequence,page,x,y]);},
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
    const beforeFollow=await f.action('snapshot');
    for (const [page,y] of [[1,280],[1,281],[1,279],[0,240]]) {
      f.controller.handle(['preview-forward',1,0,page,300,y]);
      const followed=await f.action('snapshot');
      assert.equal(followed.scrollTop,beforeFollow.scrollTop,'visible SVG SyncTeX target cannot reset to page top or recenter');
      assert.equal(followed.toolbar,beforeFollow.toolbar,'visible source target cannot steal the center-derived active page');
      assert.equal(followed.epoch,beforeFollow.epoch,'source following cannot create a user-scroll epoch');
    }
    await f.drain();
    console.log('PASS: repeated visible SVG SyncTeX targets and adjacent-page targets preserve exact scroll position');
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
    f.controller.beginSourceFollow();f.controller.handle(['preview-forward',2,1,2,300,150]);await f.drain();
    const revealed=await f.action('snapshot');
    assert.ok(revealed.shells.some((s:any)=>s.page===2&&s.visible&&s.rendered),'offscreen SVG SyncTeX target still reveals and renders its page');
    console.log('PASS: continuous real webview shows adjacent pages, preserves anchors, isolates surfaces/metadata and bounds distant-page resources');
  } finally {f.controller.dispose();}

  // The colored content is measured from the mounted SVG or PNG canvas, rather
  // than deriving the expected fit from the production layout calculations.
  for(const png of [false,true]){
    const fitted=await make(false,png,false,'text');
    const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,140));await fitted.drain();};
    const currentRequest=async(label:string)=>{
      const owns=(command:Command)=>command[2]===0&&command[1]===(fitted.controller as any).inFlight?.id;
      await fitted.until(()=>fitted.pending.some(owns),label);
      return fitted.pending.splice(fitted.pending.findIndex(owns),1)[0];
    };
    try{
      await fitted.drain();await fitted.action('zoom',{value:'text'});await fitted.action('landmark',{page:0,fraction:.3});
      const first=await fitted.action('snapshot'),sheet=first.shells.find((s:any)=>s.page===0);
      assert.equal(first.zoom,'text','Fit to text width is selectable in the production toolbar');
      assert.ok(sheet?.ink,'the real mounted surface contains the colored text fixture');
      assert.ok(sheet.ink.left>=-1&&sheet.ink.right<=first.width+1,'asymmetric text fits inside the horizontal viewport');
      assert.ok(Math.abs((sheet.ink.left+sheet.ink.right)/2-first.width/2)<2,'text is centered despite asymmetric margins and nonzero page origin');
      assert.ok(sheet.ink.right-sheet.ink.left>first.width*.9,'text uses the available width');
      assert.ok(sheet.width>first.width*1.4,'full paper remains present beyond the fitted text');
      const edgeY=20+first.centerPoint.fraction*300;
      for(const x of [40,400]){
        fitted.forward(0,x,edgeY);const edge=await fitted.action('snapshot');
        assert.equal(edge.shells.find((s:any)=>s.page===0).highlightHidden,false,'explicit source following applies the visible text-edge target');
        assert.ok(Math.abs(edge.scrollLeft-first.scrollLeft)<1,'visible text-edge SyncTeX target cannot drift horizontally');
      }
      fitted.forward(0,220,300);const vertical=await fitted.action('snapshot');
      assert.ok(vertical.scrollTop>first.scrollTop+first.height/2,'text fit retains vertical SyncTeX following: '+JSON.stringify({before:first.scrollTop,after:vertical.scrollTop,height:first.height,point:first.centerPoint,sheet:vertical.shells.find((s:any)=>s.page===0)}));
      const panned=await fitted.action('scroll',{left:0});
      fitted.forward(0,400,300);const revealed=await fitted.action('snapshot');
      assert.ok(revealed.scrollLeft>panned.scrollLeft+20,'an actually offscreen SyncTeX target still reveals after horizontal panning');
      assert.ok(revealed.shells.find((s:any)=>s.page===0).ink.right<=revealed.width+2,'revealed source edge is inside the viewport');
      const left=await fitted.action('scroll',{left:0}),right=await fitted.action('scroll',{left:1000000});
      assert.ok(left.shells.find((s:any)=>s.page===0).left>=-1,'left paper edge can be reached');
      assert.ok(right.shells.find((s:any)=>s.page===0).right<=right.width+1,'right paper edge can be reached');
      await fitted.action('zoom',{value:'width'});await fitted.action('zoom',{value:'text'});
      await fitted.action('landmark',{page:0,fraction:.45});const anchored=await fitted.action('snapshot');
      let centerAnchor=anchored.centerPoint;
      const stablePoint=(snapshot:any,label:string)=>{
        assert.equal(snapshot.centerPoint?.page,centerAnchor.page,label+' keeps the same page under the viewport center');
        const page=snapshot.shells.find((s:any)=>s.page===snapshot.centerPoint.page);
        assert.ok(Math.abs(snapshot.centerPoint.fraction-centerAnchor.fraction)*page.height<2,label+' preserves the vertical source landmark: '+JSON.stringify({anchor:centerAnchor,observed:snapshot.centerPoint,viewportHeight:snapshot.height,scrollTop:snapshot.scrollTop,page}));
      };
      const resized=await fitted.action('resize',{width:620});
      assert.equal(resized.topPoint?.page,anchored.topPoint.page,'resize keeps the same page at the viewport top');
      assert.ok(Math.abs(resized.topPoint.fraction-anchored.topPoint.fraction)*resized.shells.find((s:any)=>s.page===resized.topPoint.page).height<2,'resize preserves the top-edge source landmark');
      let zoomOrigin=await fitted.action('landmark',{page:0,fraction:.5});
      for(const value of ['width','1','text']){
        const zoomed=await fitted.action('zoom',{value}),anchor=zoomOrigin.centerPoint;
        const page=zoomed.shells.find((s:any)=>s.page===anchor.page);
        assert.ok(page.height>=zoomed.height,'zoom fixture keeps its midpoint reachable');
        // The chosen client pixel stays fixed even if changing scrollbar
        // presence changes the viewport's center after the zoom.
        const projectedY=page.top+anchor.fraction*page.height;
        assert.ok(Math.abs(projectedY-zoomOrigin.height/2)<2,'zoom '+value+' preserves its chosen source landmark: '+JSON.stringify({before:zoomOrigin.centerPoint,originY:zoomOrigin.height/2,projectedY,page,viewportHeight:zoomed.height}));
        zoomOrigin=zoomed;
      }
      centerAnchor=zoomOrigin.centerPoint;await settle();
      const learned=await fitted.action('snapshot'),learnedWidth=learned.shells.find((s:any)=>s.page===0).width;
      // Narrower edited content must not make the shared text envelope breathe.
      fitted.invalidate();const changed=await currentRequest('edited fitted page requested');
      fitted.respond(changed,900,[255,255,255],{textBounds:[80,50,360,290]});
      await fitted.until(()=>fitted.reports.some(r=>r.continuousCheck==='decoded'&&r.request===changed[1]&&r.displayed===true&&!r.stale),'edited fitted page decoded '+JSON.stringify(changed));
      const edited=await fitted.action('snapshot');
      assert.ok(Math.abs(edited.shells.find((s:any)=>s.page===0).width-learnedWidth)<1,'narrower edit retains the learned physical text scale');stablePoint(edited,'edit');
      if(png){
        await settle();fitted.invalidate();const noop=await currentRequest('metadata-only fitted page requested');
        fitted.respond(noop,900,[255,255,255],{textBounds:[80,50,360,290],noop:true});
        await fitted.until(()=>fitted.reports.some(r=>r.continuousCheck==='decoded'&&r.request===noop[1]&&r.displayed===true&&!r.stale),'metadata-only PNG decoded '+JSON.stringify(noop));
        const metadata=await fitted.action('snapshot');
        assert.ok(Math.abs(metadata.shells.find((s:any)=>s.page===0).width-learnedWidth)<1,'zero-byte PNG retains fit geometry');stablePoint(metadata,'metadata-only PNG');
      }
      await fitted.action('zoom',{value:'width'});const refitted=await fitted.action('zoom',{value:'text'});
      const refittedPage=refitted.shells.find((s:any)=>s.page===0),retainedWidth=refittedPage.width;
      assert.ok(retainedWidth>learnedWidth*1.2,'explicit text-fit re-entry refits the latest narrower text');
      assert.ok(refittedPage.ink.left>=-1&&refittedPage.ink.right<=refitted.width+1,'explicit refit keeps the edited text in view: '+JSON.stringify({viewport:refitted.width,page:refittedPage}));
      assert.ok(Math.abs((refittedPage.ink.left+refittedPage.ink.right)/2-refitted.width/2)<2,'explicit refit centers the edited text');
      fitted.state(10000,true,0);await fitted.action('jump',{page:4000});await fitted.drain();const far=await fitted.action('snapshot');
      assert.ok(!far.shells.some((s:any)=>s.page===0),'distant navigation unmounts the original fitted surface');
      const returned=await fitted.action('jump',{page:0});
      assert.ok(Math.abs(returned.shells.find((s:any)=>s.page===0).width-retainedWidth)<1,'evicted surface keeps learned text geometry before a replacement image');
      await fitted.drain();const commandStart=fitted.commands.length;fitted.invalidate();fitted.state(1,false,0);await fitted.drain();
      const local=fitted.commands.slice(commandStart).filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0]));
      assert.ok(local.length<12&&local.every(c=>(c[2] as number)<=3),'fit geometry after an edit demands only nearby pages, not the document catalogue');
      console.log('PASS: '+(png?'PNG':'SVG')+' Fit to text width centers real content, retains full paper and stable geometry through edits, resizing and eviction');
    }finally{fitted.controller.dispose();}
  }
  for(const [png,kind] of [[false,'legacy'],[true,'blank']] as const){
    const fallback=await make(false,png,false,kind);
    try{
      await fallback.drain();const text=await fallback.action('zoom',{value:'text'}),width=await fallback.action('zoom',{value:'width'});
      assert.equal(text.zoom,'text','missing text metadata keeps the requested toolbar mode');
      const textPage=text.shells.find((s:any)=>s.page===0),widthPage=width.shells.find((s:any)=>s.page===0);
      assert.ok(Math.abs(textPage.width-widthPage.width)<1,'fresh '+kind+' page falls back to ordinary Fit width');
      assert.ok(textPage.left>=-1&&textPage.right<=text.width+1,'fallback leaves the complete paper visible');
      if(kind==='blank'){assert.equal(textPage.ink,null,'blank PNG stays blank');}
      console.log('PASS: Fit to text width has a sane '+kind+' metadata fallback');
    }finally{fallback.controller.dispose();}
  }

  const unknown=await make(true);
  try {
    await unknown.drain();await new Promise(resolve=>setTimeout(resolve,500));await unknown.drain();
    const rendered=unknown.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0]));
    assert.ok(rendered.length>0&&Math.max(...rendered.map(c=>c[2] as number))<=2,'stationary unknown frontier advances at most two pages during initial fill');
    const settled=rendered.length;await new Promise(resolve=>setTimeout(resolve,350));await unknown.drain();
    assert.equal(unknown.commands.filter(c=>/^preview-(?:render|svg|auto|png|background)$/.test(c[0])).length,settled,'response arrival does not create another scroll epoch');
    console.log('PASS: unknown frontier settles without runaway compilation or export');
  } finally {unknown.controller.dispose();}
  const progress=await make(false,true,false);
  try {
    await progress.drain();await progress.action('remember-link',{page:0});
    const take=async(page:number)=>{const owns=(command:Command)=>command[2]===page&&command[1]===(progress.controller as any).inFlight?.id;await progress.until(()=>progress.pending.some(owns),'foreground request '+page);return progress.pending.splice(progress.pending.findIndex(owns),1)[0];};
    const delayed=async(page:number,color:[number,number,number],height=300)=>{
      await progress.action('arm-decode',{color});const before=progress.reports.length;progress.invalidate();
      const command=await take(page);progress.respond(command,height,color);
      await progress.until(()=>progress.reports.slice(before).some(r=>r.continuousCheck==='decode-held'),'PNG decoder is held');return command;
    };
    const old=await delayed(0,[240,230,220],600);
    progress.invalidate();const before=await progress.action('snapshot');
    await progress.action('release-decode');
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===old[1]),'older decoded frame acknowledged');
    const stale=progress.reports.find(r=>r.continuousCheck==='decoded'&&r.request===old[1]);
    assert.equal(stale.displayed,true,'ordinary source invalidation permits monotonic older visual progress');
    assert.equal(stale.stale,true,'displayed older content is explicitly stale');
    const stalePage=stale.shells.find((s:any)=>s.page===0);
    assert.deepEqual(stalePage.pixel,[240,230,220,255],'the delayed PNG actually replaces visible pixels');
    assert.equal(stalePage.highlightHidden,true,'older source content cannot apply a source highlight');
    assert.equal(stale.scrollTop,before.scrollTop,'older source content cannot move the viewport');
    const learnedPage=before.shells.find((s:any)=>s.page===0);
    assert.ok(Math.abs(stalePage.height-learnedPage.height)<1,'older pixels cannot replace the learned current paper height');
    const relaid=await progress.action('zoom',{value:'0.5'}),relaidPage=relaid.shells.find((s:any)=>s.page===0);
    assert.ok(Math.abs(relaidPage.height/relaidPage.width-learnedPage.height/learnedPage.width)<.001,'later zoom cannot relearn obsolete paper bounds from a displayed stale frame');
    await progress.action('zoom',{value:'1'});
    const commands=progress.commands.length,opened=progress.opened.length;
    await progress.action('click-remembered');await progress.action('inverse',{page:0});await progress.action('lens',{page:0});
    const inert=await progress.action('snapshot');
    assert.equal(progress.opened.length,opened,'stale links remain disabled');assert.equal(inert.lensHidden,true,'stale content cannot activate the magnifier');
    assert.ok(!progress.commands.slice(commands).some(c=>c[0]==='preview-inverse'||c[0]==='preview-region'||c[0]==='preview-destination'),'stale content cannot issue inverse/link/detail requests');
    const current=await take(0);progress.respond(current,300,[220,240,230]);
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===current[1]&&r.displayed===true&&!r.stale),'current source restores interaction');
    await progress.action('link',{page:0});assert.equal(progress.opened.length,opened+1,'current frame restores hyperlink interaction');
    // The ownership probe changed scale and may have centered page one. Give
    // the existing navigation-retirement checks their original page-zero setup.
    await progress.action('jump',{page:0});await new Promise(resolve=>setTimeout(resolve,140));await progress.drain();
    const navOld=await delayed(0,[210,220,240]);await progress.action('jump',{page:1});await progress.action('release-decode');
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===navOld[1]),'navigated decode retired');
    assert.equal(progress.reports.find(r=>r.continuousCheck==='decoded'&&r.request===navOld[1]).displayed,false,'manual navigation retires the pending decoder');
    await progress.drain();
    const zoomOld=await delayed(1,[200,220,240]);await progress.action('zoom',{value:'0.5'});await progress.action('release-decode');
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===zoomOld[1]),'zoomed decode retired');
    assert.equal(progress.reports.find(r=>r.continuousCheck==='decoded'&&r.request===zoomOld[1]).displayed,false,'zoom retires the pending decoder');
    await progress.drain();
    const hiddenOld=await delayed(1,[190,210,230]);
    await (progress.controller as any).post({type:'invalidate',retire:true});await progress.action('release-decode');
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===hiddenOld[1]),'hidden decode retired');
    assert.equal(progress.reports.find(r=>r.continuousCheck==='decoded'&&r.request===hiddenOld[1]).displayed,false,'panel-hide retirement rejects an already awaiting decoder');
    await progress.drain();
    await progress.action('arm-decode',{color:[180,210,240]});progress.invalidate();progress.forward(1,60,60);
    const targetOld=await take(1),heldAt=progress.reports.length;progress.respond(targetOld,300,[180,210,240]);
    await progress.until(()=>progress.reports.slice(heldAt).some(r=>r.continuousCheck==='decode-held'),'target frame decode held');
    progress.forward(1,450,240);const newerTarget=await progress.action('snapshot');await progress.action('release-decode');
    await progress.until(()=>progress.reports.some(r=>r.continuousCheck==='decoded'&&r.request===targetOld[1]),'newer source target preserved');
    const targetPaint=progress.reports.find(r=>r.continuousCheck==='decoded'&&r.request===targetOld[1]);
    const mark=targetPaint.shells.find((s:any)=>s.page===1);
    assert.ok(mark.highlightHidden||(mark.highlightLeft==='75%'&&mark.highlightTop==='80%'),'an older delayed frame cannot replace the newer same-page target');
    assert.equal(targetPaint.scrollTop,newerTarget.scrollTop,'delayed old target cannot scroll away from the newer source intent');
    console.log('PASS: source invalidation permits monotonic stale PNG pixels with inert interactions; current frames restore links, navigation/zoom retire pending decoders');
  }finally{progress.controller.dispose();}
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
