import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RenderFallbacks, type FallbackContext } from '../render-fallback';

const context: FallbackContext = { width: 1200, bounds: [0, 0, 600, 800], allocation: '1200:1600:16000000', complexity: 10000 };
const budget = { available: 16000000, required: 20000000, pixels: 8000000 };

test('SVG budget decisions survive minor edits, but fresh complexity can recover after simplification', () => {
  const failures = new RenderFallbacks();
  failures.reject(0, context, 'budget', budget);
  for (let i = 0; i < 20; i++) {
    failures.sourceChanged();
    assert.equal(failures.usePng(0, { ...context, complexity: 10000 - i * 10 }), true);
  }
  assert.equal(failures.usePng(0, { ...context, complexity: 6500 }), false, 'predicted allocation now fits');
  assert.equal(failures.usePng(0, context), false, 'a permitted retry removes the old decision');
});

test('SVG rejection retries when physical geometry or shared allocation changes', () => {
  for (const changed of [{ ...context, allocation: '1000:1333:16000000' }, { ...context, allocation: '1200:1600:32000000' },
    { ...context, bounds: [0, 0, 600, 900] }]) {
    const failures = new RenderFallbacks(); failures.reject(0, context, 'budget', budget);
    assert.equal(failures.usePng(0, changed), false);
  }
  const legacy = new RenderFallbacks(); legacy.reject(0, { ...context, allocation: undefined }, 'budget', budget);
  assert.equal(legacy.usePng(0, { ...context, width: 1000, allocation: undefined }), false, 'old webviews still retry on changed raster geometry');
  const failures = new RenderFallbacks();
  failures.reject(0, context, 'budget', { available: 4000000, required: 20000000, pixels: 8000000 });
  assert.equal(failures.usePng(0, { ...context, complexity: 0 }), true, 'simplification cannot shrink the pixel surface');
});

test('decode failures are distinct from persistent allocation failures and the cache stays bounded', () => {
  const failures = new RenderFallbacks(2);
  failures.reject(0, context, 'decode'); failures.reject(1, context, 'budget', budget);
  failures.sourceChanged();
  assert.equal(failures.usePng(0, context), false);
  assert.equal(failures.usePng(1, context), true);
  failures.reject(2, context, 'budget', budget); failures.usePng(1, context); failures.reject(3, context, 'budget', budget);
  assert.equal(failures.usePng(2, context), false, 'least recently used decision evicted');
  assert.equal(failures.usePng(1, context), true);
  failures.clear(1); assert.equal(failures.usePng(1, context), false);
  failures.clear(); assert.equal(failures.usePng(3, context), false);
});

test('fallback cache owns small metadata and ignores invalid contexts', () => {
  const failures = new RenderFallbacks(), bounds = [0, 0, 600, 800];
  failures.reject(0, { ...context, bounds }, 'budget', budget); bounds[2] = 1;
  assert.equal(failures.usePng(0, context), true);
  for (const invalid of [{ ...context, width: NaN }, { ...context, bounds: [0, 0, 0, 0] },
    { ...context, allocation: 'x'.repeat(257) }, { ...context, complexity: Infinity }]) {
    failures.reject(2, invalid, 'budget', budget); assert.equal(failures.usePng(2, context), false);
  }
});

test('SVG fallback follows physical allocation rather than the capped PNG base width', () => {
  const failures = new RenderFallbacks();
  const physical = { ...context, width: 1372, allocation: '1770:2504:16777216' };
  failures.reject(1, physical, 'budget', { available: 16777216, required: 18995526, pixels: 17728320 });
  for (const width of [970, 1372, 728, 970, 1372]) {
    assert.equal(failures.usePng(1, { ...physical, width }), true, 'active/neighbor raster caps cannot make the same SVG allocation fit');
  }
  assert.equal(failures.usePng(1, { ...physical, allocation: '1200:1698:16777216' }), false, 'a genuinely smaller SVG surface can retry');
});
