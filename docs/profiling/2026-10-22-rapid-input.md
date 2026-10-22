# Overlapping input and source-to-paint responsiveness — 22 October 2026

The `rapid-e2e` scenario drives the production controller, native engine and PNG
canvas/SVG DOM renderers through actual VS Code webview IPC. Unlike the earlier
paint-paced scenario, it sends a finite input schedule independently of whether
compilation or rendering has finished:

- Twelve letter insertions at 100 ms intervals (10 keystrokes/second).
- Twelve backspaces at 100 ms intervals, returning to the original source.
- For TikZ, eight control-point changes at 125 ms intervals (8 changes/second).

The first burst starts after the initial preview and its idle refinement. Each
burst finishes only after a frame matching the final acknowledged source
sequence reaches a paint opportunity. A further 700 ms idle observation window
records Auto refinement. No input waits for the preceding input's paint.

Every input records its intended and actual browser timestamp, its acknowledged
native source sequence, and the first exact-sequence or later caught-up frame.
Reports retain input timer lateness, bytes, intermediate frames, source staleness
at paint, coalesced source versions, last-input-to-final-paint latency, and idle
SVG refinements during/after input. Native stage traces and process memory use
the existing harness. These are paint *opportunities* measured by two animation
frames, rather than OS compositor traces. A decoded frame superseded before that
opportunity or canceled before mounting is excluded from visible frame counts.

Reproduce with the installed VS Code and existing local TeX Live/native bundle:

```sh
npm run compile-tests
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY="$PWD/native/.bundles/darwin-arm64-preview/bin/texpresso" \
TEXPRESSO_PROFILE_SCENARIO=rapid-e2e \
TEXPRESSO_PROFILE_OUTPUT="$PWD/artifacts/profile-rapid-vscode" \
TEXPRESSO_PROFILE_PAGES=1 TEXPRESSO_PROFILE_KINDS=dense,tikz \
TEXPRESSO_PROFILE_CODECS=png,svg,auto TEXPRESSO_PROFILE_REPEATS=2 \
node scripts/test-integration.cjs --profile-auto
```

Use a fresh output directory. Raw rows/frames/inputs/phases are saved in
`browser.jsonl`, alongside fixtures and metadata. The HTTP/SSE production-browser
bridge also supports `TEXPRESSO_PROFILE_SCENARIO=rapid-e2e` with the same input
script; actual VS Code avoids that bridge's network round trips.

```sh
node scripts/profiling/rapid-summary.cjs artifacts/profile-rapid-vscode/browser.jsonl
```

A source version counted as coalesced may have contributed to compiler work but
never reached its own visible frame; that is expected for fast input when
compilation is slower than the input interval. `caughtUpPaintMs` includes waiting
until a later source version becomes visible, whereas `lastKeyToPaintMs` measures
how quickly the preview catches up after input stops. `staleAtPaint` counts new
paint opportunities for a source older than the latest input already issued by
the browser; it does not count every display refresh of retained old pixels.

## Initial failure discovered

The new scenario exposed a failure absent from paint-paced tests. Three fresh
baseline dense-page runs failed to catch up after the first burst. A fourth
focused run happened to succeed; this is a scheduling race, not a uniformly slow
render path. Protocol capture shows *current*, matching request revision/sequence
pairs receiving a completed zero-page state, followed by the no-page error.
The preview stayed stuck after typing stopped.

The native debug trace contains `worker might be stuck, killing`, rollback to
position zero with an empty trace, then `No fences, assuming process finished`.
Each later change remains in that zero-page completed state. Merely suppressing
errors from obsolete requests cannot fix this matched-state failure. The saved
request/state trace and partial browser results distinguish it from missed or
coalesced intermediate inputs.

## Active-window measurement controls

A first twelve-session rerun on the repaired engine completed without errors or
stalls, but some SVG sessions had browser timers clamped to one second. Those
bursts did not have the requested cadence, so their apparent coalescing and codec
latency differences are excluded from performance comparisons.

