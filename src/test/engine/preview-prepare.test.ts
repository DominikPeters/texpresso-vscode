import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
const options = { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 };
type Prepared = Extract<PreviewMessage, ['preview-prepared', ...unknown[]]>;
class Preview {
  readonly main: ReturnType<typeof document>;
  child?: ChildProcess;
  readonly session: TexpressoSession;
  readonly messages: PreviewMessage[] = [];
  readonly images = new Map<number, PreviewImage>();
  state?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
  failure?: Error; debug = ''; id = 0; replays = 0;
  readonly inverse: { file: string; line: number; word?: string }[] = [];
  readonly checkpointOffsets: number[] = []; readonly rollbackTokens: number[] = []; readonly rollbackTraces: number[] = []; readonly compilerEvents: string[] = []; private debugPending = '';
  constructor(readonly root: string, public text: string, readonly others: ReturnType<typeof document>[] = [], command = binary!) {
    this.main = document(path.join(root, 'main.tex'), text); this.main.getText = () => this.text;
    this.session = new TexpressoSession(this.main, { ...config, command, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: false },
      new SessionPaths(this.main.fileName, false), () => [this.main, ...others], {
        state() {}, output() {}, synctex: (file, line, _column, word) => { this.inverse.push({ file, line, word }); }, debug: value => {
          this.debug = (this.debug + value).slice(-30000); if (value.includes('[prepare-edit] replay')) { this.replays++; }
          this.debugPending += value; const lines = this.debugPending.split('\n'); this.debugPending = lines.pop()!;
          for (const line of lines) {
            if (/\[prepare-edit\]|\[fence\]|\[kill\]|\[change\]|compiler-rollback|compiler-checkpoint/.test(line)) { this.compilerEvents.push(line); }
            const at = line.indexOf('[profile] '); if (at < 0) { continue; } const record = JSON.parse(line.slice(at + 10));
            if (record.stage === 'compiler-checkpoint' && record.fence) { this.checkpointOffsets.push(record.offset); }
            if (record.stage === 'compiler-rollback') { this.rollbackTokens.push(record.resumeTokens); this.rollbackTraces.push(record.resumeTrace); }
          }
        },
        error: error => { this.failure = error; }, preview: event => {
          if ('header' in event) { this.images.set(event.header.requestId, event); }
          else if (Array.isArray(event)) { this.messages.push(event); if (event[0] === 'preview-state') { this.state = event; }
            if (event[0] === 'preview-error') { this.failure = new Error(event[2]); } }
        }
      }, undefined, (command, args, options) => {
        this.child = spawn(command, args, { ...options, env: { ...process.env, ...options.env, TEXPRESSO_PROFILE: '1' } }); return this.child;
      });
  }
  async until(condition: () => boolean): Promise<void> {
    const end = Date.now() + 15000;
    while (!condition()) { if (this.failure || Date.now() > end) { throw this.failure || new Error(this.compilerEvents.join('\n') + '\n' + this.debug); } await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  async start(): Promise<void> { await fs.writeFile(this.main.fileName, this.text); await this.session.start(); }
  async render(page = 0, base?: number): Promise<PreviewImage> {
    for (;;) {
      await this.until(() => !!this.state && this.state[2] === this.session.previewSequence);
      const id = ++this.id;
      this.session.send(base ? ['preview-png', id, page, 1000, this.state![1], this.state![2], base] : ['preview-render', id, page, 1000, this.state![1], this.state![2]]);
      await this.until(() => this.images.has(id) || this.messages.some(m => m[0] === 'preview-retry' && m[1] === id));
      if (this.images.has(id)) { return this.images.get(id)!; }
    }
  }
  prepare(offset: number, file = this.main.fileName, revision = this.state![1]): number {
    const id = ++this.id; this.session.send(['preview-prepare', id, file, offset, revision, this.state![2]]); return id;
  }
  async prepared(id: number): Promise<Prepared> {
    await this.until(() => this.messages.some(m => m[0] === 'preview-prepared' && m[1] === id));
    return this.messages.find(m => m[0] === 'preview-prepared' && m[1] === id) as Prepared;
  }
  replace(offset: number, length: number, value: string): void {
    const pos = (n: number) => { const before = this.text.slice(0, n); return { line: before.split('\n').length - 1, character: n - before.lastIndexOf('\n') - 1 }; };
    const range = { start: pos(offset), end: pos(offset + length) } as import('vscode').Range;
    this.text = this.text.slice(0, offset) + value + this.text.slice(offset + length);
    this.session.sync.change(this.main, [{ rangeOffset: offset, rangeLength: length, text: value, range }]);
  }
}
async function temp(): Promise<string> { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-prepare-'))); }
const body = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Prepare here. The first editable paragraph should stay on this page.
\[ \int_0^1 x^2\,dx=\frac13. \]
` + '%' + 'padding'.repeat(250) + '\n\\newpage Second page.\\end{document}\n';

test('edit preparation preserves visible state and PNG base, reuses a bucket, and prepares the next real source edit', options, async () => {
  const root = await temp(), p = new Preview(root, body);
  try {
    await p.start(); const initial = await p.render(0); const base = await p.render(0, 999999);
    p.session.sync.syncForward(p.main, 3);
    await p.until(() => p.messages.some(m => m[0] === 'preview-forward'));
    const target = p.messages.find(m => m[0] === 'preview-forward') as Extract<PreviewMessage, ['preview-forward', ...unknown[]]>;
    const state = [...p.state!] as typeof p.state, messageStart = p.messages.length, imageCount = p.images.size;
    const offset = body.indexOf('Prepare here.') + 8;
    const ack = await p.prepared(p.prepare(Buffer.byteLength(body.slice(0, offset)))); assert.equal(ack[4], 'ready');
    assert.deepEqual(p.state, state); assert.equal(p.images.size, imageCount);
    assert.ok(!p.messages.slice(messageStart).some(m => m[0] === 'preview-invalidated'));
    assert.equal((await p.prepared(p.prepare(offset + 1)))[4], 'cached');
    p.session.send(['preview-inverse', target[1], target[2], target[3], target[4], target[5]]);
    await p.until(() => p.inverse.length > 0);
    assert.equal(p.inverse[0].file, p.main.fileName); assert.equal(p.inverse[0].line, 4);
    assert.equal(p.inverse[0].word, undefined, 'a cached SyncTeX hit after rollback does not guess a word from another renderer');
    const unchanged = await p.render(0, base.header.rasterId); assert.equal(unchanged.bytes.length, 0);
    assert.equal(unchanged.header.patch?.base, base.header.rasterId);
    p.replace(offset, 0, 'warm '); const edited = await p.render(0); assert.notDeepEqual(edited.bytes, initial.bytes);
    assert.equal(p.session.previewSequence, state![2] + 1);
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('preparation skips stale, unknown and EOF targets and can be cancelled before typing', options, async () => {
  const root = await temp(), p = new Preview(root, body);
  try {
    await p.start(); await p.render();
    assert.equal((await p.prepared(p.prepare(1, path.join(root, 'unknown.tex'))))[4], 'skipped');
    assert.equal((await p.prepared(p.prepare(64, p.main.fileName, p.state![1] + 1)))[4], 'skipped');
    assert.equal((await p.prepared(p.prepare(Buffer.byteLength(body))))[4], 'skipped');
    const at = body.indexOf('Prepare here.') + 8, replays = p.replays, checkpoints = p.checkpointOffsets.length;
    const request = p.prepare(at);
    await p.until(() => p.replays > replays);
    p.session.send(['preview-prepare-cancel', request]);
    assert.equal((await p.prepared(request))[4], 'cancelled');
    p.replace(at, 0, 'cancelled '); const edited = await p.render(); assert.ok(edited.bytes.length > 1000);
    await p.until(() => p.checkpointOffsets.slice(checkpoints).includes(at & ~63));
    assert.ok(p.checkpointOffsets.slice(checkpoints).includes(at & ~63), 'real foreground replay adopts the cancelled warm fence');
    const rollbacks = p.rollbackTokens.length;
    p.replace(at + 'cancelled '.length, 0, 'again '); const finalEdit = await p.render();
    await p.until(() => p.rollbackTokens.length > rollbacks);
    assert.ok(p.rollbackTokens.slice(rollbacks).some(tokens => tokens > 0), 'next edit reuses the handed-off checkpoint instead of replaying the preamble');
    const freshRoot = await temp(), fresh = new Preview(freshRoot, p.text);
    try { await fresh.start(); assert.deepEqual((await fresh.render()).bytes, finalEdit.bytes); }
    finally { await fresh.session.dispose(); await fs.rm(freshRoot, { recursive: true, force: true }); }
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('late included UTF-8 source can be prepared and edited without changing source coordinates', options, async () => {
  const root = await temp(); let lateText = 'Prépare ici. Café après.\n' + '% extra '.repeat(15) + '\n';
  const late = document(path.join(root, 'late.tex'), lateText); late.getText = () => lateText;
  await fs.writeFile(late.fileName, lateText);
  const source = String.raw`\documentclass{article}
\begin{document}First page.\newpage
` + '%' + 'x'.repeat(2100) + '\n\\input{late.tex}\n\\end{document}\n';
  const p = new Preview(root, source, [late]);
  try {
    await p.start(); await p.render(1);
    const at = lateText.indexOf('Café'), byte = Buffer.byteLength(lateText.slice(0, at)); assert.notEqual(at, byte);
    const ack = await p.prepared(p.prepare(byte, late.fileName)); assert.match(ack[4], /ready|cached/);
    lateText = lateText.slice(0, at) + 'Très bon ' + lateText.slice(at);
    p.session.sync.change(late, [{ rangeOffset: at, rangeLength: 0, text: 'Très bon ',
      range: { start: { line: 0, character: at }, end: { line: 0, character: at } } as import('vscode').Range }]);
    const updated = await p.render(1); assert.ok(updated.bytes.length > 1000);
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS preparation matches fresh rendering when a system font first occurs after the cursor and when edited to a new font',
  { ...options, skip: options.skip || process.platform !== 'darwin' }, async () => {
    const root = await temp(); const text = String.raw`\documentclass{article}
\usepackage{fontspec}
\begin{document}
Prepare here. Ordinary paragraph before the named font.
{\fontspec{Times New Roman}A named system font loaded in the document body.}
` + '%' + 'padding'.repeat(250) + '\n\\end{document}\n';
    const p = new Preview(root, text);
    try {
      await p.start(); const initial = await p.render();
      assert.equal((await p.prepared(p.prepare(text.indexOf('Prepare here.') + 8)))[4], 'ready');
      assert.deepEqual((await p.render()).bytes, initial.bytes);
      const start = p.text.indexOf('Times New Roman'); p.replace(start, 'Times New Roman'.length, 'Courier New');
      const edited = await p.render();
      const freshRoot = await temp(), fresh = new Preview(freshRoot, p.text);
      try { await fresh.start(); assert.deepEqual((await fresh.render()).bytes, edited.bytes); }
      finally { await fresh.session.dispose(); await fs.rm(freshRoot, { recursive: true, force: true }); }
    } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });


test('headless stdin EOF exits while an unchanged prepared checkpoint holds the visible page', options, async () => {
  const root = await temp(), p = new Preview(root, body);
  try {
    await p.start(); await p.render();
    assert.equal((await p.prepared(p.prepare(body.indexOf('Prepare here.') + 8)))[4], 'ready');
    p.child!.stdin!.end();
    const deadline = Date.now() + 2000;
    while (p.child!.exitCode === null && p.child!.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(p.child!.exitCode, 0, 'held preparation must not keep a closed headless session alive');
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});


test('cancelled preparation survives source shortening, pause and retargeting without stale ready replies', options, async () => {
  const root = await temp(), p = new Preview(root, body);
  try {
    await p.start(); await p.render();
    const replays = p.replays, request = p.prepare(body.indexOf('Prepare here.') + 8);
    await p.until(() => p.replays > replays);
    p.session.send(['pause']); assert.equal((await p.prepared(request))[4], 'cancelled');
    const shorter = '\\documentclass{article}\\begin{document}Tiny.\\end{document}\n';
    p.replace(0, p.text.length, shorter);
    await p.until(() => !!p.state && p.state[2] === p.session.previewSequence);
    assert.equal((await p.prepared(p.prepare(0, path.join(root, 'unread.tex'))))[4], 'skipped');
    p.session.send(['resume']); const frame = await p.render(); assert.ok(frame.bytes.length > 1000);
    assert.ok(!p.messages.some(m => m[0] === 'preview-prepared' && m[1] === request && m[4] === 'ready'));
    const freshRoot = await temp(), fresh = new Preview(freshRoot, shorter);
    try { await fresh.start(); assert.deepEqual((await fresh.render()).bytes, frame.bytes); }
    finally { await fresh.session.dispose(); await fs.rm(freshRoot, { recursive: true, force: true }); }
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});


test('cancelled warm fence survives edits while the replay source is still unopened',
  { ...options, skip: options.skip || process.platform === 'win32' }, async () => {
    const root = await temp(), bin = path.join(root, 'bin'); await fs.mkdir(bin);
    const frontend = path.join(bin, 'texpresso'); await fs.copyFile(binary!, frontend); await fs.chmod(frontend, 0o755);
    const engine = path.resolve(path.dirname(binary!), 'texpresso-xetex');
    try { await fs.symlink(path.resolve(path.dirname(binary!), '../lib'), path.join(root, 'lib'), 'dir'); } catch { /* direct build uses absolute libraries */ }
    const marker = path.join(root, 'launches'), release = path.join(root, 'release');
    // The second root is a healthy delayed warm replay. Its protocol proxy
    // handshakes now and forwards the real worker only after the unread edit.
    await fs.writeFile(path.join(bin, 'texpresso-xetex'), `#!/usr/bin/env python3
import array, os, select, signal, socket, subprocess, sys, time
try:
    with open(${JSON.stringify(marker)}) as f: count = int(f.read()) + 1
except FileNotFoundError: count = 1
with open(${JSON.stringify(marker)}, 'w') as f: f.write(str(count))
if count != 2:
    os.execv(${JSON.stringify(engine)}, [${JSON.stringify(engine)}] + sys.argv[1:])
s = socket.socket(fileno=int(os.environ['TEXPRESSO_FD']))
s.sendall(b'TEXPRESSOC03')
data = b''
while len(data) < 12: data += s.recv(12 - len(data))
assert data == b'TEXPRESSOS03'
print('TXP-WARM-ROOT-STALL', file=sys.stderr, flush=True)
def exact(sock, n):
    data = b''
    while len(data) < n:
        part = sock.recv(n-len(data))
        if not part: raise EOFError()
        data += part
    return data
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
    assert exact(a, 12) == b'TEXPRESSOC03'
    a.sendall(b'TEXPRESSOS03')
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
    const source = '%' + 'x'.repeat(250) + '\n' + body;
    const p = new Preview(root, source, [], frontend);
    try {
      await p.start(); await p.render();
      const at = 100, target = at & ~63, request = p.prepare(at);
      await p.until(() => p.debug.includes('TXP-WARM-ROOT-STALL'));
      p.session.send(['preview-prepare-cancel', request]); assert.equal((await p.prepared(request))[4], 'cancelled');
      const tokens = p.rollbackTokens.length;
      p.replace(at, 0, 'first');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(p.rollbackTokens.length, tokens, 'editing an unopened replay source keeps its healthy worker');
      await fs.writeFile(release, 'continue'); const edited = await p.render();
      await p.until(() => p.checkpointOffsets.includes(target));
      const nextTokens = p.rollbackTokens.length;
      p.replace(at + 5, 0, 'second'); const final = await p.render();
      await p.until(() => p.rollbackTokens.length > nextTokens);
      assert.ok(p.rollbackTraces.slice(nextTokens).some(n => n > 0), 'the following edit reuses the retained checkpoint even before the first source token');
      assert.deepEqual(final.bytes, edited.bytes, 'editing only a source comment preserves the page');
    } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });


test('native request lifecycle preserves adjacent high IDs and source sequences through INT_MAX', options, async () => {
  const root = await temp(), source = body.replace('Second page.', 'Second page.\n'), p = new Preview(root, source);
  const raw: unknown[][] = [];
  try {
    await p.start(); await p.render();
    let pending = '';
    p.child!.stdout!.on('data', chunk => {
      pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) { try { const value = JSON.parse(line); if (Array.isArray(value)) { raw.push(value); } } catch { /* no binary exports in this phase */ } }
    });
    p.session.send(['pause']);
    const sequence = 2147483646, first = 1073741825, second = first + 1;
    p.session.previewSequence = sequence; p.session.send(['preview-barrier', sequence]);
    await p.until(() => p.state?.[2] === sequence);
    const late = source.split('\n').findIndex(line => line.includes('Second page.')) + 1;
    p.child!.stdin!.write([['preview-search', first, p.main.fileName, late, sequence],
      ['preview-search', second, p.main.fileName, late, sequence]].map(command => JSON.stringify(command)).join('\n') + '\n');
    await p.until(() => raw.some(m => m[0] === 'preview-cancelled' && m[1] === first));
    p.session.send(['resume']);
    await p.until(() => raw.some(m => m[0] === 'preview-source' && m[1] === second && m[3] === sequence));
    const stale = 2147483645;
    p.session.send(['preview-search', stale, p.main.fileName, late, sequence - 1]);
    await p.until(() => raw.some(m => m[0] === 'preview-cancelled' && m[1] === stale));
    p.session.previewSequence = sequence + 1; p.session.send(['preview-barrier', sequence + 1]);
    await p.until(() => p.state?.[2] === sequence + 1);
    const render = 2147483647;
    p.session.send(['pause']);
    p.child!.stdin!.write([['preview-render', render, 500, 1000, p.state![1], sequence + 1],
      ['preview-cancel', render, 0]].map(command => JSON.stringify(command)).join('\n') + '\n');
    await p.until(() => raw.some(m => m[0] === 'preview-cancelled' && m[1] === render));
    assert.ok(!raw.some(m => m[0] === 'preview-source' && m[1] === first), 'superseded high-ID search never resolves');
    assert.ok(!raw.some(m => m[0] === 'preview-source' && m[1] === stale), 'stale epoch search never resolves');
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});


function rawPreviewMessages(p: Preview): unknown[][] {
  const messages: unknown[][] = []; let pending = '';
  p.child!.stdout!.on('data', chunk => {
    pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) { try { const value = JSON.parse(line); if (Array.isArray(value)) { messages.push(value); } } catch { /* binary exports also share stdout */ } }
  });
  return messages;
}

