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
  const resume = process.env.TEXPRESSO_PROFILE_RESUME === '1';
  if (fs.existsSync(output) && fs.readdirSync(output).length && !resume) { throw Error('Choose a new profiler output directory'); }
  const resultFile = path.join(output, 'browser.jsonl');
  const completed = new Set<string>(resume && fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').trim().split('\n').filter(Boolean).map(line => { const r=JSON.parse(line); return `${r.fixture}/${r.codec}/${r.repeat}`; }) : []);
  fs.mkdirSync(output, { recursive: true });
  if (process.platform === 'darwin') { cp.execFileSync('xcrun', ['clang', '-O2', path.join(repo, 'scripts/profiling/memory.c'), '-o', path.join(output, 'memory-sampler')]); }
  const cases = fixtures(output, (process.env.TEXPRESSO_PROFILE_PAGES || '1,100').split(',').map(Number),
    (process.env.TEXPRESSO_PROFILE_KINDS || 'dense,tikz').split(','));
  const binary = process.env.TEXPRESSO_BINARY!;
  const repeats = Number(process.env.TEXPRESSO_PROFILE_REPEATS || 3);
  const bridgeSource = fs.readFileSync(path.join(repo, 'scripts/profiling/auto-client.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(repo, 'media/preview.js'), 'utf8').replaceAll('acquireVsCodeApi', 'profileAcquireVsCodeApi');
  const metadata = { created: new Date().toISOString(), vscode: vscode.version, binary, pages: cases.map((f: any) => f.id), repeats,
    extension: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), transport: 'actual VS Code webview postMessage' };
  if (!resume) { fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2)); }
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const fixture of cases) {
      const order = [['png', 'svg', 'auto'], ['svg', 'auto', 'png'], ['auto', 'png', 'svg']][repeat % 3];
      for (const codec of order.filter(c => (process.env.TEXPRESSO_PROFILE_CODECS || 'png,svg,auto').split(',').includes(c))) {
        if (completed.has(`${fixture.id}/${codec}/${repeat}`)) { continue; }
        console.log(`PROFILE starting ${fixture.id} ${codec} #${repeat + 1}`);
        fs.writeFileSync(fixture.file, fixture.text);
        const active = new Run(fixture, binary, codec, 1600, output, repeat);
        let controller: PreviewController | undefined, realPanel: vscode.WebviewPanel | undefined;
        let resolve!: (result: any) => void, reject!: (error: Error) => void;
        const result = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
        const uiTrace: string[] = [];
        const timer = setTimeout(() => reject(Error('VS Code Auto benchmark timeout: ' + JSON.stringify(uiTrace) + '\n' + active.trace.slice(-4000))), 120000);
        active.onPreview = (event: any) => controller?.handle(event);
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
                if (m.type === 'profile-error') { reject(Error(m.error)); return; }
                if (m.type === 'profile-edit') {
                  if (m.mode === 'letter' || m.mode === 'backspace') {
                    const marker = active.text.match(/(Profiling marker 0000 )([a-z]{4,16})(\.)/);
                    if (!marker) { reject(Error('Missing typing marker')); return; }
                    const offset = marker.index + marker[1].length + marker[2].length;
                    active.replace(m.mode === 'letter' ? offset : offset - 1, m.mode === 'letter' ? 0 : 1, m.mode === 'letter' ? m.letter : '');
                  } else if (m.mode === 'font') { active.replace(active.text.indexOf('\\noindent'), 0, '\\textbf{New font} '); }
                  else { active.edit(0, !!m.coordinate); }
                  return;
                }
                active.startPromise ||= active.session.start();
                try { await active.startPromise; callback(m); } catch (error) { reject(error as Error); }
              }),
              postMessage: (message: any) => panel.webview.postMessage({ ...message,
                profileProcessingMs: message.type === 'image' ? performance.now() - active.controllerImageStart : undefined }),
              set html(value: string) {
                const instance = value.match(/data-instance="([^"]+)"/)![1];
                const bootstrap = bridgeSource.replace('__JOB__', JSON.stringify({ fixture: fixture.id, codec, repeat, pages: fixture.pages, vscode: true }));
                value = value.replace('</head>', '<style>html,body{width:800px;height:700px;overflow:hidden}</style></head>');
                value = value.replace(/<script nonce=/, `<script nonce="${instance}">${bootstrap}</script><script nonce=`);
                value = value.replace(new RegExp(`<script nonce="${instance}" src="[^"]*/preview\\.js"></script>`), `<script nonce="${instance}">${mainSource}</script>`);
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
          const saved = { ...row, transport: metadata.transport, nativeProfile: active.profile, memory: active.memory, viewerPid: active.pid };
          fs.appendFileSync(path.join(output, 'browser.jsonl'), JSON.stringify(saved) + '\n');
          console.log(`PROFILE ${fixture.id} ${codec} #${repeat + 1}: initial ${row.rows[0].ms.toFixed(1)} ms, settled ${row.rows[0].settledMs.toFixed(1)} ms`);
        } finally {
          clearTimeout(timer); controller?.dispose(); realPanel?.dispose(); await active.dispose();
        }
      }
    }
  }
}
