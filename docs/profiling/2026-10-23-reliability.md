# Sustained editing and rendering reliability

The final 147-second VS Code session completed all 1,464 inputs, actual undo/redo
and both recovery injections. Both independent five-probe oracle rounds passed.
The test exposed and verified a native fix for extensionless includes bypassing
unsaved editor buffers; after it, included-source edits changed the rendered
surfaces and the previous one-page source-target mismatch disappeared.

## Implementation

- Retain the prewarming fence through a real trace-zero rollback.
- Preserve SVG allocation decisions across edits. Retry after changed physical
  allocation or sufficiently simpler content; distinguish decode failures.
- Classify finishing passes as successful, failed or cancelled. Failed auxiliary
  output cannot replace the last successful state.
- Reuse unchanged compiled pages; the [page-cache report](2026-10-23-page-cache.md)
  contains separate cache measurements and constraints.
- Identify/cancel source searches and validate exact int32 protocol counters, so
  stale requests cannot acquire current-source identities.
- Bound webview/engine recovery and replay unsaved root/include buffers. Reload
  rotates document nonce/instance because the editor ignores identical HTML.

The native worker also avoids restarts for unread-input changes, reaps direct
children and checks worker compatibility. Extension lookup now resolves
`\input{chapter}` through the editor VFS as `chapter.tex`, recording its reads and
changes, instead of opening the local fallback directly. Four native regressions
cover stream/filesystem modes with different disk contents or no disk file,
check actual changed PNGs, require warm output to equal a fresh compile, and verify
SyncTeX plus recovery replay (`src/test/engine/virtual-input.test.ts`).

The browser displays monotonically newer foreground frames while typing
continues, with stale links/inverse SyncTeX/magnifier/targets disabled. Navigation,
zoom, hide and replacement retire pending decoders. Newer same-page targets
survive delayed old frames; obsolete decode failures cannot poison current pages.

## Final full session

| Phase | Exact input paints / inputs | Last input → current frame | Longest strict current-frame gap | Cadence valid |
| --- | ---: | ---: | ---: | :---: |
| Early | 275 / 276 | 50 ms | 120 ms | Yes |
| Middle | 273 / 281 | 43 ms | 869 ms | No |
| Included | 303 / 304 | 52 ms | 181 ms | Yes |
| Late | 301 / 302 | 48 ms | 81 ms | Yes |
| Included again | 289 / 297 | 72 ms | 635 ms | No |

All observed browser samples were visible, with no native root rollbacks or
visual epoch regressions. Cadence requires maximum lateness ≤20 ms and total
input span ≤120% of schedule. Middle/included-return maximum lateness was 65/22 ms;
other typing phases stayed below 3 ms. Incomplete-syntax repair, actual undo and
redo produced current frames in 80/254/76 ms.

Valid-source strict latency median/p95 was 69/102 ms early, 43/77 middle,
52/72 included, 47/63 late and 54/87 included again. The accepted owning page must
match native sequence/revision, followed by two animation frames: a paint
opportunity, not compositor presentation. Unfinished syntax and deliberate manual
navigation are excluded from progress gaps.

Encoded-surface progress is separate from source epochs. It follows the visible
native source target by generation/sequence, even when the toolbar centers on an
adjacent page, and compares only matching page/mime/bounds/pixel dimensions.
Included-return now made 246 comparable encoded changes versus one before the
include fix; its changed-epoch gap fell from 30.65 seconds to 843 ms. Across the five
phases changed-epoch gaps were 884/869/861/851/843 ms. Those are encoded changes,
not OCR proof that every letter appeared; a resized raster alone cannot qualify.

Both initial and post-wait oracle rounds passed 5/5 probes against exact preserved
root/include buffers, clean two-pass XeLaTeX, standalone SyncTeX and extracted
PDF text. The middle phrase now resolves to native page 16/PDF 17, matching the
independent oracle; before the fix both rounds selected native 15/PDF 16. The final
clean document has 32 pages. Page-set checks validate mapping and visibility;
the separate native regression verifies actual rendered text through PNG equality.

The bounded 12-second convergence check remained unverified because the current
native state was an incomplete on-demand prefix. The second round is explicitly
a post-wait observation, not proof of idle auxiliary convergence. Its passing
verdict does not erase the retained pre-fix failures.

The production ten-second lost-ACK timeout reloaded and painted in 10.17 seconds.
Explicit engine replacement took 1.39 seconds, preserved both dirty source hashes,
and accepted another included-source edit. This tests the replacement mechanism;
actual-command integration tests cover automatic restart policy/retry limits.

Comparable settled checkpoints had 2–24 native tasks, all with known status and
no verified zombies; the final checkpoint had 8 tasks. Summed footprint ranged
219–445 MB and ended at 256 MB. Browser cache stayed below 32 MiB and shells below 12.
These are shared-process task sums, not deduplicated RAM/PSS; browser counters
omit GPU allocations. Retained profiling logs confound host-heap leak inference.
Checkpoint preparation does not guarantee auxiliary work is idle.

## PNG, SVG and Auto

The earlier matched native pair (`41c6d079`) ran identical 202-character root-only
prose edits for PNG/SVG/Auto, then 25 forced-boundary edits. The include-path fix
does not affect this root-only scenario, so that matrix is retained separately.
All three independent clean oracles passed. PNG cadence passed; SVG/Auto failed
maximum lateness at 42/27 ms. This finite pass is descriptive, not a statistical
codec ranking.

