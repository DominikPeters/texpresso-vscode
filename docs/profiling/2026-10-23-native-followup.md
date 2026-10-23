# Native checkpoint retention and responsive worker startup

Two native follow-ups retain useful edit checkpoints and keep the frontend responsive while its worker starts. The focused repair/undo checks pass, and the final combined 1,464-input PNG run passes both five-probe reference rounds. This report separates those results from bootstrap duration, memory accounting and the remaining compiler-side latency tails. See also the [source-page priority comparison](2026-10-23-source-priority.md).

## Retain the recently edited source prefixes

The existing checkpoint selection spreads retained compiler processes through a long document. That coverage is useful for navigation, but it can evict the prefix immediately before a source location the user has just edited or prepared for editing. Traversing a long suffix during a failed finishing pass can consequently make a small repair or undo replay a large prefix.

The focused baseline fixture demonstrates this failure: the repair rollback resumes at 1,971,923 tokens although a useful prefix had reached 12,984,533 tokens. The difference is approximately 11.01 million tokens. These are compiler-position observations from the fixture, not milliseconds or a universal amount of work per edit.

The accepted policy targets two recent primary edit/prewarm source groups inside the existing 32-entry retained checkpoint table. An anchor identifies a validated source-file/offset checkpoint; other retained processes continue to provide document coverage. A bounded predecessor fallback protects up to four existing snapshots for the two hot sites, rather than assuming one representative per group is sufficient. The focused repair/undo trial passes; the final combined-bundle identity and validation are recorded below.

Repeated checkpoints can represent the same source-file/offset group. Their roles are different:

- Group recency follows the newest refresh, so revisiting the same source site keeps it recent.
- The retained group representative is the earliest live ancestor, so it can resume before a later paste when that paste is repaired or undone.

Choosing the newest duplicate as the representative can preserve an attractive later compiler position while losing the ancestor needed to undo the change. Validation also found a second issue: resuming an exact checkpoint for repair can consume the earlier state needed by the subsequent undo. Keeping one apparently suitable anchor is therefore not enough to establish the policy. The candidate must preserve a valid earlier fallback without manufacturing an invalid checkpoint or changing the existing retained-table bound.

The focused case includes an incomplete theorem/math paste, failed finishing through a long suffix, repair and a large undo. It also exercises another source file and an earlier edit, which must still invalidate later checkpoints correctly. The focused predecessor trial passes both work-count and clean-output checks, as recorded below. Checkpoint retention and worker-startup responsiveness have separate regression coverage; both are present in the final combined bundle.

The policy selects existing snapshots and requests no new eager forks. The 32-entry figure describes the retained checkpoint table, not a hard total-PID or RAM ceiling: an already existing transient extra fork can occur before Q_CHLD pruning. Different checkpoint locations can retain different private/COW pages and resources. No claim about unchanged resident or physical memory follows from the retained-table bound.

## Keep editor commands responsive during worker startup

Previously the frontend waited synchronously for the worker's C02 greeting. A slow bootstrap could stop processing queued source edits, Pause/Resume and shutdown until the greeting arrived. This is distinct from how long the worker itself takes to initialize.

The startup state accumulates and validates the greeting incrementally. During pending startup, the frontend continues polling its normal inputs and requests a 5 ms SDL wait timeout only while startup is pending. The normal idle wait policy is unchanged. Fragmented greeting bytes and an immediately following first query must remain distinguishable; finishing the greeting while paused must not advance that compiler query.

The startup deadline is 120 seconds, measured with an unconditional monotonic clock. It must still work with profiling disabled. A private test-only override, `TEXPRESSO_TEST_STARTUP_TIMEOUT_MS`, is bounded to 50–120,000 ms and allows deterministic timeout coverage; it is not a user-facing tuning setting.

An incompatible greeting, EOF or timeout closes the failed channel and terminates/reaps the owned starting child. A child that ignores SIGTERM must not remain indefinitely. The frontend must keep accepting commands, avoid automatic respawn loops and permit explicit recovery. Stdin EOF must also cancel a partially greeted worker without waiting for the rest of the greeting.

This changes frontend availability during bootstrap. It does not claim that format loading, TeX initialization or the worker's greeting takes less time. There can still be synchronous operations elsewhere in compilation; their cost needs separate timing evidence.

## What the controlled-worker startup tests establish

The six controlled-worker tests check protocol behavior, not speed thresholds. Only the first two causally gate greeting release; the others check failure, cleanup, recovery or cancellation:

1. A delayed greeting is held behind a release gate. Source changes, Pause and the source barrier must be observed before the test releases the greeting.
2. A fragmented greeting uses the same gate and then coalesces its final bytes with the first query. The query is not processed while paused; Resume reads the newest unsaved source.
3. A timeout with profiling disabled produces one failure, terminates/reaps a child that ignores SIGTERM and permits one explicit replacement.
4. EOF during the greeting follows the same failure/recovery contract.
5. An incompatible greeting follows the same failure/recovery contract.
6. Stdin EOF shuts down and reaps a partially greeted worker before the gate is released.

