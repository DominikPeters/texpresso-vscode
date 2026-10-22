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
test('convergence accepts identical filesystem auxiliary input but rereads changed output',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-aux-stability-')));
    await fs.writeFile(path.join(root, 'stable.dat'), '\\def\\StableValue{same}\n');
    let text = String.raw`\documentclass{article}
\nofiles
\newwrite\stableout
\begin{document}
\input{stable.dat}
\typeout{READ-VALUE:\StableValue}
\StableValue
\immediate\openout\stableout=stable.dat
\immediate\write\stableout{\string\def\string\StableValue{same}}
\immediate\closeout\stableout
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), text); main.getText = () => text;
    await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, debug = '', output = '', id = 0;
    let stableDisk = false, stablePasses = 0, finishing = 0, changedRead = false, pending = '';
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: false },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output: (target, value) => { if (target === 'out') { output = value; changedRead ||= output.includes('READ-VALUE:changed'); } }, synctex() {},
        debug: value => {
          debug = (debug + value).slice(-15000); pending += value;
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines) {
            stableDisk ||= line.includes('stable.dat unchanged from filesystem input');
            if (line.includes('aux byte-stable, convergence reached')) { stablePasses++; }
            if (line.includes('on-demand: finishing pass')) { finishing++; }
          }
        }, error: e => { failure = e; }, preview: event => {
          if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
          }
        }
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 25000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug + '\n' + output); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    const render = async () => {
      for (;;) { await until(() => !!state && state[2] === session.previewSequence); const request = ++id;
        session.send(['preview-render', request, 0, 800, state![1], state![2]]);
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; }
      }
    };
    try {
      await session.start(); await render(); assert.match(output, /READ-VALUE:same/);
      session.send(['rerun-once']); await until(() => stablePasses === 1);
      assert.ok(stableDisk, 'identical consumed disk bytes need no convergence-created stash');
      await render();
      const offset = text.indexOf('{same}'), before = text.slice(0, offset);
      const line = before.split('\n').length - 1, character = offset - before.lastIndexOf('\n') - 1;
      text = text.slice(0, offset) + '{changed}' + text.slice(offset + 6);
      session.sync.change(main, [{ rangeOffset: offset, rangeLength: 6, text: '{changed}',
        range: { start: { line, character }, end: { line, character: character + 6 } } as import('vscode').Range }]);
      await render(); const oldFinishing = finishing;
      session.send(['rerun-once']); await until(() => finishing > oldFinishing && changedRead);
      assert.ok(changedRead, 'changed auxiliary bytes still feed the next real compiler pass');
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });

test('stable convergence restores late-input trace counters and page metadata before later edits',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 60000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-aux-late-')));
    let source = String.raw`\documentclass{article}
\nofiles
\newwrite\stableout
\makeatletter\let\primitiveinput\@@input\makeatother
\begin{document}
\input{stable.dat}
\immediate\openout\stableout=stable.dat
\immediate\write\stableout{same}
\immediate\closeout\stableout
First page.\newpage
`;
    // Force a READ checkpoint after first-page output, before the primitive
    // input. The short late file uses fewer than 500 tokens and adds no later
    // snapshot. The retained trace therefore predates this file's first read.
    source += '%' + 'x'.repeat(2048 - Buffer.byteLength(source) - 2) + '\n';
    source += String.raw`\primitiveinput late.tex
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), source);
    let lateText = 'Late first.\n'; const late = document(path.join(root, 'late.tex'), lateText); late.getText = () => lateText;
    await fs.writeFile(main.fileName, source); await fs.writeFile(late.fileName, lateText);
    await fs.writeFile(path.join(root, 'stable.dat'), 'same\n');
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, debug = '', id = 0;
    let stable = 0, launches = 0, pending = '';
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const targets: Extract<PreviewMessage, ['preview-forward', ...unknown[]]>[] = [];
    const inverse: { file: string; line: number; word?: string }[] = [];
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor', autoRerun: false },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, synctex: (file, line, _column, word) => inverse.push({ file, line, word }),
        debug: value => { debug = (debug + value).slice(-20000); pending += value;
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines) {
            if (line.includes('aux byte-stable, convergence reached')) { stable++; }
            if (line.includes('[process] launched pid')) { launches++; }
          }
        }, error: e => { failure = e; }, preview: event => {
          if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-forward') { targets.push(event); }
          }
        }
      });
    const until = async (condition: () => boolean) => { const end = Date.now() + 25000;
      while (!condition()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(resolve => setTimeout(resolve, 10)); } };
    const render = async (page: number) => {
      for (;;) { await until(() => !!state && state[2] === session.previewSequence); const request = ++id;
        session.send(['preview-render', request, page, 800, state![1], state![2]]);
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; }
      }
    };
    try {
      await session.start(); await render(0);
      const oldStable = stable; session.send(['rerun-once']); await until(() => stable > oldStable);
      assert.equal(launches, 1, 'stable finishing keeps an existing live snapshot');
      await until(() => !!state && state[3] === 1);
      let previousPng: Buffer | undefined;
      for (const replacement of ['changed', 'updated']) {
        session.sync.openDocument(late);
        const old = lateText.slice(5, -2); lateText = 'Late ' + replacement + '.\n';
        session.sync.change(late, [{ rangeOffset: 5, rangeLength: old.length, text: replacement,
          range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 + old.length } } as import('vscode').Range }]);
        const frame = await render(1); assert.equal(frame.header.page, 1);
        if (previousPng) { assert.notDeepEqual(frame.bytes, previousPng, 'second included-file edit changes the rendered page'); }
        previousPng = frame.bytes;
        const oldTargets = targets.length; session.sync.syncForward(late, 0); await until(() => targets.length > oldTargets);
        const target = targets.at(-1)!; assert.equal(target[3], 1);
        const oldInverse = inverse.length;
        session.send(['preview-inverse', target[1], target[2], 1, target[4], target[5]]);
        await until(() => inverse.length > oldInverse);
        assert.equal(inverse.at(-1)!.file, late.fileName); assert.equal(inverse.at(-1)!.line, 1);
        assert.match(inverse.at(-1)!.word || '', new RegExp('Late|' + replacement));
      }
      assert.ok(!debug.includes('[fatal]'));
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
