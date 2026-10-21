import { test } from 'node:test';
import * as assert from 'node:assert/strict';

type Region = { token: number; bounds: number[]; width: number };
const LensCache = require('../../media/preview-lens.js') as { new(): {
  cached?: { bounds: number[] }; pending?: Region;
  reset(): void;
  request(point: { x: number; y: number }, page: number[], span: number, pixelsPerPoint: number): Region | undefined;
  accept(token: number, header: { bounds: number[] }): boolean;
} };

test('magnifier overscans, reuses nearby pixels, and keeps one render pending during movement', () => {
  const cache = new LensCache(), page = [0, 0, 1000, 1000];
  const request = (x: number) => cache.request({ x, y: 500 }, page, 100, 4);
  const first = request(500)!;
  assert.deepEqual(first.bounds, [400, 400, 600, 600]);
  assert.equal(first.width, 800, 'same pixel density over twice the visible span');
  assert.equal(request(501), undefined, 'no new request on every little move');
  assert.equal(request(515), undefined, 'pointer movement does not obsolete the active request');
  assert.equal(cache.accept(first.token, { bounds: first.bounds }), true);
  for (let x = 490; x <= 520; x++) { assert.equal(request(x), undefined); }
  const second = request(540)!;
  assert.deepEqual(second.bounds, [440, 400, 640, 600]);
  assert.deepEqual(cache.cached!.bounds, first.bounds, 'old pixels stay available during prefetch');
  assert.equal(request(545), undefined);
  cache.accept(second.token, { bounds: second.bounds });
  assert.equal(request(545), undefined);
});

test('magnifier clips its coverage guard at page edges, bounds memory, and rejects closed-lens images', () => {
  const cache = new LensCache(), page = [0, 0, 1000, 1000];
  const first = cache.request({ x: 5, y: 5 }, page, 100, 10)!;
  assert.deepEqual(first.bounds, [0, 0, 200, 200]);
  assert.equal(first.width, 1024);
  cache.accept(first.token, { bounds: [0, 0, 200.0000001, 200] });
  assert.equal(cache.request({ x: 4, y: 4 }, page, 100, 10), undefined, 'no edge refresh loop');
  const second = cache.request({ x: 900, y: 900 }, page, 100, 10)!;
  cache.reset();
  const third = cache.request({ x: 5, y: 5 }, page, 100, 10)!;
  assert.notEqual(third.token, second.token);
  assert.equal(cache.accept(second.token, { bounds: second.bounds }), false);
  assert.equal(cache.cached, undefined);
  assert.equal(cache.accept(third.token, { bounds: third.bounds }), true);
});
