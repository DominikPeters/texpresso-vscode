import { test } from 'node:test';
import type * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';

type Rect = [number, number, number, number];
// The engine's own writer: 8-bit gray or RGB, unfiltered rows. Surfaces may exceed the
// four megapixels the shared profiling decoder accepts.
function rgb(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const data: Buffer[] = []; let width = 0, height = 0, channels = 0;
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8), chunk = bytes.subarray(at + 8, at + 8 + size); at += size + 12;
    if (kind === 'IHDR') { width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); assert.equal(chunk[8], 8); assert.ok(chunk[9] === 0 || chunk[9] === 2); channels = chunk[9] === 0 ? 1 : 3; }
    if (kind === 'IDAT') { data.push(chunk); }
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels + 1, pixels = Buffer.alloc(width * height * 3);
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0);
    if (channels === 3) { raw.copy(pixels, y * width * 3, y * stride + 1, (y + 1) * stride); }
    else { for (let x = 0; x < width; x++) { pixels.fill(raw[y * stride + 1 + x], (y * width + x) * 3, (y * width + x + 1) * 3); } }
  }
  return { width, height, pixels };
}
/** The pixels of `clip` taken from a raster covering `outer`. */
function crop(image: { width: number; pixels: Buffer }, outer: Rect, clip: Rect): Buffer {
  const w = clip[2] - clip[0], h = clip[3] - clip[1], out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    image.pixels.copy(out, y * w * 3, ((clip[1] - outer[1] + y) * image.width + clip[0] - outer[0]) * 3, ((clip[1] - outer[1] + y) * image.width + clip[2] - outer[0]) * 3);
  }
  return out;
}

