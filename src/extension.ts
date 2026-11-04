import { refineSourceWord } from './source-word';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import { readConfiguration } from './configuration';
import { resolveEngine } from './engine-selection';
import { SessionPaths } from './paths';
import { TexpressoSession } from './session';
import { ExternalCompiler } from './external-compile';
import { PreviewControls } from './controls';
import { PreviewController } from './preview-controller';
import { SourceFollow } from './source-follow';
import { RecoveryBudget, isRecoverableEngineFailure } from './recovery';
import { describeFailure } from './failures';
import { setupReport } from './setup';
import { renamedPath } from './renames';
import { mainDocuments } from './root-selection';
import type { SessionConfiguration } from './configuration';
import type { FileChange, WatchFile } from './dependencies';

tmp.setGracefulCleanup();
let deactivateSession: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const roots = mainDocuments(context);
  const shutdowns = new Set<Promise<void>>();
  function retiring(dispose: Promise<void>): void {
    shutdowns.add(dispose);
    void dispose.finally(() => shutdowns.delete(dispose));
  }
  let activeSession: TexpressoSession | undefined;
  let preview: PreviewController | undefined;
  let startRequest = 0;
  let disposeTheme = () => {};
  let pendingRename: TexpressoSession | undefined;
  let lastError = '';
  const recoveryBudget = new RecoveryBudget();
  const launched = new WeakSet<TexpressoSession>();
  const failed = new WeakSet<TexpressoSession>();
  const sessionRequests = new WeakMap<TexpressoSession, number>();
  let latestOutput = { out: '', log: '' };
  const output = vscode.window.createOutputChannel('TeXpresso');
  const log = vscode.window.createOutputChannel('TeXpresso Log');
  const debug = vscode.window.createOutputChannel('TeXpresso Engine', { log: true });
  const build = vscode.window.createOutputChannel('TeXpresso Build');
  const setup = vscode.window.createOutputChannel('TeXpresso Setup');
  const controls = new PreviewControls();
  const compiler = new ExternalCompiler(text => build.append(text));
  const sourceFollow = new SourceFollow();
  context.subscriptions.push(output, log, debug, build, setup, controls, compiler);
  const running = () => activeSession?.state === 'running' ? activeSession : undefined;
  const settings = (document: vscode.TextDocument) => vscode.workspace.getConfiguration('texpresso', document.uri);
  const configurationFor = (document: vscode.TextDocument) =>
    resolveEngine(readConfiguration(settings(document)), context.extensionUri.fsPath);
  const watchGroups = new Map<string, { files: Map<string, Set<Parameters<WatchFile>[1]>>; dispose(): void }>();
  const watchKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const watchFile: WatchFile = (file, changed) => {
    let base = path.dirname(file);
    while (!fs.existsSync(base) && path.dirname(base) !== base) {
      base = path.dirname(base);
    }
    const pattern = base === path.dirname(file) ? '*' : '**/*';
    const groupKey = watchKey(base) + '\0' + pattern;
    let group = watchGroups.get(groupKey);
    if (!group) {
      const files = new Map<string, Set<Parameters<WatchFile>[1]>>();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      const dispatch = (uri: vscode.Uri, kind: FileChange) => {
        files.get(watchKey(uri.fsPath))?.forEach(callback => callback(kind));
      };
      const listeners = [watcher.onDidChange(uri => dispatch(uri, 'change')),
        watcher.onDidCreate(uri => dispatch(uri, 'create')), watcher.onDidDelete(uri => dispatch(uri, 'delete'))];
      group = { files, dispose() { listeners.forEach(listener => listener.dispose()); watcher.dispose(); } };
      watchGroups.set(groupKey, group);
    }
    const key = watchKey(file);
    const callbacks = group.files.get(key) || new Set();
    callbacks.add(changed);
    group.files.set(key, callbacks);
    let disposed = false;
    return { dispose() {
      if (disposed) { return; }
      disposed = true;
      callbacks.delete(changed);
      if (!callbacks.size) { group!.files.delete(key); }
      if (!group!.files.size) { group!.dispose(); watchGroups.delete(groupKey); }
    } };
  };

  function updateContexts(): void {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'texpresso.running', !!running());
    void vscode.commands.executeCommand('setContext', 'texpresso.starting', activeSession?.state === 'starting');
    void vscode.commands.executeCommand('setContext', 'texpresso.active',
      activeSession?.state === 'starting' || activeSession?.state === 'running');
    void vscode.commands.executeCommand('setContext', 'texpresso.hasDocument', !!activeSession);
    void vscode.commands.executeCommand('setContext', 'texpresso.paused', !!activeSession?.paused);
    void vscode.commands.executeCommand('setContext', 'texpresso.canPause', !!running() &&
      !activeSession?.unsupported.has('pause') && !activeSession?.unsupported.has('resume'));
    void vscode.commands.executeCommand('setContext', 'texpresso.canRerun', !!running() &&
      !activeSession?.unsupported.has('rerun-once') && !activeSession?.paused);
    void vscode.commands.executeCommand('setContext', 'texpresso.autoRerun', !!activeSession?.autoRerun);
    void vscode.commands.executeCommand('setContext', 'texpresso.canAutoRerun', !!running() && !activeSession?.unsupported.has('rerun'));
    void vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor',
      !!running() && !!editor && !!running()?.sync.contains(editor.document));
    controls.update(activeSession?.state === 'stopped' ? undefined : activeSession);
    if (activeSession?.embedded && activeSession.state === 'running' && !preview) {
      const controller = new PreviewController(vscode, context.extensionUri, activeSession,
        () => { if (preview === controller) { void stop(); } }, action => {
          const session = activeSession;
          if (!session || preview !== controller) { return; }
          if (action === 'restart') { void startDocument(session.document, false); }
          else if (action === 'pause') { session.setPaused(!session.paused); }
          else { output.show(true); }
        }, () => { if (activeSession) { sourceFollow.suspend(activeSession); } });
      preview = controller;
    }
    preview?.update();
    updatePrewarm();
  }

  async function stop(): Promise<void> {
    startRequest++; recoveryBudget.reset();
    const previous = activeSession;
    activeSession = undefined;
    pendingRename = undefined;
    const previousPreview = preview; preview = undefined; previousPreview?.dispose();
    if (previous) { retiring(previous.dispose()); }
    disposeTheme();
    retiring(compiler.dispose());
    updateContexts();
    await Promise.all(shutdowns);
  }
  deactivateSession = stop;
  context.subscriptions.push({ dispose: stop });

  async function reportError(error: unknown, configuration?: SessionConfiguration, recoveryExhausted = false): Promise<void> {
    const failure = describeFailure(error, configuration);
    if (recoveryExhausted) { failure.message = 'TeXpresso could not recover after two automatic restarts. ' + failure.message; }
    lastError = (recoveryExhausted ? 'Automatic recovery exhausted: ' : '') + (error instanceof Error ? error.message : String(error));
    debug.appendLine(lastError);
    const action = await vscode.window.showErrorMessage(
      failure.message, ...(process.platform === 'win32' && !configuration?.useWSL ? ['Reopen in WSL'] : []),
      'Check Setup', 'Open Settings', 'Show Engine Log');
    if (action === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', failure.setting);
    } else if (action === 'Show Engine Log') {
      debug.show(true);
    } else if (action === 'Check Setup') {
      void checkSetup();
    } else if (action === 'Reopen in WSL') {
      void vscode.commands.executeCommand('texpresso.openInWSL');
    }
  }

  async function sessionFailed(session: TexpressoSession, error: Error): Promise<void> {
    if (activeSession !== session || sessionRequests.get(session) !== startRequest || failed.has(session)) { return; }
    failed.add(session);
    lastError = error.message;
    // Record the original failure and bounded compiler output before a new
    // process can replace it. Never dump source buffers into diagnostics.
    debug.appendLine('[recovery] ' + error.name + ': ' + error.message);
    if ('details' in error && typeof error.details === 'string' && error.details) { debug.appendLine(error.details.slice(-8000)); }
    for (const [target, text] of Object.entries(latestOutput)) {
      if (text) { debug.appendLine('[recovery ' + target + ']\n' + text.slice(-8000)); }
    }
    const safeReplay = session.configuration.streamFiles || session.previewRequestLifecycle;
    if (!safeReplay || !isRecoverableEngineFailure(error, launched.has(session), latestOutput.out + '\n' + latestOutput.log)) {
      await reportError(error, session.configuration); return;
    }
    if (!recoveryBudget.take()) {
      debug.appendLine('[recovery] Automatic restart limit reached (two attempts in one minute).');
      await reportError(error, session.configuration, true); return;
    }
    debug.appendLine('[recovery] Restarting the engine from current editor buffers.');
    sourceFollow.invalidate(session);
    await startDocument(session.document, false, session);
  }

  async function startDocument(document = vscode.window.activeTextEditor?.document, checkRoot = true,
    recoveringFrom?: TexpressoSession): Promise<void> {
    if (recoveringFrom && activeSession !== recoveringFrom) { return; }
    const request = ++startRequest;
    if (!recoveringFrom) { recoveryBudget.reset(); }
    pendingRename = undefined;
    if (!document) {
      void vscode.window.showErrorMessage('TeXpresso: Open a LaTeX document first.');
      return;
    }
    if (checkRoot) {
      try {
        const session = activeSession;
        document = await roots.resolve(document, session ? { root: session.document,
          contains: source => session.sync.contains(source) } : undefined);
      } catch (error) {
        if (request === startRequest) { void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error)); }
        return;
      }
      if (!document || request !== startRequest) { return; }
    }
    let temporaryDirectory: tmp.DirResult | undefined;
    try {
      const configuration = configurationFor(document);
      let rootPath = document.fileName;
      if (document.isUntitled) {
        temporaryDirectory = tmp.dirSync({ unsafeCleanup: true });
        rootPath = path.join(temporaryDirectory.name, 'untitled.tex');
        await fs.promises.writeFile(rootPath, document.getText());
        rootPath = await fs.promises.realpath(rootPath);
      }
      if (request !== startRequest) {
        temporaryDirectory?.removeCallback();
        return;
      }
      const session = new TexpressoSession(document, configuration,
        new SessionPaths(rootPath, configuration.useWSL, undefined, configuration.wslDistribution), () => vscode.workspace.textDocuments, {
          state: () => {
            if (activeSession === session) {
              if (session.state === 'running') { launched.add(session); }
              updateContexts();
            }
          },
          output: (target, text) => {
            if (activeSession === session) {
              latestOutput[target] = text;
              (target === 'out' ? output : log).replace(text);
            }
          },
          debug: text => {
            if (activeSession === session) {
              debug.appendLine(text);
            }
          },
          synctex: (file, line, column, word) => { void revealSource(session, file, line, column, word); },
          preview: event => { if (activeSession === session) { preview?.handle(event); } },
          rendered: () => {
            if (running() === session && settings(session.document).get('syncTeXForwardOnSelection', true)) {
              syncForward(undefined, false);
            }
          },
          restart: () => {
            if (running() === session) {
              void startDocument(session.document, false);
            }
          },
          warning: message => {
            if (activeSession === session) {
              void vscode.window.showWarningMessage(message);
            }
          },
          error: error => {
            if (activeSession === session) {
              void sessionFailed(session, error);
            }
          }
        }, temporaryDirectory, undefined, {
          watchFile, roots: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath), recovering: !!recoveringFrom, initialPaused: recoveringFrom?.paused
        });
      temporaryDirectory = undefined;
      const previous = activeSession;
      sessionRequests.set(session, request);
      activeSession = session;
      if (recoveringFrom && preview) {
        preview.replaceSession(session);
        sourceFollow.suspend(session);
      } else {
        const previousPreview = preview; preview = undefined; previousPreview?.dispose();
      }
      if (previous) { retiring(previous.dispose()); }
      disposeTheme();
      retiring(compiler.dispose());
      output.clear(); log.clear(); latestOutput = { out: '', log: '' };
      if (!recoveringFrom) { debug.clear(); lastError = ''; }
      updateContexts();
      await session.start();
      if (running() === session && settings(document).get('useEditorTheme', false)) {
        adoptTheme(session);
      }
    } catch (error) {
      temporaryDirectory?.removeCallback();
      if (request === startRequest) {
        void reportError(error);
      }
    }
  }

  async function revealSource(session: TexpressoSession, file: string, line: number, column?: number, word?: string): Promise<void> {
    if (running() !== session) {
      return;
    }
    try {
      const document = session.document.isUntitled && file === session.paths.rootEditorPath
        ? session.document : await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (running() !== session) {
        return;
      }
      const sourceColumn = session.embedded
        ? vscode.window.visibleTextEditors.find(editor => session.sync.contains(editor.document))?.viewColumn || vscode.ViewColumn.One
        : undefined;
      const editor = await vscode.window.showTextDocument(document, sourceColumn);
      if (running() !== session) {
        return;
      }
      const refined = column === undefined || column <= 0 ? refineSourceWord(document.getText(), line - 1, word) : undefined;
      const position = document.validatePosition(new vscode.Position(refined?.line ?? Math.max(0, line - 1),
        refined?.character ?? Math.max(0, (column || 1) - 1)));
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    } catch (error) {
      debug.appendLine('Could not open SyncTeX source: ' + String(error));
    }
  }

  function updatePrewarm(): void {
    const editor = vscode.window.activeTextEditor;
    preview?.prepareEdit(editor?.document, editor?.document.offsetAt(editor.selection.start));
  }

  function syncForward(editor = vscode.window.activeTextEditor, explicit = true): void {
    const session = running();
    if (!editor || !session || !session.sync.contains(editor.document)) { return; }
    const state = session.previewState;
    const revision = state?.[2] === session.previewSequence ? state[1] : 0;
    if (!sourceFollow.request({ session, document: editor.document.uri.toString(), version: editor.document.version,
      line: editor.selection.active.line, column: editor.selection.active.character, sequence: session.previewSequence, revision }, explicit)) { return; }
    preview?.beginSourceFollow();
    session.sync.syncForward(editor.document, editor.selection.active.line);
  }

  function register(name: string, callback: (...args: never[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand('texpresso.' + name, callback));
  }
  register('startDocument', () => startDocument());
  register('selectMainDocument', async () => {
    const source = vscode.window.activeTextEditor?.document || activeSession?.document;
    if (!source) { return; }
    const request = ++startRequest;
    const document = await roots.select(source);
    if (document && request === startRequest && activeSession) { await startDocument(document, false); }
  });
  register('restart', () => activeSession && startDocument(activeSession.document, false));
  register('stop', stop);
  register('showControls', () => controls.show(activeSession?.state === 'stopped' ? undefined : activeSession));
  register('checkSetup', checkSetup);
  register('openInWSL', async () => {
    if (process.platform !== 'win32' || vscode.env.remoteName) {
      void vscode.window.showInformationMessage('Use this command in a local Windows VS Code window.');
      return;
    }
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('remote-wsl.reopenInWSL')) {
      await vscode.commands.executeCommand('remote-wsl.reopenInWSL');
    } else {
      await vscode.commands.executeCommand('extension.open', 'ms-vscode-remote.remote-wsl');
      void vscode.window.showInformationMessage('Install the WSL extension, then run TeXpresso: Reopen Folder in WSL.');
    }
  });
  register('showEngineLog', () => debug.show(true));
  register('showCompilerOutput', () => output.show(true));
  register('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso'));
  register('rerunOnce', () => { const session = running(); if (session) { sourceFollow.invalidate(session); session.rerunOnce(); } });
  register('pause', () => running()?.setPaused(true));
  register('resume', () => running()?.setPaused(false));
  for (const [name, enabled] of [['enableAutoRerun', true], ['disableAutoRerun', false]] as const) {
    register(name, () => {
      const document = activeSession?.document || vscode.window.activeTextEditor?.document;
      if (document) {
        const target = vscode.workspace.getWorkspaceFolder(document.uri)
          ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
        return settings(document).update('autoRerun', enabled, target);
      }
    });
  }
  // rescan does not reliably discover previously absent auxiliary files (#13).
  // Keep Refresh as a compatibility alias for a complete session restart.
  register('refresh', () => running() && startDocument(running()!.document, false));
  register('nextPage', () => preview ? preview.navigate(1) : running()?.send(['next-page']));
  register('previousPage', () => preview ? preview.navigate(-1) : running()?.send(['previous-page']));
  register('syncTeXForward', () => syncForward());
  register('syncTeXForwardShortName', () => syncForward());
  register('defaultTheme', () => running()?.send(['theme', [1, 1, 1], [0, 0, 0]]));
  register('adoptTheme', () => { if (running()) { adoptTheme(running()!); } });
  for (const [name, enabled] of [['activateSyncTeXForward', true], ['deactivateSyncTeXForward', false]] as const) {
    register(name, () => {
      const document = activeSession?.document || vscode.window.activeTextEditor?.document;
      if (document) {
        const target = vscode.workspace.getWorkspaceFolder(document.uri)
          ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
        void settings(document).update('syncTeXForwardOnSelection', enabled, target);
      }
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      const session = running();
      if (!session) {
        return;
      }
      if (event.affectsConfiguration('texpresso.useEditorTheme', session.document.uri)) {
        if (settings(session.document).get('useEditorTheme', false)) {
          adoptTheme(session);
        } else {
          session.send(['theme', [1, 1, 1], [0, 0, 0]]);
        }
      }
      if (event.affectsConfiguration('texpresso.syncTeXForwardOnSelection', session.document.uri)) {
        sourceFollow.invalidate(session);
        if (settings(session.document).get('syncTeXForwardOnSelection', true)) { syncForward(); }
      }
      if (event.affectsConfiguration('texpresso.autoRerun', session.document.uri)) {
        session.setAutoRerun(settings(session.document).get('autoRerun', false));
      }
      const launchKeys = ['command', 'useWSL', 'wslDistribution', 'useChangeRangeMode', 'packageProvider', 'miktexAutoInstall', 'miktexWindowsBin', 'includeDirectories', 'arguments',
        'streamFiles', 'watchDependencies', 'previewLocation'];
      if (launchKeys.some(key => event.affectsConfiguration('texpresso.' + key, session.document.uri)) &&
          JSON.stringify(configurationFor(session.document)) !== JSON.stringify(session.configuration)) {
        void vscode.window.showInformationMessage('TeXpresso settings changed. Restart the preview to apply them.', 'Restart')
          .then(action => {
            if (action === 'Restart' && running() === session) {
              void startDocument(session.document, false);
            }
          });
      }
    }),
    vscode.workspace.onDidOpenTextDocument(document => running()?.sync.openDocument(document)),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document === activeSession?.document) {
        if (pendingRename !== activeSession) {
          stop();
        }
      } else {
        const session = running();
        session?.sync.closeDocument(document);
        session?.dependencies.closed(document.uri.fsPath);
      }
    }),
    vscode.workspace.onWillRenameFiles(event => {
      const session = activeSession;
      if (session && renamedPath(session.paths.rootEditorPath, event.files)) {
        // VS Code may close the old document before firing onDidRenameFiles.
        pendingRename = session;
        // Windows cannot move a directory held as a child process's cwd.
        // Release this launch and any retiring launches before the rename;
        // onDidRenameFiles starts the preview again at its new path.
        retiring(session.dispose());
        retiring(compiler.dispose());
        disposeTheme();
        event.waitUntil(Promise.all(shutdowns).then(() => {}));
      }
    }),
    vscode.workspace.onDidRenameFiles(event => {
      const session = activeSession;
      if (!session || !session.sync.trackedPaths.some(file => renamedPath(file, event.files))) {
        return;
      }
      const root = renamedPath(session.paths.rootEditorPath, event.files) || session.paths.rootEditorPath;
      void vscode.workspace.openTextDocument(vscode.Uri.file(root)).then(document => {
        if (activeSession === session) {
          return startDocument(document, false);
        }
      }, error => {
        if (activeSession === session) {
          stop();
          void reportError(error, session.configuration);
        }
      });
    }),
    vscode.workspace.onDidChangeTextDocument(event => { running()?.sync.change(event.document, event.contentChanges); updatePrewarm(); }),
    vscode.window.onDidChangeActiveTextEditor(updateContexts),
    vscode.window.onDidChangeTextEditorSelection(event => {
      const session = running();
      if (session && event.textEditor === vscode.window.activeTextEditor && settings(session.document).get('syncTeXForwardOnSelection', true)) {
        syncForward(event.textEditor, false);
      }
      updatePrewarm();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      const session = running();
      if (session && settings(session.document).get('useEditorTheme', false)) {
        adoptTheme(session);
      }
    })
  );

  async function checkSetup(): Promise<void> {
    const session = activeSession;
    const document = session?.document || vscode.window.activeTextEditor?.document;
    if (!document) {
      void vscode.window.showInformationMessage('Open a LaTeX document to check its TeXpresso settings.');
      return;
    }
    setup.clear();
    setup.appendLine('Checking TeXpresso setup…');
    setup.show(true);
    try {
      const configuration = configurationFor(document);
      const paths = new SessionPaths(session?.paths.rootEditorPath || document.fileName, configuration.useWSL, undefined, configuration.wslDistribution);
      const host = process.platform + ' ' + process.arch + (vscode.env.remoteName ? ' (' + vscode.env.remoteName + ')' : '');
      const report = await setupReport(configuration, paths, host);
      setup.replace(report + (lastError ? '\nLast failure: ' + lastError + '\nSee TeXpresso Engine for engine output.\n' : ''));
    } catch (error) {
      setup.appendLine('Setup check failed: ' + String(error));
    }
  }

  register('externalCompileAndRefresh', async () => {
    const session = running();
    if (!session) {
      return;
    }
    const status = vscode.window.setStatusBarMessage('TeXpresso: External compilation...');
    session.dependencies.suspended = true;
    try {
      for (const document of vscode.workspace.textDocuments) {
        if (session.sync.contains(document) && document.isDirty && !document.isUntitled && !await document.save()) {
          return;
        }
      }
      if (running() !== session) {
        return;
      }
      if (session.document.isUntitled) {
        await fs.promises.writeFile(session.paths.rootEditorPath, session.document.getText());
      }
      build.show(true);
      await compiler.run(settings(session.document).get<string>('externalCompileCommand', 'latexmk'), session.paths);
      if (running() === session) {
        await startDocument(session.document, false);
      }
    } catch (error) {
      build.appendLine(String(error));
      if (running() === session) {
        void vscode.window.showErrorMessage('TeXpresso: ' + String(error));
      }
    } finally {
      session.dependencies.resumeWatching();
      status.dispose();
    }
  });

  function adoptTheme(session: TexpressoSession): void {
    disposeTheme();
    const panel = vscode.window.createWebviewPanel('texpresso.colorTheme', 'TeXpresso Theme',
      { preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }, { enableScripts: true });
    const receiver = panel.webview.onDidReceiveMessage((colors: unknown) => {
      cleanup();
      if (running() !== session || !Array.isArray(colors)) {
        return;
      }
      const theme = new Map<string, number[]>();
      for (const item of colors) {
        if (item && typeof item === 'object') {
          for (const [key, value] of Object.entries(item)) {
            if (typeof value === 'string') {
              const rgb = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
              if (rgb) {
                theme.set(key, rgb.slice(1).map(component => parseInt(component, 16) / 255));
              }
            }
          }
        }
      }
      const background = theme.get('--vscode-editor-background');
      const foreground = theme.get('--vscode-editor-foreground');
      if (background && foreground) {
        session.send(['theme', background, foreground]);
      }
    });
    const closed = panel.onDidDispose(() => {
      receiver.dispose();
      closed.dispose();
    });
    const cleanup = () => {
      closed.dispose();
      receiver.dispose();
      panel.dispose();
    };
    disposeTheme = cleanup;
    panel.webview.html = '<!DOCTYPE html><html><script>' +
      'const vscode = acquireVsCodeApi();' +
      'vscode.postMessage(["--vscode-editor-background","--vscode-editor-foreground"].map(key => ' +
      '({[key]: getComputedStyle(document.documentElement).getPropertyValue(key).trim()})));' +
      '</script></html>';
  }
  updateContexts();
}

export async function deactivate(): Promise<void> {
  const stop = deactivateSession;
  deactivateSession = undefined;
  await stop?.();
}
