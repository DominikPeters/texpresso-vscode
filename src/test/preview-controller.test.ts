import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { TexpressoSession } from '../session';
import type { Command } from '../protocol';
import { PreviewController } from '../preview-controller';

function fixture() {
  let receive!: (value: unknown) => void, view!: () => void, closed!: () => void;
  let stops = 0;
  const messages: Record<string, any>[] = [], commands: Command[] = [], opened: string[] = [];
  const panel = { visible: true,
    webview: { html: '', cspSource: 'local:', asWebviewUri: () => 'local:/asset',
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; },
      postMessage: async (message: Record<string, any>) => { messages.push(message); return true; } },
    onDidChangeViewState: (callback: () => void) => { view = callback; },
    onDidDispose: (callback: () => void) => { closed = callback; }, dispose: () => closed() };
  const api = { Uri: { joinPath: () => ({}), parse: (uri: string) => uri }, ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => panel }, env: { openExternal: async (uri: string) => { opened.push(uri); return true; } } };
  const session = { embedded: true, state: 'running', paused: false, previewSequence: 0,
    document: { fileName: '/work/main.tex' }, send: (command: Command) => commands.push(command) };
  const controller = new PreviewController(api as unknown as typeof vscode, {} as vscode.Uri,
    session as unknown as TexpressoSession, () => { stops++; }, () => {});
  const instance = () => panel.webview.html.match(/data-instance="([^"]+)"/)![1];
  return { controller, panel, session, messages, commands, opened, stops: () => stops,
    send: (m: object) => receive({ instance: instance(), ...m }), view: () => view() };
}

test('preview admits one frame until decode acknowledgment and ignores messages from another webview', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, false, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    const render = f.commands[0]; assert.equal(render[0], 'preview-render');
    f.send({ type: 'viewport', page: 0, width: 1200 });
    assert.equal(f.commands.length, 1, 'resize waits for the active frame');
    f.controller.handle({ header: { requestId: render[1] as number, revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 612, 792], width: 1000, height: 1295, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
    assert.equal(f.commands.length, 2, 'obsolete size is replaced after consuming its frame');
    const current = f.commands[1];
    f.controller.handle({ header: { requestId: current[1] as number, revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 612, 792], width: 1200, height: 1553, mime: 'image/png', byteLength: 4 }, bytes: Buffer.from([1, 2, 3, 4]) });
    const image = f.messages.find(m => m.type === 'image')!;
    assert.ok(image.bytes instanceof ArrayBuffer); assert.equal(image.bytes.byteLength, 4);
    f.send({ type: 'viewport', page: 1, width: 1200 });
    assert.equal(f.commands.length, 2);
    f.send({ instance: 'another-instance', type: 'decoded', id: current[1] });
    assert.equal(f.commands.length, 2);
    f.send({ type: 'decoded', id: current[1] });
    assert.equal(f.commands.length, 3); assert.equal(f.commands[2][2], 1);
  } finally { f.controller.dispose(); }
  assert.equal(f.stops(), 0, 'programmatic disposal does not stop a replacement session');
});

test('preview shows completed foreground progress as stale, rejects its interactions and restores a hidden panel', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, false, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.session.previewSequence = 1;
    f.controller.handle({ sourceSequence: 1 });
    f.controller.handle({ header: { requestId: 1, revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 612, 792], width: 1000, height: 1295, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
    const progress = f.messages.filter(m => m.type === 'image');
    assert.equal(progress.length, 1); assert.equal(progress[0].visualOnly, true);
    assert.equal(progress[0].target, undefined); assert.equal(progress[0].destination, undefined);
    assert.equal(f.commands.length, 1, 'wait for current source and return the old frame decode credit');
    f.controller.handle(['preview-state', 3, 1, 1, false, 0]);
    assert.equal(f.commands.length, 1, 'completed old frame keeps the one browser decode credit');
    f.send({ type: 'decoded', id: 1, displayed: true, stale: true });
    assert.equal(f.commands.length, 2); assert.equal(f.commands[1][4], 3); assert.equal(f.commands[1][5], 1);
    f.send({ type: 'inverse', revision: 1, sequence: 0, page: 0, x: 10, y: 20 });
    assert.equal(f.commands.length, 2);
    f.panel.visible = false; f.view();
    f.panel.visible = true; f.view();
    f.send({ type: 'ready', page: 0, width: 1000 });
    assert.equal(f.commands.length, 3);
  } finally { f.controller.dispose(); }
});

test('forward SyncTeX from an obsolete rendering pass cannot navigate the current preview', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 5, 0, 2, false, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.controller.handle(['preview-forward', 4, 0, 1, 100, 100]);
    const frame = { header: { requestId: 1, revision: 5, sequence: 0, page: 0,
      bounds: [0, 0, 612, 792] as [number, number, number, number], width: 1000, height: 1295,
      mime: 'image/png' as const, byteLength: 4 }, bytes: Buffer.alloc(4) };
    f.controller.handle(frame);
    f.send({ type: 'decoded', id: 1 });
    assert.equal(f.commands.length, 1);
    assert.equal(f.messages.find(m => m.type === 'image')?.target, undefined);
  } finally { f.controller.dispose(); }
});

test('forward targets are consumed once so later zooming does not revive a highlight', () => {
  const f = fixture();
  const frame = (id: number) => ({ header: { requestId: id, revision: 1, sequence: 0, page: 0,
    bounds: [0, 0, 612, 792] as [number, number, number, number], width: 1000, height: 1295,
    mime: 'image/png' as const, byteLength: 4 }, bytes: Buffer.alloc(4) });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.controller.handle(['preview-forward', 1, 0, 0, 100, 100]);
    f.controller.handle(frame(1));
    assert.ok(f.messages.find(m => m.type === 'image')?.target);
    f.send({ type: 'decoded', id: 1 });
    f.send({ type: 'viewport', page: 0, width: 1200 });
    f.controller.handle(frame(2));
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)?.target, undefined);
    f.send({ type: 'decoded', id: 2 });
    f.controller.handle(['preview-forward', 1, 0, 0, 100, 100]);
    assert.equal(f.messages.at(-1)?.type, 'target');
    f.send({ type: 'viewport', page: 0, width: 1400 });
    f.controller.handle(frame(3));
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)?.target, undefined);
  } finally { f.controller.dispose(); }
});

test('magnifier shares decode credit, coalesces pointer movement, and yields to page updates', () => {
  const f = fixture();
  (f.session as typeof f.session & { previewRegions: boolean }).previewRegions = true;
  const frame = (id: number) => ({ header: { requestId: id, revision: 1, sequence: 0, page: 0,
    bounds: [0, 0, 612, 792] as [number, number, number, number], width: 1000, height: 1295,
    mime: 'image/png' as const, byteLength: 4 }, bytes: Buffer.alloc(4) });
  const region = (token: number, bounds = [100, 100, 200, 200]) =>
    f.send({ type: 'region', token, revision: 1, sequence: 0, page: 0, bounds, width: 480 });
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.controller.handle(frame(1));
    region(1); region(2);
    assert.equal(f.commands.length, 1);
    f.send({ type: 'decoded', id: 1 });
    assert.equal(f.commands.at(-1)?.[0], 'preview-region');
    f.controller.handle(frame(2));
    assert.equal(f.messages.filter(m => m.type === 'region').at(-1)?.token, 2);
    region(3, [-1, 0, 20, 20]); // Invalid bounds cannot replace a request.
    region(4); region(5);
    f.send({ type: 'viewport', page: 1, width: 1000 });
    f.send({ type: 'decoded', id: 2 });
    assert.equal(f.commands.length, 3);
    assert.equal(f.commands.at(-1)?.[0], 'preview-render');
    assert.equal(f.commands.at(-1)?.[2], 1);
    f.send({ type: 'inverse', revision: 1, sequence: 0, page: 0, x: 500, y: 500 });
    assert.equal(f.commands.at(-1)?.[0], 'preview-render', 'old page is no longer available for inverse navigation');
  } finally { f.controller.dispose(); }
});

test('viewport detail shares decode credit, yields to the magnifier, and keeps inverse coordinates on the full page', () => {
  const f = fixture();
  (f.session as typeof f.session & { previewRegions: boolean }).previewRegions = true;
  const frame = (id: number, bounds: [number, number, number, number] = [0, 0, 612, 792]) =>
    ({ header: { requestId: id, revision: 1, sequence: 0, page: 0, bounds, width: 1732, height: 2241,
      mime: 'image/png' as const, byteLength: 4 }, bytes: Buffer.alloc(4) });
  const region = (type: string, token: number, width: number) =>
    f.send({ type, token, revision: 1, sequence: 0, page: 0, bounds: [100, 100, 500, 500], width });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1732 });
    f.controller.handle(frame(1));
    region('detail', 10, 2000); region('region', 20, 480);
    assert.equal(f.commands.length, 1, 'base decode owns the frame credit');
    f.send({ type: 'decoded', id: 1 });
    assert.equal(f.commands.at(-1)?.[3], 480, 'magnifier precedes background detail');
    f.controller.handle(frame(2, [100, 100, 500, 500]));
    f.send({ type: 'decoded', id: 2 });
    assert.equal(f.commands.at(-1)?.[3], 2000);
    f.controller.handle(frame(3, [100, 100, 500, 500]));
    assert.equal(f.messages.filter(m => m.type === 'detail').at(-1)?.token, 10);
    f.send({ type: 'decoded', id: 3 });
    f.send({ type: 'inverse', revision: 1, sequence: 0, page: 0, x: 600, y: 700 });
    assert.equal(f.commands.at(-1)?.[0], 'preview-inverse', 'crop never replaces full-page hit bounds');
    region('region', 30, 2000); region('detail', 40, 4097);
    assert.equal(f.commands.at(-1)?.[0], 'preview-inverse', 'purpose-specific raster limits');
    region('detail', 50, 2000);
    f.controller.handle(['preview-error', f.commands.at(-1)![1] as number, 'crop failed']);
    assert.equal(f.messages.at(-1)?.purpose, 'detail');
    region('detail', 60, 2000);
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(frame(f.commands.at(-1)![1] as number, [100, 100, 500, 500]));
    assert.equal(f.messages.filter(m => m.type === 'detail').length, 1, 'stale detail is dropped after edits');
  } finally { f.controller.dispose(); }
});

test('SVG selection is capability-gated and decode failure falls back to PNG with shared frame credit', () => {
  const f = fixture();
  const frame = (id: number, mime: 'image/png' | 'image/svg+xml', page = 0) => ({ header: { requestId: id, revision: 1, sequence: 0, page,
    bounds: [0, 0, 612, 792] as [number, number, number, number], width: 612, height: 792, mime, byteLength: 4 }, bytes: Buffer.alloc(4) });
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1200, format: 'svg' });
    assert.equal(f.commands[0][0], 'preview-render', 'old engines receive no new verbs');
    f.controller.handle(frame(1, 'image/png')); f.send({ type: 'decoded', id: 1 });
    (f.session as typeof f.session & { previewSvg: boolean }).previewSvg = true;
    f.send({ type: 'viewport', page: 0, width: 1200, format: 'svg' });
    assert.equal(f.commands.at(-1)?.[0], 'preview-svg');
    f.controller.handle(frame(2, 'image/svg+xml'));
    f.send({ type: 'decode-error', id: 2 });
    assert.equal(f.commands.length, 2, 'decode fallback reuses the already cached PNG');
    const image = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.match(image.header.fallback, /SVG could not be decoded/);
    f.send({ type: 'viewport', page: 0, width: 1200, format: 'svg' });
    f.send({ type: 'decoded', id: 3 });
    assert.equal(f.commands.length, 2, 'failed SVG is not retried in a loop');
    f.send({ type: 'viewport', page: 1, width: 1200, format: 'svg' });
    assert.equal(f.commands.at(-1)?.[0], 'preview-svg', 'decode fallback is scoped to its page');
    f.controller.handle(frame(4, 'image/svg+xml', 1)); f.send({ type: 'decoded', id: 4 });
  } finally { f.controller.dispose(); }
});

