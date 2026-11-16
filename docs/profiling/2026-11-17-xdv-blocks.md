# XDV imported-PDF block experiment

Native stage timings only; not end-to-end or presentation latency.

Machine: Apple M1 Pro, darwin/arm64.

336 full-reference comparisons and 336 baseline pixel comparisons passed, including warmups. 384 measured samples remain after warmup exclusion.

Times below are median / p95 in milliseconds. p95 uses nearest rank; with six measured edits it is the maximum. Native export is an estimate from stage sums, excluding verification renders and compiler/display-list work.

## Findings and next direction

On the real slide title edit, flat analysis took 78.265 ms; cached PDF leaves took 1.663 ms. Estimated native export fell from 607.760 ms with the unchanged engine to 13.753 ms.

Page display-list construction still took 86.145 ms separately. The export result therefore is not a claim of a 13.753 ms typing-to-screen latency. Reflow that moves the expensive figure still pays its rasterization cost.

The promising direction is reuse of explicitly identified immutable drawing blocks. General byte or PUSH/POP matching should remain a diagnostic: it does not establish state/resource equivalence, and large reflow diffs can themselves be costly. Cheap pages and direct TikZ do not justify enabling this imported-PDF cache universally.

The next experiment should test reusing imported-PDF interpretation/display-list output, which targets the remaining construction cost, with bounded memory and the same full-reference checks. Further raster reuse for moved figures needs separate compositing and subpixel-correctness work.

The cache passed replacement, fractional placement/scaling, repeated imports, nested optional-content layers and unsupported-image fallback in the generated fixtures. Registry tests cover invalidation, aborts, forged tags and eviction. Real same-path file reloads, malformed PDF exceptions, varied themes and arbitrary transparency/clip combinations still need integration coverage before production adoption.

XDV summaries compare snapshot 0 (original) with snapshot 1 (first edit). Snapshot 2 returns to a short edit in alternating reflow tests and must not be used to measure reflow. A regression test covers this selection.

