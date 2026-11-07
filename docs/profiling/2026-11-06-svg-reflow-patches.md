# Retaining SVG glyphs through text reflow

Small text edits were sometimes replacing the entire SVG page because reflow
changes the positions of hundreds of glyphs. The old diff treated each moved
`<use>` as a removed and inserted node, exhausting the structural patch budget.
Its equal-length alignment shortcut also missed nearby reusable glyphs.

The host now batches transform changes for otherwise byte-identical leaf
`<use>` elements and aligns nearby glyphs across insertions/deletions. The
webview keeps these DOM nodes and updates only their transforms. Definitions,
references and all other attributes retain their existing validation. Every
fragment and target is validated before any visible mutation.

This adds a separate limit of 1,024 moved glyphs. The existing 256 structural
node budget, 64 combined operation/batch limit, 64 KiB/35% payload cap and 5 ms
host diff budget remain. Large/unsupported changes still fall back to a full
render. Transform-only updates also retain their cost observation for Auto.
There is no classifier/default change.

## Controlled before/after results

The same native SVG frames were replayed through old/new host diff code and
renderers in actual VS Code 1.145.0 webviews on macOS arm64, DPR 2. Each sequence
contains an initial page, a leading-space edit and twenty typed letters. These
are natural line-reflow cases from three private papers/slides, rather than
generated SVGs. Sources and exported SVGs stayed local.

| Case / CSS width | Full replacements per 21 edits, before → after | Host + browser work p95, before → after | Browser work p95, before → after |
| --- | --- | --- | --- |
| Conference paper / 640 | 8 → 0 | 33.42 → 5.31 ms | 30.5 → 1.9 ms |
| Conference paper / 1100 | 8 → 0 | 32.13 → 5.55 ms | 29.5 → 1.8 ms |
| Math paper / 640 | 5 → 0 | 26.82 → 4.28 ms | 24.6 → 1.3 ms |
| Slides / 640 | 0 → 0 | 1.50 → 1.05 ms | 1.0 → 0.5 ms |

The conference cases have three measured repetitions per variant/width; math
and slides have two. Repetition zero is warm-up and excluded. Old/new order
alternates each repetition. Across 28 trials, all **616 frame DOMs** matched an
independently mounted full SVG; all trials stayed visible. There are 420 measured
edit observations, correlated within each sequence, not 420 independent trials.
Initial mounts are excluded from the table. Percentiles use nearest rank.

Combined work adds host canonicalization/diff and browser patch/mount CPU work.
It excludes native compilation/export, message transit and paint waiting, so
these results do **not** establish a sixfold total typing-speed improvement.
Two-animation-frame paint-opportunity p95 fell from 63.5 to 13.9 ms for the
640 px conference case and 50.5 to 14.0 ms for math; this is not GPU scanout.
Slides show the expected small host overhead (median 0.47 → 0.55 ms).

The oracle compares element order, namespaces, attributes and values, ignoring
only generated ID scopes and namespace declarations. It is DOM equivalence,
not screenshot/pixel readback. Additional real-webview checks verify retained
glyph identity across insertion and atomic rejection of malformed transforms,
duplicate/removed targets and over-budget updates.

## Runtime and limitations

[Compact evidence](2026-11-06-svg-reflow-patches.json) includes per-frame timings,
validation/visibility results, input and frame hashes, runtime hashes and source
adaptations. The baseline is root revision
`577b4254dae48bebb51e27000f9d7cbd4a2b5fde` with a diagnostic-only callback added.
The frontend used to capture SVGs is existing native revision
`8c8553ff574acb1905d6b17208ea026f40738b6f`; no native rebuild was needed.
Private manuscript text, SVG payloads and absolute document paths are omitted.

Conference font/metadata and math font/pdfoutput adaptations are recorded in
the evidence. Conference/slides use the existing measurement-only leading-dot
annotation-number adapter; this does not establish unmodified-engine document
compatibility. Only SVG update work is compared here, not PNG versus SVG quality
or a new held-out classifier. Earlier cost-model measurements predate this fix.

Validation: 245 Node tests, lint, compilation and the native-backed real VS Code
preview suite pass. The latter covers unsaved edits, SVG/PNG rendering, viewport
behavior, SyncTeX, magnification, panel lifecycle and invalid patch rejection.

After saving the evidence, cleanup removed 41.26 MiB of private copied projects,
SVG captures, frozen comparison runtimes and redundant replay output. About
49 KiB of private input configuration and validation logs remains locally.
`npm run clean:generated -- --apply` found no additional eligible old outputs.
Original documents, dependencies and working native bundles are untouched.

## Reproduction

Use the private-input format described in [the profiling guide](README.md).
Capture one or more cases into a fresh output directory:

```sh
npm run compile-tests
TEXPRESSO_BINARY=/absolute/current/bundle/bin/texpresso \
node scripts/profiling/svg-patch-cases.cjs /absolute/private-inputs.json \
  artifacts/svg-reflow/capture
```

Freeze the old algorithm/renderer before comparing. For this baseline, create
the small runtime directly from source without checking out or building a
second copy of the project:

```sh
node <<'NODE'
const fs = require('node:fs'), { execFileSync } = require('node:child_process');
const ts = require('typescript'), out = 'artifacts/svg-reflow/baseline';
const revision = '577b4254dae48bebb51e27000f9d7cbd4a2b5fde';
const read = file => execFileSync('git', ['show', revision + ':' + file], {encoding:'utf8'});
fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(out + '/svg-patch.cjs', ts.transpileModule(read('src/svg-patch.ts'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
fs.writeFileSync(out + '/preview-svg.js', read('media/preview-svg.js'));
NODE
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
TEXPRESSO_BINARY=/absolute/current/bundle/bin/texpresso \
TEXPRESSO_SVG_PATCH_CAPTURE=artifacts/svg-reflow/capture \
TEXPRESSO_SVG_PATCH_BASELINE=artifacts/svg-reflow/baseline \
TEXPRESSO_PROFILE_OUTPUT=artifacts/svg-reflow/replay \
TEXPRESSO_REAL_WIDTHS=640,1100 TEXPRESSO_PROFILE_REPEATS=4 \
node scripts/test-integration.cjs --profile-svg-patch
```

Run only one timing job at a time. This reproduction baseline omits the optional
rejection diagnostic callback, so diagnostic records/hashes differ, while the
old algorithm is unchanged. Preserve a source-free summary and remove copied
projects, captures and redundant baseline runtimes after analysis.
