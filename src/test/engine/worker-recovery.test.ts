import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
const options = { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1' || process.platform === 'win32', timeout: 45000 };
for (const mode of ['dead', 'buffered', 'unopened', 'reaped'] as const) {
  test({ dead: 'a source edit replaces a closed trace-zero root worker',
    buffered: 'editing buffered source still kills a stalled worker with delayed SEEN',
    unopened: 'repeated unopened included-file edits preserve a healthy delayed worker',
    reaped: 'repeated closed-root replacements leave no zombie direct compiler children' }[mode], options, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-worker-recovery-')));
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    const frontend = path.join(bin, 'texpresso'); await fs.copyFile(binary!, frontend); await fs.chmod(frontend, 0o755);
    const engine = path.resolve(path.dirname(binary!), 'texpresso-xetex');
    try { await fs.symlink(path.resolve(path.dirname(binary!), '../lib'), path.join(root, 'lib'), 'dir'); } catch { /* development builds use absolute libraries */ }
    const marker = path.join(root, 'first-worker'), release = path.join(root, 'release');
    // Only the first worker is controlled. The unopened case proxies a real
    // worker after release, including SCM_RIGHTS used by compiler checkpoints.
    await fs.writeFile(path.join(bin, 'texpresso-xetex'), `#!/usr/bin/env python3
import array, os, select, signal, socket, struct, subprocess, sys, time
mode = ${JSON.stringify(mode)}
try:
    fd = os.open(${JSON.stringify(marker)}, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
except FileExistsError:
    if mode != 'reaped' or os.path.exists(${JSON.stringify(release)}):
        os.execv(${JSON.stringify(engine)}, [${JSON.stringify(engine)}] + sys.argv[1:])
s = socket.socket(fileno=int(os.environ['TEXPRESSO_FD']))
def exact(sock, n):
    data = b''
    while len(data) < n:
        part = sock.recv(n-len(data))
        if not part: raise EOFError()
        data += part
    return data
def tag(sock):
    value = exact(sock, 4)
    while value == b'FLSH': value = exact(sock, 4)
    return value
s.sendall(b'TEXPRESSOC02')
assert exact(s, 12) == b'TEXPRESSOS02'
if mode in ('dead', 'reaped'):
    print('TXP-TEST-CLOSED', file=sys.stderr, flush=True)
    s.close()
    sys.exit(0)
if mode == 'buffered':
    s.sendall(b'OPRD' + struct.pack('<II', 0, 0) + b'main.tex\\0' + b'TEX\\0')
    assert tag(s) == b'OPEN'
    exact(s, struct.unpack('<I', exact(s, 4))[0])
    s.sendall(b'READ' + struct.pack('<IIII', 0, 0, 0, 4096))
    assert tag(s) == b'READ'
    exact(s, struct.unpack('<I', exact(s, 4))[0])
print('TXP-TEST-STALL', file=sys.stderr, flush=True)
if mode == 'buffered': time.sleep(60)
else:
    deadline = time.monotonic() + 10
    while not os.path.exists(${JSON.stringify(release)}):
        if time.monotonic() > deadline: raise TimeoutError('test did not release worker')
        time.sleep(0.005)
    a, b = socket.socketpair()
    env = dict(os.environ, TEXPRESSO_FD=str(b.fileno()))
    child = subprocess.Popen([${JSON.stringify(engine)}] + sys.argv[1:], env=env, pass_fds=(b.fileno(),))
    b.close()
    def stop(_sig, _frame): raise SystemExit()
    signal.signal(signal.SIGTERM, stop)
    try:
        assert exact(a, 12) == b'TEXPRESSOC02'
        a.sendall(b'TEXPRESSOS02')
        while True:
            ready, _, _ = select.select([s, a], [], [], 5)
            for source in ready:
                data, ancillary, _flags, _address = source.recvmsg(65536, socket.CMSG_SPACE(64))
                if not data: raise EOFError()
                target = a if source is s else s
                sent = target.sendmsg([data], ancillary)
                if sent < len(data): target.sendall(data[sent:])
                for level, kind, payload in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        ids = array.array('i'); ids.frombytes(payload[:len(payload)//ids.itemsize*ids.itemsize])
                        for fd in ids: os.close(fd)
    except EOFError: pass
    finally:
        a.close()
        if child.poll() is None: child.terminate()
        child.wait(timeout=2)
`, { mode: 0o755 });
    let text = '\\documentclass{article}\n\\begin{document}\n\\typeout{Target}\nTarget text.\n' +
      (mode === 'unopened' ? '\\input{chapter.tex}\n' : '') + '\\end{document}\n';
    let childText = '\\typeout{CHILD:base}\nChild text.\n';
    const main = document(path.join(root, 'main.tex'), text); main.getText = () => text;
    const included = document(path.join(root, 'chapter.tex'), childText); included.getText = () => childText;
    await fs.writeFile(main.fileName, text); await fs.writeFile(included.fileName, 'Old disk contents.');
    let stalled = false, closed = false, killed = false, zeroRewind = false, terminated = false, output = '';
    let closedCount = 0, terminatedCount = 0, debugPending = '', frontendPid: number | undefined;
    const launched = new Set<string>();
    let debug = '', failure: Error | undefined, state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: frontend, packageProvider: 'texlive', previewLocation: 'editor', streamFiles: mode === 'unopened' },
      new SessionPaths(main.fileName, false), () => mode === 'unopened' ? [main, included] : [main], {
        state() {}, output: (target, value) => { if (target === 'out') { output = value; } }, synctex() {},
        debug: s => {
          debug = (debug + s).slice(-50000);
          debugPending += s; const lines = debugPending.split('\n'); debugPending = lines.pop()!;
          for (const line of lines) {
            if (line.includes('TXP-TEST-CLOSED')) { closedCount++; }
            if (line.includes('[process] terminating process')) { terminatedCount++; }
          }
          stalled ||= debug.includes('TXP-TEST-STALL'); closed ||= debug.includes('TXP-TEST-CLOSED');
          killed ||= debug.includes('worker might be stuck, killing'); terminated ||= debug.includes('[process] terminating process');
          zeroRewind ||= /rewinded trace from \d+ to 0 entries/.test(debug);
          for (const match of debug.matchAll(/\[process\] launched pid (\d+)/g)) { launched.add(match[1]); }
        }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
          } }
      }, undefined, (command, args, options) => {
        const child = spawn(command, args, options); frontendPid = child.pid; return child;
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 20000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    try {
      await session.start(); await until(() => mode === 'dead' || mode === 'reaped' ? closed && terminated : stalled);
      if (mode === 'reaped') {
        for (let i = 0; i < 12; ++i) {
          const offset = text.length, line = text.split('\n').length - 1, value = `%restart ${i}\n`; text += value;
          session.sync.change(main, [{ rangeOffset: offset, rangeLength: 0, text: value,
            range: { start: { line, character: 0 }, end: { line, character: 0 } } as import('vscode').Range }]);
          await until(() => closedCount >= i + 2 && terminatedCount >= i + 2);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        session.send(['preview-barrier', session.previewSequence]);
        await new Promise(resolve => setTimeout(resolve, 50));
        const children = execFileSync('ps', ['-axo', 'pid=,ppid=,stat='], { encoding: 'utf8' }).trim().split('\n')
          .map(line => line.trim().split(/\s+/)).filter(parts => Number(parts[1]) === frontendPid);
        assert.ok(!children.some(parts => parts[2].startsWith('Z')), 'closed direct compiler children are reaped after settling');
        await fs.writeFile(release, 'allow real worker');
      }
      if (mode === 'unopened') {
        for (let i = 0; i < 20; ++i) {
          const offset = childText.indexOf('}'); childText = childText.slice(0, offset) + 'x' + childText.slice(offset);
          session.sync.change(included, [{ rangeOffset: offset, rangeLength: 0, text: 'x',
            range: { start: { line: 0, character: offset }, end: { line: 0, character: offset } } as import('vscode').Range }]);
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        await until(() => state?.[2] === session.previewSequence);
        assert.equal(launched.size, 1, 'edits to an unopened file must not restart healthy startup');
        assert.ok(!killed, 'an unopened-file edit is not evidence the worker is stuck');
        await fs.writeFile(release, 'continue');
      } else {
        const offset = text.indexOf('Target'); text = text.replace('Target', 'Changed');
        session.sync.change(main, [{ rangeOffset: offset, rangeLength: 6, text: 'Changed',
          range: { start: { line: 2, character: 9 }, end: { line: 2, character: 15 } } as import('vscode').Range }]);
      }
      for (let id = 1; id < 10; id++) {
        await until(() => !!state && state[2] === session.previewSequence);
        session.send(['preview-render', id, 0, 800, state![1], state![2]]);
        await until(() => frames.has(id) || retries.has(id));
        if (frames.has(id)) {
          assert.equal(frames.get(id)!.header.sequence, session.previewSequence);
          if (mode === 'unopened') { assert.match(output, /CHILD:basex{20}/, 'real worker reads the newest unsaved included text'); }
          else {
            assert.ok(zeroRewind, 'rollback target is trace zero'); assert.ok(launched.size >= 2, 'unusable worker is replaced');
            assert.equal(killed, mode === 'buffered', 'only an unresponsive worker with buffered input requires a kill');
            assert.match(output, /Changed/, 'replacement compiler sees the unsaved source change');
          }
          return;
        }
      }
      assert.fail('No frame after worker recovery');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
}
