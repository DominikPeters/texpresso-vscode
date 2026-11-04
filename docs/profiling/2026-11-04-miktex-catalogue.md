# Windows MiKTeX catalogue in WSL, 4 November 2026

MiKTeX integration is deferred from VS Code v2.0.0. The extension integration,
experiment sources and dedicated workflow are preserved on
[`codex/miktex-experiments`](https://github.com/DominikPeters/texpresso-vscode/tree/codex/miktex-experiments).
Check out that branch for the reproduction commands below. Shared-engine
provider code remains in the unified engine history.

The FNDB catalogue can answer ordinary lookups correctly without launching
Windows processes. It passes 102 real-resolver parity checks. A deliberately
frozen snapshot cuts later edits from about 1.37 seconds to about 0.10 seconds
in the matched-control experiment, but still needs roughly six times TeX Live's
later-edit time in the final focused run. Warm startup and first edits remain
several seconds. This is a useful prototype, not a finished responsive provider;
native integration and efficient update detection remain production work.

## Catalogue with per-query update checks

| Provider / experiment | Empty format | Warm startup | First edit | Later edits |
| --- | ---: | ---: | ---: | ---: |
| TeX Live in WSL | 4.181 s | 0.171 s | 191.0 ms | 13.4 ms |
| Windows MiKTeX: existing bridge | 145.233 s | 20.709 s | 11009.7 ms | 1170.6 ms |
| Windows MiKTeX: instrumented control | 155.779 s | 20.999 s | 10949.8 ms | 1298.5 ms |
| Windows MiKTeX: local catalogue, update checks | 75.861 s | 12.641 s | 7350.5 ms | 910.9 ms |

Three interleaved warm launches, five incremental edits per launch. Startup and
first-edit values are medians of three samples; later edits are the median of
the remaining 12 samples. Empty format does not mean a flushed OS cache.

The catalogue contains 19,061 records across three roots. All 82 sampled hits
and 20 synthetic misses agree with `findtexmf`, with no fallback during parity
validation. Configuration export takes 9.464 seconds, separately from the table.
Catalogue parsing is included in engine timings, about 145 ms per helper.
Packages remain in their existing Windows directories; no package files are
copied and there is no persistent lookup-cache storage.

Across the three warm launches, all 243 requests were answered locally: 135 file
hits, nine version responses and 99 misses. No Windows lookup process was needed.
Nevertheless, request handling took about 55 seconds across those launches and
their edits. Repeated checks of Windows-side configuration, databases, journals
and unmanaged directories remain expensive; eliminating `findtexmf.exe` alone
does not eliminate cross-filesystem overhead. These counters motivate a separate
frozen-snapshot experiment to isolate lookup work from change detection.

## Frozen catalogue with filesystem checks for misses

This separate run disables per-query database/configuration checks and retains
unmanaged recursive-tree misses. It still checks the Windows temp working
directory on each query. The installation remains frozen throughout timing.

| Provider / experiment | Empty format | Warm startup | First edit | Later edits |
| --- | ---: | ---: | ---: | ---: |
| TeX Live in WSL | 5.140 s | 0.222 s | 235.3 ms | 15.7 ms |
| Windows MiKTeX: existing bridge | 163.424 s | 23.985 s | 12540.4 ms | 1369.5 ms |
| Windows MiKTeX: instrumented control | 171.621 s | 24.643 s | 12891.1 ms | 1443.5 ms |
| Windows MiKTeX: frozen catalogue | 36.164 s | 5.851 s | 4331.8 ms | 109.6 ms |

Later edits improve about 12.5 times against the actual bridge, but remain about
seven times slower than the same-run TeX Live reference. Startup improves about
4.1 times. All 102 parity queries agree again; all 243 warm requests are local
with no Windows fallback. Warm request handling totals 11.062 seconds, down from
55.023 seconds in the checked run; the runners differ, so these totals are
diagnostic rather than a controlled cross-run ratio. Parsing averages about
198 ms per helper; separate metadata export takes 9.980 seconds.

## Frozen catalogue with complete resolved misses retained

The final focused variant retains complete resolved misses within each frozen
helper, including nonrecursive working-directory checks. Installation-enabled
misses remain delegated rather than retained. Matched Windows controls are
already recorded above; this run compares with TeX Live and requires identical
reference pixels.

| Provider / experiment | Empty format | Warm startup | First edit | Later edits |
| --- | ---: | ---: | ---: | ---: |
| TeX Live in WSL | 5.246 s | 0.216 s | 218.2 ms | 16.6 ms |
| Windows MiKTeX: frozen catalogue + resolved misses | 37.373 s | 6.110 s | 4472.3 ms | 98.0 ms |

Later edits are about 5.9 times TeX Live, not within two times. The extra miss
memoization makes little further difference relative to the preceding frozen
run; those runs use different hosts, so a small difference cannot establish a
precise speedup. Parity passes all 102 queries again. All 243 warm requests are
local, including 99 misses, with zero Windows lookup processes. Their aggregate
handling time is 11.252 seconds; parsing averages about 204 ms per helper.
Separate metadata export takes 11.041 seconds.

This rules out repeated Windows resolver subprocesses as the remaining warm
bottleneck in this fixture. It does not isolate the remaining native file reads,
format/dependency validation, initial unmanaged-tree scans or Python/path-shim
overhead. A native integration should profile these separately and use efficient
change notification/epochs instead of per-query DrvFS metadata scans. The frozen
snapshot is only a performance experiment: it cannot justify retaining misses
across arbitrary package or search-path changes in the shipped provider.

## Resolver behavior

An independent, read-only Python parser reads MiKTeX FNDB version 5 and its update
journal. Bootstrap exports real roots, file-type policy, search-path order,
Windows temp working directory and drive mappings. No TDS layout or `/mnt/c`
location is assumed. The prototype keeps the existing PowerShell helper as the
fallback and uses the same native engine through benchmark PATH wrappers.

The checked variant stats configuration/database/journal fingerprints per query.
Database replacement and complete journal changes reload the index; corrupt,
unsupported or torn snapshots fall back. Configuration changes require a fresh
metadata export; the existing process falls back until restarted. Same-pattern
duplicate hits use MiKTeX's own tie-breaking. Unmanaged user roots require actual
filesystem checks beyond the FNDB; recursive miss checks stop at directory links,
unindexed candidates or 4,096 directories and fall back. Installation-enabled
misses also fall back so package downloads remain explicit.

The separate `snapshot` mode freezes installation/configuration for a benchmark:
it loads the catalogue once per helper, skips per-query configuration/database
checks and retains proven misses within that helper. Indexed
positive paths still check file existence. It cannot safely handle arbitrary
package, configuration or unindexed-file changes without a restart. Neither
variant is a shipped extension setting or finished production invalidation
policy.

## Validation and reproduction

All initial images match SHA-256
`506e3cec9b8b5f8a2f46748225603deb208732276b361dc87913a3460b63f7e9`.
Every edit waits for a changed PNG carrying its editor sequence. Warm format
timestamps remain unchanged; renderer font/TEC warnings are rejected. Packages
are primed before measurement, and timed MiKTeX runs disable installation.
Timings end at complete 800-pixel PNG payload arrival, before VS Code decoding
and paint. One small article/math document on one Windows 2022/Ubuntu 24.04 WSL
runner is insufficient to establish performance across real projects or systems.

- [Checked-catalogue run](https://github.com/DominikPeters/texpresso-vscode/actions/runs/41914795972).
- [All checked-mode samples and counters](2026-11-04-miktex-catalogue-checked.json).
- [Frozen-catalogue run with matched Windows controls](https://github.com/DominikPeters/texpresso-vscode/actions/runs/41919014591).
- [Frozen-mode samples and counters](2026-11-04-miktex-catalogue-snapshot.json),
  benchmark revision `081a807e4857da7f788eac86e05cf715973c3c45`.
- [Focused frozen-miss run](https://github.com/DominikPeters/texpresso-vscode/actions/runs/41922692989)
  and [all samples/counters](2026-11-04-miktex-catalogue-resident.json), benchmark
  revision `d4514d1bbcb9467dce6a8f2acdb09ee9d6baf8e1`.
- Benchmark revision: `2c39efee92368fa2a82c7c326fc9a192372e65ac`.
- Shared engine: `25ea10f6a443636fff55f36c69dfd9e46952a0ea`.
- Upstream layout/search reference: MiKTeX `76d1b3bd2b69857f30133c62ff9ab66c83dcf80f`.
- Installed Windows resolver: MiKTeX Find Utility 4.1 / MiKTeX 26.5.
- Document SHA-256: `b046c0e18e28bcfbae6d52adca6053ac25094ebfd1543f4264d02aa541f08700`.

```sh
gh workflow run provider-benchmark.yml --ref codex/miktex-experiments -f catalogue=true
gh workflow run provider-benchmark.yml --ref codex/miktex-experiments -f snapshot=true
python3 -B native/bench/providers/test_catalogue.py
```

On an already provisioned WSL runner, use `benchmark.py --catalogue` or
`--catalogue-snapshot` with `--engine`, a new `--output` directory and `--repeats 3`.
Raw diagnostics have seven-day CI retention. Compact reports preserve samples,
revisions and commands; native builds and package installations run on GitHub.
