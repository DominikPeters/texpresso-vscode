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
  readonly checkpointOffsets: number[] = []; readonly rollbackTokens: number[] = []; readonly compilerEvents: string[] = []; private debugPending = '';
  constructor(readonly root: string, public text: string, readonly others: ReturnType<typeof document>[] = []) {
    this.main = document(path.join(root, 'main.tex'), text); this.main.getText = () => this.text;
    this.session = new TexpressoSession(this.main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: false },
      new SessionPaths(this.main.fileName, false), () => [this.main, ...others], {
        state() {}, output() {}, synctex: (file, line, _column, word) => { this.inverse.push({ file, line, word }); }, debug: value => {
          this.debug = (this.debug + value).slice(-30000); if (value.includes('[prepare-edit] replay')) { this.replays++; }
          this.debugPending += value; const lines = this.debugPending.split('\n'); this.debugPending = lines.pop()!;
          for (const line of lines) {
            if (/\[prepare-edit\]|\[fence\]|\[kill\]|\[change\]|compiler-rollback|compiler-checkpoint/.test(line)) { this.compilerEvents.push(line); }
            const at = line.indexOf('[profile] '); if (at < 0) { continue; } const record = JSON.parse(line.slice(at + 10));
            if (record.stage === 'compiler-checkpoint' && record.fence) { this.checkpointOffsets.push(record.offset); }
            if (record.stage === 'compiler-rollback') { this.rollbackTokens.push(record.resumeTokens); }
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
    assert.match(p.inverse[0].word || '', /Prepare|here/);
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
