# Compiler checkpoint coverage, 22 October 2026

This pass identifies a rollback fence that unnecessarily repeated an expensive
TikZ expansion after edits to prose following the figure. The fix keeps the
existing 64-byte alignment but removes the additional 64-byte look-behind.
It leaves the input buffering policy, checkpoint count limit, and macOS font
safety guard unchanged.

## What was happening

TeXpresso checkpoints XeTeX by forking at source-input READ boundaries. An edit
rolls back to a process that has not consumed changed bytes, then installs READ
fences to make nearer checkpoints for subsequent edits. A fence splits the next
READ before the affected source bytes and forks before delivering the rest.

Previously the nearest fence used `(changedOffset - 64) & ~63`. A one-line prose
edit just after a figure could therefore place its checkpoint *inside the
figure's repeated macro expansion*. Later edits restarted that expansion even
though none of its input had changed. Adding an unrelated first page moved
source byte alignment enough to trigger this behavior in the benchmark.

The new placement is `changedOffset & ~63`, still no later than the first changed
byte. Existing rollback trace bounds and READ truncation remain authoritative.
No changed input is provided to the process before its checkpoint. The alignment
retains some reuse for nearby edits; edits before the retained position still
roll back to an earlier process normally.

## Focused measurement

Local arm64 macOS, installed TeX Live, headless frontend, PNG output at width
800. A 21 by 21 TikZ loop draws circles and line segments, followed by a separate
curve and prose. All timings include source synchronization through receipt of
the complete native PNG, excluding browser rendering.

| Edit on second page | Previous fence, first edit | New fence, first edit | Previous warm median | New warm median |
| --- | ---: | ---: | ---: | ---: |
| Prose after figure | 894 ms | 847 ms | 511 ms | 19 ms |
| Curve inside figure, after the expensive loop | 1277 ms | 883 ms | 533 ms | 521 ms |

These are one independent session per cell and three warm edits per session.
The first-edit differences are noisy and are not evidence of an improvement.
The after-figure improvement is explained by retained compiler state:

- Previously resumed at token 7,279,278, before the expensive loop.
- Now resumes at token 52,377,700, after the expensive loop.
- Complete page progress was token 52,483,479.

The curve edit still lies in a 64-byte bucket that crosses the loop boundary.
Changing geometry *inside the repeated loop* must rerun that loop; it is also
covered by the regression harness. These are not general compiler acceleration
claims.

For the final fence-only confirmation, every warm image in both source states
was compared pixel-for-pixel against independent clean engines. The permanent
engine regression additionally checks that unchanged figure expansion is
retained after prose edits and changed loop geometry is rebuilt. It asserts
token coverage rather than machine-dependent timing limits.

Raw measurements, generated fixtures and compiler traces are ignored artifacts:
`artifacts/profile-checkpoints-baseline2/` and
`artifacts/profile-checkpoints-fence-only/`.

## Rapid startup recovery

Rapid-input profiling also exposed a separate correctness bug. If an edit
arrived while a new XeTeX worker had completed its handshake but had not yet
reported any input, the existing 10 ms stuck-worker safeguard could kill it
with trace length zero. Rollback kept that dead worker because its trace length
equaled the rollback target zero. The respawn path only launches when no process
is retained, so every later preview request reported zero pages indefinitely.

Rollback now discards dead workers as well as workers beyond its target. A
controlled startup-stall regression completes the protocol handshake without
issuing input queries, triggers an edit, and requires the replacement real XeTeX
to produce the latest source revision. No production test hooks or relaxed
process timeouts are needed.

A further error-ordering correction ensures obsolete preview requests receive
`preview-retry` before no-page errors are considered. An empty-document
regression verifies obsolete requests retry while current requests still
report a real no-page failure.

## Important remaining limits

- On macOS, the first automatic fork deliberately waits for DVI output to start.
  Loading a previously unused system font after a fork can fail. This pass does
  not relax that guard. First edits to short documents can therefore still need
  a full compile to establish adaptive checkpoints.
- READ checkpoints cannot interrupt an expensive macro loop that operates only
  on tokens already in memory. They help work *after* a completed figure, but
  cannot memoize a changed figure's internal expansion.
- The engine's source-input buffer is 1 KiB. A short file can be read entirely
  before later constructs are evaluated, leaving few initial READ boundaries.
  An experiment with 256-byte editor-input windows was removed because its
  separate benefit and IPC/fork overhead were not established.
- Token counts were misleadingly labeled milliseconds in old native debug
  output. They now say tokens. Real elapsed durations remain milliseconds.

With `TEXPRESSO_PROFILE=1`, stderr includes structured `compiler-checkpoint`
and `compiler-rollback` records. Checkpoints expose token progress, trace and
byte offset, checkpoint count, and whether the fork was requested by a fence.
Rollbacks expose previous/resumed token progress and trace lengths. They have
`request: -1` because compiler work can precede a preview render request.

## Reproduction

```sh
npm run compile-tests
TEXPRESSO_BINARY="$PWD/native/.bundles/darwin-arm64-preview/bin/texpresso" \
  node scripts/profiling/checkpoints.cjs artifacts/profile-checkpoints-new
```

The default matrix covers first and second pages, before-figure prose, geometry
inside the repeated loop, the final curve, and after-figure prose. Each case
performs a first edit plus three warm toggles, and validates both states against
independent clean engines. Select cases or add independent repetitions with
`TEXPRESSO_CHECKPOINT_PAGES=2`,
`TEXPRESSO_CHECKPOINT_SITES=loop,after`, and
`TEXPRESSO_CHECKPOINT_REPEATS=3`.

Use a fresh output directory. The harness uses local TeX Live, performs no
network downloads, and opens no native preview windows. Run measurements without
other builds or benchmarks competing for the CPU.
