# Predicting rendering cost from display-list features

This is an offline experiment. The shipping Auto classifier and default are
unchanged. It tests whether cheap content features predict PNG/SVG rendering
work on projects excluded from model fitting and parameter selection.

These measurements predate the [SVG reflow patch fix](2026-11-06-svg-reflow-patches.md),
which removes avoidable full replacements in the measured text-edit cases.
Replacement timings below describe the earlier renderer.

## Result

The richer regression **does not justify a shipping classifier change** on this
corpus. Its codec decisions save about **0.008 ms** over the scalar model after
charging measured feature acquisition, and its held-out timing predictions are
slightly worse. It improves choice cost on only one of seven projects. Keep the
instrumentation and evaluation tools, with Auto's production policy unchanged.

The matrix completed **126 sessions**: seven eligible projects × two codecs ×
three display contexts × three repetitions. Forty-two warm-ups and two measured
sessions whose webviews became hidden are excluded. The remaining 82 sessions
provide **722 accepted render-work observations**: 82 first frames and 640 paced
edits. Production's cost-recording hook supplies no current render-work record
for the 82 cold-edit observations; these are audited as missing, not imputed.
Sixteen forced-SVG edit observations actually fell back to PNG (the wide Retina
TikZ election page) and are excluded from requested-codec fitting.

Of the matched pairs, **259** meet the same-content, full-display-density
criterion. Another 85 require PNG detail refinement and are excluded from the
choice score. Thirty-four observations lack an eligible codec partner after
visibility/fallback exclusions. There are no compiled-content counter mismatches.
No timing outliers were removed. These are seven independent projects, not 722
independent documents.

Project-balanced held-out results, milliseconds:

| Predictor/policy | Timing prediction MAE | Selected rendering work, including feature acquisition |
| --- | ---: | ---: |
| Constant + base state | 11.545 | 5.553 |
| Scalar complexity + state | 11.506 | 5.521 |
| Content features + state | 12.124 | 5.514 |
| Always PNG | — | 5.553 |
| Always SVG | — | 20.294 |

Prediction errors use all 722 accepted observations; choice work uses only the
259 density-equivalent pairs. Native export, host processing and synchronous
webview decode/mount work are summed. These are **not input-to-paint latencies**
and exclude IPC queueing, GPU/display completion and compiler work.

Always-PNG is already only about **0.129 ms from the measured rendering-work
oracle** in the comparable subset. The content model's net saving over it is
about 0.040 ms, concentrated in the slide deck. Leaving that one project out
turns the saving into a 0.075 ms loss. This does not support a meaningful general
benefit. It also does not settle the PNG/Auto default: below-density PNG and
zoom/refinement quality are deliberately outside this comparison.

Uncached feature acquisition across the accepted observations averages
**0.057 ms**, with a 1.070 ms maximum. The feature pass is inexpensive, but its
cost still matters when potential decision savings are this small. Cache reuse
across output-size changes and invalidation after source edits pass separate
checks. Enabling the counters preserves exact PNG and SVG payload bytes.

The main unresolved predictor is **whether an SVG update requires a full browser
replacement**. Across accepted observations, full SVG work has a 51.2 ms median,
versus 9.1 ms for SVG patches. In one two-column session, adjacent edits had
3,875/3,876 glyphs, the same 149 distinct glyphs and 296 text spans, yet work
jumped from 9.94 ms for a patch to 53.08 ms for a full replacement. Aggregate DVI
features barely distinguish those outcomes. Their patch/full status was not
used as a feature because it is known after export/patch construction.

A later-stage decision using actual patch availability before committing a full
browser mount is a more targeted next experiment. It must account for the SVG
export work already spent, possible PNG export/refinement, and switching costs.
That is a hypothesis suggested by this result, not a validated implementation.

[Compact evaluation and provenance](2026-11-06-render-cost-model.json) and
[sanitized observations](2026-11-06-render-cost-observations.jsonl) allow the
statistics to be reproduced without manuscript sources. Replaying the sanitized
observations reproduces all fitted models and held-out decisions exactly.

