import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const binary = process.env.TEXPRESSO_BINARY;
type Profile = { stage: string; tokens?: number; resumeTokens?: number; fence?: boolean; outcome?: string };
class AnchorPreview {
  readonly files: { name: string; text: string; doc: ReturnType<typeof document> }[];
  readonly session: TexpressoSession;
  readonly profiles: Profile[] = [];
  readonly messages: PreviewMessage[] = [];
  readonly images = new Map<number, PreviewImage>();
  state?: Extract<PreviewMessage, ['preview-state', ...unknown[]]>;
  failure?: Error; debug = ''; pending = ''; decimations = 0; id = 0;
  readonly selectionTables: number[] = []; private listing = -1;
  constructor(readonly root: string, sources: Record<string, string>) {
    this.files = Object.entries(sources).map(([name, text]) => {
      const entry = { name, text, doc: document(path.join(root, name), text) };
      entry.doc.getText = () => entry.text; return entry;
    });
    const main = this.files[0].doc;
    this.session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: false, streamFiles: true },
      new SessionPaths(main.fileName, false), () => this.files.map(file => file.doc), {
        state() {}, output() {}, synctex() {}, error: error => { this.failure = error; },
        debug: value => {
          this.debug = (this.debug + value).slice(-30000); this.pending += value;
          const lines = this.pending.split('\n'); this.pending = lines.pop()!;
          for (const line of lines) {
            if (line.includes('after process decimation:')) { this.decimations++; this.listing = 0; }
            else if (this.listing >= 0) {
              if (line.startsWith('- position ')) { this.listing++; }
              else { this.selectionTables.push(this.listing); this.listing = -1; }
            }
            const at = line.indexOf('[profile] ');
            if (at >= 0) { this.profiles.push(JSON.parse(line.slice(at + 10)) as Profile); }
          }
        }, preview: event => {
          if ('header' in event) { this.images.set(event.header.requestId, event); }
          else if (Array.isArray(event)) { this.messages.push(event); if (event[0] === 'preview-state') { this.state = event; } }
        }
      }, undefined, (command, args, options) => spawn(command, args, { ...options, env: { ...process.env, ...options.env, TEXPRESSO_PROFILE: '1' } }));
  }
  async until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 30000;
    while (!condition()) {
      if (this.failure || Date.now() > deadline) { throw this.failure || new Error(this.debug); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  async start(): Promise<void> {
    for (const file of this.files) { await fs.writeFile(file.doc.fileName, file.text); }
    await fs.writeFile(path.join(this.root, 'stable.dat'), '\\def\\StableValue{same}\n');
    await this.session.start();
  }
  replace(name: string, offset: number, length: number, text: string): void {
    const file = this.files.find(file => file.name === name)!;
    const position = (n: number) => { const before = file.text.slice(0, n); return { line: before.split('\n').length - 1, character: n - before.lastIndexOf('\n') - 1 }; };
    const range = { start: position(offset), end: position(offset + length) } as import('vscode').Range;
    file.text = file.text.slice(0, offset) + text + file.text.slice(offset + length);
    this.session.sync.change(file.doc, [{ rangeOffset: offset, rangeLength: length, text, range }]);
  }
  async render(page: number): Promise<PreviewImage> {
    for (;;) {
      await this.until(() => !!this.state && this.state[2] === this.session.previewSequence);
      const id = ++this.id;
      this.session.send(['preview-render', id, page, 800, this.state![1], this.state![2]]);
      await this.until(() => this.images.has(id) || this.messages.some(message => ['preview-retry', 'preview-error'].includes(message[0]) && message[1] === id));
      if (this.images.has(id)) { return this.images.get(id)!; }
      assert.ok(!this.messages.some(message => message[0] === 'preview-error' && message[1] === id), this.debug);
    }
  }
  async finish(outcome: string): Promise<void> {
    const start = this.profiles.length;
    this.session.send(['rerun-once']);
    await this.until(() => this.profiles.slice(start).some(event => event.stage === 'compiler-convergence' && event.outcome === outcome));
  }
  async clean(pages: number[]): Promise<PreviewImage[]> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-anchor-clean-')));
    const reference = new AnchorPreview(root, Object.fromEntries(this.files.map(file => [file.name, file.text])));
    try {
      await reference.start(); const frames: PreviewImage[] = [];
      for (const page of pages) { frames.push(await reference.render(page)); }
      return frames;
    }
    finally { await reference.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  }
}

test('edit anchors survive failed finishing and large undo, while earlier and other-file edits remain correct',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-edit-anchors-')));
    const rootText = String.raw`\documentclass{article}
\usepackage{amsmath,amsthm}
\newtheorem{theorem}{Theorem}
\nofiles
\newwrite\stableout
\begin{document}
\input{stable.dat}
\immediate\openout\stableout=stable.dat
\immediate\write\stableout{\string\def\string\StableValue{same}}
First page.\newpage
${'%' + 'r'.repeat(2046) + '\n'}
\newcount\slow\slow=0
\loop\advance\slow by1\ifnum\slow<500000\repeat
\input{chapter.tex}
\immediate\write\stableout{\string\def\string\StableValue{same}}
\newpage
\input{other.tex}\newpage
` + Array.from({ length: 640 }, (_, i) => `Later paragraph ${i}. This varied suffix exercises complete compiler checkpoint coverage without changing the edited include.\\par\n`).join('') + '\\end{document}\n';
    const chapter = '%' + 'c'.repeat(1022) + '\nAnchor sentence.\\par\n';
    const other = '%' + 'o'.repeat(1022) + '\nOther editable source.\\par\n';
    const p = new AnchorPreview(root, { 'main.tex': rootText, 'chapter.tex': chapter, 'other.tex': other });
    try {
      await p.start(); await p.render(1);
      // Establish an existing foreground READ fence before the later paste.
      const insertion = chapter.indexOf('sentence.') + 'sentence.'.length;
      let start = p.profiles.length;
      p.replace('chapter.tex', insertion, 0, 'kept '); await p.render(1);
      const anchor = p.profiles.slice(start).filter(event => event.stage === 'compiler-checkpoint' && event.fence).at(-1)?.tokens;
      assert.ok(anchor && anchor > 0, 'the local edit creates a measurable safe prefix checkpoint');
      const offset = insertion + 'kept '.length;
      const broken = String.raw`
\subsection{A repaired local claim}
\begin{theorem}For $0<x<1$, the finite sum is bounded.\end{theorem}
\begin{proof}Sum the bounds using a geometric series.\end{proof}
\begin{align*}
 R_n(x) &= \sum_{j=1}^{n}x^j
`;
      const repair = String.raw` &= \frac{x(1-x^n)}{1-x}.
\end{align*}
`;
      const oldDecimations = p.decimations;
      p.replace('chapter.tex', offset, 0, broken);
      await p.until(() => p.state?.[2] === p.session.previewSequence);
      await p.finish('incomplete');
      assert.ok(p.decimations > oldDecimations, 'failed finishing traverses enough suffix to exercise checkpoint eviction');
      start = p.profiles.length;
      p.replace('chapter.tex', offset + broken.length, 0, repair); await p.render(1);
      const repaired = p.profiles.slice(start).find(event => event.stage === 'compiler-rollback');
      start = p.profiles.length;
      p.replace('chapter.tex', offset, broken.length + repair.length, '');
      const undone = await p.render(1);
      const rollback = p.profiles.slice(start).find(event => event.stage === 'compiler-rollback');
      t.diagnostic(JSON.stringify({ anchor, repaired, rollback, decimations: p.decimations,
        selectionTables: p.selectionTables, selections: p.profiles.filter(event => event.stage === 'compiler-decimation') }));
      assert.ok(repaired && repaired.resumeTokens! >= anchor-1000, `repair should retain its expensive prefix, anchor ${anchor}, rollback ${JSON.stringify(repaired)}`);
      assert.ok(rollback && rollback.resumeTokens! >= anchor-1000, `undo should retain its expensive prefix, anchor ${anchor}, rollback ${JSON.stringify(rollback)}`);
      assert.deepEqual(undone.bytes, (await p.clean([1]))[0].bytes, 'undo image matches an independent clean engine');
      // A distinct file can establish another site; equal offsets are not identities.
      p.replace('other.tex', other.indexOf('Other'), 5, 'Fresh');
      const changedOther = await p.render(2);
      assert.deepEqual(changedOther.bytes, (await p.clean([2]))[0].bytes, 'another source file is rebuilt correctly');
      start = p.profiles.length;
      p.replace('main.tex', p.files[0].text.indexOf('First page.'), 'First'.length, 'Changed');
      const changedFirst = await p.render(0), changedChapter = await p.render(1);
      const earlier = p.profiles.slice(start).find(event => event.stage === 'compiler-rollback');
      assert.ok(earlier && earlier.resumeTokens! < anchor, 'earlier edits invalidate later include anchors');
      const clean = await p.clean([0, 1]);
      assert.deepEqual(changedFirst.bytes, clean[0].bytes); assert.deepEqual(changedChapter.bytes, clean[1].bytes);
    } finally { await p.session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
