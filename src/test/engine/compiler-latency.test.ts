import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { terminate } from '../../process-lifecycle';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const binary = process.env.TEXPRESSO_BINARY;

test('paced compiler queries yield to pending editor commands before ten queries complete',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1' || process.platform === 'win32', timeout: 30000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-compiler-latency-')));
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    const frontend = path.join(bin, 'texpresso'); await fs.copyFile(binary!, frontend); await fs.chmod(frontend, 0o755);
    try { await fs.symlink(path.resolve(path.dirname(binary!), '../lib'), path.join(root, 'lib'), 'dir'); } catch { /* development builds use absolute libraries */ }
    await fs.writeFile(path.join(root, 'main.tex'), 'A controlled compiler needs no TeX compilation.\n');
    // A read/write FIFO is inherited as stdin by this isolated frontend and
    // worker. The worker can buffer an editor command synchronously between
    // queries, avoiding any Node callback or wall-clock assertion race.
    const commandsPath = path.join(root, 'commands');
    execFileSync('mkfifo', [commandsPath]);
    const commands = await fs.open(commandsPath, 'r+');
    await fs.writeFile(path.join(bin, 'texpresso-xetex'), `#!/usr/bin/env python3
import os, socket, struct, sys, time
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
time.sleep(0.08)
s.sendall(b'TEXPRESSOC03')
assert exact(12) == b'TEXPRESSOS03'
s.sendall(b'OPRD' + struct.pack('<II', 0, 0) + b'main.tex\\0' + b'TEX\\0')
assert tag() == b'OPEN'
exact(struct.unpack('<I', exact(4))[0])
for i in range(1, 13):
    time.sleep(0.008)
    s.sendall(b'SIZE' + struct.pack('<II', i, 0))
    assert tag() == b'SIZE'
    exact(4)
    print('TXP-LATENCY-QUERY %d' % i, file=sys.stderr, flush=True)
    if i == 2:
        os.write(0, b'["pause"]\\n')
time.sleep(60)
`, { mode: 0o755 });
    const child = spawn(frontend, ['-json', '-headless', '-texlive', 'main.tex'], {
      cwd: root, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', TEXPRESSO_PROFILE: '1' }, detached: true, stdio: [commands.fd, 'ignore', 'pipe']
    });
    let debug = '', pending = '', paused = false, queries = 0, atPause = -1;
    let failure: Error | undefined, closed = false;
    const profiles: { stage: string; nativeAt: number; ms: number; steps?: number; reason?: string; pid?: number }[] = [];
    const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
    child.on('error', error => { failure = error; });
    child.stderr!.on('data', (data: Buffer) => {
      debug += data.toString(); pending += data.toString();
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('TXP-LATENCY-QUERY ')) { queries = Number(line.slice('TXP-LATENCY-QUERY '.length)); }
        if (line.includes('[command] pause:')) { paused = true; atPause = queries; }
        if (line.startsWith('[profile] ')) { profiles.push(JSON.parse(line.slice(10))); }
      }
    });
    try {
      const deadline = Date.now() + 15000;
      while (!paused) {
        if (failure || closed || Date.now() > deadline) { throw failure || new Error(debug); }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(atPause >= 2 && atPause <= 4, `pause must be serviced after at most two additional queries, saw ${atPause}\n${debug}`);
      const spawnEvent = profiles.find(event => event.stage === 'compiler-spawn');
      const handshake = profiles.find(event => event.stage === 'compiler-handshake');
      assert.ok(spawnEvent && handshake, 'spawn and handshake have independent timing records');
      assert.equal(spawnEvent.pid, handshake.pid, 'startup stages identify the same compiler');
      assert.ok(handshake.ms >= 40, 'the controlled delayed handshake is included in its timer');
      assert.ok(handshake.nativeAt >= spawnEvent.nativeAt, 'native monotonic timestamps order startup stages');
      const bursts = profiles.filter(event => event.stage === 'compiler-burst');
      // A poll can return before the next paced query arrives, producing a wait
      // rather than a budget exit. The synchronous Pause above is the causal
      // responsiveness check; do not require one OS scheduling outcome.
      assert.ok(bursts.some(event => (event.steps || 0) > 0 && (event.steps || 0) <= 4),
        'profile records bounded progress before the pending Pause');
      assert.ok(profiles.every(event => Number.isFinite(event.nativeAt) && event.nativeAt > 0 && event.ms >= 0), 'all diagnostic records carry native monotonic timestamps and durations');
    } finally {
      await terminate(child);
      await exited;
      await commands.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
