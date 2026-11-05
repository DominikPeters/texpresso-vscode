# Retex versus XeTeX: compiler feasibility benchmark

Retex's native macro optimizations are promising for a TeXpresso worker, particularly on expensive TikZ pages. With retex's own checkpoints disabled, the heavy drawing fixture's body/shipout time is **857 ms versus XeTeX XDV's 2,607 ms (3.04× faster)**. Dense prose and the varied fixture improve modestly; the math fixture is slower through this retex PDF path. This supports a targeted worker prototype, not a general claim that every edit becomes three times faster.

## Setup and scope

- Apple M1 Pro, eight CPU cores, 16 GiB RAM, macOS 15.7.9. All accepted repeated trials were collected on battery, low-power mode off. Hardware/power output is retained in the compact evidence.
- Retex `bc5c55b` / `1.6.0-beta.5`, local Apple Silicon release build, rustup Rust 1.92.0. XeTeX `0.999998`, TeX Live 2026; local LuaLaTeX supplies the correctness oracle. Exact binary and fixture SHA-256 hashes are recorded in [the evidence](2026-10-29-retex-xetex.json).
- Identical UTF-8 sources and explicit Latin Modern OpenType font files across engines, including the existing page-fill fixtures and sustained-edit varied fixture with an included file. The nominal 30-page varied fixture actually produces **31 pages**, with all three engines.
- `RETEX_NO_SNAPSHOT=1`, `--passes=1`, no watch mode, one fresh process per sample; native macro shortcuts and figure caching remain enabled. XeTeX also starts from scratch. This measures the proposed faster computation core, without adopting retex's checkpoint manager.
- Five accepted samples per fixture/engine/phase, rotating engine order, serial execution. Three preflight passes settle auxiliary files and warm caches; LuaLaTeX is not running alongside timed trials. Two initial warm rounds overlapped an auxiliary text-diff check: all 42 observations were excluded and replaced. Preflight and warm-up timings are excluded from the medians.
- The power transition happened before the accepted trials. The empty-application-cache observation belongs to preflight and is reported separately; no cold OS-cache claim is made. TeXstudio's build/test jobs had finished; its normal interactive preview and ordinary desktop applications remained available. These are workstation measurements, not an isolated laboratory run. Per-group minima/maxima and CPU times are preserved; five observations do not establish tail latency.

## Whole-pass time

Median wall time in milliseconds. **XeTeX XDV is the relevant baseline for TeXpresso**, which does not need XeTeX to finish a PDF through `xdvipdfmx`. Retex still writes a PDF in this comparison. The PDF-to-PDF comparison is included to expose conversion overhead rather than count it as compiler-core improvement.

| Fixture | Actual pages | Retex PDF | XeTeX XDV | XeTeX PDF | XDV / retex |
|---|---:|---:|---:|---:|---:|
| Sparse text | 1 | 259.0 | 365.4 | 689.6 | 1.41× |
| Dense text | 10 | 275.9 | 391.7 | 721.4 | 1.42× |
| Dense text | 50 | 364.2 | 487.2 | 810.3 | 1.34× |
| Math and theorems | 10 | 312.3 | 409.7 | 748.6 | 1.31× |
| Heavy TikZ | 10 | 1203.0 | 3083.5 | 3461.0 | 2.56× |
| Varied flowing document | 31 | 752.4 | 909.7 | 1236.3 | 1.21× |
| Heavy TikZ, horizontal-mode entry | 10 | 1195.9 | 3071.6 | 3437.9 | 2.57× |

The sparse fixture shows a substantial fixed startup/preamble advantage (259 versus 365 ms to XDV). Much of that work is already retained in TeXpresso's checkpoints, so the whole-process ratio alone would overstate the expected editing benefit. One varied-fixture retex sample reached 1,119 ms while its median was 752 ms; this pass does not explain every desktop scheduling spike.

With an empty retex application cache, the one-page preflight took **2.92 s**, including automatic format/cache creation. This is a one-off setup observation with warm OS files, not comparable to the repeated warm trials or a measured XeTeX format build.

## Body and shipout

Two portable `\sys_timer:` markers bracket the body, from just after `\begin{document}` through a final `\clearpage`, before `\end{document}`. Resolution is 1/65,536 s. This excludes format/preamble startup and final teardown while including line/page breaking, figure execution, page shipout and output backpressure. It is closer to checkpoint replay work, but not an isolated interpreter or integrated live-preview measurement.

| Fixture | Retex PDF body, ms | XeTeX XDV body, ms | XeTeX / retex |
|---|---:|---:|---:|
| Dense text (10 pages) | 21.7 | 24.9 | 1.14× |
| Dense text (50 pages) | 106.5 | 121.4 | 1.14× |
| Math and theorems (10 pages) | 35.6 | 22.9 | 0.64× |
| Heavy TikZ (10 pages) | 856.9 | 2606.8 | 3.04× |
| Varied flowing document (31 pages) | 279.2 | 328.4 | 1.18× |
| Heavy TikZ, horizontal-mode entry (10 pages) | 853.2 | 2584.6 | 3.03× |

The evidence is strongest for costly diagrams: the TikZ source draws 625 circles and 625 segments on three pages, with prose on intervening pages. The plain-text gain is around 14%; the mixed document around 18%. The 10-page math body is about 55% slower in the retex PDF path. Retex and XeTeX use different output backends here, so that is not proof that the math layout routine alone is slower.

