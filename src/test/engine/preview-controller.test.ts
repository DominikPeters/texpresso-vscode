import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import { PreviewController } from '../../preview-controller';
import type { Command } from '../../protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
for (const format of ['png', 'svg', 'auto'] as const) {
test('real controller revisits cached pages without native work and prepares the correct page for inverse SyncTeX (' + format + ')',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-page-cache-')));
    const main = document(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nFirst page target.\\par\n\\newpage\nSecond page target.\\par\n\\end{document}\n');
    await fs.writeFile(main.fileName, main.getText());
    let receive!: (message: unknown) => void, controller: PreviewController | undefined, failure: Error | undefined, debug = '';
    const messages: Record<string, any>[] = [], commands: Command[] = [], targets: number[][] = [], sources: { line: number; word?: string }[] = [];
    const panel = { visible: true, webview: { html: '', cspSource: 'local:', asWebviewUri: () => 'local:/asset',
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; },
      postMessage: async (message: Record<string, any>) => { messages.push(message); return true; } },
    onDidChangeViewState() {}, onDidDispose() {}, dispose() {} };
    const api = { Uri: { joinPath: () => ({}) }, ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => panel } };
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, debug: text => { debug = (debug + text).slice(-100000); }, error: error => { failure = error; },
        synctex: (_file, line, _column, word) => sources.push({ line, word }),
        preview: event => {
          if (Array.isArray(event) && event[0] === 'preview-forward') { targets.push(event.slice(1) as number[]); }
          controller?.handle(event);
        }
      });
    const originalSend = session.send.bind(session);
    session.send = command => { commands.push(command); originalSend(command); };
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 30000;
      while (!check()) {
        if (failure || Date.now() > deadline) { throw failure || new Error('Cache controller timeout\n' + debug.slice(-5000)); }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await session.start();
      controller = new PreviewController(api as unknown as typeof vscode, {} as vscode.Uri, session, () => {}, () => {});
      const instance = panel.webview.html.match(/data-instance="([^"]+)"/)![1];
      const send = (message: object) => receive({ instance, ...message });
      send({ type: 'ready', page: 0, width: 1200, format, svgDom: format !== 'png' });
      await until(() => messages.some(m => m.type === 'image'));
      const first = messages.filter(m => m.type === 'image').at(-1)!;
      if (format !== 'png') { assert.equal(first.inlineSvg, true); }
      send({ type: 'decoded', id: first.header.requestId, svg: first.inlineSvg ? first.contentId : undefined, cached: [first.contentId] });
      session.sync.syncForward(main, 2); await until(() => targets.length > 0);
      const point = targets[0];
      send({ type: 'viewport', page: 1, width: 1200, format });
      await until(() => messages.filter(m => m.type === 'image').length >= 2);
      const second = messages.filter(m => m.type === 'image').at(-1)!;
      send({ type: 'decoded', id: second.header.requestId, svg: second.inlineSvg ? second.contentId : undefined, cached: [first.contentId, second.contentId] });
      const nativeRenders = () => commands.filter(c => c[0] === 'preview-render' || c[0] === 'preview-svg' || c[0] === 'preview-auto').length;
      const before = nativeRenders();
      send({ type: 'viewport', page: 0, width: 1200, format });
      const cached = messages.filter(m => m.type === 'image').at(-1)!;
      assert.equal(cached.header.page, 0); assert.equal(cached.bytes, undefined); assert.equal(nativeRenders(), before);
      send({ type: 'decoded', id: cached.header.requestId, svg: cached.inlineSvg ? cached.contentId : undefined, cached: [first.contentId, second.contentId] });
      send({ type: 'inverse', revision: cached.header.revision, sequence: cached.header.sequence, page: 0, x: point[3], y: point[4] });
      await until(() => sources.length > 0);
      assert.equal(nativeRenders(), before + 1, 'only inverse search requests native page preparation');
      assert.equal(sources[0].line, 3); assert.match(sources[0].word || '', /First|page|target/);
      assert.doesNotMatch(debug, /\[fatal\]/);
    } finally { controller?.dispose(); await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });

}
