import { test } from 'node:test';
import * as assert from 'node:assert/strict';

type Rect = { left: number; top: number; width: number; height: number };
type Region = { token: number; bounds: number[]; width: number };
const { wheelFactor, scrollCorrection, syncScrollCorrection, rasterWidth, DetailCache } = require('../../media/preview-viewport.js') as {
  wheelFactor(delta: number, mode: number): number;
  scrollCorrection(before: Rect, after: Rect, origin: { x: number; y: number }, point?: { x: number; y: number }): { x: number; y: number };
  syncScrollCorrection(point: { x: number; y: number }, viewport: Rect, automatic?: boolean): { x: number; y: number };
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


test('SyncTeX leaves visible targets still and rejects small margin corrections while revealing offscreen targets', () => {
  const viewport = { left: 100, top: 50, width: 800, height: 600 };
  for (const y of [250, 251, 249, 400, 600, 603]) {
    assert.deepEqual(syncScrollCorrection({ x: 300, y }, viewport), { x: 0, y: 0 });
  }
  // Bottom comfortable edge is 602px; 1–4px drift must not recenter it.
  assert.deepEqual(syncScrollCorrection({ x: 300, y: 606 }, viewport), { x: 0, y: 0 });
  assert.deepEqual(syncScrollCorrection({ x: 300, y: 700 }, viewport), { x: 0, y: 350 });
  assert.deepEqual(syncScrollCorrection({ x: 40, y: 350 }, viewport), { x: -84, y: 0 });
  assert.deepEqual(syncScrollCorrection({ x: 960, y: 350 }, viewport), { x: 84, y: 0 });
  assert.deepEqual(syncScrollCorrection({ x: 4, y: 5 }, { left: 0, top: 0, width: 10, height: 10 }), { x: 0, y: 0 });
});

test('automatic SyncTeX preserves horizontal position even for offscreen targets; explicit jumps reveal only when needed', () => {
  const viewport = { left: 100, top: 50, width: 800, height: 600 };
  for (const x of [96, 100, 112, 888, 900, 904]) { assert.equal(syncScrollCorrection({ x, y: 300 }, viewport, true).x, 0); }
  assert.deepEqual(syncScrollCorrection({ x: 112, y: 700 }, viewport, true), { x: 0, y: 350 });
  for (const x of [-500, 80, 920, 2000]) { assert.equal(syncScrollCorrection({ x, y: 300 }, viewport, true).x, 0); }
  assert.equal(syncScrollCorrection({ x: 112, y: 300 }, viewport).x, 0, 'explicit jumps also leave visible targets still');
});

// --- Page grids and surfaces --------------------------------------------
type Budget = { whole: number; clip: number; max: number };
const surface = require('../../media/preview-viewport.js') as {
  SURFACE_CELL: number;
  gridHeight(bounds: number[], gridWidth: number): number;
  surfaceBudget(viewportPixels: number, maxPixels: number): number;
  planSurface(grid: number[], visible: number[] | undefined, budget: Budget, current?: number[], cell?: number): number[] | undefined;
  visibleGridRect(grid: number[], page: Rect, viewport: { left: number; top: number; right: number; bottom: number }): number[] | undefined;
  surfacePlacement(grid: number[], clip: number[]): { left: number; top: number; width: number; height: number };
  PageLayout: { new(): { rects: (Rect & { bounds: number[] })[]; offsets: Float64Array; maxWidth: number;
    setBounds(page: number, bounds: number[]): boolean; grid(bounds: number[], cssWidth: number): number[];
    configure(options: object): void } };
};
const pixels = (r: number[]) => (r[2] - r[0]) * (r[3] - r[1]);

test('grid rows follow the engine rule, without an extra row from single-precision page sizes', () => {
  const a4 = [0, 0, 595.276, 841.89];
  // 841.89/595.276 is a hair above 99/70 in single precision.
  for (let width = 70; width <= 7000; width += 70) { assert.equal(surface.gridHeight(a4, width), width / 70 * 99); }
  assert.equal(surface.gridHeight(a4, 2240), 3168);
  assert.equal(surface.gridHeight([0, 0, 612, 791.999939], 2000), 2589);
  assert.equal(surface.gridHeight([-72.27, -72.27, 239.03, 135.63], 1401), surface.gridHeight([0, 0, 311.3, 207.9], 1401), 'only the extent matters');
  assert.equal(surface.gridHeight([0, 0, 1000, 0.001], 100), 1);
});

test('the surface budget follows the viewport, with a floor for small panes and the engine ceiling', () => {
  assert.equal(surface.surfaceBudget(2800000, 16000000), 4200000);
  assert.equal(surface.surfaceBudget(500000, 16000000), 2000000);
  assert.equal(surface.surfaceBudget(14000000, 16000000), 16000000);
  assert.equal(surface.surfaceBudget(2800000, 4000000), 4000000);
});

test('a page that fits the budget is held whole and never moves with the viewport', () => {
  const budget = { whole: 4200000, clip: 1000000, max: 16000000 };
  assert.deepEqual(surface.planSurface([1400, 1980], [0, 300, 1400, 1700], budget), [0, 0, 1400, 1980]);
  assert.deepEqual(surface.planSurface([1400, 1980], undefined, budget), [0, 0, 1400, 1980], 'even off screen');
  assert.equal(surface.planSurface([3404, 4406], undefined, budget), undefined, 'a page too large to hold whole needs no surface while off screen');
  assert.equal(surface.planSurface([3404, 4406], [10, 10, 10, 500], budget), undefined);
  assert.deepEqual(surface.planSurface([9000, 100], [0, 0, 2000, 100], { whole: 16000000, clip: 16000000, max: 16000000 })!.slice(0, 2), [0, 0],
    'a page within the area budget but wider than a canvas is still clipped');
});

test('a larger page keeps its visible part sharp on the engine lattice, overscans within its share and stays put for small scrolls', () => {
  const grid = [3404, 4406], budget = { whole: 4200000, clip: 4200000, max: 16000000 }, seen = [700, 1300, 2700, 2700];
  const clip = surface.planSurface(grid, seen, budget)!;
  for (const n of clip) { assert.ok(n % surface.SURFACE_CELL === 0 || n === grid[0] || n === grid[1], `${n} is on the lattice or a page edge`); }
  assert.ok(clip[0] <= seen[0] && clip[1] <= seen[1] && clip[2] >= seen[2] && clip[3] >= seen[3], 'covers everything on screen');
  assert.ok(pixels(clip) >= 2000 * 1400, 'lattice alignment may exceed the share but never cuts into the view');
  assert.deepEqual(surface.planSurface(grid, [700, 1400, 2700, 2800], budget, clip), clip, 'a scroll inside the rectangle changes nothing');
  const next = surface.planSurface(grid, [700, 2000, 2700, 3400], budget, clip)!;
  assert.notDeepEqual(next, clip); assert.ok(next[1] <= 2000 && next[3] >= 3400);
  // With room to spare the rectangle grows by whole lattice rows on both sides.
  const roomy = surface.planSurface(grid, [1024, 2048, 2048, 2560], { whole: 4200000, clip: 3000000, max: 16000000 })!;
  assert.deepEqual(roomy, [1024, 1024, 2048, 3584]); assert.ok(pixels(roomy) <= 3000000);
  // At a page edge the spare rows all go to the other side.
  assert.deepEqual(surface.planSurface(grid, [0, 0, 1024, 512], { whole: 4200000, clip: 1600000, max: 16000000 }), [0, 0, 1024, 1536]);
  // A held rectangle above its present share is kept while the whole budget allows it.
  assert.deepEqual(surface.planSurface(grid, [700, 1400, 2700, 2000], { whole: 4200000, clip: 1000000, max: 16000000 }, [512, 1024, 3072, 2560]), [512, 1024, 3072, 2560]);
  assert.notDeepEqual(surface.planSurface(grid, [700, 1400, 2700, 2000], { whole: 2000000, clip: 1000000, max: 16000000 }, [512, 1024, 3072, 2560]), [512, 1024, 3072, 2560]);
});

test('a view beyond the engine ceiling keeps its middle sharp and every rectangle within the limits', () => {
  const budget = { whole: 16000000, clip: 16000000, max: 16000000 };
  const clip = surface.planSurface([9000, 12000], [0, 0, 6000, 3400], budget)!;
  assert.ok(pixels(clip) <= 16000000 && clip[2] - clip[0] <= 8192 && clip[3] - clip[1] <= 8192);
  assert.ok(clip[0] <= 3000 && clip[2] >= 3000 && clip[1] <= 1700 && clip[3] >= 1700, 'the centre of the view stays covered');
  let random = 11;
  const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) / 4294967296; };
  for (let i = 0; i < 2000; i++) {
    const grid = [1 + Math.floor(next() * 12000), 1 + Math.floor(next() * 20000)];
    const x0 = Math.floor(next() * grid[0]), y0 = Math.floor(next() * grid[1]);
    const seen = [x0, y0, Math.min(grid[0], x0 + 1 + Math.floor(next() * 5000)), Math.min(grid[1], y0 + 1 + Math.floor(next() * 4000))];
    const max = 1 + Math.floor(next() * 16000000), b = { whole: Math.floor(next() * max), clip: Math.floor(next() * max), max };
    const r = surface.planSurface(grid, seen, b);
    if (!r) { continue; }
    assert.ok(r.every(Number.isInteger) && r[0] >= 0 && r[1] >= 0 && r[2] <= grid[0] && r[3] <= grid[1] && r[2] > r[0] && r[3] > r[1], `${grid} ${seen} ${JSON.stringify(b)} -> ${r}`);
    assert.ok(pixels(r) <= max && r[2] - r[0] <= 8192 && r[3] - r[1] <= 8192, `${grid} ${seen} ${JSON.stringify(b)} -> ${r}`);
    assert.deepEqual(surface.planSurface(grid, seen, b, r), r, 'a fresh plan is stable');
  }
});