test('document links use current engine metadata, allow web/mail URLs, and resolve internal destinations lazily', () => {
  const f = fixture();
  (f.session as typeof f.session & { previewLinks: boolean }).previewLinks = true;
  const frame = (id: number, page: number) => ({ header: { requestId: id, revision: 1, sequence: 0, page,
    bounds: [0, 0, 612, 792] as [number, number, number, number], width: 612, height: 792,
    mime: 'image/png' as const, byteLength: 4, annotations: {
      links: ['https://example.com/', 'mailto:test@example.com', 'javascript:alert(1)', 'command:evil', '#target'].map(uri =>
        ({ bounds: [10, 10, 100, 30] as [number, number, number, number], uri })),
      destinations: [{ name: 'target', x: 20, y: 200 }]
    } }, bytes: Buffer.alloc(4) });
  const click = (index: number, extra = {}) => f.send({ type: 'link', revision: 1, sequence: 0, page: 0, index, ...extra });
  try {
    f.controller.handle(['preview-state', 1, 0, 2, false, 0]);
    f.send({ type: 'ready', page: 0, width: 1200 }); f.controller.handle(frame(1, 0)); f.send({ type: 'decoded', id: 1 });
    click(0, { revision: 0 }); click(0, { index: 99 });
    assert.deepEqual(f.opened, []);
    click(0, { uri: 'https://untrusted-webview.example' }); click(1); click(2); click(3);
    assert.deepEqual(f.opened, ['https://example.com/', 'mailto:test@example.com']);
    click(4); assert.deepEqual(f.commands.at(-1), ['preview-destination', 1, 0, 'target']);
    const before = f.commands.length;
    f.controller.handle(['preview-destination', 0, 0, 'target', 1]);
    assert.equal(f.commands.length, before);
    f.controller.handle(['preview-destination', 1, 0, 'target', 1]);
    assert.equal(f.commands.at(-1)?.[2], 1);
    f.controller.handle(frame(2, 1));
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)?.destination, 'target');
    f.send({ type: 'decoded', id: 2 });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); click(0);
    assert.equal(f.opened.length, 2, 'links from stale source images cannot open anything');
  } finally { f.controller.dispose(); }
});

function cachedFrame(id: number, page = 0, byte = page, revision = 1, sequence = 0, size = 4) {
  return { header: { requestId: id, revision, sequence, page,
    bounds: [0, 0, 612, 792] as [number, number, number, number], width: 1000, height: 1295,
    mime: 'image/png' as const, byteLength: size }, bytes: Buffer.alloc(size, byte) };
}

test('previous/next reuse exported pages and decoded images without asking the engine', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 }); f.controller.handle(cachedFrame(1));
    const first = f.messages.find(m => m.type === 'image')!;
    f.send({ type: 'decoded', id: 1, cached: [first.contentId] });
    f.send({ type: 'viewport', page: 1, width: 1000 }); f.controller.handle(cachedFrame(2, 1));
    const second = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: 2, cached: [first.contentId, second.contentId] });
    f.send({ type: 'viewport', page: 0, width: 1000 });
    const reused = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(f.commands.length, 2); assert.equal(reused.header.page, 0);
    assert.equal(reused.header.requestId, 3); assert.equal(reused.contentId, first.contentId);
    assert.equal(reused.bytes, undefined, 'cache reference avoids retransmitting the image');
    f.send({ type: 'viewport', page: 1, width: 1000 });
    assert.equal(f.messages.filter(m => m.type === 'image').length, 3, 'cache hits still use decode credit');
    f.send({ type: 'decoded', id: 3, cached: [first.contentId, second.contentId] });
    assert.equal(f.commands.length, 2);
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.header.page, 1);
  } finally { f.controller.dispose(); }
});

test('cached navigation synchronizes the native page before inverse search and drops abandoned clicks', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 }); f.controller.handle(cachedFrame(1)); f.send({ type: 'decoded', id: 1 });
    f.send({ type: 'viewport', page: 1, width: 1000 }); f.controller.handle(cachedFrame(2, 1)); f.send({ type: 'decoded', id: 2 });
    f.send({ type: 'viewport', page: 0, width: 1000 }); f.send({ type: 'decoded', id: 3 });
    f.send({ type: 'inverse', revision: 1, sequence: 0, page: 0, x: 100, y: 200 });
    assert.deepEqual(f.commands.at(-1), ['preview-render', 4, 0, 1000, 1, 0]);
    f.controller.handle(cachedFrame(4));
    assert.deepEqual(f.commands.at(-1), ['preview-inverse', 1, 0, 0, 100, 200]);
    f.send({ type: 'decoded', id: 4 });
    f.send({ type: 'viewport', page: 1, width: 1000 }); f.send({ type: 'decoded', id: 5 });
    f.send({ type: 'inverse', revision: 1, sequence: 0, page: 1, x: 100, y: 200 });
    f.send({ type: 'viewport', page: 0, width: 1000 });
    f.controller.handle(cachedFrame(6, 1));
    assert.equal(f.commands.filter(c => c[0] === 'preview-inverse').length, 1);
  } finally { f.controller.dispose(); }
});

test('undo may reuse identical image content but always compiles and refreshes link metadata for the new revision', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 }); f.controller.handle(cachedFrame(1));
    const first = f.messages.find(m => m.type === 'image')!;
    f.send({ type: 'decoded', id: 1, cached: [first.contentId] });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-invalidated', 2, 1]); f.controller.handle(['preview-state', 2, 1, 1, true, 0]);
    assert.equal(f.commands.length, 2, 'no guessed source-state cache');
    const next = cachedFrame(2, 0, 0, 2, 1);
    const annotations = { links: [{ bounds: [0, 0, 10, 10] as [number, number, number, number], uri: 'https://example.com/new' }], destinations: [] };
    f.controller.handle({ ...next, header: { ...next.header, annotations } });
    const reused = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(reused.bytes, undefined); assert.equal(reused.header.revision, 2); assert.equal(reused.header.sequence, 1);
    assert.deepEqual(reused.header.annotations, annotations, 'image identity does not determine hyperlinks');
  } finally { f.controller.dispose(); }
});

test('webview cache misses and panel reloads resend bytes without another engine render', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 }); f.controller.handle(cachedFrame(1));
    const id = f.messages.find(m => m.type === 'image')!.contentId;
    f.send({ type: 'decoded', id: 1, cached: [id] });
    f.controller.navigate(0);
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.bytes, undefined);
    f.send({ type: 'cache-miss', id: 2 });
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.bytes.byteLength, 4);
    assert.equal(f.commands.length, 1);
    f.send({ type: 'decoded', id: 3, cached: [id] });
    f.panel.visible = false; f.view(); f.panel.visible = true; f.view();
    f.send({ type: 'ready', page: 0, width: 1000 });
    assert.equal(f.commands.length, 1); assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.bytes.byteLength, 4);
  } finally { f.controller.dispose(); }
});

test('encoded pages have LRU byte/entry limits and distinguish width and format', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 20, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    for (let page = 0; page < 9; page++) {
      if (page) { f.send({ type: 'viewport', page, width: 1000 }); }
      f.controller.handle(cachedFrame(page + 1, page)); f.send({ type: 'decoded', id: page + 1 });
    }
    f.send({ type: 'viewport', page: 0, width: 1000 });
    assert.equal(f.commands.length, 10, 'oldest of nine entries was evicted');
    f.controller.handle(cachedFrame(10)); f.send({ type: 'decoded', id: 10 });
    f.send({ type: 'viewport', page: 0, width: 1200 });
    assert.equal(f.commands.length, 11, 'different PNG resolution needs a render');
    f.controller.handle(cachedFrame(11)); f.send({ type: 'decoded', id: 11 });
    (f.session as typeof f.session & { previewSvg: boolean }).previewSvg = true;
    f.send({ type: 'viewport', page: 0, width: 1200, format: 'svg' });
    assert.equal(f.commands.at(-1)?.[0], 'preview-svg');
  } finally { f.controller.dispose(); }
  const g = fixture();
  try {
    g.controller.handle(['preview-state', 1, 0, 20, true, 0]); g.send({ type: 'ready', page: 0, width: 1000 });
    g.controller.handle(cachedFrame(1, 0, 0, 1, 0, 5 * 1024 * 1024)); g.send({ type: 'decoded', id: 1 });
    g.send({ type: 'viewport', page: 1, width: 1000 });
    g.controller.handle(cachedFrame(2, 1, 1, 1, 0, 5 * 1024 * 1024)); g.send({ type: 'decoded', id: 2 });
    g.send({ type: 'viewport', page: 0, width: 1000 });
    assert.equal(g.commands.length, 3, 'aggregate byte budget evicts even with only two pages');
  } finally { g.controller.dispose(); }
});

test('SVG DOM patches require an acknowledged base and recover with full bytes after a browser miss', () => {
  const f = fixture();
  (f.session as typeof f.session & { previewSvg: boolean }).previewSvg = true;
  const xml = (value: number) => '<svg xmlns="http://www.w3.org/2000/svg">' +
    Array.from({ length: 80 }, (_, i) => `<path d="M${i === 20 ? value : i} 0L1 1"/>`).join('') + '</svg>';
  const frame = (id: number, revision: number, sequence: number, value: number) => {
    const bytes = Buffer.from(xml(value));
    return { header: { ...cachedFrame(id).header, revision, sequence, mime: 'image/svg+xml' as const, byteLength: bytes.length }, bytes };
  };
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1200, format: 'svg', svgDom: true });
    f.controller.handle(frame(1, 1, 0, 20));
    const first = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(first.inlineSvg, true); assert.ok(first.bytes); assert.equal(first.svgPatch, undefined);
    f.send({ type: 'decoded', id: 1, svg: first.contentId, cached: [first.contentId] });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-invalidated', 2, 1]); f.controller.handle(['preview-state', 2, 1, 1, true, 0]);
    f.controller.handle(frame(2, 2, 1, 500));
    const patch = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(patch.svgPatch.base, first.contentId); assert.equal(patch.bytes, undefined);
    assert.equal(patch.svgPatch.operations.length, 1); assert.equal(patch.header.revision, 2);
    f.send({ type: 'cache-miss', id: 2 });
    const full = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(full.svgPatch, undefined); assert.ok(full.bytes); assert.equal(full.header.requestId, 3);
    assert.equal(f.commands.length, 2, 'full resynchronization uses encoded cache');
    f.send({ type: 'decoded', id: 1, svg: first.contentId });
    f.send({ type: 'decoded', id: 3, svg: full.contentId, cached: [full.contentId] });
    f.session.previewSequence = 2; f.controller.handle({ sourceSequence: 2 });
    f.controller.handle(['preview-invalidated', 3, 2]); f.controller.handle(['preview-state', 3, 2, 1, true, 0]);
    f.controller.handle(frame(4, 3, 2, 20));
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.svgPatch.base, full.contentId);
  } finally { f.controller.dispose(); }
});

