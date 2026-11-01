/* Opt-in performance experiment using real VS Code IPC and production renderers.
 * It runs only via scripts/test-integration.cjs --profile-auto. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { PreviewController } from '../../preview-controller';
const { Run, fixtures } = require('../../../scripts/profile-preview.cjs');

export async function run(): Promise<void> {
  const repo = path.resolve(__dirname, '../../..');
  const output = path.resolve(process.env.TEXPRESSO_PROFILE_OUTPUT || 'artifacts/profile-auto-vscode');
  const rapid = process.env.TEXPRESSO_PROFILE_SCENARIO === 'rapid-e2e';
  const prewarmScenario = process.env.TEXPRESSO_PROFILE_SCENARIO === 'prewarm-e2e';
  const richDemo = prewarmScenario || process.env.TEXPRESSO_PROFILE_RICH === '1';
  const earlyInput = process.env.TEXPRESSO_PROFILE_RAPID_EARLY === '1';
  const extras = process.env.TEXPRESSO_PROFILE_EXTRAS === '1';
  const resume = process.env.TEXPRESSO_PROFILE_RESUME === '1';
  if (fs.existsSync(output) && fs.readdirSync(output).length && !resume) { throw Error('Choose a new profiler output directory'); }
  const resultFile = path.join(output, 'browser.jsonl');
  const completed = new Set<string>(resume && fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').trim().split('\n').filter(Boolean).map(line => { const r=JSON.parse(line); return `${r.variant || 'default'}/${r.fixture}/${r.codec}/${r.repeat}`; }) : []);
  fs.mkdirSync(output, { recursive: true });
  if (process.platform === 'darwin') { cp.execFileSync('xcrun', ['clang', '-O2', path.join(repo, 'scripts/profiling/memory.c'), '-o', path.join(output, 'memory-sampler')]); }
  const cases = prewarmScenario ? (process.env.TEXPRESSO_PROFILE_PREWARM_MODES || 'cold,warm,early').split(',').map(value=>({
    ...require('../../../scripts/profiling/rich-demo-native.cjs').richFixture(output,'rich-prewarm-'+value), autoRerun:true,prewarmMode:value
  })) : richDemo ? (process.env.TEXPRESSO_PROFILE_AUTORERUN || 'false,true').split(',').map(value=>({
    ...require('../../../scripts/profiling/rich-demo-native.cjs').richFixture(output,'rich-rerun-'+value), autoRerun:value==='true'
  })) : fixtures(output, (process.env.TEXPRESSO_PROFILE_PAGES || '1,100').split(',').map(Number),
    (process.env.TEXPRESSO_PROFILE_KINDS || 'dense,tikz').split(','));
  const hash = (file: string) => fs.existsSync(file) ? require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  const commandOutput = (command: string, args: string[]) => {
    const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
    return { status: result.status, stdout: result.stdout?.trim() || '', stderr: result.stderr?.trim() || '', error: result.error?.message };
  };
  const variantInputs: { name: string; binary: string; codecs?: string[] }[] = process.env.TEXPRESSO_PROFILE_VARIANTS
    ? JSON.parse(process.env.TEXPRESSO_PROFILE_VARIANTS)
    : [{ name: 'default', binary: process.env.TEXPRESSO_BINARY!, codecs: (process.env.TEXPRESSO_PROFILE_CODECS || 'png,svg,auto').split(',') }];
  if (!Array.isArray(variantInputs) || !variantInputs.length || new Set(variantInputs.map(v => v.name)).size !== variantInputs.length) {
    throw Error('Profiler variants must be a nonempty array with unique names');
  }
  const variants = variantInputs.map(variant => {
    const codecs = variant.codecs || (process.env.TEXPRESSO_PROFILE_CODECS || 'png,svg,auto').split(',');
    if (!/^[a-zA-Z0-9_-]+$/.test(variant.name) || typeof variant.binary !== 'string' || !path.isAbsolute(variant.binary) ||
        !fs.existsSync(variant.binary) || !Array.isArray(codecs) || !codecs.length || codecs.some(codec => !['png', 'svg', 'auto'].includes(codec))) {
      throw Error('Invalid profiler variant: ' + JSON.stringify(variant));
    }
    const binary = variant.binary, capabilityProbe = commandOutput(binary, ['-capabilities']);
    let capabilities: unknown;
    try { capabilities = JSON.parse(capabilityProbe.stdout); } catch { capabilities = null; }
    const manifestFile = path.resolve(path.dirname(binary), '../build-manifest.json');
    return { name: variant.name, binary, codecs, capabilities, capabilityProbe,
      binarySha256: hash(binary), workerSha256: hash(path.join(path.dirname(binary), 'texpresso-xetex')),
      buildManifest: fs.existsSync(manifestFile) ? { path: manifestFile, sha256: hash(manifestFile), value: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } : null };
  });
  const { binary, binarySha256, workerSha256, capabilities, capabilityProbe, buildManifest } = variants[0];
  const runtimeFiles = ['package-lock.json', 'dist/extension.js', 'out/session.js', 'out/preview-controller.js', 'out/preview-svg.js',
    'scripts/profile-preview.cjs', 'scripts/profiling/auto-client.js', 'src/test/integration/auto-profile.ts',
    'media/preview.js', 'media/preview.css', 'media/preview-cache.js', 'media/preview-svg.js', 'media/preview-png.js', 'media/preview-lens.js', 'media/preview-viewport.js'];
  const sourceState = (folder: string) => ({
    revision: commandOutput('git', ['-C', folder, 'rev-parse', 'HEAD']).stdout,
    status: commandOutput('git', ['-C', folder, 'status', '--porcelain']).stdout,
    diffSha256: require('node:crypto').createHash('sha256').update(commandOutput('git', ['-C', folder, 'diff', 'HEAD', '--', '.']).stdout).digest('hex')
  });
  const power = process.platform === 'darwin' ? { battery: commandOutput('pmset', ['-g', 'batt']), settings: commandOutput('pmset', ['-g', 'custom']) } : null;
  const repeats = Number(process.env.TEXPRESSO_PROFILE_REPEATS || 3);
  if(richDemo) { await require('./continuous-preview').checkContinuousPreview(vscode.Uri.file(repo)); }
  const bridgeSource = fs.readFileSync(path.join(repo, 'scripts/profiling/auto-client.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(repo, 'media/preview.js'), 'utf8').replaceAll('acquireVsCodeApi', 'profileAcquireVsCodeApi');
  const metadata = { richDemo, prewarmScenario, earlyInput, extras, backgroundThrottlingDisabled: true, cadenceLatenessBudgetMs: 20, scenario: prewarmScenario ? 'prewarm-e2e' : rapid ? 'rapid-e2e' : 'auto-e2e', created: new Date().toISOString(), vscode: vscode.version, binary, pages: cases.map((f: any) => f.id), repeats,
    engine: cp.execFileSync('git', ['-C', 'native/texpresso', 'rev-parse', 'HEAD'], {cwd:repo,encoding:'utf8'}).trim(),
    binarySha256, workerSha256, capabilities, capabilityProbe, buildManifest, variants, power,
    sources: { extension: sourceState(repo), engine: sourceState(path.join(repo, 'native/texpresso')) },
    runtimeHashes: Object.fromEntries(runtimeFiles.map(file => [file, hash(path.join(repo, file))])),
    fixtures: cases.map((fixture: any) => ({ id: fixture.id, nominalPages: fixture.pages, sourceSha256: require('node:crypto').createHash('sha256').update(fixture.text).digest('hex') })),
    memoryAccounting: 'Native process-group per-task footprints include shared/copy-on-write pages; browser DOM/canvas/cache counters exclude unmounted decoded resources and GPU memory.',
    resolutionPolicy: 'Production viewport at 800x700 CSS pixels; actual DPR, requested widths, returned raster dimensions and mounted CSS surfaces recorded per frame. Native pixel cap unchanged.',
    extension: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), transport: 'actual VS Code webview postMessage' };
  if (!resume) { fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2)); }
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const fixture of cases) {
      const variantOrder = [...variants.slice(repeat % variants.length), ...variants.slice(0, repeat % variants.length)];
      for (const variant of variantOrder) {
      const { binary, capabilities } = variant;
      const order = [['png', 'svg', 'auto'], ['svg', 'auto', 'png'], ['auto', 'png', 'svg']][repeat % 3];
      for (const codec of order.filter(c => variant.codecs.includes(c))) {
        if (completed.has(`${variant.name}/${fixture.id}/${codec}/${repeat}`)) { continue; }
        console.log(`PROFILE starting ${variant.name} ${fixture.id} ${codec} #${repeat + 1}`);
        fs.writeFileSync(fixture.file, fixture.text);
        const active = new Run(fixture, binary, codec, 1600, output, repeat);
        if(richDemo) { active.session.autoRerun=fixture.autoRerun; active.session.configuration.autoRerun=fixture.autoRerun; }
        if(prewarmScenario) { Object.defineProperty(active.session.document,'version',{get:()=>active.session.previewSequence}); }
        const sentence='Edit this sentence and watch the preview change.';
        if(richDemo && !active.text.includes(sentence)) {throw Error('The rich demo edit sentence changed; update its benchmark anchor.');}
        const richAnchor=richDemo ? active.text.indexOf(sentence)+sentence.length : 0;
        let richInserted=0;
        let controller: PreviewController | undefined, realPanel: vscode.WebviewPanel | undefined;
        let resolve!: (result: any) => void, reject!: (error: Error) => void;
        const result = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
        const uiTrace: string[] = [];
        const timer = setTimeout(() => reject(Error('VS Code Auto benchmark timeout: ' + JSON.stringify(uiTrace) + '\n' + active.trace.slice(-4000))), 120000);
        const requestTrace: any[] = [];
        active.onPreview = (event: any) => {
          const at=performance.now(); requestTrace.push({at, received:event.header || event});
          if(Array.isArray(event)&&event[0]==='preview-prepared') {
            void realPanel?.webview.postMessage({type:'profile-prewarm-ack',phase:'complete',request:event[1],revision:event[2],sequence:event[3],result:event[4],hostReceivedAt:at});
          }
          controller?.handle(event);
        };
        const send = active.session.send.bind(active.session);
        active.session.send = (command: any) => {
          const at=performance.now();
          if(command[0].startsWith('preview-')) { requestTrace.push({at, sent:command}); }
          if(command[0]==='preview-prepare') {
            void realPanel?.webview.postMessage({type:'profile-prewarm-ack',phase:'sent',inputId:'warmup',request:command[1],hostSentAt:at});
          }
          send(command);
        };
        active.onState = () => controller?.update();
        const createPanel = (...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
          const panel = vscode.window.createWebviewPanel(...args); realPanel = panel;
          const wrapper = {
            get visible() { return panel.visible; },
            onDidChangeViewState: panel.onDidChangeViewState.bind(panel), onDidDispose: panel.onDidDispose.bind(panel), dispose: panel.dispose.bind(panel),
            webview: {
              cspSource: panel.webview.cspSource, asWebviewUri: panel.webview.asWebviewUri.bind(panel.webview),
              onDidReceiveMessage: (callback: (message: any) => void) => panel.webview.onDidReceiveMessage(async m => {
                uiTrace.push(m.type + ':' + (m.id ?? '')); if (uiTrace.length > 30) { uiTrace.shift(); }
                if (m.type === 'profile-result') { resolve(m.result); return; }
                if (m.type === 'profile-error') {
                  if (m.partial) { fs.writeFileSync(path.join(output, `${variant.name}-${fixture.id}-${codec}-${repeat}-partial.json`), JSON.stringify(m.partial,null,2)); }
                  reject(Error(m.error)); return;
                }
                if (m.type === 'profile-prewarm') {
                  controller!.prepareEdit(active.session.document,richAnchor);
                  return;
                }
                if (m.type === 'profile-edit') {
                  if (m.mode === 'demo') {active.replace(richAnchor+richInserted,0,m.text);richInserted+=m.text.length;}
                  else if (m.mode === 'letter' || m.mode === 'backspace') {
                    const marker = active.text.match(/(Profiling marker 0000 )([a-z]{4,16})(\.)/);
                    if (!marker) { reject(Error('Missing typing marker')); return; }
                    const offset = marker.index + marker[1].length + marker[2].length;
                    active.replace(m.mode === 'letter' ? offset : offset - 1, m.mode === 'letter' ? 0 : 1, m.mode === 'letter' ? m.letter : '');
                  } else if (m.mode === 'font') { active.replace(active.text.indexOf('\\noindent'), 0, '\\textbf{New font} '); }
                  else { active.edit(0, !!m.coordinate); }
                  if (prewarmScenario) { controller!.prepareEdit(active.session.document,richAnchor+richInserted); }
                  if (m.inputId !== undefined) { await panel.webview.postMessage({type:'profile-edit-ack', inputId:m.inputId, sequence:active.session.previewSequence,hostAppliedAt:performance.now()}); }
                  return;
                }
                active.startPromise ||= active.session.start();
                try { await active.startPromise; callback(m); } catch (error) { reject(error as Error); }
              }),
              postMessage: (message: any) => panel.webview.postMessage({ ...message,
                profileUpgrade: (controller as any)?.inFlight?.upgrade === true,
                profileProcessingMs: message.type === 'image' ? performance.now() - active.controllerImageStart : undefined }),
              set html(value: string) {
                const instance = value.match(/data-instance="([^"]+)"/)![1];
                const bootstrap = bridgeSource.replace('__JOB__', JSON.stringify({ fixture: fixture.id, codec, repeat, variant: variant.name, pages: fixture.pages, vscode: true, rapid, earlyInput, richDemo, extras, prewarmScenario, prewarmMode:fixture.prewarmMode, autoRerun:fixture.autoRerun }));
                value = value.replace(/style-src ([^;]+);/, `style-src $1 'nonce-${instance}';`);
                value = value.replace('</head>', `<style nonce="${instance}">html,body{width:800px;height:700px;overflow:hidden}</style></head>`);
                value = value.replace(/<script nonce=/, `<script nonce="${instance}">${bootstrap}</script><script nonce=`);
                value = value.replace(new RegExp(`<script nonce="${instance}" src="[^"]*/preview\\.js"></script>`), () => `<script nonce="${instance}">${mainSource}</script>`);
                panel.webview.html = value;
              }
            }
          };
          return wrapper;
        };
        const api = { Uri: vscode.Uri, ViewColumn: vscode.ViewColumn, env: vscode.env, window: { createWebviewPanel: createPanel } } as unknown as typeof vscode;
        try {
          controller = new PreviewController(api, vscode.Uri.file(repo), active.session, () => {}, () => {});
          const internals = controller as any, image = internals.image;
          internals.image = (frame: any) => { active.controllerImageStart = performance.now(); return image.call(controller, frame); };
          const row = await result;
          const saved = { ...row, variant: variant.name, binarySha256: variant.binarySha256, transport: metadata.transport, backend: capabilities, power: process.platform === 'darwin' ? commandOutput('pmset', ['-g', 'batt']) : null, sourceSha256: require('node:crypto').createHash('sha256').update(active.text).digest('hex'), nativeProfile: active.profile, memory: active.memory, viewerPid: active.pid };
          fs.appendFileSync(path.join(output, 'browser.jsonl'), JSON.stringify(saved) + '\n');
          console.log(`PROFILE ${variant.name} ${fixture.id} ${codec} #${repeat + 1}: initial ${row.rows[0].ms.toFixed(1)} ms, settled ${row.rows[0].settledMs.toFixed(1)} ms`);
        } finally {
          fs.writeFileSync(path.join(output, `${variant.name}-${fixture.id}-${codec}-${repeat}-trace.log`), active.trace);
          fs.writeFileSync(path.join(output, `${variant.name}-${fixture.id}-${codec}-${repeat}-requests.json`), JSON.stringify(requestTrace,null,2));
          clearTimeout(timer); controller?.dispose(); realPanel?.dispose(); await active.dispose();
        }
      }
      }
    }
  }
}
