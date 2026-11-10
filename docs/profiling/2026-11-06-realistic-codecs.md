# Real-document rendering policy comparison

This study revisits the PNG/Auto default using real local papers and slides,
actual VS Code IPC, display-density checks and an experimental Auto policy.
Earlier synthetic results do not by themselves settle the default. The earlier
discussion favoring PNG after accounting for complexity was a judgment, not a
new measurement.

## Workload and provenance

The corpus contains a math paper with Palatino text, a Times two-column conference
paper, a text/math Beamer deck and a Moloch deck with dense imported vector plots.
The latter focuses an actual graphical slide, verified against current-source
SyncTeX (page 20, zero based). Original projects were read only. Copies excluded
stale `.aux`/`.toc`/`.nav`/`.snm` state and retained bibliography inputs; original
and prepared-source hashes identify adaptations.
The papers required explicit XeTeX metadata/font-encoding adjustments in the
copies. The decks were unchanged. A rejected paper also failed ordinary XeLaTeX;
LuaTeX-only emoji decks were excluded rather than silently stripping content.

The machine is an Apple M1 Pro with 16 GiB RAM and VS Code 1.145.0. The native
engine is the existing development bundle at engine revision
`8c8553ff574acb1905d6b17208ea026f40738b6f`, not the older local preview bundle.
Its executable SHA256 is
`6f9ee9f2b7dcd3da11fb5eaa8e6fa14a068f31326c3a8db5d851c54149ae6d32`;
worker SHA256 is
`0ba3ab4bd817f9a27baffbbffc9bcfb500d08deaf58faddeb959ed911db9a229`.
It uses zlib-ng 2.3.3, PNG level 2, MuPDF revision
`8ad45e92f0935d3d87f1db3f873086472a5e1b24` and TeX Live 2026.
There was no new native build or artifact download. The source checkout was
dirty; compact evidence records hashes of the executed JS/assets as well as
the native manifest. These results describe those runtimes, not an unchanged
published v2.0.0 installation.

Each cell starts a fresh native process. Repetition zero is excluded as warm-up;
subsequent repetitions reuse warm OS/font/package caches. Codec order reverses
between repetitions. The session includes a cold edit, eight paced prose/title
edits, a twelve-key 100 ms open-loop burst, undo, 100/125/200% zoom, two pans,
fit-width, next-page navigation and cached return. Source insertion uses
production DocumentSync, not physical keyboard dispatch. Edits within a session
are correlated; repetitions are the experimental units. Nearest-rank p95 is
descriptive at this sample size, not a confidence bound.

The initial matrix covers three documents, 640/1100 CSS pixel viewports, DPR 2,
PNG/current Auto and four repetitions. The follow-up adds the graphics deck,
uses 1100 CSS pixels, three policies and three repetitions at both DPR 2 and
DPR 1. DPR is checked in the webview. DPR 1 is an emulated browser display scale
on the same Retina machine, not a second physical display. Power settings and
per-session load averages are recorded; this was a working workstation, not a
controlled idle lab machine.

Two animation frames after a decoded update mark a paint opportunity, not GPU
completion or display scanout. Quality checks require an SVG surface, a raster
at display density, or a display-density detail tile covering the visible page.
They check geometry, not human-perceived quality. Settled visual samples are
local composites of the actual mounted surfaces, captured after timing. Native
task footprint is not whole-VS-Code or GPU memory. The harness retains frame
buffers, so extension-host memory is not an isolated product measurement.

## What the initial matrix exposed

Current Auto can be slower even on an eligible ordinary text page. In one
two-column session, patched SVG updates took about 3 ms in the webview, while
full SVG replacements took 52–75 ms. Their input-to-paint observations rose from
about 52 ms to 102–127 ms. This is a concrete rendering cost, not just compiler
latency or a claim based on encoded image size.

First-sharp-frame timing also overstates Auto's zoom advantage in some cases.
An existing SVG can remain sharp for the first frame, then be replaced by a
lower-density PNG before its detail tile arrives. The initial observer recorded
first sharpness only. The follow-up records sharpness transitions every 10 ms,
waits for foreground requests/upgrades to settle, and reports the last transition
to sharp if the final state is sharp. The observation window is bounded at
2.2 seconds from the action. If compilation delays the first visible frame past
that bound, the observer records that frame without a further refinement wait;
such navigation/focus observations cannot establish sustained quality. The
initial startup observation is likewise first visual only. Initial-matrix
first-sharp values must not be described as sustained sharpness values.

The existing 32 MiB/four-entry cache budget matters. A full portrait SVG surface
at 200% on DPR 2 can exceed the surface budget even when its encoded XML is small;
Auto then needs raster/detail fallback. Full-page vector output is not free of
browser raster memory.

## Experimental classifier

