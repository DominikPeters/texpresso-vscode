# Display-density clipping and damage: 16 November 2026

Clipping is sufficient to make native raster export inexpensive on the two
ordinary pages tested, but not on the dense vector slide. A title-only edit on
that slide changes very few sharp pixels. Rendering just that known region is
fast. This makes conservative damage detection **before rasterization** a
particularly promising experiment; these measurements do not implement it.

Numeric results, source hashes, binary manifest, sample ranges and validation
results are in [the source-free data](2026-11-16-clipped-raster.json). The reusable
runner is [clipped-raster.cjs](../../scripts/profiling/clipped-raster.cjs).
No production preview behavior was changed.

## Method and limits

- Local macOS arm64, Apple M1 Pro, one native job at a time; no native build or Docker.
- Three copied real projects: math paper, dense vector election slide, and an
  election paper with a figure. Original documents were not edited or uploaded.
- 1000 × 700 CSS-pixel viewport, DPR 2; at most 2000 × 1400 physical pixels
  before current region rounding. No overscan. Portrait pages have additional
  content outside this viewport; the landscape fit view fits the whole page.
- Fit physical page width 2000; zoom widths 3404, 4000 and 3256 respectively.
  These correspond to about 1.7×, 2× and 1.6× fit. Full reference images stay
  below 16 MP, using the existing native opt-in. Production client validators
  still reject images above 4 MP. This raw client deliberately bypasses them.
- Six requests per case, first discarded as warmup, then median of five.
  Alternate request order each repetition. Static exports must be byte-identical
  across repetitions. Every timed request uses `preview-region`, including full
  page references, to bypass the exported-page cache. Every sample must include
  a native `png-draw` stage; retained display lists and resource caches are warm.
- Viewport includes the actual edit. SyncTeX checks its page; landscape view
  starts at the top because frame-level SyncTeX does not locate the title exactly.
  Sharp before/after comparisons assert nonzero visible damage.
- An edit inserts two characters in prose/title. This is three small edits,
  **not** a representative distribution of reflow, graphics or font changes.
- Timings below are native export time: drawing, color processing, comparison
  and PNG encoding. They exclude compilation, display-list construction, browser
  decoding, compositing and presentation. Round-trip samples are also recorded,
  but are not keystroke-to-display latency. Memory was not instrumented.
- Engine `8c8553ff574acb1905d6b17208ea026f40738b6f`, MuPDF
  `8ad45e92f0935d3d87f1db3f873086472a5e1b24`; binary and worker SHA256 and
  build configuration are in the JSON. This is the existing instrumented engine
  used for earlier codec studies, not a rebuilt release candidate.
- The legacy engine emits one malformed annotation header on the slide. The
  measurement-only quote-aware number adapter fixes that header; PNG bytes are
  untouched. This does not test production parsing or compatibility.
- Math-paper copy uses recorded XeTeX compatibility adaptations (T1 fonts and
  removal of pdfTeX output selection). Other copies need no adaptations.

## Zoom results

Median milliseconds; each sharp viewport is about 2.8 MP.

| Input | Whole sharp page | Sharp viewport | Viewport drawing | Viewport PNG encoding |
| --- | ---: | ---: | ---: | ---: |
| Math paper | 29.46 | 5.91 | 0.73 | 5.16 |
| Dense vector slide | 986.98 | 461.45 | 452.69 | 8.73 |
| Election paper / figure | 31.19 | 6.01 | 1.46 | 4.53 |

The dense slide contains many translucent vector marks. Clipping avoids some
drawing but still leaves an expensive visible plot. Faster encoding alone
cannot remove its approximately 453 ms drawing cost. Conversely, PNG encoding
dominates these ordinary-page viewport exports, so transport/codec work may
matter there. Raw transport was **not measured**, and saving encoding time is
not the same as reducing end-to-end latency: raw bytes still require transport,
copies and browser presentation.

### Approximate current base-image baseline

The runner also measured `old-base` in every repetition. Those samples were
included in the JSON but omitted from the original report's table. At zoom:

| Input | Approximately 4 MP whole-page base | Sharp viewport |
| --- | ---: | ---: |
| Math paper | 9.83 ms | 5.91 ms |
| Dense vector slide | 577.87 ms | 461.45 ms |
| Election paper / figure | 11.26 ms | 6.01 ms |

These are matched native uncached exports using the width corresponding to a
4 MP page budget, not the complete shipping pipeline. The math image rounds to
4,001,208 pixels under the experimental 16 MP allowance; the other two are just
under 4 MP. Production may choose different sizes when sharing the budget among
pages, and its export/patch caches, overscan, detail request and browser costs
are not modeled here. Thus clipping did not increase native export cost in
these three zoom cases; this does not establish user-visible latency improvement
or a worst-case bound for other documents.

## Sharp pixel damage and a post-hoc oracle

After inserting the characters, compare complete before/after sharp RGB rasters.
Then align the **known** changed bounding box outward to a page-anchored grid and
render that rectangle from the edited display list. This is one bounding region,
not separate tile requests. It is an oracle experiment: computing this damage
currently already required both full renders. The results are potential
region-export costs, **not achieved incremental-update costs or speedups**.

