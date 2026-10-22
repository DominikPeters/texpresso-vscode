import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AutoRenderCosts } from '../auto-render-costs';

test('Auto compares render components only with sustained matching codec/phase observations', () => {
  let now = 0;
  const costs = new AutoRenderCosts(() => now);
  const record = (codec: 'png' | 'svg', patch: boolean, native: number, host = 1, webview = 1) =>
    costs.record('page0:1200:bounds:complexity', codec, patch, { native, host, webview });
  for (let i = 0; i < 5; i++) { record('png', false, 2); record('svg', true, 8); }
  assert.equal(costs.preferPng('page0:1200:bounds:complexity', true), false, 'full PNG is not a warm crop comparison');
  for (let i = 0; i < 4; i++) { record('png', true, 2); }
  assert.equal(costs.preferPng('page0:1200:bounds:complexity', true), false, 'four observations do not establish sustained separation');
  record('png', true, 2);
  assert.equal(costs.preferPng('page0:1200:bounds:complexity', true), true);
  assert.equal(costs.preferPng('page0:1600:bounds:complexity', true), false, 'raster viewport changes invalidate comparison');
  now = 30001;
  assert.equal(costs.preferPng('page0:1200:bounds:complexity', true), false, 'expired evidence cannot keep a preference');
});

test('Auto ignores small differences and outliers, counts all render components and reverses conservatively', () => {
  const costs = new AutoRenderCosts();
  const add = (png: number, svg: number) => {
    costs.record('page', 'png', true, { native: 2, host: 1, webview: png });
    costs.record('page', 'svg', true, { native: 1, host: 4, webview: svg });
  };
  for (let i = 0; i < 5; i++) { add(2, 1); }
  assert.equal(costs.preferPng('page', true), false, '1 ms gap does not change the policy');
  add(2, 200);
  assert.equal(costs.preferPng('page', true), false, 'one scheduler stall does not select PNG');
  for (let i = 0; i < 8; i++) { add(2, 10); }
  assert.equal(costs.preferPng('page', true), true, 'native export saving can be outweighed by host/browser work');
  add(10, 1);
  assert.equal(costs.preferPng('page', true), true);
  for (let i = 0; i < 8; i++) { add(10, 1); }
  assert.equal(costs.preferPng('page', true), false);
  costs.record('bad', 'png', true, { native: NaN, host: 0, webview: 0 });
  assert.equal(costs.preferPng('bad', true), false);
});