```sh
python3 scripts/profiling/render-cost-model.py \
  --observations docs/profiling/2026-11-06-render-cost-observations.jsonl \
  --output artifacts/render-cost-reproduced
```

## Protocol fixed before evaluation

Three ridge regressions are compared, with separate PNG and SVG fits:

- `constant`: an intercept and whether a same-codec page base is available.
- `scalar`: the existing vector complexity estimate, raster/physical pixel
  counts and base availability.
- `content`: glyph count, distinct font/glyph pairs, text spans, fonts, drawn
  paths, packed path bytes, raster/physical pixels, base availability and the
  increase in distinct glyphs since the previous observed page.

Counts/pixels use `log1p`; base availability is binary. The response is **native
export + host processing + webview mount/decode milliseconds**, not compiler or
input-to-paint time. Current encoded bytes, current patch success/size, current
timings and document identity are excluded from predictors. Actual full/patch
status is retained only for diagnosis. Feature extraction is timed separately.

Each whole project is held out in turn. Feature means/scales and coefficients
use only training projects. Within those projects, a second project-held-out
loop selects ridge strength from 0.1, 1, 10 and 100 by rendering-time MSE.
Each project has equal total fitting weight. No random split of neighboring
edits is used. Model tests change the outer held-out labels and verify that
neither fitted parameters nor inner parameter selection changes for that fold.
If several entries share a project or closely related manuscript, use
`--groups local-groups.json` to map their fixture IDs to one family. This corpus
has one measured entry per independent project.

Decisions compare against always-PNG and always-SVG. A regression selects PNG
only if predicted savings exceed both 3 ms and 20% of the smaller prediction;
otherwise it retains SVG. This margin is not a confidence interval. Report
project-balanced prediction error and regret against the cheaper measured codec.
Also charge the measured feature-acquisition pass to the scalar/content models
and show savings by project and sensitivity to leaving one project out. Charging
the full pass to the scalar model is conservative: a dedicated scalar-only pass
could be cheaper. These are forced-codec, steady-history
comparisons, **not a deployed switching-controller simulation**. In particular,
they do not establish the cost of discarding one codec's cache to switch to the
other during typing, or compare against a replay of current Auto.

Paired decisions must have the same compiled page counters and bounds. PNG must
meet at least 98% of physical display density; below-density PNG would need a
detail crop whose cost/quality is not represented by a base-frame timing.
Such observations can inform cost prediction but are excluded from codec-choice
regret. Native SVG eligibility and browser surface budgets remain independent
constraints. Missing partners, fallback MIME types, capped counters, hidden
sessions and absent cost observations are counted explicitly.

This is exploratory evidence from one machine and a small number of independent
projects. Multiple edits/repetitions do not turn those projects into hundreds
of independent documents. A model winning this experiment still needs broader
validation and an actual controller test before becoming a product policy.

## Instrumentation

The optional native environment flag `TEXPRESSO_PROFILE_FEATURES=1` adds numeric
`renderFeatures`, `featureMs` and `featureCached` fields to full-page image
headers. It analyzes the MuPDF display list, so imported PDF paths are included.
Fonts are counted up to 64; distinct font/glyph pairs use a bounded 8192-entry
hash table. Tracking-cap flags make saturation explicit. Images, source image
pixels, clip operations, groups and shades are also collected for eligibility
and future experiments; they are not all used as regression coefficients.
No text, font names or source paths are emitted in the feature fields.

Features are cached by immutable native content token, independently of codec
and viewport. Their acquisition runs before the `exportMs` timer and is reported
separately. The ordinary SVG eligibility preflight remains in native SVG export
time. The measurement adapter for the previously identified Beamer annotation
number bug remains enabled for both codecs. It repairs metadata syntax without
changing binary image bytes; it is not a production fix.

The frontend-only builder reuses the existing compact MuPDF and zlib-ng
libraries and the unchanged installed XeTeX worker. It validates dependency
versions/archive hashes and records source patch/config/runtime hashes. It does
not build the compiler, download dependencies, make Docker images or produce
ZIP duplicates. Intermediates stay under `native/.work/`.

