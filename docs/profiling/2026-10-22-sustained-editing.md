# Sustained editing in naturally flowing documents

The shared corpus in `scripts/profiling/varied-fixture.cjs` combines varied prose,
local `lipsum` text, aligned equations, numbered theorems and lemmas, proofs,
section headings, internal references/hyperlinks, and a moderate TikZ drawing
every sixth section. It has no explicit page breaks. This allows insertions to
move subsequent content across old page boundaries rather than preserving an
artificial one-section-per-page layout.

The standard corpus has 44 sections and produced 30 pages in local TeX Live
calibration. The larger, opt-in corpus has 145 sections and targets approximately
100 pages; the engine's observed complete count is authoritative. Both have
unique early, middle and late rendered anchors and named destinations. Helpers
resolve their current source locations after preceding edits, including UTF-16
and UTF-8 offsets. A Unicode comment before the anchors makes those offsets
different, even though the rendered document uses locally available fonts.

The shared finite plans insert 212 characters of prose/display math early,
287 characters of a subsection/theorem/proof in the middle, and 230 characters
of prose late, at fixed 100 ms intervals. Their scheduled durations are 21.1,
28.6 and 22.9 seconds. Input does not wait for compiler or paint completion.
The early phase includes navigation away after the sixtieth input and back
after the 130th. Supplemental steps paste an incomplete aligned calculation,
repair it, then undo exactly that pasted block while preserving all earlier
changes. Temporarily incomplete commands and environments are intentional;
temporary TeX diagnostics must be distinguished from an engine/process failure
and the final valid source must recover.

Generator tests verify deterministic content, natural pagination, distinct named
anchors, byte-offset conversion, finite typing durations, and exact undo source
restoration. They also reject ambiguous cursor markers or an undo whose expected
source tail has changed. They do not invoke TeX or compare timing.

The earlier [cursor-prewarming experiment](2026-10-22-prewarm.md) used nineteen
characters in a short rich document. These longer phases test sustained edits,
reflow and source/page ownership instead of extrapolating that result.

## Independent wrong-page reproduction

A small deterministic native test isolated a correctness bug before the sustained
timing runs. On engine `4919c95`, a pending source search for PDF page 25 survived
an insertion of 180 blank source lines. Those blank lines do not change the PDF
pagination, but the old numeric source line now referred to content on page 7.
The engine emitted that wrong page tagged with the **new** source sequence. A
host-side stale-frame check could therefore not distinguish it from a current
answer. The [original protocol capture](2026-10-22-routing-repro.json) retains the
exact old binary identity; its page indices are zero-based.

The new regression requires that the stale intent produce no forward result or
distant compiler demand after a source barrier. A new search at the updated
source line must then resolve once to PDF page 25. Separate regressions cover
canceling a pending search when the user navigates to a cached page, resolving
already available source records without compiling another page, and releasing
any superseded image request credit. This is correctness evidence, not a latency
comparison with the varied-document workload.

Automatic source following also previously treated each compiler flush as fresh
selection intent. A completed search can itself flush output, so that callback
could submit the same search again and keep the compiler/preview busy. The host
now records document/version, source line, source sequence and compiler revision
before sending. Repeated callbacks for the same intent are suppressed; edits,
real selection changes, new passes and explicit forward commands remain eligible.
A synchronous-recursion unit test exercises this feedback path without relying
on a timing threshold. Manual page navigation and wheel scrolling now suspend
late automatic source results until a new source edit/selection or explicit
forward command. Cancel-all also retires the host render credit immediately: the
native command cancels unfinished foreground renders without a retry reply, so
retaining their credit could otherwise stall replacement images. Continuous
webview acceptance exposed this additional cancellation case.

## Measured sustained runs

Both successful runs used native `3fbbd757d508039778f12c1cd201b28333768c43`
(binary SHA-256 `66d1d444670026181ecb05e1f310e6402e73081396202ceeb77d5aa4a936db17`)
and VS Code 1.143.0, with source-follow fixes in the working tree (the recorded
extension HEAD is the pre-change base). The later wheel-scroll and canceled-render
credit refinements were checked by the continuous webview acceptance suite. Each applied 732 real document updates: three long typing
phases, incomplete paste/repair, and an actual VS Code undo. The input driver
used `TextEditor.edit` per character and real selection/change events. macOS
background test windows can leave the core `type` command without a focused code
editor; two no-edit preflight attempts were discarded. These measurements cover
the production document/session/controller/webview pipeline, not keyboard input
latency or compositor presentation.

The endpoint requires a visible owning-page mount matching the current native
source target and revision, followed by two animation frames. Neighboring page
renders cannot complete the final-key measurement.

