import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { TexpressoSession } from '../session';
import { config, document, FakeProcess } from './helpers';

test('controller isolates old process exits, reloads root settings, and retains failure logs', async () => {
  const main = document('/work/main.tex', '\\begin{document}sample\\end{document}');
  const childDocument = document('/work/child.tex');
  const values: Record<string, unknown> = { ...config };
  const commands = new Map<string, () => unknown>();
  const contexts = new Map<string, unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const channels = new Map<string, { text: string; clear(): void; replace(text: string): void;
    append(text: string): void; appendLine(text: string): void; show(): void; dispose(): void }>();
  const children: FakeProcess[] = [];
  const launches: string[][] = [];
  const scopedReads: unknown[] = [];
  const errors: string[] = [];
  const disposable = { dispose() {} };
  const event = (name: string) => (listener: (...args: unknown[]) => unknown) => {
    listeners.set(name, listener);
    return disposable;
  };
  const editor = { document: main, selection: { active: { line: 0 } } };
  const api = {
    workspace: {
      textDocuments: [main, childDocument],
      getConfiguration(_section: string, scope: unknown) {
        scopedReads.push(scope);
        return { get(key: string, fallback: unknown) {
          return structuredClone(values[key] === undefined ? fallback : values[key]);
        } };
      },
      onDidChangeConfiguration: event('configuration'),
      onDidOpenTextDocument: event('open'), onDidCloseTextDocument: event('close'),
      onDidChangeTextDocument: event('change'),
      onWillRenameFiles: event('willRename'), onDidRenameFiles: event('rename')
    },
    window: {
      activeTextEditor: editor,
      createOutputChannel(name: string) {
        const channel = {
          text: '',
          clear() { this.text = ''; }, replace(text: string) { this.text = text; },
          append(text: string) { this.text += text; }, appendLine(text: string) { this.text += text + '\n'; },
          show() {}, dispose() {}
        };
        channels.set(name, channel);
        return channel;
      },
      onDidChangeActiveTextEditor: event('editor'),
      onDidChangeTextEditorSelection: event('selection'),
      onDidChangeActiveColorTheme: event('theme'),
      async showWarningMessage() { return 'Continue'; },
      async showInformationMessage() { return 'Restart'; },
      async showErrorMessage(message: string) { errors.push(message); }
    },
    commands: {
      registerCommand(name: string, handler: () => unknown) { commands.set(name, handler); return disposable; },
      async executeCommand(name: string, key: string, value: unknown) {
        assert.equal(name, 'setContext');
        contexts.set(key, value);
      }
    }
  };

  class TestSession extends TexpressoSession {
    constructor(...args: ConstructorParameters<typeof TexpressoSession>) {
      super(args[0], args[1], args[2], args[3], args[4], args[5], (_command, argv) => {
        launches.push([...argv]);
        const process = new FakeProcess();
        children.push(process);
        queueMicrotask(() => process.emit('spawn'));
        return process.asChild();
      });
    }
  }
  const extensionPath = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(extensionPath);
  const exported: { activate?: (context: { subscriptions: unknown[] }) => void; deactivate?: () => void } = {};
  vm.runInNewContext(readFileSync(extensionPath, 'utf8'), {
    exports: exported, module: { exports: exported },
    require(name: string) {
      if (name === 'vscode') {
        return api;
      }
      if (name === './session') {
        return { TexpressoSession: TestSession };
      }
      if (name === './controls') {
        return { PreviewControls: class { update() {} show() {} dispose() {} } };
      }
      return localRequire(name);
    }
  });
  exported.activate!({ subscriptions: [] });
  try {
    await commands.get('texpresso.startDocument')!();
    assert.equal(contexts.get('texpresso.running'), true);
    assert.equal(contexts.get('texpresso.inActiveEditor'), true);
    children[0].stdout.write('["input-file",2,"child.tex"]\n');
    await commands.get('texpresso.startDocument')!();
    children[1].stdout.write('["append-lines","out","new session output"]\n["flush"]\n');
    children[0].emit('close', null, 'SIGTERM');
    assert.equal(contexts.get('texpresso.running'), true);
    assert.equal(channels.get('TeXpresso')!.text, 'new session output\n');
    assert.equal(errors.length, 0);
    assert.deepEqual(children[1].commands.at(-1), ['synctex-forward', main.fileName, 1]);

    values.packageProvider = 'tectonic';
    // Restart must use the original root, even with an imported file active.
    editor.document = childDocument;
    listeners.get('configuration')!({
      affectsConfiguration: (key: string) => key === 'texpresso.packageProvider'
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(children.length, 3);
    assert.ok(launches[2].includes('-tectonic'));
    assert.equal(launches[2].at(-1), main.fileName);
    assert.ok(scopedReads.every(scope => scope === main.uri));

    await commands.get('texpresso.restart')!();
    assert.equal(launches[3].at(-1), main.fileName);
    assert.equal(children[2].killed, true);

    children[3].stdout.write('["append-lines","out","failure details"]\n["flush"]\n');
    children[3].emit('close', 1, null);
    assert.equal(contexts.get('texpresso.running'), false);
    assert.equal(channels.get('TeXpresso')!.text, 'failure details\n');
    assert.equal(errors.length, 1);
  } finally {
    exported.deactivate!();
  }
});
