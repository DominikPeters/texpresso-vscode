'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {stats, exportCost, provenance, summarize, markdown} = require('./summarize-xdv-blocks.cjs');
test('median and nearest rank p95', () => {
  assert.deepEqual(stats([6, 1, 2, 4, 3, 5]), {n: 6, median: 3.5, p95: 6});
  assert.equal(stats([undefined, NaN]), null);
});
test('export estimate excludes native verification and aggregate draw timing', () => {
  const row = {variant: 'cached', damage: {analysisMs: 2, renderMs: 3, referenceMs: 500},
    stages: {'png-draw': 505, 'png-color': 1, 'png-compare': 2, 'png-encode': 3, 'text-bounds': 4}};
  assert.equal(exportCost(row), 15);
  assert.equal(exportCost({...row, variant: 'baseline'}), 515);
});
test('provenance retains hashes and revisions without private paths', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(provenance({engineRevision: 'abcdef', compilerConfiguration: '/private/compiler',
    sources: {'/private/a': hash, 'scripts/a.c': hash}, original: '/private/manuscript'}),
  {engineRevision: 'abcdef', sources: {'scripts/a.c': hash}});
});
test('completion and candidate correctness are required before summarizing', () => {
  const row = {fixture: 'sample', scenario: 'small', variant: 'baseline', repeat: 1, warmup: false,
    sourceSha256: 'a', pixelSha256: 'b', clip: [0, 0, 1, 1], stages: {'png-draw': 2, 'png-color': 0, 'png-compare': 1, 'png-encode': 1, 'text-bounds': 0}};
  const candidate = {...row, variant: 'cached', damage: {exact: true, analysisMs: 0.5, renderMs: 0.5}};
  const metadata = {cpu: 'test', platform: 'test', architecture: 'test', fixtures: [{id: 'sample'}]};
  assert.throws(() => summarize([row, candidate], metadata, [], {samples: 3, exactComparisons: 1}));
  assert.throws(() => summarize([row, {...candidate, pixelSha256: 'wrong'}], metadata, [], {samples: 2, exactComparisons: 1}));
  const report = summarize([row, candidate], metadata, [], {samples: 2, exactComparisons: 1});
  assert.equal(report.rows[1].estimatedNativeExportMs.median, 3);
  assert.match(markdown(report), /not end-to-end or presentation/);
});
