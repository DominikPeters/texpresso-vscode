import { test } from 'node:test';
import * as assert from 'node:assert/strict';

type Bounds = [number, number, number, number];
interface Geometry {
  count: number; total: number; maxWidth: number; sizes: Map<number, Bounds>;
  rects: { top: number; width: number; height: number; bounds: Bounds }[];
  configure(options: { count?: number; complete?: boolean; active?: number; zoom?: string | number; width?: number; height?: number }): void;
  setBounds(page: number, bounds: number[]): boolean;
  latestText: Map<number, number[]>; textExtent?: number[];
  setTextBounds(page: number, bounds: number[], textBounds?: number[]): boolean;
  refitText(): void;
  dimensions(bounds: number[], proposedTextBounds?: number[]): { width: number; height: number };
  textScroll(): number;
  pageAt(y: number): number;
  window(top: number, height: number, limit?: number): { first: number; last: number; center: number; start: number; end: number };
}
const { PageLayout } = require('../../media/preview-viewport.js') as { PageLayout: new () => Geometry };

test('continuous geometry preserves mixed page bounds, origins, and physical numerical zoom', () => {
  const layout = new PageLayout();
  layout.setBounds(0, [10,20,610,820]); layout.setBounds(1, [-50,-20,750,580]);
  layout.configure({ count: 2, complete: true, zoom: .75, width: 900, height: 700 });
  assert.equal(layout.rects[0].width, 600); assert.equal(layout.rects[0].height, 800);
  assert.equal(layout.rects[1].width, 800); assert.equal(layout.rects[1].height, 600);
  assert.equal(layout.rects[1].top, 808); assert.equal(layout.total, 1408);
  assert.equal(layout.pageAt(807), 0); assert.equal(layout.pageAt(808), 1);
  assert.equal(layout.pageAt(-100), 0); assert.equal(layout.pageAt(1e9), 1);
});

test('fit modes use each page size while learned geometry survives surface eviction', () => {
  const layout = new PageLayout();
  layout.setBounds(0, [0,0,600,800]); layout.setBounds(1, [0,0,800,600]);
  layout.configure({ count: 2, complete: true, zoom: 'width', width: 900, height: 600 });
  assert.equal(layout.rects[0].width, 900); assert.equal(layout.rects[1].width, 900);
  assert.equal(layout.rects[0].height, 1200); assert.equal(layout.rects[1].height, 675);
  layout.configure({ count: 2, complete: true, zoom: 'page', width: 900, height: 600 });
  assert.equal(layout.rects[0].height, 600); assert.equal(layout.rects[1].height, 600);
  assert.equal(layout.rects[0].width, 450); assert.equal(layout.rects[1].width, 800);
  assert.equal(layout.sizes.size, 2);
});

test('incomplete page count creates just one frontier and recomputation cannot advance it', () => {
  const layout = new PageLayout();
  for (let i = 0; i < 20; i++) { layout.configure({ count: 3, complete: false }); assert.equal(layout.count, 4); }
  layout.configure({ count: 3, complete: true }); assert.equal(layout.count, 3);
  layout.configure({ count: 3, complete: false, active: 99 }); assert.equal(layout.count, 100, 'explicit distant navigation has estimated geometry');
  layout.configure({ count: 0, complete: true, active:4000 }); assert.equal(layout.count, 1, 'terminal empty document drops distant estimated geometry');
  layout.configure({ count:3,complete:true,active:4000 }); assert.equal(layout.count,3,'a final page count supersedes a distant navigation estimate');
});

test('virtualized windows stay bounded for distant and unusually small pages', () => {
  const layout = new PageLayout();
  layout.configure({ count: 100000, complete: true, zoom: .25, width: 1200, height: 800 });
  for (const top of [0, 100, 500000, layout.total - 800]) {
    const window = layout.window(top, 800);
    assert.ok(window.end-window.start+1 <= 12); assert.ok(window.start >= 0); assert.ok(window.end < 100000);
    assert.ok(window.center >= window.start && window.center <= window.end);
  }
  for (let i = 0; i < 100; i++) { layout.setBounds(i,[0,0,100,1]); }
  layout.configure({ count:100,complete:true,zoom:.25,width:1200,height:800 });
  const tiny = layout.window(0,800); assert.ok(tiny.end-tiny.start+1 <= 12);
});

test('local anchor survives a corrected page height above the viewport', () => {
  const layout = new PageLayout(); layout.configure({ count: 10, complete: true, zoom: 1 });
  const page = 5, fraction = .37, viewportY = 123;
  const oldTop = layout.rects[page].top + fraction*layout.rects[page].height - viewportY;
  layout.setBounds(1,[0,0,600,1200]); layout.configure({ count:10,complete:true,zoom:1 });
  const newTop = layout.rects[page].top + fraction*layout.rects[page].height - viewportY;
  assert.notEqual(oldTop,newTop);
  assert.ok(Math.abs((newTop+viewportY-layout.rects[page].top)/layout.rects[page].height-fraction)<1e-12);
});