test('a page rendered during navigation stays cached even if its display was superseded', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.send({ type: 'viewport', page: 1, width: 1000 });
    f.controller.handle(cachedFrame(1));
    f.controller.handle(cachedFrame(2, 1)); f.send({ type: 'decoded', id: 2 });
    f.send({ type: 'viewport', page: 0, width: 1000 });
    assert.equal(f.commands.length, 2, 'returning uses the previously superseded page frame');
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.header.page, 0);
  } finally { f.controller.dispose(); }
});

function autoFixture() {
  const f = fixture(); Object.assign(f.session, { previewAuto: true, previewSvg: true, previewRegions: true });
  f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
  f.send({ type: 'ready', page: 0, width: 1200, format: 'auto', svgDom: true });
  return f;
}
function autoFrame(id: number, svg = false, cost = 40000, sequence = 0, revision = 1) {
  const bytes = svg ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">' +
    Array.from({ length: 80 }, (_, i) => `<path d="M${i === 20 ? 100 + sequence : i} 1L2 2"/>`).join('') + '</svg>') : Buffer.alloc(4);
  return { header: { requestId: id, revision, sequence, page: 0, bounds: [0, 0, 600, 800] as [number, number, number, number],
    width: 600, height: 800, mime: svg ? 'image/svg+xml' as const : 'image/png' as const,
    byteLength: bytes.length, svgEligible: true, vectorCost: cost }, bytes };
}

test('Auto starts with native complexity selection, upgrades after idle and learns to keep SVG across edits', t => {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] }); const f = autoFixture();
  try {
    assert.deepEqual(f.commands[0], ['preview-auto', 1, 0, 1200, 1, 0, 16000]);
    f.controller.handle(autoFrame(1));
    t.mock.timers.tick(500); assert.equal(f.commands.length, 1, 'wait for the first PNG acknowledgment');
    f.send({ type: 'decoded', id: 1 });
    t.mock.timers.tick(349); assert.equal(f.commands.length, 1);
    t.mock.timers.tick(1); assert.equal(f.commands[1][0], 'preview-svg');
    f.controller.handle(autoFrame(2, true));
    const image = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(image.inlineSvg, true);
    f.send({ type: 'decoded', id: 2, svg: image.contentId, renderMs: 50 });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
    assert.deepEqual(f.commands.at(-1), ['preview-auto', 3, 0, 1200, 2, 1, 52000], 'learned limit allows direct SVG without a PNG interlude');
    f.controller.handle(autoFrame(3, true, 40000, 1, 2));
    const patch = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.ok(patch.svgPatch, 'next edit reuses the retained SVG DOM');
    f.send({ type: 'decoded', id: 3, svg: patch.contentId, renderMs: 30 });
    f.session.previewSequence = 2; f.controller.handle({ sourceSequence: 2 });
    f.controller.handle(['preview-state', 3, 2, 3, true, 0]);
    assert.equal(f.commands.at(-1)![6], 0, 'a slow incremental patch uses the tighter 24 ms budget');
  } finally { f.controller.dispose(); }
});

test('Auto defers during held gestures, gives magnification priority and drops superseded upgrades', t => {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] }); const f = autoFixture();
  try {
    f.controller.handle(autoFrame(1)); f.send({ type: 'decoded', id: 1 });
    f.send({ type: 'interaction', active: true }); t.mock.timers.tick(1000);
    assert.equal(f.commands.length, 1, 'no upgrade while the pointer is held');
    f.send({ type: 'interaction', active: false }); t.mock.timers.tick(350);
    assert.equal(f.commands.at(-1)![0], 'preview-svg');
    f.send({ type: 'region', revision: 1, sequence: 0, page: 0, token: 1, bounds: [0, 0, 100, 100], width: 300 });
    assert.equal(f.commands.at(-1)![0], 'preview-region', 'interactive request does not wait for background credit');
    const count = f.messages.filter(m => m.type === 'image').length;
    f.controller.handle(autoFrame(2, true));
    assert.equal(f.messages.filter(m => m.type === 'image').length, count, 'late upgrade cannot replace the visible page');
    f.send({ type: 'viewport', format: 'auto', page: 1, width: 1200 });
    f.controller.handle({ ...autoFrame(3), header: { ...autoFrame(3).header, bounds: [0, 0, 100, 100] } });
    assert.equal(f.commands.at(-1)![2], 1, 'navigation wins over the old region');
  } finally { f.controller.dispose(); }
});

test('Auto keeps PNG after slow or unsupported SVG and does not repeat upgrades at the same complexity', t => {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] }); const f = autoFixture();
  try {
    f.controller.handle(autoFrame(1)); f.send({ type: 'decoded', id: 1 }); t.mock.timers.tick(350);
    f.controller.handle(autoFrame(2, true));
    const image = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: 2, svg: image.contentId, renderMs: 100 });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
    assert.equal(f.commands.at(-1)![6], 0, 'slow page starts as PNG on its next edit');
    f.controller.handle(autoFrame(3, false, 40000, 1, 2)); f.send({ type: 'decoded', id: 3 });
    t.mock.timers.tick(1000); assert.equal(f.commands.length, 3, 'same-cost page is not exported twice on each edit');
    f.send({ type: 'viewport', format: 'png', page: 0, width: 1200 });
    t.mock.timers.tick(1000); assert.equal(f.commands.length, 3, 'explicit PNG uses its cache and never upgrades');
  } finally { f.controller.dispose(); }
});

test('Auto rejects unsupported idle SVG without replacing PNG, and cancels upgrades across source barriers', t => {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] });
  const f = autoFixture();
  try {
    f.controller.handle(autoFrame(1)); f.send({ type: 'decoded', id: 1 }); t.mock.timers.tick(350);
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>');
    f.controller.handle({ ...autoFrame(2, true), bytes, header: { ...autoFrame(2, true).header, byteLength: bytes.length } });
    assert.equal(f.messages.filter(m => m.type === 'image').length, 1, 'unsupported refinement leaves the acknowledged PNG intact');
    assert.ok(f.messages.some(m => m.type === 'refinement-end'), 'PNG detail rendering can resume');
    f.send({ type: 'interaction' }); t.mock.timers.tick(1000); assert.equal(f.commands.length, 2);
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
    f.controller.handle(autoFrame(3, false, 10000, 1, 2)); f.send({ type: 'decoded', id: 3 });
    t.mock.timers.tick(350); assert.equal(f.commands.at(-1)![0], 'preview-svg', 'substantially simpler content can be reconsidered');
    f.session.previewSequence = 2; f.controller.handle({ sourceSequence: 2 });
    f.controller.handle(['preview-state', 3, 2, 3, true, 0]);
    const before = f.messages.filter(m => m.type === 'image').length;
    f.controller.handle(autoFrame(4, true, 10000, 1, 2));
    f.send({ type: 'decoded', id: 4, svg: 'stale' });
    assert.equal(f.messages.filter(m => m.type === 'image').length, before, 'late SVG and its ACK cannot cross a source barrier');
    assert.equal(f.commands.at(-1)![1], 5);
  } finally { f.controller.dispose(); }
});

function pngFixture() {
  const f = fixture(); Object.assign(f.session, { previewPngPatches: true });
  f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
  f.send({ type: 'ready', page: 0, width: 1000, format: 'png', pngCanvas: true });
  return f;
}
function pngFrame(id: number, sequence: number, patch?: { base: number; rect: [number, number, number, number] }) {
  const f = cachedFrame(id, 0, id, sequence + 1, sequence, patch?.rect[2] === 0 ? 0 : 4);
  return { ...f, header: { ...f.header, rasterId: id, patch } };
}

test('PNG patches require an acknowledged canvas base, survive source edits and cache page revisits', () => {
  const f = pngFixture();
  try {
    assert.deepEqual(f.commands[0], ['preview-png', 1, 0, 1000, 1, 0, 0]);
    f.controller.handle(pngFrame(1, 0));
    const first = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(first.inlinePng, true);
    f.send({ type: 'decoded', id: 1, png: first.contentId, cached: [first.contentId] });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); f.controller.handle(['preview-state', 2, 1, 2, true, 0]);
    assert.deepEqual(f.commands.at(-1), ['preview-png', 2, 0, 1000, 2, 1, 1]);
    f.controller.handle(pngFrame(2, 1, { base: 1, rect: [10, 20, 30, 40] }));
    const changed = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(changed.rasterPatch.base, first.contentId); assert.ok(changed.bytes);
    f.send({ type: 'decoded', id: 2, png: changed.contentId, cached: [changed.contentId] });
    f.send({ type: 'viewport', page: 1, width: 1000, format: 'png' });
    const second = { ...cachedFrame(3, 1, 9, 2, 1), header: { ...cachedFrame(3, 1, 9, 2, 1).header, rasterId: 3 } };
    f.controller.handle(second);
    const other = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: 3, png: other.contentId, cached: [changed.contentId, other.contentId] });
    const before = f.commands.length;
    f.send({ type: 'viewport', page: 0, width: 1000, format: 'png' });
    const cached = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(cached.contentId, changed.contentId); assert.equal(cached.bytes, undefined); assert.equal(f.commands.length, before);
    f.send({ type: 'cache-miss', id: cached.header.requestId });
    assert.equal(f.commands.at(-1)![0], 'preview-png'); assert.equal(f.commands.at(-1)![6], 0, 'lost canvas forces a keyframe, not an unreconstructable patch replay');
  } finally { f.controller.dispose(); }
});

test('identical PNG pixels reuse canvas identity with fresh metadata; unsupported canvases fall back to images', () => {
  const f = pngFixture();
  try {
    f.controller.handle(pngFrame(1, 0)); const first = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: 1, png: first.contentId, cached: [first.contentId] });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); f.controller.handle(['preview-state', 2, 1, 2, true, 0]);
    f.controller.handle(pngFrame(2, 1, { base: 1, rect: [0, 0, 0, 0] }));
    const same = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(same.contentId, first.contentId); assert.equal(same.bytes, undefined); assert.equal(same.header.sequence, 1);
    f.send({ type: 'cache-miss', id: 2 });
    assert.equal(f.commands.at(-1)![6], 0);
    f.controller.handle(pngFrame(3, 1)); f.send({ type: 'cache-miss', id: 3, pngUnsupported: true });
    const fallback = f.messages.filter(m => m.type === 'image').at(-1)!;
    assert.equal(fallback.inlinePng, false); assert.ok(fallback.bytes, 'full encoded PNG can use the ordinary image decoder');
  } finally { f.controller.dispose(); }
});


test('Auto revisits a cached PNG fallback after SVG failure changes its learned limit', () => {
  const f = autoFixture();
  try {
    f.controller.handle(autoFrame(1, true, 12000));
    f.send({ type: 'decode-error', id: 1 });
    assert.equal(f.commands.at(-1)![0], 'preview-render');
    f.controller.handle(autoFrame(2, false, 12000)); f.send({ type: 'decoded', id: 2 });
    f.send({ type: 'viewport', page: 1, width: 1200, format: 'auto' });
    const other = autoFrame(3, false);
    f.controller.handle({ ...other, header: { ...other.header, page: 1 } }); f.send({ type: 'decoded', id: 3 });
    const count = f.commands.length;
    f.send({ type: 'viewport', page: 0, width: 1200, format: 'auto' });
    assert.equal(f.commands.length, count, 'Auto uses the PNG codec cache when the selection threshold changed');
    assert.equal(f.messages.filter(m => m.type === 'image').at(-1)!.header.mime, 'image/png');
  } finally { f.controller.dispose(); }
});


