/* Opt-in sustained editing with a real VS Code TextDocument, source selection
 * events, production session/controller and actual webview renderers. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import { PreviewController } from '../../preview-controller';
import { SourceFollow } from '../../source-follow';
import { config } from '../helpers';
const { createVariedFixture, sourceLocation, resolveInput, sustainedPlans } = require('../../../scripts/profiling/varied-fixture.cjs');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  const repo = path.resolve(__dirname, '../../..');
  const output = path.resolve(process.env.TEXPRESSO_PROFILE_OUTPUT || 'artifacts/profile-varied-vscode');
  if (fs.existsSync(output) && fs.readdirSync(output).length) { throw Error('Choose a fresh varied-profile output directory'); }
  fs.mkdirSync(output, { recursive: true });
  const binary = process.env.TEXPRESSO_BINARY!, legacyFollow = process.env.TEXPRESSO_PROFILE_LEGACY_FOLLOW === '1';
  const metadata = { created: new Date().toISOString(), vscode: vscode.version, binary, legacyFollow,
    engine: cp.execFileSync('git', ['-C', 'native/texpresso', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    extension: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    extensionDirty: !!cp.execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(['src/extension.ts', 'src/source-follow.ts', 'src/preview-controller.ts', 'media/preview.js'].map(file =>
      [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')])),
    endpoint: 'Accepted production webview frame followed by two animation frames; not compositor presentation',
    input: 'Real VS Code TextDocument editor.edit operations at a scheduled 100 ms cadence; no keyboard or compositor latency' };
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const bootstrap = fs.readFileSync(path.join(repo, 'src/test/fixtures/varied-webview.js'), 'utf8');
  const source = fs.readFileSync(path.join(repo, 'media/preview.js'), 'utf8').replaceAll('acquireVsCodeApi', 'variedApi')
    .replace('acknowledge(header.requestId, performance.now() - renderStart);',
      'window.variedAccepted(header, imageId); acknowledge(header.requestId, performance.now() - renderStart);');
  for (const pages of (process.env.TEXPRESSO_PROFILE_PAGES || '30,100').split(',').map(Number)) {
    for (const codec of (process.env.TEXPRESSO_PROFILE_CODECS || 'svg,auto').split(',')) {
      const fixture = createVariedFixture(output, { targetPages: pages, id: `varied-${pages}-${codec}` });
      const document = await vscode.workspace.openTextDocument(fixture.file);
      for (const [key, value] of Object.entries({ autoClosingBrackets: 'never', autoClosingQuotes: 'never', autoIndent: 'none', formatOnType: false, acceptSuggestionOnEnter: 'off' })) {
        await vscode.workspace.getConfiguration('editor', document.uri).update(key, value, vscode.ConfigurationTarget.Workspace);
      }
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      let controller: PreviewController | undefined, panel: vscode.WebviewPanel | undefined, failure: Error | undefined;
      let expectedPage: number | undefined, expectedRevision: number | undefined, runError: Error | undefined;
      let sequence = 0, actionId = 0, phase = 'initial', debug = '', raw = '', disposed = false;
      const native: any[] = [], messages: any[] = [], browser: any[] = [], inputs: any[] = [], phases: any[] = [], probes: any[] = [], warnings: string[] = [];
      const follow = new SourceFollow();
      const session = new TexpressoSession(document, { ...config, command: binary, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: true, watchDependencies: false },
        new SessionPaths(document.fileName, false), () => [document], {
          state: () => controller?.update(), output: () => {}, synctex: () => {}, warning: text => warnings.push(text),
          error: error => { failure = error; },
          debug: text => {
            debug = (debug + text).slice(-200000); raw += text;
            const lines = raw.split('\n'); raw = lines.pop()!;
            for (const line of lines) { const at = line.indexOf('[profile] '); if (at >= 0) {
              try { native.push({ at: performance.now(), phase, ...JSON.parse(line.slice(at + 10)) }); } catch { /* Child stderr may interleave. */ }
            } }
          },
          rendered: () => syncForward(),
          preview: event => {
            messages.push({ at: performance.now(), phase, received: 'header' in event ? event.header : event });
            if (Array.isArray(event) && event[0] === 'preview-forward' && event[2] === session.previewSequence) { expectedPage = event[3]; expectedRevision = event[1]; }
            controller?.handle(event);
          }
        });
      const send = session.send.bind(session);
      session.send = command => { messages.push({ at: performance.now(), phase, sent: command[0].startsWith('preview-') || command[0] === 'synctex-forward' ? command : [command[0]] }); send(command); };
      function syncForward(explicit = false) {
        if (disposed || session.state !== 'running' || vscode.window.activeTextEditor?.document !== document) { return; }
        const state = session.previewState;
        if (!legacyFollow && !follow.request({ session, document: document.uri.toString(), version: document.version,
          line: editor.selection.active.line, column: editor.selection.active.character, sequence: session.previewSequence, revision: state?.[2] === session.previewSequence ? state[1] : 0 }, explicit)) { return; }
        controller?.beginSourceFollow(); session.sync.syncForward(document, editor.selection.active.line);
      }
      const subscriptions = [
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document === document) { session.sync.change(document, event.contentChanges); sequence = session.previewSequence; expectedPage = undefined; }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
          if (event.textEditor === editor) { syncForward(); controller?.prepareEdit(document, document.offsetAt(editor.selection.start)); }
        })
      ];
      const until = async (check: () => boolean, label: string, timeout = 20000) => {
        const deadline = performance.now() + timeout;
        while (!check()) { if (failure || performance.now() > deadline) { throw failure || Error('Varied stress timeout: ' + label + '\n' + debug.slice(-6000)); } await delay(10); }
      };
      const createPanel = (...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
        const real = vscode.window.createWebviewPanel(...args); panel = real;
        return { get visible() { return real.visible; }, onDidChangeViewState: real.onDidChangeViewState.bind(real), onDidDispose: real.onDidDispose.bind(real), dispose: () => real.dispose(), webview: {
          cspSource: real.webview.cspSource, asWebviewUri: real.webview.asWebviewUri.bind(real.webview),
          onDidReceiveMessage: (callback: (m: any) => void) => real.webview.onDidReceiveMessage(m => {
            if (m.varied) { browser.push({ ...m, hostAt: performance.now(), phase, latestSequence: sequence }); } else { callback(m); }
          }),
          postMessage: (m: any) => real.webview.postMessage({ ...m, variedSourceSequence: session.previewSequence }),
          set html(value: string) {
            const nonce = value.match(/data-instance="([^"]+)"/)![1];
            const boot = bootstrap.replace('__CODEC__', JSON.stringify(codec));
            value = value.replace(/style-src ([^;]+);/, `style-src $1 'nonce-${nonce}';`)
              .replace('</head>', `<style nonce="${nonce}">html,body{width:900px;height:800px;overflow:hidden}</style></head>`)
              .replace(/<script nonce=/, () => `<script nonce="${nonce}">${boot}</script><script nonce=`)
              .replace(/<script nonce="[^"]+" src="[^"]*\/preview\.js"><\/script>/, () => `<script nonce="${nonce}">${source}</script>`);
            real.webview.html = value;
          }
        } };
      };
      const action = async (name: string, extra: object = {}) => {
        const id = ++actionId; await panel!.webview.postMessage({ variedAction: { name, id, ...extra } });
        await until(() => browser.some(b => b.varied === 'action' && b.action === id), 'browser ' + name);
        return browser.find(b => b.varied === 'action' && b.action === id);
      };
      const settled = async (after: number, label: string, requireTarget = false) => {
        await until(() => browser.some(b => b.varied === 'paint' && b.hostAt >= after && b.header.sequence >= sequence && !b.superseded &&
          (requireTarget ? b.header.page === expectedPage && b.header.revision === expectedRevision && b.header.revision === session.previewState?.[1] : b.header.page === b.toolbar) &&
          b.shells.some((s: any) => s.page === b.header.page && s.visible)), label, 30000);
      };
      try {
        const started = performance.now(); await session.start();
        const api = { Uri: vscode.Uri, ViewColumn: vscode.ViewColumn, env: vscode.env, window: { createWebviewPanel: createPanel } } as unknown as typeof vscode;
        controller = new PreviewController(api, vscode.Uri.file(repo), session, () => {}, () => {}, () => follow.suspend(session));
        await settled(started, 'initial frame');
        console.log(`VARIED ${fixture.id}: first frame ${(performance.now() - started).toFixed(1)}ms`);
        const plans = sustainedPlans().map((p: any) => process.env.TEXPRESSO_PROFILE_INPUT_LIMIT ? { ...p, inputs: p.inputs.slice(0,Number(process.env.TEXPRESSO_PROFILE_INPUT_LIMIT)) } : p).filter((p: any) => !process.env.TEXPRESSO_PROFILE_PHASES || process.env.TEXPRESSO_PROFILE_PHASES.split(',').includes(p.id));
        for (const plan of plans) {
          await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
          await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
          phase = plan.id; const phaseStart = performance.now(), baseText = document.getText();
          const location = sourceLocation(baseText, plan.anchor);
          editor.selection = new vscode.Selection(document.positionAt(location.offset), document.positionAt(location.offset));
          editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
          syncForward(true); controller.prepareEdit(document, location.offset);
          await delay(700);
          const start = performance.now(), firstInput = inputs.length; let returnPage: number | undefined;
          for (let i = 0; i < plan.inputs.length; i++) {
            const input = plan.inputs[i], scheduled = start + i * plan.intervalMs;
            await delay(Math.max(0, scheduled - performance.now()));
            const before = document.getText(), edit = resolveInput(before, input), at = performance.now();
            if (input.undo) {
              await vscode.commands.executeCommand('undo');
            } else {
              await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.text), { undoStopBefore: plan.id !== 'paste-incomplete-repair' || i === 0, undoStopAfter: plan.id !== 'paste-incomplete-repair' || i === plan.inputs.length - 1 });
              const pos = document.positionAt(edit.offset + edit.text.length); editor.selection = new vscode.Selection(pos, pos);
            }
            const expected = before.slice(0, edit.offset) + edit.text + before.slice(edit.offset + edit.length);
            if (document.getText() !== expected) { throw Error('Editor altered scripted input ' + plan.id + '/' + i + '; active=' + vscode.window.activeTextEditor?.document.uri.toString() + '; version=' + document.version + '; length=' + document.getText().length + '/' + expected.length); }
            inputs.push({ phase, index: i, scheduled, applied: at, completed: performance.now(), lateness: at - scheduled,
              sequence, version: document.version, line: editor.selection.active.line, length: edit.text.length, deleteLength: edit.length });
            for (const navigation of plan.navigation.filter((n: any) => n.afterInput === i + 1)) {
              const beforeNavigation = await action('snapshot');
              if (navigation.action === 'away') { returnPage = beforeNavigation.toolbar; }
              const available = session.previewState?.[3] || 3;
              await action('page', { page: navigation.action === 'away' ? (beforeNavigation.toolbar === 0 ? Math.max(1, available - 1) : 0) : returnPage ?? 0 });
            }
          }
          const lastInput = inputs.at(-1)!.applied;
          const targetStart = messages.length; syncForward(true);
          await until(() => messages.slice(targetStart).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'final source target ' + plan.id, 30000);
          await settled(lastInput, 'valid final source for ' + plan.id, true);
          await delay(700);
          const stableTarget = messages.length; syncForward(true);
          await until(() => messages.slice(stableTarget).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'post-rerun target ' + plan.id, 30000);
          await settled(lastInput, 'post-rerun image ' + plan.id, true);
          const snapshot = await action('snapshot');
          const part = inputs.slice(firstInput);
          const paints = browser.filter(b => b.varied === 'paint' && b.hostAt >= start && b.header.sequence >= part[0].sequence && !b.superseded && b.shells.some((s: any) => s.page === b.header.page && s.visible));
          const first = paints[0], final = paints.find(b => b.header.sequence >= sequence && b.header.page === expectedPage && b.header.revision === expectedRevision);
          phases.push({ name: phase, anchor: plan.anchor, count: part.length, start, end: performance.now(), maxInputLateness: Math.max(...part.map(i => i.lateness)),
            firstPaintMs: first ? first.hostAt - start : null, finalPaintMs: final ? final.hostAt - lastInput : null,
            sourceSequence: sequence, expectedPage, observedInputSpan: part.at(-1).applied - part[0].applied, scheduledInputSpan: (part.length - 1) * plan.intervalMs,
            visibleThroughout: paints.every(b => b.visibility === 'visible'), snapshot, elapsed: performance.now() - phaseStart });
          console.log(`VARIED ${fixture.id} ${plan.id}: ${part.length} inputs, final ${phases.at(-1).finalPaintMs?.toFixed(1)}ms, page ${snapshot.toolbar + 1}`);
        }
        for (const phrase of ['every new term has a source location', 'sum the bounds', 'The final argument must also update']) {
          const text = document.getText(), offset = text.indexOf(phrase);
          if (offset < 0) { continue; }
          const position = document.positionAt(offset + phrase.length);
          editor.selection = new vscode.Selection(position, position);
          const mark = messages.length; syncForward(true);
          await until(() => messages.slice(mark).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'independent oracle probe ' + phrase, 30000);
          await settled(0, 'oracle probe image ' + phrase, true);
          probes.push({ phrase, line1: position.line + 1, column: position.character, nativePage: expectedPage, revision: expectedRevision, sequence, snapshot: await action('snapshot') });
        }
        phase = 'idle'; const beforeIdle = messages.length; await delay(2000); await action('snapshot');
        phases.push({ name: 'idle', commands: messages.slice(beforeIdle).filter(m => m.sent), snapshot: browser.at(-1) });
      } catch (error) { runError = error instanceof Error ? error : Error(String(error)); throw error; } finally {
        const result = { metadata, fixture: { ...fixture, text: undefined }, phases, probes, inputs, browser, messages, native, warnings, error: (runError || failure)?.message, nodeMemory: process.memoryUsage() };
        fs.writeFileSync(path.join(output, fixture.id + '.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(output, fixture.id + '-native.log'), debug);
        fs.writeFileSync(path.join(fixture.root, 'edited.tex'), document.getText());
        disposed = true; for (const subscription of subscriptions) { subscription.dispose(); }
        controller?.dispose(); await session.dispose();
      }
    }
  }
}
