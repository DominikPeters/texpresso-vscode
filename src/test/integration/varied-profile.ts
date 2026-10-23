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
const { createVariedFixture, sourceLocation, resolveInput, scenarioPlans } = require('../../../scripts/profiling/varied-fixture.cjs');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  const repo = path.resolve(__dirname, '../../..');
  const output = path.resolve(process.env.TEXPRESSO_PROFILE_OUTPUT || 'artifacts/profile-varied-vscode');
  if (fs.existsSync(output) && fs.readdirSync(output).length) { throw Error('Choose a fresh varied-profile output directory'); }
  fs.mkdirSync(output, { recursive: true });
  const scenario = process.env.TEXPRESSO_PROFILE_SCENARIO || 'default';
  const samplerPath = path.join(output, 'memory-sampler');
  if (process.platform === 'darwin') { cp.execFileSync('xcrun', ['clang', '-O2', path.join(repo, 'scripts/profiling/memory.c'), '-o', samplerPath]); }
  const binary = process.env.TEXPRESSO_BINARY!, legacyFollow = process.env.TEXPRESSO_PROFILE_LEGACY_FOLLOW === '1';
  const metadata = { created: new Date().toISOString(), hostTimeOrigin: performance.timeOrigin, vscode: vscode.version, binary, legacyFollow, scenario,
    profileEnabled: process.env.TEXPRESSO_PROFILE === '1', profileActivity: process.env.TEXPRESSO_PROFILE_ACTIVITY === '1',
    controllerVariant: process.env.TEXPRESSO_PROFILE_CONTROLLER_VARIANT || 'working-tree',
    controllerRuntimeSha256: createHash('sha256').update(fs.readFileSync(require.resolve('../../preview-controller'))).digest('hex'),
    memoryAccounting: 'Owned native process-group task RSS/footprint sums; not deduplicated RAM/PSS. Node heap includes retained profiling logs. Browser counters describe mounted resources, not GPU memory.',
    engine: cp.execFileSync('git', ['-C', 'native/texpresso', 'rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    engineDirty: !!cp.execFileSync('git', ['-C', 'native/texpresso', 'status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    engineDiffSha256: createHash('sha256').update(cp.execFileSync('git', ['-C', 'native/texpresso', 'diff', 'HEAD', '--no-ext-diff'], { cwd: repo, maxBuffer: 8 * 1024 * 1024 })).digest('hex'),
    bundleManifest: fs.existsSync(path.resolve(path.dirname(binary), '../build-manifest.json')) ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(binary), '../build-manifest.json'), 'utf8')) : undefined,
    binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    extension: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    extensionDirty: !!cp.execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(['src/extension.ts', 'src/source-follow.ts', 'src/session.ts', 'src/engine-process.ts', 'src/preview-controller.ts', 'src/render-fallback.ts', 'src/recovery.ts', 'media/preview.js', 'media/preview-png.js', 'media/preview-svg.js', 'media/preview-cache.js'].map(file =>
      [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')])),
    endpoint: 'Accepted production webview frame followed by two animation frames; not compositor presentation',
    input: 'Real VS Code TextDocument editor.edit operations at a scheduled 100 ms cadence; no keyboard or compositor latency' };
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const bootstrap = fs.readFileSync(path.join(repo, 'src/test/fixtures/varied-webview.js'), 'utf8');
  const source = fs.readFileSync(path.join(repo, 'media/preview.js'), 'utf8').replaceAll('acquireVsCodeApi', 'variedApi')
    .replace("case 'image': {", "case 'image': { window.variedReceiving(m.header, performance.now());")
    .replace('acknowledge(header.requestId, performance.now() - renderStart);',
      'window.variedAccepted(header, imageId, {stale, latestSequence: latestSourceSequence, latestRevision: latestSourceRevision, renderMs: performance.now() - renderStart}); acknowledge(header.requestId, performance.now() - renderStart);');
  if (!source.includes('window.variedAccepted(header, imageId,') || !source.includes('window.variedReceiving(m.header,')) { throw Error('Production image acceptance hook changed; update the observer before profiling'); }
  for (const pages of (process.env.TEXPRESSO_PROFILE_PAGES || (scenario === 'default' ? '30,100' : '30')).split(',').map(Number)) {
    for (const codec of (process.env.TEXPRESSO_PROFILE_CODECS || (scenario === 'long' ? 'auto' : scenario === 'compare' ? 'png,svg,auto' : 'svg,auto')).split(',')) {
      const fixture = createVariedFixture(output, { targetPages: pages, id: `varied-${pages}-${codec}`, included: scenario === 'long' });
      const document = await vscode.workspace.openTextDocument(fixture.file);
      for (const [key, value] of Object.entries({ autoClosingBrackets: 'never', autoClosingQuotes: 'never', autoIndent: 'none', formatOnType: false, acceptSuggestionOnEnter: 'off' })) {
        await vscode.workspace.getConfiguration('editor', document.uri).update(key, value, vscode.ConfigurationTarget.Workspace);
      }
      const documents: vscode.TextDocument[] = [document];
      for (const file of fixture.files || []) { documents.push(await vscode.workspace.openTextDocument(file.file)); }
      let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      let controller: PreviewController | undefined, panel: vscode.WebviewPanel | undefined, failure: Error | undefined;
      let expectedPage: number | undefined, expectedRevision: number | undefined, runError: Error | undefined;
      let sequence = 0, actionId = 0, phase = 'initial', debug = '', raw = '', disposed = false;
      let generation = 0, ownedChild: cp.ChildProcess | undefined, sampler: cp.ChildProcess | undefined;
      let dropNextAck = false, webviewLoads = 0, allowFollow = true;
      const memory: any[] = [], checkpoints: any[] = [], recoveries: any[] = [], fallbackDecisions: any[] = [], sourceReplays: any[] = [], convergenceChecks: any[] = [];
      let sourceReplayOverflow = 0;
      const stopSampler = async () => {
        const old = sampler; sampler = undefined; if (!old || old.exitCode !== null || old.signalCode !== null) { return; }
        const closed = new Promise<void>(resolve => old.once('close', () => resolve())); old.kill('SIGTERM'); await closed;
      };
      const native: any[] = [], messages: any[] = [], browser: any[] = [], inputs: any[] = [], phases: any[] = [], probes: any[] = [], warnings: string[] = [];
      const timeline: any[] = []; let timelineOverflow = 0;
      const stage = (name: string, details: object = {}) => {
        if (timeline.length < 200000) { timeline.push({ stage: name, at: performance.now(), phase, generation, ...details }); }
        else { timelineOverflow++; }
      };
      let hostTick = performance.now();
      const hostScheduler = setInterval(() => {
        const now = performance.now(), lag = Math.max(0, now - hostTick - 100); hostTick = now;
        if (lag > 10) { stage('host-lag', { lag }); }
      }, 100);
      const follow = new SourceFollow();
      const newSession = (recovering = false): TexpressoSession => {
        const ownGeneration = generation;
        const current = new TexpressoSession(document, { ...config, command: binary, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: true, watchDependencies: false, streamFiles: scenario === 'long' },
        new SessionPaths(document.fileName, false), () => documents, {
          state: () => controller?.update(), output: () => {}, synctex: () => {}, warning: text => warnings.push(text),
          error: error => { failure = error; },
          debug: text => {
            debug = (debug + text).slice(-200000); raw += text;
            const lines = raw.split('\n'); raw = lines.pop()!;
            for (const line of lines) { const at = line.indexOf('[profile] '); if (at >= 0) {
              try { native.push({ at: performance.now(), phase, generation: ownGeneration, ...JSON.parse(line.slice(at + 10)) }); } catch { /* Child stderr may interleave. */ }
            } }
          },
          rendered: () => syncForward(),
          preview: event => {
            if ('sourceSequence' in event) { sequence = event.sourceSequence; expectedPage = undefined; expectedRevision = undefined; }
            messages.push({ at: performance.now(), phase, generation: ownGeneration, received: 'header' in event ? event.header : event });
            if (Array.isArray(event) && event[0] === 'preview-forward' && event[2] === current.previewSequence) { expectedPage = event[3]; expectedRevision = event[1]; }
            controller?.handle(event);
          }
        }, undefined, (command, args, options) => {
          ownedChild = cp.spawn(command, args, options);
          const child = ownedChild;
          if (process.platform === 'darwin') { child.once('spawn', () => {
            let pending = '';
            sampler = cp.spawn(samplerPath, [String(child.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
            sampler.stdout?.on('data', data => { pending += data.toString(); const lines = pending.split('\n'); pending = lines.pop()!;
              for (const line of lines) { try { memory.push({ ...JSON.parse(line), hostAt: performance.now(), generation: ownGeneration, phase }); } catch { /* Ignore a truncated final sample. */ } }
            });
          }); }
          return child;
        }, { recovering });
        const send = current.send.bind(current);
        current.send = command => {
          if (command[0] === 'open' || command[0] === 'open-base64') {
            if (sourceReplays.length < 256) {
              const bytes = Buffer.from(command[2], command[0] === 'open' ? 'utf8' : 'base64');
              const logical = path.isAbsolute(command[1]) ? command[1] : path.resolve(fixture.root, command[1]);
              const owner = documents.find(doc => path.resolve(doc.fileName) === logical);
              sourceReplays.push({ at: performance.now(), phase, generation: ownGeneration, command: command[0], path: command[1],
                bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
                editor: owner ? { file: path.basename(owner.fileName), version: owner.version, dirty: owner.isDirty,
                  bytes: Buffer.byteLength(owner.getText()), sha256: createHash('sha256').update(owner.getText()).digest('hex') } : undefined });
            } else { sourceReplayOverflow++; }
          }
          messages.push({ at: performance.now(), phase, generation: ownGeneration, sent: command[0].startsWith('preview-') || command[0] === 'synctex-forward' ? command : [command[0]] }); send(command);
        };
        return current;
      };
      let session = newSession();
      function syncForward(explicit = false) {
        if (disposed || (!explicit && !allowFollow) || session.state !== 'running' || vscode.window.activeTextEditor?.document !== editor.document) { return; }
        const state = session.previewState;
        if (!legacyFollow && !follow.request({ session, document: editor.document.uri.toString(), version: editor.document.version,
          line: editor.selection.active.line, column: editor.selection.active.character, sequence: session.previewSequence, revision: state?.[2] === session.previewSequence ? state[1] : 0 }, explicit)) { return; }
        controller?.beginSourceFollow(); session.sync.syncForward(editor.document, editor.selection.active.line);
      }
      const subscriptions = [
        vscode.workspace.onDidChangeTextDocument(event => {
          if (documents.includes(event.document)) { session.sync.change(event.document, event.contentChanges); sequence = session.previewSequence; expectedPage = undefined; }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
          if (event.textEditor === editor) { syncForward(); controller?.prepareEdit(editor.document, editor.document.offsetAt(editor.selection.start)); }
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
            if (m.varied) { browser.push({ ...m, hostAt: performance.now(), phase, latestSequence: sequence, latestRevision: session.previewState?.[1], generation }); } else if (m.type === 'decoded' && dropNextAck) {
              dropNextAck = false; recoveries.push({ type: 'dropped-ack', at: performance.now(), generation, requestId: m.id, page: m.page });
            } else {
              if (m.type === 'decoded') {
                stage('decoded', { id: m.id, page: m.page, latestSequence: sequence, latestRevision: session.previewState?.[1], displayed: m.displayed,
                  stale: m.stale, renderMs: m.renderMs, profileTiming: m.profileTiming });
              }
              if (['rasterize', 'cache-miss', 'decode-error', 'evicted', 'ready'].includes(m.type)) { messages.push({ at: performance.now(), phase, generation, browserSent: m }); }
              callback(m);
            }
          }),
          postMessage: (m: any) => {
            if (m.header) { stage('post', { id: m.header.requestId, kind: m.type, page: m.header.page,
              sequence: m.header.sequence, revision: m.header.revision, latestSequence: sequence,
              mime: m.header.mime, width: m.header.width, height: m.header.height, bounds: m.header.bounds,
              bytes: m.bytes?.byteLength || 0, nativeBytes: m.header.byteLength, svgOperations: m.svgPatch?.operations?.length,
              rasterPatch: m.rasterPatch?.rect, background: m.background, visualOnly: m.visualOnly }); }
            const posted = real.webview.postMessage({ ...m, variedSourceSequence: session.previewSequence,
              ...(m.header ? { header: { ...m.header, profileGeneration: generation } } : {}) });
            if (m.header) { void posted.then(delivered => stage('post-result', { id: m.header.requestId, delivered })); }
            return posted;
          },
          set html(value: string) {
            webviewLoads++; recoveries.push({ type: 'webview-load', at: performance.now(), generation, load: webviewLoads });
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
        await until(() => browser.some(b => b.varied === 'paint' && b.hostAt >= after && b.header.sequence >= sequence && b.header.profileGeneration === generation && !b.superseded &&
          (requireTarget ? b.header.page === expectedPage && b.header.revision === expectedRevision && b.header.revision === session.previewState?.[1] : b.header.page === b.toolbar) &&
          b.shells.some((s: any) => s.page === b.header.page && s.visible)), label, 30000);
      };
      const selectDocument = async (relative = 'varied.tex') => {
        const selected = documents.find(doc => path.basename(doc.fileName) === relative);
        if (!selected) { throw Error('Missing source document ' + relative); }
        editor = await vscode.window.showTextDocument(selected, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); return selected;
      };
      const checkpoint = async (name: string) => {
        const selected = await selectDocument(); const location = sourceLocation(selected.getText(), 'early');
        const position = selected.positionAt(location.offset); editor.selection = new vscode.Selection(position, position);
        await action('zoom', { value: 'width' }); const mark = messages.length; syncForward(true);
        await until(() => messages.slice(mark).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'checkpoint target ' + name, 30000);
        await settled(0, 'checkpoint current image ' + name, true); await delay(500);
        const snapshot = await action('snapshot'), at = performance.now();
        if (snapshot.shells.length > 12 || snapshot.resources.residentBytes > 32 * 1024 * 1024) { throw Error('Settled preview exceeded its shell/cache budget'); }
        const sample = memory.filter(m => m.generation === generation && m.hostAt >= at - 1000).at(-1);
        checkpoints.push({ name, at, generation, sequence, expectedPage, snapshot, native: sample, node: process.memoryUsage(),
          sources: documents.map(doc => ({ file: path.basename(doc.fileName), dirty: doc.isDirty, bytes: Buffer.byteLength(doc.getText()), sha256: createHash('sha256').update(doc.getText()).digest('hex') })) });
      };
      try {
        const started = performance.now(); await session.start();
        const api = { Uri: vscode.Uri, ViewColumn: vscode.ViewColumn, env: vscode.env, window: { createWebviewPanel: createPanel } } as unknown as typeof vscode;
        controller = new PreviewController(api, vscode.Uri.file(repo), session, () => {}, () => {}, () => follow.suspend(session));
        // Observe rejected-context invalidation without changing production policy.
        const fallback = (controller as any).fallback;
        const usePng = fallback.usePng.bind(fallback);
        fallback.usePng = (page: number, context: any) => {
          const previous = fallback.entries.get(page), result = usePng(page, context);
          if (previous && !result && fallbackDecisions.length < 30) {
            fallbackDecisions.push({ at: performance.now(), phase, page, previous: JSON.parse(JSON.stringify(previous)), context, result });
          }
          return result;
        };
        await settled(started, 'initial frame');
        console.log(`VARIED ${fixture.id}: first frame ${(performance.now() - started).toFixed(1)}ms`);
        if (scenario !== 'default') { await checkpoint('initial-settled'); }
        const plans = scenarioPlans(scenario).map((p: any) => process.env.TEXPRESSO_PROFILE_INPUT_LIMIT ? { ...p, inputs: p.inputs.slice(0,Number(process.env.TEXPRESSO_PROFILE_INPUT_LIMIT)) } : p).filter((p: any) => !process.env.TEXPRESSO_PROFILE_PHASES || process.env.TEXPRESSO_PROFILE_PHASES.split(',').includes(p.id));
        for (const plan of plans) {
          const activeDocument = await selectDocument(plan.document);
          allowFollow = plan.sourceFollow !== false;
          phase = plan.id; const phaseStart = performance.now(), baseText = activeDocument.getText();
          const location = sourceLocation(baseText, plan.anchor);
          editor.selection = new vscode.Selection(activeDocument.positionAt(location.offset), activeDocument.positionAt(location.offset));
          editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
          syncForward(true); controller.prepareEdit(activeDocument, location.offset);
          if (plan.zoom) { await action('zoom', { value: plan.zoom }); }
          await delay(scenario === 'default' ? 700 : 400);
          let budgetStart: any;
          if (plan.budgetBoundary) {
            await action('boundary'); await delay(200); budgetStart = await action('snapshot');
            if (budgetStart.shells.filter((sheet: any) => sheet.visible).length < 2) { throw Error('Budget comparison requires two visible page surfaces'); }
          }
          const start = performance.now(), firstInput = inputs.length; let returnPage: number | undefined, manualViewport = !allowFollow;
          for (let i = 0; i < plan.inputs.length; i++) {
            const input = plan.inputs[i], scheduled = start + i * plan.intervalMs;
            await delay(Math.max(0, scheduled - performance.now()));
            const before = activeDocument.getText(), edit = resolveInput(before, input), at = performance.now();
            if (input.undo) {
              await vscode.commands.executeCommand('undo');
            } else if (input.redo) {
              await vscode.commands.executeCommand('redo');
            } else {
              await editor.edit(builder => builder.replace(new vscode.Range(activeDocument.positionAt(edit.offset), activeDocument.positionAt(edit.offset + edit.length)), edit.text), { undoStopBefore: !['paste-incomplete-repair', 'long-incomplete-repair'].includes(plan.id) || i === 0, undoStopAfter: !['paste-incomplete-repair', 'long-incomplete-repair'].includes(plan.id) || i === plan.inputs.length - 1 });
              const pos = activeDocument.positionAt(edit.offset + edit.text.length); editor.selection = new vscode.Selection(pos, pos);
            }
            const expected = before.slice(0, edit.offset) + edit.text + before.slice(edit.offset + edit.length);
            if (activeDocument.getText() !== expected) { throw Error('Editor altered scripted input ' + plan.id + '/' + i + '; active=' + vscode.window.activeTextEditor?.document.uri.toString() + '; version=' + activeDocument.version + '; length=' + activeDocument.getText().length + '/' + expected.length); }
            inputs.push({ phase, index: i, scheduled, applied: at, completed: performance.now(), lateness: at - scheduled,
              sequence, generation, document: path.basename(activeDocument.fileName), sourceValid: input.sourceValid, manualViewport, version: activeDocument.version, line: editor.selection.active.line, length: edit.text.length, deleteLength: edit.length });
            for (const navigation of plan.navigation.filter((n: any) => n.afterInput === i + 1)) {
              if (navigation.action === 'scroll') { manualViewport = true; await action('scroll', { delta: navigation.delta || 350 }); continue; }
              const beforeNavigation = await action('snapshot');
              if (navigation.action === 'away') { returnPage = beforeNavigation.toolbar; manualViewport = true; } else { manualViewport = false; }
              const available = session.previewState?.[3] || 3;
              await action('page', { page: navigation.action === 'away' ? (beforeNavigation.toolbar === 0 ? Math.max(1, available - 1) : 0) : returnPage ?? 0 });
            }
          }
          allowFollow = true;
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
          phases.push({ name: phase, anchor: plan.anchor, document: path.basename(activeDocument.fileName), generation, sourceFollow: plan.sourceFollow !== false, budgetStart, count: part.length, start, end: performance.now(), maxInputLateness: Math.max(...part.map(i => i.lateness)),
            firstPaintMs: first ? first.hostAt - start : null, finalPaintMs: final ? final.hostAt - lastInput : null,
            sourceSequence: sequence, expectedPage, expectedRevision, observedInputSpan: part.at(-1).applied - part[0].applied, scheduledInputSpan: (part.length - 1) * plan.intervalMs,
            visibleThroughout: paints.every(b => b.visibility === 'visible'), snapshot, elapsed: performance.now() - phaseStart });
          console.log(`VARIED ${fixture.id} ${plan.id}: ${part.length} inputs, final ${phases.at(-1).finalPaintMs?.toFixed(1)}ms, page ${snapshot.toolbar + 1}`);
          if (scenario !== 'default') { await checkpoint(plan.id); }
        }
        if (scenario === 'long') {
          phase = 'webview-recovery'; const loads = webviewLoads, mark = performance.now(); dropNextAck = true;
          await action('zoom', { value: '1.25' });
          await until(() => recoveries.some(r => r.type === 'dropped-ack' && r.at >= mark), 'controlled lost image acknowledgment');
          await until(() => webviewLoads > loads, 'production webview acknowledgment-timeout recovery', 16000);
          const reloadAt = recoveries.filter(r => r.type === 'webview-load').at(-1)!.at;
          await until(() => browser.some(b => b.varied === 'paint' && b.hostAt >= reloadAt && !b.superseded && b.header.profileGeneration === generation), 'paint after webview recovery', 30000);
          recoveries.push({ type: 'webview-recovered', at: performance.now(), elapsedMs: performance.now() - mark, generation });
          await checkpoint('after-webview-recovery');
          phase = 'engine-recovery'; const failureStart = performance.now(), previous = session, child = ownedChild;
          if (!child?.pid) { throw Error('No owned native process to terminate'); }
          const overlays = documents.map(doc => ({ doc, text: doc.getText(), dirty: doc.isDirty })); child.kill('SIGKILL');
          await delay(50); await until(() => previous.state === 'failed', 'injected engine failure');
          const injectedFailure = failure?.message; failure = undefined; await previous.dispose(); await stopSampler();
          generation++; sequence = 0; expectedPage = undefined; expectedRevision = undefined;
          session = newSession(true); controller.replaceSession(session); await session.start();
          await until(() => session.state === 'running', 'replacement session running');
          for (const overlay of overlays) { if (overlay.doc.getText() !== overlay.text || overlay.doc.isDirty !== overlay.dirty) { throw Error('Recovery lost an unsaved source overlay'); } }
          await checkpoint('after-explicit-engine-replacement');
          recoveries.push({ type: 'engine-replaced-explicitly', generation, elapsedMs: performance.now() - failureStart, failure: injectedFailure,
            automaticPolicy: false, overlayCount: overlays.length });
          // A final actual edit proves source synchronization remains live after rebind.
          const childDocument = await selectDocument('chapter.tex'), before = childDocument.getText();
          const edit = resolveInput(before, { anchor: 'included', text: '\nThe recovered include accepts another live edit.\n' });
          await editor.edit(builder => builder.insert(childDocument.positionAt(edit.offset), edit.text));
          if (childDocument.getText() !== before.slice(0, edit.offset) + edit.text + before.slice(edit.offset)) { throw Error('Replacement source edit mismatch'); }
          const position = childDocument.positionAt(edit.offset + edit.text.length); editor.selection = new vscode.Selection(position, position);
          const targetMark = messages.length; syncForward(true);
          await until(() => messages.slice(targetMark).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'replacement source target');
          await settled(0, 'replacement source edit visible', true); await checkpoint('final-settled');
        }
        const queryProbes = async (round: string) => {
        for (const phrase of ['every new term has a source location', 'Every new term has a source location', 'sum the bounds', 'The final argument must also update', 'included recovery remains current', 'The recovered include accepts another live edit']) {
          const owner = documents.find(doc => doc.getText().includes(phrase)); if (!owner) { continue; }
          await selectDocument(path.basename(owner.fileName));
          const text = owner.getText(), offset = text.indexOf(phrase), position = owner.positionAt(offset + phrase.length);
          editor.selection = new vscode.Selection(position, position);
          const mark = messages.length; syncForward(true);
          await until(() => messages.slice(mark).some(m => m.received?.[0] === 'preview-forward' && m.received[2] === sequence), 'independent oracle probe ' + phrase, 30000);
          await settled(0, 'oracle probe image ' + phrase, true);
          probes.push({ round, phrase, document: path.basename(owner.fileName), line1: position.line + 1, column: position.character, nativePage: expectedPage, revision: expectedRevision, sequence, generation, snapshot: await action('snapshot') });
        }
        };
        await queryProbes('initial');
        if (scenario === 'long') {
          phase = 'oracle-convergence'; const waitStart = performance.now(), deadline = waitStart + 12000;
          let observedRevision = session.previewState?.[1], stableSince = performance.now(), verified = false;
          while (performance.now() < deadline) {
            if (failure) { throw failure; }
            const state = session.previewState;
            if (state?.[1] !== observedRevision) { observedRevision = state?.[1]; stableSince = performance.now(); }
            if (!state?.[4] || state[2] !== sequence) { stableSince = performance.now(); }
            if (state?.[4] && state[2] === sequence && performance.now() - stableSince >= 1200) { verified = true; break; }
            await delay(25);
          }
          convergenceChecks.push({ round: 'settled', verified, waitedMs: performance.now() - waitStart,
            criterion: 'Current source complete and native revision unchanged for 1200 ms, bounded 12 s; not an aux-protocol guarantee',
            generation, sequence, state: session.previewState ? [...session.previewState] : undefined });
          await queryProbes('settled');
        }
        phase = 'idle'; const beforeIdle = messages.length; await delay(2000); await action('snapshot');
        phases.push({ name: 'idle', commands: messages.slice(beforeIdle).filter(m => m.sent), snapshot: browser.at(-1) });
      } catch (error) { runError = error instanceof Error ? error : Error(String(error)); throw error; } finally {
        clearInterval(hostScheduler);
        await stopSampler();
        const editedFiles = documents.map(doc => { const relative = path.basename(doc.fileName), saved = relative === 'varied.tex' ? 'edited.tex' : 'edited-' + relative;
          fs.writeFileSync(path.join(fixture.root, saved), doc.getText()); return { relative, saved, dirty: doc.isDirty, sha256: createHash('sha256').update(doc.getText()).digest('hex') }; });
        const result = { metadata, timeline, timelineOverflow, convergenceChecks, sourceReplays, sourceReplayOverflow, fallbackDecisions, finalSource: { sequence, generation }, editedFiles, checkpoints, recoveries, memory, fixture: { ...fixture, text: undefined }, phases, probes, inputs, browser, messages, native, warnings, error: (runError || failure)?.message, nodeMemory: process.memoryUsage() };
        fs.writeFileSync(path.join(output, fixture.id + '.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(output, fixture.id + '-native.log'), debug);
        fs.writeFileSync(path.join(fixture.root, 'edited.tex'), document.getText());
        disposed = true; for (const subscription of subscriptions) { subscription.dispose(); }
        controller?.dispose(); await session.dispose();
      }
    }
  }
}
