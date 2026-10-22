import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TexpressoSession } from '../../session';
import { SessionPaths } from '../../paths';
import type { PreviewImage, PreviewMessage } from '../../preview-protocol';
import { config, document } from '../helpers';
import { diagnostics } from './diagnostics';

const binary = process.env.TEXPRESSO_BINARY;
test('real SVG preview: outlined glyphs, wrapped hyperlinks, lazy destinations and stale-link rejection',
  { skip: !binary || process.env.TEXPRESSO_TEST_PREVIEW !== '1', timeout: 90000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'texpresso-svg-')));
    const contents = String.raw`\documentclass{article}
\usepackage[xetex]{graphicx}
\usepackage[xetex]{xcolor}
\usepackage[xetex,hidelinks]{hyperref}
\begin{document}
\hypertarget{first}{First page.}
\href{https://example.com/a?x=1\&y=2}{External web link}.
\hyperlink{later}{Jump to a later page}.
\parbox{90pt}{\href{mailto:test@example.com}{This email link wraps across several lines of text.}}
\newpage
\hypertarget{later}{Later target.}
\hyperlink{first}{Back to first page}.
\newpage
\includegraphics[width=100pt]{transparency.pdf}
\end{document}
`;
    // Tiny deterministic PDF with knockout/non-normal blending, exercising
    // PDF -> DVI display list -> SVG preflight -> exact PNG fallback.
    const paint = 'q /GS1 gs 1 0 0 rg 0 0 120 120 re f 0 0 1 rg 50 50 120 120 re f Q';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /ExtGState << /GS1 5 0 R >> >> /Group << /S /Transparency /CS /DeviceRGB /I true /K true >> /Contents 4 0 R >>',
      `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`, '<< /Type /ExtGState /BM /Multiply /ca 0.5 >>'];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await fs.writeFile(path.join(root, 'transparency.pdf'), pdf);
    const main = document(path.join(root, 'links.tex'), contents); await fs.writeFile(main.fileName, contents);
    let state: Extract<PreviewMessage, ['preview-state', ...unknown[]]> | undefined;
    const frames = new Map<number, PreviewImage>(), retries = new Set<number>();
    const destinations: Extract<PreviewMessage, ['preview-destination', ...unknown[]]>[] = [];
    let failure: Error | undefined, debug = '', id = 0;
    const session = new TexpressoSession(main, { ...config, command: binary!, packageProvider: 'texlive', previewLocation: 'editor' },
      new SessionPaths(main.fileName, false), () => [main], {
        state() {}, output() {}, debug: text => { debug = (debug + text).slice(-100000); }, error: error => { failure = error; }, synctex() {},
        preview: event => {
          if ('header' in event) { frames.set(event.header.requestId, event); }
          else if (Array.isArray(event)) {
            if (event[0] === 'preview-state') { state = event; }
            if (event[0] === 'preview-retry') { retries.add(event[1]); }
            if (event[0] === 'preview-destination') { destinations.push(event); }
            if (event[0] === 'preview-error') { failure = new Error(event[2]); }
          }
        }
      });
    const until = async (predicate: () => boolean) => {
      const end = Date.now() + 35000;
      while (!predicate()) {
        if (failure || Date.now() > end) { throw failure || new Error('SVG preview timeout\n' + debug.slice(-7000)); }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    };
    const render = async (page: number, svg: boolean | 'auto', width = 1200, limit = 16000) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await until(() => !!state && state[2] === session.previewSequence);
        const request = ++id;
        if (svg === 'auto') { session.send(['preview-auto', request, page, width, state![1], state![2], limit]); }
        else { session.send([svg ? 'preview-svg' : 'preview-render', request, page, width, state![1], state![2]]); }
        await until(() => frames.has(request) || retries.has(request));
        if (frames.has(request)) { return frames.get(request)!; }
      }
      throw new Error('Too many obsolete SVG requests');
    };
    try {
      await session.start(); assert.equal(session.previewSvg, true); assert.equal(session.previewLinks, true);
      const png = await render(0, false), svg = await render(0, true);
      assert.equal(png.header.mime, 'image/png'); assert.equal(svg.header.mime, 'image/svg+xml');
      assert.equal(svg.header.fallback, undefined);
      assert.equal(session.previewAuto, true);
      const autoPng = await render(0, 'auto', 1200, 0), autoSvg = await render(0, 'auto', 1200, 200000);
      assert.equal(autoPng.header.mime, 'image/png'); assert.equal(autoPng.header.svgEligible, true);
      assert.ok(autoPng.header.vectorCost! > 0); assert.equal(autoPng.header.fallback, undefined);
      assert.deepEqual(autoPng.bytes, png.bytes, 'Auto PNG keeps exact reference pixels');
      assert.equal(autoSvg.header.mime, 'image/svg+xml'); assert.equal(autoSvg.header.vectorCost, autoPng.header.vectorCost);
      assert.deepEqual(autoSvg.bytes, svg.bytes, 'Auto SVG keeps exact reference paths');
      const automatic = await render(0, 'auto');
      assert.equal(automatic.header.mime, automatic.header.vectorCost! <= 16000 ? 'image/svg+xml' : 'image/png');
      const xml = svg.bytes.toString('utf8'); assert.match(xml, /<svg/); assert.match(xml, /<path/); assert.match(xml, /<use/);
      assert.doesNotMatch(xml, /<text\b|<script\b|https?:\/\/example/);
      const enlarged = await render(0, true, 2400);
      assert.deepEqual(enlarged.bytes, svg.bytes, 'SVG export is independent of raster width');
      assert.deepEqual(svg.header.annotations, png.header.annotations, 'interaction metadata is codec-independent');
      const links = svg.header.annotations!.links;
      assert.ok(links.some(link => link.uri === 'https://example.com/a?x=1&y=2'), JSON.stringify(svg.header.annotations));
      assert.ok(links.some(link => link.uri === '#later'));
      assert.ok(links.filter(link => link.uri === 'mailto:test@example.com').length >= 3, 'wrapped link has separate text-run rectangles');
      assert.ok(links.every(link => link.bounds[3] - link.bounds[1] < 30), 'wrapped links do not cover inter-line whitespace');
      assert.equal(state![3], 1, 'only the requested first page was compiled');
      const frameCount = frames.size;
      session.send(['preview-destination', state![1], state![2], 'later']);
      await until(() => destinations.some(d => d[3] === 'later'));
      assert.equal(destinations.find(d => d[3] === 'later')![4], 1);
      assert.equal(frames.size, frameCount, 'resolving links does not rasterize intermediate pages');
      const second = await render(1, true);
      assert.ok(second.header.annotations!.destinations.some(d => d.name === 'later' && d.y > 0));
      const previous = state!;
      session.send(['preview-barrier', ++session.previewSequence]);
      await until(() => state![2] === session.previewSequence);
      session.send(['preview-destination', previous[1], previous[2], 'stale-target']);
      session.send(['preview-destination', state![1], state![2], 'missing-target']);
      await until(() => destinations.some(d => d[3] === 'missing-target'));
      assert.equal(destinations.find(d => d[3] === 'missing-target')![4], -1);
      assert.ok(!destinations.some(d => d[3] === 'stale-target'));
      const fallback = await render(2, true), reference = await render(2, false);
      assert.equal(fallback.header.mime, 'image/png'); assert.match(fallback.header.fallback!, /transparency|blending/);
      const autoFallback = await render(2, 'auto', 1200, 200000);
      assert.equal(autoFallback.header.mime, 'image/png'); assert.equal(autoFallback.header.svgEligible, false);
      assert.equal(autoFallback.header.fallback, undefined);
      assert.deepEqual(autoFallback.bytes, reference.bytes);
      assert.deepEqual(fallback.bytes, reference.bytes, 'fallback preserves the PNG reference exactly');
      assert.doesNotMatch(debug, /LaTeX Error|Package .*Error:/);
    } catch (error) { await diagnostics(root, '', debug); throw error; }
    finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
