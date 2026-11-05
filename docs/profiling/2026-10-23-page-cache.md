# Native unchanged-page caching, 23 October 2026

This pass adds two bounded native caches. Eligible unchanged pages can reuse a
MuPDF display list and an exported SVG or PNG raster. Compilation and SyncTeX
still run normally; these caches do not skip compiler work.

## Native end-to-end comparison

The benchmark uses the production `TexpressoSession`, a local TeX Live document
with ordinary paragraphs (`lipsum`) and TikZ paths, and a raster target width of
1600 pixels. It compares the preserved previous development bundle with the
integrated candidate. Each codec/session first renders pages 0 and 1, then records
eight warm requests for page 1 and eight returns to page 1 after rendering page 0.
Timing starts immediately before a request and ends after its complete binary
frame reaches the extension host. It excludes VS Code webview/browser paint.

Final relocated candidate measurements (including exact integer request handling and request-lifecycle fixes):

| Codec | Operation | Baseline median | Cache candidate median |
|---|---|---:|---:|
| PNG | Warm request | 28.95 ms | 0.75 ms |
| PNG | Return to page | 22.00 ms | 1.48 ms |
| SVG | Warm request | 2.07 ms | 1.26 ms |
| SVG | Return to page | 2.48 ms | 1.49 ms |

Every measured output matched the reference bytes exactly. Cross-binary PNG and
SVG SHA-256 values also matched. The baseline had no cache hits; the candidate
recorded 40 list/export hits per codec. At this scale the cached result approaches
the cost of protocol transfer and extension-host processing, so native lookup
microseconds alone would overstate the user-visible improvement.

Final artifacts are in `artifacts/page-cache-protocol2-final/`: `result.json`,
per-codec and per-binary JSON/profile logs, and the exact `main.tex`. The reusable
driver is committed as `scripts/profiling/page-cache.cjs`. Each run records frontend/worker, source and image hashes,
every sample, native stages and frontend RSS snapshots. All 64 measured outputs
matched their reference bytes. The candidate was built in
`native/.bundles/darwin-arm64-preview-reliability-final`, with compact static
ICU data, relocated dependencies, a matched C02/S02 worker handshake, and an
ad-hoc signature. The baseline bundle is preserved at
`native/.bundles/darwin-arm64-preview-before-reliability`. At the end of this pass, the canonical `demo:preview` bundle contained this same
frontend plus the extensionless-input worker fix in native commit `91f7d92`.
Subsequent [latency work](2026-10-23-latency.md) updates the canonical frontend
while preserving the exact cache benchmark pair. That fix was
validated by all 49 engine tests; it does not change the native rendering caches.
The exact pair measured here remains preserved in `reliability-final`.

Measured frontend SHA-256:
`8cc20d7e803a6e8c593b20131af6377d20a68f4b439f3381da25f44f8ad0ed94`.
Worker SHA-256:
`d2e586db56a6d2c4b467c4269f184a183f7d5a1a859a400d145e4085ab6e7dfe`.
The executable bytes were measured before the native source was committed. The
manifest now records native commit `41c6d0792209708e1938210eddbb52820ecec7e6`
and the verified matching source digest; the binaries are unchanged. To repeat the
comparison, compile the production session code and select the preserved baseline
and candidate explicitly:

```sh
npm run compile-tests
node scripts/profiling/page-cache.cjs \
  --baseline native/.bundles/darwin-arm64-preview-before-reliability/bin/texpresso \
  --candidate native/.bundles/darwin-arm64-preview-reliability-final/bin/texpresso \
  --output artifacts/page-cache-new-run
```

`--width`, `--repeats` and `--formats` are configurable; defaults reproduce this
1600-pixel, eight-repeat PNG/SVG matrix. The driver rejects existing nonempty
output directories, checks every measured frame's exact bytes, and persists
subprocess/validation errors instead of reporting a successful partial run.

## What is validated

`incdvi_display_list` compares exact DVI page-program bytes after BOP counters and
back pointers, actual page geometry, DVI scale/version, color-stack origins, and
resolved font objects/specifications. BOP counters and offsets are excluded
because they do not draw; a source comment or unrelated earlier content can move
those offsets without changing the page. The page must select its font before
using text, and a font cannot be redefined after its earlier mapping was used.

