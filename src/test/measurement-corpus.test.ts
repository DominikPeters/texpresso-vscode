import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { prepare, fingerprint } = require('../../scripts/profiling/real-corpus.cjs');

test('measurement corpus copies inputs without altering originals or inheriting generated TeX state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texpresso-corpus-'));
  try {
    const project = path.join(dir, 'project'), output = path.join(dir, 'output'), config = path.join(dir, 'inputs.json');
    fs.mkdirSync(project);
    const text = '\\pdfoutput=1\n\\documentclass{article}\n\\begin{document}\nUnique anchor.\n\\end{document}\n';
    fs.writeFileSync(path.join(project, 'main.tex'), text);
    fs.writeFileSync(path.join(project, 'main.aux'), 'old auxiliary state');
    fs.writeFileSync(config, JSON.stringify([{id:'paper', project, entry:'main.tex', focusPage:0, editAfter:'Unique anchor', removePdfOutput:true, normalizePreviewNumbers:true}]));
    const [result] = prepare(config, output);
    assert.equal(fs.readFileSync(path.join(project, 'main.tex'), 'utf8'), text);
    assert.equal(fs.existsSync(path.join(result.root, 'main.aux')), false);
    assert.notEqual(result.sourceSha256, result.originalSha256);
    assert.equal(result.text.slice(result.editOffset - 'Unique anchor'.length, result.editOffset), 'Unique anchor');
    assert.equal(result.projectFingerprint.files, 1);
    assert.equal(result.normalizePreviewNumbers, true);
    fs.writeFileSync(path.join(result.root, 'main.aux'), 'new auxiliary state');
    assert.deepEqual(fingerprint(result.root), result.projectFingerprint);
    assert.throws(() => prepare(config, output), /fresh corpus/);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('measurement corpus rejects an entry outside the copy before writing output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texpresso-corpus-'));
  try {
    const config = path.join(dir, 'inputs.json'), output = path.join(dir, 'output');
    fs.writeFileSync(config, JSON.stringify([{id:'paper', project:dir, entry:'../../original.tex', focusPage:0, editAfter:'anchor'}]));
    assert.throws(() => prepare(config, output), /within the copied project/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