| Fixture | Edit | Variant | Analysis | Render | PNG encode | PNG compare | Compiler burst | DVI list | Native export estimate |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| math-paper | small | baseline | — | 1.067 / 1.769 | 0.058 / 0.073 | 0.356 / 0.780 | 1.393 / 1.595 | 0.294 / 0.308 | 1.548 / 2.663 |
| math-paper | small | flat | 0.255 / 0.296 | 1.586 / 2.598 | 0.102 / 0.136 | 0.356 / 0.382 | 0.754 / 1.033 | 0.281 / 0.290 | 2.354 / 3.379 |
| math-paper | small | uncached | 0.270 / 0.363 | 1.909 / 2.355 | 0.082 / 0.296 | 0.421 / 0.551 | 2.041 / 3.740 | 0.392 / 0.617 | 2.787 / 3.430 |
| math-paper | small | cached | 0.310 / 0.402 | 2.154 / 13.887 | 0.069 / 0.325 | 0.443 / 0.599 | 1.867 / 2.167 | 0.349 / 0.591 | 2.985 / 15.067 |
| math-paper | reflow | baseline | — | 1.127 / 1.810 | 3.825 / 3.967 | 0.554 / 0.995 | 1.421 / 1.684 | 0.288 / 0.327 | 5.625 / 6.595 |
| math-paper | reflow | flat | 0.258 / 0.270 | 2.129 / 5.457 | 3.740 / 3.984 | 0.590 / 0.638 | 1.427 / 1.613 | 0.290 / 0.295 | 6.855 / 10.206 |
| math-paper | reflow | uncached | 0.268 / 0.280 | 2.244 / 4.392 | 3.901 / 4.532 | 0.529 / 0.609 | 1.586 / 1.654 | 0.286 / 0.564 | 6.975 / 9.847 |
| math-paper | reflow | cached | 0.273 / 0.291 | 2.239 / 3.248 | 3.783 / 4.171 | 0.558 / 0.573 | 1.556 / 1.864 | 0.289 / 0.828 | 6.894 / 8.312 |
| graphic-slides | small | baseline | — | 605.804 / 626.671 | 0.120 / 0.213 | 0.378 / 0.390 | 0.052 / 0.089 | 88.189 / 91.000 | 607.760 / 628.589 |
| graphic-slides | small | flat | 78.265 / 131.142 | 10.489 / 24.220 | 0.114 / 0.139 | 0.417 / 1.368 | 0.030 / 4.868 | 87.946 / 100.360 | 90.674 / 159.978 |
| graphic-slides | small | uncached | 77.392 / 78.378 | 10.268 / 10.624 | 0.115 / 0.223 | 0.395 / 0.429 | 0.034 / 4.436 | 87.816 / 95.402 | 89.788 / 90.678 |
| graphic-slides | small | cached | 1.663 / 1.997 | 10.159 / 10.198 | 0.138 / 0.208 | 0.377 / 0.407 | 0.034 / 0.044 | 86.145 / 87.748 | 13.753 / 14.070 |
| graphic-slides | reflow | baseline | — | 572.590 / 593.793 | 20.352 / 21.890 | 0.948 / 1.250 | 0.537 / 1.148 | 87.487 / 102.336 | 595.958 / 616.818 |
| graphic-slides | reflow | flat | 77.347 / 80.858 | 570.070 / 580.995 | 20.181 / 21.365 | 0.974 / 1.042 | 0.955 / 4.961 | 86.767 / 88.710 | 672.592 / 681.170 |
| graphic-slides | reflow | uncached | 80.635 / 159.111 | 609.566 / 822.130 | 20.564 / 21.482 | 0.974 / 1.655 | 0.596 / 1.541 | 94.751 / 442.994 | 713.607 / 923.352 |
| graphic-slides | reflow | cached | 1.867 / 2.183 | 589.813 / 652.380 | 20.454 / 23.522 | 0.960 / 1.785 | 0.559 / 1.760 | 88.864 / 220.312 | 616.534 / 676.648 |
| election-figure | small | baseline | — | 1.773 / 2.615 | 0.096 / 0.143 | 0.504 / 1.032 | 1.626 / 1.924 | 0.463 / 0.514 | 2.605 / 3.830 |
| election-figure | small | flat | 0.402 / 0.404 | 1.469 / 1.552 | 0.049 / 0.128 | 0.394 / 0.465 | 1.606 / 2.204 | 0.462 / 0.477 | 2.374 / 2.416 |
| election-figure | small | uncached | 0.395 / 0.569 | 1.520 / 1.906 | 0.059 / 0.090 | 0.363 / 0.392 | 1.470 / 1.901 | 0.495 / 0.724 | 2.425 / 2.944 |
| election-figure | small | cached | 0.394 / 0.462 | 1.625 / 1.698 | 0.057 / 0.097 | 0.359 / 0.370 | 1.571 / 2.202 | 0.472 / 0.740 | 2.486 / 2.595 |
| election-figure | reflow | baseline | — | 2.208 / 3.781 | 8.624 / 9.559 | 1.195 / 3.553 | 1.573 / 1.712 | 0.441 / 0.642 | 12.102 / 15.285 |
| election-figure | reflow | flat | 0.377 / 0.395 | 2.864 / 3.337 | 8.639 / 9.888 | 0.750 / 0.804 | 1.696 / 1.884 | 0.437 / 0.515 | 12.915 / 14.226 |
| election-figure | reflow | uncached | 0.397 / 0.415 | 2.971 / 3.459 | 9.068 / 10.261 | 0.744 / 1.030 | 1.685 / 1.811 | 0.425 / 0.706 | 13.252 / 15.246 |
| election-figure | reflow | cached | 0.416 / 0.463 | 3.437 / 9.230 | 9.986 / 10.700 | 0.786 / 1.048 | 1.675 / 2.107 | 0.460 / 1.640 | 14.577 / 21.491 |
| synthetic-plot | small | baseline | — | 31.721 / 35.881 | 0.077 / 0.099 | 0.575 / 9.765 | 10.623 / 12.531 | 32.171 / 33.536 | 32.523 / 42.351 |
| synthetic-plot | small | flat | 6.277 / 6.457 | 14.577 / 17.364 | 0.080 / 0.099 | 0.370 / 0.446 | 10.100 / 12.843 | 32.587 / 35.026 | 21.442 / 24.421 |
| synthetic-plot | small | uncached | 6.355 / 6.497 | 14.239 / 15.646 | 0.065 / 0.078 | 0.380 / 0.482 | 10.532 / 12.095 | 33.178 / 34.444 | 21.241 / 22.760 |
| synthetic-plot | small | cached | 6.246 / 6.373 | 14.141 / 15.612 | 0.064 / 0.107 | 0.377 / 0.416 | 11.738 / 12.637 | 32.558 / 34.295 | 20.972 / 22.572 |
| synthetic-plot | reflow | baseline | — | 23.255 / 32.538 | 19.590 / 21.611 | 1.006 / 1.493 | 11.557 / 12.750 | 32.404 / 33.083 | 44.395 / 54.400 |
| synthetic-plot | reflow | flat | 6.220 / 6.262 | 25.520 / 32.223 | 20.003 / 20.422 | 0.656 / 0.739 | 10.930 / 13.240 | 33.815 / 35.431 | 52.622 / 59.751 |
| synthetic-plot | reflow | uncached | 6.205 / 6.285 | 24.873 / 32.748 | 19.703 / 22.054 | 0.695 / 0.725 | 10.419 / 12.150 | 33.421 / 35.994 | 51.590 / 61.832 |
| synthetic-plot | reflow | cached | 6.207 / 6.284 | 25.259 / 35.835 | 20.318 / 23.687 | 0.678 / 0.942 | 10.003 / 12.076 | 33.028 / 35.321 | 54.389 / 63.204 |
| synthetic-plot | figure | baseline | — | 31.761 / 33.002 | 19.488 / 32.370 | 1.189 / 6.464 | 10.110 / 12.323 | 33.648 / 34.391 | 52.677 / 72.112 |
| synthetic-plot | figure | flat | 6.194 / 6.476 | 33.091 / 34.913 | 20.162 / 22.404 | 0.771 / 0.803 | 10.977 / 12.649 | 31.610 / 34.218 | 61.127 / 62.643 |
| synthetic-plot | figure | uncached | 6.257 / 12.027 | 34.508 / 60.004 | 20.160 / 26.976 | 0.685 / 0.978 | 11.540 / 13.082 | 31.623 / 36.326 | 61.867 / 100.346 |
| synthetic-plot | figure | cached | 6.283 / 6.342 | 33.616 / 47.068 | 19.837 / 24.045 | 0.739 / 0.816 | 11.460 / 12.752 | 31.711 / 43.077 | 61.641 / 78.406 |
| pdf-import | small | baseline | — | 15.954 / 17.847 | 0.064 / 0.169 | 0.391 / 0.458 | — | — | 16.564 / 18.631 |
| pdf-import | small | flat | 3.833 / 3.909 | 2.325 / 3.242 | 0.120 / 0.209 | 0.393 / 0.439 | — | — | 6.889 / 7.674 |
| pdf-import | small | uncached | 3.910 / 4.025 | 2.468 / 3.128 | 0.074 / 0.828 | 0.378 / 2.421 | — | — | 7.035 / 10.141 |
| pdf-import | small | cached | 0.202 / 0.205 | 2.512 / 3.381 | 0.061 / 0.185 | 0.359 / 0.411 | — | — | 3.299 / 4.285 |
| pdf-import | reflow | baseline | — | 11.559 / 15.767 | 20.065 / 20.889 | 0.693 / 1.075 | — | — | 32.370 / 37.770 |
| pdf-import | reflow | flat | 3.853 / 4.091 | 14.041 / 16.639 | 21.121 / 22.102 | 0.677 / 0.739 | — | — | 39.731 / 43.352 |
| pdf-import | reflow | uncached | 3.928 / 5.475 | 14.815 / 19.966 | 22.275 / 41.226 | 0.728 / 1.135 | — | — | 45.662 / 56.757 |
| pdf-import | reflow | cached | 0.232 / 0.265 | 13.591 / 17.124 | 20.872 / 21.580 | 0.724 / 0.769 | — | — | 35.606 / 39.067 |
| pdf-import | figure | baseline | — | 18.175 / 28.422 | 21.492 / 21.787 | 0.809 / 1.048 | 0.605 / 0.605 | 3.729 / 3.729 | 40.834 / 51.175 |
| pdf-import | figure | flat | 3.929 / 9.475 | 17.485 / 19.709 | 20.957 / 23.525 | 0.744 / 0.779 | — | — | 43.710 / 50.898 |
| pdf-import | figure | uncached | 3.867 / 4.020 | 16.796 / 18.548 | 21.396 / 22.016 | 0.722 / 0.890 | — | — | 42.953 / 45.380 |
| pdf-import | figure | cached | 0.201 / 0.256 | 16.459 / 17.189 | 20.886 / 22.281 | 0.750 / 0.891 | — | — | 38.606 / 39.492 |
| pdf-resource | figure | baseline | — | 15.052 / 16.555 | 20.835 / 21.104 | 0.732 / 0.820 | — | — | 36.978 / 38.303 |
| pdf-resource | figure | flat | 3.933 / 5.010 | 17.124 / 20.104 | 21.557 / 23.783 | 0.704 / 0.732 | — | — | 44.055 / 46.978 |
| pdf-resource | figure | uncached | 3.923 / 3.967 | 16.093 / 17.704 | 20.818 / 21.491 | 0.727 / 0.792 | — | — | 41.730 / 43.987 |
| pdf-resource | figure | cached | 0.204 / 0.214 | 16.916 / 19.132 | 21.523 / 26.659 | 0.738 / 0.911 | — | — | 39.210 / 44.756 |
| pdf-scale | figure | baseline | — | 15.389 / 19.047 | 20.673 / 25.395 | 0.695 / 0.853 | — | — | 37.028 / 45.448 |
| pdf-scale | figure | flat | 3.933 / 4.094 | 16.688 / 19.167 | 21.419 / 22.777 | 0.698 / 0.780 | — | — | 43.585 / 45.143 |
| pdf-scale | figure | uncached | 3.891 / 4.152 | 15.899 / 17.724 | 20.587 / 21.107 | 0.679 / 0.797 | — | — | 41.635 / 43.103 |
| pdf-scale | figure | cached | 0.206 / 0.243 | 17.045 / 29.012 | 22.776 / 30.659 | 0.707 / 0.790 | — | — | 41.880 / 60.847 |
| pdf-raster | figure | baseline | — | 17.678 / 22.546 | 22.651 / 94.114 | 0.793 / 0.952 | — | — | 41.047 / 117.671 |
| pdf-raster | figure | flat | 3.908 / 4.095 | 16.187 / 17.088 | 20.431 / 21.107 | 0.705 / 0.754 | — | — | 41.544 / 43.093 |
| pdf-raster | figure | uncached | 3.909 / 4.115 | 16.235 / 25.018 | 21.011 / 22.355 | 0.716 / 0.780 | — | — | 42.244 / 51.715 |
| pdf-raster | figure | cached | 0.203 / 0.209 | 15.755 / 17.521 | 20.434 / 24.489 | 0.738 / 1.078 | — | — | 38.151 / 41.507 |
| pdf-repeated | figure | baseline | — | 16.849 / 21.720 | 0.061 / 0.174 | 0.382 / 0.459 | — | — | 17.653 / 22.466 |
| pdf-repeated | figure | flat | 7.485 / 8.111 | 3.298 / 4.498 | 0.067 / 0.100 | 0.387 / 0.503 | 0.501 / 0.501 | 6.311 / 6.311 | 11.971 / 12.678 |
| pdf-repeated | figure | uncached | 7.237 / 7.607 | 17.685 / 19.259 | 0.092 / 0.409 | 0.373 / 0.456 | — | — | 26.133 / 27.218 |
| pdf-repeated | figure | cached | 0.379 / 0.384 | 17.252 / 18.395 | 0.078 / 0.088 | 0.356 / 0.442 | — | — | 18.429 / 19.509 |

