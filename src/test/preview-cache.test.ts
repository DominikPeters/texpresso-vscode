import { test } from 'node:test';
import * as assert from 'node:assert/strict';
const ImageCache = require('../../media/preview-cache.js');

test('decoded image cache enforces byte and entry budgets with LRU disposal and explicit oversized rejection', () => {
  const disposed: string[] = [];
  const cache = new ImageCache((value: string) => disposed.push(value), 100, 2);
  assert.equal(cache.put('a', 'first', 40), true); cache.put('b', 'second', 40);
  assert.equal(cache.get('a'), 'first'); cache.put('c', 'third', 40);
  assert.equal(cache.has('b'), false); assert.deepEqual(disposed, ['second']);
  assert.equal(cache.put('big', 'large', 101), false); assert.equal(cache.has('big'), false);
  assert.equal(cache.put('invalid', 'invalid', NaN), false);
  cache.put('d', 'fourth', 70);
  assert.deepEqual(cache.keys(), ['d']); assert.equal(cache.bytes, 70);
  cache.clear(); assert.equal(cache.bytes, 0); assert.deepEqual(cache.keys(), []);
  assert.deepEqual(disposed, ['second', 'first', 'third', 'fourth']);
});

test('moving a retained SVG between cache identities does not dispose its live layer', () => {
  const disposed: object[] = [], value = {};
  const cache = new ImageCache((entry: object) => disposed.push(entry), 100, 2);
  cache.put('before', value, 40); assert.equal(cache.take('before'), value);
  assert.equal(cache.bytes, 0); assert.deepEqual(disposed, []);
  cache.put('after', value, 40); cache.clear(); assert.deepEqual(disposed, [value]);
});
