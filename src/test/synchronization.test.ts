import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { ByteBuffer } from '../byte-buffer';
import { DocumentSync } from '../document-sync';
import { SessionPaths } from '../paths';
import { renamedPath } from '../renames';
import { Command } from '../protocol';
import { document } from './helpers';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

test('legacy byte offsets stay correct across former rope boundaries and Unicode edits', () => {
  let text = 'a'.repeat(500) + '😀' + 'b'.repeat(500) + '\r\ncafé 章节';
  const buffer = new ByteBuffer(text);
  let seed = 42;
  const random = (bound: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % bound; };
  for (let i = 0; i < 200; i++) {
    // Include every offset, even positions between UTF-16 surrogate halves.
    for (let offset = 0; offset <= text.length; offset++) {
      assert.equal(buffer.byteOffset(offset), Buffer.byteLength(text.slice(0, offset)), 'offset ' + offset);
    }
    const offset = random(text.length + 1);
    const length = Math.min(random(12), text.length - offset);
    const addition = ['😀', 'é', '\r\n', '', '章节', 'abc'][random(6)];
    buffer.replace(offset, length, addition);
    text = text.slice(0, offset) + addition + text.slice(offset + length);
  }
});

test('multiple legacy edits use the pre-edit snapshot and subsequent events use the updated one', () => {
  const text = 'a'.repeat(500) + '😀' + 'b'.repeat(500);
  const root = document('/work/main.tex', text);
  const sent: Command[] = [];
  const sync = new DocumentSync(root, new SessionPaths(root.fileName, false), false, () => [root], cmd => sent.push(cmd));
  const edit = (offset: number, length: number, text: string) =>
    ({ rangeOffset: offset, rangeLength: length, text } as vscode.TextDocumentContentChangeEvent);
  sync.initialize();
  sync.change(root, [edit(0, 1, 'é'), edit(503, 1, 'X')]);
  assert.deepEqual(sent.slice(-2), [['change', root.fileName, 505, 1, 'X'], ['change', root.fileName, 0, 1, 'é']]);
  sync.change(root, [edit(504, 1, 'Y')]);
  assert.deepEqual(sent.at(-1), ['change', root.fileName, 507, 1, 'Y']);
});

test('rename matching covers enclosing directories without matching siblings with the same prefix', () => {
  const old = path.resolve('/work/paper');
  const moved = path.resolve('/work/new paper');
  const renames = [{ oldUri: { fsPath: old }, newUri: { fsPath: moved } }];
  assert.equal(renamedPath(path.join(old, 'chapters', 'main.tex'), renames), path.join(moved, 'chapters', 'main.tex'));
  assert.equal(renamedPath(path.resolve('/work/paper2/main.tex'), renames), undefined);
});

test('included-directory sources retain logical engine names and resolve to real editor documents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-includes-'));
  try {
    const root = document(path.join(directory, 'main.tex'));
    const support = path.join(directory, 'support files');
    await fs.mkdir(support);
    const child = document(path.join(support, 'child.tex'));
    await fs.writeFile(root.fileName, root.getText());
    await fs.writeFile(child.fileName, child.getText());
    const paths = new SessionPaths(root.fileName, false);
    const sent: Command[] = [];
    const sync = new DocumentSync(root, paths, true, () => [root, child], cmd => sent.push(cmd));
    sync.includeDirectories = [support];
    sync.announce('child.tex');
    assert.ok(sync.contains(child));
    const logicalName = path.join(paths.engineDirectory, 'child.tex');
    assert.deepEqual(sent.at(-1), ['open', logicalName, child.getText()]);
    assert.equal(sync.editorPath('child.tex'), child.uri.fsPath);
    sync.syncForward(child, 0);
    assert.deepEqual(sent.at(-1), ['synctex-forward', logicalName, 1]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('canonical engine paths match buffers opened through a directory symlink', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-symlink-'));
  try {
    const real = path.join(directory, 'real');
    const alias = path.join(directory, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(real, 'main.tex'), 'main');
    await fs.writeFile(path.join(real, 'child.tex'), 'child');
    const root = document(path.join(alias, 'main.tex'));
    const child = document(path.join(alias, 'child.tex'));
    const paths = new SessionPaths(root.fileName, false);
    const sent: Command[] = [];
    const sync = new DocumentSync(root, paths, true, () => [root, child], cmd => sent.push(cmd));
    const canonicalChild = await fs.realpath(child.fileName);
    sync.announce(canonicalChild);
    assert.ok(sync.contains(child));
    assert.equal(sync.editorPath(canonicalChild), child.uri.fsPath);
    assert.deepEqual(sent.at(-1), ['open', canonicalChild, child.getText()]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
