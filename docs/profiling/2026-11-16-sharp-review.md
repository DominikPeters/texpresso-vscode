# Sharp-surface review and conservative damage experiment

16 November 2026. The reviewed surface implementation fixes the typing blur in
the measured workloads. A separate pre-rasterization damage prototype helps the
dense real slide substantially, but is not an unconditional improvement and is
not included in the shipping engine. Data: [compact results](2026-11-16-sharp-review.json).

## Implementation review

The native change is `87e1cbbcc99e0f6a6037569b5204ff4dc057596f`, based on
`1bfd2e5`. The extension changes are on `codex/sharp-surfaces`, draft
[PR 40](https://github.com/DominikPeters/texpresso-vscode/pull/40); the native
companion is [PR 1](https://github.com/DominikPeters/texpresso/pull/1).

Review corrections:

- Keep legacy whole-page and magnifier commands on their previous single-pass
  renderer, including dimension rounding. Only `preview-surface` opts into the
  canonical lattice. The TeXstudio chat independently recommended this; its Qt
  canvas does not yet position partial surfaces. Its engine pin is unchanged.
- Prune host patch-base metadata when the browser evicts its decoded canvas.
  Otherwise visiting many pages accumulates metadata for unavailable patch bases.
- Recognize `preview-surface` in integration diagnostics. Navigation cache tests
  count authoritative exports separately from optional coarse placeholders.
- Fix the additional packaged-command navigation race: the host previously
  rendered using a nearby page's coarse prefetch width before the webview sent
  its sharp grid/clip. A per-jump acknowledgment now gates rendering; old queued
  viewport/ready replies cannot unblock it. Missing replies recover the webview,
  and late coarse prefetches cannot overwrite a retained sharp page.
- Snap page positions in screen coordinates, including viewport origin and
  scrolling. At DPR 1.25 a 37 CSS-pixel toolbar places the viewport at physical
  y=46.25: locally integer positions still resample the page. Measured phase error
  fell from 0.25 device pixels to at most 0.00586 (CSS layout quantization). At
  DPR 1.5 the maximum was 0.00391; at DPR 2 it was zero during typing.
- Document that the viewport pixel budget is a planning target, not a cap on all
  native, browser, transport and GPU allocations combined.

Local validation: 264 unit tests, lint, native PNG/grid/retention tests, all 64
real-engine tests with preview coverage explicitly enabled, and the production
preview in the installed VS Code webview passed. Native pixel tests include
overlapping regions, nonzero origins, text, curves, transparency and a real TikZ
page. The experiment below is additional evidence, not a replacement for CI.

Final production revision `947455f3148647d51ec2fbd24733e7b8cab9b2d5` passed
[Tests, including Windows/WSL](https://github.com/DominikPeters/texpresso-vscode/actions/runs/43885237021)
and [installed Linux x64/arm64 VSIX acceptance](https://github.com/DominikPeters/texpresso-vscode/actions/runs/43885236993).
The same native engine pin also passed
[both macOS bundle builds](https://github.com/DominikPeters/texpresso-vscode/actions/runs/43874544507).
The engine and extension PRs are ready for review; nothing has been released.

## Browser comparison

Production controller and webview scripts through the existing local HTTP bridge
in Chromium 157; M1 Pro, macOS, 1400 × 1000 CSS viewport, PNG, DPR 2. The same
local native engine, MuPDF 1.28.6 and system zlib level 1 serve both policies.
The baseline disables only the `surfaces` capability through the harness's probe
adapter, retaining the legacy whole-page/detail path. These are not packaged
release-binary timings and HTTP is not VS Code IPC. Actual VS Code integration
was checked separately for correctness.

Three generated three-page cases: packed prose, TikZ graphics and a mixed raster/
math/prose document. Open-loop input at 125 ms intervals: 12 letters followed by
12 backspaces; TikZ adds eight coordinate edits. Navigation, 200% zoom, fit-width
and the magnifier run outside those input phases. One measured workload per
case/policy; p95 is descriptive of these 24/32 inputs, not a population estimate.
An initial instrumentation warmup is excluded. All reported runs have no harness
errors. The final surface runs follow the screen-position correction.
They precede the subsequent host-command navigation correction at `947455f`;
the browser workload navigates through the page input, while packaged command
navigation is validated separately in the VS Code integration suite.

Latency below is input injection to the first paint opportunity of a revision
that includes that input. Coalesced intermediate revisions count as caught-up
when a later revision appears; they are not counted as exact individual frames.
Two animation frames approximate a paint opportunity, not OS presentation.

| Case | Legacy median / p95 | Surfaces median / p95 | Sharp sampled typing frames, legacy → surfaces |
| --- | ---: | ---: | ---: |
| Packed prose | 45 / 263 ms | 41 / 308 ms | 0/116 → 115/115 |
| TikZ | 1970 / 2475 ms | 1431 / 2021 ms | 0/300 → 249/249 |
| Mixed raster/math | 1164 / 2904 ms | 58 / 374 ms | 0/177 → 116/116 |

Sharp samples require either a main raster at ≥98% of physical display density,
or a detail overlay at that density covering the visible page portion. Sampling
every 32 ms includes input and post-input settling. All 480 surface samples were
at density 1; the legacy policy had no fully sharp samples in these phases. The
fractional-scale prose runs also passed: 115/115 at DPR 1.25 and 116/116 at 1.5.
This checks geometry/coverage, not a perceptual text-quality score.

The TikZ case shows why sharpness and latency must be reported separately. Each
burst produced only its final edited revision in both policies; the surface
stayed sharp but old while compilation caught up. Active native exports were
tens of milliseconds, not the full 1–2 second input latency. This bridge has no
editor cursor and does not exercise cursor-driven edit prewarming. The result
does not establish starvation-free compilation, and pre-rasterization damage
cannot remove time spent compiling the document. Maximum sampled age of the
oldest input not yet represented was about 1.98 seconds with surfaces versus
2.47 seconds with the legacy policy in this case.

### Resource cost

| Case | Native observed CPU, legacy → surfaces | Chromium observed CPU, legacy → surfaces | Decoded-cache estimate peak, legacy → surfaces |
| --- | ---: | ---: | ---: |
| Packed prose | 1.00 → 0.97 s | 1.29 → 1.22 s | 15.6 → 58.0 MiB |
| TikZ | 10.01 → 8.76 s | 1.25 → 0.94 s | 15.6 → 58.4 MiB |
| Mixed | 2.25 → 1.85 s | 1.45 → 1.36 s | 17.1 → 66.8 MiB |

CPU is the sum of per-task counter deltas between first/last observed samples;
it excludes work before/after sampling and the Node HTTP bridge. It is not a
complete machine-wide CPU measurement. Cache estimates include decoded RGBA
and encoded payload estimates, not all browser memory. Mounted canvases peaked
around 32.9 MiB of RGBA with surfaces versus 16.1 MiB in the legacy run; detached
cached canvases and other allocations are additional.

The macOS sampler polls task accounting every 50 ms. Chromium PIDs, including
renderer and GPU processes, are refreshed through CDP every 400 ms. Native
non-zombie footprint sums peaked around 240–271 MiB with surfaces and 255–268 MiB
with the legacy policy. Whole Chromium process-pool footprint sums were roughly
1.0–1.3 GiB in both sets; RSS sums and process details are in the JSON. These
pool totals include browser overhead/caches and the tool's blank page, not just
the preview; shared surfaces and copy-on-write pages are not deduplicated. Browser
processes persist between cases, so these figures cannot establish a memory
reduction or be attributed entirely to the extension. Sampling can miss short
allocation peaks. They also do not prove a bound or absence of long-term leaks.

The clear measured trade-off is approximately 42–50 MiB more decoded-cache
retention in this wide pane in exchange for keeping sharp pixels. A future
retention-policy comparison must include this cost as well as navigation speed.

## Pre-rasterization damage prototype

This is a scratch engine, built by
[build-damage-engine.cjs](../../scripts/profiling/build-damage-engine.cjs). It
compiles one injected frontend translation unit and links existing objects;
there is no worker/dependency build and no production engine source change.
[structural-damage.h](../../scripts/profiling/structural-damage.h) contains the
experimental device; [the runner](../../scripts/profiling/structural-damage.cjs)
keeps private source copies in ignored output.

The device walks the display list before rasterization and hashes ordered drawing
operations into canonical 512-pixel cells. Paths include actual geometry, stroke
state, transforms, colors and opacity; text includes immutable font identity and
glyph positions. Clip/group/render-state events conservatively enter every cell.
Type 3 text also enters every cell because its programs can paint outside reported
glyph bounds. Old display lists stay alive during comparison, preventing resource
pointer reuse from impersonating an unchanged font/colorspace. Images, masks,
shadings and patterns currently force a full redraw. This uses SHA-256 identity
and assumptions about immutable resources; it is an experiment requiring wider
adversarial validation, not a proof for every possible MuPDF operation.

For cells whose fingerprint changes, clone the old retained raster, replay all
contributing content in those cells and then compare/encode normally. Unchanged
background content is repainted inside changed cells. Every candidate raster is
compared byte-for-byte to a complete sharp reference **after** timed analysis and
redraw. The patched client-side image is also compared against the ordinary
engine at identical source and grid. All **63 candidate exports** passed both
checks; 126 exports total across nine case/scenario pairs, seven repetitions
each, first discarded. Each source revision is unique to prevent exported-page
cache hits. Six measured samples per row; variants run sequentially, baseline
first, with warm resource caches. Small differences are not statistically robust.

The three real projects are copied from the preceding clipping study, with
source hashes and compatibility adaptations recorded in the JSON. A public
[dense TikZ fixture](../../scripts/profiling/damage-fixtures/dense.tex) adds direct
figure-color edits. Reflow alternates a long paragraph insertion with a small
unique edit; figure changes alternate all plot marks between blue and red.
These are stress cases, not a representative distribution of real editing.

Median milliseconds:

| Case / edit | Ordinary native export | Damage analysis | Changed-cell redraw + copy | Candidate component sum* |
| --- | ---: | ---: | ---: | ---: |
| Math paper / small | 2.40 | 0.26 | 1.63 | 2.36 |
| Math paper / reflow | 5.74 | 0.27 | 2.38 | 7.12 |
| Dense real slide / title | 593.73 | 78.08 | 10.40 | 88.93 |
| Dense real slide / reflow | 612.53 | 84.31 | 635.56 | 751.91 |
| Election paper / small | 2.30 | 0.39 | 1.57 | 2.41 |
| Election paper / reflow | 11.85 | 0.40 | 2.81 | 13.46 |
| Synthetic plot / small | 31.02 | 6.12 | 15.25 | 21.90 |
| Synthetic plot / reflow | 47.78 | 6.21 | 25.16 | 50.76 |
| Synthetic plot / figure color | 51.42 | 6.37 | 35.21 | 62.32 |

*Analysis + redraw/copy + pixel comparison + PNG encoding. It excludes the
mandatory verification render, compilation, metadata/cache bookkeeping and
transfer/browser work. It is not measured end-to-end latency. Small component
differences should not be interpreted as wins. Do not compare absolute timings
directly with the earlier report: MuPDF, compressor, rectangle sizes and lattice
rendering differ. This study compares its own matched baseline and candidate.

The dense slide contains approximately 49,922 operations. Its title edit changes
four of the 12 held cells, and avoiding unrelated graphics helps substantially.
But hashing the unchanged plot still costs about 78 ms. Reflow invalidates the
whole rectangle and adds analysis overhead. On inexpensive pages, analysis and
copying are already comparable with the original draw cost. A production design
should record/reuse stable drawing structure as lists/objects are constructed,
and be able to bypass damage analysis when it is unlikely to pay. That is a
next experiment, not a speedup already delivered by this prototype.

## Decisions and remaining work

- Keep the authoritative sharp-surface fix separate from damage optimization.
  Preserve the single in-flight frame and revision-coherent interactions.
- Do not enable this damage prototype unconditionally. Its benefit depends on
  unchanged expensive content; reflow and figure edits can lose. Additional
  correctness cases must cover masks, images, color changes, resources, paint
  reordering and unusual Type 3 programs before any production adoption.
- The lattice is a rasterization correctness primitive. It does not require
  retaining every cell as a separate browser/engine object. These measurements
  have not selected retained tiles versus overlap reuse in a scrolling surface.
- PNG versus raw transfer and moving-object raster caching remain unmeasured.
  They are separate experiments; neither solves compilation-dominated stalls.
- The current rectangle is redrawn when scrolling outside it. Measure strip/
  cell reuse before selecting a retention policy, including peak memory and
  long-session behavior. No claim of an optimal tile size follows from this run.

## Reproduction and cleanup

Use fresh output directories, run one local native/browser benchmark at a time,
and use an existing development engine build. Private input schema is the same
as `real-corpus.cjs`, with optional `figureChange: {from, to}`. No manuscripts or
image assets are included in the compact report. The public synthetic case uses
`scripts/profiling/damage-fixtures/dense.tex`, edit anchor `Editing this sentence.`,
and replaces `\fill[blue,opacity` with `\fill[red,opacity`.

```sh
node scripts/profiling/build-damage-engine.cjs
node scripts/profiling/structural-damage.cjs artifacts/damage-inputs.json \
  native/texpresso/build/texpresso native/.work/structural-damage/texpresso \
  artifacts/damage-new

TEXPRESSO_BINARY="$PWD/native/texpresso/build/texpresso" \
TEXPRESSO_PROFILE_SCENARIO=rapid-e2e TEXPRESSO_PROFILE_PAGES=3 \
TEXPRESSO_PROFILE_KINDS=packed,tikz,mixed TEXPRESSO_PROFILE_CODECS=png \
TEXPRESSO_PROFILE_REPEATS=1 TEXPRESSO_PROFILE_EXTRAS=1 \
node scripts/profiling/browser.cjs artifacts/browser-sharp-new
```

While the server runs, evaluate
[surface-browser-playwright.js](../../scripts/profiling/surface-browser-playwright.js)
as a function and pass a Playwright Page. It creates its own contexts, runs the
workloads and registers Chromium PIDs for sampling. For the matched legacy run,
restart the server with `TEXPRESSO_PROFILE_DISABLE_SURFACES=1`, a fresh output
directory, and pass `{scales:[2]}` to the browser function. macOS task accounting
is available only on macOS. The report can be regenerated with
`summarize-sharp-review.cjs DAMAGE_DIR SHARP_DIR LEGACY_DIR OUTPUT.json`.

The final experiment manifest records the scratch binary, worker and injected
source hashes. Private copied projects, superseded raw runs and scratch binaries
are disposable after this report. Keep original projects, reusable experimental
sources and the usable native engine. Native platform matrices ran on GitHub;
no local Docker or dependency downloads were used.
