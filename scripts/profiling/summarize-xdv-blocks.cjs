#!/usr/bin/env node
'use strict';
// Source-free summary of a completed native-only benchmark; no engine execution.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function stats(values) {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return {n: values.length, median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    p95: values[Math.ceil(values.length * 0.95) - 1]};
}
function exportCost(row) {
  const s = row.stages;
  const draw = row.variant === 'baseline' ? s['png-draw'] : row.damage?.analysisMs + row.damage?.renderMs;
  const parts = [draw, s['png-color'], s['png-compare'], s['png-encode'], s['text-bounds']];
  assert.ok(parts.every(Number.isFinite), 'Missing export-cost stage');
  return parts.reduce((sum, value) => sum + value, 0);
}
// Retain revisions and content hashes, never compiler strings or absolute paths.
function provenance(value) {
  if (!value || typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (path.isAbsolute(key) || key === 'compilerConfiguration') continue;
    if (typeof item === 'string' && (key === 'engineRevision' || /^[a-f0-9]{64}$/.test(item))) output[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const child = provenance(item); if (Object.keys(child).length) output[key] = child;
    }
  }
  return output;
}
function summarize(rows, metadata, stability, complete) {
  assert.equal(rows.length, complete.samples, 'Incomplete sample file');
  const candidates = rows.filter(row => row.variant !== 'baseline');
  assert.equal(candidates.length, complete.exactComparisons);
  const baseline = new Map(rows.filter(row => row.variant === 'baseline').map(row => [[row.fixture, row.scenario, row.repeat].join('\0'), row]));
  for (const row of candidates) {
    assert.equal(row.damage?.exact, true, 'Missing full-reference verification');
    const reference = baseline.get([row.fixture, row.scenario, row.repeat].join('\0'));
    assert.ok(reference, 'Missing baseline');
    assert.equal(row.sourceSha256, reference.sourceSha256);
    assert.equal(row.pixelSha256, reference.pixelSha256);
    assert.deepEqual(row.clip, reference.clip);
  }
  const groups = new Map();
  for (const row of rows.filter(row => !row.warmup)) {
    const key = [row.fixture, row.scenario, row.variant].join('\0');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const metrics = {
    analysisMs: r => r.damage?.analysisMs, renderMs: r => r.damage?.renderMs,
    pngDrawMs: r => r.stages['png-draw'], pngEncodeMs: r => r.stages['png-encode'],
    pngCompareMs: r => r.stages['png-compare'], compilerBurstMs: r => r.stages['compiler-burst'],
    dviDisplayListMs: r => r.stages['dvi-display-list'], estimatedNativeExportMs: exportCost,
    changedCells: r => r.damage?.changedCells, totalCells: r => r.damage?.totalCells,
    blockHits: r => r.damage?.blockHits, blockMisses: r => r.damage?.blockMisses,
    cachedOperations: r => r.damage?.cachedOperations,
  };
  return {schema: 1, scope: 'Native stage timings only; not end-to-end or presentation latency.',
    methodology: {warmupsExcluded: true, percentile: 'nearest rank p95; median averages middle pair',
      estimatedNativeExport: 'analysis + render (baseline: png-draw) + png-color + png-compare + png-encode + text-bounds; excludes full-reference/oracle render, compilation, display-list construction, IPC and webview',
      repetitions: 'Each group excludes the first of seven edits; p95 is the maximum of six samples.'},
    verification: {samples: rows.length, measuredSamples: rows.filter(r => !r.warmup).length,
      exactFullReferenceComparisons: candidates.length, exactBaselinePixelComparisons: candidates.length},
    machine: {cpu: metadata.cpu, platform: metadata.platform, architecture: metadata.architecture},
    provenance: provenance(metadata),
    fixtures: metadata.fixtures.map(f => ({id: f.id, focusPage:f.focusPage, sourceSha256: f.sourceSha256, originalSha256: f.originalSha256})),
    rows: [...groups.values()].map(group => ({fixture: group[0].fixture, scenario: group[0].scenario, variant: group[0].variant,
      n: group.length, ...Object.fromEntries(Object.entries(metrics).map(([name, fn]) => [name, stats(group.map(fn))]))})),
    syntacticWarning: 'Exact XDV instruction or balanced PUSH/POP matches are opportunity measurements only; incoming interpreter state, resource identity, paint order and pixel reuse are not validated by syntactic equality.',
    xdv: stability.flatMap(item => item.comparison.pages.map(p => ({fixture: item.fixture, scenario: item.scenario,
      page: p.page, oldInstructions: p.oldInstructions, newInstructions: p.newInstructions,
      instructionDiff: p.instructionDiff, balancedBlocks: p.balancedBlocks,
      balancedByteCoverageFraction: p.newBytes ? p.balancedBlocks?.matchedNewByteCoverage / p.newBytes : null,
      pdfImage: p.specials?.['pdf-image'], instructionDiffMs: p.timingsMs?.instructionDiff,
      totalComparisonMs: item.comparison.timingsMs.total, rawByteDiff: item.comparison.rawByteDiff}))),
    limitations: [
      'Research-only immutable imported-PDF fingerprint cache, not a general XDV subtree or raster cache.',
      'The cache key includes resolved document identity, page and final transform. A moved block changes the key and conservatively invalidates all cells.',
      'Full pixel comparisons validate these finite sampled edits; they are not a correctness proof for arbitrary documents.',
      'Compiler-burst is a single instrumented burst, not total compilation latency; the harness does not issue edit-prewarm commands.',
      'Fixed viewport, zoom and color settings; no scrolling, webview scheduling, presentation latency, revision age or peak-memory measurements.',
      'Cache lookup still replays MuPDF display-list operations; hits avoid repeated detailed fingerprint analysis, not all display-list traversal.',
      'Fixed variant order (baseline, flat, uncached, cached); small samples from one machine; reference checks perturb cache/CPU behavior, even though their timed work is excluded from the estimated cost.',
    ],
    reproduction: [
      'node scripts/profiling/build-damage-engine.cjs',
      'node scripts/profiling/make-xdv-fixture.cjs artifacts/xdv-fixture',
      'node scripts/profiling/build-xdv-engine.cjs',
      'node scripts/profiling/xdv-block-benchmark.cjs <private-corpus-config.json> <baseline-engine> <flat-engine> <xdv-engine> artifacts/xdv-comparison',
      'node scripts/profiling/xdv-block-benchmark.cjs artifacts/xdv-fixture/adversarial.json <baseline-engine> <flat-engine> <xdv-engine> artifacts/xdv-adversarial',
      'node scripts/profiling/summarize-xdv-blocks.cjs artifacts/xdv-comparison docs/profiling/2026-11-17-xdv-blocks artifacts/xdv-adversarial',
    ]};
}
const number = value => Number.isFinite(value) ? value.toFixed(3) : '—';
function markdown(report) {
  const pair = metric => metric ? `${number(metric.median)} / ${number(metric.p95)}` : '—';
  const find=(fixture,scenario,variant)=>report.rows.find(r=>r.fixture===fixture&&r.scenario===scenario&&r.variant===variant);
  const flat=find('graphic-slides','small','flat'),cached=find('graphic-slides','small','cached'),baseline=find('graphic-slides','small','baseline');
  const conclusions=flat&&cached&&baseline?[
    '## Findings and next direction','',
    `On the real slide title edit, flat analysis took ${number(flat.analysisMs.median)} ms; cached PDF leaves took ${number(cached.analysisMs.median)} ms. Estimated native export fell from ${number(baseline.estimatedNativeExportMs.median)} ms with the unchanged engine to ${number(cached.estimatedNativeExportMs.median)} ms.`,
    '',`Page display-list construction still took ${number(cached.dviDisplayListMs.median)} ms separately. The export result therefore is not a claim of a ${number(cached.estimatedNativeExportMs.median)} ms typing-to-screen latency. Reflow that moves the expensive figure still pays its rasterization cost.`,
    '',
    'The promising direction is reuse of explicitly identified immutable drawing blocks. General byte or PUSH/POP matching should remain a diagnostic: it does not establish state/resource equivalence, and large reflow diffs can themselves be costly. Cheap pages and direct TikZ do not justify enabling this imported-PDF cache universally.',
    '',
    'The next experiment should test reusing imported-PDF interpretation/display-list output, which targets the remaining construction cost, with bounded memory and the same full-reference checks. Further raster reuse for moved figures needs separate compositing and subpixel-correctness work.',
    '',
    'The cache passed replacement, fractional placement/scaling, repeated imports, nested optional-content layers and unsupported-image fallback in the generated fixtures. Registry tests cover invalidation, aborts, forged tags and eviction. Real same-path file reloads, malformed PDF exceptions, varied themes and arbitrary transparency/clip combinations still need integration coverage before production adoption.',
    '',
    'XDV summaries compare snapshot 0 (original) with snapshot 1 (first edit). Snapshot 2 returns to a short edit in alternating reflow tests and must not be used to measure reflow. A regression test covers this selection.',
    '',
  ]:[];
  const lines = ['# XDV imported-PDF block experiment', '', report.scope, '',
    `Machine: ${report.machine.cpu}, ${report.machine.platform}/${report.machine.architecture}.`, '',
    `${report.verification.exactFullReferenceComparisons} full-reference comparisons and ${report.verification.exactBaselinePixelComparisons} baseline pixel comparisons passed, including warmups. ${report.verification.measuredSamples} measured samples remain after warmup exclusion.`, '',
    'Times below are median / p95 in milliseconds. p95 uses nearest rank; with six measured edits it is the maximum. Native export is an estimate from stage sums, excluding verification renders and compiler/display-list work.', '',
    ...conclusions,
    '| Fixture | Edit | Variant | Analysis | Render | PNG encode | PNG compare | Compiler burst | DVI list | Native export estimate |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const r of report.rows) lines.push(`| ${r.fixture} | ${r.scenario} | ${r.variant} | ${pair(r.analysisMs)} | ${pair(r.variant === 'baseline' ? r.pngDrawMs : r.renderMs)} | ${pair(r.pngEncodeMs)} | ${pair(r.pngCompareMs)} | ${pair(r.compilerBurstMs)} | ${pair(r.dviDisplayListMs)} | ${pair(r.estimatedNativeExportMs)} |`);
  lines.push('', '## Syntactic XDV stability', '', report.syntacticWarning, '',
    '| Fixture | Edit | Instructions old / new | Instruction distance | Balanced byte coverage | PDF image matches / new | Diff ms | Total compare ms |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of report.xdv) lines.push(`| ${r.fixture} | ${r.scenario} | ${r.oldInstructions} / ${r.newInstructions} | ${r.instructionDiff?.complete ? r.instructionDiff.distance : 'incomplete'} | ${number(r.balancedByteCoverageFraction * 100)}% | ${r.pdfImage?.matchedNew ?? 0} / ${r.pdfImage?.new ?? 0} | ${number(r.instructionDiffMs)} | ${number(r.totalComparisonMs)} |`);
  lines.push('', '## Limits', '', ...report.limitations.map(s => '- ' + s), '', '## Reproduction', '', '```sh', ...report.reproduction, '```', '', 'Revision and input/binary hashes are retained in the accompanying JSON; private paths, manuscripts and compiler configuration strings are omitted.', '');
  return lines.join('\n');
}
function main() {
  const [input = 'artifacts/xdv-comparison', output = 'docs/profiling/2026-11-17-xdv-blocks'] = process.argv.slice(2);
  const directories=[input,...process.argv.slice(4)];
  const runs=directories.map(directory=>{
    const json=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
    const complete=json('complete.json');
    const rows=fs.readFileSync(path.join(directory,'samples.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    return {rows,complete,metadata:json('metadata.json'),stability:json('xdv-stability.json')};
  });
  const metadata={...runs[0].metadata,fixtures:runs.flatMap(run=>run.metadata.fixtures),
    harnessesSha256:Object.fromEntries(runs.map((run,index)=>['run'+index,run.metadata.harnessSha256]))};
  for(const run of runs) {
    assert.equal(run.metadata.experimentManifest.experimentBinarySha256,metadata.experimentManifest.experimentBinarySha256,'Combining different candidate binaries');
    assert.equal(run.metadata.flatManifest.experimentBinarySha256,metadata.flatManifest.experimentBinarySha256,'Combining different flat binaries');
  }
  const complete={samples:runs.reduce((n,r)=>n+r.complete.samples,0),exactComparisons:runs.reduce((n,r)=>n+r.complete.exactComparisons,0)};
  const report=summarize(runs.flatMap(r=>r.rows),metadata,runs.flatMap(r=>r.stability),complete);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(output + '.md', markdown(report));
  console.log(`${output}.{json,md}`);
}
module.exports = {stats, exportCost, provenance, summarize, markdown};
if (require.main === module) main();
