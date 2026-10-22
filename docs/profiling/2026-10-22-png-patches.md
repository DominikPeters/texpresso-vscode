# Native PNG dirty rectangles — 22 October 2026

PNG updates now compare the new RGB raster with one retained raster before
compression. Small differences encode and transfer just their bounding rectangle;
unchanged pixels need zero image bytes. Broad changes and missing bases send a
full PNG. The full page is still rasterized, and compiler latency is unchanged.

The new optional `pngPatches` capability negotiates this path for PNG and Auto.
Older clients/engines retain ordinary PNG behavior. The extension accepts native
patches only against an acknowledged canvas with matching page geometry. The
webview decodes and validates the crop before changing the retained canvas. It
checks its source generation again before committing the draw, preventing an
asynchronous old decode from modifying a newer page. White pixels erase old ink.

A metadata-only frame retains the same canvas/content identity while refreshing
annotations, revision and source sequence. Missing or malformed patch bases
request a full frame. Canvas unavailability falls back to the image decoder.
Encoded caches never replay obsolete full PNGs over newer patch results. Patched
pages can be revisited through a bounded decoded-page metadata cache; eviction or
webview reload recovers through a native keyframe rather than replaying a chain.

## Local measurements

M1 Pro, native 1599×2261 full-page RGB raster, local TeX Live, existing
sparse/dense/packed/TikZ fixtures. Seven measured edits per mode after two warmups;
full mode precedes patch mode. Text alternates a four-letter marker; TikZ changes
a curve coordinate. Values are medians from one session per content/mode. Native
stage timings cover export work, not compilation, IPC or browser paint.

| Page/edit | Full PNG bytes | Patch bytes | Full encoding ms | Comparison + patch encoding ms |
| --- | ---: | ---: | ---: | ---: |
| sparse text | 75,796 | 318 | 7.91 | 0.49 |
| dense text | 217,930 | 318 | 10.82 | 0.44 |
| packed text | 321,427 | 318 | 12.82 | 0.48 |
| TikZ curve | 327,288 | 113,571 | 17.82 | 3.34 |

Drawing remained approximately 0.4/1.1/1.5/10.8 ms respectively. These are focused
local observations, not an end-to-end speed guarantee. Raw stage samples and RSS
snapshots are in `artifacts/profile-png-native-final/native-png.json` (ignored).

One retained raster adds about 10.3 MiB for this resolution, with a maximum of
11.45 MiB of RGB samples. Browser canvas storage stays within the existing
32 MiB/four-entry decoded cache estimate; a patch transfers ownership of the
active canvas between identities without copying its whole bitmap. Magnifier
fallback draws into a 240 CSS-pixel canvas capped at DPR 2, rather than cloning
the full page. Temporary raster/decode allocations and GPU storage are additional.
Native RSS snapshots varied with allocator/checkpoint state: about 48–56 MiB in
full mode and 38–65 MiB in patch mode; they do not isolate the retained-raster cost.

High-zoom viewport detail and magnifier regions continue to use bounded full PNG
crops. This pass optimizes full-page updates; it does not retain another native
comparison raster for each region.

## Validation and reproduction

The native test compares sparse, colored, padded-row, edge and erasure bounds.
A real-engine test chains typing, backspace, gray-to-color and rule-width edits,
then compares reconstructed RGB pixels against a fresh full PNG. It covers zero
bodies, region/base independence, resize/page/source changes and unknown bases.
Controller tests cover acknowledged bases, cache revisits, recovery, and image
fallback. Actual VS Code tests load both renderers and patch exact canvas pixels.

The recorded native chain was 12,362 → 0 → 1,579 → 1,554 → 414 → 110 image bytes.
The browser's production PNG renderer passed 14 checks, including exact RGBA
comparison to the full reference and transactional rejection of malformed crops.
The live production preview used 239 bytes for a dense-page letter insertion and
120 bytes for backspace in the manual DPR-2 check.

```sh
npm run compile-tests
TEXPRESSO_BINARY=/path/to/new/texpresso TEXPRESSO_TEST_PREVIEW=1 \
TEXPRESSO_PNG_FIXTURES="$PWD/artifacts/png-patch-check" \
node --test out/test/engine/png-patches.test.js
node scripts/profiling/png-patch-validation.cjs artifacts/png-patch-check
# Open http://127.0.0.1:9387/ and run the verification.

TEXPRESSO_BINARY=/path/to/new/texpresso \
node scripts/profiling/png-native.cjs artifacts/png-export-check
```

The browser profiler also accepts `TEXPRESSO_PROFILE_DISABLE_PNG_PATCH=1` for its
ordinary image baseline. PNG/Auto production previews negotiate patches without
a new user setting. No dependency downloads or native windows are needed.