Retex `-draftmode` did not meaningfully remove this cost (math body 36.5 ms, versus 35.6 ms normally). Inspection of `LazyPdf::get` explains why: it writes a scratch `.pdf.draft` and removes it later. Those diagnostic samples are retained but **not treated as a PDF-backend-free comparison**.

## Which retex optimization helps?

Median body/shipout milliseconds, five runs per variant. The last column disables both figure caching and native macro shortcuts, leaving ordinary macro execution.

| Fixture | Default | Figure cache off | Native shortcuts and figure cache off |
|---|---:|---:|---:|
| Heavy TikZ | 856.9 | 854.1 | 2381.1 |
| Varied flowing document | 279.2 | 277.0 | 317.4 |
| Heavy TikZ, horizontal-mode entry | 853.2 | 866.8 | 2393.8 |

Disabling native shortcuts takes the heavy drawing body from about **854 ms to 2,381 ms** with caching disabled in both cases. Most of that advantage is therefore from accelerated macro execution, consistent with using retex under TeXpresso's existing checkpoint manager. Without those shortcuts, its heavy drawing body is only modestly faster than XeTeX's 2,607 ms.

There were **zero figure replay hits** in the accepted fresh-process warm samples, including the separate horizontal-mode-entry fixture intended to make pictures eligible. The counters describe pictures as cacheable, but they were executed each time. The drawing gain cannot be credited to cached pictures. Why cross-process reuse misses is an open question; the cache should not be assumed effective in this workload without further investigation. The fixture without timers in preliminary runs also showed no hits, so body timing is not the sole explanation.

## Changed sources

Each sample compiles the complete edited source in a fresh process. The varied fixture receives a sentence at an early, middle or late anchor; each coordinate-edit repetition uses a novel first-figure control point rather than warming the edited drawing's exact cache key.

| Change | Retex PDF, ms | XeTeX XDV, ms | XeTeX PDF, ms |
|---|---:|---:|---:|
| early | 719.2 | 936.8 | 1286.4 |
| middle | 721.6 | 945.6 | 1263.4 |
| late | 719.5 | 910.6 | 1262.9 |
| coordinate | 1245.6 | 3162.5 | 3528.7 |

The position of a text edit provides little advantage because neither engine uses checkpoints. These numbers must not be read as keystroke-to-visible-page latency. They show the full-pass economics of the changed source, which a later worker prototype would reduce through TeXpresso-owned rollback/prewarming.

## Correctness and memory

All seven measured baseline PDFs match fresh LuaLaTeX in total page count and whitespace-normalized extracted text. The first, middle and last pages (one page for the one-page fixture) are pixel-identical at 150 dpi grayscale. The same checks pass for the final representative early/middle/late sentence edits and coordinate edit; source hashes agree across timed engines, new sentences are present, the changed drawing's first-page raster differs, and there are no unresolved `??` references. This is a sampled raster check, not an all-page pixel-identity assertion.

XeTeX has the same page counts. Its paper-width serialization differs by about 0.004 pt; math extraction also differs in variation selectors and the order in which positioned equation fragments are returned. Retex/LuaLaTeX agreement is the correctness oracle; no pixel-equivalence claim is made between LuaTeX-compatible output and XeTeX output.

Median kernel maximum RSS is roughly **76–100 MiB for retex**, versus **182–189 MiB for XeTeX XDV**. CPU accounting generally follows the wall-time result, including the drawing gain; this is not just an observed wait reduction. `wait4` supplies process/descendant CPU and OS peak RSS. These values are not summed simultaneous process-group peaks, deduplicated physical RAM with checkpoints, browser memory, or an energy measurement. Reintroducing TeXpresso checkpoints will change memory costs.

## Next useful experiment

Implement a minimal retex worker driven by TeXpresso's checkpoint and source-read protocol, prioritizing the existing heavy TikZ and mixed-document probes. First establish faithful unsaved-source consumption fences, page export and SyncTeX; then compare identical edits from matched checkpoints through visible paint. The current evidence justifies that experiment, especially for expensive figure pages. It does not establish better latency tails, cancellation behavior, preview rendering speed, or universal math/prose improvement.

## Reproduction

The [harness](../../scripts/profiling/retex-xetex.py) uses installed TeX Live and Poppler only. The existing fixture generators require `npm run compile-tests`. Build retex first using the working rustup compiler and cached Cargo crates; no package downloads, SDL/VS Code windows or Tectonic are involved in these trials.

```sh
python3 scripts/profiling/retex-xetex.py prepare --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py preflight --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py verify --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py measure --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py ablate --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py draft --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py verify --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py verifyedits --output artifacts/retex-comparison --repeats 5
python3 scripts/profiling/retex-xetex.py summarize --output artifacts/retex-comparison --repeats 5
```

Use `--retex /absolute/path/to/retex` if needed. Do not run builds or other benchmarks concurrently. The `repair` action is specific to this recorded run's two contaminated rounds; it is not part of normal reproduction. Original logs, individual observations, source snapshots, PDF/SyncTeX outputs and validation hashes are retained under `artifacts/profile-retex-xetex-20261029-v3`. The committed compact evidence contains accepted and excluded repeated observations, ranges, binary/source hashes, power context, and validation results. Harness additions after preparation expose the edited-output checks and incident exclusions; both preparation and final harness hashes are recorded. No engine source or extension runtime changed.