test('invalid geometry is rejected and catalogue allocation is bounded', () => {
  const layout = new PageLayout();
  for (const bounds of [[0,0,0,10],[0,0,10,0],[0,0,NaN,10],[0,0,Infinity,10]]) { assert.equal(layout.setBounds(0,bounds),false); }
  assert.equal(layout.setBounds(100001,[0,0,10,10]),false);
  layout.configure({ count:2147483647,complete:true }); assert.equal(layout.count,100001);
});

test('native-current-page notifications do not rebuild unchanged long-document geometry', () => {
  const layout = new PageLayout();
  layout.configure({ count: 10000, complete: true, active: 4, zoom: 'width', width: 800, height: 700 });
  const before = layout.rects;
  layout.configure({ count: 10000, complete: true, active: 5, zoom: 'width', width: 800, height: 700 });
  assert.equal(layout.rects, before);
  layout.setBounds(5, [0,0,600,400]);
  layout.configure({ count: 10000, complete: true, active: 5, zoom: 'width', width: 800, height: 700 });
  assert.notEqual(layout.rects, before);
  assert.ok(Math.abs(layout.rects[5].height-800*400/600)<1e-9);
});


test('wide neighboring paper determines one stable horizontal extent across virtualized windows', () => {
  const layout = new PageLayout();
  layout.setBounds(0,[0,0,600,800]); layout.setBounds(12,[0,0,1800,800]);
  layout.configure({ count:100,complete:true,zoom:1,width:800,height:700 });
  assert.equal(layout.maxWidth,2400);
  const near = layout.window(0,700), distant = layout.window(layout.rects[50].top,700);
  assert.ok(near.end<12 && distant.start>12,'wide paper is unmounted in both windows');
  assert.equal(layout.maxWidth,2400,'window selection cannot shift narrower paper horizontally');
  layout.configure({ count:100,complete:true,zoom:'width',width:800,height:700 });
  assert.ok(Math.abs(layout.maxWidth-800)<1e-9,'fit width uses a shared viewport extent');
});

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);
const projectedText = (layout: Geometry, page: number, x: number) => {
  const rect = layout.rects[page], scale = rect.width / (rect.bounds[2] - rect.bounds[0]);
  return (layout.maxWidth - rect.width) / 2 + (x - rect.bounds[0]) * scale - layout.textScroll();
};

test('text fit centers asymmetric text with nonzero paper origins while keeping the full paper scrollable', () => {
  const layout = new PageLayout(), paper = [10, 20, 610, 820];
  layout.setBounds(0, paper); layout.setTextBounds(0, paper, [70, 100, 490, 700]);
  layout.configure({ count: 1, complete: true, zoom: 'text', width: 900, height: 700 });
  near(layout.rects[0].width, 600 * 876 / 420);
  near(projectedText(layout, 0, 70), 12); near(projectedText(layout, 0, 490), 888);
  assert.ok(layout.maxWidth > 900 && layout.textScroll() > 0);
  assert.deepEqual(layout.rects[0].bounds, paper, 'text fit does not crop page coordinates or paper');
});

test('shared centered text extents preserve one physical scale across mixed paper and blank pages', () => {
  const layout = new PageLayout(), portrait = [0, 0, 600, 800], landscape = [-50, -20, 950, 580];
  layout.setBounds(0, portrait); layout.setBounds(1, landscape); layout.setBounds(2, portrait);
  layout.configure({ count: 3, complete: true, zoom: 'text', width: 900 });
  assert.equal(layout.rects[0].width, 900, 'older engines and fresh blank documents use normal paper fit');
  layout.setTextBounds(0, portrait, [100, 100, 500, 700]);
  layout.setTextBounds(1, landscape, [250, 40, 650, 500]);
  layout.configure({ count: 3, complete: true, zoom: 'text', width: 900 });
  const scale = layout.rects[0].width / 600;
  near(scale, 876 / 400); near(layout.rects[1].width / 1000, scale); near(layout.rects[2].width / 600, scale);
  near(projectedText(layout, 0, 100), 12); near(projectedText(layout, 1, 250), 12);
  near(projectedText(layout, 0, 500), 888); near(projectedText(layout, 1, 650), 888);
});

test('text fitting keeps a high-water envelope during edits and explicitly refits latest retained geometry', () => {
  const layout = new PageLayout(), paper = [0, 0, 600, 800];
  for (const page of [0, 1]) { layout.setBounds(page, paper); }
  layout.setTextBounds(0, paper, [100, 50, 500, 750]); layout.setTextBounds(1, paper, [50, 50, 550, 750]);
  layout.configure({ count: 2, complete: true, zoom: 'text', width: 900 });
  const before = layout.rects;
  layout.setTextBounds(0, paper, [180, 50, 420, 750]); layout.setTextBounds(1, paper, [200, 50, 400, 750]);
  layout.configure({ count: 2, complete: true, zoom: 'text', width: 900 });
  assert.equal(layout.rects, before, 'narrower edits do not resize paper or rebuild geometry');
  layout.setTextBounds(0, paper, [179, 50, 421, 750]);
  assert.equal(layout.latestText.size, 2, 'per-page estimates are independent of surface/DOM eviction');
  layout.refitText(); layout.configure({ count: 2, complete: true, zoom: 'text', width: 900 });
  near(layout.rects[0].width / 600, 876 / 242);
  assert.ok(layout.rects[0].width > before[0].width, 're-entering text mode can fit a deliberate narrower layout');
  const refitted = layout.rects;
  layout.setTextBounds(0, paper, [178, 50, 422, 750]); layout.configure({ count: 2, complete: true, zoom: 'text', width: 900 });
  assert.equal(layout.rects, refitted, 'subtle glyph-bound drift is absorbed by the screen gutter');
});

