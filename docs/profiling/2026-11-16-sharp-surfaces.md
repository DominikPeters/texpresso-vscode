# Sharp surfaces and the rasterization lattice: 16 November 2026

Measurements behind [sharp surfaces](../sharp-surfaces.md): why rectangles of a
page grid are rasterized in fixed lattice cells, what cell size costs, and what
typing looks like with the display-density surface as the authoritative raster.

**Setup.** Apple M1 Pro, macOS, one engine at a time. Local development build
of the engine at `1bfd2e5` plus the surface changes, linked against Homebrew
MuPDF 1.28.6 and system zlib level 1 (the bundled engine uses zlib-ng level 2,
so encoding times here are pessimistic). Extension at `b5296e1` plus the
surface changes. TeX Live. Inputs are the repository's
`scripts/preview-demo/{showcase,lipsum,math}.tex` and a synthetic dense page
(source at the end). These are four documents and small edits, not a corpus.

Review follow-up: the final implementation confines lattice rendering to
`preview-surface`; legacy whole-page commands keep their previous pixels and
rounding for shared-engine compatibility. The lattice measurements below
describe the surface renderer and do not imply legacy commands use it.

## Why a shared transform is not enough

With one transform and integer device rectangles, a clipped render still
differed from the same pixels of the complete page: text never, paths wherever
one crossed the rectangle's border.

| Content (311 × 208 pt page, grid 1000) | Rectangles differing | Pixels differing | Largest channel difference |
| --- | ---: | ---: | ---: |
| Text (14 lines, 5.5–15 pt) | 0 of 5 | 0 | 0 |
| Thin translucent Bézier stroke | 4 of 5 | 17–135 | 8 |
| Translucent filled shape | 3 of 5 | 353–546 | 4 |
| Opaque even-odd filled shape | 4 of 5 | 3–718 | 13 |

MuPDF's scan converter re-interpolates an edge where it meets the clip, which
perturbs the edge's stepping for the rest of its length; most differing pixels
were in the interior of the rectangle, not at its border. Rasterizing each
pixel in its cell of a fixed lattice makes the result independent of the
request: all rectangles then matched exactly, in the unit test (180 random
rectangles over three page origins and five grid widths) and against the real
engine on a TikZ page (`src/test/engine/surfaces.test.ts`).

## Lattice cell size

Median `png-draw` of six renders, an edit before each to bypass the export
cache. "Whole" is the complete page at grid width 2000; "view" is a
2048 × 1536 rectangle of the grid 3404 wide, aligned for every size tested.

| Document | Request | Single pass | 1024 | **512** | 256 |
| --- | --- | ---: | ---: | ---: | ---: |
| showcase | whole 2000 × 2589 | 0.95 | 1.47 | 1.15 | 2.11 |
| showcase | view | 6.14 | 1.77 | 1.00 | 1.72 |
| dense | whole 2000 × 2589 | 81.15 | 82.41 | 78.91 | 88.33 |
| dense | view | 161.71 | 76.48 | 54.54 | 62.73 |
| lipsum | whole 2000 × 4000 | 4.08 | 4.24 | 4.88 | 5.79 |
| lipsum | view | 12.37 | 3.12 | 1.73 | 2.22 |
| math | whole 2000 × 1800 | 2.23 | 2.48 | 2.36 | 4.07 |
| math | view | 6.41 | 3.86 | 3.46 | 5.38 |

All times in milliseconds. A 512-pixel lattice costs at most 0.8 ms on a whole
page and is two to seven times faster than a single pass on the zoomed view.
Why a single pass is slower when zoomed was not investigated. Reproduce other
sizes by rebuilding the engine frontend with `-DTXP_PREVIEW_CELL=<n>`.

## Native export per request

`node scripts/profiling/surface-export.cjs native/texpresso/build/texpresso <file.tex> [anchor] ...`
Median milliseconds. The edit types one letter and names the retained raster of
the 2048 × 1536 view as its base.

