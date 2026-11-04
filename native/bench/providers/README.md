# Package provider and cache benchmark

The manual `Provider and cache benchmark` Actions workflow compares the same
article/math document on one Windows/WSL runner with TeX Live, Linux MiKTeX,
Tectonic, and Windows MiKTeX. It builds the committed shared-engine pin. Run it
explicitly when measurements are needed; ordinary PR edits do not repeat this
substantial job.

Packages are provisioned before timing. Each provider gets a fresh TeXpresso
format cache, followed by three interleaved warm launches. Every measured
launch performs five edits and waits for a changed PNG tagged with the matching
editor sequence. Timings stop at the engine's complete PNG payload, excluding
VS Code/browser transport, decoding and paint. This is one representative small
document, not a broad document corpus. Cold means empty application caches,
not a flushed OS page cache. MiKTeX downloads are disabled during measurements;
Tectonic retains its usual bundle-validation behavior.

Windows cases compare the real bridge, an instrumented proxy with no cache,
a persistent positive lookup-path cache, and a cache which additionally copies
package files into the WSL filesystem. The direct/proxy-none difference exposes
harness overhead. Cache counters include remote lookup time and hit counts;
reports include added file storage. Image hashes must match between Windows
cache strategies and between each case's cold and warm launches.

These are **benchmark-only cache prototypes**, not new runtime settings. They
validate original files by identity, size and timestamps, do not retain misses,
and clear path records after successful font-map regeneration. Mirrored inputs
are refreshed before worker format validation, so unchanged local copies cannot
hide a modified/deleted original. The installation is otherwise frozen during
the experiment: package database changes and search-order overrides need a
production invalidation design. Live dependency watching and cache eviction
would also need design and testing before shipping a mirrored provider.

Small local correctness checks require no native build or download:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 native/bench/providers/test_cache.py
```

With all four providers already installed in a disposable WSL environment:

```sh
TEXPRESSO_MIKTEX_WINDOWS_BIN='C:\path\to\miktex\bin\x64' \
python3 native/bench/providers/benchmark.py \
  --engine /opt/texpresso/build/texpresso \
  --output /opt/provider-benchmark-output --repeats 3
```

Use a new output directory. GitHub retains compact JSON/Markdown results and
logs for seven days. Format caches, mirrored packages and executables stay on
the disposable runner. Save the final compact report, revisions and command in
`docs/profiling/` before raw diagnostic retention expires.

Results: [4 November 2026](../../../docs/profiling/2026-11-04-provider-cache.md).
