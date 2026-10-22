#!/usr/bin/env node
/* Inspect real MuPDF SVG stability across letter insertion/undo and font changes.
 * Run npm run compile-tests first. Uses local TeX Live and headless engines. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const {Run, fixtures} = require('../profile-preview.cjs');
const output = path.resolve(process.argv[2] || 'artifacts/profile-svg-diff');
if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Choose an empty output directory');
fs.mkdirSync(output, { recursive: true });
const binary = path.resolve(process.env.TEXPRESSO_BINARY || `native/.bundles/${process.platform}-${process.arch}-preview/bin/texpresso`);
const change = (run, offset, old, replacement) => {
  if (run.text.slice(offset, offset + old.length) !== old) throw new Error('Unexpected source');
  const position = offset => {
    const before = run.text.slice(0, offset);
    return { line: before.split('\n').length - 1, character: offset - (before.lastIndexOf('\n') + 1) };
  };
  const range = { start: position(offset), end: position(offset + old.length) };
  run.text = run.text.slice(0, offset) + replacement + run.text.slice(offset + old.length);
  run.session.sync.change(run.main, [{ rangeOffset: offset, rangeLength: old.length, text: replacement, range }]);
};
(async () => {
  const results = [];
  const corpus = fixtures(output, [10], ['sparse', 'dense', 'packed', 'tikz']);
  if (process.argv.includes('--math')) {
    const root = path.join(output, 'fixtures', 'math'), file = path.join(root, 'main.tex');
    const text = fs.readFileSync(path.join(__dirname, '../preview-demo/sample.tex'), 'utf8');
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, text);
    corpus.push({ id: 'math', kind: 'math', root, file, text, pages: 2 });
  }
  for (const fixture of corpus) {
    const run = new Run(fixture, binary, 'svg', 1600, output, 0);
    try {
      run.started = performance.now(); await run.session.start();
      const baseline = await run.operation('initial', 0);
      const offset = run.text.indexOf(fixture.kind === 'math' ? 'x^2' : 'aaaa.');
      const inserted = await run.operation('insert-letter', 0, () => change(run, offset, '', 'z'));
      const undo = await run.operation('undo-letter', 0, () => change(run, offset, 'z', ''));
      const fontOffset = run.text.indexOf(fixture.kind === 'math' ? '\\maketitle' : '\\noindent');
      const font = await run.operation('insert-earlier-font', 0, () => change(run, fontOffset, '', '\\textbf{Z} '));
      for (const [name, frame] of Object.entries({ baseline, inserted, undo, font })) {
        if (frame.header.mime !== 'image/svg+xml') throw new Error('Unexpected fallback');
        fs.writeFileSync(path.join(output, `${fixture.kind}-${name}.svg`), frame.bytes);
      }
      results.push({ kind: fixture.kind, operations: run.operations, undoExact: baseline.bytes.equals(undo.bytes) });
    } finally { await run.dispose(); }
  }
  fs.writeFileSync(path.join(output, 'native.json'), JSON.stringify(results, null, 2));
  cp.execFileSync('python3', [path.join(__dirname, 'svg-diff.py'), output], { stdio: 'inherit' });
})().catch(error => { console.error(error); process.exitCode = 1; });
