# General structural damage measurements

Native-only structural damage experiment on real papers/slides and generated direct-TikZ pages; not end-to-end or presentation latency.

Timing cells are median / p95 milliseconds. Warmups are excluded. Render for baseline is png-draw; candidates report render without the oracle. Native export estimates include analysis, render, color, compare, encode and text bounds.

## general-dense

Machine: Apple M1 Pro, darwin/arm64. 28 full-reference and 28 baseline pixel comparisons passed, including warmups.

| Fixture | Edit | Variant | Grid / clip | Analysis | Render | PNG compare | PNG encode | Export estimate | Changed cells median | Direct cells median | Operations median |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense-math-body | small | baseline | 3181 / [0, 1024, 2048, 2560] | — | 1.308 / 1.571 | 0.370 / 0.697 | 0.083 / 0.109 | 1.802 / 2.436 | — | — | — |
| dense-math-body | small | flat | 3181 / [0, 1024, 2048, 2560] | 0.444 / 0.527 | 2.298 / 2.502 | 0.354 / 0.374 | 0.122 / 0.126 | 3.245 / 3.509 | 66.667% | 0.000 | 254.000 |
| dense-math-body | small | direct | 3181 / [0, 1024, 2048, 2560] | 0.426 / 0.449 | 2.103 / 2.429 | 0.362 / 0.380 | 0.053 / 0.064 | 2.992 / 3.378 | 66.667% | 8.000 | 254.000 |
| dense-math-body | reflow | baseline | 3181 / [0, 1024, 2048, 2560] | — | 1.657 / 2.616 | 0.901 / 1.478 | 10.444 / 11.503 | 12.935 / 15.671 | — | — | — |
| dense-math-body | reflow | flat | 3181 / [0, 1024, 2048, 2560] | 0.410 / 0.434 | 3.204 / 7.258 | 0.930 / 2.412 | 10.677 / 15.565 | 16.007 / 26.066 | 100.000% | 0.000 | 246.500 |
| dense-math-body | reflow | direct | 3181 / [0, 1024, 2048, 2560] | 0.399 / 0.424 | 2.533 / 3.541 | 0.815 / 0.831 | 10.598 / 11.072 | 14.502 / 15.381 | 100.000% | 12.000 | 246.500 |

Offline conservative cost-gate replay: thresholds use only previously observed full native draw cost. Calibration warmups train state but are excluded below. This is counterfactual arithmetic, not a native policy or presentation measurement. Routes are measured full / cold / warm counts; cold explicitly pays fresh analysis plus baseline full export.

| Fixture | Edit | Threshold ms | Replay median ms | Baseline total ms | Replay total ms | Saved total ms | Saved median ms | Full / cold / warm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense-math-body | small | 4 | 1.802 | 11.427 | 11.427 | 0.000 | 0.000 | 6 / 0 / 0 |
| dense-math-body | small | 8 | 1.802 | 11.427 | 11.427 | 0.000 | 0.000 | 6 / 0 / 0 |
| dense-math-body | small | 16 | 1.802 | 11.427 | 11.427 | 0.000 | 0.000 | 6 / 0 / 0 |
| dense-math-body | reflow | 4 | 12.935 | 79.929 | 79.929 | 0.000 | 0.000 | 6 / 0 / 0 |
| dense-math-body | reflow | 8 | 12.935 | 79.929 | 79.929 | 0.000 | 0.000 | 6 / 0 / 0 |
| dense-math-body | reflow | 16 | 12.935 | 79.929 | 79.929 | 0.000 | 0.000 | 6 / 0 / 0 |

Replay full draws discard the signature base. The next enabled sample therefore pays a cold start. A warm update that changes every cell contributes an approximate full-render observation (clone/clear overhead included). Probes occur every 16 samples, beyond these seven-edit sequences. No reference/oracle timing drives selection.


Paired comparisons below show median export costs and paired median milliseconds saved. Hindsight columns use exact measured costs and cannot be deployed as a selection policy.