test('an obsolete render error cannot hide or strand a newer source update', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1200 });
    const obsolete = f.commands.at(-1)![1] as number;
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 1, false, 0]);
    assert.equal(f.commands.length, 1, 'new source waits for old request credit');
    f.controller.handle(['preview-error', obsolete, 'The document has not produced a page.']);
    assert.equal(f.messages.filter(m => m.type === 'error').length, 0);
    assert.deepEqual(f.commands.at(-1), ['preview-render', 2, 0, 1200, 2, 1]);
    f.controller.handle(['preview-error', 2, 'A real current render failure']);
    assert.equal(f.messages.filter(m => m.type === 'error').length, 1, 'current failures remain actionable');
  } finally { f.controller.dispose(); }
});


test('Auto includes native export work in its SVG safety budget', () => {
  const f = autoFixture();
  try {
    const frame = autoFrame(1, true, 12000);
    f.controller.handle({ ...frame, header: { ...frame.header, exportMs: 90 } });
    const image = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: 1, svg: image.contentId, renderMs: 1 });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
    assert.equal(f.commands.at(-1)![6], 0, 'cheap browser decoding cannot hide expensive native SVG export');
  } finally { f.controller.dispose(); }
});

test('a late SVG acknowledgment cannot teach the page navigated to in the meantime', () => {
  const f = autoFixture();
  try {
    f.controller.handle(autoFrame(1, true, 12000));
    const image = f.messages.filter(m => m.type === 'image').at(-1)!;
    f.send({ type: 'viewport', page: 1, width: 1200, format: 'auto' });
    f.send({ type: 'decoded', id: 1, svg: image.contentId, renderMs: 100 });
    assert.equal(f.commands.at(-1)![2], 1);
    assert.equal(f.commands.at(-1)![6], 16000, 'new page starts with default complexity selection, not old-page failure');
  } finally { f.controller.dispose(); }
});

function continuousFrame(command: Command, page: number, extra: object = {}) {
  return { header: { requestId: command[1] as number, revision: command[4] as number, sequence: command[5] as number, page,
    bounds: [0, 0, 600, 800] as [number, number, number, number], width: 1000, height: 1333,
    mime: 'image/png' as const, byteLength: 4, ...extra }, bytes: Buffer.from([1, 2, 3, 4]) };
}
const prefetchDelay = () => new Promise(resolve => setTimeout(resolve, 175));

test('continuous viewport serves visible neighbors without turning native page observations into jumps', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({type:'ready',page:0,width:1000,continuous:true,visible:[{page:0,width:1000},{page:1,width:1000}],nearby:[],resident:[0,1],epoch:0});
    f.controller.handle(continuousFrame(f.commands[0],0));
    const first=f.messages.filter(m=>m.type==='image').at(-1)!;
    f.send({type:'decoded',id:first.header.requestId,page:0,cached:[first.contentId]});
    assert.equal(f.commands.at(-1)?.[2],1,'visible neighbor gets the next shared credit');
    f.controller.handle(['preview-state',1,0,3,true,2]);
    f.controller.handle(continuousFrame(f.commands.at(-1)!,1));
    const neighbor=f.messages.filter(m=>m.type==='image').at(-1)!;
    assert.equal(neighbor.header.page,1);
    assert.ok(neighbor.bytes instanceof ArrayBuffer,'identical bytes on another page still need an independently owned surface');
    f.send({type:'decoded',id:neighbor.header.requestId,page:1,cached:[first.contentId]});
    assert.equal(f.messages.filter(m=>m.type==='jump').length,0,'neighbor/native observations cannot move the scroll anchor');
    assert.equal(f.messages.filter(m=>m.type==='state').at(-1)?.page,0,'toolbar follows browser active page');
  } finally {f.controller.dispose();}
});

test('source following renders a visible neighbor at its own width before the viewport catches up', () => {
  const f = fixture();
  const visible = [{ page: 0, width: 1078 }, { page: 1, width: 970 }];
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1078, format: 'png', continuous: true,
      visible, nearby: [], resident: [0, 1], epoch: 0 });
    const first = f.commands.at(-1)!;
    f.controller.beginSourceFollow();
    f.controller.handle(['preview-forward', 1, 0, 1, 100, 100]);
    assert.equal(f.commands.length, 1, 'source following preserves the shared decode credit');
    f.controller.handle(continuousFrame(first, 0, { width: 1078 }));
    f.send({ type: 'decoded', id: first[1], page: 0 });
    const neighbor = f.commands.at(-1)!;
    assert.equal(neighbor[2], 1);
    assert.equal(neighbor[3], 970, 'the target page must not inherit the old toolbar page width');
    f.send({ type: 'viewport', page: 1, width: 970, format: 'png', continuous: true,
      visible, nearby: [], resident: [0, 1], epoch: 0 });
    f.controller.handle(continuousFrame(neighbor, 1, { width: 970 }));
    f.send({ type: 'decoded', id: neighbor[1], page: 1 });
    assert.equal(f.commands.length, 2, 'the confirming viewport needs no replacement resize keyframe');
    assert.equal(f.messages.filter(m => m.type === 'image' && m.header.page === 1).length, 1);
  } finally { f.controller.dispose(); }
});

function sourcePriorityFixture() {
  const f = fixture();
  const viewport = { page: 0, width: 1078, format: 'png', continuous: true,
    visible: [{ page: 0, width: 1078, allocation: 'page-zero' }, { page: 1, width: 970, allocation: 'page-one' }],
    nearby: [], resident: [0, 1], epoch: 0 };
  f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
  f.send({ type: 'ready', ...viewport });
  const first = f.commands.at(-1)!;
  f.controller.beginSourceFollow(); f.controller.handle(['preview-forward', 1, 0, 1, 100, 100]);
  f.controller.handle(continuousFrame(first, 0, { width: 1078 }));
  f.send({ type: 'decoded', id: first[1], page: 0 });
  const request = f.commands.at(-1)!;
  assert.equal(request[2], 1); assert.equal(request[3], 970);
  return { ...f, viewport, request };
}

test('passive viewport center reports preserve source-page priority across edits and stale visual progress', () => {
  const f = sourcePriorityFixture(); Object.assign(f.session, { previewLinks: true, previewRegions: true, previewBackground: true });
  try {
    f.send({ type: 'viewport', ...f.viewport });
    assert.equal(f.messages.filter(m => m.type === 'state').at(-1)?.page, 0, 'toolbar reports browser center, independently of render priority');
    f.controller.handle(continuousFrame(f.request, 1, { width: 970 }));
    f.send({ type: 'decoded', id: f.request[1], page: 1 });
    assert.equal(f.commands.length, 2, 'passive reports do not ask for the center page again');
    for (const sequence of [1, 3]) {
      f.session.previewSequence = sequence; f.controller.handle({ sourceSequence: sequence });
      f.controller.handle(['preview-state', sequence + 1, sequence, 3, true, 0]);
      const request = f.commands.at(-1)!;
      assert.equal(request[2], 1, 'new source starts with the last edited visible page before SyncTeX replies');
      assert.equal(request[3], 970);
      f.send({ type: 'viewport', ...f.viewport });
      f.controller.handle(['preview-forward', sequence + 1, sequence, 1, 100, 100]);
      f.session.previewSequence = sequence + 1; f.controller.handle({ sourceSequence: sequence + 1 });
      f.controller.handle(['preview-state', sequence + 2, sequence + 1, 3, true, 0]);
      f.send({ type: 'viewport', ...f.viewport, width: 1200,
        visible: [{ page: 0, width: 1200, allocation: 'resized-center-only' }, f.viewport.visible[1]] });
      f.controller.handle(continuousFrame(request, 1, { width: 970,
        annotations: { links: [{ bounds: [1, 1, 10, 10], uri: 'https://example.com' }], destinations: [] } }));
      const progress = f.messages.filter(m => m.type === 'image').at(-1)!;
      assert.equal(progress.header.sequence, sequence); assert.equal(progress.visualOnly, true);
      assert.equal(progress.target, undefined, 'stale progress cannot reveal a target');
      const commands: number = f.commands.length;
      f.send({ type: 'link', page: 1, revision: sequence + 1, sequence, index: 0 });
      f.send({ type: 'inverse', page: 1, revision: sequence + 1, sequence, x: 5, y: 5 });
      f.send({ type: 'region', page: 1, revision: sequence + 1, sequence, token: 1, bounds: [0, 0, 10, 10], width: 100 });
      assert.equal(f.opened.length, 0); assert.equal(f.commands.length, commands);
      f.send({ type: 'decoded', id: request[1], displayed: true, stale: true });
      assert.equal(f.commands.at(-1)?.[2], 1); assert.equal(f.commands.at(-1)?.[5], sequence + 1);
      assert.equal((f.controller as any).visualSnapshots.get(1).sequence, sequence);
      // Complete the newest frame before beginning another independent edit pair.
      const current = f.commands.at(-1)!;
      f.controller.handle(continuousFrame(current, 1, { width: 970 }));
      f.send({ type: 'decoded', id: current[1], page: 1 });
    }
    assert.equal(f.commands.filter(command => command[0] === 'preview-render' && command[2] === 0).length, 1, 'only the initial center page was foreground-rendered');
  } finally { f.controller.dispose(); }
});

test('manual navigation and real source-page demand changes retire older foreground progress', () => {
  const changes = [
    { name: 'scroll', update: { scroll: true, epoch: 1 }, page: 0, width: 1078 },
    { name: 'jump', update: { jump: true, epoch: 1 }, page: 0, width: 1078 },
    { name: 'resize', update: { visible: [{ page: 0, width: 1078, allocation: 'page-zero' }, { page: 1, width: 900, allocation: 'page-one' }] }, page: 1, width: 900 },
    { name: 'allocation', update: { visible: [{ page: 0, width: 1078, allocation: 'page-zero' }, { page: 1, width: 970, allocation: 'new-page-one' }] }, page: 1, width: 970 },
    { name: 'codec', update: { format: 'auto' }, page: 1, width: 970 },
    { name: 'no longer visible', update: { visible: [{ page: 0, width: 1078, allocation: 'page-zero' }], resident: [0] }, page: 0, width: 1078 }
  ];
  for (const change of changes) {
    const f = sourcePriorityFixture();
    try {
      const images = f.messages.filter(m => m.type === 'image').length;
      f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
      f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
      f.send({ type: 'viewport', ...f.viewport, ...change.update });
      f.controller.handle(continuousFrame(f.request, 1, { width: 970 }));
      assert.equal(f.messages.filter(m => m.type === 'image').length, images, `${change.name} retires the old view intent`);
      assert.equal(f.commands.at(-1)?.[2], change.page, change.name);
      assert.equal(f.commands.at(-1)?.[3], change.width, change.name);
    } finally { f.controller.dispose(); }
  }
});

test('page commands use the browser center and override source priority', () => {
  const f = sourcePriorityFixture();
  try {
    f.send({ type: 'viewport', ...f.viewport });
    f.controller.navigate(1);
    assert.equal(f.messages.filter(m => m.type === 'jump').at(-1)?.page, 1, 'Next from centered page zero means page one, even when source priority already is one');
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
    f.controller.handle(['preview-state', 2, 1, 3, true, 0]);
    const jumps = f.messages.filter(m => m.type === 'jump').length;
    f.controller.handle(['preview-forward', 2, 1, 2, 100, 100]);
    assert.equal(f.messages.filter(m => m.type === 'jump').length, jumps, 'manual page commands suspend later source targets');
    f.controller.handle(continuousFrame(f.request, 1, { width: 970 }));
    f.send({ type: 'viewport', ...f.viewport });
    assert.equal(f.commands.at(-1)?.[2], 1, 'decode credit is not released by a viewport report');
  } finally { f.controller.dispose(); }
});

