# Worker CPU, protocol waits and interrupted page publication

The new trace shows how modest native delays can become a gap spanning several keystrokes. In one visible 250 ms case, a slow fork and a low-CPU worker interval delay replay; the next edit arrives just after the page and its SyncTeX target are available, and invalidates it before an image is sent. Replaying the page again extends the gap. Browser receive-to-commit time is about 1 ms in this case.

There are also real CPU-heavy compiler intervals and a separate hidden-webview observation gap. These have different causes. This pass adds opt-in diagnostics and identifies a possible next scheduling change; it does not implement that change or establish a speedup.

## Scope and provenance

Two serial observations used the same 30-page flowing fixture, PNG, Fit Page and the `controlled-prose` phase: exactly 202 real editor edits scheduled 100 ms apart. One used unchanged native `2010b9f`; the other used a separate activity-instrumented bundle over that base, subsequently committed as `bd2d68f`. Both used controller runtime SHA-256 `f5f566587ef1003fd0c18916c38c9e434a4e66b73ee0c3e252fee1dad4ebfacd`. The canonical demo remains on `2010b9f`.

| Run | Native frontend SHA-256 | Maximum input lateness |
| --- | --- | ---: |
| Baseline | `40d905780d70145eba44486059f5a85010b64ac67ac1549078e31a26213a049d` | 5.816 ms |
| Activity | `eacb1ab3173da1beb36b909645191c1815f26ffc1930c994b9ab0465aff5b606` | 4.424 ms |

The measured activity worker SHA-256 is `d165b82b4a9393da3774ec71b0b4a9b1ca43ced30834757b6cd4e0c67bd033a7`; frozen native source digest is `39bf6fd65b78d62a30b1862a5c0b19507eae867ef7862962c49fb66f7019668c`. Its captured manifest records `2010b9f` plus dirty source; the later commit does not change the measured runtime bytes. Full manifests and hashes are retained in the [compact evidence](2026-10-23-worker-waits.json).

Both runs exited successfully, completed all inputs without timeline overflow, and passed their in-harness source probe. The diagnostic run records both profiling flags enabled and contains frontend, worker and main-loop activity rows. No external stack sampler was used. Diagnostic clocks, bounded logging and explicit request flushing add overhead; differences between these single runs are not a controlled estimate of overhead or improvement.

## Visible replay interrupted at page publication

The 250.381 ms interval starts at input sequence 39, index 37, after typing `A controlled comparison uses the same` on source line 43. Inputs 40 and 41 arrive during the interval. All relevant exposure samples are visible.

| Event | Host timestamp (ms) | Evidence |
| --- | ---: | --- |
| Sequence 39 applied | 7656.239 | Source edit |
| Rollback received | 7678.744 | 17,105,769 → 17,105,373 token positions; trace 477 |
| Child checkpoint acknowledged | 7736.487 | Parent 66117 → child 66258; 46.431 ms frontend fork round trip |
| Sequence 40 applied | 7759.310 | Next character |
| Sequence 40 page/forward target available | 7856.646 | Page 1 SyncTeX target; two-page prefix reported |
| Sequence 41 applied | 7857.046 | 0.400 ms after that target notification |
| Sequence 40 display list received | 7858.978 | Page 1 list built; no image header follows |
| Rollback received | 7859.149 | 17,574,080 → 17,105,769: 468,311 token positions discarded |
| Winning sequence 41 image header | 7904.469 | Page 1, revision 79; raster export 3.905 ms |
| Current visible commit ACK | 7906.620 | Browser receive-to-commit 1.3 ms |

There are two actual rollbacks in the interval. The intervening edit can update input before it is consumed without forcing another rollback. The final edit replaces genuinely advanced work: the previous page had reached shipout/SyncTeX and display-list creation, but no corresponding pixels were sent. Thus three keystrokes do not imply three complete replays, and the trace does support interruption amplifying shorter delays into a longer visible gap.

Direct timing separates the frontend's fork round trip from the worker's `fork()` call:

| Exact native span | Wall | CPU | Meaning |
| --- | ---: | ---: | --- |
| Worker 66117, fork → 66258 | 34.252 ms | 0.429 ms | Parent `fork()` call, native time 615388482.398–615388516.650 |
| Worker 66258, query 2, SEEN | 23.361 ms | 1.699 ms | Work before that query, native time 615388535.444–615388558.805 |
| Frontend poll for parent query 1319 | 20.707 ms | 0.010 ms | Overlaps fork/child delivery |
| Frontend poll for child query 2 | 14.203 ms | 0.014 ms | Overlaps worker work |

The two worker spans are disjoint, but they explain only part of 250 ms. Polls overlap worker execution and must not be added as another independent cost. The fork timing includes the library wrapper around the system call. Wall minus CPU also includes external work and I/O; it does not isolate OS descheduling.

The exact native rollback-start to final image write is 225.771 ms. Compiler-burst intervals cover approximately 206.402 ms of the 250.381 ms host interval; the remaining 43.979 ms includes input/rollback handling, the discarded display list, final display-list/raster export, browser work and unclassified gaps. The largest uncovered region is 23.199 ms around the first rollback/resume. Native-to-host boundary alignment uses a nearby minimum receipt offset, so these enclosing coverage figures are approximate, not calibrated one-way transport measurements.

SDL idle is not the main cause here. The overlapping idle buckets contain 76.766 ms, but their identified maxima of 32.275 ms and 41.922 ms lie wholly outside the interval. At most 2.569 ms of the remaining bucket total could fall inside it. Aggregate windows cannot assign every remaining millisecond to a specific operation.

A concrete next experiment is to publish an already completed page before a subsequent source edit invalidates it, while preserving revision ownership and prioritizing the newest work. This could reduce gaps caused by discarding a nearly ready image, but its correctness, visual tradeoffs and benefit remain untested.