const binary = process.env.TEXPRESSO_BINARY;
test('native surfaces: every rectangle of a grid has the page\'s pixels; sharp patches, budgets and retained neighbours',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 120000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'txp-surface-')));
    // Text is exact under any clip; curves, hairlines and translucent overlap are what a
    // clip-dependent rasterizer gets slightly wrong where a path crosses the rectangle.
    let text = String.raw`\documentclass{article}
\usepackage{tikz}
\pagestyle{empty}
\begin{document}
The word aaaa is editable. Other text stays still, efficiently.

\noindent\begin{tikzpicture}
\draw[blue, very thin] (0,0) .. controls (4,7) and (8,-5) .. (12,6);
\draw[red, thin] (0,6) -- (12.3,0.2);
\fill[green!60!black, opacity=0.4] (3,3) circle (2.6);
\fill[orange, opacity=0.4] (6,2.5) ellipse (3.1 and 1.7);
\foreach \i in {0,...,40} { \draw[gray, very thin] (\i*0.3,0) -- (12-\i*0.3,6); }
\end{tikzpicture}

\noindent\rule{90pt}{10pt}
\newpage
Second page, with its own surface.
\end{document}
`;
    const main = document(path.join(root, 'main.tex'), text);
    await fs.writeFile(main.fileName, text);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined, failure: Error | undefined, id = 0, debug = '';
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], { state() {}, output() {}, synctex() {},
        debug: s => { debug = (debug + s).slice(-10000); }, error: e => { failure = e; },
        preview: event => { if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) { if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry' || event[0] === 'preview-cancelled') { retries.add(event[1]); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); } } } });
    const until = async (check: () => boolean) => { const end = Date.now() + 60000;
      while (!check()) { if (failure || Date.now() > end) { throw failure || new Error(debug); } await new Promise(r => setTimeout(r, 10)); } };
    const request = async (send: (request: number) => void) => {
      for (;;) { await until(() => !!state && state[2] === session.previewSequence); const request = ++id; send(request);
        await until(() => frames.has(request) || retries.has(request)); if (frames.has(request)) { return frames.get(request)!; } }
    };
    const surface = (grid: number, clip: Rect, base = 0, page = 0, background: 0 | 1 = 0, codec: 0 | 1 | 2 = 0) =>
      request(r => session.send(['preview-surface', r, page, grid, state![1], state![2], ...clip, codec, 0, base, background]));
    const change = (old: string, replacement: string) => { const offset = text.indexOf(old); assert.ok(offset >= 0);
      const position = (n: number) => { const before = text.slice(0, n); return { line: before.split('\n').length - 1, character: n - before.lastIndexOf('\n') - 1 }; };
      const range = { start: position(offset), end: position(offset + old.length) };
      text = text.slice(0, offset) + replacement + text.slice(offset + old.length);
      session.sync.change(main, [{ range: range as vscode.Range, rangeOffset: offset, rangeLength: old.length, text: replacement }]); };
    try {
      await session.start();
      assert.equal(session.previewSurfaces, true); assert.ok(session.previewMaxPixels > 4000000, 'the session is launched with the engine\'s surface budget');

      // One grid, many rectangles: each must equal the corresponding pixels of the complete page.
      for (const grid of [1000, 1401, 2000]) {
        const whole = await surface(grid, [0, 0, grid, 100000]);
        const [gw, gh] = whole.header.grid!;
        assert.equal(gw, grid); assert.deepEqual(whole.header.clip, [0, 0, gw, gh], 'a rectangle is clamped to the page');
        assert.equal(whole.header.width, gw); assert.equal(whole.header.height, gh);
        assert.equal(whole.header.bounds[0], 0); assert.ok(whole.header.bounds[2] > 600, 'bounds stay those of the complete page');
        assert.ok(whole.header.rasterId); assert.ok(whole.header.textBounds, 'surfaces are page frames and keep page metadata');
        const page = rgb(whole.bytes); assert.equal(page.width, gw); assert.equal(page.height, gh);
        assert.ok(page.pixels.some(n => n !== 255));
        const full: Rect = [0, 0, gw, gh];
        const rects: Rect[] = [[0, 0, 512, 512], [512, 512, Math.min(gw, 1024), 1024], [100, 137, 613, 700], [0, 300, gw, 301],
          [gw - 1, gh - 1, gw, gh], [256, 0, 700, gh], [333, 400, 334, 900]];
        for (const rect of rects) {
          const part = await surface(grid, rect);
          assert.deepEqual(part.header.clip, rect); assert.deepEqual(part.header.grid, [gw, gh]);
          assert.deepEqual(part.header.bounds, whole.header.bounds);
          const image = rgb(part.bytes);
          assert.equal(image.width, rect[2] - rect[0]); assert.equal(image.height, rect[3] - rect[1]);
          assert.ok(image.pixels.equals(crop(page, full, rect)), `grid ${grid}, rectangle ${rect}: identical to the complete page`);
        }

      }

      // Display density beyond four megapixels, and trimming rather than rescaling at the session budget.
      const large = await surface(3404, [0, 0, 3072, 2048]);
      assert.equal(large.header.width * large.header.height, 3072 * 2048); assert.deepEqual(large.header.clip, [0, 0, 3072, 2048]);
      const trimmed = await surface(8000, [0, 0, 8000, 8000]);
      assert.equal(trimmed.header.grid![0], 8000); assert.equal(trimmed.header.clip![2], 8000);
      assert.ok(trimmed.header.width * trimmed.header.height <= session.previewMaxPixels, 'rows are trimmed; the scale is untouched');
      assert.equal(trimmed.header.clip![3], Math.floor(session.previewMaxPixels / 8000));

      // Patches are computed at display density against the named raster.
      const clip: Rect = [0, 0, 2048, 1536], grid = 3404;
      const key = await surface(grid, clip); let base = key.header.rasterId!;
      const composite = Buffer.from(rgb(key.bytes).pixels), width = clip[2] - clip[0];
      const same = await surface(grid, clip, base);
      assert.deepEqual(same.header.patch, { base, rect: [0, 0, 0, 0] }); assert.equal(same.bytes.length, 0); base = same.header.rasterId!;
      const apply = (frame: PreviewImage) => {
        assert.equal(frame.header.patch?.base, base, debug); assert.deepEqual(frame.header.clip, clip);
        const [x, y, w, h] = frame.header.patch!.rect, part = rgb(frame.bytes); assert.equal(part.width, w); assert.equal(part.height, h);
        assert.ok(x + w <= width && y + h <= clip[3] - clip[1], 'patch rectangles are relative to the surface');
        for (let row = 0; row < h; row++) { part.pixels.copy(composite, ((y + row) * width + x) * 3, row * w * 3, (row + 1) * w * 3); }
        base = frame.header.rasterId!;
      };
      change('aaaa', 'aaab'); const edited = await surface(grid, clip, base); apply(edited);
      assert.ok(edited.bytes.length < key.bytes.length / 4, 'a one-letter edit sends a small rectangle');
      assert.ok(edited.header.patch!.rect[2] * edited.header.patch!.rect[3] < width * (clip[3] - clip[1]) / 20);
      // A neighbour's surface, rendered speculatively, is retained beside the active page's.
      const second = await surface(grid, [0, 0, 2048, 1024], 0, 1, 1);
      assert.equal(second.header.page, 1); assert.ok(second.header.rasterId);
      // The rule lies below this rectangle: an edit outside it transfers no pixels at all.
      change('90pt', '110pt'); const outside = await surface(grid, clip, base);
      assert.deepEqual(outside.header.patch, { base, rect: [0, 0, 0, 0] }); assert.equal(outside.bytes.length, 0); base = outside.header.rasterId!;
      change('aaab', 'aaabcd'); apply(await surface(grid, clip, base));
      const neighbour = await surface(grid, [0, 0, 2048, 1024], second.header.rasterId!, 1, 1);
      assert.deepEqual(neighbour.header.patch, { base: second.header.rasterId, rect: [0, 0, 0, 0] }, 'an unchanged neighbour is a no-op patch against its own raster');
      const reference = await surface(grid, clip);
      assert.ok(composite.equals(rgb(reference.bytes).pixels), 'chained sharp patches reconstruct a fresh render exactly');

      // Anything but the same page, grid and rectangle is a complete surface; a released base cannot be reused.
      const moved = await surface(grid, [0, 512, 2048, 2048], reference.header.rasterId!);
      assert.equal(moved.header.patch, undefined); assert.equal(moved.bytes.length > 1000, true);
      assert.equal((await surface(grid, clip, reference.header.rasterId!)).header.patch, undefined, 'the named base was released when it was replaced');
      const regrid = await surface(grid, clip); assert.equal((await surface(grid + 1, clip, regrid.header.rasterId!)).header.patch, undefined);
      assert.ok(!debug.includes('[fatal]'));
    } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
