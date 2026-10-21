import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { TexpressoSession } from '../session';
import type { Command } from '../protocol';
import { PreviewController } from '../preview-controller';

function fixture() {
  let receive!: (value: unknown) => void, view!: () => void, closed!: () => void;
  let stops = 0;
  const messages: Record<string, any>[] = [], commands: Command[] = [];
  const panel = { visible: true,
    webview: { html: '', cspSource: 'local:', asWebviewUri: () => 'local:/asset',
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; },
      postMessage: async (message: Record<string, any>) => { messages.push(message); return true; } },
    onDidChangeViewState: (callback: () => void) => { view = callback; },
    onDidDispose: (callback: () => void) => { closed = callback; }, dispose: () => closed() };
  const api = { Uri: { joinPath: () => ({}) }, ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => panel } };
  const session = { embedded: true, state: 'running', paused: false, previewSequence: 0,
    document: { fileName: '/work/main.tex' }, send: (command: Command) => commands.push(command) };
  const controller = new PreviewController(api as unknown as typeof vscode, {} as vscode.Uri,
    session as unknown as TexpressoSession, () => { stops++; }, () => {});
  const instance = panel.webview.html.match(/data-instance="([^"]+)"/)![1];
  return { controller, panel, session, messages, commands, stops: () => stops,
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
