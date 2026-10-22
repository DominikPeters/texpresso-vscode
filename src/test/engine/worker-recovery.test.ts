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
test('rapid edit restarts a stalled root worker even before its first input trace entry',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1' || process.platform === 'win32', timeout: 45000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-worker-recovery-')));
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    const frontend = path.join(bin, 'texpresso'); await fs.copyFile(binary!, frontend); await fs.chmod(frontend, 0o755);
    const engine = path.resolve(path.dirname(binary!), 'texpresso-xetex');
    // Bundled macOS frontend libraries remain available after copying the
    // executable into the isolated fixture. No binaries are rebuilt/downloaded.
    try { await fs.symlink(path.resolve(path.dirname(binary!), '../lib'), path.join(root, 'lib'), 'dir'); } catch { /* direct development builds use absolute libraries */ }
    const marker = path.join(root, 'first-worker');
    // Only the first worker is a controlled startup stall. It completes the
    // actual protocol handshake, then cannot produce a READ/SEEN query. Its
    // replacement execs the real installed XeTeX and must compile the edits.
    await fs.writeFile(path.join(bin, 'texpresso-xetex'), `#!/usr/bin/env python3
import os, socket, sys, time
try:
    fd = os.open(${JSON.stringify(marker)}, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
except FileExistsError:
    os.execv(${JSON.stringify(engine)}, [${JSON.stringify(engine)}] + sys.argv[1:])
s = socket.socket(fileno=int(os.environ['TEXPRESSO_FD']))
s.sendall(b'TEXPRESSOC01')
data = b''
while len(data) < 12:
    data += s.recv(12 - len(data))
assert data == b'TEXPRESSOS01'
print('TXP-TEST-STALL', file=sys.stderr, flush=True)
time.sleep(60)
`, { mode: 0o755 });
    let text = '\\documentclass{article}\n\\begin{document}\n\\typeout{Target}\nTarget text.\n\\end{document}\n';
    const main = document(path.join(root, 'main.tex'), text); main.getText = () => text;
    await fs.writeFile(main.fileName, text);
    let stalled = false, killed = false, zeroRewind = false, output = '';
    const launched = new Set<string>();
    let debug = '', failure: Error | undefined, state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: frontend, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output: (target, value) => { if (target === 'out') { output = value; } }, synctex() {},
        debug: s => {
          debug = (debug + s).slice(-50000);
          // Provider startup logs can evict early events from the bounded
          // failure trace. Preserve the assertions independently of that tail.
          stalled ||= debug.includes('TXP-TEST-STALL');
          killed ||= debug.includes('worker might be stuck, killing');
          zeroRewind ||= debug.includes('rewinded trace from 0 to 0 entries');
          for (const match of debug.matchAll(/\[process\] launched pid (\d+)/g)) { launched.add(match[1]); }
        }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
          } }
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 30000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    try {
      await session.start(); await until(() => stalled);
      const offset = text.indexOf('Target'); text = text.replace('Target', 'Changed');
      session.sync.change(main, [{ rangeOffset: offset, rangeLength: 6, text: 'Changed',
        range: { start: { line: 2, character: 9 }, end: { line: 2, character: 15 } } as import('vscode').Range }]);
      await until(() => !!state && state[2] === session.previewSequence && state[3] > 0);
      assert.ok(killed, 'stalled root worker was killed');
      assert.ok(zeroRewind, 'rollback target is trace zero');
      assert.ok(launched.size >= 2, 'dead trace-zero worker is replaced');
      for (let id = 1; id < 10; id++) {
        session.send(['preview-render', id, 0, 800, state![1], state![2]]);
        await until(() => frames.has(id) || retries.has(id));
        if (frames.has(id)) { assert.equal(frames.get(id)!.header.sequence, session.previewSequence);
          assert.match(output, /Changed/, 'replacement compiler sees the unsaved source change'); return; }
      }
      assert.fail('No frame after worker recovery');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