| Fixture | Edit | Baseline ms | Direct ms | Median-cost speedup | Saved ms | Hindsight minimum ms | Hindsight with sunk analysis ms | Direct wins |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dense-math-body | all | 7.398 | 8.739 | 0.847× | -1.237 | 7.398 | 7.803 | 1/12 |
| dense-math-body | small | 1.802 | 2.992 | 0.602× | -1.112 | 1.802 | 2.232 | 0/6 |
| dense-math-body | reflow | 12.935 | 14.502 | 0.892× | -1.681 | 12.935 | 13.345 | 1/6 |
## general-more

Machine: Apple M1 Pro, darwin/arm64. 56 full-reference and 56 baseline pixel comparisons passed, including warmups.

| Fixture | Edit | Variant | Grid / clip | Analysis | Render | PNG compare | PNG encode | Export estimate | Changed cells median | Direct cells median | Operations median |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| two-column-math | small | baseline | 3404 / [0, 2560, 2048, 4096] | — | 1.536 / 3.129 | 0.419 / 1.625 | 0.052 / 0.072 | 2.291 / 4.918 | — | — | — |
| two-column-math | small | flat | 3404 / [0, 2560, 2048, 4096] | 0.581 / 0.600 | 1.600 / 2.193 | 0.388 / 0.531 | 0.059 / 0.078 | 2.686 / 3.370 | 33.333% | 0.000 | 324.000 |
| two-column-math | small | direct | 3404 / [0, 2560, 2048, 4096] | 0.578 / 0.609 | 1.405 / 1.506 | 0.358 / 0.396 | 0.054 / 0.194 | 2.511 / 2.687 | 33.333% | 4.000 | 324.000 |
| two-column-math | reflow | baseline | 3404 / [0, 2560, 2048, 4096] | — | 1.620 / 3.253 | 1.010 / 1.367 | 11.245 / 11.777 | 13.918 / 16.484 | — | — | — |
| two-column-math | reflow | flat | 3404 / [0, 2560, 2048, 4096] | 0.556 / 0.580 | 3.123 / 3.598 | 0.818 / 0.881 | 10.871 / 11.205 | 15.520 / 16.190 | 100.000% | 0.000 | 312.000 |
| two-column-math | reflow | direct | 3404 / [0, 2560, 2048, 4096] | 0.579 / 1.005 | 2.963 / 3.746 | 0.804 / 1.003 | 11.335 / 11.656 | 15.753 / 16.929 | 100.000% | 12.000 | 312.000 |
| direct-tikz-slides | small | baseline | 4000 / [0, 0, 2048, 1536] | — | 5.043 / 5.441 | 0.399 / 0.826 | 0.101 / 0.215 | 5.643 / 6.053 | — | — | — |
| direct-tikz-slides | small | flat | 4000 / [0, 0, 2048, 1536] | 0.146 / 0.166 | 4.223 / 4.308 | 0.409 / 0.480 | 0.076 / 0.110 | 4.865 / 5.014 | 66.667% | 0.000 | 107.000 |
| direct-tikz-slides | small | direct | 4000 / [0, 0, 2048, 1536] | 0.144 / 0.159 | 4.003 / 4.095 | 0.418 / 0.424 | 0.076 / 0.097 | 4.678 / 4.732 | 66.667% | 8.000 | 107.000 |
| direct-tikz-slides | reflow | baseline | 4000 / [0, 0, 2048, 1536] | — | 4.660 / 4.858 | 0.784 / 1.573 | 12.886 / 13.151 | 18.306 / 18.992 | — | — | — |
| direct-tikz-slides | reflow | flat | 4000 / [0, 0, 2048, 1536] | 0.152 / 0.169 | 6.247 / 6.897 | 0.812 / 0.853 | 13.204 / 13.915 | 20.495 / 21.082 | 100.000% | 0.000 | 108.000 |
| direct-tikz-slides | reflow | direct | 4000 / [0, 0, 2048, 1536] | 0.150 / 0.165 | 5.679 / 6.214 | 0.893 / 0.934 | 13.035 / 13.229 | 19.651 / 20.169 | 100.000% | 12.000 | 108.000 |

