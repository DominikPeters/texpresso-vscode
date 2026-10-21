import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type * as vscode from 'vscode';
import { readProtocol, Command, Message } from '../protocol';
import { OutputBuffer, SessionOutput } from '../logs';
import { buildLaunchCommand } from '../configuration';
import { SessionPaths } from '../paths';
import { DocumentSync } from '../document-sync';
import { TexpressoSession } from '../session';
import * as path from 'node:path';

import { config, document, FakeProcess } from './helpers';

test('protocol preserves every UTF-8 split boundary and recovers after malformed input', async () => {
  const notification = JSON.stringify(['synctex', 'café/章节/😀.tex', 12, 2]) + '\n';
  const bytes = Buffer.from(notification);
  for (let split = 1; split < bytes.length; split++) {
    const input = new PassThrough();
    const received: Message[] = [];
    const invalid: string[] = [];
    const reader = readProtocol(input, message => received.push(message), line => invalid.push(line));
    const closed = new Promise<void>(resolve => reader.once('close', resolve));
    input.write('not JSON\nnull\n["input-file","bad","file.tex"]\n');
    input.write(bytes.subarray(0, split));
    input.write(bytes.subarray(split));
    input.end('["flush"]\n["input-file",2,"child.tex"]\n');
    await closed;
    assert.deepEqual(received, [
      ['synctex', 'café/章节/😀.tex', 12, 2], ['flush'], ['input-file', 2, 'child.tex']
    ]);
    assert.equal(invalid.length, 3);
  }
});

test('output backtracking keeps the prefix, including truncation to zero', () => {
  const output = new OutputBuffer();
  output.appendLines(['one', 'two', 'three']);
  output.truncateLines(2);
  assert.equal(output.toString(), 'one\ntwo\n');
  output.appendLines(['replacement']);
  assert.equal(output.toString(), 'one\ntwo\nreplacement\n');
  output.truncateLines(0);
  assert.equal(output.toString(), '');
  output.append(0, 'é 😀 old');
  output.append(Buffer.byteLength('é 😀 '), 'new');
  assert.equal(output.toString(), 'é 😀 new');
  output.truncate(Buffer.byteLength('é'));
  assert.equal(output.toString(), 'é');
  output.truncate(0);
  assert.equal(output.toString(), '');
});

test('output channels publish only complete flushes and retain independent state', () => {
  const published: unknown[] = [];
  const output = new SessionOutput((target, contents) => published.push([target, contents]));
  output.handle(['append-lines', 'out', 'hello']);
  output.handle(['append', 'log', 0, 'engine']);
  assert.equal(published.length, 0);
  output.handle(['flush']);
  assert.deepEqual(published, [['out', 'hello\n'], ['log', 'engine']]);
  output.handle(['truncate-lines', 'out', 0]);
  output.handle(['flush']);
  assert.deepEqual(published[2], ['out', '']);
});

test('provider settings override legacy flags without mutating user arguments', () => {
  const args = ['-tectonic'];
  const configuration = { ...config, packageProvider: 'texlive' as const, arguments: args,
    includeDirectories: ['support files'] };
  const root = path.resolve('/work/paper/main.tex');
  const directory = path.dirname(root);
  const paths = new SessionPaths(root, false);
  const first = buildLaunchCommand(configuration, paths);
  const second = buildLaunchCommand(configuration, paths);
  assert.deepEqual(first, second);
  assert.deepEqual(args, ['-tectonic']);
  assert.deepEqual(first.args, ['-texlive', '-I', path.join(directory, 'support files'), '-json', '-lines', root]);
  assert.equal(first.command, 'texpresso');
  assert.equal(first.cwd, directory);
  assert.deepEqual(buildLaunchCommand({ ...config, arguments: ['-tectonic'] }, paths).args,
    ['-tectonic', '-json', '-lines', root]);
  assert.throws(() => buildLaunchCommand({ ...config, arguments: ['-tectonic', '-texlive'] }, paths));
  assert.throws(() => buildLaunchCommand({ ...config, arguments: ['-I'] }, paths));
  assert.deepEqual(buildLaunchCommand({ ...configuration, arguments: ['-I', '-tectonic'] }, paths).args.slice(0, 3),
    ['-I', '-tectonic', '-texlive']);
});

