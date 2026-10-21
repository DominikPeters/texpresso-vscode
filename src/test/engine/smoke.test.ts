import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import { config, document } from '../helpers';
import { diagnostics } from './diagnostics';

const binary = process.env.TEXPRESSO_BINARY;
const providers = process.env.TEXPRESSO_TEST_TECTONIC === '1' ? ['texlive', 'tectonic'] as const : ['texlive'] as const;
for (const packageProvider of providers) {
  for (const streamFiles of [false, true]) {
    for (const useChangeRangeMode of [false, true]) {
      test('real engine: ' + packageProvider + ', ' + (streamFiles ? 'stream, ' : '') + (useChangeRangeMode ? 'ranges' : 'bytes'),
        { skip: !binary, timeout: 60000 }, async () => {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-engine-'));
          const support = path.join(root, 'support files');
          await fs.mkdir(support);
          const main = document(path.join(root, 'main.tex'),
            '\\documentclass{article}\n\\begin{document}\n\\input{chapter.tex}\n\\end{document}\n');
          const initial = '%' + 'a'.repeat(499) + '😀' + 'b'.repeat(500) + '\n\\typeout{BEFORE}\nChapter content.\n';
          let contents = initial;
          const child = document(path.join(support, 'chapter.tex'), initial);
          child.getText = () => contents;
          await fs.writeFile(main.fileName, main.getText());
          await fs.writeFile(child.fileName, initial);
          let output = '';
          let debug = '';
          let activity = Date.now();
          let failure: Error | undefined;
          const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider,
            useChangeRangeMode, streamFiles, includeDirectories: ['support files'] },
          new SessionPaths(main.fileName, false), () => [main, child], {
            state() {}, synctex() {}, debug: text => { debug += text; activity = Date.now(); },
            error: error => { failure = error; },
            output: (target, text) => { if (target === 'out') { output = text; } }
          });
          const until = async (check: () => boolean) => {
            const deadline = Date.now() + 25000;
            while (!check()) {
              if (failure || Date.now() > deadline) {
                throw failure || new Error('Engine timeout\n' + output + '\n' + debug.slice(-3000));
              }
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          };
          try {
            await session.start();
            // The typeout appears before the first usable rollback checkpoint.
            await until(() => output.includes('BEFORE') && Date.now() - activity >= 300 &&
              debug.lastIndexOf('[info] output 1 pages long') > Math.max(
                debug.lastIndexOf('texpresso: handshake success'), debug.lastIndexOf('[change] rewinded trace')));
            assert.ok(session.sync.contains(child), 'upstream announces included source');
            const offset = initial.indexOf('BEFORE');
            contents = initial.replace('BEFORE', 'AFTER');
            session.sync.change(child, [{ rangeOffset: offset, rangeLength: 6, text: 'AFTER',
              range: { start: { line: 1, character: 9 }, end: { line: 1, character: 15 } }
            } as import('vscode').TextDocumentContentChangeEvent]);
            await until(() => output.includes('AFTER'));
            assert.doesNotMatch(debug, /\[fatal\]/);
          } catch (error) {
            await diagnostics(root, output, debug);
            throw error;
          } finally {
            await session.dispose();
            await fs.rm(root, { recursive: true, force: true });
          }
        });
    }
  }
}
