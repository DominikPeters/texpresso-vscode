'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validate, pairedComparison, summarizeRun, report, markdown} = require('./summarize-general-damage.cjs');
function row(variant, repeat, cost, analysis = 0) {
  return {fixture: 'math', scenario: 'small', variant, repeat, warmup: false, grid: 2, clip: [0, 0, 2, 2],
    sourceSha256: String(repeat), pixelSha256: String(repeat), stages: {'png-draw': cost, 'png-color': 0, 'png-compare': 0, 'png-encode': 0, 'text-bounds': 0},
    ...(variant === 'baseline' ? {} : {damage: {exact: true, analysisMs: analysis, renderMs: cost - analysis, changedCells: 1, totalCells: 4, directCells: variant === 'direct' ? 1 : 0, operations: 500}})};
}
const samples = [row('baseline', 1, 10), row('flat', 1, 8, 2), row('direct', 1, 5, 2),
  row('baseline', 2, 1), row('flat', 2, 9, 3), row('direct', 2, 8, 3)];
test('paired hindsight reports analysis sunk cost separately', () => {
  const result = pairedComparison(samples);
  assert.equal(result.hindsightMs.median, 3);
  assert.equal(result.hindsightWithSunkAnalysisMs.median, 4.5);
  assert.equal(result.savedMs.median, -1);
  assert.equal(result.directFasterCount, 1);
  assert.equal(result.hindsightSelectedBaseline, 1);
  assert.equal(result.medianCostSpeedup, 5.5 / 6.5);
});
test('all variants and exact source/pixel/geometry equivalence are required', () => {
  assert.equal(validate(samples, {samples: 6, exactComparisons: 4}).exactBaselinePixelComparisons, 4);
  assert.throws(() => validate(samples.slice(1), {samples: 5, exactComparisons: 4}));
  assert.throws(() => validate([...samples, samples[0]], {samples: 7, exactComparisons: 4}));
  assert.throws(() => validate(samples.map(r => r.variant === 'direct' ? {...r, pixelSha256: 'bad'} : r), {samples: 6, exactComparisons: 4}));
});
test('report excludes warmups and private provenance', () => {
  const warmups = samples.slice(0, 3).map(r => ({...r, repeat: 0, warmup: true}));
  const result = summarizeRun('test', [...warmups, ...samples], {cpu: 'test', platform: 'test', architecture: 'test', fixtures: [{id: 'math'}],
    experimentManifest: {engineRevision: 'abc', compilerConfiguration: '/private/compiler', sources: {'/private/source': 'a'.repeat(64)}}}, {samples: 9, exactComparisons: 6});
  assert.equal(result.rows[0].n, 2);
  assert.equal(result.rows.find(r => r.variant === 'direct').changedFraction.median, 0.25);
  assert.equal(result.verification.exactFullReferenceComparisons, 6);
  const document = report([result]);
  assert.doesNotMatch(JSON.stringify(document), /\/private\//);
  assert.match(markdown(document), /signature base/);
});
const {replayGate} = require('./summarize-general-damage.cjs');
function gateSequence(draws, directCost = 2, analysis = 1) {
  return draws.flatMap((draw, repeat) => [row('baseline', repeat, draw), row('flat', repeat, directCost, analysis), row('direct', repeat, directCost, analysis)]
    .map(r => ({...r, warmup: repeat === 0})));
}
test('offline gate pays cold analysis after calibration and after every bypass', () => {
  const replay = replayGate(gateSequence([10, 10, 10, 10]), 4);
  assert.deepEqual(replay.steps.map(s => s.route), ['full', 'cold', 'warm', 'warm']);
  assert.equal(replay.steps[1].costMs, 11);
  assert.equal(replay.replayTotalMs, 15);
  assert.deepEqual(replay.measuredRoutes, {full: 0, cold: 1, warm: 2});
  const periodic = replayGate(gateSequence(Array(19).fill(10)), 4);
  assert.equal(periodic.steps[16].route, 'full');
  assert.equal(periodic.steps[17].route, 'cold');
  assert.equal(periodic.steps[17].costMs, 11);
});
test('gate cannot peek at current full draw or damage before choosing route', () => {
  const original = gateSequence([2, 10, 10, 10]);
  const changed = original.map(r => r.repeat === 1 ? (r.variant === 'baseline' ? {...r, stages: {...r.stages, 'png-draw': 100}} : {...r, damage: {...r.damage, analysisMs: 99, renderMs: 50, changedCells: 4}}) : r);
  const a = replayGate(original, 4), b = replayGate(changed, 4);
  assert.equal(a.steps[1].route, 'full');
  assert.equal(b.steps[1].route, 'full');
  assert.equal(a.steps[2].route, 'cold');
  assert.equal(b.steps[2].route, 'cold');
  // Unselected direct timings and reference time do not affect baseline policy.
  const unselected = original.map(r => r.variant !== 'baseline' && r.repeat <= 1 ? {...r, damage: {...r.damage, analysisMs: 5000, renderMs: 7000, referenceMs: 999999, changedCells: 4}} : r);
  assert.deepEqual(replayGate(unselected, 4).steps.map(s => s.route), a.steps.map(s => s.route));
});
test('full damage updates are observed only after the warm route', () => {
  const rows = gateSequence([10, 10, 10, 10, 10]);
  const modified = rows.map(r => r.variant === 'direct' && r.repeat === 2 ? {...r, damage: {...r.damage, changedCells: 4, renderMs: 2}} : r);
  const replay = replayGate(modified, 4);
  assert.equal(replay.steps[2].route, 'warm');
  assert.equal(replay.steps[2].observation, 'direct-full-render-approximation');
  assert.equal(replay.steps[3].route, 'full');
  assert.equal(replay.steps[4].route, 'cold');
  assert.equal(replay.steps[4].costMs, 11);
});
