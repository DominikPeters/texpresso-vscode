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
test('Beamer navigation annotations are valid JSON without a stream adapter',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 120000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-annotations-')));
    const main = document(path.join(root, 'slides.tex'), String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Navigation}
An ordinary slide with navigation icons and a \hyperlink{later}{link}.
\end{frame}
\begin{frame}[label=later]{Destination}Another slide.\end{frame}
\end{document}
`);
    await fs.writeFile(main.fileName, main.getText());
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    let failure: Error | undefined, debug = '';
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex() {}, debug: s => { debug = (debug + s).slice(-12000); },
        error: e => { failure = e; }, preview: event => {
          if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          }
        }
      });
    const until = async (condition: () => boolean, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (!condition()) {
        if (failure || Date.now() > deadline) { throw failure || new Error('Annotation frame timeout\n' + debug); }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    };
    try {
      await session.start(); await until(() => !!state);
      for (const [index, verb] of (['preview-render', 'preview-svg'] as const).entries()) {
        let frame: PreviewImage | undefined;
        for (let attempt = 0; attempt < 20 && !frame; attempt++) {
          const id = index * 100 + attempt + 1;
          session.send([verb, id, 0, 1200, state![1], state![2]]);
          // This is the first engine test: fresh TeX Live installations may
          // build font maps and the XeLaTeX format before compiling Beamer.
          // Keep ordinary subsequent exports bounded separately from bootstrap.
          await until(() => frames.has(id) || retries.has(id), index === 0 ? 60000 : 20000); frame = frames.get(id);
        }
        assert.ok(frame, 'current frame reaches the production JSON parser');
        assert.ok(frame.header.annotations?.links.length, 'Beamer navigation links are retained');
        assert.ok(frame.header.annotations.links.every(link => link.bounds.every(Number.isFinite)));
        assert.ok(frame.header.annotations.destinations.every(d => Number.isFinite(d.x) && Number.isFinite(d.y)));
      }
      assert.doesNotMatch(debug, /LaTeX Error|Package .*Error:/);
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