test('only confirmed EOF trims learned text and paper; incomplete prefixes retain distant estimates', () => {
  const layout = new PageLayout(), paper = [0, 0, 600, 800];
  layout.setBounds(0, paper); layout.setTextBounds(0, paper, [100, 50, 500, 750]);
  layout.setBounds(20, paper); layout.setTextBounds(20, paper, [20, 50, 580, 750]);
  layout.configure({ count: 30, complete: true, zoom: 'text', width: 900 });
  const wide = layout.rects[0].width;
  layout.configure({ count: 2, complete: false, zoom: 'text', width: 900 });
  assert.ok(layout.latestText.has(20)); near(layout.rects[0].width, wide);
  layout.configure({ count: 2, complete: true, zoom: 'text', width: 900 });
  assert.ok(!layout.latestText.has(20) && !layout.sizes.has(20)); near(layout.rects[0].width, 600 * 876 / 400);
  layout.configure({ count: 0, complete: true, zoom: 'text', width: 900 });
  assert.equal(layout.latestText.size, 0); assert.equal(layout.textExtent, undefined); assert.equal(layout.rects[0].width, 900);
});

test('text geometry clips to paper and narrow labels obey the existing zoom ceiling', () => {
  const layout = new PageLayout(), paper = [10, 20, 610, 820]; layout.setBounds(0, paper);
  for (const bad of [[0, 0, NaN, 10], [0, 0, 10, 10], [700, 50, 800, 100]]) { assert.equal(layout.setTextBounds(0, paper, bad), false); }
  assert.equal(layout.setTextBounds(100001, paper, [20, 30, 40, 50]), false);
  layout.setTextBounds(0, paper, [-100, 10, 700, 900]); layout.configure({ count: 1, complete: true, zoom: 'text', width: 900 });
  near(layout.rects[0].width, 876);
  layout.setTextBounds(0, paper, [20, 40, 25, 80]); layout.refitText();
  layout.configure({ count: 1, complete: true, zoom: 'text', width: 900 });
  near(layout.rects[0].width / 600, 4 * 96 / 72);
  near((projectedText(layout, 0, 20) + projectedText(layout, 0, 25)) / 2, 450);
  layout.configure({ count: 100000, complete: false, zoom: 'text', width: 900 });
  const window = layout.window(layout.rects[50000].top, 700);
  assert.ok(window.end - window.start + 1 <= 12); assert.equal(layout.latestText.size, 1, 'text fit learns only pages that actually arrive');
});

test('proposed text-fit surface budgets match committed geometry including learning hysteresis', () => {
  const layout = new PageLayout(), paper = [0, 0, 600, 800];
  layout.setBounds(0, paper); layout.configure({ count: 1, complete: true, zoom: 'text', width: 900, height: 700 });
  for (const text of [[100, 50, 500, 750], [99, 50, 501, 750], [98, 50, 502, 750],
    [80, 50, 520, 750], [180, 50, 420, 750], [-100, 50, 700, 750]]) {
    const proposed = layout.dimensions(paper, text);
    layout.setTextBounds(0, paper, text); layout.configure({ count: 1, complete: true, zoom: 'text', width: 900, height: 700 });
    near(proposed.width, layout.rects[0].width); near(proposed.height, layout.rects[0].height);
  }
});

test('unchanged EOF skips catalogue scans but newly learned out-of-range estimates are pruned', () => {
  const layout = new PageLayout(), paper = [0, 0, 600, 800];
  layout.setBounds(0, paper); layout.setTextBounds(0, paper, [100, 50, 500, 750]);
  layout.configure({ count: 10, complete: true, zoom: 'text' });
  let scans = 0;
  for (const entries of [layout.sizes, layout.latestText]) {
    const keys = entries.keys.bind(entries);
    entries.keys = () => { scans++; return keys(); };
  }
  for (let active = 0; active < 10; active++) { layout.configure({ count: 10, complete: true, active, zoom: 'text' }); }
  assert.equal(scans, 0, 'native-current-page updates keep the cheap unchanged-layout path');
  layout.setBounds(20, paper); layout.setTextBounds(20, paper, [20, 50, 580, 750]);
  layout.configure({ count: 10, complete: true, zoom: 'text' });
  assert.equal(scans, 2); assert.ok(!layout.sizes.has(20) && !layout.latestText.has(20));
  layout.configure({ count: 10, complete: true, active: 9, zoom: 'text' });
  assert.equal(scans, 2, 'the retained EOF bound becomes cheap again after pruning');
});