test('manual page navigation uses a nearby page demand and retains the width when none is known', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1078, format: 'png', continuous: true,
      visible: [{ page: 0, width: 1078 }], nearby: [{ page: 1, width: 970 }], resident: [0], epoch: 0 });
    const first = f.commands.at(-1)!;
    f.controller.handle(continuousFrame(first, 0, { width: 1078 }));
    f.send({ type: 'decoded', id: first[1], page: 0 });
    f.controller.navigate(1);
    const neighbor = f.commands.at(-1)!;
    assert.equal(neighbor[2], 1); assert.equal(neighbor[3], 970);
    f.controller.handle(continuousFrame(neighbor, 1, { width: 970 }));
    f.send({ type: 'decoded', id: neighbor[1], page: 1 });
    f.controller.navigate(1);
    const unknown = f.commands.at(-1)!;
    assert.equal(unknown[2], 2); assert.equal(unknown[3], 970, 'an unmeasured page keeps the latest active width');
  } finally { f.controller.dispose(); }
});

test('continuous page metadata routes links and cached-page inverse search by owning page', () => {
  const f=fixture();Object.assign(f.session,{previewLinks:true});
  try {
    f.controller.handle(['preview-state',1,0,2,true,0]);
    f.send({type:'ready',page:0,width:1000,continuous:true,visible:[{page:0,width:1000},{page:1,width:1000}],nearby:[],resident:[0,1],epoch:0});
    for(const page of [0,1]) {
      const command=f.commands.at(-1)!;
      f.controller.handle(continuousFrame(command,page,{annotations:{links:[{bounds:[10,10,100,30],uri:`https://example.com/page-${page}`}],destinations:[]}}));
      const image=f.messages.filter(m=>m.type==='image').at(-1)!;
      f.send({type:'decoded',id:image.header.requestId,page,cached:[image.contentId]});
    }
    f.send({type:'link',revision:1,sequence:0,page:1,index:0});
    f.send({type:'link',revision:1,sequence:0,page:0,index:0});
    assert.deepEqual(f.opened,['https://example.com/page-1','https://example.com/page-0']);
    f.send({type:'inverse',revision:1,sequence:0,page:0,x:100,y:200});
    const preparation=f.commands.at(-1)!;
    assert.equal(preparation[2],0,'restore page-zero hit testing after the neighbor changed native display list');
    f.controller.handle(continuousFrame(preparation,0));
    assert.deepEqual(f.commands.at(-1),['preview-inverse',1,0,0,100,200]);
    f.session.previewSequence=1;f.controller.handle({sourceSequence:1});
    f.send({type:'link',revision:1,sequence:0,page:1,index:0});
    assert.equal(f.opened.length,2,'invalidation disables every stale page link');
  } finally {f.controller.dispose();}
});

test('continuous background export is canceled by source edits and its late frame cannot consume foreground credit', async () => {
  const f=fixture();Object.assign(f.session,{previewBackground:true});
  try {
    f.controller.handle(['preview-state',1,0,2,true,0]);
    f.send({type:'ready',page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[{page:1,width:1000}],resident:[0],epoch:0});
    f.controller.handle(continuousFrame(f.commands[0],0));f.send({type:'decoded',id:1,page:0});
    await prefetchDelay();const background=f.commands.at(-1)!;
    assert.equal(background[0],'preview-background');assert.equal(background[2],1);
    f.session.previewSequence=1;f.controller.handle({sourceSequence:1});
    assert.ok(f.commands.some(c=>c[0]==='preview-cancel'&&c[1]===background[1]),'native speculative demand is canceled, not only its host queue');
    f.controller.handle(['preview-state',2,1,2,true,0]);
    const foreground=f.commands.at(-1)!;assert.equal(foreground[2],0);
    f.controller.handle(continuousFrame(background,1));
    assert.equal(f.messages.filter(m=>m.type==='image'&&m.header.page===1).length,0);
    f.controller.handle(continuousFrame(foreground,0));
    const current=f.messages.filter(m=>m.type==='image').at(-1)!;
    assert.equal(current.header.sequence,1);assert.equal(current.header.requestId,foreground[1]);
    f.send({type:'decoded',id:background[1],page:1});
    assert.equal((f.controller as any).inFlight.id,foreground[1],'late neighbor ACK cannot release current frame credit');
  } finally {f.controller.dispose();}
});

test('continuous unknown frontier has a finite initial allowance and one advance per real scroll epoch', async () => {
  const f=fixture();Object.assign(f.session,{previewBackground:true});
  const viewport=(nearby:number,epoch=0,scroll=false)=>f.send({type:'viewport',page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[{page:nearby,width:1000}],resident:[0],epoch,scroll});
  const finish=(page:number)=>{const command=f.commands.at(-1)!;f.controller.handle(['preview-state',1,0,page+1,false,0]);f.controller.handle(continuousFrame(command,page));f.send({type:'decoded',id:command[1],page});};
  try {
    f.controller.handle(['preview-state',1,0,1,false,0]);
    f.send({type:'ready',page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[{page:1,width:1000}],resident:[0],epoch:0});
    finish(0);await prefetchDelay();assert.equal(f.commands.at(-1)?.[2],1);finish(1);
    viewport(2);await prefetchDelay();assert.equal(f.commands.at(-1)?.[2],2);finish(2);
    const initial=f.commands.length;viewport(3);await prefetchDelay();
    assert.equal(f.commands.length,initial,'response/layout callbacks cannot grow the document indefinitely');
    viewport(3,1,true);await prefetchDelay();assert.equal(f.commands.at(-1)?.[2],3);finish(3);
    const scrolled=f.commands.length;viewport(4,1,true);await prefetchDelay();
    assert.equal(f.commands.length,scrolled,'the same scroll epoch cannot renew speculative demand');
  } finally {f.controller.dispose();}
});

test('continuous neighbor acknowledgment cannot clear an unresolved internal-link destination', async () => {
  const f=fixture();Object.assign(f.session,{previewLinks:true,previewBackground:true});
  const viewport={page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[{page:1,width:1000}],resident:[0],epoch:0};
  try {
    f.controller.handle(['preview-state',1,0,3,true,0]);f.send({type:'ready',...viewport});
    f.controller.handle(continuousFrame(f.commands[0],0,{annotations:{links:[{bounds:[10,10,100,30],uri:'#target'}],destinations:[]}}));
    const first=f.messages.filter(m=>m.type==='image').at(-1)!;f.send({type:'decoded',id:first.header.requestId,page:0,cached:[first.contentId]});
    f.send({type:'link',revision:1,sequence:0,page:0,index:0});
    assert.deepEqual(f.commands.at(-1),['preview-destination',1,0,'target']);
    f.send({type:'viewport',...viewport});await prefetchDelay();
    const neighbor=f.commands.at(-1)!;assert.equal(neighbor[0],'preview-background');assert.equal(neighbor[2],1);
    f.controller.handle(continuousFrame(neighbor,1));const image=f.messages.filter(m=>m.type==='image').at(-1)!;
    f.send({type:'decoded',id:image.header.requestId,page:1,cached:[first.contentId,image.contentId]});
    f.controller.handle(['preview-destination',1,0,'target',2]);
    assert.equal(f.messages.filter(m=>m.type==='jump').at(-1)?.page,2,'lookup result survives unrelated neighbor decode');
    const target=f.commands.at(-1)!;assert.equal(target[2],2);
    f.controller.handle(continuousFrame(target,2));
    assert.equal(f.messages.filter(m=>m.type==='image').at(-1)?.destination,'target','resolved destination follows its owning target frame');
  } finally {f.controller.dispose();}
});

test('continuous terminal zero-page state cannot retain an out-of-range active page after shrinking', () => {
  const f=fixture();
  try {
    f.controller.handle(['preview-state',1,0,10000,true,4000]);
    f.send({type:'ready',page:4000,width:1000,continuous:true,visible:[{page:4000,width:1000}],nearby:[],resident:[4000],epoch:0});
    const first=f.commands.at(-1)!;f.controller.handle(continuousFrame(first,4000));f.send({type:'decoded',id:first[1],page:4000});
    f.session.previewSequence=1;f.controller.handle({sourceSequence:1});
    f.controller.handle(['preview-invalidated',2,1]);const before=f.commands.length;f.controller.handle(['preview-state',2,1,0,true,0]);
    assert.equal(f.messages.filter(m=>m.type==='state').at(-1)?.page,0,'terminal empty document selects its empty start, not a vanished page');
    const next=f.commands.slice(before).find(c=>/^preview-(?:render|svg|auto|png)$/.test(c[0]));
    assert.ok(!next||next[2]===0,'empty document does not request the old distant page');
    if(next){f.controller.handle(['preview-error',next[1] as number,'The document has not produced a page.']);}
    const count=f.commands.length;f.controller.update();assert.equal(f.commands.length,count,'terminal empty state does not loop renderer requests');
  } finally {f.controller.dispose();}
});

test('older engines render visible continuous pages without uncancellable speculative demand', t => {
  (t.mock.timers as unknown as { enable(options: { apis: string[] }): void }).enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 3, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, continuous: true,
      visible: [{ page: 0, width: 1000 }, { page: 1, width: 1000 }],
      nearby: [{ page: 2, width: 1000 }], resident: [0, 1], epoch: 0 });
    for (const page of [0, 1]) {
      const command = f.commands.at(-1)!;
      assert.equal(command[0], 'preview-render'); assert.equal(command[2], page);
      f.controller.handle(continuousFrame(command, page));
      f.send({ type: 'decoded', id: command[1], page });
    }
    t.mock.timers.tick(2000);
    assert.equal(f.commands.length, 2, 'only visible pages are requested without the cancellation capability');
  } finally { f.controller.dispose(); }
});

function prepareFixture() {
  const f=fixture();
  const positions:{document:unknown;offset:number}[]=[];
  Object.assign(f.session.document,{uri:{toString:()=>'/work/main.tex'},version:1});
  Object.assign(f.session,{previewPrepareEdit:true,sync:{sourcePosition:(document:unknown,offset:number)=>{
    positions.push({document,offset});
    return Number.isSafeInteger(offset)&&offset>=0?{path:'/work/main.tex',offset}:undefined;
  }}});
  f.controller.handle(['preview-state',1,0,2,true,0]);f.send({type:'ready',page:0,width:1000});
  f.controller.handle(continuousFrame(f.commands[0],0));f.send({type:'decoded',id:f.commands[0][1]});
  return {...f,positions};
}

test('cursor preparation waits for idle and leaves the current page and render cache intact', t=>{
  (t.mock.timers as unknown as {enable(options:{apis:string[]}):void}).enable({apis:['setTimeout']});const f=prepareFixture();
  try {
    const images=f.messages.filter(m=>m.type==='image').length;
    const cache=(f.controller as any).pages.size;
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,128);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0,'cursor movement never starts synchronous compiler work');
    t.mock.timers.tick(1000);
    const prepare=f.commands.filter(c=>c[0]==='preview-prepare').at(-1)!;
    assert.ok(prepare);assert.deepEqual(prepare.slice(2),['/work/main.tex',128,1,0]);
    f.controller.handle(['preview-prepared',prepare[1] as number,1,0,'ready']);
    assert.equal(f.messages.filter(m=>m.type==='image').length,images,'checkpoint acknowledgment has no preview frame');
    assert.equal((f.controller as any).pages.size,cache,'prewarming preserves encoded page cache');
    assert.equal(f.messages.filter(m=>m.type==='jump'||m.type==='invalidate').length,0,'no scroll or source-state UI mutation');
    assert.equal((f.controller as any).inFlight,undefined,'prewarming does not take render/decode credit');
    const attempts=f.commands.filter(c=>c[0]==='preview-prepare').length;
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,150);t.mock.timers.tick(1000);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,attempts,'moving within a prepared 64-byte bucket does not repeat speculative compilation');
  } finally {f.controller.dispose();}
});

