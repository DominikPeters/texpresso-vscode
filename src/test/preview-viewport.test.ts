import { test } from 'node:test';
import * as assert from 'node:assert/strict';

type Rect = { left: number; top: number; width: number; height: number };
type Region = { token: number; bounds: number[]; width: number };
const { wheelFactor, scrollCorrection, rasterWidth, DetailCache } = require('../../media/preview-viewport.js') as {
  wheelFactor(delta: number, mode: number): number;
  scrollCorrection(before: Rect, after: Rect, origin: { x: number; y: number }, point?: { x: number; y: number }): { x: number; y: number };
  rasterWidth(bounds: number[], cssWidth: number, dpr: number): number;
  DetailCache: { new(): {
    cached?: { bounds: number[]; width: number }; pending?: Region;
    reset(): void;
    request(page: number[], rect: Rect, viewport: { left: number; top: number; right: number; bottom: number },
      dpr: number, baseWidth: number): Region | undefined;
    accept(token: number, header: { bounds: number[]; width: number }): boolean;
  } };
};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('pinch scale follows PDF.js delta mapping independently of event frequency, including tiny deltas', () => {
  near(wheelFactor(-10, 0), Math.exp(0.1));
  near(Array.from({ length: 100 }, () => wheelFactor(-0.1, 0)).reduce((a, b) => a * b, 1), wheelFactor(-10, 0));
  near(wheelFactor(-0.01, 0) * wheelFactor(0.01, 0), 1);
  assert.ok(wheelFactor(-0.01, 0) > 1, 'small finger movements are not rounded away');
  assert.equal(wheelFactor(0, 0), 1);
  near(wheelFactor(-1, 1), wheelFactor(-10, 0));
  near(wheelFactor(-1, 2), wheelFactor(-100, 0));
});

test('zoom anchoring includes centered page offsets, existing scroll, and viewport origin', () => {
  const before = { left: 100, top: -450, width: 600, height: 800 };
  const after = { left: -20, top: -450, width: 1200, height: 1600 };
  const origin = { x: 320, y: 260 };
  const delta = scrollCorrection(before, after, origin);
  near((origin.x - (after.left - delta.x)) / after.width, (origin.x - before.left) / before.width);
  near((origin.y - (after.top - delta.y)) / after.height, (origin.y - before.top) / before.height);
  assert.deepEqual(scrollCorrection(before, before, origin), { x: 0, y: 0 });
});

test('a fixed gesture anchor survives browser rounding of hundreds of subpixel scroll adjustments', () => {
  const origin = { x: 420, y: 300 };
  let width = 1600, left = 200, top = 400;
  const point = { x: (origin.x + left) / width, y: (origin.y + top) / (width * 4 / 3) };
  for (let i = 0; i < 200; i++) {
    const before = { left: -left, top: -top, width, height: width * 4 / 3 };
    width *= wheelFactor(-0.01, 0);
    const after = { left: -left, top: -top, width, height: width * 4 / 3 };
    const correction = scrollCorrection(before, after, origin, point);
    left = Math.round(left + correction.x); top = Math.round(top + correction.y);
  }
  assert.ok(Math.abs(point.x * width - left - origin.x) <= 0.5);
  assert.ok(Math.abs(point.y * width * 4 / 3 - top - origin.y) <= 0.5);
});

test('page rasters use physical screen pixels and obey the native pixel/axis budget at any zoom', () => {
  const page = [0, 0, 600, 800];
  assert.equal(rasterWidth(page, 700, 1), 700);
  assert.equal(rasterWidth(page, 700, 2), 1400);
  assert.equal(rasterWidth(page, 700.25, 2), 1401);
  for (const bounds of [page, [0, 0, 100, 10000], [0, 0, 10000, 100]]) {
    for (const dpr of [1, 1.5, 2, 3]) {
      const width = rasterWidth(bounds, 4000, dpr), height = width * bounds[3] / bounds[2];
      assert.ok(width * height <= 4000000);
      assert.ok(width <= 4096 && height <= 8192);
    }
  }
  assert.equal(rasterWidth(page, 4000, 2), rasterWidth(page, 8000, 2), 'no redundant full-page renders above the budget');
});

test('high-DPI detail crops overscan the viewport, reuse small scrolls, and refresh at a higher screen density', () => {
  const cache = new DetailCache(), page = [0, 0, 600, 800];
  const rect = { left: -300, top: -600, width: 2400, height: 3200 };
  const view = { left: 0, top: 0, right: 600, bottom: 500 };
  const first = cache.request(page, rect, view, 2, 1732)!;
  assert.ok(first.bounds[0] < 75 && first.bounds[2] > 225, 'horizontal overscan');
  assert.ok(first.bounds[1] < 150 && first.bounds[3] > 275, 'vertical overscan');
  near(first.width / (first.bounds[2] - first.bounds[0]), 8);
  assert.equal(cache.request(page, rect, view, 2, 1732), undefined, 'single in-flight crop');
  cache.accept(first.token, first);
  assert.equal(cache.request(page, { ...rect, top: -610 }, view, 2, 1732), undefined);
  assert.ok(cache.request(page, rect, view, 3, 1732), 'moving to a denser display requests sharper pixels');
});

test('detail memory stays bounded on a huge display and an accepted image does not cause a render loop', () => {
  const cache = new DetailCache(), page = [0, 0, 600, 800];
  const rect = { left: 0, top: 0, width: 2400, height: 3200 };
  const view = { left: 0, top: 0, right: 2400, bottom: 2000 };
  const first = cache.request(page, rect, view, 3, 1732)!;
  const w = first.bounds[2] - first.bounds[0], h = first.bounds[3] - first.bounds[1];
  assert.ok(first.width * first.width * h / w <= 4000000);
  cache.accept(first.token, { ...first, width: Math.ceil(first.width * 0.999) });
  assert.equal(cache.request(page, rect, view, 3, 1732), undefined);
  cache.reset();
  assert.equal(cache.accept(first.token, first), false, 'invalidated images cannot reappear');
  assert.equal(cache.request(page, { ...rect, width: 600, height: 800 }, view, 1, 600), undefined, 'no detail needed for a sharp base image');
});
