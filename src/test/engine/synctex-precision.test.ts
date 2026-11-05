import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import { config, document } from '../helpers';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';

const binary = process.env.TEXPRESSO_BINARY;
test('real precision engine distinguishes words and ligatures, and inverses cached nonforeground pages without images',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-precise-')));
    const text = '\\documentclass{article}\n\\pagestyle{empty}\n\\begin{document}\n' +
      '\\noindent Café office target.\\par\n\\newpage\nA separate cached page.\\par\n\\end{document}\n';
    const main = document(path.join(root, 'café source.tex'), text); await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, debug = '', id = 0, images = 0;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const forwards: Extract<PreviewMessage, ['preview-forward', ...unknown[]]>[] = [];
    const reveals: { file: string; line: number; column?: number; word?: string }[] = [];
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', watchDependencies: false },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, error: e => { failure = e; }, debug: value => { debug = (debug + value).slice(-16000); },
        synctex: (file, line, column, word) => reveals.push({ file, line, column, word }),
        preview: event => {
          if ('header' in event) { images++; frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-forward') { forwards.push(event); }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          }
        }
      });
    const until = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 25000;
      while (!check()) {
        if (failure || Date.now() > deadline) { throw failure || new Error(label + '\n' + debug); }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const render = async (page: number) => {
      for (let i = 0; i < 20; i++) {
        await until(() => !!state && state[2] === session.previewSequence, 'source state');
        const request = ++id;
        session.send(['preview-render', request, page, 900, state![1], state![2]]);
        await until(() => frames.has(request) || retries.has(request), 'render ' + page);
        if (frames.has(request)) { return frames.get(request)!; }
      }
      throw new Error('render retries exceeded');
    };
    try {
      await session.start();
      if (!session.previewSynctexPrecision) { t.skip('External engine does not advertise precision'); return; }
      await render(0); await render(1);
      const line = text.split('\n')[3];
      const forward = async (word: string) => {
        const before = forwards.length;
        session.syncForward(main, 3, line.indexOf(word) + 2);
        await until(() => forwards.length > before, 'precise forward ' + word);
        return forwards.at(-1)!;
      };
      const office = await forward('office'), target = await forward('target');
      assert.equal(office[3], 0); assert.equal(target[3], 0);
      assert.ok(office[6]?.length, 'ligature word supplies actual geometry');
      assert.ok(target[6]?.length, 'same source line supplies distinct word geometry');
      assert.ok(office[6]![0][2] <= target[6]![0][0], 'word hints improve horizontal precision on the same source line');
      const legacy = forwards.length; session.sync.syncForward(main, 3);
      await until(() => forwards.length > legacy, 'legacy forward');
      assert.equal(forwards.at(-1)!.length, 6, 'legacy replies remain unchanged');
      // Make page one the foreground renderer while retaining page zero's map/text.
      await render(1); const beforeImages = images;
      const b = office[6]![0];
      session.inversePrecise(state![1], session.previewSequence, 0, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, () => true);
      await until(() => reveals.length > 0, 'cached page inverse');
      assert.equal(await fs.realpath(reveals[0].file), main.fileName);
      assert.equal(reveals[0].word, 'office', 'multi-codepoint glyphs survive inverse text recovery');
      assert.equal(images, beforeImages, 'cached inverse does not export another page image');
      assert.equal(state![5], 1, 'cached inverse does not switch the native foreground page');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