| Phase | Inputs | Nominal 30 pages, SVG: last input | 100 pages, Auto: last input |
| --- | ---: | ---: | ---: |
| Early prose/display math | 212 | 99 ms | 37 ms |
| Middle subsection/theorem/proof | 287 | 52 ms | 41 ms |
| Late prose | 230 | 99 ms | 42 ms |
| Incomplete paste, then repair | 2 chunks | 104 ms | 93 ms |
| Undo pasted block | 1 | 355 ms | 638 ms |

Final-key latency does not describe every pause. The 100-page Auto run's median
source-caught-up opportunities were 54/57/41 ms for early/middle/late typing;
their worst cases were 470/4197/190 ms. The approximately 4.2-second middle tail
starts at the opening brace of `\subsection{A statement inserted during live
editing}` and ends when its argument closes about 42 characters later. The
30-page run showed the same incomplete-heading pause, at 4.50 seconds. A heading
cannot be typeset completely before its argument is finished. All valid final
sources recovered; no user-facing preview errors or indefinite waits occurred.

The 30-page SVG run also took 2.43 seconds to show its first changed-source frame,
and late typing had a 1.02-second catch-up tail. Native stage profiling was not
enabled for that run, so its root/checkpoint counts are **unavailable**, not zero.
In 100-page Auto, profiling recorded zero root replays during typing/settlement
and 210/286/228 checkpoint rollbacks in the three long phases. One root replay
occurred during the early phase's preparation before typing began. These data
do not establish the cause of the 30-page initial pause.

All 100-page phases met the strict 20 ms scheduler-lateness criterion (maximum
6.5 ms). In the 30-page run, early/middle maxima were 36/142 ms: their total
21.10/28.60-second input spans matched the schedules, but the isolated late
inputs fail that strict criterion. Late prose met it at 8.6 ms. The two documents
and codecs therefore are not a controlled SVG-versus-Auto speed comparison.

## Page correctness and remaining opportunity

Two clean local XeLaTeX passes produced 31 pages after edits in the nominal
30-page case and 100 pages in the larger case. Standalone SyncTeX and independent
Poppler text pagination agreed with the actual visible preview for all six
probes: PDF pages 2/16/30 and 2/50/99. Middle and late targets remained on their
expected pages while commands/environments were incomplete. Early content
crossed the first-page boundary. This verifies the sampled completed source
locations rather than asserting that every transient layout is identical.

Forced SVG repeatedly encountered the continuous preview's budget fallback:
early typing received 260 SVG and 182 PNG headers, and late typing 412 SVG and
325 PNG headers; counts include neighboring pages and detail work. Middle typing,
with one visible sheet, received 241 SVG and only 2 PNG headers. The browser
accounts for SVG's rendered surface plus DOM nodes against the shared budget;
two visible sheets have a smaller allowance per page. The host then clears its
SVG rejection set on each source invalidation, allowing similar pages to retry
SVG and then PNG again. Remembering a budget rejection across minor edits,
scoped to viewport/allocation and a bounded page-complexity class, is a concrete
next optimization. It was **not implemented** in this pass, and the generic
fallback annotation alone does not distinguish every budget/decode cause.

The two-second final idle observations issued eight/six bounded preview,
preparation and neighbor requests, with zero new `synctex-forward` requests.
They did not recreate the automatic source-follow feedback loop.

[Compact measurements and independent-oracle proof](2026-10-22-sustained-editing.json)
retain exact source/PDF/tool hashes, target-page checks, cadence limits and timing
statistics. Full per-input/frame/protocol records remain in
`artifacts/profile-varied-30-svg/` and `artifacts/profile-varied-100-auto/`;
clean oracle logs are in `artifacts/varied-oracle-30/` and `artifacts/varied-oracle-100/`.

Reproduce with the local prepared engine and installed TeX Live:

```sh
npm run compile-tests
TEXPRESSO_PROFILE_OUTPUT="$PWD/artifacts/profile-varied-new" \
TEXPRESSO_PROFILE_PAGES=30 TEXPRESSO_PROFILE_CODECS=svg \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY="$PWD/native/.bundles/darwin-arm64-preview/bin/texpresso" \
npm run profile:preview:varied
```

Use a fresh output directory; choose pages 100 and codec `auto` for the large
case. Do not overlap profiling with builds or other benchmark jobs. The native
smoke driver is `scripts/profiling/varied-native.cjs`; its endpoint is native
frame receipt, separate from webview paint. It passed paste/repair/undo with one
worker launch and no kills. No large native timing matrix was run.

Final validation: 142 unit tests, lint/type checks, all 33 headless engine tests,
native C SyncTeX tests, actual VS Code preview acceptance, and VSIX payload
verification passed. Native windows remained disabled.