Offline conservative cost-gate replay: thresholds use only previously observed full native draw cost. Calibration warmups train state but are excluded below. This is counterfactual arithmetic, not a native policy or presentation measurement. Routes are measured full / cold / warm counts; cold explicitly pays fresh analysis plus baseline full export.

| Fixture | Edit | Threshold ms | Replay median ms | Baseline total ms | Replay total ms | Saved total ms | Saved median ms | Full / cold / warm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| two-column-math | small | 4 | 2.291 | 16.321 | 16.321 | 0.000 | 0.000 | 6 / 0 / 0 |
| two-column-math | small | 8 | 2.291 | 16.321 | 16.321 | 0.000 | 0.000 | 6 / 0 / 0 |
| two-column-math | small | 16 | 2.291 | 16.321 | 16.321 | 0.000 | 0.000 | 6 / 0 / 0 |
| two-column-math | reflow | 4 | 13.918 | 85.779 | 85.779 | 0.000 | 0.000 | 6 / 0 / 0 |
| two-column-math | reflow | 8 | 13.918 | 85.779 | 85.779 | 0.000 | 0.000 | 6 / 0 / 0 |
| two-column-math | reflow | 16 | 13.918 | 85.779 | 85.779 | 0.000 | 0.000 | 6 / 0 / 0 |
| direct-tikz-slides | small | 4 | 4.712 | 34.177 | 29.602 | 4.575 | 0.806 | 0 / 1 / 5 |
| direct-tikz-slides | small | 8 | 5.643 | 34.177 | 34.177 | 0.000 | 0.000 | 6 / 0 / 0 |
| direct-tikz-slides | small | 16 | 5.643 | 34.177 | 34.177 | 0.000 | 0.000 | 6 / 0 / 0 |
| direct-tikz-slides | reflow | 4 | 19.532 | 110.103 | 117.364 | -7.261 | -1.302 | 0 / 1 / 5 |
| direct-tikz-slides | reflow | 8 | 18.306 | 110.103 | 110.103 | 0.000 | 0.000 | 6 / 0 / 0 |
| direct-tikz-slides | reflow | 16 | 18.306 | 110.103 | 110.103 | 0.000 | 0.000 | 6 / 0 / 0 |

Replay full draws discard the signature base. The next enabled sample therefore pays a cold start. A warm update that changes every cell contributes an approximate full-render observation (clone/clear overhead included). Probes occur every 16 samples, beyond these seven-edit sequences. No reference/oracle timing drives selection.


Paired comparisons below show median export costs and paired median milliseconds saved. Hindsight columns use exact measured costs and cannot be deployed as a selection policy.

| Fixture | Edit | Baseline ms | Direct ms | Median-cost speedup | Saved ms | Hindsight minimum ms | Hindsight with sunk analysis ms | Direct wins |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| two-column-math | all | 9.113 | 9.074 | 1.004× | -0.653 | 7.997 | 8.268 | 4/12 |
| two-column-math | small | 2.291 | 2.511 | 0.912× | -0.198 | 2.168 | 2.467 | 3/6 |
| two-column-math | reflow | 13.918 | 15.753 | 0.884× | -2.136 | 13.918 | 14.537 | 1/6 |
| direct-tikz-slides | all | 12.036 | 12.034 | 1.000× | -0.270 | 11.375 | 11.450 | 6/12 |
| direct-tikz-slides | small | 5.643 | 4.678 | 1.206× | 0.960 | 4.678 | 4.678 | 6/6 |
| direct-tikz-slides | reflow | 18.306 | 19.651 | 0.932× | -1.302 | 18.306 | 18.451 | 0/6 |
## general-motion

Machine: Apple M1 Pro, darwin/arm64. 56 full-reference and 56 baseline pixel comparisons passed, including warmups.

