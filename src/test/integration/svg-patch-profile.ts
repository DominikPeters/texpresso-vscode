/* Replay identical private native SVG frames through the real VS Code webview.
 * Source capture and validation are outside the timed DOM updates. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export async function run(): Promise<void> {
  const repo=path.resolve(__dirname,'../../..'),capture=process.env.TEXPRESSO_SVG_PATCH_CAPTURE!;
  const output=path.resolve(process.env.TEXPRESSO_PROFILE_OUTPUT!);fs.mkdirSync(output,{recursive:true});
  const fixtures=JSON.parse(fs.readFileSync(path.join(capture,'cases.json'),'utf8'));
  const baseline=path.resolve(process.env.TEXPRESSO_SVG_PATCH_BASELINE || path.join(repo,'artifacts/svg-patch-review/baseline'));
  const variants=[{name:'before',module:path.join(baseline,'svg-patch.cjs'),renderer:path.join(baseline,'preview-svg.js')},
    {name:'after',module:path.join(repo,'out/svg-patch.js'),renderer:path.join(repo,'media/preview-svg.js')}];
  const widths=(process.env.TEXPRESSO_REAL_WIDTHS||'640,1100').split(',').map(Number),repeats=Number(process.env.TEXPRESSO_PROFILE_REPEATS||4);
  await vscode.commands.executeCommand('workbench.action.closeSidebar');await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const client=fs.readFileSync(path.join(repo,'scripts/profiling/svg-patch-client.js'),'utf8');
  const manifest={created:new Date().toISOString(),vscode:vscode.version,variants:variants.map(v=>({name:v.name,moduleSha256:hash(v.module),rendererSha256:hash(v.renderer)})),widths,repeats,
    fixtures:fixtures.map((f:any)=>({id:f.id,sourceSha256:f.sourceSha256,frames:fs.readdirSync(path.join(capture,f.id)).filter(n=>n.endsWith('.svg')).sort().map(n=>({name:n,sha256:hash(path.join(capture,f.id,n))}))}))};
  fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify(manifest,null,2));
  for(let repeat=0;repeat<repeats;repeat++) {for(const fixture of fixtures) {for(const width of widths) {
    const files=fs.readdirSync(path.join(capture,fixture.id)).filter(n=>n.endsWith('.svg')).sort();
    const frames=files.map(n=>fs.readFileSync(path.join(capture,fixture.id,n),'utf8'));
    for(const variant of repeat%2?[...variants].reverse():variants) {
      const engine=require(variant.module),renderer=fs.readFileSync(variant.renderer,'utf8');
      const panel=vscode.window.createWebviewPanel('texpresso.svg-patch-profile','SVG update replay',{viewColumn:vscode.ViewColumn.One,preserveFocus:false},{enableScripts:true});
      const nonce='svg-patch-profile';let previous:any;
      const metrics:any[]=[],prepared:string[]=[];
      let resolve!:(value:any)=>void,reject!:(error:Error)=>void;
      const done=new Promise<any>((ok,fail)=>{resolve=ok;reject=fail;});
      const timer=setTimeout(()=>reject(Error('SVG replay timeout')),120000);
      panel.webview.onDidReceiveMessage(async message=>{
        try {
          if(message.type==='ready') {await send(0);}
          else if(message.type==='rendered') {
            metrics[message.index]={...metrics[message.index],...message};
            if(message.index+1<frames.length) {await send(message.index+1);}
            else {await panel.webview.postMessage({type:'validate',frames:prepared});}
          } else if(message.type==='validated') {resolve(message);}
          else if(message.type==='error') {reject(Error(message.error));}
        }catch(error){reject(error as Error);}
      });
      async function send(index:number) {
        const start=performance.now(),doc=engine.canonicalSvg(frames[index]);if(!doc) {throw Error('SVG preparation budget');}
        const id='frame'+index;let diagnostic:any;
        const patch=previous?engine.diffSvg(previous,doc,'frame'+(index-1),{diagnostic:(d:any)=>diagnostic=d}):undefined;
        metrics[index]={index,hostMs:performance.now()-start,patch:!!patch,diagnostic};prepared.push(doc.text);previous=doc;
        const bytes=patch?undefined:new TextEncoder().encode(doc.text).buffer;
        await panel.webview.postMessage({type:'render',index,id,patch,bytes});
      }
      try {
        panel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">html,body{margin:0;width:${width}px;height:760px;overflow:hidden}#surface{width:${width-15}px}svg{width:100%;height:auto}</style></head><body><div id="surface"></div><script nonce="${nonce}">${renderer}</script><script nonce="${nonce}">const job=${JSON.stringify({width})};${client}</script></body></html>`;
        const result=await done;
        fs.appendFileSync(path.join(output,'runs.jsonl'),JSON.stringify({fixture:fixture.id,width,repeat,variant:variant.name,warmup:repeat===0,metrics,validation:result})+'\n');
        console.log(`SVG replay ${variant.name} ${fixture.id} ${width} repeat ${repeat}: ${metrics.filter(m=>m.patch).length}/${frames.length-1} edits patched; DOM validation passed`);
      }finally{clearTimeout(timer);panel.dispose();}
    }
  }}}
}
function hash(file:string):string{return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