`edit-png-auto` exists only in the profiling harness. It retains production
Auto's native eligibility, measured-cost feedback and fallback guards. For
250 ms after a source change it asks Auto for its PNG path when either the
full PNG fits the existing four-megapixel cap or an SVG surface alone would
exceed the allocated surface budget. It also suppresses idle SVG promotion in
those cases. Otherwise it retains vector editing and idle upgrades. The activity
window is an experimental parameter, not a tuned optimum.

The intent is to avoid expensive vector replacements where raster already
provides sufficient resolution, while preserving a measurable SVG benefit where
raster needs refinement. This is a testable candidate, not a claim that a more
complicated classifier is automatically better.

The candidate's decision can change as the visible-page surface allocation
changes. In the two-column DPR 2 case, one measured repetition used PNG for the
paced edits, while another retained SVG and its costly full replacements. This
is precisely why request/frame validation and more than one repetition matter.
The candidate has not established that it removes the typing tail consistently.

## Results

**120 successful sessions**, including 36 warm-ups, leave **84 measured sessions**.
One additional failed attempt is reported separately below. Successful measured
sessions had no client decode/cache errors or hidden-page observations. One
baseline burst missed the cadence criterion and is excluded from burst latency
only. Baseline cells have three measured repetitions (24 paced edits); follow-up
cells have two (16 paced edits).

Initial DPR 2 typing, **p50 / p95 milliseconds**:

| Document | CSS width | PNG | Current Auto |
| --- | ---: | ---: | ---: |
| Math paper | 640 | 34.2 / 69.5 | 37.0 / 75.6 |
| Math paper | 1100 | 35.4 / 54.5 | 35.4 / 82.7 |
| Two-column paper | 640 | 48.4 / 56.2 | 53.5 / 125.0 |
| Two-column paper | 1100 | 50.3 / 58.0 | 54.5 / 127.7 |
| Text/math slides | 640 | 47.6 / 66.6 | 44.1 / 49.9 |
| Text/math slides | 1100 | 49.1 / 143.2 | 44.1 / 87.3 |

Follow-up typing at width 1100, **p50 / p95 milliseconds**:

| Document | DPR | PNG | Current Auto | Candidate Auto |
| --- | ---: | ---: | ---: | ---: |
| Math paper | 1 | 35.1 / 72.1 | 36.3 / 70.9 | 30.2 / 47.7 |
| Two-column paper | 1 | 53.2 / 91.9 | 57.6 / 138.8 | 49.9 / 76.0 |
| Text/math slides | 1 | 47.3 / 81.7 | 46.9 / 64.8 | 45.7 / 56.7 |
| Graphics slides | 1 | 393.1 / 462.1 | 410.7 / 521.2 | 404.5 / 440.9 |
| Math paper | 2 | 33.4 / 57.0 | 36.4 / 79.6 | 34.0 / 77.1 |
| Two-column paper | 2 | 50.4 / 53.4 | 69.0 / 118.4 | 52.8 / 116.3 |
| Text/math slides | 2 | 45.9 / 69.1 | 43.4 / 56.9 | 48.0 / 54.1 |
| Graphics slides | 2 | 574.1 / 602.6 | 585.0 / 1105.3 | 583.1 / 617.1 |

Time until sustained display-density sharpness at **200% zoom, DPR 2**, p50
milliseconds within the observation window:

| Document | PNG | Current Auto | Candidate Auto |
| --- | ---: | ---: | ---: |
| Math paper | 151.1 | 182.1 | 182.2 |
| Two-column paper | 150.3 | 196.1 | 165.6 |
| Text/math slides | 175.3 | 11.3 | 7.9 |
| Graphics slides | 1259.2 | 1249.2 | 1258.6 |

Current Auto lost and regained sharpness during the 200% transition in both
math-paper and both two-column repetitions. The text/math slide SVG stayed
sharp throughout. At DPR 1, the same zoom operation was about 6–41 ms for
PNG/current Auto on ordinary papers/slides; the larger Retina difference does
not apply uniformly to lower-density views.

The candidate improves the 1× typing tail in these cells, but its two-column
Retina repetitions still differ substantially: one uses PNG; the other retains
SVG and reaches a 116 ms paced-edit maximum. It also does not improve every
open-loop burst. This is evidence for continuing the experiment, not shipping
a universal replacement classifier.

Cold first-edit p50s are roughly 0.72–0.87 seconds on ordinary documents across
policies. The graphics case is about 0.4 seconds per warmed edit at DPR 1 and
0.6 seconds at DPR 2; native drawing/export dominates representative frames.

The graphics-deck next-page check exposes a further PNG quality gap: both DPR 2
repetitions end the 2.2-second observation with a fully visible page at about
0.87× display density and no detail tile. Current Auto shows that neighboring
page as a cached sharp SVG in roughly 7 ms. No detail native request appears
for the PNG page during that operation. The missing refinement needs separate
investigation; this is not evidence that PNG remains blurry forever. Dense-page
focus itself takes over 3.6 seconds to become visible, beyond the quality window,
so its initial low-density result cannot establish sustained quality.

