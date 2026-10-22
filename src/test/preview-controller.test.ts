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
  const instance = panel.webview.html.match(/data-instance="([^"]+)"/)![1];
  return { controller, panel, session, messages, commands, opened, stops: () => stops,
    send: (m: object) => receive({ instance, ...m }), view: () => view() };
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

test('preview rejects stale source images and coordinates, and restores a hidden panel with a fresh request', () => {
  const f = fixture();
  try {
    f.controller.handle(['preview-state', 1, 0, 1, false, 0]);
    f.send({ type: 'ready', page: 0, width: 1000 });
    f.session.previewSequence = 1;
    f.controller.handle({ sourceSequence: 1 });
    f.controller.handle({ header: { requestId: 1, revision: 1, sequence: 0, page: 0,
      bounds: [0, 0, 612, 792], width: 1000, height: 1295, mime: 'image/png', byteLength: 4 }, bytes: Buffer.alloc(4) });
    assert.equal(f.messages.filter(m => m.type === 'image').length, 0);
    assert.equal(f.commands.length, 1, 'wait for the engine to acknowledge new source');
    f.controller.handle(['preview-state', 3, 1, 1, false, 0]);
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