The profiling launcher now disables renderer backgrounding, background timer
throttling and occluded-window backgrounding for profiling runs only. These are
verified [Electron switches](https://www.electronjs.org/docs/latest/api/command-line-switches)
and [Google Chrome tooling switches](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md).
Every phase records document visibility and focus at input, dispatch, paint and
phase boundaries, plus visibility transitions. Focus is informative: typing in
the source normally leaves the preview unfocused. Hidden documents invalidate an
active-paint comparison. A phase is also excluded if any input timer is more than
20 ms late, or if its actual input span exceeds its requested span by over 20%.
The summary reports valid/excluded session counts and never pools unvalidated
older recordings into codec comparisons.

Actual background SVG upgrades are identified by the controller's `inFlight.upgrade`
flag. PNG `refining` means that a later SVG is eligible and is not itself an
upgrade. For recordings made before that explicit flag was added, the summary
recovers Auto's background `preview-svg` request IDs from protocol traces.

## Final validated results

Native revision `140b9ca` includes the compiler-fence correction, export timing,
obsolete-request retry ordering, and dead-root recovery. Twelve fresh VS Code
sessions cover dense text/TikZ × PNG/SVG/Auto × two repetitions. Every one of the
30 phases passed cadence and visibility validation, with zero preview errors or
stalls. A further four Auto sessions cover early typing below; all ten of those
phases passed too. Maximum timer lateness across the sixteen sessions was 5.6 ms.
[Compact measurements and per-session latency samples](2026-10-22-rapid-input.json)
are committed alongside this report; large raw traces remain in ignored artifacts.

Median last-input-to-final-source paint opportunity, milliseconds. Both fresh
sessions are measured; each cell has only two independent samples.

| Fixture | Mode | Insert 12 letters | Delete 12 letters | Change 8 coordinates |
| --- | --- | ---: | ---: | ---: |
| Dense text | PNG | 151 | 43 | — |
| Dense text | SVG | 31 | 45 | — |
| Dense text | Auto | 35 | 44 | — |
| TikZ | PNG | 1334 | 935 | 963 |
| TikZ | SVG | 989 | 903 | 1392 |
| TikZ | Auto | 963 | 885 | 916 |

Insertion is the first edit after startup and exposes checkpoint/startup
variance. Backspace follows the first burst and its idle settle. Dense PNG's
insertion samples were 265 and 37 ms; TikZ SVG's coordinate samples were 920 and
1865 ms. Those ranges are too wide to infer a general codec ranking from two
sessions. Warm dense backspace is consistently around 43–45 ms across modes.

Every TikZ typing/backspace burst coalesced eleven of twelve input versions, and
every coordinate burst coalesced seven of eight. Only the final version became
visible, roughly another second after typing stopped; compilation dominates.
The final coordinate toggles return to the original source and need zero image
payload bytes, yet still require substantial compiler work. This is a concrete
future target for compilation/checkpoint or exact-source reuse, not further
image transport compression. The twelve-session matrix had one intermediate
paint opportunity for already superseded source, in a dense PNG backspace burst;
all final source versions arrived correctly. There were no background SVG
upgrade requests during or after the settled Auto bursts.

### Typing before Auto's idle upgrade

Set `TEXPRESSO_PROFILE_RAPID_EARLY=1` to begin the first typing burst 80 ms after
the first PNG paint, before the normal 350 ms idle upgrade. The follow-up uses
dense/TikZ × Auto × two repetitions, retaining the same input cadence and exact
final-source checks. It captured the latest UI adjustment: normal status banners
are hidden and the format option is always exactly `Auto`. Both DOM assertions
passed at every measured paint in all four production webviews. The twelve-mode
matrix above preceded that UI-only adjustment.

There were **zero background SVG upgrade requests during typing**. All four
first bursts requested their upgrade only after the final source sequence. Three
upgrades reached a visible SVG paint in the idle observation window; the fourth
native SVG was not sent to the webview. This distinguishes attempted background
work from successfully displayed refinements. Input remained on the PNG path
while its pending first upgrade was deferred. Early input can force cancellation
and restart before checkpoints are established: last-key catch-up was 1.13/1.69 s
for the two dense runs and 0.97/1.38 s for TikZ. This startup case is a compiler
responsiveness opportunity, even though idle SVG work correctly stays out of the
input burst.

To reproduce the focused follow-up, add `TEXPRESSO_PROFILE_RAPID_EARLY=1` and
`TEXPRESSO_PROFILE_CODECS=auto` to the command above, using a fresh output folder.
The completed matrices left no owned native viewer or memory sampler running.
