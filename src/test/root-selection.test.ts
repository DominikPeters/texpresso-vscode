import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as vm from 'node:vm';
import type * as vscode from 'vscode';
import { document } from './helpers';

test('picker scopes candidates and remembered selections to a workspace folder and follows renames', async () => {
  const first = path.resolve('/first'); const second = path.resolve('/second');
  const uri = (file: string) => ({ fsPath: file, toString: () => file });
  const root = document(path.join(second, 'main.tex'), '\\documentclass{article}');
  const empty = document(path.join(second, 'empty.tex'), '');
  const child = document(path.join(second, 'chapter.tex'));
  const unrelated = document(path.join(first, 'chapter.tex'));
  for (const d of [root, empty, child, unrelated]) { Object.assign(d, { uri: uri(d.fileName) }); }
  const documents = [root, empty, child, unrelated];
  const folder = (file: { fsPath: string }) => ({ uri: uri(file.fsPath.startsWith(first + path.sep) ? first : second), name: 'Project' });
  let rename: (event: unknown) => void = () => {};
  let selected: string | undefined = root.fileName;
  let base: unknown;
  let saved: Record<string, string> = {};
  const api = {
    Uri: { file: uri },
    RelativePattern: class { constructor(value: unknown) { base = value; } },
    workspace: {
      textDocuments: documents, getWorkspaceFolder: folder,
      onDidRenameFiles(callback: typeof rename) { rename = callback; return { dispose() {} }; },
      async findFiles() { return [root.uri, empty.uri]; },
      fs: { async stat() { return { size: 20 }; }, async readFile() { return Buffer.from('\\documentclass{article}'); } },
      async openTextDocument(value: { fsPath: string }) {
        const doc = documents.find(d => d.fileName === value.fsPath);
        if (!doc) { throw new Error('ENOENT'); } return doc;
      }
    },
    window: {
      async showQuickPick(items: { uri?: { fsPath: string }; description?: string }[]) {
        assert.ok(!items.some(item => item.uri?.fsPath === empty.fileName), 'empty editor overlay wins over disk content');
        const chosen = selected ? items.find(item => item.uri?.fsPath === selected) : undefined;
        if (chosen) { assert.ok(chosen.description, 'candidate has a distinguishing relative path'); }
        return chosen;
      }
    }
  };
  const file = path.join(__dirname, '../root-selection.js');
  const localRequire = createRequire(file);
  const exported = {} as typeof import('../root-selection');
  vm.runInNewContext(readFileSync(file, 'utf8'), { exports: exported, Buffer,
    require: (name: string) => name === 'vscode' ? api : localRequire(name) });
  const roots = exported.mainDocuments({ subscriptions: [], workspaceState: {
    get: () => saved, async update(_key: string, value: Record<string, string>) { saved = value; }
  } } as unknown as vscode.ExtensionContext);
  assert.equal(await roots.select(child), root);
  assert.equal((base as { fsPath: string }).fsPath, second);
  selected = undefined;
  assert.equal(await roots.resolve(child), root);
  assert.equal(await roots.resolve(unrelated), undefined, 'another workspace folder has no remembered root');
  const old = root.fileName;
  Object.assign(root, { fileName: path.join(second, 'renamed.tex'), uri: uri(path.join(second, 'renamed.tex')) });
  rename({ files: [{ oldUri: uri(old), newUri: root.uri }] });
  assert.equal(await roots.resolve(child), root);
});