| Codec | Strict median / p95 | Last input → current frame | Native export median | Comparable encoded changes |
| --- | ---: | ---: | ---: | ---: |
| PNG | 78 / 111 ms | 77 ms | 8.82 ms | 254 |
| SVG | 176 / 353 ms | 83 ms | 3.55 ms | 148 |
| Auto | 95 / 129 ms | 63 ms | 9.38 ms PNG | 253 |

SVG exported faster but had higher observed complete-path latency here. Compiler,
allocation and browser work matter beyond export time. Maximum changed-epoch
gaps were 815/773/829 ms for PNG/SVG/Auto, with no regressions. An initial summary
incorrectly used the toolbar page and omitted the edited adjacent page; this was
a profiler bug, corrected from existing raw data with explicit regression tests.
It was not stalled codec output.

The 25-edit Fit Width boundary phase deliberately suspended source following;
it tests fallback retries rather than source-follow latency. All codecs met
cadence, made no repeated in-window budget rejections, and settled to 4–6 bounded
commands in the following two seconds. All comparison launches exited cleanly.

## Acceptance, diagnostics and provenance

Actual installed-Code acceptance passed held-decode source barriers, inert stale
interactions/current restoration, navigation/zoom/hide retirement and newer target
ownership. Startup, SVG/PNG patches, continuous scrolling, shared magnifier/detail
ownership, native unsaved editing and hide/restore passed too. Log:
`artifacts/monotonic-preview-final2-acceptance.log`. The final verification also
passed 175 unit tests, 49 headless native engine tests and 6 C checks, plus compile
and full ESLint. Production VSIX/content checks and actual packaged-Code
integration also passed (exit 0): dirty root/include recovery, the two-retry limit,
Stop races, no automatic retry for TeX errors, rename/external edits, streaming,
multiple roots and failed-start recovery. Packaged log:
`/private/tmp/txp-reliability-final-packaged-code.log`.

The first new-binary launch exceeded the old three-second capability timeout and
was incorrectly classified as unsupported, before any inputs. The preserved
preflight failure is `artifacts/profile-long-input-fix-final`; the successful
full retry used the same warmed binary and old timeout. The production follow-up
increases the bounded probe to ten seconds and reports a timed-out launch with
a retry message instead of “unsupported.” Actual 3.5-second executable and mock
timeout regressions failed the old implementation and pass the fix. This change
occurs after measurements and does not change normal rendering.

The [compact snapshot](2026-10-23-reliability.json) retains earlier failures and
hashes rather than replacing them with passing results:

- C01 exposed root replay starvation and 31.51-second progress gaps; C02 removed
  those restarts. Raw: `profile-long-final`, `profile-codec-final`,
  `profile-long-c02`, `profile-codec-c02` under `artifacts/`.
- A same-native SVG retest reduced idle budget rejections 66→0 and commands 99→4 by
  keeping decisions for an unchanged SVG physical allocation despite PNG base
  width changes. Raw: `artifacts/profile-svg-fallback-fixed`.
- Pre-include-fix full evidence retains its 30.65-second included content gap and
  both 4/5 oracle rounds: `artifacts/profile-long-visual-final` and
  `artifacts/oracle-long-visual-final`.
- Final full: `artifacts/profile-long-input-fix-final2` and
  `artifacts/oracle-long-input-fix-final2`. Codec matrix/oracles:
  `artifacts/profile-codec-visual-final` and `artifacts/oracle-codec-visual-final-{png,svg,auto}`.

Final native commit: `91f7d921d6769d104366b5fb36bd1b2abec2b17e`.
Frontend SHA256: `8cc20d7e803a6e8c593b20131af6377d20a68f4b439f3381da25f44f8ad0ed94`;
worker: `5f3cbd59e660b5ac23854134ab600c75cf04eb2aa9ef2b0e3a5d58fccc595bcd`.
Measured controller: `fc545af6650f8b3a9424bf8b593ff489d5da485cfbf3c63b4f7eb5f7349b6ab7`;
preview.js: `b993f4ffe8da72e3b0018418d773d1da61a37248fd92aa0831e36c565ce261f8`.
These hashes precede the parent extension commit and later capability guard.

## Method and reproduction

The flowing nominal 30-page corpus contains prose, math, theorems/proofs,
references and moderate TikZ. It edits early/middle/late root anchors and an
unsaved include for 147 seconds, navigates/scrolls while typing, repairs syntax,
and performs actual undo/redo with exact source assertions. `TextEditor.edit`
uses open-loop 100 ms deadlines through real document/provider/controller/IPC/
renderer paths; it does not measure keyboard dispatch. Local installed TeX Live
and native binaries require no downloads or native preview windows.

Memory checkpoints return to the same early anchor, wait for a current frame,
then 500 ms. Final root/include sources are hashed and preserved independently.
Use fresh output directories; the executable override avoids editor downloads.

```sh
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY="$PWD/native/.bundles/darwin-arm64-preview/bin/texpresso" \
TEXPRESSO_PROFILE_SCENARIO=long TEXPRESSO_PROFILE_PAGES=30 \
TEXPRESSO_PROFILE_CODECS=auto TEXPRESSO_PROFILE_OUTPUT="$PWD/artifacts/profile-long-retest" \
npm run profile:preview:varied

# Use scenario=compare and codecs=png,svg,auto for the controlled matrix.
node scripts/profiling/varied-summary.cjs artifacts/profile-long-retest artifacts/profile-long-retest/summary.json
node scripts/profiling/varied-oracle.cjs artifacts/profile-long-retest/varied-30-auto.json artifacts/oracle-long-retest
```
