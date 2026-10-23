import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { terminate } from '../../process-lifecycle';

const binary = process.env.TEXPRESSO_BINARY;
const options = { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1' || process.platform === 'win32', timeout: 30000 };
const initial = 'Initial disk source.\n';
const edited = 'Latest unsaved source, including startup edits.\n';

type Mode = 'delayed' | 'fragmented' | 'timeout' | 'eof' | 'invalid';
async function controlled(mode: Mode) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-startup-')));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const frontend = path.join(bin, 'texpresso'); await fs.copyFile(binary!, frontend); await fs.chmod(frontend, 0o755);
  try { await fs.symlink(path.resolve(path.dirname(binary!), '../lib'), path.join(root, 'lib'), 'dir'); } catch { /* development builds use absolute libraries */ }
  await fs.writeFile(path.join(root, 'main.tex'), initial);
  const release = path.join(root, 'release');
  await fs.writeFile(path.join(bin, 'texpresso-xetex'), `#!/usr/bin/env python3
import os, signal, socket, struct, sys, time
mode = ${JSON.stringify(mode)}
try:
    fd = os.open(${JSON.stringify(path.join(root, 'first'))}, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
except FileExistsError:
    mode = 'recovery'
s = socket.socket(fileno=int(os.environ['TEXPRESSO_FD']))
def exact(n):
    data = b''
    while len(data) < n:
        part = s.recv(n-len(data))
        if not part: raise EOFError()
        data += part
    return data
def tag():
    value = exact(4)
    while value == b'FLSH': value = exact(4)
    return value
assert exact(12) == b'TEXPRESSOS02'
if mode in ('fragmented', 'timeout', 'eof'):
    s.sendall(b'TEXP')
print('TXP-STARTUP-WAIT', file=sys.stderr, flush=True)
if mode == 'eof':
    s.close()
    sys.exit(0)
if mode == 'invalid':
    s.sendall(b'TEXPRESSOC01')
    time.sleep(60)
if mode == 'timeout':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(60)
if mode != 'recovery':
    deadline = time.monotonic() + 15
    while not os.path.exists(${JSON.stringify(release)}):
        if time.monotonic() > deadline: raise TimeoutError('test did not release greeting')
        time.sleep(0.002)
# Coalesce the end of the greeting and first query. Neither fragmented nor
# immediately available protocol bytes may be mistaken for ordinary queries.
hello = b'RESSOC02' if mode == 'fragmented' else b'TEXPRESSOC02'
s.sendall(hello + b'OPRD' + struct.pack('<II', 0, 0) + b'main.tex\\0' + b'TEX\\0')
print('TXP-HELLO-SENT', file=sys.stderr, flush=True)
assert tag() == b'OPEN'
exact(struct.unpack('<I', exact(4))[0])
s.sendall(b'READ' + struct.pack('<IIII', 1, 0, 0, 4096))
assert tag() == b'READ'
source = exact(struct.unpack('<I', exact(4))[0])
assert source == ${JSON.stringify(edited)}.encode(), repr(source)
print('TXP-STARTUP-INPUT-CURRENT', file=sys.stderr, flush=True)
s.sendall(b'FINI' + struct.pack('<II', 2, 1))
assert tag() == b'DONE'
s.close()
`, { mode: 0o755 });
  const child = spawn(frontend, ['-json', '-headless', '-texlive', 'main.tex'], {
    cwd: root, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', TEXPRESSO_PROFILE: mode === 'timeout' ? '0' : '1',
      ...(mode === 'timeout' ? { TEXPRESSO_TEST_STARTUP_TIMEOUT_MS: '1000' } : {}) },
    detached: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let debug = '', closed = false, failure: Error | undefined, pending = '';
  const messages: unknown[][] = [];
  const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  child.on('error', error => { failure = error; });
  child.stderr!.on('data', (data: Buffer) => { debug += data.toString(); });
  child.stdout!.on('data', (data: Buffer) => {
    pending += data.toString(); const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) { try { const value = JSON.parse(line); if (Array.isArray(value)) { messages.push(value); } } catch { /* unrelated diagnostic */ } }
  });
  const send = (command: unknown[]) => child.stdin!.write(JSON.stringify(command) + '\n');
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 15000;
    while (!condition()) {
      if (failure || closed || Date.now() > end) { throw failure || new Error(debug); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { child, messages, send, until, exited, release: () => fs.writeFile(release, ''), debug: () => debug,
    async dispose() { await terminate(child); await exited; await fs.rm(root, { recursive: true, force: true }); } };
}

for (const mode of ['delayed', 'fragmented'] as const) {
  test(`${mode} worker greeting yields to edits and Pause, then Resume reads newest source`, options, async () => {
    const p = await controlled(mode);
    try {
      await p.until(() => p.debug().includes('TXP-STARTUP-WAIT'));
      p.send(['pause']);
      p.send(['open', 'main.tex', 'Intermediate unsaved source.\n']);
      p.send(['open', 'main.tex', edited]);
      p.send(['preview-barrier', 1]);
      await p.until(() => p.debug().includes('[command] pause:') && p.messages.some(message => message[0] === 'preview-state' && message[2] === 1));
      assert.ok(!p.debug().includes('TXP-HELLO-SENT'), 'editor commands were processed before releasing the greeting');
      assert.equal((p.debug().match(/\[process\] launched pid/g) || []).length, 1, 'startup edits do not replace the healthy unread worker');
      await p.release();
      await p.until(() => p.debug().includes('"stage":"compiler-handshake"') && p.debug().includes('"outcome":"ready"'));
      assert.ok(!p.debug().includes('TXP-STARTUP-INPUT-CURRENT'), 'greeting completion while paused does not step the first compiler query');
      p.send(['resume']);
      await p.until(() => p.debug().includes('TXP-STARTUP-INPUT-CURRENT'));
      assert.ok(!p.debug().includes('worker might be stuck'), 'partial greetings are not subject to the ordinary SEEN stall watchdog');
    } finally { await p.dispose(); }
  });
}

async function processExists(child: ChildProcess, pid: number): Promise<boolean> {
  assert.ok(pid > 0 && pid !== child.pid);
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; }
    throw error;
  }
}