| Fixture | Edit | Variant | Grid / clip | Analysis | Render | PNG compare | PNG encode | Export estimate | Changed cells median | Direct cells median | Operations median |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | reflow | baseline | 3404 / [1024, 0, 3072, 1536] | — | 341.492 / 423.248 | 0.893 / 1.069 | 22.203 / 25.068 | 365.383 / 447.904 | — | — | — |
| tikz-curves | reflow | flat | 3404 / [1024, 0, 3072, 1536] | 0.925 / 0.940 | 345.993 / 453.597 | 0.827 / 15.333 | 24.095 / 40.201 | 387.604 / 478.976 | 83.333% | 0.000 | 774.000 |
| tikz-curves | reflow | direct | 3404 / [1024, 0, 3072, 1536] | 0.907 / 0.994 | 430.847 / 565.661 | 0.884 / 1.506 | 23.011 / 26.064 | 456.654 / 588.857 | 83.333% | 10.000 | 774.000 |
| tikz-curves | figure | baseline | 3404 / [1024, 0, 3072, 1536] | — | 427.769 / 467.068 | 0.349 / 0.784 | 0.002 / 0.021 | 428.164 / 467.499 | — | — | — |
| tikz-curves | figure | flat | 3404 / [1024, 0, 3072, 1536] | 0.966 / 1.101 | 162.736 / 181.615 | 0.405 / 1.282 | 0.003 / 0.006 | 164.590 / 183.021 | 66.667% | 0.000 | 771.000 |
| tikz-curves | figure | direct | 3404 / [1024, 0, 3072, 1536] | 0.938 / 1.774 | 161.849 / 192.024 | 0.329 / 0.947 | 0.002 / 0.005 | 163.123 / 194.325 | 66.667% | 8.000 | 771.000 |
| tikz-partial-themed | reflow | baseline | 3404 / [1097, 91, 2999, 1445] | — | 38.953 / 55.341 | 1.022 / 1.580 | 14.742 / 18.440 | 56.419 / 74.475 | — | — | — |
| tikz-partial-themed | reflow | flat | 3404 / [1097, 91, 2999, 1445] | 0.120 / 0.159 | 34.145 / 51.606 | 0.764 / 2.307 | 15.171 / 17.712 | 52.225 / 67.427 | 83.333% | 0.000 | 70.000 |
| tikz-partial-themed | reflow | direct | 3404 / [1097, 91, 2999, 1445] | 0.118 / 0.165 | 33.444 / 38.483 | 0.719 / 0.780 | 14.352 / 16.602 | 48.698 / 55.347 | 83.333% | 2.000 | 70.000 |
| tikz-partial-themed | figure | baseline | 3404 / [1097, 91, 2999, 1445] | — | 37.351 / 39.402 | 0.547 / 0.703 | 0.003 / 0.005 | 39.641 / 41.136 | — | — | — |
| tikz-partial-themed | figure | flat | 3404 / [1097, 91, 2999, 1445] | 0.098 / 0.120 | 18.000 / 18.519 | 0.265 / 0.320 | 0.002 / 0.003 | 18.399 / 18.885 | 66.667% | 0.000 | 67.000 |
| tikz-partial-themed | figure | direct | 3404 / [1097, 91, 2999, 1445] | 0.100 / 0.113 | 18.363 / 34.636 | 0.336 / 0.663 | 0.003 / 0.004 | 18.986 / 35.195 | 66.667% | 2.000 | 67.000 |

Offline conservative cost-gate replay: thresholds use only previously observed full native draw cost. Calibration warmups train state but are excluded below. This is counterfactual arithmetic, not a native policy or presentation measurement. Routes are measured full / cold / warm counts; cold explicitly pays fresh analysis plus baseline full export.

