import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
test('TikZ dashed paths render and update on a later page in both PNG and SVG',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-preview-dashes-')));
    let text = String.raw`\documentclass{article}
\usepackage{tikz}
\begin{document}
First page.
\newpage
\begin{tikzpicture}
\draw[densely dashed,line width=1pt] (0,0) -- (5,0);
\draw[densely dotted,line width=1pt] (0,1) -- (5,1);
\draw[dash pattern=on 2pt off 3pt on 4pt off 5pt,line width=1pt] (0,2) -- (5,2);
\draw[solid,line width=1pt] (0,3) -- (5,3);
\end{tikzpicture}
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), text); main.getText = () => text;
    await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, debug = '', id = 0;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex() {}, debug: s => { debug = (debug + s).slice(-10000); }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          } }
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 25000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    const render = async (page: number, svg = false) => {
      for (;;) {
        await until(() => !!state && state[2] === session.previewSequence); const request = ++id;
        session.send([svg ? 'preview-svg' : 'preview-render', request, page, 1000, state![1], state![2]]);
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; }
      }
    };
    try {
      await session.start(); await render(0);
      const png = await render(1); assert.equal(png.header.mime, 'image/png');
      const svg = await render(1, true); assert.equal(svg.header.mime, 'image/svg+xml');
      assert.match(svg.bytes.toString(), /stroke-dasharray/, 'SVG preserves dashed geometry');
      const offset = text.indexOf('densely dashed'); text = text.replace('densely dashed', 'densely dotted');
      session.sync.change(main, [{ rangeOffset: offset, rangeLength: 14, text: 'densely dotted',
        range: { start: { line: 6, character: 6 }, end: { line: 6, character: 20 } } as import('vscode').Range }]);
      const changed = await render(1); assert.notDeepEqual(changed.bytes, png.bytes, 'edited dash style changes rendered pixels');
      const changedSvg = await render(1, true); assert.match(changedSvg.bytes.toString(), /stroke-dasharray/);
      assert.ok(!debug.includes('[fatal]'));
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
