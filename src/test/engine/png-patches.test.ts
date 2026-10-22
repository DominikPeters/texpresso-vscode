import { test } from 'node:test';
import type * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

const { decode } = require('../../../scripts/profiling/png-regions.cjs') as {
  decode(bytes: Buffer): { width: number; height: number; channels: number; stride: number; raw: Buffer };
};
function rgb(bytes: Buffer) {
  const p = decode(bytes), pixels = Buffer.alloc(p.width * p.height * 3);
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) for (let c = 0; c < 3; c++) {
    pixels[(y * p.width + x) * 3 + c] = p.raw[y * p.stride + 1 + x * p.channels + (p.channels === 1 ? 0 : c)];
  }
  return { width: p.width, height: p.height, pixels };
}
const binary = process.env.TEXPRESSO_BINARY;
test('native PNG patches: exact chained RGB/gray edits, erasure, no-op metadata and keyframe recovery',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-png-patch-')));
    let text = String.raw`\documentclass{article}
\usepackage{xcolor}
\pagestyle{empty}
\begin{document}
The word aaaa is editable. Other text stays still.

\noindent\rule{90pt}{10pt}
\newpage
Second page.
\end{document}
`;
    const original = text, main = document(path.join(root, 'main.tex'), text);
    await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, id = 0, debug = '';
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], { state() {}, output() {}, synctex() {},
        debug: s => { debug = (debug + s).slice(-10000); }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) { if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); } } } });
    const until = async (check: () => boolean) => { const end = Date.now() + 30000;
      while (!check()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(r => setTimeout(r, 10)); } };
    const render = async (base: number | undefined, width = 1000, page = 0, auto = false) => {
      for (;;) { await until(() => !!state && state[2] === session.previewSequence); const request = ++id;
        if (base === undefined) { session.send(['preview-render', request, page, width, state![1], state![2]]); }
        else if (auto) { session.send(['preview-auto', request, page, width, state![1], state![2], 0, base]); }
        else { session.send(['preview-png', request, page, width, state![1], state![2], base]); }
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; } }
    };
    const change = (old: string, replacement: string) => { const offset = text.indexOf(old); assert.ok(offset >= 0);
      const position = (n: number) => { const before = text.slice(0, n); return { line: before.split('\n').length - 1, character: n - before.lastIndexOf('\n') - 1 }; };
      const range = { start: position(offset), end: position(offset + old.length) };
      text = text.slice(0, offset) + replacement + text.slice(offset + old.length);
      session.sync.change(main, [{ range: range as vscode.Range, rangeOffset: offset, rangeLength: old.length, text: replacement }]); };
    try {
      await session.start(); assert.equal(session.previewPngPatches, true);
      const full = await render(0), baseline = rgb(full.bytes), composite = Buffer.from(baseline.pixels);
      const chain: PreviewImage[] = [full];
      let base = full.header.rasterId!;
      const regionId = ++id;
      session.send(['preview-region', regionId, 0, 300, state![1], state![2], 0, 0, 100, 100]);
      await until(() => frames.has(regionId)); assert.equal(frames.get(regionId)!.header.rasterId, undefined);
      const same = await render(base); assert.equal(same.bytes.length, 0); assert.deepEqual(same.header.patch?.rect, [0,0,0,0]);
      assert.equal(same.header.patch?.base, base); base = same.header.rasterId!; chain.push(same);
      const apply = (frame: PreviewImage) => {
        assert.equal(frame.header.patch?.base, base); assert.ok(frame.bytes.length < full.bytes.length / 3);
        const [x,y,w,h] = frame.header.patch!.rect, crop = rgb(frame.bytes); assert.equal(crop.width,w); assert.equal(crop.height,h);
        for (let row=0;row<h;row++) crop.pixels.copy(composite, ((y+row)*baseline.width+x)*3, row*w*3,(row+1)*w*3);
        base = frame.header.rasterId!; chain.push(frame);
      };
      change('aaaa','aaaac'); apply(await render(base));
      change('aaaac','aaaa'); apply(await render(base)); assert.deepEqual(composite, baseline.pixels, 'backspace erases every added pixel');
      change('aaaa','\\textcolor{red}{aaaa}'); apply(await render(base,1000,0,true));
      change('90pt','110pt'); apply(await render(base));
      const reference = await render(undefined); assert.deepEqual(composite,rgb(reference.bytes).pixels, 'all chained regions reconstruct full reference exactly');
      const fixtures = process.env.TEXPRESSO_PNG_FIXTURES;
      if (fixtures) { await fs.mkdir(fixtures,{recursive:true});
        for (let i=0;i<chain.length;i++) { await fs.writeFile(path.join(fixtures,`${i}.png`),chain[i].bytes); }
        await fs.writeFile(path.join(fixtures,'reference.png'),reference.bytes);
        await fs.writeFile(path.join(fixtures,'frames.json'),JSON.stringify(chain.map(f=>f.header))); }
      const recovered = await render(base); assert.equal(recovered.header.patch, undefined, 'missing native base returns a full PNG');
      const wrong = await render(999999); assert.equal(wrong.header.patch, undefined);
      const resized = await render(wrong.header.rasterId!,1200); assert.equal(resized.header.patch,undefined);
      const other = await render(resized.header.rasterId!,1200,1); assert.equal(other.header.patch,undefined);
      const returned = await render(other.header.rasterId!); assert.equal(returned.header.patch,undefined);
      change(text, original); const restored = await render(returned.header.rasterId!);
      assert.ok(restored.header.patch, 'source barriers preserve the last acknowledged raster');
      assert.ok(!debug.includes('[fatal]'));
    } finally { await session.dispose(); await fs.rm(root,{recursive:true,force:true}); }
  });