| Document | Whole: draw / encode | View: draw / encode | Edit: total export | Edit: bytes sent |
| --- | ---: | ---: | ---: | ---: |
| showcase | 2.65 / 23.53 | 0.96 / 8.53 | 2.28 | 7,294 |
| dense | 75.22 / 37.29 | 52.47 / 24.39 | 50.92 | 0 |
| lipsum | 5.39 / 22.74 | 1.85 / 9.01 | 1.46 | 0 |
| math | 2.68 / 15.49 | 3.36 / 13.48 | 3.64 | 0 |

In the last three rows the typed letter lies outside the rectangle, so the
response is a no-op patch and the cost is the draw and comparison alone. The
dense page shows what remains to be gained: about 50 ms to redraw a plot that
the edit did not touch. Finding damage before rasterizing would remove that.

## Typing in the production webview

Production `PreviewController` and webview scripts, real engine, in a Chromium
pane over a local HTTP bridge that replaces VS Code's IPC (the same arrangement
as `scripts/profiling/browser.cjs`). Viewport 1009 × 731 CSS pixels at device
pixel ratio 2, fit width, PNG, `showcase.tex`. The page's grid is 2018 × 2612
(5.3 MP), so its surface is the rectangle `[0, 0, 2018, 2048]` (4.1 MP), shown
at exactly 1009 × 1024 CSS pixels.

Fifteen single-letter insertions 120 ms apart, after four warm-up edits; time
from sending the edit to the frame reaching the webview:

| | |
| --- | --- |
| Edits answered by an in-place patch | 15 of 15 |
| Median / maximum | 28.3 ms / 42.1 ms |
| Patch size | 1127 × 34 to 1550 × 111 pixels |
| Samples (every 4 ms) with the same canvas at one raster pixel per device pixel and no overlay | 488 of 488 |

With two pages visible, both hold surfaces and both are answered per edit (the
unedited one by a no-op patch): 50–60 ms in six edits. The first edits at a
location without a compiler checkpoint took about 120 ms to compile, during
which faster keystrokes were coalesced; the bridge has no editor cursor, so
edit prewarming never ran. That is compiler latency, unchanged by this work.

For comparison, the engine bundled with 2.0.1 (no `surfaces`) in the same
viewport: a 1757 × 2274 base stretched over 2018 device pixels, the detail crop
absent 80 ms after an edit and back after the pause.

## Not measured

* Peak native and browser memory.
* Scrolling, zoom gestures, reflowing edits and figure edits; p95 over a corpus.
* A real VS Code webview, non-integer pixel ratios on screen, Windows and Linux.
* The bundled engine build (zlib-ng, pinned MuPDF) and the CI platform matrix.

## Dense page

```latex
\documentclass{article}
\usepackage{tikz}
\usepackage[margin=2cm]{geometry}
\begin{document}
\section*{Dense translucent vector marks}
Some text above the plot so that an edit here leaves the plot unchanged.

\begin{center}
\begin{tikzpicture}
\pgfmathsetseed{7}
\draw[step=0.5,gray!30,very thin] (0,0) grid (15,18);
\foreach \i in {1,...,6000} {
  \pgfmathsetmacro\x{rnd*15}\pgfmathsetmacro\y{rnd*18}\pgfmathsetmacro\r{0.03+rnd*0.12}
  \fill[blue,opacity=0.25] (\x,\y) circle (\r);
}
\foreach \i in {1,...,60} {
  \pgfmathsetmacro\a{rnd*15}\pgfmathsetmacro\b{rnd*18}\pgfmathsetmacro\c{rnd*15}\pgfmathsetmacro\d{rnd*18}
  \draw[red,opacity=0.5,thin] (\a,\b) .. controls (\c,\b) and (\a,\d) .. (\c,\d);
}
\draw[thick,->] (0,0) -- (15.3,0); \draw[thick,->] (0,0) -- (0,18.3);
\end{tikzpicture}
\end{center}
\end{document}
```