The measurement adapter averages 0.016–0.108 ms per header across measured
cells; the worst observed header is 4.37 ms. All policies use it. This is extra
measurement work, not product performance or a native bug fix.

[Compact evidence](2026-11-06-realistic-codecs.json) includes per-repetition
typing distributions, frame costs, geometry checks, cadence exclusions, native
task metrics, source/project fingerprints and executed runtime hashes.

## Policy implications

Rendering format should remain a setting, rather than a preview-toolbar control.
**Retain the existing Auto default for now**, with PNG and SVG selectable in
Settings. PNG's better two-column typing tail is real, but PNG has a measurable
Retina zoom/refinement tradeoff and the next-page refinement gap needs diagnosis
before making it the general default. Cheap SVG supplies a useful quality
advantage, not merely a theoretical benefit. This changes the provisional PNG
choice made before the real-document quality checks.

Do not ship this experimental Auto policy as an improvement merely because it
wins some cells. A future revision should separate editing and gesture/idle
decisions, learn the cost of full SVG replacements as well as patches, consider
physical density and surface budgets, and avoid repeated quality regressions
while switching formats. Those are requirements suggested by observations, not
a validated universal classifier. Four documents on one machine cannot train
or establish one. The current experiment does not justify removing Auto or
declaring further Auto work pointless.

The dense imported-plot case also calls for native rendering work. Ordinary
title edits still redraw the expensive plot before producing tiny PNG patches;
representative export times were roughly 430–460 ms before webview decode.
Changing a codec classifier alone will not remove that shared cost.

## Failed attempt

One measured 1× PNG slide session stopped on its second paced edit. The trace
shows rollback to the edit fence, a fresh worker fork, then `[pass] failed` and
`[process] terminating process`. The preview reported that the document had not
produced a page; it did not recover within the 45-second source-generation wait.
There was no accompanying TeX syntax error in the retained trace. A fresh-process
retry of the same cell/runtime passed. The cause is unresolved; this observation
does not establish that PNG caused it. The failed attempt is retained separately
and excluded from successful latency samples, not counted as a latency win or
silently hidden by resumption.

## Independent compatibility finding

The native annotation writer uses MuPDF's compact PDF `%g` formatter for JSON
coordinates. Beamer destinations produced `"y":-.9999771`, which strict JSON
parsing rejects. This blocks the tested decks with the unmodified engine and is
independent of codec choice. The fault is in
`native/texpresso/src/dvi/dvi_annotations.c`; finite-value checks do not make
leading-dot numbers valid JSON.

All measured policies use the same **measurement-only** streaming adapter that
inserts a leading zero outside quoted strings. It reads the declared image
length and forwards binary bytes unchanged. Tests cover ordinary decimals,
exponents, quoted text and fragmented binary framing. Its measured header cost
is recorded separately. Production parsing and the native source are unchanged;
these slide timings are conditional on that adapter, not evidence that released
slide compatibility already works. A shared-engine fix should emit valid,
locale-independent JSON numbers and test fractional/negative destinations,
links and figure bounds.

## Reproduction and retention

See [the private-corpus harness instructions](README.md#private-real-document-comparisons).
The initial matrix uses `TEXPRESSO_REAL_WIDTHS=640,1100`,
`TEXPRESSO_REAL_REPEATS=4`, `TEXPRESSO_REAL_DPR=2` and
`TEXPRESSO_PROFILE_CODECS=png,auto`. The follow-up uses width 1100, three
repetitions, DPR 1/2 in sequential jobs, and
`TEXPRESSO_PROFILE_CODECS=png,auto,edit-png-auto`. Each local case explicitly
enables `normalizePreviewNumbers` for the adapter. Do not mix changed runtime
hashes in one output directory.

Private paths, manuscript sources, image captures and raw native annotation
payloads stay local. The compact evidence contains generic corpus IDs, hashes,
timings and runtime metadata. Preserve that evidence before removing copied
projects and redundant raw outputs. Representative visual comparisons may stay
in ignored `artifacts/` for local review.

After measurement, lint cleanup added statement braces in the test host, and
the provisional extension setting default was restored to Auto. Measured cells
select their codec explicitly; metadata describes the pre-cleanup runtime.
The experimental classifier remains confined to the profiling harness.

Validation: 240 unit tests pass, TypeScript/webpack compile, and lint passes
without warnings. Real VS Code preview assertions passed twice, including the
Auto default and live SVG/PNG setting switches. The first isolated acceptance
app required termination after its test host exited 0. The retry completed
normally with exit code 0 after a delayed shutdown; no cleanup signal reached
that instance. The test now explicitly discards its disposable untitled tab;
the shutdown cause is not established. The benchmark matrices exited normally
(apart from the separately documented failed attempt).

Cleanup removed 142.5 MiB of copied projects, redundant pixel samples and raw
traces. About 7.5 MiB remains locally: representative comparisons, four diagnostic
sessions, failure evidence, private reproduction configuration and validation
logs. The normal generated-output cleanup also ran with one-day retention.
Original projects and usable native bundles were preserved.