test('cursor retargeting and source edits cancel preparation; stale acknowledgments cannot revive old work', t=>{
  (t.mock.timers as unknown as {enable(options:{apis:string[]}):void}).enable({apis:['setTimeout']});const f=prepareFixture();
  try {
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,128);t.mock.timers.tick(1000);
    const first=f.commands.filter(c=>c[0]==='preview-prepare').at(-1)!;
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,256);
    assert.ok(f.commands.some(c=>c[0]==='preview-prepare-cancel'&&(c[1]===first[1]||c[1]===0)),'cursor retarget cancels obsolete native speculative work');
    t.mock.timers.tick(1000);const second=f.commands.filter(c=>c[0]==='preview-prepare').at(-1)!;
    assert.notEqual(second[1],first[1]);assert.equal(second[3],256);
    f.controller.handle(['preview-prepared',first[1] as number,1,0,'ready']);
    f.session.previewSequence=1;f.controller.handle({sourceSequence:1});
    assert.ok(f.commands.some(c=>c[0]==='preview-prepare-cancel'&&(c[1]===second[1]||c[1]===0)),'typing cancels preparation without waiting for an ACK');
    const before=f.commands.filter(c=>c[0]==='preview-prepare').length;
    f.controller.handle(['preview-prepared',second[1] as number,1,0,'ready']);t.mock.timers.tick(1000);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,before,'old completion cannot start more work under a new source barrier');
  } finally {f.controller.dispose();}
});

test('cursor preparation is optional and suspended for hidden or paused previews', t=>{
  (t.mock.timers as unknown as {enable(options:{apis:string[]}):void}).enable({apis:['setTimeout']});const f=prepareFixture();
  try {
    const prepare=()=>{f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,128);t.mock.timers.tick(1000);};
    Object.assign(f.session,{previewPrepareEdit:false});prepare();
    Object.assign(f.session,{previewPrepareEdit:true,paused:true});prepare();
    f.session.paused=false;f.panel.visible=false;f.view();prepare();
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0);
    f.panel.visible=true;f.view();f.send({type:'ready',page:0,width:1000});
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,-1);t.mock.timers.tick(1000);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0,'an unresolved or malformed source position is inert');
  } finally {f.controller.dispose();}
});

test('preparing an edit preserves acknowledged PNG and SVG patch bases', t=>{
  (t.mock.timers as unknown as {enable(options:{apis:string[]}):void}).enable({apis:['setTimeout']});
  for(const svg of [false,true]) {
    const f=svg?autoFixture():pngFixture();
    Object.assign(f.session.document,{uri:{toString:()=>'/work/main.tex'},version:1});
    Object.assign(f.session,{previewPrepareEdit:true,sync:{sourcePosition:()=>({path:'/work/main.tex',offset:128})}});
    try {
      f.controller.handle(svg?autoFrame(1,true,12000):pngFrame(1,0));
      const image=f.messages.filter(m=>m.type==='image').at(-1)!;
      f.send({type:'decoded',id:1,...(svg?{svg:image.contentId}:{png:image.contentId}),cached:[image.contentId]});
      const internals=f.controller as any,base=svg?internals.svgBase:internals.rasterBase;
      assert.ok(base);
      f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,128);t.mock.timers.tick(200);
      const command=f.commands.filter(c=>c[0]==='preview-prepare').at(-1)!;assert.ok(command);
      f.controller.handle(['preview-prepared',command[1] as number,1,0,'ready']);
      assert.equal(svg?internals.svgBase:internals.rasterBase,base,'checkpoint replay does not invalidate the acknowledged mutable surface');
      f.session.previewSequence=1;f.controller.handle({sourceSequence:1});f.controller.handle(['preview-state',2,1,3,true,0]);
      const request=f.commands.at(-1)!;
      if(!svg){assert.equal(request[6],1,'next PNG edit retains its native raster base');}
      else {
        f.controller.handle(autoFrame(request[1] as number,true,12000,1,2));
        assert.equal(f.messages.filter(m=>m.type==='image').at(-1)!.svgPatch.base,image.contentId,'next SVG edit patches the previously acknowledged DOM');
      }
    } finally {f.controller.dispose();}
  }
});

test('cursor preparation cannot get ahead of a pending page decode', t=>{
  (t.mock.timers as unknown as {enable(options:{apis:string[]}):void}).enable({apis:['setTimeout']});
  const f=fixture();Object.assign(f.session.document,{uri:{toString:()=>'/work/main.tex'},version:1});
  Object.assign(f.session,{previewPrepareEdit:true,sync:{sourcePosition:()=>({path:'/work/main.tex',offset:128})}});
  try {
    f.controller.handle(['preview-state',1,0,2,true,0]);f.send({type:'ready',page:0,width:1000});
    f.controller.prepareEdit(f.session.document as unknown as vscode.TextDocument,128);t.mock.timers.tick(1000);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0);
    f.controller.handle(continuousFrame(f.commands[0],0));t.mock.timers.tick(1000);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0,'receiving bytes does not prove a paintable frame');
    f.send({type:'decoded',id:f.commands[0][1]});t.mock.timers.tick(199);
    assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,0);
    t.mock.timers.tick(1);assert.equal(f.commands.filter(c=>c[0]==='preview-prepare').length,1);
  } finally {f.controller.dispose();}
});


test('old source state cannot shrink a new edit viewport or invalidate its current images', () => {
  const f=fixture();
  try {
    f.controller.handle(['preview-state',5,0,30,true,24]);
    f.send({type:'ready',page:24,width:1000,continuous:true,visible:[{page:24,width:1000}],nearby:[],resident:[24],epoch:0});
    f.session.previewSequence=1;f.controller.handle({sourceSequence:1});
    const messages=f.messages.length;
    f.controller.handle(['preview-state',5,0,2,true,1]);
    f.controller.handle(['preview-invalidated',5,0]);
    assert.equal(f.messages.length,messages,'obsolete source metadata has no UI effect');
    f.controller.handle(['preview-state',6,1,30,true,24]);
    assert.equal(f.messages.filter(m=>m.type==='state').at(-1)?.page,24,'new source keeps the selected distant page');
    const count=f.messages.length;f.controller.handle(['preview-state',4,1,1,true,0]);
    assert.equal(f.messages.length,count,'older compiler pass cannot replace current metadata');
  } finally {f.controller.dispose();}
});

test('manual preview navigation cancels source search and rejects late forward results until a new source intent', () => {
  const f=fixture();Object.assign(f.session,{previewBackground:true});
  try {
    f.controller.handle(['preview-state',1,0,30,true,0]);
    f.send({type:'ready',page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[],resident:[0],epoch:0});
    f.send({type:'viewport',page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[],resident:[0],epoch:1,jump:true});
    assert.ok(f.commands.some(c=>c[0]==='preview-cancel'&&c[1]===0),'even a cached same-page jump cancels pending source search');
    const jumps=f.messages.filter(m=>m.type==='jump').length;
    f.controller.handle(['preview-forward',1,0,24,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').length,jumps,'a queued old source result cannot undo navigation');
    f.controller.beginSourceFollow();f.controller.handle(['preview-forward',1,0,24,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').at(-1)?.page,24,'new explicit source intent can follow again');
  } finally {f.controller.dispose();}
});


test('manual continuous scrolling suspends late source targets even within the same page', () => {
  const f=fixture();Object.assign(f.session,{previewBackground:true});
  try {
    f.controller.handle(['preview-state',1,0,30,true,0]);
    const viewport={page:0,width:1000,continuous:true,visible:[{page:0,width:1000}],nearby:[],resident:[0],epoch:0};
    f.send({type:'ready',...viewport});
    f.send({type:'viewport',...viewport,epoch:1,scroll:false});
    f.controller.handle(['preview-forward',1,0,0,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').length,1,'programmatic layout corrections preserve source following');
    const oldRequest=f.commands.filter(c=>c[0]==='preview-render').at(-1)?.[1];
    f.send({type:'viewport',...viewport,epoch:2,scroll:true});
    assert.notEqual(f.commands.filter(c=>c[0]==='preview-render').at(-1)?.[1],oldRequest,
      'cancel-all releases foreground credit and immediately replaces the canceled render');
    assert.ok(f.commands.some(c=>c[0]==='preview-cancel'&&c[1]===0),'same-page manual scrolling cancels pending source search');
    const jumps=f.messages.filter(m=>m.type==='jump').length;
    f.controller.handle(['preview-forward',1,0,24,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').length,jumps,'late source result cannot steal the manual scroll position');
    f.controller.handle(['preview-state',2,0,30,true,0]);
    f.controller.handle(['preview-forward',2,0,24,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').length,jumps,'a new compiler pass cannot release the manual scroll hold');
    f.controller.beginSourceFollow();f.controller.handle(['preview-forward',2,0,24,100,100]);
    assert.equal(f.messages.filter(m=>m.type==='jump').at(-1)?.page,24,'a new source intent resumes following');
  } finally {f.controller.dispose();}
});

test('unacknowledged webview recovery reloads a fresh document and rejects retired messages within a bounded budget', () => {
  const f = fixture(); let reloads = 0, html = f.panel.webview.html;
  Object.defineProperty(f.panel.webview, 'html', { get: () => html, set: value => { if (value !== html) { html = value; reloads++; } } });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    const old = f.commands.at(-1)!, oldHtml = html, oldInstance = html.match(/data-instance="([^"]+)"/)![1];
    (f.controller as any).recoverWebview(); assert.equal(reloads, 1);
    const instance = html.match(/data-instance="([^"]+)"/)![1];
    assert.notEqual(instance, oldInstance); assert.notEqual(html, oldHtml, 'VS Code sees changed HTML instead of ignoring the assignment');
    assert.ok(!html.includes(oldInstance));
    assert.ok(html.includes(`script-src 'nonce-${instance}'`), 'CSP and new document identity agree');
    assert.equal((html.match(new RegExp(`nonce="${instance}"`, 'g')) || []).length, 6, 'all script nonces rotate together');
    const before = f.commands.length;
    f.send({ instance: oldInstance, type: 'ready', page: 0, width: 1000 });
    assert.equal(f.commands.length, before, 'queued ready from retired document cannot acquire fresh credit');
    f.send({ type: 'ready', page: 0, width: 1000 }); const fresh = f.commands.at(-1)!;
    assert.notEqual(old[1], fresh[1]);
    f.send({ instance: oldInstance, type: 'decoded', id: fresh[1] });
    assert.equal((f.controller as any).inFlight.id, fresh[1], 'old document cannot acknowledge a new request');
    f.send({ type: 'decoded', id: old[1] });
    assert.equal((f.controller as any).inFlight.id, fresh[1], 'stale decode cannot release new engine request');
    (f.controller as any).recoverWebview(); assert.equal(reloads, 2);
    assert.notEqual(html.match(/data-instance="([^"]+)"/)![1], instance, 'each permitted recovery gets a new identity');
    f.send({ type: 'ready', page: 0, width: 1000 }); (f.controller as any).recoverWebview();
    assert.equal(reloads, 2, 'third failure cannot create an endless reload loop');
    assert.match(f.messages.at(-1)?.text, /two recovery attempts/);
  } finally { f.controller.dispose(); }
});

test('replacing a failed engine preserves the webview while isolating source epochs and request identities', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 40, 0, 20, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    const retired = f.commands.at(-1)!; const html = f.panel.webview.html;
    const commands: Command[] = [], replacement = { ...f.session, send: (command: Command) => commands.push(command) };
    f.controller.replaceSession(replacement as unknown as TexpressoSession);
    assert.equal(f.panel.webview.html, html, 'engine recovery retains the existing DOM');
    f.controller.handle(['preview-state', 1, 0, 20, false, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    const current = commands.at(-1)!; assert.notEqual(current[1], retired[1]);
    f.controller.handle(['preview-cancelled', Number(retired[1])]);
    assert.equal((f.controller as any).inFlight.id, current[1], 'retired cancellation cannot settle replacement');
    const before = f.messages.filter(m => m.type === 'jump').length;
    f.controller.handle(['preview-forward', 1, 0, 15, 1, 1]);
    assert.equal(f.messages.filter(m => m.type === 'jump').length, before, 'recovery does not steal the retained viewport');
  } finally { f.controller.dispose(); }
});

test('SVG memory rejection persists across source edits without preventing allocation-driven retry', () => {
  const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
  const emit = (id: number, revision: number, sequence: number, mime: 'image/png' | 'image/svg+xml') => f.controller.handle({
    header: { requestId: id, revision, sequence, page: 0, bounds: [0, 0, 600, 800], width: 1000, height: 1333,
      mime, byteLength: 4, vectorCost: 10000 }, bytes: Buffer.alloc(4)
  });
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 1000, allocation: 'old-page-size' }], nearby: [], resident: [0] });
    const first = f.commands.at(-1)!; assert.equal(first[0], 'preview-svg'); emit(Number(first[1]), 1, 0, 'image/svg+xml');
    f.send({ type: 'rasterize', page: 0, id: first[1], reason: 'budget', allocation: 'actual-page-size',
      budget: { available: 100, required: 200, pixels: 150 } });
    let fallback = f.commands.at(-1)!; assert.equal(fallback[0], 'preview-auto'); assert.equal(fallback[6], 0);
    emit(Number(fallback[1]), 1, 0, 'image/png'); f.send({ type: 'decoded', id: fallback[1] });
    for (let sequence = 1; sequence <= 3; sequence++) {
      f.session.previewSequence = sequence; f.controller.handle({ sourceSequence: sequence });
      f.controller.handle(['preview-state', sequence + 1, sequence, 2, true, 0]);
      fallback = f.commands.at(-1)!;
      assert.equal(fallback[0], 'preview-auto', 'minor edits refresh vector metadata through cheap PNG selection');
      assert.equal(fallback[6], 0, 'the same rejected SVG is not exported again');
      emit(Number(fallback[1]), sequence + 1, sequence, 'image/png'); f.send({ type: 'decoded', id: fallback[1] });
    }
    f.send({ type: 'viewport', page: 0, width: 900, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 900, allocation: 'smaller-page-size' }], nearby: [], resident: [0] });
    assert.equal(f.commands.at(-1)?.[0], 'preview-svg', 'changed geometry can retry SVG');
  } finally { f.controller.dispose(); }
});