test('WSL launches and synchronization use engine paths, including paths with spaces', () => {
  const conversion = {
    toEngine: (file: string) => file.replace(/^C:\\/, '/mnt/c/').replace(/\\/g, '/'),
    toEditor: (file: string) => file.replace(/^\/mnt\/c\//, 'C:\\').replace(/\//g, '\\')
  };
  const paths = new SessionPaths('C:\\Paper Folder\\main.tex', true, conversion);
  assert.equal(paths.toEditor('child.tex'), 'C:\\Paper Folder\\child.tex');
  const command = buildLaunchCommand({ ...config, useWSL: true, packageProvider: 'tectonic',
    includeDirectories: ['C:\\Support Files'] }, paths);
  assert.deepEqual(command, { command: 'wsl', args: ['-e', 'texpresso', '-tectonic', '-I',
    '/mnt/c/Support Files', '-json', '-lines', '/mnt/c/Paper Folder/main.tex'] });
  const root = document(paths.rootEditorPath);
  const child = document('C:\\Paper Folder\\child.tex');
  const sent: Command[] = [];
  const sync = new DocumentSync(root, paths, true, () => [root, child], cmd => sent.push(cmd));
  sync.initialize();
  sync.announce('child.tex');
  sync.syncForward(child, 4);
  assert.deepEqual(sent.at(-1), ['synctex-forward', '/mnt/c/Paper Folder/child.tex', 5]);
});

function edit(offset: number, length: number, text: string): vscode.TextDocumentContentChangeEvent {
  return { rangeOffset: offset, rangeLength: length, text,
    range: { start: { line: 0, character: offset }, end: { line: 0, character: offset + length } }
  } as vscode.TextDocumentContentChangeEvent;
}

for (const useRanges of [true, false]) {
  test('included file edits and resets retain a correct pre-edit snapshot (' + (useRanges ? 'ranges' : 'bytes') + ')', () => {
    const root = document('/work/main.tex');
    const child = document('/work/child.tex', 'éabc');
    let documents = [root, child];
    const sent: Command[] = [];
    const sync = new DocumentSync(root, new SessionPaths(root.fileName, false), useRanges,
      () => documents, command => sent.push(command));
    sync.initialize();
    sync.announce('child.tex');
    // Repeated input indices / notifications after backtracking must not reopen
    // or reset the pre-edit buffer.
    sync.announce('child.tex');
    assert.equal(sent.filter(cmd => cmd[0] === 'open' && cmd[1] === child.fileName).length, 1);
    sync.change(child, [edit(1, 1, 'XX'), edit(3, 1, 'Z')]);
    const changes = sent.filter(cmd => cmd[0] === 'change' || cmd[0] === 'change-range');
    assert.deepEqual(changes, useRanges ? [
      ['change-range', child.fileName, 0, 3, 0, 4, 'Z'],
      ['change-range', child.fileName, 0, 1, 0, 2, 'XX']
    ] : [
      ['change', child.fileName, 4, 1, 'Z'],
      ['change', child.fileName, 2, 1, 'XX']
    ]);
    sync.closeDocument(child);
    assert.deepEqual(sent.at(-1), ['close', child.fileName]);
    documents = [root];
    sync.initialize();
    assert.deepEqual(sent.at(-1), ['open', root.fileName, 'abc']);
    const reopened = document(child.fileName, 'fresh');
    documents = [root, reopened];
    sync.openDocument(reopened);
    sync.change(reopened, [edit(0, 1, 'F')]);
    assert.deepEqual(sent.at(-1), useRanges
      ? ['change-range', child.fileName, 0, 0, 0, 1, 'F']
      : ['change', child.fileName, 0, 1, 'F']);
  });
}

test('failed process startup leaves a failed session and no running state', async () => {
  const states: string[] = [];
  const errors: Error[] = [];
  const child = new FakeProcess();
  const root = document('/work/main.tex');
  const session = new TexpressoSession(root, config, new SessionPaths(root.fileName, false), () => [root], {
    state: state => states.push(state), error: error => errors.push(error),
    output() {}, debug() {}, synctex() {}
  }, undefined, () => {
    queueMicrotask(() => {
      child.emit('error', new Error('spawn ENOENT'));
      child.emit('close', -2, null);
    });
    return child.asChild();
  });
  await session.start();
  assert.equal(session.state, 'failed');
  assert.deepEqual(states, ['failed']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ENOENT/);
  assert.equal(child.commands.length, 0);
});

test('stopping during startup does not reopen buffers or report an intentional exit as an error', async () => {
  const child = new FakeProcess();
  const errors: Error[] = [];
  const root = document('/work/main.tex');
  const session = new TexpressoSession(root, config, new SessionPaths(root.fileName, false), () => [root], {
    state() {}, error: error => errors.push(error), output() {}, debug() {}, synctex() {}
  }, undefined, () => child.asChild());
  const starting = session.start();
  session.dispose();
  child.emit('spawn');
  child.emit('close', null, 'SIGTERM');
  await starting;
  assert.equal(session.state, 'stopped');
  assert.equal(errors.length, 0);
  assert.equal(child.commands.length, 0);
});

test('session handles reset-sync and preserves final output when the process exits', async () => {
  const child = new FakeProcess();
  const root = document('/work/main.tex');
  const published: unknown[] = [];
  const session = new TexpressoSession(root, config, new SessionPaths(root.fileName, false), () => [root], {
    state() {}, error(error) { throw error; },
    output: (target, text) => published.push([target, text]), debug() {}, synctex() {}
  }, undefined, () => {
    queueMicrotask(() => child.emit('spawn'));
    return child.asChild();
  });
  await session.start();
  child.stdout.write('["reset-sync"]\n["append-lines","out","last message"]\n');
  assert.equal(child.commands.filter(cmd => cmd[0] === 'open').length, 2);
  child.emit('close', 0, null);
  assert.equal(session.state, 'stopped');
  assert.deepEqual(published, [['out', 'last message\n']]);
});
