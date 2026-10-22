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
test('background PNG/SVG/Auto preserve the foreground raster, foreground demand and cancellation',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-preview-background-')));
    const text = String.raw`\documentclass{article}
\begin{document}
First page foreground.\par
\newpage
Second page for background rendering.\par
\newpage
Third page is not needed yet.
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), text); await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, debug = '', id = 0;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const states: Extract<PreviewMessage, ['preview-state', ...unknown[]]>[] = [];
    const targets: Extract<PreviewMessage, ['preview-forward', ...unknown[]]>[] = [];
    const words: string[] = [];
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex: (_file, _line, _column, word) => { if (word) { words.push(word); } }, debug: s => { debug = (debug + s).slice(-15000); }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; states.push(event); }
            if (event[0] === 'preview-forward') { targets.push(event); }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          } }
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 25000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    const render = async (base: number, background?: 0 | 1 | 2) => {
      for (;;) {
        await until(() => !!state && state[2] === session.previewSequence); const request = ++id;
        if (background === undefined) { session.send(['preview-png', request, 0, 1000, state![1], state![2], base]); }
        else { session.send(['preview-background', request, 1, 1000, state![1], state![2], background, 200000]); }
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; }
      }
    };
    try {
      await session.start(); assert.equal(session.previewBackground, true);
      const original = await render(0); let base = original.header.rasterId!;
      for (const codec of [0, 1, 2] as const) {
        const start = states.length, frame = await render(0, codec);
        assert.equal(frame.header.page, 1); assert.equal(frame.header.mime, codec === 0 ? 'image/png' : 'image/svg+xml');
        assert.equal(frame.header.patch, undefined); assert.equal(frame.header.rasterId, undefined, 'background never claims comparison-base ownership');
        assert.ok(frame.bytes.length > 0);
        assert.ok(states.slice(start).every(event => event[5] === 0), 'compiler speculation does not change foreground navigation');
        const foreground = await render(base);
        assert.equal(foreground.header.patch?.base, base, 'background export preserves the native foreground raster ID');
        assert.deepEqual(foreground.header.patch?.rect, [0, 0, 0, 0]);
        assert.equal(foreground.bytes.length, 0); base = foreground.header.rasterId!;
      }
      session.sync.syncForward(main, 2); await until(() => targets.length > 0);
      const target = targets[0]; assert.equal(target[3], 0);
      session.send(['pause']);
      const obsolete = ++id;
      session.send(['preview-background', obsolete, 50, 1000, state![1] - 1, state![2], 0, 0]);
      await until(() => retries.has(obsolete)); assert.ok(!frames.has(obsolete));
      const interrupted = ++id;
      session.send(['preview-background', interrupted, 50, 1000, state![1], state![2], 0, 0]);
      session.send(['preview-inverse', target[1], target[2], 0, target[4], target[5]]);
      await until(() => words.length > 0 && retries.has(interrupted));
      assert.match(words[0], /First|page|foreground/, 'inverse search retains the foreground display list');
      assert.ok(!frames.has(interrupted));
      const canceled = ++id;
      session.send(['preview-background', canceled, 50, 1000, state![1], state![2], 0, 0]);
      session.send(['preview-cancel', canceled, 0]);
      const recovered = await render(base);
      assert.equal(recovered.header.patch?.base, base);
      assert.equal(recovered.bytes.length, 0);
      assert.ok(!frames.has(canceled), 'cancel retargets demand without exporting an extra page');
      // id=0 also retargets cached navigation without requesting an image.
      session.send(['preview-cancel', 0, 1]);
      session.send(['preview-cancel', 0, 0]);
      const returned = await render(recovered.header.rasterId!);
      assert.equal(returned.bytes.length, 0); assert.ok(!frames.has(canceled));
      session.send(['resume']);
      assert.ok(!debug.includes('[fatal]'));
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
