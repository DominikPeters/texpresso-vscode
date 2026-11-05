import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
test('full-page text bounds survive codecs, resizing and PNG patches, excluding blank and graphics-only pages',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-text-bounds-')));
    let text = String.raw`\documentclass{article}
\usepackage[margin=30mm]{geometry}
\pagestyle{empty}
\begin{document}
\noindent Text width aaaa.\par
\noindent\rule{400pt}{10pt}
\newpage
\noindent\rule{400pt}{10pt}
\newpage
\null
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), text);
    main.getText = () => text;
    await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    let failure: Error | undefined, debug = '', id = 0;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main,
      { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', watchDependencies: false },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex() {}, error: error => { failure = error; },
        debug: value => { debug = (debug + value).slice(-10000); },
        preview: event => {
          if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          }
        }
      });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 25000;
      while (!check()) {
        if (failure || Date.now() > deadline) { throw failure || new Error('Text bounds timeout\n' + debug); }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const render = async (codec: 'png' | 'svg', page = 0, width = 1000, base = 0) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await until(() => !!state && state[2] === session.previewSequence);
        const request = ++id;
        if (codec === 'png') { session.send(['preview-png', request, page, width, state![1], state![2], base]); }
        else { session.send(['preview-svg', request, page, width, state![1], state![2]]); }
        await until(() => frames.has(request) || retries.has(request));
        if (frames.has(request)) { return frames.get(request)!; }
      }
      throw new Error('Too many obsolete text-bounds requests');
    };
    try {
      await session.start();
      const first = await render('png'), bounds = first.header.textBounds;
      assert.equal(first.header.mime, 'image/png');
      assert.ok(bounds, 'a text page exports text geometry');
      assert.ok(bounds.every(Number.isFinite), 'text geometry is finite in page coordinates');
      assert.ok(bounds[2] - bounds[0] > 20 && bounds[2] - bounds[0] < 150,
        'the 400pt figure must not widen the short line of text');
      const noop = await render('png', 0, 1000, first.header.rasterId);
      assert.equal(noop.bytes.length, 0);
      assert.deepEqual(noop.header.patch?.rect, [0, 0, 0, 0]);
      assert.deepEqual(noop.header.textBounds, bounds, 'metadata remains available without image bytes');
      const svg = await render('svg');
      assert.equal(svg.header.mime, 'image/svg+xml');
      assert.deepEqual(svg.header.textBounds, bounds);
      assert.deepEqual((await render('png', 0, 1200)).header.textBounds, bounds,
        'text bounds stay in page coordinates rather than render pixels');
      const regionId = ++id;
      session.send(['preview-region', regionId, 0, 300, state![1], state![2], ...bounds]);
      await until(() => frames.has(regionId));
      assert.equal(frames.get(regionId)!.header.textBounds, undefined);
      const base = await render('png');
      const offset = text.indexOf('aaaa'), before = text.slice(0, offset);
      const position = { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
      const range = { start: position, end: { ...position, character: position.character + 4 } };
      text = text.slice(0, offset) + 'aaaaX' + text.slice(offset + 4);
      session.sync.change(main, [{ range: range as vscode.Range, rangeOffset: offset, rangeLength: 4, text: 'aaaaX' }]);
      const patch = await render('png', 0, 1000, base.header.rasterId);
      assert.ok(patch.header.patch && patch.bytes.length > 0, 'the edit produces an actual dirty rectangle');
      assert.ok(patch.header.textBounds && patch.header.textBounds[2] > bounds[2],
        'changed display-list content invalidates cached text geometry');
      assert.equal(patch.header.textBounds[0], bounds[0]);
      assert.deepEqual((await render('svg')).header.textBounds, patch.header.textBounds,
        'PNG patches describe the full page, not their cropped image payload');
      for (const page of [1, 2]) {
        assert.equal((await render('png', page)).header.textBounds, undefined);
        assert.equal((await render('svg', page)).header.textBounds, undefined);
      }
    } finally {
      await session.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
