# Package providers and cache experiments, 4 November 2026

TeX Live and Tectonic are responsive on this fixture. Both MiKTeX paths are too
slow for a good live-preview experience in their current implementation.
Persisting positive lookup paths helps, but does not solve that problem. Copying
package files into WSL adds storage without improving these results.

## Results

| Provider / experiment | Empty format | Warm startup | First edit | Later edits | Extra lookup/cache storage |
| --- | ---: | ---: | ---: | ---: | ---: |
| TeX Live in WSL | 3.882 s | 0.162 s | 147.1 ms | 12.8 ms | 0.00 MiB |
| Tectonic in WSL | 1.358 s | 0.194 s | 178.9 ms | 12.1 ms | 0.00 MiB |
| MiKTeX in WSL | 30.035 s | 7.010 s | 3564.6 ms | 436.2 ms | 0.00 MiB |
| Windows MiKTeX: current bridge | 136.227 s | 19.570 s | 10392.9 ms | 1145.6 ms | 0.00 MiB |
| Windows MiKTeX: instrumented control | 146.462 s | 20.288 s | 10870.2 ms | 1232.0 ms | 0.00 MiB |
| Windows MiKTeX: saved positive paths | 139.738 s | 9.824 s | 5825.5 ms | 797.4 ms | 0.19 MiB |
| Windows MiKTeX: paths + local file copies | 143.784 s | 10.537 s | 5869.1 ms | 828.5 ms | 9.06 MiB |

Warm startup and first-edit values are medians of three launches. Later edits
are the median of the remaining four edits in each launch (12 samples). The
first edit is sent immediately after the initial image; it is deliberately
reported separately because it is much slower than subsequent edits. The JSON
contains every sample and the proxy counters. Extra storage excludes installed
providers, their normal caches, TeXpresso formats and OS caches.

The instrumented control costs roughly 0.7 seconds over the actual Windows
bridge at warm startup. Compare path/mirror experiments with that control.
Saved paths reduce warm startup by about 52%, but still leave roughly 0.8-second
later edits and 5.8-second first edits. Mirroring is slightly slower in this run
and adds about 9 MiB. Neither prototype is a satisfactory finished optimization.

Across the three warm path-cache sessions, 135 successful lookups hit the cache.
There were still 99 unsuccessful lookups and 9 other requests (availability
probes), taking about 42 seconds in the Windows helper across startup and all
15 edits. Positive-result caching cannot eliminate these remaining calls. The
next design should avoid per-file subprocess queries using a package catalogue
or batched lookup, with explicit invalidation for installation/search-order
changes. Missing results cannot simply be cached indefinitely.

## Method and limits

One Windows 2022 GitHub runner, Ubuntu 24.04 in WSL 2, the same embedded compiler,
and one small article/amsmath document. Every initial PNG had SHA-256
`506e3cec9b8b5f8a2f46748225603deb208732276b361dc87913a3460b63f7e9`.
Every edit required a matching editor sequence and a changed PNG body; logs had
no missing renderer-font or TECkit-map warnings. Warm format file timestamps
were checked for reuse. First-use package downloads were completed before
measurement, and MiKTeX installation was disabled in every timed session.
Tectonic retained its normal bundle-validation behavior. Package versions vary
between distributions; the document and installed-package state were held fixed
within each provider's cases.

Empty format means fresh TeXpresso format and experimental lookup caches, not a
flushed OS cache or a fresh provider installation. All cold cases run first;
warm cases are interleaved using a fixed random seed. This is a small CI sample,
not a broad corpus or a statistical claim about all hardware. WSL uses root and
the Windows runner uses an administrator account, unlike many desktop sessions.
Times end at receipt of a current 800-pixel PNG payload, before VS Code transport,
browser decoding and paint. Actual visible UI latency includes those costs.

Caches are benchmark-only: successful paths validate file identity, size and
timestamps; misses are retried. The mirror validates original inputs before
worker format validation. Production update/ranking invalidation, live dependency
watching and eviction still need design. No runtime cache setting is shipped.

This run exposed a separate correctness issue: a Windows format with packages
already installed exceeded the ordinary two-minute worker startup limit while
loading hyphenation patterns. The experimental bridge now permits a bounded ten
minutes without enabling package installation. That makes cold initialization
finish; it does not improve its speed. Ordinary native startup limits and fast
test overrides are unchanged.

## Provenance and reproduction

- [Successful benchmark and diagnostics](https://github.com/DominikPeters/texpresso-vscode/actions/runs/41879711571).
- [Complete samples and counters](2026-11-04-provider-cache.json).
- Benchmark extension revision: `8275a919303c87c582527bde745e901e50328847`.
- Shared engine: `25ea10f6a443636fff55f36c69dfd9e46952a0ea`.
- Document SHA-256: `b046c0e18e28bcfbae6d52adca6053ac25094ebfd1543f4264d02aa541f08700`.
- kpathsea 6.3.5; Linux MiKTeX Find Utility 4.1 / MiKTeX 26.5; Tectonic 0.17.0.
  Windows uses the checksum-verified basic MiKTeX 25.12 installer followed by
  package updates; its exact final core version was not captured.

The reusable workflow is `provider-benchmark.yml`, intentionally manual to avoid
repeating a substantial experiment for unrelated PR edits. With all providers
already provisioned on the runner, the measured command is:

```sh
TEXPRESSO_MIKTEX_WINDOWS_BIN='C:\path\to\miktex\bin\x64' \
python3 native/bench/providers/benchmark.py \
  --engine /opt/texpresso/build/texpresso \
  --output /opt/provider-benchmark-output --repeats 3
```

Raw logs have seven-day CI retention. This compact report and JSON preserve the
results; format caches, package copies and executables remain on the disposable
runner. No substantial native build or benchmark ran on the developer machine.
