import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import { readConfiguration } from './configuration';
import { SessionPaths } from './paths';
import { TexpressoSession } from './session';
import { ExternalCompiler } from './external-compile';
import { PreviewControls } from './controls';
import { describeFailure } from './failures';
import { setupReport } from './setup';
import { renamedPath } from './renames';
import type { SessionConfiguration } from './configuration';

tmp.setGracefulCleanup();
let deactivateSession: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  let activeSession: TexpressoSession | undefined;
  let startRequest = 0;
  let disposeTheme = () => {};
  let pendingRename: TexpressoSession | undefined;
  let lastError = '';
  const output = vscode.window.createOutputChannel('TeXpresso');
  const log = vscode.window.createOutputChannel('TeXpresso Log');
  const debug = vscode.window.createOutputChannel('TeXpresso Engine', { log: true });
  const build = vscode.window.createOutputChannel('TeXpresso Build');
  const setup = vscode.window.createOutputChannel('TeXpresso Setup');
  const controls = new PreviewControls();
  const compiler = new ExternalCompiler(text => build.append(text));
  context.subscriptions.push(output, log, debug, build, setup, controls, compiler);
  const running = () => activeSession?.state === 'running' ? activeSession : undefined;
  const settings = (document: vscode.TextDocument) => vscode.workspace.getConfiguration('texpresso', document.uri);

  function updateContexts(): void {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'texpresso.running', !!running());
    void vscode.commands.executeCommand('setContext', 'texpresso.starting', activeSession?.state === 'starting');
    void vscode.commands.executeCommand('setContext', 'texpresso.active',
      activeSession?.state === 'starting' || activeSession?.state === 'running');
    void vscode.commands.executeCommand('setContext', 'texpresso.hasDocument', !!activeSession);
    void vscode.commands.executeCommand('setContext', 'texpresso.inActiveEditor',
      !!running() && !!editor && !!running()?.sync.contains(editor.document));
    controls.update(activeSession?.state === 'stopped' ? undefined : activeSession);
  }

  function stop(): void {
    startRequest++;
    const previous = activeSession;
    activeSession = undefined;
    pendingRename = undefined;
    previous?.dispose();
    disposeTheme();
    compiler.dispose();
    updateContexts();
  }
  deactivateSession = stop;
  context.subscriptions.push({ dispose: stop });

  async function reportError(error: unknown, configuration?: SessionConfiguration): Promise<void> {
    const failure = describeFailure(error, configuration);
    lastError = error instanceof Error ? error.message : String(error);
    debug.appendLine(lastError);
    const action = await vscode.window.showErrorMessage(
      failure.message, 'Check Setup', 'Open Settings', 'Show Engine Log');
    if (action === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', failure.setting);
    } else if (action === 'Show Engine Log') {
      debug.show(true);
    } else if (action === 'Check Setup') {
      void checkSetup();
    }
  }

  async function startDocument(document = vscode.window.activeTextEditor?.document, checkRoot = true): Promise<void> {
    const request = ++startRequest;
    pendingRename = undefined;
    if (!document) {
      void vscode.window.showErrorMessage('TeXpresso: Open a LaTeX document first.');
      return;
    }
    if (checkRoot && !document.getText().includes('\\begin{document}')) {
      const result = await vscode.window.showWarningMessage(
        'This file does not contain \\begin{document}. Start TeXpresso from this file anyway?',
        { modal: true }, 'Continue');
      if (result !== 'Continue' || request !== startRequest) {
        return;
      }
    }
    let temporaryDirectory: tmp.DirResult | undefined;
    try {
      const configuration = readConfiguration(settings(document));
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
        new SessionPaths(rootPath, configuration.useWSL), () => vscode.workspace.textDocuments, {
          state: () => {
            if (activeSession === session) {
              updateContexts();
            }
          },
          output: (target, text) => {
            if (activeSession === session) {
              (target === 'out' ? output : log).replace(text);
            }
          },
          debug: text => {
            if (activeSession === session) {
              debug.appendLine(text);
            }
          },
          synctex: (file, line, column) => { void revealSource(session, file, line, column); },
          rendered: () => {
            if (running() === session && settings(session.document).get('syncTeXForwardOnSelection', true)) {
              syncForward();
            }
          },
          error: error => {
            if (activeSession === session) {
              void reportError(error, session.configuration);
            }
          }
        }, temporaryDirectory);
      temporaryDirectory = undefined;
      const previous = activeSession;
      activeSession = session;
      previous?.dispose();
      disposeTheme();
      compiler.dispose();
      output.clear();
      log.clear();
      debug.clear();
      lastError = '';
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

  async function revealSource(session: TexpressoSession, file: string, line: number, column = 1): Promise<void> {
    if (running() !== session) {
      return;
    }
    try {
      const document = session.document.isUntitled && file === session.paths.rootEditorPath
        ? session.document : await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (running() !== session) {
        return;
      }
      const editor = await vscode.window.showTextDocument(document);
      if (running() !== session) {
        return;
      }
      const position = document.validatePosition(new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1)));
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    } catch (error) {
      debug.appendLine('Could not open SyncTeX source: ' + String(error));
    }
  }

  function syncForward(editor = vscode.window.activeTextEditor): void {
    if (editor) {
      running()?.sync.syncForward(editor.document, editor.selection.active.line);
    }
  }

  function register(name: string, callback: (...args: never[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand('texpresso.' + name, callback));
  }
  register('startDocument', () => startDocument());
  register('restart', () => activeSession && startDocument(activeSession.document, false));
  register('stop', stop);
  register('showControls', () => controls.show(activeSession?.state === 'stopped' ? undefined : activeSession));
  register('checkSetup', checkSetup);
  register('showEngineLog', () => debug.show(true));
  register('showCompilerOutput', () => output.show(true));
  register('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'texpresso'));
  // rescan does not reliably discover previously absent auxiliary files (#13).
  // Keep Refresh as a compatibility alias for a complete session restart.
  register('refresh', () => running() && startDocument(running()!.document, false));
  register('nextPage', () => running()?.send(['next-page']));
  register('previousPage', () => running()?.send(['previous-page']));
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
      const launchKeys = ['command', 'useWSL', 'useChangeRangeMode', 'packageProvider', 'includeDirectories', 'arguments'];
      if (launchKeys.some(key => event.affectsConfiguration('texpresso.' + key, session.document.uri)) &&
          JSON.stringify(readConfiguration(settings(session.document))) !== JSON.stringify(session.configuration)) {
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
        running()?.sync.closeDocument(document);
      }
    }),
    vscode.workspace.onWillRenameFiles(event => {
      const session = activeSession;
      if (session && renamedPath(session.paths.rootEditorPath, event.files)) {
        // VS Code may close the old document before firing onDidRenameFiles.
        pendingRename = session;
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
    vscode.workspace.onDidChangeTextDocument(event => running()?.sync.change(event.document, event.contentChanges)),
    vscode.window.onDidChangeActiveTextEditor(updateContexts),
    vscode.window.onDidChangeTextEditorSelection(event => {
      const session = running();
      if (session && settings(session.document).get('syncTeXForwardOnSelection', true)) {
        syncForward(event.textEditor);
      }
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
      const configuration = readConfiguration(settings(document));
      const paths = new SessionPaths(session?.paths.rootEditorPath || document.fileName, configuration.useWSL);
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

export function deactivate(): void {
  deactivateSession?.();
  deactivateSession = undefined;
}
