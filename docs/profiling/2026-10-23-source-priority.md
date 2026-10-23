# Source-follow page priority: focused matched comparison

The controller now keeps the validated source-follow render target separate from the viewport's center/toolbar page. When the edited paragraph is on adjacent visible page 1 but page 0 still dominates the viewport, a passive viewport report no longer repeatedly switches render priority back to page 0. Manual navigation, changed dimensions/codec/allocation, and an offscreen source target still retire the old intent.

This is a follow-up to the [latency investigation](2026-10-23-latency.md). The change reduces wrong-priority requests and preserves the source page's PNG patch chain. The matched test improves median and p95 latency, but does **not** improve the worst compiler-side delay in this single pair.

## Workload and provenance

The serial baseline/candidate runs use the unchanged `compare/controlled-prose` plan: 202 characters at 100 ms cadence, a naturally flowing approximately 30-page fixture, Fit Page, a 900 × 763 CSS-pixel viewport at DPR 2, PNG mode, and no manual navigation. Both runs finish cleanly; each passes its independent two-pass XeLaTeX/SyncTeX oracle (one source-page probe). Maximum input lateness is 6.47 ms before and 1.95 ms after.

| Component | Identity |
| --- | --- |
| Parent baseline | `57a5e1f144098f927d2f2641f873b6cf0cfafa84` |
| Baseline compiled controller SHA-256 | `e1a7dc4e764ed9f894f5927a4ef554a18d5df871929d87c1d8cdc363dd245e36` |
| Candidate compiled controller SHA-256 | `f5f566587ef1003fd0c18916c38c9e434a4e66b73ee0c3e252fee1dad4ebfacd` |
| Shared native source revision | `9cf7741adb9fae3229e9bf75e33b783060c5a443` |
| Shared native frontend SHA-256 | `d11de559337f1189f2961a8b98f8b72b06813f3eb528d92f96bd31dfd5f86355` |
| Shared native worker SHA-256 | `e5b9a4dfe22da77ad2f2d3d293637750b92687c40ce56e75cdf53fe3c94550a0` |

Both variants use the same native executable pair from the shared performance bundle, including its existing auxiliary-rerun fixes. The tracked candidate controller source is present during both runs, so `controllerRuntimeSha256` and `controllerVariant` identify the module that actually ran. The compiled candidate is restored afterward. Both the initial fixture and the final edited source are byte-identical across variants.

Artifacts: `artifacts/profile-priority-before/varied-30-png.json`, `artifacts/profile-priority-after/varied-30-png.json`, and the corresponding `artifacts/oracle-priority-before/` and `artifacts/oracle-priority-after/` results. [Compact measurements](2026-10-23-source-priority.json) retain hashes, source identity, endpoints and the worst inputs.

## Routing and render work

Counts stop at the last edit completion; they exclude the deliberate post-phase wait. Source affinity is attributed using the last observed native forward target for that source epoch, which may arrive after the render request. A neighboring visible page can still legitimately need updating, so other-page requests are not all described as wasted work.

| Measure | Before | After |
| --- | ---: | ---: |
| Full-page render requests, including background/cancelled work | 765 | 412 |
| Inputs whose first request targets their eventual source page | 3 | 197 |
| Inputs whose first request targets another page | 196 | 1 |
| First request/target unavailable for attribution | 3 | 4 |
| Completed native image frames | 415 | 388 |
| Completed native frames with no corresponding host image post | 19 | 0 |
| Native encoded image payload | 54.81 MB | 29.30 MB |
| Host image posts | 396 | 388 |
| Host image payload | 22.52 MB | 0.64 MB |
| Same source/revision/page/codec rendered at multiple widths | 0 | 0 |

The earlier width correction is present in both variants. This pair isolates the subsequent priority correction: it fixes which visible page is requested first and avoids unnecessary intent/raster-base resets.

### Why the host byte reduction is large

The native source-page PNG composition changes substantially:

| Page 1, containing the edited paragraph | Before | After |
| --- | ---: | ---: |
| Full keyframes | 188 | 4 |
| Patch frames, including no-ops | 27 | 192 |
| Zero-byte no-op patches | 5 | 31 |
| Patch payload | 3.4 KB | 28.6 KB |
| Total native payload | 29.19 MB | 0.65 MB |

The corrected priority keeps the source page's raster base useful across edits, so small changes remain small patches. This accounts for most of the payload reduction. The unchanged neighboring page 0 still costs 25.62 MB before and 28.65 MB after in native encoded payload. Host decoded-content reuse avoids forwarding that repeated content: page-0 host payload is zero before and 0.152 MB after, including one candidate keyframe. Page-1 host payload falls from 22.52 MB to 0.493 MB. Across both pages, host patch payload is 3.4 KB before and 28.6 KB after; the remaining transmitted bytes are keyframe payload.