for (const mode of ['timeout', 'eof', 'invalid'] as const) {
  test(`${mode} worker greeting fails once, reaps the child and permits explicit recovery`, options, async () => {
    const p = await controlled(mode);
    try {
      await p.until(() => p.debug().includes('[process] Compiler startup'));
      assert.match(p.debug(), mode === 'timeout' ? /startup timed out/ : /closed its connection or sent an incompatible greeting/);
      const pid = Number(p.debug().match(/\[process\] launched pid (\d+)/)![1]);
      const end = Date.now() + 5000;
      while (await processExists(p.child, pid)) {
        assert.ok(Date.now() < end, `failed startup child ${pid} must terminate and be reaped\n${p.debug()}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      p.send(['pause']); await p.until(() => p.debug().includes('[command] pause:'));
      assert.equal((p.debug().match(/\[process\] launched pid/g) || []).length, 1, 'startup failure cannot automatically respawn in a loop');
      if (mode === 'timeout') { assert.ok(!p.debug().includes('[profile]'), 'the startup deadline works when profiling is disabled'); }
      p.send(['open', 'main.tex', edited]); p.send(['resume']);
      await p.until(() => p.debug().includes('TXP-STARTUP-INPUT-CURRENT'));
      assert.equal((p.debug().match(/\[process\] launched pid/g) || []).length, 2, 'an explicit recovery starts one replacement');
    } finally { await p.dispose(); }
  });
}

test('a partially greeted worker can be canceled through stdin EOF without waiting for startup', options, async () => {
  const p = await controlled('fragmented');
  try {
    await p.until(() => p.debug().includes('TXP-STARTUP-WAIT'));
    const pid = Number(p.debug().match(/\[process\] launched pid (\d+)/)![1]);
    p.child.stdin!.end();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([p.exited, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('stdin EOF did not cancel pending startup')), 5000);
      })]);
    } finally { clearTimeout(timeout); }
    assert.equal(await processExists(p.child, pid), false, 'shutdown reaps the starting direct child');
    assert.ok(!p.debug().includes('TXP-HELLO-SENT'), 'cancellation does not need the rest of the greeting');
  } finally { await p.dispose(); }
});
