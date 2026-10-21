import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deflateSync } from 'node:zlib';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import { config, document } from '../helpers';
import type { SessionConfiguration } from '../../configuration';
import { diagnostics } from './diagnostics';

const binary = process.env.TEXPRESSO_BINARY;
async function engine(source: string, options: Partial<SessionConfiguration>,
  body: (context: { session: TexpressoSession; root: string; output(): string; debug(): string;
    until(check: () => boolean): Promise<void> }) => Promise<void>,
  prepare?: (root: string) => Promise<void>, expectedRestarts = 0): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-upstream-')));
  const main = document(path.join(root, 'main.tex'), source);
  await fs.writeFile(main.fileName, source);
  await prepare?.(root);
  let output = '';
  let debug = '';
  let failure: Error | undefined;
  let restarts = 0;
  const watchers = new Map<string, Set<(kind: 'change' | 'delete') => void>>();
  const watcher = watch(root, { persistent: false }, (_event, name) => {
    if (name) {
      const file = path.join(root, name.toString());
      watchers.get(file)?.forEach(changed => changed(existsSync(file) ? 'change' : 'delete'));
    }
  });
  watcher.on('error', error => { failure = error; });
  const makeSession = (): TexpressoSession => new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', ...options },
    new SessionPaths(main.fileName, false), () => [main], {
      state() {}, synctex() {}, debug: text => { debug += text; }, error: error => { failure = error; },
      restart: () => {
        restarts++;
        session.dispose();
        session = makeSession();
        void session.start();
      },
      output: (target, text) => { if (target === 'out') { output = text; } }
    }, undefined, undefined, {
      watchDelay: 20,
      watchFile(file, changed) {
        const callbacks = watchers.get(file) || new Set();
        callbacks.add(changed);
        watchers.set(file, callbacks);
        return { dispose: () => { callbacks.delete(changed); if (!callbacks.size) { watchers.delete(file); } } };
      }
    });
  let session = makeSession();
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 25000;
    while (!check()) {
      if (failure || Date.now() > deadline) {
        throw failure || new Error('Engine timeout\n' + output + '\n' + debug.slice(-5000));
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await session.start();
    await body({ session, root, output: () => output, debug: () => debug, until });
    assert.equal(restarts, expectedRestarts, 'only streamed-image changes require a process restart');
  } catch (error) {
    await diagnostics(root, output, debug);
    throw error;
  } finally { await session.dispose(); watcher.close(); await fs.rm(root, { recursive: true, force: true }); }
}

const references = '\\documentclass{article}\n\\begin{document}\nSee Section~\\ref{target}.\n\\section{Target}\\label{target}\n\\typeout{REFERENCE-CHECKED}\n\\end{document}\n';
for (const automatic of [false, true]) {
  test('real upstream: ' + (automatic ? 'automatic' : 'one-shot') + ' reference convergence',
    { skip: !binary, timeout: 60000 }, async () => {
      await engine(references, { autoRerun: automatic }, async ({ session, output, debug, until }) => {
        if (!automatic) {
          await until(() => /Reference.*undefined/.test(output()));
          session.rerunOnce();
        }
        await until(() => debug().includes(automatic ? '[rerun] idle' : '[rerun] on-demand'));
        await until(() => output().includes('REFERENCE-CHECKED') && !/Reference.*undefined/.test(output()));
        assert.equal(session.state, 'running');
      });
    });
}

test('real upstream: edits remain paused until resume', { skip: !binary, timeout: 60000 }, async () => {
  const source = '\\documentclass{article}\n\\begin{document}\n\\typeout{BEFORE}\nText.\n\\end{document}\n';
  await engine(source, {}, async ({ session, output, debug, until }) => {
    await until(() => output().includes('BEFORE'));
    session.setPaused(true);
    await until(() => debug().includes('engine stepping suspended'));
    session.send(['open', session.paths.rootEnginePath, source.replace('BEFORE', 'AFTER')]);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(!output().includes('AFTER'));
    session.setPaused(false);
    await until(() => output().includes('AFTER'));
  });
});

function png(width: number): Buffer {
  const chunk = (type: string, bytes: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const value of payload) {
      crc ^= value;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(width + 1))), chunk('IEND', Buffer.alloc(0))]);
}

for (const streamFiles of [false, true]) {
  test('real upstream: binary image updates through ' + (streamFiles ? 'streaming and cache-clearing restart' : 'rescan'),
    { skip: !binary, timeout: 60000 }, async () => {
      const source = '\\documentclass{article}\n\\usepackage[xetex]{graphicx}\n\\begin{document}\n' +
        '\\newbox\\picturebox\\setbox\\picturebox=\\hbox{\\includegraphics{picture.png}}\n' +
        '\\typeout{IMAGE-WIDTH=\\the\\wd\\picturebox}\\box\\picturebox\n\\end{document}\n';
      await engine(source, { streamFiles }, async ({ root, output, debug, until }) => {
        await until(() => /IMAGE-WIDTH=([\d.]+)/.test(output()));
        const before = output().match(/IMAGE-WIDTH=([\d.]+)/)![1];
        await fs.writeFile(path.join(root, 'picture.png'), png(2));
        await until(() => {
          const after = output().match(/IMAGE-WIDTH=([\d.]+)/)?.[1];
          return !!after && after !== before;
        });
        assert.doesNotMatch(debug(), /\[fatal\]|unknown verb/);
      }, root => fs.writeFile(path.join(root, 'picture.png'), png(1)), streamFiles ? 1 : 0);
    });
}