For this fixture, the page-0 trace explicitly records 200 → 192 export-cache bypasses and zero export-cache hits in either variant. It also records 200 → 192 PNG drawing and encoding operations: accumulated `png-encode` elapsed time is 1,210 → 1,311 ms, producing the 25.62 → 28.65 MB above. Thus this particular neighbor really is repeatedly encoded and transported; these numbers do not imply that all unchanged pages miss the existing native export cache.

Any future reuse must validate the page's dependencies before skipping work or sending an unchanged-content reference while refreshing source/annotation metadata. The current cache deliberately bypasses virtual fonts and external or unclassified specials, among other unrepresented dependencies. The saved profile identifies a bypass but does not establish its precise guard reason, so this measurement does not justify removing a correctness safeguard. This opportunity is separate from the source-page priority correction measured here.

## Latency and visibility

Strict current commit timing means the host has received an ACK for the owning source page, geometrically visible in a visible browser document at commit, with the source sequence and compiler revision still current in the host at ACK receipt. It is an upper bound on commit latency, not compositor presentation.

| Strict current visible commit ACK | Before | After |
| --- | ---: | ---: |
| All-input count | 202 | 202 |
| Median, all inputs | 38.9 ms | 30.4 ms |
| p95, all inputs | 70.4 ms | 56.8 ms |
| Maximum, all inputs | 264.0 ms | 498.4 ms |
| Sampled-visible exposure count | 202 | 201 |
| Inputs crossing observed hidden exposure | 0 | 0 |
| Inputs with unknown exposure | 0 | 1 |
| Median, sampled-visible subset | 38.9 ms | 30.4 ms |
| p95, sampled-visible subset | 70.4 ms | 54.2 ms |
| Maximum, sampled-visible subset | 264.0 ms | 498.4 ms |

The sampled-visible rule requires a preceding visible sample, no hidden sample through ACK receipt, and no observation gap above 150 ms. One candidate input has unknown exposure under this conservative rule. All-input numbers are retained; no hidden interval is used to explain away the worse candidate maximum.

The stricter current-at-two-animation-frame-observation endpoint has median 52.3 → 44.5 ms and p95 82.5 → 63.8 ms. Its maxima are 578.4 → 653.6 ms. This endpoint can overshoot actual useful progress when a new input arrives between commit and the observer callback; an older-source image may already be visible but no longer satisfy exact-current sampling.

## What causes the remaining candidate maximum

Input sequence 158 arrives at 19,493.151 ms. The compiler rolls back at 19,496.567 ms, resuming near 17.106 million tokens. More edits arrive at 100 ms cadence. Sequences 158–162 repeatedly resume that checkpoint; native compiler wait/budget bursts continue, including a 55.615 ms wait burst. No native image header is produced in the interval until sequence 162, at 19,988.350 ms: 495.200 ms after the original input.

That page-1 frame exports in 3.416 ms, is posted at 19,988.418 ms, and receives its current ACK at 19,991.595 ms. Browser-local receive-to-commit is 1.8 ms. The browser heartbeat is visible with zero reported lag and no long-task entries. There is no worker handshake, convergence rerun or source-target page change during this interval; checkpoint forks in it range from approximately 0.25 to 5.1 ms.

The changed sequence-162 surface is observed at 20,007.100 ms, about 514 ms after sequence 158, while sequence 163 is already the latest source epoch. The exact-current observer consequently waits until sequence 164 at 20,146.783 ms, producing the 653.6 ms sample. That latter value overstates the wait for the first useful changed image, but the approximately 495 ms period without a native image is still a real compiler-side tail.

This single matched pair supports the routing/patch-chain fix and lower routine latency. It does not establish improved worst-case latency. Remaining compiler replay and scheduling costs need their own evidence and changes; another measurement was not added to search for a more favorable maximum.

## Reproduction

Compile and preserve each controller runtime separately. Run the two variants serially against the same native bundle, changing only the runtime module and the variant/output labels:

```sh
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY='/Users/dominik/GitHub/texstudio/native/.bundles/darwin-arm64-shared-performance/bin/texpresso' \
TEXPRESSO_PROFILE_SCENARIO=compare \
TEXPRESSO_PROFILE_PHASES=controlled-prose \
TEXPRESSO_PROFILE_PAGES=30 \
TEXPRESSO_PROFILE_CODECS=png \
TEXPRESSO_PROFILE_CONTROLLER_VARIANT=source-priority-fixed \
TEXPRESSO_PROFILE_OUTPUT="$PWD/artifacts/profile-priority-after" \
node scripts/test-integration.cjs --profile-varied
```

After measurement ends, use `scripts/profiling/latency-summary.cjs` or `varied-summary.cjs` for endpoint analysis, and run `varied-oracle.cjs` separately against a fresh output directory. Do not compile, run other native tests, or run the oracle concurrently with the interactive benchmark.
