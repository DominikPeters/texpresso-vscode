import { test } from 'node:test';
import * as assert from 'node:assert/strict';

type Bounds = [number, number, number, number];
interface Geometry {
  count: number; total: number; maxWidth: number; sizes: Map<number, Bounds>;
  rects: { top: number; width: number; height: number; bounds: Bounds }[];
  configure(options: { count?: number; complete?: boolean; active?: number; zoom?: string | number; width?: number; height?: number }): void;
  setBounds(page: number, bounds: number[]): boolean;
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