test('successful EOF rejects missing requested pages and settles unknown-file source searches', options, async () => {
  const root = await temp(), p = new Preview(root, body);
  try {
    await p.start(); await p.render(); const raw = rawPreviewMessages(p);
    const search = 7001;
    p.session.send(['preview-search', search, path.join(root, 'never-input.tex'), 1, p.session.previewSequence]);
    await p.until(() => raw.some(m => m[0] === 'preview-cancelled' && m[1] === search) && p.state?.[4] === true);
    assert.equal(p.state![3], 2, 'the source search drove the real successful pass to EOF');
    const request = 7002;
    p.session.send(['preview-render', request, 500, 800, p.state![1], p.state![2]]);
    await p.until(() => p.images.has(request) || raw.some(m => m[0] === 'preview-error' && m[1] === request));
    assert.ok(!p.images.has(request), 'a missing page never exports the last page under the original request ID');
    assert.ok(raw.some(m => m[0] === 'preview-error' && m[1] === request), 'missing page request receives a terminal error');
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a passive image request cannot silently destroy a pending identified source search', options, async () => {
  const root = await temp();
  const text = '\\documentclass{article}\n\\begin{document}\n' +
    Array.from({ length: 20 }, (_, i) => `Rendered page ${i + 1}.\n${i < 19 ? '\\newpage\n' : ''}`).join('') + '\\end{document}\n';
  const p = new Preview(root, text);
  try {
    await p.start(); await p.render(); const raw = rawPreviewMessages(p);
    p.session.send(['pause']);
    const search = 7101, image = 7102, line = text.split('\n').findIndex(s => s.includes('Rendered page 20.')) + 1;
    p.child!.stdin!.write([['preview-search', search, p.main.fileName, line, p.session.previewSequence],
      ['preview-render', image, 1, 800, p.state![1], p.state![2]]].map(command => JSON.stringify(command)).join('\n') + '\n');
    p.session.send(['resume']);
    await p.until(() => raw.some(m => (m[0] === 'preview-source' || m[0] === 'preview-cancelled') && m[1] === search));
    const resolved = raw.find(m => m[0] === 'preview-source' && m[1] === search);
    if (resolved) { assert.equal(resolved[4], 19, 'the identified source result still belongs to its requested late page'); }
    else { assert.ok(raw.some(m => m[0] === 'preview-cancelled' && m[1] === search), 'preemption has an explicit terminal reply'); }
  } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