The tests also assert that startup edits do not replace a healthy unread worker and that fragmented greetings are not mistaken for the ordinary SEEN stall watchdog. Passing these assertions demonstrates command handling before greeting release; it is not evidence of a particular millisecond improvement on every machine.

## Focused predecessor trial

The focused one-site regression reports:

| Operation | Resume token position |
| --- | ---: |
| Baseline repair | 1,971,923 |
| Useful expensive-prefix anchor | 12,984,533 |
| Candidate repair | 12,984,533 |
| Candidate undo | 12,984,532 |

The undo fallback is one token before the exact anchor, so it resumes from a valid earlier prefix. In this fixture it avoids discarding approximately 11.01 million tokens of useful prefix coverage. This is a work-position result, not a measured millisecond improvement.

The candidate undo PNG matches an independently clean engine. Different-file editing and an earlier root edit also pass the clean-output/invalidation checks. The accepted trial records three pruning events reducing 32 table entries to 5, 6 and 6 retained entries, with two existing snapshots reserved for this single hot site and its predecessor. Baseline pruning events retain 3 and 4 entries from 32. The event counts are not identical and these are fixture-specific selections, not a universal survivor count or memory comparison. Final source/binary identity is recorded below.

## Final runtime and validation

| Component | Identity |
| --- | --- |
| Clean native revision | `2010b9fec2c2450b4d06013544d5968d8605922b` |
| Verified native source digest | `b513b25af25f65ab572163c0fd9d28d92f4eb112c46e1bde9f70ecea7c99275c` |
| Frontend SHA-256 | `40d905780d70145eba44486059f5a85010b64ac67ac1549078e31a26213a049d` |
| Worker SHA-256 | `5f3cbd59e660b5ac23854134ab600c75cf04eb2aa9ef2b0e3a5d58fccc595bcd` |
| Compiled controller SHA-256 | `f5f566587ef1003fd0c18916c38c9e434a4e66b73ee0c3e252fee1dad4ebfacd` |

The complete combined candidate passes 57 native engine tests with zero failures/skips and seven C suites: checkpoint selector, protocol numbers, SVG, PNG, DVI strokes, annotations and SyncTeX. A final cleanup-only closed-entry guard/comment polish was rebuilt and passed all six controlled-worker startup cases again before the clean native commit. Actual VS Code preview acceptance, full lint and the production VSIX content check also pass. The canonical local demo bundle and ZIP now use the verified final native pair; the previous demo bundle is preserved.

TeXstudio independently validates the same shared revision: all 15 Qt suites, all 1,613 application checks, and the 30/100-page sustained corpus pass. Its new gated-startup, Stop/reaping and timeout/Restart cases pass without a production host API change. The sustained checks cover 1,464 edits and six independent source-page probes; these are correctness checks, not additional latency measurements.

Focused evidence is retained in `/private/tmp/txp-edit-anchors-baseline.log`, `/private/tmp/txp-priority-combined-engine-suite.log` and `/private/tmp/txp-priority-combined-c-suites.log`. Final actual-Code acceptance is logged in `/private/tmp/txp-priority-final-preview.log`.

## Complete long-workload regression

The final raw trace is `artifacts/profile-native-followup-long/varied-30-png.json`; its independent result is `artifacts/oracle-native-followup-long/result.json`. Both exit cleanly. The unchanged 30-page `long` scenario runs all 1,464 planned inputs, including dirty includes, prose/math/theorem edits, navigation, incomplete math/repair, undo/redo and controlled webview/engine recovery. Both five-probe independent two-pass XeLaTeX/SyncTeX rounds pass (10/10). Dirty-source replay bytes and hashes match both editor buffers at replacement. No phases are missing and the timeline does not overflow.

This is a combined regression and attribution check. It is not a controlled native-only speedup comparison with earlier runs, because the controller and native changes are combined. No additional run was used to search for a more favorable tail.

### Cadence, visibility and current commits

The harness's maximum-lateness rule is 20 ms. The middle phase reaches **20.832 ms**, exceeding that rule by 0.832 ms: its `validCadence` flag is false. Its observations remain in the report, but that phase is ineligible for clean cadence performance conclusions. All other phases pass their cadence flags; the early/include/late/include-return maxima are 7.00, 8.77, 2.48 and 5.09 ms respectively.

Strict commit latency is host receipt of an ACK for the owning source page, visible at browser commit and still matching the host source sequence and compiler revision at ACK receipt. It bounds commit latency; it does not establish compositor presentation. Invalid-source and deliberate manual-navigation intervals are excluded.

