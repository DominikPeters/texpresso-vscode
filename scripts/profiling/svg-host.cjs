#!/usr/bin/env node
/* Measure host canonicalization/diff against recorded native SVG edits.
 * npm run compile-tests
 * node scripts/profiling/svg-host.cjs artifacts/profile-svg-diff [baseline-module.js]
 * With a baseline, alternate processors each round to reduce ordering bias.
 * No engines, browser windows, network, or dependencies are started. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = path.resolve(process.argv[2] || 'artifacts/profile-svg-diff');
const processors = [ ['current', require('../../out/svg-patch.js')] ];
if (process.argv[3]) processors.unshift(['baseline', require(path.resolve(process.argv[3]))]);
const rounds = Number(process.env.TEXPRESSO_SVG_HOST_ROUNDS || 80), warmups = 10;
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10000) throw new Error('Invalid round count');
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
const results = [];
for (const kind of ['sparse', 'dense', 'packed', 'tikz']) {
  const texts = ['baseline', 'inserted', 'undo', 'font'].map(name => fs.readFileSync(path.join(root, `${kind}-${name}.svg`), 'utf8'));
  // Reference output/tree from a fresh, independently validated parse. Also
  // compare the exact normalized bytes/operations when a baseline is supplied.
  const expected = texts.map(text => processors[0][1].canonicalSvg(text, 1000));
  for (const [, processor] of processors) for (let i = 0; i < texts.length; i++) {
    const actual = processor.canonicalSvg(texts[i], 1000);
    assert.equal(actual.text, expected[i].text);
    assert.deepEqual(actual.root, processor.parseSvg(actual.text, 1000).root);
    if (i) assert.deepEqual(processor.diffSvg(expected[i - 1], actual, 'base', { maxMs: 1000 }),
      processors[0][1].diffSvg(expected[i - 1], expected[i], 'base', { maxMs: 1000 }));
  }
  const samples = new Map(processors.map(([name]) => [name, { canonical: [], diff: [], total: [] }]));
  for (let round = -warmups; round < rounds; round++) {
    for (const [name, processor] of round % 2 ? [...processors].reverse() : processors) {
      let previous;
      for (const text of texts) {
        const start = performance.now(), doc = processor.canonicalSvg(text, 1000), canonical = performance.now() - start;
        assert.ok(doc);
        const diffStart = performance.now();
        if (previous) processor.diffSvg(previous, doc, 'base', { maxMs: 1000 });
        const diff = performance.now() - diffStart;
        if (round >= 0) {
          samples.get(name).canonical.push(canonical); samples.get(name).diff.push(diff); samples.get(name).total.push(canonical + diff);
        }
        previous = doc;
      }
    }
  }
  for (const [processor, stages] of samples) results.push({ kind, processor, frames: rounds * texts.length,
    ...Object.fromEntries(Object.entries(stages).map(([stage, values]) => [stage, { medianMs: quantile(values, .5), p95Ms: quantile(values, .95) }])) });
}
process.stdout.write(JSON.stringify({ corpus: root, rounds, node: process.version, platform: process.platform, arch: process.arch, results }, null, 2) + '\n');
