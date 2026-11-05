# Project instructions

## Sites workflow

- Use the Sites workflow only when the user explicitly requests building a ChatGPT Site.
- Do not use Sites or its scaffolds for local apps or independently published apps.

## Generated files and disk space

- Local disk space is limited. Run substantial native builds and platform matrices on GitHub by default. Do not start local Docker or download full CI artifacts just to inspect logs.
- Put disposable build intermediates in `native/.work/` and profiling/test output in ignored `artifacts/`. Keep source code and reusable experiments outside ignored output directories.
- Successful native builds remove their workspace automatically. Use `--keep-work` only for an active debugging need; failures retain their workspace for diagnosis. Delete it after diagnosis.
- Keep one usable local bundle per platform/architecture, with a canonical name such as `darwin-arm64-preview`. Do not retain successive `before`, `candidate`, `final2`, or timestamped bundle copies and ZIP duplicates after their comparison is complete.
- For profiling, use only the current run or one before/after pair. Save the compact result, input revisions, and reproduction command in `docs/profiling/` before deleting large raw traces, images, and copied executables. Historical raw output is disposable once summarized; do not duplicate reports merely as backups.
- After substantial build/profiling work, inspect generated disk use with `npm run clean:generated`. Once no build, test, or profiler is using the outputs, apply cleanup with `npm run clean:generated -- --apply`. The default retention is seven days; use `--days 1` when space is tight and the work is already summarized.
- A `.keep` file inside an output directory (or a sibling `filename.keep` for a file) pins it for a specific ongoing task. Remove the pin when the task finishes. The cleanup command also preserves canonical bundles, the latest VSIX per target, tracked files, and top-level experimental source/image files.
- Finish by reporting material disk use or cleanup. Do not delete source checkouts, dependencies, working native executables, user documents, or outputs belonging to an active task merely because they are ignored by Git.