| Phase | Eligible strict ACKs | Median | p95 | Maximum | Cadence |
| --- | ---: | ---: | ---: | ---: | --- |
| Early prose | 156 | 30.9 ms | 80.7 ms | 452.4 ms | pass |
| Middle prose | 281 | 20.0 ms | 44.1 ms | 153.9 ms | **miss** |
| Included source | 304 | 25.4 ms | 45.8 ms | 74.1 ms | pass |
| Late prose | 212 | 24.2 ms | 45.4 ms | 165.3 ms | pass |
| Return to include | 297 | 26.3 ms | 51.2 ms | 93.6 ms | pass |
| Repair | 1 | 29.2 ms | — | 29.2 ms | pass |
| Undo | 1 | 32.9 ms | — | 32.9 ms | pass |
| Redo | 1 | 39.6 ms | — | 39.6 ms | pass |

No eligible interval crosses observed hidden exposure. One early-prose interval has unknown exposure under the conservative 150 ms maximum sample-gap rule. Its exclusion leaves 155 sampled-visible early inputs, median 30.9 ms, p95 70.4 ms and maximum 452.4 ms. Other eligible phases have no unknown exposure. The all-input observations above are retained.

Across owning commits, browser-local receive-to-commit is 1.4 ms median, 2.4 ms p95 and 17.1 ms maximum. Host post-to-ACK is 2.13 ms median. Commit-to-two-animation-frame observation adds 11.4 ms median; its maximum is 85.6 ms. A 169 ms browser long task appears near the transition into the return-to-include phase, so browser scheduling remains distinguishable from native work. These separate percentile samples are not added together as one hypothetical path.

### Undo retains the expensive prefix

In the final long run, undo rolls back from token position 26,545,016 to 25,862,703, a span of approximately 0.68 million positions. The earlier combined run recorded roughly 9.06 million positions of rollback for that operation. The focused fixture independently verifies the selection policy and clean output; the two complete runs are not a matched native-only timing experiment.

Undo input arrives at 163,706.109 ms. Its source target returns at 163,729.614 ms, the page-15 PNG header arrives at 163,736.018 ms (29.909 ms after input, including 5.647 ms export), and the current ACK follows at 163,738.973 ms (32.864 ms after input). The two-frame observer follows at 163,749.211 ms, after 43.102 ms. Repair has a 29.160 ms current ACK and 42.476 ms two-frame observation. These distinguish compiler progress, image production and browser observation rather than treating them as one render cost.

### A 452 ms compiler tail remains

The early maximum starts at input sequence 17, at 7,127.514 ms. Subsequent edits repeatedly resume near token 17,105,756. Compiler wait/budget bursts continue, including a 34.836 ms checkpoint fork; there is no worker handshake or convergence rerun in this interval. No page image is produced until sequence 21 at 7,576.872 ms, about 449.4 ms after the original input. It exports in 8.188 ms, receives its current ACK at 7,579.960 ms (452.446 ms), and is observed after two frames at 7,592.546 ms (465.032 ms). Browser receive-to-commit is 2.1 ms.

Thus preservation of repair/undo anchors does not remove every compiler replay/scheduling tail. The largest remaining interval is primarily before image production, not a 452 ms image decode. The exact causal contribution of OS scheduling versus compiler work inside these wall-clock bursts is not isolated by this run.

### Startup is responsive, not a faster bootstrap

The cold initial greeting still takes **1,406.8 ms** in this run. The prewarm greeting takes 173.4 ms, and later demand/convergence greetings take approximately 158.5–188.8 ms. These are different startup contexts, not a matched bootstrap-speed comparison. The implementation change lets the frontend process source/Pause/shutdown while a greeting is pending; the two causal release-gate cases establish that ordering directly.

## Recovery, process accounting and convergence limits

The controlled lost-ACK recovery takes 10.284 seconds, including its intentional ten-second watchdog. Explicit native replacement takes 1.366 seconds and replays both dirty editor buffers correctly. These are recovery exercises, not ordinary typing-latency samples.

Recorded settled checkpoints contain 3–16 live native tasks, zero zombies and no unknown process-status rows. RSS/physical-footprint sums include shared/COW pages and are not unique RAM or PSS. The retained-table bound and observed finite-session process counts do not establish unchanged memory use or hours-long stability.

The bounded 12-second whole-document convergence observation remains unverified because compilation ends at an on-demand 16-page prefix with `complete=false`. This is an existing observation limit, **not a new oracle failure**: all ten independent reference-page checks pass. Global auxiliary convergence, synchronous compiler operations and longer-session memory behavior still need their own evidence.

[Compact results and provenance](2026-10-23-native-followup.json) preserve the endpoints, cadence/exposure flags, rollback observations and validation scope.