test('engine replacement preserves SVG controls while probing then adopts the new capabilities', () => {
  const f = fixture(); Object.assign(f.session, { previewSvg: true, previewRegions: true, previewLinks: true });
  try {
    f.controller.handle(['preview-state', 8, 0, 20, true, 0]);
    f.send({ type: 'ready', page: 5, width: 1000, format: 'svg' });
    const html = f.panel.webview.html;
    const replacement = { ...f.session, state: 'starting', previewSvg: false, previewRegions: false, previewLinks: false };
    f.controller.replaceSession(replacement as unknown as TexpressoSession);
    f.controller.update();
    let state = f.messages.filter(message => message.type === 'state').at(-1)!;
    assert.equal(state.svg, true); assert.equal(state.links, true); assert.equal(state.regions, true);
    assert.equal(state.count, 20); assert.equal(state.complete, true, 'pagination does not collapse while probing');
    f.send({ type: 'ready', page: 5, width: 1000, format: 'svg' });
    assert.equal((f.controller as any).format, 'svg', 'ready during probing does not downgrade the saved mode');
    assert.equal(f.panel.webview.html, html, 'same DOM and viewport survive capability negotiation');
    replacement.state = 'running'; Object.assign(replacement, { previewSvg: true });
    f.controller.update(); state = f.messages.filter(message => message.type === 'state').at(-1)!;
    assert.equal(state.svg, true); assert.equal(state.links, false); assert.equal(state.regions, false);
    assert.equal(state.count, 20); assert.equal(state.complete, true, 'retained pagination outlives the capability probe');
    f.controller.handle(['preview-state', 1, 1, 1, false, 0]); f.controller.update();
    assert.equal(f.messages.filter(message => message.type === 'state').at(-1)?.count, 20, 'stale source metadata cannot clear the retained count');
    f.controller.handle(['preview-state', 1, 0, 8, false, 0]);
    state = f.messages.filter(message => message.type === 'state').at(-1)!;
    assert.equal(state.count, 8); assert.equal(state.complete, false, 'first valid replacement state adopts its own pagination');
    replacement.previewSvg = false; f.controller.update();
    assert.equal(f.messages.filter(message => message.type === 'state').at(-1)?.svg, false, 'real capability changes are published after startup');
  } finally { f.controller.dispose(); }
});

test('learned cached SVG cannot replay after rejection, but a same-width allocation change can retry it', () => {
  const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
  const svg = Buffer.from('<svg><path d="M0 0L1 1"/></svg>');
  const emit = (id: number, mime: 'image/png' | 'image/svg+xml') => f.controller.handle({
    header: { requestId: id, revision: 1, sequence: 0, page: 0, bounds: [0, 0, 600, 800], width: 1000, height: 1333,
      mime, byteLength: mime === 'image/png' ? 4 : svg.length, vectorCost: 10000 }, bytes: mime === 'image/png' ? Buffer.alloc(4) : svg
  });
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, format: 'svg', svgDom: true, continuous: true,
      visible: [{ page: 0, width: 1000, allocation: 'small' }], nearby: [], resident: [0] });
    const first = f.commands.at(-1)!; emit(Number(first[1]), 'image/svg+xml');
    let image = f.messages.filter(message => message.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: first[1], svg: image.contentId, cached: [image.contentId], renderMs: 1 });
    const imagesBefore = f.messages.filter(message => message.type === 'image').length;
    f.send({ type: 'rasterize', page: 0, id: first[1], reason: 'budget', allocation: 'small',
      budget: { available: 100, required: 200, pixels: 150 } });
    const fallback = f.commands.at(-1)!;
    assert.notEqual(fallback[1], first[1]); assert.equal(fallback[0], 'preview-auto'); assert.equal(fallback[6], 0);
    assert.equal(f.messages.filter(message => message.type === 'image').length, imagesBefore, 'rejected cached SVG does not consume a second decode credit');
    emit(Number(fallback[1]), 'image/png'); image = f.messages.filter(message => message.type === 'image').at(-1)!;
    f.send({ type: 'decoded', id: fallback[1], cached: [image.contentId] });
    f.send({ type: 'viewport', page: 0, width: 1000, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 1000, allocation: 'large' }], nearby: [], resident: [0] });
    image = f.messages.filter(message => message.type === 'image').at(-1)!;
    assert.equal(image.header.mime, 'image/svg+xml', 'allocation-only change retries the reusable SVG within the same source revision');
    assert.notEqual(image.header.requestId, fallback[1]);
  } finally { f.controller.dispose(); }
});

test('manual SVG retries once after a newly simplified PNG is acknowledged, without retrying minor edits', () => {
  const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
  const emit = (id: number, revision: number, sequence: number, mime: 'image/png' | 'image/svg+xml', vectorCost: number) => f.controller.handle({
    header: { requestId: id, revision, sequence, page: 0, bounds: [0, 0, 600, 800], width: 1000, height: 1333,
      mime, byteLength: 4, vectorCost }, bytes: Buffer.alloc(4)
  });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 1000, allocation: 'fixed' }], nearby: [], resident: [0] });
    const initial = f.commands.at(-1)!; emit(Number(initial[1]), 1, 0, 'image/svg+xml', 10000);
    f.send({ type: 'rasterize', page: 0, id: initial[1], reason: 'budget', allocation: 'fixed',
      budget: { available: 16000, required: 20000, pixels: 8000 } });
    let request = f.commands.at(-1)!; emit(Number(request[1]), 1, 0, 'image/png', 10000);
    f.send({ type: 'decoded', id: request[1] });
    for (const [sequence, cost] of [[1, 9900], [2, 9800], [3, 5000]]) {
      f.session.previewSequence = sequence; f.controller.handle({ sourceSequence: sequence });
      f.controller.handle(['preview-state', sequence + 1, sequence, 1, true, 0]);
      request = f.commands.at(-1)!;
      assert.equal(request[0], 'preview-auto'); assert.equal(request[6], 0);
      const before = f.commands.length;
      emit(Number(request[1]), sequence + 1, sequence, 'image/png', cost);
      assert.equal(f.commands.length, before, 'no second image request before the PNG decode credit is returned');
      f.send({ type: 'decoded', id: request[1] });
      if (cost > 5000) { assert.equal(f.commands.length, before, 'minor edits keep the budget decision without duplicate SVG exports'); }
      else {
        assert.equal(f.commands.length, before + 1);
        const retry = f.commands.at(-1)!; assert.equal(retry[0], 'preview-svg');
        assert.equal(retry[4], sequence + 1); assert.equal(retry[5], sequence, 'retry belongs to the acknowledged source generation');
        emit(Number(retry[1]), sequence + 1, sequence, 'image/svg+xml', cost); f.send({ type: 'decoded', id: retry[1] });
        assert.equal(f.commands.length, before + 1, 'successful retry cannot create a render loop');
      }
    }
  } finally { f.controller.dispose(); }
});

test('capped PNG base width changes cannot create an idle SVG budget retry loop', () => {
  const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
  const bounds: [number, number, number, number] = [0, 0, 595.275574, 841.889709];
  const allocation = '1770:2504:16777216';
  const emit = (id: number, mime: 'image/png' | 'image/svg+xml', width: number) => f.controller.handle({
    header: { requestId: id, revision: 1, sequence: 0, page: 0, bounds, width, height: Math.ceil(width * bounds[3] / bounds[2]),
      mime, byteLength: 4, vectorCost: 79582 }, bytes: Buffer.alloc(4)
  });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1372, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 1372, allocation }], nearby: [], resident: [0] });
    let request = f.commands.at(-1)!; emit(Number(request[1]), 'image/svg+xml', 596);
    f.send({ type: 'rasterize', page: 0, id: request[1], reason: 'budget', allocation,
      budget: { available: 16777216, required: 18995526, pixels: 17728320 } });
    request = f.commands.at(-1)!; emit(Number(request[1]), 'image/png', 1372); f.send({ type: 'decoded', id: request[1] });
    f.send({ type: 'viewport', page: 0, width: 970, format: 'svg', continuous: true,
      visible: [{ page: 0, width: 970, allocation }], nearby: [], resident: [0] });
    request = f.commands.at(-1)!;
    assert.equal(request[0], 'preview-auto'); assert.equal(request[6], 0, 'new PNG cap preserves the rejected SVG allocation');
    emit(Number(request[1]), 'image/png', 970); f.send({ type: 'decoded', id: request[1] });
    const settled = f.commands.length;
    for (let i = 0; i < 8; i++) {
      f.send({ type: 'viewport', page: 0, width: 970, format: 'svg', continuous: true,
        visible: [{ page: 0, width: 970, allocation }], nearby: [], resident: [0] });
    }
    assert.equal(f.commands.length, settled, 'unchanged idle viewport cannot trigger another render or cancellation');
    assert.equal(f.commands.filter(command => command[0] === 'preview-svg').length, 1);
  } finally { f.controller.dispose(); }
});

