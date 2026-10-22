import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
test('empty document rejects obsolete preview requests before reporting a current no-page failure',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 30000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-preview-empty-')));
    const main = document(path.join(root, 'empty.tex'), '\\documentclass{article}\n\\begin{document}\n\\end{document}\n');
    await fs.writeFile(main.fileName, main.getText());
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    const replies: PreviewMessage[] = [];
    let failure: Error | undefined, debug = '';
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex() {}, debug: s => { debug = (debug + s).slice(-10000); },
        error: e => { failure = e; }, preview: event => {
          if (Array.isArray(event)) {
            replies.push(event);
            if (event[0] === 'preview-state') { state = event; }
          }
        }
      });
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 20000;
      while (!condition()) {
        if (failure || Date.now() > deadline) { throw failure || new Error(debug); }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await session.start();
      await until(() => !!state && state[4] && state[2] === session.previewSequence);
      assert.equal(state![3], 0, 'valid empty document has no shipped pages');
      session.send(['preview-render', 100, 0, 800, state![1] - 1, state![2]]);
      await until(() => replies.some(event => event[1] === 100 && ['preview-retry', 'preview-error'].includes(event[0])));
      assert.ok(replies.some(event => event[0] === 'preview-retry' && event[1] === 100));
      assert.ok(!replies.some(event => event[0] === 'preview-error' && event[1] === 100), 'obsolete work cannot surface a no-page failure');
      session.send(['preview-render', 101, 0, 800, state![1], state![2]]);
      await until(() => replies.some(event => event[0] === 'preview-error' && event[1] === 101));
      const error = replies.find(event => event[0] === 'preview-error' && event[1] === 101)!;
      assert.match(String(error[2]), /has not produced a page/, 'current request still reports a real no-page failure');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
