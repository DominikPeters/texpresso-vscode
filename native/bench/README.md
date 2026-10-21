# Embedded preview export experiment

This is an offline design experiment, independent of extension runtime code.
It compares PNG with outlined SVG export from a retained MuPDF display list.
The generated PDFs are test inputs for that common rendering boundary; live
TeXpresso documents use XDV and do not require producing a PDF first.

With a completed compact MuPDF build and local XeLaTeX/TikZ:

```sh
python3 native/bench/preview.py \
  --mupdf-build native/.work/build-ny6_3gtx/mupdf \
  --output native/.work/preview-bench-new
```

The output directory must be new. The script compiles a small C exporter,
generates three single-page fixtures, and writes PNG/SVG samples and JSON
measurements. Nothing is downloaded. It uses XeLaTeX, never Tectonic. macOS
builds use Xcode's compiler/SDK and the installed codec libraries; other hosts
may need to adjust library paths. Python 3.12+ is required. The MuPDF source
tree must already contain `build/vscode/{libmupdf.a,libmupdf-third.a}` built
with the repository profile.

The fixtures are repeated text/math, a dense TikZ drawing (2,000 circles and
2,000 line segments), and a deterministic noisy raster. The raster is a
compression stress case, not a representative photograph. Text includes
internal/external hyperref links; `text.xdv` retains their specials for inspection.

After one warm-up, the exporter averages seven replays of one display list at
1600 and 2400 pixels wide. PNG uses MuPDF's standard RGB, opaque-background
encoder. SVG outlines fonts and shares image resources. SVG serialization is
independent of requested raster width; some SVG content, such as shadings, is
rasterized at the SVG device's default resolution. The Python script separately
measures gzip levels 1 and 6. Loading the PDF and creating its display list is
reported separately. Disk writes are outside the export timings.

An optional browser comparison uses an **already installed** Playwright package
and Google Chrome:

```sh
node native/bench/browser.cjs native/.work/preview-bench-new
```

It creates an isolated temporary browser profile, blocks page network requests,
and loads generated data through Blob URLs. It records image decoding, decoding
plus two animation-frame waits, and a separate canvas draw/readback measurement.
It saves screenshots at 800 CSS pixels wide with DPR 2. Canvas timing includes
readback overhead; animation-frame timing includes refresh-rate waits. These
are microbenchmarks, not additive measurements of a real webview pipeline.
They exclude VS Code transport, gzip decompression, engine incrementality,
peak native/browser/GPU memory, and first-use font/resource costs.

To estimate the additional transfer saving from already-cached glyph outlines:

```sh
python3 native/bench/glyphs.py native/.work/preview-bench-new
```

This strips the fixtures' simple glyph path definitions before compression.
It estimates warm-cache body bytes, not a renderable image, measured browser
memory saving, or working dictionary protocol. It excludes protocol overhead
and does not handle arbitrary SVG or Type 3 resource dependencies.

The initial results and recommendations are in
[the design](../../docs/embedded-preview.md). Generated artifacts belong in
ignored `native/.work/`, not in Git. The small JSON results snapshot records
the measured environment and timings without committing binaries or fixtures.
