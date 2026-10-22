#!/usr/bin/env node
/* Actual headless renders, followed by a probe of dirty rectangles and crop PNGs. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const {Run, fixtures} = require('../profile-preview.cjs'), png = require('./png-regions.cjs');
const output = path.resolve(process.argv[2] || 'artifacts/profile-png-regions');
if (fs.existsSync(output) && fs.readdirSync(output).length) throw Error('Choose an empty output directory');
fs.mkdirSync(output, { recursive: true });
const binary = path.resolve(process.env.TEXPRESSO_BINARY || `native/.bundles/${process.platform}-${process.arch}-preview/bin/texpresso`);
function change(run, offset, old, value) {
  if (run.text.slice(offset, offset + old.length) !== old) throw Error('Unexpected source');
  const position = offset => { const before = run.text.slice(0, offset); return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 }; };
  const range = { start: position(offset), end: position(offset + old.length) };
  run.text = run.text.slice(0, offset) + value + run.text.slice(offset + old.length);
  run.session.sync.change(run.main, [{ rangeOffset: offset, rangeLength: old.length, text: value, range }]);
}
const paragraph = 'A measurement of interactive document rendering needs ordinary prose with enough words to fill several lines. Small source changes can move later words and sometimes alter every remaining line of a paragraph. We compare the complete old and new images so that erased letters, moved figures, and their white backgrounds are all included in the update. The resulting rectangle must reproduce every pixel of the new page, including places where ink disappeared.';
(async () => {
  const results = [];
  for (const fixture of fixtures(output, [10], ['sparse', 'dense', 'packed', 'tikz'])) {
    fixture.text = fixture.text.replace(/\\lipsum\[1(?:-(\d+))?\]/, (_, last) => '\\noindent ' + paragraph + '\\par\n' + (last ? `\\lipsum[2-${last}]` : ''));
    fs.writeFileSync(fixture.file, fixture.text);
    const run = new Run(fixture, binary, 'png', 1600, output, 0);
    try {
      run.started = performance.now(); await run.session.start();
      const baseline = await run.operation('initial', 0), a = png.decode(baseline.bytes);
      const cases = [['letter', 'aaaa.', 'zaaaa.'], ['reflow', 'measurement', 'an appreciably longer replacement phrase']];
      if (fixture.kind === 'tikz') cases.push(['coordinate', '(12,1.0)', '(12,2.0)']);
      for (const [name, old, value] of cases) {
        const offset = run.text.indexOf(old);
        const frame = await run.operation(name, 0, () => change(run, offset, old, value));
        const decodeStart = performance.now(), b = png.decode(frame.bytes), decodeMs = performance.now() - decodeStart;
        const scan = [], encode = []; let rect, patch;
        for (let i = 0; i < 9; i++) {
          const start = performance.now(); rect = png.dirty(a, b); const scanMs = performance.now() - start;
          if (!rect) throw Error('No pixel change');
          const encodeStart = performance.now(); patch = png.crop(b, rect); const encodeMs = performance.now() - encodeStart;
          if (i >= 2) { scan.push(scanMs); encode.push(encodeMs); }
        }
        png.verify(a, b, rect, patch);
        const undoPatch = png.crop(a, rect); png.verify(b, a, rect, undoPatch);
        const stem = `${fixture.kind}-${name}`;
        for (const [suffix, bytes] of [['before', baseline.bytes], ['after', frame.bytes], ['forward', patch], ['backward', undoPatch]]) fs.writeFileSync(path.join(output, `${stem}-${suffix}.png`), bytes);
        results.push({ kind: fixture.kind, name, stem, rect, width: b.width, height: b.height, channels: b.channels,
          areaFraction: rect.width * rect.height / (b.width * b.height), fullBytes: frame.bytes.length, patchBytes: patch.length,
          decodeMs, scanMs: scan, encodeMs: encode, exactPixels: true });
        await run.operation('undo-' + name, 0, () => change(run, offset, value, old));
      }
    } finally { await run.dispose(); }
  }
  fs.writeFileSync(path.join(output, 'regions.json'), JSON.stringify(results, null, 2));
  console.log(results.map(r => `${r.stem}: ${(r.areaFraction * 100).toFixed(2)}% area, ${r.patchBytes}/${r.fullBytes} bytes`).join('\n'));
})().catch(error => { console.error(error); process.exitCode = 1; });