| Fixture | Edit | Threshold ms | Replay median ms | Baseline total ms | Replay total ms | Saved total ms | Saved median ms | Full / cold / warm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | reflow | 4 | 451.208 | 2188.215 | 2583.524 | -395.309 | -15.423 | 0 / 1 / 5 |
| tikz-curves | reflow | 8 | 451.208 | 2188.215 | 2583.524 | -395.309 | -15.423 | 0 / 1 / 5 |
| tikz-curves | reflow | 16 | 451.208 | 2188.215 | 2583.524 | -395.309 | -15.423 | 0 / 1 / 5 |
| tikz-curves | figure | 4 | 174.433 | 2641.362 | 1326.350 | 1315.012 | 253.698 | 0 / 1 / 5 |
| tikz-curves | figure | 8 | 174.433 | 2641.362 | 1326.350 | 1315.012 | 253.698 | 0 / 1 / 5 |
| tikz-curves | figure | 16 | 174.433 | 2641.362 | 1326.350 | 1315.012 | 253.698 | 0 / 1 / 5 |
| tikz-partial-themed | reflow | 4 | 48.698 | 337.479 | 302.052 | 35.427 | 1.167 | 0 / 1 / 5 |
| tikz-partial-themed | reflow | 8 | 48.698 | 337.479 | 302.052 | 35.427 | 1.167 | 0 / 1 / 5 |
| tikz-partial-themed | reflow | 16 | 48.698 | 337.479 | 302.052 | 35.427 | 1.167 | 0 / 1 / 5 |
| tikz-partial-themed | figure | 4 | 19.549 | 237.707 | 151.272 | 86.435 | 19.781 | 0 / 1 / 5 |
| tikz-partial-themed | figure | 8 | 19.549 | 237.707 | 151.272 | 86.435 | 19.781 | 0 / 1 / 5 |
| tikz-partial-themed | figure | 16 | 19.549 | 237.707 | 151.272 | 86.435 | 19.781 | 0 / 1 / 5 |

Replay full draws discard the signature base. The next enabled sample therefore pays a cold start. A warm update that changes every cell contributes an approximate full-render observation (clone/clear overhead included). Probes occur every 16 samples, beyond these seven-edit sequences. No reference/oracle timing drives selection.


Paired comparisons below show median export costs and paired median milliseconds saved. Hindsight columns use exact measured costs and cannot be deployed as a selection policy.

| Fixture | Edit | Baseline ms | Direct ms | Median-cost speedup | Saved ms | Hindsight minimum ms | Hindsight with sunk analysis ms | Direct wins |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | all | 428.164 | 240.321 | 1.782× | 115.819 | 236.259 | 236.756 | 6/12 |
| tikz-curves | reflow | 365.383 | 456.654 | 0.800× | -17.441 | 365.383 | 366.269 | 0/6 |
| tikz-curves | figure | 428.164 | 163.123 | 2.625× | 265.397 | 163.123 | 163.123 | 6/6 |
| tikz-partial-themed | all | 42.166 | 38.925 | 1.083× | 14.444 | 38.925 | 38.925 | 11/12 |
| tikz-partial-themed | reflow | 56.419 | 48.698 | 1.159× | 2.333 | 48.510 | 48.578 | 5/6 |
| tikz-partial-themed | figure | 39.641 | 18.986 | 2.088× | 19.883 | 18.986 | 18.986 | 6/6 |
## general-visible

Machine: Apple M1 Pro, darwin/arm64. 28 full-reference and 28 baseline pixel comparisons passed, including warmups.

| Fixture | Edit | Variant | Grid / clip | Analysis | Render | PNG compare | PNG encode | Export estimate | Changed cells median | Direct cells median | Operations median |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | small | baseline | 3404 / [0, 0, 2048, 1536] | — | 750.304 / 785.024 | 0.450 / 0.653 | 0.111 / 0.669 | 751.257 / 785.673 | — | — | — |
| tikz-curves | small | flat | 3404 / [0, 0, 2048, 1536] | 1.252 / 1.310 | 277.270 / 281.093 | 0.377 / 0.400 | 0.059 / 0.092 | 279.019 / 282.858 | 66.667% | 0.000 | 771.000 |
| tikz-curves | small | direct | 3404 / [0, 0, 2048, 1536] | 1.236 / 1.358 | 280.138 / 332.979 | 0.381 / 0.831 | 0.088 / 0.107 | 281.855 / 334.838 | 66.667% | 8.000 | 771.000 |
| tikz-partial-themed | small | baseline | 3404 / [73, 91, 1975, 1445] | — | 61.953 / 62.440 | 0.412 / 0.755 | 0.093 / 0.109 | 64.014 / 64.886 | — | — | — |
| tikz-partial-themed | small | flat | 3404 / [73, 91, 1975, 1445] | 0.123 / 0.130 | 28.771 / 32.679 | 0.327 / 0.716 | 0.123 / 0.518 | 29.511 / 33.248 | 66.667% | 0.000 | 67.000 |
| tikz-partial-themed | small | direct | 3404 / [73, 91, 1975, 1445] | 0.121 / 0.419 | 29.317 / 32.551 | 0.362 / 0.495 | 0.097 / 0.181 | 29.874 / 33.170 | 66.667% | 2.000 | 67.000 |