| Input | Changed sharp pixels / whole page | Changed 256-pixel cells | Oracle region export: 256 grid | 512 grid | 1024 grid |
| --- | ---: | ---: | ---: | ---: | ---: |
| Math paper | 33,270 / 14,998,024 | 9 / 252 | 1.34 ms | 2.76 ms | 6.31 ms |
| Dense vector slide | 2,157 / 9,004,000 | 1 / 144 | 1.18 ms | 1.66 ms | 63.21 ms |
| Election paper / figure | 9,058 / 14,993,880 | 3 / 234 | 0.37 ms | 1.21 ms | 4.37 ms |

The slide's 1024-grid region overlaps the expensive plot; its smaller regions
do not. This illustrates why avoiding unrelated graphics can matter much more
than transferring fewer bytes. It does not establish an optimal tile size.
Fine cells also require more bookkeeping and potentially more replay/transfer
work on other edits. The JSON includes other viewport positions, small regions
and scroll strips; region location changes their cost dramatically.

## Pixel-grid correctness

Repeated identical requests were byte-stable. However, clipped and full-page
rasters were not always pixel-identical at their corresponding coordinates:
the zoom slide differed at 202 of 2.8 million pixels, maximum channel delta 12;
the election page differed at 27 pixels, maximum delta 6. Some requested
1400-pixel-high clips became 1401 pixels high. This is consistent with the
current floating-point bounds/independently derived scale, but its exact cause
has not been isolated.

The raw benchmark bypasses `preview-viewport.js`, so its per-region `floor`
cannot by itself explain the observed differences. The native region renderer
also derives its transform separately from region bounds and raster dimensions.
Both client and engine geometry need examination; the mismatch is not yet
attributed to one rounding operation.

A new retained-surface protocol should specify a shared page transform and
integer device-space origins/bounds. Exact pixel-equivalence tests across
adjacent/overlapping regions are required before calling tiles interchangeable
with a whole-page raster. Do not derive high-resolution validity from low-
resolution pixel differences.

## Design implications

1. Keep the fixed-zoom typing contract: sharp pixels remain sharp, and pixels,
   links, SyncTeX and highlights describe the same displayed revision. Coalesce
   obsolete work while retaining the prior complete sharp frame. Measure visible
   revision age; holding it does not solve slow rendering by itself.
2. Size the working set from visible physical pixels, with bounded overscan and
   explicit memory accounting. A 1400 × 1000 CSS viewport at DPR 2 needs 5.6 MP:
   about 22.4 MB per RGBA copy, or 44.8 MB for two copies, before native retained
   pixels, transport, decoded images and GPU allocations. Splitting does not
   reduce that requirement. Use backpressure and bounded in-flight revisions.
3. Investigate conservative drawing damage. Compare structured drawing content
   and bounds while respecting paint order, old and new bounds, clipping,
   stroke extents, font/image identity, transparency groups and masks. Replay all
   contributing operations inside damaged regions, not just changed operations.
   Fall back to broader/full damage when equivalence cannot be established.
   Differential full-reference rendering must catch false-negative damage.
4. Compare retained tiles with a rolling clipped surface that reuses overlap and
   renders newly exposed strips. Neither representation inherently wins on user
   resource cost. A single bounding union can waste work between sparse damage;
   sparse tile playback can add display-list walks. One replay into several tile
   targets is not automatically free and needs measurement. Implementation effort
   is not a reason to select the slower or less correct approach.
5. Benchmark scrolling, zoom transitions, paragraph reflow, figure edits and
   multi-page visible updates, including p95 presentation latency, revision age,
   CPU and peak native/browser memory. Compare codecs for actual damaged regions
   through the real host/webview pipeline, rather than inferring from compression
   times alone. These experiments do not establish an Auto policy.

Follow-up requirements after review:

- Keep blur removal independent of damage optimization. A roughly 6 ms native
  viewport export makes the ordinary cases plausible without damage detection;
  actual sharp-to-sharp presentation latency still needs measurement.
- Add paragraph reflow, edits beside/inside figures, figure movement without
  content changes and sustained typing. Report measured damage-analysis cost
  separately from raster export and full keystroke-to-presentation latency.
- Treat a maximum displayed-revision age as an objective to measure, not a hard
  guarantee: an individual render can already exceed it. Use bounded in-flight
  work, avoid cancellation starvation and show rendering activity while keeping
  a coherent sharp frame. Coalescing alone cannot guarantee fast output.
- Object raster caching is a separate hypothesis. Repositioning is exact only
  under compatible scale, device-pixel phase, clipping, color configuration and
  compositing/backdrop conditions. Content identity alone is insufficient, even
  for an integer translation of a non-isolated transparency group. Measure how
  often expensive objects move unchanged before selecting this optimization.

## Reproduction and cleanup

Local private configuration is `artifacts/clipped-raster/inputs.json`, in the
same schema as `real-corpus.cjs`: project, entry, zero-based focusPage, editAfter,
optional startAfter and compatibility flags. Source hashes in the JSON identify
the exact prepared inputs without publishing manuscript text. Public reproduction
on identical sources requires access to those documents; other local inputs can
use the same runner. Use a **fresh** output directory:

```sh
node scripts/profiling/clipped-raster.cjs artifacts/clipped-raster/inputs.json \
  /Users/dominik/GitHub/texstudio/native/.bundles/darwin-arm64/bin/texpresso \
  artifacts/clipped-raster/new-run
node --test scripts/profiling/test-clipped-raster.cjs
```

All three analysis-helper tests pass (native RGB/grayscale decoding, damage/tile
boundaries and full-page/crop coordinate comparison). Copied documents, sample
images and redundant raw runs are disposable after this compact report; original
projects and canonical native bundles remain untouched.
