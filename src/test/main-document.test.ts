import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { MainDocuments, magicRoot, isMainDocument, RootDocument } from '../main-document';

const doc = (name: string, text: string): RootDocument => ({ fileName: path.resolve(name), isUntitled: false, getText: () => text });
function fixture(documents: RootDocument[]) {
  const saved = new Map<string, string>(); let chosen: RootDocument | undefined; let picks = 0;
  const project = (d: RootDocument) => d.fileName.split(path.sep).slice(0, -1).join(path.sep);
  const roots = new MainDocuments({
    async open(file: string) { const d = documents.find(d => d.fileName === file); if (!d) { throw new Error('ENOENT'); } return d; },
    async choose() { picks++; return chosen; },
    recalled: d => saved.get(project(d)),
    remember(d, root) { if (root) { saved.set(project(d), root.fileName); } else { saved.delete(project(d)); } }
  });
  return { roots, saved, get picks() { return picks; }, choose(d: RootDocument | undefined) { chosen = d; } };
}

test('root comments support casing, whitespace, quoted spaces, relative chains and explicit precedence', async () => {
  const main = doc('/paper/main document.tex', '\\documentclass{article}');
  const middle = doc('/paper/chapters/parent.tex', '% !TEX root = ../main document.tex');
  const child = doc('/paper/chapters/child.tex', '%!tex root="parent.tex"\n\\begin{document}');
  const f = fixture([main, middle, child]);
  assert.equal(magicRoot('% !TeX root = "a b.tex"'), 'a b.tex');
  assert.equal(await f.roots.resolve(child, { root: middle, contains: () => true }), main);
  assert.equal(f.picks, 0);
});

test('broken, circular and untitled relative magic roots are actionable errors', async () => {
  const a = doc('/paper/a.tex', '% !TeX root=b.tex'); const b = doc('/paper/b.tex', '% !TeX root=a.tex');
  const f = fixture([a, b]);
  await assert.rejects(f.roots.resolve(a), /Circular/);
  await assert.rejects(f.roots.resolve(doc('/paper/c.tex', '% !TeX root=missing.tex')), /Cannot open main document/);
  await assert.rejects(f.roots.resolve(doc('/paper/c.tex', '% !TeX root= ')), /Empty/);
  await assert.rejects(f.roots.resolve({ ...a, isUntitled: true }), /Save this file/);
  assert.equal(f.picks, 0, 'invalid explicit paths never silently select another document');
});

test('known inputs retain their preview root; standalone files and comments are distinguished', async () => {
  const main = doc('/paper/main.tex', '\\documentclass[12pt]{article}');
  const child = doc('/paper/child.tex', '% \\begin{document}\nChapter.');
  const f = fixture([main, child]);
  assert.equal(await f.roots.resolve(child, { root: main, contains: d => d === child }), main);
  assert.equal(await f.roots.resolve(main), main);
  assert.equal(isMainDocument(child.getText()), false);
  assert.equal(isMainDocument('\\verb|\\begin{document}|'), false);
  assert.equal(isMainDocument('\\begin{verbatim}\n\\documentclass{article}\n\\end{verbatim}'), false);
  assert.equal(isMainDocument('\\% literal percent\n\\begin{document}'), true);
});

test('selected roots are remembered per project; cancellation and stale selections are safe', async () => {
  const main = doc('/paper/main.tex', '\\documentclass{article}');
  const child = doc('/paper/child.tex', 'Chapter.'); const other = doc('/other/child.tex', 'Other project.');
  const docs = [main, child, other]; const f = fixture(docs);
  f.choose(main); assert.equal(await f.roots.resolve(child), main);
  f.choose(undefined); assert.equal(await f.roots.resolve(child), main);
  assert.equal(await f.roots.resolve(other), undefined);
  docs.splice(docs.indexOf(main), 1);
  assert.equal(await f.roots.resolve(child), undefined);
  assert.equal(f.saved.size, 0);
});
