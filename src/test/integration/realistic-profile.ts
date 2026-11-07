/* Opt-in real-document renderer comparison. Uses the production session,
 * controller, webview assets and VS Code IPC, with copied private documents. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { PreviewController } from '../../preview-controller';
const { Run } = require('../../../scripts/profile-preview.cjs');

export async function run(): Promise<void> {
  const repo = path.resolve(__dirname, '../../..');
  const output = path.resolve(process.env.TEXPRESSO_PROFILE_OUTPUT || 'artifacts/realistic-codecs');
  fs.mkdirSync(output, {recursive:true});
  const cases = JSON.parse(fs.readFileSync(process.env.TEXPRESSO_REAL_CASES || path.join(output, 'cases.json'), 'utf8'));
  const widths = (process.env.TEXPRESSO_REAL_WIDTHS || '640,1100').split(',').map(Number);
  const repeats = Number(process.env.TEXPRESSO_REAL_REPEATS || 4), dpr = Number(process.env.TEXPRESSO_REAL_DPR || 2);
  const codecs = (process.env.TEXPRESSO_PROFILE_CODECS || 'png,auto').split(',');
  if (!widths.every(w => w >= 400 && w <= 1400) || ![1,2].includes(dpr) || repeats < 1 || repeats > 10 || !codecs.every(c => ['png','svg','auto','edit-png-auto'].includes(c))) {throw Error('Invalid benchmark dimensions');}
  const binary = process.env.TEXPRESSO_BINARY!;
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const runtime = [...fs.readdirSync(path.join(repo,'out')).filter(f=>f.endsWith('.js')).map(f=>'out/'+f),
    ...fs.readdirSync(path.join(repo,'media')).filter(f=>/\.(js|css)$/.test(f)).map(f=>'media/'+f),
    'out/test/integration/realistic-profile.js','scripts/profiling/realistic-client.js','scripts/profiling/json-number-bridge.cjs','scripts/profile-preview.cjs'];
  const metadata = {schema:1, created:new Date().toISOString(), vscode:vscode.version, platform:process.platform, architecture:process.arch,
    cpu:os.cpus()[0].model, cpus:os.cpus().length, memory:os.totalmem(), binarySha256:hash(binary),
    workerSha256:hash(path.join(path.dirname(binary),'texpresso-xetex')), runtimeHashes:Object.fromEntries(runtime.map(f => [f,hash(path.join(repo,f))])),
    engineManifest:JSON.parse(fs.readFileSync(path.resolve(path.dirname(binary),'../build-manifest.json'),'utf8')),
    power:cp.spawnSync('pmset',['-g','batt'],{encoding:'utf8'}).stdout, powerSettings:cp.spawnSync('pmset',['-g','custom'],{encoding:'utf8'}).stdout, widths, dpr, repeats, codecs,
    profileFeatures:process.env.TEXPRESSO_PROFILE_FEATURES==='1',
    cases:cases.map((c: any) => ({id:c.id,focusPage:c.focusPage,sourceSha256:c.sourceSha256,originalSha256:c.originalSha256,compatibility:c.compatibility,normalizePreviewNumbers:c.normalizePreviewNumbers})),
    limitations:['Two requestAnimationFrame callbacks are a paint opportunity, not display scanout.','Native task footprint excludes Chromium/GPU memory.','In-memory source edits use production DocumentSync; physical key dispatch is not measured.','Capture pixels are composed from actual mounted webview surfaces, not an OS screenshot.']};
  const metadataPath=path.join(output,`metadata-dpr${dpr}.json`);
  if(fs.existsSync(metadataPath)) {
    const old=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
    if(JSON.stringify(old.runtimeHashes)!==JSON.stringify(metadata.runtimeHashes)||old.binarySha256!==metadata.binarySha256) {throw Error('Do not mix runtime revisions in one measurement directory');}
  }
  fs.writeFileSync(metadataPath,JSON.stringify(metadata,null,2));
  if (process.platform === 'darwin') {cp.execFileSync('xcrun',['clang','-O2',path.join(repo,'scripts/profiling/memory.c'),'-o',path.join(output,'memory-sampler')]);}
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const resultPath = path.join(output,'sessions.jsonl');
  const completed = new Set(fs.existsSync(resultPath) ? fs.readFileSync(resultPath,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).key) : []);
  const client = fs.readFileSync(path.join(repo,'scripts/profiling/realistic-client.js'),'utf8');
  const main = fs.readFileSync(path.join(repo,'media/preview.js'),'utf8').replaceAll('acquireVsCodeApi','measurementAcquireVsCodeApi');
  for (let repeat=0; repeat<repeats; repeat++) {for (const fixture of cases) {for (const width of widths) {
    const order = repeat % 2 ? [...codecs].reverse() : codecs;
    for (const codec of order) {
      const key = `${fixture.id}-${width}-dpr${dpr}-${codec}-${repeat}`;
      if (completed.has(key)) {continue;}
      console.log('REALISTIC start ' + key);
      fixture.text = fs.readFileSync(fixture.file,'utf8');
      const active = new Run(fixture,binary,codec,width*dpr,output,repeat);
      let controller: PreviewController | undefined, real: vscode.WebviewPanel | undefined, inserted = 0;
      let resolve!: (value: any) => void, reject!: (error: Error) => void;
      const result = new Promise<any>((ok,fail) => { resolve=ok; reject=fail; });
      const requests: any[] = [], headers: any[] = [], costObservations: any[] = [];
      const requestStates = new Map<number, any>(), previousFeatures = new Map<number, any>();
      let editingUntil=0;
      const timer = setTimeout(() => reject(Error('Session deadline: ' + key + '\n' + active.trace.slice(-1500))),180000);
      const send = active.session.send.bind(active.session);
      active.session.send = (command: any) => {
        if (command[0]==='change'||command[0]==='change-range') { editingUntil=performance.now()+250; }
        // Experimental policy only: preserve production Auto's eligibility,
        // idle upgrades and safety budgets, but use its raster path during edits.
        if(codec==='edit-png-auto' && command[0]==='preview-auto' && performance.now()<editingUntil) {
          const allocation=(controller as any)?.fallbackContext(command[2],command[3])?.allocation;
          const [w,h,quota]=typeof allocation==='string'?allocation.split(':').map(Number):[];
          // Keep vector editing when a capped PNG would be below display
          // density and the SVG still fits the production surface budget.
          if(w>0&&h>0&&quota>0&&(w*h<=4000000||w*h*4>quota)) { command=[...command];command[6]=0; }
        }
        if (command[0].startsWith('preview-')) {
          requests.push({at:performance.now(),command});
          if(['preview-png','preview-render','preview-svg','preview-auto','preview-background','preview-region'].includes(command[0])) {
            const c=controller as any,page=command[2];
            requestStates.set(command[1],{pngBaseAvailable:c?.rasterBase?.page===page,svgBaseAvailable:c?.svgBase?.page===page,
              allocation:c?.fallbackContext(page,command[3])?.allocation,previousFeatures:previousFeatures.get(page)});
          }
        }
        send(command);
      };
      active.onPreview = (event: any) => {
        if (event.header) {
          headers.push({...event.header,at:performance.now()});
          if(event.header.renderFeatures) { previousFeatures.set(event.header.page,event.header.renderFeatures); }
        }
        controller?.handle(event);
      };
      active.onState = () => controller?.update();
      const createPanel = (...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
        args[2] = {viewColumn:vscode.ViewColumn.One,preserveFocus:false};
        const panel = vscode.window.createWebviewPanel(...args); real=panel;
        return {get visible(){return panel.visible;}, onDidChangeViewState:panel.onDidChangeViewState.bind(panel),
          onDidDispose:panel.onDidDispose.bind(panel), dispose:panel.dispose.bind(panel), webview:{
            cspSource:panel.webview.cspSource, asWebviewUri:panel.webview.asWebviewUri.bind(panel.webview),
            postMessage:(message: any) => panel.webview.postMessage(message),
            onDidReceiveMessage:(callback: (message: any) => void) => panel.webview.onDidReceiveMessage(async m => {
              try {
                if (m.type === 'measurement-result') { resolve(m.result); return; }
                if (m.type === 'measurement-error') { reject(Error(m.error)); return; }
                if (m.type === 'measurement-probe') {
                  const c=controller as any;
                  await panel.webview.postMessage({type:'measurement-probe-ack',id:m.id,busy:!!c &&
                    (!!c.inFlight&&!c.inFlight.background||!!c.upgradeTimer||c.upgradeReady||c.dirty||!!c.region||!!c.detail)}); return;
                }
                if (m.type === 'measurement-capture') {
                  const name = `${key}-${m.name}.png`;
                  fs.writeFileSync(path.join(output,name),Buffer.from(m.png,'base64')); return;
                }
                if (m.type === 'measurement-edit') {
                  const offset = fixture.editOffset+inserted;
                  active.replace(m.undo ? offset-1 : offset,m.undo ? 1 : 0,m.undo ? '' : m.text);
                  inserted += m.undo ? -1 : m.text.length;
                  await panel.webview.postMessage({type:'measurement-edit-ack',id:m.id,sequence:active.session.previewSequence}); return;
                }
                active.startPromise ||= active.session.start();
                await active.startPromise;
                callback(m);
              } catch (error) { reject(error as Error); }
            }),
            set html(value: string) {
              const instance = value.match(/data-instance="([^"]+)"/)![1];
                const job = {key,fixture:fixture.id,focusPage:fixture.focusPage,codec,width,height:760,dpr,repeat,
                capture:process.env.TEXPRESSO_REAL_CAPTURE === '1' && repeat === 1};
              value = value.replace(/style-src ([^;]+);/,`style-src $1 'nonce-${instance}';`)
                .replace('</head>',`<style nonce="${instance}">html,body{width:${width}px;height:760px;overflow:hidden}</style></head>`)
                .replace(/<script nonce=/,() => `<script nonce="${instance}">${client.replace('__JOB__',JSON.stringify(job))}</script><script nonce=`)
                .replace(new RegExp(`<script nonce="${instance}" src="[^"]*/preview\\.js"></script>`),() => `<script nonce="${instance}">${main}</script>`);
              panel.webview.html=value;
            }
          }};
      };
      const api = {Uri:vscode.Uri,ViewColumn:vscode.ViewColumn,env:vscode.env,window:{createWebviewPanel:createPanel}} as unknown as typeof vscode;
      try {
        controller = new PreviewController(api,vscode.Uri.file(repo),active.session,()=>{},()=>{},undefined,undefined,(codec==='edit-png-auto'?'auto':codec) as 'png'|'svg'|'auto');
        if(process.env.TEXPRESSO_PROFILE_FEATURES==='1') {
          const c=controller as any,record=c.renderCosts.record.bind(c.renderCosts);
          c.renderCosts.record=(context:string,actualCodec:string,patch:boolean,work:any)=>{
            const h=c.shown,request=c.inFlight;
            if(h?.renderFeatures && request) {
              const allocation=c.fallbackContext(h.page,request.width,h).allocation;
              costObservations.push({id:h.requestId,page:h.page,sequence:h.sequence,codec:actualCodec,patch,
                ...work,features:h.renderFeatures,featureMs:h.featureMs,featureCached:h.featureCached,
                requestWidth:request.width,allocation,bytes:h.byteLength,bounds:h.bounds,
                ...requestStates.get(h.requestId),context});
            }
            record(context,actualCodec,patch,work);
          };
        }
        if(codec==='edit-png-auto') {
          const c=controller as any,canUpgrade=c.canUpgrade.bind(c);
          c.canUpgrade=()=>{
            const allocation=c.fallbackContext(c.page,c.width,c.shown)?.allocation;
            const [w,h,quota]=typeof allocation==='string'?allocation.split(':').map(Number):[];
            if(w>0&&h>0&&quota>0&&(w*h<=4000000||w*h*4>quota)) { return false; }
            return canUpgrade();
          };
        }
        const row = await result;
        if(process.env.TEXPRESSO_PROFILE_FEATURES==='1' && !headers.some(h=>h.renderFeatures)) { throw Error('Missing native feature instrumentation'); }
        fs.appendFileSync(resultPath,JSON.stringify({...row,key,warmup:repeat===0,requests,headers,costObservations,nativeMemory:active.memory,viewerPid:active.pid,
          numberBridge:active.numberBridge ? {headers:active.numberBridge.headers,changed:active.numberBridge.changed,headerMs:active.numberBridge.headerMs,maxHeaderMs:active.numberBridge.maxHeaderMs} : undefined,
          binarySha256:metadata.binarySha256,runtimeHashes:metadata.runtimeHashes,load:os.loadavg()})+'\n');
        console.log(`REALISTIC done ${key}: ${row.operations.length} operations; errors=${row.errors.length}`);
      } finally {
        clearTimeout(timer); controller?.dispose(); real?.dispose();
        fs.writeFileSync(path.join(output,key+'-trace.log'),active.trace);
        await active.dispose();
      }
    }
  }}}
}