test('sustained edits admit monotonic foreground snapshots while keeping links, caches and preparation source-current', () => {
  const f = fixture(); let currentDecodes = 0; Object.assign(f.session, { previewLinks: true, previewDecoded: () => currentDecodes++ });
  const emit = (request: Command, sequence: number) => f.controller.handle({ header: {
    requestId: Number(request[1]), revision: sequence + 1, sequence, page: 0, bounds: [0, 0, 600, 800], width: 1000, height: 1333,
    mime: 'image/png', byteLength: 4, annotations: { links: [{ bounds: [1, 1, 10, 10], uri: 'https://example.com' }], destinations: [] }
  }, bytes: Buffer.from([sequence, 0, 0, 0]) });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, continuous: true, visible: [{ page: 0, width: 1000 }], nearby: [] });
    for (let sequence = 0; sequence < 4; sequence++) {
      const request = f.commands.at(-1)!;
      f.session.previewSequence = sequence + 1; f.controller.handle({ sourceSequence: sequence + 1 });
      f.controller.handle(['preview-state', sequence + 2, sequence + 1, 1, true, 0]);
      emit(request, sequence);
      const image = f.messages.filter(message => message.type === 'image').at(-1)!;
      assert.equal(image.header.sequence, sequence); assert.equal(image.visualOnly, true);
      assert.equal(image.target, undefined); assert.equal(image.destination, undefined);
      const count = f.commands.length;
      f.send({ type: 'link', page: 0, revision: sequence + 1, sequence, index: 0 });
      f.send({ type: 'inverse', page: 0, revision: sequence + 1, sequence, x: 5, y: 5 });
      f.send({ type: 'detail', page: 0, revision: sequence + 1, sequence, token: 1, bounds: [0, 0, 10, 10], width: 100 });
      assert.equal(f.commands.length, count); assert.equal(f.opened.length, 0);
      f.send({ type: 'decoded', id: request[1], displayed: true, stale: true });
      assert.equal(f.commands.length, count + 1, 'newest source starts immediately after visual progress acknowledgment');
      assert.equal((f.controller as any).pages.size, 0); assert.equal((f.controller as any).rasterPages.size, 0);
      assert.equal((f.controller as any).visualSnapshots.get(0).sequence, sequence);
    }
    assert.equal(currentDecodes, 0, 'visual progress never acknowledges current-source readiness');
    const current = f.commands.at(-1)!; emit(current, 4);
    f.send({ type: 'decoded', id: current[1], displayed: true, stale: false });
    assert.equal(currentDecodes, 1);
  } finally { f.controller.dispose(); }
});

test('older-source progress is rejected after away-and-back page, width or rendering intent changes', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.send({ type: 'viewport', page: 1, width: 1000 }); f.send({ type: 'viewport', page: 0, width: 1000 }); },
    (f: ReturnType<typeof fixture>) => { f.send({ type: 'viewport', page: 0, width: 1200 }); f.send({ type: 'viewport', page: 0, width: 1000 }); },
    (f: ReturnType<typeof fixture>) => { f.send({ type: 'viewport', page: 0, width: 1000, format: 'png' }); f.send({ type: 'viewport', page: 0, width: 1000 }); }
  ]) {
    const f = fixture();
    try {
      f.controller.handle(['preview-state', 1, 0, 2, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
      const old = f.commands.at(-1)!;
      f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); change(f);
      f.controller.handle(['preview-state', 2, 1, 2, true, 0]);
      f.controller.handle({ header: { requestId: Number(old[1]), revision: 1, sequence: 0, page: 0,
        bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
      assert.equal(f.messages.filter(message => message.type === 'image').length, 0, 'returning to equal dimensions does not revive retired work');
      assert.equal(f.commands.at(-1)?.[5], 1, 'retired frame yields credit to the latest source');
    } finally { f.controller.dispose(); }
  }
});

test('an image invalidated during browser decode cannot report current-source readiness', () => {
  const f = fixture(); let ready = 0; Object.assign(f.session, { previewDecoded: () => ready++ });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    f.controller.handle({ header: { requestId: 1, revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
    f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); f.controller.handle(['preview-state', 2, 1, 1, true, 0]);
    f.send({ type: 'decoded', id: 1, displayed: true, stale: true });
    assert.equal(ready, 0); assert.equal(f.commands.at(-1)?.[5], 1);
    const current = f.commands.at(-1)![1];
    f.send({ type: 'decoded', id: 1, displayed: true, stale: false });
    assert.equal((f.controller as any).inFlight.id, current, 'very late ACK cannot consume newer frame credit');
  } finally { f.controller.dispose(); }
});


test('hiding retires an already decoding browser frame without letting its ACK release restored credit', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    const old = f.commands.at(-1)!;
    f.controller.handle({ header: { requestId: Number(old[1]), revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
    f.panel.visible = false; f.view();
    const invalidation = f.messages.at(-1)!;
    assert.equal(invalidation.type, 'invalidate'); assert.equal(invalidation.retire, true);
    assert.equal(invalidation.sequence, 0); assert.equal(invalidation.revision, 1);
    f.panel.visible = true; f.view(); f.send({ type: 'ready', page: 0, width: 1000 });
    const restored = (f.controller as any).inFlight.id; assert.notEqual(restored, old[1]);
    f.send({ type: 'decoded', id: old[1], displayed: false, stale: true });
    assert.equal((f.controller as any).inFlight.id, restored);
  } finally { f.controller.dispose(); }
});

test('older-revision visual progress cannot enable queued interactions in the same source sequence', () => {
  const f = fixture(); Object.assign(f.session, { previewLinks: true, previewRegions: true });
  try {
    f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
    f.send({ type: 'ready', page: 0, width: 1000, continuous: true, visible: [{ page: 0, width: 1000 }], nearby: [] });
    const request = f.commands.at(-1)!;
    f.controller.handle(['preview-state', 2, 0, 1, true, 0]);
    f.controller.handle({ header: { requestId: Number(request[1]), revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime: 'image/png', byteLength: 4,
      annotations: { links: [{ bounds: [1, 1, 10, 10], uri: 'https://example.com' }], destinations: [] } }, bytes: Buffer.alloc(4) });
    assert.equal(f.messages.filter(message => message.type === 'image').at(-1)!.visualOnly, true);
    const count = f.commands.length;
    f.send({ type: 'link', page: 0, revision: 1, sequence: 0, index: 0 });
    f.send({ type: 'inverse', page: 0, revision: 1, sequence: 0, x: 5, y: 5 });
    for (const type of ['region', 'detail']) { f.send({ type, page: 0, revision: 1, sequence: 0, token: 1, bounds: [0, 0, 10, 10], width: 100 }); }
    assert.equal(f.opened.length, 0); assert.equal(f.commands.length, count);
    assert.equal((f.controller as any).inverse, undefined); assert.equal((f.controller as any).region, undefined);
    assert.equal((f.controller as any).detail, undefined);
  } finally { f.controller.dispose(); }
});


test('obsolete browser failures release credit without poisoning new source or codec decisions', () => {
  for (const mime of ['image/png', 'image/svg+xml'] as const) {
    for (const type of ['decode-error', 'rasterize', 'cache-miss']) {
      for (const sequenceChange of [true, false]) {
        const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
        try {
          f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
          f.send({ type: 'ready', page: 0, width: 1000, format: mime === 'image/png' ? 'png' : 'svg', continuous: true,
            visible: [{ page: 0, width: 1000, allocation: 'same' }], nearby: [] });
          const obsolete = f.commands.at(-1)!;
          f.controller.handle({ header: { requestId: Number(obsolete[1]), revision: 1, sequence: 0, page: 0,
            bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime, byteLength: 4 }, bytes: Buffer.alloc(4) });
          if (sequenceChange) { f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 }); }
          f.controller.handle(['preview-state', 2, sequenceChange ? 1 : 0, 1, true, 0]);
          const before = f.commands.length;
          f.send({ type, page: 0, id: obsolete[1], reason: 'decode', allocation: 'same', pngUnsupported: true,
            budget: { available: 100, required: 200, pixels: 150 } });
          assert.equal(f.messages.filter(message => message.type === 'error').length, 0);
          assert.equal((f.controller as any).failed.size, 0); assert.equal((f.controller as any).svgFailures.size, 0);
          assert.equal((f.controller as any).svgDecodeFailed, false); assert.equal((f.controller as any).fallback.has(0), false);
          assert.equal((f.controller as any).autoPages.size, 0);
          assert.equal(f.commands.length, before + 1, 'latest source gets the returned decode credit');
          assert.equal(f.commands.at(-1)![4], 2); assert.equal(f.commands.at(-1)![5], sequenceChange ? 1 : 0);
          assert.equal(f.commands.at(-1)![0], mime === 'image/png' ? 'preview-render' : 'preview-svg');
        } finally { f.controller.dispose(); }
      }
    }
  }
});

test('obsolete viewport decode failures cannot fail the newly navigated page', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 2, true, 0]); f.send({ type: 'ready', page: 0, width: 1000 });
    f.controller.handle(cachedFrame(1)); f.send({ type: 'viewport', page: 1, width: 1000 });
    f.send({ type: 'decode-error', id: 1 });
    assert.equal(f.messages.filter(message => message.type === 'error').length, 0);
    assert.equal((f.controller as any).failed.size, 0); assert.equal(f.commands.at(-1)![2], 1);
  } finally { f.controller.dispose(); }
});


test('late SVG budget evidence survives source edits only for unchanged physical view intent', () => {
  for (const changeView of [false, true]) {
    const f = fixture(); Object.assign(f.session, { previewSvg: true, previewAuto: true });
    try {
      f.controller.handle(['preview-state', 1, 0, 1, true, 0]);
      f.send({ type: 'ready', page: 0, width: 1000, format: 'svg', continuous: true,
        visible: [{ page: 0, width: 1000, allocation: 'same' }], nearby: [] });
      const obsolete = f.commands.at(-1)!;
      f.controller.handle({ header: { requestId: Number(obsolete[1]), revision: 1, sequence: 0, page: 0,
        bounds: [0, 0, 600, 800], width: 1000, height: 1333, mime: 'image/svg+xml', byteLength: 4 }, bytes: Buffer.alloc(4) });
      f.session.previewSequence = 1; f.controller.handle({ sourceSequence: 1 });
      f.controller.handle(['preview-state', 2, 1, 1, true, 0]);
      if (changeView) { f.send({ type: 'viewport', page: 0, width: 900, format: 'svg', continuous: true,
        visible: [{ page: 0, width: 900, allocation: 'different' }], nearby: [] }); }
      f.send({ type: 'rasterize', page: 0, id: obsolete[1], reason: 'budget', allocation: 'same',
        budget: { available: 100, required: 200, pixels: 150 } });
      assert.equal((f.controller as any).fallback.has(0), !changeView);
      assert.equal((f.controller as any).autoPages.size, 0); assert.equal((f.controller as any).failed.size, 0);
      assert.equal(f.messages.filter(message => message.type === 'error').length, 0);
      assert.equal(f.commands.at(-1)![5], 1, 'new source resumes after old decode credit is returned');
      assert.equal(f.commands.at(-1)![0], changeView ? 'preview-svg' : 'preview-auto');
      if (!changeView) { assert.equal(f.commands.at(-1)![6], 0); }
    } finally { f.controller.dispose(); }
  }
});