The font manager owns immutable loaded font and metric resources for its context
lifetime. Their actual resolved identities participate in the cache key. This is
validation against the interpreter's loaded resources, not a new disk-font change
watcher. Virtual fonts are excluded because their nested programs can introduce
additional dependencies. External PDF/image specials and unclassified specials
are also excluded. A supported deterministic path/color/annotation special can
be cached; currently ignored document/resource dictionary specials are explicitly
audited as no-ops. That audit must be revisited if the DVI interpreter gains new
resource-resolution behavior.

An unfinished PDF path can survive a frame in the existing interpreter. Pages
with a carried or surviving path are therefore not stored or reused. This avoids
assuming that the page program captures all cross-page graphics state.

Links and destinations are retained only with their exact validated DVI program
and font geometry. Changing a URI invalidates the list entry even if its visible
text is identical. Global destination discovery is still updated from the current
DVI stream. SyncTeX mappings are never cached here: a source-only edit must still
return its new source line through both synchronization directions.

The export cache uses a monotonically generated content token for a currently
validated list, plus bounds, requested width/codec/Auto limit and color-theme
configuration. It stores no display-list references, so it cannot extend the
list cache's lifetime behind its accounting. Unknown/evicted lists have token 0
and bypass export caching. Region requests also bypass it. Request IDs, revision,
source sequence and annotations are serialized freshly on every response.

Cached PNG pixels still pass through the existing dirty-rectangle comparison.
Chained patches, erased pixels, zero-byte no-op updates, invalid bases and full
keyframe recovery retain their original semantics.

## Retention and measurement limits

The display-list cache has at most eight entries, admits page programs of at most
128 KiB, and uses a 32 MiB accounting budget. Its charge is 128 bytes per program
byte plus 4 KiB and the exact retained key/annotation bytes. This is conservative
operation accounting, not a measured MuPDF allocation count or an RSS guarantee:
MuPDF exposes no public display-list allocation-size API. Entry/program bounds
remain explicit even if actual allocation costs differ.

The export cache has at most four entries and a 32 MiB budget for its encoded
buffers, retained raster strides/heights and entry records. Native four-megapixel
render and 16 MiB transfer limits still apply. In the final benchmark the list
cache charged 3.55 MB; export retention reached 20.23 MB for PNG and 0.31 MB for
SVG. These are retained-cache charges, not total process RSS. Compiler checkpoints,
MuPDF's resource store, the active display list, and the existing PNG patch base
are outside these cache budgets.

Frontend `ps` RSS snapshots after warmup and each return peaked at 27.34 MB
baseline versus 29.25 MB candidate for PNG, and 17.50 MB versus 15.94 MB for SVG.
PNG caching retains raster memory to avoid redraw/encoding. macOS reclaimed
resident pages during these runs, and earlier repetitions showed substantially
different RSS totals with the same retained cache charges. These snapshots do not
isolate cache allocation cost or establish a steady-state bound. Samples exclude
worker processes, compiler-checkpoint children and browser/GPU memory; explicit
retained-byte accounting is the reproducible cache-size measure.

## Verification

`src/test/engine/page-cache.test.ts` checks byte-identical return-to-page reuse,
PNG redraw skipping/no-op patches, source-only edits with fresh SyncTeX locations,
URI/font/geometry changes, distant-page eviction, external-resource bypass and
unfinished cross-page paths. Cache profile stages expose hits, misses, bypasses
and retained charged bytes. Existing PNG patch and SVG/link suites should also
run against the final integrated candidate. The three cache regressions and the
standalone exact-integer protocol test passed. Native SVG, PNG, annotation, stroke
and SyncTeX C suites also passed after rebuilding consumers of the numeric ABI.
Full native and VS Code acceptance results are recorded in the
[reliability report](2026-10-23-reliability.md).

Opt in with `TEXPRESSO_TEST_PREVIEW=1` and `TEXPRESSO_BINARY` pointing at a fresh
candidate. Run native tests serially and headlessly; no Tectonic downloads or
native preview windows are needed.