## Syntactic XDV stability

Exact XDV instruction or balanced PUSH/POP matches are opportunity measurements only; incoming interpreter state, resource identity, paint order and pixel reuse are not validated by syntactic equality.

| Fixture | Edit | Instructions old / new | Instruction distance | Balanced byte coverage | PDF image matches / new | Diff ms | Total compare ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| math-paper | small | 4103 / 4106 | 19 | 90.923% | 0 / 0 | 0.436 | 20.200 |
| math-paper | reflow | 4103 / 4114 | 1623 | 71.009% | 0 / 0 | 26.139 | 65.319 |
| graphic-slides | small | 525 / 527 | 2 | 84.688% | 2 / 2 | 0.051 | 240.525 |
| graphic-slides | reflow | 525 / 559 | 38 | 76.064% | 2 / 2 | 0.075 | 181.190 |
| election-figure | small | 5053 / 5056 | 5 | 97.195% | 0 / 0 | 0.437 | 18.204 |
| election-figure | reflow | 5053 / 4884 | 1987 | 75.860% | 0 / 0 | 40.128 | 96.107 |
| synthetic-plot | small | 90877 / 90879 | 8 | 99.960% | 0 / 0 | 2.384 | 405.553 |
| synthetic-plot | reflow | 90877 / 91117 | 270 | 99.713% | 0 / 0 | 4.499 | 344.795 |
| synthetic-plot | figure | 90877 / 90879 | incomplete | 0.042% | 0 / 0 | 46.813 | 287.270 |
| pdf-import | small | 73 / 75 | 2 | 31.111% | 1 / 1 | 0.003 | 0.280 |
| pdf-import | reflow | 73 / 320 | 257 | 5.118% | 1 / 1 | 0.315 | 21.610 |
| pdf-import | figure | 73 / 75 | 4 | 26.875% | 1 / 1 | 0.005 | 0.244 |
| pdf-resource | figure | 73 / 75 | 4 | 21.246% | 0 / 1 | 0.032 | 2.328 |
| pdf-scale | figure | 73 / 75 | 6 | 26.838% | 1 / 1 | 0.018 | 0.914 |
| pdf-raster | figure | 73 / 75 | 4 | 26.976% | 1 / 1 | 0.007 | 0.510 |
| pdf-repeated | figure | 93 / 95 | 6 | 33.270% | 2 / 2 | 0.007 | 0.629 |