## Corpus and reproduction

Local copies include seven independent projects: two conventional papers, two
ACM-style papers, a text/math slide deck, a paper with TikZ pie charts and a paper
with a TikZ election diagram. A dense imported-plot slide deck was preflighted
but excluded from paired rendering: its roughly 17,000 paths and 8,500 clip
operations already exceed SVG's eligibility budget. That is a PNG-only guard
case, not a statistical opportunity to choose unsupported SVG.

Source anchors were resolved through current-engine SyncTeX: the two graphical
paper pages are 1 and 2, zero based. Originals are untouched. Corpus preparation,
XeTeX adaptations and source/project hashes follow the
[private-corpus workflow](README.md#private-real-document-comparisons).
Private paths, copies and visual output are never uploaded.

Use a separate checkout of native `codex/render-cost-features` at `262c717` for
the opt-in instrumentation. The production submodule remains on the shared
engine; building this experiment must not change the release pin.

```sh
python3 scripts/profiling/build-feature-frontend.py \
  --engine-source /absolute/instrumented-engine-checkout \
  --dependency-config /absolute/existing/compact/Makefile.config \
  --base-bundle /absolute/existing/bundle \
  --work native/.work/render-features
npm run compile-tests
TEXPRESSO_BINARY="$PWD/native/.work/render-features/bin/texpresso" \
TEXPRESSO_PROFILE_FEATURES=1 \
node scripts/profiling/preflight-real-cases.cjs \
  artifacts/render-model/cases.json artifacts/render-model/preflight
```

The actual VS Code matrix selects PNG/SVG explicitly, excludes repetition zero,
and reverses codec order on alternate repetitions. Run the following twice,
sequentially: DPR 2 with widths `640,1100`, then DPR 1 with width `1100`.
DPR 1 is emulated browser scale on the same physical Retina machine.

```sh
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY="$PWD/native/.work/render-features/bin/texpresso" \
TEXPRESSO_PROFILE_FEATURES=1 \
TEXPRESSO_PROFILE_OUTPUT="$PWD/artifacts/render-model/measured" \
TEXPRESSO_REAL_CASES="$PWD/artifacts/render-model/measured-cases.json" \
TEXPRESSO_REAL_WIDTHS=640,1100 TEXPRESSO_REAL_DPR=2 \
TEXPRESSO_REAL_REPEATS=3 TEXPRESSO_PROFILE_CODECS=png,svg \
node scripts/test-integration.cjs --profile-realistic
python3 scripts/profiling/render-cost-model.py \
  artifacts/render-model/measured/sessions.jsonl \
  --output artifacts/render-model/model
python3 -m unittest discover -s scripts/profiling -p test_render_cost_model.py
```

Save sanitized observations, evaluation, runtime metadata and reproduction
details before deleting copied projects and large native traces. Keep only
representative local diagnostics for unresolved findings.

## Validation and source status

241 Node unit tests, five model tests and lint pass. Native count tests pass;
byte-for-byte PNG/SVG equivalence, content-cache reuse across resizing and cache
invalidation after source edits pass. The measured JS/assets remained identical
through both matrices, and all eight copied source-tree fingerprints remained
unchanged. The reused XeTeX worker hash is unchanged as well.

The native instrumentation is preserved as commit `262c717` on
`codex/render-cost-features`, based on the shared engine's `a33eded` commit.
The measured frontend source patch matches that commit exactly. The branch was
published during release preparation to preserve reproduction; it is separate
from the production engine pin. No production Auto classifier change is made.

Cleanup removed 185.0 MiB of copied private projects, full raw
traces, duplicate model output and the completed disposable profiling runtime.
About 3.1 MiB remains locally as four diagnostic sessions, private input
configuration and validation logs. Original projects, dependency caches and
existing working native bundles are untouched. The small frontend can be rebuilt
from the saved source commit and reproduction command.
