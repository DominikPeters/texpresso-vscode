#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {stats, provenance, exportCost} = require('./summarize-xdv-blocks.cjs');
const key = r => [r.fixture, r.scenario, r.repeat].join('\0');
function validate(rows, complete) {
  assert.equal(rows.length, complete.samples, 'Incomplete sample file');
  const base = new Map();
  const seen = new Set();
  for (const r of rows) {
    const id = key(r) + '\0' + r.variant;
    assert.ok(!seen.has(id), 'Duplicate sample'); seen.add(id);
    assert.ok(['baseline', 'flat', 'direct'].includes(r.variant), 'Unknown variant');
    if (r.variant === 'baseline') base.set(key(r), r);
  }
  const candidates = rows.filter(r => r.variant !== 'baseline');
  assert.equal(candidates.length, complete.exactComparisons, 'Comparison count mismatch');
  for (const r of candidates) {
    assert.equal(r.damage?.exact, true, 'Missing reference verification');
    const b = base.get(key(r)); assert.ok(b, 'Missing baseline');
    assert.equal(r.sourceSha256, b.sourceSha256); assert.equal(r.pixelSha256, b.pixelSha256);
    assert.deepEqual(r.clip, b.clip); assert.equal(r.grid, b.grid);
  }
  for (const b of base.values()) for (const v of ['flat', 'direct'])
    assert.ok(seen.has(key(b) + '\0' + v), 'Missing paired variant');
  return {samples: rows.length, exactFullReferenceComparisons: candidates.length, exactBaselinePixelComparisons: candidates.length};
}
function pairedComparison(rows) {
  const base = new Map(rows.filter(r => r.variant === 'baseline').map(r => [key(r), r]));
  const pairs = rows.filter(r => r.variant === 'direct').map(r => {
    const baselineMs = exportCost(base.get(key(r))), directMs = exportCost(r), analysisMs = r.damage.analysisMs;
    return {baselineMs, directMs, savedMs: baselineMs - directMs,
      hindsightMs: Math.min(baselineMs, directMs), hindsightWithSunkAnalysisMs: Math.min(baselineMs + analysisMs, directMs)};
  });
  assert.ok(pairs.length, 'No direct pairs');
  const metrics = Object.fromEntries(Object.keys(pairs[0]).map(k => [k, stats(pairs.map(p => p[k]))]));
  return {pairs: pairs.length, ...metrics,
    medianCostSpeedup: metrics.baselineMs.median / metrics.directMs.median,
    totalCostSpeedup: pairs.reduce((s, p) => s + p.baselineMs, 0) / pairs.reduce((s, p) => s + p.directMs, 0),
    directFasterCount: pairs.filter(p => p.directMs < p.baselineMs).length,
    hindsightSelectedBaseline: pairs.filter(p => p.baselineMs <= p.directMs).length};
}
// Offline counterfactual replay. Only the chosen route's observations update
// policy state; current full-draw/damage metrics never choose that same frame.
function replayGate(sequence, thresholdMs, probeEvery = 16) {
  assert.ok(Number.isFinite(thresholdMs) && thresholdMs >= 0);
  const baselines = sequence.filter(r => r.variant === 'baseline').sort((a, b) => a.repeat - b.repeat);
  const directs = new Map(sequence.filter(r => r.variant === 'direct').map(r => [r.repeat, r]));
  assert.ok(baselines.length && baselines[0].repeat === 0 && baselines[0].warmup,
    'Replay requires repeat0 warmup calibration');
  let lastFullDraw, signatureBase = false;
  const steps = [];
  for (let index = 0; index < baselines.length; index++) {
    const b = baselines[index], d = directs.get(b.repeat);
    assert.ok(d, 'Missing direct counterpart');
    const previousFullDrawMs = lastFullDraw;
    let route;
    if (index === 0 || lastFullDraw <= thresholdMs || index % probeEvery === 0) route = 'full';
    else route = signatureBase ? 'warm' : 'cold';
    let costMs, observation;
    if (route === 'full') {
      costMs = exportCost(b); signatureBase = false;
      lastFullDraw = b.stages['png-draw']; observation = 'baseline-png-draw';
    } else if (route === 'cold') {
      // Bypass discarded the prior signature base. Re-establishing it requires
      // fingerprint analysis and a full render, even if an offline direct row
      // happened to have retained a usable base in its separate native run.
      costMs = exportCost(b) + d.damage.analysisMs; signatureBase = true;
      lastFullDraw = b.stages['png-draw']; observation = 'cold-full-png-draw';
    } else {
      costMs = exportCost(d);
      if (d.damage.changedCells === d.damage.totalCells && d.damage.totalCells > 0) {
        lastFullDraw = d.damage.renderMs;
        observation = 'direct-full-render-approximation';
      } else observation = 'none';
    }
    assert.ok(Number.isFinite(costMs) && Number.isFinite(lastFullDraw));
    steps.push({repeat: b.repeat, warmup: b.warmup, route, previousFullDrawMs,
      observation, observedFullDrawMs: observation === 'none' ? undefined : lastFullDraw,
      baselineMs: exportCost(b), costMs, savedMs: exportCost(b) - costMs});
  }
  const measured = steps.filter(s => !s.warmup);
  const counts = list => Object.fromEntries(['full', 'cold', 'warm'].map(route => [route, list.filter(s => s.route === route).length]));
  const baselineTotalMs = measured.reduce((sum, s) => sum + s.baselineMs, 0);
  const replayTotalMs = measured.reduce((sum, s) => sum + s.costMs, 0);
  return {thresholdMs, probeEvery, measuredSamples: measured.length,
    baselineMs: stats(measured.map(s => s.baselineMs)), replayMs: stats(measured.map(s => s.costMs)),
    savedMs: stats(measured.map(s => s.savedMs)), baselineTotalMs, replayTotalMs,
    totalSavedMs: baselineTotalMs - replayTotalMs,
    totalCostSpeedup: baselineTotalMs / replayTotalMs,
    routesIncludingCalibration: counts(steps), measuredRoutes: counts(measured), steps};
}
function summarizeRun(id, rows, metadata, complete) {
  const verification = validate(rows, complete), measured = rows.filter(r => !r.warmup), groups = new Map();
  const metrics = {
    analysisMs: r => r.damage?.analysisMs, renderMs: r => r.variant === 'baseline' ? r.stages['png-draw'] : r.damage?.renderMs,
    pngCompareMs: r => r.stages['png-compare'], pngEncodeMs: r => r.stages['png-encode'],
    estimatedNativeExportMs: exportCost, compilerBurstMs: r => r.stages['compiler-burst'],
    dviDisplayListMs: r => r.stages['dvi-display-list'], directCells: r => r.damage?.directCells,
    changedFraction: r => r.damage?.totalCells ? r.damage.changedCells / r.damage.totalCells : undefined,
    operations: r => r.damage?.operations,
  };
  for (const r of measured) {
    const k = [r.fixture, r.scenario, r.variant].join('\0');
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r);
  }
  const fixtureIds = [...new Set(measured.map(r => r.fixture))];
  return {id, verification, machine: {cpu: metadata.cpu, platform: metadata.platform, architecture: metadata.architecture},
    provenance: provenance(metadata), fixtures: metadata.fixtures.map(f => ({id: f.id, sourceSha256: f.sourceSha256, originalSha256: f.originalSha256,
      ...Object.fromEntries(['viewportPoint', 'clipOffset', 'theme'].filter(k => Array.isArray(f[k]) && f[k].flat(Infinity).every(Number.isFinite)).map(k => [k, f[k]]))})),
    rows: [...groups.values()].map(g => ({fixture: g[0].fixture, scenario: g[0].scenario, variant: g[0].variant, n: g.length, grid: g[0].grid, clip: g[0].clip,
      ...Object.fromEntries(Object.entries(metrics).map(([name, fn]) => [name, stats(g.map(fn))]))})),
    gateSensitivity: fixtureIds.flatMap(fixture => {
      const all = rows.filter(r => r.fixture === fixture);
      return [...new Set(all.map(r => r.scenario))].flatMap(scenario =>
        [4, 8, 16].map(threshold => ({fixture, scenario,
          ...replayGate(all.filter(r => r.scenario === scenario), threshold)})));
    }),
    paired: fixtureIds.flatMap(fixture => {
      const selected = measured.filter(r => r.fixture === fixture);
      return [{fixture, scenario: 'all', ...pairedComparison(selected)},
        ...[...new Set(selected.map(r => r.scenario))].map(scenario => ({fixture, scenario, ...pairedComparison(selected.filter(r => r.scenario === scenario))}))];
    })};
}
function report(runs) {
  return {schema: 1, scope: 'Native-only structural damage experiment on real papers/slides and generated direct-TikZ pages; not end-to-end or presentation latency.',
    methodology: {warmupsExcluded: true, percentile: 'nearest rank p95; six measured samples per edit group, so p95 is the maximum',
      estimatedExport: 'analysis + render (baseline: png-draw) + png-color + png-compare + png-encode + text-bounds; excludes oracle/full-reference work, compiler, display-list construction, IPC and webview',
      direct: 'Per-cell temporary pixmap avoidance; no imported-PDF fingerprint cache in this experiment.',
      savings: 'Paired baseline minus direct export milliseconds; positive saves time. Speedups are baseline/direct ratios.',
      hindsight: 'min(baseline, direct), an unattainable selection bound with exact future costs and maintained signature base.',
      hindsightWithSunkAnalysis: 'min(baseline + direct analysis, direct): shows that analysis is already paid if fallback is decided after damage analysis. Still an optimistic, non-deployable bound.',
      gateReplay: 'OFFLINE counterfactual, not a native implementation. Repeat0 calibrates baseline png-draw and discards signature base. Later choose full when last observed full draw <= threshold or every16th sample; full discards signature base. Otherwise cold costs baseline export + direct analysis, re-establishes base and observes baseline png-draw; warm costs direct export and retains base. Warm all-cell redraw observes direct render as approximate full paint (including clone/clear overhead). Selection uses prior observations only; no oracle/reference timing.',
      gateReplayLimits: 'Warmups train state but do not enter cost summaries. Seven-edit sequences are short; repeated calibration and cold-start cost are paid. Replay does not measure native policy overhead, signature memory, presentation or revision age; separate-run timings are counterfactual estimates.'},
    policyLimitations: [
      'These measurements determine whether gains occur on the sampled workloads; they do not establish a universally beneficial damage path.',
      'A per-frame minimum requires knowing both rendering costs before choosing and is not an implementable policy.',
      'Bypassing damage analysis invalidates the signature base for subsequent revisions; a policy needs cheap probes, signature maintenance/rebuild costs, or partial feedback.',
      'Oracle verification work is excluded from sums but perturbs CPU and cache behavior. Six samples, one machine, fixed viewport and zoom.',
      'Pixel equality on sampled edits is not a correctness proof for arbitrary clipping, transparency, masks, moved content or resources.',
      'No presentation latency, revision age, scrolling, peak memory or general user workload distribution is measured.',
    ], runs,
    reproduction: ['node scripts/profiling/build-damage-engine.cjs',
      'node scripts/profiling/general-damage.cjs <private-corpus-config.json> <baseline-engine> <damage-engine> <fresh-output-directory>',
      'node scripts/profiling/summarize-general-damage.cjs <completed-output-directory> [<another-completed-directory>] --output docs/profiling/2026-11-17-general-damage']};
}
const number = n => Number.isFinite(n) ? n.toFixed(3) : '—';
const pair = s => s ? `${number(s.median)} / ${number(s.p95)}` : '—';
function markdown(r) {
  const lines = ['# General structural damage measurements', '', r.scope, '',
    'Timing cells are median / p95 milliseconds. Warmups are excluded. Render for baseline is png-draw; candidates report render without the oracle. Native export estimates include analysis, render, color, compare, encode and text bounds.', ''];
  for (const run of r.runs) {
    lines.push(`## ${run.id}`, '', `Machine: ${run.machine.cpu}, ${run.machine.platform}/${run.machine.architecture}. ${run.verification.exactFullReferenceComparisons} full-reference and ${run.verification.exactBaselinePixelComparisons} baseline pixel comparisons passed, including warmups.`, '',
      '| Fixture | Edit | Variant | Grid / clip | Analysis | Render | PNG compare | PNG encode | Export estimate | Changed cells median | Direct cells median | Operations median |',
      '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const g of run.rows) lines.push(`| ${g.fixture} | ${g.scenario} | ${g.variant} | ${g.grid} / [${g.clip.join(', ')}] | ${pair(g.analysisMs)} | ${pair(g.renderMs)} | ${pair(g.pngCompareMs)} | ${pair(g.pngEncodeMs)} | ${pair(g.estimatedNativeExportMs)} | ${g.changedFraction ? number(g.changedFraction.median * 100) + '%' : '—'} | ${number(g.directCells?.median)} | ${number(g.operations?.median)} |`);
    lines.push('', 'Offline conservative cost-gate replay: thresholds use only previously observed full native draw cost. Calibration warmups train state but are excluded below. This is counterfactual arithmetic, not a native policy or presentation measurement. Routes are measured full / cold / warm counts; cold explicitly pays fresh analysis plus baseline full export.', '',
      '| Fixture | Edit | Threshold ms | Replay median ms | Baseline total ms | Replay total ms | Saved total ms | Saved median ms | Full / cold / warm |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const g of run.gateSensitivity) lines.push(`| ${g.fixture} | ${g.scenario} | ${g.thresholdMs} | ${number(g.replayMs?.median)} | ${number(g.baselineTotalMs)} | ${number(g.replayTotalMs)} | ${number(g.totalSavedMs)} | ${number(g.savedMs?.median)} | ${g.measuredRoutes.full} / ${g.measuredRoutes.cold} / ${g.measuredRoutes.warm} |`);
    lines.push('', 'Replay full draws discard the signature base. The next enabled sample therefore pays a cold start. A warm update that changes every cell contributes an approximate full-render observation (clone/clear overhead included). Probes occur every 16 samples, beyond these seven-edit sequences. No reference/oracle timing drives selection.', '');
    lines.push('', 'Paired comparisons below show median export costs and paired median milliseconds saved. Hindsight columns use exact measured costs and cannot be deployed as a selection policy.', '',
      '| Fixture | Edit | Baseline ms | Direct ms | Median-cost speedup | Saved ms | Hindsight minimum ms | Hindsight with sunk analysis ms | Direct wins |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const p of run.paired) lines.push(`| ${p.fixture} | ${p.scenario} | ${number(p.baselineMs.median)} | ${number(p.directMs.median)} | ${number(p.medianCostSpeedup)}× | ${number(p.savedMs.median)} | ${number(p.hindsightMs.median)} | ${number(p.hindsightWithSunkAnalysisMs.median)} | ${p.directFasterCount}/${p.pairs} |`);
  }
  lines.push('', '## Interpretation limits', '', ...r.policyLimitations.map(s => '- ' + s), '',
    'Damage analysis is a sunk cost once performed. Falling back then costs analysis plus the baseline render path; skipping it also loses the signature base. Cheap probes or partial feedback and explicit base maintenance need measurement before any selection policy is proposed.', '',
    '## Reproduction', '', '```sh', ...r.reproduction, '```', '',
    'The accompanying JSON retains revisions and hashes, with absolute source paths and compiler configuration strings omitted.', '');
  return lines.join('\n');
}
function main() {
  const args = process.argv.slice(2), index = args.indexOf('--output');
  let output = 'docs/profiling/2026-11-17-general-damage';
  if (index >= 0) {assert.ok(args[index + 1], '--output requires a prefix'); output = args[index + 1]; args.splice(index, 2);}
  assert.ok(args.length, 'Supply one or more completed run directories');
  const ids = new Set();
  const runs = args.map(dir => {
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const complete = read('complete.json'), id = path.basename(path.resolve(dir));
    assert.ok(!ids.has(id), 'Run directory names must be unique'); ids.add(id);
    const rows = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return summarizeRun(id, rows, read('metadata.json'), complete);
  });
  const result = report(runs); fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output + '.json', JSON.stringify(result, null, 2) + '\n'); fs.writeFileSync(output + '.md', markdown(result));
  console.log(`${output}.{json,md}`);
}
module.exports = {validate, pairedComparison, replayGate, summarizeRun, report, markdown};
if (require.main === module) main();