## CPU-heavy and low-CPU work are both present

The initial visible 258.280 ms tail has actual compiler work. Exact correlated worker spans include APND query 1152 at 11.543 ms wall / 11.321 ms CPU, APND 1192 at 16.827 / 12.374 ms, and SEEN 1236 at 13.565 / 12.340 ms. These three spans are wholly within the tail and total 36.035 ms CPU.

A larger worker bucket reports 429 work spans, 206.889 ms wall and 160.122 ms CPU over 232.258 ms. It overlaps only 175.766 ms of the tail and begins approximately 56.492 ms before the input. Its CPU cannot all be assigned to the tail or apportioned by wall-time overlap.

Elsewhere during visible typing, worker 66285 query 7 APND takes 36.606 ms wall but only 1.809 ms CPU; the matching frontend poll is 36.829 ms / 0.008 ms. This locates elapsed delay on the worker side of that exchange, without identifying the internal routine or whether external work or descheduling dominates. Other SEEN work is CPU-heavy, for example 30.931 ms wall / 24.570 ms CPU. Frontend answer/read/flush costs are generally smaller in the observed maxima; no single socket timeout explains all cases. A 367 ms worker read occurs after typing ends and is not evidence of a typing stall.

## Visibility explains the separate one-second endpoint

The diagnostic run becomes hidden at host 17669.152 ms and visible again at 18669.017 ms. Native rendering and hidden browser commits continue: sequence 141 has an image header at 17926.889 and a hidden commit ACK at 17932.763 ms, followed by sequences 142–148. A hidden heartbeat reports 0.4 ms lag and no long tasks. No intentional native suspension is observed.

The strict *visible* endpoint excludes those hidden commits and credits sequence 149 at 18702.281 ms, producing a 1,043.784 ms result for input 139. That is retained in all-input results and identified as hidden exposure; it is not a one-second visible engine freeze. The visibility transition precedes most of the observation gap. The early native delay across several edits is still real, but does not explain the whole one-second endpoint.

| Strict current visible ACK endpoint | Baseline median / p95 / max | Activity median / p95 / max |
| --- | --- | --- |
| All 202 inputs | 33.925 / 70.170 / 290.352 ms | 32.956 / 258.280 / 1,043.784 ms |
| Sampled-visible exposure only | 33.925 / 69.615 / 192.291 ms (201 inputs) | 32.833 / 69.588 / 258.280 ms (189 inputs) |

Baseline exposure counts are 201 sampled-visible, zero hidden and one unknown initial interval; activity counts are 189 sampled-visible and 13 hidden. The unknown baseline maximum is retained. Its ending patch has zero bytes, illustrating that strict source catch-up and changed pixels differ. Both final newlines produce no-op patches. Open terminal pixel-progress intervals are censored; deliberate post-typing waits are separate. ACK and two animation frames are observations, not compositor presentation.

## What the older 450–500 ms traces establish

Both older spikes type ordinary prose at the same early source region. Nearly all latency precedes the native image: 449 ms of the 452 ms case and 495 ms of the 498 ms case. Compiler-burst unions cover 324.975 ms of a 443.738 ms native core, and 385.309 ms of a 492.133 ms core respectively. Their largest uncovered gaps between bursts are 36.680 and 29.925 ms.

The existing 50 ms process sampler shows limited observed CPU during those gaps:

| Partial process accounting | Older 452 ms gap | Older 498 ms gap |
| --- | ---: | ---: |
| Interior sample span | 403.929 ms | 397.984 ms |
| Frontend / observed worker CPU | 4.463 / 36.781 ms | 4.999 / 24.981 ms |
| Bracketing sample span | 509.986 ms | 528.277 ms |
| Frontend / observed worker CPU | 18.114 / 46.755 ms | 10.172 / 50.319 ms |
| Newly forked children absent from samples | 3 / 10 | 4 / 12 |

These are partial totals, not CPU-utilization estimates. Terminated workers lose CPU after their last sample, or their entire lifetime if never sampled. Stable PID deltas and proven new births are handled separately; cumulative group totals cannot be subtracted across changing workers. The sampler's Mach conversion was checked independently: a 150.013 ms process-CPU loop gave 150.012708 ms from the raw usage counters and 150.010 ms from getrusage. The old observations motivate the new wait/fork diagnosis but cannot retroactively prove its exact cause.

## Logging limits and validation

The activity run captures 527 frontend, 573 frontend-loop and 3,871 worker diagnostic rows. Deduplicating `dropped` by actor/PID/window reports 13 frontend and 249 frontend-loop suppressions/failures, zero worker. The counter combines capped slow spans and failed/truncated writes, so these are not all lost I/O records; aggregate counts and maxima remain available. Of 636 forked children, 201 have no worker aggregate row. Killed work can end before a flush, and the harness saves raw data before session disposal, so shutdown terminal windows are absent. Complete run-wide CPU attribution remains unavailable.

The native controlled C02 activity test passed, including CPU/sleep separation, delayed payloads, fork parking/resume, ordinal matching, default-off behavior and bounded accounting. All 57 native engine tests passed. Harness compilation and lint passed; the production controller byte hash is unchanged. No scheduler production change or external stack sampling was included. This focused pass used in-harness source probes; it did not add another independent page-oracle run.

Raw observations: `artifacts/profile-worker-latency-baseline-prose-202/varied-30-png.json` and `artifacts/profile-worker-latency-activity-prose-202/varied-30-png.json`. [Machine-readable evidence](2026-10-23-worker-waits.json) preserves manifests, strict metrics, exposure counts, token transitions, exact spans and accounting limits.