test('the visible part of a page is expressed in its own grid pixels', () => {
  const grid = [2000, 2589], page = { left: 100, top: 500, width: 1000, height: 1294.5 };
  assert.deepEqual(surface.visibleGridRect(grid, page, { left: 0, top: 0, right: 900, bottom: 700 }), [0, 0, 1600, 400]);
  assert.deepEqual(surface.visibleGridRect(grid, page, { left: 150.2, top: 600.4, right: 400.6, bottom: 3000 }), [100, 200, 602, 2589]);
  assert.equal(surface.visibleGridRect(grid, page, { left: 0, top: 0, right: 900, bottom: 500 }), undefined);
  assert.equal(surface.visibleGridRect(grid, page, { left: 1100, top: 0, right: 1900, bottom: 900 }), undefined);
  assert.deepEqual(surface.surfacePlacement([2000, 4000], [500, 1000, 1500, 3000]), { left: .25, top: .25, width: .5, height: .5 });
});

test('with a pixel ratio every page is laid out on whole device pixels, matching its grid', () => {
  const cases = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.2, 3].flatMap(dpr => ['width', 'page', 'text', 0.9, 1.37].flatMap(zoom => [701, 813.5, 1000].map(width => ({ dpr, zoom, width }))));
  for (const { dpr, zoom, width } of cases) {
    const layout = new surface.PageLayout();
    layout.setBounds(0, [0, 0, 612, 792]); layout.setBounds(1, [-72.27, -72.27, 523.006, 769.62]); layout.setBounds(2, [0, 0, 841.89, 595.276]);
    layout.configure({ count: 3, complete: true, zoom, width, height: 900, dpr });
    for (let page = 0; page < 3; page++) {
      const rect = layout.rects[page], grid = layout.grid(rect.bounds, rect.width);
      near(rect.width * dpr, grid[0]); near(rect.height * dpr, grid[1]);
      assert.equal(grid[1], surface.gridHeight(rect.bounds, grid[0]));
      near(rect.top * dpr, Math.round(rect.top * dpr));
    }
  }
  // Without one, exact page proportions are untouched.
  const layout = new surface.PageLayout(); layout.setBounds(0, [0, 0, 612, 792]);
  layout.configure({ count: 1, complete: true, zoom: 'width', width: 701, height: 900 });
  near(layout.rects[0].width, 701); near(layout.rects[0].height, 701 * 792 / 612);
});
