# End-to-end checks after the SVG reflow fix

The [bounded glyph-transform patch](2026-11-06-svg-reflow-patches.md) removes an
avoidable SVG replacement cost. This follow-up checks the complete production
session/controller/webview pipeline rather than extrapolating replay savings
into total typing latency. **Keep Auto as the default.** This small follow-up
finds no reason to replace it with either forced PNG or a regression classifier.

## Method

Same existing native engine, real-document harness, private input adaptations
and machine as [the earlier comparison](2026-11-06-realistic-codecs.md).
No native rebuild, downloads or source-document changes. Viewport width is
640 CSS pixels at DPR 2. Conference paper, math paper and text/math slides each
run PNG/Auto for three repetitions, with codec order alternating. Repetition
zero is warm-up. Three supplementary forced-SVG conference sessions run
afterward; they are not interleaved with PNG/Auto and are reported separately.

This gives **21 successful sessions, seven warm-ups and 14 measured sessions**.
Each cell has two measured repetitions and 16 paced edits. No measured session
became hidden, reported a client decode/cache error or missed the burst cadence.
Nearest-rank p95 with 16 correlated edits is descriptive (here it equals the
maximum); it is not a confidence bound. This is one working workstation, with
load recorded, not an isolated lab or a cross-platform performance claim.

Source edits use production DocumentSync. Input-to-two-animation-frame paint
opportunity includes compilation, export, IPC and renderer scheduling, but is
not physical keyboard dispatch or display scanout. Quality is a display-density
geometry check, not a perceptual comparison. Captures were disabled during this
follow-up. The complete zoom/navigation workload remains enabled.

## Results

Warmed paced input-to-paint opportunity, **p50 / p95 ms**:

| Document | PNG | Auto | Auto's paced-edit codec |
| --- | --- | --- | --- |
| Conference paper | 46.1 / 70.6 | 43.6 / 53.8 | PNG |
| Math paper | 36.1 / 53.0 | 33.7 / 40.8 | SVG |
| Text/math slides | 44.5 / 59.9 | 42.1 / 51.5 | SVG |

Forced SVG on the conference paper measures **47.2 / 51.5 ms**. All 16 measured
paced edits use SVG patches, with browser work of 1.7–4.1 ms. This confirms the
new path works through production IPC and source updates. It does not establish
that forcing SVG is faster than Auto, nor that the historical 125 ms Auto tail
fell to 54 ms solely because of this fix: the earlier study is not a controlled
before/after run, and current Auto selected PNG for these conference edits.
The controlled causal evidence remains the identical-frame replay.

Auto is not better on every operation. The two conference burst observations
are 49.0/66.6 ms, versus PNG's 43.9/42.7 ms. For the other documents, bursts are
about 34–45 ms across PNG/Auto. Cold first edits still take roughly 0.68–0.71 s;
this work does not remove compiler checkpoint/bootstrap costs.

SVG retains a zoom advantage in suitable contexts. Slides remain sharp at
200% in about 14 ms versus PNG's 172 ms (lower of two observations). Math is
more nuanced: at 125%, Auto reaches sustained sharpness at about 29 ms versus
PNG's 175 ms; at 200% it falls back to raster/detail and takes about 192 ms
versus PNG's 163 ms. Initial sharpness alone would misstate that second result.
Every operation ends sharp within the observation window in these three cases.

The policy implication is modest: fix concrete rendering/scheduling defects
and retain measured-cost feedback and fallback budgets. These data do not
justify a more elaborate predictor or a universal PNG preference.

## Evidence and reproduction

[Compact results and runtime hashes](2026-11-06-post-reflow-live.json) preserve
per-cell/per-repetition timing, actual edit codecs, quality summaries, cadence,
visibility, native metadata and original/prepared source hashes. They contain
no manuscript text, exported SVG or absolute private input paths.
These sessions precede the separate [PNG detail-queue fix](2026-11-06-png-detail-queue.md).
That report also records final validation and cleanup for both experiments.

Prepare the three private cases using the guide's `real-corpus.cjs` workflow,
then run in a fresh directory:

```sh
npm run compile-tests
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY=/absolute/current/bundle/bin/texpresso \
TEXPRESSO_PROFILE_OUTPUT=artifacts/post-reflow \
TEXPRESSO_REAL_WIDTHS=640 TEXPRESSO_REAL_REPEATS=3 TEXPRESSO_REAL_DPR=2 \
TEXPRESSO_PROFILE_CODECS=png,auto \
node scripts/test-integration.cjs --profile-realistic
```

For the supplementary check, use a conference-only cases manifest, a fresh
output directory and `TEXPRESSO_PROFILE_CODECS=svg`. Summarize both directories
with `node scripts/profiling/summarize-realistic.cjs MAIN SVG_ONLY`. Run one
timing job at a time and do not change compiled runtime files during a matrix.
