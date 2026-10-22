import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';
import { diagnostics } from './diagnostics';

const binary = process.env.TEXPRESSO_BINARY;
for (const streamFiles of [false, true]) {
  test('real headless preview: PNG, zoom, page demand, both SyncTeX directions and unsaved edits' + (streamFiles ? ' (stream)' : ''),
    { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-preview-')));
      let contents = '\\documentclass{article}\n\\begin{document}\nFirst page.\n\\newpage\n\\typeout{SECOND-PAGE}\nSecond page target.\\par\n\\end{document}\n';
      const main = document(path.join(root, 'main.tex'), contents);
      main.getText = () => contents;
      await fs.writeFile(main.fileName, contents);
      let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
      const images = new Map<number, PreviewImage>(), retries = new Set<number>();
      const targets: Extract<PreviewMessage, ['preview-forward', ...unknown[]]>[] = [];
      const sources: { file: string; line: number; word?: string }[] = [];
      let failure: Error | undefined, debug = '', output = '', id = 0;
      const originalVideo = process.env.SDL_VIDEODRIVER;
      // This engine must work even when no video driver can be initialized.
      process.env.SDL_VIDEODRIVER = 'texpresso-no-video-driver';
      const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive',
        previewLocation: 'editor', streamFiles }, new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output: (target, text) => { if (target === 'out') { output = text; } },
        debug: text => { debug = (debug + text).slice(-100000); }, error: error => { failure = error; },
        synctex: (file, line, _column, word) => sources.push({ file, line, word }),
        preview: event => {
          if ('header' in event) { images.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-forward') { targets.push(event); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          }
        }
      });
      const until = async (check: () => boolean, timeout = 25000) => {
        const end = Date.now() + timeout;
        while (!check()) {
          if (failure || Date.now() > end) { throw failure || new Error('Preview timeout\n' + debug.slice(-5000)); }
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      };
      const render = async (page: number, width: number): Promise<PreviewImage> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          await until(() => !!state && state[2] === session.previewSequence, 60000);
          const request = ++id;
          session.send(['preview-render', request, page, width, state![1], state![2]]);
          await until(() => images.has(request) || retries.has(request));
          if (images.has(request)) { return images.get(request)!; }
        }
        throw new Error('Too many obsolete render requests');
      };
      try {
        await session.start(); assert.equal(session.embedded, true); assert.equal(session.previewRegions, true);
        const first = await render(0, 1200);
        assert.deepEqual(first.bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
        assert.equal(first.header.sequence, session.previewSequence);
        assert.equal(first.header.page, 0);
        const zoomed = await render(0, 4096);
        assert.ok(zoomed.header.width > first.header.width);
        assert.ok(zoomed.header.width * zoomed.header.height <= 4000000, 'native pixel budget');
        const regionId = ++id;
        session.send(['preview-region', regionId, 0, 480, zoomed.header.revision, zoomed.header.sequence, 60, 60, 120, 120]);
        await until(() => images.has(regionId));
        const region = images.get(regionId)!;
        assert.deepEqual(region.header.bounds, [60, 60, 120, 120]);
        assert.ok(region.header.width >= 478 && region.header.width <= 481);
        assert.ok(region.header.width * region.header.height < 240000, 'loupe only rasterizes the requested area');
        const second = await render(1, 1200);
        assert.equal(second.header.page, 1); assert.match(output, /SECOND-PAGE/);
        session.sync.syncForward(main, 5);
        await until(() => targets.some(target => target[3] === 1));
        const target = targets.find(target => target[3] === 1)!;
        session.send(['preview-inverse', target[1], target[2], target[3], target[4], target[5]]);
        await until(() => sources.length > 0);
        assert.equal(sources[0].file, main.fileName); assert.equal(sources[0].line, 6);
        assert.ok(sources[0].word && /Second|page|target/.test(sources[0].word), 'inverse lookup includes the clicked word');

        const previousSources = sources.length;
        contents = contents.replace('First page.', 'Edited first page.');
        session.sync.change(main, [{ rangeOffset: main.getText().indexOf('Edited first page.'), rangeLength: 11,
          text: 'Edited first page.', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 11 } }
        } as import('vscode').TextDocumentContentChangeEvent]);
        session.send(['preview-inverse', target[1], target[2], target[3], target[4], target[5]]);
        const edited = await render(0, 1200);
        assert.ok(edited.header.revision > first.header.revision);
        assert.ok(edited.header.sequence > first.header.sequence);
        assert.notDeepEqual(edited.bytes, first.bytes, 'unsaved edit changes the preview');
        assert.equal(sources.length, previousSources, 'stale inverse SyncTeX was rejected');
        assert.doesNotMatch(debug, /\[fatal\]|Window could not|SDL could not initialize/);
      } catch (error) {
        await diagnostics(root, output, debug); throw error;
      } finally {
        await session.dispose();
        if (originalVideo === undefined) { delete process.env.SDL_VIDEODRIVER; } else { process.env.SDL_VIDEODRIVER = originalVideo; }
        await fs.rm(root, { recursive: true, force: true });
      }
    });
}

test('real headless SyncTeX targets prose records above and below their baselines instead of paragraph/page containers',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-hit-')));
    const contents = await fs.readFile(path.resolve(__dirname, '../../../scripts/preview-demo/sample.tex'), 'utf8');
    const main = document(path.join(root, 'sample.tex'), contents);
    await fs.writeFile(main.fileName, contents);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    let frame: PreviewImage | undefined;
    const retries = new Set<number>();
    const targets: Extract<PreviewMessage, ['preview-forward', ...unknown[]]>[] = [];
    const sources: { line: number; word?: string }[] = [];
    let failure: Error | undefined, debug = '', id = 0;
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, debug: text => { debug = (debug + text).slice(-100000); }, error: error => { failure = error; },
        synctex: (_file, line, _column, word) => sources.push({ line, word }),
        preview: event => {
          if ('header' in event) { frame = event; }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
            if (event[0] === 'preview-forward') { targets.push(event); }
          }
        }
      });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 30000;
      while (!check()) {
        if (failure || Date.now() > deadline) { throw failure || new Error('SyncTeX hit timeout\n' + debug.slice(-5000)); }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    };
    try {
      await session.start();
      for (let attempt = 0; !frame && attempt < 20; attempt++) {
        await until(() => !!state && state[2] === session.previewSequence);
        const request = ++id;
        session.send(['preview-render', request, 0, 1200, state![1], state![2]]);
        await until(() => frame?.header.requestId === request || retries.has(request));
      }
      assert.ok(frame);
      session.sync.syncForward(main, 17);
      await until(() => targets.length === 1);
      const first = targets[0];
      session.sync.syncForward(main, 18);
      await until(() => targets.length === 2);
      const control = targets[1];
      for (const [x, y, line] of [
        [first[4] - 10, first[5] - 5, 18],
        [first[4] + 60, first[5] - 3, 18],
        [control[4] - 10, control[5] - 5, 19],
        [first[4] - 10, first[5] + 14, 19]
      ]) {
        const count = sources.length;
        session.send(['preview-inverse', first[1], first[2], 0, x, y]);
        await until(() => sources.length > count);
        assert.equal(sources.at(-1)!.line, line, `click ${x},${y} must select prose, not begin-align or newpage`);
      }
      assert.equal(sources[0].word, 'Forward');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