Offline conservative cost-gate replay: thresholds use only previously observed full native draw cost. Calibration warmups train state but are excluded below. This is counterfactual arithmetic, not a native policy or presentation measurement. Routes are measured full / cold / warm counts; cold explicitly pays fresh analysis plus baseline full export.

| Fixture | Edit | Threshold ms | Replay median ms | Baseline total ms | Replay total ms | Saved total ms | Saved median ms | Full / cold / warm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | small | 4 | 283.664 | 4539.358 | 2248.146 | 2291.212 | 457.582 | 0 / 1 / 5 |
| tikz-curves | small | 8 | 283.664 | 4539.358 | 2248.146 | 2291.212 | 457.582 | 0 / 1 / 5 |
| tikz-curves | small | 16 | 283.664 | 4539.358 | 2248.146 | 2291.212 | 457.582 | 0 / 1 / 5 |
| tikz-partial-themed | small | 4 | 29.874 | 383.105 | 215.660 | 167.445 | 33.436 | 0 / 1 / 5 |
| tikz-partial-themed | small | 8 | 29.874 | 383.105 | 215.660 | 167.445 | 33.436 | 0 / 1 / 5 |
| tikz-partial-themed | small | 16 | 29.874 | 383.105 | 215.660 | 167.445 | 33.436 | 0 / 1 / 5 |

Replay full draws discard the signature base. The next enabled sample therefore pays a cold start. A warm update that changes every cell contributes an approximate full-render observation (clone/clear overhead included). Probes occur every 16 samples, beyond these seven-edit sequences. No reference/oracle timing drives selection.


Paired comparisons below show median export costs and paired median milliseconds saved. Hindsight columns use exact measured costs and cannot be deployed as a selection policy.

| Fixture | Edit | Baseline ms | Direct ms | Median-cost speedup | Saved ms | Hindsight minimum ms | Hindsight with sunk analysis ms | Direct wins |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tikz-curves | all | 751.257 | 281.855 | 2.665× | 465.649 | 281.855 | 281.855 | 6/6 |
| tikz-curves | small | 751.257 | 281.855 | 2.665× | 465.649 | 281.855 | 281.855 | 6/6 |
| tikz-partial-themed | all | 64.014 | 29.874 | 2.143× | 33.436 | 29.874 | 29.874 | 6/6 |
| tikz-partial-themed | small | 64.014 | 29.874 | 2.143× | 33.436 | 29.874 | 29.874 | 6/6 |

## Interpretation limits

- These measurements determine whether gains occur on the sampled workloads; they do not establish a universally beneficial damage path.
- A per-frame minimum requires knowing both rendering costs before choosing and is not an implementable policy.
- Bypassing damage analysis invalidates the signature base for subsequent revisions; a policy needs cheap probes, signature maintenance/rebuild costs, or partial feedback.
- Oracle verification work is excluded from sums but perturbs CPU and cache behavior. Six samples, one machine, fixed viewport and zoom.
- Pixel equality on sampled edits is not a correctness proof for arbitrary clipping, transparency, masks, moved content or resources.
- No presentation latency, revision age, scrolling, peak memory or general user workload distribution is measured.

Damage analysis is a sunk cost once performed. Falling back then costs analysis plus the baseline render path; skipping it also loses the signature base. Cheap probes or partial feedback and explicit base maintenance need measurement before any selection policy is proposed.

## Reproduction

```sh
node scripts/profiling/build-damage-engine.cjs
node scripts/profiling/general-damage.cjs <private-corpus-config.json> <baseline-engine> <damage-engine> <fresh-output-directory>
node scripts/profiling/summarize-general-damage.cjs <completed-output-directory> [<another-completed-directory>] --output docs/profiling/2026-11-17-general-damage
```

The accompanying JSON retains revisions and hashes, with absolute source paths and compiler configuration strings omitted.