## Limits

- Research-only immutable imported-PDF fingerprint cache, not a general XDV subtree or raster cache.
- The cache key includes resolved document identity, page and final transform. A moved block changes the key and conservatively invalidates all cells.
- Full pixel comparisons validate these finite sampled edits; they are not a correctness proof for arbitrary documents.
- Compiler-burst is a single instrumented burst, not total compilation latency; the harness does not issue edit-prewarm commands.
- Fixed viewport, zoom and color settings; no scrolling, webview scheduling, presentation latency, revision age or peak-memory measurements.
- Cache lookup still replays MuPDF display-list operations; hits avoid repeated detailed fingerprint analysis, not all display-list traversal.
- Fixed variant order (baseline, flat, uncached, cached); small samples from one machine; reference checks perturb cache/CPU behavior, even though their timed work is excluded from the estimated cost.

## Reproduction

```sh
node scripts/profiling/build-damage-engine.cjs
node scripts/profiling/make-xdv-fixture.cjs artifacts/xdv-fixture
node scripts/profiling/build-xdv-engine.cjs
node scripts/profiling/xdv-block-benchmark.cjs <private-corpus-config.json> <baseline-engine> <flat-engine> <xdv-engine> artifacts/xdv-comparison
node scripts/profiling/xdv-block-benchmark.cjs artifacts/xdv-fixture/adversarial.json <baseline-engine> <flat-engine> <xdv-engine> artifacts/xdv-adversarial
node scripts/profiling/summarize-xdv-blocks.cjs artifacts/xdv-comparison docs/profiling/2026-11-17-xdv-blocks artifacts/xdv-adversarial
```

Revision and input/binary hashes are retained in the accompanying JSON; private paths, manuscripts and compiler configuration strings are omitted.
