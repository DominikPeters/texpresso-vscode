# Preserve queued detail while rendering neighboring pages

The earlier graphics-slide navigation sharpness gap is reproducible. A queued
high-resolution crop could be silently discarded when the controller rendered
another visible page. The browser retained its pending token and never asked
again. The base PNG remained at about **0.87× display density** despite an idle
renderer and a fully visible slide.

Visible base pages still take priority. The controller now preserves a queued
detail request across other-page renders. A replacement of the same page still
retires that request because its incoming image resets the browser's detail
cache. Source invalidation, cancellation and frame/decode credit rules remain
in force. This is a scheduling fix, not an increased raster or cache budget.

## Reproduction and result

The same private graphics deck as the earlier study, zero-based focus page 20,
next page 21, width 1100 CSS pixels, DPR 2 and forced PNG. Existing native engine
`8c8553ff574acb1905d6b17208ea026f40738b6f`; no native build. Separate before/after
directories prevent mixing runtime revisions. Only `out/preview-controller.js`
differs in the recorded production runtime hashes.

Before: one warm-up and one measured session both end the next-page operation
below display density, with **no detail frame** within the 2.2 s quality window.
After: one warm-up and two measured sessions all receive a detail crop at
**1.0× density**. The measured runs reach sustained sharpness in **776.9 and
770.4 ms**, with no decode/cache errors or hidden-page observations. Other
visible-page work precedes the crop; this does not make dense native drawing
instantaneous. It resolves the missing-request failure rather than establishing
a precise speedup ratio. Sample size is deliberately small for this targeted
correctness reproduction.

The new controller regression reproduces the failure before the fix: request
detail for the active page while a neighboring page owns decode credit, then
complete multiple visible-neighbor renders. The detail must eventually receive
credit and preserve its original token. It fails on the old controller and
passes with the fix. Existing tests cover stale source crops and purpose-specific
limits; the full real VS Code preview suite exercises crop ownership/lifecycle.

[Source-free evidence](2026-11-06-png-detail-queue.json) records the runtime and
input hashes, per-run next-page quality timeline, delivered detail frames and
visibility/errors. The graphics deck uses the existing measurement-only
leading-dot annotation-number adapter, unchanged between variants. This does
not establish unmodified-engine document compatibility.

To reproduce, prepare the graphics case through `real-corpus.cjs` and run the
document harness with a fresh output directory per runtime:

```sh
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY=/absolute/current/bundle/bin/texpresso \
TEXPRESSO_REAL_CASES=/absolute/private/cases.json \
TEXPRESSO_PROFILE_OUTPUT=artifacts/detail-after \
TEXPRESSO_REAL_WIDTHS=1100 TEXPRESSO_REAL_REPEATS=3 TEXPRESSO_REAL_DPR=2 \
TEXPRESSO_PROFILE_CODECS=png \
node scripts/test-integration.cjs --profile-realistic
```

Use the earlier controller to reproduce the missing detail, keeping the other
runtime files and native engine identical. Do not combine before/after timing
cells into one aggregate summary.

## Validation and cleanup

All 246 Node tests, lint, compilation and the native-backed real VS Code preview
regression suite pass. The four copied source-tree fingerprints remained
unchanged throughout the live and detail experiments.

After saving both compact reports, cleanup removed **55.12 MiB** of copied
projects, raw sessions/native traces and disposable memory samplers. About
115 KiB of private input configuration and validation logs remains locally.
`npm run clean:generated -- --apply` found no further eligible output. Original
papers/slides, dependencies and working native bundles are untouched.
